import { describe, expect, it } from 'vitest';
import type { InboxEmail, TxInput } from '../shared/types';
import {
  VISIBLE_INBOX_STATUSES,
  addSenderEntry,
  buildAllowlistUpdate,
  buildEmailFeedToggleUpdate,
  buildInboxTxInput,
  normalizeSenderEntry,
  proposedCount,
  removeSenderEntry,
  seedInboxDraft,
  senderEntryError,
  showEmptyAllowlistWarning,
  validateInboxDraft,
  visibleInboxItems,
  type InboxDraft,
} from '../src/components/inbox/inboxHelpers';

const SETTINGS = {
  categories: ['Housing', 'Dining', 'Needs review'],
  accounts: ['Main Checking', 'Cash'],
};

function item(overrides: Partial<InboxEmail> = {}): InboxEmail {
  return {
    id: 'inbox-1',
    receivedAt: '2026-08-10T09:00:00.000Z',
    from: 'alerts@bank.com',
    subject: 'You made a purchase',
    status: 'proposed',
    parsed: {
      date: '2026-08-10',
      merchant: 'Coffee Shop',
      amount: 12.5,
      type: 'expense',
      pack: 'generic-en',
    },
    documentId: null,
    createdAt: '2026-08-10T09:00:01.000Z',
    ...overrides,
  };
}

function draft(overrides: Partial<InboxDraft> = {}): InboxDraft {
  return {
    date: '2026-08-10',
    merchant: 'Coffee Shop',
    amount: '12.50',
    type: 'expense',
    category: 'Needs review',
    account: 'Main Checking',
    ...overrides,
  };
}

describe('visibleInboxItems', () => {
  it('pins the v1 visible set to proposed + unparsed exactly', () => {
    expect(VISIBLE_INBOX_STATUSES).toEqual(['proposed', 'unparsed']);
  });

  it('hides confirmed and dismissed items entirely', () => {
    const items = [
      item({ id: 'a', status: 'proposed', receivedAt: '2026-08-11T09:00:00.000Z' }),
      item({ id: 'b', status: 'confirmed', receivedAt: '2026-08-12T09:00:00.000Z' }),
      item({ id: 'c', status: 'unparsed', parsed: null, receivedAt: '2026-08-10T09:00:00.000Z' }),
      item({ id: 'd', status: 'dismissed', receivedAt: '2026-08-09T09:00:00.000Z' }),
    ];
    expect(visibleInboxItems(items).map((i) => i.id)).toEqual(['a', 'c']);
  });

  it('orders newest-first by receivedAt', () => {
    const items = [
      item({ id: 'old', receivedAt: '2026-08-01T09:00:00.000Z' }),
      item({ id: 'new', receivedAt: '2026-08-11T09:00:00.000Z' }),
      item({ id: 'mid', receivedAt: '2026-08-05T09:00:00.000Z' }),
    ];
    expect(visibleInboxItems(items).map((i) => i.id)).toEqual(['new', 'mid', 'old']);
  });

  it('tie-breaks equal receivedAt by createdAt, newest first', () => {
    const items = [
      item({ id: 'first', createdAt: '2026-08-10T09:00:01.000Z' }),
      item({ id: 'second', createdAt: '2026-08-10T09:00:05.000Z' }),
    ];
    expect(visibleInboxItems(items).map((i) => i.id)).toEqual(['second', 'first']);
  });

  it('never mutates the input array', () => {
    const items = [
      item({ id: 'old', receivedAt: '2026-08-01T09:00:00.000Z' }),
      item({ id: 'new', receivedAt: '2026-08-11T09:00:00.000Z' }),
    ];
    visibleInboxItems(items);
    expect(items.map((i) => i.id)).toEqual(['old', 'new']);
  });
});

describe('proposedCount', () => {
  it('counts proposals only — unparsed items have nothing to review', () => {
    const items = [
      item({ id: 'a', status: 'proposed' }),
      item({ id: 'b', status: 'unparsed', parsed: null }),
      item({ id: 'c', status: 'proposed' }),
      item({ id: 'd', status: 'confirmed' }),
      item({ id: 'e', status: 'dismissed' }),
    ];
    expect(proposedCount(items)).toBe(2);
  });

  it('is zero for an empty inbox', () => {
    expect(proposedCount([])).toBe(0);
  });
});

