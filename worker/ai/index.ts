// One entry point for extraction, whichever provider is configured. Callers
// get validated fields or a readable Error — never raw model output, never an
// inserted transaction (VISION.md principle 2: AI suggests, it never writes).
import type { DocumentMeta, Settings } from '../../shared/types';
import { readAiApiKey, readSarvamApiKey } from '../settingsStore';
import { runAnthropic } from './anthropic';
import { normalizeExtraction, type ExtractionFields } from './normalize';
import { assertMimeSupported, assertStatementMime, selectProvider, selectStatementProvider } from './providers';
import { runSarvamReceipt, runSarvamStatement } from './sarvam';
import { runAnthropicStatement, type StatementRun } from './statement';
import { runWorkersAi } from './workersAi';

export {
  ANTHROPIC_DEFAULT_MODEL,
  assertMimeSupported,
  assertStatementMime,
  SARVAM_DEFAULT_MODEL,
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
export { countPdfPages, splitPdfIntoBatches } from './pdfSplit';
export { MAX_SARVAM_PAGES_PER_JOB } from './sarvam';
export type { StatementRun } from './statement';

/** The stored Sarvam key, or the readable error for a row deleted mid-flight. */
async function requireSarvamKey(env: Env): Promise<string> {
  const apiKey = await readSarvamApiKey(env.DB);
  if (!apiKey) {
    // sarvamKeySet said otherwise — the row was removed between the two reads.
    throw new Error('No Sarvam API key is stored. Add one in Settings.');
  }
  return apiKey;
}

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
  } else if (provider === 'sarvam') {
    raw = await runSarvamReceipt(await requireSarvamKey(env), bytes, doc.mimeType, categories);
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
 * and the cap it wants to apply. Both providers' rows arrive in the same
 * envelope shape and flow through the same normalize pipeline: Sarvam output
 * gets zero extra trust.
 */
export async function extractStatementFromDocument(
  env: Env,
  settings: Settings,
  doc: Pick<DocumentMeta, 'mimeType'>,
  bytes: ArrayBuffer,
): Promise<StatementRun> {
  const { provider, model } = selectStatementProvider(settings);
  assertStatementMime(doc.mimeType);

  if (provider === 'sarvam') {
    return runSarvamStatement(await requireSarvamKey(env), bytes, settings.categories);
  }

  const apiKey = await readAiApiKey(env.DB);
  if (!apiKey) {
    // aiKeySet said otherwise — the row was removed between the two reads.
    throw new Error('No Anthropic API key is stored. Add one in Settings.');
  }
  return runAnthropicStatement(apiKey, model, bytes, settings.categories);
}
