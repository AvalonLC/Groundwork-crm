#!/usr/bin/env python3
"""
Patch 1: app_premium.js
  A. Insert buildDivisionPipeline() helper before the lead() function (line 523)
  B. Add estimate fields as Section 4 in lead() form (after Section 3 closing </div> before the detail toggle)
  C. Add estimate panel to opportunityDetail() form
  D. Add Division Pipeline drill-down to manager() view

Patch 2: reps.js
  Insert Division Pipeline section between Section 3 (Monthly Budget) and Section 4 (Pipeline Health)

Patch 3: premium.css
  Add CSS for .dp-* (division pipeline) classes
"""

import re, sys

# ─── PATCH 1A: Insert buildDivisionPipeline() helper into app_premium.js ───

APP_PATH = '/home/user/webapp/public/static/app_premium.js'

with open(APP_PATH, 'r', encoding='utf-8') as f:
    app = f.read()

HELPER_FUNC = r"""
// ── buildDivisionPipeline() ─────────────────────────────────────────────────
// Calculates per-division pipeline metrics from state.opportunities[]
// Division mapping: projectCategory / workType → landscape / maintenance / snow
function buildDivisionPipeline() {
  const opps = (window.avalonState && window.avalonState.opportunities) || (typeof state !== 'undefined' ? state.opportunities : []) || [];
  const todayStr = typeof todayISO === 'function' ? todayISO() : new Date().toISOString().slice(0,10);
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);

  // Map an opportunity to a division key
  function getDiv(o) {
    const cat = (o.projectCategory || '').toLowerCase();
    const wt  = (o.workType || '').toLowerCase();
    const sl  = (o.serviceLine || '').toLowerCase();
    if (cat.includes('snow') || wt.includes('snow') || sl.includes('snow')) return 'snow';
    if (cat.includes('mainten') || wt.includes('mainten') || sl.includes('mainten')) return 'maintenance';
    if (cat.includes('landscape') || cat.includes('design') || cat.includes('hardscape') ||
        cat.includes('drainage') || wt.includes('landscape') || wt.includes('hardscape') ||
        wt.includes('drainage') || wt.includes('design')) return 'landscape';
    // fallback by service line
    if (sl.includes('landscape') || sl.includes('hardscape') || sl.includes('drainage')) return 'landscape';
    return 'landscape'; // default
  }

  // Win probability by stage (mirrors HubSpot pipeline)
  const STAGE_WIN_PROB = {
    'New Lead': 0.10,
    'Contacted': 0.15,
    'Site Visit Scheduled': 0.25,
    'Site Visit Complete': 0.35,
    'Estimating': 0.45,
    'Estimate Sent': 0.55,
    'Proposal Under Review': 0.65,
    'Negotiating': 0.75,
    'Follow-Up': 0.50,
    'Decision Pending': 0.70,
    'Sold / Activation': 1.0,
    'Closed Lost': 0.0,
  };
  function winProb(o) {
    return STAGE_WIN_PROB[o.status] || 0.20;
  }

  // "Paper on the Street" statuses — formal estimates/proposals in front of customers
  const POTS_ESTIMATE_STATUSES = ['sent','revised','viewed','awaiting_response','awaiting response'];
  const POTS_STAGES = ['Estimate Sent','Proposal Under Review','Negotiating','Decision Pending','Follow-Up'];

  const OPEN_STAGES_EXCL = ['Sold / Activation','Closed Lost'];

  const divKeys = ['landscape','maintenance','snow'];
  const divLabels = { landscape:'Landscape', maintenance:'Maintenance', snow:'Snow & Ice' };
  const divColors = { landscape:'#22d3ee', maintenance:'#4ade80', snow:'#60a5fa' };

  const result = {};
  divKeys.forEach(k => {
    result[k] = {
      key: k,
      label: divLabels[k],
      color: divColors[k],
      openValue: 0,           // total open pipeline value (all active opps)
      openEstimateValue: 0,   // value of opps with a formal estimate out
      paperOnStreet: 0,       // active quoted/proposed value not yet sold or lost
      weightedPipeline: 0,    // openValue * win probability
      openCount: 0,           // # active opportunities
      openEstimateCount: 0,   // # opps with estimate sent/active
      estimateAgeDays: [],    // array of ages (in days) for open estimates
      sevenDayRisk: 0,        // # open opps with follow-up due within 7 days
      soldThisMonth: 0,       // sold value this calendar month
      soldCountThisMonth: 0,
      totalSold: 0,           // all time sold value (for close rate)
      totalClosed: 0,         // sold + lost (for close rate denominator)
    };
  });

  opps.forEach(o => {
    const div = getDiv(o);
    const d = result[div];
    if (!d) return;
    const val = parseFloat(o.jobValue || 0);
    const estAmt = parseFloat(o.estimateAmount || val); // fall back to jobValue if no estimateAmount

    const isSold = o.status === 'Sold / Activation';
    const isLost = o.status === 'Closed Lost';
    const isOpen = !isSold && !isLost;

    // Close rate denominator
    if (isSold || isLost) d.totalClosed++;
    if (isSold) {
      d.totalSold += val;
      // Sold this month?
      if (o.updatedAt && o.updatedAt.slice(0,10) >= startOfMonth) {
        d.soldThisMonth += val;
        d.soldCountThisMonth++;
      }
    }

    if (!isOpen) return;

    // Open pipeline
    d.openCount++;
    d.openValue += val;
    d.weightedPipeline += val * winProb(o);

    // Estimate open?
    const estStatus = (o.estimateStatus || '').toLowerCase().replace(/ /g,'_');
    const hasOpenEstimate = POTS_ESTIMATE_STATUSES.includes(estStatus) ||
                             POTS_ESTIMATE_STATUSES.includes((o.estimateStatus||'').toLowerCase()) ||
                             POTS_STAGES.includes(o.status);
    if (hasOpenEstimate && estAmt > 0) {
      d.openEstimateCount++;
      d.openEstimateValue += estAmt;

      // Paper on the Street: active quoted value in front of customer
      d.paperOnStreet += estAmt;

      // Estimate age
      const sentDate = o.estimateSentDate || o.updatedAt || o.createdAt;
      if (sentDate) {
        const sent = new Date(sentDate);
        const ageMs = now - sent;
        const ageDays = Math.floor(ageMs / 86400000);
        if (ageDays >= 0) d.estimateAgeDays.push(ageDays);
      }
    }

    // 7-day follow-up risk
    if (o.nextFollowUp) {
      const followDate = new Date(o.nextFollowUp + 'T12:00:00');
      const daysUntil = Math.floor((followDate - now) / 86400000);
      if (daysUntil >= 0 && daysUntil <= 7) d.sevenDayRisk++;
    }
  });

  // Compute derived stats
  divKeys.forEach(k => {
    const d = result[k];
    d.avgEstimateAge = d.estimateAgeDays.length > 0
      ? Math.round(d.estimateAgeDays.reduce((a,b) => a+b, 0) / d.estimateAgeDays.length)
      : null;
    d.oldestEstimateAge = d.estimateAgeDays.length > 0
      ? Math.max(...d.estimateAgeDays)
      : null;
    d.closeRate = d.totalClosed > 0
      ? Math.round((d.totalSold > 0 ? (d.soldCountThisMonth > 0 ? 1 : 0) : 0) * 100) / 100
      : null;
    // Better close rate: sold / (sold + lost) by count
    const soldCount = opps.filter(o => o.status === 'Sold / Activation' && getDiv(o) === k).length;
    const lostCount = opps.filter(o => o.status === 'Closed Lost'        && getDiv(o) === k).length;
    d.closeRatePct = (soldCount + lostCount) > 0
      ? Math.round((soldCount / (soldCount + lostCount)) * 100)
      : null;
  });

  // Totals row
  result.total = {
    label: 'Total',
    color: '#e2e8f0',
    openValue:         divKeys.reduce((a,k) => a + result[k].openValue, 0),
    openEstimateValue: divKeys.reduce((a,k) => a + result[k].openEstimateValue, 0),
    paperOnStreet:     divKeys.reduce((a,k) => a + result[k].paperOnStreet, 0),
    weightedPipeline:  divKeys.reduce((a,k) => a + result[k].weightedPipeline, 0),
    openCount:         divKeys.reduce((a,k) => a + result[k].openCount, 0),
    openEstimateCount: divKeys.reduce((a,k) => a + result[k].openEstimateCount, 0),
    soldThisMonth:     divKeys.reduce((a,k) => a + result[k].soldThisMonth, 0),
    sevenDayRisk:      divKeys.reduce((a,k) => a + result[k].sevenDayRisk, 0),
  };

  return { divisions: result, keys: divKeys };
}
// ────────────────────────────────────────────────────────────────────────────
"""

