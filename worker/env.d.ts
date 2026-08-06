/// <reference types="@cloudflare/workers-types" />

interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  /** Optional bearer for /api/drive-sync; unset in local dev. Never logged. */
  SYNC_TOKEN?: string;
}
