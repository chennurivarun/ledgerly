// Synthetic Kotak-layout statement generator (tests only).
//
// Renders per-page plain text that matches
// shared/packs/packs/in-kotak-savings.ts's grammar EXACTLY, from a list of
// seed transactions. Every string here is invented — no real statement
// content, no real account data, ever (docs/PACKS.md: packs are layout
// knowledge, not customer knowledge — fixtures follow the same rule). The
// MICR/IFSC line below uses only zero-padded placeholder digits and the
// bank's public IFSC prefix, not any real account's data.
import type { TxType } from '../../shared/types';

const GAP = '   '; // 3-space column gap, matching the reference pack's layout.

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const ACCOUNT_STATEMENT_LINE = 'Account Statement';
const MICR_LINE = 'MICR   500000000   IFSC Code   KKBK0000000';
const SECTION_TITLE = 'Savings Account Transactions';
const HEADER_LINE =
  '#   Date   Description   Chq/Ref. No.   Withdrawal (Dr.)   Deposit (Cr.)   Balance';

export type RowLayout = 'single' | 'wrapped' | 'wrapped-mid-token';

/** How many physical lines each layout occupies — exported so tests can
 * compute exact `breakAfterLines` offsets without re-deriving these. */
export const LAYOUT_LINE_COUNTS: Readonly<Record<RowLayout, number>> = {
  single: 1,
  wrapped: 3,
  'wrapped-mid-token': 2,
};

export interface SyntheticRow {
  /** 'dd MMM yyyy' display form (2-digit day, exact-case 3-letter month —
   * e.g. "05 Aug 2026"), or an ISO 'yyyy-MM-dd' string (converted for you). */
  date: string;
  /** Single spaces only between words — 2+ spaces are a column gap to the
   * grammar, not description content. 'wrapped' needs >= 2 words (it splits
   * on a word boundary); 'wrapped-mid-token' needs a last word >= 2 chars
   * (it splits inside that word, mirroring a real mid-reference wrap). */
  description: string;
  /** Positive magnitude. */
  amount: number;
  type: TxType;
  /** Default 'single'. */
  layout?: RowLayout;
}

export interface SyntheticStatementOptions {
  openingBalance: number;
  rows: SyntheticRow[];
  /** Default 'indian' (1,25,000.00). 'western' renders 125,000.00. */
  grouping?: 'indian' | 'western';
  /**
   * Force page breaks after these many cumulative transaction-table LINES
   * (1-based, the same numbering LAYOUT_LINE_COUNTS uses per row). Default:
   * everything on one page. A break offset landing INSIDE a wrapped row's
   * line run is exactly how a row-wraps-across-a-page-boundary fixture is
   * built — furniture (this page's footer, the next page's section title +
   * header) then interleaves the open row.
   */
  breakAfterLines?: number[];
}

function indianGroup(intPart: string): string {
  if (intPart.length <= 3) return intPart;
  let rest = intPart.slice(0, -3);
  const last3 = intPart.slice(-3);
  const groups: string[] = [];
  while (rest.length > 2) {
    groups.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest.length > 0) groups.unshift(rest);
  return `${groups.join(',')},${last3}`;
}