# Insert the helper just before "function lead(){"
ANCHOR_1A = 'function lead(){'
if ANCHOR_1A not in app:
    print('ERROR: Could not find anchor for buildDivisionPipeline insertion')
    sys.exit(1)

app = app.replace(ANCHOR_1A, HELPER_FUNC + '\n' + ANCHOR_1A, 1)
print('PATCH 1A: buildDivisionPipeline() helper inserted')


# ─── PATCH 1B: Add estimate fields (Section 4) to lead() form ───

# Insert Section 4 (Estimate) between Section 3 closing div and the detail toggle
# Anchor: the comment "// ── Optional detail toggle ──"

ESTIMATE_SECTION = (
    "\n"
    "      // \u2500\u2500 Section 4: Estimate (optional, collapsible) \u2500\u2500\n"
    "      + '<div class=\"lf-section\">'  \n"
    "        + '<div class=\"lf-section-header\">'  \n"
    "          + '<span class=\"lf-section-num\" style=\"background:linear-gradient(135deg,#7c3aed,#6d28d9)\">4</span>'  \n"
    "          + '<div>'  \n"
    "            + '<div class=\"lf-section-title\">Estimate</div>'  \n"
    "            + '<div class=\"lf-section-sub\">Track what\\'s on the street \u2014 formal quotes and proposals</div>'  \n"
    "          + '</div>'  \n"
    "        + '</div>'  \n"
    "        + '<div class=\"lf-fields\">'  \n"
    "          + '<label class=\"lf-field\">'  \n"
    "            + '<span class=\"lf-label\">Estimate Status</span>'  \n"
    "            + '<select name=\"estimateStatus\" class=\"lf-select\">'  \n"
    "              + '<option value=\"\">Not started</option>'  \n"
    "              + '<option value=\"draft\">Draft \u2014 not yet sent</option>'  \n"
    "              + '<option value=\"sent\">Sent \u2014 awaiting response</option>'  \n"
    "              + '<option value=\"revised\">Revised &amp; resent</option>'  \n"
    "              + '<option value=\"viewed\">Viewed by customer</option>'  \n"
    "              + '<option value=\"awaiting_response\">Awaiting response</option>'  \n"
    "              + '<option value=\"accepted\">Accepted</option>'  \n"
    "              + '<option value=\"declined\">Declined</option>'  \n"
    "              + '<option value=\"expired\">Expired</option>'  \n"
    "            + '</select>'  \n"
    "          + '</label>'  \n"
    "          + '<label class=\"lf-field\">'  \n"
    "            + '<span class=\"lf-label\">Estimate Amount ($)</span>'  \n"
    "            + '<input name=\"estimateAmount\" type=\"number\" class=\"lf-input lf-input--value\" placeholder=\"Quoted amount\" min=\"0\" step=\"100\">'  \n"
    "          + '</label>'  \n"
    "          + '<label class=\"lf-field\">'  \n"
    "            + '<span class=\"lf-label\">Date Sent to Customer</span>'  \n"
    "            + '<input name=\"estimateSentDate\" type=\"date\" class=\"lf-input\">'  \n"
    "          + '</label>'  \n"
    "          + '<label class=\"lf-field\">'  \n"
    "            + '<span class=\"lf-label\"># of Estimates Issued</span>'  \n"
    "            + '<input name=\"estimateCount\" type=\"number\" class=\"lf-input\" placeholder=\"e.g. 1\" min=\"0\" step=\"1\" value=\"0\">'  \n"
    "          + '</label>'  \n"
    "        + '</div>'  \n"
    "      + '</div>'\n"
    "\n"
)

