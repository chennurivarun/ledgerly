// Pack distillation (sprint 19) — S19 contract stubs, frozen by the EM.
// Lane A replaces every body; SIGNATURES and types are the cross-lane
// contract and do not move without an EM ruling.
//
// Distillation turns ONE successful AI read into layout knowledge: given a
// statement's per-page text and the rows the user CONFIRMED in review, infer
// a draft StatementPack — then prove it, by running the REAL S18 engine on
// the same pages and requiring a verified parse that matches the anchors.
// The engine is the oracle: a draft that does not fully verify against the
// very statement it came from is refused, never returned. Every regex the
// distiller emits comes from fixed structural templates or from repeated
// LAYOUT lines, generalized (money tokens, ALL digit runs, month
// abbreviations, column gaps -> pattern classes). `reason` strings are
// structural only, same contract as the engine's.
//
// Privacy is LAYERED, not a single guarantee (post-review, see
// docs/PACKS.md's Distillation section for the full account): generalization
// alone cannot tell a genuine column header from a person's name that
// happens to repeat identically across pages — repetition proves nothing
// about layout vs. content. A pure-word repeated line is excluded outright
// (hasStructuralShape); the balance-chain seed additionally passes through
// a small vocabulary allow-list (BALANCE_LABEL_VOCABULARY) and can never be
// transaction-shaped itself. What's left after those gates still isn't
// blindly trusted: every successful result carries `reviewables` — the
// literal words that survived into the pack — for a human to confirm before
// the pack ships. That confirmation step is load-bearing, not decorative.
import type { TxType } from '../types';
import type { PackDateFormat, PackRow, PackTableGrammar, PackVerification, StatementPack } from './spec';
import { STATEMENT_PACK_SPEC } from './spec';
import { parseStatement, validatePack } from './engine';

/** One user-confirmed row, used as an inference anchor. Merchant text is
 * deliberately absent — review-time cleaning means it no longer matches the
 * printed descriptor; dates + amounts + directions are the stable truth. */
export interface DistillAnchor {
  /** ISO YYYY-MM-DD. */
  date: string;
  /** Positive magnitude. */
  amount: number;
  type: TxType;
}

/** Identity the UI collects — a distiller cannot know what to call a bank. */
export interface DistillIdentity {
  /** Must satisfy the spec id shape ^[a-z]{2}\.[a-z0-9-]+\.[a-z0-9-]+$. */
  id: string;
  /** Human name ("My Bank — Savings"). */
  name: string;
  /** ISO 3166-1 alpha-2, lowercase. */
  country: string;
  /** ISO 4217. */
  currency: string;
}

export type DistillResult =
  | {
      ok: true;
      pack: StatementPack;
      /** The proof the draft earned: the engine's verified row count on
       * these pages, and how many anchors matched a parsed row exactly. */
      proof: { rows: number; anchorsMatched: number; anchorsTotal: number };
      /**
       * EM-authorized S19 contract amendment (post-review, additive):
       * every literal alphabetic run of length >=2 that survives into ANY
       * of the pack's regexes (headerLine / furniture / signature /
       * openingBalanceLine — rowStart/rowTail never carry statement text),
       * deduplicated by text and tagged with the field it sits in. The
       * machine cannot tell a layout label ("Balance", "Opening") from a
       * person's name that happened to pass every structural gate —
       * `reviewables` is the last line of defense: a human confirms the
       * survivors before the pack ships. Empty when nothing survived. */
      reviewables: { field: string; literalText: string }[];
    }
  | { ok: false; reason: string };

/** Anchors below this count refuse outright — inference needs ground truth. */
export const DISTILL_MIN_ANCHORS = 3;

/** Of the anchors given, at least this fraction must match a parsed row
 * (user edits in review legitimately diverge from the printed truth, so a
 * perfect match is not required — but a majority is). Also reused, at the
 * same ratio, for every other "≥60%" structural threshold the algorithm
 * below needs (date-format winner, repeated-line detection) — one pinned
 * number, not several independent magic constants. */
export const DISTILL_MIN_ANCHOR_MATCH = 0.6;

/** The only words a balance-chain seed line is allowed to carry (case-
 * insensitive) once its money tokens are removed and it's generalized —
 * layout labels a "Brought Forward" / "Opening Balance" style line
 * legitimately prints. Anything else surviving there is presumed to be
 * statement content (a merchant name, a note) and refuses the seed rather
 * than risk shipping it. A PR can grow this list. */
export const BALANCE_LABEL_VOCABULARY = [
  'Opening',
  'Balance',
  'Brought',
  'Forward',
  'Carried',
  'Previous',
  'Statement',
  'Total',
  'B/F',
  'C/F',
] as const;

// ---------------------------------------------------------------------------
// Small local helpers. shared/packs/engine.ts doesn't export its internal
// regexes/parsers (only validatePack/detectPack/parseStatement/
// toStatementRowInputs are public), so the handful this module needs are
// redeclared here rather than reached into across the module boundary —
// same pattern engine.ts itself uses for worker/util.ts.
// ---------------------------------------------------------------------------

