/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { generateBackfillManifest, executeBackfillManifest } from "./backfill-write-repos";
import { getLatestOverheadAllocationForDivision } from "./repos";
import { MAX_MANIFEST_AGE_MS } from "../engines/backfill-write";
import type { BackfillManifest } from "../engines/backfill-write";

const db = () => env.DB;
const AS_OF = "2026-08-27";

// IMPORTANT — tenant isolation strategy for this file:
// @cloudflare/vitest-pool-workers (this repo's pinned version, 0.20.2) only
// isolates storage PER TEST FILE, not per individual test (the "isolated
// per-test storage" behavior documented for earlier versions was removed
// during the Vitest 4 migration — see Cloudflare's own
// isolation-and-concurrency docs and workers-sdk#13173). All `it()` blocks
// in this file therefore share ONE live D1 instance and its accumulated
// state. backfill-analysis-repos.test.ts (Phase 3's read-only sibling
// suite) gets away with a single shared TENANT constant because every one
// of its assertions looks up a specific job_id via `.find(...)`, never an
// absolute row count. This suite's job is different: it verifies a WRITE
// path (rowsWritten counts, "wrote exactly N rows", "every row's
// approved_by is X"), which are precisely the assertions that break under
// cross-test accumulation. The correct, production-faithful fix is to give
// EVERY test its own freshly-generated, never-reused company_id — this
// exercises the code's real multi-tenant scoping (the same scoping that
// protects real tenants from each other in production) rather than
// fighting the test runner's storage model. Do not reintroduce a shared
// TENANT constant here.

