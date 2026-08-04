# UI-MONEYLOOP

W4-moneyloop: "Money Loop depth 1+2 — runway hero, five verb tiles, verb lanes."
Depends on W3-rateapi, W3-actions. Files: `src/ui/money-loop.tsx`,
`src/ui/money-loop.e2e.ts`.

## Structure (two depths)
- **Depth 1 — runway hero.** A top-level summary, likely built from RECOVERY.md's
  `recovery_snapshot` (pct_recovered, projected_black_friday, confidence_days) —
  "runway" suggesting a time-to-target framing rather than a raw dollar figure.
- **Depth 1 — five verb tiles.** One tile per `action_item.verb`
  (collect/bill/pay/fix/decide, ACTIONS.md), each showing a count and/or total
  `amount_cents` of open actions for that verb.
- **Depth 2 — verb lanes.** Drilling into a tile opens a lane (kanban-style list) of
  the individual `action_item` rows for that verb, each showing `owner_id`,
  `sla_due`, `confidence`.

## Hard constraints (forbidden list)
- "rendering margin or wage for crew role" — this page must respect ROLES.md's
  crew-visibility rule even though it's action-oriented, not a rates page.
- "accounting vocabulary in simple mode" — every label on this page goes through
  DICTIONARY.md's simple/advanced toggle; "runway," "verb tiles" etc. are internal
  names, not necessarily the on-screen copy.

## Derivation confidence
**Confident:** the five-tile/verb-lane structure follows directly from ACTIONS.md's
five-verb constraint, which is explicit evidence. Both forbidden clauses are verbatim
from tasks.json.

**Inferred:** "runway hero" as a recovery-snapshot summary is my interpretation of an
unexplained task-title phrase — no other evidence names what the hero shows.
**Needs Tyler:** confirm what "runway" means here before W4-moneyloop's hero section
is built; the verb tiles/lanes rest on firmer ground (ACTIONS.md) than the hero does.
