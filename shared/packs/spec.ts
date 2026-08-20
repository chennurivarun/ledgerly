// The Open Bank-Format Commons — pack spec (sprint 18).
//
// A statement pack teaches Ledgerly (or ANY host app — the spec is
// deliberately host-agnostic, see docs/PACKS.md) to read one bank's PDF
// statement layout DETERMINISTICALLY: instant, offline, zero AI, zero cost.
// Packs are DATA driving one well-tested engine — never code — so a
// community contribution is a reviewable object literal, not an audit burden.
//
// Trust model, pinned: a pack read must VERIFY before it proposes. The engine
// runs the pack's declared verification chains (serial numbers must increment,
// running balance must reconcile every row to the cent) and refuses the whole
// parse on the first break — never-guess, mechanically enforced. Even a
// verified read is still only a SUGGESTION: rows ride the same review gate as
// every AI provider's output.
//
// Input contract: per-page plain text, one string per page, as extracted by
// the host (Ledgerly: pdf.js text layer, the same extraction the browser
// statement flow already performs; other hosts: `pdftotext -layout` produces
// the same line-oriented shape). Packs see LINES — never PDF bytes, never
// column geometry.
import type { TxType } from '../types';

/** Spec revisions an engine build understands. Unknown fields or spec values
 * REJECT at validation — evolution happens by bumping the number, never by
 * silently ignoring what a newer pack meant. */
export const STATEMENT_PACK_SPEC = 1;

/**
 * How a row's direction (expense vs income) is recovered from a layout that
 * flattens Dr/Cr columns into one amount token.
 *
 * 'balance-delta' (the v1 mode): previous running balance minus amount equals
 * the new balance → expense; plus → income; NEITHER → the parse refuses.
 * Requires `table.openingBalanceLine` (the chain seed) and a `balance` group
 * in the row tail. This is also a per-row checksum — direction and
 * verification come from the same arithmetic. Future modes (Dr/Cr markers,
 * signed amounts, separate columns) extend this union WITH a spec bump.
 */
export type PackDirectionMode = 'balance-delta';

/** Verification chains a pack can declare. Every declared chain must pass
 * over the WHOLE statement or the parse refuses. */
export type PackVerification = 'serial-chain' | 'balance-chain';

/** Date layouts the engine can turn into ISO YYYY-MM-DD. English month
 * abbreviations (Jan..Dec) for the MMM forms. */
export type PackDateFormat =
  | 'dd MMM yyyy'
  | 'dd/MM/yyyy'
  | 'dd-MM-yyyy'
  | 'MM/dd/yyyy'
  | 'yyyy-MM-dd';

/**
 * The table grammar. All fields hold REGEX SOURCES (compiled by the engine,
 * never with user input interpolated). Named groups are the contract:
 *
 * - rowStart: opens a transaction row. Groups: `date` (required), `rest`
 *   (required — the line's remainder), `serial` (optional; required when
 *   'serial-chain' is declared). Column gaps in source layouts are runs of
 *   2+ spaces — grammars should anchor on `\s{2,}`, because single spaces
 *   occur INSIDE descriptions.
 * - rowTail: closes a row — matched against the END of any line of the row
 *   (a row may wrap across several lines; the tail may share the rowStart
 *   line). Groups: `amount` (required), `balance` (required for
 *   'balance-delta'/'balance-chain'). Amount tokens allow any digit
 *   grouping (`1,25,000.00` and `125,000.00` both parse — commas stripped).
 * - headerLine: the table's column-header line — starts (and, on later
 *   pages, continues) table mode; skipped wherever it appears.
 * - openingBalanceLine: seeds the balance chain. Group: `balance`.
 * - furniture: lines skipped OUTRIGHT, even mid-row (page footers, section
 *   titles — anything the layout interleaves with wrapped rows). Must never
 *   contain user-specific content (names, account numbers): packs are
 *   layout knowledge, not customer knowledge.
 */
export interface PackTableGrammar {
  headerLine: string;
  openingBalanceLine?: string;
  rowStart: string;
  rowTail: string;
  furniture: string[];
}

/** One bank statement layout, as shareable data. */
export interface StatementPack {
  spec: typeof STATEMENT_PACK_SPEC;
  /** Stable id: '<iso3166-country>.<bank>.<product>', lowercase. */
  id: string;
  /** Human name shown in the UI ("Read with the <name> pack"). */
  name: string;
  /** ISO 3166-1 alpha-2, lowercase. */
  country: string;
  /** ISO 4217 code of amounts in this layout. */
  currency: string;
  /**
   * Detection: regex sources that must EVERY ONE match somewhere in the
   * FIRST page's text (compiled with the 'm' flag). Signatures must be
   * specific enough that no two bundled packs match one document — the
   * engine refuses ambiguous detection outright.
   */
  signature: string[];
  dateFormat: PackDateFormat;
  direction: PackDirectionMode;
  verify: PackVerification[];
  table: PackTableGrammar;
}

/** One parsed-and-verified transaction row (engine output). */
export interface PackRow {
  /** ISO YYYY-MM-DD. */
  date: string;
  /** The raw printed description, tail tokens removed — downstream
   * enrichment (cleanBankDescriptor, rules) does the cleaning, exactly as it
   * does for AI-proposed rows. */
  description: string;
  /** Positive magnitude, rupees-and-paise style (2 decimals). */
  amount: number;
  type: TxType;
  /** Running balance AFTER this row (from the statement, chain-verified). */
  balance: number;
  /** The printed serial, when the grammar captures one. */
  serial: number | null;
}

/**
 * A parse either fully verifies or refuses — no partial output, ever.
 * `reason` is STRUCTURAL copy only (row ordinals, chain names, page numbers
 * — never a date, an amount, a merchant, or any other statement content):
 * it is stored into job errors and must stay as leak-proof as the AI error
 * taxonomy.
 */
export type PackParse =
  | { ok: true; rows: PackRow[] }
  | { ok: false; reason: string };

/**
 * Structural validation for one pack object (shape, regex compilability,
 * group presence for the declared modes, id/country/currency formats).
 * Returns null when valid, else a short structural reason. The registry
 * test suite runs this over every bundled pack; hosts embedding packs from
 * elsewhere run it before first use.
 */
export type PackValidationError = string;