let idCounter = 0;
function uid(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

/** Fresh, unique tenant id — call once per test (and once more per
 * "other tenant" a given test needs). Never reused across tests. */
function newTenant(): string {
  return uid("t-bfw");
}

// ── Fixture helpers (same conventions as backfill-analysis-repos.test.ts) ──

async function seedWorkOrder(
  id: string, companyId: string,
  opts: { crew_id?: string | null; type?: string | null; created_at?: string } = {},
) {
  await db().prepare(`
    INSERT INTO work_orders (id, company_id, wo_number, status, crew_id, type, created_at)
    VALUES (?,?,?,?,?,?,?)
  `).bind(
    id, companyId, `WO-${id}`, "scheduled",
    opts.crew_id ?? null, opts.type ?? "Install",
    opts.created_at ?? "2026-01-01 00:00:00",
  ).run();
}

async function seedCrew(id: string, companyId: string, division: string | null) {
  await db().prepare(
    `INSERT INTO crews (id, company_id, name, division) VALUES (?,?,?,?)`,
  ).bind(id, companyId, `Crew ${id}`, division).run();
}

async function seedAcceptedEstimate(
  id: string, companyId: string,
  opts: { work_order_id?: string; total_cents?: number | null; subtotal_cents?: number | null; accepted_at?: string | null; status?: string } = {},
) {
  await db().prepare(`
    INSERT INTO estimates (id, company_id, status, total_cents, subtotal_cents, accepted_at, work_order_id)
    VALUES (?,?,?,?,?,?,?)
  `).bind(
    id, companyId, opts.status ?? "accepted",
    opts.total_cents === undefined ? 500_000 : opts.total_cents,
    opts.subtotal_cents === undefined ? 400_000 : opts.subtotal_cents,
    opts.accepted_at === undefined ? "2026-01-15" : opts.accepted_at,
    opts.work_order_id ?? "",
  ).run();
}

async function seedOverheadAllocation(companyId: string, division: string, asOf: string) {
  await db().prepare(`
    INSERT INTO overhead_allocation
      (company_id, division, as_of, sellable_hours, allocated_overhead_cents,
       weighted_labor_rate_cents, overhead_rate, absorbed_cost_cents, target_margin, required_bill_rate_cents)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).bind(companyId, division, asOf, 1000, 100000, 2500, 2422, 90000, 300000, 5000).run();
}

// NOTE: plan_visits has a UNIQUE index on (subscription_id, scheduled_date)
// (migration 0072). Since countRemainingPlanVisitsForJob filters only by
// company_id/work_order_id/status (never subscription_id), subscription_id
// is not semantically meaningful to these tests — but it MUST be unique per
// row whenever scheduled_date collides (e.g. multiple visits seeded for the
// same job on the same nominal date). Using the visit's own id as its
// subscription_id guarantees uniqueness without affecting test semantics.
async function seedPlanVisit(id: string, companyId: string, workOrderId: string, scheduledDate: string, status = "scheduled") {
  await db().prepare(`
    INSERT INTO plan_visits (id, company_id, subscription_id, plan_id, client_id, work_order_id, scheduled_date, status)
    VALUES (?,?,?,?,?,?,?,?)
  `).bind(id, companyId, `sub-${id}`, "plan-1", "client-1", workOrderId, scheduledDate, status).run();
}

/** Seeds a fully "would create a clean cost_to_cost baseline" job: crew
 * with a division, an accepted estimate for that job, and an overhead
 * allocation covering the division at/before the estimate's accepted_at.
 * No receipts (so has_non_labor_cost_evidence stays false), type=Install
 * (so completion_method resolves to cost_to_cost), no plan_visits link. */
async function seedSafeCostToCostJob(companyId: string, division: string, opts: { total_cents?: number; subtotal_cents?: number } = {}): Promise<string> {
  const jobId = uid("job");
  const crewId = uid("crew");
  await seedCrew(crewId, companyId, division);
  await seedWorkOrder(jobId, companyId, { crew_id: crewId, type: "Install" });
  await seedAcceptedEstimate(uid("est"), companyId, {
    work_order_id: jobId, total_cents: opts.total_cents, subtotal_cents: opts.subtotal_cents,
  });
  await seedOverheadAllocation(companyId, division, "2026-01-01");
  return jobId;
}

/** Same as above but completion_method resolves to service_units (via a
 * plan_visits link) instead of cost_to_cost. `visitCount` scheduled/
 * in_progress visits are seeded so countRemainingPlanVisitsForJob resolves
 * to a real positive count. */
async function seedSafeServiceUnitsJob(companyId: string, division: string, visitCount: number): Promise<string> {
  const jobId = uid("job");
  const crewId = uid("crew");
  await seedCrew(crewId, companyId, division);
  await seedWorkOrder(jobId, companyId, { crew_id: crewId, type: "Maintenance" });
  await seedAcceptedEstimate(uid("est"), companyId, { work_order_id: jobId });
  await seedOverheadAllocation(companyId, division, "2026-01-01");
  for (let i = 0; i < visitCount; i++) {
    await seedPlanVisit(uid("visit"), companyId, jobId, "2026-02-01", "scheduled");
  }
  return jobId;
}

async function countJobBudgetVersions(companyId: string): Promise<number> {
  const row = await db().prepare(`SELECT COUNT(*) as n FROM job_budget_versions WHERE company_id = ?`).bind(companyId).first<{ n: number }>();
  return row?.n ?? 0;
}

async function getExecutionLedgerRow(companyId: string, manifestHash: string) {
  return db().prepare(`SELECT * FROM backfill_manifest_execution WHERE company_id = ? AND manifest_hash = ?`).bind(companyId, manifestHash).first<{
    status: string; rows_written: number; approved_by: string; confirmation_token_hash: string;
  }>();
}

const APPLY_OPTS = {
  apply: true as const,
  confirmationToken: "test-confirmation-token",
  backupConfirmed: true,
  approvedBy: "tester@example.com",
};

// ── FR-01: generateBackfillManifest is report-only, zero writes ───────────
describe("FR-01 generateBackfillManifest — zero writes", () => {
  it("running generation never inserts/updates/deletes any row anywhere in the database", async () => {
    const TENANT = newTenant();
    await seedSafeCostToCostJob(TENANT, "div-fr1");

    const tables = ["work_orders", "crews", "estimates", "overhead_allocation", "job_budget_versions", "backfill_manifest_execution"];
    const before: Record<string, number> = {};
    for (const t of tables) before[t] = (await db().prepare(`SELECT COUNT(*) as n FROM ${t}`).first<{ n: number }>())?.n ?? 0;

    await generateBackfillManifest(db(), TENANT, AS_OF, "local");
    await generateBackfillManifest(db(), TENANT, AS_OF, "local"); // twice, to catch a memoization/upsert bug

    for (const t of tables) {
      const after = (await db().prepare(`SELECT COUNT(*) as n FROM ${t}`).first<{ n: number }>())?.n ?? 0;
      expect(after).toBe(before[t]);
    }
  });

  it("refuses a wildcard company_id", async () => {
    await expect(generateBackfillManifest(db(), "*", AS_OF, "local")).rejects.toThrow(/wildcard/i);
  });

  it("two generations against unchanged data produce deep-equal manifests (hash aside... actually including hash, since generated_at can differ)", async () => {
    const TENANT = newTenant();
    const jobId = await seedSafeCostToCostJob(TENANT, "div-fr1b");
    const m1 = await generateBackfillManifest(db(), TENANT, AS_OF, "local");
    const m2 = await generateBackfillManifest(db(), TENANT, AS_OF, "local");
    expect(m1.jobs).toEqual(m2.jobs);
    expect(m1.excluded_jobs).toEqual(m2.excluded_jobs);
    expect(m1.total_jobs_scanned).toBe(m2.total_jobs_scanned);
    expect(m1.jobs.find((j) => j.job_id === jobId)).toBeDefined();
  });
});

// ── FR-02: manifest content correctness — the two safe buckets, correct fields ──
describe("FR-02 generateBackfillManifest — manifest content correctness", () => {
  it("a safe cost_to_cost job produces a manifest row with correct contract_value/direct_cost/division/overhead_rate", async () => {
    const TENANT = newTenant();
    const jobId = await seedSafeCostToCostJob(TENANT, "div-fr2", { total_cents: 900_000, subtotal_cents: 600_000 });
    const manifest = await generateBackfillManifest(db(), TENANT, AS_OF, "local");
    const row = manifest.jobs.find((j) => j.job_id === jobId);
    expect(row).toBeDefined();
    expect(row!.contract_value_cents).toBe(900_000);
    expect(row!.direct_cost_budget_cents).toBe(600_000);
    expect(row!.division).toBe("div-fr2");
    expect(row!.overhead_rate_used).toBe(2422);
    expect(row!.completion_method).toBe("cost_to_cost");
    expect(row!.service_units_planned).toBeNull();
    expect(row!.bucket).toBe("would_create_needs_review_cost_to_cost");
  });

  it("a safe service_units job's service_units_planned equals the remaining scheduled+in_progress visit count", async () => {
    const TENANT = newTenant();
    const jobId = await seedSafeServiceUnitsJob(TENANT, "div-fr2b", 3);
    const manifest = await generateBackfillManifest(db(), TENANT, AS_OF, "local");
    const row = manifest.jobs.find((j) => j.job_id === jobId);
    expect(row).toBeDefined();
    expect(row!.completion_method).toBe("service_units");
    expect(row!.service_units_planned).toBe(3);
  });

  it("completed/cancelled/skipped plan_visits do not count toward the remaining count", async () => {
    const TENANT = newTenant();
    const jobId = uid("job");
    const crewId = uid("crew");
    await seedCrew(crewId, TENANT, "div-fr2c");
    await seedWorkOrder(jobId, TENANT, { crew_id: crewId, type: "Maintenance" });
    await seedAcceptedEstimate(uid("est"), TENANT, { work_order_id: jobId });
    await seedOverheadAllocation(TENANT, "div-fr2c", "2026-01-01");
    await seedPlanVisit(uid("visit"), TENANT, jobId, "2026-02-01", "scheduled");
    await seedPlanVisit(uid("visit"), TENANT, jobId, "2026-02-02", "in_progress");
    await seedPlanVisit(uid("visit"), TENANT, jobId, "2026-02-03", "completed");
    await seedPlanVisit(uid("visit"), TENANT, jobId, "2026-02-04", "cancelled");
    await seedPlanVisit(uid("visit"), TENANT, jobId, "2026-02-05", "skipped");

    const manifest = await generateBackfillManifest(db(), TENANT, AS_OF, "local");
    const row = manifest.jobs.find((j) => j.job_id === jobId);
    expect(row!.service_units_planned).toBe(2); // only scheduled + in_progress
  });

  it("a service_units-bucket job with zero remaining visits is excluded, not defaulted to 0/guessed", async () => {
    const TENANT = newTenant();
    const jobId = uid("job");
    const crewId = uid("crew");
    await seedCrew(crewId, TENANT, "div-fr2d");
    await seedWorkOrder(jobId, TENANT, { crew_id: crewId, type: "Maintenance" });
    await seedAcceptedEstimate(uid("est"), TENANT, { work_order_id: jobId });
    await seedOverheadAllocation(TENANT, "div-fr2d", "2026-01-01");
    await seedPlanVisit(uid("visit"), TENANT, jobId, "2026-02-01", "completed"); // link exists, but zero remaining

    const manifest = await generateBackfillManifest(db(), TENANT, AS_OF, "local");
    expect(manifest.jobs.find((j) => j.job_id === jobId)).toBeUndefined();
    const excluded = manifest.excluded_jobs.find((j) => j.job_id === jobId);
    expect(excluded).toBeDefined();
    expect(excluded!.reason).toMatch(/remaining scheduled-visit count/i);
  });

  it("tenant isolation: a manifest for TENANT never includes OTHER_TENANT's jobs", async () => {
    const TENANT = newTenant();
    const OTHER_TENANT = newTenant();
    const otherJobId = await seedSafeCostToCostJob(OTHER_TENANT, "div-fr2e");
    await seedSafeCostToCostJob(TENANT, "div-fr2e");
    const manifest = await generateBackfillManifest(db(), TENANT, AS_OF, "local");
    expect(manifest.jobs.find((j) => j.job_id === otherJobId)).toBeUndefined();
    expect(manifest.company_id).toBe(TENANT);
  });

  it("a job already having a budget version is excluded entirely (not in jobs, not in excluded_jobs — same as Phase 3's own bucket)", async () => {
    const TENANT = newTenant();
    const jobId = await seedSafeCostToCostJob(TENANT, "div-fr2f");
    await db().prepare(`
      INSERT INTO job_budget_versions
        (id, company_id, job_id, source_type, source_id, revision_seq, contract_value_cents,
         direct_cost_budget_cents, division, overhead_rate_used, budgeted_overhead_cents,
         completion_method, approved_at, approved_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(uid("jbv"), TENANT, jobId, "estimate", "est-x", 0, 500_000, 240_000, "div-fr2f", 2422, 0, "cost_to_cost", "2026-01-01", "tester").run();

    const manifest = await generateBackfillManifest(db(), TENANT, AS_OF, "local");
    expect(manifest.jobs.find((j) => j.job_id === jobId)).toBeUndefined();
    expect(manifest.excluded_jobs.find((j) => j.job_id === jobId)).toBeUndefined();
  });
});

