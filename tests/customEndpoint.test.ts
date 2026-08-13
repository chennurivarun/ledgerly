// The BYO endpoint provider (sprint 15): base-URL validation and
// normalization, the write-only optional key, provider gating (keyless-ready
// is the point), the OpenAI-shaped request layer S16 will reuse (multi-image
// message building), the anthropic-style error taxonomy, and the images-only
// mime gate with its honest PDF refusal.
//
// No network anywhere: the HTTP layer runs against an injectable fetch
// (sarvam.test.ts convention) and the settings round-trips run against the
// in-memory fake D1 from ai-key-storage.test.ts.
import { describe, expect, it } from 'vitest';
import { defaultSettings, type Settings } from '../shared/types';
import {
  runCustomChat,
  runCustomReceipt,
  visionMessages,
  type ChatMessage,
} from '../worker/ai/custom';
import { normalizeExtraction } from '../worker/ai/normalize';
import {
  assertMimeSupported,
  CUSTOM_NO_PDF,
  selectProvider,
  selectStatementProvider,
  supportsMime,
} from '../worker/ai/providers';
import {
  customMissingConfig,
  pdfStatementsBlockedCopy,
} from '../src/components/ai/preflightHelpers';
import { applyPreferences, normalizeCustomBaseUrl } from '../worker/preferences';
import {
  CUSTOM_KEY_SECRET_KEY,
  readCustomApiKey,
  readSettings,
  redactAiSecret,
} from '../worker/settingsStore';

const SECRET = 'nvapi-test-key-do-not-echo-0123456789';
const CATEGORIES = ['Groceries', 'Dining', 'Needs review'];

function settingsWith(patch: Partial<Settings>): Settings {
  return { ...defaultSettings(), ...patch };
}

/** The active-and-fully-configured custom settings most gating tests start from. */
function customReady(): Settings {
  return settingsWith({
    aiProvider: 'custom',
    customBaseUrl: 'https://integrate.api.nvidia.com/v1',
    aiModel: 'nvidia/nemotron-3.5-lightning-30b-a3b',
  });
}

// ---------------------------------------------------------------------------
// URL validation + normalization (worker/preferences.ts)
// ---------------------------------------------------------------------------

