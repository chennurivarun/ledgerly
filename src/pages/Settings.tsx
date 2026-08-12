// Settings page (spec §16) — display currency, net worth setup, managed
// categories/tags/accounts, automatic detection controls, Drive sync status,
// and the danger zone.
import { AlertTriangle, Coins, ExternalLink, FolderSync, Mail, MessageCircle, Radar, RotateCcw, Sparkles, Wallet, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { fmtCurrency } from '../../shared/format';
import type { AiProvider, BriefingCadence } from '../../shared/types';
import type { BriefingPreview } from '../api';
import { CurrencySelect } from '../components/CurrencySelect';
import { ManagedListSection } from '../components/manage/ManagedListSection';
import { StatusBadge } from '../components/manage/StatusBadge';
import { Toggle } from '../components/manage/Toggle';
import { useDriveSync } from '../components/manage/useDriveSync';
import { WipeDataModal } from '../components/manage/WipeDataModal';
import {
  buildBriefingToggleUpdate,
  buildCadenceUpdate,
  buildDeliveryUpdate,
  buildTokenUpdate,
  briefingSentMessage,
  canSendTestBriefing,
  deliveryDirty,
  digitsOnly,
  lastBriefingLabel,
  type BriefingSettingsUpdate,
} from '../components/settings/briefingHelpers';
import {
  addSenderEntry,
  buildAllowlistUpdate,
  buildEmailFeedToggleUpdate,
  removeSenderEntry,
  senderEntryError,
  showEmptyAllowlistWarning,
} from '../components/inbox/inboxHelpers';
import { useStore } from '../store';
import { Button, Card, EmptyState, Field, InlineError, Input, SegmentedControl, Spinner } from '../components/ui';

function formatScheduleTime(time: string): string {
  const [h, m] = time.split(':').map(Number);
  if (!Number.isFinite(h)) return time;
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m ?? 0).padStart(2, '0')} ${period}`;
}

const SYNC_TONE = { complete: 'positive', partial: 'caution', error: 'danger' } as const;

export default function Settings() {
  const settings = useStore((s) => s.settings);
  const tags = useStore((s) => s.tags);
  const updatePreferences = useStore((s) => s.updatePreferences);
  const previewBriefing = useStore((s) => s.previewBriefing);
  const sendBriefing = useStore((s) => s.sendBriefing);
  const wipeAll = useStore((s) => s.wipeAll);
  const toast = useStore((s) => s.toast);
  const drive = useDriveSync();
  // Single source for BOTH the error count and the error list: DriveSyncStatus.folder
  // is a DriveSyncMeta and already carries `lastErrors` (message strings), so
  // both numbers come from this one /api/drive-sync fetch instead of pairing
  // it with settings.drive (a separate GET /api/state fetch) that could
  // disagree if a sync completes between the two requests.
  const driveErrorMessages = drive.status?.folder.lastErrors ?? [];

  return (
    <div className="space-y-6">
      <CurrencySection
        currency={settings.currency}
        onSave={async (code) => {
          await updatePreferences({ currency: code });
          toast('success', 'Display currency updated.');
        }}
      />

      <AiSection
        provider={settings.aiProvider}
        model={settings.aiModel}
        keySet={settings.aiKeySet}
        onSaveProvider={async (provider) => {
          await updatePreferences({ aiProvider: provider });
          toast('success', 'AI provider updated.');
        }}
        onSaveKey={async (key) => {
          await updatePreferences({ aiApiKey: key });
          toast('success', 'API key saved.');
        }}
        onRemoveKey={async () => {
          await updatePreferences({ aiApiKey: null });
          toast('success', 'API key removed.');
        }}
        onSaveModel={async (model) => {
          await updatePreferences({ aiModel: model });
          toast('success', 'Model override saved.');
        }}
      />

      <BriefingsSection
        enabled={settings.briefingsEnabled}
        cadence={settings.briefingCadence}
        recipient={settings.briefingWhatsappRecipient}
        phoneNumberId={settings.briefingWhatsappPhoneNumberId}
        tokenSet={settings.briefingWhatsappTokenSet}
        lastSentAt={settings.lastBriefingSentAt}
        onToggle={async (next) => {
          await updatePreferences(buildBriefingToggleUpdate(next));
          toast('success', next ? 'Briefings enabled.' : 'Briefings disabled.');
        }}
        onSaveCadence={async (cadence) => {
          await updatePreferences(buildCadenceUpdate(cadence));
          toast('success', 'Briefing cadence updated.');
        }}
        onSaveDelivery={async (recipientDraft, phoneNumberIdDraft) => {
          await updatePreferences(buildDeliveryUpdate(recipientDraft, phoneNumberIdDraft));
          toast('success', 'Delivery settings saved.');
        }}
        onSaveToken={async (update) => {
          await updatePreferences(update);
          toast(
            'success',
            update.briefingWhatsappToken === null ? 'Access token removed.' : 'Access token saved.',
          );
        }}
        onPreview={() => previewBriefing()}
        onSendTest={async () => {
          // sendBriefing reads nothing client-side — the server validates the
          // SAVED config at call time and its error message surfaces inline.
          const res = await sendBriefing();
          toast('success', briefingSentMessage(res.sentTo));
        }}
      />

      <MailInFeedSection
        enabled={settings.emailFeedEnabled}
        allowedSenders={settings.emailAllowedSenders}
        onToggle={async (next) => {
          await updatePreferences(buildEmailFeedToggleUpdate(next));
          toast('success', next ? 'Mail-in feed enabled.' : 'Mail-in feed disabled.');
        }}
        onAddSender={async (raw) => {
          // Read fresh at dispatch time — full-replacement saves must not
          // drop a concurrent change (same rule as the managed lists below).
          const current = useStore.getState().settings.emailAllowedSenders;
          await updatePreferences(buildAllowlistUpdate(addSenderEntry(current, raw)));
        }}
        onRemoveSender={async (entry) => {
          const current = useStore.getState().settings.emailAllowedSenders;
          await updatePreferences(buildAllowlistUpdate(removeSenderEntry(current, entry)));
        }}
      />

      <NetWorthSection
        assetsTotal={settings.assetsTotal}
        liabilitiesTotal={settings.liabilitiesTotal}
        configured={settings.netWorthConfigured}
        onSave={async (assets, liabilities) => {
          await updatePreferences({
            assetsTotal: assets,
            liabilitiesTotal: liabilities,
            netWorthConfigured: true,
          });
          toast('success', 'Net worth totals saved.');
        }}
      />

      <Card title="Managed categories, tags & accounts">
        {/*
          ponytail: blockRemove only guards "don't let the list go to zero" —
          it can't know whether `name` is the value currently selected in
          some other open form elsewhere on the app (e.g. mid-edit in a
          Recurring/Budget modal on another tab). True open-form tracking
          would need a shared registry of "categories/accounts in use by an
          open form" wired through every page that owns a form with a
          category/account picker, which doesn't exist in this scaffold.
          The last-item guard plus label preservation on removal (existing
          rows keep their historical value) are the practical mitigations.
        */}
        <div className="space-y-6">
          <ManagedListSection
            title="Categories"
            itemLabel="category"
            items={settings.categories}
            blockRemove={(name) =>
              settings.categories.length <= 1
                ? `Keep at least one category — "${name}" can't be the last one removed.`
                : null
            }
            onAdd={async (name) => {
              // Read fresh: two adds (or an add racing a remove) in flight
              // together must not silently drop each other's change.
              const current = useStore.getState().settings.categories;
              await updatePreferences({ categories: [...current, name] });
            }}
            onRemove={async (name) => {
              const current = useStore.getState().settings.categories;
              await updatePreferences({ categories: current.filter((c) => c !== name) });
            }}
          />
          <ManagedListSection
            title="Tags"
            itemLabel="tag"
            items={tags.map((t) => t.name)}
            onAdd={async (name) => {
              const current = useStore.getState().tags;
              await updatePreferences({ tags: [...current.map((t) => t.name), name] });
            }}
            onRemove={async (name) => {
              const current = useStore.getState().tags;
              await updatePreferences({ tags: current.map((t) => t.name).filter((n) => n !== name) });
            }}
          />
          <ManagedListSection
            title="Accounts"
            itemLabel="account"
            items={settings.accounts}
            blockRemove={(name) =>
              settings.accounts.length <= 1
                ? `Keep at least one account — "${name}" can't be the last one removed.`
                : null
            }
            onAdd={async (name) => {
              const current = useStore.getState().settings.accounts;
              await updatePreferences({ accounts: [...current, name] });
            }}
            onRemove={async (name) => {
              const current = useStore.getState().settings.accounts;
              await updatePreferences({ accounts: current.filter((a) => a !== name) });
            }}
          />
        </div>
      </Card>

      <DetectionSection
        ignoredCount={settings.dismissedPatterns.length}
        onRestore={async () => {
          const count = settings.dismissedPatterns.length;
          await updatePreferences({ dismissedPatterns: [] });
          toast('success', `Restored ${count} ignored suggestion${count === 1 ? '' : 's'}.`);
        }}
      />

      <Card title="Google Drive sync">
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
        ) : !drive.status?.folder.folderUrl ? (
          <EmptyState
            icon={FolderSync}
            compact
            title="Drive inbox not configured yet"
            body="Once a dedicated Drive folder is connected, files added there are checked automatically at 8:00 AM daily."
          />
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-sm font-semibold">{drive.status.folder.folderName ?? 'Drive inbox'}</p>
              <a
                href={drive.status.folder.folderUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
              >
                View folder <ExternalLink className="size-3.5" aria-hidden />
              </a>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge
                label={`Daily at ${formatScheduleTime(drive.status.schedule.time)} · ${drive.status.schedule.timezone}`}
                tone="accent"
              />
              {drive.status.lastStatus && (
                <StatusBadge
                  label={
                    drive.status.lastStatus === 'complete'
                      ? 'Last sync complete'
                      : drive.status.lastStatus === 'partial'
                        ? 'Last sync partial'
                        : 'Last sync error'
                  }
                  tone={SYNC_TONE[drive.status.lastStatus]}
                />
              )}
            </div>
            <p className="text-xs text-muted">
              {drive.status.lastSyncedAt
                ? `Last synced ${new Date(drive.status.lastSyncedAt).toLocaleString()}`
                : 'Not synced yet.'}
            </p>
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
              <div>
                <p className="text-xs text-muted">Imported</p>
                <p className="font-medium">{drive.status.counts.imported}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Duplicates</p>
                <p className="font-medium">{drive.status.counts.duplicates}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Stored</p>
                <p className="font-medium">{drive.status.counts.stored}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Review</p>
                <p className="font-medium">{drive.status.counts.review}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Errors</p>
                <p className="font-medium">{driveErrorMessages.length}</p>
              </div>
            </div>
            {driveErrorMessages.length > 0 && (
              <ul className="list-inside list-disc space-y-1 text-xs text-danger">
                {driveErrorMessages.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted">
              Add a receipt, CSV, statement, or invoice to the folder — it&apos;s checked daily at 8:00 AM.
            </p>
          </div>
        )}
      </Card>

      <SetupSection
        onRerun={async () => {
          await updatePreferences({ onboarded: false });
        }}
      />

      <DangerZone onWipe={wipeAll} onSuccess={() => toast('success', 'All Ledgerly data has been erased.')} />
    </div>
  );
}

function CurrencySection({
  currency,
  onSave,
}: {
  currency: string;
  onSave: (code: string) => Promise<void>;
}) {
  // `pending` optimistically holds the just-picked code while the save is in
  // flight: the store's `currency` prop only updates once updatePreferences
  // resolves, so binding the select directly to `currency` during that
  // round-trip would render the OLD value on every re-render (the click
  // "snaps back" until the request completes, and reads as a rejection on a
  // slow connection). Once the request settles, `pending` clears and the
  // select falls through to `currency` — which by then matches on success,
  // and reverts naturally to the pre-change value on error.
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(code: string) {
    if (code === currency) return;
    setPending(code);
    setError(null);
    try {
      await onSave(code);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save. Try again.');
    } finally {
      setPending(null);
    }
  }

  return (
    <Card title="Currency">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Coins className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted">
            Sets how amounts are displayed across Ledgerly. This changes formatting only — existing
            amounts are not converted between currencies.
          </p>
          <div className="mt-3 flex max-w-xs items-center gap-2">
            <CurrencySelect
              value={pending ?? currency}
              onChange={(code) => void handleChange(code)}
              disabled={pending !== null}
            />
            {pending !== null && <Spinner className="size-4 shrink-0 text-muted" />}
          </div>
          <InlineError message={error} />
        </div>
      </div>
    </Card>
  );
}

const AI_PROVIDER_OPTIONS: { value: AiProvider; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'workers-ai', label: 'Workers AI' },
  { value: 'anthropic', label: 'Anthropic (BYOK)' },
];

