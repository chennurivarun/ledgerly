// The single insert pipeline for every import path — manual, CSV, documents and
// Drive all go through here so validation, tag registration, duplicate
// detection and rules behave identically (spec §4.4, §8.3).
import { txFingerprint } from '../shared/fingerprint';
import {
  NEEDS_REVIEW,
  type BatchInsertResult,
  type Transaction,
  type TxSource,
  type TxType,
} from '../shared/types';
import { readEnabledRules, rowToTransaction, TX_COLUMNS, type TxRow } from './queries';
import { applyRules } from './rules';
import { isIsoDate, isRecord, normalizeNames } from './util';

export const DEFAULT_ACCOUNT = 'Imported account';
export const MAX_BATCH = 5000;

const SOURCES = new Set<TxSource>(['manual', 'csv', 'document', 'google-drive']);

/** A validated row, ready to insert. Ids/timestamps are added at insert time. */
export type ValidTx = Omit<Transaction, 'id' | 'createdAt'>;

export interface TxDefaults {
  /** Used when the payload does not carry a source. */
  source?: TxSource;
  /** Overrides any source in the payload (documents/Drive own their source). */
  forceSource?: TxSource;
  /** Account fallback when the payload has no grounded account. */
  account?: string;
  /** Tags added to every row (e.g. `Drive import`). */
  extraTags?: string[];
  receipt?: boolean;
}

export type ValidationResult =
  | { ok: true; value: ValidTx }
  | { ok: false; error: string };

function readAmount(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100; // money is cents; keeps the fingerprint stable
}

/** Boundary validation for one TxInput. Pure — exported for tests. */
export function validateTxInput(raw: unknown, defaults: TxDefaults = {}): ValidationResult {
  if (!isRecord(raw)) return { ok: false, error: 'expected an object.' };

  const date = typeof raw.date === 'string' ? raw.date.trim() : '';
  if (!isIsoDate(date)) return { ok: false, error: 'date must be a real YYYY-MM-DD date.' };

  const merchant = typeof raw.merchant === 'string' ? raw.merchant.trim() : '';
  if (!merchant) return { ok: false, error: 'merchant is required.' };

  const amount = readAmount(raw.amount);
  if (amount === null) return { ok: false, error: 'amount must be a positive number.' };

  const type = raw.type;
  if (type !== 'expense' && type !== 'income') {
    return { ok: false, error: "type must be 'expense' or 'income'." };
  }

  const tags = normalizeNames(raw.tags);
  if (tags === null) return { ok: false, error: 'tags must be a list of names.' };
  const merged = normalizeNames([...tags, ...(defaults.extraTags ?? [])]) ?? [];

  const category = (typeof raw.category === 'string' ? raw.category.trim() : '') || NEEDS_REVIEW;
  const account =
    (typeof raw.account === 'string' ? raw.account.trim() : '') ||
    defaults.account ||
    DEFAULT_ACCOUNT;

  const payloadSource = typeof raw.source === 'string' ? (raw.source as TxSource) : undefined;
  const source =
    defaults.forceSource ??
    (payloadSource && SOURCES.has(payloadSource) ? payloadSource : (defaults.source ?? 'manual'));

  const receipt =
    typeof raw.receipt === 'boolean' ? raw.receipt : (defaults.receipt ?? false);

  return {
    ok: true,
    value: {
      date,
      merchant,
      category,
      amount,
      type: type as TxType,
      account,
      tags: merged,
      receipt,
      source,
      fingerprint: txFingerprint(date, merchant, amount, account),
    },
  };
}

/**
 * Split rows against the fingerprints already stored. Pure — exported for
 * tests. Duplicates *inside* the batch collapse too, so one payload can never
 * insert the same transaction twice.
 */
export function partitionByFingerprint<T extends { fingerprint: string }>(
  rows: T[],
  existing: ReadonlySet<string>,
): { fresh: T[]; duplicates: number } {
  const fresh: T[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const row of rows) {
    if (existing.has(row.fingerprint) || seen.has(row.fingerprint)) {
      duplicates++;
      continue;
    }
    seen.add(row.fingerprint);
    fresh.push(row);
  }
  return { fresh, duplicates };
}

