// "Getting to know you" merchant questions (sprint 14): the sourcing matrix
// (threshold, the understands-it exclusion, profile/dismissal/rule-covered
// exclusions via the REAL applyRules, ranking, the 3-question cap), the
// person-name heuristic, answer validation, and the answer flow against a
// fake D1 — including the pins that the bulk recategorization touches ONLY
// 'Needs review' rows and never records category_corrections.
import { describe, expect, it } from 'vitest';
import { NEEDS_REVIEW, type Rule } from '../shared/types';
import {
  answerMerchantQuestion,
  computeMerchantQuestions,
  dismissMerchantQuestion,
  MAX_MERCHANT_QUESTIONS,
  MERCHANT_QUESTION_THRESHOLD,
  normalizeQuestionMerchant,
  readMerchantQuestions,
  ruleHandlesMerchant,
  suggestPersonKind,
  validateMerchantAnswer,
  type MerchantQuestionContext,
  type QuestionTx,
} from '../worker/questions';
import { ApiFail } from '../worker/util';

function tx(
  merchant: string,
  category: string,
  amount = 100,
  date = '2026-08-01',
  createdAt = '2026-08-01T10:00:00Z',
): QuestionTx {
  return { merchant, category, amount, date, createdAt };
}

function rule(whenText: string, thenText: string, enabled = true): Rule {
  return { id: whenText + thenText, whenText, thenText, enabled, createdAt: '2026-01-01T00:00:00Z' };
}

function ctx(overrides: Partial<MerchantQuestionContext> = {}): MerchantQuestionContext {
  return { rules: [], profiledKeys: new Set(), dismissedKeys: new Set(), ...overrides };
}

/** Three raw bank spellings of the same person — the grouping must see one merchant. */
const RAVI_RAW = [
  tx('UPI-RAVI KUMAR-ravik@okaxis-402934857382', NEEDS_REVIEW, 500, '2026-08-01'),
  tx('UPI-Ravi Kumar-ravik@okhdfcbank', NEEDS_REVIEW, 250, '2026-08-03'),
  tx('Ravi Kumar', NEEDS_REVIEW, 490.5, '2026-08-05'),
];

describe('sourcing — threshold and the understands-it test', () => {
  it('two transactions are not worth a question; three are', () => {
    expect(computeMerchantQuestions(RAVI_RAW.slice(0, 2), ctx())).toEqual([]);
    const out = computeMerchantQuestions(RAVI_RAW, ctx());
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      id: 'ravi kumar',
      merchant: 'Ravi Kumar',
      txCount: 3,
      total: 1240.5,
      mostRecent: '2026-08-05',
      suggestedKind: 'person',
    });
    expect(MERCHANT_QUESTION_THRESHOLD).toBe(3);
  });

  it('a merchant whose transactions all agree on one real category is understood — no question', () => {
    const consistent = RAVI_RAW.map((t) => ({ ...t, category: 'Dining' }));
    expect(computeMerchantQuestions(consistent, ctx())).toEqual([]);
  });

  it('disagreeing categories mean the app does NOT understand it — question', () => {
    const inconsistent = [
      { ...RAVI_RAW[0], category: 'Dining' },
      { ...RAVI_RAW[1], category: 'Shopping' },
      { ...RAVI_RAW[2], category: 'Dining' },
    ];
    expect(computeMerchantQuestions(inconsistent, ctx())).toHaveLength(1);
  });

  it('a mix of a real category and Needs review is also inconsistent — question', () => {
    const mixed = [
      { ...RAVI_RAW[0], category: 'Dining' },
      RAVI_RAW[1],
      RAVI_RAW[2],
    ];
    expect(computeMerchantQuestions(mixed, ctx())).toHaveLength(1);
  });

  it('groups raw bank spellings under the cleaned key and sums their totals without float dust', () => {
    const dusty = [
      tx('UPI-RAVI KUMAR-ravik@okaxis-1111', NEEDS_REVIEW, 10.1),
      tx('UPI-RAVI KUMAR-ravik@okaxis-2222', NEEDS_REVIEW, 20.2),
      tx('Ravi Kumar', NEEDS_REVIEW, 30.3),
    ];
    const out = computeMerchantQuestions(dusty, ctx());
    expect(out[0].total).toBe(60.6); // not 60.599999999999994
    expect(out[0].txCount).toBe(3);
  });

  it('display casing follows the newest transaction (date, then createdAt)', () => {
    const rows = [
      tx('RAVI KUMAR', NEEDS_REVIEW, 100, '2026-08-01'),
      tx('RAVI Kumar', NEEDS_REVIEW, 100, '2026-08-06'), // newest — mixed case survives cleanup as written
      tx('Ravi Kumar', NEEDS_REVIEW, 100, '2026-08-03'),
    ];
    const out = computeMerchantQuestions(rows, ctx());
    expect(out[0].merchant).toBe('RAVI Kumar');
    expect(out[0].id).toBe('ravi kumar'); // key unaffected by casing
    expect(out[0].mostRecent).toBe('2026-08-06');
  });
});

