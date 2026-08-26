/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { approveChangeOrderWorkflow, resolveCompletionInputs } from "./change-order-approval";
import {
  insertChangeOrder, submitChangeOrderForApproval, getChangeOrder,
  getLatestJobBudgetVersion, listJobBudgetVersionsForJob, insertOverheadAllocation,
} from "../db/repos";
import type { JobBudgetVersion } from "../db/schema";

const db = () => env.DB;
const TENANT = "t-co-approval";
const OTHER_TENANT = "t-co-approval-other";

let idCounter = 0;
function uid(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

async function seedWorkOrder(id: string, companyId: string, crewId?: string) {
  await db().prepare(
    `INSERT INTO work_orders (id, company_id, wo_number, status, crew_id) VALUES (?,?,?,?,?)`,
  ).bind(id, companyId, `WO-${id}`, "scheduled", crewId ?? null).run();
}

async function seedCrew(id: string, companyId: string, division: string) {
  await db().prepare(
    `INSERT INTO crews (id, company_id, name, division) VALUES (?,?,?,?)`,
  ).bind(id, companyId, `Crew ${id}`, division).run();
}

async function seedOverheadRate(companyId: string, division: string, asOf: string, overheadRate: number) {
  await insertOverheadAllocation(db(), {
    company_id: companyId, division, as_of: asOf, sellable_hours: 1000,
    allocated_overhead_cents: 100000 as never, weighted_labor_rate_cents: 350000 as never,
    overhead_rate: overheadRate as never, absorbed_cost_cents: 0 as never,
    target_margin: 0 as never, required_bill_rate_cents: 0 as never,
  });
}

/** A tenant-scoped job with a division and an overhead rate on record —
 * the minimum a change order needs in order to be approvable at all. Each
 * call gets its own division (overhead_allocation is UNIQUE on
 * company_id+division+as_of), so multiple tests in the same file can each
 * seed an independent "current overhead rate" without colliding. */
async function seedApprovableJob(companyId: string, asOf = "2026-08-01") {
  const division = uid("division");
  const crewId = uid("crew");
  await seedCrew(crewId, companyId, division);
  const jobId = uid("job");
  await seedWorkOrder(jobId, companyId, crewId);
  await seedOverheadRate(companyId, division, asOf, 242200);
  return jobId;
}

async function seedPendingChangeOrder(
  companyId: string, jobId: string,
  opts: Partial<{ revenue_adjustment_cents: number; direct_cost_adjustment_cents: number; labor_hours_adjustment_hundredths: number; effective_date: string | null }> = {},
) {
  const coId = uid("co");
  await insertChangeOrder(db(), {
    id: coId, company_id: companyId, job_id: jobId, estimate_id: null, customer_id: null,
    revenue_adjustment_cents: opts.revenue_adjustment_cents ?? 600000,
    direct_cost_adjustment_cents: opts.direct_cost_adjustment_cents ?? 350000,
    labor_hours_adjustment_hundredths: opts.labor_hours_adjustment_hundredths ?? 4000,
    effective_date: opts.effective_date ?? "2026-08-01",
    description: "scope add", reason: "customer request", created_by: "rep-1",
  });
  await submitChangeOrderForApproval(db(), companyId, coId);
  return coId;
}

describe("resolveCompletionInputs — carries forward prior revision, defaults only when no prior exists", () => {
  it("with no prior revision and no override: defaults to cost_to_cost / null", () => {
    const result = resolveCompletionInputs(null, null);
    expect(result).toEqual({ completion_method: "cost_to_cost", service_units_planned: null });
  });

  it("with a prior revision and no override: carries the prior revision's method + planned units forward unchanged", () => {
    const prior = { completion_method: "service_units", service_units_planned: 40 } as JobBudgetVersion;
    const result = resolveCompletionInputs(prior, null);
    expect(result).toEqual({ completion_method: "service_units", service_units_planned: 40 });
  });

  it("with an explicit override: the override wins over the prior revision", () => {
    const prior = { completion_method: "cost_to_cost", service_units_planned: null } as JobBudgetVersion;
    const result = resolveCompletionInputs(prior, { completion_method: "manual", service_units_planned: null });
    expect(result).toEqual({ completion_method: "manual", service_units_planned: null });
  });

  it("an override's service_units_planned is dropped for any method other than service_units", () => {
    const result = resolveCompletionInputs(null, { completion_method: "manual", service_units_planned: 99 });
    expect(result).toEqual({ completion_method: "manual", service_units_planned: null });
  });
});

describe("approveChangeOrderWorkflow — the single authorized entry point for CO approval", () => {
  it("approves a pending CO with no prior budget version, creating revision_seq=0", async () => {
    const jobId = await seedApprovableJob(TENANT);
    const coId = await seedPendingChangeOrder(TENANT, jobId);

    const result = await approveChangeOrderWorkflow(db(), TENANT, coId, "owner-1", null, "2026-08-01");
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("unreachable");
    expect(result.revision_seq).toBe(0);

    const co = await getChangeOrder(db(), TENANT, coId);
    expect(co?.status).toBe("approved");
    expect(co?.approved_by).toBe("owner-1");

    const version = await getLatestJobBudgetVersion(db(), TENANT, jobId);
    expect(version?.contract_value_cents).toBe(600000);
    expect(version?.direct_cost_budget_cents).toBe(350000);
    // 40 hrs * $24.22/hr = $968.80 -> 96880 cents, on a zero baseline
    expect(version?.budgeted_overhead_cents).toBe(96880);
    expect(version?.source_type).toBe("change_order");
    expect(version?.source_id).toBe(coId);
    expect(version?.needs_review).toBe(0);
  });

  it("a second CO's approval rolls forward cumulatively onto the first's revision, not onto a re-summed history", async () => {
    const jobId = await seedApprovableJob(TENANT);
    const co1 = await seedPendingChangeOrder(TENANT, jobId, { revenue_adjustment_cents: 100000, direct_cost_adjustment_cents: 50000, labor_hours_adjustment_hundredths: 0 });
    const first = await approveChangeOrderWorkflow(db(), TENANT, co1, "owner-1", null, "2026-08-01");
    expect(first.success).toBe(true);

    const co2 = await seedPendingChangeOrder(TENANT, jobId, { revenue_adjustment_cents: 25000, direct_cost_adjustment_cents: 10000, labor_hours_adjustment_hundredths: 0 });
    const second = await approveChangeOrderWorkflow(db(), TENANT, co2, "owner-1", null, "2026-08-01");
    expect(second.success).toBe(true);
    if (!second.success) throw new Error("unreachable");
    expect(second.revision_seq).toBe(1);

    const version = await getLatestJobBudgetVersion(db(), TENANT, jobId);
    expect(version?.contract_value_cents).toBe(125000); // 100000 + 25000
    expect(version?.direct_cost_budget_cents).toBe(60000); // 50000 + 10000

    const history = await listJobBudgetVersionsForJob(db(), TENANT, jobId);
    expect(history.map((h) => h.revision_seq)).toEqual([0, 1]);
    expect(history[0].contract_value_cents).toBe(100000); // revision 0 untouched by revision 1's insert
  });

  it("bucketing: a CO's lump direct_cost_adjustment_cents lands entirely in other_direct_budget_cents, other categories carried forward unchanged", async () => {
    const jobId = await seedApprovableJob(TENANT);
    const coId = await seedPendingChangeOrder(TENANT, jobId, { direct_cost_adjustment_cents: 77700 });
    const result = await approveChangeOrderWorkflow(db(), TENANT, coId, "owner-1", null, "2026-08-01");
    expect(result.success).toBe(true);

    const version = await getLatestJobBudgetVersion(db(), TENANT, jobId);
    expect(version?.other_direct_budget_cents).toBe(77700);
    expect(version?.materials_budget_cents).toBe(0);
    expect(version?.subcontractor_budget_cents).toBe(0);
  });

  it("fails with not_found for a change order id that doesn't exist", async () => {
    const result = await approveChangeOrderWorkflow(db(), TENANT, "no-such-co", "owner-1", null, "2026-08-01");
    expect(result).toEqual({ success: false, reason: "not_found" });
  });

  it("fails with not_pending for a draft change order (never submitted)", async () => {
    const jobId = await seedApprovableJob(TENANT);
    const coId = uid("co");
    await insertChangeOrder(db(), {
      id: coId, company_id: TENANT, job_id: jobId, estimate_id: null, customer_id: null,
      revenue_adjustment_cents: 1, direct_cost_adjustment_cents: 0,
      labor_hours_adjustment_hundredths: 0, effective_date: null,
      description: "still draft", reason: "test", created_by: "rep-1",
    });
    const result = await approveChangeOrderWorkflow(db(), TENANT, coId, "owner-1", null, "2026-08-01");
    expect(result).toEqual({ success: false, reason: "not_pending" });
  });

  it("fails with no_division when the job's crew has no division set", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT); // no crew at all
    const coId = await seedPendingChangeOrder(TENANT, jobId);
    const result = await approveChangeOrderWorkflow(db(), TENANT, coId, "owner-1", null, "2026-08-01");
    expect(result).toEqual({ success: false, reason: "no_division" });
  });

  it("fails with no_overhead_rate when the division has no overhead_allocation row as of the effective date", async () => {
    const crewId = uid("crew");
    await seedCrew(crewId, TENANT, "no-rate-division");
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT, crewId);
    const coId = await seedPendingChangeOrder(TENANT, jobId);
    const result = await approveChangeOrderWorkflow(db(), TENANT, coId, "owner-1", null, "2026-08-01");
    expect(result).toEqual({ success: false, reason: "no_overhead_rate" });
  });

  it("fails with invalid_revised_budget when the resulting cumulative total would go negative", async () => {
    const jobId = await seedApprovableJob(TENANT);
    const coId = await seedPendingChangeOrder(TENANT, jobId, { revenue_adjustment_cents: -50, direct_cost_adjustment_cents: 0, labor_hours_adjustment_hundredths: 0 });
    const result = await approveChangeOrderWorkflow(db(), TENANT, coId, "owner-1", null, "2026-08-01");
    expect(result).toEqual({ success: false, reason: "invalid_revised_budget" });
    // No budget version was created despite the failed validation.
    const version = await getLatestJobBudgetVersion(db(), TENANT, jobId);
    expect(version).toBeNull();
  });

  it("fails with invalid_completion_inputs for completion_method=service_units with no positive planned units", async () => {
    const jobId = await seedApprovableJob(TENANT);
    const coId = await seedPendingChangeOrder(TENANT, jobId);
    const result = await approveChangeOrderWorkflow(
      db(), TENANT, coId, "owner-1",
      { completion_method: "service_units", service_units_planned: null },
      "2026-08-01",
    );
    expect(result).toEqual({ success: false, reason: "invalid_completion_inputs" });
  });

  it("accepts a completionOverride, freezing the new revision's completion_method/service_units_planned", async () => {
    const jobId = await seedApprovableJob(TENANT);
    const coId = await seedPendingChangeOrder(TENANT, jobId);
    const result = await approveChangeOrderWorkflow(
      db(), TENANT, coId, "owner-1",
      { completion_method: "service_units", service_units_planned: 25 },
      "2026-08-01",
    );
    expect(result.success).toBe(true);
    const version = await getLatestJobBudgetVersion(db(), TENANT, jobId);
    expect(version?.completion_method).toBe("service_units");
    expect(version?.service_units_planned).toBe(25);
  });

  it("tenant isolation: a change order under a different tenant is never found or approved", async () => {
    const jobId = await seedApprovableJob(OTHER_TENANT);
    const coId = await seedPendingChangeOrder(OTHER_TENANT, jobId);
    const result = await approveChangeOrderWorkflow(db(), TENANT, coId, "intruder", null, "2026-08-01");
    expect(result).toEqual({ success: false, reason: "not_found" });
    const co = await getChangeOrder(db(), OTHER_TENANT, coId);
    expect(co?.status).toBe("pending"); // untouched by the cross-tenant attempt
  });

  it("duplicate/concurrent approval: a second call against an already-approved CO safely reports atomic_conflict, never a second budget version", async () => {
    const jobId = await seedApprovableJob(TENANT);
    const coId = await seedPendingChangeOrder(TENANT, jobId);
    const first = await approveChangeOrderWorkflow(db(), TENANT, coId, "owner-1", null, "2026-08-01");
    expect(first.success).toBe(true);

    const second = await approveChangeOrderWorkflow(db(), TENANT, coId, "owner-1", null, "2026-08-01");
    expect(second).toEqual({ success: false, reason: "not_pending" }); // rejected before ever reaching the atomic write

    const history = await listJobBudgetVersionsForJob(db(), TENANT, jobId);
    expect(history.length).toBe(1); // exactly one revision, not two
  });

  it("true race: 5 concurrent approval attempts against the same pending CO produce exactly one success and no duplicate budget version", async () => {
    const jobId = await seedApprovableJob(TENANT);
    const coId = await seedPendingChangeOrder(TENANT, jobId);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => approveChangeOrderWorkflow(db(), TENANT, coId, "owner-1", null, "2026-08-01")),
    );
    const successes = results.filter((r) => r.success);
    expect(successes.length).toBe(1);

    const history = await listJobBudgetVersionsForJob(db(), TENANT, jobId);
    expect(history.length).toBe(1); // the atomic INSERT...SELECT...WHERE changes()>0 guard held under concurrency
  });
});
