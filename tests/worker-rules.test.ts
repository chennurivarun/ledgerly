// Pure-function checks for the worker's non-trivial logic: the plain-language
// rules parser, the Drive resetAt fence, and duplicate detection.
import { describe, expect, it } from 'vitest';
import { NEEDS_REVIEW, type Rule } from '../shared/types';
import { applyRules, parseRule, parseThen, parseWhen } from '../worker/rules';
import { capProcessedIds, driveFileDisposition } from '../worker/drive';
import { partitionByFingerprint, validateTxInput } from '../worker/transactions';

function rule(whenText: string, thenText: string, enabled = true): Rule {
  return { id: whenText + thenText, whenText, thenText, enabled, createdAt: '2026-01-01T00:00:00Z' };
}

describe('rules parser — when', () => {
  it('reads quoted merchant conditions', () => {
    expect(parseWhen('merchant contains "Blue Bottle"')).toBe('blue bottle');
    expect(parseWhen("When description contains 'Uber'")).toBe('uber');
  });

  it('reads bare contains and bare text', () => {
    expect(parseWhen('contains Netflix')).toBe('netflix');
    expect(parseWhen('  Whole Foods  ')).toBe('whole foods');
  });

  it('rejects empty conditions', () => {
    expect(parseWhen('   ')).toBeNull();
    expect(parseWhen('when ')).toBeNull();
  });
});

describe('rules parser — then', () => {
  it('reads category phrasings', () => {
    expect(parseThen('category Dining').category).toBe('Dining');
    expect(parseThen('set category to Groceries').category).toBe('Groceries');
    expect(parseThen('Category: "Coffee Shops"').category).toBe('Coffee Shops');
  });

  it('reads tag phrasings and combined clauses', () => {
    expect(parseThen('tag Coffee').tags).toEqual(['Coffee']);
    expect(parseThen('add tag Work')).toEqual({ category: null, tags: ['Work'] });
    expect(parseThen('set category to Dining and add tag Coffee')).toEqual({
      category: 'Dining',
      tags: ['Coffee'],
    });
  });

  it('treats a bare phrase as the category', () => {
    expect(parseThen('Utilities').category).toBe('Utilities');
  });

  it('returns null for a rule it cannot read at all', () => {
    expect(parseRule('', 'category Dining')).toBeNull();
    expect(parseRule('contains Netflix', '   ')).toBeNull();
  });
});

describe('applyRules', () => {
  const target = { merchant: 'NETFLIX.COM 4085', category: NEEDS_REVIEW, tags: [] as string[] };

  it('fills an uncategorized row and appends tags', () => {
    const out = applyRules(target, [
      rule('merchant contains "netflix"', 'set category to Subscriptions and add tag Streaming'),
    ]);
    expect(out).toEqual({ category: 'Subscriptions', tags: ['Streaming'] });
  });

  it('is case-insensitive on the merchant and skips non-matches', () => {
    expect(applyRules(target, [rule('contains SPOTIFY', 'category Music')]).category).toBe(
      NEEDS_REVIEW,
    );
  });

  it('ignores disabled rules', () => {
    const out = applyRules(target, [rule('contains netflix', 'category Subscriptions', false)]);
    expect(out.category).toBe(NEEDS_REVIEW);
  });

  it('never overwrites a grounded category, but still adds tags', () => {
    const grounded = { merchant: 'Netflix', category: 'Entertainment', tags: ['Home'] };
    const out = applyRules(grounded, [
      rule('contains netflix', 'category Subscriptions, tag Streaming'),
    ]);
    expect(out).toEqual({ category: 'Entertainment', tags: ['Home', 'Streaming'] });
  });

  it('does not duplicate a tag the row already has', () => {
    const tagged = { merchant: 'Netflix', category: NEEDS_REVIEW, tags: ['streaming'] };
    expect(applyRules(tagged, [rule('contains netflix', 'add tag Streaming')]).tags).toEqual([
      'streaming',
    ]);
  });
});

