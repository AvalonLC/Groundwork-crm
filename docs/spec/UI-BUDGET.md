# UI-BUDGET

W4-budget-ui: "Budget & Rates page — 6-step build, driver map, both rate types."
Depends on E2-allocation. Files: `src/ui/budget.tsx`, `src/ui/budget.e2e.ts`.

## Both rate types
"Both rate types" = labor (burden engine, BH-TESTS.md) and equipment (EQUIPMENT.md).
This page is where `labor_rate_profile` and `equipment_rate_profile` rows get
created/recalibrated — the human-facing counterpart to the immutable, effective-dated
tables in SCHEMA.md. Per the derived-value rule (ROLES.md), computed fields
(`burdened_rate`, `total_rate`, `required_bill_rate`) are always shown as outputs,
never editable inputs; only the underlying cost inputs (wage, hours, purchase price,
etc. — the fixture `input` keys) are editable.

## Driver map
Visualizes `overhead_pool.driver` -> division allocation (ALLOCATION.md) — likely a
table or diagram showing which pools allocate on which basis, and the 10%-revenue-cap
rule as a visible constraint, not just a backend validation.

## 6-step build
A wizard-style flow implied by "6-step" in the task title — no evidence names the six
steps. Plausible ordering, following the dependency chain visible in tasks.json
(E2-burden -> E2-equipment/E2-allocation -> W3-rateapi): (1) labor rate inputs, (2)
equipment rate inputs, (3) overhead pools, (4) allocation drivers, (5) target margins
per division, (6) review computed rates before publishing (i.e. before the profile's
`effective_from` takes effect).

## Derivation confidence
**Confident:** both-rate-types (labor + equipment) and the driver map's data source
(ALLOCATION.md) are grounded in fixture/task evidence.

**Needs Tyler:** the six-step wizard's exact steps are invented from a step *count*
with no content given — a reasonable ordering, but a guess. Confirm before W4-budget-ui
locks in a wizard flow.
