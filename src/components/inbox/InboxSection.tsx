// "Mail-in inbox" section on the Documents page (sprint 8): emails routed to
// the user's own Worker, each waiting on an explicit decision. Presentational
// — the page owns the modal slot and busy state so the sprint-4 one-modal /
// one-in-flight-action discipline stays in one place (Documents.tsx).
import { Mail, Paperclip } from 'lucide-react';
import { fmtDate, fmtSigned } from '../../../shared/format';
import type { DocumentMeta, InboxEmail } from '../../../shared/types';
import { StatusBadge } from '../manage/StatusBadge';
import { Button, Card, EmptyState } from '../ui';

function AttachmentNote({ item, documents }: { item: InboxEmail; documents: DocumentMeta[] }) {
  if (!item.documentId) return null;
  const doc = documents.find((d) => d.id === item.documentId);
  // Text only either way — no dead link when the document is gone (deleted,
  // or outside the capped /api/state document list).
  return (
    <p className="mt-0.5 flex items-center gap-1 text-xs text-muted">
      <Paperclip className="size-3 shrink-0" aria-hidden />
      {doc ? (
        <span className="truncate">Attachment saved to the vault below: {doc.filename}</span>
      ) : (
        <span>Attachment is no longer in the vault.</span>
      )}
    </p>
  );
}

export function InboxSection({
  items,
  proposed,
  documents,
  actionsDisabled,
  dismissingId,
  onReview,
  onDismiss,
}: {
  /** Pre-filtered, newest-first (visibleInboxItems). */
  items: InboxEmail[];
  /** Count for the header chip. */
  proposed: number;
  documents: DocumentMeta[];
  /** True while the page has any conflicting action in flight. */
  actionsDisabled: boolean;
  /** Item id of an in-flight row dismiss, or null. */
  dismissingId: string | null;
  onReview: (item: InboxEmail) => void;
  onDismiss: (item: InboxEmail) => void;
}) {
  return (
    <Card
      title="Mail-in inbox"
      action={proposed > 0 ? <StatusBadge label={`${proposed} to review`} tone="caution" /> : undefined}
    >
      {items.length === 0 ? (
        // Only reachable while the feed is enabled (the page hides the whole
        // section when it's off and there's nothing to show).
        <EmptyState
          icon={Mail}
          compact
          title="No email waiting for review."
          body="Messages from your allow-listed senders land here as proposals you confirm — nothing is imported automatically."
        />
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-3 py-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                <Mail className="size-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{item.from}</p>
                <p className="mt-0.5 truncate text-xs text-muted">
                  {item.subject} · {fmtDate(item.receivedAt.slice(0, 10))}
                </p>
                {item.parsed ? (
                  <p className="mt-0.5 text-sm">
                    <span className="font-medium">{item.parsed.merchant}</span> ·{' '}
                    {fmtDate(item.parsed.date)} ·{' '}
                    <span
                      className={`font-semibold tabular-nums ${
                        item.parsed.type === 'income' ? 'text-positive' : 'text-ink'
                      }`}
                    >
                      {fmtSigned(item.parsed.amount, item.parsed.type)}
                    </span>{' '}
                    <span className="text-xs text-muted">parsed by {item.parsed.pack}</span>
                  </p>
                ) : (
                  <p className="mt-0.5 text-xs text-muted">
                    Couldn&apos;t read a transaction from this email.
                  </p>
                )}
                <AttachmentNote item={item} documents={documents} />
              </div>
              {item.parsed ? (
                <Button
                  variant="subtle"
                  size="sm"
                  disabled={actionsDisabled}
                  onClick={() => onReview(item)}
                >
                  Review
                </Button>
              ) : (
                <>
                  <Button
                    variant="subtle"
                    size="sm"
                    disabled={actionsDisabled}
                    onClick={() => onReview(item)}
                  >
                    Add manually
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={actionsDisabled && dismissingId !== item.id}
                    loading={dismissingId === item.id}
                    onClick={() => onDismiss(item)}
                  >
                    Dismiss
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
