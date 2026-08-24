/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import {
  getTenantFinancePolicy, upsertTenantFinancePolicy,
  insertLaborRateProfile, getLaborRateAsOf, recalibrateLaborRate,
  insertEquipmentRateProfile, getEquipmentRateAsOf, recalibrateEquipmentRate,
  getWorkItem, listCompletedUnbilledWorkItems, updateWorkOrderFinanceColumns,
  postTimeEntry, getTimeEntry,
  postJobCostLedgerLines, getJobCostLedgerForJob,
  insertOverheadPool, insertOverheadAllocation, getOverheadAllocationAsOf,
  upsertRecoverySnapshot, getLatestRecoverySnapshot,
  insertActionItem, getOpenActionItems, resolveActionItem,
  insertClassificationFinding,
  insertReceipt, getReceiptByHash,
  getConfigOverride, upsertConfigOverride, deleteConfigOverride, listConfigOverrides, GLOBAL_CONFIG_SCOPE,
} from "./repos";

const db = () => env.DB;
const TENANT = "t-round-trip";

/** work_orders/time_entries live in this same DB now (migrations/0057_finance_merge.sql)
 * — repos.ts's Finance-side functions read/write a slim view over them, so
 * tests seed the real CRM tables directly rather than a separate Finance table. */
async function seedWorkOrder(id: string, opts: { status?: string } = {}) {
  await db().prepare(
    `INSERT INTO work_orders (id, company_id, wo_number, status) VALUES (?,?,?,?)`,
  ).bind(id, TENANT, `WO-${id}`, opts.status ?? "scheduled").run();
}

async function seedTimeEntry(id: string, workOrderId: string, hoursHundredths: number) {
  // duration_min chosen so hours_hundredths (computed as ROUND(duration_min*100/60))
  // comes out to the requested value: duration_min = hoursHundredths * 60/100.
  const durationMin = Math.round((hoursHundredths * 60) / 100);
  await db().prepare(
    `INSERT INTO time_entries (id, rep_id, company_id, clock_in, clock_out, duration_min, work_order_id) VALUES (?,?,?,?,?,?,?)`,
  ).bind(id, "emp-1", TENANT, "2026-07-01T08:00:00Z", "2026-07-01T16:00:00Z", durationMin, workOrderId).run();
}

describe("tenant_finance_policy", () => {
  it("round-trips and upserts", async () => {
    await upsertTenantFinancePolicy(db(), {
      company_id: TENANT, equipment_engine_active: 0,
      materiality_threshold_cents: 50000, restated_target_cents: 59100000,
      black_friday_date: "2026-12-21", created_at: "", updated_at: "",
    } as never);
    let p = await getTenantFinancePolicy(db(), TENANT);
    expect(p?.equipment_engine_active).toBe(0);

    await upsertTenantFinancePolicy(db(), {
      company_id: TENANT, equipment_engine_active: 1,
      materiality_threshold_cents: 50000, restated_target_cents: 59100000,
      black_friday_date: "2026-12-21", created_at: "", updated_at: "",
    } as never);
    p = await getTenantFinancePolicy(db(), TENANT);
    expect(p?.equipment_engine_active).toBe(1);
  });
});

