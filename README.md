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

## Command Center Rename + Nav Consolidation + Masonry Grid Bug Fixes (2026-08-03)

Follow-up to the entry above. Two threads, done together per explicit
request: (1) consolidate My Day + the 3 separate report pages into one
"Command Center" hub with drill-down links, and (2) fix a "blank spaces /
missing widgets" layout bug reported live in production.

**IA consolidation — Command Center:**
- Renamed the `curated` My Day mode (and all page titles/headers/toasts) from
  "My Day" to **"Command Center"** — same underlying `today` route, no
  routing changes, only display labels.
- Removed `salesReports` (Business Pulse) / `financialReports` (Financial
  Snapshot) / `opsReports` (Operations Snapshot) as **top-level Dashboard
  nav tabs** — they had confirmed real data overlap with My Day's own
  widgets (pipeline funnel, budget vs actual, work orders), which is what
  produced the "same 3-4 pages, messy" feeling reported by the user. The
  three pages/routes/functions themselves are fully intact and unchanged —
  only removed from the top-level tab list in all 4 places it was defined
  (`gwDashboard()`, `_gwApplyFieldNavFilters()`, `_gwInitAllPanels()`,
  `_wsTabDefs.Dashboard`).
- Added contextual **"Full report" drill-down buttons** instead: Pipeline
  Chart widget → Business Pulse, Today's Jobs widget → Operations Snapshot,
  Financial Pulse's existing "Full View" button → Financial Snapshot.
- Added a **"Command Center ›" breadcrumb back-link** to all 3 detail pages'
  header eyebrows so users can return to the hub in one click.

**Masonry grid bug fixes (root cause: `!important` beats inline styles):**
The live "blank spaces, no blocks where there should be" symptom traced to
three separate CSS bugs in `public/js/premium.css`, all variants of the same
mistake — an `!important` CSS rule always wins over an inline `style="..."`
regardless of selector specificity, and the My Day layout engine
(`_gwMyDayMasonry()` in `app_premium.js`) depends entirely on being able to
set each widget's real height via inline `style="grid-row:span N"`:
1. Three competing `.gw-myday-grid` rule blocks fought over
   `grid-auto-rows`/`grid-auto-flow`/`gap` — the last `!important` block won
   and forced `grid-auto-rows:auto` + `grid-auto-flow:row`, breaking the
   masonry engine's 4px fine-grained row assumption and causing large dead
   vertical gaps. Consolidated into one base rule.
2. `.gw-myday-widget { grid-row: auto !important; }` silently nullified
   every widget's JS-computed row span, and widget-id-specific
   `grid-column: span N !important;` rules (for `tasks`, `recent`,
   `staleLeads`, `recentWins`, `calendar`, `pipeStrip`, `activity`,
   `reviews`) nullified each day-mode's configured column span — this is
   what caused My Tasks to render at a hardcoded span 4 and visually overlap
   the Pipeline Chart widget instead of curated mode's configured span 2.
   Fixed by dropping `!important` from both (kept the mobile `≤768px`
   breakpoint override, which correctly still uses `!important` since the
   masonry JS intentionally bails out below that width).
3. The masonry measurement function itself (`_gwMyDayMasonry()`) measured
   the outer `.gw-myday-widget` wrapper's `getBoundingClientRect().height`
   after resetting its `grid-row` to `auto` — but the grid's
   `align-items:stretch` plus the fixed `grid-auto-rows:4px` track meant the
   wrapper always measured ~4px regardless of real content, so every widget
   got the same fallback span and taller content (e.g. Pipeline Snapshot's
   stat values, Financial Pulse tiles) was visually clipped. Fixed by
   measuring `.gw-myday-widget-body.scrollHeight` (the content-sized child,
   unaffected by grid stretching) instead, while still resetting the
   wrapper's `grid-row` to `auto` first each pass — omitting that reset
   caused a second bug, a runaway growth feedback loop, since the body's
   `min-height:100%` (of the wrapper) would otherwise inflate on every
   `ResizeObserver` tick.
