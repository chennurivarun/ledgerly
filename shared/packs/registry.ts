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
