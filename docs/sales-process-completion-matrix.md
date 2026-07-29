# Sales-process completion matrix

This matrix is the implementation gate for the versioned sales-process platform.
No Avalon publication is permitted while any generic row remains incomplete.

| Area | Schema | Backend | Frontend | Behavioral proof | Status |
| --- | --- | --- | --- | --- | --- |
| Clean migration chain and unique prefixes | Complete | Not applicable | Not applicable | `clean-migrations.test.mjs` | Complete |
| Immutable Groundwork v2 template | Complete | Copy-on-adopt supported | Template selection foundation | Catalog graph test | Complete |
| Four distinct template graphs | Complete | Copy-on-adopt supported | Template selection foundation | Catalog graph test | Complete |
| Outcome-aware branching transition paths | Complete | Forward, reverse, branching, revision, terminal, Disqualified, and Nurture paths enforced | Configured destination metadata and confirmation UI available | Two-company transition integration suite | Complete |
| Complete relationship remapping | Complete | Stages, outcomes, statuses, requirements, guides, resources, automations, transitions, Academy | Not applicable | Static remapping assertions | In progress |
| Canonical compatibility resolution | Complete | Active version, stages, outcomes, transitions, assignments, and approved mappings hydrate at authentication | Shared resolver exposes open, proposal, presentation, Won, Lost, and restaging semantics | Resolver precedence and rename invariance pass | Complete |
| Optimistic draft mutations | Complete | Token-claimed mutations cover stages, outcomes, statuses, requirements, guides, resources, automations, transitions, Academy associations, and company content | Builder reloads current content after conflicts | Concurrent stage and resource mutations pass | Complete |
| Full transition requirement evaluation | Evidence schema complete | Exit, entry, checklist, estimate, appointment, task, terminal, manager authorization, override reason, and boolean evidence enforced | Stage Guide shows structured missing items and requires confirmation | Two-company transition behavior and audit suite passes | Complete |
| Semantic reporting conversion | Complete | Inventory and publication reconciliation prefer assignments and outcomes | Dashboard, My Day, pipeline filters, forecasts, stagnation, representative metrics, commission, financial summaries, and manager funnel use semantic predicates | Rename invariance and restaging exclusions pass; remaining compatibility-only labels are inventoried | In progress |
| Sales Process Builder | Complete | Version-owned content mutation APIs and immutable published reads | All required panels expose draft editing and published read-only content | Rendered/mobile tests pending | In progress |
| Needs Restaging workspace | Complete | Review, snapshot, and reconciliation endpoints exist | Filtered review, Save and Next, bulk review, counts, and snapshot preview exist | Full mobile workspace tests pending | In progress |
| Stage Guide | Complete | Published company-scoped context groups requirements, evidence, aging, transitions, resources, and training | Opportunity detail renders the published definition and configured destinations | Tenant-scope and explicit-confirmation checks pass | Complete |
| Call Companion | Complete | Published guide, known data, missing information, and evidence context available | Version-owned collapsible sections and review-only post-call drafts require separate confirmation | Published-content and no-automatic-action checks pass | Complete |
| Academy playbook | Complete | Published endpoint separates immutable global skills from visibility-filtered company content and orders it by active process stage | Academy landing renders the Groundwork core library and generated company playbook separately | Tenant scope, immutability, visibility, and process-order checks pass | Complete |
| AI Process Assistant | Complete | Suggestions and decisions are audited against company-owned drafts with no execution side effects | Side-by-side JSON suggestion review and individual decisions are available | Draft-only and role restriction behavior passes | In progress |
| Snapshot, preview, approval, publication | Complete | Current approved snapshots, drift checks, active pointer, and atomic publication implemented | Impact and surface preview workflow exists | Two-company drift, failure recovery, publication, and isolation pass | In progress |
| Rollback | Complete | Restores version pointer, stable stage, and both compatibility labels while preserving audit history | Administrative workflow pending | Publication and rollback restoration pass | In progress |
| Avalon inventory and draft | Complete | Inventory foundation | Review UI foundation | Authenticated data unavailable | Blocked by generic completion |

## Mandatory publication gates

Publication requires a valid immutable draft, a current approved snapshot, complete
active-opportunity mappings, zero unexplained reconciliation differences, explicit
administrator approval, and a validated rollback path. AI and automation cannot
publish, remap, transition, communicate, schedule, or select terminal outcomes.
