// Step 3: editable account-label list. `accounts` is CONTROLLED by
// OnboardingWizard (seeded from settings.accounts once, at wizard mount) —
// this step used to own that state locally, seeded from a prop, which meant
// it reset to the seed every time the step remounted (steps are
// conditionally rendered, so Back → Continue silently discarded anything
// added/removed in between; review S2-2r1). `originalAccounts` is the last
// value actually persisted to the server (settings.accounts, read live) and
// is only used to decide whether Continue needs to PUT at all. Add/remove
// only edit the draft — it persists once, via updatePreferences({ accounts
// }), on Continue. The add-name field owns its own <form> (mirrors
// ManagedListSection) so pressing Enter there adds an account instead of
// advancing the wizard.
import { Plus, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useStore } from '../../store';
import { Button, Field, InlineError, Input } from '../ui';
import { accountsEqual, addAccountName, removeAccountName } from './accountList';
import { StepFooter } from './StepFooter';

export function AccountsStep({
  accounts,
  onChange,
  originalAccounts,
  onBack,
  onContinue,
  disabled,
  onBusyChange,
}: {
  accounts: string[];
  onChange: (accounts: string[]) => void;
  originalAccounts: string[];
  onBack: () => void;
  onContinue: () => void;
  /** True while "Skip setup" is in flight elsewhere — locks this step's controls too. */
  disabled: boolean;
  /** Reports this step's own save in flight so the wizard can lock "Skip setup". */
  onBusyChange: (busy: boolean) => void;
}) {
  const updatePreferences = useStore((s) => s.updatePreferences);
  const [draft, setDraft] = useState('');
  const [listError, setListError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const locked = saving || disabled;

  function handleAdd(evt: FormEvent<HTMLFormElement>) {
    evt.preventDefault();
    const result = addAccountName(accounts, draft);
    setListError(result.error);
    if (result.error) return;
    onChange(result.accounts);
    setDraft('');
  }

  function handleRemove(name: string) {
    const result = removeAccountName(accounts, name);
    setListError(result.error);
    if (result.error) return;
    onChange(result.accounts);
  }

  async function handleContinue() {
    if (accounts.length === 0) {
      setSaveError('Add at least one account to continue.');
      return;
    }
    if (accountsEqual(accounts, originalAccounts)) {
      onContinue();
      return;
    }
    setSaving(true);
    onBusyChange(true);
    setSaveError(null);
    try {
      await updatePreferences({ accounts });
      onContinue();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Could not save your accounts. Try again.');
    } finally {
      setSaving(false);
      onBusyChange(false);
    }
  }

  return (
    <div>
      <h1 tabIndex={-1} data-step-heading className="text-xl font-semibold outline-none">
        Set up your accounts
      </h1>
      <p className="mt-2 text-sm text-muted">
        These are just labels for where money moves — no balances, no bank linking. Add or
        remove any of them; you&apos;ll need at least one to continue.
      </p>

      <div className="mt-5 flex flex-wrap gap-2">
        {accounts.map((name) => (
          <span
            key={name}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-canvas py-1.5 pl-3 pr-1.5 text-sm"
          >
            {name}
            <button
              type="button"
              aria-label={`Remove account ${name}`}
              disabled={locked}
              onClick={() => handleRemove(name)}
              className="-m-2.5 flex size-11 items-center justify-center rounded-full p-2.5 text-muted transition-colors hover:bg-danger-soft hover:text-danger active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </span>
        ))}
      </div>

      <form className="mt-4 flex gap-2" onSubmit={handleAdd}>
        {/* Field already wraps this input in a <label>"Add an account" — no
            separate aria-label needed; one would just override the visible
            label with a near-duplicate string for AT users. */}
        <Field label="Add an account">
          <Input
            value={draft}
            disabled={locked}
            onChange={(e) => {
              setDraft(e.target.value);
              if (listError) setListError(null);
            }}
            placeholder="e.g. Savings"
          />
        </Field>
        <div className="flex items-end">
          <Button type="submit" variant="ghost" disabled={locked} aria-label="Add account">
            <Plus className="size-4" aria-hidden />
            Add
          </Button>
        </div>
      </form>
      <InlineError message={listError} />
      <InlineError message={saveError} />

      <StepFooter
        onBack={onBack}
        continueType="button"
        continueLoading={saving}
        continueDisabled={accounts.length === 0}
        disabled={disabled}
        onContinueClick={() => void handleContinue()}
      />
    </div>
  );
}
