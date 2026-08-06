// Plain-language categorization rules (spec §15.1). Pure + exported for tests.
//
// ponytail: best-effort parser. Ceiling — the only supported condition is a
// case-insensitive substring match on the merchant, and the only supported
// actions are "set the category" and "add a tag". No amount/date/account
// conditions, no regex, no AND/OR/NOT, no negation. Anything it cannot read is
// ignored rather than guessed, so an unparseable rule simply never fires.
import { NEEDS_REVIEW, type Rule } from '../shared/types';

export interface ParsedRule {
  /** Lowercased substring the merchant must contain. */
  contains: string;
  category: string | null;
  tags: string[];
}

const WHEN_PREFIX = /^\s*(?:when|if)\b\s*/i;
const FIELD_CONTAINS =
  /^(?:the\s+)?(?:merchant|description|payee|source|name|vendor|memo)\s+(?:name\s+)?(?:contains|includes|has|matches|is|starts with|equals)\s+(.+)$/i;
const BARE_CONTAINS = /^(?:contains|includes|matches|is|equals)\s+(.+)$/i;
const CATEGORY_CLAUSE =
  /^(?:set|use|change|make(?:\s+it)?|mark(?:\s+it)?|assign)?\s*(?:the\s+)?category(?:\s+to|\s*[:=])?\s+(.+)$/i;
const TAG_CLAUSE = /^(?:add|apply|append|attach|with)?\s*tags?(?:\s+to|\s*[:=])?\s+(.+)$/i;
const CLAUSE_SPLIT = /\s*(?:,|;|\+|\band\b|\bthen\b|\balso\b)\s*/i;

function unquote(raw: string): string {
  const trimmed = raw.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (trimmed.length >= 2 && first === last && (first === '"' || first === "'")) {
    return trimmed.slice(1, -1).trim();
  }
  if (trimmed.length >= 2 && first === '“' && last === '”') {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** The merchant substring a `whenText` asks for, or null when unreadable. */
export function parseWhen(whenText: string): string | null {
  const stripped = whenText.replace(WHEN_PREFIX, '').trim();
  if (!stripped) return null;
  const match = FIELD_CONTAINS.exec(stripped) ?? BARE_CONTAINS.exec(stripped);
  const value = unquote(match ? match[1] : stripped);
  return value ? value.toLowerCase() : null;
}

/** The category/tag actions a `thenText` asks for. */
export function parseThen(thenText: string): { category: string | null; tags: string[] } {
  let category: string | null = null;
  const tags: string[] = [];
  const clauses = thenText
    .trim()
    .replace(/^then\s+/i, '')
    .split(CLAUSE_SPLIT)
    .map((c) => c.trim())
    .filter(Boolean);

  let matchedAny = false;
  for (const clause of clauses) {
    const cat = CATEGORY_CLAUSE.exec(clause);
    if (cat) {
      const value = unquote(cat[1]);
      if (value) {
        category = value;
        matchedAny = true;
      }
      continue;
    }
    const tag = TAG_CLAUSE.exec(clause);
    if (tag) {
      const value = unquote(tag[1]);
      if (value && !tags.some((t) => t.toLowerCase() === value.toLowerCase())) tags.push(value);
      matchedAny = true;
    }
  }

  // Bare "then" text with no keywords reads as the target category ("Dining").
  if (!matchedAny && clauses.length === 1) {
    const value = unquote(clauses[0]);
    if (value) category = value;
  }
  return { category, tags };
}

export function parseRule(whenText: string, thenText: string): ParsedRule | null {
  const contains = parseWhen(whenText ?? '');
  if (!contains) return null;
  const { category, tags } = parseThen(thenText ?? '');
  if (!category && tags.length === 0) return null;
  return { contains, category, tags };
}

export interface RuleTarget {
  merchant: string;
  category: string;
  tags: string[];
}

/**
 * Apply enabled rules to a row that is about to be inserted (spec §4.4 — after
 * duplicate detection, never to historical rows).
 *
 * A rule fills in the category only when the row is still uncategorized
 * (`Needs review`): a grounded statement category or a category the user picked
 * in the entry form always wins (spec §8.1.6). Tags are always appended.
 */
export function applyRules(target: RuleTarget, rules: Rule[]): { category: string; tags: string[] } {
  const merchant = target.merchant.toLowerCase();
  let category = target.category;
  const tags = [...target.tags];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    const parsed = parseRule(rule.whenText, rule.thenText);
    if (!parsed || !merchant.includes(parsed.contains)) continue;
    if (parsed.category && (!category || category === NEEDS_REVIEW)) category = parsed.category;
    for (const tag of parsed.tags) {
      if (!tags.some((t) => t.toLowerCase() === tag.toLowerCase())) tags.push(tag);
    }
  }
  return { category, tags };
}
