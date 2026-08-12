// The mail-in feed: every security invariant, the sender allowlist, the
// deterministic parser packs, dedupe (including the no-Message-ID hash path),
// the caps, and the confirm/dismiss review flow.
//
// No network anywhere. Raw messages are string fixtures pushed through the
// real postal-mime; the fakes below stand in for D1 and R2.
import { describe, expect, it } from 'vitest';
import { txFingerprint } from '../shared/fingerprint';
import { MAX_INBOX_EMAILS_PER_DAY } from '../shared/types';
import {
  ingestRawEmail,
  MAX_INBOUND_EMAIL_BYTES,
  normalizeAllowedSenders,
  senderAllowed,
} from '../worker/email/ingest';
import { confirmInboxEmail, dismissInboxEmail, readInboxEmails } from '../worker/email/inbox';
import { genericEnPack, parseAlertEmail, type ParserPack } from '../worker/email/parse';

// ---------------------------------------------------------------------------
// senderAllowed — the allowlist is the perimeter
// ---------------------------------------------------------------------------

describe('senderAllowed — exact address and exact domain, nothing looser', () => {
  it('matches an exact address, case-insensitively on both sides', () => {
    expect(senderAllowed('alerts@chase.com', ['alerts@chase.com'])).toBe(true);
    expect(senderAllowed('ALERTS@Chase.COM', ['alerts@chase.com'])).toBe(true);
    expect(senderAllowed('alerts@chase.com', ['ALERTS@CHASE.COM'])).toBe(true);
    expect(senderAllowed('other@chase.com', ['alerts@chase.com'])).toBe(false);
  });

  it('matches a whole-domain entry for any local part', () => {
    expect(senderAllowed('no-reply@chase.com', ['@chase.com'])).toBe(true);
    expect(senderAllowed('Fraud-Alerts@CHASE.com', ['@chase.com'])).toBe(true);
  });

  // The classic lookalike: a suffix match would hand the feed to anyone who
  // registers evil-chase.com. Domains compare whole, never as suffixes.
  it("does NOT let 'evil-chase.com' ride '@chase.com'", () => {
    expect(senderAllowed('no-reply@evil-chase.com', ['@chase.com'])).toBe(false);
    expect(senderAllowed('no-reply@notchase.com', ['@chase.com'])).toBe(false);
  });

  // Pinned v1 policy: subdomains do not match the parent domain. The user can
  // allowlist '@alerts.chase.com' explicitly; a loose rule cannot be revoked.
  it("does NOT match subdomains: 'alerts.chase.com' is not 'chase.com'", () => {
    expect(senderAllowed('no-reply@alerts.chase.com', ['@chase.com'])).toBe(false);
    expect(senderAllowed('no-reply@alerts.chase.com', ['@alerts.chase.com'])).toBe(true);
  });

  it('extracts the domain after the LAST @ — tricky local parts cannot spoof', () => {
    expect(senderAllowed('chase.com@evil.com', ['@chase.com'])).toBe(false);
    expect(senderAllowed('"x@chase.com"@evil.com', ['@chase.com'])).toBe(false);
  });

  it('an exact-address entry never matches a longer lookalike address', () => {
    expect(senderAllowed('alerts@chase.com.evil.com', ['alerts@chase.com'])).toBe(false);
  });

  it('rejects everything on an empty allowlist and on malformed senders', () => {
    expect(senderAllowed('alerts@chase.com', [])).toBe(false);
    expect(senderAllowed('', ['@chase.com'])).toBe(false);
    expect(senderAllowed('not-an-address', ['@chase.com'])).toBe(false);
    expect(senderAllowed('@chase.com', ['@chase.com'])).toBe(false); // no local part
    expect(senderAllowed('user@', ['@chase.com'])).toBe(false); // no domain
  });

  it('skips garbage entries instead of matching on them', () => {
    expect(senderAllowed('alerts@chase.com', ['', '   ', '@chase.com'])).toBe(true);
    expect(senderAllowed('alerts@chase.com', ['', '   '])).toBe(false);
  });
});

describe('normalizeAllowedSenders — PUT /api/preferences validation', () => {
  it('lowercases, trims and dedupes valid entries', () => {
    expect(normalizeAllowedSenders([' Alerts@Chase.com ', '@BOA.com', 'alerts@chase.com'])).toEqual(
      ['alerts@chase.com', '@boa.com'],
    );
  });

  it('rejects a non-list body', () => {
    expect(() => normalizeAllowedSenders('alerts@chase.com')).toThrowError(/list/i);
  });

  it('rejects entries that are neither an address nor an @domain', () => {
    for (const bad of ['chase.com', 'alerts@nodot', '@nodot', 'a b@chase.com', 42]) {
      expect(() => normalizeAllowedSenders([bad])).toThrowError(/emailAllowedSenders\[0\]/);
    }
  });

  it('caps the list length with a readable 400', () => {
    const many = Array.from({ length: 101 }, (_, i) => `user${i}@chase.com`);
    expect(() => normalizeAllowedSenders(many)).toThrowError(/at most 100/);
    try {
      normalizeAllowedSenders(many);
    } catch (err) {
      expect(err).toMatchObject({ status: 400 });
    }
  });
});

// ---------------------------------------------------------------------------
// The generic-en parser pack — conservative never-guess rules
// ---------------------------------------------------------------------------

