// Shared date-period control (spec §6.1) — used on Dashboard and Transactions
// so both pages read/write the same persisted `settings.selectedPeriod`.
// store.setPeriod is already optimistic-with-rollback and toasts on failure.
import { Calendar, ChevronDown } from 'lucide-react';
import { PERIOD_OPTIONS, type Period } from '../../../shared/types';
import { useStore } from '../../store';
import { Select } from '../ui';

export function PeriodSelector({ className = '' }: { className?: string }) {
  const period = useStore((s) => s.settings.selectedPeriod);
  const setPeriod = useStore((s) => s.setPeriod);

  return (
    <div className={`relative w-full sm:w-52 ${className}`}>
      <Calendar className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
      <Select
        aria-label="Date period"
        value={period}
        onChange={(e) => void setPeriod(e.target.value as Period)}
        className="pl-9 pr-8"
      >
        {PERIOD_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
    </div>
  );
}
