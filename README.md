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
│   └── static/            # Source copies of public/js files (edit here)
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
  so estimate and proposal templates stay separate.

---

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
