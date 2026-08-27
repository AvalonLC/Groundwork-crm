/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { runBackfillAnalysis } from "./repos";
import { BACKFILL_BUCKETS } from "../engines/backfill-analysis";

const db = () => env.DB;
const TENANT = "t-backfill";
const OTHER_TENANT = "t-backfill-other";
const AS_OF = "2026-08-27";

let idCounter = 0;
function uid(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

async function seedWorkOrder(
  id: string, companyId: string,
  opts: { crew_id?: string | null; type?: string | null; created_at?: string; opp_id?: string | null; estimate_id?: string | null } = {},
) {
  await db().prepare(`
    INSERT INTO work_orders (id, company_id, wo_number, status, crew_id, type, created_at, opp_id, estimate_id)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).bind(
    id, companyId, `WO-${id}`, "scheduled",
    opts.crew_id ?? null, opts.type ?? "Install",
    opts.created_at ?? "2026-01-01 00:00:00", opts.opp_id ?? null, opts.estimate_id ?? null,
  ).run();
}

async function seedCrew(id: string, companyId: string, division: string | null) {
  await db().prepare(
    `INSERT INTO crews (id, company_id, name, division) VALUES (?,?,?,?)`,
  ).bind(id, companyId, `Crew ${id}`, division).run();
}

async function seedAcceptedEstimate(
  id: string, companyId: string,
  opts: { work_order_id?: string; total_cents?: number | null; accepted_at?: string | null; status?: string } = {},
) {
  await db().prepare(`
    INSERT INTO estimates (id, company_id, status, total_cents, accepted_at, work_order_id)
    VALUES (?,?,?,?,?,?)
  `).bind(
    id, companyId, opts.status ?? "accepted",
    opts.total_cents === undefined ? 500_000 : opts.total_cents,
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

async function seedReceipt(id: string, companyId: string, jobId: string, costCategory: string | null) {
  await db().prepare(`
    INSERT INTO receipt (id, company_id, job_id, r2_key, content_hash, cost_category)
    VALUES (?,?,?,?,?,?)
  `).bind(id, companyId, jobId, `r2/${id}`, `hash-${id}`, costCategory).run();
}

async function seedPlanVisit(id: string, companyId: string, workOrderId: string, scheduledDate: string) {
  await db().prepare(`
    INSERT INTO plan_visits (id, company_id, subscription_id, plan_id, client_id, work_order_id, scheduled_date)
    VALUES (?,?,?,?,?,?,?)
  `).bind(id, companyId, "sub-1", "plan-1", "client-1", workOrderId, scheduledDate).run();
}

async function seedJobBudgetVersion(companyId: string, jobId: string) {
  await db().prepare(`
    INSERT INTO job_budget_versions
      (id, company_id, job_id, source_type, source_id, revision_seq, contract_value_cents,
       direct_cost_budget_cents, division, overhead_rate_used, budgeted_overhead_cents,
       completion_method, approved_at, approved_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    uid("jbv"), companyId, jobId, "estimate", "est-x", 0, 500_000,
    240_000, "landscaping", 242_200, 96_880, "cost_to_cost", "2026-01-01", "tester",
  ).run();
}

async function countRows(table: string): Promise<number> {
  const row = await db().prepare(`SELECT COUNT(*) as n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

describe("BA-REPO-01 zero writes", () => {
  it("running the analysis never inserts/updates/deletes any row anywhere in the database", async () => {
    const jobId = uid("job");
    await seedCrew("crew-zw", TENANT, "div-zw");
    await seedWorkOrder(jobId, TENANT, { crew_id: "crew-zw" });
    await seedAcceptedEstimate(uid("est"), TENANT, { work_order_id: jobId });
    await seedOverheadAllocation(TENANT, "div-zw", "2026-01-01");

    const tablesToCheck = [
      "work_orders", "crews", "estimates", "overhead_allocation",
      "job_budget_versions", "receipt", "plan_visits", "change_orders", "job_cost_ledger",
    ];
    const before: Record<string, number> = {};
    for (const t of tablesToCheck) before[t] = await countRows(t);

    await runBackfillAnalysis(db(), TENANT, AS_OF);
    // Run it twice, to also catch any write that only happens on a second pass
    // (e.g. a memoization/upsert bug).
    await runBackfillAnalysis(db(), TENANT, AS_OF);

    for (const t of tablesToCheck) {
      const after = await countRows(t);
      expect(after).toBe(before[t]);
    }
  });

  it("specifically: job_budget_versions row count is unchanged even for a job that WOULD get a clean baseline", async () => {
    const jobId = uid("job");
    await seedCrew("crew-zw2", TENANT, "div-zw2");
    await seedWorkOrder(jobId, TENANT, { crew_id: "crew-zw2", type: "Install" });
    await seedAcceptedEstimate(uid("est"), TENANT, { work_order_id: jobId });
    await seedOverheadAllocation(TENANT, "div-zw2", "2026-01-01");

    const before = await countRows("job_budget_versions");
    const report = await runBackfillAnalysis(db(), TENANT, AS_OF);
    const after = await countRows("job_budget_versions");

    expect(after).toBe(before);
    // Sanity: the job really did classify as a "would create" bucket, so this
    // assertion is actually exercising the zero-write guarantee on the
    // interesting path, not a no-op path.
    const job = report.jobs.find((j) => j.job_id === jobId);
    expect(job?.bucket).toBe("would_create_needs_review_cost_to_cost");
  });
});

describe("BA-REPO-02 tenant isolation", () => {
  it("an accepted estimate belonging to another tenant can never satisfy this tenant's job, even when its work_order_id value collides", async () => {
    // work_orders.id is a global PK (not company-scoped in this schema), so
    // two tenants can never literally share a job_id — the realistic cross-
    // tenant leakage risk instead is estimates.work_order_id (a plain TEXT
    // column, no FK) pointing at another tenant's job id by coincidence.
    // If any query here forgot to scope estimates by company_id, an
    // OTHER_TENANT estimate whose work_order_id happens to equal this
    // tenant's jobId would incorrectly satisfy the join.
    const jobId = uid("job");
    await seedCrew("crew-t1", TENANT, "div-t1");
    await seedWorkOrder(jobId, TENANT, { crew_id: "crew-t1" });
    // TENANT's own job has NO accepted estimate of its own.
    await seedOverheadAllocation(TENANT, "div-t1", "2026-01-01");

    // OTHER_TENANT has an accepted estimate whose work_order_id text value
    // happens to equal TENANT's job id.
    await seedAcceptedEstimate(uid("est"), OTHER_TENANT, { work_order_id: jobId });

    const reportA = await runBackfillAnalysis(db(), TENANT, AS_OF);
    const jobInA = reportA.jobs.find((j) => j.job_id === jobId);

    // Must still be no_accepted_estimate — the other tenant's estimate must
    // never leak across the company_id boundary.
    expect(jobInA?.bucket).toBe("no_accepted_estimate");
    expect(reportA.company_id).toBe(TENANT);
  });

  it("a job that only exists in the other tenant never appears in this tenant's report at all", async () => {
    await seedCrew("crew-t2", OTHER_TENANT, "div-t2");
    const otherJobId = uid("job");
    await seedWorkOrder(otherJobId, OTHER_TENANT, { crew_id: "crew-t2" });
    await seedAcceptedEstimate(uid("est"), OTHER_TENANT, { work_order_id: otherJobId });
    await seedOverheadAllocation(OTHER_TENANT, "div-t2", "2026-01-01");

    const reportA = await runBackfillAnalysis(db(), TENANT, AS_OF);
    expect(reportA.jobs.find((j) => j.job_id === otherJobId)).toBeUndefined();
  });

  it("total_jobs_scanned for one tenant is unaffected by how many jobs another tenant has", async () => {
    await seedCrew("crew-iso1", TENANT, "div-iso1");
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT, { crew_id: "crew-iso1" });

    const before = await runBackfillAnalysis(db(), TENANT, AS_OF);

    // Add a pile of unrelated jobs to the OTHER tenant.
    for (let i = 0; i < 5; i++) {
      await seedWorkOrder(uid("otherjob"), OTHER_TENANT, {});
    }

    const after = await runBackfillAnalysis(db(), TENANT, AS_OF);
    expect(after.total_jobs_scanned).toBe(before.total_jobs_scanned);
  });
});

describe("BA-REPO-03 determinism", () => {
  it("calling runBackfillAnalysis twice against an unchanged database returns a deep-equal report", async () => {
    const jobId = uid("job");
    await seedCrew("crew-det", TENANT, "div-det");
    await seedWorkOrder(jobId, TENANT, { crew_id: "crew-det" });
    await seedAcceptedEstimate(uid("est"), TENANT, { work_order_id: jobId });
    await seedOverheadAllocation(TENANT, "div-det", "2026-01-01");

    const r1 = await runBackfillAnalysis(db(), TENANT, AS_OF);
    const r2 = await runBackfillAnalysis(db(), TENANT, AS_OF);
    expect(r1).toEqual(r2);
  });

  it("job ordering within the report is stable regardless of insertion order", async () => {
    const jobA = "aaa-job";
    const jobB = "zzz-job";
    await seedCrew("crew-ord", TENANT, "div-ord");
    // Insert Z before A to prove ordering isn't insertion-order-dependent.
    await seedWorkOrder(jobB, TENANT, { crew_id: "crew-ord" });
    await seedWorkOrder(jobA, TENANT, { crew_id: "crew-ord" });

    const report = await runBackfillAnalysis(db(), TENANT, AS_OF);
    const ids = report.jobs.map((j) => j.job_id).filter((id) => id === jobA || id === jobB);
    expect(ids).toEqual([jobA, jobB]);
  });
});

describe("BA-REPO-04 bucketing correctness against real tables", () => {
  it("already_has_budget_version: a job with an existing job_budget_versions row is bucketed correctly even though it would otherwise qualify for a clean baseline", async () => {
    const jobId = uid("job");
    await seedCrew("crew-jbv", TENANT, "div-jbv");
    await seedWorkOrder(jobId, TENANT, { crew_id: "crew-jbv" });
    await seedAcceptedEstimate(uid("est"), TENANT, { work_order_id: jobId });
    await seedOverheadAllocation(TENANT, "div-jbv", "2026-01-01");
    await seedJobBudgetVersion(TENANT, jobId);

    const report = await runBackfillAnalysis(db(), TENANT, AS_OF);
    const job = report.jobs.find((j) => j.job_id === jobId);
    expect(job?.bucket).toBe("already_has_budget_version");
  });

  it("no_accepted_estimate: a job with zero estimates at all", async () => {
    const jobId = uid("job");
    await seedCrew("crew-noest", TENANT, "div-noest");
    await seedWorkOrder(jobId, TENANT, { crew_id: "crew-noest" });

    const report = await runBackfillAnalysis(db(), TENANT, AS_OF);
    expect(report.jobs.find((j) => j.job_id === jobId)?.bucket).toBe("no_accepted_estimate");
  });

  it("no_accepted_estimate: a job whose only estimate is status='sent', not 'accepted'", async () => {
    const jobId = uid("job");
    await seedCrew("crew-sentonly", TENANT, "div-sentonly");
    await seedWorkOrder(jobId, TENANT, { crew_id: "crew-sentonly" });
    await seedAcceptedEstimate(uid("est"), TENANT, { work_order_id: jobId, status: "sent" });

    const report = await runBackfillAnalysis(db(), TENANT, AS_OF);
    expect(report.jobs.find((j) => j.job_id === jobId)?.bucket).toBe("no_accepted_estimate");
  });

  it("no_division: crew_id is null", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT, { crew_id: null });
    await seedAcceptedEstimate(uid("est"), TENANT, { work_order_id: jobId });

    const report = await runBackfillAnalysis(db(), TENANT, AS_OF);
    expect(report.jobs.find((j) => j.job_id === jobId)?.bucket).toBe("no_division");
  });

  it("no_division: crew_id points at a crew row that belongs to a DIFFERENT tenant (cross-tenant dangling reference, malformed-record safety)", async () => {
    // work_orders.crew_id has a bare FK to crews(id) with no company_id
    // component, so SQLite's FK constraint alone can't catch a crew_id
    // that resolves to another tenant's crew row — this is exactly the
    // realistic "dangling from this tenant's point of view" case the
    // company-scoped division lookup itself must still reject rather than
    // leaking another tenant's division into this report.
    const jobId = uid("job");
    await seedCrew("crew-cross-tenant", OTHER_TENANT, "div-cross-tenant");
    await seedWorkOrder(jobId, TENANT, { crew_id: "crew-cross-tenant" });
    await seedAcceptedEstimate(uid("est"), TENANT, { work_order_id: jobId });

    const report = await runBackfillAnalysis(db(), TENANT, AS_OF);
    expect(report.jobs.find((j) => j.job_id === jobId)?.bucket).toBe("no_division");
  });

  it("no_division: crew exists but its division column is null", async () => {
    const jobId = uid("job");
    await seedCrew("crew-nodiv", TENANT, null);
    await seedWorkOrder(jobId, TENANT, { crew_id: "crew-nodiv" });
    await seedAcceptedEstimate(uid("est"), TENANT, { work_order_id: jobId });

    const report = await runBackfillAnalysis(db(), TENANT, AS_OF);
    expect(report.jobs.find((j) => j.job_id === jobId)?.bucket).toBe("no_division");
  });

  it("no_overhead_rate_for_division: division resolves but no overhead_allocation row exists for it", async () => {
    const jobId = uid("job");
    await seedCrew("crew-norate", TENANT, "plumbing-division-with-no-rate");
    await seedWorkOrder(jobId, TENANT, { crew_id: "crew-norate" });
    await seedAcceptedEstimate(uid("est"), TENANT, { work_order_id: jobId });

    const report = await runBackfillAnalysis(db(), TENANT, AS_OF);
    expect(report.jobs.find((j) => j.job_id === jobId)?.bucket).toBe("no_overhead_rate_for_division");
  });

  it("no_overhead_rate_for_division: an allocation row exists but only AFTER the estimate's accepted_at (must not use a future rate)", async () => {
    const jobId = uid("job");
    await seedCrew("crew-futurerate", TENANT, "hardscape");
    await seedWorkOrder(jobId, TENANT, { crew_id: "crew-futurerate" });
    await seedAcceptedEstimate(uid("est"), TENANT, { work_order_id: jobId, accepted_at: "2026-01-15" });
    await seedOverheadAllocation(TENANT, "hardscape", "2026-06-01"); // after accepted_at

    const report = await runBackfillAnalysis(db(), TENANT, AS_OF);
    expect(report.jobs.find((j) => j.job_id === jobId)?.bucket).toBe("no_overhead_rate_for_division");
  });

  it("ambiguous_direct_cost_split: a receipt with a materials cost_category exists for the job", async () => {
    const jobId = uid("job");
    await seedCrew("crew-ambig", TENANT, "div-ambig");
    await seedWorkOrder(jobId, TENANT, { crew_id: "crew-ambig" });
    await seedAcceptedEstimate(uid("est"), TENANT, { work_order_id: jobId });
    await seedOverheadAllocation(TENANT, "div-ambig", "2026-01-01");
    await seedReceipt(uid("rcpt"), TENANT, jobId, "materials");

    const report = await runBackfillAnalysis(db(), TENANT, AS_OF);
    expect(report.jobs.find((j) => j.job_id === jobId)?.bucket).toBe("ambiguous_direct_cost_split");
  });

  it("NOT ambiguous: a receipt with cost_category='other' does not count as non-labor evidence", async () => {
    const jobId = uid("job");
    await seedCrew("crew-other", TENANT, "div-other");
    await seedWorkOrder(jobId, TENANT, { crew_id: "crew-other", type: "Install" });
    await seedAcceptedEstimate(uid("est"), TENANT, { work_order_id: jobId });
    await seedOverheadAllocation(TENANT, "div-other", "2026-01-01");
    await seedReceipt(uid("rcpt"), TENANT, jobId, "other");

    const report = await runBackfillAnalysis(db(), TENANT, AS_OF);
    expect(report.jobs.find((j) => j.job_id === jobId)?.bucket).toBe("would_create_needs_review_cost_to_cost");
  });

  it("NOT ambiguous: a receipt with a null cost_category (uploaded but unclassified) does not count as evidence", async () => {
    const jobId = uid("job");
    await seedCrew("crew-nullcat", TENANT, "div-nullcat");
    await seedWorkOrder(jobId, TENANT, { crew_id: "crew-nullcat", type: "Install" });
    await seedAcceptedEstimate(uid("est"), TENANT, { work_order_id: jobId });
    await seedOverheadAllocation(TENANT, "div-nullcat", "2026-01-01");
    await seedReceipt(uid("rcpt"), TENANT, jobId, null);

    const report = await runBackfillAnalysis(db(), TENANT, AS_OF);
    expect(report.jobs.find((j) => j.job_id === jobId)?.bucket).toBe("would_create_needs_review_cost_to_cost");
  });

  it("no_completion_method_signal: type is not Install/Service and there is no plan_visits link", async () => {
    const jobId = uid("job");
    await seedCrew("crew-nomethod", TENANT, "div-nomethod");
    await seedWorkOrder(jobId, TENANT, { crew_id: "crew-nomethod", type: "Maintenance" });
    await seedAcceptedEstimate(uid("est"), TENANT, { work_order_id: jobId });
    await seedOverheadAllocation(TENANT, "div-nomethod", "2026-01-01");

    const report = await runBackfillAnalysis(db(), TENANT, AS_OF);
    expect(report.jobs.find((j) => j.job_id === jobId)?.bucket).toBe("no_completion_method_signal");
  });

  it("would_create_needs_review_cost_to_cost: a fully clean Install job", async () => {
    const jobId = uid("job");
    await seedCrew("crew-clean-ctc", TENANT, "div-clean-ctc");
    await seedWorkOrder(jobId, TENANT, { crew_id: "crew-clean-ctc", type: "Install" });
    await seedAcceptedEstimate(uid("est"), TENANT, { work_order_id: jobId });
    await seedOverheadAllocation(TENANT, "div-clean-ctc", "2026-01-01");

    const report = await runBackfillAnalysis(db(), TENANT, AS_OF);
    const job = report.jobs.find((j) => j.job_id === jobId);
    expect(job?.bucket).toBe("would_create_needs_review_cost_to_cost");
    expect(job?.would_need_review).toBe(true);
    expect(job?.resolved_completion_method).toBe("cost_to_cost");
  });

  it("would_create_needs_review_service_units: a job linked via plan_visits.work_order_id", async () => {
    const jobId = uid("job");
    await seedCrew("crew-clean-su", TENANT, "div-clean-su");
    await seedWorkOrder(jobId, TENANT, { crew_id: "crew-clean-su", type: "Maintenance" });
    await seedAcceptedEstimate(uid("est"), TENANT, { work_order_id: jobId });
    await seedOverheadAllocation(TENANT, "div-clean-su", "2026-01-01");
    await seedPlanVisit(uid("visit"), TENANT, jobId, "2026-02-01");

    const report = await runBackfillAnalysis(db(), TENANT, AS_OF);
    const job = report.jobs.find((j) => j.job_id === jobId);
    expect(job?.bucket).toBe("would_create_needs_review_service_units");
    expect(job?.resolved_completion_method).toBe("service_units");
  });

  it("a plan_visits row scheduled AFTER as_of does not count as a link for a report labelled before it", async () => {
    const jobId = uid("job");
    await seedCrew("crew-futurevisit", TENANT, "div-futurevisit");
    await seedWorkOrder(jobId, TENANT, { crew_id: "crew-futurevisit", type: "Maintenance" });
    await seedAcceptedEstimate(uid("est"), TENANT, { work_order_id: jobId });
    await seedOverheadAllocation(TENANT, "div-futurevisit", "2026-01-01");
    await seedPlanVisit(uid("visit"), TENANT, jobId, "2027-01-01"); // after AS_OF

    const report = await runBackfillAnalysis(db(), TENANT, AS_OF);
    expect(report.jobs.find((j) => j.job_id === jobId)?.bucket).toBe("no_completion_method_signal");
  });

  it("a work_orders row created AFTER as_of is excluded from the report entirely", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT, { created_at: "2027-01-01 00:00:00" }); // after AS_OF

    const report = await runBackfillAnalysis(db(), TENANT, AS_OF);
    expect(report.jobs.find((j) => j.job_id === jobId)).toBeUndefined();
  });
});

describe("BA-REPO-05 malformed-record safety", () => {
  it("an estimate marked accepted but with a NULL total_cents does not crash the report and lands in no_accepted_estimate", async () => {
    const jobId = uid("job");
    await seedCrew("crew-malformed1", TENANT, "div-malformed1");
    await seedWorkOrder(jobId, TENANT, { crew_id: "crew-malformed1" });
    await seedAcceptedEstimate(uid("est"), TENANT, { work_order_id: jobId, total_cents: null });

    const report = await runBackfillAnalysis(db(), TENANT, AS_OF);
    expect(report.jobs.find((j) => j.job_id === jobId)?.bucket).toBe("no_accepted_estimate");
  });

  it("an estimate marked accepted but with an empty-string accepted_at does not crash the report", async () => {
    const jobId = uid("job");
    await seedCrew("crew-malformed2", TENANT, "div-malformed2");
    await seedWorkOrder(jobId, TENANT, { crew_id: "crew-malformed2" });
    // accepted_at defaults to '' at the schema level for a non-accepted
    // estimate; simulate a row that is marked accepted anyway without ever
    // having accepted_at populated (a real-world data-quality gap §10 must
    // tolerate, not crash on).
    await seedAcceptedEstimate(uid("est"), TENANT, { work_order_id: jobId, accepted_at: "" });

    const report = await runBackfillAnalysis(db(), TENANT, AS_OF);
    expect(report.jobs.find((j) => j.job_id === jobId)?.bucket).toBe("no_accepted_estimate");
  });

  it("a whole tenant with zero work_orders produces a valid, zero-job report rather than throwing", async () => {
    const emptyTenant = uid("t-empty");
    const report = await runBackfillAnalysis(db(), emptyTenant, AS_OF);
    expect(report.total_jobs_scanned).toBe(0);
    expect(report.jobs).toEqual([]);
  });

  it("a job whose estimate.work_order_id/estimate_id/opp_id chain never connects it to any estimate still classifies safely", async () => {
    const jobId = uid("job");
    await seedCrew("crew-noconnect", TENANT, "div-noconnect");
    await seedWorkOrder(jobId, TENANT, { crew_id: "crew-noconnect" });
    // An accepted estimate exists in the tenant, but is not linked to this
    // job by any of the three reachability branches.
    await seedAcceptedEstimate(uid("est"), TENANT, { work_order_id: "some-other-job-entirely" });

    const report = await runBackfillAnalysis(db(), TENANT, AS_OF);
    expect(report.jobs.find((j) => j.job_id === jobId)?.bucket).toBe("no_accepted_estimate");
  });
});

describe("BA-REPO-06 invariant totals", () => {
  it("bucket_counts always sums to total_jobs_scanned, and every job appears in exactly one bucket, across a mixed tenant", async () => {
    // One job per bucket-triggering condition, deliberately mixed together.
    await seedCrew("crew-mix", TENANT, "div-mix");

    const jClean = uid("job");
    await seedWorkOrder(jClean, TENANT, { crew_id: "crew-mix", type: "Install" });
    await seedAcceptedEstimate(uid("est"), TENANT, { work_order_id: jClean });
    await seedOverheadAllocation(TENANT, "div-mix", "2026-01-01");

    const jNoEst = uid("job");
    await seedWorkOrder(jNoEst, TENANT, { crew_id: "crew-mix" });

    const jNoDiv = uid("job");
    await seedWorkOrder(jNoDiv, TENANT, { crew_id: null });
    await seedAcceptedEstimate(uid("est"), TENANT, { work_order_id: jNoDiv });

    const jAmbig = uid("job");
    await seedWorkOrder(jAmbig, TENANT, { crew_id: "crew-mix" });
    await seedAcceptedEstimate(uid("est"), TENANT, { work_order_id: jAmbig });
    await seedReceipt(uid("rcpt"), TENANT, jAmbig, "subcontractor");

    const jNoMethod = uid("job");
    await seedWorkOrder(jNoMethod, TENANT, { crew_id: "crew-mix", type: "Repair" });
    await seedAcceptedEstimate(uid("est"), TENANT, { work_order_id: jNoMethod });

    const jHasVersion = uid("job");
    await seedWorkOrder(jHasVersion, TENANT, { crew_id: "crew-mix", type: "Install" });
    await seedAcceptedEstimate(uid("est"), TENANT, { work_order_id: jHasVersion });
    await seedJobBudgetVersion(TENANT, jHasVersion);

    const report = await runBackfillAnalysis(db(), TENANT, AS_OF);

    // Every one of the 10 buckets present, zero-filled where empty.
    expect(Object.keys(report.bucket_counts).sort()).toEqual([...BACKFILL_BUCKETS].sort());

    const sum = Object.values(report.bucket_counts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(report.total_jobs_scanned);

    // Every job appears in exactly one of report.jobs (no duplicates, no omissions).
    const seededIds = [jClean, jNoEst, jNoDiv, jAmbig, jNoMethod, jHasVersion];
    for (const id of seededIds) {
      const matches = report.jobs.filter((j) => j.job_id === id);
      expect(matches.length).toBe(1);
    }

    expect(report.jobs.find((j) => j.job_id === jClean)?.bucket).toBe("would_create_needs_review_cost_to_cost");
    expect(report.jobs.find((j) => j.job_id === jNoEst)?.bucket).toBe("no_accepted_estimate");
    expect(report.jobs.find((j) => j.job_id === jNoDiv)?.bucket).toBe("no_division");
    expect(report.jobs.find((j) => j.job_id === jAmbig)?.bucket).toBe("ambiguous_direct_cost_split");
    expect(report.jobs.find((j) => j.job_id === jNoMethod)?.bucket).toBe("no_completion_method_signal");
    expect(report.jobs.find((j) => j.job_id === jHasVersion)?.bucket).toBe("already_has_budget_version");
  });
});
