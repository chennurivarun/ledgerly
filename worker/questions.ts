// "Getting to know you" merchant questions (sprint 14). Deterministic — no
// AI: a merchant the user keeps paying while the app demonstrably does not
// understand it (every transaction 'Needs review', or the categories
// disagree) becomes ONE question on the Dashboard. Answering writes a
// permanent merchant profile and a real rule through the S5 accept path; the
// rules engine stays authoritative — coverage is always tested with the real
// applyRules, never a parallel matcher. Pure core + thin D1 wrappers,
// mirroring worker/suggestions.ts.
import { cleanBankDescriptor } from '../shared/descriptors';
import {
  NEEDS_REVIEW,
  type MerchantAnswerInput,
  type MerchantKind,
  type MerchantQuestion,
  type Rule,
} from '../shared/types';
import { readRules } from './queries';
import { applyRules } from './rules';
import { buildSuggestionRuleText, ruleCoversPair } from './suggestions';
import { ApiFail, isRecord } from './util';

/** Questions offered at once — the queue is a drip, never a wall. */
export const MAX_MERCHANT_QUESTIONS = 3;

/** Transactions a merchant needs before it is worth a question. */
export const MERCHANT_QUESTION_THRESHOLD = 3;

/**
 * The one grouping key: the same display cleanup statement proposals use
 * (shared/descriptors.ts), lowercased so casing variants collapse. Applied to
 * RAW stored merchants when grouping and to the (already-clean) display
 * merchant when answering/dismissing — cleanBankDescriptor leaves a cleaned
 * name alone, so both sides land on the same key.
 */
export function normalizeQuestionMerchant(raw: string): string {
  return cleanBankDescriptor(raw).toLowerCase();
}

/**
 * Words that mark a descriptor as a business name. Enumerable and tested —
 * the heuristic only ever suggests, so a miss costs one toggle click.
 */
export const BUSINESS_TOKENS = new Set([
  'ltd',
  'limited',
  'pvt',
  'private',
  'store',
  'mart',
  'services',
  'technologies',
  'bank',
  'corp',
  'inc',
  'retail',
  'payments',
]);

/**
 * 'person' when the display merchant reads like a personal name: 1–3
 * Title-Case words ("Ravi Kumar") with no business token among them.
 * Anything else — all-caps acronyms ("KFC"), mixed-case brands ("PhonePe"),
 * business tokens ("Swiggy Limited") — returns null (no opinion). This is a
 * HINT for the UI's default toggle only; nothing is stored without the
 * user's explicit answer.
 */
export function suggestPersonKind(display: string): MerchantKind | null {
  const words = display.trim().split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 3) return null;
  for (const word of words) {
    if (BUSINESS_TOKENS.has(word.toLowerCase())) return null;
    if (!/^\p{Lu}\p{Ll}+$/u.test(word)) return null;
  }
  return 'person';
}

/**
 * True when the enabled rules already assign ANY category to this merchant —
 * judged by the real applyRules (anti-fork rule; suggestions' ruleCoversPair
 * asks the category-exact version of the same question).
 */
export function ruleHandlesMerchant(merchant: string, rules: Rule[]): boolean {
  return applyRules({ merchant, category: NEEDS_REVIEW, tags: [] }, rules).category !== NEEDS_REVIEW;
}

/** The transaction fields the sourcing needs; Transaction satisfies this. */
export interface QuestionTx {
  merchant: string;
  category: string;
  amount: number;
  date: string;
  createdAt: string;
}

export interface MerchantQuestionContext {
  /** All rules; disabled ones are ignored by the coverage check. */
  rules: Rule[];
  /** Merchants the user already answered (merchant_profiles keys). */
  profiledKeys: ReadonlySet<string>;
  /** Merchants the user asked never to be asked about again. */
  dismissedKeys: ReadonlySet<string>;
}

/**
 * Group the capped transactions read into questions. Pure — exported for
 * tests. A merchant qualifies when it has >= MERCHANT_QUESTION_THRESHOLD
 * transactions AND the app demonstrably does not understand it (every one
 * 'Needs review', or the categories disagree). Profiled, dismissed and
 * rule-covered merchants are excluded. Ranked by txCount desc then total
 * desc, capped at MAX_MERCHANT_QUESTIONS.
 */
