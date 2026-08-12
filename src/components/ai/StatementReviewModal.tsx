// Review modal for a PDF statement's proposed rows — the heart of sprint 4.
// A statement is a table, not a receipt: dozens of row-level proposals
// triaged at once instead of one form per document. Same vision principle as
// receipt extraction: AI suggests, nothing is written until the user
// confirms; missing/low-confidence fields are flagged, never invented.
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { fmtDate, fmtSigned } from '../../../shared/format';
import type {
  BatchInsertResult,
  DocumentMeta,
  StatementExtraction,
  StatementRow,
  TxType,
} from '../../../shared/types';
import { useStore } from '../../store';
import { Button, InlineError, Input, Modal, Select } from '../ui';
import {
  applyDraftPatch,
  buildStatementConfirmInput,
  canRowBeSelected,
  filterBySnapshot,
  isCleanOutcome,
  missingRowFields,
  seedStatementRowDraft,
  selectableRows,
  visibleLowConfidenceFields,
  type StatementRowDraft,
} from './statementHelpers';

const PROVIDER_LABEL: Record<string, string> = {
  'workers-ai': 'Workers AI',
  anthropic: 'Anthropic',
  sarvam: 'Sarvam',
};

const TYPE_OPTIONS: { value: TxType; label: string }[] = [
  { value: 'expense', label: 'Expense' },
  { value: 'income', label: 'Income' },
];

function buildDraftsMap(rows: StatementRow[], categories: string[]): Record<string, StatementRowDraft> {
  const map: Record<string, StatementRowDraft> = {};
  for (const row of rows) map[row.id] = seedStatementRowDraft(row, categories);
  return map;
}

