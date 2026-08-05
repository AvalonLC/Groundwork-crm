/// <reference types="@cloudflare/vitest-pool-workers" />
import { applyD1Migrations, env } from "cloudflare:test";

// Runs once per test file, against a fresh local Miniflare D1 instance —
// never the real database_id configured in wrangler.jsonc.
await applyD1Migrations(env.FINANCE_DB, env.TEST_FINANCE_MIGRATIONS);