export function computeMerchantQuestions(
  transactions: readonly QuestionTx[],
  ctx: MerchantQuestionContext,
): MerchantQuestion[] {
  interface Group {
    display: string;
    txCount: number;
    total: number;
    mostRecent: string; // date of the newest tx
    newestStamp: string; // `${date}|${createdAt}` — display follows the newest
    categories: Set<string>;
  }
  const groups = new Map<string, Group>();
  for (const tx of transactions) {
    const display = cleanBankDescriptor(tx.merchant);
    if (!display) continue;
    const key = display.toLowerCase();
    const stamp = `${tx.date}|${tx.createdAt}`;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        display,
        txCount: 1,
        total: tx.amount,
        mostRecent: tx.date,
        newestStamp: stamp,
        categories: new Set([tx.category]),
      });
      continue;
    }
    group.txCount += 1;
    group.total += tx.amount;
    group.categories.add(tx.category);
    if (tx.date > group.mostRecent) group.mostRecent = tx.date;
    if (stamp > group.newestStamp) {
      group.newestStamp = stamp;
      group.display = display;
    }
  }

  const out: MerchantQuestion[] = [];
  for (const [key, g] of groups) {
    if (g.txCount < MERCHANT_QUESTION_THRESHOLD) continue;
    // The app understands this merchant only if every transaction agrees on
    // one real category. All-'Needs review' or disagreeing categories = ask.
    const allNeedsReview = g.categories.size === 1 && g.categories.has(NEEDS_REVIEW);
    const inconsistent = g.categories.size > 1;
    if (!allNeedsReview && !inconsistent) continue;
    if (ctx.profiledKeys.has(key)) continue; // already answered
    if (ctx.dismissedKeys.has(key)) continue; // asked not to ask
    if (ruleHandlesMerchant(g.display, ctx.rules)) continue; // engine already knows
    out.push({
      id: key,
      merchant: g.display,
      txCount: g.txCount,
      total: Math.round(g.total * 100) / 100, // amounts are 2dp; drop float dust
      mostRecent: g.mostRecent,
      suggestedKind: suggestPersonKind(g.display),
    });
  }

  out.sort(
    (a, b) =>
      b.txCount - a.txCount ||
      b.total - a.total ||
      (a.mostRecent < b.mostRecent ? 1 : a.mostRecent > b.mostRecent ? -1 : 0) ||
      a.id.localeCompare(b.id),
  );
  return out.slice(0, MAX_MERCHANT_QUESTIONS);
}

// ---------------------------------------------------------------------------
// Answer validation
// ---------------------------------------------------------------------------

export type MerchantAnswerResult =
  | { ok: true; value: Required<Omit<MerchantAnswerInput, 'kind'>> & { kind: MerchantKind | null } }
  | { ok: false; error: string };

/** Boundary validation for MerchantAnswerInput. Pure — exported for tests.
 * label defaults to the display merchant; kind may honestly be null. */
export function validateMerchantAnswer(raw: unknown): MerchantAnswerResult {
  if (!isRecord(raw)) return { ok: false, error: 'Send a JSON object with merchant and category.' };
  const merchant = typeof raw.merchant === 'string' ? raw.merchant.trim() : '';
  if (!merchant) return { ok: false, error: 'merchant is required.' };
  const category = typeof raw.category === 'string' ? raw.category.trim() : '';
  if (!category) return { ok: false, error: 'category is required.' };
  const kind = raw.kind === 'person' || raw.kind === 'business' ? raw.kind : null;
  if (raw.kind !== undefined && raw.kind !== null && kind === null) {
    return { ok: false, error: "kind must be 'person', 'business' or null." };
  }
  const label = (typeof raw.label === 'string' ? raw.label.trim() : '') || merchant;
  if (raw.applyToExisting !== undefined && typeof raw.applyToExisting !== 'boolean') {
    return { ok: false, error: 'applyToExisting must be true or false.' };
  }
  return {
    ok: true,
    value: { merchant, kind, label, category, applyToExisting: raw.applyToExisting === true },
  };
}

// ---------------------------------------------------------------------------
// D1 wrappers
// ---------------------------------------------------------------------------

/**
 * Compute questions for /api/state. Takes the transactions and rules the
 * caller already read; its own reads are two bounded key lists.
 */
