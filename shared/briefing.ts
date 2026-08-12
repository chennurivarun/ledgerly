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
import { isoDayOffset, type Forecast, type ForecastOccurrence } from './forecast';
import type { BriefingCadence, Transaction } from './types';

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

/** Round to cents (codebase money idiom) — applied at EACH accumulation. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Exact user-facing copy for the review counts. A count of 0 emits no line —
 * an empty ledger's briefing never manufactures urgency.
 */
function attentionLines(counts: BriefingAttentionCounts): string[] {
  const lines: string[] = [];
  const { documentsAwaitingReview: docs, ruleSuggestions: rules, statementRowsProposed: rows } =
    counts;
  if (docs > 0) {
    lines.push(docs === 1 ? '1 document waiting for review.' : `${docs} documents waiting for review.`);
  }
  if (rules > 0) {
    lines.push(rules === 1 ? '1 suggested rule to look at.' : `${rules} suggested rules to look at.`);
  }
  if (rows > 0) {
    lines.push(
      rows === 1
        ? '1 statement row proposed and not yet reviewed.'
        : `${rows} statement rows proposed and not yet reviewed.`,
    );
  }
  return lines;
}

/**
 * Assemble the deterministic briefing for `todayIso` (the caller's calendar
 * day, YYYY-MM-DD — the ONLY notion of "now" in here; no Date.now()).
 *
 * Stats cover real transactions dated `periodStart`..`todayIso` inclusive,
 * where periodStart is BRIEFING_WINDOW_DAYS before today (so a transaction
 * exactly BRIEFING_WINDOW_DAYS old is still in; one day older is out).
 * `forecast` is a buildForecast(transactions, dismissed, 30, todayIso) result;
 * only its occurrences within the next BRIEFING_WINDOW_DAYS days are kept.
 */
export function buildBriefing(
  transactions: Transaction[],
  forecast: Forecast,
  attention: BriefingAttentionCounts,
  todayIso: string,
): Briefing {
  const periodStart = isoDayOffset(todayIso, -BRIEFING_WINDOW_DAYS);
  // ISO YYYY-MM-DD strings order correctly under plain comparison.
  const window = transactions.filter((t) => t.date >= periodStart && t.date <= todayIso);

  let income = 0;
  let spending = 0;
  const byCategory = new Map<string, number>();
  for (const tx of window) {
    if (tx.type === 'income') {
      income = round2(income + tx.amount);
    } else {
      spending = round2(spending + tx.amount);
      byCategory.set(tx.category, round2((byCategory.get(tx.category) ?? 0) + tx.amount));
    }
  }
  const topCategories: BriefingCategoryTotal[] = [...byCategory.entries()]
    .map(([category, amount]) => ({ category, amount }))
    // Amount desc; ties alphabetical (codepoint order — deterministic, same
    // idiom as the forecast's occurrence sort).
    .sort((a, b) =>
      a.amount !== b.amount ? b.amount - a.amount : a.category < b.category ? -1 : 1,
    )
    .slice(0, BRIEFING_TOP_CATEGORIES);

  // buildForecast already starts the day after `todayIso`; the lower bound is
  // defensive so a hand-built forecast can never leak today into "upcoming".
  const horizonEnd = isoDayOffset(todayIso, BRIEFING_WINDOW_DAYS);
  const upcoming = forecast.occurrences.filter((o) => o.date > todayIso && o.date <= horizonEnd);

  let upcomingIn = 0;
  let upcomingOut = 0;
  for (const occ of upcoming) {
    if (occ.type === 'income') upcomingIn = round2(upcomingIn + occ.amount);
    else upcomingOut = round2(upcomingOut + occ.amount);
  }

  return {
    date: todayIso,
    periodStart,
    stats: {
      income,
      spending,
      net: round2(income - spending),
      txCount: window.length,
      topCategories,
    },
    upcoming,
    upcomingIn,
    upcomingOut,
    attention: attentionLines(attention),
  };
}

