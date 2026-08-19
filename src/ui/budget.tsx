import { Hono } from "hono";
import { listCurrentLaborRates, listCurrentEquipmentRates, listOverheadPools,
  getTenantFinancePolicy, recalibrateLaborRate, recalibrateEquipmentRate,
  insertOverheadPool } from "../db/repos";
import { parseRateForm, parseEquipmentForm, parseOverheadForm, SCOPES, OVERHEAD_DRIVERS,
  type RateFormFields, type EquipmentFormFields, type OverheadFormFields } from "../api/rate_entry";
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

/** Errors and the values the user typed, so a rejected form comes back filled in. */
type FormState = {
  errors?: string[]; saved?: string; values?: RateFormFields;
  /** Which form the message belongs to, so an error lands under the right one. */
  which?: "labor" | "equipment" | "overhead";
  eqValues?: EquipmentFormFields;
  ovValues?: OverheadFormFields;
};

budgetRouter.get("/", (c) => renderBudget(c, undefined));

/**
 * POST /finance/budget/labor-rate — create or recalibrate a labor rate.
 *
 * Always goes through recalibrateLaborRate, which closes any currently-open row
 * for this scope and inserts a new one in a single batch. That is correct for
 * the first rate too: the UPDATE matches nothing and the INSERT still runs. A
 * rate row is never edited in place — see migrations/finance/0002_rates.sql.
 */
budgetRouter.post("/labor-rate", async (c) => {
  const { tenant_id, role } = readPageArgs(c);
  if (!canSee(role, "can_see_budget_rates")) {
    return renderBudget(c, { errors: ["Cost rates are owner-only."] }, 403);
  }

  const body = (await c.req.parseBody()) as Record<string, string>;
  const values: RateFormFields = body;

  // The equipment-engine flag is read from the policy, never from the form —
  // otherwise the BH-13 guard could be switched off by whoever is submitting.
  const policy = await getTenantFinancePolicy(c.env.DB, tenant_id);
  const equipmentEngineActive = Number(policy?.equipment_engine_active ?? 0) === 1;

  const parsed = parseRateForm(tenant_id, values, equipmentEngineActive);
  if (!parsed.ok) return renderBudget(c, { errors: parsed.errors, values }, 400);

  await recalibrateLaborRate(c.env.DB, tenant_id, parsed.row.scope, parsed.row.scope_id, parsed.row);

  const rate = parsed.preview.burdened_rate.toFixed(4);
  const note = `An hour of ${parsed.row.scope_id} now costs $${rate}` +
    (parsed.warnings.length ? ` — ${parsed.warnings.join(' ')}` : '.');
  return renderBudget(c, { saved: note });
});

/**
 * POST /finance/budget/equipment-rate — create or recalibrate a machine's rate.
 *
 * Same immutability rule as labor: recalibrateEquipmentRate closes the open row
 * and inserts, in one batch, and never edits a rate in place.
 */
budgetRouter.post("/equipment-rate", async (c) => {
  const { tenant_id, role } = readPageArgs(c);
  if (!canSee(role, "can_see_budget_rates")) {
    return renderBudget(c, { errors: ["Cost rates are owner-only."], which: "equipment" }, 403);
  }

  const eqValues = (await c.req.parseBody()) as EquipmentFormFields;
  const parsed = parseEquipmentForm(tenant_id, eqValues);
  if (!parsed.ok) return renderBudget(c, { errors: parsed.errors, eqValues, which: "equipment" }, 400);

  await recalibrateEquipmentRate(c.env.DB, tenant_id, parsed.row.equipment_id, parsed.row);

  const note = `${parsed.row.equipment_id} costs $${parsed.preview.total_rate.toFixed(4)} an hour ` +
    `($${parsed.preview.ownership_rate.toFixed(2)} to own, $${parsed.preview.operating_rate.toFixed(2)} to run)` +
    (parsed.warnings.length ? ` — ${parsed.warnings.join(' ')}` : '.');
  return renderBudget(c, { saved: note, which: "equipment" });
});

