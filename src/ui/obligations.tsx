import { Hono } from "hono";
import { canSee } from "./roles";
import { readPageArgs, Page, Card, Empty, type FinanceAuthVars } from "./layout";

export type ObligationsBindings = { FINANCE_DB: D1Database };

/**
 * Obligations — accounts payable (money the company owes). Genuinely
 * blocked, not just unbuilt: unlike Collections, there is no vendor
 * bill/AP table anywhere in the CRM's `DB` to read — confirmed directly
 * (2026-08-06) by checking for real vendor/expense/bank-transaction data
 * before building the classifier config, per PUNCHLIST.md's ingest gap.
 * The CRM only has invoices/payments (money coming IN from customers).
 * An honest empty state rather than repurposing action_item(verb='pay'),
 * which nothing currently populates in bulk either.
 */
export const obligationsRouter = new Hono<{ Bindings: ObligationsBindings; Variables: FinanceAuthVars }>();

obligationsRouter.get("/", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  if (!canSee(role, "can_see_recovery")) {
    return c.html(
      <Page title="Obligations" active="obligations" role={role}>
        <Card>
          <div class="fin-empty" data-testid="denied">
            <div class="fin-empty-t">Not available for your role</div>
            <div class="fin-empty-s">Accounts payable is limited to office and owner roles.</div>
          </div>
        </Card>
      </Page>,
      403,
    );
  }

  return c.html(
    <Page title="Obligations" active="obligations" tenant={tenant_id || undefined} role={role} vocab={vocab}>
      <Card title="Money the company owes">
        <div data-testid="obligations-blocked">
          <Empty
            title="No vendor bill data exists yet"
            hint="This needs a real accounts-payable source — vendor bills, bank/card transactions categorized as expenses, or a bookkeeping export. The CRM's own database has invoices and payments (money coming in from customers) but nothing for money going out to vendors. Uploading a bank or card export at Upload Documents is the closest existing path, once ingest.sources.json's rules are confirmed against a real export."
          />
        </div>
      </Card>
    </Page>,
  );
});
