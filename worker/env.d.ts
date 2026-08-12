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
  /** Optional bearer for /api/mcp; unset = open, for local dev only (the
   * documented SYNC_TOKEN contract — see docs/MCP.md). Never logged. */
  MCP_TOKEN?: string;
}
