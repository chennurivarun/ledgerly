// Pure helpers for the AI receipt-extraction review flow (sprint 3). Kept
// dependency-free from React so they're cheap to unit test. Encodes the
// vision's "never guess" principle: a missing or low-confidence field starts
// blank/flagged in the review form rather than being silently invented.
import {
  NEEDS_REVIEW,
  type ExtractedField,
  type ExtractionResult,
  type Settings,
  type TxInput,
  type TxType,
} from '../../../shared/types';

export const LOW_CONFIDENCE_THRESHOLD = 0.6;

/**
 * Rounds a numeric amount string to integer cents; null when not a real
 * number. Single source of truth for "does this amount actually round to at
 * least one cent" — a sub-cent value like "0.004" passes a naive `> 0` check
 * but rounds to 0 once stored, so validation and the payload builder must
 * agree on the same rounding. Shared by validateExtractionDraft below and by
 * statementHelpers.ts's identical amount-validity check.
 */
export function amountCents(amount: string): number | null {
  const n = Number(amount);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/**
 * True when a field is missing or the model wasn't confident — draws the eye,
 * never blocks confirmation. A missing/non-finite confidence (malformed data
 * crossing the JSON boundary — undefined, NaN, Infinity) is treated as LOW,
 * never as implicitly high; only a real number below the threshold is "safe".
 */
export function isLowConfidence<T>(field: ExtractedField<T> | undefined | null): boolean {
  if (!field) return true;
  if (field.value === null) return true;
  return !Number.isFinite(field.confidence) || field.confidence < LOW_CONFIDENCE_THRESHOLD;
}

/** Extraction only makes sense for a rendered document: images and PDFs. */
export function isDocumentExtractable(mimeType: string): boolean {
  return mimeType.startsWith('image/') || mimeType === 'application/pdf';
}

/** Real calendar-date check for YYYY-MM-DD strings (mirrors shared/format's local-date construction — no timezone surprises, catches e.g. Feb 30). */
export function isRealDateISO(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

/**
 * Resolve the extraction's category suggestion against the managed list
 * (case-insensitive, since the model doesn't know the user's exact casing).
 * Falls back to "Needs review" when present — it's self-labelling, so
 * showing it is honest. Never silently substitutes an arbitrary category
 * (e.g. the first one) for an unmatched suggestion: a confident "Travel"
 * suggestion quietly becoming "Housing" under a "Suggested by AI" footer
 * would be an invented value, not a real fallback. Unmatched/missing
 * suggestions with no "Needs review" category seed '' instead, forcing an
 * explicit choice (the review form shows a "Choose a category…" placeholder
 * and validation blocks confirm until one is picked).
 */
export function resolveCategorySuggestion(suggested: string | null, categories: string[]): string {
  if (suggested) {
    const match = categories.find((c) => c.toLowerCase() === suggested.toLowerCase());
    if (match) return match;
  }
  if (categories.includes(NEEDS_REVIEW)) return NEEDS_REVIEW;
  return '';
}

export interface ExtractionDraft {
  merchant: string;
  date: string; // '' until the user picks one, if the extraction didn't supply a real value
  total: string; // numeric text field
  type: TxType;
  category: string;
  account: string;
  tags: string[];
}

/**
 * Seeds the review form from the extraction's suggestion. Never invents a
 * date or amount: those start blank when the model didn't supply one, so the
 * user consciously fills them in instead of unknowingly confirming a guess.
 */
export function seedExtractionDraft(
  extraction: ExtractionResult,
  settings: Pick<Settings, 'categories' | 'accounts'>,
): ExtractionDraft {
  return {
    merchant: extraction.merchant.value ?? '',
    date: extraction.date.value ?? '',
    total: extraction.total.value !== null ? String(extraction.total.value) : '',
    type: extraction.type.value ?? 'expense',
    category: resolveCategorySuggestion(extraction.category.value, settings.categories),
    account: settings.accounts[0] ?? '',
    tags: [],
  };
}

/** date real, total > 0, merchant non-empty — first failing rule wins; nothing here guesses on the user's behalf. */
export function validateExtractionDraft(draft: ExtractionDraft): string | null {
  if (!draft.merchant.trim()) return 'Enter a merchant.';
  if (!draft.date || !isRealDateISO(draft.date)) return 'Choose a real date.';
  // Guard against sub-cent amounts (e.g. "0.004"): they pass a naive `> 0`
  // check but round to 0 once stored as cents (buildTxInputFromDraft below
  // rounds the same way) — validate the rounding the payload actually uses.
  const cents = amountCents(draft.total);
  if (cents === null || cents < 1) return 'Enter a total greater than 0.';
  if (!draft.category) return 'Choose a category.';
  if (!draft.account) return 'Choose an account.';
  return null;
}

/** Builds the TxInput sent to store.confirmExtraction. Caller must validate the draft first. */
export function buildTxInputFromDraft(draft: ExtractionDraft): TxInput {
  return {
    date: draft.date,
    merchant: draft.merchant.trim(),
    amount: Math.round(Number(draft.total) * 100) / 100,
    type: draft.type,
    category: draft.category,
    account: draft.account,
    tags: draft.tags,
    receipt: true,
    source: 'document',
  };
}
