// One entry point for extraction, whichever provider is configured. Callers
// get validated fields or a readable Error — never raw model output, never an
// inserted transaction (VISION.md principle 2: AI suggests, it never writes).
import type { DocumentMeta, Settings } from '../../shared/types';
import { readAiApiKey } from '../settingsStore';
import { runAnthropic } from './anthropic';
import { normalizeExtraction, type ExtractionFields } from './normalize';
import { assertMimeSupported, assertStatementMime, selectProvider, selectStatementProvider } from './providers';
import { runAnthropicStatement, type StatementRun } from './statement';
import { runWorkersAi } from './workersAi';

export {
  ANTHROPIC_DEFAULT_MODEL,
  assertMimeSupported,
  assertStatementMime,
  selectProvider,
  selectStatementProvider,
  supportsMime,
  WORKERS_AI_DEFAULT_MODEL,
  type ProviderChoice,
} from './providers';
export {
  emptyFields,
  emptyStatementRow,
  lowestConfidence,
  normalizeExtraction,
  normalizeStatementRows,
  type ExtractionFields,
  type StatementRowFields,
} from './normalize';
export type { StatementRun } from './statement';

/**
 * Run the configured provider over one stored document.
 *
 * Throws `ApiFail` for configuration the user must fix (no provider, no key,
 * unsupported file) and a plain `Error` for a run that was attempted and
 * failed — the caller stores the latter as a `failed` extraction so the UI can
 * show what happened, and lets the former surface as a 400.
 */
export async function extractFromDocument(
  env: Env,
  settings: Settings,
  doc: Pick<DocumentMeta, 'mimeType'>,
  bytes: ArrayBuffer,
): Promise<ExtractionFields> {
  const { provider, model } = selectProvider(settings);
  assertMimeSupported(provider, doc.mimeType);

  const categories = settings.categories;
  let raw: unknown;

  if (provider === 'anthropic') {
    const apiKey = await readAiApiKey(env.DB);
    if (!apiKey) {
      // aiKeySet said otherwise — the row was removed between the two reads.
      throw new Error('No Anthropic API key is stored. Add one in Settings.');
    }
    raw = await runAnthropic(apiKey, model, doc.mimeType, bytes, categories);
  } else {
    raw = await runWorkersAi(env, model, doc.mimeType, bytes, categories);
  }

  // Everything the model said is re-checked here before it is stored.
  return normalizeExtraction(raw, categories);
}

/**
 * Run the statement pipeline over one stored PDF. Same contract as
 * `extractFromDocument`: `ApiFail` for configuration the user must fix, a plain
 * `Error` for a run that was attempted and failed. Returns the model's raw rows
 * — the caller normalizes them, because only the caller knows the category list
 * and the cap it wants to apply.
 */
export async function extractStatementFromDocument(
  env: Env,
  settings: Settings,
  doc: Pick<DocumentMeta, 'mimeType'>,
  bytes: ArrayBuffer,
): Promise<StatementRun> {
  const { model } = selectStatementProvider(settings);
  assertStatementMime(doc.mimeType);

  const apiKey = await readAiApiKey(env.DB);
  if (!apiKey) {
    // aiKeySet said otherwise — the row was removed between the two reads.
    throw new Error('No Anthropic API key is stored. Add one in Settings.');
  }
  return runAnthropicStatement(apiKey, model, bytes, settings.categories);
}
