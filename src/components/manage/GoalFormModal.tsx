// Add/edit form for a Goal (spec §13).
import { useState } from 'react';
import { fmtCurrency } from '../../../shared/format';
import type { Goal } from '../../../shared/types';
import { Button, Field, InlineError, Input, Modal } from '../ui';

const TEXTAREA_CLASS =
  'w-full min-h-20 rounded-xl border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus:outline-2 focus:outline-accent';

export function GoalFormModal({
  initial,
  onClose,
  onSave,
}: {
  initial?: Goal;
  onClose: () => void;
  onSave: (goal: Goal) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [target, setTarget] = useState(initial ? String(initial.target) : '');
  const [current, setCurrent] = useState(initial ? String(initial.current) : '0');
  const [dueDate, setDueDate] = useState(initial?.dueDate ?? '');
  const [note, setNote] = useState(initial?.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    const trimmedName = name.trim();
    const parsedTarget = Number(target);
    const parsedCurrent = current.trim() === '' ? 0 : Number(current);
    if (!trimmedName) {
      setError('Enter a goal name.');
      return;
    }
    if (!Number.isFinite(parsedTarget) || parsedTarget <= 0) {
      setError(`Enter a target amount greater than ${fmtCurrency(0)}.`);
      return;
    }
    if (!Number.isFinite(parsedCurrent) || parsedCurrent < 0) {
      setError(`Enter a current amount of ${fmtCurrency(0)} or more.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        id: initial?.id ?? crypto.randomUUID(),
        name: trimmedName,
        target: Math.round(parsedTarget * 100) / 100,
        current: Math.round(parsedCurrent * 100) / 100,
        dueDate: dueDate || undefined,
        note: note.trim() || undefined,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the goal. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={initial ? 'Edit goal' : 'Create goal'}
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void handleSubmit()} loading={saving}>
            Save
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Goal name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Emergency fund" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Target amount">
            <Input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="0.00"
            />
          </Field>
          <Field label="Current amount">
            <Input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              placeholder="0.00"
            />
          </Field>
        </div>
        <Field label="Due date (optional)">
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
        <Field label="Note (optional)">
          <textarea
            className={TEXTAREA_CLASS}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What is this goal for?"
            rows={3}
          />
        </Field>
        <InlineError message={error} />
      </div>
    </Modal>
  );
}
