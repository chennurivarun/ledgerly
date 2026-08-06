import { describe, expect, it } from 'vitest';
import {
  buildStatementConfirmInput,
  canRowBeSelected,
  isRowLowConfidence,
  missingRowFields,
  rowLowConfidenceFields,
  seedStatementRowDraft,
  type StatementRowDraft,
} from '../src/components/ai/statementHelpers';
import type { ExtractedField, StatementRow, TxType } from '../shared/types';

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

describe('rowLowConfidenceFields / isRowLowConfidence', () => {
  it('flags nothing for a fully confident row', () => {
    expect(rowLowConfidenceFields(row())).toEqual([]);
    expect(isRowLowConfidence(row())).toBe(false);
  });

  it('flags a null value even with high confidence', () => {
    const r = row({ amount: field<number>(null, 0.99) });
    expect(rowLowConfidenceFields(r)).toEqual(['amount']);
    expect(isRowLowConfidence(r)).toBe(true);
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
});

describe('missingRowFields / canRowBeSelected', () => {
  const complete = { date: '2026-08-01', merchant: 'Coffee Shop', amount: '12.50' };

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

  it('reports every missing field at once', () => {
    expect(missingRowFields({ date: '', merchant: '', amount: '' })).toEqual([
      'date',
      'merchant',
      'amount',
    ]);
  });
});

describe('seedStatementRowDraft', () => {
  const categories = ['Housing', 'Dining', 'Needs review'];

  it('seeds every field from a confident, non-duplicate row and defaults to checked', () => {
    const draft = seedStatementRowDraft(row(), categories);
    expect(draft).toEqual({
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
    const draft = seedStatementRowDraft(
      row({ date: field<string>(null, 0.9), amount: field<number>(null, 0.9) }),
      categories,
    );
    expect(draft.date).toBe('');
    expect(draft.amount).toBe('');
    expect(draft.selected).toBe(false);
  });

  it('duplicate rows start UNCHECKED even when complete', () => {
    const draft = seedStatementRowDraft(row({ duplicate: true }), categories);
    expect(draft.selected).toBe(false);
  });

  it('defaults type to expense when unset', () => {
    const draft = seedStatementRowDraft(row({ type: field<TxType>(null, 0.9) }), categories);
    expect(draft.type).toBe('expense');
  });

  it('never invents a category: unmatched suggestion falls back to Needs review when present', () => {
    const draft = seedStatementRowDraft(row({ category: field('Travel', 0.95) }), categories);
    expect(draft.category).toBe('Needs review');
  });

  it('never invents a category: seeds empty when Needs review is unavailable, forcing an explicit choice', () => {
    const draft = seedStatementRowDraft(row({ category: field('Travel', 0.95) }), ['Housing', 'Dining']);
    expect(draft.category).toBe('');
  });
});

describe('buildStatementConfirmInput', () => {
  it('assembles the confirm payload, rounded to cents, with the batch account applied', () => {
    const rows = [row(), row({ id: 'row-2', merchant: field('Grocery Store'), amount: field(45.999) })];
    const drafts: Record<string, StatementRowDraft> = {
      'row-1': {
        id: 'row-1',
        date: '2026-08-01',
        merchant: '  Coffee Shop  ',
        amount: '12.567',
        type: 'expense',
        category: 'Dining',
        selected: true,
      },
      'row-2': {
        id: 'row-2',
        date: '2026-08-02',
        merchant: 'Grocery Store',
        amount: '45.999',
        type: 'expense',
        category: '',
        selected: true,
      },
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
          receipt: true,
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
          receipt: true,
          source: 'document',
        },
      ],
    });
  });
});