describe("labor_rate_profile — immutability (BH-06/BH-07/BH-11)", () => {
  const base = {
    company_id: TENANT, scope: "employee" as const, scope_id: "emp-1",
    wage_cents: 2400, paid_hours: 2080, pto_hours: 96, shop_hours: 168,
    idle_hours: 194, tax_rate: 865, comp_rate: 700, benefits_monthly_cents: 26000,
    support_truck_annual_cents: 420000, support_tools_annual_cents: 83400,
    support_equipment_annual_cents: 240000, require_rate_approval: 0 as const,
    effective_from: "2026-01-01", effective_to: null,
  };

  it("BH-07: an entry dated before a rate change resolves to the OLDER profile", async () => {
    await insertLaborRateProfile(db(), base);
    await recalibrateLaborRate(db(), TENANT, "employee", "emp-1", {
      ...base, wage_cents: 2600, effective_from: "2026-06-01",
    });

    const before = await getLaborRateAsOf(db(), TENANT, "employee", "emp-1", "2026-03-01");
    expect(before?.wage_cents).toBe(2400);

    const after = await getLaborRateAsOf(db(), TENANT, "employee", "emp-1", "2026-07-01");
    expect(after?.wage_cents).toBe(2600);
  });

  it("BH-11: recalibration INSERTs a new row, sets effective_to on the prior row, history unchanged", async () => {
    const scopeId = "emp-2";
    await insertLaborRateProfile(db(), { ...base, scope_id: scopeId });
    const priorBefore = await getLaborRateAsOf(db(), TENANT, "employee", scopeId, "2026-01-15");
    expect(priorBefore?.effective_to).toBeNull();
    expect(priorBefore?.wage_cents).toBe(2400);

    await recalibrateLaborRate(db(), TENANT, "employee", scopeId, {
      ...base, scope_id: scopeId, wage_cents: 2500, effective_from: "2026-04-01",
    });

    // Prior row's rate/cost fields are untouched — only effective_to changed.
    const { results } = await db().prepare(
      `SELECT * FROM labor_rate_profile WHERE company_id = ? AND scope_id = ? ORDER BY effective_from ASC`,
    ).bind(TENANT, scopeId).all();
    expect(results.length).toBe(2);
    const [prior, next] = results as any[];
    expect(prior.wage_cents).toBe(2400); // history unchanged
    expect(prior.effective_to).toBe("2026-04-01"); // only this field changed
    expect(next.wage_cents).toBe(2500);
    expect(next.effective_to).toBeNull();
  });
});

describe("equipment_rate_profile — immutability", () => {
  const base = {
    company_id: TENANT, equipment_id: "eq-1", purchase_price_cents: 6200000,
    salvage_cents: 1400000, life_years: 7, annual_machine_hours: 720,
    finance_rate: 750, insurance_annual_cents: 118000, storage_annual_cents: 60000,
    fuel_gal_per_hr: 24000, fuel_price_cents: 405, repairs_annual_cents: 490000,
    wear_annual_cents: 330000, lube_pct_of_fuel: 1200,
    effective_from: "2026-01-01", effective_to: null,
  };

  it("recalibration inserts new row and closes the prior one, never rewriting cost fields", async () => {
    await insertEquipmentRateProfile(db(), base);
    await recalibrateEquipmentRate(db(), TENANT, "eq-1", {
      ...base, purchase_price_cents: 6500000, effective_from: "2026-05-01",
    });

    const asOfEarly = await getEquipmentRateAsOf(db(), TENANT, "eq-1", "2026-02-01");
    expect(asOfEarly?.purchase_price_cents).toBe(6200000);
    const asOfLate = await getEquipmentRateAsOf(db(), TENANT, "eq-1", "2026-06-01");
    expect(asOfLate?.purchase_price_cents).toBe(6500000);
  });
});

describe("work_item (folded onto work_orders)", () => {
  it("round-trips and lists completed-unbilled", async () => {
    await seedWorkOrder("wi-1", { status: "completed" });
    await updateWorkOrderFinanceColumns(db(), TENANT, "wi-1", 12000, "2026-07-01");

    const wi = await getWorkItem(db(), TENANT, "wi-1");
    expect(wi?.status).toBe("complete");

    const completed = await listCompletedUnbilledWorkItems(db(), TENANT);
    expect(completed.some((w) => w.id === "wi-1")).toBe(true);
  });
});

describe("time_entry — posting is write-once (folded onto time_entries)", () => {
  it("posts resolved_rate/applied_overhead once; a second post is a no-op", async () => {
    await seedWorkOrder("wo-post-1");
    await seedTimeEntry("te-post-1", "wo-post-1", 800);

    const firstPost = await postTimeEntry(db(), TENANT, "te-post-1", 421002, "high", 27430);
    expect(firstPost).toBe(true);

    const entry = await getTimeEntry(db(), TENANT, "te-post-1");
    expect(entry?.resolved_rate).toBe(421002);
    expect(entry?.hours_hundredths).toBe(800);

    // Attempting to post again with a different rate must not overwrite it.
    const secondPost = await postTimeEntry(db(), TENANT, "te-post-1", 999999, "high", 1);
    expect(secondPost).toBe(false);
    const unchanged = await getTimeEntry(db(), TENANT, "te-post-1");
    expect(unchanged?.resolved_rate).toBe(421002);
  });
});

