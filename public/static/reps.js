/**
 * Avalon Sales Hub — Rep Auth, Commission Tracking & Individual Dashboards
 *
 * ARCHITECTURE:
 *  - "Login" is just a name/PIN selector — no server auth needed (internal tool)
 *  - Each rep gets their own localStorage namespace: avalonRepState_<repId>
 *  - Tyler is the admin — sees all reps, all commissions, manager view
 *  - Commission engine based on the Ryan Sales Role & Commission Plan structure
 *  - All opportunities carry repId + workType + clientType + leadSource fields
 */

// ── Rep Registry ──────────────────────────────────────────────────────────────
// Admin can add reps by updating this list and redeploying
const REPS = [
  {
    id: 'tyler',
    name: 'Tyler',
    title: 'Owner / Sales Manager',
    role: 'admin',
    pin: '1111',
    avatar: '',
    color: '#00d4ff',
    base: null, // owner — no base
    commissionPlan: 'admin'
  },
  {
    id: 'ryan',
    name: 'Ryan',
    title: 'Client Relations & Enhancement Sales Associate',
    role: 'rep',
    pin: '2222',
    avatar: '',
    color: '#4ade80',
    base: { rateTraining: 20, ratePostTraining: 21 },
    commissionPlan: 'ryan'
  },
  {
    id: 'jen',
    name: 'Jen',
    title: 'Office Manager — Sales Operations',
    role: 'office_manager',
    pin: '3333',
    avatar: '',
    color: '#f59e0b',
    email: 'admin@avalon-lc.com',
    base: null,
    commissionPlan: null
  }
  // Add new reps here — copy the Ryan structure and give them a unique id/pin
  // { id: 'sarah', name: 'Sarah', title: 'Account Manager', role: 'rep', pin: '4444', avatar: '⭐', color: '#a78bfa', base: { rateTraining: 20, ratePostTraining: 21 }, commissionPlan: 'ryan' }
];

// ── Commission Plans ───────────────────────────────────────────────────────────
// ── Commission Rules Loader ────────────────────────────────────────────────────
// Admin can override rates via avalonCommissionRulesV1 in localStorage.
// Falls back to COMMISSION_PLANS defaults if no override exists.
function loadActiveCommissionRules() {
  try {
    const saved = JSON.parse(localStorage.getItem('avalonCommissionRulesV1') || 'null');
    if (saved && saved.version) return saved;
  } catch(e) {}
  return null; // use COMMISSION_PLANS defaults
}
window.loadActiveCommissionRules = loadActiveCommissionRules;

function saveCommissionRules(rules) {
  // ── COMM-04: Audit trail — log before/after state with actor + timestamp ──
  try {
    const prev = JSON.parse(localStorage.getItem('avalonCommissionRulesV1') || 'null');
    const actor = window.getCurrentRep ? (window.getCurrentRep()?.id || 'admin') : 'admin';
    const auditKey = 'avalonCommissionAuditV1';
    const audit = JSON.parse(localStorage.getItem(auditKey) || '[]');
    audit.unshift({
      id:        'audit_' + Date.now(),
      ts:        new Date().toISOString(),
      actor,
      action:    prev ? 'rules_updated' : 'rules_created',
      before:    prev,
      after:     rules
    });
    // Keep last 50 entries
    if (audit.length > 50) audit.length = 50;
    localStorage.setItem(auditKey, JSON.stringify(audit));
  } catch(e) {}
  rules.updatedAt = new Date().toISOString();
  rules.updatedBy = window.getCurrentRep ? (window.getCurrentRep()?.id || 'admin') : 'admin';
  rules.version   = (rules.version || 0) + 1;
  localStorage.setItem('avalonCommissionRulesV1', JSON.stringify(rules));
}
window.saveCommissionRules = saveCommissionRules;

// ── COMM-04: Load commission audit trail ─────────────────────────────────────
function loadCommissionAudit() {
  try { return JSON.parse(localStorage.getItem('avalonCommissionAuditV1') || '[]'); }
  catch(e) { return []; }
}
window.loadCommissionAudit = loadCommissionAudit;

// ── COMM-11: Commission lifecycle helpers ─────────────────────────────────────
// Status flow: estimated → pending_approval → approved → paid
//              estimated → rejected | on_hold
// Stored in opp.commissionLifecycle: { status, amount, rate, note, ruleApplied, capApplied,
//   requiresApproval, retentionBonus, retentionBonusPaidAt, history[] }
// Backwards-compatible: opp.commissionApproved (bool) still accepted as fallback.

function getCommissionStatus(opp) {
  if (opp.commissionLifecycle && opp.commissionLifecycle.status) {
    return opp.commissionLifecycle.status;
  }
  // Migrate legacy boolean field
  if (opp.commissionApproved === true)  return 'approved';
  if (opp.status === 'Sold / Activation') return 'pending_approval';
  return 'estimated';
}
window.getCommissionStatus = getCommissionStatus;

function getCommissionStatusLabel(status) {
  return {
    estimated:        'Estimated',
    pending_approval: 'Pending Approval',
    approved:         'Approved',
    paid:             'Paid',
    rejected:         'Rejected',
    on_hold:          'On Hold',
    pending_reapproval: 'Needs Re-Approval'
  }[status] || status;
}
window.getCommissionStatusLabel = getCommissionStatusLabel;

function getCommissionStatusColor(status) {
  return {
    estimated:          '#94a3b8',
    pending_approval:   '#f59e0b',
    pending_reapproval: '#f87171',
    approved:           '#00d4ff',
    paid:               '#4ade80',
    rejected:           '#f87171',
    on_hold:            '#f59e0b'
  }[status] || '#94a3b8';
}
window.getCommissionStatusColor = getCommissionStatusColor;

/**
 * Upgrade an opportunity's commission state to the lifecycle model,
 * recalculating from the engine. Saves to localStorage.
 * Returns the updated opp object (not saved unless persist=true).
 */
function touchCommissionLifecycle(oppId, { newStatus, actor, note: actionNote, persist = true } = {}) {
  try {
    const stateKey = 'avalonSalesHubStateV3';
    const s = JSON.parse(localStorage.getItem(stateKey) || '{}');
    const idx = (s.opportunities || []).findIndex(o => o.id === oppId);
    if (idx < 0) return null;
    const opp = s.opportunities[idx];

    // Calculate fresh from engine
    const repObj = REPS.find(r => r.id === opp.repId);
    const result = calculateCommission({
      planId:     repObj?.commissionPlan || 'ryan',
      workType:   opp.workType   || 'landscape',
      leadSource: opp.leadSource || 'company_lead',
      jobValue:   parseFloat(opp.jobValue || 0),
      collected:  !!opp.collected,
      approved:   newStatus === 'approved' || newStatus === 'paid',
      preview:    true
    });

    const prevLC    = opp.commissionLifecycle || {};
    const prevStatus = prevLC.status || getCommissionStatus(opp);
    const resolvedStatus = newStatus || prevStatus || 'pending_approval';

    const historyEntry = {
      ts:       new Date().toISOString(),
      actor:    actor || (window.getCurrentRep ? (window.getCurrentRep()?.id || 'system') : 'system'),
      from:     prevStatus,
      to:       resolvedStatus,
      amount:   result.amount,
      note:     actionNote || ''
    };

    opp.commissionLifecycle = {
      status:          resolvedStatus,
      amount:          result.amount,
      rate:            result.rate,
      cap:             result.cap,
      capApplied:      result.capApplied,
      requiresApproval:result.requiresApproval,
      note:            result.note,
      ruleApplied:     result.ruleApplied,
      retentionBonus:  result.retentionBonus,
      retentionBonusPaidAt: prevLC.retentionBonusPaidAt || null,
      calculatedAt:    new Date().toISOString(),
      history:         [historyEntry, ...(prevLC.history || [])].slice(0, 20)
    };

    // Keep legacy boolean in sync for backwards compat
    opp.commissionApproved    = resolvedStatus === 'approved' || resolvedStatus === 'paid';
    opp.commissionApprovedAt  = opp.commissionApproved ? (opp.commissionApprovedAt || historyEntry.ts) : null;
    opp.commissionApprovedBy  = opp.commissionApproved ? (actor || opp.commissionApprovedBy || 'admin') : null;
    opp.updatedAt = new Date().toISOString();

    if (persist) {
      s.opportunities[idx] = opp;
      localStorage.setItem(stateKey, JSON.stringify(s));
    }
    return opp;
  } catch(e) { console.error('touchCommissionLifecycle:', e); return null; }
}
window.touchCommissionLifecycle = touchCommissionLifecycle;

const COMMISSION_PLANS = {
  ryan: {
    landscape: {
      // REVISED STRUCTURE (COMM-03) — lower than old 10/8% to protect margin
      // [min, max, selfGen%, companyLead%, assisted%]
      tiers: [
        { min: 500,   max: 2500,  selfGen: 0.08, companyLead: 0.05, assisted: 0.025 },
        { min: 2501,  max: 10000, selfGen: 0.06, companyLead: 0.04, assisted: 0.015 },
        { min: 10001, max: 25000, selfGen: 0.04, companyLead: 0.03, assisted: 0.010 },
        { min: 25001, max: null,  selfGen: 0.025, companyLead: 0.02, assisted: 0.005 }
      ],
      // Soft approval at $1,500 payout; hard cap at $2,500 unless overridden
      softApprovalPayoutThreshold: 1500,
      hardCapPayout: 2500
    },
    maintenance: {
      // One-time / seasonal flat rates
      oneTime: { selfGen: 0.06, companyLead: 0.04, assisted: 0.015, approvalAbove: 750 },
      // Recurring — tiered first-month payout with caps + retention bonus
      recurring: {
        selfGen:     { t1Rate: 0.40, t1Max: 1000, t2Rate: 0.20, t2Max: 1000, t3Rate: 0.05, cap: 600,  retentionBonus: 100 },
        companyLead: { t1Rate: 0.20, t1Max: 1000, t2Rate: 0.10, t2Max: 1000, t3Rate: 0.03, cap: 300,  retentionBonus: 75  },
        assisted:    { t1Rate: 0.08, t1Max: 1000, t2Rate: 0.04, t2Max: 1000, t3Rate: 0.015,cap: 125,  retentionBonus: 25  }
      },
      upsell: 'use_landscape_table'
    },
    approvalThresholds: {
      under2500: 'self_approve_with_template',
      to10000:   'manager_review',
      over10000: 'tyler_approval',
      complex:   'management_always' // hardscape, drainage, grading, design/build
    },
    // FY2026 Annual Quotas (from Operating Playbook v2.2)
    quotas: {
      landscapeJobs: 75,
      landscapeRevenue: 525000,
      maintenanceGrowth: 165000,
      meanLandscapeTicket: 6500,
      medianLandscapeTicket: 4000
    },
    kpiFloors: [
      { kpi: 'Landscape GM per job',            floor: '≥ 50%',    cadence: 'Per deal' },
      { kpi: 'Maintenance Quote-to-Close',       floor: '50–60%',   cadence: 'Rolling 90-day' },
      { kpi: 'HubSpot Stage Hygiene',            floor: '0 stale deals > 14 days', cadence: 'Weekly' },
      { kpi: 'Driveway T.A.P.P.O. Confirmed',    floor: '100% of qualified opps',  cadence: 'Per deal' },
      { kpi: 'CBR Narrative Populated',          floor: '100% of opps in Stage 3+','cadence': 'Per deal' }
    ],
    // From Operating Playbook §11 — AUTHORITATIVE weekly cadence (replaces old targets)
    weeklyTargets: {
      proactiveSalesCalls:     { target: 5, label: 'Proactive Sales Calls',     description: 'Outreach to past clients 2023–2025' },
      referralAsks:            { target: 2, label: 'Referral Asks',             description: 'Warm introductions from active clients' },
      pastClientTouches:       { target: 1, label: 'Past Client Touches',        description: 'Warranty follow-ups, seasonal walkthrough invites' },
      onSiteVisits:            { target: 2, label: 'On-Site Visits',             description: 'Property walks, re-confirming Mutual Agreements live' },
      proactiveUpsellProposals:{ target: 1, label: 'Proactive Upsell Proposals', description: 'Detail on pruning, mulch, or drainage upgrades' },
      pipelineReviewMeeting:   { target: 1, label: 'Weekly Pipeline Review Mtg', description: 'With owner — stage movement, slip risk' }
    }
  }
};

// ── Auth State ────────────────────────────────────────────────────────────────
const AUTH_KEY = 'avalonRepAuth';

function getCurrentRep() {
  try {
    const d = JSON.parse(localStorage.getItem(AUTH_KEY) || '{}');
    if (!d.repId) return null;
    return REPS.find(r => r.id === d.repId) || null;
  } catch(e) { return null; }
}

function loginRep(repId) {
  localStorage.setItem(AUTH_KEY, JSON.stringify({ repId, loginAt: new Date().toISOString() }));
}

function logoutRep() {
  localStorage.removeItem(AUTH_KEY);
}

function isAdmin() {
  const rep = getCurrentRep();
  return rep?.role === 'admin';
}

function isOfficeManager() {
  const rep = getCurrentRep();
  return rep?.role === 'office_manager';
}

// Returns true for both admin and office_manager — use for "elevated" access checks
function isElevated() {
  const rep = getCurrentRep();
  return rep?.role === 'admin' || rep?.role === 'office_manager';
}

window.isAdmin = isAdmin;
window.isOfficeManager = isOfficeManager;
window.isElevated = isElevated;

// ── Per-Rep State ─────────────────────────────────────────────────────────────
function getRepStateKey(repId) { return `avalonRepState_${repId}`; }

function loadRepState(repId) {
  try {
    return JSON.parse(localStorage.getItem(getRepStateKey(repId)) || '{}');
  } catch(e) { return {}; }
}

function saveRepState(repId, patch) {
  const cur = loadRepState(repId);
  localStorage.setItem(getRepStateKey(repId), JSON.stringify({ ...cur, ...patch }));
}

// Activity log per rep
function logRepActivity(repId, type, data) {
  const state = loadRepState(repId);
  const log = state.activityLog || [];
  log.unshift({ id: genId(), type, data, at: new Date().toISOString() });
  saveRepState(repId, { activityLog: log.slice(0, 500) }); // Keep last 500
}

// ── Commission Engine ─────────────────────────────────────────────────────────
/**
 * Master commission calculation engine (COMM-02).
 * Reads active rules from localStorage override (avalonCommissionRulesV1) first,
 * falls back to COMMISSION_PLANS defaults. All app surfaces must call this function
 * rather than performing local commission math.
 *
 * @param {Object} opts
 * @param {string} opts.planId        - 'ryan' or future plan ids
 * @param {string} opts.workType      - 'landscape' | 'maintenance_onetime' | 'maintenance_recurring' | 'maintenance_upsell' | 'hardscape' | 'drainage' | 'design_build'
 * @param {string} opts.leadSource    - 'self_generated' | 'company_lead' | 'assisted'
 * @param {number} opts.jobValue      - Dollar value of job (first-month value for recurring)
 * @param {boolean} opts.collected    - Has payment been collected?
 * @param {boolean} opts.approved     - Has management approved (when required)?
 * @param {boolean} opts.preview      - If true, skip collection gate (for live UI previews)
 * @returns {{ amount: number, rate: number, cap: number|null, capApplied: boolean,
 *             requiresApproval: boolean, approvalReason: string, note: string,
 *             ruleApplied: string, retentionBonus: number }}
 */
