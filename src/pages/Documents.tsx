// Documents page (spec §14) — upload + Drive inbox status + vault list.
// objectKey is never rendered; no encryption claims are made anywhere here.
import { Download, ExternalLink, FileText, FolderSync, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { fmtDate } from '../../shared/format';
import { MAX_FILE_BYTES, type DocumentMeta, type UploadResult } from '../../shared/types';
import { api } from '../api';
import { ConfirmDialog } from '../components/manage/ConfirmDialog';
import { StatusBadge } from '../components/manage/StatusBadge';
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

export default function Documents() {
  const documents = useStore((s) => s.documents);
  const uploadDocuments = useStore((s) => s.uploadDocuments);
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

      <Card title={documents.length > 0 ? 'Document vault' : undefined}>
        {documents.length === 0 ? (
          <EmptyState icon={FileText} title="No documents yet. Upload a file or add one to your Drive inbox." />
        ) : (
          <ul className="divide-y divide-border">
            {documents.map((doc) => (
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
                </div>
                <StatusBadge label={STATUS_LABEL[doc.status]} tone={STATUS_TONE[doc.status]} />
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
            ))}
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
    </div>
  );
}