const ARRIVED = '2026-08-12T10:30:00.000Z';

function parse(subject: string, body = ''): ReturnType<typeof parseAlertEmail> {
  return parseAlertEmail(subject, body, ARRIVED);
}

describe('generic-en — realistic alerts that must parse', () => {
  it('Chase-style: "You made a $23.45 transaction with STARBUCKS"', () => {
    expect(parse('You made a $23.45 transaction with STARBUCKS')).toEqual({
      date: '2026-08-12',
      merchant: 'STARBUCKS',
      amount: 23.45,
      type: 'expense',
      pack: 'generic-en',
    });
  });

  it('BofA-style: "A $1,200.00 payment to OAKWOOD APARTMENTS was made"', () => {
    expect(parse('A $1,200.00 payment to OAKWOOD APARTMENTS was made')).toEqual({
      date: '2026-08-12',
      merchant: 'OAKWOOD APARTMENTS',
      amount: 1200,
      type: 'expense',
      pack: 'generic-en',
    });
  });

  it('currency-code amounts: "credited with INR 4,200.00 … from ACME PAYROLL"', () => {
    expect(
      parse('Credit alert', 'Your account was credited with INR 4,200.00 by transfer from ACME PAYROLL'),
    ).toEqual({
      date: '2026-08-12',
      merchant: 'ACME PAYROLL',
      amount: 4200,
      type: 'income',
      pack: 'generic-en',
    });
  });

  it('a bare d+.dd counts when it hugs a direction keyword', () => {
    expect(parse('Charged 23.45 at STARBUCKS COFFEE')).toMatchObject({
      merchant: 'STARBUCKS COFFEE',
      amount: 23.45,
      type: 'expense',
    });
  });

  it('the same amount restated in subject and body collapses to one candidate', () => {
    const out = parse(
      'You spent $23.45 at STARBUCKS',
      'You spent $23.45 at STARBUCKS on 08/10. Questions? Call us.',
    );
    expect(out).toMatchObject({ merchant: 'STARBUCKS', amount: 23.45, type: 'expense' });
  });

  it('trims date tails and trailing punctuation off the merchant capture', () => {
    expect(parse('You spent $8.00 at PARKING GARAGE on 08/11.')).toMatchObject({
      merchant: 'PARKING GARAGE',
    });
  });
});

describe('generic-en — merchant capture stops at boundary markers (integration-QA fix)', () => {
  // The exact live fixture that caught the greedy capture: without the
  // boundary cut, the merchant came back as the whole trailing clause and
  // would poison duplicate fingerprints + sprint-5 rule suggestions.
  it("card boilerplate: '… with STARBUCKS STORE 08841 on your card ending 4321.'", () => {
    expect(
      parse('You made a $23.45 transaction with STARBUCKS STORE 08841 on your card ending 4321.'),
    ).toMatchObject({ merchant: 'STARBUCKS STORE 08841', amount: 23.45, type: 'expense' });
  });

  it("date tail after an aux clause: '… payment to OAKWOOD APARTMENTS was made on 08/12'", () => {
    expect(parse('A $1,200.00 payment to OAKWOOD APARTMENTS was made on 08/12')).toMatchObject({
      merchant: 'OAKWOOD APARTMENTS',
      amount: 1200,
    });
  });

  it("'using card' / 'via' / time-like 'at' tails are cut", () => {
    expect(parse('You made a $9.00 purchase at TARGET using card 4321')).toMatchObject({
      merchant: 'TARGET',
    });
    expect(parse('A $15.00 payment to ACME CORP via UPI was made')).toMatchObject({
      merchant: 'ACME CORP',
    });
    expect(parse('You spent $7.50 at CAFE NERO at 12:45')).toMatchObject({
      merchant: 'CAFE NERO',
    });
  });

  // Never-guess backstop: when truncation leaves nothing, there is no
  // merchant fact to propose — the whole email lands unparsed.
  it('a capture that truncates to empty makes the email unparsed', () => {
    expect(parse('You spent $10.00 at via UPI')).toBeNull();
  });
});

describe('generic-en — ambiguity always means unparsed, never a guess', () => {
  // Direction flips signs; the S4 statement sprint's critical was exactly a
  // guessed `type`. Both kinds of keyword present → refuse.
  it('an email with BOTH direction kinds does not parse', () => {
    expect(parse('Your payment to ACME WIDGETS was received: $20.00')).toBeNull();
  });

  it('an email with NO direction keyword does not parse', () => {
    expect(parse('Your statement is ready', 'View your August statement for $12.00 savings')).toBeNull();
  });

  it('a marketing email full of prices does not parse (multiple amounts)', () => {
    expect(
      parse(
        '50% off!',
        'Get 50% off your next purchase at STARBUCKS. Pastries from $2.99, lattes from $4.99.',
      ),
    ).toBeNull();
  });

  it('zero money-like candidates does not parse — a bare number far from a keyword is not money', () => {
    expect(parse('You spent money at STARBUCKS', 'Order ref 23456')).toBeNull();
  });

  it('no merchant capture does not parse', () => {
    expect(parse('You spent $10.00 today')).toBeNull();
  });

  it('a lowercase currency code is not money (fail closed, like the CSV importer)', () => {
    expect(parse('debited inr 500 from SAVINGS')).toBeNull();
  });

  it('percentages are never amounts', () => {
    expect(parse('Your purchase at STARBUCKS earned 5.00% cash back')).toBeNull();
  });
});