function isUniqueViolation(err: unknown): boolean {
  const message =
    err instanceof Error
      ? `${err.message} ${err.cause instanceof Error ? err.cause.message : ''}`
      : String(err);
  return /unique constraint/i.test(message);
}

/**
 * Fingerprints of `candidates` that already exist, looked up in small chunks.
 * Exported for the statement pipeline's duplicate pre-flagging, which asks the
 * same question before the user commits to anything.
 */
export async function existingFingerprints(
  db: D1Database,
  candidates: string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  const unique = [...new Set(candidates)];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const placeholders = chunk.map(() => '?').join(',');
    const { results } = await db
      .prepare(`SELECT fingerprint FROM transactions WHERE fingerprint IN (${placeholders})`)
      .bind(...chunk)
      .all<{ fingerprint: string }>();
    for (const row of results ?? []) found.add(row.fingerprint);
  }
  return found;
}

/** Register unseen tag names, keeping the casing they were first seen with. */
export async function registerTags(db: D1Database, names: string[]): Promise<void> {
  if (names.length === 0) return;
  const { results } = await db.prepare('SELECT name FROM tags').all<{ name: string }>();
  const known = new Set((results ?? []).map((r) => r.name.toLowerCase()));
  const now = new Date().toISOString();
  const stmt = db.prepare('INSERT OR IGNORE INTO tags (name, createdAt) VALUES (?, ?)');
  const fresh: D1PreparedStatement[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (known.has(key)) continue;
    known.add(key);
    fresh.push(stmt.bind(name, now));
  }
  if (fresh.length > 0) await db.batch(fresh);
}

/**
 * Validate → dedupe → apply enabled rules → insert. Rows are inserted one at a
 * time (not in a D1 batch) so one bad row never rolls back the good ones, and
 * so a UNIQUE violation from a concurrent import counts as a duplicate instead
 * of failing the request (spec §8.3, §20).
 */
export async function insertTransactions(
  db: D1Database,
  inputs: unknown[],
  defaults: TxDefaults = {},
): Promise<BatchInsertResult> {
  const errors: string[] = [];
  const valid: ValidTx[] = [];
  let duplicates = 0;

  inputs.forEach((raw, index) => {
    const result = validateTxInput(raw, defaults);
    if (result.ok) valid.push(result.value);
    else errors.push(`Row ${index + 1}: ${result.error}`);
  });

  if (valid.length === 0) {
    return { inserted: 0, duplicates: 0, insertedRows: [], errors };
  }

  const existing = await existingFingerprints(
    db,
    valid.map((v) => v.fingerprint),
  );
  const { fresh, duplicates: preChecked } = partitionByFingerprint(valid, existing);
  duplicates += preChecked;

  const rules = fresh.length > 0 ? await readEnabledRules(db) : [];
  const insertedRows: Transaction[] = [];
  const stmt = db.prepare(
    `INSERT INTO transactions (${TX_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const row of fresh) {
    // Rules run after dedupe and only on rows we are about to insert — they can
    // change the category/tags, never the fingerprint, so they cannot create a
    // duplicate (spec §4.4).
    const ruled = applyRules(row, rules);
    const tx: Transaction = {
      ...row,
      category: ruled.category,
      tags: ruled.tags,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    try {
      await stmt
        .bind(
          tx.id,
          tx.date,
          tx.merchant,
          tx.category,
          tx.amount,
          tx.type,
          tx.account,
          JSON.stringify(tx.tags),
          tx.receipt ? 1 : 0,
          tx.source,
          tx.fingerprint,
          tx.createdAt,
        )
        .run();
      insertedRows.push(tx);
    } catch (err) {
      if (isUniqueViolation(err)) duplicates++; // raced with another import
      else errors.push(`${tx.merchant}: could not be saved.`);
    }
  }

  const tagNames = normalizeNames(insertedRows.flatMap((t) => t.tags)) ?? [];
  await registerTags(db, tagNames);

  return { inserted: insertedRows.length, duplicates, insertedRows, errors };
}

/** Read one transaction back after a write. */
export async function readTransaction(db: D1Database, id: string): Promise<Transaction | null> {
  const row = await db
    .prepare(`SELECT ${TX_COLUMNS} FROM transactions WHERE id = ?`)
    .bind(id)
    .first<TxRow>();
  return row ? rowToTransaction(row) : null;
}
