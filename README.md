# Groundwork CRM

## Project Overview
- **Name**: Groundwork CRM (formerly Avalon Sales Hub)
- **Goal**: Internal sales OS for Avalon's team — leads, pipeline, clients, docs, and Google Workspace in one hub
- **Platform**: Cloudflare Pages + Hono (edge-deployed)
- **Tech Stack**: Hono · TypeScript · TailwindCSS (CDN) · Wrangler · Vite

## URLs
- **Production (primary)**: https://groundwork-crm.com
- **Production (alt)**: https://www.groundwork-crm.com
- **Cloudflare Pages**: https://avalon-sales-hub.pages.dev
- **GitHub**: https://github.com/AvalonLC/Groundwork-crm
- **Auth**: PIN-based per-rep login (Tyler / Ryan / Jen)

> ⚠️ `groundwork-crm.pages.dev` returns HTTP 500 — this is a Cloudflare infrastructure ghost
> from when the project was originally named. The subdomain is locked to the creation name
> (`avalon-sales-hub`). Use `groundwork-crm.com` as the canonical URL.

## Google OAuth Setup
The Google OAuth callback route is `/auth/google/callback` (no `/api/` prefix).

**Required Authorized Redirect URIs in Google Cloud Console:**
```
https://groundwork-crm.com/auth/google/callback
https://www.groundwork-crm.com/auth/google/callback
https://avalon-sales-hub.pages.dev/auth/google/callback
```
> The URIs currently registered (`/api/auth/google/callback`) have the wrong path prefix.
> The code sends `${location.origin}/auth/google/callback` — update Google Cloud Console to match.

## Features Completed

### Core Sales Views
- Today Dashboard, Pipeline (Kanban), Lead cards, Clients list
- Process, Forms, Scripts, Templates, Objections, Calculator, Academy
- Revenue / Financial Data Hub (admin-only)

### Rep System
- Color-coded rep pills on every lead card
- First-letter colored tiles
- Sidebar nav with role-gated views
- Per-role nav permission matrix

### User & Access Management (Admin-only)
- Users CRUD tab — edit name, role, color, PIN
- Roles & Permissions matrix — per-view toggle for all roles
- Workspace Connections grid — see all reps' Google connection status
- Login Audit tab — timestamped login history

### Google Workspace Hub (Integrations view)
- **Per-user isolation** — each rep connects their own Google account
- **Gmail tab**: thread list, read full threads, inline reply, compose new, trash, mark-read
- **Calendar tab**: agenda / week / month views — create, edit, delete events
- **Drive tab**: file browser, icon-coded file types, search, open/preview links
- **Homeworks tab**: push leads, visits, estimates to Zapier webhook

### Icon System
- `window.gwIcon(name, size, color)` — 80+ inline SVG icons replacing all emoji
- Loaded via `/static/gw-icons.js` as the first script in app shell

## Data Architecture
- **Database**: Cloudflare D1 (`avalon-sales-hub-production`) — binding `DB`
- **D1 schema**: opportunities, clients, tasks, settings, reps, sessions tables
- **localStorage**: Used as read-cache / offline fallback only; D1 is write authority
- **Google tokens**: `avalonUserGoogleV1` keyed by `repId`

## Cloudflare Configuration
- **Project name**: `groundwork-crm`
- **Pages subdomain**: `avalon-sales-hub.pages.dev` (locked at creation)
- **D1 binding**: `DB` → `avalon-sales-hub-production` (ID: `a09eba8e-6c21-4ec3-a257-70a94b6e2aeb`)
- **Compatibility date**: `2026-05-03`
- **Compatibility flags**: `nodejs_compat`

## User Guide
1. Open https://groundwork-crm.com → select your rep tile → enter PIN
2. Navigate via sidebar (role-gated views auto-hide for non-admins)
3. Today view → Coming Up, Recently Updated, Due Now sections
4. Pipeline → Kanban board with lead cards
5. Integrations → Connect Google account per-rep for Gmail/Calendar/Drive

## Deployment
- **Platform**: Cloudflare Pages
- **Status**: ✅ Active
- **Deploy command**: `npm run build && npx wrangler pages deploy dist --project-name groundwork-crm`
- **Last Updated**: 2026-06-28

## Known Issues / Pending
- `groundwork-crm.pages.dev` → 500 (Cloudflare infrastructure, cannot fix via API; use `groundwork-crm.com`)
- Google OAuth "Access blocked" — URIs in Google Cloud Console need updating (see above)
- D1 schema: `opportunities` table missing `lead_source` column — needs migration