describe('normalizeCustomBaseUrl', () => {
  it('accepts https and stores it as typed', () => {
    expect(normalizeCustomBaseUrl('https://integrate.api.nvidia.com/v1')).toBe(
      'https://integrate.api.nvidia.com/v1',
    );
  });

  it('strips trailing slashes so the client can always append /chat/completions', () => {
    expect(normalizeCustomBaseUrl('https://openrouter.ai/api/v1/')).toBe(
      'https://openrouter.ai/api/v1',
    );
    expect(normalizeCustomBaseUrl('https://openrouter.ai/api/v1///')).toBe(
      'https://openrouter.ai/api/v1',
    );
  });

  it('a bare-origin https URL normalizes to origin with no trailing slash', () => {
    // new URL() always reports pathname '/', which must not survive storage.
    expect(normalizeCustomBaseUrl('https://example.com')).toBe('https://example.com');
    expect(normalizeCustomBaseUrl('https://example.com/')).toBe('https://example.com');
  });

  it('trims surrounding whitespace before validating', () => {
    expect(normalizeCustomBaseUrl('  https://example.com/v1  ')).toBe('https://example.com/v1');
  });

  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    it(`allows plain http for ${host} (the local-dev Ollama pairing)`, () => {
      expect(normalizeCustomBaseUrl(`http://${host}:11434/v1`)).toBe(`http://${host}:11434/v1`);
    });
  }

  it('refuses plain http on any remote host, naming the https rule', () => {
    expect(() => normalizeCustomBaseUrl('http://api.example.com/v1')).toThrow(
      /https.*localhost/i,
    );
    // A lookalike must not ride the localhost loophole.
    expect(() => normalizeCustomBaseUrl('http://localhost.evil.com/v1')).toThrow(
      /https.*localhost/i,
    );
  });

  it('refuses embedded credentials — the key has its own write-only field', () => {
    expect(() => normalizeCustomBaseUrl('https://user:pass@example.com/v1')).toThrow(
      /must not embed credentials/i,
    );
    // Username alone is still a credential in the URL.
    expect(() => normalizeCustomBaseUrl('https://token@example.com/v1')).toThrow(
      /must not embed credentials/i,
    );
  });

  it('refuses query strings and fragments', () => {
    expect(() => normalizeCustomBaseUrl('https://example.com/v1?key=abc')).toThrow(
      /query string or fragment/i,
    );
    expect(() => normalizeCustomBaseUrl('https://example.com/v1#section')).toThrow(
      /query string or fragment/i,
    );
  });

  it('refuses non-http(s) schemes and unparseable values, readably', () => {
    expect(() => normalizeCustomBaseUrl('ftp://example.com/v1')).toThrow(/https/i);
    expect(() => normalizeCustomBaseUrl('not a url')).toThrow(/full URL/i);
    expect(() => normalizeCustomBaseUrl(42)).toThrow(/URL like/i);
  });

  it("'' clears (and trims down to a clear)", () => {
    expect(normalizeCustomBaseUrl('')).toBe('');
    expect(normalizeCustomBaseUrl('   ')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Settings round-trip — write-only key, derived flag, redaction
// (fake D1 shape shared with ai-key-storage.test.ts)
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
        return { results: [] as T[] };
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

describe('custom endpoint settings round-trip', () => {
  it('stores base URL normalized and derives customKeySet without ever echoing the key', async () => {
    const { db } = fakeDb();
    const result = await applyPreferences(db, {
      aiProvider: 'custom',
      customBaseUrl: 'https://integrate.api.nvidia.com/v1/',
      customApiKey: SECRET,
    });

    expect(result.settings.aiProvider).toBe('custom');
    expect(result.settings.customBaseUrl).toBe('https://integrate.api.nvidia.com/v1');
    expect(result.settings.customKeySet).toBe(true);
    // The key appears NOWHERE in the response.
    expect(JSON.stringify(result)).not.toContain(SECRET);
    // But it is stored, retrievable only by the worker-side reader.
    expect(await readCustomApiKey(db)).toBe(SECRET);
  });

  it('null clears the stored key; customKeySet follows the row', async () => {
    const { db } = fakeDb({ [CUSTOM_KEY_SECRET_KEY]: SECRET });
    expect((await readSettings(db)).customKeySet).toBe(true);

    const result = await applyPreferences(db, { customApiKey: null });
    expect(result.settings.customKeySet).toBe(false);
    expect(await readCustomApiKey(db)).toBeNull();
  });

  it("'' clears the base URL", async () => {
    const { db } = fakeDb({ customBaseUrl: 'https://example.com/v1' });
    const result = await applyPreferences(db, { customBaseUrl: '' });
    expect(result.settings.customBaseUrl).toBe('');
  });

  it('an invalid base URL 400s and writes nothing', async () => {
    const { db, settingsRows } = fakeDb();
    await expect(
      applyPreferences(db, { customBaseUrl: 'http://api.example.com/v1' }),
    ).rejects.toThrow(/https.*localhost/i);
    expect(settingsRows.has('customBaseUrl')).toBe(false);
  });

  it('an empty-string key is refused, not treated as a clear', async () => {
    const { db } = fakeDb();
    await expect(applyPreferences(db, { customApiKey: '   ' })).rejects.toThrow(
      /non-empty key, or null/i,
    );
  });

  it("aiProvider accepts 'custom'", async () => {
    const { db } = fakeDb();
    const result = await applyPreferences(db, { aiProvider: 'custom' });
    expect(result.settings.aiProvider).toBe('custom');
  });

  it('redactAiSecret strips the custom secret even if something upstream leaked it in', () => {
    const contaminated = {
      ...defaultSettings(),
      [CUSTOM_KEY_SECRET_KEY]: SECRET,
    } as unknown as Settings;
    expect(JSON.stringify(redactAiSecret(contaminated))).not.toContain(SECRET);
  });

  it('a client echoing customKeySet back is ignored — the flag stays derived', async () => {
    const { db } = fakeDb();
    const result = await applyPreferences(db, { customKeySet: true } as Record<string, unknown>);
    expect(result.settings.customKeySet).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Provider gating — keyless-with-URL-and-model is READY; the two 400s
// ---------------------------------------------------------------------------

describe('selectProvider — custom', () => {
  it('keyless with URL + model is READY (Ollama needs no key)', () => {
    expect(selectProvider(customReady())).toEqual({
      provider: 'custom',
      model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    });
  });

  it('without a base URL: readable 400 pointing at Settings', () => {
    expect(() =>
      selectProvider(settingsWith({ aiProvider: 'custom', aiModel: 'some-model' })),
    ).toThrow(/endpoint base URL in Settings/i);
  });

  it("without a model: the pinned 'Set the model id in Settings → AI.' — no invented default", () => {
    expect(() =>
      selectProvider(settingsWith({ aiProvider: 'custom', customBaseUrl: 'https://x.dev/v1' })),
    ).toThrow('Set the model id in Settings → AI.');
    // Whitespace is not a model id either.
    expect(() =>
      selectProvider(
        settingsWith({ aiProvider: 'custom', customBaseUrl: 'https://x.dev/v1', aiModel: '  ' }),
      ),
    ).toThrow('Set the model id in Settings → AI.');
  });
});

describe('mime gating — images only for custom', () => {
  for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/jpg']) {
    it(`${mime} is supported`, () => {
      expect(supportsMime('custom', mime)).toBe(true);
      expect(() => assertMimeSupported('custom', mime)).not.toThrow();
    });
  }

  it('PDFs are refused with the pinned honest copy (receipt path only since S16)', () => {
    expect(supportsMime('custom', 'application/pdf')).toBe(false);
    expect(() => assertMimeSupported('custom', 'application/pdf')).toThrow(CUSTOM_NO_PDF);
    // The copy points multi-page PDFs at the door that DOES work now.
    expect(CUSTOM_NO_PDF).toMatch(/Read as statement/);
  });

  it('statements ACCEPT custom since S16 (the browser-pages flow), with its config gates', () => {
    expect(selectStatementProvider(customReady())).toEqual({
      provider: 'custom',
      model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    });
    // An unconfigured custom gets the same actionable config 400s as
    // receipts — "set the base URL" now leads somewhere real.
    expect(() => selectStatementProvider(settingsWith({ aiProvider: 'custom' }))).toThrow(
      /endpoint base URL in Settings/i,
    );
    expect(() =>
      selectStatementProvider(
        settingsWith({ aiProvider: 'custom', customBaseUrl: 'https://x.dev/v1' }),
      ),
    ).toThrow('Set the model id in Settings → AI.');
  });
});

// ---------------------------------------------------------------------------
// Client-side readiness helpers (Documents banner + Settings caution)
// ---------------------------------------------------------------------------

describe('customMissingConfig', () => {
  it('keyless with URL + model = READY (null)', () => {
    expect(customMissingConfig('custom', 'https://x.dev/v1', 'model-a')).toBeNull();
  });

  it('names exactly what is missing', () => {
    expect(customMissingConfig('custom', '', null)).toBe('endpoint base URL and model id');
    expect(customMissingConfig('custom', '', 'model-a')).toBe('endpoint base URL');
    expect(customMissingConfig('custom', 'https://x.dev/v1', null)).toBe('model id');
    expect(customMissingConfig('custom', 'https://x.dev/v1', '   ')).toBe('model id');
  });

  it('never fires for other providers', () => {
    expect(customMissingConfig('anthropic', '', null)).toBeNull();
    expect(customMissingConfig('off', '', null)).toBeNull();
  });
});

describe('pdfStatementsBlockedCopy', () => {
  it('names Workers AI for workers-ai', () => {
    expect(pdfStatementsBlockedCopy('workers-ai')).toMatch(/Workers AI/);
  });

  it('null for the providers that can read statements — custom included since S16', () => {
    expect(pdfStatementsBlockedCopy('anthropic')).toBeNull();
    expect(pdfStatementsBlockedCopy('sarvam')).toBeNull();
    expect(pdfStatementsBlockedCopy('custom')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Message building — the S16 seam
// ---------------------------------------------------------------------------

describe('visionMessages', () => {
  it('single image: system + one user turn, image part then instruction text', () => {
    const messages = visionMessages(['data:image/png;base64,AAA'], 'SYSTEM', 'INSTRUCTION');
    expect(messages).toEqual([
      { role: 'system', content: 'SYSTEM' },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
          { type: 'text', text: 'INSTRUCTION' },
        ],
      },
    ]);
  });

  it('multiple images ride ONE user turn, in order, instruction last — what S16 needs', () => {
    const pages = ['data:image/png;base64,P1', 'data:image/png;base64,P2', 'data:image/png;base64,P3'];
    const messages = visionMessages(pages, 'SYSTEM', 'READ ALL PAGES');
    expect(messages).toHaveLength(2);
    const content = messages[1].content as Exclude<ChatMessage['content'], string>;
    expect(content).toHaveLength(4);
    expect(content.slice(0, 3).map((p) => (p.type === 'image_url' ? p.image_url.url : ''))).toEqual(
      pages,
    );
    expect(content[3]).toEqual({ type: 'text', text: 'READ ALL PAGES' });
  });
});

// ---------------------------------------------------------------------------
// The request layer — wire shape, auth, taxonomy. Injected fetch, no network.
// ---------------------------------------------------------------------------

interface Call {
  url: string;
  init?: RequestInit;
}

function completionResponse(content: unknown, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function scriptedFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const CFG = {
  baseUrl: 'https://integrate.api.nvidia.com/v1',
  apiKey: SECRET,
  model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
};

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hi' }];

describe('runCustomChat — request shape', () => {
  it('POSTs {baseUrl}/chat/completions with model, temperature 0 and NO response_format', async () => {
    const { fetchImpl, calls } = scriptedFetch(() => completionResponse('ok'));
    await runCustomChat(CFG, MESSAGES, { fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(calls[0].init?.method).toBe('POST');
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect(body.model).toBe(CFG.model);
    expect(body.temperature).toBe(0);
    expect(body.messages).toEqual(MESSAGES);
    // Pinned: no structured-output field — server support varies and the
    // normalize pipeline distrusts the output either way.
    expect('response_format' in body).toBe(false);
  });

  it('sends Bearer auth exactly when a key is present', async () => {
    const withKey = scriptedFetch(() => completionResponse('ok'));
    await runCustomChat(CFG, MESSAGES, { fetchImpl: withKey.fetchImpl });
    expect((withKey.calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${SECRET}`,
    );

    const keyless = scriptedFetch(() => completionResponse('ok'));
    await runCustomChat({ ...CFG, apiKey: null }, MESSAGES, { fetchImpl: keyless.fetchImpl });
    // No Authorization header AT ALL — not an empty one.
    expect('Authorization' in (keyless.calls[0].init?.headers as Record<string, string>)).toBe(
      false,
    );
  });

  it('reads a plain string content', async () => {
    const { fetchImpl } = scriptedFetch(() => completionResponse('the answer'));
    expect(await runCustomChat(CFG, MESSAGES, { fetchImpl })).toBe('the answer');
  });

  it('reads content-part arrays (some servers return them) by joining the text parts', async () => {
    const { fetchImpl } = scriptedFetch(() =>
      completionResponse([
        { type: 'text', text: '{"a":' },
        { type: 'text', text: '1}' },
      ]),
    );
    expect(await runCustomChat(CFG, MESSAGES, { fetchImpl })).toBe('{"a":1}');
  });
});

describe('runCustomChat — error taxonomy (bodies dropped, key never quoted)', () => {
  const failing = (status: number) =>
    scriptedFetch(
      () =>
        new Response(JSON.stringify({ error: `secret-echoing body ${SECRET}` }), { status }),
    );

  for (const status of [401, 403]) {
    it(`${status} → key copy naming "your custom endpoint", body dropped`, async () => {
      const { fetchImpl } = failing(status);
      const err = await runCustomChat(CFG, MESSAGES, { fetchImpl }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/custom endpoint rejected the API key/i);
      expect((err as Error).message).not.toContain(SECRET);
    });
  }

  it('404 → model-or-path copy (compatible servers 404 for both)', async () => {
    const { fetchImpl } = failing(404);
    await expect(runCustomChat(CFG, MESSAGES, { fetchImpl })).rejects.toThrow(
      /no such model or path.*base URL and model id/i,
    );
  });

  it('429 → rate-limit copy', async () => {
    const { fetchImpl } = failing(429);
    await expect(runCustomChat(CFG, MESSAGES, { fetchImpl })).rejects.toThrow(/rate limited/i);
  });

  it('500 → generic readable copy', async () => {
    const { fetchImpl } = failing(500);
    await expect(runCustomChat(CFG, MESSAGES, { fetchImpl })).rejects.toThrow(
      /could not process this request/i,
    );
  });

  it('network failure → readable copy; the thrown detail (which carries the URL) is dropped', async () => {
    const fetchImpl = (async () => {
      throw new Error(`connect ECONNREFUSED ${CFG.baseUrl}?key=${SECRET}`);
    }) as unknown as typeof fetch;
    const err = await runCustomChat(CFG, MESSAGES, { fetchImpl }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/could not reach your custom endpoint/i);
    expect((err as Error).message).not.toContain(SECRET);
    expect((err as Error).message).not.toContain('ECONNREFUSED');
  });

  it('a hung server hits the timeout with the 90-second copy', async () => {
    // Never resolves on its own; rejects only when the client aborts.
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;
    await expect(runCustomChat(CFG, MESSAGES, { fetchImpl, timeoutMs: 5 })).rejects.toThrow(
      /did not answer within 90 seconds/i,
    );
  });

  it('unparseable and shapeless responses are refused readably', async () => {
    const notJson = scriptedFetch(() => new Response('<html>gateway</html>', { status: 200 }));
    await expect(runCustomChat(CFG, MESSAGES, { fetchImpl: notJson.fetchImpl })).rejects.toThrow(
      /could not be read/i,
    );

    const noChoices = scriptedFetch(
      () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await expect(runCustomChat(CFG, MESSAGES, { fetchImpl: noChoices.fetchImpl })).rejects.toThrow(
      /could not be read/i,
    );
  });
});

// ---------------------------------------------------------------------------
// runCustomReceipt — prompt reuse, salvage, and the normalize handoff
// ---------------------------------------------------------------------------

describe('runCustomReceipt', () => {
  const IMAGE = 'data:image/jpeg;base64,QUJD';

  it('sends the receipt system prompt with the categories and the image as a data URI', async () => {
    const { fetchImpl, calls } = scriptedFetch(() => completionResponse('{}'));
    await runCustomReceipt(CFG, IMAGE, CATEGORIES, { fetchImpl });

    const body = JSON.parse(String(calls[0].init?.body)) as {
      messages: { role: string; content: unknown }[];
    };
    expect(body.messages[0].role).toBe('system');
    expect(String(body.messages[0].content)).toContain('Groceries, Dining, Needs review');
    expect(body.messages[1].content).toEqual([
      { type: 'image_url', image_url: { url: IMAGE } },
      { type: 'text', text: expect.stringContaining('Extract the transaction details') as string },
    ]);
  });

  it('a fenced answer is salvaged by parseModelJson and flows through normalizeExtraction', async () => {
    // No response_format means the model may fence its JSON — exactly the
    // case the salvage path exists for.
    const answer = [
      'Here is the extraction:',
      '```json',
      JSON.stringify({
        merchant: { value: 'Blue Bottle', confidence: 0.95 },
        date: { value: '2026-08-01', confidence: 0.9 },
        total: { value: 12.5, confidence: 0.9 },
        type: { value: 'expense', confidence: 0.9 },
        category: { value: 'dining', confidence: 0.8 },
      }),
      '```',
    ].join('\n');
    const { fetchImpl } = scriptedFetch(() => completionResponse(answer));

    const raw = await runCustomReceipt(CFG, IMAGE, CATEGORIES, { fetchImpl });
    const fields = normalizeExtraction(raw, CATEGORIES);
    expect(fields.merchant).toEqual({ value: 'Blue Bottle', confidence: 0.95 });
    // Casing comes back as the USER manages it, not as the model wrote it.
    expect(fields.category).toEqual({ value: 'Dining', confidence: 0.8 });
  });

  it('an answer with no JSON at all is a readable failure, never an empty success', async () => {
    const { fetchImpl } = scriptedFetch(() => completionResponse('I cannot read this image.'));
    await expect(runCustomReceipt(CFG, IMAGE, CATEGORIES, { fetchImpl })).rejects.toThrow(
      /could not be read/i,
    );
  });
});
