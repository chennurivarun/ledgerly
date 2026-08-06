import { describe, expect, it } from 'vitest';
import { detectPatterns, monthlyEquivalent, normalizeMerchant, patternKey } from '../shared/detection';
import type { Transaction } from '../shared/types';

let idCounter = 0;

function mkTx(overrides: {
  date: string;
  merchant: string;
  amount: number;
  category?: string;
  type?: 'expense' | 'income';
  tags?: string[];
  account?: string;
}): Transaction {
  idCounter++;
  return {
    id: `tx-${idCounter}`,
    date: overrides.date,
    merchant: overrides.merchant,
    category: overrides.category ?? 'Needs review',
    amount: overrides.amount,
    type: overrides.type ?? 'expense',
    account: overrides.account ?? 'Main Checking',
    tags: overrides.tags ?? [],
    receipt: false,
    source: 'manual',
    fingerprint: `${overrides.date}|${overrides.merchant.trim().toLowerCase()}|${overrides.amount.toFixed(2)}|main checking`,
    createdAt: `${overrides.date}T00:00:00.000Z`,
  };
}

describe('normalizeMerchant', () => {
  it('lowercases, trims, and collapses whitespace', () => {
    expect(normalizeMerchant('  Netflix   Inc  ')).toBe('netflix inc');
  });

  it('strips a terminal "#1234" reference', () => {
    expect(normalizeMerchant('Store #1234')).toBe('store');
  });

  it('strips punctuation', () => {
    expect(normalizeMerchant('Netflix.com')).toBe('netflix com');
  });

  it('removes long reference-number digit sequences', () => {
    expect(normalizeMerchant('Payment 123456789 Store')).toBe('payment store');
  });

  it('keeps short numbers that are part of the merchant name', () => {
    expect(normalizeMerchant('7-Eleven')).toBe('7 eleven');
  });
});

describe('patternKey', () => {
  it('is normalized|cadence', () => {
    expect(patternKey('netflix', 'monthly')).toBe('netflix|monthly');
  });

  it('is stable across repeated calls (used for dismissal persistence)', () => {
    expect(patternKey('netflix', 'monthly')).toBe(patternKey('netflix', 'monthly'));
  });
});

describe('monthlyEquivalent', () => {
  it('applies the exact formulas from spec §9.6', () => {
    expect(monthlyEquivalent(100, 'weekly')).toBeCloseTo((100 * 52) / 12, 10);
    expect(monthlyEquivalent(100, 'biweekly')).toBeCloseTo((100 * 26) / 12, 10);
    expect(monthlyEquivalent(100, 'monthly')).toBe(100);
    expect(monthlyEquivalent(300, 'quarterly')).toBeCloseTo(100, 10);
    expect(monthlyEquivalent(1200, 'annual')).toBeCloseTo(100, 10);
  });
});

