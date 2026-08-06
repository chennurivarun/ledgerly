// Pure presentation helpers for the Recurring page's Forecast section
// (VISION phase-2 item 4, sprint 6 S6-2). Everything with logic — tile
// derivation, occurrence grouping, list capping, axis math — lives here,
// dependency-free from React, so it's unit-tested directly and the component
// stays thin. Every figure these helpers emit comes straight from the
// Forecast object (shared/forecast.ts) — no invented numbers.
import { getNiceTickValues } from 'recharts-scale';
import type { Forecast, ForecastOccurrence, ForecastPoint } from '../../../shared/forecast';
import { fmtCurrency, fmtSigned, getActiveCurrency } from '../../../shared/format';

// ---------------------------------------------------------------------------
// Stat tiles
// ---------------------------------------------------------------------------

export interface ForecastTile {
  label: string;
  /** Currency-formatted via shared/format — respects settings.currency. */
  value: string;
  sub: string;
  /** Only the Net tile is toned: positive net green, negative net caution. */
  tone?: 'positive' | 'caution';
}

/**
 * The three horizon tiles. Net is signed per house convention (fmtSigned:
 * "+" for a projected surplus, "-" for a shortfall) and toned like the
 * dashboard's trend strips: positive green, caution orange when negative.
 * A zero net counts as a surplus ("+", positive) — it isn't a shortfall.
 */
export function deriveForecastTiles(f: Forecast): [ForecastTile, ForecastTile, ForecastTile] {
  return [
    {
      label: 'Expected in',
      value: fmtCurrency(f.totalIn),
      sub: `${f.incomeSeries} income series`,
    },
    {
      label: 'Expected out',
      value: fmtCurrency(f.totalOut),
      sub: `${f.expenseSeries} expense series`,
    },
    {
      label: 'Net',
      value: fmtSigned(f.net, f.net >= 0 ? 'income' : 'expense'),
      sub: `Next ${f.horizonDays} days`,
      tone: f.net >= 0 ? 'positive' : 'caution',
    },
  ];
}

// ---------------------------------------------------------------------------
// Upcoming list: cap, then group by date
// ---------------------------------------------------------------------------

/** Visible-occurrence cap so a 90-day/many-series list stays scannable. */
export const UPCOMING_CAP = 30;

/**
 * First `cap` occurrences plus an honest count of what the cap hides.
 * The forecast's occurrences are date-ascending (contract), so the visible
 * slice is always the soonest ones.
 */
export function capUpcoming(
  occurrences: ForecastOccurrence[],
  cap: number = UPCOMING_CAP,
): { visible: ForecastOccurrence[]; hiddenCount: number } {
  return {
    visible: occurrences.slice(0, cap),
    hiddenCount: Math.max(0, occurrences.length - cap),
  };
}

/** "+N more within the horizon", or null when nothing is hidden. */
export function hiddenCountLabel(hiddenCount: number): string | null {
  return hiddenCount > 0 ? `+${hiddenCount} more within the horizon` : null;
}

export interface OccurrenceGroup {
  date: string; // YYYY-MM-DD
  occurrences: ForecastOccurrence[];
}

/**
 * Groups occurrences under date headings. Insertion-order grouping: the
 * input is already date-ascending (forecast contract), so first-seen date
 * order IS ascending order, and within a day the input order is preserved
 * unchanged (stable) — no re-sorting that could disagree with the engine.
 */
export function groupOccurrencesByDate(occurrences: ForecastOccurrence[]): OccurrenceGroup[] {
  const groups: OccurrenceGroup[] = [];
  const byDate = new Map<string, ForecastOccurrence[]>();
  for (const o of occurrences) {
    let bucket = byDate.get(o.date);
    if (!bucket) {
      bucket = [];
      byDate.set(o.date, bucket);
      groups.push({ date: o.date, occurrences: bucket });
    }
    bucket.push(o);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Chart axis math — same idioms as flows/charts.tsx (compact currency ticks,
// nice-tick-sized gutter). Duplicated rather than imported because those
// helpers are module-private to charts.tsx, which is outside this task's
// file boundary; the math is kept byte-for-byte in step with it.
// ---------------------------------------------------------------------------

/** Compact axis tick in the active currency, e.g. "$2K" (spec §5 chart legibility). */
export function compactCurrency(v: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: getActiveCurrency(),
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(v);
}

/**
 * Nice tick values covering the cumulative-net range. Unlike the cash-flow
 * chart, net can dip below zero (out ahead of in), so the domain is
 * [min(0, ...net), max(0, ...net)] — always anchored through 0 so the axis
 * shows where the projection crosses from surplus to shortfall.
 */
export function netAxisTicks(points: ForecastPoint[]): number[] {
  let min = 0;
  let max = 0;
  for (const p of points) {
    if (p.net < min) min = p.net;
    if (p.net > max) max = p.net;
  }
  return getNiceTickValues([min, max], 5, true);
}

/**
 * Y-axis gutter width sized from the actual rendered ticks — identical
 * budget math to charts.tsx tickGutterWidth (7.5px/char for the 12px tick
 * font + 20px recharts chrome, clamped to [52, 100]).
 */
export function netTickGutterWidth(ticks: number[]): number {
  const longestTick = Math.max(...ticks.map((t) => compactCurrency(t).length));
  return Math.min(100, Math.max(52, Math.ceil(longestTick * 7.5) + 20));
}

/** Short x-axis day label ("Sep 5") — fmtDate's year would overcrowd 90 daily ticks. */
export function fmtDayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
