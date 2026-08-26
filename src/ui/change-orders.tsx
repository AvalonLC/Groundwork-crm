import { Hono, type Context } from "hono";
import {
  insertChangeOrder, getChangeOrder, listChangeOrdersForJob, listPendingChangeOrders,
  updateChangeOrder, submitChangeOrderForApproval, rejectChangeOrder, voidChangeOrder,
  getLatestJobBudgetVersion, listJobBudgetVersionsForJob,
  listJobBudgetVersionsNeedingReview, resolveJobBudgetVersionReview, getAssignableJob,
  getWorkOrderProgress,
  setWorkOrderManualCompletion, setWorkOrderServiceUnitsCompleted, listAssignableJobsForTenant,
  type AssignableJob,
} from "../db/repos";
import { approveChangeOrderWorkflow } from "../api/change-order-approval";
import type { ChangeOrder, JobBudgetVersion } from "../db/schema";
import { canSee, type Role } from "./roles";
import type { VocabularyMode } from "./vocabulary";
import { readPageArgs, Page, Card, Empty, Why, money, isPartialRequest, type FinanceAuthVars } from "./layout";

export type ChangeOrdersBindings = { DB: D1Database };

/**
 * Item 4 Stage 2 PR D. Tenant-scoped change-order workflow (draft -> pending
 * -> approved|rejected, plus draft|pending -> void), budget-version review
 * queue, and per-job completion-method configuration — see
 * docs/spec/ITEM4-JOBCOST.md §4.1/§4.2/§4.3 for the schema this implements
 * against, and src/db/repos.ts's existing change_orders/job_budget_versions
 * section (Item 4 Stage 2 PR B) for the repository functions this router
 * calls rather than reimplements. Follows receipt-posting.tsx's exact
 * pattern: server-side canSee() gate on every route, a REASON_LABEL map so
 * no failure is silently swallowed, a partial/full dual-response on every
 * mutation, and data-testid on every meaningful element.
 *
 * State machine note (mandate: "do not invent unsupported status
 * transitions... implement the smallest consistent state machine"): every
 * transition below is exactly what the existing repo functions' own WHERE
 * clauses already enforce — draft <-> draft (edit), draft -> pending
 * (submit), pending <-> pending (edit), pending -> approved (terminal,
 * atomic with a new budget version), pending -> rejected (terminal),
 * draft|pending -> void (terminal, distinct from rejected). This router
 * adds no new transition and no new status value; it is a UI/route layer
 * over transitions the schema and PR B repo layer already define.
 *
 * Authorization note: can_manage_change_orders (office+owner) gates
 * create/edit/submit/void — the same "day-to-day workflow" tier as
 * can_manage_receipts. can_approve_change_orders (owner-only) gates
 * approve/reject specifically, since approval is the one irreversible step
 * that atomically creates an equally-immutable job_budget_versions row —
 * see src/ui/roles.ts's doc comment on both fields for the full reasoning.
 * Both permissions are inferred (not confirmed by Tyler), same documented
 * status as can_manage_receipts itself (docs/spec/ROLES.md).
 */
export const changeOrdersRouter = new Hono<{ Bindings: ChangeOrdersBindings; Variables: FinanceAuthVars }>();

function deniedPage(role: string, partial: boolean, need: "manage" | "approve") {
  return (
    <Page title="Change Orders" active="finJobCost" role={role} partial={partial}>
      <Card>
        <div class="fin-empty" data-testid="denied">
          <div class="fin-empty-t">Not available for your role</div>
          <div class="fin-empty-s">
            {need === "approve"
              ? "Approving or rejecting a change order requires the owner role."
              : "Managing change orders requires an office or owner role."}
          </div>
        </div>
      </Card>
    </Page>
  );
}

/** Every failure reason a route in this file can produce, mapped to plain
 * language — same convention as receipt-posting.tsx's REASON_LABEL, so no
 * failure here is ever silently dropped either. */
const REASON_LABEL: Record<string, string> = {
  not_found: "Change order not found.",
  not_editable: "This change order can no longer be edited (already approved, rejected, or void).",
  not_draft: "Only a draft change order can be submitted for approval.",
  not_pending: "Only a pending change order can be approved or rejected.",
  no_job: "No job selected.",
  job_not_in_tenant: "The selected job does not belong to this company.",
  no_division: "The job's crew has no division set — set one in Setup & Config before approving.",
  no_overhead_rate: "No overhead rate on record for this job's division — set one in Budget & Rates before approving.",
  invalid_completion_inputs: "Service-units completion requires a positive planned-units figure before this change order can be approved.",
  invalid_revised_budget: "Approving this change order would produce a negative revised budget figure.",
  invalid_budget: "Approving this change order would produce a negative revised budget figure.",
  atomic_conflict: "This change order was already approved, rejected, or voided by someone else — refresh to see the current state.",
  reason_required: "A reason is required to reject a change order.",
  already_resolved: "This budget version was already resolved (or does not need review).",
  no_service_units_planned: "Set planned service units on the next approved revision before completing visits against it.",
};

