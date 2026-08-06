// Tag deletion for the Rules page's Tags section (spec §15.2) — the only tag
// deletion flow that offers to strip the tag from historical transactions.
// (Settings §16.2 tag removal is the simpler "future pickers only" version.)
import { useState } from 'react';
import { Button, InlineError, Modal } from '../ui';

export function TagDeleteModal({
  name,
  usageCount,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  name: string;
  usageCount: number;
  busy: boolean;
  error: string | null;
  onConfirm: (stripFromHistory: boolean) => void;
  onCancel: () => void;
}) {
  const [stripFromHistory, setStripFromHistory] = useState(false);

  return (
    <Modal
      title={`Delete tag "${name}"?`}
      // Guarded the same way as ConfirmDialog/WipeDataModal: a strip-from-
      // history delete can loop over many transactions, so Escape/backdrop
      // must not dismiss the dialog while that's actually in flight.
      onClose={busy ? () => {} : onCancel}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => onConfirm(stripFromHistory)} loading={busy}>
            Delete tag
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-sm text-muted">
        <p>This removes the tag from future tag pickers. It won&apos;t be selectable going forward.</p>
        {usageCount > 0 && (
          <label className="flex items-start gap-2.5 rounded-xl border border-border p-3 text-ink">
            <input
              type="checkbox"
              checked={stripFromHistory}
              onChange={(e) => setStripFromHistory(e.target.checked)}
              disabled={busy}
              className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
            />
            <span>
              Also remove this tag from {usageCount} existing transaction{usageCount === 1 ? '' : 's'}. If
              left unchecked, those transactions keep the tag.
            </span>
          </label>
        )}
        <InlineError message={error} />
      </div>
    </Modal>
  );
}
