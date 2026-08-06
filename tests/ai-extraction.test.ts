// The pure half of AI extraction: what the server does to a model's answer
// before it is allowed anywhere near the database, and which provider runs.
// No network, no bindings — everything under test here is a pure function.
import { describe, expect, it } from 'vitest';
import { defaultSettings, type Settings } from '../shared/types';
import {
  clampConfidence,
  emptyFields,
  normalizeExtraction,
  parseModelJson,
} from '../worker/ai/normalize';
import {
  ANTHROPIC_DEFAULT_MODEL,
  assertMimeSupported,
  canonicalMime,
  selectProvider,
  supportsMime,
  WORKERS_AI_DEFAULT_MODEL,
} from '../worker/ai/providers';
import { EXTRACTION_IN_FLIGHT_MS, extractionInFlight } from '../worker/extractions';

const CATEGORIES = ['Groceries', 'Dining', 'Needs review', 'Transportation'];

/** A well-formed model answer; individual tests corrupt one field at a time. */
function modelSaid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    merchant: { value: 'Blue Bottle Coffee', confidence: 0.9 },
    date: { value: '2026-03-04', confidence: 0.8 },
    total: { value: 12.5, confidence: 0.95 },
    type: { value: 'expense', confidence: 0.99 },
    category: { value: 'Dining', confidence: 0.7 },
    ...overrides,
  };
}

describe('normalizeExtraction — a clean answer survives intact', () => {
  it('keeps every grounded field and its confidence', () => {
    const out = normalizeExtraction(modelSaid(), CATEGORIES);
    expect(out).toEqual({
      merchant: { value: 'Blue Bottle Coffee', confidence: 0.9 },
      date: { value: '2026-03-04', confidence: 0.8 },
      total: { value: 12.5, confidence: 0.95 },
      type: { value: 'expense', confidence: 0.99 },
      category: { value: 'Dining', confidence: 0.7 },
    });
  });

  it('returns all-unknown for input that is not an object', () => {
    for (const bad of [null, undefined, 'text', 42, [], true]) {
      expect(normalizeExtraction(bad, CATEGORIES)).toEqual(emptyFields());
    }
  });
});

describe('normalizeExtraction — dates are checked against the real calendar', () => {
  for (const good of ['2026-03-04', '2024-02-29', '2026-12-31']) {
    it(`accepts ${good}`, () => {
      const out = normalizeExtraction(modelSaid({ date: { value: good, confidence: 0.8 } }), CATEGORIES);
      expect(out.date.value).toBe(good);
    });
  }

  it('takes the date out of a longer timestamp', () => {
    const out = normalizeExtraction(
      modelSaid({ date: { value: '2026-03-04T09:15:00Z', confidence: 0.8 } }),
      CATEGORIES,
    );
    expect(out.date.value).toBe('2026-03-04');
  });

  // 2026-02-30 and 2025-02-29 parse as strings but are not days that exist.
  for (const bad of [
    '2026-02-30',
    '2025-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-03-32',
    '03/04/2026',
    '4 March 2026',
    '2026-3-4',
    '',
    '   ',
  ]) {
    it(`rejects ${JSON.stringify(bad)} and drops its confidence`, () => {
      const out = normalizeExtraction(modelSaid({ date: { value: bad, confidence: 0.99 } }), CATEGORIES);
      expect(out.date).toEqual({ value: null, confidence: 0 });
    });
  }

  for (const bad of [20260304, null, { y: 2026 }, ['2026-03-04']]) {
    it(`rejects the non-string ${JSON.stringify(bad)}`, () => {
      const out = normalizeExtraction(modelSaid({ date: { value: bad, confidence: 0.9 } }), CATEGORIES);
      expect(out.date).toEqual({ value: null, confidence: 0 });
    });
  }
});

