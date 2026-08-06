// Pure-function checks for correction-learning rule suggestions: grouping,
// threshold, the three exclusions (engine-covered via the REAL applyRules,
// dismissed, deleted category), ordering/cap, and the guarantee that accepted
// suggestions round-trip exactly through the plain-language rule parser.
import { describe, expect, it } from 'vitest';
import { NEEDS_REVIEW, RULE_SUGGESTION_THRESHOLD, type Rule } from '../shared/types';
import { applyRules, parseRule } from '../worker/rules';
import {
  buildSuggestionRuleText,
  computeRuleSuggestions,
  MAX_RULE_SUGGESTIONS,
  ruleCoversPair,
  suggestionKey,
  validateSuggestionAction,
  type CorrectionRow,
  type SuggestionContext,
} from '../worker/suggestions';

const CATEGORIES = ['Dining', 'Groceries', 'Subscriptions', 'Entertainment', NEEDS_REVIEW];

function correction(merchant: string, category: string, createdAt: string): CorrectionRow {
  return { merchant, category, createdAt };
}

function rule(whenText: string, thenText: string, enabled = true): Rule {
  return { id: whenText + thenText, whenText, thenText, enabled, createdAt: '2026-01-01T00:00:00Z' };
}

function ctx(overrides: Partial<SuggestionContext> = {}): SuggestionContext {
  return { rules: [], dismissedKeys: new Set(), categories: CATEGORIES, ...overrides };
}

describe('threshold', () => {
  it('one correction is not a pattern; two agreeing corrections are', () => {
    const one = [correction('Netflix', 'Subscriptions', '2026-08-01T10:00:00Z')];
    expect(computeRuleSuggestions(one, ctx())).toEqual([]);

    const two = [...one, correction('Netflix', 'Subscriptions', '2026-08-02T10:00:00Z')];
    expect(computeRuleSuggestions(two, ctx())).toEqual([
      {
        id: 'netflix|Subscriptions',
        merchant: 'Netflix',
        category: 'Subscriptions',
        evidenceCount: 2,
        lastSeen: '2026-08-02T10:00:00Z',
      },
    ]);
    expect(RULE_SUGGESTION_THRESHOLD).toBe(2);
  });

  it('the same merchant corrected to two categories counts per pair, not per merchant', () => {
    const split = [
      correction('Netflix', 'Subscriptions', '2026-08-01T10:00:00Z'),
      correction('Netflix', 'Entertainment', '2026-08-02T10:00:00Z'),
    ];
    expect(computeRuleSuggestions(split, ctx())).toEqual([]);
  });
});

describe('grouping and display casing', () => {
  it('groups case- and whitespace-insensitively but displays the most recent raw casing', () => {
    const rows = [
      correction('NETFLIX.COM', 'Subscriptions', '2026-08-01T10:00:00Z'),
      correction('  netflix.com ', 'Subscriptions', '2026-08-03T10:00:00Z'),
      correction('Netflix.Com', 'Subscriptions', '2026-08-02T10:00:00Z'),
    ];
    const out = computeRuleSuggestions(rows, ctx());
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('netflix.com|Subscriptions');
    expect(out[0].merchant).toBe('netflix.com'); // raw casing of the newest, trimmed
    expect(out[0].evidenceCount).toBe(3);
    expect(out[0].lastSeen).toBe('2026-08-03T10:00:00Z');
  });

  it('finds the newest correction regardless of input order', () => {
    const rows = [
      correction('spotify', 'Subscriptions', '2026-08-02T10:00:00Z'),
      correction('SPOTIFY', 'Subscriptions', '2026-08-05T10:00:00Z'),
      correction('Spotify', 'Subscriptions', '2026-08-01T10:00:00Z'),
    ];
    const out = computeRuleSuggestions(rows, ctx());
    expect(out[0].merchant).toBe('SPOTIFY');
    expect(out[0].lastSeen).toBe('2026-08-05T10:00:00Z');
  });

  it('ignores corrections with a blank merchant or category', () => {
    const rows = [
      correction('   ', 'Dining', '2026-08-01T10:00:00Z'),
      correction('   ', 'Dining', '2026-08-02T10:00:00Z'),
      correction('Cafe', '', '2026-08-01T10:00:00Z'),
      correction('Cafe', '', '2026-08-02T10:00:00Z'),
    ];
    expect(computeRuleSuggestions(rows, ctx())).toEqual([]);
  });
});

describe('exclusions', () => {
  const netflixTwice = [
    correction('NETFLIX.COM 4085', 'Subscriptions', '2026-08-01T10:00:00Z'),
    correction('NETFLIX.COM 4085', 'Subscriptions', '2026-08-02T10:00:00Z'),
  ];

  it('drops a pair an enabled rule already covers — judged by the real engine', () => {
    const covered = ctx({ rules: [rule('merchant contains "netflix"', 'set category to Subscriptions')] });
    expect(computeRuleSuggestions(netflixTwice, covered)).toEqual([]);
  });

  it('a disabled rule does not count as coverage', () => {
    const disabled = ctx({
      rules: [rule('merchant contains "netflix"', 'set category to Subscriptions', false)],
    });
    expect(computeRuleSuggestions(netflixTwice, disabled)).toHaveLength(1);
  });

  it('a rule sending the merchant to a DIFFERENT category is not coverage', () => {
    const other = ctx({ rules: [rule('merchant contains "netflix"', 'set category to Entertainment')] });
    expect(computeRuleSuggestions(netflixTwice, other)).toHaveLength(1);
  });

  it('drops a dismissed pair', () => {
    const dismissed = ctx({
      dismissedKeys: new Set([suggestionKey('NETFLIX.COM 4085', 'Subscriptions')]),
    });
    expect(computeRuleSuggestions(netflixTwice, dismissed)).toEqual([]);
  });

  it('drops a pair whose category was deleted from settings', () => {
    const rows = [
      correction('Delta', 'Travel', '2026-08-01T10:00:00Z'),
      correction('Delta', 'Travel', '2026-08-02T10:00:00Z'),
    ];
    expect(computeRuleSuggestions(rows, ctx())).toEqual([]); // 'Travel' not managed
    const withTravel = ctx({ categories: [...CATEGORIES, 'Travel'] });
    expect(computeRuleSuggestions(rows, withTravel)).toHaveLength(1);
  });
});

