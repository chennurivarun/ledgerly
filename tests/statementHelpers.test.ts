import { describe, expect, it } from 'vitest';
import {
  applyDraftPatch,
  buildStatementConfirmInput,
  canRowBeSelected,
  filterBySnapshot,
  isCleanOutcome,
  missingRowFields,
  resumableStatementIds,
  rowLowConfidenceFields,
  seedStatementRowDraft,
  selectableRows,
  statementProgressLabel,
  visibleLowConfidenceFields,
  type StatementRowDraft,
} from '../src/components/ai/statementHelpers';
import type {
  BatchInsertResult,
  ExtractedField,
  StatementExtraction,
  StatementRow,
  TxType,
} from '../shared/types';

function field<T>(value: T | null, confidence = 0.9): ExtractedField<T> {
  return { value, confidence };
}

function row(overrides: Partial<StatementRow> = {}): StatementRow {
  return {
    id: 'row-1',
    documentId: 'doc-1',
    index: 0,
    date: field('2026-08-01'),
    merchant: field('Coffee Shop'),
    amount: field(12.5),
    type: field<TxType>('expense'),
    category: field('Dining'),
    status: 'proposed',
    duplicate: false,
    lowestConfidence: 0.9,
    ...overrides,
  };
}

function draft(overrides: Partial<StatementRowDraft> = {}): StatementRowDraft {
  return {
    id: 'row-1',
    date: '2026-08-01',
    merchant: 'Coffee Shop',
    amount: '12.50',
    type: 'expense',
    category: 'Dining',
    selected: true,
    ...overrides,
  };
}

function insertResult(overrides: Partial<BatchInsertResult> = {}): BatchInsertResult {
  return { inserted: 0, duplicates: 0, insertedRows: [], errors: [], ...overrides };
}

describe('rowLowConfidenceFields', () => {
  it('flags nothing for a fully confident row', () => {
    expect(rowLowConfidenceFields(row())).toEqual([]);
  });

  it('flags a null value even with high confidence', () => {
    const r = row({ amount: field<number>(null, 0.99) });
    expect(rowLowConfidenceFields(r)).toEqual(['amount']);
  });

  it('flags confidence below the 0.6 threshold', () => {
    const r = row({ merchant: field('Coffee Shop', 0.5) });
    expect(rowLowConfidenceFields(r)).toEqual(['merchant']);
  });

  it('treats non-finite or missing confidence as LOW, never implicitly high', () => {
    const r = row({ date: { value: '2026-08-01' } as unknown as ExtractedField<string> });
    expect(rowLowConfidenceFields(r)).toEqual(['date']);
  });

  it('collects every flagged field, not just the first', () => {
    const r = row({
      date: field<string>(null, 0.9),
      category: field('Dining', 0.1),
    });
    expect(rowLowConfidenceFields(r)).toEqual(['date', 'category']);
  });

  it('flags a low-confidence type', () => {
    const r = row({ type: field<TxType>('expense', 0.3) });
    expect(rowLowConfidenceFields(r)).toEqual(['type']);
  });
});