describe('seedInboxDraft', () => {
  it('prefills the parsed facts and applies the house category/account defaults', () => {
    expect(seedInboxDraft(item(), SETTINGS)).toEqual({
      date: '2026-08-10',
      merchant: 'Coffee Shop',
      amount: '12.5',
      type: 'expense',
      category: 'Needs review',
      account: 'Main Checking',
    });
  });

  it('keeps a parsed income type as income (type is a parsed fact, never re-guessed)', () => {
    const salary = item({
      parsed: { date: '2026-08-01', merchant: 'Employer', amount: 3200, type: 'income', pack: 'generic-en' },
    });
    expect(seedInboxDraft(salary, SETTINGS).type).toBe('income');
  });

  it('seeds category as "" when "Needs review" is not a managed category (placeholder blocks)', () => {
    const settings = { categories: ['Housing', 'Dining'], accounts: ['Main Checking'] };
    expect(seedInboxDraft(item(), settings).category).toBe('');
  });

  it('seeds an unparsed email with EVERY transaction field empty — including type', () => {
    const unparsed = item({ status: 'unparsed', parsed: null });
    expect(seedInboxDraft(unparsed, SETTINGS)).toEqual({
      date: '',
      merchant: '',
      amount: '',
      type: '',
      category: 'Needs review',
      account: 'Main Checking',
    });
  });

  it('seeds account as "" when no accounts exist', () => {
    const settings = { categories: ['Needs review'], accounts: [] };
    expect(seedInboxDraft(item(), settings).account).toBe('');
  });
});

describe('validateInboxDraft', () => {
  it('accepts a complete draft', () => {
    expect(validateInboxDraft(draft())).toBeNull();
  });

  it('requires a non-whitespace merchant first', () => {
    expect(validateInboxDraft(draft({ merchant: '' }))).toBe('Enter a merchant.');
    expect(validateInboxDraft(draft({ merchant: '   ' }))).toBe('Enter a merchant.');
  });

  it('requires a real calendar date', () => {
    expect(validateInboxDraft(draft({ date: '' }))).toBe('Choose a real date.');
    expect(validateInboxDraft(draft({ date: '2026-02-30' }))).toBe('Choose a real date.');
  });

  it('rejects empty, zero, and non-numeric amounts', () => {
    expect(validateInboxDraft(draft({ amount: '' }))).toBe('Enter an amount greater than 0.');
    expect(validateInboxDraft(draft({ amount: '0' }))).toBe('Enter an amount greater than 0.');
    expect(validateInboxDraft(draft({ amount: 'twelve' }))).toBe('Enter an amount greater than 0.');
  });

  it('rejects a sub-cent amount that a naive > 0 check would pass (shared amountCents rule)', () => {
    expect(validateInboxDraft(draft({ amount: '0.004' }))).toBe('Enter an amount greater than 0.');
  });

  it('accepts an amount that rounds to at least one cent under the same shared rule', () => {
    expect(validateInboxDraft(draft({ amount: '0.005' }))).toBeNull();
  });

  it('requires an explicit type — never guessed on the user’s behalf', () => {
    expect(validateInboxDraft(draft({ type: '' }))).toBe('Choose expense or income.');
  });

  it('requires a category (the "" placeholder blocks confirm)', () => {
    expect(validateInboxDraft(draft({ category: '' }))).toBe('Choose a category.');
  });

  it('requires an account', () => {
    expect(validateInboxDraft(draft({ account: '' }))).toBe('Choose an account.');
  });
});

