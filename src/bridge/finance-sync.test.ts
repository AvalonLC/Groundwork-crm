import { describe, it, expect, vi } from "vitest";
import {
  syncWorkOrderToFinance, syncTimeEntryToFinance, markOpportunityCollectedFromInvoice,
} from "./finance-sync";

/**
 * These three functions bridge the CRM's `DB` and Finance OS's `FINANCE_DB`
 * — two different D1 instances, only one of which (FINANCE_DB) has its
 * schema loaded in this project's vitest harness (test/apply-finance-
 * migrations.ts). A hand-rolled fake stands in for both here so the
 * branching logic (estimate-tier resolution, the division/work-order guard
 * clauses, the collected-flag chain) is covered without needing the full
 * CRM schema. The end-to-end path — a real work order producing a real
 * work_item, a real clock-out producing real job_cost_ledger lines — is
 * proven separately against local D1 (see the plan's verification section),
 * the same way src/api/posting.test.ts proves postTimeEntryToLedger against
 * real Miniflare D1 rather than a mock.
 */

interface Handler {
  match: RegExp;
  first?: (args: unknown[]) => unknown;
  run?: (args: unknown[]) => unknown;
}

class FakeStatement {
  private args: unknown[] = [];
  constructor(private sql: string, private db: FakeD1) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>(): Promise<T | null> {
    this.db.calls.push(this.sql);
    for (const h of this.db.handlers) if (h.match.test(this.sql) && h.first) return h.first(this.args) as T;
    return null;
  }
  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    this.db.calls.push(this.sql);
    for (const h of this.db.handlers) if (h.match.test(this.sql) && h.run) return h.run(this.args) as never;
    return { success: true, meta: { changes: 1, last_row_id: 1 } };
  }
}

class FakeD1 {
  calls: string[] = [];
  constructor(public handlers: Handler[]) {}
  prepare(sql: string) { return new FakeStatement(sql, this); }
}

describe("syncWorkOrderToFinance — estimate resolution tiers", () => {
  it("FS-01 uses work_orders.estimate_id when set (tier 1)", async () => {
    const db = new FakeD1([
      { match: /FROM work_orders WHERE id/, first: () => ({ id: "wo-1", crew_id: null, opp_id: "opp-1", estimate_id: "est-tier1", title: "Job A", status: "scheduled" }) },
      { match: /FROM estimates WHERE id/, first: () => ({ total: 1500 }) },
    ]);
    const financeDb = new FakeD1([
      { match: /FROM work_item WHERE/, first: () => null },
    ]);
    let upserted: any = null;
    financeDb.handlers.push({ match: /INSERT INTO work_item/, run: (args) => { upserted = args; return { success: true, meta: { changes: 1, last_row_id: 1 } }; } });

    await syncWorkOrderToFinance(db as never, financeDb as never, "co-1", "wo-1");
    expect(upserted[5]).toBe(150000); // 1500 dollars -> 150000 cents
  });

  it("FS-02 falls back to estimates.work_order_id (tier 2) when estimate_id is unset", async () => {
    const db = new FakeD1([
      { match: /FROM work_orders WHERE id/, first: () => ({ id: "wo-2", crew_id: null, opp_id: null, estimate_id: null, title: "Job B", status: "scheduled" }) },
      { match: /FROM estimates WHERE work_order_id/, first: () => ({ total: 200 }) },
    ]);
    const financeDb = new FakeD1([{ match: /FROM work_item WHERE/, first: () => null }]);
    let upserted: any = null;
    financeDb.handlers.push({ match: /INSERT INTO work_item/, run: (args) => { upserted = args; return { success: true, meta: { changes: 1, last_row_id: 1 } }; } });

    await syncWorkOrderToFinance(db as never, financeDb as never, "co-1", "wo-2");
    expect(upserted[5]).toBe(20000);
  });

  it("FS-03 falls back to the most recent accepted estimate on the opportunity (tier 3)", async () => {
    const db = new FakeD1([
      { match: /FROM work_orders WHERE id/, first: () => ({ id: "wo-3", crew_id: null, opp_id: "opp-3", estimate_id: null, title: "Job C", status: "scheduled" }) },
      { match: /FROM estimates WHERE work_order_id/, first: () => null },
      { match: /FROM estimates WHERE opp_id/, first: () => ({ total: 75 }) },
    ]);
    const financeDb = new FakeD1([{ match: /FROM work_item WHERE/, first: () => null }]);
    let upserted: any = null;
    financeDb.handlers.push({ match: /INSERT INTO work_item/, run: (args) => { upserted = args; return { success: true, meta: { changes: 1, last_row_id: 1 } }; } });

    await syncWorkOrderToFinance(db as never, financeDb as never, "co-1", "wo-3");
    expect(upserted[5]).toBe(7500);
  });

  it("FS-04 estimate_cents is null when no estimate resolves at any tier", async () => {
    const db = new FakeD1([
      { match: /FROM work_orders WHERE id/, first: () => ({ id: "wo-4", crew_id: null, opp_id: null, estimate_id: null, title: "Job D", status: "scheduled" }) },
      { match: /FROM estimates WHERE work_order_id/, first: () => null },
    ]);
    const financeDb = new FakeD1([{ match: /FROM work_item WHERE/, first: () => null }]);
    let upserted: any = null;
    financeDb.handlers.push({ match: /INSERT INTO work_item/, run: (args) => { upserted = args; return { success: true, meta: { changes: 1, last_row_id: 1 } }; } });

    await syncWorkOrderToFinance(db as never, financeDb as never, "co-1", "wo-4");
    expect(upserted[5]).toBeNull();
  });

  it("FS-05 maps CRM status 'completed' to FINANCE_DB 'complete', anything else to 'open'", async () => {
    const db = new FakeD1([
      { match: /FROM work_orders WHERE id/, first: () => ({ id: "wo-5", crew_id: null, opp_id: null, estimate_id: null, title: "Job E", status: "completed" }) },
      { match: /FROM estimates WHERE work_order_id/, first: () => null },
    ]);
    const financeDb = new FakeD1([{ match: /FROM work_item WHERE/, first: () => null }]);
    let upserted: any = null;
    financeDb.handlers.push({ match: /INSERT INTO work_item/, run: (args) => { upserted = args; return { success: true, meta: { changes: 1, last_row_id: 1 } }; } });

    await syncWorkOrderToFinance(db as never, financeDb as never, "co-1", "wo-5");
    expect(upserted[4]).toBe("complete");
    expect(upserted[6]).not.toBeNull(); // completed_at set
  });

  it("FS-06 no-ops (does not throw) when the work order doesn't exist", async () => {
    const db = new FakeD1([{ match: /FROM work_orders WHERE id/, first: () => null }]);
    const financeDb = new FakeD1([]);
    await expect(syncWorkOrderToFinance(db as never, financeDb as never, "co-1", "missing")).resolves.toBeUndefined();
    expect(financeDb.calls.length).toBe(0);
  });
});

