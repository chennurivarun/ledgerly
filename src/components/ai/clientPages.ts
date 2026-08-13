// The browser side of the statement-pages flow (sprint 16): this module turns
// a stored PDF into per-page payloads with pdf.js — the text layer where the
// PDF has one, a rendered JPEG where it doesn't — and drives the worker's
// begin → round × N → finalize protocol.
//
// Trust framing, pinned: this code runs in the user's OWN browser, on a PDF
// they uploaded, and everything it submits is a SUGGESTION that rides the
// same never-guess normalization and review table as every provider — the
// manual-entry trust model. The custom API key never reaches this code: the
// worker holds it and makes every model call.
//
// pdfjs-dist is CLIENT-ONLY and imported dynamically inside the extraction
// function, so the worker bundle and the app's initial chunk never carry it.
// Pure helpers (classification, chunking, progress copy) stay at module level
// with no DOM dependency so vitest can pin them; the canvas-dependent
// rendering is isolated in renderPageToJpeg.
import { api } from '../../api';
import {
  CLIENT_STATEMENT_MAX_PAGES,
  CLIENT_STATEMENT_PAGES_PER_ROUND,
  STATEMENT_PAGE_TEXT_MAX_CHARS,
  type StatementExtraction,
  type StatementPageInput,
} from '../../../shared/types';

// ---------------------------------------------------------------------------
// Pinned constants
// ---------------------------------------------------------------------------

/**
 * A page whose extracted text layer has at least this many characters is a
 * TEXT page — the model reads the exact printed strings, which is both more
 * accurate and far cheaper than vision. Below it (a scanned page's text layer
 * is empty or a few OCR artifacts) the page is rendered to an image instead.
 * 200 characters is deliberately low: even a sparse statement page (a header
 * and a couple of rows) clears it, while a pure scan does not.
 */
export const TEXT_PAGE_MIN_CHARS = 200;

/**
 * Rendering ladder for image pages: try ~1200px wide at JPEG 0.8 (plenty for
 * a model to read table text), and step down until the data URI fits the
 * client-side cap. The cap stays under the server's 2 MB hard limit so a
 * payload the client builds is never one the server refuses.
 */
export const IMAGE_ATTEMPTS: readonly { width: number; quality: number }[] = [
  { width: 1200, quality: 0.8 },
  { width: 1000, quality: 0.7 },
  { width: 800, quality: 0.6 },
  { width: 600, quality: 0.5 },
];

/** Client-side per-image budget (data-URI length ≈ bytes; base64 is ASCII). */
export const IMAGE_MAX_BYTES = 1.5 * 1024 * 1024;

/** One retry per round, after a short breather (free tiers rate limit). */
export const ROUND_RETRY_DELAY_MS = 4000;

// ---------------------------------------------------------------------------
// Pure helpers (vitest-covered, DOM-free)
// ---------------------------------------------------------------------------

/** TEXT page or IMAGE page — the one heuristic, applied to the trimmed layer. */
export function isTextPage(text: string): boolean {
  return text.trim().length >= TEXT_PAGE_MIN_CHARS;
}

/** Clip to the server's per-page cap so a text-dense page can't 400 a round. */
export function clipPageText(text: string): string {
  return text.length > STATEMENT_PAGE_TEXT_MAX_CHARS
    ? text.slice(0, STATEMENT_PAGE_TEXT_MAX_CHARS)
    : text;
}

/** Rounds of ≤8 pages, in order — the request-size shape the worker expects. */
export function chunkPages<T>(
  pages: readonly T[],
  size = CLIENT_STATEMENT_PAGES_PER_ROUND,
): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < pages.length; i += size) out.push(pages.slice(i, i + size) as T[]);
  return out;
}

/** True when a rendered page fits the client-side image budget. */
export function imageWithinCap(dataUrl: string): boolean {
  return dataUrl.length <= IMAGE_MAX_BYTES;
}

/**
 * The round-progress copy, pinned: "Reading pages 9–16 of 23…" (en dash), or
 * the singular "Reading page 9 of 23…" when a round is one page. Page
 * numbers are 1-based — humans don't read page 0.
 */
export function pagesProgressLabel(first: number, last: number, total: number): string {
  if (first === last) return `Reading page ${first} of ${total}…`;
  return `Reading pages ${first}–${last} of ${total}…`;
}

/** The extraction-phase copy while pdf.js works through the pages. */
export function preparingLabel(page: number, total: number): string {
  return `Preparing page ${page} of ${total}…`;
}

// ---------------------------------------------------------------------------
// Cancellation — a mutable token the page flips; the flow checks it between
// steps and tells the worker the read is over (best-effort abort).
// ---------------------------------------------------------------------------

export interface CancelToken {
  cancelled: boolean;
}

export function createCancelToken(): CancelToken {
  return { cancelled: false };
}

/** Thrown (only) when the token was flipped — callers treat it as silence. */
export class ClientReadCancelled extends Error {
  constructor() {
    super('The read was cancelled.');
    this.name = 'ClientReadCancelled';
  }
}

function checkCancelled(token: CancelToken, documentId: string): void {
  if (!token.cancelled) return;
  void api.abortStatementPages(documentId).catch(() => undefined);
  throw new ClientReadCancelled();
}

// ---------------------------------------------------------------------------
// pdf.js page extraction (browser-only)
// ---------------------------------------------------------------------------

interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}

interface PdfPage {
  getViewport(opts: { scale: number }): { width: number; height: number };
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
  render(opts: { canvas: HTMLCanvasElement; viewport: unknown }): { promise: Promise<void> };
}

interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
}

/** pdf.js v6: teardown lives on the LOADING TASK, not the document proxy. */
interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}

