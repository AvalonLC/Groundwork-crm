#!/usr/bin/env python3
"""
Avalon Sales Hub — Comprehensive patch script
Applies all pending feature additions:
  1A. Font/contrast CSS improvements for dark cards
  2B. Monthly Revenue entry/edit admin page  
  3A. Calendar Month/Week/Agenda view toggle
  + Drive search results use int-list-row class
"""

import re

# ──────────────────────────────────────────────────────────────────────────────
# SECTION 1: premium.css — add dark card readability CSS + calendar toggle CSS
# ──────────────────────────────────────────────────────────────────────────────
PREMIUM_CSS_PATH = '/home/user/webapp/public/static/premium.css'

with open(PREMIUM_CSS_PATH, 'r') as f:
    premium_css = f.read()

# Add after the last line — add dark card contrast + calendar view CSS
EXTRA_CSS = """
/* ── Dark card readability improvements ─────────────────────────────────── */
/* Primary text on all dark sections */
[style*="background:#0f172a"] { color: #f1f5f9; }
[style*="background:#0a1628"] { color: #f1f5f9; }
[style*="background:linear-gradient(135deg,#0a1628"] { color: #f1f5f9; }
/* Stat/metric values on dark cards */
.dark-card-val { font-size: 1.7rem; font-weight: 800; color: #f8fafc !important; }
.dark-card-label { font-size: 10px; font-weight: 700; color: #94a3b8 !important; text-transform: uppercase; letter-spacing: .06em; }
.dark-card-green { color: #4ade80 !important; }
.dark-card-red   { color: #f87171 !important; }
.dark-card-yellow{ color: #fbbf24 !important; }
.dark-card-cyan  { color: #22d3ee !important; }
/* Month mini-card row on Owner Dashboard */
.month-mini-card { background:#111827; border:1px solid #1e293b; border-radius:10px; padding:10px 12px; min-width:80px; text-align:center; }
.month-mini-card .budget { font-size:11px; color:#64748b; }
.month-mini-card .actual { font-size:14px; font-weight:700; color:#22d3ee; }
.month-mini-card .variance.pos { color:#4ade80; }
.month-mini-card .variance.neg { color:#f87171; }
.month-mini-card .variance.none { color:#475569; }
/* Quick Actions integration buttons */
.int-action-btn {
  display:inline-flex; align-items:center; gap:7px;
  padding:9px 14px; border-radius:10px;
  border:2px solid var(--line); background:#fff;
  color:var(--blue-dark); font-size:13px; font-weight:700;
  cursor:pointer; text-decoration:none;
  transition:all .15s;
}
.int-action-btn:hover { background:var(--blue-soft); border-color:var(--blue); box-shadow:0 4px 12px rgba(0,167,225,.12); }
/* ── Calendar view toggle ──────────────────────────────────────────────── */
.cal-view-toggle { display:flex; gap:4px; background:#1e293b; border-radius:8px; padding:3px; }
.cal-view-btn { border:0; background:transparent; color:#94a3b8; font-size:12px; font-weight:600; padding:5px 12px; border-radius:6px; cursor:pointer; transition:all .12s; }
.cal-view-btn.active { background:#0f172a; color:#f1f5f9; box-shadow:0 1px 4px rgba(0,0,0,.4); }
.cal-view-btn:hover:not(.active) { color:#cbd5e1; }
/* Month grid */
.cal-month-grid { display:grid; grid-template-columns:repeat(7,1fr); gap:1px; background:#1e293b; border-radius:8px; overflow:hidden; margin-top:8px; }
.cal-month-day-header { background:#0f172a; color:#64748b; font-size:10px; font-weight:700; text-align:center; padding:6px 0; text-transform:uppercase; letter-spacing:.05em; }
.cal-month-cell { background:#0a0f1a; min-height:72px; padding:4px; position:relative; }
.cal-month-cell.today { background:#0f2a1a; }
.cal-month-cell.other-month { background:#06090f; opacity:.55; }
.cal-month-cell-num { font-size:11px; font-weight:700; color:#475569; margin-bottom:2px; width:20px; height:20px; display:flex; align-items:center; justify-content:center; border-radius:50%; }
.cal-month-cell.today .cal-month-cell-num { background:#00d4ff; color:#0a1628; }
.cal-event-chip { font-size:10px; font-weight:600; color:#e2e8f0; background:#1e3a5f; border-radius:3px; padding:1px 5px; margin-bottom:1px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer; }
.cal-event-chip:hover { background:#2563eb; }
/* Week columns */
.cal-week-grid { display:grid; grid-template-columns:48px repeat(7,1fr); gap:1px; background:#1e293b; border-radius:8px; overflow:hidden; margin-top:8px; }
.cal-week-header { background:#0f172a; padding:6px 4px; text-align:center; }
.cal-week-header .dow { font-size:10px; color:#64748b; font-weight:700; text-transform:uppercase; }
.cal-week-header .dom { font-size:16px; font-weight:800; color:#e2e8f0; line-height:1.2; }
.cal-week-header .dom.today-num { background:#00d4ff; color:#0a1628; border-radius:50%; width:28px; height:28px; display:flex; align-items:center; justify-content:center; margin:0 auto; }
.cal-week-time-label { background:#0a0f1a; padding:4px 4px; text-align:right; font-size:10px; color:#334155; border-bottom:1px solid #1e293b; }
.cal-week-cell { background:#0a0f1a; border-bottom:1px solid #111827; position:relative; min-height:28px; }
.cal-week-event { position:absolute; left:2px; right:2px; background:#1e3a5f; border-left:2px solid #2563eb; border-radius:3px; padding:1px 4px; font-size:10px; color:#93c5fd; overflow:hidden; z-index:1; cursor:pointer; }
.cal-week-event:hover { background:#1d4ed8; color:#fff; }
/* Revenue editor */
.rev-editor-table { width:100%; border-collapse:collapse; font-size:13px; }
.rev-editor-table thead tr { background:#0f172a; }
.rev-editor-table th { padding:10px 12px; text-align:left; color:#64748b; font-size:11px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; border-bottom:1px solid #1e293b; }
.rev-editor-table th.right { text-align:right; }
.rev-editor-table tbody tr { border-bottom:1px solid #0f172a; transition:background .1s; }
.rev-editor-table tbody tr:hover { background:#0f172a; }
.rev-editor-table td { padding:8px 12px; color:#e2e8f0; }
.rev-editor-table td.right { text-align:right; }
.rev-editor-input { width:100%; background:#0f172a; border:1px solid #1e293b; border-radius:6px; color:#f1f5f9; font-size:13px; font-weight:700; padding:6px 10px; text-align:right; box-sizing:border-box; }
.rev-editor-input:focus { border-color:#00d4ff; outline:none; }
.rev-editor-input.locked { opacity:.45; pointer-events:none; }
.rev-variance-pos { color:#4ade80; font-weight:700; }
.rev-variance-neg { color:#f87171; font-weight:700; }
.rev-variance-none { color:#334155; }
.rev-month-tag { font-size:10px; font-weight:800; letter-spacing:.06em; text-transform:uppercase; color:#94a3b8; margin-right:6px; }
.rev-locked-badge { font-size:9px; background:#1e293b; color:#475569; border-radius:4px; padding:1px 5px; margin-left:4px; vertical-align:middle; }
"""

