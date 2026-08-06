// Documents page (spec §14) — upload + Drive inbox status + vault list.
// objectKey is never rendered; no encryption claims are made anywhere here.
import { Download, ExternalLink, FileText, FolderSync, Sparkles, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fmtDate } from '../../shared/format';
import {
  MAX_FILE_BYTES,
  type DocumentMeta,
  type ExtractionResult,
  type ExtractionStatus,
  type StatementExtraction,
  type StatementJobStatus,
  type UploadResult,
} from '../../shared/types';
import { api } from '../api';
import { ExtractionReviewModal } from '../components/ai/ExtractionReviewModal';
import { isDocumentExtractable } from '../components/ai/extractionHelpers';
import { StatementReviewModal } from '../components/ai/StatementReviewModal';
import { ConfirmDialog } from '../components/manage/ConfirmDialog';
import { StatusBadge, type BadgeTone } from '../components/manage/StatusBadge';
import { useDriveSync } from '../components/manage/useDriveSync';
import { useStore } from '../store';
import { Button, Card, EmptyState, InlineError, Input, Spinner } from '../components/ui';

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function mimeLabel(mime: string): string {
  const sub = mime.split('/')[1] ?? mime;
  if (sub.includes('pdf')) return 'PDF';
  if (sub.includes('csv')) return 'CSV';
  if (sub.includes('sheet') || sub.includes('excel')) return 'Spreadsheet';
  if (mime.startsWith('image/')) return 'Image';
  return sub.toUpperCase();
}

