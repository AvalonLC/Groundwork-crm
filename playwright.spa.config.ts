import { defineConfig } from "@playwright/test";

/**
 * Separate from playwright.config.ts (which drives the 16 standalone Finance
 * OS *.e2e.ts files against src/ui/dev-server.ts — no SPA shell, no real
 * auth). This config exercises the finance-spa-integration change itself:
 * real browser navigation against the REAL app (src/index.tsx, built and
 * served via `wrangler pages dev`, same code path as production) — sidebar,
 * app_premium.js, session-cookie auth, the whole SPA shell that dev-server.ts
 * doesn't have. testDir is tests/ (not src/ui) and the spec file here does
 * NOT match playwright.config.ts's own "**\/*.e2e.ts" glob (different
 * suffix), so `npm run e2e` never picks this up and the two configs never
 * fight over which webServer owns which port.
 *
 * Deliberately NOT wired into .github/workflows/ci.yml: a real build +
 * `wrangler pages dev` cycle materially lengthens every CI run, and touching
 * the shared CI workflow is a bigger, separate call than this task asked
 * for. Run manually via `npm run e2e:spa` (after `npm run db:migrate:local`
 * has been run at least once, so the migrations/0002_seed_data.sql `tyler`/
 * `avalon` rep+company rows this test logs in as actually exist).
 */
export default defineConfig({
  testDir: "tests",
  testMatch: "finance-spa-nav.spa.ts",
  outputDir: "test-results-spa",
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
  },
  webServer: {
    // Deliberately not `npm run build` — that also runs scripts/bump-version.js,
    // which rewrites every ?v= cache-buster in src/index.tsx (and its persisted
    // counter file) as a side effect. A real `npm run deploy` bumping the
    // version is expected; a local test run silently mutating a tracked source
    // file every time it's run is not. `vite build` alone produces the same
    // dist/ output this test actually needs.
    //
    // Also deliberately NOT `npm run dev:local` (which passes `--d1=DB`):
    // found while wiring this up — `wrangler pages dev dist --d1=DB --local`
    // does NOT resolve to wrangler.jsonc's configured `avalon-sales-hub-production`
    // database, it silently creates an empty, disconnected ad-hoc local D1 named
    // "local-DB" (confirmed via `wrangler pages dev`'s own binding-summary output
    // and a 500 "no such table: reps" on /api/auth/login). Dropping the `--d1=DB`
    // override lets wrangler pages dev resolve the binding from wrangler.jsonc's
    // own d1_databases entry instead, which correctly reaches the same local D1
    // `npm run db:migrate:local` migrates. This is a pre-existing bug in
    // package.json's own dev:local/preview scripts, unrelated to this branch's
    // change — logged in docs/PUNCHLIST.md rather than fixed here (out of scope).
    command: "npx vite build && cp -r public/js/. dist/js/ && echo '{\"version\":1,\"include\":[\"/*\"],\"exclude\":[\"/js/*\"]}' > dist/_routes.json && wrangler pages dev dist --local --ip 0.0.0.0 --port 3000",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
