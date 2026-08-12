// The Sarvam provider (sprint 10, resumable since sprint 12): PDF splitting
// math, the schema dialect adaptation, the fixed-confidence envelope pin, the
// no-polling statement submit + the tick primitives it hands to
// worker/statements.ts, the receipt path's in-request loop, preflight math,
// provider gating and the write-only key/price settings.
//
// No network anywhere: the HTTP layer runs against an injectable fetch, and
// the PDF fixtures are built in-test with pdf-lib.
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { defaultSettings, type Settings } from '../shared/types';
import { normalizeExtraction, normalizeStatementRow } from '../worker/ai/normalize';
import { countPdfPages, splitPdfIntoBatches } from '../worker/ai/pdfSplit';
import {
  assertMimeSupported,
  SARVAM_DEFAULT_MODEL,
  selectProvider,
  selectStatementProvider,
  supportsMime,
  WORKERS_AI_NO_PDF,
} from '../worker/ai/providers';
import {
  fetchSarvamJobRows,
  isSarvamTerminal,
  MAX_SARVAM_PAGES_PER_JOB,
  pollSarvamJobStatus,
  runSarvamReceipt,
  SARVAM_FIELD_CONFIDENCE,
  sarvamReceiptSchema,
  sarvamStatementSchema,
  submitSarvamStatementJobs,
  toReceiptEnvelope,
  toStatementEnvelopeRow,
} from '../worker/ai/sarvam';
import { applyPreferences, normalizeSarvamPrice } from '../worker/preferences';
import { readSarvamApiKey, readSettings, SARVAM_KEY_SECRET_KEY } from '../worker/settingsStore';
import { buildStatementPreflight } from '../worker/statements';

const CATEGORIES = ['Groceries', 'Dining', 'Needs review', 'Transportation'];

function settingsWith(patch: Partial<Settings>): Settings {
  return { ...defaultSettings(), ...patch };
}

// ---------------------------------------------------------------------------
// PDF fixtures — built with pdf-lib so the split math is tested on real PDFs.
// Each page's width encodes its position (100 + index), which is how order
// preservation is asserted after a split.
// ---------------------------------------------------------------------------

async function pdfWithPages(count: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) doc.addPage([100 + i, 200]);
  return doc.save({ useObjectStreams: false });
}

/** Widths of every page across the given batch PDFs, in order. */
async function widthsAcross(batches: Uint8Array[]): Promise<number[]> {
  const widths: number[] = [];
  for (const bytes of batches) {
    const doc = await PDFDocument.load(bytes);
    for (const page of doc.getPages()) widths.push(Math.round(page.getWidth()));
  }
  return widths;
}

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/**
 * A structurally valid PDF whose trailer carries an /Encrypt dictionary —
 * pdf-lib cannot *create* encrypted PDFs, so the marker real banks set is
 * spliced into a fixture the same parser then refuses.
 */
async function encryptedPdf(): Promise<Uint8Array> {
  const bytes = await pdfWithPages(1);
  const latin = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  const at = latin.lastIndexOf('trailer');
  expect(at).toBeGreaterThan(-1);
  const open = latin.indexOf('<<', at);
  expect(open).toBeGreaterThan(-1);
  const insert = ascii(' /Encrypt << /Filter /Standard /V 1 >>');
  const out = new Uint8Array(bytes.length + insert.length);
  out.set(bytes.subarray(0, open + 2), 0);
  out.set(insert, open + 2);
  out.set(bytes.subarray(open + 2), open + 2 + insert.length);
  return out;
}

describe('countPdfPages', () => {
  for (const pages of [1, 10, 11, 25]) {
    it(`counts a ${pages}-page PDF`, async () => {
      expect(await countPdfPages(await pdfWithPages(pages))).toBe(pages);
    });
  }

  it('refuses bytes that are not a PDF, readably', async () => {
    await expect(countPdfPages(ascii('not a pdf at all'))).rejects.toThrow(
      /could not be read for splitting/i,
    );
  });

  it('refuses a password-protected PDF and says what to do — never tries passwords', async () => {
    await expect(countPdfPages(await encryptedPdf())).rejects.toThrow(/password-protected/i);
  });
});

