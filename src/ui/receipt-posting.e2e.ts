import { test, expect, type APIRequestContext } from "@playwright/test";
import { resetFinanceDb, exec } from "./test-seed";

const TENANT = "t-e2e-post-receipts";
const OTHER_TENANT = "t-e2e-post-receipts-other";

test.beforeEach(async ({ request }) => {
  await resetFinanceDb(request, TENANT);
  await resetFinanceDb(request, OTHER_TENANT);
});

/** exec() (test-seed.ts) only confirms ok()/throws — it never hands back
 * rows, so any test that needs to read a value back (a SELECT, or an
 * INSERT/UPDATE's returned row count) must hit /test/exec directly and
 * parse its {ok, meta, results} body itself. Kept local to this file since
 * no other *.e2e.ts suite currently needs SELECT verification this heavily. */
async function querySql<T = Record<string, unknown>>(
  request: APIRequestContext, sql: string, params: unknown[] = [],
): Promise<T[]> {
  const res = await request.post("/test/exec", { data: { sql, params } });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { results: T[] };
  return body.results;
}

/** Seeds a work order (+ optionally a crew with a division, wired via
 * crew_id) directly against the shared local D1 — the same tables
 * document-upload.tsx / receipt-posting.tsx read through
 * listAssignableJobsForTenant / getJobDivision. */
async function seedJob(
  request: APIRequestContext, companyId: string, jobId: string,
  opts: { crewId?: string; division?: string; status?: string } = {},
) {
  let crewId = opts.crewId ?? null;
  if (opts.division && !crewId) {
    crewId = `crew-${jobId}`;
    await exec(request, `INSERT INTO crews (id, company_id, name, division) VALUES (?,?,?,?)`,
      [crewId, companyId, `Crew ${crewId}`, opts.division]);
  }
  await exec(request,
    `INSERT INTO work_orders (id, company_id, wo_number, title, client_name, status, crew_id) VALUES (?,?,?,?,?,?,?)`,
    [jobId, companyId, `WO-${jobId}`, `Job ${jobId}`, "Acme Client", opts.status ?? "scheduled", crewId]);
  return crewId;
}

/** Seeds an approved receipt, optionally already job/category-assigned or
 * already posted, directly against `receipt` — mirrors seedReceipt from
 * src/db/job-progress-repos.test.ts but through the e2e /test/exec path. */
async function seedApprovedReceipt(
  request: APIRequestContext, companyId: string, id: string,
  opts: {
    jobId?: string | null; costCategory?: string | null; amountCents?: number;
    progressEligible?: 0 | 1; posted?: boolean; vendor?: string;
  } = {},
) {
  await exec(request, `
    INSERT INTO receipt
      (id, company_id, job_id, r2_key, content_hash, vendor, amount_cents, receipt_date, status, cost_category, progress_eligible)
    VALUES (?,?,?,?,?,?,?,?, 'approved', ?, ?)
  `, [
    id, companyId, opts.jobId ?? null, `r2/${id}`, `hash-${id}`,
    opts.vendor ?? "Acme Supply", opts.amountCents ?? 5000, "2026-07-01",
    opts.costCategory ?? null, opts.progressEligible ?? 1,
  ]);
  if (opts.posted) {
    await exec(request, `UPDATE receipt SET posted_at = datetime('now') WHERE company_id = ? AND id = ?`, [companyId, id]);
  }
}

