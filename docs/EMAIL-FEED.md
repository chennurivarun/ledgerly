# The mail-in feed

Bank alert emails become a credential-free transaction feed. Most banks can
email you on every transaction; route those alerts into your own Worker and
Ledgerly turns each one into a **proposed** entry you confirm or dismiss. No
bank credentials, no aggregator, no screen-scraping — the bank already tells
you what happened, and that email is yours.

## The security model (read this first)

- **Secure by default.** The feed ships **off**, and even when on, an **empty
  allowlist ingests nothing**. Both gates are checked before a single byte of
  the message is parsed.
- **Suggestion-only, always.** Ingestion never writes a transaction. The only
  path from an email to your ledger is the Confirm button, which re-validates
  everything server-side. A spoofed email can at worst *propose* an entry you
  reject.
- **No AI on inbound mail.** Parsing is deterministic (regexes, not models).
  Attachments land in the Documents vault as plain stored files; AI extraction
  remains a separate action you click yourself.
- **Minimal retention.** Ledgerly stores the sender address, a clipped
  subject, the parsed fields, and the attachment (if any). The body and raw
  MIME are never persisted, and nothing about a message is logged.
- **Deduped.** Message-IDs are unique (falling back to a content hash), so a
  re-delivered or re-forwarded message is a silent no-op, never a second row.
- **Capped.** Messages over 5 MB are rejected before parsing, and at most
  `MAX_INBOX_EMAILS_PER_DAY` (200) emails are accepted per UTC day.

## The allowlist

`Settings → emailAllowedSenders` holds either:

- a full address — `alerts@chase.com`
- a whole domain — `@chase.com`

Matching is case-insensitive and **exact**:

- `no-reply@evil-chase.com` does **not** match `@chase.com` (whole-domain
  comparison, never a suffix).
- `no-reply@alerts.chase.com` does **not** match `@chase.com` either —
  subdomains must be allowlisted explicitly (v1 pins this: you can always add
  `@alerts.chase.com`, but a loose rule can never be taken back).

When Cloudflare delivers the message, the **SMTP envelope sender** is what is
checked (the `From:` header is only a fallback for the HTTP door). Envelope
spoofing is possible in general, which is exactly why ingestion is
suggestion-only — the allowlist is a noise filter, the Confirm click is the
security boundary.

## Setup A: Cloudflare Email Routing (deployed Worker)

1. Deploy Ledgerly (`npm run deploy`) and add your domain to Cloudflare.
2. In the Cloudflare dashboard: **Email → Email Routing → Enable**, and follow
   the DNS prompts (MX + SPF records are added for you).
3. Create a custom address, e.g. `ledger@yourdomain.com`, and set its action
   to **Send to Worker → ledgerly**. The Worker's `email()` handler feeds the
   same pipeline as everything else.
4. In Ledgerly's Settings, enable the mail-in feed and allowlist your bank's
   alert sender.
5. At your bank: turn on **per-transaction alert emails** (usually under
   Alerts/Notifications; set the amount threshold to the minimum) and point
   them at `ledger@yourdomain.com` — or auto-forward them from your mailbox
   with a filter.

Rejections (blocked sender, feed disabled, over cap) answer with a permanent
SMTP error, so misdirected mail bounces instead of silently vanishing.

## Setup B: the HTTP door (local dev, CI, any other mail pipe)

`POST /api/inbound-email` accepts a raw RFC-822 message as the request body
and runs the identical pipeline. If a `SYNC_TOKEN` secret is configured the
endpoint requires `Authorization: Bearer <token>` (same contract as
`/api/drive-sync`); without one — local dev — it is open.

```sh
curl -sS -X POST 'http://localhost:5173/api/inbound-email?from=no-reply@chase.com' \
  -H 'Content-Type: message/rfc822' \
  --data-binary @alert.eml
```

- `?from=` overrides the envelope sender when your pipe knows it; otherwise
  the message's `From:` header is used.
- Responses: `{"ok":"ingested","id":"…","status":"proposed"|"unparsed"}`,
  `{"ok":"duplicate"}`, or a 400 with `{"ok":false,"reason":"…"}`.

Any system that can produce a raw email can feed this — a procmail rule, a
`fetchmail` cron, an AWS SES receipt rule, a GitHub Action.

## What the parser does (and refuses to do)

The deterministic parser proposes fields only when the email states them
unambiguously:

- **amount** — exactly one money-like value in subject+body. A marketing blast
  full of prices produces zero proposals.
- **direction** — an unambiguous keyword (`charged`, `payment to`, `debited` …
  vs `credited`, `deposited`, `refund` …). Both kinds present, or neither →
  no proposal. Direction flips signs; it is never guessed.
- **merchant** — a literal `at|to|from` capture after the direction phrase.
- **date** — the email's own arrival date. Printed in-body dates are ambiguous
  (`01/02`) and are deliberately not read in v1.

Anything the parser cannot establish makes the whole email **unparsed** — you
still get the row (it is the audit trail) and can fill the form yourself.
Confirming re-validates every field server-side and runs the same duplicate
fingerprint as every other import path.

## Contributing a parser pack

`worker/email/parse.ts` defines the extension point:

```ts
export interface ParserPack {
  name: string;
  parse(subject: string, body: string): InboxParsedFields | null;
}
```

Packs run in registration order; first match wins. The v1 pack is
`generic-en`. A good pack for your bank's exact wording beats a clever general
one — return `null` for anything you are not sure about (the runner re-checks
your output and stamps the arrival date if you return `date: ''`). Add
fixture tests to `tests/emailFeed.test.ts` with real (redacted) alert wording
and register the pack in `PARSER_PACKS`.
