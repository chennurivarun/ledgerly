// Review modal for an AI extraction suggestion — the heart of receipt
// extraction (sprint 3). Vision principle: AI suggests, the user confirms;
// nothing here is ever silently written. Low-confidence/missing fields are
// flagged so the eye goes there, but never block confirmation on their own.
import { AlertTriangle, FileWarning } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { api } from '../../api';
import { fmtDate } from '../../../shared/format';
import type { DocumentMeta, ExtractedField, ExtractionResult, TxType } from '../../../shared/types';
import { useStore } from '../../store';
import { Button, Field, InlineError, Input, Modal, Select, SegmentedControl, TagPill } from '../ui';
import {
  buildTxInputFromDraft,
  isLowConfidence,
  seedExtractionDraft,
  validateExtractionDraft,
  type ExtractionDraft,
} from './extractionHelpers';

const TYPE_OPTIONS: { value: TxType; label: string }[] = [
  { value: 'expense', label: 'Expense' },
  { value: 'income', label: 'Income' },
];

const PROVIDER_LABEL: Record<string, string> = {
  'workers-ai': 'Workers AI',
  anthropic: 'Anthropic',
  sarvam: 'Sarvam',
};

function CautionNote({ field }: { field: ExtractedField<unknown> }) {
  if (!isLowConfidence(field)) return null;
  return (
    <span className="mt-1 flex items-center gap-1 text-xs font-medium text-caution">
      <AlertTriangle className="size-3" aria-hidden />
      Low confidence — verify
    </span>
  );
}