describe('ordering and cap', () => {
  it('sorts by evidence desc then recency desc and caps the list', () => {
    const rows: CorrectionRow[] = [];
    // 21 two-correction pairs with increasing recency, plus one three-correction pair.
    for (let i = 0; i < 21; i++) {
      const stamp = `2026-08-01T00:${String(i).padStart(2, '0')}:00Z`;
      rows.push(correction(`Shop ${i}`, 'Groceries', '2026-07-01T00:00:00Z'));
      rows.push(correction(`Shop ${i}`, 'Groceries', stamp));
    }
    rows.push(
      correction('Heavy', 'Dining', '2026-06-01T00:00:00Z'),
      correction('Heavy', 'Dining', '2026-06-02T00:00:00Z'),
      correction('Heavy', 'Dining', '2026-06-03T00:00:00Z'),
    );

    const out = computeRuleSuggestions(rows, ctx());
    expect(out).toHaveLength(MAX_RULE_SUGGESTIONS);
    expect(out[0].merchant).toBe('Heavy'); // most evidence wins despite older lastSeen
    expect(out[1].merchant).toBe('Shop 20'); // then newest lastSeen first
    expect(out[out.length - 1].merchant).toBe('Shop 2'); // Shop 1 and Shop 0 fell off the cap
  });
});

describe('accepted suggestions round-trip through the real parser', () => {
  it('builds canonical text that parses back to exactly (merchant-contains, set-category)', () => {
    const text = buildSuggestionRuleText('NETFLIX.COM 4085', 'Subscriptions');
    expect(text).toEqual({
      whenText: 'merchant contains "NETFLIX.COM 4085"',
      thenText: 'set category to Subscriptions',
    });
    expect(parseRule(text!.whenText, text!.thenText)).toEqual({
      contains: 'netflix.com 4085',
      category: 'Subscriptions',
      tags: [],
    });
  });

  it('survives quotes inside the merchant name', () => {
    const text = buildSuggestionRuleText(`Joe's "Best" Pizza`, 'Dining');
    expect(text).not.toBeNull();
    expect(parseRule(text!.whenText, text!.thenText)).toEqual({
      contains: `joe's "best" pizza`,
      category: 'Dining',
      tags: [],
    });
  });

  it('the created rule actually fires on the merchant it was learned from', () => {
    const text = buildSuggestionRuleText('Blue Bottle #42', 'Dining');
    const out = applyRules(
      { merchant: 'BLUE BOTTLE #42 OAKLAND', category: NEEDS_REVIEW, tags: [] },
      [rule(text!.whenText, text!.thenText)],
    );
    expect(out.category).toBe('Dining');
  });

  it('refuses a pair the parser would misread instead of storing a wrong rule', () => {
    // CLAUSE_SPLIT cuts these thenTexts apart, so the stored rule would set
    // category 'Food' — never store what would fire differently than promised.
    expect(buildSuggestionRuleText('Spotify', 'Food and Drink')).toBeNull();
    expect(buildSuggestionRuleText('Spotify', 'Food, Drink')).toBeNull();
    // A merchant with "and" is fine — parseWhen never clause-splits.
    expect(buildSuggestionRuleText('Chip and Dale', 'Dining')).not.toBeNull();
  });
});

describe('accept idempotency decision', () => {
  it('once the built rule exists, the pair reads as covered — no duplicate rule', () => {
    expect(ruleCoversPair('Spotify AB', 'Subscriptions', [])).toBe(false);
    const text = buildSuggestionRuleText('Spotify AB', 'Subscriptions');
    const created = rule(text!.whenText, text!.thenText);
    expect(ruleCoversPair('Spotify AB', 'Subscriptions', [created])).toBe(true);
    // Coverage is category-exact: the same rule does not cover another category.
    expect(ruleCoversPair('Spotify AB', 'Entertainment', [created])).toBe(false);
  });
});

describe('action input validation', () => {
  it('accepts a well-formed body and trims it', () => {
    expect(validateSuggestionAction({ merchant: ' Netflix ', category: ' Subscriptions ' })).toEqual(
      { ok: true, merchant: 'Netflix', category: 'Subscriptions' },
    );
  });

  it('rejects non-objects and blank fields with readable messages', () => {
    expect(validateSuggestionAction('nope')).toEqual({
      ok: false,
      error: 'Send a JSON object with merchant and category.',
    });
    expect(validateSuggestionAction({ category: 'Dining' })).toEqual({
      ok: false,
      error: 'merchant is required.',
    });
    expect(validateSuggestionAction({ merchant: 'Netflix', category: '   ' })).toEqual({
      ok: false,
      error: 'category is required.',
    });
  });
});
