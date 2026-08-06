// Global "Import" modal (spec §8.1/8.2): CSV statement import with a manual
// mapping step when detection is ambiguous, and multi-file document upload
// with a client-side 20MB pre-check.
import { useState } from 'react';
import { AlertTriangle, ChevronDown, FileSpreadsheet, FileText, Upload } from 'lucide-react';
import { detectMapping, parseCsv, rowsToTransactions, type CsvMapping, type CsvTable } from '../../../shared/csv';
import { MAX_FILE_BYTES, NEEDS_REVIEW, type UploadResult } from '../../../shared/types';
import { useStore } from '../../store';
import { Button, Field, InlineError, Input, Modal, Select, SegmentedControl } from '../ui';

type ImportTab = 'csv' | 'documents';

export function ImportModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<ImportTab>('csv');
  return (
    <Modal title="Import" onClose={onClose} wide>
      <div className="space-y-4">
        <SegmentedControl
          ariaLabel="Import type"
          options={[
            { value: 'csv', label: 'CSV statement' },
            { value: 'documents', label: 'Documents' },
          ]}
          value={tab}
          onChange={setTab}
        />
        {tab === 'csv' ? <CsvImport onDone={onClose} /> : <DocumentImport onDone={onClose} />}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// CSV statement import (spec §8.1)
// ---------------------------------------------------------------------------

interface CsvResult {
  inserted: number;
  duplicates: number;
  skipped: number;
  needsReview: number;
  /** Candidate rows the server rejected outright (failed validation) — distinct from client-side `skipped` (unparseable) and `duplicates`. */
  rejected: number;
  errors: string[];
}

/**
 * True when every parsed, non-zero value in `rows[*][columnIndex]` shares
 * one sign — meaning debit-only vs. credit-only can't be told apart from
 * the data alone (spec §8.1.5: never guess silently). Run for BOTH the
 * auto-detected and the fully-manual mapping path, since a manual mapping
 * never calls detectMapping at all.
 *
 * Deliberately simpler than shared/csv.ts's internal parser (no
 * decimal-comma detection): this only gates a confirmation prompt, so the
 * worst case is one extra confirmation click, never a silently-skipped one
 * for the currency-symbol/thousands-comma/parenthesized-negative formats it
 * does handle.
 */
function looksSingleSigned(rows: string[][], columnIndex: number): boolean {
  const signs = new Set<number>();
  for (const row of rows) {
    const raw = row[columnIndex];
    if (!raw) continue;
    const cleaned = raw.trim().replace(/[$\s]/g, '').replace(/,/g, '').replace(/^\((.*)\)$/, '-$1');
    const n = Number(cleaned);
    if (Number.isFinite(n) && n !== 0) signs.add(Math.sign(n));
  }
  return signs.size === 1;
}

function CsvImport({ onDone }: { onDone: () => void }) {
  const settings = useStore((s) => s.settings);
  const addTransactions = useStore((s) => s.addTransactions);
  const toast = useStore((s) => s.toast);

  const [table, setTable] = useState<CsvTable | null>(null);
  const [fileName, setFileName] = useState('');
  const [mapping, setMapping] = useState<Partial<CsvMapping>>({ signConvention: 'negative-expense' });
  const [amountMode, setAmountMode] = useState<'single' | 'split'>('single');
  const [defaultAccount, setDefaultAccount] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [result, setResult] = useState<CsvResult | null>(null);
  // Keyed on "which amount column + which sign choice" was last explicitly
  // confirmed, rather than a plain boolean — this is what makes the
  // confirmation self-invalidate the instant the user changes the column or
  // the sign choice, with no scattered reset calls needed (see `ready` below).
  const [confirmedSignFor, setConfirmedSignFor] = useState<string | null>(null);

  async function handleFile(f: File) {
    setLoadError(null);
    setResult(null);
    setConfirmedSignFor(null); // a new file's data is unrelated to any prior confirmation
    if (f.size > MAX_FILE_BYTES) {
      setLoadError(`This file is over the 20 MB limit (${(f.size / (1024 * 1024)).toFixed(1)} MB). Choose a smaller export.`);
      return;
    }
    try {
      const text = await f.text();
      const parsed = parseCsv(text);
      if (parsed.headers.length === 0) {
        setLoadError('This file has no rows we could read. Choose a CSV export from your bank or card.');
        return;
      }
      setTable(parsed);
      setFileName(f.name);
      // Auto-detection is the safe fallback: when ambiguous it returns null
      // and the manual mapping step below is required (spec §8.1.3). Passing
      // `rows` lets it refine the sign convention from the actual data.
      const auto = detectMapping(parsed.headers, parsed.rows);
      if (auto) {
        setMapping(auto);
        setAmountMode(auto.debit != null || auto.credit != null ? 'split' : 'single');
      } else {
        setMapping({ signConvention: 'negative-expense' });
        setAmountMode('single');
      }
    } catch {
      setLoadError('Could not read that file. Choose a CSV export from your bank or card.');
    }
  }

  // A single amount column where every parsed value shares one sign can't be
  // told apart (debit-only vs. credit-only export) — this must be checked in
  // BOTH the auto-detected and the fully-manual mapping path, since a manual
  // mapping never runs detectMapping at all (spec §8.1.5: never guess
  // silently). Computed fresh from the live mapping/table rather than a
  // one-time flag from detection, so switching to a different amount column
  // re-evaluates instead of trusting a stale answer.
  const signAmbiguous =
    amountMode === 'single' && table !== null && mapping.amount !== undefined && looksSingleSigned(table.rows, mapping.amount);
  const signConfirmKey =
    mapping.amount !== undefined ? `${mapping.amount}:${mapping.signConvention ?? 'negative-expense'}` : null;
  // Keyed confirmation: changing the amount column OR the sign choice changes
  // this key, so a stale confirmation from a previous choice never silently
  // carries over (closes the "reset when mapping changes" requirement without
  // needing an explicit reset call at every setMapping site).
  const signNeedsConfirmation = signAmbiguous && confirmedSignFor !== signConfirmKey;

  const ready =
    !!table &&
    mapping.date !== undefined &&
    mapping.description !== undefined &&
    (amountMode === 'single' ? mapping.amount !== undefined : mapping.debit !== undefined || mapping.credit !== undefined) &&
    !signNeedsConfirmation;

  async function handleImport() {
    if (!table || !ready) return;
    setSaving(true);
    setSaveError(null);
    try {
      const finalMapping: CsvMapping = {
        date: mapping.date!,
        description: mapping.description!,
        signConvention: mapping.signConvention ?? 'negative-expense',
        ...(amountMode === 'single' ? { amount: mapping.amount } : { debit: mapping.debit, credit: mapping.credit }),
        ...(mapping.category !== undefined ? { category: mapping.category } : {}),
        ...(mapping.account !== undefined ? { account: mapping.account } : {}),
      };
      const { transactions, skipped } = rowsToTransactions(table, finalMapping, {
        account: defaultAccount.trim() || undefined,
        // Preserve a SUPPORTED statement category only (spec §8.1.6) — without
        // this, raw statement category text would pass through unchecked.
        categories: settings.categories,
      });
      if (transactions.length === 0) {
        setSaveError('No valid rows found with this mapping. Check your column choices.');
        return;
      }
      const res = await addTransactions(transactions);
      // Post-dedupe truth: count "needs review" only among rows the server
      // actually inserted, not rows that would have needed review before
      // duplicate detection removed them (spec §8.1.9).
      const needsReview = res.insertedRows.filter((t) => t.category === NEEDS_REVIEW).length;
      const rejected = Math.max(0, transactions.length - res.inserted - res.duplicates);
      setResult({ inserted: res.inserted, duplicates: res.duplicates, skipped, needsReview, rejected, errors: res.errors });
      toast('success', `Imported ${res.inserted} transaction${res.inserted === 1 ? '' : 's'}.`);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Could not import this file.');
    } finally {
      setSaving(false);
    }
  }

  if (result) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl bg-canvas p-4">
          <p className="text-sm font-semibold">Import complete for {fileName}</p>
          <dl className={`mt-3 grid grid-cols-2 gap-3 text-sm ${result.rejected > 0 ? 'sm:grid-cols-5' : 'sm:grid-cols-4'}`}>
            <ResultStat label="Inserted" value={result.inserted} />
            <ResultStat label="Duplicates" value={result.duplicates} />
            <ResultStat label="Skipped" value={result.skipped} />
            <ResultStat label="Needs review" value={result.needsReview} />
            {result.rejected > 0 && <ResultStat label="Rejected" value={result.rejected} />}
          </dl>
          {result.errors.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-danger">
              {result.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              setTable(null);
              setResult(null);
            }}
          >
            Import another file
          </Button>
          <Button onClick={onDone}>Done</Button>
        </div>
      </div>
    );
  }

  if (!table) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted">
          Choose a CSV export from your bank or card. We will show you the detected columns before importing
          anything.
        </p>
        <InlineError message={loadError} />
        <label className="flex h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border text-center text-sm text-muted hover:border-accent hover:text-accent">
          <FileSpreadsheet className="size-6" aria-hidden />
          Choose a CSV file
          <input
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
            }}
          />
        </label>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-canvas p-3 text-xs text-muted">
        <p className="font-medium text-ink">{fileName}</p>
        <p>
          {table.rows.length} row{table.rows.length === 1 ? '' : 's'} detected · columns:{' '}
          {table.headers.join(', ') || '(no header row)'}
        </p>
      </div>

      {table.truncated && (
        <p className="flex items-start gap-1.5 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          This file looks malformed or truncated — an unclosed quote likely swallowed the rest of the file. Only
          {` ${table.rows.length} row${table.rows.length === 1 ? '' : 's'}`} parsed successfully; anything after the
          break was lost. Re-export the statement before importing if that count looks too low.
        </p>
      )}

      {table.rows.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted">Preview (first {Math.min(3, table.rows.length)} rows)</p>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[420px] text-left text-xs">
              <thead>
                <tr className="border-b border-border bg-canvas">
                  {table.headers.map((h, i) => (
                    <th key={i} className="whitespace-nowrap px-2.5 py-1.5 font-medium text-muted">
                      {h || `Column ${i + 1}`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {table.rows.slice(0, 3).map((row, ri) => (
                  <tr key={ri}>
                    {table.headers.map((_, ci) => (
                      <td key={ci} className="whitespace-nowrap px-2.5 py-1.5 text-muted">
                        {row[ci] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <InlineError message={saveError} />

      <p className="text-sm font-medium">Map your columns</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Date column">
          <ColumnSelect
            headers={table.headers}
            value={mapping.date}
            onChange={(v) => setMapping((m) => ({ ...m, date: v }))}
            ariaLabel="Date column"
          />
        </Field>
        <Field label="Description / merchant column">
          <ColumnSelect
            headers={table.headers}
            value={mapping.description}
            onChange={(v) => setMapping((m) => ({ ...m, description: v }))}
            ariaLabel="Description column"
          />
        </Field>
      </div>

      <div>
        <p className="mb-1.5 text-sm font-medium">Amount columns</p>
        <SegmentedControl
          ariaLabel="Amount column layout"
          options={[
            { value: 'single', label: 'One signed column' },
            { value: 'split', label: 'Separate debit / credit' },
          ]}
          value={amountMode}
          onChange={setAmountMode}
        />
      </div>

      {amountMode === 'single' ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Amount column">
            <ColumnSelect
              headers={table.headers}
              value={mapping.amount}
              onChange={(v) => setMapping((m) => ({ ...m, amount: v }))}
              ariaLabel="Amount column"
            />
          </Field>
          <Field label="Sign convention">
            <div className="flex h-11 items-center gap-4 text-sm">
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="sign"
                  checked={mapping.signConvention !== 'positive-expense'}
                  onChange={() => setMapping((m) => ({ ...m, signConvention: 'negative-expense' }))}
                  className="accent-accent"
                />
                Negative = expense
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="sign"
                  checked={mapping.signConvention === 'positive-expense'}
                  onChange={() => setMapping((m) => ({ ...m, signConvention: 'positive-expense' }))}
                  className="accent-accent"
                />
                Positive = expense
              </label>
            </div>
          </Field>
          {signNeedsConfirmation && (
            <div className="flex flex-col items-start gap-2 rounded-lg bg-caution-soft px-3 py-2.5 sm:col-span-2">
              <p className="flex items-start gap-1.5 text-xs text-caution">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                Every parsed amount in this column has the same sign — we can&apos;t confidently tell whether debits
                or credits mean expenses. Choose the correct option above, then confirm it.
              </p>
              {/* A dedicated confirm control, not the radios themselves: clicking an
                  already-selected radio fires no change event in React, so relying on
                  the radios alone can leave Import permanently disabled when the
                  pre-filled guess is already correct. A button always fires its
                  handler on every click regardless of prior state. */}
              <Button variant="subtle" size="sm" onClick={() => signConfirmKey && setConfirmedSignFor(signConfirmKey)}>
                Confirm: {mapping.signConvention === 'positive-expense' ? 'positive' : 'negative'} amounts are
                expenses
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Debit column (money out)">
            <ColumnSelect
              headers={table.headers}
              value={mapping.debit}
              onChange={(v) => setMapping((m) => ({ ...m, debit: v }))}
              allowNone
              ariaLabel="Debit column"
            />
          </Field>
          <Field label="Credit column (money in)">
            <ColumnSelect
              headers={table.headers}
              value={mapping.credit}
              onChange={(v) => setMapping((m) => ({ ...m, credit: v }))}
              allowNone
              ariaLabel="Credit column"
            />
          </Field>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Category column (optional)">
          <ColumnSelect
            headers={table.headers}
            value={mapping.category}
            onChange={(v) => setMapping((m) => ({ ...m, category: v }))}
            allowNone
            ariaLabel="Category column"
          />
        </Field>
        <Field label="Account column (optional)">
          <ColumnSelect
            headers={table.headers}
            value={mapping.account}
            onChange={(v) => setMapping((m) => ({ ...m, account: v }))}
            allowNone
            ariaLabel="Account column"
          />
        </Field>
      </div>

      <Field label="Default account (optional)" hint="Used for rows with no account column.">
        <Input value={defaultAccount} onChange={(e) => setDefaultAccount(e.target.value)} placeholder="e.g. Main Checking" />
      </Field>

      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          onClick={() => {
            setTable(null);
            setSaveError(null);
          }}
          disabled={saving}
        >
          Choose a different file
        </Button>
        <Button onClick={() => void handleImport()} loading={saving} disabled={!ready}>
          Import
        </Button>
      </div>
    </div>
  );
}

function ColumnSelect({
  headers,
  value,
  onChange,
  allowNone = false,
  ariaLabel,
}: {
  headers: string[];
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  allowNone?: boolean;
  ariaLabel: string;
}) {
  return (
    <div className="relative">
      <Select
        aria-label={ariaLabel}
        value={value === undefined ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        className="pr-8"
      >
        <option value="" disabled={!allowNone}>
          {allowNone ? 'None' : 'Select a column'}
        </option>
        {headers.map((h, i) => (
          <option key={i} value={i}>
            {h || `Column ${i + 1}`}
          </option>
        ))}
      </Select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" aria-hidden />
    </div>
  );
}

function ResultStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Document import (spec §8.2)
// ---------------------------------------------------------------------------

function DocumentImport({ onDone }: { onDone: () => void }) {
  const uploadDocuments = useStore((s) => s.uploadDocuments);
  const toast = useStore((s) => s.toast);

  const [files, setFiles] = useState<File[]>([]);
  const [rejected, setRejected] = useState<{ name: string; reason: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);

  function handlePick(list: FileList | null) {
    if (!list) return;
    const accepted: File[] = [];
    const bad: { name: string; reason: string }[] = [];
    for (const f of Array.from(list)) {
      if (f.size > MAX_FILE_BYTES) {
        bad.push({ name: f.name, reason: `Over the 20 MB limit (${(f.size / (1024 * 1024)).toFixed(1)} MB).` });
      } else {
        accepted.push(f);
      }
    }
    setFiles(accepted);
    setRejected(bad);
    setResult(null);
    setError(null);
  }

  async function handleUpload() {
    if (files.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const res = await uploadDocuments(files);
      setResult(res);
      setFiles([]);
      toast('success', `Uploaded ${res.documents.length} file${res.documents.length === 1 ? '' : 's'}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not upload these files.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Upload receipts, invoices, statements, PDFs, images, or spreadsheets. Each file must be 20 MB or smaller.
      </p>
      <InlineError message={error} />

      <label className="flex h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border text-center text-sm text-muted hover:border-accent hover:text-accent">
        <Upload className="size-6" aria-hidden />
        Choose files
        <input type="file" multiple className="sr-only" onChange={(e) => handlePick(e.target.files)} />
      </label>

      {rejected.length > 0 && (
        <ul className="space-y-1 text-xs text-danger">
          {rejected.map((r) => (
            <li key={r.name}>
              {r.name}: {r.reason}
            </li>
          ))}
        </ul>
      )}

      {files.length > 0 && (
        <ul className="space-y-1 text-sm">
          {files.map((f) => (
            <li key={f.name} className="flex items-center gap-2">
              <FileText className="size-4 shrink-0 text-muted" aria-hidden />
              <span className="truncate">{f.name}</span>
              <span className="shrink-0 text-xs text-muted">{(f.size / (1024 * 1024)).toFixed(1)} MB</span>
            </li>
          ))}
        </ul>
      )}

      {result && (
        <div className="rounded-xl bg-canvas p-4">
          <p className="text-sm font-semibold">Upload complete</p>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <ResultStat label="Stored" value={result.documents.length} />
            <ResultStat label="Transactions" value={result.inserted} />
            <ResultStat label="Duplicates" value={result.duplicates} />
            <ResultStat label="Needs review" value={result.review} />
          </dl>
          {result.errors.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-danger">
              {result.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone} disabled={saving}>
          {result ? 'Done' : 'Cancel'}
        </Button>
        {!result && (
          <Button onClick={() => void handleUpload()} loading={saving} disabled={files.length === 0}>
            Upload
          </Button>
        )}
      </div>
    </div>
  );
}
