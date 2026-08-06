import { describe, expect, it } from 'vitest';
import { detectPatterns, nextCadenceDate, patternKey } from '../shared/detection';
import { FORECAST_HORIZONS, buildForecast, isoDayOffset } from '../shared/forecast';
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

const NONE = new Set<string>();

describe('nextCadenceDate', () => {
  it('clamps a monthly step at a short month end (Jan 31 -> Feb 28)', () => {
    expect(nextCadenceDate('2026-01-31', 'monthly', 31)).toBe('2026-02-28');
  });

  it('recovers the anchor day after an intermediate clamp (Feb 28 with anchor 31 -> Mar 31)', () => {
    expect(nextCadenceDate('2026-02-28', 'monthly', 31)).toBe('2026-03-31');
  });

  it('steps weekly/biweekly by plain day arithmetic across a month boundary', () => {
    expect(nextCadenceDate('2026-01-30', 'weekly', 30)).toBe('2026-02-06');
    expect(nextCadenceDate('2026-01-30', 'biweekly', 30)).toBe('2026-02-13');
  });

  it('clamps quarterly and annual steps to the target month length', () => {
    expect(nextCadenceDate('2026-01-31', 'quarterly', 31)).toBe('2026-04-30');
    // Leap day + 1 year lands on the last day of a non-leap February.
    expect(nextCadenceDate('2028-02-29', 'annual', 29)).toBe('2029-02-28');
  });
});

describe('detectPatterns type parameterization', () => {
  const NOW = new Date(Date.UTC(2026, 2, 15)); // 2026-03-15

  const netflixTxs = [
    mkTx({ date: '2026-01-01', merchant: 'Netflix', amount: 15.99 }),
    mkTx({ date: '2026-02-01', merchant: 'Netflix', amount: 15.99 }),
    mkTx({ date: '2026-03-01', merchant: 'Netflix', amount: 15.99 }),
  ];
  const payrollTxs = [
    mkTx({ date: '2026-01-05', merchant: 'Payroll', amount: 3000, type: 'income' }),
    mkTx({ date: '2026-02-05', merchant: 'Payroll', amount: 3000, type: 'income' }),
    mkTx({ date: '2026-03-05', merchant: 'Payroll', amount: 3000, type: 'income' }),
  ];

  it('leaves the default (no opts) call byte-identical to an explicit { type: "expense" } call', () => {
    const mixed = [...netflixTxs, ...payrollTxs];
    expect(detectPatterns(mixed, NOW)).toEqual(detectPatterns(mixed, NOW, { type: 'expense' }));
  });

  it('detects each type only on its own pass of a mixed ledger (spot-pin of the pre-existing expense behavior)', () => {
    const mixed = [...netflixTxs, ...payrollTxs];

    // Default pass: exactly the spec-§9 expense result, income invisible.
    const expense = detectPatterns(mixed, NOW);
    expect(expense).toHaveLength(1);
    expect(expense[0].key).toBe('netflix|monthly');
    expect(expense[0].kind).toBe('subscription');
    expect(expense[0].nextDate).toBe('2026-04-01');

    // Income pass: same machinery, income group only.
    const income = detectPatterns(mixed, NOW, { type: 'income' });
    expect(income).toHaveLength(1);
    const p = income[0];
    expect(p.key).toBe(patternKey('payroll', 'monthly'));
    expect(p.kind).toBe('recurring');
    expect(p.cadence).toBe('monthly');
    expect(p.confidence).toBe('high');
    expect(p.averageAmount).toBe(3000);
    expect(p.monthlyEquivalent).toBe(3000);
    expect(p.nextDate).toBe('2026-04-05');
  });

  it('gates subscription hints to expense: variable "Patreon" income must pass the strict no-hint cutoff (and fails it here)', () => {
    // Variation ~6.5% (>3%). With the (expense-flavored) 'patreon' hint
    // gated off for income, the strict no-hint stability gate applies and
    // rejects the group; a leaked hint would have accepted it (<=20%).
    const txs = [
      mkTx({ date: '2026-01-10', merchant: 'Patreon', amount: 100, type: 'income' }),
      mkTx({ date: '2026-02-10', merchant: 'Patreon', amount: 110, type: 'income' }),
      mkTx({ date: '2026-03-10', merchant: 'Patreon', amount: 100, type: 'income' }),
    ];
    expect(detectPatterns(txs, NOW, { type: 'income' })).toEqual([]);
  });

  it('never labels income a "subscription", even when merchant AND category both carry hints', () => {
    const txs = [
      mkTx({ date: '2026-01-10', merchant: 'Patreon', amount: 100, type: 'income', category: 'Subscriptions' }),
      mkTx({ date: '2026-02-10', merchant: 'Patreon', amount: 100, type: 'income', category: 'Subscriptions' }),
      mkTx({ date: '2026-03-10', merchant: 'Patreon', amount: 100, type: 'income', category: 'Subscriptions' }),
    ];
    const results = detectPatterns(txs, NOW, { type: 'income' });
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe('recurring');
  });

  it('keeps the subscription hint live for the same merchant as an expense (the gate is type-scoped, not removed)', () => {
    const txs = [
      mkTx({ date: '2026-01-10', merchant: 'Patreon', amount: 100 }),
      mkTx({ date: '2026-02-10', merchant: 'Patreon', amount: 100 }),
      mkTx({ date: '2026-03-10', merchant: 'Patreon', amount: 100 }),
    ];
    const results = detectPatterns(txs, NOW);
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe('subscription');
  });

  it('does not detect biweekly income: weekly/biweekly cadences unlock only via the (expense-only) subscription hint', () => {
    // Known, deliberate constraint of running the IDENTICAL machinery: the
    // §9.5 weekly/biweekly guard requires a subscription hint, and hints
    // are expense-gated — so a biweekly paycheck is not surfaced.
    const txs = [
      mkTx({ date: '2026-01-02', merchant: 'Payroll', amount: 3000, type: 'income' }),
      mkTx({ date: '2026-01-16', merchant: 'Payroll', amount: 3000, type: 'income' }),
      mkTx({ date: '2026-01-30', merchant: 'Payroll', amount: 3000, type: 'income' }),
      mkTx({ date: '2026-02-13', merchant: 'Payroll', amount: 3000, type: 'income' }),
    ];
    expect(detectPatterns(txs, new Date(Date.UTC(2026, 1, 20)), { type: 'income' })).toEqual([]);
  });
});