- **Verified** via Playwright (login + live D1 data) across all 5 day-modes
  (`curated`/`field`/`office`/`sales`/`focus`): zero widget overlaps, zero
  clipped content, stable widget heights across repeated 2s/5s/10s
  re-measurements (no growth-loop regression), and tight masonry packing
  with no dead vertical gaps.
- **Not done in this pass**: the deeper visual "hub" redesign the user also
  asked for (hero KPI styling / zone grouping to feel more like a true
  command-center dashboard rather than a grid of small widgets) — the IA
  consolidation and both rounds of grid bug fixes above were prioritized
  first since they were reported as active defects. Recommended follow-up.

## Visual Hub Pass: Hero KPI Band + Zone-Grouped Command Center (2026-08-03)

Follow-up to the entry above, delivering the "recommended follow-up" flagged
there. Two parts, both requested together: (a) elevate the Pipeline Snapshot
stat strip into a true hero KPI band, and (b) group Command Center's widgets
into visually distinct zones so the page reads as a hub of the underlying
report pages rather than a flat pile of same-weight widgets.

**(a) Hero KPI band:**
- Redesigned the Pipeline Snapshot strip (Open Leads / Proposals Out /
  Pipeline Value / Won MTD) from a plain bordered-divider stat row into
  icon-chip cards, each with its own color accent (sky/amber/pine/emerald)
  and an inline SVG icon (via `gwIcon()`) on a colored chip background.
- Renders full-width, standalone, above all zone sections (see below) — it's
  a compact KPI strip, not a masonry-packed card.

**(b) Zone-grouped layout:**
- Added a `zone` tag (`hero`/`sales`/`financial`/`operations`/`personal`) to
  every widget in `_GW_MYDAY_WIDGETS`, plus a `_GW_MYDAY_ZONES` config
  (label, icon, accent color, and — where one exists — the report route to
  drill into) for `sales` → Business Pulse, `financial` → Financial
  Snapshot, `operations` → Operations Snapshot, and a `personal` "My Work"
  zone with no report link.
- Command Center's **preset day-modes** (curated/field/office/sales/focus),
  in view mode, now render widgets grouped under titled
  `<section class="gw-myday-zone">` blocks — colored header border, icon
  chip, and (for zones with a report) a "Full report ›" button that
  navigates straight to the matching report page.
- The custom **"My Layout"** mode and **edit mode** are both intentionally
  untouched — they keep the original flat single-grid layout exactly as
  before, so drag-and-drop reordering (which assumes one grid) needed no
  changes.
- The masonry engine (`_gwMyDayMasonry()`) was rewritten to pack **every**
  `.gw-myday-grid` on the page (one per zone) via `querySelectorAll`
  instead of assuming a single global grid, while preserving the exact
  reset-before-measure sequence from the prior bug fix (see entry above) so
  the previously-fixed runaway-growth-loop bug does not recur per-grid.
- **Verified** via Playwright (login + live D1 data): zero widget overlaps
  and zero clipped content across curated/office/sales/field/focus + custom
  + edit mode; zero widget-height growth across repeated timepoints in a
  mode with async widgets (finance/AR snapshot); correct drill-down
  navigation from a zone's "Full report" button; and confirmed the separate
  mobile renderer (`_gwTodayRenderMobile()`, ≤768px) is completely
  unaffected by all of the above (fresh page load at 400px shows zero
  zones, original mobile header layout intact).
- **Known verification gap**: the intermediate `900px`/`1100px` CSS
  breakpoints for `.gw-myday-grid` were not explicitly screenshot-tested
  against the new per-zone multi-grid structure (only full desktop width
  and mobile were). Low risk since those overrides are class-based and
  apply per-grid automatically, but not visually re-confirmed.

## Command Center Rebuild: Single Canonical Layout, Report Pages Retired (2026-08-03)

