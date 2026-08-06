// Rules page (spec §15) — categorization rules + tag management with usage
// counts. Rules apply to future imports only, after duplicate detection;
// historical transactions are never rewritten by a rule automatically.
//
// Rules and Tags are independent settings groups, but within EACH group
// every write (toggle/edit/delete for rules; add/delete for tags) targets
// the same array — two of them in flight together would race (whichever
// response lands last silently reverts the other). Fixed the same way as
// the rest of the app: read useStore.getState() fresh when building a
// payload, and disable every mutation control in a group while any write
// from that group is in flight (rulesBusy / tagsBusy below).
//
// Suggestion accepts (sprint 5) join the rules group one-sidedly: an accept
// appends to the same server-side rules array, so while one is in flight the
// client-built rule writes (toggle/delete — their payload wouldn't include
// the new rule yet) are blocked, and vice versa. Accept-vs-accept is safe —
// the payload is the suggestion's own merchant/category, not client rule
// state, but two accepts' RESPONSES can land out of order and the later
// stale rules list would overwrite the newer one client-side — so accepts
// serialize against each other too. Only dismisses stay per-card.
import { Pencil, Plus, SlidersHorizontal, Tags, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Rule } from '../../shared/types';
import { ConfirmDialog } from '../components/manage/ConfirmDialog';
import { RuleFormModal } from '../components/manage/RuleFormModal';
import { ruleCreatedMessage, suggestionEvidence } from '../components/manage/ruleSuggestionHelpers';
import { TagDeleteModal } from '../components/manage/TagDeleteModal';
import { Toggle } from '../components/manage/Toggle';
import { useStore } from '../store';
import { Button, Card, EmptyState, Field, InlineError, Input } from '../components/ui';