const AI_PROVIDER_COPY: Record<AiProvider, string> = {
  off: 'AI receipt extraction is disabled — no document is ever sent anywhere for analysis.',
  sarvam:
    "Sends documents to Sarvam's Document AI under YOUR key — built for Indian documents (22 Indic languages + English). Your key is stored in your database and never displayed again.",
  'workers-ai':
    'Processed by Workers AI inside your own Cloudflare account — never sent to a third-party vendor.',
  anthropic:
    "Sends document images to Anthropic's API under YOUR key. Your key is stored in your database and never displayed again.",
};

// Model override is shown for any active provider except 'off' — placeholder
// reflects what that provider actually calls its models, so it never reads
// like Anthropic naming while Workers AI is selected.
const MODEL_PLACEHOLDER: Record<'workers-ai' | 'anthropic' | 'sarvam', string> = {
  'workers-ai': '@cf/meta/llama-3.1-8b-instruct',
  anthropic: 'claude-opus-5',
  sarvam: 'sarvam-vision-1.5',
};

function AiSection({
  provider,
  model,
  keySet,
  onSaveProvider,
  onSaveKey,
  onRemoveKey,
  onSaveModel,
}: {
  provider: AiProvider;
  model: string | null;
  keySet: boolean;
  onSaveProvider: (provider: AiProvider) => Promise<void>;
  onSaveKey: (key: string) => Promise<void>;
  onRemoveKey: () => Promise<void>;
  onSaveModel: (model: string | null) => Promise<void>;
}) {
  const [providerPending, setProviderPending] = useState<AiProvider | null>(null);
  const [providerError, setProviderError] = useState<string | null>(null);

  const [keyInputOpen, setKeyInputOpen] = useState(!keySet);
  const [keyDraft, setKeyDraft] = useState('');
  const [keyBusy, setKeyBusy] = useState<'save' | 'remove' | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);

  const [modelDraft, setModelDraft] = useState(model ?? '');
  const [modelBusy, setModelBusy] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);

  // Re-open the key input whenever there's no saved key (initial state, or
  // after a successful Remove) so "add a key" is always reachable.
  useEffect(() => {
    if (!keySet) setKeyInputOpen(true);
  }, [keySet]);

  // Keep the model draft in sync with the saved value (e.g. after a save
  // elsewhere, or a danger-zone wipe resetting it to null).
  useEffect(() => {
    setModelDraft(model ?? '');
  }, [model]);

  const activeProvider = providerPending ?? provider;
  const anyBusy = providerPending !== null || keyBusy !== null || modelBusy;

  // A half-typed key left over from browsing the Anthropic tab must not
  // linger once the user switches away — clear the draft, not the saved key.
  useEffect(() => {
    if (activeProvider !== 'anthropic') setKeyDraft('');
  }, [activeProvider]);

  async function handleProviderChange(next: AiProvider) {
    if (next === provider || anyBusy) return;
    setProviderPending(next);
    setProviderError(null);
    try {
      await onSaveProvider(next);
    } catch (e) {
      setProviderError(e instanceof Error ? e.message : 'Could not save. Try again.');
    } finally {
      setProviderPending(null);
    }
  }

  async function handleSaveKey() {
    if (!keyDraft.trim()) {
      setKeyError('Enter an API key.');
      return;
    }
    setKeyBusy('save');
    setKeyError(null);
    try {
      await onSaveKey(keyDraft.trim());
      setKeyDraft('');
      setKeyInputOpen(false);
    } catch (e) {
      setKeyError(e instanceof Error ? e.message : 'Could not save the key. Try again.');
    } finally {
      setKeyBusy(null);
    }
  }

  async function handleRemoveKey() {
    setKeyBusy('remove');
    setKeyError(null);
    try {
      await onRemoveKey();
    } catch (e) {
      setKeyError(e instanceof Error ? e.message : 'Could not remove the key. Try again.');
    } finally {
      setKeyBusy(null);
    }
  }

  async function handleSaveModel() {
    setModelBusy(true);
    setModelError(null);
    try {
      await onSaveModel(modelDraft.trim() || null);
    } catch (e) {
      setModelError(e instanceof Error ? e.message : 'Could not save. Try again.');
    } finally {
      setModelBusy(false);
    }
  }

  return (
    <Card title="AI receipt extraction">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Sparkles className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 space-y-4">
          <p className="text-sm text-muted">
            Suggests merchant, date, total, and category from a receipt or statement you upload. Ledgerly
            never creates a transaction automatically — you review and confirm every suggestion.
          </p>

          <div className={anyBusy ? 'pointer-events-none opacity-60' : ''}>
            <SegmentedControl
              ariaLabel="AI provider"
              options={AI_PROVIDER_OPTIONS}
              value={activeProvider}
              onChange={(v) => void handleProviderChange(v)}
            />
          </div>
          {providerPending !== null && (
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <Spinner className="size-3.5" /> Saving…
            </p>
          )}
          <InlineError message={providerError} />

          <p className="rounded-xl border border-border bg-canvas px-3 py-2.5 text-xs text-muted">
            {AI_PROVIDER_COPY[activeProvider]}
          </p>

          {/*
            Key management and model override are each gated independently:
            - Key management shows whenever a key is actually stored
              (regardless of which provider is active — deleting a stored
              credential must never require re-enabling Anthropic first), or
              when Anthropic is active with no key yet (so there's a way to
              add one).
            - Model override shows for any provider except 'off' — Workers AI
              has an override too, just with Workers-AI-shaped model names.
          */}
          {(keySet || activeProvider !== 'off') && (
            <div className="space-y-4 border-t border-border pt-4">
              {(keySet || activeProvider === 'anthropic') && (
                <div>
                  {activeProvider === 'anthropic' && !keySet && (
                    <p className="mb-2 text-xs font-medium text-caution">
                      Add your Anthropic key below to start extracting.
                    </p>
                  )}
                  <Field label="Anthropic API key">
                    {!keyInputOpen ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge label="Key saved ✓" tone="positive" />
                        <Button variant="ghost" size="sm" disabled={anyBusy} onClick={() => setKeyInputOpen(true)}>
                          Replace
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={anyBusy}
                          loading={keyBusy === 'remove'}
                          onClick={() => void handleRemoveKey()}
                        >
                          Remove
                        </Button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        <Input
                          type="password"
                          autoComplete="off"
                          value={keyDraft}
                          disabled={anyBusy}
                          onChange={(e) => setKeyDraft(e.target.value)}
                          placeholder="sk-ant-…"
                          className="max-w-xs"
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={anyBusy || !keyDraft.trim()}
                          loading={keyBusy === 'save'}
                          onClick={() => void handleSaveKey()}
                        >
                          Save key
                        </Button>
                        {keySet && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={anyBusy}
                            onClick={() => {
                              setKeyInputOpen(false);
                              setKeyDraft('');
                              setKeyError(null);
                            }}
                          >
                            Cancel
                          </Button>
                        )}
                      </div>
                    )}
                    <p className="mt-1.5 text-xs text-muted">
                      Write-only — once saved, the key itself is never shown again.
                    </p>
                  </Field>
                  <InlineError message={keyError} />
                </div>
              )}

              {activeProvider !== 'off' && (
                <div>
                  <Field label="Model override (optional)" hint="Leave blank to use the default model.">
                    <Input
                      value={modelDraft}
                      disabled={anyBusy}
                      onChange={(e) => setModelDraft(e.target.value)}
                      placeholder={MODEL_PLACEHOLDER[activeProvider]}
                      className="max-w-xs"
                    />
                  </Field>
                  <div className="mt-2 flex justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={anyBusy || modelDraft.trim() === (model ?? '')}
                      loading={modelBusy}
                      onClick={() => void handleSaveModel()}
                    >
                      Save model
                    </Button>
                  </div>
                  <InlineError message={modelError} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

const BRIEFING_CADENCE_OPTIONS: { value: BriefingCadence; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
];

function BriefingsSection({
  enabled,
  cadence,
  recipient,
  phoneNumberId,
  tokenSet,
  lastSentAt,
  onToggle,
  onSaveCadence,
  onSaveDelivery,
  onSaveToken,
  onPreview,
  onSendTest,
}: {
  enabled: boolean;
  cadence: BriefingCadence;
  recipient: string;
  phoneNumberId: string;
  tokenSet: boolean;
  lastSentAt: string | null;
  onToggle: (next: boolean) => Promise<void>;
  onSaveCadence: (next: BriefingCadence) => Promise<void>;
  onSaveDelivery: (recipientDraft: string, phoneNumberIdDraft: string) => Promise<void>;
  onSaveToken: (update: BriefingSettingsUpdate) => Promise<void>;
  onPreview: () => Promise<BriefingPreview>;
  onSendTest: () => Promise<void>;
}) {
  const [togglePending, setTogglePending] = useState<boolean | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const [cadencePending, setCadencePending] = useState<BriefingCadence | null>(null);
  const [cadenceError, setCadenceError] = useState<string | null>(null);

  const [recipientDraft, setRecipientDraft] = useState(recipient);
  const [phoneIdDraft, setPhoneIdDraft] = useState(phoneNumberId);
  const [deliveryBusy, setDeliveryBusy] = useState(false);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);

  const [tokenDraft, setTokenDraft] = useState('');
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);

  // Preview and test-send share ONE in-flight slot — a single briefing
  // action at a time; both buttons disable while either is running.
  const [actionBusy, setActionBusy] = useState<'preview' | 'send' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);

  // Saved values can change under the drafts (save from elsewhere, or a
  // danger-zone wipe resetting them) — resync, same as the AI model draft.
  useEffect(() => {
    setRecipientDraft(recipient);
  }, [recipient]);
  useEffect(() => {
    setPhoneIdDraft(phoneNumberId);
  }, [phoneNumberId]);

  const activeEnabled = togglePending ?? enabled;
  const activeCadence = cadencePending ?? cadence;
  const anyBusy =
    togglePending !== null ||
    cadencePending !== null ||
    deliveryBusy ||
    tokenBusy ||
    actionBusy !== null;

  // null = blank draft with nothing stored, i.e. nothing to save.
  const tokenUpdate = buildTokenUpdate(tokenDraft, tokenSet);
  const dirty = deliveryDirty(
    { recipient: recipientDraft, phoneNumberId: phoneIdDraft },
    { recipient, phoneNumberId },
  );
  // Eligibility comes from CURRENT SAVED settings only — unsaved edits in the
  // fields above don't count until saved. The server re-validates on send.
  const canSend = canSendTestBriefing({
    briefingsEnabled: enabled,
    briefingWhatsappRecipient: recipient,
    briefingWhatsappPhoneNumberId: phoneNumberId,
    briefingWhatsappTokenSet: tokenSet,
  });
  const lastSentLabel = lastBriefingLabel(lastSentAt);

  async function handleToggle(next: boolean) {
    if (next === enabled || anyBusy) return;
    setTogglePending(next);
    setToggleError(null);
    try {
      await onToggle(next);
    } catch (e) {
      setToggleError(e instanceof Error ? e.message : 'Could not save. Try again.');
    } finally {
      setTogglePending(null);
    }
  }

  async function handleCadenceChange(next: BriefingCadence) {
    if (next === cadence || anyBusy) return;
    setCadencePending(next);
    setCadenceError(null);
    try {
      await onSaveCadence(next);
    } catch (e) {
      setCadenceError(e instanceof Error ? e.message : 'Could not save. Try again.');
    } finally {
      setCadencePending(null);
    }
  }

  async function handleSaveDelivery() {
    setDeliveryBusy(true);
    setDeliveryError(null);
    try {
      await onSaveDelivery(recipientDraft, phoneIdDraft);
    } catch (e) {
      setDeliveryError(e instanceof Error ? e.message : 'Could not save. Try again.');
    } finally {
      setDeliveryBusy(false);
    }
  }

  async function handleSaveToken() {
    if (!tokenUpdate) return;
    setTokenBusy(true);
    setTokenError(null);
    try {
      await onSaveToken(tokenUpdate);
      setTokenDraft('');
    } catch (e) {
      setTokenError(e instanceof Error ? e.message : 'Could not save the token. Try again.');
    } finally {
      setTokenBusy(false);
    }
  }

  async function handlePreview() {
    setActionBusy('preview');
    setActionError(null);
    try {
      const res = await onPreview();
      setPreviewText(res.text);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not build the preview. Try again.');
    } finally {
      setActionBusy(null);
    }
  }

  async function handleSendTest() {
    setActionBusy('send');
    setActionError(null);
    try {
      await onSendTest();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not send the briefing. Try again.');
    } finally {
      setActionBusy(null);
    }
  }

  return (
    <Card title="Briefings">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
          <MessageCircle className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 space-y-4">
          <p className="text-sm text-muted">
            A plain-text digest of your last seven days of transactions, the next seven days of
            forecast projections, and anything waiting for your review — delivered to WhatsApp on
            the cadence you choose.
          </p>

          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium">Enable briefings</p>
            <Toggle
              checked={activeEnabled}
              onChange={(next) => void handleToggle(next)}
              label="Enable briefings"
              disabled={anyBusy}
            />
          </div>
          {togglePending !== null && (
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <Spinner className="size-3.5" /> Saving…
            </p>
          )}
          <InlineError message={toggleError} />

          {activeEnabled && (
            <div>
              <div className={anyBusy ? 'pointer-events-none opacity-60' : ''}>
                <SegmentedControl
                  ariaLabel="Briefing cadence"
                  options={BRIEFING_CADENCE_OPTIONS}
                  value={activeCadence}
                  onChange={(v) => void handleCadenceChange(v)}
                />
              </div>
              {cadencePending !== null && (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
                  <Spinner className="size-3.5" /> Saving…
                </p>
              )}
              <InlineError message={cadenceError} />
            </div>
          )}

          {/*
            Delivery config shows while briefings are on OR any credential/
            value is stored — a stored token must be removable without
            re-enabling briefings first (same principle as the AI key).
          */}
          {(activeEnabled || recipient !== '' || phoneNumberId !== '' || tokenSet) && (
            <div className="space-y-4 border-t border-border pt-4">
              <p className="rounded-xl border border-border bg-canvas px-3 py-2.5 text-xs text-muted">
                Delivery uses your own Meta WhatsApp Business Cloud API app — see the{' '}
                <a
                  href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-accent hover:underline"
                >
                  getting-started guide
                </a>
                . A Meta app in development mode can only message its registered test numbers.
                Briefings are generated from your data on your server and sent directly from it to
                Meta — no other party is involved.
              </p>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="WhatsApp recipient" hint="Country code + number, digits only.">
                  <Input
                    inputMode="numeric"
                    autoComplete="off"
                    value={recipientDraft}
                    disabled={anyBusy}
                    onChange={(e) => setRecipientDraft(digitsOnly(e.target.value))}
                    placeholder="15551234567"
                  />
                </Field>
                <Field label="Phone number ID">
                  <Input
                    inputMode="numeric"
                    autoComplete="off"
                    value={phoneIdDraft}
                    disabled={anyBusy}
                    onChange={(e) => setPhoneIdDraft(digitsOnly(e.target.value))}
                  />
                </Field>
              </div>
              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={anyBusy || !dirty}
                  loading={deliveryBusy}
                  onClick={() => void handleSaveDelivery()}
                >
                  Save delivery settings
                </Button>
              </div>
              <InlineError message={deliveryError} />

              <div>
                <Field label="Cloud API access token">
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      type="password"
                      autoComplete="off"
                      value={tokenDraft}
                      disabled={anyBusy}
                      onChange={(e) => setTokenDraft(e.target.value)}
                      placeholder="EAA…"
                      className="max-w-xs"
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={anyBusy || tokenUpdate === null}
                      loading={tokenBusy}
                      onClick={() => void handleSaveToken()}
                    >
                      Save token
                    </Button>
                  </div>
                  <p className="mt-1.5 text-xs text-muted">
                    {tokenSet
                      ? 'Stored — enter a new token to replace it, or clear to remove.'
                      : 'Write-only — once saved, the token itself is never shown again.'}
                  </p>
                </Field>
                <InlineError message={tokenError} />
              </div>
            </div>
          )}

          <div className="space-y-3 border-t border-border pt-4">
            {/* Preview needs ZERO WhatsApp config — it only renders the text. */}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={anyBusy}
                loading={actionBusy === 'preview'}
                onClick={() => void handlePreview()}
              >
                Preview briefing
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={anyBusy || !canSend}
                loading={actionBusy === 'send'}
                onClick={() => void handleSendTest()}
              >
                Send test briefing
              </Button>
            </div>
            <InlineError message={actionError} />
            {previewText !== null && (
              <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl border border-border bg-canvas px-3 py-2.5 font-mono text-xs">
                {previewText}
              </pre>
            )}
            {lastSentLabel && <p className="text-xs text-muted">{lastSentLabel}</p>}
          </div>
        </div>
      </div>
    </Card>
  );
}

