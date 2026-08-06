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

// ---------------------------------------------------------------------------
// Statement extraction (sprint 4) — the same envelope, many times over
// ---------------------------------------------------------------------------

/**
 * A statement is a *table*, so the schema is the receipt's five fields wrapped
 * in a `rows` array. Deliberately no `maxItems`: array-length constraints are
 * not on the supported-keyword list, and the server caps at MAX_STATEMENT_ROWS
 * anyway (worker/ai/normalize.ts) — a schema promise the API might silently
 * drop is worse than no promise at all.
 */
export const STATEMENT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['rows'],
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['date', 'merchant', 'amount', 'type', 'category'],
        properties: {
          date: field({ type: 'string' }),
          merchant: field({ type: 'string' }),
          amount: field({ type: 'number' }),
          type: field({ type: 'string', enum: ['expense', 'income'] }),
          category: field({ type: 'string' }),
        },
      },
    },
  },
};

/**
 * Same never-guess contract as the receipt prompt, plus the two rules a table
 * adds: read EVERY row in printed order, and skip the lines that look like
 * transactions but are not (balances, subtotals, interest summaries, page
 * furniture). A missed row the user can spot; an invented one they cannot.
 */
export function buildStatementSystemPrompt(categories: readonly string[]): string {
  const list = categories.length > 0 ? categories.join(', ') : '(none configured)';
  return [
    'You read a bank or credit-card statement and extract every transaction row that is actually printed on it.',
    'You never infer, complete or invent a value. If something is not clearly legible, return null for it with confidence 0.',
    '',
    'Read the statement from the first page to the last and return one entry per transaction row, in the order they are printed.',
    'Do not merge rows, do not reorder them, and do not summarize.',
    '',
    'Skip anything that is not a transaction: opening and closing balances, running balances, subtotals, section totals,',
    'minimum payment and credit-limit boxes, interest and fee summary tables, reward-point lines, headers, footers and page numbers.',
    'A line only becomes a row when it names a single dated movement of money.',
    '',
    'Fields, per row:',
    '- date: the transaction date as printed, normalized to YYYY-MM-DD. Statements often print the year once in a header — use it. If the year is genuinely not printed anywhere, return null rather than assuming the current year.',
    '- merchant: the payee or description as printed, trimmed of reference numbers and card digits where they are clearly separate. Not the bank, not the account holder.',
    '- amount: a positive number with no currency symbol and no minus sign.',
    "- type: follow the statement's own debit/credit convention. A debit, withdrawal, purchase or charge is \"expense\". A credit, deposit, refund or payment received is \"income\". If the column, sign or wording does not make the direction clear, return null.",
    `- category: the single best fit from this list, or null when none fits. Choose only from the list; never invent a category. List: ${list}`,
    '',
    'confidence is your calibrated certainty about that one field, from 0 to 1.',
    'Use a value below 0.6 whenever you are uncertain — low confidence sends the field to a human for review, which is the right outcome for a faint scan or a truncated description.',
    'A null value always has confidence 0.',
    '',
    'Respond with the JSON object only.',
  ].join('\n');
}

export const STATEMENT_USER_INSTRUCTION =
  'Extract every transaction row from this statement, in order. Return null for anything you cannot read directly off it, and skip lines that are not transactions.';
