// The pack engine — S18 implementation (lane A).
// Interprets the frozen contracts in ./spec.ts: validates a pack's shape,
// picks one for a statement's first page, and walks a statement's text
// through a deterministic line state machine into chain-verified rows.
// Nothing here ever guesses — a statement either verifies exactly or the
// whole read is refused with a structural reason (VISION.md "never guess").
//
// Pure module — no D1, no network, no bindings. Exercised directly by tests.
import type {
  PackDateFormat,
  PackDirectionMode,
  PackParse,
  PackRow,
  PackTableGrammar,
  PackValidationError,
  PackVerification,
  StatementPack,
} from './spec';
import { STATEMENT_PACK_SPEC } from './spec';
import type { TxType } from '../types';

// ---------------------------------------------------------------------------
// Small local helpers. shared/ never imports worker/ (see spec.ts and
// docs/PACKS.md's host-agnostic framing), so these are re-declared rather
// than pulled from worker/util.ts.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Named capture groups declared in a regex SOURCE string. A literal scan
 * for `(?<name>` rather than a real parse — sufficient here since packs
 * write plain literal group names, never a name built from something that
 * could itself contain the `(?<` sequence. */
function namedGroupsIn(source: string): Set<string> {
  const names = new Set<string>();
  const re = /\(\?<([A-Za-z_$][\w$]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) names.add(m[1]);
  return names;
}

function compilesAsRegExp(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

const ID_RE = /^[a-z]{2}\.[a-z0-9-]+\.[a-z0-9-]+$/;
const COUNTRY_RE = /^[a-z]{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

const DATE_FORMATS: readonly PackDateFormat[] = [
  'dd MMM yyyy',
  'dd/MM/yyyy',
  'dd-MM-yyyy',
  'MM/dd/yyyy',
  'yyyy-MM-dd',
];
const DIRECTIONS: readonly PackDirectionMode[] = ['balance-delta'];
const VERIFICATIONS: readonly PackVerification[] = ['serial-chain', 'balance-chain'];

const TOP_LEVEL_KEYS = [
  'spec',
  'id',
  'name',
  'country',
  'currency',
  'signature',
  'dateFormat',
  'direction',
  'verify',
  'table',
] as const;

const TABLE_KEYS = ['headerLine', 'openingBalanceLine', 'rowStart', 'rowTail', 'furniture'] as const;

// ---------------------------------------------------------------------------
// validatePack
// ---------------------------------------------------------------------------

/**
 * Strict structural validation (see spec.ts's doc comments for the full
 * shape). Never throws: a regex source that fails to compile is a
 * validation failure, not an exception. Returns a short structural reason
 * on the FIRST rule violated, or null when the pack is valid.
 */
export function validatePack(pack: unknown): PackValidationError | null {
  if (!isRecord(pack)) return 'pack must be an object';

  for (const key of Object.keys(pack)) {
    if (!(TOP_LEVEL_KEYS as readonly string[]).includes(key)) {
      return `unknown top-level key "${key}"`;
    }
  }

  if (pack.spec !== STATEMENT_PACK_SPEC) return `spec must be exactly ${STATEMENT_PACK_SPEC}`;

  if (typeof pack.id !== 'string' || !ID_RE.test(pack.id)) {
    return 'id must match ^[a-z]{2}\\.[a-z0-9-]+\\.[a-z0-9-]+$';
  }
  if (typeof pack.country !== 'string' || !COUNTRY_RE.test(pack.country)) {
    return 'country must match ^[a-z]{2}$';
  }
  if (typeof pack.currency !== 'string' || !CURRENCY_RE.test(pack.currency)) {
    return 'currency must match ^[A-Z]{3}$';
  }
  if (typeof pack.name !== 'string' || pack.name.trim() === '') {
    return 'name must be a non-empty string';
  }

  if (!Array.isArray(pack.signature) || pack.signature.length === 0) {
    return 'signature must be a non-empty string array';
  }
  for (const entry of pack.signature) {
    if (typeof entry !== 'string' || !compilesAsRegExp(entry)) {
      return 'signature entry must be a string that compiles as a RegExp';
    }
  }

  if (typeof pack.dateFormat !== 'string' || !DATE_FORMATS.includes(pack.dateFormat as PackDateFormat)) {
    return 'dateFormat must be a supported format';
  }
  if (typeof pack.direction !== 'string' || !DIRECTIONS.includes(pack.direction as PackDirectionMode)) {
    return 'direction must be a supported direction';
  }

  if (!Array.isArray(pack.verify)) return 'verify must be an array';
  for (const entry of pack.verify) {
    if (typeof entry !== 'string' || !VERIFICATIONS.includes(entry as PackVerification)) {
      return 'verify entries must be supported verification chains';
    }
  }
  if (new Set(pack.verify).size !== pack.verify.length) return 'verify entries must be unique';

  if (!isRecord(pack.table)) return 'table must be an object';
  const table = pack.table;
  for (const key of Object.keys(table)) {
    if (!(TABLE_KEYS as readonly string[]).includes(key)) {
      return `unknown table-level key "${key}"`;
    }
  }

  if (typeof table.headerLine !== 'string' || !compilesAsRegExp(table.headerLine)) {
    return 'table.headerLine must be a string that compiles as a RegExp';
  }
  if (table.openingBalanceLine !== undefined) {
    if (typeof table.openingBalanceLine !== 'string' || !compilesAsRegExp(table.openingBalanceLine)) {
      return 'table.openingBalanceLine must be a string that compiles as a RegExp';
    }
  }
  if (typeof table.rowStart !== 'string' || !compilesAsRegExp(table.rowStart)) {
    return 'table.rowStart must be a string that compiles as a RegExp';
  }
  if (typeof table.rowTail !== 'string' || !compilesAsRegExp(table.rowTail)) {
    return 'table.rowTail must be a string that compiles as a RegExp';
  }
  if (!Array.isArray(table.furniture)) return 'table.furniture must be a string array';
  for (const entry of table.furniture) {
    if (typeof entry !== 'string' || !compilesAsRegExp(entry)) {
      return 'table.furniture entries must be strings that compile as a RegExp';
    }
  }

  const rowStartGroups = namedGroupsIn(table.rowStart);
  if (!rowStartGroups.has('date')) return 'table.rowStart must declare a "date" named group';
  if (!rowStartGroups.has('rest')) return 'table.rowStart must declare a "rest" named group';

  const rowTailGroups = namedGroupsIn(table.rowTail);
  if (!rowTailGroups.has('amount')) return 'table.rowTail must declare an "amount" named group';

  // Cross-field rules.
  if (pack.direction === 'balance-delta') {
    if (!pack.verify.includes('balance-chain')) {
      return 'direction "balance-delta" requires "balance-chain" in verify';
    }
    if (table.openingBalanceLine === undefined) {
      return 'direction "balance-delta" requires table.openingBalanceLine';
    }
    if (!rowTailGroups.has('balance')) {
      return 'direction "balance-delta" requires a "balance" named group in table.rowTail';
    }
  }
  if (pack.verify.includes('serial-chain') && !rowStartGroups.has('serial')) {
    return '"serial-chain" in verify requires a "serial" named group in table.rowStart';
  }

  return null;
}

// ---------------------------------------------------------------------------
// detectPack
// ---------------------------------------------------------------------------

/**
 * Picks the one pack whose ENTIRE signature (every regex, ANDed, compiled
 * with 'm') matches a statement's first page. Uses pages[0] only — an empty
 * or missing first page, zero matches, or 2+ matches (ambiguity) all return
 * null; ambiguity is a refusal, never a guess at which pack is "more
 * right".
 */
export function detectPack(
  pages: readonly string[],
  registry: readonly StatementPack[],
): StatementPack | null {
  const page1 = pages[0];
  if (!page1) return null;

  const matches = registry.filter((pack) =>
    pack.signature.every((source) => {
      try {
        return new RegExp(source, 'm').test(page1);
      } catch {
        return false;
      }
    }),
  );

  return matches.length === 1 ? matches[0] : null;
}

// ---------------------------------------------------------------------------
// parseStatement
// ---------------------------------------------------------------------------

const MAX_LINE_LENGTH = 2000;
const MAX_ROWS = 5000;

const MONTHS_3LETTER: Readonly<Record<string, number>> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

/** UTC round-trip real-calendar check, same idea as worker/util.ts's
 * `isIsoDate` — rejects e.g. Feb 30 even though its digits are individually
 * in range. */
function isRealUtcDate(year: number, monthIndex0: number, day: number): boolean {
  const dt = new Date(Date.UTC(year, monthIndex0, day));
  return (
    dt.getUTCFullYear() === year && dt.getUTCMonth() === monthIndex0 && dt.getUTCDate() === day
  );
}

function toIso(year: number, monthIndex0: number, day: number): string {
  const mm = String(monthIndex0 + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/**
 * `dateFormat` -> ISO YYYY-MM-DD, with real calendar validation. For the
 * `MMM` form, the month must be an EXACT-CASE English 3-letter
 * abbreviation ("Aug", not "aug"/"AUG") — a looser case match would be a
 * guess at what the statement actually printed.
 */
function parsePackDate(raw: string, format: PackDateFormat): string | null {
  switch (format) {
    case 'dd MMM yyyy': {
      const m = /^(\d{2}) ([A-Za-z]{3}) (\d{4})$/.exec(raw);
      if (!m) return null;
      const day = Number.parseInt(m[1], 10);
      const month = MONTHS_3LETTER[m[2]];
      const year = Number.parseInt(m[3], 10);
      if (month === undefined) return null;
      return isRealUtcDate(year, month, day) ? toIso(year, month, day) : null;
    }
    case 'dd/MM/yyyy': {
      const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
      if (!m) return null;
      const day = Number.parseInt(m[1], 10);
      const month = Number.parseInt(m[2], 10) - 1;
      const year = Number.parseInt(m[3], 10);
      return isRealUtcDate(year, month, day) ? toIso(year, month, day) : null;
    }
    case 'dd-MM-yyyy': {
      const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(raw);
      if (!m) return null;
      const day = Number.parseInt(m[1], 10);
      const month = Number.parseInt(m[2], 10) - 1;
      const year = Number.parseInt(m[3], 10);
      return isRealUtcDate(year, month, day) ? toIso(year, month, day) : null;
    }
    case 'MM/dd/yyyy': {
      const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
      if (!m) return null;
      const month = Number.parseInt(m[1], 10) - 1;
      const day = Number.parseInt(m[2], 10);
      const year = Number.parseInt(m[3], 10);
      return isRealUtcDate(year, month, day) ? toIso(year, month, day) : null;
    }
    case 'yyyy-MM-dd': {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
      if (!m) return null;
      const year = Number.parseInt(m[1], 10);
      const month = Number.parseInt(m[2], 10) - 1;
      const day = Number.parseInt(m[3], 10);
      return isRealUtcDate(year, month, day) ? toIso(year, month, day) : null;
    }
  }
}

/** `[\d,]+\.\d{2}` shape, comma-stripped, to exact INTEGER CENTS — string
 * arithmetic only, so no float ever touches a money value. */
function parseAmountToCents(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  if (!/^[\d,]+\.\d{2}$/.test(raw)) return null;
  const stripped = raw.replace(/,/g, '');
  const dot = stripped.indexOf('.');
  const whole = stripped.slice(0, dot);
  const frac = stripped.slice(dot + 1);
  if (whole === '') return null;
  return Number.parseInt(whole, 10) * 100 + Number.parseInt(frac, 10);
}

interface CompiledTable {
  headerLine: RegExp;
  openingBalanceLine: RegExp | null;
  rowStart: RegExp;
  rowTail: RegExp;
  furniture: RegExp[];
}

function compileTable(table: PackTableGrammar): CompiledTable | null {
  try {
    return {
      headerLine: new RegExp(table.headerLine),
      openingBalanceLine: table.openingBalanceLine ? new RegExp(table.openingBalanceLine) : null,
      rowStart: new RegExp(table.rowStart),
      rowTail: new RegExp(table.rowTail),
      furniture: table.furniture.map((source) => new RegExp(source)),
    };
  } catch {
    return null;
  }
}

/** rowTail matched against the END of `text` — content before the match is
 * the row's trailing description fragment. Returns null on no match, or a
 * match that doesn't reach the end of `text` (a mid-string coincidental
 * match — e.g. a description containing its own digit-and-dot tokens — is
 * not a close). */
function matchTailAtEnd(rowTail: RegExp, text: string): RegExpExecArray | null {
  const match = rowTail.exec(text);
  if (!match) return null;
  return match.index + match[0].length === text.length ? match : null;
}

interface OpenRow {
  /** 1-based ordinal this row will take among CLOSED rows if it succeeds —
   * used only for reason strings (never row content). */
  ordinal: number;
  date: string;
  serial: number | null;
  fragments: string[];
}

type CloseResult =
  | { ok: true; row: PackRow; nextBalanceCents: number; nextSerial: number | null }
  | { ok: false; reason: string };

/** Parses amount/balance, derives `type` from the balance-chain arithmetic,
 * checks the serial chain, and assembles the description. Shared by the
 * same-line close (rule 3) and the later-line close (rule 4). */
function closeRow(
  pack: StatementPack,
  openRow: OpenRow,
  match: RegExpExecArray,
  text: string,
  prevBalanceCents: number,
  prevSerial: number | null,
): CloseResult {
  const groups = match.groups ?? {};
  const amountCents = parseAmountToCents(groups.amount);
  if (amountCents === null) {
    return { ok: false, reason: `row ${openRow.ordinal} has an unreadable amount` };
  }

  const prefix = text.slice(0, match.index).trim();
  if (prefix) openRow.fragments.push(prefix);
  const description = openRow.fragments.join(' ').trim();

  if (pack.direction !== 'balance-delta') {
    // Unreachable while PackDirectionMode has a single member (validatePack
    // requires 'balance-delta' to carry a balance group), but kept as an
    // explicit refusal rather than a thrown error or an `as never` cast —
    // never throw on data, even data that "can't happen" today.
    return { ok: false, reason: `row ${openRow.ordinal} has no direction rule to derive type` };
  }

  const balanceCents = parseAmountToCents(groups.balance);
  if (balanceCents === null) {
    return { ok: false, reason: `row ${openRow.ordinal} has an unreadable balance` };
  }

  let type: TxType;
  if (prevBalanceCents - amountCents === balanceCents) {
    type = 'expense';
  } else if (prevBalanceCents + amountCents === balanceCents) {
    type = 'income';
  } else {
    return { ok: false, reason: `row ${openRow.ordinal} breaks the balance chain` };
  }

  let nextSerial = prevSerial;
  if (pack.verify.includes('serial-chain')) {
    // A missing serial under serial-chain is already refused when the row
    // opened (rowStart time), so `openRow.serial` is non-null here.
    const serial = openRow.serial as number;
    if (prevSerial !== null && serial !== prevSerial + 1) {
      return { ok: false, reason: `row ${openRow.ordinal} breaks the serial chain` };
    }
    nextSerial = serial;
  }

  const row: PackRow = {
    date: openRow.date,
    description,
    amount: amountCents / 100,
    type,
    balance: balanceCents / 100,
    serial: openRow.serial,
  };
  return { ok: true, row, nextBalanceCents: balanceCents, nextSerial };
}

/**
 * Runs a statement's per-page text through the pack's line grammar, then
 * verifies the closed rows' chains as it goes. See spec.ts's
 * PackTableGrammar doc comments for the grammar. Never throws —
 * `{ok:false, reason}` is the only error channel, and every reason is
 * STRUCTURAL (row ordinals, page numbers, chain names) — never a date,
 * amount, description, or any other statement content.
 */
export function parseStatement(pack: StatementPack, pages: readonly string[]): PackParse {
  const compiled = compileTable(pack.table);
  if (!compiled) return { ok: false, reason: 'pack table failed to compile' };
  if (pages.length === 0) return { ok: false, reason: 'no pages provided' };

  let tableStarted = false;
  let balanceSeeded = false;
  let prevBalanceCents = 0;
  let prevSerial: number | null = null;
  let openRow: OpenRow | null = null;
  const rows: PackRow[] = [];

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const pageNum = pageIdx + 1;
    const lines = pages[pageIdx].split('\n');

    for (const line of lines) {
      if (line.length > MAX_LINE_LENGTH) {
        return { ok: false, reason: `page ${pageNum} has an unreadably long line` };
      }

      if (!tableStarted) {
        if (compiled.headerLine.test(line)) tableStarted = true;
        continue;
      }

      // (1) headerLine or any furniture regex -> skip, even mid-row.
      if (compiled.headerLine.test(line) || compiled.furniture.some((re) => re.test(line))) {
        continue;
      }

      // (2) openingBalanceLine, when not yet seeded, seeds the balance chain.
      if (!balanceSeeded && compiled.openingBalanceLine && compiled.openingBalanceLine.test(line)) {
        const m = compiled.openingBalanceLine.exec(line);
        const cents = parseAmountToCents(m?.groups?.balance);
        if (cents === null) {
          return { ok: false, reason: 'opening balance line has an unreadable balance' };
        }
        prevBalanceCents = cents;
        balanceSeeded = true;
        continue;
      }

      // (3) rowStart opens a new row.
      const rowStartMatch = compiled.rowStart.exec(line);
      if (rowStartMatch) {
        if (openRow) {
          return {
            ok: false,
            reason: `row ${openRow.ordinal + 1} opened before row ${openRow.ordinal} closed`,
          };
        }
        if (pack.direction === 'balance-delta' && !balanceSeeded) {
          return { ok: false, reason: 'opening balance was never found before the first row' };
        }

        const groups = rowStartMatch.groups ?? {};
        const ordinal = rows.length + 1;

        const serialRaw = groups.serial;
        const serial = serialRaw !== undefined ? Number.parseInt(serialRaw, 10) : null;
        if (pack.verify.includes('serial-chain') && serial === null) {
          return { ok: false, reason: `row ${ordinal} is missing a required serial` };
        }

        const isoDate = parsePackDate(groups.date ?? '', pack.dateFormat);
        if (isoDate === null) {
          return { ok: false, reason: `row ${ordinal} has an invalid date` };
        }

        const rest = groups.rest ?? '';
        const candidate: OpenRow = { ordinal, date: isoDate, serial, fragments: [] };

        const tailMatch = matchTailAtEnd(compiled.rowTail, rest);
        if (tailMatch) {
          const closed = closeRow(pack, candidate, tailMatch, rest, prevBalanceCents, prevSerial);
          if (!closed.ok) return closed;
          rows.push(closed.row);
          if (rows.length > MAX_ROWS) {
            return { ok: false, reason: `statement has more than ${MAX_ROWS} rows` };
          }
          prevBalanceCents = closed.nextBalanceCents;
          prevSerial = closed.nextSerial;
        } else {
          if (rest.trim()) candidate.fragments.push(rest.trim());
          openRow = candidate;
        }
        continue;
      }

      // (4) a row is open: try to close it against this line's end.
      if (openRow) {
        const tailMatch = matchTailAtEnd(compiled.rowTail, line);
        if (tailMatch) {
          const closed = closeRow(pack, openRow, tailMatch, line, prevBalanceCents, prevSerial);
          if (!closed.ok) return closed;
          rows.push(closed.row);
          if (rows.length > MAX_ROWS) {
            return { ok: false, reason: `statement has more than ${MAX_ROWS} rows` };
          }
          prevBalanceCents = closed.nextBalanceCents;
          prevSerial = closed.nextSerial;
          openRow = null;
        } else {
          if (line.trim()) openRow.fragments.push(line.trim());
        }
        continue;
      }

      // (5) no row open -> inter-table furniture, ignored.
    }
  }

  if (openRow) {
    return { ok: false, reason: `row ${openRow.ordinal} never closed` };
  }
  if (rows.length === 0) {
    return { ok: false, reason: 'no transaction rows recognized' };
  }

  return { ok: true, rows };
}

// ---------------------------------------------------------------------------
// toStatementRowInputs
// ---------------------------------------------------------------------------

/**
 * Maps chain-verified rows to the raw envelope shape
 * `normalizeStatementRows` (worker/ai/normalize.ts) expects: {date,
 * merchant, amount, type} as {value, confidence: 1} — the read is
 * chain-verified structure, not a guess — and category always {value:
 * null, confidence: 0}, since category assignment is the rules/enrichment
 * layer's job, never this engine's.
 */
export function toStatementRowInputs(rows: readonly PackRow[]): unknown[] {
  return rows.map((row) => ({
    date: { value: row.date, confidence: 1 },
    merchant: { value: row.description, confidence: 1 },
    amount: { value: row.amount, confidence: 1 },
    type: { value: row.type, confidence: 1 },
    category: { value: null, confidence: 0 },
  }));
}
