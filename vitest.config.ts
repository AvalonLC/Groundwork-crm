import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// Since the 2026-08-09 merge (migrations/0057_finance_merge.sql), Finance OS
// tables live in the same database as the CRM's own tables — tests need the
// full CRM schema now (companies, work_orders, time_entries, crews, etc.),
// not just the old Finance-only 5-file subset.
const migrationsPath = path.join(__dirname, "migrations");
const migrations = await readD1Migrations(migrationsPath);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Consumed by test/apply-migrations.ts. Local Miniflare D1
        // only — never touches the real database_id in wrangler.jsonc.
        // TEST_CRON_SECRET is a fixed test-only value for
        // src/api/cron-trigger.test.ts — never the real production secret,
        // which is never checked into this repo.
        bindings: { TEST_MIGRATIONS: migrations, TEST_CRON_SECRET: "vitest-only-secret-not-real" }
      }
    })
  ],
  test: {
    include: ["src/**/*.test.ts"],
    reporters: ["default", "json"],
    outputFile: { json: "./test-results.json" },
    setupFiles: ["./test/apply-migrations.ts"]
  }
});