if '/* ── Dark card readability improvements' not in premium_css:
    premium_css = premium_css.rstrip() + '\n' + EXTRA_CSS
    with open(PREMIUM_CSS_PATH, 'w') as f:
        f.write(premium_css)
    print('✅ premium.css — dark card CSS + calendar + revenue editor CSS added')
else:
    print('⚠️  premium.css — dark card CSS already present, skipping')


# ──────────────────────────────────────────────────────────────────────────────
# SECTION 2: app_premium.js
#   2a. Add Monthly Revenue editor functions (revenueAdmin page)
#   2b. Calendar view toggle in integrations (intLoadCalendar → calendar view)
#   2c. Drive search results use int-list-row
#   2d. Add 'revenueAdmin' to routes
# ──────────────────────────────────────────────────────────────────────────────
APP_PREMIUM_PATH = '/home/user/webapp/public/static/app_premium.js'

with open(APP_PREMIUM_PATH, 'r') as f:
    app_js = f.read()

# ── 2a: Add revenueAdmin() function before the show() call at the bottom ──────
REVENUE_ADMIN_FN = """
// ── Monthly Revenue Admin (Phase 2B) ─────────────────────────────────────────
const REV_ACTUALS_KEY = 'avalonRevenueActuals';
function loadRevenueActuals() {
  try { return JSON.parse(localStorage.getItem(REV_ACTUALS_KEY)) || {}; }
  catch(e) { return {}; }
}
function saveRevenueActuals(actuals) {
  localStorage.setItem(REV_ACTUALS_KEY, JSON.stringify(actuals));
}

function revenueAdmin() {
  const fy = window.AVALON_DATA.fy2026;
  const savedActuals = loadRevenueActuals();
  // Merge saved actuals with data.js actuals (saved wins)
  const months = (fy.monthlyBudget || []).map((m, idx) => {
    const saved = savedActuals[m.month];
    const actual = saved !== undefined ? saved : m.actual;
    const variance = actual != null ? actual - m.budgeted : null;
    return { ...m, actual, variance, idx };
  });

  function fmtM(n) { return n != null ? n.toLocaleString(undefined, { style:'currency', currency:'USD', maximumFractionDigits:0 }) : '—'; }

  // Compute YTD from months with actual
  const ytdBudget  = months.filter(m => m.actual != null).reduce((a,m) => a + m.budgeted, 0);
  const ytdActual  = months.filter(m => m.actual != null).reduce((a,m) => a + m.actual, 0);
  const ytdVar     = ytdActual - ytdBudget;
  const ytdVarColor= ytdVar >= 0 ? '#4ade80' : '#f87171';

  const currentMonthIdx = new Date().getMonth(); // 0-based

  const tableRows = months.map(m => {
    const isPast     = m.idx < currentMonthIdx;
    const isCurrent  = m.idx === currentMonthIdx;
    const hasActual  = m.actual != null;
    const varColor   = m.variance == null ? '#334155' : m.variance >= 0 ? '#4ade80' : '#f87171';
    const varSign    = m.variance != null && m.variance > 0 ? '+' : '';
    const lockBadge  = isPast && hasActual ? '<span class="rev-locked-badge">saved</span>' : '';
    return `<tr>
      <td><span class="rev-month-tag">${escapeHtml(m.month)}</span>${lockBadge}</td>
      <td class="right" style="color:#64748b">${fmtM(m.budgeted)}</td>
      <td class="right">
        <input class="rev-editor-input" type="number" min="0" step="1000"
          id="rev_actual_${m.idx}"
          value="${hasActual ? m.actual : ''}"
          placeholder="enter actual"
          onchange="revUpdateRow(${m.idx})"
          ${isCurrent || isPast ? '' : 'style="opacity:.5"'}
        >
      </td>
      <td class="right" id="rev_var_${m.idx}" style="color:${varColor};font-weight:700">${m.variance != null ? varSign + fmtM(m.variance) : '—'}</td>
      <td style="color:#64748b;font-size:12px" id="rev_notes_${m.idx}">
        <input style="background:transparent;border:none;border-bottom:1px solid #1e293b;width:100%;color:#94a3b8;font-size:12px;padding:4px 0" 
          placeholder="notes…" 
          id="rev_note_text_${m.idx}"
          value="${escapeHtml(savedActuals['note_'+m.month]||'')}">
      </td>
    </tr>`;
  }).join('');

  view.innerHTML = `
    <button class="secondary-btn" onclick="show('manager')">← Back to Manager Tools</button>
    <div class="eyebrow" style="margin-top:16px">Admin — FY2026</div>
    <h1>Monthly Revenue Editor</h1>
    <p class="lede">Enter or edit monthly actual revenue. Variance auto-calculates. Dashboard updates immediately on save.</p>

    <div style="background:linear-gradient(135deg,#0a1628,#0f172a);border:1px solid #1e4d6b;border-radius:14px;padding:20px;margin-bottom:24px">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:16px">
        <div style="text-align:center">
          <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.07em">YTD Budget</div>
          <div id="rev_ytd_budget" style="font-size:1.6rem;font-weight:900;color:#e2e8f0">${fmtM(ytdBudget)}</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.07em">YTD Actual</div>
          <div id="rev_ytd_actual" style="font-size:1.6rem;font-weight:900;color:#22d3ee">${fmtM(ytdActual)}</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.07em">YTD Variance</div>
          <div id="rev_ytd_var" style="font-size:1.6rem;font-weight:900;color:${ytdVarColor}">${ytdVar >= 0 ? '+' : ''}${fmtM(ytdVar)}</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.07em">Annual Budget</div>
          <div style="font-size:1.6rem;font-weight:900;color:#a78bfa">${fmtM(fy.annual.budgetedRevenue)}</div>
        </div>
      </div>
    </div>

    <div class="card" style="background:#0a0f1a;border:1px solid #1e293b;padding:0;overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #1e293b">
        <h2 style="margin:0;color:#f1f5f9;font-size:1.1rem">Budget vs Actual — Jan–Dec 2026</h2>
        <div style="display:flex;gap:8px">
          <button class="secondary-btn small" onclick="revSaveAll()" style="background:#16a34a;border-color:#16a34a;color:#fff">💾 Save All</button>
          <button class="secondary-btn small" onclick="revExportCsv()">📥 Export CSV</button>
        </div>
      </div>
      <div style="overflow-x:auto">
        <table class="rev-editor-table" id="revTable">
          <thead>
            <tr>
              <th>Month</th>
              <th class="right">Budgeted</th>
              <th class="right">Actual Revenue</th>
              <th class="right">Variance</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
          <tfoot>
            <tr style="background:#0f172a;font-weight:700;border-top:2px solid #1e293b">
              <td style="padding:12px;color:#e2e8f0">YTD Total</td>
              <td class="right" style="padding:12px;color:#64748b" id="rev_tfoot_budget">${fmtM(ytdBudget)}</td>
              <td class="right" style="padding:12px;color:#22d3ee" id="rev_tfoot_actual">${fmtM(ytdActual)}</td>
              <td class="right" style="padding:12px;color:${ytdVarColor}" id="rev_tfoot_var">${ytdVar >= 0 ? '+' : ''}${fmtM(ytdVar)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>

    <div class="card mt" style="background:#0a0f1a;border:1px solid #1e293b">
      <h3 style="color:#f1f5f9;margin-top:0">How This Works</h3>
      <ul style="color:#94a3b8;font-size:13px;line-height:1.7;margin:0;padding-left:18px">
        <li>Enter actual monthly revenue in the <strong style="color:#e2e8f0">Actual Revenue</strong> column</li>
        <li>Variance calculates automatically (Actual − Budget)</li>
        <li>Click <strong style="color:#e2e8f0">Save All</strong> to persist. Owner Dashboard and YTD cards update on next load</li>
        <li>Add notes in the Notes column to explain variances</li>
        <li>Future months remain editable so you can enter projections</li>
      </ul>
    </div>
  `;
}

window.revUpdateRow = function(idx) {
  const fy = window.AVALON_DATA.fy2026;
  const months = fy.monthlyBudget || [];
  const m = months[idx];
  if (!m) return;
  const input = document.getElementById('rev_actual_' + idx);
  const rawVal = input?.value;
  const actual = rawVal !== '' && rawVal != null ? parseFloat(rawVal) : null;
  const variance = actual != null ? actual - m.budgeted : null;
  const varColor = variance == null ? '#334155' : variance >= 0 ? '#4ade80' : '#f87171';
  const varSign  = variance != null && variance > 0 ? '+' : '';
  function fmtM(n) { return n != null ? n.toLocaleString(undefined, { style:'currency', currency:'USD', maximumFractionDigits:0 }) : '—'; }
  const varEl = document.getElementById('rev_var_' + idx);
  if (varEl) { varEl.textContent = variance != null ? varSign + fmtM(variance) : '—'; varEl.style.color = varColor; }

  // Recompute YTD from all current inputs
  let ytdBudget = 0, ytdActual = 0;
  months.forEach((mb, i) => {
    const inp = document.getElementById('rev_actual_' + i);
    const v = inp?.value !== '' && inp?.value != null ? parseFloat(inp.value) : null;
    if (v != null) { ytdBudget += mb.budgeted; ytdActual += v; }
  });
  const ytdVar = ytdActual - ytdBudget;
  const ytdVarColor = ytdVar >= 0 ? '#4ade80' : '#f87171';
  const setEl = (id, txt, color) => { const el = document.getElementById(id); if (el) { el.textContent = txt; if (color) el.style.color = color; } };
  setEl('rev_ytd_budget', fmtM(ytdBudget));
  setEl('rev_ytd_actual', fmtM(ytdActual), '#22d3ee');
  setEl('rev_ytd_var', (ytdVar >= 0 ? '+' : '') + fmtM(ytdVar), ytdVarColor);
  setEl('rev_tfoot_budget', fmtM(ytdBudget));
  setEl('rev_tfoot_actual', fmtM(ytdActual));
  setEl('rev_tfoot_var', (ytdVar >= 0 ? '+' : '') + fmtM(ytdVar), ytdVarColor);
};

window.revSaveAll = function() {
  const fy = window.AVALON_DATA.fy2026;
  const months = fy.monthlyBudget || [];
  const actuals = loadRevenueActuals();
  months.forEach((m, idx) => {
    const inp = document.getElementById('rev_actual_' + idx);
    if (!inp) return;
    const val = inp.value !== '' && inp.value != null ? parseFloat(inp.value) : undefined;
    if (val !== undefined && !isNaN(val)) actuals[m.month] = val;
    else delete actuals[m.month];
    const noteInp = document.getElementById('rev_note_text_' + idx);
    if (noteInp) {
      if (noteInp.value.trim()) actuals['note_' + m.month] = noteInp.value.trim();
      else delete actuals['note_' + m.month];
    }
  });
  saveRevenueActuals(actuals);
  showToast('✅ Revenue data saved — dashboard will reflect on reload');
};

window.revExportCsv = function() {
  const fy = window.AVALON_DATA.fy2026;
  const saved = loadRevenueActuals();
  const months = (fy.monthlyBudget || []).map(m => {
    const actual = saved[m.month] != null ? saved[m.month] : m.actual;
    const variance = actual != null ? actual - m.budgeted : null;
    return { month: m.month, budgeted: m.budgeted, actual, variance, note: saved['note_'+m.month]||'' };
  });
  const hdr = ['Month','Budgeted','Actual','Variance','Notes'];
  const rows = months.map(m => [m.month, m.budgeted||'', m.actual||'', m.variance||'', m.note].map(v => `"${String(v).replace(/"/g,'""')}"`).join(','));
  const blob = new Blob([[hdr.join(','), ...rows].join('\\n')], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'avalon-revenue-2026.csv'; a.click(); URL.revokeObjectURL(a.href);
};

window.revenueAdmin = revenueAdmin;
"""

