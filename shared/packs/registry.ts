// The bundled pack registry — every statement pack this build ships.
// Client (pack detection before a browser read) and worker (begin's packId
// validation) both import from here, so the two sides can never disagree
// about what a pack id means.
//
// Adding a bank = adding one pack module + one line here + a synthetic
// fixture in tests (docs/PACKS.md is the contribution contract). The
// registry test suite validates every entry structurally and proves the
// signatures unambiguous, so a bad pack fails CI — never a user's read.
import type { StatementPack } from './spec';
import { inKotakSavings } from './packs/in-kotak-savings';

export const STATEMENT_PACKS: readonly StatementPack[] = [inKotakSavings];

/** The pack for an id, or null — the worker's begin-gate lookup. */
export function statementPackById(id: string): StatementPack | null {
  return STATEMENT_PACKS.find((p) => p.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// User-local packs (sprint 19) — packs the user distilled from their own
// statements, stored in Settings.localStatementPacks. Bundled + local form
// ONE detection space with one ambiguity rule; ids are globally unique
// (preferences validation rejects a local id colliding with a bundled one).
// ---------------------------------------------------------------------------

/** Most local packs a settings save accepts. */
export const LOCAL_PACKS_MAX = 25;

/** Largest single local pack a settings save accepts (JSON-serialized). */
export const LOCAL_PACK_MAX_BYTES = 8 * 1024;

/** Bundled packs first, then the user's local packs — the full detection
 * space for a client read. Order never decides a match (detection refuses
 * ambiguity outright), it just keeps output deterministic. */
export function allStatementPacks(local: readonly StatementPack[]): readonly StatementPack[] {
  return [...STATEMENT_PACKS, ...local];
}

/** Bundled-or-local lookup by id — the begin gate's sprint-19 form. */
export function anyStatementPackById(
  local: readonly StatementPack[],
  id: string,
): StatementPack | null {
  return statementPackById(id) ?? local.find((p) => p.id === id) ?? null;
}