export function ExtractionReviewModal({
  doc,
  extraction,
  onClose,
}: {
  doc: DocumentMeta;
  extraction: ExtractionResult;
  onClose: () => void;
}) {
  const settings = useStore((s) => s.settings);
  const allTags = useStore((s) => s.tags);
  const confirmExtraction = useStore((s) => s.confirmExtraction);
  const dismissExtraction = useStore((s) => s.dismissExtraction);
  const toast = useStore((s) => s.toast);

  const [draft, setDraft] = useState(() => seedExtractionDraft(extraction, settings));
  const [newTag, setNewTag] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [duplicateNotice, setDuplicateNotice] = useState(false);
  const [busy, setBusy] = useState<'confirm' | 'dismiss' | null>(null);

  // The frozen Modal re-runs its focus-trap effect (and steals focus back to
  // itself) whenever the `onClose` it receives changes identity — so onClose
  // here must stay referentially stable across re-renders, not just
  // "correct". A plain `busy ? () => {} : onClose` recreates a function on
  // every render while busy, and even at rest depends on the caller passing
  // a stable `onClose` prop. Reading `busy` through a ref lets this callback
  // never change identity while still guarding against Escape/backdrop close
  // mid-save (the same behavior WipeDataModal gets from its inline ternary).
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const guardedClose = useCallback(() => {
    if (!busyRef.current) onClose();
  }, [onClose]);

  const noAccounts = settings.accounts.length === 0;
  const noCategories = settings.categories.length === 0;
  const isImage = doc.mimeType.startsWith('image/');
  const isPdf = doc.mimeType === 'application/pdf';
  const downloadUrl = api.documentDownloadUrl(doc.id);
  // Images render inline regardless of Content-Disposition; the PDF <object>
  // needs the worker's inline opt-in or the browser downloads the file
  // instead of rendering it — a silent side effect just from opening Review.
  const previewUrl = isPdf ? `${downloadUrl}?inline=1` : downloadUrl;

  // Every draft edit clears a stale duplicate notice: a genuine second
  // identical purchase is a real case, and the user editing the form (even a
  // no-op re-select) signals "let me try confirming again" — the notice
  // should not permanently swallow the Confirm button (AddEntryModal keeps
  // Save live for the same kind of server response).
  function updateDraft(updater: (d: ExtractionDraft) => ExtractionDraft) {
    setDraft(updater);
    setDuplicateNotice(false);
  }

  function toggleTag(name: string) {
    updateDraft((d) => ({
      ...d,
      tags: d.tags.includes(name) ? d.tags.filter((t) => t !== name) : [...d.tags, name],
    }));
  }

  function addNewTag() {
    const name = newTag.trim();
    if (!name) return;
    updateDraft((d) => (d.tags.some((t) => t.toLowerCase() === name.toLowerCase()) ? d : { ...d, tags: [...d.tags, name] }));
    setNewTag('');
  }

  async function handleConfirm() {
    const validationError = validateExtractionDraft(draft);
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy('confirm');
    setError(null);
    setDuplicateNotice(false);
    try {
      const res = await confirmExtraction(doc.id, buildTxInputFromDraft(draft));
      if (res.duplicates > 0 && res.inserted === 0) {
        // Honest, not an error — the transaction already exists, so nothing new was added.
        setDuplicateNotice(true);
        return;
      }
      if (res.inserted === 0) {
        setError(res.errors[0] ?? 'Could not save the transaction.');
        return;
      }
      toast('success', 'Transaction added from receipt.');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not confirm the extraction.');
    } finally {
      setBusy(null);
    }
  }

  async function handleDismiss() {
    setBusy('dismiss');
    setError(null);
    try {
      await dismissExtraction(doc.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not dismiss the suggestion.');
      setBusy(null);
    }
  }

  const unselectedExisting = allTags.map((t) => t.name).filter((name) => !draft.tags.includes(name));
  const providerLabel = PROVIDER_LABEL[extraction.provider] ?? extraction.provider;

  return (
    <Modal
      title="Review extraction"
      // Escape-guard while saving (WipeDataModal pattern), via a referentially
      // stable callback — see guardedClose above for why identity matters here.
      onClose={guardedClose}
      wide
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="ghost" onClick={() => void handleDismiss()} disabled={busy !== null} loading={busy === 'dismiss'}>
            Dismiss
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy !== null}>
              {duplicateNotice ? 'Close' : 'Cancel'}
            </Button>
            {!duplicateNotice && (
              <Button onClick={() => void handleConfirm()} disabled={busy !== null} loading={busy === 'confirm'}>
                Confirm
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-[220px_1fr] sm:items-start">
        <div className="flex h-64 items-center justify-center overflow-hidden rounded-xl border border-border bg-canvas sm:h-full sm:max-h-[480px]">
          {isImage ? (
            <img
              src={previewUrl}
              alt={`Preview of ${doc.filename}`}
              className="h-full w-full object-contain"
            />
          ) : isPdf ? (
            <object data={previewUrl} type="application/pdf" className="h-full w-full" aria-label={`Preview of ${doc.filename}`}>
              <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
                <FileWarning className="size-6 text-muted" aria-hidden />
                <p className="text-xs text-muted">Preview isn&apos;t available for this file.</p>
                <a href={previewUrl} target="_blank" rel="noreferrer" className="text-xs font-medium text-accent hover:underline">
                  Open PDF in a new tab
                </a>
              </div>
            </object>
          ) : (
            <div className="flex flex-col items-center gap-2 p-4 text-center">
              <FileWarning className="size-6 text-muted" aria-hidden />
              <a href={downloadUrl} target="_blank" rel="noreferrer" className="text-xs font-medium text-accent hover:underline">
                Download to view
              </a>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <InlineError message={error} />
          {duplicateNotice && (
            <p role="status" className="rounded-lg bg-info-soft px-3 py-2 text-sm text-info">
              This matches a transaction you already have — nothing was added.
            </p>
          )}

          <SegmentedControl ariaLabel="Entry type" options={TYPE_OPTIONS} value={draft.type} onChange={(v) => updateDraft((d) => ({ ...d, type: v }))} />
          <CautionNote field={extraction.type} />

          <div className="grid grid-cols-2 gap-3">
            <Field label="Total">
              <Input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={draft.total}
                disabled={busy !== null}
                onChange={(e) => updateDraft((d) => ({ ...d, total: e.target.value }))}
              />
              <CautionNote field={extraction.total} />
            </Field>
            <Field label="Date">
              <Input
                type="date"
                value={draft.date}
                disabled={busy !== null}
                onChange={(e) => updateDraft((d) => ({ ...d, date: e.target.value }))}
              />
              <CautionNote field={extraction.date} />
            </Field>
          </div>

          <Field label="Merchant">
            <Input
              value={draft.merchant}
              disabled={busy !== null}
              onChange={(e) => updateDraft((d) => ({ ...d, merchant: e.target.value }))}
              placeholder="e.g. Coffee shop"
            />
            <CautionNote field={extraction.merchant} />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Category">
              {noCategories ? (
                <p className="text-xs text-muted">Add a category in Settings first.</p>
              ) : (
                <Select value={draft.category} disabled={busy !== null} onChange={(e) => updateDraft((d) => ({ ...d, category: e.target.value }))}>
                  <option value="" disabled>
                    Choose a category…
                  </option>
                  {settings.categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              )}
              <CautionNote field={extraction.category} />
            </Field>
            <Field label="Account">
              {noAccounts ? (
                <p className="text-xs text-muted">Add an account in Settings first.</p>
              ) : (
                <Select value={draft.account} disabled={busy !== null} onChange={(e) => updateDraft((d) => ({ ...d, account: e.target.value }))}>
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
            <p className="mb-1.5 text-sm font-medium">Tags (optional)</p>
            {draft.tags.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {draft.tags.map((t) => (
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
                    disabled={busy !== null}
                    className="rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted hover:border-accent hover:text-accent disabled:opacity-50"
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <Input
                value={newTag}
                disabled={busy !== null}
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
              <Button variant="ghost" onClick={addNewTag} disabled={busy !== null || !newTag.trim()}>
                Add
              </Button>
            </div>
          </div>

          <p className="text-xs text-muted">
            Suggested by {providerLabel} · {extraction.model} · uploaded {fmtDate(doc.createdAt.slice(0, 10))}
          </p>
        </div>
      </div>
    </Modal>
  );
}
