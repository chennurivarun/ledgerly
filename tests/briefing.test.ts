// Sprint 7 — briefing engine, cadence gate, and the write-only WhatsApp
// token. Pure throughout: no network, no bindings; DB paths run against the
// same in-memory settings fake the ai-key-storage tests use.
import { describe, expect, it } from 'vitest';
import {
  BRIEFING_WINDOW_DAYS,
  buildBriefing,
  renderBriefingText,
  shouldSendBriefing,
  type BriefingAttentionCounts,
} from '../shared/briefing';
import { isoDayOffset, type Forecast, type ForecastOccurrence } from '../shared/forecast';
import { defaultSettings, type Settings, type Transaction } from '../shared/types';
import { sendConfigError } from '../worker/briefings';
import { applyPreferences } from '../worker/preferences';
import {
  BRIEFING_TOKEN_SECRET_KEY,
  readBriefingWhatsappToken,
  readSettings,
  redactAiSecret,
} from '../worker/settingsStore';
import { readableWhatsappError } from '../worker/whatsapp';

const TODAY = '2026-08-12';
const TOKEN = 'EAAG-meta-token-do-not-echo-0123456789';

const NO_ATTENTION: BriefingAttentionCounts = {
  documentsAwaitingReview: 0,
  ruleSuggestions: 0,
  statementRowsProposed: 0,
};

let seq = 0;
function tx(over: Partial<Transaction>): Transaction {
  seq += 1;
  return {
    id: `tx-${seq}`,
    date: TODAY,
    merchant: 'Shop',
    category: 'Groceries',
    amount: 10,
    type: 'expense',
    account: 'Main Checking',
    tags: [],
    receipt: false,
    source: 'manual',
    fingerprint: `fp-${seq}`,
    createdAt: `${TODAY}T00:00:00.000Z`,
    ...over,
  };
}

function occ(over: Partial<ForecastOccurrence>): ForecastOccurrence {
  return {
    key: 'netflix|monthly',
    date: isoDayOffset(TODAY, 1),
    merchant: 'Netflix',
    amount: 15.49,
    type: 'expense',
    cadence: 'monthly',
    confidence: 'high',
    category: 'Subscriptions',
    ...over,
  };
}

/** buildBriefing only reads `occurrences` — the rest is honest filler. */
function forecastOf(occurrences: ForecastOccurrence[]): Forecast {
  return {
    start: isoDayOffset(TODAY, 1),
    end: isoDayOffset(TODAY, 30),
    horizonDays: 30,
    occurrences,
    points: [],
    totalIn: 0,
    totalOut: 0,
    net: 0,
    expenseSeries: 0,
    incomeSeries: 0,
  };
}

const EMPTY_FORECAST = forecastOf([]);

// ---------------------------------------------------------------------------
// buildBriefing — stats window
// ---------------------------------------------------------------------------

describe('buildBriefing stats window', () => {
  it('includes a transaction dated exactly BRIEFING_WINDOW_DAYS ago', () => {
    const b = buildBriefing(
      [tx({ date: isoDayOffset(TODAY, -BRIEFING_WINDOW_DAYS) })],
      EMPTY_FORECAST,
      NO_ATTENTION,
      TODAY,
    );
    expect(b.periodStart).toBe(isoDayOffset(TODAY, -BRIEFING_WINDOW_DAYS));
    expect(b.stats.txCount).toBe(1);
  });

  it('excludes a transaction one day older than the window', () => {
    const b = buildBriefing(
      [tx({ date: isoDayOffset(TODAY, -(BRIEFING_WINDOW_DAYS + 1)) })],
      EMPTY_FORECAST,
      NO_ATTENTION,
      TODAY,
    );
    expect(b.stats.txCount).toBe(0);
  });

  it('includes today and excludes future-dated rows', () => {
    const b = buildBriefing(
      [tx({ date: TODAY, amount: 5 }), tx({ date: isoDayOffset(TODAY, 1), amount: 99 })],
      EMPTY_FORECAST,
      NO_ATTENTION,
      TODAY,
    );
    expect(b.stats.txCount).toBe(1);
    expect(b.stats.spending).toBe(5);
  });

  it('splits income and spending by direction and nets them', () => {
    const b = buildBriefing(
      [
        tx({ type: 'income', category: 'Income', amount: 2500 }),
        tx({ amount: 100.25 }),
        tx({ amount: 50.5 }),
      ],
      EMPTY_FORECAST,
      NO_ATTENTION,
      TODAY,
    );
    expect(b.stats.income).toBe(2500);
    expect(b.stats.spending).toBe(150.75);
    expect(b.stats.net).toBe(2349.25);
    expect(b.stats.txCount).toBe(3);
  });

  it('rounds accumulations to cents (no float dust)', () => {
    const b = buildBriefing(
      [tx({ amount: 0.1 }), tx({ amount: 0.2 })],
      EMPTY_FORECAST,
      NO_ATTENTION,
      TODAY,
    );
    expect(b.stats.spending).toBe(0.3);
    expect(b.stats.net).toBe(-0.3);
  });
});

