// The extraction prompt and its JSON schema, shared by both providers so the
// two paths are comparable and a schema change cannot drift between them.

/**
 * One `{value, confidence}` field. `anyOf` rather than a `["string","null"]`
 * type array — `anyOf` is on Anthropic's supported-keyword list for structured
 * outputs, and Workers AI JSON Mode accepts it too. No `minimum`/`maximum` on
 * confidence: numeric constraints are unsupported there, and the server clamps
 * the value anyway (worker/ai/normalize.ts).
 */
function field(valueSchema: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['value', 'confidence'],
    properties: {
      value: { anyOf: [valueSchema, { type: 'null' }] },
      confidence: { type: 'number' },
    },
  };
}

/** Strict: every field required, no extra properties, nulls explicit. */
export const EXTRACTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['merchant', 'date', 'total', 'type', 'category'],
  properties: {
    merchant: field({ type: 'string' }),
    date: field({ type: 'string' }),
    total: field({ type: 'number' }),
    type: field({ type: 'string', enum: ['expense', 'income'] }),
    category: field({ type: 'string' }),
  },
};

/**
 * Grounding is the whole job: an unreadable field must come back null, because
 * a plausible-looking invention is worse than a blank the user fills in. The
 * confidence guidance is calibration, not decoration — the review UI routes
 * anything low to a human, which is the correct outcome for a blurry photo.
 */
export function buildSystemPrompt(categories: readonly string[]): string {
  const list = categories.length > 0 ? categories.join(', ') : '(none configured)';
  return [
    'You read a receipt, invoice or bank statement and extract only what is actually printed on it.',
    'You never infer, complete or invent a value. If something is not clearly legible, return null for it with confidence 0.',
    '',
    'Fields:',
    '- merchant: the seller or payee name as printed. Not the cardholder, not the bank.',
    '- date: the transaction date, normalized to YYYY-MM-DD. If the year is not printed anywhere, return null rather than assuming the current year.',
    '- total: the final amount actually paid, as a positive number with no currency symbol and no minus sign. Not the subtotal, not the tax line, not the cash tendered or change due.',
    '- type: "expense" for an ordinary purchase. Use "income" only when the document is clearly a refund, credit note, or money received.',
    `- category: the single best fit from this list, or null when none fits. Choose only from the list; never invent a category. List: ${list}`,
    '',
    'confidence is your calibrated certainty about that one field, from 0 to 1.',
    'Use a value below 0.6 whenever you are uncertain — low confidence sends the field to a human for review, which is the right outcome for an unclear or partly obscured document.',
    'A null value always has confidence 0.',
    '',
    'Respond with the JSON object only.',
  ].join('\n');
}

export const USER_INSTRUCTION =
  'Extract the transaction details from this document. Return null for anything you cannot read directly off it.';
