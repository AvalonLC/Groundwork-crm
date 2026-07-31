# AGENTS.md — Groundwork CRM

Briefing for AI coding agents (Codex, Claude, etc.) working on this repo.
Read this fully before editing anything.

## What this is

Groundwork CRM — a multi-tenant SaaS CRM for field-service companies
(landscaping, HVAC, etc.), live at https://groundwork-crm.com.

- **Stack**: Hono (TypeScript) on Cloudflare Pages + D1 (SQLite) + R2 (media)
- **Backend**: `src/index.tsx` (single large Hono app), `src/portal.tsx` (client portal)
- **Frontend**: vanilla JS bundles in `public/js/` (NO framework, NO bundler for
  frontend code — files are served as-is). Main bundle: `public/js/app_premium.js`.
  Icons: `public/js/gw-icons.js` (check an icon name exists before using `gwIcon()`).
- **Build**: `npm run build` (Vite, builds `src/` into `dist/_worker.js`; also
  auto-bumps `?v=` cache stamps referenced in `src/index.tsx`)

## Hard rules

1. **NO emojis** — not in code, UI strings, commit messages, or replies to the user.
2. **NEVER modify `.github/workflows/deploy.yml`.**
3. Frontend JS lives in `public/js/`. `public/static/` is a legacy mirror —
   never edit `public/static/` directly; it is synced by copy (see workflow below).
4. Production HTML loads scripts from the `/js/` path. When verifying production,
   curl `https://groundwork-crm.com/js/<file>` — NOT `/static/` (stale mirror there
   is expected).
5. Multi-tenant: every D1 query must be scoped by company. Never leak data across
   companies.
6. Settings persist to D1 via `PUT /api/settings` (keys are prefixed per company);
   selected keys hydrate to localStorage at login via the FIN_MAP bootstrap in
   `src/index.tsx` (~line 11500). Do not store real data only in localStorage.

## Standard edit-and-deploy workflow

```bash
# 1. Edit files in public/js/ and/or src/

# 2. Sync legacy static mirror, then build
cp -r public/js/. public/static/
npm run build                # long-running; allow 300s

# 3. Local test (PM2 app name: avalon-sales-hub, port 3000)
fuser -k 3000/tcp 2>/dev/null; pm2 restart avalon-sales-hub; sleep 6
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000   # expect 200
# Authenticated API test: cookie avalon_session=testtoken123

# 4. Syntax check any edited JS
node --check public/js/app_premium.js

# 5. Commit and push — push to main IS the production deploy
git add -A && git commit -m "message" && git push origin main

# 6. GitHub Actions builds and deploys to Cloudflare Pages (~100 s).
#    Verify: curl -s https://groundwork-crm.com/js/<file> | grep <new symbol>
```

If PM2 isn't available (e.g. Codex cloud sandbox), local preview:
`npm run build && npm run dev:local` (wrangler pages dev on port 3000, local D1).

## Database (D1)

