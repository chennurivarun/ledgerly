// Goal card (spec §13): name, due date, current/target, remaining, progress.
import { Pencil, Trash2 } from 'lucide-react';
import { fmtCurrency, fmtDate } from '../../../shared/format';
import type { Goal } from '../../../shared/types';
import { ProgressBar } from '../ui';

export function GoalCard({
  goal,
  onEdit,
  onDelete,
}: {
  goal: Goal;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const remaining = goal.target - goal.current;
  const pct = goal.target > 0 ? (goal.current / goal.target) * 100 : goal.current > 0 ? 100 : 0;
  const reached = remaining <= 0;

  return (
    <div className="rounded-xl border border-border bg-canvas p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{goal.name}</p>
          {goal.dueDate && <p className="mt-0.5 text-xs text-muted">Due {fmtDate(goal.dueDate)}</p>}
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            aria-label={`Edit ${goal.name}`}
            onClick={onEdit}
            className="flex size-9 items-center justify-center rounded-lg text-muted hover:bg-surface hover:text-ink"
          >
            <Pencil className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={`Delete ${goal.name}`}
            onClick={onDelete}
            className="flex size-9 items-center justify-center rounded-lg text-muted hover:bg-danger-soft hover:text-danger"
          >
            <Trash2 className="size-4" aria-hidden />
          </button>
        </div>
      </div>

      <p className="mt-3 text-sm">
        <span className="font-semibold">{fmtCurrency(goal.current)}</span>
        <span className="text-muted"> of {fmtCurrency(goal.target)}</span>
      </p>
      <div className="mt-2">
        <ProgressBar pct={pct} tone={reached ? 'positive' : 'accent'} />
      </div>
      <p className={`mt-2 text-sm font-medium ${reached ? 'text-positive' : 'text-muted'}`}>
        {reached ? 'Goal reached' : `${fmtCurrency(remaining)} to go`}
      </p>
      {goal.note && <p className="mt-2 text-sm text-muted">{goal.note}</p>}
    </div>
  );
}
