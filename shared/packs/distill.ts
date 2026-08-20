// Pack distillation (sprint 19) — S19 contract stubs, frozen by the EM.
// Lane A replaces every body; SIGNATURES and types are the cross-lane
// contract and do not move without an EM ruling.
//
// Distillation turns ONE successful AI read into layout knowledge: given a
// statement's per-page text and the rows the user CONFIRMED in review, infer
// a draft StatementPack — then prove it, by running the REAL S18 engine on
// the same pages and requiring a verified parse that matches the anchors.
// The engine is the oracle: a draft that does not fully verify against the
// very statement it came from is refused, never returned. A distilled pack
// is layout knowledge ONLY — every regex the distiller emits comes from
// fixed structural templates or from repeated LAYOUT lines with all money
// tokens and 5+-digit runs generalized to pattern classes; statement
// content (dates, amounts, descriptions, account numbers, names) never
// survives into the output. `reason` strings are structural only, same
// contract as the engine's.
import type { TxType } from '../types';
import type { StatementPack } from './spec';

/** One user-confirmed row, used as an inference anchor. Merchant text is
 * deliberately absent — review-time cleaning means it no longer matches the
 * printed descriptor; dates + amounts + directions are the stable truth. */
export interface DistillAnchor {
  /** ISO YYYY-MM-DD. */
  date: string;
  /** Positive magnitude. */
  amount: number;
  type: TxType;
}

/** Identity the UI collects — a distiller cannot know what to call a bank. */
export interface DistillIdentity {
  /** Must satisfy the spec id shape ^[a-z]{2}\.[a-z0-9-]+\.[a-z0-9-]+$. */
  id: string;
  /** Human name ("My Bank — Savings"). */
  name: string;
  /** ISO 3166-1 alpha-2, lowercase. */
  country: string;
  /** ISO 4217. */
  currency: string;
}

export type DistillResult =
  | {
      ok: true;
      pack: StatementPack;
      /** The proof the draft earned: the engine's verified row count on
       * these pages, and how many anchors matched a parsed row exactly. */
      proof: { rows: number; anchorsMatched: number; anchorsTotal: number };
    }
  | { ok: false; reason: string };

/** Anchors below this count refuse outright — inference needs ground truth. */
export const DISTILL_MIN_ANCHORS = 3;

/** Of the anchors given, at least this fraction must match a parsed row
 * (user edits in review legitimately diverge from the printed truth, so a
 * perfect match is not required — but a majority is). */
export const DISTILL_MIN_ANCHOR_MATCH = 0.6;

/**
 * Infer a draft pack from pages + anchors, prove it with the real engine,
 * and return it only when: validatePack passes, parseStatement fully
 * verifies on `pages`, at least DISTILL_MIN_ANCHORS anchors were given, and
 * anchorsMatched/anchorsTotal >= DISTILL_MIN_ANCHOR_MATCH. Never throws on
 * malformed input — refusal is the only error channel.
 */
export function distillStatementPack(
  _pages: readonly string[],
  _anchors: readonly DistillAnchor[],
  _identity: DistillIdentity,
): DistillResult {
  throw new Error('S19 stub — implemented by lane A');
}

/**
 * The downloadable pack module: a self-contained TypeScript file matching
 * the shipped packs' shape — SPDX CC0-1.0 header (pack DATA is public
 * domain, see shared/packs/packs/LICENSE), the StatementPack import, and
 * one exported const named from the pack id. This is the artifact a user
 * hands to the commons (S20 automates the PR).
 */
export function renderPackModule(_pack: StatementPack): string {
  throw new Error('S19 stub — implemented by lane A');
}
