// The extraction review flow: run → suggest → confirm or dismiss.
//
// An extraction row is a *suggestion*. No transaction exists until the user
// confirms one, and confirming goes through the same insertTransactions
// pipeline as manual entry, CSV and Drive — same validation, same duplicate
// fingerprint, same rules (spec §4.4, VISION.md principle 2).
import {
  MAX_FILE_BYTES,
  type BatchInsertResult,
  type ExtractionResult,
  type ExtractionStatus,
} from '../shared/types';
import {
  assertMimeSupported,
  emptyFields,
  extractFromDocument,
  selectProvider,
  type ExtractionFields,
} from './ai';
import { readSettings } from './settingsStore';
import { insertTransactions } from './transactions';
import { ApiFail, clip, isRecord } from './util';

const EXTRACTION_COLUMNS =
  'documentId, status, fields, provider, model, error, createdAt, updatedAt';

const STATUSES = new Set<string>([
  'pending',
  'suggested',
  'confirmed',
  'dismissed',
  'failed',
]);

interface ExtractionRow {
  documentId: string;
  status: string;
  fields: string;
  provider: string;
  model: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocRow {
  id: string;
  mimeType: string;
  objectKey: string;
  size: number;
}

/** A corrupt `fields` blob degrades to all-unknown rather than breaking /api/state. */
function parseFields(raw: string): ExtractionFields {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return emptyFields();
    // Stored rows were normalized on the way in; re-shaping here would need the
    // category list, which is not what this read path is for.
    return { ...emptyFields(), ...(parsed as Partial<ExtractionFields>) };
  } catch {
    return emptyFields();
  }
}

