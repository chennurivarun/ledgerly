// The advisory pageCount on vault documents (sprint 11): PDFs get a real
// count at upload time, everything else — and every PDF that can't be read —
// stays null. The count exists so the UI can stop offering the single-receipt
// Extract path on multi-page PDFs; it must never change what uploads succeed.
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { computePdfPageCount, uploadDocuments } from '../worker/documents';

async function pdfWithPages(count: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) doc.addPage([100 + i, 200]);
  return doc.save({ useObjectStreams: false });
}

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/**
 * A structurally valid PDF whose trailer carries an /Encrypt dictionary —
 * pdf-lib cannot *create* encrypted PDFs, so the marker real banks set is
 * spliced into a fixture (same trick as tests/sarvam.test.ts).
 */
async function encryptedPdf(): Promise<Uint8Array> {
  const bytes = await pdfWithPages(1);
  const latin = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  const at = latin.lastIndexOf('trailer');
  expect(at).toBeGreaterThan(-1);
  const open = latin.indexOf('<<', at);
  expect(open).toBeGreaterThan(-1);
  const insert = ascii(' /Encrypt << /Filter /Standard /V 1 >>');
  const out = new Uint8Array(bytes.length + insert.length);
  out.set(bytes.subarray(0, open + 2), 0);
  out.set(insert, open + 2);
  out.set(bytes.subarray(open + 2), open + 2 + insert.length);
  return out;
}

describe('computePdfPageCount — the decision logic, pure', () => {
  it('counts a real PDF', async () => {
    expect(await computePdfPageCount('application/pdf', await pdfWithPages(1))).toBe(1);
    expect(await computePdfPageCount('application/pdf', await pdfWithPages(12))).toBe(12);
  });

  it('matches the PDF mime case-insensitively (client-declared, so casing varies)', async () => {
    expect(await computePdfPageCount('Application/PDF', await pdfWithPages(3))).toBe(3);
  });

  it('is null for non-PDF mimes even when the bytes happen to be a PDF', async () => {
    // Pages are not a meaningful concept for a CSV/image row; the mime the
    // client declared is what the rest of the app gates on.
    expect(await computePdfPageCount('text/csv', await pdfWithPages(2))).toBeNull();
    expect(await computePdfPageCount('image/png', ascii('png-ish'))).toBeNull();
  });

  it('is null — never a throw — for unreadable bytes', async () => {
    expect(await computePdfPageCount('application/pdf', ascii('not a pdf at all'))).toBeNull();
  });

  it('is null for an encrypted PDF: the count is unknown, not guessed', async () => {
    expect(await computePdfPageCount('application/pdf', await encryptedPdf())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// uploadDocuments sets the count on the stored row. Minimal fake env: the
// upload path reads settings (managed categories) and inserts document rows.
// ---------------------------------------------------------------------------

function fakeEnv() {
  const documents: Record<string, unknown>[] = [];
  const exec = (sql: string, args: unknown[]): { rows: Record<string, unknown>[] } => {
    if (/SELECT key, value FROM settings/i.test(sql)) return { rows: [] }; // defaults apply
    if (/INSERT OR IGNORE INTO settings/i.test(sql)) return { rows: [] };
    if (/CREATE /i.test(sql) || /ALTER TABLE/i.test(sql)) return { rows: [] };
    if (/INSERT INTO documents/i.test(sql)) {
      documents.push({
        id: args[0],
        filename: args[1],
        mimeType: args[2],
        size: args[3],
        objectKey: args[4],
        status: args[5],
        source: args[6],
        createdAt: args[7],
        pageCount: args[8],
      });
      return { rows: [] };
    }
    throw new Error(`fake D1 has no handler for: ${sql}`);
  };
  interface Stmt {
    sql: string;
    args: unknown[];
    bind(...values: unknown[]): Stmt;
    all<T>(): Promise<{ results: T[] }>;
    first<T>(): Promise<T | null>;
    run(): Promise<{ meta: { changes: number } }>;
  }
  const statement = (sql: string, args: unknown[] = []): Stmt => ({
    sql,
    args,
    bind: (...values: unknown[]) => statement(sql, values),
    all: async <T,>() => ({ results: exec(sql, args).rows as T[] }),
    first: async <T,>() => (exec(sql, args).rows[0] as T | undefined) ?? null,
    run: async () => {
      exec(sql, args);
      return { meta: { changes: 1 } };
    },
  });
  const env = {
    DB: {
      prepare: (sql: string) => statement(sql),
      batch: async (statements: Stmt[]) => {
        for (const s of statements) exec(s.sql, s.args);
        return [];
      },
    },
    BUCKET: { put: async () => undefined },
  } as unknown as Env;
  return { env, documents };
}

function formWith(files: File[]): FormData {
  const form = new FormData();
  for (const f of files) form.append('files', f);
  return form;
}

describe('uploadDocuments — pageCount lands on the stored row', () => {
  it('a 12-page PDF is stored with pageCount 12', async () => {
    const { env, documents } = fakeEnv();
    const bytes = await pdfWithPages(12);
    const file = new File([bytes as BlobPart], 'statement.pdf', { type: 'application/pdf' });
    const result = await uploadDocuments(env, formWith([file]));
    expect(result.errors).toEqual([]);
    expect(result.documents[0].pageCount).toBe(12);
    expect(documents[0].pageCount).toBe(12);
  });

  it('an unreadable PDF still uploads, with pageCount null and no extra error', async () => {
    // The count is advisory: a corrupt PDF stores exactly as it did before
    // the column existed — for review, count unknown, upload not failed.
    const { env, documents } = fakeEnv();
    const file = new File([ascii('%PDF-1.4 but broken') as BlobPart], 'broken.pdf', {
      type: 'application/pdf',
    });
    const result = await uploadDocuments(env, formWith([file]));
    expect(result.errors).toEqual([]);
    expect(result.documents[0].status).toBe('review');
    expect(result.documents[0].pageCount).toBeNull();
    expect(documents[0].pageCount).toBeNull();
  });

  it('a non-PDF is stored with pageCount null', async () => {
    const { env, documents } = fakeEnv();
    const file = new File([ascii('fake image bytes') as BlobPart], 'receipt.png', {
      type: 'image/png',
    });
    const result = await uploadDocuments(env, formWith([file]));
    expect(result.documents[0].pageCount).toBeNull();
    expect(documents[0].pageCount).toBeNull();
  });
});
