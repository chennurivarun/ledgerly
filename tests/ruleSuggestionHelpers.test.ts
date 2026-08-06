import { describe, expect, it } from 'vitest';
import {
  ruleCreatedMessage,
  suggestionEvidence,
} from '../src/components/manage/ruleSuggestionHelpers';

describe('suggestionEvidence', () => {
  it('pins the exact copy with a plural count', () => {
    expect(
      suggestionEvidence({ merchant: 'Netflix', category: 'Subscriptions', evidenceCount: 3 }),
    ).toBe("You filed 'Netflix' under Subscriptions 3 times.");
  });

  it('uses the threshold minimum count as-is (never rounds or embellishes)', () => {
    expect(
      suggestionEvidence({ merchant: 'Shell', category: 'Transport', evidenceCount: 2 }),
    ).toBe("You filed 'Shell' under Transport 2 times.");
  });

  it('handles the singular correctly even though the threshold prevents it in practice', () => {
    expect(
      suggestionEvidence({ merchant: 'Shell', category: 'Transport', evidenceCount: 1 }),
    ).toBe("You filed 'Shell' under Transport 1 time.");
  });

  it('keeps the merchant verbatim, including apostrophes', () => {
    expect(
      suggestionEvidence({ merchant: "Trader Joe's", category: 'Groceries', evidenceCount: 4 }),
    ).toBe("You filed 'Trader Joe's' under Groceries 4 times.");
  });
});

describe('ruleCreatedMessage', () => {
  it('pins the exact future-only toast copy', () => {
    expect(ruleCreatedMessage({ merchant: 'Netflix', category: 'Subscriptions' })).toBe(
      "Rule created — future 'Netflix' entries will be filed under Subscriptions.",
    );
  });

  it('keeps the merchant verbatim', () => {
    expect(ruleCreatedMessage({ merchant: "Trader Joe's", category: 'Groceries' })).toBe(
      "Rule created — future 'Trader Joe's' entries will be filed under Groceries.",
    );
  });
});
