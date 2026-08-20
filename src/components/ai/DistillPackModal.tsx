// Distillation (sprint 19): turn ONE already-confirmed AI statement read into
// a reusable local pack — layout knowledge only, never statement content (see
// shared/packs/distill.ts's header). This modal collects the identity a
// distiller cannot know on its own (name/country/currency), re-downloads the
// same PDF and re-extracts its text (the same seam runAutoRead uses, textOnly
// so a scanned page bails immediately instead of paying for a canvas render
// this flow could never use), builds anchors from the statement's own
// CONFIRMED rows, and hands all three to the real distiller. The engine is
// the oracle throughout: a draft that does not fully verify against the very
// statement it came from is refused, never shown as if it worked.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { distillStatementPack, renderPackModule, type DistillAnchor, type DistillIdentity, type DistillResult } from '../../../shared/packs/distill';
import { allStatementPacks } from '../../../shared/packs/registry';
import type { DocumentMeta, StatementExtraction } from '../../../shared/types';
import { useStore } from '../../store';
import { Button, Field, InlineError, Input, Modal, Spinner } from '../ui';
import { ClientReadCancelled, createCancelToken, extractStatementPages, type CancelToken } from './clientPages';

/** Lowercase, spaces/punctuation collapsed to single hyphens, no leading or
 * trailing hyphen — the slug half of a derived pack id. */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** `<country>.<slug>.statement`, suffixed -2, -3… on collision with anything
 * already in `taken` (bundled packs + this user's other local ones). Purely
 * a client-side courtesy — the worker is the authority on uniqueness at
 * save time. */
function deriveId(country: string, name: string, taken: ReadonlySet<string>): string {
  const base = slugify(name) || 'pack';
  let suffix = 1;
  let id = `${country}.${base}.statement`;
  while (taken.has(id)) {
    suffix += 1;
    id = `${country}.${base}-${suffix}.statement`;
  }
  return id;
}

/** The distiller's ground truth: date + amount + direction off every row the
 * user actually CONFIRMED (never a still-proposed one — an unreviewed
 * suggestion isn't ground truth). Merchant text is deliberately excluded,
 * same reasoning as DistillAnchor's own doc comment. A confirmed row with a
 * null field (shouldn't happen — confirm requires every field present) is
 * skipped rather than trusted. */
function confirmedAnchors(statement: StatementExtraction): DistillAnchor[] {
  const anchors: DistillAnchor[] = [];
  for (const row of statement.rows) {
    if (row.status !== 'confirmed') continue;
    const date = row.date.value;
    const amount = row.amount.value;
    const type = row.type.value;
    if (date === null || amount === null || type === null) continue;
    anchors.push({ date, amount, type });
  }
  return anchors;
}

type Phase =
  | { kind: 'form' }
  | { kind: 'working'; label: string }
  | { kind: 'result'; result: DistillResult };

export function DistillPackModal({
  doc,
  statement,
  onClose,
}: {
  doc: DocumentMeta;
  statement: StatementExtraction;
  onClose: () => void;
}) {
  const settings = useStore((s) => s.settings);
  const updatePreferences = useStore((s) => s.updatePreferences);
  const toast = useStore((s) => s.toast);

  const [name, setName] = useState('');
  const [country, setCountry] = useState('');
  const [currency, setCurrency] = useState(settings.currency);
  const [formError, setFormError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The load-bearing human step (S19 review): the distiller enumerates every
  // literal word that survived generalization into the pack's regexes, and a
  // machine cannot tell a layout label from a person's name — so the user
  // must confirm the survivors before the pack can be saved or shared.
  const [reviewablesConfirmed, setReviewablesConfirmed] = useState(false);

  const takenIds = useMemo(
    () => new Set(allStatementPacks(settings.localStatementPacks).map((p) => p.id)),
    [settings.localStatementPacks],
  );
  const countryValid = /^[a-z]{2}$/.test(country);
  const nameValid = name.trim() !== '';
  const previewId = countryValid && nameValid ? deriveId(country, name, takenIds) : null;

  // Same identity-stability requirement as StatementReviewModal's
  // guardedClose: the frozen Modal re-runs its focus-trap effect whenever the
  // `onClose` it receives changes identity.
  const busyRef = useRef(false);
  busyRef.current = phase.kind === 'working' || saveBusy;
  const guardedClose = useCallback(() => {
    if (!busyRef.current) onClose();
  }, [onClose]);

  // The one cancellation channel for the in-flight download/extract — never
  // needs a worker abort (distillation takes no claim), just needs the
  // extraction loop to notice and unwind. Flipped on unmount so navigating
  // away mid-distill doesn't keep spending browser CPU on a modal nobody can
  // see any more.
  const cancelTokenRef = useRef<CancelToken | null>(null);
  useEffect(
    () => () => {
      if (cancelTokenRef.current) cancelTokenRef.current.cancelled = true;
    },
    [],
  );

  async function handleDistill() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError('Enter a name for this pack.');
      return;
    }
    if (!countryValid) {
      setFormError('Country must be a 2-letter code, e.g. "in".');
      return;
    }
    const trimmedCurrency = currency.trim().toUpperCase();
    if (!trimmedCurrency) {
      setFormError('Enter a currency code.');
      return;
    }

    setFormError(null);
    const token = createCancelToken();
    cancelTokenRef.current = token;
    setPhase({ kind: 'working', label: 'Preparing…' });
    try {
      const res = await fetch(api.documentDownloadUrl(doc.id));
      if (!res.ok) throw new Error('Could not download the statement from the vault.');
      const bytes = await res.arrayBuffer();
      if (token.cancelled) throw new ClientReadCancelled();

      const extracted = await extractStatementPages(
        bytes,
        (label) => setPhase({ kind: 'working', label }),
        token,
        doc.id,
        null,
        { textOnly: true },
      );
      if (extracted.bailedAtPage !== null) {
        throw new Error(`page ${extracted.bailedAtPage} has no text layer — packs need text`);
      }
      if (token.cancelled) throw new ClientReadCancelled();

      const identity: DistillIdentity = {
        id: deriveId(country, trimmedName, takenIds),
        name: trimmedName,
        country,
        currency: trimmedCurrency,
      };
      const anchors = confirmedAnchors(statement);
      let result: DistillResult;
      try {
        result = distillStatementPack(extracted.texts, anchors, identity);
      } catch {
        // The contract says this never throws — defense-in-depth only, the
        // same posture runPackRead takes around the rest of the engine.
        result = { ok: false, reason: 'Could not distill this statement — try again.' };
      }
      setReviewablesConfirmed(false);
      setPhase({ kind: 'result', result });
    } catch (e) {
      if (e instanceof ClientReadCancelled) {
        setPhase({ kind: 'form' });
        return;
      }
      setFormError(e instanceof Error ? e.message : 'Could not distill this statement.');
      setPhase({ kind: 'form' });
    }
  }

  async function handleSave(result: Extract<DistillResult, { ok: true }>) {
    setSaveBusy(true);
    setSaveError(null);
    try {
      // Read fresh at dispatch time: a full-replacement save must not drop a
      // concurrent local-pack change made elsewhere (same rule as every
      // other managed list in Settings).
      const current = useStore.getState().settings.localStatementPacks;
      await updatePreferences({ localStatementPacks: [...current, result.pack] });
      toast('success', 'Your statements from this bank now read instantly — no AI.');
      onClose();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Could not save this pack.');
    } finally {
      setSaveBusy(false);
    }
  }

  function handleDownload(result: Extract<DistillResult, { ok: true }>) {
    let code: string;
    try {
      code = renderPackModule(result.pack);
    } catch {
      setSaveError('Could not build the pack file — try again.');
      return;
    }
    const blob = new Blob([code], { type: 'text/typescript' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${result.pack.id}.ts`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const working = phase.kind === 'working';

  return (
    <Modal
      title="Create a statement pack"
      onClose={guardedClose}
      footer={
        phase.kind === 'result' ? (
          <div className="flex justify-end">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={working}>
              Cancel
            </Button>
            <Button onClick={() => void handleDistill()} disabled={working} loading={working}>
              Distill this statement
            </Button>
          </div>
        )
      }
    >
      <div className="space-y-4">
        {phase.kind !== 'result' && (
          <>
            <p className="text-sm text-muted">
              Turn this already-reviewed statement into a reusable pack: future statements from the
              same bank read instantly, offline, with no AI at all.
            </p>
            <Field label="Name">
              <Input
                value={name}
                disabled={working}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Bank — Savings"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Country" hint="ISO 3166-1 alpha-2, lowercase">
                <Input
                  value={country}
                  disabled={working}
                  maxLength={2}
                  onChange={(e) => setCountry(e.target.value.trim().toLowerCase())}
                  placeholder="in"
                />
              </Field>
              <Field label="Currency">
                <Input
                  value={currency}
                  disabled={working}
                  maxLength={3}
                  onChange={(e) => setCurrency(e.target.value.trim().toUpperCase())}
                  placeholder="INR"
                />
              </Field>
            </div>
            <Field label="Pack ID" hint="Derived from the name and country — read-only.">
              <p className="rounded-xl border border-border bg-canvas px-3 py-2.5 font-mono text-sm text-muted">
                {previewId ?? '—'}
              </p>
            </Field>
            {working && (
              <p className="flex items-center gap-2 text-sm text-muted">
                <Spinner className="size-4" /> {phase.label}
              </p>
            )}
            <InlineError message={formError} />
          </>
        )}

        {phase.kind === 'result' &&
          (() => {
            const result = phase.result;
            const needsConfirmation = result.ok && result.reviewables.length > 0;
            const blocked = needsConfirmation && !reviewablesConfirmed;
            return result.ok ? (
              <div className="space-y-4">
                <p role="status" className="rounded-lg bg-info-soft px-3 py-2 text-sm text-info">
                  Verified against this statement: {result.proof.rows} rows read,{' '}
                  {result.proof.anchorsMatched}/{result.proof.anchorsTotal} confirmed rows matched.
                </p>
                {needsConfirmation && (
                  <div className="space-y-2 rounded-lg border border-border bg-canvas px-3 py-2.5">
                    <p className="text-sm font-semibold">
                      These words from the statement's layout will ship inside the pack:
                    </p>
                    <p className="font-mono text-sm">
                      {result.reviewables.map((r) => r.literalText).join(' · ')}
                    </p>
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={reviewablesConfirmed}
                        onChange={(e) => setReviewablesConfirmed(e.target.checked)}
                      />
                      <span>
                        None of these is personal information — they are labels the bank prints on
                        every statement.
                      </span>
                    </label>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() => void handleSave(result)}
                    loading={saveBusy}
                    disabled={saveBusy || blocked}
                  >
                    Save to my packs
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => handleDownload(result)}
                    disabled={saveBusy || blocked}
                  >
                    Download pack file
                  </Button>
                </div>
                <p className="text-xs text-muted">
                  Public-domain (CC0) — share it in the Ledgerly packs registry so everyone with this
                  bank benefits.
                </p>
                <InlineError message={saveError} />
              </div>
            ) : (
              <div className="space-y-3">
                <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{result.reason}</p>
                <p className="text-sm text-muted">This layout may not fit the v1 pack format yet.</p>
                <div className="flex justify-end">
                  <Button variant="ghost" onClick={() => setPhase({ kind: 'form' })}>
                    Try again
                  </Button>
                </div>
              </div>
            );
          })()}
      </div>
    </Modal>
  );
}
