# Scheduling engine — handoff after step 4

> **Status note (2026-08-12).** The `scheduling.bundle` referenced by the
> original handoff never reached this machine — the four commits it described
> were unrecoverable. **Steps 1–4 were rebuilt from scratch** against this
> document, on branch `claude/scheduling-capacity`. If that bundle ever turns
> up, do not merge it: diff it against these four commits, note anything it does
> that this rebuild missed, then delete it. Two things the original flagged as
> unverified are now confirmed against the source — see *Resolved* below.

Steps 1–4 are the entire data foundation. **No UI at all.**

| Commit | What |
|---|---|
| `9bbd738` | `0060` productive-hours setting + `src/scheduling/capacity.ts` (pure) |
| `6eeee9f` | `0061` backfill every scheduled work order into `wo_days` |
| `8e20909` | `0062` `wo_day_employees` — per person, per day, planned minutes |
| `a56e1df` | `0063` snapshot budgeted hours from the estimate |

Verified on this machine: `npm test` 356 passing across 28 files (29 of them new
in `capacity.test.ts`), `npm run typecheck` clean, `npm run test:migrations`
**green**, `npm run build` succeeds, all 68 migrations apply to a clean database.

### This fixes a pre-existing bug on main

The marketing renumber overshot: main went `0059_service_packages` →
`0064_marketing_core`, leaving **0060–0063 empty**, so `npm run test:migrations`
was failing on main. These four fill the hole exactly. Numbering is now gapless
`0001..0068`.

Worth knowing: CI's `gate` job runs `typecheck`, `npm test` and `e2e` but **not**
`test:migrations`, which is why that gap sat red on main without any PR catching
it.

---

## Resolved — two unknowns the original handoff left open

**1. `time_entries.duration_min` is GROSS. Breaks are not subtracted.**
Confirmed against the source, not inferred:

- both clock-out handlers store raw wall-clock elapsed
  (`now - clock_in`, `src/index.tsx`)
- ending a break only *accumulates* into `time_entries.break_minutes`; it never
  touches `duration_min`
- the timesheet roll-up reports `total_minutes` and `total_break_minutes` as
  **separate columns**
- nothing anywhere in `src/` or `public/js/` subtracts one from the other

So summing `duration_min` alone overstates actual hours by exactly the break
time. Use `netActualMinutes()` / `sumNetActualMinutes()` from
`src/scheduling/capacity.ts`, which do the subtraction.

**2. The `0.0h · 0%` crew metric — cause confirmed, and it is two separate
things.** The rendering code did *not* move in #27/#28; it is still in
`_sbRender` in `public/js/app_premium.js`.

- **The denominator is hardcoded.** The crew-lane metric is literally
  `const weeklyCapacity = 40;`. It was never derived from crew size, so the
  percentage is meaningless for any crew that is not one person on a 40-hour
  week. That is what `0060` + `capacity.ts` exist to replace.
- **`0.0h` means zero matching jobs, not a broken duration calculation.**
  `_sbEventRange()` can never return 0 — it floors at 30 minutes and falls back
  to a 60-minute default. So the numerator is 0 only when no work order in the
  visible week has `md_crew_id`/`crew_id` equal to that crew. Unassigned jobs
  land in a separate `__unassigned__` lane, so a *named* crew at 0.0h means
  nothing is assigned to it that week, or crew ids do not line up between
  `/api/crews` and the work orders.

Checked and cleared: the crew sum has no date filter of its own, but the fetch
is date-scoped (`date_from`/`date_to`), and lanes only render in week mode, so
the numerator is correctly week-scoped.

---

## Findings that shaped the design

