// Reusable "add by name / remove with confirmation" list — Settings §16.2 uses
// three of these (categories, tags, accounts) with identical rules: trim,
// case-insensitive duplicate prevention, optional guard against removing the
// last item, removal never touches historical transaction labels.
//
// Add and remove both rewrite the same list, so one of each in flight
// together would race (whichever response lands last silently reverts the
// other). The caller (Settings.tsx) reads fresh state at dispatch time to
// build each payload; this component additionally disables every mutation
// control here — the add form AND every chip's remove button — while
// `busy` is true, so the two write paths can never actually overlap.
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Button, Field, InlineError, Input } from '../ui';
import { ConfirmDialog } from './ConfirmDialog';

export function ManagedListSection({
  title,
  itemLabel,
  items,
  onAdd,
  onRemove,
  blockRemove,
}: {
  title: string;
  itemLabel: string;
  items: string[];
  onAdd: (name: string) => Promise<void>;
  onRemove: (name: string) => Promise<void>;
  /** Return a reason string to block removal (e.g. "last category"), or null to allow it. */
  blockRemove?: (name: string) => string | null;
}) {
  const [draft, setDraft] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const busy = adding || removing;

  async function handleAdd() {
    const trimmed = draft.trim();
    if (!trimmed) {
      setAddError(`Enter a ${itemLabel} name.`);
      return;
    }
    if (items.some((i) => i.toLowerCase() === trimmed.toLowerCase())) {
      setAddError(`"${trimmed}" already exists.`);
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      await onAdd(trimmed);
      setDraft('');
    } catch (e) {
      setAddError(e instanceof Error ? e.message : `Could not add that ${itemLabel}.`);
    } finally {
      setAdding(false);
    }
  }

  async function confirmRemove() {
    if (!pendingRemove) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      await onRemove(pendingRemove);
      setPendingRemove(null);
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : `Could not remove that ${itemLabel}.`);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div>
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-3 flex flex-wrap gap-2">
        {items.length === 0 && <p className="text-sm text-muted">None yet.</p>}
        {items.map((item) => {
          const blocked = blockRemove?.(item) ?? null;
          return (
            <span
              key={item}
              title={blocked ?? undefined}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-canvas py-1.5 pl-3 pr-1.5 text-sm"
            >
              {item}
              <button
                type="button"
                aria-label={blocked ? `Cannot remove ${item}: ${blocked}` : `Remove ${item}`}
                disabled={!!blocked || busy}
                onClick={() => setPendingRemove(item)}
                // Padding + negative margin grows the tap target to ~44px
                // without growing the chip's visual footprint.
                className="-m-2.5 flex size-11 items-center justify-center rounded-full p-2.5 text-muted hover:bg-danger-soft hover:text-danger disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </span>
          );
        })}
      </div>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void handleAdd();
        }}
      >
        <Field label={`Add a ${itemLabel}`}>
          <Input
            value={draft}
            disabled={busy}
            onChange={(e) => {
              setDraft(e.target.value);
              if (addError) setAddError(null);
            }}
            placeholder={`New ${itemLabel} name`}
            aria-label={`New ${itemLabel} name`}
          />
        </Field>
        <div className="flex items-end">
          <Button type="submit" variant="ghost" loading={adding} disabled={busy} aria-label={`Add ${itemLabel}`}>
            <Plus className="size-4" aria-hidden />
            Add
          </Button>
        </div>
      </form>
      <InlineError message={addError} />

      {pendingRemove && (
        <ConfirmDialog
          title={`Remove "${pendingRemove}"?`}
          message={
            <p>
              This removes it from future {itemLabel} pickers. Historical transactions keep their
              existing label — nothing already saved changes.
            </p>
          }
          confirmLabel="Remove"
          busy={busy}
          error={removeError}
          onConfirm={() => void confirmRemove()}
          onCancel={() => {
            setPendingRemove(null);
            setRemoveError(null);
          }}
        />
      )}
    </div>
  );
}