export function StatementReviewModal({
  doc,
  statement,
  onClose,
}: {
  doc: DocumentMeta;
  statement: StatementExtraction;
  onClose: () => void;
}) {
  const settings = useStore((s) => s.settings);
  const confirmStatementRows = useStore((s) => s.confirmStatementRows);
  const dismissStatement = useStore((s) => s.dismissStatement);
  const toast = useStore((s) => s.toast);

  // Only rows still awaiting triage are shown — a row the server has already
  // flipped to confirmed/dismissed (e.g. from an earlier partial confirm in
  // this same session) has nothing left to do and would just be clutter.
  const pendingRows = useMemo(() => statement.rows.filter((r) => r.status === 'proposed'), [statement.rows]);

  const [drafts, setDrafts] = useState<Record<string, StatementRowDraft>>(() =>
    buildDraftsMap(pendingRows, settings.categories),
  );
  const [account, setAccount] = useState(settings.accounts[0] ?? '');
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<BatchInsertResult | null>(null);
  const [busy, setBusy] = useState<'confirm' | 'dismiss' | null>(null);
  // A frozen id-set, not a live predicate: filtering by "is this row
  // CURRENTLY flagged" would unmount the row under the user's cursor the
  // instant their edit clears its last flag (visibleRows drops it, focus
  // falls to body). Snapshotting on toggle-on keeps the filtered set stable
  // through edits; re-toggling off then on again takes a fresh snapshot.
  const [flaggedSnapshot, setFlaggedSnapshot] = useState<Set<string> | null>(null);
  const [confirmingDismissAll, setConfirmingDismissAll] = useState(false);

  // Server truth, not a guess: after a confirm, store.confirmStatementRows
  // refreshes `statements` from the server, and rows that actually got
  // inserted flip away from 'proposed'. Re-sync local drafts from that
  // authoritative list rather than trying to infer which specific rows a
  // BatchInsertResult's aggregate counts refer to — rows no longer proposed
  // drop out of the table, and everything still proposed keeps its
  // in-progress edits untouched.
  useEffect(() => {
    setDrafts((prev) => {
      const next: Record<string, StatementRowDraft> = {};
      let changed = false;
      for (const row of pendingRows) {
        if (prev[row.id]) {
          next[row.id] = prev[row.id];
        } else {
          next[row.id] = seedStatementRowDraft(row, settings.categories);
          changed = true;
        }
      }
      if (!changed && Object.keys(next).length !== Object.keys(prev).length) changed = true;
      return changed ? next : prev;
    });
  }, [pendingRows, settings.categories]);

  // Same identity-stability requirement as ExtractionReviewModal's
  // guardedClose: the frozen Modal re-runs its focus-trap effect whenever the
  // `onClose` it receives changes identity, so this must stay referentially
  // stable across re-renders (busy read through a ref, not a closure).
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const guardedClose = useCallback(() => {
    if (!busyRef.current) onClose();
  }, [onClose]);

  // The "Dismiss all?" confirmation is an inline strip in the footer, not a
  // second nested Modal — so there's no second document-level Escape
  // listener to fight with the frozen Modal's own. Escape should still just
  // hide the strip rather than closing the whole review, though: a listener
  // registered in the CAPTURE phase runs before the Modal's own bubble-phase
  // listener even though both are on `document` (capture always precedes
  // bubble, regardless of registration order), so stopPropagation here wins
  // the race without any ref-based coordination with guardedClose.
  useEffect(() => {
    if (!confirmingDismissAll) return;
    const onKeyCapture = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // A dismiss actually in flight must not read as cancelled: let the
        // request finish (and the frozen Modal's own bubble-phase handler
        // no-op via guardedClose's busy check) instead of hiding the strip
        // out from under it.
        if (busyRef.current) return;
        e.stopPropagation();
        setConfirmingDismissAll(false);
      }
    };
    document.addEventListener('keydown', onKeyCapture, { capture: true });
    return () => document.removeEventListener('keydown', onKeyCapture, { capture: true });
  }, [confirmingDismissAll]);

  // The strip isn't a separate Modal, so nothing else moves focus into it
  // when it appears: without this, focus stays on the (now unmounted)
  // "Dismiss all" button, drops to body, and Tab can walk out to the page
  // behind the review modal (Shift+Tab would land on the destructive
  // "Dismiss" button first). Focus the strip's first button instead — which
  // must be "Keep" in DOM order (see the JSX below) so the safe,
  // non-destructive action is what a stray Enter/Space would trigger.
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (confirmingDismissAll) {
      stripRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    }
  }, [confirmingDismissAll]);

  // Stable across renders (functional setState — doesn't close over `drafts`)
  // so the memoized row component below only re-renders the row that
  // actually changed, not all (up to 300) rows on every keystroke.
  const updateDraft = useCallback((id: string, patch: Partial<StatementRowDraft>) => {
    setDrafts((prev) => {
      const current = prev[id];
      if (!current) return prev;
      return { ...prev, [id]: applyDraftPatch(current, patch) };
    });
    // Resuming edits after a partial outcome signals "let me try again" —
    // mirrors ExtractionReviewModal's duplicateNotice-clears-on-edit pattern.
    setOutcome(null);
  }, []);

  const selectedRows = useMemo(() => selectableRows(pendingRows, drafts), [pendingRows, drafts]);

  // Rows still worth a second look: the AI's original suggestion was
  // low-confidence for at least one field the user hasn't since edited away.
  // Printed statement order stays the primary sort (it's the cross-check
  // against the source PDF) — this is a filter, not a reorder. Stays LIVE
  // (unlike the snapshot below) because it only feeds the toolbar button's
  // count — watching it tick down as the user fixes rows is good feedback,
  // and it never controls what's mounted in the table.
  const flaggedRowIds = useMemo(() => {
    const ids = new Set<string>();
    for (const row of pendingRows) {
      const d = drafts[row.id];
      if (d && visibleLowConfidenceFields(row, d, settings.categories).length > 0) ids.add(row.id);
    }
    return ids;
  }, [pendingRows, drafts, settings.categories]);

  // Filtered by the frozen snapshot (see flaggedSnapshot above), not by the
  // live flaggedRowIds — this is what's actually mounted in the table.
  const visibleRows = useMemo(
    () => filterBySnapshot(pendingRows, flaggedSnapshot),
    [pendingRows, flaggedSnapshot],
  );

  // Bulk-select actions are scoped to what's currently on screen
  // (screen-is-the-scope): with the "Needs verification" filter active,
  // "Select all" must only touch the rows the user can actually see, not
  // every pending row hidden behind the filter. The footer's Import count
  // stays global (selectedRows, derived from all of `drafts`) regardless.
  function applySelection(pick: (row: StatementRow, draft: StatementRowDraft) => boolean) {
    setDrafts((prev) => {
      const next = { ...prev };
      for (const row of visibleRows) {
        const d = prev[row.id];
        if (!d) continue;
        next[row.id] = { ...d, selected: pick(row, d) };
      }
      return next;
    });
    setOutcome(null);
  }

  const noAccounts = settings.accounts.length === 0;
  const noCategories = settings.categories.length === 0;
  const providerLabel = PROVIDER_LABEL[statement.provider] ?? statement.provider;
  const previewUrl = `${api.documentDownloadUrl(doc.id)}?inline=1`;

  async function handleConfirm() {
    if (selectedRows.length === 0 || noAccounts) return;
    setBusy('confirm');
    setError(null);
    setOutcome(null);
    try {
      const input = buildStatementConfirmInput(selectedRows, drafts, account);
      const res = await confirmStatementRows(doc.id, input);
      if (isCleanOutcome(res, selectedRows.length)) {
        toast('success', `Imported ${res.inserted} transaction${res.inserted === 1 ? '' : 's'}.`);
        onClose();
        return;
      }
      // Honest, not silently swallowed: report exactly what happened. Uncheck
      // exactly the rows just attempted so a second click can't resubmit
      // them before the store's unawaited refresh lands (or if it never
      // does) — the rows that actually succeeded also fall out of
      // `pendingRows` once the effect above re-syncs from the server.
      const attemptedIds = new Set(input.rows.map((r) => r.rowId));
      setDrafts((prev) => {
        const next = { ...prev };
        for (const id of attemptedIds) {
          if (next[id]) next[id] = { ...next[id], selected: false };
        }
        return next;
      });
      setOutcome(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not import the selected rows.');
    } finally {
      setBusy(null);
    }
  }

  async function handleDismissAll() {
    setBusy('dismiss');
    setError(null);
    try {
      await dismissStatement(doc.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not dismiss this statement.');
      setBusy(null);
      setConfirmingDismissAll(false);
    }
  }

  return (
    <Modal
      title="Review statement"
      onClose={guardedClose}
      xl
      footer={
        confirmingDismissAll ? (
          // Inline strip, not a second nested Modal (a ConfirmDialog here
          // would unlock body scroll on its own cancel and double up
          // aria-modal against the review modal underneath it). Escape is
          // handled separately above; this is just the visible affordance.
          // ref + role="alert": see the focus-management effect above — the
          // "Dismiss all" button this strip replaces just unmounted, so
          // something has to move focus in, and the prompt needs to be
          // announced the same moment it takes focus.
          <div ref={stripRef} className="flex flex-wrap items-center justify-between gap-2">
            <p role="alert" className="text-sm font-medium text-danger">
              Dismiss all {pendingRows.length} remaining row{pendingRows.length === 1 ? '' : 's'}? This can&apos;t be
              undone.
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setConfirmingDismissAll(false)} disabled={busy !== null}>
                Keep
              </Button>
              <Button
                variant="danger"
                onClick={() => void handleDismissAll()}
                disabled={busy !== null}
                loading={busy === 'dismiss'}
              >
                Dismiss
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              variant="ghost"
              onClick={() => (pendingRows.length > 1 ? setConfirmingDismissAll(true) : void handleDismissAll())}
              disabled={busy !== null}
              loading={busy === 'dismiss'}
            >
              Dismiss all
            </Button>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onClose} disabled={busy !== null}>
                Cancel
              </Button>
              <Button
                onClick={() => void handleConfirm()}
                disabled={busy !== null || selectedRows.length === 0 || noAccounts}
                loading={busy === 'confirm'}
              >
                Import {selectedRows.length} transaction{selectedRows.length === 1 ? '' : 's'}
              </Button>
            </div>
          </div>
        )
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{doc.filename}</p>
            <p className="mt-0.5 text-xs text-muted">
              {statement.rowCount} row{statement.rowCount === 1 ? '' : 's'} read · Suggested by {providerLabel} ·{' '}
              {statement.model} · uploaded {fmtDate(doc.createdAt.slice(0, 10))}
            </p>
          </div>
          <a
            href={previewUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-accent hover:underline"
          >
            View original PDF <ExternalLink className="size-3.5" aria-hidden />
          </a>
        </div>

        {statement.truncated && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-xl border border-caution/40 bg-caution-soft px-3 py-2.5 text-sm text-caution"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              Only the first {statement.rowCount} row{statement.rowCount === 1 ? '' : 's'} were read from this
              statement; some transactions may be missing.
            </span>
          </div>
        )}

        <InlineError message={error} />

        {outcome && (
          <p role="status" className="rounded-lg bg-info-soft px-3 py-2 text-sm text-info">
            Imported {outcome.inserted}
            {outcome.duplicates > 0
              ? ` · ${outcome.duplicates} duplicate${outcome.duplicates === 1 ? '' : 's'} skipped`
              : ''}
            {outcome.errors.length > 0 ? ` · ${outcome.errors.length} error${outcome.errors.length === 1 ? '' : 's'}: ${outcome.errors.join('; ')}` : ''}
            . Remaining rows are still below for review.
          </p>
        )}

        {pendingRows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">Every row from this statement has been triaged.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" size="sm" onClick={() => applySelection((_r, d) => canRowBeSelected(d))} disabled={busy !== null}>
                  Select all
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => applySelection((r, d) => !r.duplicate && canRowBeSelected(d))}
                  disabled={busy !== null}
                >
                  Only new
                </Button>
                <Button variant="ghost" size="sm" onClick={() => applySelection(() => false)} disabled={busy !== null}>
                  Select none
                </Button>
                <Button
                  variant={flaggedSnapshot ? 'subtle' : 'ghost'}
                  size="sm"
                  onClick={() => setFlaggedSnapshot((prev) => (prev === null ? new Set(flaggedRowIds) : null))}
                  disabled={busy !== null}
                >
                  Needs verification ({flaggedRowIds.size})
                </Button>
              </div>
              <label className="flex items-center gap-2 text-xs font-medium text-muted">
                Account for this batch
                {noAccounts ? (
                  <span className="text-danger">Add an account in Settings first.</span>
                ) : (
                  <div className="w-44">
                    <Select
                      aria-label="Account for this batch"
                      value={account}
                      disabled={busy !== null}
                      onChange={(e) => setAccount(e.target.value)}
                    >
                      {settings.accounts.map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                    </Select>
                  </div>
                )}
              </label>
            </div>

            {visibleRows.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted">No rows need verification right now.</p>
            ) : (
              <div className="scroll-rail max-h-[50vh] overflow-auto rounded-xl border border-border">
                <table className="w-full min-w-[900px] border-collapse text-sm">
                  <thead className="sticky top-0 z-10 bg-canvas">
                    <tr className="border-b border-border text-left text-xs font-medium text-muted">
                      <th scope="col" className="w-11 px-2 py-2">
                        <span className="sr-only">Select</span>
                      </th>
                      <th scope="col" className="px-2 py-2">
                        Date
                      </th>
                      <th scope="col" className="px-2 py-2">
                        Merchant
                      </th>
                      <th scope="col" className="px-2 py-2">
                        Type
                      </th>
                      <th scope="col" className="px-2 py-2 text-right">
                        Amount
                      </th>
                      <th scope="col" className="px-2 py-2">
                        Category
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((row) => (
                      <StatementRowItem
                        key={row.id}
                        row={row}
                        draft={drafts[row.id]}
                        categories={settings.categories}
                        noCategories={noCategories}
                        busy={busy !== null}
                        onChange={updateDraft}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

const StatementRowItem = memo(function StatementRowItem({
  row,
  draft,
  categories,
  noCategories,
  busy,
  onChange,
}: {
  row: StatementRow;
  draft: StatementRowDraft | undefined;
  categories: string[];
  noCategories: boolean;
  busy: boolean;
  onChange: (id: string, patch: Partial<StatementRowDraft>) => void;
}) {
  if (!draft) return null;

  const missing = missingRowFields(draft);
  const flags = visibleLowConfidenceFields(row, draft, categories);
  const selectable = missing.length === 0;
  const amountNum = Number(draft.amount);
  const amountValid = !missing.includes('amount');
  let amountPreview: string | null = null;
  if (amountValid && draft.type) {
    amountPreview = fmtSigned(amountNum, draft.type);
  }
  const rowLabel = `row ${row.index + 1}`;

  return (
    <tr className={`border-b border-border last:border-0 ${row.duplicate ? 'bg-canvas/60 opacity-70' : ''}`}>
      <td className="px-2 py-2 align-top">
        <label
          className="flex h-11 w-11 items-center justify-center"
          title={!selectable ? `Missing: ${missing.join(', ')}` : undefined}
        >
          <input
            type="checkbox"
            checked={draft.selected}
            disabled={busy || !selectable}
            onChange={(e) => onChange(row.id, { selected: e.target.checked })}
            className="size-5 shrink-0 rounded border-border accent-accent disabled:opacity-40"
            aria-label={`Select ${rowLabel}${row.duplicate ? ' (already in your ledger)' : ''}`}
          />
        </label>
      </td>
      <td className="px-2 py-2 align-top">
        <div className="w-36">
          <Input
            type="date"
            aria-label={`Date for ${rowLabel}`}
            value={draft.date}
            disabled={busy}
            onChange={(e) => onChange(row.id, { date: e.target.value })}
          />
        </div>
        {missing.includes('date') ? (
          <p className="mt-1 text-[11px] font-medium text-danger">Missing date</p>
        ) : (
          flags.includes('date') && <FieldFlag />
        )}
      </td>
      <td className="px-2 py-2 align-top">
        <div className="w-48">
          <Input
            aria-label={`Merchant for ${rowLabel}`}
            value={draft.merchant}
            disabled={busy}
            onChange={(e) => onChange(row.id, { merchant: e.target.value })}
            placeholder="Merchant"
          />
        </div>
        {missing.includes('merchant') ? (
          <p className="mt-1 text-[11px] font-medium text-danger">Missing merchant</p>
        ) : (
          flags.includes('merchant') && <FieldFlag />
        )}
        {row.duplicate && <p className="mt-1 text-[11px] font-medium text-muted">Already in your ledger</p>}
      </td>
      <td className="px-2 py-2 align-top">
        <div className="w-32">
          <Select
            aria-label={`Type for ${rowLabel}`}
            value={draft.type}
            disabled={busy}
            onChange={(e) => onChange(row.id, { type: e.target.value as TxType })}
          >
            <option value="" disabled>
              Choose…
            </option>
            {TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        {missing.includes('type') ? (
          <p className="mt-1 text-[11px] font-medium text-danger">Missing type</p>
        ) : (
          flags.includes('type') && <FieldFlag />
        )}
      </td>
      <td className="px-2 py-2 align-top text-right">
        <div className="ml-auto w-28">
          <Input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            aria-label={`Amount for ${rowLabel}`}
            value={draft.amount}
            disabled={busy}
            onChange={(e) => onChange(row.id, { amount: e.target.value })}
            placeholder="0.00"
          />
        </div>
        {missing.includes('amount') ? (
          <p className="mt-1 text-[11px] font-medium text-danger">Missing amount</p>
        ) : (
          <>
            {amountPreview && (
              <p
                className={`mt-1 text-xs font-medium tabular-nums ${draft.type === 'income' ? 'text-positive' : 'text-ink'}`}
              >
                {amountPreview}
              </p>
            )}
            {flags.includes('amount') && <FieldFlag align="right" />}
          </>
        )}
      </td>
      <td className="px-2 py-2 align-top">
        {noCategories ? (
          <p className="text-xs text-muted">Add one in Settings.</p>
        ) : (
          <div className="w-40">
            <Select
              aria-label={`Category for ${rowLabel}`}
              value={draft.category}
              disabled={busy}
              onChange={(e) => onChange(row.id, { category: e.target.value })}
            >
              <option value="">Choose…</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </div>
        )}
        {flags.includes('category') && <FieldFlag />}
      </td>
    </tr>
  );
});

/** Visible (not title-only) low-confidence marker for a single table cell. */
function FieldFlag({ align = 'left' }: { align?: 'left' | 'right' }) {
  return (
    <p
      className={`mt-1 flex items-center gap-1 text-[11px] font-medium text-caution ${align === 'right' ? 'justify-end' : ''}`}
    >
      <AlertTriangle className="size-3 shrink-0" aria-hidden />
      Low confidence
    </p>
  );
}