if 'function revenueAdmin()' not in app_js:
    # Insert before the show('today') at the very end
    app_js = app_js.replace("show('today');", REVENUE_ADMIN_FN + "\nshow('today');")
    print('✅ app_premium.js — revenueAdmin() added')
else:
    print('⚠️  app_premium.js — revenueAdmin() already present, skipping')

# ── 2b: Wire revenueAdmin into routes ─────────────────────────────────────────
OLD_ROUTES = "const routes = {today, pipeline, lead, process, forms, scripts, templates, objections, calculator, academy, manager, settings, ...intRoute, ...repRoute};"
NEW_ROUTES = "const revenueRoute = (typeof revenueAdmin === 'function') ? {revenueAdmin} : {};\n  const routes = {today, pipeline, lead, process, forms, scripts, templates, objections, calculator, academy, manager, settings, ...intRoute, ...repRoute, ...revenueRoute};"

if 'revenueRoute' not in app_js:
    app_js = app_js.replace(OLD_ROUTES, NEW_ROUTES)
    print('✅ app_premium.js — revenueAdmin wired into routes')
else:
    print('⚠️  app_premium.js — revenueRoute already in routes')

# ── 2c: Add revenueAdmin to NAV_PERMS allowed list for admin ──────────────────
OLD_ADMIN_PERMS = "admin: ['today','myDashboard','pipeline','lead','process','forms','scripts','templates','objections','calculator','academy','manager','integrations','settings'],"
NEW_ADMIN_PERMS = "admin: ['today','myDashboard','pipeline','lead','process','forms','scripts','templates','objections','calculator','academy','manager','integrations','settings','revenueAdmin'],"