/**
 * POST /finance/budget/overhead-pool — add a pool.
 *
 * Unlike the two rate profiles this is a plain insert: overhead_pool has an
 * as_of but no effective_to, and listOverheadPools sums every row it finds. The
 * validation therefore has to see the pools that already exist — both to refuse
 * a duplicate that would double-count, and to check the 10% revenue rule, which
 * is a property of the whole set rather than of this row.
 */
budgetRouter.post("/overhead-pool", async (c) => {
  const { tenant_id, role } = readPageArgs(c);
  if (!canSee(role, "can_see_budget_rates")) {
    return renderBudget(c, { errors: ["Cost rates are owner-only."], which: "overhead" }, 403);
  }

  const ovValues = (await c.req.parseBody()) as OverheadFormFields;
  const existing = await listOverheadPools(c.env.DB, tenant_id);
  const parsed = parseOverheadForm(tenant_id, ovValues, existing);
  if (!parsed.ok) return renderBudget(c, { errors: parsed.errors, ovValues, which: "overhead" }, 400);

  await insertOverheadPool(c.env.DB, parsed.row);

  const note = `${parsed.row.division} — ${parsed.row.pool_type} added. ` +
    `Total overhead is now $${(parsed.totals.total_cents / 100).toLocaleString()}, ` +
    `${(parsed.totals.revenue_share * 100).toFixed(1)}% of it revenue-driven` +
    (parsed.warnings.length ? `. ${parsed.warnings.join(' ')}` : '.');
  return renderBudget(c, { saved: note, which: "overhead" });
});