describe("job_cost_ledger — two-line post", () => {
  it("writes exactly one labor line and one overhead line, atomically", async () => {
    await seedWorkOrder("job-2");
    await seedTimeEntry("te-job-2", "job-2", 800);
    await postJobCostLedgerLines(
      db(),
      { company_id: TENANT, time_entry_id: "te-job-2", job_id: "job-2", amount_cents: 33680, division: "maintenance" },
      { company_id: TENANT, time_entry_id: "te-job-2", job_id: "job-2", amount_cents: 19374, division: "maintenance" },
    );
    const lines = await getJobCostLedgerForJob(db(), TENANT, "job-2");
    expect(lines.length).toBe(2);
    expect(lines.map((l) => l.line_type).sort()).toEqual(["labor", "overhead"]);
  });
});

describe("overhead_pool / overhead_allocation", () => {
  it("round-trips a division allocation row", async () => {
    await insertOverheadPool(db(), {
      company_id: TENANT, division: "maintenance", pool_type: "shop",
      annual_cost_cents: 19640000, driver: "sellable_hours", as_of: "2026-08-01",
    });
    await insertOverheadAllocation(db(), {
      company_id: TENANT, division: "maintenance", as_of: "2026-08-01",
      sellable_hours: 8110, allocated_overhead_cents: 19640000,
      weighted_labor_rate_cents: 3840, overhead_rate: 242170,
      absorbed_cost_cents: 6262, target_margin: 4000, required_bill_rate_cents: 10437,
    });
    const rows = await getOverheadAllocationAsOf(db(), TENANT, "2026-08-01");
    expect(rows.length).toBe(1);
    expect(rows[0].required_bill_rate_cents).toBe(10437);
  });
});

describe("recovery_snapshot", () => {
  it("upserts by (company_id, as_of) — a re-run replaces, not duplicates", async () => {
    const row = {
      company_id: TENANT, as_of: "2026-08-03", restated_target_cents: 59100000,
      recovered_to_date_cents: 38190000, hours_per_week_hundredths: 38000,
      blended_overhead_rate: 274300, weekly_recovery_cents: 1042340,
      pct_recovered_millionths: 646193, projected_black_friday: "2026-12-21",
      confidence_days: 13,
    };
    await upsertRecoverySnapshot(db(), row);
    await upsertRecoverySnapshot(db(), { ...row, recovered_to_date_cents: 39000000 });

    const latest = await getLatestRecoverySnapshot(db(), TENANT);
    expect(latest?.recovered_to_date_cents).toBe(39000000);

    const { results } = await db().prepare(
      `SELECT COUNT(*) as n FROM recovery_snapshot WHERE company_id = ? AND as_of = ?`,
    ).bind(TENANT, "2026-08-03").all();
    expect((results[0] as any).n).toBe(1);
  });
});

describe("action_item — five-verb constraint", () => {
  it("round-trips, lists open by verb, and resolves", async () => {
    await insertActionItem(db(), {
      id: "ai-1", company_id: TENANT, verb: "collect", owner_id: "user-1",
      sla_due: "2026-08-10", amount_cents: 5000, confidence: "high",
      stale_components: null, source_type: "work_order", source_id: "wi-1",
    });
    const open = await getOpenActionItems(db(), TENANT, "collect");
    expect(open.some((a) => a.id === "ai-1")).toBe(true);

    await resolveActionItem(db(), TENANT, "ai-1");
    const stillOpen = await getOpenActionItems(db(), TENANT, "collect");
    expect(stillOpen.some((a) => a.id === "ai-1")).toBe(false);
  });

  it("rejects a verb outside {collect,bill,pay,fix,decide} at the DB level", async () => {
    await expect(
      db().prepare(
        `INSERT INTO action_item (id, company_id, verb, owner_id, sla_due, confidence, status)
         VALUES (?, ?, 'approve', ?, ?, 'high', 'open')`,
      ).bind("ai-bad", TENANT, "user-1", "2026-08-10").run(),
    ).rejects.toThrow();
  });
});

