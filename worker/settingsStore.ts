// Settings live one row per key in D1 (spec §4.1) and are decoded back into the
// frozen `Settings` shape for the client. Missing keys fall back to defaults.
import { defaultSettings, type Settings } from '../shared/types';

/** Internal settings keys that are NOT part of the client `Settings` payload. */
export const PROCESSED_FILE_IDS_KEY = 'processedFileIds';
export const MAX_PROCESSED_FILE_IDS = 5000;

/**
 * Where the BYOK API key is stored. Deliberately NOT a key in
 * `defaultSettings()`: `readSettings` copies a stored row into the payload only
 * when its key already exists on the defaults object, so a key parked here can
 * never be echoed by /api/state or /api/preferences, no matter what a future
 * caller does. `Settings.aiKeySet` is derived from its presence instead.
 */
export const AI_KEY_SECRET_KEY = 'aiApiKeySecret';

/**
 * Where the WhatsApp Cloud API access token is stored. Same containment as
 * the BYOK key above: NOT a `defaultSettings()` key, so `readSettings` can
 * never copy it into a payload; `Settings.briefingWhatsappTokenSet` is
 * derived from its presence instead.
 */
export const BRIEFING_TOKEN_SECRET_KEY = 'briefingWhatsappTokenSecret';

/**
 * Where the Sarvam API key is stored. Same containment as the BYOK key
 * above: NOT a `defaultSettings()` key, so `readSettings` can never copy it
 * into a payload; `Settings.sarvamKeySet` is derived from its presence
 * instead.
 */
export const SARVAM_KEY_SECRET_KEY = 'sarvamApiKeySecret';

/**
 * Where the custom-endpoint API key is stored (sprint 15). Same containment
 * as the BYOK key above: NOT a `defaultSettings()` key, so `readSettings` can
 * never copy it into a payload; `Settings.customKeySet` is derived from its
 * presence instead. Unlike the other secrets this one is optional even when
 * its provider is active — keyless servers (local Ollama) need none.
 */
export const CUSTOM_KEY_SECRET_KEY = 'customApiKeySecret';

/** Every write-only settings row. Grows here, and ONLY here, per secret. */
const SECRET_KEYS = [
  AI_KEY_SECRET_KEY,
  BRIEFING_TOKEN_SECRET_KEY,
  SARVAM_KEY_SECRET_KEY,
  CUSTOM_KEY_SECRET_KEY,
] as const;

interface SettingRow {
  key: string;
  value: string;
}

/**
 * Settings keys whose value is `number | null`. Their default (null) hides
 * the numeric half from the generic fallback check below, so they are named
 * here instead of silently degrading every stored number to null.
 */
const NULLABLE_NUMBER_KEYS = new Set(['sarvamPricePerPage']);

/**
 * A stored value only replaces its default when it still has the expected
 * shape — a corrupt row degrades to the default instead of breaking the UI.
 */
function shapeOk(key: string, value: unknown, fallback: unknown): boolean {
  if (NULLABLE_NUMBER_KEYS.has(key)) return value === null || typeof value === 'number';
  if (Array.isArray(fallback)) return Array.isArray(value);
  if (fallback === null) return value === null || typeof value === 'string'; // driveResetAt
  if (typeof fallback === 'object') {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
  return typeof value === typeof fallback;
}

/** A stored secret is only a secret while it is a non-empty string. */
function decodeSecret(rawValue: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return null;
  }
  if (typeof parsed !== 'string') return null;
  const trimmed = parsed.trim();
  return trimmed || null;
}