function formatScheduleTime(time: string): string {
  const [h, m] = time.split(':').map(Number);
  if (!Number.isFinite(h)) return time;
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m ?? 0).padStart(2, '0')} ${period}`;
}

const STATUS_TONE = { queued: 'info', stored: 'positive', review: 'caution' } as const;
const STATUS_LABEL = { queued: 'Queued', stored: 'Stored', review: 'Review' } as const;
const SYNC_TONE = { complete: 'positive', partial: 'caution', error: 'danger' } as const;

// Extraction status chip, shown alongside the document's own status badge.
const EXTRACTION_TONE: Record<ExtractionStatus, BadgeTone> = {
  pending: 'info',
  suggested: 'caution',
  confirmed: 'positive',
  dismissed: 'neutral',
  failed: 'danger',
};
const EXTRACTION_LABEL: Record<ExtractionStatus, string> = {
  pending: 'Extracting…',
  suggested: 'Needs review',
  confirmed: 'Extracted',
  dismissed: 'Dismissed',
  failed: 'Extraction failed',
};
// Every non-terminal status keeps an escape hatch: dismissed/failed offer a
// plain re-extract, and 'pending' gets one too (a "Try again" affordance) so
// no row is ever permanently stuck — even though the current backend runs
// the extraction synchronously, so a row rarely stays 'pending' in practice.
const REEXTRACTABLE_STATUSES: ExtractionStatus[] = ['dismissed', 'failed', 'pending'];

function extractButtonLabel(extraction: ExtractionResult | undefined): string {
  if (!extraction) return 'Extract';
  if (extraction.status === 'pending') return 'Try again';
  return 'Re-extract';
}

// Statement job chip, shown alongside the document's own status badge — a
// statement is a table, not a receipt: the chip surfaces how many rows are
// still awaiting triage rather than a single pass/fail state.
const STATEMENT_TONE: Record<StatementJobStatus, BadgeTone> = {
  pending: 'info',
  suggested: 'caution',
  partial: 'caution',
  confirmed: 'positive',
  dismissed: 'neutral',
  failed: 'danger',
};

function statementLabel(statement: StatementExtraction): string {
  const proposed = statement.rows.filter((r) => r.status === 'proposed').length;
  switch (statement.status) {
    case 'pending':
      return 'Reading statement…';
    case 'suggested':
      return `${proposed} proposed`;
    case 'partial':
      return `${proposed} proposed · truncated`;
    case 'confirmed':
      return 'Statement imported';
    case 'dismissed':
      return 'Dismissed';
    case 'failed':
      return 'Read failed';
  }
}

// Same escape-hatch rule as receipt extraction: dismissed/failed/pending all
// get a plain re-run so no statement job is ever permanently stuck.
const STATEMENT_REEXTRACTABLE_STATUSES: StatementJobStatus[] = ['dismissed', 'failed', 'pending'];

function statementButtonLabel(statement: StatementExtraction | undefined): string {
  if (!statement) return 'Read as statement';
  if (statement.status === 'pending') return 'Try again';
  return 'Re-run';
}

export default function Documents() {
  const documents = useStore((s) => s.documents);
  const extractions = useStore((s) => s.extractions);
  const statements = useStore((s) => s.statements);
  const aiProvider = useStore((s) => s.settings.aiProvider);
  const aiKeySet = useStore((s) => s.settings.aiKeySet);
  const uploadDocuments = useStore((s) => s.uploadDocuments);
  const extractDocument = useStore((s) => s.extractDocument);
  const extractStatement = useStore((s) => s.extractStatement);
  const refreshQuiet = useStore((s) => s.refreshQuiet);
  const toast = useStore((s) => s.toast);
  const drive = useDriveSync();

  const [uploading, setUploading] = useState(false);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [lastResult, setLastResult] = useState<UploadResult | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<DocumentMeta | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Busy-flag discipline: only one AI run (receipt extract OR statement
  // read) across the whole vault at a time — every other row's actions are
  // disabled while it runs (same rule ManagedListSection applies to its
  // add/remove controls). Tracking `kind` alongside the id lets a single
  // document's Extract and "Read as statement" buttons show independent
  // loading state without allowing either to start while the other runs.
  const [running, setRunning] = useState<{ id: string; kind: 'extract' | 'statement' } | null>(null);
  // Transient, per-document: a thrown request-level error (network/HTTP).
  // Server-recorded failures use extraction.error/statement.error instead —
  // kept to exactly one persistent surface (the chip's row text) and one
  // transient surface (this), no redundant toast on top of either.
  const [extractError, setExtractError] = useState<{ id: string; message: string } | null>(null);
  const [statementError, setStatementError] = useState<{ id: string; message: string } | null>(null);
  // Single slot for whichever review modal is open (extraction or
  // statement) — one `kind` field means an auto-open from either flow can
  // check "is anything at all already open" with one freshness-guaranteed
  // updater, instead of two state variables that can't see each other's
  // latest value from inside a setState callback.
  const [reviewing, setReviewing] = useState<{ id: string; kind: 'extract' | 'statement' } | null>(null);

  const aiOn = aiProvider !== 'off';
  // Anthropic without a stored key can't actually extract anything — treat
  // it as not-ready rather than offering a button that will just fail.
  const keyMissing = aiProvider === 'anthropic' && !aiKeySet;
  const aiReady = aiOn && !keyMissing;

  async function handleExtract(doc: DocumentMeta) {
    setRunning({ id: doc.id, kind: 'extract' });
    setExtractError(null);
    try {
      const result = await extractDocument(doc.id);
      if (result.status === 'suggested') {
        // Never steal focus from an already-open review: if the user is
        // mid-edit on a different document, this result waits for its own
        // Review click instead of hijacking the open modal.
        setReviewing((current) => (current === null ? { id: doc.id, kind: 'extract' } : current));
      } else if (result.status === 'pending') {
        toast('success', 'Still working — check back in a moment.');
      }
      // 'failed' is surfaced persistently via the extraction row's own error
      // text once the store updates — no toast needed on top of that.
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not extract that document.';
      setExtractError({ id: doc.id, message });
    } finally {
      setRunning(null);
    }
  }

  async function handleReadStatement(doc: DocumentMeta) {
    setRunning({ id: doc.id, kind: 'statement' });
    setStatementError(null);
    try {
      const result = await extractStatement(doc.id);
      if (result.status === 'suggested' || result.status === 'partial') {
        setReviewing((current) => (current === null ? { id: doc.id, kind: 'statement' } : current));
      } else if (result.status === 'pending') {
        toast('success', 'Still working — check back in a moment.');
      }
      // 'failed' is surfaced persistently via the statement row's own error
      // text once the store updates — no toast needed on top of that.
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not read that statement.';
      setStatementError({ id: doc.id, message });
    } finally {
      setRunning(null);
    }
  }

  // While anything is 'pending', poll for a resolved status instead of
  // leaving the row stuck on "Extracting…"/"Reading statement…" forever —
  // but never while a review modal is open. A poll-triggered re-render hands
  // the modal a new set of store-derived props on every tick; without
  // pausing, that used to change the modal's onClose identity too, which
  // re-ran the (frozen) Modal's focus effect and yanked focus to its close
  // button mid-edit — a stray Enter would then discard the draft. Paused
  // here, and belt-and-braces via the stable closeReview/guarded-onClose in
  // each modal.
  const hasPending =
    extractions.some((e) => e.status === 'pending') || statements.some((s) => s.status === 'pending');
  useEffect(() => {
    if (!hasPending || reviewing) return;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout>;
    // Re-arm only after the previous refresh settles, so a slow request
    // can't overlap with the next tick (setTimeout, not setInterval).
    const tick = () => {
      void refreshQuiet().finally(() => {
        if (!cancelled) timeoutId = setTimeout(tick, 5000);
      });
    };
    timeoutId = setTimeout(tick, 5000);
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [hasPending, reviewing, refreshQuiet]);

  // Stable identity across re-renders (setReviewing from useState never
  // changes) — passed to whichever modal is open so its internal onClose
  // guard can also stay stable, which is what actually stops the focus
  // effect from re-running on every poll tick or busy transition.
  const closeReview = useCallback(() => setReviewing(null), []);

  // Defensive cleanup: if the document (or its extraction/statement record)
  // a review modal points at disappears from the store — deleted, or wiped
  // by a background refresh — clear `reviewing` rather than leaving it
  // pointing at nothing. The modal already renders null in that case (see
  // the lookups below), but `reviewing` staying set would keep the polling
  // effect above paused forever with no visible modal to show for it.
  useEffect(() => {
    if (!reviewing) return;
    const docStillExists = documents.some((d) => d.id === reviewing.id);
    const targetStillExists =
      reviewing.kind === 'extract'
        ? extractions.some((e) => e.documentId === reviewing.id)
        : statements.some((s) => s.documentId === reviewing.id);
    if (!docStillExists || !targetStillExists) setReviewing(null);
  }, [reviewing, documents, extractions, statements]);

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    const tooLarge = files.filter((f) => f.size > MAX_FILE_BYTES);
    const valid = files.filter((f) => f.size <= MAX_FILE_BYTES);
    const errors = tooLarge.map((f) => `"${f.name}" is larger than 20 MB and was not uploaded.`);
    setLastResult(null);
    setUploadErrors(errors);

    if (valid.length === 0) {
      setInputKey((k) => k + 1);
      return;
    }
    setUploading(true);
    try {
      const result = await uploadDocuments(valid);
      setLastResult(result);
      if (result.errors.length > 0) setUploadErrors((prev) => [...prev, ...result.errors]);
      const parts = [`${result.documents.length} file${result.documents.length === 1 ? '' : 's'} stored`];
      if (result.inserted > 0) parts.push(`${result.inserted} transaction${result.inserted === 1 ? '' : 's'} added`);
      if (result.duplicates > 0) parts.push(`${result.duplicates} duplicate${result.duplicates === 1 ? '' : 's'} skipped`);
      if (result.review > 0) parts.push(`${result.review} need${result.review === 1 ? 's' : ''} review`);
      toast('success', parts.join(' · '));
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Upload failed. Try again.');
    } finally {
      setUploading(false);
      setInputKey((k) => k + 1);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await api.deleteDocument(pendingDelete.id);
      await refreshQuiet();
      toast('success', 'Document deleted.');
      setPendingDelete(null);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Could not delete that document.');
    } finally {
      setDeleteBusy(false);
    }
  }

  const status = drive.status;
  const folderConfigured = !!status?.folder.folderUrl;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Upload documents">
          <p className="text-sm text-muted">
            Add receipts, statements, invoices, PDFs, images, CSVs, or spreadsheets. Max 20 MB per file.
          </p>
          <div className="mt-3">
            <Input
              key={inputKey}
              type="file"
              multiple
              disabled={uploading}
              aria-label="Choose files to upload"
              onChange={(e) => void handleFiles(e.target.files)}
            />
          </div>
          {uploading && (
            <p className="mt-3 flex items-center gap-2 text-sm text-muted">
              <Spinner className="size-4" /> Uploading…
            </p>
          )}
          {uploadErrors.length > 0 && (
            <div className="mt-3 space-y-1">
              {uploadErrors.map((err, i) => (
                <InlineError key={i} message={err} />
              ))}
            </div>
          )}
          {lastResult && lastResult.documents.length > 0 && (
            <p className="mt-3 text-sm text-positive">
              Stored {lastResult.documents.length} document{lastResult.documents.length === 1 ? '' : 's'}.
            </p>
          )}
        </Card>

        <Card title="Google Drive inbox">
          {drive.loading ? (
            <p className="flex items-center gap-2 text-sm text-muted">
              <Spinner className="size-4" /> Checking Drive sync status…
            </p>
          ) : drive.error ? (
            <div className="space-y-2">
              <InlineError message={drive.error} />
              <Button variant="ghost" size="sm" onClick={() => void drive.reload()}>
                Try again
              </Button>
            </div>
          ) : !folderConfigured ? (
            <EmptyState
              icon={FolderSync}
              compact
              title="Drive inbox not configured yet"
              body="Once a dedicated Drive folder is connected, files added there are checked automatically at 8:00 AM daily."
            />
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-sm font-semibold">{status.folder.folderName ?? 'Drive inbox'}</p>
                <a
                  href={status.folder.folderUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
                >
                  View folder <ExternalLink className="size-3.5" aria-hidden />
                </a>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge label={`Daily at ${formatScheduleTime(status.schedule.time)}`} tone="accent" />
                {status.lastStatus && (
                  <StatusBadge
                    label={status.lastStatus === 'complete' ? 'Last sync complete' : status.lastStatus === 'partial' ? 'Last sync partial' : 'Last sync error'}
                    tone={SYNC_TONE[status.lastStatus]}
                  />
                )}
              </div>
              <p className="text-xs text-muted">
                {status.lastSyncedAt ? `Last synced ${new Date(status.lastSyncedAt).toLocaleString()}` : 'Not synced yet.'}
              </p>
              <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                <div>
                  <p className="text-xs text-muted">Imported</p>
                  <p className="font-medium">{status.counts.imported}</p>
                </div>
                <div>
                  <p className="text-xs text-muted">Duplicates</p>
                  <p className="font-medium">{status.counts.duplicates}</p>
                </div>
                <div>
                  <p className="text-xs text-muted">Stored</p>
                  <p className="font-medium">{status.counts.stored}</p>
                </div>
                <div>
                  <p className="text-xs text-muted">Review</p>
                  <p className="font-medium">{status.counts.review}</p>
                </div>
              </div>
              <p className="text-xs text-muted">
                Add a receipt, CSV, statement, or invoice to the folder — it&apos;s checked daily at 8:00 AM.
              </p>
            </div>
          )}
        </Card>
      </div>

      {!aiOn && (
        // Shown once for the whole vault, not per row (per-row noise would
        // repeat the same "it's off" message on every extractable document).
        <div className="flex items-center gap-2 rounded-xl border border-border bg-surface px-4 py-3 text-sm text-muted">
          <Sparkles className="size-4 shrink-0 text-accent" aria-hidden />
          <span>AI receipt extraction is off.</span>
          <Link to="/settings" className="font-medium text-accent hover:underline">
            Enable it in Settings
          </Link>
        </div>
      )}
      {aiOn && keyMissing && (
        // Anthropic selected but no key stored yet — extraction can't run,
        // so don't offer buttons that would just fail; point at Settings.
        <div className="flex items-center gap-2 rounded-xl border border-border bg-surface px-4 py-3 text-sm text-muted">
          <Sparkles className="size-4 shrink-0 text-accent" aria-hidden />
          <span>Add your Anthropic key in Settings to start extracting.</span>
          <Link to="/settings" className="font-medium text-accent hover:underline">
            Go to Settings
          </Link>
        </div>
      )}

      <Card title={documents.length > 0 ? 'Document vault' : undefined}>
        {documents.length === 0 ? (
          <EmptyState icon={FileText} title="No documents yet. Upload a file or add one to your Drive inbox." />
        ) : (
          <ul className="divide-y divide-border">
            {documents.map((doc) => {
              const extraction = extractions.find((e) => e.documentId === doc.id);
              const statement = statements.find((s) => s.documentId === doc.id);
              const mimeOk = isDocumentExtractable(doc.mimeType);
              const isPdf = doc.mimeType === 'application/pdf';
              // Review just opens an already-fetched suggestion — it never
              // calls the provider, so it stays reachable even with AI fully
              // off (otherwise a 'suggested' extraction from before the user
              // turned AI off would dangle: a chip with no way to act on it).
              const showReview = mimeOk && extraction?.status === 'suggested';
              // Starting a NEW extraction needs a ready provider (a key, if anthropic).
              const showExtract =
                aiReady && mimeOk && (!extraction || REEXTRACTABLE_STATUSES.includes(extraction.status));

              // Statement path: PDF only (spec — the receipt path above stays
              // for one-purchase PDFs; images get receipt only). Same
              // already-fetched-suggestion reasoning as showReview.
              const proposedCount = statement ? statement.rows.filter((r) => r.status === 'proposed').length : 0;
              const showStatementReview =
                isPdf &&
                !!statement &&
                (statement.status === 'suggested' || statement.status === 'partial') &&
                proposedCount > 0;
              // Ready like Extract, plus PDF-only — but the backend rejects
              // Workers AI for PDFs, so a workers-ai user still sees the
              // button (not hidden) with a disabled state and an honest
              // reason, rather than a click that just fails server-side.
              // Also covers the dead-end where a job landed in
              // 'suggested'/'partial' with zero proposed rows — a real
              // outcome (a PDF with no readable table, rows pruned, or
              // /api/state's newest-10-jobs cap meaning rows:[] even though
              // rowCount > 0) that otherwise leaves no action at all.
              const showStatementAction =
                aiReady &&
                isPdf &&
                (!statement ||
                  STATEMENT_REEXTRACTABLE_STATUSES.includes(statement.status) ||
                  ((statement.status === 'suggested' || statement.status === 'partial') && proposedCount === 0));
              const statementBlockedByProvider = showStatementAction && aiProvider === 'workers-ai';
              return (
                <li key={doc.id} className="flex flex-wrap items-center gap-3 py-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                    <FileText className="size-4" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{doc.filename}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      {mimeLabel(doc.mimeType)} · {formatBytes(doc.size)} ·{' '}
                      {doc.source === 'google-drive' ? 'Google Drive' : 'Upload'} · {fmtDate(doc.createdAt.slice(0, 10))}
                    </p>
                    {extraction?.status === 'failed' && (
                      <p className="mt-0.5 text-xs text-danger">
                        {extraction.error ?? 'Extraction failed — try again.'}
                      </p>
                    )}
                    {extractError?.id === doc.id && <p className="mt-0.5 text-xs text-danger">{extractError.message}</p>}
                    {statement?.status === 'failed' && (
                      <p className="mt-0.5 text-xs text-danger">
                        {statement.error ?? 'Could not read this statement — try again.'}
                      </p>
                    )}
                    {statementError?.id === doc.id && (
                      <p className="mt-0.5 text-xs text-danger">{statementError.message}</p>
                    )}
                  </div>
                  <StatusBadge label={STATUS_LABEL[doc.status]} tone={STATUS_TONE[doc.status]} />
                  {extraction && <StatusBadge label={EXTRACTION_LABEL[extraction.status]} tone={EXTRACTION_TONE[extraction.status]} />}
                  {statement && <StatusBadge label={statementLabel(statement)} tone={STATEMENT_TONE[statement.status]} />}
                  {showReview && (
                    // Disabled parity with Extract: opening a review while
                    // another document's extraction is in flight is exactly
                    // the race that hijacks this modal when it resolves —
                    // block the open, not just the close.
                    <Button
                      variant="subtle"
                      size="sm"
                      disabled={running !== null}
                      onClick={() => setReviewing({ id: doc.id, kind: 'extract' })}
                    >
                      Review
                    </Button>
                  )}
                  {showStatementReview && (
                    <Button
                      variant="subtle"
                      size="sm"
                      disabled={running !== null}
                      onClick={() => setReviewing({ id: doc.id, kind: 'statement' })}
                    >
                      Review {proposedCount} transaction{proposedCount === 1 ? '' : 's'}
                    </Button>
                  )}
                  {showExtract && (
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={running?.id === doc.id && running.kind === 'extract'}
                      disabled={running !== null && !(running.id === doc.id && running.kind === 'extract')}
                      onClick={() => void handleExtract(doc)}
                    >
                      <Sparkles className="size-3.5" aria-hidden />
                      {extractButtonLabel(extraction)}
                    </Button>
                  )}
                  {showStatementAction && (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={running?.id === doc.id && running.kind === 'statement'}
                        disabled={
                          statementBlockedByProvider ||
                          (running !== null && !(running.id === doc.id && running.kind === 'statement'))
                        }
                        title={statementBlockedByProvider ? 'PDF statements need the Anthropic provider' : undefined}
                        onClick={() => void handleReadStatement(doc)}
                      >
                        <Sparkles className="size-3.5" aria-hidden />
                        {statementButtonLabel(statement)}
                      </Button>
                      {/* Visible, not title-only: a title attribute is
                          unreachable on a disabled, non-focusable control. */}
                      {statementBlockedByProvider && (
                        <span className="text-xs text-muted">PDF statements need the Anthropic provider.</span>
                      )}
                    </div>
                  )}
                  <a
                    href={api.documentDownloadUrl(doc.id)}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Download ${doc.filename}`}
                    className="flex size-9 items-center justify-center rounded-lg text-muted hover:bg-canvas hover:text-ink"
                  >
                    <Download className="size-4" aria-hidden />
                  </a>
                  <button
                    type="button"
                    aria-label={`Delete ${doc.filename}`}
                    onClick={() => setPendingDelete(doc)}
                    className="flex size-9 items-center justify-center rounded-lg text-muted hover:bg-danger-soft hover:text-danger"
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete "${pendingDelete.filename}"?`}
          message={
            <p>
              This removes the stored file copy and its record from your vault. This can&apos;t be undone.
            </p>
          }
          busy={deleteBusy}
          error={deleteError}
          onConfirm={() => void confirmDelete()}
          onCancel={() => {
            setPendingDelete(null);
            setDeleteError(null);
          }}
        />
      )}

      {reviewing?.kind === 'extract' &&
        (() => {
          const reviewDoc = documents.find((d) => d.id === reviewing.id);
          const reviewExtraction = extractions.find((e) => e.documentId === reviewing.id);
          if (!reviewDoc || !reviewExtraction) return null;
          return (
            // key={reviewing.id} forces a full remount (and re-seed) whenever
            // the reviewed document changes — belt-and-braces on top of the
            // "only open if nothing is open" guard in handleExtract, so a
            // stale draft can never render against a different document's
            // image/attribution.
            <ExtractionReviewModal
              key={reviewing.id}
              doc={reviewDoc}
              extraction={reviewExtraction}
              onClose={closeReview}
            />
          );
        })()}

      {reviewing?.kind === 'statement' &&
        (() => {
          const reviewDoc = documents.find((d) => d.id === reviewing.id);
          const reviewStatement = statements.find((s) => s.documentId === reviewing.id);
          if (!reviewDoc || !reviewStatement) return null;
          return (
            // Same keyed-remount + guarded-close discipline as the
            // extraction modal above (sprint-3 lesson).
            <StatementReviewModal
              key={reviewing.id}
              doc={reviewDoc}
              statement={reviewStatement}
              onClose={closeReview}
            />
          );
        })()}
    </div>
  );
}
