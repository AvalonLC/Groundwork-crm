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
    avatar: '👔',
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
    avatar: '🌿',
    color: '#4ade80',
    base: { rateTraining: 20, ratePostTraining: 21 },
    commissionPlan: 'ryan'
  },
  // Add new reps here — copy the Ryan structure and give them a unique id/pin
  // { id: 'sarah', name: 'Sarah', title: 'Account Manager', role: 'rep', pin: '3333', avatar: '⭐', color: '#f59e0b', base: { rateTraining: 20, ratePostTraining: 21 }, commissionPlan: 'ryan' }
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

  if (isAdminUser) {
    renderAdminDashboard(viewEl);
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
      <h2 style="margin:0;font-size:16px">🔥 My Active Pipeline</h2>
      <button class="secondary-btn" onclick="show('pipeline')" style="font-size:12px">View All</button>
    </div>
    ${open.slice(0,6).map(o => repOppMiniCard(o)).join('') || '<p style="color:var(--muted);font-size:13px">No open opportunities yet. <button class="primary-btn" onclick="show(\'lead\')" style="margin-left:8px;padding:4px 12px;font-size:12px">+ New Lead</button></p>'}
    ${open.length > 6 ? `<p style="color:var(--muted);font-size:12px;text-align:center;margin-top:8px">+ ${open.length - 6} more in pipeline</p>` : ''}
  </section>

  <!-- Weekly Scoreboard -->
  <section class="card">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <h2 style="margin:0;font-size:16px">📊 Weekly Activity</h2>
      <span style="font-size:11px;color:var(--muted)">Week of ${weekOf()}</span>
    </div>
    ${renderWeeklyScoreboard(rep.id, weeklyActivity, weekTargets)}
    <button class="secondary-btn" onclick="openWeeklyTracker('${rep.id}')" style="width:100%;margin-top:14px;font-size:13px">📝 Log Today's Activity</button>
  </section>

</div>

<!-- Commission Breakdown -->
<section class="card" style="margin-bottom:28px">
  <h2 style="margin:0 0 16px;font-size:16px">💰 Commission Breakdown — Sold Jobs</h2>
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
              ? '<span style="background:#14532d;color:#4ade80;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600">✓ Collected</span>'
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
  <h2 style="margin:0 0 16px;font-size:16px">📋 My Commission Plan</h2>
  ${renderCommissionPlanRef(rep.commissionPlan)}
</section>

<!-- Weekly Activity Log Modal (hidden) -->
<div id="weeklyTrackerModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:1000;align-items:center;justify-content:center">
  <div style="background:#1e293b;border-radius:16px;padding:28px;width:min(480px,95vw);max-height:90vh;overflow-y:auto;position:relative">
    <button onclick="document.getElementById('weeklyTrackerModal').style.display='none'"
      style="position:absolute;top:12px;right:12px;background:transparent;border:none;color:#64748b;font-size:20px;cursor:pointer">✕</button>
    <h2 style="margin:0 0 20px;font-size:18px">📝 Log This Week's Activity</h2>
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
    if (window.showToast) window.showToast('✅ Activity saved!');
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
    <p style="font-size:11px;color:#64748b;margin-top:12px">⚠️ Commission paid only on approved, sold, and collected work. Pricing must be management-approved. Base: $20/hr training → $21/hr post-training. 90-day review checkpoint.</p>
  </div>`;
}

// ── ADMIN MANAGER DASHBOARD ───────────────────────────────────────────────────
function renderAdminDashboard(viewEl) {
  const allOpps = getGlobalOpps();
  const repRows = REPS.filter(r => r.role === 'rep').map(rep => {
    const repOpps = allOpps.filter(o => o.repId === rep.id);
    const open = repOpps.filter(o => !['Sold / Activation','Closed Lost'].includes(o.status)).length;
    const sold = repOpps.filter(o => o.status === 'Sold / Activation');
    const soldValue = sold.reduce((a, o) => a + parseFloat(o.jobValue || 0), 0);
    const { totalEarned, pendingCollection } = calcRepCommissions(rep.id);
    const overdue = repOpps.filter(o => o.nextFollowUp && o.nextFollowUp < todayISO() && !['Sold / Activation','Closed Lost'].includes(o.status)).length;
    return { rep, open, sold: sold.length, soldValue, totalEarned, pendingCollection, overdue };
  });

  viewEl.innerHTML = `
<div class="eyebrow" style="color:#00d4ff">👔 Tyler · Admin</div>
<h1 style="margin-bottom:4px">Manager Dashboard</h1>
<p class="lede" style="margin-bottom:24px">All reps · Full pipeline view · Commission oversight · <button onclick="logoutRep();renderLoginScreen()" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:14px;text-decoration:underline">Switch Account</button></p>

<!-- Team Summary KPIs -->
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:28px">
  <div class="stat"><span>Total Open</span><strong>${allOpps.filter(o=>!['Sold / Activation','Closed Lost'].includes(o.status)).length}</strong></div>
  <div class="stat"><span>Sold This Period</span><strong>${allOpps.filter(o=>o.status==='Sold / Activation').length}</strong></div>
  <div class="stat bad"><span>Overdue Follow-ups</span><strong>${allOpps.filter(o=>o.nextFollowUp&&o.nextFollowUp<todayISO()&&!['Sold / Activation','Closed Lost'].includes(o.status)).length}</strong></div>
  <div class="stat"><span>Total Sold Value</span><strong>${fmtCurrency(allOpps.filter(o=>o.status==='Sold / Activation').reduce((a,o)=>a+parseFloat(o.jobValue||0),0))}</strong></div>
  <div class="stat"><span>Reps Active</span><strong>${REPS.filter(r=>r.role==='rep').length}</strong></div>
</div>

<!-- Rep Performance Cards -->
<div style="margin-bottom:28px">
  <h2 style="font-size:18px;margin-bottom:16px">👥 Rep Performance</h2>
  <div class="grid grid-2" style="gap:16px">
    ${repRows.map(({ rep, open, sold, soldValue, totalEarned, pendingCollection, overdue }) => `
    <div class="card" style="border-left:4px solid ${rep.color}">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
        <span style="font-size:28px">${rep.avatar}</span>
        <div>
          <div style="font-weight:700;font-size:16px;color:${rep.color}">${rep.name}</div>
          <div style="font-size:12px;color:#64748b">${rep.title}</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
        <div style="background:#0f172a;border-radius:10px;padding:12px;text-align:center">
          <div style="font-size:10px;color:#64748b;font-weight:600;text-transform:uppercase">Open</div>
          <div style="font-size:22px;font-weight:800;color:#e2e8f0;margin-top:4px">${open}</div>
        </div>
        <div style="background:#0f172a;border-radius:10px;padding:12px;text-align:center">
          <div style="font-size:10px;color:#64748b;font-weight:600;text-transform:uppercase">Sold</div>
          <div style="font-size:22px;font-weight:800;color:#4ade80;margin-top:4px">${sold}</div>
        </div>
        <div style="background:#0f172a;border-radius:10px;padding:12px;text-align:center">
          <div style="font-size:10px;color:#64748b;font-weight:600;text-transform:uppercase">Sold Value</div>
          <div style="font-size:15px;font-weight:800;color:#e2e8f0;margin-top:4px">${fmtCurrency(soldValue)}</div>
        </div>
        <div style="background:#0f172a;border-radius:10px;padding:12px;text-align:center">
          <div style="font-size:10px;color:#64748b;font-weight:600;text-transform:uppercase">Overdue</div>
          <div style="font-size:22px;font-weight:800;color:${overdue>0?'#f87171':'#e2e8f0'};margin-top:4px">${overdue}</div>
        </div>
      </div>
      <div style="background:#0a1a0a;border:1px solid #14532d;border-radius:10px;padding:12px;display:flex;justify-content:space-between;margin-bottom:12px">
        <div style="text-align:center">
          <div style="font-size:10px;color:#86efac;font-weight:600;text-transform:uppercase">Earned</div>
          <div style="font-size:16px;font-weight:800;color:#4ade80;margin-top:2px">${fmtCurrency(totalEarned)}</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:10px;color:#fde68a;font-weight:600;text-transform:uppercase">Pending</div>
          <div style="font-size:16px;font-weight:800;color:#fbbf24;margin-top:2px">${fmtCurrency(pendingCollection)}</div>
        </div>
      </div>
      <button class="secondary-btn" onclick="viewRepPipeline('${rep.id}')" style="width:100%;font-size:13px">
        View ${rep.name}'s Pipeline →
      </button>
    </div>
    `).join('')}
  </div>
</div>

<!-- All Unassigned Opps -->
<section class="card">
  <h2 style="font-size:16px;margin-bottom:16px">⚠️ Unassigned Opportunities</h2>
  ${renderUnassignedOpps(allOpps)}
</section>
`;

  window.viewRepPipeline = function(repId) {
    show('pipeline');
    // Filter pipeline to this rep — set a temp filter
    setTimeout(() => {
      if (window.filterPipelineByRep) window.filterPipelineByRep(repId);
    }, 100);
  };
}

function renderUnassignedOpps(allOpps) {
  const unassigned = allOpps.filter(o => !o.repId && !['Closed Lost'].includes(o.status));
  if (!unassigned.length) return '<p style="color:var(--muted);font-size:13px">✅ All opportunities are assigned to reps.</p>';
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
    'landscape': '🌿 Landscape',
    'maintenance_onetime': '🍂 Maint (one-time)',
    'maintenance_recurring': '🔄 Maint (recurring)',
    'maintenance_upsell': '➕ Maint Upsell',
    'hardscape': '🪨 Hardscape',
    'drainage': '💧 Drainage',
    'design_build': '📐 Design/Build'
  };
  return map[wt] || wt || '—';
}

function formatLeadSource(ls) {
  const map = {
    'self_generated': '🟢 Self-Generated',
    'company_lead': '🔵 Company Lead',
    'assisted': '⚪ Assisted'
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
      if (window.showToast) window.showToast(`✅ Assigned to ${REPS.find(r=>r.id===repId)?.name}`);
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