Full rebuild of Command Center per direct user sign-off ("go with your
recommendations and implement the full thing now"), replacing the
preset-day-mode / edit-mode / drag-and-drop system from the entries above
with **one canonical layout for everyone**.

**Layout:**
- Header simplified to: title, date/rep line, single **"+ Add Widget"**
  button. No modes, no edit-mode toggle, no day-mode picker.
- Hero band gained a **5th chip — Avg Close Likelihood**, computed via
  `gwLeadScore()`, alongside the existing Open Leads / Proposals Out /
  Pipeline Value / Won MTD chips. New `.gw-today-pipe-strip--five` CSS grid
  (5 cols desktop → 3 at ≤900px → 2 at ≤680px) plus a rose color variant for
  the low-score band.
- Zones unchanged in concept (Sales & Pipeline / Financial / Operations /
  My Work) but every widget now renders at a **fixed span from a single
  registry** (`_GW_MYDAY_WIDGETS`) — no per-mode spans/heights/order,
  reordering is not supported (drag-and-drop cut entirely).
- **Needs Follow-Up** upgraded to sort by `gwStageClock()`'s "late" urgency
  band (stage-relative overdue, not just calendar age) and is a **default**
  Sales & Pipeline widget.
- **Rep Leaderboard** (new) and **Budget vs Actual** (new) are
  **Add-Widget-only** — hidden by default, role-gated (admin/office_manager
  for Rep Leaderboard), surfaced only via the picker.
- Deep content that used to live on the report pages now expands **in
  place via accordion** instead of a modal/page: Pipeline Chart's "View
  trend" and Money Owed's "Aging" both toggle a `.gw-accordion-body` with a
  chevron rotation and a short reveal animation
  (`window.gwMyDayAccordionToggle(id)`).
- Operations zone gained an Add-Widget-only "Upcoming Schedule (7 Days)"
  deeper-content widget (`opsDeeper`).

**Customization model — replaced entirely:**
- No presets, no modes, no edit-mode banner/state.
- **"+ Add Widget"** opens a popover (`_gwMyDayAddWidgetPopover`) listing
  every widget allowed for the current role with an Add/Remove toggle.
- Each on-screen widget gets a small **hover-only "×"** in its top-right
  corner (`.gw-myday-widget-remove`, opacity 0→1 on `:hover`) to remove it
  — same popover to re-add.
- Drag-and-drop, resize grips, and all related CSS/state (`.gw-myday-grip--*`,
  `.gw-myday-resizing`, `.gw-myday-drop-target`, `.gw-myday-dragging`, the
  old edit-mode banner/bar/name/wiggle-animation classes) removed.

**Report pages deleted outright:**
- `salesReports()`, `financialReports()`, `opsReports()` and every line of
  wiring that referenced them are gone — nav-permission arrays (admin /
  office_manager / division_manager / foreman / field_supervisor, in both
  `app_premium.js` and `user_management.js` and both `defaultNavPerms`
  blocks in `src/index.tsx`), `_VIEW_WORKSPACE_MAP`, `_wsHeaderMap`,
  `_viewLabels`, `dashAliases`, the `p7Route` dispatch table, the
  `gwDashboard()` tab fallthrough, and the `GW_VIEWS` registry in
  `platform_core.js`. Their content now lives inline as Command Center
  widgets (with accordion-expand for anything that was "deep").
- Copy cleanup: "Business Pulse" / "Financial Snapshot" / "Operations
  Snapshot" removed from labels, tooltips, and Spanish i18n
  (`gw_i18n.js`); added a `'Command Center': 'Centro de Comando'` entry.

**Nav:**
- Dashboard's collapsible workspace-group (chevron + subtabs) replaced with
  a single top-level **"Command Center"** nav button (`show('today')`) in
  `src/index.tsx`. Verified backward-compatible — `activateNav()` and
  `_gwApplyFieldNavFilters()` both null-guard on the now-absent subtabs
  container.

**Density pass:**
- `.gw-myday-grid` column-gap tightened 28px → 18px to match the JS `GAP`
  constant; tighter CSS `minmax()` widths throughout.

**Incidental fixes found and fixed along the way (unrelated to this
rebuild, pre-existing corruption from earlier sessions):**
- Four separate syntax/logic corruptions in `app_premium.js` (a stray dead
  `const objective : '';` statement, a mangled CSV-export filename line, a
  corrupted save-button template string, and ~13 lines of garbled
  duplicated trailing fragments at EOF) and one in `user_management.js` (a
  duplicated/mangled role-change audit block) — all found via iterative
  `node -c` syntax-check passes and fixed; `node -c` is clean on all four
  touched JS files.
- A **critical** bug in `src/index.tsx`: an entire ~39-tag block of
  `<script src="...">` elements was duplicated verbatim, causing every
  script's top-level `const`/`let`/`var` declarations to execute twice →
  20 distinct "Identifier X has already been declared" runtime errors.
  Not visible via `node -c` (this is HTML/TSX markup, not standalone JS);
  caught via Playwright console capture and confirmed fixed the same way
  (0 "already declared" errors post-fix, only expected 401s remain).
- A widget-registry regression introduced mid-rebuild: `Needs Follow-Up`
  had inherited a stale `defaultOff:true` flag from the old registry,
  which — combined with the new spec (only Rep Leaderboard and Budget vs
  Actual are meant to be Add-Widget-only) — meant it was silently hidden
  by default. Caught during this pass's Playwright verification (comparing
  the rendered Add-Widget popover against the confirmed spec) and fixed by
  removing the flag; confirmed via re-test that it now renders by default
  in the Sales & Pipeline zone.

