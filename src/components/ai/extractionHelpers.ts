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

/** True when a field is missing or the model wasn't confident — draws the eye, never blocks confirmation. */
export function isLowConfidence<T>(field: ExtractedField<T> | undefined | null): boolean {
  if (!field) return true;
  return field.value === null || field.confidence < LOW_CONFIDENCE_THRESHOLD;
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
 * Falls back to "Needs review" when present, else the first managed category.
 */
export function resolveCategorySuggestion(suggested: string | null, categories: string[]): string {
  if (suggested) {
    const match = categories.find((c) => c.toLowerCase() === suggested.toLowerCase());
    if (match) return match;
  }
  if (categories.includes(NEEDS_REVIEW)) return NEEDS_REVIEW;
  return categories[0] ?? '';
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
  const total = Number(draft.total);
  if (!Number.isFinite(total) || total <= 0) return 'Enter a total greater than 0.';
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
