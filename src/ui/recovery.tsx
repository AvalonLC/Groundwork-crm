import { Hono } from "hono";
import { getLatestRecoverySnapshot, getOverheadAllocationAsOf } from "../db/repos";
import { canSee } from "./roles";
import { readPageArgs, Page, Term, type FinanceAuthVars } from "./layout";

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
    return c.html(<Page title="Overhead Recovery"><p data-testid="denied">not available for this role</p></Page>, 403);
  }

  const db = c.env.FINANCE_DB;
  const snapshot = await getLatestRecoverySnapshot(db, tenant_id);
  const allocations = snapshot ? await getOverheadAllocationAsOf(db, tenant_id, snapshot.as_of) : [];

  return c.html(
    <Page title="Overhead Recovery">
      <section data-testid="thermometer">
        <h1><Term term="overhead recovery" vocab={vocab} /></h1>
        {snapshot ? (
          <>
            <div data-testid="pct-recovered" style={`width:${(snapshot.pct_recovered_millionths / 10000).toFixed(1)}%`}>
              {(snapshot.pct_recovered_millionths / 10000).toFixed(1)}%
            </div>
            <p data-testid="projected-date">
              <Term term="restated target" vocab={vocab} /> by {snapshot.projected_black_friday}
              {" "}(+/- {snapshot.confidence_days} days)
            </p>
          </>
        ) : <p data-testid="pct-recovered">no snapshot yet</p>}
      </section>

      <section data-testid="division-dates">
        <p data-testid="division-dates-note">
          Per-division projection dates are not yet computed upstream — only a
          tenant-level date is available. See docs/spec/UI-RECOVERY.md.
        </p>
      </section>

      <section data-testid="absorption">
        <h2><Term term="absorbed cost" vocab={vocab} /></h2>
        <table>
          <tbody>
            {allocations.map((a) => (
              <tr data-testid={`division-${a.division}`}>
                <td>{a.division}</td>
                <td data-testid={`absorbed-${a.division}`}>{(a.absorbed_cost_cents / 100).toFixed(2)}</td>
                <td data-testid={`required-bill-rate-${a.division}`}>{(a.required_bill_rate_cents / 100).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </Page>,
  );
});
