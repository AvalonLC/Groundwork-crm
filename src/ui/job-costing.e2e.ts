import { test, expect } from "@playwright/test";
import { resetFinanceDb, exec } from "./test-seed";

const TENANT = "t-e2e-jobcost";
const JOB = "job-e2e-1";

test.beforeEach(async ({ request }) => {
  await resetFinanceDb(request, TENANT);
  await exec(request,
    `INSERT INTO work_item (id, tenant_id, job_id, description, status, estimate_cents, completed_at) VALUES (?,?,?,?,?,?,?)`,
    [JOB, TENANT, JOB, "mow + edge", "complete", 60000, "2026-07-01"]);
  await exec(request,
    `INSERT INTO time_entry (tenant_id, employee_id, crew_id, job_id, work_date, hours_hundredths, ot_hours_hundredths, resolved_rate, posted_at) VALUES (?,?,?,?,?,?,?,?, datetime('now'))`,
    [TENANT, "emp-1", null, JOB, "2026-07-01", 800, 0, 421002]);
  await exec(request,
    `INSERT INTO job_cost_ledger (tenant_id, time_entry_id, job_id, line_type, amount_cents, division) VALUES (?, (SELECT id FROM time_entry WHERE job_id = ? LIMIT 1), ?, 'labor', ?, ?)`,
    [TENANT, JOB, JOB, 33680, "maintenance"]);
  await exec(request,
    `INSERT INTO job_cost_ledger (tenant_id, time_entry_id, job_id, line_type, amount_cents, division) VALUES (?, (SELECT id FROM time_entry WHERE job_id = ? LIMIT 1), ?, 'overhead', ?, ?)`,
    [TENANT, JOB, JOB, 19374, "maintenance"]);
});

test("UJ-01 applied overhead shows labor, overhead, and total cost lines", async ({ page }) => {
  await page.goto(`/job-costing?tenant_id=${TENANT}&job_id=${JOB}&role=owner`);
  await expect(page.getByTestId("labor-cost")).toHaveText("336.80");
  await expect(page.getByTestId("overhead-cost")).toHaveText("193.74");
  await expect(page.getByTestId("total-cost")).toHaveText("530.54");
});

test("UJ-02 hours vs estimate shows the work_item's estimate", async ({ page }) => {
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
