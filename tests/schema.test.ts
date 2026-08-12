// ensureSchema's lightweight-migration pattern (sprint 11 — the first ALTER
// migration in the codebase). CREATE TABLE IF NOT EXISTS cannot add columns
// to existing tables, so a column added after its table shipped rides an
// idempotent "ALTER, swallow duplicate-column" step. These tests pin the two
// database shapes it must handle (pre-migration and fresh) and that only the
// duplicate-column signal is ever swallowed.
import { describe, expect, it } from 'vitest';
import { SCHEMA_STATEMENTS, ensureSchema } from '../worker/schema';

// ---------------------------------------------------------------------------
// Fake D1 that actually tracks tables and their columns, so CREATE TABLE IF
// NOT EXISTS vs ALTER semantics are simulated rather than assumed: CREATE on
// an existing table is a no-op (exactly why the migration exists), and ALTER
// on an existing column throws SQLite's duplicate-column error.
// ---------------------------------------------------------------------------

/** First word of each depth-0 comma segment = the column name. */
function parseColumns(body: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      segments.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  segments.push(current);
  return segments.map((s) => s.trim().split(/\s+/)[0]).filter(Boolean);
}

function fakeDb(opts: { alterError?: Error } = {}) {
  const tables = new Map<string, string[]>();
  // Per-table so each migration's idempotence is pinned on its own count,
  // however many migrations MIGRATION_STATEMENTS grows to.
  const alterCounts = new Map<string, number>();

  function exec(sql: string): void {
    const create = sql.match(/^\s*CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*)\)\s*$/i);
    if (create) {
      const [, name, body] = create;
      if (!tables.has(name)) tables.set(name, parseColumns(body));
      return; // existing table: the no-op that makes the ALTER necessary
    }
    const alter = sql.match(/^\s*ALTER TABLE (\w+) ADD COLUMN (\w+)/i);
    if (alter) {
      const [, name, column] = alter;
      alterCounts.set(name, (alterCounts.get(name) ?? 0) + 1);
      if (opts.alterError) throw opts.alterError;
      const cols = tables.get(name);
      if (!cols) throw new Error(`no such table: ${name}`);
      if (cols.includes(column)) {
        // D1 wraps the SQLite message; the substring is what matters.
        throw new Error(`D1_ERROR: duplicate column name: ${column}: SQLITE_ERROR`);
      }
      cols.push(column);
      return;
    }
    if (/^\s*CREATE INDEX IF NOT EXISTS/i.test(sql)) return;
    if (/^\s*INSERT OR IGNORE INTO settings/i.test(sql)) return;
    throw new Error(`fake D1 has no handler for: ${sql}`);
  }

  interface Stmt {
    sql: string;
    bind(...values: unknown[]): Stmt;
    run(): Promise<{ meta: { changes: number } }>;
  }
  function statement(sql: string): Stmt {
    return {
      sql,
      bind: () => statement(sql),
      run: async () => {
        exec(sql);
        return { meta: { changes: 1 } };
      },
    };
  }

  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Stmt[]) => {
      for (const s of statements) exec(s.sql);
      return [];
    },
  } as unknown as D1Database;

  return { db, tables, alterAttempts: (table: string) => alterCounts.get(table) ?? 0 };
}

/** The documents table exactly as it shipped BEFORE sprint 11 — no pageCount. */
const OLD_DOCUMENTS_CREATE = `CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    mimeType TEXT NOT NULL,
    size INTEGER NOT NULL,
    objectKey TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    source TEXT NOT NULL,
    createdAt TEXT NOT NULL
  )`;

describe('ensureSchema — pageCount migration', () => {
  // force: true throughout — ensureSchema's per-isolate memo would otherwise
  // no-op every call after the first across the whole test run.

  it('adds pageCount to a pre-migration documents table, idempotently across repeat runs', async () => {
    const { db, tables, alterAttempts } = fakeDb();
    // Simulate a database created by the OLD schema shape: the table exists
    // without the column, so the CREATE in ensureSchema will be a no-op.
    await db.prepare(OLD_DOCUMENTS_CREATE).run();
    expect(tables.get('documents')).not.toContain('pageCount');

    await ensureSchema(db, { force: true });
    expect(tables.get('documents')).toContain('pageCount');

    // Second run: the ALTER fires again, hits duplicate-column, and is
    // swallowed — no error, no change.
    await ensureSchema(db, { force: true });
    expect(alterAttempts('documents')).toBe(2);
    expect(tables.get('documents')?.filter((c) => c === 'pageCount')).toHaveLength(1);
  });

  it('a fresh database gets pageCount from the CREATE itself, and repeat runs stay clean', async () => {
    const { db, tables } = fakeDb();
    await ensureSchema(db, { force: true });
    expect(tables.get('documents')).toContain('pageCount');
    // The ALTER hit duplicate-column internally and was swallowed; a second
    // full run must be just as quiet.
    await expect(ensureSchema(db, { force: true })).resolves.toBeUndefined();
  });

  it('re-throws a migration failure that is NOT the duplicate-column signal', async () => {
    // Only "already migrated" may be silent. A real failure (here: a
    // simulated D1 outage) must reject loudly, not be skipped.
    const { db } = fakeDb({ alterError: new Error('D1_ERROR: database is locked') });
    await expect(ensureSchema(db, { force: true })).rejects.toThrow(/database is locked/);
  });

  it('pins pageCount in the documents CREATE, so fresh installs never depend on the ALTER', () => {
    const create = SCHEMA_STATEMENTS.find((s) => /CREATE TABLE IF NOT EXISTS documents/.test(s));
    expect(create).toMatch(/pageCount INTEGER/);
  });
});

/** statement_extractions exactly as it shipped BEFORE sprint 12 — no providerState. */
const OLD_STATEMENT_EXTRACTIONS_CREATE = `CREATE TABLE IF NOT EXISTS statement_extractions (
    documentId TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    rowCount INTEGER NOT NULL DEFAULT 0,
    truncated INTEGER NOT NULL DEFAULT 0,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    error TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )`;

describe('ensureSchema — providerState migration (sprint 12)', () => {
  it('adds providerState to a pre-migration statement_extractions table, idempotently', async () => {
    const { db, tables, alterAttempts } = fakeDb();
    await db.prepare(OLD_STATEMENT_EXTRACTIONS_CREATE).run();
    expect(tables.get('statement_extractions')).not.toContain('providerState');

    await ensureSchema(db, { force: true });
    expect(tables.get('statement_extractions')).toContain('providerState');

    await ensureSchema(db, { force: true });
    expect(alterAttempts('statement_extractions')).toBe(2);
    expect(
      tables.get('statement_extractions')?.filter((c) => c === 'providerState'),
    ).toHaveLength(1);
  });

  it('a fresh database gets providerState from the CREATE itself', async () => {
    const { db, tables } = fakeDb();
    await ensureSchema(db, { force: true });
    expect(tables.get('statement_extractions')).toContain('providerState');
    await expect(ensureSchema(db, { force: true })).resolves.toBeUndefined();
  });

  it('pins providerState LAST in the CREATE — matching where the ALTER appends it', () => {
    const create = SCHEMA_STATEMENTS.find((s) =>
      /CREATE TABLE IF NOT EXISTS statement_extractions/.test(s),
    );
    expect(create).toBeDefined();
    expect(create).toMatch(/providerState TEXT\s*\)\s*$/);
  });
});
