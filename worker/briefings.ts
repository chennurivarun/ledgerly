// Briefing computation + WhatsApp delivery orchestration (sprint 7).
//
// The digest itself is pure (shared/briefing.ts); this module wires it to
// stored data and to the Cloud API client, and owns the two gates:
//  - config gate (sendConfigError) — can a send happen at all?
//  - cadence gate (shouldSendBriefing) — should the SCHEDULED path send now?
// Manual sends (POST /api/briefings/send) skip the cadence gate on purpose:
// a user pressing "send" wants the message now.
import {
  buildBriefing,
  renderBriefingText,
  shouldSendBriefing,
  type Briefing,
} from '../shared/briefing';
import { buildForecast } from '../shared/forecast';
import type { Settings } from '../shared/types';
import { readRules, readTransactions } from './queries';
import {
  readBriefingWhatsappToken,
  readSettings,
  writeSettings,
} from './settingsStore';
import { readRuleSuggestions } from './suggestions';
import { ApiFail } from './util';
import { sendWhatsappText } from './whatsapp';

/**
 * The worker's calendar day. UTC on purpose: the worker has no user timezone,
 * and a stable, honest clock beats a guessed local one (the cron tick is
 * documented as 08:00 UTC for the same reason). Exported so the MCP tools
 * (worker/mcp/tools.ts) run on the same clock.
 */
export function todayIsoUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface BriefingComputation {
  briefing: Briefing;
  /** The exact plain-text message a delivery would send. */
  text: string;
  settings: Settings;
}

/**
 * Compute today's briefing from stored data. Config-free: works with zero
 * WhatsApp configuration, so /preview can always render.
 */
export async function computeBriefing(db: D1Database): Promise<BriefingComputation> {
  const [transactions, settings, rules] = await Promise.all([
    readTransactions(db),
    readSettings(db),
    readRules(db),
  ]);
  const todayIso = todayIsoUtc();
  // 30-day horizon (the Recurring page's default); buildBriefing slices it
  // down to the next BRIEFING_WINDOW_DAYS days.
  const forecast = buildForecast(transactions, new Set(settings.dismissedPatterns), 30, todayIso);
  const [docCount, rowCount, suggestions] = await Promise.all([
    db
      .prepare('SELECT COUNT(*) AS n FROM documents WHERE status = ?')
      .bind('review')
      .first<{ n: number }>(),
    db
      .prepare('SELECT COUNT(*) AS n FROM statement_rows WHERE status = ?')
      .bind('proposed')
      .first<{ n: number }>(),
    readRuleSuggestions(db, rules, settings.categories),
  ]);
  const briefing = buildBriefing(
    transactions,
    forecast,
    {
      documentsAwaitingReview: docCount?.n ?? 0,
      ruleSuggestions: suggestions.length,
      statementRowsProposed: rowCount?.n ?? 0,
    },
    todayIso,
  );
  return { briefing, text: renderBriefingText(briefing, settings.currency), settings };
}

/**
 * Why a delivery cannot happen right now, as user-facing copy — or null when
 * the configuration is complete. Pure so the decisions are testable.
 */
export function sendConfigError(settings: Settings, tokenStored: boolean): string | null {
  if (!settings.briefingsEnabled) return 'Briefings are turned off. Enable them in Settings first.';
  if (!settings.briefingWhatsappRecipient) {
    return 'Add the WhatsApp recipient number in Settings first.';
  }
  if (!settings.briefingWhatsappPhoneNumberId) {
    return 'Add the WhatsApp phone number ID in Settings first.';
  }
  if (!tokenStored) return 'Save a WhatsApp access token in Settings first.';
  return null;
}

/**
 * Compute and deliver today's briefing, then stamp lastBriefingSentAt — the
 * ONLY place that field is ever written. Throws ApiFail with readable copy
 * when config is incomplete or Meta refuses the message.
 */
export async function sendBriefingNow(db: D1Database): Promise<{ ok: true; sentTo: string }> {
  const [settings, token] = await Promise.all([readSettings(db), readBriefingWhatsappToken(db)]);
  const blocked = sendConfigError(settings, token !== null);
  if (blocked !== null) throw new ApiFail(400, blocked);

  const { text } = await computeBriefing(db);
  try {
    // token is non-null here: sendConfigError gates on tokenStored.
    await sendWhatsappText(
      settings.briefingWhatsappPhoneNumberId,
      token as string,
      settings.briefingWhatsappRecipient,
      text,
    );
  } catch (err) {
    // whatsapp.ts already reduced the failure to safe, actionable copy.
    throw new ApiFail(500, err instanceof Error ? err.message : 'WhatsApp delivery failed. Try again.');
  }
  // Stamped only after Meta accepted the message — a failed send never
  // advances the cadence gate.
  await writeSettings(db, { lastBriefingSentAt: new Date().toISOString() });
  return { ok: true, sentTo: settings.briefingWhatsappRecipient };
}

export type BriefingRunResult = { ok: true; sentTo: string } | { ok: true; skipped: string };

/**
 * Cadence-gated entry shared by the cron trigger and POST /api/briefings/run.
 * Safe to hit as often as a scheduler likes: the gates, not the caller,
 * decide whether a message actually goes out (daily = once per UTC day,
 * weekly = once per 7 days). Skips report their reason instead of erroring so
 * an external cron never alarms over an intentional no-send; a real delivery
 * failure still throws (and, unstamped, is retried by the next tick).
 */
export async function runScheduledBriefing(db: D1Database): Promise<BriefingRunResult> {
  const [settings, token] = await Promise.all([readSettings(db), readBriefingWhatsappToken(db)]);
  if (!settings.briefingsEnabled) return { ok: true, skipped: 'briefings-disabled' };
  if (!shouldSendBriefing(settings.briefingCadence, settings.lastBriefingSentAt, todayIsoUtc())) {
    return { ok: true, skipped: 'already-sent-for-cadence' };
  }
  if (sendConfigError(settings, token !== null) !== null) {
    return { ok: true, skipped: 'whatsapp-not-configured' };
  }
  return sendBriefingNow(db);
}