- Binding: `DB`. Production DB name: `avalon-sales-hub-production`
  (UUID in `wrangler.jsonc`, lives in the owner's Cloudflare account).
- Local dev uses `--local` (SQLite under `.wrangler/state/`), no credentials needed.
- Schema changes: add a new numbered file in `migrations/` (never edit old ones).
  - Local:  `npx wrangler d1 migrations apply avalon-sales-hub-production --local`
  - Production: applied AUTOMATICALLY by the deploy workflow on push to main
    (the "Apply D1 migrations" step runs before the Pages deploy). No manual
    step needed — just make sure new migrations are additive and safe to run
    against live data (use IF NOT EXISTS, never drop or rewrite existing
    columns without a data-preserving path).
- Local console:
  `npx wrangler d1 execute avalon-sales-hub-production --local --command="..."`

## Deployment

- GitHub repo: `AvalonLC/Groundwork-crm`, branch `main`.
- `.github/workflows/deploy.yml` deploys `dist` to Cloudflare Pages project
  `groundwork-crm` on every push to main, using repo secrets `CF_API_TOKEN`
  and `CF_ACCOUNT_ID`. Do not add other deploy paths.

## Sales process platform (versioned)

- Schema: migrations `0046`–`0052`. Core tables: `sales_processes`,
  `sales_process_versions`, `sales_process_stages`, `sales_stage_outcomes`,
  `sales_stage_internal_statuses`, `sales_stage_requirements`,
  `sales_stage_guides`, `sales_process_resources`, `sales_process_automations`,
  `sales_stage_transition_paths` (current; `sales_stage_transitions` is legacy
  fallback), `sales_stage_assignments`, `sales_migration_mappings/history/
  snapshots/snapshot_items`, `sales_process_publications`,
  `sales_ai_suggestions`, `sales_academy_associations`.
- Global template catalog is immutable (`company_id='__global__'`,
  `is_template=1`, `is_immutable=1`). The templates endpoint returns only the
  latest version per template; adopting a graphless superseded version
  (e.g. `tpl_groundwork_field_service_v1`) is rejected with 409. Never edit
  global templates — tenants get deep copies with fresh IDs on adopt.
- Lifecycle (all `/api/sales-process/*`, admin session): draft from template
  (`/drafts/from-template`) or from the live board
  (`/drafts/from-current-pipeline`, imports current pipeline labels as a
  validation-complete draft) -> validate -> migration propose ->
  per-opportunity mapping review (`final_stage_id`, optional
  `final_outcome_type`) -> snapshot (`migration_batch_id` in body) ->
  snapshot approve -> publication-readiness (`?migration_batch_id=` query) ->
  publish `{confirm:true, migration_batch_id}` -> optional rollback
  `{confirm:true}`.
- Publish is a FULL PIPELINE CUTOVER: it writes the published stage labels to
  the `{companyId}:pipeline_stages` setting, migrates each mapped
  opportunity's `status`/`pipeline_stage` text to the new labels, and captures
  the prior setting in `impact_json.previous_pipeline_stages` (`null` if the
  setting did not exist) plus per-opportunity prior labels in history
  `event_json`. Rollback restores all of it exactly (deletes the setting when
  previously absent). New leads default to the live setting's first label;
  legacy status writes sync the stable assignment via
  `syncPublishedStageAssignment` (classification `status_synced`) — unknown
  labels leave assignments untouched (Needs Restaging preserved).
- LIVE EDITING (published version, no draft cycle): `PUT /api/sales-process/
  live/:versionId/stages` and `PUT .../live/:versionId/components/:component`
  (internal_statuses|requirements|guides|resources|automations|academy only —
  no transitions/outcomes). Gated on `lifecycle='published'` + admin role +
  `content_revision` optimistic concurrency (same changes()=0 INSERT trick as
  drafts). Stage saves cascade live: rewrite `{companyId}:pipeline_stages`
  setting and UPDATE renamed stages' opportunities `status`/`pipeline_stage`
  by `sales_process_stage_id`. Deleting/archiving a NON-CLOSING stage that
  holds `sales_stage_assignments` is rejected 409 (draft flow required).
  Occupied CLOSING stages may be archived/removed when active closing stages
  absorb every lead by its assignment `outcome_type` (split Closed into
  Won/Lost; preference chains won->terminal, lost->terminal,
  disqualified->lost->terminal, nurture->terminal->lost; unmatched outcome
  = 409). Response carries `redistributed_leads`. New active
  stages get wired into the transition graph; orphaned transitions/outcomes
  for removed stages are deleted. Draft routes still 404 on published
  versions (immutability contract in the adoption integration test).
- Canonical stage resolver: `resolveSalesOpportunityStage` in `src/index.tsx`;
  browser mirror: `public/js/sales-process.js`. Keep them in sync.
- Migration/publishing code must NEVER touch `gw_leads`
  (see `docs/sales-process-dependency-inventory.md`).
- Production publication for a live tenant is a deliberate HUMAN gate — never
  automate adopt/review/publish against production data
  (see `docs/sales-process-completion-matrix.md`).
- GROUNDWORK AI LEAD SCORING (client-side, `public/js/app_premium.js`):
  `gwStageClock(o)` = days in current stage from `stageEnteredAt` (API field
  `sales_process_assigned_at`, a subselect on GET /api/opportunities over
  `sales_stage_assignments.assigned_at`, which is refreshed on every stage
  move) vs the stage's `expected_duration_days`; bands ok/watch/late (late =
  1.75x expected) drive the follow-up urgency chips, the "Needs Follow-Up"
  stat card and the `overdue` quick-filter. `gwLeadScore(o)` = deterministic
  0-100 close likelihood; hard pins won=100 / lost|disqualified=0; open leads
  clamped 3-97; baseline from stage position plus factors (stage-clock ratio,
  process velocity, lead source, budget-vs-estimate via `gwParseBudget`,
  estimate momentum from `linked_estimate_status`, engagement recency), all
  surfaced in a factor breakdown (rail card + pill tooltip). Pipeline sort
  default is `priority` (score desc). If you add signals, keep the factor
  list transparent and never let an open lead hit 0 or 100.
