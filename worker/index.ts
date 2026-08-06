// Ledgerly API worker — D1 for structured data, R2 for original file bytes
// (docs/SPEC.md §4 + §17). Every query is parameterized; nothing here logs
// payloads, file bytes or tokens (§20).
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  WIPE_CONFIRMATION,
  type BatchInsertResult,
  type StatePayload,
  type WipeResult,
} from '../shared/types';
import { deleteDocument, downloadDocument, uploadDocuments } from './documents';
import { readDriveStatus, runDriveSync } from './drive';
import { applyPreferences } from './preferences';
import { readDocuments, readRules, readTags, readTransactions } from './queries';
import { ensureSchema } from './schema';
import { readSettings, writeSettings } from './settingsStore';
import {
  insertTransactions,
  MAX_BATCH,
  readTransaction,
  registerTags,
} from './transactions';
import { ApiFail, isRecord, normalizeNames, safeEqual } from './util';

type App = { Bindings: Env };
const app = new Hono<App>();

async function readJson(c: Context<App>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiFail(400, 'Send a valid JSON body.');
  }
}

// Schema creation is idempotent and memoized per isolate (spec §20).
app.use('/api/*', async (c, next) => {
  try {
    await ensureSchema(c.env.DB);
  } catch {
    throw new ApiFail(503, 'The database is unavailable right now. Nothing was saved.');
  }
  await next();
});

// ---------------------------------------------------------------------------
// State (spec §4.3) + complete wipe (spec §4.7)
// ---------------------------------------------------------------------------

app.get('/api/state', async (c) => {
  const db = c.env.DB;
  const [transactions, tags, rules, settings, documents] = await Promise.all([
    readTransactions(db),
    readTags(db),
    readRules(db),
    readSettings(db),
    readDocuments(db),
  ]);
  const payload: StatePayload = { transactions, tags, rules, settings, documents };
  return c.json(payload);
});

app.delete('/api/state', async (c) => {
  const body = await readJson(c);
  if (!isRecord(body) || body.confirm !== WIPE_CONFIRMATION) {
    throw new ApiFail(400, 'Type the exact confirmation phrase to erase all Ledgerly data.');
  }
  const db = c.env.DB;
  const wipedAt = new Date().toISOString();

  await db.batch([
    db.prepare('DELETE FROM transactions'),
    db.prepare('DELETE FROM documents'),
    db.prepare('DELETE FROM rules'),
    db.prepare('DELETE FROM tags'),
    db.prepare('DELETE FROM settings'),
  ]);

  let bucketFailed = false;
  try {
    await wipeBucket(c.env.BUCKET);
  } catch {
    bucketFailed = true;
  }

  // Re-seed the structural defaults this wipe just deleted, then the explicit
  // fresh-start values (spec §4.7.3–4.7.7).
  await ensureSchema(db, { force: true });
  await writeSettings(db, {
    freshStart: true,
    driveResetAt: wipedAt,
    assetsTotal: 0,
    liabilitiesTotal: 0,
    netWorthConfigured: false,
    selectedPeriod: 'all-time',
    // Technically a no-op — ensureSchema(force: true) above already reseeds
    // every settings key, including onboarded, back to defaultSettings()
    // (onboarded: false). Left explicit so a full wipe re-running the
    // onboarding wizard reads as intentional here, not as an accident of
    // schema reseeding that a future refactor could silently drop.
    onboarded: false,
  });

  if (bucketFailed) {
    throw new ApiFail(
      500,
      'Database records were erased, but some stored files could not be deleted. Try again.',
    );
  }
  const result: WipeResult = { ok: true, wipedAt };
  return c.json(result);
});