describe('parseAlertEmail — the pack runner', () => {
  const fixed: ParserPack = {
    name: 'fixed',
    parse: () => ({ date: '', merchant: 'FIXED', amount: 1, type: 'expense', pack: 'fixed' }),
  };

  it('stamps the arrival date (UTC day) when the pack returned none', () => {
    const out = parseAlertEmail('x', 'y', ARRIVED, [fixed]);
    expect(out?.date).toBe('2026-08-12');
    expect(out?.pack).toBe('fixed');
  });

  it('keeps a valid date a pack DID establish', () => {
    const dated: ParserPack = {
      name: 'dated',
      parse: () => ({ date: '2026-08-01', merchant: 'M', amount: 2, type: 'income', pack: 'dated' }),
    };
    expect(parseAlertEmail('x', 'y', ARRIVED, [dated])?.date).toBe('2026-08-01');
  });

  it('first match wins, in registration order', () => {
    const other: ParserPack = {
      name: 'other',
      parse: () => ({ date: '', merchant: 'OTHER', amount: 9, type: 'income', pack: 'other' }),
    };
    expect(parseAlertEmail('x', 'y', ARRIVED, [fixed, other])?.merchant).toBe('FIXED');
  });

  it('a pack that throws is skipped — a broken community pack cannot kill ingestion', () => {
    const broken: ParserPack = {
      name: 'broken',
      parse: () => {
        throw new Error('boom');
      },
    };
    expect(parseAlertEmail('x', 'y', ARRIVED, [broken, fixed])?.merchant).toBe('FIXED');
  });

  it('re-checks pack output: a zero amount or blank merchant is refused', () => {
    const zero: ParserPack = {
      name: 'zero',
      parse: () => ({ date: '', merchant: 'M', amount: 0, type: 'expense', pack: 'zero' }),
    };
    const blank: ParserPack = {
      name: 'blank',
      parse: () => ({ date: '', merchant: '  ', amount: 5, type: 'expense', pack: 'blank' }),
    };
    expect(parseAlertEmail('x', 'y', ARRIVED, [zero])).toBeNull();
    expect(parseAlertEmail('x', 'y', ARRIVED, [blank])).toBeNull();
  });

  it('genericEnPack itself reports date "" — the runner owns the date', () => {
    expect(genericEnPack.parse('You made a $5.00 transaction with CAFE', '')?.date).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Fake D1 + env — scoped to exactly the statements the pipeline issues
// ---------------------------------------------------------------------------

interface Tables {
  settings: Record<string, unknown>[];
  inbox_emails: Record<string, unknown>[];
  documents: Record<string, unknown>[];
  transactions: Record<string, unknown>[];
  tags: Record<string, unknown>[];
  rules: Record<string, unknown>[];
}

interface Hooks {
  /** Fires after the dedupe SELECT — lets a test land a competing insert. */
  afterDedupeRead?: () => void;
}

function fakeDb(seed: Partial<Tables> = {}, hooks: Hooks = {}) {
  const t: Tables = {
    settings: [],
    inbox_emails: [],
    documents: [],
    transactions: [],
    tags: [],
    rules: [],
    ...seed,
  };

  function exec(sql: string, args: unknown[]): { rows: Record<string, unknown>[]; changes: number } {
    // --- settings ---------------------------------------------------------
    if (/SELECT key, value FROM settings/i.test(sql)) {
      return { rows: t.settings, changes: 0 };
    }

    // --- inbox_emails -----------------------------------------------------
    if (/SELECT COUNT\(\*\) AS n FROM inbox_emails/i.test(sql)) {
      const n = t.inbox_emails.filter((r) => (r.createdAt as string) >= (args[0] as string)).length;
      return { rows: [{ n }], changes: 0 };
    }
    if (/SELECT id FROM inbox_emails WHERE messageId = \?/i.test(sql)) {
      const rows = t.inbox_emails.filter((r) => r.messageId === args[0]).map((r) => ({ id: r.id }));
      hooks.afterDedupeRead?.();
      return { rows, changes: 0 };
    }
    if (/FROM inbox_emails WHERE id = \?/i.test(sql)) {
      return { rows: t.inbox_emails.filter((r) => r.id === args[0]).map((r) => ({ ...r })), changes: 0 };
    }
    if (/FROM inbox_emails ORDER BY createdAt DESC/i.test(sql)) {
      const rows = [...t.inbox_emails]
        .sort((a, b) => (b.createdAt as string).localeCompare(a.createdAt as string))
        .map((r) => ({ ...r }));
      return { rows, changes: 0 };
    }
    if (/INSERT INTO inbox_emails/i.test(sql)) {
      const [id, messageId, receivedAt, fromAddress, subject, status, parsed, documentId, createdAt] =
        args;
      if (t.inbox_emails.some((r) => r.messageId === messageId)) {
        throw new Error('UNIQUE constraint failed: inbox_emails.messageId');
      }
      t.inbox_emails.push({
        id,
        messageId,
        receivedAt,
        fromAddress,
        subject,
        status,
        parsed,
        documentId,
        createdAt,
      });
      return { rows: [], changes: 1 };
    }
    if (/UPDATE inbox_emails SET status = \?/i.test(sql)) {
      let changes = 0;
      for (const r of t.inbox_emails) {
        if (r.id === args[1]) {
          r.status = args[0];
          changes++;
        }
      }
      return { rows: [], changes };
    }

    // --- documents --------------------------------------------------------
    if (/INSERT INTO documents/i.test(sql)) {
      t.documents.push({
        id: args[0],
        filename: args[1],
        mimeType: args[2],
        size: args[3],
        objectKey: args[4],
        status: args[5],
        source: args[6],
        createdAt: args[7],
      });
      return { rows: [], changes: 1 };
    }

    // --- transactions / tags / rules --------------------------------------
    if (/SELECT fingerprint FROM transactions/i.test(sql)) {
      return {
        rows: t.transactions
          .filter((x) => (args as string[]).includes(x.fingerprint as string))
          .map((x) => ({ fingerprint: x.fingerprint })),
        changes: 0,
      };
    }
    if (/INSERT INTO transactions/i.test(sql)) {
      if (t.transactions.some((x) => x.fingerprint === args[10])) {
        throw new Error('UNIQUE constraint failed: transactions.fingerprint');
      }
      t.transactions.push({
        id: args[0],
        date: args[1],
        merchant: args[2],
        category: args[3],
        amount: args[4],
        type: args[5],
        account: args[6],
        tags: args[7],
        receipt: args[8],
        source: args[9],
        fingerprint: args[10],
        createdAt: args[11],
      });
      return { rows: [], changes: 1 };
    }
    if (/FROM rules/i.test(sql)) return { rows: t.rules, changes: 0 };
    if (/SELECT name FROM tags/i.test(sql)) return { rows: t.tags, changes: 0 };
    if (/INSERT OR IGNORE INTO tags/i.test(sql)) {
      t.tags.push({ name: args[0] });
      return { rows: [], changes: 1 };
    }

    throw new Error(`fake D1 has no handler for: ${sql}`);
  }

  interface Stmt {
    sql: string;
    args: unknown[];
    bind(...values: unknown[]): Stmt;
    all<T>(): Promise<{ results: T[] }>;
    first<T>(): Promise<T | null>;
    run(): Promise<{ meta: { changes: number } }>;
  }

  function statement(sql: string, args: unknown[] = []): Stmt {
    return {
      sql,
      args,
      bind: (...values: unknown[]) => statement(sql, values),
      all: async <T,>() => ({ results: exec(sql, args).rows as T[] }),
      first: async <T,>() => (exec(sql, args).rows[0] as T | undefined) ?? null,
      run: async () => ({ meta: { changes: exec(sql, args).changes } }),
    };
  }

  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Stmt[]) => {
      for (const s of statements) exec(s.sql, s.args);
      return [];
    },
  } as unknown as D1Database;

  return { db, tables: t };
}

function feedSettings(enabled: boolean, allowlist: string[]): Record<string, unknown>[] {
  return [
    { key: 'emailFeedEnabled', value: JSON.stringify(enabled) },
    { key: 'emailAllowedSenders', value: JSON.stringify(allowlist) },
  ];
}

function fakeEnv(seed: Partial<Tables> = {}, hooks: Hooks = {}) {
  const { db, tables } = fakeDb(seed, hooks);
  const puts: { key: string; size: number; contentType?: string }[] = [];
  const env = {
    DB: db,
    BUCKET: {
      put: async (
        key: string,
        bytes: Uint8Array,
        opts?: { httpMetadata?: { contentType?: string } },
      ) => {
        puts.push({ key, size: bytes.byteLength, contentType: opts?.httpMetadata?.contentType });
      },
    },
    // No AI binding on purpose: the no-AI-on-inbound invariant means the
    // pipeline must never even look for one.
  } as unknown as Env;
  return { env, tables, puts };
}

// ---------------------------------------------------------------------------
// MIME fixtures
// ---------------------------------------------------------------------------

function rawEmail(
  opts: {
    from?: string;
    subject?: string;
    body?: string;
    /** null omits the Message-ID header entirely (the hash-dedupe path). */
    messageId?: string | null;
    date?: string;
  } = {},
): string {
  const lines = [`From: Alerts <${opts.from ?? 'no-reply@chase.com'}>`, 'To: feed@ledgerly.test'];
  if (opts.messageId !== null) lines.push(`Message-ID: <${opts.messageId ?? 'm-1@chase.com'}>`);
  lines.push(`Date: ${opts.date ?? 'Wed, 12 Aug 2026 10:30:00 +0000'}`);
  lines.push(`Subject: ${opts.subject ?? 'Transaction alert'}`);
  lines.push('Content-Type: text/plain; charset=utf-8');
  lines.push('');
  lines.push(opts.body ?? 'You made a $23.45 transaction with STARBUCKS');
  return lines.join('\r\n');
}

/** Tiny but real: "%PDF-1.4\n%%EOF" base64-encoded. */
const PDF_B64 = 'JVBERi0xLjQKJSVFT0Y=';

function rawEmailWithAttachment(
  opts: { mimeType?: string; filename?: string; contentB64?: string } = {},
): string {
  return [
    'From: Alerts <no-reply@chase.com>',
    'To: feed@ledgerly.test',
    'Message-ID: <with-attachment@chase.com>',
    'Date: Wed, 12 Aug 2026 10:30:00 +0000',
    'Subject: Receipt attached',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'You made a $23.45 transaction with STARBUCKS',
    '--b1',
    `Content-Type: ${opts.mimeType ?? 'application/pdf'}`,
    `Content-Disposition: attachment; filename="${opts.filename ?? 'receipt.pdf'}"`,
    'Content-Transfer-Encoding: base64',
    '',
    opts.contentB64 ?? PDF_B64,
    '--b1--',
  ].join('\r\n');
}

/** HTML-only email whose sole image is a cid-referenced logo (not a document). */
function rawEmailWithRelatedLogo(): string {
  return [
    'From: Alerts <no-reply@chase.com>',
    'To: feed@ledgerly.test',
    'Message-ID: <logo-only@chase.com>',
    'Date: Wed, 12 Aug 2026 10:30:00 +0000',
    'Subject: You made a $23.45 transaction with STARBUCKS',
    'Content-Type: multipart/related; boundary="b2"',
    '',
    '--b2',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>You made a $23.45 transaction with STARBUCKS</p><img src="cid:logo@chase.com">',
    '--b2',
    'Content-Type: image/png',
    'Content-ID: <logo@chase.com>',
    'Content-Disposition: inline',
    'Content-Transfer-Encoding: base64',
    '',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    '--b2--',
  ].join('\r\n');
}

// ---------------------------------------------------------------------------
// ingestRawEmail — secure by default, suggestion-only, deduped, capped
// ---------------------------------------------------------------------------

describe('ingestRawEmail — secure by default', () => {
  it('rejects when the feed is disabled, before looking at the message', async () => {
    const { env, tables } = fakeEnv({ settings: feedSettings(false, ['@chase.com']) });
    // The sender is not allowlisted either — the reason proves the disabled
    // gate fired FIRST, before any sender/MIME inspection.
    const result = await ingestRawEmail(env, rawEmail({ from: 'x@evil.test' }), 'x@evil.test');
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/turned off/i) });
    expect(tables.inbox_emails).toHaveLength(0);
  });

  it('rejects on an EMPTY allowlist even when enabled — nothing is ingested by default', async () => {
    const { env, tables } = fakeEnv({ settings: feedSettings(true, []) });
    const result = await ingestRawEmail(env, rawEmail(), 'no-reply@chase.com');
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/allowed senders/i) });
    expect(tables.inbox_emails).toHaveLength(0);
  });

  it('rejects a non-allowlisted envelope sender', async () => {
    const { env, tables } = fakeEnv({ settings: feedSettings(true, ['@chase.com']) });
    const result = await ingestRawEmail(env, rawEmail(), 'no-reply@evil-chase.com');
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/allowed list/i) });
    expect(tables.inbox_emails).toHaveLength(0);
  });

  it('falls back to the From header when no envelope is given — and still gates on it', async () => {
    const { env, tables } = fakeEnv({ settings: feedSettings(true, ['@chase.com']) });
    const rejected = await ingestRawEmail(env, rawEmail({ from: 'x@evil.test' }), null);
    expect(rejected.ok).toBe(false);
    expect(tables.inbox_emails).toHaveLength(0);
    const accepted = await ingestRawEmail(env, rawEmail(), null);
    expect(accepted.ok).toBe('ingested');
  });

  it('the envelope sender is the trust anchor: it wins over a spoofed From header', async () => {
    const { env, tables } = fakeEnv({ settings: feedSettings(true, ['@chase.com']) });
    const result = await ingestRawEmail(
      env,
      rawEmail({ from: 'spoofed@evil.test' }),
      'No-Reply@chase.com',
    );
    expect(result.ok).toBe('ingested');
    expect(tables.inbox_emails[0].fromAddress).toBe('no-reply@chase.com');
  });

  it('rejects an oversized raw message before touching the database at all', async () => {
    const env = {
      DB: {
        prepare() {
          throw new Error('the size cap must fire before any DB access');
        },
      },
      BUCKET: {},
    } as unknown as Env;
    const big = 'x'.repeat(MAX_INBOUND_EMAIL_BYTES + 1);
    const result = await ingestRawEmail(env, big, null);
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/5 MB/) });
  });

  it('rejects an empty message', async () => {
    const { env } = fakeEnv({ settings: feedSettings(true, ['@chase.com']) });
    expect((await ingestRawEmail(env, '', null)).ok).toBe(false);
  });
});

