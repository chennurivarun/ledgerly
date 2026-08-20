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
