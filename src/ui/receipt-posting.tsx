import { Hono, type Context } from "hono";
import {
  listReceiptsNeedingManualAssignment, listReceiptsReadyToPost, getReceiptForPosting,
  setReceiptCostCategory, setReceiptJobId, listAssignableJobsForTenant, getJobDivision,
  listRecentlyPostedReceipts, type AssignableJob,
} from "../db/repos";
import { postApprovedReceiptToLedger, type ReceiptPostingResult } from "../api/receipt-posting";
import { DIRECT_COST_CATEGORIES, type DirectCostCategory, type Receipt } from "../db/schema";
import { canSee, type Role } from "./roles";
import type { VocabularyMode } from "./vocabulary";
import { readPageArgs, Page, Card, Empty, Why, money, isPartialRequest, type FinanceAuthVars } from "./layout";

export type ReceiptPostingBindings = { DB: D1Database };

/**
 * PR C's authorized review/posting UI — the missing "explicit posting
 * step" documents.tsx's own comments flag: approving a receipt there
 * changes receipt.status but has never posted anything to job_cost_ledger.
 * This router is that separate, explicit action, calling the already-
 * tested repository/API functions (listReceiptsNeedingManualAssignment,
 * listReceiptsReadyToPost, postApprovedReceiptToLedger) rather than
 * re-implementing any of their logic. Same server-side authorization gate
 * as documents.tsx/document-upload.tsx (canSee(role, "can_manage_receipts"))
 * — never relies on a hidden UI control to keep an unauthorized role out.
 */
export const receiptPostingRouter = new Hono<{ Bindings: ReceiptPostingBindings; Variables: FinanceAuthVars }>();

function deniedPage(role: string, partial: boolean) {
  return (
    <Page title="Post Receipts" active="finDocuments" role={role} partial={partial}>
      <Card>
        <div class="fin-empty" data-testid="denied">
          <div class="fin-empty-t">Not available for your role</div>
          <div class="fin-empty-s">Posting receipts to the job cost ledger requires an office or owner role.</div>
        </div>
      </Card>
    </Page>
  );
}

const REASON_LABEL: Record<Exclude<ReceiptPostingResult, { success: true }>["reason"], string> = {
  not_found: "Receipt not found.",
  not_approved: "Receipt must be approved (on the Documents page) before it can be posted.",
  already_posted: "Already posted — no duplicate line was created.",
  no_job_assigned: "No job/work order assigned yet.",
  job_not_in_tenant: "The assigned job does not belong to this company.",
  no_cost_category: "No cost category assigned yet.",
  no_amount: "Receipt has no amount.",
  no_division: "The assigned job's crew has no division set — set one in Setup & Config before posting.",
};

function receiptRow(
  r: Receipt, jobs: AssignableJob[], basePath: string, qs: string, mode: "assign" | "ready" | "posted",
) {
  const job = jobs.find((j) => j.id === r.job_id);
  return (
    <tr data-testid={`post-receipt-${r.id}`}>
      <td>{r.vendor ?? "—"}</td>
      <td class="fin-num">{r.amount_cents !== null ? money(r.amount_cents) : "—"}</td>
      <td>{r.receipt_date ?? "—"}</td>
      <td data-testid={`post-receipt-job-${r.id}`}>{job ? `${job.wo_number} — ${job.title || job.client_name}` : "— unassigned —"}</td>
      <td data-testid={`post-receipt-category-${r.id}`}>{r.cost_category ?? "— unassigned —"}</td>
      <td>
        {r.posted_at ? (
          <span class="fin-badge b-high" data-testid={`post-receipt-posted-${r.id}`}>posted {r.posted_at}</span>
        ) : (
          <form method="post" action={`${basePath}/${r.id}/assign${qs}`} style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
            <select name="job_id" data-testid={`assign-job-${r.id}`} style="padding:6px 8px;border:1px solid var(--gw-line-strong);border-radius:var(--gw-r-sm);font-size:12px">
              <option value="">— unassigned —</option>
              {jobs.map((j) => (
                <option value={j.id} selected={r.job_id === j.id}>{j.wo_number} — {j.title || j.client_name}</option>
              ))}
            </select>
            <select name="cost_category" data-testid={`assign-category-${r.id}`} style="padding:6px 8px;border:1px solid var(--gw-line-strong);border-radius:var(--gw-r-sm);font-size:12px">
              <option value="">— not sure —</option>
              {DIRECT_COST_CATEGORIES.map((cat) => (
                <option value={cat} selected={r.cost_category === cat}>{cat}</option>
              ))}
            </select>
            <label style="font-size:12px;display:flex;align-items:center;gap:4px">
              <input type="checkbox" name="progress_eligible" data-testid={`assign-progress-eligible-${r.id}`} checked={r.progress_eligible === 1} />
              progress-eligible
            </label>
            <button type="submit" data-testid={`assign-save-${r.id}`} style="background:none;border:1px solid var(--gw-line-strong);border-radius:var(--gw-r-sm);padding:5px 10px;font-size:12px;font-weight:700;cursor:pointer">
              Save
            </button>
            {mode === "ready" && (
              <button
                type="submit" formaction={`${basePath}/${r.id}/post${qs}`}
                data-testid={`post-submit-${r.id}`}
                style="background:var(--gw-pine);color:#fff;border:0;border-radius:var(--gw-r-sm);padding:5px 10px;font-size:12px;font-weight:700;cursor:pointer"
              >
                Approve &amp; post
              </button>
            )}
          </form>
        )}
      </td>
    </tr>
  );
}

