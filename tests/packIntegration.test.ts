// Sprint 18 cross-lane integration: the REAL engine (lane A) driven through
// the REAL browser decision logic (lane B) on the REAL bundled registry —
// the one seam neither lane's own suite could cover, since lane B mocked the
// engine (its worktree had stubs) and lane A never touched the client flow.
// Only the worker API is mocked: everything from page text to the finalize
// payload is the shipping code path.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/api', () => ({
  api: {
    beginStatementPages: vi.fn(),
    finalizeStatementPages: vi.fn(),
    abortStatementPages: vi.fn(),
    statementPagesRound: vi.fn(),
  },
}));

import { api } from '../src/api';
import { createCancelToken, runPackRead } from '../src/components/ai/clientPages';
import { inKotakSavings } from '../shared/packs/packs/in-kotak-savings';
import { STATEMENT_PACKS } from '../shared/packs/registry';
import { generateSyntheticStatement } from './helpers/syntheticStatement';
import type { StatementExtraction } from '../shared/types';

const begin = vi.mocked(api.beginStatementPages);
const finalize = vi.mocked(api.finalizeStatementPages);
const abort = vi.mocked(api.abortStatementPages);
const round = vi.mocked(api.statementPagesRound);

const SETTLED = { documentId: 'doc-1', status: 'suggested' } as unknown as StatementExtraction;

/** A small statement exercising the grammar's hard shapes: wrapped rows, a
 * mid-token wrap, both directions, indian grouping, and a page break landing
 * INSIDE a wrapped row's line run. All data synthetic. */
function fixture(): string[] {
  return generateSyntheticStatement({
    openingBalance: 6078.87,
    rows: [
      { date: '2026-01-01', description: 'UPI/SYNTH STORES/000000000001/Payment from Ph', amount: 185, type: 'expense', layout: 'wrapped' },
      { date: '2026-01-01', description: 'NEFT SYNTH SALARY CREDIT JANUARY', amount: 125000, type: 'income', layout: 'single' },
      { date: '2026-01-02', description: 'UPI/SYNTH MART/000000000002/Groceries run', amount: 3704.5, type: 'expense', layout: 'wrapped-mid-token' },
      { date: '2026-01-03', description: 'SYNTH CASHBACK EARNED', amount: 1, type: 'income', layout: 'single' },
    ],
    grouping: 'indian',
    breakAfterLines: [4],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  begin.mockResolvedValue({ ok: true, runId: 'run-integration' });
  finalize.mockResolvedValue(SETTLED);
});

describe('pack read end-to-end (real engine, real registry, real fixture)', () => {
  it('detects the Kotak pack, verifies, claims with its id, and finalizes converted rows', async () => {
    const labels: string[] = [];
    const result = await runPackRead(
      'doc-1',
      fixture(),
      STATEMENT_PACKS,
      false,
      (l: string) => labels.push(l),
      createCancelToken(),
    );

    expect(result).toBe(SETTLED);
    expect(begin).toHaveBeenCalledWith('doc-1', inKotakSavings.id);
    expect(round).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    expect(labels).toContain(`Reading with the ${inKotakSavings.name} pack…`);

    const payload = finalize.mock.calls[0][1] as {
      rows: {
        date: { value: string; confidence: number };
        merchant: { value: string; confidence: number };
        amount: { value: number; confidence: number };
        type: { value: string; confidence: number };
        category: { value: null; confidence: number };
      }[];
      truncated: boolean;
      runId: string;
    };
    expect(payload.truncated).toBe(false);
    expect(payload.runId).toBe('run-integration');
    expect(payload.rows).toHaveLength(4);
    // Chain-verified structure arrives at confidence 1; category is left for
    // the enrichment layer at confidence 0 — the toStatementRowInputs pin,
    // proven here through the real converter on real parse output.
    expect(payload.rows[0]).toEqual({
      date: { value: '2026-01-01', confidence: 1 },
      merchant: { value: 'UPI/SYNTH STORES/000000000001/Payment from Ph', confidence: 1 },
      amount: { value: 185, confidence: 1 },
      type: { value: 'expense', confidence: 1 },
      category: { value: null, confidence: 0 },
    });
    expect(payload.rows[1].amount.value).toBe(125000);
    expect(payload.rows[1].type.value).toBe('income');
    expect(payload.rows[2].amount.value).toBe(3704.5);
    expect(payload.rows[3].type.value).toBe('income');
  });

  it('a corrupted balance chain refuses through the REAL engine — nothing is ever claimed', async () => {
    const pages = fixture();
    // Tamper one balance token: bump a digit in the last money token of the
    // final table line. The engine's balance chain must catch it.
    const tampered = pages.map((page, i) =>
      i === pages.length - 1 ? page.replace(/(\d)(\.\d{2})(?!.*\d\.\d{2})/s, (_, d, tail) => `${(Number(d) + 1) % 10}${tail}`) : page,
    );

    const result = await runPackRead('doc-1', tampered, STATEMENT_PACKS, false, () => undefined, createCancelToken());

    expect(result).toMatchObject({ outcome: 'no-pack' });
    expect((result as { reason: string | null }).reason).toMatch(/balance chain/);
    // Structural reason only — never statement content.
    expect((result as { reason: string }).reason).not.toMatch(/SYNTH|UPI|\d\.\d{2}/);
    expect(begin).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  });

  it('a truncated extraction settles the pack read as truncated (loud partial, never silent)', async () => {
    await runPackRead('doc-1', fixture(), STATEMENT_PACKS, true, () => undefined, createCancelToken());
    expect((finalize.mock.calls[0][1] as { truncated: boolean }).truncated).toBe(true);
  });
});
