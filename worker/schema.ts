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
  `CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    mimeType TEXT NOT NULL,
    size INTEGER NOT NULL,
    objectKey TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    source TEXT NOT NULL,
    createdAt TEXT NOT NULL
  )`,
];

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
  const now = new Date().toISOString();
  const defaults = defaultSettings();
  const stmt = db.prepare('INSERT OR IGNORE INTO settings (key, value, updatedAt) VALUES (?, ?, ?)');
  await db.batch(
    Object.entries(defaults).map(([key, value]) => stmt.bind(key, JSON.stringify(value), now)),
  );
  ensured = true;
}
