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
| Receipt extraction — PDFs | ❌ not yet | PDF ingestion is a per-vendor extension no two OpenAI-compatible servers agree on. Ledgerly refuses up front with a readable message; use Sarvam or Anthropic for PDF receipts for now. |
| Statement reads (PDF) | ❌ not yet | Same reason. Sprint 16 lifts both by rendering pages to images in your browser and sending those. |

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