// ---------------------------------------------------------------------------
// buildBriefing — top categories
// ---------------------------------------------------------------------------

describe('buildBriefing top categories', () => {
  it('orders by amount desc and caps at 3', () => {
    const b = buildBriefing(
      [
        tx({ category: 'A', amount: 50 }),
        tx({ category: 'B', amount: 60 }),
        tx({ category: 'B', amount: 40 }),
        tx({ category: 'C', amount: 75 }),
        tx({ category: 'D', amount: 25 }),
      ],
      EMPTY_FORECAST,
      NO_ATTENTION,
      TODAY,
    );
    expect(b.stats.topCategories).toEqual([
      { category: 'B', amount: 100 },
      { category: 'C', amount: 75 },
      { category: 'A', amount: 50 },
    ]);
  });

  it('breaks amount ties alphabetically', () => {
    const b = buildBriefing(
      [tx({ category: 'Dining', amount: 50 }), tx({ category: 'Coffee', amount: 50 })],
      EMPTY_FORECAST,
      NO_ATTENTION,
      TODAY,
    );
    expect(b.stats.topCategories.map((c) => c.category)).toEqual(['Coffee', 'Dining']);
  });

  it('counts expenses only — income categories never appear', () => {
    const b = buildBriefing(
      [tx({ type: 'income', category: 'Income', amount: 5000 }), tx({ category: 'Rent', amount: 1400 })],
      EMPTY_FORECAST,
      NO_ATTENTION,
      TODAY,
    );
    expect(b.stats.topCategories).toEqual([{ category: 'Rent', amount: 1400 }]);
  });
});

// ---------------------------------------------------------------------------
// buildBriefing — upcoming slice
// ---------------------------------------------------------------------------

