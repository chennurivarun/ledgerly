// PUT /api/preferences — partial update: only the groups present in the body
// are touched, every other setting is left exactly as it was (spec §4.5).
import { CURRENCY_CODES } from '../shared/currencies';
import {
  PERIOD_OPTIONS,
  type AiProvider,
  type BriefingCadence,
  type Budget,
  type Cadence,
  type DriveSyncMeta,
  type Goal,
  type Period,
  type PreferencesResult,
  type RecurringItem,
  type Rule,
  type Settings,
  type Tag,
} from '../shared/types';
import { normalizeAllowedSenders } from './email/ingest';
import { readRules, readTags } from './queries';
import {
  clearAiApiKey,
  clearBriefingWhatsappToken,
  clearCustomApiKey,
  clearSarvamApiKey,
  readSettings,
  redactAiSecret,
  writeAiApiKey,
  writeBriefingWhatsappToken,
  writeCustomApiKey,
  writeSarvamApiKey,
  writeSettings,
} from './settingsStore';
import { ApiFail, isIsoDate, isRecord, normalizeNames, uniqueStrings } from './util';

const PERIODS = new Set<string>(PERIOD_OPTIONS.map((p) => p.value));
const CADENCES = new Set<string>(['weekly', 'biweekly', 'monthly', 'quarterly', 'annual']);
const AI_PROVIDERS = new Set<string>(['off', 'workers-ai', 'anthropic', 'sarvam', 'custom']);
const BRIEFING_CADENCES = new Set<string>(['daily', 'weekly']);

/**
 * The WhatsApp Cloud API addresses recipients as E.164 digits WITHOUT the
 * leading '+' (e.g. '15551234567'). Empty clears the recipient. Exported pure
 * so the validation decisions are testable without a DB.
 */
export function normalizeBriefingRecipient(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : null;
  if (value === null || (value !== '' && !/^\d{6,15}$/.test(value))) {
    throw new ApiFail(
      400,
      'briefingWhatsappRecipient must be 6-15 digits (country code first, no +), or empty to clear it.',
    );
  }
  return value;
}

/** The Meta app's phone number ID — an opaque numeric id, or empty to clear. */
export function normalizeBriefingPhoneNumberId(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : null;
  if (value === null || (value !== '' && !/^\d+$/.test(value))) {
    throw new ApiFail(400, 'briefingWhatsappPhoneNumberId must be digits only, or empty to clear it.');
  }
  return value;
}

/**
 * What to do with the BYOK key this request. Kept separate from the settings
 * patch because the key never lives in the `Settings` payload — it is written
 * to (and deleted from) its own row.
 */
type KeyAction = { type: 'set'; value: string } | { type: 'clear' };

/**
 * Display-only ceiling on the user-entered Sarvam per-page rate. The value is
 * never charged by us — it only feeds the preflight estimate — so validation
 * is about catching typos (a negative rate, a fat-fingered 1e9), not billing.
 */
export const MAX_SARVAM_PRICE_PER_PAGE = 10000;

/**
 * The user's own per-page price off dashboard.sarvam.ai, or null to show no
 * estimate at all — a guessed price would be a made-up number wearing a
 * currency sign. Exported pure so the validation decisions are testable
 * without a DB.
 */
export function normalizeSarvamPrice(raw: unknown): number | null {
  if (raw === null) return null;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > MAX_SARVAM_PRICE_PER_PAGE) {
    throw new ApiFail(
      400,
      `sarvamPricePerPage must be a positive number up to ${MAX_SARVAM_PRICE_PER_PAGE}, or null to show no estimate.`,
    );
  }
  // Not rounded to cents: per-page rates are legitimately sub-cent (₹0.015);
  // the preflight rounds the final pages × price estimate instead.
  return n;
}

/**
 * Hostnames a plain-http custom endpoint is allowed on. The pairing is for
 * LOCAL DEV ONLY (a keyless Ollama at http://localhost:11434/v1 next to
 * `npm run dev`): a DEPLOYED worker runs on Cloudflare's edge and cannot
 * reach the user's localhost at all, so this loophole never sends anything
 * over plain http across a real network. Everything remote must be https.
 */
