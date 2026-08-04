# API

W3-rateapi: "`/internal/rates/resolve` + `/internal/rates/equipment`, cascade +
confidence." Per CLAUDE.md's architecture invariant: "ALL cost rates come from
`/internal/rates/resolve` and `/internal/rates/equipment`. No module computes its own
labor or overhead arithmetic. Ever." These two endpoints are the only legitimate
entry point into the burden and equipment engines for every other layer (posting,
job costing, UI).

## POST /internal/rates/resolve
Input: `{ employee_id, work_date, tenant_id }`. Resolves `labor_rate_profile` via the
BH-06 cascade — employee -> crew -> role -> tenant, each hop downgrading confidence.
BH-07: an entry dated before a rate change resolves to the OLDER profile in effect on
`work_date`, not the current one (the whole point of effective-dated rows). Forbidden
(W3-rateapi): "caching a rate across work dates" — every call re-resolves against
`work_date`, no memoization that could serve a stale profile across an effective-date
boundary.

Output includes `resolved_rate` (ten-thousandths), `confidence` (high at
employee-scope, degrading down the cascade), `stale_components` (which support pools
are outdated), and reflects `tenant_finance_policy.equipment_engine_active` when
deciding whether `support_equipment_annual` is zeroed (BH-13). Forbidden: "returning
a number without confidence" — every response carries it, never a bare rate.

## POST /internal/rates/equipment
Input: `{ equipment_id, tenant_id }` (or machine-hours context for tier-2 capture,
see EQUIPMENT.md). Resolves `equipment_rate_profile`, returns `ownership_rate` and
`operating_rate` as two separate numbers (never merged — same rule as E2-equipment),
plus `total_rate` for display.

## Confidence semantics (shared)
`confidence` is not a single global scale — BH-04's `suspect`/`requires_review` flags
(low-utilization) and BH-05's `config_warning` (multiplier ceiling) are engine-level
signals that both endpoints must surface, not swallow. A caller reading `resolved_rate`
without checking these flags would silently trust a suspect number.

## Derivation confidence
**Confident:** the two endpoint names and their role as the sole rate-computation
entry point (verbatim from CLAUDE.md), the cascade order and stale-rate resolution
(BH-06/BH-07 in BH-TESTS.md), the "never cache across work dates" and "always include
confidence" forbidden clauses (verbatim from tasks.json).

**Inferred:** exact request/response JSON shapes — field names beyond `resolved_rate`,
`confidence`, `stale_components` are my construction, matching the SCHEMA.md columns
but not independently specified anywhere. **Needs Tyler:** whether these are HTTP
routes on the same Pages Worker or genuinely `/internal/*`-namespaced with additional
auth (service-binding vs public-but-unlisted) — CLAUDE.md doesn't say.
