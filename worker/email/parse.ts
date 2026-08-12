// The deterministic alert parser — PURE. No D1, no R2, no network, no clock.
//
// This file is the community-extension point for the mail-in feed: a
// ParserPack turns one bank's alert wording into proposed transaction fields,
// and parseAlertEmail runs the registered packs in order, first match wins.
// The house rule applies with full force here because direction flips signs
// and an amount IS the ledger: a field the pack cannot establish unambiguously
// makes the whole email 'unparsed' (never-guess — the S4 statement sprint's
// critical was exactly a guessed `type`). An unparsed email is not a failure:
// the user still gets the row and fills the form themselves.
import { CURRENCY_CODES } from '../../shared/currencies';
import type { InboxParsedFields, TxType } from '../../shared/types';
import { isIsoDate } from '../util';

/**
 * One community parser pack. `parse` sees the subject and the plain-text body
 * and returns grounded fields, or null when this pack does not recognize the
 * email. Packs have no clock and usually no in-body date they can trust, so a
 * pack that cannot read a date returns `date: ''` and parseAlertEmail stamps
 * the email's own arrival date over it; a pack that CAN read an unambiguous
 * YYYY-MM-DD may set it and it is kept.
 */
export interface ParserPack {
  name: string;
  parse(subject: string, body: string): InboxParsedFields | null;
}

// ---------------------------------------------------------------------------
// Direction phrases (generic-en)
// ---------------------------------------------------------------------------

/**
 * A phrase that implies money moved in one direction. `prep: true` means the
 * phrase itself ends in a preposition, so the merchant follows it directly
 * ("payment to OAKWOOD…"); otherwise the merchant is looked up after the
 * phrase via a bare at|to|from ("spent $5 at STARBUCKS").
 *
 * Bare "transaction" is deliberately NOT a direction word — a "transaction
 * alert" subject implies nothing; only "transaction with/at" (a card
 * purchase) does.
 */
interface DirectionPhrase {
  re: RegExp;
  prep: boolean;
}

const EXPENSE_PHRASES: DirectionPhrase[] = [
  { re: /\btransactions? (?:with|at)\b/i, prep: true },
  { re: /\bpayments? to\b/i, prep: true },
  { re: /\bpurchases? (?:at|from)\b/i, prep: true },
  { re: /\bspent\b/i, prep: false },
  { re: /\bcharged\b/i, prep: false },
  { re: /\bpurchases?\b/i, prep: false },
  { re: /\bdebited\b/i, prep: false },
  { re: /\bwithdrawn\b/i, prep: false },
];

const INCOME_PHRASES: DirectionPhrase[] = [
  { re: /\bpayments? from\b/i, prep: true },
  { re: /\brefunds? from\b/i, prep: true },
  { re: /\breceived\b/i, prep: false },
  { re: /\bdeposited\b/i, prep: false },
  { re: /\bcredited\b/i, prep: false },
  { re: /\brefund(?:ed)?s?\b/i, prep: false },
];

/**
 * Direction is decided by unambiguous keyword presence. BOTH kinds present
 * ("your payment to ACME was received") or NEITHER → null. Direction flips
 * the sign of the amount; it is the one field a wrong guess corrupts silently,
 * so it is never inferred from anything softer than these phrases.
 */
function detectDirection(text: string): TxType | null {
  const expense = EXPENSE_PHRASES.some((p) => p.re.test(text));
  const income = INCOME_PHRASES.some((p) => p.re.test(text));
  if (expense === income) return null;
  return expense ? 'expense' : 'income';
}

// ---------------------------------------------------------------------------
// Amount (generic-en)
// ---------------------------------------------------------------------------

// Same glyph set the CSV importer strips (shared/csv.ts), same ISO codes as
// the display-currency list. Codes are matched case-sensitively — a lowercase
// "inr 500" fails closed, consistent with the CSV parser's never-guess stance.
const SYMBOLS = '$€£¥₹₩₪₱₫';
const CODE_PATTERN = [...CURRENCY_CODES].join('|');
// `\d+` first so "1200.00" is consumed whole; the comma groups only ever
// extend a match ("4,200.00"). Non-western digit grouping ("1,23,456.00")
// splits into several tokens and therefore fails the exactly-one gate —
// fail-closed by construction, a pack for those formats can do better.
const NUM = String.raw`\d+(?:,\d{3})*(?:\.\d{1,2})?`;
// The bare-number form additionally requires cents ("23.45") — a lone "23"
// next to a keyword is far more likely a quantity than money.
const NUM_DECIMAL = String.raw`\d+(?:,\d{3})*\.\d{2}`;