ANCHOR_1B = "      // \u2500\u2500 Optional detail toggle \u2500\u2500"
if ANCHOR_1B not in app:
    print('ERROR: Could not find anchor for estimate section (1B)')
    sys.exit(1)

app = app.replace(ANCHOR_1B, ESTIMATE_SECTION + '      ' + ANCHOR_1B.strip(), 1)
print('PATCH 1B: Estimate Section 4 added to lead() form')


# ─── PATCH 1C: Add estimate fields to opportunityDetail() form grid ───

# The oppForm has a form-grid. We'll add estimate fields after the existing form-grid inputs
# Anchor: the line with textarea('prompt',... which is right after the form-grid closing div

OLD_1C = "      ${textarea('prompt','What prompted the inquiry?',o.prompt)}${textarea('desiredOutcome','Desired outcome / what good looks like',o.desiredOutcome)}${textarea('fitConcerns','Fit concerns / risk flags',o.fitConcerns)}"

NEW_1C = r"""      <div class="form-grid" style="margin-top:16px;padding-top:16px;border-top:1px solid #1e293b">
        <div style="grid-column:1/-1;margin-bottom:4px">
          <span style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#7c3aed">Estimate Tracking</span>
          <span style="font-size:11px;color:#475569;margin-left:8px">Paper on the Street data</span>
        </div>
        <label><span>Estimate Status</span>
          <select id="estimateStatusEdit" name="estimateStatus">
            <option value="" ${!o.estimateStatus?'selected':''}>Not started</option>
            <option value="draft"             ${o.estimateStatus==='draft'?'selected':''}>Draft — not yet sent</option>
            <option value="sent"              ${o.estimateStatus==='sent'?'selected':''}>Sent — awaiting response</option>
            <option value="revised"           ${o.estimateStatus==='revised'?'selected':''}>Revised &amp; resent</option>
            <option value="viewed"            ${o.estimateStatus==='viewed'?'selected':''}>Viewed by customer</option>
            <option value="awaiting_response" ${o.estimateStatus==='awaiting_response'?'selected':''}>Awaiting response</option>
            <option value="accepted"          ${o.estimateStatus==='accepted'?'selected':''}>Accepted</option>
            <option value="declined"          ${o.estimateStatus==='declined'?'selected':''}>Declined</option>
            <option value="expired"           ${o.estimateStatus==='expired'?'selected':''}>Expired</option>
          </select>
        </label>
        ${inputEdit('estimateAmount','Estimate Amount ($)',o.estimateAmount,'number')}
        ${inputEdit('estimateSentDate','Date Sent to Customer',o.estimateSentDate,'date')}
        ${inputEdit('estimateCount','# Estimates Issued',o.estimateCount,'number')}
      </div>
      ${textarea('prompt','What prompted the inquiry?',o.prompt)}${textarea('desiredOutcome','Desired outcome / what good looks like',o.desiredOutcome)}${textarea('fitConcerns','Fit concerns / risk flags',o.fitConcerns)}"""

if OLD_1C not in app:
    print('ERROR: Could not find anchor for opportunityDetail estimate fields (1C)')
    sys.exit(1)

app = app.replace(OLD_1C, NEW_1C, 1)
print('PATCH 1C: Estimate fields added to opportunityDetail() form')


# ─── PATCH 1D: Add Division Pipeline drill-down section to manager() ───
# Insert after the monthly budget table card (after the closing </div> of that card)
# and before the HubSpot pipeline card

# Anchor: the HubSpot pipeline section start
ANCHOR_1D_OLD = "    <div class=\"card mt\">\n      <h2>\\ud83d\\udd35 HubSpot 7-Stage Pipeline"

DIVISION_PIPELINE_SECTION = r"""    <!-- ── DIVISION PIPELINE / PAPER ON THE STREET ── -->
    <div class="card mt" id="divPipelineSection">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;flex-wrap:wrap;gap:8px">
        <div>
          <h2 style="margin:0;font-size:16px">Pipeline by Division</h2>
          <div style="font-size:11px;color:#64748b;margin-top:3px">
            <strong style="color:#7c3aed">Paper on the Street</strong>
            <span style="color:#475569"> = active quoted / proposed value currently in front of customers, not yet sold or lost</span>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap" id="dpFilterRow">
          <select id="dpRepFilter" onchange="renderDivisionPipelineTable()" style="padding:5px 10px;background:#0f172a;border:1px solid #1e293b;border-radius:8px;color:#e2e8f0;font-size:11px">
            <option value="">All Reps</option>
            ${(window.REPS||[]).filter(r=>r.role==='rep').map(r=>`<option value="${r.id}">${r.name}</option>`).join('')}
          </select>
          <select id="dpEstFilter" onchange="renderDivisionPipelineTable()" style="padding:5px 10px;background:#0f172a;border:1px solid #1e293b;border-radius:8px;color:#e2e8f0;font-size:11px">
            <option value="">All Estimate Statuses</option>
            <option value="sent">Sent</option>
            <option value="revised">Revised</option>
            <option value="viewed">Viewed</option>
            <option value="awaiting_response">Awaiting Response</option>
          </select>
        </div>
      </div>

      <div id="dpTableWrap" style="overflow-x:auto;margin-top:8px"></div>

      <!-- Aging Buckets -->
      <div style="margin-top:20px;border-top:1px solid #1e293b;padding-top:16px">
        <h3 style="font-size:13px;font-weight:700;color:#94a3b8;margin:0 0 10px;text-transform:uppercase;letter-spacing:.08em">Estimate Aging — Open Paper</h3>
        <div id="dpAgingWrap" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px"></div>
      </div>
    </div>

    <div class="card mt">
      <h2>&#x1F535; HubSpot 7-Stage Pipeline""" + " \u2014 Win Probabilities &amp; Gate Fields"

