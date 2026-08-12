// Pure helpers for the mail-in feed (sprint 8). Kept dependency-free from
// React so they're cheap to unit test (same split as ai/extractionHelpers.ts
// and settings/briefingHelpers.ts). The parser behind these items is
// deterministic — parsed fields are facts read off the email, so there is no
// confidence machinery here — but the never-guess principle still applies to
// everything the parser could NOT establish: an unparsed email seeds an
// EMPTY form, and nothing is ever invented on the user's behalf.
import {
  type InboxEmail,
  type InboxEmailStatus,
  type PreferencesUpdate,
  type Settings,
  type TxInput,
  type TxType,
} from '../../../shared/types';
import { amountCents, isRealDateISO, resolveCategorySuggestion } from '../ai/extractionHelpers';

/**
 * v1 shows only items still waiting on a decision. 'confirmed' and
 * 'dismissed' are hidden entirely — pinned here (not inline in the page) so
 * a later "history" ladder item changes exactly one list.
 */
export const VISIBLE_INBOX_STATUSES: InboxEmailStatus[] = ['proposed', 'unparsed'];

/** Items the inbox section renders: undecided only, newest-first (receivedAt
 * desc, createdAt then id as deterministic tie-breaks — same newest-first
 * idiom as store.sortTransactions). Never mutates the input. */
export function visibleInboxItems(items: InboxEmail[]): InboxEmail[] {
  return items
    .filter((i) => VISIBLE_INBOX_STATUSES.includes(i.status))
    .sort(
      (a, b) =>
        b.receivedAt.localeCompare(a.receivedAt) ||
        b.createdAt.localeCompare(a.createdAt) ||
        b.id.localeCompare(a.id),
    );
}

/** Count for the section header's "N to review" chip — proposals only
 * (unparsed items have nothing to review, only a manual path). */
export function proposedCount(items: InboxEmail[]): number {
  return items.filter((i) => i.status === 'proposed').length;
}

/** Local editable state for the confirm form, keyed-remounted per item id. */
export interface InboxDraft {
  date: string; // '' until filled — never invented
  merchant: string;
  amount: string; // numeric text; positive magnitude
  /** '' until the user picks one for an unparsed email. `type` flips the
   * sign of every downstream number, so it is NEVER defaulted (the sprint-4
   * never-guess pin) — a parsed proposal carries the parser's
   * deterministically-read type instead. */
  type: TxType | '';
  category: string; // 'Needs review' default when present, else '' (placeholder blocks)
  account: string;
}

/**
 * Seeds the confirm form. A parsed proposal prefills the facts the parser
 * read (date/merchant/amount/type); an unparsed email seeds every
 * transaction field EMPTY — the user fills everything, and the email itself
 * is the audit trail. The only defaults beyond the parse are the house
 * ones: category falls back to "Needs review" when that category exists
 * (self-labelling, so showing it is honest — S3 precedent) else '' so the
 * placeholder blocks confirm, and account seeds to the first account
 * (AddEntryModal/seedExtractionDraft pattern; it is a user-side choice, not
 * a fact read off the email).
 */
export function seedInboxDraft(
  item: InboxEmail,
  settings: Pick<Settings, 'categories' | 'accounts'>,
): InboxDraft {
  const category = resolveCategorySuggestion(null, settings.categories);
  const account = settings.accounts[0] ?? '';
  if (!item.parsed) {
    return { date: '', merchant: '', amount: '', type: '', category, account };
  }
  return {
    date: item.parsed.date,
    merchant: item.parsed.merchant,
    amount: String(item.parsed.amount),
    type: item.parsed.type,
    category,
    account,
  };
}

/**
 * First failing rule wins (same order and copy style as
 * validateExtractionDraft, plus the type rule that form doesn't need).
 * Amount validity uses the SHARED amountCents rounding rule so "0.004" can't
 * pass validation and then store as 0.
 */
export function validateInboxDraft(draft: InboxDraft): string | null {
  if (!draft.merchant.trim()) return 'Enter a merchant.';
  if (!draft.date || !isRealDateISO(draft.date)) return 'Choose a real date.';
  const cents = amountCents(draft.amount);
  if (cents === null || cents < 1) return 'Enter an amount greater than 0.';
  if (!draft.type) return 'Choose expense or income.';
  if (!draft.category) return 'Choose a category.';
  if (!draft.account) return 'Choose an account.';
  return null;
}

/**
 * Builds the TxInput sent to store.confirmInboxEmail. Caller must validate
 * the draft first; an invalid amount or unset type reaching here is a caller
 * bug, not a value to guess around, so it throws rather than silently
 * submitting a wrong number (buildStatementConfirmInput's defensive stance).
 * `receipt: false` — the email itself is not a receipt attachment; a stored
 * attachment already lives in the vault as its own document.
 */
export function buildInboxTxInput(draft: InboxDraft): TxInput {
  const cents = amountCents(draft.amount);
  if (cents === null || cents < 1) {
    throw new Error('buildInboxTxInput: invalid amount');
  }
  if (!draft.type) {
    throw new Error('buildInboxTxInput: missing type');
  }
  return {
    date: draft.date,
    merchant: draft.merchant.trim(),
    amount: cents / 100,
    type: draft.type,
    category: draft.category,
    account: draft.account,
    receipt: false,
    source: 'email',
  };
}

// ---------------------------------------------------------------------------
// Settings — allowlist editing
// ---------------------------------------------------------------------------

/** The server matches senders case-insensitively; store entries lowercased
 * and trimmed so the list reads exactly the way it matches. */
export function normalizeSenderEntry(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Client-side shape check for a new allowlist entry: an exact address
 * ("alerts@bank.com") or a whole domain ("@bank.com"). The honest minimum —
 * it must contain '@' with a domain after it — plus a case-insensitive
 * duplicate check against the current list. Returns the reason to show
 * inline, or null when the entry can be added.
 */
export function senderEntryError(raw: string, current: string[]): string | null {
  const entry = normalizeSenderEntry(raw);
  if (!entry) return 'Enter an email address or @domain.';
  if (!entry.includes('@')) {
    return 'Include an @ — an exact address like alerts@bank.com, or a whole domain like @bank.com.';
  }
  if (entry.lastIndexOf('@') === entry.length - 1) return 'Add the domain after the @.';
  if (current.some((c) => normalizeSenderEntry(c) === entry)) {
    return `"${entry}" is already on the list.`;
  }
  return null;
}

/** Appends a normalized entry. Caller validates with senderEntryError first. */
export function addSenderEntry(current: string[], raw: string): string[] {
  return [...current, normalizeSenderEntry(raw)];
}

/** Removes exactly the given entry (entries are stored normalized). */
export function removeSenderEntry(current: string[], entry: string): string[] {
  return current.filter((e) => e !== entry);
}

export function buildEmailFeedToggleUpdate(enabled: boolean): PreferencesUpdate {
  return { emailFeedEnabled: enabled };
}

/** Full-replacement save, like the tags list. */
export function buildAllowlistUpdate(list: string[]): PreferencesUpdate {
  return { emailAllowedSenders: list };
}

/** The feed being on with an empty allowlist accepts NOTHING (secure by
 * default) — worth a visible warning so "enabled" doesn't read as working. */
export function showEmptyAllowlistWarning(enabled: boolean, allowedSenders: string[]): boolean {
  return enabled && allowedSenders.length === 0;
}
