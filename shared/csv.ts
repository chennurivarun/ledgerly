import { CURRENCY_CODES } from './currencies';
import { NEEDS_REVIEW, type TxInput } from './types';

export interface CsvTable {
  headers: string[];
  rows: string[][];
  /** True when the input ended with an unterminated quoted field — the rest
   * of the file was swallowed into one field rather than parsed row by row.
   * The caller should surface this as a malformed-file signal instead of
   * silently importing a truncated table. */
  truncated?: boolean;
}

export interface CsvMapping {
  date: number;
  description: number;
  amount?: number; // single signed column
  debit?: number; // separate debit column
  credit?: number; // separate credit column
  category?: number;
  account?: number;
  /** How a signed single amount column maps to type (spec §8.1.5). */
  signConvention: 'negative-expense' | 'positive-expense';
  /** False only when a single amount column's sign convention could not be
   * confidently inferred from the actual row data (every parsed value
   * shares one sign, so debit-vs-credit can't be told apart) — the import
   * UI must ask the user to confirm before importing. Omitted (treated as
   * confident) when debit/credit columns are used, when `rows` wasn't
   * passed to detectMapping, or when the data showed mixed signs. */
  signConventionInferred?: boolean;
}

export interface CsvToTxResult {
  transactions: TxInput[];
  skipped: number; // unparseable rows — never imported as placeholders (spec §8.1.10)
  needsReview: number; // imported rows that fell back to the Needs review category
}

/**
 * RFC-4180 CSV parser: quoted fields (commas/newlines inside quotes),
 * doubled-quote escaping (`""` -> `"`), CRLF or LF row terminators, blank
 * lines skipped, unquoted cells trimmed (quoted content is preserved
 * verbatim, including leading/trailing whitespace). A quote opens a quoted
 * field as soon as it appears after only whitespace since the last
 * delimiter/newline (e.g. `foo, "bar, baz", 1` — a space after the comma is
 * common in hand-edited exports) — the leading whitespace is discarded
 * rather than leaking into the field.
 *
 * ponytail: does not support a quote character appearing mid-field after
 * non-whitespace content in an unquoted cell (e.g. `foo"bar`), and content
 * between a quoted field's closing quote and the next delimiter isn't
 * specially trimmed/validated — RFC-4180 doesn't define either case and
 * real bank exports don't produce them. Upgrade path: a full state machine
 * per RFC-4180 §2 if a real export ever needs it.
 */
export function parseCsv(text: string): CsvTable {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldWasQuoted = false;
  let i = 0;
  const n = text.length;

  const pushField = () => {
    row.push(fieldWasQuoted ? field : field.trim());
    field = '';
    fieldWasQuoted = false;
  };
  const pushRow = () => {
    pushField();
    // A line that produced exactly one empty, unquoted field is blank — skip it.
    if (!(row.length === 1 && row[0] === '')) {
      rows.push(row);
    }
    row = [];
  };

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
      continue;
    }

    if (ch === '"' && field.trim() === '') {
      inQuotes = true;
      fieldWasQuoted = true;
      field = ''; // discard any leading whitespace accumulated before the quote
      i++;
    } else if (ch === ',') {
      pushField();
      i++;
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      i++;
      pushRow();
    } else if (ch === '\n') {
      i++;
      pushRow();
    } else {
      field += ch;
      i++;
    }
  }
  const truncated = inQuotes;
  // Flush a trailing field/row that wasn't terminated by a newline.
  if (field !== '' || row.length > 0) {
    pushRow();
  }

  if (rows.length === 0) return truncated ? { headers: [], rows: [], truncated: true } : { headers: [], rows: [] };
  const [headers, ...dataRows] = rows;
  return truncated ? { headers, rows: dataRows, truncated: true } : { headers, rows: dataRows };
}

const DATE_HEADERS = ['date', 'posted', 'transaction date'];
const DESCRIPTION_HEADERS = ['description', 'merchant', 'payee', 'name', 'details'];
const AMOUNT_HEADERS = ['amount'];
const DEBIT_HEADERS = ['debit', 'withdrawal'];
const CREDIT_HEADERS = ['credit', 'deposit'];
const CATEGORY_HEADERS = ['category'];
const ACCOUNT_HEADERS = ['account'];

