// Ledgerly API worker — D1 for structured data, R2 for original file bytes
// (docs/SPEC.md §4 + §17). Every query is parameterized; nothing here logs
// payloads, file bytes or tokens (§20).
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  NEEDS_REVIEW,
  WIPE_CONFIRMATION,
  type BatchInsertResult,
  type StatePayload,
  type WipeResult,
} from '../shared/types';
import { computeBriefing, runScheduledBriefing, sendBriefingNow } from './briefings';
import { deleteDocument, downloadDocument, uploadDocuments } from './documents';
import { readDriveStatus, runDriveSync } from './drive';
import { ingestRawEmail, MAX_INBOUND_EMAIL_BYTES } from './email/ingest';
import { confirmInboxEmail, dismissInboxEmail, readInboxEmails } from './email/inbox';
import {
  handleMcpMessage,
  MCP_FORBIDDEN_ORIGIN,
  MCP_NOT_ALLOWED,
  MCP_UNAUTHORIZED,
  parseJsonRpcMessage,
  rpcError,
  type JsonRpcResponse,
} from './mcp/protocol';
import { bindMcpTools } from './mcp/tools';
import {
  confirmExtraction,
  dismissExtraction,
  readExtractions,
  runExtraction,
} from './extractions';
import { applyPreferences } from './preferences';
import { readDocuments, readRules, readTags, readTransactions } from './queries';
import { ensureSchema } from './schema';
import { readSettings, writeSettings } from './settingsStore';
import {
  confirmStatementRows,
  dismissStatement,
  readStatements,
  runStatementExtraction,
  statementPreflight,
} from './statements';
import {
  buildSuggestionRuleText,
  readRuleSuggestions,
  recordCategoryCorrection,
  ruleCoversPair,
  suggestionKey,
  validateSuggestionAction,
} from './suggestions';
import {
  insertTransactions,
  MAX_BATCH,
  readTransaction,
  registerTags,
} from './transactions';
import { ApiFail, clip, isRecord, normalizeNames, safeEqual } from './util';

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
  const [transactions, tags, rules, settings, documents, inboxEmails] = await Promise.all([
    readTransactions(db),
    readTags(db),
    readRules(db),
    readSettings(db),
    readDocuments(db),
    readInboxEmails(db),
  ]);
  // Extractions and statement jobs are scoped to the documents just returned,
  // so these reads are bounded by the same cap rather than growing with the vault.
  const documentIds = documents.map((d) => d.id);
  const [extractions, statements, ruleSuggestions] = await Promise.all([
    readExtractions(db, documentIds),
    readStatements(db, documentIds),
    // Reuses the rules/settings just read; its own reads are bounded
    // (CORRECTIONS_SCAN_LIMIT), so state stays O(1)-ish as corrections grow.
    readRuleSuggestions(db, rules, settings.categories),
  ]);
  const payload: StatePayload = {
    transactions,
    tags,
    rules,
    settings,
    documents,
    extractions,
    statements,
    ruleSuggestions,
    inboxEmails,
  };
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
    db.prepare('DELETE FROM extractions'),
    db.prepare('DELETE FROM statement_extractions'),
    db.prepare('DELETE FROM statement_rows'),
    db.prepare('DELETE FROM category_corrections'),
    db.prepare('DELETE FROM rule_suggestion_dismissals'),
    db.prepare('DELETE FROM inbox_emails'),
    db.prepare('DELETE FROM rules'),
    db.prepare('DELETE FROM tags'),
    // Clears both stored secrets with everything else — the BYOK key
    // (`aiApiKeySecret`) and the WhatsApp token (`briefingWhatsappTokenSecret`)
    // live in this table (worker/settingsStore.ts).
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
  let newCategory: string | null = null;

  if (body.category !== undefined) {
    const category = typeof body.category === 'string' ? body.category.trim() : '';
    if (!category) throw new ApiFail(400, 'Choose a category.');
    sets.push('category = ?');
    binds.push(category);
    newCategory = category;
  }
  if (body.tags !== undefined) {
    newTags = normalizeNames(body.tags);
    if (newTags === null) throw new ApiFail(400, 'Tags must be a list of names.');
    sets.push('tags = ?');
    binds.push(JSON.stringify(newTags));
  }
  if (sets.length === 0) throw new ApiFail(400, 'Provide a category and/or tags to update.');

  const exists = await db
    .prepare('SELECT id, category FROM transactions WHERE id = ?')
    .bind(id)
    .first<{ id: string; category: string }>();
  if (!exists) throw new ApiFail(404, 'That transaction no longer exists.');

  await db
    .prepare(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds, id)
    .run();
  if (newTags) await registerTags(db, newTags);

  const saved = await readTransaction(db, id);
  if (!saved) throw new ApiFail(404, 'That transaction no longer exists.');

  // A manual recategorization is correction-learning evidence (VISION.md
  // phase-2 item 1). Only this PATCH path records — never inserts, imports or
  // statement confirms — and parking a row back at 'Needs review' teaches nothing.
  if (newCategory !== null && newCategory !== exists.category && newCategory !== NEEDS_REVIEW) {
    await recordCategoryCorrection(db, saved.merchant, newCategory);
  }
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
// Rule suggestions (VISION.md phase-2 item 1). Suggestions are computed, never
// stored — /accept is the only path that turns one into a real rule.
// ---------------------------------------------------------------------------