OLD_OM_PERMS = "office_manager: ['today','myDashboard','pipeline','lead','process','forms','scripts','templates','objections','calculator','academy','manager','integrations','settings'],"
NEW_OM_PERMS = "office_manager: ['today','myDashboard','pipeline','lead','process','forms','scripts','templates','objections','calculator','academy','manager','integrations','settings','revenueAdmin'],"

if "'revenueAdmin'" not in app_js:
    app_js = app_js.replace(OLD_ADMIN_PERMS, NEW_ADMIN_PERMS)
    app_js = app_js.replace(OLD_OM_PERMS, NEW_OM_PERMS)
    print('✅ app_premium.js — revenueAdmin added to nav perms')
else:
    print('⚠️  app_premium.js — revenueAdmin already in nav perms')

# ── 2d: Add "Revenue Editor" button to manager() view ─────────────────────────
OLD_MANAGER_BTN = '<h2 class="mt" style="font-size:1rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)">Division P&amp;L \u2014 Actual vs Target</h2>'
NEW_MANAGER_BTN = """<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:4px">
      <h2 class="mt" style="font-size:1rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:0">Division P&amp;L \u2014 Actual vs Target</h2>
      <button class="primary-btn small" onclick="show('revenueAdmin')" style="font-size:12px;padding:6px 14px;background:linear-gradient(135deg,#1d4ed8,#1e40af)">✏️ Edit Monthly Revenue</button>
    </div>"""

