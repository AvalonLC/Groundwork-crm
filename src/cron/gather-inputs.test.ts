/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { gatherTenantRollupInputs, listTenantIdsWithPolicy } from "./gather-inputs";
import {
  upsertTenantFinancePolicy, postTimeEntry,
  insertOverheadPool, insertOverheadAllocation, postJobCostLedgerLines,
} from "../db/repos";
import type { Cents } from "../db/schema";

const db = () => env.DB;
const TENANT = "t-gather-inputs";

async function seedWorkOrderAndTimeEntry(companyId: string, jobId: string, teId: string) {
  await db().prepare(`INSERT INTO work_orders (id, company_id, wo_number) VALUES (?,?,?)`)
    .bind(jobId, companyId, `WO-${jobId}`).run();
  await db().prepare(
    `INSERT INTO time_entries (id, rep_id, company_id, clock_in, clock_out, duration_min, work_order_id) VALUES (?,?,?,?,?,?,?)`,
  ).bind(teId, "emp-1", companyId, "2026-08-01T08:00:00Z", "2026-08-01T16:00:00Z", 480, jobId).run();
}

describe("gatherTenantRollupInputs", () => {
  it("GI-01 returns null when the tenant has no tenant_finance_policy row", async () => {
    const result = await gatherTenantRollupInputs(db(), "t-no-policy", "2026-08-03");
    expect(result).toBeNull();
  });

  it("GI-02 pulls restated_target_cents straight from tenant_finance_policy", async () => {
    await upsertTenantFinancePolicy(db(), {
      company_id: TENANT, equipment_engine_active: 0, materiality_threshold_cents: 0,
      restated_target_cents: 59100000, black_friday_date: null,
    } as never);
    const result = await gatherTenantRollupInputs(db(), TENANT, "2026-08-03");
    expect(result?.restated_target_cents).toBe(59100000);
  });

  it("GI-03 sums posted overhead ledger lines into recovered_to_date_cents", async () => {
    const tenantId = "t-gather-recovered";
    await upsertTenantFinancePolicy(db(), {
      company_id: tenantId, equipment_engine_active: 0, materiality_threshold_cents: 0,
      restated_target_cents: 100000, black_friday_date: null,
    } as never);
    await seedWorkOrderAndTimeEntry(tenantId, "job-1", "te-1");
    await postTimeEntry(db(), tenantId, "te-1", 421002, "high", 27430);
    await postJobCostLedgerLines(
      db(),
      { company_id: tenantId, time_entry_id: "te-1", job_id: "job-1", amount_cents: 33680 as Cents, division: "maintenance" },
      { company_id: tenantId, time_entry_id: "te-1", job_id: "job-1", amount_cents: 19374 as Cents, division: "maintenance" },
    );
    // posted_at defaults to now, so the as_of has to be on or after today for
    // the line to count. This test used to ask for 2026-08-03 and pass — which
    // was the bug: a line posted today counted toward a snapshot dated in the
    // past, because the query had a lower bound only.
    const today = new Date().toISOString().slice(0, 10);
    const result = await gatherTenantRollupInputs(db(), tenantId, today);
    expect(result?.recovered_to_date_cents).toBe(19374); // only the overhead line, not labor
  });

  it("GI-03b a ledger line posted AFTER as_of does not count toward it", async () => {
    // The bound this adds. Without an upper bound a backfilled snapshot picks up
    // everything posted since, so a row labelled 2026-08-14 carries the 19th's
    // work — authoritative-looking and wrong.
    const tenantId = "t-gather-asof-upper";
    await upsertTenantFinancePolicy(db(), {
      company_id: tenantId, equipment_engine_active: 0, materiality_threshold_cents: 0,
      restated_target_cents: 100000, black_friday_date: null,
    } as never);
    await seedWorkOrderAndTimeEntry(tenantId, "job-u", "te-u");
    await postTimeEntry(db(), tenantId, "te-u", 421002, "high", 27430);
    await postJobCostLedgerLines(
      db(),
      { company_id: tenantId, time_entry_id: "te-u", job_id: "job-u", amount_cents: 33680 as Cents, division: "maintenance" },
      { company_id: tenantId, time_entry_id: "te-u", job_id: "job-u", amount_cents: 19374 as Cents, division: "maintenance" },
    );

    // Same year, so the lower bound still admits it; only the upper bound excludes it.
    const backdated = `${new Date().toISOString().slice(0, 4)}-01-02`;
    const result = await gatherTenantRollupInputs(db(), tenantId, backdated);
    expect(result?.recovered_to_date_cents, "a line posted today leaked into a January snapshot").toBe(0);
    expect(result?.absorbed_overhead_cents, "same leak in the absorbed-this-week figure").toBe(0);
  });

  it("GI-03c an allocation set after as_of does not set the blended rate", async () => {
    // MAX(as_of) with no bound handed a backfilled date today's allocation.
    const tenantId = "t-gather-alloc-asof";
    await upsertTenantFinancePolicy(db(), {
      company_id: tenantId, equipment_engine_active: 0, materiality_threshold_cents: 0,
      restated_target_cents: 100000, black_friday_date: null,
    } as never);
    await insertOverheadAllocation(db(), {
      company_id: tenantId, division: "maintenance", as_of: "2026-06-01",
      sellable_hours: 1000, allocated_overhead_cents: 5_000_000 as Cents,
      weighted_labor_rate_cents: 4210 as Cents, overhead_rate: 5000,
      absorbed_cost_cents: 0 as Cents, target_margin: 4000, required_bill_rate_cents: 0 as Cents,
    } as never);

    // Before that allocation existed: no rate.
    const before = await gatherTenantRollupInputs(db(), tenantId, "2026-05-01");
    expect(before?.blended_overhead_rate, "an allocation from the future set the rate").toBe(0);

    // After it: the rate is in effect.
    const after = await gatherTenantRollupInputs(db(), tenantId, "2026-07-01");
    expect(after?.blended_overhead_rate).toBeGreaterThan(0);
  });

  it("GI-04 blended_overhead_rate is 0 when no overhead_allocation exists yet, not an error", async () => {
    const tenantId = "t-gather-no-allocation";
    await upsertTenantFinancePolicy(db(), {
      company_id: tenantId, equipment_engine_active: 0, materiality_threshold_cents: 0,
      restated_target_cents: 100000, black_friday_date: null,
    } as never);
    const result = await gatherTenantRollupInputs(db(), tenantId, "2026-08-03");
    expect(result?.blended_overhead_rate).toBe(0);
  });

  it("GI-05 blended_overhead_rate computes from the latest overhead_allocation as_of", async () => {
    const tenantId = "t-gather-blended";
    await upsertTenantFinancePolicy(db(), {
      company_id: tenantId, equipment_engine_active: 0, materiality_threshold_cents: 0,
      restated_target_cents: 100000, black_friday_date: null,
    } as never);
    await insertOverheadPool(db(), {
      company_id: tenantId, division: "maintenance", pool_type: "shop",
      annual_cost_cents: 19640000, driver: "sellable_hours", as_of: "2026-08-01",
    });
    await insertOverheadAllocation(db(), {
      company_id: tenantId, division: "maintenance", as_of: "2026-08-01",
      sellable_hours: 8110, allocated_overhead_cents: 19640000,
      weighted_labor_rate_cents: 3840, overhead_rate: 242170,
      absorbed_cost_cents: 6262, target_margin: 4000, required_bill_rate_cents: 10437,
    });
    const result = await gatherTenantRollupInputs(db(), tenantId, "2026-08-03");
    expect(result?.blended_overhead_rate).toBeGreaterThan(0);
  });
});

describe("listTenantIdsWithPolicy", () => {
  it("GI-06 returns distinct company_ids that have a tenant_finance_policy row", async () => {
    const tenantId = "t-gather-list";
    await upsertTenantFinancePolicy(db(), {
      company_id: tenantId, equipment_engine_active: 0, materiality_threshold_cents: 0,
      restated_target_cents: 0, black_friday_date: null,
    } as never);
    const ids = await listTenantIdsWithPolicy(db());
    expect(ids).toContain(tenantId);
  });
});
