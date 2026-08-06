// First-run onboarding wizard (spec §3 empty-start, §5 visual system). Full-
// screen takeover — not a Modal — mounted from App.tsx whenever
// `loaded && !settings.onboarded`, including a mid-life re-run triggered from
// Settings' "Run setup again" (sets onboarded=false, which unmounts the
// normal app and remounts this fresh) and from the Danger Zone wipe (also
// resets onboarded=false; WelcomeStep leads with a wipe-acknowledgment
// message in that case — see the `wiped` gate below). Every step reads
// CURRENT settings as its initial values so a re-run reflects real data,
// never the starter state. "Skip setup" is
// reachable from any step and persists nothing but onboarded=true — it must
// never partially save whatever draft the current step holds.
//
// Steps are conditionally rendered (only the active one is mounted), so any
// state a step owned locally used to die on Back/Continue navigation away
// from it. The accounts list and net-worth drafts are the two steps where
// that's a real data-loss risk (typing/adding takes real effort to redo), so
// those drafts are lifted here and seeded from settings exactly once, on
// this component's mount — the initializer runs a single time per wizard
// mount, so the "seed from current settings" re-run property still holds.
import { Wallet } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { Button, InlineError, ProgressBar } from '../ui';
import { AccountsStep } from './AccountsStep';
import { CurrencyStep } from './CurrencyStep';
import { FirstDataStep } from './FirstDataStep';
import { NetWorthStep } from './NetWorthStep';
import { WelcomeStep } from './WelcomeStep';

const STEP_TITLES = ['Welcome', 'Currency', 'Accounts', 'Net worth', 'Add your first data'] as const;

export default function OnboardingWizard() {
  const settings = useStore((s) => s.settings);
  const transactions = useStore((s) => s.transactions);
  const documents = useStore((s) => s.documents);
  const updatePreferences = useStore((s) => s.updatePreferences);
  // settings.freshStart is a one-way latch — the wipe sets it true and
  // nothing ever resets it, so read alone it would keep claiming "your data
  // was erased" on every later re-run (e.g. Settings' "Run setup again"
  // months after a wipe, once real data exists again). Only trust it while
  // it's still corroborated by an actually-empty account: freshStart plus no
  // transactions and no documents.
  const wiped = settings.freshStart && transactions.length === 0 && documents.length === 0;

  const [step, setStep] = useState(0);
  const [skipping, setSkipping] = useState(false);
  const [skipError, setSkipError] = useState<string | null>(null);
  // True while the CURRENT step's own Continue-save is in flight — locks
  // "Skip setup" so it can't fire a second, overlapping PUT (review S2-2r1
  // item 4; mirrors ManagedListSection's local `busy` pattern, hoisted here
  // because the two actions live in different components).
  const [stepBusy, setStepBusy] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const [accountsDraft, setAccountsDraft] = useState<string[]>(() => settings.accounts);
  const [assetsDraft, setAssetsDraft] = useState<string>(() =>
    settings.netWorthConfigured ? String(settings.assetsTotal) : '',
  );
  const [liabilitiesDraft, setLiabilitiesDraft] = useState<string>(() =>
    settings.netWorthConfigured ? String(settings.liabilitiesTotal) : '',
  );

  // Move focus to the new step's heading on every change so keyboard and
  // screen-reader users get a clear, unambiguous signal the screen advanced.
  useEffect(() => {
    cardRef.current?.querySelector<HTMLElement>('[data-step-heading]')?.focus();
  }, [step]);

  async function handleSkip() {
    setSkipping(true);
    setSkipError(null);
    try {
      // Only `onboarded` is sent — skipping must never partially persist
      // whatever draft the current step happens to hold.
      await updatePreferences({ onboarded: true });
      if (!useStore.getState().settings.onboarded) {
        // A 200 response isn't proof the field was actually persisted (the
        // exact seam the S2-1 cross-agent check flagged) — re-check instead
        // of assuming success.
        setSkipError("Setup couldn't be saved. Try again.");
      }
    } catch (e) {
      setSkipError(e instanceof Error ? e.message : 'Could not skip setup. Try again.');
    } finally {
      setSkipping(false);
    }
  }

  const goNext = () => setStep((s) => Math.min(s + 1, STEP_TITLES.length - 1));
  const goBack = () => setStep((s) => Math.max(s - 1, 0));

  return (
    <div className="fixed inset-0 z-40 overflow-y-auto bg-canvas">
      <div className="mx-auto flex min-h-dvh w-full max-w-lg flex-col px-4 py-8 sm:py-12">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-xl bg-accent text-white">
              <Wallet className="size-5" aria-hidden />
            </span>
            <span className="text-lg font-bold tracking-tight">Ledgerly</span>
          </div>
          <Button variant="ghost" loading={skipping} disabled={stepBusy} onClick={() => void handleSkip()}>
            Skip setup
          </Button>
        </div>
        {skipError && (
          <div className="mt-3">
            <InlineError message={skipError} />
          </div>
        )}

        <div className="mt-6" aria-live="polite">
          <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-muted">
            <span>{STEP_TITLES[step]}</span>
            <span>
              Step {step + 1} of {STEP_TITLES.length}
            </span>
          </div>
          <ProgressBar pct={((step + 1) / STEP_TITLES.length) * 100} />
        </div>

        <StepCard cardRef={cardRef} stepKey={step}>
          {step === 0 && <WelcomeStep wiped={wiped} disabled={skipping} onContinue={goNext} />}
          {step === 1 && (
            <CurrencyStep
              currentCurrency={settings.currency}
              onBack={goBack}
              onContinue={goNext}
              disabled={skipping}
              onBusyChange={setStepBusy}
            />
          )}
          {step === 2 && (
            <AccountsStep
              accounts={accountsDraft}
              onChange={setAccountsDraft}
              originalAccounts={settings.accounts}
              onBack={goBack}
              onContinue={goNext}
              disabled={skipping}
              onBusyChange={setStepBusy}
            />
          )}
          {step === 3 && (
            <NetWorthStep
              assetsDraft={assetsDraft}
              liabilitiesDraft={liabilitiesDraft}
              onAssetsDraftChange={setAssetsDraft}
              onLiabilitiesDraftChange={setLiabilitiesDraft}
              netWorthConfigured={settings.netWorthConfigured}
              onBack={goBack}
              onContinue={goNext}
              disabled={skipping}
              onBusyChange={setStepBusy}
            />
          )}
          {step === 4 && (
            <FirstDataStep onBack={goBack} disabled={skipping} onBusyChange={setStepBusy} />
          )}
        </StepCard>
      </div>
    </div>
  );
}

/**
 * Onboarding is rare and first-time (spec/emil-design-eng: occasional
 * screens can carry a little delight) so each step fades/rises in briefly on
 * mount. Remounting on `stepKey` (via React `key`) replays it every step
 * change; `motion-reduce:` collapses straight to the resting state.
 */
function StepCard({
  stepKey,
  cardRef,
  children,
}: {
  stepKey: number;
  cardRef: React.RefObject<HTMLDivElement>;
  children: ReactNode;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(false);
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, [stepKey]);

  return (
    <div
      ref={cardRef}
      className={`mt-6 flex-1 rounded-card border border-border bg-surface p-6 shadow-[0_1px_3px_rgba(16,24,40,0.06)] transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none sm:p-8 ${
        visible ? 'translate-y-0 opacity-100' : 'translate-y-1.5 opacity-0 motion-reduce:opacity-100'
      }`}
    >
      {children}
    </div>
  );
}
