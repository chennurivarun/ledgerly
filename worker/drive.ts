// /api/drive-sync — the automation posts grounded transactions + original file
// bytes here; this module owns durable storage, the resetAt fence and the
// processed-file ledger (spec §4.7, §17).
import {
  MAX_FILE_BYTES,
  type DocStatus,
  type DriveSyncMeta,
  type DriveSyncResult,
  type DriveSyncStatus,
} from '../shared/types';
import {
  MAX_PROCESSED_FILE_IDS,
  PROCESSED_FILE_IDS_KEY,
  readProcessedFileIds,
  readSettings,
  writeSettings,
} from './settingsStore';
import { insertTransactions } from './transactions';
import { ApiFail, clip, isRecord, safeFilename } from './util';

const MAX_FILES_PER_SYNC = 100;
const MAX_TX_PER_SYNC = 5000;
const MAX_REPORTED_ERRORS = 20;
const DRIVE_ACCOUNT = 'Drive import';
const DRIVE_TAG = 'Drive import';

export interface DriveFile {
  fileId: string;
  filename: string;
  mimeType: string;
  modifiedTime: string;
  contentBase64?: string;
  status: DocStatus;
}

export type DriveDisposition = 'process' | 'processed' | 'fenced' | 'invalid-time';

/**
 * Which files a sync run may touch. Pure — exported for tests.
 * - already in the processed ledger → never re-imported
 * - modified at or before `resetAt` → fenced out after a wipe (spec §4.7)
 * - unreadable modified time → left alone so it can be retried, not guessed
 */
export function driveFileDisposition(
  file: { fileId: string; modifiedTime?: string },
  ctx: { processed: ReadonlySet<string>; resetAt: string | null },
): DriveDisposition {
  if (ctx.processed.has(file.fileId)) return 'processed';
  if (!ctx.resetAt) return 'process';
  const reset = Date.parse(ctx.resetAt);
  const modified = Date.parse(file.modifiedTime ?? '');
  if (!Number.isFinite(reset)) return 'process'; // no usable fence
  if (!Number.isFinite(modified)) return 'invalid-time';
  return modified <= reset ? 'fenced' : 'process';
}

/** Append newly processed ids, dedupe, keep the most recent 5000. Pure. */
export function capProcessedIds(
  existing: readonly string[],
  added: readonly string[],
  max = MAX_PROCESSED_FILE_IDS,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...existing, ...added]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.slice(-max);
}

export async function readDriveStatus(db: D1Database): Promise<DriveSyncStatus> {
  const [settings, processedFileIds] = await Promise.all([
    readSettings(db),
    readProcessedFileIds(db),
  ]);
  const drive: DriveSyncMeta = settings.drive ?? {};
  return {
    folder: drive,
    schedule: { time: '08:00', timezone: drive.timezone ?? 'unset', cadence: 'daily' },
    lastSyncedAt: drive.lastSyncedAt ?? null,
    lastStatus: drive.lastStatus ?? null,
    counts: {
      imported: drive.lastImported ?? 0,
      duplicates: drive.lastDuplicates ?? 0,
      stored: drive.lastStored ?? 0,
      review: drive.lastReview ?? 0,
      errors: drive.lastErrors?.length ?? 0,
    },
    processedFileIds,
    resetAt: settings.driveResetAt,
  };
}

function validateFile(raw: unknown): DriveFile | null {
  if (!isRecord(raw)) return null;
  const fileId = typeof raw.fileId === 'string' ? raw.fileId.trim() : '';
  const filename = typeof raw.filename === 'string' ? raw.filename.trim() : '';
  if (!fileId || !filename) return null;
  const status = raw.status;
  return {
    fileId,
    filename,
    mimeType:
      typeof raw.mimeType === 'string' && raw.mimeType.trim()
        ? raw.mimeType.trim()
        : 'application/octet-stream',
    modifiedTime: typeof raw.modifiedTime === 'string' ? raw.modifiedTime.trim() : '',
    contentBase64: typeof raw.contentBase64 === 'string' ? raw.contentBase64 : undefined,
    status: status === 'stored' || status === 'queued' || status === 'review' ? status : 'review',
  };
}

