// Read-only MCP server (sprint 9): the JSON-RPC/MCP protocol layer, the tool
// registry's read-only pin, every argument-validation branch, the LIKE-escape
// guarantee, summary math vs hand-built fixtures, and the Budgets-page mirror.
// Handlers run against an in-memory D1 fake (same idiom as briefing.test.ts).
import { describe, expect, it } from 'vitest';
import { isoDayOffset } from '../shared/forecast';
import type { Budget, Transaction, TxType } from '../shared/types';
import { todayIsoUtc } from '../worker/briefings';
import {
  handleMcpMessage,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_INFO,
  parseJsonRpcMessage,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_PARSE_ERROR,
  rpcResult,
  ToolError,
  type JsonRpcResponse,
  type McpToolHandle,
  type ParsedMessage,
} from '../worker/mcp/protocol';
import {
  bindMcpTools,
  buildSearchWhere,
  computeBudgetRows,
  computeSummary,
  escapeLike,
  MCP_TOOLS,
  parseForecastArgs,
  parseRecurringArgs,
  parseSearchArgs,
  parseSummaryArgs,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
} from '../worker/mcp/tools';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let txSeq = 0;

function tx(overrides: Partial<Transaction> = {}): Transaction {
  txSeq++;
  return {
    id: `tx-${txSeq}`,
    date: '2026-08-01',
    merchant: 'Corner Store',
    category: 'Groceries',
    amount: 10,
    type: 'expense',
    account: 'Main Checking',
    tags: [],
    receipt: false,
    source: 'manual',
    fingerprint: `fp-${txSeq}`,
    createdAt: `2026-08-01T00:00:${String(txSeq % 60).padStart(2, '0')}Z`,
    ...overrides,
  };
}

function budget(category: string, limit: number, active = true): Budget {
  return { id: `b-${category}`, category, limit, active };
}

function request(method: string, params?: Record<string, unknown>): ParsedMessage {
  return { kind: 'request', id: 1, method, params };
}

function errorOf(response: JsonRpcResponse | null): { code: number; message: string } {
  expect(response?.error).toBeDefined();
  return response!.error!;
}

/** A tool result's parsed content — asserts the MCP text-content wrapping. */
function contentOf(response: JsonRpcResponse | null): { text: string; isError: boolean } {
  const result = response?.result as
    | { content: { type: string; text: string }[]; isError?: boolean }
    | undefined;
  expect(result).toBeDefined();
  expect(result!.content).toHaveLength(1);
  expect(result!.content[0].type).toBe('text');
  return { text: result!.content[0].text, isError: result!.isError === true };
}

