// Statements over the custom provider via browser-extracted pages (sprint
// 16): begin → round × N → finalize (or abort), end to end through the
// worker endpoints with a fake D1 + R2 and a scripted OpenAI-compatible
// endpoint. No network, no waiting, no DOM — the browser's half is covered
// by tests/clientPages.test.ts.
//
// The shape under test: begin runs the custom statement gates and takes the
// SAME claim every provider's run takes, parking a {mode:'client-pages'}
// providerState the S12 tick path must refuse; rounds turn ≤8 pages into at
// most two model calls (text batched into one, images into one) and persist
// NOTHING; finalize runs the one existing pipeline — normalize cap,
// enrichment, confirmed-row exclusion, duplicate pre-flags, loud partial
// semantics — and the custom API key never appears anywhere near a client
// payload.
import { describe, expect, it } from 'vitest';
import { txFingerprint } from '../shared/fingerprint';
import {
  CLIENT_STATEMENT_PAGES_PER_ROUND,
  STATEMENT_PAGE_IMAGE_MAX_BYTES,
  STATEMENT_PAGE_TEXT_MAX_CHARS,
  type StatementPageInput,
} from '../shared/types';
import {
  buildImageRoundMessages,
  buildTextRoundMessages,
  runStatementPagesRound,
  STATEMENT_ROWS_SHAPE_INSTRUCTION,
  validateRoundPages,
} from '../worker/ai/statementPages';
import type { ChatMessage } from '../worker/ai/custom';
import {
  abortClientStatement,
  beginClientStatement,
  buildStatementPreflight,
  CLIENT_ABORT_MESSAGE,
  clientStatementRound,
  CUSTOM_STATEMENT_BROWSER_FLOW,
  finalizeClientStatement,
  parseClientPagesState,
  parseProviderState,
  runStatementExtraction,
  statementPreflight,
  statementProgress,
} from '../worker/statements';

const DOC = 'doc-1';
const OBJECT_KEY = 'vault/doc-1.pdf';
const SECRET = 'nvapi-test-key-do-not-echo-0123456789';

// ---------------------------------------------------------------------------
// Fake D1 + R2 (statementResume.test.ts's shape, extended with the
// client-pages flow's reads) — every executed statement recorded so tests
// can pin what did NOT run too.
// ---------------------------------------------------------------------------

interface JobRecord {
  documentId: string;
  status: string;
  rowCount: number;
  truncated: number;
  provider: string;
  model: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  providerState: string | null;
}

interface Tables {
  documents: Record<string, unknown>[];
  /** settings key → raw stored JSON string. */
  settings: Map<string, string>;
  statement_extractions: JobRecord[];
  statement_rows: Record<string, unknown>[];
  transactions: Record<string, unknown>[];
  rules: Record<string, unknown>[];
}

