import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cloudflare } from '@cloudflare/vite-plugin';

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
  };
});
