// Pure helpers for the Budgets page (spec §12). Kept dependency-free from
// React so they're cheap to unit test.
import { toISODate } from '../../../shared/format';
import type { Budget, Transaction } from '../../../shared/types';

/** Bounded [start, end] ISO dates for the current calendar month (both inclusive). */
export function currentMonthRange(now: Date = new Date()): { start: string; end: string } {
  const y = now.getFullYear();
  const m = now.getMonth();
  return { start: toISODate(new Date(y, m, 1)), end: toISODate(new Date(y, m + 1, 0)) };
}

/**
 * Spent = sum of expense transactions in the current calendar month whose
 * category matches the budget's category case-insensitively (spec §12).
 */
export function computeBudgetSpent(
  transactions: Transaction[],
  category: string,
  now: Date = new Date(),
): number {
  const { start, end } = currentMonthRange(now);
  const target = category.trim().toLowerCase();
  let spent = 0;
  for (const t of transactions) {
    if (t.type !== 'expense') continue;
    if (t.date < start || t.date > end) continue;
    if (t.category.trim().toLowerCase() !== target) continue;
    spent += t.amount;
  }
  return spent;
}

export type BudgetTone = 'accent' | 'caution' | 'danger';

/** Progress-bar tone: calm under 80%, caution near the limit, danger over budget. */
export function budgetTone(spent: number, limit: number): BudgetTone {
  if (limit <= 0) return spent > 0 ? 'danger' : 'accent';
  const pct = (spent / limit) * 100;
  if (pct > 100) return 'danger';
  if (pct >= 80) return 'caution';
  return 'accent';
}

export function budgetPct(spent: number, limit: number): number {
  if (limit <= 0) return spent > 0 ? 100 : 0;
  return (spent / limit) * 100;
}

/** Case-insensitive, trim-insensitive: does a category already have a budget? */
export function categoryHasBudget(budgets: Budget[], category: string): boolean {
  const target = category.trim().toLowerCase();
  return budgets.some((b) => b.category.trim().toLowerCase() === target);
}

/**
 * Categories still eligible for a new budget (spec §12) — a category that
 * already has a budget is excluded so Create budget can never produce two
 * budgets for the same category, which would double-count spend in the
 * health ring (each budget independently sums the same transactions).
 */
export function availableBudgetCategories(categories: string[], budgets: Budget[]): string[] {
  return categories.filter((c) => !categoryHasBudget(budgets, c));
}

export interface BudgetHealth {
  totalSpent: number;
  totalLimit: number;
  pct: number;
  tone: BudgetTone;
}

/** Budget-health summary ring, computed from real active budgets only (spec §12). */
export function computeBudgetHealth(
  budgets: Budget[],
  transactions: Transaction[],
  now: Date = new Date(),
): BudgetHealth {
  const active = budgets.filter((b) => b.active);
  let totalSpent = 0;
  let totalLimit = 0;
  for (const b of active) {
    totalSpent += computeBudgetSpent(transactions, b.category, now);
    totalLimit += b.limit;
  }
  const pct = budgetPct(totalSpent, totalLimit);
  return { totalSpent, totalLimit, pct, tone: budgetTone(totalSpent, totalLimit) };
}
