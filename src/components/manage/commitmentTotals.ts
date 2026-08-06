// Pure helpers for the Recurring/Subscriptions "same engine, two lenses" pages
// (spec §10–§11). Kept dependency-free from React so they're cheap to unit test.
import { monthlyEquivalent, normalizeMerchant, patternKey } from '../../../shared/detection';
import { toISODate } from '../../../shared/format';
import type { Cadence, DetectedPattern, RecurringItem } from '../../../shared/types';

/**
 * Suggestions must never double-count against an already-confirmed item.
 * A suggestion is "covered" when its stable key (normalized merchant +
 * cadence) matches a confirmed item's own key, regardless of which page
 * confirmed it.
 *
 * ponytail: key-only matching, deliberately reverted from an amount+cadence
 * proximity heuristic that was tried here and proved wrong in review — it
 * suppressed suggestions merchant-blind, so confirming Netflix ($15.49/mo)
 * silently hid Disney+, Hulu, Max, Paramount+, Peacock, and Audible any time
 * their price landed within 5% (streaming prices cluster there constantly),
 * and it worsened with every confirmed item. Worse: a suppressed suggestion
 * was invisible and unrecoverable, since it was never added to
 * dismissedPatterns, so Settings' "Restore ignored suggestions" couldn't
 * bring it back either. That failure mode — a real subscription silently
 * never suggested — is worse than the one this file accepts instead: a
 * renamed confirmed item (edited in the Add/Edit modal, which changes its
 * patternKey) re-suggests itself under the original detected merchant name
 * until the user clicks Ignore once. One recoverable extra suggestion beats
 * an invisible false negative. Upgrade path: store the origin pattern key on
 * the RecurringItem at Keep time and match on that instead of re-deriving it
 * from the (possibly since-edited) name — closes the rename gap without
 * reintroducing merchant-blind matching.
 */
export function dedupeSuggestions(
  suggestions: DetectedPattern[],
  confirmed: RecurringItem[],
): DetectedPattern[] {
  const confirmedKeys = new Set(
    confirmed.map((item) => patternKey(normalizeMerchant(item.name), item.cadence)),
  );
  return suggestions.filter((p) => !confirmedKeys.has(p.key));
}

export interface CommitmentTotals {
  monthly: number;
  annual: number;
  /** Earliest upcoming date (YYYY-MM-DD) across active confirmed items + visible suggestions, or null. */
  nextDate: string | null;
}

/**
 * Combined estimated monthly/annual commitment across active confirmed items
 * AND visible suggestions, without double counting (spec §10/§11). Callers
 * must pass suggestions already filtered through `dedupeSuggestions` so a
 * pattern matching a confirmed item is never included here.
 *
 * `monthly`/`annual` always include every item passed in — the dollar
 * commitment doesn't depend on whether its next date has already elapsed.
 * `nextDate` (the headline "next expected payment/renewal" stat) only
 * considers dates on or after `now`: a confirmed item whose nextDate has
 * gone stale (the user never edited it after the last charge) must not
 * become a permanently-wrong headline.
 *
 * ponytail: a stale nextDate is excluded rather than rolled forward
 * calendar-aware by cadence. Rolling forward would duplicate the detection
 * engine's own date math (shared/detection.ts) here; excluding it is also
 * more honest — Ledgerly genuinely doesn't know the next date until the
 * user edits the item or a fresh suggestion supersedes it. Upgrade path:
 * a shared calendar-aware "advance by cadence" helper, if this turns out
 * to be common enough to need one.
 */
export function computeCommitmentTotals(
  confirmedActive: RecurringItem[],
  visibleSuggestions: DetectedPattern[],
  now: Date = new Date(),
): CommitmentTotals {
  const today = toISODate(now);
  let monthly = 0;
  let nextDate: string | null = null;

  for (const item of confirmedActive) {
    monthly += monthlyEquivalent(item.amount, item.cadence);
    if (item.nextDate >= today && (!nextDate || item.nextDate < nextDate)) nextDate = item.nextDate;
  }
  for (const p of visibleSuggestions) {
    monthly += p.monthlyEquivalent;
    if (p.nextDate >= today && (!nextDate || p.nextDate < nextDate)) nextDate = p.nextDate;
  }

  return { monthly, annual: monthly * 12, nextDate };
}

/** Builds a confirmed RecurringItem/Subscription from a "Keep" action (spec §9.7). */
export function patternToItem(pattern: DetectedPattern): RecurringItem {
  return {
    id: crypto.randomUUID(),
    name: pattern.merchant,
    category: pattern.category,
    amount: Math.round(pattern.averageAmount * 100) / 100,
    cadence: pattern.cadence,
    nextDate: pattern.nextDate,
    account: undefined,
    active: true,
  };
}

export const CADENCE_LABELS: Record<Cadence, string> = {
  weekly: 'Weekly',
  biweekly: 'Biweekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Annual',
};
