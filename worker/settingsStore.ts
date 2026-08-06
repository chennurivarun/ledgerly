// Settings live one row per key in D1 (spec §4.1) and are decoded back into the
// frozen `Settings` shape for the client. Missing keys fall back to defaults.
import { defaultSettings, type Settings } from '../shared/types';

/** Internal settings keys that are NOT part of the client `Settings` payload. */
export const PROCESSED_FILE_IDS_KEY = 'processedFileIds';
export const MAX_PROCESSED_FILE_IDS = 5000;

interface SettingRow {
  key: string;
  value: string;
}

/**
 * A stored value only replaces its default when it still has the expected
 * shape — a corrupt row degrades to the default instead of breaking the UI.
 */
function shapeOk(value: unknown, fallback: unknown): boolean {
  if (Array.isArray(fallback)) return Array.isArray(value);
  if (fallback === null) return value === null || typeof value === 'string'; // driveResetAt
  if (typeof fallback === 'object') {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
  return typeof value === typeof fallback;
}

export async function readSettings(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<SettingRow>();
  const out = defaultSettings() as unknown as Record<string, unknown>;
  for (const row of results ?? []) {
    if (!(row.key in out)) continue; // internal keys stay out of the client payload
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      continue;
    }
    if (shapeOk(parsed, out[row.key])) out[row.key] = parsed;
  }
  return out as unknown as Settings;
}

/** Upsert only the given keys — unrelated settings are never touched (spec §4.5). */
export async function writeSettings(
  db: D1Database,
  entries: Record<string, unknown>,
): Promise<void> {
  const list = Object.entries(entries);
  if (list.length === 0) return;
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
  );
  await db.batch(list.map(([key, value]) => stmt.bind(key, JSON.stringify(value), now)));
}

export async function readProcessedFileIds(db: D1Database): Promise<string[]> {
  const row = await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .bind(PROCESSED_FILE_IDS_KEY)
    .first<{ value: string }>();
  if (!row) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string').slice(-MAX_PROCESSED_FILE_IDS);
  } catch {
    return [];
  }
}
