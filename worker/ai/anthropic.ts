// Anthropic BYOK provider — the accuracy option. The user's own key, held
// server-side and never echoed; document bytes go to Anthropic under that key,
// which is the trade the user opts into by choosing this provider.
//
// The client is constructed per request: the key is read fresh from D1 and no
// long-lived object ever holds it.
import Anthropic from '@anthropic-ai/sdk';
import { parseModelJson } from './normalize';
import { buildSystemPrompt, EXTRACTION_SCHEMA, USER_INSTRUCTION } from './prompt';
import { canonicalMime, toBase64 } from './providers';

/**
 * Thinking is on by default on the current models and shares this budget with
 * the answer, so leave headroom well above the ~200 tokens the schema needs.
 */
const MAX_TOKENS = 4096;

export function documentBlock(mimeType: string, data: string): Anthropic.ContentBlockParam {
  const mime = canonicalMime(mimeType);
  if (mime === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  return {
    type: 'image',
    // providers.ts already refused anything outside this set.
    source: { type: 'base64', media_type: mime as Anthropic.Base64ImageSource['media_type'], data },
  };
}

/**
 * Map SDK failures onto something a user can act on. The original message is
 * deliberately dropped: it can carry request fragments, and an auth failure's
 * body is the last place we want near a log line (spec §20). Shared with the
 * statement pipeline so both paths fail in the same words.
 */
export function readableError(err: unknown): Error {
  if (err instanceof Anthropic.AuthenticationError) {
    return new Error('Anthropic rejected the API key. Check the key saved in Settings.');
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new Error('Anthropic rate limited this request. Try again in a moment.');
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new Error('That Anthropic key is not allowed to use this model.');
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new Error('Anthropic does not know that model id. Check the model in Settings.');
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new Error('Could not reach Anthropic. Check the connection and try again.');
  }
  if (err instanceof Anthropic.APIError) {
    return new Error('Anthropic could not process this document. Try again.');
  }
  return new Error('The Anthropic request failed before it could be sent.');
}

export async function runAnthropic(
  apiKey: string,
  model: string,
  mimeType: string,
  bytes: ArrayBuffer,
  categories: readonly string[],
): Promise<unknown> {
  const client = new Anthropic({ apiKey, maxRetries: 1 });

  let message: Anthropic.Message;
  try {
    message = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      // Extraction is a short, well-specified read — low effort is the right
      // spend, and the schema does the shaping that a longer prompt would.
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: EXTRACTION_SCHEMA },
      },
      system: buildSystemPrompt(categories),
      messages: [
        {
          role: 'user',
          content: [documentBlock(mimeType, toBase64(bytes)), { type: 'text', text: USER_INSTRUCTION }],
        },
      ],
    });
  } catch (err) {
    throw readableError(err);
  }

  // A refusal is a successful HTTP response with no usable content — check
  // before touching `content`, never parse it.
  if (message.stop_reason === 'refusal') {
    throw new Error('Anthropic declined to process this document.');
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error('The model ran out of room before finishing. Try a smaller or clearer file.');
  }

  const text = message.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
  const parsed = parseModelJson(text);
  if (parsed === null) throw new Error('Anthropic returned a response that could not be read.');
  return parsed;
}
