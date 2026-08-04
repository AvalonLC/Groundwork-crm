# UI-QUEUE

W4-queue-ui: "Work Queue — SLA clocks, AI first-pass, confidence panel." Depends on
W3-actions. Files: `src/ui/queue.tsx`, `src/ui/queue.e2e.ts`.

## SLA clocks
Every `action_item` carries `sla_due` (ACTIONS.md, required field) — this page is a
worklist of open action items sorted/highlighted by how close each is to its SLA,
presumably with visual urgency (overdue vs approaching vs fresh).

## AI first-pass
Findings originating from the classifier (CLASSIFIER.md stage 1-4), receipts
(RECEIPTS.md), or ingest (INGEST.md) arrive here as an AI "first pass" — a proposed
`action_item` that a human confirms, edits, or dismisses. Never auto-resolved:
CLASSIFIER.md and INGEST.md both forbid auto-posting/auto-approving above
materiality or on model self-confidence alone, so this queue is where that human
step actually happens.

## Confidence panel
Surfaces the `confidence` and `stale_components` fields (CLAUDE.md hard rule 4: both
must render in the UI) per action item — likely a side panel showing why the AI
proposed this action and how confident it is, so the reviewer isn't confirming a
black box.

## Derivation confidence
**Confident:** SLA-clock display (from the required `sla_due` field) and the
confidence-panel requirement (verbatim CLAUDE.md hard rule) are both grounded.

**Inferred:** "AI first-pass" as specifically meaning classifier/receipts/ingest
findings landing here as proposals — reasonable given ACTIONS.md's "Sources" section,
but the exact UI treatment (inline edit vs separate confirm dialog) isn't specified.
**Needs Tyler:** none blocking; the data model is solid, only the interaction pattern
is a guess.
