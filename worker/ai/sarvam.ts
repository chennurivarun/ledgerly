// Sarvam Doc AI provider — BYOK document extraction built for Indian
// documents (22 Indic languages + English). The user's own subscription key,
// held server-side and never echoed; document bytes go to Sarvam under that
// key, which is the trade the user opts into by choosing this provider.
//
// API shape (verified against docs.sarvam.ai, 2026-08-13):
//   POST /doc-ai/v1/job/extract        multipart `file` + `schema` (JSON *string*)
//   GET  /doc-ai/v1/job/{id}/status    pending → running → terminal
//   GET  /doc-ai/v1/job/{id}/results   { result: {...} }
//   auth header `api-subscription-key`; terminals: completed,
//   partially_completed, failed, rejected; limits: 10 pages per PDF per job,
//   200 MB, 10 requests/minute account-wide.
//
// Statements longer than 10 pages are split into 10-page jobs
// (worker/ai/pdfSplit.ts). Since sprint 12 the statement flow is resumable:
// this module only CREATES the jobs (submitSarvamStatementJobs) and exposes
// one-shot status/results calls (pollSarvamJobStatus / fetchSarvamJobRows) —
// worker/statements.ts drives them across client ticks, so no request ever
// polls a dense statement to completion (real Sarvam latency exceeded any
// honest in-request ceiling, and longer polling would blow the free plan's
// per-request subrequest cap). Receipts are small single jobs and keep the
// original in-request create→poll→results loop. Everything returned here is
// still raw model output — worker/ai/normalize re-checks every field before
// any of it reaches D1 (VISION.md principle 2).
import { isRecord } from '../util';
import { splitPdfIntoBatches } from './pdfSplit';

/** Sarvam's documented per-job page ceiling — the batch size pdfSplit uses. */
export const MAX_SARVAM_PAGES_PER_JOB = 10;

/**
 * Sarvam Doc AI returns plain extracted values with NO per-field confidence.
 * Present fields are mapped to this fixed mid confidence and missing ones to
 * null/0, so the review screen's Verify markers stay honest: a
 * deterministic-extractor field is neither "unread" (0) nor "certain" (a fake
 * 1.0) — it is a machine read the user should still be able to spot-check.
 * Pinned by tests/sarvam.test.ts; change both together.
 */
export const SARVAM_FIELD_CONFIDENCE = 0.7;

const SARVAM_JOB_BASE = 'https://api.sarvam.ai/doc-ai/v1/job';

/** Poll cadence per job: every 2s, give up after 90s of waiting. */
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 90000;

/**
 * Injectable seams so tests run the whole batch pipeline with zero network
 * and zero real waiting. Production callers pass nothing.
 */
export interface SarvamDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

interface ResolvedDeps {
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  pollIntervalMs: number;
  pollTimeoutMs: number;
}

function resolveDeps(deps: SarvamDeps): ResolvedDeps {
  return {
    // Wrapped, not aliased: calling the global `fetch` through a property
    // reference rebinds `this` and workerd throws "Illegal invocation".
    fetchImpl: deps.fetchImpl ?? ((input, init) => fetch(input, init)),
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    pollIntervalMs: deps.pollIntervalMs ?? POLL_INTERVAL_MS,
    pollTimeoutMs: deps.pollTimeoutMs ?? POLL_TIMEOUT_MS,
  };
}

// ---------------------------------------------------------------------------
// Error taxonomy — the anthropic.ts contract: something a user can act on,
// with the original message deliberately dropped. Sarvam error bodies can
// echo request fragments, and an auth failure's body is the last place we
// want near a log line or a stored extraction row (spec §20).
// ---------------------------------------------------------------------------

function readableHttpError(status: number): Error {
  if (status === 401 || status === 403) {
    return new Error('Sarvam rejected the API key. Check the key saved in Settings.');
  }
  if (status === 429) {
    return new Error(
      'Sarvam rate limited this request (the account allows 10 per minute). Try again in a minute.',
    );
  }
  if (status === 400 || status === 413 || status === 422) {
    return new Error('Sarvam could not accept this document. Check the file and try again.');
  }
  return new Error('Sarvam could not process this document. Try again.');
}

const UNREADABLE_RESPONSE = 'Sarvam returned a response that could not be read.';
const CONNECTION_ERROR = 'Could not reach Sarvam. Check the connection and try again.';

