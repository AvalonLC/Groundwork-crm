# Runbook — deploying to production

Merging and deploying are separate decisions. A merge to `main` runs `ci.yml`
and ships nothing. Production is reached only by dispatching **Deploy to
production** by hand.

## Why

`deploy.yml` used to trigger on `push: branches: [main]`. On 2026-09-07 three
engineering PRs were merged twenty seconds apart, producing three production
deployments and three `d1 migrations apply --remote` runs in under a minute.
Nothing was wrong with the changes; nobody chose to deploy three times. A
routine merge should not be able to ship.

## Deploying

Actions → **Deploy to production** → Run workflow.

| input | notes |
|---|---|
| `ref` | Prefer a **commit SHA**. A branch name can move between approving the run and the run reaching the deploy job. |
| `run_migrations` | `no` when the release contains no files under `migrations/`. Check with `git diff --name-only <last-deployed-sha> <ref> -- migrations/`. |
| `confirm` | Must be exactly `DEPLOY`. |

The run then stops twice for approval:

1. **`production-database`** — before `d1 migrations apply --remote`. Skipped
   entirely when `run_migrations: no`.
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
# Re-dispatch Deploy to production with:
#   ref            = the previous good SHA
#   run_migrations = no
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
Re-deploying older application code against a newer schema is usually safe —
the migrations in this repo are additive by policy, and `ci.yml` enforces that
for `migrations/finance/` — but confirm the specific change before relying on it.

## What is deliberately not automated

Nothing here reads or writes `DB_PROD` outside the migration step, and no step
queries Stripe. Those stay manual, per `CLAUDE.md`.