function rowToExtraction(row: ExtractionRow): ExtractionResult {
  const fields = parseFields(row.fields);
  return {
    documentId: row.documentId,
    status: (STATUSES.has(row.status) ? row.status : 'failed') as ExtractionStatus,
    merchant: fields.merchant,
    date: fields.date,
    total: fields.total,
    type: fields.type,
    category: fields.category,
    provider: row.provider,
    model: row.model,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Rows for the documents /api/state actually returned. Bounded by that same
 * cap, so this never becomes an unbounded read as the vault grows.
 */
export async function readExtractions(
  db: D1Database,
  documentIds: string[],
): Promise<ExtractionResult[]> {
  if (documentIds.length === 0) return [];
  const out: ExtractionResult[] = [];
  for (let i = 0; i < documentIds.length; i += 100) {
    const chunk = documentIds.slice(i, i + 100);
    const placeholders = chunk.map(() => '?').join(',');
    const { results } = await db
      .prepare(
        `SELECT ${EXTRACTION_COLUMNS} FROM extractions WHERE documentId IN (${placeholders})`,
      )
      .bind(...chunk)
      .all<ExtractionRow>();
    for (const row of results ?? []) out.push(rowToExtraction(row));
  }
  return out;
}

/** Shared with the statement pipeline — same 404, same words. */
export async function readDocumentRow(db: D1Database, id: string): Promise<DocRow> {
  const row = await db
    .prepare('SELECT id, mimeType, objectKey, size FROM documents WHERE id = ?')
    .bind(id)
    .first<DocRow>();
  if (!row) throw new ApiFail(404, 'That document no longer exists.');
  return row;
}

interface UpsertInput {
  documentId: string;
  status: ExtractionStatus;
  fields: ExtractionFields;
  provider: string;
  model: string;
  error: string | null;
  now: string;
}

/** `createdAt` survives a re-run; everything else is replaced. */
async function upsertExtraction(db: D1Database, input: UpsertInput): Promise<ExtractionResult> {
  const row: ExtractionRow = {
    documentId: input.documentId,
    status: input.status,
    fields: JSON.stringify(input.fields),
    provider: input.provider,
    model: input.model,
    error: input.error,
    createdAt: input.now,
    updatedAt: input.now,
  };
  await db
    .prepare(
      `INSERT INTO extractions (${EXTRACTION_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(documentId) DO UPDATE SET
         status = excluded.status,
         fields = excluded.fields,
         provider = excluded.provider,
         model = excluded.model,
         error = excluded.error,
         updatedAt = excluded.updatedAt`,
    )
    .bind(
      row.documentId,
      row.status,
      row.fields,
      row.provider,
      row.model,
      row.error,
      row.createdAt,
      row.updatedAt,
    )
    .run();

  const saved = await db
    .prepare(`SELECT ${EXTRACTION_COLUMNS} FROM extractions WHERE documentId = ?`)
    .bind(input.documentId)
    .first<ExtractionRow>();
  return saved ? rowToExtraction(saved) : rowToExtraction(row);
}

/**
 * Move an existing row to a terminal status without disturbing the suggestion
 * it holds — the fields stay readable after confirm/dismiss so the review
 * history is still auditable. Inserts a bare row when the user resolves a
 * document that was never extracted.
 */
async function setStatus(
  db: D1Database,
  documentId: string,
  status: ExtractionStatus,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO extractions (${EXTRACTION_COLUMNS})
       VALUES (?, ?, ?, '', '', NULL, ?, ?)
       ON CONFLICT(documentId) DO UPDATE SET
         status = excluded.status,
         error = NULL,
         updatedAt = excluded.updatedAt`,
    )
    .bind(documentId, status, JSON.stringify(emptyFields()), now, now)
    .run();
}

/**
 * "Try again" is offered on pending and failed rows, so a second POST can land
 * while a first run is still awaiting the model — and both would pay for a
 * metered call. A run therefore claims the row first; a claim older than this
 * window belongs to a run that died, not one that is running, so a crashed
 * worker never blocks retries for good.
 */
export const EXTRACTION_IN_FLIGHT_MS = 2 * 60 * 1000;

/**
 * The guard's decision, kept pure so tests can pin it down: only a fresh
 * 'pending' claim blocks a second run. A garbled stamp reads as not running —
 * failing open costs one duplicate call, failing closed strands the document.
 */
export function extractionInFlight(
  status: string,
  updatedAt: string,
  now: string,
  windowMs = EXTRACTION_IN_FLIGHT_MS,
): boolean {
  if (status !== 'pending') return false;
  const claimed = Date.parse(updatedAt);
  if (Number.isNaN(claimed)) return false;
  return Date.parse(now) - claimed < windowMs;
}

const IN_FLIGHT_MESSAGE =
  'That extraction is already running — give it a moment to finish.';

/**
 * Flip the row to 'pending' for this run. The write is conditional on the
 * exact row this request read, so when two POSTs race, D1's serialized writes
 * let one claim through and the other sees no change — same 409 either way.
 * The previous suggestion's fields survive the claim; they stay auditable
 * while the re-run is in flight.
 */
async function claimExtraction(
  db: D1Database,
  documentId: string,
  provider: string,
  model: string,
  now: string,
): Promise<void> {
  const current = await db
    .prepare('SELECT status, updatedAt FROM extractions WHERE documentId = ?')
    .bind(documentId)
    .first<{ status: string; updatedAt: string }>();
  if (current && extractionInFlight(current.status, current.updatedAt, now)) {
    throw new ApiFail(409, IN_FLIGHT_MESSAGE);
  }

  const claimed = current
    ? await db
        .prepare(
          `UPDATE extractions
           SET status = 'pending', provider = ?, model = ?, error = NULL, updatedAt = ?
           WHERE documentId = ? AND updatedAt = ?`,
        )
        .bind(provider, model, now, documentId, current.updatedAt)
        .run()
    : await db
        .prepare(
          `INSERT INTO extractions (${EXTRACTION_COLUMNS})
           VALUES (?, 'pending', ?, ?, ?, NULL, ?, ?)
           ON CONFLICT(documentId) DO NOTHING`,
        )
        .bind(documentId, JSON.stringify(emptyFields()), provider, model, now, now)
        .run();
  if (claimed.meta.changes === 0) throw new ApiFail(409, IN_FLIGHT_MESSAGE);
}

/** POST /api/documents/:id/extract */
export async function runExtraction(env: Env, documentId: string): Promise<ExtractionResult> {
  const doc = await readDocumentRow(env.DB, documentId);
  const settings = await readSettings(env.DB);

  // Configuration problems are the user's to fix, so they are 400s and leave
  // no row behind; only an attempted-and-failed run is stored as `failed`.
  const { provider, model } = selectProvider(settings);
  assertMimeSupported(provider, doc.mimeType);

  // Cannot happen — upload rejects anything larger — but a stray row from a
  // future import path should not stream 20 MB+ into a model request.
  if (doc.size > MAX_FILE_BYTES) {
    throw new ApiFail(413, 'That file is too large to send for extraction.');
  }

  // Claim before touching R2 or the model: everything above is configuration
  // the user must fix (400s, no row behind), everything below is the run
  // itself. A failure past this point leaves the claim standing until the
  // window expires — acceptable, because those failures don't heal on an
  // immediate retry anyway.
  const now = new Date().toISOString();
  await claimExtraction(env.DB, documentId, provider, model, now);

  const object = await env.BUCKET.get(doc.objectKey);
  if (!object) throw new ApiFail(404, 'The stored copy of that file is no longer available.');
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new ApiFail(413, 'That file is too large to send for extraction.');
  }

  try {
    const fields = await extractFromDocument(env, settings, doc, bytes);
    return await upsertExtraction(env.DB, {
      documentId,
      status: 'suggested',
      fields,
      provider,
      model,
      error: null,
      now,
    });
  } catch (err) {
    if (err instanceof ApiFail) throw err;
    return await upsertExtraction(env.DB, {
      documentId,
      status: 'failed',
      fields: emptyFields(),
      provider,
      model,
      error: clip(err instanceof Error ? err.message : 'Extraction failed.'),
      now,
    });
  }
}

/**
 * POST /api/documents/:id/extraction/confirm — body is the user-edited TxInput.
 * Duplicates are reported honestly in the result, not raised as an error: the
 * transaction the user wanted does exist, it was just already there.
 */
export async function confirmExtraction(
  env: Env,
  documentId: string,
  body: unknown,
): Promise<BatchInsertResult> {
  await readDocumentRow(env.DB, documentId);

  const result = await insertTransactions(env.DB, [body], {
    forceSource: 'document',
    receipt: true,
  });

  // A single user-edited form, unlike a CSV batch, has no partial success to
  // report — an invalid field is a 400 with the reason, so the review modal
  // can point at it.
  if (result.inserted === 0 && result.duplicates === 0) {
    const reason = result.errors[0]?.replace(/^Row 1:\s*/, '') ?? 'the details could not be saved.';
    throw new ApiFail(400, clip(`Check the transaction: ${reason}`));
  }

  await setStatus(env.DB, documentId, 'confirmed');
  await env.DB.prepare("UPDATE documents SET status = 'stored' WHERE id = ?")
    .bind(documentId)
    .run();

  return result;
}

/** POST /api/documents/:id/extraction/dismiss */
export async function dismissExtraction(env: Env, documentId: string): Promise<void> {
  await readDocumentRow(env.DB, documentId);
  await setStatus(env.DB, documentId, 'dismissed');
}