describe('normalizeExtraction — totals are positive magnitudes', () => {
  it('rounds to cents', () => {
    const out = normalizeExtraction(modelSaid({ total: { value: 12.3456, confidence: 0.9 } }), CATEGORIES);
    expect(out.total.value).toBe(12.35);
  });

  it('accepts a numeric string', () => {
    const out = normalizeExtraction(modelSaid({ total: { value: ' 41.20 ', confidence: 0.6 } }), CATEGORIES);
    expect(out.total).toEqual({ value: 41.2, confidence: 0.6 });
  });

  // A negative total is dropped, never flipped: on a receipt it usually means
  // the model read a discount line, and "so it must be a refund" is a guess.
  for (const bad of [-12.5, 0, -0.01, Number.NaN, Number.POSITIVE_INFINITY, 'free', '', null, {}]) {
    it(`rejects ${JSON.stringify(bad)} and drops its confidence`, () => {
      const out = normalizeExtraction(modelSaid({ total: { value: bad, confidence: 0.99 } }), CATEGORIES);
      expect(out.total).toEqual({ value: null, confidence: 0 });
    });
  }
});

describe('normalizeExtraction — type is a closed enum', () => {
  for (const good of ['expense', 'income'] as const) {
    it(`accepts ${good}`, () => {
      const out = normalizeExtraction(modelSaid({ type: { value: good, confidence: 0.9 } }), CATEGORIES);
      expect(out.type.value).toBe(good);
    });
  }

  // No default to 'expense': an unreadable type goes to the user, not to a guess.
  for (const bad of ['Expense', 'refund', 'credit', 'debit', '', 1, null]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      const out = normalizeExtraction(modelSaid({ type: { value: bad, confidence: 0.95 } }), CATEGORIES);
      expect(out.type).toEqual({ value: null, confidence: 0 });
    });
  }
});

describe('normalizeExtraction — categories must be in the managed list', () => {
  it('matches case-insensitively and returns the managed casing', () => {
    const out = normalizeExtraction(
      modelSaid({ category: { value: '  gROCERIES ', confidence: 0.55 } }),
      CATEGORIES,
    );
    expect(out.category).toEqual({ value: 'Groceries', confidence: 0.55 });
  });

  for (const invented of ['Coffee', 'Food & Drink', 'Groceries ✨', '']) {
    it(`drops the invented category ${JSON.stringify(invented)}`, () => {
      const out = normalizeExtraction(
        modelSaid({ category: { value: invented, confidence: 0.9 } }),
        CATEGORIES,
      );
      expect(out.category).toEqual({ value: null, confidence: 0 });
    });
  }

  it('drops every category when the user manages none', () => {
    const out = normalizeExtraction(modelSaid(), []);
    expect(out.category).toEqual({ value: null, confidence: 0 });
    // The other fields are unaffected.
    expect(out.merchant.value).toBe('Blue Bottle Coffee');
  });
});

describe('normalizeExtraction — merchant', () => {
  it('trims surrounding whitespace', () => {
    const out = normalizeExtraction(modelSaid({ merchant: { value: '  Tesco  ', confidence: 0.5 } }), CATEGORIES);
    expect(out.merchant).toEqual({ value: 'Tesco', confidence: 0.5 });
  });

  it('clips an absurdly long name instead of storing it whole', () => {
    const out = normalizeExtraction(
      modelSaid({ merchant: { value: 'A'.repeat(500), confidence: 0.5 } }),
      CATEGORIES,
    );
    expect(out.merchant.value).not.toBeNull();
    expect(out.merchant.value!.length).toBeLessThanOrEqual(120);
  });

  for (const bad of ['', '   ', 42, null, {}]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      const out = normalizeExtraction(modelSaid({ merchant: { value: bad, confidence: 0.9 } }), CATEGORIES);
      expect(out.merchant).toEqual({ value: null, confidence: 0 });
    });
  }
});