export default function Rules() {
  const rules = useStore((s) => s.rules);
  const tags = useStore((s) => s.tags);
  const transactions = useStore((s) => s.transactions);
  const ruleSuggestions = useStore((s) => s.ruleSuggestions);
  const updatePreferences = useStore((s) => s.updatePreferences);
  const patchTransaction = useStore((s) => s.patchTransaction);
  const acceptRuleSuggestion = useStore((s) => s.acceptRuleSuggestion);
  const dismissRuleSuggestion = useStore((s) => s.dismissRuleSuggestion);
  const toast = useStore((s) => s.toast);

  const [ruleModal, setRuleModal] = useState<'add' | Rule | null>(null);
  const [togglingRuleId, setTogglingRuleId] = useState<string | null>(null);
  const [pendingDeleteRule, setPendingDeleteRule] = useState<Rule | null>(null);
  const [deleteRuleBusy, setDeleteRuleBusy] = useState(false);
  const [deleteRuleError, setDeleteRuleError] = useState<string | null>(null);
  // Per-suggestion in-flight marker: only that card's two buttons disable,
  // the rest of the section stays usable (see header comment for why that
  // is safe for accepts).
  const [suggestionAction, setSuggestionAction] = useState<{
    id: string;
    kind: 'accept' | 'dismiss';
  } | null>(null);
  // Client-built writes to the rules array (payload derived from client
  // state) — the original rules-group flag.
  const ruleListWriteBusy = togglingRuleId !== null || deleteRuleBusy;
  // What the rule-list controls key off: also true while an accept is in
  // flight, since the accept appends to the same server-side array.
  const rulesBusy = ruleListWriteBusy || suggestionAction?.kind === 'accept';

  const [tagDraft, setTagDraft] = useState('');
  const [tagAddError, setTagAddError] = useState<string | null>(null);
  const [tagAdding, setTagAdding] = useState(false);
  const [pendingDeleteTag, setPendingDeleteTag] = useState<string | null>(null);
  const [deleteTagBusy, setDeleteTagBusy] = useState(false);
  const [deleteTagError, setDeleteTagError] = useState<string | null>(null);
  const tagsBusy = tagAdding || deleteTagBusy;

  // Recomputed only when transactions or tags actually change, not on every
  // render — this list is O(tags * transactions) and both can be large.
  const usageCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tag of tags) counts.set(tag.name, 0);
    for (const t of transactions) {
      for (const tagName of t.tags) {
        counts.set(tagName, (counts.get(tagName) ?? 0) + 1);
      }
    }
    return counts;
  }, [tags, transactions]);
  const usageCount = (tagName: string) => usageCounts.get(tagName) ?? 0;

  async function handleSaveRule(rule: Rule) {
    const current = useStore.getState().rules;
    const exists = current.some((r) => r.id === rule.id);
    const next = exists ? current.map((r) => (r.id === rule.id ? rule : r)) : [...current, rule];
    await updatePreferences({ rules: next });
    toast('success', exists ? 'Rule updated.' : 'Rule created.');
  }

  async function handleToggleRule(rule: Rule) {
    setTogglingRuleId(rule.id);
    try {
      const current = useStore.getState().rules;
      await updatePreferences({
        rules: current.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r)),
      });
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Could not update the rule.');
    } finally {
      setTogglingRuleId(null);
    }
  }

  async function confirmDeleteRule() {
    if (!pendingDeleteRule) return;
    setDeleteRuleBusy(true);
    setDeleteRuleError(null);
    try {
      const current = useStore.getState().rules;
      await updatePreferences({ rules: current.filter((r) => r.id !== pendingDeleteRule.id) });
      toast('success', 'Rule deleted.');
      setPendingDeleteRule(null);
    } catch (e) {
      setDeleteRuleError(e instanceof Error ? e.message : 'Could not delete the rule.');
    } finally {
      setDeleteRuleBusy(false);
    }
  }

  async function handleAcceptSuggestion(id: string) {
    // Fresh read at call time (house rule) — the rendered object could be a
    // stale closure if a background refresh replaced the suggestions array.
    const suggestion = useStore.getState().ruleSuggestions.find((s) => s.id === id);
    if (!suggestion) return;
    setSuggestionAction({ id, kind: 'accept' });
    try {
      await acceptRuleSuggestion(suggestion);
      toast('success', ruleCreatedMessage(suggestion));
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Could not create the rule.');
    } finally {
      setSuggestionAction(null);
    }
  }

  async function handleDismissSuggestion(id: string) {
    const suggestion = useStore.getState().ruleSuggestions.find((s) => s.id === id);
    if (!suggestion) return;
    setSuggestionAction({ id, kind: 'dismiss' });
    try {
      await dismissRuleSuggestion(suggestion);
      // No toast — the card disappearing is the whole story.
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Could not dismiss that suggestion.');
    } finally {
      setSuggestionAction(null);
    }
  }

  async function handleAddTag() {
    const trimmed = tagDraft.trim();
    if (!trimmed) {
      setTagAddError('Enter a tag name.');
      return;
    }
    if (tags.some((t) => t.name.toLowerCase() === trimmed.toLowerCase())) {
      setTagAddError(`"${trimmed}" already exists.`);
      return;
    }
    setTagAdding(true);
    setTagAddError(null);
    try {
      const current = useStore.getState().tags;
      await updatePreferences({ tags: [...current.map((t) => t.name), trimmed] });
      setTagDraft('');
      toast('success', `Tag "${trimmed}" created.`);
    } catch (e) {
      setTagAddError(e instanceof Error ? e.message : 'Could not create that tag.');
    } finally {
      setTagAdding(false);
    }
  }

  async function confirmDeleteTag(stripFromHistory: boolean) {
    if (!pendingDeleteTag) return;
    setDeleteTagBusy(true);
    setDeleteTagError(null);
    try {
      if (stripFromHistory) {
        // Report actual progress rather than an all-or-nothing outcome. If a
        // patch fails partway through, leave the tag definition in place
        // (don't delete it) and keep the dialog open with an inline error —
        // re-clicking Delete tag re-derives `affected` from fresh state, so
        // already-stripped rows are naturally skipped and this is safe to
        // retry until it fully succeeds.
        const affected = useStore.getState().transactions.filter((t) => t.tags.includes(pendingDeleteTag));
        let stripped = 0;
        for (const t of affected) {
          try {
            await patchTransaction(t.id, { tags: t.tags.filter((x) => x !== pendingDeleteTag) });
            stripped += 1;
          } catch {
            // Keep going so the final count reflects every row attempted,
            // not just the first failure.
          }
        }
        if (stripped < affected.length) {
          setDeleteTagError(
            `Removed the tag from ${stripped} of ${affected.length} transactions — the tag still exists on the rest. Try again to finish, or cancel.`,
          );
          return;
        }
      }
      const current = useStore.getState().tags;
      await updatePreferences({ tags: current.map((t) => t.name).filter((n) => n !== pendingDeleteTag) });
      toast('success', `Tag "${pendingDeleteTag}" deleted.`);
      setPendingDeleteTag(null);
    } catch (e) {
      setDeleteTagError(e instanceof Error ? e.message : 'Could not delete that tag.');
    } finally {
      setDeleteTagBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Rendered only when there is something to suggest — no empty-state
          filler; the section vanishes entirely once every suggestion is
          accepted or dismissed. */}
      {ruleSuggestions.length > 0 && (
        <Card title="Suggested from your corrections">
          <ul className="divide-y divide-border">
            {ruleSuggestions.map((suggestion) => {
              const cardBusy = suggestionAction?.id === suggestion.id;
              return (
                <li key={suggestion.id} className="flex flex-wrap items-center gap-3 py-3">
                  <p className="min-w-0 flex-1 text-sm">{suggestionEvidence(suggestion)}</p>
                  <Button
                    size="sm"
                    loading={cardBusy && suggestionAction?.kind === 'accept'}
                    disabled={cardBusy || rulesBusy}
                    onClick={() => void handleAcceptSuggestion(suggestion.id)}
                  >
                    Create rule
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={cardBusy && suggestionAction?.kind === 'dismiss'}
                    disabled={cardBusy}
                    onClick={() => void handleDismissSuggestion(suggestion.id)}
                  >
                    No thanks
                  </Button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Card
        title="Rules"
        action={
          <Button size="sm" onClick={() => setRuleModal('add')} disabled={rulesBusy}>
            <Plus className="size-4" aria-hidden />
            Create rule
          </Button>
        }
      >
        <p className="mb-4 text-sm text-muted">
          Enabled rules apply to future imports, after duplicate detection. They never rewrite
          transactions you already have.
        </p>
        {rules.length === 0 ? (
          <EmptyState
            icon={SlidersHorizontal}
            compact
            title="No rules yet"
            body="Create a rule to automatically categorize or tag future imports that match a condition."
            action={
              <Button onClick={() => setRuleModal('add')} disabled={rulesBusy}>
                Create rule
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {rules.map((rule) => (
              <li key={rule.id} className="flex flex-wrap items-center gap-3 py-3">
                <p className="min-w-0 flex-1 text-sm">
                  <span className="font-semibold">When</span> {rule.whenText}{' '}
                  <span className="font-semibold">then</span> {rule.thenText}
                </p>
                <Toggle
                  checked={rule.enabled}
                  onChange={() => void handleToggleRule(rule)}
                  label={`${rule.enabled ? 'Disable' : 'Enable'} rule`}
                  disabled={rulesBusy}
                />
                <button
                  type="button"
                  aria-label="Edit rule"
                  onClick={() => setRuleModal(rule)}
                  disabled={rulesBusy}
                  className="flex size-9 items-center justify-center rounded-lg text-muted hover:bg-canvas hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  <Pencil className="size-4" aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label="Delete rule"
                  onClick={() => setPendingDeleteRule(rule)}
                  disabled={rulesBusy}
                  className="flex size-9 items-center justify-center rounded-lg text-muted hover:bg-danger-soft hover:text-danger disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  <Trash2 className="size-4" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Tags">
        <div className="flex flex-wrap gap-2">
          {tags.length === 0 && <p className="text-sm text-muted">No tags yet.</p>}
          {tags.map((tag) => (
            <span
              key={tag.name}
              className="inline-flex items-center gap-2 rounded-full border border-border bg-canvas py-1.5 pl-3 pr-1.5 text-sm"
            >
              <Tags className="size-3.5 text-muted" aria-hidden />
              {tag.name}
              <span className="rounded-full bg-surface px-1.5 py-0.5 text-xs text-muted">
                {usageCount(tag.name)}
              </span>
              <button
                type="button"
                aria-label={`Delete tag ${tag.name}`}
                disabled={tagsBusy}
                onClick={() => setPendingDeleteTag(tag.name)}
                // Padding + negative margin grows the tap target to ~44px
                // without growing the chip's visual footprint.
                className="-m-2.5 flex size-11 items-center justify-center rounded-full p-2.5 text-muted hover:bg-danger-soft hover:text-danger disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <Trash2 className="size-3.5" aria-hidden />
              </button>
            </span>
          ))}
        </div>

        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void handleAddTag();
          }}
        >
          <Field label="Create tag">
            <Input
              value={tagDraft}
              disabled={tagsBusy}
              onChange={(e) => {
                setTagDraft(e.target.value);
                if (tagAddError) setTagAddError(null);
              }}
              placeholder="Tag name"
              aria-label="New tag name"
            />
          </Field>
          <div className="flex items-end">
            <Button type="submit" variant="ghost" loading={tagAdding} disabled={tagsBusy}>
              <Plus className="size-4" aria-hidden />
              Add
            </Button>
          </div>
        </form>
        <InlineError message={tagAddError} />
      </Card>

      {ruleModal !== null && (
        <RuleFormModal
          initial={ruleModal === 'add' ? undefined : ruleModal}
          onClose={() => setRuleModal(null)}
          onSave={handleSaveRule}
        />
      )}

      {pendingDeleteRule && (
        <ConfirmDialog
          title="Delete this rule?"
          message={<p>This rule will no longer apply to future imports. This can&apos;t be undone.</p>}
          busy={deleteRuleBusy}
          error={deleteRuleError}
          onConfirm={() => void confirmDeleteRule()}
          onCancel={() => {
            setPendingDeleteRule(null);
            setDeleteRuleError(null);
          }}
        />
      )}

      {pendingDeleteTag && (
        <TagDeleteModal
          name={pendingDeleteTag}
          usageCount={usageCount(pendingDeleteTag)}
          busy={deleteTagBusy}
          error={deleteTagError}
          onConfirm={(strip) => void confirmDeleteTag(strip)}
          onCancel={() => {
            setPendingDeleteTag(null);
            setDeleteTagError(null);
          }}
        />
      )}
    </div>
  );
}
