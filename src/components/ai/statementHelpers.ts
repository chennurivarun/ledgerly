// Pure helpers for the AI statement batch-review flow (sprint 4). Kept
// dependency-free from React so they're cheap to unit test. Same never-guess
// principle as receipt extraction (extractionHelpers.ts): a missing or
// low-confidence field is flagged, never invented, and a row missing a
// required field can't be selected for import until the user fills it in.
import type { StatementConfirmInput, StatementRow, TxType } from '../../../shared/types';
import { isLowConfidence, isRealDateISO, resolveCategorySuggestion } from './extractionHelpers';

/** Local, per-row editable state held until the user confirms the batch. */
export interface StatementRowDraft {
  id: string;
  date: string; // '' until filled — never invented
  merchant: string;
  amount: string; // numeric text; positive magnitude
  type: TxType;
  category: string; // '' = "Choose…"; optional at confirm (server applies its own default)
  selected: boolean;
}

/**
 * Field names that came back null or below the confidence threshold — drives
 * the row's low-confidence marker. Checks every field directly (not just the
 * server-computed `lowestConfidence`) so a malformed/missing confidence value
 * crossing the JSON boundary is still treated as low, never implicitly high
 * (same defensive stance as extractionHelpers.isLowConfidence).
 */
export function rowLowConfidenceFields(row: StatementRow): string[] {
  const flagged: string[] = [];
  if (isLowConfidence(row.date)) flagged.push('date');
  if (isLowConfidence(row.merchant)) flagged.push('merchant');
  if (isLowConfidence(row.amount)) flagged.push('amount');
  if (isLowConfidence(row.type)) flagged.push('type');
  if (isLowConfidence(row.category)) flagged.push('category');
  return flagged;
}

export function isRowLowConfidence(row: StatementRow): boolean {
  return rowLowConfidenceFields(row).length > 0;
}

/**
 * Required to select a row for import: a real date, a non-empty merchant,
 * and a positive amount. Category is intentionally NOT required — forcing a
 * category choice on every row of a up-to-300-row batch would make triage
 * impractical. An unset category is sent as omitted, and the server applies
 * its own honest "Needs review" default (TxInput.category is optional for
 * exactly this reason) — the UI itself never invents a category value.
 */
export function missingRowFields(
  draft: Pick<StatementRowDraft, 'date' | 'merchant' | 'amount'>,
): string[] {
  const missing: string[] = [];
  if (!draft.date || !isRealDateISO(draft.date)) missing.push('date');
  if (!draft.merchant.trim()) missing.push('merchant');
  const amount = Number(draft.amount);
  if (draft.amount.trim() === '' || !Number.isFinite(amount) || amount <= 0) missing.push('amount');
  return missing;
}

export function canRowBeSelected(
  draft: Pick<StatementRowDraft, 'date' | 'merchant' | 'amount'>,
): boolean {
  return missingRowFields(draft).length === 0;
}

/**
 * Seeds one row's draft from the AI suggestion. Never invents a date or
 * amount — those start blank when the model didn't supply one. Selection
 * defaults: duplicate rows start UNCHECKED (already in the ledger); every
 * other row starts CHECKED, unless it's missing a required field, in which
 * case it can't be checked yet regardless of the default (never-guess: a
 * blank amount stays blank and blocks selection rather than defaulting to 0
 * or being silently checked anyway).
 */
export function seedStatementRowDraft(row: StatementRow, categories: string[]): StatementRowDraft {
  const date = row.date.value ?? '';
  const merchant = row.merchant.value ?? '';
  const amount = row.amount.value !== null ? String(row.amount.value) : '';
  const type = row.type.value ?? 'expense';
  const category = resolveCategorySuggestion(row.category.value, categories);
  const complete = missingRowFields({ date, merchant, amount }).length === 0;
  return {
    id: row.id,
    date,
    merchant,
    amount,
    type,
    category,
    selected: !row.duplicate && complete,
  };
}

/**
 * Builds the confirm payload from the rows the user selected (and possibly
 * edited). Caller is expected to have already filtered `rows` down to the
 * selected + complete ones (canRowBeSelected) — this never drops or
 * substitutes a value for an incomplete row on its own.
 */
export function buildStatementConfirmInput(
  rows: StatementRow[],
  drafts: Record<string, StatementRowDraft>,
  account: string,
): StatementConfirmInput {
  return {
    rows: rows.map((row) => {
      const d = drafts[row.id];
      return {
        rowId: row.id,
        date: d.date,
        merchant: d.merchant.trim(),
        amount: Math.round(Number(d.amount) * 100) / 100,
        type: d.type,
        category: d.category || undefined,
        account,
        receipt: true,
        source: 'document' as const,
      };
    }),
  };
}