/**
 * Dynamic on purpose (see the module header): both the library and its worker
 * asset load as a separate chunk the first time a browser read runs.
 */
async function loadPdfjs(): Promise<{
  getDocument(opts: { data: ArrayBuffer }): PdfLoadingTask;
}> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs as unknown as {
    getDocument(opts: { data: ArrayBuffer }): PdfLoadingTask;
  };
}

/** One page's text layer, joined with pdf.js's own line breaks. */
function joinTextItems(items: PdfTextItem[]): string {
  let out = '';
  for (const item of items) {
    if (typeof item.str === 'string') out += item.str;
    out += item.hasEOL ? '\n' : ' ';
  }
  return out;
}

/**
 * Render one page down the attempt ladder until it fits the image budget.
 * Returns null when even the smallest attempt is too big (an extreme page) —
 * the caller skips that page and marks the read truncated, loudly, instead of
 * sending a payload the server would refuse.
 */
async function renderPageToJpeg(page: PdfPage): Promise<string | null> {
  const base = page.getViewport({ scale: 1 });
  for (const attempt of IMAGE_ATTEMPTS) {
    const scale = attempt.width / base.width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
    const dataUrl = canvas.toDataURL('image/jpeg', attempt.quality);
    if (imageWithinCap(dataUrl)) return dataUrl;
  }
  return null;
}

export interface ExtractedPages {
  pages: StatementPageInput[];
  /** Pages were skipped (past the 100-page cap, or unrenderable) — the read
   * must finalize as a loud partial. */
  truncated: boolean;
}

/**
 * Every page of the PDF as a round-ready payload: text where the PDF carries
 * a usable text layer, a rendered JPEG where it doesn't. Reads at most
 * CLIENT_STATEMENT_MAX_PAGES pages; anything past that is reported as
 * truncation, never silently dropped.
 */
export async function extractStatementPages(
  bytes: ArrayBuffer,
  onProgress: (label: string) => void,
  token: CancelToken,
  documentId: string,
): Promise<ExtractedPages> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: bytes });
  const doc = await task.promise;
  try {
    const total = doc.numPages;
    const cap = Math.min(total, CLIENT_STATEMENT_MAX_PAGES);
    const pages: StatementPageInput[] = [];
    let truncated = total > cap;

    for (let i = 1; i <= cap; i++) {
      checkCancelled(token, documentId);
      onProgress(preparingLabel(i, cap));
      const page = await doc.getPage(i);
      const text = joinTextItems((await page.getTextContent()).items);
      if (isTextPage(text)) {
        pages.push({ index: i - 1, kind: 'text', content: clipPageText(text) });
        continue;
      }
      const image = await renderPageToJpeg(page);
      if (image === null) {
        truncated = true; // skipped, and finalize will say so
        continue;
      }
      pages.push({ index: i - 1, kind: 'image', content: image });
    }
    return { pages, truncated };
  } finally {
    void task.destroy().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// The flow driver
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One round with one retry after a breather — then the caller marks truncated. */
async function roundWithRetry(
  documentId: string,
  pages: StatementPageInput[],
  token: CancelToken,
): Promise<{ rows: unknown[]; truncated: boolean }> {
  try {
    return await api.statementPagesRound(documentId, { pages });
  } catch {
    checkCancelled(token, documentId);
    await sleep(ROUND_RETRY_DELAY_MS);
    checkCancelled(token, documentId);
    return await api.statementPagesRound(documentId, { pages });
  }
}

/**
 * The whole read: begin (claim) → download the PDF from the vault → extract
 * pages → rounds, sequentially, one retry each → finalize through the
 * worker's ordinary pipeline. A round that fails twice marks the read
 * truncated and moves on — a loud partial always beats a silent hole. Throws
 * ClientReadCancelled when the token flips (abort already sent), and a
 * readable Error for anything that stops the read entirely (abort sent
 * best-effort so the claim never lingers).
 */
export async function runClientStatementRead(
  documentId: string,
  onProgress: (label: string) => void,
  token: CancelToken,
): Promise<StatementExtraction> {
  onProgress('Preparing…');
  await api.beginStatementPages(documentId);
  try {
    checkCancelled(token, documentId);
    const res = await fetch(api.documentDownloadUrl(documentId));
    if (!res.ok) throw new Error('Could not download the statement from the vault.');
    const bytes = await res.arrayBuffer();
    checkCancelled(token, documentId);

    const extracted = await extractStatementPages(bytes, onProgress, token, documentId);
    if (extracted.pages.length === 0) {
      throw new Error('No readable pages were found in this PDF.');
    }

    const rows: unknown[] = [];
    let truncated = extracted.truncated;
    for (const round of chunkPages(extracted.pages)) {
      checkCancelled(token, documentId);
      onProgress(
        pagesProgressLabel(
          round[0].index + 1,
          round[round.length - 1].index + 1,
          extracted.pages[extracted.pages.length - 1].index + 1,
        ),
      );
      try {
        const out = await roundWithRetry(documentId, round, token);
        rows.push(...out.rows);
        if (out.truncated) truncated = true;
      } catch (err) {
        if (err instanceof ClientReadCancelled) throw err;
        // This round's pages are skipped — the read continues and finalize
        // reports the hole loudly instead of hiding it.
        truncated = true;
      }
    }

    checkCancelled(token, documentId);
    onProgress('Finishing…');
    return await api.finalizeStatementPages(documentId, { rows, truncated });
  } catch (err) {
    if (!(err instanceof ClientReadCancelled)) {
      // The claim must not linger behind a read that died before finalize.
      void api.abortStatementPages(documentId).catch(() => undefined);
    }
    throw err;
  }
}
