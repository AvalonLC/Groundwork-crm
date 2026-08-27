import { Hono } from "hono";
import { getJobCostLedgerForJob, getWorkItem, getJobProgress } from "../db/repos";
import type { EarnedCompletionUnavailableReason } from "../engines/job-progress";
import { canSee } from "./roles";
import { readPageArgs, Page, Term, Card, Empty, Why, money, isPartialRequest, type FinanceAuthVars } from "./layout";

export type JobCostingBindings = { DB: D1Database };

/**
 * See docs/spec/UI-JOBCOST.md. Two data sources feed this page:
 *
 * 1. job_cost_ledger (labor + overhead lines, immutable once posted per
 *    POSTING.md) for the Stage-1 "applied overhead" tiles, and a work_item
 *    as the estimate source for "hours vs estimate" — the real job/estimate
 *    data lives in the CRM's own database (a cross-database read flagged as
 *    a gap in wave 0); this page's work_item lookup is a stand-in until
 *    that join exists.
 * 2. src/db/repos.ts's getJobProgress (Item 4 Stage 2, PR E) — the single
 *    assembly point wiring real work_orders/job_budget_versions/
 *    job_cost_ledger rows into src/engines/job-progress.ts's
 *    computeJobProgress, which is what actually implements the 9 approved
 *    ITEM4-JOBCOST.md formulas (revised contract value, revised budgeted
 *    direct cost, actual/progress-eligible direct cost to date, earned
 *    completion %, earned revenue, budgeted/recovered/absorbed overhead,
 *    overhead recovery variance). This page renders getJobProgress's output
 *    directly — it recomputes nothing itself, per §11's "no duplicated
 *    formula logic in the UI" requirement.
 *
 * Margin (Stage 1's estimate-minus-labor/overhead figure) is gated behind
 * can_see_margin — crew never sees it (CLAUDE.md), the one rule W4-roles
 * centralizes. The Item 4 formula tiles below are NOT gated by
 * can_see_margin: per ROLES.md, only "margin, wage, or rate fields" are
 * off-limits to crew, and revised budget/earned revenue/overhead figures
 * are progress metrics, not a margin computation — but recovered/absorbed
 * overhead and overhead variance are still finance-facing enough that they
 * follow can_see_recovery, the same gate UI-RECOVERY.md's page uses for the
 * company-wide equivalent of these same figures.
 */
export const jobCostingRouter = new Hono<{ Bindings: JobCostingBindings; Variables: FinanceAuthVars }>();

/** Human copy for each of computeEarnedCompletion's "why is this null"
 * reasons (src/engines/job-progress.ts) — the review-required message shown
 * in place of a fabricated percentage. Every branch of
 * EarnedCompletionUnavailableReason is listed here so a new reason added to
 * the engine fails typecheck here too, rather than silently falling through
 * to a generic message. */
const UNAVAILABLE_REASON_COPY: Record<EarnedCompletionUnavailableReason, string> = {
  no_budget_version: "This job has no approved budget version yet — set one up in Change Orders.",
  zero_direct_cost_budget: "The approved budget's direct-cost figure is $0, so cost-to-cost completion can't be computed.",
  no_service_units_planned: "This job's completion method is service units, but no units-planned figure is set on the budget version.",
  no_manual_override_set: "This job's completion method is manual, but no completion percentage has been entered yet.",
  not_completed: "This is a flat-rate/event job — it reads 0% earned until marked completed and financially closed.",
};

/** Shared "review required" pill for a formula tile whose value is
 * genuinely unavailable — never rendered for a legitimate zero. */
function ReviewRequired({ reason }: { reason: string }) {
  return (
    <div class="fin-empty" data-testid="jobprogress-review-required">
      <div class="fin-empty-t">
        <span class="fin-badge b-med">needs review</span>
      </div>
      <div class="fin-empty-s">{reason}</div>
    </div>
  );
}

/** One formula tile: renders `value` (already formatted by the caller) when
 * non-null, or a ReviewRequired note when null. Distinguishes "unavailable"
 * from "legitimately zero" purely by null-ness — a $0 or 0.0% result from
 * computeJobProgress is a real number and renders as such, never coerced
 * into a review-required state. */
function FormulaTile({
  label, testId, value, sub, negative,
}: {
  label: string; testId: string; value: string | null; sub?: string; negative?: boolean;
}) {
  return (
    <div class="fin-tile">
      <div class="fin-tile-l">{label}</div>
      {value !== null ? (
        <div
          class="fin-tile-v fin-num"
          data-testid={testId}
          style={negative ? "color:var(--gw-rose)" : undefined}
        >
          {value}
        </div>
      ) : (
        // The "why is this unavailable" reason (sub) is nested INSIDE the
        // testid'd element here, not rendered as a sibling — a caller like
        // Playwright's getByTestId(...).toContainText(specificReason) must
        // find the reason within the same element the badge lives in, not
        // merely somewhere else in the tile.
        <div data-testid={testId}>
          <span class="fin-badge b-med">review required</span>
          {sub ? <div class="fin-tile-m">{sub}</div> : null}
        </div>
      )}
      {value !== null && sub ? <div class="fin-tile-m">{sub}</div> : null}
    </div>
  );
}

