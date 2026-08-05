# THE PROMPT — adapted to Tyler's actual Claude Code setup

## BEFORE you paste anything

Your screenshot showed three things that must change first:

**1. You launched claude in your home directory.** Claude's own tip flagged this.
Relaunch inside the repo:
```bash
cd "/Users/tylerjohnson/Desktop/Groundwork CRM/Groundwork-crm-REPO"
claude
```

**2. "manual mode on" is showing.** That prompts you to approve every single
file edit — it will hang on the first write and wait all night. The harness now
passes `--permission-mode acceptEdits` on each headless call, so the autopilot
path is fine. But do not run waves from the interactive session while manual
mode is on.

**3. You have 4 uncommitted files.** `package.json`, `package-lock.json`,
`scripts/.build-version`, `src/index.tsx`. Commit or stash them yourself before
starting. `.agent-protected` lists the risky two and the pre-push hook refuses
any commit touching them, but clean is safer than guarded.

---
>>> BEGIN PROMPT >>>

You are running an unattended build inside an EXISTING, LIVE production repo.
I will be asleep. Work autonomously. Stop honestly rather than guess.

## THIS REPO IS ALREADY IN PRODUCTION
Hono + Cloudflare Pages/D1, project `groundwork-crm`, live at
https://groundwork-crm.com, with real feature history (pricing, onboarding, AI
setup copilot, template builder, masonry grid).

You are ADDING a Finance OS layer. You are not scaffolding a new app.
- Do NOT restructure existing directories.
- Do NOT reformat or "clean up" files you were not asked to touch.
- Config is **wrangler.jsonc**. Do NOT create a wrangler.toml.
- Match the conventions already in this codebase.

## THERE IS NO STAGING STEP. DEPLOYS ARE INSTANT.
`npm run deploy` publishes to groundwork-crm.com IMMEDIATELY.
`npm run db:migrate:prod` writes the PRODUCTION database IMMEDIATELY.

You must NEVER run either, nor any equivalent:
`wrangler pages deploy`, `wrangler d1 migrations apply --remote`.
Not to verify. Not to "check it works." Never. I run those myself, awake.
The pre-push hook blocks them and will fail your push.

Local database work only:
`wrangler d1 migrations apply <db> --local`

## I HAVE UNCOMMITTED WORK HERE
Files in `.agent-protected` had in-progress edits before you started.
- Never modify them.
- Never `git add -A` in the main working tree — stage explicitly by path.
- Never `git stash`, `git checkout --`, or `git restore` anything you did not create.

## READ FIRST, IN THIS ORDER
1. `CLAUDE.md` — binding contract. Every rule applies to every action.
2. `START-HERE.md` — operator runbook.
3. `tasks.json` — 23 tasks, waves 0-6. Your work queue.
4. `fixtures/golden.json` — verified numbers. These are TESTS, not examples.
5. `docs/spec/BH-TESTS.md` — acceptance tests for the keystone engine.

## THE ONE NUMBER THAT MATTERS MOST
A prior design pass contained an arithmetic error. Corrected values:

| equipment_engine_active | burdened rate | multiplier |
|---|---|---|
| false | 42.1002 (displays $42.10) | 1.754x |
| true  | 40.6205 (displays $40.62) | 1.693x |

The equipment component is `2400 / 1622 billable hours = 1.4797/hr`.
It is NOT 2.61 — that used paid hours, the wrong denominator.
`39.49` is a known-bad value. Four layers reject it: the BH-13 test, the
pre-push hook, CI, and `scripts/check-fixtures.js`. Never write it anywhere.

## YOUR PROCEDURE

### Step 1 — verify the harness before spending anything
```bash
npm install
git config core.hooksPath .githooks
npm run preflight
```
- `FAIL` = the harness is broken. Diagnose, fix, re-run. Do not proceed past one.
- `TODO` = needs MY credentials (git remote, D1 database id). You cannot do
  these. If any remain, write `BLOCKED-setup.md` naming exactly which, then STOP.
- `WARN` = acceptable, continue.

Then prove the harness end-to-end with zero tokens:
```bash
bash scripts/harness-selftest.sh
```
Expect `26 passed · 0 failed`. If it fails, fix the harness and re-run.
Never start a wave on an unverified harness.

### Step 2 — run the build (DUAL DRIVER)

I have Claude **Pro** ($20 tier — the weakest Claude Code tier, 5-hour rolling
caps) and ChatGPT **Business** (Codex included, with flexible credits for
overage). So we split by task character:

```bash
PLAN=pro \
DRIVER=claude \
DRIVER_W4=codex DRIVER_W5=codex DRIVER_W6=codex \
CODEX_FLAGS="--full-auto" \
FROM=0 TO=6 bash scripts/autopilot.sh
```

- **Waves 0-3 → Claude (Opus)**: schema, engines, posting. Precision work with
  to-the-cent fixtures. Claude Pro's caps are survivable here because
  `PLAN=pro` throttles to 2 parallel agents and autopilot re-runs partial waves.
