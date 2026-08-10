/// <reference types="@cloudflare/vitest-pool-workers" />
import { applyD1Migrations, env } from "cloudflare:test";

// Runs once per test file, against a fresh local Miniflare D1 instance —
// never the real database_id configured in wrangler.jsonc. Applies the full
// CRM schema (migrations/*.sql, including 0057_finance_merge.sql) since the
// 2026-08-09 merge put Finance OS's tables in the same database.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
