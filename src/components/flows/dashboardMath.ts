// Pure calculation helpers for the Dashboard (spec §6). Kept dependency-free
// (no React) so the date/period math is unit-testable without a DOM — see
// tests/dashboardMath.test.ts.
import { inPeriod, periodRange, toISODate } from '../../../shared/format';
import type { Period, RecurringItem, Transaction, TxType } from '../../../shared/types';

// ---------------------------------------------------------------------------
// Cash flow chart (spec §6.3): up to seven monthly points from real dated
// transactions, refiltered by the selected period.
// ---------------------------------------------------------------------------

export interface MonthPoint {
  key: string; // YYYY-MM
  label: string; // "Aug 2026"
  income: number;
  expense: number;
}

export interface CashFlowSeries {
  points: MonthPoint[];
  /** true when more real months existed than the 7-point cap kept — surface this in the UI rather than silently truncating. */
  truncated: boolean;
}

export function buildCashFlowSeries(
  transactions: Transaction[],
  period: Period,
  now: Date = new Date(),
): CashFlowSeries {
  const points = new Map<string, MonthPoint>();
  for (const t of transactions) {
    if (!inPeriod(t.date, period, now)) continue;
    const key = t.date.slice(0, 7);
    let point = points.get(key);
    if (!point) {
      const [y, m] = key.split('-').map(Number);
      point = {
        key,
        label: new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
        income: 0,
        expense: 0,
      };
      points.set(key, point);
    }
    if (t.type === 'income') point.income += t.amount;
    else point.expense += t.amount;
  }
  const all = Array.from(points.values()).sort((a, b) => a.key.localeCompare(b.key));
  return { points: all.slice(-7), truncated: all.length > 7 };
}

// ---------------------------------------------------------------------------
// Spending by category donut (spec §6.3).
// ---------------------------------------------------------------------------

export interface CategorySlice {
  /** Synthetic, stable identity for rendering — never assume category names are unique (a real "Other" category can collide with the fold bucket below). */
  id: string;
  category: string;
  amount: number;
  pct: number; // 0..100
  color: string;
}

// Fixed categorical order — colorblind-safe pairwise per the dataviz skill's
// validator (worst adjacent CVD ΔE 9.1, normal-vision floor 19.6 on white).
// Never cycled or generated: a 9th+ category folds into "Other categories" below.
export const CATEGORY_COLORS = [
  '#2a78d6',
  '#eb6834',
  '#1baf7a',
  '#eda100',
  '#e87ba4',
  '#008300',
  '#4a3aa7',
  '#e34948',
];
const FOLD_LABEL = 'Other categories';
const FOLD_COLOR = '#8b8d98';

export function buildCategoryBreakdown(
  transactions: Transaction[],
  period: Period,
  now: Date = new Date(),
): { slices: CategorySlice[]; total: number } {
  const expenses = transactions.filter((t) => t.type === 'expense' && inPeriod(t.date, period, now));
  const totals = new Map<string, number>();
  for (const t of expenses) totals.set(t.category, (totals.get(t.category) ?? 0) + t.amount);
  const total = expenses.reduce((sum, t) => sum + t.amount, 0);
  const ranked = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]);

  const toSlice = (category: string, amount: number, i: number): CategorySlice => ({
    id: `slot-${i}`,
    category,
    amount,
    pct: total > 0 ? (amount / total) * 100 : 0,
    color: CATEGORY_COLORS[i],
  });

  if (ranked.length <= CATEGORY_COLORS.length) {
    // No overflow — every category (including a real "Other") gets its own slice;
    // the synthetic fold bucket never appears, so nothing can collide with it.
    return { slices: ranked.map(([category, amount], i) => toSlice(category, amount, i)), total };
  }

  let head = ranked.slice(0, CATEGORY_COLORS.length);
  const tail = ranked.slice(CATEGORY_COLORS.length);
  let foldAmount = tail.reduce((sum, [, amount]) => sum + amount, 0);

  // A real "Other" category ranking inside the head would otherwise collide
  // (in name and meaning) with the synthetic fold bucket — merge it in instead.
  const realOtherIndex = head.findIndex(([category]) => category === 'Other');
  if (realOtherIndex !== -1) {
    foldAmount += head[realOtherIndex][1];
    head = head.filter((_, i) => i !== realOtherIndex);
  }

  const slices = head.map(([category, amount], i) => toSlice(category, amount, i));
  if (foldAmount > 0) {
    slices.push({
      id: 'other-categories',
      category: FOLD_LABEL,
      amount: foldAmount,
      pct: total > 0 ? (foldAmount / total) * 100 : 0,
      color: FOLD_COLOR,
    });
  }
  return { slices, total };
}

// ---------------------------------------------------------------------------
// Prior-period trend (spec §6.2)
//
// RULING (b): calendar-named periods compare against their LITERAL previous
// calendar unit — this-month against the full previous month (not a
// same-length slice of it), last-month against the month before that,
// this-year against the full previous year. Rolling periods (last-3/6-months)
// compare against an equal-length window immediately before the current one,
// labeled with its real date range so the label never implies a calendar
// unit it isn't (e.g. "vs Feb 1 – May 4", never "vs last month"). all-time
// never produces a trend — there is no comparable "prior all-time".
// ---------------------------------------------------------------------------

function addDaysISO(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return toISODate(dt);
}

