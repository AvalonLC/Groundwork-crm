import { Hono } from "hono";
import { getLatestRecoverySnapshot } from "../db/repos";
import { canSee } from "./roles";
import { readPageArgs, Page, Card, Why, type FinanceAuthVars } from "./layout";

export type ForecastBindings = { DB: D1Database };

/**
 * Forecast — real backing (recovery_snapshot), same tenant-level
 * projection Control Center and Overhead Recovery already show, reframed
 * as "what's ahead" rather than "where things stand." Deliberately does
 * NOT attempt a fuller forecast (per-division projection, job-pipeline
 * revenue, multi-week trend): that needs either weeks of trailing
 * recovery_snapshot variance that won't exist until the rollup has run
 * that long (docs/PUNCHLIST.md's confidence_days gap), or the same
 * CRM-side job/pipeline data Collections needed for invoices — not
 * checked for here, so not claimed. Same honesty pattern as
 * recovery.tsx's division-dates note.
 */
export const forecastRouter = new Hono<{ Bindings: ForecastBindings; Variables: FinanceAuthVars }>();

forecastRouter.get("/", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  if (!canSee(role, "can_see_recovery")) {
    return c.html(
      <Page title="Forecast" active="finControl" role={role}>
        <Card>
          <div class="fin-empty" data-testid="denied">
            <div class="fin-empty-t">Not available for your role</div>
            <div class="fin-empty-s">Forecast figures are limited to office and owner roles.</div>
          </div>
        </Card>
      </Page>,
      403,
    );
  }

  const snapshot = await getLatestRecoverySnapshot(c.env.DB, tenant_id);
  const pct = snapshot ? snapshot.pct_recovered_millionths / 10000 : null;

  return c.html(
    <Page title="Forecast" active="finControl" tenant={tenant_id || undefined} role={role} vocab={vocab}>
      <section class="fin-hero" data-testid="forecast-hero">
        <div class="fin-hero-l">Projected coverage date</div>
        {snapshot && pct !== null ? (
          <>
            <div class="fin-hero-v" data-testid="projected-date">{snapshot.projected_black_friday}</div>
            <p class="fin-hero-s">
              At the current pace, this year's fixed costs are fully covered around{" "}
              <strong>{snapshot.projected_black_friday}</strong>, +/- {snapshot.confidence_days} days.
              {" "}Currently at {pct.toFixed(1)}% recovered.
            </p>
          </>
        ) : (
          <>
            <div class="fin-hero-v" data-testid="projected-date">no projection yet</div>
            <p class="fin-hero-s">
              Nothing has been rolled up yet. Once the nightly rollup runs, this shows the
              date this year's fixed costs are on pace to be fully covered.
            </p>
          </>
        )}
      </section>

      <div class="fin-note" data-testid="forecast-scope-note">
        This is a single tenant-level date, not a fuller forecast. A per-division
        breakdown, revenue forecast, or job-pipeline projection would need either weeks
        of trailing rollup history to compute confidence from, or a join against the
        CRM's own job/pipeline data — neither exists yet, so neither is shown here
        rather than estimated.
      </div>

      <Why
        what="The date this year's fixed operating costs are on pace to be fully covered by what's actually being recovered."
        source="The nightly recovery rollup's most recent snapshot — the same number Control Center and Overhead Recovery show."
        matters="A date that keeps slipping later is the earliest warning that overhead recovery is falling behind, before it shows up anywhere else."
        moves="Weekly recovery pace changing — more sellable hours, higher bill rates, or overhead itself changing."
      />
    </Page>,
  );
});