if 'revenueAdmin' not in app_js or 'Edit Monthly Revenue' not in app_js:
    if OLD_MANAGER_BTN in app_js:
        app_js = app_js.replace(OLD_MANAGER_BTN, NEW_MANAGER_BTN)
        print('✅ app_premium.js — Edit Monthly Revenue button added to manager()')
    else:
        print('⚠️  Could not find manager() division P&L heading to insert button')
else:
    print('⚠️  app_premium.js — Edit Monthly Revenue button already present')

with open(APP_PREMIUM_PATH, 'w') as f:
    f.write(app_js)

print('✅ app_premium.js saved')

# ──────────────────────────────────────────────────────────────────────────────
# SECTION 3: integrations.js — Calendar Month/Week/Agenda toggle
# Replace intLoadCalendar with one that has a view toggle
# ──────────────────────────────────────────────────────────────────────────────
INT_PATH = '/home/user/webapp/public/static/integrations.js'

with open(INT_PATH, 'r') as f:
    int_js = f.read()

OLD_INTLOADCALENDAR = '''async function intLoadCalendar() {
  const el = document.getElementById('int-cal-list');
  if (!el) return;
  el.innerHTML = '<div class="spinner-wrap"><div class="spinner"></div></div>';
  try {
    const result = await calListUpcoming(8);
    const events = result.items || [];
    if (!events.length) { el.innerHTML = '<p style="color:var(--muted);font-size:13px">No upcoming events.</p>'; return; }
    // Group by day for agenda view
    const byDay = {};
    events.forEach(ev => {
      const start = ev.start?.dateTime || ev.start?.date || '';
      const dayKey = start ? new Date(start).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : 'Unknown';
      if (!byDay[dayKey]) byDay[dayKey] = [];
      byDay[dayKey].push(ev);
    });
    el.innerHTML = Object.entries(byDay).map(([day, dayEvents]) => `
      <div style="margin-bottom:14px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#64748b;margin-bottom:6px;padding:0 2px">${day}</div>
        ${dayEvents.map(ev => {
          const t = ev.start?.dateTime ? new Date(ev.start.dateTime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : 'All day';
          const end = ev.end?.dateTime ? new Date(ev.end.dateTime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
          return `<div class="int-list-row">
            <div style="min-width:0;flex:1">
              <div class="int-list-row-title">📅 ${escapeHtml(ev.summary || '(no title)')}</div>
              <div class="int-list-row-meta">${t}${end ? ' – ' + end : ''}${ev.location ? ' · 📍 ' + escapeHtml(ev.location) : ''}</div>
            </div>
            ${ev.htmlLink ? `<a href="${escapeHtml(ev.htmlLink)}" target="_blank" rel="noopener" class="int-list-row-link">Open →</a>` : ''}
          </div>`;
        }).join('')}
      </div>
    `).join('');
  } catch(e) {
    el.innerHTML = `<p style="color:#f87171;font-size:13px">Error: ${escapeHtml(e.message)}</p>`;
  }
}'''

