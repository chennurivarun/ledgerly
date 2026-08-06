// Tag-only modal opened by the "+" at the end of a transaction row's tags
// (spec §7.2). Select existing tags and/or create one new tag by name only —
// never asks for a category, rule, or color.
import { useState } from 'react';
import type { Transaction } from '../../../shared/types';
import { useStore } from '../../store';
import { Button, Field, InlineError, Input, Modal, TagPill } from '../ui';

export function TagEditModal({ transaction, onClose }: { transaction: Transaction; onClose: () => void }) {
  const allTags = useStore((s) => s.tags);
  const patchTransaction = useStore((s) => s.patchTransaction);
  const refreshQuiet = useStore((s) => s.refreshQuiet);
  const toast = useStore((s) => s.toast);

  const [selected, setSelected] = useState<string[]>(transaction.tags);
  const [newTag, setNewTag] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(name: string) {
    setSelected((prev) => (prev.includes(name) ? prev.filter((t) => t !== name) : [...prev, name]));
  }

  function addNewTag() {
    const name = newTag.trim();
    if (!name) return;
    if (!selected.some((t) => t.toLowerCase() === name.toLowerCase())) {
      setSelected((prev) => [...prev, name]);
    }
    setNewTag('');
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const isNewTag = selected.some((t) => !allTags.some((existing) => existing.name === t));
      await patchTransaction(transaction.id, { tags: selected });
      // Contract (spec §7.2, ratified against worker/index.ts): PATCH
      // /api/transactions registers new tag names globally. patchTransaction
      // only updates this one row locally, so refresh to pick up the new
      // global tag for other rows' pickers without a full page reload.
      if (isNewTag) void refreshQuiet();
      toast('success', 'Tags updated.');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save tags.');
    } finally {
      setSaving(false);
    }
  }

  const unselectedExisting = allTags.map((t) => t.name).filter((name) => !selected.includes(name));

  return (
    <Modal
      title={`Tags for ${transaction.merchant}`}
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={saving}>
            Save tags
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <InlineError message={error} />

        <div>
          <p className="mb-1.5 text-sm font-medium">Selected tags</p>
          {selected.length === 0 ? (
            <p className="text-sm text-muted">No tags yet.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {selected.map((t) => (
                <TagPill key={t} label={t} onRemove={() => toggle(t)} />
              ))}
            </div>
          )}
        </div>

        {unselectedExisting.length > 0 && (
          <div>
            <p className="mb-1.5 text-sm font-medium">Add an existing tag</p>
            <div className="flex flex-wrap gap-1.5">
              {unselectedExisting.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggle(t)}
                  className="rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted hover:border-accent hover:text-accent"
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        )}

        <Field label="Create a new tag" hint="Just a name — no category or color needed.">
          <div className="flex gap-2">
            <Input
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addNewTag();
                }
              }}
              placeholder="e.g. Reimbursable"
              maxLength={40}
            />
            <Button variant="ghost" onClick={addNewTag} disabled={!newTag.trim()}>
              Add
            </Button>
          </div>
        </Field>
      </div>
    </Modal>
  );
}
