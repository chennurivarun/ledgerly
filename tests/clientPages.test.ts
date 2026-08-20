// The browser half of the statement-pages flow (sprint 16, extended sprint
// 18) — the pure, DOM-free helpers: the text/image page heuristic, the round
// chunking, the image-size gate, and the pinned progress copy; plus
// runPackRead, the sprint-18 pack-detection DECISION logic (detect → parse →
// verify → claim-and-finalize), tested here against fed-in page text. The
// canvas- and pdf.js-dependent pieces (extractStatementPages and everything
// built on it — runAutoRead, runClientStatementRead's 'ai-rounds' mode) stay
// isolated behind those seams and exercised by the live smoke, not vitest —
// this file's own header has always drawn that line, and sprint 18 doesn't
// move it: shared/packs/engine is mocked HERE to pin runPackRead's decision
// logic in isolation (including how it degrades when the engine throws);
// tests/packIntegration.test.ts drives the same flow through the REAL engine.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chunkPages,
  clipPageText,
  ClientReadCancelled,
  createCancelToken,
  IMAGE_ATTEMPTS,
  IMAGE_MAX_BYTES,
  imageWithinCap,
  isTextPage,
  pagesProgressLabel,
  preparingLabel,
  runPackRead,
  TEXT_PAGE_MIN_CHARS,
} from '../src/components/ai/clientPages';
import {
  CLIENT_STATEMENT_MAX_PAGES,
  CLIENT_STATEMENT_PAGES_PER_ROUND,
  STATEMENT_PAGE_IMAGE_MAX_BYTES,
  STATEMENT_PAGE_TEXT_MAX_CHARS,
} from '../shared/types';

// The engine is mocked so these tests pin the DECISION LOGIC runPackRead
// wraps around it — what gets called, what degrades, what never claims —
// independent of parsing behavior (packIntegration.test.ts covers the
// real-engine composition).
vi.mock('../shared/packs/engine', () => ({
  detectPack: vi.fn(),
  parseStatement: vi.fn(),
  toStatementRowInputs: vi.fn(),
}));

// The worker calls a verified pack read makes — mocked because this file has
// no fetch/DOM harness, not because the module is untestable; runAutoRead's
// download step is the untestable (pdf.js/canvas) part, and isn't under test
// here.
vi.mock('../src/api', () => ({
  api: {
    beginStatementPages: vi.fn(),
    finalizeStatementPages: vi.fn(),
    abortStatementPages: vi.fn(),
    statementPagesRound: vi.fn(),
  },
}));

import { api } from '../src/api';
import { detectPack, parseStatement, toStatementRowInputs } from '../shared/packs/engine';
import { inKotakSavings } from '../shared/packs/packs/in-kotak-savings';
import type { PackRow } from '../shared/packs/spec';
import type { StatementExtraction } from '../shared/types';

describe('the text-page heuristic', () => {
  it('pins the threshold at 200 characters', () => {
    expect(TEXT_PAGE_MIN_CHARS).toBe(200);
  });

  it('exactly at the threshold is a text page; one under is an image page', () => {
    expect(isTextPage('x'.repeat(200))).toBe(true);
    expect(isTextPage('x'.repeat(199))).toBe(false);
  });

  it('whitespace does not count — a scan whose "text layer" is padding renders as an image', () => {
    expect(isTextPage(`${' '.repeat(500)}\n\n${'\t'.repeat(100)}`)).toBe(false);
    expect(isTextPage(`  ${'x'.repeat(200)}  `)).toBe(true);
  });
});

describe('clipPageText', () => {
  it('clips to the server cap so a dense page cannot 400 its round', () => {
    const long = 'x'.repeat(STATEMENT_PAGE_TEXT_MAX_CHARS + 500);
    expect(clipPageText(long)).toHaveLength(STATEMENT_PAGE_TEXT_MAX_CHARS);
    const fits = 'x'.repeat(STATEMENT_PAGE_TEXT_MAX_CHARS);
    expect(clipPageText(fits)).toBe(fits);
  });
});

