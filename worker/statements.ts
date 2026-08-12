// PDF statement extraction: one document in, many *proposed* rows out.
//
// The receipt pipeline's contract, applied to a table (VISION.md phase 2 item
// 3): nothing is inserted without confirmation, every row is re-validated
// server-side, the duplicate fingerprint applies per row, unreadable rows are
// reported and skipped rather than guessed, and a run that could not read the
// whole statement says so instead of quietly returning less.
import { txFingerprint } from '../shared/fingerprint';
import {
  MAX_FILE_BYTES,
  MAX_STATEMENT_ROWS,
  type BatchInsertResult,
  type StatementExtraction,
  type StatementJobStatus,
  type StatementRow,
  type StatementRowStatus,
} from '../shared/types';
import {
  assertStatementMime,
  emptyStatementRow,
  extractStatementFromDocument,
  lowestConfidence,
  normalizeStatementRows,
  selectStatementProvider,
  type StatementRowFields,
} from './ai';
import { extractionInFlight, readDocumentRow } from './extractions';
import { readSettings } from './settingsStore';
import {
  DEFAULT_ACCOUNT,
  existingFingerprints,
  insertTransactions,
  validateTxInput,
} from './transactions';
import { ApiFail, clip, isRecord } from './util';

const JOB_COLUMNS =
  'documentId, status, rowCount, truncated, provider, model, error, createdAt, updatedAt';
const ROW_COLUMNS =
  'id, documentId, idx, fields, status, duplicate, lowestConfidence, createdAt';

const JOB_STATUSES = new Set<string>([
  'pending',
  'suggested',
  'partial',
  'confirmed',
  'dismissed',
  'failed',
]);

const ROW_STATUSES = new Set<string>(['proposed', 'confirmed', 'dismissed']);

/** Job states whose rows the review screen can still act on. */
const REVIEWABLE = ['pending', 'suggested', 'partial'];

/**
 * ponytail: /api/state loads rows only for jobs still awaiting review, and only
 * for the newest few of those. A settled job's rows have done their work — the
 * transactions they became live in `transactions` — so the payload stays bounded
 * by what a review screen can show (10 × 300) instead of by the whole vault
 * (100 documents × 300 rows). The job record itself is always returned, so the
 * UI can still show that a statement was read, and what it said.
 */
const ROW_JOB_LIMIT = 10;