describe('confidence is clamped, and never disagrees with its value', () => {
  it('clamps out-of-range numbers into 0..1', () => {
    expect(clampConfidence(1.7)).toBe(1);
    expect(clampConfidence(42)).toBe(1);
    expect(clampConfidence(-0.5)).toBe(0);
    expect(clampConfidence(0)).toBe(0);
    expect(clampConfidence(0.5)).toBe(0.5);
  });

  it('rounds to two decimals', () => {
    expect(clampConfidence(0.87654)).toBe(0.88);
  });

  it('treats anything non-numeric as least confident', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 'high', null, undefined, {}, []]) {
      expect(clampConfidence(bad)).toBe(0);
    }
  });

  it('accepts a numeric string', () => {
    expect(clampConfidence('0.4')).toBe(0.4);
  });

  it('clamps through normalizeExtraction', () => {
    const out = normalizeExtraction(
      modelSaid({
        merchant: { value: 'Tesco', confidence: 9 },
        date: { value: '2026-03-04', confidence: -3 },
      }),
      CATEGORIES,
    );
    expect(out.merchant.confidence).toBe(1);
    expect(out.date.confidence).toBe(0);
  });

  it('forces confidence to 0 whenever the value is null', () => {
    const out = normalizeExtraction(
      {
        merchant: { value: null, confidence: 0.99 },
        date: { value: null, confidence: 1 },
        total: { value: null, confidence: 0.8 },
        type: { value: null, confidence: 0.7 },
        category: { value: null, confidence: 0.6 },
      },
      CATEGORIES,
    );
    expect(out).toEqual(emptyFields());
  });

  it('defaults a missing confidence to 0 rather than assuming certainty', () => {
    const out = normalizeExtraction(modelSaid({ merchant: { value: 'Tesco' } }), CATEGORIES);
    expect(out.merchant).toEqual({ value: 'Tesco', confidence: 0 });
  });

  it('survives a field that is not an envelope at all', () => {
    const out = normalizeExtraction({ ...modelSaid(), merchant: 'Tesco' }, CATEGORIES);
    expect(out.merchant).toEqual({ value: null, confidence: 0 });
  });
});

