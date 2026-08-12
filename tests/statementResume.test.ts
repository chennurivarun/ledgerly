// Resumable Sarvam statement reads (sprint 12): submit-then-tick end to end
// through runStatementExtraction, with a fake D1 + R2 and a scripted Sarvam
// API. No network, no real waiting — and no wall-clock ceiling anywhere in
// the flow, which is the point of the sprint.
//
// The shape under test: one SUBMIT request creates every batch job and
// returns 'pending' immediately (providerState parked in D1); client-driven
// TICK requests (the same POST on the pending job) each poll the outstanding
// jobs once, harvest a bounded number of finished ones, and finalize through
// the ordinary persistence flow once every batch is terminal.
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  parseProviderState,
  runStatementExtraction,
  statementProgress,
  STATEMENT_DEADLINE_MESSAGE,
  STATEMENT_RESUME_DEADLINE_MS,
  type ProviderState,
} from '../worker/statements';

const DOC = 'doc-1';
const OBJECT_KEY = 'vault/doc-1.pdf';

// ---------------------------------------------------------------------------
// PDF fixture — real bytes so the submit path's split math runs for real.
// ---------------------------------------------------------------------------

async function pdfWithPages(count: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) doc.addPage([100 + i, 200]);
  return doc.save({ useObjectStreams: false });
}

// ---------------------------------------------------------------------------
// Scripted Sarvam API. Creates are served in order from `create`; statuses
// drain one per poll (last repeats); results are keyed by job id.
// ---------------------------------------------------------------------------

interface Call {
  url: string;
  init?: RequestInit;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface SarvamScript {
  /** One entry per expected create call: a job id, or an HTTP status to fail with. */
  create?: (string | { fail: number })[];
  /** Per-job status queues, drained one per poll; the last entry repeats. */
  statuses?: Record<string, string[]>;
  /** Per-job results body (`result` value). */
  results?: Record<string, unknown>;
}

function sarvamApi(script: SarvamScript) {
  const calls: Call[] = [];
  let created = 0;
  const statuses = new Map<string, string[]>(
    Object.entries(script.statuses ?? {}).map(([k, v]) => [k, [...v]]),
  );

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.endsWith('/extract')) {
      const entry = (script.create ?? [])[created];
      created++;
      if (entry === undefined) return json(500, {});
      if (typeof entry !== 'string') return json(entry.fail, {});
      return json(200, { job_id: entry, status: 'pending' });
    }
    const statusMatch = /\/([\w-]+)\/status$/.exec(url);
    if (statusMatch) {
      const queue = statuses.get(statusMatch[1]) ?? ['failed'];
      const status = queue.length > 1 ? queue.shift() : queue[0];
      return json(200, { job_id: statusMatch[1], status });
    }
    const resultsMatch = /\/([\w-]+)\/results$/.exec(url);
    if (resultsMatch) {
      return json(200, { result: (script.results ?? {})[resultsMatch[1]] ?? {} });
    }
    return json(404, {});
  }) as typeof fetch;

  return {
    fetchImpl,
    calls,
    urls: (suffix: string) => calls.filter((c) => c.url.endsWith(suffix)),
  };
}

function rawRow(merchant: string): Record<string, unknown> {
  return { date: '2026-03-04', merchant, amount: 100, type: 'expense', category: 'Dining' };
}

// ---------------------------------------------------------------------------
// Fake D1 + R2 covering exactly the statements the extract flow issues, with
// every executed statement recorded so tests can pin what did NOT run too.
// ---------------------------------------------------------------------------

interface JobRecord {
  documentId: string;
  status: string;
  rowCount: number;
  truncated: number;
  provider: string;
  model: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  providerState: string | null;
}

interface Tables {
  documents: Record<string, unknown>[];
  /** settings key → raw stored JSON string. */
  settings: Map<string, string>;
  statement_extractions: JobRecord[];
  statement_rows: Record<string, unknown>[];
  transactions: Record<string, unknown>[];
}

interface FakeDbOpts {
  /**
   * Makes the single-key secret read miss while the bulk settings read still
   * carries the row — the documented "key removed between the two reads"
   * race. It is how these tests drive the ANTHROPIC branch through its whole
   * claim→run→failure lifecycle without any network: the run fails inside
   * extractStatementFromDocument, before the SDK is touched.
   */
  hideSecretsOnDirectRead?: boolean;
}