- **Waves 4-6 → Codex (GPT-5.6)**: UI, classifier, hardening. High volume,
  layouts already specified, and Business credits do not hard-stop mid-wave.

If `--full-auto` is not the right flag for the installed Codex version, run
`codex exec --help`, pick the non-interactive/auto-approve flag, and set
`CODEX_FLAGS` accordingly. Do not leave it interactive — it will hang all night.

**Note on Codex/GPT-5.6 specifically:** there are documented reports of this
model drifting off declared constraints. `scripts/verify-scope.js` now runs as a
MANDATORY gate before the test gate on every task: if a task edits any file
outside its `files_owned`, the branch is rejected and never merged. Do not
attempt to bypass or weaken that check.

If autopilot halts, do this and nothing more:
1. Read the failing task's log in `logs/`.
2. If the cause is a harness defect — a wrong path, bad glob, missing dep, a bug
   in one of my scripts — FIX THE HARNESS and resume from the failed wave.
3. If the cause is genuinely ambiguous requirements or missing evidence — write
   `BLOCKED-<task_id>.md` with the exact failing assertion and what evidence you
   would need, then STOP. Do not guess. Do not widen scope.

### Step 3 — finish
When wave 6 is green, write `docs/PUNCHLIST.md` containing:
- every gap that is real, stated plainly
- every spec you derived rather than were given, with your confidence
- every number that is an estimate rather than a verified figure
- exactly what I must review before I deploy anything

## WAVE 0 IS SPECIAL — READ CAREFULLY
`docs/spec/*.md` ship as stubs. Task `W0-specs` asks you to derive them from
evidence already in this repo: `CLAUDE.md` invariants, `tasks.json` task titles
and `forbidden` lists, `fixtures/golden.json`, `src/engines/burden.test.ts`, and
the existing app's own conventions.

For each spec file:
- Every monetary figure MUST already appear in `fixtures/golden.json`.
  Inventing one is a hard violation; `scripts/check-derived-specs.js` enforces it.
- Every file MUST end with `## Derivation confidence` stating what you inferred,
  what you are confident about, and what I need to confirm. Be honest — an
  inferred field name I fix in two minutes beats a confident guess I find in
  week three.
- If a spec cannot be honestly derived (a screen layout with no evidence), write
  only the sections you CAN support and list the rest under `## Needs Tyler`.
  Do not fabricate a layout.

## SCOPE IS MECHANICALLY ENFORCED
Every task declares `files_owned`. After you finish a task, the harness diffs
your branch against main and REJECTS it if you touched anything else.
`package-lock.json` and `BLOCKED-*.md` are the only incidental exceptions.
Stage files explicitly by path. Never `git add -A`.

## HARD BOUNDARIES — violating any one fails the run
- NEVER `npm run deploy` or `npm run db:migrate:prod` or any deploy equivalent.
- NEVER `wrangler ... --remote`.
- NEVER touch files in `.agent-protected`.
- NEVER `git add -A` in the main working tree.
- NEVER edit `src/engines/burden.test.ts` — it is the double-count guard.
- NEVER delete, skip, or weaken a test to make a gate pass.
- NEVER edit a file outside the current task's `files_owned`.
- NEVER commit `node_modules` (a symlink slips past a trailing-slash gitignore).
- NEVER `git push --force` or rewrite history.
- NEVER write 39.49, or treat 2.61 as the equipment component.
- Money is INTEGER cents. Rates are INTEGER ten-thousandths. No floats.
- Create no `wrangler.toml`. This repo uses `wrangler.jsonc`.
- NEVER edit a file outside `files_owned` — the scope gate rejects the branch.

## HOW I JUDGE THIS RUN
Not by how many tasks turned green. By whether every green task is actually
correct and every gap is honestly named.

Waves 0-3 green with correct engines and a candid punch list is a success.
All six waves reported green while hiding a wrong rate or a fabricated spec is a
failure — worse than not running at all, because every number downstream
inherits the error and looks entirely plausible.

If unsure, stop and write it down. That costs me fifteen minutes.
Guessing costs me a month.

Begin with Step 1.

<<< END PROMPT <<<
---

## While you sleep
```bash
cat logs/HEARTBEAT.md          # stage, waves green, last task, blockers
```

## If it halted
```bash
git tag                        # highest wave-N-green = last good state
ls BLOCKED-*.md                # what it refused to guess
tail -40 logs/autopilot-*.log  # why it stopped
PLAN=pro DRIVER=claude FROM=<failed> TO=6 bash scripts/autopilot.sh
```

## Rollback
```bash
git reset --hard wave-<N>-green
```

## Deploy — yours alone, when awake
```bash
npm run preflight              # still clean?
npm test && npm run typecheck
npm run db:migrate:prod        # production DB, no undo
npm run deploy                 # live at groundwork-crm.com
```

## What it will NOT have done
Deployed anything. Touched the production D1. Reached 91% classifier accuracy
(needs 8 weeks of real corrections). Enabled enforcing price floors (needs 8-10
weeks of closed jobs). Those are calendar-gated, by design.
