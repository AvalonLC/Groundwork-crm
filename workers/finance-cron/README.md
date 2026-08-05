# Finance OS nightly rollup — scheduling scaffold

**Decision locked in 2026-08-04: Option B (external scheduler via GitHub
Actions).** See `.github/workflows/finance-cron.yml` at the repo root —
that's the active implementation now. This directory (Option A, a
companion Cloudflare Worker) was **not chosen** and is kept only as a
documented, unused alternative in case the decision is revisited later.
Nothing here is deployed or referenced by the active workflow.

The rollup logic itself (`src/cron/rollup.ts`, `src/cron/gather-inputs.ts`)
and the authenticated trigger endpoint (`POST /internal/cron/rollup`, see
`src/api/cron-trigger.ts`) are shared by both options and don't change
based on which one is used.

## Option A — this companion Worker (not chosen, reference only)
A tiny separate Cloudflare Worker (this directory) whose only job would be
calling `POST /internal/cron/rollup` with the shared secret, on a Cron
Trigger. If you ever want to switch to this instead of GitHub Actions:
1. Pick a schedule and uncomment `triggers.crons` in `wrangler.jsonc`.
2. Set the shared secret on **both** projects (must match):
   ```
   wrangler secret put CRON_SECRET --config workers/finance-cron/wrangler.jsonc
   wrangler pages secret put CRON_SECRET --project-name groundwork-crm
   ```
3. `wrangler deploy --config workers/finance-cron/wrangler.jsonc`
4. Disable/delete `.github/workflows/finance-cron.yml` so both aren't
   running redundantly.

## Option B — external scheduler via GitHub Actions (chosen, active)
`.github/workflows/finance-cron.yml` calls `POST /internal/cron/rollup`
directly on a schedule — no Cloudflare Worker involved. Setup needed
(documented in full inside that workflow file's header comment):
1. Generate a secret value (e.g. `openssl rand -hex 32`).
2. Add it as a GitHub Actions repository secret named `CRON_SECRET`.
3. Set the same value as a Cloudflare Pages secret:
   `wrangler pages secret put CRON_SECRET --project-name groundwork-crm`.

## Either way
`CRON_SECRET` is never committed to this repo — it's a Cloudflare secret
and a GitHub Actions secret, set independently on each platform, not a
`vars` entry or file value anywhere in version control. Until the
Cloudflare Pages side is set, `POST /internal/cron/rollup` fails closed
(503) for every request — there is no unauthenticated fallback.
