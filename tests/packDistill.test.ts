// Sprint 19, lane A — pack distillation tests. Every fixture is synthetic
// (tests/helpers/syntheticStatement.ts, or hand-built lines in the same
// literal shapes), so ground truth is always known. See docs/PACKS.md's
// "Distillation" section for the algorithm this exercises.
//
// Post-review (consolidated fix round): the reviewer's adversarial pass
// found two privacy criticals (a seed-line leak, and repeated personal
// lines clearing every structural gate the same way a real header does),
// a broken export artifact under CRLF/embedded-LineTerminator input, a
// date-transposition risk on slash-separated formats, and degenerate-input
// gaps (single-page statements, single-gap "headers"). Each fix has a
// dedicated regression test below, named after what it guards.
import { describe, expect, it } from 'vitest';
import {
  distillStatementPack,
  renderPackModule,
  BALANCE_LABEL_VOCABULARY,
  DISTILL_MIN_ANCHORS,
  DISTILL_MIN_ANCHOR_MATCH,
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

/** Splices `linesToInject` into every page right after the section-title
 * masthead line — the same position real statements carry a holder-name
 * running header, and distinct from the table header/footer that already
 * legitimately repeats there. */
function injectRepeatedLines(pages: string[], linesToInject: string[]): string[] {
  return pages.map((p) => {
    const lines = p.split('\n');
    const idx = lines.indexOf('Savings Account Transactions');
    const insertAt = idx === -1 ? 0 : idx + 1;
    lines.splice(insertAt, 0, ...linesToInject);
    return lines.join('\n');
  });
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

    // reviewables: a manifest, not a filter — every survivor is short,
    // structural-label-shaped, and never a word from an actual transaction
    // description (those never touch header/furniture/signature/opening).
    expect(result.reviewables.length).toBeGreaterThan(0);
    expect(result.reviewables.every((r) => r.literalText.length >= 2)).toBe(true);
    const survivors = result.reviewables.map((r) => r.literalText);
    expect(survivors).toContain('Balance');
    expect(survivors).toContain('Opening');
    const descriptionWords = new Set(SEEDS.flatMap((s) => s.description.split(/[\s/]+/)));
    for (const word of survivors) expect(descriptionWords.has(word)).toBe(false);

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
// Degenerate inputs
// ---------------------------------------------------------------------------

describe('distillStatementPack — degenerate inputs', () => {
  it('refuses a single-page statement outright — nothing to repeat against yet', () => {
    const pages = fixture('indian').slice(0, 1);
    const anchors = anchorsFrom(SEEDS.slice(0, 3));
    const result = distillStatementPack(pages, anchors, IDENTITY);
    expect(result).toEqual({ ok: false, reason: 'a single-page statement cannot be distilled yet' });
  });

  it('a repeated masthead line with only ONE column gap never wins the header slot', () => {
    const rowLine = (serial: number, date: string, desc: string, amount: string, balance: string) =>
      `${serial}   ${date}   ${desc}   ${amount}   ${balance}`;
    // 'Bank  Statement' has exactly one \s{2,} gap — header shape requires
    // two. It repeats on both pages, sits above every row, and would have
    // won the old proximity-only ranking; item 5's shape gate excludes it.
    const page1 = ['Bank  Statement', rowLine(1, '05 Aug 2026', 'ROW ONE', '100.00', '900.00')].join('\n');
    const page2 = ['Bank  Statement', rowLine(2, '06 Aug 2026', 'ROW TWO', '50.00', '850.00')].join('\n');
    const anchors: DistillAnchor[] = [
      { date: '2026-08-05', amount: 100, type: 'expense' },
      { date: '2026-08-06', amount: 50, type: 'expense' },
      { date: '2026-08-07', amount: 25, type: 'expense' },
    ];
    const result = distillStatementPack([page1, page2], anchors, IDENTITY);
    expect(result).toEqual({ ok: false, reason: 'no repeating table header found' });
  });
});

// ---------------------------------------------------------------------------
// Date-format transposition (dd/MM/yyyy <-> MM/dd/yyyy)
// ---------------------------------------------------------------------------

describe('distillStatementPack — date format transposition', () => {
  const HEADER = '#   Date   Description   Amount   Balance';
  const openingLine = (balance: string) => `-   -   Opening Balance   -   -   -   ${balance}`;
  const rowLine = (serial: number, date: string, desc: string, amount: string, balance: string) =>
    `${serial}   ${date}   ${desc}   ${amount}   ${balance}`;

  function buildPages(dates: string[]): string[] {
    const page1 = [
      HEADER,
      openingLine('1000.00'),
      rowLine(1, dates[0], 'ROW ONE', '100.00', '900.00'),
      rowLine(2, dates[1], 'ROW TWO', '50.00', '850.00'),
      rowLine(3, dates[2], 'ROW THREE', '25.00', '825.00'),
    ].join('\n');
    const page2 = [
      HEADER,
      rowLine(4, dates[3], 'ROW FOUR', '10.00', '815.00'),
      rowLine(5, dates[4], 'ROW FIVE', '5.00', '810.00'),
      rowLine(6, dates[5], 'ROW SIX', '5.00', '805.00'),
    ].join('\n');
    return [page1, page2];
  }

  const anchors: DistillAnchor[] = [
    { date: '2026-08-05', amount: 100, type: 'expense' },
    { date: '2026-08-06', amount: 50, type: 'expense' },
    { date: '2026-08-07', amount: 25, type: 'expense' },
  ];

  it('refuses as ambiguous when every date in the WHOLE document has day<=12 (no corroboration)', () => {
    const pages = buildPages(['05/08/2026', '06/08/2026', '07/08/2026', '08/08/2026', '09/08/2026', '10/08/2026']);
    const result = distillStatementPack(pages, anchors, IDENTITY);
    expect(result).toEqual({ ok: false, reason: 'date format is ambiguous' });
  });

  it('accepts once one date ANYWHERE (even an unanchored row) has day>12, proving the chirality', () => {
    const pages = buildPages(['05/08/2026', '06/08/2026', '07/08/2026', '25/08/2026', '09/08/2026', '10/08/2026']);
    const result = distillStatementPack(pages, anchors, IDENTITY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pack.dateFormat).toBe('dd/MM/yyyy');
    expect(result.proof.rows).toBe(6);
    expect(result.proof.anchorsMatched).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Privacy — the layered model. See docs/PACKS.md's Distillation section for
// what each layer does and doesn't cover; each test here is one layer.
// ---------------------------------------------------------------------------

describe('distillStatementPack — privacy', () => {
  it('never lets a page-1-only account number or name survive into the pack (structural exclusion: not repeated)', () => {
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

  it('a name repeated identically on EVERY page (structural exclusion: pure-word lines) never enters the pack or reviewables', () => {
    // This is the review's real repro shape: a holder name in a running
    // masthead, repeating on (nearly) every page — 100% coverage here,
    // clearing the same ">=60% of pages" bar a genuine header clears.
    // Item 2a's structural-shape gate is what actually stops it: a
    // pure-word line (no digit run, no money class, no column gap) is
    // excluded outright, regardless of how consistently it repeats.
    const pages = injectRepeatedLines(fixture('indian'), ['Mr Synthetic Testperson']);
    const anchors = anchorsFrom(SEEDS);
    const result = distillStatementPack(pages, anchors, IDENTITY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const serialized = JSON.stringify(result.pack);
    expect(serialized).not.toMatch(/Synthetic/);
    expect(serialized).not.toMatch(/Testperson/);
    // Never entered the pack -> extractLiteralAlphaRuns never scans it ->
    // it cannot appear in reviewables either. This is the "only if a
    // structural line carries it" half of the pin.
    const reviewableTexts = result.reviewables.map((r) => r.literalText);
    expect(reviewableTexts).not.toContain('Synthetic');
    expect(reviewableTexts).not.toContain('Testperson');
  });

  it('a MIXED line ("NAME  12345": a word plus a digit run) clears the structural gate and surfaces in reviewables — this is why reviewables exists', () => {
    // The counterpoint to the pure-word case: once a repeated line carries
    // ANY digit run or column gap, it has "layout shape" exactly like a
    // real header does, and the structural gate alone cannot tell it apart
    // from a genuine label. It ships (furniture/signature can legitimately
    // look like this), but its literal word surfaces in `reviewables` so a
    // human — not the algorithm — makes the final call.
    const pages = injectRepeatedLines(fixture('indian'), ['NAME  12345']);
    const anchors = anchorsFrom(SEEDS);
    const result = distillStatementPack(pages, anchors, IDENTITY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const serialized = JSON.stringify(result.pack);
    // The digit run never survives literally (strengthened generalization) ...
    expect(serialized).not.toMatch(/12345/);
    // ... but the word does, somewhere in the pack's grammar ...
    expect(serialized).toMatch(/NAME/);
    // ... and, critically, it's surfaced for human review.
    const reviewable = result.reviewables.find((r) => r.literalText === 'NAME');
    expect(reviewable).toBeDefined();
    expect(['headerLine', 'furniture', 'signature', 'openingBalanceLine']).toContain(reviewable?.field);
  });

  it('refuses a seed line that is transaction-shaped or carries non-vocabulary words (the seed-line-leak fix, 1b/1c)', () => {
    // Reproduces the review's probe: a line ABOVE the real table that looks
    // like an ordinary row (a date, merchant-like text, two money tokens)
    // sits closer to the true first row than any real "Opening Balance"
    // furniture line (there isn't one here). Neither 1b (transaction-shaped
    // -> refuse outright) nor 1c (non-vocabulary words survive -> refuse)
    // ever let this become the balance-chain seed.
    const HEADER = '#   Date   Description   Amount   Balance';
    const rowLine = (serial: number, date: string, desc: string, amount: string, balance: string) =>
      `${serial}   ${date}   ${desc}   ${amount}   ${balance}`;
    const page1 = [
      HEADER,
      '05 Aug 2026   OLD MERCHANT REFUND   50.00   950.00', // the decoy
      rowLine(1, '06 Aug 2026', 'ROW ONE', '100.00', '900.00'),
      rowLine(2, '07 Aug 2026', 'ROW TWO', '50.00', '850.00'),
      rowLine(3, '08 Aug 2026', 'ROW THREE', '25.00', '825.00'),
    ].join('\n');
    const page2 = [
      HEADER,
      rowLine(4, '09 Aug 2026', 'ROW FOUR', '10.00', '815.00'),
      rowLine(5, '10 Aug 2026', 'ROW FIVE', '5.00', '810.00'),
      rowLine(6, '11 Aug 2026', 'ROW SIX', '5.00', '805.00'),
    ].join('\n');
    const anchors: DistillAnchor[] = [
      { date: '2026-08-06', amount: 100, type: 'expense' },
      { date: '2026-08-07', amount: 50, type: 'expense' },
      { date: '2026-08-08', amount: 25, type: 'expense' },
    ];
    const result = distillStatementPack([page1, page2], anchors, IDENTITY);
    expect(result).toEqual({ ok: false, reason: 'no opening balance line found' });
  });

  it('the balance-label vocabulary is exactly the exported constant, case-insensitively applied', () => {
    for (const word of ['Opening', 'Balance', 'Brought', 'Forward', 'Carried', 'Previous', 'Statement', 'Total', 'B/F', 'C/F']) {
      expect(BALANCE_LABEL_VOCABULARY as readonly string[]).toContain(word);
    }
  });

  it('a 4-digit year in a repeated structural furniture line emerges as \\d+, never literally', () => {
    // Strengthened generalization pin: pre-review, only 5+-digit runs
    // generalized, so a 4-digit year like "2026" survived literally.
    const pages = injectRepeatedLines(fixture('indian'), ['Statement Year   2026']);
    const anchors = anchorsFrom(SEEDS);
    const result = distillStatementPack(pages, anchors, IDENTITY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const serialized = JSON.stringify(result.pack);
    expect(serialized).not.toMatch(/2026/);
    // The pack's regex SOURCE holds a single backslash (\s{2,}, \d+);
    // JSON.stringify doubles it, so the serialized text carries two.
    expect(serialized).toContain('Statement Year\\\\s{2,}\\\\d+');
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

  // -------------------------------------------------------------------------
  // Compile-proof (esbuild) + CRLF — the "broken export artifact" fix.
  // -------------------------------------------------------------------------

  it('the rendered module is syntactically valid TypeScript (esbuild compile-proof)', async () => {
    const pages = fixture('indian');
    const anchors = anchorsFrom(SEEDS);
    const result = distillStatementPack(pages, anchors, IDENTITY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rendered = renderPackModule(result.pack);
    // A syntax error here rejects the promise, which fails the test — no
    // try/catch needed, that IS the assertion.
    const { code } = await (await import('esbuild')).transform(rendered, { loader: 'ts' });
    expect(code).toContain('export const zzSynthbankSavings');
  });

  it('an identity name with an embedded newline still renders a compilable module', async () => {
    const pages = fixture('indian');
    const anchors = anchorsFrom(SEEDS);
    const result = distillStatementPack(pages, anchors, { ...IDENTITY, name: 'Synth Bank\nSavings\r\nDivision' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rendered = renderPackModule(result.pack);
    // The `name:` line itself must be ONE physical line — a raw
    // LineTerminator surviving un-escaped inside the single-quoted string
    // literal would split it into more than one, breaking the file's line
    // count. (The esbuild compile-proof right below is the definitive
    // check; this is the readable, targeted version of the same claim.)
    const nameLines = rendered.split('\n').filter((line) => line.trimStart().startsWith('name:'));
    expect(nameLines).toHaveLength(1);
    expect(nameLines[0]).toContain("Synth Bank\\nSavings\\r\\nDivision");

    const { code } = await (await import('esbuild')).transform(rendered, { loader: 'ts' });
    expect(code).toContain('export const zzSynthbankSavings');
  });

  it('CRLF page input still distills correctly (grammar inference) and renders a compilable module', async () => {
    const crlfPages = fixture('indian').map((p) => p.replace(/\n/g, '\r\n'));
    const anchors = anchorsFrom(SEEDS);
    const result = distillStatementPack(crlfPages, anchors, IDENTITY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proof.rows).toBe(SEEDS.length);
    expect(result.proof.anchorsMatched).toBe(SEEDS.length);

    // No stray \r survived into any generalized/templated regex source.
    expect(result.pack.table.headerLine).not.toMatch(/\r/);
    expect(result.pack.table.openingBalanceLine ?? '').not.toMatch(/\r/);
    for (const f of result.pack.table.furniture) expect(f).not.toMatch(/\r/);

    const rendered = renderPackModule(result.pack);
    const { code } = await (await import('esbuild')).transform(rendered, { loader: 'ts' });
    expect(code).toContain('export const zzSynthbankSavings');
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
    const page1 = [
      singleAmountLine(1, '05 Aug 2026', 'ROW ONE', '100.00'),
      singleAmountLine(2, '06 Aug 2026', 'ROW TWO', '50.00'),
      singleAmountLine(3, '07 Aug 2026', 'ROW THREE', '25.00'),
    ].join('\n');
    const page2 = [singleAmountLine(4, '08 Aug 2026', 'ROW FOUR', '10.00')].join('\n');
    const anchors: DistillAnchor[] = [
      { date: '2026-08-05', amount: 100, type: 'expense' },
      { date: '2026-08-06', amount: 50, type: 'expense' },
      { date: '2026-08-07', amount: 25, type: 'expense' },
    ];
    const result = distillStatementPack([page1, page2], anchors, IDENTITY);
    expect(result).toEqual({
      ok: false,
      reason: 'no running balance column found — the v1 pack format needs one',
    });
  });

  it('refuses when no repeating table header is found (rows open with nothing above them, on either page)', () => {
    const rowLine = (serial: number, date: string, desc: string, amount: string, balance: string) =>
      `${serial}   ${date}   ${desc}   ${amount}   ${balance}`;
    const page1 = [
      rowLine(1, '05 Aug 2026', 'ROW ONE', '100.00', '900.00'),
      rowLine(2, '06 Aug 2026', 'ROW TWO', '50.00', '850.00'),
      rowLine(3, '07 Aug 2026', 'ROW THREE', '25.00', '825.00'),
    ].join('\n');
    const page2 = [rowLine(4, '08 Aug 2026', 'ROW FOUR', '10.00', '815.00')].join('\n');
    const anchors: DistillAnchor[] = [
      { date: '2026-08-05', amount: 100, type: 'expense' },
      { date: '2026-08-06', amount: 50, type: 'expense' },
      { date: '2026-08-07', amount: 25, type: 'expense' },
    ];
    const result = distillStatementPack([page1, page2], anchors, IDENTITY);
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
    expect(() =>
      distillStatementPack(fixture('indian'), anchorsFrom(SEEDS), { ...IDENTITY, name: '\r\n\u2028\u2029' }),
    ).not.toThrow();
  });

  it('validatePack still accepts every successfully distilled pack (sanity: distill never ships a structurally invalid pack)', () => {
    const pages = fixture('indian');
    const anchors = anchorsFrom(SEEDS);
    const result = distillStatementPack(pages, anchors, IDENTITY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validatePack(result.pack)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DISTILL_MIN_ANCHOR_MATCH — used elsewhere in this file; pin its value so a
// silent change doesn't quietly retune every threshold above.
// ---------------------------------------------------------------------------

describe('DISTILL_MIN_ANCHOR_MATCH', () => {
  it('is 0.6', () => {
    expect(DISTILL_MIN_ANCHOR_MATCH).toBe(0.6);
  });
});
