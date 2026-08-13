// PDF statement extraction: the pure half (what the server does to a model's
// rows before any of them reach D1) plus the two write paths that need a
// database — the in-flight claim and confirm-time validation.
//
// No network anywhere. The live model call is exercised only through its
// inputs and outputs; the fakes below stand in for D1.
import { describe, expect, it } from 'vitest';
import { MAX_STATEMENT_ROWS } from '../shared/types';
import { txFingerprint } from '../shared/fingerprint';
import {
  lowestConfidence,
  normalizeStatementRow,
  normalizeStatementRows,
  salvageStatementRows,
  readRowsArray,
  type StatementRowFields,
} from '../worker/ai/normalize';
import {
  assertStatementMime,
  selectStatementProvider,
} from '../worker/ai/providers';
import { defaultSettings, type Rule, type Settings } from '../shared/types';
import {
  claimStatement,
  confirmStatementRows,
  defaultStatementAccount,
  enrichStatementRows,
  flagDuplicates,
  statementRowFingerprint,
} from '../worker/statements';

const CATEGORIES = ['Groceries', 'Dining', 'Needs review', 'Transportation'];

/** A well-formed row off a statement; individual tests corrupt one field. */
function modelRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    date: { value: '2026-03-04', confidence: 0.9 },
    merchant: { value: 'Tesco', confidence: 0.8 },
    amount: { value: 41.2, confidence: 0.95 },
    type: { value: 'expense', confidence: 0.99 },
    category: { value: 'Groceries', confidence: 0.7 },
    ...overrides,
  };
}

/** The normalized shape of `modelRow`, for building fingerprints in tests. */
function fieldsOf(overrides: Record<string, unknown> = {}): StatementRowFields {
  const row = normalizeStatementRow(modelRow(overrides), CATEGORIES);
  if (!row) throw new Error('test fixture produced a dropped row');
  return row;
}

// ---------------------------------------------------------------------------
// Per-row re-validation
// ---------------------------------------------------------------------------

describe('normalizeStatementRow — a clean row survives intact', () => {
  it('keeps every grounded field and its confidence', () => {
    expect(normalizeStatementRow(modelRow(), CATEGORIES)).toEqual({
      date: { value: '2026-03-04', confidence: 0.9 },
      merchant: { value: 'Tesco', confidence: 0.8 },
      amount: { value: 41.2, confidence: 0.95 },
      type: { value: 'expense', confidence: 0.99 },
      category: { value: 'Groceries', confidence: 0.7 },
    });
  });

  it('drops anything that is not an object', () => {
    for (const bad of [null, undefined, 'row', 7, [], true]) {
      expect(normalizeStatementRow(bad, CATEGORIES)).toBeNull();
    }
  });
});

describe('normalizeStatementRow — dates are checked against the real calendar', () => {
  it('takes the date out of a longer timestamp', () => {
    const row = normalizeStatementRow(
      modelRow({ date: { value: '2026-03-04T00:00:00Z', confidence: 0.8 } }),
      CATEGORIES,
    );
    expect(row?.date.value).toBe('2026-03-04');
  });

  // The row survives on its amount alone — a date we could not read is the
  // user's to fill in, not a reason to hide the transaction from them.
  for (const bad of ['2026-02-30', '2025-02-29', '04/03/2026', '4 Mar', '2026-3-4', '']) {
    it(`rejects ${JSON.stringify(bad)} but keeps the row`, () => {
      const row = normalizeStatementRow(
        modelRow({ date: { value: bad, confidence: 0.99 } }),
        CATEGORIES,
      );
      expect(row?.date).toEqual({ value: null, confidence: 0 });
      expect(row?.amount.value).toBe(41.2);
    });
  }
});

describe('normalizeStatementRow — amounts are positive magnitudes', () => {
  it('rounds to cents', () => {
    const row = normalizeStatementRow(
      modelRow({ amount: { value: 12.3456, confidence: 0.9 } }),
      CATEGORIES,
    );
    expect(row?.amount.value).toBe(12.35);
  });

  it('accepts a numeric string', () => {
    const row = normalizeStatementRow(
      modelRow({ amount: { value: ' 41.20 ', confidence: 0.6 } }),
      CATEGORIES,
    );
    expect(row?.amount).toEqual({ value: 41.2, confidence: 0.6 });
  });

  // A negative amount is dropped rather than flipped: the sign lives in `type`,
  // and "so it must be a credit" is exactly the inference we refuse to make.
  for (const bad of [0, -41.2, -0.01, Number.NaN, Number.POSITIVE_INFINITY, 'free', null, {}]) {
    it(`rejects ${JSON.stringify(bad)} but keeps the row on its date`, () => {
      const row = normalizeStatementRow(
        modelRow({ amount: { value: bad, confidence: 0.99 } }),
        CATEGORIES,
      );
      expect(row?.amount).toEqual({ value: null, confidence: 0 });
      expect(row?.date.value).toBe('2026-03-04');
    });
  }
});

