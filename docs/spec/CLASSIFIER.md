# CLASSIFIER

W5-classifier: "Classifier stages 1-3 deterministic + stage 4 LLM + calibration
table." Depends on W1-repos. Files: `src/ai/classify.ts`, `src/ai/calibration.ts`.

## Staged escalation
- **Stages 1-3 — deterministic.** Rule-based matching (e.g. vendor name patterns,
  amount patterns, historical tenant corrections via the `gw-tenant-history`
  Vectorize index). Cheap, fast, no model call. Forbidden: "calling a model before
  stages 1-3 have failed" — the LLM is a fallback, not a first resort.
- **Stage 4 — LLM.** Only reached when stages 1-3 don't produce a confident match.
  Uses Workers AI (the `AI` binding in wrangler.jsonc).

## Materiality override
Forbidden: "auto-posting on model self-reported confidence" and "auto-posting any row
over tenant materiality" — a model saying "I'm 95% confident" is never sufficient by
itself to auto-post; and regardless of confidence, anything over
`tenant_finance_policy.materiality_threshold_cents` (SCHEMA.md) requires human
review via an `action_item` (`verb=decide`), never auto-posts. `gate_must_include`
for this task: `stages-1-3-hit-rate` and `materiality-override` — both must be
covered by tests.

## Calibration table
`calibration.ts` presumably tracks stage-4 accuracy over time to inform confidence
scoring — GO-PROMPT.md is explicit that a well-calibrated table needs 4+ weeks of
real corrections and "ships present-but-advisory" for this build, not a finished
feature. Don't build toward 91% accuracy in this wave; that's explicitly out of
24-hour-build scope per GO-PROMPT.md's "WHAT 24H CANNOT BUY."

## Derivation confidence
**Confident:** the staged-escalation order and both forbidden clauses (verbatim from
tasks.json), the materiality-threshold gate (ties directly to `tenant_finance_policy`
in SCHEMA.md), the explicit non-goal of reaching high accuracy this build (verbatim
from GO-PROMPT.md).

**Needs Tyler:** what stages 1-3 actually match against beyond "vendor name / amount
patterns" (my inference) — no concrete rule set was given anywhere in evidence. This
is a real gap for W5-classifier; likely needs your input on what the deterministic
rules should check before that task can be built for real rather than stubbed.