describe('ingestRawEmail — suggestion-only ingestion', () => {
  it('stores a proposed row with the parsed facts and NEVER inserts a transaction', async () => {
    const { env, tables } = fakeEnv({ settings: feedSettings(true, ['@chase.com']) });
    const result = await ingestRawEmail(env, rawEmail(), 'no-reply@chase.com');
    expect(result).toEqual({ ok: 'ingested', id: expect.any(String), status: 'proposed' });

    expect(tables.inbox_emails).toHaveLength(1);
    const row = tables.inbox_emails[0];
    expect(row.status).toBe('proposed');
    expect(row.fromAddress).toBe('no-reply@chase.com');
    expect(row.receivedAt).toBe('2026-08-12T10:30:00.000Z'); // the Date header
    expect(JSON.parse(row.parsed as string)).toEqual({
      date: '2026-08-12',
      merchant: 'STARBUCKS',
      amount: 23.45,
      type: 'expense',
      pack: 'generic-en',
    });

    // The invariant that makes spoofing harmless: nothing reached the ledger.
    expect(tables.transactions).toHaveLength(0);
  });

  it('an email the parser cannot read lands as unparsed — a record, not a proposal', async () => {
    const { env, tables } = fakeEnv({ settings: feedSettings(true, ['@chase.com']) });
    const result = await ingestRawEmail(
      env,
      rawEmail({ subject: 'Hello', body: 'Nothing about money here' }),
      'no-reply@chase.com',
    );
    expect(result).toMatchObject({ ok: 'ingested', status: 'unparsed' });
    expect(tables.inbox_emails[0].parsed).toBeNull();
    expect(tables.transactions).toHaveLength(0);
  });

  it('clips the stored subject (house clip: 200 chars with an ellipsis)', async () => {
    const { env, tables } = fakeEnv({ settings: feedSettings(true, ['@chase.com']) });
    await ingestRawEmail(env, rawEmail({ subject: 'S'.repeat(300) }), 'no-reply@chase.com');
    const subject = tables.inbox_emails[0].subject as string;
    expect(subject).toHaveLength(200);
    expect(subject.endsWith('…')).toBe(true);
  });
});