describe('chunkPages', () => {
  it('23 pages → rounds of 4,4,4,4,4,3, in order', () => {
    const pages = Array.from({ length: 23 }, (_, i) => i);
    const rounds = chunkPages(pages);
    expect(rounds.map((r) => r.length)).toEqual([4, 4, 4, 4, 4, 3]);
    expect(rounds[0][0]).toBe(0);
    expect(rounds[5][2]).toBe(22);
  });

  it('an exact multiple has no ragged tail; a single page is one round', () => {
    expect(chunkPages(Array.from({ length: 16 }, (_, i) => i)).map((r) => r.length)).toEqual([4, 4, 4, 4]);
    expect(chunkPages([1]).map((r) => r.length)).toEqual([1]);
  });

  it('defaults to the shared per-round constant', () => {
    // 4, not 8 — the 2026-08-13 free-endpoint timeout incident.
    expect(CLIENT_STATEMENT_PAGES_PER_ROUND).toBe(4);
    expect(CLIENT_STATEMENT_MAX_PAGES).toBe(100);
  });
});

describe('the image-size gate', () => {
  it('the client budget stays safely under the server hard cap', () => {
    expect(IMAGE_MAX_BYTES).toBe(1.5 * 1024 * 1024);
    expect(IMAGE_MAX_BYTES).toBeLessThan(STATEMENT_PAGE_IMAGE_MAX_BYTES);
  });

  it('accepts at the budget, refuses one byte over', () => {
    expect(imageWithinCap('a'.repeat(IMAGE_MAX_BYTES))).toBe(true);
    expect(imageWithinCap('a'.repeat(IMAGE_MAX_BYTES + 1))).toBe(false);
  });

  it('the attempt ladder starts at ~1200px/0.8 and only ever steps down', () => {
    expect(IMAGE_ATTEMPTS[0]).toEqual({ width: 1200, quality: 0.8 });
    for (let i = 1; i < IMAGE_ATTEMPTS.length; i++) {
      expect(IMAGE_ATTEMPTS[i].width).toBeLessThan(IMAGE_ATTEMPTS[i - 1].width);
      expect(IMAGE_ATTEMPTS[i].quality).toBeLessThanOrEqual(IMAGE_ATTEMPTS[i - 1].quality);
    }
  });
});

describe('progress copy (pinned)', () => {
  it('a multi-page round: "Reading pages 9–16 of 23…" — en dash, 1-based', () => {
    expect(pagesProgressLabel(9, 16, 23)).toBe('Reading pages 9–16 of 23…');
  });

  it('a one-page round reads singular', () => {
    expect(pagesProgressLabel(9, 9, 23)).toBe('Reading page 9 of 23…');
  });

  it('the extraction phase: "Preparing page 3 of 23…"', () => {
    expect(preparingLabel(3, 23)).toBe('Preparing page 3 of 23…');
  });
});

describe('cancellation token', () => {
  it('starts un-cancelled, and the cancel error is its own named type', () => {
    const token = createCancelToken();
    expect(token.cancelled).toBe(false);
    const err = new ClientReadCancelled();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ClientReadCancelled');
  });
});

// ---------------------------------------------------------------------------
// runPackRead — the sprint-18 pack-detection decision: detect → parse →
// verify → claim-and-finalize, given page text already in hand (the
// pdf.js/canvas extraction step is out of vitest's reach — see the module
// header — so these tests feed text directly, exactly what runAutoRead
// hands runPackRead after extraction).
// ---------------------------------------------------------------------------

const DOC = 'doc-1';
/** Well past the 200-char text-page threshold — never triggers the
 * no-text-layer refusal by accident. */
const LONG_TEXT = 'Statement line item text that is long enough to read as a real page. '.repeat(6);

