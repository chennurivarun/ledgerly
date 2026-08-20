// The pack engine — S18 contract stubs, frozen by the EM.
// Lane A replaces every body; SIGNATURES are the cross-lane contract and do
// not move without an EM ruling.
import type { PackParse, PackRow, PackValidationError, StatementPack } from './spec';

/**
 * Validate one pack object structurally (see PackValidationError in spec.ts).
 * Null = valid.
 */
export function validatePack(_pack: unknown): PackValidationError | null {
  throw new Error('S18 stub — implemented by lane A');
}

/**
 * Which bundled pack reads this document, if exactly one signature set
 * matches the first page's text. Ambiguity (2+ matches) returns null — a
 * deterministic read the engine cannot attribute is a read it refuses.
 * `pages` are per-page plain text, page order, UNCLIPPED.
 */
export function detectPack(
  _pages: readonly string[],
  _registry: readonly StatementPack[],
): StatementPack | null {
  throw new Error('S18 stub — implemented by lane A');
}

/**
 * Parse the whole statement with one pack: state machine over lines
 * (headerLine starts table mode; rowStart opens a row; furniture/headerLine
 * lines are skipped even mid-row; rowTail closes a row), then the declared
 * verification chains over every row, in cents-integer arithmetic. Any
 * break anywhere → { ok: false } with a STRUCTURAL reason. Never throws on
 * malformed input — refusal is the error channel.
 */
export function parseStatement(_pack: StatementPack, _pages: readonly string[]): PackParse {
  throw new Error('S18 stub — implemented by lane A');
}

/**
 * PackRows in the exact raw-row envelope finalize's normalizeStatementRows
 * expects: {date, merchant, amount, type} as {value, confidence: 1} (the
 * read is chain-verified structure, not a guess) and category
 * {value: null, confidence: 0} for the rules/enrichment layer to fill.
 */
export function toStatementRowInputs(_rows: readonly PackRow[]): unknown[] {
  throw new Error('S18 stub — implemented by lane A');
}