const SYMBOL_AMOUNT_RE = new RegExp(`[${SYMBOLS}]\\s?${NUM}(?!%)`, 'g');
const CODE_BEFORE_RE = new RegExp(`\\b(?:${CODE_PATTERN})\\s?${NUM}(?!%)`, 'g');
const CODE_AFTER_RE = new RegExp(`${NUM}\\s?(?:${CODE_PATTERN})\\b`, 'g');
const SYMBOL_CHARS_RE = new RegExp(`[${SYMBOLS}]`, 'g');
const CODE_STRIP_RE = new RegExp(`\\b(?:${CODE_PATTERN})\\b`, 'g');

/** "$1,200.00" / "INR 4,200.00" / "23.45" → cents-rounded number, else null. */
function parseMoneyToken(token: string): number | null {
  const cleaned = token
    .replace(SYMBOL_CHARS_RE, '')
    .replace(CODE_STRIP_RE, '')
    .replace(/[,\s]/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

/**
 * The amount must be exactly ONE money-like value in the combined
 * subject+body. Money-like: a currency symbol or ISO code adjacent to the
 * number, or a bare d+.dd immediately adjacent to a direction phrase
 * ("Charged 23.45 at…"). Zero candidates or several DIFFERENT values → null —
 * a marketing email full of prices must never turn into a proposal. The same
 * value repeated (subject restating the body) collapses to one candidate:
 * identical numbers cannot pick the wrong amount, so collapsing them is not
 * a guess.
 */
function detectAmount(text: string): number | null {
  const tokens: string[] = [];
  for (const re of [SYMBOL_AMOUNT_RE, CODE_BEFORE_RE, CODE_AFTER_RE]) {
    for (const match of text.match(re) ?? []) tokens.push(match);
  }

  // Bare numbers qualify only when they hug a direction phrase. Only each
  // phrase's first occurrence is inspected — adjacency is a tight claim and
  // scanning every repetition would only ever ADD candidates, never resolve
  // ambiguity.
  for (const { re } of [...EXPENSE_PHRASES, ...INCOME_PHRASES]) {
    const m = re.exec(text);
    if (!m) continue;
    const before = new RegExp(`(${NUM_DECIMAL})(?!%)\\s*(?:was\\s+|has\\s+been\\s+)?$`, 'i').exec(
      text.slice(0, m.index),
    );
    if (before) tokens.push(before[1]);
    const after = new RegExp(`^\\s*(?:of\\s+|with\\s+|for\\s+)?(${NUM_DECIMAL})(?!%)`, 'i').exec(
      text.slice(m.index + m[0].length),
    );
    if (after) tokens.push(after[1]);
  }

  const values = new Set<number>();
  for (const token of tokens) {
    const value = parseMoneyToken(token);
    if (value !== null) values.add(value);
  }
  if (values.size !== 1) return null;
  return [...values][0];
}

// ---------------------------------------------------------------------------
// Merchant (generic-en)
// ---------------------------------------------------------------------------

/**
 * Boundary markers that end a merchant capture (integration-QA ruling): the
 * raw at|to|from capture runs to the end of the clause, which on real alerts
 * drags trailing boilerplate into the name ("STARBUCKS STORE 08841 on your
 * card ending 4321") — and a sloppy merchant poisons duplicate fingerprints
 * and the sprint-5 rule suggestions. The capture is truncated at the FIRST of
 * these markers. Deterministic and enumerable ON PURPOSE — no cleverness
 * beyond this list. Word-boundary anchored (not literal ' marker ') so a
 * capture that BEGINS with a marker truncates to empty and the email lands
 * unparsed (never-guess holds) instead of keeping boilerplate as a merchant.
 */
const MERCHANT_BOUNDARIES: RegExp[] = [
  // Sentence terminator or line break. The capture classes exclude these
  // characters today, so these two are unreachable belt-and-braces — kept so
  // the boundary list stays complete if a capture regex ever loosens.
  /[.!?](?=\s|$)/,
  /[\r\n]/,
  /\bon your card\b/i,
  /\busing card\b/i,
  /\bwith card\b/i,
  /\bending\s/i,
  // "on" followed by a date-like token (08/12, 2026-08, Aug …).
  /\bon (?=\d{1,2}\/\d{1,2}|\d{4}-\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/i,
  // "at" followed by a time-like token (12:45).
  /\bat (?=\d{1,2}:\d{2})/i,
  /\bvia\b/i,
];

/** Cut the capture at the first boundary marker; the trims below finish up. */
function truncateAtBoundary(raw: string): string {
  let cut = raw.length;
  for (const re of MERCHANT_BOUNDARIES) {
    const m = re.exec(raw);
    if (m && m.index < cut) cut = m.index;
  }
  return raw.slice(0, cut);
}

/** True when the capture is really a money value, not a merchant name. */
function looksLikeMoney(candidate: string): boolean {
  if (/^\d[\d.,\s]*$/.test(candidate)) return true;
  for (const re of [SYMBOL_AMOUNT_RE, CODE_BEFORE_RE, CODE_AFTER_RE]) {
    if ((candidate.match(re) ?? []).length > 0) return true;
  }
  return false;
}

/**
 * Trim a raw capture down to the name the email actually stated: truncate at
 * the first boundary marker, then cut auxiliary-verb tails ("…APARTMENTS was
 * made"), date tails ("…STARBUCKS on 08/10"), and trailing reference codes,
 * then trailing punctuation. Empty after truncation/trimming → null, and a
 * capture that is itself a money value → null.
 */
function cleanMerchant(raw: string): string | null {
  let s = truncateAtBoundary(raw);
  s = s.replace(/\s+(?:was|were|is|are|has|have|had|will)\b[\s\S]*$/i, '');
  s = s.replace(/\s+on\s+\d[\s\S]*$/i, '');
  s = s.replace(/\s*[-–#(]?\s*\b(?:ref(?:erence)?|txn|auth(?:orization)?)\b[.:#\s]*\S*\s*$/i, '');
  s = s.replace(/[\s.,;:!?*#\-–]+$/, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s || looksLikeMoney(s)) return null;
  return s;
}

/**
 * Merchant is a literal at|to|from capture anchored to the matched direction
 * phrase — never a free-floating proper noun. 'with' is honored only as part
 * of "transaction with" (a bare "credited with INR 4,200.00" must not turn
 * the amount into a merchant).
 */
function detectMerchant(text: string, type: TxType): string | null {
  const phrases = type === 'expense' ? EXPENSE_PHRASES : INCOME_PHRASES;
  for (const phrase of phrases) {
    const m = phrase.re.exec(text);
    if (!m) continue;
    const rest = text.slice(m.index + m[0].length);
    const capture = phrase.prep
      ? /^\s*([^\r\n.,;!?]+)/.exec(rest)
      : /\b(?:at|to|from)\s+([^\r\n.,;!?]+)/.exec(rest);
    if (!capture) continue;
    const merchant = cleanMerchant(capture[1]);
    if (merchant) return merchant;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The v1 pack + the runner
// ---------------------------------------------------------------------------

/**
 * generic-en: conservative English bank-alert wording. Returns `date: ''` —
 * body-date extraction is deliberately not attempted in v1: printed dates
 * arrive in ambiguous local forms ("01/02" is January 2nd or February 1st
 * depending on the bank) and a wrong date corrupts the duplicate fingerprint
 * silently. The email's own arrival date is an honest observable fact, so
 * parseAlertEmail stamps that instead.
 */
export const genericEnPack: ParserPack = {
  name: 'generic-en',
  parse(subject, body) {
    const text = `${subject}\n${body}`;
    const type = detectDirection(text);
    if (type === null) return null;
    const amount = detectAmount(text);
    if (amount === null) return null;
    const merchant = detectMerchant(text, type);
    if (merchant === null) return null;
    return { date: '', merchant, amount, type, pack: 'generic-en' };
  },
};

/** Packs run in registration order; the first one to match wins. */
export const PARSER_PACKS: ParserPack[] = [genericEnPack];

/**
 * Run the packs over one email. `receivedAtIso` is the email's arrival time;
 * its YYYY-MM-DD prefix (UTC, matching every other worker date) backfills a
 * pack that returned no date. Returns null when no pack matched — the email
 * lands as 'unparsed', which is a first-class outcome, not an error.
 */
export function parseAlertEmail(
  subject: string,
  body: string,
  receivedAtIso: string,
  packs: readonly ParserPack[] = PARSER_PACKS,
): InboxParsedFields | null {
  for (const pack of packs) {
    let fields: InboxParsedFields | null;
    try {
      fields = pack.parse(subject, body);
    } catch {
      fields = null; // a broken pack must never take ingestion down with it
    }
    if (fields === null) continue;

    // Belt-and-braces over pack output — community packs are untrusted code
    // as far as the ledger is concerned, so the runner re-checks the facts.
    const date = isIsoDate(fields.date) ? fields.date : receivedAtIso.slice(0, 10);
    const merchant = fields.merchant.trim();
    const amount = Math.round(fields.amount * 100) / 100;
    if (!isIsoDate(date) || !merchant || !Number.isFinite(amount) || amount <= 0) continue;
    if (fields.type !== 'expense' && fields.type !== 'income') continue;
    return { date, merchant, amount, type: fields.type, pack: pack.name };
  }
  return null;
}
