// Proactive briefings (VISION.md phase-2 item 6, sprint 7).
//
// A briefing is a DETERMINISTIC digest of what the app already knows: the
// last seven days of real transactions, the next seven days of the forecast
// engine's projection, and the counts of things waiting for the user's
// review. No AI, no trend commentary, no invented numbers — every figure is
// derived from stored data, and an empty ledger produces an honestly empty
// briefing.
//
// Pure module — no D1, no network, no bindings. Exercised directly by tests.
import type { ForecastOccurrence } from './forecast';

/** Days of history summarized and days of forecast previewed. */
export const BRIEFING_WINDOW_DAYS = 7;

/** Top spending categories listed in the summary. */
export const BRIEFING_TOP_CATEGORIES = 3;

export interface BriefingCategoryTotal {
  category: string;
  /** Total spent in the window (expenses only), positive. */
  amount: number;
}

export interface BriefingStats {
  /** Real transactions in the window, by direction. */
  income: number;
  spending: number;
  net: number;
  txCount: number;
  /** Largest expense categories in the window, amount desc. */
  topCategories: BriefingCategoryTotal[];
}

export interface Briefing {
  /** The calendar day the briefing describes (the caller's today). */
  date: string; // YYYY-MM-DD
  /** Look-back window: `periodStart`..`date` inclusive. */
  periodStart: string;
  stats: BriefingStats;
  /** Projected occurrences in the next BRIEFING_WINDOW_DAYS days. */
  upcoming: ForecastOccurrence[];
  upcomingIn: number;
  upcomingOut: number;
  /** Honest to-review lines, e.g. "2 documents are waiting for review." —
   * empty array when nothing needs attention. Derived, never invented. */
  attention: string[];
}

/** Inputs the attention lines are derived from — all real stored counts. */
export interface BriefingAttentionCounts {
  documentsAwaitingReview: number;
  ruleSuggestions: number;
  statementRowsProposed: number;
}