/**
 * WhatsApp text bodies cap at 4096 characters — list at most this many
 * upcoming occurrences and summarize the rest honestly.
 */
const MAX_UPCOMING_LINES = 8;

/**
 * Render the briefing as WhatsApp plain text. `*text*` is WhatsApp's bold
 * marker; the message must also read cleanly anywhere that renders it
 * verbatim, so markers stay minimal and there is exactly one leading emoji.
 *
 * `currency` is the ISO 4217 display code (settings.currency). Formatting is
 * local to this module on purpose: shared/format's active-currency singleton
 * is a client concern the worker must not couple to. Locale pinned en-US so
 * output is machine-independent (sprint-2 decision).
 */
export function renderBriefingText(briefing: Briefing, currency: string): string {
  const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency });
  const money = (n: number) => fmt.format(n);
  const { stats } = briefing;

  const lines: string[] = [];
  lines.push(`📊 *Ledgerly briefing — ${briefing.date}*`);
  lines.push('');

  lines.push(`*Last ${BRIEFING_WINDOW_DAYS} days*`);
  if (stats.txCount === 0) {
    // Honest empty ledger: no zeros dressed up as data.
    lines.push(`No activity in the last ${BRIEFING_WINDOW_DAYS} days.`);
  } else {
    const netSign = stats.net < 0 ? '-' : '+';
    lines.push(
      `Income ${money(stats.income)} · Spending ${money(stats.spending)} · Net ${netSign}${money(Math.abs(stats.net))}`,
    );
    lines.push(
      stats.txCount === 1 ? '1 transaction recorded.' : `${stats.txCount} transactions recorded.`,
    );
    if (stats.topCategories.length > 0) {
      lines.push(
        `Top spending: ${stats.topCategories.map((c) => `${c.category} ${money(c.amount)}`).join(', ')}`,
      );
    }
  }
  lines.push('');

  lines.push(`*Next ${BRIEFING_WINDOW_DAYS} days*`);
  if (briefing.upcoming.length === 0) {
    lines.push('Nothing projected.');
  } else {
    lines.push(`Expected: +${money(briefing.upcomingIn)} in, -${money(briefing.upcomingOut)} out.`);
    const shown = briefing.upcoming.slice(0, MAX_UPCOMING_LINES);
    for (const occ of shown) {
      lines.push(`${occ.date}: ${occ.merchant} ${occ.type === 'income' ? '+' : '-'}${money(occ.amount)}`);
    }
    const hidden = briefing.upcoming.length - shown.length;
    if (hidden > 0) lines.push(`…and ${hidden} more.`);
  }
  lines.push('');

  lines.push('*Needs attention*');
  if (briefing.attention.length === 0) lines.push('Nothing waiting on you.');
  else lines.push(...briefing.attention);

  return lines.join('\n');
}

/**
 * The cadence gate for scheduled delivery. Pure: `todayIso` is the caller's
 * calendar day; `lastSentAt` is the server-stamped ISO timestamp of the last
 * successful send (null = never sent).
 *
 * daily: send unless a briefing already went out today.
 * weekly: send when never sent, or the last send is 7+ calendar days old.
 * An unparseable stamp is treated as never-sent — a corrupt row must not
 * silence briefings forever.
 */
export function shouldSendBriefing(
  cadence: BriefingCadence,
  lastSentAt: string | null,
  todayIso: string,
): boolean {
  if (lastSentAt === null) return true;
  const lastDay = lastSentAt.slice(0, 10);
  if (cadence === 'daily') return lastDay !== todayIso;
  const elapsedDays =
    (Date.parse(`${todayIso}T00:00:00Z`) - Date.parse(`${lastDay}T00:00:00Z`)) / 86_400_000;
  if (!Number.isFinite(elapsedDays)) return true;
  return elapsedDays >= 7;
}
