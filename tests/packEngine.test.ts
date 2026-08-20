import { describe, expect, it } from 'vitest';
import {
  detectPack,
  parseStatement,
  toStatementRowInputs,
  validatePack,
} from '../shared/packs/engine';
import { inKotakSavings } from '../shared/packs/packs/in-kotak-savings';
import type { PackRow, StatementPack } from '../shared/packs/spec';
import { generateSyntheticStatement } from './helpers/syntheticStatement';

// ---------------------------------------------------------------------------
// Hand-built minimal lines, in the exact literal shapes
// shared/packs/packs/in-kotak-savings.ts's grammar expects (proven against
// the fixture generator's identical constants in tests/packRegistry.test.ts)
// — used for refusal cases where a bespoke single-line defect is clearer
// than round-tripping the full generator.
// ---------------------------------------------------------------------------

const HEADER_LINE =
  '#   Date   Description   Chq/Ref. No.   Withdrawal (Dr.)   Deposit (Cr.)   Balance';
const openingLine = (balance: string) => `-   -   Opening Balance   -   -   -   ${balance}`;
const rowLine = (serial: number, date: string, desc: string, amount: string, balance: string) =>
  `${serial}   ${date}   ${desc}   ${amount}   ${balance}`;

function page(lines: string[]): string {
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Round-trips
// ---------------------------------------------------------------------------

describe('parseStatement — round-trips (via the synthetic Kotak fixture)', () => {
  const seeds: {
    date: string;
    description: string;
    amount: number;
    type: 'expense' | 'income';
    layout?: 'single' | 'wrapped' | 'wrapped-mid-token';
    expectedDescription?: string;
  }[] = [
    { date: '2026-08-01', description: 'SYNTH MART', amount: 45.5, type: 'expense' },
    { date: '2026-08-02', description: 'SYNTH PAYROLL DEPOSIT', amount: 3000, type: 'income' },
    {
      date: '2026-08-03',
      description: 'UPI SYNTH GENERAL STORE MONTHLY GROCERY RESTOCK PURCHASE',
      amount: 812.25,
      type: 'expense',
      layout: 'wrapped',
    },
    {
      date: '2026-08-04',
      description: 'UPI/SYNTH STORES/000000000000/Payment from Phone',
      amount: 120,
      type: 'expense',
      layout: 'wrapped-mid-token',
      // The mid-token split reconstructs with a single space at the cut
      // point ("Ph" + "one") — description assembly always joins fragments
      // with a single space (spec.ts), so this is pinned, expected lossy
      // behavior for this real layout habit, not a bug.
      expectedDescription: 'UPI/SYNTH STORES/000000000000/Payment from Ph one',
    },
    {
      // A digit-and-dot token INSIDE the description ("45.00") must not be
      // mistaken for the row's own tail — only a single space separates it
      // from "THANKS", so rowTail's \s{2,} column-gap requirement can never
      // be satisfied there; the true tail further right is what closes it.
      date: '2026-08-05',
      description: 'SYNTH MART INV 45.00 THANKS',
      amount: 99.99,
      type: 'expense',
    },
  ];

  function expectedRows(openingCents: number): PackRow[] {
    let balanceCents = openingCents;
    return seeds.map((seed, i) => {
      const amountCents = Math.round(seed.amount * 100);
      balanceCents = seed.type === 'expense' ? balanceCents - amountCents : balanceCents + amountCents;
      return {
        date: seed.date,
        description: seed.expectedDescription ?? seed.description,
        amount: amountCents / 100,
        type: seed.type,
        balance: balanceCents / 100,
        serial: i + 1,
      };
    });
  }

  it('parses mixed single/wrapped/wrapped-mid-token rows, expense+income, Indian grouping', () => {
    const pages = generateSyntheticStatement({ openingBalance: 10000, rows: seeds, grouping: 'indian' });
    const result = parseStatement(inKotakSavings, pages);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows).toEqual(expectedRows(1_000_000));
  });

  it('parses the identical statement with western digit grouping to the same numeric result', () => {
    const pages = generateSyntheticStatement({ openingBalance: 10000, rows: seeds, grouping: 'western' });
    const result = parseStatement(inKotakSavings, pages);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows).toEqual(expectedRows(1_000_000));
  });

  it('wraps a row across a page boundary — furniture interleaves without breaking the open row, serials stay continuous', () => {
    const rows: typeof seeds = [
      { date: '2026-08-01', description: 'SYNTH MART ROW ONE', amount: 10, type: 'expense' },
      {
        date: '2026-08-02',
        description: 'UPI SYNTH GENERAL STORE MONTHLY GROCERY RESTOCK',
        amount: 55.25,
        type: 'expense',
        layout: 'wrapped',
      },
      { date: '2026-08-03', description: 'SYNTH MART ROW THREE', amount: 5, type: 'income' },
    ];
    // row 1: 1 line. row 2 (wrapped): 3 lines. row 3: 1 line.
    // Break after cumulative line 2 -- inside row 2's own 3-line run, after
    // its rowStart line but before its continuation/tail lines.
    const pages = generateSyntheticStatement({ openingBalance: 100, rows, breakAfterLines: [2] });
    expect(pages).toHaveLength(2);

    const result = parseStatement(inKotakSavings, pages);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.map((r) => r.serial)).toEqual([1, 2, 3]);
    expect(result.rows.map((r) => r.type)).toEqual(['expense', 'expense', 'income']);
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('parseStatement — refusals', () => {
  it('refuses a serial gap, naming the row ordinal and the chain, no row content', () => {
    const pages = [
      page([
        HEADER_LINE,
        openingLine('1000.00'),
        rowLine(1, '05 Aug 2026', 'FIRST ROW', '100.00', '900.00'),
        rowLine(3, '06 Aug 2026', 'SECOND ROW', '50.00', '850.00'), // serial jumps 1 -> 3
      ]),
    ];
    const result = parseStatement(inKotakSavings, pages);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('row 2 breaks the serial chain');
    expect(result.reason).not.toMatch(/FIRST ROW|SECOND ROW|100\.00|50\.00/);
  });

  it('refuses a balance mismatch, naming the row ordinal and the chain, no row content', () => {
    const pages = [
      page([
        HEADER_LINE,
        openingLine('1000.00'),
        rowLine(1, '05 Aug 2026', 'FIRST ROW', '100.00', '900.00'),
        rowLine(2, '06 Aug 2026', 'SECOND ROW', '50.00', '999.00'), // should be 850.00
      ]),
    ];
    const result = parseStatement(inKotakSavings, pages);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('row 2 breaks the balance chain');
    expect(result.reason).not.toMatch(/FIRST ROW|SECOND ROW|100\.00|50\.00/);
  });

  it('refuses when the opening balance was never found before the first row', () => {
    const pages = [page([HEADER_LINE, rowLine(1, '05 Aug 2026', 'FIRST ROW', '100.00', '900.00')])];
    const result = parseStatement(inKotakSavings, pages);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('opening balance was never found before the first row');
  });

  it('refuses a row that never closes', () => {
    const pages = [
      page([HEADER_LINE, openingLine('1000.00'), '1   05 Aug 2026   ROW WITH NO TAIL AT ALL']),
    ];
    const result = parseStatement(inKotakSavings, pages);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('row 1 never closed');
      expect(result.reason).not.toMatch(/TAIL/);
    }
  });

  it('refuses a row opened before the previous row closed', () => {
    const pages = [
      page([
        HEADER_LINE,
        openingLine('1000.00'),
        '1   05 Aug 2026   FIRST ROW NO TAIL',
        '2   06 Aug 2026   SECOND ROW NO TAIL',
      ]),
    ];
    const result = parseStatement(inKotakSavings, pages);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('row 2 opened before row 1 closed');
  });

  it('refuses empty pages (zero pages provided)', () => {
    const result = parseStatement(inKotakSavings, []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no pages provided');
  });

  it('refuses when no transaction rows are recognized', () => {
    const pages = [page([HEADER_LINE, openingLine('1000.00')])];
    const result = parseStatement(inKotakSavings, pages);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no transaction rows recognized');
  });

  it('refuses an unreadably long line, naming the page number only', () => {
    const pages = [page(['x'.repeat(2001)])];
    const result = parseStatement(inKotakSavings, pages);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('page 1 has an unreadably long line');
  });

  it('refuses a date that fails real-calendar validation (30 Feb)', () => {
    const pages = [
      page([HEADER_LINE, openingLine('1000.00'), rowLine(1, '30 Feb 2026', 'ROW', '100.00', '900.00')]),
    ];
    const result = parseStatement(inKotakSavings, pages);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('row 1 has an invalid date');
      expect(result.reason).not.toMatch(/Feb|30|2026/);
    }
  });

  it('refuses a zero-amount row with an unchanged balance as direction-ambiguous, never a silent expense guess', () => {
    const pages = [
      page([
        HEADER_LINE,
        openingLine('1000.00'),
        rowLine(1, '05 Aug 2026', 'ROW', '0.00', '1000.00'), // amount 0, balance unchanged: both directions "verify"
      ]),
    ];
    const result = parseStatement(inKotakSavings, pages);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('row 1 has an ambiguous direction in the balance chain');
      expect(result.reason).not.toMatch(/ROW/);
    }
  });

  it('refuses a 17-digit amount token rather than accept an imprecise double at confidence 1', () => {
    const pages = [
      page([
        HEADER_LINE,
        openingLine('1000.00'),
        rowLine(1, '05 Aug 2026', 'ROW', '12345678901234567.89', '900.00'),
      ]),
    ];
    const result = parseStatement(inKotakSavings, pages);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('row 1 has an unreadable amount');
  });

  it('refuses an enormous identical amount/balance token pair rather than let Infinity === Infinity verify', () => {
    const huge = `${'9'.repeat(900)}.00`; // overflows to Infinity when parsed; line stays under the 2000-char cap
    const pages = [
      page([HEADER_LINE, openingLine('1000.00'), rowLine(1, '05 Aug 2026', 'ROW', huge, huge)]),
    ];
    const result = parseStatement(inKotakSavings, pages);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('row 1 has an unreadable amount');
  });

  it('refuses more than 200 pages before doing any per-line work', () => {
    const pages = Array.from({ length: 201 }, () => '');
    const result = parseStatement(inKotakSavings, pages);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('statement has too many pages');
  });

  it('refuses more than 5000 rows (generated cheaply, no fixture helper)', () => {
    const lines = [HEADER_LINE, openingLine('100.00')];
    let balanceCents = 10_000; // $100.00
    const rowCount = 5001;
    for (let i = 1; i <= rowCount; i++) {
      const expense = i % 2 === 1;
      balanceCents = expense ? balanceCents - 100 : balanceCents + 100; // +/- $1.00
      lines.push(rowLine(i, '05 Aug 2026', `ROW ${i}`, '1.00', (balanceCents / 100).toFixed(2)));
    }
    const result = parseStatement(inKotakSavings, [page(lines)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('statement has more than 5000 rows');
  });
});

// ---------------------------------------------------------------------------
// toStatementRowInputs
// ---------------------------------------------------------------------------

describe('toStatementRowInputs', () => {
  it('maps each field to {value, confidence: 1}, category always {null, 0}', () => {
    const rows: PackRow[] = [
      {
        date: '2026-08-01',
        description: 'SYNTH MART',
        amount: 45.5,
        type: 'expense',
        balance: 954.5,
        serial: 1,
      },
    ];
    expect(toStatementRowInputs(rows)).toEqual([
      {
        date: { value: '2026-08-01', confidence: 1 },
        merchant: { value: 'SYNTH MART', confidence: 1 },
        amount: { value: 45.5, confidence: 1 },
        type: { value: 'expense', confidence: 1 },
        category: { value: null, confidence: 0 },
      },
    ]);
  });

  it('maps an empty row list to an empty list', () => {
    expect(toStatementRowInputs([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validatePack — one test per rule
// ---------------------------------------------------------------------------

function basePack(): StatementPack {
  return structuredClone(inKotakSavings);
}

describe('validatePack', () => {
  it('rejects a non-object', () => {
    expect(validatePack(null)).not.toBeNull();
    expect(validatePack('a pack')).not.toBeNull();
    expect(validatePack([1, 2, 3])).not.toBeNull();
  });

  // ReDoS gate (sprint 19): local packs made every pack regex USER-AUTHORED
  // data the client executes — the catastrophic-backtracking shape (a
  // repeated group whose body itself quantifies or alternates) is rejected
  // at validation, which also armors the S20 community-PR CI for free.
  describe('catastrophic-quantifier rejection', () => {
    it('rejects the classic (a+)+ in a table regex, naming the field', () => {
      const pack = basePack();
      pack.table.furniture = ['^([0-9]+)+$'];
      expect(validatePack(pack)).toBe(
        'table.furniture entry must not repeat a quantified group (catastrophic backtracking risk)',
      );
    });

    it('rejects a repeated alternation group (a|b)* in a signature', () => {
      const pack = basePack();
      pack.signature = ['^(Dr|Cr)*$'];
      expect(validatePack(pack)).toBe(
        'signature entry must not repeat a quantified group (catastrophic backtracking risk)',
      );
    });

    it('rejects the nested-hidden form ((a+)?)* — marks propagate outward', () => {
      const pack = basePack();
      pack.table.headerLine = '^((x+)?)*$';
      expect(validatePack(pack)).toBe(
        'table.headerLine must not repeat a quantified group (catastrophic backtracking risk)',
      );
    });

    it('rejects a brace-repeated quantified group (\\d+){2,}', () => {
      const pack = basePack();
      pack.table.rowTail =
        '(?:^|\\s)(?<amount>[\\d,]+\\.\\d{2})\\s{2,}(?<balance>[\\d,]+\\.\\d{2})(\\d+){2,}$';
      expect(validatePack(pack)).toBe(
        'table.rowTail must not repeat a quantified group (catastrophic backtracking risk)',
      );
    });

    it('keeps an OPTIONAL group containing a quantifier — (?:x+)? cannot repeat', () => {
      const pack = basePack();
      // An optional trailing column is a legitimate grammar shape.
      pack.table.rowTail =
        '(?:^|\\s)(?<amount>[\\d,]+\\.\\d{2})\\s{2,}(?<balance>[\\d,]+\\.\\d{2})(?:\\s+\\S+)?$';
      expect(validatePack(pack)).toBeNull();
    });

    it('a quantifier-in-class is literal text, never the rejected shape', () => {
      const pack = basePack();
      pack.table.furniture = ['^[+*]+ notes$'];
      expect(validatePack(pack)).toBeNull();
    });
  });

  it('rejects an unknown top-level key', () => {
    const pack = { ...basePack(), extra: true };
    expect(validatePack(pack)).toBe('unknown top-level key "extra"');
  });

  it('rejects spec !== 1', () => {
    const pack = { ...basePack(), spec: 2 };
    expect(validatePack(pack)).toBe('spec must be exactly 1');
  });

  it('rejects a malformed id', () => {
    const pack = { ...basePack(), id: 'Not-Valid' };
    expect(validatePack(pack)).toMatch(/^id must match/);
  });

  it('rejects a malformed country', () => {
    const pack = { ...basePack(), country: 'IN' };
    expect(validatePack(pack)).toMatch(/^country must match/);
  });

  it('rejects a malformed currency', () => {
    const pack = { ...basePack(), currency: 'inr' };
    expect(validatePack(pack)).toMatch(/^currency must match/);
  });

  it('rejects an empty name', () => {
    const pack = { ...basePack(), name: '   ' };
    expect(validatePack(pack)).toBe('name must be a non-empty string');
  });

  it('rejects an empty signature array', () => {
    const pack = { ...basePack(), signature: [] };
    expect(validatePack(pack)).toBe('signature must be a non-empty string array');
  });

  it('rejects a signature entry that fails to compile as a RegExp', () => {
    const pack = { ...basePack(), signature: ['(unterminated'] };
    expect(validatePack(pack)).toBe('signature entry must be a string that compiles as a RegExp');
  });

  it('rejects an unsupported dateFormat', () => {
    const pack = { ...basePack(), dateFormat: 'yyyy/dd/MM' };
    expect(validatePack(pack)).toBe('dateFormat must be a supported format');
  });

  it('rejects an unsupported direction', () => {
    const pack = { ...basePack(), direction: 'signed-amount' };
    expect(validatePack(pack)).toBe('direction must be a supported direction');
  });

  it('rejects a non-array verify', () => {
    const pack = { ...basePack(), verify: 'balance-chain' };
    expect(validatePack(pack)).toBe('verify must be an array');
  });

  it('rejects an unsupported verify entry', () => {
    const pack = { ...basePack(), verify: ['balance-chain', 'nonsense'] };
    expect(validatePack(pack)).toBe('verify entries must be supported verification chains');
  });

  it('rejects duplicate verify entries', () => {
    const pack = { ...basePack(), verify: ['balance-chain', 'balance-chain'] };
    expect(validatePack(pack)).toBe('verify entries must be unique');
  });

  it('rejects a non-object table', () => {
    const pack = { ...basePack(), table: 'nope' };
    expect(validatePack(pack)).toBe('table must be an object');
  });

  it('rejects an unknown table-level key', () => {
    const pack = { ...basePack(), table: { ...basePack().table, extra: true } };
    expect(validatePack(pack)).toBe('unknown table-level key "extra"');
  });

  it('rejects a headerLine that fails to compile', () => {
    const pack = { ...basePack(), table: { ...basePack().table, headerLine: '(unterminated' } };
    expect(validatePack(pack)).toBe('table.headerLine must be a string that compiles as a RegExp');
  });

  it('rejects an openingBalanceLine that fails to compile', () => {
    const pack = {
      ...basePack(),
      table: { ...basePack().table, openingBalanceLine: '(unterminated' },
    };
    expect(validatePack(pack)).toBe('table.openingBalanceLine must be a string that compiles as a RegExp');
  });

  it('rejects a rowStart that fails to compile', () => {
    const pack = { ...basePack(), table: { ...basePack().table, rowStart: '(unterminated' } };
    expect(validatePack(pack)).toBe('table.rowStart must be a string that compiles as a RegExp');
  });

  it('rejects a rowTail that fails to compile', () => {
    const pack = { ...basePack(), table: { ...basePack().table, rowTail: '(unterminated' } };
    expect(validatePack(pack)).toBe('table.rowTail must be a string that compiles as a RegExp');
  });

  it('rejects a non-array furniture, and a furniture entry that fails to compile', () => {
    const notArray = { ...basePack(), table: { ...basePack().table, furniture: 'nope' } };
    expect(validatePack(notArray)).toBe('table.furniture must be a string array');

    const badEntry = { ...basePack(), table: { ...basePack().table, furniture: ['(unterminated'] } };
    expect(validatePack(badEntry)).toBe('table.furniture entries must be strings that compile as a RegExp');
  });

  it('rejects a rowStart missing the "date" named group', () => {
    const pack = {
      ...basePack(),
      table: {
        ...basePack().table,
        rowStart: '^(?<serial>\\d{1,5})\\s{2,}(?<rest>.*\\S)\\s*$',
      },
    };
    expect(validatePack(pack)).toBe('table.rowStart must declare a "date" named group');
  });

  it('rejects a rowStart missing the "rest" named group', () => {
    const pack = {
      ...basePack(),
      table: {
        ...basePack().table,
        rowStart: '^(?<serial>\\d{1,5})\\s{2,}(?<date>\\d{2} [A-Z][a-z]{2} \\d{4})\\s*$',
      },
    };
    expect(validatePack(pack)).toBe('table.rowStart must declare a "rest" named group');
  });

  it('is not fooled by a fake named group written inside a character class', () => {
    const pack = {
      ...basePack(),
      table: {
        ...basePack().table,
        // `[(?<balance>]` is a character class matching one of those nine
        // literal characters -- no capture group at all. The only REAL
        // group here is `amount`.
        rowTail: '(?<amount>[\\d,]+\\.\\d{2})[(?<balance>]\\s*$',
      },
    };
    expect(validatePack(pack)).toBe(
      'direction "balance-delta" requires a "balance" named group in table.rowTail',
    );
  });

  it('is not fooled by a fake named group written after a backslash escape', () => {
    const pack = {
      ...basePack(),
      table: {
        ...basePack().table,
        // `\(?<balance>` is an escaped literal "(" (optional) followed by
        // literal text "<balance>" -- not a capture group.
        rowTail: '(?<amount>[\\d,]+\\.\\d{2})\\(?<balance>\\s*$',
      },
    };
    expect(validatePack(pack)).toBe(
      'direction "balance-delta" requires a "balance" named group in table.rowTail',
    );
  });

  it('rejects a rowTail missing the "amount" named group', () => {
    const pack = {
      ...basePack(),
      table: { ...basePack().table, rowTail: '(?<balance>[\\d,]+\\.\\d{2})\\s*$' },
    };
    expect(validatePack(pack)).toBe('table.rowTail must declare an "amount" named group');
  });

  it('rejects direction "balance-delta" without "balance-chain" in verify', () => {
    const pack = { ...basePack(), verify: ['serial-chain'] };
    expect(validatePack(pack)).toBe('direction "balance-delta" requires "balance-chain" in verify');
  });

  it('rejects direction "balance-delta" without table.openingBalanceLine', () => {
    const base = basePack();
    const { openingBalanceLine: _drop, ...tableWithoutOpening } = base.table;
    const pack = { ...base, table: tableWithoutOpening };
    expect(validatePack(pack)).toBe('direction "balance-delta" requires table.openingBalanceLine');
  });

  it('rejects direction "balance-delta" without a "balance" named group in rowTail', () => {
    const pack = {
      ...basePack(),
      table: { ...basePack().table, rowTail: '(?<amount>[\\d,]+\\.\\d{2})\\s*$' },
    };
    expect(validatePack(pack)).toBe(
      'direction "balance-delta" requires a "balance" named group in table.rowTail',
    );
  });

  it('rejects "serial-chain" in verify without a "serial" named group in rowStart', () => {
    const pack = {
      ...basePack(),
      table: {
        ...basePack().table,
        rowStart: '^(?<date>\\d{2} [A-Z][a-z]{2} \\d{4})\\s{2,}(?<rest>.*\\S)\\s*$',
      },
    };
    expect(validatePack(pack)).toBe(
      '"serial-chain" in verify requires a "serial" named group in table.rowStart',
    );
  });

  it('accepts the bundled Kotak pack unchanged', () => {
    expect(validatePack(basePack())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectPack
// ---------------------------------------------------------------------------

describe('detectPack', () => {
  it('matches the one pack whose full signature is satisfied', () => {
    const pages = generateSyntheticStatement({
      openingBalance: 1000,
      rows: [{ date: '2026-08-01', description: 'SYNTH MART', amount: 10, type: 'expense' }],
    });
    expect(detectPack(pages, [inKotakSavings])).toBe(inKotakSavings);
  });

  it('returns null when no pack matches', () => {
    expect(detectPack(['nothing resembling any bank statement here'], [inKotakSavings])).toBeNull();
  });

  it('returns null on ambiguity — two packs both match', () => {
    const pages = generateSyntheticStatement({
      openingBalance: 1000,
      rows: [{ date: '2026-08-01', description: 'SYNTH MART', amount: 10, type: 'expense' }],
    });
    const decoy: StatementPack = {
      ...structuredClone(inKotakSavings),
      id: 'in.decoy.savings',
      signature: ['IFSC Code\\s+KKBK'], // deliberately overlaps the real pack's signature
    };
    expect(detectPack(pages, [inKotakSavings, decoy])).toBeNull();
  });

  it('returns null for empty or missing pages', () => {
    expect(detectPack([], [inKotakSavings])).toBeNull();
    expect(detectPack([''], [inKotakSavings])).toBeNull();
  });
});