async function renderReviewPage(
  c: Context<{ Bindings: ReceiptPostingBindings; Variables: FinanceAuthVars }>,
  tenant_id: string, role: Role, vocab: VocabularyMode, notice: string | null, partial: boolean,
) {
  const [readyToPost, needsAssignment, recentlyPosted, jobs] = await Promise.all([
    listReceiptsReadyToPost(c.env.DB, tenant_id),
    listReceiptsNeedingManualAssignment(c.env.DB, tenant_id),
    listRecentlyPostedReceipts(c.env.DB, tenant_id),
    listAssignableJobsForTenant(c.env.DB, tenant_id),
  ]);
  const basePath = c.req.path;
  const qs = `?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}`;

  return (
    <Page title="Post Receipts" active="finDocuments" tenant={tenant_id || undefined} role={role} vocab={vocab} partial={partial}>
      {notice && (
        <div class="fin-note" data-testid="notice" style={notice.startsWith("Error") ? "border-left-color:var(--gw-rose)" : ""}>
          {notice}
        </div>
      )}

      <div class="fin-note">
        Only approved receipts show up here — Approve one on the Documents page first. Posting
        is a separate, explicit action from Approve: it writes a real job_cost_ledger line and
        cannot be undone by editing the receipt afterward — a correction after posting uses a
        reversal/adjustment, the same as any other posted ledger line.
      </div>

      <Card title="Needs assignment" sub="approved, but missing a job or cost category — assign both to move it to Ready to post">
        <div data-testid="needs-assignment-list">
          {needsAssignment.length === 0 ? (
            <Empty title="Nothing waiting" hint="Every approved receipt has a job and category assigned." />
          ) : (
            <table class="fin-table">
              <thead><tr><th>Vendor</th><th>Amount</th><th>Date</th><th>Job</th><th>Category</th><th>Assign</th></tr></thead>
              <tbody>{needsAssignment.map((r) => receiptRow(r, jobs, basePath, qs, "assign"))}</tbody>
            </table>
          )}
        </div>
      </Card>

      <Card title="Ready to post" sub="approved, job and category assigned — review and post">
        <div data-testid="ready-to-post-list">
          {readyToPost.length === 0 ? (
            <Empty title="Nothing ready" hint="Assign a job and category to a receipt above to see it here." />
          ) : (
            <table class="fin-table">
              <thead><tr><th>Vendor</th><th>Amount</th><th>Date</th><th>Job</th><th>Category</th><th>Post</th></tr></thead>
              <tbody>{readyToPost.map((r) => receiptRow(r, jobs, basePath, qs, "ready"))}</tbody>
            </table>
          )}
        </div>
        <Why
          what="The write-once posting step that turns an approved receipt into a real job_cost_ledger direct-cost line."
          source="postApprovedReceiptToLedger (src/api/receipt-posting.ts) — the same tested function whether posted here or from any other future caller."
          matters="Nothing about an uploaded or approved receipt posts automatically; a human must explicitly approve posting here, with all required fields set, exactly once."
          moves="Clicking Approve & post. Never OCR, upload, or the Documents page's Approve action alone."
        />
      </Card>

      <Card title="Recently posted" sub="already written to the job cost ledger — a correction from here on uses a reversal/adjustment, never a re-edit">
        <div data-testid="recently-posted-list">
          {recentlyPosted.length === 0 ? (
            <Empty title="Nothing posted yet" hint="Posted receipts will appear here, most recent first." />
          ) : (
            <table class="fin-table">
              <thead><tr><th>Vendor</th><th>Amount</th><th>Date</th><th>Job</th><th>Category</th><th>Status</th></tr></thead>
              <tbody>{recentlyPosted.map((r) => receiptRow(r, jobs, basePath, qs, "posted"))}</tbody>
            </table>
          )}
        </div>
      </Card>
    </Page>
  );
}

