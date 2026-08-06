// The BYOK key is write-only. These tests pin that invariant from both ends:
// the redaction helper every preferences response is built through, and the
// full applyPreferences round-trip against an in-memory `settings` table.
//
// The fake below extends the one in preferences-validation.test.ts with the
// single-statement `.run()` path, which is how the key row is deleted.
import { describe, expect, it } from 'vitest';
import { defaultSettings, type Settings } from '../shared/types';
import { applyPreferences, buildPreferencesResult } from '../worker/preferences';
import { AI_KEY_SECRET_KEY, readAiApiKey, readSettings, redactAiSecret } from '../worker/settingsStore';

const SECRET = 'sk-ant-test-do-not-echo-0123456789';

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

describe('redactAiSecret — the helper every preferences response goes through', () => {
  it('strips the secret key even when something upstream leaked it in', () => {
    const contaminated = {
      ...defaultSettings(),
      [AI_KEY_SECRET_KEY]: SECRET,
    } as unknown as Settings;

    const clean = redactAiSecret(contaminated);
    expect(AI_KEY_SECRET_KEY in (clean as unknown as Record<string, unknown>)).toBe(false);
    expect(JSON.stringify(clean)).not.toContain(SECRET);
  });

  it('leaves every legitimate setting untouched', () => {
    const settings = { ...defaultSettings(), currency: 'EUR', aiProvider: 'anthropic' as const };
    expect(redactAiSecret(settings)).toEqual(settings);
  });

  it('buildPreferencesResult cannot emit the secret', () => {
    const contaminated = {
      ...defaultSettings(),
      [AI_KEY_SECRET_KEY]: SECRET,
    } as unknown as Settings;

    const result = buildPreferencesResult(contaminated, [], []);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe('applyPreferences — aiApiKey is write-only', () => {
  it('stores the key, reports aiKeySet, and never echoes it', async () => {
    const { db, settingsRows } = fakeDb();
    const result = await applyPreferences(db, { aiProvider: 'anthropic', aiApiKey: SECRET });

    expect(result.settings.aiProvider).toBe('anthropic');
    expect(result.settings.aiKeySet).toBe(true);
    // The whole serialized response, not just the fields we happen to check.
    expect(JSON.stringify(result)).not.toContain(SECRET);

    // It is stored — under a key that is not part of the Settings payload.
    expect(settingsRows.has(AI_KEY_SECRET_KEY)).toBe(true);
    expect(await readAiApiKey(db)).toBe(SECRET);
  });

  it('keeps the key out of /api/state as well', async () => {
    const { db } = fakeDb();
    await applyPreferences(db, { aiApiKey: SECRET });
    const settings = await readSettings(db);
    expect(JSON.stringify(settings)).not.toContain(SECRET);
    expect(settings.aiKeySet).toBe(true);
  });

  it('trims the key before storing it', async () => {
    const { db } = fakeDb();
    await applyPreferences(db, { aiApiKey: `  ${SECRET}  ` });
    expect(await readAiApiKey(db)).toBe(SECRET);
  });

  it('null removes the stored key and flips aiKeySet back to false', async () => {
    const { db, settingsRows } = fakeDb();
    await applyPreferences(db, { aiApiKey: SECRET });
    const result = await applyPreferences(db, { aiApiKey: null });

    expect(result.settings.aiKeySet).toBe(false);
    expect(settingsRows.has(AI_KEY_SECRET_KEY)).toBe(false);
    expect(await readAiApiKey(db)).toBeNull();
  });

  it('leaves an existing key alone when the field is absent', async () => {
    const { db } = fakeDb();
    await applyPreferences(db, { aiApiKey: SECRET });
    const result = await applyPreferences(db, { currency: 'EUR' });

    expect(result.settings.aiKeySet).toBe(true);
    expect(await readAiApiKey(db)).toBe(SECRET);
  });

  // A blank string is a mistake, not a request to clear — `null` is the clear.
  for (const bad of ['', '   ', 123, true, {}, ['sk-ant'], undefined]) {
    it(`rejects ${JSON.stringify(bad) ?? 'undefined'} without echoing it`, async () => {
      const { db, settingsRows } = fakeDb();
      await expect(applyPreferences(db, { aiApiKey: bad })).rejects.toMatchObject({ status: 400 });
      expect(settingsRows.has(AI_KEY_SECRET_KEY)).toBe(false);
    });
  }

  it('the rejection message never quotes the key', async () => {
    const { db } = fakeDb();
    // A key-shaped value that still fails validation (wrong type wrapping).
    await expect(applyPreferences(db, { aiApiKey: [SECRET] })).rejects.toSatisfy(
      (err: unknown) => !String((err as Error).message).includes(SECRET),
    );
  });
});

describe('aiKeySet is derived, never trusted from its own row', () => {
  it('reports false when a stale row claims true but no key is stored', async () => {
    const { db } = fakeDb({ aiKeySet: true });
    expect((await readSettings(db)).aiKeySet).toBe(false);
  });

  it('reports true when a key is stored but the row claims false', async () => {
    const { db } = fakeDb({ aiKeySet: false, [AI_KEY_SECRET_KEY]: SECRET });
    expect((await readSettings(db)).aiKeySet).toBe(true);
  });

  it('treats a blank stored key as no key', async () => {
    const { db } = fakeDb({ [AI_KEY_SECRET_KEY]: '   ' });
    expect((await readSettings(db)).aiKeySet).toBe(false);
    expect(await readAiApiKey(db)).toBeNull();
  });
});

describe('applyPreferences — aiProvider and aiModel', () => {
  for (const provider of ['off', 'workers-ai', 'anthropic'] as const) {
    it(`accepts ${provider}`, async () => {
      const { db } = fakeDb();
      const result = await applyPreferences(db, { aiProvider: provider });
      expect(result.settings.aiProvider).toBe(provider);
    });
  }

  for (const bad of ['openai', 'Workers-AI', '', null, 1, true, ['off']]) {
    it(`rejects the provider ${JSON.stringify(bad)}`, async () => {
      const { db } = fakeDb();
      await expect(applyPreferences(db, { aiProvider: bad })).rejects.toMatchObject({ status: 400 });
    });
  }

  it('stores a trimmed model override, and null for the provider default', async () => {
    const { db } = fakeDb();
    expect((await applyPreferences(db, { aiModel: '  claude-sonnet-5  ' })).settings.aiModel).toBe(
      'claude-sonnet-5',
    );
    expect((await applyPreferences(db, { aiModel: null })).settings.aiModel).toBeNull();
    // A blank override means "use the default", not an empty model id.
    expect((await applyPreferences(db, { aiModel: '   ' })).settings.aiModel).toBeNull();
  });

  for (const bad of [42, true, {}, ['m']]) {
    it(`rejects the model ${JSON.stringify(bad)}`, async () => {
      const { db } = fakeDb();
      await expect(applyPreferences(db, { aiModel: bad })).rejects.toMatchObject({ status: 400 });
    });
  }

  it('does not write the key when a later field in the same body fails', async () => {
    const { db, settingsRows } = fakeDb();
    await expect(
      applyPreferences(db, { aiApiKey: SECRET, aiProvider: 'nope' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(settingsRows.has(AI_KEY_SECRET_KEY)).toBe(false);
  });
});
