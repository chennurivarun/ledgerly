// "Adjust budgets" modal (spec §12) — edit limits, toggle active, or delete
// existing budgets. Each field auto-saves (matches the inline-edit pattern
// used elsewhere in the app) instead of a separate bulk "Save" step.
// Delete confirms inline within the row rather than a nested Modal, since
// stacking two focus-trapped Modal instances would fight over Escape.
//
// Every write here targets the SAME settings.budgets array, so two rows
// (or a blur-commit racing a delete-confirm) writing concurrently would
// silently drop one write's change. Fixed two ways: (1) build `next` from
// useStore.getState() at the moment each write is dispatched, never from
// the `budgets` prop closure, and (2) disable every row's controls while
// ANY row's write is in flight (`busyId !== null`), so writes are fully
// serialized and never actually overlap.
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { fmtCurrency } from '../../../shared/format';
import type { Budget } from '../../../shared/types';
import { useStore } from '../../store';
import { Button, InlineError, Input, Modal } from '../ui';
import { Toggle } from './Toggle';

export function AdjustBudgetsModal({
  budgets,
  onClose,
  onSave,
}: {
  budgets: Budget[];
  onClose: () => void;
  onSave: (next: Budget[]) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(budgets.map((b) => [b.id, String(b.limit)])),
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const anyBusy = busyId !== null;

  async function persist(id: string, build: (fresh: Budget[]) => Budget[]) {
    setBusyId(id);
    setError(null);
    try {
      const fresh = useStore.getState().settings.budgets;
      await onSave(build(fresh));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save. Try again.');
    } finally {
      setBusyId(null);
    }
  }

  async function commitLimit(budget: Budget) {
    const raw = drafts[budget.id];
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError(`Enter a monthly limit greater than ${fmtCurrency(0)}.`);
      setDrafts((d) => ({ ...d, [budget.id]: String(budget.limit) }));
      return;
    }
    if (parsed === budget.limit) return;
    const rounded = Math.round(parsed * 100) / 100;
    await persist(budget.id, (fresh) =>
      fresh.map((b) => (b.id === budget.id ? { ...b, limit: rounded } : b)),
    );
  }

  async function toggleActive(budget: Budget) {
    await persist(budget.id, (fresh) =>
      fresh.map((b) => (b.id === budget.id ? { ...b, active: !b.active } : b)),
    );
  }

  async function remove(budget: Budget) {
    await persist(budget.id, (fresh) => fresh.filter((b) => b.id !== budget.id));
    setConfirmingId(null);
  }

  return (
    <Modal
      title="Adjust budgets"
      onClose={onClose}
      wide
      footer={
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {budgets.length === 0 ? (
          <p className="text-sm text-muted">No budgets yet.</p>
        ) : (
          budgets.map((budget) => (
            <div key={budget.id} className="rounded-xl border border-border p-3">
              <div className="flex flex-wrap items-center gap-3">
                <p className="min-w-0 flex-1 truncate text-sm font-semibold">{budget.category}</p>
                <Input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  aria-label={`${budget.category} monthly limit`}
                  className="w-28"
                  value={drafts[budget.id] ?? ''}
                  disabled={anyBusy}
                  onChange={(e) => setDrafts((d) => ({ ...d, [budget.id]: e.target.value }))}
                  onBlur={() => void commitLimit(budget)}
                />
                <Toggle
                  checked={budget.active}
                  onChange={() => void toggleActive(budget)}
                  label={`${budget.active ? 'Deactivate' : 'Activate'} ${budget.category} budget`}
                  disabled={anyBusy}
                />
                {confirmingId === budget.id ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted">Delete?</span>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => void remove(budget)}
                      disabled={anyBusy}
                      loading={busyId === budget.id}
                    >
                      Yes
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmingId(null)} disabled={anyBusy}>
                      No
                    </Button>
                  </div>
                ) : (
                  <button
                    type="button"
                    aria-label={`Delete ${budget.category} budget`}
                    onClick={() => setConfirmingId(budget.id)}
                    disabled={anyBusy}
                    className="flex size-9 items-center justify-center rounded-lg text-muted hover:bg-danger-soft hover:text-danger disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                )}
              </div>
            </div>
          ))
        )}
        <InlineError message={error} />
      </div>
    </Modal>
  );
}