function MailInFeedSection({
  enabled,
  allowedSenders,
  onToggle,
  onAddSender,
  onRemoveSender,
}: {
  enabled: boolean;
  allowedSenders: string[];
  onToggle: (next: boolean) => Promise<void>;
  onAddSender: (raw: string) => Promise<void>;
  onRemoveSender: (entry: string) => Promise<void>;
}) {
  const [togglePending, setTogglePending] = useState<boolean | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const [entryDraft, setEntryDraft] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [removingEntry, setRemovingEntry] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const activeEnabled = togglePending ?? enabled;
  // Add and remove rewrite the same list — one allowlist write (or toggle
  // save) at a time, same discipline as the Briefings section above.
  const anyBusy = togglePending !== null || addBusy || removingEntry !== null;

  async function handleToggle(next: boolean) {
    if (next === enabled || anyBusy) return;
    setTogglePending(next);
    setToggleError(null);
    try {
      await onToggle(next);
    } catch (e) {
      setToggleError(e instanceof Error ? e.message : 'Could not save. Try again.');
    } finally {
      setTogglePending(null);
    }
  }

  async function handleAdd() {
    const validationError = senderEntryError(entryDraft, allowedSenders);
    if (validationError) {
      setAddError(validationError);
      return;
    }
    setAddBusy(true);
    setAddError(null);
    try {
      await onAddSender(entryDraft);
      setEntryDraft('');
    } catch (e) {
      setAddError(e instanceof Error ? e.message : 'Could not add that sender. Try again.');
    } finally {
      setAddBusy(false);
    }
  }

  async function handleRemove(entry: string) {
    setRemovingEntry(entry);
    setRemoveError(null);
    try {
      await onRemoveSender(entry);
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : 'Could not remove that sender. Try again.');
    } finally {
      setRemovingEntry(null);
    }
  }

  return (
    <Card title="Mail-in feed">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Mail className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 space-y-4">
          <p className="text-sm text-muted">
            Bank alerts, e-receipts, and statements emailed to an address you control become
            proposed transactions here. Only allow-listed senders are accepted, nothing is imported
            without your review, and inbound email never triggers AI.
          </p>

          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium">Enable the mail-in feed</p>
            <Toggle
              checked={activeEnabled}
              onChange={(next) => void handleToggle(next)}
              label="Enable the mail-in feed"
              disabled={anyBusy}
            />
          </div>
          {togglePending !== null && (
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <Spinner className="size-3.5" /> Saving…
            </p>
          )}
          <InlineError message={toggleError} />

          {/*
            Allowlist shows while the feed is on OR entries are stored — a
            saved allowlist stays editable without re-enabling the feed first
            (same principle as the Briefings delivery block above).
          */}
          {(activeEnabled || allowedSenders.length > 0) && (
            <div className="space-y-4 border-t border-border pt-4">
              <p className="rounded-xl border border-border bg-canvas px-3 py-2.5 text-xs text-muted">
                Ledgerly never connects to a mailbox. Routing happens in your own Cloudflare
                dashboard: under Email Routing, route an address to your Ledgerly Worker, then
                allow the senders you trust below — see the{' '}
                <a
                  href="https://github.com/chennurivarun/ledgerly/blob/main/docs/EMAIL-FEED.md"
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-accent hover:underline"
                >
                  setup guide
                </a>
                .
              </p>

              {showEmptyAllowlistWarning(activeEnabled, allowedSenders) && (
                <p className="rounded-lg bg-caution-soft px-3 py-2 text-xs font-medium text-caution">
                  The feed is on but the allowlist is empty — no email will be accepted until you
                  add a sender.
                </p>
              )}

              {allowedSenders.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {allowedSenders.map((entry) => (
                    <span
                      key={entry}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-canvas py-1.5 pl-3 pr-1.5 text-sm"
                    >
                      {entry}
                      <button
                        type="button"
                        aria-label={`Remove ${entry} from the allowlist`}
                        disabled={anyBusy}
                        onClick={() => void handleRemove(entry)}
                        // Padding + negative margin grows the tap target to
                        // ~44px without growing the chip (ManagedListSection).
                        className="-m-2.5 flex size-11 items-center justify-center rounded-full p-2.5 text-muted hover:bg-danger-soft hover:text-danger disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                      >
                        {removingEntry === entry ? (
                          <Spinner className="size-3.5" />
                        ) : (
                          <X className="size-3.5" aria-hidden />
                        )}
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <InlineError message={removeError} />

              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleAdd();
                }}
              >
                <Field label="Add an allowed sender" hint="An exact address, or a whole domain starting with @.">
                  <Input
                    value={entryDraft}
                    disabled={anyBusy}
                    onChange={(e) => {
                      setEntryDraft(e.target.value);
                      if (addError) setAddError(null);
                    }}
                    placeholder="alerts@bank.com or @bank.com"
                    aria-label="New allowed sender"
                  />
                </Field>
                <div className="flex items-start pt-7">
                  <Button type="submit" variant="ghost" loading={addBusy} disabled={anyBusy}>
                    Add
                  </Button>
                </div>
              </form>
              <InlineError message={addError} />
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function SetupSection({ onRerun }: { onRerun: () => Promise<void> }) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRerun() {
    setRunning(true);
    setError(null);
    try {
      await onRerun();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start setup. Try again.');
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card title="Setup">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
            <RotateCcw className="size-5" aria-hidden />
          </span>
          <p className="text-sm text-muted">Reopens the first-run setup wizard.</p>
        </div>
        <Button variant="ghost" size="sm" loading={running} onClick={() => void handleRerun()}>
          Run setup again
        </Button>
      </div>
      <InlineError message={error} />
    </Card>
  );
}

function NetWorthSection({
  assetsTotal,
  liabilitiesTotal,
  configured,
  onSave,
}: {
  assetsTotal: number;
  liabilitiesTotal: number;
  configured: boolean;
  onSave: (assets: number, liabilities: number) => Promise<void>;
}) {
  const [assetsDraft, setAssetsDraft] = useState(String(assetsTotal));
  const [liabilitiesDraft, setLiabilitiesDraft] = useState(String(liabilitiesTotal));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // This section stays mounted across a danger-zone wipe (spec §16.5), which
  // resets assetsTotal/liabilitiesTotal to 0 outside of user input — resync
  // the drafts so the form actually returns to the empty state instead of
  // showing stale pre-wipe numbers.
  useEffect(() => {
    setAssetsDraft(String(assetsTotal));
    setLiabilitiesDraft(String(liabilitiesTotal));
  }, [assetsTotal, liabilitiesTotal]);

  const previewAssets = Number(assetsDraft);
  const previewLiabilities = Number(liabilitiesDraft);
  const validPreview = Number.isFinite(previewAssets) && Number.isFinite(previewLiabilities);
  const preview = validPreview ? previewAssets - previewLiabilities : null;

  async function handleSave() {
    if (!Number.isFinite(previewAssets) || previewAssets < 0) {
      setError(`Enter total assets as a number of ${fmtCurrency(0)} or more.`);
      return;
    }
    if (!Number.isFinite(previewLiabilities) || previewLiabilities < 0) {
      setError(`Enter total liabilities as a number of ${fmtCurrency(0)} or more.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(Math.round(previewAssets * 100) / 100, Math.round(previewLiabilities * 100) / 100);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Net worth">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Wallet className="size-5" aria-hidden />
        </span>
        <p className="text-sm text-muted">
          Net worth is your total assets minus your total liabilities — it is not calculated from
          monthly income minus expenses. Enter your own totals below.
        </p>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Total assets">
          <Input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={assetsDraft}
            onChange={(e) => setAssetsDraft(e.target.value)}
          />
        </Field>
        <Field label="Total liabilities">
          <Input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={liabilitiesDraft}
            onChange={(e) => setLiabilitiesDraft(e.target.value)}
          />
        </Field>
      </div>

      <div className="mt-4 rounded-xl border border-border bg-canvas px-4 py-3">
        <p className="text-xs font-medium text-muted">Live preview</p>
        <p className="mt-1 text-lg font-semibold">{preview !== null ? fmtCurrency(preview) : '—'}</p>
      </div>

      {configured && (
        <p className="mt-2 text-xs text-muted">Currently saved net worth is configured.</p>
      )}

      <InlineError message={error} />

      <div className="mt-4 flex justify-end">
        <Button onClick={() => void handleSave()} loading={saving}>
          Save net worth
        </Button>
      </div>
    </Card>
  );
}

function DetectionSection({
  ignoredCount,
  onRestore,
}: {
  ignoredCount: number;
  onRestore: () => Promise<void>;
}) {
  const [restoring, setRestoring] = useState(false);

  return (
    <Card title="Automatic detection">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Radar className="size-5" aria-hidden />
        </span>
        <p className="text-sm text-muted">
          Ledgerly looks for expense transactions from the same merchant repeating on a steady
          weekly, biweekly, monthly, quarterly, or annual schedule with a stable amount. When it
          finds one, it shows a suggestion on Recurring or Subscriptions — it never creates a
          confirmed entry automatically. Choosing Keep confirms it; choosing Ignore hides it.
        </p>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-canvas px-4 py-3">
        <p className="text-sm">
          <span className="font-semibold">{ignoredCount}</span> ignored suggestion{ignoredCount === 1 ? '' : 's'}
        </p>
        <Button
          variant="ghost"
          size="sm"
          disabled={ignoredCount === 0}
          loading={restoring}
          onClick={async () => {
            setRestoring(true);
            try {
              await onRestore();
            } finally {
              setRestoring(false);
            }
          }}
        >
          Restore ignored suggestions
        </Button>
      </div>
    </Card>
  );
}

function DangerZone({ onWipe, onSuccess }: { onWipe: () => Promise<void>; onSuccess: () => void }) {
  const [open, setOpen] = useState(false);

  return (
    <Card title="Danger zone">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-danger-soft text-danger">
          <AlertTriangle className="size-5" aria-hidden />
        </span>
        <div className="flex-1">
          <p className="text-sm text-muted">
            Permanently erase every database record and stored file copy in Ledgerly. Files already
            in your connected Google Drive folder are not affected.
          </p>
          <div className="mt-3">
            <Button variant="danger" onClick={() => setOpen(true)}>
              Erase all Ledgerly data
            </Button>
          </div>
        </div>
      </div>

      {open && (
        <WipeDataModal
          onClose={() => setOpen(false)}
          onWipe={async () => {
            await onWipe();
            onSuccess();
          }}
        />
      )}
    </Card>
  );
}