describe('ingestRawEmail — dedupe by Message-ID and by content hash', () => {
  it('a duplicate Message-ID is a silent success, never a second row', async () => {
    const { env, tables } = fakeEnv({ settings: feedSettings(true, ['@chase.com']) });
    expect((await ingestRawEmail(env, rawEmail(), 'no-reply@chase.com')).ok).toBe('ingested');
    expect(await ingestRawEmail(env, rawEmail(), 'no-reply@chase.com')).toEqual({ ok: 'duplicate' });
    expect(tables.inbox_emails).toHaveLength(1);
  });

  it('without a Message-ID, identical bytes dedupe by SHA-256; different bytes do not', async () => {
    const { env, tables } = fakeEnv({ settings: feedSettings(true, ['@chase.com']) });
    const raw = rawEmail({ messageId: null });
    expect((await ingestRawEmail(env, raw, 'no-reply@chase.com')).ok).toBe('ingested');
    expect(await ingestRawEmail(env, raw, 'no-reply@chase.com')).toEqual({ ok: 'duplicate' });
    expect(tables.inbox_emails).toHaveLength(1);
    expect((tables.inbox_emails[0].messageId as string).startsWith('sha256:')).toBe(true);

    const other = rawEmail({ messageId: null, body: 'You spent $9.99 at CAFE NERO' });
    expect((await ingestRawEmail(env, other, 'no-reply@chase.com')).ok).toBe('ingested');
    expect(tables.inbox_emails).toHaveLength(2);
  });

  it('a race that slips past the read is caught by the UNIQUE index and reported as duplicate', async () => {
    let raced = false;
    const { env, tables } = fakeEnv({ settings: feedSettings(true, ['@chase.com']) }, {
      afterDedupeRead: () => {
        if (raced) return;
        raced = true;
        // The same message lands through the other door between read and write.
        tables.inbox_emails.push({
          id: 'race',
          messageId: '<m-1@chase.com>',
          receivedAt: ARRIVED,
          fromAddress: 'no-reply@chase.com',
          subject: 'x',
          status: 'proposed',
          parsed: null,
          documentId: null,
          createdAt: ARRIVED,
        });
      },
    });
    expect(await ingestRawEmail(env, rawEmail(), 'no-reply@chase.com')).toEqual({ ok: 'duplicate' });
    expect(tables.inbox_emails).toHaveLength(1);
  });
});

