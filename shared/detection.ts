import type { Cadence, DetectedPattern, Transaction, TxType } from './types';

/**
 * Merchant normalization for pattern matching (spec §9.1).
 * Lowercase, trim, strip punctuation, strip terminal "#123", collapse
 * whitespace, drop long reference-number digit runs. Display merchant on the
 * transaction is never modified.
 */
export function normalizeMerchant(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/#\s*\d+\s*$/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b\d{5,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Stable dismissal key persisted in settings.dismissedPatterns (spec §9.7). */
export function patternKey(normalized: string, cadence: Cadence): string {
  return `${normalized}|${cadence}`;
}

/** Monthly-equivalent conversion (spec §9.6). */
export function monthlyEquivalent(amount: number, cadence: Cadence): number {
  switch (cadence) {
    case 'weekly':
      return (amount * 52) / 12;
    case 'biweekly':
      return (amount * 26) / 12;
    case 'monthly':
      return amount;
    case 'quarterly':
      return amount / 3;
    case 'annual':
      return amount / 12;
  }
}

// ---------------------------------------------------------------------------
// Detection engine (spec §9)
// ---------------------------------------------------------------------------

/** Cadence windows in days (spec §9.2), checked in this order. */
const CADENCE_WINDOWS: { cadence: Cadence; min: number; max: number }[] = [
  { cadence: 'weekly', min: 5, max: 9 },
  { cadence: 'biweekly', min: 12, max: 17 },
  { cadence: 'monthly', min: 24, max: 40 },
  { cadence: 'quarterly', min: 75, max: 110 },
  { cadence: 'annual', min: 330, max: 400 },
];

const SUBSCRIPTION_HINTS = [
  'netflix',
  'spotify',
  'hulu',
  'disney',
  'youtube',
  'icloud',
  'dropbox',
  'adobe',
  'microsoft',
  'amazon prime',
  'patreon',
  'membership',
  'studio',
  'gym',
  'openai',
  'chatgpt',
  'canva',
  'notion',
  'zoom',
  'slack',
  'github',
];

const RECURRING_BILL_HINTS = [
  'mortgage',
  'rent',
  'loan',
  'insurance',
  'utility',
  'utilities',
  'electric',
  'water',
  'internet',
  'phone',
  'mobile',
  'daycare',
  'tuition',
  'lease',
  'car payment',
  'auto payment',
  'hoa',
  'property tax',
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a case-insensitive matcher for a hint list. Single-word hints
 * ('rent', 'loan', 'gym', 'hoa'...) are matched with a `\b` word-boundary
 * regex so they only match whole words — a plain substring test would
 * manufacture false hints inside unrelated merchant names ('hoa' inside
 * "Hoagie Haven", 'water' inside "Waterfront Grill", 'lease' inside "Please
 * & Thank You", 'loan' inside "Sloane Cafe", 'gym' inside "Gymboree Play"),
 * defeating the §9.5 false-positive guard. An optional trailing `s` is
 * allowed on single-word hints so simple plurals still match as whole words
 * ('loans' inside "Sallie Mae Student Loans"). Multi-word hints ('amazon
 * prime', 'car payment') are matched with plain substring `includes` — a
 * two-plus-word phrase is specific enough on its own.
 */
function buildHintMatcher(hints: string[]): (haystack: string) => boolean {
  const singleWord = hints.filter((h) => !h.includes(' '));
  const multiWord = hints.filter((h) => h.includes(' '));
  const singleWordRe = singleWord.length
    ? new RegExp(`\\b(?:${singleWord.map(escapeRegex).join('|')})s?\\b`, 'i')
    : null;
  return (haystack: string) => {
    if (singleWordRe && singleWordRe.test(haystack)) return true;
    if (multiWord.length === 0) return false;
    const lower = haystack.toLowerCase();
    return multiWord.some((h) => lower.includes(h));
  };
}

const matchesSubscriptionHint = buildHintMatcher(SUBSCRIPTION_HINTS);
const matchesRecurringBillHint = buildHintMatcher(RECURRING_BILL_HINTS);

/** Does this group have a subscription hint (spec §9.3)? */
function hasSubscriptionHint(normalized: string, category: string, tags: string[]): boolean {
  if (/subscription/i.test(category)) return true;
  if (tags.some((t) => /subscription/i.test(t))) return true;
  return matchesSubscriptionHint(normalized);
}

/** Does this group have a recurring-bill hint (spec §9.4)? */
function hasRecurringBillHint(normalized: string, category: string, tags: string[]): boolean {
  const merged = `${normalized} ${category} ${tags.join(' ')}`;
  return matchesRecurringBillHint(merged);
}

/**
 * Amount variation: max relative deviation from the mean, i.e.
 * max(|amount_i - mean|) / mean across the group. This is the variation
 * definition used throughout this file for both the candidate cutoffs
 * (§9.2, §9.5) and the high-confidence threshold (§9.6). A single outlier
 * charge (e.g. one annual fee spike) is what should gate a pattern, not the
 * spread between two arbitrary members, so max-deviation-from-mean is used
 * rather than (max - min) / mean.
 */
function amountVariation(amounts: number[]): number {
  const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  if (mean === 0) return amounts.some((a) => a !== 0) ? Infinity : 0;
  const maxDeviation = Math.max(...amounts.map((a) => Math.abs(a - mean)));
  return maxDeviation / mean;
}

/**
 * Classify the group's dominant interval into a cadence window. Uses the
 * (upper) MEDIAN of the consecutive-day intervals rather than the mode with
 * a tie-break-toward-shortest: a plain mode tie-break lets a single stray
 * gap hijack the classification — e.g. intervals [7, 24, 28] (one skipped
 * week folded into an otherwise-monthly bill) would tie-break to the bogus
 * "7" (weekly) even though the pattern is clearly monthly, and intervals
 * [31, 28, 4] (a stray extra charge) would tie-break to "4", which fits no
 * window at all and rejects a real monthly pattern outright. The median is
 * robust to a single outlier interval in either direction. For an even
 * count, the upper of the two middle values is used. Returns null when the
 * median doesn't fall in any supported window.
 */
function classifyDominantInterval(
  intervals: number[],
): { cadence: Cadence; median: number } | null {
  const sorted = [...intervals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const window = CADENCE_WINDOWS.find((w) => median >= w.min && median <= w.max);
  if (!window) return null;
  return { cadence: window.cadence, median };
}

/** Round to cents. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Advance `date` by one cadence period, calendar-aware. For monthly/
 * quarterly/annual cadences, the day-of-month is preserved from `anchorDay`
 * with end-of-month clamping (e.g. Jan 31 -> Feb 28/29). Weekly/biweekly add
 * 7/14 days.
 */
function advanceByCadence(date: Date, cadence: Cadence, anchorDay: number): Date {
  switch (cadence) {
    case 'weekly':
      return addDays(date, 7);
    case 'biweekly':
      return addDays(date, 14);
    case 'monthly':
      return addMonthsClamped(date, 1, anchorDay);
    case 'quarterly':
      return addMonthsClamped(date, 3, anchorDay);
    case 'annual':
      return addMonthsClamped(date, 12, anchorDay);
  }
}

function addDays(date: Date, days: number): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function daysInMonth(year: number, monthIndex0: number): number {
  // monthIndex0 is 0-based; day 0 of next month = last day of this month.
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

function addMonthsClamped(date: Date, months: number, anchorDay: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const targetMonthIndex = month + months;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const clampedDay = Math.min(anchorDay, daysInMonth(targetYear, targetMonth));
  return new Date(Date.UTC(targetYear, targetMonth, clampedDay));
}

function toDateOnly(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toIsoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Advance an ISO calendar date by one cadence period using the engine's own
 * calendar semantics: monthly/quarterly/annual preserve `anchorDay` (the
 * pattern's day-of-month, taken from its last real occurrence) with
 * end-of-month clamping (Jan 31 -> Feb 28, then recovering to Mar 31);
 * weekly/biweekly are plain 7/14-day steps. Exported so the forecast
 * (shared/forecast.ts) rolls occurrences forward with EXACTLY the stepping
 * that produced `nextDate` — one calendar, no second implementation.
 */
export function nextCadenceDate(dateIso: string, cadence: Cadence, anchorDay: number): string {
  return toIsoDate(advanceByCadence(toDateOnly(dateIso), cadence, anchorDay));
}

/**
 * Recurring/subscription detection engine (spec §9).
 *
 * Operates on transactions of ONE type — `opts.type`, defaulting to
 * 'expense' (the spec-§9 behavior; every pre-forecast call site relies on
 * that default) — grouped by normalized merchant. Passing
 * `{ type: 'income' }` runs the identical machinery (cadence windows,
 * dead-pattern gate, stability cutoffs, confidence) over income instead;
 * only the grouping filter and the hint gate below differ.
 *
 * `now` is read via its UTC getters (getUTCFullYear/Month/Date) and compared
 * against transaction dates, which are parsed as UTC midnight (see
 * toDateOnly) — i.e. the YYYY-MM-DD strings carry no timezone and are
 * treated as bare calendar dates, not instants. That's normalized once,
 * below, into `nowUtcMidnight`. Passing a bare `new Date()` (the default)
 * still works, but the *civil* "today" it represents depends on the JS
 * engine's local timezone: at a negative UTC offset (e.g. US timezones)
 * late in the local day, the UTC calendar date has already rolled over to
 * tomorrow, which can shift the effective "today" one day past the
 * caller's intended boundary. Callers that need `now` to mean a *specific*
 * calendar day (tests, scheduled jobs) should construct it as a UTC date
 * explicitly, e.g. `new Date(Date.UTC(y, m, d))` or `new Date('YYYY-MM-DD')`,
 * rather than relying on the local-time default.
 */
export function detectPatterns(
  transactions: Transaction[],
  now: Date = new Date(),
  opts?: { type?: TxType },
): DetectedPattern[] {
  const targetType: TxType = opts?.type ?? 'expense';
  const nowUtcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  // Recency reference (used only for the dead-pattern gate below): the
  // EARLIER of `now` and the latest transaction date anywhere in the whole
  // imported dataset. `nowUtcMidnight` alone measures every pattern against
  // literal wall-clock time, which silently zeroes out a batch import whose
  // data doesn't reach "today" — e.g. importing a full year of 2025
  // statements in mid-2026 would judge every 2025 pattern as dead, because
  // nothing in the import is recent by wall-clock standards. Capping the
  // reference at the dataset's own latest date judges recency against what
  // we actually know happened, not the gap to today that the data simply
  // doesn't cover — while a pattern with genuinely recent activity
  // elsewhere in the same dataset (dataMax close to real `now`) is still
  // judged against real time, so a merchant that's actually gone quiet
  // amid otherwise-current data is still correctly flagged dead (a 2019
  // gym membership inside an otherwise-2026 dataset stays dead, since
  // dataMax there is ~2026, not 2019).
  const dataMaxMs =
    transactions.length > 0
      ? Math.max(...transactions.map((t) => toDateOnly(t.date).getTime()))
      : nowUtcMidnight;
  const recencyReferenceMs = Math.min(nowUtcMidnight, dataMaxMs);

  const groups = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    if (tx.type !== targetType) continue;
    const normalized = normalizeMerchant(tx.merchant);
    if (!normalized) continue;
    const list = groups.get(normalized);
    if (list) list.push(tx);
    else groups.set(normalized, [tx]);
  }

  const results: DetectedPattern[] = [];

  for (const [normalized, txs] of groups) {
    // Unique dates (spec §9.2).
    const uniqueDates = Array.from(new Set(txs.map((t) => t.date))).sort();
    if (uniqueDates.length < 2) continue;

    const lastDate = uniqueDates[uniqueDates.length - 1];
    const anchorDay = toDateOnly(lastDate).getUTCDate();

    // Consecutive-day intervals between sorted unique dates.
    const intervals: number[] = [];
    for (let i = 1; i < uniqueDates.length; i++) {
      const days = Math.round(
        (toDateOnly(uniqueDates[i]).getTime() - toDateOnly(uniqueDates[i - 1]).getTime()) /
          86400000,
      );
      intervals.push(days);
    }

    const classified = classifyDominantInterval(intervals);
    if (!classified) continue;
    const { cadence, median } = classified;

    // Recency bound: a pattern whose last occurrence is more than two full
    // cadence periods behind the recency reference is dead, not a live
    // commitment (e.g. a 2019 gym membership must not surface as a 2026
    // suggestion). Advance twice from the last occurrence, calendar-aware,
    // and compare to `recencyReferenceMs` (see above).
    const deadCutoff = advanceByCadence(
      advanceByCadence(toDateOnly(lastDate), cadence, anchorDay),
      cadence,
      anchorDay,
    );
    if (deadCutoff.getTime() < recencyReferenceMs) continue;

    // Interval jitter: max deviation of intervals from the median interval.
    const jitter = Math.max(...intervals.map((iv) => Math.abs(iv - median)));

    // One representative amount per unique date (multiple same-day charges
    // are averaged into a single occurrence, not counted separately).
    const byDate = new Map<string, Transaction[]>();
    for (const tx of txs) {
      const list = byDate.get(tx.date);
      if (list) list.push(tx);
      else byDate.set(tx.date, [tx]);
    }
    const occurrenceAmounts = uniqueDates.map((d) => {
      const list = byDate.get(d)!;
      return list.reduce((sum, t) => sum + t.amount, 0) / list.length;
    });
    const occurrences = uniqueDates.length;
    const variation = amountVariation(occurrenceAmounts);

    // Most recent transaction in the group (by date, then createdAt) — used
    // for the display merchant and as the category tie-break preference.
    let mostRecent = txs[0];
    for (const tx of txs) {
      if (
        tx.date > mostRecent.date ||
        (tx.date === mostRecent.date && tx.createdAt > mostRecent.createdAt)
      ) {
        mostRecent = tx;
      }
    }

    // Most frequent category in the group. Ties are broken deterministically
    // — regardless of the caller's transaction ordering — by preferring the
    // most recent transaction's category if it's among the tied leaders,
    // else falling back to alphabetical order.
    const categoryCounts = new Map<string, number>();
    for (const tx of txs) {
      categoryCounts.set(tx.category, (categoryCounts.get(tx.category) ?? 0) + 1);
    }
    const maxCategoryCount = Math.max(...categoryCounts.values());
    const tiedCategories = [...categoryCounts.entries()]
      .filter(([, count]) => count === maxCategoryCount)
      .map(([cat]) => cat);
    const category =
      tiedCategories.length === 1
        ? tiedCategories[0]
        : tiedCategories.includes(mostRecent.category)
          ? mostRecent.category
          : [...tiedCategories].sort()[0];

    // All tags seen in the group.
    const allTags = txs.flatMap((t) => t.tags);

    // Hints (§9.3/§9.4) are expense-flavored — subscription services and
    // household bills. For income detection they are disabled entirely, so
    // e.g. Patreon/GitHub payout income can never be labeled a
    // 'subscription' (kind stays 'recurring') and a "rent"-named deposit
    // can't ride the bill-hint relaxation: income must pass the strict
    // no-hint stability gate on its own. Consequence, pinned in tests:
    // weekly/biweekly cadences (unlocked only by a subscription hint) are
    // never detected for income.
    const subscriptionHint =
      targetType === 'expense' && hasSubscriptionHint(normalized, category, allTags);
    const recurringBillHint =
      targetType === 'expense' && hasRecurringBillHint(normalized, category, allTags);
    const hasHint = subscriptionHint || recurringBillHint;

    // False-positive guard (§9.5). Weekly/biweekly cadences are only ever
    // unlocked by a SUBSCRIPTION hint (§9.3) — a §9.4 recurring-bill hint
    // (mortgage/rent/utility/insurance/...) is not enough, since no real
    // bill is charged weekly, and allowing it manufactures false positives
    // out of ordinary weekly spending that merely contains a bill-flavored
    // word ("Enterprise Rent A Car", "Water Street Deli", "Mobile Gas
    // Mart", "Electric Avenue Bar", "Lease Cafe"). Even with a subscription
    // hint, weekly/biweekly candidates need strong stability (>=4
    // occurrences, <=5% variation) before surfacing — a hint alone
    // shouldn't be enough to promote what could still be routine spending.
    // No-hint monthly/quarterly/annual candidates need >=3 stable
    // occurrences with <=3% variation.
    if (cadence === 'weekly' || cadence === 'biweekly') {
      if (!subscriptionHint) continue;
      if (occurrences < 4 || variation > 0.05) continue;
    } else if (!hasHint) {
      if (occurrences < 3 || variation > 0.03) continue;
    }

    // Amount variation limits (§9.2): subscription candidates <=20%, other
    // recurring <=35%.
    const subscriptionEligible = subscriptionHint && variation <= 0.2;
    const kind: DetectedPattern['kind'] = subscriptionEligible ? 'subscription' : 'recurring';
    const varLimit = kind === 'subscription' ? 0.2 : 0.35;
    if (variation > varLimit) continue;

    // Confidence (§9.6).
    const confidence: DetectedPattern['confidence'] =
      occurrences >= 3 && variation <= 0.12 && jitter <= 5 ? 'high' : 'likely';

    const averageAmount = round2(
      occurrenceAmounts.reduce((a, b) => a + b, 0) / occurrenceAmounts.length,
    );

    let next = advanceByCadence(toDateOnly(lastDate), cadence, anchorDay);
    // Advance by the cadence until it's not before `now`, keeping the
    // day-of-month anchor for month-based cadences.
    let guard = 0;
    while (next.getTime() < nowUtcMidnight && guard < 1000) {
      next = advanceByCadence(next, cadence, anchorDay);
      guard++;
    }

    results.push({
      key: patternKey(normalized, cadence),
      merchant: mostRecent.merchant,
      normalized,
      kind,
      cadence,
      occurrences,
      confidence,
      averageAmount,
      monthlyEquivalent: monthlyEquivalent(averageAmount, cadence),
      nextDate: toIsoDate(next),
      lastDate,
      category,
    });
  }

  return results;
}
