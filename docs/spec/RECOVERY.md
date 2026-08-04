# RECOVERY

Covers two tasks: the recovery projection engine (E2-recovery) and the nightly cron
rollup (W3-rollup). Field names and figures below are taken directly from the
`recovery` fixture.

## Recovery projection (E2-recovery)
Fixture: as_of 2026-08-03, restated_target $591,000, recovered_to_date $381,900,
hours_per_week 380, blended_overhead_rate $27.43/hr, weekly_recovery $10,423.40,
pct_recovered 0.646193, projected_black_friday 2026-12-21, confidence_days 13.

- **Restated target, not straight-line.** Forbidden (E2-recovery): "straight-line
  target instead of restated actuals" — the target is periodically restated against
  actual overhead spend, not a flat annual-budget/12 line.
- **weekly_recovery = hours_per_week x blended_overhead_rate**: 380 x 27.43 =
  10,423.40 — matches the fixture exactly.
- **pct_recovered = recovered_to_date / restated_target**: 381900 / 591000 =
  0.646192... — matches the fixture (0.646193) within tolerance.
- **Black Friday date + confidence range.** Forbidden: "returning a single date
  without a confidence range" — `projected_black_friday` must ship alongside
  `confidence_days` (a +/- window, not a point estimate), and per BH-12's seasonal
  pattern, utilization/recovery pacing should be read off trailing 12 months, not a
  single quarter, for seasonal tenants.
- Recovery recognition source: ONLY `time_entry` hours increment recovery. Never an
  invoice, deposit, or payment event (CLAUDE.md hard rule 3) — this is what makes
  recovery a cost-absorption metric, not a cash metric.

## Nightly rollup (W3-rollup)
Writes `recovery_snapshot` (SCHEMA.md) from `time_entry` + `job_cost_ledger`, using
`db.batch()` — forbidden: "row-by-row writes." Depends on E2-recovery and W3-posting.

### Open infrastructure question — needs Tyler before W3-rollup starts
This app deploys as **Cloudflare Pages** (`wrangler.jsonc`, `pages_build_output_dir`),
and Pages has no native Cron Trigger support — Cron Triggers are a Workers-only
feature. `wrangler.jsonc`'s "cron trigger" preflight check was downgraded to a SKIP
for exactly this reason (see scripts/preflight.sh). Two honest options for W3-rollup,
neither implemented yet:
1. A small companion Worker (separate wrangler config) with its own Cron Trigger,
   calling an authenticated internal endpoint on the Pages app to run the rollup.
2. An external scheduled caller (e.g. a third-party cron service, or GitHub Actions
   on a schedule) hitting an authenticated internal endpoint.
Both are standard patterns; neither was chosen for you. **This needs a decision
before W3-rollup can be built for real** — flagging rather than guessing.

## Derivation confidence
**Confident:** every fixture figure, the weekly_recovery and pct_recovered formulas
(both independently verified against the fixture), the time_entry-only recognition
rule (explicit in CLAUDE.md), the "no straight-line" and "no single date" forbidden
clauses (explicit in tasks.json).

**Needs Tyler:** the cron mechanism (companion Worker vs external scheduler) — a real
architectural gap, not a stylistic guess, and it blocks W3-rollup's actual deployment
even though the engine logic itself (E2-recovery) doesn't depend on it.