// ── Change-order row + list rendering ───────────────────────────────────────

const STATUS_BADGE_CLASS: Record<ChangeOrder["status"], string> = {
  draft: "b-low", pending: "b-med", approved: "b-high", rejected: "b-low", void: "b-low",
};

function changeOrderRow(co: ChangeOrder, basePath: string, qs: string, canManage: boolean, canApprove: boolean) {
  const editable = co.status === "draft" || co.status === "pending";
  return (
    <tr data-testid={`co-row-${co.id}`}>
      <td data-testid={`co-status-${co.id}`}>
        <span class={`fin-badge ${STATUS_BADGE_CLASS[co.status]}`}>{co.status}</span>
      </td>
      <td>{co.description || "—"}</td>
      <td class="fin-num" data-testid={`co-revenue-adj-${co.id}`}>{money(co.revenue_adjustment_cents)}</td>
      <td class="fin-num" data-testid={`co-direct-cost-adj-${co.id}`}>{money(co.direct_cost_adjustment_cents)}</td>
      <td>{co.effective_date ?? "—"}</td>
      <td data-testid={`co-approval-meta-${co.id}`}>
        {co.status === "approved" ? `approved by ${co.approved_by} at ${co.approved_at}` :
         co.status === "rejected" ? `rejected by ${co.approved_by}: ${co.reason}` :
         co.status === "void" ? `voided: ${co.reason}` : "—"}
      </td>
      <td>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          {editable && canManage ? (
            <a href={`${basePath}/${co.id}/edit${qs}`} data-testid={`co-edit-link-${co.id}`}>Edit</a>
          ) : null}
          {co.status === "draft" && canManage ? (
            <form method="post" action={`${basePath}/${co.id}/submit${qs}`}>
              <button type="submit" data-testid={`co-submit-${co.id}`}>Submit for approval</button>
            </form>
          ) : null}
          {co.status === "pending" && canApprove ? (
            <>
              <form method="post" action={`${basePath}/${co.id}/approve${qs}`}>
                <button type="submit" data-testid={`co-approve-${co.id}`}>Approve</button>
              </form>
              <form method="post" action={`${basePath}/${co.id}/reject${qs}`} style="display:flex;gap:4px">
                <input type="text" name="reason" placeholder="Reason" data-testid={`co-reject-reason-${co.id}`} style="width:120px;font-size:12px" required />
                <button type="submit" data-testid={`co-reject-${co.id}`}>Reject</button>
              </form>
            </>
          ) : null}
          {(co.status === "draft" || co.status === "pending") && canManage ? (
            <form method="post" action={`${basePath}/${co.id}/void${qs}`} style="display:flex;gap:4px">
              <input type="text" name="reason" placeholder="Void reason" data-testid={`co-void-reason-${co.id}`} style="width:110px;font-size:12px" required />
              <button type="submit" data-testid={`co-void-${co.id}`}>Void</button>
            </form>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function budgetVersionRow(v: JobBudgetVersion, isActive: boolean, canManage: boolean, basePath: string, qs: string) {
  return (
    <tr data-testid={`budget-version-${v.id}`}>
      <td>
        {v.revision_seq}
        {isActive ? <span class="fin-badge b-high" data-testid={`budget-version-active-${v.id}`} style="margin-left:6px">current</span> : null}
      </td>
      <td>{v.source_type === "change_order" ? `change order ${v.source_id}` : `estimate ${v.source_id}`}</td>
      <td class="fin-num" data-testid={`budget-version-contract-${v.id}`}>{money(v.contract_value_cents)}</td>
      <td class="fin-num" data-testid={`budget-version-direct-cost-${v.id}`}>{money(v.direct_cost_budget_cents)}</td>
      <td class="fin-num" data-testid={`budget-version-overhead-${v.id}`}>{money(v.budgeted_overhead_cents)}</td>
      <td>{v.completion_method}</td>
      <td data-testid={`budget-version-needs-review-${v.id}`}>
        {v.needs_review === 1 ? (
          canManage ? (
            <form method="post" action={`${basePath}/budget-versions/${v.id}/resolve-review${qs}`}>
              <button type="submit" data-testid={`resolve-review-${v.id}`}>Confirm reviewed</button>
            </form>
          ) : (
            <span class="fin-badge b-med">needs review</span>
          )
        ) : (
          "—"
        )}
      </td>
    </tr>
  );
}

// ── Page composers ──────────────────────────────────────────────────────────

async function renderJobChangeOrdersPage(
  c: Context<{ Bindings: ChangeOrdersBindings; Variables: FinanceAuthVars }>,
  tenant_id: string, role: Role, vocab: VocabularyMode, jobId: string, notice: string | null, partial: boolean,
) {
  const canManage = canSee(role, "can_manage_change_orders");
  const canApprove = canSee(role, "can_approve_change_orders");
  const db = c.env.DB;

  const [job, changeOrders, history, progress] = await Promise.all([
    getAssignableJob(db, tenant_id, jobId),
    listChangeOrdersForJob(db, tenant_id, jobId),
    listJobBudgetVersionsForJob(db, tenant_id, jobId),
    getWorkOrderProgress(db, tenant_id, jobId),
  ]);
  const basePath = c.req.path.replace(/\/[^/]+$/, "") || "/finance/change-orders";
  const qs = `?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}&job_id=${encodeURIComponent(jobId)}`;
  const latest = history.length > 0 ? history[history.length - 1] : null;

  return (
    <Page title={job ? `Change Orders — ${job.wo_number}` : "Change Orders"} active="finJobCost"
      tenant={tenant_id || undefined} role={role} vocab={vocab} partial={partial}>
      {notice && (
        <div class="fin-note" data-testid="notice" style={notice.startsWith("Error") ? "border-left-color:var(--gw-rose)" : ""}>
          {notice}
        </div>
      )}

      {!job ? (
        <Card><Empty title="Job not found" hint="Add ?job_id=… for a job that belongs to this company." /></Card>
      ) : (
        <>
          <Card
            title="Change orders"
            sub={job ? `${job.wo_number} — ${job.title || job.client_name}` : undefined}
          >
            {canManage ? (
              <div style="margin-bottom:12px">
                <a href={`${basePath}/new${qs}`} data-testid="co-new-link">+ New change order</a>
              </div>
            ) : null}
            <div data-testid="co-list">
              {changeOrders.length === 0 ? (
                <Empty title="No change orders yet" hint="Create one to adjust this job's contract value or budget." />
              ) : (
                <table class="fin-table">
                  <thead>
                    <tr><th>Status</th><th>Description</th><th>Revenue adj.</th><th>Direct-cost adj.</th><th>Effective date</th><th>Approval / rejection</th><th>Actions</th></tr>
                  </thead>
                  <tbody>{changeOrders.map((co) => changeOrderRow(co, basePath, qs, canManage, canApprove))}</tbody>
                </table>
              )}
            </div>
            <Why
              what="Every change order affecting this job's contract value, direct-cost budget, and (when it changes labor hours) budgeted overhead."
              source="change_orders, tenant- and job-scoped."
              matters="A CO's own adjustment figures are frozen once approved — the only way to see what actually changed the budget is this history, never an edited row."
              moves="Creating, editing (while draft/pending), submitting, approving, or rejecting a change order below."
            />
          </Card>

          <Card title="Budget version history" sub="one immutable row per approved baseline or approved change order">
            <div data-testid="budget-version-list">
              {history.length === 0 ? (
                <Empty title="No approved budget yet" hint="This job has no baseline budget version on record." />
              ) : (
                <table class="fin-table">
                  <thead>
                    <tr><th>Rev.</th><th>Source</th><th>Contract value</th><th>Direct-cost budget</th><th>Budgeted overhead</th><th>Completion method</th><th>Review</th></tr>
                  </thead>
                  <tbody>
                    {history.map((v) => budgetVersionRow(v, latest != null && v.id === latest.id, canManage, basePath, qs))}
                  </tbody>
                </table>
              )}
            </div>
          </Card>

          {latest && canManage ? (
            <Card title="Completion-method configuration" sub="how this job's earned completion % is measured going forward">
              <form method="post" action={`${basePath}/progress${qs}`} data-testid="completion-config-form" style="display:flex;flex-direction:column;gap:10px;max-width:420px">
                <div>
                  <div class="fin-tile-l">Current method (latest approved revision)</div>
                  <div class="fin-tile-v" data-testid="current-completion-method">{latest.completion_method}</div>
                  <div class="fin-tile-m">
                    Changing the method requires a new change order / budget revision — it cannot be edited on an
                    approved revision in place. This form only sets the manual/service-units progress INPUTS on the
                    job itself.
                  </div>
                </div>
                {latest.completion_method === "manual" ? (
                  <label>
                    Manual completion % (0–100)
                    <input
                      type="number" name="manual_completion_pct" min="0" max="100" step="0.001"
                      data-testid="manual-completion-input"
                      value={progress?.completion_pct_millionths != null ? (progress.completion_pct_millionths / 10000).toString() : ""}
                    />
                  </label>
                ) : null}
                {latest.completion_method === "service_units" ? (
                  <>
                    <div class="fin-tile-m" data-testid="service-units-planned-display">
                      Planned units on the current budget version: {latest.service_units_planned ?? "not set — see note below"}
                    </div>
                    <label>
                      Service units completed
                      <input
                        type="number" name="service_units_completed" min="0" step="0.01"
                        data-testid="service-units-completed-input"
                        value={progress?.service_units_completed ?? ""}
                      />
                    </label>
                  </>
                ) : null}
                {latest.completion_method === "cost_to_cost" || latest.completion_method === "completed" ? (
                  <div class="fin-empty" data-testid="no-manual-input-needed">
                    <div class="fin-empty-t">No manual input for this method</div>
                    <div class="fin-empty-s">
                      {latest.completion_method === "cost_to_cost"
                        ? "Computed automatically from posted direct cost vs. the budget — nothing to set here."
                        : "Reads 100% only once the job is marked completed and financially closed."}
                    </div>
                  </div>
                ) : null}
                <button type="submit" data-testid="completion-config-save">Save</button>
              </form>
              <Why
                what="Which of the four approved completion methods this job uses, and the human-entered progress input that method needs (if any)."
                source="job_budget_versions.completion_method (frozen per revision) plus work_orders.completion_pct_millionths / service_units_completed."
                matters="An unset manual/service-units input is never guessed at — a job missing what its method needs must surface as needing review, not silently read as 0% or 100%."
                moves="completion_method changes only via a new approved revision; the progress input itself can be set here at any time."
              />
            </Card>
          ) : null}

          {!latest ? (
            <div class="fin-note" data-testid="no-budget-version-note" style="border-left-color:var(--gw-amber)">
              This job has no approved budget version yet, so its completion method and progress inputs cannot be
              configured until a baseline (or its first approved change order) exists.
            </div>
          ) : null}
        </>
      )}
    </Page>
  );
}

async function renderNewOrEditChangeOrderPage(
  c: Context<{ Bindings: ChangeOrdersBindings; Variables: FinanceAuthVars }>,
  tenant_id: string, role: Role, vocab: VocabularyMode, jobId: string, existing: ChangeOrder | null,
  notice: string | null, partial: boolean,
) {
  const job = await getAssignableJob(c.env.DB, tenant_id, jobId);
  const basePath = c.req.path.replace(/\/(new|[^/]+\/edit)$/, "");
  const qs = `?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}&job_id=${encodeURIComponent(jobId)}`;
  const action = existing ? `${basePath}/${existing.id}/edit${qs}` : `${basePath}/new${qs}`;

  return (
    <Page title={existing ? "Edit Change Order" : "New Change Order"} active="finJobCost"
      tenant={tenant_id || undefined} role={role} vocab={vocab} partial={partial}>
      {notice && (
        <div class="fin-note" data-testid="notice" style={notice.startsWith("Error") ? "border-left-color:var(--gw-rose)" : ""}>
          {notice}
        </div>
      )}
      <Card title={existing ? `Editing change order (${existing.status})` : "New change order"}
        sub={job ? `${job.wo_number} — ${job.title || job.client_name}` : jobId}>
        <form method="post" action={action} data-testid="co-form" style="display:flex;flex-direction:column;gap:10px;max-width:480px">
          <label>
            Description
            <input type="text" name="description" data-testid="co-description-input" value={existing?.description ?? ""} required />
          </label>
          <label>
            Reason
            <input type="text" name="reason" data-testid="co-reason-input" value={existing?.reason ?? ""} required />
          </label>
          <label>
            Contract-value adjustment (dollars, may be negative)
            <input type="number" step="0.01" name="revenue_adjustment" data-testid="co-revenue-adjustment-input"
              value={existing ? (existing.revenue_adjustment_cents / 100).toString() : "0"} required />
          </label>
          <label>
            Direct-cost budget adjustment (dollars, may be negative)
            <input type="number" step="0.01" name="direct_cost_adjustment" data-testid="co-direct-cost-adjustment-input"
              value={existing ? (existing.direct_cost_adjustment_cents / 100).toString() : "0"} required />
          </label>
          <label>
            Labor-hours adjustment (hours, may be negative — drives the overhead-budget adjustment)
            <input type="number" step="0.01" name="labor_hours_adjustment" data-testid="co-labor-hours-adjustment-input"
              value={existing ? (existing.labor_hours_adjustment_hundredths / 100).toString() : "0"} required />
          </label>
          <label>
            Effective date
            <input type="date" name="effective_date" data-testid="co-effective-date-input" value={existing?.effective_date ?? ""} />
          </label>
          <button type="submit" data-testid="co-form-save">{existing ? "Save changes" : "Create draft"}</button>
        </form>
      </Card>
    </Page>
  );
}

// ── Budget-version review queue (across all jobs, tenant-wide) ─────────────

async function renderReviewQueuePage(
  c: Context<{ Bindings: ChangeOrdersBindings; Variables: FinanceAuthVars }>,
  tenant_id: string, role: Role, vocab: VocabularyMode, notice: string | null, partial: boolean,
) {
  const [needingReview, jobs] = await Promise.all([
    listJobBudgetVersionsNeedingReview(c.env.DB, tenant_id),
    listAssignableJobsForTenant(c.env.DB, tenant_id),
  ]);
  const canManage = canSee(role, "can_manage_change_orders");
  const basePath = c.req.path;
  const qs = `?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}`;
  const jobLabel = (jid: string) => {
    const j = jobs.find((x: AssignableJob) => x.id === jid);
    return j ? `${j.wo_number} — ${j.title || j.client_name}` : jid;
  };

  return (
    <Page title="Budget Version Review" active="finJobCost" tenant={tenant_id || undefined} role={role} vocab={vocab} partial={partial}>
      {notice && (
        <div class="fin-note" data-testid="notice" style={notice.startsWith("Error") ? "border-left-color:var(--gw-rose)" : ""}>
          {notice}
        </div>
      )}
      <Card title="Needs review" sub="approved budget versions where a category split could not be attributed cleanly">
        <div data-testid="needs-review-list">
          {needingReview.length === 0 ? (
            <Empty title="Nothing needs review" hint="Every approved budget version has a clean attribution." />
          ) : (
            <table class="fin-table">
              <thead>
                <tr><th>Job</th><th>Rev.</th><th>Contract value</th><th>Direct-cost budget</th><th>Budgeted overhead</th><th>Confirm</th></tr>
              </thead>
              <tbody>
                {needingReview.map((v) => (
                  <tr data-testid={`review-row-${v.id}`}>
                    <td><a href={`/finance/change-orders?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}&job_id=${encodeURIComponent(v.job_id)}`}>{jobLabel(v.job_id)}</a></td>
                    <td>{v.revision_seq}</td>
                    <td class="fin-num">{money(v.contract_value_cents)}</td>
                    <td class="fin-num">{money(v.direct_cost_budget_cents)}</td>
                    <td class="fin-num">{money(v.budgeted_overhead_cents)}</td>
                    <td>
                      {canManage ? (
                        <form method="post" action={`${basePath}/budget-versions/${v.id}/resolve-review${qs}`}>
                          <button type="submit" data-testid={`resolve-review-${v.id}`}>Confirm reviewed</button>
                        </form>
                      ) : (
                        <span class="fin-badge b-med">needs review</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <Why
          what="Approved budget versions flagged by the historical-data backfill because their direct-cost category split could not be attributed cleanly."
          source="job_budget_versions.needs_review, set only by the backfill script — never by ordinary approval flow."
          matters="A flagged row's approved figures are never rewritten to resolve the flag — resolving only confirms a human looked, it never touches the underlying values."
          moves="Confirming reviewed here; nothing else can clear this flag."
        />
      </Card>
    </Page>
  );
}

// ── Job change-orders list/detail routes ────────────────────────────────────

changeOrdersRouter.get("/", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  const partial = isPartialRequest(c);
  if (!canSee(role, "can_manage_change_orders") && !canSee(role, "can_approve_change_orders")) {
    return c.html(deniedPage(role, partial, "manage"), 403);
  }
  const jobId = c.req.query("job_id") ?? "";
  const errorReason = c.req.query("error");
  const notice =
    c.req.query("saved") === "1" ? "Saved."
    : c.req.query("submitted") === "1" ? "Submitted for approval."
    : c.req.query("approved") === "1" ? "Approved — a new budget version was created."
    : c.req.query("rejected") === "1" ? "Rejected."
    : c.req.query("voided") === "1" ? "Voided."
    : c.req.query("resolved") === "1" ? "Marked reviewed."
    : errorReason && errorReason in REASON_LABEL ? `Error: ${REASON_LABEL[errorReason]}`
    : errorReason ? "Error: could not complete that action."
    : null;

  if (!jobId) {
    // No job selected yet — show the tenant's assignable jobs so the user
    // can pick one, same "pick a job" empty state as job-costing.tsx.
    const jobs = await listAssignableJobsForTenant(c.env.DB, tenant_id);
    const qs = `?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}`;
    return c.html(
      <Page title="Change Orders" active="finJobCost" tenant={tenant_id || undefined} role={role} vocab={vocab} partial={partial}>
        <Card title="Pick a job">
          <div data-testid="job-picker-list">
            {jobs.length === 0 ? (
              <Empty title="No jobs yet" />
            ) : (
              <ul data-testid="job-picker">
                {jobs.map((j) => (
                  <li><a href={`/finance/change-orders${qs}&job_id=${encodeURIComponent(j.id)}`} data-testid={`job-picker-link-${j.id}`}>{j.wo_number} — {j.title || j.client_name}</a></li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </Page>,
    );
  }

  return c.html(await renderJobChangeOrdersPage(c, tenant_id, role, vocab, jobId, notice, partial));
});

changeOrdersRouter.get("/new", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  const partial = isPartialRequest(c);
  if (!canSee(role, "can_manage_change_orders")) return c.html(deniedPage(role, partial, "manage"), 403);
  const jobId = c.req.query("job_id") ?? "";
  return c.html(await renderNewOrEditChangeOrderPage(c, tenant_id, role, vocab, jobId, null, null, partial));
});

changeOrdersRouter.post("/new", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  const partial = isPartialRequest(c);
  if (!canSee(role, "can_manage_change_orders")) return c.text("not available for your role", 403);
  const jobId = c.req.query("job_id") ?? "";
  const repId = c.var.repId ?? "office";

  const job = await getAssignableJob(c.env.DB, tenant_id, jobId);
  if (!job) {
    if (partial) return c.html(await renderNewOrEditChangeOrderPage(c, tenant_id, role, vocab, jobId, null, "Error: no_job", true));
    return c.redirect(`/finance/change-orders?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}&job_id=${encodeURIComponent(jobId)}&error=no_job`);
  }

  const form = await c.req.parseBody();
  const id = `co-${crypto.randomUUID()}`;
  await insertChangeOrder(c.env.DB, {
    id, company_id: tenant_id, job_id: jobId, estimate_id: null, customer_id: null,
    revenue_adjustment_cents: Math.round(parseFloat(String(form.revenue_adjustment ?? "0")) * 100) as ChangeOrder["revenue_adjustment_cents"],
    direct_cost_adjustment_cents: Math.round(parseFloat(String(form.direct_cost_adjustment ?? "0")) * 100) as ChangeOrder["direct_cost_adjustment_cents"],
    labor_hours_adjustment_hundredths: Math.round(parseFloat(String(form.labor_hours_adjustment ?? "0")) * 100) as ChangeOrder["labor_hours_adjustment_hundredths"],
    effective_date: String(form.effective_date ?? "").trim() || null,
    description: String(form.description ?? "").trim(),
    reason: String(form.reason ?? "").trim(),
    created_by: repId,
  });

  const qs = `?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}&job_id=${encodeURIComponent(jobId)}`;
  if (partial) return c.html(await renderJobChangeOrdersPage(c, tenant_id, role, vocab, jobId, "Saved.", true));
  return c.redirect(`/finance/change-orders${qs}&saved=1`);
});

changeOrdersRouter.get("/:id/edit", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  const partial = isPartialRequest(c);
  if (!canSee(role, "can_manage_change_orders")) return c.html(deniedPage(role, partial, "manage"), 403);
  const id = c.req.param("id")!;
  const co = await getChangeOrder(c.env.DB, tenant_id, id);
  if (!co) {
    return c.html(deniedPage(role, partial, "manage"), 404);
  }
  return c.html(await renderNewOrEditChangeOrderPage(c, tenant_id, role, vocab, co.job_id, co, null, partial));
});

changeOrdersRouter.post("/:id/edit", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  const partial = isPartialRequest(c);
  if (!canSee(role, "can_manage_change_orders")) return c.text("not available for your role", 403);
  const id = c.req.param("id")!;
  const jobId = c.req.query("job_id") ?? "";

  const form = await c.req.parseBody();
  const ok = await updateChangeOrder(c.env.DB, tenant_id, id, {
    revenue_adjustment_cents: Math.round(parseFloat(String(form.revenue_adjustment ?? "0")) * 100) as ChangeOrder["revenue_adjustment_cents"],
    direct_cost_adjustment_cents: Math.round(parseFloat(String(form.direct_cost_adjustment ?? "0")) * 100) as ChangeOrder["direct_cost_adjustment_cents"],
    labor_hours_adjustment_hundredths: Math.round(parseFloat(String(form.labor_hours_adjustment ?? "0")) * 100) as ChangeOrder["labor_hours_adjustment_hundredths"],
    effective_date: String(form.effective_date ?? "").trim() || null,
    description: String(form.description ?? "").trim(),
    reason: String(form.reason ?? "").trim(),
  });

  const qs = `?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}&job_id=${encodeURIComponent(jobId)}`;
  if (!ok) {
    if (partial) return c.html(await renderJobChangeOrdersPage(c, tenant_id, role, vocab, jobId, "Error: not_editable", true));
    return c.redirect(`/finance/change-orders${qs}&error=not_editable`);
  }
  if (partial) return c.html(await renderJobChangeOrdersPage(c, tenant_id, role, vocab, jobId, "Saved.", true));
  return c.redirect(`/finance/change-orders${qs}&saved=1`);
});

changeOrdersRouter.post("/:id/submit", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  const partial = isPartialRequest(c);
  if (!canSee(role, "can_manage_change_orders")) return c.text("not available for your role", 403);
  const id = c.req.param("id")!;
  const jobId = c.req.query("job_id") ?? "";

  const ok = await submitChangeOrderForApproval(c.env.DB, tenant_id, id);
  const qs = `?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}&job_id=${encodeURIComponent(jobId)}`;
  if (!ok) {
    if (partial) return c.html(await renderJobChangeOrdersPage(c, tenant_id, role, vocab, jobId, "Error: not_draft", true));
    return c.redirect(`/finance/change-orders${qs}&error=not_draft`);
  }
  if (partial) return c.html(await renderJobChangeOrdersPage(c, tenant_id, role, vocab, jobId, "Submitted for approval.", true));
  return c.redirect(`/finance/change-orders${qs}&submitted=1`);
});

changeOrdersRouter.post("/:id/void", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  const partial = isPartialRequest(c);
  if (!canSee(role, "can_manage_change_orders")) return c.text("not available for your role", 403);
  const id = c.req.param("id")!;
  const jobId = c.req.query("job_id") ?? "";
  const form = await c.req.parseBody();
  const reason = String(form.reason ?? "").trim();

  const ok = reason ? await voidChangeOrder(c.env.DB, tenant_id, id, reason) : false;
  const qs = `?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}&job_id=${encodeURIComponent(jobId)}`;
  if (!ok) {
    const err = reason ? "not_editable" : "reason_required";
    if (partial) return c.html(await renderJobChangeOrdersPage(c, tenant_id, role, vocab, jobId, `Error: ${err}`, true));
    return c.redirect(`/finance/change-orders${qs}&error=${err}`);
  }
  if (partial) return c.html(await renderJobChangeOrdersPage(c, tenant_id, role, vocab, jobId, "Voided.", true));
  return c.redirect(`/finance/change-orders${qs}&voided=1`);
});

changeOrdersRouter.post("/:id/reject", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  const partial = isPartialRequest(c);
  if (!canSee(role, "can_approve_change_orders")) return c.text("not available for your role", 403);
  const id = c.req.param("id")!;
  const jobId = c.req.query("job_id") ?? "";
  const form = await c.req.parseBody();
  const reason = String(form.reason ?? "").trim();
  const repId = c.var.repId ?? "owner";

  const qs = `?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}&job_id=${encodeURIComponent(jobId)}`;
  if (!reason) {
    if (partial) return c.html(await renderJobChangeOrdersPage(c, tenant_id, role, vocab, jobId, "Error: reason_required", true));
    return c.redirect(`/finance/change-orders${qs}&error=reason_required`);
  }

  const ok = await rejectChangeOrder(c.env.DB, tenant_id, id, repId, reason);
  if (!ok) {
    if (partial) return c.html(await renderJobChangeOrdersPage(c, tenant_id, role, vocab, jobId, "Error: not_pending", true));
    return c.redirect(`/finance/change-orders${qs}&error=not_pending`);
  }
  if (partial) return c.html(await renderJobChangeOrdersPage(c, tenant_id, role, vocab, jobId, "Rejected.", true));
  return c.redirect(`/finance/change-orders${qs}&rejected=1`);
});

/**
 * Approval: a thin caller of approveChangeOrderWorkflow (src/api/
 * change-order-approval.ts), which resolves division/overhead rate,
 * computes the cumulative revised budget via
 * computeRevisedBudgetFromChangeOrders (ITEM4-JOBCOST.md §5 formula 4),
 * validates it (validateRevisedBudget — mandate: reject negative/
 * impossible totals before they're ever written), and then calls the
 * already-atomic approveChangeOrderAndCreateBudgetVersion exactly once.
 * This route does NOT reimplement any of that — same convention as
 * receipt-posting.tsx's /:id/post route calling postApprovedReceiptToLedger.
 */
changeOrdersRouter.post("/:id/approve", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  const partial = isPartialRequest(c);
  if (!canSee(role, "can_approve_change_orders")) return c.text("not available for your role", 403);
  const id = c.req.param("id")!;
  const jobId = c.req.query("job_id") ?? "";
  const repId = c.var.repId ?? "owner";
  const qs = `?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}&job_id=${encodeURIComponent(jobId)}`;

  // The CO's own effective_date, not "today", is the as-of date used to
  // resolve the overhead-rate snapshot — falls back to today only when no
  // effective_date was set (see approveChangeOrderWorkflow's own doc
  // comment on asOfDate for why this must be resolved before, not inside,
  // the atomic write).
  const co = await getChangeOrder(c.env.DB, tenant_id, id);
  const asOf = co?.effective_date ?? new Date().toISOString().slice(0, 10);

  const result = await approveChangeOrderWorkflow(c.env.DB, tenant_id, id, repId, null, asOf);

  if (!result.success) {
    if (partial) return c.html(await renderJobChangeOrdersPage(c, tenant_id, role, vocab, jobId, `Error: ${REASON_LABEL[result.reason] ?? result.reason}`, true));
    return c.redirect(`/finance/change-orders${qs}&error=${result.reason}`);
  }
  if (partial) return c.html(await renderJobChangeOrdersPage(c, tenant_id, role, vocab, jobId, "Approved — a new budget version was created.", true));
  return c.redirect(`/finance/change-orders${qs}&approved=1`);
});

// ── Progress-input configuration (manual %, service units completed) ───────

changeOrdersRouter.post("/progress", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  const partial = isPartialRequest(c);
  if (!canSee(role, "can_manage_change_orders")) return c.text("not available for your role", 403);
  const jobId = c.req.query("job_id") ?? "";
  const qs = `?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}&job_id=${encodeURIComponent(jobId)}`;

  const latest = await getLatestJobBudgetVersion(c.env.DB, tenant_id, jobId);
  const form = await c.req.parseBody();

  if (latest?.completion_method === "manual") {
    const raw = String(form.manual_completion_pct ?? "").trim();
    const pct = raw === "" ? null : Math.round(parseFloat(raw) * 10000);
    // Prevent impossible values: only accept a finite [0,100] % input; an
    // out-of-range or non-numeric value is refused (kept null / unchanged)
    // rather than silently clamped, so a typo never quietly becomes 0% or
    // 100% — the mandate's "prevent impossible values" for this method.
    if (pct === null || (Number.isFinite(pct) && pct >= 0 && pct <= 1_000_000)) {
      await setWorkOrderManualCompletion(c.env.DB, tenant_id, jobId, pct);
    } else {
      if (partial) return c.html(await renderJobChangeOrdersPage(c, tenant_id, role, vocab, jobId, "Error: invalid_budget", true));
      return c.redirect(`/finance/change-orders${qs}&error=invalid_budget`);
    }
  } else if (latest?.completion_method === "service_units") {
    if (latest.service_units_planned === null) {
      if (partial) return c.html(await renderJobChangeOrdersPage(c, tenant_id, role, vocab, jobId, "Error: no_service_units_planned", true));
      return c.redirect(`/finance/change-orders${qs}&error=no_service_units_planned`);
    }
    const raw = String(form.service_units_completed ?? "").trim();
    const units = raw === "" ? null : parseFloat(raw);
    if (units === null || (Number.isFinite(units) && units >= 0)) {
      await setWorkOrderServiceUnitsCompleted(c.env.DB, tenant_id, jobId, units);
    } else {
      if (partial) return c.html(await renderJobChangeOrdersPage(c, tenant_id, role, vocab, jobId, "Error: invalid_budget", true));
      return c.redirect(`/finance/change-orders${qs}&error=invalid_budget`);
    }
  }
  // cost_to_cost / completed: no manual input accepted, nothing to write —
  // the form doesn't even render inputs for those methods (see the page
  // composer), so a POST here for those methods is a no-op save.

  if (partial) return c.html(await renderJobChangeOrdersPage(c, tenant_id, role, vocab, jobId, "Saved.", true));
  return c.redirect(`/finance/change-orders${qs}&saved=1`);
});

// ── Budget-version review queue (tenant-wide) ───────────────────────────────

changeOrdersRouter.get("/budget-versions/review", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  const partial = isPartialRequest(c);
  if (!canSee(role, "can_manage_change_orders") && !canSee(role, "can_approve_change_orders")) {
    return c.html(deniedPage(role, partial, "manage"), 403);
  }
  const errorReason = c.req.query("error");
  const notice =
    c.req.query("resolved") === "1" ? "Marked reviewed."
    : errorReason && errorReason in REASON_LABEL ? `Error: ${REASON_LABEL[errorReason]}`
    : errorReason ? "Error: could not resolve."
    : null;
  return c.html(await renderReviewQueuePage(c, tenant_id, role, vocab, notice, partial));
});

changeOrdersRouter.post("/budget-versions/:id/resolve-review", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  const partial = isPartialRequest(c);
  if (!canSee(role, "can_manage_change_orders")) return c.text("not available for your role", 403);
  const id = c.req.param("id")!;
  const jobId = c.req.query("job_id") ?? "";

  const ok = await resolveJobBudgetVersionReview(c.env.DB, tenant_id, id);

  // Two possible return pages depending on how this route was reached
  // (from a specific job's page, or from the tenant-wide review queue).
  if (jobId) {
    const qs = `?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}&job_id=${encodeURIComponent(jobId)}`;
    if (!ok) {
      if (partial) return c.html(await renderJobChangeOrdersPage(c, tenant_id, role, vocab, jobId, "Error: already_resolved", true));
      return c.redirect(`/finance/change-orders${qs}&error=already_resolved`);
    }
    if (partial) return c.html(await renderJobChangeOrdersPage(c, tenant_id, role, vocab, jobId, "Marked reviewed.", true));
    return c.redirect(`/finance/change-orders${qs}&resolved=1`);
  }

  const qs = `?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}`;
  if (!ok) {
    if (partial) return c.html(await renderReviewQueuePage(c, tenant_id, role, vocab, "Error: already_resolved", true));
    return c.redirect(`/finance/change-orders/budget-versions/review${qs}&error=already_resolved`);
  }
  if (partial) return c.html(await renderReviewQueuePage(c, tenant_id, role, vocab, "Marked reviewed.", true));
  return c.redirect(`/finance/change-orders/budget-versions/review${qs}&resolved=1`);
});
