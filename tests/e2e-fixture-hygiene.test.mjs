/* An e2e suite that seeds CRM rows must also reset them.
 *
 * src/ui/dev-server.ts exposes two resets against the one database:
 * /test/reset clears FINANCE_TABLES, and /test/reset-crm clears the CRM's own
 * work_orders, crews, invoices, payments and time_entries. The finance list
 * deliberately omits work_orders and crews — its own comment says so, and
 * points at reset-crm for them.
 *
 * So a suite that seeds a work order and calls only resetFinanceDb never
 * cleans up. Two did:
 *
 *   receipt-posting.e2e.ts seeds fixed ids ("job-valid", "job-cat", ...), so
 *   the second run on any database died with UNIQUE constraint failed:
 *   work_orders.id. The suite passed exactly once per database, and the nine
 *   resulting failures looked like a regression in whatever change happened to
 *   be in flight — it cost real time on unrelated work more than once.
 *
 *   change-orders.e2e.ts generates unique ids per run, so it never failed. It
 *   just quietly accumulated: 506 stale work orders in one local database by
 *   the time anyone looked.
 *
 * The failure is invisible in the suite that causes it and shows up in whatever
 * runs next, which is the worst possible place for it. This pins the rule.
 *
 * Run: node --test tests/e2e-fixture-hygiene.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const uiDir = new URL('../src/ui/', import.meta.url);
const suites = readdirSync(uiDir).filter(f => f.endsWith('.e2e.ts'));

function read(file) {
  return readFileSync(new URL(file, uiDir), 'utf8');
}

/** Tables /test/reset does NOT clear, so seeding one obliges a resetCrmDb. */
const CRM_ONLY_TABLES = ['work_orders', 'crews', 'time_entries', 'invoices', 'payments'];

/**
 * A CALL, not a mention. Checking for the bare name matches the import line and
 * every comment, so a suite that imports the helper and never calls it looks
 * compliant — this test passed against the real bug until that was fixed.
 */
