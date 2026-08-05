# SCHEMA

Derived from CLAUDE.md's architecture invariants, the BH-TESTS acceptance table,
and fixtures/golden.json. Database: `FINANCE_DB` (D1, name `groundwork`),
migrations in `migrations/finance/`, separate from the CRM's `DB` binding.

## Hard rules that shape every table
- Every monetary column is `INTEGER` cents. Every rate column is `INTEGER`
  ten-thousandths (e.g. 42.1002 -> 421002). No `REAL`/`FLOAT`/`DOUBLE` for money, ever.
- Every table carries `tenant_id TEXT NOT NULL` (multi-tenant CRM; omitting it fails
  the W1-schema gate per tasks.json `forbidden`).
- `*_rate_profile` tables are immutable + effective-dated: recalibration `INSERT`s a
  new row and sets `effective_to` on the prior row. Never `UPDATE` a rate row
  (enforced by W1-repos forbidden list and the pre-push hook's scope checks).

## Core tables (12, per W1-schema)

1. **tenant_finance_policy** — one row per tenant. `equipment_engine_active BOOLEAN`,
   `materiality_threshold_cents INTEGER`, `restated_target_cents INTEGER`,
   `black_friday_date TEXT`. Governs the BH-13 double-count switch: when
   `equipment_engine_active = true`, `labor_rate_profile.support_equipment_annual`
   MUST be 0 (CLAUDE.md, "THE EQUIPMENT DOUBLE-COUNT").

2. **labor_rate_profile** — immutable, effective-dated. Columns per BH fixture inputs:
   `wage_cents`, `paid_hours`, `pto_hours`, `shop_hours`, `idle_hours`, `tax_rate`,
   `comp_rate`, `benefits_monthly_cents`, `support_truck_annual_cents`,
   `support_tools_annual_cents`, `support_equipment_annual_cents`, `scope` (employee |
   crew | role | tenant — the BH-06 resolution cascade), `effective_from`,
   `effective_to`, `require_rate_approval BOOLEAN` (BH-10).

3. **equipment_rate_profile** — immutable, effective-dated. Inputs match the
   `equipment_rate` fixture: `purchase_price_cents`, `salvage_cents`, `life_years`,
   `annual_machine_hours`, `finance_rate`, `insurance_annual_cents`,
   `storage_annual_cents`, `fuel_gal_per_hr`, `fuel_price_cents`,
   `repairs_annual_cents`, `wear_annual_cents`, `lube_pct_of_fuel`. Ownership and
   operating components stored/returned separately (E2-equipment forbidden: "merging
   ownership and operating into one rate").

4. **overhead_pool** — division-scoped. `division`, `pool_type`, `annual_cost_cents`,
   `driver` (the allocation basis).

5. **overhead_allocation** — division x driver -> `overhead_rate` (ten-thousandths),
   matching the `overhead_allocation` fixture shape (`sellable_hours`,
   `allocated_overhead_cents`, `weighted_labor_rate_cents`, `overhead_rate`).
   Forbidden: "revenue driving more than 10% of total pool", "leaving any pool
   unallocated" (E2-allocation).

6. **time_entry** — the event spine input. `employee_id`, `crew_id`, `job_id`,
   `work_date`, `hours`, `ot_hours`, `resolved_rate` (ten-thousandths, INTEGER),
   `applied_overhead_cents`. Both `resolved_rate` and `applied_overhead_cents` are
   written ONCE at posting time and never recomputed on read (CLAUDE.md
   "ARCHITECTURE INVARIANTS"; W3-posting forbidden: "recomputing resolved_rate on read").

7. **work_item** — completed/billable units of work, used by the unbilled-work
   detector (E2-unbilled) to find completed items with no receivable.

8. **job_cost_ledger** — two-line cost posting per time_entry (labor line + overhead
   line), immutable once posted.

9. **recovery_snapshot** — nightly rollup output. `as_of`, `restated_target_cents`,
   `recovered_to_date_cents`, `pct_recovered`, `projected_black_friday`,
   `confidence_days` — field names taken directly from the `recovery` fixture.
   Written only by the cron rollup (W3-rollup), incrementing ONLY from `time_entry`
   hours, never from invoice/deposit/payment events (CLAUDE.md hard rule 3).

10. **action_item** — AI findings and human tasks. `verb` constrained to
    `{collect,bill,pay,fix,decide}`, `owner_id NOT NULL`, `sla_due NOT NULL`,
    `amount_cents`, `confidence`, `stale_components` (JSON array) — confidence and
    staleness must travel with the row and render in the UI (CLAUDE.md hard rule 4).

11. **classification_finding** — classifier stage 1-4 output feeding `action_item`,
    with `stage_reached`, `confidence`, `materiality_cents`.

12. **receipt** — R2 object key + hash (dedupe), field-level confidence per extracted
    field, `tenant_id`, `job_id`.

## Rate resolution — single source of truth
No module computes its own labor or overhead arithmetic. All cost rates come from
`/internal/rates/resolve` and `/internal/rates/equipment` (see API.md), which read
`labor_rate_profile` / `equipment_rate_profile` with the effective-dated cascade.

## Derivation confidence
**Confident (traced to fixtures/golden.json or CLAUDE.md):** the money-as-cents rule,
the rate-as-ten-thousandths rule, immutability of rate profiles, `tenant_finance_policy`
enforcing `support_equipment_annual = 0` when the equipment engine is active, the
`overhead_allocation` and `recovery_snapshot` field shapes (lifted directly from the
fixture keys), the 5-verb constraint on `action_item`.

**Inferred, needs Tyler to confirm:** exact table/column names beyond what fixtures or
CLAUDE.md name explicitly (e.g. `job_cost_ledger`, `work_item`, `classification_finding`
are my naming, not given anywhere) — table names are cheap to rename in wave 1, so
proceeding rather than blocking. Also inferred: which of `labor_rate_profile` vs
`equipment_rate_profile` owns `require_rate_approval` (BH-10) — assumed labor-side
since the BH acceptance table only exercises labor.

**Needs Tyler:** none of the 12 tables were literally named in evidence, only implied
by the 7 architecture layers and the fixture keys — worth a quick read-through before
W1-schema starts, not a blocker.