NEW_INTLOADCALENDAR = r'''// Calendar view state ('agenda' | 'week' | 'month')
let _calView = 'agenda';
let _calEvents = [];
let _calWeekOffset = 0; // weeks from today
let _calMonthOffset = 0; // months from today

async function intLoadCalendar() {
  const el = document.getElementById('int-cal-list');
  if (!el) return;
  el.innerHTML = '<div class="spinner-wrap"><div class="spinner"></div></div>';
  try {
    // Fetch up to 50 events so we have enough for week/month grids
    const result = await calListUpcoming(50);
    _calEvents = result.items || [];
    intRenderCalView(el);
  } catch(e) {
    el.innerHTML = `<p style="color:#f87171;font-size:13px">Error: ${escapeHtml(e.message)}</p>`;
  }
}

function intRenderCalView(el) {
  if (!el) el = document.getElementById('int-cal-list');
  if (!el) return;

  // Build the view toggle header
  const navHtml = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
    <div class="cal-view-toggle">
      <button class="cal-view-btn ${_calView==='month'?'active':''}" onclick="intSetCalView('month')">Month</button>
      <button class="cal-view-btn ${_calView==='week'?'active':''}" onclick="intSetCalView('week')">Week</button>
      <button class="cal-view-btn ${_calView==='agenda'?'active':''}" onclick="intSetCalView('agenda')">Agenda</button>
    </div>
    <div style="display:flex;gap:6px;align-items:center">
      <button onclick="intCalPrev()" style="background:transparent;border:1px solid #334155;color:#94a3b8;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:13px">‹</button>
      <span id="cal-view-label" style="font-size:12px;font-weight:700;color:#94a3b8;min-width:100px;text-align:center"></span>
      <button onclick="intCalNext()" style="background:transparent;border:1px solid #334155;color:#94a3b8;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:13px">›</button>
      <button onclick="intCalToday()" style="background:transparent;border:1px solid #334155;color:#60a5fa;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:11px;font-weight:700">Today</button>
    </div>
  </div>`;

  let bodyHtml = '';
  if (_calView === 'agenda') bodyHtml = intRenderAgenda();
  else if (_calView === 'week') bodyHtml = intRenderWeek();
  else bodyHtml = intRenderMonth();

  el.innerHTML = navHtml + bodyHtml;
  // Update the label
  const labelEl = document.getElementById('cal-view-label');
  if (labelEl) {
    const today = new Date();
    if (_calView === 'agenda') labelEl.textContent = 'Upcoming';
    else if (_calView === 'week') {
      const weekStart = new Date(today);
      weekStart.setDate(today.getDate() - today.getDay() + _calWeekOffset * 7);
      labelEl.textContent = weekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } else {
      const d = new Date(today.getFullYear(), today.getMonth() + _calMonthOffset, 1);
      labelEl.textContent = d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    }
  }
}

function intRenderAgenda() {
  const events = _calEvents;
  if (!events.length) return '<p style="color:var(--muted);font-size:13px">No upcoming events.</p>';
  const byDay = {};
  events.forEach(ev => {
    const start = ev.start?.dateTime || ev.start?.date || '';
    const dayKey = start ? new Date(start).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : 'Unknown';
    if (!byDay[dayKey]) byDay[dayKey] = [];
    byDay[dayKey].push(ev);
  });
  return Object.entries(byDay).map(([day, dayEvents]) => `
    <div style="margin-bottom:14px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#64748b;margin-bottom:6px;padding:0 2px">${day}</div>
      ${dayEvents.map(ev => {
        const t = ev.start?.dateTime ? new Date(ev.start.dateTime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : 'All day';
        const end = ev.end?.dateTime ? new Date(ev.end.dateTime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
        return `<div class="int-list-row">
          <div style="min-width:0;flex:1">
            <div class="int-list-row-title">📅 ${escapeHtml(ev.summary || '(no title)')}</div>
            <div class="int-list-row-meta">${t}${end ? ' – ' + end : ''}${ev.location ? ' · 📍 ' + escapeHtml(ev.location) : ''}</div>
          </div>
          ${ev.htmlLink ? `<a href="${escapeHtml(ev.htmlLink)}" target="_blank" rel="noopener" class="int-list-row-link">Open →</a>` : ''}
        </div>`;
      }).join('')}
    </div>
  `).join('');
}

function intRenderWeek() {
  const today = new Date();
  const todayNum = today.getDate();
  const todayMonth = today.getMonth();
  const todayYear = today.getFullYear();
  // Week starts Sunday
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay() + _calWeekOffset * 7);
  weekStart.setHours(0,0,0,0);

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    days.push(d);
  }
  const dowLabels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const hours = [];
  for (let h = 7; h <= 19; h++) hours.push(h); // 7am – 7pm

  // Header row
  let html = `<div class="cal-week-grid">
    <div class="cal-week-header" style="background:#0a0f1a"></div>
    ${days.map(d => {
      const isToday = d.getDate()===todayNum && d.getMonth()===todayMonth && d.getFullYear()===todayYear;
      const domHtml = isToday
        ? `<div class="dom today-num">${d.getDate()}</div>`
        : `<div class="dom">${d.getDate()}</div>`;
      return `<div class="cal-week-header"><div class="dow">${dowLabels[d.getDay()]}</div>${domHtml}</div>`;
    }).join('')}`;

  // Time rows
  hours.forEach(h => {
    const label = h === 12 ? '12 PM' : h > 12 ? `${h-12} PM` : `${h} AM`;
    html += `<div class="cal-week-time-label">${label}</div>`;
    days.forEach(d => {
      // Find events in this hour
      const cellEvents = _calEvents.filter(ev => {
        if (!ev.start?.dateTime) return false;
        const eStart = new Date(ev.start.dateTime);
        return eStart.getFullYear()===d.getFullYear() &&
               eStart.getMonth()===d.getMonth() &&
               eStart.getDate()===d.getDate() &&
               eStart.getHours()===h;
      });
      const evHtml = cellEvents.map(ev => {
        const t = new Date(ev.start.dateTime).toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
        return `<a href="${escapeHtml(ev.htmlLink||'#')}" target="_blank" rel="noopener" class="cal-week-event" title="${escapeHtml(ev.summary||'')}">${t} ${escapeHtml((ev.summary||'(no title)').slice(0,20))}</a>`;
      }).join('');
      html += `<div class="cal-week-cell">${evHtml}</div>`;
    });
  });
  html += '</div>';
  return html;
}

function intRenderMonth() {
  const today = new Date();
  const viewDate = new Date(today.getFullYear(), today.getMonth() + _calMonthOffset, 1);
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstDay = new Date(year, month, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const dowLabels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  let html = `<div class="cal-month-grid">
    ${dowLabels.map(d => `<div class="cal-month-day-header">${d}</div>`).join('')}`;

  // Pad empty cells before day 1
  for (let i = 0; i < firstDay; i++) {
    html += `<div class="cal-month-cell other-month"></div>`;
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const isToday = day === today.getDate() && month === today.getMonth() && year === today.getFullYear();
    const dayEvents = _calEvents.filter(ev => {
      const s = ev.start?.dateTime || ev.start?.date;
      if (!s) return false;
      const d = new Date(s);
      return d.getFullYear()===year && d.getMonth()===month && d.getDate()===day;
    });
    const evChips = dayEvents.slice(0,3).map(ev =>
      `<div class="cal-event-chip" title="${escapeHtml(ev.summary||'')}" onclick="window.open('${escapeHtml(ev.htmlLink||'')}','_blank')">${escapeHtml((ev.summary||'Event').slice(0,16))}</div>`
    ).join('');
    const moreCount = dayEvents.length - 3;
    html += `<div class="cal-month-cell${isToday?' today':''}">
      <div class="cal-month-cell-num">${day}</div>
      ${evChips}
      ${moreCount > 0 ? `<div style="font-size:10px;color:#64748b;margin-top:1px">+${moreCount} more</div>` : ''}
    </div>`;
  }

  // Pad to complete final week row
  const totalCells = firstDay + daysInMonth;
  const remaining = (7 - (totalCells % 7)) % 7;
  for (let i = 0; i < remaining; i++) {
    html += `<div class="cal-month-cell other-month"></div>`;
  }
  html += '</div>';
  return html;
}

window.intSetCalView = function(v) { _calView = v; intRenderCalView(); };
window.intCalPrev = function() {
  if (_calView === 'week') _calWeekOffset--;
  else if (_calView === 'month') _calMonthOffset--;
  intRenderCalView();
};
window.intCalNext = function() {
  if (_calView === 'week') _calWeekOffset++;
  else if (_calView === 'month') _calMonthOffset++;
  intRenderCalView();
};
window.intCalToday = function() {
  _calWeekOffset = 0; _calMonthOffset = 0;
  intRenderCalView();
};'''