if ANCHOR_1D_OLD not in app:
    # Try alternate match
    ANCHOR_1D_OLD = "    <div class=\"card mt\">\n      <h2>\\ud83d\\udd35 HubSpot"
    if ANCHOR_1D_OLD not in app:
        print('WARN: HubSpot anchor not found literally, trying unicode-safe search...')
        # Search for the unique substring
        idx = app.find('<h2>\\ud83d\\udd35 HubSpot 7-Stage')
        if idx == -1:
            idx = app.find('HubSpot 7-Stage Pipeline')
        print(f'  HubSpot anchor index: {idx}')
        # Find the start of that card
        card_start = app.rfind('<div class="card mt">', 0, idx)
        print(f'  card_start: {card_start}')

print('PATCH 1D: Proceeding...')

# Use a simpler anchor: find "HubSpot 7-Stage Pipeline" and back up to the card div
HS_MARKER = 'HubSpot 7-Stage Pipeline'
idx = app.find(HS_MARKER)
if idx == -1:
    print('ERROR: Cannot find HubSpot 7-Stage Pipeline in app_premium.js')
    sys.exit(1)

card_open = app.rfind('\n    <div class="card mt">', 0, idx)
if card_open == -1:
    print('ERROR: Cannot find card div before HubSpot section')
    sys.exit(1)

INSERT_BEFORE = app[card_open:]  # from the HubSpot card div onward
# We'll replace from card_open: inject new section, then keep the rest

DP_MANAGER_SECTION = """
    <!-- ── DIVISION PIPELINE / PAPER ON THE STREET ── -->
    <div class="card mt" id="divPipelineSection">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;flex-wrap:wrap;gap:8px">
        <div>
          <h2 style="margin:0;font-size:16px">Pipeline by Division</h2>
          <div style="font-size:11px;color:#64748b;margin-top:3px">
            <strong style="color:#a78bfa">Paper on the Street</strong>
            <span style="color:#475569"> = active quoted / proposed value currently in front of customers, not yet sold or lost</span>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <select id="dpRepFilter" onchange="window._renderDpTable&&window._renderDpTable()" style="padding:5px 10px;background:#0f172a;border:1px solid #1e293b;border-radius:8px;color:#e2e8f0;font-size:11px">
            <option value="">All Reps</option>
            ${(window.REPS||[]).filter(r=>r.role==='rep').map(r=>\`<option value="\${r.id}">\${r.name}</option>\`).join('')}
          </select>
          <select id="dpEstFilter" onchange="window._renderDpTable&&window._renderDpTable()" style="padding:5px 10px;background:#0f172a;border:1px solid #1e293b;border-radius:8px;color:#e2e8f0;font-size:11px">
            <option value="">All Estimate Statuses</option>
            <option value="sent">Sent</option>
            <option value="revised">Revised</option>
            <option value="viewed">Viewed</option>
            <option value="awaiting_response">Awaiting Response</option>
          </select>
        </div>
      </div>

      <div id="dpTableWrap" style="overflow-x:auto;margin-top:8px"></div>

      <div style="margin-top:20px;border-top:1px solid #1e293b;padding-top:16px">
        <h3 style="font-size:13px;font-weight:700;color:#94a3b8;margin:0 0 10px;text-transform:uppercase;letter-spacing:.08em">Estimate Aging \u2014 Open Paper</h3>
        <div id="dpAgingWrap" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px"></div>
      </div>
    </div>

"""

app = app[:card_open] + DP_MANAGER_SECTION + app[card_open:]
print('PATCH 1D: Division Pipeline drill-down section inserted in manager()')


# ─── PATCH 1E: Wire up the table render function after manager() sets view.innerHTML ───
# We need to add the _renderDpTable() call after view.innerHTML is set in manager()
# Find the end of manager() — look for the closing of view.innerHTML = `...`; followed by }

# The pattern: after the big template literal in manager(), there's a closing backtick+semicolon
# Then we can inject the render call

# Find the manager function end
MANAGER_END_ANCHOR = "    </div>\n  `;\n}\nfunction input("
if MANAGER_END_ANCHOR not in app:
    # Try alternate
    MANAGER_END_ANCHOR_ALT = "  `;\n}\nfunction input("
    if MANAGER_END_ANCHOR_ALT not in app:
        print('WARN: manager() end anchor not found cleanly')
    else:
        MANAGER_END_ANCHOR = MANAGER_END_ANCHOR_ALT

