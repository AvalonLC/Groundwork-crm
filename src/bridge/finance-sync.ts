import { upsertWorkItem, getWorkItem, insertTimeEntry } from "../db/repos";
import { postTimeEntryToLedger } from "../api/posting";
import type { Cents, HoursHundredths } from "../db/schema";

/**
 * CRM (`DB`) -> Finance OS (`FINANCE_DB`) write-through connectors. These are
 * called from the CRM's own request handlers in src/index.tsx, not from
 * Finance OS engines — writes only ever flow this direction (CRM event ->
 * FINANCE_DB row), never the reverse, matching the propose-don't-post
 * boundary in CLAUDE.md. Every function here is best-effort: a Finance OS
 * write failure must never break the CRM request that triggered it.
 */

interface CrmWorkOrderRow {
  id: string;
  crew_id: string | null;
  opp_id: string | null;
  estimate_id: string | null;
  title: string;
  status: string;
}

/**
 * Mirrors a CRM work order into FINANCE_DB's work_item, keyed by the work
 * order's own id (work_item.id === work_item.job_id === CRM work_orders.id
 * — the same convention src/ui/job-costing.tsx's getWorkItem(..., jobId)
 * call already assumes).
 */
export async function syncWorkOrderToFinance(
  db: D1Database, financeDb: D1Database, companyId: string, woId: string,
): Promise<void> {
  try {
    const wo = await db.prepare(
      `SELECT id, crew_id, opp_id, estimate_id, title, status FROM work_orders WHERE id = ? AND company_id = ?`,
    ).bind(woId, companyId).first<CrmWorkOrderRow>();
    if (!wo) return;

    // Resolve the linked estimate: work_orders.estimate_id (rarely set by
    // today's create/update handlers) -> the reverse FK estimates.work_order_id
    // (set by the estimate->work-order conversion flow) -> the most recent
    // accepted estimate on the same opportunity -> none.
    let estimateTotal: number | null = null;
    if (wo.estimate_id) {
      const est = await db.prepare(`SELECT total FROM estimates WHERE id = ? AND company_id = ?`)
        .bind(wo.estimate_id, companyId).first<{ total: number }>();
      estimateTotal = est?.total ?? null;
    }
    if (estimateTotal === null) {
      const est = await db.prepare(
        `SELECT total FROM estimates WHERE work_order_id = ? AND company_id = ? ORDER BY created_at DESC LIMIT 1`,
      ).bind(woId, companyId).first<{ total: number }>();
      estimateTotal = est?.total ?? null;
    }
    if (estimateTotal === null && wo.opp_id) {
      const est = await db.prepare(
        `SELECT total FROM estimates WHERE opp_id = ? AND company_id = ? AND status = 'accepted' ORDER BY created_at DESC LIMIT 1`,
      ).bind(wo.opp_id, companyId).first<{ total: number }>();
      estimateTotal = est?.total ?? null;
    }

    const status: "open" | "complete" = wo.status === "completed" ? "complete" : "open";

    // Preserve the original completion timestamp across re-syncs instead of
    // resetting it to "now" every time an already-complete work order is
    // touched again (e.g. a note edit after completion).
    const existing = await getWorkItem(financeDb, companyId, wo.id);
    const completedAt = status === "complete"
      ? (existing?.status === "complete" ? existing.completed_at : new Date().toISOString())
      : null;

    await upsertWorkItem(financeDb, {
      id: wo.id,
      tenant_id: companyId,
      job_id: wo.id,
      description: wo.title || "",
      status,
      estimate_cents: estimateTotal !== null ? (Math.round(estimateTotal * 100) as Cents) : null,
      completed_at: completedAt,
    });
  } catch (e) {
    console.error("syncWorkOrderToFinance failed (non-blocking)", woId, e);
  }
}

interface CrmTimeEntryRow {
  id: string;
  clock_in: string;
  work_order_id: string | null;
}