describe('buildInboxTxInput', () => {
  it('builds the TxInput with cent rounding, trimmed merchant, source email, receipt false', () => {
    const input = buildInboxTxInput(
      draft({ merchant: '  Coffee Shop  ', amount: '12.567', category: 'Dining' }),
    );
    expect(input).toEqual({
      date: '2026-08-10',
      merchant: 'Coffee Shop',
      amount: 12.57,
      type: 'expense',
      category: 'Dining',
      account: 'Main Checking',
      receipt: false,
      source: 'email',
    });
  });

  it('rounds through the SAME shared rule validation used ("0.005" → 0.01, never 0)', () => {
    expect(buildInboxTxInput(draft({ amount: '0.005' })).amount).toBe(0.01);
  });

  it('throws on an amount that does not round to a cent — a caller bug, not a value to guess around', () => {
    expect(() => buildInboxTxInput(draft({ amount: '0.004' }))).toThrow(/amount/);
    expect(() => buildInboxTxInput(draft({ amount: '' }))).toThrow(/amount/);
  });

  it('throws on an unset type', () => {
    expect(() => buildInboxTxInput(draft({ type: '' }))).toThrow(/type/);
  });

  it('confirm inputs stay keyed to their OWN item — a reordered subset of id-keyed drafts never cross-pairs', () => {
    // Three items with deliberately distinct facts; drafts keyed by item id;
    // then only a subset, in non-insertion order, is confirmed. Any
    // index/position-based pairing of item→draft would mismatch here.
    const items = [
      item({ id: 'a', parsed: { date: '2026-08-01', merchant: 'A Corp', amount: 10, type: 'expense', pack: 'generic-en' } }),
      item({ id: 'b', parsed: { date: '2026-08-02', merchant: 'B Corp', amount: 20, type: 'income', pack: 'generic-en' } }),
      item({ id: 'c', parsed: { date: '2026-08-03', merchant: 'C Corp', amount: 30, type: 'expense', pack: 'generic-en' } }),
    ];
    const drafts: Record<string, InboxDraft> = {};
    for (const i of items) drafts[i.id] = seedInboxDraft(i, SETTINGS);

    const confirmed = [items[1], items[0]]; // subset: c excluded; order reversed
    const inputs: TxInput[] = confirmed.map((i) => buildInboxTxInput(drafts[i.id]));

    expect(inputs.map((x) => [x.merchant, x.amount, x.type, x.date])).toEqual([
      ['B Corp', 20, 'income', '2026-08-02'],
      ['A Corp', 10, 'expense', '2026-08-01'],
    ]);
  });
});

describe('normalizeSenderEntry', () => {
  it('trims and lowercases so entries read the way the server matches them', () => {
    expect(normalizeSenderEntry('  Alerts@Chase.COM  ')).toBe('alerts@chase.com');
    expect(normalizeSenderEntry('@Bank.com')).toBe('@bank.com');
  });
});

describe('senderEntryError', () => {
  it('accepts an exact address and a whole @domain', () => {
    expect(senderEntryError('alerts@bank.com', [])).toBeNull();
    expect(senderEntryError('@bank.com', [])).toBeNull();
  });

  it('rejects an empty or whitespace entry', () => {
    expect(senderEntryError('', [])).toBe('Enter an email address or @domain.');
    expect(senderEntryError('   ', [])).toBe('Enter an email address or @domain.');
  });

  it('rejects an entry without an @', () => {
    expect(senderEntryError('bank.com', [])).toMatch(/@/);
  });

  it('rejects an @ with no domain after it', () => {
    expect(senderEntryError('@', [])).toBe('Add the domain after the @.');
    expect(senderEntryError('alerts@', [])).toBe('Add the domain after the @.');
  });

  it('rejects a duplicate case-insensitively against the stored list', () => {
    expect(senderEntryError('Alerts@Bank.com', ['alerts@bank.com'])).toBe(
      '"alerts@bank.com" is already on the list.',
    );
  });
});

describe('allowlist edits', () => {
  it('addSenderEntry appends the NORMALIZED entry without mutating the current list', () => {
    const current = ['alerts@bank.com'];
    expect(addSenderEntry(current, '  @Chase.com ')).toEqual(['alerts@bank.com', '@chase.com']);
    expect(current).toEqual(['alerts@bank.com']);
  });

  it('removeSenderEntry removes exactly the given entry without mutating', () => {
    const current = ['alerts@bank.com', '@chase.com'];
    expect(removeSenderEntry(current, '@chase.com')).toEqual(['alerts@bank.com']);
    expect(current).toHaveLength(2);
  });

  it('builds a full-replacement allowlist update (like the tags list)', () => {
    expect(buildAllowlistUpdate(['a@b.com'])).toEqual({ emailAllowedSenders: ['a@b.com'] });
    expect(buildAllowlistUpdate([])).toEqual({ emailAllowedSenders: [] });
  });

  it('toggle update carries only the enabled flag', () => {
    expect(buildEmailFeedToggleUpdate(true)).toEqual({ emailFeedEnabled: true });
    expect(buildEmailFeedToggleUpdate(false)).toEqual({ emailFeedEnabled: false });
  });
});

describe('showEmptyAllowlistWarning', () => {
  it('warns only when the feed is ON with an empty allowlist', () => {
    expect(showEmptyAllowlistWarning(true, [])).toBe(true);
    expect(showEmptyAllowlistWarning(true, ['a@b.com'])).toBe(false);
    expect(showEmptyAllowlistWarning(false, [])).toBe(false);
    expect(showEmptyAllowlistWarning(false, ['a@b.com'])).toBe(false);
  });
});