function stubTool(overrides: Partial<McpToolHandle> = {}): McpToolHandle {
  return {
    name: 'stub',
    description: 'a stub',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    invoke: async () => ({ ok: true }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-memory D1 fake (same idiom as briefing.test.ts): serves the transaction
// and settings reads the tools make, records every executed statement so SQL
// and binds can be asserted, and answers COUNT queries with a canned total.
// ---------------------------------------------------------------------------

interface ExecutedStatement {
  sql: string;
  binds: unknown[];
}

function toTxRow(t: Transaction): Record<string, unknown> {
  return { ...t, tags: JSON.stringify(t.tags), receipt: t.receipt ? 1 : 0 };
}

function fakeDb(
  opts: {
    transactions?: Transaction[];
    settings?: Record<string, unknown>;
    matchedCount?: number;
  } = {},
) {
  const executed: ExecutedStatement[] = [];
  const txRows = (opts.transactions ?? []).map(toTxRow);
  const settingsRows = Object.entries(opts.settings ?? {}).map(([key, value]) => ({
    key,
    value: JSON.stringify(value),
  }));

  function statement(sql: string, binds: unknown[] = []) {
    return {
      sql,
      binds,
      bind: (...values: unknown[]) => statement(sql, values),
      all: async <T,>() => {
        executed.push({ sql, binds });
        if (/FROM transactions/i.test(sql)) return { results: txRows as T[] };
        if (/FROM settings/i.test(sql)) return { results: settingsRows as T[] };
        return { results: [] as T[] }; // rules / corrections / dismissals
      },
      first: async <T,>() => {
        executed.push({ sql, binds });
        if (/COUNT\(\*\) AS n FROM transactions/i.test(sql)) {
          return { n: opts.matchedCount ?? txRows.length } as T;
        }
        if (/COUNT\(\*\) AS n/i.test(sql)) return { n: 0 } as T;
        return null as T | null;
      },
      run: async () => {
        throw new Error('read-only violation: a write reached the fake DB');
      },
    };
  }

  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async () => {
      throw new Error('read-only violation: a batch write reached the fake DB');
    },
  } as unknown as D1Database;

  return { env: { DB: db } as Env, executed };
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  env: Env,
): Promise<JsonRpcResponse | null> {
  return handleMcpMessage(request('tools/call', { name, arguments: args }), bindMcpTools(env));
}

// ---------------------------------------------------------------------------
// parseJsonRpcMessage
// ---------------------------------------------------------------------------

describe('parseJsonRpcMessage', () => {
  function invalidCode(raw: string): number {
    const parsed = parseJsonRpcMessage(raw);
    expect(parsed.kind).toBe('invalid');
    return parsed.kind === 'invalid' ? parsed.response.error!.code : NaN;
  }

  it('malformed JSON is -32700 with a null id', () => {
    const parsed = parseJsonRpcMessage('{"jsonrpc": nope');
    expect(parsed.kind).toBe('invalid');
    if (parsed.kind === 'invalid') {
      expect(parsed.response).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: { code: RPC_PARSE_ERROR, message: 'The request body is not valid JSON.' },
      });
    }
  });

  it('batch arrays are rejected with -32600 (single-message v1, pinned)', () => {
    const one = { jsonrpc: '2.0', id: 1, method: 'ping' };
    expect(invalidCode(JSON.stringify([one]))).toBe(RPC_INVALID_REQUEST);
    expect(invalidCode('[]')).toBe(RPC_INVALID_REQUEST);
  });

  for (const [label, raw] of [
    ['a bare string', '"ping"'],
    ['a number', '7'],
    ['null', 'null'],
  ] as const) {
    it(`${label} is -32600`, () => {
      expect(invalidCode(raw)).toBe(RPC_INVALID_REQUEST);
    });
  }

  it('wrong or missing jsonrpc version is -32600', () => {
    expect(invalidCode(JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'ping' }))).toBe(
      RPC_INVALID_REQUEST,
    );
    expect(invalidCode(JSON.stringify({ id: 1, method: 'ping' }))).toBe(RPC_INVALID_REQUEST);
  });

  it('missing, empty or non-string method is -32600', () => {
    expect(invalidCode(JSON.stringify({ jsonrpc: '2.0', id: 1 }))).toBe(RPC_INVALID_REQUEST);
    expect(invalidCode(JSON.stringify({ jsonrpc: '2.0', id: 1, method: '' }))).toBe(
      RPC_INVALID_REQUEST,
    );
    expect(invalidCode(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 5 }))).toBe(
      RPC_INVALID_REQUEST,
    );
  });

  it('non-object params are -32600', () => {
    expect(
      invalidCode(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: [1] })),
    ).toBe(RPC_INVALID_REQUEST);
  });

  it('a null or boolean id is -32600 (MCP requires string/number ids)', () => {
    expect(invalidCode(JSON.stringify({ jsonrpc: '2.0', id: null, method: 'ping' }))).toBe(
      RPC_INVALID_REQUEST,
    );
    expect(invalidCode(JSON.stringify({ jsonrpc: '2.0', id: true, method: 'ping' }))).toBe(
      RPC_INVALID_REQUEST,
    );
  });

  it('a message without an id is a notification', () => {
    const parsed = parseJsonRpcMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    );
    expect(parsed).toEqual({ kind: 'notification', method: 'notifications/initialized' });
  });

  it('id 0 is a request, not a notification (falsy-id trap)', () => {
    const parsed = parseJsonRpcMessage(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }));
    expect(parsed.kind).toBe('request');
    if (parsed.kind === 'request') expect(parsed.id).toBe(0);
  });

  it('a well-formed request parses with its params', () => {
    const parsed = parseJsonRpcMessage(
      JSON.stringify({ jsonrpc: '2.0', id: 'a1', method: 'tools/call', params: { name: 'x' } }),
    );
    expect(parsed).toEqual({
      kind: 'request',
      id: 'a1',
      method: 'tools/call',
      params: { name: 'x' },
    });
  });
});

// ---------------------------------------------------------------------------
// handleMcpMessage — the method router
// ---------------------------------------------------------------------------

