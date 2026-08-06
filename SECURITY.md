# Security Policy

Ledgerly handles financial data, so security reports get priority over
everything else.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability
reporting ("Report a vulnerability" under the Security tab) on this
repository. You'll get an acknowledgment within a few days.

## Scope notes for researchers

- The default deployment is single-user behind Cloudflare Access; the app
  itself intentionally has no login screen. Reports assuming an
  unauthenticated multi-user deployment of the current version are out of
  scope by design (multi-tenancy is a roadmap item).
- `POST /api/drive-sync` supports an optional bearer token (`SYNC_TOKEN`
  secret). Token-handling issues are very much in scope.
- Anything enabling injection through imported CSV/receipt content (the
  untrusted-input boundary) is in scope and high priority.