// ---------------------------------------------------------------------------
// Schemas — Sarvam's dialect, not raw JSON Schema: root `object` with a
// non-empty `properties` map, every field carries a `type` and a non-empty
// `description`, optional `enum`, maximum nesting depth 4. The field NAMES
// mirror the Anthropic schemas exactly (worker/ai/prompt.ts) so both
// providers' output flows through the same normalize pipeline unchanged.
// The never-guess instructions live in the descriptions — Sarvam has no
// system prompt, so the schema is the prompt.
// ---------------------------------------------------------------------------

function categoryDescription(categories: readonly string[]): string {
  const list = categories.length > 0 ? categories.join(', ') : '(none configured)';
  return `The single best fitting category from this exact list, or leave it out when none fits. Never invent a category. List: ${list}`;
}

/**
 * Statement rows. Depth: object → rows (array) → items (object) → leaf
 * fields = 4, exactly at Sarvam's nesting ceiling.
 */
export function sarvamStatementSchema(categories: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      rows: {
        type: 'array',
        description:
          'Every transaction row printed on the statement, one entry per row, in printed order. ' +
          'Skip lines that are not transactions: opening/closing/running balances, subtotals, ' +
          'interest and fee summaries, minimum-payment boxes, headers, footers and page numbers.',
        items: {
          type: 'object',
          description: 'One dated movement of money exactly as printed.',
          properties: {
            date: {
              type: 'string',
              description:
                'The transaction date as printed, formatted YYYY-MM-DD. Statements often print the year once in a header — use it. If the year is genuinely not printed anywhere, leave the field out rather than assuming one.',
            },
            merchant: {
              type: 'string',
              description:
                'The payee or description as printed, without reference numbers or card digits where they are clearly separate. Not the bank, not the account holder.',
            },
            amount: {
              type: 'number',
              description: 'The amount as a positive number, no currency symbol, no minus sign.',
            },
            type: {
              type: 'string',
              enum: ['expense', 'income'],
              description:
                'Follow the statement\'s own debit/credit convention: a debit, withdrawal, purchase or charge is "expense"; a credit, deposit, refund or payment received is "income". Leave it out if the direction is not clear.',
            },
            category: { type: 'string', description: categoryDescription(categories) },
          },
        },
      },
    },
  };
}

/** Single receipt/invoice — the receipt pipeline's five fields (depth 2). */
export function sarvamReceiptSchema(categories: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      merchant: {
        type: 'string',
        description: 'The seller or payee name as printed. Not the cardholder, not the bank.',
      },
      date: {
        type: 'string',
        description:
          'The transaction date, formatted YYYY-MM-DD. If the year is not printed anywhere, leave the field out rather than assuming the current year.',
      },
      total: {
        type: 'number',
        description:
          'The final amount actually paid, as a positive number with no currency symbol and no minus sign. Not the subtotal, not the tax line, not cash tendered or change due.',
      },
      type: {
        type: 'string',
        enum: ['expense', 'income'],
        description:
          '"expense" for an ordinary purchase; "income" only when the document is clearly a refund, credit note, or money received.',
      },
      category: { type: 'string', description: categoryDescription(categories) },
    },
  };
}

// ---------------------------------------------------------------------------
// Envelope adaptation — Sarvam's plain values into the `{value, confidence}`
// shape the normalize pipeline validates. Output here is still UNTRUSTED:
// normalize re-checks every value, so a present-but-invalid field (a date the
// extractor mangled) still ends at null/0, and Sarvam output gets exactly as
// much trust as any model's — none.
// ---------------------------------------------------------------------------

function envelopeField(value: unknown): { value: unknown; confidence: number } {
  const missing =
    value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
  return missing
    ? { value: null, confidence: 0 }
    : { value, confidence: SARVAM_FIELD_CONFIDENCE };
}

/** One statement row in the STATEMENT_SCHEMA envelope shape. */
export function toStatementEnvelopeRow(raw: unknown): Record<string, unknown> {
  const row = isRecord(raw) ? raw : {};
  return {
    date: envelopeField(row.date),
    merchant: envelopeField(row.merchant),
    amount: envelopeField(row.amount),
    type: envelopeField(row.type),
    category: envelopeField(row.category),
  };
}

/** A receipt answer in the EXTRACTION_SCHEMA envelope shape. */
export function toReceiptEnvelope(raw: unknown): Record<string, unknown> {
  const rec = isRecord(raw) ? raw : {};
  return {
    merchant: envelopeField(rec.merchant),
    date: envelopeField(rec.date),
    total: envelopeField(rec.total),
    type: envelopeField(rec.type),
    category: envelopeField(rec.category),
  };
}