function calculateCommission({ planId = 'ryan', workType = 'landscape', leadSource = 'company_lead', jobValue = 0, collected = false, approved = true, preview = false }) {
  // Load admin-overridden rules if present, else use default plan
  const override = loadActiveCommissionRules();
  const plan = (override && override.plans && override.plans[planId]) ? override.plans[planId] : COMMISSION_PLANS[planId];
  if (!plan) return { amount: 0, rate: 0, cap: null, capApplied: false, requiresApproval: false, approvalReason: '', note: 'No commission plan found', ruleApplied: 'none', retentionBonus: 0 };

  // Collection gate — skip only for UI preview mode
  if (!collected && !preview) {
    return { amount: 0, rate: 0, cap: null, capApplied: false, requiresApproval: false, approvalReason: '', note: 'Commission paid after payment is collected', ruleApplied: 'pending_collection', retentionBonus: 0 };
  }

  const srcKey = leadSource === 'self_generated' ? 'selfGen' :
                 leadSource === 'company_lead'   ? 'companyLead' : 'assisted';
  const srcLabel = leadSource === 'self_generated' ? 'Self-Generated' :
                   leadSource === 'company_lead'   ? 'Company Lead' : 'Assisted';

  // ── Recurring Maintenance — tiered first-month payout with cap ──────────────
  if (workType === 'maintenance_recurring') {
    const r = plan.maintenance.recurring[srcKey];
    if (!r) return { amount: 0, rate: 0, cap: null, capApplied: false, requiresApproval: false, approvalReason: '', note: 'No recurring rate configured', ruleApplied: 'maintenance_recurring', retentionBonus: 0 };
    // Tier 1: first $t1Max of first-month value
    const t1 = Math.min(jobValue, r.t1Max) * r.t1Rate;
    // Tier 2: next $t2Max
    const t2 = Math.max(0, Math.min(jobValue - r.t1Max, r.t2Max)) * r.t2Rate;
    // Tier 3: everything above t1Max+t2Max
    const t3 = Math.max(0, jobValue - r.t1Max - r.t2Max) * r.t3Rate;
    let rawAmount = t1 + t2 + t3;
    const capApplied = rawAmount > r.cap;
    const amount = Math.min(rawAmount, r.cap);
    const effectiveRate = jobValue > 0 ? (amount / jobValue) : 0;
    const note = `Recurring Maintenance — ${srcLabel}: ${Math.round(r.t1Rate*100)}% first $${r.t1Max.toLocaleString()}, ${Math.round(r.t2Rate*100)}% next $${r.t2Max.toLocaleString()}, ${Math.round(r.t3Rate*100)}% above. Cap: $${r.cap}. +$${r.retentionBonus} retention bonus after 90 days active.`;
    return { amount, rate: effectiveRate, cap: r.cap, capApplied, requiresApproval: false, approvalReason: '', note, ruleApplied: `maintenance_recurring_${srcKey}`, retentionBonus: r.retentionBonus };
  }

  // ── Maintenance One-Time / Seasonal ─────────────────────────────────────────
  if (workType === 'maintenance_onetime' || workType === 'maintenance_upsell') {
    const ot = plan.maintenance.oneTime;
    const rate = ot[srcKey];
    const rawAmount = jobValue * rate;
    const approvalAbove = ot.approvalAbove || 750;
    const requiresApproval = rawAmount > approvalAbove && !approved;
    const note = `Maintenance One-Time/Seasonal — ${srcLabel}: ${Math.round(rate*100)}%${rawAmount > approvalAbove ? ` (approval required above $${approvalAbove} payout)` : ''}`;
    return { amount: requiresApproval ? 0 : rawAmount, rate, cap: null, capApplied: false, requiresApproval, approvalReason: requiresApproval ? `Payout $${Math.round(rawAmount).toLocaleString()} exceeds $${approvalAbove} threshold — Tyler approval required` : '', note, ruleApplied: `maintenance_onetime_${srcKey}`, retentionBonus: 0 };
  }

  // ── Landscape / Enhancement / Hardscape / Drainage / Design-Build — tiered ──
  const tiers = plan.landscape.tiers;
  const softThreshold = plan.landscape.softApprovalPayoutThreshold || 1500;
  const hardCap = plan.landscape.hardCapPayout || 2500;

  for (const tier of tiers) {
    const inRange = jobValue >= tier.min && (tier.max === null || jobValue <= tier.max);
    if (!inRange) continue;
    const rate = tier[srcKey];
    if (rate === null || rate === undefined) {
      return { amount: 0, rate: 0, cap: null, capApplied: false, requiresApproval: true, approvalReason: 'Job value requires Tyler direct approval — rate set by management', note: 'Large job — commission rate set by management approval', ruleApplied: 'landscape_approval_required', retentionBonus: 0 };
    }
    const rawAmount = jobValue * rate;
    // Soft approval gate
    const needsSoftApproval = rawAmount > softThreshold && !approved;
    // Hard cap (never exceed $2,500 without override)
    const capApplied = rawAmount > hardCap;
    const amount = needsSoftApproval ? 0 : Math.min(rawAmount, hardCap);
    const tierLabel = tier.max ? `$${tier.min.toLocaleString()}–$${tier.max.toLocaleString()}` : `$${tier.min.toLocaleString()}+`;
    const note = `Landscape/Enhancement — ${srcLabel}, ${tierLabel} tier: ${Math.round(rate*100)}%${capApplied ? ` (capped at $${hardCap.toLocaleString()})` : ''}${needsSoftApproval ? ' — pending Tyler approval' : ''}`;
    const approvalReason = needsSoftApproval ? `Payout $${Math.round(rawAmount).toLocaleString()} exceeds $${softThreshold.toLocaleString()} soft threshold — Tyler approval required` : '';
    return { amount, rate, cap: capApplied ? hardCap : null, capApplied, requiresApproval: needsSoftApproval, approvalReason, note, ruleApplied: `landscape_${srcKey}_${tierLabel}`, retentionBonus: 0 };
  }

  return { amount: 0, rate: 0, cap: null, capApplied: false, requiresApproval: false, approvalReason: '', note: 'Job value below $500 minimum — no commission', ruleApplied: 'below_minimum', retentionBonus: 0 };
}

// Convenience wrapper — preview mode skips collection gate for live UI estimates
function estimateCommission(opts) {
  return calculateCommission({ ...opts, preview: true });
}

/**
 * Total commissions for a rep — COMM-11/13: lifecycle-aware
 * Returns: { totalEarned, pendingApproval, approved, paid, onHold, rejected,
 *            pendingCollection (legacy), ytdTotal, retentionBonusTotal, breakdown }
 */
function calcRepCommissions(repId) {
  const allOpps = getGlobalOpps();
  const repOpps = allOpps.filter(o => o.repId === repId && o.status === 'Sold / Activation');
  const repObj  = REPS.find(r => r.id === repId);
  const planId  = repObj?.commissionPlan || 'ryan';

  let totalEarned = 0;         // legacy: collected+approved
  let pendingCollection = 0;   // legacy: sold but not collected
  let approvedTotal = 0;       // lifecycle: approved (not yet paid)
  let paidTotal = 0;           // lifecycle: paid out
  let pendingApprovalTotal = 0;// lifecycle: awaiting approval
  let onHoldTotal = 0;
  let rejectedTotal = 0;
  let retentionBonusTotal = 0;
  let breakdown = [];

  repOpps.forEach(o => {
    const result = calculateCommission({
      planId,
      workType:   o.workType   || 'landscape',
      leadSource: o.leadSource || 'company_lead',
      jobValue:   parseFloat(o.jobValue || o.budget?.replace(/[^0-9.]/g, '') || 0),
      collected:  !!o.collected,
      approved:   !!o.commissionApproved,
      preview:    true
    });

    // Resolve lifecycle status
    const lcStatus = getCommissionStatus(o);

    // Bucket by lifecycle status
    switch (lcStatus) {
      case 'paid':              paidTotal             += result.amount; break;
      case 'approved':          approvedTotal         += result.amount; break;
      case 'on_hold':           onHoldTotal           += result.amount; break;
      case 'rejected':          rejectedTotal         += result.amount; break;
      default:                  pendingApprovalTotal  += result.amount; break;
    }

    // Legacy buckets (for backwards-compat with existing dashboard cards)
    if (o.collected) totalEarned       += result.amount;
    else             pendingCollection += result.amount;

    // Retention bonus tracking
    if (result.retentionBonus > 0 && lcStatus === 'paid') {
      retentionBonusTotal += result.retentionBonus;
    }

    breakdown.push({ opp: o, result, lcStatus });
  });

  const ytdTotal = paidTotal + approvedTotal + pendingApprovalTotal;
  return {
    // Legacy (still used by dashboard summary cards)
    totalEarned, pendingCollection,
    // Lifecycle buckets
    paidTotal, approvedTotal, pendingApprovalTotal, onHoldTotal, rejectedTotal,
    ytdTotal, retentionBonusTotal,
    breakdown
  };
}

// ── Global opps bridge ────────────────────────────────────────────────────────
function getGlobalOpps() {
  try {
    const s = JSON.parse(localStorage.getItem('avalonSalesHubStateV3') || '{}');
    return s.opportunities || [];
  } catch(e) { return []; }
}

function getRepOpps(repId) {
  const all = getGlobalOpps();
  if (!repId || repId === 'all') return all;
  return all.filter(o => o.repId === repId);
}

// ── Helper ────────────────────────────────────────────────────────────────────
function genId() { return Math.random().toString(36).slice(2,10); }

