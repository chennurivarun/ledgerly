// Read paths + row mappers. D1 stores tags as JSON text and booleans as 0/1;
// everything crossing the API boundary uses the frozen shared types.
import type { DocumentMeta, Rule, Tag, Transaction } from '../shared/types';

export const TX_COLUMNS =
  'id, date, merchant, category, amount, type, account, tags, receipt, source, fingerprint, createdAt';

export interface TxRow {
  id: string;
  date: string;
  merchant: string;
  category: string;
  amount: number;
  type: string;
  account: string;
  tags: string;
  receipt: number;
  source: string;
  fingerprint: string;
  createdAt: string;
}

function parseTags(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

export function rowToTransaction(row: TxRow): Transaction {
  return {
    id: row.id,
    date: row.date,
    merchant: row.merchant,
    category: row.category,
    amount: row.amount,
    type: row.type === 'income' ? 'income' : 'expense',
    account: row.account,
    tags: parseTags(row.tags),
    receipt: row.receipt === 1,
    source: (row.source as Transaction['source']) ?? 'manual',
    fingerprint: row.fingerprint,
    createdAt: row.createdAt,
  };
}

/** Newest first, capped at 5000 (spec §4.3). Never returns file bytes. */
export async function readTransactions(db: D1Database): Promise<Transaction[]> {
  const { results } = await db
    .prepare(
      `SELECT ${TX_COLUMNS} FROM transactions ORDER BY date DESC, createdAt DESC LIMIT 5000`,
    )
    .all<TxRow>();
  return (results ?? []).map(rowToTransaction);
}

export async function readTags(db: D1Database): Promise<Tag[]> {
  const { results } = await db
    .prepare('SELECT name, createdAt FROM tags ORDER BY name COLLATE NOCASE ASC')
    .all<Tag>();
  return results ?? [];
}

interface RuleRow {
  id: string;
  whenText: string;
  thenText: string;
  enabled: number;
  createdAt: string;
}

export async function readRules(db: D1Database): Promise<Rule[]> {
  const { results } = await db
    .prepare('SELECT id, whenText, thenText, enabled, createdAt FROM rules ORDER BY createdAt ASC')
    .all<RuleRow>();
  return (results ?? []).map((r) => ({
    id: r.id,
    whenText: r.whenText,
    thenText: r.thenText,
    enabled: r.enabled === 1,
    createdAt: r.createdAt,
  }));
}

/** Enabled rules only, oldest first — later rules can layer tags on top (spec §4.4). */
export async function readEnabledRules(db: D1Database): Promise<Rule[]> {
  const rules = await readRules(db);
  return rules.filter((r) => r.enabled);
}

interface DocRow {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  objectKey: string;
  status: string;
  source: string;
  createdAt: string;
  pageCount: number | null;
}

function rowToDocument(row: DocRow): DocumentMeta {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    objectKey: row.objectKey,
    status: (row.status as DocumentMeta['status']) ?? 'review',
    source: (row.source as DocumentMeta['source']) ?? 'upload',
    createdAt: row.createdAt,
    // Pre-migration rows are NULL in D1; anything non-numeric stays null
    // (unknown), never a made-up count.
    pageCount: typeof row.pageCount === 'number' ? row.pageCount : null,
  };
}

/** Newest first, capped at 100 (spec §4.3). Metadata only — never bytes. */
export async function readDocuments(db: D1Database): Promise<DocumentMeta[]> {
  const { results } = await db
    .prepare(
      `SELECT id, filename, mimeType, size, objectKey, status, source, createdAt, pageCount
       FROM documents ORDER BY createdAt DESC LIMIT 100`,
    )
    .all<DocRow>();
  return (results ?? []).map(rowToDocument);
}
