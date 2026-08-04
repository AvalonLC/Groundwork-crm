/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { postTimeEntryToLedger } from "./posting";
import {
  insertTimeEntry, insertLaborRateProfile, upsertTenantFinancePolicy,
  insertOverheadAllocation, getTimeEntry, getJobCostLedgerForJob,
} from "../db/repos";

const db = () => env.FINANCE_DB;
const TENANT = "t-posting";

async function seedRateAndAllocation(scopeId: string, jobId: string) {
  await upsertTenantFinancePolicy(db(), {
    tenant_id: TENANT, equipment_engine_active: 0, materiality_threshold_cents: 0,
    restated_target_cents: 0, black_friday_date: null,
  } as never);
  await insertLaborRateProfile(db(), {
    tenant_id: TENANT, scope: "employee", scope_id: scopeId,
    wage_cents: 2400, paid_hours: 2080, pto_hours: 96, shop_hours: 168, idle_hours: 194,
    tax_rate: 865, comp_rate: 700, benefits_monthly_cents: 26000,
    support_truck_annual_cents: 420000, support_tools_annual_cents: 83400,
    support_equipment_annual_cents: 240000, require_rate_approval: 0,
    effective_from: "2026-01-01", effective_to: null,
  });
  await insertOverheadAllocation(db(), {
    tenant_id: TENANT, division: "maintenance", as_of: "2026-01-01",
    sellable_hours: 8110, allocated_overhead_cents: 19640000,
    weighted_labor_rate_cents: 3840, overhead_rate: 242170,
    absorbed_cost_cents: 6262, target_margin: 4000, required_bill_rate_cents: 10437,
  });
}

describe("time entry posting", () => {
  it("PT-01 posts a two-line ledger and writes resolved_rate/applied_overhead", async () => {
    await seedRateAndAllocation("emp-post-1", "job-1");
    const id = await insertTimeEntry(db(), {
      tenant_id: TENANT, employee_id: "emp-post-1", crew_id: null, job_id: "job-1",
      work_date: "2026-06-01", hours_hundredths: 800, ot_hours_hundredths: 0,
    });

    const result = await postTimeEntryToLedger(db(), TENANT, id, "maintenance");
    expect(result.success).toBe(true);

    const entry = await getTimeEntry(db(), TENANT, id);
    expect(entry?.posted_at).not.toBeNull();
    expect(entry?.resolved_rate).toBe((result as any).resolved_rate);

    const lines = await getJobCostLedgerForJob(db(), TENANT, "job-1");
    expect(lines.length).toBe(2);
  });

  it("immutability: a second post never recomputes resolved_rate or duplicates ledger lines", async () => {
    await seedRateAndAllocation("emp-post-2", "job-2");
    const id = await insertTimeEntry(db(), {
      tenant_id: TENANT, employee_id: "emp-post-2", crew_id: null, job_id: "job-2",
      work_date: "2026-06-01", hours_hundredths: 800, ot_hours_hundredths: 0,
    });

    const first = await postTimeEntryToLedger(db(), TENANT, id, "maintenance");
    expect(first.success).toBe(true);
    const rateAfterFirst = (await getTimeEntry(db(), TENANT, id))?.resolved_rate;

    // Recalibrate the rate profile between the two posting attempts — a
    // recompute-on-read bug would pick this up; write-once must not.
    await insertLaborRateProfile(db(), {
      tenant_id: TENANT, scope: "employee", scope_id: "emp-post-2",
      wage_cents: 9999, paid_hours: 2080, pto_hours: 96, shop_hours: 168, idle_hours: 194,
      tax_rate: 865, comp_rate: 700, benefits_monthly_cents: 26000,
      support_truck_annual_cents: 420000, support_tools_annual_cents: 83400,
      support_equipment_annual_cents: 240000, require_rate_approval: 0,
      effective_from: "2026-01-01", effective_to: null,
    });

    const second = await postTimeEntryToLedger(db(), TENANT, id, "maintenance");
    expect(second).toEqual({ success: false, reason: "already_posted" });

    const rateAfterSecond = (await getTimeEntry(db(), TENANT, id))?.resolved_rate;
    expect(rateAfterSecond).toBe(rateAfterFirst); // never recomputed on read

    const lines = await getJobCostLedgerForJob(db(), TENANT, "job-2");
    expect(lines.length).toBe(2); // not 4 — no duplicate ledger lines
  });

  it("PT-03 not_found for a time_entry that doesn't exist", async () => {
    const result = await postTimeEntryToLedger(db(), TENANT, 999999, "maintenance");
    expect(result).toEqual({ success: false, reason: "not_found" });
  });

  it("PT-04 no_rate_resolves when no labor rate profile exists for the employee", async () => {
    const id = await insertTimeEntry(db(), {
      tenant_id: TENANT, employee_id: "emp-no-rate", crew_id: null, job_id: "job-3",
      work_date: "2026-06-01", hours_hundredths: 800, ot_hours_hundredths: 0,
    });
    const result = await postTimeEntryToLedger(db(), TENANT, id, "maintenance");
    expect(result).toEqual({ success: false, reason: "no_rate_resolves" });
  });

  it("PT-05 no_overhead_allocation when the division has no allocation on record", async () => {
    await upsertTenantFinancePolicy(db(), {
      tenant_id: TENANT, equipment_engine_active: 0, materiality_threshold_cents: 0,
      restated_target_cents: 0, black_friday_date: null,
    } as never);
    await insertLaborRateProfile(db(), {
      tenant_id: TENANT, scope: "employee", scope_id: "emp-post-5",
      wage_cents: 2400, paid_hours: 2080, pto_hours: 96, shop_hours: 168, idle_hours: 194,
      tax_rate: 865, comp_rate: 700, benefits_monthly_cents: 26000,
      support_truck_annual_cents: 420000, support_tools_annual_cents: 83400,
      support_equipment_annual_cents: 240000, require_rate_approval: 0,
      effective_from: "2026-01-01", effective_to: null,
    });
    const id = await insertTimeEntry(db(), {
      tenant_id: TENANT, employee_id: "emp-post-5", crew_id: null, job_id: "job-5",
      work_date: "2026-06-01", hours_hundredths: 800, ot_hours_hundredths: 0,
    });
    const result = await postTimeEntryToLedger(db(), TENANT, id, "division-with-no-allocation");
    expect(result).toEqual({ success: false, reason: "no_overhead_allocation" });
  });
});
