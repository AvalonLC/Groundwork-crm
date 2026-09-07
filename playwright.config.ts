import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "src/ui",
  testMatch: "**/*.e2e.ts",
  // Distinct from the existing tests/ e2e_full.js's own test-results/ dir —
  // that one already had state (.last-run.json) before this session started.
  outputDir: "test-results-finance",
  reporter: [["list"], ["json", { outputFile: "test-results.json" }]],
  // Every suite shares ONE database. There is a single dev server on :3100
  // (webServer below) bound to one local D1 file, and the suites seed fixed
  // row ids into it: 'inv-1' is seeded by collections, invoices-payments AND
  // ledger; 'inv-paid' by two of them. Each suite's beforeEach also calls
  // /test/reset-crm, which is a bare DELETE FROM — tenant-blind, so it clears
  // every other suite's rows too.
  //
  // Playwright's default worker count is half the machine's cores, and files
  // are the unit of parallelism. On a 10-core machine that is 5 suites running
  // against that one database at once, which fails three different ways and
  // never names its real cause:
  //
  //   D1_ERROR: UNIQUE constraint failed: invoices.id   (seeded twice)
  //   PC-11 sees 2 of 5 concurrent posts conflict, not 4 (rows swept mid-test)
  //   connect ECONNREFUSED ::1:3100 for every later test (the worker died)
  //
  // The blame always lands on whatever change is in flight rather than on the
  // harness, and it has cost real time on unrelated work more than once.
  //
  // CI has hidden this: ubuntu-latest is 2-core, so Playwright already picks
  // one worker there. It only bites on a developer's larger machine, and it
  // gets far more likely when anything else is running — a `wrangler pages
  // dev` on :3000 against the same .wrangler/state took the parallel run from
  // green to red on 3 of 5 attempts, while serial went 4 for 4.
  //
  // Serial costs almost nothing: 39s against 36s, because these suites are
  // waiting on one server either way. If the fixtures are ever made
  // suite-independent (unique ids AND tenant-scoped resets), this can go back
  // up — tests/e2e-fixture-hygiene.test.mjs EH-04 states that condition.
  workers: 1,
  use: {
    baseURL: "http://localhost:3100"
  },
  // Auto-starts the standalone Finance UI dev server (src/ui/dev-server.ts) —
  // real local D1, no main-app auth stack. See that file for why.
  webServer: {
    command: "./node_modules/.bin/wrangler dev src/ui/dev-server.ts --port 3100 --local",
    url: "http://localhost:3100",
    reuseExistingServer: true,
    timeout: 30_000
  }
});
