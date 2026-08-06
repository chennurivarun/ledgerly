// Transactions (spec §7): search + account/category filters + shared period,
// desktop table / mobile stacked cards, inline category + tag editing.
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, ChevronDown, Paperclip, Plus, Search, SearchX, Trash2 } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { fmtDate, fmtSigned, inPeriod } from '../../shared/format';
import type { Transaction } from '../../shared/types';
import { PeriodSelector } from '../components/flows/PeriodSelector';
import { TagEditModal } from '../components/flows/TagEditModal';
import { Button, Card, EmptyState, Input, Modal, Select, TagPill } from '../components/ui';
import { useStore } from '../store';

export default function Transactions() {
  const transactions = useStore((s) => s.transactions);
  const settings = useStore((s) => s.settings);
  const patchTransaction = useStore((s) => s.patchTransaction);
  const deleteTransaction = useStore((s) => s.deleteTransaction);
  const setPeriod = useStore((s) => s.setPeriod);
  const toast = useStore((s) => s.toast);
  const openModal = useStore((s) => s.openModal);
  const [searchParams] = useSearchParams();

  const [search, setSearch] = useState('');
  const [account, setAccount] = useState('all');
  // Supports a deep link from the Dashboard's "Needs review" insight (?category=...).
  const [category, setCategory] = useState(() => searchParams.get('category') ?? 'all');
  const [tagEditTx, setTagEditTx] = useState<Transaction | null>(null);
  const [deleteTx, setDeleteTx] = useState<Transaction | null>(null);
  const [deleting, setDeleting] = useState(false);

  const period = settings.selectedPeriod;
  // One stable "now" per render pass, unified with how Dashboard computes its date math.
  const now = useMemo(() => new Date(), []);

  const noLocalFilters = search.trim() === '' && account === 'all' && category === 'all';

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return transactions.filter((t) => {
      if (!inPeriod(t.date, period, now)) return false;
      if (account !== 'all' && t.account !== account) return false;
      if (category !== 'all' && t.category !== category) return false;
      if (q) {
        const hit =
          t.merchant.toLowerCase().includes(q) ||
          t.category.toLowerCase().includes(q) ||
          t.tags.some((tag) => tag.toLowerCase().includes(q));
        if (!hit) return false;
      }
      return true;
    });
  }, [transactions, period, now, account, category, search]);

  // The period is the only local filter that isn't reset by "Clear filters"
  // below unless we're the reason for an empty result — surfaced in the
  // empty-state copy and folded into clearFilters so the button always works.
  const periodOnlyConstraint = noLocalFilters && transactions.length > 0 && filtered.length === 0;

  async function handleCategoryChange(id: string, newCategory: string) {
    try {
      await patchTransaction(id, { category: newCategory });
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Could not update the category.');
      throw e; // let the optimistic dropdown roll back to its previous value
    }
  }

  async function handleRemoveTag(tx: Transaction, tag: string) {
    try {
      await patchTransaction(tx.id, { tags: tx.tags.filter((t) => t !== tag) });
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Could not remove the tag.');
    }
  }

  async function handleDelete() {
    if (!deleteTx) return;
    setDeleting(true);
    try {
      await deleteTransaction(deleteTx.id);
      toast('success', 'Transaction deleted.');
      setDeleteTx(null);
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Could not delete the transaction.');
    } finally {
      setDeleting(false);
    }
  }

  function clearFilters() {
    // Only resets the LOCAL filters — the period is a shared, persisted
    // setting (also visible on Dashboard), so a generic "clear" shouldn't
    // silently change it. When the period itself is the reason for an empty
    // result, the dedicated "Show all time" action below handles that case
    // explicitly instead.
    setSearch('');
    setAccount('all');
    setCategory('all');
  }

  function showAllTime() {
    void setPeriod('all-time');
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative flex-1 lg:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input
            type="search"
            aria-label="Search transactions"
            placeholder="Search merchant, category, or tag"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <FilterSelect ariaLabel="Filter by account" value={account} onChange={setAccount} options={settings.accounts} allLabel="All accounts" />
          <FilterSelect
            ariaLabel="Filter by category"
            value={category}
            onChange={setCategory}
            options={settings.categories}
            allLabel="All categories"
          />
          <PeriodSelector />
        </div>
      </div>

      {transactions.length === 0 ? (
        <Card>
          <EmptyState
            icon={ArrowLeftRight}
            title="No transactions yet"
            body="Add an entry manually or import a statement to get started."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={() => openModal('add-entry')}>Add entry</Button>
                <Button variant="ghost" onClick={() => openModal('import')}>
                  Import
                </Button>
              </div>
            }
          />
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <EmptyState
            icon={SearchX}
            title="No transactions match your filters"
            body={
              periodOnlyConstraint
                ? 'No transactions fall in the selected date period.'
                : 'Try a different search term, account, or category — or clear your filters.'
            }
            action={
              periodOnlyConstraint ? (
                <Button variant="ghost" onClick={showAllTime}>
                  Show all time
                </Button>
              ) : (
                <Button variant="ghost" onClick={clearFilters}>
                  Clear filters
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-card border border-border bg-surface lg:block">
            <table className="w-full min-w-[900px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs font-medium text-muted">
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-4 py-3 font-medium">Merchant</th>
                  <th className="px-4 py-3 font-medium">Category</th>
                  <th className="px-4 py-3 font-medium">Account</th>
                  <th className="px-4 py-3 font-medium">Tags</th>
                  <th className="px-4 py-3 text-right font-medium">Amount</th>
                  <th className="px-2 py-3">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((t) => (
                  <TransactionRow
                    key={t.id}
                    tx={t}
                    categories={settings.categories}
                    onCategoryChange={handleCategoryChange}
                    onRemoveTag={handleRemoveTag}
                    onAddTag={() => setTagEditTx(t)}
                    onDelete={() => setDeleteTx(t)}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-3 lg:hidden">
            {filtered.map((t) => (
              <TransactionCard
                key={t.id}
                tx={t}
                categories={settings.categories}
                onCategoryChange={handleCategoryChange}
                onRemoveTag={handleRemoveTag}
                onAddTag={() => setTagEditTx(t)}
                onDelete={() => setDeleteTx(t)}
              />
            ))}
          </div>
        </>
      )}

      {tagEditTx && <TagEditModal transaction={tagEditTx} onClose={() => setTagEditTx(null)} />}

      {deleteTx && (
        <Modal
          title="Delete transaction?"
          onClose={() => {
            if (!deleting) setDeleteTx(null);
          }}
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDeleteTx(null)} disabled={deleting}>
                Cancel
              </Button>
              <Button variant="danger" onClick={() => void handleDelete()} loading={deleting}>
                Delete
              </Button>
            </div>
          }
        >
          <p className="text-sm text-muted">
            This removes <span className="font-medium text-ink">{deleteTx.merchant}</span> (
            {fmtSigned(deleteTx.amount, deleteTx.type)} on {fmtDate(deleteTx.date)}) permanently. This can&apos;t be
            undone.
          </p>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter controls
// ---------------------------------------------------------------------------

function FilterSelect({
  ariaLabel,
  value,
  onChange,
  options,
  allLabel,
}: {
  ariaLabel: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  allLabel: string;
}) {
  return (
    <div className="relative w-full sm:w-44">
      <Select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} className="pr-8">
        <option value="all">{allLabel}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </Select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
    </div>
  );
}

/**
 * Optimistic-with-rollback (mirrors store.setPeriod's pattern): the select
 * shows the new value immediately on change, and only reverts if the save
 * actually fails — so a successful edit never visibly snaps back then
 * forward while the request is in flight.
 */
function CategorySelect({
  value,
  categories,
  onChange,
}: {
  value: string;
  categories: string[];
  onChange: (v: string) => Promise<void>;
}) {
  const [optimistic, setOptimistic] = useState<string | null>(null);
  useEffect(() => {
    setOptimistic(null); // the store's real value arrived — drop the local override
  }, [value]);

  const displayValue = optimistic ?? value;
  // Defensive: keep the current value selectable even if it was removed from managed categories.
  const options = categories.includes(displayValue) ? categories : [displayValue, ...categories];

  async function handleChange(next: string) {
    const previous = displayValue;
    setOptimistic(next);
    try {
      await onChange(next);
    } catch {
      setOptimistic(previous); // caller already toasted the error
    }
  }

  return (
    <div className="relative">
      <Select aria-label="Category" value={displayValue} onChange={(e) => void handleChange(e.target.value)} className="pr-8">
        {options.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </Select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" aria-hidden />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Desktop row / mobile card (spec §19)
// ---------------------------------------------------------------------------

interface RowProps {
  tx: Transaction;
  categories: string[];
  onCategoryChange: (id: string, category: string) => Promise<void>;
  onRemoveTag: (tx: Transaction, tag: string) => void;
  onAddTag: () => void;
  onDelete: () => void;
}

function TransactionRow({ tx, categories, onCategoryChange, onRemoveTag, onAddTag, onDelete }: RowProps) {
  return (
    <tr>
      <td className="whitespace-nowrap px-4 py-2.5 text-muted">{fmtDate(tx.date)}</td>
      <td className="px-4 py-2.5">
        <span className="flex items-center gap-1.5 font-medium">
          <span className="truncate">{tx.merchant}</span>
          {tx.receipt && <Paperclip className="size-3.5 shrink-0 text-muted" aria-label="Has a receipt attached" />}
        </span>
      </td>
      <td className="px-4 py-2.5">
        <div className="w-40">
          <CategorySelect value={tx.category} categories={categories} onChange={(c) => onCategoryChange(tx.id, c)} />
        </div>
      </td>
      <td className="whitespace-nowrap px-4 py-2.5 text-muted">{tx.account}</td>
      <td className="px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {tx.tags.map((tag) => (
            <TagPill key={tag} label={tag} onRemove={() => onRemoveTag(tx, tag)} />
          ))}
          <button
            type="button"
            aria-label={`Add tag to ${tx.merchant}`}
            onClick={onAddTag}
            className="flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-muted hover:border-accent hover:text-accent"
          >
            <Plus className="size-3.5" aria-hidden />
          </button>
        </div>
      </td>
      <td
        className={`whitespace-nowrap px-4 py-2.5 text-right font-semibold tabular-nums ${tx.type === 'income' ? 'text-positive' : 'text-ink'}`}
      >
        {fmtSigned(tx.amount, tx.type)}
      </td>
      <td className="px-2 py-2.5 text-right">
        <button
          type="button"
          aria-label={`Delete ${tx.merchant}`}
          onClick={onDelete}
          className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-danger-soft hover:text-danger"
        >
          <Trash2 className="size-4" aria-hidden />
        </button>
      </td>
    </tr>
  );
}

function TransactionCard({ tx, categories, onCategoryChange, onRemoveTag, onAddTag, onDelete }: RowProps) {
  return (
    <div className="rounded-card border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate font-medium">
            <span className="truncate">{tx.merchant}</span>
            {tx.receipt && <Paperclip className="size-3.5 shrink-0 text-muted" aria-label="Has a receipt attached" />}
          </p>
          <p className="text-xs text-muted">
            {fmtDate(tx.date)} · {tx.account}
          </p>
        </div>
        <span className={`shrink-0 font-semibold tabular-nums ${tx.type === 'income' ? 'text-positive' : 'text-ink'}`}>
          {fmtSigned(tx.amount, tx.type)}
        </span>
      </div>
      <div className="mt-3">
        <CategorySelect value={tx.category} categories={categories} onChange={(c) => onCategoryChange(tx.id, c)} />
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {tx.tags.map((tag) => (
            <TagPill key={tag} label={tag} onRemove={() => onRemoveTag(tx, tag)} />
          ))}
          <button
            type="button"
            aria-label={`Add tag to ${tx.merchant}`}
            onClick={onAddTag}
            className="flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-muted hover:border-accent hover:text-accent"
          >
            <Plus className="size-4" aria-hidden />
          </button>
        </div>
        <button
          type="button"
          aria-label={`Delete ${tx.merchant}`}
          onClick={onDelete}
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-danger-soft hover:text-danger"
        >
          <Trash2 className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
