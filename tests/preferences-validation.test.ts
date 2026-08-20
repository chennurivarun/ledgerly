// applyPreferences (worker/preferences.ts) validation for the sprint-2
// `currency`/`onboarded` keys, plus the sprint-19 `localStatementPacks`
// validator (the one place in this file the REAL engine's `validatePack` is
// the subject under test, not a mock). Every other validator in that file is
// exercised only indirectly (through the live API), since applyPreferences
// needs a D1Database — this is the first test in the repo to give it one, so
// the fake below is scoped tightly to the two things applyPreferences
// actually does with `db`: read/write the `settings` table (readSettings /
// writeSettings) and read the always-empty-here `tags`/`rules` tables
// (readTags / readRules, called unconditionally at the end of every request).
import { describe, expect, it } from 'vitest';
import { LOCAL_PACK_MAX_BYTES, LOCAL_PACKS_MAX } from '../shared/packs/registry';
import { inKotakSavings } from '../shared/packs/packs/in-kotak-savings';
import type { StatementPack } from '../shared/packs/spec';
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

// ---------------------------------------------------------------------------
// applyPreferences — localStatementPacks (sprint 19). validatePack here is
// the REAL shared/packs/engine implementation, not a mock: this is the one
// place in the repo that exercises the worker's wholesale reject-on-any-
// failure discipline against the actual engine.
// ---------------------------------------------------------------------------

/** A structurally valid local pack, distinct from every bundled id. */
function localPack(overrides: Partial<StatementPack> = {}): StatementPack {
  return { ...structuredClone(inKotakSavings), id: 'in.my-bank.savings', name: 'My Bank', ...overrides };
}

describe('applyPreferences — localStatementPacks', () => {
  it('a valid single pack round-trips through save and read-back', async () => {
    const { db, settingsRows } = fakeDb();
    const pack = localPack();
    const res = await applyPreferences(db, { localStatementPacks: [pack] });
    expect(res.settings.localStatementPacks).toEqual([pack]);
    expect(settingsRows.has('localStatementPacks')).toBe(true);
  });

  it('rejects a non-array value', async () => {
    const { db } = fakeDb();
    await expect(
      applyPreferences(db, { localStatementPacks: { not: 'an array' } }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it(`rejects more than ${LOCAL_PACKS_MAX} packs`, async () => {
    const { db, settingsRows } = fakeDb();
    const many = Array.from({ length: LOCAL_PACKS_MAX + 1 }, (_, i) =>
      localPack({ id: `in.bank-${i}.savings` }),
    );
    await expect(applyPreferences(db, { localStatementPacks: many })).rejects.toMatchObject({
      status: 400,
    });
    expect(settingsRows.has('localStatementPacks')).toBe(false);
  });

  it('an invalid pack (a signature regex that fails to compile) 400s naming the index and the engine reason', async () => {
    const { db } = fakeDb();
    const bad = localPack({ signature: ['(unterminated'] });
    await expect(applyPreferences(db, { localStatementPacks: [bad] })).rejects.toMatchObject({
      status: 400,
    });
    await expect(applyPreferences(db, { localStatementPacks: [bad] })).rejects.toThrow(
      'Pack 1: signature entry must be a string that compiles as a RegExp',
    );
  });

  it('rejects duplicate ids within the same list', async () => {
    const { db } = fakeDb();
    const dupe = [localPack(), localPack({ name: 'My Bank (again)' })];
    await expect(applyPreferences(db, { localStatementPacks: dupe })).rejects.toMatchObject({
      status: 400,
    });
    await expect(applyPreferences(db, { localStatementPacks: dupe })).rejects.toThrow(
      'Pack 2: id "in.my-bank.savings" is already used earlier in this list.',
    );
  });

  it('rejects an id colliding with a bundled pack', async () => {
    const { db } = fakeDb();
    const collides = localPack({ id: 'in.kotak.savings' });
    await expect(applyPreferences(db, { localStatementPacks: [collides] })).rejects.toMatchObject({
      status: 400,
    });
    await expect(applyPreferences(db, { localStatementPacks: [collides] })).rejects.toThrow(
      'Pack 1: id "in.kotak.savings" collides with a bundled pack.',
    );
  });

  it(`rejects a pack whose serialized size exceeds ${LOCAL_PACK_MAX_BYTES} bytes`, async () => {
    const { db } = fakeDb();
    const oversized = localPack({ name: 'x'.repeat(LOCAL_PACK_MAX_BYTES) });
    await expect(applyPreferences(db, { localStatementPacks: [oversized] })).rejects.toMatchObject({
      status: 400,
    });
    await expect(applyPreferences(db, { localStatementPacks: [oversized] })).rejects.toThrow(
      `Pack 1: exceeds ${LOCAL_PACK_MAX_BYTES} bytes serialized.`,
    );
  });

  it('an empty list is valid and clears any previously saved packs', async () => {
    const { db, settingsRows } = fakeDb({ localStatementPacks: [localPack()] });
    const res = await applyPreferences(db, { localStatementPacks: [] });
    expect(res.settings.localStatementPacks).toEqual([]);
    expect(settingsRows.get('localStatementPacks')).toBe('[]');
  });

  it('a mix of one valid and one invalid pack rejects the WHOLE list — the valid entry is not persisted either (pins the wholesale contract against a future incremental-accumulation refactor)', async () => {
    const { db, settingsRows } = fakeDb();
    const valid = localPack();
    const invalid = localPack({ id: 'in.other-bank.savings', signature: ['(unterminated'] });
    await expect(applyPreferences(db, { localStatementPacks: [valid, invalid] })).rejects.toMatchObject({
      status: 400,
    });
    await expect(applyPreferences(db, { localStatementPacks: [valid, invalid] })).rejects.toThrow(
      'Pack 2: signature entry must be a string that compiles as a RegExp',
    );
    // Not "the invalid one was dropped" — NOTHING was written, not even the
    // valid entry that validated fine on its own. No row at all, same as a
    // totally untouched settings table.
    expect(settingsRows.has('localStatementPacks')).toBe(false);
    expect([...settingsRows.keys()]).toEqual([]);
  });
});
