// Global "Drive sync" status modal (spec §5/§16.4). Read-only status view —
// calls api.getDriveSync() directly since the store has no wrapping action
// for it; this is still the sanctioned typed API client, never a raw fetch.
// Never renders tokens: DriveSyncStatus has no token field to begin with.
import { useEffect, useState } from 'react';
import { CheckCircle2, Clock, Cloud, ExternalLink, XCircle, type LucideIcon } from 'lucide-react';
import { api } from '../../api';
import type { DriveSyncStatus } from '../../../shared/types';
import { Button, EmptyState, InlineError, Modal, Spinner } from '../ui';

export function DriveSyncModal({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<DriveSyncStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getDriveSync()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load Drive sync status.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Modal
      title="Drive sync"
      onClose={onClose}
      footer={
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          A scheduled runner with your Google authorization checks the dedicated Drive folder every day and sends
          only new files to Ledgerly. Ledgerly never browses Drive directly from your browser.
        </p>

        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner className="size-4" /> Loading Drive sync status…
          </div>
        )}

        {!loading && error && <InlineError message={error} />}

        {!loading &&
          !error &&
          status &&
          (status.folder.folderName ? (
            <div className="space-y-4">
              <div className="rounded-xl border border-border p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <span className="flex size-9 items-center justify-center rounded-xl bg-accent-soft text-accent">
                      <Cloud className="size-5" aria-hidden />
                    </span>
                    <div>
                      <p className="text-sm font-semibold">{status.folder.folderName}</p>
                      <p className="text-xs text-muted">Dedicated import folder</p>
                    </div>
                  </div>
                  {status.folder.folderUrl && (
                    <a
                      href={status.folder.folderUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1 text-xs font-medium text-accent hover:underline"
                    >
                      Open <ExternalLink className="size-3" aria-hidden />
                    </a>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <InfoRow icon={Clock} label="Schedule" value={`${status.schedule.time} daily · ${status.schedule.timezone}`} />
                <InfoRow
                  icon={status.lastStatus === 'error' ? XCircle : CheckCircle2}
                  label="Last sync"
                  value={status.lastSyncedAt ? new Date(status.lastSyncedAt).toLocaleString() : 'Not run yet'}
                />
              </div>

              {status.lastSyncedAt && (
                <>
                  <dl className="grid grid-cols-2 gap-3 rounded-xl bg-canvas p-4 text-sm sm:grid-cols-4">
                    <ResultStat label="Imported" value={status.counts.imported} />
                    <ResultStat label="Duplicates" value={status.counts.duplicates} />
                    <ResultStat label="Stored" value={status.counts.stored} />
                    <ResultStat label="Needs review" value={status.counts.review} />
                  </dl>
                  {status.counts.errors > 0 && (
                    <p className="text-xs text-danger">
                      {status.counts.errors} sync error{status.counts.errors === 1 ? '' : 's'} on the last run.
                    </p>
                  )}
                </>
              )}
            </div>
          ) : (
            <EmptyState
              icon={Cloud}
              title="Drive sync isn't configured yet"
              body="Once a dedicated Drive folder is connected, files added there will be checked automatically every day at 8:00 AM."
              compact
            />
          ))}
      </div>
    </Modal>
  );
}

function InfoRow({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
      <div className="min-w-0">
        <p className="text-xs text-muted">{label}</p>
        <p className="truncate font-medium">{value}</p>
      </div>
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
