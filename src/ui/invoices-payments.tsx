import { Hono } from "hono";
import { canSee } from "./roles";
import { readPageArgs, Page, Card, Empty, Why, isPartialRequest, type FinanceAuthVars } from "./layout";

export type InvoicesPaymentsBindings = { DB: D1Database };

interface InvoiceRow {
  id: string;
  invoice_number: string;
  client_name: string;
  status: string;
  total_cents: number;
  balance_due_cents: number;
  due_date: string;
}

interface PaymentRow {
  id: string;
  invoice_number_display: string | null;
  client_id: string | null;
  amount_cents: number;
  payment_method: string;
  status: string;
  created_at: string;
}

const INVOICE_BADGE: Record<string, string> = {
  paid: "b-high",
  partial: "b-med",
  overdue: "b-low",
  void: "b-human",
  written_off: "b-human",
};

/**
 * Invoices & Payments — the full record view (every invoice, any status),
 * distinct from Collections (which only shows open/actionable receivables).
 * Reads the CRM's own `DB` directly, same as collections.tsx — no
 * receivables/payments table of its own in Finance OS. Strictly read-only.
 */
export const invoicesPaymentsRouter = new Hono<{ Bindings: InvoicesPaymentsBindings; Variables: FinanceAuthVars }>();

invoicesPaymentsRouter.get("/", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  if (!canSee(role, "can_see_recovery")) {
    return c.html(
      <Page title="Invoices & Payments" active="finInvPay" role={role} partial={isPartialRequest(c)}>
        <Card>
          <div class="fin-empty" data-testid="denied">
            <div class="fin-empty-t">Not available for your role</div>
            <div class="fin-empty-s">Invoices and payments are limited to office and owner roles.</div>
          </div>
        </Card>
      </Page>,
      403,
    );
  }

  const [{ results: invoices }, { results: payments }] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, invoice_number, client_name, status, total_cents, balance_due_cents, due_date FROM invoices
       WHERE company_id = ? ORDER BY due_date DESC, invoice_number DESC LIMIT 50`,
    ).bind(tenant_id).all<InvoiceRow>(),
    c.env.DB.prepare(
      `SELECT p.id, COALESCE(NULLIF(p.invoice_number,''), i.invoice_number) AS invoice_number_display,
              p.client_id, p.amount_cents, p.payment_method, p.status, p.created_at
       FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id
       WHERE p.company_id = ? ORDER BY p.created_at DESC LIMIT 50`,
    ).bind(tenant_id).all<PaymentRow>(),
  ]);

  return c.html(
    <Page title="Invoices & Payments" active="finInvPay" tenant={tenant_id || undefined} role={role} vocab={vocab} partial={isPartialRequest(c)}>
      <div class="fin-note">
        Reads the CRM's own invoices and payments directly — the full record,
        every status. For just what's still owed, see Collections instead.
      </div>

      <Card title="Invoices" sub="most recent 50, any status">
        <div data-testid="invoices-list">
          {invoices.length === 0 ? (
            <Empty title="No invoices yet" hint="Invoices this company sends will show up here." />
          ) : (
            <table class="fin-table">
              <thead>
                <tr><th>Invoice</th><th>Client</th><th>Total</th><th>Balance due</th><th>Due date</th><th>Status</th></tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr data-testid={`invoice-${inv.id}`}>
                    <td>{inv.invoice_number || "—"}</td>
                    <td><strong>{inv.client_name || "—"}</strong></td>
                    <td class="fin-num">${(inv.total_cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    <td class="fin-num">${(inv.balance_due_cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    <td>{inv.due_date || "—"}</td>
                    <td><span class={`fin-badge ${INVOICE_BADGE[inv.status] ?? "b-human"}`}>{inv.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>

      <Card title="Payments" sub="most recent 50">
        <div data-testid="payments-list">
          {payments.length === 0 ? (
            <Empty title="No payments yet" hint="Payments recorded against invoices will show up here." />
          ) : (
            <table class="fin-table">
              <thead>
                <tr><th>Date</th><th>Invoice</th><th>Amount</th><th>Method</th><th>Status</th></tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr data-testid={`payment-${p.id}`}>
                    <td>{p.created_at ? p.created_at.slice(0, 10) : "—"}</td>
                    <td>{p.invoice_number_display || "—"}</td>
                    <td class="fin-num">${(p.amount_cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    <td>{p.payment_method || "—"}</td>
                    <td><span class="fin-badge b-human">{p.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <Why
          what="Every invoice this company has sent, and every payment recorded against them."
          source="The CRM's own invoices and payments tables, read directly — Finance OS has no separate copy."
          matters="This is the underlying record Collections, Ledger, and the recovery numbers all ultimately trace back to."
          moves="A new invoice being sent, or a payment being recorded — not editable from here."
        />
      </Card>
    </Page>,
  );
});