describe('normalizeStatementRow — type is a closed enum', () => {
  for (const good of ['expense', 'income'] as const) {
    it(`accepts ${good}`, () => {
      const row = normalizeStatementRow(
        modelRow({ type: { value: good, confidence: 0.9 } }),
        CATEGORIES,
      );
      expect(row?.type.value).toBe(good);
    });
  }

  // No default to 'expense': a statement whose debit/credit column we could not
  // read goes to the user, not to a guess that could invert their balance.
  for (const bad of ['Expense', 'debit', 'credit', 'DR', '', 1, null]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      const row = normalizeStatementRow(
        modelRow({ type: { value: bad, confidence: 0.95 } }),
        CATEGORIES,
      );
      expect(row?.type).toEqual({ value: null, confidence: 0 });
    });
  }
});

describe('normalizeStatementRow — categories must be in the managed list', () => {
  it('matches case-insensitively and returns the managed casing', () => {
    const row = normalizeStatementRow(
      modelRow({ category: { value: '  dINING ', confidence: 0.55 } }),
      CATEGORIES,
    );
    expect(row?.category).toEqual({ value: 'Dining', confidence: 0.55 });
  });

  for (const invented of ['Coffee', 'Food & Drink', 'Groceries ✨', '']) {
    it(`drops the invented category ${JSON.stringify(invented)}`, () => {
      const row = normalizeStatementRow(
        modelRow({ category: { value: invented, confidence: 0.9 } }),
        CATEGORIES,
      );
      expect(row?.category).toEqual({ value: null, confidence: 0 });
    });
  }

  it('drops every category when the user manages none', () => {
    const row = normalizeStatementRow(modelRow(), []);
    expect(row?.category).toEqual({ value: null, confidence: 0 });
    expect(row?.merchant.value).toBe('Tesco');
  });
});

describe('normalizeStatementRow — a row with neither date nor amount is not a transaction', () => {
  it('drops it entirely rather than offering a blank form', () => {
    const row = normalizeStatementRow(
      modelRow({
        date: { value: null, confidence: 0 },
        amount: { value: null, confidence: 0 },
        merchant: { value: 'CLOSING BALANCE', confidence: 0.9 },
      }),
      CATEGORIES,
    );
    expect(row).toBeNull();
  });

  it('drops it when both fields are merely invalid, not absent', () => {
    const row = normalizeStatementRow(
      modelRow({
        date: { value: 'Statement period', confidence: 0.4 },
        amount: { value: -0, confidence: 0.4 },
      }),
      CATEGORIES,
    );
    expect(row).toBeNull();
  });

  it('keeps a row that has only a date', () => {
    const row = normalizeStatementRow(
      modelRow({ amount: { value: null, confidence: 0 } }),
      CATEGORIES,
    );
    expect(row).not.toBeNull();
  });

  it('keeps a row that has only an amount', () => {
    const row = normalizeStatementRow(
      modelRow({ date: { value: null, confidence: 0 } }),
      CATEGORIES,
    );
    expect(row).not.toBeNull();
  });
});

