import { Hono } from "hono";
import { canSee } from "./roles";
import { readPageArgs, Page, Card, Empty, Why, isPartialRequest, type FinanceAuthVars } from "./layout";

export type LedgerBindings = { DB: D1Database };

interface LedgerEvent {
  ts: string;
  type: "invoice" | "payment";
  label: string;
  amount_cents: number;
  status: string;
}

/**
 * Ledger — the real-data rebuild of the CRM SPA's financialActivity(),
 * which read three localStorage keys (avalonPayments/avalonDeposits/
 * avalonInvoices) plus in-memory won opportunities. This page keeps only
 * the two pieces that are actually D1-backed (invoices, payments) — read
 * directly from the CRM's own DB, same as collections.tsx and
 * invoices-payments.tsx. Deposits and Statements have no D1 table or API
 * route today (confirmed: avalonDeposits/avalonStatements are
 * localStorage-only) — said honestly below rather than faked. Strictly
 * read-only.
 */
export const ledgerRouter = new Hono<{ Bindings: LedgerBindings; Variables: FinanceAuthVars }>();

ledgerRouter.get("/", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  if (!canSee(role, "can_see_recovery")) {
    return c.html(
      <Page title="Ledger" active="finLedger" role={role} partial={isPartialRequest(c)}>
        <Card>
          <div class="fin-empty" data-testid="denied">
            <div class="fin-empty-t">Not available for your role</div>
            <div class="fin-empty-s">The ledger is limited to office and owner roles.</div>
          </div>
        </Card>
      </Page>,
      403,
    );
  }

  const [{ results: invoices }, { results: payments }] = await Promise.all([
    c.env.DB.prepare(
      `SELECT invoice_number, client_name, total_cents, created_at FROM invoices
       WHERE company_id = ? ORDER BY created_at DESC LIMIT 50`,
    ).bind(tenant_id).all<{ invoice_number: string; client_name: string; total_cents: number; created_at: string }>(),
    c.env.DB.prepare(
      `SELECT COALESCE(NULLIF(p.invoice_number,''), i.invoice_number) AS invoice_number_display,
              p.client_id, p.amount_cents, p.status, p.created_at
       FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id
       WHERE p.company_id = ? ORDER BY p.created_at DESC LIMIT 50`,
    ).bind(tenant_id).all<{ invoice_number_display: string | null; client_id: string | null; amount_cents: number; status: string; created_at: string }>(),
  ]);

  const events: LedgerEvent[] = [
    ...invoices.map((i) => ({
      ts: i.created_at, type: "invoice" as const,
      label: `Invoice ${i.invoice_number || ""} — ${i.client_name || "client"}`,
      amount_cents: i.total_cents, status: "sent",
    })),
    ...payments.map((p) => ({
      ts: p.created_at, type: "payment" as const,
      label: `Payment — ${p.invoice_number_display ? `invoice ${p.invoice_number_display}` : "no invoice on file"}`,
      amount_cents: p.amount_cents, status: p.status,
    })),
  ].sort((a, b) => b.ts.localeCompare(a.ts));

  const totalInCents = events.filter((e) => e.type === "payment").reduce((t, e) => t + e.amount_cents, 0);

  return c.html(
    <Page title="Ledger" active="finLedger" tenant={tenant_id || undefined} role={role} vocab={vocab} partial={isPartialRequest(c)}>
      <div class="fin-note" data-testid="deposits-statements-gap">
        This is invoices and payments only — the two record types that are
        actually tracked in the CRM's database. Deposits and Statements
        aren't tracked server-side yet (still browser-local); until they are,
        this page won't claim to show them.{" "}
        <a href="/#deposits" style="font-weight:700">Deposits</a> ·{" "}
        <a href="/#statements" style="font-weight:700">Statements</a>{" "}
        stay reachable in the main app.
      </div>

      <div class="fin-grid fin-grid-3">
        <div class="fin-tile">
          <div class="fin-tile-l">Activity</div>
          <div class="fin-tile-v" data-testid="event-count">{events.length}</div>
          <div class="fin-tile-m">invoices + payments</div>
        </div>
        <div class="fin-tile">
          <div class="fin-tile-l">Total received</div>
          <div class="fin-tile-v" data-testid="total-in">${(totalInCents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          <div class="fin-tile-m">across shown payments</div>
        </div>
      </div>

      <Card title="Activity" sub="newest first">
        <div data-testid="ledger-list">
          {events.length === 0 ? (
            <Empty title="Nothing yet" hint="Invoices and payments will show up here as they happen." />
          ) : (
            <table class="fin-table">
              <thead>
                <tr><th>Date</th><th>Description</th><th>Amount</th><th>Type</th></tr>
              </thead>
              <tbody>
                {events.map((e, i) => (
                  <tr data-testid={`event-${i}`}>
                    <td>{e.ts ? e.ts.slice(0, 10) : "—"}</td>
                    <td>{e.label}</td>
                    <td class="fin-num">${(e.amount_cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    <td><span class={`fin-badge ${e.type === "payment" ? "b-high" : "b-human"}`}>{e.type}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <Why
          what="A single chronological feed of invoices sent and payments received."
          source="The CRM's own invoices and payments tables, merged and sorted here — not a separate ledger of its own."
          matters="The record of what actually happened financially, in order, in one place."
          moves="A new invoice or payment. Nothing here is editable from this page."
        />
      </Card>
    </Page>,
  );
});