/**
 * Detect a column mapping from headers (spec §8.1.2–§8.1.3), optionally
 * refining the sign convention from sample row data (spec §8.1.5). Returns a
 * full mapping only when unambiguous: date + description are both present,
 * neither role matches more than one column, and exactly one of {amount
 * column, debit/credit column(s)} is present. Any other shape (missing
 * date/description, a role matching multiple columns, both amount and
 * debit/credit present, or neither) returns null so the UI falls back to
 * its manual mapping step rather than guessing.
 *
 * When `rows` is supplied and a single amount column is used, the actual
 * values are inspected: mixed signs confidently confirm the
 * 'negative-expense' default, but if every parsed value shares one sign the
 * convention can't be told apart from data alone, so `signConventionInferred:
 * false` is set on the mapping and the caller's import UI should ask the
 * user to confirm rather than import silently.
 */
export function detectMapping(headers: string[], rows?: string[][]): CsvMapping | null {
  const normalized = headers.map((h) => h.trim().toLowerCase());
  const findAll = (candidates: string[]) =>
    normalized.reduce<number[]>((acc, h, i) => {
      if (candidates.includes(h)) acc.push(i);
      return acc;
    }, []);

  const dateIdxs = findAll(DATE_HEADERS);
  const descIdxs = findAll(DESCRIPTION_HEADERS);
  const amountIdxs = findAll(AMOUNT_HEADERS);
  const debitIdxs = findAll(DEBIT_HEADERS);
  const creditIdxs = findAll(CREDIT_HEADERS);
  const categoryIdxs = findAll(CATEGORY_HEADERS);
  const accountIdxs = findAll(ACCOUNT_HEADERS);

  // Any role matching more than one column is ambiguous — bail to the manual mapping step.
  if (
    dateIdxs.length > 1 ||
    descIdxs.length > 1 ||
    amountIdxs.length > 1 ||
    debitIdxs.length > 1 ||
    creditIdxs.length > 1 ||
    categoryIdxs.length > 1 ||
    accountIdxs.length > 1
  ) {
    return null;
  }

  const dateIdx = dateIdxs[0] ?? -1;
  const descIdx = descIdxs[0] ?? -1;
  const amountIdx = amountIdxs[0] ?? -1;
  const debitIdx = debitIdxs[0] ?? -1;
  const creditIdx = creditIdxs[0] ?? -1;
  const categoryIdx = categoryIdxs[0] ?? -1;
  const accountIdx = accountIdxs[0] ?? -1;

  if (dateIdx === -1 || descIdx === -1) return null;

  const hasAmount = amountIdx !== -1;
  const hasDebitCredit = debitIdx !== -1 || creditIdx !== -1;

  // Need amount XOR debit/credit — both present or neither is ambiguous.
  if (hasAmount === hasDebitCredit) return null;

  const mapping: CsvMapping = {
    date: dateIdx,
    description: descIdx,
    // Debit/credit columns make the sign explicit, so signConvention is
    // unused in that path; a lone amount column can't be classified from
    // the header alone, so 'negative-expense' (the overwhelming statement
    // convention) is the documented default rather than a silent guess at
    // structure — the mapping itself is still unambiguous. See below for
    // the data-driven refinement when `rows` is supplied.
    signConvention: 'negative-expense',
  };
  if (categoryIdx !== -1) mapping.category = categoryIdx;
  if (accountIdx !== -1) mapping.account = accountIdx;

  if (hasDebitCredit) {
    if (debitIdx !== -1) mapping.debit = debitIdx;
    if (creditIdx !== -1) mapping.credit = creditIdx;
  } else {
    mapping.amount = amountIdx;
    if (rows && rows.length > 0) {
      const signs = rows
        .map((r) => parseAmount(r[amountIdx]))
        .filter((n): n is number => n !== null && n !== 0)
        .map((n) => Math.sign(n));
      const hasPositive = signs.includes(1);
      const hasNegative = signs.includes(-1);
      if (signs.length > 0 && !(hasPositive && hasNegative)) {
        // Every parsed amount shares one sign — can't confidently tell
        // debit from credit convention from the data alone.
        mapping.signConventionInferred = false;
      }
    }
  }

  return mapping;
}

