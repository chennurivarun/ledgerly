// Step 5: the only step that finishes onboarding itself. Each card calls
// updatePreferences({ onboarded: true }) first, then re-reads the store to
// confirm `onboarded` actually flipped before treating it as a success — a
// 200 response alone isn't proof the field was persisted (this is the exact
// seam flagged during the S2-1 cross-agent check: applyPreferences silently
// dropping an unrecognized field would otherwise look like success here).
// Only on a confirmed flip do the first two cards open the matching global
// modal; the wizard itself unmounts via App.tsx re-rendering on
// settings.onboarded. Never creates a transaction/document itself (spec
// §3) — it just hands off to the existing Add entry / Import flows.
import { Clock, PenLine, Upload } from 'lucide-react';
import { type ComponentType, useState } from 'react';
import { useStore } from '../../store';
import { Button, InlineError, Spinner } from '../ui';

type Action = 'csv' | 'manual' | 'later';

const CARDS: { key: Action; icon: ComponentType<{ className?: string }>; title: string; body: string }[] = [
  {
    key: 'csv',
    icon: Upload,
    title: 'Import a CSV statement',
    body: 'Upload a bank or card statement and map its columns.',
  },
  {
    key: 'manual',
    icon: PenLine,
    title: 'Add an entry by hand',
    body: 'Log a single transaction to get started.',
  },
  {
    key: 'later',
    icon: Clock,
    title: "I'll do this later",
    body: "Finish setup now and add data whenever you're ready.",
  },
];

export function FirstDataStep({
  onBack,
  disabled,
  onBusyChange,
}: {
  onBack: () => void;
  /** True while "Skip setup" is in flight elsewhere — locks this step's controls too. */
  disabled: boolean;
  /** Reports this step's own save in flight so the wizard can lock "Skip setup". */
  onBusyChange: (busy: boolean) => void;
}) {
  const updatePreferences = useStore((s) => s.updatePreferences);
  const openModal = useStore((s) => s.openModal);
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const locked = pending !== null || disabled;

  async function handlePick(action: Action) {
    setPending(action);
    onBusyChange(true);
    setError(null);
    try {
      await updatePreferences({ onboarded: true });
      if (!useStore.getState().settings.onboarded) {
        setError("Setup couldn't be saved. Try again.");
        return;
      }
      if (action === 'csv') openModal('import');
      if (action === 'manual') openModal('add-entry');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not finish setup. Try again.');
    } finally {
      setPending(null);
      onBusyChange(false);
    }
  }

  return (
    <div>
      <h1 tabIndex={-1} data-step-heading className="text-xl font-semibold outline-none">
        Add your first data
      </h1>
      <p className="mt-2 text-sm text-muted">
        Ledgerly starts empty — nothing is added until you say so. Pick how you&apos;d like to
        begin.
      </p>

      <div className="mt-5 space-y-3">
        {CARDS.map(({ key, icon: Icon, title, body }) => (
          <button
            key={key}
            type="button"
            disabled={locked}
            onClick={() => void handlePick(key)}
            className="flex w-full items-center gap-4 rounded-xl border border-border bg-surface p-4 text-left transition-colors hover:border-accent hover:bg-accent-soft/40 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
              {pending === key ? (
                <Spinner className="size-5" />
              ) : (
                <Icon className="size-5" aria-hidden />
              )}
            </span>
            <span>
              <span className="block text-sm font-semibold">{title}</span>
              <span className="mt-0.5 block text-xs text-muted">{body}</span>
            </span>
          </button>
        ))}
      </div>

      <InlineError message={error} />

      <div className="mt-6 flex items-center justify-between border-t border-border pt-5">
        <Button type="button" variant="ghost" onClick={onBack} disabled={locked}>
          Back
        </Button>
      </div>
    </div>
  );
}
