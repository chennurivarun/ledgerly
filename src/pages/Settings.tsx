// Settings page (spec §16) — display currency, net worth setup, managed
// categories/tags/accounts, automatic detection controls, Drive sync status,
// and the danger zone.
import { AlertTriangle, Coins, ExternalLink, FolderSync, Radar, RotateCcw, Wallet } from 'lucide-react';
import { useEffect, useState } from 'react';
import { fmtCurrency } from '../../shared/format';
import { CurrencySelect } from '../components/CurrencySelect';
import { ManagedListSection } from '../components/manage/ManagedListSection';
import { StatusBadge } from '../components/manage/StatusBadge';
import { useDriveSync } from '../components/manage/useDriveSync';
import { WipeDataModal } from '../components/manage/WipeDataModal';
import { useStore } from '../store';
import { Button, Card, EmptyState, Field, InlineError, Input, Spinner } from '../components/ui';

function formatScheduleTime(time: string): string {
  const [h, m] = time.split(':').map(Number);
  if (!Number.isFinite(h)) return time;
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m ?? 0).padStart(2, '0')} ${period}`;
}

const SYNC_TONE = { complete: 'positive', partial: 'caution', error: 'danger' } as const;

export default function Settings() {
  const settings = useStore((s) => s.settings);
  const tags = useStore((s) => s.tags);
  const updatePreferences = useStore((s) => s.updatePreferences);
  const wipeAll = useStore((s) => s.wipeAll);
  const toast = useStore((s) => s.toast);
  const drive = useDriveSync();
  // Single source for BOTH the error count and the error list: DriveSyncStatus.folder
  // is a DriveSyncMeta and already carries `lastErrors` (message strings), so
  // both numbers come from this one /api/drive-sync fetch instead of pairing
  // it with settings.drive (a separate GET /api/state fetch) that could
  // disagree if a sync completes between the two requests.
  const driveErrorMessages = drive.status?.folder.lastErrors ?? [];

  return (
    <div className="space-y-6">
      <CurrencySection
        currency={settings.currency}
        onSave={async (code) => {
          await updatePreferences({ currency: code });
          toast('success', 'Display currency updated.');
        }}
      />

      <NetWorthSection
        assetsTotal={settings.assetsTotal}
        liabilitiesTotal={settings.liabilitiesTotal}
        configured={settings.netWorthConfigured}
        onSave={async (assets, liabilities) => {
          await updatePreferences({
            assetsTotal: assets,
            liabilitiesTotal: liabilities,
            netWorthConfigured: true,
          });
          toast('success', 'Net worth totals saved.');
        }}
      />

      <Card title="Managed categories, tags & accounts">
        {/*
          ponytail: blockRemove only guards "don't let the list go to zero" —
          it can't know whether `name` is the value currently selected in
          some other open form elsewhere on the app (e.g. mid-edit in a
          Recurring/Budget modal on another tab). True open-form tracking
          would need a shared registry of "categories/accounts in use by an
          open form" wired through every page that owns a form with a
          category/account picker, which doesn't exist in this scaffold.
          The last-item guard plus label preservation on removal (existing
          rows keep their historical value) are the practical mitigations.
        */}
        <div className="space-y-6">
          <ManagedListSection
            title="Categories"
            itemLabel="category"
            items={settings.categories}
            blockRemove={(name) =>
              settings.categories.length <= 1
                ? `Keep at least one category — "${name}" can't be the last one removed.`
                : null
            }
            onAdd={async (name) => {
              // Read fresh: two adds (or an add racing a remove) in flight
              // together must not silently drop each other's change.
              const current = useStore.getState().settings.categories;
              await updatePreferences({ categories: [...current, name] });
            }}
            onRemove={async (name) => {
              const current = useStore.getState().settings.categories;
              await updatePreferences({ categories: current.filter((c) => c !== name) });
            }}
          />
          <ManagedListSection
            title="Tags"
            itemLabel="tag"
            items={tags.map((t) => t.name)}
            onAdd={async (name) => {
              const current = useStore.getState().tags;
              await updatePreferences({ tags: [...current.map((t) => t.name), name] });
            }}
            onRemove={async (name) => {
              const current = useStore.getState().tags;
              await updatePreferences({ tags: current.map((t) => t.name).filter((n) => n !== name) });
            }}
          />
          <ManagedListSection
            title="Accounts"
            itemLabel="account"
            items={settings.accounts}
            blockRemove={(name) =>
              settings.accounts.length <= 1
                ? `Keep at least one account — "${name}" can't be the last one removed.`
                : null
            }
            onAdd={async (name) => {
              const current = useStore.getState().settings.accounts;
              await updatePreferences({ accounts: [...current, name] });
            }}
            onRemove={async (name) => {
              const current = useStore.getState().settings.accounts;
              await updatePreferences({ accounts: current.filter((a) => a !== name) });
            }}
          />
        </div>
      </Card>

      <DetectionSection
        ignoredCount={settings.dismissedPatterns.length}
        onRestore={async () => {
          const count = settings.dismissedPatterns.length;
          await updatePreferences({ dismissedPatterns: [] });
          toast('success', `Restored ${count} ignored suggestion${count === 1 ? '' : 's'}.`);
        }}
      />

      <Card title="Google Drive sync">
        {drive.loading ? (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner className="size-4" /> Checking Drive sync status…
          </p>
        ) : drive.error ? (
          <div className="space-y-2">
            <InlineError message={drive.error} />
            <Button variant="ghost" size="sm" onClick={() => void drive.reload()}>
              Try again
            </Button>
          </div>
        ) : !drive.status?.folder.folderUrl ? (
          <EmptyState
            icon={FolderSync}
            compact
            title="Drive inbox not configured yet"
            body="Once a dedicated Drive folder is connected, files added there are checked automatically at 8:00 AM daily."
          />
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-sm font-semibold">{drive.status.folder.folderName ?? 'Drive inbox'}</p>
              <a
                href={drive.status.folder.folderUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
              >
                View folder <ExternalLink className="size-3.5" aria-hidden />
              </a>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge
                label={`Daily at ${formatScheduleTime(drive.status.schedule.time)} · ${drive.status.schedule.timezone}`}
                tone="accent"
              />
              {drive.status.lastStatus && (
                <StatusBadge
                  label={
                    drive.status.lastStatus === 'complete'
                      ? 'Last sync complete'
                      : drive.status.lastStatus === 'partial'
                        ? 'Last sync partial'
                        : 'Last sync error'
                  }
                  tone={SYNC_TONE[drive.status.lastStatus]}
                />
              )}
            </div>
            <p className="text-xs text-muted">
              {drive.status.lastSyncedAt
                ? `Last synced ${new Date(drive.status.lastSyncedAt).toLocaleString()}`
                : 'Not synced yet.'}
            </p>
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
              <div>
                <p className="text-xs text-muted">Imported</p>
                <p className="font-medium">{drive.status.counts.imported}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Duplicates</p>
                <p className="font-medium">{drive.status.counts.duplicates}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Stored</p>
                <p className="font-medium">{drive.status.counts.stored}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Review</p>
                <p className="font-medium">{drive.status.counts.review}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Errors</p>
                <p className="font-medium">{driveErrorMessages.length}</p>
              </div>
            </div>
            {driveErrorMessages.length > 0 && (
              <ul className="list-inside list-disc space-y-1 text-xs text-danger">
                {driveErrorMessages.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted">
              Add a receipt, CSV, statement, or invoice to the folder — it&apos;s checked daily at 8:00 AM.
            </p>
          </div>
        )}
      </Card>

      <SetupSection
        onRerun={async () => {
          await updatePreferences({ onboarded: false });
        }}
      />

      <DangerZone onWipe={wipeAll} onSuccess={() => toast('success', 'All Ledgerly data has been erased.')} />
    </div>
  );
}

function CurrencySection({
  currency,
  onSave,
}: {
  currency: string;
  onSave: (code: string) => Promise<void>;
}) {
  // `pending` optimistically holds the just-picked code while the save is in
  // flight: the store's `currency` prop only updates once updatePreferences
  // resolves, so binding the select directly to `currency` during that
  // round-trip would render the OLD value on every re-render (the click
  // "snaps back" until the request completes, and reads as a rejection on a
  // slow connection). Once the request settles, `pending` clears and the
  // select falls through to `currency` — which by then matches on success,
  // and reverts naturally to the pre-change value on error.
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(code: string) {
    if (code === currency) return;
    setPending(code);
    setError(null);
    try {
      await onSave(code);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save. Try again.');
    } finally {
      setPending(null);
    }
  }

  return (
    <Card title="Currency">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Coins className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted">
            Sets how amounts are displayed across Ledgerly. This changes formatting only — existing
            amounts are not converted between currencies.
          </p>
          <div className="mt-3 flex max-w-xs items-center gap-2">
            <CurrencySelect
              value={pending ?? currency}
              onChange={(code) => void handleChange(code)}
              disabled={pending !== null}
            />
            {pending !== null && <Spinner className="size-4 shrink-0 text-muted" />}
          </div>
          <InlineError message={error} />
        </div>
      </div>
    </Card>
  );
}

function SetupSection({ onRerun }: { onRerun: () => Promise<void> }) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRerun() {
    setRunning(true);
    setError(null);
    try {
      await onRerun();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start setup. Try again.');
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card title="Setup">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
            <RotateCcw className="size-5" aria-hidden />
          </span>
          <p className="text-sm text-muted">Reopens the first-run setup wizard.</p>
        </div>
        <Button variant="ghost" size="sm" loading={running} onClick={() => void handleRerun()}>
          Run setup again
        </Button>
      </div>
      <InlineError message={error} />
    </Card>
  );
}

function NetWorthSection({
  assetsTotal,
  liabilitiesTotal,
  configured,
  onSave,
}: {
  assetsTotal: number;
  liabilitiesTotal: number;
  configured: boolean;
  onSave: (assets: number, liabilities: number) => Promise<void>;
}) {
  const [assetsDraft, setAssetsDraft] = useState(String(assetsTotal));
  const [liabilitiesDraft, setLiabilitiesDraft] = useState(String(liabilitiesTotal));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // This section stays mounted across a danger-zone wipe (spec §16.5), which
  // resets assetsTotal/liabilitiesTotal to 0 outside of user input — resync
  // the drafts so the form actually returns to the empty state instead of
  // showing stale pre-wipe numbers.
  useEffect(() => {
    setAssetsDraft(String(assetsTotal));
    setLiabilitiesDraft(String(liabilitiesTotal));
  }, [assetsTotal, liabilitiesTotal]);

  const previewAssets = Number(assetsDraft);
  const previewLiabilities = Number(liabilitiesDraft);
  const validPreview = Number.isFinite(previewAssets) && Number.isFinite(previewLiabilities);
  const preview = validPreview ? previewAssets - previewLiabilities : null;

  async function handleSave() {
    if (!Number.isFinite(previewAssets) || previewAssets < 0) {
      setError(`Enter total assets as a number of ${fmtCurrency(0)} or more.`);
      return;
    }
    if (!Number.isFinite(previewLiabilities) || previewLiabilities < 0) {
      setError(`Enter total liabilities as a number of ${fmtCurrency(0)} or more.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(Math.round(previewAssets * 100) / 100, Math.round(previewLiabilities * 100) / 100);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Net worth">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Wallet className="size-5" aria-hidden />
        </span>
        <p className="text-sm text-muted">
          Net worth is your total assets minus your total liabilities — it is not calculated from
          monthly income minus expenses. Enter your own totals below.
        </p>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Total assets">
          <Input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={assetsDraft}
            onChange={(e) => setAssetsDraft(e.target.value)}
          />
        </Field>
        <Field label="Total liabilities">
          <Input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={liabilitiesDraft}
            onChange={(e) => setLiabilitiesDraft(e.target.value)}
          />
        </Field>
      </div>

      <div className="mt-4 rounded-xl border border-border bg-canvas px-4 py-3">
        <p className="text-xs font-medium text-muted">Live preview</p>
        <p className="mt-1 text-lg font-semibold">{preview !== null ? fmtCurrency(preview) : '—'}</p>
      </div>

      {configured && (
        <p className="mt-2 text-xs text-muted">Currently saved net worth is configured.</p>
      )}

      <InlineError message={error} />

      <div className="mt-4 flex justify-end">
        <Button onClick={() => void handleSave()} loading={saving}>
          Save net worth
        </Button>
      </div>
    </Card>
  );
}

function DetectionSection({
  ignoredCount,
  onRestore,
}: {
  ignoredCount: number;
  onRestore: () => Promise<void>;
}) {
  const [restoring, setRestoring] = useState(false);

  return (
    <Card title="Automatic detection">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Radar className="size-5" aria-hidden />
        </span>
        <p className="text-sm text-muted">
          Ledgerly looks for expense transactions from the same merchant repeating on a steady
          weekly, biweekly, monthly, quarterly, or annual schedule with a stable amount. When it
          finds one, it shows a suggestion on Recurring or Subscriptions — it never creates a
          confirmed entry automatically. Choosing Keep confirms it; choosing Ignore hides it.
        </p>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-canvas px-4 py-3">
        <p className="text-sm">
          <span className="font-semibold">{ignoredCount}</span> ignored suggestion{ignoredCount === 1 ? '' : 's'}
        </p>
        <Button
          variant="ghost"
          size="sm"
          disabled={ignoredCount === 0}
          loading={restoring}
          onClick={async () => {
            setRestoring(true);
            try {
              await onRestore();
            } finally {
              setRestoring(false);
            }
          }}
        >
          Restore ignored suggestions
        </Button>
      </div>
    </Card>
  );
}

function DangerZone({ onWipe, onSuccess }: { onWipe: () => Promise<void>; onSuccess: () => void }) {
  const [open, setOpen] = useState(false);

  return (
    <Card title="Danger zone">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-danger-soft text-danger">
          <AlertTriangle className="size-5" aria-hidden />
        </span>
        <div className="flex-1">
          <p className="text-sm text-muted">
            Permanently erase every database record and stored file copy in Ledgerly. Files already
            in your connected Google Drive folder are not affected.
          </p>
          <div className="mt-3">
            <Button variant="danger" onClick={() => setOpen(true)}>
              Erase all Ledgerly data
            </Button>
          </div>
        </div>
      </div>

      {open && (
        <WipeDataModal
          onClose={() => setOpen(false)}
          onWipe={async () => {
            await onWipe();
            onSuccess();
          }}
        />
      )}
    </Card>
  );
}