describe('ingestRawEmail — the daily flood cap', () => {
  function seededToday(count: number, dayOffset = 0): Record<string, unknown>[] {
    const day = new Date(Date.now() - dayOffset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return Array.from({ length: count }, (_, i) => ({
      id: `seed-${dayOffset}-${i}`,
      messageId: `<seed-${dayOffset}-${i}@x.test>`,
      receivedAt: `${day}T01:00:00.000Z`,
      fromAddress: 'no-reply@chase.com',
      subject: 'x',
      status: 'unparsed',
      parsed: null,
      documentId: null,
      createdAt: `${day}T01:00:00.000Z`,
    }));
  }

  it('rejects once today (UTC) already holds MAX_INBOX_EMAILS_PER_DAY rows', async () => {
    const { env, tables } = fakeEnv({
      settings: feedSettings(true, ['@chase.com']),
      inbox_emails: seededToday(MAX_INBOX_EMAILS_PER_DAY),
    });
    const result = await ingestRawEmail(env, rawEmail(), 'no-reply@chase.com');
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/daily/i) });
    expect(tables.inbox_emails).toHaveLength(MAX_INBOX_EMAILS_PER_DAY);
  });

  it("yesterday's rows do not count against today", async () => {
    const { env } = fakeEnv({
      settings: feedSettings(true, ['@chase.com']),
      inbox_emails: seededToday(MAX_INBOX_EMAILS_PER_DAY, 1),
    });
    expect((await ingestRawEmail(env, rawEmail(), 'no-reply@chase.com')).ok).toBe('ingested');
  });
});

