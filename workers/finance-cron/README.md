# Finance OS nightly rollup — scheduling scaffold

The rollup logic itself (`src/cron/rollup.ts`, `src/cron/gather-inputs.ts`)
and the authenticated trigger endpoint (`POST /internal/cron/rollup`, see
`src/api/cron-trigger.ts`) are built and tested. Cloudflare Pages has no
native Cron Trigger — that's a Workers-only feature — so something else has
to call that endpoint on a schedule. Two options, both scaffolded, neither
deployed:

## Option A — this companion Worker
A tiny separate Cloudflare Worker (this directory) whose only job is calling
`POST /internal/cron/rollup` with the shared secret, on a Cron Trigger.

To activate:
1. Pick a schedule and uncomment `triggers.crons` in `wrangler.jsonc`
   (cron syntax, e.g. `"0 7 * * *"` = 7am UTC daily).
2. Set the shared secret on **both** projects (must match):
   ```
   wrangler secret put CRON_SECRET --config workers/finance-cron/wrangler.jsonc
   wrangler pages secret put CRON_SECRET --project-name groundwork-crm
   ```
3. `wrangler deploy --config workers/finance-cron/wrangler.jsonc`

## Option B — an external scheduler
Skip this Worker entirely. Point any external scheduler (GitHub Actions on
a `schedule:` trigger, cron-job.org, a server you already run, etc.) directly
at:
```
POST https://groundwork-crm.com/internal/cron/rollup
X-Cron-Secret: <the same shared secret>
```
Only needs `wrangler pages secret put CRON_SECRET --project-name groundwork-crm`
— nothing in this `workers/finance-cron/` directory is used.

## Either way
`CRON_SECRET` is never committed to this repo — it's a Cloudflare secret,
set via `wrangler secret put` / `wrangler pages secret put`, not a `vars`
entry in any `wrangler.jsonc`. Until it's set, `POST /internal/cron/rollup`
fails closed (503) for every request — there is no unauthenticated fallback.

**The only remaining decision is which option, and the actual cron
schedule.** Nothing else needs to be built for either path.