RENDER_DP_JS = r"""

  // ── Division Pipeline table render ──────────────────────────────────────
  window._renderDpTable = function() {
    const repFilter = (document.getElementById('dpRepFilter')||{}).value || '';
    const estFilter = (document.getElementById('dpEstFilter')||{}).value || '';
    const opps = (typeof state !== 'undefined' ? state.opportunities : []) || [];
    const POTS_STATUSES = ['sent','revised','viewed','awaiting_response','awaiting response'];
    const POTS_STAGES   = ['Estimate Sent','Proposal Under Review','Negotiating','Decision Pending','Follow-Up'];

    function getDiv(o) {
      const cat = (o.projectCategory||'').toLowerCase();
      const wt  = (o.workType||'').toLowerCase();
      const sl  = (o.serviceLine||'').toLowerCase();
      if (cat.includes('snow')||wt.includes('snow')||sl.includes('snow')) return 'snow';
      if (cat.includes('mainten')||wt.includes('mainten')||sl.includes('mainten')) return 'maintenance';
      return 'landscape';
    }

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);
    const STAGE_WIN = {'New Lead':.10,'Contacted':.15,'Site Visit Scheduled':.25,'Site Visit Complete':.35,
      'Estimating':.45,'Estimate Sent':.55,'Proposal Under Review':.65,'Negotiating':.75,
      'Follow-Up':.50,'Decision Pending':.70,'Sold / Activation':1.0,'Closed Lost':0.0};

    const KEYS = ['landscape','maintenance','snow'];
    const LABELS = {landscape:'Landscape',maintenance:'Maintenance',snow:'Snow & Ice'};
    const COLORS = {landscape:'#22d3ee',maintenance:'#4ade80',snow:'#60a5fa'};

    const stats = {};
    KEYS.forEach(k => { stats[k] = {openVal:0,estVal:0,pots:0,weighted:0,openCt:0,estCt:0,ageDays:[],risk7:0,soldMo:0,soldMoCt:0,sold:0,soldCt:0,lost:0,lostCt:0}; });

    opps.forEach(o => {
      if (repFilter && o.repId !== repFilter) return;
      const estSt = (o.estimateStatus||'').toLowerCase().replace(/ /g,'_');
      if (estFilter && estSt !== estFilter) return;

      const d = stats[getDiv(o)];
      if (!d) return;
      const val = parseFloat(o.jobValue||0);
      const estAmt = parseFloat(o.estimateAmount||val);
      const isSold = o.status==='Sold / Activation';
      const isLost = o.status==='Closed Lost';

      if (isSold) { d.sold+=val; d.soldCt++; if ((o.updatedAt||'').slice(0,10)>=startOfMonth){d.soldMo+=val;d.soldMoCt++;} }
      if (isLost) { d.lostCt++; }
      if (isSold||isLost) return;

      d.openCt++; d.openVal+=val; d.weighted+=val*(STAGE_WIN[o.status]||0.20);
      const hasEst = POTS_STATUSES.includes(estSt)||POTS_STATUSES.includes((o.estimateStatus||'').toLowerCase())||POTS_STAGES.includes(o.status);
      if (hasEst&&estAmt>0) {
        d.estCt++; d.estVal+=estAmt; d.pots+=estAmt;
        const sentDate = o.estimateSentDate||o.updatedAt||o.createdAt;
        if (sentDate) { const age=Math.floor((now-new Date(sentDate))/86400000); if(age>=0)d.ageDays.push(age); }
      }
      if (o.nextFollowUp) { const days=Math.floor((new Date(o.nextFollowUp+'T12:00:00')-now)/86400000); if(days>=0&&days<=7)d.risk7++; }
    });

    function fm(n){ return n!=null?n.toLocaleString(undefined,{style:'currency',currency:'USD',maximumFractionDigits:0}):'—'; }
    function cr(d){ const tot=d.soldCt+d.lostCt; return tot>0?Math.round(d.soldCt/tot*100)+'%':'—'; }
    function avgAge(d){ return d.ageDays.length>0?Math.round(d.ageDays.reduce((a,b)=>a+b,0)/d.ageDays.length):null; }
    function maxAge(d){ return d.ageDays.length>0?Math.max(...d.ageDays):null; }
    function ageColor(days){ if(days==null)return'#475569'; if(days<=7)return'#4ade80'; if(days<=14)return'#fbbf24'; if(days<=30)return'#f97316'; return'#f87171'; }

    const totals = {
      openVal:KEYS.reduce((a,k)=>a+stats[k].openVal,0),
      estVal:KEYS.reduce((a,k)=>a+stats[k].estVal,0),
      pots:KEYS.reduce((a,k)=>a+stats[k].pots,0),
      weighted:KEYS.reduce((a,k)=>a+stats[k].weighted,0),
      openCt:KEYS.reduce((a,k)=>a+stats[k].openCt,0),
      estCt:KEYS.reduce((a,k)=>a+stats[k].estCt,0),
      risk7:KEYS.reduce((a,k)=>a+stats[k].risk7,0),
      soldMo:KEYS.reduce((a,k)=>a+stats[k].soldMo,0),
    };

    const headerRow = `<tr style="background:#0f172a">
      <th style="padding:8px 10px;text-align:left;color:#64748b;border-bottom:1px solid #1e293b;font-size:11px">Division</th>
      <th style="padding:8px 10px;text-align:right;color:#64748b;border-bottom:1px solid #1e293b;font-size:11px">Open Pipeline</th>
      <th style="padding:8px 10px;text-align:right;color:#a78bfa;border-bottom:1px solid #1e293b;font-size:11px" title="Active quoted/proposed value in front of customers, not yet sold or lost">Paper on the Street</th>
      <th style="padding:8px 10px;text-align:right;color:#64748b;border-bottom:1px solid #1e293b;font-size:11px">Open Est. Value</th>
      <th style="padding:8px 10px;text-align:right;color:#64748b;border-bottom:1px solid #1e293b;font-size:11px">Weighted</th>
      <th style="padding:8px 10px;text-align:center;color:#64748b;border-bottom:1px solid #1e293b;font-size:11px">Active Opps</th>
      <th style="padding:8px 10px;text-align:center;color:#64748b;border-bottom:1px solid #1e293b;font-size:11px">Open Ests</th>
      <th style="padding:8px 10px;text-align:center;color:#64748b;border-bottom:1px solid #1e293b;font-size:11px">Avg Age</th>
      <th style="padding:8px 10px;text-align:center;color:#64748b;border-bottom:1px solid #1e293b;font-size:11px">Oldest</th>
      <th style="padding:8px 10px;text-align:center;color:#64748b;border-bottom:1px solid #1e293b;font-size:11px">7d Risk</th>
      <th style="padding:8px 10px;text-align:right;color:#64748b;border-bottom:1px solid #1e293b;font-size:11px">Sold Mo.</th>
      <th style="padding:8px 10px;text-align:center;color:#64748b;border-bottom:1px solid #1e293b;font-size:11px">Close Rate</th>
    </tr>`;

    const divRows = KEYS.map(k => {
      const d = stats[k]; const avg=avgAge(d); const mx=maxAge(d);
      return `<tr style="border-bottom:1px solid #0f172a">
        <td style="padding:8px 10px;font-weight:700;color:${COLORS[k]}">${LABELS[k]}</td>
        <td style="padding:8px 10px;text-align:right;font-weight:600">${fm(d.openVal)}</td>
        <td style="padding:8px 10px;text-align:right;font-weight:800;color:#a78bfa">${fm(d.pots)}</td>
        <td style="padding:8px 10px;text-align:right;color:#94a3b8">${fm(d.estVal)}</td>
        <td style="padding:8px 10px;text-align:right;color:#94a3b8">${fm(d.weighted)}</td>
        <td style="padding:8px 10px;text-align:center">${d.openCt}</td>
        <td style="padding:8px 10px;text-align:center">${d.estCt}</td>
        <td style="padding:8px 10px;text-align:center;color:${ageColor(avg)};font-weight:600">${avg!=null?avg+'d':'—'}</td>
        <td style="padding:8px 10px;text-align:center;color:${ageColor(mx)};font-weight:600">${mx!=null?mx+'d':'—'}</td>
        <td style="padding:8px 10px;text-align:center;color:${d.risk7>0?'#fbbf24':'#4ade80'};font-weight:700">${d.risk7}</td>
        <td style="padding:8px 10px;text-align:right;color:#4ade80;font-weight:700">${fm(d.soldMo)}</td>
        <td style="padding:8px 10px;text-align:center;font-weight:700;color:#00d4ff">${cr(d)}</td>
      </tr>`;
    }).join('');

    const totRow = `<tr style="background:#0d1829;border-top:2px solid #1e293b">
      <td style="padding:9px 10px;font-weight:800;color:#e2e8f0">Total</td>
      <td style="padding:9px 10px;text-align:right;font-weight:800;color:#e2e8f0">${fm(totals.openVal)}</td>
      <td style="padding:9px 10px;text-align:right;font-weight:900;color:#a78bfa">${fm(totals.pots)}</td>
      <td style="padding:9px 10px;text-align:right;font-weight:700;color:#94a3b8">${fm(totals.estVal)}</td>
      <td style="padding:9px 10px;text-align:right;color:#94a3b8">${fm(totals.weighted)}</td>
      <td style="padding:9px 10px;text-align:center;font-weight:700">${totals.openCt}</td>
      <td style="padding:9px 10px;text-align:center;font-weight:700">${totals.estCt}</td>
      <td colspan="2" style="padding:9px 10px;text-align:center;color:#475569">—</td>
      <td style="padding:9px 10px;text-align:center;font-weight:700;color:${totals.risk7>0?'#fbbf24':'#4ade80'}">${totals.risk7}</td>
      <td style="padding:9px 10px;text-align:right;font-weight:800;color:#4ade80">${fm(totals.soldMo)}</td>
      <td style="padding:9px 10px"></td>
    </tr>`;

    const tableWrap = document.getElementById('dpTableWrap');
    if (tableWrap) {
      tableWrap.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px;min-width:700px">
        <thead>${headerRow}</thead>
        <tbody>${divRows}${totRow}</tbody>
      </table>`;
    }

    // Aging buckets
    const allAgeDays = KEYS.flatMap(k => {
      const d = stats[k];
      return d.ageDays.map(age => ({age, label:LABELS[k], color:COLORS[k], val:0}));
    });
    // Re-compute aging by day bucket across all opps
    const buckets = [{label:'0–7 days',max:7,count:0,val:0,color:'#4ade80'},{label:'8–14 days',min:8,max:14,count:0,val:0,color:'#fbbf24'},{label:'15–30 days',min:15,max:30,count:0,val:0,color:'#f97316'},{label:'30+ days',min:31,count:0,val:0,color:'#f87171'}];
    const POTS_S = ['sent','revised','viewed','awaiting_response','awaiting response'];
    const POTS_ST = ['Estimate Sent','Proposal Under Review','Negotiating','Decision Pending','Follow-Up'];
    opps.forEach(o => {
      if (repFilter && o.repId !== repFilter) return;
      const estSt2 = (o.estimateStatus||'').toLowerCase().replace(/ /g,'_');
      if (estFilter && estSt2 !== estFilter) return;
      if (['Sold / Activation','Closed Lost'].includes(o.status)) return;
      const hasEst2 = POTS_S.includes(estSt2)||POTS_S.includes((o.estimateStatus||'').toLowerCase())||POTS_ST.includes(o.status);
      if (!hasEst2) return;
      const sentDate2 = o.estimateSentDate||o.updatedAt||o.createdAt;
      if (!sentDate2) return;
      const age2 = Math.floor((now-new Date(sentDate2))/86400000);
      const estAmt2 = parseFloat(o.estimateAmount||o.jobValue||0);
      const b = age2<=7?buckets[0]:age2<=14?buckets[1]:age2<=30?buckets[2]:buckets[3];
      b.count++; b.val+=estAmt2;
    });

    const agingWrap = document.getElementById('dpAgingWrap');
    if (agingWrap) {
      agingWrap.innerHTML = buckets.map(b => `
        <div style="background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px">${b.label}</div>
          <div style="font-size:22px;font-weight:800;color:${b.color}">${b.count}</div>
          <div style="font-size:12px;color:#94a3b8;margin-top:2px">estimates</div>
          <div style="font-size:13px;font-weight:700;color:${b.color};margin-top:4px">${b.val>0?b.val.toLocaleString(undefined,{style:'currency',currency:'USD',maximumFractionDigits:0}):'—'}</div>
        </div>`).join('');
    }
  };
  // Render immediately after DOM is set
  setTimeout(window._renderDpTable, 80);
"""