export function rowsToTransactions(
  table: CsvTable,
  mapping: CsvMapping,
  opts: { account?: string; categories?: string[] } = {},
): CsvToTxResult {
  const out: TxInput[] = [];
  let skipped = 0;
  let needsReview = 0;
  for (const row of table.rows) {
    const date = normalizeDate(row[mapping.date] ?? '');
    const merchant = (row[mapping.description] ?? '').trim();
    const parsed = readAmount(row, mapping);
    if (!date || !merchant || parsed === null || parsed.amount <= 0) {
      skipped++;
      continue;
    }
    const rawCategory = mapping.category != null ? (row[mapping.category] ?? '').trim() : '';
    let category: string;
    if (opts.categories) {
      // Preserve a SUPPORTED statement category only (spec §8.1.6); anything
      // else — unrecognized or blank — falls back to Needs review.
      const match = rawCategory
        ? opts.categories.find((c) => c.toLowerCase() === rawCategory.toLowerCase())
        : undefined;
      category = match ?? NEEDS_REVIEW;
      if (!match) needsReview++;
    } else {
      // No supported-category list provided — preserve current behavior:
      // use the raw statement category as-is when present (callers that
      // want §8.1.6 enforcement pass `opts.categories`).
      category = rawCategory || NEEDS_REVIEW;
      if (!rawCategory) needsReview++;
    }
    out.push({
      date,
      merchant,
      amount: parsed.amount,
      type: parsed.type,
      category,
      account:
        (mapping.account != null ? (row[mapping.account] ?? '').trim() : '') ||
        opts.account ||
        'Imported account',
      receipt: false,
      source: 'csv',
    });
  }
  return { transactions: out, skipped, needsReview };
}

// Currency notation parseAmount is willing to strip: an anchored 3-letter
// ISO code (any of the 30 supported display currencies, e.g. "CHF 1,234.56"
// or "1,234.56 CHF" — a leading code also survives a leading sign or open
// paren, e.g. "-CHF 1,234.56" and "(CHF 1,234.00)"), the handful of currency glyphs
// Intl actually renders for those currencies in the app (symbol-only
// currencies aren't anchored since a symbol can't be confused with anything
// else), and whitespace. A WHITELIST, not a blacklist of "anything
// non-numeric": an earlier version stripped every character that wasn't a
// digit or numeric punctuation, which turned strict rejection into "extract
// any digits from the string" — silently misparsing a "12.34DR" debit
// marker, a "Ref 12345" reference number, or a "Jan 5 2026" date as a
// dollar amount. Built once at module scope, not per call.
// Case-sensitive by design: a lowercase "chf 100" fails closed (skipped and
// counted) rather than being guessed at, consistent with the parser's
// never-guess invariant. No lookbehind anywhere in these patterns — a
// module-scope `new RegExp` with lookbehind throws at app load on Safari
// 16.0–16.3, which the build target still declares supported.
const CURRENCY_CODE_PATTERN = [...CURRENCY_CODES].join('|');
/** Leading ISO code, preserving an optional sign and/or open paren before it. */
const LEADING_CODE = new RegExp(`^([-+]?\\(?)(?:${CURRENCY_CODE_PATTERN})\\s*`);
const CURRENCY_NOTATION = new RegExp(
  `\\s*(?:${CURRENCY_CODE_PATTERN})$|[$€£¥₹₩₪₱₫]|\\s`,
  'g',
);

/**
 * Parse a raw amount cell into a number, or null when unparseable/ambiguous.
 * Strips known currency notation (see CURRENCY_NOTATION) and surrounding
 * whitespace, unwraps parenthesized negatives (e.g. "(1,234.56)" ->
 * "-1234.56"), and strips US-style comma thousands separators. Anything left
 * over that isn't numeric — a debit/credit marker, a reference number, a
 * date, a percent sign — fails Number() and is correctly rejected rather
 * than silently coerced into an amount (spec §8.1.10: never guess).
 *
 * Refuses to guess on decimal-comma notation (e.g. "-1.234,56", meaning
 * -1234.56 in EU convention): stripping the comma as if it were a US
 * thousands separator would silently misparse it as -1.23, off by ~1000x.
 * A trailing comma followed by exactly two digits is treated as this
 * ambiguous case and returns null (the row is skipped and counted, never
 * silently imported with the wrong magnitude) — real US thousands grouping
 * is always in groups of three digits, so it never matches this shape.
 */
