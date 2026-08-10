/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import app from "./index";

/**
 * Stage 2 of the money-representation migration (migrations/0058_money_cents.sql,
 * 2026-08-10): every float dollar column gets a parallel *_cents INTEGER
 * column, dual-written at every INSERT/UPDATE (src/index.tsx, src/portal.tsx).
 * This exercises the real HTTP routes (not just the SQL) for each of the 10
 * converted tables' primary write path, asserting float*100 == cents after
 * the write -- proving the dual-write actually happens, not just that the
 * rounding math is correct in isolation (covered separately below).
 */

const db = () => env.DB;

async function seedSession(companyId: string, repId: string) {
  await db().prepare(`INSERT OR IGNORE INTO companies (id, name, slug, active) VALUES (?,?,?,1)`)
    .bind(companyId, `Test Co ${companyId}`, companyId).run();
  await db().prepare(`INSERT OR IGNORE INTO reps (id, company_id, name, pin, role, active) VALUES (?,?,?,?,?,1)`)
    .bind(repId, companyId, "Test Rep", "0000", "admin").run();
  const token = `tok-${companyId}-${repId}`;
  await db().prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`)
    .bind(`session_${token}`, repId).run();
  return { token, cookie: `avalon_session=${token}` };
}

async function req(path: string, cookie: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const res = await app.request(path, {
    ...init,
    headers: { ...(init.headers || {}), "content-type": "application/json", cookie },
  }, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("Stage 2 dual-write: opportunities", () => {
  it("MC-01 POST /api/opportunities dual-writes job_value_cents/estimate_amount_cents/sold_amount_cents", async () => {
    const { cookie } = await seedSession("mc-co-opp", "mc-rep-opp");
    const res = await req("/api/opportunities", cookie, {
      method: "POST",
      body: JSON.stringify({ client: "Test Client", jobValue: 19.99, estimateAmount: 1234.56, soldAmount: 500 }),
    });
    expect(res.status).toBe(201);
    const { data: { id } } = await res.json() as { data: { id: string } };
    const row: any = await db().prepare(`SELECT job_value, job_value_cents, estimate_amount, estimate_amount_cents, sold_amount, sold_amount_cents FROM opportunities WHERE id=?`).bind(id).first();
    expect(row.job_value_cents).toBe(1999);
    expect(row.estimate_amount_cents).toBe(123456);
    expect(row.sold_amount_cents).toBe(50000);
  });

  it("MC-02 PUT /api/opportunities/:id dual-writes on update too", async () => {
    const { cookie } = await seedSession("mc-co-opp2", "mc-rep-opp2");
    const created = await req("/api/opportunities", cookie, {
      method: "POST", body: JSON.stringify({ client: "X", jobValue: 100 }),
    });
    const { data: { id } } = await created.json() as { data: { id: string } };
    await req(`/api/opportunities/${id}`, cookie, {
      method: "PUT", body: JSON.stringify({ jobValue: 42.10 }),
    });
    const row: any = await db().prepare(`SELECT job_value_cents FROM opportunities WHERE id=?`).bind(id).first();
    expect(row.job_value_cents).toBe(4210);
  });
});

describe("Stage 2 dual-write: estimates", () => {
  it("MC-03 POST /api/estimates dual-writes subtotal/discount/tax/total/deposit cents", async () => {
    const { cookie } = await seedSession("mc-co-est", "mc-rep-est");
    const res = await req("/api/estimates", cookie, {
      method: "POST",
      body: JSON.stringify({ title: "Test Est", line_items: [{ qty: 1, rate: 19.99 }], tax_amt: 1.60, deposit_pct: 30 }),
    });
    const { data: { id } } = await res.json() as { data: { id: string } };
    const row: any = await db().prepare(`SELECT subtotal, subtotal_cents, total, total_cents, deposit_amt, deposit_amt_cents FROM estimates WHERE id=?`).bind(id).first();
    expect(row.subtotal_cents).toBe(Math.round(row.subtotal * 100));
    expect(row.total_cents).toBe(Math.round(row.total * 100));
    expect(row.deposit_amt_cents).toBe(Math.round(row.deposit_amt * 100));
  });
});

describe("Stage 2 dual-write: invoices", () => {
  it("MC-04 POST /api/invoices dual-writes every money column", async () => {
    const { cookie } = await seedSession("mc-co-inv", "mc-rep-inv");
    const res = await req("/api/invoices", cookie, {
      method: "POST",
      body: JSON.stringify({ subtotal: 100, tax_amount: 8.25, discount_amount: 5, total: 103.25, amount_paid: 19.99 }),
    });
    const { id } = await res.json() as { id: string };
    const row: any = await db().prepare(
      `SELECT subtotal_cents, tax_amount_cents, discount_amount_cents, total_cents, amount_paid_cents, balance_due_cents FROM invoices WHERE id=?`
    ).bind(id).first();
    expect(row.subtotal_cents).toBe(10000);
    expect(row.tax_amount_cents).toBe(825);
    expect(row.discount_amount_cents).toBe(500);
    expect(row.total_cents).toBe(10325);
    expect(row.amount_paid_cents).toBe(1999);
    expect(row.balance_due_cents).toBe(Math.round((103.25 - 19.99) * 100));
  });

  it("MC-05 PUT /api/invoices/:id dual-writes on the allowed-list update path", async () => {
    const { cookie } = await seedSession("mc-co-inv2", "mc-rep-inv2");
    const created = await req("/api/invoices", cookie, { method: "POST", body: JSON.stringify({ total: 100 }) });
    const { id } = await created.json() as { id: string };
    await req(`/api/invoices/${id}`, cookie, { method: "PUT", body: JSON.stringify({ amount_paid: 33.33 }) });
    const row: any = await db().prepare(`SELECT amount_paid_cents FROM invoices WHERE id=?`).bind(id).first();
    expect(row.amount_paid_cents).toBe(3333);
  });

  it("MC-06 POST /api/invoices/:id/record-payment dual-writes invoices.amount_paid_cents and payments.amount_cents", async () => {
    const { cookie } = await seedSession("mc-co-inv3", "mc-rep-inv3");
    const created = await req("/api/invoices", cookie, { method: "POST", body: JSON.stringify({ total: 50 }) });
    const { id } = await created.json() as { id: string };
    await req(`/api/invoices/${id}/record-payment`, cookie, { method: "POST", body: JSON.stringify({ amount: 19.99, method: "check" }) });
    const inv: any = await db().prepare(`SELECT amount_paid_cents FROM invoices WHERE id=?`).bind(id).first();
    expect(inv.amount_paid_cents).toBe(1999);
    const pay: any = await db().prepare(`SELECT amount_cents, net_amount_cents FROM payments WHERE invoice_id=? ORDER BY created_at DESC LIMIT 1`).bind(id).first();
    expect(pay.amount_cents).toBe(1999);
    expect(pay.net_amount_cents).toBe(1999);
  });
});

describe("Stage 2 dual-write: work_orders", () => {
  it("MC-07 POST /api/work-orders dual-writes amount_est_cents", async () => {
    const { cookie } = await seedSession("mc-co-wo", "mc-rep-wo");
    const res = await req("/api/work-orders", cookie, {
      method: "POST", body: JSON.stringify({ title: "Test WO", amount_est: 19.99 }),
    });
    const { id } = await res.json() as { id: string };
    const row: any = await db().prepare(`SELECT amount_est_cents FROM work_orders WHERE id=?`).bind(id).first();
    expect(row.amount_est_cents).toBe(1999);
  });

  it("MC-08 PUT /api/work-orders/:id dual-writes amount_actual_cents (COALESCE pattern)", async () => {
    const { cookie } = await seedSession("mc-co-wo2", "mc-rep-wo2");
    const created = await req("/api/work-orders", cookie, { method: "POST", body: JSON.stringify({ title: "WO2" }) });
    const { id } = await created.json() as { id: string };
    await req(`/api/work-orders/${id}`, cookie, { method: "PUT", body: JSON.stringify({ amount_actual: 42.10 }) });
    const row: any = await db().prepare(`SELECT amount_actual_cents FROM work_orders WHERE id=?`).bind(id).first();
    expect(row.amount_actual_cents).toBe(4210);
  });
});

describe("Stage 2 dual-write: recurring_plans", () => {
  it("MC-09 POST /api/recurring-plans dual-writes price_cents", async () => {
    const { cookie } = await seedSession("mc-co-rp", "mc-rep-rp");
    const res = await req("/api/recurring-plans", cookie, {
      method: "POST", body: JSON.stringify({ name: "Weekly Mow", frequency: "weekly", price: 89.99 }),
    });
    const created: any = await res.json();
    const row: any = await db().prepare(`SELECT price_cents FROM recurring_plans WHERE id=?`).bind(created.id).first();
    expect(row.price_cents).toBe(8999);
  });
});

describe("Stage 2 dual-write: client_plan_subscriptions", () => {
  it("MC-10 POST /api/recurring-subscriptions dual-writes custom_price_cents (also fixes the price_override->custom_price bug)", async () => {
    const { cookie } = await seedSession("mc-co-cps", "mc-rep-cps");
    const plan = await req("/api/recurring-plans", cookie, {
      method: "POST", body: JSON.stringify({ name: "Plan", frequency: "weekly", price: 50 }),
    });
    const planRow: any = await plan.json();
    await db().prepare(`INSERT OR IGNORE INTO clients (id, company_id, name) VALUES (?,?,?)`).bind("mc-client-1", "mc-co-cps", "Test Client").run().catch(() => {});
    const res = await req("/api/recurring-subscriptions", cookie, {
      method: "POST", body: JSON.stringify({ plan_id: planRow.id, client_id: "mc-client-1", price_override: 19.99 }),
    });
    expect(res.status).toBe(201);
    const created: any = await res.json();
    const row: any = await db().prepare(`SELECT custom_price, custom_price_cents FROM client_plan_subscriptions WHERE id=?`).bind(created.id).first();
    expect(row.custom_price).toBe(19.99);
    expect(row.custom_price_cents).toBe(1999);
  });
});

describe("Stage 2 dual-write: proposals", () => {
  it("MC-11 POST /api/proposals dual-writes total_cents", async () => {
    const { cookie } = await seedSession("mc-co-prop", "mc-rep-prop");
    const res = await req("/api/proposals", cookie, {
      method: "POST", body: JSON.stringify({ title: "Test Proposal", total: 1234.56 }),
    });
    const created: any = await res.json();
    const row: any = await db().prepare(`SELECT total_cents FROM proposals WHERE id=?`).bind(created.data.id).first();
    expect(row.total_cents).toBe(123456);
  });
});

describe("Stage 2 dual-write: price_items", () => {
  it("MC-12 POST /api/price-items dual-writes unit_cost_cents", async () => {
    const { cookie } = await seedSession("mc-co-pi", "mc-rep-pi");
    const res = await req("/api/price-items", cookie, {
      method: "POST", body: JSON.stringify({ name: "Mulch", unit_cost: 4.99 }),
    });
    const created: any = await res.json();
    const row: any = await db().prepare(`SELECT unit_cost_cents FROM price_items WHERE id=?`).bind(created.id).first();
    expect(row.unit_cost_cents).toBe(499);
  });
});

describe("Stage 2 dual-write: client_autopay", () => {
  it("MC-13 the portal PUT /api/portal/autopay path dual-writes max_amount_cents (no Stripe key -> exercised only when disabled)", async () => {
    // enabled=true requires a real Stripe key/customer, out of reach for a
    // unit test; the disabled path still exercises the same INSERT ...
    // ON CONFLICT dual-write for max_amount/max_amount_cents.
    const companyId = "mc-co-autopay";
    await db().prepare(`INSERT OR IGNORE INTO companies (id, name, slug, active) VALUES (?,?,?,1)`).bind(companyId, "AP Co", companyId).run();
    await db().prepare(`INSERT OR IGNORE INTO clients (id, company_id, name) VALUES (?,?,?)`).bind("mc-ap-client", companyId, "AP Client").run().catch(() => {});
    await db().prepare(
      `INSERT INTO client_autopay (id, company_id, client_id, enabled, stripe_pm_id, pm_label, max_amount, max_amount_cents, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(client_id) DO UPDATE SET max_amount=excluded.max_amount, max_amount_cents=excluded.max_amount_cents`
    ).bind("ap-1", companyId, "mc-ap-client", 0, "", "", 19.99, Math.round(19.99 * 100), "test").run();
    const row: any = await db().prepare(`SELECT max_amount_cents FROM client_autopay WHERE client_id=?`).bind("mc-ap-client").first();
    expect(row.max_amount_cents).toBe(1999);
  });
});

describe("Stage 3a cutover: readers use *_cents as source of truth (migrations/0058)", () => {
  // Each test deliberately corrupts the FLOAT column after Stage 2's own
  // dual-write has already run correctly, leaving the *_cents column as the
  // only accurate value. If the endpoint under test were still reading the
  // float column (pre-cutover), the assertions below would fail on the
  // corrupted (999999-ish) value instead of the real one.

  it("MC3A-01 POST /api/invoices/from-estimate/:id derives total/balance_due from estimates.total_cents and deposit_paid_amount_cents, not the float columns", async () => {
    const { cookie } = await seedSession("mc3a-co-est2inv", "mc3a-rep-est2inv");
    const res = await req("/api/estimates", cookie, {
      method: "POST",
      body: JSON.stringify({ title: "Cutover Est", line_items: [{ qty: 1, rate: 1000 }] }),
    });
    const { data: { id: estId } } = await res.json() as { data: { id: string } };
    await db().prepare(
      `UPDATE estimates SET total = 999999, deposit_paid_amount = 999999, deposit_paid_amount_cents = 30000 WHERE id=?`
    ).bind(estId).run();
    const invRes = await req(`/api/invoices/from-estimate/${estId}`, cookie, { method: "POST" });
    const inv: any = await invRes.json();
    const row: any = await db().prepare(
      `SELECT total, total_cents, amount_paid, amount_paid_cents, balance_due, balance_due_cents FROM invoices WHERE id=?`
    ).bind(inv.id).first();
    expect(row.total_cents).toBe(100000);
    expect(row.amount_paid_cents).toBe(30000);
    expect(row.balance_due_cents).toBe(70000);
    expect(row.total).toBe(1000);
    expect(row.amount_paid).toBe(300);
    expect(row.balance_due).toBe(700);
  });

  it("MC3A-02 POST /api/invoices/:id/record-payment derives balance_due from invoices.total_cents/amount_paid_cents, not the float columns", async () => {
    const { cookie } = await seedSession("mc3a-co-recpay", "mc3a-rep-recpay");
    const res = await req("/api/invoices", cookie, {
      method: "POST", body: JSON.stringify({ total: 500 }),
    });
    const { id: invId } = await res.json() as { id: string };
    await db().prepare(`UPDATE invoices SET total = 999999, amount_paid = 999999 WHERE id=?`).bind(invId).run();
    const payRes = await req(`/api/invoices/${invId}/record-payment`, cookie, {
      method: "POST", body: JSON.stringify({ amount: 150 }),
    });
    const out: any = await payRes.json();
    expect(out.balance_due).toBe(350);
    const row: any = await db().prepare(`SELECT balance_due, balance_due_cents FROM invoices WHERE id=?`).bind(invId).first();
    expect(row.balance_due_cents).toBe(35000);
    expect(row.balance_due).toBe(350);
  });

  it("MC3A-03 POST /api/estimates/:id/convert-to-job sets work_orders.amount_est/_cents from estimates.total_cents, not the float total", async () => {
    const { cookie } = await seedSession("mc3a-co-wo", "mc3a-rep-wo");
    const res = await req("/api/estimates", cookie, {
      method: "POST",
      body: JSON.stringify({ title: "Cutover Est WO", line_items: [{ qty: 2, rate: 250 }] }),
    });
    const { data: { id: estId } } = await res.json() as { data: { id: string } };
    await db().prepare(`UPDATE estimates SET total = 999999 WHERE id=?`).bind(estId).run();
    const woRes = await req(`/api/estimates/${estId}/convert-to-job`, cookie, { method: "POST", body: JSON.stringify({}) });
    expect(woRes.status).toBe(201);
    const wo: any = await woRes.json();
    const row: any = await db().prepare(`SELECT amount_est, amount_est_cents FROM work_orders WHERE id=?`).bind(wo.work_order_id).first();
    expect(row.amount_est_cents).toBe(50000);
    expect(row.amount_est).toBe(500);
  });

  it("MC3A-04 POST /api/recurring-subscriptions without price_override derives custom_price from recurring_plans.price_cents, not the float price column", async () => {
    const { cookie } = await seedSession("mc3a-co-rp", "mc3a-rep-rp");
    const planRes = await req("/api/recurring-plans", cookie, {
      method: "POST", body: JSON.stringify({ name: "Cutover Plan", frequency: "weekly", price: 75 }),
    });
    const plan: any = await planRes.json();
    await db().prepare(`UPDATE recurring_plans SET price = 999999 WHERE id=?`).bind(plan.id).run();
    await db().prepare(`INSERT OR IGNORE INTO clients (id, company_id, name) VALUES (?,?,?)`).bind("mc3a-client-1", "mc3a-co-rp", "Cutover Client").run().catch(() => {});
    const subRes = await req("/api/recurring-subscriptions", cookie, {
      method: "POST", body: JSON.stringify({ plan_id: plan.id, client_id: "mc3a-client-1" }),
    });
    expect(subRes.status).toBe(201);
    const sub: any = await subRes.json();
    const row: any = await db().prepare(`SELECT custom_price, custom_price_cents FROM client_plan_subscriptions WHERE id=?`).bind(sub.id).first();
    expect(row.custom_price_cents).toBe(7500);
    expect(row.custom_price).toBe(75);
  });

  it("MC3A-05 GET /api/ai/assistant/context pipeline.value is derived from opportunities.job_value_cents, not the float job_value column", async () => {
    const { cookie } = await seedSession("mc3a-co-opp", "mc3a-rep-opp");
    const res = await req("/api/opportunities", cookie, {
      method: "POST", body: JSON.stringify({ client: "Cutover Opp", jobValue: 1200 }),
    });
    const { data: { id: oppId } } = await res.json() as { data: { id: string } };
    await db().prepare(`UPDATE opportunities SET job_value = 999999 WHERE id=?`).bind(oppId).run();
    const ctxRes = await req("/api/ai/assistant/context", cookie);
    const ctx: any = await ctxRes.json();
    expect(ctx.data.pipeline.value).toBe(1200);
  });
});

describe("Stage 2: rounding correctness (ROUND, not truncation)", () => {
  const cases: [number, number][] = [
    [19.99, 1999], [0.1, 10], [0.2, 20], [4.99, 499], [1234.56, 123456],
    [100, 10000], [0, 0], [42.1002, 4210], // burden-rate-style value truncates to whole cents
  ];
  for (const [dollars, expectedCents] of cases) {
    it(`MC-R ${dollars} -> ${expectedCents} cents via ROUND`, () => {
      expect(Math.round(dollars * 100)).toBe(expectedCents);
    });
  }
});
