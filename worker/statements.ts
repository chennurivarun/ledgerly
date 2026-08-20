// PDF statement extraction: one document in, many *proposed* rows out.
//
// The receipt pipeline's contract, applied to a table (VISION.md phase 2 item
// 3): nothing is inserted without confirmation, every row is re-validated
// server-side, the duplicate fingerprint applies per row, unreadable rows are
// reported and skipped rather than guessed, and a run that could not read the
// whole statement says so instead of quietly returning less.
import { cleanBankDescriptor } from '../shared/descriptors';
import { txFingerprint } from '../shared/fingerprint';
import { anyStatementPackById } from '../shared/packs/registry';
import {
  CLIENT_STATEMENT_PAGES_PER_ROUND,
  MAX_FILE_BYTES,
  MAX_STATEMENT_ROWS,
  NEEDS_REVIEW,
  type AiProvider,
  type BatchInsertResult,
  type Rule,
  type Settings,
  type StatementExtraction,
  type StatementJobStatus,
  type StatementPagesRoundResult,
  type StatementPreflight,
  type StatementRow,
  type StatementRowStatus,
} from '../shared/types';
import {
  assertStatementMime,
  countPdfPages,
  emptyStatementRow,
  extractStatementFromDocument,
  fetchSarvamJobRows,
  isSarvamTerminal,
  lowestConfidence,
  MAX_SARVAM_PAGES_PER_JOB,
  normalizeStatementRows,
  pollSarvamJobStatus,
  requireSarvamKey,
  runStatementPagesRound,
  selectProvider,
  selectStatementProvider,
  submitSarvamStatementJobs,
  toStatementEnvelopeRow,
  validateRoundPages,
  type CustomDeps,
  type SarvamDeps,
  type StatementRowFields,
  type StatementRun,
} from './ai';
import { extractionInFlight, readDocumentRow } from './extractions';
import { readEnabledRules } from './queries';
import { applyRules } from './rules';
import { readCustomApiKey, readSarvamApiKey, readSettings } from './settingsStore';
import {
  DEFAULT_ACCOUNT,
  existingFingerprints,
  insertTransactions,
  validateTxInput,
} from './transactions';
import { ApiFail, clip, isRecord } from './util';

const JOB_COLUMNS =
  'documentId, status, rowCount, truncated, provider, model, error, createdAt, updatedAt';
// providerState rides only the SELECTs: the INSERTs keep the original column
// list (a fresh row's providerState is NULL by default) and every non-NULL
// write goes through writeProviderState, so the resumable state has exactly
// one writer and the Anthropic persistence path stays byte-identical.
const JOB_SELECT_COLUMNS = `${JOB_COLUMNS}, providerState`;
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
  providerState: string | null;
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
// Resumable provider state (sprint 12)
//
// Real Sarvam latency for dense statements exceeds any honest in-request poll
// ceiling, and polling longer would blow the free plan's per-request
// subrequest cap. So a Sarvam read is split in two: one SUBMIT request that
// creates every batch job and returns 'pending' immediately, then small
// client-driven TICK requests (the UI re-POSTs /statement/extract while the
// job is pending) that each poll the outstanding jobs once, harvest rows from
// newly finished ones, and finalize through the ordinary persistence flow
// once every batch is terminal. The in-between state lives in
// statement_extractions.providerState as versioned, worker-internal JSON —
// non-NULL exactly while a resumable run is pending, NULL everywhere else.
// ---------------------------------------------------------------------------

interface ProviderStateJob {
  jobId: string;
  /** 'submitted' = still owed an answer. 'done' = completed, rows harvested.
   * 'failed' = this batch could not be fully read — a failed/rejected job
   * (no rows), or a partially_completed one (its readable rows ARE harvested,
   * and the failure still marks the whole run truncated). */
  status: 'submitted' | 'done' | 'failed';
  /** Raw rows exactly as Sarvam returned them — envelope mapping and
   * normalization happen once, at finalize. */
  rows?: unknown[];
}

export interface ProviderState {
  v: 1;
  jobs: ProviderStateJob[];
  batchCount: number;
  submittedAt: string;
}

const JOB_STATE_STATUSES = new Set(['submitted', 'done', 'failed']);

/**
 * The one reader of the providerState blob. Anything that does not parse to
 * the exact v1 shape is null — and a pending row whose state is null is
 * simply a legacy in-flight run, handled by the original 409 guard. Corrupt
 * state therefore degrades to the pre-sprint-12 behavior, never to a crash
 * and never to a guessed resume.
 */
export function parseProviderState(raw: string | null | undefined): ProviderState | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== 1) return null;
  // Pinned (sprint 16): a state carrying ANY `mode` marker is not a Sarvam
  // resumable run — today that means the browser-pages flow's
  // {mode:'client-pages'} claim, whose job the WORKER must never tick (there
  // are no provider jobs to poll; the user's browser is doing the work). The
  // field checks below would already reject it, but this rule is a contract,
  // not a coincidence of shapes.
  if (parsed.mode !== undefined) return null;
  if (!Array.isArray(parsed.jobs) || typeof parsed.submittedAt !== 'string') return null;
  if (typeof parsed.batchCount !== 'number' || !Number.isInteger(parsed.batchCount)) return null;
  if (parsed.batchCount < 1) return null;
  for (const job of parsed.jobs) {
    if (!isRecord(job)) return null;
    if (typeof job.jobId !== 'string' || job.jobId === '') return null;
    if (typeof job.status !== 'string' || !JOB_STATE_STATUSES.has(job.status)) return null;
    if (job.rows !== undefined && !Array.isArray(job.rows)) return null;
  }
  return parsed as unknown as ProviderState;
}