# Insert this render function right before the closing of manager() — after the view.innerHTML assignment closes
# Find the end of the view.innerHTML template literal in manager()
# Pattern: the last `  ` + backtick + semicolon before closing brace of manager()

# Find manager function start
manager_start = app.find('\nfunction manager(){')
if manager_start == -1:
    print('ERROR: Cannot find function manager(){}')
    sys.exit(1)

# Find "  `;\n}" after manager_start
manager_end_pattern = "\n  `;\n}"
manager_end_idx = app.find(manager_end_pattern, manager_start)
if manager_end_idx == -1:
    print('ERROR: Cannot find end of manager() template literal')
    sys.exit(1)

# Insert RENDER_DP_JS just before the closing backtick
# app[manager_end_idx] is "\n  `;\n}"
# We want: <existing> + RENDER_DP_JS + "\n  `;\n}"
app = app[:manager_end_idx] + RENDER_DP_JS + app[manager_end_idx:]
print('PATCH 1E: _renderDpTable() function injected into manager()')

with open(APP_PATH, 'w', encoding='utf-8') as f:
    f.write(app)
print(f'app_premium.js written ({len(app)} chars)')


# ─── PATCH 2: reps.js — Insert Paper on the Street panel ───

REPS_PATH = '/home/user/webapp/public/static/reps.js'

with open(REPS_PATH, 'r', encoding='utf-8') as f:
    reps = f.read()

# Insertion point: between the closing </div> of Section 3 (Monthly Budget) at line 1066
# and the comment "<!-- ── SECTION 4: PIPELINE HEALTH + COMMISSION QUEUE ── -->"

