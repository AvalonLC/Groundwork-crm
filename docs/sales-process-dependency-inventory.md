# Sales process dependency inventory

This inventory is the pre-change safety record for the normalized sales-process installation. It distinguishes tenant customer opportunities in `opportunities` from Groundwork platform sales records in `gw_leads`; migration and publishing code must never query or update `gw_leads`.

## Server and persistence dependencies

| Location | Dependency on editable labels | Compatibility requirement |
| --- | --- | --- |
| `src/index.tsx` `/api/pipeline-stages` | Stores a JSON array of English stage names in company-prefixed settings and seeds the legacy nine-stage Avalon list. | Continue returning labels while normalized versions are introduced. Do not mutate this setting until publish. |
| `src/index.tsx` `/api/auth/bootstrap` | Hydrates pipeline settings and serializes `opportunities.status` and `pipeline_stage`. | Add normalized process data without removing legacy fields. |
| `src/index.tsx` opportunity create, update, and bulk-upsert | Defaults new records to an English stage and accepts `status`/`pipeline_stage`. | Resolve a stable stage only from a published company version or an approved mapping; unknown text remains unresolved. |
| `src/index.tsx` activity logging | Records generic status changes but not stable stage transitions or overrides. | Record company, opportunity, version, prior/new stable stage, actor, and override reason. |
| `src/index.tsx` AI and reporting queries | Prompt context, proposal follow-up, stagnation, counts, and financial summaries consume textual status or `pipeline_stage`. | Read semantic types from the published process; exclude unresolved records from stage-specific metrics. |
| `migrations/0001_initial_schema.sql` | Defines `opportunities.status` and `opportunities.pipeline_stage` as text. | Retain both during compatibility. |
| `migrations/0013_generic_roles_and_activity_log.sql` | Seeds company stage arrays in settings and defines generic activity behavior. | Do not rewrite; normalized migration is additive. |

## Frontend dependencies

| Location | Label-sensitive behavior |
| --- | --- |
| `public/js/app_premium.js` `getPipelineStages()` | Chooses D1/settings labels, then static data, then the nine Avalon labels. |
| `public/js/app_premium.js` pipeline filters/grouping and `orphanOpps` | Compares `o.status` by exact equality; previously inserted unknown records into the first stage. Unknown records must instead appear once in Needs Restaging with their original value. |
| `public/js/app_premium.js` opportunity detail/stage editing | Builds selectors from label arrays and writes text status. |
| `public/js/app_premium.js` Call Companion, dashboards, forecasts, and reports | Uses strings such as proposal, follow-up, sold, activation, won, and lost to infer behavior. |
| `public/js/reps.js` | Hydrates pipeline labels and compares Sold, Lost, proposal, and open-stage strings for representative metrics. |
| `public/js/record-page.js` `StageTracker` | Uses fixed order, shortened English labels, and terminal-stage checks. |
| `public/js/academy.js` | Training is independently organized around mutual agreement, CBR, budget, decision process, presentation, and follow-up labels. These become skills associated with stable stages. |
| `public/js/data.js` | Defines fixed stages, gates, scripts, checklists, and training relationships using numeric or textual stage identity. |
| `public/js/db.js` `pipelineStages` | Exposes the legacy list/save API only. |

## Known editable and legacy labels

The compatibility mapper must recognize, but never use as a relational key: `Lead Intake / Rapport`, `Mutual Agreement Set`, `Discovery / CBR Uncovered`, `Budget & Investment Qualified`, `Decision Process Qualified`, `Presentation & SOW Pitch`, `Deal Closed / Won`, `On Hold`, `Sold / Activation`, `Closed Lost`, `Proposal / Estimate Sent`, and `Follow-Up`. Blank, conflicting, and nonstandard labels are explicitly classified as Needs Restaging.

## Avalon pre-migration inventory contract

The company-scoped inventory endpoint captures opportunity identity, Avalon company ID, customer/contact fields, representative ownership, both legacy stage fields, value, service line, source, estimate fields, appointment fields, next follow-up, timestamps, inferred Won/Lost state, and task/activity counts. Reconciliation includes total count, counts by status, open value, Won value, Lost count, missing owner, missing next action, missing next-action date, and unknown/blank stage. It reads only `opportunities WHERE company_id = ?` and related rows joined with the same company ID. It never deletes, rewrites, or merges customer, task, estimate, appointment, note, activity, or ownership data.

## Publication sequence and rollback boundary

1. Copy the immutable global template into a company-owned draft.
2. Validate stable keys, ordering, terminal outcomes, references, and absence of occupied archived stages.
3. Generate a company-scoped mapping batch. Clear legacy mappings may be proposed; ambiguous and conflicting records remain pending.
4. Review every active mapping and reconcile counts, values, owners, actions, estimates, tasks, activities, and appointments with zero unexplained differences.
5. Publish the immutable version and apply approved assignments as one D1 batch; retain legacy text and all mapping/history rows.
6. Rollback creates a new audited publication event, reactivates the prior version, and restores recorded assignments without deleting later activity.
