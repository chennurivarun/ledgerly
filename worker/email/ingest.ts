// The ONE ingestion pipeline for inbound email — both doors (the Cloudflare
// Email Routing handler and POST /api/inbound-email) funnel through
// ingestRawEmail, so the security posture cannot fork between them.
//
// Invariants (EM rulings, each pinned by a test in tests/emailFeed.test.ts):
// - Secure by default: emailFeedEnabled=false OR an empty allowlist rejects
//   BEFORE any MIME parsing. A fresh install ingests nothing.
// - Suggestion-only: ingestion NEVER inserts a transaction. The only path from
//   an email to the ledger is /api/inbox/:id/confirm, behind the user's click.
//   A spoofed email can at worst propose an item the user rejects.
// - No AI: inbound email never triggers a model call. Attachments land in the
//   vault as plain stored documents; extraction stays a user-clicked action.
// - Store the minimum: clipped subject, single sender address, parsed fields.
//   No body is persisted, no raw MIME is stored, nothing is logged.
import PostalMime, { type Email } from 'postal-mime';
import { MAX_FILE_BYTES, MAX_INBOX_EMAILS_PER_DAY, type DocumentMeta } from '../../shared/types';
import { computePdfPageCount, insertDocumentRow } from '../documents';
import { readSettings } from '../settingsStore';
import { isUniqueViolation } from '../transactions';
import { ApiFail, clip, safeFilename } from '../util';
import { parseAlertEmail } from './parse';

/** Hard cap on one raw message — enforced before any parsing. */
export const MAX_INBOUND_EMAIL_BYTES = 5 * 1024 * 1024; // 5 MB

export const INBOX_COLUMNS =
  'id, messageId, receivedAt, fromAddress, subject, status, parsed, documentId, createdAt';

export type IngestResult =
  | { ok: 'ingested'; id: string; status: 'proposed' | 'unparsed' }
  /** Same message seen before — a silent success, never a second row. */
  | { ok: 'duplicate' }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Allowlist (pure)
// ---------------------------------------------------------------------------

const ADDRESS_ENTRY = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_ENTRY = /^@[^\s@]+\.[^\s@]+$/;
const MAX_ALLOWED_SENDERS = 100;

/**
 * Validate + normalize the allowlist for PUT /api/preferences. Entries are an
 * exact address ("alerts@chase.com") or a whole domain ("@chase.com"); they
 * are stored lowercased (matching is case-insensitive anyway, so storing the
 * canonical form keeps the settings honest about what they mean). Throws a
 * readable 400 on anything else.
 */
export function normalizeAllowedSenders(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new ApiFail(400, 'emailAllowedSenders must be a list of addresses or @domains.');
  }
  if (raw.length > MAX_ALLOWED_SENDERS) {
    throw new ApiFail(400, `emailAllowedSenders can hold at most ${MAX_ALLOWED_SENDERS} entries.`);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  raw.forEach((value, i) => {
    const entry = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!ADDRESS_ENTRY.test(entry) && !DOMAIN_ENTRY.test(entry)) {
      throw new ApiFail(
        400,
        `emailAllowedSenders[${i}] must be a full address like "alerts@chase.com" or a domain like "@chase.com".`,
      );
    }
    if (seen.has(entry)) return;
    seen.add(entry);
    out.push(entry);
  });
  return out;
}

/**
 * Whether `from` may feed the inbox. Case-insensitive; an entry is either an
 * exact address or an exact-domain "@chase.com". Domain entries compare the
 * WHOLE domain, never a suffix — "user@evil-chase.com" must not ride
 * "@chase.com". Subdomains do not match either ("alerts.chase.com" is not
 * "chase.com"): v1 pins strict equality because a bank's alert subdomain is
 * something the user can allowlist explicitly, while a loose suffix rule is
 * something an attacker registers a domain against.
 */
export function senderAllowed(from: string, allowlist: readonly string[]): boolean {
  const address = from.trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return false;
  const domain = address.slice(at + 1);
  for (const raw of allowlist) {
    const entry = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!entry) continue;
    if (entry.startsWith('@')) {
      if (domain === entry.slice(1)) return true;
    } else if (address === entry) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Attachment storage
// ---------------------------------------------------------------------------

/** v1 stores the FIRST real PDF/image only: bank alerts carry at most one
 * receipt/statement, and "everything in the email" would turn a single
 * forwarded thread into a vault-spamming primitive. `related` parts (images
 * the HTML references — logos, tracking pixels) are never documents. */
function pickAttachment(email: Email): { filename: string; mimeType: string; bytes: Uint8Array } | null {
  for (const att of email.attachments) {
    const mime = att.mimeType.toLowerCase();
    if (mime !== 'application/pdf' && !mime.startsWith('image/')) continue;
    if (att.related) continue;
    const bytes =
      typeof att.content === 'string'
        ? new TextEncoder().encode(att.content)
        : new Uint8Array(att.content as ArrayBuffer | Uint8Array);
    // Same limits as the upload path (worker/documents.ts): empty and >20 MB
    // files never enter the vault. An unusable attachment skips to the next
    // candidate rather than sinking the email — the row is the audit trail.
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_BYTES) continue;
    const fallback = mime === 'application/pdf' ? 'attachment.pdf' : 'attachment';
    return { filename: att.filename?.trim() || fallback, mimeType: att.mimeType, bytes };
  }
  return null;
}