/**
 * The additive progress contract: {done, total} ONLY while a pending job
 * carries parseable resumable state — done counts batches the provider has
 * settled, total is what was submitted. Everything else (settled jobs,
 * blocking providers, legacy pending, corrupt state) is null, which the UI
 * also uses as "this pending job is not tick-driven".
 */
export function statementProgress(
  status: string,
  providerState: string | null | undefined,
): { done: number; total: number } | null {
  if (status !== 'pending') return null;
  const state = parseProviderState(providerState);
  if (!state) return null;
  return {
    done: state.jobs.filter((j) => j.status !== 'submitted').length,
    total: state.batchCount,
  };
}

/**
 * How long a resumable run may stay unfinished, measured from the state's own
 * submittedAt — NOT the job row's createdAt, which deliberately survives
 * re-runs (sprint 4) and would leave any re-run of an old statement born
 * expired.
 */
export const STATEMENT_RESUME_DEADLINE_MS = 20 * 60 * 1000;

export const STATEMENT_DEADLINE_MESSAGE =
  'Sarvam did not finish within 20 minutes. Try again — if it keeps happening, ' +
  'the document may be too complex for your Sarvam plan.';

const NO_ROWS_MESSAGE =
  'Sarvam could not read any transactions from this statement. ' +
  'Try again, or try a clearer copy.';

/** Result fetches per tick — with status polls for the outstanding jobs (≤10
 * jobs even for a 100-page statement) this keeps a tick far under the
 * free-plan ~50-subrequest cap; unharvested finished jobs simply wait for the
 * next tick. */
const TICK_MAX_RESULT_FETCHES = 2;

// ---------------------------------------------------------------------------
// Client-pages state (sprint 16)
//
// The browser-pages flow parks a DIFFERENT providerState shape while a
// browser is reading the statement: {v:1, mode:'client-pages', beganAt}.
// There is nothing in it to resume — no provider jobs, no rows — because the
// user's own browser holds the read in flight; the state exists so the claim
// is visible (a second read attempt 409s) and so parseProviderState can
// refuse it (the S12 tick path must never mistake a browser read for a
// Sarvam run). Rows a browser submits are SUGGESTIONS that pass the same
// never-guess normalization + review table as every provider — the
// manual-entry trust model — and the custom API key never leaves the worker.
// ---------------------------------------------------------------------------

interface ClientPagesState {
  v: 1;
  mode: 'client-pages';
  beganAt: string;
  /** Scopes round/finalize/abort to the begin that issued them. Live
   * incident 2026-08-13: a reloading tab's best-effort abort landed AFTER a
   * fresh begin in the new tab and killed the new run — a stale caller must
   * be a no-op, never a cancel. Optional only for states written before this
   * field existed (cross-deploy compat); absent means "match anything". */
  runId?: string;
}

/** The one reader of a client-pages blob; anything else is null. */
export function parseClientPagesState(raw: string | null | undefined): ClientPagesState | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== 1 || parsed.mode !== 'client-pages') return null;
  if (typeof parsed.beganAt !== 'string') return null;
  if (parsed.runId !== undefined && typeof parsed.runId !== 'string') return null;
  return parsed as unknown as ClientPagesState;
}

/** Optional runId off a request body — absent is fine (legacy clients). */
function readRunId(body: unknown): string | null {
  if (!isRecord(body)) return null;
  return typeof body.runId === 'string' && body.runId !== '' ? body.runId : null;
}

/** Whether a caller's runId is allowed to act on this state: both known and
 * different = a stale caller from a superseded run. */
function runIdMismatch(state: ClientPagesState, callerRunId: string | null): boolean {
  return typeof state.runId === 'string' && callerRunId !== null && state.runId !== callerRunId;
}

/** POST /statement/extract while a browser holds the claim — same words as
 * every other in-flight collision. */
export const CUSTOM_STATEMENT_BROWSER_FLOW =
  'This provider reads statements through the browser flow.';

export const CLIENT_ABORT_MESSAGE = 'The read was cancelled in the browser.';

const NO_CLIENT_READ_MESSAGE =
  'No browser read is in progress for this statement. Start the read again.';

const CLIENT_NO_ROWS_MESSAGE =
  'No transactions could be read from this statement. Try again, or try a clearer copy.';

/** The ONLY writer of a non-NULL providerState (and the explicit clear). The
 * Anthropic branch never calls it — pinned by tests. */
