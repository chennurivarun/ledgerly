// Pure logic for the Settings "Briefings" section — eligibility, payload
// building, and label rules live here so they are unit-testable without
// rendering the page (same split as manage/ruleSuggestionHelpers.ts).
import type { BriefingCadence, PreferencesUpdate, Settings } from '../../../shared/types';

/** The briefing wire fields now live on PreferencesUpdate itself
 * (integration fixup after the S7 parallel builds); the alias remains so
 * call sites read as what they are. */
export type BriefingSettingsUpdate = PreferencesUpdate;

/** Recipient numbers are E.164 digits only — strip everything else so a
 * pasted "+1 (555) 123-4567" becomes "15551234567". */
export function digitsOnly(raw: string): string {
  return raw.replace(/\D/g, '');
}

/**
 * "Send test briefing" eligibility — computed from CURRENT SAVED settings
 * (never unsaved drafts): briefings on, a recipient, a phone number ID, and
 * a stored access token. The server re-validates; this only gates the button.
 */
export function canSendTestBriefing(
  s: Pick<
    Settings,
    | 'briefingsEnabled'
    | 'briefingWhatsappRecipient'
    | 'briefingWhatsappPhoneNumberId'
    | 'briefingWhatsappTokenSet'
  >,
): boolean {
  return (
    s.briefingsEnabled &&
    s.briefingWhatsappRecipient.trim() !== '' &&
    s.briefingWhatsappPhoneNumberId.trim() !== '' &&
    s.briefingWhatsappTokenSet
  );
}

export function buildBriefingToggleUpdate(enabled: boolean): BriefingSettingsUpdate {
  return { briefingsEnabled: enabled };
}

export function buildCadenceUpdate(cadence: BriefingCadence): BriefingSettingsUpdate {
  return { briefingCadence: cadence };
}

export function buildDeliveryUpdate(
  recipientDraft: string,
  phoneNumberIdDraft: string,
): BriefingSettingsUpdate {
  return {
    briefingWhatsappRecipient: digitsOnly(recipientDraft),
    briefingWhatsappPhoneNumberId: phoneNumberIdDraft.trim(),
  };
}

/** Whether the delivery drafts differ from the saved values (Save button is
 * disabled while they match, mirroring the AI model-override button). */
export function deliveryDirty(
  drafts: { recipient: string; phoneNumberId: string },
  saved: { recipient: string; phoneNumberId: string },
): boolean {
  return (
    digitsOnly(drafts.recipient) !== saved.recipient ||
    drafts.phoneNumberId.trim() !== saved.phoneNumberId
  );
}

/**
 * Token field payload (null-to-clear, mirroring aiApiKey):
 * - non-blank draft  → store the trimmed token;
 * - blank draft with a token stored → null, i.e. "clear to remove";
 * - blank draft with nothing stored → null result: nothing to save.
 */
export function buildTokenUpdate(
  draft: string,
  tokenSet: boolean,
): BriefingSettingsUpdate | null {
  const trimmed = draft.trim();
  if (trimmed !== '') return { briefingWhatsappToken: trimmed };
  if (tokenSet) return { briefingWhatsappToken: null };
  return null;
}

/** Quiet meta line under the actions; null hides it (never sent, or a
 * timestamp that doesn't parse — never render "Invalid Date"). Uses
 * toLocaleString like the Drive card's "Last synced" line on this page. */
export function lastBriefingLabel(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `Last sent ${d.toLocaleString()}`;
}

/** Success toast for a test send — always the server-confirmed recipient. */
export function briefingSentMessage(sentTo: string): string {
  return `Briefing sent to ${sentTo}.`;
}