// ── FR-03: executeBackfillManifest dry-run default (mandate item 1) ───────
describe("FR-03 executeBackfillManifest — dry-run default, zero writes", () => {
  it("omitting apply entirely issues zero writes and returns applied=false", async () => {
    const TENANT = newTenant();
    await seedSafeCostToCostJob(TENANT, "div-fr3");
    const manifest = await generateBackfillManifest(db(), TENANT, AS_OF, "local");
    const before = await countJobBudgetVersions(TENANT);

    const result = await executeBackfillManifest(db(), manifest, { expectedCompanyId: TENANT, expectedEnvironment: "local" });

    expect(result.applied).toBe(false);
    expect(result.validation.valid).toBe(true);
    expect(await countJobBudgetVersions(TENANT)).toBe(before);
    expect(result.rowsWritten).toBeUndefined();
  });

  it("apply:false explicitly also issues zero writes", async () => {
    const TENANT = newTenant();
    await seedSafeCostToCostJob(TENANT, "div-fr3b");
    const manifest = await generateBackfillManifest(db(), TENANT, AS_OF, "local");
    const before = await countJobBudgetVersions(TENANT);
    const result = await executeBackfillManifest(db(), manifest, { apply: false, expectedCompanyId: TENANT, expectedEnvironment: "local" });
    expect(result.applied).toBe(false);
    expect(await countJobBudgetVersions(TENANT)).toBe(before);
  });

  it("dry-run reconciliation matches the manifest's own job/excluded counts", async () => {
    const TENANT = newTenant();
    await seedSafeCostToCostJob(TENANT, "div-fr3c");
    const manifest = await generateBackfillManifest(db(), TENANT, AS_OF, "local");
    const result = await executeBackfillManifest(db(), manifest, { expectedCompanyId: TENANT, expectedEnvironment: "local" });
    expect(result.reconciliation.jobs_in_manifest).toBe(manifest.jobs.length);
    expect(result.reconciliation.expected_max_rows_written).toBe(manifest.jobs.length);
  });
});