- **`estimates.cost_data.rollup.budgeted_hours` already exists** — the Job Cost
  Engine's own figure (migration `0034`). This also answers the question parked
  in `docs/spec/UI-JOBCOST.md` ("confirm which existing CRM table holds job
  estimates"): it is `estimates.cost_data`.
- **That figure is already being written into `work_orders.duration_hours`** at
  from-estimate conversion (`budgetHours || Number(b.duration_hours || 0)`), and
  `duration_hours` is *also* what the grid reads for calendar blocking. One
  column, two meanings — this is the conflation `0063` separates.
- **`workday_settings` already existed** (`0014`) with working days and shift
  times. `0060` only adds the productive-vs-shift distinction.
- **`wo_days` already had per-day clock times** (`0045`/`0046`/`0047`), but no
  `is_primary`; `0061` adds it.
- **`crew_members` already exists**, so the capacity denominator was always
  computable.

---

## What is next: step 5, the API

New router `src/scheduling/api.ts`, mounted at `/api/scheduling` with
`requireAuth` at the mount point in `src/index.tsx` — the same pattern as
`/api/marketing`.

| Endpoint | Purpose |
|---|---|
| `GET /week?start=&crew_id=` | one payload: days, crews, assignments, capacity, working hours |
| `GET /backlog` | Needs Scheduling / Needs Crew / Tentative, with filters |
| `POST /days/:id/schedule` | set date, start, duration (drag, resize, drop) |
| `POST /days/:id/assign` | add/remove a rep, set planned minutes |
| `DELETE /days/:id/schedule` | return to backlog |
| `GET /work-orders/:id/hours` | budget / scheduled / actual for one job |

Notes for whoever builds it:

- **`GET /week` must return one shape** so the grid never issues N queries per
  crew. Every write should return recomputed capacity for affected days, so the
  sidebar cannot drift from the grid.
- **Crew roles must not see money.** The backlog card shows job value; strip it
  **server-side** for field roles (`foreman`, `laborer`, `mechanic`), not with
  CSS. CLAUDE.md: crew never sees margin, wage or rate.
- **Nothing may write `work_orders.budget_minutes`.** Scheduling changes
  `wo_day_employees.planned_minutes` only.
- **Actual hours are read-only** from `time_entries`, and must be summed net of
  breaks — see *Resolved* above.
- **Nothing creates `wo_days` rows for new work orders yet.** The backfill
  handled history only. `POST /days/:id/schedule` (or work-order creation) needs
  to create the day row, otherwise jobs created after the migration never appear
  on the grid.

Then steps 6–11: week grid, drag/drop, capacity header, variance card, actual
hours, nav wiring.

---

## Verification

```bash
npm run db:migrate:local
npm test
npm run typecheck
npm run test:migrations
npm run build
npm run dev:local
```

`npm test` runs fine here **without** `CLOUDFLARE_API_TOKEN` — the AI and
Vectorize bindings emit warnings, not failures. The original handoff's claim
that the suite cannot run without that token was specific to the authoring
sandbox and does not hold on this machine. Any failure in the scheduling suites
is therefore attributable to the branch.

Known trap (`docs/PUNCHLIST.md`): `dev:local` passes `--d1=DB`, which binds an
empty `local-DB` rather than `avalon-sales-hub-production`. Blank pages are that,
not the new code.

---

## Migration safety — read before merging

**Merging the PR *is* the production migration.** `.github/workflows/deploy.yml`
fires on every push to `main` and runs, in order:

1. `npm run build`
2. `wrangler d1 migrations apply avalon-sales-hub-production --remote`
3. `wrangler pages deploy dist`

There is no separate manual apply step and no confirmation prompt in front of
the database. `npm run db:migrate:prod` is not how migrations reach production —
CI is. (Claude sessions must still never run `deploy`, `db:migrate:prod` or any
`wrangler --remote` themselves; the point here is that a *merge* does it.)

So the dry-run count below must be taken **before the PR is merged**, not before
some later manual step:

```sql
SELECT COUNT(*) FROM work_orders wo
 WHERE COALESCE(wo.scheduled_date,'') <> ''
   AND NOT EXISTS (SELECT 1 FROM wo_days d WHERE d.work_order_id = wo.id);
```

That is exactly how many rows `0061` will insert.

`0061` is the only one that touches live data. It is additive only — it inserts
`wo_days` rows and alters no existing column — and reversible in one statement:

```sql
DELETE FROM wo_days WHERE is_primary = 1;
```

`0062` cascades from `wo_days` (`ON DELETE CASCADE`), so that rollback leaves no
orphans; verified against the local database.

`0063` carries one trap worth knowing: `json_extract` **raises** on malformed
input rather than returning NULL, and `cost_data` is free-form TEXT. An
unguarded backfill would abort on a single bad row and fail the deploy
part-way. It is guarded with `json_valid()`, and verified against a deliberately
malformed row.