function fmtCurrency(n) {
  if (!n && n !== 0) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtPercent(r) {
  if (r === null || r === undefined) return '—';
  return Math.round(r * 100) + '%';
}

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

// ── LOGIN SCREEN ──────────────────────────────────────────────────────────────
function renderLoginScreen() {
  document.body.innerHTML = `
  <div style="min-height:100vh;background:#0a0f1a;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <div style="width:min(420px,95vw);padding:0 20px">

      <!-- Logo / Brand -->
      <div style="text-align:center;margin-bottom:40px">
        <img src="/static/avalon-logo.png" alt="Avalon" style="width:80px;height:80px;object-fit:contain;border-radius:16px;background:#0f172a;padding:8px;margin-bottom:16px">
        <h1 style="color:#e2e8f0;font-size:24px;font-weight:800;margin:0">Avalon Sales Hub</h1>
        <p style="color:#64748b;font-size:14px;margin:6px 0 0">Select your name to continue</p>
      </div>

      <!-- Rep Cards -->
      <div style="display:flex;flex-direction:column;gap:12px;margin-bottom:32px" id="repCards">
        ${REPS.map(rep => `
        <button onclick="selectRep('${rep.id}')"
          style="display:flex;align-items:center;gap:16px;padding:16px 20px;background:#0f172a;border:2px solid #1e293b;border-radius:14px;cursor:pointer;text-align:left;transition:all .15s;width:100%"
          onmouseover="this.style.borderColor='${rep.color}';this.style.background='#111827'"
          onmouseout="this.style.borderColor='#1e293b';this.style.background='#0f172a'">
          <span style="font-size:18px;font-weight:700;width:48px;height:48px;display:flex;align-items:center;justify-content:center;background:${rep.color}22;border:2px solid ${rep.color}66;border-radius:12px;color:${rep.color}">${rep.name[0]}</span>
          <div>
            <div style="font-weight:700;font-size:16px;color:#e2e8f0">${rep.name}</div>
            <div style="font-size:12px;color:#64748b;margin-top:2px">${rep.title}</div>
          </div>
          <div style="margin-left:auto;width:10px;height:10px;border-radius:50%;background:${rep.color}"></div>
        </button>
        `).join('')}
      </div>

      <!-- PIN Entry (hidden until rep selected) -->
      <div id="pinEntry" style="display:none;background:#0f172a;border-radius:16px;padding:24px;border:1px solid #1e293b">
        <div style="text-align:center;margin-bottom:20px">
          <div id="pinRepName" style="font-size:18px;font-weight:700;color:#e2e8f0"></div>
          <div style="font-size:13px;color:#64748b;margin-top:4px">Enter your PIN</div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-bottom:16px" id="pinDisplay">
          <div id="pin0" style="height:12px;border-radius:6px;background:#1e293b"></div>
          <div id="pin1" style="height:12px;border-radius:6px;background:#1e293b"></div>
          <div id="pin2" style="height:12px;border-radius:6px;background:#1e293b"></div>
          <div id="pin3" style="height:12px;border-radius:6px;background:#1e293b"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
          ${[1,2,3,4,5,6,7,8,9,'','0','⌫'].map(k => `
            <button onclick="pinKey('${k}')"
              style="padding:18px;background:#1e293b;border:none;border-radius:12px;color:#e2e8f0;font-size:20px;font-weight:600;cursor:pointer;${k===''?'visibility:hidden':''}"
              onmouseover="this.style.background='#334155'" onmouseout="this.style.background='#1e293b'">
              ${k}
            </button>
          `).join('')}
        </div>
        <div id="pinError" style="color:#f87171;font-size:13px;text-align:center;margin-top:12px;display:none">Incorrect PIN — try again</div>
        <button onclick="backToReps()" style="width:100%;margin-top:16px;padding:10px;background:transparent;border:1px solid #334155;border-radius:10px;color:#64748b;font-size:14px;cursor:pointer">
          ← Back
        </button>
      </div>

      <p style="text-align:center;color:#1e293b;font-size:11px;margin-top:24px">Internal use only · Avalon Landscape Construction</p>
    </div>
  </div>
  `;

  // PIN logic
  let selectedRepId = null;
  let pinBuffer = '';
  const REP_COLOR = {};
  REPS.forEach(r => REP_COLOR[r.id] = r.color);

  window.selectRep = function(repId) {
    selectedRepId = repId;
    pinBuffer = '';
    const rep = REPS.find(r => r.id === repId);
    document.getElementById('repCards').style.display = 'none';
    document.getElementById('pinEntry').style.display = 'block';
    document.getElementById('pinRepName').textContent = rep.name;
    document.getElementById('pinRepName').style.color = REP_COLOR[repId];
    updatePinDisplay();
    document.getElementById('pinError').style.display = 'none';
  };

  window.backToReps = function() {
    document.getElementById('repCards').style.display = 'flex';
    document.getElementById('repCards').style.flexDirection = 'column';
    document.getElementById('pinEntry').style.display = 'none';
    selectedRepId = null;
    pinBuffer = '';
  };

  window.pinKey = function(k) {
    if (k === '') return;
    if (k === '⌫') { pinBuffer = pinBuffer.slice(0, -1); updatePinDisplay(); return; }
    if (pinBuffer.length >= 4) return;
    pinBuffer += k;
    updatePinDisplay();
    if (pinBuffer.length === 4) {
      setTimeout(() => attemptLogin(selectedRepId, pinBuffer), 300);
    }
  };

  function updatePinDisplay() {
    for (let i = 0; i < 4; i++) {
      const el = document.getElementById(`pin${i}`);
      if (el) {
        const rep = selectedRepId ? REPS.find(r => r.id === selectedRepId) : null;
        el.style.background = i < pinBuffer.length ? (rep?.color || '#00d4ff') : '#1e293b';
      }
    }
  }

  function attemptLogin(repId, pin) {
    const rep = REPS.find(r => r.id === repId);
    if (rep && rep.pin === pin) {
      loginRep(repId);
      initApp(); // Go to main app
    } else {
      pinBuffer = '';
      updatePinDisplay();
      document.getElementById('pinError').style.display = 'block';
      document.querySelector('#pinEntry').style.borderColor = '#ef4444';
      setTimeout(() => {
        document.getElementById('pinError').style.display = 'none';
        document.querySelector('#pinEntry').style.borderColor = '#1e293b';
      }, 1500);
    }
  }
}

// ── REP DASHBOARD VIEW ────────────────────────────────────────────────────────
function repDashboard() {
  const currentRep = getCurrentRep();
  if (!currentRep) { renderLoginScreen(); return; }

  const viewEl = document.getElementById('view');
  if (!viewEl) return;

  const isAdminUser = currentRep.role === 'admin';
  const isOMUser    = currentRep.role === 'office_manager';

  if (isAdminUser) {
    renderAdminDashboard(viewEl);
  } else if (isOMUser) {
    renderOMDashboard(viewEl, currentRep);
  } else {
    renderRepDashboard(viewEl, currentRep);
  }
}

function renderRepDashboard(viewEl, rep) {
  const opps = getRepOpps(rep.id);
  const open = opps.filter(o => !['Sold / Activation','Closed Lost'].includes(o.status));
  const sold = opps.filter(o => o.status === 'Sold / Activation');
  const lost = opps.filter(o => o.status === 'Closed Lost');
  const overdue = open.filter(o => o.nextFollowUp && o.nextFollowUp < todayISO());
  const { totalEarned, pendingCollection, breakdown,
          paidTotal, approvedTotal, pendingApprovalTotal, onHoldTotal, rejectedTotal,
          ytdTotal, retentionBonusTotal } = calcRepCommissions(rep.id);

  // Weekly activity from repState
  const repState = loadRepState(rep.id);
  const weeklyActivity = repState.weeklyActivity || {};
  const weekTargets = COMMISSION_PLANS.ryan.weeklyTargets;

  const activityLog = (repState.activityLog || []).slice(0, 8);

  viewEl.innerHTML = `
<div class="eyebrow" style="color:${rep.color}">${rep.name}</div>
<h1 style="margin-bottom:4px">My Dashboard</h1>
<p class="lede" style="margin-bottom:24px">${rep.title} · <button onclick="logoutRep();renderLoginScreen()" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:14px;text-decoration:underline">Switch Rep</button></p>

<!-- Commission Summary -->
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:28px">
  <div style="background:linear-gradient(135deg,#0c2a1a,#0f172a);border:1px solid #16a34a;border-radius:14px;padding:18px;text-align:center">
    <div style="font-size:11px;font-weight:700;color:#86efac;letter-spacing:.06em;text-transform:uppercase">Commissions Earned</div>
    <div style="font-size:28px;font-weight:800;color:#4ade80;margin-top:8px">${fmtCurrency(totalEarned)}</div>
    <div style="font-size:11px;color:#64748b;margin-top:4px">Collected & confirmed</div>
  </div>
  <div style="background:linear-gradient(135deg,#1a1a0c,#0f172a);border:1px solid #ca8a04;border-radius:14px;padding:18px;text-align:center">
    <div style="font-size:11px;font-weight:700;color:#fde68a;letter-spacing:.06em;text-transform:uppercase">Pending Collection</div>
    <div style="font-size:28px;font-weight:800;color:#fbbf24;margin-top:8px">${fmtCurrency(pendingCollection)}</div>
    <div style="font-size:11px;color:#64748b;margin-top:4px">Sold, awaiting payment</div>
  </div>
  <div style="background:#0f172a;border:1px solid #1e293b;border-radius:14px;padding:18px;text-align:center">
    <div style="font-size:11px;font-weight:700;color:#94a3b8;letter-spacing:.06em;text-transform:uppercase">Open Opportunities</div>
    <div style="font-size:28px;font-weight:800;color:#e2e8f0;margin-top:8px">${open.length}</div>
    <div style="font-size:11px;color:#64748b;margin-top:4px">${overdue.length > 0 ? `<span style="color:#f87171">${overdue.length} overdue</span>` : 'All current'}</div>
  </div>
  <div style="background:#0f172a;border:1px solid #1e293b;border-radius:14px;padding:18px;text-align:center">
    <div style="font-size:11px;font-weight:700;color:#94a3b8;letter-spacing:.06em;text-transform:uppercase">Sold This Year</div>
    <div style="font-size:28px;font-weight:800;color:#e2e8f0;margin-top:8px">${sold.length}</div>
    <div style="font-size:11px;color:#64748b;margin-top:4px">${fmtCurrency(sold.reduce((a,o) => a + parseFloat(o.jobValue || 0), 0))} total value</div>
  </div>
</div>

<!-- Two-column layout -->
<div class="grid grid-2" style="gap:24px;margin-bottom:28px">

  <!-- My Pipeline -->
  <section class="card">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <h2 style="margin:0;font-size:16px">My Active Pipeline</h2>
      <button class="secondary-btn" onclick="show('pipeline')" style="font-size:12px">View All</button>
    </div>
    ${open.slice(0,6).map(o => repOppMiniCard(o)).join('') || '<p style="color:var(--muted);font-size:13px">No open opportunities yet. <button class="primary-btn" onclick="show(\'lead\')" style="margin-left:8px;padding:4px 12px;font-size:12px">+ New Lead</button></p>'}
    ${open.length > 6 ? `<p style="color:var(--muted);font-size:12px;text-align:center;margin-top:8px">+ ${open.length - 6} more in pipeline</p>` : ''}
  </section>

  <!-- Weekly Scoreboard -->
  <section class="card">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <h2 style="margin:0;font-size:16px">Weekly Activity</h2>
      <span style="font-size:11px;color:var(--muted)">Week of ${weekOf()}</span>
    </div>
    ${renderWeeklyScoreboard(rep.id, weeklyActivity, weekTargets)}
    <button class="secondary-btn" onclick="openWeeklyTracker('${rep.id}')" style="width:100%;margin-top:14px;font-size:13px">Log Today's Activity</button>
  </section>

</div>

<!-- Commission Breakdown -->
<section class="card" style="margin-bottom:28px">
  <h2 style="margin:0 0 16px;font-size:16px">Commission Breakdown — Sold Jobs</h2>
  ${breakdown.length === 0 ? `<p style="color:var(--muted);font-size:13px">No sold jobs yet. Close your first deal to start earning!</p>` :
    `<div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="border-bottom:1px solid #1e293b">
          <th style="text-align:left;padding:8px 12px;color:#64748b;font-weight:600">Client</th>
          <th style="text-align:left;padding:8px 12px;color:#64748b;font-weight:600">Type</th>
          <th style="text-align:left;padding:8px 12px;color:#64748b;font-weight:600">Lead Source</th>
          <th style="text-align:right;padding:8px 12px;color:#64748b;font-weight:600">Job Value</th>
          <th style="text-align:right;padding:8px 12px;color:#64748b;font-weight:600">Rate</th>
          <th style="text-align:right;padding:8px 12px;color:#64748b;font-weight:600">Commission</th>
          <th style="text-align:center;padding:8px 12px;color:#64748b;font-weight:600">Status</th>
        </tr>
      </thead>
      <tbody>
        ${breakdown.map(({ opp, result, lcStatus }) => {
          const statusColor = getCommissionStatusColor(lcStatus);
          const statusLabel = getCommissionStatusLabel(lcStatus);
          const capBadge = result.capApplied ? `<span style="font-size:9px;background:#f87171;color:#fff;border-radius:10px;padding:1px 5px;margin-left:4px">CAPPED</span>` : '';
          const bonusBadge = result.retentionBonus > 0 && lcStatus === 'paid'
            ? `<span style="font-size:9px;background:#16a34a;color:#fff;border-radius:10px;padding:1px 5px;margin-left:4px">+${fmtCurrency(result.retentionBonus)} bonus</span>` : '';

          // COMM-15: Collection gate display — show what they'd earn + clear gate message
          const gateInfo = window.getCollectionGateInfo ? window.getCollectionGateInfo(opp, result) : null;
          const gateRow = gateInfo && gateInfo.held ? `
        <tr>
          <td colspan="7" style="padding:2px 12px 10px">
            <div style="display:inline-flex;align-items:center;gap:6px;background:#1c1412;border:1px solid #f59e0b40;border-radius:6px;padding:4px 10px">
              <span style="font-size:10px;color:#f59e0b">⏳</span>
              <span style="font-size:10px;color:#f59e0b">${gateInfo.reason}</span>
              ${gateInfo.preview > 0 ? `<span style="font-size:10px;color:#64748b">Earns ${fmtCurrency(gateInfo.preview)} once collected.</span>` : ''}
            </div>
          </td>
        </tr>` : '';

          return `
        <tr style="border-bottom:1px solid #0f172a;cursor:pointer" onclick="show('pipeline','${opp.id}')"
          onmouseover="this.style.background='#0f172a'" onmouseout="this.style.background=''">
          <td style="padding:10px 12px;font-weight:600">${escapeHtml(opp.client)}</td>
          <td style="padding:10px 12px;color:#94a3b8">${formatWorkType(opp.workType)}</td>
          <td style="padding:10px 12px;color:#94a3b8">${formatLeadSource(opp.leadSource)}</td>
          <td style="padding:10px 12px;text-align:right">${fmtCurrency(opp.jobValue)}</td>
          <td style="padding:10px 12px;text-align:right;color:${rep.color}">${fmtPercent(result.rate)}</td>
          <td style="padding:10px 12px;text-align:right;font-weight:700;color:${statusColor}">${fmtCurrency(result.amount)}${capBadge}${bonusBadge}</td>
          <td style="padding:10px 12px;text-align:center">
            <span style="background:${statusColor}22;color:${statusColor};padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;border:1px solid ${statusColor}40">${statusLabel}</span>
          </td>
        </tr>
        <tr>
          <td colspan="7" style="padding:0 12px 4px;font-size:11px;color:#64748b">${escapeHtml(result.note)}</td>
        </tr>
        ${gateRow}`;
        }).join('')}
      </tbody>
    </table></div>`}
</section>

<!-- COMM-13: Rep Payout View — by lifecycle status with YTD totals + retention bonuses -->
<section class="card" style="margin-bottom:28px">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
    <h2 style="margin:0;font-size:16px">My Commission Payouts</h2>
    <span style="font-size:11px;color:#64748b">YTD · All sold jobs</span>
  </div>

  <!-- YTD Summary Chips -->
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:20px">
    ${[
      { label:'Paid Out',        val: paidTotal,            color:'#4ade80', status:'paid' },
      { label:'Approved',        val: approvedTotal,        color:'#00d4ff', status:'approved' },
      { label:'Pending Approval',val: pendingApprovalTotal, color:'#f59e0b', status:'pending_approval' },
      { label:'On Hold',         val: onHoldTotal,          color:'#f59e0b', status:'on_hold' },
      { label:'Retention Bonus', val: retentionBonusTotal,  color:'#4ade80', status:null }
    ].filter(b => b.val > 0).map(b => `
    <div style="background:${b.color}12;border:1px solid ${b.color}40;border-radius:10px;padding:12px;text-align:center">
      <div style="font-size:9px;font-weight:700;color:${b.color};text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">${b.label}</div>
      <div style="font-size:20px;font-weight:800;color:${b.color}">${fmtCurrency(b.val)}</div>
    </div>`).join('') || '<div style="color:#64748b;font-size:13px">No commissions yet — close your first deal!</div>'}
  </div>

  <!-- Buckets by status -->
  ${['paid','approved','pending_approval','pending_reapproval','on_hold','rejected'].map(status => {
    const items = breakdown.filter(b => b.lcStatus === status);
    if (!items.length) return '';
    const label = getCommissionStatusLabel(status);
    const color = getCommissionStatusColor(status);
    const subtotal = items.reduce((a, b) => a + b.result.amount, 0);
    return `
  <div style="margin-bottom:16px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <span style="font-size:12px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:.04em">${label}</span>
      <span style="font-size:12px;font-weight:700;color:${color}">${fmtCurrency(subtotal)}</span>
    </div>
    ${items.map(({ opp, result, lcStatus: s }) => {
      const capBadge = result.capApplied ? `<span style="font-size:9px;background:#f87171;color:#fff;border-radius:10px;padding:1px 5px;margin-left:4px">CAPPED</span>` : '';
      const bonusEl = result.retentionBonus > 0
        ? `<div style="font-size:10px;color:#4ade80;margin-top:2px">${s === 'paid' ? '✓' : '○'} ${fmtCurrency(result.retentionBonus)} retention bonus ${s === 'paid' ? 'earned' : 'after 90-day active'}</div>` : '';
      // COMM-15: collection gate badge on payout cards
      const gateInfo = window.getCollectionGateInfo ? window.getCollectionGateInfo(opp, result) : null;
      const gateEl   = gateInfo && gateInfo.held
        ? `<div style="display:flex;align-items:center;gap:5px;margin-top:4px"><span style="font-size:10px;color:#f59e0b">⏳ ${gateInfo.reason}</span>${gateInfo.preview > 0 ? `<span style="font-size:10px;color:#64748b">Earns ${fmtCurrency(gateInfo.preview)} once collected.</span>` : ''}</div>` : '';
      return `
    <div onclick="show('pipeline','${opp.id}')" style="display:flex;align-items:flex-start;justify-content:space-between;padding:10px 12px;background:#0f172a;border-radius:8px;margin-bottom:5px;cursor:pointer;border:1px solid ${gateInfo && gateInfo.held ? '#f59e0b30' : '#1e293b'}"
      onmouseover="this.style.borderColor='${color}40'" onmouseout="this.style.borderColor='${gateInfo && gateInfo.held ? '#f59e0b30' : '#1e293b'}'">
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:13px">${escapeHtml(opp.client || 'Unnamed')}</div>
        <div style="font-size:11px;color:#64748b;margin-top:2px">${formatWorkType(opp.workType)} · ${formatLeadSource(opp.leadSource)}</div>
        <div style="font-size:10px;color:#475569;margin-top:3px">${escapeHtml(result.note)}</div>
        ${bonusEl}${gateEl}
      </div>
      <div style="text-align:right;flex-shrink:0;margin-left:12px">
        <div style="font-size:14px;font-weight:800;color:${color}">${fmtCurrency(result.amount)}${capBadge}</div>
        <div style="font-size:10px;color:#64748b">${fmtCurrency(opp.jobValue)}</div>
      </div>
    </div>`;
    }).join('')}
  </div>`;
  }).join('')}

  ${breakdown.length === 0 ? '<p style="color:#64748b;font-size:13px">No sold jobs yet.</p>' : ''}
</section>

<!-- Commission Plan Quick Reference -->
<section class="card">
  <h2 style="margin:0 0 16px;font-size:16px">My Commission Plan</h2>
  ${renderCommissionPlanRef(rep.commissionPlan)}
</section>

<!-- Weekly Activity Log Modal (hidden) -->
<div id="weeklyTrackerModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:1000;align-items:center;justify-content:center">
  <div style="background:#1e293b;border-radius:16px;padding:28px;width:min(480px,95vw);max-height:90vh;overflow-y:auto;position:relative">
    <button onclick="document.getElementById('weeklyTrackerModal').style.display='none'"
      style="position:absolute;top:12px;right:12px;background:transparent;border:none;color:#64748b;font-size:20px;cursor:pointer">×</button>
    <h2 style="margin:0 0 20px;font-size:18px">Log This Week's Activity</h2>
    <div style="display:flex;flex-direction:column;gap:14px">
      ${Object.entries(weekTargets).map(([key, target]) => `
      <div>
        <label style="font-size:12px;font-weight:600;color:var(--muted)">${formatActivityKey(key)} <span style="color:#64748b;font-weight:400">(target: ${target})</span></label>
        <input type="number" id="wa_${key}" min="0"
          value="${weeklyActivity[key] || ''}"
          placeholder="0"
          style="width:100%;margin-top:6px;padding:10px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:14px;box-sizing:border-box">
      </div>
      `).join('')}
      <button class="primary-btn" onclick="saveWeeklyActivity('${rep.id}')" style="margin-top:8px">Save Activity Log</button>
    </div>
  </div>
</div>
`;

  // Expose modal helper
  window.openWeeklyTracker = function() {
    document.getElementById('weeklyTrackerModal').style.display = 'flex';
  };

  window.saveWeeklyActivity = function(repId) {
    const data = {};
    Object.keys(weekTargets).forEach(key => {
      const el = document.getElementById(`wa_${key}`);
      if (el) data[key] = parseInt(el.value) || 0;
    });
    saveRepState(repId, { weeklyActivity: data });
    if (window.showToast) window.showToast('Activity saved');
    document.getElementById('weeklyTrackerModal').style.display = 'none';
    repDashboard();
  };
}

function repOppMiniCard(o) {
  const stageColors = {
    'New Lead': '#6366f1', 'Contacted': '#8b5cf6', 'Meeting Set': '#3b82f6',
    'Proposal / Estimate Sent': '#f59e0b', 'Negotiation': '#ef4444', 'Sold / Activation': '#10b981'
  };
  const color = stageColors[o.status] || '#64748b';
  const overdue = o.nextFollowUp && o.nextFollowUp < todayISO();
  return `
  <div onclick="show('pipeline','${o.id}')" style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:#0f172a;border-radius:10px;margin-bottom:8px;cursor:pointer;border:1px solid ${overdue ? '#7f1d1d' : '#1e293b'}"
    onmouseover="this.style.background='#131d2e'" onmouseout="this.style.background='#0f172a'">
    <div style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0"></div>
    <div style="flex:1;min-width:0">
      <div style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(o.client)}</div>
      <div style="font-size:11px;color:#64748b;margin-top:1px">${escapeHtml(o.serviceLine || o.status)} · ${o.clientType || ''}${o.nextFollowUp ? ' · ' + formatDate(o.nextFollowUp) : ''}</div>
    </div>
    ${overdue ? '<span style="font-size:10px;color:#f87171;font-weight:700;flex-shrink:0">OVERDUE</span>' : ''}
    ${o.jobValue ? `<span style="font-size:12px;color:#94a3b8;flex-shrink:0">${fmtCurrency(o.jobValue)}</span>` : ''}
  </div>`;
}

function renderWeeklyScoreboard(repId, actual, targets) {
  const keys = Object.keys(targets);
  return `<div style="display:flex;flex-direction:column;gap:10px">
    ${keys.map(key => {
      const val = actual[key] || 0;
      const t = targets[key];
      // Support both new structured format {target, label, description, floor} and old string format
      const targetNum = (t && typeof t === 'object') ? (t.target || 0) : (parseInt((t + '').split('-').pop()) || 1);
      const label = (t && t.label) ? t.label : formatActivityKey(key);
      const isFloor = (t && t.floor);
      // For floor KPIs (e.g. stale deals = 0 is good), invert the logic
      const pct = isFloor
        ? (val === 0 ? 100 : Math.max(0, 100 - Math.round((val / Math.max(targetNum, 1)) * 100)))
        : (targetNum > 0 ? Math.min(100, Math.round((val / targetNum) * 100)) : 0);
      const color = pct >= 100 ? '#4ade80' : pct >= 60 ? '#fbbf24' : '#f87171';
      const displayTarget = isFloor ? '0 stale' : targetNum + '/wk';
      return `<div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px">
          <span style="font-size:12px;color:#94a3b8">${label}</span>
          <span style="font-size:12px;font-weight:700;color:${color}">${val} <span style="color:#334155;font-weight:400">/ ${displayTarget}</span></span>
        </div>
        <div style="height:5px;background:#1e293b;border-radius:3px">
          <div style="height:5px;width:${pct}%;background:${color};border-radius:3px;transition:width .4s"></div>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

function renderCommissionPlanRef(planId) {
  if (planId === 'admin') return '<p style="color:var(--muted)">Owner account — no commission plan.</p>';
  if (!planId) return '<p style="color:var(--muted)">No commission plan assigned.</p>';
  const override = loadActiveCommissionRules();
  const plan = (override && override.plans && override.plans[planId]) ? override.plans[planId] : COMMISSION_PLANS[planId];
  if (!plan) return '<p style="color:var(--muted)">Commission plan not found.</p>';

  const thStyle = 'padding:9px 10px;text-align:center;border-bottom:1px solid #1e293b;font-size:11px;font-weight:700;letter-spacing:.04em';
  const tdStyle = 'padding:8px 10px;text-align:center;font-weight:700;font-size:13px';
  const rowStyle = 'border-bottom:1px solid #0f172a';
  const lStyle = 'padding:8px 10px;font-size:12px;color:#94a3b8';

  // Landscape tiers
  const lTiers = plan.landscape.tiers;
  const softCap = plan.landscape.softApprovalPayoutThreshold || 1500;
  const hardCap = plan.landscape.hardCapPayout || 2500;

  const landscapeRows = lTiers.map(t => {
    const label = t.max ? `$${t.min.toLocaleString()} – $${t.max.toLocaleString()}` : `$${t.min.toLocaleString()}+`;
    if (t.selfGen === null || t.selfGen === undefined) {
      return `<tr style="${rowStyle}"><td style="${lStyle}">${label}</td><td colspan="3" style="${tdStyle};color:#f59e0b">Management approval — contact Tyler</td></tr>`;
    }
    return `<tr style="${rowStyle}">
      <td style="${lStyle}">${label}</td>
      <td style="${tdStyle};color:#4ade80">${Math.round(t.selfGen*100)}%</td>
      <td style="${tdStyle};color:#60a5fa">${Math.round(t.companyLead*100)}%</td>
      <td style="${tdStyle};color:#94a3b8">${Math.round(t.assisted*100)}%</td>
    </tr>`;
  }).join('');

  // Maintenance recurring
  const rec = plan.maintenance.recurring;
  function recRow(key, label, color) {
    const r = rec[key];
    if (!r) return '';
    return `<tr style="${rowStyle}">
      <td style="${lStyle}">${label}</td>
      <td style="${tdStyle};color:${color};font-size:11px">${Math.round(r.t1Rate*100)}% / ${Math.round(r.t2Rate*100)}% / ${Math.round(r.t3Rate*100)}%<br><span style="color:#64748b;font-weight:500">Cap $${r.cap} · +$${r.retentionBonus} bonus</span></td>
    </tr>`;
  }

  // Maintenance one-time
  const ot = plan.maintenance.oneTime;

  return `
  <div style="overflow-x:auto;display:flex;flex-direction:column;gap:16px">

    <!-- Landscape / Enhancement -->
    <div>
      <div style="font-size:10px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px">Landscape / Enhancement / Hardscape</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;background:#0f172a;border-radius:8px;overflow:hidden">
        <thead><tr style="background:#1e293b">
          <th style="${thStyle};text-align:left;color:#64748b">Job Value Range</th>
          <th style="${thStyle};color:#4ade80">Self-Generated</th>
          <th style="${thStyle};color:#60a5fa">Company Lead</th>
          <th style="${thStyle};color:#94a3b8">Assisted</th>
        </tr></thead>
        <tbody>${landscapeRows}</tbody>
      </table>
      <div style="font-size:11px;color:#475569;margin-top:6px;padding:0 2px">
        Soft approval at <strong style="color:#f59e0b">$${softCap.toLocaleString()} payout</strong> · Hard cap <strong style="color:#f87171">$${hardCap.toLocaleString()}</strong> unless Tyler overrides
      </div>
    </div>

    <!-- Maintenance One-Time -->
    <div>
      <div style="font-size:10px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px">Maintenance — One-Time / Seasonal</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;background:#0f172a;border-radius:8px;overflow:hidden">
        <thead><tr style="background:#1e293b">
          <th style="${thStyle};text-align:left;color:#64748b">Type</th>
          <th style="${thStyle};color:#4ade80">Self-Generated</th>
          <th style="${thStyle};color:#60a5fa">Company Lead</th>
          <th style="${thStyle};color:#94a3b8">Assisted</th>
        </tr></thead>
        <tbody>
          <tr>
            <td style="${lStyle}">One-time / Seasonal</td>
            <td style="${tdStyle};color:#4ade80">${Math.round(ot.selfGen*100)}%</td>
            <td style="${tdStyle};color:#60a5fa">${Math.round(ot.companyLead*100)}%</td>
            <td style="${tdStyle};color:#94a3b8">${Math.round(ot.assisted*100)}%</td>
          </tr>
        </tbody>
      </table>
      <div style="font-size:11px;color:#475569;margin-top:6px;padding:0 2px">Approval required when payout exceeds <strong style="color:#f59e0b">$${(ot.approvalAbove||750).toLocaleString()}</strong></div>
    </div>

    <!-- Recurring Maintenance -->
    <div>
      <div style="font-size:10px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px">Recurring Maintenance — First-Month Tiered Payout</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;background:#0f172a;border-radius:8px;overflow:hidden">
        <thead><tr style="background:#1e293b">
          <th style="${thStyle};text-align:left;color:#64748b">Source</th>
          <th style="${thStyle};color:#e2e8f0">First $1K / Next $1K / Above — Cap · Bonus</th>
        </tr></thead>
        <tbody>
          ${recRow('selfGen',     'Self-Generated',  '#4ade80')}
          ${recRow('companyLead', 'Company Lead',    '#60a5fa')}
          ${recRow('assisted',    'Assisted',        '#94a3b8')}
        </tbody>
      </table>
      <div style="font-size:11px;color:#475569;margin-top:6px;padding:0 2px">Retention bonus paid after client remains active 90+ days · Paid after 60-day active period</div>
    </div>

    <p style="font-size:11px;color:#475569;margin:0;padding:10px;background:#0a0f1a;border-radius:8px;border:1px solid #1e293b">
      Commission paid only on approved, sold, and collected work. Pricing must be management-approved.
      ${override ? `<span style="color:#f59e0b"> ⚙ Custom rules active (edited ${new Date(override.updatedAt||'').toLocaleDateString()}).</span>` : ''}
    </p>
  </div>`;
}

// ── OFFICE MANAGER DASHBOARD ─────────────────────────────────────────────────
function renderOMDashboard(viewEl, rep) {
  const allOpps = getGlobalOpps();

  // Pipeline health counts — all reps (Jen sees the whole pipeline)
  const open   = allOpps.filter(o => !['Sold / Activation','Closed Lost'].includes(o.status));
  const sold   = allOpps.filter(o => o.status === 'Sold / Activation');
  const lost   = allOpps.filter(o => o.status === 'Closed Lost');
  const overdue = open.filter(o => o.nextFollowUp && o.nextFollowUp < todayISO());
  const needsFollowUp = open.filter(o => !o.nextFollowUp);
  const proposals = open.filter(o => ['Proposal / Estimate Sent','Follow-Up'].includes(o.status));
  const newLeads  = open.filter(o => o.status === 'New Lead' || o.status === 'Contacted');

  // Sort overdue by most overdue first
  const overdueList = [...overdue].sort((a,b) => a.nextFollowUp.localeCompare(b.nextFollowUp));
  // Proposals needing chase (sent > 3 days ago with no future follow-up set)
  const today = todayISO();
  const chaseList = proposals.filter(o => !o.nextFollowUp || o.nextFollowUp <= today).slice(0, 8);

  // Unassigned leads — no repId set
  const unassigned = open.filter(o => !o.repId);

  viewEl.innerHTML = `
<div class="eyebrow" style="color:${rep.color}">${rep.name} · Office Manager</div>
<h1 style="margin-bottom:4px">Sales Operations Dashboard</h1>
<p class="lede" style="margin-bottom:24px">Pipeline health, follow-up queue, lead routing, and proposal status — for the whole team. <button onclick="logoutRep();renderLoginScreen()" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:14px;text-decoration:underline">Switch Account</button></p>

<!-- Pipeline Health Tiles -->
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:12px;margin-bottom:28px">
  <div class="dash-card-clickable" onclick="show('pipeline')" title="View all open opportunities"
    style="background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:16px;text-align:center;cursor:pointer"
    onmouseover="this.style.background='#1e293b'" onmouseout="this.style.background='#0f172a'">
    <div style="font-size:10px;font-weight:700;color:#94a3b8;letter-spacing:.06em;text-transform:uppercase">Open Opps</div>
    <div style="font-size:26px;font-weight:800;color:#e2e8f0;margin-top:6px">${open.length}</div>
    <div style="font-size:11px;color:#64748b;margin-top:2px">Active pipeline</div>
  </div>
  <div class="dash-card-clickable" onclick="show('pipeline')" title="View overdue follow-ups"
    style="background:${overdue.length > 0 ? 'linear-gradient(135deg,#2a0a0a,#0f172a)' : '#0f172a'};border:1px solid ${overdue.length > 0 ? '#7f1d1d' : '#1e293b'};border-radius:12px;padding:16px;text-align:center;cursor:pointer"
    onmouseover="this.style.opacity='0.85'" onmouseout="this.style.opacity='1'">
    <div style="font-size:10px;font-weight:700;color:#94a3b8;letter-spacing:.06em;text-transform:uppercase">Overdue</div>
    <div style="font-size:26px;font-weight:800;color:${overdue.length > 0 ? '#f87171' : '#4ade80'};margin-top:6px">${overdue.length}</div>
    <div style="font-size:11px;color:#64748b;margin-top:2px">Past follow-up date</div>
  </div>
  <div class="dash-card-clickable" onclick="show('pipeline')" title="View proposals awaiting response"
    style="background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:16px;text-align:center;cursor:pointer"
    onmouseover="this.style.background='#1e293b'" onmouseout="this.style.background='#0f172a'">
    <div style="font-size:10px;font-weight:700;color:#94a3b8;letter-spacing:.06em;text-transform:uppercase">Proposals Out</div>
    <div style="font-size:26px;font-weight:800;color:#fbbf24;margin-top:6px">${proposals.length}</div>
    <div style="font-size:11px;color:#64748b;margin-top:2px">Awaiting response</div>
  </div>
  <div class="dash-card-clickable" onclick="show('pipeline')" title="View new leads not yet contacted"
    style="background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:16px;text-align:center;cursor:pointer"
    onmouseover="this.style.background='#1e293b'" onmouseout="this.style.background='#0f172a'">
    <div style="font-size:10px;font-weight:700;color:#94a3b8;letter-spacing:.06em;text-transform:uppercase">New Leads</div>
    <div style="font-size:26px;font-weight:800;color:#60a5fa;margin-top:6px">${newLeads.length}</div>
    <div style="font-size:11px;color:#64748b;margin-top:2px">Not yet contacted</div>
  </div>
  <div class="dash-card-clickable" onclick="show('pipeline')" title="View unassigned leads"
    style="background:#0f172a;border:1px solid ${unassigned.length > 0 ? '#f59e0b60' : '#1e293b'};border-radius:12px;padding:16px;text-align:center;cursor:pointer"
    onmouseover="this.style.background='#1e293b'" onmouseout="this.style.background='#0f172a'">
    <div style="font-size:10px;font-weight:700;color:#94a3b8;letter-spacing:.06em;text-transform:uppercase">Unassigned</div>
    <div style="font-size:26px;font-weight:800;color:${unassigned.length > 0 ? '#f59e0b' : '#4ade80'};margin-top:6px">${unassigned.length}</div>
    <div style="font-size:11px;color:#64748b;margin-top:2px">No rep assigned</div>
  </div>
  <div class="dash-card-clickable" onclick="show('pipeline')" title="View sold opportunities"
    style="background:linear-gradient(135deg,#0c2a1a,#0f172a);border:1px solid #16a34a;border-radius:12px;padding:16px;text-align:center;cursor:pointer"
    onmouseover="this.style.opacity='0.85'" onmouseout="this.style.opacity='1'">
    <div style="font-size:10px;font-weight:700;color:#86efac;letter-spacing:.06em;text-transform:uppercase">Sold</div>
    <div style="font-size:26px;font-weight:800;color:#4ade80;margin-top:6px">${sold.length}</div>
    <div style="font-size:11px;color:#64748b;margin-top:2px">${fmtCurrency(sold.reduce((a,o)=>a+parseFloat(o.jobValue||0),0))}</div>
  </div>
</div>

<!-- Two-column: Overdue + Chase List -->
<div class="grid grid-2" style="gap:20px;margin-bottom:24px">

  <!-- Overdue Follow-Ups -->
  <section class="card">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <h2 style="margin:0;font-size:15px">Overdue Follow-Ups</h2>
      <span style="font-size:11px;color:#f87171;font-weight:700">${overdueList.length} item${overdueList.length===1?'':'s'}</span>
    </div>
    ${overdueList.length === 0
      ? '<p style="color:#4ade80;font-size:13px">No overdue follow-ups — pipeline is current.</p>'
      : overdueList.slice(0, 8).map(o => `
        <div onclick="show('pipeline','${o.id}')" style="display:flex;align-items:center;gap:10px;padding:9px 11px;background:#0f172a;border:1px solid #7f1d1d;border-radius:9px;margin-bottom:7px;cursor:pointer"
          onmouseover="this.style.background='#1a0a0a'" onmouseout="this.style.background='#0f172a'">
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(o.client||'Unnamed')}</div>
            <div style="font-size:11px;color:#64748b;margin-top:1px">${escapeHtml(o.status)} · Due ${o.nextFollowUp}</div>
          </div>
          ${(()=>{ const _r=(window.REPS||[]).find(r=>r.id===o.repId); return _r ? `<span style="font-size:10px;font-weight:600;color:${_r.color||'#94a3b8'};background:${_r.color||'#94a3b8'}18;border:1px solid ${_r.color||'#94a3b8'}40;border-radius:20px;padding:1px 7px;white-space:nowrap;flex-shrink:0">${escapeHtml(_r.name)}</span>` : `<span style="font-size:10px;font-weight:600;color:#f59e0b;background:#f59e0b18;border:1px solid #f59e0b40;border-radius:20px;padding:1px 7px;white-space:nowrap;flex-shrink:0">⚠ Unassigned</span>`; })()}
          <span style="font-size:10px;color:#f87171;font-weight:700;white-space:nowrap">OVERDUE</span>
        </div>`).join('')}
    ${overdueList.length > 8 ? `<p style="font-size:12px;color:#64748b;text-align:center;margin-top:8px">+ ${overdueList.length - 8} more — <button class="link-btn" onclick="show('pipeline')" style="color:var(--accent);background:none;border:none;cursor:pointer;font-size:12px;padding:0">Open pipeline</button></p>` : ''}
  </section>

  <!-- Proposals to Chase -->
  <section class="card">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <h2 style="margin:0;font-size:15px">Proposals to Chase</h2>
      <span style="font-size:11px;color:#fbbf24;font-weight:700">${chaseList.length} pending</span>
    </div>
    ${chaseList.length === 0
      ? '<p style="color:#4ade80;font-size:13px">All proposals have a follow-up scheduled.</p>'
      : chaseList.map(o => `
        <div onclick="show('pipeline','${o.id}')" style="display:flex;align-items:center;gap:10px;padding:9px 11px;background:#0f172a;border:1px solid #1e293b;border-radius:9px;margin-bottom:7px;cursor:pointer"
          onmouseover="this.style.background='#131d2e'" onmouseout="this.style.background='#0f172a'">
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(o.client||'Unnamed')}</div>
            <div style="font-size:11px;color:#64748b;margin-top:1px">${escapeHtml(o.serviceLine||o.status)}${o.repId ? ' · ' + ((window.REPS||[]).find(r=>r.id===o.repId)?.name||'') : ' · unassigned'}</div>
          </div>
          ${o.jobValue ? `<span style="font-size:12px;color:#94a3b8;white-space:nowrap">${fmtCurrency(o.jobValue)}</span>` : ''}
        </div>`).join('')}
  </section>

</div>

<!-- Unassigned Leads + Quick Actions -->
<div class="grid grid-2" style="gap:20px;margin-bottom:24px">
  <section class="card">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <h2 style="margin:0;font-size:15px">Unassigned Leads</h2>
      <button class="primary-btn" onclick="show('lead')" style="font-size:12px;padding:6px 14px">+ New Lead</button>
    </div>
    ${unassigned.length === 0
      ? '<p style="color:#4ade80;font-size:13px">All open leads have a rep assigned.</p>'
      : unassigned.map(o => `
        <div onclick="show('pipeline','${o.id}')" style="display:flex;align-items:center;gap:10px;padding:9px 11px;background:#0f172a;border:1px solid #f59e0b40;border-radius:9px;margin-bottom:7px;cursor:pointer"
          onmouseover="this.style.background='#131d2e'" onmouseout="this.style.background='#0f172a'">
          
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(o.client||'Unnamed')}</div>
            <div style="font-size:11px;color:#64748b;margin-top:1px">${escapeHtml(o.status)} · ${escapeHtml(o.serviceLine||'No service line')}</div>
          </div>
          <span style="font-size:10px;color:#f59e0b;font-weight:700">ASSIGN</span>
        </div>`).join('')}
  </section>

  <section class="card">
    <h2 style="margin:0 0 14px;font-size:15px">Quick Actions</h2>
    <div style="display:flex;flex-direction:column;gap:10px">
      <button class="primary-btn" onclick="show('lead')" style="text-align:left;justify-content:flex-start">Add New Lead</button>
      <button class="secondary-btn" onclick="show('pipeline')" style="text-align:left;justify-content:flex-start">Open Full Pipeline</button>
      <button class="secondary-btn" onclick="show('templates')" style="text-align:left;justify-content:flex-start">Email il Templates</button>
      <button class="secondary-btn" onclick="show('forms','follow-up')" style="text-align:left;justify-content:flex-start">Follow-Up Cadence</button>
      <button class="secondary-btn" onclick="show('manager')" style="text-align:left;justify-content:flex-start">Manager Tools (View)</button>
      <button class="secondary-btn" onclick="show('settings')" style="text-align:left;justify-content:flex-start">Settings / Export</button>
    </div>
  </section>
</div>
`;
}