describe("classification_finding", () => {
  it("round-trips", async () => {
    await insertClassificationFinding(db(), {
      id: "cf-1", company_id: TENANT, subject_type: "pnl_line", subject_id: "line-1",
      stage_reached: 4, confidence: "medium", materiality_cents: 2500,
      proposed_change: null, action_item_id: null,
    });
    const { results } = await db().prepare(
      `SELECT * FROM classification_finding WHERE id = ?`,
    ).bind("cf-1").all();
    expect(results.length).toBe(1);
  });
});

describe("receipt — dedupe by hash", () => {
  it("round-trips and finds by content hash", async () => {
    await seedWorkOrder("job-1");
    await insertReceipt(db(), {
      id: "r-1", company_id: TENANT, job_id: "job-1", r2_key: "receipts/r-1.jpg",
      content_hash: "hash-abc", vendor: "Acme Supply", amount_cents: 4599,
      receipt_date: "2026-07-01", field_confidence: null, action_item_id: null,
      receipt_number: null,
    });
    const found = await getReceiptByHash(db(), TENANT, "hash-abc");
    expect(found?.id).toBe("r-1");
    const notFound = await getReceiptByHash(db(), TENANT, "hash-does-not-exist");
    expect(notFound).toBeNull();
  });
});

describe("finance_config_override — tenant beats global beats nothing", () => {
  it("returns null when no override exists at any scope", async () => {
    const result = await getConfigOverride(db(), "t-cfg-none", "classifier_rules");
    expect(result).toBeNull();
  });

  it("a global override applies when no tenant-specific override exists", async () => {
    await upsertConfigOverride(db(), GLOBAL_CONFIG_SCOPE, "automation_policy", '{"classifier_enabled":false}', "admin-1");
    const result = await getConfigOverride(db(), "t-cfg-global", "automation_policy");
    expect(result?.company_id).toBe(GLOBAL_CONFIG_SCOPE);
    expect(result?.config_json).toContain("classifier_enabled");
  });

  it("a tenant-specific override takes precedence over a global one", async () => {
    await upsertConfigOverride(db(), GLOBAL_CONFIG_SCOPE, "approval_thresholds", '{"default_materiality_threshold_cents":50000}', "admin-1");
    await upsertConfigOverride(db(), "t-cfg-specific", "approval_thresholds", '{"default_materiality_threshold_cents":99999}', "admin-2");
    const result = await getConfigOverride(db(), "t-cfg-specific", "approval_thresholds");
    expect(result?.company_id).toBe("t-cfg-specific");
    expect(result?.config_json).toContain("99999");
  });

  it("upsert replaces an existing override for the same scope, not duplicates", async () => {
    await upsertConfigOverride(db(), "t-cfg-upsert", "division_map", '{"v":1}', "admin-1");
    await upsertConfigOverride(db(), "t-cfg-upsert", "division_map", '{"v":2}', "admin-2");
    const result = await getConfigOverride(db(), "t-cfg-upsert", "division_map");
    expect(result?.config_json).toBe('{"v":2}');
    expect(result?.updated_by).toBe("admin-2");
    const { results } = await db().prepare(
      `SELECT COUNT(*) as n FROM finance_config_override WHERE company_id = ? AND config_name = ?`,
    ).bind("t-cfg-upsert", "division_map").all();
    expect((results[0] as any).n).toBe(1);
  });

  it("delete removes an override, reverting to the next scope down", async () => {
    await upsertConfigOverride(db(), "t-cfg-delete", "tenant_defaults", '{"v":1}', "admin-1");
    await deleteConfigOverride(db(), "t-cfg-delete", "tenant_defaults");
    const result = await getConfigOverride(db(), "t-cfg-delete", "tenant_defaults");
    expect(result).toBeNull();
  });

  it("listConfigOverrides returns both the tenant's own and global overrides", async () => {
    const tenantId = "t-cfg-list";
    await upsertConfigOverride(db(), GLOBAL_CONFIG_SCOPE, "ingest_sources", '{"g":1}', "admin-1");
    await upsertConfigOverride(db(), tenantId, "classifier_rules", '{"t":1}', "admin-1");
    const list = await listConfigOverrides(db(), tenantId);
    const names = list.map((o) => o.config_name);
    expect(names).toContain("ingest_sources");
    expect(names).toContain("classifier_rules");
  });
});
