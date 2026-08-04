# EQUIPMENT

Two consumers: the equipment rate engine (E2-equipment) and equipment capture
(W5-equipcapture). Field names below are taken directly from the `equipment_rate`
fixture in fixtures/golden.json.

## Ownership / operating split (E2-equipment)
`computeEquipmentRate(input)` is a pure function, no DB call, mirroring
`computeBurden`. Inputs: `purchase_price`, `salvage`, `life_years`,
`annual_machine_hours`, `finance_rate`, `insurance_annual`, `storage_annual`,
`fuel_gal_per_hr`, `fuel_price`, `repairs_annual`, `wear_annual`,
`lube_pct_of_fuel`. Outputs, kept as two separate numbers per the forbidden rule
("merging ownership and operating into one rate"):
- `ownership_rate` — depreciation + finance cost of capital, amortized over
  `annual_machine_hours`. Fixture: purchase_price 62000, salvage 14000, life_years 7,
  annual_machine_hours 720, finance_rate 0.075 -> ownership_annual $11,487.14,
  ownership_rate $15.9544/hr.
- `operating_rate` — fuel + lube + repairs + wear + insurance + storage per machine
  hour. Fixture -> operating_rate $22.2753/hr.
- `total_rate` = ownership_rate + operating_rate = $38.2297/hr (fixture), exposed
  for display but callers needing the breakdown use the two components directly.

## The double-count guard (shared with SCHEMA.md / CLAUDE.md)
When `tenant_finance_policy.equipment_engine_active = true`, the labor engine's
`support_equipment_annual` MUST be 0 — equipment cost then flows exclusively through
this engine, never through burden. This is BH-13: burdened_rate goes from $42.10 to
$40.62, a delta of `2400 / 1622` billable hours ($1.4797/hr), not `2400 / paid_hours`
($2.61/hr — the historical bug). `/internal/rates/equipment` (API.md) is the only
legitimate source for equipment cost once the engine is active.

## Capture pipeline (W5-equipcapture)
Two tiers, per tasks.json title "Tier-1 crew-attached machine capture + tier-2 meter
photo":
- **Tier 1** — crew/job association only (which machine was on which job, no meter
  reading). Cheap, high-confidence, deterministic — a crew selects equipment from a
  tenant equipment list per time_entry or job.
- **Tier 2** — meter-photo capture (hour-meter or odometer photo), OCR'd for actual
  machine hours, field-level confidence per RECEIPTS.md's pattern. Used to true-up
  `annual_machine_hours` utilization against the rate profile's assumption, flagged
  as a `classification_finding` when materially divergent (see CLASSIFIER.md).

## Derivation confidence
**Confident:** all six equipment fixture inputs and four expected outputs, the
double-count relationship to burden (directly stated in CLAUDE.md and asserted by
BH-13), the ownership/operating separation requirement (explicit E2-equipment
forbidden clause).

**Inferred:** the two-tier capture design (crew-attach vs meter-photo) is named only
in the W5-equipcapture task title — I inferred the mechanics (crew selection list,
OCR meter reading) from RECEIPTS.md's confidence pattern and CLASSIFIER.md's staged
approach. Needs Tyler to confirm the actual UI/capture flow before W5-equipcapture starts.
