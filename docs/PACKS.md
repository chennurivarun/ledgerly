# Statement packs — the Open Bank-Format Commons

A statement pack is a small, shareable piece of DATA that teaches a host
application to read one bank's statement text layout **deterministically**:
no AI call, no network, no cost, and no wait. A pack is interpreted by one
engine (`shared/packs/engine.ts`); it is never code, so a community
contribution is a reviewable object literal, not an audit burden.

This document is the pack format's public spec. It is deliberately
**host-agnostic** — Ledgerly is the first consumer, not the only intended one.

## Trust model

A pack read either **verifies or refuses**. There is no partial-credit path.

The engine walks a statement's lines with the pack's grammar, closing rows
one at a time, and — as each row closes — checks the verification chains the
pack declares:

- **balance-chain**: the previous running balance, plus or minus the row's
  amount, must reproduce the row's own printed balance exactly, to the cent.
  This is also how the row's direction (expense vs income) is recovered: the
  arithmetic direction that reproduces the balance IS the type.
- **serial-chain**: the row's printed serial number must be exactly one more
  than the previous row's.

The first row, chain, or structural rule that breaks anywhere refuses the
**whole** parse — never a partial or best-effort result. Refusal reasons are
strictly structural (a row's position, a page number, a chain's name) and
never contain statement content — no date, amount, description, or other
transaction data ever ends up in an error message.

Even a fully verified read is still only a **suggestion**. Pack-parsed rows
ride through the exact same review gate as AI-proposed rows: nothing becomes
a real transaction until a person confirms it. A pack removes the AI call
(and its cost, latency, and provider dependency) from an otherwise-identical
review flow — it does not remove the review.

## Input contract

A pack sees **per-page plain text** — one string per page, in page order,
never PDF bytes and never column/coordinate geometry. Any extraction that
produces this shape works:

- `pdf.js`'s text layer (what Ledgerly's browser-side statement flow already
  extracts before this ever reaches a pack).
- `pdftotext -layout` (poppler-utils) on the command line — the `-layout`
  flag is what preserves column alignment as runs of spaces, which pack
  grammars rely on.

A pack's regexes are written against **lines** split on `\n`. Column
boundaries in real statements show up as runs of 2 or more spaces; a single
space is assumed to occur only inside real content (a description). Grammars
should anchor gaps with `\s{2,}`, never a bare literal space count.

## Pack shape reference

All fields mirror `shared/packs/spec.ts`, which is the source of truth.

```ts
interface StatementPack {
  spec: 1;                          // the only value spec 1 accepts
  id: string;                       // '<country>.<bank>.<product>', e.g. 'in.kotak.savings'
  name: string;                     // shown in the UI: "Read with the <name> pack"
  country: string;                  // ISO 3166-1 alpha-2, lowercase: 'in'
  currency: string;                 // ISO 4217: 'INR'
  signature: string[];              // regex sources; every one must match page 1
  dateFormat: PackDateFormat;       // 'dd MMM yyyy' | 'dd/MM/yyyy' | 'dd-MM-yyyy'
                                     //   | 'MM/dd/yyyy' | 'yyyy-MM-dd'
  direction: 'balance-delta';       // how type (expense/income) is recovered
  verify: ('serial-chain' | 'balance-chain')[];
  table: PackTableGrammar;
}

interface PackTableGrammar {
  headerLine: string;               // the table's column-header line
  openingBalanceLine?: string;      // seeds the balance chain; group: balance
  rowStart: string;                 // opens a row; groups: date, rest, [serial]
  rowTail: string;                  // closes a row; groups: amount, [balance]
  furniture: string[];              // lines skipped outright, even mid-row
}
```

Every regex field is a **string** (a regex source), never a compiled
`RegExp` — packs are plain, serializable data. The engine compiles them.

### Named groups are the contract

- `rowStart` **must** declare `date` and `rest`. `rest` is everything on the
  line after the date — it's what gets tested against `rowTail` for a
  same-line close, or becomes the row's first description fragment for a
  row that wraps. `serial` is optional, but required when `verify` includes
  `serial-chain`.
- `rowTail` **must** declare `amount`. `balance` is required when
  `direction` is `balance-delta` (today, that's always — it's the only
  direction mode spec 1 defines).
- Amount and balance tokens are matched as `[\d,]+\.\d{2}` and comma-stripped
  by the engine — both Indian grouping (`1,25,000.00`) and Western grouping
  (`125,000.00`) parse identically. A pack never needs to pick one.

## Engine semantics

`parseStatement(pack, pages)` runs one pass per page, line by line:

