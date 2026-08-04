import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

const migrationsPath = path.join(__dirname, "migrations/finance");
const migrations = await readD1Migrations(migrationsPath);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Consumed by test/apply-finance-migrations.ts. Local Miniflare D1
        // only — never touches the real database_id in wrangler.jsonc.
        bindings: { TEST_FINANCE_MIGRATIONS: migrations }
      }
    })
  ],
  test: {
    include: ["src/**/*.test.ts"],
    reporters: ["default", "json"],
    outputFile: { json: "./test-results.json" },
    setupFiles: ["./test/apply-finance-migrations.ts"]
  }
});
