import { Hono } from "hono";
import { getJobCostLedgerForJob, getWorkItem } from "../db/repos";
import { canSee } from "./roles";
import { readPageArgs, Page, Term, Card, Empty, Why, money, isPartialRequest, type FinanceAuthVars } from "./layout";

export type JobCostingBindings = { DB: D1Database };

/**
 * See docs/spec/UI-JOBCOST.md. Reads job_cost_ledger (labor + overhead
 * lines, immutable once posted per POSTING.md) for live cost, and a
 * work_item as the estimate source for "hours vs estimate" — the real
 * job/estimate data lives in the CRM's own database (a cross-database read
 * flagged as a gap in wave 0); this page's work_item lookup is a stand-in
 * until that join exists. Margin is gated behind can_see_margin — crew
 * never sees it (CLAUDE.md), the one rule W4-roles centralizes.
 */
export const jobCostingRouter = new Hono<{ Bindings: JobCostingBindings; Variables: FinanceAuthVars }>();

jobCostingRouter.get("/", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  const jobId = c.req.query("job_id") ?? "";
  const db = c.env.DB;

  const [lines, workItem] = await Promise.all([
    getJobCostLedgerForJob(db, tenant_id, jobId),
    getWorkItem(db, tenant_id, jobId),
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