export async function readMerchantQuestions(
  db: D1Database,
  transactions: readonly QuestionTx[],
  rules: Rule[],
): Promise<MerchantQuestion[]> {
  const [profiles, dismissals] = await Promise.all([
    db.prepare('SELECT normalizedMerchant FROM merchant_profiles').all<{ normalizedMerchant: string }>(),
    db
      .prepare('SELECT normalizedMerchant FROM merchant_question_dismissals')
      .all<{ normalizedMerchant: string }>(),
  ]);
  return computeMerchantQuestions(transactions, {
    rules,
    profiledKeys: new Set((profiles.results ?? []).map((r) => r.normalizedMerchant)),
    dismissedKeys: new Set((dismissals.results ?? []).map((r) => r.normalizedMerchant)),
  });
}

/**
 * Answer a question: store the merchant profile, create the rule through the
 * S5 accept path (buildSuggestionRuleText round-trips through the REAL
 * parseRule — honest 400 when the pair can't survive it), and optionally
 * recategorize this merchant's existing 'Needs review' transactions.
 *
 * The bulk update deliberately does NOT record category_corrections: an
 * answer is the user teaching the app in one stroke, not a correction
 * pattern to be re-learned from — recording it would double-count the same
 * signal into the S5 suggestion engine.
 */
export async function answerMerchantQuestion(
  db: D1Database,
  raw: unknown,
): Promise<{ rules: Rule[]; recategorized: number }> {
  const validated = validateMerchantAnswer(raw);
  if (!validated.ok) throw new ApiFail(400, validated.error);
  const { merchant, kind, label, category, applyToExisting } = validated.value;
  const normalized = normalizeQuestionMerchant(merchant);

  // Same idempotency as S5 accept: when an enabled rule already sends this
  // merchant to this category, answering again creates no duplicate rule.
  if (!ruleCoversPair(merchant, category, await readRules(db))) {
    const text = buildSuggestionRuleText(merchant, category);
    if (!text) {
      throw new ApiFail(
        400,
        'This merchant and category cannot be turned into a rule automatically. Create the rule yourself on the Rules page.',
      );
    }
    await db
      .prepare('INSERT INTO rules (id, whenText, thenText, enabled, createdAt) VALUES (?, ?, ?, 1, ?)')
      .bind(crypto.randomUUID(), text.whenText, text.thenText, new Date().toISOString())
      .run();
  }

  // The permanent profile — what makes this merchant never be asked again.
  // Upsert so a repeated answer refines rather than errors.
  await db
    .prepare(
      `INSERT INTO merchant_profiles (normalizedMerchant, label, kind, category, createdAt) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(normalizedMerchant) DO UPDATE SET label = excluded.label, kind = excluded.kind, category = excluded.category`,
    )
    .bind(normalized, label, kind, category, new Date().toISOString())
    .run();
  // Answering outranks an old dismissal of the same merchant (S5 precedent).
  await db
    .prepare('DELETE FROM merchant_question_dismissals WHERE normalizedMerchant = ?')
    .bind(normalized)
    .run();

  let recategorized = 0;
  if (applyToExisting) {
    // The grouping key needs cleanBankDescriptor, which SQL cannot express —
    // so match server-side and update by id list (parameterized, chunked).
    // Scope is 'Needs review' ONLY: grounded/user-picked categories are never
    // overwritten (spec §8.1.6).
    const { results } = await db
      .prepare('SELECT id, merchant FROM transactions WHERE category = ?')
      .bind(NEEDS_REVIEW)
      .all<{ id: string; merchant: string }>();
    const ids = (results ?? [])
      .filter((r) => normalizeQuestionMerchant(r.merchant) === normalized)
      .map((r) => r.id);
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const placeholders = chunk.map(() => '?').join(',');
      await db
        .prepare(`UPDATE transactions SET category = ? WHERE id IN (${placeholders})`)
        .bind(category, ...chunk)
        .run();
    }
    recategorized = ids.length;
  }

  return { rules: await readRules(db), recategorized };
}

/** Suppress a merchant's question forever (until an answer outranks it). */
export async function dismissMerchantQuestion(db: D1Database, raw: unknown): Promise<void> {
  const merchant =
    isRecord(raw) && typeof raw.merchant === 'string' ? raw.merchant.trim() : '';
  if (!merchant) throw new ApiFail(400, 'merchant is required.');
  await db
    .prepare(
      `INSERT INTO merchant_question_dismissals (normalizedMerchant, createdAt) VALUES (?, ?)
       ON CONFLICT(normalizedMerchant) DO UPDATE SET createdAt = excluded.createdAt`,
    )
    .bind(normalizeQuestionMerchant(merchant), new Date().toISOString())
    .run();
}
