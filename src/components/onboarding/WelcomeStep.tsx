// Step 1: intro only, no persistence, single Continue (spec: "what Ledgerly
// is; private personal-finance dashboard; your data stays in your own
// database"). When the wizard re-runs right after a Danger Zone wipe, this
// doubles as the §16.5(6) post-wipe confirmation — the normal Toasts live in
// Layout, which this full-screen takeover unmounts, so there'd otherwise be
// no acknowledgement the erase happened. `wiped` is NOT raw
// settings.freshStart: that flag is a one-way latch the wipe sets and
// nothing ever resets, so read alone it would keep claiming "your data was
// erased" on every later re-run, even months afterward once real data
// exists again. The caller corroborates it against actually-empty
// transactions/documents before passing it down — see OnboardingWizard.
import { Wallet } from 'lucide-react';
import { Button } from '../ui';

export function WelcomeStep({
  wiped,
  disabled,
  onContinue,
}: {
  wiped: boolean;
  disabled: boolean;
  onContinue: () => void;
}) {
  return (
    <div>
      <div className="mb-5 flex size-14 items-center justify-center rounded-full bg-accent-soft text-accent">
        <Wallet className="size-7" aria-hidden />
      </div>
      {/* The wizard is a full-screen takeover, not nested app content — this
          is the page's only h1; every other step heading matches. */}
      <h1 tabIndex={-1} data-step-heading className="text-xl font-semibold outline-none">
        Welcome to Ledgerly
      </h1>
      <p className="mt-2 text-sm text-muted">
        {wiped
          ? "Your data was erased. Let's set Ledgerly up again. "
          : 'Ledgerly is your private personal-finance dashboard. '}
        Your data stays in your own database — nothing is shared and there&apos;s nothing else to
        sign into. A quick setup gets your currency and accounts ready; you can change any of it
        later in Settings.
      </p>
      <div className="mt-6 flex justify-end border-t border-border pt-5">
        <Button onClick={onContinue} disabled={disabled}>
          Continue
        </Button>
      </div>
    </div>
  );
}