describe('ingestRawEmail — attachments land as plain vault documents, no AI', () => {
  // The fake env has NO AI binding at all: the pipeline succeeding end-to-end
  // is itself the proof that inbound email never reaches for a model.
  it('stores the first PDF attachment through the documents pipeline', async () => {
    const { env, tables, puts } = fakeEnv({ settings: feedSettings(true, ['@chase.com']) });
    const result = await ingestRawEmail(env, rawEmailWithAttachment(), 'no-reply@chase.com');
    expect(result.ok).toBe('ingested');

    expect(tables.documents).toHaveLength(1);
    const doc = tables.documents[0];
    expect(doc.filename).toBe('receipt.pdf');
    expect(doc.mimeType).toBe('application/pdf');
    expect(doc.status).toBe('review'); // stored for review, exactly like a non-CSV upload
    expect(doc.source).toBe('upload');
    expect(tables.inbox_emails[0].documentId).toBe(doc.id);

    expect(puts).toHaveLength(1);
    expect(puts[0].key).toMatch(/^email-inbox\//);
    expect(puts[0].contentType).toBe('application/pdf');
  });

  it('skips cid-referenced logo images — a bank logo is not a document', async () => {
    const { env, tables, puts } = fakeEnv({ settings: feedSettings(true, ['@chase.com']) });
    const result = await ingestRawEmail(env, rawEmailWithRelatedLogo(), 'no-reply@chase.com');
    expect(result.ok).toBe('ingested');
    expect(tables.documents).toHaveLength(0);
    expect(puts).toHaveLength(0);
    expect(tables.inbox_emails[0].documentId).toBeNull();
  });

  it('skips non-PDF/image attachments (v1 pin: an emailed CSV is not the import path)', async () => {
    const { env, tables } = fakeEnv({ settings: feedSettings(true, ['@chase.com']) });
    const raw = rawEmailWithAttachment({
      mimeType: 'text/csv',
      filename: 'statement.csv',
      contentB64: btoa('Date,Description,Amount\n'),
    });
    const result = await ingestRawEmail(env, raw, 'no-reply@chase.com');
    expect(result.ok).toBe('ingested');
    expect(tables.documents).toHaveLength(0);
    expect(tables.transactions).toHaveLength(0); // and it certainly was not parsed
  });

  it('skips an empty attachment but still ingests the email', async () => {
    const { env, tables } = fakeEnv({ settings: feedSettings(true, ['@chase.com']) });
    const raw = rawEmailWithAttachment({ contentB64: '' });
    const result = await ingestRawEmail(env, raw, 'no-reply@chase.com');
    expect(result.ok).toBe('ingested');
    expect(tables.documents).toHaveLength(0);
    expect(tables.inbox_emails).toHaveLength(1);
  });

  it('an R2 failure loses the attachment, never the email', async () => {
    const { env, tables } = fakeEnv({ settings: feedSettings(true, ['@chase.com']) });
    (env as unknown as { BUCKET: R2Bucket }).BUCKET = {
      put: async () => {
        throw new Error('r2 down');
      },
    } as unknown as R2Bucket;
    const result = await ingestRawEmail(env, rawEmailWithAttachment(), 'no-reply@chase.com');
    expect(result.ok).toBe('ingested');
    expect(tables.inbox_emails[0].documentId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The review flow — confirm / dismiss
// ---------------------------------------------------------------------------

const PARSED = JSON.stringify({
  date: '2026-08-12',
  merchant: 'STARBUCKS',
  amount: 23.45,
  type: 'expense',
  pack: 'generic-en',
});

function inboxRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'mail-1',
    messageId: '<m-1@chase.com>',
    receivedAt: '2026-08-12T10:30:00.000Z',
    fromAddress: 'no-reply@chase.com',
    subject: 'Transaction alert',
    status: 'proposed',
    parsed: PARSED,
    documentId: null,
    createdAt: '2026-08-12T10:30:05.000Z',
    ...overrides,
  };
}

function txInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    date: '2026-08-12',
    merchant: 'STARBUCKS',
    amount: 23.45,
    type: 'expense',
    category: 'Dining',
    account: 'Everyday Visa',
    ...overrides,
  };
}

describe('confirmInboxEmail — the ONLY path from an email to the ledger', () => {
  it('inserts the user-edited row through the one pipeline and flips the status', async () => {
    const { db, tables } = fakeDb({ inbox_emails: [inboxRow()] });
    const result = await confirmInboxEmail(db, 'mail-1', txInput());
    expect(result.inserted).toBe(1);
    expect(result.duplicates).toBe(0);

    expect(tables.transactions).toHaveLength(1);
    const tx = tables.transactions[0];
    expect(tx.merchant).toBe('STARBUCKS');
    expect(tx.amount).toBe(23.45);
    expect(tx.source).toBe('email');
    expect(tx.receipt).toBe(0); // an alert email is a trail, not a receipt
    expect(tables.inbox_emails[0].status).toBe('confirmed');
  });

  it('forces source and receipt whatever the payload claims — spoof-resistant', async () => {
    const { db, tables } = fakeDb({ inbox_emails: [inboxRow()] });
    await confirmInboxEmail(db, 'mail-1', txInput({ source: 'manual', receipt: true }));
    expect(tables.transactions[0].source).toBe('email');
    expect(tables.transactions[0].receipt).toBe(0);
  });

  it('confirms an UNPARSED email with a fully user-filled form — the email is the receipt trail', async () => {
    const { db, tables } = fakeDb({ inbox_emails: [inboxRow({ status: 'unparsed', parsed: null })] });
    const result = await confirmInboxEmail(db, 'mail-1', txInput());
    expect(result.inserted).toBe(1);
    expect(tables.inbox_emails[0].status).toBe('confirmed');
  });

  it('reports an already-present transaction as an honest duplicate and still settles the email', async () => {
    const fingerprint = txFingerprint('2026-08-12', 'STARBUCKS', 23.45, 'Everyday Visa');
    const { db, tables } = fakeDb({
      inbox_emails: [inboxRow()],
      transactions: [{ fingerprint }],
    });
    const result = await confirmInboxEmail(db, 'mail-1', txInput());
    expect(result.inserted).toBe(0);
    expect(result.duplicates).toBe(1);
    // The transaction the user wanted exists — the email's work is done.
    expect(tables.inbox_emails[0].status).toBe('confirmed');
  });

  it('rejects an invalid form with a readable 400 naming the problem, leaving everything unchanged', async () => {
    const { db, tables } = fakeDb({ inbox_emails: [inboxRow()] });
    await expect(confirmInboxEmail(db, 'mail-1', txInput({ date: 'yesterday' }))).rejects.toMatchObject(
      { status: 400, message: expect.stringMatching(/date/i) },
    );
    expect(tables.transactions).toHaveLength(0);
    expect(tables.inbox_emails[0].status).toBe('proposed');
  });

  it('rejects a negative or zero amount', async () => {
    const { db } = fakeDb({ inbox_emails: [inboxRow()] });
    await expect(confirmInboxEmail(db, 'mail-1', txInput({ amount: 0 }))).rejects.toMatchObject({
      status: 400,
    });
  });

  it('404s for an unknown id', async () => {
    const { db } = fakeDb();
    await expect(confirmInboxEmail(db, 'nope', txInput())).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a settled email: dismissed and confirmed rows are not confirmable again', async () => {
    const dismissed = fakeDb({ inbox_emails: [inboxRow({ status: 'dismissed' })] });
    await expect(confirmInboxEmail(dismissed.db, 'mail-1', txInput())).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/dismissed/i),
    });
    expect(dismissed.tables.transactions).toHaveLength(0);

    const confirmed = fakeDb({ inbox_emails: [inboxRow({ status: 'confirmed' })] });
    await expect(confirmInboxEmail(confirmed.db, 'mail-1', txInput())).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/already imported/i),
    });
  });
});

