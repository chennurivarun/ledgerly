// WhatsApp Business Cloud API client (BYO Meta credentials) — text messages
// only, used for briefing delivery (sprint 7).
//
// Error handling mirrors worker/ai/anthropic.ts: failures map onto short,
// actionable copy and the ORIGINAL error/response is deliberately dropped —
// the access token, the recipient number and Meta's response body must never
// reach a thrown message or a log line (spec §20). Nothing in this module
// logs anything.

/** Pinned Graph API version — bumped deliberately, never floating. */
const GRAPH_BASE = 'https://graph.facebook.com/v20.0';

/**
 * Map a Cloud API failure onto something the user can act on. `code` is
 * Meta's numeric error code (`body.error.code`) when the body was readable —
 * the only fragment of the response this module ever inspects. Notable codes:
 *  - 131030: recipient not in the app's allowed list (development mode)
 *  - 131026: message undeliverable (no WhatsApp account / malformed number)
 *  - 131047: outside the 24-hour customer-service window
 */
export function readableWhatsappError(status: number, code: number | null): Error {
  if (status === 401 || status === 403) {
    return new Error('Meta rejected the access token. Check the token saved in Settings.');
  }
  if (status === 404) {
    return new Error('Meta does not know that phone number ID. Check the value saved in Settings.');
  }
  if (status === 429) {
    return new Error('WhatsApp rate limited this request. Try again in a moment.');
  }
  if (status === 400) {
    if (code === 131030) {
      return new Error(
        'WhatsApp cannot deliver to that recipient. If your Meta app is in development mode, the recipient must be added as a test number.',
      );
    }
    if (code === 131026) {
      return new Error(
        'WhatsApp cannot deliver to that recipient. Check that the number is on WhatsApp and saved as digits only with the country code first.',
      );
    }
    if (code === 131047) {
      return new Error(
        'WhatsApp closed the free-text window for this recipient. Have them send any message to your WhatsApp business number, then try again.',
      );
    }
    return new Error(
      'Meta did not accept the message. Check the recipient number and phone number ID saved in Settings.',
    );
  }
  return new Error('WhatsApp could not process this message right now. Try again.');
}

/** Meta's error envelope: `{ error: { code: number, ... } }` — code only. */
function readErrorCode(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const err = (body as { error?: unknown }).error;
  if (typeof err !== 'object' || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'number' ? code : null;
}

/**
 * Send one plain-text WhatsApp message. `recipient` is E.164 digits without
 * the '+' (the Cloud API's `to` convention); `text` supports WhatsApp's
 * `*bold*` formatting. Resolves on success, throws readable copy otherwise.
 */
export async function sendWhatsappText(
  phoneNumberId: string,
  token: string,
  recipient: string,
  text: string,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${GRAPH_BASE}/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: recipient,
        type: 'text',
        text: { body: text },
      }),
    });
  } catch {
    throw new Error('Could not reach WhatsApp. Check the connection and try again.');
  }
  if (res.ok) return;

  // Only the numeric error code is read off the failure body; everything
  // else — including the messages Meta writes there — is discarded unseen.
  let code: number | null = null;
  try {
    code = readErrorCode(await res.json());
  } catch {
    // Unreadable body → status-only mapping.
  }
  throw readableWhatsappError(res.status, code);
}