describe('visibleLowConfidenceFields', () => {
  const categories = ['Housing', 'Dining', 'Needs review'];

  it('shows a flagged field while the draft still matches the AI suggestion', () => {
    const r = row({ merchant: field('Coffee Shop', 0.3) });
    const d = draft({ merchant: 'Coffee Shop' }); // unedited — matches r.merchant.value
    expect(visibleLowConfidenceFields(r, d, categories)).toEqual(['merchant']);
  });

  it('clears the marker once the user edits that field away from the suggestion', () => {
    const r = row({ merchant: field('Coffee Shop', 0.3) });
    const d = draft({ merchant: 'Corrected Merchant' }); // edited
    expect(visibleLowConfidenceFields(r, d, categories)).toEqual([]);
  });

  it('clears per-field independently — editing one flagged field leaves another visible', () => {
    const r = row({ merchant: field('Coffee Shop', 0.3), date: field('2026-08-01', 0.2) });
    const d = draft({ merchant: 'Corrected Merchant', date: '2026-08-01' });
    expect(visibleLowConfidenceFields(r, d, categories)).toEqual(['date']);
  });

  it('a null-seeded field stays visible until the user fills something in', () => {
    const r = row({ amount: field<number>(null, 0.9) });
    const d = draft({ amount: '' }); // still blank, matches the null seed
    expect(visibleLowConfidenceFields(r, d, categories)).toEqual(['amount']);
    const edited = draft({ amount: '12.50' });
    expect(visibleLowConfidenceFields(r, edited, categories)).toEqual([]);
  });

  it('category comparison accounts for suggestion resolution, not a raw string match', () => {
    const r = row({ category: field('Travel', 0.2) }); // unmatched suggestion
    // resolveCategorySuggestion('Travel', categories) => 'Needs review' (present in the list)
    const seeded = draft({ category: 'Needs review' });
    expect(visibleLowConfidenceFields(r, seeded, categories)).toEqual(['category']);
    const edited = draft({ category: 'Dining' });
    expect(visibleLowConfidenceFields(r, edited, categories)).toEqual([]);
  });

  it('type comparison respects the never-guess blank seed', () => {
    const r = row({ type: field<TxType>(null, 0.9) });
    const seeded = draft({ type: '' });
    expect(visibleLowConfidenceFields(r, seeded, categories)).toEqual(['type']);
    const picked = draft({ type: 'income' });
    expect(visibleLowConfidenceFields(r, picked, categories)).toEqual([]);
  });
});

describe('missingRowFields / canRowBeSelected', () => {
  const complete = { date: '2026-08-01', merchant: 'Coffee Shop', amount: '12.50', type: 'expense' as TxType | '' };

  it('passes a complete draft', () => {
    expect(missingRowFields(complete)).toEqual([]);
    expect(canRowBeSelected(complete)).toBe(true);
  });

  it('flags a blank date — never guesses one', () => {
    expect(missingRowFields({ ...complete, date: '' })).toEqual(['date']);
    expect(canRowBeSelected({ ...complete, date: '' })).toBe(false);
  });

  it('flags a non-real date', () => {
    expect(missingRowFields({ ...complete, date: '2026-02-30' })).toEqual(['date']);
  });

  it('flags a blank merchant', () => {
    expect(missingRowFields({ ...complete, merchant: '  ' })).toEqual(['merchant']);
  });

  it('flags a blank amount — never guesses one, and blocks selection', () => {
    expect(missingRowFields({ ...complete, amount: '' })).toEqual(['amount']);
    expect(canRowBeSelected({ ...complete, amount: '' })).toBe(false);
  });

  it('flags a zero, negative, or non-numeric amount', () => {
    expect(missingRowFields({ ...complete, amount: '0' })).toEqual(['amount']);
    expect(missingRowFields({ ...complete, amount: '-5' })).toEqual(['amount']);
    expect(missingRowFields({ ...complete, amount: 'abc' })).toEqual(['amount']);
  });

  it('flags a sub-cent amount that rounds to 0 — a naive `> 0` check would miss this', () => {
    expect(missingRowFields({ ...complete, amount: '0.004' })).toEqual(['amount']);
    expect(missingRowFields({ ...complete, amount: '0.001' })).toEqual(['amount']);
  });

  it('accepts an amount that rounds to at least one cent', () => {
    expect(missingRowFields({ ...complete, amount: '0.01' })).toEqual([]);
  });

  it('flags an unset type — never guesses "expense"', () => {
    expect(missingRowFields({ ...complete, type: '' })).toEqual(['type']);
    expect(canRowBeSelected({ ...complete, type: '' })).toBe(false);
  });

  it('reports every missing field at once', () => {
    expect(missingRowFields({ date: '', merchant: '', amount: '', type: '' })).toEqual([
      'date',
      'merchant',
      'amount',
      'type',
    ]);
  });
});