ANCHOR_2_OLD = "\n<!-- \u2500\u2500 SECTION 4: PIPELINE HEALTH + COMMISSION QUEUE \u2500\u2500 -->"
if ANCHOR_2_OLD not in reps:
    print('WARN: Section 4 anchor not found with dashes, trying plain...')
    ANCHOR_2_OLD = "\n<!-- \u2500\u2500 SECTION 4:"
    if ANCHOR_2_OLD not in reps:
        # Try with actual line content
        idx4 = reps.find('SECTION 4: PIPELINE HEALTH')
        print(f'  SECTION 4 index: {idx4}')
        if idx4 > -1:
            # find the start of that comment line
            line_start = reps.rfind('\n', 0, idx4)
            ANCHOR_2_OLD = reps[line_start:line_start+80]
            print(f'  Using anchor: {repr(ANCHOR_2_OLD)}')

POTS_DASHBOARD_SECTION = """
<!-- \u2500\u2500 SECTION 3B: PIPELINE BY DIVISION \u2500\u2500 -->
<div style="margin-bottom:24px">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">
    <div>
      <h2 style="margin:0;font-size:16px">Pipeline by Division</h2>
      <div style="font-size:11px;color:#64748b;margin-top:3px">
        <strong style="color:#a78bfa">Paper on the Street</strong>
        = active quoted/proposed value currently in front of customers, not yet sold or lost
      </div>
    </div>
    <button onclick="show('manager')" style="padding:6px 14px;background:rgba(167,139,250,.12);border:1px solid #7c3aed40;border-radius:8px;color:#a78bfa;font-size:11px;font-weight:700;cursor:pointer">
      Full Drill-Down \u2192
    </button>
  </div>

  <div id="dashDivPipeline" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px"></div>
</div>
"""

if ANCHOR_2_OLD not in reps:
    print('ERROR: Cannot find Section 4 anchor in reps.js')
    sys.exit(1)

reps = reps.replace(ANCHOR_2_OLD, POTS_DASHBOARD_SECTION + ANCHOR_2_OLD, 1)
print('PATCH 2A: Division Pipeline section inserted in reps.js dashboard')


# Now inject the JS that populates #dashDivPipeline after the admin dashboard
# The admin function renders the dashboard template. Find the end of the template
# and inject a setTimeout that calls buildDivisionPipeline() and renders the cards.

# Find where the admin dashboard template ends and we can inject JS
# In reps.js the pattern is: view.innerHTML = `...`; followed by setTimeout or similar

REPS_RENDER_ANCHOR = "// ── Build admin dashboard ──"
if REPS_RENDER_ANCHOR not in reps:
    # Try alternate
    REPS_RENDER_ANCHOR = "view.innerHTML = adminDashHtml"
    if REPS_RENDER_ANCHOR not in reps:
        # Find the assignment by looking for adminDashHtml
        idx_assign = reps.find('view.innerHTML')
        print(f'  view.innerHTML index: {idx_assign}')

# Simpler approach: find the end of the admin dashboard view.innerHTML template
# Pattern: the template closes and then there's JS code following it
# Look for the setTimeout(() => { that's after the template

# Find "setTimeout(() => {" after the admin template is set
admin_tmpl_close = reps.rfind('view.innerHTML')
print(f'  admin view.innerHTML at: {admin_tmpl_close}')

# Find the semicolon that ends the view.innerHTML assignment
semi_idx = reps.find(';\n', admin_tmpl_close)
if semi_idx == -1:
    semi_idx = reps.find(';', admin_tmpl_close)
print(f'  semi_idx: {semi_idx}')

# Check what's right after
print(f'  After semi: {repr(reps[semi_idx:semi_idx+100])}')

