import { getTenantFinancePolicy, insertActionItem, insertClassificationFinding } from "../db/repos";
import type { Cents, RateConfidence } from "../db/schema";
import {
  automationPolicy, classifierRules, confidenceAtLeast, type ClassifierRules,
} from "../config/finance-config";

/**
 * See docs/spec/CLASSIFIER.md and BLOCKED-W5-classifier.md. Stages 1-3 are
 * deterministic and entirely config-driven (config/finance/classifier.rules.json)
 * — no business rule is hardcoded here. The rules shipped are placeholders
 * (marked `"placeholder": true`); this module is the mechanism, not the
 * rules themselves. Stage 4 (LLM) is only ever reached after stages 1-3
 * produce a review, never before (CLAUDE.md forbidden: "calling a model
 * before stages 1-3 have failed"), and its suggestion is attached to the
 * review item, never auto-applied (forbidden: "auto-posting on model
 * self-reported confidence").
 *
 * classifyDeterministic/decide take `rules` as a parameter (defaulting to
 * the static config) rather than importing the module-level singleton
 * directly — this is what lets classifyTransaction pass an admin-edited
 * override (src/config/finance-config-runtime.ts) through to pure,
 * DB-free, fully unit-testable functions.
 */

export interface TransactionInput {
  tenant_id: string;
  subject_type: string;
  subject_id: string;
  vendor: string | null;
  memo: string | null;
  amount_cents: number;
}

export interface DeterministicDecision {
  category: string | null;
  confidence: RateConfidence;
  stage_reached: 1 | 2 | 3;
  matched_rule_id: string | null;
  requires_review: boolean;
  review_reason: string | null;
}

let compiledCache: { rules: ClassifierRules; compiled: { rule: ClassifierRules["stage1_vendor_patterns"][number]; regex: RegExp }[] } | null = null;
function compileVendorPatterns(rules: ClassifierRules) {
  if (compiledCache?.rules === rules) return compiledCache.compiled;
  const compiled = rules.stage1_vendor_patterns.map((rule) => ({ rule, regex: new RegExp(rule.pattern, "i") }));
  compiledCache = { rules, compiled };
  return compiled;
}

/** Pure — no DB, no I/O. Stages 1 and 2 only; stage 3 here means "no
 * deterministic match, always review" (the amount-based force-review check
 * happens in classifyTransaction, which has the tenant's materiality
 * threshold from the DB, not just the static config default). */
export function classifyDeterministic(input: TransactionInput, rules: ClassifierRules = classifierRules): DeterministicDecision {
  if (!automationPolicy.classifier_enabled) {
    return decide(null, "low", 3, null, rules);
  }

  if (input.vendor) {
    for (const { rule, regex } of compileVendorPatterns(rules)) {
      if (regex.test(input.vendor)) return decide(rule.category, rule.confidence, 1, rule.id, rules);
    }
  }

  if (input.memo) {
    const memoLower = input.memo.toLowerCase();
    for (const rule of rules.stage2_keyword_rules) {
      if (rule.keywords.some((k) => memoLower.includes(k.toLowerCase()))) {
        return decide(rule.category, rule.confidence, 2, rule.id, rules);
      }
    }
  }

  return decide(null, "low", 3, null, rules);
}

function decide(
  category: string | null, confidence: RateConfidence, stage: 1 | 2 | 3, ruleId: string | null,
  rules: ClassifierRules,
): DeterministicDecision {
  const forcedReview = category !== null && rules.forced_review_categories.includes(category);
  const belowThreshold = category === null
    || !confidenceAtLeast(confidence, rules.confidence_thresholds.auto_categorize_min);
  const requiresReview = forcedReview || belowThreshold;

  return {
    category, confidence, stage_reached: stage, matched_rule_id: ruleId,
    requires_review: requiresReview,
    review_reason: forcedReview
      ? `category "${category}" is in forced_review_categories`
      : belowThreshold ? "confidence below classifier.rules.json's auto_categorize_min" : null,
  };
}

export interface AiSuggestion {
  category: string;
  confidence: RateConfidence;
}

export interface ClassifyResult {
  decision: DeterministicDecision;
  ai_suggestion: AiSuggestion | null;
  finding_id: string;
  action_item_id: string | null;
  materiality_forced_review: boolean;
}

/**
 * Orchestrates the full pipeline: deterministic stages -> tenant-materiality
 * check -> AI fallback (only if still unresolved) -> classification_finding
 * -> action_item(verb='decide') when review is needed. `aiClassify` is
 * injected the same way receipts.ts injects OCR extraction — the actual
 * model call has little logic of its own worth testing here. `rules`
 * defaults to the static config but the caller (e.g. an HTTP route with
 * access to finance-config-runtime's getEffectiveConfig) can pass an
 * admin-edited override.
 */
export async function classifyTransaction(
  db: D1Database,
  input: TransactionInput,
  reviewOwnerId: string,
  aiClassify?: (input: TransactionInput) => Promise<AiSuggestion | null>,
  rules: ClassifierRules = classifierRules,
): Promise<ClassifyResult> {
  const decision = classifyDeterministic(input, rules);

  const policy = await getTenantFinancePolicy(db, input.tenant_id);
  const materialityThreshold = policy?.materiality_threshold_cents ?? Number.MAX_SAFE_INTEGER;
  const materialityForcedReview = input.amount_cents > materialityThreshold;
  const needsReview = decision.requires_review || materialityForcedReview;

  let aiSuggestion: AiSuggestion | null = null;
  if (needsReview && automationPolicy.classifier_ai_fallback_enabled && aiClassify) {
    const suggestion = await aiClassify(input);
    if (suggestion && confidenceAtLeast(suggestion.confidence, rules.confidence_thresholds.stage4_fallback_min)) {
      aiSuggestion = suggestion;
    }
  }

  const findingId = `cf-classify-${crypto.randomUUID().slice(0, 8)}`;
  await insertClassificationFinding(db, {
    id: findingId,
    tenant_id: input.tenant_id,
    subject_type: input.subject_type,
    subject_id: input.subject_id,
    stage_reached: aiSuggestion ? 4 : decision.stage_reached,
    confidence: decision.confidence,
    materiality_cents: input.amount_cents as Cents,
    proposed_change: JSON.stringify({ decision, ai_suggestion: aiSuggestion, materiality_forced_review: materialityForcedReview }),
    action_item_id: null,
  });

  let actionItemId: string | null = null;
  if (needsReview && automationPolicy.auto_create_action_items) {
    actionItemId = `ai-classify-${findingId.slice(-12)}`;
    await insertActionItem(db, {
      id: actionItemId,
      tenant_id: input.tenant_id,
      verb: "decide",
      owner_id: reviewOwnerId,
      sla_due: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
      amount_cents: input.amount_cents as Cents,
      confidence: decision.confidence,
      stale_components: null,
      source_type: "classification_finding",
      source_id: findingId,
    });
  }

  return { decision, ai_suggestion: aiSuggestion, finding_id: findingId, action_item_id: actionItemId, materiality_forced_review: materialityForcedReview };
}