/** One chain-verified row, shaped exactly like the engine's real output. */
function packRow(overrides: Partial<PackRow> = {}): PackRow {
  return {
    date: '2026-03-04',
    description: 'ACH TRANSFER REF 12345',
    amount: 500,
    type: 'expense',
    balance: 9500,
    serial: 1,
    ...overrides,
  };
}

describe('runPackRead', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('a verified pack claims the read and finalizes with the converted rows — no rounds, ever', async () => {
    const rows = [packRow()];
    const convertedRows = [{ merchant: 'converted-row' }];
    const settled = { documentId: DOC, status: 'suggested' } as unknown as StatementExtraction;
    vi.mocked(detectPack).mockReturnValue(inKotakSavings);
    vi.mocked(parseStatement).mockReturnValue({ ok: true, rows });
    vi.mocked(toStatementRowInputs).mockReturnValue(convertedRows);
    vi.mocked(api.beginStatementPages).mockResolvedValue({ ok: true, runId: 'run-1' });
    vi.mocked(api.finalizeStatementPages).mockResolvedValue(settled);

    const labels: string[] = [];
    const result = await runPackRead(
      DOC,
      [LONG_TEXT],
      false,
      (l: string) => labels.push(l),
      createCancelToken(),
    );

    expect(detectPack).toHaveBeenCalledWith([LONG_TEXT], expect.any(Array));
    expect(parseStatement).toHaveBeenCalledWith(inKotakSavings, [LONG_TEXT]);
    expect(toStatementRowInputs).toHaveBeenCalledWith(rows);
    // The claim is taken under the PACK's identity, never an AI provider's.
    expect(api.beginStatementPages).toHaveBeenCalledWith(DOC, 'in.kotak.savings');
    expect(api.finalizeStatementPages).toHaveBeenCalledWith(DOC, {
      rows: convertedRows,
      truncated: false,
      runId: 'run-1',
    });
    expect(api.statementPagesRound).not.toHaveBeenCalled();
    expect(labels).toContain(`Reading with the ${inKotakSavings.name} pack…`);
    expect(result).toBe(settled);
  });

  it('no bundled pack matches this bank → {outcome, reason: null}, no worker calls at all', async () => {
    vi.mocked(detectPack).mockReturnValue(null);

    const result = await runPackRead(DOC, [LONG_TEXT], false, () => undefined, createCancelToken());

    expect(result).toEqual({ outcome: 'no-pack', reason: null });
    expect(parseStatement).not.toHaveBeenCalled();
    expect(api.beginStatementPages).not.toHaveBeenCalled();
    expect(api.abortStatementPages).not.toHaveBeenCalled();
  });

  it('a matched pack that cannot verify propagates the structural reason, no claim taken', async () => {
    vi.mocked(detectPack).mockReturnValue(inKotakSavings);
    vi.mocked(parseStatement).mockReturnValue({
      ok: false,
      reason: 'row 12: balance chain broke',
    });

    const result = await runPackRead(DOC, [LONG_TEXT], false, () => undefined, createCancelToken());

    expect(result).toEqual({ outcome: 'no-pack', reason: 'row 12: balance chain broke' });
    expect(api.beginStatementPages).not.toHaveBeenCalled();
    expect(api.abortStatementPages).not.toHaveBeenCalled();
  });

  it('any page with no usable text layer refuses before detection even runs, naming the page', async () => {
    const result = await runPackRead(
      DOC,
      [LONG_TEXT, 'short'],
      false,
      () => undefined,
      createCancelToken(),
    );

    expect(result).toEqual({ outcome: 'no-pack', reason: 'page 2 has no text layer' });
    expect(detectPack).not.toHaveBeenCalled();
    expect(api.beginStatementPages).not.toHaveBeenCalled();
  });

  it('a cancellation between a verified parse and the claim throws WITHOUT an abort POST — nothing is claimed yet', async () => {
    vi.mocked(detectPack).mockReturnValue(inKotakSavings);
    vi.mocked(parseStatement).mockReturnValue({ ok: true, rows: [] });
    vi.mocked(toStatementRowInputs).mockReturnValue([]);
    const token = createCancelToken();
    token.cancelled = true;

    await expect(
      runPackRead(DOC, [LONG_TEXT], false, () => undefined, token),
    ).rejects.toBeInstanceOf(ClientReadCancelled);

    expect(api.beginStatementPages).not.toHaveBeenCalled();
    expect(api.abortStatementPages).not.toHaveBeenCalled();
  });

  it('a truncated extraction that still verifies passes truncated through to finalize — a loud partial, never a silent "suggested"', async () => {
    const rows = [packRow()];
    const convertedRows = [{ merchant: 'converted-row' }];
    vi.mocked(detectPack).mockReturnValue(inKotakSavings);
    vi.mocked(parseStatement).mockReturnValue({ ok: true, rows });
    vi.mocked(toStatementRowInputs).mockReturnValue(convertedRows);
    vi.mocked(api.beginStatementPages).mockResolvedValue({ ok: true, runId: 'run-1' });
    vi.mocked(api.finalizeStatementPages).mockResolvedValue({
      documentId: DOC,
      status: 'partial',
    } as unknown as StatementExtraction);

    await runPackRead(DOC, [LONG_TEXT], true, () => undefined, createCancelToken());

    expect(api.finalizeStatementPages).toHaveBeenCalledWith(DOC, {
      rows: convertedRows,
      truncated: true,
      runId: 'run-1',
    });
  });

  describe('engine throws degrade to the ordinary "no pack" fallback (permanent defense, not a merge shim)', () => {
    it('detectPack throwing → outcome no-pack, zero worker calls', async () => {
      vi.mocked(detectPack).mockImplementation(() => {
        throw new Error('malformed pack signature regex');
      });

      const result = await runPackRead(DOC, [LONG_TEXT], false, () => undefined, createCancelToken());

      expect(result).toEqual({ outcome: 'no-pack', reason: null });
      expect(parseStatement).not.toHaveBeenCalled();
      expect(api.beginStatementPages).not.toHaveBeenCalled();
      expect(api.finalizeStatementPages).not.toHaveBeenCalled();
      expect(api.abortStatementPages).not.toHaveBeenCalled();
      expect(api.statementPagesRound).not.toHaveBeenCalled();
    });

    it('parseStatement throwing → outcome no-pack, zero worker calls', async () => {
      vi.mocked(detectPack).mockReturnValue(inKotakSavings);
      vi.mocked(parseStatement).mockImplementation(() => {
        throw new Error('the state machine walked off the end of a line');
      });

      const result = await runPackRead(DOC, [LONG_TEXT], false, () => undefined, createCancelToken());

      expect(result).toEqual({ outcome: 'no-pack', reason: null });
      expect(api.beginStatementPages).not.toHaveBeenCalled();
      expect(api.finalizeStatementPages).not.toHaveBeenCalled();
      expect(api.abortStatementPages).not.toHaveBeenCalled();
    });

    it('toStatementRowInputs throwing after a verified parse → outcome no-pack, zero worker calls (no claim to abort)', async () => {
      vi.mocked(detectPack).mockReturnValue(inKotakSavings);
      vi.mocked(parseStatement).mockReturnValue({ ok: true, rows: [packRow()] });
      vi.mocked(toStatementRowInputs).mockImplementation(() => {
        throw new Error('unexpected row shape');
      });

      const result = await runPackRead(DOC, [LONG_TEXT], false, () => undefined, createCancelToken());

      expect(result).toEqual({ outcome: 'no-pack', reason: null });
      // The parse verified, but conversion runs BEFORE any claim is taken —
      // so there is nothing to abort.
      expect(api.beginStatementPages).not.toHaveBeenCalled();
      expect(api.finalizeStatementPages).not.toHaveBeenCalled();
      expect(api.abortStatementPages).not.toHaveBeenCalled();
    });
  });
});
