import { describe, expect, it } from 'vitest';
import { txFingerprint } from '../shared/fingerprint';

describe('txFingerprint', () => {
  it('follows the exact recipe from spec §4.4', () => {
    const date = '2026-01-05';
    const merchant = 'Netflix';
    const amount = 15.5;
    const account = 'Main Checking';
    const expected = `${date}|${merchant.trim().toLowerCase()}|${amount.toFixed(2)}|${account
      .trim()
      .toLowerCase()}`;
    expect(txFingerprint(date, merchant, amount, account)).toBe(expected);
    expect(txFingerprint(date, merchant, amount, account)).toBe(
      '2026-01-05|netflix|15.50|main checking',
    );
  });

  it('trims and lowercases merchant and account', () => {
    expect(txFingerprint('2026-01-05', '  Netflix  ', 15.5, '  MAIN CHECKING  ')).toBe(
      '2026-01-05|netflix|15.50|main checking',
    );
  });

  it('formats the amount to exactly two decimal places', () => {
    expect(txFingerprint('2026-01-05', 'Costco', 100, 'Visa')).toBe(
      '2026-01-05|costco|100.00|visa',
    );
    expect(txFingerprint('2026-01-05', 'Costco', 99.999, 'Visa')).toBe(
      '2026-01-05|costco|100.00|visa',
    );
  });

  it('is stable/deterministic for identical inputs (used for dedup)', () => {
    const a = txFingerprint('2026-02-01', 'Starbucks', 4.5, 'Visa');
    const b = txFingerprint('2026-02-01', 'Starbucks', 4.5, 'Visa');
    expect(a).toBe(b);
  });

  it('produces different fingerprints when merchant case/whitespace normalizes to the same value but other fields differ', () => {
    const a = txFingerprint('2026-02-01', 'Starbucks', 4.5, 'Visa');
    const b = txFingerprint('2026-02-02', 'Starbucks', 4.5, 'Visa');
    expect(a).not.toBe(b);
  });
});