receiptPostingRouter.get("/", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  const partial = isPartialRequest(c);
  if (!canSee(role, "can_manage_receipts")) return c.html(deniedPage(role, partial), 403);
  // Non-partial /:id/post failures redirect here with ?error=<reason> (see
  // below) — this must be surfaced, not silently dropped alongside the
  // posted/saved cases, or a full-page post failure looks like nothing
  // happened at all.
  const errorReason = c.req.query("error");
  const notice =
    c.req.query("posted") === "1" ? "Posted."
    : c.req.query("saved") === "1" ? "Saved."
    : errorReason && errorReason in REASON_LABEL ? `Error: ${REASON_LABEL[errorReason as keyof typeof REASON_LABEL]}`
    : errorReason ? "Error: could not post this receipt."
    : null;
  return c.html(await renderReviewPage(c, tenant_id, role, vocab, notice, partial));
});

/** Assign/correct job + cost category + progress eligibility — never
 * touches job_cost_ledger, purely the receipt's own pre-posting fields.
 * Refuses (via setReceiptJobId/setReceiptCostCategory's own posted_at IS
 * NULL guards) once the receipt is posted — this route does not special-
 * case that; the underlying repo calls already make it a no-op.
 *
 * Deliberately does NOT also gate on receipt.status === 'approved': setting
 * a job/category is inert data prep (same as document-upload.tsx setting
 * cost_category at upload time, before any approve/reject decision exists
 * at all) and moves no money. The one gate that actually matters —
 * status === 'approved' before *posting* — is enforced independently by
 * postApprovedReceiptToLedger's own not_approved check, so a
 * pending/rejected receipt can never reach the ledger no matter what this
 * route allows on job/category fields. */
receiptPostingRouter.post("/:id/assign", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  const partial = isPartialRequest(c);
  if (!canSee(role, "can_manage_receipts")) return c.text("not available for your role", 403);
  const id = c.req.param("id")!;

  const form = await c.req.parseBody();
  const jobIdRaw = String(form.job_id ?? "").trim();
  const jobs = await listAssignableJobsForTenant(c.env.DB, tenant_id);
  const jobId = jobIdRaw && jobs.some((j) => j.id === jobIdRaw) ? jobIdRaw : null;
  await setReceiptJobId(c.env.DB, tenant_id, id, jobId);

  const costCategoryRaw = String(form.cost_category ?? "").trim();
  if ((DIRECT_COST_CATEGORIES as string[]).includes(costCategoryRaw)) {
    const progressEligible: 0 | 1 = form.progress_eligible ? 1 : 0;
    await setReceiptCostCategory(c.env.DB, tenant_id, id, costCategoryRaw as DirectCostCategory, progressEligible);
  }

  const basePath = c.req.path.replace(/\/[^/]+\/assign$/, "");
  if (partial) return c.html(await renderReviewPage(c, tenant_id, role, vocab, "Saved.", true));
  return c.redirect(`${basePath}?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}&saved=1`);
});

/**
 * The explicit, human-approved, write-once posting action (PR C's core
 * requirement) — a thin caller of postApprovedReceiptToLedger, resolving
 * `division` the same way postWorkOrderTimeEntry does (work_orders.crew_id
 * -> crews.division) so a receipt posts under the same division a job's
 * labor already posts under. Authorization is re-checked here (server-
 * side, not just hidden by the UI); every failure reason from
 * postApprovedReceiptToLedger is surfaced as a plain-language notice, not
 * swallowed.
 */
receiptPostingRouter.post("/:id/post", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  const partial = isPartialRequest(c);
  if (!canSee(role, "can_manage_receipts")) return c.text("not available for your role", 403);
  const id = c.req.param("id")!;
  const basePath = c.req.path.replace(/\/[^/]+\/post$/, "");

  const receipt = await getReceiptForPosting(c.env.DB, tenant_id, id);
  const division = receipt?.job_id ? await getJobDivision(c.env.DB, tenant_id, receipt.job_id) : null;
  const postedBy = c.var.repId ?? "office-post";

  const result = await postApprovedReceiptToLedger(c.env.DB, tenant_id, id, division ?? "", postedBy);

  if (!result.success) {
    const notice = `Error: ${REASON_LABEL[result.reason]}`;
    if (partial) return c.html(await renderReviewPage(c, tenant_id, role, vocab, notice, true));
    return c.redirect(`${basePath}?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}&error=${encodeURIComponent(result.reason)}`);
  }

  if (partial) return c.html(await renderReviewPage(c, tenant_id, role, vocab, "Posted.", true));
  return c.redirect(`${basePath}?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}&posted=1`);
});