function fakeDb(seed: Partial<Tables> = {}, opts: FakeDbOpts = {}) {
  const t: Tables = {
    documents: [],
    settings: new Map(),
    statement_extractions: [],
    statement_rows: [],
    transactions: [],
    ...seed,
  };
  const executed: { sql: string; args: unknown[] }[] = [];

  function exec(sql: string, args: unknown[]): { rows: Record<string, unknown>[]; changes: number } {
    executed.push({ sql, args });

    // --- documents ---------------------------------------------------------
    if (/FROM documents WHERE id = \?/i.test(sql)) {
      return { rows: t.documents.filter((d) => d.id === args[0]), changes: 0 };
    }
    if (/UPDATE documents SET status/i.test(sql)) return { rows: [], changes: 1 };

    // --- settings ----------------------------------------------------------
    if (/SELECT key, value FROM settings/i.test(sql)) {
      return {
        rows: [...t.settings].map(([key, value]) => ({ key, value })),
        changes: 0,
      };
    }
    if (/SELECT value FROM settings WHERE key = \?/i.test(sql)) {
      if (opts.hideSecretsOnDirectRead) return { rows: [], changes: 0 };
      const value = t.settings.get(args[0] as string);
      return { rows: value === undefined ? [] : [{ value }], changes: 0 };
    }

    // --- statement_extractions --------------------------------------------
    if (/^SELECT status, updatedAt FROM statement_extractions/i.test(sql)) {
      return {
        rows: t.statement_extractions.filter((j) => j.documentId === args[0]).map((j) => ({ ...j })),
        changes: 0,
      };
    }
    if (/SET providerState = \?, updatedAt = \?/i.test(sql)) {
      const [state, now, documentId] = args as [string | null, string, string];
      let changes = 0;
      for (const j of t.statement_extractions) {
        if (j.documentId === documentId) {
          j.providerState = state;
          j.updatedAt = now;
          changes++;
        }
      }
      return { rows: [], changes };
    }
    if (/UPDATE statement_extractions/i.test(sql)) {
      // The claim: SET status='pending', provider, model, error=NULL,
      // providerState=NULL, updatedAt WHERE documentId AND updatedAt.
      const [provider, model, now, documentId, expected] = args as string[];
      let changes = 0;
      for (const j of t.statement_extractions) {
        if (j.documentId === documentId && j.updatedAt === expected) {
          Object.assign(j, {
            status: 'pending',
            provider,
            model,
            error: null,
            providerState: null,
            updatedAt: now,
          });
          changes++;
        }
      }
      return { rows: [], changes };
    }
    if (/INSERT INTO statement_extractions/i.test(sql)) {
      const documentId = args[0] as string;
      const existing = t.statement_extractions.find((j) => j.documentId === documentId);
      if (/DO NOTHING/i.test(sql)) {
        if (existing) return { rows: [], changes: 0 };
        const [, provider, model, createdAt, updatedAt] = args as string[];
        t.statement_extractions.push({
          documentId,
          status: 'pending',
          rowCount: 0,
          truncated: 0,
          provider,
          model,
          error: null,
          createdAt,
          updatedAt,
          providerState: null,
        });
        return { rows: [], changes: 1 };
      }
      // saveJob's nine-column upsert.
      const [, status, rowCount, truncated, provider, model, error, createdAt, updatedAt] =
        args as [string, string, number, number, string, string, string | null, string, string];
      if (existing) {
        Object.assign(existing, { status, rowCount, truncated, provider, model, error, updatedAt });
      } else {
        t.statement_extractions.push({
          documentId,
          status,
          rowCount,
          truncated,
          provider,
          model,
          error,
          createdAt,
          updatedAt,
          providerState: null,
        });
      }
      return { rows: [], changes: 1 };
    }
    if (/FROM statement_extractions WHERE documentId = \?/i.test(sql)) {
      // JOB_SELECT reads (the tick pre-read and readJob).
      return {
        rows: t.statement_extractions.filter((j) => j.documentId === args[0]).map((j) => ({ ...j })),
        changes: 0,
      };
    }

    // --- statement_rows ----------------------------------------------------
    if (/DELETE FROM statement_rows/i.test(sql)) {
      const before = t.statement_rows.length;
      t.statement_rows = t.statement_rows.filter(
        (r) => !(r.documentId === args[0] && (r.status === 'proposed' || r.status === 'dismissed')),
      );
      return { rows: [], changes: before - t.statement_rows.length };
    }
    if (/FROM statement_rows\s+WHERE documentId = \? AND status = 'confirmed'/i.test(sql)) {
      return {
        rows: t.statement_rows.filter((r) => r.documentId === args[0] && r.status === 'confirmed'),
        changes: 0,
      };
    }
    if (/FROM statement_rows\s+WHERE documentId IN/i.test(sql)) {
      return {
        rows: t.statement_rows
          .filter((r) => (args as string[]).includes(r.documentId as string))
          .sort((a, b) => (a.idx as number) - (b.idx as number)),
        changes: 0,
      };
    }
    if (/INSERT INTO statement_rows/i.test(sql)) {
      const [id, documentId, idx, fields, status, duplicate, lowestConfidence, createdAt] = args;
      t.statement_rows.push({ id, documentId, idx, fields, status, duplicate, lowestConfidence, createdAt });
      return { rows: [], changes: 1 };
    }

    // --- transactions ------------------------------------------------------
    if (/SELECT fingerprint FROM transactions/i.test(sql)) {
      return {
        rows: t.transactions
          .filter((x) => (args as string[]).includes(x.fingerprint as string))
          .map((x) => ({ fingerprint: x.fingerprint })),
        changes: 0,
      };
    }

    throw new Error(`fake D1 has no handler for: ${sql}`);
  }

  interface Stmt {
    sql: string;
    args: unknown[];
    bind(...values: unknown[]): Stmt;
    all<T>(): Promise<{ results: T[] }>;
    first<T>(): Promise<T | null>;
    run(): Promise<{ meta: { changes: number } }>;
  }

  function statement(sql: string, args: unknown[] = []): Stmt {
    return {
      sql,
      args,
      bind: (...values: unknown[]) => statement(sql, values),
      all: async <T,>() => ({ results: exec(sql, args).rows as T[] }),
      first: async <T,>() => (exec(sql, args).rows[0] as T | undefined) ?? null,
      run: async () => ({ meta: { changes: exec(sql, args).changes } }),
    };
  }

  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Stmt[]) => {
      for (const s of statements) exec(s.sql, s.args);
      return [];
    },
  } as unknown as D1Database;

  return { db, tables: t, executed };
}