const CALLS_CRM_RESET = /\bresetCrmDb\s*\(/;
const CALLS_FINANCE_RESET = /\bresetFinanceDb\s*\(/;

test('EH-01 a suite that seeds CRM-only tables also calls resetCrmDb', () => {
  const offenders = [];
  for (const file of suites) {
    const src = read(file);
    const seeded = CRM_ONLY_TABLES.filter(t => new RegExp(`INSERT INTO ${t}\\b`).test(src));
    if (seeded.length && !CALLS_CRM_RESET.test(src)) {
      offenders.push(`${file} (seeds ${seeded.join(', ')})`);
    }
  }
  assert.deepEqual(
    offenders, [],
    `these e2e suites seed CRM tables that /test/reset does not clear, and never ` +
    `call resetCrmDb, so their fixtures survive the run:\n  ${offenders.join('\n  ')}\n` +
    `Add resetCrmDb to the suite's beforeEach, after resetFinanceDb.`,
  );
});

test('EH-02 resets run finance-first, so FK children go before CRM parents', () => {
  // job_cost_ledger.job_id and .time_entry_id are real FKs into work_orders and
  // time_entries (migrations/0057_finance_merge.sql). Clearing the CRM parents
  // first fails the batch on SQLITE_CONSTRAINT_FOREIGNKEY the moment a suite has
  // posted anything. dev-server.ts's reset-crm comment states the same ordering.
  for (const file of suites) {
    const src = read(file);
    if (!CALLS_CRM_RESET.test(src) || !CALLS_FINANCE_RESET.test(src)) continue;
    // Compare first CALL sites, not first mentions — the import line names both
    // and would otherwise decide this comparison.
    assert.ok(
      src.search(CALLS_FINANCE_RESET) < src.search(CALLS_CRM_RESET),
      `${file} calls resetCrmDb before resetFinanceDb — the finance tables hold ` +
      `FKs into work_orders/time_entries, so they must be cleared first`,
    );
  }
});

test('EH-03 the two reset helpers still cover the tables this rule assumes', () => {
  // If someone adds work_orders to FINANCE_TABLES, or drops it from reset-crm,
  // EH-01 silently starts checking the wrong thing.
  const dev = readFileSync(new URL('../src/ui/dev-server.ts', import.meta.url), 'utf8');
  const financeList = dev.slice(dev.indexOf('const FINANCE_TABLES'), dev.indexOf('app.post("/test/reset"'));
  const crmReset = dev.slice(dev.indexOf('app.post("/test/reset-crm"'), dev.indexOf('app.post("/test/exec-crm"'));

  for (const t of CRM_ONLY_TABLES) {
    assert.doesNotMatch(
      financeList, new RegExp(`"${t}"`),
      `${t} is now in FINANCE_TABLES — this file's premise no longer holds`,
    );
    assert.match(
      crmReset, new RegExp(`DELETE FROM ${t}\\b`),
      `/test/reset-crm no longer clears ${t}, so nothing does`,
    );
  }
});

/**
 * Every fixed row id a suite INSERTs into a CRM-only table, mapped to the
 * suites that use it. Scans the text of each INSERT rather than the whole
 * file so that page selectors and test ids — `post-receipt-posted-...` and
 * friends, which share the same lowercase-hyphenated shape — cannot be
 * mistaken for seeded rows.
 */
function sharedFixtureIds() {
  const byId = new Map();
  for (const file of suites) {
    const src = read(file);
    for (const table of CRM_ONLY_TABLES) {
      const statements = src.match(new RegExp(`INSERT INTO ${table}\\b[\\s\\S]{0,600}`, 'g')) ?? [];
      for (const statement of statements) {
        for (const literal of statement.match(/["']([a-z][a-z0-9]*(?:-[a-z0-9]+)+)["']/g) ?? []) {
          const id = literal.slice(1, -1);
          if (!byId.has(id)) byId.set(id, new Set());
          byId.get(id).add(file);
        }
      }
    }
  }
  return [...byId].filter(([, files]) => files.size > 1).map(([id, files]) => [id, [...files]]);
}

test('EH-04 suites sharing a fixture id may not run in parallel against the one database', () => {
  // There is a single dev server on :3100 bound to one local D1 file, and
  // /test/reset-crm is a bare DELETE FROM — tenant-blind. So two suites that
  // seed the same id are not merely racing to insert it; either one's reset
  // sweeps the other's rows out from under a running test.
  //
  // Playwright's default is half the machine's cores, with the FILE as the
  // unit of parallelism, so this is five suites at once on a 10-core laptop.
  // It surfaced as three unrelated-looking failures — UNIQUE constraint failed
  // on invoices.id, PC-11 counting 2 conflicts instead of 4, and ECONNREFUSED
  // on every test after a worker died — none of which name the harness.
  //
  // CI never caught it: ubuntu-latest is 2-core, so Playwright already picks
  // one worker there. It only bites locally, which is the worst place for it.
  //
  // This test retires itself. Give the suites unique ids and tenant-scoped
  // resets and the shared list goes empty, at which point the pin is free to
  // come off and parallelism can come back.
  const shared = sharedFixtureIds();
  if (shared.length === 0) return;

  // Strip comments before matching. The first version of this assertion did
  // not, so `// workers: 1,` satisfied it and the guard passed against the
  // very mutation it exists to catch — the same way EH-01 once passed against
  // a suite that imported resetCrmDb and never called it. A guard has to look
  // at the setting, not at the text of a line about the setting.
  const config = readFileSync(new URL('../playwright.config.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.match(
    config, /\bworkers:\s*1\b/,
    `playwright.config.ts does not pin workers: 1, but these fixture ids are still ` +
    `seeded by more than one suite against the single shared database:\n  ` +
    shared.map(([id, files]) => `${id} — ${files.join(', ')}`).join('\n  ') + `\n` +
    `Either restore the pin, or make the fixtures suite-independent first.`,
  );
});
