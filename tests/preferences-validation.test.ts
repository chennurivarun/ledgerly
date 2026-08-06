// applyPreferences (worker/preferences.ts) validation for the sprint-2
// `currency`/`onboarded` keys. Every other validator in that file is
// exercised only indirectly (through the live API), since applyPreferences
// needs a D1Database — this is the first test in the repo to give it one, so
// the fake below is scoped tightly to the two things applyPreferences
// actually does with `db`: read/write the `settings` table (readSettings /
// writeSettings) and read the always-empty-here `tags`/`rules` tables
// (readTags / readRules, called unconditionally at the end of every request).
import { describe, expect, it } from 'vitest';
import { applyPreferences } from '../worker/preferences';

interface FakeStatement {
  sql: string;
  args: unknown[];
  bind(...values: unknown[]): FakeStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

/** In-memory `settings` table, keyed exactly like the real D1 schema (spec §4.1). */
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
          return { results: [...settingsRows].map(([key, value]) => ({ key, value })) as unknown as T[] };
        }
        // tags/rules are always read back by applyPreferences, but no test
        // here sends `tags`/`rules` in the body, so both stay empty.
        return { results: [] as T[] };
      },
      first: async <T,>() => null as T | null,
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

describe('applyPreferences — currency', () => {
  it('accepts a supported code and writes only that key', async () => {
    const { db, settingsRows } = fakeDb({ assetsTotal: 1234.5, selectedPeriod: 'this-year' });
    const res = await applyPreferences(db, { currency: 'EUR' });
    expect(res.settings.currency).toBe('EUR');
    expect([...settingsRows.keys()].sort()).toEqual(['assetsTotal', 'currency', 'selectedPeriod']);
    // Untouched groups keep their prior values (spec §4.5 partial update).
    expect(res.settings.assetsTotal).toBe(1234.5);
    expect(res.settings.selectedPeriod).toBe('this-year');
  });

  for (const bad of ['eur', 'XYZ', '', 'USD ', 'BTC']) {
    it(`rejects an unsupported code ${JSON.stringify(bad)}`, async () => {
      const { db } = fakeDb();
      await expect(applyPreferences(db, { currency: bad })).rejects.toMatchObject({ status: 400 });
    });
  }

  for (const bad of [null, 123, true, ['USD'], { code: 'USD' }, undefined]) {
    it(`rejects a non-string value ${JSON.stringify(bad) ?? 'undefined'}`, async () => {
      const { db } = fakeDb();
      await expect(applyPreferences(db, { currency: bad })).rejects.toMatchObject({ status: 400 });
    });
  }

  it('leaves currency untouched when the key is absent from the body', async () => {
    const { db, settingsRows } = fakeDb({ currency: 'GBP' });
    const res = await applyPreferences(db, { selectedPeriod: 'this-month' });
    expect(res.settings.currency).toBe('GBP');
    expect(settingsRows.get('currency')).toBe('"GBP"');
    expect(settingsRows.has('selectedPeriod')).toBe(true);
  });
});

describe('applyPreferences — onboarded', () => {
  it('accepts true and false', async () => {
    const { db: dbTrue } = fakeDb();
    expect((await applyPreferences(dbTrue, { onboarded: true })).settings.onboarded).toBe(true);
    const { db: dbFalse } = fakeDb();
    expect((await applyPreferences(dbFalse, { onboarded: false })).settings.onboarded).toBe(false);
  });

  for (const bad of ['true', 1, 0, null, {}, ['true']]) {
    it(`rejects a non-boolean value ${JSON.stringify(bad)}`, async () => {
      const { db } = fakeDb();
      await expect(applyPreferences(db, { onboarded: bad })).rejects.toMatchObject({ status: 400 });
    });
  }

  it('rejects undefined even though the key is present', async () => {
    const { db } = fakeDb();
    await expect(applyPreferences(db, { onboarded: undefined })).rejects.toMatchObject({ status: 400 });
  });

  it('does not touch onboarded when the key is absent from the body', async () => {
    const { db, settingsRows } = fakeDb({ onboarded: true });
    const res = await applyPreferences(db, { currency: 'USD' });
    expect(res.settings.onboarded).toBe(true);
    expect(settingsRows.get('onboarded')).toBe('true');
  });
});

describe('applyPreferences — a rejected body writes nothing', () => {
  it('never persists an earlier valid key once a later key in the same body fails validation', async () => {
    const { db, settingsRows } = fakeDb();
    await expect(
      applyPreferences(db, { assetsTotal: 999, currency: 'NOPE' }),
    ).rejects.toMatchObject({ status: 400 });
    expect([...settingsRows.keys()]).toEqual([]);
  });
});