function decodeBase64(raw: string): Uint8Array {
  const cleaned = raw.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  // Reject before allocating: 4 base64 chars carry 3 bytes.
  if ((cleaned.length * 3) / 4 > MAX_FILE_BYTES) {
    throw new ApiFail(413, 'File is larger than 20 MB.');
  }
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Store the batch. A file id is added to the processed ledger only after its
 * bytes and its transactions are safely in D1/R2 — anything that fails stays
 * unprocessed so tomorrow's run retries it (spec §17.2).
 */
export async function runDriveSync(env: Env, body: unknown): Promise<DriveSyncResult> {
  if (!isRecord(body)) throw new ApiFail(400, 'Send a JSON body with transactions, files or errors.');
  const db = env.DB;

  const rawFiles = Array.isArray(body.files) ? body.files : [];
  const rawTxs = Array.isArray(body.transactions) ? body.transactions : [];
  if (rawFiles.length > MAX_FILES_PER_SYNC) {
    throw new ApiFail(400, `Send at most ${MAX_FILES_PER_SYNC} files per sync request.`);
  }
  if (rawTxs.length > MAX_TX_PER_SYNC) {
    throw new ApiFail(400, `Send at most ${MAX_TX_PER_SYNC} transactions per sync request.`);
  }

  const [settings, processedList] = await Promise.all([readSettings(db), readProcessedFileIds(db)]);
  const processed = new Set(processedList);
  const resetAt = settings.driveResetAt;

  const errors: string[] = [];
  if (Array.isArray(body.errors)) {
    for (const e of body.errors.slice(0, MAX_REPORTED_ERRORS)) {
      if (typeof e === 'string' && e.trim()) errors.push(clip(e.trim()));
    }
  }

  // fileId → whether everything we were given for it is now durably stored.
  const fileOutcome = new Map<string, boolean>();
  const skipped = new Set<string>(); // fenced / unusable: their transactions are ignored too
  let filesStored = 0;
  let filesReview = 0;

  for (const raw of rawFiles) {
    const file = validateFile(raw);
    if (!file) {
      errors.push('A file entry was missing its id or filename and was skipped.');
      continue;
    }
    const disposition = driveFileDisposition(file, { processed, resetAt });
    if (disposition === 'processed') continue; // already imported on an earlier run
    if (disposition === 'fenced') {
      skipped.add(file.fileId); // modified at or before the wipe — stays out (spec §4.7)
      continue;
    }
    if (disposition === 'invalid-time') {
      skipped.add(file.fileId);
      errors.push(`${file.filename}: unreadable modified time; left for a later run.`);
      continue;
    }
    if (!file.contentBase64) {
      fileOutcome.set(file.fileId, false);
      errors.push(`${file.filename}: no file content was provided; left for a later run.`);
      continue;
    }

    try {
      const bytes = decodeBase64(file.contentBase64);
      if (bytes.byteLength === 0) throw new ApiFail(400, 'File was empty.');
      if (bytes.byteLength > MAX_FILE_BYTES) throw new ApiFail(413, 'File is larger than 20 MB.');

      const objectKey = `drive-inbox/${safeFilename(file.fileId)}-${safeFilename(file.filename)}`;
      await env.BUCKET.put(objectKey, bytes, {
        httpMetadata: { contentType: file.mimeType },
        customMetadata: { driveFileId: file.fileId, modifiedTime: file.modifiedTime },
      });
      await db
        .prepare(
          `INSERT INTO documents (id, filename, mimeType, size, objectKey, status, source, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, 'google-drive', ?)
           ON CONFLICT(objectKey) DO UPDATE SET
             filename = excluded.filename,
             mimeType = excluded.mimeType,
             size = excluded.size,
             status = excluded.status,
             createdAt = excluded.createdAt`,
        )
        .bind(
          crypto.randomUUID(),
          file.filename,
          file.mimeType,
          bytes.byteLength,
          objectKey,
          file.status,
          new Date().toISOString(),
        )
        .run();

      filesStored++;
      if (file.status === 'review') filesReview++;
      fileOutcome.set(file.fileId, true);
    } catch (err) {
      fileOutcome.set(file.fileId, false);
      const why = err instanceof ApiFail ? err.message : 'could not be stored';
      errors.push(clip(`${file.filename}: ${why} Left for a later run.`));
    }
  }

  // Transactions are grouped by source file so one failing file does not block
  // another file's rows from being marked processed.
  const groups = new Map<string, unknown[]>();
  for (const raw of rawTxs) {
    const fileId = isRecord(raw) && typeof raw.fileId === 'string' ? raw.fileId.trim() : '';
    if (fileId && (skipped.has(fileId) || processed.has(fileId))) continue; // ledger/fence wins
    const list = groups.get(fileId) ?? [];
    list.push(raw);
    groups.set(fileId, list);
  }

  let imported = 0;
  let duplicates = 0;
  const txOutcome = new Map<string, boolean>();
  for (const [fileId, list] of groups) {
    const result = await insertTransactions(db, list, {
      forceSource: 'google-drive',
      account: DRIVE_ACCOUNT,
      extraTags: [DRIVE_TAG],
    });
    imported += result.inserted;
    duplicates += result.duplicates;
    for (const err of result.errors) errors.push(clip(err));
    txOutcome.set(fileId, result.errors.length === 0);
  }

  const newlyProcessed: string[] = [];
  for (const [fileId, stored] of fileOutcome) {
    if (stored && (txOutcome.get(fileId) ?? true)) newlyProcessed.push(fileId);
  }
  for (const [fileId, ok] of txOutcome) {
    if (fileId && ok && !fileOutcome.has(fileId)) newlyProcessed.push(fileId);
  }

  const lastSyncedAt = new Date().toISOString();
  const status: 'complete' | 'partial' = errors.length > 0 ? 'partial' : 'complete';
  const drive: DriveSyncMeta = {
    ...(settings.drive ?? {}),
    lastSyncedAt,
    lastStatus: status,
    lastImported: imported,
    lastDuplicates: duplicates,
    lastStored: filesStored,
    lastReview: filesReview,
    lastErrors: errors.slice(0, MAX_REPORTED_ERRORS),
  };
  await writeSettings(db, {
    drive,
    [PROCESSED_FILE_IDS_KEY]: capProcessedIds(processedList, newlyProcessed),
  });

  return {
    status,
    lastSyncedAt,
    imported,
    duplicates,
    filesStored,
    filesReview,
    errors: errors.slice(0, MAX_REPORTED_ERRORS),
  };
}
