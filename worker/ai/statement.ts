// One Anthropic request per statement: the whole PDF in, many proposed rows
// out. Everything this returns is still raw model output — worker/ai/normalize
// re-checks every field before any of it reaches D1 (VISION.md principle 2).
//
// ponytail: no per-page chunking in v1. A statement goes to the model whole,
// and a run that runs out of output room reports `truncated` and keeps the rows
// it did read (worker/statements.ts persists that as status 'partial'). Chunking
// would buy longer statements at the cost of page-boundary rows being read
// twice or not at all — a correctness problem traded for a size limit, which is
// the wrong trade while the size limit is still loud.
import Anthropic from '@anthropic-ai/sdk';
import { readableError } from './anthropic';
import { parseModelJson, readRowsArray, salvageStatementRows } from './normalize';
import {
  buildStatementSystemPrompt,
  STATEMENT_SCHEMA,
  STATEMENT_USER_INSTRUCTION,
} from './prompt';
import { toBase64 } from './providers';

/**
 * A dozen pages of rows is a lot of JSON, and thinking is on by default on the
 * current models and shares this budget with the answer. Sized generously
 * because the failure mode is truncation, which costs the user a re-run of an
 * expensive call.
 */
const MAX_TOKENS = 32000;

export interface StatementRun {
  /** Unvalidated row objects, in the order the model returned them. */
  rows: unknown[];
  /** The model ran out of room — rows may be missing from the end. */
  truncated: boolean;
}

/**
 * Read one PDF statement. Streaming is not optional at this size: a
 * non-streaming request with a 32k budget sits on an open socket long enough
 * to hit HTTP timeouts, and the whole run would be lost with it.
 */
export async function runAnthropicStatement(
  apiKey: string,
  model: string,
  bytes: ArrayBuffer,
  categories: readonly string[],
): Promise<StatementRun> {
  const client = new Anthropic({ apiKey, maxRetries: 1 });

  let message: Anthropic.Message;
  try {
    message = await client.messages
      .stream({
        model,
        max_tokens: MAX_TOKENS,
        // Reading a printed table is transcription, not reasoning — the schema
        // does the shaping, so the budget belongs to the rows.
        output_config: {
          effort: 'low',
          format: { type: 'json_schema', schema: STATEMENT_SCHEMA },
        },
        system: buildStatementSystemPrompt(categories),
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: toBase64(bytes) },
              },
              { type: 'text', text: STATEMENT_USER_INSTRUCTION },
            ],
          },
        ],
      })
      .finalMessage();
  } catch (err) {
    throw readableError(err);
  }

  // A refusal is a successful HTTP response with no usable content — checked
  // before `content` is touched, never parsed.
  if (message.stop_reason === 'refusal') {
    throw new Error('Anthropic declined to read this statement.');
  }
  const truncated = message.stop_reason === 'max_tokens';

  const text = message.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
  const rows = readRowsArray(parseModelJson(text));
  if (rows !== null) return { rows, truncated };

  // Unparseable is the expected shape of a truncated answer: the JSON stops
  // mid-row. Salvage the complete rows before calling the run a failure.
  const salvaged = salvageStatementRows(text);
  if (salvaged.length > 0) return { rows: salvaged, truncated: true };

  throw new Error(
    truncated
      ? 'The model ran out of room before it could return a single complete row.'
      : 'Anthropic returned a statement response that could not be read.',
  );
}
