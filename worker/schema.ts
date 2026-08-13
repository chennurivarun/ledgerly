// Idempotent D1 schema + structural settings seeding (spec §4.1, §3).
// Safe to run on every request path that touches the DB; never destroys data.
import { defaultSettings } from '../shared/types';

export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    merchant TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Needs review',
    amount REAL NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('expense','income')),
    account TEXT NOT NULL DEFAULT 'Imported account',
    tags TEXT NOT NULL DEFAULT '[]',
    receipt INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    createdAt TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date DESC, createdAt DESC)`,
  `CREATE TABLE IF NOT EXISTS tags (
    name TEXT PRIMARY KEY,
    createdAt TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY,
    whenText TEXT NOT NULL,
    thenText TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS extractions (
    documentId TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    fields TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    error TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS statement_extractions (
    documentId TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    rowCount INTEGER NOT NULL DEFAULT 0,
    truncated INTEGER NOT NULL DEFAULT 0,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    error TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    providerState TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS statement_rows (
    id TEXT PRIMARY KEY,
    documentId TEXT NOT NULL,
    idx INTEGER NOT NULL,
    fields TEXT NOT NULL,
    status TEXT NOT NULL,
    duplicate INTEGER NOT NULL DEFAULT 0,
    lowestConfidence REAL NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_statement_rows_doc ON statement_rows(documentId, idx)`,
  `CREATE TABLE IF NOT EXISTS category_corrections (
    id TEXT PRIMARY KEY,
    merchant TEXT NOT NULL,
    category TEXT NOT NULL,
    createdAt TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_category_corrections_merchant
     ON category_corrections(merchant)`,
  `CREATE TABLE IF NOT EXISTS rule_suggestion_dismissals (
    key TEXT PRIMARY KEY,
    createdAt TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS merchant_profiles (
    normalizedMerchant TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    kind TEXT,
    category TEXT NOT NULL,
    createdAt TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS merchant_question_dismissals (
    normalizedMerchant TEXT PRIMARY KEY,
    createdAt TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS inbox_emails (
    id TEXT PRIMARY KEY,
    messageId TEXT NOT NULL UNIQUE,
    receivedAt TEXT NOT NULL,
    fromAddress TEXT NOT NULL,
    subject TEXT NOT NULL,
    status TEXT NOT NULL,
    parsed TEXT,
    documentId TEXT,
    createdAt TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_inbox_emails_created ON inbox_emails(createdAt DESC)`,
  `CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    mimeType TEXT NOT NULL,
    size INTEGER NOT NULL,
    objectKey TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    source TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    pageCount INTEGER
  )`,
];

/**
 * Lightweight migrations (sprint 11 — first one in the codebase; keep the
 * pattern exemplary). CREATE TABLE IF NOT EXISTS cannot add a column to a
 * table that already exists, so a column added after its table shipped needs
 * an ALTER of its own. The pattern:
 *
 * - One `ALTER TABLE … ADD COLUMN` per added column, nullable with no
 *   default, so pre-existing rows read as NULL ("unknown") — never a guessed
 *   value.
 * - The column ALSO appears (last — matching where ALTER appends it) in the
 *   CREATE TABLE above, so a fresh database and the wipe path are complete
 *   without the ALTER ever succeeding.
 * - The ALTER runs unconditionally on every ensureSchema; SQLite's
 *   "duplicate column name" error is the idempotence signal and is swallowed.
 *   Anything else re-throws — a migration that fails for a real reason must
 *   be loud, not silently skipped.
 */
const MIGRATION_STATEMENTS = [
  'ALTER TABLE documents ADD COLUMN pageCount INTEGER',
  // Sprint 12: a resumable Sarvam statement read parks its submit/tick state
  // here (worker/statements.ts owns the JSON shape). NULL for settled jobs,
  // single-request providers, and every row that predates the migration.
  'ALTER TABLE statement_extractions ADD COLUMN providerState TEXT',
];

/** The one ALTER outcome that means "already migrated" (D1 wraps the SQLite
 * message, so match the substring on the error and its cause). */
function isDuplicateColumn(err: unknown): boolean {
  const message =
    err instanceof Error
      ? `${err.message} ${err.cause instanceof Error ? err.cause.message : ''}`
      : String(err);
  return /duplicate column/i.test(message);
}

let ensured = false;

/**
 * Create tables and seed structural settings defaults. INSERT OR IGNORE means
 * existing user values always survive; starter categories/accounts are lookup
 * configuration only — never balances or transactions (spec §3).
 *
 * `force` skips the per-isolate memo so `DELETE /api/state` can re-seed the
 * defaults it just deleted (spec §4.7.3).
 */
export async function ensureSchema(db: D1Database, opts: { force?: boolean } = {}): Promise<void> {
  if (ensured && !opts.force) return; // per-isolate memo; statements are idempotent anyway
  await db.batch(SCHEMA_STATEMENTS.map((s) => db.prepare(s)));
  // Migrations run after the CREATEs: on a fresh database the ALTER hits the
  // duplicate-column signal immediately (the CREATE already has the column);
  // on a pre-migration database the CREATE no-ops and the ALTER does the work.
  for (const sql of MIGRATION_STATEMENTS) {
    try {
      await db.prepare(sql).run();
    } catch (err) {
      if (!isDuplicateColumn(err)) throw err;
    }
  }
  const now = new Date().toISOString();
  const defaults = defaultSettings();
  const stmt = db.prepare('INSERT OR IGNORE INTO settings (key, value, updatedAt) VALUES (?, ?, ?)');
  await db.batch(
    Object.entries(defaults).map(([key, value]) => stmt.bind(key, JSON.stringify(value), now)),
  );
  ensured = true;
}
