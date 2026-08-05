# Groundwork Finance OS — Build Contract

## STACK (this is an EXISTING LIVE APP — do not substitute or re-scaffold)
Hono + Cloudflare Pages/D1 · TypeScript · Vite · Vitest · Playwright
Config: **wrangler.jsonc** (NOT wrangler.toml — do not create a .toml)
Project: `groundwork-crm` · live at https://groundwork-crm.com
Two D1 databases, do not cross them:
  - `DB` (avalon-sales-hub-production) — the existing CRM. Migrations: numbered SQL in /migrations.
  - `FINANCE_DB` (groundwork) — Finance OS, separate database. Migrations: numbered SQL in /migrations/finance, starting at 0001.
Local: `wrangler d1 migrations apply groundwork --local` (finance) or `npm run db:migrate:local` (CRM)

This repo already contains a working CRM with real feature history. You are ADDING
a Finance OS layer inside it. Do not restructure existing directories, do not
reformat existing files, and do not "clean up" code you were not asked to touch.

## PRODUCTION IS LIVE AND HAS NO STAGING STEP
`npm run deploy` pushes to groundwork-crm.com IMMEDIATELY.
`npm run db:migrate:prod` writes the PRODUCTION database IMMEDIATELY.

You must NEVER run either one, or any equivalent (`wrangler pages deploy`,
`wrangler d1 migrations apply --remote`). No exceptions, no "just to verify."
Tyler runs those himself while awake. The pre-push hook blocks them.

## MONEY IS INTEGER CENTS
Every monetary column is INTEGER cents. Every rate column is INTEGER
ten-thousandths (e.g. $42.1002 -> 421002). Convert at the UI boundary only.
Floats WILL fail the to-the-cent fixtures. This is not negotiable.

## FOUR HARD RULES — violating any one fails review
1. No write path to QuickBooks. Groundwork proposes; QBO records.
2. Rate rows are immutable + effective-dated. Recalibration INSERTs a new row
   and sets effective_to on the prior row. NEVER UPDATE a rate row.
3. Overhead recovery increments ONLY from time_entry hours. Never from an
   invoice, deposit, or payment event.
4. `confidence` and `stale_components` travel with every returned number and
   must render in the UI.

## ARCHITECTURE INVARIANTS
- 7 layers, dependency flows DOWN only:
  input -> event spine -> rates -> job costing -> recovery -> action queue -> learning
- ALL cost rates come from /internal/rates/resolve and /internal/rates/equipment.
  No module computes its own labor or overhead arithmetic. Ever.
- Every AI finding becomes an action_item with
  verb in {collect,bill,pay,fix,decide} + owner_id + sla_due + amount_cents.
- time_entry.resolved_rate and .applied_overhead are written ONCE at posting
  and never recomputed.

## THE EQUIPMENT DOUBLE-COUNT (most likely bug in this project)
labor_rate_profile.support_equipment_annual MUST be 0 whenever
tenant_finance_policy.equipment_engine_active = true.
- equipment_engine_active = false -> burdened rate 42.1002 (1.754x)
- equipment_engine_active = true  -> burdened rate 40.6205 (1.693x)
Test BH-13 asserts this. It is pre-written. Do not modify or skip it.

## UI INVARIANTS
- Two vocabularies, one dataset, per-user toggle. Simple mode is DEFAULT and
  contains zero accounting words (see /docs/dictionary.json).
- Crew role: never render margin, wage, or rate fields.
- If a value can be derived, never add an input for it.

## WORKFLOW — every task, no exceptions
1. Read the task's spec_ref BEFORE writing code.
2. Write the failing test FIRST, from the fixture in fixtures/golden.json.
3. Implement until the gate command exits 0.
4. Touch ONLY files listed in files_owned.
5. Commit format: `[<task_id>] <what changed>` — one task, one commit.
6. If blocked after max_attempts: write BLOCKED-<task_id>.md describing the
   failing assertion and STOP. Do NOT invent a workaround. Do NOT widen scope.
   Do NOT delete or skip a test to make a gate pass.

## TYLER HAS UNCOMMITTED WORK IN THIS REPO
Files listed in `.agent-protected` had in-progress edits before you started.
Never modify them, never `git add -A` in the main working tree, and never
`git stash`, `git checkout --`, or `git restore` anything you did not create.
Stage files explicitly by path. The pre-push hook enforces this.

## NEVER
- `wrangler ... --remote` (local only; humans run remote)
- `git push --force` or any history rewrite
- Reading or writing DB_PROD
- npm install of a package absent from package.json without noting it in the commit
- Editing another task's files_owned