test("PC-01 upload with a valid tenant-owned work order attaches it, sends nothing to manual review", async ({ page, request }) => {
  const jobId = "job-valid";
  await seedJob(request, TENANT, jobId);

  await page.goto(`/upload?tenant_id=${TENANT}&role=owner`);
  await page.getByTestId("receipt-file-input").setInputFiles({
    name: "valid-job.jpg", mimeType: "image/jpeg", buffer: Buffer.from("valid-job-bytes"),
  });
  await page.getByTestId("receipt-vendor-input").fill("Acme Supply");
  await page.getByTestId("receipt-amount-input").fill("99.00");
  await page.getByTestId("receipt-date-input").fill("2026-07-01");
  await page.getByTestId("receipt-job-select").selectOption(jobId);
  await page.getByTestId("receipt-category-select").selectOption("materials");
  await page.getByTestId("receipt-submit").click();
  await expect(page.getByTestId("receipt-result")).toBeVisible();

  // Manually approve it (Documents page's own explicit step) so it can
  // reach the ready-to-post queue.
  await page.goto(`/documents?tenant_id=${TENANT}&role=owner`);
  await page.locator('[data-testid^="approve-"]').first().click();

  await page.goto(`/post-receipts?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("ready-to-post-list")).toContainText(`WO-${jobId}`);
  await expect(page.getByTestId("needs-assignment-list")).toContainText("Nothing waiting");
});

test("PC-02 upload without an assignment lands in the manual-review (needs-assignment) queue", async ({ page }) => {
  await page.goto(`/upload?tenant_id=${TENANT}&role=owner`);
  await page.getByTestId("receipt-file-input").setInputFiles({
    name: "unassigned.jpg", mimeType: "image/jpeg", buffer: Buffer.from("unassigned-bytes"),
  });
  await page.getByTestId("receipt-vendor-input").fill("Mystery Vendor");
  await page.getByTestId("receipt-amount-input").fill("42.00");
  await page.getByTestId("receipt-date-input").fill("2026-07-02");
  // job_id and cost_category left at their default "unassigned"/"not sure" options.
  await page.getByTestId("receipt-submit").click();
  await expect(page.getByTestId("receipt-result")).toBeVisible();

  await page.goto(`/documents?tenant_id=${TENANT}&role=owner`);
  await page.locator('[data-testid^="approve-"]').first().click();

  await page.goto(`/post-receipts?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId("needs-assignment-list")).toContainText("Mystery Vendor");
  await expect(page.getByTestId("ready-to-post-list")).toContainText("Nothing ready");
});

test("PC-03 cost-category persists after assign, and survives a page reload", async ({ page, request }) => {
  const jobId = "job-cat";
  await seedJob(request, TENANT, jobId);
  const receiptId = "rcpt-cat";
  await seedApprovedReceipt(request, TENANT, receiptId, { jobId, costCategory: null });

  await page.goto(`/post-receipts?tenant_id=${TENANT}&role=owner`);
  await page.getByTestId(`assign-category-${receiptId}`).selectOption("subcontractor");
  await page.getByTestId(`assign-save-${receiptId}`).click();

  await page.goto(`/post-receipts?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId(`post-receipt-category-${receiptId}`)).toContainText("subcontractor");

  const rows = await querySql<{ cost_category: string }>(request,
    `SELECT cost_category FROM receipt WHERE company_id = ? AND id = ?`, [TENANT, receiptId]);
  expect(rows[0]?.cost_category).toBe("subcontractor");
});

test("PC-04 progress-eligibility persists after assign (unchecking it sticks)", async ({ page, request }) => {
  const jobId = "job-prog";
  await seedJob(request, TENANT, jobId);
  const receiptId = "rcpt-prog";
  await seedApprovedReceipt(request, TENANT, receiptId, { jobId, costCategory: "materials", progressEligible: 1 });

  await page.goto(`/post-receipts?tenant_id=${TENANT}&role=owner`);
  await page.getByTestId(`assign-progress-eligible-${receiptId}`).uncheck();
  await page.getByTestId(`assign-save-${receiptId}`).click();

  const rows = await querySql<{ progress_eligible: number }>(request,
    `SELECT progress_eligible FROM receipt WHERE company_id = ? AND id = ?`, [TENANT, receiptId]);
  expect(rows[0]?.progress_eligible).toBe(0);

  await page.goto(`/post-receipts?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId(`assign-progress-eligible-${receiptId}`)).not.toBeChecked();
});

test("PC-05 authorized (office/owner) review and posting: Approve & post creates exactly one ledger line and shows posted state", async ({ page, request }) => {
  const jobId = "job-post";
  await seedJob(request, TENANT, jobId, { division: "landscape" });
  const receiptId = "rcpt-post";
  await seedApprovedReceipt(request, TENANT, receiptId, { jobId, costCategory: "materials", amountCents: 12345 });

  await page.goto(`/post-receipts?tenant_id=${TENANT}&role=office`);
  await expect(page.getByTestId(`post-submit-${receiptId}`)).toBeVisible();
  await page.getByTestId(`post-submit-${receiptId}`).click();

  await expect(page.getByTestId("notice")).toContainText("Posted");
  await expect(page.getByTestId(`post-receipt-posted-${receiptId}`)).toBeVisible();

  const lines = await querySql<{ id: number; amount_cents: number; job_id: string }>(request,
    `SELECT id, amount_cents, job_id FROM job_cost_ledger WHERE company_id = ? AND source_receipt_id = ?`,
    [TENANT, receiptId]);
  expect(lines.length).toBe(1);
  expect(lines[0].amount_cents).toBe(12345);
  expect(lines[0].job_id).toBe(jobId);
});

