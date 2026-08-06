import { describe, expect, it } from 'vitest';
import {
  computeCommitmentTotals,
  dedupeSuggestions,
  patternToItem,
} from '../src/components/manage/commitmentTotals';
import type { DetectedPattern, RecurringItem } from '../shared/types';

// Fixed reference point so date-relative assertions never depend on the
// wall-clock date the test happens to run on.
const NOW = new Date(2026, 7, 15); // August 15, 2026

function pattern(overrides: Partial<DetectedPattern> = {}): DetectedPattern {
  return {
    key: 'netflix|monthly',
    merchant: 'Netflix',
    normalized: 'netflix',
    kind: 'subscription',
    cadence: 'monthly',
    occurrences: 3,
    confidence: 'high',
    averageAmount: 15.49,
    monthlyEquivalent: 15.49,
    nextDate: '2026-09-01',
    lastDate: '2026-08-01',
    category: 'Subscriptions',
    ...overrides,
  };
}

function item(overrides: Partial<RecurringItem> = {}): RecurringItem {
  return {
    id: 'a',
    name: 'Netflix',
    category: 'Subscriptions',
    amount: 15.49,
    cadence: 'monthly',
    nextDate: '2026-09-01',
    active: true,
    ...overrides,
  };
}

describe('dedupeSuggestions', () => {
  it('excludes a suggestion whose key matches a confirmed item', () => {
    const suggestions = [
      pattern({ key: 'netflix|monthly' }),
      pattern({
        key: 'spotify|monthly',
        merchant: 'Spotify',
        normalized: 'spotify',
        averageAmount: 9.99,
        monthlyEquivalent: 9.99,
      }),
    ];
    const confirmed = [item({ name: 'Netflix', cadence: 'monthly', amount: 15.49 })];
    const visible = dedupeSuggestions(suggestions, confirmed);
    expect(visible).toHaveLength(1);
    expect(visible[0].merchant).toBe('Spotify');
  });

  it('keeps a suggestion when the confirmed item has a different cadence and amount', () => {
    const suggestions = [pattern({ key: 'netflix|monthly', averageAmount: 15.49 })];
    const confirmed = [item({ name: 'Netflix', cadence: 'annual', amount: 120 })];
    expect(dedupeSuggestions(suggestions, confirmed)).toHaveLength(1);
  });

  it('is case/punctuation-insensitive via normalized merchant matching', () => {
    const suggestions = [pattern({ key: 'the coffee shop|weekly', cadence: 'weekly' })];
    const confirmed = [item({ name: 'The Coffee Shop #42', cadence: 'weekly' })];
    expect(dedupeSuggestions(suggestions, confirmed)).toHaveLength(0);
  });

  it('regression: a different merchant on the same cadence with a nearby price stays fully visible and counted (no amount-proximity suppression)', () => {
    // A prior version of dedupeSuggestions also suppressed a suggestion when
    // ANY confirmed item shared its cadence and landed within 5% of its
    // amount, meant to catch a renamed confirmed item. Review proved that
    // merchant-blind: confirming Netflix $15.49/monthly silently hid Disney+,
    // Hulu, Max, Paramount+, Peacock, and Audible any time their price
    // clustered within 5% — which streaming prices do constantly — and the
    // suppressed suggestion was invisible and unrecoverable (never added to
    // dismissedPatterns, so Restore ignored suggestions couldn't surface it
    // either). Reverted to key-only matching; this pins that a same-cadence,
    // close-amount, different-merchant suggestion is never suppressed.
    const suggestions = [
      pattern({
        key: 'hulu|monthly',
        merchant: 'Hulu',
        normalized: 'hulu',
        averageAmount: 14.99,
        monthlyEquivalent: 14.99,
        cadence: 'monthly',
        nextDate: '2026-08-20',
      }),
    ];
    const confirmed = [item({ name: 'Netflix', cadence: 'monthly', amount: 15.49 })]; // within 3% of Hulu's price
    const visible = dedupeSuggestions(suggestions, confirmed);
    expect(visible).toHaveLength(1);
    expect(visible[0].merchant).toBe('Hulu');
    // And it must actually count toward the commitment totals, not just
    // render as a card — the double-counting-avoidance math must agree.
    const totals = computeCommitmentTotals([item({ name: 'Netflix', cadence: 'monthly', amount: 15.49, nextDate: '2026-09-01' })], visible, NOW);
    expect(totals.monthly).toBeCloseTo(15.49 + 14.99, 5);
  });

  it('a renamed confirmed item re-suggests under its original key (accepted limitation, not a regression)', () => {
    // ponytail: documents the accepted trade-off from the comment above —
    // renaming a confirmed item changes its patternKey, so the original
    // pattern is no longer suppressed. One recoverable extra suggestion
    // (Ignore it once) beats the invisible false negative the amount-based
    // fix caused.
    const suggestions = [pattern({ key: 'netflix|monthly', merchant: 'Netflix', cadence: 'monthly' })];
    const confirmed = [item({ name: 'Streaming service', cadence: 'monthly', amount: 15.49 })];
    expect(dedupeSuggestions(suggestions, confirmed)).toHaveLength(1);
  });
});

