// Confirm modal for a mail-in inbox item (sprint 8). The parser behind a
// proposal is deterministic — its fields are facts read off the email, so
// there is no confidence chrome here (unlike AI extraction). Nothing is ever
// inserted until the user confirms; Dismiss marks the email rejected. An
// unparsed email opens this same form with EMPTY fields — the user fills
// everything, and the email itself remains the audit trail.
//
// All of sprint 4's modal lessons apply: the caller keys this component by
// item id (full remount per item), passes a referentially stable onClose,
// and this file guards close through a busy ref — one in-flight action,
// no focus-steal.
import { useCallback, useRef, useState } from 'react';
import { fmtDate } from '../../../shared/format';
import type { InboxEmail, TxType } from '../../../shared/types';
import { useStore } from '../../store';
import { Button, Field, InlineError, Input, Modal, Select, SegmentedControl } from '../ui';
import {
  buildInboxTxInput,
  seedInboxDraft,
  validateInboxDraft,
  type InboxDraft,
} from './inboxHelpers';

const TYPE_OPTIONS: { value: TxType; label: string }[] = [
  { value: 'expense', label: 'Expense' },
  { value: 'income', label: 'Income' },
];

export function InboxConfirmModal({ item, onClose }: { item: InboxEmail; onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const confirmInboxEmail = useStore((s) => s.confirmInboxEmail);
  const dismissInboxEmail = useStore((s) => s.dismissInboxEmail);
  const toast = useStore((s) => s.toast);

  const [draft, setDraft] = useState(() => seedInboxDraft(item, settings));
  const [error, setError] = useState<string | null>(null);
  const [duplicateNotice, setDuplicateNotice] = useState(false);
  const [busy, setBusy] = useState<'confirm' | 'dismiss' | null>(null);

  // Same referentially-stable guarded close as ExtractionReviewModal: the
  // frozen Modal re-runs its focus effect when onClose changes identity, so
  // the guard reads `busy` through a ref instead of closing over it.
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const guardedClose = useCallback(() => {
    if (!busyRef.current) onClose();
  }, [onClose]);

  const noAccounts = settings.accounts.length === 0;
  const noCategories = settings.categories.length === 0;

  // Every draft edit clears a stale duplicate notice — a genuine second
  // identical purchase is a real case, and editing signals "let me try
  // confirming again" (ExtractionReviewModal precedent).
  function updateDraft(updater: (d: InboxDraft) => InboxDraft) {
    setDraft(updater);
    setDuplicateNotice(false);
  }

  async function handleConfirm() {
    // Payload is built from the FORM as it stands at submit time — never
    // from a snapshot taken at open/seed time.
    const validationError = validateInboxDraft(draft);
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy('confirm');
    setError(null);
    setDuplicateNotice(false);
    try {
      const res = await confirmInboxEmail(item.id, buildInboxTxInput(draft));
      if (res.duplicates > 0 && res.inserted === 0) {
        // Honest, not an error — already in the ledger, nothing new added.
        setDuplicateNotice(true);
        return;
      }
      if (res.inserted === 0) {
        setError(res.errors[0] ?? 'Could not save the transaction.');
        return;
      }
      toast('success', 'Transaction added from email.');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not confirm this transaction.');
    } finally {
      setBusy(null);
    }
  }

  async function handleDismiss() {
    setBusy('dismiss');
    setError(null);
    try {
      await dismissInboxEmail(item.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not dismiss this email.');
      setBusy(null);
    }
  }

  return (
    <Modal
      title={item.parsed ? 'Review email proposal' : 'Add from email'}
      onClose={guardedClose}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            variant="ghost"
            onClick={() => void handleDismiss()}
            disabled={busy !== null}
            loading={busy === 'dismiss'}
          >
            Dismiss
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy !== null}>
              {duplicateNotice ? 'Close' : 'Cancel'}
            </Button>
            {!duplicateNotice && (
              <Button onClick={() => void handleConfirm()} disabled={busy !== null} loading={busy === 'confirm'}>
                Confirm
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {/* The source email — the audit trail behind whatever gets confirmed. */}
        <div className="rounded-xl border border-border bg-canvas px-3 py-2.5 text-xs text-muted">
          <p className="truncate">
            <span className="font-medium text-ink">{item.from}</span> · {fmtDate(item.receivedAt.slice(0, 10))}
          </p>
          <p className="mt-0.5 truncate">{item.subject}</p>
          {!item.parsed && (
            <p className="mt-1">
              Couldn&apos;t read a transaction from this email — enter the details yourself.
            </p>
          )}
        </div>

        <InlineError message={error} />
        {duplicateNotice && (
          <p role="status" className="rounded-lg bg-info-soft px-3 py-2 text-sm text-info">
            Already in your ledger — nothing new was added.
          </p>
        )}

        {/* Unset type renders with neither segment checked (unparsed emails
            only) — validation blocks Confirm until one is chosen. */}
        <SegmentedControl<TxType | ''>
          ariaLabel="Entry type"
          options={TYPE_OPTIONS}
          value={draft.type}
          onChange={(v) => updateDraft((d) => ({ ...d, type: v }))}
        />

        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount">
            <Input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={draft.amount}
              disabled={busy !== null}
              onChange={(e) => updateDraft((d) => ({ ...d, amount: e.target.value }))}
            />
          </Field>
          <Field label="Date">
            <Input
              type="date"
              value={draft.date}
              disabled={busy !== null}
              onChange={(e) => updateDraft((d) => ({ ...d, date: e.target.value }))}
            />
          </Field>
        </div>

        <Field label="Merchant">
          <Input
            value={draft.merchant}
            disabled={busy !== null}
            onChange={(e) => updateDraft((d) => ({ ...d, merchant: e.target.value }))}
            placeholder="e.g. Coffee shop"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Category">
            {noCategories ? (
              <p className="text-xs text-muted">Add a category in Settings first.</p>
            ) : (
              <Select
                value={draft.category}
                disabled={busy !== null}
                onChange={(e) => updateDraft((d) => ({ ...d, category: e.target.value }))}
              >
                <option value="" disabled>
                  Choose a category…
                </option>
                {settings.categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Account">
            {noAccounts ? (
              <p className="text-xs text-muted">Add an account in Settings first.</p>
            ) : (
              <Select
                value={draft.account}
                disabled={busy !== null}
                onChange={(e) => updateDraft((d) => ({ ...d, account: e.target.value }))}
              >
                {settings.accounts.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <p className="text-xs text-muted">
          {item.parsed
            ? `Parsed by ${item.parsed.pack} — deterministic, no AI involved. You confirm every field.`
            : 'Entered by you — the original email stays as the audit trail.'}
        </p>
      </div>
    </Modal>
  );
}