test("PC-06 unauthorized roles (crew, crew_lead) get 403 on every route: page, assign, post", async ({ page, request }) => {
  const jobId = "job-403";
  await seedJob(request, TENANT, jobId, { division: "landscape" });
  const receiptId = "rcpt-403";
  await seedApprovedReceipt(request, TENANT, receiptId, { jobId, costCategory: "materials" });

  for (const role of ["crew", "crew_lead"]) {
    const res = await page.goto(`/post-receipts?tenant_id=${TENANT}&role=${role}`);
    expect(res?.status()).toBe(403);
    await expect(page.getByTestId("denied")).toBeVisible();

    const assignRes = await request.post(
      `/post-receipts/${receiptId}/assign?tenant_id=${TENANT}&role=${role}`,
      { form: { job_id: jobId, cost_category: "materials" } },
    );
    expect(assignRes.status()).toBe(403);

    const postRes = await request.post(
      `/post-receipts/${receiptId}/post?tenant_id=${TENANT}&role=${role}`,
      { form: {} },
    );
    expect(postRes.status()).toBe(403);
  }

  // Confirm none of those unauthorized attempts actually posted anything.
  const rows = await querySql<{ posted_at: string | null }>(request,
    `SELECT posted_at FROM receipt WHERE company_id = ? AND id = ?`, [TENANT, receiptId]);
  expect(rows[0]?.posted_at).toBeNull();
  const lines = await querySql(request,
    `SELECT id FROM job_cost_ledger WHERE company_id = ? AND source_receipt_id = ?`, [TENANT, receiptId]);
  expect(lines.length).toBe(0);
});

