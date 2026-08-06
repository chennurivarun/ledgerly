// PUT /api/preferences — partial update: only the groups present in the body
// are touched, every other setting is left exactly as it was (spec §4.5).
import { CURRENCY_CODES } from '../shared/currencies';
import {
  PERIOD_OPTIONS,
  type AiProvider,
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
import { readRules, readTags } from './queries';
import {
  clearAiApiKey,
  readSettings,
  redactAiSecret,
  writeAiApiKey,
  writeSettings,
} from './settingsStore';
import { ApiFail, isIsoDate, isRecord, normalizeNames, uniqueStrings } from './util';

const PERIODS = new Set<string>(PERIOD_OPTIONS.map((p) => p.value));
const CADENCES = new Set<string>(['weekly', 'biweekly', 'monthly', 'quarterly', 'annual']);
const AI_PROVIDERS = new Set<string>(['off', 'workers-ai', 'anthropic']);

/**
 * What to do with the BYOK key this request. Kept separate from the settings
 * patch because the key never lives in the `Settings` payload — it is written
 * to (and deleted from) its own row.
 */
type KeyAction = { type: 'set'; value: string } | { type: 'clear' };

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
      throw new ApiFail(400, 'aiProvider must be off, workers-ai or anthropic.');
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

  // Tags and rules live in their own tables; everything else is a settings row.
  const tagList = 'tags' in body ? names(body.tags, 'tags') : null;
  const ruleList = 'rules' in body ? normalizeRules(body.rules) : null;

  await writeSettings(db, patch);
  if (keyAction?.type === 'set') await writeAiApiKey(db, keyAction.value);
  else if (keyAction?.type === 'clear') await clearAiApiKey(db);
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
