// Create/edit rule modal (spec §15.1) — plain-language "when X then Y" rows.
import { useState } from 'react';
import type { Rule } from '../../../shared/types';
import { Button, Field, InlineError, Input, Modal } from '../ui';
import { Toggle } from './Toggle';

export function RuleFormModal({
  initial,
  onClose,
  onSave,
}: {
  initial?: Rule;
  onClose: () => void;
  onSave: (rule: Rule) => Promise<void>;
}) {
  const [whenText, setWhenText] = useState(initial?.whenText ?? '');
  const [thenText, setThenText] = useState(initial?.thenText ?? '');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    const w = whenText.trim();
    const t = thenText.trim();
    if (!w) {
      setError('Describe when this rule should apply (e.g. merchant contains "Netflix").');
      return;
    }
    if (!t) {
      setError('Describe what the rule should do (e.g. set category to Subscriptions).');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        id: initial?.id ?? crypto.randomUUID(),
        whenText: w,
        thenText: t,
        enabled,
        createdAt: initial?.createdAt ?? new Date().toISOString(),
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the rule. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={initial ? 'Edit rule' : 'Create rule'}
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
        <Field label="When" hint="A plain-language merchant or source condition.">
          <Input
            value={whenText}
            onChange={(e) => setWhenText(e.target.value)}
            placeholder='Merchant contains "Netflix"'
          />
        </Field>
        <Field label="Then" hint="The category and/or tag to apply.">
          <Input
            value={thenText}
            onChange={(e) => setThenText(e.target.value)}
            placeholder="Set category to Subscriptions"
          />
        </Field>
        <div className="flex items-center justify-between rounded-xl border border-border px-3 py-2">
          <span className="text-sm font-medium">Enabled</span>
          <Toggle checked={enabled} onChange={setEnabled} label="Enabled" />
        </div>
        <InlineError message={error} />
      </div>
    </Modal>
  );
}
