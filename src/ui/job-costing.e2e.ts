import { test, expect } from "@playwright/test";
import { resetFinanceDb, resetCrmDb, exec, execCrm } from "./test-seed";

const TENANT = "t-e2e-jobcost";
const JOB = "job-e2e-1";
const TIME_ENTRY = "te-e2e-1";

test.beforeEach(async ({ request }) => {
  await resetFinanceDb(request, TENANT);
  await resetCrmDb(request, TENANT);
  // work_item folded into work_orders (migrations/0057_finance_merge.sql) —
  // estimate_cents/finance_completed_at live on the work order itself now.
  await execCrm(request,
    `INSERT INTO work_orders (id, company_id, wo_number, status, estimate_cents, finance_completed_at) VALUES (?,?,?,?,?,?)`,
    [JOB, TENANT, "WO-E2E-1", "completed", 60000, "2026-07-01"]);
  // time_entry folded into time_entries — hours_hundredths is derived from
  // duration_min at read time (8h = 480min = 800 hundredths), not stored.
  await execCrm(request,
    `INSERT INTO time_entries (id, rep_id, company_id, clock_in, clock_out, duration_min, work_order_id, resolved_rate, posted_at) VALUES (?,?,?,?,?,?,?,?, datetime('now'))`,
    [TIME_ENTRY, "emp-1", TENANT, "2026-07-01T08:00:00Z", "2026-07-01T16:00:00Z", 480, JOB, 421002]);
  await exec(request,
    `INSERT INTO job_cost_ledger (company_id, time_entry_id, job_id, line_type, amount_cents, division) VALUES (?,?,?,'labor',?,?)`,
    [TENANT, TIME_ENTRY, JOB, 33680, "maintenance"]);
  await exec(request,
    `INSERT INTO job_cost_ledger (company_id, time_entry_id, job_id, line_type, amount_cents, division) VALUES (?,?,?,'overhead',?,?)`,
    [TENANT, TIME_ENTRY, JOB, 19374, "maintenance"]);
});

test("UJ-01 applied overhead shows labor, overhead, and total cost lines", async ({ page }) => {
  await page.goto(`/job-costing?tenant_id=${TENANT}&job_id=${JOB}&role=owner`);
  await expect(page.getByTestId("labor-cost")).toHaveText("336.80");
  await expect(page.getByTestId("overhead-cost")).toHaveText("193.74");
  await expect(page.getByTestId("total-cost")).toHaveText("530.54");
});

test("UJ-02 hours vs estimate shows the work order's estimate", async ({ page }) => {
  await page.goto(`/job-costing?tenant_id=${TENANT}&job_id=${JOB}&role=owner`);
  await expect(page.getByTestId("estimate-cents")).toHaveText("600.00");
});

test("crew-cannot-see-margin: owner sees live margin, crew does not", async ({ page }) => {
  await page.goto(`/job-costing?tenant_id=${TENANT}&job_id=${JOB}&role=owner`);
  await expect(page.getByTestId("margin-cents")).toHaveText("69.46"); // 600 - 530.54

  await page.goto(`/job-costing?tenant_id=${TENANT}&job_id=${JOB}&role=crew`);
  await expect(page.getByTestId("margin-hidden")).toBeVisible();
  await expect(page.getByTestId("margin-cents")).toHaveCount(0);
});
