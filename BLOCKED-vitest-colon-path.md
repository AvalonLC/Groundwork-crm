# BLOCKED: vitest cannot run — repo path contains a colon

`npm test` (and `./node_modules/.bin/vitest` invoked directly, bypassing PATH
entirely) both fail with:

```
Error: Cannot find module '/@vite/env'
 ❯ VitestExecutor._fetchModule .../Groundwork%20CRM/Groundwork-crm%20:%20REPO/node_modules/vite-node/dist/client.mjs:247:19
```

## Root cause (confirmed empirically, not a guess)
The repo lives at:
`/Users/tylerjohnson/Desktop/Groundwork CRM/Groundwork-crm : REPO`

The colon in `Groundwork-crm : REPO` breaks two independent things:

1. **PATH resolution.** `npm run test` prepends `<repo>/node_modules/.bin` to
   `PATH` as a colon-joined string. Since the repo's own path contains a colon,
   that single PATH entry gets silently split into two garbage entries — this is
   why `npm test` reports `vitest: command not found` even though the binary is
   installed. (Same root cause as the earlier `npx wrangler` failures fixed in
   `scripts/preflight.sh` by calling `./node_modules/.bin/wrangler` directly.)

2. **Vite's internal module URLs.** Even calling the vitest binary directly
   (`./node_modules/.bin/vitest run ...`), vite-node still fails —
   it builds internal module specifiers as URLs, and the colon in the directory
   name breaks that URL construction when resolving the `/@vite/env` virtual
   module. This is inside `vite-node`/`vitest` itself, not something fixable by
   editing our own scripts (unlike the PATH issue, which `preflight.sh` already
   works around by avoiding `npx`).

## Why this blocks wave 1+
Every wave-1-through-6 gate in `tasks.json` that runs `npm test` will fail this
way regardless of whether the code under test is correct. `npm run e2e`
(Playwright) may hit related path/URL issues too, untested. This is not a
harness bug I can script around — the underlying tool breaks on this specific
path shape.

## What I need from Tyler
The clean fix is renaming the repo's containing directory to remove the colon
(e.g. `Groundwork-crm : REPO` -> `Groundwork-crm-REPO`, or move it out from
under `Desktop/Groundwork CRM/` entirely). I have **not** done this — it changes
the repo's location on disk, which could affect open editor windows, Finder
aliases, or other tooling (e.g. `ecosystem.config.cjs` / pm2, if it references
an absolute path), and Tyler's own standing policy for this session says to stop
before renames. Need an explicit go-ahead and the new path to use before wave 1
testing can proceed for real.
