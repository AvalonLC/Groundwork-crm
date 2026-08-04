import {
  getTimeEntry, postTimeEntry, postJobCostLedgerLines, getLatestOverheadAllocationForDivision,
} from "../db/repos";
import { resolveLaborRate } from "./rates";
import type { Cents } from "../db/schema";

const toCents = (n: number): Cents => n as Cents;

export type PostingResult =
  | { success: true; resolved_rate: number; labor_cents: number; overhead_cents: number }
  | { success: false; reason: "not_found" | "already_posted" | "no_rate_resolves" | "no_overhead_allocation" };

/**
 * See docs/spec/POSTING.md. Writes resolved_rate/applied_overhead exactly
 * once (the postTimeEntry() WHERE posted_at IS NULL guard makes this
 * immutable — see the "immutability" test in posting.test.ts) and posts the
 * two-line ledger (labor + overhead) atomically. There is deliberately no
 * function anywhere in this file that updates an already-posted entry or its
 * ledger lines — retroactive recost has no code path to call (forbidden:
 * "retroactive recost without an explicit job").
 *
 * `division` is supplied by the caller (looked up from the job in the CRM's
 * own database — Finance OS doesn't have a job/division mapping of its own;
 * see docs/spec/UNBILLED.md for the same cross-database pattern).
 */
export async function postTimeEntryToLedger(
  db: D1Database, tenantId: string, timeEntryId: number, division: string,
): Promise<PostingResult> {
  const entry = await getTimeEntry(db, tenantId, timeEntryId);
  if (!entry) return { success: false, reason: "not_found" };
  if (entry.posted_at) return { success: false, reason: "already_posted" };

  const resolved = await resolveLaborRate(db, {
    tenant_id: tenantId, employee_id: entry.employee_id, work_date: entry.work_date,
    crew_id: entry.crew_id ?? undefined,
  });
  if (!resolved) return { success: false, reason: "no_rate_resolves" };

  const allocation = await getLatestOverheadAllocationForDivision(db, tenantId, division, entry.work_date);
  if (!allocation) return { success: false, reason: "no_overhead_allocation" };

  const hours = entry.hours_hundredths / 100;
  const rateDollarsPerHr = resolved.resolved_rate / 10000;
  const overheadDollarsPerHr = allocation.overhead_rate / 10000;
  const laborCents = Math.round(hours * rateDollarsPerHr * 100);
  const overheadCents = Math.round(hours * overheadDollarsPerHr * 100);

  // Write-once guard: if another call already posted this entry between our
  // read and this write, postTimeEntry returns false and we do NOT write
  // ledger lines — never two sets of ledger lines for one time_entry.
  const wrote = await postTimeEntry(db, tenantId, timeEntryId, resolved.resolved_rate, resolved.confidence, overheadCents);
  if (!wrote) return { success: false, reason: "already_posted" };

  await postJobCostLedgerLines(
    db,
    { tenant_id: tenantId, time_entry_id: timeEntryId, job_id: entry.job_id, amount_cents: toCents(laborCents), division },
    { tenant_id: tenantId, time_entry_id: timeEntryId, job_id: entry.job_id, amount_cents: toCents(overheadCents), division },
  );

  return { success: true, resolved_rate: resolved.resolved_rate, labor_cents: laborCents, overhead_cents: overheadCents };
}