// ── ADMIN / OWNER DASHBOARD ──────────────────────────────────────────────────
function renderAdminDashboard(viewEl) {
  const allOpps  = getGlobalOpps();
  const today    = todayISO();
  const fy       = (typeof getResolvedFY === 'function') ? getResolvedFY() : ((window.AVALON_DATA || {}).fy2026 || {});
  const annual   = fy.annual || {};
  const divs     = fy.divisions || {};


  // ── Pipeline stats ──
  const openOpps   = allOpps.filter(o => !['Sold / Activation','Closed Lost'].includes(o.status));
  const soldOpps   = allOpps.filter(o => o.status === 'Sold / Activation');
  const lostOpps   = allOpps.filter(o => o.status === 'Closed Lost');
  const overdueList = openOpps.filter(o => o.nextFollowUp && o.nextFollowUp < today)
                              .sort((a,b) => a.nextFollowUp.localeCompare(b.nextFollowUp));
  const unassigned = openOpps.filter(o => !o.repId);
  const proposals  = openOpps.filter(o => ['Proposal / Estimate Sent','Follow-Up'].includes(o.status));
  const stale      = openOpps.filter(o => {
    if (!o.updatedAt) return false;
    return (Date.now() - new Date(o.updatedAt).getTime()) > 14 * 24 * 60 * 60 * 1000;
  });
  const soldValue  = soldOpps.reduce((a,o) => a + parseFloat(o.jobValue || 0), 0);
  const totalPipelineValue = openOpps.reduce((a,o) => a + parseFloat(o.jobValue || 0), 0);

  // Commission approval queue — sold opps not yet commission-approved
  // COMM-11: lifecycle-aware queue — pending_approval + pending_reapproval + on_hold
  const commQueue = soldOpps.filter(o => {
    const s = getCommissionStatus(o);
    return o.repId && ['pending_approval','pending_reapproval','on_hold','estimated'].includes(s);
  });
  // Approved queue (for mark-paid action)
  const commApproved = soldOpps.filter(o => {
    const s = getCommissionStatus(o);
    return o.repId && s === 'approved';
  });

  // ── Rep performance ──
  const repRows = REPS.filter(r => r.role === 'rep').map(rep => {
    const repOpps   = allOpps.filter(o => o.repId === rep.id);
    const repOpen   = repOpps.filter(o => !['Sold / Activation','Closed Lost'].includes(o.status));
    const repSold   = repOpps.filter(o => o.status === 'Sold / Activation');
    const repSoldVal = repSold.reduce((a,o) => a + parseFloat(o.jobValue || 0), 0);
    const repOverdue = repOpen.filter(o => o.nextFollowUp && o.nextFollowUp < today).length;
    const repProposals = repOpen.filter(o => ['Proposal / Estimate Sent','Follow-Up'].includes(o.status)).length;
    const { totalEarned, pendingCollection } = calcRepCommissions(rep.id);
    // Close rate
    const repTotal = repSold.length + lostOpps.filter(o => o.repId === rep.id).length;
    const closeRate = repTotal > 0 ? Math.round((repSold.length / repTotal) * 100) : null;
    // Quota progress (landscape revenue vs $525K target)
    const quotaTarget = 525000;
    const quotaPct = Math.min(100, Math.round((repSoldVal / quotaTarget) * 100));
    return { rep, open: repOpen.length, sold: repSold.length, soldValue: repSoldVal,
             totalEarned, pendingCollection, overdue: repOverdue, proposals: repProposals,
             closeRate, quotaPct };
  });

  // ── Helpers ──
  function fmtM(n) { return n != null ? n.toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}) : '—'; }
  function pbar(actual, target, color) {
    const pct = target > 0 ? Math.min(100, Math.round((actual / target) * 100)) : 0;
    const c = color || (pct >= 100 ? '#4ade80' : pct >= 70 ? '#fbbf24' : '#f87171');
    return `<div style="height:5px;background:#1e293b;border-radius:3px;margin-top:6px"><div style="height:5px;width:${pct}%;background:${c};border-radius:3px;transition:width .5s"></div></div><div style="font-size:10px;color:#64748b;margin-top:2px">${pct}% of target</div>`;
  }
  const DIV_SVG_ICONS = {
    landscape:   '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M9 15V9.5M9 9.5C9 9.5 5 9.5 3 5c3 0 6 2 6 4.5zm0 0c0 0 4 0 6-4.5-3 0-6 2-6 4.5z" stroke="#4ade80" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    maintenance: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M12.5 3a3 3 0 00-2.5 4.5L3.8 13.8a.8.8 0 001.2 1.2l6.5-5.7A3 3 0 0014 10a3 3 0 00-.5-1.5l-1.8 1.8-1.2-1.2 1.8-1.8A3 3 0 0012.5 3z" stroke="#22d3ee" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    snow:        '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M9 2.5v13M2.5 9h13M4.5 4.5l9 9M13.5 4.5l-9 9" stroke="#93c5fd" stroke-width="1.5" stroke-linecap="round"/><circle cx="9" cy="2.5" r="1" fill="#93c5fd"/><circle cx="9" cy="15.5" r="1" fill="#93c5fd"/><circle cx="2.5" cy="9" r="1" fill="#93c5fd"/><circle cx="15.5" cy="9" r="1" fill="#93c5fd"/></svg>',
  };
  function divCard(div, key) {
    if (!div || !div.target) return '';
    const abovePlan = div.remaining <= 0;
    const gmOk = div.grossMarginPct >= div.grossMarginFloor;
    const pct = Math.min(100, Math.round((div.actual / div.target) * 100));
    const barColor = pct >= 100 ? '#4ade80' : pct >= 70 ? '#fbbf24' : '#f87171';
    const divIconSvg = DIV_SVG_ICONS[key] || '';
    return `<div style="background:#0f172a;border:1px solid ${abovePlan ? '#16a34a' : '#1e293b'};border-radius:12px;padding:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="font-weight:700;font-size:14px;display:flex;align-items:center;gap:8px">${divIconSvg} ${div.name}</div>
        ${abovePlan ? '<span style="background:#16a34a;color:#fff;font-size:9px;font-weight:700;border-radius:20px;padding:2px 7px">ABOVE PLAN</span>' : ''}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px">
        <div><div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:.05em">Target</div><div style="font-size:1.1rem;font-weight:800;color:#e2e8f0">${fmtM(div.target)}</div></div>
        <div><div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:.05em">Actual</div><div style="font-size:1.1rem;font-weight:800;color:${abovePlan ? '#4ade80' : '#00d4ff'}">${fmtM(div.actual)}</div></div>
        <div><div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:.05em">GM Floor</div><div style="font-size:.95rem;font-weight:700;color:#f59e0b">${Math.round(div.grossMarginFloor * 100)}%</div></div>
        <div><div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:.05em">Actual GM</div><div style="font-size:.95rem;font-weight:700;color:${gmOk ? '#4ade80' : '#f87171'}">${Math.round(div.grossMarginPct * 100)}% ${gmOk ? '+' : '!'}</div></div>
      </div>
      <div style="height:5px;background:#1e293b;border-radius:3px"><div style="height:5px;width:${pct}%;background:${barColor};border-radius:3px;transition:width .5s"></div></div>
      <div style="font-size:10px;color:#64748b;margin-top:4px">${pct}% · ${abovePlan ? '<span style="color:#4ade80">+' + fmtM(Math.abs(div.remaining)) + ' over</span>' : fmtM(div.remaining) + ' remaining'}</div>
    </div>`;
  }

  // Monthly budget mini-table (actuals only for months with data)
  const months = (fy.monthlyBudget || []);
  const completedMonths = months.filter(m => m.actual != null);
  const ytdBudgeted = completedMonths.reduce((a,m) => a + m.budgeted, 0);
  const ytdVariance = (annual.actualRevenue || 0) - ytdBudgeted;
  // ytdVariance and actualRevenue are already resolved by getResolvedFY()

  viewEl.innerHTML = `
<!-- ── HEADER ── -->
<div class="eyebrow" style="color:#00d4ff">Tyler · Owner / CEO</div>
<h1 style="margin-bottom:4px">Owner Dashboard</h1>
<p class="lede" style="margin-bottom:20px">FY2026 financials · Division P&L · Team performance · Commission queue · Pipeline health ·
  <button onclick="logoutRep();renderLoginScreen()" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:14px;text-decoration:underline">Switch Account</button>
</p>

<!-- ── EXEC SUMMARY: plain-language takeaways ── -->
${(()=>{
  const pctOfBudget = annual.budgetedRevenue > 0 ? Math.round(((annual.actualRevenue||0)/annual.budgetedRevenue)*100) : 0;
  const isAheadBudget = (ytdVariance||0) >= 0;
  const overdueCount = overdueList.length;
  const commQueueCount = commQueue.length;
  const unassignedCount = unassigned.length;
  const takeaways = [];

  // Revenue vs plan
  if (isAheadBudget) {
    takeaways.push({ icon:`<span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;background:rgba(74,222,128,.18);border:1px solid rgba(74,222,128,.4);color:#4ade80;flex-shrink:0" title="Positive"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 2v8M2 6h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>`, color:'#4ade80', text:`Revenue is <strong style="color:#4ade80">+${fmtM(Math.abs(ytdVariance||0))} ahead of budget</strong> YTD — currently at ${pctOfBudget}% of annual plan.` });
  } else {
    takeaways.push({ icon:`<span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;background:rgba(248,113,113,.18);border:1px solid rgba(248,113,113,.4);color:#f87171;flex-shrink:0" title="Behind target"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 9V3M6 9l-2.5-3M6 9l2.5-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`, color:'#f87171', text:`Revenue is <strong style="color:#f87171">${fmtM(Math.abs(ytdVariance||0))} behind budget</strong> YTD (${pctOfBudget}% of plan) — needs ${fmtM(annual.avgNeededPerMonth)} per month to close gap.` });
  }

  // Overdue follow-ups
  if (overdueCount === 0) {
    takeaways.push({ icon:`<span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;background:rgba(74,222,128,.18);border:1px solid rgba(74,222,128,.4);color:#4ade80;flex-shrink:0" title="Positive"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 2v8M2 6h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>`, color:'#4ade80', text:'All follow-ups are current — no overdue leads.' });
  } else {
    takeaways.push({ icon:`<span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;background:rgba(251,191,36,.18);border:1px solid rgba(251,191,36,.4);color:#fbbf24;flex-shrink:0" title="Action needed"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 2v5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="6" cy="9.5" r="1" fill="currentColor"/></svg></span>`, color:'#f87171', text:`<strong style="color:#f87171">${overdueCount} lead${overdueCount>1?'s are':' is'} overdue</strong> for follow-up — <span onclick="window._pipelineStatusFilter='overdue';show('pipeline')" style="color:#00d4ff;cursor:pointer;text-decoration:underline">review now →</span>` });
  }

  // Commission queue
  if (commQueueCount > 0) {
    takeaways.push({ icon:`<span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;background:rgba(251,191,36,.18);border:1px solid rgba(251,191,36,.4);color:#fbbf24;flex-shrink:0" title="Commission"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1.5v9M4 8c0 1 .9 1.5 2 1.5S8 9 8 8s-1-1.5-2-1.5S4 5 4 4s.9-1.5 2-1.5S8 3 8 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></span>`, color:'#f59e0b', text:`<strong style="color:#f59e0b">${commQueueCount} commission${commQueueCount>1?'s':''} pending approval</strong> — sold but not yet approved. <span onclick="show('repDashboard')" style="color:#00d4ff;cursor:pointer;text-decoration:underline">Review queue →</span>` });
  } else {
    takeaways.push({ icon:`<span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;background:rgba(74,222,128,.18);border:1px solid rgba(74,222,128,.4);color:#4ade80;flex-shrink:0" title="Positive"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 2v8M2 6h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>`, color:'#4ade80', text:'Commission queue is clear — all sold deals have been approved.' });
  }

  // Unassigned leads
  if (unassignedCount > 0) {
    takeaways.push({ icon:`<span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;background:rgba(100,116,139,.18);border:1px solid rgba(100,116,139,.4);color:#94a3b8;flex-shrink:0" title="Note"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="1.5" fill="currentColor"/><path d="M6 2.5v2M6 7.5v2M2.5 6h2M7.5 6h2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity=".5"/></svg></span>`, color:'#f59e0b', text:`<strong style="color:#f59e0b">${unassignedCount} unassigned lead${unassignedCount>1?'s':''}</strong> in pipeline — assign to Ryan or take directly.` });
  }

  // Stale check
  if (stale.length > 0) {
    takeaways.push({ icon:`<span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;background:rgba(251,191,36,.18);border:1px solid rgba(251,191,36,.4);color:#fbbf24;flex-shrink:0" title="Stale"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6.5" r="4" stroke="currentColor" stroke-width="1.4"/><path d="M6 4v3l1.5 1.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 1h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity=".5"/></svg></span>`, color:'#f59e0b', text:`<strong style="color:#f59e0b">${stale.length} stale lead${stale.length>1?'s':''}</strong> (14+ days no activity) — at risk of losing interest.` });
  }

  const rows = takeaways.map(t => `
    <div style="display:flex;gap:12px;align-items:flex-start;padding:10px 14px;border-bottom:1px solid #1e293b">
      <span style="font-size:1.1rem;min-width:24px">${t.icon}</span>
      <p style="margin:0;font-size:13px;color:#e2e8f0;line-height:1.5">${t.text}</p>
    </div>`).join('');

  return `<div style="background:linear-gradient(135deg,#0a1020,#0f1a30);border:1px solid #1e4d6b;border-radius:14px;margin-bottom:20px;overflow:hidden">
    <div style="padding:12px 16px;background:#0a1628;border-bottom:1px solid #1e4d6b;display:flex;align-items:center;justify-content:space-between">
      <span style="font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#00d4ff">Executive Summary</span>
      <span style="font-size:11px;color:#64748b">Key takeaways as of today</span>
    </div>
    ${rows}
  </div>`;
})()}