async function wipeBucket(bucket: R2Bucket): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ cursor, limit: 1000 });
    if (listed.objects.length > 0) await bucket.delete(listed.objects.map((o) => o.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

// ---------------------------------------------------------------------------
// Transactions (spec §4.4)
// ---------------------------------------------------------------------------

app.post('/api/transactions', async (c) => {
  const body = await readJson(c);
  const list = Array.isArray(body) ? body : [body];
  if (list.length === 0) throw new ApiFail(400, 'Send at least one transaction.');
  if (list.length > MAX_BATCH) {
    throw new ApiFail(400, `Send at most ${MAX_BATCH} transactions per request.`);
  }
  const result: BatchInsertResult = await insertTransactions(c.env.DB, list);
  return c.json(result);
});

app.patch('/api/transactions/:id', async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  const body = await readJson(c);
  if (!isRecord(body)) throw new ApiFail(400, 'Send a JSON object with category and/or tags.');

  const sets: string[] = [];
  const binds: (string | number)[] = [];
  let newTags: string[] | null = null;

  if (body.category !== undefined) {
    const category = typeof body.category === 'string' ? body.category.trim() : '';
    if (!category) throw new ApiFail(400, 'Choose a category.');
    sets.push('category = ?');
    binds.push(category);
  }
  if (body.tags !== undefined) {
    newTags = normalizeNames(body.tags);
    if (newTags === null) throw new ApiFail(400, 'Tags must be a list of names.');
    sets.push('tags = ?');
    binds.push(JSON.stringify(newTags));
  }
  if (sets.length === 0) throw new ApiFail(400, 'Provide a category and/or tags to update.');

  const exists = await db
    .prepare('SELECT id FROM transactions WHERE id = ?')
    .bind(id)
    .first<{ id: string }>();
  if (!exists) throw new ApiFail(404, 'That transaction no longer exists.');

  await db
    .prepare(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds, id)
    .run();
  if (newTags) await registerTags(db, newTags);

  const saved = await readTransaction(db, id);
  if (!saved) throw new ApiFail(404, 'That transaction no longer exists.');
  return c.json(saved);
});

app.delete('/api/transactions/:id', async (c) => {
  // Idempotent on purpose: deleting an already-deleted row is a success.
  await c.env.DB.prepare('DELETE FROM transactions WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Preferences (spec §4.5)
// ---------------------------------------------------------------------------

app.put('/api/preferences', async (c) => {
  const result = await applyPreferences(c.env.DB, await readJson(c));
  return c.json(result);
});

// ---------------------------------------------------------------------------
// Documents (spec §4.6)
// ---------------------------------------------------------------------------

app.post('/api/documents', async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw new ApiFail(400, 'Send the files as a multipart form.');
  }
  return c.json(await uploadDocuments(c.env, form));
});

app.get('/api/documents/:id/download', async (c) => downloadDocument(c.env, c.req.param('id')));

app.delete('/api/documents/:id', async (c) => {
  await deleteDocument(c.env, c.req.param('id'));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Drive sync (spec §17)
// ---------------------------------------------------------------------------

/**
 * The automation's temporary bearer, when one is configured. Local dev has no
 * SYNC_TOKEN and stays open; production privacy comes from Cloudflare Access.
 * The token is compared, never logged or echoed.
 */
function requireSyncToken(c: Context<App>): void {
  const expected = c.env.SYNC_TOKEN;
  if (!expected) return;
  const header =
    c.req.header('Authorization') ?? c.req.header('OAI-Sites-Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match || !safeEqual(match[1].trim(), expected)) {
    throw new ApiFail(401, 'Unauthorized.');
  }
}

app.get('/api/drive-sync', async (c) => c.json(await readDriveStatus(c.env.DB)));

app.post('/api/drive-sync', async (c) => {
  requireSyncToken(c);
  return c.json(await runDriveSync(c.env, await readJson(c)));
});

// ---------------------------------------------------------------------------

app.notFound((c) =>
  c.req.path.startsWith('/api/')
    ? c.json({ error: 'Not found' }, 404)
    : c.text('Not found', 404),
);

app.onError((err, c) => {
  if (err instanceof ApiFail) return c.json({ error: err.message }, err.status);
  // Message only — never the request payload (spec §20).
  console.error('[ledgerly] unhandled error:', err instanceof Error ? err.message : 'unknown');
  return c.json({ error: 'Something went wrong on the server. Please try again.' }, 500);
});

export default app;