const HTTP_OK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The custom endpoint's base URL — the one piece of configuration that IS the
 * provider (sprint 15). '' clears it. Anything else must be a URL the worker
 * could actually call: https (or http on localhost, see above), no embedded
 * credentials (keys travel in the Authorization header, never in the URL —
 * a URL is quoted in too many places to hold a secret), no query or fragment
 * (the client appends `/chat/completions`; a query string would end up in the
 * middle of the path). Stored normalized with trailing slashes stripped so
 * the client can always append its path with a single '/'.
 * Exported pure so the validation decisions are testable without a DB.
 */
export function normalizeCustomBaseUrl(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : null;
  if (value === null) {
    throw new ApiFail(
      400,
      'customBaseUrl must be a URL like https://integrate.api.nvidia.com/v1, or empty to clear it.',
    );
  }
  if (value === '') return '';

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiFail(
      400,
      'customBaseUrl must be a full URL like https://integrate.api.nvidia.com/v1.',
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ApiFail(400, 'customBaseUrl must start with https:// (or http:// for localhost).');
  }
  if (url.protocol === 'http:' && !HTTP_OK_HOSTNAMES.has(url.hostname)) {
    throw new ApiFail(
      400,
      'customBaseUrl must use https — plain http is allowed only for localhost (local dev).',
    );
  }
  if (url.username || url.password) {
    throw new ApiFail(
      400,
      'customBaseUrl must not embed credentials — save the API key in its own field instead.',
    );
  }
  if (url.search || url.hash) {
    throw new ApiFail(400, 'customBaseUrl must not have a query string or fragment.');
  }
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/**
 * The single place a `PreferencesResult` is assembled. Routing every response
 * through here means the redaction is a property of the endpoint, not of one
 * lucky call site.
 */
export function buildPreferencesResult(
  settings: Settings,
  tags: Tag[],
  rules: Rule[],
): PreferencesResult {
  return { ok: true, settings: redactAiSecret(settings), tags, rules };
}

function names(raw: unknown, label: string): string[] {
  const list = normalizeNames(raw);
  if (list === null) throw new ApiFail(400, `${label} must be a list of names.`);
  return list;
}

function requiredText(raw: unknown, label: string): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) throw new ApiFail(400, `${label} is required.`);
  return value;
}

function optionalText(raw: unknown): string | undefined {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value || undefined;
}

function amount(raw: unknown, label: string): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 0) throw new ApiFail(400, `${label} must be a number of 0 or more.`);
  return Math.round(n * 100) / 100;
}

function items(raw: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(raw)) throw new ApiFail(400, `${label} must be a list.`);
  return raw.map((item, i) => {
    if (!isRecord(item)) throw new ApiFail(400, `${label}[${i}] must be an object.`);
    return item;
  });
}

function id(raw: unknown): string {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : crypto.randomUUID();
}

function isoDate(raw: unknown, label: string): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!isIsoDate(value)) throw new ApiFail(400, `${label} must be a YYYY-MM-DD date.`);
  return value;
}

function normalizeGoals(raw: unknown): Goal[] {
  return items(raw, 'goals').map((g, i) => ({
    id: id(g.id),
    name: requiredText(g.name, `goals[${i}].name`),
    target: amount(g.target, `goals[${i}].target`),
    current: amount(g.current ?? 0, `goals[${i}].current`),
    dueDate: optionalText(g.dueDate),
    note: optionalText(g.note),
  }));
}

function normalizeBudgets(raw: unknown): Budget[] {
  return items(raw, 'budgets').map((b, i) => ({
    id: id(b.id),
    category: requiredText(b.category, `budgets[${i}].category`),
    limit: amount(b.limit, `budgets[${i}].limit`),
    active: b.active !== false,
  }));
}

function normalizeRecurring(raw: unknown, label: string): RecurringItem[] {
  return items(raw, label).map((r, i) => {
    const cadence = typeof r.cadence === 'string' ? r.cadence : '';
    if (!CADENCES.has(cadence)) {
      throw new ApiFail(400, `${label}[${i}].cadence must be weekly, biweekly, monthly, quarterly or annual.`);
    }
    return {
      id: id(r.id),
      name: requiredText(r.name, `${label}[${i}].name`),
      category: requiredText(r.category, `${label}[${i}].category`),
      amount: amount(r.amount, `${label}[${i}].amount`),
      cadence: cadence as Cadence,
      nextDate: isoDate(r.nextDate, `${label}[${i}].nextDate`),
      account: optionalText(r.account),
      active: r.active !== false,
    };
  });
}