describe('sourcing — exclusions', () => {
  it('an answered merchant (profile exists) is never asked again', () => {
    const profiled = ctx({ profiledKeys: new Set(['ravi kumar']) });
    expect(computeMerchantQuestions(RAVI_RAW, profiled)).toEqual([]);
  });

  it('a dismissed merchant is never asked again', () => {
    const dismissed = ctx({ dismissedKeys: new Set(['ravi kumar']) });
    expect(computeMerchantQuestions(RAVI_RAW, dismissed)).toEqual([]);
  });

  it('a merchant an enabled rule already categorizes is excluded — judged by the real applyRules', () => {
    const covered = ctx({ rules: [rule('merchant contains "ravi kumar"', 'set category to Other')] });
    expect(computeMerchantQuestions(RAVI_RAW, covered)).toEqual([]);
    expect(ruleHandlesMerchant('Ravi Kumar', covered.rules)).toBe(true);
  });

  it('a disabled rule does not count as coverage', () => {
    const disabled = ctx({
      rules: [rule('merchant contains "ravi kumar"', 'set category to Other', false)],
    });
    expect(computeMerchantQuestions(RAVI_RAW, disabled)).toHaveLength(1);
  });

  it('a tag-only rule does not count as coverage — it never answers the category question', () => {
    const tagOnly = ctx({ rules: [rule('merchant contains "ravi kumar"', 'add tag friends')] });
    expect(computeMerchantQuestions(RAVI_RAW, tagOnly)).toHaveLength(1);
    expect(ruleHandlesMerchant('Ravi Kumar', tagOnly.rules)).toBe(false);
  });
});

describe('sourcing — ranking and cap', () => {
  it('ranks by txCount desc then total desc, and caps at 3 — a drip, never a wall', () => {
    const rows: QuestionTx[] = [];
    const seed = (merchant: string, count: number, amount: number) => {
      for (let i = 0; i < count; i++) rows.push(tx(merchant, NEEDS_REVIEW, amount, '2026-08-01'));
    };
    seed('Alpha One', 5, 10); // most transactions — first
    seed('Beta Two', 4, 100); // ties Gamma on count, bigger total — second
    seed('Gamma Three', 4, 25); // third
    seed('Delta Four', 3, 999); // qualifies but falls off the cap

    const out = computeMerchantQuestions(rows, ctx());
    expect(out.map((q) => q.merchant)).toEqual(['Alpha One', 'Beta Two', 'Gamma Three']);
    expect(MAX_MERCHANT_QUESTIONS).toBe(3);
  });
});

describe('the person-name heuristic — a default-toggle hint, nothing more', () => {
  it('reads 1-3 Title-Case words with no business token as a person', () => {
    expect(suggestPersonKind('Varun')).toBe('person');
    expect(suggestPersonKind('Ravi Kumar')).toBe('person');
    expect(suggestPersonKind('Anand Kumar Sharma')).toBe('person');
  });

  it('a business token anywhere kills the hint', () => {
    expect(suggestPersonKind('Swiggy Limited')).toBeNull();
    expect(suggestPersonKind('Reliance Retail')).toBeNull();
    expect(suggestPersonKind('Sharma Store')).toBeNull();
    expect(suggestPersonKind('Sbi Cards Payments')).toBeNull();
    expect(suggestPersonKind('Acme Services')).toBeNull();
  });

  it('acronyms, mixed-case brands and long strings get no opinion', () => {
    expect(suggestPersonKind('KFC')).toBeNull(); // all caps is not a Title-Case word
    expect(suggestPersonKind('HDFC Bank')).toBeNull();
    expect(suggestPersonKind('PhonePe')).toBeNull(); // mid-word capital
    expect(suggestPersonKind('One Two Three Four')).toBeNull(); // 4+ words
    expect(suggestPersonKind('lowercase name')).toBeNull();
  });
});