POTS_DASH_RENDER_JS = """

  // ── Populate Paper on the Street division cards ──────────────────────────
  setTimeout(function() {
    const wrap = document.getElementById('dashDivPipeline');
    if (!wrap) return;
    if (typeof buildDivisionPipeline !== 'function') return;
    const dp = buildDivisionPipeline();
    const KEYS = dp.keys;
    const divs = dp.divisions;
    function fm(n){ return n!=null?n.toLocaleString(undefined,{style:'currency',currency:'USD',maximumFractionDigits:0}):'—'; }
    function ageColor(d){ if(d==null)return'#475569'; if(d<=7)return'#4ade80'; if(d<=14)return'#fbbf24'; if(d<=30)return'#f97316'; return'#f87171'; }
    wrap.innerHTML = KEYS.map(k => {
      const d = divs[k];
      const potsColor = d.paperOnStreet > 0 ? '#a78bfa' : '#475569';
      const crStr = d.closeRatePct != null ? d.closeRatePct + '%' : '—';
      const avgAgeStr = d.avgEstimateAge != null ? d.avgEstimateAge + 'd' : '—';
      const oldestStr = d.oldestEstimateAge != null ? d.oldestEstimateAge + 'd' : '—';
      return `<div style="background:linear-gradient(135deg,#0d1e35,#0a1628);border:1px solid #1e3a5f;border-radius:14px;padding:18px">
        <div style="font-size:13px;font-weight:800;color:${d.color};margin-bottom:12px;text-transform:uppercase;letter-spacing:.06em">${d.label}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div>
            <div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Open Pipeline</div>
            <div style="font-size:15px;font-weight:800;color:#e2e8f0">${fm(d.openValue)}</div>
          </div>
          <div>
            <div style="font-size:9px;color:#a78bfa;text-transform:uppercase;font-weight:600" title="Active quoted/proposed value not yet sold or lost">Paper on Street</div>
            <div style="font-size:15px;font-weight:800;color:${potsColor}">${fm(d.paperOnStreet)}</div>
          </div>
          <div>
            <div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Weighted</div>
            <div style="font-size:13px;font-weight:700;color:#94a3b8">${fm(d.weightedPipeline)}</div>
          </div>
          <div>
            <div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Sold This Mo.</div>
            <div style="font-size:13px;font-weight:700;color:#4ade80">${fm(d.soldThisMonth)}</div>
          </div>
          <div>
            <div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Active Opps</div>
            <div style="font-size:16px;font-weight:800;color:#e2e8f0">${d.openCount}</div>
          </div>
          <div>
            <div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Open Ests</div>
            <div style="font-size:16px;font-weight:800;color:#e2e8f0">${d.openEstimateCount}</div>
          </div>
          <div>
            <div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Avg Est. Age</div>
            <div style="font-size:13px;font-weight:700;color:${ageColor(d.avgEstimateAge)}">${avgAgeStr}</div>
          </div>
          <div>
            <div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Oldest Est.</div>
            <div style="font-size:13px;font-weight:700;color:${ageColor(d.oldestEstimateAge)}">${oldestStr}</div>
          </div>
          <div>
            <div style="font-size:9px;color:#fbbf24;text-transform:uppercase;font-weight:600">7d Follow-Up Risk</div>
            <div style="font-size:16px;font-weight:800;color:${d.sevenDayRisk>0?'#fbbf24':'#4ade80'}">${d.sevenDayRisk}</div>
          </div>
          <div>
            <div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Close Rate</div>
            <div style="font-size:13px;font-weight:700;color:#00d4ff">${crStr}</div>
          </div>
        </div>
      </div>`;
    }).join('') + `<div style="background:linear-gradient(135deg,#0a1628,#071525);border:1px solid #334155;border-radius:14px;padding:18px">
      <div style="font-size:13px;font-weight:800;color:#e2e8f0;margin-bottom:12px;text-transform:uppercase;letter-spacing:.06em">Total</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Open Pipeline</div><div style="font-size:15px;font-weight:800;color:#e2e8f0">${fm(divs.total.openValue)}</div></div>
        <div><div style="font-size:9px;color:#a78bfa;text-transform:uppercase;font-weight:600">Paper on Street</div><div style="font-size:15px;font-weight:800;color:#a78bfa">${fm(divs.total.paperOnStreet)}</div></div>
        <div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Weighted</div><div style="font-size:13px;font-weight:700;color:#94a3b8">${fm(divs.total.weightedPipeline)}</div></div>
        <div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Sold This Mo.</div><div style="font-size:13px;font-weight:700;color:#4ade80">${fm(divs.total.soldThisMonth)}</div></div>
        <div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Active Opps</div><div style="font-size:16px;font-weight:800;color:#e2e8f0">${divs.total.openCount}</div></div>
        <div><div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:600">Open Ests</div><div style="font-size:16px;font-weight:800;color:#e2e8f0">${divs.total.openEstimateCount}</div></div>
        <div><div style="font-size:9px;color:#fbbf24;text-transform:uppercase;font-weight:600">7d Risk Total</div><div style="font-size:16px;font-weight:800;color:${divs.total.sevenDayRisk>0?'#fbbf24':'#4ade80'}">${divs.total.sevenDayRisk}</div></div>
        <div></div>
      </div>
    </div>`;
  }, 100);
"""

# Find the view.innerHTML assignment end in reps.js and inject after it
# reps.js uses view.innerHTML = adminDashHtml style — let's find it
reps_vi_idx = reps.rfind('view.innerHTML')
reps_semi = reps.find(';', reps_vi_idx)
if reps_semi == -1:
    print('ERROR: Cannot find semicolon after view.innerHTML in reps.js')
    sys.exit(1)

# Check what's at that semicolon
print(f'reps.js: view.innerHTML ends at {reps_semi}, char after: {repr(reps[reps_semi:reps_semi+50])}')

reps = reps[:reps_semi+1] + POTS_DASH_RENDER_JS + reps[reps_semi+1:]
print('PATCH 2B: Paper on the Street dashboard render JS injected')

with open(REPS_PATH, 'w', encoding='utf-8') as f:
    f.write(reps)
print(f'reps.js written ({len(reps)} chars)')


# ─── PATCH 3: premium.css — Add Division Pipeline CSS ───

CSS_PATH = '/home/user/webapp/public/static/premium.css'

with open(CSS_PATH, 'r', encoding='utf-8') as f:
    css = f.read()

DP_CSS = """

/* ── Division Pipeline / Paper on the Street ─────────────────────────────── */
#dashDivPipeline, #dpTableWrap, #dpAgingWrap { transition: opacity .2s; }

.dp-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:6px; flex-wrap:wrap; gap:8px; }
.dp-title { font-size:16px; font-weight:700; margin:0; color:var(--fg); }
.dp-subtitle { font-size:11px; color:#64748b; margin-top:3px; }
.dp-subtitle strong { color:#a78bfa; }

/* Estimate status chip inside opp detail */
.est-status-chip {
  display: inline-block;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  background: rgba(124,58,237,.15);
  color: #a78bfa;
  border: 1px solid rgba(124,58,237,.3);
}
.est-status-chip.sent      { background:rgba(250,204,21,.12); color:#fbbf24; border-color:rgba(250,204,21,.3); }
.est-status-chip.viewed    { background:rgba(96,165,250,.12); color:#60a5fa; border-color:rgba(96,165,250,.3); }
.est-status-chip.accepted  { background:rgba(74,222,128,.12); color:#4ade80; border-color:rgba(74,222,128,.3); }
.est-status-chip.declined  { background:rgba(248,113,113,.12); color:#f87171; border-color:rgba(248,113,113,.3); }
.est-status-chip.expired   { background:rgba(100,116,139,.12); color:#64748b; border-color:rgba(100,116,139,.3); }

/* Lead form Section 4 (estimate) number badge */
.lf-section-num.est { background: linear-gradient(135deg,#7c3aed,#6d28d9); }

/* Aging color helpers (used inline but kept here for reference) */
/* age-ok:#4ade80  age-warn:#fbbf24  age-risk:#f97316  age-over:#f87171 */

/* missing-data-badge already defined; adding dp-specific missing variant */
.dp-empty {
  text-align: center;
  color: #475569;
  font-size: 13px;
  padding: 20px;
}
/* ────────────────────────────────────────────────────────────────────────── */
"""

css = css.rstrip() + '\n' + DP_CSS

with open(CSS_PATH, 'w', encoding='utf-8') as f:
    f.write(css)
print(f'premium.css written ({len(css)} chars)')
print('\nAll patches complete.')