function normalizeRules(raw: unknown): Rule[] {
  const now = new Date().toISOString();
  return items(raw, 'rules').map((r, i) => ({
    id: id(r.id),
    whenText: requiredText(r.whenText, `rules[${i}].whenText`),
    thenText: requiredText(r.thenText, `rules[${i}].thenText`),
    enabled: r.enabled !== false,
    createdAt: typeof r.createdAt === 'string' && r.createdAt ? r.createdAt : now,
  }));
}

/** Only known Drive fields are merged in; unrelated Drive metadata survives. */
function mergeDrive(raw: unknown, current: DriveSyncMeta): DriveSyncMeta {
  if (!isRecord(raw)) throw new ApiFail(400, 'drive must be an object.');
  const next: DriveSyncMeta = { ...current };
  if ('folderName' in raw) next.folderName = optionalText(raw.folderName);
  if ('folderUrl' in raw) next.folderUrl = optionalText(raw.folderUrl);
  if ('timezone' in raw) next.timezone = optionalText(raw.timezone);
  return next;
}

/** Tags are a full replacement list: new names are added, removed ones deleted. */
async function syncTags(db: D1Database, wanted: string[]): Promise<void> {
  const { results } = await db.prepare('SELECT name FROM tags').all<{ name: string }>();
  const existing = (results ?? []).map((r) => r.name);
  const wantedKeys = new Set(wanted.map((t) => t.toLowerCase()));
  const existingKeys = new Set(existing.map((t) => t.toLowerCase()));
  const now = new Date().toISOString();

  const statements: D1PreparedStatement[] = [];
  const del = db.prepare('DELETE FROM tags WHERE name = ?');
  for (const name of existing) {
    if (!wantedKeys.has(name.toLowerCase())) statements.push(del.bind(name));
  }
  const add = db.prepare('INSERT OR IGNORE INTO tags (name, createdAt) VALUES (?, ?)');
  for (const name of wanted) {
    if (!existingKeys.has(name.toLowerCase())) statements.push(add.bind(name, now));
  }
  if (statements.length > 0) await db.batch(statements);
}

/** Rules are a full replacement of the table. */
async function replaceRules(db: D1Database, rules: Rule[]): Promise<void> {
  const insert = db.prepare(
    'INSERT INTO rules (id, whenText, thenText, enabled, createdAt) VALUES (?, ?, ?, ?, ?)',
  );
  const statements: D1PreparedStatement[] = [db.prepare('DELETE FROM rules')];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) continue; // a duplicated id would abort the batch
    seen.add(rule.id);
    statements.push(
      insert.bind(rule.id, rule.whenText, rule.thenText, rule.enabled ? 1 : 0, rule.createdAt),
    );
  }
  await db.batch(statements);
}

