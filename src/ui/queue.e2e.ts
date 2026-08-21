import { test, expect } from "@playwright/test";
import { resetFinanceDb, exec } from "./test-seed";

const TENANT = "t-e2e-queue";

test.beforeEach(async ({ request }) => {
  await resetFinanceDb(request, TENANT);
  await exec(request,
    `INSERT INTO action_item (id, company_id, verb, owner_id, sla_due, amount_cents, confidence, stale_components, source_type, status) VALUES (?,?,?,?,?,?,?,?,?, 'open')`,
    ["ai-q-late", TENANT, "fix", "user-1", "2026-08-05", 1000, "low", '["utilization"]', "classification_finding"]);
  await exec(request,
    `INSERT INTO action_item (id, company_id, verb, owner_id, sla_due, amount_cents, confidence, source_type, status) VALUES (?,?,?,?,?,?,?,?, 'open')`,
    ["ai-q-soon", TENANT, "collect", "user-2", "2026-08-20", 2000, "high", null]);
});

test("UQ-01 items are sorted by sla_due, soonest first (SLA clocks)", async ({ page }) => {
  await page.goto(`/queue?tenant_id=${TENANT}`);
  const items = page.getByTestId("queue-list").locator("li");
  await expect(items.first()).toHaveAttribute("data-testid", "queue-item-ai-q-late");
});

test("UQ-02 AI first-pass items are labeled, manual ones are labeled differently", async ({ page }) => {
  await page.goto(`/queue?tenant_id=${TENANT}`);
  await expect(page.getByTestId("ai-first-pass-ai-q-late")).toContainText("classification_finding");
  await expect(page.getByTestId("human-ai-q-soon")).toBeVisible();
});

test("UQ-03 confidence panel shows confidence and stale_components per item", async ({ page }) => {
  await page.goto(`/queue?tenant_id=${TENANT}`);
  const panel = await page.getByTestId("confidence-panel-ai-q-late").innerText();
  expect(panel).toContain("confidence: low");
  expect(panel).toContain("stale");
  expect(panel).toContain("utilization");
});

test("UQ-04 Resolve marks the item resolved and removes it from the open queue", async ({ page, request }) => {
  await page.goto(`/queue?tenant_id=${TENANT}`);
  await page.getByTestId("resolve-ai-q-late").click();

  // Full-page (non-partial) request redirects back to the queue with a notice.
  await expect(page.getByTestId("notice")).toHaveText(/Resolved/);
  await expect(page.getByTestId("queue-item-ai-q-late")).toHaveCount(0);
  // The other, untouched item should still be listed.
  await expect(page.getByTestId("queue-item-ai-q-soon")).toBeVisible();

  const res = await request.post("/test/exec", {
    data: { sql: `SELECT status, resolved_at FROM action_item WHERE id = ?`, params: ["ai-q-late"] }
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { results: { status: string; resolved_at: string | null }[] };
  expect(body.results[0].status).toBe("resolved");
  expect(body.results[0].resolved_at).toBeTruthy();
});

test("UQ-05 Dismiss marks the item dismissed and removes it from the open queue", async ({ page, request }) => {
  await page.goto(`/queue?tenant_id=${TENANT}`);
  await page.getByTestId("dismiss-ai-q-soon").click();

  await expect(page.getByTestId("notice")).toHaveText(/Dismissed/);
  await expect(page.getByTestId("queue-item-ai-q-soon")).toHaveCount(0);
  await expect(page.getByTestId("queue-item-ai-q-late")).toBeVisible();

  const res = await request.post("/test/exec", {
    data: { sql: `SELECT status, resolved_at FROM action_item WHERE id = ?`, params: ["ai-q-soon"] }
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { results: { status: string; resolved_at: string | null }[] };
  expect(body.results[0].status).toBe("dismissed");
  expect(body.results[0].resolved_at).toBeTruthy();
});
