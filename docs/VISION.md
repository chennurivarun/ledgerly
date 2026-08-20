# Ledgerly — Vision

> **AI-based finance management where the intelligence comes to your data —
> your data never goes to the intelligence.**

Ledgerly is a private, self-hosted finance dashboard that runs in **your own
Cloudflare account**: your transactions in your D1 database, your receipts in
your R2 bucket, no vendor in between. The vision is to grow it into the
privacy-first alternative for AI-assisted money management — first for
individuals, then for freelancers and small businesses.

## Why this, why now

In mid-2026 the "connect every account and let AI analyze it" lane was claimed
by the biggest player possible: OpenAI shipped bank-linked personal-finance
features inside ChatGPT (Plaid, 12,000+ institutions, an Intuit partnership).
Competing with that on connectivity would be pointless. But that product has a
structural ceiling it can never cross: **your complete financial life lives on
someone else's servers and feeds someone else's models.**

Meanwhile, the open-source finance world (Actual Budget, Firefly III,
Ghostfolio, Maybe/Sure) proved lasting demand for self-hosted money tools —
tens of thousands of GitHub stars, real communities — yet **none of them ship
native AI**, and their communities' loudest complaints are import friction and
missing intelligence.

That gap is the vision: **the trust model of self-hosted open source, with the
intelligence of a modern AI finance app.**

## What exists today

A complete, tested v1 — deterministic core plus the first rung of the AI
ladder (receipt extraction, shipped August 2026):

- Nine pages: dashboard, transactions, recurring, subscriptions, budgets,
  goals, documents, rules, settings — with a first-run onboarding wizard and
  30-currency display support.
- Deterministic engines with real test suites: duplicate-fingerprint imports,
  an auditable recurring/subscription detection algorithm, a rules engine,
  strict never-guess CSV parsing (ambiguity always asks the user).
- Documents vault: original receipt/statement bytes stored in R2.
- AI receipt extraction (off by default): Workers AI in the user's own
  Cloudflare account, or bring-your-own-key Anthropic. Suggestion-only —
  per-field confidence, a review form, and no transaction until the user
  confirms.
- A full data-erase flow, empty-start guarantee (no sample data, ever), and a
  `/api/drive-sync` contract ready for scheduled import runners.

## Principles (non-negotiable)

1. **Your data stays in your infrastructure.** Default deployment is the
   user's own Cloudflare account. Nothing phones home.
2. **Deterministic core, AI assist.** Money math — totals, dedupe, recurring
   detection, budgets — stays deterministic and auditable. AI suggests;
   it never silently writes.
3. **Never guess.** Ambiguous imports ask. Uncertain extractions go to
   review. Confirm-before-write everywhere.
4. **No sample data, no dark patterns, no invented numbers.** Empty states
   are honest; trends render only when real data supports them.

## Roadmap

### Phase 1 — Open source ✅ *(shipped August 2026)*

License: **AGPL-3.0**. Every comparable app with a hosted arm chose it
(Firefly III, Ghostfolio, Maybe); the one permissive-licensed peer (Actual,
MIT) watched third parties capture its hosting revenue. AGPL keeps a future
first-party cloud viable while staying genuinely OSI-approved open source —
which fair-source licenses are not, at real cost to directory listings and
launch trust.

Launch checklist: LICENSE + CONTRIBUTING + code of conduct, one-command
deploy docs ("deploy to your own Cloudflare in 10 minutes"), screenshots and
a public demo instance, then a Show HN positioned as the *open-source,
privacy-first alternative to AI finance apps*. Growth follows the proven
playbook (Plausible, Cal.com): "open-source alternative to X" content, not
star-chasing.

### Phase 2 — The AI ladder (evidence-ranked: impact × feasibility)

What the market data says is genuinely sticky is *invisible* AI judged by
friction reduction — not chat gimmicks (only ~18% of consumers are
comfortable letting AI make financial decisions autonomously).

1. **Categorization that learns from corrections.** 🚧 *In progress.* AI
   fallback where deterministic rules don't match; user corrections get
   promoted into new rules. The existing rules engine stays authoritative.
2. **Receipt extraction.** ✅ *Shipped.* The bytes were already in R2; a
   schema-constrained LLM reads one document into a suggested transaction
   (merchant, date, total, category) with per-field confidence, and the user
   confirms it in a review form. Two paths from one feature: **Workers AI**
   (inference inside the user's own Cloudflare account — the privacy-first
   default) and **bring-your-own-key** frontier models for maximum accuracy.
   Cents per document or less.