if '_calView' not in int_js:
    if OLD_INTLOADCALENDAR in int_js:
        int_js = int_js.replace(OLD_INTLOADCALENDAR, NEW_INTLOADCALENDAR)
        print('✅ integrations.js — Calendar view toggle added (Month/Week/Agenda)')
    else:
        print('⚠️  integrations.js — Could not find old intLoadCalendar to replace')
else:
    print('⚠️  integrations.js — Calendar toggle already present')

# ── Fix intSearchDrive to use int-list-row class ──────────────────────────────
OLD_DRIVE_SEARCH_ROW = '''      return `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#0f172a;border-radius:8px;margin-bottom:6px;gap:12px">
          <div style="display:flex;align-items:center;gap:8px;min-width:0">
            <span style="font-size:18px">${icon}</span>
            <div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(f.name)}</div>
          </div>
          ${f.webViewLink ? `<a href="${escapeHtml(f.webViewLink)}" target="_blank" rel="noopener" style="font-size:11px;color:var(--accent);white-space:nowrap;text-decoration:none">Open →</a>` : ''}
        </div>
      `;'''

NEW_DRIVE_SEARCH_ROW = '''      return `
        <div class="int-list-row">
          <div style="display:flex;align-items:center;gap:10px;min-width:0;flex:1">
            <span style="font-size:20px;flex-shrink:0">${icon}</span>
            <div style="min-width:0">
              <div class="int-list-row-title">${escapeHtml(f.name)}</div>
              <div class="int-list-row-meta">File</div>
            </div>
          </div>
          ${f.webViewLink ? `<a href="${escapeHtml(f.webViewLink)}" target="_blank" rel="noopener" class="int-list-row-link">Open →</a>` : ''}
        </div>
      `;'''