/**
 * Mirrors a just-closed CRM time_entries row into FINANCE_DB's time_entry,
 * then immediately posts it (resolve rate -> job_cost_ledger). Only called
 * at clock-out, never clock-in: hours aren't known until then, and
 * time_entry.hours_hundredths is NOT NULL. General/non-job clock-ins (no
 * linked work order) are intentionally not synced at all.
 */
export async function syncTimeEntryToFinance(
  db: D1Database, financeDb: D1Database, companyId: string, repId: string,
  entry: CrmTimeEntryRow, durMin: number,
): Promise<void> {
  try {
    if (!entry.work_order_id) return;

    const wo = await db.prepare(`SELECT crew_id FROM work_orders WHERE id = ? AND company_id = ?`)
      .bind(entry.work_order_id, companyId).first<{ crew_id: string | null }>();
    if (!wo?.crew_id) return;

    // division is required by postTimeEntryToLedger and has no FINANCE_DB
    // source of its own (see src/api/posting.ts's docstring) — crews.division
    // is the only place it exists in the CRM. Without it, posting can never
    // succeed, so skip the write entirely rather than leave a permanently
    // unposted zombie time_entry row.
    const crew = await db.prepare(`SELECT division FROM crews WHERE id = ? AND company_id = ?`)
      .bind(wo.crew_id, companyId).first<{ division: string | null }>();
    if (!crew?.division) return;

    const workDate = entry.clock_in.slice(0, 10); // YYYY-MM-DD
    const hoursHundredths = Math.max(0, Math.round(durMin * 100 / 60)) as HoursHundredths;

    const timeEntryId = await insertTimeEntry(financeDb, {
      tenant_id: companyId,
      employee_id: repId,
      crew_id: wo.crew_id,
      job_id: entry.work_order_id,
      work_date: workDate,
      hours_hundredths: hoursHundredths,
      ot_hours_hundredths: 0 as HoursHundredths,
    });

    const result = await postTimeEntryToLedger(financeDb, companyId, timeEntryId, crew.division);
    if (!result.success) {
      // Expected when a tenant hasn't finished Finance OS setup (no rate
      // profile / no overhead allocation for this division yet) — an honest
      // gap, not a bug. Logged for visibility, not thrown.
      console.warn("syncTimeEntryToFinance: posting did not complete", entry.id, result.reason);
    }
  } catch (e) {
    console.error("syncTimeEntryToFinance failed (non-blocking)", entry.id, e);
  }
}

/**
 * Server-side counterpart to the manual "Payment Collected" checkbox
 * (public/js/app_premium.js's setOppField('collected', ...)). Called from
 * every CRM code path that transitions an invoice to status='paid', so
 * `collected` reflects a real payment event even if nobody ever checks the
 * box by hand. Does not touch commission_approved or any commission math —
 * that stays exactly as it is today (client-side, manual).
 */
export async function markOpportunityCollectedFromInvoice(
  db: D1Database, companyId: string, invoiceId: string, estimateIdHint?: string | null,
): Promise<void> {
  try {
    let estimateId = estimateIdHint ?? null;
    if (!estimateId) {
      const inv = await db.prepare(`SELECT estimate_id FROM invoices WHERE id = ? AND company_id = ?`)
        .bind(invoiceId, companyId).first<{ estimate_id: string | null }>();
      estimateId = inv?.estimate_id ?? null;
    }
    if (!estimateId) return; // not every invoice traces back to an estimate/opportunity

    const est = await db.prepare(`SELECT opp_id FROM estimates WHERE id = ? AND company_id = ?`)
      .bind(estimateId, companyId).first<{ opp_id: string | null }>();
    if (!est?.opp_id) return;

    await db.prepare(`UPDATE opportunities SET collected = 1 WHERE id = ? AND company_id = ?`)
      .bind(est.opp_id, companyId).run();
  } catch (e) {
    console.error("markOpportunityCollectedFromInvoice failed (non-blocking)", invoiceId, e);
  }
}