describe('handleMcpMessage', () => {
  it('initialize returns the exact pinned envelope', async () => {
    const response = await handleMcpMessage(
      request('initialize', {
        protocolVersion: '2025-03-26', // client offers an older revision
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.0' },
      }),
      [],
    );
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'ledgerly', version: '0.1.0' },
      },
    });
    // The constants the envelope is built from stay pinned too.
    expect(MCP_PROTOCOL_VERSION).toBe('2025-06-18');
    expect(MCP_SERVER_INFO).toEqual({ name: 'ledgerly', version: '0.1.0' });
  });

  it('ping returns an empty result', async () => {
    expect(await handleMcpMessage(request('ping'), [])).toEqual(rpcResult(1, {}));
  });

  it('notifications produce no response (the 202 path)', async () => {
    expect(
      await handleMcpMessage({ kind: 'notification', method: 'notifications/initialized' }, []),
    ).toBeNull();
    // Even an unknown notifications/* method with an id is ignored, per spec.
    expect(await handleMcpMessage(request('notifications/whatever'), [])).toBeNull();
  });

  it('unknown methods are -32601', async () => {
    const err = errorOf(await handleMcpMessage(request('resources/list'), []));
    expect(err.code).toBe(RPC_METHOD_NOT_FOUND);
    expect(err.message).toContain('resources/list');
  });

  it('tools/list returns name, description and inputSchema per tool', async () => {
    const tool = stubTool();
    const response = await handleMcpMessage(request('tools/list'), [tool]);
    expect(response?.result).toEqual({
      tools: [{ name: 'stub', description: 'a stub', inputSchema: tool.inputSchema }],
    });
  });

  it('tools/call with an unknown tool is -32602', async () => {
    const err = errorOf(
      await handleMcpMessage(request('tools/call', { name: 'delete_everything' }), [stubTool()]),
    );
    expect(err.code).toBe(RPC_INVALID_PARAMS);
    expect(err.message).toContain('delete_everything');
  });

  it('tools/call without a name, or with non-object arguments, is -32602', async () => {
    expect(errorOf(await handleMcpMessage(request('tools/call', {}), [stubTool()])).code).toBe(
      RPC_INVALID_PARAMS,
    );
    expect(
      errorOf(
        await handleMcpMessage(request('tools/call', { name: 'stub', arguments: [1] }), [
          stubTool(),
        ]),
      ).code,
    ).toBe(RPC_INVALID_PARAMS);
  });

  it('a tool result is wrapped as pretty-printed JSON text content', async () => {
    const response = await handleMcpMessage(
      request('tools/call', { name: 'stub', arguments: {} }),
      [stubTool({ invoke: async () => ({ answer: 42 }) })],
    );
    const { text, isError } = contentOf(response);
    expect(isError).toBe(false);
    expect(JSON.parse(text)).toEqual({ answer: 42 });
    expect(text).toContain('\n'); // JSON.stringify(_, null, 2)
  });

  it('a ToolError becomes an isError result, not a JSON-RPC error (MCP semantics)', async () => {
    const response = await handleMcpMessage(
      request('tools/call', { name: 'stub', arguments: {} }),
      [
        stubTool({
          invoke: async () => {
            throw new ToolError('limit must be an integer between 1 and 200.');
          },
        }),
      ],
    );
    expect(response?.error).toBeUndefined();
    const { text, isError } = contentOf(response);
    expect(isError).toBe(true);
    expect(text).toBe('limit must be an integer between 1 and 200.');
  });

  it('an unexpected throw becomes a generic isError result that leaks nothing', async () => {
    const response = await handleMcpMessage(
      request('tools/call', { name: 'stub', arguments: {} }),
      [
        stubTool({
          invoke: async () => {
            throw new Error('D1_ERROR: no such table: transactions');
          },
        }),
      ],
    );
    const { text, isError } = contentOf(response);
    expect(isError).toBe(true);
    expect(text).toBe('The tool failed unexpectedly. Try again.');
  });
});

// ---------------------------------------------------------------------------
// The registry: the read-only invariant
// ---------------------------------------------------------------------------

