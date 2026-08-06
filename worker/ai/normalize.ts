// Server-side validation of model output. NOTHING a model returns is trusted:
// every field is re-checked here against the same rules the deterministic
// import path uses, and anything that fails becomes `null` with confidence 0
// rather than a guess (VISION.md — "never guess", "AI suggests, never writes").
//
// Pure module — no D1, no network, no bindings. Exercised directly by tests.
import { MAX_STATEMENT_ROWS, type ExtractedField, type TxType } from '../../shared/types';
import { clip, isIsoDate, isRecord } from '../util';

/** The five suggestion fields, exactly as they appear on `ExtractionResult`. */
export interface ExtractionFields {
  merchant: ExtractedField<string>;
  date: ExtractedField<string>;
  total: ExtractedField<number>;
  type: ExtractedField<TxType>;
  category: ExtractedField<string>;
}

const MAX_MERCHANT = 120;

/** A fresh all-unknown suggestion — used for failed runs and corrupt rows. */
export function emptyFields(): ExtractionFields {
  const blank = <T>(): ExtractedField<T> => ({ value: null, confidence: 0 });
  return {
    merchant: blank<string>(),
    date: blank<string>(),
    total: blank<number>(),
    type: blank<TxType>(),
    category: blank<string>(),
  };
}

/**
 * Confidence is advisory, so a nonsense value is clamped rather than rejected:
 * out of range collapses to the nearest bound, non-numeric to 0 (least
 * confident — the safe direction, since low confidence routes to review).
 */
export function clampConfidence(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 1) return 1;
  return Math.round(n * 100) / 100;
}

/** `{value, confidence}` envelope, tolerant of a model that omits either half. */
function envelope(raw: unknown): { value: unknown; confidence: number } {
  if (!isRecord(raw)) return { value: null, confidence: 0 };
  return { value: raw.value ?? null, confidence: clampConfidence(raw.confidence) };
}

/** A dropped value always drops its confidence with it — they cannot disagree. */
function keep<T>(value: T | null, confidence: number): ExtractedField<T> {
  return value === null ? { value: null, confidence: 0 } : { value, confidence };
}

function readMerchant(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? clip(trimmed, MAX_MERCHANT) : null;
}

/**
 * Real calendar dates only. A leading `YYYY-MM-DD` is taken from a longer
 * timestamp, but any other shape (`03/04/2026`) is rejected outright rather
 * than reordered — guessing day-vs-month is exactly the ambiguity the CSV
 * importer refuses to resolve on the user's behalf (spec §8.2).
 */
function readDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return null;
  const candidate = trimmed.slice(0, 10);
  return isIsoDate(candidate) ? candidate : null;
}

/**
 * A positive magnitude, matching `Transaction.amount` (sign lives in `type`).
 * A negative or zero total is dropped rather than flipped: on a receipt it
 * usually means the model read a discount line or the change due, and inferring
 * "so it must be a refund" would be a guess.
 */
