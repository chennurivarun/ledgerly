import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts so unit tests run without the Cloudflare plugin.
export default defineConfig({
  // Tests must be deterministic — vite.config.ts's buildId is a fresh
  // timestamp per run, which would make BUILD_ID-dependent assertions flaky.
  define: { __LEDGERLY_BUILD_ID__: '"test-build"' },
  test: {
    include: ['tests/**/*.test.ts', 'shared/**/*.test.ts'],
  },
});
