// Cash-flow forecasting (VISION.md phase-2 item 4).
//
// The projection is DETERMINISTIC and auditable: it only extends what the
// recurring-detection engine (shared/detection.ts, spec §9) already found —
// each live, undismissed pattern's occurrences are rolled forward from its
// calendar-aware nextDate until the horizon ends. No trend fitting, no
// invented numbers: a merchant the engine can't classify contributes nothing,
// and an empty ledger forecasts nothing.
//
// Pure module — no D1, no network, no bindings. Exercised directly by tests.
import { detectPatterns, nextCadenceDate } from './detection';
import type { Cadence, DetectedPattern, Transaction, TxType } from './types';

export const FORECAST_HORIZONS = [30, 60, 90] as const;
export type ForecastHorizon = (typeof FORECAST_HORIZONS)[number];

/** One projected future occurrence of a detected recurring pattern. */
export interface ForecastOccurrence {
  /** The contributing pattern's stable key (`${normalized}|${cadence}`). */
  key: string;
  /** Projected calendar date, YYYY-MM-DD. */
  date: string;
  /** Display merchant (as the detection engine reports it). */
  merchant: string;
  /** The pattern's averageAmount — always positive; `type` carries direction. */
  amount: number;
  type: TxType;
  cadence: Cadence;
  /** Detection confidence, surfaced so the UI can de-emphasize 'likely'. */
  confidence: 'high' | 'likely';
  category: string;
}

/** One day on the cumulative curve. Amounts accumulate from 0 at `start`. */
export interface ForecastPoint {
  date: string; // YYYY-MM-DD
  in: number; // cumulative projected income through this date
  out: number; // cumulative projected spending through this date
  net: number; // in - out
}

export interface Forecast {
  /** First projected day (the day after `today`). */
  start: string;
  /** Last projected day (inclusive). */
  end: string;
  horizonDays: number;
  /** Every projected occurrence in the window, date ascending. */
  occurrences: ForecastOccurrence[];
  /** One point per day from start to end — cumulative, starting from 0. */
  points: ForecastPoint[];
  totalIn: number;
  totalOut: number;
  net: number;
  /** How many detected series contribute, by direction. */
  expenseSeries: number;
  incomeSeries: number;
}

/** YYYY-MM-DD for a UTC-midnight offset from `base` (no local-tz drift). */
export function isoDayOffset(baseIso: string, days: number): string {
  const base = new Date(`${baseIso}T00:00:00Z`);
  const shifted = new Date(base.getTime() + days * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

/** Round to cents (codebase money idiom) — applied at EACH accumulation. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Build the deterministic forecast for the given horizon.
 *
 * `dismissedKeys` are the user's dismissed pattern keys
 * (settings.dismissedPatterns) — a dismissed pattern contributes nothing.
 * `todayIso` is the caller's calendar day (YYYY-MM-DD); projection starts
 * the day after. Pure: `todayIso` is the ONLY notion of "now" — no
 * Date.now() anywhere in here.
 *
 * The projection runs the ONE detection engine twice (expense + income) and
 * rolls each live, undismissed pattern forward from its nextDate via
 * nextCadenceDate — the engine's own calendar stepping (month-length
 * clamping and all). Only dates the cadence actually lands on appear: an
 * overdue pattern (nextDate at/before `today`) advances by whole cadence
 * periods until it enters the window or passes it — never a fabricated
 * catch-up occurrence squeezed inside the window.
 */
export function buildForecast(
  transactions: Transaction[],
  dismissedKeys: ReadonlySet<string>,
  horizonDays: ForecastHorizon,
  todayIso: string,
): Forecast {
  const start = isoDayOffset(todayIso, 1);
  const end = isoDayOffset(todayIso, horizonDays);

  // Anchor the engine's "now" at the caller's calendar day (parsed as UTC
  // midnight — detectPatterns reads `now` via its UTC getters).
  const now = new Date(`${todayIso}T00:00:00Z`);
  const series: { pattern: DetectedPattern; type: TxType }[] = [
    ...detectPatterns(transactions, now).map((pattern) => ({ pattern, type: 'expense' as const })),
    ...detectPatterns(transactions, now, { type: 'income' }).map((pattern) => ({
      pattern,
      type: 'income' as const,
    })),
  ].filter(({ pattern }) => !dismissedKeys.has(pattern.key));

  const occurrences: ForecastOccurrence[] = [];
  let expenseSeries = 0;
  let incomeSeries = 0;

  for (const { pattern, type } of series) {
    // The engine anchors month-based stepping on the day-of-month of the
    // pattern's LAST REAL occurrence (so Jan 31 -> Feb 28 recovers to
    // Mar 31); reuse that same anchor to continue its sequence exactly.
    const anchorDay = Number(pattern.lastDate.slice(8, 10));
    let date = pattern.nextDate;
    // Overdue/at-today patterns: advance by whole cadence periods until the
    // window opens (bounded like the engine's own advance loop).
    let guard = 0;
    while (date < start && guard < 1000) {
      date = nextCadenceDate(date, pattern.cadence, anchorDay);
      guard++;
    }
    let contributed = 0;
    while (date <= end && guard < 1000) {
      occurrences.push({
        key: pattern.key,
        date,
        merchant: pattern.merchant,
        amount: pattern.averageAmount,
        type,
        cadence: pattern.cadence,
        confidence: pattern.confidence,
        category: pattern.category,
      });
      contributed++;
      date = nextCadenceDate(date, pattern.cadence, anchorDay);
      guard++;
    }
    if (contributed > 0) {
      if (type === 'expense') expenseSeries++;
      else incomeSeries++;
    }
  }

  // Date asc; ties by merchant asc, then key — a stable, deterministic
  // order regardless of detection iteration order.
  occurrences.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.merchant !== b.merchant) return a.merchant < b.merchant ? -1 : 1;
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    return 0;
  });

  // Honest empty state: when nothing contributes, the forecast is EMPTY
  // (no points) — never a flat line of zeros dressed up as data.
  if (occurrences.length === 0) {
    return {
      start,
      end,
      horizonDays,
      occurrences: [],
      points: [],
      totalIn: 0,
      totalOut: 0,
      net: 0,
      expenseSeries: 0,
      incomeSeries: 0,
    };
  }

  // One point per day, start..end inclusive; cumulative from 0, rounded to
  // cents at each accumulation so no float dust survives into the curve.
  const points: ForecastPoint[] = [];
  let cumIn = 0;
  let cumOut = 0;
  let occIdx = 0;
  for (let day = 1; day <= horizonDays; day++) {
    const date = isoDayOffset(todayIso, day);
    while (occIdx < occurrences.length && occurrences[occIdx].date === date) {
      if (occurrences[occIdx].type === 'income') cumIn = round2(cumIn + occurrences[occIdx].amount);
      else cumOut = round2(cumOut + occurrences[occIdx].amount);
      occIdx++;
    }
    points.push({ date, in: cumIn, out: cumOut, net: round2(cumIn - cumOut) });
  }

  const last = points[points.length - 1];
  return {
    start,
    end,
    horizonDays,
    occurrences,
    points,
    totalIn: last.in,
    totalOut: last.out,
    net: last.net,
    expenseSeries,
    incomeSeries,
  };
}
