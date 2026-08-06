// Per-budget progress card (spec §12). Spent is computed live from the
// current calendar month's expense transactions — never stored.
import { fmtCurrency } from '../../../shared/format';
import type { Budget, Transaction } from '../../../shared/types';
import { ProgressBar } from '../ui';
import { budgetPct, budgetTone, computeBudgetSpent } from './budgetMath';

export function BudgetCard({ budget, transactions }: { budget: Budget; transactions: Transaction[] }) {
  const spent = computeBudgetSpent(transactions, budget.category);
  const remaining = budget.limit - spent;
  const pct = budgetPct(spent, budget.limit);
  const tone = budgetTone(spent, budget.limit);
  const over = remaining < 0;

  return (
    <div className="rounded-xl border border-border bg-canvas p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm font-semibold">{budget.category}</p>
        <p className="shrink-0 text-xs font-medium text-muted">{Math.round(pct)}%</p>
      </div>
      <p className="mt-1 text-sm text-muted">
        {fmtCurrency(spent)} of {fmtCurrency(budget.limit)}
      </p>
      <div className="mt-3">
        <ProgressBar pct={pct} tone={tone} />
      </div>
      <p className={`mt-2 text-sm font-medium ${over ? 'text-danger' : 'text-muted'}`}>
        {over
          ? `Over budget by ${fmtCurrency(Math.abs(remaining))}`
          : `${fmtCurrency(remaining)} remaining`}
      </p>
    </div>
  );
}