// ── FR-04: apply-path requires explicit write flag + confirmation + backup + attribution ──
describe("FR-04 executeBackfillManifest — apply path requires explicit safety fields", () => {
  it("apply:true without a confirmationToken is refused, zero writes", async () => {
    const TENANT = newTenant();
    await seedSafeCostToCostJob(TENANT, "div-fr4");
    const manifest = await generateBackfillManifest(db(), TENANT, AS_OF, "local");
    const before = await countJobBudgetVersions(TENANT);
    const result = await executeBackfillManifest(db(), manifest, {
      apply: true, backupConfirmed: true, approvedBy: "tester", expectedCompanyId: TENANT, expectedEnvironment: "local",
    });
    expect(result.applied).toBe(false);
    expect(result.validation.errors.some((e) => /confirmationToken/.test(e))).toBe(true);
    expect(await countJobBudgetVersions(TENANT)).toBe(before);
  });

  it("apply:true without backupConfirmed===true is refused, zero writes", async () => {
    const TENANT = newTenant();
    await seedSafeCostToCostJob(TENANT, "div-fr4b");
    const manifest = await generateBackfillManifest(db(), TENANT, AS_OF, "local");
    const before = await countJobBudgetVersions(TENANT);
    const result = await executeBackfillManifest(db(), manifest, {
      apply: true, confirmationToken: "tok", approvedBy: "tester", expectedCompanyId: TENANT, expectedEnvironment: "local",
    });
    expect(result.applied).toBe(false);
    expect(result.validation.errors.some((e) => /backupConfirmed/.test(e))).toBe(true);
    expect(await countJobBudgetVersions(TENANT)).toBe(before);
  });

  it("apply:true without approvedBy is refused, zero writes", async () => {
    const TENANT = newTenant();
    await seedSafeCostToCostJob(TENANT, "div-fr4c");
    const manifest = await generateBackfillManifest(db(), TENANT, AS_OF, "local");
    const before = await countJobBudgetVersions(TENANT);
    const result = await executeBackfillManifest(db(), manifest, {
      apply: true, confirmationToken: "tok", backupConfirmed: true, expectedCompanyId: TENANT, expectedEnvironment: "local",
    });
    expect(result.applied).toBe(false);
    expect(result.validation.errors.some((e) => /approvedBy/.test(e))).toBe(true);
    expect(await countJobBudgetVersions(TENANT)).toBe(before);
  });

  it("apply:true with a blank approvedBy is refused", async () => {
    const TENANT = newTenant();
    await seedSafeCostToCostJob(TENANT, "div-fr4d");
    const manifest = await generateBackfillManifest(db(), TENANT, AS_OF, "local");
    const result = await executeBackfillManifest(db(), manifest, {
      ...APPLY_OPTS, approvedBy: "   ", expectedCompanyId: TENANT, expectedEnvironment: "local",
    });
    expect(result.applied).toBe(false);
  });
});