function readSuggestionAction(body: unknown): { merchant: string; category: string } {
  const action = validateSuggestionAction(body);
  if (!action.ok) throw new ApiFail(400, action.error);
  return action;
}

app.post('/api/rule-suggestions/accept', async (c) => {
  const db = c.env.DB;
  const { merchant, category } = readSuggestionAction(await readJson(c));

  // Idempotent: when an enabled rule already sends this merchant to this
  // category (same applyRules check the suggestion filter uses), accepting
  // again succeeds without creating a duplicate.
  if (!ruleCoversPair(merchant, category, await readRules(db))) {
    const text = buildSuggestionRuleText(merchant, category);
    if (!text) {
      throw new ApiFail(
        400,
        'This merchant and category cannot be turned into a rule automatically. Create the rule yourself on the Rules page.',
      );
    }
    await db
      .prepare('INSERT INTO rules (id, whenText, thenText, enabled, createdAt) VALUES (?, ?, ?, 1, ?)')
      .bind(crypto.randomUUID(), text.whenText, text.thenText, new Date().toISOString())
      .run();
  }

  // Accepting outranks an old dismissal of the same pair.
  await db
    .prepare('DELETE FROM rule_suggestion_dismissals WHERE key = ?')
    .bind(suggestionKey(merchant, category))
    .run();
  return c.json({ rules: await readRules(db) });
});

