import { describe, expect, it } from 'vitest';
import {
  accountsEqual,
  addAccountName,
  removeAccountName,
} from '../src/components/onboarding/accountList';

describe('addAccountName', () => {
  it('trims and appends a new account', () => {
    const result = addAccountName(['Main Checking'], '  Savings  ');
    expect(result).toEqual({ accounts: ['Main Checking', 'Savings'], error: null });
  });

  it('rejects a blank name without touching the list', () => {
    const result = addAccountName(['Main Checking'], '   ');
    expect(result).toEqual({ accounts: ['Main Checking'], error: 'Enter an account name.' });
  });

  it('rejects a case-insensitive duplicate', () => {
    const result = addAccountName(['Main Checking'], 'main checking');
    expect(result).toEqual({
      accounts: ['Main Checking'],
      error: '"main checking" already exists.',
    });
  });

  it('rejects a duplicate that only differs by surrounding whitespace and case', () => {
    const result = addAccountName(['Rewards Card'], '  REWARDS CARD  ');
    expect(result.error).toBe('"REWARDS CARD" already exists.');
    expect(result.accounts).toEqual(['Rewards Card']);
  });

  it('allows the starter four to be added to individually from empty', () => {
    let accounts: string[] = [];
    for (const name of ['Main Checking', 'Everyday Visa', 'Rewards Card', 'Cash']) {
      const result = addAccountName(accounts, name);
      expect(result.error).toBeNull();
      accounts = result.accounts;
    }
    expect(accounts).toEqual(['Main Checking', 'Everyday Visa', 'Rewards Card', 'Cash']);
  });

  it('does not mutate the input array on success', () => {
    const input = ['Main Checking'];
    const snapshot = [...input];
    addAccountName(input, 'Savings');
    expect(input).toEqual(snapshot);
  });

  it('does not mutate the input array on a blocked add (blank or duplicate)', () => {
    const input = ['Main Checking'];
    const snapshot = [...input];
    addAccountName(input, '   ');
    addAccountName(input, 'main checking');
    expect(input).toEqual(snapshot);
  });
});

describe('removeAccountName', () => {
  it('removes an existing account when more than one remains', () => {
    const result = removeAccountName(['Main Checking', 'Cash'], 'Cash');
    expect(result).toEqual({ accounts: ['Main Checking'], error: null });
  });

  it('blocks removing the last remaining account', () => {
    const result = removeAccountName(['Main Checking'], 'Main Checking');
    expect(result).toEqual({
      accounts: ['Main Checking'],
      error: 'Keep at least one account to continue.',
    });
  });

  it('is a no-op (list unchanged) when the name is not present', () => {
    const result = removeAccountName(['Main Checking', 'Cash'], 'Nonexistent');
    expect(result).toEqual({ accounts: ['Main Checking', 'Cash'], error: null });
  });

  it('does not mutate the input array on success', () => {
    const input = ['Main Checking', 'Cash'];
    const snapshot = [...input];
    removeAccountName(input, 'Cash');
    expect(input).toEqual(snapshot);
  });

  it('does not mutate the input array when blocked (last account)', () => {
    const input = ['Main Checking'];
    const snapshot = [...input];
    removeAccountName(input, 'Main Checking');
    expect(input).toEqual(snapshot);
  });
});

describe('accountsEqual', () => {
  it('is true for identical lists', () => {
    expect(accountsEqual(['Main Checking', 'Cash'], ['Main Checking', 'Cash'])).toBe(true);
  });

  it('is true when the same names appear in a different order (order-insensitive)', () => {
    expect(accountsEqual(['Main Checking', 'Cash', 'Rewards Card'], ['Rewards Card', 'Main Checking', 'Cash'])).toBe(
      true,
    );
  });

  it('is true after a remove-then-re-add of the same name (regression: redundant reordering PUT)', () => {
    const original = ['Main Checking', 'Everyday Visa', 'Rewards Card', 'Cash'];
    const afterRemove = removeAccountName(original, 'Cash').accounts;
    const afterReAdd = addAccountName(afterRemove, 'Cash').accounts;
    expect(accountsEqual(afterReAdd, original)).toBe(true);
  });

  it('is false when lengths differ', () => {
    expect(accountsEqual(['Main Checking'], ['Main Checking', 'Cash'])).toBe(false);
  });

  it('is false when contents differ', () => {
    expect(accountsEqual(['Main Checking', 'Cash'], ['Main Checking', 'Savings'])).toBe(false);
  });

  it('is case-sensitive (differently-cased names are a real difference, not noise)', () => {
    expect(accountsEqual(['Cash'], ['cash'])).toBe(false);
  });

  it('does not mutate either input array', () => {
    const a = ['Cash', 'Main Checking'];
    const b = ['Main Checking', 'Cash'];
    const snapshotA = [...a];
    const snapshotB = [...b];
    accountsEqual(a, b);
    expect(a).toEqual(snapshotA);
    expect(b).toEqual(snapshotB);
  });
});
