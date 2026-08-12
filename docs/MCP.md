# The MCP server

Point your own AI client at your own finances. Ledgerly's worker exposes a
**read-only** [MCP](https://modelcontextprotocol.io) endpoint at `/api/mcp`,
so Claude Code, Claude Desktop, or any other MCP client can search your
ledger, summarize spending, and read your recurring patterns, forecast,
budgets and briefing — **your client talks directly to your worker**. Your
data is never routed through any vendor's aggregator, and Ledgerly itself
never sends it anywhere: the AI client you choose (and the model behind it)
is the only thing that ever sees a tool result.

## The read-only guarantee

Read-only is **structural**, not a policy promise:

- **No tool mutates anything.** There is no write of any kind behind the
  endpoint — no insert, no update, no delete, no settings change. The tool
  registry contains exactly six read tools, and a test pins those six names:
  adding a seventh tool (or a mutating one) fails the build.
- **No settings exposure.** Tool results carry at most the display currency
  code. The sender allowlists, AI configuration, WhatsApp configuration and
  every secret-adjacent flag never leave the worker through MCP.
- **No internals.** Transactions are returned as
  `id / date / merchant / category / amount / type / account / tags` — never
  fingerprints or storage keys.

A prompt-injected or simply confused model on the client side can therefore,
at worst, *read* what you already chose to expose — it cannot change or
delete anything.

## Setup

### 1. Set a token (deployed workers)

```sh
npx wrangler secret put MCP_TOKEN
```

Every `/api/mcp` request must then carry `Authorization: Bearer <token>`.
Wrong or missing token → `401`.

> **Local dev is open by design — read this.** When `MCP_TOKEN` is **not**
> configured, `/api/mcp` accepts unauthenticated requests. This is the same
> contract as `SYNC_TOKEN`: local dev on your own machine carries no auth,
> and production privacy comes from Cloudflare Access plus the token. **Never
> deploy publicly without setting `MCP_TOKEN`** (and ideally Cloudflare
> Access in front of it).

As extra hardening against DNS-rebinding, browser-originated requests are
rejected: if a request carries an `Origin` header that is not a localhost
origin, the endpoint answers `403` before doing anything. Server-to-server
MCP clients send no `Origin` header and are unaffected.

### 2. Connect Claude Code

```sh
claude mcp add --transport http ledgerly https://<your-worker>/api/mcp \
  --header "Authorization: Bearer <token>"
```

For a local dev server (no token configured):

```sh
claude mcp add --transport http ledgerly http://localhost:5173/api/mcp
```

### 3. Connect Claude Desktop

Add to the `mcpServers` object of your Claude Desktop config:

```json
{
  "mcpServers": {
    "ledgerly": {
      "type": "http",
      "url": "https://<your-worker>/api/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

Then ask things like *"what did I spend on dining last month?"*, *"which
subscriptions renew in the next two weeks?"*, or *"am I over budget
anywhere?"*.

## The tools

All arguments are optional on every tool; unknown or malformed arguments are
rejected with a readable message. Amounts are positive magnitudes —
direction is carried by `type` (`expense` | `income`).

### `search_transactions`

Search the ledger. Filters combine with AND; results newest first.

| Argument | Type | Meaning |
|---|---|---|
| `query` | string | Case-insensitive substring matched against merchant, category and account. Literal text — `%` and `_` are not wildcards. |
| `dateFrom` / `dateTo` | string | Inclusive `YYYY-MM-DD` bounds (real calendar dates). |
| `type` | string | `expense` or `income`. |
| `category` | string | Exact category name (case-insensitive). |
| `account` | string | Exact account name (case-insensitive). |
| `minAmount` / `maxAmount` | number | Positive amount bounds (inclusive). |
| `limit` | integer | Rows returned, 1–200 (default 50). |

Returns `{ transactions, matched, returned, capped }` — `matched` is the
total count for the same filters, so a capped result is always honest about
what it left out.

### `get_summary`

Income, spending, net and top-5 spending categories.

| Argument | Type | Meaning |
|---|---|---|
| `period` | string | One of the app's periods: `all-time`, `this-month`, `last-month`, `last-3-months`, `last-6-months`, `this-year` — the same window math as the Dashboard. |
| `dateFrom` / `dateTo` | string | Explicit inclusive bounds instead of a period. |

`period` and an explicit range are mutually exclusive; passing neither means
all-time. Returns the resolved `dateFrom`/`dateTo` (null = unbounded),
`income`, `spending`, `net`, `txCount`, `topCategories` and the display
`currency`.

### `get_recurring`

Recurring payments and subscriptions found by the deterministic detection
engine — both expenses and income; patterns you dismissed in the app are
excluded.

| Argument | Type | Meaning |
|---|---|---|
| `type` | string | Only `expense` or `income` patterns (default: both). |

Each pattern reports merchant, kind, cadence, average amount, monthly
equivalent, next/last date, confidence, category and direction.

### `get_forecast`

The deterministic cash-flow projection: it only extends detected recurring
patterns — no trend fitting, no invented numbers, and an empty ledger
forecasts nothing.

| Argument | Type | Meaning |
|---|---|---|
| `horizonDays` | integer | `30`, `60` or `90` (default 30). |

Returns the full forecast (projected occurrences, cumulative daily points,
totals, series counts) plus the display currency.

### `get_budgets`

No arguments. Current calendar-month status of every **active** budget, with
the same month-window and category-matching semantics as the Budgets page:
`{ month, budgets: [{ category, limit, spent, remaining, over }] }`.

### `get_briefing`

No arguments. The exact briefing the app can deliver — last 7 days of real
activity, next 7 days of projections, honest to-review counts — as
`{ briefing, text }`, where `text` is the rendered plain-text message.

## Protocol notes and honest limitations

- **Transport:** stateless Streamable HTTP. `POST /api/mcp` with a single
  JSON-RPC 2.0 message returns a single JSON response. There is no SSE
  stream (`GET` answers `405`), no server push, and no sessions
  (`Mcp-Session-Id` is ignored, as the spec allows for stateless servers).
- **Single messages only:** JSON-RPC batch arrays are rejected with
  `-32600`.
- **Notifications** (messages without an `id`, e.g.
  `notifications/initialized`) are accepted with `202` and an empty body.
- **Protocol version:** the server speaks `2025-06-18` and responds with
  that version regardless of what the client offers.
- **Auth is a bearer token, not OAuth.** MCP's OAuth flow is not implemented
  yet; the token + Cloudflare Access is the deployment story for now.
- **Dates are UTC.** "Today" for the forecast, recurring detection, summary
  periods and the budget month is the worker's UTC calendar day (the app's
  pages use your browser's local day, which can differ near midnight).
- **Summary/recurring/forecast/budgets read the same dataset the app does:**
  the newest 5000 transactions. `search_transactions` queries the full table
  directly.
- **Read-only means read-only.** There is deliberately no way to add,
  categorize or delete anything over MCP — review actions stay in the app,
  where you can see what you're confirming.
