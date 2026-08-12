// Pure helpers for the statement-read preflight flow (sprint 10). Kept
// dependency-free from React so they're cheap to unit test — same convention
// as extractionHelpers/statementHelpers. The honest-cost principle applied to
// money the app itself spends: every number shown here is either returned by
// the free preflight endpoint or derived from a price the user typed in —
// nothing is ever invented client-side.
import { fmtCurrency } from '../../../shared/format';
import type { AiProvider, StatementPreflight } from '../../../shared/types';

/**
 * Providers that can read PDF statements — mirrors the server's selectProvider
 * rules (Workers AI cannot ingest PDFs; Anthropic and Sarvam both can).
 * Single source for the Documents page's disabled state, its banner, and the
 * button tooltip, so the three can never disagree.
 */
export function providerCanReadPdfStatements(provider: AiProvider): boolean {
  return provider === 'anthropic' || provider === 'sarvam';
}

/**
 * Which BYOK provider is selected but missing its stored key — the display
 * name (used verbatim in the "add your key" banner), or null when the active
 * provider is ready. Only the ACTIVE provider's key matters: a stored Sarvam
 * key doesn't make Anthropic ready, and vice versa.
 */
export function missingKeyProvider(
  provider: AiProvider,
  aiKeySet: boolean,
  sarvamKeySet: boolean,
): 'Anthropic' | 'Sarvam' | null {
  if (provider === 'anthropic' && !aiKeySet) return 'Anthropic';
  if (provider === 'sarvam' && !sarvamKeySet) return 'Sarvam';
  return null;
}

/** "This statement is N page(s) and will be read in M batch(es)." — the dialog's first line. */
export function preflightSummary(p: Pick<StatementPreflight, 'pages' | 'batches'>): string {
  const pages = `${p.pages} page${p.pages === 1 ? '' : 's'}`;
  const batches = `${p.batches} batch${p.batches === 1 ? '' : 'es'}`;
  return `This statement is ${pages} and will be read in ${batches}.`;
}

/**
 * The dialog's cost line, or null when the provider has nothing honest to
 * say (shouldn't happen for a provider that can read statements at all).
 * - Sarvam with a saved rate: the arithmetic estimate. The number is
 *   denominated in whatever currency the user entered their Sarvam rate in
 *   (typically the display currency, but possibly not) — so the label
 *   attributes it to "your saved Sarvam rate" rather than asserting it's a
 *   display-currency amount.
 * - Sarvam without a saved rate: point at Settings, no invented number.
 * - Anthropic: per-token billing — static honest copy, never a fake figure,
 *   and never the per-page estimate line even if a cost value sneaks through
 *   (per-page arithmetic doesn't describe per-token billing).
 */
export function preflightCostLine(
  p: Pick<StatementPreflight, 'provider' | 'estimatedCost'>,
): string | null {
  if (p.provider === 'sarvam') {
    if (p.estimatedCost !== null) {
      return `Estimated cost: ~${fmtCurrency(p.estimatedCost)} (your saved Sarvam rate × pages).`;
    }
    return 'Sarvam bills per page — save your rate in Settings for an estimate.';
  }
  if (p.provider === 'anthropic') {
    return 'Anthropic bills per token — typically a few cents per statement.';
  }
  return null;
}

/**
 * Client-side validation for the Settings "Price per page" draft. Blank is
 * valid (it clears the saved price → no estimate, never a guessed one);
 * anything else must parse to a real number greater than 0.
 */
export function sarvamPriceError(draft: string): string | null {
  if (draft.trim() === '') return null;
  const n = Number(draft);
  if (!Number.isFinite(n) || n <= 0) {
    return 'Enter a price greater than 0, or leave blank for no estimate.';
  }
  return null;
}

/**
 * The wire value for a validated price draft: null clears, otherwise the
 * parsed number. Caller must have passed sarvamPriceError first — a draft
 * that fails validation here means a caller bug, so it throws rather than
 * silently coercing an invalid string into a price.
 */
export function parseSarvamPriceDraft(draft: string): number | null {
  if (sarvamPriceError(draft) !== null) {
    throw new Error(`parseSarvamPriceDraft: invalid draft ${JSON.stringify(draft)}`);
  }
  if (draft.trim() === '') return null;
  return Number(draft);
}
