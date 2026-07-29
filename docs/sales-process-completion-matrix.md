# Sales-process completion matrix

This matrix is the implementation gate for the versioned sales-process platform.
No Avalon publication is permitted while any generic row remains incomplete.

| Area | Schema | Backend | Frontend | Behavioral proof | Status |
| --- | --- | --- | --- | --- | --- |
| Clean migration chain and unique prefixes | Complete | Not applicable | Not applicable | `clean-migrations.test.mjs` | Complete |
| Immutable Groundwork v2 template | Complete | Copy-on-adopt supported | Template selection foundation | Catalog graph test | Complete |
| Four distinct template graphs | Complete | Copy-on-adopt supported | Template selection foundation | Catalog graph test | Complete |
| Outcome-aware branching transition paths | Complete | Stable company-scoped paths enforce manager-required overrides and structured responses | Destination metadata available | `sales-process-transitions.integration.test.mjs` covers roles, stale state, task fallback, and tenant isolation | Complete |
| Complete relationship remapping | Complete | Stages, outcomes, statuses, requirements, guides, resources, task actions, email templates, automations, transitions, and Academy | Not applicable | Every immutable template is adopted through the worker against isolated D1; copied counts, fresh IDs, relationship remapping, catalog immutability, graph differences, and second-company isolation are asserted | Complete |
| Canonical compatibility resolution | Complete | Assignment, approved mapping, legacy fallback, restaging, and published bootstrap context | Shared resolver is hydrated at login | Resolver precedence and rename-invariance tests | Complete |
| Optimistic draft mutations | Complete | Atomic revision guard protects stage and component replacement; tenant, role, lifecycle, and occupied-stage rules are enforced | Stale-save conflicts instruct the editor to reload | Behavioral proof covers stale revisions, roles, occupied archival, and published immutability | Complete |
| Full transition requirement evaluation | Evidence schema complete | Required exit and entry evidence, manager-only requirements, strict boolean evidence, and task-derived next actions are enforced | Structured missing-evidence response available to transition UI | `sales-process-transitions.integration.test.mjs` | Complete |
| Semantic reporting conversion | Complete | Normalized AI coaching and automation outcome checks use published assignments; legacy labels are isolated to no-published-process compatibility and migration review | Shared resolver drives reports, forecasts, commissions, estimates, financial summaries, and StageTracker without operational label matching | Rename-invariance, Needs Restaging exclusions, two-company AI coaching, workflow outcome, and renamed StageTracker behavior are covered | Complete |
| Sales Process Builder | Complete | Optimistic mutations cover stages, statuses, requirements, guides, resources, automations, Academy associations, transitions, and outcomes | Field-specific controls cover overview, stages, statuses, qualification, checklists, guides, automations, email, Academy, AI review, versions, validation, preview, and mapping | Mobile and full lifecycle behavioral tests remain pending | In progress |
| Needs Restaging workspace | Complete | Inventory and review endpoints expose activity, estimates, appointments, value, and notes | Filterable review, individual Save and Next, bulk approval, counts, reconciliation, and responsive layout | Full DOM lifecycle tests pending | In progress |
| Stage Guide | Complete | Published stage, requirements, resources, transitions, and associations are company scoped | Call Companion renders the normalized current-stage guide | Two-company runtime-context behavioral test | Complete |
| Call Companion | Complete | Version-owned guides, requirements, transitions, resources, and training are returned | Current normalized stage drives questions, checklists, next steps, and training | Two-company runtime-context behavioral test | Complete |
| Academy playbook | Complete | Published company playbook resolves version-owned stages, guides, and associated global or company skills | Academy home and Call Companion display the normalized company playbook | Two-company playbook and cross-tenant training isolation tests | Complete |
| AI Process Assistant | Complete | Company-scoped draft suggestions reject unsafe types and require an optimistic mutation before acceptance | Side-by-side review and individual accept/reject controls | Role, tenant, unsafe-type, and optimistic acceptance tests pass; guided generation tests pending | In progress |
| Snapshot, preview, approval, publication | Complete | Company-scoped snapshot capture, drift-safe approval, impact preview, readiness gates, and atomic publication | Restaging can capture and approve a snapshot and render impact preview | Publication and rollback lifecycle passes; mobile preview tests pending | In progress |
| Rollback | Complete | Reactivates prior version and restores prior stage, outcome, and classification while retaining history | Authorized publication history includes explicit rollback confirmation and refresh | Failed publication recovery and successful rollback lifecycle pass; DOM proof pending | In progress |
| Avalon inventory and draft | Complete | Inventory foundation | Review UI foundation | Authenticated data unavailable | Blocked by generic completion |

## Mandatory publication gates

Publication requires a valid immutable draft, a current approved snapshot, complete
active-opportunity mappings, zero unexplained reconciliation differences, explicit
administrator approval, and a validated rollback path. AI and automation cannot
publish, remap, transition, communicate, schedule, or select terminal outcomes.
