// Add/edit form for a confirmed RecurringItem or Subscription (spec §10/§11).
// Same shape backs both — the page passes labels so copy reads naturally.
import { useState } from 'react';
import { fmtCurrency, todayISO } from '../../../shared/format';
import type { Cadence, RecurringItem } from '../../../shared/types';
import { Button, Field, InlineError, Input, Modal, Select } from '../ui';
import { Toggle } from './Toggle';

const CADENCE_OPTIONS: { value: Cadence; label: string }[] = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Biweekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'annual', label: 'Annual' },
];

export function RecurringItemModal({
  nameLabel,
  categories,
  accounts,
  initial,
  onClose,
  onSave,
}: {
  nameLabel: string;
  categories: string[];
  accounts: string[];
  initial?: RecurringItem;
  onClose: () => void;
  onSave: (item: RecurringItem) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [category, setCategory] = useState(initial?.category ?? categories[0] ?? '');
  const [amount, setAmount] = useState(initial ? String(initial.amount) : '');
  const [cadence, setCadence] = useState<Cadence>(initial?.cadence ?? 'monthly');
  const [nextDate, setNextDate] = useState(initial?.nextDate ?? todayISO());
  const [account, setAccount] = useState(initial?.account ?? '');
  const [active, setActive] = useState(initial?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    const trimmedName = name.trim();
    const parsedAmount = Number(amount);
    if (!trimmedName) {
      setError(`Enter a ${nameLabel.toLowerCase()}.`);
      return;
    }
    if (!category) {
      setError('Choose a category.');
      return;
    }
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setError(`Enter an amount greater than ${fmtCurrency(0)}.`);
      return;
    }
    if (!nextDate) {
      setError('Choose the next date.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        id: initial?.id ?? crypto.randomUUID(),
        name: trimmedName,
        category,
        amount: Math.round(parsedAmount * 100) / 100,
        cadence,
        nextDate,
        account: account || undefined,
        active,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={initial ? `Edit ${nameLabel.toLowerCase()}` : `Add ${nameLabel.toLowerCase()}`}
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
        <Field label={nameLabel}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={nameLabel} />
        </Field>
        <Field label="Category">
          <Select value={category} onChange={(e) => setCategory(e.target.value)}>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount">
            <Input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </Field>
          <Field label="Cadence">
            <Select value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)}>
              {CADENCE_OPTIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Next date">
            <Input type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} />
          </Field>
          <Field label="Account (optional)">
            <Select value={account} onChange={(e) => setAccount(e.target.value)}>
              <option value="">No account</option>
              {accounts.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="flex items-center justify-between rounded-xl border border-border px-3 py-2">
          <span className="text-sm font-medium">Active</span>
          <Toggle checked={active} onChange={setActive} label="Active" />
        </div>
        <InlineError message={error} />
      </div>
    </Modal>
  );
}
