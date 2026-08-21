# Prompt for Claude — Finance OS fix implementation

Copy everything below the line into a fresh Claude Code session pointed at this repo.

---

You are implementing a complete fix plan for Groundwork CRM's "Finance OS"
sub-system (Hono + JSX under `src/ui/*.tsx`, mounted at `/finance/*`). The full
plan — root causes, exact files, exact fixes, and verification steps for every
item — is already written out in **`docs/FINANCE-OS-FIX-PLAN.md`**. Read that file
first, in full, before doing anything else. It is the authoritative spec for this
work; do not re-derive root causes from scratch, they're already confirmed there.

## Ground rules

- Work through the plan's 7 items **in the order given** (item 0 through item 7).
  The plan doc's "Suggested execution order & branching" section at the bottom
  explains dependencies — item 0 is already built and just needs to land; items
  4/5 can be combined into one PR; item 7 is a standing note, not a PR.
- **One branch and one PR per item** (or per combined pair, per the plan's
  guidance), branched from `main`, not stacked on top of each other, unless a
  later item explicitly depends on an earlier one's schema/code — check the plan
  doc for stated dependencies before assuming independence.
- Before writing any code for an item, re-read that item's section in the plan doc
  and confirm you understand the exact root cause and fix described — don't
  improvise a different fix than what's specified without flagging why.
- **Item 1 (ingest matching) needs a real file sample from the user** to fully fix
  — the plan doc says so explicitly. If no sample has been provided, ship only the
  sub-fix that doesn't need it (the improved "headers found vs headers expected"
  error message), commit that, and explicitly tell the user you're blocked on the
  rest until they provide a sample export file. Do not guess at header formats.
- **Item 4 has an open decision** (whether to delete or keep `job_cost_ledger`
  rows when their work order is deleted) — the plan doc recommends keeping them
  for cost-history reasons but says to confirm with the user before shipping.
  Ask before implementing that part; don't assume.
- **Item 6/7 involve new tooling decisions** (notification method, observability
  vendor) — propose options per the plan doc, but confirm the user's preference
  before adding new external dependencies or secrets.

## Quality bar for every item, before opening a PR

1. `npx tsc --noEmit -p tsconfig.finance.json` (or the project's main tsconfig if
   the change touches `src/index.tsx` outside the finance UI tree) — must be clean.
2. `npm run build` — must succeed.
3. Full test suite — `npm test` (this repo's `package.json` runs
   `vitest run && npm run test:browser-js`) — must pass, not just the tests for
   files you touched. Do not skip this in favor of only running the new/changed
   test file.
4. New behavior needs new test coverage — the plan doc states what to add for each
   item (unit tests, e2e tests, or both). Don't ship an item without the tests it
   specifies.
5. Standard sandbox service verification before calling anything done: kill port
   3000, rebuild, restart via PM2, curl the affected route(s), check
   `pm2 logs --nostream` for errors.
6. Follow this repo's existing conventions — money in cents, hours in hundredths,
   `company_id`-scoped queries, the "propose don't auto-post" pattern used
   throughout Finance OS (e.g. new `action_item` rows for findings, never silent
   auto-invoicing/auto-payments). If an item's fix seems to call for violating one
   of these established patterns, stop and ask rather than proceeding.

## Git workflow

- Call `setup_github_environment` before any push.
- Confirm the actual remote (`git remote -v`) before assuming a repo name — don't
  guess based on anything outside this session.
- Branch names: short and descriptive, e.g. `finance-unbilled-detector`,
  `finance-config-admin-gating`, `finance-time-entry-guards`.
- Commit messages: explain the root cause fixed, not just "fix bug" — match the
  style already in this repo's history (see `git log --oneline -20` for examples).
- Push each branch, open a PR against `main`, verify CI
  (`.github/workflows/ci.yml`) is green before considering the item complete.
- Update `docs/PUNCHLIST.md` and any `docs/spec/*.md` file the plan doc names as
  needing an update (e.g. item 3 says to update `docs/spec/UNBILLED.md` once the
  CRM join is built) — do this as part of the same PR, not a follow-up.

## Reporting back

After each item (or combined pair), report to the user:
- What was root-caused and fixed, in plain language (this audience is a business
  owner, not an engineer — avoid unexplained jargon).
- The PR link/branch name and CI status.
- Exactly how they can verify it themselves in the live app (a specific page to
  visit, action to take, and what they should now see).
- Anything you were blocked on (missing file sample, an open decision you're
  waiting on their answer for) — call this out clearly rather than silently
  skipping or guessing.

Start now: read `docs/FINANCE-OS-FIX-PLAN.md` in full, then begin with item 0.
