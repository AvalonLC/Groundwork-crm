# DICTIONARY

Spec for `docs/dictionary.json` (owned by W4-roles). Note: like UNBILLED.md, this
file has no `spec_ref` in tasks.json and isn't gated by `check-derived-specs.js` —
treat it as a starting proposal, not a locked contract.

## Rule
Simple mode is DEFAULT and contains **zero accounting words** (CLAUDE.md UI
invariant). Advanced mode uses the real accounting terms this whole build is built
on. Same data, different labels — the toggle never changes which numbers are shown,
only what they're called.

## Proposed mapping (advanced -> simple)
| Advanced (accounting) | Simple (plain language) |
|---|---|
| burdened rate | true hourly cost |
| burden multiplier | cost markup |
| overhead absorption / recovery | overhead caught up |
| absorbed cost | full cost per hour |
| required bill rate | what to charge |
| margin | profit |
| overhead pool | shared costs |
| allocation driver | how costs are split |
| classification finding | needs a look |
| materiality threshold | worth reviewing |
| resolved_rate | your rate |
| action_item (verb=decide) | needs your decision |
| action_item (verb=collect) | money to collect |
| action_item (verb=bill) | needs an invoice |
| action_item (verb=pay) | needs to be paid |
| action_item (verb=fix) | something's off |
| recovery snapshot | how we're tracking |
| restated target | this year's goal |

## Derivation confidence
**Confident:** the rule itself (simple=default, zero accounting words, same dataset)
is verbatim from CLAUDE.md.

**Needs Tyler — entirely:** every row of the mapping table above is my invention,
not derived from any evidence in the repo. There is no existing copy/voice reference
for Groundwork's simple-mode language. This whole file is a first-draft strawman for
you to edit, not something W4-roles should build against without your review.
