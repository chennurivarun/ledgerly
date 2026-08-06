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
import type { Cadence, Transaction, TxType } from './types';

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

/**
 * Build the deterministic forecast for the given horizon.
 *
 * `dismissedKeys` are the user's dismissed pattern keys
 * (settings.dismissedPatterns) — a dismissed pattern contributes nothing.
 * `todayIso` is the caller's calendar day (YYYY-MM-DD); projection starts
 * the day after.
 *
 * CONTRACT STUB (sprint-6 S6-0): returns the correctly-dated empty forecast.
 * S6-1 replaces this body with the real projection driven by detectPatterns.
 */
export function buildForecast(
  transactions: Transaction[],
  dismissedKeys: ReadonlySet<string>,
  horizonDays: ForecastHorizon,
  todayIso: string,
): Forecast {
  void transactions;
  void dismissedKeys;
  const start = isoDayOffset(todayIso, 1);
  const end = isoDayOffset(todayIso, horizonDays);
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
