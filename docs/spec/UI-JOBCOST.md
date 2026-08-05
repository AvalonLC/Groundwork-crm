# UI-JOBCOST

W4-jobcost-ui: "Job Costing — live margin, hours vs estimate, applied overhead."
Depends on W3-posting. Files: `src/ui/job-costing.tsx`, `src/ui/job-costing.e2e.ts`.

## Live margin
Reads `job_cost_ledger`'s two posted lines per `time_entry` (POSTING.md: labor line +
overhead line) and the job's billed/quoted amount to show real-time margin as work is
logged — "live" meaning it updates as new `time_entry` rows post, not a batch/nightly
figure like `recovery_snapshot`. Per ROLES.md, margin is exactly the field crew must
never see on this page — the gate `crew-cannot-see-margin` (ROLES.md/W4-roles)
almost certainly gets exercised against this screen specifically, since job costing
is the most natural place a crew member would otherwise see margin.

## Hours vs estimate
Compares actual posted hours (`time_entry.hours` summed per job) against the job's
originally estimated hours — a variance view, presumably highlighting jobs running
over.

## Applied overhead
`time_entry.applied_overhead` (SCHEMA.md/POSTING.md) shown per job, sourced from the
division's `overhead_rate` (ALLOCATION.md) at time of posting — immutable once
posted, so this page always shows what was actually applied, not a recalculated
current rate.

## Derivation confidence
**Confident:** all three data sources (job_cost_ledger, time_entry.hours,
time_entry.applied_overhead) are grounded in SCHEMA.md/POSTING.md, which are
themselves grounded in CLAUDE.md's architecture invariants.

**Inferred:** where the job's "estimate" (hours and billed amount) comes from — this
Finance OS build doesn't define a jobs/estimates table; it's presumably read from the
existing CRM's `DB` binding, similar to UNBILLED.md's cross-database read. **Needs
Tyler:** confirm which existing CRM table holds job estimates before W4-jobcost-ui
can wire up the "hours vs estimate" comparison for real.