<!-- ── SECTION 1: FY2026 REVENUE BANNER ── -->
<div style="background:linear-gradient(135deg,#0a1628,#0f172a);border:1px solid #1e4d6b;border-radius:16px;padding:20px;margin-bottom:24px">
  <div style="font-size:11px;font-weight:700;color:#64748b;letter-spacing:.08em;text-transform:uppercase;margin-bottom:14px">FY2026 · ${fy.budgetVersion || 'v2.2'} · As of ${fy.asOfDate || '—'}</div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px">
    <div style="text-align:center">
      <div style="font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.06em">Annual Budget</div>
      <div style="font-size:1.6rem;font-weight:900;color:#e2e8f0">${fmtM(annual.budgetedRevenue)}</div>
    </div>
    <div style="text-align:center">
      <div style="font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.06em">Actual Revenue</div>
      <div style="font-size:1.6rem;font-weight:900;color:#00d4ff">${fmtM(annual.actualRevenue)}</div>
    </div>
    <div style="text-align:center">
      <div style="font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.06em">Remaining</div>
      <div style="font-size:1.6rem;font-weight:900;color:#f87171">${fmtM(annual.remaining)}</div>
    </div>
    <div style="text-align:center">
      <div style="font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.06em">Needed / Mo</div>
      <div style="font-size:1.6rem;font-weight:900;color:#f59e0b">${fmtM(annual.avgNeededPerMonth)}</div>
      <div style="font-size:9px;color:#64748b">${annual.monthsLeft != null ? annual.monthsLeft : 7} months left (dynamic)</div>
    </div>
    <div style="text-align:center">
      <div style="font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.06em">Operating GM</div>
      <div style="font-size:1.6rem;font-weight:900;color:#a78bfa">${annual.grossMarginPct ? Math.round(annual.grossMarginPct * 100) + '%' : '—'}</div>
    </div>
    <div style="text-align:center">
      <div style="font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.06em">True Net Income</div>
      <div style="font-size:1.3rem;font-weight:900;color:#4ade80">${fmtM(annual.trueNetIncome)}</div>
      <div style="font-size:9px;color:#64748b">after ${fmtM(annual.loanMonthly)}/mo loans</div>
    </div>
  </div>
  <!-- YTD progress bar -->
  <div style="margin-top:16px">
    <div style="display:flex;justify-content:space-between;font-size:11px;color:#64748b;margin-bottom:4px">
      <span>YTD Progress to Budget</span>
      <span style="color:${ytdVariance >= 0 ? '#4ade80' : '#f87171'}">${ytdVariance >= 0 ? '+' : ''}${fmtM(ytdVariance)} vs budget</span>
    </div>
    <div style="height:8px;background:#1e293b;border-radius:4px">
      <div style="height:8px;width:${Math.min(100, Math.round(((annual.actualRevenue||0)/(annual.budgetedRevenue||1))*100))}%;background:linear-gradient(90deg,#00d4ff,#4ade80);border-radius:4px;transition:width .5s"></div>
    </div>
    <div style="font-size:10px;color:#64748b;margin-top:3px">${Math.round(((annual.actualRevenue||0)/(annual.budgetedRevenue||1))*100)}% of annual budget · ${fy.asOfDate || ''}</div>
  </div>
