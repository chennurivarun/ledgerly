// Browser-extracted statement pages → raw rows, over the custom endpoint
// (sprint 16). The client's browser did the PDF work (text layer, or a
// rendered page image); this module owns everything model-shaped about one
// ROUND: validating the page payload, building the two message shapes (one
// text call for the text pages, one vision call for the image pages), calling
// the endpoint through runCustomChat, and reading rows back out of whatever
// the model answered. Nothing here persists — finalize owns normalization and
// D1 (worker/statements.ts), and everything returned is still raw model
// output the normalize pipeline re-checks.
import {
  CLIENT_STATEMENT_PAGES_PER_ROUND,
  STATEMENT_PAGE_IMAGE_MAX_BYTES,
  STATEMENT_PAGE_TEXT_MAX_CHARS,
  type StatementPageInput,
  type StatementPagesRoundResult,
} from '../../shared/types';
import { ApiFail, isRecord } from '../util';
import {
  runCustomChat,
  UNREADABLE_RESPONSE,
  visionMessages,
  type ChatMessage,
  type CustomDeps,
  type CustomEndpointConfig,
} from './custom';
import { parseModelJson, readRowsArray, salvageStatementRows } from './normalize';
import { buildStatementSystemPrompt, STATEMENT_USER_INSTRUCTION } from './prompt';

// ---------------------------------------------------------------------------
// Payload validation — readable 400s naming the page. The client is the
// user's own browser, but a cap is a cap: one round stays small enough that
// every request is short and free-plan safe.
// ---------------------------------------------------------------------------

/** Image pages must be data URIs the endpoint can read without fetching. */
const IMAGE_DATA_URI = /^data:image\/(?:jpeg|png);base64,/;

/**
 * The `pages` array out of a round body, fully validated — or a 400 that
 * names exactly which page broke which rule.
 */
export function validateRoundPages(body: unknown): StatementPageInput[] {
  if (!isRecord(body) || !Array.isArray(body.pages)) {
    throw new ApiFail(400, 'Send the pages for this round.');
  }
  const list = body.pages;
  if (list.length === 0) throw new ApiFail(400, 'Send at least one page.');
  if (list.length > CLIENT_STATEMENT_PAGES_PER_ROUND) {
    throw new ApiFail(400, `Send at most ${CLIENT_STATEMENT_PAGES_PER_ROUND} pages per round.`);
  }

  const seen = new Set<number>();
  return list.map((raw, i) => {
    const label = `Page ${i + 1}`;
    if (!isRecord(raw)) throw new ApiFail(400, `${label}: expected an object.`);
    const index = raw.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      throw new ApiFail(400, `${label}: index must be a non-negative integer.`);
    }
    if (seen.has(index)) throw new ApiFail(400, `${label}: page index ${index} was sent twice.`);
    seen.add(index);
    const kind = raw.kind;
    if (kind !== 'text' && kind !== 'image') {
      throw new ApiFail(400, `${label}: kind must be 'text' or 'image'.`);
    }
    const content = raw.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new ApiFail(400, `${label}: content must be a non-empty string.`);
    }
    if (kind === 'text' && content.length > STATEMENT_PAGE_TEXT_MAX_CHARS) {
      throw new ApiFail(
        400,
        `${label}: text is longer than ${STATEMENT_PAGE_TEXT_MAX_CHARS} characters.`,
      );
    }
    if (kind === 'image') {
      if (!IMAGE_DATA_URI.test(content)) {
        throw new ApiFail(400, `${label}: image must be a base64 JPEG or PNG data URI.`);
      }
      if (content.length > STATEMENT_PAGE_IMAGE_MAX_BYTES) {
        throw new ApiFail(400, `${label}: image is larger than 2 MB.`);
      }
    }
    return { index, kind, content };
  });
}

// ---------------------------------------------------------------------------
// Message building. The custom endpoint has no structured-output contract
// (worker/ai/custom.ts explains why), so the rows shape the schema-constrained
// providers get from STATEMENT_SCHEMA is spelled out in words here — the same
// fields, the same envelope, and the salvage+normalize pipeline still treats
// whatever comes back as suspect.
// ---------------------------------------------------------------------------

