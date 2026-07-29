/* Shared normalized sales-process resolver. Legacy text is compatibility-only. */
(function () {
  'use strict';

  const legacy = Object.freeze({
    'Lead Intake / Rapport': { stableKey: 'new_lead', semantic: 'intake' },
    'Mutual Agreement Set': { stableKey: 'connect_qualify', semantic: 'active_qualification' },
    'Discovery / CBR Uncovered': { stableKey: 'connect_qualify', semantic: 'active_qualification' },
    'Budget & Investment Qualified': { stableKey: 'connect_qualify', semantic: 'active_qualification' },
    'Decision Process Qualified': { stableKey: 'connect_qualify', semantic: 'active_qualification' },
    'Presentation & SOW Pitch': { stableKey: '', semantic: '', ambiguous: true },
    'Proposal / Estimate Sent': { stableKey: 'estimate_presentation', semantic: 'proposal_presentation' },
    'Proposal Sent': { stableKey: 'estimate_presentation', semantic: 'proposal_presentation' },
    'Follow-Up': { stableKey: 'decision_pending', semantic: 'decision' },
    'On Hold': { stableKey: 'decision_pending', semantic: 'decision' },
    'Deal Closed / Won': { stableKey: 'closed', semantic: 'won', outcome: 'won' },
    'Sold / Activation': { stableKey: 'closed', semantic: 'won', outcome: 'won' },
    'Closed Lost': { stableKey: 'closed', semantic: 'lost', outcome: 'lost' }
  });

  function processDefinition() {
    return window._gwSalesProcess || null;
  }

  function resolve(opportunity, definition) {
    const process = definition || processDefinition();
    const stages = process && Array.isArray(process.stages) ? process.stages : [];
    const opportunityId = String((opportunity && opportunity.id) || '');
    const processAssignment = process && Array.isArray(process.assignments) ? process.assignments.find(item => String(item.opportunity_id) === opportunityId) : null;
    const assignment = opportunity && (opportunity.salesProcessAssignment || opportunity.sales_process_assignment) || processAssignment;
    const stageId = String((assignment && assignment.stage_id) || (opportunity && (opportunity.salesProcessStageId || opportunity.sales_process_stage_id)) || '');
    if (process && process.process && process.process.lifecycle === 'published' && stageId) {
      const stage = stages.find(item => String(item.id) === stageId);
      if (stage) return { resolved: true, source: 'assignment', stage, semantic: stage.semantic_type, outcome: (assignment && assignment.outcome_type) || '' };
    }
    const processMapping = process && Array.isArray(process.mappings) ? process.mappings.find(item => String(item.opportunity_id) === opportunityId) : null;
    const mapping = opportunity && (opportunity.salesProcessMapping || opportunity.sales_process_mapping) || processMapping;
    if (mapping && mapping.review_state === 'approved') {
      const stage = stages.find(item => String(item.id) === String(mapping.final_stage_id));
      if (stage) return { resolved: true, source: 'approved_mapping', stage, semantic: stage.semantic_type, outcome: mapping.final_outcome_type || '' };
    }
    if (!process || !process.process || process.process.lifecycle !== 'published') {
      const status = String((opportunity && (opportunity.status || opportunity.pipeline_stage)) || '');
      const fallback = legacy[status];
      if (fallback && !fallback.ambiguous) return { resolved: true, source: 'legacy_compatibility', stage: null, ...fallback };
    }
    return { resolved: false, source: 'needs_restaging', stage: null, semantic: '', outcome: '', originalLabel: String((opportunity && (opportunity.status || opportunity.pipeline_stage)) || '') };
  }

  function is(opportunity, semantic) {
    const result = resolve(opportunity);
    return result.resolved && (result.semantic === semantic || result.outcome === semantic);
  }

  function includedInStageMetrics(opportunity) { return resolve(opportunity).resolved; }
  function isOpen(opportunity) {
    const result = resolve(opportunity);
    return result.resolved && !['won', 'lost', 'disqualified'].includes(result.outcome || result.semantic);
  }

  function isOverallOpen(opportunity) {
    const result = resolve(opportunity);
    return !result.resolved || !['won', 'lost', 'disqualified'].includes(result.outcome || result.semantic);
  }

  function isProposal(opportunity) {
    const result = resolve(opportunity);
    return result.resolved && ['proposal_presentation', 'decision'].includes(result.semantic);
  }

  function isPresentation(opportunity) { return is(opportunity, 'proposal_presentation'); }
  function isWon(opportunity) { return is(opportunity, 'won'); }
  function isLost(opportunity) { return is(opportunity, 'lost'); }
  function needsRestaging(opportunity) { return !resolve(opportunity).resolved; }

  window.GWSalesProcess = Object.freeze({ resolve, is, isOpen, isOverallOpen, isProposal, isPresentation, isWon, isLost, needsRestaging, includedInStageMetrics, legacy });
})();
