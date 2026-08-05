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

### Scheduling — decided 2026-08-04: Option B, GitHub Actions
Pages has no native Cron Trigger (Workers-only feature; `scripts/preflight.sh`'s
"cron trigger" check is a SKIP for this reason). Tyler chose Option B: an
external scheduler, specifically a GitHub Actions scheduled workflow
(`.github/workflows/finance-cron.yml`), reusing this repo's existing CI/CD
setup rather than deploying a second Cloudflare Worker for a once-daily
HTTP call. Option A (a companion Worker, `workers/finance-cron/`) was
scaffolded but not chosen — kept as a documented, unused alternative.

What's built:
- `POST /internal/cron/rollup` (`src/api/cron-trigger.ts`), mounted at
  `/internal/cron` — secret-header authenticated (`X-Cron-Secret`), fails
  closed (503) if `CRON_SECRET` isn't configured. Gathers real inputs per
  tenant (`src/cron/gather-inputs.ts`) and calls `runNightlyRollup`.
- `.github/workflows/finance-cron.yml` — the active scheduler. 7am UTC
  daily by default (edit the cron expression to change), plus a manual
  `workflow_dispatch` trigger for testing.

**Only remaining input: set the `CRON_SECRET` value on both GitHub Actions
(as a repo secret) and Cloudflare Pages (via `wrangler pages secret put`)
— exact steps are in the workflow file's header comment and
`workers/finance-cron/README.md`.** Nothing else needs to be built.

## Derivation confidence
**Confident:** every fixture figure, the weekly_recovery and pct_recovered formulas
(both independently verified against the fixture), the time_entry-only recognition
rule (explicit in CLAUDE.md), the "no straight-line" and "no single date" forbidden
clauses (explicit in tasks.json), the cron-trigger endpoint's fail-closed auth.

**Inferred, not confirmed:** `gather-inputs.ts`'s derivation of
recovered_to_date/budgeted/absorbed from job_cost_ledger and overhead_allocation
are reasonable proxies I built, not formulas Tyler confirmed — worth review
before trusting the numbers for anything customer-facing (see
docs/PUNCHLIST.md).

**Needs Tyler:** set `CRON_SECRET` on both GitHub Actions and Cloudflare
Pages (same value, two places) — the only remaining input for scheduling.
