// Step 4 (optional): assets/liabilities with a live preview. Drafts are
// CONTROLLED by OnboardingWizard (seeded once, at wizard mount, from
// settings.assetsTotal/liabilitiesTotal — blank when net worth isn't
// configured yet, prefilled with the current saved totals when it is) — this
// used to be local state that reset on remount, so Back → Continue silently
// discarded typed values (review S2-2r1). "Skip for now" never persists.
// Continue only persists when at least one field has something in it; an
// untouched Continue behaves like Skip. If net worth IS already configured
// and the user clears BOTH fields, Continue is blocked instead of silently
// leaving the old totals in place while the screen shows blank — see
// handleSubmit.
import { type FormEvent, useState } from 'react';
import { fmtCurrency } from '../../../shared/format';
import { useStore } from '../../store';
import { Button, Field, InlineError, Input } from '../ui';
import { StepFooter } from './StepFooter';

export function NetWorthStep({
  assetsDraft,
  liabilitiesDraft,
  onAssetsDraftChange,
  onLiabilitiesDraftChange,
  netWorthConfigured,
  onBack,
  onContinue,
  disabled,
  onBusyChange,
}: {
  assetsDraft: string;
  liabilitiesDraft: string;
  onAssetsDraftChange: (v: string) => void;
  onLiabilitiesDraftChange: (v: string) => void;
  netWorthConfigured: boolean;
  onBack: () => void;
  onContinue: () => void;
  /** True while "Skip setup" is in flight elsewhere — locks this step's controls too. */
  disabled: boolean;
  /** Reports this step's own save in flight so the wizard can lock "Skip setup". */
  onBusyChange: (busy: boolean) => void;
}) {
  const updatePreferences = useStore((s) => s.updatePreferences);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = saving || disabled;

  const parsedAssets = Number(assetsDraft || 0);
  const parsedLiabilities = Number(liabilitiesDraft || 0);
  const validPreview = Number.isFinite(parsedAssets) && Number.isFinite(parsedLiabilities);
  const preview = validPreview ? parsedAssets - parsedLiabilities : null;

  async function handleSubmit(evt: FormEvent<HTMLFormElement>) {
    evt.preventDefault();
    if (!assetsDraft.trim() && !liabilitiesDraft.trim()) {
      if (netWorthConfigured) {
        // Net worth is already saved server-side — a silent "nothing
        // entered" Continue here would leave those old totals in place
        // while the screen shows blank, which reads as "I just cleared it."
        // Block instead of guessing whether blank means "clear it" or
        // "I didn't touch this field."
        setError('Enter values, or use Skip for now to leave your saved totals unchanged.');
        return;
      }
      // Never configured — nothing to persist, Continue behaves like Skip.
      onContinue();
      return;
    }
    if (!Number.isFinite(parsedAssets) || parsedAssets < 0) {
      setError('Enter total assets as a number of 0 or more.');
      return;
    }
    if (!Number.isFinite(parsedLiabilities) || parsedLiabilities < 0) {
      setError('Enter total liabilities as a number of 0 or more.');
      return;
    }
    setSaving(true);
    onBusyChange(true);
    setError(null);
    try {
      await updatePreferences({
        assetsTotal: Math.round(parsedAssets * 100) / 100,
        liabilitiesTotal: Math.round(parsedLiabilities * 100) / 100,
        netWorthConfigured: true,
      });
      onContinue();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save your net worth. Try again.');
    } finally {
      setSaving(false);
      onBusyChange(false);
    }
  }

  return (
    <form onSubmit={(evt) => void handleSubmit(evt)}>
      <h1 tabIndex={-1} data-step-heading className="text-xl font-semibold outline-none">
        Net worth
        <span className="ml-2 align-middle text-xs font-normal text-muted">Optional</span>
      </h1>
      <p className="mt-2 text-sm text-muted">
        Enter your total assets and liabilities to see net worth on the dashboard. This is
        entirely optional — skip it and set it up anytime in Settings.
      </p>

      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Total assets">
          <Input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            placeholder="0.00"
            disabled={locked}
            value={assetsDraft}
            onChange={(e) => onAssetsDraftChange(e.target.value)}
          />
        </Field>
        <Field label="Total liabilities">
          <Input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            placeholder="0.00"
            disabled={locked}
            value={liabilitiesDraft}
            onChange={(e) => onLiabilitiesDraftChange(e.target.value)}
          />
        </Field>
      </div>

      <div className="mt-4 rounded-xl border border-border bg-canvas px-4 py-3">
        <p className="text-xs font-medium text-muted">Live preview</p>
        <p className="mt-1 text-lg font-semibold">{preview !== null ? fmtCurrency(preview) : '—'}</p>
      </div>

      <InlineError message={error} />

      <StepFooter
        onBack={onBack}
        continueLoading={saving}
        disabled={disabled}
        secondary={
          <Button type="button" variant="ghost" onClick={onContinue} disabled={locked}>
            Skip for now
          </Button>
        }
      />
    </form>
  );
}
