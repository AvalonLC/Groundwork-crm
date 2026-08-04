import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "src/ui",
  testMatch: "**/*.e2e.ts",
  // Distinct from the existing tests/ e2e_full.js's own test-results/ dir —
  // that one already had state (.last-run.json) before this session started.
  outputDir: "test-results-finance",
  reporter: [["list"], ["json", { outputFile: "test-results.json" }]],
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
