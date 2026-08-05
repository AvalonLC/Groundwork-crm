# UI-RECOVERY

W4-recovery-ui: "Overhead Recovery page — thermometer, division dates, absorption."
Depends on W3-rollup. Files: `src/ui/recovery.tsx`, `src/ui/recovery.e2e.ts`.

## Thermometer
A progress-bar/thermometer visualization of `recovery_snapshot.pct_recovered`
against `restated_target_cents` — fixture: 0.646193 (64.6%) of $591,000 recovered
($381,900 to date). This is the visual anchor of the page, read from
`recovery_snapshot` (SCHEMA.md / RECOVERY.md), never recomputed client-side —
consistent with the nightly-rollup-writes-once pattern.

## Division dates
Per-division projected recovery completion dates, presumably each division's own
version of the tenant-level `projected_black_friday` figure — ALLOCATION.md's four
divisions (maintenance, hardscape, snow, drainage) each absorb overhead at a
different rate, so each would reach full recovery on a different date. Not
explicitly specified as a per-division field in fixtures/golden.json (the `recovery`
fixture is tenant-level only) — this page likely needs a per-division breakdown that
E2-recovery/W3-rollup don't yet compute at the division level.

## Absorption
"Absorbed cost" per ALLOCATION.md's division rows (`absorbed_cost` = weighted labor
rate + overhead rate per hour) — this page likely shows how absorption is trending
toward each division's `required_bill_rate`.

## Derivation confidence
**Confident:** the thermometer's data source (`recovery_snapshot`) and the general
concept of absorption (from ALLOCATION.md) are both grounded in fixture data.

**Needs Tyler — a real gap:** "division dates" implies per-division recovery
projection, but E2-recovery's fixture and RECOVERY.md's engine spec are tenant-level
only. Either the recovery engine needs a per-division mode not yet specified, or
"division dates" means something else entirely. Flagging rather than guessing at a
UI layout for data that may not exist yet.