describe('answer validation', () => {
  it('accepts a full body, trims it, and defaults the label to the merchant', () => {
    expect(
      validateMerchantAnswer({
        merchant: ' Ravi Kumar ',
        kind: 'person',
        label: '  ',
        category: ' Transfers ',
        applyToExisting: true,
      }),
    ).toEqual({
      ok: true,
      value: {
        merchant: 'Ravi Kumar',
        kind: 'person',
        label: 'Ravi Kumar',
        category: 'Transfers',
        applyToExisting: true,
      },
    });
  });

  it('kind may honestly be null or omitted; anything else is rejected', () => {
    const base = { merchant: 'Ravi Kumar', category: 'Transfers', applyToExisting: false };
    expect(validateMerchantAnswer({ ...base, kind: null })).toMatchObject({ ok: true });
    expect(validateMerchantAnswer(base)).toMatchObject({ ok: true, value: { kind: null } });
    expect(validateMerchantAnswer({ ...base, kind: 'alien' })).toEqual({
      ok: false,
      error: "kind must be 'person', 'business' or null.",
    });
  });

  it('rejects non-objects, blank fields and a non-boolean applyToExisting', () => {
    expect(validateMerchantAnswer('nope')).toEqual({
      ok: false,
      error: 'Send a JSON object with merchant and category.',
    });
    expect(validateMerchantAnswer({ category: 'Transfers' })).toEqual({
      ok: false,
      error: 'merchant is required.',
    });
    expect(validateMerchantAnswer({ merchant: 'Ravi Kumar', category: ' ' })).toEqual({
      ok: false,
      error: 'category is required.',
    });
    expect(
      validateMerchantAnswer({ merchant: 'Ravi Kumar', category: 'Transfers', applyToExisting: 'yes' }),
    ).toEqual({ ok: false, error: 'applyToExisting must be true or false.' });
  });
});

// ---------------------------------------------------------------------------
// Answer/dismiss flow against a fake D1 that tracks every executed statement,
// so "never records category_corrections" is pinned on evidence.
// ---------------------------------------------------------------------------

interface FakeTxRow {
  id: string;
  merchant: string;
  category: string;
}

interface RuleRow {
  id: string;
  whenText: string;
  thenText: string;
  enabled: number;
  createdAt: string;
}

