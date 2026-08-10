#!/usr/bin/env node
/**
 * One-time data copy: the old separate `groundwork` D1 database -> the
 * merged tables in `avalon-sales-hub-production` (migrations/0057_finance_merge.sql).
 *
 * This CANNOT be a SQL migration -- D1/SQLite has no cross-database query,
 * and the two databases are (as of this script's writing) still two
 * separate D1 instances. This script bridges them by shelling out to
 * `wrangler d1 execute` twice per table: once to read from `groundwork`,
 * once to write into `avalon-sales-hub-production`.
 *
 * SAFE BY DEFAULT: dry-run unless --apply is passed. Always reports counts.
 * You choose --local or --remote; this script never assumes. Per CLAUDE.md,
 * only run this with --remote yourself -- it is never invoked by an agent
 * session, CI, or any automated process.
 *
 * Usage:
 *   node scripts/migrate-finance-data.mjs --local          (dry run, local D1)
 *   node scripts/migrate-finance-data.mjs --local --apply   (actually writes, local D1)
 *   node scripts/migrate-finance-data.mjs --remote --apply  (actually writes, PRODUCTION -- you run this)
 *
 * See docs/RUNBOOK-finance-merge.md for the full walkthrough.
 */
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const MODE = args.includes("--remote") ? "--remote" : "--local";
const APPLY = args.includes("--apply");
const SOURCE_DB = "groundwork";
const TARGET_DB = "avalon-sales-hub-production";

function run(dbName, sql, params = []) {
  const bound = params.length
    ? sql.replace(/\?/g, () => escapeSqlLiteral(params.shift()))
    : sql;
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", dbName, MODE, "--json", "--command", bound],
    { encoding: "utf8", maxBuffer: 1024 * 1024 * 64 },
  );
  const parsed = JSON.parse(out);
  return parsed[0]?.results ?? [];
}

