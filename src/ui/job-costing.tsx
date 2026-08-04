import { Hono } from "hono";
import { getJobCostLedgerForJob, getWorkItem } from "../db/repos";
import { canSee } from "./roles";
import { readPageArgs, Page, Term, type FinanceAuthVars } from "./layout";

export type JobCostingBindings = { FINANCE_DB: D1Database };

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
  const db = c.env.FINANCE_DB;

  const [lines, workItem] = await Promise.all([
    getJobCostLedgerForJob(db, tenant_id, jobId),
    getWorkItem(db, tenant_id, jobId),
  ]);

  const laborCents = lines.filter((l) => l.line_type === "labor").reduce((s, l) => s + l.amount_cents, 0);
  const overheadCents = lines.filter((l) => l.line_type === "overhead").reduce((s, l) => s + l.amount_cents, 0);
  const totalCostCents = laborCents + overheadCents;
  const estimateCents = workItem?.estimate_cents ?? null;
  const marginCents = estimateCents !== null ? estimateCents - totalCostCents : null;

  return c.html(
    <Page title="Job Costing">
      <h1>Job {jobId}</h1>

      <section data-testid="applied-overhead">
        <h2><Term term="overhead absorption" vocab={vocab} /></h2>
        <p data-testid="labor-cost">{(laborCents / 100).toFixed(2)}</p>
        <p data-testid="overhead-cost">{(overheadCents / 100).toFixed(2)}</p>
        <p data-testid="total-cost">{(totalCostCents / 100).toFixed(2)}</p>
      </section>

      <section data-testid="hours-vs-estimate">
        <h2>Estimate</h2>
        {estimateCents !== null
          ? <p data-testid="estimate-cents">{(estimateCents / 100).toFixed(2)}</p>
          : <p data-testid="estimate-cents">no estimate on record</p>}
      </section>

      <section data-testid="live-margin">
        <h2><Term term="margin" vocab={vocab} /></h2>
        {canSee(role, "can_see_margin") ? (
          <p data-testid="margin-cents">{marginCents !== null ? (marginCents / 100).toFixed(2) : "n/a"}</p>
        ) : (
          <p data-testid="margin-hidden">not available for this role</p>
        )}
      </section>
    </Page>,
  );
});