describe("syncTimeEntryToFinance — guard clauses", () => {
  it("FS-07 skips entirely when the time entry has no linked work order", async () => {
    const db = new FakeD1([]);
    const financeDb = new FakeD1([]);
    await syncTimeEntryToFinance(db as never, financeDb as never, "co-1", "rep-1", { id: "te-1", clock_in: "2026-08-01T09:00:00Z", work_order_id: null }, 90);
    expect(db.calls.length).toBe(0);
    expect(financeDb.calls.length).toBe(0);
  });

  it("FS-08 skips when the linked work order has no crew", async () => {
    const db = new FakeD1([{ match: /FROM work_orders WHERE id/, first: () => ({ crew_id: null }) }]);
    const financeDb = new FakeD1([]);
    await syncTimeEntryToFinance(db as never, financeDb as never, "co-1", "rep-1", { id: "te-2", clock_in: "2026-08-01T09:00:00Z", work_order_id: "wo-1" }, 90);
    expect(financeDb.calls.length).toBe(0);
  });

  it("FS-09 skips when the crew has no division set", async () => {
    const db = new FakeD1([
      { match: /FROM work_orders WHERE id/, first: () => ({ crew_id: "crew-1" }) },
      { match: /FROM crews WHERE id/, first: () => ({ division: null }) },
    ]);
    const financeDb = new FakeD1([]);
    await syncTimeEntryToFinance(db as never, financeDb as never, "co-1", "rep-1", { id: "te-3", clock_in: "2026-08-01T09:00:00Z", work_order_id: "wo-1" }, 90);
    expect(financeDb.calls.length).toBe(0);
  });
});

describe("markOpportunityCollectedFromInvoice", () => {
  it("FS-10 no-ops when the invoice has no linked estimate", async () => {
    const db = new FakeD1([{ match: /FROM invoices WHERE id/, first: () => ({ estimate_id: null }) }]);
    await markOpportunityCollectedFromInvoice(db as never, "co-1", "inv-1");
    expect(db.calls.some((c) => /UPDATE opportunities/.test(c))).toBe(false);
  });

  it("FS-11 no-ops when the estimate has no linked opportunity", async () => {
    const db = new FakeD1([
      { match: /FROM invoices WHERE id/, first: () => ({ estimate_id: "est-1" }) },
      { match: /FROM estimates WHERE id/, first: () => ({ opp_id: null }) },
    ]);
    await markOpportunityCollectedFromInvoice(db as never, "co-1", "inv-1");
    expect(db.calls.some((c) => /UPDATE opportunities/.test(c))).toBe(false);
  });

  it("FS-12 sets collected=1 when the full chain resolves", async () => {
    let updateArgs: unknown[] = [];
    const db = new FakeD1([
      { match: /FROM invoices WHERE id/, first: () => ({ estimate_id: "est-1" }) },
      { match: /FROM estimates WHERE id/, first: () => ({ opp_id: "opp-1" }) },
      { match: /UPDATE opportunities/, run: (args) => { updateArgs = args; return { success: true, meta: { changes: 1, last_row_id: 0 } }; } },
    ]);
    await markOpportunityCollectedFromInvoice(db as never, "co-1", "inv-1");
    expect(updateArgs).toEqual(["opp-1", "co-1"]);
  });

  it("FS-13 an estimateIdHint skips the invoices lookup entirely", async () => {
    const db = new FakeD1([
      { match: /FROM invoices WHERE id/, first: () => { throw new Error("should not be called"); } },
      { match: /FROM estimates WHERE id/, first: () => ({ opp_id: "opp-9" }) },
      { match: /UPDATE opportunities/, run: () => ({ success: true, meta: { changes: 1, last_row_id: 0 } }) },
    ]);
    await expect(markOpportunityCollectedFromInvoice(db as never, "co-1", "inv-9", "est-hint")).resolves.toBeUndefined();
  });
});
