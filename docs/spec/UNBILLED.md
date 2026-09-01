# UNBILLED

E2-unbilled: "Unbilled-work detector — completed `work_items` with no receivable."
Depends on W1-schema. Note: unlike most wave-2 engines, this task has no `spec_ref`
in tasks.json and no dedicated fixture key — it isn't gated by
`check-derived-specs.js`, so treat this file as guidance rather than a binding
contract the way BH-TESTS.md or ALLOCATION.md are.

## What it detects
Scans completed work with no corresponding receivable in the CRM's existing
billing/invoicing data. **As originally designed** (below), this was a join
across the Finance OS `FINANCE_DB` and the CRM's `DB` — the only place in the
Finance OS design that would read from the existing production database
rather than only `FINANCE_DB`. **That framing is superseded**: per
`migrations/0057_finance_merge.sql` (2026-08-09, see SCHEMA.md's "Update"
note), there is no separate `FINANCE_DB`/`work_item` anymore — both this
detector and the data it scans live in the one merged `DB`, reading
`work_orders` directly (see "RESOLVED" below for the actual implementation).
CLAUDE.md's "No write path to QuickBooks" rule (hard rule 1) applies by
analogy here too: this detector proposes, it does not invoice — findings
become `action_item` rows (`verb=collect`, per ACTIONS.md's inferred mapping)
for a human to act on, never an automatic invoice.

## Output
A `classification_finding` or direct `action_item` per detected gap, carrying the
`work_item_id`, `amount_cents` (from the work item's estimated/quoted value, not
invented), and `confidence` — a work item flagged "complete" with high confidence but
no receivable is a stronger signal than one where completion itself is uncertain.

## Derivation confidence
**Confident:** the general shape (completed work_item, no receivable, becomes an
action_item, never auto-invoiced) follows directly from the task title plus CLAUDE.md's
propose-don't-write rule.

**RESOLVED (2026-08-21):** the "no receivable" join is implemented. Since
`migrations/0057_finance_merge.sql` merged Finance OS and CRM tables into one D1
database, `src/db/repos.ts`'s `listBilledWorkOrderIds()` determines "has a receivable"
by checking whether a `work_orders` row is reachable from any `invoices` row through
any of three paths (the same three `syncWorkOrderFinanceColumns` already walks in
`src/index.tsx`, since `work_orders.estimate_id` is rarely set directly):

1. `work_orders.estimate_id -> estimates.id -> invoices.estimate_id`
2. `work_orders.id -> estimates.work_order_id -> invoices.estimate_id` (reverse FK)
3. `work_orders.opp_id -> estimates.opp_id -> invoices.estimate_id` (shared opportunity)

A work order counts as "billed" if any invoice (any status, including draft) is
reachable by any of the three paths — this intentionally does not require the invoice
to be paid or sent, only that billing has been initiated, matching the detector's
purpose of surfacing forgotten billing, not collections.

`src/cron/unbilled-sweep.ts`'s `runUnbilledWorkDetection()` wires this into the
existing nightly rollup (`src/api/cron-trigger.ts`'s `POST /rollup`): it pairs
`listCompletedUnbilledWorkItems()` (completed work orders) against
`listBilledWorkOrderIds()` (billed work orders), runs the existing pure
`detectUnbilledWork()` from `src/engines/unbilled.ts` against the difference, and for
each finding creates an `action_item(verb='collect', source_type='work_order',
source_id=work_item_id, ...)` — skipping any work order that already has an open item
for it (dedup via `getOpenActionItemSourceIds`), and auto-resolving any previously
open item whose work order has since been billed (`resolveActionItemsBySource`).
`dry_run` computes findings but performs no writes. Default action owner is the first
active `admin`/`office_manager` rep for the tenant (`getDefaultActionOwner`, same
selection query as `POST /api/admin/impersonate`); if none exists the findings are
still returned but no action_item is written (`skipped_no_owner`).

Tests: `src/cron/unbilled-sweep.test.ts` (US-01 through US-06) cover creation,
already-invoiced exclusion, dedup on repeat runs, auto-resolve when billed after the
fact, `dry_run` no-write behavior, and exclusion of not-yet-completed work orders.
