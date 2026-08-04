import { Hono } from "hono";
import { listCurrentLaborRates, listCurrentEquipmentRates, listOverheadPools } from "../db/repos";
import { canSee } from "./roles";
import { readPageArgs, Page, Term } from "./layout";

export type BudgetBindings = { FINANCE_DB: D1Database };

/**
 * See docs/spec/UI-BUDGET.md. "Both rate types" = labor + equipment,
 * grounded in the repo layer. The 6-step wizard framing in the spec is a
 * documented guess with no confirmed content — this page renders the two
 * rate types plus the driver map as plain review tables rather than
 * fabricating wizard steps with no evidence behind them. Gated entirely
 * behind can_see_budget_rates (owner only per docs/spec/ROLES.md).
 */
export const budgetRouter = new Hono<{ Bindings: BudgetBindings }>();

budgetRouter.get("/", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  if (!canSee(role, "can_see_budget_rates")) {
    return c.html(<Page title="Budget & Rates"><p data-testid="denied">not available for this role</p></Page>, 403);
  }

  const db = c.env.FINANCE_DB;
  const [laborRates, equipmentRates, pools] = await Promise.all([
    listCurrentLaborRates(db, tenant_id),
    listCurrentEquipmentRates(db, tenant_id),
    listOverheadPools(db, tenant_id),
  ]);

  return c.html(
    <Page title="Budget & Rates">
      <section data-testid="labor-rates">
        <h1><Term term="resolved rate" vocab={vocab} /> — labor</h1>
        <table>
          <tbody>
            {laborRates.map((r) => (
              <tr data-testid={`labor-rate-${r.scope}-${r.scope_id}`}>
                <td>{r.scope}</td><td>{r.scope_id}</td>
                <td data-testid={`labor-wage-${r.scope_id}`}>{(r.wage_cents / 100).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section data-testid="equipment-rates">
        <h1><Term term="resolved rate" vocab={vocab} /> — equipment</h1>
        <table>
          <tbody>
            {equipmentRates.map((r) => (
              <tr data-testid={`equipment-rate-${r.equipment_id}`}>
                <td>{r.equipment_id}</td>
                <td data-testid={`equipment-price-${r.equipment_id}`}>{(r.purchase_price_cents / 100).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section data-testid="driver-map">
        <h2><Term term="allocation driver" vocab={vocab} /></h2>
        <table>
          <tbody>
            {pools.map((p) => (
              <tr data-testid={`pool-${p.division}-${p.pool_type}`}>
                <td>{p.division}</td><td>{p.pool_type}</td>
                <td data-testid={`driver-${p.division}-${p.pool_type}`}>{p.driver}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </Page>,
  );
});
