// "Getting to know you" (sprint 14): one sparse, high-value question at a
// time — "who is this merchant?" — whose answer permanently teaches the app
// (a stored profile + a real rule, optionally recategorizing the merchant's
// existing 'Needs review' rows). Rendered only while questions exist; the
// card vanishes entirely once the queue drains.
//
// The inner form is keyed by question id, so advancing the queue remounts a
// fresh form (house lesson from the sprint-4/8 review modals) — no draft
// state ever bleeds from one merchant to the next.
import { useMemo, useState } from 'react';
import type { MerchantKind, MerchantQuestion } from '../../../shared/types';
import { useStore } from '../../store';
import { Button, Card, Field, InlineError, Input, Select, SegmentedControl } from '../ui';
import {
  answeredMessage,
  applyExistingLabel,
  countNeedsReview,
  questionPrompt,
} from './questionHelpers';

const KIND_OPTIONS: { value: MerchantKind; label: string }[] = [
  { value: 'person', label: 'Person' },
  { value: 'business', label: 'Business' },
];

export function MerchantQuestionCard() {
  const questions = useStore((s) => s.merchantQuestions);
  if (questions.length === 0) return null;
  const question = questions[0]; // server-ranked; the queue is a drip
  return (
    <Card
      title="Getting to know you"
      action={<span className="text-xs text-muted">1 of {questions.length}</span>}
    >
      <QuestionForm key={question.id} question={question} />
    </Card>
  );
}

function QuestionForm({ question }: { question: MerchantQuestion }) {
  const settings = useStore((s) => s.settings);
  const transactions = useStore((s) => s.transactions);
  const answerMerchantQuestion = useStore((s) => s.answerMerchantQuestion);
  const dismissMerchantQuestion = useStore((s) => s.dismissMerchantQuestion);
  const toast = useStore((s) => s.toast);

  // suggestedKind is a heuristic HINT for this default only — the user's
  // toggle is what actually gets stored.
  const [kind, setKind] = useState<MerchantKind>(question.suggestedKind ?? 'business');
  const [label, setLabel] = useState('');
  const [category, setCategory] = useState('');
  const [applyExisting, setApplyExisting] = useState(true);
  const [busy, setBusy] = useState<'answer' | 'skip' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const needsReviewCount = useMemo(
    () => countNeedsReview(transactions, question.id),
    [transactions, question.id],
  );
  const noCategories = settings.categories.length === 0;

  async function handleAnswer() {
    if (!category) {
      setError('Choose a category.');
      return;
    }
    setBusy('answer');
    setError(null);
    const finalLabel = label.trim() || question.merchant;
    try {
      await answerMerchantQuestion(question, {
        merchant: question.merchant,
        kind,
        label: finalLabel,
        category,
        applyToExisting: applyExisting && needsReviewCount > 0,
      });
      toast('success', answeredMessage(finalLabel, category));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that answer.');
    } finally {
      setBusy(null);
    }
  }

  async function handleSkip() {
    setBusy('skip');
    setError(null);
    try {
      await dismissMerchantQuestion(question);
      // No toast — the next question appearing (or the card vanishing) is
      // the whole story, like S5's suggestion dismiss.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not skip that question.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm">{questionPrompt(question)}</p>

      <InlineError message={error} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <span className="mb-1.5 block text-sm font-medium">Who is this?</span>
          <SegmentedControl<MerchantKind>
            ariaLabel="Person or business"
            options={KIND_OPTIONS}
            value={kind}
            onChange={setKind}
          />
        </div>
        <Field label="Name or label (optional)">
          <Input
            value={label}
            disabled={busy !== null}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={question.merchant}
            maxLength={80}
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Category">
          {noCategories ? (
            <p className="text-xs text-muted">Add a category in Settings first.</p>
          ) : (
            <Select
              value={category}
              disabled={busy !== null}
              onChange={(e) => {
                setCategory(e.target.value);
                if (error) setError(null);
              }}
            >
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
        </Field>
      </div>

      {/* The payoff moment — only offered when there is actually something
          to recategorize, checked by default. */}
      {needsReviewCount > 0 && (
        <label className="flex min-h-11 items-center gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={applyExisting}
            disabled={busy !== null}
            onChange={(e) => setApplyExisting(e.target.checked)}
            className="size-5 shrink-0 rounded border-border accent-accent"
          />
          {applyExistingLabel(needsReviewCount)}
        </label>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => void handleAnswer()}
          disabled={busy !== null || noCategories}
          loading={busy === 'answer'}
        >
          Answer
        </Button>
        <Button
          variant="ghost"
          onClick={() => void handleSkip()}
          disabled={busy !== null}
          loading={busy === 'skip'}
        >
          Skip
        </Button>
      </div>
    </div>
  );
}
