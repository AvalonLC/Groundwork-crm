# ALLOCATION

E2-allocation: "Overhead pools + multi-driver allocation + division rates." Field
names and figures below are taken directly from the `overhead_allocation` fixture.

## Shape
Fixture: total_overhead $578,400 across total_sellable_hours 21,086, blended
overhead_rate $27.4305/hr. Split across four divisions (maintenance, hardscape, snow,
drainage), each with: `sellable_hours`, `allocated_overhead`, `weighted_labor_rate`,
`overhead_rate`, `absorbed_cost` (labor + overhead per hour), `target_margin`,
`required_bill_rate`.

Example row (maintenance): sellable_hours 8110, allocated_overhead $196,400,
weighted_labor_rate $38.40/hr, overhead_rate $24.217/hr, absorbed_cost $62.62/hr,
target_margin 0.40, required_bill_rate $104.37/hr. The engine must reproduce all
four division rows within the fixture's rate tolerance ($0.01, per
`fixtures/golden.json.tolerance`).

## Multi-driver allocation
"Multi-driver" per the task title implies pools may allocate on more than one basis
(e.g. sellable hours for labor-driven pools, revenue for sales-driven pools) —
`overhead_pool.driver` (SCHEMA.md) carries this per-pool. Hard constraint from
tasks.json forbidden list: **revenue may never drive more than 10% of the total
pool** — most overhead allocation must be hours-driven, not revenue-driven, to avoid
circularity with billing decisions. Also forbidden: leaving any pool unallocated —
every `overhead_pool` row must resolve to a division's `allocated_overhead`.

## required_bill_rate derivation
`required_bill_rate = absorbed_cost / (1 - target_margin)`. Check against maintenance
row: 62.62 / (1 - 0.40) = 104.37 — matches the fixture exactly (within tolerance).

## Derivation confidence
**Confident:** every field name and number in this file is copied from the
`overhead_allocation` fixture; the required_bill_rate formula was verified against
all four division rows (each reproduces its `required_bill_rate` within $0.01) —
math derived, not invented, but worth a spot check during E2-allocation review since
it wasn't stated as a formula anywhere, only demonstrated by the numbers.

**Inferred:** the multi-driver mechanism and the "revenue <=10%" rule's exact
enforcement point (compile-time config validation vs runtime check) — the rule itself
is explicit in tasks.json, the enforcement mechanism is my inference. **Needs Tyler:**
whether divisions are fixed to these four or tenant-configurable.