/**
 * Store the picked attachment through the documents pipeline: bytes to R2,
 * metadata row in D1, status 'review' like any other non-CSV upload. Source
 * is 'upload' — DocSource is a frozen contract without an 'email' member, and
 * the inbox row's documentId is what carries the provenance. Returns null on
 * any storage failure: the email itself still ingests.
 */
async function storeAttachment(env: Env, email: Email): Promise<string | null> {
  const picked = pickAttachment(email);
  if (!picked) return null;
  const id = crypto.randomUUID();
  const doc: DocumentMeta = {
    id,
    filename: picked.filename,
    mimeType: picked.mimeType,
    size: picked.bytes.byteLength,
    objectKey: `email-inbox/${id}-${safeFilename(picked.filename)}`,
    status: 'review',
    source: 'upload',
    createdAt: new Date().toISOString(),
    // Same advisory count as the upload path: null on non-PDF or an
    // unreadable PDF, and a failure to count never fails the storage.
    pageCount: await computePdfPageCount(picked.mimeType, picked.bytes),
  };
  try {
    await env.BUCKET.put(doc.objectKey, picked.bytes, {
      httpMetadata: { contentType: doc.mimeType },
    });
    await insertDocumentRow(env.DB, doc, doc.source);
    return id;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Email Date header when readable, else the moment of ingestion — a fact either way. */
function resolveReceivedAt(headerDate: string | undefined, now: string): string {
  const parsed = Date.parse(headerDate ?? '');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : now;
}

/**
 * Ingest one raw RFC-822 message. `envelopeFrom` is the SMTP envelope sender
 * when the door knows it (the Cloudflare email handler always does); null
 * falls back to the parsed From header. Never throws for expected outcomes —
 * the discriminated result is the contract, and the doors map it to HTTP
 * statuses or SMTP rejects.
 */
export async function ingestRawEmail(
  env: Env,
  raw: ArrayBuffer | string,
  envelopeFrom: string | null,
): Promise<IngestResult> {
  const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : new Uint8Array(raw);
  if (bytes.byteLength === 0) return { ok: false, reason: 'The message was empty.' };
  if (bytes.byteLength > MAX_INBOUND_EMAIL_BYTES) {
    return { ok: false, reason: 'The message is larger than 5 MB.' };
  }

  // Secure by default: both gates reject before a single MIME byte is parsed.
  const settings = await readSettings(env.DB);
  if (!settings.emailFeedEnabled) {
    return { ok: false, reason: 'The mail-in feed is turned off in Settings.' };
  }
  const allowlist = settings.emailAllowedSenders;
  if (allowlist.length === 0) {
    return { ok: false, reason: 'No allowed senders are configured, so nothing is ingested.' };
  }
  // The envelope sender, when the door provided one, is checked pre-parse too.
  if (envelopeFrom !== null && !senderAllowed(envelopeFrom, allowlist)) {
    return { ok: false, reason: 'The sender is not on your allowed list.' };
  }

  // Flood cap: at most MAX_INBOX_EMAILS_PER_DAY rows created today (UTC).
  // createdAt is always an ISO UTC timestamp, so the day boundary is a plain
  // string compare.
  const now = new Date().toISOString();
  const capRow = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM inbox_emails WHERE createdAt >= ?',
  )
    .bind(`${now.slice(0, 10)}T00:00:00.000Z`)
    .first<{ n: number }>();
  if ((capRow?.n ?? 0) >= MAX_INBOX_EMAILS_PER_DAY) {
    return { ok: false, reason: 'The daily mail-in limit was reached. Try again tomorrow.' };
  }

  let email: Email;
  try {
    email = await PostalMime.parse(bytes);
  } catch {
    return { ok: false, reason: 'The message could not be read as an email.' };
  }

  const from = (envelopeFrom ?? email.from?.address ?? '').trim();
  if (!from) return { ok: false, reason: 'The sender address could not be determined.' };
  if (!senderAllowed(from, allowlist)) {
    return { ok: false, reason: 'The sender is not on your allowed list.' };
  }

  // Dedupe on Message-ID; a message without one is keyed by a hash of its own
  // bytes (prefixed so it can never collide with a real <…> header value).
  // The read is a fast path — the UNIQUE index is the actual guarantee.
  const messageId = (email.messageId ?? '').trim() || `sha256:${await sha256Hex(bytes)}`;
  const seen = await env.DB.prepare('SELECT id FROM inbox_emails WHERE messageId = ?')
    .bind(messageId)
    .first<{ id: string }>();
  if (seen) return { ok: 'duplicate' };

  const receivedAt = resolveReceivedAt(email.date, now);
  const subject = (email.subject ?? '').trim();
  // Deterministic parse over subject + plain-text body only. HTML-only email
  // parses against the subject alone in v1: a "deterministic" HTML-to-text
  // pass is anything but, and an unparsed row still reaches the user.
  const parsed = parseAlertEmail(subject, email.text ?? '', receivedAt);
  const documentId = await storeAttachment(env, email);

  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO inbox_emails (${INBOX_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        messageId,
        receivedAt,
        from.toLowerCase(),
        clip(subject),
        parsed ? 'proposed' : 'unparsed',
        parsed ? JSON.stringify(parsed) : null,
        documentId,
        now,
      )
      .run();
  } catch (err) {
    // Raced with the same message through the other door — still a success.
    if (isUniqueViolation(err)) return { ok: 'duplicate' };
    throw err;
  }
  return { ok: 'ingested', id, status: parsed ? 'proposed' : 'unparsed' };
}