function makeEnv(
  bytes: Uint8Array,
  seed: Partial<Tables> = {},
  opts: FakeDbOpts = {},
) {
  const fake = fakeDb(
    {
      documents: [
        { id: DOC, mimeType: 'application/pdf', objectKey: OBJECT_KEY, size: bytes.length },
      ],
      ...seed,
    },
    opts,
  );
  const env = {
    DB: fake.db,
    BUCKET: {
      get: async (key: string) =>
        key === OBJECT_KEY
          ? {
              arrayBuffer: async () =>
                bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            }
          : null,
    },
  } as unknown as Env;
  return { env, ...fake };
}

function sarvamSettings(): Map<string, string> {
  return new Map([
    ['aiProvider', JSON.stringify('sarvam')],
    ['sarvamApiKeySecret', JSON.stringify('sk-sarvam-test')],
  ]);
}

const NOW_ISH = () => new Date().toISOString();

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

/** A pending resumable job row as the submit step leaves it. */
function pendingJob(state: ProviderState, overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    documentId: DOC,
    status: 'pending',
    rowCount: 0,
    truncated: 0,
    provider: 'sarvam',
    model: 'sarvam-doc-ai',
    error: null,
    createdAt: state.submittedAt,
    updatedAt: state.submittedAt,
    providerState: JSON.stringify(state),
    ...overrides,
  };
}

function state(jobs: ProviderState['jobs'], overrides: Partial<ProviderState> = {}): ProviderState {
  return { v: 1, jobs, batchCount: jobs.length, submittedAt: NOW_ISH(), ...overrides };
}

const jobState = (jobStatus: 'submitted' | 'done' | 'failed', jobId: string, rows?: unknown[]) =>
  rows === undefined ? { jobId, status: jobStatus } : { jobId, status: jobStatus, rows };

// ---------------------------------------------------------------------------
// SUBMIT
// ---------------------------------------------------------------------------