function fakeDb(
  seed: {
    rules?: Rule[];
    transactions?: FakeTxRow[];
    profiles?: string[];
    dismissals?: string[];
  } = {},
) {
  const rules: RuleRow[] = (seed.rules ?? []).map((r) => ({
    id: r.id,
    whenText: r.whenText,
    thenText: r.thenText,
    enabled: r.enabled ? 1 : 0,
    createdAt: r.createdAt,
  }));
  const transactions = (seed.transactions ?? []).map((t) => ({ ...t }));
  const profiles = new Map<string, { label: string; kind: string | null; category: string }>();
  for (const key of seed.profiles ?? []) profiles.set(key, { label: key, kind: null, category: 'Other' });
  const dismissals = new Map<string, string>();
  for (const key of seed.dismissals ?? []) dismissals.set(key, '2026-01-01T00:00:00Z');
  const executed: string[] = [];

  interface Stmt {
    sql: string;
    args: unknown[];
    bind(...values: unknown[]): Stmt;
    all<T>(): Promise<{ results: T[] }>;
    run(): Promise<void>;
  }
  function statement(sql: string, args: unknown[] = []): Stmt {
    return {
      sql,
      args,
      bind: (...values: unknown[]) => statement(sql, values),
      all: async <T,>() => {
        executed.push(sql);
        if (/FROM rules/i.test(sql)) return { results: rules.map((r) => ({ ...r })) as T[] };
        if (/SELECT id, merchant FROM transactions WHERE category = \?/i.test(sql)) {
          return {
            results: transactions
              .filter((t) => t.category === args[0])
              .map((t) => ({ id: t.id, merchant: t.merchant })) as T[],
          };
        }
        if (/FROM merchant_profiles/i.test(sql)) {
          return { results: [...profiles.keys()].map((k) => ({ normalizedMerchant: k })) as T[] };
        }
        if (/FROM merchant_question_dismissals/i.test(sql)) {
          return { results: [...dismissals.keys()].map((k) => ({ normalizedMerchant: k })) as T[] };
        }
        throw new Error(`fake D1 has no .all handler for: ${sql}`);
      },
      run: async () => {
        executed.push(sql);
        if (/INSERT INTO rules/i.test(sql)) {
          rules.push({
            id: args[0] as string,
            whenText: args[1] as string,
            thenText: args[2] as string,
            enabled: 1,
            createdAt: args[3] as string,
          });
          return;
        }
        if (/INSERT INTO merchant_profiles/i.test(sql)) {
          profiles.set(args[0] as string, {
            label: args[1] as string,
            kind: args[2] as string | null,
            category: args[3] as string,
          });
          return;
        }
        if (/DELETE FROM merchant_question_dismissals/i.test(sql)) {
          dismissals.delete(args[0] as string);
          return;
        }
        if (/INSERT INTO merchant_question_dismissals/i.test(sql)) {
          dismissals.set(args[0] as string, args[1] as string);
          return;
        }
        if (/UPDATE transactions SET category = \? WHERE id IN/i.test(sql)) {
          const ids = new Set(args.slice(1) as string[]);
          for (const t of transactions) if (ids.has(t.id)) t.category = args[0] as string;
          return;
        }
        throw new Error(`fake D1 has no .run handler for: ${sql}`);
      },
    };
  }

  const db = { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
  return { db, rules, transactions, profiles, dismissals, executed };
}

const LEDGER: FakeTxRow[] = [
  { id: 't1', merchant: 'UPI-RAVI KUMAR-ravik@okaxis-402934857382', category: NEEDS_REVIEW },
  { id: 't2', merchant: 'UPI-Ravi Kumar-ravik@okhdfcbank', category: NEEDS_REVIEW },
  { id: 't3', merchant: 'Ravi Kumar', category: NEEDS_REVIEW },
  { id: 't4', merchant: 'Ravi Kumar', category: 'Dining' }, // user-grounded — must survive
  { id: 't5', merchant: 'Zomato', category: NEEDS_REVIEW }, // different merchant — must survive
];

describe('answerMerchantQuestion', () => {
  const ANSWER = {
    merchant: 'Ravi Kumar',
    kind: 'person' as const,
    label: '',
    category: 'Transfers',
    applyToExisting: true,
  };

  it('stores the profile, creates the rule via the S5 round-trip path, and recategorizes only matching Needs-review rows', async () => {
    const { db, transactions, profiles, executed } = fakeDb({ transactions: LEDGER });
    const res = await answerMerchantQuestion(db, ANSWER);

    // The rule went through buildSuggestionRuleText — canonical text, real parser.
    expect(res.rules).toHaveLength(1);
    expect(res.rules[0].whenText).toBe('merchant contains "Ravi Kumar"');
    expect(res.rules[0].thenText).toBe('set category to Transfers');
    expect(res.rules[0].enabled).toBe(true);

    // The profile is permanent memory; label defaulted to the display merchant.
    expect(profiles.get('ravi kumar')).toEqual({
      label: 'Ravi Kumar',
      kind: 'person',
      category: 'Transfers',
    });

    // Exactly the three raw Ravi Needs-review rows — not the grounded Dining
    // row, not the other merchant.
    expect(res.recategorized).toBe(3);
    expect(transactions.map((t) => t.category)).toEqual([
      'Transfers',
      'Transfers',
      'Transfers',
      'Dining',
      NEEDS_REVIEW,
    ]);

    // An answer is not a correction pattern: the S5 learning table is never touched.
    expect(executed.some((sql) => /category_corrections/i.test(sql))).toBe(false);
  });

  it('keeps a user-provided label', async () => {
    const { db, profiles } = fakeDb({ transactions: LEDGER });
    await answerMerchantQuestion(db, { ...ANSWER, label: ' Mom ' });
    expect(profiles.get('ravi kumar')?.label).toBe('Mom');
  });

  it('applyToExisting false leaves the ledger untouched — no transaction reads or writes at all', async () => {
    const { db, transactions, executed } = fakeDb({ transactions: LEDGER });
    const res = await answerMerchantQuestion(db, { ...ANSWER, applyToExisting: false });
    expect(res.recategorized).toBe(0);
    expect(transactions.every((t, i) => t.category === LEDGER[i].category)).toBe(true);
    expect(executed.some((sql) => /transactions/i.test(sql))).toBe(false);
  });

  it('refuses (400) a category the rule parser would misread, before writing anything', async () => {
    const { db, profiles, rules } = fakeDb({ transactions: LEDGER });
    await expect(
      answerMerchantQuestion(db, { ...ANSWER, category: 'Food and Drink' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(profiles.size).toBe(0); // honest 400 leaves nothing half-done
    expect(rules).toHaveLength(0);
  });

  it('is idempotent against an existing covering rule — no duplicate rule, profile still stored', async () => {
    const covering = rule('merchant contains "Ravi Kumar"', 'set category to Transfers');
    const { db, rules: ruleRows, profiles } = fakeDb({ rules: [covering], transactions: LEDGER });
    const res = await answerMerchantQuestion(db, ANSWER);
    expect(ruleRows).toHaveLength(1);
    expect(res.rules).toHaveLength(1);
    expect(profiles.has('ravi kumar')).toBe(true);
  });

  it('an answer outranks an old dismissal of the same merchant', async () => {
    const { db, dismissals } = fakeDb({ transactions: LEDGER, dismissals: ['ravi kumar'] });
    await answerMerchantQuestion(db, ANSWER);
    expect(dismissals.has('ravi kumar')).toBe(false);
  });

  it('rejects an invalid body with the validator message', async () => {
    const { db } = fakeDb();
    await expect(answerMerchantQuestion(db, { category: 'Transfers' })).rejects.toMatchObject({
      status: 400,
      message: 'merchant is required.',
    });
    await expect(answerMerchantQuestion(db, 'nope')).rejects.toBeInstanceOf(ApiFail);
  });
});

describe('dismissMerchantQuestion', () => {
  it('records the dismissal under the normalized key and re-dismissing is quiet', async () => {
    const { db, dismissals } = fakeDb();
    await dismissMerchantQuestion(db, { merchant: 'Zomato' });
    expect(dismissals.has('zomato')).toBe(true);
    await expect(dismissMerchantQuestion(db, { merchant: 'ZOMATO' })).resolves.toBeUndefined();
    expect(dismissals.size).toBe(1);
  });

  it('rejects a blank merchant', async () => {
    const { db } = fakeDb();
    await expect(dismissMerchantQuestion(db, { merchant: '  ' })).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('readMerchantQuestions — the full loop', () => {
  const RAVI_TXS: QuestionTx[] = RAVI_RAW;

  it('asks about an ununderstood merchant, and an answer silences it for good', async () => {
    const { db } = fakeDb({ transactions: LEDGER });
    const before = await readMerchantQuestions(db, RAVI_TXS, []);
    expect(before.map((q) => q.id)).toEqual(['ravi kumar']);

    const res = await answerMerchantQuestion(db, {
      merchant: 'Ravi Kumar',
      kind: 'person',
      category: 'Transfers',
      applyToExisting: true,
    });
    const after = await readMerchantQuestions(db, RAVI_TXS, res.rules);
    expect(after).toEqual([]);
  });

  it('a stored dismissal suppresses the question', async () => {
    const { db } = fakeDb({ transactions: LEDGER });
    await dismissMerchantQuestion(db, { merchant: 'Ravi Kumar' });
    expect(await readMerchantQuestions(db, RAVI_TXS, [])).toEqual([]);
  });
});

describe('normalizeQuestionMerchant', () => {
  it('is stable across raw bank spellings and idempotent on cleaned names', () => {
    expect(normalizeQuestionMerchant('UPI-RAVI KUMAR-ravik@okaxis-402934857382')).toBe('ravi kumar');
    expect(normalizeQuestionMerchant('Ravi Kumar')).toBe('ravi kumar');
    expect(normalizeQuestionMerchant(normalizeQuestionMerchant('UPI-Ravi Kumar-ravik@okhdfcbank'))).toBe(
      'ravi kumar',
    );
    expect(normalizeQuestionMerchant('KFC')).toBe('kfc');
  });
});
