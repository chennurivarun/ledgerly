// Budgets page (spec §12) — empty start with a prominent Create budget
// action; spent is computed live from the current calendar month.
import { PiggyBank, SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { fmtCurrency } from '../../shared/format';
import type { Budget } from '../../shared/types';
import { AdjustBudgetsModal } from '../components/manage/AdjustBudgetsModal';
import { BudgetCard } from '../components/manage/BudgetCard';
import { BudgetFormModal } from '../components/manage/BudgetFormModal';
import { computeBudgetHealth } from '../components/manage/budgetMath';
import { ProgressRing } from '../components/manage/ProgressRing';
import { useStore } from '../store';
import { Button, Card, EmptyState } from '../components/ui';

export default function Budgets() {
  const transactions = useStore((s) => s.transactions);
  const settings = useStore((s) => s.settings);
  const updatePreferences = useStore((s) => s.updatePreferences);
  const toast = useStore((s) => s.toast);

  const [showCreate, setShowCreate] = useState(false);
  const [showAdjust, setShowAdjust] = useState(false);

  const budgets = settings.budgets;
  const activeBudgets = budgets.filter((b) => b.active);
  const health = computeBudgetHealth(budgets, transactions);

  // The last budget can be deleted from inside Adjust budgets itself — if
  // that empties the list while the modal is still open, drop back to the
  // empty-start view instead of leaving a stale "Adjust budgets" modal open
  // over a page that just re-rendered into its empty state.
  useEffect(() => {
    if (budgets.length === 0) setShowAdjust(false);
  }, [budgets.length]);

  async function handleCreate(budget: Budget) {
    // Read fresh: two "Create budget" submits (or a create racing an Adjust
    // budgets edit) must not silently drop each other's write.
    const current = useStore.getState().settings.budgets;
    await updatePreferences({ budgets: [...current, budget] });
    toast('success', `Budget for "${budget.category}" created.`);
  }

  async function handleAdjustSave(next: Budget[]) {
    await updatePreferences({ budgets: next });
  }

  if (budgets.length === 0) {
    return (
      <>
        <Card>
          <EmptyState
            icon={PiggyBank}
            title="No budgets yet"
            body="Create a budget to track spending against a monthly limit, category by category."
            action={<Button onClick={() => setShowCreate(true)}>Create budget</Button>}
          />
        </Card>
        {showCreate && (
          <BudgetFormModal
            categories={settings.categories}
            budgets={budgets}
            onClose={() => setShowCreate(false)}
            onSave={handleCreate}
          />
        )}
      </>
    );
  }

  return (
    <div className="space-y-6">
      <Card title="Budget health">
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center">
          <ProgressRing pct={health.pct} tone={health.tone}>
            <span className="text-lg font-semibold">{Math.round(health.pct)}%</span>
            <span className="text-xs text-muted">used</span>
          </ProgressRing>
          <div className="text-center sm:text-left">
            <p className="text-sm font-semibold">
              {fmtCurrency(health.totalSpent)} of {fmtCurrency(health.totalLimit)} spent this month
            </p>
            <p className="mt-1 text-sm text-muted">
              Across {activeBudgets.length} active budget{activeBudgets.length === 1 ? '' : 's'}.
              {health.tone === 'danger' && ' You are over budget overall.'}
              {health.tone === 'caution' && ' You are close to your limit.'}
            </p>
          </div>
        </div>
      </Card>

      <Card
        title="Your budgets"
        action={
          // Card's header row (ui.tsx, frozen) doesn't wrap, so two full-width
          // action buttons alongside a title can overflow at ~390px. Stack
          // them below `sm` instead of relying on the header itself to wrap.
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button variant="ghost" size="sm" onClick={() => setShowAdjust(true)}>
              <SlidersHorizontal className="size-4" aria-hidden />
              Adjust budgets
            </Button>
            <Button size="sm" onClick={() => setShowCreate(true)}>
              Create budget
            </Button>
          </div>
        }
      >
        {activeBudgets.length === 0 ? (
          <EmptyState
            compact
            title="No active budgets"
            body="All of your budgets are paused. Reactivate one from Adjust budgets."
            action={
              <Button variant="ghost" onClick={() => setShowAdjust(true)}>
                Adjust budgets
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {activeBudgets.map((b) => (
              <BudgetCard key={b.id} budget={b} transactions={transactions} />
            ))}
          </div>
        )}
      </Card>

      {showCreate && (
        <BudgetFormModal
          categories={settings.categories}
          budgets={budgets}
          onClose={() => setShowCreate(false)}
          onSave={handleCreate}
        />
      )}
      {showAdjust && (
        <AdjustBudgetsModal budgets={budgets} onClose={() => setShowAdjust(false)} onSave={handleAdjustSave} />
      )}
    </div>
  );
}
