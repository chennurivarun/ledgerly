// Which provider runs, on which model, for which file types. Pure decision
// logic — no bindings, no network — so the endpoint's 400s are testable and the
// two providers stay interchangeable behind one dispatch (VISION.md phase 2:
// Workers AI is the privacy-first default, BYOK the accuracy option).
import type { AiProvider, Settings } from '../../shared/types';
import { ApiFail } from '../util';

/**
 * Workers AI vision default. Verified against the live catalog on 2026-08-06
 * (https://developers.cloudflare.com/workers-ai/models/): several models list
 * vision (llama-4-scout, mistral-small-3.1, gemma-4, kimi-k2.6), but this is the
 * only vision-capable model that also appears on the JSON Mode support list
 * (https://developers.cloudflare.com/workers-ai/features/json-mode/). Extraction
 * is schema-constrained by design, so structured-output support decides it.
 * Users can override via Settings.aiModel if the catalog moves on.
 */
export const WORKERS_AI_DEFAULT_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

/** BYOK default. Settings.aiModel overrides. */
export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5';

/** Image types both providers accept. */
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** `image/jpg` is not an IANA type but browsers and scanners still emit it. */
const MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
};

/** Strip parameters (`image/png; charset=binary`) and fold known aliases. */
export function canonicalMime(raw: string): string {
  const base = raw.split(';')[0]?.trim().toLowerCase() ?? '';
  return MIME_ALIASES[base] ?? base;
}

export interface ProviderChoice {
  provider: Exclude<AiProvider, 'off'>;
  model: string;
}

/**
 * Resolve the active provider, or explain what the user needs to turn on.
 * Both failures are user-fixable configuration, so they are 400s with the
 * action in the message rather than a stored failed extraction.
 */
export function selectProvider(settings: Settings): ProviderChoice {
  const override = typeof settings.aiModel === 'string' ? settings.aiModel.trim() : '';

  if (settings.aiProvider === 'anthropic') {
    if (!settings.aiKeySet) {
      throw new ApiFail(400, 'Add your Anthropic API key in Settings to use this provider.');
    }
    return { provider: 'anthropic', model: override || ANTHROPIC_DEFAULT_MODEL };
  }
  if (settings.aiProvider === 'workers-ai') {
    return { provider: 'workers-ai', model: override || WORKERS_AI_DEFAULT_MODEL };
  }
  throw new ApiFail(400, 'Enable an AI provider in Settings to extract from documents.');
}

/**
 * Anthropic reads PDFs natively; the Workers AI vision models document image
 * input only, so a PDF there is refused instead of being sent as bytes the
 * model would hallucinate over.
 */
export function supportsMime(provider: ProviderChoice['provider'], mimeType: string): boolean {
  const mime = canonicalMime(mimeType);
  if (IMAGE_MIME_TYPES.has(mime)) return true;
  return provider === 'anthropic' && mime === 'application/pdf';
}

export function assertMimeSupported(
  provider: ProviderChoice['provider'],
  mimeType: string,
): void {
  if (supportsMime(provider, mimeType)) return;
  throw new ApiFail(
    400,
    provider === 'anthropic'
      ? 'This file type cannot be read. Upload a PDF or an image of the receipt.'
      : 'Workers AI reads images only. Upload a photo or scan of the receipt, or switch to the Anthropic provider for PDFs.',
  );
}

/** Base64 for the request body, chunked so a 20 MB file cannot blow the stack. */
export function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
