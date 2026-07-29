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
    const assignment = opportunity && (opportunity.salesProcessAssignment || opportunity.sales_process_assignment);
    const stageId = String((assignment && assignment.stage_id) || (opportunity && (opportunity.salesProcessStageId || opportunity.sales_process_stage_id)) || '');
    if (process && process.process && process.process.lifecycle === 'published' && stageId) {
      const stage = stages.find(item => String(item.id) === stageId);
      if (stage) return { resolved: true, source: 'assignment', stage, semantic: stage.semantic_type, outcome: (assignment && assignment.outcome_type) || opportunity.sales_process_outcome_type || opportunity.salesProcessOutcomeType || '' };
    }
    const mapping = opportunity && (opportunity.salesProcessMapping || opportunity.sales_process_mapping);
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
    return !result.resolved || !['won', 'lost', 'disqualified'].includes(result.outcome || result.semantic);
  }

  // Operational metrics consume stable semantics. Unresolved opportunities stay
  // in overall totals, but cannot distort stage conversion, forecast, or aging.
  function summarize(opportunities, options = {}) {
    const rows = Array.isArray(opportunities) ? opportunities : [];
    const resolved = rows.map(opportunity => ({ opportunity, resolution: resolve(opportunity, options.definition) }));
    const stageEligible = resolved.filter(row => row.resolution.resolved);
    const won = stageEligible.filter(row => row.resolution.outcome === 'won' || row.resolution.semantic === 'won');
    const lost = stageEligible.filter(row => row.resolution.outcome === 'lost' || row.resolution.semantic === 'lost');
    const open = resolved.filter(row => !row.resolution.resolved || !['won','lost','disqualified'].includes(row.resolution.outcome || row.resolution.semantic));
    const value = row => Number(row.opportunity.jobValue || row.opportunity.job_value || row.opportunity.estimateAmount || row.opportunity.estimate_amount || 0);
    const proposal = stageEligible.filter(row => row.resolution.semantic === 'proposal_presentation');
    const probability = Object.assign({ intake:.1, active_qualification:.2, consultation:.35, estimate_development:.5, proposal_presentation:.7, decision:.8 }, options.probability || {});
    return {
      total: rows.length,
      totalValue: rows.reduce((sum, opportunity) => sum + Number(opportunity.jobValue || opportunity.job_value || 0), 0),
      needsRestaging: resolved.length - stageEligible.length,
      open: open.length,
      won: won.length,
      lost: lost.length,
      wonValue: won.reduce((sum, row) => sum + value(row), 0),
      proposal: proposal.length,
      presentation: proposal.length,
      closeRate: won.length + lost.length ? won.length / (won.length + lost.length) : 0,
      forecast: open.reduce((sum, row) => sum + value(row) * Number(probability[row.resolution.semantic] || 0), 0),
      stageEligible: stageEligible.length
    };
  }

  function isStagnant(opportunity, now = Date.now()) {
    const result = resolve(opportunity);
    if (!result.resolved || ['won','lost','disqualified','nurture'].includes(result.outcome || result.semantic)) return false;
    const duration = Number(result.stage && result.stage.expected_duration_days || 0);
    const entered = Date.parse(opportunity.stage_entered_at || opportunity.stageEnteredAt || opportunity.updated_at || opportunity.updatedAt || '');
    return duration > 0 && Number.isFinite(entered) && now - entered > duration * 86400000;
  }

  const defaultProbability = Object.freeze({ intake:.1, active_qualification:.2, consultation:.35, estimate_development:.5, proposal_presentation:.7, decision:.8 });
  function forecastProbability(opportunity, probability = defaultProbability) {
    const result = resolve(opportunity);
    if (!result.resolved || ['won','lost','disqualified','nurture'].includes(result.outcome || result.semantic)) return 0;
    return Number(probability[result.semantic] || 0);
  }

  function hasOpenEstimate(opportunity) {
    if (!isOpen(opportunity) || !includedInStageMetrics(opportunity)) return false;
    const estimateStatus = String(opportunity.estimateStatus || opportunity.estimate_status || '').toLowerCase().replace(/ /g, '_');
    return ['sent','revised','viewed','awaiting_response'].includes(estimateStatus) || isProposal(opportunity);
  }

  function isProposal(opportunity) { return is(opportunity, 'proposal_presentation'); }
  function isWon(opportunity) { return is(opportunity, 'won'); }
  function isLost(opportunity) { return is(opportunity, 'lost'); }
  function didEnterOutcome(previous, current, outcome) { return !is(previous, outcome) && is(current, outcome); }

  window.GWSalesProcess = Object.freeze({ resolve, is, isOpen, isWon, isLost, isProposal, didEnterOutcome, includedInStageMetrics, summarize, isStagnant, forecastProbability, hasOpenEstimate, legacy });
  window.gwSalesIs = is;
  window.gwSalesIsOpen = isOpen;
})();
