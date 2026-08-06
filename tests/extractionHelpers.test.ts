import { describe, expect, it } from 'vitest';
import {
  buildTxInputFromDraft,
  isDocumentExtractable,
  isLowConfidence,
  isRealDateISO,
  resolveCategorySuggestion,
  seedExtractionDraft,
  validateExtractionDraft,
  type ExtractionDraft,
} from '../src/components/ai/extractionHelpers';
import type { ExtractedField, ExtractionResult, TxType } from '../shared/types';

function field<T>(value: T | null, confidence = 0.9): ExtractedField<T> {
  return { value, confidence };
}

function extraction(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    documentId: 'doc-1',
    status: 'suggested',
    merchant: field('Coffee Shop'),
    date: field('2026-08-01'),
    total: field(12.5),
    type: field<TxType>('expense'),
    category: field('Dining'),
    provider: 'workers-ai',
    model: 'llama-3',
    error: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('isLowConfidence', () => {
  it('flags a missing field', () => {
    expect(isLowConfidence(undefined)).toBe(true);
    expect(isLowConfidence(null)).toBe(true);
  });

  it('flags a null value even with high confidence', () => {
    expect(isLowConfidence(field(null, 0.99))).toBe(true);
  });

  it('flags confidence below the 0.6 threshold', () => {
    expect(isLowConfidence(field('x', 0.59))).toBe(true);
    expect(isLowConfidence(field('x', 0))).toBe(true);
  });

  it('does not flag confidence at or above the threshold with a real value', () => {
    expect(isLowConfidence(field('x', 0.6))).toBe(false);
    expect(isLowConfidence(field('x', 1))).toBe(false);
  });

  it('treats non-finite or missing confidence as LOW, never as implicitly high', () => {
    expect(isLowConfidence(field('x', NaN))).toBe(true);
    expect(isLowConfidence(field('x', Infinity))).toBe(true);
    expect(isLowConfidence(field('x', -Infinity))).toBe(true);
    // Malformed data crossing the JSON boundary — confidence missing entirely.
    expect(isLowConfidence({ value: 'x' } as unknown as ExtractedField<string>)).toBe(true);
  });
});

describe('isDocumentExtractable', () => {
  it('allows images and PDFs', () => {
    expect(isDocumentExtractable('image/jpeg')).toBe(true);
    expect(isDocumentExtractable('image/png')).toBe(true);
    expect(isDocumentExtractable('application/pdf')).toBe(true);
  });

  it('excludes everything else', () => {
    expect(isDocumentExtractable('text/csv')).toBe(false);
    expect(isDocumentExtractable('application/vnd.ms-excel')).toBe(false);
  });
});

describe('isRealDateISO', () => {
  it('accepts real calendar dates', () => {
    expect(isRealDateISO('2026-08-06')).toBe(true);
    expect(isRealDateISO('2024-02-29')).toBe(true); // leap year
  });

  it('rejects malformed or non-existent dates', () => {
    expect(isRealDateISO('')).toBe(false);
    expect(isRealDateISO('not-a-date')).toBe(false);
    expect(isRealDateISO('2026-02-30')).toBe(false);
    expect(isRealDateISO('2026-13-01')).toBe(false);
    expect(isRealDateISO('2025-02-29')).toBe(false); // not a leap year
  });
});

describe('resolveCategorySuggestion', () => {
  const categories = ['Housing', 'Dining', 'Needs review'];

  it('matches the suggestion case-insensitively', () => {
    expect(resolveCategorySuggestion('dining', categories)).toBe('Dining');
    expect(resolveCategorySuggestion('DINING', categories)).toBe('Dining');
  });

  it('falls back to Needs review when the suggestion has no match', () => {
    expect(resolveCategorySuggestion('Travel', categories)).toBe('Needs review');
    expect(resolveCategorySuggestion(null, categories)).toBe('Needs review');
  });

  it('never silently substitutes an unrelated category — seeds empty when Needs review is absent', () => {
    // Regression: a confident "Travel" suggestion must never quietly become
    // "Housing" (categories[0]) under a "Suggested by AI" footer — that's an
    // invented value, not a real fallback.
    expect(resolveCategorySuggestion('Travel', ['Housing', 'Dining'])).toBe('');
    expect(resolveCategorySuggestion(null, ['Housing', 'Dining'])).toBe('');
  });

  it('returns an empty string when there are no categories at all', () => {
    expect(resolveCategorySuggestion('Dining', [])).toBe('');
  });
});

describe('seedExtractionDraft', () => {
  const settings = { categories: ['Housing', 'Dining', 'Needs review'], accounts: ['Main Checking', 'Cash'] };

  it('seeds every field from a confident extraction', () => {
    const draft = seedExtractionDraft(extraction(), settings);
    expect(draft).toEqual({
      merchant: 'Coffee Shop',
      date: '2026-08-01',
      total: '12.5',
      type: 'expense',
      category: 'Dining',
      account: 'Main Checking',
      tags: [],
    });
  });

  it('never invents a missing date or total — they start blank', () => {
    const draft = seedExtractionDraft(
      extraction({ date: field<string>(null, 0.9), total: field<number>(null, 0.9) }),
      settings,
    );
    expect(draft.date).toBe('');
    expect(draft.total).toBe('');
  });

  it('defaults type to expense and account to the first managed account when unset', () => {
    const draft = seedExtractionDraft(extraction({ type: field<TxType>(null, 0.9) }), settings);
    expect(draft.type).toBe('expense');
    expect(draft.account).toBe('Main Checking');
  });

  it('never invents a category: an unmatched suggestion seeds "Needs review" when present, not a silent substitution', () => {
    const draft = seedExtractionDraft(extraction({ category: field('Travel', 0.95) }), settings);
    // settings.categories includes 'Needs review' here, so that's the honest fallback.
    expect(draft.category).toBe('Needs review');
  });

  it('never invents a category: an unmatched suggestion seeds empty when Needs review is unavailable, forcing an explicit choice', () => {
    const noReview = { categories: ['Housing', 'Dining'], accounts: ['Main Checking'] };
    const draft = seedExtractionDraft(extraction({ category: field('Travel', 0.95) }), noReview);
    expect(draft.category).toBe('');
  });
});

describe('validateExtractionDraft', () => {
  const valid: ExtractionDraft = {
    merchant: 'Coffee Shop',
    date: '2026-08-01',
    total: '12.50',
    type: 'expense',
    category: 'Dining',
    account: 'Main Checking',
    tags: [],
  };

  it('passes a complete, valid draft', () => {
    expect(validateExtractionDraft(valid)).toBeNull();
  });

  it('requires a non-empty merchant', () => {
    expect(validateExtractionDraft({ ...valid, merchant: '  ' })).toBe('Enter a merchant.');
  });

  it('requires a real date', () => {
    expect(validateExtractionDraft({ ...valid, date: '' })).toBe('Choose a real date.');
    expect(validateExtractionDraft({ ...valid, date: '2026-02-30' })).toBe('Choose a real date.');
  });

  it('requires a positive total', () => {
    expect(validateExtractionDraft({ ...valid, total: '0' })).toBe('Enter a total greater than 0.');
    expect(validateExtractionDraft({ ...valid, total: '-5' })).toBe('Enter a total greater than 0.');
    expect(validateExtractionDraft({ ...valid, total: 'abc' })).toBe('Enter a total greater than 0.');
  });

  it('requires a category and an account', () => {
    expect(validateExtractionDraft({ ...valid, category: '' })).toBe('Choose a category.');
    expect(validateExtractionDraft({ ...valid, account: '' })).toBe('Choose an account.');
  });
});

describe('buildTxInputFromDraft', () => {
  it('assembles a TxInput sourced from the document, rounded to cents', () => {
    const draft: ExtractionDraft = {
      merchant: '  Coffee Shop  ',
      date: '2026-08-01',
      total: '12.567',
      type: 'expense',
      category: 'Dining',
      account: 'Main Checking',
      tags: ['work'],
    };
    expect(buildTxInputFromDraft(draft)).toEqual({
      date: '2026-08-01',
      merchant: 'Coffee Shop',
      amount: 12.57,
      type: 'expense',
      category: 'Dining',
      account: 'Main Checking',
      tags: ['work'],
      receipt: true,
      source: 'document',
    });
  });
});
