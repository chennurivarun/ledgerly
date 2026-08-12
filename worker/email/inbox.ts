// The inbox review flow: read → confirm or dismiss.
//
// An inbox email is a *suggestion* (or, when unparsed, just a record that
// something arrived). No transaction exists until the user confirms one, and
// confirming goes through the same insertTransactions pipeline as manual
// entry, CSV, Drive and extractions — same validation, same duplicate
// fingerprint, same rules (spec §4.4, VISION.md principle 2).
import type { BatchInsertResult, InboxEmail, InboxEmailStatus, InboxParsedFields } from '../../shared/types';
import { insertTransactions, validateTxInput } from '../transactions';
import { ApiFail, clip, isRecord } from '../util';
import { INBOX_COLUMNS } from './ingest';

/** /api/state carries the newest 100 in ALL statuses — the UI filters. */
const INBOX_READ_LIMIT = 100;

const STATUSES = new Set<string>(['proposed', 'unparsed', 'confirmed', 'dismissed']);

interface InboxRow {
  id: string;
  messageId: string;
  receivedAt: string;
  fromAddress: string;
  subject: string;
  status: string;
  parsed: string | null;
  documentId: string | null;
  createdAt: string;
}

/** A corrupt `parsed` blob degrades to null rather than breaking /api/state. */
function parseParsedFields(raw: string | null): InboxParsedFields | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (
      typeof parsed.date !== 'string' ||
      typeof parsed.merchant !== 'string' ||
      typeof parsed.amount !== 'number' ||
      (parsed.type !== 'expense' && parsed.type !== 'income') ||
      typeof parsed.pack !== 'string'
    ) {
      return null;
    }
    return {
      date: parsed.date,
      merchant: parsed.merchant,
      amount: parsed.amount,
      type: parsed.type,
      pack: parsed.pack,
    };
  } catch {
    return null;
  }
}

function toInboxEmail(row: InboxRow): InboxEmail {
  return {
    id: row.id,
    receivedAt: row.receivedAt,
    from: row.fromAddress,
    subject: row.subject,
    // An unknown status degrades to the safe terminal state, same as
    // statement rows — a corrupt row must not invite a confirm.
    status: (STATUSES.has(row.status) ? row.status : 'dismissed') as InboxEmailStatus,
    parsed: parseParsedFields(row.parsed),
    documentId: row.documentId,
    createdAt: row.createdAt,
  };
}

/** Newest first, capped — the payload stays bounded as mail accumulates. */
export async function readInboxEmails(db: D1Database): Promise<InboxEmail[]> {
  const { results } = await db
    .prepare(
      `SELECT ${INBOX_COLUMNS} FROM inbox_emails ORDER BY createdAt DESC LIMIT ${INBOX_READ_LIMIT}`,
    )
    .all<InboxRow>();
  return (results ?? []).map(toInboxEmail);
}

async function readInboxRow(db: D1Database, id: string): Promise<InboxRow> {
  const row = await db
    .prepare(`SELECT ${INBOX_COLUMNS} FROM inbox_emails WHERE id = ?`)
    .bind(id)
    .first<InboxRow>();
  if (!row) throw new ApiFail(404, 'That email is no longer in the inbox.');
  return row;
}

/**
 * POST /api/inbox/:id/confirm — body is the user-edited TxInput. Confirmable
 * from 'proposed' AND from 'unparsed': an unparsed email plus a fully
 * user-filled form is legitimate — the email is the receipt trail even when
 * the parser could not read it. Duplicates are reported honestly in the
 * result, not raised as an error (statement precedent): inserted or
 * already-there, both mean the user's transaction is now in the ledger.
 */
export async function confirmInboxEmail(
  db: D1Database,
  id: string,
  body: unknown,
): Promise<BatchInsertResult> {
  const row = await readInboxRow(db, id);
  if (row.status !== 'proposed' && row.status !== 'unparsed') {
    throw new ApiFail(
      400,
      row.status === 'confirmed'
        ? 'That email was already imported.'
        : 'That email was dismissed. Refresh to see its current status.',
    );
  }

  // The user's edited values rule; the email can at most have proposed them.
  // forceSource pins 'email' whatever the payload claims. receipt is
  // server-owned too (an alert email is a trail, not a receipt image) — but a
  // payload boolean would override the default inside validateTxInput, so it
  // is overwritten before validation rather than trusted.
  if (!isRecord(body)) throw new ApiFail(400, 'Check the transaction: expected an object.');
  const payload = { ...body, receipt: false };
  const defaults = { forceSource: 'email' as const, receipt: false };
  const checked = validateTxInput(payload, defaults);
  if (!checked.ok) throw new ApiFail(400, clip(`Check the transaction: ${checked.error}`));

  const result = await insertTransactions(db, [payload], defaults);
  if (result.inserted === 0 && result.duplicates === 0) {
    // validateTxInput passed, so only an insert-time failure lands here.
    throw new ApiFail(400, clip(result.errors[0] ?? 'The transaction could not be saved.'));
  }

  await setInboxStatus(db, id, 'confirmed');
  return result;
}

/**
 * POST /api/inbox/:id/dismiss. Idempotent on an already-dismissed row; a
 * confirmed row cannot be dismissed — its transaction exists, and flipping
 * the record to 'dismissed' would falsify the audit trail.
 */
export async function dismissInboxEmail(db: D1Database, id: string): Promise<void> {
  const row = await readInboxRow(db, id);
  if (row.status === 'dismissed') return;
  if (row.status === 'confirmed') {
    throw new ApiFail(400, 'That email was already imported and can no longer be dismissed.');
  }
  await setInboxStatus(db, id, 'dismissed');
}

async function setInboxStatus(db: D1Database, id: string, status: InboxEmailStatus): Promise<void> {
  await db.prepare('UPDATE inbox_emails SET status = ? WHERE id = ?').bind(status, id).run();
}
