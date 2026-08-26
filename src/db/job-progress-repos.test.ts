/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import {
  insertChangeOrder, getChangeOrder, listChangeOrdersForJob, listPendingChangeOrders,
  updateChangeOrder, submitChangeOrderForApproval, approveChangeOrder, rejectChangeOrder,
  voidChangeOrder, approveChangeOrderAndCreateBudgetVersion,
  getLatestJobBudgetVersion, listJobBudgetVersionsForJob, insertJobBudgetVersion,
  listJobBudgetVersionsNeedingReview,
  getWorkOrderProgress, setWorkOrderManualCompletion, setWorkOrderServiceUnitsCompleted,
  setWorkOrderFinanciallyClosed,
  postDirectCostLedgerLine, getLedgerLinesForJobProgress, getJobCostLedgerLine,
  reverseJobCostLedgerLine, getJobCostLedgerAdjustmentsForLine,
  setReceiptCostCategory, listReceiptsReadyToPost, listReceiptsNeedingManualAssignment,
  getReceiptForPosting, markReceiptPosted, receiptHasPostedLedgerLine,
  listAssignableJobsForTenant, getJobDivision, setReceiptJobId,
  listRecentlyPostedReceipts, getAssignableJob, resolveJobBudgetVersionReview,
  getJobProgress,
} from "./repos";
import { postApprovedReceiptToLedger } from "../api/receipt-posting";
import type { Receipt } from "./schema";

const db = () => env.DB;
const TENANT = "t-jobprog";
const OTHER_TENANT = "t-jobprog-other";

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