describe('splitPdfIntoBatches — 10-page batches, order preserved', () => {
  const cases: [pages: number, batches: number][] = [
    [1, 1],
    [10, 1],
    [11, 2],
    [25, 3],
  ];
  for (const [pages, batchCount] of cases) {
    it(`${pages} pages → ${batchCount} batch(es), every page once, in order`, async () => {
      const batches = await splitPdfIntoBatches(await pdfWithPages(pages), 10);
      expect(batches.length).toBe(batchCount);
      // Each chunk holds at most 10 pages and the widths read back 100..100+n-1.
      expect(await widthsAcross(batches)).toEqual(
        Array.from({ length: pages }, (_, i) => 100 + i),
      );
      const counts = await Promise.all(batches.map((b) => countPdfPages(b)));
      expect(Math.max(...counts)).toBeLessThanOrEqual(10);
    });
  }

  it('an 11-page split puts 10 pages in the first chunk and 1 in the second', async () => {
    const batches = await splitPdfIntoBatches(await pdfWithPages(11), 10);
    expect(await countPdfPages(batches[0])).toBe(10);
    expect(await countPdfPages(batches[1])).toBe(1);
  });

  it('refuses encrypted PDFs with the same message as counting', async () => {
    await expect(splitPdfIntoBatches(await encryptedPdf(), 10)).rejects.toThrow(
      /password-protected/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Schema adaptation — Sarvam's dialect: type + non-empty description on every
// field, optional enum, nesting ≤ 4. Field names must mirror the Anthropic
// schemas exactly so both providers feed the same normalize pipeline.
// ---------------------------------------------------------------------------

type Dict = Record<string, unknown>;

function props(schema: unknown): Dict {
  return (schema as Dict).properties as Dict;
}

describe('sarvamStatementSchema', () => {
  const schema = sarvamStatementSchema(CATEGORIES);

  it('is a rows array of the five statement fields, in the statement names', () => {
    expect((schema as Dict).type).toBe('object');
    const rows = props(schema).rows as Dict;
    expect(rows.type).toBe('array');
    const items = rows.items as Dict;
    expect(items.type).toBe('object');
    expect(Object.keys(props(items))).toEqual(['date', 'merchant', 'amount', 'type', 'category']);
  });

  it('every field carries a type and a non-empty description (Sarvam requires both)', () => {
    const rows = props(schema).rows as Dict;
    expect(typeof rows.description).toBe('string');
    expect((rows.description as string).length).toBeGreaterThan(0);
    for (const field of Object.values(props(rows.items as Dict))) {
      const f = field as Dict;
      expect(typeof f.type).toBe('string');
      expect(typeof f.description).toBe('string');
      expect((f.description as string).length).toBeGreaterThan(0);
      // Leaf fields are primitives — the schema never exceeds depth 4.
      expect(f.properties).toBeUndefined();
      expect(f.items).toBeUndefined();
    }
  });

  it('constrains type to the closed enum and names every category in its description', () => {
    const items = props(props(schema).rows as Dict) as Dict;
    const itemProps = props((props(schema).rows as Dict).items as Dict);
    expect((itemProps.type as Dict).enum).toEqual(['expense', 'income']);
    for (const category of CATEGORIES) {
      expect((itemProps.category as Dict).description).toContain(category);
    }
    void items;
  });
});

describe('sarvamReceiptSchema', () => {
  it('is the receipt pipeline’s five fields at the root, in the receipt names', () => {
    const schema = sarvamReceiptSchema(CATEGORIES);
    expect((schema as Dict).type).toBe('object');
    expect(Object.keys(props(schema))).toEqual(['merchant', 'date', 'total', 'type', 'category']);
    for (const field of Object.values(props(schema))) {
      const f = field as Dict;
      expect(typeof f.type).toBe('string');
      expect((f.description as string).length).toBeGreaterThan(0);
    }
    expect((props(schema).type as Dict).enum).toEqual(['expense', 'income']);
  });
});

// ---------------------------------------------------------------------------
// The confidence pin — Sarvam returns no per-field confidence, so present
// fields get a FIXED mid confidence and missing ones null/0. This drives the
// review screen's Verify markers honestly; change SARVAM_FIELD_CONFIDENCE and
// this block together.
// ---------------------------------------------------------------------------

describe('envelope adaptation and the fixed confidence', () => {
  it('pins the fixed mid confidence at 0.7 — neither unread (0) nor fake-certain (1)', () => {
    expect(SARVAM_FIELD_CONFIDENCE).toBe(0.7);
  });

  it('maps present values to {value, 0.7} and missing/empty to {null, 0}', () => {
    const row = toStatementEnvelopeRow({
      date: '2026-03-04',
      merchant: 'SWIGGY BANGALORE',
      amount: 418.5,
      type: null,
      category: '   ',
    });
    expect(row).toEqual({
      date: { value: '2026-03-04', confidence: 0.7 },
      merchant: { value: 'SWIGGY BANGALORE', confidence: 0.7 },
      amount: { value: 418.5, confidence: 0.7 },
      type: { value: null, confidence: 0 },
      category: { value: null, confidence: 0 },
    });
  });

  it('a non-object row becomes all-missing, never a guess', () => {
    for (const bad of [null, undefined, 'text', 42, []]) {
      const row = toStatementEnvelopeRow(bad);
      for (const field of Object.values(row)) {
        expect(field).toEqual({ value: null, confidence: 0 });
      }
    }
  });

  it('normalize still re-validates: a present-but-invalid value ends at null/0', () => {
    // '04/03/2026' is present (→ 0.7 in the envelope) but not an ISO date —
    // never-guess drops it in normalize, so Sarvam output gets zero extra trust.
    const normalized = normalizeStatementRow(
      toStatementEnvelopeRow({ date: '04/03/2026', merchant: 'IRCTC', amount: 1200 }),
      CATEGORIES,
    );
    expect(normalized).not.toBeNull();
    expect(normalized?.date).toEqual({ value: null, confidence: 0 });
    expect(normalized?.merchant).toEqual({ value: 'IRCTC', confidence: 0.7 });
    expect(normalized?.amount).toEqual({ value: 1200, confidence: 0.7 });
  });

  it('receipt envelope uses the receipt field names, same mapping', () => {
    const out = toReceiptEnvelope({ merchant: 'Cafe Coffee Day', total: 240 });
    expect(out).toEqual({
      merchant: { value: 'Cafe Coffee Day', confidence: 0.7 },
      date: { value: null, confidence: 0 },
      total: { value: 240, confidence: 0.7 },
      type: { value: null, confidence: 0 },
      category: { value: null, confidence: 0 },
    });
  });
});

// ---------------------------------------------------------------------------
// The resumable statement flow's provider half, against a scripted fetch.
// Job lifecycle per docs.sarvam.ai: POST extract → {job_id, status} → GET
// status to a terminal → GET results → {result}. Since sprint 12 statements
// never poll in-request: submit creates every batch job and returns, and
// worker/statements.ts drives one-shot status/results calls across ticks.
// ---------------------------------------------------------------------------

interface Call {
  url: string;
  init?: RequestInit;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Scripted Sarvam API: each created job is served from `jobs` in creation
 * order — its poll statuses (drained one per poll, last repeats) and its
 * results body. A job entry may instead be a canned failure `Response` for
 * the creation call itself.
 */
function sarvamApi(
  jobs: { statuses?: string[]; result?: unknown; createResponse?: Response }[],
) {
  const calls: Call[] = [];
  let created = 0;
  const polls = new Map<string, string[]>();
  const results = new Map<string, unknown>();

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.endsWith('/extract')) {
      const job = jobs[created];
      created++;
      if (!job) return json(500, {});
      if (job.createResponse) return job.createResponse;
      const id = `job-${created}`;
      polls.set(id, [...(job.statuses ?? ['completed'])]);
      results.set(id, job.result ?? {});
      return json(200, { job_id: id, status: 'pending' });
    }
    const statusMatch = /\/(job-\d+)\/status$/.exec(url);
    if (statusMatch) {
      const queue = polls.get(statusMatch[1]) ?? ['failed'];
      const status = queue.length > 1 ? queue.shift() : queue[0];
      return json(200, { job_id: statusMatch[1], status });
    }
    const resultsMatch = /\/(job-\d+)\/results$/.exec(url);
    if (resultsMatch) return json(200, { result: results.get(resultsMatch[1]) });
    return json(404, {});
  }) as typeof fetch;

  return { fetchImpl, calls };
}

const FAST = { sleep: async () => {}, pollIntervalMs: 2, pollTimeoutMs: 10 };

function statementRow(merchant: string): Record<string, unknown> {
  return { date: '2026-03-04', merchant, amount: 100, type: 'expense', category: 'Dining' };
}

describe('submitSarvamStatementJobs — create everything, poll nothing', () => {
  it('creates one job per 10-page batch, in page order, without a single poll', async () => {
    const api = sarvamApi([{}, {}, {}]);
    const submit = await submitSarvamStatementJobs('sk-test', await pdfWithPages(25), CATEGORIES, {
      fetchImpl: api.fetchImpl,
      ...FAST,
    });
    expect(submit).toEqual({ jobIds: ['job-1', 'job-2', 'job-3'], batchCount: 3, failure: null });
    // The whole point of the resumable flow: every call was a creation —
    // not one /status, not one /results.
    expect(api.calls).toHaveLength(3);
    expect(api.calls.every((c) => c.url.endsWith('/extract'))).toBe(true);
  });

  it('authenticates with the api-subscription-key header and sends the schema as a JSON string', async () => {
    const api = sarvamApi([{}]);
    await submitSarvamStatementJobs('sk-test', await pdfWithPages(1), CATEGORIES, {
      fetchImpl: api.fetchImpl,
      ...FAST,
    });
    const create = api.calls[0];
    expect((create.init?.headers as Record<string, string>)['api-subscription-key']).toBe('sk-test');
    const body = create.init?.body as FormData;
    const schema = body.get('schema');
    expect(typeof schema).toBe('string');
    expect(JSON.parse(schema as string)).toEqual(sarvamStatementSchema(CATEGORIES));
    expect(body.get('file')).toBeInstanceOf(Blob);
  });

  it('a create failing partway records the jobs that DO exist plus the readable failure, and stops', async () => {
    const api = sarvamApi([{}, { createResponse: json(500, {}) }, {}]);
    const submit = await submitSarvamStatementJobs('sk-test', await pdfWithPages(25), CATEGORIES, {
      fetchImpl: api.fetchImpl,
      ...FAST,
    });
    // job-1 exists at Sarvam (and was paid for) — the caller records it while
    // failing the run; batch 3 was never attempted past the failure.
    expect(submit.jobIds).toEqual(['job-1']);
    expect(submit.batchCount).toBe(3);
    expect(submit.failure?.message).toMatch(/could not process/i);
    expect(api.calls).toHaveLength(2);
  });

  it('401/403 come back as the auth failure, original body dropped', async () => {
    for (const status of [401, 403]) {
      const api = sarvamApi([
        { createResponse: json(status, { error: 'secret-echoing body must never surface' }) },
      ]);
      const submit = await submitSarvamStatementJobs('sk-bad', await pdfWithPages(1), CATEGORIES, {
        fetchImpl: api.fetchImpl,
        ...FAST,
      });
      expect(submit.jobIds).toEqual([]);
      expect(submit.failure?.message).toBe(
        'Sarvam rejected the API key. Check the key saved in Settings.',
      );
      expect(JSON.stringify(submit)).not.toContain('secret-echoing');
    }
  });

  it('429 comes back as the rate-limit failure', async () => {
    const api = sarvamApi([{ createResponse: json(429, {}) }]);
    const submit = await submitSarvamStatementJobs('sk-test', await pdfWithPages(1), CATEGORIES, {
      fetchImpl: api.fetchImpl,
      ...FAST,
    });
    expect(submit.failure?.message).toMatch(/rate limited/i);
  });

  it('an encrypted PDF fails before anything reaches Sarvam — zero jobs, the password message', async () => {
    const api = sarvamApi([{}]);
    const submit = await submitSarvamStatementJobs('sk-test', await encryptedPdf(), CATEGORIES, {
      fetchImpl: api.fetchImpl,
      ...FAST,
    });
    expect(submit).toMatchObject({ jobIds: [], batchCount: 0 });
    expect(submit.failure?.message).toMatch(/password-protected/i);
    expect(api.calls).toHaveLength(0);
  });
});

describe('pollSarvamJobStatus / fetchSarvamJobRows — the tick primitives', () => {
  it('one poll is one subrequest returning the raw status', async () => {
    const api = sarvamApi([{ statuses: ['running', 'completed'], result: { rows: [] } }]);
    await submitSarvamStatementJobs('sk-test', await pdfWithPages(1), CATEGORIES, {
      fetchImpl: api.fetchImpl,
      ...FAST,
    });
    expect(await pollSarvamJobStatus('sk-test', 'job-1', { fetchImpl: api.fetchImpl })).toBe('running');
    expect(await pollSarvamJobStatus('sk-test', 'job-1', { fetchImpl: api.fetchImpl })).toBe('completed');
    expect(api.calls.filter((c) => c.url.endsWith('/job-1/status'))).toHaveLength(2);
    expect(api.calls.filter((c) => c.url.endsWith('/results'))).toHaveLength(0);
  });

  it('fetchSarvamJobRows returns the RAW rows — no envelope, no trust added yet', async () => {
    const api = sarvamApi([{ result: { rows: [statementRow('raw-1'), statementRow('raw-2')] } }]);
    await submitSarvamStatementJobs('sk-test', await pdfWithPages(1), CATEGORIES, {
      fetchImpl: api.fetchImpl,
      ...FAST,
    });
    const rows = await fetchSarvamJobRows('sk-test', 'job-1', { fetchImpl: api.fetchImpl });
    // Plain objects exactly as returned — the envelope + normalize happen at
    // finalize in worker/statements.ts, so stored tick state adds no trust.
    expect(rows).toEqual([statementRow('raw-1'), statementRow('raw-2')]);
  });

  it('a results body without a rows array reads as zero rows, not an error', async () => {
    const api = sarvamApi([{ result: { unexpected: true } }]);
    await submitSarvamStatementJobs('sk-test', await pdfWithPages(1), CATEGORIES, {
      fetchImpl: api.fetchImpl,
      ...FAST,
    });
    expect(await fetchSarvamJobRows('sk-test', 'job-1', { fetchImpl: api.fetchImpl })).toEqual([]);
  });

  it('isSarvamTerminal knows exactly the four documented terminal statuses', () => {
    for (const status of ['completed', 'partially_completed', 'failed', 'rejected']) {
      expect(isSarvamTerminal(status)).toBe(true);
    }
    for (const status of ['pending', 'running', 'queued', '']) {
      expect(isSarvamTerminal(status)).toBe(false);
    }
  });
});

describe('runSarvamReceipt', () => {
  it('runs one extract job and returns the envelope for normalizeExtraction', async () => {
    const api = sarvamApi([
      {
        statuses: ['running', 'completed'],
        result: { merchant: 'Cafe Coffee Day', date: '2026-03-04', total: 240, type: 'expense', category: 'Dining' },
      },
    ]);
    const raw = await runSarvamReceipt('sk-test', ascii('fake-image'), 'image/png', CATEGORIES, {
      fetchImpl: api.fetchImpl,
      ...FAST,
    });
    const fields = normalizeExtraction(raw, CATEGORIES);
    expect(fields.merchant).toEqual({ value: 'Cafe Coffee Day', confidence: 0.7 });
    expect(fields.total).toEqual({ value: 240, confidence: 0.7 });
    expect(fields.category).toEqual({ value: 'Dining', confidence: 0.7 });
    // The receipt schema, not the statement schema, rides the form.
    const body = api.calls[0].init?.body as FormData;
    expect(JSON.parse(body.get('schema') as string)).toEqual(sarvamReceiptSchema(CATEGORIES));
  });

  // Receipts are the ONLY remaining user of the in-request create→poll→results
  // loop (statements went resumable in sprint 12), so its timeout and
  // terminal-failure behavior is pinned here.
  it('a receipt job that never reaches a terminal state times out readably', async () => {
    const api = sarvamApi([{ statuses: ['running'], result: {} }]);
    await expect(
      runSarvamReceipt('sk-test', ascii('fake-image'), 'image/png', CATEGORIES, {
        fetchImpl: api.fetchImpl,
        sleep: async () => {},
        pollIntervalMs: 2,
        pollTimeoutMs: 6,
      }),
    ).rejects.toThrow(/did not finish/i);
  });

  it('a failed or rejected receipt job throws readably', async () => {
    for (const terminal of ['failed', 'rejected']) {
      const api = sarvamApi([{ statuses: [terminal] }]);
      await expect(
        runSarvamReceipt('sk-test', ascii('fake-image'), 'image/png', CATEGORIES, {
          fetchImpl: api.fetchImpl,
          ...FAST,
        }),
      ).rejects.toThrow(/could not read this document/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Provider gating
// ---------------------------------------------------------------------------

describe('provider gating — sarvam', () => {
  it('receipt path: sarvam with a stored key resolves, without one it 400s naming Sarvam', () => {
    expect(selectProvider(settingsWith({ aiProvider: 'sarvam', sarvamKeySet: true }))).toEqual({
      provider: 'sarvam',
      model: SARVAM_DEFAULT_MODEL,
    });
    const keyless = settingsWith({ aiProvider: 'sarvam', sarvamKeySet: false });
    expect(() => selectProvider(keyless)).toThrowError(/Sarvam API key/i);
    try {
      selectProvider(keyless);
    } catch (err) {
      expect(err).toMatchObject({ status: 400 });
    }
  });

  it('statement path: sarvam is allowed with a key, refused without one', () => {
    expect(
      selectStatementProvider(settingsWith({ aiProvider: 'sarvam', sarvamKeySet: true })).provider,
    ).toBe('sarvam');
    expect(() =>
      selectStatementProvider(settingsWith({ aiProvider: 'sarvam', sarvamKeySet: false })),
    ).toThrowError(/Sarvam API key/i);
  });

  it('workers-ai is still refused for statements, and the copy names both capable providers', () => {
    expect(() =>
      selectStatementProvider(settingsWith({ aiProvider: 'workers-ai' })),
    ).toThrowError(/can't read PDFs yet/i);
    expect(WORKERS_AI_NO_PDF).toContain('Anthropic or Sarvam');
  });

  it('sarvam reads PDFs and its documented image formats — and nothing else', () => {
    expect(supportsMime('sarvam', 'application/pdf')).toBe(true);
    expect(supportsMime('sarvam', 'image/png')).toBe(true);
    expect(supportsMime('sarvam', 'image/jpeg')).toBe(true);
    expect(supportsMime('sarvam', 'image/jpg')).toBe(true); // alias folds to jpeg
    expect(supportsMime('sarvam', 'image/webp')).toBe(false);
    expect(supportsMime('sarvam', 'image/gif')).toBe(false);
    expect(() => assertMimeSupported('sarvam', 'image/webp')).toThrowError(/JPEG or PNG/);
  });
});

// ---------------------------------------------------------------------------
// Preflight math
// ---------------------------------------------------------------------------

describe('buildStatementPreflight', () => {
  it('sarvam batches at the 10-page job ceiling', () => {
    expect(MAX_SARVAM_PAGES_PER_JOB).toBe(10);
    for (const [pages, batches] of [
      [1, 1],
      [10, 1],
      [11, 2],
      [25, 3],
    ] as const) {
      expect(buildStatementPreflight(pages, 'sarvam', null).batches).toBe(batches);
    }
  });

  it('anthropic reads the whole PDF in one request — always 1 batch, never a cost', () => {
    expect(buildStatementPreflight(25, 'anthropic', 0.05)).toEqual({
      pages: 25,
      batches: 1,
      provider: 'anthropic',
      estimatedCost: null,
    });
  });

  it('estimates pages × the saved rate, rounded to 2dp', () => {
    expect(buildStatementPreflight(25, 'sarvam', 0.05)).toEqual({
      pages: 25,
      batches: 3,
      provider: 'sarvam',
      estimatedCost: 1.25,
    });
    expect(buildStatementPreflight(11, 'sarvam', 0.033).estimatedCost).toBe(0.36);
  });

  it('no saved rate → no estimate, never a guessed price', () => {
    expect(buildStatementPreflight(25, 'sarvam', null).estimatedCost).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Settings: the per-page price and the write-only key
// ---------------------------------------------------------------------------

describe('normalizeSarvamPrice', () => {
  it('accepts null (no estimate) and positive rates up to 10000', () => {
    expect(normalizeSarvamPrice(null)).toBeNull();
    expect(normalizeSarvamPrice(0.05)).toBe(0.05);
    expect(normalizeSarvamPrice(' 2.5 ')).toBe(2.5);
    expect(normalizeSarvamPrice(10000)).toBe(10000);
    // Sub-cent rates survive un-rounded — the estimate rounds, not the rate.
    expect(normalizeSarvamPrice(0.015)).toBe(0.015);
  });

  for (const bad of [0, -1, 10000.01, Number.NaN, 'free', '', true, {}, [], undefined]) {
    it(`rejects ${JSON.stringify(bad)} with a readable 400`, () => {
      expect(() => normalizeSarvamPrice(bad)).toThrowError(/sarvamPricePerPage/);
      try {
        normalizeSarvamPrice(bad);
      } catch (err) {
        expect(err).toMatchObject({ status: 400 });
      }
    });
  }
});

// The same in-memory `settings` table fake the other preferences suites use —
// scoped to what applyPreferences touches (settings rows + empty tags/rules).
interface FakeStatement {
  sql: string;
  args: unknown[];
  bind(...values: unknown[]): FakeStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<void>;
}

function fakeDb(initialSettings: Record<string, unknown> = {}) {
  const settingsRows = new Map<string, string>();
  for (const [key, value] of Object.entries(initialSettings)) {
    settingsRows.set(key, JSON.stringify(value));
  }

  function statement(sql: string, args: unknown[] = []): FakeStatement {
    return {
      sql,
      args,
      bind: (...values: unknown[]) => statement(sql, values),
      all: async <T,>() => {
        if (/FROM settings/i.test(sql)) {
          return {
            results: [...settingsRows].map(([key, value]) => ({ key, value })) as unknown as T[],
          };
        }
        return { results: [] as T[] }; // tags / rules stay empty here
      },
      first: async <T,>() => {
        if (/SELECT value FROM settings WHERE key = \?/i.test(sql)) {
          const value = settingsRows.get(args[0] as string);
          return (value === undefined ? null : { value }) as T | null;
        }
        return null as T | null;
      },
      run: async () => {
        if (/DELETE FROM settings WHERE key = \?/i.test(sql)) {
          settingsRows.delete(args[0] as string);
        }
      },
    };
  }

  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: FakeStatement[]) => {
      for (const stmt of statements) {
        if (/INSERT INTO settings/i.test(stmt.sql)) {
          const [key, value] = stmt.args as [string, string];
          settingsRows.set(key, value);
        }
      }
      return [];
    },
  } as unknown as D1Database;

  return { db, settingsRows };
}

describe('applyPreferences — the Sarvam key is write-only', () => {
  const SECRET = 'sarvam-sub-key-do-not-echo-42';

  it('stores the key, derives sarvamKeySet, and never echoes a byte of it', async () => {
    const { db, settingsRows } = fakeDb();
    const res = await applyPreferences(db, { sarvamApiKey: SECRET });
    expect(res.settings.sarvamKeySet).toBe(true);
    expect(JSON.stringify(res)).not.toContain(SECRET);
    expect(settingsRows.has(SARVAM_KEY_SECRET_KEY)).toBe(true);
    expect(await readSarvamApiKey(db)).toBe(SECRET);
    // The /api/state read path is equally silent about it.
    const settings = await readSettings(db);
    expect(settings.sarvamKeySet).toBe(true);
    expect(JSON.stringify(settings)).not.toContain(SECRET);
  });

  it('null clears the key and flips sarvamKeySet off', async () => {
    const { db, settingsRows } = fakeDb();
    await applyPreferences(db, { sarvamApiKey: SECRET });
    const res = await applyPreferences(db, { sarvamApiKey: null });
    expect(res.settings.sarvamKeySet).toBe(false);
    expect(settingsRows.has(SARVAM_KEY_SECRET_KEY)).toBe(false);
    expect(await readSarvamApiKey(db)).toBeNull();
  });

  it('an empty key is a 400, not a silent clear', async () => {
    const { db } = fakeDb();
    await expect(applyPreferences(db, { sarvamApiKey: '  ' })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("accepts aiProvider 'sarvam' and names it in the enum error", async () => {
    const { db } = fakeDb();
    const res = await applyPreferences(db, { aiProvider: 'sarvam' });
    expect(res.settings.aiProvider).toBe('sarvam');
    await expect(applyPreferences(db, { aiProvider: 'gemini' })).rejects.toThrowError(/sarvam/);
  });

  it('round-trips sarvamPricePerPage through storage — including back to null', async () => {
    const { db } = fakeDb();
    const res = await applyPreferences(db, { sarvamPricePerPage: 0.05 });
    expect(res.settings.sarvamPricePerPage).toBe(0.05);
    // A fresh read decodes the stored number (the shapeOk nullable-number path).
    expect((await readSettings(db)).sarvamPricePerPage).toBe(0.05);
    const cleared = await applyPreferences(db, { sarvamPricePerPage: null });
    expect(cleared.settings.sarvamPricePerPage).toBeNull();
  });
});
