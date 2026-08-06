import { Hono } from "hono";
import { getLatestRecoverySnapshot, getOverheadAllocationAsOf } from "../db/repos";
import { canSee } from "./roles";
import { readPageArgs, Page, Term, Card, Empty, Why, type FinanceAuthVars } from "./layout";

export type RecoveryBindings = { FINANCE_DB: D1Database };

/**
 * See docs/spec/UI-RECOVERY.md. Thermometer + absorption are grounded in
 * recovery_snapshot / overhead_allocation. Per-division recovery DATES are a
 * documented gap (UI-RECOVERY.md wave-0 spec): E2-recovery/W3-rollup only
 * compute a tenant-level projection, not per-division, so this page shows
 * the tenant-level date with an explicit note rather than fabricating
 * division breakdowns that don't exist upstream.
 */
export const recoveryRouter = new Hono<{ Bindings: RecoveryBindings; Variables: FinanceAuthVars }>();

recoveryRouter.get("/", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  if (!canSee(role, "can_see_recovery")) {
    return c.html(
      <Page title="Overhead Recovery" active="recovery" role={role}>
        <Card>
          <div class="fin-empty" data-testid="denied">
            <div class="fin-empty-t">Not available for your role</div>
            <div class="fin-empty-s">
              Overhead recovery figures are limited to office and owner roles.
            </div>
          </div>
        </Card>
      </Page>,
      403,
    );
  }

  const db = c.env.FINANCE_DB;
  const snapshot = await getLatestRecoverySnapshot(db, tenant_id);
  const allocations = snapshot ? await getOverheadAllocationAsOf(db, tenant_id, snapshot.as_of) : [];
  const pct = snapshot ? snapshot.pct_recovered_millionths / 10000 : null;

  return c.html(
    <Page
      title="Overhead Recovery"
      active="recovery"
      tenant={tenant_id || undefined}
      role={role}
      vocab={vocab}
    >
      <section class="fin-hero" data-testid="thermometer">
        <div class="fin-hero-l"><Term term="overhead recovery" vocab={vocab} /></div>
        {snapshot && pct !== null ? (
          <>
            <div class="fin-hero-v" data-testid="pct-recovered" style={`width:${pct.toFixed(1)}%`}>
              {pct.toFixed(1)}%
            </div>
            <p class="fin-hero-s" data-testid="projected-date">
              <Term term="restated target" vocab={vocab} /> by{" "}
              <strong>{snapshot.projected_black_friday}</strong> (+/- {snapshot.confidence_days} days)
              {" "}— the date this year's fixed costs are fully covered.
            </p>
            <div class="fin-meter">
              <div class="fin-meter-f" style={`width:${Math.min(pct, 100).toFixed(1)}%`}></div>
            </div>
          </>
        ) : (
          <>
            <div class="fin-hero-v" data-testid="pct-recovered">no snapshot yet</div>
            <p class="fin-hero-s">
              The nightly rollup hasn't produced a snapshot yet. Once it runs, this shows
              how much of the year's overhead is covered and the date you get there.
            </p>
          </>
        )}
      </section>

      <div class="fin-note" data-testid="division-dates">
        <span data-testid="division-dates-note">
          Per-division projection dates are not yet computed upstream — only a
          tenant-level date is available. See docs/spec/UI-RECOVERY.md.
        </span>
      </div>

      <Card
        title="Where the overhead is landing"
        sub={vocab === "simple" ? "by part of the business" : "absorbed cost by division"}
      >
        <div data-testid="absorption">
          {allocations.length === 0 ? (
            <Empty
              title="No division allocations yet"
              hint="Once overhead pools are allocated and hours are posted, each part of the business shows what it has absorbed and what it must bill per hour to cover it."
            />
          ) : (
            <table class="fin-table">
              <thead>
                <tr>
                  <th>Division</th>
                  <th>{vocab === "simple" ? "Overhead carried" : "Absorbed cost"}</th>
                  <th>{vocab === "simple" ? "Must bill per hour" : "Required bill rate"}</th>
                </tr>
              </thead>
              <tbody>
                {allocations.map((a) => (
                  <tr data-testid={`division-${a.division}`}>
                    <td><strong>{a.division}</strong></td>
                    <td class="fin-num" data-testid={`absorbed-${a.division}`}>
                      {(a.absorbed_cost_cents / 100).toFixed(2)}
                    </td>
                    <td class="fin-num" data-testid={`required-bill-rate-${a.division}`}>
                      {(a.required_bill_rate_cents / 100).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <Why
          what="How much of your fixed yearly cost each part of the business has covered so far."
          source="Overhead pools allocated by their driver, charged against hours actually worked — never against invoices or payments."
          matters="A division recovering too slowly drags the whole company's break-even date later, and that's invisible without this split."
          moves="Selling and performing more hours in that division, or raising what you bill per hour."
        />
      </Card>
    </Page>,
  );
});
