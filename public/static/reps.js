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
    avatar: 'TK',
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
    avatar: 'RV',
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
    avatar: 'JM',
    color: '#f59e0b',
    email: 'admin@avalon-lc.com',
    base: null,
    commissionPlan: null
  }
  // Add new reps here — copy the Ryan structure and give them a unique id/pin
  // { id: 'sarah', name: 'Sarah', title: 'Account Manager', role: 'rep', pin: '4444', avatar: '⭐', color: '#a78bfa', base: { rateTraining: 20, ratePostTraining: 21 }, commissionPlan: 'ryan' }
];

// ── Commission Plans ───────────────────────────────────────────────────────────
const COMMISSION_PLANS = {
  ryan: {
    landscape: {
      // [min, max, selfGen%, companyLead%, assisted%]
      tiers: [
        { min: 500,   max: 2500,  selfGen: 0.10, companyLead: 0.06, assisted: 0.03 },
        { min: 2501,  max: 10000, selfGen: 0.08, companyLead: 0.05, assisted: 0.02 },
        { min: 10001, max: null,  selfGen: null, companyLead: null, assisted: null, approvalRequired: true }
      ]
    },
    maintenance: {
      oneTime:   { selfGen: 0.08, companyLead: 0.05, assisted: 0.02 },
      recurring: { selfGen: 0.50, companyLead: 0.25, assisted: 0.10, note: 'of first month' },
      upsell:    'use_landscape_table'
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
 * Calculate commission for a sold job
 * @param {Object} opts
 * @param {string} opts.planId - 'ryan' or future plan ids
 * @param {string} opts.workType - 'landscape' | 'maintenance_onetime' | 'maintenance_recurring' | 'maintenance_upsell'
 * @param {string} opts.leadSource - 'self_generated' | 'company_lead' | 'assisted'
 * @param {number} opts.jobValue - Dollar value of job
 * @param {boolean} opts.collected - Has payment been collected?
 * @param {boolean} opts.approved - Has management approved if required?
 * @returns {{ amount: number, rate: number, note: string, requiresApproval: boolean }}
 */
function calculateCommission({ planId = 'ryan', workType = 'landscape', leadSource = 'company_lead', jobValue = 0, collected = false, approved = true }) {
  const plan = COMMISSION_PLANS[planId];
  if (!plan) return { amount: 0, rate: 0, note: 'No plan found', requiresApproval: false };

  if (!collected) return { amount: 0, rate: 0, note: 'Commission paid after collection', requiresApproval: false };

  const srcKey = leadSource === 'self_generated' ? 'selfGen' :
                 leadSource === 'company_lead' ? 'companyLead' : 'assisted';

  // Maintenance recurring — first month basis
  if (workType === 'maintenance_recurring') {
    const rate = plan.maintenance.recurring[srcKey];
    const amount = jobValue * rate;
    return { amount, rate, note: `${Math.round(rate*100)}% of first month — paid after 60-day active period`, requiresApproval: false };
  }

  // Maintenance one-time
  if (workType === 'maintenance_onetime') {
    const rate = plan.maintenance.oneTime[srcKey];
    return { amount: jobValue * rate, rate, note: `${Math.round(rate*100)}% one-time service`, requiresApproval: false };
  }

  // Landscape / Enhancement — tiered
  for (const tier of plan.landscape.tiers) {
    const inRange = jobValue >= tier.min && (tier.max === null || jobValue <= tier.max);
    if (!inRange) continue;
    if (tier.approvalRequired) {
      if (!approved) return { amount: 0, rate: 0, note: 'Requires Tyler/management approval — pending', requiresApproval: true };
      return { amount: 0, rate: 0, note: '$10K+ job — commission rate set by management approval. Contact Tyler.', requiresApproval: true };
    }
    const rate = tier[srcKey];
    return { amount: jobValue * rate, rate, note: `${Math.round(rate*100)}% (${tier.min === 500 ? '$500-2.5K' : '$2.5K-10K'} ${leadSource.replace(/_/g,' ')} tier)`, requiresApproval: false };
  }

  return { amount: 0, rate: 0, note: 'Job value below $500 minimum', requiresApproval: false };
}

/**
 * Total commissions for a rep across all their opportunities
 */
function calcRepCommissions(repId) {
  const allOpps = getGlobalOpps();
  const repOpps = allOpps.filter(o => o.repId === repId && o.status === 'Sold / Activation');
  let totalEarned = 0;
  let pendingCollection = 0;
  let breakdown = [];

  repOpps.forEach(o => {
    const result = calculateCommission({
      planId: COMMISSION_PLANS[(REPS.find(r => r.id === repId)?.commissionPlan)] ? (REPS.find(r => r.id === repId)?.commissionPlan) : 'ryan',
      workType: o.workType || 'landscape',
      leadSource: o.leadSource || 'company_lead',
      jobValue: parseFloat(o.jobValue || o.budget?.replace(/[^0-9.]/g, '') || 0),
      collected: !!o.collected,
      approved: !!o.commissionApproved
    });
    if (o.collected) totalEarned += result.amount;
    else pendingCollection += result.amount;
    breakdown.push({ opp: o, result });
  });

  return { totalEarned, pendingCollection, breakdown };
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
          <span style="font-size:32px;width:48px;height:48px;display:flex;align-items:center;justify-content:center;background:#1e293b;border-radius:12px">${rep.avatar}</span>
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
    document.getElementById('pinRepName').textContent = `${rep.avatar} ${rep.name}`;
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
  const { totalEarned, pendingCollection, breakdown } = calcRepCommissions(rep.id);

  // Weekly activity from repState
  const repState = loadRepState(rep.id);
  const weeklyActivity = repState.weeklyActivity || {};
  const weekTargets = COMMISSION_PLANS.ryan.weeklyTargets;

  const activityLog = (repState.activityLog || []).slice(0, 8);

  viewEl.innerHTML = `
<div class="eyebrow" style="color:${rep.color}">${rep.avatar} ${rep.name}</div>
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
        ${breakdown.map(({ opp, result }) => `
        <tr style="border-bottom:1px solid #0f172a;cursor:pointer" onclick="show('pipeline','${opp.id}')"
          onmouseover="this.style.background='#0f172a'" onmouseout="this.style.background=''">
          <td style="padding:10px 12px;font-weight:600">${escapeHtml(opp.client)}</td>
          <td style="padding:10px 12px;color:#94a3b8">${formatWorkType(opp.workType)}</td>
          <td style="padding:10px 12px;color:#94a3b8">${formatLeadSource(opp.leadSource)}</td>
          <td style="padding:10px 12px;text-align:right">${fmtCurrency(opp.jobValue)}</td>
          <td style="padding:10px 12px;text-align:right;color:${rep.color}">${fmtPercent(result.rate)}</td>
          <td style="padding:10px 12px;text-align:right;font-weight:700;color:${opp.collected ? '#4ade80' : '#fbbf24'}">${fmtCurrency(result.amount)}</td>
          <td style="padding:10px 12px;text-align:center">
            ${opp.collected
              ? '<span style="background:#14532d;color:#4ade80;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600">Collected</span>'
              : result.requiresApproval
                ? '<span style="background:#1c1917;color:#f59e0b;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600">Approval Needed</span>'
                : '<span style="background:#1c1917;color:#fbbf24;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600">Pending</span>'}
          </td>
        </tr>
        <tr>
          <td colspan="7" style="padding:0 12px 10px;font-size:11px;color:#64748b">${escapeHtml(result.note)}</td>
        </tr>
        `).join('')}
      </tbody>
    </table></div>`}
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
  return `
  <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:16px">
      <thead>
        <tr style="background:#0f172a">
          <th style="padding:10px;text-align:left;color:#64748b;border-bottom:1px solid #1e293b">LANDSCAPE / ENHANCEMENT</th>
          <th style="padding:10px;text-align:center;color:#4ade80;border-bottom:1px solid #1e293b">Self-Generated</th>
          <th style="padding:10px;text-align:center;color:#60a5fa;border-bottom:1px solid #1e293b">Company Lead</th>
          <th style="padding:10px;text-align:center;color:#94a3b8;border-bottom:1px solid #1e293b">Assisted</th>
        </tr>
      </thead>
      <tbody>
        <tr style="border-bottom:1px solid #0f172a">
          <td style="padding:10px">$500 – $2,500</td>
          <td style="padding:10px;text-align:center;color:#4ade80;font-weight:700">10%</td>
          <td style="padding:10px;text-align:center;color:#60a5fa;font-weight:700">6%</td>
          <td style="padding:10px;text-align:center;color:#94a3b8;font-weight:700">3%</td>
        </tr>
        <tr style="border-bottom:1px solid #0f172a">
          <td style="padding:10px">$2,501 – $10,000</td>
          <td style="padding:10px;text-align:center;color:#4ade80;font-weight:700">8%</td>
          <td style="padding:10px;text-align:center;color:#60a5fa;font-weight:700">5%</td>
          <td style="padding:10px;text-align:center;color:#94a3b8;font-weight:700">2%</td>
        </tr>
        <tr>
          <td style="padding:10px">$10,001+</td>
          <td colspan="3" style="padding:10px;text-align:center;color:#f59e0b">By management approval — contact Tyler</td>
        </tr>
      </tbody>
    </table>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead>
        <tr style="background:#0f172a">
          <th style="padding:10px;text-align:left;color:#64748b;border-bottom:1px solid #1e293b">MAINTENANCE</th>
          <th style="padding:10px;text-align:center;color:#4ade80;border-bottom:1px solid #1e293b">Self-Generated</th>
          <th style="padding:10px;text-align:center;color:#60a5fa;border-bottom:1px solid #1e293b">Company Lead</th>
          <th style="padding:10px;text-align:center;color:#94a3b8;border-bottom:1px solid #1e293b">Assisted</th>
        </tr>
      </thead>
      <tbody>
        <tr style="border-bottom:1px solid #0f172a">
          <td style="padding:10px">One-time seasonal</td>
          <td style="padding:10px;text-align:center;color:#4ade80;font-weight:700">8%</td>
          <td style="padding:10px;text-align:center;color:#60a5fa;font-weight:700">5%</td>
          <td style="padding:10px;text-align:center;color:#94a3b8;font-weight:700">2%</td>
        </tr>
        <tr>
          <td style="padding:10px">New recurring client</td>
          <td style="padding:10px;text-align:center;color:#4ade80;font-weight:700">50% 1st mo</td>
          <td style="padding:10px;text-align:center;color:#60a5fa;font-weight:700">25% 1st mo</td>
          <td style="padding:10px;text-align:center;color:#94a3b8;font-weight:700">10% 1st mo</td>
        </tr>
      </tbody>
    </table>
    <p style="font-size:11px;color:#64748b;margin-top:12px">Commission paid only on approved, sold, and collected work. Pricing must be management-approved. Base: $20/hr training → $21/hr post-training. 90-day review checkpoint.</p>
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
<div class="eyebrow" style="color:${rep.color}">${rep.avatar} ${rep.name} · Office Manager</div>
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
            <div style="font-size:11px;color:#64748b;margin-top:1px">${escapeHtml(o.status)} · Due ${o.nextFollowUp}${o.repId ? ' · ' + (window.REPS||[]).find(r=>r.id===o.repId)?.avatar || '' : ' · unassigned'}</div>
          </div>
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
            <div style="font-size:11px;color:#64748b;margin-top:1px">${escapeHtml(o.serviceLine||o.status)}${o.repId ? ' · ' + ((window.REPS||[]).find(r=>r.id===o.repId)?.avatar||'') + ' ' + ((window.REPS||[]).find(r=>r.id===o.repId)?.name||'') : ' · unassigned'}</div>
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
  const commQueue = soldOpps.filter(o => !o.commissionApproved && o.repId);

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
  function divCard(div, key) {
    if (!div || !div.target) return '';
    const abovePlan = div.remaining <= 0;
    const gmOk = div.grossMarginPct >= div.grossMarginFloor;
    const pct = Math.min(100, Math.round((div.actual / div.target) * 100));
    const barColor = pct >= 100 ? '#4ade80' : pct >= 70 ? '#fbbf24' : '#f87171';
    return `<div style="background:#0f172a;border:1px solid ${abovePlan ? '#16a34a' : '#1e293b'};border-radius:12px;padding:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="font-weight:700;font-size:14px">${div.icon} ${div.name}</div>
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
    takeaways.push({ icon:'+', color:'#4ade80', text:`Revenue is <strong style="color:#4ade80">+${fmtM(Math.abs(ytdVariance||0))} ahead of budget</strong> YTD — currently at ${pctOfBudget}% of annual plan.` });
  } else {
    takeaways.push({ icon:'−', color:'#f87171', text:`Revenue is <strong style="color:#f87171">${fmtM(Math.abs(ytdVariance||0))} behind budget</strong> YTD (${pctOfBudget}% of plan) — needs ${fmtM(annual.avgNeededPerMonth)} per month to close gap.` });
  }

  // Overdue follow-ups
  if (overdueCount === 0) {
    takeaways.push({ icon:'+', color:'#4ade80', text:'All follow-ups are current — no overdue leads.' });
  } else {
    takeaways.push({ icon:'!', color:'#f87171', text:`<strong style="color:#f87171">${overdueCount} lead${overdueCount>1?'s are':' is'} overdue</strong> for follow-up — <span onclick="window._pipelineStatusFilter='overdue';show('pipeline')" style="color:#00d4ff;cursor:pointer;text-decoration:underline">review now →</span>` });
  }

  // Commission queue
  if (commQueueCount > 0) {
    takeaways.push({ icon:'$', color:'#f59e0b', text:`<strong style="color:#f59e0b">${commQueueCount} commission${commQueueCount>1?'s':''} pending approval</strong> — sold but not yet approved. <span onclick="show('repDashboard')" style="color:#00d4ff;cursor:pointer;text-decoration:underline">Review queue →</span>` });
  } else {
    takeaways.push({ icon:'+', color:'#4ade80', text:'Commission queue is clear — all sold deals have been approved.' });
  }

  // Unassigned leads
  if (unassignedCount > 0) {
    takeaways.push({ icon:'·', color:'#f59e0b', text:`<strong style="color:#f59e0b">${unassignedCount} unassigned lead${unassignedCount>1?'s':''}</strong> in pipeline — assign to Ryan or take directly.` });
  }

  // Stale check
  if (stale.length > 0) {
    takeaways.push({ icon:'⏱', color:'#f59e0b', text:`<strong style="color:#f59e0b">${stale.length} stale lead${stale.length>1?'s':''}</strong> (14+ days no activity) — at risk of losing interest.` });
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
            <div style="font-size:10px;color:#64748b">${escapeHtml(o.status)} · Due ${o.nextFollowUp}${o.repId ? ' · ' + ((window.REPS||[]).find(r=>r.id===o.repId)?.avatar||'') : ' · unassigned'}</div>
          </div>
          <span style="font-size:9px;color:#f87171;font-weight:700">OVERDUE</span>
        </div>`).join('')}
      ${overdueList.length > 4 ? `<div style="font-size:11px;color:#64748b;text-align:center;margin-top:6px">+${overdueList.length - 4} more — <button class="link-btn" onclick="show('pipeline')" style="color:var(--accent);background:none;border:none;cursor:pointer;font-size:11px;padding:0">open pipeline</button></div>` : ''}
    </div>` : '<p style="color:#4ade80;font-size:13px;margin-top:8px">No overdue follow-ups.</p>'}
  </section>

  <!-- Commission Approval Queue -->
  <section class="card">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <h2 style="margin:0;font-size:16px">Commission Approval Queue</h2>
      <span style="font-size:11px;color:${commQueue.length > 0 ? '#fbbf24' : '#4ade80'};font-weight:700">${commQueue.length} pending</span>
    </div>
    ${commQueue.length === 0
      ? '<p style="color:#4ade80;font-size:13px">All sold jobs have commission approved.</p>'
      : commQueue.map(o => {
          const rep = (window.REPS||[]).find(r => r.id === o.repId);
          const val = parseFloat(o.jobValue || 0);
          return `
          <div onclick="show('pipeline','${o.id}')" style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:#0f172a;border:1px solid #ca8a0440;border-radius:10px;margin-bottom:8px;cursor:pointer"
            onmouseover="this.style.background='#131d2e'" onmouseout="this.style.background='#0f172a'">
            <div style="flex:1;min-width:0">
              <div style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(o.client||'Unnamed')}</div>
              <div style="font-size:11px;color:#64748b;margin-top:1px">${rep ? rep.avatar + ' ' + rep.name : 'Unassigned'} · ${escapeHtml(o.serviceLine||o.workType||'—')}</div>
            </div>
            <div style="text-align:right;flex-shrink:0">
              <div style="font-size:13px;font-weight:700;color:#fbbf24">${fmtM(val)}</div>
              <div style="font-size:10px;color:#64748b">${o.collected ? 'collected' : 'uncollected'}</div>
            </div>
          </div>`;
        }).join('')}
    ${commQueue.length > 0 ? `<p style="font-size:11px;color:#64748b;margin-top:8px">Open any job above → Admin Controls → check Commission Approved to clear the queue.</p>` : ''}

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
        <span style="font-size:28px">${rep.avatar}</span>
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

// ── Assign rep to opportunity ─────────────────────────────────────────────────
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

// ── Expose globals ────────────────────────────────────────────────────────────
window.repDashboard = repDashboard;
window.renderLoginScreen = renderLoginScreen;
window.getCurrentRep = getCurrentRep;
window.loginRep = loginRep;
window.logoutRep = logoutRep;
window.isAdmin = isAdmin;
window.REPS = REPS;
window.calculateCommission = calculateCommission;
window.calcRepCommissions = calcRepCommissions;
window.getRepOpps = getRepOpps;
window.formatWorkType = formatWorkType;
window.formatLeadSource = formatLeadSource;
window.fmtCurrency = fmtCurrency;
window.initApp = initApp;
