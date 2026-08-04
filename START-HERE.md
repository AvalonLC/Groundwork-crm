# Groundwork Finance OS — how to know it's ready before you click go

## TWO GATES. Both must pass. Neither costs agent tokens.

```bash
npm run preflight              # 38 static checks
bash scripts/harness-selftest.sh   # 26 live checks, real runner, ZERO tokens
```

If both are green, the harness is proven. Only then run wave 1.

---

## THE NUMBER CORRECTION (read this first)

An earlier design pass said the equipment-removed labor rate was **$39.49 at 1.645x**.
Verified in code — that was wrong two ways:

- The equipment component is `2400 / 1622 billable hrs = $1.4797/hr`, **not $2.61**
  ($2.61 used *paid* hours — the wrong denominator; every other component is per billable hour)
- It subtracted from the rounded $42.10 instead of the actual $42.1002

| equipment_engine_active | burdened rate | multiplier |
|---|---|---|
| `false` | **$42.1002** → $42.10 | 1.754x |
| `true`  | **$40.6205** → $40.62 | 1.693x |

$39.49 understated true labor cost by **$1.13/hr ≈ $23,838/yr across 13 field staff.**

Four layers now reject it: the `BH-13` test, the pre-push hook, CI, and
`scripts/check-fixtures.js` (which re-derives the delta and fails if it drifts).

---

## SETUP (~15 min, once)

```bash
unzip groundwork-finance-os-scaffold.zip && cd gw

git init && git add -A && git commit -m "wave 0: verified harness"
git branch -M main
git remote add origin git@github.com:<you>/groundwork-finance-os.git
git push -u origin main

git config core.hooksPath .githooks     # REQUIRED — hooks are inert without this
npm install                             # REQUIRED — gates cannot run without deps

npx wrangler login
npx wrangler d1 create groundwork        # paste database_id into wrangler.toml
npx wrangler vectorize create gw-tenant-history --dimensions=768 --metric=cosine
npx wrangler r2 bucket create gw-receipts
```

---

## GATE 1 — preflight (static, instant)

```bash
npm run preflight
```

Three outcome types, and the distinction matters:

| Result | Meaning | Action |
|---|---|---|
| **FAIL** | harness is broken | fix before anything else |
| **TODO** | your setup step is incomplete | do it (remote, D1 id) |
| **WARN** | optional / needs a login | fine to proceed |

Covers: node ≥20, deps installed, git remote reachable, `core.hooksPath` set,
hook executable, task graph valid with no file collisions, all 22 `spec_ref`
files present, fixture delta re-derived, BH-13 intact, no `--remote` in src,
no `DB_PROD`, node_modules untracked, all five Cloudflare bindings, agent CLI present.

**Prove Claude is authenticated (not just installed):**
```bash
npm run preflight -- live      # burns ~1 turn, asks Claude to reply "READY"
```
`command -v claude` only proves the binary exists. This proves auth works.

---

## GATE 2 — harness self-test (live, still zero tokens)

```bash
bash scripts/harness-selftest.sh
```

This is the important one. It runs **the real `run-wave.sh`** with a `noop`
driver that writes a known-good burden engine, so the real gate grades real
code. It verifies:

1. deps present and node_modules is a real dir, not a tracked symlink
2. pre-push hook actually matches `--remote`, `DB_PROD`, `39.49`, `.skip(`
3. rendered prompt contains the gate, the fixture, forbidden items, READ-ONLY
4. `check-deps` refuses to start wave 3 without wave-1/2 tags
5. **full dry run**: worktree → driver → gate → merge → regression → tag
6. rollback tag resolves
7. teardown removes worktrees, branches, tags, and the reference impl

Expected: **26 passed · 0 failed**

---

## DRIVER SPLIT — Claude Pro + ChatGPT Business

| Waves | Driver | Why |
|---|---|---|
| 0-3 | Claude (Opus) | precision; fixtures catch errors to the cent |
| 4-6 | Codex (GPT-5.6) | bulk volume; Business credits absorb overage |

```bash
PLAN=pro DRIVER=claude \
  DRIVER_W4=codex DRIVER_W5=codex DRIVER_W6=codex \
  CODEX_FLAGS="--full-auto" \
  FROM=0 TO=6 bash scripts/autopilot.sh
```

Verify the Codex flag first: `codex exec --help`. If `--full-auto` is wrong,
set `CODEX_FLAGS` to whatever the installed version calls auto-approve.

## SCOPE IS ENFORCED, NOT REQUESTED
`scripts/verify-scope.js` runs before the test gate on every task. It diffs the
agent's branch against main and rejects any file outside `files_owned`.
Protected files in `.agent-protected` are an absolute stop. Tested three ways:
in-scope passes, drift fails, protected file fails.

## THEN, AND ONLY THEN

```bash
./scripts/run-wave.sh 1        # spine     ~3h
./scripts/run-wave.sh 2        # engines   ~4h   <-- audit this one
./scripts/run-wave.sh 3        # posting   ~4h
./scripts/run-wave.sh 4        # UI        ~5h   (or: ... 4 codex)
./scripts/run-wave.sh 5        # AI + IO   ~4h
./scripts/run-wave.sh 6        # harden    ~3h
```

A wave will **not tag** if any task failed its gate. Rollback:
`git reset --hard wave-N-green`

---

## BEFORE EACH WAVE: fill in its spec files

`docs/spec/*.md` ship as stubs. `npm run preflight` lists which are still stubs.
Paste the corresponding design content in before running that wave — fixtures
keep the numbers right, but an agent will guess at layout and field names.

---

## YOUR 6 CHECKPOINTS (~100 min total)

| When | Min | Check | Kill criterion |
|---|---|---|---|
| H0 | 60 | both gates green | any FAIL |
| H4 | 15 | read the 3 migrations | money stored as REAL |
| H8 | 20 | BH-13 passes; `grep -rn 39.49 src/` | any hit outside burden.test.ts |
| H12 | 10 | immutability test; `grep -r -- --remote logs/` | any hit |
| H18 | 20 | preview URL as all 4 roles | crew sees a margin |
| H24 | 30 | read `docs/PUNCHLIST.md` + `BLOCKED-*.md` | — |

---

## DO NOT

- promote to production D1 at hour 24 while tired — tag, sleep, promote in the morning
- skip `git config core.hooksPath .githooks` (hooks silently do nothing)
- skip `npm install` (every gate fails with `vitest: not found`)
- let an agent edit `src/engines/burden.test.ts`

## WHAT 24H CANNOT BUY

Classifier at 91% (needs 8 weeks of corrections) · calibration table (4+ weeks) ·
enforcing price floors (8–10 weeks of closed jobs) · telematics (vendor auth).
These ship present-but-advisory. That is the design, not a shortfall.
