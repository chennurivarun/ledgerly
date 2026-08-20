// Sprint 19, lane A — pack distillation tests. Every fixture is synthetic
// (tests/helpers/syntheticStatement.ts, or hand-built lines in the same
// literal shapes), so ground truth is always known. See docs/PACKS.md's
// "Distillation" section for the algorithm this exercises.
import { describe, expect, it } from 'vitest';
import {
  distillStatementPack,
  renderPackModule,
  DISTILL_MIN_ANCHORS,
  type DistillAnchor,
  type DistillIdentity,
} from '../shared/packs/distill';
import { parseStatement, validatePack } from '../shared/packs/engine';
import { generateSyntheticStatement, type SyntheticRow } from './helpers/syntheticStatement';

const IDENTITY: DistillIdentity = {
  id: 'zz.synthbank.savings',
  name: 'Synth Bank — Savings',
  country: 'zz',
  currency: 'ZZZ',
};

/** 10 rows: mixed layouts (single/wrapped/wrapped-mid-token), both
 * directions, distinct dates and descriptions so no two row lines can ever
 * generalize to the same pattern. Row-aligned page breaks (no row wraps
 * across a page boundary — that seam is already proven at the engine level
 * in tests/packEngine.test.ts; this suite's job is the distiller). */
const SEEDS: SyntheticRow[] = [
  { date: '2026-08-01', description: 'SYNTH MART PURCHASE', amount: 45.5, type: 'expense', layout: 'single' },
  { date: '2026-08-02', description: 'SYNTH PAYROLL DEPOSIT', amount: 3000, type: 'income', layout: 'single' },
  {
    date: '2026-08-03',
    description: 'UPI SYNTH GENERAL STORE MONTHLY RESTOCK ORDER',
    amount: 812.25,
    type: 'expense',
    layout: 'wrapped',
  },
  { date: '2026-08-04', description: 'SYNTH UTILITY BILL PAYMENT', amount: 220, type: 'expense', layout: 'single' },
  {
    date: '2026-08-05',
    description: 'UPI/SYNTH STORES/000000000000/Payment from Phone',
    amount: 120,
    type: 'expense',
    layout: 'wrapped-mid-token',
  },
  { date: '2026-08-06', description: 'SYNTH CASHBACK EARNED', amount: 15, type: 'income', layout: 'single' },
  {
    date: '2026-08-07',
    description: 'NEFT SYNTH FREELANCE INVOICE SETTLEMENT RECEIVED',
    amount: 4500,
    type: 'income',
    layout: 'wrapped',
  },
  { date: '2026-08-08', description: 'SYNTH GROCERY RUN', amount: 63.75, type: 'expense', layout: 'single' },
  {
    date: '2026-08-09',
    description: 'UPI/SYNTH TRANSPORT/000000000001/Ride home',
    amount: 18.5,
    type: 'expense',
    layout: 'wrapped-mid-token',
  },
  { date: '2026-08-10', description: 'SYNTH INTEREST CREDIT', amount: 9.1, type: 'income', layout: 'single' },
];

// Row-aligned page breaks (line counts: single=1, wrapped=3, wrapped-mid=2):
// rows 1-3 -> lines 1-5, rows 4-7 -> lines 6-12, rows 8-10 -> lines 13-16.
const BREAKS = [5, 12];

function fixture(grouping: 'indian' | 'western' = 'indian'): string[] {
  return generateSyntheticStatement({
    openingBalance: 10000,
    rows: SEEDS,
    grouping,
    breakAfterLines: BREAKS,
  });
}

function anchorsFrom(rows: SyntheticRow[]): DistillAnchor[] {
  return rows.map((r) => ({ date: r.date, amount: r.amount, type: r.type }));
}

