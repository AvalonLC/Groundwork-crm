# Finance OS config

Seven files. Each is a safe default that the app runs on as-is — nothing
here is required before Finance OS works, it just determines how much gets
auto-resolved vs. routed to a human review queue.

## How to edit these

**Preferred: the admin UI at `/finance/config`** (owner role only). Shows
the current effective value for each file, lets you paste a full
replacement JSON blob, validates it before saving, and Reset reverts to
the file below. Edits there take effect immediately — no deploy, no code
change — stored as a database override layered on top of the file.

**Alternative: edit the file directly**, then run
`npm run validate:finance-config` before committing (also runs
automatically in CI and `npm run preflight`) — it checks the same
structural rules the admin UI enforces, so a broken hand-edit gets caught
immediately rather than silently breaking the classifier or ingest at
runtime.

## What each file is for

| File | Controls | Safe to leave as-is? |
|---|---|---|
| `classifier.rules.json` | Vendor/keyword matching rules for auto-categorizing transactions | Yes — everything just routes to manual review until real rules are added. Every shipped rule is marked `"placeholder": true`. |
| `ingest.sources.json` | Which CSV column layouts are recognized for P&L/bank/payroll uploads | Yes — an unrecognized file format safely flags for review instead of guessing a mapping. |
| `division-map.json` | Canonical division names + aliases (e.g. "lawn maintenance" -> "maintenance") | Yes — an unmapped division flags for review. |
| `approval-thresholds.json` | Dollar/percentage thresholds (materiality, equipment variance, SLA days) | Yes — reasonable defaults, tune anytime. |
| `automation-policy.json` | On/off switches for each automated pipeline | Yes — everything defaults to enabled; disabling degrades to manual review, never silent skipping. |
| `tenant-defaults.json` | Seed values for a brand-new tenant's finance policy | Yes — sane defaults for onboarding. |
| `role-map.json` | Maps your CRM's role strings to Finance OS permission levels | **Review before relying on it** — this one has real information-exposure risk if wrong. Currently conservative defaults; see `docs/PUNCHLIST.md`. |

## What's NOT safe to leave unreviewed

`role-map.json` is the one file on this list that isn't purely
"restrictive by default, safe to ignore" — it decides who can see
margin/wage/rate data on live pages. The current values default ambiguous
roles to the *more* restrictive option, but that's a guess, not a
confirmed policy. Everything else degrades safely (unrecognized data goes
to a review queue) if left untouched.