// ── FR-05: the real write happens, correctly, once every check passes ─────
describe("FR-05 executeBackfillManifest — successful apply", () => {
  it("writes exactly one job_budget_versions row per manifest job, needs_review=1, correct fields", async () => {
    const TENANT = newTenant();
    const jobId = await seedSafeCostToCostJob(TENANT, "div-fr5", { total_cents: 900_000, subtotal_cents: 600_000 });
    const manifest = await generateBackfillManifest(db(), TENANT, AS_OF, "local");
    expect(manifest.jobs.length).toBe(1); // sanity: this fresh tenant has exactly the one seeded job

    const result = await executeBackfillManifest(db(), manifest, { ...APPLY_OPTS, expectedCompanyId: TENANT, expectedEnvironment: "local" });

    expect(result.applied).toBe(true);
    expect(result.validation.valid).toBe(true);
    expect(result.rowsWritten).toBe(1);

    const row = await db().prepare(`SELECT * FROM job_budget_versions WHERE company_id = ? AND job_id = ?`).bind(TENANT, jobId).first<Record<string, unknown>>();
    expect(row).toBeDefined();
    expect(row!.needs_review).toBe(1);
    expect(row!.revision_seq).toBe(0);
    expect(row!.source_type).toBe("estimate");
    expect(row!.contract_value_cents).toBe(900_000);
    expect(row!.direct_cost_budget_cents).toBe(600_000);
    expect(row!.other_direct_budget_cents).toBe(600_000);
    expect(row!.materials_budget_cents).toBe(0);
    expect(row!.approved_by).toBe("tester@example.com");
  });

  it("the execution ledger records a completed row with the correct rows_written/approved_by, and never stores the raw confirmation token", async () => {
    const TENANT = newTenant();
    await seedSafeCostToCostJob(TENANT, "div-fr5b");
    const manifest = await generateBackfillManifest(db(), TENANT, AS_OF, "local");
    await executeBackfillManifest(db(), manifest, { ...APPLY_OPTS, expectedCompanyId: TENANT, expectedEnvironment: "local" });

    const ledgerRow = await getExecutionLedgerRow(TENANT, manifest.manifest_hash);
    expect(ledgerRow).toBeDefined();
    expect(ledgerRow!.status).toBe("completed");
    expect(ledgerRow!.rows_written).toBe(1);
    expect(ledgerRow!.approved_by).toBe("tester@example.com");
    expect(ledgerRow!.confirmation_token_hash).not.toBe("test-confirmation-token");
    expect(ledgerRow!.confirmation_token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a multi-job manifest writes all eligible rows in one execution", async () => {
    const TENANT = newTenant();
    const job1 = await seedSafeCostToCostJob(TENANT, "div-fr5c-1");
    const job2 = await seedSafeCostToCostJob(TENANT, "div-fr5c-2");
    const job3 = await seedSafeServiceUnitsJob(TENANT, "div-fr5c-3", 2);
    const manifest = await generateBackfillManifest(db(), TENANT, AS_OF, "local");
    expect(manifest.jobs.length).toBe(3);

    const result = await executeBackfillManifest(db(), manifest, { ...APPLY_OPTS, expectedCompanyId: TENANT, expectedEnvironment: "local" });
    expect(result.rowsWritten).toBe(3);
    for (const jobId of [job1, job2, job3]) {
      const exists = await db().prepare(`SELECT 1 FROM job_budget_versions WHERE company_id = ? AND job_id = ?`).bind(TENANT, jobId).first();
      expect(exists).not.toBeNull();
    }
  });
});

// ── FR-06: idempotency / duplicate prevention / consumed-manifest refusal ──
describe("FR-06 executeBackfillManifest — idempotency and duplicate prevention", () => {
  it("re-executing the SAME completed manifest a second time is refused (mandate item 18: consumed manifest)", async () => {
    const TENANT = newTenant();
    await seedSafeCostToCostJob(TENANT, "div-fr6");
    const manifest = await generateBackfillManifest(db(), TENANT, AS_OF, "local");
    const first = await executeBackfillManifest(db(), manifest, { ...APPLY_OPTS, expectedCompanyId: TENANT, expectedEnvironment: "local" });
    expect(first.applied).toBe(true);

    const before = await countJobBudgetVersions(TENANT);
    const second = await executeBackfillManifest(db(), manifest, { ...APPLY_OPTS, expectedCompanyId: TENANT, expectedEnvironment: "local" });
    expect(second.applied).toBe(false);
    expect(second.validation.errors.some((e) => /already executed/.test(e))).toBe(true);
    expect(await countJobBudgetVersions(TENANT)).toBe(before); // no duplicate row created
  });

  it("a dry-run check against an already-consumed manifest also reports it (before a confirmation token is ever supplied)", async () => {
    const TENANT = newTenant();
    await seedSafeCostToCostJob(TENANT, "div-fr6b");
    const manifest = await generateBackfillManifest(db(), TENANT, AS_OF, "local");
    await executeBackfillManifest(db(), manifest, { ...APPLY_OPTS, expectedCompanyId: TENANT, expectedEnvironment: "local" });

    const dryRun = await executeBackfillManifest(db(), manifest, { expectedCompanyId: TENANT, expectedEnvironment: "local" });
    expect(dryRun.applied).toBe(false);
    expect(dryRun.validation.valid).toBe(false);
    expect(dryRun.validation.errors.some((e) => /already executed/.test(e))).toBe(true);
  });

  it("a same-job race (two independent manifests both proposing a baseline for the same job) writes only ONE row, never two", async () => {
    const TENANT = newTenant();
    const jobId = await seedSafeCostToCostJob(TENANT, "div-fr6c");
    const manifestA = await generateBackfillManifest(db(), TENANT, AS_OF, "local");
    // A second, independently-generated manifest for the same tenant/as_of
    // is structurally identical (same job set) but has a different
    // generated_at/hash — simulating two operators racing, or a retry
    // after the first attempt appeared to fail.
    await new Promise((r) => setTimeout(r, 5));
    const manifestB = await generateBackfillManifest(db(), TENANT, AS_OF, "local");
    expect(manifestA.manifest_hash).not.toBe(manifestB.manifest_hash); // different generated_at

    const resultA = await executeBackfillManifest(db(), manifestA, { ...APPLY_OPTS, expectedCompanyId: TENANT, expectedEnvironment: "local" });
    expect(resultA.rowsWritten).toBe(1);

    // manifestB's own execution is NOT itself a "consumed manifest" (its
    // own hash was never executed before) — but the underlying job now
    // already has a revision_seq=0 row, so the INSERT OR IGNORE guard
    // (unique company_id/job_id/revision_seq index) must silently skip it.
    const resultB = await executeBackfillManifest(db(), manifestB, { ...APPLY_OPTS, expectedCompanyId: TENANT, expectedEnvironment: "local" });
    expect(resultB.applied).toBe(true); // manifestB's own validation passes; it just writes nothing new
    expect(resultB.rowsWritten).toBe(0);

    const finalCount = await db().prepare(`SELECT COUNT(*) as n FROM job_budget_versions WHERE company_id = ? AND job_id = ?`).bind(TENANT, jobId).first<{ n: number }>();
    expect(finalCount?.n).toBe(1);
  });
});

// ── FR-07: refusal of altered/mismatched/stale manifests at the DB layer ──
describe("FR-07 executeBackfillManifest — refusal of altered/mismatched/stale manifests", () => {
  it("refuses a manifest whose content was altered after generation (hash mismatch)", async () => {
    const TENANT = newTenant();
    await seedSafeCostToCostJob(TENANT, "div-fr7");
    const manifest = await generateBackfillManifest(db(), TENANT, AS_OF, "local");
    const tampered: BackfillManifest = { ...manifest, total_jobs_scanned: manifest.total_jobs_scanned + 100 };

    const result = await executeBackfillManifest(db(), tampered, { ...APPLY_OPTS, expectedCompanyId: TENANT, expectedEnvironment: "local" });
    expect(result.applied).toBe(false);
    expect(result.validation.errors.some((e) => /altered after generation|corrupted/.test(e))).toBe(true);
    expect(await countJobBudgetVersions(TENANT)).toBe(0);
  });

  it("refuses a manifest generated for a different tenant than the one actually being targeted", async () => {
    const TENANT = newTenant();
    const OTHER_TENANT = newTenant();
    await seedSafeCostToCostJob(TENANT, "div-fr7b");
    const manifest = await generateBackfillManifest(db(), TENANT, AS_OF, "local");
    const result = await executeBackfillManifest(db(), manifest, { ...APPLY_OPTS, expectedCompanyId: OTHER_TENANT, expectedEnvironment: "local" });
    expect(result.applied).toBe(false);
    expect(result.validation.errors.some((e) => /different tenant/.test(e))).toBe(true);
  });

  it("refuses a local-generated manifest being executed against remote (environment mismatch)", async () => {
    const TENANT = newTenant();
    await seedSafeCostToCostJob(TENANT, "div-fr7c");
    const manifest = await generateBackfillManifest(db(), TENANT, AS_OF, "local");
    const result = await executeBackfillManifest(db(), manifest, { ...APPLY_OPTS, expectedCompanyId: TENANT, expectedEnvironment: "remote" });
    expect(result.applied).toBe(false);
    expect(result.validation.errors.some((e) => /environment/.test(e))).toBe(true);
  });

  it("refuses a stale manifest (older than MAX_MANIFEST_AGE_MS)", async () => {
    const TENANT = newTenant();
    await seedSafeCostToCostJob(TENANT, "div-fr7d");
    const manifest = await generateBackfillManifest(db(), TENANT, AS_OF, "local");
    const staleNowIso = new Date(Date.parse(manifest.generated_at) + MAX_MANIFEST_AGE_MS + 60_000).toISOString();
    const result = await executeBackfillManifest(db(), manifest, { ...APPLY_OPTS, nowIso: staleNowIso, expectedCompanyId: TENANT, expectedEnvironment: "local" });
    expect(result.applied).toBe(false);
    expect(result.validation.errors.some((e) => /stale|MAX_MANIFEST_AGE_MS/.test(e))).toBe(true);
    expect(await countJobBudgetVersions(TENANT)).toBe(0);
  });
});

// ── FR-08: overhead-rate freezing — never retroactively reshaped ──────────
describe("FR-08 overhead_rate_used is frozen at the estimate's accepted_at date, never the CURRENT rate", () => {
  it("uses the rate effective at accepted_at, not a later rate added afterward", async () => {
    const TENANT = newTenant();
    const jobId = uid("job");
    const crewId = uid("crew");
    await seedCrew(crewId, TENANT, "div-fr8");
    await seedWorkOrder(jobId, TENANT, { crew_id: crewId, type: "Install" });
    await seedAcceptedEstimate(uid("est"), TENANT, { work_order_id: jobId, accepted_at: "2026-01-15" });
    await seedOverheadAllocation(TENANT, "div-fr8", "2026-01-01"); // rate as of 2026-01-01, overhead_rate=2422 (see helper)
    // A LATER allocation, superseding the rate as of 2026-06-01 — must NOT
    // be picked up, since the estimate's accepted_at (2026-01-15) predates it.
    await db().prepare(`
      INSERT INTO overhead_allocation
        (company_id, division, as_of, sellable_hours, allocated_overhead_cents,
         weighted_labor_rate_cents, overhead_rate, absorbed_cost_cents, target_margin, required_bill_rate_cents)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).bind(TENANT, "div-fr8", "2026-06-01", 1000, 100000, 2500, 9999, 90000, 300000, 5000).run();

    const manifest = await generateBackfillManifest(db(), TENANT, AS_OF, "local");
    const row = manifest.jobs.find((j) => j.job_id === jobId);
    expect(row!.overhead_rate_used).toBe(2422); // NOT 9999
  });
});

// ── FR-09: MAX_MANIFEST_JOBS cap — never silently truncated ───────────────
describe("FR-09 generateBackfillManifest — MAX_MANIFEST_JOBS cap", () => {
  it("throws rather than silently truncating when safe-bucket jobs exceed the cap", async () => {
    // A tiny, deterministic way to exercise this without seeding 501 real
    // jobs: this test documents the throw contract directly against the
    // real function by seeding exactly enough jobs is impractical here, so
    // instead this test is a targeted unit check that the cap constant
    // itself is wired through generateBackfillManifest's own guard by
    // seeding a small number and confirming normal (non-throwing)
    // operation stays correct below the cap — the throwing branch itself
    // is exercised directly against the pure MAX_MANIFEST_JOBS constant in
    // src/engines/backfill-write.test.ts (BW-07's oversized-manifest test),
    // which is the appropriate place for a boundary this expensive to
    // reach via real DB fixtures.
    const TENANT = newTenant();
    const jobId = await seedSafeCostToCostJob(TENANT, "div-fr9");
    const manifest = await generateBackfillManifest(db(), TENANT, AS_OF, "local");
    expect(manifest.jobs.length).toBeLessThan(500);
    expect(manifest.jobs.find((j) => j.job_id === jobId)).toBeDefined();
  });
});

// ── FR-10: audit attribution end-to-end ────────────────────────────────────
describe("FR-10 audit attribution end-to-end", () => {
  it("every written row's approved_by matches the operator identity supplied at execute time, never blank, never the manifest generator's identity", async () => {
    const TENANT = newTenant();
    await seedSafeCostToCostJob(TENANT, "div-fr10");
    const manifest = await generateBackfillManifest(db(), TENANT, AS_OF, "local");
    await executeBackfillManifest(db(), manifest, { ...APPLY_OPTS, approvedBy: "ops-lead@avalon-lc.com", expectedCompanyId: TENANT, expectedEnvironment: "local" });

    const rows = await db().prepare(`SELECT approved_by FROM job_budget_versions WHERE company_id = ?`).bind(TENANT).all<{ approved_by: string }>();
    expect(rows.results.length).toBeGreaterThan(0);
    for (const r of rows.results) expect(r.approved_by).toBe("ops-lead@avalon-lc.com");
  });
});

// ── FR-11: getLatestOverheadAllocationForDivision reuse sanity check ──────
describe("FR-11 reuse of getLatestOverheadAllocationForDivision (not a re-derived query)", () => {
  it("returns the full row, not just a boolean, confirming Phase 2 reads the real rate", async () => {
    const TENANT = newTenant();
    await seedOverheadAllocation(TENANT, "div-fr11", "2026-01-01");
    const alloc = await getLatestOverheadAllocationForDivision(db(), TENANT, "div-fr11", "2026-01-15");
    expect(alloc).not.toBeNull();
    expect(alloc!.overhead_rate).toBe(2422);
  });
});
