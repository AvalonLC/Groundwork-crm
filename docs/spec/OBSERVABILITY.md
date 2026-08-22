# OBSERVABILITY — standing note (fix plan item 7)

Not a build task. Item 7 in `docs/FINANCE-OS-FIX-PLAN.md` is explicitly "a
standing architectural note, not a PR" — this doc records the risk, what
was checked, and the decision that's still Tyler's to make, so it isn't
lost between now and whenever it's picked up.

## The risk

Three write-through helpers in `src/index.tsx` bridge ordinary CRM writes
into Finance OS state:

| Helper | ~Line | Triggered by | On failure |
|---|---|---|---|
| `syncWorkOrderFinanceColumns` | 648 | work-order create/update | `console.error`, request succeeds |
| `postWorkOrderTimeEntry` | 704 | clock-out, and item 5's `/adjust` replacement path | `console.warn` (expected gaps) or `console.error` (unexpected), request succeeds |
| `markOpportunityCollectedFromInvoice` | 735 | every invoice transition to `status='paid'` | `console.error`, request succeeds |

All three are deliberately **best-effort**: none of them throw, none block
or roll back the CRM request that triggered them (creating a work order,
clocking out, marking an invoice paid). That's the correct design — a
Finance OS hiccup should never take down an ordinary CRM action — but it
has a direct cost: **on failure, the only trace is a `console.error` /
`console.warn` line**, and there is currently no observability configured
at all to catch it.

Checked directly, still true as of this note:
- No observability block in `wrangler.jsonc`.
- No error-tracking secret in `wrangler pages secret list` (SENTRY_*,
  LOGPUSH_*, or similar — grepped for both across `src/`, `.github/`, and
  `wrangler.jsonc`; none found).
- The three helpers' own code comments already say this out loud (`"All
  three are best-effort: a Finance OS write failure must never break the
  CRM request that triggered it"`, `src/index.tsx` ~line 641) — the
  design choice is intentional and documented; the missing piece is
  purely the observability layer around it.

A real failure in any of these three helpers today is invisible to
everyone unless someone happens to run `wrangler tail` at the right
moment. Nothing in the rest of the fix plan changes this — items 4/5's
new immutability guards make posted data *harder to corrupt*, but a
posting failure in `postWorkOrderTimeEntry` itself would still only ever
surface as a `console.warn`/`console.error`.

## Recommended fix — decide with Tyler before building

**1. Turn on retained, searchable logging for `console.error`/`console.warn`.**
Two paths, in order of how much this repo already leans toward:

- **(a) Cloudflare Workers Logs / Logpush** — native to the platform this
  app already deploys to, no new secret, no new vendor account. Turned on
  per-Worker in the Cloudflare dashboard (or via `wrangler.jsonc`'s
  `observability` block on newer Wrangler versions); retains `console.*`
  output and makes it searchable/filterable in the dashboard. This is the
  lower-friction option and matches how `finance-cron.yml`/
  `marketing-cron.yml` already prefer "reuse what the platform gives us"
  over adding a new service (see `finance-cron.yml`'s own "Option B"
  comment for that same reasoning applied to scheduling).
- **(b) A third-party error tracker (e.g. Sentry)** — richer feature set
  (grouping, alerting rules, stack traces with source maps, email/Slack
  notification out of the box) at the cost of a **new secret** (a DSN)
  and a **new dependency** (`@sentry/cloudflare` or manual `fetch`-based
  reporting, since the Node SDK's transports don't run in the Workers
  runtime) and a new vendor relationship to maintain.

This doc does not pick between them — **that decision needs to go to
Tyler explicitly**, both because it's a new-dependency/new-secret call
(this repo's existing pattern, e.g. `CRON_SECRET`, `SENDGRID_API_KEY`, is
to hand-configure every secret via `wrangler pages secret put` and
document it in a runbook — see `docs/RUNBOOK-finance-cron.md` — never to
silently add one) and because option (b) has an ongoing cost/vendor
tradeoff that isn't a purely technical call.

**2. Consider surfacing `postWorkOrderTimeEntry`'s two silent no-op cases
somewhere user-facing**, not just a log line:
- No `work_order_id` on the time entry (general/non-job time — expected,
  not a bug).
- The work order's crew has no `division` set — this one silently means
  that crew's time **never posts to the ledger, forever**, until someone
  sets a division, with nothing today pointing a human at the gap.

At minimum, "N time entries this week couldn't post — no division set on
crew X" belongs somewhere a human looking at Setup & Config or Job
Costing would see it, rather than being purely a log line only visible to
whoever has observability tooling and thinks to look. This overlaps with
item 2's Setup & Config redesign (raw JSON editors now gated behind
`isSuperAdmin`, `src/ui/config-admin.tsx`) — if that page ever grows
anything beyond raw config for super-admins, this is a natural fit there.
Not built now; noted so it isn't independently rediscovered later.

## Why this wasn't folded into items 4-6

Items 4-6 all had a fully-specified fix (exact response codes/messages,
exact schema, exact UI copy) that could be built and verified without any
new outside decision. This item's very first sentence in the fix plan is
"no single fix — a standing risk to document and decide on," and its
recommended fix explicitly adds a new secret/dependency — the one thing
this project's own conventions (and the top-level instructions this
agent operates under) require flagging to the user rather than choosing
automatically. Shipping this quietly by defaulting to option (a) or (b)
would be picking that decision for Tyler instead of surfacing it.

## Status

**Open — awaiting Tyler's choice between (a) Cloudflare Workers
Logs/Logpush and (b) a third-party tracker (e.g. Sentry)**, or a decision
to defer this further. Once decided, the follow-up work is: wire up the
chosen tool (secret + minimal integration in the three helpers' catch
blocks, or a platform-level toggle for option (a)), and separately, decide
whether to build the Setup & Config no-op surfacing from point 2 above.
Neither has an estimate yet since neither has been scoped past this note.
