# POSTING

W3-posting: "Two-line cost posting; `resolved_rate` written once, never recomputed."
Depends on W3-rateapi.

## The two lines
Every `time_entry` posts as exactly two `job_cost_ledger` lines: a **labor line**
(hours x `resolved_rate` from `/internal/rates/resolve`) and an **overhead line**
(hours x the division's `overhead_rate` from ALLOCATION.md). This is the "two-line"
in the task title — cost is never posted as a single blended figure, so job costing
(UI-JOBCOST.md) can show labor and overhead separately.

## Immutability (gate_must_include: "immutability")
`time_entry.resolved_rate` and `time_entry.applied_overhead` are written exactly once,
at posting time, by calling `/internal/rates/resolve`. Forbidden: "recomputing
resolved_rate on read" — any later read of a posted entry uses the stored value, even
if the underlying rate profile is later recalibrated (recalibration inserts a new
`labor_rate_profile` row with a new `effective_from`; it does not touch already-posted
entries). Forbidden: "retroactive recost without an explicit job" — bulk recost is not
a side effect of any other operation, it would need its own explicit, auditable action
if ever built (not in scope for waves 1-6).

## Ordering
Posting happens after `/internal/rates/resolve` returns for a given `time_entry` and
`work_date` — the resolve call happens first (respecting the BH-07 effective-date
cascade), then the two ledger lines are written atomically with the resolved values
baked in.

## Derivation confidence
**Confident:** the two-line structure and immutability rule are both explicit in the
task title and CLAUDE.md's architecture invariants ("time_entry.resolved_rate and
.applied_overhead are written ONCE at posting and never recomputed").

**Inferred:** the exact atomicity mechanism (single D1 transaction vs two sequential
writes) and whether `job_cost_ledger` stores the rate resolution's `confidence`
alongside each line — CLAUDE.md hard rule 4 says confidence must travel with every
number, so I'd carry it here too, but this wasn't stated for posting specifically.
**Needs Tyler:** none blocking — the core two-line/immutable design has enough
evidence to build against.
