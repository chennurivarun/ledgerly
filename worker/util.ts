// Small shared helpers for the worker. Nothing here touches D1/R2.

/** Statuses the API returns for expected, user-facing failures. */
export type FailStatus = 400 | 401 | 404 | 413 | 500 | 503;

/**
 * An expected failure with a message safe to show the user.
 * index.ts turns this into `{ error }` JSON with the right status.
 */
export class ApiFail extends Error {
  readonly status: FailStatus;
  constructor(status: FailStatus, message: string) {
    super(message);
    this.name = 'ApiFail';
    this.status = status;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Trim, drop blanks, dedupe case-insensitively, keep first-seen casing.
 * Used for tags, categories and accounts alike (spec §4.4, §16.2).
 * Returns null when the input is not an array so callers can raise a 400.
 */
export function normalizeNames(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/** Exact (case-sensitive) dedupe — for opaque keys like dismissed patterns. */
export function uniqueStrings(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** R2 keys and Content-Disposition headers are built from user filenames — keep them boring. */
export function safeFilename(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  return cleaned.slice(0, 120) || 'file';
}

/** Keep error strings short: they are shown in the UI and stored in settings. */
export function clip(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** True only for a real calendar date in YYYY-MM-DD form. */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Constant-time string compare for the optional sync token. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
