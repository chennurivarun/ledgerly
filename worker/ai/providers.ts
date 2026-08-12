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

/**
 * Sarvam Doc AI has no model parameter — every job runs on Sarvam's own
 * document stack (Sarvam Vision). This id is a display label for job records;
 * a Settings.aiModel override still replaces it there (same rule as every
 * provider) but changes nothing about the request.
 */
export const SARVAM_DEFAULT_MODEL = 'sarvam-vision-1.5';

/** Image types the Anthropic and Workers AI vision paths accept. */
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * Sarvam Doc AI's documented input formats (docs.sarvam.ai, 2026-08-13):
 * PDF, JPEG and PNG. webp/gif are refused up front rather than bounced off
 * Sarvam's own 400 mid-run.
 */
const SARVAM_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'application/pdf']);

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
  if (settings.aiProvider === 'sarvam') {
    if (!settings.sarvamKeySet) {
      throw new ApiFail(400, 'Add your Sarvam API key in Settings to use this provider.');
    }
    return { provider: 'sarvam', model: override || SARVAM_DEFAULT_MODEL };
  }
  throw new ApiFail(400, 'Enable an AI provider in Settings to extract from documents.');
}

/**
 * Anthropic reads PDFs natively; Sarvam Doc AI reads PDFs plus its documented
 * image formats; the Workers AI vision models document image input only, so a
 * PDF there is refused instead of being sent as bytes the model would
 * hallucinate over.
 */
export function supportsMime(provider: ProviderChoice['provider'], mimeType: string): boolean {
  const mime = canonicalMime(mimeType);
  if (provider === 'sarvam') return SARVAM_MIME_TYPES.has(mime);
  if (IMAGE_MIME_TYPES.has(mime)) return true;
  return provider === 'anthropic' && mime === 'application/pdf';
}

export function assertMimeSupported(
  provider: ProviderChoice['provider'],
  mimeType: string,
): void {
  if (supportsMime(provider, mimeType)) return;
  if (provider === 'workers-ai') {
    throw new ApiFail(
      400,
      'Workers AI reads images only. Upload a photo or scan of the receipt, or switch to the Anthropic or Sarvam provider for PDFs.',
    );
  }
  if (provider === 'sarvam') {
    throw new ApiFail(
      400,
      'Sarvam reads PDFs and JPEG or PNG images. Upload one of those, or switch the provider in Settings.',
    );
  }
  throw new ApiFail(400, 'This file type cannot be read. Upload a PDF or an image of the receipt.');
}

// ---------------------------------------------------------------------------
// Statement extraction (sprint 4) is narrower than receipt extraction: PDFs
// only, Anthropic only. Both limits are stated to the user in the words that
// explain them, because "unsupported" with no reason is a dead end.
// ---------------------------------------------------------------------------

export const WORKERS_AI_NO_PDF =
  "Reading PDF statements needs the Anthropic or Sarvam provider — Workers AI models can't read PDFs yet.";

/**
 * Statement extraction is BYOK-only: Anthropic (sprint 4) or Sarvam (sprint
 * 10). The privacy-first default cannot do the job at all here (providers.ts
 * has refused PDFs to Workers AI since sprint 3), so rather than pretend, the
 * endpoint names the capable providers and the reason.
 */
export function selectStatementProvider(settings: Settings): ProviderChoice {
  if (settings.aiProvider === 'workers-ai') throw new ApiFail(400, WORKERS_AI_NO_PDF);
  // 'off' and a missing key are the same configuration problems as receipt
  // extraction, and get the same messages.
  const choice = selectProvider(settings);
  if (choice.provider !== 'anthropic' && choice.provider !== 'sarvam') {
    throw new ApiFail(400, WORKERS_AI_NO_PDF);
  }
  return choice;
}

/**
 * PDFs only. A CSV is pointed at the deterministic importer rather than at a
 * model: that path reads every row exactly and costs nothing, so sending it
 * here would be a worse answer at a higher price (VISION.md phase 2 item 3).
 */
export function assertStatementMime(mimeType: string): void {
  const mime = canonicalMime(mimeType);
  if (mime === 'application/pdf') return;
  if (mime === 'text/csv' || mime === 'application/csv') {
    throw new ApiFail(
      400,
      'Import CSV statements from the Transactions page — that reads every row exactly, with no model involved.',
    );
  }
  throw new ApiFail(
    400,
    'Statement extraction reads PDF statements. Upload the PDF your bank issued, or import a CSV from the Transactions page.',
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