describe('buildBriefing upcoming slice', () => {
  it('keeps an occurrence exactly BRIEFING_WINDOW_DAYS out, drops one past it', () => {
    const inside = occ({ date: isoDayOffset(TODAY, BRIEFING_WINDOW_DAYS) });
    const outside = occ({ date: isoDayOffset(TODAY, BRIEFING_WINDOW_DAYS + 1), merchant: 'Gym' });
    const b = buildBriefing([], forecastOf([inside, outside]), NO_ATTENTION, TODAY);
    expect(b.upcoming).toEqual([inside]);
  });

  it('never lets today (or earlier) leak into upcoming', () => {
    const b = buildBriefing([], forecastOf([occ({ date: TODAY })]), NO_ATTENTION, TODAY);
    expect(b.upcoming).toEqual([]);
  });

  it('sums upcomingIn and upcomingOut by direction, cent-rounded', () => {
    const b = buildBriefing(
      [],
      forecastOf([
        occ({ amount: 0.1 }),
        occ({ date: isoDayOffset(TODAY, 2), amount: 0.2 }),
        occ({
          date: isoDayOffset(TODAY, 7),
          merchant: 'Salary',
          type: 'income',
          amount: 2000,
          key: 'salary|monthly',
        }),
      ]),
      NO_ATTENTION,
      TODAY,
    );
    expect(b.upcomingOut).toBe(0.3);
    expect(b.upcomingIn).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// buildBriefing — attention lines
// ---------------------------------------------------------------------------

describe('buildBriefing attention lines', () => {
  const lines = (counts: BriefingAttentionCounts) =>
    buildBriefing([], EMPTY_FORECAST, counts, TODAY).attention;

  it('uses exact singular copy', () => {
    expect(
      lines({ documentsAwaitingReview: 1, ruleSuggestions: 1, statementRowsProposed: 1 }),
    ).toEqual([
      '1 document waiting for review.',
      '1 suggested rule to look at.',
      '1 statement row proposed and not yet reviewed.',
    ]);
  });

  it('uses exact plural copy', () => {
    expect(
      lines({ documentsAwaitingReview: 2, ruleSuggestions: 3, statementRowsProposed: 4 }),
    ).toEqual([
      '2 documents waiting for review.',
      '3 suggested rules to look at.',
      '4 statement rows proposed and not yet reviewed.',
    ]);
  });

  it('suppresses zero counts entirely', () => {
    expect(
      lines({ documentsAwaitingReview: 0, ruleSuggestions: 2, statementRowsProposed: 0 }),
    ).toEqual(['2 suggested rules to look at.']);
  });

  it('emits no lines when nothing needs attention', () => {
    expect(lines(NO_ATTENTION)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// renderBriefingText — pinned output
// ---------------------------------------------------------------------------

describe('renderBriefingText', () => {
  function populatedBriefing() {
    return buildBriefing(
      [
        tx({ type: 'income', category: 'Income', merchant: 'Salary', amount: 2500 }),
        tx({ category: 'Groceries', amount: 310.5, date: isoDayOffset(TODAY, -1) }),
        tx({ category: 'Dining', amount: 205, date: isoDayOffset(TODAY, -2) }),
        tx({ category: 'Transportation', amount: 120, date: isoDayOffset(TODAY, -3) }),
      ],
      forecastOf([
        occ({ date: isoDayOffset(TODAY, 2) }),
        occ({
          date: isoDayOffset(TODAY, 7),
          merchant: 'Salary',
          type: 'income',
          amount: 2000,
          key: 'salary|monthly',
        }),
      ]),
      { documentsAwaitingReview: 2, ruleSuggestions: 0, statementRowsProposed: 1 },
      TODAY,
    );
  }

  it('renders the populated briefing exactly', () => {
    expect(renderBriefingText(populatedBriefing(), 'USD')).toBe(
      [
        '📊 *Ledgerly briefing — 2026-08-12*',
        '',
        '*Last 7 days*',
        'Income $2,500.00 · Spending $635.50 · Net +$1,864.50',
        '4 transactions recorded.',
        'Top spending: Groceries $310.50, Dining $205.00, Transportation $120.00',
        '',
        '*Next 7 days*',
        'Expected: +$2,000.00 in, -$15.49 out.',
        '2026-08-14: Netflix -$15.49',
        '2026-08-19: Salary +$2,000.00',
        '',
        '*Needs attention*',
        '2 documents waiting for review.',
        '1 statement row proposed and not yet reviewed.',
      ].join('\n'),
    );
  });

  it('renders the empty ledger honestly, exactly', () => {
    const empty = buildBriefing([], EMPTY_FORECAST, NO_ATTENTION, TODAY);
    expect(renderBriefingText(empty, 'USD')).toBe(
      [
        '📊 *Ledgerly briefing — 2026-08-12*',
        '',
        '*Last 7 days*',
        'No activity in the last 7 days.',
        '',
        '*Next 7 days*',
        'Nothing projected.',
        '',
        '*Needs attention*',
        'Nothing waiting on you.',
      ].join('\n'),
    );
  });

  it('formats in the given currency, not a hardcoded $', () => {
    const text = renderBriefingText(populatedBriefing(), 'EUR');
    expect(text).toContain('€2,500.00');
    expect(text).not.toContain('$');
  });

  it('shows a negative net with a minus sign', () => {
    const b = buildBriefing([tx({ amount: 42 })], EMPTY_FORECAST, NO_ATTENTION, TODAY);
    expect(renderBriefingText(b, 'USD')).toContain('Net -$42.00');
  });

  it('uses singular copy for one transaction', () => {
    const b = buildBriefing([tx({ amount: 42 })], EMPTY_FORECAST, NO_ATTENTION, TODAY);
    expect(renderBriefingText(b, 'USD')).toContain('1 transaction recorded.');
  });

  it('caps the upcoming list at 8 lines and summarizes the rest', () => {
    const many = Array.from({ length: 11 }, (_, i) =>
      occ({ date: isoDayOffset(TODAY, 1 + (i % 7)), merchant: `M${i}`, key: `m${i}|monthly` }),
    );
    const text = renderBriefingText(
      buildBriefing([], forecastOf(many), NO_ATTENTION, TODAY),
      'USD',
    );
    expect(text.split('\n').filter((l) => l.includes(': M')).length).toBe(8);
    expect(text).toContain('…and 3 more.');
  });
});

// ---------------------------------------------------------------------------
// shouldSendBriefing — the cadence gate
// ---------------------------------------------------------------------------

describe('shouldSendBriefing', () => {
  it('sends when never sent, on either cadence', () => {
    expect(shouldSendBriefing('daily', null, TODAY)).toBe(true);
    expect(shouldSendBriefing('weekly', null, TODAY)).toBe(true);
  });

  it('daily: skips when already sent today, sends after yesterday', () => {
    expect(shouldSendBriefing('daily', `${TODAY}T08:00:12.000Z`, TODAY)).toBe(false);
    expect(shouldSendBriefing('daily', `${isoDayOffset(TODAY, -1)}T23:59:59.000Z`, TODAY)).toBe(true);
  });

  it('weekly: skips under 7 days, sends at exactly 7', () => {
    expect(shouldSendBriefing('weekly', `${TODAY}T08:00:00.000Z`, TODAY)).toBe(false);
    expect(shouldSendBriefing('weekly', `${isoDayOffset(TODAY, -6)}T08:00:00.000Z`, TODAY)).toBe(false);
    expect(shouldSendBriefing('weekly', `${isoDayOffset(TODAY, -7)}T08:00:00.000Z`, TODAY)).toBe(true);
    expect(shouldSendBriefing('weekly', `${isoDayOffset(TODAY, -30)}T08:00:00.000Z`, TODAY)).toBe(true);
  });

  it('treats an unparseable stamp as never-sent rather than silencing forever', () => {
    expect(shouldSendBriefing('weekly', 'not-a-date', TODAY)).toBe(true);
    expect(shouldSendBriefing('daily', 'not-a-date', TODAY)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Preferences plumbing — same in-memory settings fake as ai-key-storage.
// ---------------------------------------------------------------------------

interface FakeStatement {
  sql: string;
  args: unknown[];
  bind(...values: unknown[]): FakeStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<void>;
}

function fakeDb(initialSettings: Record<string, unknown> = {}) {
  const settingsRows = new Map<string, string>();
  for (const [key, value] of Object.entries(initialSettings)) {
    settingsRows.set(key, JSON.stringify(value));
  }

  function statement(sql: string, args: unknown[] = []): FakeStatement {
    return {
      sql,
      args,
      bind: (...values: unknown[]) => statement(sql, values),
      all: async <T,>() => {
        if (/FROM settings/i.test(sql)) {
          return {
            results: [...settingsRows].map(([key, value]) => ({ key, value })) as unknown as T[],
          };
        }
        return { results: [] as T[] }; // tags / rules stay empty here
      },
      first: async <T,>() => {
        if (/SELECT value FROM settings WHERE key = \?/i.test(sql)) {
          const value = settingsRows.get(args[0] as string);
          return (value === undefined ? null : { value }) as T | null;
        }
        return null as T | null;
      },
      run: async () => {
        if (/DELETE FROM settings WHERE key = \?/i.test(sql)) {
          settingsRows.delete(args[0] as string);
        } else if (/^DELETE FROM settings$/i.test(sql.trim())) {
          settingsRows.clear(); // the wipe's whole-table delete
        }
      },
    };
  }

  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: FakeStatement[]) => {
      for (const stmt of statements) {
        if (/INSERT INTO settings/i.test(stmt.sql)) {
          const [key, value] = stmt.args as [string, string];
          settingsRows.set(key, value);
        }
      }
      return [];
    },
  } as unknown as D1Database;

  return { db, settingsRows };
}

describe('applyPreferences — briefing settings validation', () => {
  it('accepts the enable flag and cadence values', async () => {
    const { db } = fakeDb();
    const result = await applyPreferences(db, { briefingsEnabled: true, briefingCadence: 'daily' });
    expect(result.settings.briefingsEnabled).toBe(true);
    expect(result.settings.briefingCadence).toBe('daily');
  });

  for (const bad of ['yes', 1, null, [true]]) {
    it(`rejects briefingsEnabled ${JSON.stringify(bad)}`, async () => {
      const { db } = fakeDb();
      await expect(applyPreferences(db, { briefingsEnabled: bad })).rejects.toMatchObject({
        status: 400,
      });
    });
  }

  for (const bad of ['monthly', 'Daily', '', null, 2]) {
    it(`rejects briefingCadence ${JSON.stringify(bad)}`, async () => {
      const { db } = fakeDb();
      await expect(applyPreferences(db, { briefingCadence: bad })).rejects.toMatchObject({
        status: 400,
      });
    });
  }

  for (const good of ['123456', '15551234567', '123456789012345', '']) {
    it(`accepts recipient ${JSON.stringify(good)}`, async () => {
      const { db } = fakeDb();
      const result = await applyPreferences(db, { briefingWhatsappRecipient: good });
      expect(result.settings.briefingWhatsappRecipient).toBe(good);
    });
  }

  it('trims the recipient before validating and storing', async () => {
    const { db } = fakeDb();
    const result = await applyPreferences(db, { briefingWhatsappRecipient: ' 15551234567 ' });
    expect(result.settings.briefingWhatsappRecipient).toBe('15551234567');
  });

  for (const bad of [
    '+15551234567', // Cloud API wants digits only, no '+'
    '12345', // too short
    '1234567890123456', // too long
    '555-123-4567',
    '555 1234567',
    'abcdef',
    15551234567, // digits, wrong type
    null,
  ]) {
    it(`rejects recipient ${JSON.stringify(bad)}`, async () => {
      const { db } = fakeDb();
      await expect(applyPreferences(db, { briefingWhatsappRecipient: bad })).rejects.toMatchObject({
        status: 400,
      });
    });
  }

  for (const good of ['123456789012345', '1', '']) {
    it(`accepts phone number ID ${JSON.stringify(good)}`, async () => {
      const { db } = fakeDb();
      const result = await applyPreferences(db, { briefingWhatsappPhoneNumberId: good });
      expect(result.settings.briefingWhatsappPhoneNumberId).toBe(good);
    });
  }

  for (const bad of ['12a34', 'abc', 123, null]) {
    it(`rejects phone number ID ${JSON.stringify(bad)}`, async () => {
      const { db } = fakeDb();
      await expect(
        applyPreferences(db, { briefingWhatsappPhoneNumberId: bad }),
      ).rejects.toMatchObject({ status: 400 });
    });
  }

  it('rejects lastBriefingSentAt — the server alone stamps it', async () => {
    const { db } = fakeDb();
    await expect(
      applyPreferences(db, { lastBriefingSentAt: '2026-08-12T08:00:00.000Z' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('ignores a client-sent briefingWhatsappTokenSet — the flag stays derived', async () => {
    const { db } = fakeDb();
    const result = await applyPreferences(db, { briefingWhatsappTokenSet: true });
    expect(result.settings.briefingWhatsappTokenSet).toBe(false);
  });
});

describe('applyPreferences — briefingWhatsappToken is write-only', () => {
  it('stores the token, reports briefingWhatsappTokenSet, and never echoes it', async () => {
    const { db, settingsRows } = fakeDb();
    const result = await applyPreferences(db, { briefingWhatsappToken: TOKEN });

    expect(result.settings.briefingWhatsappTokenSet).toBe(true);
    // The whole serialized response, not just the fields we happen to check.
    expect(JSON.stringify(result)).not.toContain(TOKEN);

    expect(settingsRows.has(BRIEFING_TOKEN_SECRET_KEY)).toBe(true);
    expect(await readBriefingWhatsappToken(db)).toBe(TOKEN);
  });

  it('keeps the token out of /api/state as well', async () => {
    const { db } = fakeDb();
    await applyPreferences(db, { briefingWhatsappToken: TOKEN });
    const settings = await readSettings(db);
    expect(JSON.stringify(settings)).not.toContain(TOKEN);
    expect(settings.briefingWhatsappTokenSet).toBe(true);
  });

  it('null removes the stored token and flips the flag back', async () => {
    const { db, settingsRows } = fakeDb();
    await applyPreferences(db, { briefingWhatsappToken: TOKEN });
    const result = await applyPreferences(db, { briefingWhatsappToken: null });

    expect(result.settings.briefingWhatsappTokenSet).toBe(false);
    expect(settingsRows.has(BRIEFING_TOKEN_SECRET_KEY)).toBe(false);
    expect(await readBriefingWhatsappToken(db)).toBeNull();
  });

  for (const bad of ['', '   ', 123, true, {}, [TOKEN]]) {
    it(`rejects ${JSON.stringify(bad)} without echoing it`, async () => {
      const { db, settingsRows } = fakeDb();
      await expect(applyPreferences(db, { briefingWhatsappToken: bad })).rejects.toSatisfy(
        (err: unknown) =>
          (err as { status: number }).status === 400 &&
          !String((err as Error).message).includes(TOKEN),
      );
      expect(settingsRows.has(BRIEFING_TOKEN_SECRET_KEY)).toBe(false);
    });
  }

  it('redactAiSecret strips a leaked briefing token too', () => {
    const contaminated = {
      ...defaultSettings(),
      [BRIEFING_TOKEN_SECRET_KEY]: TOKEN,
    } as unknown as Settings;
    const clean = redactAiSecret(contaminated);
    expect(BRIEFING_TOKEN_SECRET_KEY in (clean as unknown as Record<string, unknown>)).toBe(false);
    expect(JSON.stringify(clean)).not.toContain(TOKEN);
  });

  it('briefingWhatsappTokenSet is derived, never trusted from its own row', async () => {
    const stale = fakeDb({ briefingWhatsappTokenSet: true });
    expect((await readSettings(stale.db)).briefingWhatsappTokenSet).toBe(false);

    const drifted = fakeDb({ briefingWhatsappTokenSet: false, [BRIEFING_TOKEN_SECRET_KEY]: TOKEN });
    expect((await readSettings(drifted.db)).briefingWhatsappTokenSet).toBe(true);
  });

  it("the wipe's whole-table settings DELETE clears the token", async () => {
    const { db, settingsRows } = fakeDb();
    await applyPreferences(db, { briefingWhatsappToken: TOKEN });
    expect(settingsRows.has(BRIEFING_TOKEN_SECRET_KEY)).toBe(true);

    // The wipe endpoint runs exactly this statement against the settings table.
    await (db as unknown as { prepare(sql: string): FakeStatement })
      .prepare('DELETE FROM settings')
      .run();
    expect(settingsRows.has(BRIEFING_TOKEN_SECRET_KEY)).toBe(false);
    expect(await readBriefingWhatsappToken(db)).toBeNull();
    expect((await readSettings(db)).briefingWhatsappTokenSet).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sendConfigError — the config gate's decisions
// ---------------------------------------------------------------------------

describe('sendConfigError', () => {
  const configured = (): Settings => ({
    ...defaultSettings(),
    briefingsEnabled: true,
    briefingWhatsappRecipient: '15551234567',
    briefingWhatsappPhoneNumberId: '123456789012345',
  });

  it('blocks when briefings are disabled', () => {
    expect(sendConfigError(defaultSettings(), true)).toBe(
      'Briefings are turned off. Enable them in Settings first.',
    );
  });

  it('blocks on a missing recipient', () => {
    expect(sendConfigError({ ...configured(), briefingWhatsappRecipient: '' }, true)).toBe(
      'Add the WhatsApp recipient number in Settings first.',
    );
  });

  it('blocks on a missing phone number ID', () => {
    expect(sendConfigError({ ...configured(), briefingWhatsappPhoneNumberId: '' }, true)).toBe(
      'Add the WhatsApp phone number ID in Settings first.',
    );
  });

  it('blocks when no token is stored', () => {
    expect(sendConfigError(configured(), false)).toBe(
      'Save a WhatsApp access token in Settings first.',
    );
  });

  it('passes a complete configuration', () => {
    expect(sendConfigError(configured(), true)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readableWhatsappError — safe copy, originals dropped by construction
// ---------------------------------------------------------------------------

describe('readableWhatsappError', () => {
  it('maps auth failures to the token message', () => {
    expect(readableWhatsappError(401, null).message).toBe(
      'Meta rejected the access token. Check the token saved in Settings.',
    );
    expect(readableWhatsappError(403, 10).message).toBe(
      'Meta rejected the access token. Check the token saved in Settings.',
    );
  });

  it('maps 404 to the phone number ID message', () => {
    expect(readableWhatsappError(404, null).message).toBe(
      'Meta does not know that phone number ID. Check the value saved in Settings.',
    );
  });

  it('names the development-mode test-number reality on 131030', () => {
    const msg = readableWhatsappError(400, 131030).message;
    expect(msg).toContain('development mode');
    expect(msg).toContain('test number');
  });

  it('gives recipient guidance on 131026 and window guidance on 131047', () => {
    expect(readableWhatsappError(400, 131026).message).toContain('cannot deliver');
    expect(readableWhatsappError(400, 131047).message).toContain('window');
  });

  it('falls back to readable generic copy for unknown 400s and 5xx', () => {
    expect(readableWhatsappError(400, 999).message).toBe(
      'Meta did not accept the message. Check the recipient number and phone number ID saved in Settings.',
    );
    expect(readableWhatsappError(500, null).message).toBe(
      'WhatsApp could not process this message right now. Try again.',
    );
  });
});