async function renderBudget(c: any, form: FormState | undefined, status = 200) {
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
  const [laborRates, equipmentRates, pools, policy] = await Promise.all([
    listCurrentLaborRates(db, tenant_id),
    listCurrentEquipmentRates(db, tenant_id),
    listOverheadPools(db, tenant_id),
    getTenantFinancePolicy(db, tenant_id),
  ]);
  const equipmentEngineActive = Number(policy?.equipment_engine_active ?? 0) === 1;

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
              hint="Fill in the form below and the true cost of an hour shows here — the number job costing, price floors and break-even all inherit."
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
        title={vocab === "simple" ? "Set what an hour costs" : "New labor rate profile"}
        sub={equipmentEngineActive
          ? "machine cost is charged separately — leave it out here"
          : "wage, hours and the costs that ride along with them"}
      >
        <div data-testid="rate-form">
          {form?.saved && form.which !== "equipment" ? (
            <div class="fin-note" data-testid="rate-saved">
              Saved. {form.saved}
            </div>
          ) : null}
          {form?.errors?.length && form.which !== "equipment" ? (
            <div class="fin-note fin-note-bad" data-testid="rate-errors">
              <strong>Not saved.</strong>
              <ul>{form.errors.map((e) => <li>{e}</li>)}</ul>
            </div>
          ) : null}

          <form method="post" action="/finance/budget/labor-rate" class="fin-form">
            <div class="fin-form-row">
              <label>
                {vocab === "simple" ? "Applies to" : "Scope"}
                <select name="scope" data-testid="f-scope">
                  {SCOPES.map((s) => (
                    <option value={s} selected={(form?.values?.scope || "employee") === s}>{s}</option>
                  ))}
                </select>
              </label>
              <label>
                {vocab === "simple" ? "Who or which crew" : "Scope id"}
                <input name="scope_id" data-testid="f-scope-id" value={form?.values?.scope_id || ""} />
              </label>
              <label>
                {vocab === "simple" ? "Starts on" : "Effective from"}
                <input name="effective_from" type="date" data-testid="f-effective-from"
                       value={form?.values?.effective_from || new Date().toISOString().slice(0, 10)} />
              </label>
            </div>

            <div class="fin-form-row">
              <label>
                {vocab === "simple" ? "Hourly pay ($)" : "Wage ($/hr)"}
                <input name="wage" data-testid="f-wage" value={form?.values?.wage || ""} />
              </label>
              <label>
                {vocab === "simple" ? "Payroll tax (%)" : "Payroll tax rate (%)"}
                <input name="tax_pct" data-testid="f-tax" value={form?.values?.tax_pct || ""} />
              </label>
              <label>
                {vocab === "simple" ? "Insurance (%)" : "Workers' comp rate (%)"}
                <input name="comp_pct" data-testid="f-comp" value={form?.values?.comp_pct || ""} />
              </label>
              <label>
                {vocab === "simple" ? "Benefits per month ($)" : "Benefits ($/month)"}
                <input name="benefits_monthly" data-testid="f-benefits" value={form?.values?.benefits_monthly || "0"} />
              </label>
            </div>

            <div class="fin-form-row">
              <label>
                {vocab === "simple" ? "Paid hours a year" : "Paid hours"}
                <input name="paid_hours" data-testid="f-paid" value={form?.values?.paid_hours || "2080"} />
              </label>
              <label>
                {vocab === "simple" ? "Time off" : "PTO hours"}
                <input name="pto_hours" data-testid="f-pto" value={form?.values?.pto_hours || "0"} />
              </label>
              <label>
                {vocab === "simple" ? "Shop time" : "Shop hours"}
                <input name="shop_hours" data-testid="f-shop" value={form?.values?.shop_hours || "0"} />
              </label>
              <label>
                {vocab === "simple" ? "Downtime" : "Idle hours"}
                <input name="idle_hours" data-testid="f-idle" value={form?.values?.idle_hours || "0"} />
              </label>
            </div>

            <div class="fin-form-row">
              <label>
                {vocab === "simple" ? "Truck cost a year ($)" : "Support — truck ($/yr)"}
                <input name="support_truck_annual" data-testid="f-truck" value={form?.values?.support_truck_annual || "0"} />
              </label>
              <label>
                {vocab === "simple" ? "Tools a year ($)" : "Support — tools ($/yr)"}
                <input name="support_tools_annual" data-testid="f-tools" value={form?.values?.support_tools_annual || "0"} />
              </label>
              {equipmentEngineActive ? (
                <div data-testid="f-equipment-locked" class="fin-locked">
                  {vocab === "simple" ? "Machine cost" : "Support — equipment"}
                  <input type="hidden" name="support_equipment_annual" value="0" />
                  <p class="fin-hint">
                    Charged per machine hour by the equipment engine, so it is deliberately
                    not in this rate. Putting it here as well would bill the same machine twice.
                  </p>
                </div>
              ) : (
                <label>
                  {vocab === "simple" ? "Machines a year ($)" : "Support — equipment ($/yr)"}
                  <input name="support_equipment_annual" data-testid="f-equipment"
                         value={form?.values?.support_equipment_annual || "0"} />
                </label>
              )}
            </div>

            <button type="submit" class="fin-btn" data-testid="f-submit">
              {laborRates.length ? "Save as a new dated rate" : "Create the first rate"}
            </button>
            <p class="fin-hint">
              Saving never edits the existing rate. It closes the old one on this date and
              writes a new row, so every past job keeps the cost it was actually priced at.
            </p>
          </form>
        </div>
        <Why
          what="The inputs behind the cost of an hour."
          source="What you pay, what rides along with it, and how much of the paid day you can actually bill."
          matters="Nothing downstream can produce a real number until one of these exists — job costing simply has no rate to resolve."
          moves="A raise, an insurance renewal, or a change in how much of the day is billable."
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
        title={vocab === "simple" ? "Set what a machine costs an hour" : "New equipment rate profile"}
        sub="what it costs to own it, and what it costs to run it"
      >
        <div data-testid="equipment-form">
          {form?.saved && form.which === "equipment" ? (
            <div class="fin-note" data-testid="eq-saved">Saved. {form.saved}</div>
          ) : null}
          {form?.errors?.length && form.which === "equipment" ? (
            <div class="fin-note fin-note-bad" data-testid="eq-errors">
              <strong>Not saved.</strong>
              <ul>{form.errors.map((e) => <li>{e}</li>)}</ul>
            </div>
          ) : null}

          <form method="post" action="/finance/budget/equipment-rate" class="fin-form">
            <div class="fin-form-row">
              <label>
                {vocab === "simple" ? "Which machine" : "Equipment id"}
                <input name="equipment_id" data-testid="e-id" value={form?.eqValues?.equipment_id || ""} />
              </label>
              <label>
                {vocab === "simple" ? "Starts on" : "Effective from"}
                <input name="effective_from" type="date" data-testid="e-effective-from"
                       value={form?.eqValues?.effective_from || new Date().toISOString().slice(0, 10)} />
              </label>
            </div>

            <div class="fin-form-row">
              <label>
                {vocab === "simple" ? "What it cost ($)" : "Purchase price ($)"}
                <input name="purchase_price" data-testid="e-price" value={form?.eqValues?.purchase_price || ""} />
              </label>
              <label>
                {vocab === "simple" ? "What it will be worth ($)" : "Salvage value ($)"}
                <input name="salvage" data-testid="e-salvage" value={form?.eqValues?.salvage || "0"} />
              </label>
              <label>
                {vocab === "simple" ? "Years you will keep it" : "Life (years)"}
                <input name="life_years" data-testid="e-life" value={form?.eqValues?.life_years || ""} />
              </label>
              <label>
                {vocab === "simple" ? "Hours a year it runs" : "Annual machine hours"}
                <input name="annual_machine_hours" data-testid="e-hours" value={form?.eqValues?.annual_machine_hours || ""} />
              </label>
            </div>

            <div class="fin-form-row">
              <label>
                {vocab === "simple" ? "Loan rate (%)" : "Finance rate (%)"}
                <input name="finance_pct" data-testid="e-finance" value={form?.eqValues?.finance_pct || "0"} />
              </label>
              <label>
                {vocab === "simple" ? "Insurance a year ($)" : "Insurance ($/yr)"}
                <input name="insurance_annual" data-testid="e-insurance" value={form?.eqValues?.insurance_annual || "0"} />
              </label>
              <label>
                {vocab === "simple" ? "Storage a year ($)" : "Storage ($/yr)"}
                <input name="storage_annual" data-testid="e-storage" value={form?.eqValues?.storage_annual || "0"} />
              </label>
            </div>

            <div class="fin-form-row">
              <label>
                {vocab === "simple" ? "Fuel burned an hour (gal)" : "Fuel burn (gal/hr)"}
                <input name="fuel_gal_per_hr" data-testid="e-fuelburn" value={form?.eqValues?.fuel_gal_per_hr || "0"} />
              </label>
              <label>
                {vocab === "simple" ? "Fuel price a gallon ($)" : "Fuel price ($/gal)"}
                <input name="fuel_price" data-testid="e-fuelprice" value={form?.eqValues?.fuel_price || "0"} />
              </label>
              <label>
                {vocab === "simple" ? "Oil as % of fuel" : "Lube (% of fuel)"}
                <input name="lube_pct_of_fuel" data-testid="e-lube" value={form?.eqValues?.lube_pct_of_fuel || "0"} />
              </label>
              <label>
                {vocab === "simple" ? "Repairs a year ($)" : "Repairs ($/yr)"}
                <input name="repairs_annual" data-testid="e-repairs" value={form?.eqValues?.repairs_annual || "0"} />
              </label>
              <label>
                {vocab === "simple" ? "Wear parts a year ($)" : "Wear ($/yr)"}
                <input name="wear_annual" data-testid="e-wear" value={form?.eqValues?.wear_annual || "0"} />
              </label>
            </div>

            <button type="submit" class="fin-btn" data-testid="e-submit">
              {equipmentRates.length ? "Save as a new dated rate" : "Create the first machine rate"}
            </button>
            <p class="fin-hint">
              {equipmentEngineActive
                ? "The equipment engine is on, so this rate is charged per machine hour and is kept out of the labor rate."
                : "The equipment engine is off, so machine cost is currently carried inside the labor rate instead. Turning the engine on is what makes this rate take effect."}
            </p>
          </form>
        </div>
        <Why
          what="What one hour on this machine costs, split into owning it and running it."
          source="What you paid, what it will be worth, how long you keep it and the loan for owning it; fuel, oil, repairs and wear parts for running it."
          matters="Kept separate so a machine that is cheap to own but thirsty to run cannot hide behind one blended number."
          moves="Fuel price, a major repair, or a change in how many hours a year it actually runs."
        />
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
                <tr>
                  <th>{vocab === "simple" ? "Part of the business" : "Division"}</th>
                  <th>{vocab === "simple" ? "Cost" : "Pool"}</th>
                  <th>Divided by</th>
                </tr>
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
        <div data-testid="overhead-form">
          {form?.saved && form.which === "overhead" ? (
            <div class="fin-note" data-testid="ov-saved">Saved. {form.saved}</div>
          ) : null}
          {form?.errors?.length && form.which === "overhead" ? (
            <div class="fin-note fin-note-bad" data-testid="ov-errors">
              <strong>Not saved.</strong>
              <ul>{form.errors.map((e) => <li>{e}</li>)}</ul>
            </div>
          ) : null}

          <form method="post" action="/finance/budget/overhead-pool" class="fin-form">
            <div class="fin-form-row">
              <label>
                {vocab === "simple" ? "Part of the business" : "Division"}
                <input name="division" data-testid="o-division" value={form?.ovValues?.division || ""} />
              </label>
              <label>
                {vocab === "simple" ? "What the cost is" : "Pool type"}
                <input name="pool_type" data-testid="o-pool-type" value={form?.ovValues?.pool_type || ""} />
              </label>
              <label>
                {vocab === "simple" ? "Cost a year ($)" : "Annual cost ($)"}
                <input name="annual_cost" data-testid="o-cost" value={form?.ovValues?.annual_cost || ""} />
              </label>
              <label>
                {vocab === "simple" ? "Split it by" : "Driver"}
                <select name="driver" data-testid="o-driver">
                  {OVERHEAD_DRIVERS.map((d) => (
                    <option value={d} selected={(form?.ovValues?.driver || "sellable_hours") === d}>
                      {d === "sellable_hours"
                        ? (vocab === "simple" ? "hours you can bill" : "sellable_hours")
                        : (vocab === "simple" ? "money brought in" : "revenue")}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {vocab === "simple" ? "For the year starting" : "As of"}
                <input name="as_of" type="date" data-testid="o-as-of"
                       value={form?.ovValues?.as_of || new Date().toISOString().slice(0, 10)} />
              </label>
            </div>
            <button type="submit" class="fin-btn" data-testid="o-submit">
              {pools.length ? "Add another pool" : "Create the first pool"}
            </button>
            <p class="fin-hint">
              Splitting by money brought in makes a busy part of the business carry a quiet
              one's costs, so no more than a tenth of the total may be split that way. Past
              that, none of these costs can be spread onto jobs at all.
            </p>
          </form>
        </div>
        <Why
          what="The rule each shared cost is split by before it lands on a job."
          source="Overhead pools you define, each with a driver — labor hours, machine hours, headcount or revenue."
          matters="Pick the wrong driver and one part of the business quietly carries another's costs, which makes a losing division look profitable."
          moves="Changing a pool's driver, or the mix of work across divisions."
        />
      </Card>
    </Page>,
    status as any,
  );
}