app.post('/api/rule-suggestions/dismiss', async (c) => {
  const { merchant, category } = readSuggestionAction(await readJson(c));
  await c.env.DB.prepare(
    `INSERT INTO rule_suggestion_dismissals (key, createdAt) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET createdAt = excluded.createdAt`,
  )
    .bind(suggestionKey(merchant, category), new Date().toISOString())
    .run();
  return c.json({ ok: true });
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

app.get('/api/documents/:id/download', async (c) =>
  downloadDocument(c.env, c.req.param('id'), { inline: c.req.query('inline') === '1' }),
);

app.delete('/api/documents/:id', async (c) => {
  await deleteDocument(c.env, c.req.param('id'));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// AI extraction (spec §4.6, VISION.md phase 2). Suggestions only — /extract
// never writes a transaction; /extraction/confirm is the only path that does.
// ---------------------------------------------------------------------------

app.post('/api/documents/:id/extract', async (c) =>
  c.json(await runExtraction(c.env, c.req.param('id'))),
);

app.post('/api/documents/:id/extraction/confirm', async (c) =>
  c.json(await confirmExtraction(c.env, c.req.param('id'), await readJson(c))),
);

app.post('/api/documents/:id/extraction/dismiss', async (c) => {
  await dismissExtraction(c.env, c.req.param('id'));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// PDF statement extraction (VISION.md phase 2 item 3). Many proposed rows from
// one document — /statement/extract never writes a transaction; /confirm is the
// only path that does, and only for the rows the user selected.
// ---------------------------------------------------------------------------

// Free and side-effect-free: pages, batch count and an honest cost estimate
// BEFORE the user commits to a metered run. Same gates as /extract.
app.get('/api/documents/:id/statement/preflight', async (c) =>
  c.json(await statementPreflight(c.env, c.req.param('id'))),
);

app.post('/api/documents/:id/statement/extract', async (c) =>
  c.json(await runStatementExtraction(c.env, c.req.param('id'))),
);

app.post('/api/documents/:id/statement/confirm', async (c) =>
  c.json(await confirmStatementRows(c.env, c.req.param('id'), await readJson(c))),
);

app.post('/api/documents/:id/statement/dismiss', async (c) => {
  await dismissStatement(c.env, c.req.param('id'));
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
// The mail-in feed (VISION.md phase 2, sprint 8). Ingestion is suggestion-only
// — nothing here writes a transaction; /api/inbox/:id/confirm is the only
// path that does, and only for the row the user reviewed.
// ---------------------------------------------------------------------------

/**
 * The HTTP door into the same pipeline the Cloudflare email() handler feeds:
 * local dev, CI and non-Cloudflare mail pipes POST the raw RFC-822 message
 * here. Same optional bearer gating as /api/drive-sync; `?from=` overrides
 * the envelope sender for pipes that know it (the From header is used
 * otherwise). The discriminated pipeline result is the response body —
 * rejections are 400s with honest reasons.
 */
app.post('/api/inbound-email', async (c) => {
  requireSyncToken(c);
  const raw = await c.req.arrayBuffer();
  const from = c.req.query('from')?.trim() || null;
  const result = await ingestRawEmail(c.env, raw, from);
  return c.json(result, result.ok === false ? 400 : 200);
});

app.post('/api/inbox/:id/confirm', async (c) =>
  c.json(await confirmInboxEmail(c.env.DB, c.req.param('id'), await readJson(c))),
);

app.post('/api/inbox/:id/dismiss', async (c) => {
  await dismissInboxEmail(c.env.DB, c.req.param('id'));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Proactive briefings (VISION.md phase-2 item 6, sprint 7)
// ---------------------------------------------------------------------------

// Config-free: computes the digest and the exact text a delivery would send,
// without touching WhatsApp — works with zero briefing configuration.
app.get('/api/briefings/preview', async (c) => {
  const { briefing, text } = await computeBriefing(c.env.DB);
  return c.json({ briefing, text });
});

// Manual send: config-gated but NOT cadence-gated (the user asked for it now).
app.post('/api/briefings/send', async (c) => c.json(await sendBriefingNow(c.env.DB)));

// External-scheduler entry — same optional bearer gating as /api/drive-sync.
// The cadence gate inside decides whether anything is actually sent, so any
// cron can hit this safely and idempotently.
app.post('/api/briefings/run', async (c) => {
  requireSyncToken(c);
  return c.json(await runScheduledBriefing(c.env.DB));
});

// ---------------------------------------------------------------------------
// Read-only MCP server (VISION.md phase-2 item 5, sprint 9; docs/MCP.md).
// Stateless Streamable HTTP, minimal-compliant: one POST = one JSON response
// (no SSE), notifications → 202, GET → 405, Mcp-Session-Id ignored (allowed
// for stateless servers). Errors on this endpoint are JSON-RPC-shaped, not
// ApiFail's { error } — MCP clients should only ever parse one error shape.
// ---------------------------------------------------------------------------

/** Origins a browser page may POST from — MCP clients proper send no Origin. */
const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLocalhostOrigin(origin: string): boolean {
  try {
    return LOCALHOST_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * The MCP bearer, mirroring requireSyncToken: when the MCP_TOKEN secret is
 * configured, every request must present it; unset = open (the documented
 * SYNC_TOKEN local-dev contract — docs/MCP.md says so loudly). Returns the
 * 401 body instead of throwing ApiFail so the response stays JSON-RPC-shaped.
 * The token is compared in constant time, never logged or echoed.
 */
function requireMcpToken(c: Context<App>): JsonRpcResponse | null {
  const expected = c.env.MCP_TOKEN;
  if (!expected) return null;
  const header = c.req.header('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match || !safeEqual(match[1].trim(), expected)) {
    return rpcError(null, MCP_UNAUTHORIZED, 'Unauthorized.');
  }
  return null;
}

app.post('/api/mcp', async (c) => {
  // DNS-rebinding hardening (MCP spec recommendation): a present, non-local
  // Origin header means a browser page on someone else's origin is driving
  // this request — reject before any processing. Server-to-server MCP
  // clients send no Origin header at all.
  const origin = c.req.header('Origin');
  if (origin !== undefined && !isLocalhostOrigin(origin)) {
    return c.json(rpcError(null, MCP_FORBIDDEN_ORIGIN, 'Origin not allowed.'), 403);
  }
  const unauthorized = requireMcpToken(c);
  if (unauthorized !== null) return c.json(unauthorized, 401);

  const message = parseJsonRpcMessage(await c.req.text());
  // Protocol-level rejects (unparseable body / not a single JSON-RPC message).
  if (message.kind === 'invalid') return c.json(message.response, 400);
  const response = await handleMcpMessage(message, bindMcpTools(c.env));
  // Notifications (and ignorable notifications/* strays) get no body.
  if (response === null) return c.body(null, 202);
  return c.json(response);
});

// No SSE stream in v1: the GET half of Streamable HTTP is declined with
// 405 + Allow, which compliant clients treat as "POST only".
app.get('/api/mcp', (c) =>
  c.json(rpcError(null, MCP_NOT_ALLOWED, 'Method not allowed. POST a single JSON-RPC message.'), 405, {
    Allow: 'POST',
  }),
);

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

/**
 * Cron tick (wrangler.jsonc `triggers`, daily 08:00 UTC). The tick itself is
 * dumb on purpose: the cadence + config gates in runScheduledBriefing decide
 * whether anything is sent, so daily ticks serve the weekly cadence too.
 */
async function scheduled(
  _controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  ctx.waitUntil(
    (async () => {
      try {
        // The /api/* middleware is not on this path — ensure tables exist.
        await ensureSchema(env.DB);
        await runScheduledBriefing(env.DB);
      } catch (err) {
        // Message only — never a payload or credential (spec §20; the
        // whatsapp taxonomy already dropped anything sensitive).
        console.error(
          '[ledgerly] scheduled briefing failed:',
          err instanceof Error ? err.message : 'unknown',
        );
      }
    })(),
  );
}

/**
 * Cloudflare Email Routing door (docs/EMAIL-FEED.md). Deploy-only and kept
 * deliberately thin: its logic IS the tested ingestRawEmail pipeline, and the
 * local/CI door for the same pipeline is POST /api/inbound-email. Rejections
 * become permanent SMTP errors via setReject, so a blocked sender's mail
 * bounces instead of silently vanishing.
 */
async function email(
  message: ForwardableEmailMessage,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  // The /api/* middleware is not on this path — ensure tables exist.
  await ensureSchema(env.DB);
  // Reject oversized mail before buffering the stream at all.
  if (message.rawSize > MAX_INBOUND_EMAIL_BYTES) {
    message.setReject('Message is larger than 5 MB.');
    return;
  }
  const raw = await new Response(message.raw).arrayBuffer();
  const result = await ingestRawEmail(env, raw, message.from ?? null);
  // Expected rejections become PERMANENT SMTP errors; an unexpected throw is
  // deliberately left to propagate — the runtime answers with a temporary
  // failure and the sending server retries, which is what a transient D1
  // blip deserves. Nothing here logs headers or content (spec §20).
  if (result.ok === false) message.setReject(clip(result.reason));
}

// Hono keeps serving fetch; the scheduled + email handlers ride alongside it.
export default { fetch: app.fetch, scheduled, email };
