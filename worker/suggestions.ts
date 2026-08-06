// Correction-learning rule suggestions (VISION.md phase-2 item 1).
// Deterministic — no AI: repeated manual recategorizations of the same merchant
// become a suggested rule. The rules engine stays authoritative: coverage is
// always tested with the real applyRules, never a parallel matcher, and nothing
// writes a rule until the user accepts. Pure core + thin D1 wrappers.
import {
  NEEDS_REVIEW,
  RULE_SUGGESTION_THRESHOLD,
  type Rule,
  type RuleSuggestion,
} from '../shared/types';
import { applyRules, parseRule } from './rules';
import { isRecord } from './util';

/** Suggestions shown at once — the list is a nudge, not a backlog. */
export const MAX_RULE_SUGGESTIONS = 20;

/** Corrections scanned per compute, newest first — keeps /api/state bounded. */
export const CORRECTIONS_SCAN_LIMIT = 500;

/** Stable pair key — matches the frozen RuleSuggestion.id contract. */
export function suggestionKey(merchant: string, category: string): string {
  return `${merchant.toLowerCase().trim()}|${category}`;
}

/** One recorded manual recategorization, as stored in category_corrections. */
export interface CorrectionRow {
  merchant: string;
  category: string;
  createdAt: string; // ISO timestamp
}

export type SuggestionActionResult =
  | { ok: true; merchant: string; category: string }
  | { ok: false; error: string };

/** Boundary validation for RuleSuggestionActionInput. Pure — exported for tests. */
export function validateSuggestionAction(raw: unknown): SuggestionActionResult {
  if (!isRecord(raw)) return { ok: false, error: 'Send a JSON object with merchant and category.' };
  const merchant = typeof raw.merchant === 'string' ? raw.merchant.trim() : '';
  if (!merchant) return { ok: false, error: 'merchant is required.' };
  const category = typeof raw.category === 'string' ? raw.category.trim() : '';
  if (!category) return { ok: false, error: 'category is required.' };
  return { ok: true, merchant, category };
}

/**
 * True when the enabled rules already send this merchant to this category —
 * the one coverage check, shared by the suggestion filter and accept's
 * duplicate guard. applyRules skips disabled rules itself.
 */
export function ruleCoversPair(merchant: string, category: string, rules: Rule[]): boolean {
  return applyRules({ merchant, category: NEEDS_REVIEW, tags: [] }, rules).category === category;
}

/**
 * Canonical rule text for an accepted suggestion, or null when the pair cannot
 * survive the plain-language parser (e.g. a category containing "and", which
 * CLAUSE_SPLIT would cut in half). The round-trip through the real parseRule is
 * verified here so accept can never store a rule that would fire differently
 * than the suggestion promised — better an honest 400 than a silently-wrong rule.
 */
export function buildSuggestionRuleText(
  merchant: string,
  category: string,
): { whenText: string; thenText: string } | null {
  const whenText = `merchant contains "${merchant}"`;
  const thenText = `set category to ${category}`;
  const parsed = parseRule(whenText, thenText);
  if (
    !parsed ||
    parsed.contains !== merchant.trim().toLowerCase() ||
    parsed.category !== category ||
    parsed.tags.length > 0
  ) {
    return null;
  }
  return { whenText, thenText };
}

export interface SuggestionContext {
  /** All rules; disabled ones are ignored by the coverage check. */
  rules: Rule[];
  /** Keys the user asked never to see again. */
  dismissedKeys: ReadonlySet<string>;
  /** The managed category list — a deleted category kills its suggestions. */
  categories: readonly string[];
}

/**
 * Group corrections into suggestions. Pure — exported for tests. A pair needs
 * RULE_SUGGESTION_THRESHOLD agreeing corrections; pairs the engine already
 * covers, dismissed keys and deleted categories are excluded. Sorted by
 * evidence desc then recency desc, capped at MAX_RULE_SUGGESTIONS.
 */
export function computeRuleSuggestions(
  corrections: readonly CorrectionRow[],
  ctx: SuggestionContext,
): RuleSuggestion[] {
  interface Group {
    merchant: string;
    category: string;
    evidenceCount: number;
    lastSeen: string;
  }
  const groups = new Map<string, Group>();
  for (const row of corrections) {
    const merchant = row.merchant.trim();
    if (!merchant || !row.category) continue;
    const key = suggestionKey(row.merchant, row.category);
    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        merchant,
        category: row.category,
        evidenceCount: 1,
        lastSeen: row.createdAt,
      });
      continue;
    }
    group.evidenceCount += 1;
    // ISO timestamps order lexicographically; the display casing follows the
    // most recent correction.
    if (row.createdAt > group.lastSeen) {
      group.lastSeen = row.createdAt;
      group.merchant = merchant;
    }
  }

  const managed = new Set(ctx.categories);
  const out: RuleSuggestion[] = [];
  for (const [key, g] of groups) {
    if (g.evidenceCount < RULE_SUGGESTION_THRESHOLD) continue;
    if (ctx.dismissedKeys.has(key)) continue;
    if (!managed.has(g.category)) continue; // category deleted since the corrections
    if (ruleCoversPair(g.merchant, g.category, ctx.rules)) continue; // engine already agrees
    out.push({
      id: key,
      merchant: g.merchant,
      category: g.category,
      evidenceCount: g.evidenceCount,
      lastSeen: g.lastSeen,
    });
  }

  out.sort(
    (a, b) =>
      b.evidenceCount - a.evidenceCount ||
      (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0),
  );
  return out.slice(0, MAX_RULE_SUGGESTIONS);
}

// ---------------------------------------------------------------------------
// D1 wrappers
// ---------------------------------------------------------------------------

/** Record one manual recategorization. Only the PATCH path calls this. */
export async function recordCategoryCorrection(
  db: D1Database,
  merchant: string,
  category: string,
): Promise<void> {
  await db
    .prepare('INSERT INTO category_corrections (id, merchant, category, createdAt) VALUES (?, ?, ?, ?)')
    .bind(crypto.randomUUID(), merchant, category, new Date().toISOString())
    .run();
}

/**
 * Compute suggestions for /api/state. Takes the rules and categories the
 * caller already read, so the only extra work is two bounded reads.
 */
export async function readRuleSuggestions(
  db: D1Database,
  rules: Rule[],
  categories: readonly string[],
): Promise<RuleSuggestion[]> {
  const [corrections, dismissals] = await Promise.all([
    db
      .prepare(
        'SELECT merchant, category, createdAt FROM category_corrections ORDER BY createdAt DESC LIMIT ?',
      )
      .bind(CORRECTIONS_SCAN_LIMIT)
      .all<CorrectionRow>(),
    db.prepare('SELECT key FROM rule_suggestion_dismissals').all<{ key: string }>(),
  ]);
  return computeRuleSuggestions(corrections.results ?? [], {
    rules,
    dismissedKeys: new Set((dismissals.results ?? []).map((d) => d.key)),
    categories,
  });
}
