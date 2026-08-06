import { describe, expect, it } from 'vitest';
import {
  buildCashFlowSeries,
  buildCategoryBreakdown,
  computeTrend,
  priorWindow,
  upcomingItems,
} from '../src/components/flows/dashboardMath';
import type { RecurringItem, Transaction } from '../shared/types';

function tx(overrides: Partial<Transaction>): Transaction {
  return {
    id: crypto.randomUUID(),
    date: '2026-08-01',
    merchant: 'Test merchant',
    category: 'Other',
    amount: 10,
    type: 'expense',
    account: 'Main Checking',
    tags: [],
    receipt: false,
    source: 'manual',
    fingerprint: Math.random().toString(),
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

const NOW = new Date(2026, 7, 5); // Aug 5, 2026 — matches the session's "today"

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('buildCashFlowSeries', () => {
  it('groups by month, caps at 7 points, most recent last, and flags truncation', () => {
    const txs: Transaction[] = [];
    // 9 months of a single expense each, Dec 2025 .. Aug 2026.
    for (let m = 0; m < 9; m++) {
      const d = new Date(2025, 11 - 2 + m, 15); // rolls year correctly via Date
      txs.push(tx({ date: isoOf(d), amount: 100, type: 'expense' }));
    }
    const { points, truncated } = buildCashFlowSeries(txs, 'all-time', NOW);
    expect(points).toHaveLength(7);
    expect(truncated).toBe(true);
    expect(points[points.length - 1].key <= '2026-08').toBe(true);
    expect(points[0].key < points[points.length - 1].key).toBe(true);
  });

  it('separates income and expense sums per month', () => {
    const txs: Transaction[] = [
      tx({ date: '2026-08-01', amount: 500, type: 'income' }),
      tx({ date: '2026-08-15', amount: 120, type: 'expense' }),
      tx({ date: '2026-08-20', amount: 30, type: 'expense' }),
    ];
    const { points, truncated } = buildCashFlowSeries(txs, 'all-time', NOW);
    expect(points).toHaveLength(1);
    expect(truncated).toBe(false);
    expect(points[0].income).toBe(500);
    expect(points[0].expense).toBe(150);
  });

  it('refilters by the selected period — this-month excludes prior months', () => {
    const txs: Transaction[] = [
      tx({ date: '2026-07-15', amount: 50, type: 'expense' }),
      tx({ date: '2026-08-02', amount: 75, type: 'expense' }),
    ];
    const { points } = buildCashFlowSeries(txs, 'this-month', NOW);
    expect(points).toHaveLength(1);
    expect(points[0].key).toBe('2026-08');
    expect(points[0].expense).toBe(75);
  });

  it('returns no points when there is no data (empty-state trigger)', () => {
    const { points, truncated } = buildCashFlowSeries([], 'all-time', NOW);
    expect(points).toEqual([]);
    expect(truncated).toBe(false);
  });
});

describe('buildCategoryBreakdown', () => {
  it('sums expenses per category and computes percentages', () => {
    const txs: Transaction[] = [
      tx({ date: '2026-08-01', amount: 60, category: 'Groceries' }),
      tx({ date: '2026-08-02', amount: 40, category: 'Dining' }),
      tx({ date: '2026-08-03', amount: 500, type: 'income', category: 'Income' }), // excluded — not an expense
    ];
    const { slices, total } = buildCategoryBreakdown(txs, 'all-time', NOW);
    expect(total).toBe(100);
    expect(slices).toHaveLength(2);
    expect(slices[0].category).toBe('Groceries');
    expect(slices[0].pct).toBe(60);
    expect(slices[1].pct).toBe(40);
  });

  it('folds categories beyond the 8-color ceiling into "Other categories"', () => {
    const cats = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
    const txs = cats.map((c, i) => tx({ date: '2026-08-01', amount: 10 + i, category: c }));
    const { slices } = buildCategoryBreakdown(txs, 'all-time', NOW);
    expect(slices).toHaveLength(9); // 8 real slots + 1 fold bucket
    expect(slices[slices.length - 1].category).toBe('Other categories');
  });

  it('merges a real "Other" category into the fold bucket instead of colliding with it', () => {
    // 10 categories; "Other" is the 8th-highest by amount, so it would otherwise land in the head.
    const cats = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'Other', 'I', 'J'];
    const txs = cats.map((c, i) => tx({ date: '2026-08-01', amount: 100 - i, category: c }));
    const { slices } = buildCategoryBreakdown(txs, 'all-time', NOW);
    expect(slices.filter((s) => s.category === 'Other categories')).toHaveLength(1);
    expect(slices.some((s) => s.category === 'Other')).toBe(false);
    expect(new Set(slices.map((s) => s.id)).size).toBe(slices.length); // synthetic keys stay unique
  });

  it('leaves a real "Other" category as its own slice when there is no overflow', () => {
    const txs = [
      tx({ date: '2026-08-01', amount: 60, category: 'Groceries' }),
      tx({ date: '2026-08-02', amount: 40, category: 'Other' }),
    ];
    const { slices } = buildCategoryBreakdown(txs, 'all-time', NOW);
    expect(slices.map((s) => s.category).sort()).toEqual(['Groceries', 'Other']);
  });

  it('returns no slices when there are no expenses (empty-state trigger)', () => {
    expect(buildCategoryBreakdown([], 'all-time', NOW).slices).toEqual([]);
  });
});

describe('priorWindow', () => {
  it('returns null for all-time (no defined-length prior window)', () => {
    expect(priorWindow('all-time', NOW)).toBeNull();
  });

  it('this-month compares against the full previous calendar month', () => {
    expect(priorWindow('this-month', NOW)).toEqual({ start: '2026-07-01', end: '2026-07-31', label: 'vs last month' });
  });

  it('last-month compares against the full month before that', () => {
    expect(priorWindow('last-month', NOW)).toEqual({
      start: '2026-06-01',
      end: '2026-06-30',
      label: 'vs the month before',
    });
  });

  it('this-year compares against the full previous calendar year', () => {
    expect(priorWindow('this-year', NOW)).toEqual({ start: '2025-01-01', end: '2025-12-31', label: 'vs last year' });
  });

  it('last-3-months compares against an equal-length window immediately before, labeled with real bounds', () => {
    // Current window is 2026-05-05..2026-08-05 (92 days) — prior is the 92 days immediately before it.
    expect(priorWindow('last-3-months', NOW)).toEqual({
      start: '2026-02-01',
      end: '2026-05-04',
      label: 'vs Feb 1 – May 4',
    });
  });

  it('last-6-months prior window spans two different (non-current) years — both get a year suffix', () => {
    // Current window starts 2026-02-05; the 181-day prior window lands entirely in 2025 on
    // the start side and 2026 on the end side, so a bare "Aug 7 – Feb 4" would be ambiguous.
    expect(priorWindow('last-6-months', NOW)).toEqual({
      start: '2025-08-07',
      end: '2026-02-04',
      label: 'vs Aug 7, 2025 – Feb 4, 2026',
    });
  });

  it('a rolling window entirely within one non-current year gets a single trailing year', () => {
    const jan2026 = new Date(2026, 0, 15); // Jan 15, 2026 — the prior 3-month window falls entirely in 2025
    expect(priorWindow('last-3-months', jan2026)).toEqual({
      start: '2025-07-14',
      end: '2025-10-14',
      label: 'vs Jul 14 – Oct 14, 2025',
    });
  });
});

describe('computeTrend', () => {
  it('is not-applicable for all-time (no comparable prior window exists)', () => {
    const trend = computeTrend([tx({ date: '2026-08-01', amount: 100, type: 'income' })], 'all-time', 100, 'income', NOW);
    expect(trend.kind).toBe('not-applicable');
  });

  it('is unavailable when the CURRENT window has no transactions, even if the prior window does', () => {
    const txs = [tx({ date: '2026-07-15', amount: 200, type: 'income' })]; // only prior-month data
    const trend = computeTrend(txs, 'this-month', 0, 'income', NOW);
    expect(trend.kind).toBe('unavailable');
  });

  it('is unavailable when the prior window has no transactions', () => {
    const txs = [tx({ date: '2026-08-01', amount: 100, type: 'income' })];
    const trend = computeTrend(txs, 'this-month', 100, 'income', NOW);
    expect(trend.kind).toBe('unavailable');
  });

  it('computes a signed percent change against the literal previous calendar month', () => {
    const txs = [
      tx({ date: '2026-08-02', amount: 150, type: 'income' }), // this month
      tx({ date: '2026-07-10', amount: 100, type: 'income' }), // full previous month
    ];
    const trend = computeTrend(txs, 'this-month', 150, 'income', NOW);
    expect(trend.kind).toBe('trend');
    expect(trend.pct).toBe(50);
    expect(trend.label).toBe('vs last month');
  });

  it('never divides by a zero baseline (no invented percentages)', () => {
    const txs = [
      tx({ date: '2026-08-02', amount: 150, type: 'income' }),
      tx({ date: '2026-07-10', amount: 40, type: 'expense' }), // prior month has data, but zero prior income
    ];
    const trend = computeTrend(txs, 'this-month', 150, 'income', NOW);
    expect(trend.kind).toBe('unavailable');
  });

  it('does not produce a wildly misleading percentage for a short current-month window', () => {
    // Regression: an equal-length-window approach compared a 5-day this-month
    // slice against a same-length slice of last month, producing +300% when
    // the true full-month comparison was roughly -99.5%.
    const txs = [
      tx({ date: '2026-08-02', amount: 400, type: 'expense' }), // 5 days into August
      tx({ date: '2026-07-01', amount: 80000, type: 'expense' }), // a large full previous month
    ];
    const trend = computeTrend(txs, 'this-month', 400, 'expense', NOW);
    expect(trend.kind).toBe('trend');
    expect(trend.pct).toBeCloseTo(-99.5, 1);
  });
});

describe('upcomingItems', () => {
  function recurring(overrides: Partial<RecurringItem>): RecurringItem {
    return {
      id: crypto.randomUUID(),
      name: 'Test item',
      category: 'Utilities',
      amount: 20,
      cadence: 'monthly',
      nextDate: '2026-08-10',
      active: true,
      ...overrides,
    };
  }

  it('includes active items due within 14 days, sorted soonest first', () => {
    const items = upcomingItems(
      [recurring({ id: 'a', nextDate: '2026-08-12' }), recurring({ id: 'b', nextDate: '2026-08-06' })],
      [recurring({ id: 'c', nextDate: '2026-08-20' })], // beyond the 14-day window
      NOW,
    );
    expect(items.map((i) => i.id)).toEqual(['b', 'a']);
  });

  it('excludes inactive items and items outside the window', () => {
    const items = upcomingItems(
      [recurring({ id: 'a', active: false, nextDate: '2026-08-06' }), recurring({ id: 'b', nextDate: '2026-07-01' })],
      [],
      NOW,
    );
    expect(items).toEqual([]);
  });
});
