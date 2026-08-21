/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { runUnbilledWorkDetection } from "./unbilled-sweep";
import { getOpenActionItems } from "../db/repos";

const db = () => env.DB;

async function seedCompanyAndAdmin(companyId: string) {
  await db().prepare(`INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)`).bind(companyId, companyId, companyId).run();
  await db().prepare(
    `INSERT INTO reps (id, company_id, name, role, pin, active) VALUES (?,?,?,?,?,1)`,
  ).bind(`${companyId}-admin`, companyId, "Admin", "admin", "0000").run();
}

async function seedWorkOrder(companyId: string, id: string, opts: { status?: string; estimateCents?: number | null } = {}) {
  await db().prepare(
    `INSERT INTO work_orders (id, company_id, wo_number, status, estimate_cents, finance_completed_at) VALUES (?,?,?,?,?,?)`,
  ).bind(
    id, companyId, `WO-${id}`, opts.status ?? "completed",
    opts.estimateCents ?? null, opts.status === "completed" || opts.status === undefined ? "2026-08-01T00:00:00Z" : null,
  ).run();
}

async function seedEstimateAndInvoice(companyId: string, workOrderId: string, estimateId: string, invoiceId: string) {
  await db().prepare(
    `INSERT INTO estimates (id, company_id, work_order_id) VALUES (?,?,?)`,
  ).bind(estimateId, companyId, workOrderId).run();
  await db().prepare(
    `INSERT INTO invoices (id, company_id, estimate_id) VALUES (?,?,?)`,
  ).bind(invoiceId, companyId, estimateId).run();
}

describe("runUnbilledWorkDetection", () => {
  it("US-01 a completed work order with no invoice produces one open 'collect' action_item", async () => {
    const tenant = "t-unbilled-1";
    await seedCompanyAndAdmin(tenant);
    await seedWorkOrder(tenant, "wo-1", { estimateCents: 50000 });

    const result = await runUnbilledWorkDetection(db(), tenant, false);
    expect(result.findings.length).toBe(1);
    expect(result.created_action_item_ids.length).toBe(1);

    const open = await getOpenActionItems(db(), tenant, "collect");
    expect(open.length).toBe(1);
    expect(open[0].source_type).toBe("work_order");
    expect(open[0].source_id).toBe("wo-1");
    expect(open[0].amount_cents).toBe(50000);
  });

  it("US-02 a completed work order that already has an invoice (via work_order_id -> estimate -> invoice) produces no item", async () => {
    const tenant = "t-unbilled-2";
    await seedCompanyAndAdmin(tenant);
    await seedWorkOrder(tenant, "wo-2", { estimateCents: 30000 });
    await seedEstimateAndInvoice(tenant, "wo-2", "est-2", "inv-2");

    const result = await runUnbilledWorkDetection(db(), tenant, false);
    expect(result.findings.length).toBe(0);
    expect(result.created_action_item_ids.length).toBe(0);
  });

  it("US-03 running twice on the same uninvoiced work order does not create a duplicate open item", async () => {
    const tenant = "t-unbilled-3";
    await seedCompanyAndAdmin(tenant);
    await seedWorkOrder(tenant, "wo-3", { estimateCents: 10000 });

    const first = await runUnbilledWorkDetection(db(), tenant, false);
    expect(first.created_action_item_ids.length).toBe(1);

    const second = await runUnbilledWorkDetection(db(), tenant, false);
    expect(second.created_action_item_ids.length).toBe(0);

    const open = await getOpenActionItems(db(), tenant, "collect");
    expect(open.length).toBe(1);
  });

  it("US-04 a job that gets invoiced after its collect item was created has that item auto-resolved on the next run", async () => {
    const tenant = "t-unbilled-4";
    await seedCompanyAndAdmin(tenant);
    await seedWorkOrder(tenant, "wo-4", { estimateCents: 20000 });

    await runUnbilledWorkDetection(db(), tenant, false);
    let open = await getOpenActionItems(db(), tenant, "collect");
    expect(open.length).toBe(1);

    // Now the job gets invoiced.
    await seedEstimateAndInvoice(tenant, "wo-4", "est-4", "inv-4");

    await runUnbilledWorkDetection(db(), tenant, false);
    open = await getOpenActionItems(db(), tenant, "collect");
    expect(open.length).toBe(0);
  });

  it("US-05 dry_run computes findings but writes no action_item and resolves nothing", async () => {
    const tenant = "t-unbilled-5";
    await seedCompanyAndAdmin(tenant);
    await seedWorkOrder(tenant, "wo-5", { estimateCents: 15000 });

    const result = await runUnbilledWorkDetection(db(), tenant, true);
    expect(result.findings.length).toBe(1);
    expect(result.created_action_item_ids.length).toBe(0);

    const open = await getOpenActionItems(db(), tenant, "collect");
    expect(open.length).toBe(0);
  });

  it("US-06 a work order still in progress (not completed) never appears as a finding", async () => {
    const tenant = "t-unbilled-6";
    await seedCompanyAndAdmin(tenant);
    await seedWorkOrder(tenant, "wo-6", { status: "scheduled", estimateCents: 40000 });

    const result = await runUnbilledWorkDetection(db(), tenant, false);
    expect(result.findings.length).toBe(0);
  });
});