export async function applyPreferences(db: D1Database, body: unknown): Promise<PreferencesResult> {
  if (!isRecord(body)) throw new ApiFail(400, 'Send a JSON object of preferences to update.');

  const current = await readSettings(db);
  const patch: Record<string, unknown> = {};

  if ('categories' in body) patch.categories = names(body.categories, 'categories');
  if ('accounts' in body) patch.accounts = names(body.accounts, 'accounts');
  if ('goals' in body) patch.goals = normalizeGoals(body.goals);
  if ('budgets' in body) patch.budgets = normalizeBudgets(body.budgets);
  if ('subscriptions' in body) {
    patch.subscriptions = normalizeRecurring(body.subscriptions, 'subscriptions');
  }
  if ('recurring' in body) patch.recurring = normalizeRecurring(body.recurring, 'recurring');
  if ('dismissedPatterns' in body) {
    const list = uniqueStrings(body.dismissedPatterns);
    if (list === null) throw new ApiFail(400, 'dismissedPatterns must be a list of keys.');
    patch.dismissedPatterns = list;
  }
  if ('assetsTotal' in body) patch.assetsTotal = amount(body.assetsTotal, 'assetsTotal');
  if ('liabilitiesTotal' in body) {
    patch.liabilitiesTotal = amount(body.liabilitiesTotal, 'liabilitiesTotal');
  }
  if ('netWorthConfigured' in body) {
    if (typeof body.netWorthConfigured !== 'boolean') {
      throw new ApiFail(400, 'netWorthConfigured must be true or false.');
    }
    patch.netWorthConfigured = body.netWorthConfigured;
  }
  if ('selectedPeriod' in body) {
    const period = typeof body.selectedPeriod === 'string' ? body.selectedPeriod : '';
    if (!PERIODS.has(period)) throw new ApiFail(400, 'selectedPeriod is not a supported period.');
    patch.selectedPeriod = period as Period;
  }
  if ('currency' in body) {
    const code = typeof body.currency === 'string' ? body.currency : '';
    if (!CURRENCY_CODES.has(code)) {
      throw new ApiFail(400, 'currency must be a supported ISO 4217 currency code.');
    }
    patch.currency = code;
  }
  if ('onboarded' in body) {
    if (typeof body.onboarded !== 'boolean') {
      throw new ApiFail(400, 'onboarded must be true or false.');
    }
    patch.onboarded = body.onboarded;
  }
  if ('drive' in body) patch.drive = mergeDrive(body.drive, current.drive ?? {});

  if ('aiProvider' in body) {
    const provider = typeof body.aiProvider === 'string' ? body.aiProvider : '';
    if (!AI_PROVIDERS.has(provider)) {
      throw new ApiFail(400, 'aiProvider must be off, workers-ai, anthropic, sarvam or custom.');
    }
    patch.aiProvider = provider as AiProvider;
  }
  if ('aiModel' in body) {
    if (body.aiModel === null) patch.aiModel = null;
    else if (typeof body.aiModel === 'string') patch.aiModel = body.aiModel.trim() || null;
    else throw new ApiFail(400, 'aiModel must be a model id, or null for the provider default.');
  }

  // Write-only: validated here, written after the patch, and never read back
  // into the response. The value is never quoted in an error message.
  let keyAction: KeyAction | null = null;
  if ('aiApiKey' in body) {
    if (body.aiApiKey === null) keyAction = { type: 'clear' };
    else if (typeof body.aiApiKey === 'string' && body.aiApiKey.trim()) {
      keyAction = { type: 'set', value: body.aiApiKey.trim() };
    } else {
      throw new ApiFail(400, 'aiApiKey must be a non-empty key, or null to remove the stored key.');
    }
  }

  // The Sarvam key mirrors aiApiKey exactly: write-only, own row, never
  // echoed, never quoted in an error message. `sarvamKeySet` is derived in
  // readSettings and simply ignored if a client echoes it back.
  let sarvamKeyAction: KeyAction | null = null;
  if ('sarvamApiKey' in body) {
    if (body.sarvamApiKey === null) sarvamKeyAction = { type: 'clear' };
    else if (typeof body.sarvamApiKey === 'string' && body.sarvamApiKey.trim()) {
      sarvamKeyAction = { type: 'set', value: body.sarvamApiKey.trim() };
    } else {
      throw new ApiFail(400, 'sarvamApiKey must be a non-empty key, or null to remove the stored key.');
    }
  }
  if ('sarvamPricePerPage' in body) {
    patch.sarvamPricePerPage = normalizeSarvamPrice(body.sarvamPricePerPage);
  }

  // The custom endpoint (sprint 15). The base URL is a plain setting, but
  // never stored raw — normalizeCustomBaseUrl decides what a callable URL is.
  // The key mirrors aiApiKey exactly (write-only, own row, never echoed,
  // never quoted in an error message), with one semantic difference read at
  // call time, not here: a stored key is OPTIONAL for this provider.
  if ('customBaseUrl' in body) {
    patch.customBaseUrl = normalizeCustomBaseUrl(body.customBaseUrl);
  }
  let customKeyAction: KeyAction | null = null;
  if ('customApiKey' in body) {
    if (body.customApiKey === null) customKeyAction = { type: 'clear' };
    else if (typeof body.customApiKey === 'string' && body.customApiKey.trim()) {
      customKeyAction = { type: 'set', value: body.customApiKey.trim() };
    } else {
      throw new ApiFail(400, 'customApiKey must be a non-empty key, or null to remove the stored key.');
    }
  }

  // Proactive briefings (sprint 7). `briefingWhatsappTokenSet` is derived in
  // readSettings and simply ignored if a client echoes it back.
  if ('briefingsEnabled' in body) {
    if (typeof body.briefingsEnabled !== 'boolean') {
      throw new ApiFail(400, 'briefingsEnabled must be true or false.');
    }
    patch.briefingsEnabled = body.briefingsEnabled;
  }
  if ('briefingCadence' in body) {
    const cadence = typeof body.briefingCadence === 'string' ? body.briefingCadence : '';
    if (!BRIEFING_CADENCES.has(cadence)) {
      throw new ApiFail(400, 'briefingCadence must be daily or weekly.');
    }
    patch.briefingCadence = cadence as BriefingCadence;
  }
  if ('briefingWhatsappRecipient' in body) {
    patch.briefingWhatsappRecipient = normalizeBriefingRecipient(body.briefingWhatsappRecipient);
  }
  if ('briefingWhatsappPhoneNumberId' in body) {
    patch.briefingWhatsappPhoneNumberId = normalizeBriefingPhoneNumberId(
      body.briefingWhatsappPhoneNumberId,
    );
  }
  // Server-stamped on successful delivery only — a client that could set or
  // clear it could spoof the cadence gate, so the field is rejected loudly
  // rather than silently dropped.
  if ('lastBriefingSentAt' in body) {
    throw new ApiFail(400, 'lastBriefingSentAt is set by the server and cannot be updated here.');
  }
  // The Cloud API token mirrors aiApiKey exactly: write-only, own row, never
  // echoed, never quoted in an error message.
  let briefingTokenAction: KeyAction | null = null;
  if ('briefingWhatsappToken' in body) {
    if (body.briefingWhatsappToken === null) briefingTokenAction = { type: 'clear' };
    else if (typeof body.briefingWhatsappToken === 'string' && body.briefingWhatsappToken.trim()) {
      briefingTokenAction = { type: 'set', value: body.briefingWhatsappToken.trim() };
    } else {
      throw new ApiFail(
        400,
        'briefingWhatsappToken must be a non-empty token, or null to remove the stored token.',
      );
    }
  }

  // The mail-in feed (sprint 8). Both fields are plain settings — the security
  // work happens at ingestion time (worker/email/ingest.ts), which re-reads
  // them on every message; disabled or empty-allowlist means nothing ingests.
  if ('emailFeedEnabled' in body) {
    if (typeof body.emailFeedEnabled !== 'boolean') {
      throw new ApiFail(400, 'emailFeedEnabled must be true or false.');
    }
    patch.emailFeedEnabled = body.emailFeedEnabled;
  }
  if ('emailAllowedSenders' in body) {
    patch.emailAllowedSenders = normalizeAllowedSenders(body.emailAllowedSenders);
  }

  // Tags and rules live in their own tables; everything else is a settings row.
  const tagList = 'tags' in body ? names(body.tags, 'tags') : null;
  const ruleList = 'rules' in body ? normalizeRules(body.rules) : null;

  await writeSettings(db, patch);
  if (keyAction?.type === 'set') await writeAiApiKey(db, keyAction.value);
  else if (keyAction?.type === 'clear') await clearAiApiKey(db);
  if (sarvamKeyAction?.type === 'set') await writeSarvamApiKey(db, sarvamKeyAction.value);
  else if (sarvamKeyAction?.type === 'clear') await clearSarvamApiKey(db);
  if (customKeyAction?.type === 'set') await writeCustomApiKey(db, customKeyAction.value);
  else if (customKeyAction?.type === 'clear') await clearCustomApiKey(db);
  if (briefingTokenAction?.type === 'set') {
    await writeBriefingWhatsappToken(db, briefingTokenAction.value);
  } else if (briefingTokenAction?.type === 'clear') {
    await clearBriefingWhatsappToken(db);
  }
  if (tagList) await syncTags(db, tagList);
  if (ruleList) await replaceRules(db, ruleList);

  const [settings, tags, rules] = await Promise.all([
    readSettings(db),
    readTags(db),
    readRules(db),
  ]);
  // `settings.aiKeySet` is derived inside readSettings from the row just
  // written or deleted, so it is true exactly when a key is stored.
  return buildPreferencesResult(settings, tags, rules);
}