</div>

<!-- ── SECTION 2: DIVISION P&L ── -->
<div style="margin-bottom:24px">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
    <h2 style="margin:0;font-size:16px">Division P&L</h2>
    <button class="secondary-btn" onclick="show('manager')" style="font-size:12px">Full P&L View →</button>
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px">
    ${divCard(divs.landscape, 'landscape')}
    ${divCard(divs.maintenance, 'maintenance')}
    ${divCard(divs.snow, 'snow')}
  </div>
</div>

<!-- ── SECTION 3: MONTHLY BUDGET ACTUALS ── -->
<div style="margin-bottom:24px">
  <h2 style="font-size:16px;margin-bottom:12px">Monthly Budget vs Actual</h2>
  <div style="overflow-x:auto">
    <div style="display:flex;gap:8px;min-width:600px">
      ${months.map(m => {
        const hasActual = m.actual != null;
        const varColor = !hasActual ? '#334155' : m.variance >= 0 ? '#4ade80' : '#f87171';
        const barPct = hasActual ? Math.min(100, Math.round((m.actual / m.budgeted) * 100)) : 0;
        return `<div style="flex:1;min-width:60px;background:#0f172a;border:1px solid ${hasActual ? '#1e4d6b' : '#1e293b'};border-radius:10px;padding:10px 8px;text-align:center">
          <div style="font-size:10px;font-weight:700;color:#94a3b8;margin-bottom:6px">${m.month}</div>
          <div style="font-size:11px;font-weight:600;color:#64748b;margin-bottom:2px">${fmtM(m.budgeted)}</div>
          ${hasActual ? `<div style="font-size:12px;font-weight:800;color:#00d4ff">${fmtM(m.actual)}</div>
          <div style="font-size:10px;color:${varColor};font-weight:700;margin-top:2px">${m.variance >= 0 ? '+' : ''}${fmtM(m.variance)}</div>
          <div style="height:3px;background:#1e293b;border-radius:2px;margin-top:6px"><div style="height:3px;width:${barPct}%;background:${m.variance >= 0 ? '#4ade80' : '#f87171'};border-radius:2px"></div></div>`
          : `<div style="font-size:10px;color:#334155;margin-top:4px">—</div>`}
        </div>`;
      }).join('')}
    </div>

<!-- ── SECTION 3B: PIPELINE BY DIVISION ── -->
<div style="margin-bottom:24px">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">
    <div>
      <h2 style="margin:0;font-size:16px">Pipeline by Division</h2>
      <div style="font-size:11px;color:#64748b;margin-top:3px">
        <strong style="color:#a78bfa">Paper on the Street</strong>
        = active quoted propd value currently in front of customers, not yet sold or lost
      </div>
    </div>
    <button onclick="show('manager')" style="padding:6px 14px;background:rgba(167,139,250,.12);border:1px solid rgba(124,58,237,.4);border-radius:8px;color:#a78bfa;font-size:11px;font-weight:700;cursor:pointer">
      Full Drill-Down →
    </button>
  </div>
  <div id="dashDivPipeline" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px"></div>
</div>


  </div>
</div>

