# Groundwork CRM

**Production URL:** https://groundwork-crm.com  
**Cloudflare Pages project:** `groundwork-crm` (Tyler@avalon-lc.com's account)  
**GitHub repo:** https://github.com/AvalonLC/Groundwork-crm  
**Tech stack:** Hono · TypeScript · Vite · Cloudflare Pages · Cloudflare D1

---

## Quick start — clone & run from any machine

> Works on Mac, Linux, or Windows (WSL2 recommended on Windows).  
> You need **Node 18+**, **npm**, and a **Cloudflare API token** with Pages + D1 permissions.

```bash
# 1. Clone
git clone https://github.com/AvalonLC/Groundwork-crm.git
cd Groundwork-crm

# 2. Install dependencies
npm install

# 3. Set your Cloudflare API token for local wrangler commands
#    Create one at https://dash.cloudflare.com/profile/api-tokens
#    Permissions needed: Cloudflare Pages:Edit, D1:Edit, Account Settings:Read
export CLOUDFLARE_API_TOKEN=your_token_here

# 4. Apply DB migrations to local SQLite (first time only)
npm run db:migrate:local

# 5. Build the app
npm run build

# 6. Run locally against your D1 production DB (read-only safe)
npm run dev:local
#    → http://localhost:3000
```

---

## Deploy to production from any terminal

```bash
# One command — builds and pushes to groundwork-crm.com
npm run deploy
```

This runs:
1. `node scripts/bump-version.js` — auto-increments the build version in `src/index.tsx`
2. `vite build` — compiles the Hono worker + copies static assets
3. `wrangler pages deploy dist --project-name groundwork-crm` — uploads to Cloudflare

**Prerequisite:** `CLOUDFLARE_API_TOKEN` env var must be set (see above).

---

## Automatic deploys via GitHub Actions

Every push to `main` automatically builds and deploys to `groundwork-crm.com`.

**One-time setup** (already done — but needed if you fork or recreate):

1. Go to your GitHub repo → **Settings → Secrets and variables → Actions**
2. Add two repository secrets:

| Secret name     | Value |
|----------------|-------|
| `CF_API_TOKEN`  | Your Cloudflare API token (Pages:Edit + D1:Edit + Account Settings:Read) |
| `CF_ACCOUNT_ID` | `9cc88e60ca3b4d57d9f6461fc8100577` |

3. Push anything to `main` — the workflow in `.github/workflows/deploy.yml` fires automatically.

You can also trigger a deploy manually: **GitHub → Actions → Deploy to Cloudflare Pages → Run workflow**.

---

## Project structure

```
groundwork-crm/
├── src/
│   └── index.tsx          # Hono app — all routes, HTML shell, bootstrapD1Auth
├── public/
│   ├── js/                # All client-side JS (served at /js/*)
│   │   ├── app_premium.js     # Main CRM app (21 000+ lines)
│   │   ├── field_workday.js   # Field dashboard
│   │   ├── field_mode.js      # Field mode (standalone)
│   │   ├── gw_i18n.js         # EN/ES translation engine
│   │   └── ...
│   └── static/            # LEGACY/unused — not served by src/index.tsx (only
│                           #   `/js/*` is registered via serveStatic). Do not
│                           #   edit files here; they are stale copies left
│                           #   over from an earlier refactor. Edit `public/js/`.
├── migrations/            # D1 SQL migrations (0001_*.sql … 0029_*.sql)
├── scripts/
│   └── bump-version.js    # Auto-increments ?v= cache-bust version on build
├── .github/
│   └── workflows/
│       └── deploy.yml     # GitHub Actions: push to main → auto-deploy
├── wrangler.jsonc         # Cloudflare config (project name, D1 binding)
├── package.json           # npm scripts
└── vite.config.ts         # Vite build config
```

---

## Database (Cloudflare D1)

- **Production DB name:** `avalon-sales-hub-production`
- **Production DB UUID:** `a09eba8e-6c21-4ec3-a257-70a94b6e2aeb`
- **Binding in code:** `c.env.DB`
- **Migrations folder:** `./migrations/`

```bash
# Apply migrations to production D1
npm run db:migrate:prod

# Apply migrations to local SQLite (dev)
npm run db:migrate:local

# Query production D1 directly
npx wrangler d1 execute avalon-sales-hub-production --command "SELECT COUNT(*) FROM reps"

# Query local D1
npx wrangler d1 execute avalon-sales-hub-production --local --command "SELECT COUNT(*) FROM reps"
```

---

## Multi-tenant lifecycle (added 2026-07-14)

- **Public signup**: `/signup` (`/onboard` 301-redirects there). Protected by an invisible honeypot
  field and an IP rate limit (3 signups/hour, settings key `_signup_rl_<ip>`). New companies get a
  14-day trial (`subscription_status='trial'`, `trial_expires_at`).
- **Email verification**: soft gate. If `SENDGRID_API_KEY` is set, signup sends a verify link
  (`/api/auth/verify-email?token=`); the app shows a bottom banner with "Resend link" until verified.
  Status is stored as settings key `<companyId>:email_verified_<repId>`.
- **Trial enforcement**: `requireAuth` returns **402 trial_expired** on data routes once
  `trial_expires_at` passes (auth/branding/companies/poll remain reachable so the app can render the
  upgrade overlay). Frontend shows a full-screen "trial ended" overlay + a countdown pill in the topbar.
  To extend/upgrade: Platform Admin → edit company plan, or set `trial_expires_at` / `subscription_status`.
- **Suspension**: setting a company `active=0` blocks login (403) and all API calls (`company_suspended`).
- **Password reset**: `/api/auth/reset-request` (emails 6-digit OTP) → `/api/auth/reset-pin`. Wired to
  the "Forgot?" panel on the login screen. Requires `SENDGRID_API_KEY` for email delivery.
- **Company delete**: Platform Admin → Companies → **Delete** (type-to-confirm) or
  `DELETE /api/admin/companies/:id?confirm=<id>` — purges all tenant rows, settings, and sessions.
  `avalon` and `groundwork_platform` are protected.
- **Company export**: Settings → Export → "Full Company Export (Cloud)" or `GET /api/company/export`
  (admin/office manager) — JSON of every tenant table, credentials stripped.
- **Schema self-heal**: first signup on any deployment runs embedded migrations 0022–0030
  idempotently (`ensureFullSchema`, flag `_schema_full_v1`) so production D1 never lags the code.
- **E2E tests**: `node tests/e2e_full.js` (see tests/README.md).

## Unified Estimates & Proposals + Price Book (added 2026-07-16)

The old separate Estimates and Proposals pages are merged into one document system under
**Sales → Estimates**. An estimate is simply a "simple-mode" proposal.

- **Simple ⇄ Advanced toggle** in the builder. Advanced adds an overview section and
  **Good / Better / Best option tiers** (stored in `estimates.tiers` JSON).
- **One-Time ⇄ Recurring toggle**. Recurring opens the maintenance-contract calculator:
  per-service visits/year × man-hours × materials → yearly cost → +profit → **monthly price**,
  with a multi-year escalation table (default 3%/yr from year 2). Rollup persists in `recurring_data`.
- **Job Cost Engine** (internal-only panel, never shown to customers): materials + tax +
  plant warranty + misc + setup pay + equipment + labor (budgeted hrs) → direct cost →
  + overhead recovery → break-even → + profit % → **recommended selling price**, with
  revenue-per-man-hour goal check and crew/days estimate. Rollup persists in `cost_data`.
  All rates are per-company settings (`GET/PUT /api/pricing-settings`, editable in
  Services & Pricing → Job Cost Settings) so any service business can customize.
- **Price Book — Admin → Services & Pricing** (`pricing` tab, admin/office_manager):
  CRUD for services/materials/labor/equipment items (`price_items` table) plus
  **CSV/Excel import** (SheetJS, multi-block sheet detection, merge or replace) via
  `POST /api/price-items/import`. Builder line items get a type-ahead **price-book picker**
  that auto-fills unit, unit cost, and unit time.
- **✨ AI Quote Generator** in the builder: `POST /api/ai/generate-quote` reads the lead's
  conversation + notes, matches against the company price book, optionally cross-references
  market rates, and drafts a tiered quote with email/SMS copy. **Review-before-apply** — nothing
  changes until you click Apply. Requires the company `openai_api_key`
  (Integrations → Admin Setup); returns a graceful `no_api_key` message otherwise.
  AI calls run through `_aiChatJson` (JSON response format + low reasoning effort on
  gpt-5/o-family, with a bare retry for BYOK models that reject those params) and
  `_aiParseJson` (fence- and truncation-tolerant salvage parser), which fixed multi-tier
  (2/3-option) generations that previously timed out or returned unparseable drafts.
- **Customer price view (August 2026)**: each estimate has `price_display`
  (`itemized` default | `total_only`, migration 0054). "Total only" shows the client ONE
  list-price callout plus a description-only checklist of included scope items — no
  per-line pricing — on both the in-app portal preview (`_estPortalContentHtml`) and the
  public tokenized portal page (`/estimates/portal/:token`). Toggle lives in the builder's
  Line Items section; applying an AI quote defaults to `total_only`. The Pricing Workbench
  and internal detail views always stay fully itemized.
- **Editable lead value + division pipeline totals (August 2026)**: every lead's
  Est. Value (`jobValue`) is editable in two places — an "Est. Value ($)" field in the
  Contact & Opportunity form and a click-to-edit stat in the left-rail Figures grid
  (`window._gwSetLeadValue` persists via `_d1SaveOpp` and refreshes the Commission figure
  in place). Won leads switch that stat to an editable **Sold @** amount — the final
  price that then drives the final commission (`gwLeadBaseValue`: sold amount for won
  leads, estimate otherwise). Commission previews use the ASSIGNED rep's plan, and
  unknown plan ids fall back to the default plan instead of silently showing $0.
  The Pipeline page shows an "Open Pipeline Value" strip (`_gwDivisionValueStrip`):
  grand total of OPEN-lead value (won/lost excluded — they have left the pipeline)
  plus one clickable tile per company division (`gwClassifyDivision` + `gwDivisions()`),
  which toggles the existing division filter. Pipeline cards show the value in a fixed
  spot (right side of the stage row, a muted dash when unset).
- **Expanded +New menu (August 2026)**: `_gwBuildNewMenu` now also offers New Estimate
  (admin + sales), and for admins: New Invoice, Record Payment (invoice picker
  `_invPaymentPicker`), New Asset, and New Employee (invite form). Items route through
  `window._gwNavThen(view, fnName, arg)`, which navigates then polls briefly for the
  module's entry point before invoking it.
- **Convert to Job / Event**: accepted estimates get a "Convert to Job" button (also in the
  ⋯ menus) → `POST /api/estimates/:id/convert-to-job` creates a work order (409 with a link
  if already converted). The detail view shows "View Work Order" once linked.
- **Proposals tab retired from nav** — deep links (`show('proposals')`, portal, composer)
  still work and highlight the Estimates tab. Existing `/api/proposals` documents remain
  fully accessible. The estimates list shows **PROPOSAL** / **RECURRING** chips so
  advanced/recurring documents are visible at a glance.
- **Schema**: migration `0034_price_book_estimate_merge.sql`; production self-heals via
  `ensurePriceBookSchema` on first API hit (no manual remote migration needed).

### Tabbed Builder — Document tab + Pricing Workbench (added 2026-07-16)

The estimate builder is split into two clearly-separated tabs so it's obvious whether
you're editing what the **customer sees** vs. **internal pricing**:

- **📄 Proposal/Estimate tab (customer-facing)** — green banner. Title, scope,
  customer-visible line items, overview + Good/Better/Best tiers (Proposal mode),
  attachments, notes, terms. The Simple ⇄ **Proposal** toggle (formerly "Advanced")
  switches between a quick estimate and a high-level branded proposal.
- **Live branded preview** — sticky side-by-side panel rendering the *exact* customer
  portal document (same renderer, company logo/brand color, tiers, CTAs inert) with a
  250ms-debounced refresh as you type. Toggleable (persisted per-browser, default ON);
  when off, the classic quote-summary rail returns.
- **🔒 Pricing Workbench tab (internal, never shown to customers)** — grey lock banner,
  sections lettered A/B/C. Spreadsheet-style **costed lines** (item type, qty, unit cost,
  hrs/unit → extended cost & hours), the recurring-contract calculator, and the Job Cost
  Engine all live here. "Use $X" pushes the engine's recommended selling price into the
  customer document, and the workbench tab shows a **live price badge** so the current
  recommended total is visible from the Document tab.
- **Estimate templates** — save the current document (content + workbench cost data,
  minus customer) as a reusable template; apply/delete from a picker on the Document tab.
  Stored via the existing `/api/proposal-templates` endpoints with `content.kind='estimate'`
  so estimate and proposal templates stay separate. Picker labels show each template's
  kind (Simple/Proposal · Recurring · # lines).

### Adjustable rates, workbench sections & proposal cover (added 2026-07-17)

- **Per-estimate rate overrides** — a "Rates for this estimate" panel in the Job Cost
  Engine lets anyone adjust profit %, OHR $/hr, labor rate, sales tax %, warranty %,
  setup pay, rev/man-hr goal, workday hours, and non-productive hrs for *that estimate
  only* (blank = company default from Job Cost Settings). Overrides live in
  `cost_data.rates`, save with the estimate and its templates, show amber ✎ highlights
  plus a "N custom rates" badge, and are one-click resettable. The recurring calculator
  has its own panel (maint labor/OHR/profit/escalation/tax → `recurring_data.rates`).
- **Workbench cost sections** — costed lines group into sheet-style sections
  (Landscaping, Hardscaping / Drainage, Miscellaneous, Equipment Rental, or custom "+ New
  section") with per-section highlighted subtotals and a grand total, matching the
  spreadsheet layout. Price-book picks auto-assign their category as the section.
- **Proposal mode is visually distinct** — Proposal-mode documents get a full-width
  branded cover band (brand color gradient, logo, "PROJECT PROPOSAL", title, prepared-for
  block) in the portal and live preview; Simple stays a clean quote. The builder shows a
  mode banner explaining what each mode adds.
- **Price Book export** — "⬇ Export CSV" on Services & Pricing downloads the whole price
  book (same headers the importer detects, so it round-trips through Sheets/Excel).
- **Company default Terms & Conditions** — Settings → Company → "Estimate & Proposal
  Defaults" card stores company-wide default T&C + customer notes
  (`GET/PUT /api/estimate-defaults`, admin/office_manager write, settings key
  `{companyId}:estimate_defaults`). Every NEW estimate auto-fills them (editable
  per-document); existing estimates are never touched, late-arriving defaults never
  overwrite user typing, and templates without their own terms keep the company default.

## Google Calendar Sync + Meeting Automation (added 2026-07-17)

- **Server-side sync** (`POST /api/calendar/sync`): pulls Google Calendar events (past 30d → next 90d)
  using each rep's stored OAuth refresh token (`google_tokens`), upserts into the `calendar_events`
  D1 table (migration `0035_calendar_sync.sql`). Runs automatically ~2.5s after login (throttled 4 min).
- **Booking-page capture**: events booked through Google appointment-schedule links are flagged
  (`is_booking=1`, "Booked online" chip) and auto-matched to leads by attendee email or a
  `[opp_xxx]` tag in the event description. Manual link/unlink via `PUT /api/calendar/events/:id/link`
  (manual links survive re-syncs).
- **My Day widget** ("My Calendar"): hour-by-hour agenda for today with live-now highlight,
  lead links, ↻ Sync and Expand (→ full month/week/agenda calendar in Integrations).
  Rendered by `public/js/calendar_sync.js` via mount `#gw-myday-cal-mount`.
- **Lead record**: synced Google meetings render in the lead's Meetings rail
  ("From Google Calendar") via mount `#gw-lead-cal-meetings` + MutationObserver.
- **Post-meeting automation**: when a lead-matched meeting ends, sync auto-creates a
  high-priority "Send post-meeting follow-up email" task on that lead (due 4h after end,
  `source='calendar_automation'`, deduped by `[cal:<eventId>]` tag in the description).
- **Endpoints**: `POST /api/calendar/sync`, `GET /api/calendar/events?from=&to=&oppId=`,
  `PUT /api/calendar/events/:id/link`.

---

## AI Phase 1 — Post-Meeting Follow-Up Emails (added 2026-07-18)

Turn a meeting transcript into a sent, logged follow-up email in under a minute:

1. Calendar automation creates a "Send post-meeting follow-up email" task on the lead after a meeting.
2. Open the task list → the ✨ button appears on open `follow_up`/`email` tasks linked to an opportunity/lead.
3. Click ✨ → paste your meeting transcript or raw notes (+ optional instructions like "keep it short" or "Spanish").
4. **Draft Email** → `POST /api/ai/draft-followup` assembles lead context (opportunity, last 8 comms, company brand, rep name) and returns `{subject, body_html}` — grounded, no invented commitments.
5. Review/edit the draft (To / Subject / rich-text body), then **Send via Gmail** (requires connected Google account; Copy-to-clipboard always available).
6. On send: email logs to the lead's communications timeline (`type=email, direction=out`) and the task auto-completes (checkbox, on by default).

**Pieces:**
- Backend: `POST /api/ai/draft-followup` (src/index.tsx) — requires `transcript`; metered in `ai_usage` as feature `followup_email`; uses the same `_aiCreds` resolution (tenant BYOK → platform master key if tenant AI enabled).
- Frontend: `public/js/ai_followup.js` — 2-step modal (`window.gwAiFollowupOpen({taskId, oppId, oppLabel})`), Gmail send via `window.gwAiGmailSend` (exported from integrations.js), task completion via `window.gwTask.complete`.
- Task rows: ✨ action button in `task_engine.js` `gwRenderTaskRow` for open, non-archived `follow_up`/`email` tasks with a linked opportunity/lead.

## AI Phase 2 — Plans, Quotas & Billing Guardrails (added 2026-07-18)

Platform-key AI usage is now capped by per-tenant monthly plans (BYOK tenants are never capped — their key, their money):

| Plan | Monthly AI actions |
|---|---|
| Starter (default) | 200 |
| Pro | 1,000 |
| Unlimited | no cap |

- **Enforcement**: all three tenant AI endpoints (proposal, quote, follow-up email) call `_aiQuotaGate` — at 100% of cap they return `429 quota_exceeded` with an upgrade message. Custom override: `{companyId}:ai_custom_cap` setting (a number; 0 = uncapped).
- **80% warning / 100% block in the UI**: `GET /api/ai/quota` (tenant-facing) powers a yellow warn strip at 80%+ and a disabled Draft button at 100% in the AI follow-up modal.
- **Platform Settings AI panel**: per-tenant plan dropdown (Starter/Pro/Unlimited) + month-to-date quota bar (teal → amber at 80% → red BLOCKED at 100%). `PUT /api/admin/ai/company/:id` now accepts `{ai_plan, ai_custom_cap}` alongside `ai_enabled`.
- **Avalon default**: `avalon:ai_enabled` is seeded to `1` on first schema run (INSERT OR IGNORE — an explicit owner OFF is respected). Schema flag bumped to `_schema_ai_v2` so prod re-runs the idempotent DDL + seed once.

## AI Phase 3 — Smarter Calendar Automation (added 2026-07-18)

Post-meeting task automation in `POST /api/calendar/sync` is now meeting-type aware:

| Meeting title matches | Task created | Priority |
|---|---|---|
| estimate / quote / bid / proposal | "Send estimate follow-up email" | high |
| site visit / walkthrough / assessment / consult, or booking-page events | "Send post-site-visit follow-up email" | high |
| kickoff / project start / onboard | "Send project kickoff recap email" | high |
| check-in / review / status | "Send check-in recap email" | normal |
| anything else | "Send post-meeting follow-up email" | high |

Each task's description carries a type-specific hint the rep (and the AI drafter) can lean on. **Due dates** moved from "4h after the meeting" to **next business morning 9:00** (skips Sat/Sun) — follow-ups land at the top of the next workday instead of overdue at dinnertime.

## Platform AI — Master Key, Entitlements & Usage Metering (added 2026-07-18)

- **Master key**: the platform owner saves ONE OpenAI key on the platform side (Platform Admin → Platform Settings → "AI — Platform Master Key & Tenant Access"). Stored as `groundwork_platform:openai_api_key` in settings.
- **Key resolution order** (`_aiCreds` in src/index.tsx): tenant BYOK `{companyId}:openai_api_key` → platform master key (only if `{companyId}:ai_enabled = '1'`) → legacy unprefixed key → env `OPENAI_API_KEY`.
- **Entitlements**: per-tenant AI ON/OFF toggles in the same Platform Settings panel (`PUT /api/admin/ai/company/:id`). Tenants without access get a clear "ask your Groundwork rep" error.
- **Metering**: every AI call inserts a row into `ai_usage` (migration 0036, auto-creates in prod via `ensureAiSchema`): company, rep, feature, model, prompt/completion/total tokens, key_source (`platform`/`byok`/`env`). 30-day platform-key usage shows per tenant in the panel; `GET /api/admin/ai/usage?company_id=&days=` returns detail rows for billing.
- **Tenant-side key entry**: companies who bring their own key use Integrations → Admin Setup tab (visible whether or not Google is connected).

## Multi-Day Jobs — Daily AI Checklists + Auto-Published Portal Updates (added 2026-07-20)

Jobs (work orders) can be marked multi-day. Each internal "day" gets an AI-generated end-of-day yes/no checklist; crews must attach a photo to every answer, and completing a day auto-publishes a client portal update composed by Groundwork AI with all the day's photos.

- **Schema**: migration `0045_multiday_jobs.sql` — `work_orders.is_multiday` / `total_days` columns + `wo_days` table (per-day scope, questions JSON, status, `update_id` link to the published portal update). Self-heals in prod via `_schema_multiday_v1` flag (index.tsx) and `_schema_portal_v5` (portal.tsx) — no remote wrangler migration needed.
- **API** (src/index.tsx):
  - `POST /api/work-orders/:id/multiday` — body `{total_days (2-30), start_date?, day_scopes?}`. One AI call generates 3-6 photo-verifiable yes/no questions per day (feature `multiday_questions`); graceful fallback questions when AI unavailable. Re-running setup never overwrites days that are in progress or completed.
  - `GET /api/work-orders/:id/days` — day list with parsed questions.
  - `POST /api/work-orders/:id/days/:n/answer` — `{question_index, answer, photo_media_id}`. Photo is REQUIRED and must exist in `project_media` for that job; questions must be answered strictly in order; completed days reject changes (409).
  - `POST /api/work-orders/:id/days/:n/complete` — rejects if any question unanswered; AI composes the client update title/body (feature `multiday_update`, deterministic fallback); INSERTs a published `project_updates` row, attaches all answered-question photos, marks the day completed, appends a WO timeline event, emails active portal users, and flips the WO to `completed` when the last day finishes.
- **Frontend** (`public/js/multiday.js`, mounted in the visit modal in app_premium.js):
  - Staff: "Multi-Day Job" section in the scheduled-job modal — enable multi-day, set day count + per-day scopes, see per-day progress badges (PENDING / n-of-m ANSWERED / PUBLISHED).
  - Crew: "Start Day" opens a fullscreen popup — one question at a time; the YES/NO buttons stay disabled until a photo is uploaded (camera capture supported); finishing all questions shows a Complete Day screen that triggers the AI publish.
- Photos reuse the Release 1 portal media pipeline (`POST /api/admin/portal/projects/:woId/media`, R2-backed, 15 MB limit).

## Environment variables / secrets

| Variable | Where to set | Purpose |
|----------|-------------|---------|
| `CLOUDFLARE_API_TOKEN` | Shell env / `.dev.vars` | Wrangler auth for local commands |
| `CF_API_TOKEN` | GitHub Actions secret | CI/CD deploy |
| `CF_ACCOUNT_ID` | GitHub Actions secret | CI/CD deploy (value: `9cc88e60ca3b4d57d9f6461fc8100577`) |

Create a `.dev.vars` file (gitignored) for local development:
```
CLOUDFLARE_API_TOKEN=your_token_here
```

---

## npm scripts reference

| Command | What it does |
|---------|-------------|
| `npm run build` | Bump version → Vite build → copy JS → write `_routes.json` |
| `npm run deploy` | Build + deploy to `groundwork-crm` CF Pages project |
| `npm run dev:local` | Serve `dist/` locally with real D1 (local SQLite) on port 3000 |
| `npm run preview` | Serve `dist/` locally without D1 binding |
| `npm run db:migrate:local` | Apply all pending migrations to local SQLite |
| `npm run db:migrate:prod` | Apply all pending migrations to production D1 |

---

## Cloudflare dashboard references

| Resource | URL |
|----------|-----|
| Pages project | https://dash.cloudflare.com → Pages → groundwork-crm |
| D1 database | https://dash.cloudflare.com → D1 → avalon-sales-hub-production |
| Custom domain | groundwork-crm.com (set in Pages → Custom domains) |
| API tokens | https://dash.cloudflare.com/profile/api-tokens |

---

## Key user roles

| Role | Landing page | Nav access |
|------|-------------|-----------|
| `admin` | My Day dashboard | Full |
| `office_manager` | My Day dashboard | Full except Admin |
| `foreman` | Field Dashboard | Operations (Schedule, WOs, Time Tracker) |
| `laborer` | Field Dashboard | Operations (Schedule, WOs, Time Tracker) |
| `field_supervisor` | Field Dashboard | Operations + limited admin |

---

## Languages

The app supports **English (EN)** and **Spanish (ES)**.  
- Toggle is in the sidebar (🌐 Language pill above user avatar)  
- Preference saves to D1 via `PATCH /api/me/language` (per-user — each foreman/laborer keeps their own setting)  
- Translation engine: `public/js/gw_i18n.js` (**v2 — DOM auto-translation**)

### How the v2 engine works
The engine watches the live DOM with a `MutationObserver` and translates every
text node, `placeholder`, `title`, and `aria-label` on the fly — no `_t()`
calls are required in view code. Toggling back to EN restores the exact
original English text.

- **Exact-match dictionary** — `_GW_ES` map in `gw_i18n.js` (nav, dashboards, tasks, pipeline stages, work orders, field mode, AAR, etc.)
- **Pattern rules** — dynamic strings like `Overdue (3)`, `2 due today`, `3d ago`, `43% of annual target`, `Follow up with <name>`
- **Date words** — weekday/month names localize (`MONDAY, JULY 13` → `LUNES, JULIO 13`)

### Adding / fixing a translation
Edit `public/js/gw_i18n.js`:
1. Add the English string as a key to `_GW_ES` with its Spanish value (exact match, trimmed).
2. For strings with numbers/names in them, add a regex row to `_GW_PATTERNS`.
3. Copy the file to keep both copies in sync: `cp public/static/gw_i18n.js public/js/gw_i18n.js` (or vice versa — `/js/` is the one served).
4. `npm run build` + deploy. Untranslated strings simply stay in English (safe fallback).

## Estimate Presentation & Traffic-Light Hold Scheduling (2026-07-17)
- **Customer-facing pricing**: portal/preview line items show only Item → Qty → Total (no rate column, no cost/hours leakage).
- **Internal Pricing Breakdown** (estimate detail): Cost/Rate → Qty/Hr → Budgeted Hours (internal-only, amber-tinted) → Taxes → Total, plus a Budgeted Hours rollup in totals.
- **Flat action bar**: "More ▾" dropdown dissolved — Edit / Email / Preview / Duplicate / Convert to Invoice / Delete all visible.
- **Schedule to Job button**: always prominent. Before client acceptance it places a YELLOW "hold" on the chosen day (`work_orders.status='hold'`); when the client accepts (internal accept, portal approve, or proposal accept) all holds auto-flip GREEN to `scheduled`; decline releases them to `cancelled` (red). Traffic-light dots on schedule board week cards, month dots/chips, mobile cards; Holds counter in the stats bar.

## Onboarding Build-Out (T23)
- **Migration 0040** (`0040_onboarding_buildout.sql`, INSERT OR REPLACE — preserves recorded progress): sales playbook expanded to **17 steps across 4 phases** (Discovery & Demo → Proposal & Close → Account Setup → Launch & Success) with tactical guidance in each description (pre-demo research, 48-hr follow-up, objection handling, Google connect, 1-week check-in, 30-day success review); wizard custom questions refined to **4 fast all-select questions** (heard-about, current tools, #1 pain, data import); Getting Started checklist expanded to **11 items, 9 auto-detecting** (added: branding, first job scheduled, Stripe payments).
- **Auto-detection extended** (`/api/onboarding/checklist`): `branding` (logo_url/brand_color), `work_orders`, `stripe` (connected + onboarded) — all checklist view targets corrected to real app views (settings/pricing/dispatchBoard/integrations/reviews).
- **Demo modal now embeds the Sales Playbook**: opening any demo request shows the full phase-grouped checklist inline with progress bar + %; checkboxes save instantly without leaving the modal.
- **Phase support**: playbook rows in the Onboarding tab group steps under phase headers; sales-step editor modal has a Phase field (with datalist of the 4 standard phases); builder list shows each step's phase.
- **Self-heal**: `_schema_gwops_v4` (0037+0038+0039+0040).
- E2E-verified via Playwright: phase headers render, demo-modal playbook loads 17 steps, toggle round-trips 0/17→1/17, builder shows new items, no page errors.

## Prod Template Seed Fix (T24)
- **Bug**: Template Builder tab rendered blank in production — `gw_onboarding_templates` was empty. The self-heal SQL runner splits statements on `;`, and 0039's template seed contained inline semicolons *inside string literals* (e.g. `'…steps are locked; add custom questions below.'`), which chopped the INSERT mid-statement. Steps survived (0040's INSERT OR REPLACE strings were semicolon-free), so stats showed 17/11 while the builder had no template sections to render.
- **Fix**: replaced 3 inline semicolons in 0039 seed strings with em-dashes; verified all 4 gwops migrations (0037–0040) contain zero semicolons inside string literals; bumped self-heal flag to `_schema_gwops_v5` so prod re-ran the corrected seed (INSERT OR IGNORE — idempotent, preserves any existing data).
- **Rule going forward**: migration files bundled into the self-heal runner must never contain `;` inside string literals — use em-dashes or periods.
- Deployed `cf3288b`; heal triggered and confirmed in prod.

## Onboarding System (T22)
- **Migration 0039** (`0039_onboarding_system.sql`): `gw_onboarding_templates` (types: `sales` | `customer_wizard` | `tenant_checklist`), `gw_onboarding_steps` (JSON `fields` for wizard questions / checklist auto-detect meta), `gw_onboarding_progress` (per demo or company). Seeded: 11-step sales playbook, 6 wizard steps (5 built-in locked + 1 custom-questions), 8-item Getting Started checklist.
- **Platform Admin → Onboarding** (`gwOnboarding`), three tabs:
  - **Sales Playbook** — every active demo request gets the internal demo→live checklist; expandable rows with per-step check-off and progress bars; stat cards for in-flight/not-started.
  - **Template Builder** — edit all three templates: add/edit/delete steps, reorder, activate/deactivate. Wizard custom questions use `Label | text` or `Label | select | Opt1, Opt2` lines. Checklist items configure auto-detect key + target view + CTA label. Built-in wizard steps are locked.
  - **Tenant Funnel** — every tenant with wizard progress (step X/6 or ✓), manual checklist count, and their custom wizard answers (expandable).
- **APIs**: `GET /api/platform/onboarding/templates`, `POST/PUT/DELETE /api/platform/onboarding/steps[/:id]`, `GET/POST /api/platform/onboarding/progress`, `GET /api/platform/onboarding/funnel` (super-admin). Tenant-facing: `GET /api/onboarding/wizard-config`, `POST /api/onboarding/wizard-answers`, `GET /api/onboarding/checklist` (auto-detects clients/price book/estimates/invoices/team/Google), `POST /api/onboarding/checklist/:stepId` (requireAuth).
- **Tenant experience** (`onboarding.js`): platform-defined custom questions render as extra wizard step(s) before the Done screen (answers → `onboarding_responses`, visible in Tenant Funnel); after the wizard, admins get a floating **🚀 Getting Started** launcher (bottom-right) with progress ring and per-item CTAs that auto-checks off as they use the product; session-dismissable; hidden for the platform owner account and once all items complete.
- **Self-heal**: flag bumped to `_schema_gwops_v3` (runs 0037+0038+0039 on first platform/onboarding API call in prod).

## Real Pricing Import (T21)
- **Migration 0038** (`0038_real_pricing_import.sql`): extends `gw_pricing_plans` with per-seat pricing (`tagline`, `seat_rep`, `seat_field`, `seat_office`, `seat_viewonly`, `viewonly_included`, `extra_seats_available`, `is_custom`); creates `gw_ai_packages`; purges placeholder plans; seeds the real Groundwork pricing.
- **CRM Plans** (base = 1 Rep/Estimator seat): Starter $29 (50 AI, no extra seats), Core $49 (100 AI; seats $49/$25/$89, 1 view-only incl then $10), Growth $65 ★Most Popular (250 AI; $65/$30/$105, 3 incl), Pro $85 (500 AI; $85/$35/$135, 5 incl), Enterprise custom.
- **Field-seat volume discounts** (settings key `gw_field_seat_discounts`): 1–5 standard, 6–10 = 10% off, 11+ = 15% off / custom (field seats only).
- **AI Packages** (`gw_ai_packages`): Essentials $12/500, Plus $29/1,500 ★, Max $59/5,000, Custom AI (contact sales), BYOK (no AI charge).
- **AI quota caps** (`AI_PLAN_CAPS`) now match: starter 50 / core 100 / growth 250 / pro 500 / essentials 500 / plus 1500 / max 5000 / enterprise & unlimited uncapped. BYOK never capped; per-company override via `{companyId}:ai_custom_cap`.
- **New API**: `GET/POST/PUT/DELETE /api/platform/ai-packages` (super-admin only). Pricing-plans CRUD accepts the 8 new seat/custom fields.
- **Self-heal**: `ensureGwOpsSchema` flag bumped to `_schema_gwops_v2` and runs migrations 0037+0038, so production picks up the new schema + seed on the first platform/demos/pricing API call after deploy.
- **UI**: Pricing Plans view rebuilt — plan cards with seat-pricing tables & "Starting at $X/mo", Field-Seat Volume Pricing panel, AI package cards (purple theme), stat row (Est. Base MRR). Plan modal now edits tagline/seat prices/view-only included/custom flag; new AI-package modal with full CRUD. Platform Settings AI dropdown grouped: CRM-included / AI packages / Uncapped.

## Platform Admin Remodel (T20 — Phase A)
- **Full-width premium layout**: `shell()` in platform_admin.js no longer caps at 1280px — pages stretch to the window with a gradient hero header band; stat cards (hover lift, gradient accents) and panels (accent-bar titles, row hover) restyled. New CSS section 63 in groundwork-design.css (`gw-pa-shell`, `gw-pa-stat-grid`, `gw-pa-panel`).
- **Demo Requests** (`gwDemos` view + `/api/platform/demos` CRUD + `POST /api/platform/demos/:id/convert` → gw_leads): tracks demos from groundwork-crm.info (status: requested/scheduled/completed/no_show/converted/cancelled).
- **Pricing Plans manager** (`gwPricing` view + `/api/platform/pricing-plans` CRUD): gw_pricing_plans table is now the MRR source of truth (Overview computes MRR from it; falls back to legacy map if empty). Seeded starter $99 / pro $249 / enterprise $499.
- **Public demo intake**: `POST /api/public/demo-request` (no auth; honeypot `website_url` field; 3/email/day rate limit; email+name validation) — wire groundwork-crm.info forms to this. Payload: `{name, email, company?, phone?, message?, source_page?}`.
- **Google Workspace card** in Platform Settings: connect tyler@groundwork-crm.com via existing OAuth flow (`window.gwGoogleOAuthConnect`), status/disconnect wired to `/api/google/status|disconnect`.
- **Schema**: migration 0037 (gw_demos + gw_pricing_plans) with prod self-heal `ensureGwOpsSchema` (`_schema_gwops_v1` flag).

## Groundwork AI Setup Copilot (T26)
- **`public/js/gw_copilot.js`** — gamified onboarding layer on top of the existing wizard + checklist (nothing removed/replaced):
  - **Spotlight guided tours** (10, keyed to Getting Started items `cl_*`): dims the app, navigates to the right view, highlights the exact button with a pulsing green ring, shows step cards with pro tips. `clickToAdvance` steps let the user do the real action; clicking the highlighted target advances the tour. Element finding is resilient (CSS selector → visible-text fallback, polling `waitForEl`).
  - **AI chat panel** (✨ Groundwork AI): context-aware — sends current view + live checklist status to `/api/ai/copilot`; answers how-to questions and returns an optional `tour` id, rendered as a "✨ Show me" button that launches the matching spotlight tour. Suggestion chips; graceful fallback to tours when AI is not enabled.
  - **Celebrations**: confetti on tour finish and on NEW checklist completions (localStorage-tracked delta); 🏆 full-screen "Setup Complete!" moment at 100%; wizard finish now fires confetti + surfaces the Getting Started launcher.
- **`POST /api/ai/copilot`** (src/index.tsx, after checklist POST): reuses `_aiCreds` (BYOK → platform key → env), `_aiQuotaGate`, `_logAiUsage` (feature `copilot`). System prompt encodes real app navigation facts + valid tour ids; returns `{answer, tour|null}` (tour id validated `^cl_[a-z_]+$`).
- **Getting Started panel** (onboarding.js): each undone item now has a green "✨ Show me" tour button above the existing CTA; footer button opens the AI chat. Version `v20260718t26`.
- Script tag added after onboarding.js in index.tsx (`gw_copilot.js?v=20260718t26`).
- E2E-verified: 10 tours registered, cl_client tour navigates + spotlights "+ Add Client" with pulse ring, chat opens with 4 chips, chip launches tour, GS panel shows Show-me/Ask-AI. Deployed `71d77e1`, prod-verified.

## Groundwork AI Assistant + Done-Bug Fix (T30)
- **Done bug fixed** (Getting Started checklist): root cause was an orphaned endpoint — `POST /api/onboarding/checklist/:stepId` existed but NO client ever called it; the GS panel rendered no "Mark done" control, so manual completion was impossible. Fixes:
  - `onboarding.js`: "Mark done" button on every undone item + "Undo" on manually-done items, wired through `window._gwGSPersistDone` (optimistic UI, disabled-while-saving, auto-retry once, server-truth re-render, revert + message on real failure). `_onbFinish` wizard-completion save now retries (2 attempts + delayed background retry) and side effects (confetti, launcher) can no longer block/mask the save.
  - `src/index.tsx` checklist GET: manual marks now ALWAYS count (`done = auto_done || manual_done`) — previously a manual mark on an auto-detected item was silently discarded. Response now includes `auto_done`/`manual_done` per item.
- **Groundwork AI** (`public/js/groundwork_ai.js`, v20260720t30): persistent floating orb bottom-right (56px, brand gradient, sparkle icon, unread high-priority badge, thinking pulse, keyboard/ARIA accessible, z 8500 below tours) + 420px right-side panel with tabs:
  - **Home** — What I see (company/view/pipeline pulse) · What I suggest (top 3 cards) · What I can do (quick actions)
  - **Suggestions** — all recommendation cards (priority chip, "Why it matters" expand, action buttons)
  - **Coach** — manager-level risk signals (invoices, stagnation, stale/estimates) + compounding-habit tips + "Ask the coach"
  - **Setup** — Getting Started checklist lives here now (working Mark done/Undo, Show-me tours); admin-only tab
  - **Chat** — context-aware (`{question, view, oppId}`); renders tour-offer buttons; graceful `no_api_key` state
  - Action dispatcher: `open_lead` → `show('pipeline', id)`, `open_view`, `create_task` (POST /api/tasks, due tomorrow, toast), `draft_email` → `gwAiFollowupOpen`, `start_tour` → `gwCopilot.startTour`. Old `#gwGSLauncher` suppressed when orb present; `window.gwGettingStarted()` routes to orb Setup tab. Platform-account guard uses SERVER-resolved company (context endpoint) so impersonation works.
- **Backend** (src/index.tsx, before demo-request block):
  - `gwAssistSignals(db, companyId, repId, role)` — deterministic signal engine, 7 signals: overdue follow-ups, stale leads (14d), no-next-step, estimates sent/viewed 5d+ unanswered, overdue tasks, overdue invoices (mgr), stage stagnation (mgr). Every query binds server-derived companyId; non-managers get rep-scoped opp/task queries; bind counts trimmed to match placeholders (D1 rejects extras). Cards: `{id,type,priority,title,summary,why,action_kind,action_payload,actions[]}`, high→low, max 10.
  - `GET /api/ai/assistant/context` — no-LLM snapshot `{company, company_id, business_type, role, ai_enabled, pipeline{open,value}, setup_total, recommendations}` — Suggestions/Coach/Home work with zero AI key.
  - `POST /api/ai/assistant` — context-aware chat; oppId tenant-ownership validated before lead + last-6-comms context is included; deterministic signals embedded in prompt; `_aiCreds`/`_aiQuotaGate`/`_logAiUsage` (feature `assistant`); `{answer, tour}` with fence-strip + `^cl_[a-z_]+$` validation.
- E2E-verified (Playwright, impersonated avalon): orb mounts + persists across views, 10 real recommendation cards, Done click persists server-side AND across full refresh, undo works, quick action navigates + closes panel, gwGettingStarted opens Setup tab, Escape closes, zero page errors. Tenant safety spot-checked (foreign oppId ignored; empty-tenant context clean).

## Groundwork AI Follow-Ups (T31)
- **Server-side snooze**: `POST /api/ai/assistant/snooze` `{recId, days?|clear}` — per-rep, per-company map in settings key `gwai_snooze_<companyId>_<repId>` (expired entries pruned on read, 1-90 day clamp, recId format-validated). Context endpoint filters snoozed recs and returns `snoozed` count. Each suggestion card has a "Snooze 7d" link (fade-out + toast + server persist + revert on failure).
- **Tunable thresholds**: `GW_ASSIST_DEFAULTS` (fu_high_days 7, stale_days 14, stale_high_value 5000, est_days 5, est_high_total 3000, inv_high_owed 2000, stag_days 21, stag_min_deals 3) with per-company JSON override in settings key `gwai_thresholds_<companyId>` — tune without redeploy. Numeric-validated; stagnation title derives weeks from the setting.
- **Mobile/field positioning**: at <=768px the orb lifts to `bottom:calc(82px + safe-area)` (clear of `#gw-mobile-nav` 68px bar) and shrinks to 50px; toasts lift to 150px on mobile.
- **Public demo-request page**: `GET /demo-request` — branded standalone form (name/email required, company/phone/message optional, honeypot `website_url`, client+server validation, success state). `?embed=1` strips chrome for iframe embedding on groundwork-crm.info. Posts to existing `/api/public/demo-request` (rate limit 3/email/day intact).
- Verified: snooze persist/clear/injection-guard via curl + Playwright (card count 10→9, server context confirms, cleanup restores); threshold override (stale_days=9999 → 0 stale recs) applied and reverted; demo page 200 + live submit 200 (test row deleted); full T30 E2E regression suite still ALL PASSED.

## Client Portal Release 1 (T36 — Sessions A/B/C, 2026-07-19/20)

Client-facing portal at `/portal/*` with a fully separate auth world from staff sessions.

- **Session A — Foundation**: portal user identity (`portal_users`, `portal_memberships`, `property_access`, `portal_sessions` via migrations 0041/0042), invite/accept/login/reset lifecycle, role presets (account_admin, billing, project, approver, read_only), staff admin UI (Portal Admin) for inviting/managing portal users, full audit trail (`actor_type='portal'`).
- **Session B — Core Records**: estimates review/approve/decline (approve flips work-order holds to scheduled + notifies staff), billing (invoices with payments, payment history, Pay link), documents (proposals). Property-level scoping via `propOk`, explicit column allowlists.
- **Session C — Projects**: work-order-backed project tracking (`portal_visible` flag, phase mapping scheduled/in_progress/completed), staff-published daily updates (`project_updates`), R2-backed photo galleries (`project_media`, bucket `groundwork-crm-media`, binding `MEDIA`). Staff publish updates + upload photos from the schedule-board visit modal or work order detail page; clients see a timeline with lightbox galleries. Migration 0043 (applied in prod via runtime schema self-heal v3 — wrangler remote D1 apply is blocked by token permissions).

- **Session D — Hardening**: D1-backed sliding-window rate limits on login/reset/accept-invite (fail-open), 7-day idle session timeout + 30-day absolute + 10-session cap per user, password change revokes other sessions, security headers on portal pages (X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy) and no-store on portal APIs, client email notifications on daily-update publish (with staff opt-out checkbox), Active Projects dashboard card, mobile CSS pass (safe-area tabbar, scrollable line-item tables, sub-640px tuning).

Key routes: `/portal/login`, `/portal/home` (SPA: Home/Projects/Estimates/Billing/Documents/Account), portal APIs under `/api/portal/*`, staff admin APIs under `/api/admin/portal/*`.

## Client Portal Release 2 — Payments, Autopay & Contacts (T36, 2026-07-20)

Builds on the existing Stripe Connect integration (platform-level Stripe Customer per client in `clients.stripe_customer_id`, off-session PaymentIntents with `transfer_data[destination]` routing to the connected account, hosted Checkout on the connected account for card-not-on-file payments).

- **Payment methods** (`manage_payment_methods`): Billing tab "Payment Methods" — list saved cards/ACH, add via Stripe Checkout setup mode (redirect + `?pm_added=1` return), remove (detach with customer-ownership check; disables autopay if it pointed at the removed method). APIs: `GET/POST(setup)/DELETE /api/portal/payment-methods*`.
- **Autopay** (`manage_autopay`): per-client config in new `client_autopay` table (enabled, chosen saved method, optional per-invoice cap). When staff sends an invoice (`POST /api/invoices/:id/send`), the open balance is charged automatically to the client's chosen method (best-effort, never blocks the send; respects the cap; response includes an `autopay` result object). Staff gets an in-app notification when clients change autopay.
- **Deposits & invoice payments from the portal** (`make_payments`): estimate detail shows a deposit pay box for approved estimates with an unpaid deposit — pay with a saved method (immediate off-session charge) or by card via hosted Checkout (return handled by `verify-deposit`, which validates the Checkout session's PaymentIntent metadata against the estimate before marking `deposit_paid`). Invoice detail also offers "Pay with a saved method" alongside the existing hosted pay link. Payment attempts are rate-limited (10/10min per user). All successes write to `payments`, update estimate/invoice state, audit log, and notify staff.
- **Contact management** (`manage_contacts`): Account view "Contacts" card — list/add/edit/remove (soft-delete) `client_contacts` rows scoped to manageable clients only. Contacts linked to an active portal login cannot be removed from the portal.
- **Migration 0044** (`clients.stripe_customer_id` + `client_autopay`) ships via the runtime schema self-heal, flag bumped to `_schema_portal_v4` (wrangler remote D1 apply remains blocked by token permissions).
- Everything degrades gracefully when `STRIPE_SECRET_KEY` is absent or the company is not Stripe-connected (503 / "not available" — no crashes).

## Company Customization (July 2026)
- **Custom Divisions**: Companies name and create any number of divisions (Settings > System Config > Divisions, with color pickers). All dashboards, pipeline analytics, financial planning, month drill-downs, CSV import/export and filters are driven by the configured divisions. Renaming preserves historical data; legacy Avalon data classifies via keyword bridges.
- **Custom Lead Intake Form**: Categories (with optional `Value | Short` labels), work types, lead sources and service lines are editable in Settings > System Config > Lead Intake Form. The new-lead and edit-lead forms render from this config.
- **Storage**: D1 settings keys `company_divisions` and `company_intake_config`, hydrated to localStorage (`gwCompanyDivisions` / `gwIntakeConfig`) at login.
- **Onboarding (9 steps)**: Welcome > Business Profile (incl. logo upload) > Name Your Divisions > Lead Intake Setup > First Client > First Estimate > Team Setup > Preferences (commission opt-in, email signature, Google Workspace connect) > Done.
- **Legacy Work Order Detail page retired**: every job click routes to the Schedule board and opens the visit modal (single source of truth for job details).

## Versioned Sales Process Platform (July 2026)

Full versioned, migration-safe sales process engine replacing the legacy fixed pipeline labels. Shipped across migrations `0046`–`0052` and the July 2026 sales-process continuation (PR #19 lineage, merged to main).

### Concepts
- **Immutable global template catalog**: 5 curated templates owned by `company_id='__global__'` (`tpl_groundwork_field_service_v2`, `tpl_design_build_v1`, `tpl_maintenance_v1`, `tpl_fast_turn_v1`, `tpl_commercial_bid_v1`). The template list endpoint returns only the latest version per template; superseded graphless versions (e.g. groundwork v1) are hidden and adoption of them is rejected with 409.
- **Copy-on-adopt**: adopting a template deep-copies stages, outcomes, internal statuses, requirements, guides, resources, automations, transition paths and academy associations into a tenant-owned draft with fresh IDs and remapped relationships.
- **Optimistic concurrency**: drafts carry `content_revision`; stale writes are rejected.
- **Migration review**: proposing a migration builds a mapping batch for every open opportunity (approved legacy mappings auto-approve; ambiguous/conflicting ones require per-opportunity review with `final_stage_id` and optional `final_outcome_type`).
- **Snapshots + approval + readiness gates**: a publication requires an approved snapshot of the migration batch and a passing publication-readiness check (validation, no pending mappings, no snapshot drift, no stale mappings).
- **Atomic publish + rollback (full pipeline cutover)**: publish flips the prior published version to superseded, writes `sales_stage_assignments`, sets `opportunities.sales_process_stage_id` and history in one batch. Publish is also a real cutover of the legacy pipeline: it writes the published stage labels into the `{companyId}:pipeline_stages` setting (board columns change immediately), moves every mapped opportunity's `status`/`pipeline_stage` text to its new stage label, and captures the prior setting (`impact_json.previous_pipeline_stages`, `null` if it did not exist) plus each opportunity's prior labels (history `event_json.previous_status`/`previous_pipeline_stage`). Rollback restores the setting exactly (deleting it if it was absent) and every opportunity's prior labels alongside the snapshot restore. New leads default to the first label of the live `pipeline_stages` setting, and legacy status writes (board drag-and-drop, lead form, record edits) keep the published stable assignment in sync via `syncPublishedStageAssignment` (classification `status_synced`); unknown labels leave the assignment untouched so Needs Restaging semantics are preserved. `gw_leads` is never read or written by any of this.

### API lifecycle (all under `/api/sales-process`, admin session required)
`POST /drafts/from-template` (or `POST /drafts/from-current-pipeline` to import the live board's stage labels as a validation-complete draft with inferred semantics, guaranteed intake/won/lost stages and an open transition graph) -> `POST /versions/:id/validate` -> `POST /migration/propose` -> `PUT /migration/:batchId/:oppId` -> `POST /versions/:id/snapshots` -> `POST /snapshots/:id/approve` -> `GET /versions/:id/publication-readiness?migration_batch_id=X` -> `POST /versions/:id/publish {confirm:true, migration_batch_id}` -> optional `POST /publications/:id/rollback {confirm:true}`.

### Live editing of the published process (August 2026)
Admins can edit the live process directly without a draft/publish cycle:
- `PUT /live/:versionId/stages` — rename, reorder, add, or archive stages on the published version. Applies immediately: the `{companyId}:pipeline_stages` setting is rewritten (board columns follow) and every lead in a renamed stage carries the new `status`/`pipeline_stage` label (keyed by `sales_process_stage_id`, so assignments stay stable). New active stages are wired into the transition graph; new terminal stages get an outcome. Non-closing stages holding leads cannot be deleted or archived (409 with guidance to move leads on the board or start a draft). Closing stages CAN be split live: archive the closing stage and add active stages typed won/lost (and so on) — each lead moves to the stage matching its assignment `outcome_type` (preference chains: won->terminal, lost->terminal, disqualified->lost->terminal, nurture->terminal->lost); if any outcome has no home the save is rejected 409. The response includes `redistributed_leads`. Guarded by `content_revision` optimistic concurrency.
- `PUT /live/:versionId/components/:component` — live edits for internal statuses, qualification fields, call guides, automations, email templates, and Academy associations. Transitions and outcomes remain draft-only.
Structural restructures (mass lead moves, removing occupied stages) still use the full draft -> lead review -> publish flow. Draft endpoints continue to return 404 for published versions.

### Frontend
- **Sales Process Builder** view in `public/js/app_premium.js`, surfaced as the second Sales workspace tab ("Sales Process") plus an admin-only "Customize Stages" shortcut on the Pipeline board header. Start screen offers "Use my current pipeline" (imports live stage labels via `POST /api/sales-process/drafts/from-current-pipeline`) or a Groundwork template. Drafts use a 3-step wizard (Design Stages / Move Your Leads / Go Live); published processes show a 2-step layout (Edit Stages / History & Rollback) with live editing enabled — stage and component saves route to the `/live/` endpoints and refresh `window._gwPipelineStages` from the response. Stage editing uses labeled cards (name, friendly stage type, typical days, milestone, entry/exit guidance, status) with per-panel directions. Advanced tools dropdown covers overview, internal statuses, qualification fields, call guides, automations, email templates and Academy (the former Checklists and AI Assistant pages were removed). Post-publish the client refreshes `window._gwPipelineStages` from the publish response; post-rollback it re-fetches `DB.pipelineStages.list()`.
- Shared stage resolver `public/js/sales-process.js` (browser) mirrors the canonical server resolver `resolveSalesOpportunityStage` in `src/index.tsx`. Record pages use the StageTracker conversion.

### Tests (39 total across 7 suites)
`npm run test:migrations` (needs the `sqlite3` CLI), `node --test tests/sales-process-platform.test.mjs tests/sales-process-safety.test.mjs` (platform + safety), `npm run test:sales-process-ui` (linkedom DOM proof), plus 3 Miniflare integration suites: `npm run test:sales-process-transitions`, `test:sales-process-adoption`, `test:migration-review` (these `vite build` first and import `dist/_worker.js`).

### Deliberate human gate
Publishing a sales process for a live tenant (including Avalon) is intentionally NOT automatable: an authenticated admin must adopt, review mappings, approve the snapshot and publish through the Sales Process Builder UI in production. See `docs/sales-process-completion-matrix.md` and `docs/sales-process-dependency-inventory.md`.

### Groundwork AI close likelihood + time-in-stage (August 2026)
The pipeline's follow-up signal is time-in-stage, not the old next-follow-up "OVERDUE" badge, and every open lead carries a running 0-100% close-likelihood score:
- **Time-in-stage clock** (`gwStageClock` in `public/js/app_premium.js`): days since the lead entered its current stage (from `sales_stage_assignments.assigned_at`, exposed as `sales_process_assigned_at` on `GET /api/opportunities` and mapped to `stageEnteredAt`) compared to the stage's `expected_duration_days`. Bands: `ok` (< expected), `watch` (1-1.75x), `late` (>= 1.75x, "follow up"). Cards show a "Nd in stage" chip; the board's "Needs Follow-Up" stat card and `overdue` quick-filter use the `late` band; the mini-row dot escalates by band.
- **Groundwork AI score** (`gwLeadScore`): deterministic heuristic recomputed live on every render. Hard pins: won = 100%, lost/disqualified = 0%. Open leads: baseline from stage progression (15% intake to 85% closing) adjusted by six transparent factors — time sitting in the current stage vs expected, velocity through the process so far (created-at vs cumulative expected durations), lead source quality (existing client +12, referral +10, website +3, cold -6), budget vs estimate fit (parses free-text `budget_range` against `estimate_amount`/`job_value`), estimate momentum (accepted +18 ... declined -18, sourced from the linked estimates table via `linked_estimate_status`), and engagement recency. Clamped 3-97 so only real outcomes reach the poles. Every factor is listed with its +/- contribution in the pill tooltip and in the "Groundwork AI" card at the top of the lead detail right rail (score, meter, clock line, factor breakdown).
- **Prioritization**: the Pipeline sort defaults to "Priority" (score descending); "Sitting Longest" sorts by stage-clock ratio. Lead detail hero shows "Close Likelihood" and "In Stage" stat chips.

## AI Lead Import + Commercial Multi-Property Accounts (August 2026)

Fast lead creation from raw email text, with first-class support for commercial property-manager accounts (one point of contact, many properties/bids underneath).

- **Entry points**: "+New" menu -> "AI Lead Import" (admin/sales), and the Add Lead page hero's "Import from Email (AI)" button. Both open `window._gwAiLeadImport()` in `public/js/app_premium.js`.
- **Step 1 — drop box**: paste any email text into the textarea or drag/drop a downloaded `.eml` / `.txt` file (read client-side via FileReader, capped at 60k chars). "Read with Groundwork AI" posts to the backend.
- **Backend**: `POST /api/ai/parse-lead` (src/index.tsx, session required) — `_aiCreds` -> `_aiQuotaGate` -> `_aiChatJson` (raw fetch Response; check `r.ok` then `r.json()`) -> `_logAiUsage(..., 'lead_import', ...)` -> `_aiParseJson`. The prompt extracts the prospective contact (never the recipient), company, phone (cell preferred), email, `client_type` (Commercial for property-management firms), EVERY property address with its site-specific notes (max 25), `contract_hint` (annual | multi_year | one_time | unknown), urgency/meeting plan, and a summary note. Returns sanitized JSON only.
- **Step 2 — preview**: editable contact fields, rep assignment, client type; a "Multi-property account — 1 contact, N sites" badge with the contract hint; per-property checkbox rows (label, address, site notes all editable); urgency callout and summary preview. Button reads "Create Account + N Property Leads" when multiple sites are checked.
- **Create**: one Commercial client record (found by name match in `loadClients()` or created — tagged `Multi-Property` when N>1, AI summary stored in `notes` since D1 `clients` persists base columns only; the `properties` array lives in the client payload/localStorage) plus **one lead per checked property**, each named `Contact — Site label`, linked via `clientId`, `source:'Email'`, `leadSource:'company_lead'`, first pipeline stage, its own value/bid, and an auto-note combining the AI summary with the site notes (persisted via `_d1SaveNote`). Multi-property lands on the Pipeline; single property opens the new lead.
- **Why one-lead-per-property**: each site carries its own bid, value, stage and commission math independently, while the client record shows the whole portfolio (client page already lists linked leads via `clientId`).
- Validated end-to-end against a real commercial email (3 properties + per-site notes extracted correctly, ~8s, ~1.3k tokens).

## Client Portfolio (Client Detail Page)
Each client page now shows the full portfolio:
- **Leads & Opportunities**: every lead grouped Open / Won / Lost-Archived, linked via the new `opportunities.client_id` column (with name/prefix-match self-heal for older leads), plus open pipeline value chip.
- **Financials tabs**: Estimates, Invoices (balance-due highlighted), Payments (with invoice number), filtered per client via `GET /api/estimates?client_id=`, `GET /api/invoices?client_id=`, and the new `GET /api/payments?client_id=`.
- **Outstanding balance** stat (sum of unpaid invoice balances).
- **Site Photos** grid from project media (`GET /api/customers/:id/media`).
- **Recurring & Projections**: active subscriptions plus revenue projection card (monthly run rate, 12-month, 3-year).
- **Extended contact card**: office phone, CC emails, mailing address vs service address, main POC, billing contact, site contact, payment method — all editable in the client form and persisted in `clients.extra` JSON (see `CLIENT_EXTRA_FIELDS` in src/index.tsx).
- Migration `0055_client_portfolio.sql` adds `opportunities.client_id`, `clients.extra`, and fixes `recurring_plans` drift (`frequency_unit`, `visit_duration_minutes`, `services_included` — previously every recurring-subscriptions request returned 500). Self-heals in prod via `ensurePortfolioSchema`.

### Client Page Inline Editing & Quick Create (update)
- Contact Info is now edited directly in place (lead-style): click any field, type, and it autosaves — no separate Edit modal.
- Green create buttons under each section: Schedule Job, New Lead (creates the lead with client info prefilled and opens the lead view), New Estimate / New Invoice (builders prefilled with the client), Record Payment (picks from open invoices), Add Property, Upload Photos (direct client photo upload via `POST /api/customers/:id/photos`).

## My Day — Curated Mode, Pipeline Chart & "+N More" Capping (added 2026-08-03)

My Day gained a new default layout ("My Day" / `curated` mode) designed for
owner-operators who want a calm, glanceable start to the day instead of a
long scrolling dashboard — plus a real-data Pipeline chart widget and a
consistent overflow pattern so widget cards never grow or scroll.

- **New `curated` day-mode** (`_GW_MYDAY_MODES` in `public/js/app_premium.js`)
  sits alongside the existing Field/Office/Sales/Focus presets and the
  bespoke "My Layout" (custom) mode. It surfaces Pipeline Snapshot, Today's
  Jobs, My Tasks, My Calendar, and the new Pipeline Chart in a fixed
  2-up grid.
- **Default for first-time users only** — `_gwMyDayGetMode()` now defaults
  anyone with **no saved mode AND no saved custom layout** into `curated`.
  Anyone who has ever customized My Day (a `gw-myday-layout-*` key already
  exists in their browser) keeps landing on their own layout exactly as
  before — this only changes the experience for brand-new / never-touched
  accounts. Verified live: an account with a pre-existing saved layout
  resolves to `custom` and is unaffected; a fresh account resolves to
  `curated`.
- **Pipeline Chart widget** (`pipeChart`, `_pipeChartHtml`) — sparkline of
  real pipeline value over the last 4 weeks (bucketed from each open lead's
  `closedDate`/`updatedAt`/`createdAt`), a stage-breakdown bar + legend from
  real `status` grouping, and a won-MTD figure. No fabricated data: the
  week-over-week trend badge only renders when there's a real prior-week
  baseline to compare against.
- **"+N more" capping pattern** — replaces scrollbars/growing cards on the
  three list-style widgets (My Tasks, Today's Jobs, My Calendar). Each
  widget caps its visible rows to the active mode's per-widget limit
  (`_GW_MYDAY_DEFAULT_CAPS` / each mode's own `caps`, e.g. curated =
  `{jobsToday:4, tasks:4, calendar:4}`), collapsing the remainder into a
  "N more — view all" link that expands the same card in place (no
  separate filtered list page exists for any of the three, so in-place
  expand is the real destination, not a placeholder). Each widget tracks
  its own expand flag (`window._gwMyDayTasksExpanded` /
  `_gwMyDayJobsExpanded` / `_gwMyDayCalExpanded`) so expanding one never
  affects the others. My Tasks caps in priority order (overdue → due today
  → upcoming → no date); Today's Jobs and My Calendar cap today's items
  first, then upcoming/all-day.
- **Shared caps handoff**: caps for the active mode are resolved once per
  render at the top of `_gwTodayRender()` and published to
  `window._gwMyDayCaps` so the async/mount-based Jobs and Calendar widgets
  (and the async task-reload callback) read the same values as the
  synchronous My Tasks render.
- **CSS**: new `.w-fixed-h` / `.list-cap` / `.more-link` / `.gw-pipe-chart`
  + `.pipe-*` classes live in `public/js/premium.css` (the real served
  stylesheet — see the note above about `public/static/` being unused).
- **Verified** via a live login + screenshot pass (Playwright): curated
  mode auto-applies for a no-history account, the Pipeline chart renders
  correct real D1-derived figures, and both My Tasks and Today's Jobs
  correctly cap at 4 visible rows with an accurate hidden count once
  seeded past the cap — including a full expand → "Show less" → re-collapse
  round trip.
- **Known verification gap**: the My Calendar widget's capping code path
  mirrors the same pattern as Tasks/Jobs but could not be exercised live in
  this sandbox — it only renders once a real Google Calendar OAuth
  connection exists (`isGoogleConnected()` + server-side
  `GET /api/google/status`), which isn't available in this dev environment.
  Recommended follow-up: verify with a real connected Google account, or
  add a small D1-seeding test harness against the `calendar_events` table.
