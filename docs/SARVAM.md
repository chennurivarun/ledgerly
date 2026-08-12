# The Sarvam provider

Ledgerly can read receipts and PDF bank statements with [Sarvam AI](https://www.sarvam.ai)'s
Document AI — a document-extraction stack built for Indian documents, covering
22 Indic languages plus English. Like the Anthropic provider it is strictly
BYOK: your documents go to Sarvam under **your** key, only when **you** click
extract, and nothing a model returns is ever written to your ledger without
your row-by-row confirmation.

## Getting a key

1. Create an account at [dashboard.sarvam.ai](https://dashboard.sarvam.ai) and
   copy an API subscription key.
2. In Ledgerly, open **Settings → AI extraction**, choose **Sarvam**, and paste
   the key. It is stored write-only in your own database and never displayed
   again; `null`-saving the field removes it.

## What it can read

- **Receipts and invoices** — PDF, JPEG or PNG, through the same review modal
  as every other provider.
- **PDF bank statements** — any length, through the statement review table.

## Unlimited statement size, in 10-page batches

Sarvam caps one extraction job at 10 pages, so Ledgerly splits longer
statements into sequential 10-page chunks, runs one job per chunk, and merges
the rows back in printed order. A 60-page statement is simply 6 jobs; the
batches run one at a time, which also stays inside Sarvam's 10-requests-per-
minute account limit.

**Batch-boundary caveat:** chunks do not overlap. A transaction row printed
across a page boundary can be misread or lost at the seam. Ledgerly does not
paper over this — if any part of a run comes back incomplete (a failed batch
after earlier ones succeeded, or a partially processed job), the statement is
marked **partial**, loudly, and the review screen says rows may be missing.
Cross-check the imported rows against the PDF as you review, exactly as you
would for any extraction.

If a batch fails before any batch has succeeded, the run fails with the reason
(bad key, rate limit, unreadable file) and nothing is stored as read.

Password-protected PDFs are refused with an explanation — bank statements
often ship protected; download an unprotected copy or print to a new PDF.
Ledgerly never attempts passwords.

## Honest cost estimates

Sarvam bills per page. Ledgerly will show an estimated cost on the statement
preflight **only if you enter your own per-page rate** (from your Sarvam
dashboard) in Settings — it is a display-only number you control. If no rate
is saved, no estimate is shown: a guessed price would just be a made-up number
wearing a currency sign.

`GET /api/documents/:id/statement/preflight` returns the page count, batch
count, resolved provider and that estimate before anything is sent anywhere —
it is free and side-effect-free.

## Confidence markers

Sarvam's extractor returns plain values without per-field confidence. Ledgerly
maps every present field to a fixed mid confidence (0.7) and every missing one
to unknown, so the review screen's verification markers stay meaningful: a
machine-read field is neither "unread" nor pretend-certain, and the fields
Sarvam could not read are flagged for you to fill in. Every value is still
re-validated server-side before it is even proposed — Sarvam output gets no
more trust than any other model's.