- AI STRUCTURED-OUTPUT CONTRACT (`src/index.tsx`): all JSON-drafting AI
  endpoints (generate-quote, generate-proposal) MUST call `_aiChatJson`
  (adds `response_format: json_object`; adds `reasoning_effort: 'low'` only
  for gpt-5/o-family models; retries once WITHOUT extras on HTTP 400 so BYOK
  custom models keep working) and parse with `_aiParseJson` (strips fences,
  salvages truncated JSON by closing unterminated strings/brackets). Never
  regress to raw `JSON.parse(indexOf('{')..lastIndexOf('}'))` — multi-tier
  quotes previously produced ~10k completion tokens and timed out or
  truncated, breaking 2/3-option generation.
- CUSTOMER PRICE VIEW (`estimates.price_display`, migration 0054, ensured by
  `ensurePriceBookSchema`): `'itemized'` | `'total_only'`. `total_only`
  renders ONE total callout + description-only included-scope checklist in
  BOTH renderers — `_estPortalContentHtml` (estimates.js) and the server
  portal page `/estimates/portal/:token` (index.tsx); keep them in sync.
  Persisted via `_estApplyExtFields`; normalized in `_estNormalize`;
  `_estAiApply` defaults AI quotes to `total_only`. Internal views (Pricing
  Workbench, detail page) must always stay itemized.
- LEAD VALUE / COMMISSION COUPLING: `opp.jobValue` (server column `job_value`)
  drives `estCommission(opp)` → `window.estimateCommission`. Edits go through
  `window._gwSetLeadValue(id, raw)` (app_premium.js), which coerces to Number,
  write-throughs via `_d1SaveOpp`, and updates `#gwFigVal_<id>` /
  `#gwFigComm_<id>` in place — do NOT full re-render on value edit (wipes
  unsaved form fields). The Overview form input intentionally has NO `name`
  attribute so the generic string autosave skips it. Pipeline division totals
  come from `_gwDivisionValueStrip` (open leads, `gwClassifyDivision`).
- +NEW MENU: `_gwBuildNewMenu` items for cross-module creation use
  `window._gwNavThen(view, fnName, arg)` — navigate first, then poll up to 3s
  for the module to register its entry point (`_estNewEstimate`,
  `_invOpenBuilder`, `_invPaymentPicker` in invoices.js, `_ahNewAsset`,
  `_umOpenInviteForm`). Keep role gates: estimate = admin/sales; invoice,
  payment, asset, employee = admin (admin includes office_manager).

## Tests

39 tests across 7 suites; all must pass before pushing sales-process changes:

```bash
npm run test:migrations            # needs the sqlite3 CLI (apt-get install sqlite3)
node --test tests/sales-process-platform.test.mjs tests/sales-process-safety.test.mjs
npm run test:sales-process-ui      # linkedom DOM proof of the admin builder
npm run test:sales-process-transitions   # Miniflare; vite-builds dist first
npm run test:sales-process-adoption      # Miniflare; vite-builds dist first
npm run test:migration-review            # Miniflare; vite-builds dist first
```

Sandboxes reset: reinstall the `sqlite3` CLI if `test:migrations` fails to spawn it.

## Gotchas learned the hard way

- Some existing strings contain unicode (em/en dashes). If an exact-match edit
  fails with "string not found", inspect the real bytes (grep/python) rather
  than retrying with a guessed ASCII version.
- `src/index.tsx` is very large (10k+ lines); grep for anchors before editing.
- Frontend has no build step — a syntax error in `public/js/*.js` breaks the
  live app directly. Always `node --check` after editing.
- Divisions and lead-intake form are company-configurable: use `gwDivisions()`,
  `gwClassifyDivision(o)`, `gwIntakeConfig()` in `app_premium.js` — never
  hardcode division names/categories in new code.
- The legacy work-order detail page is retired: job clicks must route to the
  schedule board visit modal (`workOrderDetail()` is redirect-only; keep it so).
- Onboarding wizard: `public/js/onboarding.js`, 9 steps, gated by
  `onboarding_completed` / `onboarding_step >= 9` on the company record.