describe('submit — create every batch job, poll nothing, return pending', () => {
  it('an 11-page statement becomes 2 jobs, providerState, and progress {0,2} — with zero polling', async () => {
    const api = sarvamApi({ create: ['job-a', 'job-b'] });
    const { env, tables } = makeEnv(await pdfWithPages(11), { settings: sarvamSettings() });

    const result = await runStatementExtraction(env, DOC, { fetchImpl: api.fetchImpl });

    expect(result.status).toBe('pending');
    expect(result.progress).toEqual({ done: 0, total: 2 });
    expect(result.error).toBeNull();

    // The request made ONLY create calls — no /status, no /results: the
    // 90s in-request poll ceiling is gone because in-request polling is gone.
    expect(api.calls.length).toBe(2);
    expect(api.calls.every((c) => c.url.endsWith('/extract'))).toBe(true);

    const stored = parseProviderState(tables.statement_extractions[0].providerState);
    expect(stored).toEqual({
      v: 1,
      jobs: [
        { jobId: 'job-a', status: 'submitted' },
        { jobId: 'job-b', status: 'submitted' },
      ],
      batchCount: 2,
      submittedAt: expect.any(String),
    });
  });

  it('a create failing partway fails the whole run readably but records the jobs that exist', async () => {
    const api = sarvamApi({ create: ['job-a', { fail: 500 }] });
    const { env, tables } = makeEnv(await pdfWithPages(11), { settings: sarvamSettings() });

    const result = await runStatementExtraction(env, DOC, { fetchImpl: api.fetchImpl });

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/could not process/i);
    expect(result.progress).toBeNull();

    // job-a exists at Sarvam — recorded for the audit trail. With the run
    // 'failed' no tick will ever poll it: no orphan polling.
    const stored = parseProviderState(tables.statement_extractions[0].providerState);
    expect(stored?.jobs).toEqual([{ jobId: 'job-a', status: 'submitted' }]);
    expect(stored?.batchCount).toBe(2);
  });

  it('a later re-run claims over a failed submit and clears its recorded state', async () => {
    const api = sarvamApi({ create: ['job-a', { fail: 500 }] });
    const { env, tables } = makeEnv(await pdfWithPages(11), { settings: sarvamSettings() });
    await runStatementExtraction(env, DOC, { fetchImpl: api.fetchImpl });
    expect(tables.statement_extractions[0].providerState).not.toBeNull();

    // The re-run: fresh claim → stale audit state cleared → fresh submit. If
    // the claim did NOT clear it, this POST would have "ticked" job-a — a job
    // this run never created.
    const retry = sarvamApi({ create: ['job-c', 'job-d'] });
    const result = await runStatementExtraction(env, DOC, { fetchImpl: retry.fetchImpl });
    expect(result.status).toBe('pending');
    expect(parseProviderState(tables.statement_extractions[0].providerState)?.jobs).toEqual([
      { jobId: 'job-c', status: 'submitted' },
      { jobId: 'job-d', status: 'submitted' },
    ]);
  });

  it('an encrypted PDF fails the run with the password message and no jobs', async () => {
    // Splice the /Encrypt marker into a real PDF's trailer (pdf-lib cannot
    // create encrypted files) — same fixture technique as tests/sarvam.test.ts.
    const bytes = await pdfWithPages(1);
    const latin = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
    const at = latin.lastIndexOf('trailer');
    const open = latin.indexOf('<<', at);
    const insert = Uint8Array.from(' /Encrypt << /Filter /Standard /V 1 >>', (c) => c.charCodeAt(0));
    const out = new Uint8Array(bytes.length + insert.length);
    out.set(bytes.subarray(0, open + 2), 0);
    out.set(insert, open + 2);
    out.set(bytes.subarray(open + 2), open + 2 + insert.length);

    const api = sarvamApi({});
    const { env, tables } = makeEnv(out, { settings: sarvamSettings() });
    const result = await runStatementExtraction(env, DOC, { fetchImpl: api.fetchImpl });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/password-protected/i);
    expect(api.calls).toHaveLength(0);
    expect(tables.statement_extractions[0].providerState).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TICK
// ---------------------------------------------------------------------------

describe('tick — poll once, harvest bounded, keep pending until every batch is terminal', () => {
  it('harvests one of two, stays pending with progress {1,2}, then finalizes on the next tick', async () => {
    const st = state([jobState('submitted', 'job-a'), jobState('submitted', 'job-b')]);
    const { env, tables } = makeEnv(await pdfWithPages(11), {
      settings: sarvamSettings(),
      statement_extractions: [pendingJob(st)],
    });

    // Tick 1: job-b finished first, job-a still running. Harvest order and
    // batch order are different things — pinned at finalize below.
    const tick1 = sarvamApi({
      statuses: { 'job-a': ['running'], 'job-b': ['completed'] },
      results: { 'job-b': { rows: [rawRow('b2-r1')] } },
    });
    const mid = await runStatementExtraction(env, DOC, { fetchImpl: tick1.fetchImpl });
    expect(mid.status).toBe('pending');
    expect(mid.progress).toEqual({ done: 1, total: 2 });
    expect(tick1.urls('/status')).toHaveLength(2);
    expect(tick1.urls('/results')).toHaveLength(1);

    // Tick 2: only job-a is still outstanding — one poll, one harvest, then
    // finalize. Rows come out in BATCH order (job-a's page-1 rows first) even
    // though job-b finished first.
    const tick2 = sarvamApi({
      statuses: { 'job-a': ['completed'] },
      results: { 'job-a': { rows: [rawRow('b1-r1'), rawRow('b1-r2')] } },
    });
    const done = await runStatementExtraction(env, DOC, { fetchImpl: tick2.fetchImpl });
    expect(tick2.urls('/status')).toHaveLength(1);
    expect(done.status).toBe('suggested');
    expect(done.truncated).toBe(false);
    expect(done.rowCount).toBe(3);
    expect(done.progress).toBeNull();
    expect(done.rows.map((r) => r.merchant.value)).toEqual(['b1-r1', 'b1-r2', 'b2-r1']);
    expect(tables.statement_extractions[0].providerState).toBeNull();
  });

  it('bounds result fetches to 2 per tick — the third finished job waits for the next tick', async () => {
    const st = state([
      jobState('submitted', 'job-a'),
      jobState('submitted', 'job-b'),
      jobState('submitted', 'job-c'),
    ]);
    const { env } = makeEnv(await pdfWithPages(25), {
      settings: sarvamSettings(),
      statement_extractions: [pendingJob(st)],
    });

    const api = sarvamApi({
      statuses: { 'job-a': ['completed'], 'job-b': ['completed'], 'job-c': ['completed'] },
      results: {
        'job-a': { rows: [rawRow('a')] },
        'job-b': { rows: [rawRow('b')] },
        'job-c': { rows: [rawRow('c')] },
      },
    });
    const mid = await runStatementExtraction(env, DOC, { fetchImpl: api.fetchImpl });
    // 3 status polls, only 2 result fetches — the subrequest budget holds
    // however many batches finish at once.
    expect(api.urls('/status')).toHaveLength(3);
    expect(api.urls('/results')).toHaveLength(2);
    expect(mid.status).toBe('pending');
    expect(mid.progress).toEqual({ done: 2, total: 3 });

    const next = sarvamApi({
      statuses: { 'job-c': ['completed'] },
      results: { 'job-c': { rows: [rawRow('c')] } },
    });
    const done = await runStatementExtraction(env, DOC, { fetchImpl: next.fetchImpl });
    expect(done.status).toBe('suggested');
    expect(done.rows.map((r) => r.merchant.value)).toEqual(['a', 'b', 'c']);
  });

  it('one job failed + one done with rows → loud partial: status partial, truncated', async () => {
    const st = state([jobState('submitted', 'job-a'), jobState('submitted', 'job-b')]);
    const { env } = makeEnv(await pdfWithPages(11), {
      settings: sarvamSettings(),
      statement_extractions: [pendingJob(st)],
    });
    const api = sarvamApi({
      statuses: { 'job-a': ['completed'], 'job-b': ['failed'] },
      results: { 'job-a': { rows: [rawRow('kept')] } },
    });
    const done = await runStatementExtraction(env, DOC, { fetchImpl: api.fetchImpl });
    expect(done.status).toBe('partial');
    expect(done.truncated).toBe(true);
    expect(done.rows.map((r) => r.merchant.value)).toEqual(['kept']);
    // A failed job has no results to fetch.
    expect(api.urls('/results')).toHaveLength(1);
  });

  it('a partially_completed job keeps its readable rows AND truncates the run', async () => {
    const st = state([jobState('submitted', 'job-a')]);
    const { env } = makeEnv(await pdfWithPages(5), {
      settings: sarvamSettings(),
      statement_extractions: [pendingJob(st)],
    });
    const api = sarvamApi({
      statuses: { 'job-a': ['partially_completed'] },
      results: { 'job-a': { rows: [rawRow('partial-read')] } },
    });
    const done = await runStatementExtraction(env, DOC, { fetchImpl: api.fetchImpl });
    expect(done.status).toBe('partial');
    expect(done.truncated).toBe(true);
    expect(done.rows.map((r) => r.merchant.value)).toEqual(['partial-read']);
  });

  it('every job failed → the run fails with a readable message, state cleared', async () => {
    const st = state([jobState('submitted', 'job-a'), jobState('submitted', 'job-b')]);
    const { env, tables } = makeEnv(await pdfWithPages(11), {
      settings: sarvamSettings(),
      statement_extractions: [pendingJob(st)],
    });
    const api = sarvamApi({ statuses: { 'job-a': ['failed'], 'job-b': ['rejected'] } });
    const done = await runStatementExtraction(env, DOC, { fetchImpl: api.fetchImpl });
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/could not read any transactions/i);
    expect(tables.statement_extractions[0].providerState).toBeNull();
  });

  it('all jobs completed but zero rows overall → failed readable, not "0 proposed"', async () => {
    const st = state([jobState('submitted', 'job-a')]);
    const { env } = makeEnv(await pdfWithPages(5), {
      settings: sarvamSettings(),
      statement_extractions: [pendingJob(st)],
    });
    const api = sarvamApi({
      statuses: { 'job-a': ['completed'] },
      results: { 'job-a': { rows: [] } },
    });
    const done = await runStatementExtraction(env, DOC, { fetchImpl: api.fetchImpl });
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/could not read any transactions/i);
  });

  it('a provider hiccup mid-tick keeps what the tick learned and stays pending for the next one', async () => {
    const st = state([jobState('submitted', 'job-a'), jobState('submitted', 'job-b')]);
    const { env, tables } = makeEnv(await pdfWithPages(11), {
      settings: sarvamSettings(),
      statement_extractions: [pendingJob(st)],
    });
    // job-a harvests; job-b's poll answers 429 — transient, swallowed.
    const api = sarvamApi({
      statuses: { 'job-a': ['completed'] },
      results: { 'job-a': { rows: [rawRow('kept')] } },
    });
    const throttled = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('job-b')) return json(429, {});
      return api.fetchImpl(input, init);
    }) as typeof fetch;
    const mid = await runStatementExtraction(env, DOC, { fetchImpl: throttled });
    expect(mid.status).toBe('pending');
    expect(mid.progress).toEqual({ done: 1, total: 2 });
    const stored = parseProviderState(tables.statement_extractions[0].providerState);
    expect(stored?.jobs[0]).toMatchObject({ jobId: 'job-a', status: 'done' });
    expect(stored?.jobs[1]).toMatchObject({ jobId: 'job-b', status: 'submitted' });
  });

  it('a key removed mid-run makes the tick a no-op (still pending, nothing polled) — the deadline bounds it', async () => {
    const st = state([jobState('submitted', 'job-a')]);
    const settings = sarvamSettings();
    settings.delete('sarvamApiKeySecret');
    const { env } = makeEnv(await pdfWithPages(5), {
      settings,
      statement_extractions: [pendingJob(st)],
    });
    const api = sarvamApi({});
    const mid = await runStatementExtraction(env, DOC, { fetchImpl: api.fetchImpl });
    expect(mid.status).toBe('pending');
    expect(api.calls).toHaveLength(0);
  });

  it('ticks keep working after the user switches the provider away mid-run — a paid read still finishes', async () => {
    const st = state([jobState('submitted', 'job-a')]);
    const settings = sarvamSettings();
    settings.set('aiProvider', JSON.stringify('off')); // would 400 a NEW run
    const { env } = makeEnv(await pdfWithPages(5), {
      settings,
      statement_extractions: [pendingJob(st)],
    });
    const api = sarvamApi({
      statuses: { 'job-a': ['completed'] },
      results: { 'job-a': { rows: [rawRow('r')] } },
    });
    const done = await runStatementExtraction(env, DOC, { fetchImpl: api.fetchImpl });
    expect(done.status).toBe('suggested');
  });
});