// ---------------------------------------------------------------------------
// The job lifecycle: create → poll → results
// ---------------------------------------------------------------------------

async function fetchJson(
  deps: ResolvedDeps,
  apiKey: string,
  url: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await deps.fetchImpl(url, {
      ...init,
      headers: { 'api-subscription-key': apiKey, ...(init?.headers ?? {}) },
    });
  } catch {
    // The underlying message can carry the URL and request details; dropped.
    throw new Error(CONNECTION_ERROR);
  }
  if (!res.ok) throw readableHttpError(res.status);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(UNREADABLE_RESPONSE);
  }
  if (!isRecord(body)) throw new Error(UNREADABLE_RESPONSE);
  return body;
}

interface JobOutcome {
  /** The `result` object from /results. Still untrusted. */
  result: Record<string, unknown>;
  /** Sarvam finished but could not process every page ('partially_completed'). */
  partial: boolean;
}

const TERMINAL_STATUSES = new Set(['completed', 'partially_completed', 'failed', 'rejected']);

/** True once Sarvam will never change this job's status again. */
export function isSarvamTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Create one extract job — the request statements resume from. Nothing is
 * polled here; the create response's own status rides along so the receipt
 * loop below behaves exactly as it did before this seam was extracted.
 */
async function createExtractJob(
  apiKey: string,
  file: Blob,
  filename: string,
  schema: Record<string, unknown>,
  deps: ResolvedDeps,
): Promise<{ jobId: string; status: string }> {
  const form = new FormData();
  form.append('file', file, filename);
  // Sarvam takes the schema as a JSON *string* field, not a JSON part.
  form.append('schema', JSON.stringify(schema));

  const created = await fetchJson(deps, apiKey, `${SARVAM_JOB_BASE}/extract`, {
    method: 'POST',
    body: form,
  });
  const jobId = typeof created.job_id === 'string' ? created.job_id : '';
  if (!jobId) throw new Error(UNREADABLE_RESPONSE);
  return { jobId, status: typeof created.status === 'string' ? created.status : 'pending' };
}

/**
 * Run one extract job to a terminal state and fetch its result — the receipt
 * path's in-request loop (receipts are single small jobs; the 90s ceiling is
 * honest for them). The wait is bounded by iteration count (`waited`
 * accumulates the configured interval), not by the wall clock, so the timeout
 * behaves identically under the tests' no-op sleep and in production.
 */
async function runExtractJob(
  apiKey: string,
  file: Blob,
  filename: string,
  schema: Record<string, unknown>,
  deps: ResolvedDeps,
): Promise<JobOutcome> {
  const created = await createExtractJob(apiKey, file, filename, schema, deps);
  const jobId = created.jobId;

  let status = created.status;
  let waited = 0;
  while (!TERMINAL_STATUSES.has(status)) {
    if (waited >= deps.pollTimeoutMs) {
      throw new Error(
        'Sarvam did not finish reading this document in time. Try again in a moment.',
      );
    }
    await deps.sleep(deps.pollIntervalMs);
    waited += deps.pollIntervalMs;
    const polled = await fetchJson(
      deps,
      apiKey,
      `${SARVAM_JOB_BASE}/${encodeURIComponent(jobId)}/status`,
    );
    status = typeof polled.status === 'string' ? polled.status : '';
  }

  if (status === 'failed' || status === 'rejected') {
    // The job's own error detail is dropped with the rest (spec §20).
    throw new Error('Sarvam could not read this document. Try again, or try a clearer copy.');
  }

  const fetched = await fetchJson(
    deps,
    apiKey,
    `${SARVAM_JOB_BASE}/${encodeURIComponent(jobId)}/results`,
  );
  if (!isRecord(fetched.result)) throw new Error(UNREADABLE_RESPONSE);
  return { result: fetched.result, partial: status === 'partially_completed' };
}

// ---------------------------------------------------------------------------
// Public runners
// ---------------------------------------------------------------------------

/** What one submit attempt produced — never thrown, so a half-submitted read
 * can record the jobs that DO exist before the caller fails the run. */
export interface SarvamStatementSubmit {
  /** Ids of the jobs actually created, in batch (page) order. */
  jobIds: string[];
  /** Total batches the split produced (0 when the split itself failed). */
  batchCount: number;
  /** The readable error that stopped submission, or null when every batch's
   * job was created. */
  failure: Error | null;
}

