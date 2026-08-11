import { Hono } from "hono";
import { listCurrentLaborRates, listCurrentEquipmentRates, listOverheadPools } from "../db/repos";
import { canSee } from "./roles";
import { readPageArgs, Page, Term, Card, Empty, Why, isPartialRequest, type FinanceAuthVars } from "./layout";

export type BudgetBindings = { DB: D1Database };

/**
 * See docs/spec/UI-BUDGET.md. "Both rate types" = labor + equipment,
 * grounded in the repo layer. The 6-step wizard framing in the spec is a
 * documented guess with no confirmed content — this page renders the two
 * rate types plus the driver map as plain review tables rather than
 * fabricating wizard steps with no evidence behind them. Gated entirely
 * behind can_see_budget_rates (owner only per docs/spec/ROLES.md).
 */
export const budgetRouter = new Hono<{ Bindings: BudgetBindings; Variables: FinanceAuthVars }>();

budgetRouter.get("/", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  if (!canSee(role, "can_see_budget_rates")) {
    return c.html(
      <Page title="Budget & Rates" active="finBudget" role={role} partial={isPartialRequest(c)}>
        <Card>
          <div class="fin-empty" data-testid="denied">
            <div class="fin-empty-t">Not available for your role</div>
            <div class="fin-empty-s">
              Cost rates and budget figures are owner-only.
            </div>
          </div>
        </Card>
      </Page>,
      403,
    );
  }

  const db = c.env.DB;
  const [laborRates, equipmentRates, pools] = await Promise.all([
    listCurrentLaborRates(db, tenant_id),
    listCurrentEquipmentRates(db, tenant_id),
    listOverheadPools(db, tenant_id),
  ]);

  return c.html(
    <Page
      title="Budget & Rates"
      active="finBudget"
      tenant={tenant_id || undefined}
      role={role}
      vocab={vocab}
      partial={isPartialRequest(c)}
    >
      <div class="fin-note">
        These are the numbers every other page inherits. Cost rates resolve through
        <strong> /internal/rates</strong> — nothing recomputes labor or overhead on its own,
        and a rate row is never edited in place: recalibrating writes a new dated row.
      </div>

      <Card
        title={vocab === "simple" ? "What an hour of crew time costs" : "Labor rates"}
        sub="current effective rows"
      >
        <div data-testid="labor-rates">
          <h1 style="display:none"><Term term="resolved rate" vocab={vocab} /> — labor</h1>
          {laborRates.length === 0 ? (
            <Empty
              title="No labor rates yet"
              hint="Once a rate profile is created, the fully burdened cost of an hour shows here — the number job costing, price floors and break-even all inherit."
            />
          ) : (
            <table class="fin-table">
              <thead>
                <tr>
                  <th>Scope</th>
                  <th>Applies to</th>
                  <th>{vocab === "simple" ? "Base pay / hr" : "Wage"}</th>
                </tr>
              </thead>
              <tbody>
                {laborRates.map((r) => (
                  <tr data-testid={`labor-rate-${r.scope}-${r.scope_id}`}>
                    <td><span class="fin-badge b-human">{r.scope}</span></td>
                    <td><strong>{r.scope_id}</strong></td>
                    <td class="fin-num" data-testid={`labor-wage-${r.scope_id}`}>
                      {(r.wage_cents / 100).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <Why
          what="What one hour of crew time actually costs you once everything is loaded in."
          source="Wage plus taxes, insurance, time off, vehicles and tools, divided by the hours you can actually bill."
          matters="Almost every downstream number inherits this one. Wrong here means wrong everywhere, quietly."
          moves="Pay changes, insurance renewals, and how much of the paid day is genuinely billable."
        />
      </Card>

      <Card
        title={vocab === "simple" ? "What the machines cost to run" : "Equipment rates"}
        sub="current effective rows"
      >
        <div data-testid="equipment-rates">
          <h1 style="display:none"><Term term="resolved rate" vocab={vocab} /> — equipment</h1>
          {equipmentRates.length === 0 ? (
            <Empty
              title="No equipment rates yet"
              hint="With the equipment engine active, machine cost is charged per machine hour instead of being smeared across every labor hour."
            />
          ) : (
            <table class="fin-table">
              <thead>
                <tr><th>Machine</th><th>Purchase price</th></tr>
              </thead>
              <tbody>
                {equipmentRates.map((r) => (
                  <tr data-testid={`equipment-rate-${r.equipment_id}`}>
                    <td><strong>{r.equipment_id}</strong></td>
                    <td class="fin-num" data-testid={`equipment-price-${r.equipment_id}`}>
                      {(r.purchase_price_cents / 100).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>

      <Card
        title={vocab === "simple" ? "How shared costs get split up" : "Overhead pools and drivers"}
        sub="what each pool is divided by"
      >
        <div data-testid="driver-map">
          <h2 style="display:none"><Term term="allocation driver" vocab={vocab} /></h2>
          {pools.length === 0 ? (
            <Empty
              title="No overhead pools yet"
              hint="Pools are the fixed costs of staying open, grouped so each one can be divided by whatever actually drives it."
            />
          ) : (
            <table class="fin-table">
              <thead>
                <tr><th>Division</th><th>Pool</th><th>Divided by</th></tr>
              </thead>
              <tbody>
                {pools.map((p) => (
                  <tr data-testid={`pool-${p.division}-${p.pool_type}`}>
                    <td><strong>{p.division}</strong></td>
                    <td>{p.pool_type}</td>
                    <td data-testid={`driver-${p.division}-${p.pool_type}`}>
                      <span class="fin-badge b-ai">{p.driver}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <Why
          what="The rule each shared cost is split by before it lands on a job."
          source="Overhead pools you define, each with a driver — labor hours, machine hours, headcount or revenue."
          matters="Pick the wrong driver and one part of the business quietly carries another's costs, which makes a losing division look profitable."
          moves="Changing a pool's driver, or the mix of work across divisions."
        />
      </Card>
    </Page>,
  );
});
