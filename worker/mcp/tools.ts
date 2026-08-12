// The read-only MCP tool registry (sprint 9, VISION.md phase-2 item 5).
//
// READ-ONLY IS STRUCTURAL: no tool here mutates anything — there is no
// INSERT/UPDATE/DELETE in this file, and tests pin the registry to exactly
// these six names so a mutating tool cannot appear quietly. No tool exposes
// Settings beyond what its result inherently needs (the display currency
// code); the sender allowlists, AI config, WhatsApp config and every
// *Set/secret-adjacent field never leave the worker through MCP.
//
// Every argument is validated server-side regardless of the inputSchema —
// the schema documents the contract to clients, the parse functions enforce
// it (same boundary discipline as validateTxInput). Readable messages
// surface as isError tool results (see protocol.ts ToolError).
import { detectPatterns } from '../../shared/detection';
import { periodRange } from '../../shared/format';
import { buildForecast, FORECAST_HORIZONS, type ForecastHorizon } from '../../shared/forecast';
import { PERIOD_OPTIONS, type Budget, type Transaction, type TxType } from '../../shared/types';
import { computeBriefing, todayIsoUtc } from '../briefings';
import { readTransactions, rowToTransaction, TX_COLUMNS, type TxRow } from '../queries';
import { readSettings } from '../settingsStore';
import { isIsoDate } from '../util';
import { ToolError, type McpInputSchema, type McpToolHandle } from './protocol';

function fail(message: string): never {
  throw new ToolError(message);
}

/** Round to cents (codebase money idiom) — applied at EACH accumulation. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Unknown keys are rejected loudly so a misspelled optional argument can
 * never silently become "no filter" — a search the caller believes is
 * narrowed must not quietly return everything.
 */
function rejectUnknownArgs(
  args: Record<string, unknown>,
  allowed: readonly string[],
  tool: string,
): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      fail(
        allowed.length > 0
          ? `Unknown argument "${key}" for ${tool}. Allowed: ${allowed.join(', ')}.`
          : `${tool} takes no arguments (got "${key}").`,
      );
    }
  }
}

