# INGEST

W5-ingest: "P&L ingest + AI normalization + reclassification proposals + gap
report." Depends on W1-repos.

## Pipeline
1. **Ingest** — a P&L (profit & loss statement) is imported, presumably from the
   existing QuickBooks-adjacent bookkeeping flow implied by CLAUDE.md hard rule 1
   ("No write path to QuickBooks. Groundwork proposes; QBO records.") — this task is
   the read-side counterpart: Groundwork reads/ingests P&L data but never writes back.
2. **AI normalization** — line items normalized against the tenant's chart of
   accounts / overhead pool structure (ALLOCATION.md), so ingested P&L lines can be
   compared against `overhead_pool` entries.
3. **Reclassification proposals** — when an ingested line looks miscategorized
   relative to the tenant's established pattern (via classifier stages, CLASSIFIER.md),
   propose a reclassification. Forbidden: "auto-approving any reclassification" — every
   proposal becomes an `action_item` (`verb=decide`) for human review, same
   materiality-override discipline as CLASSIFIER.md.
4. **Gap report** — surfaces P&L lines with no matching overhead pool or division,
   or divisions with no matching P&L coverage (the ALLOCATION.md forbidden rule
   "leaving any pool unallocated" viewed from the ingest side).

## Hard boundary
Forbidden: "posting to the GL" — this task never writes to a general ledger, existing
QBO, or otherwise. It reads, normalizes, proposes, and reports. CLAUDE.md hard rule 1
("Groundwork proposes; QBO records") is the through-line for this entire task.

## Derivation confidence
**Confident:** the propose-not-post boundary and no-auto-approval rule are both
explicit forbidden clauses; the QBO relationship is explicit in CLAUDE.md.

**Inferred:** P&L ingest format/source (file upload? API? which accounting system) —
not specified anywhere in evidence beyond "QBO records," so I inferred a QuickBooks-
adjacent source. **Needs Tyler:** the actual ingest mechanism (file format, whether
this connects to a QBO export/API) is a real gap before W5-ingest can be built,
not a stylistic guess.

## Implementation notes (as built)

File upload, resolved: a tenant uploads a QuickBooks export directly (Upload
Documents / Financial Setup pages), not an API/OAuth connection. Two file
formats are supported today, both config-driven
(`config/finance/ingest.sources.json` — adding a new export format is a
config edit, not a code change):

- **CSV** — tall format, one row per (account, division) or per account,
  detected by matching the file's header row against each configured
  source's `detect.required_headers` (`src/ai/ingest.ts`'s `detectSource`).
  Handles: plain P&L, class/division P&L, balance sheet, generic bank/card
  CSV, generic payroll export.
- **XLSX** — QuickBooks' "Profit and Loss by Class" export in its native
  wide format: one column per division plus a `Total` column, with
  nested/subtotal rows (`src/ai/xlsx.ts`). This has no plain-text header row
  to match against, so it's detected by grid *shape* instead
  (`detectXlsxSource` locates the division-name header row itself, skipping
  title rows above it) — same config-driven-when-possible spirit as CSV,
  even though the shape detector itself has to be code, not JSON, for a
  binary format. Read with a small hand-rolled OOXML unzip+XML reader
  (`fflate` for the zip container) rather than a general-purpose xlsx
  library, to keep the Cloudflare Workers bundle small.

**Division mapping**: both formats resolve each row's raw division name
against `config/finance/division-map.json` (`resolveDivision` —
case-insensitive canonical match, then alias match). A real QuickBooks
Class P&L export's division names are tenant-specific business labels
(e.g. Avalon Landscape Construction's actual divisions are "G&A",
"Landscaping", "Maintenance", "Snow Removal") and will not all match the
platform's placeholder default division list out of the box — "Maintenance"
happens to match canonically and "Snow Removal" is a configured alias, but
"Landscaping" and "G&A" do not match anything and are flagged
`needs_review`, never guessed. A tenant can either accept that first-upload
review cost, or an admin can add tenant-specific aliases via the
`finance_config_override` mechanism (`src/config/finance-config-runtime.ts`)
— not yet exercised for this, still an open decision.

**Test fixtures**: `fixtures/ingest/qbo-class-pnl-wide-avalon.xlsx` is a
real (not synthetic) "Profit and Loss by Class" export for Avalon Landscape
Construction LLC, used across `src/ai/xlsx.test.ts`,
`src/ai/ingest.test.ts`, and the `document-upload.e2e.ts` /
`onboarding.e2e.ts` Playwright suites — chosen deliberately over a
hand-built sample so the parser is proven against QuickBooks' actual
nested-subtotal, blank-vs-zero, and multi-division-column output, not an
idealized version of it.
