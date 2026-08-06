// Generic confirmation dialog built from the frozen Modal primitive — used
// everywhere a page needs "delete this?" (rules, tags, categories, accounts,
// budgets, goals, documents). Built once here instead of re-implemented per
// page (laziness ladder).
import type { ReactNode } from 'react';
import { Button, InlineError, Modal } from '../ui';

export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Delete',
  tone = 'danger',
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  tone?: 'danger' | 'primary';
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      title={title}
      // ui.tsx's Modal (frozen) closes on Escape/backdrop-click unconditionally
      // — guard it here instead: no-op while a confirmed action is actually in
      // flight, so a stray Escape can't dismiss the dialog mid-request (same
      // fix as WipeDataModal, applied here since every delete flow in the app
      // shares this component).
      onClose={busy ? () => {} : onCancel}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant={tone} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-sm text-muted">
        {message}
        <InlineError message={error} />
      </div>
    </Modal>
  );
}