describe('seedStatementRowDraft', () => {
  const categories = ['Housing', 'Dining', 'Needs review'];

  it('seeds every field from a confident, non-duplicate row and defaults to checked', () => {
    const d = seedStatementRowDraft(row(), categories);
    expect(d).toEqual({
      id: 'row-1',
      date: '2026-08-01',
      merchant: 'Coffee Shop',
      amount: '12.5',
      type: 'expense',
      category: 'Dining',
      selected: true,
    });
  });

  it('never invents a missing date or amount — they start blank and block selection', () => {
    const d = seedStatementRowDraft(
      row({ date: field<string>(null, 0.9), amount: field<number>(null, 0.9) }),
      categories,
    );
    expect(d.date).toBe('');
    expect(d.amount).toBe('');
    expect(d.selected).toBe(false);
  });

  it('never guesses a null type as "expense": seeds "", blocks selection until the user picks one', () => {
    const d = seedStatementRowDraft(row({ type: field<TxType>(null, 0.9) }), categories);
    expect(d.type).toBe('');
    expect(d.selected).toBe(false);
    expect(canRowBeSelected(d)).toBe(false);
    // Picking a type is enough to make the row selectable again (date/merchant/amount already valid).
    expect(canRowBeSelected({ ...d, type: 'expense' })).toBe(true);
  });

  it('duplicate rows start UNCHECKED even when complete', () => {
    const d = seedStatementRowDraft(row({ duplicate: true }), categories);
    expect(d.selected).toBe(false);
  });

  it('never invents a category: unmatched suggestion falls back to Needs review when present', () => {
    const d = seedStatementRowDraft(row({ category: field('Travel', 0.95) }), categories);
    expect(d.category).toBe('Needs review');
  });

  it('never invents a category: seeds empty AND stays selectable — category never blocks selection', () => {
    const noReview = ['Housing', 'Dining'];
    const d = seedStatementRowDraft(row({ category: field('Travel', 0.95) }), noReview);
    expect(d.category).toBe('');
    expect(d.selected).toBe(true);
  });
});

describe('applyDraftPatch', () => {
  it('applies the patch normally when the row stays complete', () => {
    const current = draft({ selected: true });
    const next = applyDraftPatch(current, { merchant: 'New Name' });
    expect(next.merchant).toBe('New Name');
    expect(next.selected).toBe(true);
  });

  it('force-unchecks a checked row when an edit makes it incomplete', () => {
    const current = draft({ selected: true });
    const next = applyDraftPatch(current, { amount: '' });
    expect(next.amount).toBe('');
    expect(next.selected).toBe(false);
  });

  it('force-unchecks when a patch blanks the type', () => {
    const current = draft({ selected: true });
    const next = applyDraftPatch(current, { type: '' });
    expect(next.selected).toBe(false);
  });

  it('cannot be used to select an incomplete row — selected stays false even if the patch says true', () => {
    const current = draft({ selected: false, amount: '' });
    const next = applyDraftPatch(current, { selected: true });
    expect(next.selected).toBe(false);
  });

  it('a patch that completes a row still requires an explicit selected:true to check it', () => {
    const current = draft({ selected: false, amount: '' });
    const next = applyDraftPatch(current, { amount: '12.50' });
    expect(next.selected).toBe(false); // patch didn't touch `selected`, stays as-is
  });
});

describe('selectableRows', () => {
  it('includes only rows that are both checked and complete', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })];
    const drafts: Record<string, StatementRowDraft> = {
      a: draft({ id: 'a', selected: true }),
      b: draft({ id: 'b', selected: false }),
      c: draft({ id: 'c', selected: true, amount: '' }), // checked but incomplete
    };
    expect(selectableRows(rows, drafts).map((r) => r.id)).toEqual(['a']);
  });

  it('excludes a row with no draft at all', () => {
    const rows = [row({ id: 'a' })];
    expect(selectableRows(rows, {})).toEqual([]);
  });
});

