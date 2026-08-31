import {
  getReceiptForPosting, receiptHasPostedLedgerLine, markReceiptPosted,
  postDirectCostLedgerLine,
} from "../db/repos";
import type { Cents, DirectCostCategory } from "../db/schema";

const toCents = (n: number): Cents => n as Cents;

export type ReceiptPostingResult =
  | { success: true; ledger_line_id: number }
  | {
      success: false;
      reason:
        | "not_found" // receipt doesn't exist for this tenant
        | "not_approved" // receipt.status !== 'approved'
        | "already_posted" // posted_at already set, or a matching ledger line already exists
        | "no_job_assigned" // receipt.job_id is null
        | "job_not_in_tenant" // job_id doesn't resolve to a work_order in this company
        | "no_cost_category" // cost_category not set (approver hasn't classified it yet)
        | "no_amount" // amount_cents is null — nothing to post
        | "no_division"; // the job's crew has no division set (division is required on job_cost_ledger, same gap postTimeEntryToLedger already handles)
    };

/**
 * PR C's authorized posting route, mirroring src/api/posting.ts's
 * postTimeEntryToLedger step-for-step (retrieve -> verify -> post
 * write-once -> ledger line), but for a single approved, human-classified
 * receipt instead of a time entry. Runs the mandate's exact 10-step order:
 *
 *  1. Retrieve the pending (approved-but-unposted) receipt.
 *  2. (Tenant/user permission check is the CALLER's job — see
 *     src/ui/documents.tsx's canSee(role, "can_manage_receipts") gate,
 *     same permission that already gates approve/reject. This function
 *     assumes that check already passed.)
 *  3. Confirm the job belongs to this tenant (job_not_in_tenant).
 *  4. Confirm category/amount/date/progress treatment are all set
 *     (no_cost_category / no_amount; date is already required by the
 *     Receipt row itself; progress_eligible always has a value, defaulting
 *     to 1).
 *  5. Prevent duplicate posting (receiptHasPostedLedgerLine, belt-and-
 *     suspenders on top of the posted_at write-once guard).
 *  6/7. Mark the receipt posted FIRST via markReceiptPosted's own
 *     `WHERE posted_at IS NULL` write-once guard, THEN create the ledger
 *     entry only if that guard actually won the race — mirroring
 *     src/api/posting.ts's postTimeEntryToLedger (postTimeEntry() first,
 *     ledger lines only if it returns true). This order matters: the
 *     previous implementation ran an *unconditional* ledger INSERT
 *     together with the guarded UPDATE inside one db.batch(), which meant
 *     a losing concurrent request's INSERT could still land before its
 *     own UPDATE was rejected by the guard — under real concurrency this
 *     produced more than one ledger row for a single receipt (caught via
 *     PC-11's "exactly one ledger posting" assertion failing intermittently
 *     in CI, root-caused during Finance OS Phase 6). Guarding the write
 *     that actually decides "did I win the race" BEFORE the write that has
 *     no guard of its own removes the gap entirely — a losing request now
 *     never reaches the ledger INSERT at all.
 *  8. Preserve the source attachment — untouched; r2_key/content_hash are
 *     never modified by this function.
 *  9. Record approving user + timestamps — the caller passes `postedBy`,
 *     which becomes job_cost_ledger's audit trail via... (see note below;
 *     job_cost_ledger has no explicit posted_by column, so this is
 *     surfaced via the ledger line's posted_at timestamp plus the
 *     receipt's own row, which already records who approved it upstream
 *     in documents.tsx — see "Known gap" below).
 * 10. Return a safe conflict response when already posted (the
 *     "already_posted" reason, not an error/exception).
 *
 * Known gap (documented, not silently swept under the rug): job_cost_ledger
 * has no posted_by column of its own (migration 0085 didn't add one — only
 * change_orders and job_budget_versions carry approved_by). The audit trail
 * for "who posted this receipt" therefore lives on the CALLER's audit log /
 * the receipt's own history, not on the ledger line itself. This function
 * accepts `postedBy` and returns it unused in the result on purpose, so a
 * caller wiring this into a route can still write its own audit record
 * (e.g. an action_item or a future job_cost_ledger.posted_by column) without
 * this function silently pretending the ledger row already carries it.
 */
export async function postApprovedReceiptToLedger(
  db: D1Database, companyId: string, receiptId: string, division: string,
  _postedBy: string,
): Promise<ReceiptPostingResult> {
  // Step 1: retrieve.
  const receipt = await getReceiptForPosting(db, companyId, receiptId);
  if (!receipt) return { success: false, reason: "not_found" };

  // Step 2 (permission check) is the caller's responsibility — not
  // re-verified here since this function has no concept of "role".

  if (receipt.status !== "approved") return { success: false, reason: "not_approved" };
  if (receipt.posted_at) return { success: false, reason: "already_posted" };

  // Step 3: confirm the job belongs to this tenant.
  if (!receipt.job_id) return { success: false, reason: "no_job_assigned" };
  const job = await db.prepare(`SELECT id FROM work_orders WHERE id = ? AND company_id = ?`)
    .bind(receipt.job_id, companyId).first<{ id: string }>();
  if (!job) return { success: false, reason: "job_not_in_tenant" };

  // Step 4: confirm category/amount/progress treatment.
  if (receipt.cost_category === null) return { success: false, reason: "no_cost_category" };
  if (receipt.amount_cents === null) return { success: false, reason: "no_amount" };
  if (!division) return { success: false, reason: "no_division" };

  // Step 5: prevent duplicate posting (belt-and-suspenders on top of the
  // posted_at write-once guard applied in the same batch below).
  const alreadyHasLine = await receiptHasPostedLedgerLine(db, companyId, receiptId);
  if (alreadyHasLine) return { success: false, reason: "already_posted" };

  const costCategory: DirectCostCategory = receipt.cost_category;

  // Step 6: write-once guard FIRST — mirrors postTimeEntryToLedger's own
  // "guard, then ledger lines only if the guard won" order exactly. If a
  // concurrent request already posted this receipt between our read
  // (step 5) and this write, markReceiptPosted's `WHERE posted_at IS NULL`
  // returns false and we return a safe conflict WITHOUT ever reaching the
  // ledger INSERT below — the losing request never touches job_cost_ledger
  // at all, so no duplicate row can be created.
  const wonRace = await markReceiptPosted(db, companyId, receiptId);
  if (!wonRace) {
    // Step 10: return a safe conflict response, not an error.
    return { success: false, reason: "already_posted" };
  }

  // Step 7: create the ledger entry — only the single request that won the
  // guard above ever reaches this line.
  const ledgerLineId = await postDirectCostLedgerLine(db, {
    company_id: companyId,
    job_id: receipt.job_id,
    cost_category: costCategory,
    amount_cents: toCents(receipt.amount_cents),
    division,
    progress_eligible: receipt.progress_eligible,
    change_order_id: null,
    source_receipt_id: receipt.id,
  });

  // Step 8: source attachment (r2_key/content_hash) is never touched above.

  return { success: true, ledger_line_id: ledgerLineId };
}