const pct = (millionths: number): string => `${(millionths / 10_000).toFixed(1)}%`;

jobCostingRouter.get("/", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  const jobId = c.req.query("job_id") ?? "";
  const db = c.env.DB;

  const [lines, workItem, progress] = await Promise.all([
    getJobCostLedgerForJob(db, tenant_id, jobId),
    getWorkItem(db, tenant_id, jobId),
    jobId ? getJobProgress(db, tenant_id, jobId) : Promise.resolve(null),
  ]);

  const laborCents = lines.filter((l) => l.line_type === "labor").reduce((s, l) => s + l.amount_cents, 0);
  const overheadCents = lines.filter((l) => l.line_type === "overhead").reduce((s, l) => s + l.amount_cents, 0);
  const totalCostCents = laborCents + overheadCents;
  const estimateCents = workItem?.estimate_cents ?? null;
  const marginCents = estimateCents !== null ? estimateCents - totalCostCents : null;
  const marginPct =
    estimateCents !== null && estimateCents > 0 && marginCents !== null
      ? (marginCents / estimateCents) * 100
      : null;

  const showMargin = canSee(role, "can_see_margin");
  const showRecovery = canSee(role, "can_see_recovery");

  const earned = progress?.earned_completion ?? null;
  const completionValue = earned && earned.completion_millionths !== null ? pct(earned.completion_millionths) : null;
  const completionReason = earned?.unavailable_reason ? UNAVAILABLE_REASON_COPY[earned.unavailable_reason] : null;

  return c.html(
    <Page
      title={jobId ? `Job ${jobId}` : "Job Costing"}
      active="finJobCost"
      eyebrow="Financial · Job Costing"
      tenant={tenant_id || undefined}
      role={role}
      vocab={vocab}
      partial={isPartialRequest(c)}
    >
      {!jobId ? (
        <Card>
          <Empty
            title="Pick a job to cost"
            hint="Add ?job_id=… to see live cost for a single job: what labor and overhead have landed on it, and how that compares to what it was sold for."
          />
        </Card>
      ) : null}

      {jobId ? (
        <div class="fin-note" data-testid="related-pages-link">
          Contract-value and budget changes for this job (change orders, approval
          history, and completion-method setup) live in{" "}
          <a
            href={`/finance/change-orders?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}&job_id=${encodeURIComponent(jobId)}`}
            data-testid="change-orders-drillthrough-link"
          >
            Change Orders
          </a>
          .
        </div>
      ) : null}

      {jobId && progress ? (
        <Card
          title="Job progress (Item 4 formulas)"
          sub="revised budget, earned completion, and overhead recovery for this job"
        >
          <div class="fin-grid fin-grid-3" data-testid="jobprogress-tiles">
            <FormulaTile
              label="Revised contract value"
              testId="jp-revised-contract-value"
              value={progress.revised_contract_value_cents !== null ? money(progress.revised_contract_value_cents) : null}
              sub="baseline estimate + approved change orders"
            />
            <FormulaTile
              label="Revised budgeted direct cost"
              testId="jp-revised-direct-cost-budget"
              value={progress.revised_budgeted_direct_cost_cents !== null ? money(progress.revised_budgeted_direct_cost_cents) : null}
              sub="materials, subs, equipment, disposal, permits, labor"
            />
            <FormulaTile
              label="Actual direct cost to date"
              testId="jp-actual-direct-cost"
              value={money(progress.actual_direct_cost_to_date_cents)}
              sub={`of which ${money(progress.progress_eligible_direct_cost_to_date_cents)} progress-eligible`}
            />
            <FormulaTile
              label="Earned completion %"
              testId="jp-earned-completion"
              value={completionValue}
              sub={completionReason ?? undefined}
            />
            <FormulaTile
              label="Earned revenue to date"
              testId="jp-earned-revenue"
              value={progress.earned_revenue_to_date_cents !== null ? money(progress.earned_revenue_to_date_cents) : null}
              sub="revised contract value × earned completion %"
            />
            <FormulaTile
              label="Budgeted overhead"
              testId="jp-budgeted-overhead"
              value={progress.revised_budgeted_overhead_cents !== null ? money(progress.revised_budgeted_overhead_cents) : null}
              sub="baseline + approved-CO overhead adjustments"
            />
            {showRecovery ? (
              <>
                <FormulaTile
                  label="Recovered overhead to date"
                  testId="jp-recovered-overhead"
                  value={progress.recovered_overhead_to_date_cents !== null ? money(progress.recovered_overhead_to_date_cents) : null}
                  sub="budgeted overhead × earned completion %"
                />
                <FormulaTile
                  label="Absorbed overhead to date"
                  testId="jp-absorbed-overhead"
                  value={money(progress.absorbed_overhead_to_date_cents)}
                  sub="posted overhead lines, from approved hours at the effective rate"
                />
                <FormulaTile
                  label="Overhead recovery variance"
                  testId="jp-overhead-variance"
                  value={progress.overhead_recovery_variance_cents !== null ? money(progress.overhead_recovery_variance_cents) : null}
                  sub="recovered − absorbed; negative means absorbing ahead of progress"
                  negative={progress.overhead_recovery_variance_cents !== null && progress.overhead_recovery_variance_cents < 0}
                />
              </>
            ) : (
              <div class="fin-empty" data-testid="jobprogress-recovery-hidden">
                <div class="fin-empty-t">Overhead recovery not shown for your role</div>
                <div class="fin-empty-s">Recovered/absorbed overhead and recovery variance are limited to office and owner roles.</div>
              </div>
            )}
          </div>
          <Why
            what="The nine Item 4 job-costing formulas: what this job is now worth, what it's actually costing, how much of it is earned, and how overhead recovery is tracking against progress."
            source="src/engines/job-progress.ts's computeJobProgress, fed by the job's latest approved job_budget_versions row and every posted job_cost_ledger line (src/db/repos.ts's getJobProgress)."
            matters="A job can look on-track by hours logged and still be absorbing more overhead than it has earned, or vice versa — these numbers are what a cost-to-cost read alone would hide."
            moves="Approved change orders (revised budget), posted direct-cost/labor/overhead lines (actuals), and the job's completion method (how earned % is computed)."
          />
        </Card>
      ) : null}

      {jobId && !progress ? (
        <div class="fin-note" data-testid="jobcost-job-not-found" style="border-left-color:var(--gw-amber)">
          No job found with this id under this tenant — nothing to cost.
        </div>
      ) : null}

      <div class="fin-grid fin-grid-3" data-testid="applied-overhead">
        <div class="fin-tile">
          <div class="fin-tile-l">{vocab === "simple" ? "Crew cost" : "Labor cost"}</div>
          <div class="fin-tile-v fin-num" data-testid="labor-cost">{(laborCents / 100).toFixed(2)}</div>
          <div class="fin-tile-m">hours at their burdened rate</div>
        </div>
        <div class="fin-tile">
          <div class="fin-tile-l">
            {vocab === "simple" ? "Share of running the business" : <Term term="overhead absorption" vocab={vocab} />}
          </div>
          <div class="fin-tile-v fin-num" data-testid="overhead-cost">{(overheadCents / 100).toFixed(2)}</div>
          <div class="fin-tile-m">allocated from the overhead pools</div>
        </div>
        <div class="fin-tile">
          <div class="fin-tile-l">Total cost</div>
          <div class="fin-tile-v fin-num" data-testid="total-cost">{(totalCostCents / 100).toFixed(2)}</div>
          <div class="fin-tile-m">{lines.length} posted line{lines.length === 1 ? "" : "s"}</div>
        </div>
      </div>

      <div class="fin-note" data-testid="jobcost-labor-overhead-note">
        Labor cost, overhead cost, and total cost above are the labor+overhead
        subset of this job's posted ledger — materials, subcontractor,
        equipment, disposal, and permit costs are not included in these
        three tiles specifically. See "Actual direct cost to date" above for
        the full posted-cost figure across every category.
      </div>

      <Card title={vocab === "simple" ? "What it sold for" : "Estimate"} sub="from the work item on record">
        <div data-testid="hours-vs-estimate">
          {estimateCents !== null ? (
            <div class="fin-tile-v fin-num" data-testid="estimate-cents">
              {(estimateCents / 100).toFixed(2)}
            </div>
          ) : (
            <div data-testid="estimate-cents">
              <Empty
                title="No estimate on record"
                hint="Job estimates live in the CRM's own database; the cross-database join isn't built yet, so this reads the finance-side work item."
              />
            </div>
          )}
        </div>
      </Card>

      <Card
        title={vocab === "simple" ? "What's left over" : "Live margin"}
        sub={showMargin ? "estimate minus everything that landed on the job" : undefined}
      >
        <div data-testid="live-margin">
          {showMargin ? (
            <>
              <div
                class="fin-tile-v fin-num"
                data-testid="margin-cents"
                style={marginCents !== null && marginCents < 0 ? "color:var(--gw-rose)" : "color:var(--gw-emerald)"}
              >
                {marginCents !== null ? (marginCents / 100).toFixed(2) : "n/a"}
              </div>
              {marginPct !== null ? (
                <div class="fin-tile-m">
                  {marginPct.toFixed(1)}% of what it sold for
                  {marginCents !== null && marginCents < 0
                    ? " — this job is losing money at the current numbers"
                    : ""}
                </div>
              ) : null}
              <Why
                what="What's left after the crew hours and this job's share of running the business."
                source="Estimate on the work item, minus posted labor and overhead lines from the job cost ledger."
                matters="A job can look busy and still lose money. This is the number that tells you which one you're in."
                moves="Hours against plan, what you bought for the job, and what you sold it for."
              />
            </>
          ) : (
            <div class="fin-empty" data-testid="margin-hidden">
              <div class="fin-empty-t">Not shown for your role</div>
              <div class="fin-empty-s">
                Hours and progress are visible to everyone; money left over is limited to
                office and owner roles.
              </div>
            </div>
          )}
        </div>
      </Card>
    </Page>,
  );
});