const ID_RE = /^[a-z]{2}\.[a-z0-9-]+\.[a-z0-9-]+$/;
const COUNTRY_RE = /^[a-z]{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

function identityValid(identity: DistillIdentity): boolean {
  return (
    typeof identity.id === 'string' &&
    ID_RE.test(identity.id) &&
    typeof identity.country === 'string' &&
    COUNTRY_RE.test(identity.country) &&
    typeof identity.currency === 'string' &&
    CURRENCY_RE.test(identity.currency) &&
    typeof identity.name === 'string' &&
    identity.name.trim() !== ''
  );
}

const MONTHS_3LETTER = [
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
] as const;

const DATE_FORMATS: readonly PackDateFormat[] = [
  'dd MMM yyyy',
  'dd/MM/yyyy',
  'dd-MM-yyyy',
  'MM/dd/yyyy',
  'yyyy-MM-dd',
];

/** Fixed per-format date sub-pattern table (Stage 4's "FIXED TEMPLATES
 * ONLY" rule) — never built from statement text. */
const DATE_SUBPATTERN: Readonly<Record<PackDateFormat, string>> = {
  'dd MMM yyyy': '\\d{2} [A-Z][a-z]{2} \\d{4}',
  'dd/MM/yyyy': '\\d{2}/\\d{2}/\\d{4}',
  'dd-MM-yyyy': '\\d{2}-\\d{2}-\\d{4}',
  'MM/dd/yyyy': '\\d{2}/\\d{2}/\\d{4}',
  'yyyy-MM-dd': '\\d{4}-\\d{2}-\\d{2}',
};

/** The fixed S18 Kotak-shape row tail — every distilled v1 pack uses this
 * verbatim (spec 1 only ever defines this one shape). */
const ROW_TAIL = '(?:^|\\s)(?<amount>[\\d,]+\\.\\d{2})\\s{2,}(?<balance>[\\d,]+\\.\\d{2})\\s*$';

/** ISO 'yyyy-MM-dd' -> the literal rendering a statement would show under
 * `format`, exact-case for the MMM form. */
function renderDate(iso: string, format: PackDateFormat): string {
  const yyyy = iso.slice(0, 4);
  const mm = iso.slice(5, 7);
  const dd = iso.slice(8, 10);
  const month0 = Number(mm) - 1;
  switch (format) {
    case 'dd MMM yyyy':
      return `${dd} ${MONTHS_3LETTER[month0]} ${yyyy}`;
    case 'dd/MM/yyyy':
      return `${dd}/${mm}/${yyyy}`;
    case 'dd-MM-yyyy':
      return `${dd}-${mm}-${yyyy}`;
    case 'MM/dd/yyyy':
      return `${mm}/${dd}/${yyyy}`;
    case 'yyyy-MM-dd':
      return `${yyyy}-${mm}-${dd}`;
  }
}

function escapeRegexLiteral(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches an English 3-letter month abbreviation only as a whole token —
 * not as a prefix of a longer word (so "Jan" generalizes but "Jane" or
 * "January" don't get truncated mid-word). */
const MONTH_ABBR_RE = /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?![A-Za-z])/;

/** These are the fixed template substrings `generalizeLine` itself emits —
 * never statement content. Used by `extractLiteralAlphaRuns` (the
 * `reviewables` scan, below) to tell "our own regex syntax" apart from
 * "text that survived generalization". Order doesn't matter: none is a
 * substring of another, and none can appear inside escaped literal text
 * (escapeRegexLiteral never emits a bare, unescaped backslash pairing). */
const GENERALIZATION_TEMPLATE_TOKENS = ['[\\d,]+\\.\\d{2}', '\\d+', '\\s{2,}', '[A-Z][a-z]{2}'] as const;

/**
 * PRIVACY-CRITICAL generalization (spec: header/furniture/openingBalance/
 * signature alike, post-review STRENGTHENED): escape the line literally
 * except every money token -> `[\d,]+\.\d{2}`, every English month
 * abbreviation -> `[A-Z][a-z]{2}`, every run of digits (ANY length, not
 * just 5+ — a 2-digit day or a 4-digit year must die here too) -> `\d+`,
 * and runs of 2+ spaces -> `\s{2,}`; anchored with `^`. When `target` is
 * given, the FIRST occurrence of that exact money-token substring
 * (left-boundary checked so it can't be a partial match inside a longer
 * digit run) becomes a named group instead of the generic money class —
 * this is how openingBalanceLine's `balance` group is produced.
 *
 * This alone is NOT the privacy boundary — see docs/PACKS.md's
 * Distillation section for the full layered model (structural exclusion of
 * pure-word repeats, the balance-label vocabulary gate, and `reviewables`
 * as the human-in-the-loop backstop). Generalization only guarantees that
 * DATES and MONEY VALUES can't survive; arbitrary literal words (a name, a
 * note) survive it just fine when nothing else excludes the line.
 */
function generalizeLine(line: string, target?: { value: string; name: string }): string {
  let out = '';
  let i = 0;
  let namedUsed = false;
  while (i < line.length) {
    if (
      target &&
      !namedUsed &&
      line.startsWith(target.value, i) &&
      (i === 0 || !/[\d,]/.test(line[i - 1]))
    ) {
      out += `(?<${target.name}>[\\d,]+\\.\\d{2})`;
      i += target.value.length;
      namedUsed = true;
      continue;
    }
    const rest = line.slice(i);
    const money = /^[\d,]+\.\d{2}/.exec(rest);
    if (money) {
      out += '[\\d,]+\\.\\d{2}';
      i += money[0].length;
      continue;
    }
    const month = MONTH_ABBR_RE.exec(rest);
    if (month) {
      out += '[A-Z][a-z]{2}';
      i += month[0].length;
      continue;
    }
    const digits = /^\d+/.exec(rest);
    if (digits) {
      out += '\\d+';
      i += digits[0].length;
      continue;
    }
    const spaces = /^ {2,}/.exec(rest);
    if (spaces) {
      out += '\\s{2,}';
      i += spaces[0].length;
      continue;
    }
    out += escapeRegexLiteral(line[i]);
    i += 1;
  }
  return `^${out}`;
}

/** True when a generalized pattern carries at least one digit-run, money,
 * or column-gap class — i.e. it has SOME structural shape beyond bare
 * words. A pure-word line (a name, a title) never matches this: post-review
 * fix for the repeated-personal-line critical — such lines are excluded
 * outright from furniture and the signature-extra slot, since they're
 * cosmetic for parsing (the oracle's chains never depend on them) but a
 * real privacy risk when they happen to repeat across pages.
 *
 * The candidate ALSO needs at least one literal word (EM integration fix,
 * S19 merge): a pattern that is ONLY classes and gaps — the generalized
 * form of a wrapped row's own `<amount>  <balance>` continuation line — is
 * indistinguishable across every such row, so with enough wrapped rows it
 * "repeats" its way into furniture and then breaks every wrapped row's
 * tail-close (the engine skips furniture even mid-row). Real layout
 * furniture always carries a label word; a line with structure but no
 * words is a row fragment, never furniture. */
function hasStructuralShape(pattern: string): boolean {
  return (
    GENERALIZATION_TEMPLATE_TOKENS.some((token) => pattern.includes(token)) &&
    extractLiteralAlphaRuns(pattern).length > 0
  );
}

/** The literal alphabetic runs (length >=2) that survive in a generated
 * regex SOURCE string, once our own template syntax — named-group opens
 * and the fixed class tokens above — is stripped out. What's left is, by
 * construction, statement text that made it through generalization: this
 * is the `reviewables` scan. */
function extractLiteralAlphaRuns(patternSource: string): string[] {
  let stripped = patternSource.replace(/\(\?<[A-Za-z_$][\w$]*>/g, '');
  for (const token of GENERALIZATION_TEMPLATE_TOKENS) {
    stripped = stripped.split(token).join('');
  }
  return stripped.match(/[A-Za-z]{2,}/g) ?? [];
}

/** The `reviewables` a distilled pack ships with: every literal alphabetic
 * run that survived into headerLine / furniture / signature /
 * openingBalanceLine, deduplicated by text (first field it's seen in wins
 * the attribution), in that fixed field-scan order for determinism.
 * rowStart/rowTail are fixed templates — never scanned, never a source of
 * statement content. */
function collectReviewables(pack: StatementPack): { field: string; literalText: string }[] {
  const seen = new Set<string>();
  const out: { field: string; literalText: string }[] = [];
  const scan = (field: string, source: string) => {
    for (const run of extractLiteralAlphaRuns(source)) {
      if (seen.has(run)) continue;
      seen.add(run);
      out.push({ field, literalText: run });
    }
  };
  scan('headerLine', pack.table.headerLine);
  for (const f of pack.table.furniture) scan('furniture', f);
  for (const s of pack.signature) scan('signature', s);
  if (pack.table.openingBalanceLine) scan('openingBalanceLine', pack.table.openingBalanceLine);
  return out;
}

// ---------------------------------------------------------------------------
// Flattened page/line model shared by stages 2-4.
// ---------------------------------------------------------------------------

interface FlatLine {
  page: number;
  line: number;
  globalIdx: number;
  text: string;
}

function flattenPages(pages: readonly string[]): FlatLine[] {
  const out: FlatLine[] = [];
  let g = 0;
  pages.forEach((pageText, p) => {
    pageText.split('\n').forEach((text, l) => {
      out.push({ page: p, line: l, globalIdx: g, text });
      g += 1;
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Stage 1 — date format.
// ---------------------------------------------------------------------------

type DateFormatResult =
  | { ok: true; format: PackDateFormat; matchedAnchors: DistillAnchor[] }
  | { ok: false; reason: 'none' | 'ambiguous' };

function detectDateFormat(pages: readonly string[], anchors: readonly DistillAnchor[]): DateFormatResult {
  const scored = DATE_FORMATS.map((format) => {
    const matched = anchors.filter((a) => {
      const rendering = renderDate(a.date, format);
      return pages.some((p) => p.includes(rendering));
    });
    return { format, matched };
  });
  const passing = scored.filter((s) => s.matched.length / anchors.length >= DISTILL_MIN_ANCHOR_MATCH);
  if (passing.length === 0) return { ok: false, reason: 'none' };
  const maxCount = Math.max(...passing.map((s) => s.matched.length));
  const winners = passing.filter((s) => s.matched.length === maxCount);
  if (winners.length > 1) return { ok: false, reason: 'ambiguous' };
  return { ok: true, format: winners[0].format, matchedAnchors: winners[0].matched };
}

/** At least one `\d{2}/\d{2}/\d{4}`-shaped token anywhere in the pages
 * whose day-position component (per `format`'s chirality) is >12 — a value
 * only valid as a day, never as a month, so it disambiguates dd/MM from
 * MM/dd independent of which anchors were given. */
function hasTranspositionCorroboration(
  pages: readonly string[],
  format: 'dd/MM/yyyy' | 'MM/dd/yyyy',
): boolean {
  const re = /\d{2}\/\d{2}\/\d{4}/g;
  const dayIndex = format === 'dd/MM/yyyy' ? 0 : 1;
  for (const page of pages) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(page))) {
      const parts = m[0].split('/');
      if (Number.parseInt(parts[dayIndex], 10) > 12) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Stage 2 — row anchoring (candidates + serial detection).
// ---------------------------------------------------------------------------

interface RowCandidate {
  globalIdx: number;
  page: number;
  line: number;
  text: string;
  isoDate: string;
  hasSerialPrefix: boolean;
}

function findRowStartCandidates(
  flat: readonly FlatLine[],
  matchedAnchors: readonly DistillAnchor[],
  format: PackDateFormat,
): RowCandidate[] {
  const renderingByIso = new Map<string, string>();
  for (const a of matchedAnchors) {
    if (!renderingByIso.has(a.date)) renderingByIso.set(a.date, renderDate(a.date, format));
  }
  const renderings = [...renderingByIso.entries()];
  const candidates: RowCandidate[] = [];
  for (const fl of flat) {
    for (const [iso, rendering] of renderings) {
      const idx = fl.text.indexOf(rendering);
      if (idx !== -1) {
        const prefix = fl.text.slice(0, idx);
        candidates.push({
          globalIdx: fl.globalIdx,
          page: fl.page,
          line: fl.line,
          text: fl.text,
          isoDate: iso,
          hasSerialPrefix: /^\d+\s{2,}$/.test(prefix),
        });
        break;
      }
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Stage 3 — tail & balance detection.
// ---------------------------------------------------------------------------

const TAIL_RE = /(?:^|\s)([\d,]+\.\d{2})\s{2,}([\d,]+\.\d{2})\s*$/;

interface TailInfo {
  amountRaw: string;
  balanceRaw: string;
}

function findTailForCandidate(flat: readonly FlatLine[], candidate: RowCandidate, windowSize = 4): TailInfo | null {
  for (let g = candidate.globalIdx; g < Math.min(flat.length, candidate.globalIdx + windowSize); g++) {
    const text = flat[g].text;
    const m = TAIL_RE.exec(text);
    if (m && m.index + m[0].length === text.length) {
      return { amountRaw: m[1], balanceRaw: m[2] };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stage 4 — grammar assembly: header/furniture/signature via repeated,
// generalized lines.
// ---------------------------------------------------------------------------

interface PatternInfo {
  refs: FlatLine[];
  pages: Set<number>;
}

function computeRepeatedPatterns(flat: readonly FlatLine[], totalPages: number): Map<string, PatternInfo> {
  const all = new Map<string, PatternInfo>();
  for (const fl of flat) {
    if (fl.text.trim() === '') continue;
    const pattern = generalizeLine(fl.text);
    let info = all.get(pattern);
    if (!info) {
      info = { refs: [], pages: new Set() };
      all.set(pattern, info);
    }
    info.refs.push(fl);
    info.pages.add(fl.page);
  }
  const repeated = new Map<string, PatternInfo>();
  for (const [pattern, info] of all) {
    if (info.pages.size / totalPages < DISTILL_MIN_ANCHOR_MATCH) continue;
    // A line ENDING in the row-tail shape can never be layout (real-data
    // fix, S19 merge, EM): wrapped rows' own `<ref>  <amount>  <balance>`
    // continuation lines generalize to ONE identical pattern that repeats
    // on every page exactly like furniture — and carries a word ("UPI"),
    // so a words-required gate alone doesn't stop it. If such a pattern
    // shipped as furniture (or header, or signature), the engine's
    // furniture-skip would swallow every tail before the close-check runs
    // and no wrapped row could ever close. Tail-matching lines are ROWS,
    // definitionally — exclude them from the layout-candidate space
    // entirely, at the one spot all three consumers share.
    if (info.refs.some((r) => {
      const m = TAIL_RE.exec(r.text);
      return m !== null && m.index + m[0].length === r.text.length;
    })) {
      continue;
    }
    repeated.set(pattern, info);
  }
  return repeated;
}

interface HeaderScore {
  pattern: string;
  pages: number;
  avgDist: number;
}

/** A real table header has at least two column gaps — one gap could be
 * coincidence (any two-word masthead line), but a header row's whole job is
 * separating columns. Required regardless of proximity ranking (post-review
 * fix: a repeated single-gap or no-gap line must never win the header
 * slot). Counts occurrences of the `\s{2,}` template token in the
 * generalized pattern. */
function hasHeaderShape(pattern: string): boolean {
  let count = 0;
  let idx = pattern.indexOf('\\s{2,}');
  while (idx !== -1) {
    count += 1;
    if (count >= 2) return true;
    idx = pattern.indexOf('\\s{2,}', idx + 1);
  }
  return false;
}

/** Ranks repeated patterns by how consistently they sit directly above the
 * first row-start candidate on a page — best (closest, most pages) first.
 * Only patterns with header shape (>=2 column gaps) are ranked at all. */
function rankHeaderCandidates(
  repeated: ReadonlyMap<string, PatternInfo>,
  firstRowLineByPage: ReadonlyMap<number, number>,
): HeaderScore[] {
  const scored: HeaderScore[] = [];
  for (const [pattern, info] of repeated) {
    if (!hasHeaderShape(pattern)) continue;
    const perPageBestDist = new Map<number, number>();
    for (const r of info.refs) {
      const firstRow = firstRowLineByPage.get(r.page);
      if (firstRow === undefined || !(r.line < firstRow)) continue;
      const dist = firstRow - r.line;
      const cur = perPageBestDist.get(r.page);
      if (cur === undefined || dist < cur) perPageBestDist.set(r.page, dist);
    }
    if (perPageBestDist.size === 0) continue;
    const totalDist = [...perPageBestDist.values()].reduce((a, b) => a + b, 0);
    scored.push({ pattern, pages: perPageBestDist.size, avgDist: totalDist / perPageBestDist.size });
  }
  scored.sort((a, b) => b.pages - a.pages || a.avgDist - b.avgDist || (a.pattern < b.pattern ? -1 : 1));
  return scored;
}

/** The one extra `signature` line beyond headerLine (post-review
 * REPLACEMENT of the old "contains real alphabetic content" heuristic,
 * which selected FOR the worst case — a repeated pure-word name line
 * clears that bar easily). The new rule: the candidate must pass
 * `hasStructuralShape` (excludes pure-word lines outright — same gate
 * furniture uses), must already be in `repeated` (>=60% of pages, by
 * construction of that map), and must not be page-1-only. No qualifying
 * candidate -> signature is the header line alone. */
function pickSignatureExtra(repeated: ReadonlyMap<string, PatternInfo>, headerPattern: string): string | null {
  const candidates = [...repeated.entries()]
    .filter(([pattern]) => pattern !== headerPattern && hasStructuralShape(pattern))
    .filter(([, info]) => [...info.pages].some((p) => p !== 0)) // not page-1-only
    .sort((a, b) => {
      if (b[1].pages.size !== a[1].pages.size) return b[1].pages.size - a[1].pages.size;
      const aMin = Math.min(...a[1].refs.map((r) => r.globalIdx));
      const bMin = Math.min(...b[1].refs.map((r) => r.globalIdx));
      return aMin - bMin;
    });
  return candidates.length > 0 ? candidates[0][0] : null;
}

// ---------------------------------------------------------------------------
// Stage 5 — assembly + the proof.
// ---------------------------------------------------------------------------

function buildRowStart(serial: boolean, format: PackDateFormat): string {
  const datePattern = DATE_SUBPATTERN[format];
  return serial
    ? `^(?<serial>\\d{1,5})\\s{2,}(?<date>${datePattern})\\s{2,}(?<rest>.*\\S)\\s*$`
    : `^(?<date>${datePattern})\\s{2,}(?<rest>.*\\S)\\s*$`;
}

/** The statement's TRUE first row-shaped line — using the already-assembled
 * generic template (format + serial presence), not the anchor-restricted
 * Stage 2 candidates. Anchors can start well into a statement; every row
 * before the first anchor still opens via this same generic pattern once
 * the real engine runs, so the balance-chain seed (below) must precede
 * THIS line, not just the first anchored one. */
function findGenericRowStartMatch(flat: readonly FlatLine[], rowStartRe: RegExp): FlatLine | null {
  for (const fl of flat) {
    if (rowStartRe.test(fl.text)) return fl;
  }
  return null;
}

/** Walking backward from `beforeGlobalIdx` (exclusive), the nearest line
 * carrying a `[\d,]+\.\d{2}` token, and that token itself (the LAST such
 * token on the line, matching the reference layout's "trailing balance"
 * convention). This is the balance-chain seed candidate. */
function findNearestMoneyToken(
  flat: readonly FlatLine[],
  beforeGlobalIdx: number,
): { ref: FlatLine; token: string } | null {
  const moneyRe = /[\d,]+\.\d{2}/g;
  for (let g = beforeGlobalIdx - 1; g >= 0; g--) {
    const text = flat[g].text;
    let m: RegExpExecArray | null;
    let last: string | null = null;
    moneyRe.lastIndex = 0;
    while ((m = moneyRe.exec(text))) last = m[0];
    if (last) return { ref: flat[g], token: last };
  }
  return null;
}

function buildPack(
  identity: DistillIdentity,
  format: PackDateFormat,
  serial: boolean,
  headerPattern: string,
  openingBalanceLinePattern: string,
  furniture: string[],
  signature: string[],
): StatementPack {
  const verify: PackVerification[] = serial ? ['serial-chain', 'balance-chain'] : ['balance-chain'];
  const table: PackTableGrammar = {
    headerLine: headerPattern,
    openingBalanceLine: openingBalanceLinePattern,
    rowStart: buildRowStart(serial, format),
    rowTail: ROW_TAIL,
    furniture,
  };
  return {
    spec: STATEMENT_PACK_SPEC,
    id: identity.id,
    name: identity.name,
    country: identity.country,
    currency: identity.currency,
    signature,
    dateFormat: format,
    direction: 'balance-delta',
    verify,
    table,
  };
}

function matchAnchors(rows: readonly PackRow[], anchors: readonly DistillAnchor[]): number {
  const used = new Array(rows.length).fill(false);
  let matched = 0;
  for (const a of anchors) {
    const wantCents = Math.round(a.amount * 100);
    const idx = rows.findIndex(
      (r, i) => !used[i] && r.date === a.date && r.type === a.type && Math.round(r.amount * 100) === wantCents,
    );
    if (idx !== -1) {
      used[idx] = true;
      matched += 1;
    }
  }
  return matched;
}

interface Attempt {
  serial: boolean;
  header: string;
  furniture: string[];
}

/** A SMALL bounded candidate space (serial on/off, furniture subsets,
 * alternate header pick). This construction yields at most 8 combinations
 * today; the `add()` guard additionally caps at 12 as a hard ceiling so the
 * space stays small even if more combinations are added later — comment
 * and guard describe the same number on purpose. */
function buildAttempts(
  baseSerial: boolean,
  headerPattern: string,
  altHeaderPattern: string | null,
  furnitureFull: string[],
): Attempt[] {
  const list: Attempt[] = [];
  const seen = new Set<string>();
  const add = (serial: boolean, header: string, furniture: string[]) => {
    if (list.length >= 12) return;
    const key = JSON.stringify([serial, header, furniture]);
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ serial, header, furniture });
  };
  add(baseSerial, headerPattern, furnitureFull);
  if (baseSerial) add(false, headerPattern, furnitureFull);
  for (let k = 1; k <= 4 && furnitureFull.length - k >= 0; k++) {
    add(baseSerial, headerPattern, furnitureFull.slice(0, furnitureFull.length - k));
  }
  if (altHeaderPattern) {
    add(baseSerial, altHeaderPattern, furnitureFull);
    if (baseSerial) add(false, altHeaderPattern, furnitureFull);
  }
  return list;
}

/**
 * Infer a draft pack from pages + anchors, prove it with the real engine,
 * and return it only when: validatePack passes, parseStatement fully
 * verifies on `pages`, at least DISTILL_MIN_ANCHORS anchors were given, and
 * anchorsMatched/anchorsTotal >= DISTILL_MIN_ANCHOR_MATCH. Never throws on
 * malformed input — refusal is the only error channel.
 */
export function distillStatementPack(
  pagesInput: readonly string[],
  anchors: readonly DistillAnchor[],
  identity: DistillIdentity,
): DistillResult {
  try {
    // CRLF/CR -> LF at the very entry, before anything reads a single
    // character: a stray \r pollutes generalized patterns (mixed or
    // consistent line endings across an extraction produce different
    // "repeated" strings for what's visually the same line) and, left
    // uncaught, can end up embedded literally in a rendered pack module —
    // a raw LineTerminator inside a single-quoted TS string is a syntax
    // error. Normalizing here means every stage downstream, INCLUDING the
    // Stage 5 oracle call, works over the same clean text.
    const pages = pagesInput.map((p) => p.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));

    // Stage 0 — gates.
    if (anchors.length < DISTILL_MIN_ANCHORS) {
      return { ok: false, reason: 'fewer than 3 confirmed rows to anchor on' };
    }
    for (let i = 0; i < pages.length; i++) {
      if (pages[i].trim() === '') return { ok: false, reason: `page ${i + 1} has no readable text` };
    }
    if (!identityValid(identity)) return { ok: false, reason: 'the pack identity is invalid' };
    // Every structural signal past this point (header, furniture, the
    // opening-balance seed) is found by REPETITION across pages — a single
    // page has nothing to repeat against, so distillation can't work yet.
    if (pages.length < 2) {
      return { ok: false, reason: 'a single-page statement cannot be distilled yet' };
    }

    const totalPages = pages.length;
    const flat = flattenPages(pages);

    // Stage 1 — date format.
    const dateResult = detectDateFormat(pages, anchors);
    if (!dateResult.ok) {
      return {
        ok: false,
        reason: dateResult.reason === 'ambiguous' ? 'date format is ambiguous' : 'no consistent date format found',
      };
    }
    const { format, matchedAnchors } = dateResult;

    // dd/MM/yyyy and MM/dd/yyyy share one digit shape (\d{2}/\d{2}/\d{4}) —
    // when every corroborating date has both components <=12, the whole
    // statement could in principle be re-read under the opposite chirality
    // without a single invalid calendar value appearing. Require at least
    // one date-shaped token ANYWHERE in the text (not just among anchors)
    // whose day-component, under the WINNING format, exceeds 12 — a value
    // that position could only hold under this chirality, never the other.
    if (format === 'dd/MM/yyyy' || format === 'MM/dd/yyyy') {
      if (!hasTranspositionCorroboration(pages, format)) {
        return { ok: false, reason: 'date format is ambiguous' };
      }
    }

    // Stage 2 — row anchoring.
    const rowStartCandidates = findRowStartCandidates(flat, matchedAnchors, format);
    if (rowStartCandidates.length === 0) {
      return { ok: false, reason: 'no consistent date format found' };
    }
    const serialPresent = rowStartCandidates.every((c) => c.hasSerialPrefix);

    // Stage 3 — tail & balance. An existence check only (the Stage 5 oracle
    // is what actually proves every row closes): ≥60% of candidate rows
    // must show the trailing `<amount>  <balance>` pair somewhere before
    // the NEXT candidate begins. Real-data fix (S19 merge, EM): the
    // original fixed 4-line window refused an entire 728-row statement over
    // ONE row whose reference token wrapped across five short fragment
    // lines — a row's tail can sit any number of wrap-lines down, bounded
    // only by where the next row starts; and one deviant row must cost at
    // most its own vote, never the whole distillation.
    let tailsFound = 0;
    for (let i = 0; i < rowStartCandidates.length; i++) {
      const c = rowStartCandidates[i];
      const nextStart = i + 1 < rowStartCandidates.length ? rowStartCandidates[i + 1].globalIdx : flat.length;
      if (findTailForCandidate(flat, c, Math.min(nextStart - c.globalIdx, 10))) tailsFound += 1;
    }
    if (tailsFound < rowStartCandidates.length * DISTILL_MIN_ANCHOR_MATCH) {
      return { ok: false, reason: 'no running balance column found — the v1 pack format needs one' };
    }

    // Stage 4 — grammar assembly.
    const firstRowLineByPage = new Map<number, number>();
    for (const c of rowStartCandidates) {
      const cur = firstRowLineByPage.get(c.page);
      if (cur === undefined || c.line < cur) firstRowLineByPage.set(c.page, c.line);
    }

    const repeated = computeRepeatedPatterns(flat, totalPages);
    const headerRanked = rankHeaderCandidates(repeated, firstRowLineByPage);
    if (headerRanked.length === 0) return { ok: false, reason: 'no repeating table header found' };
    const headerPattern = headerRanked[0].pattern;
    const altHeaderPattern = headerRanked.length > 1 ? headerRanked[1].pattern : null;

    // The balance chain seeds ONCE, before any row opens (engine.ts:
    // `!balanceSeeded` gates every rowStart match) — so the seed line must
    // precede the statement's TRUE first row, not just the first ANCHORED
    // one (anchors can start well into the statement; unanchored rows
    // before it still open via the generic template and need the same
    // seed). Find that true first row generically, then walk back to the
    // nearest line carrying a money token — the seed candidate, exactly
    // where a real "Opening Balance" furniture line (or, structurally
    // equivalently, nothing at all before row 1) would sit.
    const genericRowStartRe = new RegExp(buildRowStart(serialPresent, format));
    const trueFirstRow = findGenericRowStartMatch(flat, genericRowStartRe);
    if (!trueFirstRow) return { ok: false, reason: 'no opening balance line found' };
    const openingFound = findNearestMoneyToken(flat, trueFirstRow.globalIdx);
    if (!openingFound) return { ok: false, reason: 'no opening balance line found' };

    // Post-review layered fix for the seed-line leak: (b) a line that is
    // itself transaction-shaped can never be the seed — it would mean an
    // ordinary row's own content (merchant text, its own date) becomes the
    // "layout" pattern. (c) even a non-row-shaped line is only trustworthy
    // once its money token is set aside and everything else that survives
    // generalization is drawn from a small closed vocabulary of balance
    // labels — anything else (a name, a note, "REFUND") refuses rather
    // than risk shipping it.
    if (genericRowStartRe.test(openingFound.ref.text)) {
      return { ok: false, reason: 'no opening balance line found' };
    }
    const withoutMoney = openingFound.ref.text.replace(/[\d,]+\.\d{2}/g, ' ');
    const survivingWords = withoutMoney.match(/[A-Za-z]+(?:\/[A-Za-z]+)*/g) ?? [];
    const vocabulary = new Set(BALANCE_LABEL_VOCABULARY.map((w) => w.toLowerCase()));
    if (survivingWords.some((w) => !vocabulary.has(w.toLowerCase()))) {
      return { ok: false, reason: 'no opening balance line found' };
    }

    const openingBalanceLinePattern = generalizeLine(openingFound.ref.text, {
      value: openingFound.token,
      name: 'balance',
    });

    const furnitureFull = [...repeated.entries()]
      .filter(([pattern]) => pattern !== headerPattern && hasStructuralShape(pattern))
      .sort((a, b) => Math.min(...a[1].refs.map((r) => r.globalIdx)) - Math.min(...b[1].refs.map((r) => r.globalIdx)))
      .slice(0, 8)
      .map(([pattern]) => pattern);

    const signatureExtra = pickSignatureExtra(repeated, headerPattern);
    const signature = signatureExtra ? [headerPattern, signatureExtra] : [headerPattern];

    // Stage 5 — the proof.
    const attempts = buildAttempts(serialPresent, headerPattern, altHeaderPattern, furnitureFull);
    for (const attempt of attempts) {
      const pack = buildPack(
        identity,
        format,
        attempt.serial,
        attempt.header,
        openingBalanceLinePattern,
        attempt.furniture,
        signature,
      );
      if (validatePack(pack)) continue;
      const parsed = parseStatement(pack, pages);
      if (!parsed.ok) continue;
      const matched = matchAnchors(parsed.rows, anchors);
      if (matched / anchors.length >= DISTILL_MIN_ANCHOR_MATCH) {
        return {
          ok: true,
          pack,
          proof: { rows: parsed.rows.length, anchorsMatched: matched, anchorsTotal: anchors.length },
          reviewables: collectReviewables(pack),
        };
      }
    }
    return { ok: false, reason: 'the draft pack could not verify against this statement' };
  } catch {
    return { ok: false, reason: 'the draft pack could not verify against this statement' };
  }
}

// ---------------------------------------------------------------------------
// renderPackModule
// ---------------------------------------------------------------------------

/** camelCase the id's non-country segments: 'in.my-bank.savings' ->
 * 'inMyBankSavings'. The country segment (first, before the first '.')
 * stays as-is; every remaining hyphen-or-dot-separated word is
 * capitalized and concatenated. */
function camelCaseFromId(id: string): string {
  const segments = id.split('.');
  const country = segments[0] ?? '';
  const rest = segments.slice(1).join('-').split('-').filter(Boolean);
  const capitalized = rest.map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return [country, ...capitalized].join('');
}

/** Single-quoted TS string literal, safe for ANY input — including
 * identity fields (free text a user typed) and, post-review, any pattern
 * that survived page normalization with an embedded LineTerminator
 * anyway. A raw \n, \r, U+2028, or U+2029 inside a single-quoted JS/TS
 * string literal is a SYNTAX ERROR (only template literals allow them
 * unescaped), so all four are escaped alongside the backslash/quote pair —
 * this is what keeps the rendered module a compilable file rather than a
 * "usually works" one. */
function tsString(s: string): string {
  return `'${s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')}'`;
}

function serializeValue(value: unknown, indent: number): string {
  const pad = '  '.repeat(indent);
  const padInner = '  '.repeat(indent + 1);
  if (typeof value === 'string') return tsString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((v) => `${padInner}${serializeValue(v, indent + 1)}`).join(',\n');
    return `[\n${items},\n${pad}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const lines = entries.map(([k, v]) => `${padInner}${k}: ${serializeValue(v, indent + 1)}`).join(',\n');
    return `{\n${lines},\n${pad}}`;
  }
  return JSON.stringify(value);
}

/**
 * The downloadable pack module: a self-contained TypeScript file matching
 * the shipped packs' shape — SPDX CC0-1.0 header (pack DATA is public
 * domain, see shared/packs/packs/LICENSE), the StatementPack import, and
 * one exported const named from the pack id. This is the artifact a user
 * hands to the commons (S20 automates the PR).
 */
export function renderPackModule(pack: StatementPack): string {
  const exportName = camelCaseFromId(pack.id);
  const lines = [
    '// SPDX-License-Identifier: CC0-1.0',
    '// Pack data in this directory is dedicated to the public domain (CC0 1.0,',
    '// see shared/packs/packs/LICENSE); it contains layout knowledge only — no',
    '// statement content, ever. Generated by Ledgerly pack distillation.',
    "import type { StatementPack } from '../spec';",
    '',
    `export const ${exportName}: StatementPack = ${serializeValue(pack, 0)};`,
    '',
  ];
  return lines.join('\n');
}
