// Display currency formatting (shared/format.ts). setActiveCurrency only
// changes formatting — never stored values — so these tests exercise the
// module-level formatter swap directly (spec: sprint-2 currency setting).
import { afterEach, describe, expect, it } from 'vitest';
import { fmtCurrency, fmtSigned, getActiveCurrency, setActiveCurrency } from '../shared/format';

// activeCurrency is a module-level singleton — reset it after every test so
// one test's currency choice can never leak into the next, regardless of
// order or an early assertion failure mid-test.
afterEach(() => {
  setActiveCurrency('USD');
});

describe('setActiveCurrency / fmtCurrency / fmtSigned', () => {
  it('changes the symbol used by fmtCurrency', () => {
    expect(fmtCurrency(12.34)).toBe('$12.34');
    setActiveCurrency('EUR');
    expect(getActiveCurrency()).toBe('EUR');
    expect(fmtCurrency(12.34)).toBe('€12.34');
  });

  it('changes the symbol used by fmtSigned while keeping the sign', () => {
    setActiveCurrency('EUR');
    expect(fmtSigned(12.34, 'income')).toBe('+€12.34');
    expect(fmtSigned(12.34, 'expense')).toBe('-€12.34');
  });

  it('ignores an unknown currency code', () => {
    setActiveCurrency('EUR');
    setActiveCurrency('NOPE');
    expect(getActiveCurrency()).toBe('EUR');
  });

  it('switches back to a previously active currency', () => {
    setActiveCurrency('GBP');
    expect(fmtCurrency(5)).toBe('£5.00');
    setActiveCurrency('USD');
    expect(getActiveCurrency()).toBe('USD');
    expect(fmtCurrency(5)).toBe('$5.00');
  });
});