/** The STATEMENT_SCHEMA envelope, in words a schema-less endpoint can follow. */
export const STATEMENT_ROWS_SHAPE_INSTRUCTION =
  'Respond with a single JSON object shaped {"rows": [...]}: one entry per transaction row, each ' +
  '{"date": {"value": "YYYY-MM-DD" or null, "confidence": 0 to 1}, ' +
  '"merchant": {"value": string or null, "confidence": 0 to 1}, ' +
  '"amount": {"value": positive number or null, "confidence": 0 to 1}, ' +
  '"type": {"value": "expense" or "income" or null, "confidence": 0 to 1}, ' +
  '"category": {"value": string or null, "confidence": 0 to 1}}.';

/** "pages 3–7" / "page 3" — 1-based, for the model's benefit and nobody else's. */
function pageSpan(pages: readonly StatementPageInput[]): string {
  const first = pages[0].index + 1;
  const last = pages[pages.length - 1].index + 1;
  return first === last ? `page ${first}` : `pages ${first}–${last}`;
}

/**
 * One text-model call for a round's text pages: the statement system prompt,
 * then a single user turn carrying every page's extracted text in page order,
 * delimited per page so the model knows where one page ends.
 */
export function buildTextRoundMessages(
  pages: readonly StatementPageInput[],
  categories: readonly string[],
): ChatMessage[] {
  const sections = pages
    .map((p) => `--- Page ${p.index + 1} ---\n${p.content}`)
    .join('\n\n');
  return [
    { role: 'system', content: buildStatementSystemPrompt(categories) },
    {
      role: 'user',
      content:
        `The following is the extracted text of ${pageSpan(pages)} of a bank statement, ` +
        'one section per page.\n\n' +
        `${sections}\n\n` +
        `${STATEMENT_USER_INSTRUCTION} ${STATEMENT_ROWS_SHAPE_INSTRUCTION}`,
    },
  ];
}

/**
 * One vision call for a round's image pages: the same system prompt, every
 * page image in page order on a single user turn (the S15 visionMessages
 * seam, built for exactly this), instruction last.
 */
export function buildImageRoundMessages(
  pages: readonly StatementPageInput[],
  categories: readonly string[],
): ChatMessage[] {
  return visionMessages(
    pages.map((p) => p.content),
    buildStatementSystemPrompt(categories),
    `These images are ${pageSpan(pages)} of a bank statement, in order. ` +
      `${STATEMENT_USER_INSTRUCTION} ${STATEMENT_ROWS_SHAPE_INSTRUCTION}`,
  );
}

/**
 * Rows out of one model answer — the statement.ts idiom: parse, else salvage
 * the complete rows from a response that stopped mid-JSON (salvage means rows
 * may be missing, which the round reports loudly), else refuse readably.
 */
function rowsFromAnswer(text: string): { rows: unknown[]; salvaged: boolean } {
  const rows = readRowsArray(parseModelJson(text));
  if (rows !== null) return { rows, salvaged: false };
  const salvaged = salvageStatementRows(text);
  if (salvaged.length > 0) return { rows: salvaged, salvaged: true };
  throw new Error(UNREADABLE_RESPONSE);
}

/**
 * Run one round: the text pages grouped into ONE text call, the image pages
 * into ONE vision call — never more than two requests, whatever mix arrived.
 * Group results concatenate in first-page order so a mixed round's rows still
 * read top-to-bottom. Any model/config failure throws its readable error and
 * the whole round is retryable client-side — no partial round results, so a
 * retry can never double rows.
 */
export async function runStatementPagesRound(
  cfg: CustomEndpointConfig,
  pages: readonly StatementPageInput[],
  categories: readonly string[],
  deps: CustomDeps = {},
): Promise<StatementPagesRoundResult> {
  const sorted = [...pages].sort((a, b) => a.index - b.index);
  const text = sorted.filter((p) => p.kind === 'text');
  const images = sorted.filter((p) => p.kind === 'image');

  const groups = [
    { pages: text, build: buildTextRoundMessages },
    { pages: images, build: buildImageRoundMessages },
  ]
    .filter((g) => g.pages.length > 0)
    .sort((a, b) => a.pages[0].index - b.pages[0].index);

  const rows: unknown[] = [];
  let truncated = false;
  for (const group of groups) {
    const answer = await runCustomChat(cfg, group.build(group.pages, categories), deps);
    const read = rowsFromAnswer(answer);
    rows.push(...read.rows);
    if (read.salvaged) truncated = true;
  }
  return { rows, truncated };
}
