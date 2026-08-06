// Workers AI provider — inference runs inside the user's own Cloudflare
// account, so the document bytes never leave their infrastructure
// (VISION.md principle 1). Images only; see providers.ts for why.
import { isRecord } from '../util';
import { parseModelJson } from './normalize';
import { buildSystemPrompt, EXTRACTION_SCHEMA, USER_INSTRUCTION } from './prompt';
import { canonicalMime, toBase64 } from './providers';

/**
 * The model id is user-configurable, so it cannot be one of the literal keys
 * the generated `Ai` binding type expects. Narrowing to this shape keeps the
 * call honest about what we actually rely on.
 */
interface AiRunner {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

const MAX_TOKENS = 1024;

/** Pull the model's JSON out of whichever envelope Workers AI returns. */
function readResponse(raw: unknown): unknown {
  if (!isRecord(raw)) return null;
  // JSON Mode returns `response` already parsed; plain text generation returns
  // it as a string that may still be fenced.
  const response = raw.response;
  if (isRecord(response)) return response;
  if (typeof response === 'string') return parseModelJson(response);
  return null;
}

export async function runWorkersAi(
  env: Env,
  model: string,
  mimeType: string,
  bytes: ArrayBuffer,
  categories: readonly string[],
): Promise<unknown> {
  if (!env.AI) {
    throw new Error('Workers AI unavailable. Check the AI binding on this deployment.');
  }
  const ai = env.AI as unknown as AiRunner;
  const dataUri = `data:${canonicalMime(mimeType)};base64,${toBase64(bytes)}`;

  let raw: unknown;
  try {
    raw = await ai.run(model, {
      messages: [
        { role: 'system', content: buildSystemPrompt(categories) },
        { role: 'user', content: USER_INSTRUCTION },
      ],
      image: dataUri,
      response_format: { type: 'json_schema', json_schema: EXTRACTION_SCHEMA },
      max_tokens: MAX_TOKENS,
    });
  } catch {
    // The underlying message can echo the request; keep it out of the UI and
    // out of the stored extraction row (spec §20).
    throw new Error(`Workers AI could not run ${model}. Check the model id in Settings.`);
  }

  const parsed = readResponse(raw);
  if (parsed === null) throw new Error('Workers AI returned a response that could not be read.');
  return parsed;
}
