export interface UnbilledCandidate {
  id: string; // work_item.id
  job_id: string;
  estimate_cents: number | null;
  completed_at: string;
}

export interface UnbilledFinding {
  work_item_id: string;
  job_id: string;
  amount_cents: number | null;
  confidence: "high" | "low";
}

/**
 * Pure function. No DB, no I/O. See docs/spec/UNBILLED.md.
 *
 * The actual join (completed work order with no receivable) no longer
 * crosses two databases (migrations/0057_finance_merge.sql, 2026-08-09) —
 * work_orders and invoices live in the same DB now — but the invoices-side
 * half of this join was never written (flagged in docs/spec/UNBILLED.md as
 * a real gap, not guessed at), so this engine still takes the join's result
 * as plain inputs: a list of already-completed work items, and the set of
 * ids already known to be billed. The caller is responsible for producing
 * `billedWorkItemIds`.
 *
 * Findings become action_item(verb='collect') rows — this function never
 * invoices anything itself (CLAUDE.md hard rule 1: propose, don't post).
 */
export function detectUnbilledWork(
  completedWorkItems: UnbilledCandidate[],
  billedWorkItemIds: ReadonlySet<string>,
): UnbilledFinding[] {
  return completedWorkItems
    .filter((w) => !billedWorkItemIds.has(w.id))
    .map((w) => ({
      work_item_id: w.id,
      job_id: w.job_id,
      amount_cents: w.estimate_cents,
      // A completed item with a known dollar amount is a stronger, more
      // actionable signal than one whose value is unknown.
      confidence: w.estimate_cents !== null ? "high" : "low",
    }));
}
