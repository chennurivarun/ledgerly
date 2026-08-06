// Global "Add entry" modal (spec §7.3). Amount/merchant always start blank;
// date defaults to today but stays editable. Validates before saving, then
// persists the transaction (and the receipt file, if any) through the store.
import { useState } from 'react';
import { todayISO } from '../../../shared/format';
import { MAX_FILE_BYTES, type TxType } from '../../../shared/types';
import { useStore } from '../../store';
import { Button, Field, InlineError, Input, Modal, Select, SegmentedControl, TagPill } from '../ui';

const TYPE_OPTIONS: { value: TxType; label: string }[] = [
  { value: 'expense', label: 'Expense' },
  { value: 'income', label: 'Income' },
];

export function AddEntryModal({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const allTags = useStore((s) => s.tags);
  const addTransactions = useStore((s) => s.addTransactions);
  const uploadDocuments = useStore((s) => s.uploadDocuments);
  const toast = useStore((s) => s.toast);

  const [type, setType] = useState<TxType>('expense');
  const [amount, setAmount] = useState('');
  const [merchant, setMerchant] = useState('');
  const [date, setDate] = useState(todayISO());
  const [category, setCategory] = useState(settings.categories[0] ?? '');
  const [account, setAccount] = useState(settings.accounts[0] ?? '');
  const [tags, setTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState('');
  const [hasReceipt, setHasReceipt] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const noAccounts = settings.accounts.length === 0;
  const noCategories = settings.categories.length === 0;

  function toggleTag(name: string) {
    setTags((prev) => (prev.includes(name) ? prev.filter((t) => t !== name) : [...prev, name]));
  }

  function addNewTag() {
    const name = newTag.trim();
    if (!name) return;
    if (!tags.some((t) => t.toLowerCase() === name.toLowerCase())) setTags((prev) => [...prev, name]);
    setNewTag('');
  }

  async function handleSave() {
    const amountNum = Number(amount);
    if (!merchant.trim()) return setError(type === 'income' ? 'Enter a source.' : 'Enter a merchant.');
    if (!Number.isFinite(amountNum) || amountNum <= 0) return setError('Enter an amount greater than 0.');
    if (!date) return setError('Choose a date.');
    if (noCategories || !category) return setError('Add a category in Settings first.');
    if (noAccounts || !account) return setError('Add an account in Settings first.');
    if (hasReceipt && !file) return setError('Choose a file to attach, or uncheck the receipt option.');
    // Pre-check before the transaction is saved — an oversized receipt must
    // never leave a saved transaction behind a failed upload (spec §8.3/§20).
    if (hasReceipt && file && file.size > MAX_FILE_BYTES) {
      return setError(`That file is over the 20 MB limit (${(file.size / (1024 * 1024)).toFixed(1)} MB).`);
    }

    setSaving(true);
    setError(null);
    try {
      const res = await addTransactions([
        {
          date,
          merchant: merchant.trim(),
          amount: amountNum,
          type,
          category,
          account,
          tags,
          receipt: hasReceipt && !!file,
          source: 'manual',
        },
      ]);
      if (res.inserted === 0) {
        // Nothing was actually saved (e.g. a duplicate fingerprint) — keep the
        // modal open and say so instead of claiming success (spec §8.3/§20).
        setError(
          res.duplicates > 0
            ? 'This looks like a duplicate of a transaction you already have.'
            : (res.errors[0] ?? 'Could not save the transaction.'),
        );
        return;
      }
      if (hasReceipt && file) {
        await uploadDocuments([file]);
      }
      toast('success', 'Transaction added.');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the transaction.');
    } finally {
      setSaving(false);
    }
  }

  const unselectedExisting = allTags.map((t) => t.name).filter((name) => !tags.includes(name));

  return (
    <Modal
      title="Add entry"
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} loading={saving}>
            Save entry
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <InlineError message={error} />

        <SegmentedControl ariaLabel="Entry type" options={TYPE_OPTIONS} value={type} onChange={setType} />

        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount">
            <Input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>

        <Field label={type === 'income' ? 'Source' : 'Merchant'}>
          <Input
            value={merchant}
            onChange={(e) => setMerchant(e.target.value)}
            placeholder={type === 'income' ? 'e.g. Paycheck' : 'e.g. Coffee shop'}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Category">
            {noCategories ? (
              <p className="text-xs text-muted">Add a category in Settings first.</p>
            ) : (
              <Select value={category} onChange={(e) => setCategory(e.target.value)}>
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
              <Select value={account} onChange={(e) => setAccount(e.target.value)}>
                {settings.accounts.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <div>
          <p className="mb-1.5 text-sm font-medium">Tags</p>
          {tags.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {tags.map((t) => (
                <TagPill key={t} label={t} onRemove={() => toggleTag(t)} />
              ))}
            </div>
          )}
          {unselectedExisting.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {unselectedExisting.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleTag(t)}
                  className="rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted hover:border-accent hover:text-accent"
                >
                  {t}
                </button>
              ))}
            </div>
          )}
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
              placeholder="Add a new tag"
              maxLength={40}
            />
            <Button variant="ghost" onClick={addNewTag} disabled={!newTag.trim()}>
              Add
            </Button>
          </div>
        </div>

        <label className="flex min-h-11 items-center gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={hasReceipt}
            onChange={(e) => {
              setHasReceipt(e.target.checked);
              if (!e.target.checked) setFile(null);
            }}
            className="size-5 shrink-0 rounded border-border accent-accent"
          />
          I have a receipt to attach
        </label>
        {hasReceipt && (
          <Field label="Receipt file" hint="Images, PDFs, or scans up to 20 MB.">
            <input
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              accept="image/*,.pdf"
              className="block w-full text-sm text-muted file:mr-3 file:h-9 file:rounded-lg file:border-0 file:bg-accent-soft file:px-3 file:text-sm file:font-medium file:text-accent"
            />
          </Field>
        )}
      </div>
    </Modal>
  );
}