describe('lowestConfidence drives review ordering', () => {
  it('is the minimum across all five fields', () => {
    expect(lowestConfidence(fieldsOf())).toBe(0.7);
  });

  it('collapses to 0 as soon as one field could not be read', () => {
    expect(lowestConfidence(fieldsOf({ category: { value: 'Nope', confidence: 0.9 } }))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The cap
// ---------------------------------------------------------------------------

describe('normalizeStatementRows — the cap is reported, never silent', () => {
  it('passes a short statement through untouched', () => {
    const out = normalizeStatementRows([modelRow(), modelRow()], CATEGORIES);
    expect(out.rows).toHaveLength(2);
    expect(out.capped).toBe(false);
  });

  it('stops at MAX_STATEMENT_ROWS and says so', () => {
    const raw = Array.from({ length: MAX_STATEMENT_ROWS + 5 }, () => modelRow());
    const out = normalizeStatementRows(raw, CATEGORIES);
    expect(out.rows).toHaveLength(MAX_STATEMENT_ROWS);
    expect(out.capped).toBe(true);
  });

  it('does not flag a run that lands exactly on the cap', () => {
    const raw = Array.from({ length: MAX_STATEMENT_ROWS }, () => modelRow());
    const out = normalizeStatementRows(raw, CATEGORIES);
    expect(out.rows).toHaveLength(MAX_STATEMENT_ROWS);
    expect(out.capped).toBe(false);
  });

  // The cap counts transactions, not lines the model emitted: 50 balance rows
  // must not eat the user's budget.
  it('applies the cap after dropping non-rows', () => {
    const junk = modelRow({
      date: { value: null, confidence: 0 },
      amount: { value: null, confidence: 0 },
    });
    const out = normalizeStatementRows([junk, junk, modelRow(), modelRow()], CATEGORIES, 3);
    expect(out.rows).toHaveLength(2);
    expect(out.capped).toBe(false);
  });

  it('honours a caller-supplied cap', () => {
    const out = normalizeStatementRows([modelRow(), modelRow(), modelRow()], CATEGORIES, 2);
    expect(out.rows).toHaveLength(2);
    expect(out.capped).toBe(true);
  });

  it('reads nothing out of a response with no rows array', () => {
    for (const bad of [null, 'text', 42, { rows: 'many' }, {}]) {
      expect(readRowsArray(bad)).toBeNull();
    }
    expect(readRowsArray({ rows: [] })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

describe('salvageStatementRows — a run that ran out of room keeps what it read', () => {
  const complete = `{"rows":[
    {"date":{"value":"2026-03-01","confidence":0.9},"merchant":{"value":"Tesco","confidence":0.9}},
    {"date":{"value":"2026-03-02","confidence":0.9},"merchant":{"value":"Shell","confidence":0.9}}
  ]}`;

  it('recovers the whole rows array when the JSON is intact', () => {
    expect(salvageStatementRows(complete)).toHaveLength(2);
  });

  it('recovers the complete rows and drops the ragged tail', () => {
    const cut = complete.slice(0, complete.indexOf('Shell'));
    const rows = salvageStatementRows(cut);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ merchant: { value: 'Tesco' } });
  });

  // A brace inside a merchant name is not the end of a row.
  it('is string-aware', () => {
    const braces = `{"rows":[{"merchant":{"value":"A } B { C","confidence":1}},{"merchant":{"value":"D","confidence":1}}]}`;
    const rows = salvageStatementRows(braces);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ merchant: { value: 'A } B { C' } });
  });

  it('survives an escaped quote inside a name', () => {
    const escaped = `{"rows":[{"merchant":{"value":"Joe\\"s \\\\ Diner","confidence":1}}]}`;
    expect(salvageStatementRows(escaped)).toHaveLength(1);
  });

  it('returns nothing when the answer was cut off before the first row closed', () => {
    expect(salvageStatementRows('{"rows":[{"date":{"value":"2026-03')).toEqual([]);
  });

  it('returns nothing when there is no rows array at all', () => {
    for (const bad of ['', 'I could not read this statement.', '{"total":12}', '[1,2,3]']) {
      expect(salvageStatementRows(bad)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Duplicate pre-flagging
// ---------------------------------------------------------------------------

describe('statementRowFingerprint', () => {
  it('matches the fingerprint an inserted transaction would get', () => {
    expect(statementRowFingerprint(fieldsOf(), 'Main Checking')).toBe(
      txFingerprint('2026-03-04', 'Tesco', 41.2, 'Main Checking'),
    );
  });

  // Unknowable, not "not a duplicate": the question needs both key fields.
  it('is null when the date could not be read', () => {
    expect(statementRowFingerprint(fieldsOf({ date: { value: 'n/a', confidence: 0 } }), 'A')).toBeNull();
  });

  it('is null when the amount could not be read', () => {
    expect(statementRowFingerprint(fieldsOf({ amount: { value: 0, confidence: 0 } }), 'A')).toBeNull();
  });

  it('treats an unreadable merchant as empty rather than skipping the row', () => {
    const fp = statementRowFingerprint(fieldsOf({ merchant: { value: '', confidence: 0 } }), 'A');
    expect(fp).toBe(txFingerprint('2026-03-04', '', 41.2, 'A'));
  });
});

describe('flagDuplicates', () => {
  const seen = new Set([txFingerprint('2026-03-04', 'Tesco', 41.2, 'Main Checking')]);

  it('flags a row that already exists in transactions', () => {
    const fps = [statementRowFingerprint(fieldsOf(), 'Main Checking')];
    expect(flagDuplicates(fps, seen)).toEqual([true]);
  });

  it('leaves a genuinely new row alone', () => {
    const fps = [statementRowFingerprint(fieldsOf({ amount: { value: 9.5, confidence: 1 } }), 'Main Checking')];
    expect(flagDuplicates(fps, seen)).toEqual([false]);
  });

  it('reports false — never true — for a row whose fingerprint is unknowable', () => {
    expect(flagDuplicates([null, null], seen)).toEqual([false, false]);
  });

  it('is account-sensitive: the same row on another account is not a duplicate', () => {
    const fps = [statementRowFingerprint(fieldsOf(), 'Rewards Card')];
    expect(flagDuplicates(fps, seen)).toEqual([false]);
  });

  it('does not pre-flag two identical charges inside one statement', () => {
    const fp = statementRowFingerprint(fieldsOf({ amount: { value: 3.5, confidence: 1 } }), 'Main Checking');
    expect(flagDuplicates([fp, fp], new Set())).toEqual([false, false]);
  });
});

describe('defaultStatementAccount', () => {
  it('uses the first managed account', () => {
    expect(defaultStatementAccount(['Main Checking', 'Cash'])).toBe('Main Checking');
  });

  it('skips blanks and trims', () => {
    expect(defaultStatementAccount(['  ', ' Everyday Visa '])).toBe('Everyday Visa');
  });

  it('falls back to the shared import default when none are managed', () => {
    expect(defaultStatementAccount([])).toBe('Imported account');
  });
});

// ---------------------------------------------------------------------------
// Proposal enrichment (sprint 13) — proposals arrive organized, not raw
// ---------------------------------------------------------------------------

describe('enrichStatementRows', () => {
  const RAW_UPI = 'UPI-SWIGGY LIMITED-swiggy@axis-402934857382-Payment';

  function rule(whenText: string, thenText: string, enabled = true): Rule {
    return {
      id: whenText + thenText,
      whenText,
      thenText,
      enabled,
      createdAt: '2026-01-01T00:00:00Z',
    };
  }

  const DINING_RULE = [rule('merchant contains swiggy', 'set category to Dining')];

  it('cleans the merchant but keeps the read confidence — the confidence still describes the read', () => {
    const [out] = enrichStatementRows(
      [fieldsOf({ merchant: { value: RAW_UPI, confidence: 0.8 } })],
      [],
      CATEGORIES,
    );
    expect(out.merchant).toEqual({ value: 'Swiggy Limited', confidence: 0.8 });
    // Nothing else moved.
    expect(out.date).toEqual({ value: '2026-03-04', confidence: 0.9 });
    expect(out.amount).toEqual({ value: 41.2, confidence: 0.95 });
    expect(out.type).toEqual({ value: 'expense', confidence: 0.99 });
  });

  // The composition the sprint exists for: the rule matches the CLEANED
  // merchant, so a rule written against "swiggy" fires on the raw descriptor.
  it('fills a null category from the user’s own rules, at confidence 1', () => {
    const [out] = enrichStatementRows(
      [
        fieldsOf({
          merchant: { value: RAW_UPI, confidence: 0.8 },
          category: { value: null, confidence: 0 },
        }),
      ],
      DINING_RULE,
      CATEGORIES,
    );
    // Confidence 1 is deliberate: a rule the user wrote or accepted is
    // deterministic user-authored knowledge, not model output — it must not
    // trip the review screen's low-confidence markers.
    expect(out.category).toEqual({ value: 'Dining', confidence: 1 });
  });

  it('leaves a null category exactly as-was when no rule fires — the Needs-review fallback stays honest', () => {
    const [out] = enrichStatementRows(
      [
        fieldsOf({
          merchant: { value: 'Tesco', confidence: 0.8 },
          category: { value: null, confidence: 0 },
        }),
      ],
      DINING_RULE,
      CATEGORIES,
    );
    expect(out.category).toEqual({ value: null, confidence: 0 });
  });

  // Spec §8.1.6 — rules FILL, they never overrule a grounded model category.
  it('never overwrites a managed category, even when a rule matches the merchant', () => {
    const [out] = enrichStatementRows(
      [fieldsOf({ merchant: { value: RAW_UPI, confidence: 0.8 } })],
      DINING_RULE,
      CATEGORIES,
    );
    expect(out.category).toEqual({ value: 'Groceries', confidence: 0.7 });
  });

  it('replaces an unmanaged category only when a rule fires', () => {
    const unmanaged = (merchant: string): StatementRowFields => ({
      ...fieldsOf({ merchant: { value: merchant, confidence: 0.8 } }),
      category: { value: 'Food', confidence: 0.4 },
    });
    const [ruled] = enrichStatementRows([unmanaged(RAW_UPI)], DINING_RULE, CATEGORIES);
    expect(ruled.category).toEqual({ value: 'Dining', confidence: 1 });

    const [unruled] = enrichStatementRows([unmanaged('Tesco')], DINING_RULE, CATEGORIES);
    expect(unruled.category).toEqual({ value: 'Food', confidence: 0.4 });
  });

  it('a disabled rule fills nothing', () => {
    const [out] = enrichStatementRows(
      [
        fieldsOf({
          merchant: { value: RAW_UPI, confidence: 0.8 },
          category: { value: null, confidence: 0 },
        }),
      ],
      [rule('merchant contains swiggy', 'set category to Dining', false)],
      CATEGORIES,
    );
    expect(out.category).toEqual({ value: null, confidence: 0 });
  });

  it('an unreadable merchant stays null and matches no rule', () => {
    const [out] = enrichStatementRows(
      [
        fieldsOf({
          merchant: { value: null, confidence: 0 },
          category: { value: null, confidence: 0 },
        }),
      ],
      DINING_RULE,
      CATEGORIES,
    );
    expect(out.merchant).toEqual({ value: null, confidence: 0 });
    expect(out.category).toEqual({ value: null, confidence: 0 });
  });

  // The cleaned merchant is what fingerprints are built from downstream —
  // enrichment must precede the duplicate pass (pinned end-to-end in
  // tests/statementResume.test.ts).
  it('the enriched row fingerprints on the cleaned name', () => {
    const [out] = enrichStatementRows(
      [fieldsOf({ merchant: { value: RAW_UPI, confidence: 0.8 } })],
      [],
      CATEGORIES,
    );
    expect(statementRowFingerprint(out, 'Main Checking')).toBe(
      txFingerprint('2026-03-04', 'Swiggy Limited', 41.2, 'Main Checking'),
    );
  });
});

// ---------------------------------------------------------------------------
// Provider and file-type gates
// ---------------------------------------------------------------------------

function settingsWith(overrides: Partial<Settings>): Settings {
  return { ...defaultSettings(), ...overrides };
}

// Sarvam joined Anthropic as a statement-capable provider in sprint 10 — its
// gating matrix lives in tests/sarvam.test.ts; the cases here pin that the
// original refusals and the Anthropic path are unchanged.
describe('selectStatementProvider — BYOK-only, and says why', () => {
  it('names the reason when Workers AI is selected', () => {
    const settings = settingsWith({ aiProvider: 'workers-ai' });
    expect(() => selectStatementProvider(settings)).toThrowError(/can't read PDFs yet/i);
    try {
      selectStatementProvider(settings);
    } catch (err) {
      expect(err).toMatchObject({ status: 400 });
    }
  });

  it("refuses when no provider is enabled — 'off' is the default", () => {
    expect(() => selectStatementProvider(defaultSettings())).toThrowError(/Enable an AI provider/i);
  });

  it('refuses anthropic without a stored key', () => {
    const settings = settingsWith({ aiProvider: 'anthropic', aiKeySet: false });
    expect(() => selectStatementProvider(settings)).toThrowError(/Anthropic API key/i);
  });

  it('accepts anthropic with a key, honouring a model override', () => {
    expect(
      selectStatementProvider(settingsWith({ aiProvider: 'anthropic', aiKeySet: true })).provider,
    ).toBe('anthropic');
    expect(
      selectStatementProvider(
        settingsWith({ aiProvider: 'anthropic', aiKeySet: true, aiModel: ' claude-sonnet-5 ' }),
      ).model,
    ).toBe('claude-sonnet-5');
  });
});

describe('assertStatementMime — PDFs only, CSVs redirected', () => {
  it('accepts a PDF, parameters and all', () => {
    expect(() => assertStatementMime('application/pdf')).not.toThrow();
    expect(() => assertStatementMime('application/pdf; version=1.7')).not.toThrow();
  });

  // CSV import is deterministic and free — sending it to a model would be a
  // worse answer at a higher price.
  it('points CSV users at the deterministic importer', () => {
    expect(() => assertStatementMime('text/csv')).toThrowError(/Transactions page/i);
    try {
      assertStatementMime('text/csv');
    } catch (err) {
      expect(err).toMatchObject({ status: 400 });
    }
  });

  it('refuses images — a statement is not a receipt photo', () => {
    for (const mime of ['image/png', 'image/jpeg', 'application/zip', '']) {
      expect(() => assertStatementMime(mime)).toThrowError(/PDF statements/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Fake D1 — scoped to exactly the statements the write paths issue.
// ---------------------------------------------------------------------------

interface Tables {
  documents: Record<string, unknown>[];
  statement_extractions: Record<string, unknown>[];
  statement_rows: Record<string, unknown>[];
  transactions: Record<string, unknown>[];
  tags: Record<string, unknown>[];
  rules: Record<string, unknown>[];
}

interface Hooks {
  /** Fires after the claim's SELECT — lets a test land a competing write. */
  afterClaimRead?: () => void;
}

function fakeDb(seed: Partial<Tables> = {}, hooks: Hooks = {}) {
  const t: Tables = {
    documents: [],
    statement_extractions: [],
    statement_rows: [],
    transactions: [],
    tags: [],
    rules: [],
    ...seed,
  };

  function exec(sql: string, args: unknown[]): { rows: Record<string, unknown>[]; changes: number } {
    // --- documents -------------------------------------------------------
    if (/FROM documents WHERE id = \?/i.test(sql)) {
      return { rows: t.documents.filter((d) => d.id === args[0]), changes: 0 };
    }
    if (/UPDATE documents SET status/i.test(sql)) {
      let changes = 0;
      for (const d of t.documents) {
        if (d.id === args[0]) {
          d.status = 'stored';
          changes++;
        }
      }
      return { rows: [], changes };
    }

    // --- statement_extractions -------------------------------------------
    if (/SELECT status, updatedAt FROM statement_extractions/i.test(sql)) {
      // Copied, not referenced: a hook that rewrites the row must not
      // retroactively change what this read returned.
      const rows = t.statement_extractions
        .filter((j) => j.documentId === args[0])
        .map((j) => ({ ...j }));
      hooks.afterClaimRead?.();
      return { rows, changes: 0 };
    }
    if (/^SELECT .* FROM statement_extractions WHERE documentId = \?/is.test(sql)) {
      return { rows: t.statement_extractions.filter((j) => j.documentId === args[0]), changes: 0 };
    }
    if (/UPDATE statement_extractions/i.test(sql)) {
      // ... SET status='pending', provider=?, model=?, error=NULL, updatedAt=?
      //     WHERE documentId=? AND updatedAt=?
      const [provider, model, now, documentId, expected] = args as string[];
      let changes = 0;
      for (const j of t.statement_extractions) {
        if (j.documentId === documentId && j.updatedAt === expected) {
          Object.assign(j, { status: 'pending', provider, model, error: null, updatedAt: now });
          changes++;
        }
      }
      return { rows: [], changes };
    }
    if (/INSERT INTO statement_extractions/i.test(sql)) {
      const documentId = args[0] as string;
      const existing = t.statement_extractions.find((j) => j.documentId === documentId);
      if (/DO NOTHING/i.test(sql)) {
        if (existing) return { rows: [], changes: 0 };
        const [, provider, model, createdAt, updatedAt] = args as string[];
        t.statement_extractions.push({
          documentId,
          status: 'pending',
          rowCount: 0,
          truncated: 0,
          provider,
          model,
          error: null,
          createdAt,
          updatedAt,
        });
        return { rows: [], changes: 1 };
      }
      // The two DO UPDATE forms differ only in how many columns they carry.
      const status = args[1] as string;
      const updatedAt = args[args.length - 1] as string;
      if (existing) {
        Object.assign(existing, { status, error: null, updatedAt });
      } else {
        t.statement_extractions.push({
          documentId,
          status,
          rowCount: 0,
          truncated: 0,
          provider: '',
          model: '',
          error: null,
          createdAt: updatedAt,
          updatedAt,
        });
      }
      return { rows: [], changes: 1 };
    }

    // --- statement_rows ---------------------------------------------------
    if (/SELECT COUNT\(\*\) AS n FROM statement_rows/i.test(sql)) {
      const n = t.statement_rows.filter(
        (r) => r.documentId === args[0] && r.status === 'proposed',
      ).length;
      return { rows: [{ n }], changes: 0 };
    }
    if (/SELECT id FROM statement_rows/i.test(sql)) {
      return {
        rows: t.statement_rows
          .filter((r) => r.documentId === args[0] && r.status === 'proposed')
          .map((r) => ({ id: r.id })),
        changes: 0,
      };
    }
    if (/UPDATE statement_rows SET status = \?/i.test(sql)) {
      const [status, documentId, ...ids] = args as string[];
      let changes = 0;
      for (const r of t.statement_rows) {
        if (r.documentId === documentId && ids.includes(r.id as string)) {
          r.status = status;
          changes++;
        }
      }
      return { rows: [], changes };
    }

    // --- transactions / tags / rules --------------------------------------
    if (/SELECT fingerprint FROM transactions/i.test(sql)) {
      return {
        rows: t.transactions
          .filter((x) => (args as string[]).includes(x.fingerprint as string))
          .map((x) => ({ fingerprint: x.fingerprint })),
        changes: 0,
      };
    }
    if (/INSERT INTO transactions/i.test(sql)) {
      t.transactions.push({ id: args[0], date: args[1], merchant: args[2], fingerprint: args[10] });
      return { rows: [], changes: 1 };
    }
    if (/FROM rules/i.test(sql)) return { rows: t.rules, changes: 0 };
    if (/SELECT name FROM tags/i.test(sql)) return { rows: t.tags, changes: 0 };
    if (/INSERT OR IGNORE INTO tags/i.test(sql)) {
      t.tags.push({ name: args[0] });
      return { rows: [], changes: 1 };
    }

    throw new Error(`fake D1 has no handler for: ${sql}`);
  }

  interface Stmt {
    sql: string;
    args: unknown[];
    bind(...values: unknown[]): Stmt;
    all<T>(): Promise<{ results: T[] }>;
    first<T>(): Promise<T | null>;
    run(): Promise<{ meta: { changes: number } }>;
  }

  function statement(sql: string, args: unknown[] = []): Stmt {
    return {
      sql,
      args,
      bind: (...values: unknown[]) => statement(sql, values),
      all: async <T,>() => ({ results: exec(sql, args).rows as T[] }),
      first: async <T,>() => (exec(sql, args).rows[0] as T | undefined) ?? null,
      run: async () => ({ meta: { changes: exec(sql, args).changes } }),
    };
  }

  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Stmt[]) => {
      for (const s of statements) exec(s.sql, s.args);
      return [];
    },
  } as unknown as D1Database;

  return { db, tables: t };
}

// ---------------------------------------------------------------------------
// The in-flight guard
// ---------------------------------------------------------------------------

describe('claimStatement — one metered multi-page call per document at a time', () => {
  const NOW = '2026-08-06T12:00:00.000Z';
  const DOC = 'doc-1';

  function stampedBefore(seconds: number): string {
    return new Date(Date.parse(NOW) - seconds * 1000).toISOString();
  }

  function job(overrides: Record<string, unknown>) {
    return {
      documentId: DOC,
      status: 'suggested',
      rowCount: 3,
      truncated: 0,
      provider: 'anthropic',
      model: 'claude-opus-5',
      error: null,
      createdAt: stampedBefore(600),
      updatedAt: stampedBefore(600),
      ...overrides,
    };
  }

  it('claims a document that was never extracted', async () => {
    const { db, tables } = fakeDb();
    await claimStatement(db, DOC, 'anthropic', 'claude-opus-5', NOW);
    expect(tables.statement_extractions).toHaveLength(1);
    expect(tables.statement_extractions[0]).toMatchObject({ status: 'pending', updatedAt: NOW });
  });

  it('refuses a second run while the first is still in flight', async () => {
    const { db } = fakeDb({ statement_extractions: [job({ status: 'pending', updatedAt: stampedBefore(30) })] });
    await expect(claimStatement(db, DOC, 'anthropic', 'm', NOW)).rejects.toMatchObject({
      status: 409,
    });
  });

  // A crashed worker must not strand the document forever.
  it('re-claims after the window expires', async () => {
    const { db, tables } = fakeDb({
      statement_extractions: [job({ status: 'pending', updatedAt: stampedBefore(10 * 60) })],
    });
    await claimStatement(db, DOC, 'anthropic', 'm', NOW);
    expect(tables.statement_extractions[0]).toMatchObject({ status: 'pending', updatedAt: NOW });
  });

  it('re-runs immediately from any settled status', async () => {
    for (const status of ['suggested', 'partial', 'failed', 'confirmed', 'dismissed']) {
      const { db, tables } = fakeDb({ statement_extractions: [job({ status })] });
      await claimStatement(db, DOC, 'anthropic', 'm', NOW);
      expect(tables.statement_extractions[0]).toMatchObject({ status: 'pending' });
    }
  });

  // The claim is conditional on the exact row this request read, so when two
  // POSTs race, one claim lands and the other sees no change — same 409 either
  // way. The hook lands the competing write between this call's read and write.
  it('409s when another request claimed the row first', async () => {
    const rows = [job({})];
    let raced = false;
    const { db, tables } = fakeDb(
      { statement_extractions: rows },
      {
        afterClaimRead: () => {
          if (raced) return;
          raced = true;
          rows[0].status = 'pending';
          rows[0].updatedAt = NOW;
        },
      },
    );
    await expect(claimStatement(db, DOC, 'anthropic', 'm', NOW)).rejects.toMatchObject({
      status: 409,
    });
    // The winner's claim is intact — the loser overwrote nothing.
    expect(tables.statement_extractions[0]).toMatchObject({ status: 'pending', updatedAt: NOW });
  });

  it('keeps the previous run’s row count while the re-run is in flight', async () => {
    const { db, tables } = fakeDb({ statement_extractions: [job({ rowCount: 42 })] });
    await claimStatement(db, DOC, 'anthropic', 'm', NOW);
    expect(tables.statement_extractions[0].rowCount).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Confirm-time validation
// ---------------------------------------------------------------------------

describe('confirmStatementRows', () => {
  const DOC = 'doc-1';

  function seeded(rows: { id: string; date: string; amount: number; merchant: string }[]) {
    return fakeDb({
      documents: [{ id: DOC, mimeType: 'application/pdf', objectKey: 'k', size: 10, status: 'review' }],
      statement_extractions: [
        {
          documentId: DOC,
          status: 'suggested',
          rowCount: rows.length,
          truncated: 0,
          provider: 'anthropic',
          model: 'claude-opus-5',
          error: null,
          createdAt: '2026-08-06T11:00:00.000Z',
          updatedAt: '2026-08-06T11:00:00.000Z',
        },
      ],
      statement_rows: rows.map((r, i) => ({
        id: r.id,
        documentId: DOC,
        idx: i,
        fields: JSON.stringify(
          normalizeStatementRow(
            modelRow({
              date: { value: r.date, confidence: 0.9 },
              amount: { value: r.amount, confidence: 0.9 },
              merchant: { value: r.merchant, confidence: 0.9 },
            }),
            CATEGORIES,
          ),
        ),
        status: 'proposed',
        duplicate: 0,
        lowestConfidence: 0.7,
        createdAt: '2026-08-06T11:00:00.000Z',
      })),
    });
  }

  const ROWS = [
    { id: 'r1', date: '2026-03-01', amount: 41.2, merchant: 'Tesco' },
    { id: 'r2', date: '2026-03-02', amount: 9.5, merchant: 'Shell' },
  ];

  function payload(rowId: string, overrides: Record<string, unknown> = {}) {
    return {
      rowId,
      date: '2026-03-01',
      merchant: 'Tesco',
      amount: 41.2,
      type: 'expense',
      category: 'Groceries',
      account: 'Main Checking',
      ...overrides,
    };
  }

  function env(db: D1Database): Env {
    return { DB: db } as unknown as Env;
  }

  it('rejects a body that is not a rows list', async () => {
    const { db } = seeded(ROWS);
    for (const bad of [null, 'rows', 42, {}, { rows: 'r1' }]) {
      await expect(confirmStatementRows(env(db), DOC, bad)).rejects.toMatchObject({ status: 400 });
    }
  });

  it('rejects an empty selection', async () => {
    const { db } = seeded(ROWS);
    await expect(confirmStatementRows(env(db), DOC, { rows: [] })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('rejects a rowId that is not awaiting review', async () => {
    const { db } = seeded(ROWS);
    for (const rowId of ['', '   ', 'nope']) {
      await expect(
        confirmStatementRows(env(db), DOC, { rows: [payload(rowId)] }),
      ).rejects.toThrowError(/no longer awaiting review/i);
    }
  });

  it('rejects the same row sent twice', async () => {
    const { db } = seeded(ROWS);
    await expect(
      confirmStatementRows(env(db), DOC, { rows: [payload('r1'), payload('r1')] }),
    ).rejects.toThrowError(/sent twice/i);
  });

  // Nothing the user edited is trusted either — the same boundary validation
  // every other import path gets, with the row named so the UI can point at it.
  it('rejects an edited row that is no longer valid, and inserts nothing', async () => {
    const bad: [string, RegExp][] = [
      ['date', /date must be a real/i],
      ['merchant', /merchant is required/i],
      ['amount', /amount must be a positive number/i],
      ['type', /type must be/i],
    ];
    for (const [field, message] of bad) {
      const { db, tables } = seeded(ROWS);
      const broken =
        field === 'date'
          ? { date: '2026-02-30' }
          : field === 'merchant'
            ? { merchant: '   ' }
            : field === 'amount'
              ? { amount: -3 }
              : { type: 'debit' };
      await expect(
        confirmStatementRows(env(db), DOC, { rows: [payload('r1', broken)] }),
      ).rejects.toThrowError(message);
      expect(tables.transactions).toHaveLength(0);
      expect(tables.statement_rows[0].status).toBe('proposed');
    }
  });

  it('inserts the selected row as a document-sourced, non-receipt transaction', async () => {
    const { db, tables } = seeded(ROWS);
    const result = await confirmStatementRows(env(db), DOC, { rows: [payload('r1')] });
    expect(result.inserted).toBe(1);
    expect(result.duplicates).toBe(0);
    expect(result.insertedRows[0]).toMatchObject({ source: 'document', receipt: false });
    expect(tables.statement_rows[0].status).toBe('confirmed');
  });

  it('leaves the rows the user did not send as proposed, and the job unfinished', async () => {
    const { db, tables } = seeded(ROWS);
    await confirmStatementRows(env(db), DOC, { rows: [payload('r1')] });
    expect(tables.statement_rows[1].status).toBe('proposed');
    expect(tables.statement_extractions[0].status).toBe('suggested');
    expect(tables.documents[0].status).toBe('review');
  });

  it('flips the job to confirmed once no proposed rows remain', async () => {
    const { db, tables } = seeded(ROWS);
    await confirmStatementRows(env(db), DOC, {
      rows: [payload('r1'), payload('r2', { date: '2026-03-02', merchant: 'Shell', amount: 9.5 })],
    });
    expect(tables.statement_extractions[0].status).toBe('confirmed');
    expect(tables.documents[0].status).toBe('stored');
  });

  // A row that is already in the ledger is not an error — the transaction the
  // user wanted exists, it was just already there.
  it('reports a duplicate honestly instead of failing', async () => {
    const { db, tables } = seeded(ROWS);
    tables.transactions.push({
      id: 'existing',
      fingerprint: txFingerprint('2026-03-01', 'Tesco', 41.2, 'Main Checking'),
    });
    const result = await confirmStatementRows(env(db), DOC, { rows: [payload('r1')] });
    expect(result.inserted).toBe(0);
    expect(result.duplicates).toBe(1);
    expect(result.errors).toEqual([]);
    // Still confirmed: the user's row made it into the ledger, once.
    expect(tables.statement_rows[0].status).toBe('confirmed');
  });

  it('404s for a document that no longer exists', async () => {
    const { db } = seeded(ROWS);
    await expect(
      confirmStatementRows(env(db), 'gone', { rows: [payload('r1')] }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a selection larger than the cap', async () => {
    const { db } = seeded(ROWS);
    const rows = Array.from({ length: MAX_STATEMENT_ROWS + 1 }, () => payload('r1'));
    await expect(confirmStatementRows(env(db), DOC, { rows })).rejects.toThrowError(/at most/i);
  });
});