1. Before the table has started, every line is scanned only for
   `headerLine`; the first match flips into "table started" mode. Nothing
   else happens to pre-table lines (masthead furniture like a bank's name
   or account metadata needs no dedicated regex — it's ignored by construction).
2. Once started, each line is tested in this exact order:
   1. **`headerLine` or any `furniture` regex** → skip. This applies even
      with a row currently open — furniture (a page footer, a repeated
      section title, the header repeating on every page) routinely
      interleaves a row that wraps across a page boundary, and must not
      break it.
   2. **`openingBalanceLine`**, if not yet seeded → seeds the balance chain
      and continues.
   3. **`rowStart`** → if a row is already open, the whole parse refuses
      (a row cannot open before the previous one closed). Otherwise a new
      row opens from the captured groups, and `rowTail` is immediately
      tried against `rest` — a row whose whole content fits on one line
      closes right there.
   4. **A row is open** → `rowTail` is tried against this line's end. A
      match closes the row (everything before the match, trimmed, is the
      line's contribution to the description). No match appends the whole
      line as a description fragment and keeps the row open.
   5. **Nothing open** → the line is inter-table furniture; ignored.
3. `rowTail` always matches against the **end** of a string — a decimal
   token embedded inside a description (`"...invoice 45.00 total..."`)
   cannot close a row early, because nothing follows it to reach the
   required end-of-string anchor.
4. Description fragments are joined with single spaces and trimmed. A row
   whose wrap splits a single token mid-word (a real layout habit —
   reference numbers wrap arbitrarily) reassembles with a space at the cut
   point; this is accepted, pinned behavior, not a defect — the surrounding
   chain verification is what's load-bearing, not description fidelity.
   A zero-amount row whose balance is unchanged satisfies BOTH the
   expense and the income arithmetic at once — the engine refuses that row
   as direction-ambiguous rather than silently guessing 'expense'.
5. Amounts, balances and dates are re-parsed and re-validated independently
   of the pack's own regex shape: `[\d,]+\.\d{2}` for money (comma-stripped
   to exact integer cents — no float ever touches a money value), and a
   real UTC-calendar round-trip for dates (a syntactically valid but
   nonexistent date like `30 Feb` refuses). Parsed cents are also bounded to
   `Number.isSafeInteger` — an oversized amount token (enough digits to
   parse as an imprecise double, or overflow to `Infinity`) refuses rather
   than "verify" at confidence 1.
6. Structural bounds: any single line over 2000 characters, a statement of
   more than 200 pages, or a statement producing more than 5000 rows,
   refuses outright (a regex-safety and memory bound, not a business rule).
7. At end of input: a still-open row refuses ("never closed"); zero closed
   rows refuses ("no transaction rows recognized").

`detectPack(pages, registry)` looks only at `pages[0]`. A pack is a
candidate when **every** entry in its `signature` array matches (compiled
with the `m` flag). Exactly one candidate wins; zero or two-or-more is
`null` — an engine that can't attribute a statement to one pack unambiguously
refuses the attribution rather than guessing which is "more right."

## How to author a pack

1. **Layout knowledge only.** A pack encodes how a bank's PDF *looks* —
   column order, header text, date format, footer shape. It must never
   contain a real statement line, a real name, a real account or IFSC/MICR
   number, or a real amount. If you can't write the pack without a real
   statement open next to you, don't paste from it — describe the shape in
   your own words and regexes instead.
2. **Fixtures are synthetic, always.** Every test fixture is generated —
   never copied from a real document. `tests/helpers/syntheticStatement.ts`
   renders a Kotak-shaped statement from invented seed rows; a new pack
   needs an equivalent generator (or an extension of an existing one, if the
   layout is close enough) producing the same kind of realistic-but-fake
   text: wrapped descriptions, page furniture, both digit groupings if the
   pack's country uses more than one.
3. **What CI runs, and what must pass:**
   - `validatePack(pack)` returns `null` — structural shape, regex
     compilability, named-group presence for every mode the pack declares,
     and the id/country/currency formats.
   - The pack's `signature` matches your generator's page 1, and
     `detectPack` picks it out uniquely from the rest of the bundled
     registry (no ambiguity with an existing pack).
   - `parseStatement` round-trips your generator's fixtures back to the
     exact seed data: same dates (ISO), same amounts, same types, same
     running balances, in order.
   - Every bundled pack still passes `validatePack`, and bundled pack ids
     stay unique — a new pack shouldn't break anyone else's.
4. **Register it.** Add the pack module under `shared/packs/packs/`, and one
   line to `shared/packs/registry.ts`'s `STATEMENT_PACKS` array.

## Versioning

`spec` is a plain integer, bumped only for a **breaking** shape change.
`validatePack` rejects any top-level or `table`-level key it doesn't
recognize, and rejects `dateFormat` / `direction` / `verify` values outside
the enums this file documents — an engine build never silently tolerates or
ignores a field a newer pack author meant something by. Evolving the format
(a new direction mode, a new date layout, a new verification chain) is
always a spec bump plus new engine handling together, never a silent
addition.

## Embedding the engine elsewhere

`shared/packs/spec.ts` and `shared/packs/engine.ts` have no Ledgerly-specific
dependency — no D1, no network, no bindings, pure functions over plain data
and strings. A host that can produce the same per-page plain-text input
(`pdftotext -layout`, or any PDF text-layer extraction) can import both files
directly and call `detectPack` / `parseStatement` / `toStatementRowInputs` on
its own statement text. `toStatementRowInputs`'s output shape is
Ledgerly-specific (it matches `worker/ai/normalize.ts`'s raw-row envelope);
a different host maps `PackRow[]` to its own row shape instead.

## Distillation

Writing a pack by hand means opening a real statement next to a text editor —
exactly the thing rule 1 above says not to do. Distillation turns that around:
given a statement's per-page text and the rows a user already **confirmed**
in review (an AI read that succeeded once), `shared/packs/distill.ts` infers
a draft pack automatically, then **proves** it with the same engine described
above — before ever handing it back. A draft that doesn't fully verify
against the very statement it came from is refused, never returned.

```ts
function distillStatementPack(
  pages: readonly string[],
  anchors: readonly DistillAnchor[], // { date, amount, type } — no merchant text
  identity: DistillIdentity,          // { id, name, country, currency } — UI-supplied
): DistillResult; // { ok: true, pack, proof, reviewables } | { ok: false, reason }

function renderPackModule(pack: StatementPack): string; // the downloadable .ts file
```

An anchor is deliberately thin: date, amount, and direction only — no
merchant text (review-time cleaning means it no longer matches the printed
descriptor anyway) and no page/line position. At least `DISTILL_MIN_ANCHORS`
(3) are required; fewer refuses outright, since inference needs ground truth
to work from. Because everything past date-format detection works by
**repetition across pages**, a single-page statement refuses outright too
("a single-page statement cannot be distilled yet") — there's nothing to
repeat against yet.

### How it infers a draft

1. **Date format.** Each anchor's ISO date is rendered in every
   `PackDateFormat` and checked against the pages; the format whose
   renderings appear for at least `DISTILL_MIN_ANCHOR_MATCH` (60%) of anchors
   wins. No qualifying format, or a tie for the win, refuses. For the two
   slash-separated formats (`dd/MM/yyyy`, `MM/dd/yyyy`, sharing one digit
   shape), the winner additionally needs **corroboration**: at least one
   date-shaped token anywhere in the pages whose day-component, under the
   winning chirality, exceeds 12 — a value only valid as a day, never a
   month, proving the statement can't be silently re-read the other way.
   Absent that, "date format is ambiguous".
2. **Row anchoring.** Lines containing a winning-format anchor rendering are
   candidate row starts. Whether they're consistently preceded by a serial
   number (`^\d+\s{2,}` before the date) decides whether the drafted grammar
   declares `serial-chain`.
3. **Tail & balance.** Candidate rows are checked for a trailing
   `amount␣␣balance` money pair. None found refuses — spec 1 only ever drafts
   `balance-delta` packs, and that mode needs a running balance column.
4. **Grammar assembly**, from fixed structural templates only — never from
   interpolated statement text:
   - `rowStart` / `rowTail` come from a small per-date-format template table,
     the same shape as the bundled reference pack.
   - `headerLine` is the line that repeats (after generalization, below) on
     at least 60% of pages, has at least two column gaps (a real table
     header separates columns; a coincidental one-gap masthead line never
     qualifies), and sits closest above a page's first candidate row.
   - `openingBalanceLine` seeds the balance chain. Because the engine seeds
     it exactly once, before any row opens, the seed must sit above the
     statement's **true** first row — not just the first anchored one, since
     unanchored rows earlier in the statement still open under the same
     generic grammar once the real engine runs. The distiller locates that
     true first row generically, then walks backward to the nearest line
     carrying a money token — subject to the seed-line safeguards below.
   - `furniture` is every other 60%-repeated generalized line that also
     clears the structural-shape gate below, capped at 8.
   - `signature` is the generalized header line, plus — when one exists — one
     more 60%-repeated, non-page-1-only line that also clears the
     structural-shape gate.

5. **The proof.** The assembled candidate must pass `validatePack`, then
   `parseStatement` must verify against `pages`. Parsed rows are matched
   against anchors by exact date + cents-exact amount + type (each parsed
   row counts once); at least `DISTILL_MIN_ANCHOR_MATCH` of anchors must
   match — not all of them, since a user's review-time edit can legitimately
   diverge from the printed truth. A first-candidate failure retries a small
   bounded space (serial on/off, smaller furniture subsets, an alternate
   header pick) before refusing.

A successful distillation typically **reads more than it was given**:
anchors only need to cover a representative slice of a statement (the
real-world shape — a user only confirms what an AI review surfaced), but the
drafted grammar is generic across dates, so `proof.rows` commonly exceeds
`proof.anchorsTotal`.

Refusal reasons follow the same structural-only contract as the engine's:
never a date, amount, description, or account number — always a shape
("no repeating table header found", "no running balance column found — the
v1 pack format needs one", "a single-page statement cannot be distilled
yet").

### The privacy model — layered, not a single guarantee

An earlier version of this section claimed generalization alone kept a
distilled pack privacy-safe. An adversarial review found that false: a
person's name that happens to repeat identically on every page (a statement
holder's name in a running masthead is a real, common layout) sails through
a "repeated, ≥60%-of-pages" check exactly like a genuine column header does
— repetition proves nothing about whether a line is LAYOUT or CONTENT. What
actually protects a distilled pack is four independent layers, and it's
worth naming what each one does and doesn't cover:

1. **Strengthened generalization.** Every candidate line has ALL digit runs
   (any length — not just 5+, so a 2-digit day and a 4-digit year both die
   here too) turned into `\d+`, English month abbreviations into
   `[A-Z][a-z]{2}`, money tokens into their class, and 2+-space runs into
   `\s{2,}`. This guarantees dates and money values never survive as
   literal text. It says nothing about literal WORDS — "Balance", "Opening",
   and a person's surname generalize identically (none of them are digits).
2. **Structural exclusion.** A candidate line — for furniture or the
   signature's extra slot — must carry at least one surviving `\d+`, money
   class, or `\s{2,}` gap once generalized. A **pure-word** repeated line
   (a name, a title) is excluded outright, unconditionally, regardless of
   how many pages it repeats on. This costs nothing the engine's own oracle
   depends on: such lines are cosmetic for parsing (mid-row interruptions
   only ever pollute a description, never a chain), so dropping them is
   free. This is what actually stops a repeated masthead name from becoming
   furniture or signature.
3. **The balance-label vocabulary gate.** `openingBalanceLine` is a special
   case — it's the one line allowed to carry a NAMED capture group, so it
   needs its own, stricter check. Once its money token is set aside, every
   remaining alphabetic word must belong to `BALANCE_LABEL_VOCABULARY`
   (`Opening`, `Balance`, `Brought`, `Forward`, `Carried`, `Previous`,
   `Statement`, `Total`, `B/F`, `C/F` — a small, PR-extensible allow-list).
   A line that's ALSO shaped like an ordinary transaction row is refused
   outright before the vocabulary check even runs — an ordinary row's own
   content can never become the seed line, full stop.
4. **`reviewables` — the human-in-the-loop backstop.** Layers 1–3 are
   structural; none of them can tell a genuine layout label from a person's
   name that happens to ALSO pass every gate (a short, all-caps word that
   coincidentally repeats, or sits directly above a table by coincidence in
   a hand-crafted layout). The machine doesn't get to decide that call. A
   successful `distillStatementPack` result carries `reviewables: {
   field, literalText }[]` — every literal alphabetic run (length ≥2) that
   survived into `headerLine`, `furniture`, `signature`, or
   `openingBalanceLine` (`rowStart`/`rowTail` are fixed templates and never
   carry statement text, so they're never scanned), deduplicated by text.
   This is not a filter — it's a manifest. The host UI shows it and asks a
   person to confirm before the pack ever reaches the commons.

None of these layers is sufficient alone; together, a name has to survive
generalization (trivial), clear the structural-shape gate (only if it's
non-page-1-only AND happens to sit next to digits or a column gap on the
SAME line, or IS the header/opening-balance line's own text, which the
vocabulary gate catches separately), and then still get past a person
actually reading `reviewables`. That is the honest claim this format makes:
distillation minimizes what a human has to check, not what a human has to
trust blindly.

### The downloadable module

`renderPackModule(pack)` renders exactly what a contributor would hand to the
commons: an SPDX `CC0-1.0`-headed, byte-shaped-like-the-bundled-packs `.ts`
file — `import type { StatementPack } from '../spec';` followed by one
`export const <camelCasedId>: StatementPack = {...}`. The id's country
segment is kept as-is; every remaining `.`/`-`-separated segment is
capitalized and concatenated (`in.my-bank.savings` → `inMyBankSavings`).

## Licensing

The pack **data** in `shared/packs/packs/` is dedicated to the public domain
under [CC0 1.0](../shared/packs/packs/LICENSE) — copy it into any project,
open or commercial, no attribution required, no strings. Bank statement
layouts are facts; facts belong to everyone, and the commons only works if
every finance app can adopt a pack without a lawyer in the room.

Everything else — the engine, the app, the tests — remains
[AGPL-3.0](../LICENSE). Embedding `engine.ts` in your project carries AGPL
obligations; re-implementing the (deliberately small, fully documented)
engine semantics above against the CC0 pack data does not. Contributions to
the packs directory are accepted only under the same CC0 dedication.
