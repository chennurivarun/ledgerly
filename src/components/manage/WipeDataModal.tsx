// Danger-zone "Erase all Ledgerly data" confirmation (spec §16.5). Requires
// typing DELETE exactly; the actual server confirmation string is sent by
// store.wipeAll() itself (api.wipeAll() hardcodes WIPE_CONFIRMATION).
import { useState } from 'react';
import { Button, Field, InlineError, Input, Modal } from '../ui';

const REQUIRED_TEXT = 'DELETE';

export function WipeDataModal({
  onClose,
  onWipe,
}: {
  onClose: () => void;
  onWipe: () => Promise<void>;
}) {
  const [confirmText, setConfirmText] = useState('');
  const [wiping, setWiping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = confirmText === REQUIRED_TEXT;

  async function handleConfirm() {
    if (!matches) return;
    setWiping(true);
    setError(null);
    try {
      await onWipe();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not erase your data. Try again.');
      setWiping(false);
    }
  }

  return (
    <Modal
      title="Erase all Ledgerly data"
      // ui.tsx's Modal (frozen) closes on Escape/backdrop-click unconditionally
      // — guard it here instead: no-op while a wipe is actually in flight, so
      // a stray Escape can't dismiss the dialog mid-request.
      onClose={wiping ? () => {} : onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={wiping}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void handleConfirm()} disabled={!matches} loading={wiping}>
            Erase everything
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-sm text-muted">
        <p>This permanently deletes every database record and stored file copy in Ledgerly: transactions, documents, budgets, goals, subscriptions, recurring items, rules, tags, and settings.</p>
        <p>Original files already in your connected Google Drive folder are not deleted or modified.</p>
        <p>This can&apos;t be undone.</p>
        <Field label={`Type ${REQUIRED_TEXT} to confirm`}>
          <Input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            disabled={wiping}
            placeholder={REQUIRED_TEXT}
            autoComplete="off"
          />
        </Field>
        <InlineError message={error} />
      </div>
    </Modal>
  );
}