describe('filterBySnapshot', () => {
  it('keeps a snapshot member visible regardless of its current flag/edit state', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' })];
    const snapshot = new Set(['a']);
    // filterBySnapshot only honors frozen id membership — it never looks at
    // whether row 'a' still has any low-confidence flags right now. This is
    // the fix for the mid-edit unmount: editing a snapshot member so its
    // flags clear must NOT drop it from the filtered view.
    expect(filterBySnapshot(rows, snapshot).map((r) => r.id)).toEqual(['a']);
  });

  it('drops a row not in the snapshot', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' })];
    expect(filterBySnapshot(rows, new Set(['b'])).map((r) => r.id)).toEqual(['b']);
  });

  it('returns the SAME array reference when snapshot is null (no filter active)', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' })];
    // Identity, not just equality, is load-bearing here: the modal's
    // visibleRows === pendingRows when no filter is active depends on this
    // function not allocating a new array in the unfiltered case.
    expect(filterBySnapshot(rows, null)).toBe(rows);
  });

  it('returns nothing for an empty snapshot', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' })];
    expect(filterBySnapshot(rows, new Set())).toEqual([]);
  });
});

describe('isCleanOutcome', () => {
  it('is clean when every attempted row was inserted with nothing skipped', () => {
    expect(isCleanOutcome(insertResult({ inserted: 3 }), 3)).toBe(true);
  });

  it('is not clean when any duplicate was skipped', () => {
    expect(isCleanOutcome(insertResult({ inserted: 2, duplicates: 1 }), 3)).toBe(false);
  });

  it('is not clean when any row errored', () => {
    expect(isCleanOutcome(insertResult({ inserted: 2, errors: ['boom'] }), 3)).toBe(false);
  });

  it('is not clean when inserted count falls short of attempted for any other reason', () => {
    expect(isCleanOutcome(insertResult({ inserted: 1 }), 3)).toBe(false);
  });
});

describe('buildStatementConfirmInput', () => {
  it('assembles the confirm payload, rounded to cents, with the batch account applied and receipt:false', () => {
    const rows = [row(), row({ id: 'row-2', merchant: field('Grocery Store'), amount: field(45.999) })];
    const drafts: Record<string, StatementRowDraft> = {
      'row-1': draft({ id: 'row-1', merchant: '  Coffee Shop  ', amount: '12.567' }),
      'row-2': draft({ id: 'row-2', date: '2026-08-02', merchant: 'Grocery Store', amount: '45.999', category: '' }),
    };
    const input = buildStatementConfirmInput(rows, drafts, 'Main Checking');
    expect(input).toEqual({
      rows: [
        {
          rowId: 'row-1',
          date: '2026-08-01',
          merchant: 'Coffee Shop',
          amount: 12.57,
          type: 'expense',
          category: 'Dining',
          account: 'Main Checking',
          receipt: false,
          source: 'document',
        },
        {
          rowId: 'row-2',
          date: '2026-08-02',
          merchant: 'Grocery Store',
          amount: 46,
          type: 'expense',
          category: undefined,
          account: 'Main Checking',
          receipt: false,
          source: 'document',
        },
      ],
    });
  });

  it('maps each row to its OWN draft by id — a subset in non-insertion order against a superset drafts map', () => {
    // 'c' deliberately excluded from `rows`, and order is reversed relative
    // to the drafts map's own key order — an index/position-based lookup
    // (instead of drafts[row.id]) would silently mismatch values here.
    const rows = [row({ id: 'b' }), row({ id: 'a' })];
    const drafts: Record<string, StatementRowDraft> = {
      a: draft({ id: 'a', date: '2026-08-01', merchant: 'A Corp', amount: '10.00', type: 'expense', category: '' }),
      b: draft({ id: 'b', date: '2026-08-02', merchant: 'B Corp', amount: '20.00', type: 'income', category: '' }),
      c: draft({ id: 'c', date: '2026-08-03', merchant: 'C Corp', amount: '30.00', type: 'expense', category: '' }),
    };
    const input = buildStatementConfirmInput(rows, drafts, 'Main Checking');
    expect(input.rows).toEqual([
      {
        rowId: 'b',
        date: '2026-08-02',
        merchant: 'B Corp',
        amount: 20,
        type: 'income',
        category: undefined,
        account: 'Main Checking',
        receipt: false,
        source: 'document',
      },
      {
        rowId: 'a',
        date: '2026-08-01',
        merchant: 'A Corp',
        amount: 10,
        type: 'expense',
        category: undefined,
        account: 'Main Checking',
        receipt: false,
        source: 'document',
      },
    ]);
  });

  it('throws naming the row when a draft is missing — a caller bug, not a value to guess around', () => {
    const rows = [row({ id: 'ghost' })];
    expect(() => buildStatementConfirmInput(rows, {}, 'Main Checking')).toThrow(/ghost/);
  });

  it('throws naming the row when the draft amount is invalid (defensive — caller should have filtered)', () => {
    const rows = [row({ id: 'row-1' })];
    const drafts = { 'row-1': draft({ amount: '0.001' }) };
    expect(() => buildStatementConfirmInput(rows, drafts, 'Main Checking')).toThrow(/row-1/);
  });

  it('throws naming the row when the draft type is unset (defensive — caller should have filtered)', () => {
    const rows = [row({ id: 'row-1' })];
    const drafts = { 'row-1': draft({ type: '' }) };
    expect(() => buildStatementConfirmInput(rows, drafts, 'Main Checking')).toThrow(/row-1/);
  });
});

