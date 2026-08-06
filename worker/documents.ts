// POST /api/documents + download/delete. Original bytes go to R2, metadata to
// D1 (spec §4.2, §4.6). One bad file never sinks the rest of the batch (§20).
import { detectMapping, parseCsv, rowsToTransactions } from '../shared/csv';
import { MAX_FILE_BYTES, type DocStatus, type DocumentMeta, type UploadResult } from '../shared/types';
import { readSettings } from './settingsStore';
import { insertTransactions } from './transactions';
import { ApiFail, clip, safeFilename } from './util';

const MAX_FILES_PER_REQUEST = 25;

/** Only real CSV/TSV statements take the parsing path; everything else is stored as-is. */
function isCsvLike(filename: string, mimeType: string): boolean {
  const name = filename.toLowerCase();
  if (name.endsWith('.csv') || name.endsWith('.tsv')) return true;
  return /^text\/(csv|tab-separated-values)/i.test(mimeType);
}

async function insertDocumentRow(db: D1Database, doc: DocumentMeta, source: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO documents (id, filename, mimeType, size, objectKey, status, source, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(objectKey) DO UPDATE SET
         filename = excluded.filename,
         mimeType = excluded.mimeType,
         size = excluded.size,
         status = excluded.status,
         createdAt = excluded.createdAt`,
    )
    .bind(
      doc.id,
      doc.filename,
      doc.mimeType,
      doc.size,
      doc.objectKey,
      doc.status,
      source,
      doc.createdAt,
    )
    .run();
}

export async function uploadDocuments(env: Env, form: FormData): Promise<UploadResult> {
  const files = form.getAll('files').filter((v): v is File => v instanceof File);
  if (files.length === 0) throw new ApiFail(400, 'Choose at least one file to upload.');
  if (files.length > MAX_FILES_PER_REQUEST) {
    throw new ApiFail(400, `Upload at most ${MAX_FILES_PER_REQUEST} files at a time.`);
  }

  const documents: DocumentMeta[] = [];
  const errors: string[] = [];
  let inserted = 0;
  let duplicates = 0;
  let review = 0;
  // Managed categories gate which statement categories are preserved (§8.1.6).
  const managedCategories = (await readSettings(env.DB)).categories;

  for (const file of files) {
    const filename = file.name || 'file';
    if (file.size > MAX_FILE_BYTES) {
      errors.push(`${filename} is larger than 20 MB and was not uploaded.`);
      continue;
    }
    if (file.size === 0) {
      errors.push(`${filename} is empty and was not uploaded.`);
      continue;
    }

    const id = crypto.randomUUID();
    const objectKey = `uploads/${id}-${safeFilename(filename)}`;
    const mimeType = file.type || 'application/octet-stream';

    let bytes: ArrayBuffer;
    try {
      bytes = await file.arrayBuffer();
    } catch {
      errors.push(`${filename} could not be read.`);
      continue;
    }
    if (bytes.byteLength > MAX_FILE_BYTES) {
      errors.push(`${filename} is larger than 20 MB and was not uploaded.`);
      continue;
    }

    try {
      await env.BUCKET.put(objectKey, bytes, { httpMetadata: { contentType: mimeType } });
    } catch {
      errors.push(`${filename} could not be stored. Nothing was saved for it.`);
      continue;
    }

    // Statements we can actually read become transactions; everything else is
    // stored for the user to review. Server-side extraction is never invented
    // from PDFs/images (spec §4.6, §8.2).
    let status: DocStatus = 'review';
    if (isCsvLike(filename, mimeType)) {
      try {
        const table = parseCsv(new TextDecoder().decode(bytes));
        const mapping =
          !table.truncated && table.headers.length > 0
            ? detectMapping(table.headers, table.rows)
            : null;
        // A truncated file or an undecidable sign convention needs a human
        // decision; this server-side path has no user to ask, so the file
        // stays in review instead of guessing (§8.2). The Import modal is the
        // interactive path that can confirm the convention.
        if (mapping && mapping.signConventionInferred !== false) {
          const parsed = rowsToTransactions(table, mapping, { categories: managedCategories });
          const result = await insertTransactions(env.DB, parsed.transactions, {
            forceSource: 'document',
            receipt: false,
          });
          inserted += result.inserted;
          duplicates += result.duplicates;
          for (const err of result.errors) errors.push(clip(`${filename}: ${err}`));
          status = 'stored';
        }
      } catch {
        errors.push(`${filename} could not be parsed; it was stored for review.`);
      }
    }
    if (status === 'review') review++;

    const doc: DocumentMeta = {
      id,
      filename,
      mimeType,
      size: bytes.byteLength,
      objectKey,
      status,
      source: 'upload',
      createdAt: new Date().toISOString(),
    };
    try {
      await insertDocumentRow(env.DB, doc, 'upload');
      documents.push(doc);
    } catch {
      errors.push(`${filename} was stored but its record could not be saved.`);
    }
  }

  return { documents, inserted, duplicates, review, errors };
}

/**
 * Only a PDF may ever be served `inline`, and only when the caller actually
 * asked for it. Every uploaded file's mimeType is client-declared and never
 * validated against real content (spec: unvalidated MIME storage is safe
 * exactly because nothing on this origin renders it) — a document stored as
 * `text/html` or `image/svg+xml` served `inline` would execute script on the
 * app's own origin (no CSP), with access to every API endpoint including the
 * ledger. Everything else always downloads as an attachment, regardless of
 * `?inline=1`.
 */
export function resolveDownloadDisposition(mimeType: string, inline: boolean): 'inline' | 'attachment' {
  const inlineOk = inline && mimeType === 'application/pdf';
  return inlineOk ? 'inline' : 'attachment';
}

/**
 * Streams the original bytes back — the R2 key never leaves the server.
 * `inline` renders the file in the browser (e.g. the extraction review
 * modal's PDF preview) instead of triggering a download; everything else
 * about the response is unchanged. Default stays `attachment` so a plain
 * link/tab-open still downloads as before.
 */
export async function downloadDocument(env: Env, id: string, opts: { inline?: boolean } = {}): Promise<Response> {
  const row = await env.DB.prepare(
    'SELECT filename, mimeType, objectKey FROM documents WHERE id = ?',
  )
    .bind(id)
    .first<{ filename: string; mimeType: string; objectKey: string }>();
  if (!row) throw new ApiFail(404, 'That document no longer exists.');

  const object = await env.BUCKET.get(row.objectKey);
  if (!object) throw new ApiFail(404, 'The stored copy of that file is no longer available.');

  const ascii = safeFilename(row.filename);
  const disposition = resolveDownloadDisposition(row.mimeType, !!opts.inline);
  const headers = new Headers();
  headers.set('Content-Type', row.mimeType || 'application/octet-stream');
  headers.set('Content-Length', String(object.size));
  // Belt-and-braces alongside the disposition allowlist above: never let a
  // browser MIME-sniff a stored file into executable content.
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set(
    'Content-Disposition',
    `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
  );
  headers.set('Cache-Control', 'private, no-store');
  return new Response(object.body, { headers });
}

export async function deleteDocument(env: Env, id: string): Promise<void> {
  const row = await env.DB.prepare('SELECT objectKey FROM documents WHERE id = ?')
    .bind(id)
    .first<{ objectKey: string }>();
  if (!row) throw new ApiFail(404, 'That document no longer exists.');
  await env.BUCKET.delete(row.objectKey);
  // AI suggestion rows are keyed to this document and unreachable once it is
  // gone (every read path scopes to live documents) — remove them with it so
  // deleted statements don't accumulate up to 300 orphaned rows each.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM documents WHERE id = ?').bind(id),
    env.DB.prepare('DELETE FROM extractions WHERE documentId = ?').bind(id),
    env.DB.prepare('DELETE FROM statement_extractions WHERE documentId = ?').bind(id),
    env.DB.prepare('DELETE FROM statement_rows WHERE documentId = ?').bind(id),
  ]);
}
