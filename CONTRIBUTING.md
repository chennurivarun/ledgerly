# Contributing to Ledgerly

Thanks for your interest! Ledgerly is a privacy-first, self-hosted finance
dashboard — read [docs/VISION.md](docs/VISION.md) first to understand where
the project is going and the principles that are not up for debate.

## Ground rules (product invariants)

Pull requests that violate these will be declined regardless of code quality:

1. **No sample/demo financial data, ever.** First launch is empty.
2. **Never guess.** Ambiguous imports ask the user; uncertain extractions go
   to review status. Silent misparsing of money is the worst bug class.
3. **Deterministic money math.** Totals, dedupe fingerprints, recurring
   detection, and budgets stay deterministic and covered by tests.
4. **Data stays in the user's infrastructure.** No telemetry, no phoning
   home, no third-party services in the default path.

## Development

```bash
npm install
npm run dev        # Vite + local Worker with local D1/R2 (miniflare)
npm test           # vitest — must stay green
npm run check      # typecheck — must stay clean
npm run build      # must succeed
```

Local data persists in `.wrangler/state/` between runs.

## Architecture in one paragraph

React SPA in `src/` talks only to `src/api.ts` → a Cloudflare Worker in
`worker/` (Hono) → D1 (structured data, binding `DB`) and R2 (original
document bytes, binding `BUCKET`). Pure, shared logic — CSV parsing,
duplicate fingerprints, recurring detection, formatting — lives in
`shared/` and is unit-tested in `tests/`. The full product spec is
[docs/SPEC.md](docs/SPEC.md).

## Pull requests

- Keep PRs focused; one change per PR.
- New logic in `shared/` or `worker/` needs tests. UI changes should include
  a screenshot.
- Run all four commands above before opening the PR.
- Describe *why*, not just what.

## Reporting bugs

Include: what you did, what you expected, what happened, browser/OS, and —
for import bugs — a **redacted** sample of the CSV shape (headers + one fake
row). Never post real financial data in an issue.

## Security

See [SECURITY.md](SECURITY.md) — please do not open public issues for
vulnerabilities.
