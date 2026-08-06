# Research: AI in Consumer Finance & Ledgerly's Feature Ladder (August 2026)

*Compiled by an AI research pass, August 2026. Sources cited inline; the
researcher flagged unverifiable claims explicitly (much of 2026 search is
SEO content-mill material; Reddit was inaccessible directly, so sentiment is
reported secondhand). Conclusions feed [docs/VISION.md](../VISION.md).*

## Summary

The market converged on three AI patterns incumbents treat as genuinely
sticky — invisible categorization that learns from corrections, forecasting
grounded in real recurring transactions, and proactive insight surfacing —
while generic "chat with your money" is more hype than proven value
(reported Forrester data: only ~18% of consumers comfortable letting AI make
important financial decisions independently; ~55% prefer human-heavier
input). Privacy-first + AI is a real but thin niche; nobody combines
automated ingestion + deterministic rules + local/BYOK AI the way Ledgerly
could. Receipt/document extraction is the most build-ready AI feature since
Ledgerly already stores raw bytes in R2.

## 1. What ships in mid-2026

| App | AI features | Notes |
|---|---|---|
| Monarch | NL assistant, dashboard insights, weekly recap, cash-flow forecasting + what-if | Forecasting gated to $199/yr tier |
| Copilot Money | Correction-learning categorization, recurring detection, proactive "Money Assistant" (beta Apr 2026), read-only **MCP beta** for external AI clients | Staged autonomy: "nothing happens without your say-so" |
| YNAB | **No native AI** (third-party FinInsights bolts on forecasting via API) | The methodology-loved app hasn't chased AI |
| Rocket Money | Invisible ML: subscription detection, negotiation, autopilot savings | Trust complaints target fees, not AI |
| Cleo | Chat-personality AI (roast/coach) | **$17M FTC settlement (2025)** over cash-advance/fee practices; AI-as-support backfired |

Sticky = invisible AI judged by friction reduction. Hype = chat as headline.

## 2. Privacy-first AI

- Closest analog: Thrust (on-device "AI CFO", manual entry, iOS-only). No
  surveyed app combines automated ingestion + deterministic rules +
  local/BYOK AI.
- BYOK nuance: BYOK improves *provider*-side privacy only — the app must
  also genuinely not persist outbound payloads, or run inference in
  infrastructure the user owns.
- **Cloudflare Workers AI** runs inference inside the same account as
  D1/R2 — a defensible "data never leaves your infrastructure" story.
  Reported: ~$0.011 per 1,000 Neurons, 10k free/day, small text + vision
  models available. *Re-verify current catalog/pricing on
  developers.cloudflare.com before committing to model IDs.*
- Local-LLM tooling (Ollama, LM Studio, llama.cpp) crossed to mainstream in
  2026; finance-specific demand evidence is a flagged research gap.

## 3. Receipt/document extraction

- Reported accuracy for clean receipts on vision LLMs: high-80s to mid-90s
  percent (SEO-sourced figures — treat as illustrative range only).
- Production pattern (consistent across sources): **hybrid** — OCR for text,
  LLM for schema-constrained JSON extraction, per-field confidence, human
  review for low confidence. Open-source references exist (e.g.
  bhimrazy/receipt-ocr, MIT).
- Cost: well under a cent to a few cents per receipt on mini/haiku-tier
  vision models (estimate, not benchmarked); batch APIs ~50% off for
  backfills.
- Ledgerly fit: `worker/documents.ts` already stores bytes; extraction is an
  async step feeding the existing review-before-write UX. Ship Workers AI
  (privacy default) + BYOK frontier (accuracy) from one feature.

## 4. Small-business wedge

- Below-QuickBooks tier is owned by free/cheap incumbents (Wave, Zoho Books
  free tier, FreshBooks, Quicken Business & Personal @ $4.99/mo).
  "Cheaper QuickBooks" is a weak wedge.
- Credible wedge = the same data-ownership thesis + receipt-to-ledger AI
  automation for freelancers/micro-SMBs.
- **Botkeeper shut down Feb 2026** after 11 years (AI bookkeeping for
  accounting firms): customer consolidation + genAI-native competition +
  the VC-dependence trap — "when the funding model breaks, the clients pay
  the price." An argument *for* a tool that runs in the customer's own
  account and survives without a funded vendor.
- Widely-circulated solopreneur-AI-adoption statistics (78%, 109% YoY, 3x)
  all trace to unsourced marketing content — **not usable in a business
  case**.

## 5. Ranked feature ladder (impact × feasibility, grounded in the codebase)

1. **Categorization that learns from corrections** — additive over
   `worker/rules.ts`; deterministic rules stay authoritative; corrections
   promote into rules. The market-proven sticky pattern; lowest risk.
2. **LLM receipt/document extraction** — bytes already in R2
   (`worker/documents.ts`); hybrid OCR+LLM, confidence scores, review
   queue; Workers AI + BYOK paths.
3. **Cash-flow forecasting** — build on `shared/detection.ts`; numeric core
   deterministic/auditable, LLM narrates what-if scenarios only.
4. **NL search / MCP (read-only)** — expose the user's data as an MCP server
   so their own AI client chats with their own data; weakest standalone
   stickiness evidence, near-free via the MCP route.
5. **Proactive briefings/anomaly alerts** — sequence last; needs signal from
   1–3 to avoid alert fatigue; beta-stage even for funded incumbents.

## Sources

[Monarch](https://www.monarch.com/whats-new) ·
[Copilot Money Assistant](https://www.copilot.money/dispatch/beta-introducing-your-money-assistant) ·
[YNAB vs AI apps](https://useorigin.com/resources/blog/ynab-vs-ai-finance-apps-whats-actually-better-in-2026) ·
[FTC v. Cleo complaint](https://www.ftc.gov/system/files/ftc_gov/pdf/cleo_ai_redacted_complaint_2025.03.27.pdf) ·
[Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) ·
[Botkeeper shutdown](https://cfotech.co.uk/story/ai-bookkeeping-startup-botkeeper-shuts-after-11-years) ·
[receipt-ocr reference](https://github.com/bhimrazy/receipt-ocr) ·
[local LLMs in 2026](https://byteiota.com/local-llms-are-good-now-what-actually-changed-in-2026/)

**Flagged:** Reddit sentiment is secondhand; accuracy percentages and
adoption statistics from SEO sources are directional only; Forrester figures
reported via secondary summaries.
