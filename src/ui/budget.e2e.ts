import { test, expect } from "@playwright/test";
import { resetFinanceDb, exec } from "./test-seed";

const TENANT = "t-e2e-budget";

test.beforeEach(async ({ request }) => {
  await resetFinanceDb(request, TENANT);
  await exec(request,
    `INSERT INTO labor_rate_profile (tenant_id, scope, scope_id, wage_cents, paid_hours, pto_hours, shop_hours, idle_hours, tax_rate, comp_rate, benefits_monthly_cents, support_truck_annual_cents, support_tools_annual_cents, support_equipment_annual_cents, require_rate_approval, effective_from, effective_to) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
    [TENANT, "employee", "emp-budget-1", 2400, 2080, 96, 168, 194, 865, 700, 26000, 420000, 83400, 240000, 0, "2026-01-01"]);
  await exec(request,
    `INSERT INTO equipment_rate_profile (tenant_id, equipment_id, purchase_price_cents, salvage_cents, life_years, annual_machine_hours, finance_rate, insurance_annual_cents, storage_annual_cents, fuel_gal_per_hr, fuel_price_cents, repairs_annual_cents, wear_annual_cents, lube_pct_of_fuel, effective_from, effective_to) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
    [TENANT, "eq-budget-1", 6200000, 1400000, 7, 720, 750, 118000, 60000, 24000, 405, 490000, 330000, 1200, "2026-01-01"]);
  await exec(request,
    `INSERT INTO overhead_pool (tenant_id, division, pool_type, annual_cost_cents, driver, as_of) VALUES (?,?,?,?,?,?)`,
    [TENANT, "maintenance", "shop", 15000000, "sellable_hours", "2026-08-01"]);
});

test("UB-01 owner sees both rate types and the driver map", async ({ page }) => {
  await page.goto(`/budget?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("labor-wage-emp-budget-1")).toHaveText("24.00");
  await expect(page.getByTestId("equipment-price-eq-budget-1")).toHaveText("62000.00");
  await expect(page.getByTestId("driver-maintenance-shop")).toHaveText("sellable_hours");
});

test("UB-02 forbidden by role design: only owner can see budget rates", async ({ page }) => {
  for (const role of ["crew", "crew_lead", "office"]) {
    const res = await page.goto(`/budget?tenant_id=${TENANT}&role=${role}`);
    expect(res?.status()).toBe(403);
    await expect(page.getByTestId("denied")).toBeVisible();
  }
});