describe('buildForecast', () => {
  it('returns the correctly-dated empty forecast for an empty ledger at every horizon', () => {
    const expectedEnds: Record<number, string> = {
      30: '2026-04-14',
      60: '2026-05-14',
      90: '2026-06-13',
    };
    for (const horizon of FORECAST_HORIZONS) {
      const f = buildForecast([], NONE, horizon, '2026-03-15');
      expect(f.start).toBe('2026-03-16');
      expect(f.end).toBe(expectedEnds[horizon]);
      expect(f.end).toBe(isoDayOffset('2026-03-15', horizon));
      expect(f.horizonDays).toBe(horizon);
      expect(f.occurrences).toEqual([]);
      // Honest empty state: no points at all, not a flat zero line.
      expect(f.points).toEqual([]);
      expect(f.totalIn).toBe(0);
      expect(f.totalOut).toBe(0);
      expect(f.net).toBe(0);
      expect(f.expenseSeries).toBe(0);
      expect(f.incomeSeries).toBe(0);
    }
  });

  it('returns the empty forecast when the ledger has no detectable pattern', () => {
    const txs = [mkTx({ date: '2026-03-01', merchant: 'Coffee Shop', amount: 4.5 })];
    const f = buildForecast(txs, NONE, 30, '2026-03-15');
    expect(f.occurrences).toEqual([]);
    expect(f.points).toEqual([]);
    expect(f.expenseSeries).toBe(0);
    expect(f.incomeSeries).toBe(0);
  });

  it('projects a monthly 31st-anchored pattern across 30/60/90 days with engine-exact clamping', () => {
    const txs = [
      mkTx({ date: '2025-12-31', merchant: 'City Mortgage', amount: 1500, category: 'Housing' }),
      mkTx({ date: '2026-01-31', merchant: 'City Mortgage', amount: 1500, category: 'Housing' }),
    ];
    // nextDate is 2026-02-28 (Feb clamp); the projection must then recover
    // the 31 anchor (Mar 31) and clamp again through 30-day April (Apr 30).
    const dates = (h: 30 | 60 | 90) =>
      buildForecast(txs, NONE, h, '2026-02-15').occurrences.map((o) => o.date);
    expect(dates(30)).toEqual(['2026-02-28']);
    expect(dates(60)).toEqual(['2026-02-28', '2026-03-31']);
    expect(dates(90)).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
  });

  it('surfaces the full pattern on each occurrence (key, merchant, amount, type, cadence, confidence, category)', () => {
    const txs = [
      mkTx({ date: '2025-12-31', merchant: 'City Mortgage', amount: 1500, category: 'Housing' }),
      mkTx({ date: '2026-01-31', merchant: 'City Mortgage', amount: 1500, category: 'Housing' }),
    ];
    const f = buildForecast(txs, NONE, 30, '2026-02-15');
    expect(f.occurrences).toEqual([
      {
        key: 'city mortgage|monthly',
        date: '2026-02-28',
        merchant: 'City Mortgage',
        amount: 1500,
        type: 'expense',
        cadence: 'monthly',
        confidence: 'likely', // only 2 observed occurrences
        category: 'Housing',
      },
    ]);
    expect(f.expenseSeries).toBe(1);
    expect(f.incomeSeries).toBe(0);
  });

  it('projects a weekly pattern across a month boundary by day arithmetic', () => {
    const txs = [
      mkTx({ date: '2025-12-29', merchant: 'Anytime Gym', amount: 25 }),
      mkTx({ date: '2026-01-05', merchant: 'Anytime Gym', amount: 25 }),
      mkTx({ date: '2026-01-12', merchant: 'Anytime Gym', amount: 25 }),
      mkTx({ date: '2026-01-19', merchant: 'Anytime Gym', amount: 25 }),
    ];
    const f = buildForecast(txs, NONE, 30, '2026-01-20');
    expect(f.occurrences.map((o) => o.date)).toEqual([
      '2026-01-26',
      '2026-02-02',
      '2026-02-09',
      '2026-02-16',
    ]);
    expect(f.totalOut).toBe(100);
    expect(f.points).toHaveLength(30);
  });

  it('advances an overdue pattern by whole cadence periods — no fabricated catch-up occurrence inside the window', () => {
    // Rent lands on the 1st; today is Feb 20, so the Feb 1 charge is simply
    // late. The engine advances nextDate to Mar 1 — the forecast must show
    // ONLY Mar 1, never a make-up charge squeezed in right after `start`.
    const txs = [
      mkTx({ date: '2025-11-01', merchant: 'Rent Co', amount: 1500, category: 'Housing' }),
      mkTx({ date: '2025-12-01', merchant: 'Rent Co', amount: 1500, category: 'Housing' }),
      mkTx({ date: '2026-01-01', merchant: 'Rent Co', amount: 1500, category: 'Housing' }),
    ];
    const f = buildForecast(txs, NONE, 30, '2026-02-20');
    expect(f.start).toBe('2026-02-21');
    expect(f.occurrences.map((o) => o.date)).toEqual(['2026-03-01']);
    expect(f.expenseSeries).toBe(1);
  });

  it('rolls a due-today pattern one full cadence forward (the window starts tomorrow; only cadence-landing dates appear)', () => {
    // nextDate is exactly `today` (2026-02-15) — before `start`. The next
    // date the cadence lands on is Mar 15; nothing appears earlier.
    const txs = [
      mkTx({ date: '2025-12-15', merchant: 'Netflix', amount: 15.99 }),
      mkTx({ date: '2026-01-15', merchant: 'Netflix', amount: 15.99 }),
    ];
    const f = buildForecast(txs, NONE, 30, '2026-02-15');
    expect(f.occurrences.map((o) => o.date)).toEqual(['2026-03-15']);
    expect(f.occurrences.every((o) => o.date >= f.start)).toBe(true);
  });

  it('excludes a dismissed pattern key entirely', () => {
    const txs = [
      mkTx({ date: '2026-01-01', merchant: 'Netflix', amount: 15.99 }),
      mkTx({ date: '2026-02-01', merchant: 'Netflix', amount: 15.99 }),
      mkTx({ date: '2026-03-01', merchant: 'Netflix', amount: 15.99 }),
    ];
    const kept = buildForecast(txs, NONE, 30, '2026-03-15');
    expect(kept.occurrences).toHaveLength(1); // control: contributes when not dismissed
    const dismissed = buildForecast(txs, new Set(['netflix|monthly']), 30, '2026-03-15');
    expect(dismissed.occurrences).toEqual([]);
    expect(dismissed.points).toEqual([]);
    expect(dismissed.expenseSeries).toBe(0);
  });

  it('accumulates income and expense with correct signs into daily cumulative points', () => {
    const txs = [
      mkTx({ date: '2026-01-01', merchant: 'Netflix', amount: 15.99 }),
      mkTx({ date: '2026-02-01', merchant: 'Netflix', amount: 15.99 }),
      mkTx({ date: '2026-03-01', merchant: 'Netflix', amount: 15.99 }),
      mkTx({ date: '2026-01-05', merchant: 'Payroll', amount: 3000, type: 'income' }),
      mkTx({ date: '2026-02-05', merchant: 'Payroll', amount: 3000, type: 'income' }),
      mkTx({ date: '2026-03-05', merchant: 'Payroll', amount: 3000, type: 'income' }),
    ];
    const f = buildForecast(txs, NONE, 30, '2026-03-15');
    expect(f.expenseSeries).toBe(1);
    expect(f.incomeSeries).toBe(1);
    expect(f.occurrences.map((o) => [o.date, o.type])).toEqual([
      ['2026-04-01', 'expense'],
      ['2026-04-05', 'income'],
    ]);

    // One point per day, start..end inclusive, cumulative from 0.
    expect(f.points).toHaveLength(30);
    expect(f.points[0]).toEqual({ date: '2026-03-16', in: 0, out: 0, net: 0 });
    const beforeAny = f.points.find((p) => p.date === '2026-03-31');
    expect(beforeAny).toEqual({ date: '2026-03-31', in: 0, out: 0, net: 0 });
    const onExpense = f.points.find((p) => p.date === '2026-04-01');
    expect(onExpense).toEqual({ date: '2026-04-01', in: 0, out: 15.99, net: -15.99 });
    const onIncome = f.points.find((p) => p.date === '2026-04-05');
    expect(onIncome).toEqual({ date: '2026-04-05', in: 3000, out: 15.99, net: 2984.01 });

    // Totals are exactly the final point.
    const last = f.points[f.points.length - 1];
    expect(last.date).toBe(f.end);
    expect(f.totalIn).toBe(last.in);
    expect(f.totalOut).toBe(last.out);
    expect(f.net).toBe(last.net);
    expect(f.net).toBe(2984.01);
  });

  it('rounds to cents at each accumulation step (0.1 + 0.2 stays 0.3) and breaks same-date ties by merchant asc', () => {
    const txs = [
      mkTx({ date: '2026-01-01', merchant: 'Bbb Storage', amount: 0.2 }),
      mkTx({ date: '2026-02-01', merchant: 'Bbb Storage', amount: 0.2 }),
      mkTx({ date: '2026-03-01', merchant: 'Bbb Storage', amount: 0.2 }),
      mkTx({ date: '2026-01-01', merchant: 'Aaa Storage', amount: 0.1 }),
      mkTx({ date: '2026-02-01', merchant: 'Aaa Storage', amount: 0.1 }),
      mkTx({ date: '2026-03-01', merchant: 'Aaa Storage', amount: 0.1 }),
    ];
    const f = buildForecast(txs, NONE, 30, '2026-03-15');
    // Same projected date (2026-04-01) — merchant asc breaks the tie.
    expect(f.occurrences.map((o) => o.merchant)).toEqual(['Aaa Storage', 'Bbb Storage']);
    const day = f.points.find((p) => p.date === '2026-04-01')!;
    expect(day.out).toBe(0.3); // exact — un-rounded float accumulation would be 0.30000000000000004
    expect(day.net).toBe(-0.3);
    expect(f.totalOut).toBe(0.3);
  });

  it('includes an occurrence landing exactly on `end` and excludes one on end+1', () => {
    const txs = [
      // Lands exactly on end (2026-01-31).
      mkTx({ date: '2025-11-30', merchant: 'City Mortgage', amount: 1500, category: 'Housing' }),
      mkTx({ date: '2025-12-31', merchant: 'City Mortgage', amount: 1500, category: 'Housing' }),
      // nextDate 2026-02-01 = end + 1 day — contributes nothing.
      mkTx({ date: '2025-12-01', merchant: 'Netflix', amount: 15.99 }),
      mkTx({ date: '2026-01-01', merchant: 'Netflix', amount: 15.99 }),
    ];
    const f = buildForecast(txs, NONE, 30, '2026-01-01');
    expect(f.end).toBe('2026-01-31');
    expect(f.occurrences.map((o) => [o.date, o.merchant])).toEqual([
      ['2026-01-31', 'City Mortgage'],
    ]);
    // Only patterns with >=1 in-window occurrence count as series.
    expect(f.expenseSeries).toBe(1);
    expect(f.totalOut).toBe(1500);
  });
});