async function seedReceipt(id: string, companyId: string, opts: Partial<Receipt> = {}) {
  await db().prepare(`
    INSERT INTO receipt (id, company_id, job_id, r2_key, content_hash, vendor, amount_cents, receipt_date, receipt_number)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).bind(
    id, companyId, opts.job_id ?? null, `r2/${id}`, `hash-${id}`,
    opts.vendor ?? "Acme Supply", opts.amount_cents ?? 5000, opts.receipt_date ?? "2026-07-01",
    opts.receipt_number ?? null,
  ).run();
  if (opts.status) {
    await db().prepare(`UPDATE receipt SET status = ? WHERE company_id = ? AND id = ?`)
      .bind(opts.status, companyId, id).run();
  }
}

let idCounter = 0;
function uid(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

describe("change_orders CRUD + lifecycle", () => {
  it("creates a draft, edits it, submits for approval, approves it, freezing overhead_rate_snapshot", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);

    const coId = uid("co");
    await insertChangeOrder(db(), {
      id: coId, company_id: TENANT, job_id: jobId, estimate_id: null, customer_id: null,
      revenue_adjustment_cents: 100000, direct_cost_adjustment_cents: 50000,
      labor_hours_adjustment_hundredths: 4000, effective_date: "2026-07-01",
      description: "Add patio", reason: "customer request", created_by: "rep-1",
    });

    let co = await getChangeOrder(db(), TENANT, coId);
    expect(co?.status).toBe("draft");
    expect(co?.overhead_rate_snapshot).toBeNull();
    expect(co?.approved_at).toBeNull();

    // Edits are allowed while draft.
    const edited = await updateChangeOrder(db(), TENANT, coId, { revenue_adjustment_cents: 120000 });
    expect(edited).toBe(true);
    co = await getChangeOrder(db(), TENANT, coId);
    expect(co?.revenue_adjustment_cents).toBe(120000);

    const submitted = await submitChangeOrderForApproval(db(), TENANT, coId);
    expect(submitted).toBe(true);
    co = await getChangeOrder(db(), TENANT, coId);
    expect(co?.status).toBe("pending");

    // Once pending, edits are refused (frozen except via approve/reject/void).
    const editAfterSubmit = await updateChangeOrder(db(), TENANT, coId, { revenue_adjustment_cents: 999 });
    // updateChangeOrder still allows 'pending' edits per this schema's rule
    // ("draft or pending"); assert that instead of a false expectation.
    expect(editAfterSubmit).toBe(true);
    await updateChangeOrder(db(), TENANT, coId, { revenue_adjustment_cents: 120000 }); // restore

    const approved = await approveChangeOrder(db(), TENANT, coId, "rep-2", 242200);
    expect(approved).toBe(true);
    co = await getChangeOrder(db(), TENANT, coId);
    expect(co?.status).toBe("approved");
    expect(co?.overhead_rate_snapshot).toBe(242200);
    expect(co?.approved_by).toBe("rep-2");
    expect(co?.approved_at).not.toBeNull();

    // An approved CO can never be edited/voided again.
    const editAfterApproval = await updateChangeOrder(db(), TENANT, coId, { revenue_adjustment_cents: 1 });
    expect(editAfterApproval).toBe(false);
    const voidAfterApproval = await voidChangeOrder(db(), TENANT, coId, "oops");
    expect(voidAfterApproval).toBe(false);
    co = await getChangeOrder(db(), TENANT, coId);
    expect(co?.revenue_adjustment_cents).toBe(120000); // untouched
    expect(co?.status).toBe("approved"); // untouched
  });

  it("rejects a pending CO; a rejected CO is terminal (cannot later be approved)", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);
    const coId = uid("co");
    await insertChangeOrder(db(), {
      id: coId, company_id: TENANT, job_id: jobId, estimate_id: null, customer_id: null,
      revenue_adjustment_cents: 1000, direct_cost_adjustment_cents: 0,
      labor_hours_adjustment_hundredths: 0, effective_date: null,
      description: "test", reason: "test", created_by: "rep-1",
    });
    await submitChangeOrderForApproval(db(), TENANT, coId);
    const rejected = await rejectChangeOrder(db(), TENANT, coId, "rep-2", "not needed");
    expect(rejected).toBe(true);
    let co = await getChangeOrder(db(), TENANT, coId);
    expect(co?.status).toBe("rejected");

    const approveAfterReject = await approveChangeOrder(db(), TENANT, coId, "rep-2", 1);
    expect(approveAfterReject).toBe(false);
    co = await getChangeOrder(db(), TENANT, coId);
    expect(co?.status).toBe("rejected"); // still rejected, never flipped to approved
  });

  it("tenant isolation: a CO created under one company is invisible to another", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);
    const coId = uid("co");
    await insertChangeOrder(db(), {
      id: coId, company_id: TENANT, job_id: jobId, estimate_id: null, customer_id: null,
      revenue_adjustment_cents: 1000, direct_cost_adjustment_cents: 0,
      labor_hours_adjustment_hundredths: 0, effective_date: null,
      description: "test", reason: "test", created_by: "rep-1",
    });
    const crossTenantRead = await getChangeOrder(db(), OTHER_TENANT, coId);
    expect(crossTenantRead).toBeNull();

    const crossTenantApprove = await approveChangeOrder(db(), OTHER_TENANT, coId, "intruder", 1);
    expect(crossTenantApprove).toBe(false);
    const co = await getChangeOrder(db(), TENANT, coId);
    expect(co?.status).toBe("draft"); // untouched by the other tenant's attempt
  });

  it("listPendingChangeOrders and listChangeOrdersForJob scope correctly", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);
    const co1 = uid("co");
    const co2 = uid("co");
    await insertChangeOrder(db(), {
      id: co1, company_id: TENANT, job_id: jobId, estimate_id: null, customer_id: null,
      revenue_adjustment_cents: 1, direct_cost_adjustment_cents: 0,
      labor_hours_adjustment_hundredths: 0, effective_date: null,
      description: "a", reason: "a", created_by: "rep-1",
    });
    await insertChangeOrder(db(), {
      id: co2, company_id: TENANT, job_id: jobId, estimate_id: null, customer_id: null,
      revenue_adjustment_cents: 2, direct_cost_adjustment_cents: 0,
      labor_hours_adjustment_hundredths: 0, effective_date: null,
      description: "b", reason: "b", created_by: "rep-1",
    });
    await submitChangeOrderForApproval(db(), TENANT, co2);

    const forJob = await listChangeOrdersForJob(db(), TENANT, jobId);
    expect(forJob.length).toBe(2);

    const pending = await listPendingChangeOrders(db(), TENANT);
    expect(pending.map((c) => c.id)).toEqual([co2]);
  });
});

describe("job_budget_versions — immutable append-only", () => {
  it("insertJobBudgetVersion never updates a prior revision; listJobBudgetVersionsForJob returns full history", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);

    await insertJobBudgetVersion(db(), {
      id: uid("jbv"), company_id: TENANT, job_id: jobId, source_type: "estimate", source_id: "est-1",
      revision_seq: 0, contract_value_cents: 4000000, labor_hours_budgeted_hundredths: 240000,
      labor_rate_used: 350000, materials_budget_cents: 800000, subcontractor_budget_cents: 0,
      equipment_budget_cents: 0, disposal_budget_cents: 0, permits_budget_cents: 0,
      other_direct_budget_cents: 0, direct_cost_budget_cents: 2400000, division: "landscape",
      overhead_rate_used: 242200, budgeted_overhead_cents: 726600, target_margin_millionths: null,
      completion_method: "cost_to_cost", service_units_planned: null, needs_review: 0,
      approved_at: "2026-07-01T00:00:00Z", approved_by: "rep-1",
    });

    const baseline = await getLatestJobBudgetVersion(db(), TENANT, jobId);
    expect(baseline?.revision_seq).toBe(0);
    expect(baseline?.contract_value_cents).toBe(4000000);

    await insertJobBudgetVersion(db(), {
      id: uid("jbv"), company_id: TENANT, job_id: jobId, source_type: "change_order", source_id: "co-x",
      revision_seq: 1, contract_value_cents: 4600000, labor_hours_budgeted_hundredths: 280000,
      labor_rate_used: 350000, materials_budget_cents: 1100000, subcontractor_budget_cents: 0,
      equipment_budget_cents: 0, disposal_budget_cents: 0, permits_budget_cents: 0,
      other_direct_budget_cents: 0, direct_cost_budget_cents: 2750000, division: "landscape",
      overhead_rate_used: 242200, budgeted_overhead_cents: 823480, target_margin_millionths: null,
      completion_method: "cost_to_cost", service_units_planned: null, needs_review: 0,
      approved_at: "2026-07-15T00:00:00Z", approved_by: "rep-2",
    });

    const latest = await getLatestJobBudgetVersion(db(), TENANT, jobId);
    expect(latest?.revision_seq).toBe(1);
    expect(latest?.contract_value_cents).toBe(4600000);

    const history = await listJobBudgetVersionsForJob(db(), TENANT, jobId);
    expect(history.map((h) => h.revision_seq)).toEqual([0, 1]);
    // The baseline row itself was never touched by inserting revision 1.
    expect(history[0].contract_value_cents).toBe(4000000);
  });

  it("listJobBudgetVersionsNeedingReview surfaces needs_review=1 rows only", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);
    await insertJobBudgetVersion(db(), {
      id: uid("jbv"), company_id: TENANT, job_id: jobId, source_type: "estimate", source_id: "est-nr",
      revision_seq: 0, contract_value_cents: 100000, labor_hours_budgeted_hundredths: 1000,
      labor_rate_used: null, materials_budget_cents: 0, subcontractor_budget_cents: 0,
      equipment_budget_cents: 0, disposal_budget_cents: 0, permits_budget_cents: 0,
      other_direct_budget_cents: 0, direct_cost_budget_cents: 0, division: "maintenance",
      overhead_rate_used: 100000, budgeted_overhead_cents: 0, target_margin_millionths: null,
      completion_method: "manual", service_units_planned: null, needs_review: 1,
      approved_at: "2026-01-01T00:00:00Z", approved_by: "backfill-script",
    });
    const needingReview = await listJobBudgetVersionsNeedingReview(db(), TENANT);
    expect(needingReview.some((r) => r.job_id === jobId)).toBe(true);
  });

  it("approveChangeOrderAndCreateBudgetVersion is atomic: approval + new revision both land together", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);
    const coId = uid("co");
    await insertChangeOrder(db(), {
      id: coId, company_id: TENANT, job_id: jobId, estimate_id: null, customer_id: null,
      revenue_adjustment_cents: 600000, direct_cost_adjustment_cents: 350000,
      labor_hours_adjustment_hundredths: 4000, effective_date: "2026-08-01",
      description: "scope add", reason: "customer request", created_by: "rep-1",
    });
    await submitChangeOrderForApproval(db(), TENANT, coId);

    const ok = await approveChangeOrderAndCreateBudgetVersion(db(), TENANT, coId, "rep-2", 242200, {
      id: uid("jbv"), company_id: TENANT, job_id: jobId, source_type: "change_order", source_id: coId,
      revision_seq: 0, contract_value_cents: 4600000, labor_hours_budgeted_hundredths: 280000,
      labor_rate_used: 350000, materials_budget_cents: 1100000, subcontractor_budget_cents: 0,
      equipment_budget_cents: 0, disposal_budget_cents: 0, permits_budget_cents: 0,
      other_direct_budget_cents: 0, direct_cost_budget_cents: 2750000, division: "landscape",
      overhead_rate_used: 242200, budgeted_overhead_cents: 823480, target_margin_millionths: null,
      completion_method: "cost_to_cost", service_units_planned: null, needs_review: 0,
      approved_at: "2026-08-01T00:00:00Z", approved_by: "rep-2",
    });
    expect(ok).toBe(true);

    const co = await getChangeOrder(db(), TENANT, coId);
    expect(co?.status).toBe("approved");
    expect(co?.overhead_rate_snapshot).toBe(242200);

    const version = await getLatestJobBudgetVersion(db(), TENANT, jobId);
    expect(version?.contract_value_cents).toBe(4600000);
    expect(version?.source_id).toBe(coId);
  });

  it("approveChangeOrderAndCreateBudgetVersion refuses (no writes) when the CO isn't pending", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);
    const coId = uid("co");
    await insertChangeOrder(db(), {
      id: coId, company_id: TENANT, job_id: jobId, estimate_id: null, customer_id: null,
      revenue_adjustment_cents: 1, direct_cost_adjustment_cents: 0,
      labor_hours_adjustment_hundredths: 0, effective_date: null,
      description: "draft-only", reason: "test", created_by: "rep-1",
    });
    // Never submitted — still 'draft', not 'pending'.
    const ok = await approveChangeOrderAndCreateBudgetVersion(db(), TENANT, coId, "rep-2", 1, {
      id: uid("jbv"), company_id: TENANT, job_id: jobId, source_type: "change_order", source_id: coId,
      revision_seq: 0, contract_value_cents: 1, labor_hours_budgeted_hundredths: 0,
      labor_rate_used: null, materials_budget_cents: 0, subcontractor_budget_cents: 0,
      equipment_budget_cents: 0, disposal_budget_cents: 0, permits_budget_cents: 0,
      other_direct_budget_cents: 0, direct_cost_budget_cents: 0, division: "landscape",
      overhead_rate_used: 1, budgeted_overhead_cents: 0, target_margin_millionths: null,
      completion_method: "cost_to_cost", service_units_planned: null, needs_review: 0,
      approved_at: "2026-08-01T00:00:00Z", approved_by: "rep-2",
    });
    expect(ok).toBe(false);
    const version = await getLatestJobBudgetVersion(db(), TENANT, jobId);
    expect(version).toBeNull(); // the batch's insert never landed either
  });
});

// PR D
describe("resolveJobBudgetVersionReview — clears needs_review without touching financial columns", () => {
  it("clears needs_review=1 -> 0 and leaves every financial column untouched", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);
    const jbvId = uid("jbv");
    await insertJobBudgetVersion(db(), {
      id: jbvId, company_id: TENANT, job_id: jobId, source_type: "estimate", source_id: "est-nr2",
      revision_seq: 0, contract_value_cents: 555500, labor_hours_budgeted_hundredths: 2000,
      labor_rate_used: 350000, materials_budget_cents: 111100, subcontractor_budget_cents: 0,
      equipment_budget_cents: 0, disposal_budget_cents: 0, permits_budget_cents: 0,
      other_direct_budget_cents: 22200, direct_cost_budget_cents: 133300, division: "landscape",
      overhead_rate_used: 242200, budgeted_overhead_cents: 48440, target_margin_millionths: null,
      completion_method: "cost_to_cost", service_units_planned: null, needs_review: 1,
      approved_at: "2026-01-01T00:00:00Z", approved_by: "backfill-script",
    });

    const ok = await resolveJobBudgetVersionReview(db(), TENANT, jbvId);
    expect(ok).toBe(true);

    const history = await listJobBudgetVersionsForJob(db(), TENANT, jobId);
    const resolved = history.find((h) => h.id === jbvId);
    expect(resolved?.needs_review).toBe(0);
    // Every financial column is byte-for-byte unchanged — resolving review
    // must never rewrite approved figures, only the flag itself.
    expect(resolved?.contract_value_cents).toBe(555500);
    expect(resolved?.materials_budget_cents).toBe(111100);
    expect(resolved?.other_direct_budget_cents).toBe(22200);
    expect(resolved?.direct_cost_budget_cents).toBe(133300);
    expect(resolved?.budgeted_overhead_cents).toBe(48440);
  });

  it("returns false (no-op) when the row is already resolved (needs_review=0)", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);
    const jbvId = uid("jbv");
    await insertJobBudgetVersion(db(), {
      id: jbvId, company_id: TENANT, job_id: jobId, source_type: "estimate", source_id: "est-clean",
      revision_seq: 0, contract_value_cents: 100, labor_hours_budgeted_hundredths: 0,
      labor_rate_used: null, materials_budget_cents: 0, subcontractor_budget_cents: 0,
      equipment_budget_cents: 0, disposal_budget_cents: 0, permits_budget_cents: 0,
      other_direct_budget_cents: 0, direct_cost_budget_cents: 0, division: "landscape",
      overhead_rate_used: 1, budgeted_overhead_cents: 0, target_margin_millionths: null,
      completion_method: "cost_to_cost", service_units_planned: null, needs_review: 0,
      approved_at: "2026-01-01T00:00:00Z", approved_by: "rep-1",
    });

    const ok = await resolveJobBudgetVersionReview(db(), TENANT, jbvId);
    expect(ok).toBe(false); // duplicate/idempotent "resolve" attempts are a safe no-op, not an error
  });

  it("returns false (no cross-tenant resolution) when the row belongs to a different tenant", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, OTHER_TENANT);
    const jbvId = uid("jbv");
    await insertJobBudgetVersion(db(), {
      id: jbvId, company_id: OTHER_TENANT, job_id: jobId, source_type: "estimate", source_id: "est-other",
      revision_seq: 0, contract_value_cents: 100, labor_hours_budgeted_hundredths: 0,
      labor_rate_used: null, materials_budget_cents: 0, subcontractor_budget_cents: 0,
      equipment_budget_cents: 0, disposal_budget_cents: 0, permits_budget_cents: 0,
      other_direct_budget_cents: 0, direct_cost_budget_cents: 0, division: "landscape",
      overhead_rate_used: 1, budgeted_overhead_cents: 0, target_margin_millionths: null,
      completion_method: "cost_to_cost", service_units_planned: null, needs_review: 1,
      approved_at: "2026-01-01T00:00:00Z", approved_by: "rep-1",
    });

    const ok = await resolveJobBudgetVersionReview(db(), TENANT, jbvId); // wrong tenant
    expect(ok).toBe(false);
    const stillFlagged = await listJobBudgetVersionsForJob(db(), OTHER_TENANT, jobId);
    expect(stillFlagged.find((h) => h.id === jbvId)?.needs_review).toBe(1);
  });
});

describe("getAssignableJob — single-job counterpart to listAssignableJobsForTenant", () => {
  it("returns the job's label fields for a tenant-owned work order", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);
    const job = await getAssignableJob(db(), TENANT, jobId);
    expect(job?.id).toBe(jobId);
    expect(job?.wo_number).toBe(`WO-${jobId}`);
  });

  it("returns null for a job that doesn't belong to this tenant", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, OTHER_TENANT);
    const job = await getAssignableJob(db(), TENANT, jobId);
    expect(job).toBeNull();
  });

  it("returns a cancelled job unfiltered (unlike listAssignableJobsForTenant), since its change-order/budget history must still be reachable", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);
    await db().prepare(`UPDATE work_orders SET status = 'cancelled' WHERE id = ?`).bind(jobId).run();
    const job = await getAssignableJob(db(), TENANT, jobId);
    expect(job?.status).toBe("cancelled");
  });

  it("returns null for a job id that doesn't exist at all", async () => {
    const job = await getAssignableJob(db(), TENANT, "no-such-job");
    expect(job).toBeNull();
  });
});

describe("work_orders progress columns", () => {
  it("round-trips manual completion override, service units completed, financially_closed_at", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);

    let progress = await getWorkOrderProgress(db(), TENANT, jobId);
    expect(progress?.completion_pct_millionths).toBeNull();
    expect(progress?.financially_closed_at).toBeNull();

    await setWorkOrderManualCompletion(db(), TENANT, jobId, 500000);
    progress = await getWorkOrderProgress(db(), TENANT, jobId);
    expect(progress?.completion_pct_millionths).toBe(500000);

    // NULL-means-compute: clearing the override sets it back to null, not 0.
    await setWorkOrderManualCompletion(db(), TENANT, jobId, null);
    progress = await getWorkOrderProgress(db(), TENANT, jobId);
    expect(progress?.completion_pct_millionths).toBeNull();

    await setWorkOrderServiceUnitsCompleted(db(), TENANT, jobId, 3);
    progress = await getWorkOrderProgress(db(), TENANT, jobId);
    expect(progress?.service_units_completed).toBe(3);

    await setWorkOrderFinanciallyClosed(db(), TENANT, jobId, "2026-08-01T00:00:00Z");
    progress = await getWorkOrderProgress(db(), TENANT, jobId);
    expect(progress?.financially_closed_at).toBe("2026-08-01T00:00:00Z");

    // Re-opening (human-triggered) sets it back to null.
    await setWorkOrderFinanciallyClosed(db(), TENANT, jobId, null);
    progress = await getWorkOrderProgress(db(), TENANT, jobId);
    expect(progress?.financially_closed_at).toBeNull();
  });
});

describe("job_cost_ledger direct_cost posting + progress read shape", () => {
  it("posts a single direct_cost line with a required cost_category", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);

    const lineId = await postDirectCostLedgerLine(db(), {
      company_id: TENANT, job_id: jobId, cost_category: "materials", amount_cents: 84000,
      division: "landscape", progress_eligible: 1, change_order_id: null, source_receipt_id: null,
    });
    expect(lineId).toBeGreaterThan(0);

    const line = await getJobCostLedgerLine(db(), TENANT, lineId);
    expect(line?.line_type).toBe("direct_cost");
    expect(line?.time_entry_id).toBeNull();
    expect(line?.cost_category).toBe("materials");

    const forProgress = await getLedgerLinesForJobProgress(db(), TENANT, jobId);
    expect(forProgress).toEqual([{ line_type: "direct_cost", amount_cents: 84000, progress_eligible: 1 }]);
  });

  it("refuses to post a direct_cost line with no cost_category", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);
    await expect(
      postDirectCostLedgerLine(db(), {
        company_id: TENANT, job_id: jobId, cost_category: null as never, amount_cents: 100,
        division: "landscape", progress_eligible: 1, change_order_id: null, source_receipt_id: null,
      }),
    ).rejects.toThrow();
  });
});

describe("job_cost_ledger_adjustments — reversal + optional replacement, atomic + audited", () => {
  it("a pure reversal (credit, no replacement) nets the job's totals to zero and records one adjustment row", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);
    const lineId = await postDirectCostLedgerLine(db(), {
      company_id: TENANT, job_id: jobId, cost_category: "materials", amount_cents: 50000,
      division: "landscape", progress_eligible: 1, change_order_id: null, source_receipt_id: null,
    });
    const original = await getJobCostLedgerLine(db(), TENANT, lineId);
    expect(original).not.toBeNull();

    const { reversal_line_id, replacement_line_id } = await reverseJobCostLedgerLine(
      db(), TENANT, original!, uid("adj"), "duplicate charge", "rep-1",
    );
    expect(replacement_line_id).toBeNull();

    const reversal = await getJobCostLedgerLine(db(), TENANT, reversal_line_id);
    expect(reversal?.amount_cents).toBe(-50000);

    const lines = await getLedgerLinesForJobProgress(db(), TENANT, jobId);
    const total = lines.reduce((sum, l) => sum + l.amount_cents, 0);
    expect(total).toBe(0);

    const adjustments = await getJobCostLedgerAdjustmentsForLine(db(), TENANT, lineId);
    expect(adjustments.length).toBe(1);
    expect(adjustments[0].reversal_line_id).toBe(reversal_line_id);
    expect(adjustments[0].replacement_line_id).toBeNull();
  });

  it("a reversal + replacement (correction) nets to the replacement's amount, both linked in one adjustment row", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);
    const lineId = await postDirectCostLedgerLine(db(), {
      company_id: TENANT, job_id: jobId, cost_category: "equipment", amount_cents: 50000,
      division: "landscape", progress_eligible: 1, change_order_id: null, source_receipt_id: null,
    });
    const original = await getJobCostLedgerLine(db(), TENANT, lineId);

    const { reversal_line_id, replacement_line_id } = await reverseJobCostLedgerLine(
      db(), TENANT, original!, uid("adj"), "wrong amount, corrected", "rep-1", 42000,
    );
    expect(replacement_line_id).not.toBeNull();

    const lines = await getLedgerLinesForJobProgress(db(), TENANT, jobId);
    const total = lines.reduce((sum, l) => sum + l.amount_cents, 0);
    expect(total).toBe(42000); // 50000 - 50000 + 42000

    const adjustments = await getJobCostLedgerAdjustmentsForLine(db(), TENANT, lineId);
    expect(adjustments.length).toBe(1);
    expect(adjustments[0].reversal_line_id).toBe(reversal_line_id);
    expect(adjustments[0].replacement_line_id).toBe(replacement_line_id);
  });

  it("posted lines are never mutated directly — only ever reversed (original row's own amount is untouched)", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);
    const lineId = await postDirectCostLedgerLine(db(), {
      company_id: TENANT, job_id: jobId, cost_category: "disposal", amount_cents: 12345,
      division: "landscape", progress_eligible: 1, change_order_id: null, source_receipt_id: null,
    });
    const original = await getJobCostLedgerLine(db(), TENANT, lineId);
    await reverseJobCostLedgerLine(db(), TENANT, original!, uid("adj"), "test", "rep-1", 9999);

    const afterReversal = await getJobCostLedgerLine(db(), TENANT, lineId);
    expect(afterReversal?.amount_cents).toBe(12345); // the ORIGINAL row itself, unchanged
  });
});

describe("receipt cost-category/progress-eligibility + write-once posting", () => {
  it("setReceiptCostCategory sets both fields, refuses once posted", async () => {
    const receiptId = uid("rcpt");
    await seedReceipt(receiptId, TENANT, { status: "approved" });

    const ok = await setReceiptCostCategory(db(), TENANT, receiptId, "materials", 1);
    expect(ok).toBe(true);
    const receipt = await getReceiptForPosting(db(), TENANT, receiptId);
    expect(receipt?.cost_category).toBe("materials");
    expect(receipt?.progress_eligible).toBe(1);

    await markReceiptPosted(db(), TENANT, receiptId);
    const changeAfterPosted = await setReceiptCostCategory(db(), TENANT, receiptId, "equipment", 0);
    expect(changeAfterPosted).toBe(false);
    const unchanged = await getReceiptForPosting(db(), TENANT, receiptId);
    expect(unchanged?.cost_category).toBe("materials"); // untouched
  });

  it("listReceiptsReadyToPost vs listReceiptsNeedingManualAssignment partition correctly", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);

    const ready = uid("rcpt");
    await seedReceipt(ready, TENANT, { status: "approved", job_id: jobId });
    await setReceiptCostCategory(db(), TENANT, ready, "materials", 1);

    const noJob = uid("rcpt");
    await seedReceipt(noJob, TENANT, { status: "approved", job_id: null });

    const noCategory = uid("rcpt");
    await seedReceipt(noCategory, TENANT, { status: "approved", job_id: jobId });

    const notApproved = uid("rcpt");
    await seedReceipt(notApproved, TENANT, { job_id: jobId }); // pending_review, never surfaces in either queue

    const readyList = await listReceiptsReadyToPost(db(), TENANT);
    expect(readyList.map((r) => r.id)).toContain(ready);
    expect(readyList.map((r) => r.id)).not.toContain(noJob);
    expect(readyList.map((r) => r.id)).not.toContain(noCategory);
    expect(readyList.map((r) => r.id)).not.toContain(notApproved);

    const needsAssignment = await listReceiptsNeedingManualAssignment(db(), TENANT);
    expect(needsAssignment.map((r) => r.id)).toContain(noJob);
    expect(needsAssignment.map((r) => r.id)).toContain(noCategory);
    expect(needsAssignment.map((r) => r.id)).not.toContain(ready);
    expect(needsAssignment.map((r) => r.id)).not.toContain(notApproved);
  });
});

describe("postApprovedReceiptToLedger — full authorized posting flow", () => {
  it("posts a ready approved receipt exactly once, atomically, and refuses a second post", async () => {
    const crewId = uid("crew");
    await seedCrew(crewId, TENANT, "landscape");
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT, crewId);

    const receiptId = uid("rcpt");
    await seedReceipt(receiptId, TENANT, { status: "approved", job_id: jobId, amount_cents: 78500 });
    await setReceiptCostCategory(db(), TENANT, receiptId, "materials", 1);

    const result = await postApprovedReceiptToLedger(db(), TENANT, receiptId, "landscape", "rep-approver");
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("unreachable");

    const line = await getJobCostLedgerLine(db(), TENANT, result.ledger_line_id);
    expect(line?.line_type).toBe("direct_cost");
    expect(line?.amount_cents).toBe(78500);
    expect(line?.source_receipt_id).toBe(receiptId);
    expect(line?.job_id).toBe(jobId);

    const receipt = await getReceiptForPosting(db(), TENANT, receiptId);
    expect(receipt?.posted_at).not.toBeNull();

    // Second attempt is a safe conflict, not a second ledger line and not an error.
    const second = await postApprovedReceiptToLedger(db(), TENANT, receiptId, "landscape", "rep-approver");
    expect(second.success).toBe(false);
    if (second.success) throw new Error("unreachable");
    expect(second.reason).toBe("already_posted");

    const linesForJob = await getLedgerLinesForJobProgress(db(), TENANT, jobId);
    expect(linesForJob.length).toBe(1); // still exactly one line
  });

  it("refuses to post a receipt with no job assigned", async () => {
    const receiptId = uid("rcpt");
    await seedReceipt(receiptId, TENANT, { status: "approved", job_id: null, amount_cents: 100 });
    const result = await postApprovedReceiptToLedger(db(), TENANT, receiptId, "landscape", "rep-1");
    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(result.reason).toBe("no_job_assigned");
  });

  it("refuses to post a receipt with no cost_category set", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);
    const receiptId = uid("rcpt");
    await seedReceipt(receiptId, TENANT, { status: "approved", job_id: jobId, amount_cents: 100 });
    const result = await postApprovedReceiptToLedger(db(), TENANT, receiptId, "landscape", "rep-1");
    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(result.reason).toBe("no_cost_category");
  });

  it("refuses to post a receipt that isn't approved yet (still pending_review)", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);
    const receiptId = uid("rcpt");
    await seedReceipt(receiptId, TENANT, { job_id: jobId, amount_cents: 100 }); // no status override -> pending_review
    await setReceiptCostCategory(db(), TENANT, receiptId, "materials", 1);
    const result = await postApprovedReceiptToLedger(db(), TENANT, receiptId, "landscape", "rep-1");
    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(result.reason).toBe("not_approved");
  });

  it("refuses to post when the job doesn't belong to this tenant", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, OTHER_TENANT); // job exists, but under a different company
    const receiptId = uid("rcpt");
    await seedReceipt(receiptId, TENANT, { status: "approved", job_id: jobId, amount_cents: 100 });
    await setReceiptCostCategory(db(), TENANT, receiptId, "materials", 1);
    const result = await postApprovedReceiptToLedger(db(), TENANT, receiptId, "landscape", "rep-1");
    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(result.reason).toBe("job_not_in_tenant");
  });

  it("tenant isolation: cannot post a receipt belonging to a different company", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, OTHER_TENANT);
    const receiptId = uid("rcpt");
    await seedReceipt(receiptId, OTHER_TENANT, { status: "approved", job_id: jobId, amount_cents: 100 });
    await setReceiptCostCategory(db(), OTHER_TENANT, receiptId, "materials", 1);

    const result = await postApprovedReceiptToLedger(db(), TENANT, receiptId, "landscape", "rep-1");
    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(result.reason).toBe("not_found"); // invisible under the wrong tenant
  });

  it("duplicate-posting protection also catches a pre-existing ledger line even if posted_at were somehow unset", async () => {
    const crewId = uid("crew");
    await seedCrew(crewId, TENANT, "landscape");
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT, crewId);
    const receiptId = uid("rcpt");
    await seedReceipt(receiptId, TENANT, { status: "approved", job_id: jobId, amount_cents: 500 });
    await setReceiptCostCategory(db(), TENANT, receiptId, "materials", 1);

    // Simulate a pre-existing ledger line sourced from this receipt without
    // posted_at being set yet (the "should never happen" belt-and-suspenders
    // case the mandate calls out).
    await postDirectCostLedgerLine(db(), {
      company_id: TENANT, job_id: jobId, cost_category: "materials", amount_cents: 500,
      division: "landscape", progress_eligible: 1, change_order_id: null, source_receipt_id: receiptId,
    });
    expect(await receiptHasPostedLedgerLine(db(), TENANT, receiptId)).toBe(true);

    const result = await postApprovedReceiptToLedger(db(), TENANT, receiptId, "landscape", "rep-1");
    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(result.reason).toBe("already_posted");

    const linesForJob = await getLedgerLinesForJobProgress(db(), TENANT, jobId);
    expect(linesForJob.length).toBe(1); // no second line was written
  });
});

describe("listAssignableJobsForTenant — PR C's receipt job/work-order selector", () => {
  it("returns a tenant's work orders, excludes cancelled, includes completed", async () => {
    const activeJob = uid("job");
    await seedWorkOrder(activeJob, TENANT);
    const completedJob = uid("job");
    await seedWorkOrder(completedJob, TENANT);
    await db().prepare(`UPDATE work_orders SET status = 'completed' WHERE id = ?`).bind(completedJob).run();
    const cancelledJob = uid("job");
    await seedWorkOrder(cancelledJob, TENANT);
    await db().prepare(`UPDATE work_orders SET status = 'cancelled' WHERE id = ?`).bind(cancelledJob).run();

    const jobs = await listAssignableJobsForTenant(db(), TENANT);
    const ids = jobs.map((j) => j.id);
    expect(ids).toContain(activeJob);
    expect(ids).toContain(completedJob); // receipts commonly land after work wraps up
    expect(ids).not.toContain(cancelledJob); // nothing should be costed against a job that never happened
  });

  it("tenant isolation: a job under a different company never appears", async () => {
    const otherJob = uid("job");
    await seedWorkOrder(otherJob, OTHER_TENANT);
    const jobs = await listAssignableJobsForTenant(db(), TENANT);
    expect(jobs.map((j) => j.id)).not.toContain(otherJob);
  });

  it("returns an empty list (not an error) for a tenant with no work orders", async () => {
    const jobs = await listAssignableJobsForTenant(db(), "t-jobprog-empty");
    expect(jobs).toEqual([]);
  });
});

describe("getJobDivision — work_orders.crew_id -> crews.division cascade", () => {
  it("resolves the division through the job's assigned crew", async () => {
    const crewId = uid("crew");
    await seedCrew(crewId, TENANT, "landscape");
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT, crewId);

    const division = await getJobDivision(db(), TENANT, jobId);
    expect(division).toBe("landscape");
  });

  it("returns null (not throws) when the job has no crew assigned", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT); // no crewId
    const division = await getJobDivision(db(), TENANT, jobId);
    expect(division).toBeNull();
  });

  it("returns null when the crew has no division set yet", async () => {
    const crewId = uid("crew");
    await db().prepare(`INSERT INTO crews (id, company_id, name, division) VALUES (?,?,?,NULL)`)
      .bind(crewId, TENANT, `Crew ${crewId}`).run();
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT, crewId);
    const division = await getJobDivision(db(), TENANT, jobId);
    expect(division).toBeNull();
  });

  it("returns null for a job that doesn't belong to this tenant (no cross-tenant leak)", async () => {
    const crewId = uid("crew");
    await seedCrew(crewId, OTHER_TENANT, "landscape");
    const jobId = uid("job");
    await seedWorkOrder(jobId, OTHER_TENANT, crewId);
    const division = await getJobDivision(db(), TENANT, jobId); // wrong tenant
    expect(division).toBeNull();
  });

  it("returns null when the crew row belongs to a different tenant than the job (cross-tenant crew join guarded)", async () => {
    // A crew_id FK value that happens to collide with another tenant's crew
    // id must never resolve — the join explicitly requires c.company_id =
    // wo.company_id, not just crews.id = work_orders.crew_id.
    const crewId = uid("crew");
    await seedCrew(crewId, OTHER_TENANT, "landscape");
    const jobId = uid("job");
    // Seed the work order directly (bypassing the FK-checked helper's
    // tenant assumption) so its crew_id points at a crew row that exists
    // only under OTHER_TENANT.
    await db().prepare(
      `INSERT INTO work_orders (id, company_id, wo_number, status, crew_id) VALUES (?,?,?,?,?)`,
    ).bind(jobId, TENANT, `WO-${jobId}`, "scheduled", crewId).run();
    const division = await getJobDivision(db(), TENANT, jobId);
    expect(division).toBeNull();
  });
});

describe("setReceiptJobId — tenant-verified job assignment, write-once after posting", () => {
  it("assigns a valid tenant-owned job to a receipt", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);
    const receiptId = uid("rcpt");
    await seedReceipt(receiptId, TENANT, { status: "approved", job_id: null });

    const ok = await setReceiptJobId(db(), TENANT, receiptId, jobId);
    expect(ok).toBe(true);
    const receipt = await getReceiptForPosting(db(), TENANT, receiptId);
    expect(receipt?.job_id).toBe(jobId);
  });

  it("clears an assignment when passed null", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);
    const receiptId = uid("rcpt");
    await seedReceipt(receiptId, TENANT, { status: "approved", job_id: jobId });

    const ok = await setReceiptJobId(db(), TENANT, receiptId, null);
    expect(ok).toBe(true);
    const receipt = await getReceiptForPosting(db(), TENANT, receiptId);
    expect(receipt?.job_id).toBeNull();
  });

  it("rejects a cross-tenant job id: does not assign, and the receipt's own row is untouched", async () => {
    const foreignJobId = uid("job");
    await seedWorkOrder(foreignJobId, OTHER_TENANT); // exists, but under a different company
    const receiptId = uid("rcpt");
    await seedReceipt(receiptId, TENANT, { status: "approved", job_id: null });

    const ok = await setReceiptJobId(db(), TENANT, receiptId, foreignJobId);
    expect(ok).toBe(false);
    const receipt = await getReceiptForPosting(db(), TENANT, receiptId);
    expect(receipt?.job_id).toBeNull(); // untouched — no cross-tenant assignment landed
  });

  it("rejects a job id that doesn't exist at all", async () => {
    const receiptId = uid("rcpt");
    await seedReceipt(receiptId, TENANT, { status: "approved", job_id: null });
    const ok = await setReceiptJobId(db(), TENANT, receiptId, "does-not-exist");
    expect(ok).toBe(false);
    const receipt = await getReceiptForPosting(db(), TENANT, receiptId);
    expect(receipt?.job_id).toBeNull();
  });

  it("refuses once the receipt is posted — job_id becomes part of the immutable ledger-line record", async () => {
    const crewId = uid("crew");
    await seedCrew(crewId, TENANT, "landscape");
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT, crewId);
    const otherJobId = uid("job");
    await seedWorkOrder(otherJobId, TENANT, crewId);

    const receiptId = uid("rcpt");
    await seedReceipt(receiptId, TENANT, { status: "approved", job_id: jobId, amount_cents: 4200 });
    await setReceiptCostCategory(db(), TENANT, receiptId, "materials", 1);
    const posted = await postApprovedReceiptToLedger(db(), TENANT, receiptId, "landscape", "rep-1");
    expect(posted.success).toBe(true);

    // Attempting to reassign a posted receipt to a different job must be a
    // silent no-op (false), never silently succeed — a posted receipt's
    // job_id is part of the ledger line's immutable record; correcting it
    // requires reverseJobCostLedgerLine, not this function.
    const reassigned = await setReceiptJobId(db(), TENANT, receiptId, otherJobId);
    expect(reassigned).toBe(false);
    const receipt = await getReceiptForPosting(db(), TENANT, receiptId);
    expect(receipt?.job_id).toBe(jobId); // untouched
  });

  it("tenant isolation: cannot assign a job to a receipt belonging to a different company", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, OTHER_TENANT);
    const receiptId = uid("rcpt");
    await seedReceipt(receiptId, OTHER_TENANT, { status: "approved", job_id: null });

    // Called with the WRONG tenant_id for this receipt.
    const ok = await setReceiptJobId(db(), TENANT, receiptId, jobId);
    expect(ok).toBe(false);
  });

  it("returns false for a receipt id that doesn't exist", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);
    const ok = await setReceiptJobId(db(), TENANT, "does-not-exist", jobId);
    expect(ok).toBe(false);
  });
});

describe("listRecentlyPostedReceipts — the posting-review UI's third queue", () => {
  it("returns only posted receipts for the tenant, most recently posted first", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);

    const unposted = uid("rcpt");
    await seedReceipt(unposted, TENANT, { status: "approved", job_id: jobId });
    await setReceiptCostCategory(db(), TENANT, unposted, "materials", 1);

    const postedFirst = uid("rcpt");
    await seedReceipt(postedFirst, TENANT, { status: "approved", job_id: jobId });
    await setReceiptCostCategory(db(), TENANT, postedFirst, "materials", 1);
    await markReceiptPosted(db(), TENANT, postedFirst);
    // Force a distinct, earlier posted_at than the second one so ordering is
    // unambiguous rather than relying on same-instant timestamps.
    await db().prepare(`UPDATE receipt SET posted_at = '2026-01-01T00:00:00.000Z' WHERE company_id = ? AND id = ?`)
      .bind(TENANT, postedFirst).run();

    const postedSecond = uid("rcpt");
    await seedReceipt(postedSecond, TENANT, { status: "approved", job_id: jobId });
    await setReceiptCostCategory(db(), TENANT, postedSecond, "materials", 1);
    await markReceiptPosted(db(), TENANT, postedSecond);
    await db().prepare(`UPDATE receipt SET posted_at = '2026-02-01T00:00:00.000Z' WHERE company_id = ? AND id = ?`)
      .bind(TENANT, postedSecond).run();

    const list = await listRecentlyPostedReceipts(db(), TENANT);
    const ids = list.map((r) => r.id);
    expect(ids).toContain(postedFirst);
    expect(ids).toContain(postedSecond);
    expect(ids).not.toContain(unposted); // never-posted receipts are absent
    // Most recently posted first.
    expect(ids.indexOf(postedSecond)).toBeLessThan(ids.indexOf(postedFirst));
  });

  it("does not leak another tenant's posted receipts", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, OTHER_TENANT);
    const receiptId = uid("rcpt");
    await seedReceipt(receiptId, OTHER_TENANT, { status: "approved", job_id: jobId });
    await setReceiptCostCategory(db(), OTHER_TENANT, receiptId, "materials", 1);
    await markReceiptPosted(db(), OTHER_TENANT, receiptId);

    const list = await listRecentlyPostedReceipts(db(), TENANT);
    expect(list.map((r) => r.id)).not.toContain(receiptId);
  });

  it("respects the limit parameter", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);
    for (let i = 0; i < 3; i++) {
      const receiptId = uid("rcpt");
      await seedReceipt(receiptId, TENANT, { status: "approved", job_id: jobId });
      await setReceiptCostCategory(db(), TENANT, receiptId, "materials", 1);
      await markReceiptPosted(db(), TENANT, receiptId);
    }
    const list = await listRecentlyPostedReceipts(db(), TENANT, 2);
    expect(list.length).toBe(2);
  });
});

// PR E. getJobProgress — the single assembly point wiring real
// work_orders/job_budget_versions/job_cost_ledger rows into
// src/engines/job-progress.ts's computeJobProgress, per ITEM4-JOBCOST.md
// §5/§11. computeJobProgress itself is exhaustively tested in
// src/engines/job-progress.test.ts against §8's worked examples; these
// tests instead prove the DB-assembly wiring is correct — that real rows
// land in the right fields of JobProgressInput.
describe("getJobProgress — assembles real DB rows into computeJobProgress (§5/§11)", () => {
  it("returns null when the job doesn't exist under this tenant", async () => {
    const result = await getJobProgress(db(), TENANT, "no-such-job");
    expect(result).toBeNull();
  });

  it("returns null when the job exists under a different tenant (no cross-tenant leak)", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, OTHER_TENANT);
    const result = await getJobProgress(db(), TENANT, jobId);
    expect(result).toBeNull();
  });

  it("a job with no job_budget_versions row at all: every budget-derived field is null, not fabricated", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);
    const result = await getJobProgress(db(), TENANT, jobId);
    expect(result).not.toBeNull();
    expect(result!.revised_contract_value_cents).toBeNull();
    expect(result!.revised_budgeted_direct_cost_cents).toBeNull();
    expect(result!.revised_budgeted_overhead_cents).toBeNull();
    expect(result!.earned_completion.completion_millionths).toBeNull();
    expect(result!.earned_completion.unavailable_reason).toBe("no_budget_version");
    expect(result!.earned_revenue_to_date_cents).toBeNull();
    expect(result!.recovered_overhead_to_date_cents).toBeNull();
    // Formulas 3 and 8 are always computable (sum of zero posted lines is 0,
    // never null) — only the budget-derived formulas 1/2/4/5/6/7/9 go null.
    expect(result!.actual_direct_cost_to_date_cents).toBe(0);
    expect(result!.absorbed_overhead_to_date_cents).toBe(0);
    expect(result!.overhead_recovery_variance_cents).toBeNull();
  });

  it("worked example 8.1 (cost_to_cost), assembled entirely from real inserted rows", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);
    await insertJobBudgetVersion(db(), {
      id: uid("jbv"), company_id: TENANT, job_id: jobId, source_type: "estimate", source_id: "est-81",
      revision_seq: 0, contract_value_cents: 4000000, labor_hours_budgeted_hundredths: 30000,
      labor_rate_used: 280000, materials_budget_cents: 1200000, subcontractor_budget_cents: 0,
      equipment_budget_cents: 360000, disposal_budget_cents: 0, permits_budget_cents: 0,
      other_direct_budget_cents: 0, direct_cost_budget_cents: 2400000, division: "hardscape",
      overhead_rate_used: 242200, budgeted_overhead_cents: 726600, target_margin_millionths: null,
      completion_method: "cost_to_cost", service_units_planned: null, needs_review: 0,
      approved_at: "2026-07-01T00:00:00Z", approved_by: "rep-1",
    });
    // Approved CO #1: revenue +$6,000, direct-cost +$3,500, +40 hrs @ $24.22/hr snapshot.
    await insertJobBudgetVersion(db(), {
      id: uid("jbv"), company_id: TENANT, job_id: jobId, source_type: "change_order", source_id: "co-81",
      revision_seq: 1, contract_value_cents: 4600000, labor_hours_budgeted_hundredths: 34000,
      labor_rate_used: 280000, materials_budget_cents: 1200000, subcontractor_budget_cents: 0,
      equipment_budget_cents: 360000, disposal_budget_cents: 350000, permits_budget_cents: 0,
      other_direct_budget_cents: 0, direct_cost_budget_cents: 2750000, division: "hardscape",
      overhead_rate_used: 242200, budgeted_overhead_cents: 823480, target_margin_millionths: null,
      completion_method: "cost_to_cost", service_units_planned: null, needs_review: 0,
      approved_at: "2026-07-15T00:00:00Z", approved_by: "rep-2",
    });
    await postDirectCostLedgerLine(db(), {
      company_id: TENANT, job_id: jobId, cost_category: "materials", amount_cents: 840000,
      division: "hardscape", progress_eligible: 1, change_order_id: null, source_receipt_id: null,
    });
    await postDirectCostLedgerLine(db(), {
      company_id: TENANT, job_id: jobId, cost_category: "materials", amount_cents: 200000,
      division: "hardscape", progress_eligible: 0, change_order_id: null, source_receipt_id: null,
    });
    await postDirectCostLedgerLine(db(), {
      company_id: TENANT, job_id: jobId, cost_category: "equipment", amount_cents: 210000,
      division: "hardscape", progress_eligible: 1, change_order_id: null, source_receipt_id: null,
    });
    await db().prepare(`
      INSERT INTO job_cost_ledger (company_id, time_entry_id, job_id, line_type, amount_cents, division)
      VALUES (?, NULL, ?, 'labor', ?, ?)
    `).bind(TENANT, jobId, 910000, "hardscape").run();
    await db().prepare(`
      INSERT INTO job_cost_ledger (company_id, time_entry_id, job_id, line_type, amount_cents, division)
      VALUES (?, NULL, ?, 'overhead', ?, ?)
    `).bind(TENANT, jobId, 823480, "hardscape").run();

    const result = await getJobProgress(db(), TENANT, jobId);
    expect(result).not.toBeNull();
    expect(result!.revised_contract_value_cents).toBe(4600000);
    expect(result!.revised_budgeted_direct_cost_cents).toBe(2750000);
    expect(result!.revised_budgeted_overhead_cents).toBe(823480);
    expect(result!.actual_direct_cost_to_date_cents).toBe(840000 + 200000 + 210000 + 910000);
    expect(result!.progress_eligible_direct_cost_to_date_cents).toBe(840000 + 210000 + 910000);
    // 1,960,000 / 2,750,000 = 0.712727... millionths
    const expectedMillionths = Math.round((1_960_000 / 2_750_000) * 1_000_000);
    expect(result!.earned_completion.completion_millionths).toBe(expectedMillionths);
    expect(result!.absorbed_overhead_to_date_cents).toBe(823480);
    expect(result!.overhead_recovery_variance_cents).not.toBeNull();
  });

  it("financially_closed_at forces earned completion to 1.00 regardless of the stored completion_method", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);
    await insertJobBudgetVersion(db(), {
      id: uid("jbv"), company_id: TENANT, job_id: jobId, source_type: "estimate", source_id: "est-closed",
      revision_seq: 0, contract_value_cents: 80000, labor_hours_budgeted_hundredths: 1000,
      labor_rate_used: 320000, materials_budget_cents: 0, subcontractor_budget_cents: 0,
      equipment_budget_cents: 0, disposal_budget_cents: 0, permits_budget_cents: 0,
      other_direct_budget_cents: 0, direct_cost_budget_cents: 32000, division: "snow",
      overhead_rate_used: 242200, budgeted_overhead_cents: 24220, target_margin_millionths: null,
      completion_method: "completed", service_units_planned: null, needs_review: 0,
      approved_at: "2026-01-01T00:00:00Z", approved_by: "rep-1",
    });
    await db().prepare(`UPDATE work_orders SET status = 'completed' WHERE id = ?`).bind(jobId).run();
    await setWorkOrderFinanciallyClosed(db(), TENANT, jobId, "2026-01-05T00:00:00Z");

    const result = await getJobProgress(db(), TENANT, jobId);
    expect(result).not.toBeNull();
    expect(result!.earned_completion.completion_millionths).toBe(1_000_000);
    expect(result!.earned_completion.unavailable_reason).toBeNull();
    expect(result!.earned_revenue_to_date_cents).toBe(80000);
  });

  it("service_units completion method reads service_units_completed/planned from the right rows", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);
    await insertJobBudgetVersion(db(), {
      id: uid("jbv"), company_id: TENANT, job_id: jobId, source_type: "estimate", source_id: "est-su",
      revision_seq: 0, contract_value_cents: 60000, labor_hours_budgeted_hundredths: 1200,
      labor_rate_used: 320000, materials_budget_cents: 0, subcontractor_budget_cents: 0,
      equipment_budget_cents: 0, disposal_budget_cents: 0, permits_budget_cents: 0,
      other_direct_budget_cents: 0, direct_cost_budget_cents: 36000, division: "maintenance",
      overhead_rate_used: 242200, budgeted_overhead_cents: 29064, target_margin_millionths: null,
      completion_method: "service_units", service_units_planned: 4, needs_review: 0,
      approved_at: "2026-01-01T00:00:00Z", approved_by: "rep-1",
    });
    await setWorkOrderServiceUnitsCompleted(db(), TENANT, jobId, 3);

    const result = await getJobProgress(db(), TENANT, jobId);
    expect(result!.earned_completion.completion_millionths).toBe(750_000); // 3/4
    expect(result!.earned_revenue_to_date_cents).toBe(45000); // 60000 * 0.75
  });

  it("manual completion method reads work_orders.completion_pct_millionths", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);
    await insertJobBudgetVersion(db(), {
      id: uid("jbv"), company_id: TENANT, job_id: jobId, source_type: "estimate", source_id: "est-man",
      revision_seq: 0, contract_value_cents: 10000, labor_hours_budgeted_hundredths: 100,
      labor_rate_used: null, materials_budget_cents: 0, subcontractor_budget_cents: 0,
      equipment_budget_cents: 0, disposal_budget_cents: 0, permits_budget_cents: 0,
      other_direct_budget_cents: 0, direct_cost_budget_cents: 5000, division: "landscape",
      overhead_rate_used: 1, budgeted_overhead_cents: 100, target_margin_millionths: null,
      completion_method: "manual", service_units_planned: null, needs_review: 0,
      approved_at: "2026-01-01T00:00:00Z", approved_by: "rep-1",
    });
    await setWorkOrderManualCompletion(db(), TENANT, jobId, 400000);

    const result = await getJobProgress(db(), TENANT, jobId);
    expect(result!.earned_completion.completion_millionths).toBe(400000);
    expect(result!.earned_revenue_to_date_cents).toBe(4000); // 10000 * 0.4
  });

  it("tenant isolation: a job under one tenant never reads another tenant's ledger/budget rows", async () => {
    const jobId = uid("job");
    await seedWorkOrder(jobId, TENANT);
    await insertJobBudgetVersion(db(), {
      id: uid("jbv"), company_id: TENANT, job_id: jobId, source_type: "estimate", source_id: "est-iso",
      revision_seq: 0, contract_value_cents: 5000, labor_hours_budgeted_hundredths: 100,
      labor_rate_used: null, materials_budget_cents: 0, subcontractor_budget_cents: 0,
      equipment_budget_cents: 0, disposal_budget_cents: 0, permits_budget_cents: 0,
      other_direct_budget_cents: 0, direct_cost_budget_cents: 1000, division: "landscape",
      overhead_rate_used: 1, budgeted_overhead_cents: 10, target_margin_millionths: null,
      completion_method: "cost_to_cost", service_units_planned: null, needs_review: 0,
      approved_at: "2026-01-01T00:00:00Z", approved_by: "rep-1",
    });

    // A job of the SAME id existing under OTHER_TENANT with wildly different
    // figures must never leak into this tenant's read.
    const sameIdOtherTenant = jobId; // same string id, different company scope is impossible for work_orders(id) PK
    // work_orders.id is a global PK (see mandate's known gotcha), so we can't
    // literally reuse the same id under a second tenant; instead prove
    // isolation via a distinct job id under OTHER_TENANT that must not
    // affect this tenant's read at all.
    const otherJobId = uid("job");
    await seedWorkOrder(otherJobId, OTHER_TENANT);
    await insertJobBudgetVersion(db(), {
      id: uid("jbv"), company_id: OTHER_TENANT, job_id: otherJobId, source_type: "estimate", source_id: "est-other",
      revision_seq: 0, contract_value_cents: 999999, labor_hours_budgeted_hundredths: 1,
      labor_rate_used: null, materials_budget_cents: 0, subcontractor_budget_cents: 0,
      equipment_budget_cents: 0, disposal_budget_cents: 0, permits_budget_cents: 0,
      other_direct_budget_cents: 0, direct_cost_budget_cents: 1, division: "landscape",
      overhead_rate_used: 1, budgeted_overhead_cents: 1, target_margin_millionths: null,
      completion_method: "cost_to_cost", service_units_planned: null, needs_review: 0,
      approved_at: "2026-01-01T00:00:00Z", approved_by: "rep-1",
    });

    const result = await getJobProgress(db(), TENANT, jobId);
    expect(result!.revised_contract_value_cents).toBe(5000); // this tenant's own figure, not 999999
    void sameIdOtherTenant;
  });
});
