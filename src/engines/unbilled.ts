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
 * The actual join (completed work_item with no receivable) crosses two
 * databases — FINANCE_DB's work_item and the CRM's own DB for
 * invoices/receivables, whose exact schema wasn't available as evidence
 * (flagged in docs/spec/UNBILLED.md as a real gap, not guessed at). This
 * engine takes the join's result as plain inputs instead: a list of
 * already-completed work items, and the set of work_item ids already known
 * to be billed. The caller (a later wave, once the CRM-side query is
 * written) is responsible for producing `billedWorkItemIds`.
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