function parseAmount(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const noCurrency = trimmed.replace(LEADING_CODE, '$1').replace(CURRENCY_NOTATION, '');
  if (/,\d{2}$/.test(noCurrency)) return null;
  const cleaned = noCurrency.replace(/,/g, '').replace(/^\((.*)\)$/, '-$1');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function readAmount(
  row: string[],
  mapping: CsvMapping,
): { amount: number; type: 'expense' | 'income' } | null {
  if (mapping.debit != null || mapping.credit != null) {
    const d = mapping.debit != null ? parseAmount(row[mapping.debit]) : null;
    const c = mapping.credit != null ? parseAmount(row[mapping.credit]) : null;
    const dNonZero = d !== null && d !== 0;
    const cNonZero = c !== null && c !== 0;
    // Both columns populated on the same row is malformed/ambiguous — skip
    // rather than guess which one is the real charge.
    if (dNonZero && cNonZero) return null;
    if (dNonZero) {
      // A negative debit-column value is a refund/reversal, not a charge.
      return { amount: Math.abs(d as number), type: (d as number) < 0 ? 'income' : 'expense' };
    }
    if (cNonZero) {
      // A negative credit-column value is a chargeback/reversal, not income.
      return { amount: Math.abs(c as number), type: (c as number) < 0 ? 'expense' : 'income' };
    }
    return null;
  }
  if (mapping.amount != null) {
    const n = parseAmount(row[mapping.amount]);
    if (n === null || n === 0) return null;
    const negativeIsExpense = mapping.signConvention === 'negative-expense';
    const isExpense = negativeIsExpense ? n < 0 : n > 0;
    return { amount: Math.abs(n), type: isExpense ? 'expense' : 'income' };
  }
  return null;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function monthFromName(name: string): number | null {
  return MONTH_NAMES[name.slice(0, 3).toLowerCase()] ?? null;
}

function isValidYMD(y: number, mo: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d)) return false;
  if (mo < 1 || mo > 12) return false;
  if (d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= daysInMonth;
}

/**
 * Normalize common date formats to YYYY-MM-DD; returns null when unparseable.
 * Supports: YYYY-MM-DD, YYYY/MM/DD, MM/DD/YYYY, M/D/YYYY, DD-MM-YYYY (day-first
 * only when the first number can't be a month, i.e. > 12 — otherwise MM/DD is
 * assumed, the overwhelming US statement convention), and textual months
 * ("Jan 5, 2026", "5 Jan 2026", "05-Jan-2026").
 */
export function normalizeDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;

  // YYYY-MM-DD or YYYY/MM/DD
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    return isValidYMD(y, mo, d) ? `${m[1]}-${pad2(mo)}-${pad2(d)}` : null;
  }

  // Numeric MM/DD/YYYY, M/D/YYYY, or day-first DD-MM-YYYY when the first
  // number exceeds 12 (can only be a day).
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = Number(m[3]);
    let mo: number;
    let d: number;
    if (a > 12 && b <= 12) {
      d = a;
      mo = b;
    } else {
      mo = a;
      d = b;
    }
    return isValidYMD(y, mo, d) ? `${y}-${pad2(mo)}-${pad2(d)}` : null;
  }

  // Textual month, month-first: "Jan 5, 2026" / "January 5 2026"
  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mo = monthFromName(m[1]);
    const d = Number(m[2]);
    const y = Number(m[3]);
    return mo != null && isValidYMD(y, mo, d) ? `${y}-${pad2(mo)}-${pad2(d)}` : null;
  }

  // Textual month, day-first: "5 Jan 2026" / "05-Jan-2026"
  m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,9})\.?[\s,-]+(\d{4})$/);
  if (m) {
    const d = Number(m[1]);
    const mo = monthFromName(m[2]);
    const y = Number(m[3]);
    return mo != null && isValidYMD(y, mo, d) ? `${y}-${pad2(mo)}-${pad2(d)}` : null;
  }

  return null;
}