async function writeProviderState(
  db: D1Database,
  documentId: string,
  state: ProviderState | ClientPagesState | null,
  now: string,
): Promise<void> {
  await db
    .prepare('UPDATE statement_extractions SET providerState = ?, updatedAt = ? WHERE documentId = ?')
    .bind(state === null ? null : JSON.stringify(state), now, documentId)
    .run();
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
    // The raw providerState blob itself never leaves the worker.
    progress: statementProgress(row.status, row.providerState),
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
        `SELECT ${JOB_SELECT_COLUMNS} FROM statement_extractions WHERE documentId IN (${placeholders})`,
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
// Proposal enrichment (sprint 13, pure — exercised directly by tests)
// ---------------------------------------------------------------------------

/**
 * Proposals arrive organized, not raw: the merchant is the printed
 * descriptor's cleaned form (a deterministic TRANSFORM — see
 * shared/descriptors.ts), and a category the model left blank is filled from
 * the user's OWN rules through the one matching engine, applyRules — never a
 * fork of it (the sprint-5 anti-fork rule).
 *
 * Ordering contract: this runs on normalized rows BEFORE the fingerprint /
 * duplicate pass in persistStatementRun, so the duplicate pre-flag and the
 * eventual insert fingerprint agree on the cleaned merchant name.
 *
 * Field semantics:
 * - merchant: value is cleaned; confidence is UNCHANGED — the read confidence
 *   still describes the read, and the cleanup neither improves nor degrades
 *   what the model saw.
 * - category: a managed category the model grounded in the document is NEVER
 *   overwritten (spec §8.1.6 — rules fill, they don't overrule). Only a null
 *   or unmanaged value is offered to the rules, matched against the CLEANED
 *   merchant. A rule that fires sets {value, confidence: 1}: a rule the user
 *   wrote or accepted is deterministic user-authored knowledge, not model
 *   output — certainty 1, so it never trips the review screen's
 *   low-confidence markers. No rule → the field stays exactly as it was
 *   (the Needs-review fallback stays honest).
 */
export function enrichStatementRows(
  rows: StatementRowFields[],
  rules: Rule[],
  categories: readonly string[],
): StatementRowFields[] {
  const managed = new Set(categories.map((c) => c.trim().toLowerCase()));
  return rows.map((row) => {
    const merchant =
      row.merchant.value === null
        ? row.merchant
        : { value: cleanBankDescriptor(row.merchant.value), confidence: row.merchant.confidence };

    let category = row.category;
    const isManaged =
      category.value !== null && managed.has(category.value.trim().toLowerCase());
    if (!isManaged) {
      const ruled = applyRules(
        { merchant: merchant.value ?? '', category: NEEDS_REVIEW, tags: [] },
        rules,
      );
      if (ruled.category !== NEEDS_REVIEW) {
        category = { value: ruled.category, confidence: 1 };
      }
    }

    return { ...row, merchant, category };
  });
}

// ---------------------------------------------------------------------------
// Preflight (sprint 10) — what a run would involve, before anything is spent
// ---------------------------------------------------------------------------

/**
 * The preflight numbers, kept pure so the math is directly testable. Batches:
 * Sarvam runs one job per 10 pages (its documented per-job ceiling); a custom
 * endpoint reads browser-extracted pages in rounds of 8 (sprint 16);
 * Anthropic reads the whole PDF in one request. estimatedCost is the user's
 * own saved per-page rate × pages, rounded to 2dp — and null whenever no rate
 * is saved or the provider does not bill per page (Anthropic bills per token;
 * a custom endpoint's pricing is whatever the user's endpoint charges, which
 * Ledgerly cannot honestly number), because a guessed price is worse than no
 * price.
 */
export function buildStatementPreflight(
  pages: number,
  provider: AiProvider,
  pricePerPage: number | null,
): StatementPreflight {
  const batches =
    provider === 'sarvam'
      ? Math.ceil(pages / MAX_SARVAM_PAGES_PER_JOB)
      : provider === 'custom'
        ? Math.ceil(pages / CLIENT_STATEMENT_PAGES_PER_ROUND)
        : 1;
  const estimatedCost =
    provider === 'sarvam' && pricePerPage !== null
      ? Math.round(pages * pricePerPage * 100) / 100
      : null;
  return { pages, batches, provider, estimatedCost };
}

/**
 * GET /api/documents/:id/statement/preflight — free and side-effect-free: no
 * claim, no model call, nothing written. Runs the SAME configuration gates as
 * the extract endpoint, so a preflight that answers cannot precede an extract
 * that would 400.
 */
export async function statementPreflight(
  env: Env,
  documentId: string,
): Promise<StatementPreflight> {
  const doc = await readDocumentRow(env.DB, documentId);
  const settings = await readSettings(env.DB);

  const { provider } = selectStatementProvider(settings);
  assertStatementMime(doc.mimeType);
  if (doc.size > MAX_FILE_BYTES) {
    throw new ApiFail(413, 'That file is too large to send for extraction.');
  }

  const object = await env.BUCKET.get(doc.objectKey);
  if (!object) throw new ApiFail(404, 'The stored copy of that file is no longer available.');

  // The sprint-11 measured count answers without parsing the PDF again (the
  // R2 existence check above still runs — a preflight must not promise a read
  // of a file that is gone). Only unknown counts (pre-migration rows, or a
  // PDF the upload path could not read) fall back to counting here.
  let pages: number;
  if (typeof doc.pageCount === 'number' && Number.isInteger(doc.pageCount) && doc.pageCount > 0) {
    pages = doc.pageCount;
  } else {
    try {
      pages = await countPdfPages(await object.arrayBuffer());
    } catch (err) {
      // pdfSplit's messages (unreadable / password-protected) are already the
      // user-facing words; here the user has spent nothing, so it is a 400.
      throw new ApiFail(400, err instanceof Error ? err.message : 'This PDF could not be read.');
    }
  }

  return buildStatementPreflight(pages, provider, settings.sarvamPricePerPage);
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
          // providerState = NULL: a fresh claim starts a fresh run, so
          // resumable state left by an earlier run (a failed submit's audit
          // record, or a blob that would not parse) must never leak into it —
          // otherwise the next POST would "tick" jobs this run never created.
          `UPDATE statement_extractions
           SET status = 'pending', provider = ?, model = ?, error = NULL,
               providerState = NULL, updatedAt = ?
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
    .prepare(`SELECT ${JOB_SELECT_COLUMNS} FROM statement_extractions WHERE documentId = ?`)
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

/**
 * Sanity bound for the RAW rows a single run may hand normalizeStatementRows
 * — not the proposal cap (MAX_STATEMENT_ROWS, applied below). Kept far above
 * any real statement so it only guards against a genuinely malformed
 * response, never against a normal read: the actual cap has to run AFTER
 * confirmed-row exclusion (see persistStatementRun) or a statement over 300
 * rows can never advance past its first page.
 */
const STATEMENT_RAW_ROWS_BOUND = 5000;

/**
 * The one persistence flow every completed read goes through, whichever
 * provider produced the rows and however many requests it took: normalize,
 * enrich (clean merchants + rule-filled categories, sprint 13), hide rows the
 * user already imported, cap at MAX_STATEMENT_ROWS, pre-flag duplicates,
 * replace the untriaged proposals, save the job as suggested/partial.
 * Extracted verbatim from the original single-request path (sprint 12) so
 * the resumable finalize step reuses it rather than forking it.
 *
 * Cap ordering, pinned (sprint 18 regression): the cap MUST run after
 * confirmed-row exclusion, not before. Capping the raw rows first meant a
 * >300-row statement could never finish: run 1 proposes rows 1–300, the user
 * imports them, run 2 re-normalizes the SAME statement, caps to the SAME
 * first 300 rows again, excludes every one of them as already-confirmed, and
 * proposes zero — a statement with 301+ transactions was stuck forever. The
 * raw normalize below uses a generous sanity bound instead of the real cap;
 * the real cap is applied to `outstanding`, the list that is left once rows
 * the user already imported are excluded.
 */
async function persistStatementRun(
  env: Env,
  documentId: string,
  settings: Settings,
  run: StatementRun,
  provider: string,
  model: string,
  now: string,
): Promise<StatementExtraction> {
  // `rawCapped` fires only when the RAW response blew past the 5000-row
  // sanity bound — a real signal, not a hypothetical: a run that big is
  // almost certainly malformed, and silently dropping the tail without
  // marking the result truncated would be exactly the kind of quiet loss
  // this pipeline exists to refuse.
  const { rows: normalized, capped: rawCapped } = normalizeStatementRows(
    run.rows,
    settings.categories,
    STATEMENT_RAW_ROWS_BOUND,
  );
  // Enrichment runs BEFORE anything fingerprints: the confirmed-row hiding,
  // the duplicate pre-flags and the eventual insert all see the same cleaned
  // merchant name.
  const fields = enrichStatementRows(
    normalized,
    await readEnabledRules(env.DB),
    settings.categories,
  );
  const account = defaultStatementAccount(settings.accounts);

  // Rows the user already imported keep their place and are not offered
  // again, so re-running after importing half a statement shows the half
  // that is still outstanding — not the whole thing over. This MUST run
  // before the MAX_STATEMENT_ROWS cap below — see the doc comment above.
  const confirmed = await readConfirmedRows(env.DB, documentId);
  const alreadyImported = new Set(
    confirmed
      .map((r) => statementRowFingerprint(parseRowFields(r.fields), account))
      .filter((fp): fp is string => fp !== null),
  );

  const outstanding = fields.filter((f) => {
    const fp = statementRowFingerprint(f, account);
    return fp === null || !alreadyImported.has(fp);
  });

  // NOW the real cap — applied to what is actually left to propose, not to
  // the raw response. `capped` is this run's `truncated` signal.
  const capped = outstanding.length > MAX_STATEMENT_ROWS;
  const fresh = capped ? outstanding.slice(0, MAX_STATEMENT_ROWS) : outstanding;

  const existing = await existingFingerprints(
    env.DB,
    fresh
      .map((f) => statementRowFingerprint(f, account))
      .filter((fp): fp is string => fp !== null),
  );
  // Duplicate flags are per-proposed-row, so they're computed on the capped
  // list — a row dropped at the cap is not proposed and needs no flag.
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

  const truncated = run.truncated || rawCapped || capped;
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
}

/** Store an attempted-and-failed run, readably (never a raw provider body). */
async function saveFailedJob(
  env: Env,
  documentId: string,
  provider: string,
  model: string,
  message: string,
  now: string,
): Promise<StatementExtraction> {
  await saveJob(env.DB, {
    documentId,
    status: 'failed',
    rowCount: 0,
    truncated: false,
    provider,
    model,
    error: clip(message),
    now,
  });
  return await readJob(env.DB, documentId);
}

/**
 * The Sarvam SUBMIT step — runs under a fresh claim. Creates every batch job
 * without polling any of them, parks the job ids in providerState, and leaves
 * the row 'pending' for the ticks to advance. If a create call fails partway,
 * the jobs that DO exist are still recorded (they were created at Sarvam and
 * paid for — an audit trail, not a live run) but the whole run is failed
 * readably: with the run failed, no tick will ever poll them, so a
 * half-submitted read can never turn into orphan polling.
 */
async function submitSarvamStatement(
  env: Env,
  documentId: string,
  provider: string,
  model: string,
  settings: Settings,
  bytes: ArrayBuffer,
  now: string,
  deps: SarvamDeps,
): Promise<StatementExtraction> {
  let apiKey: string;
  try {
    apiKey = await requireSarvamKey(env);
  } catch (err) {
    return saveFailedJob(
      env,
      documentId,
      provider,
      model,
      err instanceof Error ? err.message : 'Statement extraction failed.',
      now,
    );
  }

  const submit = await submitSarvamStatementJobs(apiKey, bytes, settings.categories, deps);
  const state: ProviderState = {
    v: 1,
    jobs: submit.jobIds.map((jobId) => ({ jobId, status: 'submitted' as const })),
    batchCount: submit.batchCount,
    submittedAt: now,
  };

  if (submit.failure) {
    const failed = await saveFailedJob(env, documentId, provider, model, submit.failure.message, now);
    if (submit.jobIds.length > 0) {
      await writeProviderState(env.DB, documentId, state, now);
    }
    return failed;
  }

  await writeProviderState(env.DB, documentId, state, now);
  // Still 'pending' (the claim set it); progress now reads {0, batchCount}.
  return await readJob(env.DB, documentId);
}

/**
 * One TICK: poll each outstanding job once, harvest rows from the ones that
 * finished (at most TICK_MAX_RESULT_FETCHES result fetches per tick), persist
 * the updated state, and finalize through persistStatementRun once every
 * batch is terminal. Provider trouble mid-tick (network, 429, a revoked key)
 * is swallowed: whatever this tick learned is kept and the next tick simply
 * tries again — poll semantics, bounded by the overall deadline below, never
 * by a wall-clock wait inside the request.
 */
async function runStatementTick(
  env: Env,
  settings: Settings,
  current: JobRow,
  state: ProviderState,
  now: string,
  deps: SarvamDeps,
): Promise<StatementExtraction> {
  const documentId = current.documentId;

  if (state.jobs.some((j) => j.status === 'submitted')) {
    // The 20-minute deadline is judged AFTER the harvest attempt below, and
    // only when a tick makes zero forward progress: a tick that arrives late
    // (interrupted client, closed tab) must first rescue batches that Sarvam
    // already finished — those pages are read and paid for. Live incident
    // 2026-08-13: deadline-before-harvest discarded an hour-old run whose
    // three batches were almost certainly complete.
    let progressed = false;

    // A key removed mid-run makes this tick a no-op rather than a failure:
    // the jobs still exist at Sarvam and were paid for, so the run stays
    // resumable in case the key comes back — the deadline above bounds how
    // long that grace lasts, and the Settings banner already says the key is
    // missing.
    const apiKey = await readSarvamApiKey(env.DB);
    if (apiKey) {
      let harvests = 0;
      try {
        for (const job of state.jobs) {
          if (job.status !== 'submitted') continue;
          const status = await pollSarvamJobStatus(apiKey, job.jobId, deps);
          if (!isSarvamTerminal(status)) continue;
          if (status === 'failed' || status === 'rejected') {
            job.status = 'failed';
            progressed = true;
            continue;
          }
          // completed / partially_completed both have readable results.
          if (harvests >= TICK_MAX_RESULT_FETCHES) continue; // next tick's work
          job.rows = await fetchSarvamJobRows(apiKey, job.jobId, deps);
          job.status = status === 'completed' ? 'done' : 'failed';
          progressed = true;
          harvests++;
        }
      } catch {
        // Transient by decree: keep what this tick learned, retry next tick.
        // The messages fetchJson throws are already stripped of provider
        // bodies, and nothing here is logged.
      }
    }

    await writeProviderState(env.DB, documentId, state, now);
    if (state.jobs.some((j) => j.status === 'submitted')) {
      // Anchored on submittedAt (createdAt survives re-runs — an S4 pin —
      // so anchoring there would make re-runs of old statements born
      // expired). A tick that advanced anything skips the verdict: progress
      // means Sarvam is still delivering, however late we are.
      const submitted = Date.parse(state.submittedAt);
      const anchor = Number.isNaN(submitted) ? Date.parse(current.createdAt) : submitted;
      if (!progressed && Date.parse(now) - anchor > STATEMENT_RESUME_DEADLINE_MS) {
        await writeProviderState(env.DB, documentId, null, now);
        return await saveFailedJob(
          env,
          documentId,
          current.provider,
          current.model,
          STATEMENT_DEADLINE_MESSAGE,
          now,
        );
      }
      return await readJob(env.DB, documentId);
    }
  }

  // FINALIZE — every batch is terminal. Raw rows concatenate in batch (page)
  // order, get the envelope shape, and ride the ordinary persistence flow.
  // Any failed batch (including a partially completed one) marks the run
  // truncated: rows may be missing and the UI must say so.
  const rawRows: unknown[] = [];
  for (const job of state.jobs) {
    for (const raw of job.rows ?? []) rawRows.push(raw);
  }
  const anyFailed = state.jobs.some((j) => j.status === 'failed');

  // Clearing state first makes a crash mid-finalize land in the legacy
  // 'pending without state' shape, which the existing in-flight window
  // already knows how to reclaim — never in a half-finalized resumable run.
  await writeProviderState(env.DB, documentId, null, now);

  if (rawRows.length === 0) {
    // Nothing readable came back from any batch (all failed, or every
    // completed batch was empty) — an honest failure, not "0 proposed".
    return await saveFailedJob(
      env,
      documentId,
      current.provider,
      current.model,
      NO_ROWS_MESSAGE,
      now,
    );
  }

  try {
    return await persistStatementRun(
      env,
      documentId,
      settings,
      { rows: rawRows.map(toStatementEnvelopeRow), truncated: anyFailed },
      current.provider,
      current.model,
      now,
    );
  } catch (err) {
    if (err instanceof ApiFail) throw err;
    return await saveFailedJob(
      env,
      documentId,
      current.provider,
      current.model,
      err instanceof Error ? err.message : 'Statement extraction failed.',
      now,
    );
  }
}

/**
 * POST /api/documents/:id/statement/extract
 *
 * Three shapes share this endpoint: a fresh run (claim → read → persist), the
 * Sarvam SUBMIT (claim → create batch jobs → return pending), and a TICK on a
 * pending resumable run (no claim — the tick IS the run making progress).
 * `deps` is a test seam threaded to the Sarvam client; production callers
 * pass nothing.
 */
export async function runStatementExtraction(
  env: Env,
  documentId: string,
  deps: SarvamDeps = {},
): Promise<StatementExtraction> {
  const doc = await readDocumentRow(env.DB, documentId);
  const settings = await readSettings(env.DB);
  const now = new Date().toISOString();

  // A pending job carrying parseable resumable state makes this POST a tick,
  // not a new run — checked before the configuration gates so a paid,
  // in-flight read can still finish after the user changes provider settings
  // mid-run. State that fails to parse is legacy pending: fall through to the
  // claim, whose original 409/in-flight semantics apply unchanged (and whose
  // claim clears the unparseable blob when the window lapses).
  const current = await env.DB
    .prepare(`SELECT ${JOB_SELECT_COLUMNS} FROM statement_extractions WHERE documentId = ?`)
    .bind(documentId)
    .first<JobRow>();
  if (current && current.status === 'pending' && current.providerState !== null) {
    const state = parseProviderState(current.providerState);
    if (state) return runStatementTick(env, settings, current, state, now, deps);
    // A browser-pages claim (sprint 16) is NOT tickable — the user's browser
    // holds the read, and the worker has nothing to advance. Inside the
    // in-flight window this POST is a collision and 409s (pinned); once the
    // window lapses the claim below reclaims, exactly like legacy pending.
    if (
      parseClientPagesState(current.providerState) &&
      extractionInFlight(current.status, current.updatedAt, now)
    ) {
      throw new ApiFail(409, IN_FLIGHT_MESSAGE);
    }
  }

  // Configuration problems are the user's to fix, so they are 400s and leave
  // no row behind; only an attempted-and-failed run is stored as `failed`.
  const { provider, model } = selectStatementProvider(settings);
  // A fresh custom-provider run never starts here: statements on the custom
  // endpoint are read via begin/round/finalize (the browser extracts the
  // pages — this worker cannot rasterize a PDF). The UI never calls this
  // route for custom; the 400 is for anyone driving the API directly.
  if (provider === 'custom') throw new ApiFail(400, CUSTOM_STATEMENT_BROWSER_FLOW);
  assertStatementMime(doc.mimeType);
  if (doc.size > MAX_FILE_BYTES) {
    throw new ApiFail(413, 'That file is too large to send for extraction.');
  }

  // Claim before touching R2 or the model — everything above is configuration,
  // everything below is the run itself.
  await claimStatement(env.DB, documentId, provider, model, now);

  const object = await env.BUCKET.get(doc.objectKey);
  if (!object) throw new ApiFail(404, 'The stored copy of that file is no longer available.');
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new ApiFail(413, 'That file is too large to send for extraction.');
  }

  if (provider === 'sarvam') {
    return submitSarvamStatement(env, documentId, provider, model, settings, bytes, now, deps);
  }

  try {
    const run = await extractStatementFromDocument(env, settings, doc, bytes);
    return await persistStatementRun(env, documentId, settings, run, provider, model, now);
  } catch (err) {
    if (err instanceof ApiFail) throw err;
    return await saveFailedJob(
      env,
      documentId,
      provider,
      model,
      err instanceof Error ? err.message : 'Statement extraction failed.',
      now,
    );
  }
}

// ---------------------------------------------------------------------------
// The browser-pages flow (sprint 16): begin → round × N → finalize (or abort).
//
// The custom provider cannot read a PDF (worker/ai/providers.ts) and a Worker
// cannot rasterize one, so the user's own browser does the page work — text
// layer where the PDF has one, a rendered image where it doesn't — and posts
// pages in rounds of ≤8. The worker owns everything else: the config gates,
// the claim, the model calls (the custom key NEVER reaches the client), and
// the one persistence pipeline every provider's rows go through at finalize.
// ---------------------------------------------------------------------------

/** Optional packId off a request body — absent (or non-string) means the
 * plain AI-rounds begin. */
function readPackId(body: unknown): string | null {
  if (!isRecord(body)) return null;
  return typeof body.packId === 'string' ? body.packId : null;
}

export const UNKNOWN_PACK_MESSAGE =
  'No community pack with that id ships in this build. Reload the tab, then try again.';

/**
 * POST /api/documents/:id/statement/pages/begin — two shapes.
 *
 * A packId claims a COMMUNITY PACK read (sprint 18): the browser already
 * parsed and chain-verified the statement locally against a bundled pack, so
 * this claim needs NO provider configured at all — the provider gate is
 * skipped entirely and the job records provider 'pack' with the pack id as
 * its model. An unknown packId is a readable 400 (almost certainly a stale
 * bundle — the copy points at the cure), never a guess.
 *
 * No packId is the sprint-16 AI-rounds begin, byte-for-byte: the statement
 * gates for provider 'custom' (URL + model required), same claim.
 *
 * Either way: PDF mime is required, and the claim/runId/providerState
 * mechanics are shared — a colliding read 409s and the S12 tick path knows
 * to keep its hands off.
 */
export async function beginClientStatement(
  env: Env,
  documentId: string,
  body: unknown = null,
): Promise<{ ok: true; runId: string }> {
  const doc = await readDocumentRow(env.DB, documentId);
  const now = new Date().toISOString();

  const packId = readPackId(body);
  let provider: string;
  let model: string;

  // Read once, ahead of the branch: a pack claim needs it too (bundled +
  // this user's own local packs, sprint 19 — one detection space, one
  // lookup) so the settings read moved here instead of living only in the
  // AI-rounds branch below.
  const settings = await readSettings(env.DB);

  if (packId !== null) {
    const pack = anyStatementPackById(settings.localStatementPacks, packId);
    if (!pack) throw new ApiFail(400, UNKNOWN_PACK_MESSAGE);
    // A pack read needs NO AI provider — that is the point.
    provider = 'pack';
    model = pack.id;
  } else {
    ({ provider, model } = selectStatementProvider(settings));
    if (provider !== 'custom') {
      // Anthropic/Sarvam read the PDF themselves — their door is /extract.
      throw new ApiFail(400, 'This provider reads statements directly — use Read as statement.');
    }
  }
  assertStatementMime(doc.mimeType);

  await claimStatement(env.DB, documentId, provider, model, now);
  const runId = crypto.randomUUID();
  await writeProviderState(
    env.DB,
    documentId,
    { v: 1, mode: 'client-pages', beganAt: now, runId },
    now,
  );
  return { ok: true, runId };
}

/** The pending client-pages claim, or the readable 409 for anything else —
 * including a caller whose runId belongs to a superseded run. */
async function requireClientClaim(
  db: D1Database,
  documentId: string,
  callerRunId: string | null = null,
): Promise<{ job: JobRow; state: ClientPagesState }> {
  const current = await db
    .prepare(`SELECT ${JOB_SELECT_COLUMNS} FROM statement_extractions WHERE documentId = ?`)
    .bind(documentId)
    .first<JobRow>();
  const state = current ? parseClientPagesState(current.providerState) : null;
  if (!current || current.status !== 'pending' || !state) {
    throw new ApiFail(409, NO_CLIENT_READ_MESSAGE);
  }
  if (runIdMismatch(state, callerRunId)) {
    throw new ApiFail(409, NO_CLIENT_READ_MESSAGE);
  }
  return { job: current, state };
}

/**
 * POST /api/documents/:id/statement/pages/round — ≤8 browser-extracted pages
 * in, raw rows out. Text pages become ONE text-model call, image pages ONE
 * vision call. NOTHING is persisted (finalize owns that); the only write is a
 * re-stamp of the claim so an actively-read statement stays visibly in
 * flight. Model and config failures are readable 400s and the round is
 * retryable client-side — a retry can never double rows because rows only
 * exist in the response.
 */
export async function clientStatementRound(
  env: Env,
  documentId: string,
  body: unknown,
  deps: CustomDeps = {},
): Promise<StatementPagesRoundResult> {
  await readDocumentRow(env.DB, documentId);
  const { job, state } = await requireClientClaim(env.DB, documentId, readRunId(body));
  // A round is the custom-provider machinery specifically — a pack claim
  // (provider 'pack', sprint 18) holds the SAME client-pages providerState
  // shape (it needs the claim-visibility mechanics too) but has no rounds,
  // no model, no key: a stray round against one must never fire a real AI
  // call. Same readable 409 as no-claim-at-all — the caller has nothing to
  // retry differently.
  if (job.provider !== 'custom') {
    throw new ApiFail(409, NO_CLIENT_READ_MESSAGE);
  }
  const pages = validateRoundPages(body);

  const settings = await readSettings(env.DB);
  // The custom config gates verbatim (URL + model, same messages), whatever
  // aiProvider currently says: the claim was taken as 'custom', and a mid-run
  // provider switch must not strand a read whose config still exists — the
  // S12 "a paid run still finishes" ruling, applied to the user's own time.
  const { model } = selectProvider({ ...settings, aiProvider: 'custom' });
  const apiKey = await readCustomApiKey(env.DB);

  // Keep the claim visibly alive while rounds arrive — a slow free-tier read
  // must not look abandoned to a colliding begin/extract.
  await writeProviderState(env.DB, documentId, state, new Date().toISOString());

  try {
    return await runStatementPagesRound(
      { baseUrl: settings.customBaseUrl, apiKey, model },
      pages,
      settings.categories,
      // Statement rounds get a patient budget: free hosted endpoints
      // (2026-08-13 incident) took >90s on dense pages and every round timed
      // out at the receipt-sized ceiling. The Worker just awaits I/O; the
      // browser client owns retry pacing. Receipts keep the short fuse.
      { timeoutMs: 240_000, ...deps },
    );
  } catch (err) {
    if (err instanceof ApiFail) throw err;
    // runCustomChat's taxonomy is already user-facing words with the
    // provider body dropped; 400 keeps the round retryable client-side.
    throw new ApiFail(
      400,
      err instanceof Error ? clip(err.message) : 'Your custom endpoint could not read these pages.',
    );
  }
}

/**
 * POST /api/documents/:id/statement/pages/finalize — {rows, truncated} in,
 * the settled job out, through the EXISTING pipeline exactly: normalize cap →
 * enrichment (cleaned merchants + rule-filled categories) → confirmed-
 * fingerprint exclusion → duplicate pre-flag → persistStatementRun semantics
 * (suggested/partial per truncated‖capped, zero readable rows → failed). The
 * rows arrive from the user's own browser and get exactly as much trust as
 * any model's output — none.
 */
export async function finalizeClientStatement(
  env: Env,
  documentId: string,
  body: unknown,
): Promise<StatementExtraction> {
  await readDocumentRow(env.DB, documentId);
  const { job: current } = await requireClientClaim(env.DB, documentId, readRunId(body));

  if (!isRecord(body) || !Array.isArray(body.rows)) {
    throw new ApiFail(400, 'Send the rows this read produced.');
  }
  if (typeof body.truncated !== 'boolean') {
    throw new ApiFail(400, 'Say whether the read was truncated (true or false).');
  }
  const rows = body.rows;
  const truncated = body.truncated;

  const settings = await readSettings(env.DB);
  const now = new Date().toISOString();

  // Clearing state first makes a crash mid-finalize land in the legacy
  // 'pending without state' shape, which the existing in-flight window
  // already knows how to reclaim (the tick finalize's exact discipline).
  await writeProviderState(env.DB, documentId, null, now);

  if (rows.length === 0) {
    // Every round failed, or every page was unreadable — an honest failure,
    // never "0 proposed". The client may attach a structural diagnosis (our
    // own taxonomy strings / finish_reason tokens, single line, clipped) so
    // an all-empty read finally says WHY (live incident 2026-08-13).
    const diagnostic =
      isRecord(body) && typeof body.diagnostic === 'string' && body.diagnostic.trim() !== ''
        ? clip(body.diagnostic.replace(/\s+/g, ' ').trim())
        : null;
    return await saveFailedJob(
      env,
      documentId,
      current.provider,
      current.model,
      diagnostic ? `${CLIENT_NO_ROWS_MESSAGE} (${diagnostic})` : CLIENT_NO_ROWS_MESSAGE,
      now,
    );
  }

  try {
    return await persistStatementRun(
      env,
      documentId,
      settings,
      { rows, truncated },
      current.provider,
      current.model,
      now,
    );
  } catch (err) {
    if (err instanceof ApiFail) throw err;
    return await saveFailedJob(
      env,
      documentId,
      current.provider,
      current.model,
      err instanceof Error ? err.message : 'Statement extraction failed.',
      now,
    );
  }
}

/**
 * POST /api/documents/:id/statement/pages/abort — best-effort and idempotent:
 * a pending browser read settles to 'failed' with the pinned cancellation
 * message and its claim cleared; anything else (no job, a settled job, a
 * Sarvam resumable run) is left exactly alone.
 */
export async function abortClientStatement(
  env: Env,
  documentId: string,
  body: unknown = null,
): Promise<{ ok: true }> {
  await readDocumentRow(env.DB, documentId);
  const current = await env.DB
    .prepare(`SELECT ${JOB_SELECT_COLUMNS} FROM statement_extractions WHERE documentId = ?`)
    .bind(documentId)
    .first<JobRow>();
  const state = current ? parseClientPagesState(current.providerState) : null;
  if (!current || current.status !== 'pending' || !state) {
    return { ok: true };
  }
  // A stale tab's late abort (it reloaded mid-read; a NEWER begin owns the
  // claim now) must not cancel the newer run: mismatched runId no-ops.
  if (runIdMismatch(state, readRunId(body))) {
    return { ok: true };
  }
  const now = new Date().toISOString();
  await writeProviderState(env.DB, documentId, null, now);
  await saveFailedJob(env, documentId, current.provider, current.model, CLIENT_ABORT_MESSAGE, now);
  return { ok: true };
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
