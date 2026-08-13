// Version-skew detection (sprint 13). POST-DEPLOY INCIDENT 2 (2026-08-13): a
// browser tab loaded before a deploy kept running the old SPA bundle against
// the new worker for an hour. Fix: the worker stamps every /api/state
// response with the build id it was deployed with (worker/index.ts); the
// client compares that against BUILD_ID baked into its own bundle
// (vite.config.ts's `define`) and, on mismatch, shows a dismissible banner
// offering a reload (src/components/Layout.tsx's UpdateBanner). It NEVER
// auto-reloads — an open review modal with user edits must survive a deploy
// untouched.

// Deliberately the bare identifier, no `typeof __LEDGERLY_BUILD_ID__ !==
// 'undefined'` fallback: a build environment that misses the `define`
// (vite.config.ts or vitest.config.ts) must fail to build/run, not silently
// ship a bundle where skew detection can never fire.
declare const __LEDGERLY_BUILD_ID__: string;

export const BUILD_ID = __LEDGERLY_BUILD_ID__;

/**
 * Whether the reload banner should be offered. serverBuildId is null/undefined
 * when the server response predates this feature or hasn't been fetched yet —
 * unknown means no banner, never guess. dismissedBuildId suppresses exactly the
 * deploy the user already dismissed; a later, DIFFERENT deploy clears that
 * suppression (dismissing doesn't dismiss skew forever, just this one deploy).
 */
export function shouldOfferReload(
  clientBuildId: string,
  serverBuildId: string | null | undefined,
  dismissedBuildId: string | null,
): boolean {
  if (serverBuildId == null) return false;
  if (serverBuildId === clientBuildId) return false;
  if (serverBuildId === dismissedBuildId) return false;
  return true;
}