function readOptionalString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fail(`${key} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed) fail(`${key} must not be empty.`);
  return trimmed;
}

function readOptionalDate(args: Record<string, unknown>, key: string): string | null {
  const value = readOptionalString(args, key);
  if (value === null) return null;
  if (!isIsoDate(value)) fail(`${key} must be a real calendar date in YYYY-MM-DD form.`);
  return value;
}

function readOptionalPositiveNumber(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail(`${key} must be a positive number.`);
  }
  return value;
}

function readOptionalTxType(args: Record<string, unknown>): TxType | null {
  const value = args.type;
  if (value === undefined || value === null) return null;
  if (value !== 'expense' && value !== 'income') fail('type must be "expense" or "income".');
  return value;
}

// ---------------------------------------------------------------------------
// search_transactions
// ---------------------------------------------------------------------------

export const SEARCH_DEFAULT_LIMIT = 50;
export const SEARCH_MAX_LIMIT = 200;

export interface SearchArgs {
  query: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  type: TxType | null;
  category: string | null;
  account: string | null;
  minAmount: number | null;
  maxAmount: number | null;
  limit: number;
}

export function parseSearchArgs(args: Record<string, unknown>): SearchArgs {
  rejectUnknownArgs(
    args,
    ['query', 'dateFrom', 'dateTo', 'type', 'category', 'account', 'minAmount', 'maxAmount', 'limit'],
    'search_transactions',
  );
  const dateFrom = readOptionalDate(args, 'dateFrom');
  const dateTo = readOptionalDate(args, 'dateTo');
  if (dateFrom !== null && dateTo !== null && dateFrom > dateTo) {
    fail('dateFrom must not be after dateTo.');
  }
  const minAmount = readOptionalPositiveNumber(args, 'minAmount');
  const maxAmount = readOptionalPositiveNumber(args, 'maxAmount');
  if (minAmount !== null && maxAmount !== null && minAmount > maxAmount) {
    fail('minAmount must not be greater than maxAmount.');
  }
  let limit = SEARCH_DEFAULT_LIMIT;
  if (args.limit !== undefined && args.limit !== null) {
    if (
      typeof args.limit !== 'number' ||
      !Number.isInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > SEARCH_MAX_LIMIT
    ) {
      fail(`limit must be an integer between 1 and ${SEARCH_MAX_LIMIT}.`);
    }
    limit = args.limit;
  }
  return {
    query: readOptionalString(args, 'query'),
    dateFrom,
    dateTo,
    type: readOptionalTxType(args),
    category: readOptionalString(args, 'category'),
    account: readOptionalString(args, 'account'),
    minAmount,
    maxAmount,
    limit,
  };
}

/**
 * Escape \, % and _ so user text can never act as a LIKE wildcard — the
 * pattern is bound with `ESCAPE '\'`. A search for "100%" must match the
 * literal string, not everything containing "100" (pinned in tests).
 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Parameterized WHERE clause + binds for both the page query and the total
 * COUNT. SQLite LIKE is case-insensitive over ASCII, which gives `query` its
 * documented case-insensitive substring semantics; category/account are
 * exact names compared COLLATE NOCASE.
 */
export function buildSearchWhere(q: SearchArgs): { where: string; binds: (string | number)[] } {
  const parts: string[] = [];
  const binds: (string | number)[] = [];
  if (q.query !== null) {
    const pattern = `%${escapeLike(q.query)}%`;
    parts.push(
      "(merchant LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\' OR account LIKE ? ESCAPE '\\')",
    );
    binds.push(pattern, pattern, pattern);
  }
  if (q.dateFrom !== null) {
    parts.push('date >= ?');
    binds.push(q.dateFrom);
  }
  if (q.dateTo !== null) {
    parts.push('date <= ?');
    binds.push(q.dateTo);
  }
  if (q.type !== null) {
    parts.push('type = ?');
    binds.push(q.type);
  }
  if (q.category !== null) {
    parts.push('category = ? COLLATE NOCASE');
    binds.push(q.category);
  }
  if (q.account !== null) {
    parts.push('account = ? COLLATE NOCASE');
    binds.push(q.account);
  }
  if (q.minAmount !== null) {
    parts.push('amount >= ?');
    binds.push(q.minAmount);
  }
  if (q.maxAmount !== null) {
    parts.push('amount <= ?');
    binds.push(q.maxAmount);
  }
  return { where: parts.length > 0 ? ` WHERE ${parts.join(' AND ')}` : '', binds };
}

async function searchTransactions(env: Env, args: Record<string, unknown>): Promise<unknown> {
  const q = parseSearchArgs(args);
  const { where, binds } = buildSearchWhere(q);
  const [page, count] = await Promise.all([
    env.DB.prepare(
      `SELECT ${TX_COLUMNS} FROM transactions${where} ORDER BY date DESC, createdAt DESC LIMIT ?`,
    )
      .bind(...binds, q.limit)
      .all<TxRow>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM transactions${where}`)
      .bind(...binds)
      .first<{ n: number }>(),
  ]);
  // Explicit projection: `id` is a harmless handle so a client can refer to
  // a row in conversation; the fingerprint and other internals never leave.
  const transactions = (page.results ?? []).map(rowToTransaction).map((t) => ({
    id: t.id,
    date: t.date,
    merchant: t.merchant,
    category: t.category,
    amount: t.amount,
    type: t.type,
    account: t.account,
    tags: t.tags,
  }));
  const matched = count?.n ?? transactions.length;
  return { transactions, matched, returned: transactions.length, capped: matched > transactions.length };
}

// ---------------------------------------------------------------------------
// get_summary
// ---------------------------------------------------------------------------

export const SUMMARY_TOP_CATEGORIES = 5;

export interface SummaryWindow {
  dateFrom: string | null;
  dateTo: string | null;
}

/**
 * Resolve the summary window. `period` reuses the app's own periodRange
 * (shared/format.ts — the Dashboard's window semantics, not a reinvention);
 * explicit dateFrom/dateTo are validated real dates; passing both forms is
 * refused. No arguments at all = all-time. `todayIso` is the worker's UTC
 * calendar day (sprint-7 convention) — periodRange reads local date fields,
 * so the day is rebuilt as a local-field Date to keep the math on that same
 * calendar day on any machine.
 */
export function parseSummaryArgs(args: Record<string, unknown>, todayIso: string): SummaryWindow {
  rejectUnknownArgs(args, ['period', 'dateFrom', 'dateTo'], 'get_summary');
  const rawPeriod = readOptionalString(args, 'period');
  const dateFrom = readOptionalDate(args, 'dateFrom');
  const dateTo = readOptionalDate(args, 'dateTo');
  if (rawPeriod !== null && (dateFrom !== null || dateTo !== null)) {
    fail('Pass either period or an explicit dateFrom/dateTo range — not both.');
  }
  if (rawPeriod !== null) {
    const period = PERIOD_OPTIONS.find((o) => o.value === rawPeriod)?.value;
    if (!period) fail(`period must be one of: ${PERIOD_OPTIONS.map((o) => o.value).join(', ')}.`);
    const [y, m, d] = todayIso.split('-').map(Number);
    const range = periodRange(period, new Date(y, m - 1, d));
    return { dateFrom: range.start, dateTo: range.end };
  }
  if (dateFrom !== null && dateTo !== null && dateFrom > dateTo) {
    fail('dateFrom must not be after dateTo.');
  }
  return { dateFrom, dateTo };
}

export interface SummaryStats {
  income: number;
  spending: number;
  net: number;
  txCount: number;
  topCategories: { category: string; amount: number }[];
}

/**
 * Pure summary math over the window (bounds inclusive; null = unbounded).
 * Same accumulation idiom as buildBriefing: round to cents at each step.
 * Top categories are expense totals, amount desc, ties alphabetical.
 */
export function computeSummary(
  transactions: readonly Transaction[],
  window: SummaryWindow,
): SummaryStats {
  let income = 0;
  let spending = 0;
  let txCount = 0;
  const byCategory = new Map<string, number>();
  for (const tx of transactions) {
    if (window.dateFrom !== null && tx.date < window.dateFrom) continue;
    if (window.dateTo !== null && tx.date > window.dateTo) continue;
    txCount++;
    if (tx.type === 'income') {
      income = round2(income + tx.amount);
    } else {
      spending = round2(spending + tx.amount);
      byCategory.set(tx.category, round2((byCategory.get(tx.category) ?? 0) + tx.amount));
    }
  }
  const topCategories = [...byCategory.entries()]
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) =>
      a.amount !== b.amount ? b.amount - a.amount : a.category < b.category ? -1 : 1,
    )
    .slice(0, SUMMARY_TOP_CATEGORIES);
  return { income, spending, net: round2(income - spending), txCount, topCategories };
}

async function getSummary(env: Env, args: Record<string, unknown>): Promise<unknown> {
  const window = parseSummaryArgs(args, todayIsoUtc());
  // Same dataset every page computes from: newest-first, capped at 5000
  // (spec §4.3) — the cap is pinned in docs/MCP.md.
  const [transactions, settings] = await Promise.all([
    readTransactions(env.DB),
    readSettings(env.DB),
  ]);
  return {
    dateFrom: window.dateFrom,
    dateTo: window.dateTo,
    ...computeSummary(transactions, window),
    currency: settings.currency,
  };
}

// ---------------------------------------------------------------------------
// get_recurring
// ---------------------------------------------------------------------------

export function parseRecurringArgs(args: Record<string, unknown>): TxType | null {
  rejectUnknownArgs(args, ['type'], 'get_recurring');
  return readOptionalTxType(args);
}

async function getRecurring(env: Env, args: Record<string, unknown>): Promise<unknown> {
  const type = parseRecurringArgs(args);
  const [transactions, settings] = await Promise.all([
    readTransactions(env.DB),
    readSettings(env.DB),
  ]);
  const now = new Date(`${todayIsoUtc()}T00:00:00Z`);
  const dismissed = new Set(settings.dismissedPatterns);
  // The ONE detection engine, run per direction (the sprint-6 opts) —
  // dismissed patterns contribute nothing (the user said "not recurring").
  const series = [
    ...(type !== 'income'
      ? detectPatterns(transactions, now).map((pattern) => ({ pattern, type: 'expense' as const }))
      : []),
    ...(type !== 'expense'
      ? detectPatterns(transactions, now, { type: 'income' }).map((pattern) => ({
          pattern,
          type: 'income' as const,
        }))
      : []),
  ].filter(({ pattern }) => !dismissed.has(pattern.key));
  // nextDate asc, then merchant, then key — stable regardless of engine order.
  series.sort((a, b) => {
    if (a.pattern.nextDate !== b.pattern.nextDate) {
      return a.pattern.nextDate < b.pattern.nextDate ? -1 : 1;
    }
    if (a.pattern.merchant !== b.pattern.merchant) {
      return a.pattern.merchant < b.pattern.merchant ? -1 : 1;
    }
    return a.pattern.key < b.pattern.key ? -1 : a.pattern.key > b.pattern.key ? 1 : 0;
  });
  return {
    patterns: series.map(({ pattern, type: patternType }) => ({
      merchant: pattern.merchant,
      kind: pattern.kind,
      cadence: pattern.cadence,
      averageAmount: pattern.averageAmount,
      monthlyEquivalent: round2(pattern.monthlyEquivalent),
      nextDate: pattern.nextDate,
      lastDate: pattern.lastDate,
      confidence: pattern.confidence,
      category: pattern.category,
      type: patternType,
    })),
  };
}

// ---------------------------------------------------------------------------
// get_forecast
// ---------------------------------------------------------------------------

export function parseForecastArgs(args: Record<string, unknown>): ForecastHorizon {
  rejectUnknownArgs(args, ['horizonDays'], 'get_forecast');
  const value = args.horizonDays;
  if (value === undefined || value === null) return 30;
  if (typeof value !== 'number' || !(FORECAST_HORIZONS as readonly number[]).includes(value)) {
    fail(`horizonDays must be one of: ${FORECAST_HORIZONS.join(', ')}.`);
  }
  return value as ForecastHorizon;
}

async function getForecast(env: Env, args: Record<string, unknown>): Promise<unknown> {
  const horizon = parseForecastArgs(args);
  const [transactions, settings] = await Promise.all([
    readTransactions(env.DB),
    readSettings(env.DB),
  ]);
  // today = the worker's UTC calendar day (sprint-7 precedent); the whole
  // Forecast object is shareable — plus the display currency.
  const forecast = buildForecast(
    transactions,
    new Set(settings.dismissedPatterns),
    horizon,
    todayIsoUtc(),
  );
  return { ...forecast, currency: settings.currency };
}

// ---------------------------------------------------------------------------
// get_budgets
// ---------------------------------------------------------------------------

export interface BudgetStatusRow {
  category: string;
  limit: number;
  spent: number;
  remaining: number;
  over: boolean;
}

/**
 * Mirrors the Budgets page month-window semantics exactly
 * (src/components/manage/budgetMath.ts, spec §12): active budgets only;
 * spent = expense transactions inside the calendar month whose category
 * matches case-insensitively after trimming; `over` matches the page's
 * danger tone — spent above the limit, so a zero-limit budget is over as
 * soon as anything is spent. The page has no rollover and each budget sums
 * its transactions independently. One deliberate difference: `month` is the
 * worker's UTC calendar month (sprint-7 convention) where the page uses the
 * browser's local month.
 */
export function computeBudgetRows(
  budgets: readonly Budget[],
  transactions: readonly Transaction[],
  month: string,
): BudgetStatusRow[] {
  const start = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const end = `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
  return budgets
    .filter((b) => b.active)
    .map((b) => {
      const target = b.category.trim().toLowerCase();
      let spent = 0;
      for (const t of transactions) {
        if (t.type !== 'expense') continue;
        if (t.date < start || t.date > end) continue;
        if (t.category.trim().toLowerCase() !== target) continue;
        spent += t.amount;
      }
      spent = round2(spent);
      return {
        category: b.category,
        limit: b.limit,
        spent,
        remaining: round2(b.limit - spent),
        over: spent > b.limit,
      };
    });
}

async function getBudgets(env: Env, args: Record<string, unknown>): Promise<unknown> {
  rejectUnknownArgs(args, [], 'get_budgets');
  const [transactions, settings] = await Promise.all([
    readTransactions(env.DB),
    readSettings(env.DB),
  ]);
  const month = todayIsoUtc().slice(0, 7);
  return { month, budgets: computeBudgetRows(settings.budgets, transactions, month) };
}

// ---------------------------------------------------------------------------
// get_briefing
// ---------------------------------------------------------------------------

async function getBriefing(env: Env, args: Record<string, unknown>): Promise<unknown> {
  rejectUnknownArgs(args, [], 'get_briefing');
  // The SAME assembly the briefings endpoints use (worker/briefings.ts) — no
  // fork. computeBriefing also returns the full Settings for the send path;
  // only the digest and its rendered text may leave through MCP.
  const { briefing, text } = await computeBriefing(env.DB);
  return { briefing, text };
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export interface McpTool {
  name: string;
  description: string;
  inputSchema: McpInputSchema;
  handler(env: Env, args: Record<string, unknown>): Promise<unknown>;
}

const DATE_FROM_SCHEMA = {
  type: 'string',
  description: 'Earliest date, YYYY-MM-DD (inclusive).',
} as const;
const DATE_TO_SCHEMA = {
  type: 'string',
  description: 'Latest date, YYYY-MM-DD (inclusive).',
} as const;

export const MCP_TOOLS: readonly McpTool[] = [
  {
    name: 'search_transactions',
    description:
      'Search the transaction ledger. All filters are optional and combine with AND; results are newest first. `query` is a case-insensitive substring matched against merchant, category and account.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Substring matched case-insensitively against merchant, category and account.',
        },
        dateFrom: DATE_FROM_SCHEMA,
        dateTo: DATE_TO_SCHEMA,
        type: { type: 'string', enum: ['expense', 'income'] },
        category: { type: 'string', description: 'Exact category name (case-insensitive).' },
        account: { type: 'string', description: 'Exact account name (case-insensitive).' },
        minAmount: { type: 'number', exclusiveMinimum: 0 },
        maxAmount: { type: 'number', exclusiveMinimum: 0 },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: SEARCH_MAX_LIMIT,
          description: `Rows to return, 1-${SEARCH_MAX_LIMIT} (default ${SEARCH_DEFAULT_LIMIT}).`,
        },
      },
      additionalProperties: false,
    },
    handler: searchTransactions,
  },
  {
    name: 'get_summary',
    description:
      'Income, spending, net and top spending categories for a named period or an explicit date range (omit everything for all-time).',
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: PERIOD_OPTIONS.map((o) => o.value),
          description: 'A named app period. Mutually exclusive with dateFrom/dateTo.',
        },
        dateFrom: DATE_FROM_SCHEMA,
        dateTo: DATE_TO_SCHEMA,
      },
      additionalProperties: false,
    },
    handler: getSummary,
  },
  {
    name: 'get_recurring',
    description:
      'Recurring payments and subscriptions the deterministic detection engine found — both expenses and income — with cadence, average amount and next expected date. Patterns the user dismissed are excluded.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['expense', 'income'],
          description: 'Only patterns of this direction (default: both).',
        },
      },
      additionalProperties: false,
    },
    handler: getRecurring,
  },
  {
    name: 'get_forecast',
    description:
      'Deterministic cash-flow projection built only from detected recurring patterns — no trend fitting, no invented numbers. Cumulative daily points plus every projected occurrence.',
    inputSchema: {
      type: 'object',
      properties: {
        horizonDays: {
          type: 'integer',
          enum: [...FORECAST_HORIZONS],
          description: 'Projection horizon in days (default 30).',
        },
      },
      additionalProperties: false,
    },
    handler: getForecast,
  },
  {
    name: 'get_budgets',
    description:
      'Current calendar-month status of every active budget: limit, spent, remaining and an over-budget flag.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: getBudgets,
  },
  {
    name: 'get_briefing',
    description:
      'The same deterministic briefing the app can deliver: last 7 days of real activity, next 7 days of projections, and honest to-review counts — as structured data plus rendered text.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: getBriefing,
  },
];

/** The registry bound to a live env, in the shape the protocol router takes. */
export function bindMcpTools(env: Env): McpToolHandle[] {
  return MCP_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    invoke: (args: Record<string, unknown>) => tool.handler(env, args),
  }));
}
