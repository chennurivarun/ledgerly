import type { Period } from './types';

const pad = (n: number) => String(n).padStart(2, '0');

/** Local-timezone ISO date (YYYY-MM-DD). Never use toISOString for calendar dates. */
export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayISO(): string {
  return toISODate(new Date());
}

import { CURRENCY_CODES } from './currencies';

// Display currency is a module-level setting so fmtCurrency/fmtSigned keep
// their frozen signatures; the store sets it from settings.currency on every
// state load. Locale stays en-US so tests are environment-independent —
// only the currency symbol/decimals change.
let activeCurrency = 'USD';
let currencyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function setActiveCurrency(code: string): void {
  if (code === activeCurrency || !CURRENCY_CODES.has(code)) return;
  activeCurrency = code;
  currencyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: code });
}

export function getActiveCurrency(): string {
  return activeCurrency;
}

export function fmtCurrency(n: number): string {
  return currencyFormatter.format(n);
}

/** "+$12.34" for income, "-$12.34" for expense (symbol follows the active currency). */
export function fmtSigned(amount: number, type: 'expense' | 'income'): string {
  return `${type === 'income' ? '+' : '-'}${currencyFormatter.format(Math.abs(amount))}`;
}

export function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Inclusive date range for a period. `null` bounds mean unbounded —
 * 'all-time' is { start: null, end: null } (spec §6.1: no start-date cutoff).
 */
export function periodRange(
  period: Period,
  now: Date = new Date(),
): { start: string | null; end: string | null } {
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (period) {
    case 'all-time':
      return { start: null, end: null };
    case 'this-month':
      return { start: toISODate(new Date(y, m, 1)), end: null };
    case 'last-month':
      return { start: toISODate(new Date(y, m - 1, 1)), end: toISODate(new Date(y, m, 0)) };
    case 'last-3-months':
      return { start: toISODate(new Date(y, m - 3, now.getDate())), end: null };
    case 'last-6-months':
      return { start: toISODate(new Date(y, m - 6, now.getDate())), end: null };
    case 'this-year':
      return { start: toISODate(new Date(y, 0, 1)), end: null };
  }
}

export function inPeriod(dateISO: string, period: Period, now: Date = new Date()): boolean {
  const { start, end } = periodRange(period, now);
  if (start && dateISO < start) return false;
  if (end && dateISO > end) return false;
  return true;
}
