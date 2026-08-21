import { detectUnbilledWork, type UnbilledCandidate, type UnbilledFinding } from "../engines/unbilled";
import {
  listCompletedUnbilledWorkItems, listBilledWorkOrderIds, getDefaultActionOwner,
  getOpenActionItemSourceIds, resolveActionItemsBySource, insertActionItem,
} from "../db/repos";
import type { Cents } from "../db/schema";

export interface UnbilledSweepResult {
  company_id: string;
  findings: UnbilledFinding[];
  /** action_item ids created this run — empty on dry_run or when every
   * finding already had an open item (see "already has an open item"
   * dedup below). */
  created_action_item_ids: string[];
  /** Findings that were skipped because the tenant has no active
   * admin/office_manager rep to own the resulting action_item — every
   * action_item requires a non-null owner_id (docs/spec/ACTIONS.md), so
   * rather than write a bad row this sweep skips and reports it instead. */
  skipped_no_owner: number;
}

/**
 * The missing half of E2-unbilled (docs/spec/UNBILLED.md, docs/PUNCHLIST.md
 * item 3): joins completed work orders against the CRM's own invoices via
 * listBilledWorkOrderIds (now possible in the same DB since
 * migrations/0057_finance_merge.sql), runs the pure detectUnbilledWork on
 * the result, and turns each finding into an action_item(verb='collect') —
 * skipping any work order that already has an OPEN collect item for it
 * (no duplicates), and auto-resolving any open collect item whose work
 * order has since been invoiced (so getting billed clears the queue entry,
 * not just prevents a new one). See
 * docs/FINANCE-OS-FIX-PLAN.md item 3 for the full fix writeup.
 *
 * dry_run: computes and returns findings/what-would-be-created, but issues
 * no writes at all (no action_item insert, no auto-resolve) — same
 * contract as runNightlyRollup's dry_run in src/api/cron-trigger.ts.
 */
export async function runUnbilledWorkDetection(
  db: D1Database, companyId: string, dryRun: boolean,
): Promise<UnbilledSweepResult> {
  const completed = await listCompletedUnbilledWorkItems(db, companyId);
  const billedIds = await listBilledWorkOrderIds(db, companyId);

  const candidates: UnbilledCandidate[] = completed.map((w) => ({
    id: w.id, job_id: w.id, estimate_cents: w.estimate_cents, completed_at: w.completed_at ?? "",
  }));
  const findings = detectUnbilledWork(candidates, billedIds);

  // Any work order that IS billed but still has an open 'collect' item from
  // a prior run gets that item resolved — a job getting invoiced should
  // clear its own queue entry, not leave a stale one sitting open forever.
  const openCollectSourceIds = await getOpenActionItemSourceIds(db, companyId, "work_order");
  const nowBilledWithOpenItem = completed
    .filter((w) => billedIds.has(w.id) && openCollectSourceIds.has(w.id))
    .map((w) => w.id);

  if (dryRun) {
    return { company_id: companyId, findings, created_action_item_ids: [], skipped_no_owner: 0 };
  }

  for (const workOrderId of nowBilledWithOpenItem) {
    await resolveActionItemsBySource(db, companyId, "work_order", workOrderId);
  }

  const createdIds: string[] = [];
  let skippedNoOwner = 0;
  const toCreate = findings.filter((f) => !openCollectSourceIds.has(f.work_item_id));
  if (toCreate.length > 0) {
    const ownerId = await getDefaultActionOwner(db, companyId);
    if (!ownerId) {
      skippedNoOwner = toCreate.length;
    } else {
      for (const finding of toCreate) {
        const id = `unbilled-${finding.work_item_id}-${crypto.randomUUID().slice(0, 8)}`;
        await insertActionItem(db, {
          id, company_id: companyId, verb: "collect", owner_id: ownerId,
          // A completed-but-uninvoiced job is a collections risk that gets
          // more urgent with time, not a fixed grace period — 3 days
          // matches the SLA already used for classifier/ingest 'decide'
          // items elsewhere in this codebase (src/ai/classify.ts,
          // src/ai/ingest.ts), kept consistent rather than invented fresh.
          sla_due: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
          amount_cents: finding.amount_cents !== null ? (finding.amount_cents as Cents) : null,
          confidence: finding.confidence,
          stale_components: JSON.stringify(["no invoice found for this completed job"]),
          source_type: "work_order", source_id: finding.work_item_id,
        });
        createdIds.push(id);
      }
    }
  }

  return { company_id: companyId, findings, created_action_item_ids: createdIds, skipped_no_owner: skippedNoOwner };
}