function westernGroup(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Integer cents -> the grammar's `[\d,]+\.\d{2}` shape, grouped. */
function formatCents(cents: number, grouping: 'indian' | 'western'): string {
  const whole = Math.floor(cents / 100).toString();
  const frac = String(cents % 100).padStart(2, '0');
  const groupedWhole = grouping === 'indian' ? indianGroup(whole) : westernGroup(whole);
  return `${groupedWhole}.${frac}`;
}

/** ISO 'yyyy-MM-dd' -> 'dd MMM yyyy'; any other input passes through
 * unchanged (assumed already 'dd MMM yyyy'). */
function toDisplayDate(input: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (!m) return input;
  const [, y, mm, d] = m;
  return `${d} ${MONTHS[Number(mm) - 1]} ${y}`;
}

/** Splits on a word boundary, roughly in half. Requires >= 2 words. */
function splitWordsInHalf(description: string): [string, string] {
  const words = description.split(' ');
  const mid = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
}

/** Splits INSIDE the last word (mirrors a real reference-number wrap, e.g.
 * "...Payment from Ph" / "one"). Requires a last word >= 2 chars. */
function splitMidToken(description: string): [string, string] {
  const lastSpace = description.lastIndexOf(' ');
  const head = lastSpace === -1 ? '' : description.slice(0, lastSpace + 1);
  const lastWord = lastSpace === -1 ? description : description.slice(lastSpace + 1);
  const cut = Math.max(1, Math.min(lastWord.length - 1, 2));
  return [`${head}${lastWord.slice(0, cut)}`, lastWord.slice(cut)];
}

function renderRowLines(
  serial: number,
  row: SyntheticRow,
  amountCents: number,
  balanceCents: number,
  grouping: 'indian' | 'western',
): string[] {
  const dateStr = toDisplayDate(row.date);
  const amountStr = formatCents(amountCents, grouping);
  const balanceStr = formatCents(balanceCents, grouping);
  const layout = row.layout ?? 'single';
  const prefix = `${serial}${GAP}${dateStr}${GAP}`;

  if (layout === 'single') {
    return [`${prefix}${row.description}${GAP}${amountStr}${GAP}${balanceStr}`];
  }
  if (layout === 'wrapped') {
    const [part1, part2] = splitWordsInHalf(row.description);
    return [`${prefix}${part1}`, part2, `${amountStr}${GAP}${balanceStr}`];
  }
  const [part1, part2] = splitMidToken(row.description);
  return [`${prefix}${part1}`, `${part2}${GAP}${amountStr}${GAP}${balanceStr}`];
}

function footerLine(pageNum: number, totalPages: number): string {
  // Content is unchecked beyond the furniture regex's literal prefix — any
  // synthetic date/time is fine.
  return `Statement Generated on 01 Jan 2000, 00:00${GAP}Page ${pageNum} of ${totalPages}`;
}

/** Renders a full synthetic statement as per-page plain text, in the exact
 * shape shared/packs/packs/in-kotak-savings.ts expects. */
export function generateSyntheticStatement(opts: SyntheticStatementOptions): string[] {
  const grouping = opts.grouping ?? 'indian';
  const breakAfterLines = new Set(opts.breakAfterLines ?? []);

  // 1. Render every row's lines up front, tracking the running balance.
  let runningCents = Math.round(opts.openingBalance * 100);
  const allLines: string[] = [];
  opts.rows.forEach((row, idx) => {
    const amountCents = Math.round(row.amount * 100);
    runningCents = row.type === 'expense' ? runningCents - amountCents : runningCents + amountCents;
    allLines.push(...renderRowLines(idx + 1, row, amountCents, runningCents, grouping));
  });

  // 2. Paginate the transaction-line stream at the requested offsets.
  const pageLineGroups: string[][] = [];
  let current: string[] = [];
  allLines.forEach((line, i) => {
    current.push(line);
    if (breakAfterLines.has(i + 1)) {
      pageLineGroups.push(current);
      current = [];
    }
  });
  if (current.length > 0 || pageLineGroups.length === 0) pageLineGroups.push(current);

  // 3. Wrap each page's transaction lines in the surrounding furniture.
  const totalPages = pageLineGroups.length;
  const openingBalanceLine = `-${GAP}-${GAP}Opening Balance${GAP}-${GAP}-${GAP}-${GAP}${formatCents(
    Math.round(opts.openingBalance * 100),
    grouping,
  )}`;

  return pageLineGroups.map((lines, i) => {
    const pageNum = i + 1;
    const header =
      pageNum === 1
        ? [ACCOUNT_STATEMENT_LINE, MICR_LINE, SECTION_TITLE, HEADER_LINE, openingBalanceLine]
        : [SECTION_TITLE, HEADER_LINE];
    return [...header, ...lines, footerLine(pageNum, totalPages)].join('\n');
  });
}
