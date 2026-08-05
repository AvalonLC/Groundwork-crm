# UNBILLED

E2-unbilled: "Unbilled-work detector — completed `work_items` with no receivable."
Depends on W1-schema. Note: unlike most wave-2 engines, this task has no `spec_ref`
in tasks.json and no dedicated fixture key — it isn't gated by
`check-derived-specs.js`, so treat this file as guidance rather than a binding
contract the way BH-TESTS.md or ALLOCATION.md are.

## What it detects
Scans `work_item` rows (SCHEMA.md) marked complete with no corresponding receivable
in the CRM's existing billing/invoicing data. This is a join across the Finance OS
`FINANCE_DB` and the CRM's `DB` — the only place in the Finance OS design that reads
from the existing production database rather than only `FINANCE_DB`. CLAUDE.md's
"No write path to QuickBooks" rule (hard rule 1) applies by analogy here too: this
detector proposes, it does not invoice — findings become `action_item` rows
(`verb=collect`, per ACTIONS.md's inferred mapping) for a human to act on, never an
automatic invoice.

## Output
A `classification_finding` or direct `action_item` per detected gap, carrying the
`work_item_id`, `amount_cents` (from the work item's estimated/quoted value, not
invented), and `confidence` — a work item flagged "complete" with high confidence but
no receivable is a stronger signal than one where completion itself is uncertain.

## Derivation confidence
**Confident:** the general shape (completed work_item, no receivable, becomes an
action_item, never auto-invoiced) follows directly from the task title plus CLAUDE.md's
propose-don't-write rule.

**Needs Tyler:** how "no receivable" is actually determined against the existing CRM
schema — this task is the one place Finance OS must read the CRM's `DB` binding, and
I don't have visibility into which existing CRM tables represent invoices/receivables
to join against. This is a real gap, not a stylistic one — worth resolving with a
quick look at the CRM's schema before E2-unbilled starts.
