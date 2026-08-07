import { Hono } from "hono";
import { canSee } from "./roles";
import { readPageArgs, Page, Card, Empty, Why, type FinanceAuthVars } from "./layout";

export type CollectionsBindings = { DB: D1Database };

interface OpenInvoiceRow {
  id: string;
  invoice_number: string;
  client_name: string;
  status: string;
  balance_due: number;
  due_date: string;
}

/** Days between a due_date and today; negative means overdue. Mirrors
 * queue.tsx's daysOut, applied to a plain date string instead of sla_due. */
function daysOut(dueDate: string): number | null {
  if (!dueDate) return null;
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  if (!isFinite(due)) return null;
  return Math.round((due - Date.now()) / 86_400_000);
}

/**
 * Collections — accounts receivable. Unlike every other Finance OS page,
 * this reads the CRM's own `DB` (invoices table) directly rather than
 * FINANCE_DB: Finance OS has no receivables table of its own, and
 * `migrations/0023_invoices.sql` already has exactly what's needed
 * (status, balance_due, due_date, scoped by company_id — the same
 * identifier as tenant_id here, confirmed via requireAuth in
 * src/index.tsx). Same query shape as the existing "overdue invoices"
 * AI-suggestion in src/index.tsx (~line 5608), widened from
 * overdue-only to every open balance so a not-yet-due invoice is visible
 * before it becomes a problem. Strictly read-only — no write path into
 * the CRM's own invoices table from here, matching CLAUDE.md's
 * propose-don't-post rule by extension.
 */
export const collectionsRouter = new Hono<{ Bindings: CollectionsBindings; Variables: FinanceAuthVars }>();

collectionsRouter.get("/", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  if (!canSee(role, "can_see_recovery")) {
    return c.html(
      <Page title="Collections" active="finQueue" role={role}>
        <Card>
          <div class="fin-empty" data-testid="denied">
            <div class="fin-empty-t">Not available for your role</div>
            <div class="fin-empty-s">Accounts receivable is limited to office and owner roles.</div>
          </div>
        </Card>
      </Page>,
      403,
    );
  }

  const { results: invoices } = await c.env.DB.prepare(
    `SELECT id, invoice_number, client_name, status, balance_due, due_date FROM invoices
     WHERE company_id = ? AND status IN ('sent','viewed','partial','overdue') AND balance_due > 0
     ORDER BY due_date ASC`,
  ).bind(tenant_id).all<OpenInvoiceRow>();

  const totalOwed = invoices.reduce((t, i) => t + i.balance_due, 0);
  const overdue = invoices.filter((i) => (daysOut(i.due_date) ?? 0) < 0);
  const overdueOwed = overdue.reduce((t, i) => t + i.balance_due, 0);

  return c.html(
    <Page title="Collections" active="finQueue" tenant={tenant_id || undefined} role={role} vocab={vocab}>
      <div class="fin-note">
        Reads the CRM's own invoices directly — this is the one Finance OS page that
        does, since there's no receivables table of its own. Read-only: nothing here
        writes back to an invoice.
      </div>

      <div class="fin-grid fin-grid-3">
        <div class="fin-tile">
          <div class="fin-tile-l">Open balance</div>
          <div class="fin-tile-v" data-testid="total-owed">${totalOwed.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          <div class="fin-tile-m">{invoices.length} open invoice{invoices.length === 1 ? "" : "s"}</div>
        </div>
        <div class="fin-tile">
          <div class="fin-tile-l">Overdue</div>
          <div class="fin-tile-v" data-testid="overdue-count" style={overdue.length > 0 ? "color:var(--gw-rose)" : ""}>{overdue.length}</div>
          <div class="fin-tile-m">{overdue.length > 0 ? `$${overdueOwed.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} past due` : "nothing overdue"}</div>
        </div>
      </div>

      <Card title="Open invoices" sub="soonest due date first">
        <div data-testid="collections-list">
          {invoices.length === 0 ? (
            <Empty title="Nothing open" hint="No unpaid invoices for this company right now." />
          ) : (
            <table class="fin-table">
              <thead>
                <tr><th>Client</th><th>Invoice</th><th>Balance due</th><th>Due date</th><th>Status</th></tr>
              </thead>
              <tbody>
                {invoices.map((inv) => {
                  const d = daysOut(inv.due_date);
                  const late = d !== null && d < 0;
                  return (
                    <tr data-testid={`invoice-${inv.id}`}>
                      <td><strong>{inv.client_name}</strong></td>
                      <td>{inv.invoice_number}</td>
                      <td class="fin-num">${inv.balance_due.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      <td style={late ? "color:var(--gw-rose)" : ""}>
                        {inv.due_date || "—"}{late ? ` (${Math.abs(d as number)}d late)` : ""}
                      </td>
                      <td>
                        <span class={`fin-badge ${late ? "b-low" : "b-human"}`} data-testid={`status-${inv.id}`}>
                          {inv.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <Why
          what="Every invoice this company has sent that isn't fully paid, void, or still a draft."
          source="The CRM's own invoices table, read directly — Finance OS has no separate receivables ledger."
          matters="This is real cash already earned but not yet in hand. The older it gets, the harder it is to collect."
          moves="A customer paying, or the invoice being marked paid/written off in the main CRM — not editable from here."
        />
      </Card>
    </Page>,
  );
});