describe('dismissInboxEmail', () => {
  it('flips proposed → dismissed, and again is an idempotent success', async () => {
    const { db, tables } = fakeDb({ inbox_emails: [inboxRow()] });
    await dismissInboxEmail(db, 'mail-1');
    expect(tables.inbox_emails[0].status).toBe('dismissed');
    await dismissInboxEmail(db, 'mail-1'); // no throw
    expect(tables.inbox_emails[0].status).toBe('dismissed');
  });

  it('an unparsed record can be dismissed too', async () => {
    const { db, tables } = fakeDb({ inbox_emails: [inboxRow({ status: 'unparsed', parsed: null })] });
    await dismissInboxEmail(db, 'mail-1');
    expect(tables.inbox_emails[0].status).toBe('dismissed');
  });

  it('refuses to dismiss a confirmed email — its transaction exists', async () => {
    const { db } = fakeDb({ inbox_emails: [inboxRow({ status: 'confirmed' })] });
    await expect(dismissInboxEmail(db, 'mail-1')).rejects.toMatchObject({ status: 400 });
  });

  it('404s for an unknown id', async () => {
    const { db } = fakeDb();
    await expect(dismissInboxEmail(db, 'nope')).rejects.toMatchObject({ status: 404 });
  });
});

describe('readInboxEmails — the /api/state slice', () => {
  it('returns every status, newest first, with parsed fields decoded', async () => {
    const { db } = fakeDb({
      inbox_emails: [
        inboxRow({ id: 'a', messageId: '<a@x>', createdAt: '2026-08-10T00:00:00.000Z' }),
        inboxRow({
          id: 'b',
          messageId: '<b@x>',
          status: 'dismissed',
          createdAt: '2026-08-12T00:00:00.000Z',
        }),
        inboxRow({
          id: 'c',
          messageId: '<c@x>',
          status: 'confirmed',
          createdAt: '2026-08-11T00:00:00.000Z',
        }),
      ],
    });
    const list = await readInboxEmails(db);
    expect(list.map((e) => e.id)).toEqual(['b', 'c', 'a']);
    expect(list.map((e) => e.status)).toEqual(['dismissed', 'confirmed', 'proposed']);
    expect(list[2].parsed).toMatchObject({ merchant: 'STARBUCKS', amount: 23.45 });
    expect(list[2].from).toBe('no-reply@chase.com');
  });

  it('degrades a corrupt parsed blob to null and an unknown status to dismissed', async () => {
    const { db } = fakeDb({
      inbox_emails: [
        inboxRow({ parsed: '{not json' }),
        inboxRow({ id: 'mail-2', messageId: '<m2@x>', status: 'garbage', parsed: null }),
        inboxRow({ id: 'mail-3', messageId: '<m3@x>', parsed: JSON.stringify({ date: 1 }) }),
      ],
    });
    const list = await readInboxEmails(db);
    expect(list.find((e) => e.id === 'mail-1')?.parsed).toBeNull();
    expect(list.find((e) => e.id === 'mail-2')?.status).toBe('dismissed');
    expect(list.find((e) => e.id === 'mail-3')?.parsed).toBeNull();
  });
});