describe('computeCommitmentTotals — no double counting', () => {
  it('sums confirmed active items and visible (already-deduped) suggestions once each', () => {
    const confirmedActive = [
      item({ id: 'a', name: 'Netflix', amount: 15.49, cadence: 'monthly', nextDate: '2026-09-05' }),
      item({ id: 'b', name: 'Gym', amount: 60, cadence: 'monthly', nextDate: '2026-08-20' }),
    ];
    const visibleSuggestions = [
      pattern({ key: 'spotify|monthly', merchant: 'Spotify', monthlyEquivalent: 9.99, nextDate: '2026-08-16' }),
    ];
    const totals = computeCommitmentTotals(confirmedActive, visibleSuggestions, NOW);
    expect(totals.monthly).toBeCloseTo(15.49 + 60 + 9.99, 5);
    expect(totals.annual).toBeCloseTo(totals.monthly * 12, 5);
    expect(totals.nextDate).toBe('2026-08-16');
  });

  it('ignores inactive items entirely (caller filters before calling)', () => {
    const confirmedActive = [item({ amount: 100, cadence: 'monthly', nextDate: '2026-09-01' })];
    const totals = computeCommitmentTotals(confirmedActive, [], NOW);
    expect(totals.monthly).toBe(100);
    expect(totals.annual).toBe(1200);
  });

  it('converts non-monthly cadences to monthly equivalents before summing', () => {
    const confirmedActive = [
      item({ id: 'a', amount: 120, cadence: 'annual', nextDate: '2027-01-01' }),
      item({ id: 'b', amount: 26, cadence: 'biweekly', nextDate: '2026-08-20' }),
    ];
    const totals = computeCommitmentTotals(confirmedActive, [], NOW);
    expect(totals.monthly).toBeCloseTo(120 / 12 + (26 * 26) / 12, 5);
    expect(totals.nextDate).toBe('2026-08-20');
  });

  it('returns null nextDate when there is nothing upcoming', () => {
    expect(computeCommitmentTotals([], [], NOW).nextDate).toBeNull();
  });

  it('never lets a past nextDate become the headline (excludes it, keeps totals intact)', () => {
    // Regression probe from review: a confirmed item whose nextDate elapsed
    // long ago (user never edited it) must not become the permanent headline.
    const confirmedActive = [
      item({ id: 'stale', name: 'Old gym', amount: 40, cadence: 'monthly', nextDate: '2024-03-01' }),
    ];
    const totals = computeCommitmentTotals(confirmedActive, [], NOW);
    expect(totals.nextDate).toBeNull(); // honest "None upcoming" fallback
    expect(totals.monthly).toBe(40); // still counted toward the dollar commitment
  });

  it('picks the earliest future date, skipping a stale one, when both are present', () => {
    const confirmedActive = [
      item({ id: 'stale', name: 'Old gym', amount: 40, cadence: 'monthly', nextDate: '2024-03-01' }),
      item({ id: 'fresh', name: 'Netflix', amount: 15.49, cadence: 'monthly', nextDate: '2026-08-20' }),
    ];
    const totals = computeCommitmentTotals(confirmedActive, [], NOW);
    expect(totals.nextDate).toBe('2026-08-20');
  });

  it('treats `now` itself as upcoming (inclusive lower bound)', () => {
    const confirmedActive = [item({ nextDate: '2026-08-15' })];
    expect(computeCommitmentTotals(confirmedActive, [], NOW).nextDate).toBe('2026-08-15');
  });
});

describe('patternToItem', () => {
  it('builds an active confirmed item from a detected pattern', () => {
    const p = pattern({ merchant: 'Netflix', averageAmount: 15.494, category: 'Subscriptions', cadence: 'monthly', nextDate: '2026-09-01' });
    const built = patternToItem(p);
    expect(built.name).toBe('Netflix');
    expect(built.category).toBe('Subscriptions');
    expect(built.amount).toBeCloseTo(15.49, 2);
    expect(built.cadence).toBe('monthly');
    expect(built.nextDate).toBe('2026-09-01');
    expect(built.active).toBe(true);
    expect(typeof built.id).toBe('string');
    expect(built.id.length).toBeGreaterThan(0);
  });
});

describe("composition: dismissed filter -> dedupeSuggestions -> totals (matches RecurringEngineView's actual pipeline)", () => {
  it('an ignored pattern never reaches totals, a kept one is excluded once confirmed, and the rest still count', () => {
    const rawPatterns = [
      pattern({ key: 'netflix|monthly', merchant: 'Netflix', averageAmount: 15.49, monthlyEquivalent: 15.49, nextDate: '2026-08-20' }),
      pattern({
        key: 'spotify|monthly',
        merchant: 'Spotify',
        normalized: 'spotify',
        averageAmount: 9.99,
        monthlyEquivalent: 9.99,
        nextDate: '2026-08-18',
      }),
      pattern({
        key: 'gym|monthly',
        merchant: 'Gym',
        normalized: 'gym',
        averageAmount: 60,
        monthlyEquivalent: 60,
        nextDate: '2026-08-25',
      }),
    ];
    const dismissedPatterns = ['spotify|monthly']; // user Ignored Spotify
    const confirmed = [
      item({ id: 'x', name: 'Netflix', cadence: 'monthly', amount: 15.49, nextDate: '2026-09-01' }),
    ]; // user Kept Netflix

    // Exact pipeline RecurringEngineView runs on every render.
    const notDismissed = rawPatterns.filter((p) => !dismissedPatterns.includes(p.key));
    const visible = dedupeSuggestions(notDismissed, confirmed);
    const totals = computeCommitmentTotals(confirmed.filter((i) => i.active), visible, NOW);

    // Spotify (ignored) and Netflix (confirmed) are both absent from the
    // suggestions surface; only Gym remains a live suggestion.
    expect(visible.map((p) => p.merchant)).toEqual(['Gym']);
    // Commitment = confirmed Netflix ($15.49) + visible Gym ($60) only —
    // Spotify never contributes (ignored) and Netflix isn't double-counted
    // (confirmed once, not also present in `visible`).
    expect(totals.monthly).toBeCloseTo(15.49 + 60, 5);
    expect(totals.nextDate).toBe('2026-08-25'); // earliest of Netflix's 09-01 and Gym's 08-25
  });
});
