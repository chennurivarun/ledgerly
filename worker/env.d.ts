/// <reference types="@cloudflare/workers-types" />

interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  /** Workers AI binding — inference inside the user's own Cloudflare account.
   * In local dev this proxies to Cloudflare and needs `wrangler login`;
   * extraction must degrade gracefully when the call fails. */
  AI?: Ai;
  /** Optional bearer for /api/drive-sync; unset in local dev. Never logged. */
  SYNC_TOKEN?: string;
}
