# Runbook: Finance OS Nightly Rollup

Operational reference for the scheduled rollup — setup, verification, and
secret rotation. For the underlying design decisions, see
`docs/spec/RECOVERY.md`. For the rejected companion-Worker alternative, see
`workers/finance-cron/README.md`.

## What this is

Once a day, something needs to call `POST /internal/cron/rollup` on the live
app so it can compute each tenant's overhead-recovery projection and write a
`recovery_snapshot` row. Cloudflare Pages has no native scheduler, so a
GitHub Actions workflow in this repo does it instead.

## How the scheduled rollup calls the app

```
.github/workflows/finance-cron.yml (cron: 7am UTC daily, or manual trigger)
  │
  ▼
POST https://groundwork-crm.com/internal/cron/rollup
  Header: X-Cron-Secret: <value from the GitHub Actions secret CRON_SECRET>
  │
  ▼
src/api/cron-trigger.ts
  1. Compares the header against the Cloudflare Pages secret CRON_SECRET.
     No match (or not configured at all) -> 401 / 503, nothing runs.
  2. Lists every tenant_id with a tenant_finance_policy row
     (src/cron/gather-inputs.ts: listTenantIdsWithPolicy).
  3. For each tenant, gathers real inputs from time_entry,
     job_cost_ledger, and overhead_allocation
     (gatherTenantRollupInputs) — skips (doesn't error) any tenant
     with no policy row yet.
  4. Calls runNightlyRollup, which computes every tenant's projection
     (src/engines/recovery.ts) and writes all recovery_snapshot rows in a
     single db.batch() call.
  5. Returns a JSON summary: tenants processed, tenants skipped, and the
     per-tenant results — this is what shows up in the GitHub Actions log.
```

## Where CRON_SECRET must be set

Two places, same value, set independently (never written to any file in
this repo — not a `wrangler.jsonc` var, not a `.env`):

| Where | Command | Notes |
|---|---|---|
| GitHub Actions | Repo Settings -> Secrets and variables -> Actions -> New repository secret, name `CRON_SECRET` | No CLI equivalent without `gh` auth; use the web UI |
| Cloudflare Pages | `wrangler pages secret put CRON_SECRET --project-name groundwork-crm` | Prompts for the value interactively; run from the repo root with wrangler authenticated |

Generate the value yourself first, e.g.:
```
openssl rand -hex 32
```
Paste the exact same string into both places. Order doesn't matter, but the
workflow will fail (or the endpoint will 503) until **both** are set.

## How to verify

**1. Confirm the Cloudflare side is configured, with no secret needed to ask:**
```
curl https://groundwork-crm.com/internal/cron/rollup/status
```
Returns `{"cron_secret_configured": true}` once
`wrangler pages secret put CRON_SECRET` has been run. This never reveals the
secret's value — only whether one is set.

**2. Dry-run the actual computation without writing anything**, once you
know the secret value:
```
curl -X POST "https://groundwork-crm.com/internal/cron/rollup?dry_run=true" \
  -H "X-Cron-Secret: <the secret value>"
```
Runs the full pipeline (gathers real per-tenant inputs, computes
projections) and returns the results, but skips the `recovery_snapshot`
write entirely — confirmed by a dedicated test (`CT-09` in
`src/api/cron-trigger.test.ts`) that asserts the table stays empty after a
dry run. Safe to run against production data any time; it never mutates
anything.

**3. Test the GitHub Actions workflow itself**, once both secrets are set:
go to the repo's Actions tab -> "Finance OS Nightly Rollup" -> "Run
workflow" (the `workflow_dispatch` trigger) rather than waiting for the
schedule. Check the run's log for the HTTP status and response body.

**4. Test locally**, without touching production at all:
```
npm run dev:local
# in another terminal:
curl -X POST "http://localhost:3000/internal/cron/rollup?dry_run=true" \
  -H "X-Cron-Secret: whatever-you-set-in-.dev.vars"
```
Requires a local `.dev.vars` file (gitignored, never committed) with a line
like `CRON_SECRET=local-test-value` — set your own value there, it never
needs to match the real production secret since it's a completely separate
local D1 instance.

## How to rotate the secret later

No downtime consideration — this only gates one internal endpoint that
nothing else depends on synchronously.

1. Generate a new value (`openssl rand -hex 32`).
2. Update the Cloudflare Pages secret first:
   `wrangler pages secret put CRON_SECRET --project-name groundwork-crm`
   (overwrites the existing value).
3. Update the GitHub Actions secret to match (Settings -> Secrets and
   variables -> Actions -> `CRON_SECRET` -> Update).
4. Verify with the `/rollup/status` check above, then optionally trigger
   the workflow manually to confirm end-to-end.

If you update only one side and forget the other, the next scheduled run
simply fails with 401 (wrong secret) — it fails closed, never silently
succeeds with a stale credential, and never runs unauthenticated.

## If a scheduled run fails

Check the GitHub Actions run log first (Actions tab -> the failed run) —
the workflow prints the HTTP status and full response body. Common causes:
- **503** — `CRON_SECRET` was never set on the Cloudflare Pages side.
- **401** — the two secret values don't match; re-check both.
- **200 but a tenant is unexpectedly in `tenants_skipped`** — that tenant
  has no `tenant_finance_policy` row yet, not an error condition.
