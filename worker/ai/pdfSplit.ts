// PDF page counting and splitting for providers with a pages-per-job limit
// (Sarvam Doc AI caps a job at 10 pages) and for the preflight endpoint's
// honest page math. Pure byte-in/byte-out — no bindings, no network — so the
// batch arithmetic is directly testable with pdf-lib-built fixtures.
//
// Errors here are plain `Error`s with user-readable messages: on the extract
// path they become a stored 'failed' run, on the preflight path the caller
// re-raises them as a 400. Neither path ever logs the document bytes.
import { PDFDocument } from 'pdf-lib';

const ENCRYPTED_MESSAGE =
  'This PDF is password-protected — bank statements often are. Remove the password ' +
  '(many banks offer an unprotected download, or print it to a new PDF) and upload it again.';

const UNREADABLE_MESSAGE =
  'This PDF could not be read for splitting. Re-download it from your bank and upload it again.';

/**
 * Parse once, refuse encrypted documents. `ignoreEncryption: true` lets
 * pdf-lib parse far enough to *detect* encryption instead of throwing a
 * generic error — the document is still refused, because its contents are
 * ciphertext. Passwords are NEVER attempted: a finance app guessing at a
 * statement password is exactly the behavior this product exists to avoid.
 */
async function loadPdf(bytes: ArrayBuffer | Uint8Array): Promise<PDFDocument> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch {
    // The pdf-lib message can quote fragments of the file — dropped (spec §20).
    throw new Error(UNREADABLE_MESSAGE);
  }
  if (doc.isEncrypted) throw new Error(ENCRYPTED_MESSAGE);
  return doc;
}

/** Page count for preflight math. Same refusals as splitting, same words. */
export async function countPdfPages(bytes: ArrayBuffer | Uint8Array): Promise<number> {
  return (await loadPdf(bytes)).getPageCount();
}

/**
 * Split one PDF into ordered chunks of at most `maxPages` pages, each a valid
 * standalone PDF (pdf-lib copyPages carries the page resources across).
 *
 * Page order is preserved and no page appears twice — chunk N holds pages
 * [N*maxPages, (N+1)*maxPages). There is deliberately NO page overlap between
 * chunks in v1: a transaction row printed across a page boundary can be read
 * badly or lost, and the existing loud 'partial'/review semantics are the
 * honest surface for that (docs/SARVAM.md pins the caveat for users).
 */
export async function splitPdfIntoBatches(
  bytes: ArrayBuffer | Uint8Array,
  maxPages = 10,
): Promise<Uint8Array[]> {
  const src = await loadPdf(bytes);
  const total = src.getPageCount();
  if (total === 0) throw new Error('This PDF has no pages to read.');

  const batches: Uint8Array[] = [];
  for (let start = 0; start < total; start += maxPages) {
    const end = Math.min(start + maxPages, total);
    const indices = Array.from({ length: end - start }, (_, i) => start + i);
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, indices);
    for (const page of pages) out.addPage(page);
    batches.push(await out.save());
  }
  return batches;
}
