/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { gatherTenantRollupInputs, listTenantIdsWithPolicy } from "./gather-inputs";
import {
  upsertTenantFinancePolicy, insertTimeEntry, postTimeEntry,
  insertOverheadPool, insertOverheadAllocation, postJobCostLedgerLines,
} from "../db/repos";
import type { Cents } from "../db/schema";

const db = () => env.FINANCE_DB;
const TENANT = "t-gather-inputs";

describe("gatherTenantRollupInputs", () => {
  it("GI-01 returns null when the tenant has no tenant_finance_policy row", async () => {
    const result = await gatherTenantRollupInputs(db(), "t-no-policy", "2026-08-03");
    expect(result).toBeNull();
  });

  it("GI-02 pulls restated_target_cents straight from tenant_finance_policy", async () => {
    await upsertTenantFinancePolicy(db(), {
      tenant_id: TENANT, equipment_engine_active: 0, materiality_threshold_cents: 0,
      restated_target_cents: 59100000, black_friday_date: null,
    } as never);
    const result = await gatherTenantRollupInputs(db(), TENANT, "2026-08-03");
    expect(result?.restated_target_cents).toBe(59100000);
  });

  it("GI-03 sums posted overhead ledger lines into recovered_to_date_cents", async () => {
    const tenantId = "t-gather-recovered";
    await upsertTenantFinancePolicy(db(), {
      tenant_id: tenantId, equipment_engine_active: 0, materiality_threshold_cents: 0,
      restated_target_cents: 100000, black_friday_date: null,
    } as never);
    const teId = await insertTimeEntry(db(), {
      tenant_id: tenantId, employee_id: "emp-1", crew_id: null, job_id: "job-1",
      work_date: "2026-08-01", hours_hundredths: 800, ot_hours_hundredths: 0,
    });
    await postTimeEntry(db(), tenantId, teId, 421002, "high", 27430);
    await postJobCostLedgerLines(
      db(),
      { tenant_id: tenantId, time_entry_id: teId, job_id: "job-1", amount_cents: 33680 as Cents, division: "maintenance" },
      { tenant_id: tenantId, time_entry_id: teId, job_id: "job-1", amount_cents: 19374 as Cents, division: "maintenance" },
    );
    const result = await gatherTenantRollupInputs(db(), tenantId, "2026-08-03");
    expect(result?.recovered_to_date_cents).toBe(19374); // only the overhead line, not labor
  });

  it("GI-04 blended_overhead_rate is 0 when no overhead_allocation exists yet, not an error", async () => {
    const tenantId = "t-gather-no-allocation";
    await upsertTenantFinancePolicy(db(), {
      tenant_id: tenantId, equipment_engine_active: 0, materiality_threshold_cents: 0,
      restated_target_cents: 100000, black_friday_date: null,
    } as never);
    const result = await gatherTenantRollupInputs(db(), tenantId, "2026-08-03");
    expect(result?.blended_overhead_rate).toBe(0);
  });

  it("GI-05 blended_overhead_rate computes from the latest overhead_allocation as_of", async () => {
    const tenantId = "t-gather-blended";
    await upsertTenantFinancePolicy(db(), {
      tenant_id: tenantId, equipment_engine_active: 0, materiality_threshold_cents: 0,
      restated_target_cents: 100000, black_friday_date: null,
    } as never);
    await insertOverheadPool(db(), {
      tenant_id: tenantId, division: "maintenance", pool_type: "shop",
      annual_cost_cents: 19640000, driver: "sellable_hours", as_of: "2026-08-01",
    });
    await insertOverheadAllocation(db(), {
      tenant_id: tenantId, division: "maintenance", as_of: "2026-08-01",
      sellable_hours: 8110, allocated_overhead_cents: 19640000,
      weighted_labor_rate_cents: 3840, overhead_rate: 242170,
      absorbed_cost_cents: 6262, target_margin: 4000, required_bill_rate_cents: 10437,
    });
    const result = await gatherTenantRollupInputs(db(), tenantId, "2026-08-03");
    expect(result?.blended_overhead_rate).toBeGreaterThan(0);
  });
});

describe("listTenantIdsWithPolicy", () => {
  it("GI-06 returns distinct tenant_ids that have a tenant_finance_policy row", async () => {
    const tenantId = "t-gather-list";
    await upsertTenantFinancePolicy(db(), {
      tenant_id: tenantId, equipment_engine_active: 0, materiality_threshold_cents: 0,
      restated_target_cents: 0, black_friday_date: null,
    } as never);
    const ids = await listTenantIdsWithPolicy(db());
    expect(ids).toContain(tenantId);
  });
});