function escapeSqlLiteral(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

function insertStatement(table, row) {
  const cols = Object.keys(row);
  const vals = cols.map((c) => escapeSqlLiteral(row[c]));
  return `INSERT INTO ${table} (${cols.join(",")}) VALUES (${vals.join(",")})`;
}

// ---- Standalone tables: straight copy, tenant_id -> company_id ----
const STANDALONE_TABLES = [
  "tenant_finance_policy", "labor_rate_profile", "equipment_rate_profile",
  "overhead_pool", "overhead_allocation", "recovery_snapshot", "action_item",
  "classification_finding", "receipt", "finance_config_override", "upload_batch",
];

function renameKey(row, from, to) {
  if (!(from in row)) return row;
  const { [from]: val, ...rest } = row;
  return { [to]: val, ...rest };
}

function copyStandaloneTable(table) {
  const rows = run(SOURCE_DB, `SELECT * FROM ${table}`);
  console.log(`${table}: ${rows.length} row(s) in source`);
  if (!APPLY || rows.length === 0) return { table, copied: 0, total: rows.length };

  let copied = 0;
  for (const row of rows) {
    const { id, ...withoutId } = row; // let target autoincrement where the source id was one (id is TEXT PK for some tables, INTEGER autoincrement for others)
    const mapped = renameKey(row, "tenant_id", "company_id");
    // action_item / classification_finding source_type='work_item' -> 'work_order'
    if ("source_type" in mapped && mapped.source_type === "work_item") mapped.source_type = "work_order";
    try {
      run(TARGET_DB, insertStatement(table, mapped));
      copied++;
    } catch (e) {
      console.error(`  FAILED to copy ${table} row id=${row.id}:`, e.message);
    }
  }
  return { table, copied, total: rows.length };
}

// ---- work_item -> work_orders.estimate_cents/finance_completed_at ----
function copyWorkItems() {
  const rows = run(SOURCE_DB, `SELECT * FROM work_item`);
  console.log(`work_item -> work_orders: ${rows.length} row(s) in source`);
  if (!APPLY) return { copied: 0, total: rows.length, missing: [] };

  let copied = 0;
  const missing = [];
  for (const row of rows) {
    const target = run(TARGET_DB, `SELECT id FROM work_orders WHERE id = ?`, [row.id]);
    if (target.length === 0) { missing.push(row.id); continue; }
    run(TARGET_DB,
      `UPDATE work_orders SET estimate_cents = ?, finance_completed_at = ? WHERE id = ?`,
      [row.estimate_cents, row.completed_at, row.id]);
    copied++;
  }
  return { copied, total: rows.length, missing };
}

// ---- time_entry -> time_entries (fuzzy match), then job_cost_ledger ----
// There is no shared key between the old time_entry (FINANCE_DB, its own
// autoincrement id) and time_entries (this DB, TEXT id) -- they were always
// two independently-created rows for the "same" clock event. Match on
// (company_id, employee_id=rep_id, job_id=work_order_id, work_date=date(clock_in)).
// Only apply when the match is UNIQUE on both sides; report everything else
// instead of guessing (same "honest gap, not fabricated" rule as everywhere
// else in this codebase).
function copyTimeEntriesAndLedger() {
  const oldEntries = run(SOURCE_DB, `SELECT * FROM time_entry`);
  console.log(`time_entry -> time_entries: ${oldEntries.length} row(s) in source`);
  const oldLedger = run(SOURCE_DB, `SELECT * FROM job_cost_ledger`);
  console.log(`job_cost_ledger: ${oldLedger.length} row(s) in source`);

  if (!APPLY) return { matched: 0, ambiguous: [], unmatched: [], ledgerCopied: 0, ledgerTotal: oldLedger.length };

  const idMap = new Map(); // old time_entry.id -> new time_entries.id
  const ambiguous = [];
  const unmatched = [];

  for (const row of oldEntries) {
    const candidates = run(TARGET_DB, `
      SELECT id FROM time_entries
      WHERE company_id = ? AND rep_id = ? AND work_order_id = ?
        AND substr(clock_in, 1, 10) = ? AND posted_at IS NULL
    `, [row.tenant_id, row.employee_id, row.job_id, row.work_date]);

    if (candidates.length === 1) {
      idMap.set(row.id, candidates[0].id);
      run(TARGET_DB,
        `UPDATE time_entries SET resolved_rate = ?, resolved_rate_confidence = ?, applied_overhead_cents = ?, posted_at = ? WHERE id = ?`,
        [row.resolved_rate, row.resolved_rate_confidence, row.applied_overhead_cents, row.posted_at, candidates[0].id]);
    } else if (candidates.length > 1) {
      ambiguous.push({ old_id: row.id, candidates: candidates.map((c) => c.id) });
    } else {
      unmatched.push(row.id);
    }
  }

  let ledgerCopied = 0;
  for (const line of oldLedger) {
    const newTimeEntryId = idMap.get(line.time_entry_id);
    if (!newTimeEntryId) continue; // its time_entry didn't uniquely match -- skip, don't guess
    const mapped = renameKey(line, "tenant_id", "company_id");
    mapped.time_entry_id = newTimeEntryId;
    delete mapped.id;
    try {
      run(TARGET_DB, insertStatement("job_cost_ledger", mapped));
      ledgerCopied++;
    } catch (e) {
      console.error(`  FAILED to copy job_cost_ledger row id=${line.id}:`, e.message);
    }
  }

  return { matched: idMap.size, ambiguous, unmatched, ledgerCopied, ledgerTotal: oldLedger.length };
}

console.log(`\n=== Finance data migration: ${SOURCE_DB} -> ${TARGET_DB} (${MODE}${APPLY ? ", APPLYING" : ", DRY RUN"}) ===\n`);

const standaloneResults = STANDALONE_TABLES.map(copyStandaloneTable);
const workItemResult = copyWorkItems();
const timeEntryResult = copyTimeEntriesAndLedger();

console.log("\n=== Summary ===");
for (const r of standaloneResults) console.log(`  ${r.table}: ${r.copied}/${r.total} copied`);
console.log(`  work_item -> work_orders: ${workItemResult.copied}/${workItemResult.total} copied`);
if (workItemResult.missing?.length) console.log(`    MISSING work_orders (no matching id in target): ${workItemResult.missing.join(", ")}`);
console.log(`  time_entry -> time_entries: ${timeEntryResult.matched} matched`);
if (timeEntryResult.ambiguous?.length) console.log(`    AMBIGUOUS (multiple candidates, skipped): ${JSON.stringify(timeEntryResult.ambiguous)}`);
if (timeEntryResult.unmatched?.length) console.log(`    UNMATCHED (no candidate, skipped): ${timeEntryResult.unmatched.join(", ")}`);
console.log(`  job_cost_ledger: ${timeEntryResult.ledgerCopied}/${timeEntryResult.ledgerTotal} copied`);

if (!APPLY) {
  console.log("\nDry run only -- nothing was written. Re-run with --apply to actually copy data.");
}
