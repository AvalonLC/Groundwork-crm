# Finance OS config

Seven files. **Every file here is a Groundwork-wide platform default** —
none of them are specific to any one customer (including whichever company
first uses this CRM). Each is a safe default that the app runs on as-is:
nothing here is required before Finance OS works, it just determines how
much gets auto-resolved vs. routed to a human review queue.

## Platform default vs. tenant override — how this actually works

There are two layers, and they're kept structurally separate:

1. **This directory** (`config/finance/*.json`) — the Groundwork-wide
   default. Version-controlled, deployed with the app, the same for every
   tenant until a tenant sets its own override. Editing these files changes
   what *every* tenant sees by default.
2. **A tenant's own override** (`finance_config_override` table, edited via
   `/finance/config` while logged in as that tenant) — applies only to the
   tenant that saved it. **The admin UI can only ever write to the
   currently-logged-in tenant's own override** — there is no UI path for
   one tenant's edit to change the platform-wide default, or any other
   tenant's view. This is verified directly by an automated test (`UC-09`
   in `src/ui/config-admin.e2e.ts`): tenant A saving a change is proven to
   never appear for tenant B.

Concretely: if a company (any company — Avalon or otherwise) starts using
this CRM and customizes its classifier rules at `/finance/config`, that
customization is *that company's own data*, isolated from the platform
default and from every other tenant. It never becomes "the new default"
for anyone else. Changing the platform-wide default for all tenants
requires editing the files in this directory directly (a deliberate,
repo-level change), not something the admin UI exposes.

## How to edit these

**Preferred: the admin UI at `/finance/config`** (owner role only). Shows
the current effective value for each file, lets you paste a full
replacement JSON blob, validates it before saving, and Reset reverts to
the platform default. Edits there take effect immediately for that tenant
only — no deploy, no code change.

**Alternative: edit the file directly** (changes the platform-wide
default for every tenant), then run `npm run validate:finance-config`
before committing (also runs automatically in CI and `npm run preflight`)
— it checks the same structural rules the admin UI enforces, so a broken
hand-edit gets caught immediately rather than silently breaking the
classifier or ingest at runtime.

## What each file is for

| File | Controls | Safe to leave as-is? |
|---|---|---|
| `classifier.rules.json` | Vendor/keyword matching rules for auto-categorizing transactions | Yes — generic contractor/landscaping/service-business starter categories, everything routes to manual review until real rules are confirmed. Every shipped rule is marked `"placeholder": true`. |
| `ingest.sources.json` | Which CSV column layouts are recognized for P&L/bank/payroll uploads | Yes — an unrecognized file format safely flags for review instead of guessing a mapping. |
| `division-map.json` | Canonical division names + aliases (e.g. "lawn maintenance" -> "maintenance") | Yes — an unmapped division flags for review. The four divisions shipped (maintenance/hardscape/snow/drainage) reflect this build's verification fixtures, not a fixed platform requirement; a tenant with different divisions sets its own override rather than editing this file. |
| `approval-thresholds.json` | Dollar/percentage thresholds (materiality, equipment variance, SLA days) | Yes — reasonable platform-wide defaults, tune anytime. |
| `automation-policy.json` | On/off switches for each automated pipeline | Yes — everything defaults to enabled; disabling degrades to manual review, never silent skipping. |
| `tenant-defaults.json` | Seed values a brand-new tenant's finance policy starts from | Yes — generic onboarding defaults, not any one company's real policy. |
| `role-map.json` | Maps the CRM's shared role vocabulary (admin/office_manager/estimator/etc.) to Finance OS permission levels | **Review before relying on it** — this one has real information-exposure risk if wrong. Currently conservative platform defaults; see `docs/PUNCHLIST.md`. |

## What's NOT safe to leave unreviewed

`role-map.json` is the one file on this list that isn't purely
"restrictive by default, safe to ignore" — it decides who can see
margin/wage/rate data on live pages. The current values default ambiguous
roles to the *more* restrictive option, but that's a guess, not a
confirmed policy. Everything else degrades safely (unrecognized data goes
to a review queue) if left untouched.
