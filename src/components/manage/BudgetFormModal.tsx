// "Create budget" modal (spec §12). Editing/deleting existing budgets lives
// in AdjustBudgetsModal — this one is purely the prominent create action.
// A category can only ever have one budget: creating a second would double
// count spend in the health ring, since each budget independently sums the
// same transactions (spec-compliance regression caught in review).
import { useState } from 'react';
import { fmtCurrency } from '../../../shared/format';
import type { Budget } from '../../../shared/types';
import { Button, EmptyState, Field, InlineError, Input, Modal, Select } from '../ui';
import { availableBudgetCategories, categoryHasBudget } from './budgetMath';

export function BudgetFormModal({
  categories,
  budgets,
  onClose,
  onSave,
}: {
  categories: string[];
  budgets: Budget[];
  onClose: () => void;
  onSave: (budget: Budget) => Promise<void>;
}) {
  const available = availableBudgetCategories(categories, budgets);
  const [category, setCategory] = useState(available[0] ?? '');
  const [limit, setLimit] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    const parsed = Number(limit);
    if (!category) {
      setError('Choose a category.');
      return;
    }
    // Defensive re-check: the picker already omits categories with a budget,
    // but budgets can change while this modal is open (e.g. Adjust budgets
    // in another tab), so re-validate against the latest list at submit time.
    if (categoryHasBudget(budgets, category)) {
      setError(`"${category}" already has a budget.`);
      return;
    }
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError(`Enter a monthly limit greater than ${fmtCurrency(0)}.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        id: crypto.randomUUID(),
        category,
        limit: Math.round(parsed * 100) / 100,
        active: true,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the budget. Try again.');
    } finally {
      setSaving(false);
    }
  }

  if (available.length === 0) {
    return (
      <Modal title="Create budget" onClose={onClose} footer={<div className="flex justify-end"><Button variant="ghost" onClick={onClose}>Close</Button></div>}>
        <EmptyState
          compact
          title="Every category already has a budget"
          body="Add a new category in Settings, or edit an existing budget's limit from Adjust budgets."
        />
      </Modal>
    );
  }

  return (
    <Modal
      title="Create budget"
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void handleSubmit()} loading={saving}>
            Create budget
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Category" hint="Only categories without a budget yet are listed.">
          <Select value={category} onChange={(e) => setCategory(e.target.value)}>
            {available.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Monthly limit" hint="Spending is tracked against the current calendar month.">
          <Input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            placeholder="0.00"
          />
        </Field>
        <InlineError message={error} />
      </div>
    </Modal>
  );
}