function readTotal(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

function readType(raw: unknown): TxType | null {
  return raw === 'expense' || raw === 'income' ? raw : null;
}

/**
 * Categories are a closed set: only a name the user actually manages survives,
 * and it comes back in the casing the user chose, not the model's.
 */
function readCategory(raw: unknown, categories: readonly string[]): string | null {
  if (typeof raw !== 'string') return null;
  const wanted = raw.trim().toLowerCase();
  if (!wanted) return null;
  return categories.find((c) => c.trim().toLowerCase() === wanted) ?? null;
}

/** Re-validate a whole model response. Unparseable input yields all-unknown. */
export function normalizeExtraction(raw: unknown, categories: readonly string[]): ExtractionFields {
  if (!isRecord(raw)) return emptyFields();

  const merchant = envelope(raw.merchant);
  const date = envelope(raw.date);
  const total = envelope(raw.total);
  const type = envelope(raw.type);
  const category = envelope(raw.category);

  return {
    merchant: keep(readMerchant(merchant.value), merchant.confidence),
    date: keep(readDate(date.value), date.confidence),
    total: keep(readTotal(total.value), total.confidence),
    type: keep(readType(type.value), type.confidence),
    category: keep(readCategory(category.value, categories), category.confidence),
  };
}

// ---------------------------------------------------------------------------
// Statement rows (sprint 4). Same rules, applied per row — plus the one rule a
// table needs: a "row" with neither a date nor an amount is not a transaction
// at all, so it is dropped rather than handed to the user as a blank form.
// ---------------------------------------------------------------------------

/** One proposed row's fields, exactly as they appear on `StatementRow`. */
export interface StatementRowFields {
  date: ExtractedField<string>;
  merchant: ExtractedField<string>;
  amount: ExtractedField<number>;
  type: ExtractedField<TxType>;
  category: ExtractedField<string>;
}

/** A fresh all-unknown row — used for corrupt stored rows on the read path. */
export function emptyStatementRow(): StatementRowFields {
  const blank = <T>(): ExtractedField<T> => ({ value: null, confidence: 0 });
  return {
    date: blank<string>(),
    merchant: blank<string>(),
    amount: blank<number>(),
    type: blank<TxType>(),
    category: blank<string>(),
  };
}

/**
 * Re-validate one row. Returns null when the row is not a transaction: with
 * neither a date nor an amount there is nothing for the user to confirm and
 * nothing to fingerprint, so it was almost certainly a header or a total the
 * model mistook for a line. Missing *one* of the two is kept as null for the
 * user to fill in — that is a row we read badly, not a row that isn't there.
 */
export function normalizeStatementRow(
  raw: unknown,
  categories: readonly string[],
): StatementRowFields | null {
  if (!isRecord(raw)) return null;

  const date = envelope(raw.date);
  const merchant = envelope(raw.merchant);
  const amount = envelope(raw.amount);
  const type = envelope(raw.type);
  const category = envelope(raw.category);

  const fields: StatementRowFields = {
    // readTotal is the same rule an amount needs — finite, positive, cents.
    date: keep(readDate(date.value), date.confidence),
    merchant: keep(readMerchant(merchant.value), merchant.confidence),
    amount: keep(readTotal(amount.value), amount.confidence),
    type: keep(readType(type.value), type.confidence),
    category: keep(readCategory(category.value, categories), category.confidence),
  };

  if (fields.date.value === null && fields.amount.value === null) return null;
  return fields;
}

/** Lowest field confidence — what the review screen sorts on. */
export function lowestConfidence(fields: StatementRowFields): number {
  return Math.min(
    fields.date.confidence,
    fields.merchant.confidence,
    fields.amount.confidence,
    fields.type.confidence,
    fields.category.confidence,
  );
}

export interface NormalizedStatement {
  rows: StatementRowFields[];
  /** True when rows were dropped at the cap — the caller must report this. */
  capped: boolean;
}

/** The `rows` array out of a parsed model response, or null if there isn't one. */
export function readRowsArray(parsed: unknown): unknown[] | null {
  if (!isRecord(parsed)) return null;
  return Array.isArray(parsed.rows) ? parsed.rows : null;
}

/**
 * Re-validate a whole statement answer. The cap is applied after dropping
 * non-rows, so a model that emits 50 balance lines does not spend the user's
 * budget on them.
 */
export function normalizeStatementRows(
  rawRows: readonly unknown[],
  categories: readonly string[],
  max = MAX_STATEMENT_ROWS,
): NormalizedStatement {
  const rows: StatementRowFields[] = [];
  let capped = false;
  for (const raw of rawRows) {
    if (rows.length >= max) {
      capped = true;
      break;
    }
    const row = normalizeStatementRow(raw, categories);
    if (row) rows.push(row);
  }
  return { rows, capped };
}

/**
 * Recover whole row objects from a response that stopped mid-JSON.
 *
 * A run that hits max_tokens has read real rows and then been cut off inside
 * one — throwing the lot away would silently lose a page of work, so the
 * balanced objects inside `rows: [` are salvaged and the ragged tail dropped.
 * Brace counting is string-aware: a `}` inside a merchant name is not a close.
 */
export function salvageStatementRows(text: string): unknown[] {
  const key = text.indexOf('"rows"');
  if (key === -1) return [];
  const open = text.indexOf('[', key);
  if (open === -1) return [];

  const rows: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          rows.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // A complete-looking object that will not parse is not a row.
        }
        start = -1;
      }
      if (depth < 0) break; // past the array — the object holding it closed
      continue;
    }
    if (ch === ']' && depth === 0) break;
  }
  return rows;
}

/**
 * Pull JSON out of a model response. Schema-constrained providers return bare
 * JSON, but a model that ignores the constraint tends to fence it or wrap it in
 * prose, so the outermost `{...}` is recovered instead of failing the run.
 * Returns null when there is nothing parseable — the caller treats that as a
 * failed extraction, never as an empty-but-successful one.
 */
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const candidates = [trimmed];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced) candidates.push(fenced[1].trim());

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      continue;
    }
  }
  return null;
}