function expectedBalanceCents(openingCents: number, rows: SyntheticRow[]): number {
  let cents = openingCents;
  for (const r of rows) {
    const amt = Math.round(r.amount * 100);
    cents = r.type === 'expense' ? cents - amt : cents + amt;
  }
  return cents;
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe('distillStatementPack — happy paths', () => {
  it('full loop: 3-page mixed-layout fixture, all anchors -> verified pack reading every row', () => {
    const pages = fixture('indian');
    expect(pages).toHaveLength(3);
    const anchors = anchorsFrom(SEEDS);

    const result = distillStatementPack(pages, anchors, IDENTITY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.proof.rows).toBe(SEEDS.length);
    expect(result.proof.anchorsMatched).toBe(result.proof.anchorsTotal);
    expect(result.proof.anchorsTotal).toBe(SEEDS.length);
    expect(result.pack.verify).toContain('serial-chain');
    expect(result.pack.verify).toContain('balance-chain');

    // The returned pack re-parses the same fixture directly via the real
    // engine — the oracle proof, re-run outside distillStatementPack.
    const reparsed = parseStatement(result.pack, pages);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.rows).toHaveLength(SEEDS.length);
    expect(reparsed.rows[0].date).toBe(SEEDS[0].date);
    expect(reparsed.rows[reparsed.rows.length - 1].balance).toBe(
      expectedBalanceCents(1_000_000, SEEDS) / 100,
    );
  });

  it('partial anchors (real-world case): last 40% of rows still verifies the WHOLE statement', () => {
    const pages = fixture('indian');
    const lastFour = SEEDS.slice(6); // last 4 of 10 = 40%
    const anchors = anchorsFrom(lastFour);

    const result = distillStatementPack(pages, anchors, IDENTITY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The pack reads MORE than the anchors: all 10 rows, not just the 4 given.
    expect(result.proof.rows).toBe(SEEDS.length);
    expect(result.proof.anchorsMatched).toBe(anchors.length);
    expect(result.proof.anchorsTotal).toBe(anchors.length);
  });

  it('anchor noise: one wrong-amount anchor (a user edit) still verifies, matched count excludes it', () => {
    const pages = fixture('indian');
    const anchors = anchorsFrom(SEEDS);
    // Tamper anchor[5]'s amount only — a plausible review-time typo. Its date
    // and type still point at the right row, so it still helps everything
    // else (date format, row anchoring) but can't itself match a parsed row.
    anchors[5] = { ...anchors[5], amount: anchors[5].amount + 500 };

    const result = distillStatementPack(pages, anchors, IDENTITY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.proof.rows).toBe(SEEDS.length);
    expect(result.proof.anchorsTotal).toBe(10);
    expect(result.proof.anchorsMatched).toBe(9);
  });

  it('western digit grouping fixture verifies identically', () => {
    const pages = fixture('western');
    const anchors = anchorsFrom(SEEDS);

    const result = distillStatementPack(pages, anchors, IDENTITY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proof.rows).toBe(SEEDS.length);
    expect(result.proof.anchorsMatched).toBe(result.proof.anchorsTotal);
  });

  it('is deterministic: identical inputs produce deeply equal results', () => {
    const pages = fixture('indian');
    const anchors = anchorsFrom(SEEDS);
    const first = distillStatementPack(pages, anchors, IDENTITY);
    const second = distillStatementPack(pages, anchors, IDENTITY);
    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// Privacy pins — the test that guards the commons.
// ---------------------------------------------------------------------------

describe('distillStatementPack — privacy', () => {
  it('never lets a page-1-only account number or name survive into the pack', () => {
    const pages = fixture('indian');
    // Insert a person-like name line and a 10-digit account-number-like run
    // into page 1's masthead block, ABOVE the table — exactly where real
    // statements carry this kind of content, and nowhere near the table
    // header/footer that legitimately repeats across pages.
    const page1Lines = pages[0].split('\n');
    const insertAt = page1Lines.indexOf('Account Statement') + 1;
    page1Lines.splice(insertAt, 0, 'Mr Synthetic Testperson', 'Customer ID   1234567890');
    pages[0] = page1Lines.join('\n');

    const anchors = anchorsFrom(SEEDS);
    const result = distillStatementPack(pages, anchors, IDENTITY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const serialized = JSON.stringify(result.pack);
    expect(serialized).not.toMatch(/1234567890/);
    expect(serialized).not.toMatch(/Synthetic Testperson/);

    // Also true of the rendered downloadable module.
    const rendered = renderPackModule(result.pack);
    expect(rendered).not.toMatch(/1234567890/);
    expect(rendered).not.toMatch(/Synthetic Testperson/);
  });
});

// ---------------------------------------------------------------------------
// renderPackModule
// ---------------------------------------------------------------------------

/** renderPackModule emits regex sources as escaped single-quoted TS string
 * literals (so the file compiles) — a raw `.toContain(regexSource)` check
 * would fail on any pattern containing a backslash. Mirrors the escaping
 * renderPackModule itself performs. */
function asTsStringLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

describe('renderPackModule', () => {
  it('produces an SPDX-first, content-free module with the pack id/name/regexes and a camelCase export', () => {
    const pages = fixture('indian');
    const anchors = anchorsFrom(SEEDS);
    const result = distillStatementPack(pages, anchors, IDENTITY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rendered = renderPackModule(result.pack);
    const lines = rendered.split('\n');
    expect(lines[0]).toBe('// SPDX-License-Identifier: CC0-1.0');
    expect(rendered).toContain("import type { StatementPack } from '../spec';");
    expect(rendered).toContain(result.pack.id);
    expect(rendered).toContain(result.pack.name);
    expect(rendered).toContain(asTsStringLiteral(result.pack.table.headerLine));
    expect(rendered).toContain(asTsStringLiteral(result.pack.table.rowStart));
    expect(rendered).toContain(asTsStringLiteral(result.pack.table.rowTail));
    if (result.pack.table.openingBalanceLine) {
      expect(rendered).toContain(asTsStringLiteral(result.pack.table.openingBalanceLine));
    }
    expect(rendered).toContain('export const zzSynthbankSavings: StatementPack = {');
  });

  it('camelCases a hyphenated multi-segment id correctly', () => {
    const pages = fixture('indian');
    const anchors = anchorsFrom(SEEDS);
    const result = distillStatementPack(pages, anchors, { ...IDENTITY, id: 'in.my-bank.savings' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rendered = renderPackModule(result.pack);
    expect(rendered).toContain('export const inMyBankSavings: StatementPack = {');
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('distillStatementPack — refusals', () => {
  it('refuses fewer than 3 anchors', () => {
    const pages = fixture('indian');
    const anchors = anchorsFrom(SEEDS.slice(0, 2));
    expect(anchors.length).toBeLessThan(DISTILL_MIN_ANCHORS);
    const result = distillStatementPack(pages, anchors, IDENTITY);
    expect(result).toEqual({ ok: false, reason: 'fewer than 3 confirmed rows to anchor on' });
  });

  it('refuses an empty page, naming its page number only', () => {
    const pages = fixture('indian');
    pages[1] = '   ';
    const anchors = anchorsFrom(SEEDS);
    const result = distillStatementPack(pages, anchors, IDENTITY);
    expect(result).toEqual({ ok: false, reason: 'page 2 has no readable text' });
  });

  it('refuses an invalid pack identity id', () => {
    const pages = fixture('indian');
    const anchors = anchorsFrom(SEEDS);
    const result = distillStatementPack(pages, anchors, { ...IDENTITY, id: 'Not-Valid' });
    expect(result).toEqual({ ok: false, reason: 'the pack identity is invalid' });
  });

  it('refuses an invalid pack identity currency', () => {
    const pages = fixture('indian');
    const anchors = anchorsFrom(SEEDS);
    const result = distillStatementPack(pages, anchors, { ...IDENTITY, currency: 'zzz' });
    expect(result).toEqual({ ok: false, reason: 'the pack identity is invalid' });
  });

  it('refuses when no consistent date format is found (anchor dates never appear in the pages)', () => {
    const pages = fixture('indian');
    const anchors: DistillAnchor[] = [
      { date: '2030-01-01', amount: 10, type: 'expense' },
      { date: '2030-01-02', amount: 20, type: 'income' },
      { date: '2030-01-03', amount: 30, type: 'expense' },
    ];
    const result = distillStatementPack(pages, anchors, IDENTITY);
    expect(result).toEqual({ ok: false, reason: 'no consistent date format found' });
  });

  it('refuses when the table has no running balance column', () => {
    const singleAmountLine = (serial: number, date: string, desc: string, amount: string) =>
      `${serial}   ${date}   ${desc}   ${amount}`;
    const page = [
      singleAmountLine(1, '05 Aug 2026', 'ROW ONE', '100.00'),
      singleAmountLine(2, '06 Aug 2026', 'ROW TWO', '50.00'),
      singleAmountLine(3, '07 Aug 2026', 'ROW THREE', '25.00'),
    ].join('\n');
    const anchors: DistillAnchor[] = [
      { date: '2026-08-05', amount: 100, type: 'expense' },
      { date: '2026-08-06', amount: 50, type: 'expense' },
      { date: '2026-08-07', amount: 25, type: 'expense' },
    ];
    const result = distillStatementPack([page], anchors, IDENTITY);
    expect(result).toEqual({
      ok: false,
      reason: 'no running balance column found — the v1 pack format needs one',
    });
  });

  it('refuses when no repeating table header is found (rows open with nothing above them)', () => {
    const rowLine = (serial: number, date: string, desc: string, amount: string, balance: string) =>
      `${serial}   ${date}   ${desc}   ${amount}   ${balance}`;
    const page = [
      rowLine(1, '05 Aug 2026', 'ROW ONE', '100.00', '900.00'),
      rowLine(2, '06 Aug 2026', 'ROW TWO', '50.00', '850.00'),
      rowLine(3, '07 Aug 2026', 'ROW THREE', '25.00', '825.00'),
    ].join('\n');
    const anchors: DistillAnchor[] = [
      { date: '2026-08-05', amount: 100, type: 'expense' },
      { date: '2026-08-06', amount: 50, type: 'expense' },
      { date: '2026-08-07', amount: 25, type: 'expense' },
    ];
    const result = distillStatementPack([page], anchors, IDENTITY);
    expect(result).toEqual({ ok: false, reason: 'no repeating table header found' });
  });

  it('refuses when the draft cannot verify against a tampered statement', () => {
    const pages = fixture('indian');
    // Bump the very last money token in the document (the final row's
    // balance) — breaks the balance chain right at the end, after
    // structural detection (date format, header, opening balance) has
    // already succeeded on the untouched earlier rows.
    const tampered = pages.map((p, i) =>
      i === pages.length - 1
        ? p.replace(/(\d)(\.\d{2})(?!.*\d\.\d{2})/s, (_, d, tail) => `${(Number(d) + 1) % 10}${tail}`)
        : p,
    );
    const anchors = anchorsFrom(SEEDS);
    const result = distillStatementPack(tampered, anchors, IDENTITY);
    expect(result).toEqual({ ok: false, reason: 'the draft pack could not verify against this statement' });
  });

  it('never throws on malformed input', () => {
    expect(() => distillStatementPack([], [], IDENTITY)).not.toThrow();
    expect(() =>
      distillStatementPack(['x'], [{ date: 'not-a-date', amount: -5, type: 'expense' }], IDENTITY),
    ).not.toThrow();
  });
});