/**
 * Submit one PDF statement of any length: split into ≤10-page chunks and
 * create one extract job per chunk, in page order, WITHOUT polling any of
 * them — worker/statements.ts persists the returned job ids and drives them
 * to completion across client ticks. Creation stays sequential, which keeps
 * even a 100-page statement (10 creates) inside the 10 rpm account limit and
 * the per-request subrequest cap.
 *
 * Batch-boundary honesty is unchanged from the blocking runner this replaced:
 * chunks do not overlap, so a row printed across a page boundary can be lost
 * or misread — that risk rides the loud 'partial'/review semantics.
 *
 * Never throws: a create failure partway (or a split failure) comes back as
 * `failure` alongside whatever jobs were already created, so the caller can
 * record them (they exist at Sarvam and were paid for) while failing the run
 * readably instead of leaving orphans it would poll forever.
 */
export async function submitSarvamStatementJobs(
  apiKey: string,
  bytes: ArrayBuffer | Uint8Array,
  categories: readonly string[],
  deps: SarvamDeps = {},
): Promise<SarvamStatementSubmit> {
  const resolved = resolveDeps(deps);
  const schema = sarvamStatementSchema(categories);

  let batches: Uint8Array[];
  try {
    batches = await splitPdfIntoBatches(bytes, MAX_SARVAM_PAGES_PER_JOB);
  } catch (err) {
    return {
      jobIds: [],
      batchCount: 0,
      failure: err instanceof Error ? err : new Error('This PDF could not be read.'),
    };
  }

  const jobIds: string[] = [];
  for (let i = 0; i < batches.length; i++) {
    const file = new Blob([batches[i] as unknown as BlobPart], { type: 'application/pdf' });
    try {
      const created = await createExtractJob(
        apiKey,
        file,
        `statement-part-${i + 1}.pdf`,
        schema,
        resolved,
      );
      jobIds.push(created.jobId);
    } catch (err) {
      return {
        jobIds,
        batchCount: batches.length,
        failure: err instanceof Error ? err : new Error(UNREADABLE_RESPONSE),
      };
    }
  }
  return { jobIds, batchCount: batches.length, failure: null };
}

/** One status poll for one job — a single subrequest, no waiting. */
export async function pollSarvamJobStatus(
  apiKey: string,
  jobId: string,
  deps: SarvamDeps = {},
): Promise<string> {
  const resolved = resolveDeps(deps);
  const polled = await fetchJson(
    resolved,
    apiKey,
    `${SARVAM_JOB_BASE}/${encodeURIComponent(jobId)}/status`,
  );
  return typeof polled.status === 'string' ? polled.status : '';
}

/**
 * Fetch one completed (or partially completed) job's raw rows. Raw means raw:
 * the plain objects Sarvam returned, NOT the envelope shape — the tick stores
 * them as-is and the finalize step runs toStatementEnvelopeRow + normalize,
 * so persisted state holds exactly what the provider said and nothing more.
 * A results body without a rows array reads as zero rows, not an error.
 */
export async function fetchSarvamJobRows(
  apiKey: string,
  jobId: string,
  deps: SarvamDeps = {},
): Promise<unknown[]> {
  const resolved = resolveDeps(deps);
  const fetched = await fetchJson(
    resolved,
    apiKey,
    `${SARVAM_JOB_BASE}/${encodeURIComponent(jobId)}/results`,
  );
  if (!isRecord(fetched.result)) throw new Error(UNREADABLE_RESPONSE);
  return Array.isArray(fetched.result.rows) ? fetched.result.rows : [];
}

/**
 * Read one receipt/invoice (PDF, JPEG or PNG — providers.ts gates the mime).
 * Returns the envelope-shaped answer for normalizeExtraction to re-validate.
 */
export async function runSarvamReceipt(
  apiKey: string,
  bytes: ArrayBuffer | Uint8Array,
  mimeType: string,
  categories: readonly string[],
  deps: SarvamDeps = {},
): Promise<unknown> {
  const resolved = resolveDeps(deps);
  const file = new Blob([bytes as BlobPart], { type: mimeType });
  const extension = mimeType === 'application/pdf' ? 'pdf' : mimeType === 'image/png' ? 'png' : 'jpg';
  const outcome = await runExtractJob(
    apiKey,
    file,
    `receipt.${extension}`,
    sarvamReceiptSchema(categories),
    resolved,
  );
  return toReceiptEnvelope(outcome.result);
}
