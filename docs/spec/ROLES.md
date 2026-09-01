# ROLES

W4-roles: "Four role templates + simple/advanced vocabulary toggle." Depends on
W3-rateapi. Files: `src/ui/roles.ts`, `src/ui/vocabulary.ts`, `docs/dictionary.json`
(see DICTIONARY.md). `gate_must_include`: `crew-cannot-see-margin`.

## Four roles (named by inference — see confidence section)
CLAUDE.md's UI invariants explicitly name one: **crew** — "never render margin, wage,
or rate fields." The other three aren't named anywhere in evidence. Given the
engines built in earlier waves (burden/equipment rates, overhead allocation, job
costing, AI classification/receipts/ingest), a plausible four-role split, ranked most
to least restrictive:
1. **crew** — field workers. Zero financial visibility: no margin, wage, or rate
   fields, ever (hard constraint, tested by `crew-cannot-see-margin`).
2. **crew-lead / dispatcher** — sees job assignments and hours but not necessarily
   full margin detail.
3. **office / bookkeeping** — the role RECEIPTS.md and INGEST.md route corrections
   and reclassification proposals to; sees rates, receipts, classifier findings.
4. **owner / admin** — full visibility: budget & rates (UI-BUDGET.md), recovery
   (UI-RECOVERY.md), all job costing.

## Vocabulary toggle
Two vocabularies, one dataset, per-user toggle (CLAUDE.md UI invariant). **Simple
mode is DEFAULT** and contains zero accounting words — see DICTIONARY.md for the
term mapping. This is a display-layer toggle only; the underlying data/API responses
are identical regardless of vocabulary mode, only labels/copy change.

## Derived-value rule
"If a value can be derived, never add an input for it" (CLAUDE.md UI invariant) —
applies across every UI spec in this set: e.g. `required_bill_rate` (ALLOCATION.md)
is always computed, never a manually-entered field.

## Derivation confidence
**Confident:** the crew role's zero-financial-visibility rule and the vocabulary
toggle's simple-mode-default rule are both verbatim from CLAUDE.md.

**Needs Tyler:** the other three role names and their exact permission boundaries are
entirely inferred from context (the engines built, and RECEIPTS.md/INGEST.md's
mention of "bookkeeping-capable roles") — nothing in evidence names them. This is the
single biggest guess in the whole Wave 0 spec set and should be confirmed before
W4-roles starts, since it defines a gate (`crew-cannot-see-margin`) that other UI
tasks depend on indirectly.

**Resolved by implementation:** `src/ui/roles.ts`, `src/ui/vocabulary.ts`,
`src/ui/roles.e2e.ts`, and `docs/dictionary.json` (W4-roles' exact `files_owned`) have
shipped, and `roles.e2e.ts` contains a `crew-cannot-see-margin` test suite matching
the gate above. The four roles landed exactly as guessed —
`export type Role = "crew" | "crew_lead" | "office" | "owner"` — with
`ROLE_PERMISSIONS` matching this doc's ranked split: `crew_lead` currently has
identical (zero) financial visibility to `crew` per the doc's own hedge ("not
necessarily full margin detail"); `office` sees margin/wage/rate/recovery and can
manage receipts and change orders but not budget-rates or approvals; `owner` has
every permission including `can_see_budget_rates` and `can_approve_change_orders`.
Two permissions not enumerated in this doc's original four bullets
(`can_manage_change_orders`, `can_approve_change_orders`, added for Item 4 Stage 2 PR
D) were assigned following the same inferred-boundary precedent documented in
`roles.ts`'s own comments, not a fresh confirmation from Tyler — the underlying "not
formally confirmed" status of the office/owner split carries forward even though the
code now exists.