if OLD_DRIVE_SEARCH_ROW in int_js:
    int_js = int_js.replace(OLD_DRIVE_SEARCH_ROW, NEW_DRIVE_SEARCH_ROW)
    print('✅ integrations.js — Drive search results use int-list-row class')
else:
    print('⚠️  integrations.js — Could not find old drive search row to upgrade')

with open(INT_PATH, 'w') as f:
    f.write(int_js)

print('✅ integrations.js saved')

# ──────────────────────────────────────────────────────────────────────────────
# SECTION 4: index.tsx — Add "Revenue Editor" nav link in Admin group
# ──────────────────────────────────────────────────────────────────────────────
INDEX_TSX_PATH = '/home/user/webapp/src/index.tsx'

with open(INDEX_TSX_PATH, 'r') as f:
    index_tsx = f.read()

# Add revenueAdmin nav item inside the Admin nav-group, after the Manager Tools button
OLD_MANAGER_NAV = '''<button class="nav-item" data-view="manager" onclick="show('manager')">Manager Tools</button>
                <button class="nav-item" data-view="integrations" onclick="show('integrations')">Integrations</button>'''

NEW_MANAGER_NAV = '''<button class="nav-item" data-view="manager" onclick="show('manager')">Manager Tools</button>
                <button class="nav-item" data-view="revenueAdmin" onclick="show('revenueAdmin')">Revenue Editor</button>
                <button class="nav-item" data-view="integrations" onclick="show('integrations')">Integrations</button>'''

if 'Revenue Editor' not in index_tsx:
    if OLD_MANAGER_NAV in index_tsx:
        index_tsx = index_tsx.replace(OLD_MANAGER_NAV, NEW_MANAGER_NAV)
        print('✅ index.tsx — Revenue Editor nav item added')
    else:
        print('⚠️  index.tsx — Could not find Manager Tools nav to insert Revenue Editor')
else:
    print('⚠️  index.tsx — Revenue Editor nav already present')

with open(INDEX_TSX_PATH, 'w') as f:
    f.write(index_tsx)

print('\n🎉 All patches applied. Run: npm run build && pm2 restart all')