// ---------------------------------------------------------------------------
// The 20-minute overall deadline
// ---------------------------------------------------------------------------

describe('the overall deadline', () => {
  it('an unfinished run older than 20 minutes fails with the pinned message and clears its state', async () => {
    const st = state([jobState('done', 'job-a', [rawRow('read')]), jobState('submitted', 'job-b')], {
      submittedAt: minutesAgo(21),
    });
    const { env, tables } = makeEnv(await pdfWithPages(11), {
      settings: sarvamSettings(),
      statement_extractions: [pendingJob(st)],
    });
    const api = sarvamApi({});
    const done = await runStatementExtraction(env, DOC, { fetchImpl: api.fetchImpl });
    expect(done.status).toBe('failed');
    expect(done.error).toBe(STATEMENT_DEADLINE_MESSAGE);
    expect(done.progress).toBeNull();
    expect(tables.statement_extractions[0].providerState).toBeNull();
    // Expired means expired: no further provider calls were spent on it.
    expect(api.calls).toHaveLength(0);
    expect(STATEMENT_RESUME_DEADLINE_MS).toBe(20 * 60 * 1000);
  });

  it('a run whose batches are ALL terminal finalizes even past the deadline — the pages were paid for', async () => {
    const st = state([jobState('done', 'job-a', [rawRow('late-but-read')])], {
      submittedAt: minutesAgo(45),
    });
    const { env } = makeEnv(await pdfWithPages(5), {
      settings: sarvamSettings(),
      statement_extractions: [pendingJob(st)],
    });
    const done = await runStatementExtraction(env, DOC, { fetchImpl: sarvamApi({}).fetchImpl });
    expect(done.status).toBe('suggested');
    expect(done.rows.map((r) => r.merchant.value)).toEqual(['late-but-read']);
  });
});

