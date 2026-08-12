/**
 * Shared lead creation.
 *
 * Extracted from the body of POST /api/opportunities so the public inquiry
 * form writes leads through exactly the same code path as the CRM does. Two
 * behaviours in particular must not diverge:
 *
 *   1. A new lead's default stage comes from the company's live
 *      `{companyId}:pipeline_stages` setting, which is kept in sync with the
 *      published sales process. A form that hardcoded "Lead Intake" would drop
 *      inquiries into a stage that may not exist for this tenant.
 *
 *   2. Money is dual-written to both the legacy float column and the *_cents
 *      integer column. Stage 3a made the cents columns the source of truth for
 *      every reader, so a writer that skipped them would produce a lead worth
 *      zero everywhere it is displayed.
 *
 * This module deliberately does NOT do the published-stage assignment or the
 * activity-log broadcast — those stay in index.tsx next to the helpers they
 * depend on. The extraction is the insert and the stage default, nothing more.
 */

export interface OpportunityInput {
  id?: string;
  repId?: string | null;
  assignedToRepId?: string;
  client?: string;
  phone?: string;
  email?: string;
  address?: string;
  serviceLine?: string;
  source?: string;
  status?: string;
  jobValue?: number;
  project?: string;
  urgency?: string;
  decisionMaker?: string;
  budgetRange?: string;
  nextFollowUp?: string;
  pipelineStage?: string;
  estimateAmount?: number;
  estimateSentDate?: string;
  estimateCount?: number;
  workType?: string;
  clientType?: string;
  prompt?: string;
  desiredOutcome?: string;
  fitConcerns?: string;
  commissionApproved?: boolean;
  collected?: boolean;
  soldDate?: string;
  soldAmount?: number;
  clientId?: string;
}

/** The nine-stage default, used only when the tenant has no pipeline setting. */
export const LEGACY_DEFAULT_STAGE = 'Lead Intake / Rapport';

/**
 * First label of the company's live pipeline, falling back to the legacy
 * default. Never throws: a malformed setting must not stop a lead being
 * captured, since the alternative is losing the inquiry entirely.
 */
export async function resolveDefaultPipelineStage(db: D1Database, companyId: string): Promise<string> {
  try {
    const row = await db
      .prepare('SELECT value FROM settings WHERE key=? LIMIT 1')
      .bind(`${companyId}:pipeline_stages`)
      .first<{ value: string }>();
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      if (Array.isArray(parsed) && parsed.length && String(parsed[0]).trim()) {
        return String(parsed[0]).trim();
      }
    }
  } catch {
    /* fall through to the legacy default */
  }
  return LEGACY_DEFAULT_STAGE;
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Cents are integers. Floats are what the *_cents columns exist to replace. */
const cents = (v: unknown): number => Math.round(num(v) * 100);

/**
 * Insert one opportunity row. Returns the id, generating one when the caller
 * did not supply it.
 */
export async function insertOpportunityRow(
  db: D1Database,
  companyId: string,
  input: OpportunityInput,
): Promise<string> {
  const id = input.id || `opp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const jobValue = num(input.jobValue);
  const estimateAmount = num(input.estimateAmount);
  const soldAmount = num(input.soldAmount);

  await db
    .prepare(
      `INSERT INTO opportunities (
         id, company_id, rep_id, assigned_to_rep_id,
         client, phone, email, address, service_line, source, status,
         job_value, job_value_cents, project, urgency, decision_maker, budget_range, next_follow_up,
         pipeline_stage, estimate_amount, estimate_amount_cents, estimate_sent_date, estimate_count,
         work_type, client_type, prompt, desired_outcome, fit_concerns,
         commission_approved, collected, sold_date, sold_amount, sold_amount_cents, client_id,
         created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
    )
    .bind(
      id, companyId, input.repId ?? null, input.assignedToRepId ?? '',
      input.client ?? '', input.phone ?? '', input.email ?? '',
      input.address ?? '', input.serviceLine ?? '', input.source ?? '',
      input.status ?? '', jobValue, cents(jobValue),
      input.project ?? '', input.urgency ?? '', input.decisionMaker ?? '',
      input.budgetRange ?? '', input.nextFollowUp ?? '',
      input.pipelineStage ?? '',
      estimateAmount, cents(estimateAmount),
      input.estimateSentDate ?? '',
      Math.trunc(num(input.estimateCount)),
      input.workType ?? '', input.clientType ?? '',
      input.prompt ?? '', input.desiredOutcome ?? '',
      input.fitConcerns ?? '',
      input.commissionApproved ? 1 : 0,
      input.collected ? 1 : 0, input.soldDate ?? '',
      soldAmount, cents(soldAmount),
      input.clientId ?? '',
    )
    .run();

  return id;
}
