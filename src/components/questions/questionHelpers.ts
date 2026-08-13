// Pure helpers for the Dashboard's "Getting to know you" card (sprint 14).
// Kept out of the component so the exact copy — including currency totals via
// the house formatter — is pinned by tests rather than living inline in JSX.
import { cleanBankDescriptor } from '../../../shared/descriptors';
import { fmtCurrency } from '../../../shared/format';
import { NEEDS_REVIEW, type MerchantQuestion, type Transaction } from '../../../shared/types';

/**
 * The same grouping key the server uses (worker/questions.ts
 * normalizeQuestionMerchant): display cleanup, lowercased. Parity is pinned
 * by tests importing both sides — the count this card promises must agree
 * with what the answer endpoint will actually recategorize.
 */
export function questionMerchantKey(merchant: string): string {
  return cleanBankDescriptor(merchant).toLowerCase();
}

/** The question itself. Honest counts; pluralization handled even though the
 * threshold means 1 never appears in practice. */
export function questionPrompt(
  q: Pick<MerchantQuestion, 'merchant' | 'txCount' | 'total'>,
): string {
  return `You've paid '${q.merchant}' ${q.txCount} ${
    q.txCount === 1 ? 'time' : 'times'
  } (${fmtCurrency(q.total)}). Who is this?`;
}

/** Success toast after an answer. Uses the label the profile was stored with. */
export function answeredMessage(label: string, category: string): string {
  return `Got it — '${label}' filed under ${category}.`;
}

/** Checkbox copy for the apply-to-existing payoff. */
export function applyExistingLabel(count: number): string {
  return `Also apply to ${count} existing 'Needs review' ${
    count === 1 ? 'transaction' : 'transactions'
  }`;
}

/**
 * How many existing 'Needs review' transactions the answer would
 * recategorize — the same scope the server applies (Needs review only,
 * matched on the shared grouping key).
 */
export function countNeedsReview(
  transactions: readonly Pick<Transaction, 'merchant' | 'category'>[],
  questionId: string,
): number {
  let count = 0;
  for (const t of transactions) {
    if (t.category === NEEDS_REVIEW && questionMerchantKey(t.merchant) === questionId) count += 1;
  }
  return count;
}