3. **PDF statement extraction — many transactions from one document.**
   ✅ *Shipped August 2026.* Receipt extraction handles the one-merchant-one-total shape; a bank or
   card statement is a *table* of dozens of rows, so it needs its own
   pipeline: page-aware reading, row-level extraction, and a review screen
   that triages a whole batch at once rather than a single form. CSV
   statements already import deterministically and stay the recommended
   path — this closes the gap for banks that only hand out PDFs.
   Non-negotiables carried over: nothing is inserted without confirmation,
   the existing duplicate fingerprint applies per row, unreadable rows are
   reported and skipped rather than guessed, and per-row confidence drives
   what the review screen puts in front of the user first. Feasibility note:
   this is the first feature where per-document cost and context limits
   matter (a 12-page statement is not a receipt) — expect chunking by page
   and a hard row cap per run.
4. **Cash-flow forecasting** on top of the recurring-detection engine — the
   numeric projection stays deterministic and auditable; AI narrates
   scenarios in plain language. ✅ *Deterministic projection shipped August
   2026 (30/60/90-day horizons on the Recurring page, income + expense
   series); AI narration still to come.*
5. **Natural-language search / MCP.** ✅ *Shipped August 2026.* Read-only.
   Expose the user's data as an MCP server so they can point *their own* AI
   client at *their own* finances — "chat with your money" without the data
   ever leaving their control. Six deterministic tools (search, summary,
   recurring, forecast, budgets, briefing) behind a bearer token; read-only
   is structural — no mutating tool exists. Setup in docs/MCP.md.
6. **Proactive briefings & anomaly alerts** — last, once 1–4 generate the
   signal that makes alerts useful instead of noisy. ✅ *Briefings shipped
   August 2026: a deterministic weekly/daily digest (last-7-days activity,
   next-7-days forecast, items awaiting review) delivered over WhatsApp via
   the user's own Meta Business Cloud API credentials. Anomaly alerts still
   to come.*

### The mail-in feed — the anti-Plaid ✅ *(shipped August 2026)*

The structural bet the deployment model makes possible: your bank's own
alert emails, e-receipts, and statements become a **credential-free,
real-time feed** — routed to an address you control and processed entirely
inside your own account. No aggregator, no shared bank login, any bank that
can send an email. A cloud vendor cannot copy this without reading your
email on their servers; Ledgerly has no servers to read it on. Bank formats
are community-contributed parser packs — the intelligence ships as open
code, never as pooled data. Ingestion is suggestion-only, allow-listed, and
never triggers AI, so a spoofed email can at worst propose a row the user
rejects.

### The Open Bank-Format Commons ✅ *(shipped August 2026)*

The anti-Plaid thesis, completed for statements: **AI reads a bank once,
the community inherits a deterministic parser forever.** A statement pack
is reviewable *data* — a layout grammar, never code — driving one
well-tested engine that reads a known bank's PDF in the browser: instant,
offline, zero AI, zero cost, no provider configured. A pack read must
*verify* before it proposes anything — serial numbers must increment and
the running balance must reconcile to the cent, or the whole read refuses —
and even verified rows ride the same review gate as every other source.
Unknown banks bootstrap through any AI provider once; the resulting layout
knowledge is distilled into a pack (structure only — never anyone's data)
and contributed back. The registry is deliberately host-agnostic
([docs/PACKS.md](PACKS.md)): input is plain per-page text, so Firefly III,
Actual Budget, or any importer can embed the same packs. Vendors whose
format knowledge *is* their moat cannot open it without unmaking
themselves; a commons that grows one contributor at a time is the moat
they can't buy. Next: distillation UX (derive a draft pack from a
confirmed AI read) and the one-click contribution flow.

### Phase 3 — Sustainability and the business wedge

- **Ledgerly Cloud**: first-party hosting for people who don't want to
  self-host. Same codebase, no feature gap for individuals — the paid
  product sells convenience, not ransomed features.
- **Freelancer / micro-business tier** (Cal.com-style: a separately-licensed
  enterprise directory, core stays AGPL): business-expense tagging, receipt-
  to-ledger automation, multi-user. The wedge is not "cheaper QuickBooks" —
  free incumbents own that — it's the same data-ownership thesis plus AI
  automation. The segment's 2026 lesson (Botkeeper's shutdown) is that
  funding-dependent platforms die and take client data workflows with them;
  a tool that runs in the customer's own account structurally cannot.

## Honest risks

- **Solo-maintainer burnout** is the #1 documented killer of projects like
  this. Scope must stay ruthless; the deterministic core must stay small.
- **Stars are not revenue.** Maybe Finance had 54k stars, VC funding, and a
  beautiful product — it was archived in 2025 and survives only as a
  community fork. The models that worked (Plausible: ~$3.5M ARR,
  bootstrapped) took years of content-driven growth.
- **AI trust is fragile in finance.** Cleo's $17M FTC settlement shows how
  fast AI + money + dark patterns destroys trust. Our principles above are
  the moat; violating them once forfeits it.

---

*Research basis: competitive and licensing landscape surveyed August 2026
(OSS finance apps, AI finance incumbents, open-core case studies). Detailed
findings with sources live in the project's research notes.*
