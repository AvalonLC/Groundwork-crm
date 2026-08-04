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