**Verified via Playwright** (login as a real tenant `office_manager`
account, live local D1 data):
- Command Center (`#gwDashboard` / `today` view) renders with the 5-chip
  hero band, zone-grouped Sales & Pipeline / Financial / Operations / My
  Work sections, and correct default widget visibility (Rep Leaderboard
  and Budget vs Actual absent by default; Needs Follow-Up present).
- Accordion toggle ("View trend") confirmed to open
  `.gw-accordion-body--open` on click.
- Hover-remove "×" confirmed to go from `opacity:0` to `opacity:1` on
  widget hover.
- Add Widget popover confirmed to open and list all widgets with correct
  Add/Remove state matching what's on screen.
- Zero "already declared" or other JS errors on the unauthenticated
  landing page or post-login Command Center; the only console errors
  present are expected pre-auth 401s (`/api/auth/me` before login) and
  two pre-existing, unrelated 404s (`/api/google/refresh`,
  `/api/calendar/sync` — both return 404 by design when a tenant hasn't
  connected Google Calendar; confirmed identical in the pre-rebuild commit,
  not a regression).
- Also verified across **admin**, **rep**, and **foreman (field role)**
  accounts in a follow-up pass:
  - **admin** (`tyler@avalon-lc.com`): full Command Center, all 4 zones
    (Sales & Pipeline / Financial / Operations / My Work), 5-chip hero band,
    zero unexpected errors.
  - **rep** (`ryan@avalon-lc.com`): Command Center renders correctly with
    **no Financial zone** (matches `showFin: isAdmin||isOM` gating) — Sales
    & Pipeline (including the rep's own "Weekly Activity Targets" widget) +
    Operations + My Work only.
  - **foreman** (field role, temp test account): correctly bypassed the
    rebuilt Command Center entirely and routed straight to the separate,
    intentionally-untouched **`fieldDashboard`** view — confirming the
    "fieldDashboard stays untouched" requirement holds. Sidebar nav still
    shows the single consolidated "Command Center" label.
  - All three roles: zero "already declared" or unexpected console errors;
    only the same pre-existing pre-auth 401s / unconnected-Google-Calendar
    404s seen in the office_manager pass.

**Deployed to production** via `wrangler pages deploy` (BYOK, Tyler's
Cloudflare account) — live at https://groundwork-crm.com and
https://www.groundwork-crm.com. Verified post-deploy with a fresh
Playwright console capture directly against production: identical clean
signature to the pre-deploy sandbox check (only the 4 expected pre-auth
401s, zero "already declared" or other JS errors). Confirmed via `curl`
that the duplicate-`<script>` fix is live (`db.js` tag appears exactly
once) and that `salesReports`/`financialReports`/`opsReports` no longer
appear anywhere in the deployed `app_premium.js` except as migration-
lineage comments.

## Command Center Widget Fit: Row-Height Matching for Paired Widgets (2026-08-03)

Follow-up polish requested after the rebuild above went live and the user
reviewed real tenant data in production: "*the widgets don't fit together
well... everything is a different size, height or shape.*" Diagnosed as a
side effect of the existing masonry-packing engine (`_gwMyDayMasonry()`),
which sizes every widget purely to its own content — so two widgets sharing
a visual row (e.g. Financial Pulse vs. Money Owed, My Tasks vs. My
Calendar) could end up wildly different heights, with dead space under the
shorter one.

**Fix — `_gwMyDayMasonry()` made row-aware (no change to the layout model,
widget registry `span` values, or any customization UI):**
- CSS `grid-auto-flow` changed from `row dense` → `row` (plain) so widget
  placement stays 100% predictable left-to-right/top-to-bottom — `dense`
  would silently reorder widgets into earlier gaps, which is incompatible
  with computing row membership in JS.
- The masonry pass now: (1) measures every widget's natural content height
  as before, (2) walks widgets in DOM order replicating the browser's own
  column-wrapping (using each widget's registry `span`, read via
  `data-widget-id` — not the mutated inline style, to stay stable across
  repeated re-packs) to group them into the same visual "rows" the grid
  actually places them into, (3) sets every widget's `grid-row` explicitly
  to the **tallest sibling in its row** (`grid-row: span N`), so widgets
  sharing a row now read as one even, aligned unit. Rows are still packed
  independently of each other — no dead space was reintroduced between
  different rows, only widgets sharing a row get matched.
- **Explicitly did NOT widen lone widgets to fill their row.** An earlier
  version of this fix force-widened any widget without a same-row partner
  (e.g. "Crew Hours Today," "Today's Jobs") to a full 6-column bar to
  avoid leaving empty space beside it — caught in Playwright visual review
  (matching the tenant's own follow-up: "why is Crew Hours so long... it
  will never need to be that long... it feels like a lot of waste") that
  this made lightly-populated widgets *worse*, stretching a one-line card
  into a mostly-empty full-width bar. Reverted before this ever reached
  production: a widget alone in its row now keeps both its own natural
  content height AND its own designed (registry) width — no forced
  widening in either dimension. Which widgets end up paired vs. alone in a
  row is a direct consequence of the user's own Add Widget / hover-remove
  choices, not something this pass overrides.
- Verified the existing accordion-expand (`gwMyDayAccordionToggle`) and its
  ResizeObserver-triggered re-pack still correctly re-stretch a widget's
  row-partner when the accordion opens/closes (e.g. opening Pipeline's
  "View trend" now also grows "Daily Sales Start-Up" beside it to match).

**Verified via Playwright** (sandbox only — pre-deploy visual check
requested by the user before production rollout):
- Screenshotted the full Command Center for `admin`
  (`tyler@avalon-lc.com`) in both the default state (Time Clock + Today's
  Jobs paired, matching height) and with Time Clock hidden (matching the
  user's own screenshots) — confirmed Financial Pulse/Money Owed now match
  heights; confirmed Today's Jobs and Crew Hours Today, each alone in
  their row once Time Clock is hidden, now stay at their own compact,
  content-sized height/width instead of stretching to fill the row.
- Accordion toggle ("View trend") re-tested post-fix: opens correctly and
  its row-partner ("Daily Sales Start-Up") grows to match the new height.
- Add Widget popover / hover-remove re-tested post-fix: toggling widgets
  on/off (incl. Time Clock) re-renders and re-packs correctly, no errors.
- Re-ran the full multi-role regression (admin / office_manager / rep /
  foreman-field): zero page errors on any role; only the same pre-existing
  expected pre-auth 401s/404s seen in every prior pass; admin still lands
  on the platform overview, rep still has no Financial zone, foreman still
  bypasses Command Center entirely for the untouched `fieldDashboard`.
- `node -c public/js/app_premium.js` clean.

## Command Center: Whole-Sheet Visual Consistency Pass (2026-08-03)

Follow-up to the row-height-matching fix above. User reviewed the live,
corrected Command Center and reported it still felt inconsistent: "*every
widget being a different size and shape just continues to throw the
professionalism of the command center off*," with screenshots of Sales &
Pipeline, Financial, and Operations zones. Row-height-matching alone wasn't
enough — two further problems were identified:

1. **Operations zone width mismatch.** With "Time Clock" hidden (a
   per-user Add Widget choice), "Today's Jobs" (registry `span:4`, ~67%
   width) and "Crew Hours Today" (registry `span:3`, ~50% width) each sat
   alone in their own row at *different* widths, leaving different amounts
   of dead space beside each — a jagged, staircase-like right edge.
2. **Internal density mismatch even at matched widths/heights.** Pipeline
   Chart (dense chart + breakdown) vs. Needs Follow-Up (2 short list
   items) and Financial Pulse (dense KPI grid + progress bars) vs. Money
   Owed (3 full-width, mostly-empty stacked blocks) matched their outer
   box size but read as completely different "shapes" of widget internally.

**Fix (two parts, both implemented):**

- **Part A — Operations zone spans:** `crewHours` registry span changed
  from `3` → `6` (full row width). It's an admin/OM-only widget that
  doesn't naturally pair with anything else in the zone, so it now owns
  its row cleanly instead of sitting at an odd half-width. Its render was
  redesigned from a narrow vertical list (`.gw-myday-crew-row`) into a
  wrapping grid of compact chip-cards (`.gw-myday-crew-grid` /
  `.gw-myday-crew-chip`, visually matching the Money Owed cell language)
  so it stays content-dense at full width regardless of crew size, plus a
  header badge showing total hours + live count.
- **Part B — Internal density parity:**
  - Money Owed (A/R): `.gw-myday-ar-grid` changed from a stacked
    `flex-direction:column` list to a 3-across `grid-template-columns:
    repeat(3,1fr)` layout, matching Financial Pulse's denser KPI-grid feel
    instead of full-width blocks with mostly-empty horizontal space.
  - Empty-state placeholders (Needs Follow-Up, Today's Jobs) gained a new
    `.gw-myday-placeholder--empty` variant: centered icon (`success` /
    `calendar`) + message, `flex:1` so it expands to fill whatever extra
    height row-matching gives it (via a `:has()` rule making the parent
    `.card` a flex column) — turning what used to be a small message
    floating in a big empty void into an intentionally centered "all
    clear" state.

**Verified via Playwright** (sandbox render pre-install, per user request):
- Measured widget bounding boxes directly (`getBoundingClientRect()`) for
  the office_manager role: confirmed Crew Hours Today now renders at full
  1112px row width (matching Reviews/Money Owed row) instead of the
  previous ~547px half-width bar; confirmed Financial Pulse / Money Owed
  both render at matched 488px height with the new 3-across A/R layout.
- Screenshotted full Command Center for `admin` and `office_manager` —
  visually confirmed Operations zone no longer has a staggered right edge,
  Money Owed reads as a dense 3-cell row instead of 3 stacked mostly-empty
  blocks, and empty-state cards center their icon+message in the available
  height instead of floating near the top with dead space below.
- Re-ran full multi-role regression (admin / office_manager / rep /
  foreman-field): zero non-expected console errors on every role (only
  the same pre-existing pre-auth 401s and the expected 403s on
  admin/OM-gated endpoints — `crewHours`/`finance` — when logged in as
  `rep`/`foreman`, consistent with every prior regression pass).
- `node -c public/js/app_premium.js` clean.
- Local D1 test credentials (temporary PINs for jen/tyler/ryan, temp
  `rep_fieldtest01` foreman record) fully reverted and verified back to
  original state after testing.

## Lead Detail Page: Fixed Corrupted Layout from Earlier Command Center Rebuild (2026-08-04)

User reported: "*my leads are messed up now*," with a screenshot showing a
lead detail page squeezed into a narrow ~25-30% width column, ~70-75%
empty space to the right, and a status badge (e.g. "Fresh Inquiry")
floating in isolation, disconnected from its card.

**Root cause found via git archaeology** (`git log -S"divero" -- public/js/app_premium.js`):
an earlier Command Center rebuild commit (`90f4ac2`, "Command Center
rebuild: single canonical layout, delete report pages, accordion-expand,
Add Widget popover") contained a botched find/replace that silently
corrupted the `opportunityDetail()` function's HTML template in
`app_premium.js`. Four nested opening tags —

```html
<div class="rp-command" id="rpCommandBar">${_cmdBarHtml}</div>
<div class="rp-body">
  <aside class="rp-left" aria-label="Lead overview">
    <div class="rp-left-hero">
```

— were deleted and replaced with a malformed fragment (`<divero">`), while
every corresponding **closing** tag further down the template was left
untouched. The browser silently auto-corrected the broken markup into a
collapsed/flattened DOM, which is what produced the narrow-column squeeze
and the orphaned floating badge (actually the command-bar content,
`_cmdBarHtml`, no longer wrapped in its intended `.rp-command` container).
This bug shipped invisibly in every deploy since `90f4ac2` — it only
became obvious once a user opened a lead detail page and looked closely.

**Fix:** restored the four missing opening tags in `opportunityDetail()`'s
`view.innerHTML` template so the tag structure matches its (already-intact)
closing tags again, giving back the intended 3-column layout (left contact
panel / center workspace / right AI+financials rail).

**Verified:**
- Reproduced the exact bug pre-fix via Playwright screenshot against a
  real lead ("John Smith") — matched the user's report precisely.
- `node -c public/js/app_premium.js` clean before and after.
- Rebuilt, restarted, re-tested via full UI click-through (login → Sales
  → Pipeline → click lead card) rather than direct hash navigation, to
  match real user flow.
- Confirmed fixed: `.rp-shell` now renders at full 1112px content width
  with `.rp-left` (280px) / `.rp-center` (464px) / `.rp-rail` (320px)
  properly distributed side-by-side; no floating badge; right rail shows
  Groundwork AI, Tasks, Stage Checklist, Financials, and Payment Schedule
  cards as designed.

**Sales Process page — could not reproduce.** The same message also said
the Sales Process (stage-editing) page felt "*tiny and scrunched*." After
applying the Lead Detail fix above, the Sales Process page was tested via
full UI navigation (Sales → Sales Process) and rendered correctly at full
width in every test: `.spb-heading`/`.spb-panel` measured 1112px (same
content-area width as the fixed Lead Detail page), stage cards
well-proportioned, no cramped Entry/Exit Guidance fields. No bug was found
here — it's possible this was a transient rendering artifact from the same
underlying corrupted-DOM issue, a narrower browser window at the time the
report was made, or something not reproducible in this environment. Flagged
to the user to re-check after this deploy and report back with a fresh
screenshot if it's still an issue.

**Command Center** — user explicitly asked to defer ("*I'm gonna sleep on
it and look at it later*"); no changes made this pass.
