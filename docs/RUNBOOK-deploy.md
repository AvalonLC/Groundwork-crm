# Runbook — deploying to production

Merging and deploying are separate decisions **in this repository**. A merge to
`main` runs `ci.yml`, and `deploy.yml` is reached only by dispatching **Deploy
to production** by hand.

> **That is not yet the whole story.** A Cloudflare Pages **Git integration**,
> configured in the Cloudflare dashboard and invisible to this repository,
> also builds and deploys `main` on every push. Until it is disconnected (see
> One-time setup below), merging still ships to production and the approvals
> below govern only the migration step. This sentence used to read "Production
> is reached only by dispatching"; it was written on 2026-09-07 and was never
> true -- see Why.

## Why

`deploy.yml` used to trigger on `push: branches: [main]`. On 2026-09-07 three
engineering PRs were merged twenty seconds apart, producing three production
deployments and three `d1 migrations apply --remote` runs in under a minute.
Nothing was wrong with the changes; nobody chose to deploy three times. A
routine merge should not be able to ship.

Removing that trigger decoupled **this workflow** from merges. It did not
decouple *deployment* from merges, because `deploy.yml` was never the only way
in. On 2026-09-15 production was found serving a bundle byte-identical to
`main` (SHA-256 `3f1bde1a...`), while the last run that applied migrations was
`248f586` on 2026-09-09 -- two migrations earlier. Migration 0088 landed that
same day and was never applied, so when the void path shipped on 2026-09-11 it
went live writing `invoice_lifecycle_events` and `invoices.void_reason`, a
table and a column that do not exist in production. That ran for four days.
Every check made in that window read this workflow's run history, which
truthfully reported no deploy; the Pages Git integration had been shipping each
merge the whole time.

`scripts/check-production-drift.mjs` now reports both halves -- migrations on
`main` that the last migrating run did not carry, and a served bundle the
workflow never shipped -- and `ci.yml` runs it as a warning on every push to
`main`.

## One-time setup — REQUIRED, and not yet done

### 1. Disconnect the Cloudflare Pages Git integration

While it is connected, everything below is decorative for the *code* half of a
deploy: the push that merges a PR ships it before anyone dispatches anything.
Nothing in this repository can turn it off, and nothing in this repository can
see it -- it is configured in the Cloudflare dashboard.

**Cloudflare dashboard → Workers & Pages → `groundwork-crm` → Settings →
Builds & deployments → Git integration → Disconnect.**

Verify by pushing a docs-only commit to `main` and confirming no new deployment
appears under the project's Deployments tab. `node scripts/check-production-drift.mjs`
reports the same thing from here: once disconnected, a merge that is not
followed by a dispatch leaves production serving the older bundle.

### 2. Create the two protected environments

The two protected environments do not exist. A workflow that references a
missing environment causes GitHub to create it **with no protection rules**, so
until this is done the approvals are decorative and a dispatch runs straight
through to production. `preflight` now refuses to start unless both exist with
required reviewers, so this is a hard prerequisite, not advice.

**Settings → Environments → New environment**, twice:

1. Name it `production` → **Required reviewers** → add yourself → Save.
2. Name it `production-database` → **Required reviewers** → add yourself → Save.

Verify: `gh api repos/AvalonLC/Groundwork-crm/environments --jq '.environments[].name'`
should list both.

## Deploying

Actions → **Deploy to production** → Run workflow.

| input | notes |
|---|---|
| `ref` | Prefer a **commit SHA**. A branch name can move between approving the run and the run reaching the deploy job. |
| `confirm` | Must be exactly `DEPLOY`. |

Migrations always run. `d1 migrations apply` is a no-op that exits 0 when
nothing is pending, so there is no flag to get wrong.

The run then stops twice for approval:

1. **`production-database`** — before `d1 migrations apply --remote`.
2. **`production`** — before `pages deploy`.

Order is `verify → migrate → deploy`. Migrations go first because the Worker
that lands next expects the schema to be there; deploying first would serve new
code against an old database for the length of the migration run. If migrations
fail, the deploy job does not run.

Only one production deployment runs at a time (`concurrency: production-deploy`,
`cancel-in-progress: false` — queueing behind a migration is better than
cancelling one half-applied).

The run summary records the deployed commit, the requested ref, whether
migrations ran, the migration count and latest file, and who dispatched it.

## Smoke checks — safe, non-mutating

Do these after the deploy job goes green. **None of them move money.**

- [ ] `curl -s -o /dev/null -w '%{http_code}' https://groundwork-crm.com/` → `200`
      (the deploy job already asserts this, with retries)
- [ ] Sign in. The shell renders; no console errors on load.
- [ ] **Mobile / narrow viewport** → Financial → the tab strip has tabs in it,
      not an empty bar.
- [ ] Command Center → an overdue row → Invoices. Navigation survives.
- [ ] Desktop → Financial → the nine Finance OS tabs are intact.
- [ ] Invoice list → the Issued and Due columns show plausible dates, and an
      evening-UTC row shows the previous local day.
- [ ] Payments → "This Month" is a figure or an em dash, never `$0.00` beside a
      non-zero lifetime total.
- [ ] Invoice list → tick two rows → the bulk bar appears with the right count.
      **Stop there. Do not charge a card or record a payment.**

## Rollback

Application code, no schema change:

```
# Re-dispatch Deploy to production with ref = the previous good SHA.
# Cancel any run parked on an approval FIRST — a waiting run holds the
# production-deploy concurrency group, so a rollback queues behind it, and a
# second rollback dispatch silently cancels the first pending one.
```

That republishes the earlier build. It is the fastest path and needs no git
history change.

If the bad commit is already on `main` and should leave it:

```
git revert -m 1 <merge-sha>     # -m 1 for a merge commit
git push origin main            # runs ci.yml only — does NOT deploy
# then dispatch Deploy to production against the new SHA
```

**Migrations do not roll back.** D1 has no down-migrations here, and
`d1 migrations apply` is forward-only. If a migration is the problem, the fix is
a new forward migration that corrects it, written and reviewed like any other.
Re-deploying older application code against a newer schema is **not** checked by
anything. Migrations here are additive by convention only: `ci.yml`'s guard over
`migrations/finance/` rejects REAL/FLOAT/DOUBLE money columns and says nothing
about additivity — and that directory is a historical record which is never
applied, so it does not even cover the 87 files that ship. Read the specific
migration before rolling code back past it.

## What is deliberately not automated

Two steps touch the production database, both inside the `migrate` job and both
behind the `production-database` approval: `d1 migrations list --remote` and
`d1 migrations apply --remote`. No step queries Stripe, reads tenant data, or
runs a backfill. Those stay manual, per `CLAUDE.md`.
