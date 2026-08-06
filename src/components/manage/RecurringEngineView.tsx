// Shared page body for Recurring (§10) and Subscriptions (§11) — "same
// engine, two lenses" per the sprint brief. Each page passes `kind` plus a
// little copy; everything else (detection wiring, Keep/Ignore, confirmed
// list, commitment totals) lives here once.
//
// Every write on this page (Keep, Ignore, Save, Toggle, Delete) targets the
// SAME settings.recurring/subscriptions/dismissedPatterns arrays. Two of
// them in flight at once would race: each computes its payload from a
// snapshot that doesn't yet include the other's not-yet-applied change, so
// whichever response lands last silently reverts the other. Fixed two ways,
// used together: (1) every handler reads useStore.getState() fresh at the
// moment it builds the payload, never the render-time `settings`/
// `confirmedItems` closures; (2) `anyBusy` disables every mutation control
// on the page (all suggestion cards, not just the one clicked, plus the
// confirmed list's Add/Edit/Delete/Toggle) while ANY write from this page
// is in flight, so writes are fully serialized and never actually overlap.
import { Pencil, Plus, Radar, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { detectPatterns } from '../../../shared/detection';
import { fmtCurrency, fmtDate, todayISO } from '../../../shared/format';
import type { DetectedPattern, RecurringItem, Settings } from '../../../shared/types';
import { useStore } from '../../store';
import { Button, Card, EmptyState } from '../ui';
import {
  CADENCE_LABELS,
  computeCommitmentTotals,
  dedupeSuggestions,
  patternToItem,
} from './commitmentTotals';
import { ConfirmDialog } from './ConfirmDialog';
import { PatternCard } from './PatternCard';
import { RecurringItemModal } from './RecurringItemModal';
import { Stat } from './Stat';
import { Toggle } from './Toggle';

function confirmedGroupOf(kind: DetectedPattern['kind'], settings: Settings): RecurringItem[] {
  return kind === 'subscription' ? settings.subscriptions : settings.recurring;
}

export function RecurringEngineView({
  kind,
  pageIcon: PageIcon,
  itemLabel,
  itemLabelPlural,
  addLabel,
  nextLabel,
}: {
  kind: DetectedPattern['kind'];
  pageIcon: typeof Radar;
  itemLabel: string;
  itemLabelPlural: string;
  addLabel: string;
  /** "Next expected payment" (Recurring, §10) vs "Next renewal" (Subscriptions, §11). */
  nextLabel: string;
}) {
  const transactions = useStore((s) => s.transactions);
  const settings = useStore((s) => s.settings);
  const updatePreferences = useStore((s) => s.updatePreferences);
  const toast = useStore((s) => s.toast);

  const confirmedItems = confirmedGroupOf(kind, settings);
  /** Persists the full confirmed list to the right settings group without a computed-key type hazard. */
  const persistItems = (next: RecurringItem[]) =>
    kind === 'subscription' ? updatePreferences({ subscriptions: next }) : updatePreferences({ recurring: next });
  /** Always the latest committed list — never the render-time closure. */
  const freshConfirmedItems = () => confirmedGroupOf(kind, useStore.getState().settings);

  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [modal, setModal] = useState<'add' | RecurringItem | null>(null);
  const [pendingDelete, setPendingDelete] = useState<RecurringItem | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /** Any write from this page in flight — see the file-header note. */
  const anyBusy = busyKey !== null || togglingId !== null || deleteBusy;

  const visibleSuggestions = useMemo(() => {
    const all = detectPatterns(transactions).filter((p) => p.kind === kind);
    const notDismissed = all.filter((p) => !settings.dismissedPatterns.includes(p.key));
    return dedupeSuggestions(notDismissed, confirmedItems);
  }, [transactions, settings.dismissedPatterns, confirmedItems, kind]);

  const confirmedActive = confirmedItems.filter((i) => i.active);
  const totals = computeCommitmentTotals(confirmedActive, visibleSuggestions);
  const today = todayISO();

  async function handleKeep(pattern: DetectedPattern) {
    setBusyKey(`keep:${pattern.key}`);
    try {
      const item = patternToItem(pattern);
      await persistItems([...freshConfirmedItems(), item]);
      toast('success', `Added "${item.name}" to your confirmed ${itemLabelPlural}.`);
    } catch (e) {
      toast('error', e instanceof Error ? e.message : `Could not save that ${itemLabel}.`);
    } finally {
      setBusyKey(null);
    }
  }

  async function handleIgnore(pattern: DetectedPattern) {
    setBusyKey(`ignore:${pattern.key}`);
    try {
      const freshDismissed = useStore.getState().settings.dismissedPatterns;
      await updatePreferences({ dismissedPatterns: [...freshDismissed, pattern.key] });
      toast('success', 'Hidden. Restore ignored suggestions anytime from Settings.');
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Could not hide that suggestion.');
    } finally {
      setBusyKey(null);
    }
  }

  async function handleSaveItem(item: RecurringItem) {
    const current = freshConfirmedItems();
    const exists = current.some((i) => i.id === item.id);
    const next = exists ? current.map((i) => (i.id === item.id ? item : i)) : [...current, item];
    await persistItems(next);
    toast('success', exists ? `${itemLabel} updated.` : `${itemLabel} added.`);
  }

  async function handleToggleActive(item: RecurringItem) {
    setTogglingId(item.id);
    try {
      const current = freshConfirmedItems();
      await persistItems(current.map((i) => (i.id === item.id ? { ...i, active: !i.active } : i)));
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Could not update active status.');
    } finally {
      setTogglingId(null);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const current = freshConfirmedItems();
      await persistItems(current.filter((i) => i.id !== pendingDelete.id));
      toast('success', `${itemLabel} deleted.`);
      setPendingDelete(null);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : `Could not delete that ${itemLabel}.`);
    } finally {
      setDeleteBusy(false);
    }
  }

  const categories = settings.categories;
  const accounts = settings.accounts;

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
            <PageIcon className="size-5" aria-hidden />
          </span>
          <div>
            <p className="text-sm font-semibold">Active detection</p>
            <p className="mt-0.5 text-sm text-muted">
              {transactions.length === 0
                ? `Add or import expense transactions and Ledgerly will start suggesting ${itemLabelPlural} automatically.`
                : visibleSuggestions.length > 0
                  ? `Found ${visibleSuggestions.length} pattern${visibleSuggestions.length === 1 ? '' : 's'} worth a look, scanning ${transactions.length} transaction${transactions.length === 1 ? '' : 's'}.`
                  : `Scanning ${transactions.length} transaction${transactions.length === 1 ? '' : 's'}. No new patterns right now — Ledgerly rechecks automatically as you add more.`}
            </p>
          </div>
        </div>
      </Card>

      <Card title="Suggestions">
        {visibleSuggestions.length === 0 ? (
          <EmptyState
            compact
            title="No suggestions right now"
            body="Detection never confirms anything automatically — Keep a suggestion here once one appears, or add one manually below."
          />
        ) : (
          <div className="space-y-3">
            {visibleSuggestions.map((p) => (
              <PatternCard
                key={p.key}
                pattern={p}
                busy={
                  busyKey === `keep:${p.key}` ? 'keep' : busyKey === `ignore:${p.key}` ? 'ignore' : null
                }
                locked={anyBusy}
                onKeep={() => void handleKeep(p)}
                onIgnore={() => void handleIgnore(p)}
              />
            ))}
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Estimated monthly" value={fmtCurrency(totals.monthly)} />
        <Stat label="Estimated annual" value={fmtCurrency(totals.annual)} />
        <Stat label={nextLabel} value={totals.nextDate ? fmtDate(totals.nextDate) : 'None upcoming'} />
      </div>

      <Card
        title={`Confirmed ${itemLabelPlural}`}
        action={
          <Button size="sm" onClick={() => setModal('add')} disabled={anyBusy}>
            <Plus className="size-4" aria-hidden />
            {addLabel}
          </Button>
        }
      >
        {confirmedItems.length === 0 ? (
          <EmptyState
            icon={PageIcon}
            title={`No confirmed ${itemLabelPlural} yet`}
            body={`Keep a detected suggestion above, or add one manually.`}
            action={<Button onClick={() => setModal('add')} disabled={anyBusy}>{addLabel}</Button>}
          />
        ) : (
          <ul className="divide-y divide-border">
            {confirmedItems.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{item.name}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {item.category} · {CADENCE_LABELS[item.cadence]} ·{' '}
                    {item.nextDate < today ? (
                      <span className="font-medium text-caution">Next date passed — update it</span>
                    ) : (
                      `Next ${fmtDate(item.nextDate)}`
                    )}
                    {item.account ? ` · ${item.account}` : ''}
                  </p>
                </div>
                <p className="text-sm font-semibold tabular-nums">{fmtCurrency(item.amount)}</p>
                <Toggle
                  checked={item.active}
                  onChange={() => void handleToggleActive(item)}
                  label={`${item.active ? 'Deactivate' : 'Activate'} ${item.name}`}
                  disabled={anyBusy}
                />
                <button
                  type="button"
                  aria-label={`Edit ${item.name}`}
                  onClick={() => setModal(item)}
                  disabled={anyBusy}
                  className="flex size-9 items-center justify-center rounded-lg text-muted hover:bg-canvas hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  <Pencil className="size-4" aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${item.name}`}
                  onClick={() => setPendingDelete(item)}
                  disabled={anyBusy}
                  className="flex size-9 items-center justify-center rounded-lg text-muted hover:bg-danger-soft hover:text-danger disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  <Trash2 className="size-4" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {modal !== null && (
        <RecurringItemModal
          nameLabel={itemLabel}
          categories={categories}
          accounts={accounts}
          initial={modal === 'add' ? undefined : modal}
          onClose={() => setModal(null)}
          onSave={handleSaveItem}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete "${pendingDelete.name}"?`}
          message={<p>This removes it from your confirmed {itemLabelPlural}. This can&apos;t be undone.</p>}
          busy={deleteBusy}
          error={deleteError}
          onConfirm={() => void confirmDelete()}
          onCancel={() => {
            setPendingDelete(null);
            setDeleteError(null);
          }}
        />
      )}
    </div>
  );
}