export async function readSettings(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<SettingRow>();
  const out = defaultSettings() as unknown as Record<string, unknown>;
  let keyStored = false;
  let briefingTokenStored = false;
  let sarvamKeyStored = false;
  let customKeyStored = false;
  for (const row of results ?? []) {
    // Secrets are the rows we read but never copy: only the boolean
    // "is there one" escapes this loop.
    if (row.key === AI_KEY_SECRET_KEY) {
      keyStored = decodeSecret(row.value) !== null;
      continue;
    }
    if (row.key === BRIEFING_TOKEN_SECRET_KEY) {
      briefingTokenStored = decodeSecret(row.value) !== null;
      continue;
    }
    if (row.key === SARVAM_KEY_SECRET_KEY) {
      sarvamKeyStored = decodeSecret(row.value) !== null;
      continue;
    }
    if (row.key === CUSTOM_KEY_SECRET_KEY) {
      customKeyStored = decodeSecret(row.value) !== null;
      continue;
    }
    if (!(row.key in out)) continue; // internal keys stay out of the client payload
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      continue;
    }
    if (shapeOk(row.key, parsed, out[row.key])) out[row.key] = parsed;
  }
  // Always derived, never read from their own rows — a stored `aiKeySet`,
  // `briefingWhatsappTokenSet` or `sarvamKeySet` could drift out of step with
  // the actual secret, and these flags gate the UI's "saved" state.
  out.aiKeySet = keyStored;
  out.briefingWhatsappTokenSet = briefingTokenStored;
  out.sarvamKeySet = sarvamKeyStored;
  out.customKeySet = customKeyStored;
  return out as unknown as Settings;
}

/**
 * Last line of defence before settings are serialized. `readSettings` already
 * cannot emit a secret; this makes that a property of the response builder
 * too, so adding a secret key to `defaultSettings()` some day would not
 * silently start leaking it. Covers EVERY key in SECRET_KEYS — the name
 * predates the second secret and stays for call-site stability.
 */
export function redactAiSecret(settings: Settings): Settings {
  const copy: Record<string, unknown> = { ...(settings as unknown as Record<string, unknown>) };
  for (const key of SECRET_KEYS) delete copy[key];
  return copy as unknown as Settings;
}

async function readSecret(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row ? decodeSecret(row.value) : null;
}

/** The plaintext BYOK key, or null when none is stored. Never leaves the worker. */
export async function readAiApiKey(db: D1Database): Promise<string | null> {
  return readSecret(db, AI_KEY_SECRET_KEY);
}

export async function writeAiApiKey(db: D1Database, key: string): Promise<void> {
  await writeSettings(db, { [AI_KEY_SECRET_KEY]: key });
}

/** Removing the row is what makes `aiKeySet` false again. */
export async function clearAiApiKey(db: D1Database): Promise<void> {
  await db.prepare('DELETE FROM settings WHERE key = ?').bind(AI_KEY_SECRET_KEY).run();
}

/** The plaintext Cloud API token, or null when none is stored. Never leaves the worker. */
export async function readBriefingWhatsappToken(db: D1Database): Promise<string | null> {
  return readSecret(db, BRIEFING_TOKEN_SECRET_KEY);
}

export async function writeBriefingWhatsappToken(db: D1Database, token: string): Promise<void> {
  await writeSettings(db, { [BRIEFING_TOKEN_SECRET_KEY]: token });
}

/** Removing the row is what makes `briefingWhatsappTokenSet` false again. */
export async function clearBriefingWhatsappToken(db: D1Database): Promise<void> {
  await db.prepare('DELETE FROM settings WHERE key = ?').bind(BRIEFING_TOKEN_SECRET_KEY).run();
}

/** The plaintext Sarvam key, or null when none is stored. Never leaves the worker. */
export async function readSarvamApiKey(db: D1Database): Promise<string | null> {
  return readSecret(db, SARVAM_KEY_SECRET_KEY);
}

export async function writeSarvamApiKey(db: D1Database, key: string): Promise<void> {
  await writeSettings(db, { [SARVAM_KEY_SECRET_KEY]: key });
}

/** Removing the row is what makes `sarvamKeySet` false again. */
export async function clearSarvamApiKey(db: D1Database): Promise<void> {
  await db.prepare('DELETE FROM settings WHERE key = ?').bind(SARVAM_KEY_SECRET_KEY).run();
}

/** The plaintext custom-endpoint key, or null when none is stored — which is
 * a VALID running state for this provider (keyless servers), not an error.
 * Never leaves the worker. */
export async function readCustomApiKey(db: D1Database): Promise<string | null> {
  return readSecret(db, CUSTOM_KEY_SECRET_KEY);
}

export async function writeCustomApiKey(db: D1Database, key: string): Promise<void> {
  await writeSettings(db, { [CUSTOM_KEY_SECRET_KEY]: key });
}

/** Removing the row is what makes `customKeySet` false again. */
export async function clearCustomApiKey(db: D1Database): Promise<void> {
  await db.prepare('DELETE FROM settings WHERE key = ?').bind(CUSTOM_KEY_SECRET_KEY).run();
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