interface JobRow {
  documentId: string;
  status: string;
  rowCount: number;
  truncated: number;
  provider: string;
  model: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RowRow {
  id: string;
  documentId: string;
  idx: number;
  fields: string;
  status: string;
  duplicate: number;
  lowestConfidence: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

/** A corrupt `fields` blob degrades to all-unknown rather than breaking /api/state. */
function parseRowFields(raw: string): StatementRowFields {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return emptyStatementRow();
    // Stored rows were normalized on the way in; re-shaping here would need the
    // category list, which is not what this read path is for.
    return { ...emptyStatementRow(), ...(parsed as Partial<StatementRowFields>) };
  } catch {
    return emptyStatementRow();
  }
}

function toStatementRow(row: RowRow): StatementRow {
  const fields = parseRowFields(row.fields);
  return {
    id: row.id,
    documentId: row.documentId,
    index: row.idx,
    date: fields.date,
    merchant: fields.merchant,
    amount: fields.amount,
    type: fields.type,
    category: fields.category,
    status: (ROW_STATUSES.has(row.status) ? row.status : 'dismissed') as StatementRowStatus,
    duplicate: row.duplicate === 1,
    lowestConfidence: row.lowestConfidence,
  };
}

function toStatementJob(row: JobRow, rows: StatementRow[]): StatementExtraction {
  return {
    documentId: row.documentId,
    status: (JOB_STATUSES.has(row.status) ? row.status : 'failed') as StatementJobStatus,
    rowCount: row.rowCount,
    truncated: row.truncated === 1,
    provider: row.provider,
    model: row.model,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    rows,
  };
}

async function readRowsFor(db: D1Database, documentIds: string[]): Promise<Map<string, StatementRow[]>> {
  const byDoc = new Map<string, StatementRow[]>();
  if (documentIds.length === 0) return byDoc;
  const placeholders = documentIds.map(() => '?').join(',');
  const { results } = await db
    .prepare(
      `SELECT ${ROW_COLUMNS} FROM statement_rows
       WHERE documentId IN (${placeholders}) ORDER BY documentId ASC, idx ASC`,
    )
    .bind(...documentIds)
    .all<RowRow>();
  for (const row of results ?? []) {
    const list = byDoc.get(row.documentId) ?? [];
    list.push(toStatementRow(row));
    byDoc.set(row.documentId, list);
  }
  return byDoc;
}

/**
 * Jobs for the documents /api/state actually returned, bounded by that same
 * cap. Rows come back only for the reviewable jobs (see ROW_JOB_LIMIT).
 */
export async function readStatements(
  db: D1Database,
  documentIds: string[],
): Promise<StatementExtraction[]> {
  if (documentIds.length === 0) return [];

  const jobs: JobRow[] = [];
  for (let i = 0; i < documentIds.length; i += 100) {
    const chunk = documentIds.slice(i, i + 100);
    const placeholders = chunk.map(() => '?').join(',');
    const { results } = await db
      .prepare(
        `SELECT ${JOB_COLUMNS} FROM statement_extractions WHERE documentId IN (${placeholders})`,
      )
      .bind(...chunk)
      .all<JobRow>();
    for (const row of results ?? []) jobs.push(row);
  }
  if (jobs.length === 0) return [];

  const withRows = jobs
    .filter((j) => REVIEWABLE.includes(j.status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, ROW_JOB_LIMIT)
    .map((j) => j.documentId);

  const rowsByDoc = await readRowsFor(db, withRows);
  return jobs.map((job) => toStatementJob(job, rowsByDoc.get(job.documentId) ?? []));
}

// ---------------------------------------------------------------------------
// Duplicate pre-flagging (pure — exercised directly by tests)
// ---------------------------------------------------------------------------

/**
 * The fingerprint this row *would* get, or null when it cannot be known.
 *
 * A row missing its date or amount has no answerable duplicate question, and
 * saying "not a duplicate" about a row we could not read would be a guess
 * dressed as a fact — so the caller reports `duplicate: false` for it and the
 * real check still happens at insert time.
 */
export function statementRowFingerprint(
  fields: StatementRowFields,
  account: string,
): string | null {
  const date = fields.date.value;
  const amount = fields.amount.value;
  if (date === null || amount === null) return null;
  return txFingerprint(date, fields.merchant.value ?? '', amount, account);
}

/**
 * Which proposed rows already exist as transactions.
 *
 * ponytail: only stored transactions count. Two identical charges on the same
 * statement (two coffees, same price, same day) are both real, so neither is
 * pre-flagged here — insertTransactions still collapses them at confirm time
 * and reports that honestly in BatchInsertResult.duplicates.
 */
export function flagDuplicates(
  fingerprints: readonly (string | null)[],
  existing: ReadonlySet<string>,
): boolean[] {
  return fingerprints.map((fp) => fp !== null && existing.has(fp));
}

/**
 * The account a proposal is fingerprinted against. Statements do not name one,
 * so the user's first managed account stands in. The confirm step's account
 * wins: whatever the user sends per row is what the transaction is inserted
 * with, so a pre-flag computed here can be wrong in either direction once they
 * change it — which is exactly why insertTransactions re-checks.
 */
export function defaultStatementAccount(accounts: readonly string[]): string {
  return accounts.find((a) => a.trim().length > 0)?.trim() ?? DEFAULT_ACCOUNT;
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

const IN_FLIGHT_MESSAGE =
  'That statement is already being read — give it a moment to finish.';

/**
 * Claim the job for this run. Same shape as the receipt guard
 * (worker/extractions.ts) and the same expiry window, but it matters more here:
 * a statement run is a multi-page metered call, so a double-click that got
 * through would spend real money twice. Exported so tests can drive the claim
 * itself, not just the predicate it leans on.
 */
export async function claimStatement(
  db: D1Database,
  documentId: string,
  provider: string,
  model: string,
  now: string,
): Promise<void> {
  const current = await db
    .prepare('SELECT status, updatedAt FROM statement_extractions WHERE documentId = ?')
    .bind(documentId)
    .first<{ status: string; updatedAt: string }>();
  if (current && extractionInFlight(current.status, current.updatedAt, now)) {
    throw new ApiFail(409, IN_FLIGHT_MESSAGE);
  }

  const claimed = current
    ? await db
        .prepare(
          `UPDATE statement_extractions
           SET status = 'pending', provider = ?, model = ?, error = NULL, updatedAt = ?
           WHERE documentId = ? AND updatedAt = ?`,
        )
        .bind(provider, model, now, documentId, current.updatedAt)
        .run()
    : await db
        .prepare(
          `INSERT INTO statement_extractions (${JOB_COLUMNS})
           VALUES (?, 'pending', 0, 0, ?, ?, NULL, ?, ?)
           ON CONFLICT(documentId) DO NOTHING`,
        )
        .bind(documentId, provider, model, now, now)
        .run();
  if (claimed.meta.changes === 0) throw new ApiFail(409, IN_FLIGHT_MESSAGE);
}

interface SaveJobInput {
  documentId: string;
  status: StatementJobStatus;
  rowCount: number;
  truncated: boolean;
  provider: string;
  model: string;
  error: string | null;
  now: string;
}

/** `createdAt` survives a re-run; everything else is replaced. */
async function saveJob(db: D1Database, input: SaveJobInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO statement_extractions (${JOB_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(documentId) DO UPDATE SET
         status = excluded.status,
         rowCount = excluded.rowCount,
         truncated = excluded.truncated,
         provider = excluded.provider,
         model = excluded.model,
         error = excluded.error,
         updatedAt = excluded.updatedAt`,
    )
    .bind(
      input.documentId,
      input.status,
      input.rowCount,
      input.truncated ? 1 : 0,
      input.provider,
      input.model,
      input.error,
      input.now,
      input.now,
    )
    .run();
}

async function readJob(db: D1Database, documentId: string): Promise<StatementExtraction> {
  const job = await db
    .prepare(`SELECT ${JOB_COLUMNS} FROM statement_extractions WHERE documentId = ?`)
    .bind(documentId)
    .first<JobRow>();
  if (!job) throw new ApiFail(404, 'That statement is no longer available.');
  const rows = await readRowsFor(db, [documentId]);
  return toStatementJob(job, rows.get(documentId) ?? []);
}

/** Rows the user already imported. They keep their place and are never re-proposed. */
async function readConfirmedRows(db: D1Database, documentId: string): Promise<RowRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${ROW_COLUMNS} FROM statement_rows
       WHERE documentId = ? AND status = 'confirmed' ORDER BY idx ASC`,
    )
    .bind(documentId)
    .all<RowRow>();
  return results ?? [];
}

async function insertRows(db: D1Database, rows: RowRow[]): Promise<void> {
  if (rows.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO statement_rows (${ROW_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < rows.length; i += 50) {
    await db.batch(
      rows.slice(i, i + 50).map((r) =>
        stmt.bind(
          r.id,
          r.documentId,
          r.idx,
          r.fields,
          r.status,
          r.duplicate,
          r.lowestConfidence,
          r.createdAt,
        ),
      ),
    );
  }
}

/** POST /api/documents/:id/statement/extract */
export async function runStatementExtraction(
  env: Env,
  documentId: string,
): Promise<StatementExtraction> {
  const doc = await readDocumentRow(env.DB, documentId);
  const settings = await readSettings(env.DB);

  // Configuration problems are the user's to fix, so they are 400s and leave
  // no row behind; only an attempted-and-failed run is stored as `failed`.
  const { provider, model } = selectStatementProvider(settings);
  assertStatementMime(doc.mimeType);
  if (doc.size > MAX_FILE_BYTES) {
    throw new ApiFail(413, 'That file is too large to send for extraction.');
  }

  // Claim before touching R2 or the model — everything above is configuration,
  // everything below is the run itself.
  const now = new Date().toISOString();
  await claimStatement(env.DB, documentId, provider, model, now);

  const object = await env.BUCKET.get(doc.objectKey);
  if (!object) throw new ApiFail(404, 'The stored copy of that file is no longer available.');
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new ApiFail(413, 'That file is too large to send for extraction.');
  }

  try {
    const run = await extractStatementFromDocument(env, settings, doc, bytes);
    const { rows: fields, capped } = normalizeStatementRows(run.rows, settings.categories);
    const account = defaultStatementAccount(settings.accounts);

    // Rows the user already imported keep their place and are not offered
    // again, so re-running after importing half a statement shows the half
    // that is still outstanding — not the whole thing over.
    const confirmed = await readConfirmedRows(env.DB, documentId);
    const alreadyImported = new Set(
      confirmed
        .map((r) => statementRowFingerprint(parseRowFields(r.fields), account))
        .filter((fp): fp is string => fp !== null),
    );

    const fresh = fields.filter((f) => {
      const fp = statementRowFingerprint(f, account);
      return fp === null || !alreadyImported.has(fp);
    });

    const existing = await existingFingerprints(
      env.DB,
      fresh
        .map((f) => statementRowFingerprint(f, account))
        .filter((fp): fp is string => fp !== null),
    );
    const duplicates = flagDuplicates(
      fresh.map((f) => statementRowFingerprint(f, account)),
      existing,
    );

    // A re-run replaces what the user has not triaged. Dismissed rows go too:
    // re-running is how a user asks for another read, and holding their earlier
    // "no" against the new one would return a statement with holes in it.
    await env.DB.prepare(
      "DELETE FROM statement_rows WHERE documentId = ? AND status IN ('proposed', 'dismissed')",
    )
      .bind(documentId)
      .run();

    const base = confirmed.length;
    await insertRows(
      env.DB,
      fresh.map((f, i) => ({
        id: crypto.randomUUID(),
        documentId,
        idx: base + i,
        fields: JSON.stringify(f),
        status: 'proposed',
        duplicate: duplicates[i] ? 1 : 0,
        lowestConfidence: lowestConfidence(f),
        createdAt: now,
      })),
    );

    const truncated = run.truncated || capped;
    await saveJob(env.DB, {
      documentId,
      // 'partial' is the loud status: rows may be missing, and the UI says so.
      status: truncated ? 'partial' : 'suggested',
      rowCount: base + fresh.length,
      truncated,
      provider,
      model,
      error: null,
      now,
    });
    return await readJob(env.DB, documentId);
  } catch (err) {
    if (err instanceof ApiFail) throw err;
    await saveJob(env.DB, {
      documentId,
      status: 'failed',
      rowCount: 0,
      truncated: false,
      provider,
      model,
      error: clip(err instanceof Error ? err.message : 'Statement extraction failed.'),
      now,
    });
    return await readJob(env.DB, documentId);
  }
}

/**
 * POST /api/documents/:id/statement/confirm — body is StatementConfirmInput.
 *
 * Every row goes through the one insert pipeline with `receipt: false` (a
 * statement line is not a receipt) so the fingerprint dedupe applies again
 * server-side. Duplicates are reported honestly in the result, not raised as an
 * error: the transaction the user wanted does exist, it was just already there.
 */
export async function confirmStatementRows(
  env: Env,
  documentId: string,
  body: unknown,
): Promise<BatchInsertResult> {
  await readDocumentRow(env.DB, documentId);

  if (!isRecord(body) || !Array.isArray(body.rows)) {
    throw new ApiFail(400, 'Send the rows you want to import.');
  }
  const list = body.rows;
  if (list.length === 0) throw new ApiFail(400, 'Choose at least one row to import.');
  if (list.length > MAX_STATEMENT_ROWS) {
    throw new ApiFail(400, `Import at most ${MAX_STATEMENT_ROWS} rows at a time.`);
  }

  const proposed = await readProposedIds(env.DB, documentId);
  const rowIds = new Set<string>();
  list.forEach((raw, index) => {
    if (!isRecord(raw)) throw new ApiFail(400, `Row ${index + 1}: expected an object.`);
    const rowId = typeof raw.rowId === 'string' ? raw.rowId.trim() : '';
    if (!rowId || !proposed.has(rowId)) {
      throw new ApiFail(
        400,
        `Row ${index + 1} is no longer awaiting review. Reload the page and try again.`,
      );
    }
    if (rowIds.has(rowId)) throw new ApiFail(400, `Row ${index + 1} was sent twice.`);
    rowIds.add(rowId);
  });

  // Validate before inserting so a bad row is a 400 the review screen can point
  // at, and so every row that survives is one we can honestly mark 'confirmed'
  // — inserted or already-there, both mean the user's row is now in the ledger.
  // receipt is server-owned: a statement line is not a receipt, and
  // validateTxInput lets a payload boolean beat defaults, so it is overwritten
  // on every row before validation (the mail-in confirm's pattern).
  const defaults = { forceSource: 'document' as const, receipt: false };
  const rows = list.map((raw) => (isRecord(raw) ? { ...raw, receipt: false } : raw));
  rows.forEach((raw, index) => {
    const checked = validateTxInput(raw, defaults);
    if (!checked.ok) throw new ApiFail(400, clip(`Row ${index + 1}: ${checked.error}`));
  });

  const result = await insertTransactions(env.DB, rows, defaults);

  const now = new Date().toISOString();
  await markRows(env.DB, documentId, [...rowIds], 'confirmed');

  // Rows the user did not send stay 'proposed' — a half-triaged statement is a
  // normal state, not an error.
  const remaining = await countProposed(env.DB, documentId);
  if (remaining === 0) {
    await setJobStatus(env.DB, documentId, 'confirmed', now);
    await env.DB.prepare("UPDATE documents SET status = 'stored' WHERE id = ?")
      .bind(documentId)
      .run();
  }

  return result;
}

/** POST /api/documents/:id/statement/dismiss */
export async function dismissStatement(env: Env, documentId: string): Promise<void> {
  await readDocumentRow(env.DB, documentId);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE statement_rows SET status = 'dismissed' WHERE documentId = ? AND status = 'proposed'",
  )
    .bind(documentId)
    .run();
  await setJobStatus(env.DB, documentId, 'dismissed', now);
}

async function readProposedIds(db: D1Database, documentId: string): Promise<Set<string>> {
  const { results } = await db
    .prepare("SELECT id FROM statement_rows WHERE documentId = ? AND status = 'proposed'")
    .bind(documentId)
    .all<{ id: string }>();
  return new Set((results ?? []).map((r) => r.id));
}

async function countProposed(db: D1Database, documentId: string): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM statement_rows WHERE documentId = ? AND status = 'proposed'",
    )
    .bind(documentId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function markRows(
  db: D1Database,
  documentId: string,
  ids: string[],
  status: StatementRowStatus,
): Promise<void> {
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const placeholders = chunk.map(() => '?').join(',');
    await db
      .prepare(
        `UPDATE statement_rows SET status = ?
         WHERE documentId = ? AND id IN (${placeholders})`,
      )
      .bind(status, documentId, ...chunk)
      .run();
  }
}

/**
 * Move the job to a terminal status without disturbing the rows it holds — the
 * proposals stay readable after confirm/dismiss so the review history is still
 * auditable. Inserts a bare job when the user resolves a statement that was
 * never extracted.
 */
async function setJobStatus(
  db: D1Database,
  documentId: string,
  status: StatementJobStatus,
  now: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO statement_extractions (${JOB_COLUMNS})
       VALUES (?, ?, 0, 0, '', '', NULL, ?, ?)
       ON CONFLICT(documentId) DO UPDATE SET
         status = excluded.status,
         error = NULL,
         updatedAt = excluded.updatedAt`,
    )
    .bind(documentId, status, now, now)
    .run();
}