describe('detectPatterns', () => {
  const NOW = new Date(Date.UTC(2026, 2, 15)); // 2026-03-15

  it('requires at least two unique dates', () => {
    const txs = [mkTx({ date: '2026-01-05', merchant: 'Netflix', amount: 15.99 })];
    expect(detectPatterns(txs, NOW)).toEqual([]);
  });

  it('ignores income transactions', () => {
    const txs = [
      mkTx({ date: '2026-01-05', merchant: 'Payroll', amount: 3000, type: 'income' }),
      mkTx({ date: '2026-02-05', merchant: 'Payroll', amount: 3000, type: 'income' }),
      mkTx({ date: '2026-03-05', merchant: 'Payroll', amount: 3000, type: 'income' }),
    ];
    expect(detectPatterns(txs, NOW)).toEqual([]);
  });

  it('detects Netflix as a high-confidence monthly subscription', () => {
    const txs = [
      mkTx({ date: '2026-01-01', merchant: 'Netflix', amount: 15.99 }),
      mkTx({ date: '2026-02-01', merchant: 'Netflix', amount: 15.99 }),
      mkTx({ date: '2026-03-01', merchant: 'Netflix', amount: 15.99 }),
    ];
    const results = detectPatterns(txs, NOW);
    expect(results).toHaveLength(1);
    const p = results[0];
    expect(p.kind).toBe('subscription');
    expect(p.cadence).toBe('monthly');
    expect(p.confidence).toBe('high');
    expect(p.occurrences).toBe(3);
    expect(p.merchant).toBe('Netflix');
    expect(p.normalized).toBe('netflix');
    expect(p.averageAmount).toBe(15.99);
    expect(p.monthlyEquivalent).toBeCloseTo(15.99, 10);
    expect(p.nextDate).toBe('2026-04-01');
    expect(p.key).toBe(patternKey('netflix', 'monthly'));
  });

  it('treats a category containing "subscription" as a subscription hint', () => {
    const txs = [
      mkTx({ date: '2026-01-10', merchant: 'Generic Media Co', amount: 9.99, category: 'Subscriptions' }),
      mkTx({ date: '2026-02-10', merchant: 'Generic Media Co', amount: 9.99, category: 'Subscriptions' }),
      mkTx({ date: '2026-03-10', merchant: 'Generic Media Co', amount: 9.99, category: 'Subscriptions' }),
    ];
    const results = detectPatterns(txs, NOW);
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe('subscription');
  });

  it('suggests a no-hint merchant with 3+ stable monthly occurrences at <=3% variation', () => {
    const txs = [
      mkTx({ date: '2026-01-02', merchant: 'Acme Storage', amount: 50.0 }),
      mkTx({ date: '2026-02-02', merchant: 'Acme Storage', amount: 50.5 }),
      mkTx({ date: '2026-03-02', merchant: 'Acme Storage', amount: 49.75 }),
    ];
    const results = detectPatterns(txs, NOW);
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe('recurring');
    expect(results[0].cadence).toBe('monthly');
  });

  it('rejects a no-hint merchant whose monthly variation exceeds 3%', () => {
    const txs = [
      mkTx({ date: '2026-01-02', merchant: 'Acme Storage', amount: 50.0 }),
      mkTx({ date: '2026-02-02', merchant: 'Acme Storage', amount: 55.0 }),
      mkTx({ date: '2026-03-02', merchant: 'Acme Storage', amount: 45.0 }),
    ];
    expect(detectPatterns(txs, NOW)).toEqual([]);
  });

  it('does not suggest routine no-hint weekly grocery runs even with stable amounts', () => {
    const txs = [
      mkTx({ date: '2026-01-05', merchant: 'Fresh Market', amount: 60, category: 'Groceries' }),
      mkTx({ date: '2026-01-12', merchant: 'Fresh Market', amount: 61, category: 'Groceries' }),
      mkTx({ date: '2026-01-19', merchant: 'Fresh Market', amount: 59, category: 'Groceries' }),
      mkTx({ date: '2026-01-26', merchant: 'Fresh Market', amount: 60, category: 'Groceries' }),
    ];
    expect(detectPatterns(txs, NOW)).toEqual([]);
  });

  it('never suggests a no-hint weekly merchant even when the name superficially resembles a hint substring', () => {
    // Regression: word-boundary hint matching must not manufacture hints
    // from substrings inside unrelated merchant names. Reviewer-reported
    // false positives: 'hoa' inside "Hoagie Haven", 'water' inside
    // "Waterfront Grill", 'lease' inside "Please & Thank You", 'loan'
    // inside "Sloane Cafe", 'gym' inside "Gymboree Play".
    const fakeHintMerchants = [
      'Hoagie Haven',
      'Waterfront Grill',
      'Please & Thank You',
      'Sloane Cafe',
      'Gymboree Play',
    ];
    for (const merchant of fakeHintMerchants) {
      const txs = [
        mkTx({ date: '2026-01-05', merchant, amount: 60, category: 'Groceries' }),
        mkTx({ date: '2026-01-12', merchant, amount: 60, category: 'Groceries' }),
        mkTx({ date: '2026-01-19', merchant, amount: 60, category: 'Groceries' }),
        mkTx({ date: '2026-01-26', merchant, amount: 60, category: 'Groceries' }),
      ];
      expect(detectPatterns(txs, NOW), `expected no suggestion for "${merchant}"`).toEqual([]);
    }
  });

  it('does not unlock a weekly cadence via a recurring-bill hint alone — no real bill is charged weekly', () => {
    // A §9.4 recurring-bill hint (mortgage/rent/utility/...) must not, by
    // itself, promote a weekly-cadence merchant into a suggestion — only a
    // §9.3 subscription hint can. Reviewer-reported false positives that a
    // hasHint-based weekly gate would incorrectly allow through:
    const recurringBillHintMerchants = [
      'Enterprise Rent A Car',
      'Water Street Deli',
      'Mobile Gas Mart',
      'Electric Avenue Bar',
      'Lease Cafe',
    ];
    for (const merchant of recurringBillHintMerchants) {
      const txs = [
        mkTx({ date: '2026-01-05', merchant, amount: 40 }),
        mkTx({ date: '2026-01-12', merchant, amount: 40 }),
        mkTx({ date: '2026-01-19', merchant, amount: 40 }),
        mkTx({ date: '2026-01-26', merchant, amount: 40 }),
      ];
      expect(detectPatterns(txs, NOW), `expected no suggestion for "${merchant}"`).toEqual([]);
    }
  });

  it('still allows a weekly cadence for a merchant that matches a subscription hint, even if it also reads like a bill/venue name', () => {
    // 'Studio Movie Grill' matches the §9.3 subscription hint 'studio', so
    // — unlike the recurring-bill-hint-only merchants above — this one
    // stays detectable by spec.
    const txs = [
      mkTx({ date: '2026-02-16', merchant: 'Studio Movie Grill', amount: 40 }),
      mkTx({ date: '2026-02-23', merchant: 'Studio Movie Grill', amount: 40 }),
      mkTx({ date: '2026-03-02', merchant: 'Studio Movie Grill', amount: 40 }),
      mkTx({ date: '2026-03-09', merchant: 'Studio Movie Grill', amount: 40 }),
    ];
    const results = detectPatterns(txs, NOW);
    expect(results).toHaveLength(1);
    expect(results[0].cadence).toBe('weekly');
  });

  it('matches plural hint forms via the appended s? on single-word hints (e.g. "Loans")', () => {
    const txs = [
      mkTx({ date: '2026-01-05', merchant: 'Sallie Mae Student Loans', amount: 250 }),
      mkTx({ date: '2026-02-05', merchant: 'Sallie Mae Student Loans', amount: 250 }),
    ];
    const results = detectPatterns(txs, NOW);
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe('recurring');
  });

  it('allows a weekly cadence when a strong hint is present, with >=4 occurrences and <=5% variation', () => {
    const txs = [
      mkTx({ date: '2026-02-16', merchant: 'Anytime Gym', amount: 25 }),
      mkTx({ date: '2026-02-23', merchant: 'Anytime Gym', amount: 25 }),
      mkTx({ date: '2026-03-02', merchant: 'Anytime Gym', amount: 25 }),
      mkTx({ date: '2026-03-09', merchant: 'Anytime Gym', amount: 25 }),
    ];
    const results = detectPatterns(txs, NOW);
    expect(results).toHaveLength(1);
    expect(results[0].cadence).toBe('weekly');
    expect(results[0].kind).toBe('subscription');
  });

  it('rejects a weekly hinted merchant with fewer than 4 occurrences', () => {
    const txs = [
      mkTx({ date: '2026-02-23', merchant: 'Anytime Gym', amount: 25 }),
      mkTx({ date: '2026-03-02', merchant: 'Anytime Gym', amount: 25 }),
      mkTx({ date: '2026-03-09', merchant: 'Anytime Gym', amount: 25 }),
    ];
    expect(detectPatterns(txs, NOW)).toEqual([]);
  });

  it('rejects a weekly hinted merchant whose variation exceeds 5%', () => {
    const txs = [
      mkTx({ date: '2026-02-16', merchant: 'Anytime Gym', amount: 25 }),
      mkTx({ date: '2026-02-23', merchant: 'Anytime Gym', amount: 25 }),
      mkTx({ date: '2026-03-02', merchant: 'Anytime Gym', amount: 25 }),
      mkTx({ date: '2026-03-09', merchant: 'Anytime Gym', amount: 30 }), // >5% deviation from mean
    ];
    expect(detectPatterns(txs, NOW)).toEqual([]);
  });

  it('falls back to "recurring" when a subscription-hint merchant\'s variation is just over 20% but within 35%', () => {
    const txs = [
      mkTx({ date: '2026-01-01', merchant: 'Netflix', amount: 10 }),
      mkTx({ date: '2026-02-01', merchant: 'Netflix', amount: 10 }),
      mkTx({ date: '2026-03-01', merchant: 'Netflix', amount: 15 }),
    ];
    // mean = 11.667, max deviation = 3.333 -> variation ~28.6% (>20%, <=35%)
    const results = detectPatterns(txs, NOW);
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe('recurring');
  });

  it('rejects a subscription-hint merchant entirely when variation exceeds 35%', () => {
    const txs = [
      mkTx({ date: '2026-01-01', merchant: 'Netflix', amount: 10 }),
      mkTx({ date: '2026-02-01', merchant: 'Netflix', amount: 10 }),
      mkTx({ date: '2026-03-01', merchant: 'Netflix', amount: 20 }),
    ];
    // mean = 13.33, max deviation = 6.67 -> variation = 50% (>35%)
    expect(detectPatterns(txs, NOW)).toEqual([]);
  });

  it('classifies a 24-day dominant interval as monthly (lower window edge)', () => {
    const txs = [
      mkTx({ date: '2026-01-01', merchant: 'Netflix', amount: 10 }),
      mkTx({ date: '2026-01-25', merchant: 'Netflix', amount: 10 }),
    ];
    const results = detectPatterns(txs, NOW);
    expect(results).toHaveLength(1);
    expect(results[0].cadence).toBe('monthly');
  });

  it('classifies a 40-day dominant interval as monthly (upper window edge)', () => {
    const txs = [
      mkTx({ date: '2026-01-01', merchant: 'Netflix', amount: 10 }),
      mkTx({ date: '2026-02-10', merchant: 'Netflix', amount: 10 }),
    ];
    const results = detectPatterns(txs, NOW);
    expect(results).toHaveLength(1);
    expect(results[0].cadence).toBe('monthly');
  });

  it('rejects a 23-day dominant interval (fits no window)', () => {
    const txs = [
      mkTx({ date: '2026-01-01', merchant: 'Netflix', amount: 10 }),
      mkTx({ date: '2026-01-24', merchant: 'Netflix', amount: 10 }),
    ];
    expect(detectPatterns(txs, NOW)).toEqual([]);
  });

  it('rejects a 41-day dominant interval (fits no window)', () => {
    const txs = [
      mkTx({ date: '2026-01-01', merchant: 'Netflix', amount: 10 }),
      mkTx({ date: '2026-02-11', merchant: 'Netflix', amount: 10 }),
    ];
    expect(detectPatterns(txs, NOW)).toEqual([]);
  });

  it('downgrades confidence to "likely" when interval jitter exceeds 5 days', () => {
    const txs = [
      mkTx({ date: '2026-01-01', merchant: 'Spotify', amount: 9.99 }),
      mkTx({ date: '2026-01-31', merchant: 'Spotify', amount: 9.99 }), // +30
      mkTx({ date: '2026-03-10', merchant: 'Spotify', amount: 9.99 }), // +38
    ];
    const results = detectPatterns(txs, NOW);
    expect(results).toHaveLength(1);
    expect(results[0].occurrences).toBe(3);
    expect(results[0].confidence).toBe('likely');
  });

  it('uses the median interval so a single stray gap does not hijack cadence classification (reviewer case a: Rent)', () => {
    // Rent charged 1/1, 1/8 (early, e.g. a bank holiday shift), 2/1, 3/1 at
    // $1500. Intervals [7, 24, 28] — a mode-with-smallest-tiebreak would
    // pick "7" (weekly) and report a $6500/mo equivalent; the median (24)
    // correctly classifies this as monthly with a $1500/mo equivalent.
    const txs = [
      mkTx({ date: '2026-01-01', merchant: 'Rent Co', amount: 1500, category: 'Housing' }),
      mkTx({ date: '2026-01-08', merchant: 'Rent Co', amount: 1500, category: 'Housing' }),
      mkTx({ date: '2026-02-01', merchant: 'Rent Co', amount: 1500, category: 'Housing' }),
      mkTx({ date: '2026-03-01', merchant: 'Rent Co', amount: 1500, category: 'Housing' }),
    ];
    const results = detectPatterns(txs, NOW);
    expect(results).toHaveLength(1);
    expect(results[0].cadence).toBe('monthly');
    expect(results[0].averageAmount).toBe(1500);
    expect(results[0].monthlyEquivalent).toBeCloseTo(1500, 10);
  });

  it('uses the median interval so a stray extra charge does not reject a real monthly pattern (reviewer case b: Netflix + stray)', () => {
    // Netflix 1/1, 2/1, 3/1 plus a stray extra charge on 3/5. Intervals
    // [31, 28, 4] — a mode-with-smallest-tiebreak would pick "4", which
    // fits no cadence window, and reject the whole group. The median (28)
    // correctly recognizes the monthly pattern.
    const txs = [
      mkTx({ date: '2026-01-01', merchant: 'Netflix', amount: 15.99 }),
      mkTx({ date: '2026-02-01', merchant: 'Netflix', amount: 15.99 }),
      mkTx({ date: '2026-03-01', merchant: 'Netflix', amount: 15.99 }),
      mkTx({ date: '2026-03-05', merchant: 'Netflix', amount: 15.99 }),
    ];
    const results = detectPatterns(txs, NOW);
    expect(results).toHaveLength(1);
    expect(results[0].cadence).toBe('monthly');
  });

  it('uses the median interval for an even-length interval set without hijacking to weekly (5 dates, 4 intervals)', () => {
    // 1/1, 1/8, 1/15 (weekly-looking start), then 2/15, 3/15 (settles into
    // monthly). Intervals [7, 7, 31, 28] — a plain mode picks "7" (count 2)
    // over the two single-count monthly-range intervals; the median (upper
    // of the two middle values, sorted [7,7,28,31] -> index 2 = 28)
    // correctly lands on monthly.
    const txs = [
      mkTx({ date: '2026-01-01', merchant: 'Netflix', amount: 15.99 }),
      mkTx({ date: '2026-01-08', merchant: 'Netflix', amount: 15.99 }),
      mkTx({ date: '2026-01-15', merchant: 'Netflix', amount: 15.99 }),
      mkTx({ date: '2026-02-15', merchant: 'Netflix', amount: 15.99 }),
      mkTx({ date: '2026-03-15', merchant: 'Netflix', amount: 15.99 }),
    ];
    const results = detectPatterns(txs, NOW);
    expect(results).toHaveLength(1);
    expect(results[0].cadence).toBe('monthly');
  });

  it('clamps end-of-month rollover: Jan 31 monthly advances to Feb 28', () => {
    const txs = [
      mkTx({ date: '2025-12-31', merchant: 'City Mortgage', amount: 1500, category: 'Housing' }),
      mkTx({ date: '2026-01-31', merchant: 'City Mortgage', amount: 1500, category: 'Housing' }),
    ];
    const results = detectPatterns(txs, new Date(Date.UTC(2026, 0, 15)));
    expect(results).toHaveLength(1);
    expect(results[0].cadence).toBe('monthly');
    expect(results[0].nextDate).toBe('2026-02-28');
  });

  it('clamps end-of-month rollover into a leap February (Jan 31 2027 case using 2028 leap year)', () => {
    const txs = [
      mkTx({ date: '2027-12-31', merchant: 'City Mortgage', amount: 1500, category: 'Housing' }),
      mkTx({ date: '2028-01-31', merchant: 'City Mortgage', amount: 1500, category: 'Housing' }),
    ];
    const results = detectPatterns(txs, new Date(Date.UTC(2028, 0, 15)));
    expect(results).toHaveLength(1);
    expect(results[0].nextDate).toBe('2028-02-29'); // 2028 is a leap year
  });

  it('recovers the true day-of-month anchor after an intermediate month-end clamp', () => {
    // Last occurrence Jan 31 -> naive next is Feb 28 (clamped, Feb has no
    // 31st), which is before `now` (Mar 15), so it hops again from Feb 28
    // using the ORIGINAL anchor (31, not 28) -> March has 31 days, so the
    // anchor recovers to Mar 31 rather than sticking at the clamped day.
    const txs = [
      mkTx({ date: '2025-12-31', merchant: 'City Mortgage', amount: 1500, category: 'Housing' }),
      mkTx({ date: '2026-01-31', merchant: 'City Mortgage', amount: 1500, category: 'Housing' }),
    ];
    const results = detectPatterns(txs, new Date(Date.UTC(2026, 2, 15))); // now = 2026-03-15
    expect(results).toHaveLength(1);
    expect(results[0].nextDate).toBe('2026-03-31');
  });

  it('advances the next date past `now` by one cadence hop when still within the alive window', () => {
    const txs = [
      mkTx({ date: '2026-01-15', merchant: 'Anytime Gym', amount: 25 }),
      mkTx({ date: '2026-02-15', merchant: 'Anytime Gym', amount: 25 }),
      mkTx({ date: '2026-03-15', merchant: 'Anytime Gym', amount: 25 }),
    ];
    // last occurrence 2026-03-15 -> naive next 2026-04-15, which is before
    // `now` (2026-05-01), so it hops once more to 2026-05-15. That's still
    // within the 2-cadence-period "alive" window (up to 2026-05-15), so the
    // pattern is suggested rather than treated as dead.
    const results = detectPatterns(txs, new Date(Date.UTC(2026, 4, 1))); // 2026-05-01
    expect(results).toHaveLength(1);
    expect(results[0].nextDate).toBe('2026-05-15');
  });

  it('still rejects a genuinely dead pattern when the dataset has recent activity elsewhere (2019 gym inside a 2026 dataset)', () => {
    // A 2019 gym membership must not appear as a live 2026 commitment, even
    // though the recency reference is capped by the dataset's own latest
    // activity (see below) — here that latest activity (Coffee Shop, June
    // 2026) is itself recent, so the reference stays anchored near real
    // `now` and the long-dead gym pattern is still correctly rejected.
    const txs = [
      mkTx({ date: '2019-01-15', merchant: 'Anytime Gym', amount: 25 }),
      mkTx({ date: '2019-02-15', merchant: 'Anytime Gym', amount: 25 }),
      mkTx({ date: '2019-03-15', merchant: 'Anytime Gym', amount: 25 }),
      mkTx({ date: '2026-06-01', merchant: 'Coffee Shop', amount: 4.5 }),
    ];
    expect(detectPatterns(txs, new Date(Date.UTC(2026, 5, 15)))).toEqual([]);
  });

  it('does not treat a fully historical import as dead relative to unrelated real-world wall-clock time (2025-only dataset stays alive)', () => {
    // The entire imported dataset is confined to 2025 — nothing in the
    // batch extends past Dec 2025. Recency is judged against the latest
    // activity actually present in the dataset (Dec 2025), not literal
    // wall-clock "today" (2026-08 here), so a pattern that was clearly live
    // through the end of the imported statement isn't wrongly killed just
    // because today's real date happens to be much later than anything the
    // import contains. Without this floor, EVERY pattern in a purely
    // historical import would show zero suggestions.
    const txs = [
      mkTx({ date: '2025-01-05', merchant: 'City Mortgage', amount: 1500, category: 'Housing' }),
      mkTx({ date: '2025-02-05', merchant: 'City Mortgage', amount: 1500, category: 'Housing' }),
      mkTx({ date: '2025-03-05', merchant: 'City Mortgage', amount: 1500, category: 'Housing' }),
      mkTx({ date: '2025-04-05', merchant: 'City Mortgage', amount: 1500, category: 'Housing' }),
      mkTx({ date: '2025-05-05', merchant: 'City Mortgage', amount: 1500, category: 'Housing' }),
      mkTx({ date: '2025-06-05', merchant: 'City Mortgage', amount: 1500, category: 'Housing' }),
      mkTx({ date: '2025-07-05', merchant: 'City Mortgage', amount: 1500, category: 'Housing' }),
      mkTx({ date: '2025-08-05', merchant: 'City Mortgage', amount: 1500, category: 'Housing' }),
      mkTx({ date: '2025-09-05', merchant: 'City Mortgage', amount: 1500, category: 'Housing' }),
      mkTx({ date: '2025-10-05', merchant: 'City Mortgage', amount: 1500, category: 'Housing' }),
      mkTx({ date: '2025-11-05', merchant: 'City Mortgage', amount: 1500, category: 'Housing' }),
      mkTx({ date: '2025-12-05', merchant: 'City Mortgage', amount: 1500, category: 'Housing' }),
    ];
    // Real wall-clock "today" is 2026-08-05 — 8 months past the last
    // transaction, which would fail the raw 2-period (2 month) rule.
    const results = detectPatterns(txs, new Date(Date.UTC(2026, 7, 5)));
    expect(results).toHaveLength(1);
    expect(results[0].cadence).toBe('monthly');
  });

  it('treats a pattern exactly at the 2-cadence-period boundary (relative to the dataset\'s own recency reference) as still alive', () => {
    const txs = [
      mkTx({ date: '2025-12-15', merchant: 'Anytime Gym', amount: 25 }),
      mkTx({ date: '2026-01-15', merchant: 'Anytime Gym', amount: 25 }),
      // Anchors the recency reference at 2026-03-15 (earlier than `now`
      // below, so it — not wall-clock `now` — becomes the binding reference).
      mkTx({ date: '2026-03-15', merchant: 'Coffee Shop', amount: 4.5 }),
    ];
    // last gym occurrence 2026-01-15 + 2 monthly hops = 2026-03-15, exactly
    // equal to the recency reference (not strictly before it) -> alive.
    const results = detectPatterns(txs, new Date(Date.UTC(2026, 5, 1)));
    expect(results).toHaveLength(1);
    expect(results[0].normalized).toBe('anytime gym');
  });

  it('treats multiple same-day charges as a single occurrence', () => {
    const txs = [
      mkTx({ date: '2026-01-01', merchant: 'Netflix', amount: 15.99 }),
      mkTx({ date: '2026-01-01', merchant: 'Netflix', amount: 15.99 }), // same day, e.g. a retry/second charge
      mkTx({ date: '2026-02-01', merchant: 'Netflix', amount: 15.99 }),
      mkTx({ date: '2026-03-01', merchant: 'Netflix', amount: 15.99 }),
    ];
    const results = detectPatterns(txs, NOW);
    expect(results).toHaveLength(1);
    expect(results[0].occurrences).toBe(3);
  });

  it('produces a stable dismissal key matching patternKey(normalized, cadence)', () => {
    const txs = [
      mkTx({ date: '2026-01-01', merchant: 'Netflix', amount: 15.99 }),
      mkTx({ date: '2026-02-01', merchant: 'Netflix', amount: 15.99 }),
      mkTx({ date: '2026-03-01', merchant: 'Netflix', amount: 15.99 }),
    ];
    const [first] = detectPatterns(txs, NOW);
    const [second] = detectPatterns(txs, NOW);
    expect(first.key).toBe(patternKey(first.normalized, first.cadence));
    expect(first.key).toBe(second.key);
    expect(first.key).toBe('netflix|monthly');
  });

  it('breaks a category tie deterministically by preferring the most recent transaction\'s category', () => {
    const txs = [
      mkTx({ date: '2026-01-05', merchant: 'Brightline Storage Co', amount: 70, category: 'Utilities' }),
      mkTx({ date: '2026-02-05', merchant: 'Brightline Storage Co', amount: 70, category: 'Bills' }),
      mkTx({ date: '2026-03-05', merchant: 'Brightline Storage Co', amount: 70, category: 'Utilities' }),
      mkTx({ date: '2026-04-05', merchant: 'Brightline Storage Co', amount: 70, category: 'Bills' }),
    ];
    // Utilities and Bills are tied 2-2; the most recent transaction (Apr 5)
    // is 'Bills', which is among the tied leaders, so it wins — regardless
    // of the caller's array order (oldest-first here).
    const results = detectPatterns(txs, new Date(Date.UTC(2026, 3, 20)));
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe('Bills');
  });

  it('breaks a category tie alphabetically when the most recent category is not among the tied leaders', () => {
    const txs = [
      mkTx({ date: '2026-01-05', merchant: 'Lakeside Storage LLC', amount: 80, category: 'Zeta' }),
      mkTx({ date: '2026-02-05', merchant: 'Lakeside Storage LLC', amount: 80, category: 'Alpha' }),
      mkTx({ date: '2026-03-05', merchant: 'Lakeside Storage LLC', amount: 80, category: 'Zeta' }),
      mkTx({ date: '2026-04-05', merchant: 'Lakeside Storage LLC', amount: 80, category: 'Alpha' }),
      mkTx({ date: '2026-05-05', merchant: 'Lakeside Storage LLC', amount: 80, category: 'Beta' }),
    ];
    // Zeta and Alpha are tied 2-2; the most recent transaction (May 5) is
    // 'Beta', which is NOT among the tied leaders, so it falls back to
    // alphabetical order among {Zeta, Alpha} -> 'Alpha'.
    const results = detectPatterns(txs, new Date(Date.UTC(2026, 4, 20)));
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe('Alpha');
  });
});
