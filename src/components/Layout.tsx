// Application shell (spec §5): desktop sidebar (238px) + sticky top bar (76px);
// mobile compact top bar + horizontally scrollable bottom nav reaching all tabs.
// OWNERSHIP: this file is frozen scaffold — global modal CONTENT lives in
// GlobalModals.tsx (Task 2); pages must not edit this file.
import { useState } from 'react';
import {
  ArrowLeftRight,
  CreditCard,
  FileText,
  LayoutDashboard,
  PiggyBank,
  Plus,
  RefreshCw,
  Repeat,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Target,
  Upload,
  Wallet,
  X,
} from 'lucide-react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useStore } from '../store';
import { BUILD_ID, shouldOfferReload } from '../../shared/version';
import { GlobalModals } from './GlobalModals';
import { Button } from './ui';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/transactions', label: 'Transactions', icon: ArrowLeftRight },
  { to: '/recurring', label: 'Recurring', icon: Repeat },
  { to: '/subscriptions', label: 'Subscriptions', icon: CreditCard },
  { to: '/budgets', label: 'Budgets', icon: PiggyBank },
  { to: '/goals', label: 'Goals', icon: Target },
  { to: '/documents', label: 'Documents', icon: FileText },
  { to: '/rules', label: 'Rules', icon: SlidersHorizontal },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

export default function Layout() {
  const { pathname } = useLocation();
  const openModal = useStore((s) => s.openModal);
  const pageTitle = NAV.find((n) => n.to === pathname)?.label ?? 'Ledgerly';

  return (
    <div className="min-h-dvh">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[238px] flex-col border-r border-border bg-surface lg:flex">
        <div className="flex items-center gap-2.5 px-6 py-5">
          <span className="flex size-9 items-center justify-center rounded-xl bg-accent text-white">
            <Wallet className="size-5" aria-hidden />
          </span>
          <span className="text-lg font-bold tracking-tight">Ledgerly</span>
        </div>
        <nav aria-label="Main navigation" className="flex-1 space-y-1 px-3 pb-6">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-accent-soft text-accent'
                    : 'text-muted hover:bg-canvas hover:text-ink'
                }`
              }
            >
              <Icon className="size-5 shrink-0" aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>
        <p className="px-6 pb-5 text-xs text-muted">Private · your data stays in your database</p>
      </aside>

      <div className="lg:pl-[238px]">
        {/* Top bar */}
        <header className="sticky top-0 z-20 border-b border-border bg-surface/95 backdrop-blur">
          <div className="flex h-14 items-center justify-between gap-3 px-4 lg:h-[76px] lg:px-8">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-white lg:hidden">
                <Wallet className="size-4" aria-hidden />
              </span>
              <h1 className="truncate text-base font-semibold lg:text-xl">{pageTitle}</h1>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                onClick={() => openModal('drive-sync')}
                className="max-lg:h-10 max-lg:w-10 max-lg:px-0"
                aria-label="Drive sync"
              >
                <RefreshCw className="size-4" aria-hidden />
                <span className="hidden lg:inline">Drive sync</span>
              </Button>
              <Button
                variant="ghost"
                onClick={() => openModal('import')}
                className="max-lg:h-10 max-lg:w-10 max-lg:px-0"
                aria-label="Import"
              >
                <Upload className="size-4" aria-hidden />
                <span className="hidden lg:inline">Import</span>
              </Button>
              <Button
                onClick={() => openModal('add-entry')}
                className="max-lg:h-10 max-lg:w-10 max-lg:px-0"
                aria-label="Add entry"
              >
                <Plus className="size-4" aria-hidden />
                <span className="hidden lg:inline">Add entry</span>
              </Button>
            </div>
          </div>
        </header>

        {/* Page content; bottom padding clears the mobile nav */}
        <main className="mx-auto w-full max-w-[1200px] px-4 py-6 pb-28 lg:px-8 lg:pb-10">
          <Outlet />
        </main>
      </div>

      {/* Mobile bottom navigation — horizontally scrollable, reaches all 9 tabs */}
      <nav
        aria-label="Main navigation"
        className="scroll-rail fixed inset-x-0 bottom-0 z-30 overflow-x-auto border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        <div className="flex min-w-max px-2">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex min-w-[72px] flex-col items-center gap-1 px-2 py-2.5 text-xs font-medium ${
                  isActive ? 'text-accent' : 'text-muted'
                }`
              }
            >
              <Icon className="size-5" aria-hidden />
              {label}
            </NavLink>
          ))}
        </div>
      </nav>

      <Toasts />
      <UpdateBanner />
      <GlobalModals />
    </div>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-4 top-16 z-[60] flex flex-col items-center gap-2 sm:inset-x-auto sm:right-6 sm:top-24 sm:items-end">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`pointer-events-auto flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium text-white shadow-lg ${
            t.kind === 'success' ? 'bg-positive' : 'bg-danger'
          }`}
        >
          {t.message}
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => dismiss(t.id)}
            className="rounded-md p-0.5 hover:bg-white/20"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}

// Version-skew banner (sprint 13, shared/version.ts): a tab that loaded
// before a deploy is still running the old bundle against the new worker.
// Non-blocking and dismissible only — see shared/version.ts for why this
// NEVER reloads on its own. Positioned above the mobile bottom nav (z-30,
// bottom-anchored) and below the Modal overlay (z-50) and Toasts (z-[60]).
function UpdateBanner() {
  const serverBuildId = useStore((s) => s.serverBuildId);
  const [dismissedBuildId, setDismissedBuildId] = useState<string | null>(null);

  if (!shouldOfferReload(BUILD_ID, serverBuildId, dismissedBuildId)) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-4 z-40 mx-auto flex max-w-sm items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-sm shadow-lg bottom-[calc(5rem+env(safe-area-inset-bottom))] lg:inset-x-auto lg:right-6 lg:left-auto lg:bottom-6"
    >
      <span className="flex-1 font-medium text-ink">A new version of Ledgerly is available.</span>
      <Button
        size="sm"
        onClick={() => {
          // The ONLY reload in this codebase, and only from this user-initiated
          // click — never auto-reload (see shared/version.ts header comment):
          // an open review modal with in-progress edits must survive a deploy.
          window.location.reload();
        }}
      >
        Reload
      </Button>
      <button
        type="button"
        aria-label="Dismiss update notice"
        onClick={() => setDismissedBuildId(serverBuildId)}
        className="rounded-md p-0.5 text-muted hover:bg-canvas hover:text-ink"
      >
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );
}
