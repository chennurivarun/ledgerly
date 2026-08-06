import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import OnboardingWizard from './components/onboarding/OnboardingWizard';
import { Button, Spinner } from './components/ui';
import { useStore } from './store';
import Budgets from './pages/Budgets';
import Dashboard from './pages/Dashboard';
import Documents from './pages/Documents';
import Goals from './pages/Goals';
import Recurring from './pages/Recurring';
import Rules from './pages/Rules';
import Settings from './pages/Settings';
import Subscriptions from './pages/Subscriptions';
import Transactions from './pages/Transactions';

export default function App() {
  const loaded = useStore((s) => s.loaded);
  const loadError = useStore((s) => s.loadError);
  const load = useStore((s) => s.load);
  const onboarded = useStore((s) => s.settings.onboarded);

  useEffect(() => {
    void load();
  }, [load]);

  // Spec §6.1.4: never render date-dependent totals before the saved period
  // arrives from the server — gate the whole app on the first state load.
  if (!loaded) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
        {loadError ? (
          <>
            <p className="text-base font-semibold">Ledgerly couldn’t load your data</p>
            <p className="max-w-sm text-sm text-muted">{loadError}</p>
            <Button onClick={() => void load()}>Try again</Button>
          </>
        ) : (
          <>
            <Spinner className="size-8 text-accent" />
            <p className="text-sm text-muted">Loading your data…</p>
          </>
        )}
      </div>
    );
  }

  // First-run onboarding (spec §3): also re-mounts mid-life when Settings'
  // "Run setup again" sets onboarded=false, since this check re-runs on
  // every settings update.
  if (!onboarded) {
    return <OnboardingWizard />;
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="transactions" element={<Transactions />} />
        <Route path="recurring" element={<Recurring />} />
        <Route path="subscriptions" element={<Subscriptions />} />
        <Route path="budgets" element={<Budgets />} />
        <Route path="goals" element={<Goals />} />
        <Route path="documents" element={<Documents />} />
        <Route path="rules" element={<Rules />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