describe('parseModelJson', () => {
  it('parses bare JSON', () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('recovers JSON from a markdown fence', () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('recovers JSON wrapped in prose', () => {
    expect(parseModelJson('Here you go:\n{"a":1}\nHope that helps!')).toEqual({ a: 1 });
  });

  // Null means "failed run", never "successful empty extraction".
  for (const bad of ['', '   ', 'I could not read this receipt.', '[1,2,3]', '{oops']) {
    it(`returns null for ${JSON.stringify(bad)}`, () => {
      expect(parseModelJson(bad)).toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------

function settingsWith(overrides: Partial<Settings>): Settings {
  return { ...defaultSettings(), ...overrides };
}

describe('selectProvider', () => {
  it("refuses when no provider is enabled — 'off' is the default", () => {
    expect(defaultSettings().aiProvider).toBe('off');
    expect(() => selectProvider(defaultSettings())).toThrowError(/Enable an AI provider/i);
    try {
      selectProvider(defaultSettings());
    } catch (err) {
      expect(err).toMatchObject({ status: 400 });
    }
  });

  it('refuses anthropic without a stored key', () => {
    const settings = settingsWith({ aiProvider: 'anthropic', aiKeySet: false });
    expect(() => selectProvider(settings)).toThrowError(/Anthropic API key/i);
    try {
      selectProvider(settings);
    } catch (err) {
      expect(err).toMatchObject({ status: 400 });
    }
  });

  it('picks each provider default when no model override is set', () => {
    expect(selectProvider(settingsWith({ aiProvider: 'workers-ai' }))).toEqual({
      provider: 'workers-ai',
      model: WORKERS_AI_DEFAULT_MODEL,
    });
    expect(selectProvider(settingsWith({ aiProvider: 'anthropic', aiKeySet: true }))).toEqual({
      provider: 'anthropic',
      model: ANTHROPIC_DEFAULT_MODEL,
    });
  });

  it('honours a model override and trims it', () => {
    const settings = settingsWith({ aiProvider: 'anthropic', aiKeySet: true, aiModel: '  claude-sonnet-5 ' });
    expect(selectProvider(settings).model).toBe('claude-sonnet-5');
  });

  it('falls back to the default for a blank override', () => {
    const settings = settingsWith({ aiProvider: 'workers-ai', aiModel: '   ' });
    expect(selectProvider(settings).model).toBe(WORKERS_AI_DEFAULT_MODEL);
  });

  it('the Workers AI default is a Cloudflare model id', () => {
    expect(WORKERS_AI_DEFAULT_MODEL.startsWith('@cf/')).toBe(true);
  });
});

describe('mime support differs by provider', () => {
  for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
    it(`both providers accept ${mime}`, () => {
      expect(supportsMime('workers-ai', mime)).toBe(true);
      expect(supportsMime('anthropic', mime)).toBe(true);
    });
  }

  it('only anthropic accepts PDFs — the Workers AI vision models document images only', () => {
    expect(supportsMime('anthropic', 'application/pdf')).toBe(true);
    expect(supportsMime('workers-ai', 'application/pdf')).toBe(false);
    expect(() => assertMimeSupported('workers-ai', 'application/pdf')).toThrowError(/images only/i);
    expect(() => assertMimeSupported('anthropic', 'application/pdf')).not.toThrow();
  });

  for (const mime of ['text/csv', 'application/zip', 'image/tiff', '', 'application/octet-stream']) {
    it(`neither provider accepts ${JSON.stringify(mime)}`, () => {
      expect(supportsMime('workers-ai', mime)).toBe(false);
      expect(supportsMime('anthropic', mime)).toBe(false);
      try {
        assertMimeSupported('anthropic', mime);
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toMatchObject({ status: 400 });
      }
    });
  }

  it('tolerates parameters and the non-standard image/jpg', () => {
    expect(canonicalMime('image/PNG; charset=binary')).toBe('image/png');
    expect(canonicalMime('image/jpg')).toBe('image/jpeg');
    expect(supportsMime('workers-ai', 'image/jpg')).toBe(true);
    expect(supportsMime('anthropic', 'application/pdf; version=1.7')).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('extractionInFlight — one metered call per document at a time', () => {
  const NOW = '2026-08-06T12:00:00.000Z';

  function stampedBefore(seconds: number): string {
    return new Date(Date.parse(NOW) - seconds * 1000).toISOString();
  }

  it('a fresh pending claim blocks a second run', () => {
    expect(extractionInFlight('pending', NOW, NOW)).toBe(true);
    expect(extractionInFlight('pending', stampedBefore(30), NOW)).toBe(true);
  });

  it('the claim expires at the window edge, so a crashed run frees itself', () => {
    const windowSeconds = EXTRACTION_IN_FLIGHT_MS / 1000;
    expect(extractionInFlight('pending', stampedBefore(windowSeconds - 1), NOW)).toBe(true);
    expect(extractionInFlight('pending', stampedBefore(windowSeconds), NOW)).toBe(false);
    expect(extractionInFlight('pending', stampedBefore(windowSeconds + 60), NOW)).toBe(false);
  });

  it('only pending blocks — every settled status re-runs immediately', () => {
    for (const status of ['suggested', 'failed', 'confirmed', 'dismissed', '']) {
      expect(extractionInFlight(status, NOW, NOW)).toBe(false);
    }
  });

  // Failing open costs one duplicate call; failing closed strands the document.
  it('a garbled stamp never blocks a retry', () => {
    for (const bad of ['', '   ', 'not a timestamp', 'yesterday']) {
      expect(extractionInFlight('pending', bad, NOW)).toBe(false);
    }
  });

  it('honours a caller-supplied window', () => {
    expect(extractionInFlight('pending', stampedBefore(5), NOW, 10_000)).toBe(true);
    expect(extractionInFlight('pending', stampedBefore(15), NOW, 10_000)).toBe(false);
  });
});
