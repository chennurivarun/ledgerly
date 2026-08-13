import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cloudflare } from '@cloudflare/vite-plugin';

// Computed once per `vite build`/`vite dev` process — not inside the
// defineConfig callback, and NOT simply a module-scope `const` either.
// @cloudflare/vite-plugin resolves config separately per environment (worker
// vs client), reloading this file fresh each time (bypassing the module
// cache) even though it's the same Node process — verified empirically: a
// plain module-scope timestamp produced a DIFFERENT value per environment,
// so the worker and client bundles disagreed on BUILD_ID immediately after a
// single build. Caching the value on `process.env` survives those repeat
// module evaluations because process.env is shared for the life of the
// process, giving exactly one id per build (or dev-server run) regardless of
// how many times this file is re-imported. The client and worker then always
// agree within one deploy; version skew (see shared/version.ts) can only
// come from a browser tab that already loaded an older bundle before a
// newer deploy landed.
const buildId = process.env.LEDGERLY_VITE_BUILD_ID ??
  (process.env.LEDGERLY_VITE_BUILD_ID = new Date().toISOString());

// Workers AI has no local simulator, so when remote bindings are enabled the
// Cloudflare plugin opens an authenticated proxy session at dev-server
// startup — and a fresh clone with no Cloudflare credentials fails to boot
// at all. Local dev must never require an account (README quick start), so
// remote bindings are opt-in: LEDGERLY_REMOTE_BINDINGS=true (env or .env)
// routes the AI binding through your Cloudflare account (`wrangler login`
// or CLOUDFLARE_API_TOKEN). With it off, `env.AI` still exists but rejects
// at call time; D1, R2, and every non-AI route run fully locally either way.
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), 'LEDGERLY_'), ...process.env };
  const remoteBindings = env.LEDGERLY_REMOTE_BINDINGS === 'true';
  return {
    plugins: [react(), tailwindcss(), cloudflare({ remoteBindings })],
    // Honor an externally assigned port (tooling sets PORT); default stays 5173.
    server: { port: Number(process.env.PORT) || 5173 },
    define: { __LEDGERLY_BUILD_ID__: JSON.stringify(buildId) },
  };
});
