// BYO endpoint provider (sprint 15) — any OpenAI-compatible server becomes a
// Ledgerly AI provider: NVIDIA Build's free hosted models, a self-hosted
// Ollama or vLLM, OpenRouter, anything speaking POST {base}/chat/completions.
// The user's own base URL and (optional) key, held server-side and never
// echoed; document images go to whatever endpoint THEY configured, which is
// the trade this provider makes explicit.
//
// The request layer (runCustomChat + visionMessages) is deliberately shaped
// for reuse: S16's statement flow will pass MULTIPLE page images through the
// same two functions, so nothing in here assumes "one image, one receipt".
import { isRecord } from '../util';
import { parseModelJson } from './normalize';
import { buildSystemPrompt, USER_INSTRUCTION } from './prompt';

/** Everything a request needs. apiKey null = keyless server (local Ollama). */
export interface CustomEndpointConfig {
  /** Normalized by worker/preferences.ts: valid scheme, no trailing slash. */
  baseUrl: string;
  apiKey: string | null;
  model: string;
}

/** Injectable seams so tests run the client with zero network and no waiting. */
export interface CustomDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * One request ceiling. 90s is the same honest single-request budget the
 * Sarvam receipt loop uses: long enough for a slow self-hosted model on
 * modest hardware, short enough that a dead endpoint fails while the user is
 * still looking at the button they clicked.
 */
const REQUEST_TIMEOUT_MS = 90000;

/** Shared with the statement-pages round runner so the copy cannot drift. */
export const UNREADABLE_RESPONSE =
  'Your custom endpoint returned a response that could not be read.';

// ---------------------------------------------------------------------------
// Error taxonomy — the anthropic.ts contract: something a user can act on,
// with the response body deliberately dropped. An arbitrary server's error
// body can echo the request (including the Authorization header on some
// misconfigured proxies), and this provider's URL is user-typed — neither the
// key nor a URL that might embed one may ever reach a log line or a stored
// extraction row (spec §20).
// ---------------------------------------------------------------------------

function readableHttpError(status: number): Error {
  if (status === 401 || status === 403) {
    return new Error(
      'Your custom endpoint rejected the API key. Check the key saved in Settings — or remove it if the server is keyless.',
    );
  }
  if (status === 404) {
    // OpenAI-compatible servers 404 for a wrong path AND for an unknown
    // model, so the message names both places to look.
    return new Error(
      'Your custom endpoint has no such model or path. Check the base URL and model id in Settings.',
    );
  }
  if (status === 429) {
    return new Error('Your custom endpoint rate limited this request. Try again in a moment.');
  }
  return new Error('Your custom endpoint could not process this request. Try again.');
}

// ---------------------------------------------------------------------------
// Message building — the OpenAI chat shape, vision included
// ---------------------------------------------------------------------------

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user';
  content: string | ChatContentPart[];
}

/**
 * A system prompt plus ONE user turn carrying any number of images and the
 * instruction text. Images first, in the order given (for S16 that order is
 * page order — models read the parts sequentially), instruction last so it
 * reads as "here is everything; now do this". `images` entries are data: URIs
 * (or any URL an endpoint could fetch, though Ledgerly only ever sends data
 * URIs — document bytes must not require the endpoint to reach anything).
 */
export function visionMessages(
  images: readonly string[],
  system: string,
  instruction: string,
): ChatMessage[] {
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: [
        ...images.map((url): ChatContentPart => ({ type: 'image_url', image_url: { url } })),
        { type: 'text', text: instruction },
      ],
    },
  ];
}

/**
 * The assistant text out of an OpenAI-shaped completion. Most servers return
 * `choices[0].message.content` as a string; some return content parts — both
 * are read, anything else is null (unreadable, never guessed at).
 */
function readCompletionText(body: unknown): string | null {
  if (!isRecord(body) || !Array.isArray(body.choices)) return null;
  const first: unknown = body.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return null;
  const content = first.message.content;
  if (typeof content === 'string' && content.trim() !== '') return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((part): part is { type: 'text'; text: string } =>
        isRecord(part) && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text);
    if (texts.length > 0) return texts.join('');
  }
  // Reasoning models served behind vLLM-style reasoning parsers split their
  // output: thinking goes to `reasoning_content`, the answer to `content` —
  // and a misconfigured or mismatched parser can leave content EMPTY with
  // everything in reasoning_content (live incident 2026-08-13: muse-glimmer
  // on NVIDIA Build produced zero readable rows this way). When content is
  // empty, fall back to reasoning_content as suspect text — the parse/salvage
  // layer downstream treats every model answer as suspect anyway.
  const reasoning = first.message.reasoning_content;
  if (typeof reasoning === 'string' && reasoning.trim() !== '') return reasoning;
  return null;
}

// ---------------------------------------------------------------------------
// The request layer
// ---------------------------------------------------------------------------

/**
 * POST {baseUrl}/chat/completions and return the assistant's text.
 *
 * Deliberately NO response_format / structured-output field: support varies
 * wildly across OpenAI-compatible servers (some 400 on the field, some accept
 * and silently ignore it, some speak their own dialect of it), and the
 * existing parseModelJson salvage + normalize pipeline treats ALL model
 * output as suspect anyway — a schema promise the server might reject buys
 * nothing the validation layer doesn't already guarantee. temperature 0
 * because extraction is a read, not a composition.
 */
export async function runCustomChat(
  cfg: CustomEndpointConfig,
  messages: ChatMessage[],
  deps: CustomDeps = {},
): Promise<string> {
  // Wrapped, not aliased: calling the global `fetch` through a property
  // reference rebinds `this` and workerd throws "Illegal invocation".
  const fetchImpl = deps.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // Bearer auth only when a key is stored — a keyless server (local Ollama)
  // gets no Authorization header at all, not an empty one.
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      // max_tokens is explicit because hosted-endpoint DEFAULTS can be small
      // (NIM previews commonly cap near 1-2k): a statement round's rows JSON
      // — after a reasoning model's thinking spend — needs real headroom, and
      // a server that allows less simply caps it (the salvage layer already
      // handles cut answers loudly). 8192 covers ~300 rows comfortably.
      body: JSON.stringify({ model: cfg.model, temperature: 0, max_tokens: 8192, messages }),
      signal: controller.signal,
    });
  } catch {
    // The underlying message can carry the URL (and a URL can carry anything
    // the user typed into it) — dropped, like every other detail here.
    if (controller.signal.aborted) {
      throw new Error(
        'Your custom endpoint did not answer within 90 seconds. Check that the server is up, then try again.',
      );
    }
    throw new Error('Could not reach your custom endpoint. Check the base URL and the connection.');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw readableHttpError(res.status);

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(UNREADABLE_RESPONSE);
  }
  const text = readCompletionText(body);
  if (text === null) throw new Error(UNREADABLE_RESPONSE);
  return text;
}

/**
 * Read one receipt/invoice image (a data: URI — providers.ts already gated
 * the mime to images). Returns the raw parsed object for normalizeExtraction
 * to re-validate; nothing here is trusted. Reuses the exact receipt prompt
 * both other vision providers use, so a provider switch changes the wire, not
 * the question.
 */
export async function runCustomReceipt(
  cfg: CustomEndpointConfig,
  imageDataUrl: string,
  categories: readonly string[],
  deps: CustomDeps = {},
): Promise<unknown> {
  const text = await runCustomChat(
    cfg,
    visionMessages([imageDataUrl], buildSystemPrompt(categories), USER_INSTRUCTION),
    deps,
  );
  const parsed = parseModelJson(text);
  if (parsed === null) throw new Error(UNREADABLE_RESPONSE);
  return parsed;
}
