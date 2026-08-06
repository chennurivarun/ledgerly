// Pure helpers for the AI statement batch-review flow (sprint 4). Kept
// dependency-free from React so they're cheap to unit test. Same never-guess
// principle as receipt extraction (extractionHelpers.ts): a missing or
// low-confidence field is flagged, never invented, and a row missing a
// required field can't be selected for import until the user fills it in.
import type {
  BatchInsertResult,
  StatementConfirmInput,
  StatementRow,
  TxType,
} from '../../../shared/types';
import { isLowConfidence, isRealDateISO, resolveCategorySuggestion } from './extractionHelpers';

/** Local, per-row editable state held until the user confirms the batch. */
export interface StatementRowDraft {
  id: string;
  date: string; // '' until filled — never invented
  merchant: string;
  amount: string; // numeric text; positive magnitude
  /** '' until the user picks one. `type` flips the sign of every downstream
   * number, so it is NEVER defaulted to 'expense' — that would be exactly
   * the kind of invented value the vision's "never guess" principle forbids. */
  type: TxType | '';
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
 * A low-confidence marker only stays useful while it still describes what's
 * on screen: once the user edits a flagged field away from the value
 * seedStatementRowDraft originally seeded, the marker for that field clears
 * (the user has already looked at it). Derived from data already in hand —
 * no separately tracked "touched" flag needed. `categories` must be the same
 * list the row was seeded with, since the category suggestion depends on it.
 */
export function visibleLowConfidenceFields(
  row: StatementRow,
  draft: Pick<StatementRowDraft, 'date' | 'merchant' | 'amount' | 'type' | 'category'>,
  categories: string[],
): string[] {
  return rowLowConfidenceFields(row).filter((field) => {
    switch (field) {
      case 'date':
        return draft.date === (row.date.value ?? '');
      case 'merchant':
        return draft.merchant === (row.merchant.value ?? '');
      case 'amount':
        return draft.amount === (row.amount.value !== null ? String(row.amount.value) : '');
      case 'type':
        return draft.type === (row.type.value ?? '');
      case 'category':
        return draft.category === resolveCategorySuggestion(row.category.value, categories);
      default:
        return true;
    }
  });
}

/**
 * Rounds a numeric amount string to integer cents; null when not a real
 * number. Single source of truth for "does this amount actually round to at
 * least one cent" — shared by missingRowFields and buildStatementConfirmInput
 * so a sub-cent value like "0.004" (which passes a naive `> 0` check but
 * rounds to 0 once stored) can't validate one way and post another.
 */
function amountCents(amount: string): number | null {
  const n = Number(amount);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/**
 * Required to select a row for import: a real date, a non-empty merchant, an
 * amount worth at least one cent once rounded, and a chosen type (never
 * guessed as 'expense'). Category is intentionally NOT required — forcing a
 * category choice on every row of an up-to-300-row batch would make triage
 * impractical. An unset category is sent as omitted, and the server applies
 * its own honest "Needs review" default (TxInput.category is optional for
 * exactly this reason) — the UI itself never invents a category value.
 */
export function missingRowFields(
  draft: Pick<StatementRowDraft, 'date' | 'merchant' | 'amount' | 'type'>,
): string[] {
  const missing: string[] = [];
  if (!draft.date || !isRealDateISO(draft.date)) missing.push('date');
  if (!draft.merchant.trim()) missing.push('merchant');
  const cents = amountCents(draft.amount);
  if (draft.amount.trim() === '' || cents === null || cents < 1) missing.push('amount');
  if (!draft.type) missing.push('type');
  return missing;
}

export function canRowBeSelected(
  draft: Pick<StatementRowDraft, 'date' | 'merchant' | 'amount' | 'type'>,
): boolean {
  return missingRowFields(draft).length === 0;
}

/**
 * Seeds one row's draft from the AI suggestion. Never invents a date,
 * amount, or type — those start blank/unset when the model didn't supply
 * one. Selection defaults: duplicate rows start UNCHECKED (already in the
 * ledger); every other row starts CHECKED, unless it's missing a required
 * field, in which case it can't be checked yet regardless of the default.
 */
export function seedStatementRowDraft(row: StatementRow, categories: string[]): StatementRowDraft {
  const date = row.date.value ?? '';
  const merchant = row.merchant.value ?? '';
  const amount = row.amount.value !== null ? String(row.amount.value) : '';
  const type = row.type.value ?? '';
  const category = resolveCategorySuggestion(row.category.value, categories);
  const complete = missingRowFields({ date, merchant, amount, type }).length === 0;
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
 * Applies an edit to a row's draft, then re-validates selection: a row that
 * becomes incomplete through the edit must visibly uncheck. Without this, a
 * checked row blanked by an edit stays visually checked while
 * selectableRows/buildStatementConfirmInput silently excludes it — "Import
 * N" would then resolve short of what the checkbox implied, with no sign
 * anything was left behind.
 */
export function applyDraftPatch(
  current: StatementRowDraft,
  patch: Partial<StatementRowDraft>,
): StatementRowDraft {
  const merged = { ...current, ...patch };
  return { ...merged, selected: merged.selected && canRowBeSelected(merged) };
}

/** Rows the user has both checked and that are still complete — the set that would actually be submitted. */
export function selectableRows(
  rows: StatementRow[],
  drafts: Record<string, StatementRowDraft>,
): StatementRow[] {
  return rows.filter((row) => {
    const d = drafts[row.id];
    return !!d && d.selected && canRowBeSelected(d);
  });
}

/**
 * True when every row submitted this round actually landed with nothing
 * skipped — the only condition under which the review modal auto-closes.
 * Any duplicate collision or per-row error keeps the modal open so the user
 * sees an honest outcome instead of an assumed clean import.
 */
export function isCleanOutcome(res: BatchInsertResult, attemptedCount: number): boolean {
  return res.errors.length === 0 && res.duplicates === 0 && res.inserted === attemptedCount;
}

/**
 * Builds the confirm payload from the rows the user selected (and possibly
 * edited). Caller is expected to have already filtered `rows` down to the
 * selected + complete ones (selectableRows/canRowBeSelected) — a missing or
 * incomplete draft reaching here means a caller bug, not a value to guess
 * around, so it throws naming the offending row rather than silently
 * skipping it. `receipt: false` — a statement line isn't a receipt
 * attachment; provenance is already carried by `source: 'document'`.
 */
export function buildStatementConfirmInput(
  rows: StatementRow[],
  drafts: Record<string, StatementRowDraft>,
  account: string,
): StatementConfirmInput {
  return {
    rows: rows.map((row) => {
      const d = drafts[row.id];
      if (!d) throw new Error(`buildStatementConfirmInput: missing draft for row ${row.id}`);
      const cents = amountCents(d.amount);
      if (cents === null || cents < 1) {
        throw new Error(`buildStatementConfirmInput: invalid amount for row ${row.id}`);
      }
      if (!d.type) {
        throw new Error(`buildStatementConfirmInput: missing type for row ${row.id}`);
      }
      return {
        rowId: row.id,
        date: d.date,
        merchant: d.merchant.trim(),
        amount: cents / 100,
        type: d.type,
        category: d.category || undefined,
        account,
        receipt: false,
        source: 'document' as const,
      };
    }),
  };
}