// ---------------------------------------------------------------------------
// Resumable-read UI helpers (sprint 12)
// ---------------------------------------------------------------------------

function job(overrides: Partial<StatementExtraction> = {}): StatementExtraction {
  return {
    documentId: 'doc-1',
    status: 'pending',
    rowCount: 0,
    truncated: false,
    provider: 'sarvam',
    model: 'sarvam-doc-ai',
    error: null,
    createdAt: '2026-08-13T10:00:00.000Z',
    updatedAt: '2026-08-13T10:00:00.000Z',
    rows: [],
    progress: null,
    ...overrides,
  };
}

describe('statementProgressLabel — the pinned chip copy', () => {
  it('names the batch being read, 1-indexed for humans', () => {
    expect(statementProgressLabel({ done: 0, total: 3 })).toBe('Reading batch 1 of 3…');
    expect(statementProgressLabel({ done: 2, total: 3 })).toBe('Reading batch 3 of 3…');
    expect(statementProgressLabel({ done: 0, total: 1 })).toBe('Reading batch 1 of 1…');
  });

  it('done === total shows Finishing… — never "Reading batch N+1 of N…"', () => {
    expect(statementProgressLabel({ done: 3, total: 3 })).toBe('Finishing…');
    expect(statementProgressLabel({ done: 1, total: 1 })).toBe('Finishing…');
  });

  it('no progress → null, so pending chips without it keep their original copy', () => {
    expect(statementProgressLabel(null)).toBeNull();
  });
});

describe('resumableStatementIds — which pending jobs the tick driver advances', () => {
  it('picks exactly the pending jobs that carry progress', () => {
    const statements = [
      job({ documentId: 'tick-me', progress: { done: 0, total: 2 } }),
      // Pending WITHOUT progress is a blocking (anthropic) or legacy run —
      // POSTing at it would just 409 against the in-flight claim.
      job({ documentId: 'blocking-run', progress: null }),
      job({ documentId: 'settled', status: 'suggested', progress: null }),
      job({ documentId: 'also-tick', progress: { done: 1, total: 2 } }),
    ];
    expect(resumableStatementIds(statements)).toEqual(['tick-me', 'also-tick']);
  });

  it('a settled job with (stale) progress is never ticked — status gates first', () => {
    expect(
      resumableStatementIds([
        job({ documentId: 'x', status: 'failed', progress: { done: 1, total: 2 } }),
      ]),
    ).toEqual([]);
  });

  it('empty in, empty out', () => {
    expect(resumableStatementIds([])).toEqual([]);
  });
});
