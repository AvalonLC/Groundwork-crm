# ACTIONS

W3-actions: "`action_item` + five-verb constraint + SLA clock." Depends on W1-schema.

## The five-verb constraint
Every AI finding or human task becomes an `action_item` with `verb` in exactly
`{collect, bill, pay, fix, decide}` (CLAUDE.md architecture invariant, restated
verbatim as a W3-actions forbidden clause: "any verb outside" this set). No sixth
verb, no free-text verb field — this is a closed enum enforced at the DB or
application layer. Rough intent per verb (inferred, not stated anywhere explicitly):
`collect` (get money in — unbilled work, AR), `bill` (invoice something), `pay`
(pay something out), `fix` (a data/config problem — e.g. a suspect rate flagged by
BH-04), `decide` (needs a human judgment call — e.g. an ambiguous classifier finding
under CLASSIFIER.md's materiality override).

## Required fields
`owner_id` and `sla_due` are both mandatory — forbidden: "an action without owner_id
or sla_due." Every `action_item` is assigned to someone with a clock running; there is
no unowned or open-ended action. `amount_cents` (nullable — not every action has a
dollar figure), `confidence`, `stale_components` per CLAUDE.md hard rule 4.

## Sources
`action_item` rows are produced by: the unbilled-work detector (E2-unbilled, likely
`verb=collect`), the classifier (CLASSIFIER.md, `W5-classifier`), receipt processing
gaps (RECEIPTS.md), and P&L ingest reclassification proposals (INGEST.md, likely
`verb=decide` since auto-approval is forbidden there). This table is the landing zone
the Work Queue UI (UI-QUEUE.md) reads from.

## Derivation confidence
**Confident:** the five-verb enum and the owner_id/sla_due requirement are both
verbatim from CLAUDE.md and tasks.json's forbidden list — not inferred.

**Inferred:** the mapping from specific verbs to specific upstream producers (e.g.
"unbilled work -> collect") — plausible but not stated anywhere; the schema doesn't
depend on getting this exactly right since verb is chosen per-finding at write time,
not hardcoded per producer. **Needs Tyler:** none blocking for W3-actions itself,
which only needs the table shape and the constraint, not the producer mapping.
