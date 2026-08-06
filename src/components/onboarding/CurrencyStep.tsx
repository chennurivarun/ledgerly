// Step 2: currency, defaulting to the CURRENT settings.currency (so a
// mid-life re-run shows the already-chosen currency, not USD). Persists via
// updatePreferences({ currency }) on continue, but skips the call entirely
// when the selection didn't change.
import { type FormEvent, useState } from 'react';
import { useStore } from '../../store';
import { CurrencySelect } from '../CurrencySelect';
import { Field, InlineError } from '../ui';
import { StepFooter } from './StepFooter';

export function CurrencyStep({
  currentCurrency,
  onBack,
  onContinue,
  disabled,
  onBusyChange,
}: {
  currentCurrency: string;
  onBack: () => void;
  onContinue: () => void;
  /** True while "Skip setup" is in flight elsewhere — locks this step's controls too. */
  disabled: boolean;
  /** Reports this step's own save in flight so the wizard can lock "Skip setup". */
  onBusyChange: (busy: boolean) => void;
}) {
  const updatePreferences = useStore((s) => s.updatePreferences);
  const [currency, setCurrency] = useState(currentCurrency);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = saving || disabled;

  async function handleSubmit(evt: FormEvent<HTMLFormElement>) {
    evt.preventDefault();
    if (currency === currentCurrency) {
      onContinue();
      return;
    }
    setSaving(true);
    onBusyChange(true);
    setError(null);
    try {
      await updatePreferences({ currency });
      onContinue();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save your currency. Try again.');
    } finally {
      setSaving(false);
      onBusyChange(false);
    }
  }

  return (
    <form onSubmit={(evt) => void handleSubmit(evt)}>
      <h1 tabIndex={-1} data-step-heading className="text-xl font-semibold outline-none">
        Choose your currency
      </h1>
      <p className="mt-2 text-sm text-muted">
        Ledgerly uses this to format every amount it shows. You can change it later in Settings.
      </p>
      <div className="mt-5">
        <Field label="Display currency">
          <CurrencySelect value={currency} onChange={setCurrency} disabled={locked} />
        </Field>
      </div>
      <InlineError message={error} />
      <StepFooter onBack={onBack} continueLoading={saving} disabled={disabled} />
    </form>
  );
}