function fakeDb(seed: Partial<Tables> = {}) {
  const t: Tables = {
    documents: [],
    settings: new Map(),
    statement_extractions: [],
    statement_rows: [],
    transactions: [],
    rules: [],
    ...seed,
  };
  const executed: { sql: string; args: unknown[] }[] = [];

  function exec(sql: string, args: unknown[]): { rows: Record<string, unknown>[]; changes: number } {
    executed.push({ sql, args });

    if (/FROM documents WHERE id = \?/i.test(sql)) {
      return { rows: t.documents.filter((d) => d.id === args[0]), changes: 0 };
    }
    if (/UPDATE documents SET status/i.test(sql)) return { rows: [], changes: 1 };

    if (/SELECT key, value FROM settings/i.test(sql)) {
      return { rows: [...t.settings].map(([key, value]) => ({ key, value })), changes: 0 };
    }
    if (/SELECT value FROM settings WHERE key = \?/i.test(sql)) {
      const value = t.settings.get(args[0] as string);
      return { rows: value === undefined ? [] : [{ value }], changes: 0 };
    }

    if (/^SELECT status, updatedAt FROM statement_extractions/i.test(sql)) {
      return {
        rows: t.statement_extractions.filter((j) => j.documentId === args[0]).map((j) => ({ ...j })),
        changes: 0,
      };
    }
    if (/SET providerState = \?, updatedAt = \?/i.test(sql)) {
      const [state, now, documentId] = args as [string | null, string, string];
      let changes = 0;
      for (const j of t.statement_extractions) {
        if (j.documentId === documentId) {
          j.providerState = state;
          j.updatedAt = now;
          changes++;
        }
      }
      return { rows: [], changes };
    }
    if (/UPDATE statement_extractions/i.test(sql)) {
      const [provider, model, now, documentId, expected] = args as string[];
      let changes = 0;
      for (const j of t.statement_extractions) {
        if (j.documentId === documentId && j.updatedAt === expected) {
          Object.assign(j, {
            status: 'pending',
            provider,
            model,
            error: null,
            providerState: null,
            updatedAt: now,
          });
          changes++;
        }
      }
      return { rows: [], changes };
    }
    if (/INSERT INTO statement_extractions/i.test(sql)) {
      const documentId = args[0] as string;
      const existing = t.statement_extractions.find((j) => j.documentId === documentId);
      if (/DO NOTHING/i.test(sql)) {
        if (existing) return { rows: [], changes: 0 };
        const [, provider, model, createdAt, updatedAt] = args as string[];
        t.statement_extractions.push({
          documentId,
          status: 'pending',
          rowCount: 0,
          truncated: 0,
          provider,
          model,
          error: null,
          createdAt,
          updatedAt,
          providerState: null,
        });
        return { rows: [], changes: 1 };
      }
      const [, status, rowCount, truncated, provider, model, error, createdAt, updatedAt] =
        args as [string, string, number, number, string, string, string | null, string, string];
      if (existing) {
        Object.assign(existing, { status, rowCount, truncated, provider, model, error, updatedAt });
      } else {
        t.statement_extractions.push({
          documentId,
          status,
          rowCount,
          truncated,
          provider,
          model,
          error,
          createdAt,
          updatedAt,
          providerState: null,
        });
      }
      return { rows: [], changes: 1 };
    }
    if (/FROM statement_extractions WHERE documentId = \?/i.test(sql)) {
      return {
        rows: t.statement_extractions.filter((j) => j.documentId === args[0]).map((j) => ({ ...j })),
        changes: 0,
      };
    }

    if (/DELETE FROM statement_rows/i.test(sql)) {
      const before = t.statement_rows.length;
      t.statement_rows = t.statement_rows.filter(
        (r) => !(r.documentId === args[0] && (r.status === 'proposed' || r.status === 'dismissed')),
      );
      return { rows: [], changes: before - t.statement_rows.length };
    }
    if (/FROM statement_rows\s+WHERE documentId = \? AND status = 'confirmed'/i.test(sql)) {
      return {
        rows: t.statement_rows.filter((r) => r.documentId === args[0] && r.status === 'confirmed'),
        changes: 0,
      };
    }
    if (/FROM statement_rows\s+WHERE documentId IN/i.test(sql)) {
      return {
        rows: t.statement_rows
          .filter((r) => (args as string[]).includes(r.documentId as string))
          .sort((a, b) => (a.idx as number) - (b.idx as number)),
        changes: 0,
      };
    }
    if (/INSERT INTO statement_rows/i.test(sql)) {
      const [id, documentId, idx, fields, status, duplicate, lowestConfidence, createdAt] = args;
      t.statement_rows.push({ id, documentId, idx, fields, status, duplicate, lowestConfidence, createdAt });
      return { rows: [], changes: 1 };
    }

    if (/FROM rules/i.test(sql)) return { rows: t.rules, changes: 0 };

    if (/SELECT fingerprint FROM transactions/i.test(sql)) {
      return {
        rows: t.transactions
          .filter((x) => (args as string[]).includes(x.fingerprint as string))
          .map((x) => ({ fingerprint: x.fingerprint })),
        changes: 0,
      };
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

  return { db, tables: t, executed };
}

function makeEnv(seed: Partial<Tables> = {}, bucketBytes: Uint8Array = new Uint8Array([1, 2, 3])) {
  const fake = fakeDb({
    documents: [
      {
        id: DOC,
        mimeType: 'application/pdf',
        objectKey: OBJECT_KEY,
        size: bucketBytes.length,
        pageCount: null,
      },
    ],
    ...seed,
  });
  const env = {
    DB: fake.db,
    BUCKET: {
      get: async (key: string) =>
        key === OBJECT_KEY ? { arrayBuffer: async () => bucketBytes.buffer } : null,
    },
  } as unknown as Env;
  return { env, ...fake };
}

function customSettings(overrides: Record<string, unknown> = {}): Map<string, string> {
  const entries: Record<string, unknown> = {
    aiProvider: 'custom',
    customBaseUrl: 'https://integrate.api.nvidia.com/v1',
    aiModel: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    customApiKeySecret: SECRET,
    ...overrides,
  };
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(entries)) {
    if (v === undefined) continue;
    map.set(k, JSON.stringify(v));
  }
  return map;
}

const NOW_ISH = () => new Date().toISOString();

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

/** A pending client-pages job row as begin leaves it. */
function clientPendingJob(overrides: Partial<JobRecord> = {}): JobRecord {
  const now = NOW_ISH();
  return {
    documentId: DOC,
    status: 'pending',
    rowCount: 0,
    truncated: 0,
    provider: 'custom',
    model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    error: null,
    createdAt: now,
    updatedAt: now,
    providerState: JSON.stringify({ v: 1, mode: 'client-pages', beganAt: now }),
    ...overrides,
  };
}

function textPage(index: number, content = `Statement text for page ${index + 1}`): StatementPageInput {
  return { index, kind: 'text', content };
}

function imagePage(index: number): StatementPageInput {
  return { index, kind: 'image', content: `data:image/jpeg;base64,QUJD${index}` };
}

/** One raw row in the STATEMENT_SCHEMA envelope shape the model is asked for. */
function envelopeRow(merchant: string, amount = 100): Record<string, unknown> {
  return {
    date: { value: '2026-03-04', confidence: 0.9 },
    merchant: { value: merchant, confidence: 0.9 },
    amount: { value: amount, confidence: 0.9 },
    type: { value: 'expense', confidence: 0.9 },
    category: { value: null, confidence: 0 },
  };
}

// ---------------------------------------------------------------------------
// Scripted OpenAI-compatible endpoint
// ---------------------------------------------------------------------------

interface Call {
  url: string;
  init?: RequestInit;
}

function completionResponse(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function scriptedFetch(respond: (call: Call, n: number) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return respond(call, calls.length);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function sentMessages(call: Call): ChatMessage[] {
  return (JSON.parse(String(call.init?.body)) as { messages: ChatMessage[] }).messages;
}

// ---------------------------------------------------------------------------
// Page-payload validation matrix
// ---------------------------------------------------------------------------

describe('validateRoundPages', () => {
  it('accepts a full round of mixed pages', () => {
    const pages = [textPage(0), imagePage(1), textPage(2)];
    expect(validateRoundPages({ pages })).toEqual(pages);
  });

  const bad: [string, unknown, RegExp][] = [
    ['a non-object body', 'pages', /send the pages/i],
    ['a missing pages array', {}, /send the pages/i],
    ['an empty round', { pages: [] }, /at least one page/i],
    [
      'more than the per-round cap',
      { pages: Array.from({ length: 5 }, (_, i) => textPage(i)) },
      /at most 4 pages per round/i,
    ],
    ['a non-object page', { pages: ['p'] }, /Page 1: expected an object/],
    ['a fractional index', { pages: [{ index: 1.5, kind: 'text', content: 'x' }] }, /index/i],
    ['a negative index', { pages: [{ index: -1, kind: 'text', content: 'x' }] }, /index/i],
    [
      'a duplicate index',
      { pages: [textPage(3), textPage(3)] },
      /Page 2: page index 3 was sent twice/,
    ],
    ['an unknown kind', { pages: [{ index: 0, kind: 'pdf', content: 'x' }] }, /kind/i],
    ['empty content', { pages: [{ index: 0, kind: 'text', content: '' }] }, /non-empty string/i],
    [
      'text past the 20k cap',
      { pages: [{ index: 0, kind: 'text', content: 'x'.repeat(STATEMENT_PAGE_TEXT_MAX_CHARS + 1) }] },
      /longer than 20000 characters/,
    ],
    [
      'an image that is not a data URI',
      { pages: [{ index: 0, kind: 'image', content: 'https://evil.example/x.jpg' }] },
      /base64 JPEG or PNG data URI/,
    ],
    [
      'a GIF data URI — jpeg/png only',
      { pages: [{ index: 0, kind: 'image', content: 'data:image/gif;base64,QUJD' }] },
      /base64 JPEG or PNG data URI/,
    ],
    [
      'an image past the 2 MB cap',
      {
        pages: [
          {
            index: 0,
            kind: 'image',
            content: `data:image/png;base64,${'A'.repeat(STATEMENT_PAGE_IMAGE_MAX_BYTES)}`,
          },
        ],
      },
      /larger than 2 MB/,
    ],
  ];

  for (const [label, body, message] of bad) {
    it(`400s on ${label}, readably`, () => {
      expect(() => validateRoundPages(body)).toThrow(message);
      try {
        validateRoundPages(body);
      } catch (err) {
        expect(err).toMatchObject({ status: 400 });
      }
    });
  }

  it('a text page exactly at the cap passes', () => {
    const pages = [{ index: 0, kind: 'text' as const, content: 'x'.repeat(STATEMENT_PAGE_TEXT_MAX_CHARS) }];
    expect(validateRoundPages({ pages })).toEqual(pages);
  });
});

// ---------------------------------------------------------------------------
// Message building — what a schema-less endpoint is actually asked
// ---------------------------------------------------------------------------

describe('round message building', () => {
  const CATEGORIES = ['Groceries', 'Dining', 'Needs review'];

  it('text pages ride ONE user turn: statement prompt, per-page delimiters, shape spelled out', () => {
    const messages = buildTextRoundMessages(
      [textPage(2, 'PAGE THREE TEXT'), textPage(3, 'PAGE FOUR TEXT')],
      CATEGORIES,
    );
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(String(messages[0].content)).toContain('bank or credit-card statement');
    expect(String(messages[0].content)).toContain('Groceries, Dining, Needs review');
    const user = String(messages[1].content);
    expect(user).toContain('extracted text of pages 3–4');
    expect(user).toContain('--- Page 3 ---\nPAGE THREE TEXT');
    expect(user).toContain('--- Page 4 ---\nPAGE FOUR TEXT');
    expect(user).toContain('Extract every transaction row');
    expect(user).toContain(STATEMENT_ROWS_SHAPE_INSTRUCTION);
  });

  it('a single text page reads "page N", not a one-page range', () => {
    const messages = buildTextRoundMessages([textPage(0, 'ONLY')], CATEGORIES);
    expect(String(messages[1].content)).toContain('extracted text of page 1 of');
  });

  it('image pages ride ONE vision turn, in page order, instruction last', () => {
    const messages = buildImageRoundMessages([imagePage(1), imagePage(2)], CATEGORIES);
    expect(messages).toHaveLength(2);
    const content = messages[1].content as Exclude<ChatMessage['content'], string>;
    expect(content).toHaveLength(3);
    expect(content[0]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,QUJD1' },
    });
    expect(content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,QUJD2' },
    });
    expect(content[2]).toMatchObject({ type: 'text' });
    const text = (content[2] as { type: 'text'; text: string }).text;
    expect(text).toContain('pages 2–3');
    expect(text).toContain(STATEMENT_ROWS_SHAPE_INSTRUCTION);
  });
});

// ---------------------------------------------------------------------------
// Round grouping — text batched into one call, images into one, mixed = two
// ---------------------------------------------------------------------------

const CFG = {
  baseUrl: 'https://integrate.api.nvidia.com/v1',
  apiKey: SECRET,
  model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
};

describe('runStatementPagesRound — grouping', () => {
  it('an all-text round is exactly ONE call', async () => {
    const { fetchImpl, calls } = scriptedFetch(() =>
      completionResponse(JSON.stringify({ rows: [envelopeRow('a')] })),
    );
    const out = await runStatementPagesRound(CFG, [textPage(0), textPage(1)], [], { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(out.rows).toHaveLength(1);
    expect(out.truncated).toBe(false);
  });

  it('an all-image round is exactly ONE vision call carrying every image', async () => {
    const { fetchImpl, calls } = scriptedFetch(() =>
      completionResponse(JSON.stringify({ rows: [envelopeRow('a')] })),
    );
    await runStatementPagesRound(CFG, [imagePage(0), imagePage(1), imagePage(2)], [], { fetchImpl });
    expect(calls).toHaveLength(1);
    const content = sentMessages(calls[0])[1].content as Exclude<ChatMessage['content'], string>;
    expect(content.filter((p) => p.type === 'image_url')).toHaveLength(3);
  });

  it('a mixed round is exactly TWO calls, rows concatenated in first-page order', async () => {
    const { fetchImpl, calls } = scriptedFetch((call) => {
      const isVision = String(call.init?.body).includes('image_url');
      return completionResponse(
        JSON.stringify({ rows: [envelopeRow(isVision ? 'from-image' : 'from-text')] }),
      );
    });
    // The image pages come FIRST in page order (0,1); text follows (2,3) —
    // so the vision call's rows must lead the concatenation.
    const out = await runStatementPagesRound(
      CFG,
      [textPage(2), imagePage(0), textPage(3), imagePage(1)],
      [],
      { fetchImpl },
    );
    expect(calls).toHaveLength(2);
    expect(
      out.rows.map((r) => (r as { merchant: { value: string } }).merchant.value),
    ).toEqual(['from-image', 'from-text']);
  });

  it('a fenced answer parses; an answer cut mid-JSON salvages its complete rows and reports truncation', async () => {
    const fenced = ['```json', JSON.stringify({ rows: [envelopeRow('fenced')] }), '```'].join('\n');
    const okRun = scriptedFetch(() => completionResponse(fenced));
    const ok = await runStatementPagesRound(CFG, [textPage(0)], [], { fetchImpl: okRun.fetchImpl });
    expect(ok.rows).toHaveLength(1);
    expect(ok.truncated).toBe(false);

    const cut = `{"rows": [${JSON.stringify(envelopeRow('whole'))}, {"date": {"va`;
    const cutRun = scriptedFetch(() => completionResponse(cut));
    const salvaged = await runStatementPagesRound(CFG, [textPage(0)], [], {
      fetchImpl: cutRun.fetchImpl,
    });
    expect(salvaged.rows).toHaveLength(1);
    expect(salvaged.truncated).toBe(true);
  });

  it('an answer with no rows JSON at all throws the readable copy — never an empty success', async () => {
    const { fetchImpl } = scriptedFetch(() => completionResponse('I could not read these pages.'));
    await expect(runStatementPagesRound(CFG, [textPage(0)], [], { fetchImpl })).rejects.toThrow(
      /could not be read/i,
    );
  });
});

// ---------------------------------------------------------------------------
// begin — gates, claim, and the tick-isolation pins
// ---------------------------------------------------------------------------

describe('beginClientStatement', () => {
  it('claims the job and parks the client-pages state the tick path must refuse', async () => {
    const { env, tables } = makeEnv({ settings: customSettings() });
    const begun = await beginClientStatement(env, DOC);
    expect(begun.ok).toBe(true);
    // The runId scopes every later round/finalize/abort to THIS run.
    expect(typeof begun.runId).toBe('string');
    expect(begun.runId).not.toBe('');

    const job = tables.statement_extractions[0];
    expect(job.status).toBe('pending');
    expect(job.provider).toBe('custom');
    const state = parseClientPagesState(job.providerState);
    expect(state).toMatchObject({ v: 1, mode: 'client-pages', runId: begun.runId });

    // THE isolation pins: the Sarvam resumable reader refuses this blob, so
    // progress stays null — which is exactly the signal the S12 tick driver
    // uses to leave a pending job alone.
    expect(parseProviderState(job.providerState)).toBeNull();
    expect(statementProgress('pending', job.providerState)).toBeNull();
  });

  it('400s readably for a non-custom provider — their door is /extract', async () => {
    const { env } = makeEnv({
      settings: new Map([
        ['aiProvider', JSON.stringify('sarvam')],
        ['sarvamApiKeySecret', JSON.stringify('sk-sarvam')],
      ]),
    });
    await expect(beginClientStatement(env, DOC)).rejects.toThrow(/reads statements directly/i);
  });

  it('runs the custom config gates: no base URL / no model → the pinned 400s, no claim taken', async () => {
    const noUrl = makeEnv({ settings: customSettings({ customBaseUrl: '' }) });
    await expect(beginClientStatement(noUrl.env, DOC)).rejects.toThrow(
      /endpoint base URL in Settings/i,
    );
    expect(noUrl.tables.statement_extractions).toHaveLength(0);

    const noModel = makeEnv({ settings: customSettings({ aiModel: null }) });
    await expect(beginClientStatement(noModel.env, DOC)).rejects.toThrow(
      'Set the model id in Settings → AI.',
    );
    expect(noModel.tables.statement_extractions).toHaveLength(0);
  });

  it('a keyless custom endpoint is fully valid — the key is optional here too', async () => {
    const { env } = makeEnv({ settings: customSettings({ customApiKeySecret: undefined }) });
    expect(await beginClientStatement(env, DOC)).toMatchObject({ ok: true });
  });

  it('refuses non-PDF mimes with the statement mime copy', async () => {
    const { env } = makeEnv({
      settings: customSettings(),
      documents: [{ id: DOC, mimeType: 'text/csv', objectKey: OBJECT_KEY, size: 10, pageCount: null }],
    });
    await expect(beginClientStatement(env, DOC)).rejects.toThrow(/Transactions page/i);
  });

  it('409s against a live claim, and reclaims over a lapsed one', async () => {
    const live = makeEnv({
      settings: customSettings(),
      statement_extractions: [clientPendingJob()],
    });
    await expect(beginClientStatement(live.env, DOC)).rejects.toMatchObject({ status: 409 });

    const stale = makeEnv({
      settings: customSettings(),
      statement_extractions: [clientPendingJob({ updatedAt: minutesAgo(5), createdAt: minutesAgo(5) })],
    });
    expect(await beginClientStatement(stale.env, DOC)).toMatchObject({ ok: true });
    const state = parseClientPagesState(stale.tables.statement_extractions[0].providerState);
    expect(state).not.toBeNull();
    // A fresh claim, not the abandoned one.
    expect(Date.parse(state!.beganAt)).toBeGreaterThan(Date.now() - 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// /statement/extract against a browser claim — the 409 pin, and the fresh-run
// refusal
// ---------------------------------------------------------------------------

describe('runStatementExtraction vs the browser flow', () => {
  it('a POST on a live client-pages claim → 409 in-flight (never a tick, never a reclaim)', async () => {
    const { env, executed } = makeEnv({
      settings: customSettings(),
      statement_extractions: [clientPendingJob()],
    });
    await expect(runStatementExtraction(env, DOC)).rejects.toMatchObject({ status: 409 });
    // Neither the claim UPDATE nor any state write ran.
    expect(executed.some((e) => /SET status = 'pending'/.test(e.sql))).toBe(false);
    expect(executed.some((e) => /SET providerState = \?/.test(e.sql))).toBe(false);
  });

  it('a fresh custom run is refused with the pinned browser-flow copy, leaving no row behind', async () => {
    const { env, tables } = makeEnv({ settings: customSettings() });
    await expect(runStatementExtraction(env, DOC)).rejects.toThrow(CUSTOM_STATEMENT_BROWSER_FLOW);
    await expect(runStatementExtraction(env, DOC)).rejects.toMatchObject({ status: 400 });
    expect(tables.statement_extractions).toHaveLength(0);
  });

  it('a lapsed client-pages claim no longer 409s — the config gates answer instead', async () => {
    const { env } = makeEnv({
      settings: customSettings(),
      statement_extractions: [clientPendingJob({ updatedAt: minutesAgo(5) })],
    });
    await expect(runStatementExtraction(env, DOC)).rejects.toThrow(CUSTOM_STATEMENT_BROWSER_FLOW);
  });
});

// ---------------------------------------------------------------------------
// round — the guard, the wire, the claim re-stamp
// ---------------------------------------------------------------------------

describe('clientStatementRound', () => {
  function roundEnv(overrides: Partial<Tables> = {}) {
    return makeEnv({
      settings: customSettings(),
      statement_extractions: [clientPendingJob()],
      ...overrides,
    });
  }

  it('409s without a client-pages claim — no job, settled job, or a Sarvam resumable run', async () => {
    const noJob = makeEnv({ settings: customSettings() });
    await expect(
      clientStatementRound(noJob.env, DOC, { pages: [textPage(0)] }),
    ).rejects.toMatchObject({ status: 409 });

    const settled = roundEnv({
      statement_extractions: [clientPendingJob({ status: 'suggested', providerState: null })],
    });
    await expect(
      clientStatementRound(settled.env, DOC, { pages: [textPage(0)] }),
    ).rejects.toMatchObject({ status: 409 });

    const sarvamRun = roundEnv({
      statement_extractions: [
        clientPendingJob({
          providerState: JSON.stringify({
            v: 1,
            jobs: [{ jobId: 'j', status: 'submitted' }],
            batchCount: 1,
            submittedAt: NOW_ISH(),
          }),
        }),
      ],
    });
    await expect(
      clientStatementRound(sarvamRun.env, DOC, { pages: [textPage(0)] }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('sends Bearer auth from the STORED key (never a client value) and returns raw rows unpersisted', async () => {
    const { fetchImpl, calls } = scriptedFetch(() =>
      completionResponse(JSON.stringify({ rows: [envelopeRow('raw-as-returned')] })),
    );
    const { env, tables } = roundEnv();
    // Backdate the seeded claim: the re-stamp writes a fresh now(), and on a
    // fast machine seed + round can land in the SAME millisecond, making a
    // plain not-equal assertion flaky (caught once at merge time).
    tables.statement_extractions[0].updatedAt = '2026-01-01T00:00:00.000Z';
    const before = tables.statement_extractions[0].updatedAt;
    const out = await clientStatementRound(env, DOC, { pages: [textPage(0)] }, { fetchImpl });

    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${SECRET}`,
    );
    expect(out.rows).toEqual([envelopeRow('raw-as-returned')]);
    expect(out.truncated).toBe(false);
    // Persists nothing…
    expect(tables.statement_rows).toHaveLength(0);
    expect(tables.statement_extractions[0].status).toBe('pending');
    // …except the claim re-stamp that keeps a slow read visibly alive.
    expect(tables.statement_extractions[0].updatedAt).not.toBe(before);
    expect(parseClientPagesState(tables.statement_extractions[0].providerState)).not.toBeNull();
  });

  it('a keyless server gets no Authorization header at all', async () => {
    const { fetchImpl, calls } = scriptedFetch(() =>
      completionResponse(JSON.stringify({ rows: [] })),
    );
    const { env } = roundEnv({ settings: customSettings({ customApiKeySecret: undefined }) });
    await clientStatementRound(env, DOC, { pages: [textPage(0)] }, { fetchImpl });
    expect('Authorization' in (calls[0].init?.headers as Record<string, string>)).toBe(false);
  });

  it('config gone mid-run → the readable config 400 (retryable once the user fixes Settings)', async () => {
    const { env } = roundEnv({
      settings: customSettings({ customBaseUrl: '' }),
    });
    await expect(clientStatementRound(env, DOC, { pages: [textPage(0)] })).rejects.toThrow(
      /endpoint base URL in Settings/i,
    );
  });

  it('a mid-run provider switch does NOT strand the read — the claim was taken as custom', async () => {
    const { fetchImpl } = scriptedFetch(() =>
      completionResponse(JSON.stringify({ rows: [envelopeRow('still-works')] })),
    );
    const { env } = roundEnv({ settings: customSettings({ aiProvider: 'off' }) });
    const out = await clientStatementRound(env, DOC, { pages: [textPage(0)] }, { fetchImpl });
    expect(out.rows).toHaveLength(1);
  });

  it('model trouble becomes a readable 400 with the endpoint taxonomy copy — the round is retryable', async () => {
    const { fetchImpl } = scriptedFetch(() => new Response('{}', { status: 429 }));
    const { env, tables } = roundEnv();
    await expect(
      clientStatementRound(env, DOC, { pages: [textPage(0)] }, { fetchImpl }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      clientStatementRound(env, DOC, { pages: [textPage(0)] }, { fetchImpl }),
    ).rejects.toThrow(/rate limited/i);
    // The claim survives a failed round — the client retries against it.
    expect(tables.statement_extractions[0].status).toBe('pending');
    expect(parseClientPagesState(tables.statement_extractions[0].providerState)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// finalize — the EXISTING pipeline, exactly
// ---------------------------------------------------------------------------

const RAW_UPI = 'UPI-SWIGGY LIMITED-swiggy@axis-402934857382-Payment';

describe('finalizeClientStatement', () => {
  function finalizeEnv(overrides: Partial<Tables> = {}) {
    return makeEnv({
      settings: customSettings(),
      statement_extractions: [clientPendingJob()],
      ...overrides,
    });
  }

  it('409s without the claim, and 400s on malformed bodies', async () => {
    const noClaim = makeEnv({ settings: customSettings() });
    await expect(
      finalizeClientStatement(noClaim.env, DOC, { rows: [], truncated: false }),
    ).rejects.toMatchObject({ status: 409 });

    const { env } = finalizeEnv();
    await expect(finalizeClientStatement(env, DOC, { rows: 'many' })).rejects.toThrow(
      /send the rows/i,
    );
    await expect(finalizeClientStatement(env, DOC, { rows: [] })).rejects.toThrow(
      /truncated/i,
    );
  });

  it('runs enrichment + duplicate pre-flags on the CLEANED merchant and settles suggested', async () => {
    const { env, tables } = finalizeEnv({
      transactions: [
        {
          id: 'tx-1',
          fingerprint: txFingerprint('2026-03-04', 'Swiggy Limited', 100, 'Main Checking'),
        },
      ],
      rules: [
        {
          id: 'rule-1',
          whenText: 'merchant contains swiggy',
          thenText: 'set category to Dining',
          enabled: 1,
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });

    const result = await finalizeClientStatement(env, DOC, {
      rows: [envelopeRow(RAW_UPI), envelopeRow('Blue Tokai', 41)],
      truncated: false,
    });

    expect(result.status).toBe('suggested');
    expect(result.rowCount).toBe(2);
    expect(result.progress).toBeNull();
    // Sprint-13 enrichment, through THIS door too: descriptor cleaned, the
    // user's own rule fills the blank category at confidence 1.
    expect(result.rows[0].merchant.value).toBe('Swiggy Limited');
    expect(result.rows[0].category).toEqual({ value: 'Dining', confidence: 1 });
    // Duplicate pre-flag agrees with the cleaned-name fingerprint.
    expect(result.rows[0].duplicate).toBe(true);
    expect(result.rows[1].duplicate).toBe(false);
    // Claim cleared — the read is over.
    expect(tables.statement_extractions[0].providerState).toBeNull();
  });

  it('rows the user already imported are not re-proposed (confirmed-fingerprint exclusion)', async () => {
    const confirmedFields = {
      date: { value: '2026-03-04', confidence: 0.9 },
      merchant: { value: 'Swiggy Limited', confidence: 0.9 },
      amount: { value: 100, confidence: 0.9 },
      type: { value: 'expense', confidence: 0.9 },
      category: { value: null, confidence: 0 },
    };
    const { env } = finalizeEnv({
      statement_rows: [
        {
          id: 'row-confirmed',
          documentId: DOC,
          idx: 0,
          fields: JSON.stringify(confirmedFields),
          status: 'confirmed',
          duplicate: 0,
          lowestConfidence: 0.9,
          createdAt: minutesAgo(30),
        },
      ],
    });

    const result = await finalizeClientStatement(env, DOC, {
      // The raw descriptor cleans to the confirmed row's merchant — same
      // fingerprint, so it is excluded; the other row is fresh.
      rows: [envelopeRow(RAW_UPI), envelopeRow('Fresh Merchant', 55)],
      truncated: false,
    });
    expect(result.rowCount).toBe(2); // 1 confirmed kept + 1 fresh
    const proposed = result.rows.filter((r) => r.status === 'proposed');
    expect(proposed).toHaveLength(1);
    expect(proposed[0].merchant.value).toBe('Fresh Merchant');
  });

  it('truncated=true from the client → loud partial', async () => {
    const { env } = finalizeEnv();
    const result = await finalizeClientStatement(env, DOC, {
      rows: [envelopeRow('kept')],
      truncated: true,
    });
    expect(result.status).toBe('partial');
    expect(result.truncated).toBe(true);
  });

  it('the MAX_STATEMENT_ROWS cap marks the run partial even when the client said complete', async () => {
    const { env } = finalizeEnv();
    const rows = Array.from({ length: 301 }, (_, i) => envelopeRow(`m-${i}`, i + 1));
    const result = await finalizeClientStatement(env, DOC, { rows, truncated: false });
    expect(result.status).toBe('partial');
    expect(result.truncated).toBe(true);
    expect(result.rowCount).toBe(300);
  });

  it('a >300-row statement advances past its first page once those rows are confirmed (cap-before-exclusion regression)', async () => {
    // Live bug: normalizeStatementRows used to cap at MAX_STATEMENT_ROWS
    // BEFORE confirmed-row exclusion, so re-running the same statement after
    // importing its first 300 rows re-capped to that SAME first 300, excluded
    // every one of them as already-confirmed, and proposed zero — a
    // statement over 300 rows could never finish.
    const { env, tables } = finalizeEnv();
    const rows = Array.from({ length: 305 }, (_, i) => envelopeRow(`m-${i}`, i + 1));

    const first = await finalizeClientStatement(env, DOC, { rows, truncated: false });
    expect(first.status).toBe('partial');
    expect(first.rowCount).toBe(300);
    expect(tables.statement_rows).toHaveLength(300);

    // The user imports everything proposed — mark those 300 rows confirmed,
    // the same status confirmStatementRows leaves behind.
    for (const row of tables.statement_rows) row.status = 'confirmed';

    // A fresh browser-pages claim, as a real re-run would take.
    tables.statement_extractions[0].status = 'pending';
    tables.statement_extractions[0].providerState = JSON.stringify({
      v: 1,
      mode: 'client-pages',
      beganAt: NOW_ISH(),
    });

    // Re-running the SAME 305 rows must not re-cap the same first 300 and
    // exclude them all to zero — rows 300–304 must appear as freshly
    // proposed, and the job must no longer report partial.
    const second = await finalizeClientStatement(env, DOC, { rows, truncated: false });
    expect(second.status).toBe('suggested');
    expect(second.truncated).toBe(false);
    expect(second.rowCount).toBe(305);
    const proposed = second.rows.filter((r) => r.status === 'proposed');
    expect(proposed).toHaveLength(5);
    // cleanBankDescriptor title-cases the lone letter token ("m-300" → "M 300")
    // — enrichment applies on both runs, so the assertion matches its output.
    expect(proposed.map((r) => r.merchant.value).sort()).toEqual(
      ['M 300', 'M 301', 'M 302', 'M 303', 'M 304'].sort(),
    );
  });

  it('zero rows → an honest failed job, never "0 proposed"; state cleared', async () => {
    const { env, tables } = finalizeEnv();
    const result = await finalizeClientStatement(env, DOC, { rows: [], truncated: true });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/no transactions could be read/i);
    expect(tables.statement_extractions[0].providerState).toBeNull();
  });

  it('zero rows with a client diagnostic → the failure names its cause (2026-08-13 incident)', async () => {
    const { env } = finalizeEnv();
    const result = await finalizeClientStatement(env, DOC, {
      rows: [],
      truncated: true,
      diagnostic: 'The model answered but no transaction rows could be read from it (finish_reason: length).',
    });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/no transactions could be read/i);
    expect(result.error).toContain('finish_reason: length');
  });

  it('rows are suggestions, not trusted input: never-guess normalization applies verbatim', async () => {
    const { env } = finalizeEnv();
    const result = await finalizeClientStatement(env, DOC, {
      rows: [
        // A "row" with neither date nor amount is not a transaction — dropped.
        { date: { value: null, confidence: 0 }, amount: { value: null, confidence: 0 } },
        // A malformed date and a bogus type are nulled, not guessed.
        {
          date: { value: '03/04/2026', confidence: 0.9 },
          merchant: { value: 'Odd Row', confidence: 0.9 },
          amount: { value: 12, confidence: 0.9 },
          type: { value: 'transfer', confidence: 0.9 },
          category: { value: 'Not A Category', confidence: 0.9 },
        },
      ],
      truncated: false,
    });
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].date.value).toBeNull();
    expect(result.rows[0].type.value).toBeNull();
    expect(result.rows[0].category.value).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// abort — best-effort, idempotent, never touches what isn't a browser read
// ---------------------------------------------------------------------------

describe('abortClientStatement', () => {
  it('settles a pending browser read to failed with the pinned message, claim cleared', async () => {
    const { env, tables } = makeEnv({
      settings: customSettings(),
      statement_extractions: [clientPendingJob()],
    });
    expect(await abortClientStatement(env, DOC)).toEqual({ ok: true });
    const job = tables.statement_extractions[0];
    expect(job.status).toBe('failed');
    expect(job.error).toBe(CLIENT_ABORT_MESSAGE);
    expect(job.providerState).toBeNull();
  });

  it('is a no-op for no job, a settled job, and a Sarvam resumable run', async () => {
    const none = makeEnv({ settings: customSettings() });
    expect(await abortClientStatement(none.env, DOC)).toEqual({ ok: true });
    expect(none.tables.statement_extractions).toHaveLength(0);

    const settled = makeEnv({
      settings: customSettings(),
      statement_extractions: [clientPendingJob({ status: 'suggested', providerState: null })],
    });
    await abortClientStatement(settled.env, DOC);
    expect(settled.tables.statement_extractions[0].status).toBe('suggested');

    const sarvamState = JSON.stringify({
      v: 1,
      jobs: [{ jobId: 'j', status: 'submitted' }],
      batchCount: 1,
      submittedAt: NOW_ISH(),
    });
    const sarvamRun = makeEnv({
      settings: customSettings(),
      statement_extractions: [clientPendingJob({ providerState: sarvamState })],
    });
    await abortClientStatement(sarvamRun.env, DOC);
    expect(sarvamRun.tables.statement_extractions[0].status).toBe('pending');
    expect(sarvamRun.tables.statement_extractions[0].providerState).toBe(sarvamState);
  });
});

describe('runId scoping — a stale tab can never touch a newer run', () => {
  // Live incident 2026-08-13: a mid-read reload's best-effort abort landed
  // AFTER the new tab's begin and cancelled the NEW run.
  const stateWithRun = (runId: string) =>
    JSON.stringify({ v: 1, mode: 'client-pages', beganAt: NOW_ISH(), runId });

  it('an abort carrying a superseded runId is a no-op success', async () => {
    const { env, tables } = makeEnv({
      settings: customSettings(),
      statement_extractions: [clientPendingJob({ providerState: stateWithRun('run-NEW') })],
    });
    expect(await abortClientStatement(env, DOC, { runId: 'run-OLD' })).toEqual({ ok: true });
    expect(tables.statement_extractions[0].status).toBe('pending');
    expect(parseClientPagesState(tables.statement_extractions[0].providerState)).not.toBeNull();
  });

  it('an abort carrying the OWNING runId still cancels', async () => {
    const { env, tables } = makeEnv({
      settings: customSettings(),
      statement_extractions: [clientPendingJob({ providerState: stateWithRun('run-NEW') })],
    });
    await abortClientStatement(env, DOC, { runId: 'run-NEW' });
    expect(tables.statement_extractions[0].status).toBe('failed');
    expect(tables.statement_extractions[0].error).toBe(CLIENT_ABORT_MESSAGE);
  });

  it('a round from a superseded runId 409s instead of riding the new claim', async () => {
    const { env } = makeEnv({
      settings: customSettings(),
      statement_extractions: [clientPendingJob({ providerState: stateWithRun('run-NEW') })],
    });
    await expect(
      clientStatementRound(env, DOC, { pages: [textPage(0)], runId: 'run-OLD' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('legacy state without a runId accepts any caller (cross-deploy compat)', async () => {
    const { env, tables } = makeEnv({
      settings: customSettings(),
      statement_extractions: [clientPendingJob()],
    });
    await abortClientStatement(env, DOC, { runId: 'run-ANY' });
    expect(tables.statement_extractions[0].status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// The state parsers' mutual exclusion, pinned as a contract
// ---------------------------------------------------------------------------

describe('client-pages state vs the Sarvam resumable reader', () => {
  it('parseProviderState rejects ANY state carrying a mode marker — even a hybrid forgery', () => {
    const hybrid = JSON.stringify({
      v: 1,
      mode: 'client-pages',
      jobs: [{ jobId: 'j', status: 'submitted' }],
      batchCount: 1,
      submittedAt: NOW_ISH(),
    });
    expect(parseProviderState(hybrid)).toBeNull();
    // …and the client-pages reader refuses the Sarvam shape right back.
    const sarvam = JSON.stringify({
      v: 1,
      jobs: [{ jobId: 'j', status: 'submitted' }],
      batchCount: 1,
      submittedAt: NOW_ISH(),
    });
    expect(parseClientPagesState(sarvam)).toBeNull();
  });

  it('parseClientPagesState rejects corrupt shapes → null (a legacy pending, never a guess)', () => {
    for (const bad of [
      null,
      undefined,
      '{nope',
      '"client-pages"',
      JSON.stringify({ v: 2, mode: 'client-pages', beganAt: 'x' }),
      JSON.stringify({ v: 1, mode: 'server-pages', beganAt: 'x' }),
      JSON.stringify({ v: 1, mode: 'client-pages' }),
    ]) {
      expect(parseClientPagesState(bad as string | null)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Preflight — the custom math, and the stored-pageCount fast path
// ---------------------------------------------------------------------------

describe('preflight for the browser flow', () => {
  it('buildStatementPreflight: rounds of the per-round cap, and NEVER an invented cost', () => {
    for (const [pages, batches] of [
      [1, 1],
      [4, 1],
      [5, 2],
      [16, 4],
      [23, 6],
      [100, 25],
    ] as const) {
      expect(buildStatementPreflight(pages, 'custom', null).batches).toBe(batches);
    }
    // Even a saved Sarvam rate never prices someone else's endpoint.
    expect(buildStatementPreflight(23, 'custom', 0.05)).toEqual({
      pages: 23,
      batches: 6,
      provider: 'custom',
      estimatedCost: null,
    });
    expect(CLIENT_STATEMENT_PAGES_PER_ROUND).toBe(4);
  });

  it('a stored pageCount answers without re-parsing the PDF (garbage bytes prove it)', async () => {
    // The bucket holds bytes countPdfPages would choke on — the stored
    // sprint-11 count must answer instead of the parser.
    const { env } = makeEnv(
      {
        settings: customSettings(),
        documents: [
          { id: DOC, mimeType: 'application/pdf', objectKey: OBJECT_KEY, size: 10, pageCount: 23 },
        ],
      },
      new Uint8Array([0, 1, 2, 3]),
    );
    expect(await statementPreflight(env, DOC)).toEqual({
      pages: 23,
      batches: 6,
      provider: 'custom',
      estimatedCost: null,
    });
  });
});
