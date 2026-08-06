// Copy helpers for the correction-learning suggestions on the Rules page
// (vision phase-2 item 1). Kept out of the component so the exact wording —
// including the real evidence count and its pluralization — is pinned by
// tests rather than living inline in JSX.
import type { RuleSuggestion } from '../../../shared/types';

/**
 * Honest evidence line for a suggestion card: the real correction count, no
 * embellishment. Singular/plural handled (the backend threshold means 1 never
 * appears in practice, but the copy must not lie if it ever does).
 */
export function suggestionEvidence(
  s: Pick<RuleSuggestion, 'merchant' | 'category' | 'evidenceCount'>,
): string {
  return `You filed '${s.merchant}' under ${s.category} ${s.evidenceCount} ${
    s.evidenceCount === 1 ? 'time' : 'times'
  }.`;
}

/**
 * Success toast after accepting a suggestion. Says "future" because rules
 * only apply to future imports — historical rows are never rewritten.
 */
export function ruleCreatedMessage(s: Pick<RuleSuggestion, 'merchant' | 'category'>): string {
  return `Rule created — future '${s.merchant}' entries will be filed under ${s.category}.`;
}
