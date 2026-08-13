// The browser half of the statement-pages flow (sprint 16) — the pure,
// DOM-free helpers: the text/image page heuristic, the round chunking, the
// image-size gate, and the pinned progress copy. The canvas- and
// pdf.js-dependent pieces are isolated behind these seams in the module
// itself and exercised by the live smoke, not vitest.
import { describe, expect, it } from 'vitest';
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
  TEXT_PAGE_MIN_CHARS,
} from '../src/components/ai/clientPages';
import {
  CLIENT_STATEMENT_MAX_PAGES,
  CLIENT_STATEMENT_PAGES_PER_ROUND,
  STATEMENT_PAGE_IMAGE_MAX_BYTES,
  STATEMENT_PAGE_TEXT_MAX_CHARS,
} from '../shared/types';

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
