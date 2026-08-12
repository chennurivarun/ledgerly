import { describe, expect, it } from 'vitest';
import { mergeStatements } from '../src/store';
import type { StatementExtraction, StatementRow } from '../shared/types';

function fakeRows(n: number, documentId = 'doc-1'): StatementRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${documentId}-row-${i}`,
    documentId,
    index: i,
    date: { value: '2026-08-01', confidence: 0.9 },
    merchant: { value: 'Merchant', confidence: 0.9 },
    amount: { value: 10, confidence: 0.9 },
    type: { value: 'expense' as const, confidence: 0.9 },
    category: { value: null, confidence: 0 },
    status: 'proposed' as const,
    duplicate: false,
    lowestConfidence: 0.9,
  }));
}

function statement(overrides: Partial<StatementExtraction> = {}): StatementExtraction {
  return {
    documentId: 'doc-1',
    status: 'suggested',
    rowCount: 2,
    truncated: false,
    provider: 'anthropic',
    model: 'claude-opus-5',
    error: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    rows: [],
    progress: null,
    ...overrides,
  };
}

describe('mergeStatements', () => {
  it('keeps local rows when the server elides them (reviewable status, rows:[], rowCount>0, local has rows)', () => {
    const local = [statement({ rows: fakeRows(2), rowCount: 2 })];
    const incoming = [statement({ rows: [], rowCount: 2, updatedAt: '2026-08-02T00:00:00.000Z' })];
    const merged = mergeStatements(local, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0].rows).toEqual(local[0].rows);
    // Everything else still comes from the fresh incoming payload.
    expect(merged[0].updatedAt).toBe('2026-08-02T00:00:00.000Z');
  });

  it('a settled incoming status always replaces local rows, even if local had rows (post-confirm pruning)', () => {
    const local = [statement({ rows: fakeRows(2), rowCount: 2, status: 'suggested' })];
    const incoming = [statement({ rows: [], rowCount: 2, status: 'confirmed' })];
    const merged = mergeStatements(local, incoming);
    expect(merged[0].rows).toEqual([]);
    expect(merged[0].status).toBe('confirmed');
  });

  it('a settled "dismissed" incoming status also always wins over local rows', () => {
    const local = [statement({ rows: fakeRows(3), rowCount: 3, status: 'partial' })];
    const incoming = [statement({ rows: [], rowCount: 3, status: 'dismissed' })];
    const merged = mergeStatements(local, incoming);
    expect(merged[0].rows).toEqual([]);
  });

  it('a genuinely empty new job (rowCount 0) takes incoming as-is', () => {
    const local: StatementExtraction[] = [];
    const incoming = [statement({ rows: [], rowCount: 0, status: 'suggested' })];
    const merged = mergeStatements(local, incoming);
    expect(merged[0].rows).toEqual([]);
  });

  it('a non-elided reviewable job (incoming actually has rows) takes incoming rows', () => {
    const local = [statement({ rows: fakeRows(2), rowCount: 2 })];
    const incomingRows = fakeRows(3);
    const incoming = [statement({ rows: incomingRows, rowCount: 3 })];
    const merged = mergeStatements(local, incoming);
    expect(merged[0].rows).toEqual(incomingRows);
  });

  it('a brand new job with no local counterpart takes incoming as-is, even if it looks elided', () => {
    const local: StatementExtraction[] = [];
    const incoming = [statement({ documentId: 'doc-new', rows: [], rowCount: 5, status: 'partial' })];
    const merged = mergeStatements(local, incoming);
    expect(merged[0].rows).toEqual([]);
  });

  it('local rows are ignored when local itself has no rows to preserve (nothing to protect)', () => {
    const local = [statement({ rows: [], rowCount: 2 })];
    const incoming = [statement({ rows: [], rowCount: 2 })];
    const merged = mergeStatements(local, incoming);
    expect(merged[0].rows).toEqual([]);
  });

  it('drops a local statement entirely absent from incoming (e.g. its document was deleted server-side)', () => {
    const local = [statement({ rows: fakeRows(2), rowCount: 2 })];
    const merged = mergeStatements(local, []);
    expect(merged).toEqual([]);
  });

  it('merges multiple statements independently in one call', () => {
    const local = [
      statement({ documentId: 'doc-1', rows: fakeRows(2, 'doc-1'), rowCount: 2 }),
      statement({ documentId: 'doc-2', rows: fakeRows(1, 'doc-2'), rowCount: 1 }),
    ];
    const incoming = [
      statement({ documentId: 'doc-1', rows: [], rowCount: 2 }), // elided — keep local
      statement({ documentId: 'doc-2', rows: fakeRows(4, 'doc-2'), rowCount: 4 }), // fresh — take incoming
    ];
    const merged = mergeStatements(local, incoming);
    expect(merged.find((s) => s.documentId === 'doc-1')?.rows).toEqual(local[0].rows);
    expect(merged.find((s) => s.documentId === 'doc-2')?.rows).toHaveLength(4);
  });
});