test("PC-07 cross-tenant assignment is rejected: a job from another company never attaches, receipt stays unassigned", async ({ page, request }) => {
  const foreignJobId = "job-foreign";
  await seedJob(request, OTHER_TENANT, foreignJobId, { division: "landscape" });
  const receiptId = "rcpt-crosstenant";
  await seedApprovedReceipt(request, TENANT, receiptId, { jobId: null, costCategory: null });

  // A crafted POST straight at the assign route with a foreign-tenant job_id
  // — the UI would never render this option, but the server must still
  // reject it (never trust a raw form id).
  const res = await request.post(
    `/post-receipts/${receiptId}/assign?tenant_id=${TENANT}&role=owner`,
    { form: { job_id: foreignJobId, cost_category: "materials" } },
  );
  expect(res.ok()).toBe(true); // the route itself still responds (redirect); it just doesn't apply the bad id

  const rows = await querySql<{ job_id: string | null; cost_category: string | null }>(request,
    `SELECT job_id, cost_category FROM receipt WHERE company_id = ? AND id = ?`, [TENANT, receiptId]);
  expect(rows[0]?.job_id).toBeNull(); // cross-tenant assignment never landed
  expect(rows[0]?.cost_category).toBe("materials"); // the legitimate part of the same submission still saved

  await page.goto(`/post-receipts?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId(`post-receipt-job-${receiptId}`)).toContainText("unassigned");
  await expect(page.getByTestId(`post-receipt-category-${receiptId}`)).toContainText("materials");
});

test("PC-08 an incomplete receipt (missing job or category) is rejected by posting, not silently accepted", async ({ page, request }) => {
  const receiptId = "rcpt-incomplete";
  // No job_id, no cost_category — deliberately incomplete. Posting must be
  // refused server-side (postApprovedReceiptToLedger's no_job_assigned /
  // no_cost_category reasons), even if somehow invoked directly.
  await seedApprovedReceipt(request, TENANT, receiptId, { jobId: null, costCategory: null });

  const res = await request.post(
    `/post-receipts/${receiptId}/post?tenant_id=${TENANT}&role=owner`,
    { form: {}, maxRedirects: 0 },
  );
  expect(res.status()).toBe(302); // redirected with an ?error=... — never a 200 "success"
  const location = res.headers()["location"] ?? "";
  expect(location).toContain("error=");

  await page.goto(`/post-receipts${location.includes("?") ? location.slice(location.indexOf("?")) : ""}`);
  await expect(page.getByTestId("notice")).toContainText("Error");

  const lines = await querySql(request,
    `SELECT id FROM job_cost_ledger WHERE company_id = ? AND source_receipt_id = ?`, [TENANT, receiptId]);
  expect(lines.length).toBe(0);
});

test("PC-09 duplicate-post prevention: posting an already-posted receipt again is a safe no-op, not a second ledger line", async ({ page, request }) => {
  const jobId = "job-dup";
  await seedJob(request, TENANT, jobId, { division: "landscape" });
  const receiptId = "rcpt-dup";
  await seedApprovedReceipt(request, TENANT, receiptId, { jobId, costCategory: "materials", amountCents: 500 });

  await page.goto(`/post-receipts?tenant_id=${TENANT}&role=owner`);
  await page.getByTestId(`post-submit-${receiptId}`).click();
  await expect(page.getByTestId(`post-receipt-posted-${receiptId}`)).toBeVisible();

  // Second attempt directly against the route (the UI itself no longer
  // renders a post button once posted, so this simulates a stale tab /
  // replayed form submission).
  const res = await request.post(
    `/post-receipts/${receiptId}/post?tenant_id=${TENANT}&role=owner`,
    { form: {}, maxRedirects: 0 },
  );
  expect(res.status()).toBe(302);
  expect(res.headers()["location"] ?? "").toContain("error=already_posted");

  const lines = await querySql(request,
    `SELECT id FROM job_cost_ledger WHERE company_id = ? AND source_receipt_id = ?`, [TENANT, receiptId]);
  expect(lines.length).toBe(1); // still exactly one line from the first post
});

test("PC-10 posted-state display: a posted receipt shows a posted badge and no assign/post controls", async ({ page, request }) => {
  const jobId = "job-posted-display";
  await seedJob(request, TENANT, jobId, { division: "landscape" });
  const receiptId = "rcpt-posted-display";
  await seedApprovedReceipt(request, TENANT, receiptId, { jobId, costCategory: "materials", posted: true });

  await page.goto(`/post-receipts?tenant_id=${TENANT}&role=owner`);
  await expect(page.getByTestId(`post-receipt-posted-${receiptId}`)).toBeVisible();
  await expect(page.getByTestId(`post-receipt-posted-${receiptId}`)).toContainText("posted");
  await expect(page.getByTestId(`assign-job-${receiptId}`)).toHaveCount(0);
  await expect(page.getByTestId(`post-submit-${receiptId}`)).toHaveCount(0);
});

test("PC-11 concurrent approval attempts produce exactly one ledger posting", async ({ request }) => {
  const jobId = "job-concurrent";
  await seedJob(request, TENANT, jobId, { division: "landscape" });
  const receiptId = "rcpt-concurrent";
  await seedApprovedReceipt(request, TENANT, receiptId, { jobId, costCategory: "materials", amountCents: 999 });

  // Fire several concurrent POSTs at the exact same posting route for the
  // same receipt — postApprovedReceiptToLedger's db.batch() atomicity (the
  // posted_at IS NULL write-once guard, checked in the same batch as the
  // ledger insert) must let exactly one of these actually create a ledger
  // line; every other must come back as a safe "already_posted" conflict.
  const attempts = await Promise.all(
    Array.from({ length: 5 }, () =>
      request.post(`/post-receipts/${receiptId}/post?tenant_id=${TENANT}&role=owner`, { form: {}, maxRedirects: 0 }),
    ),
  );

  const outcomes = attempts.map((res) => {
    const location = res.headers()["location"] ?? "";
    return location.includes("posted=1") ? "posted" : location.includes("error=already_posted") ? "conflict" : "other";
  });
  expect(outcomes.filter((o) => o === "posted").length).toBe(1);
  expect(outcomes.filter((o) => o === "conflict").length).toBe(4);
  expect(outcomes.filter((o) => o === "other").length).toBe(0);

  const lines = await querySql(request,
    `SELECT id FROM job_cost_ledger WHERE company_id = ? AND source_receipt_id = ?`, [TENANT, receiptId]);
  expect(lines.length).toBe(1); // exactly one ledger row, regardless of how many concurrent posts raced
});