<!-- ── SECTION 4: PIPELINE HEALTH + COMMISSION QUEUE ── -->
<div class="grid grid-2" style="gap:20px;margin-bottom:24px">

  <!-- Pipeline Health -->
  <section class="card">
    <h2 style="margin:0 0 14px;font-size:16px">Pipeline Health</h2>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px">
      <div class="dash-card-clickable" onclick="show('pipeline')" title="View all open opportunities"
        style="background:#0f172a;border-radius:10px;padding:12px;text-align:center;cursor:pointer"
        onmouseover="this.style.background='#1e293b'" onmouseout="this.style.background='#0f172a'">
        <div style="font-size:9px;color:#64748b;font-weight:600;text-transform:uppercase">Open Opps</div>
        <div style="font-size:22px;font-weight:800;color:#e2e8f0;margin-top:4px">${openOpps.length}</div>
        <div style="font-size:10px;color:#64748b">${fmtM(totalPipelineValue)} value</div>
      </div>
      <div class="dash-card-clickable" onclick="show('pipeline')" title="View overdue follow-ups"
        style="background:${overdueList.length > 0 ? '#2a0a0a' : '#0f172a'};border:1px solid ${overdueList.length > 0 ? '#7f1d1d' : '#1e293b'};border-radius:10px;padding:12px;text-align:center;cursor:pointer"
        onmouseover="this.style.opacity='0.85'" onmouseout="this.style.opacity='1'">
        <div style="font-size:9px;color:#94a3b8;font-weight:600;text-transform:uppercase">Overdue</div>
        <div style="font-size:22px;font-weight:800;color:${overdueList.length > 0 ? '#f87171' : '#4ade80'};margin-top:4px">${overdueList.length}</div>
        <div style="font-size:10px;color:#64748b">need follow-up</div>
      </div>
      <div class="dash-card-clickable" onclick="show('pipeline')" title="View proposals awaiting decision"
        style="background:#0f172a;border-radius:10px;padding:12px;text-align:center;cursor:pointer"
        onmouseover="this.style.background='#1e293b'" onmouseout="this.style.background='#0f172a'">
        <div style="font-size:9px;color:#64748b;font-weight:600;text-transform:uppercase">Proposals Out</div>
        <div style="font-size:22px;font-weight:800;color:#fbbf24;margin-top:4px">${proposals.length}</div>
        <div style="font-size:10px;color:#64748b">awaiting decision</div>
      </div>
      <div class="dash-card-clickable" onclick="show('pipeline')" title="View stale leads with no recent activity"
        style="background:#0f172a;border:1px solid ${stale.length > 0 ? '#f59e0b40' : '#1e293b'};border-radius:10px;padding:12px;text-align:center;cursor:pointer"
        onmouseover="this.style.background='#1e293b'" onmouseout="this.style.background='#0f172a'">
        <div style="font-size:9px;color:#94a3b8;font-weight:600;text-transform:uppercase">Stale (14d+)</div>
        <div style="font-size:22px;font-weight:800;color:${stale.length > 0 ? '#f59e0b' : '#4ade80'};margin-top:4px">${stale.length}</div>
        <div style="font-size:10px;color:#64748b">no recent activity</div>
      </div>
      <div class="dash-card-clickable" onclick="show('pipeline')" title="View sold opportunities"
        style="background:linear-gradient(135deg,#0c2a1a,#0f172a);border:1px solid #16a34a;border-radius:10px;padding:12px;text-align:center;cursor:pointer"
        onmouseover="this.style.opacity='0.85'" onmouseout="this.style.opacity='1'">
        <div style="font-size:9px;color:#86efac;font-weight:600;text-transform:uppercase">Sold</div>
        <div style="font-size:22px;font-weight:800;color:#4ade80;margin-top:4px">${soldOpps.length}</div>
        <div style="font-size:10px;color:#64748b">${fmtM(soldValue)} value</div>
      </div>
      <div class="dash-card-clickable" onclick="show('pipeline')" title="View unassigned leads"
        style="background:#0f172a;border:1px solid ${unassigned.length > 0 ? '#f59e0b60' : '#1e293b'};border-radius:10px;padding:12px;text-align:center;cursor:pointer"
        onmouseover="this.style.background='#1e293b'" onmouseout="this.style.background='#0f172a'">
        <div style="font-size:9px;color:#94a3b8;font-weight:600;text-transform:uppercase">Unassigned</div>
        <div style="font-size:22px;font-weight:800;color:${unassigned.length > 0 ? '#f59e0b' : '#4ade80'};margin-top:4px">${unassigned.length}</div>
        <div style="font-size:10px;color:#64748b">no rep assigned</div>
      </div>
    </div>
    ${overdueList.length > 0 ? `
    <div style="border-top:1px solid #1e293b;padding-top:12px">
      <div style="font-size:11px;font-weight:700;color:#f87171;margin-bottom:8px">Most Overdue</div>
      ${overdueList.slice(0, 4).map(o => `
        <div onclick="show('pipeline','${o.id}')" style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:#0f172a;border:1px solid #7f1d1d;border-radius:8px;margin-bottom:5px;cursor:pointer"
          onmouseover="this.style.background='#1a0a0a'" onmouseout="this.style.background='#0f172a'">
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(o.client||'Unnamed')}</div>
            <div style="font-size:10px;color:#64748b">${escapeHtml(o.status)} · Due ${o.nextFollowUp}</div>
            ${(()=>{ const _r=(window.REPS||[]).find(r=>r.id===o.repId); return _r ? `<span style="font-size:9px;font-weight:600;color:${_r.color||'#94a3b8'};background:${_r.color||'#94a3b8'}18;border:1px solid ${_r.color||'#94a3b8'}40;border-radius:20px;padding:1px 6px;white-space:nowrap">${escapeHtml(_r.name)}</span>` : `<span style="font-size:9px;font-weight:600;color:#f59e0b;border:1px solid #f59e0b40;border-radius:20px;padding:1px 6px">⚠ Unassigned</span>`; })()}
          </div>
          <span style="font-size:9px;color:#f87171;font-weight:700">OVERDUE</span>
        </div>`).join('')}
      ${overdueList.length > 4 ? `<div style="font-size:11px;color:#64748b;text-align:center;margin-top:6px">+${overdueList.length - 4} more — <button class="link-btn" onclick="show('pipeline')" style="color:var(--accent);background:none;border:none;cursor:pointer;font-size:11px;padding:0">open pipeline</button></div>` : ''}
    </div>` : '<p style="color:#4ade80;font-size:13px;margin-top:8px">No overdue follow-ups.</p>'}
  </section>

  <!-- Commission Approval Queue (COMM-11/12/13: lifecycle-aware) -->
  <section class="card">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <h2 style="margin:0;font-size:16px">Commission Approval Queue</h2>
      <span style="font-size:11px;color:${commQueue.length > 0 ? '#fbbf24' : '#4ade80'};font-weight:700">${commQueue.length} pending · ${commApproved.length} approved</span>
    </div>

    ${(()=>{
      function queueCard(o, isApproved) {
        const repObj = (window.REPS||[]).find(r => r.id === o.repId);
        const val = parseFloat(o.jobValue || 0);
        const lcStatus = getCommissionStatus(o);
        const scol = getCommissionStatusColor(lcStatus);
        const slbl = getCommissionStatusLabel(lcStatus);
        const cr = calculateCommission({
          planId:     repObj?.commissionPlan || 'ryan',
          workType:   o.workType   || 'landscape',
          leadSource: o.leadSource || 'company_lead',
          jobValue:   val,
          collected:  !!o.collected,
          approved:   isApproved,
          preview:    true
        });
        const capBadge = cr.capApplied ? `<span style="font-size:9px;background:#f87171;color:#fff;border-radius:10px;padding:1px 5px;margin-left:4px">CAPPED</span>` : '';
        const srcLabel = o.leadSource === 'self_generated' ? 'Self-Gen' : o.leadSource === 'company_lead' ? 'Co. Lead' : o.leadSource === 'assisted' ? 'Assisted' : '—';
        const wt = o.workType ? o.workType.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase()) : '—';
        return `
        <div style="background:#0f172a;border:1px solid ${scol}40;border-radius:12px;margin-bottom:10px;overflow:hidden">
          <div onclick="show('pipeline','${o.id}')" style="display:flex;align-items:center;gap:10px;padding:10px 12px;cursor:pointer"
            onmouseover="this.style.background='#131d2e'" onmouseout="this.style.background='transparent'">
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:8px">
                <span style="font-weight:700;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(o.client||'Unnamed')}</span>
                <span style="font-size:9px;background:${scol}22;color:${scol};border:1px solid ${scol}40;border-radius:20px;padding:1px 7px;white-space:nowrap">${slbl}</span>
              </div>
              <div style="font-size:11px;color:#64748b;margin-top:1px">${repObj ? `<span style="color:${repObj.color||'#94a3b8'}">${escapeHtml(repObj.name)}</span> · ` : ''}${wt} · ${srcLabel}</div>
            </div>
            <div style="text-align:right;flex-shrink:0">
              <div style="font-size:13px;font-weight:800;color:#00d4ff">${fmtM(val)}</div>
              <div style="font-size:10px;color:${o.collected?'#4ade80':'#f59e0b'}">${o.collected ? '✓ collected' : '⏳ uncollected'}</div>
            </div>
          </div>
          <div style="padding:8px 12px;background:#0a0f1a;border-top:1px solid #1e293b;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
            <div>
              <span style="font-size:10px;color:#475569;text-transform:uppercase;letter-spacing:.04em">Calculated Commission</span><br>
              <span style="font-size:15px;font-weight:800;color:#fbbf24">${fmtM(cr.amount)}</span>${capBadge}
              <div style="font-size:10px;color:#64748b;margin-top:2px;max-width:260px">${escapeHtml(cr.note)}</div>
              ${cr.retentionBonus > 0 ? `<div style="font-size:10px;color:#4ade80;margin-top:2px">+${fmtM(cr.retentionBonus)} retention bonus after 90-day active</div>` : ''}
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap">
              ${!isApproved ? `
              <button onclick="event.stopPropagation();window._adminApproveComm('${o.id}')"
                style="background:#16a34a;border:none;color:#fff;border-radius:8px;padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer">✓ Approve</button>
              <button onclick="event.stopPropagation();window._adminHoldComm('${o.id}')"
                style="background:#92400e;border:none;color:#fbbf24;border-radius:8px;padding:6px 10px;font-size:11px;cursor:pointer">Hold</button>
              <button onclick="event.stopPropagation();window._adminRejectComm('${o.id}')"
                style="background:#450a0a;border:none;color:#f87171;border-radius:8px;padding:6px 10px;font-size:11px;cursor:pointer">Reject</button>
              ` : `
              <button onclick="event.stopPropagation();window._adminMarkCommPaid('${o.id}')"
                style="background:#064e3b;border:none;color:#4ade80;border-radius:8px;padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer">$ Mark Paid</button>
              `}
              <button onclick="event.stopPropagation();show('pipeline','${o.id}')"
                style="background:#0f172a;border:1px solid #334155;color:#94a3b8;border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer">View →</button>
            </div>
          </div>
        </div>`;
      }

      let html = commQueue.length === 0
        ? '<p style="color:#4ade80;font-size:13px">No commissions pending approval. ✓</p>'
        : commQueue.map(o => queueCard(o, false)).join('');
      if (commQueue.length > 0) html += `<p style="font-size:11px;color:#64748b;margin-top:4px">Approve → Approved. Mark Paid → closes lifecycle. Hold/Reject for review.</p>`;
      if (commApproved.length > 0) html += `
        <div style="border-top:1px solid #1e293b;padding-top:14px;margin-top:10px">
          <div style="font-size:12px;font-weight:700;color:#00d4ff;margin-bottom:8px">Approved — Ready to Pay (${commApproved.length})</div>
          ${commApproved.map(o => queueCard(o, true)).join('')}
        </div>`;
      return html;
    })()}

    <!-- Unassigned opps inline -->
    <div style="border-top:1px solid #1e293b;padding-top:14px;margin-top:8px">
      <div style="font-size:12px;font-weight:700;color:#f59e0b;margin-bottom:8px">Unassigned Leads (${unassigned.length})</div>
      ${unassigned.length === 0
        ? '<p style="color:#4ade80;font-size:12px">All leads are assigned.</p>'
        : unassigned.slice(0, 5).map(o => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:7px 10px;background:#0f172a;border-radius:8px;margin-bottom:5px">
            <div>
              <div style="font-weight:600;font-size:12px">${escapeHtml(o.client||'Unnamed')}</div>
              <div style="font-size:10px;color:#64748b">${escapeHtml(o.serviceLine || o.status)}</div>
            </div>
            <select onchange="assignRep('${o.id}', this.value)"
              style="padding:5px 8px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:11px;cursor:pointer">
              <option value="">— Assign Rep —</option>
              ${REPS.filter(r=>r.role==='rep').map(r => `<option value="${r.id}">${r.name}</option>`).join('')}
            </select>
          </div>`).join('')}
    </div>
  </section>

</div>

<!-- ── SECTION 5: REP PERFORMANCE ── -->
<div style="margin-bottom:24px">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
    <h2 style="margin:0;font-size:16px">Rep Performance</h2>
    <button class="secondary-btn" onclick="show('pipeline')" style="font-size:12px">Full Pipeline →</button>
  </div>
  <div class="grid grid-2" style="gap:16px">
    ${repRows.map(({ rep, open, sold, soldValue, totalEarned, pendingCollection, overdue, proposals, closeRate, quotaPct }) => `
    <div class="card" style="border-left:4px solid ${rep.color}">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
        <span style="font-size:16px;font-weight:700;width:40px;height:40px;display:flex;align-items:center;justify-content:center;background:${rep.color}22;border:2px solid ${rep.color}66;border-radius:10px;color:${rep.color};flex-shrink:0">${rep.name[0]}</span>
        <div style="flex:1">
          <div style="font-weight:700;font-size:16px;color:${rep.color}">${rep.name}</div>
          <div style="font-size:11px;color:#64748b">${rep.title}</div>
        </div>
        ${overdue > 0 ? `<span style="font-size:10px;background:#7f1d1d;color:#f87171;padding:3px 8px;border-radius:20px;font-weight:700">${overdue} OVERDUE</span>` : '<span style="font-size:10px;background:#14532d;color:#4ade80;padding:3px 8px;border-radius:20px;font-weight:700">ON TRACK</span>'}
      </div>
      <!-- Stats grid -->
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">
        <div style="background:#0f172a;border-radius:8px;padding:10px;text-align:center">
          <div style="font-size:9px;color:#64748b;font-weight:600;text-transform:uppercase">Open</div>
          <div style="font-size:20px;font-weight:800;color:#e2e8f0">${open}</div>
        </div>
        <div style="background:#0f172a;border-radius:8px;padding:10px;text-align:center">
          <div style="font-size:9px;color:#64748b;font-weight:600;text-transform:uppercase">Sold</div>
          <div style="font-size:20px;font-weight:800;color:#4ade80">${sold}</div>
        </div>
        <div style="background:#0f172a;border-radius:8px;padding:10px;text-align:center">
          <div style="font-size:9px;color:#64748b;font-weight:600;text-transform:uppercase">Proposals</div>
          <div style="font-size:20px;font-weight:800;color:#fbbf24">${proposals}</div>
        </div>
      </div>
      <!-- Sold value + close rate -->
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <div style="flex:1;background:#0f172a;border-radius:8px;padding:10px;text-align:center">
          <div style="font-size:9px;color:#64748b;font-weight:600;text-transform:uppercase">Sold Value</div>
          <div style="font-size:14px;font-weight:800;color:#e2e8f0;margin-top:3px">${fmtM(soldValue)}</div>
        </div>
        <div style="flex:1;background:#0f172a;border-radius:8px;padding:10px;text-align:center">
          <div style="font-size:9px;color:#64748b;font-weight:600;text-transform:uppercase">Close Rate</div>
          <div style="font-size:14px;font-weight:800;color:${closeRate !== null ? (closeRate >= 20 ? '#4ade80' : '#fbbf24') : '#334155'};margin-top:3px">${closeRate !== null ? closeRate + '%' : '—'}</div>
        </div>
      </div>
      <!-- Quota progress bar -->
      <div style="background:#0f172a;border-radius:8px;padding:10px;margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;font-size:10px;color:#64748b;margin-bottom:5px">
          <span>Landscape Revenue Quota</span>
          <span style="color:${quotaPct >= 100 ? '#4ade80' : '#fbbf24'}">${quotaPct}% · ${fmtM(soldValue)} / ${fmtM(525000)}</span>
        </div>
        <div style="height:6px;background:#1e293b;border-radius:3px">
          <div style="height:6px;width:${quotaPct}%;background:${quotaPct >= 100 ? '#4ade80' : quotaPct >= 60 ? '#fbbf24' : '#f87171'};border-radius:3px;transition:width .5s"></div>
        </div>
      </div>
      <!-- Commission -->
      <div style="background:#0a1a0a;border:1px solid #14532d;border-radius:8px;padding:10px;display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
        <div style="text-align:center">
          <div style="font-size:9px;color:#86efac;font-weight:600;text-transform:uppercase">Earned</div>
          <div style="font-size:15px;font-weight:800;color:#4ade80;margin-top:2px">${fmtM(totalEarned)}</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:9px;color:#fde68a;font-weight:600;text-transform:uppercase">Pending</div>
          <div style="font-size:15px;font-weight:800;color:#fbbf24;margin-top:2px">${fmtM(pendingCollection)}</div>
        </div>
      </div>
      <button class="secondary-btn" onclick="viewRepPipeline('${rep.id}')" style="width:100%;font-size:12px">
        View ${rep.name}'s Pipeline →
      </button>
    </div>
    `).join('')}
  </div>
</div>

`;


  // ── Populate Paper on the Street division cards ──────────────────────────
  setTimeout(function() {
    var wrap = document.getElementById('dashDivPipeline');
    if (!wrap) return;
    if (typeof buildDivisionPipeline !== 'function') {
      wrap.innerHTML = '<p style="color:#475569;font-size:12px;padding:12px">Division pipeline data will appear once leads are added.</p>';
      return;
    }
    var dp = buildDivisionPipeline();
    var KEYS = dp.keys;
    var divs = dp.divisions;
    function fm(n){ return n!=null?n.toLocaleString(undefined,{style:'currency',currency:'USD',maximumFractionDigits:0}):'\u2014'; }
    function ageColor(d){ if(d==null)return'#475569'; if(d<=7)return'#4ade80'; if(d<=14)return'#fbbf24'; if(d<=30)return'#f97316'; return'#f87171'; }
    wrap.innerHTML = KEYS.map(function(k) {
      var d = divs[k];
      var potsColor = d.paperOnStreet > 0 ? '#a78bfa' : '#475569';
      var crStr = d.closeRatePct != null ? d.closeRatePct + '%' : '\u2014';
      var avgAgeStr = d.avgEstimateAge != null ? d.avgEstimateAge + 'd' : '\u2014';
      var oldestStr = d.oldestEstimateAge != null ? d.oldestEstimateAge + 'd' : '\u2014';
      return '<div style="background:linear-gradient(135deg,#0d1e35,#0a1628);border:1px solid #1e3a5f;border-radius:14px;padding:18px">'
        + '<div style="font-size:13px;font-weight:800;color:' + d.color + ';margin-bottom:12px;text-transform:uppercase;letter-spacing:.06em">' + d.label + '</div>'
        + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
          + '<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Open Pipeline</div><div style="font-size:15px;font-weight:800;color:#e2e8f0">' + fm(d.openValue) + '</div></div>'
          + '<div><div style="font-size:9px;color:#a78bfa;text-transform:uppercase;font-weight:600" title="Active quoted/proposed value not yet sold or lost">Paper on Street</div><div style="font-size:15px;font-weight:800;color:' + potsColor + '">' + fm(d.paperOnStreet) + '</div></div>'
          + '<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Weighted</div><div style="font-size:13px;font-weight:700;color:#94a3b8">' + fm(d.weightedPipeline) + '</div></div>'
          + '<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Sold This Mo.</div><div style="font-size:13px;font-weight:700;color:#4ade80">' + fm(d.soldThisMonth) + '</div></div>'
          + '<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Active Opps</div><div style="font-size:16px;font-weight:800;color:#e2e8f0">' + d.openCount + '</div></div>'
          + '<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Open Ests</div><div style="font-size:16px;font-weight:800;color:#e2e8f0">' + d.openEstimateCount + '</div></div>'
          + '<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Avg Est. Age</div><div style="font-size:13px;font-weight:700;color:' + ageColor(d.avgEstimateAge) + '">' + avgAgeStr + '</div></div>'
          + '<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Oldest Est.</div><div style="font-size:13px;font-weight:700;color:' + ageColor(d.oldestEstimateAge) + '">' + oldestStr + '</div></div>'
          + '<div><div style="font-size:9px;color:#fbbf24;text-transform:uppercase;font-weight:600">7d Follow-Up Risk</div><div style="font-size:16px;font-weight:800;color:' + (d.sevenDayRisk>0?'#fbbf24':'#4ade80') + '">' + d.sevenDayRisk + '</div></div>'
          + '<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Close Rate</div><div style="font-size:13px;font-weight:700;color:#00d4ff">' + crStr + '</div></div>'
        + '</div>'
      + '</div>';
    }).join('') + '<div style="background:linear-gradient(135deg,#0a1628,#071525);border:1px solid #334155;border-radius:14px;padding:18px">'
      + '<div style="font-size:13px;font-weight:800;color:#e2e8f0;margin-bottom:12px;text-transform:uppercase;letter-spacing:.06em">Total</div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
        + '<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Open Pipeline</div><div style="font-size:15px;font-weight:800;color:#e2e8f0">' + fm(divs.total.openValue) + '</div></div>'
        + '<div><div style="font-size:9px;color:#a78bfa;text-transform:uppercase;font-weight:600">Paper on Street</div><div style="font-size:15px;font-weight:800;color:#a78bfa">' + fm(divs.total.paperOnStreet) + '</div></div>'
        + '<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Weighted</div><div style="font-size:13px;font-weight:700;color:#94a3b8">' + fm(divs.total.weightedPipeline) + '</div></div>'
        + '<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Sold This Mo.</div><div style="font-size:13px;font-weight:700;color:#4ade80">' + fm(divs.total.soldThisMonth) + '</div></div>'
        + '<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Active Opps</div><div style="font-size:16px;font-weight:800;color:#e2e8f0">' + divs.total.openCount + '</div></div>'
        + '<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Open Ests</div><div style="font-size:16px;font-weight:800;color:#e2e8f0">' + divs.total.openEstimateCount + '</div></div>'
        + '<div><div style="font-size:9px;color:#fbbf24;text-transform:uppercase;font-weight:600">7d Risk Total</div><div style="font-size:16px;font-weight:800;color:' + (divs.total.sevenDayRisk>0?'#fbbf24':'#4ade80') + '">' + divs.total.sevenDayRisk + '</div></div>'
        + '<div></div>'
      + '</div>'
    + '</div>';
  }, 100);


  window.viewRepPipeline = function(repId) {
    show('pipeline');
    setTimeout(() => {
      if (window.filterPipelineByRep) window.filterPipelineByRep(repId);
    }, 100);
  };
}

function renderUnassignedOpps(allOpps) {
  const unassigned = allOpps.filter(o => !o.repId && !['Closed Lost'].includes(o.status));
  if (!unassigned.length) return '<p style="color:var(--muted);font-size:13px">All opportunities are assigned to reps.</p>';
  return unassigned.map(o => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#0f172a;border-radius:10px;margin-bottom:8px">
      <div>
        <div style="font-weight:600;font-size:13px">${escapeHtml(o.client)}</div>
        <div style="font-size:11px;color:#64748b">${escapeHtml(o.serviceLine || o.status)}</div>
      </div>
      <select onchange="assignRep('${o.id}', this.value)"
        style="padding:6px 10px;background:#1e293b;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:12px;cursor:pointer">
        <option value="">— Assign Rep —</option>
        ${REPS.filter(r=>r.role==='rep').map(r => `<option value="${r.id}">${r.name}</option>`).join('')}
      </select>
    </div>
  `).join('');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatWorkType(wt) {
  const map = {
    'landscape': 'Landscape',
    'maintenance_onetime': 'Maint (one-time)',
    'maintenance_recurring': 'Maint (recurring)',
    'maintenance_upsell': 'Maint Upsell',
    'hardscape': 'Hardscape',
    'drainage': 'Drainage',
    'design_build': 'Design/Build'
  };
  return map[wt] || wt || '—';
}

function formatLeadSource(ls) {
  const map = {
    'self_generated': 'Self-Generated',
    'company_lead': 'Company Lead',
    'assisted': 'Assisted'
  };
  return map[ls] || ls || '—';
}

function formatActivityKey(key) {
  const map = {
    pastClientFollowUps: 'Past Client Follow-ups',
    openEstimateFollowUps: 'Open Estimate Follow-ups',
    newOutboundCalls: 'New Outbound Calls',
    doorHangers: 'Door Hangers / Neighborhood Touches',
    newAppointments: 'New Appointments Created',
    crmNotes: 'CRM Notes & Next Steps',
    weeklyMeeting: 'Weekly Sales Review Meeting'
  };
  return map[key] || key;
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function weekOf() {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
  return monday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

function escapeHtml(str = '') {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Commission lifecycle actions ──────────────────────────────────────────────
// COMM-11: Full lifecycle transitions via touchCommissionLifecycle

window._adminApproveComm = function(oppId) {
  try {
    const actor = window.getCurrentRep ? (window.getCurrentRep()?.id || 'admin') : 'admin';
    const updated = touchCommissionLifecycle(oppId, { newStatus: 'approved', actor, note: 'Approved via commission queue' });
    if (updated) {
      if (window.showToast) window.showToast('Commission approved ✓');
      repDashboard();
    }
  } catch(e) { if (window.showToast) window.showToast('Error approving commission', 'error'); }
};

window._adminMarkCommPaid = function(oppId) {
  try {
    const actor = window.getCurrentRep ? (window.getCurrentRep()?.id || 'admin') : 'admin';
    const updated = touchCommissionLifecycle(oppId, { newStatus: 'paid', actor, note: 'Marked paid by admin' });
    if (updated) {
      if (window.showToast) window.showToast('Commission marked as paid ✓');
      repDashboard();
    }
  } catch(e) { if (window.showToast) window.showToast('Error updating commission', 'error'); }
};

window._adminRejectComm = function(oppId) {
  try {
    const actor = window.getCurrentRep ? (window.getCurrentRep()?.id || 'admin') : 'admin';
    const updated = touchCommissionLifecycle(oppId, { newStatus: 'rejected', actor, note: 'Rejected via commission queue' });
    if (updated) {
      if (window.showToast) window.showToast('Commission rejected');
      repDashboard();
    }
  } catch(e) { if (window.showToast) window.showToast('Error updating commission', 'error'); }
};

window._adminHoldComm = function(oppId) {
  try {
    const actor = window.getCurrentRep ? (window.getCurrentRep()?.id || 'admin') : 'admin';
    const updated = touchCommissionLifecycle(oppId, { newStatus: 'on_hold', actor, note: 'Placed on hold by admin' });
    if (updated) {
      if (window.showToast) window.showToast('Commission placed on hold');
      repDashboard();
    }
  } catch(e) { if (window.showToast) window.showToast('Error updating commission', 'error'); }
};

window.assignRep = function(oppId, repId) {
  if (!repId) return;
  try {
    const key = 'avalonSalesHubStateV3';
    const s = JSON.parse(localStorage.getItem(key) || '{}');
    const idx = (s.opportunities || []).findIndex(o => o.id === oppId);
    if (idx >= 0) {
      s.opportunities[idx].repId = repId;
      localStorage.setItem(key, JSON.stringify(s));
      if (window.showToast) window.showToast(`Assigned to ${REPS.find(r=>r.id===repId)?.name}`);
      repDashboard();
    }
  } catch(e) {}
};

// ── Auth guard for app startup ────────────────────────────────────────────────
function initApp() {
  const rep = getCurrentRep();
  if (!rep) {
    renderLoginScreen();
    return;
  }
  // App is already initialized — just re-render
  location.reload();
}

// ── COMM-16: Backfill migration ───────────────────────────────────────────────
// One-time function: initialises commissionLifecycle on every existing sold opp
// that doesn't already have it. Safe to call multiple times — idempotent.
// Tyler can trigger from browser console: window._migrateCommissionLifecycle()
// or from the Settings panel via the "Run Migration" button (if shown).
function migrateCommissionLifecycle() {
  const stateKey = 'avalonSalesHubStateV3';
  let s;
  try { s = JSON.parse(localStorage.getItem(stateKey) || '{}'); }
  catch(e) { return { migrated: 0, skipped: 0, error: e.message }; }

  const opps = s.opportunities || [];
  let migrated = 0;
  let skipped  = 0;

  opps.forEach((o, idx) => {
    // Only process sold opps that are missing a lifecycle record
    if (o.status !== 'Sold / Activation') return;
    if (o.commissionLifecycle && o.commissionLifecycle.status) { skipped++; return; }

    // Determine correct initial status from legacy fields
    let initStatus = 'pending_approval';
    if (o.commissionApproved === true) initStatus = 'approved';

    const repObj = REPS.find(r => r.id === o.repId);
    const result = calculateCommission({
      planId:     repObj?.commissionPlan || 'ryan',
      workType:   o.workType   || 'landscape',
      leadSource: o.leadSource || 'company_lead',
      jobValue:   parseFloat(o.jobValue || 0),
      collected:  !!o.collected,
      approved:   initStatus === 'approved',
      preview:    true
    });

    opps[idx].commissionLifecycle = {
      status:           initStatus,
      amount:           result.amount,
      rate:             result.rate,
      cap:              result.cap,
      capApplied:       result.capApplied,
      requiresApproval: result.requiresApproval,
      note:             result.note,
      ruleApplied:      result.ruleApplied,
      retentionBonus:   result.retentionBonus,
      retentionBonusPaidAt: null,
      calculatedAt:     new Date().toISOString(),
      history: [{
        ts:    o.commissionApprovedAt || o.updatedAt || new Date().toISOString(),
        actor: o.commissionApprovedBy || 'migration',
        from:  'legacy_boolean',
        to:    initStatus,
        note:  'Backfill migration from commissionApproved boolean (COMM-16)'
      }]
    };
    migrated++;
  });

  if (migrated > 0) {
    s.opportunities = opps;
    localStorage.setItem(stateKey, JSON.stringify(s));
  }

  console.log(`[COMM-16 migration] ${migrated} opps migrated, ${skipped} already had lifecycle records.`);
  return { migrated, skipped };
}
window._migrateCommissionLifecycle = migrateCommissionLifecycle;

// Auto-run migration on load — idempotent, only touches opps missing lifecycle records
(function autoMigrateOnLoad() {
  try {
    const stateKey = 'avalonSalesHubStateV3';
    const s = JSON.parse(localStorage.getItem(stateKey) || '{}');
    const needsMigration = (s.opportunities || []).some(
      o => o.status === 'Sold / Activation' && !o.commissionLifecycle
    );
    if (needsMigration) migrateCommissionLifecycle();
  } catch(e) {}
})();

// ── COMM-15: Collection gate helpers ─────────────────────────────────────────
// Surface clear messaging when commission is held behind collection gate.
// Used by rep dashboard and any display that shows commission amounts.
function getCollectionGateInfo(opp, engineResult) {
  if (opp.collected) return null; // gate open
  // Gate applies even in preview mode for display purposes
  if (engineResult && engineResult.ruleApplied === 'pending_collection') {
    return {
      held:    true,
      reason:  'Commission is held until payment is collected from the client.',
      preview: engineResult.amount || 0 // what they'd earn once collected
    };
  }
  // Job is sold, uncollected, and engine returned a value (preview mode was used) —
  // surface the pending amount with a clear gate warning
  if (!opp.collected && engineResult && engineResult.amount > 0) {
    return {
      held:    true,
      reason:  'Payment not yet collected — commission payout pending collection.',
      preview: engineResult.amount
    };
  }
  return null;
}
window.getCollectionGateInfo = getCollectionGateInfo;

// ── COMM-17: Feature flags ────────────────────────────────────────────────────
// avalonCommissionFeatureFlagsV1 in localStorage controls optional engine features.
// Defaults shown below — all on. Tyler can toggle from browser console.
const COMM_FLAG_DEFAULTS = {
  lifecycleEnabled:       true,  // COMM-11: track full lifecycle per deal
  simulatorEnabled:       true,  // COMM-05: show simulator in Settings
  autoReapprovalEnabled:  true,  // COMM-14: flag reapproval when fields change
  auditTrailEnabled:      true,  // COMM-04: write audit trail on rule saves
  backfillAutoRun:        true,  // COMM-16: run migration on page load
  collectionGateStrict:   true,  // COMM-15: hard-block display when uncollected
};

function getCommissionFlags() {
  try {
    const saved = JSON.parse(localStorage.getItem('avalonCommissionFeatureFlagsV1') || 'null');
    return saved ? { ...COMM_FLAG_DEFAULTS, ...saved } : COMM_FLAG_DEFAULTS;
  } catch(e) { return COMM_FLAG_DEFAULTS; }
}
window.getCommissionFlags  = getCommissionFlags;
window.COMM_FLAG_DEFAULTS  = COMM_FLAG_DEFAULTS;

// Toggle a single flag and save
window._setCommFlag = function(flagName, value) {
  const flags = getCommissionFlags();
  flags[flagName] = !!value;
  localStorage.setItem('avalonCommissionFeatureFlagsV1', JSON.stringify(flags));
  console.log(`[CommFlag] ${flagName} = ${!!value}`);
  if (window.showToast) window.showToast(`Flag "${flagName}" set to ${!!value}`);
};

// Reset all flags to defaults
window._resetCommFlags = function() {
  localStorage.removeItem('avalonCommissionFeatureFlagsV1');
  if (window.showToast) window.showToast('Commission feature flags reset to defaults ✓');
};

// ── COMM-18: QA Validation ────────────────────────────────────────────────────
// Runtime self-check: validates engine rule integrity and lifecycle consistency.
// Run from console: window._commQA()
// Returns { passed, failed, warnings, results[] }
function runCommissionQA() {
  const results  = [];
  let passed = 0, failed = 0, warnings = 0;

  function check(name, fn) {
    try {
      const r = fn();
      if (r === true)  { results.push({ name, status:'PASS', detail:'' });           passed++; }
      else if (r.warn) { results.push({ name, status:'WARN', detail:r.warn });        warnings++; }
      else             { results.push({ name, status:'FAIL', detail:r.fail || r });   failed++; }
    } catch(e) {
      results.push({ name, status:'ERROR', detail: e.message }); failed++;
    }
  }

  // ── Engine availability ──
  check('calculateCommission is defined', () => typeof window.calculateCommission === 'function' || { fail:'window.calculateCommission not found' });
  check('estimateCommission is defined',  () => typeof window.estimateCommission  === 'function' || { fail:'window.estimateCommission not found' });
  check('COMMISSION_PLANS.ryan exists',   () => !!(window.COMMISSION_PLANS && window.COMMISSION_PLANS.ryan) || { fail:'COMMISSION_PLANS.ryan missing' });

  // ── Engine output shape ──
  check('Engine returns expected keys', () => {
    const r = window.calculateCommission({ planId:'ryan', workType:'landscape', leadSource:'company_lead', jobValue:5000, collected:true, approved:true });
    const keys = ['amount','rate','cap','capApplied','requiresApproval','approvalReason','note','ruleApplied','retentionBonus'];
    const missing = keys.filter(k => !(k in r));
    return missing.length === 0 ? true : { fail:`Missing keys: ${missing.join(', ')}` };
  });

  // ── Rate structure sanity ──
  check('Landscape tier rates are valid (0 < rate < 1)', () => {
    const plan = window.COMMISSION_PLANS?.ryan?.landscape;
    if (!plan) return { fail:'No landscape plan' };
    const bad = (plan.tiers || []).filter(t => t.selfGen <= 0 || t.selfGen >= 1 || t.companyLead <= 0 || t.companyLead >= 1);
    return bad.length === 0 ? true : { fail:`${bad.length} tiers have rates out of range` };
  });
  check('Landscape soft cap < hard cap', () => {
    const p = window.COMMISSION_PLANS?.ryan?.landscape;
    if (!p) return { fail:'No landscape plan' };
    return p.softApprovalPayoutThreshold < p.hardCapPayout ? true : { fail:`soft=${p.softApprovalPayoutThreshold} >= hard=${p.hardCapPayout}` };
  });
  check('Recurring caps are positive', () => {
    const rec = window.COMMISSION_PLANS?.ryan?.maintenance?.recurring;
    if (!rec) return { fail:'No recurring plan' };
    const bad = Object.entries(rec).filter(([,r]) => !r.cap || r.cap <= 0);
    return bad.length === 0 ? true : { fail:`${bad.length} sources have invalid cap` };
  });

  // ── Scenario spot-checks ──
  check('Self-gen landscape $5k > co-lead $5k commission', () => {
    const sg = window.calculateCommission({ planId:'ryan', workType:'landscape', leadSource:'self_generated', jobValue:5000, collected:true, approved:true });
    const cl = window.calculateCommission({ planId:'ryan', workType:'landscape', leadSource:'company_lead',   jobValue:5000, collected:true, approved:true });
    return sg.amount > cl.amount ? true : { fail:`sg=${sg.amount}, cl=${cl.amount} — self-gen should pay more` };
  });
  check('Collection gate blocks payout when uncollected (strict mode)', () => {
    const r = window.calculateCommission({ planId:'ryan', workType:'landscape', leadSource:'company_lead', jobValue:5000, collected:false, approved:true, preview:false });
    return r.amount === 0 && r.ruleApplied === 'pending_collection' ? true : { fail:`amount=${r.amount}, ruleApplied=${r.ruleApplied}` };
  });
  check('Preview mode bypasses collection gate', () => {
    const r = window.calculateCommission({ planId:'ryan', workType:'landscape', leadSource:'company_lead', jobValue:5000, collected:false, approved:true, preview:true });
    return r.amount > 0 ? true : { fail:`Preview returned 0 — gate not bypassed` };
  });
  check('Hard cap enforced at large job value', () => {
    const r = window.calculateCommission({ planId:'ryan', workType:'landscape', leadSource:'self_generated', jobValue:50000, collected:true, approved:true });
    const hardCap = window.COMMISSION_PLANS?.ryan?.landscape?.hardCapPayout || 2500;
    return r.amount <= hardCap ? true : { fail:`amount=${r.amount} exceeds hardCap=${hardCap}` };
  });
  check('Below-minimum job returns 0 commission', () => {
    const r = window.calculateCommission({ planId:'ryan', workType:'landscape', leadSource:'company_lead', jobValue:100, collected:true, approved:true });
    return r.amount === 0 && r.ruleApplied === 'below_minimum' ? true : { fail:`amount=${r.amount}, rule=${r.ruleApplied}` };
  });
  check('Recurring maintenance respects cap', () => {
    const r = window.calculateCommission({ planId:'ryan', workType:'maintenance_recurring', leadSource:'company_lead', jobValue:10000, collected:true, approved:true });
    const cap = window.COMMISSION_PLANS?.ryan?.maintenance?.recurring?.companyLead?.cap || 300;
    return r.amount <= cap ? true : { fail:`amount=${r.amount} exceeds cap=${cap}` };
  });

  // ── Lifecycle helpers ──
  check('getCommissionStatus handles legacy bool', () => {
    const fn = window.getCommissionStatus;
    if (!fn) return { fail:'getCommissionStatus not exported' };
    return fn({ commissionApproved: true }) === 'approved' ? true : { fail:'legacy bool not migrated' };
  });
  check('getCommissionStatusColor returns string', () => {
    const fn = window.getCommissionStatusColor;
    if (!fn) return { fail:'not exported' };
    const v = fn('paid');
    return typeof v === 'string' && v.startsWith('#') ? true : { fail:`returned: ${v}` };
  });

  // ── Admin override ──
  check('loadActiveCommissionRules returns null when no override', () => {
    const savedKey = 'avalonCommissionRulesV1';
    const was = localStorage.getItem(savedKey);
    if (was) return { warn:'Custom rules active — skipping this check' };
    const r = window.loadActiveCommissionRules ? window.loadActiveCommissionRules() : null;
    return r === null ? true : { fail:`Expected null, got ${typeof r}` };
  });
  check('Feature flags return object with expected keys', () => {
    const flags = window.getCommissionFlags ? window.getCommissionFlags() : null;
    if (!flags) return { fail:'getCommissionFlags not exported' };
    const req = ['lifecycleEnabled','simulatorEnabled','autoReapprovalEnabled','auditTrailEnabled'];
    const missing = req.filter(k => !(k in flags));
    return missing.length === 0 ? true : { fail:`Missing flags: ${missing.join(', ')}` };
  });

  // ── Data integrity ──
  check('No sold opps missing lifecycle after migration', () => {
    try {
      const s = JSON.parse(localStorage.getItem('avalonSalesHubStateV3') || '{}');
      const missing = (s.opportunities || []).filter(o => o.status === 'Sold / Activation' && !o.commissionLifecycle);
      return missing.length === 0 ? true : { warn:`${missing.length} sold opps still missing lifecycle — run window._migrateCommissionLifecycle()` };
    } catch(e) { return { fail: e.message }; }
  });

  // Print summary
  console.group('[COMM-18 QA]');
  results.forEach(r => {
    const icon = r.status === 'PASS' ? '✅' : r.status === 'WARN' ? '⚠️' : r.status === 'ERROR' ? '💥' : '❌';
    console.log(`${icon} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  });
  console.groupEnd();
  console.log(`[COMM-18 QA] ${passed} passed · ${warnings} warnings · ${failed} failed`);

  return { passed, failed, warnings, results };
}
window._commQA = runCommissionQA;

// ── Expose globals ────────────────────────────────────────────────────────────
window.repDashboard = repDashboard;
window.renderLoginScreen = renderLoginScreen;
window.getCurrentRep = getCurrentRep;
window.loginRep = loginRep;
window.logoutRep = logoutRep;
window.isAdmin = isAdmin;
window.REPS = REPS;
window.calculateCommission = calculateCommission;
window.estimateCommission  = estimateCommission;
window.calcRepCommissions  = calcRepCommissions;
window.COMMISSION_PLANS    = COMMISSION_PLANS;
window.getRepOpps = getRepOpps;
window.formatWorkType = formatWorkType;
window.formatLeadSource = formatLeadSource;
window.fmtCurrency = fmtCurrency;
window.initApp = initApp;