function daysBetweenISO(aISO: string, bISO: string): number {
  const [ay, am, ad] = aISO.split('-').map(Number);
  const [by, bm, bd] = bISO.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

/** Inclusive calendar-month bounds for a zero-based month index (which may be <0 or >11 — Date rolls the year). */
function monthBoundsISO(y: number, zeroBasedMonth: number): { start: string; end: string } {
  return {
    start: toISODate(new Date(y, zeroBasedMonth, 1)),
    end: toISODate(new Date(y, zeroBasedMonth + 1, 0)),
  };
}

/**
 * "Feb 1 – May 4" when the whole range falls in the current year (the
 * common case — the year is implied). Once any part of it falls outside the
 * current year, a bare month/day reads as ambiguous, so a year is added:
 * a single trailing year when both ends share one (non-current) year
 * ("Jul 14 – Oct 14, 2025"), or a year on each end when the range spans two
 * different years ("Aug 7, 2025 – Feb 4, 2026").
 */
function fmtRangeLabel(startISO: string, endISO: string, now: Date): string {
  const startYear = Number(startISO.slice(0, 4));
  const endYear = Number(endISO.slice(0, 4));
  const currentYear = now.getFullYear();
  const fmt = (iso: string, withYear: boolean) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(
      'en-US',
      withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' },
    );
  };
  if (startYear === currentYear && endYear === currentYear) {
    return `${fmt(startISO, false)} – ${fmt(endISO, false)}`;
  }
  if (startYear === endYear) {
    return `${fmt(startISO, false)} – ${fmt(endISO, true)}`;
  }
  return `${fmt(startISO, true)} – ${fmt(endISO, true)}`;
}

export interface PriorWindow {
  start: string;
  end: string;
  label: string;
}

/** The comparison window for `period`'s trend. `null` for 'all-time' (no comparable prior window). */
export function priorWindow(period: Period, now: Date = new Date()): PriorWindow | null {
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (period) {
    case 'all-time':
      return null;
    case 'this-month': {
      const { start, end } = monthBoundsISO(y, m - 1);
      return { start, end, label: 'vs last month' };
    }
    case 'last-month': {
      const { start, end } = monthBoundsISO(y, m - 2);
      return { start, end, label: 'vs the month before' };
    }
    case 'this-year': {
      const start = toISODate(new Date(y - 1, 0, 1));
      const end = toISODate(new Date(y - 1, 11, 31));
      return { start, end, label: 'vs last year' };
    }
    case 'last-3-months':
    case 'last-6-months': {
      const { start: curStart } = periodRange(period, now);
      if (!curStart) return null;
      const curEnd = toISODate(now);
      const spanDays = daysBetweenISO(curStart, curEnd);
      const end = addDaysISO(curStart, -1);
      const start = addDaysISO(end, -spanDays);
      return { start, end, label: `vs ${fmtRangeLabel(start, end, now)}` };
    }
  }
}

export interface Trend {
  kind: 'trend' | 'unavailable' | 'not-applicable';
  pct: number;
  label: string;
}

/**
 * Trend for one transaction type. Requires the CURRENT window to have real
 * transaction data (any type) and the PRIOR window to have real data with a
 * non-zero baseline of `txType` — otherwise 'unavailable' ("No trend yet").
 * 'all-time' is always 'not-applicable': there is no comparable prior window,
 * so the UI should show a calculation strip instead of attempting a trend.
 */
export function computeTrend(
  transactions: Transaction[],
  period: Period,
  currentAmount: number,
  txType: TxType,
  now: Date = new Date(),
): Trend {
  if (period === 'all-time') {
    return { kind: 'not-applicable', pct: 0, label: 'All-time total — no prior period to compare' };
  }
  const currentHasData = transactions.some((t) => inPeriod(t.date, period, now));
  if (!currentHasData) return { kind: 'unavailable', pct: 0, label: '' };

  const prior = priorWindow(period, now);
  if (!prior) return { kind: 'unavailable', pct: 0, label: '' };
  const priorTx = transactions.filter((t) => t.date >= prior.start && t.date <= prior.end);
  if (priorTx.length === 0) return { kind: 'unavailable', pct: 0, label: '' };

  const priorAmount = priorTx.filter((t) => t.type === txType).reduce((sum, t) => sum + t.amount, 0);
  if (priorAmount === 0) return { kind: 'unavailable', pct: 0, label: '' };

  return {
    kind: 'trend',
    pct: ((currentAmount - priorAmount) / priorAmount) * 100,
    label: prior.label,
  };
}

// ---------------------------------------------------------------------------
// Coming up (spec §6.3): active recurring items/subscriptions due soon.
// ---------------------------------------------------------------------------

export interface UpcomingItem {
  id: string;
  name: string;
  amount: number;
  nextDate: string;
  kind: 'recurring' | 'subscription';
  category: string;
}

/** Active recurring items/subscriptions with nextDate within `days` of `now`, soonest first. */
export function upcomingItems(
  recurring: RecurringItem[],
  subscriptions: RecurringItem[],
  now: Date = new Date(),
  days = 14,
): UpcomingItem[] {
  const today = toISODate(now);
  const cutoff = addDaysISO(today, days);
  const tag = (items: RecurringItem[], kind: UpcomingItem['kind']) =>
    items
      .filter((i) => i.active && i.nextDate >= today && i.nextDate <= cutoff)
      .map((i) => ({ id: i.id, name: i.name, amount: i.amount, nextDate: i.nextDate, kind, category: i.category }));
  return [...tag(recurring, 'recurring'), ...tag(subscriptions, 'subscription')].sort((a, b) =>
    a.nextDate.localeCompare(b.nextDate),
  );
}