describe('registry read-only pin', () => {
  it('exposes EXACTLY the six read-only tools — a 7th or a mutating name fails here', () => {
    expect(MCP_TOOLS.map((t) => t.name).sort()).toEqual([
      'get_briefing',
      'get_budgets',
      'get_forecast',
      'get_recurring',
      'get_summary',
      'search_transactions',
    ]);
  });

  it('every tool has a description and a closed object schema', () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('no tool requires any argument (every tool works with {})', () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.inputSchema.required ?? []).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// search_transactions — argument validation
// ---------------------------------------------------------------------------

describe('parseSearchArgs', () => {
  it('defaults: no filters, limit 50', () => {
    expect(parseSearchArgs({})).toEqual({
      query: null,
      dateFrom: null,
      dateTo: null,
      type: null,
      category: null,
      account: null,
      minAmount: null,
      maxAmount: null,
      limit: SEARCH_DEFAULT_LIMIT,
    });
  });

  it('rejects unknown arguments loudly (a typo must not become "no filter")', () => {
    expect(() => parseSearchArgs({ merchant: 'Netflix' })).toThrowError(ToolError);
    expect(() => parseSearchArgs({ merchant: 'Netflix' })).toThrowError(/merchant/);
  });

  for (const bad of [7, true, ['a'], '', '   ']) {
    it(`rejects query ${JSON.stringify(bad)}`, () => {
      expect(() => parseSearchArgs({ query: bad })).toThrowError(ToolError);
    });
  }

  for (const bad of ['2026-13-01', '2026-02-30', '26-1-1', '2026/08/01', 'yesterday']) {
    it(`rejects dateFrom ${JSON.stringify(bad)} (real calendar dates only)`, () => {
      expect(() => parseSearchArgs({ dateFrom: bad })).toThrowError(ToolError);
    });
  }

  it('rejects an inverted date range', () => {
    expect(() => parseSearchArgs({ dateFrom: '2026-08-02', dateTo: '2026-08-01' })).toThrowError(
      /dateFrom/,
    );
  });

  it('rejects a type outside expense/income', () => {
    expect(() => parseSearchArgs({ type: 'transfer' })).toThrowError(ToolError);
    expect(() => parseSearchArgs({ type: 'Expense' })).toThrowError(ToolError);
  });

  for (const bad of [0, -5, '10', Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`rejects minAmount ${String(bad)} (positive numbers only)`, () => {
      expect(() => parseSearchArgs({ minAmount: bad })).toThrowError(ToolError);
    });
  }

  it('rejects minAmount above maxAmount', () => {
    expect(() => parseSearchArgs({ minAmount: 50, maxAmount: 10 })).toThrowError(/minAmount/);
  });

  for (const bad of [0, 201, 1.5, '50', -1]) {
    it(`rejects limit ${JSON.stringify(bad)}`, () => {
      expect(() => parseSearchArgs({ limit: bad })).toThrowError(ToolError);
    });
  }

  it('accepts the limit bounds 1 and 200', () => {
    expect(parseSearchArgs({ limit: 1 }).limit).toBe(1);
    expect(parseSearchArgs({ limit: SEARCH_MAX_LIMIT }).limit).toBe(SEARCH_MAX_LIMIT);
  });

  it('trims string filters', () => {
    const parsed = parseSearchArgs({ query: ' coffee ', category: ' Dining ', account: ' Cash ' });
    expect(parsed.query).toBe('coffee');
    expect(parsed.category).toBe('Dining');
    expect(parsed.account).toBe('Cash');
  });
});

describe('escapeLike + buildSearchWhere', () => {
  it('escapes %, _ and \\ so user text is never a wildcard (pinned)', () => {
    expect(escapeLike('100%')).toBe('100\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
    expect(escapeLike('back\\slash')).toBe('back\\\\slash');
    expect(escapeLike('50%_off\\now')).toBe('50\\%\\_off\\\\now');
  });

  it('a query containing % binds an escaped pattern with an ESCAPE clause', () => {
    const { where, binds } = buildSearchWhere(parseSearchArgs({ query: '100%' }));
    expect(where).toContain("ESCAPE '\\'");
    expect(binds).toEqual(['%100\\%%', '%100\\%%', '%100\\%%']);
  });

  it('no filters means no WHERE clause and no binds', () => {
    expect(buildSearchWhere(parseSearchArgs({}))).toEqual({ where: '', binds: [] });
  });

  it('every filter contributes a parameterized clause in order', () => {
    const { where, binds } = buildSearchWhere(
      parseSearchArgs({
        query: 'store',
        dateFrom: '2026-01-01',
        dateTo: '2026-12-31',
        type: 'expense',
        category: 'Groceries',
        account: 'Main Checking',
        minAmount: 5,
        maxAmount: 100,
      }),
    );
    expect(where).toBe(
      " WHERE (merchant LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\' OR account LIKE ? ESCAPE '\\')" +
        ' AND date >= ? AND date <= ? AND type = ? AND category = ? COLLATE NOCASE' +
        ' AND account = ? COLLATE NOCASE AND amount >= ? AND amount <= ?',
    );
    expect(binds).toEqual([
      '%store%',
      '%store%',
      '%store%',
      '2026-01-01',
      '2026-12-31',
      'expense',
      'Groceries',
      'Main Checking',
      5,
      100,
    ]);
  });
});

describe('search_transactions handler', () => {
  it('projects only public fields — never the fingerprint or object internals', async () => {
    const { env } = fakeDb({ transactions: [tx({ tags: ['work'] })] });
    const { text, isError } = contentOf(await callTool('search_transactions', {}, env));
    expect(isError).toBe(false);
    const result = JSON.parse(text) as { transactions: Record<string, unknown>[] };
    expect(result.transactions).toHaveLength(1);
    expect(Object.keys(result.transactions[0]).sort()).toEqual([
      'account',
      'amount',
      'category',
      'date',
      'id',
      'merchant',
      'tags',
      'type',
    ]);
    expect(result.transactions[0].tags).toEqual(['work']);
    expect(text).not.toContain('fingerprint');
  });

  it('reports matched vs returned honestly and flags the cap', async () => {
    const { env } = fakeDb({ transactions: [tx(), tx()], matchedCount: 7 });
    const result = JSON.parse(
      contentOf(await callTool('search_transactions', { limit: 2 }, env)).text,
    ) as Record<string, unknown>;
    expect(result.matched).toBe(7);
    expect(result.returned).toBe(2);
    expect(result.capped).toBe(true);
  });

  it('runs a parameterized page query + COUNT over the same WHERE, LIMIT bound last', async () => {
    const { env, executed } = fakeDb({ transactions: [tx()] });
    await callTool('search_transactions', { query: '50%', limit: 5 }, env);
    const page = executed.find((s) => /ORDER BY date DESC, createdAt DESC LIMIT \?/.test(s.sql));
    const count = executed.find((s) => /COUNT\(\*\) AS n FROM transactions/.test(s.sql));
    expect(page).toBeDefined();
    expect(count).toBeDefined();
    expect(page!.sql).toContain("ESCAPE '\\'");
    expect(page!.binds).toEqual(['%50\\%%', '%50\\%%', '%50\\%%', 5]);
    expect(count!.binds).toEqual(['%50\\%%', '%50\\%%', '%50\\%%']);
  });

  it('bad arguments surface as a readable isError result through tools/call', async () => {
    const { env, executed } = fakeDb();
    const { text, isError } = contentOf(
      await callTool('search_transactions', { limit: 999 }, env),
    );
    expect(isError).toBe(true);
    expect(text).toContain('limit');
    expect(executed).toHaveLength(0); // validation happens before any query
  });
});

// ---------------------------------------------------------------------------
// get_summary
// ---------------------------------------------------------------------------

describe('parseSummaryArgs', () => {
  const TODAY = '2026-08-12';

  it('refuses period combined with an explicit range', () => {
    expect(() => parseSummaryArgs({ period: 'this-month', dateFrom: '2026-01-01' }, TODAY)).toThrowError(
      /not both/,
    );
    expect(() => parseSummaryArgs({ period: 'all-time', dateTo: '2026-01-01' }, TODAY)).toThrowError(
      ToolError,
    );
  });

  for (const bad of ['This-Month', 'month', '', 7]) {
    it(`rejects period ${JSON.stringify(bad)}`, () => {
      expect(() => parseSummaryArgs({ period: bad }, TODAY)).toThrowError(ToolError);
    });
  }

  it('derives each named period window exactly like the Dashboard (periodRange)', () => {
    expect(parseSummaryArgs({ period: 'all-time' }, TODAY)).toEqual({ dateFrom: null, dateTo: null });
    expect(parseSummaryArgs({ period: 'this-month' }, TODAY)).toEqual({
      dateFrom: '2026-08-01',
      dateTo: null,
    });
    expect(parseSummaryArgs({ period: 'last-month' }, TODAY)).toEqual({
      dateFrom: '2026-07-01',
      dateTo: '2026-07-31',
    });
    expect(parseSummaryArgs({ period: 'last-3-months' }, TODAY)).toEqual({
      dateFrom: '2026-05-12',
      dateTo: null,
    });
    expect(parseSummaryArgs({ period: 'last-6-months' }, TODAY)).toEqual({
      dateFrom: '2026-02-12',
      dateTo: null,
    });
    expect(parseSummaryArgs({ period: 'this-year' }, TODAY)).toEqual({
      dateFrom: '2026-01-01',
      dateTo: null,
    });
  });

  it('passes explicit validated dates through, allowing open ends', () => {
    expect(parseSummaryArgs({ dateFrom: '2026-01-01', dateTo: '2026-06-30' }, TODAY)).toEqual({
      dateFrom: '2026-01-01',
      dateTo: '2026-06-30',
    });
    expect(parseSummaryArgs({ dateFrom: '2026-01-01' }, TODAY)).toEqual({
      dateFrom: '2026-01-01',
      dateTo: null,
    });
  });

  it('no arguments at all means all-time', () => {
    expect(parseSummaryArgs({}, TODAY)).toEqual({ dateFrom: null, dateTo: null });
  });

  it('rejects an inverted explicit range and unreal dates', () => {
    expect(() => parseSummaryArgs({ dateFrom: '2026-02-02', dateTo: '2026-02-01' }, TODAY)).toThrowError(
      ToolError,
    );
    expect(() => parseSummaryArgs({ dateFrom: '2026-02-30' }, TODAY)).toThrowError(ToolError);
  });
});

describe('computeSummary', () => {
  const LEDGER = [
    tx({ date: '2026-08-01', type: 'income', amount: 3000, category: 'Income' }),
    tx({ date: '2026-08-02', amount: 120.5, category: 'Groceries' }),
    tx({ date: '2026-08-03', amount: 80.25, category: 'Dining' }),
    tx({ date: '2026-08-04', amount: 40, category: 'Groceries' }),
    tx({ date: '2026-07-31', amount: 999, category: 'Housing' }), // outside from 08-01
    tx({ date: '2026-09-01', amount: 999, category: 'Housing' }), // outside to 08-31
  ];

  it('matches a hand-built fixture, window bounds inclusive', () => {
    expect(computeSummary(LEDGER, { dateFrom: '2026-08-01', dateTo: '2026-08-31' })).toEqual({
      income: 3000,
      spending: 240.75,
      net: 2759.25,
      txCount: 4,
      topCategories: [
        { category: 'Groceries', amount: 160.5 },
        { category: 'Dining', amount: 80.25 },
      ],
    });
  });

  it('null bounds mean all-time', () => {
    const all = computeSummary(LEDGER, { dateFrom: null, dateTo: null });
    expect(all.txCount).toBe(6);
    expect(all.spending).toBe(2238.75);
    expect(all.net).toBe(round2Check(3000 - 2238.75));
  });

  it('caps topCategories at 5, amount desc with alphabetical ties', () => {
    const many = ['A', 'B', 'C', 'D', 'E', 'F'].map((c, i) =>
      tx({ date: '2026-08-01', category: c, amount: 10 * (6 - i) }),
    );
    many.push(tx({ date: '2026-08-01', category: 'Zed', amount: 60 })); // ties with A at 60
    const { topCategories } = computeSummary(many, { dateFrom: null, dateTo: null });
    expect(topCategories).toHaveLength(5);
    expect(topCategories.map((c) => c.category)).toEqual(['A', 'Zed', 'B', 'C', 'D']);
  });

  it('an empty window is honest zeros with no categories', () => {
    expect(computeSummary(LEDGER, { dateFrom: '2030-01-01', dateTo: null })).toEqual({
      income: 0,
      spending: 0,
      net: 0,
      txCount: 0,
      topCategories: [],
    });
  });

  function round2Check(n: number): number {
    return Math.round(n * 100) / 100;
  }
});

describe('get_summary handler', () => {
  it('reports the resolved window and the display currency', async () => {
    const { env } = fakeDb({
      transactions: [tx({ date: '2026-08-01', amount: 25 })],
      settings: { currency: 'EUR' },
    });
    const result = JSON.parse(
      contentOf(await callTool('get_summary', {}, env)).text,
    ) as Record<string, unknown>;
    expect(result.dateFrom).toBeNull();
    expect(result.dateTo).toBeNull();
    expect(result.spending).toBe(25);
    expect(result.currency).toBe('EUR');
  });
});

// ---------------------------------------------------------------------------
// get_recurring + get_forecast (thin composition over the tested engines —
// fixtures are date-relative so the real UTC clock never breaks them)
// ---------------------------------------------------------------------------

const TODAY = todayIsoUtc();

/** A clean no-hint monthly expense pattern: 3 stable occurrences ending today. */
function monthlyExpenseFixture(): Transaction[] {
  return [-60, -30, 0].map((offset) =>
    tx({
      date: isoDayOffset(TODAY, offset),
      merchant: 'Blue Widget Club',
      category: 'Shopping',
      amount: 49.99,
    }),
  );
}

/** A clean no-hint monthly income pattern (payroll). */
function monthlyIncomeFixture(): Transaction[] {
  return [-60, -30, 0].map((offset) =>
    tx({
      date: isoDayOffset(TODAY, offset),
      merchant: 'Acme Payroll',
      category: 'Income',
      amount: 3000,
      type: 'income',
    }),
  );
}

describe('parseRecurringArgs', () => {
  it('accepts no filter and both directions', () => {
    expect(parseRecurringArgs({})).toBeNull();
    expect(parseRecurringArgs({ type: 'expense' })).toBe('expense');
    expect(parseRecurringArgs({ type: 'income' })).toBe('income');
  });

  it('rejects other values and unknown keys', () => {
    expect(() => parseRecurringArgs({ type: 'both' })).toThrowError(ToolError);
    expect(() => parseRecurringArgs({ cadence: 'monthly' })).toThrowError(/cadence/);
  });
});

describe('get_recurring handler', () => {
  it('detects both directions and shapes the pattern rows', async () => {
    const { env } = fakeDb({
      transactions: [...monthlyExpenseFixture(), ...monthlyIncomeFixture()],
    });
    const result = JSON.parse(contentOf(await callTool('get_recurring', {}, env)).text) as {
      patterns: Record<string, unknown>[];
    };
    expect(result.patterns).toHaveLength(2);
    const merchants = result.patterns.map((p) => p.merchant).sort();
    expect(merchants).toEqual(['Acme Payroll', 'Blue Widget Club']);
    const expense = result.patterns.find((p) => p.merchant === 'Blue Widget Club')!;
    expect(Object.keys(expense).sort()).toEqual([
      'averageAmount',
      'cadence',
      'category',
      'confidence',
      'kind',
      'lastDate',
      'merchant',
      'monthlyEquivalent',
      'nextDate',
      'type',
    ]);
    expect(expense.type).toBe('expense');
    expect(expense.cadence).toBe('monthly');
    expect(expense.averageAmount).toBe(49.99);
    const income = result.patterns.find((p) => p.merchant === 'Acme Payroll')!;
    expect(income.type).toBe('income');
  });

  it('excludes dismissed patterns (the user said "not recurring")', async () => {
    const { env } = fakeDb({
      transactions: monthlyExpenseFixture(),
      settings: { dismissedPatterns: ['blue widget club|monthly'] },
    });
    const result = JSON.parse(contentOf(await callTool('get_recurring', {}, env)).text) as {
      patterns: unknown[];
    };
    expect(result.patterns).toEqual([]);
  });

  it('the type filter narrows to one direction', async () => {
    const { env } = fakeDb({
      transactions: [...monthlyExpenseFixture(), ...monthlyIncomeFixture()],
    });
    const result = JSON.parse(
      contentOf(await callTool('get_recurring', { type: 'income' }, env)).text,
    ) as { patterns: { merchant: string }[] };
    expect(result.patterns.map((p) => p.merchant)).toEqual(['Acme Payroll']);
  });
});

describe('parseForecastArgs', () => {
  it('defaults to 30 and accepts exactly the supported horizons', () => {
    expect(parseForecastArgs({})).toBe(30);
    expect(parseForecastArgs({ horizonDays: 60 })).toBe(60);
    expect(parseForecastArgs({ horizonDays: 90 })).toBe(90);
  });

  for (const bad of [45, '30', 0, true]) {
    it(`rejects horizonDays ${JSON.stringify(bad)}`, () => {
      expect(() => parseForecastArgs({ horizonDays: bad })).toThrowError(ToolError);
    });
  }
});

describe('get_forecast handler', () => {
  it('projects the detected pattern and adds only the currency', async () => {
    const { env } = fakeDb({
      transactions: monthlyExpenseFixture(),
      settings: { currency: 'USD' },
    });
    const result = JSON.parse(
      contentOf(await callTool('get_forecast', { horizonDays: 90 }, env)).text,
    ) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual([
      'currency',
      'end',
      'expenseSeries',
      'horizonDays',
      'incomeSeries',
      'net',
      'occurrences',
      'points',
      'start',
      'totalIn',
      'totalOut',
    ]);
    expect(result.horizonDays).toBe(90);
    expect(result.currency).toBe('USD');
    expect((result.occurrences as unknown[]).length).toBeGreaterThanOrEqual(2);
    expect(result.totalOut).toBeGreaterThan(0);
    expect(result.expenseSeries).toBe(1);
  });

  it('a dismissed pattern contributes nothing', async () => {
    const { env } = fakeDb({
      transactions: monthlyExpenseFixture(),
      settings: { dismissedPatterns: ['blue widget club|monthly'] },
    });
    const result = JSON.parse(
      contentOf(await callTool('get_forecast', {}, env)).text,
    ) as Record<string, unknown>;
    expect(result.occurrences).toEqual([]);
    expect(result.points).toEqual([]); // honest empty, never zeros dressed as data
  });
});

// ---------------------------------------------------------------------------
// get_budgets — the Budgets-page mirror
// ---------------------------------------------------------------------------

describe('computeBudgetRows', () => {
  const MONTH = '2026-08';

  it('mirrors the page: month bounds inclusive, case/trim-insensitive category match', () => {
    const rows = computeBudgetRows(
      [budget('Groceries', 200)],
      [
        tx({ date: '2026-07-31', category: 'Groceries', amount: 999 }), // out (before)
        tx({ date: '2026-08-01', category: 'groceries ', amount: 50.25 }), // in, case+trim
        tx({ date: '2026-08-31', category: 'GROCERIES', amount: 25 }), // in, last day
        tx({ date: '2026-09-01', category: 'Groceries', amount: 999 }), // out (after)
        tx({ date: '2026-08-15', category: 'Dining', amount: 40 }), // other category
        tx({ date: '2026-08-15', category: 'Groceries', amount: 500, type: 'income' }), // income never counts
      ],
      MONTH,
    );
    expect(rows).toEqual([
      { category: 'Groceries', limit: 200, spent: 75.25, remaining: 124.75, over: false },
    ]);
  });

  it('excludes inactive budgets, exactly like the page', () => {
    const rows = computeBudgetRows(
      [budget('Groceries', 200), budget('Dining', 100, false)],
      [tx({ date: '2026-08-02', category: 'Dining', amount: 10 })],
      MONTH,
    );
    expect(rows.map((r) => r.category)).toEqual(['Groceries']);
  });

  it('over mirrors the page danger tone: spent above the limit, negative remaining kept honest', () => {
    const rows = computeBudgetRows(
      [budget('Dining', 100)],
      [tx({ date: '2026-08-02', category: 'Dining', amount: 150.5 })],
      MONTH,
    );
    expect(rows[0]).toEqual({
      category: 'Dining',
      limit: 100,
      spent: 150.5,
      remaining: -50.5,
      over: true,
    });
  });

  it('spending exactly at the limit is not over (pct 100 is caution, not danger)', () => {
    const rows = computeBudgetRows(
      [budget('Dining', 100)],
      [tx({ date: '2026-08-02', category: 'Dining', amount: 100 })],
      MONTH,
    );
    expect(rows[0].over).toBe(false);
  });

  it('a zero-limit budget is over as soon as anything is spent (page tone semantics)', () => {
    const spentRows = computeBudgetRows(
      [budget('Dining', 0)],
      [tx({ date: '2026-08-02', category: 'Dining', amount: 1 })],
      MONTH,
    );
    expect(spentRows[0].over).toBe(true);
    const cleanRows = computeBudgetRows([budget('Dining', 0)], [], MONTH);
    expect(cleanRows[0]).toEqual({ category: 'Dining', limit: 0, spent: 0, remaining: 0, over: false });
  });

  it('computes the month end correctly for short months', () => {
    const rows = computeBudgetRows(
      [budget('Housing', 2000)],
      [
        tx({ date: '2026-02-28', category: 'Housing', amount: 1500 }), // in (2026 not a leap year)
        tx({ date: '2026-03-01', category: 'Housing', amount: 999 }), // out
      ],
      '2026-02',
    );
    expect(rows[0].spent).toBe(1500);
  });
});

describe('get_budgets + get_briefing handlers', () => {
  it('get_budgets takes no arguments and reports the current UTC month', async () => {
    const { env } = fakeDb({
      transactions: [tx({ date: TODAY, category: 'Groceries', amount: 30 })],
      settings: { budgets: [budget('Groceries', 200)] },
    });
    const rejected = contentOf(await callTool('get_budgets', { month: '2026-01' }, env));
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toContain('no arguments');

    const result = JSON.parse(contentOf(await callTool('get_budgets', {}, env)).text) as {
      month: string;
      budgets: { spent: number }[];
    };
    expect(result.month).toBe(TODAY.slice(0, 7));
    expect(result.budgets[0].spent).toBe(30);
  });

  it('get_briefing returns EXACTLY briefing + text — never Settings', async () => {
    const { env } = fakeDb({
      transactions: [tx({ date: TODAY, amount: 12.5 })],
      settings: { currency: 'USD', emailAllowedSenders: ['alerts@chase.com'] },
    });
    const { text, isError } = contentOf(await callTool('get_briefing', {}, env));
    expect(isError).toBe(false);
    const result = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(['briefing', 'text']);
    expect(typeof result.text).toBe('string');
    // The settings object (allowlists included) must never ride along.
    expect(text).not.toContain('emailAllowedSenders');
    expect(text).not.toContain('alerts@chase.com');
  });
});

// ---------------------------------------------------------------------------
// End-to-end read-only sweep: every tool runs against the fake DB, and the
// fake throws on ANY write (run/batch) — so a mutating tool cannot hide.
// ---------------------------------------------------------------------------

describe('read-only sweep', () => {
  it('calling all six tools issues zero writes', async () => {
    const { env } = fakeDb({
      transactions: [...monthlyExpenseFixture(), ...monthlyIncomeFixture()],
      settings: { budgets: [budget('Shopping', 100)] },
    });
    for (const tool of MCP_TOOLS) {
      const response = await callTool(tool.name, {}, env);
      expect(contentOf(response).isError).toBe(false);
    }
  });
});

// Keep the fixture types honest at compile time.
const _fixtureTypeCheck: TxType[] = ['expense', 'income'];
void _fixtureTypeCheck;
