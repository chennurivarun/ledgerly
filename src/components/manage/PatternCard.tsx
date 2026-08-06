// Suggestion card for a single detected pattern (spec §9.7 / §10 / §11).
// Detection never auto-confirms — this card is the only path to Keep or Ignore.
import { fmtCurrency, fmtDate } from '../../../shared/format';
import type { DetectedPattern } from '../../../shared/types';
import { CADENCE_LABELS } from './commitmentTotals';
import { StatusBadge } from './StatusBadge';

export function PatternCard({
  pattern,
  busy,
  locked,
  onKeep,
  onIgnore,
}: {
  pattern: DetectedPattern;
  /** Which action is in flight for THIS card — controls the button label. */
  busy: 'keep' | 'ignore' | null;
  /**
   * True whenever ANY suggestion on the page is mid-write, not just this
   * one — every card writes to the same confirmed/dismissed array, so a
   * second card's Keep/Ignore must not fire while the first is in flight
   * (that's how a concurrent write silently drops another's change).
   */
  locked: boolean;
  onKeep: () => void;
  onIgnore: () => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-canvas p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{pattern.merchant}</p>
          <p className="mt-0.5 text-xs text-muted">
            {pattern.category} · {CADENCE_LABELS[pattern.cadence]}
          </p>
        </div>
        <StatusBadge
          tone={pattern.confidence === 'high' ? 'positive' : 'info'}
          label={pattern.confidence === 'high' ? 'High confidence' : 'Likely'}
        />
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted">Occurrences</dt>
          <dd className="font-medium">{pattern.occurrences}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Avg. charge</dt>
          <dd className="font-medium">{fmtCurrency(pattern.averageAmount)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Monthly equiv.</dt>
          <dd className="font-medium">{fmtCurrency(pattern.monthlyEquivalent)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Next expected</dt>
          <dd className="font-medium">{fmtDate(pattern.nextDate)}</dd>
        </div>
      </dl>

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onIgnore}
          disabled={locked}
          className="inline-flex h-9 items-center justify-center rounded-lg border border-border bg-surface px-3 text-sm font-medium text-ink transition-transform duration-150 ease-out hover:bg-canvas active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === 'ignore' ? 'Ignoring…' : 'Ignore'}
        </button>
        <button
          type="button"
          onClick={onKeep}
          disabled={locked}
          className="inline-flex h-9 items-center justify-center rounded-lg bg-accent px-3 text-sm font-medium text-white transition-transform duration-150 ease-out hover:bg-accent-deep active:scale-[0.97] disabled:cursor-not-allowed disabled:bg-accent/50"
        >
          {busy === 'keep' ? 'Saving…' : 'Keep'}
        </button>
      </div>
    </div>
  );
}
