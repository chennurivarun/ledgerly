import { afterEach, describe, expect, it } from 'vitest';
import {
  missingKeyProvider,
  parseSarvamPriceDraft,
  preflightCostLine,
  preflightSummary,
  providerCanReadPdfStatements,
  sarvamPriceError,
} from '../src/components/ai/preflightHelpers';
import { setActiveCurrency } from '../shared/format';
import type { AiProvider } from '../shared/types';

describe('providerCanReadPdfStatements', () => {
  // Enumerate every provider explicitly so adding one to AiProvider without
  // deciding its statement capability shows up as a compile error here, and
  // a flipped comparison can't survive.
  const expected: Record<AiProvider, boolean> = {
    off: false,
    'workers-ai': false,
    anthropic: true,
    sarvam: true,
    // S16: statements read via the browser-pages flow (text-first, rendered
    // image fallback) — the custom endpoint is statement-capable now.
    custom: true,
  };

  for (const [provider, capable] of Object.entries(expected) as [AiProvider, boolean][]) {
    it(`${provider} → ${capable}`, () => {
      expect(providerCanReadPdfStatements(provider)).toBe(capable);
    });
  }
});

describe('missingKeyProvider', () => {
  it('names Anthropic when it is active without its key', () => {
    expect(missingKeyProvider('anthropic', false, false)).toBe('Anthropic');
  });

  it('names Sarvam when it is active without its key', () => {
    expect(missingKeyProvider('sarvam', false, false)).toBe('Sarvam');
  });

  it('is satisfied by the active provider having its own key', () => {
    expect(missingKeyProvider('anthropic', true, false)).toBeNull();
    expect(missingKeyProvider('sarvam', false, true)).toBeNull();
  });

  it("only the ACTIVE provider's key counts — the other stored key never substitutes", () => {
    // A stored Sarvam key doesn't make Anthropic ready…
    expect(missingKeyProvider('anthropic', false, true)).toBe('Anthropic');
    // …and a stored Anthropic key doesn't make Sarvam ready.
    expect(missingKeyProvider('sarvam', true, false)).toBe('Sarvam');
  });

  it('non-BYOK providers never report a missing key, even with none stored', () => {
    expect(missingKeyProvider('off', false, false)).toBeNull();
    expect(missingKeyProvider('workers-ai', false, false)).toBeNull();
  });
});

describe('preflightSummary', () => {
  it('singular page and batch', () => {
    expect(preflightSummary({ pages: 1, batches: 1 })).toBe(
      'This statement is 1 page and will be read in 1 batch.',
    );
  });

  it('plural pages with a single batch — each noun pluralises independently', () => {
    expect(preflightSummary({ pages: 7, batches: 1 })).toBe(
      'This statement is 7 pages and will be read in 1 batch.',
    );
  });

  it('plural pages and batches', () => {
    expect(preflightSummary({ pages: 25, batches: 3 })).toBe(
      'This statement is 25 pages and will be read in 3 batches.',
    );
  });
});

describe('preflightCostLine', () => {
  afterEach(() => setActiveCurrency('USD'));

  it('sarvam with a saved rate: the estimate, formatted and attributed to the saved rate', () => {
    expect(preflightCostLine({ provider: 'sarvam', estimatedCost: 12.5 })).toBe(
      'Estimated cost: ~$12.50 (your saved Sarvam rate × pages).',
    );
  });

  it('formats the estimate with the house currency formatter (follows the active display currency)', () => {
    setActiveCurrency('INR');
    expect(preflightCostLine({ provider: 'sarvam', estimatedCost: 4 })).toBe(
      'Estimated cost: ~₹4.00 (your saved Sarvam rate × pages).',
    );
  });

  it('sarvam without a saved rate: points at Settings, never invents a number', () => {
    const line = preflightCostLine({ provider: 'sarvam', estimatedCost: null });
    expect(line).toBe('Sarvam bills per page — save your rate in Settings for an estimate.');
  });

  it('anthropic: honest static per-token copy, no invented figure', () => {
    expect(preflightCostLine({ provider: 'anthropic', estimatedCost: null })).toBe(
      'Anthropic bills per token — typically a few cents per statement.',
    );
  });

  it('anthropic never gets the per-page estimate line, even if a cost value sneaks through', () => {
    // Per-page arithmetic doesn't describe per-token billing — showing
    // "your saved Sarvam rate × pages" under Anthropic would be a lie.
    expect(preflightCostLine({ provider: 'anthropic', estimatedCost: 12.5 })).toBe(
      'Anthropic bills per token — typically a few cents per statement.',
    );
  });

  it('custom: the browser-flow copy — Ledgerly adds no cost, the endpoint owns pricing', () => {
    expect(preflightCostLine({ provider: 'custom', estimatedCost: null })).toBe(
      "Read in your browser via your custom endpoint — Ledgerly adds no cost; your endpoint's own limits and pricing apply.",
    );
  });

  it('custom never gets the per-page estimate line, even if a cost value sneaks through', () => {
    // Same rule as Anthropic: per-page arithmetic doesn't describe what the
    // user's own endpoint bills, and Ledgerly cannot honestly number it.
    expect(preflightCostLine({ provider: 'custom', estimatedCost: 12.5 })).toBe(
      "Read in your browser via your custom endpoint — Ledgerly adds no cost; your endpoint's own limits and pricing apply.",
    );
  });

  it('providers that cannot read statements have no cost line', () => {
    expect(preflightCostLine({ provider: 'off', estimatedCost: null })).toBeNull();
    expect(preflightCostLine({ provider: 'workers-ai', estimatedCost: null })).toBeNull();
  });
});

describe('sarvamPriceError', () => {
  it('blank is valid — it clears the saved price', () => {
    expect(sarvamPriceError('')).toBeNull();
    expect(sarvamPriceError('   ')).toBeNull();
  });

  it('accepts a positive number', () => {
    expect(sarvamPriceError('0.25')).toBeNull();
    expect(sarvamPriceError('1')).toBeNull();
  });

  it('rejects zero — a free per-page rate is a cleared rate, not a price', () => {
    expect(sarvamPriceError('0')).toBe('Enter a price greater than 0, or leave blank for no estimate.');
  });

  it('rejects negatives, non-numbers, and non-finite values', () => {
    expect(sarvamPriceError('-2')).not.toBeNull();
    expect(sarvamPriceError('abc')).not.toBeNull();
    expect(sarvamPriceError('Infinity')).not.toBeNull();
    expect(sarvamPriceError('NaN')).not.toBeNull();
  });
});

describe('parseSarvamPriceDraft', () => {
  it('blank parses to null (clears the saved price)', () => {
    expect(parseSarvamPriceDraft('')).toBeNull();
    expect(parseSarvamPriceDraft('  ')).toBeNull();
  });

  it('a valid draft parses to its number', () => {
    expect(parseSarvamPriceDraft('0.25')).toBe(0.25);
    expect(parseSarvamPriceDraft('2')).toBe(2);
  });

  it('throws on a draft that failed validation — an invalid string must never coerce into a price', () => {
    expect(() => parseSarvamPriceDraft('0')).toThrow();
    expect(() => parseSarvamPriceDraft('abc')).toThrow();
  });
});
