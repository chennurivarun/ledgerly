# BYO endpoint — any OpenAI-compatible server as your AI provider

Ledgerly's **Custom endpoint (BYOK)** provider points receipt extraction at any
server that speaks the OpenAI chat-completions shape: `POST
{baseUrl}/chat/completions` with an optional `Authorization: Bearer` key. One
provider unlocks a whole ecosystem — free hosted models on NVIDIA Build, a
fully-local Ollama or vLLM, OpenRouter's catalog, or anything you run yourself.

The data-flow trade is yours to make, stated plainly: Ledgerly sends document
images to **whatever endpoint you configure**. Your own server keeps the data
fully yours; a hosted endpoint sees what you send it.

## Setup

Settings → AI receipt extraction → **Custom endpoint (BYOK)**, then:

| Field | Required? | Notes |
|---|---|---|
| Endpoint base URL | yes | The `/v1`-style base — Ledgerly appends `/chat/completions`. Stored normalized (trailing slashes stripped). |
| Endpoint API key | no | Write-only, never echoed back. Leave empty for keyless servers like local Ollama. |
| Model id | yes | There is no default — your endpoint could be serving anything, so you name the model. Pick a **vision-capable** one: receipts travel as images. |

The base URL must be `https://…`. Plain `http://` is accepted **only** for
`localhost` / `127.0.0.1` / `[::1]` — and that pairing only works when Ledgerly
itself runs locally (`npm run dev`): a deployed Worker runs on Cloudflare's
edge and cannot reach your machine. URLs with embedded credentials
(`user:pass@`), query strings or fragments are refused; the key belongs in the
key field, where it is stored write-only.

## Example: NVIDIA Build (free hosted models)

1. Sign in at [build.nvidia.com](https://build.nvidia.com) and generate an API
   key (`nvapi-…`).
2. Base URL: `https://integrate.api.nvidia.com/v1`
3. Key: your `nvapi-…` key.
4. Model id — must be vision-capable for receipts, e.g.:
   - `nvidia/nemotron-3.5-lightning-30b-a3b`
   - `meta/muse-glimmer-30b`

Model ids move with NVIDIA's catalog — check the model page on build.nvidia.com
for the exact id string it lists.

## Example: local Ollama (keyless)

1. `ollama pull` a vision model and have Ollama running.
2. Base URL: `http://localhost:11434/v1`
3. Key: leave empty — Ollama needs none, and Ledgerly sends no
   `Authorization` header at all when no key is stored.
4. Model id: the tag you pulled (e.g. a llava/qwen-vl family model).

Local-dev pairing only: this works when you run Ledgerly locally next to
Ollama. A deployed Ledgerly cannot reach `localhost` (see above) — put a
real https endpoint in front if you want your own hardware behind a deployed
instance.

## Example: OpenRouter

Base URL `https://openrouter.ai/api/v1`, key `sk-or-…`, and any
vision-capable model id from their catalog. OpenRouter routes to many vendors —
the honest data-flow statement above applies to whichever vendor serves the
model you pick.

## What works today

| Capability | Custom endpoint | Notes |
|---|---|---|
| Receipt extraction — images (PNG/JPEG/WebP/GIF) | ✅ | Sent as a data-URI `image_url` part; nothing for the endpoint to fetch. |
| Receipt extraction — PDFs | ❌ not yet | PDF ingestion is a per-vendor extension no two OpenAI-compatible servers agree on. Ledgerly refuses up front with a readable message; use Sarvam or Anthropic for PDF receipts, or Read as statement for multi-page PDFs. |
| Statement reads (PDF) | ✅ | Via the browser flow below — your browser extracts each page and the worker feeds them to your endpoint. Text-first, with a scanned-page image fallback. |

## How statement reads work (the browser flow)

A Cloudflare Worker cannot rasterize a PDF and OpenAI-compatible servers do
not agree on PDF ingestion — so for statements, **your own browser does the
page work**:

1. You click **Read as statement** and confirm the preflight (pages, rounds,
   and the honest cost line: Ledgerly adds nothing; your endpoint's pricing
   applies — ₹0 on free endpoints).
2. The browser downloads the PDF from your vault and walks it page by page
   with pdf.js. A page with a real text layer is sent as **text** (more
   accurate and much cheaper than vision); a scanned or text-poor page is
   rendered to a JPEG and sent as an **image**.
3. Pages go to the worker in rounds of up to 8. The worker — never the
   browser — holds your endpoint key and makes the model calls: one text call
   and/or one vision call per round. Pick a **vision-capable** model if your
   statements are scans; a text-only model is fine for born-digital PDFs.
4. When every round is done, the worker runs the same validation, merchant
   cleanup, rule enrichment and duplicate pre-flagging every provider's rows
   get, and the review table opens. Nothing is imported until you confirm
   rows, exactly as always.

Honesty notes: free-tier rate limits mean a long statement takes minutes (the
row shows "Reading pages 9–16 of 23…" while it works, and the page stays
usable). A round that fails twice is skipped and the result is marked
**truncated** — a loud partial, never a silent hole. Closing the tab mid-read
cancels the run; statements are capped at 100 pages per read.

Requests go out with `temperature: 0` and **without** a structured-output
field: `response_format` support varies wildly across servers (some reject it,
some silently ignore it), and Ledgerly's validation pipeline re-checks every
field of every model answer anyway — nothing a model says is trusted, whichever
provider said it.

## Rate limits and free tiers, honestly

Free tiers are free because they are limited. NVIDIA Build's free keys are
rate-limited (bursts of extractions can hit 429s), OpenRouter's free models
have per-day caps, and a local Ollama is bounded by your hardware. Ledgerly
surfaces a 429 as a readable "rate limited — try again in a moment" rather than
retrying on your behalf. If extraction matters at volume, a paid tier or your
own server is the honest answer.

## Errors you might see

- **"Your custom endpoint rejected the API key."** — 401/403 from the server.
  Check (or remove) the stored key.
- **"Your custom endpoint has no such model or path."** — 404: wrong base URL
  path or a model id the server doesn't serve. Check both in Settings.
- **"Could not reach your custom endpoint."** — DNS/connection failure, or a
  deployed Ledgerly pointed at localhost.
- **"…did not answer within 90 seconds."** — the server accepted the request
  but never finished; slow hardware or a hung model.

Error bodies from the endpoint are deliberately dropped, never logged or
stored: an arbitrary server's error text can echo the request, and your key
must never end up in a log line.