describe('drive resetAt fence', () => {
  const ctx = (resetAt: string | null, processed: string[] = []) => ({
    processed: new Set(processed),
    resetAt,
  });

  it('skips files already in the processed ledger', () => {
    expect(
      driveFileDisposition({ fileId: 'a', modifiedTime: '2026-08-01T10:00:00Z' }, ctx(null, ['a'])),
    ).toBe('processed');
  });

  it('fences files modified at or before the wipe', () => {
    const resetAt = '2026-08-01T12:00:00Z';
    expect(
      driveFileDisposition({ fileId: 'a', modifiedTime: '2026-08-01T11:59:59Z' }, ctx(resetAt)),
    ).toBe('fenced');
    expect(
      driveFileDisposition({ fileId: 'a', modifiedTime: '2026-08-01T12:00:00Z' }, ctx(resetAt)),
    ).toBe('fenced');
    expect(
      driveFileDisposition({ fileId: 'a', modifiedTime: '2026-08-01T12:00:01Z' }, ctx(resetAt)),
    ).toBe('process');
  });

  it('processes everything when no wipe has happened', () => {
    expect(driveFileDisposition({ fileId: 'a', modifiedTime: 'nonsense' }, ctx(null))).toBe(
      'process',
    );
  });

  it('never guesses an unreadable modified time against a fence', () => {
    expect(
      driveFileDisposition({ fileId: 'a', modifiedTime: '' }, ctx('2026-08-01T12:00:00Z')),
    ).toBe('invalid-time');
  });

  it('caps the processed ledger at the most recent ids', () => {
    expect(capProcessedIds(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(capProcessedIds(['a', 'b', 'c'], ['d'], 2)).toEqual(['c', 'd']);
  });
});

describe('transaction validation', () => {
  const base = { date: '2026-08-05', merchant: '  Blue Bottle ', amount: 4.5, type: 'expense' };

  it('normalizes a valid row', () => {
    const result = validateTxInput({ ...base, tags: [' Coffee ', 'coffee', ''] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.merchant).toBe('Blue Bottle');
    expect(result.value.tags).toEqual(['Coffee']);
    expect(result.value.category).toBe(NEEDS_REVIEW);
    expect(result.value.account).toBe('Imported account');
    expect(result.value.source).toBe('manual');
    expect(result.value.fingerprint).toBe('2026-08-05|blue bottle|4.50|imported account');
  });

  it('applies import defaults without letting the payload override a forced source', () => {
    const result = validateTxInput(
      { ...base, source: 'manual' },
      { forceSource: 'google-drive', account: 'Drive import', extraTags: ['Drive import'] },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source).toBe('google-drive');
    expect(result.value.account).toBe('Drive import');
    expect(result.value.tags).toEqual(['Drive import']);
  });

  it('rejects bad dates, merchants, amounts and types', () => {
    expect(validateTxInput({ ...base, date: '2026-02-30' }).ok).toBe(false);
    expect(validateTxInput({ ...base, date: '05/08/2026' }).ok).toBe(false);
    expect(validateTxInput({ ...base, merchant: '   ' }).ok).toBe(false);
    expect(validateTxInput({ ...base, amount: 0 }).ok).toBe(false);
    expect(validateTxInput({ ...base, amount: -3 }).ok).toBe(false);
    expect(validateTxInput({ ...base, amount: Number.POSITIVE_INFINITY }).ok).toBe(false);
    expect(validateTxInput({ ...base, type: 'transfer' }).ok).toBe(false);
    expect(validateTxInput({ ...base, tags: 'coffee' }).ok).toBe(false);
    expect(validateTxInput('nope').ok).toBe(false);
  });
});

describe('duplicate detection', () => {
  const row = (fingerprint: string) => ({ fingerprint });

  it('drops rows whose fingerprint is already stored', () => {
    const out = partitionByFingerprint([row('a'), row('b')], new Set(['a']));
    expect(out.duplicates).toBe(1);
    expect(out.fresh).toEqual([row('b')]);
  });

  it('collapses duplicates inside one batch', () => {
    const out = partitionByFingerprint([row('a'), row('a'), row('a')], new Set());
    expect(out.duplicates).toBe(2);
    expect(out.fresh).toHaveLength(1);
  });

  it('keeps distinct rows', () => {
    const out = partitionByFingerprint([row('a'), row('b')], new Set());
    expect(out.duplicates).toBe(0);
    expect(out.fresh).toHaveLength(2);
  });
});
