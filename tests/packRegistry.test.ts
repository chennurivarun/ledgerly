import { describe, expect, it } from 'vitest';
import { detectPack, parseStatement, validatePack } from '../shared/packs/engine';
import { STATEMENT_PACKS, statementPackById } from '../shared/packs/registry';
import { inKotakSavings } from '../shared/packs/packs/in-kotak-savings';
import { generateSyntheticStatement } from './helpers/syntheticStatement';

describe('STATEMENT_PACKS', () => {
  it('every bundled pack passes validatePack', () => {
    for (const pack of STATEMENT_PACKS) {
      expect(validatePack(pack)).toBeNull();
    }
  });

  it('has unique ids', () => {
    const ids = STATEMENT_PACKS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is non-empty and includes the Kotak reference pack', () => {
    expect(STATEMENT_PACKS.length).toBeGreaterThan(0);
    expect(STATEMENT_PACKS).toContain(inKotakSavings);
  });
});

describe('statementPackById', () => {
  it('finds a bundled pack by id', () => {
    expect(statementPackById('in.kotak.savings')).toBe(inKotakSavings);
  });

  it('returns null for an unknown id', () => {
    expect(statementPackById('zz.nobank.nothing')).toBeNull();
  });
});

describe('in.kotak.savings pack — detection and end-to-end parse against the synthetic fixture', () => {
  it("the fixture generator's page 1 satisfies every signature regex", () => {
    const pages = generateSyntheticStatement({
      openingBalance: 50000,
      rows: [{ date: '2026-08-01', description: 'SYNTH MART', amount: 500, type: 'expense' }],
    });
    for (const source of inKotakSavings.signature) {
      expect(new RegExp(source, 'm').test(pages[0])).toBe(true);
    }
  });

  it('detectPack picks it uniquely from the bundled registry', () => {
    const pages = generateSyntheticStatement({
      openingBalance: 50000,
      rows: [{ date: '2026-08-01', description: 'SYNTH MART', amount: 500, type: 'expense' }],
    });
    expect(detectPack(pages, STATEMENT_PACKS)).toBe(inKotakSavings);
  });

  it('end-to-end: generator fixture -> detectPack -> parseStatement -> rows equal the seeds exactly', () => {
    const seeds = [
      { date: '2026-08-01', description: 'SYNTH MART', amount: 500, type: 'expense' as const },
      { date: '2026-08-03', description: 'SYNTH PAYROLL', amount: 200000, type: 'income' as const },
      {
        date: '2026-08-05',
        description: 'UPI SYNTH STORES 000000000000 payment',
        amount: 1234.5,
        type: 'expense' as const,
        layout: 'wrapped' as const,
      },
    ];
    const pages = generateSyntheticStatement({ openingBalance: 100000, rows: seeds });

    const pack = detectPack(pages, STATEMENT_PACKS);
    expect(pack).toBe(inKotakSavings);

    const result = parseStatement(pack!, pages);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.rows).toHaveLength(seeds.length);

    // Cents-integer arithmetic throughout, matching the engine exactly —
    // avoids any float-rounding mismatch between test expectations and the
    // engine's own cents/100 divisions.
    let balanceCents = 10000000;
    for (let i = 0; i < seeds.length; i++) {
      const seed = seeds[i];
      const amountCents = Math.round(seed.amount * 100);
      balanceCents = seed.type === 'expense' ? balanceCents - amountCents : balanceCents + amountCents;
      expect(result.rows[i]).toEqual({
        date: seed.date,
        description: seed.description,
        amount: amountCents / 100,
        type: seed.type,
        balance: balanceCents / 100,
        serial: i + 1,
      });
    }
  });
});