// ---------------------------------------------------------------------------
// Tick-vs-claim guard + the anthropic pin
// ---------------------------------------------------------------------------

describe('tick vs claim', () => {
  it('pending WITHOUT providerState still 409s inside the in-flight window (legacy semantics)', async () => {
    const now = NOW_ISH();
    const { env } = makeEnv(await pdfWithPages(5), {
      settings: sarvamSettings(),
      statement_extractions: [
        pendingJob(state([jobState('submitted', 'x')]), {
          providerState: null,
          createdAt: now,
          updatedAt: now,
        }),
      ],
    });
    await expect(
      runStatementExtraction(env, DOC, { fetchImpl: sarvamApi({}).fetchImpl }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('pending with CORRUPT providerState is legacy pending: 409 in the window, reclaim after it', async () => {
    const now = NOW_ISH();
    const corrupt = pendingJob(state([jobState('submitted', 'x')]), {
      providerState: '{definitely not json',
      createdAt: now,
      updatedAt: now,
    });
    const { env, tables } = makeEnv(await pdfWithPages(5), {
      settings: sarvamSettings(),
      statement_extractions: [corrupt],
    });
    await expect(
      runStatementExtraction(env, DOC, { fetchImpl: sarvamApi({}).fetchImpl }),
    ).rejects.toMatchObject({ status: 409 });

    // Window lapsed → the claim wins and CLEARS the unparseable blob, so the
    // new run is a clean submit, not a tick against garbage.
    tables.statement_extractions[0].updatedAt = minutesAgo(5);
    const api = sarvamApi({ create: ['job-fresh'] });
    const result = await runStatementExtraction(env, DOC, { fetchImpl: api.fetchImpl });
    expect(result.status).toBe('pending');
    expect(parseProviderState(tables.statement_extractions[0].providerState)?.jobs).toEqual([
      { jobId: 'job-fresh', status: 'submitted' },
    ]);
  });

  it('pending WITH parseable providerState ticks — no claim, no 409, even deep inside the window', async () => {
    const now = NOW_ISH();
    const st = state([jobState('submitted', 'job-a')], { submittedAt: now });
    const { env, executed } = makeEnv(await pdfWithPages(5), {
      settings: sarvamSettings(),
      statement_extractions: [pendingJob(st, { updatedAt: now })],
    });
    const api = sarvamApi({ statuses: { 'job-a': ['running'] } });
    const mid = await runStatementExtraction(env, DOC, { fetchImpl: api.fetchImpl });
    expect(mid.status).toBe('pending');
    // The claim's conditional UPDATE never ran — a tick advances the existing
    // run instead of fighting it.
    expect(executed.some((e) => /SET status = 'pending'/.test(e.sql))).toBe(false);
  });

  it("the anthropic branch never writes providerState — the whole run's SQL is clean of it", async () => {
    // Drive the anthropic branch through claim → run → failure without any
    // network: the settings row advertises a stored key (aiKeySet true) while
    // the direct secret read misses, so extractStatementFromDocument fails on
    // its documented removed-mid-flight guard before touching the SDK.
    const { env, tables, executed } = makeEnv(
      await pdfWithPages(2),
      {
        settings: new Map([
          ['aiProvider', JSON.stringify('anthropic')],
          ['aiApiKeySecret', JSON.stringify('sk-ant-fake')],
        ]),
      },
      { hideSecretsOnDirectRead: true },
    );
    const result = await runStatementExtraction(env, DOC, { fetchImpl: sarvamApi({}).fetchImpl });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/No Anthropic API key/i);
    expect(result.progress).toBeNull();

    // The pin itself: nothing in the run wrote resumable state. The only SQL
    // mentioning providerState is the shared claim (its literal NULL reset)
    // and the read paths — never the tick/submit writer, and never a bound
    // non-null value.
    expect(executed.some((e) => /SET providerState = \?/.test(e.sql))).toBe(false);
    for (const e of executed) {
      for (const arg of e.args) {
        if (typeof arg === 'string') expect(arg).not.toContain('"jobs"');
      }
    }
    expect(tables.statement_extractions[0].providerState).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pure helpers: providerState round-trip + progress derivation matrix
// ---------------------------------------------------------------------------

describe('parseProviderState', () => {
  it('round-trips the exact v1 shape', () => {
    const st = state(
      [jobState('done', 'job-a', [rawRow('r')]), jobState('submitted', 'job-b')],
      { submittedAt: '2026-08-13T10:00:00.000Z' },
    );
    expect(parseProviderState(JSON.stringify(st))).toEqual(st);
  });

  for (const [label, bad] of [
    ['null', null],
    ['not JSON', '{nope'],
    ['a JSON string', '"pending"'],
    ['wrong version', JSON.stringify({ v: 2, jobs: [], batchCount: 1, submittedAt: 'x' })],
    ['missing jobs', JSON.stringify({ v: 1, batchCount: 1, submittedAt: 'x' })],
    ['non-array jobs', JSON.stringify({ v: 1, jobs: 'many', batchCount: 1, submittedAt: 'x' })],
    [
      'a job with no id',
      JSON.stringify({ v: 1, jobs: [{ status: 'submitted' }], batchCount: 1, submittedAt: 'x' }),
    ],
    [
      'a job with an unknown status',
      JSON.stringify({ v: 1, jobs: [{ jobId: 'a', status: 'polling' }], batchCount: 1, submittedAt: 'x' }),
    ],
    [
      'non-array rows',
      JSON.stringify({ v: 1, jobs: [{ jobId: 'a', status: 'done', rows: 'r' }], batchCount: 1, submittedAt: 'x' }),
    ],
    ['zero batchCount', JSON.stringify({ v: 1, jobs: [], batchCount: 0, submittedAt: 'x' })],
    [
      'fractional batchCount',
      JSON.stringify({ v: 1, jobs: [], batchCount: 1.5, submittedAt: 'x' }),
    ],
    [
      'missing submittedAt',
      JSON.stringify({ v: 1, jobs: [{ jobId: 'a', status: 'submitted' }], batchCount: 1 }),
    ],
  ] as const) {
    it(`rejects ${label} → null (legacy pending, never a guessed resume)`, () => {
      expect(parseProviderState(bad as string | null)).toBeNull();
    });
  }
});

describe('statementProgress — the derivation matrix', () => {
  const valid = JSON.stringify(
    state([jobState('done', 'a', []), jobState('failed', 'b'), jobState('submitted', 'c')]),
  );

  it('pending + valid state → {done: terminal jobs, total: batchCount}', () => {
    expect(statementProgress('pending', valid)).toEqual({ done: 2, total: 3 });
  });

  it('done counts both harvested and failed jobs — anything the provider settled', () => {
    const allDone = JSON.stringify(state([jobState('done', 'a', []), jobState('failed', 'b')]));
    expect(statementProgress('pending', allDone)).toEqual({ done: 2, total: 2 });
  });

  it('total comes from batchCount, not the recorded job list (a half-submitted run is honest)', () => {
    const halfSubmitted = JSON.stringify(
      state([jobState('submitted', 'a')], { batchCount: 3 }),
    );
    expect(statementProgress('pending', halfSubmitted)).toEqual({ done: 0, total: 3 });
  });

  it('every non-pending status → null, state or no state', () => {
    for (const status of ['suggested', 'partial', 'confirmed', 'dismissed', 'failed']) {
      expect(statementProgress(status, valid)).toBeNull();
      expect(statementProgress(status, null)).toBeNull();
    }
  });

  it('pending without state, or with corrupt state → null (legacy pending)', () => {
    expect(statementProgress('pending', null)).toBeNull();
    expect(statementProgress('pending', undefined)).toBeNull();
    expect(statementProgress('pending', '{broken')).toBeNull();
  });
});
