/**
 * Groundwork CRM — Time Tracker Module
 *
 * Features:
 *  - Live clock-in / clock-out with running timer in sidebar
 *  - My Timesheet: personal weekly view, daily breakdown, edit entries
 *  - Payroll Hub (admin): team summary, approve/reject entries, export CSV
 *  - Job type tagging, notes per entry
 *  - Week-over-week navigation
 */

// ── State ──────────────────────────────────────────────────────────────────────
window._ttState = window._ttState || {
  activeEntry: null,     // currently open clock-in entry
  timerInterval: null,   // setInterval for live clock display
};

const TT_JOB_TYPES = [
  'General Work',
  'Sales Visit',
  'Site Estimate',
  'Admin / Office',
  'Training',
  'Drive Time',
  'Meeting',
  'Other'
];

// ── Helpers ────────────────────────────────────────────────────────────────────
function ttFmt(min) {
  if (min == null || isNaN(min)) return '—';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h ${m.toString().padStart(2,'0')}m`;
}
function ttFmtDecimal(min) {
  if (!min) return '0.00';
  return (min / 60).toFixed(2);
}
function ttFmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', hour12:true });
}
function ttFmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
}
function ttFmtDateShort(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month:'short', day:'numeric' });
}
function ttElapsed(clockInIso) {
  const diff = Math.floor((Date.now() - new Date(clockInIso).getTime()) / 1000);
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  return `${h}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
}
function ttWeekRange(offset = 0) {
  const now = new Date();
  const day = now.getDay(); // 0=Sun
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1) + offset * 7);
  monday.setHours(0,0,0,0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23,59,59,999);
  return {
    from: monday.toISOString().slice(0,10),
    to:   sunday.toISOString().slice(0,10),
    label: `${ttFmtDateShort(monday.toISOString())} – ${ttFmtDateShort(sunday.toISOString())}`
  };
}
function ttApprovalBadge(approved) {
  if (approved === 1) return `<span style="font-size:10px;font-weight:700;color:#2D7A55;background:#2D7A5518;border:1px solid #2D7A5540;border-radius:20px;padding:2px 8px">✓ Approved</span>`;
  if (approved === 2) return `<span style="font-size:10px;font-weight:700;color:#C97B6A;background:#C97B6A18;border:1px solid #C97B6A40;border-radius:20px;padding:2px 8px">✗ Rejected</span>`;
  return `<span style="font-size:10px;font-weight:700;color:#8B6914;background:#8B691418;border:1px solid rgba(139,105,20,.3);border-radius:20px;padding:2px 8px">⏳ Pending</span>`;
}
function ttE(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function ttToast(msg) {
  if (typeof window.showToast === 'function') window.showToast(msg);
}

// ── Sidebar Clock Widget ───────────────────────────────────────────────────────
// Renders a persistent mini clock widget at bottom of sidebar
function ttRenderSidebarWidget() {
  let widget = document.getElementById('tt-sidebar-widget');
  if (!widget) return; // element must exist in HTML

  const state = window._ttState;
  if (state.activeEntry) {
    widget.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;background:#2D7A5518;border:1px solid #2D7A5540;border-radius:10px;cursor:pointer" onclick="show('timeTracker')">
        <div style="width:8px;height:8px;border-radius:50%;background:#2D7A55;flex-shrink:0;animation:tt-pulse 1.5s infinite"></div>
        <div style="flex:1;min-width:0">
          <div style="font-size:11px;font-weight:700;color:#2D7A55;letter-spacing:.02em">CLOCKED IN</div>
          <div id="tt-sidebar-timer" style="font-size:13px;font-weight:800;color:#E8E4D9;font-variant-numeric:tabular-nums;letter-spacing:.02em">
            ${ttElapsed(state.activeEntry.clock_in)}
          </div>
        </div>
        <button onclick="event.stopPropagation();ttQuickClockOut()" 
          style="background:#C97B6A;color:#fff;border:none;border-radius:6px;padding:4px 8px;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0">
          Clock Out
        </button>
      </div>`;
  } else {
    widget.innerHTML = `
      <button onclick="ttQuickClockIn()" style="width:100%;display:flex;align-items:center;justify-content:center;gap:7px;padding:9px 14px;background:var(--gw-surface-2);border:1.5px dashed var(--gw-line);border-radius:10px;color:var(--gw-muted);font-size:12px;font-weight:600;cursor:pointer;transition:all .15s"
        onmouseover="this.style.borderColor='#4D8A86';this.style.color='#4D8A86'"
        onmouseout="this.style.borderColor='var(--gw-line)';this.style.color='var(--gw-muted)'">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        Clock In
      </button>`;
  }
}

function ttStartSidebarTimer() {
  if (window._ttState.timerInterval) clearInterval(window._ttState.timerInterval);
  window._ttState.timerInterval = setInterval(() => {
    const el = document.getElementById('tt-sidebar-timer');
    if (el && window._ttState.activeEntry) {
      el.textContent = ttElapsed(window._ttState.activeEntry.clock_in);
    }
  }, 1000);
}

async function ttLoadActiveEntry() {
  try {
    const res = await fetch('/api/time/active', { credentials:'include' });
    const j   = await res.json();
    window._ttState.activeEntry = (j.ok && j.data) ? j.data : null;
  } catch { window._ttState.activeEntry = null; }
  ttRenderSidebarWidget();
  if (window._ttState.activeEntry) ttStartSidebarTimer();
}

async function ttQuickClockIn() {
  try {
    const res = await fetch('/api/time/clock-in', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ jobType:'General Work' })
    });
    const j = await res.json();
    if (j.ok) {
      window._ttState.activeEntry = { id: j.data.id, clock_in: j.data.clock_in };
      ttRenderSidebarWidget();
      ttStartSidebarTimer();
      ttToast('Clocked in! ✓');
      // Refresh view if on time tracker
      if (typeof window._ttRefresh === 'function') window._ttRefresh();
    } else {
      ttToast(j.error || 'Clock-in failed');
    }
  } catch { ttToast('Network error'); }
}

async function ttQuickClockOut() {
  try {
    const res = await fetch('/api/time/clock-out', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({})
    });
    const j = await res.json();
    if (j.ok) {
      const dur = j.data.duration_min;
      window._ttState.activeEntry = null;
      clearInterval(window._ttState.timerInterval);
      ttRenderSidebarWidget();
      ttToast(`Clocked out — ${ttFmt(dur)} logged ✓`);
      if (typeof window._ttRefresh === 'function') window._ttRefresh();
    } else {
      ttToast(j.error || 'Clock-out failed');
    }
  } catch { ttToast('Network error'); }
}

// ── Main View Entry Point ──────────────────────────────────────────────────────
function timeTracker(tab) {
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  const d1Rep = window._d1SessionRep || {};
  const isAdmin = rep && (rep.role === 'admin' || rep.role === 'office_manager');
  const viewEl  = document.getElementById('view');
  if (!viewEl) return;

  const activeTab = tab || 'myTime';
  const tabs = [
    { id:'myTime',  label:'My Timesheet' },
    ...(isAdmin ? [{ id:'payroll', label:'Payroll Hub' }] : [])
  ];

  viewEl.innerHTML = `
<style>
@keyframes tt-pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
.tt-card { background:var(--gw-surface-2);border:1px solid var(--gw-line);border-radius:14px;padding:20px; }
.tt-entry-row { display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--gw-line);transition:background .12s; }
.tt-entry-row:last-child { border-bottom:none; }
.tt-entry-row:hover { background:var(--gw-surface-3); }
.tt-day-header { padding:10px 16px 6px;font-size:11px;font-weight:800;color:var(--gw-muted);text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid var(--gw-line);background:var(--gw-surface); }
.tt-stat-card { background:var(--gw-surface-2);border:1px solid var(--gw-line);border-radius:12px;padding:16px 18px;flex:1;min-width:130px; }
.tt-tab-btn { padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;border:1.5px solid var(--gw-line);background:var(--gw-surface-2);color:var(--gw-muted); }
.tt-tab-btn.active { background:#4D8A86;color:#fff;border-color:#4D8A86; }
.tt-rep-row { display:flex;align-items:center;gap:14px;padding:14px 18px;border-bottom:1px solid var(--gw-line); }
.tt-rep-row:last-child { border-bottom:none; }
.tt-check { width:16px;height:16px;accent-color:#4D8A86;cursor:pointer; }
</style>

<div class="eyebrow">Team</div>
<div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:20px">
  <div>
    <h1 style="margin:0 0 4px">Time Tracker</h1>
    <p class="lede" style="margin:0">Log hours, track your week, and manage payroll.</p>
  </div>
  <!-- Live clock-in button (big, top-right) -->
  <div id="tt-main-clock-btn"></div>
</div>

<!-- Tab nav -->
<div style="display:flex;gap:8px;margin-bottom:24px;flex-wrap:wrap">
  ${tabs.map(t=>`<button class="tt-tab-btn ${activeTab===t.id?'active':''}" onclick="timeTracker('${t.id}')">${t.label}</button>`).join('')}
</div>

<div id="tt-tab-body"></div>
`;

  // Set up refresh function
  window._ttRefresh = () => timeTracker(activeTab);

  // Render clock button top right
  ttRenderMainClockBtn();

  if (activeTab === 'myTime')  ttRenderMyTime();
  else if (activeTab === 'payroll') ttRenderPayroll();
}

function ttRenderMainClockBtn() {
  const el = document.getElementById('tt-main-clock-btn');
  if (!el) return;
  const active = window._ttState.activeEntry;
  if (active) {
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;background:#2D7A5518;border:1.5px solid #2D7A5540;border-radius:12px;padding:10px 16px">
        <div style="width:9px;height:9px;border-radius:50%;background:#2D7A55;flex-shrink:0;animation:tt-pulse 1.5s infinite"></div>
        <div>
          <div style="font-size:11px;font-weight:700;color:#2D7A55;letter-spacing:.05em">CLOCKED IN</div>
          <div id="tt-main-timer" style="font-size:18px;font-weight:900;color:#E8E4D9;font-variant-numeric:tabular-nums">
            ${ttElapsed(active.clock_in)}
          </div>
        </div>
        <button onclick="ttClockOutWithNote()" class="danger-btn" style="padding:8px 16px;font-size:13px">Clock Out</button>
      </div>`;
    // Keep main timer updated
    if (window._ttMainTimer) clearInterval(window._ttMainTimer);
    window._ttMainTimer = setInterval(() => {
      const t = document.getElementById('tt-main-timer');
      if (t && window._ttState.activeEntry) t.textContent = ttElapsed(window._ttState.activeEntry.clock_in);
    }, 1000);
  } else {
    el.innerHTML = `
      <button onclick="ttClockInWithType()" class="primary-btn" style="display:flex;align-items:center;gap:8px;padding:10px 20px;font-size:14px">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        Clock In
      </button>`;
  }
}

// ── My Timesheet Tab ───────────────────────────────────────────────────────────
let _ttMyWeekOffset = 0;

async function ttRenderMyTime() {
  const body = document.getElementById('tt-tab-body');
  if (!body) return;
  body.innerHTML = `<div style="text-align:center;padding:40px;color:var(--gw-muted)">Loading…</div>`;

  const week = ttWeekRange(_ttMyWeekOffset);
  let entries = [];
  try {
    const res = await fetch(`/api/time/entries?from=${week.from}&to=${week.to}`, { credentials:'include' });
    const j = await res.json();
    entries = j.ok ? (j.data || []) : [];
  } catch { entries = []; }

  // Stats
  const closed   = entries.filter(e => e.clock_out);
  const totalMin = closed.reduce((s,e) => s + (e.duration_min||0), 0);
  const approvedMin = closed.filter(e=>e.approved===1).reduce((s,e)=>s+(e.duration_min||0),0);
  const pendingMin  = closed.filter(e=>e.approved===0).reduce((s,e)=>s+(e.duration_min||0),0);
  const activeEntry = entries.find(e => !e.clock_out);

  // Group by date
  const byDate = {};
  entries.forEach(e => {
    const d = e.clock_in.slice(0,10);
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(e);
  });
  const sortedDates = Object.keys(byDate).sort((a,b)=>b.localeCompare(a));

  // Day bar chart (7 days)
  const days = [];
  for (let i=0;i<7;i++) {
    const d = new Date(week.from);
    d.setDate(d.getDate()+i);
    const key = d.toISOString().slice(0,10);
    const dayMin = (byDate[key]||[]).reduce((s,e)=>s+(e.duration_min||0),0);
    days.push({ key, label: d.toLocaleDateString('en-US',{weekday:'short'}), date: d.getDate(), min: dayMin, isToday: key===new Date().toISOString().slice(0,10) });
  }
  const maxMin = Math.max(...days.map(d=>d.min), 480); // max 8h for bar scale

  body.innerHTML = `
<!-- Week Navigator -->
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:10px">
  <div style="display:flex;align-items:center;gap:10px">
    <button onclick="_ttMyWeekOffset--;ttRenderMyTime()" style="background:var(--gw-surface-2);border:1px solid var(--gw-line);border-radius:8px;padding:6px 12px;color:var(--gw-ink);cursor:pointer;font-size:13px">← Prev</button>
    <span style="font-size:14px;font-weight:700;color:var(--gw-ink)">${week.label}</span>
    <button onclick="_ttMyWeekOffset++;ttRenderMyTime()" ${_ttMyWeekOffset>=0?'disabled style="opacity:.4;cursor:not-allowed;background:var(--gw-surface-2);border:1px solid var(--gw-line);border-radius:8px;padding:6px 12px;color:var(--gw-muted);font-size:13px"':'style="background:var(--gw-surface-2);border:1px solid var(--gw-line);border-radius:8px;padding:6px 12px;color:var(--gw-ink);cursor:pointer;font-size:13px"'}>Next →</button>
  </div>
  <button onclick="ttOpenAddEntry()" style="background:var(--gw-surface-2);border:1px solid var(--gw-line);border-radius:8px;padding:6px 14px;color:var(--gw-muted);font-size:12px;font-weight:600;cursor:pointer">+ Add Manual Entry</button>
</div>

<!-- Stats row -->
<div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap">
  <div class="tt-stat-card">
    <div style="font-size:11px;font-weight:700;color:var(--gw-muted);text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px">Total Hours</div>
    <div style="font-size:26px;font-weight:900;color:var(--gw-ink);font-variant-numeric:tabular-nums">${ttFmtDecimal(totalMin)}</div>
    <div style="font-size:11px;color:var(--gw-muted);margin-top:2px">${ttFmt(totalMin)}</div>
  </div>
  <div class="tt-stat-card">
    <div style="font-size:11px;font-weight:700;color:var(--gw-muted);text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px">Approved</div>
    <div style="font-size:26px;font-weight:900;color:#2D7A55;font-variant-numeric:tabular-nums">${ttFmtDecimal(approvedMin)}</div>
    <div style="font-size:11px;color:var(--gw-muted);margin-top:2px">${ttFmt(approvedMin)}</div>
  </div>
  <div class="tt-stat-card">
    <div style="font-size:11px;font-weight:700;color:var(--gw-muted);text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px">Pending Review</div>
    <div style="font-size:26px;font-weight:900;color:#8B6914;font-variant-numeric:tabular-nums">${ttFmtDecimal(pendingMin)}</div>
    <div style="font-size:11px;color:var(--gw-muted);margin-top:2px">${ttFmt(pendingMin)}</div>
  </div>
  <div class="tt-stat-card" style="flex:2;min-width:200px">
    <div style="font-size:11px;font-weight:700;color:var(--gw-muted);text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px">This Week</div>
    <!-- Day bars -->
    <div style="display:flex;align-items:flex-end;gap:6px;height:44px">
      ${days.map(d=>{
        const pct = maxMin>0 ? Math.max(3,Math.round((d.min/maxMin)*100)) : 3;
        return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px">
          <div title="${ttFmt(d.min)}" style="width:100%;height:${pct}%;min-height:3px;background:${d.isToday?'#4D8A86':d.min>0?'#4D8A8660':'var(--gw-line)'};border-radius:4px 4px 0 0;transition:height .3s"></div>
          <div style="font-size:9px;font-weight:${d.isToday?'800':'600'};color:${d.isToday?'#4D8A86':'var(--gw-muted)'}">${d.label}</div>
        </div>`;
      }).join('')}
    </div>
  </div>
</div>

${activeEntry ? `
<!-- Active entry alert -->
<div style="display:flex;align-items:center;gap:12px;padding:14px 18px;background:#2D7A5510;border:1.5px solid #2D7A5540;border-radius:12px;margin-bottom:16px">
  <div style="width:10px;height:10px;border-radius:50%;background:#2D7A55;flex-shrink:0;animation:tt-pulse 1.5s infinite"></div>
  <div style="flex:1">
    <div style="font-size:13px;font-weight:700;color:#2D7A55">Currently Clocked In</div>
    <div style="font-size:12px;color:var(--gw-muted)">Since ${ttFmtTime(activeEntry.clock_in)} · ${ttE(activeEntry.job_type||'General Work')}</div>
  </div>
  <button onclick="ttClockOutWithNote()" class="danger-btn" style="font-size:12px;padding:6px 14px">Clock Out</button>
</div>` : ''}

<!-- Entries list -->
<div class="tt-card" style="padding:0;overflow:hidden">
  ${sortedDates.length === 0
    ? `<div style="text-align:center;padding:48px 24px;color:var(--gw-muted)">
         <div style="font-size:32px;margin-bottom:12px">⏱</div>
         <div style="font-size:15px;font-weight:600;margin-bottom:6px">No entries this week</div>
         <div style="font-size:13px">Clock in to start tracking, or add a manual entry.</div>
       </div>`
    : sortedDates.map(date => {
        const dayEntries = byDate[date];
        const dayMin = dayEntries.filter(e=>e.clock_out).reduce((s,e)=>s+(e.duration_min||0),0);
        const dayLabel = ttFmtDate(date+'T12:00:00');
        return `
          <div class="tt-day-header" style="display:flex;justify-content:space-between;align-items:center">
            <span>${dayLabel}</span>
            <span style="font-weight:700;color:var(--gw-ink)">${ttFmt(dayMin)}</span>
          </div>
          ${dayEntries.map(e => ttEntryRow(e, false)).join('')}`;
      }).join('')
  }
</div>`;
}

function ttEntryRow(e, showRep=false) {
  const isOpen = !e.clock_out;
  return `
<div class="tt-entry-row" id="tt-entry-${e.id}">
  <div style="width:3px;height:36px;border-radius:3px;flex-shrink:0;background:${isOpen?'#2D7A55':e.approved===1?'#4D8A86':e.approved===2?'#C97B6A':'#8B6914'}"></div>
  ${showRep ? `<div style="flex-shrink:0">
    <div style="width:30px;height:30px;border-radius:8px;background:${e.rep_color||'#4D8A86'}22;border:2px solid ${e.rep_color||'#4D8A86'}66;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;color:${e.rep_color||'#4D8A86'}">${(e.rep_name||'?')[0]}</div>
  </div>` : ''}
  <div style="flex:1;min-width:0">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      ${showRep ? `<span style="font-size:13px;font-weight:700;color:var(--gw-ink)">${ttE(e.rep_name||'')}</span><span style="color:var(--gw-line)">·</span>` : ''}
      <span style="font-size:13px;font-weight:600;color:var(--gw-ink)">${ttE(e.job_type||'General Work')}</span>
      ${isOpen ? `<span style="font-size:10px;font-weight:700;color:#2D7A55;background:#2D7A5518;border:1px solid #2D7A5540;border-radius:20px;padding:1px 7px;animation:tt-pulse 2s infinite">● Live</span>` : ttApprovalBadge(e.approved)}
    </div>
    <div style="font-size:11px;color:var(--gw-muted);margin-top:2px">
      ${ttFmtTime(e.clock_in)} → ${isOpen?'<span style="color:#2D7A55;font-weight:600">In progress</span>':ttFmtTime(e.clock_out)}
      ${e.notes ? `<span style="color:var(--gw-line)"> · </span><span style="font-style:italic">${ttE(e.notes)}</span>` : ''}
    </div>
  </div>
  <div style="font-size:15px;font-weight:800;color:var(--gw-ink);font-variant-numeric:tabular-nums;flex-shrink:0;min-width:60px;text-align:right">
    ${isOpen ? '<span id="tt-live-dur-'+e.id+'" style="color:#2D7A55">'+ttElapsed(e.clock_in)+'</span>' : ttFmt(e.duration_min)}
  </div>
  ${!showRep ? `
  <div style="display:flex;gap:6px;flex-shrink:0">
    <button onclick="ttEditEntry('${e.id}')" title="Edit" style="background:none;border:none;color:var(--gw-muted);cursor:pointer;padding:4px;border-radius:6px;transition:color .12s" onmouseover="this.style.color='var(--gw-ink)'" onmouseout="this.style.color='var(--gw-muted)'">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
    </button>
    ${e.approved!==1?`<button onclick="ttDeleteEntry('${e.id}')" title="Delete" style="background:none;border:none;color:var(--gw-muted);cursor:pointer;padding:4px;border-radius:6px;transition:color .12s" onmouseover="this.style.color='#C97B6A'" onmouseout="this.style.color='var(--gw-muted)'">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
    </button>`:''}
  </div>` : `
  <div style="display:flex;gap:6px;flex-shrink:0">
    ${e.approved===0&&e.clock_out?`
      <button onclick="ttAdminApprove('${e.id}',1)" style="background:#2D7A5518;border:1px solid #2D7A5540;color:#2D7A55;border-radius:6px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer" title="Approve">✓</button>
      <button onclick="ttAdminApprove('${e.id}',2)" style="background:#C97B6A18;border:1px solid #C97B6A40;color:#C97B6A;border-radius:6px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer" title="Reject">✗</button>`
    : e.approved===1 ? `<button onclick="ttAdminApprove('${e.id}',0)" style="background:var(--gw-surface-2);border:1px solid var(--gw-line);color:var(--gw-muted);border-radius:6px;padding:4px 8px;font-size:10px;cursor:pointer" title="Undo">Undo</button>` : ''}
    <button onclick="ttEditEntry('${e.id}')" title="Edit" style="background:none;border:none;color:var(--gw-muted);cursor:pointer;padding:4px;border-radius:6px" onmouseover="this.style.color='var(--gw-ink)'" onmouseout="this.style.color='var(--gw-muted)'">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
    </button>
  </div>`}
</div>`;
}

// ── Payroll Hub Tab (Admin) ────────────────────────────────────────────────────
let _ttPayrollWeekOffset = 0;
let _ttPayrollSelected = new Set();

async function ttRenderPayroll() {
  const body = document.getElementById('tt-tab-body');
  if (!body) return;
  body.innerHTML = `<div style="text-align:center;padding:40px;color:var(--gw-muted)">Loading…</div>`;

  const week = ttWeekRange(_ttPayrollWeekOffset);

  let summary = [], entries = [];
  try {
    const [sRes, eRes] = await Promise.all([
      fetch(`/api/time/weekly-summary?from=${week.from}&to=${week.to}`, { credentials:'include' }),
      fetch(`/api/time/entries?from=${week.from}&to=${week.to}`, { credentials:'include' })
    ]);
    const [sJ, eJ] = await Promise.all([sRes.json(), eRes.json()]);
    summary = sJ.ok ? (sJ.data||[]) : [];
    entries = eJ.ok ? (eJ.data||[]) : [];
  } catch { summary = []; entries = []; }

  _ttPayrollSelected = new Set();
  const pendingEntries = entries.filter(e => e.approved===0 && e.clock_out);
  const totalHours = summary.reduce((s,r)=>s+(r.total_min||0),0);
  const approvedHours = summary.reduce((s,r)=>s+(r.approved_min||0),0);

  // Group entries by rep
  const byRep = {};
  entries.forEach(e => {
    if (!byRep[e.rep_id]) byRep[e.rep_id] = { name: e.rep_name, color: e.rep_color, entries:[] };
    byRep[e.rep_id].entries.push(e);
  });

  body.innerHTML = `
<!-- Week nav -->
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:10px">
  <div style="display:flex;align-items:center;gap:10px">
    <button onclick="_ttPayrollWeekOffset--;ttRenderPayroll()" style="background:var(--gw-surface-2);border:1px solid var(--gw-line);border-radius:8px;padding:6px 12px;color:var(--gw-ink);cursor:pointer;font-size:13px">← Prev</button>
    <span style="font-size:14px;font-weight:700;color:var(--gw-ink)">${week.label}</span>
    <button onclick="_ttPayrollWeekOffset++;ttRenderPayroll()" ${_ttPayrollWeekOffset>=0?'disabled style="opacity:.4;cursor:not-allowed;background:var(--gw-surface-2);border:1px solid var(--gw-line);border-radius:8px;padding:6px 12px;color:var(--gw-muted);font-size:13px"':'style="background:var(--gw-surface-2);border:1px solid var(--gw-line);border-radius:8px;padding:6px 12px;color:var(--gw-ink);cursor:pointer;font-size:13px"'}>Next →</button>
  </div>
  <div style="display:flex;gap:8px">
    <button onclick="ttApproveAll()" style="background:#2D7A5518;border:1px solid #2D7A5540;color:#2D7A55;border-radius:8px;padding:7px 14px;font-size:12px;font-weight:700;cursor:pointer">✓ Approve All Pending (${pendingEntries.length})</button>
    <button onclick="ttExportCSV('${week.from}','${week.to}')" style="background:var(--gw-surface-2);border:1px solid var(--gw-line);border-radius:8px;padding:7px 14px;font-size:12px;font-weight:600;color:var(--gw-ink);cursor:pointer">⬇ Export CSV</button>
  </div>
</div>

<!-- Summary stats -->
<div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap">
  <div class="tt-stat-card">
    <div style="font-size:11px;font-weight:700;color:var(--gw-muted);text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px">Total Team Hours</div>
    <div style="font-size:26px;font-weight:900;color:var(--gw-ink)">${ttFmtDecimal(totalHours)}</div>
    <div style="font-size:11px;color:var(--gw-muted)">${ttFmt(totalHours)}</div>
  </div>
  <div class="tt-stat-card">
    <div style="font-size:11px;font-weight:700;color:var(--gw-muted);text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px">Approved</div>
    <div style="font-size:26px;font-weight:900;color:#2D7A55">${ttFmtDecimal(approvedHours)}</div>
    <div style="font-size:11px;color:var(--gw-muted)">${ttFmt(approvedHours)}</div>
  </div>
  <div class="tt-stat-card">
    <div style="font-size:11px;font-weight:700;color:var(--gw-muted);text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px">Pending Review</div>
    <div style="font-size:26px;font-weight:900;color:#8B6914">${pendingEntries.length}</div>
    <div style="font-size:11px;color:var(--gw-muted)">entries</div>
  </div>
  <div class="tt-stat-card">
    <div style="font-size:11px;font-weight:700;color:var(--gw-muted);text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px">Team Members</div>
    <div style="font-size:26px;font-weight:900;color:var(--gw-ink)">${summary.length}</div>
    <div style="font-size:11px;color:var(--gw-muted)">with entries</div>
  </div>
</div>

<!-- Per-rep summary cards -->
${summary.length ? `
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;margin-bottom:24px">
  ${summary.map(r=>`
  <div class="tt-card" style="padding:16px;cursor:pointer" onclick="ttScrollToRep('${r.rep_id}')">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
      <div style="width:34px;height:34px;border-radius:9px;background:${r.rep_color||'#4D8A86'}22;border:2px solid ${r.rep_color||'#4D8A86'}66;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;color:${r.rep_color||'#4D8A86'}">${(r.rep_name||'?')[0]}</div>
      <div>
        <div style="font-size:14px;font-weight:700;color:var(--gw-ink)">${ttE(r.rep_name||'Unknown')}</div>
        <div style="font-size:11px;color:var(--gw-muted)">${r.entry_count} entries</div>
      </div>
      <div style="margin-left:auto;text-align:right">
        <div style="font-size:18px;font-weight:900;color:var(--gw-ink);font-variant-numeric:tabular-nums">${ttFmtDecimal(r.total_min)}h</div>
      </div>
    </div>
    <!-- Mini progress bar -->
    <div style="height:5px;background:var(--gw-line);border-radius:3px;overflow:hidden">
      <div style="height:100%;background:#4D8A86;border-radius:3px;width:${r.total_min>0?Math.round((r.approved_min/r.total_min)*100):0}%"></div>
    </div>
    <div style="display:flex;justify-content:space-between;margin-top:5px;font-size:10px;color:var(--gw-muted)">
      <span style="color:#2D7A55">✓ ${ttFmtDecimal(r.approved_min)}h approved</span>
      <span style="color:#8B6914">⏳ ${ttFmtDecimal(r.pending_min)}h pending</span>
    </div>
  </div>`).join('')}
</div>` : ''}

<!-- Full entries list grouped by rep -->
${Object.entries(byRep).map(([repId, repData])=>`
<div id="tt-rep-section-${repId}" style="margin-bottom:20px">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
    <div style="width:28px;height:28px;border-radius:7px;background:${repData.color||'#4D8A86'}22;border:2px solid ${repData.color||'#4D8A86'}66;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;color:${repData.color||'#4D8A86'}">${(repData.name||'?')[0]}</div>
    <div style="font-size:14px;font-weight:700;color:var(--gw-ink)">${ttE(repData.name||'Unknown')}</div>
    <div style="font-size:12px;color:var(--gw-muted)">${ttFmt(repData.entries.filter(e=>e.clock_out).reduce((s,e)=>s+(e.duration_min||0),0))} total</div>
    ${repData.entries.filter(e=>e.approved===0&&e.clock_out).length>0?`
    <button onclick="ttApproveRep('${repId}')" style="margin-left:auto;background:#2D7A5518;border:1px solid #2D7A5540;color:#2D7A55;border-radius:6px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer">✓ Approve All</button>`:''}
  </div>
  <div class="tt-card" style="padding:0;overflow:hidden">
    ${repData.entries.sort((a,b)=>b.clock_in.localeCompare(a.clock_in)).map(e=>ttEntryRow(e,true)).join('')}
  </div>
</div>`).join('') || `<div style="text-align:center;padding:48px;color:var(--gw-muted)">
  <div style="font-size:32px;margin-bottom:12px">📋</div>
  <div style="font-size:15px;font-weight:600">No entries this week</div>
</div>`}
`;
}

function ttScrollToRep(repId) {
  const el = document.getElementById(`tt-rep-section-${repId}`);
  if (el) el.scrollIntoView({ behavior:'smooth', block:'start' });
}

// ── Modals ─────────────────────────────────────────────────────────────────────
function ttClockInWithType() {
  const modal = document.createElement('div');
  modal.id = 'tt-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:#000c;z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
  modal.innerHTML = `
<div class="gw-modal-card" style="width:min(400px,100%)">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px">
    <h2 style="margin:0;font-size:17px">Clock In</h2>
    <button onclick="document.getElementById('tt-modal').remove()" style="background:none;border:none;color:var(--gw-muted);cursor:pointer;font-size:20px">✕</button>
  </div>
  <div style="display:grid;gap:14px">
    <div>
      <label class="um-label">Job Type</label>
      <select id="tt-ci-type" class="um-input">
        ${TT_JOB_TYPES.map(t=>`<option value="${t}">${t}</option>`).join('')}
      </select>
    </div>
    <div>
      <label class="um-label">Note <span style="font-weight:400;color:var(--gw-muted)">(optional)</span></label>
      <input id="tt-ci-note" class="um-input" type="text" placeholder="What are you working on?">
    </div>
  </div>
  <div style="display:flex;gap:10px;margin-top:20px;justify-content:flex-end">
    <button class="secondary-btn" onclick="document.getElementById('tt-modal').remove()">Cancel</button>
    <button class="primary-btn" onclick="ttDoClockIn()">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:5px"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      Clock In Now
    </button>
  </div>
</div>`;
  document.body.appendChild(modal);
  document.getElementById('tt-ci-type').focus();
}

async function ttDoClockIn() {
  const jobType = document.getElementById('tt-ci-type')?.value || 'General Work';
  const notes   = document.getElementById('tt-ci-note')?.value?.trim() || '';
  document.getElementById('tt-modal')?.remove();
  try {
    const res = await fetch('/api/time/clock-in', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ jobType, notes })
    });
    const j = await res.json();
    if (j.ok) {
      window._ttState.activeEntry = { id: j.data.id, clock_in: j.data.clock_in, job_type: jobType, notes };
      ttRenderSidebarWidget();
      ttStartSidebarTimer();
      ttToast(`Clocked in · ${jobType} ✓`);
      if (typeof window._ttRefresh === 'function') window._ttRefresh();
    } else { ttToast(j.error || 'Failed to clock in'); }
  } catch { ttToast('Network error'); }
}

function ttClockOutWithNote() {
  const modal = document.createElement('div');
  modal.id = 'tt-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:#000c;z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
  const active = window._ttState.activeEntry;
  modal.innerHTML = `
<div class="gw-modal-card" style="width:min(400px,100%)">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px">
    <h2 style="margin:0;font-size:17px">Clock Out</h2>
    <button onclick="document.getElementById('tt-modal').remove()" style="background:none;border:none;color:var(--gw-muted);cursor:pointer;font-size:20px">✕</button>
  </div>
  ${active?`<div style="font-size:13px;color:var(--gw-muted);margin-bottom:14px">Started at ${ttFmtTime(active.clock_in)} · ${ttE(active.job_type||'General Work')}</div>`:''}
  <div>
    <label class="um-label">End Note <span style="font-weight:400;color:var(--gw-muted)">(optional)</span></label>
    <input id="tt-co-note" class="um-input" type="text" placeholder="What did you accomplish?">
  </div>
  <div style="display:flex;gap:10px;margin-top:20px;justify-content:flex-end">
    <button class="secondary-btn" onclick="document.getElementById('tt-modal').remove()">Cancel</button>
    <button class="danger-btn" onclick="ttDoClockOut()">Clock Out</button>
  </div>
</div>`;
  document.body.appendChild(modal);
}

async function ttDoClockOut() {
  const notes = document.getElementById('tt-co-note')?.value?.trim() || '';
  document.getElementById('tt-modal')?.remove();
  try {
    const res = await fetch('/api/time/clock-out', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ notes })
    });
    const j = await res.json();
    if (j.ok) {
      window._ttState.activeEntry = null;
      clearInterval(window._ttState.timerInterval);
      clearInterval(window._ttMainTimer);
      ttRenderSidebarWidget();
      ttToast(`Clocked out — ${ttFmt(j.data.duration_min)} logged ✓`);
      if (typeof window._ttRefresh === 'function') window._ttRefresh();
    } else { ttToast(j.error || 'Failed to clock out'); }
  } catch { ttToast('Network error'); }
}

function ttOpenAddEntry() {
  const now = new Date();
  const pad = n => String(n).padStart(2,'0');
  const dateStr = now.toISOString().slice(0,10);
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

  const modal = document.createElement('div');
  modal.id = 'tt-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:#000c;z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
  modal.innerHTML = `
<div class="gw-modal-card" style="width:min(460px,100%)">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px">
    <h2 style="margin:0;font-size:17px">Add Manual Entry</h2>
    <button onclick="document.getElementById('tt-modal').remove()" style="background:none;border:none;color:var(--gw-muted);cursor:pointer;font-size:20px">✕</button>
  </div>
  <div style="display:grid;gap:14px">
    <div>
      <label class="um-label">Job Type</label>
      <select id="tt-ae-type" class="um-input">
        ${TT_JOB_TYPES.map(t=>`<option value="${t}">${t}</option>`).join('')}
      </select>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
      <div>
        <label class="um-label">Date</label>
        <input id="tt-ae-date" class="um-input" type="date" value="${dateStr}">
      </div>
      <div>
        <label class="um-label">Clock In</label>
        <input id="tt-ae-in" class="um-input" type="time" value="08:00">
      </div>
      <div>
        <label class="um-label">Clock Out</label>
        <input id="tt-ae-out" class="um-input" type="time" value="${timeStr}">
      </div>
    </div>
    <div>
      <label class="um-label">Notes</label>
      <input id="tt-ae-note" class="um-input" type="text" placeholder="What did you work on?">
    </div>
  </div>
  <div style="display:flex;gap:10px;margin-top:20px;justify-content:flex-end">
    <button class="secondary-btn" onclick="document.getElementById('tt-modal').remove()">Cancel</button>
    <button class="primary-btn" onclick="ttSaveManualEntry()">Save Entry</button>
  </div>
</div>`;
  document.body.appendChild(modal);
}

async function ttSaveManualEntry() {
  const date    = document.getElementById('tt-ae-date')?.value;
  const inTime  = document.getElementById('tt-ae-in')?.value;
  const outTime = document.getElementById('tt-ae-out')?.value;
  const jobType = document.getElementById('tt-ae-type')?.value || 'General Work';
  const notes   = document.getElementById('tt-ae-note')?.value?.trim() || '';
  if (!date||!inTime||!outTime) { ttToast('Please fill in date and times'); return; }

  const clockIn  = new Date(`${date}T${inTime}:00`).toISOString();
  const clockOut = new Date(`${date}T${outTime}:00`).toISOString();
  if (new Date(clockOut) <= new Date(clockIn)) { ttToast('Clock-out must be after clock-in'); return; }

  // Clock in then immediately clock out (manual entry via two calls)
  try {
    // Use a special manual-entry approach: clock in with past time via edit
    const resIn = await fetch('/api/time/clock-in', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ jobType, notes })
    });
    const jIn = await resIn.json();
    if (!jIn.ok) { ttToast(jIn.error||'Failed'); return; }
    // Immediately edit to set correct times
    await fetch(`/api/time/entries/${jIn.data.id}`, {
      method:'PUT', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ clockIn, clockOut, jobType, notes })
    });
    // Then clock out with correct times
    await fetch('/api/time/clock-out', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ notes })
    });
    // Re-fetch active entry to ensure state is clean
    await ttLoadActiveEntry();
    document.getElementById('tt-modal')?.remove();
    ttToast('Entry added ✓');
    if (typeof window._ttRefresh === 'function') window._ttRefresh();
  } catch { ttToast('Network error'); }
}

async function ttEditEntry(id) {
  // Fetch current entry from server
  let entry = null;
  try {
    const res = await fetch(`/api/time/entries?from=2020-01-01&to=2099-12-31`, { credentials:'include' });
    const j   = await res.json();
    entry = (j.data||[]).find(e=>e.id===id);
  } catch {}
  if (!entry) { ttToast('Could not load entry'); return; }

  const pad = n => String(n).padStart(2,'0');
  const toDateTimeLocal = iso => {
    if (!iso) return '';
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const modal = document.createElement('div');
  modal.id = 'tt-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:#000c;z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
  modal.innerHTML = `
<div class="gw-modal-card" style="width:min(460px,100%)">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px">
    <h2 style="margin:0;font-size:17px">Edit Entry</h2>
    <button onclick="document.getElementById('tt-modal').remove()" style="background:none;border:none;color:var(--gw-muted);cursor:pointer;font-size:20px">✕</button>
  </div>
  <div style="display:grid;gap:14px">
    <div>
      <label class="um-label">Job Type</label>
      <select id="tt-ed-type" class="um-input">
        ${TT_JOB_TYPES.map(t=>`<option value="${t}" ${entry.job_type===t?'selected':''}>${t}</option>`).join('')}
      </select>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div>
        <label class="um-label">Clock In</label>
        <input id="tt-ed-in" class="um-input" type="datetime-local" value="${toDateTimeLocal(entry.clock_in)}">
      </div>
      <div>
        <label class="um-label">Clock Out</label>
        <input id="tt-ed-out" class="um-input" type="datetime-local" value="${toDateTimeLocal(entry.clock_out)}">
      </div>
    </div>
    <div>
      <label class="um-label">Notes</label>
      <input id="tt-ed-note" class="um-input" type="text" value="${ttE(entry.notes||'')}">
    </div>
  </div>
  <div style="display:flex;gap:10px;margin-top:20px;justify-content:flex-end">
    <button class="secondary-btn" onclick="document.getElementById('tt-modal').remove()">Cancel</button>
    <button class="primary-btn" onclick="ttSaveEdit('${id}')">Save Changes</button>
  </div>
</div>`;
  document.body.appendChild(modal);
}

async function ttSaveEdit(id) {
  const jobType  = document.getElementById('tt-ed-type')?.value;
  const clockIn  = document.getElementById('tt-ed-in')?.value;
  const clockOut = document.getElementById('tt-ed-out')?.value;
  const notes    = document.getElementById('tt-ed-note')?.value?.trim();
  document.getElementById('tt-modal')?.remove();
  try {
    const res = await fetch(`/api/time/entries/${id}`, {
      method:'PUT', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        jobType,
        notes,
        clockIn:  clockIn  ? new Date(clockIn).toISOString()  : undefined,
        clockOut: clockOut ? new Date(clockOut).toISOString() : undefined
      })
    });
    const j = await res.json();
    if (j.ok) { ttToast('Entry updated ✓'); if (typeof window._ttRefresh==='function') window._ttRefresh(); }
    else ttToast(j.error||'Update failed');
  } catch { ttToast('Network error'); }
}

async function ttDeleteEntry(id) {
  if (!confirm('Delete this time entry?')) return;
  try {
    const res = await fetch(`/api/time/entries/${id}`, { method:'DELETE', credentials:'include' });
    const j   = await res.json();
    if (j.ok) { ttToast('Entry deleted'); if (typeof window._ttRefresh==='function') window._ttRefresh(); }
    else ttToast(j.error||'Delete failed');
  } catch { ttToast('Network error'); }
}

async function ttAdminApprove(id, status) {
  try {
    const res = await fetch(`/api/time/entries/${id}`, {
      method:'PUT', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ approved: status })
    });
    const j = await res.json();
    if (j.ok) {
      ttToast(status===1 ? '✓ Approved' : status===2 ? 'Rejected' : 'Reset to pending');
      if (typeof window._ttRefresh==='function') window._ttRefresh();
    } else ttToast(j.error||'Failed');
  } catch { ttToast('Network error'); }
}

async function ttApproveAll() {
  const week = ttWeekRange(_ttPayrollWeekOffset);
  try {
    const res = await fetch(`/api/time/entries?from=${week.from}&to=${week.to}`, { credentials:'include' });
    const j   = await res.json();
    const ids  = (j.data||[]).filter(e=>e.approved===0&&e.clock_out).map(e=>e.id);
    if (!ids.length) { ttToast('No pending entries to approve'); return; }
    const r2 = await fetch('/api/time/approve-batch', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ ids, approved: 1 })
    });
    const j2 = await r2.json();
    if (j2.ok) { ttToast(`✓ Approved ${j2.data.updated} entries`); ttRenderPayroll(); }
    else ttToast(j2.error||'Failed');
  } catch { ttToast('Network error'); }
}

async function ttApproveRep(repId) {
  const week = ttWeekRange(_ttPayrollWeekOffset);
  try {
    const res = await fetch(`/api/time/entries?from=${week.from}&to=${week.to}&repId=${repId}`, { credentials:'include' });
    const j   = await res.json();
    const ids  = (j.data||[]).filter(e=>e.approved===0&&e.clock_out).map(e=>e.id);
    if (!ids.length) { ttToast('No pending entries'); return; }
    const r2 = await fetch('/api/time/approve-batch', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ ids, approved: 1 })
    });
    const j2 = await r2.json();
    if (j2.ok) { ttToast(`✓ Approved ${j2.data.updated} entries`); ttRenderPayroll(); }
    else ttToast(j2.error||'Failed');
  } catch { ttToast('Network error'); }
}

async function ttExportCSV(from, to) {
  try {
    const res = await fetch(`/api/time/entries?from=${from}&to=${to}`, { credentials:'include' });
    const j   = await res.json();
    const rows = j.data || [];
    const header = ['Rep Name','Job Type','Date','Clock In','Clock Out','Duration (hrs)','Duration (min)','Notes','Status'];
    const lines  = [header.join(',')];
    rows.filter(e=>e.clock_out).forEach(e => {
      const status = e.approved===1?'Approved':e.approved===2?'Rejected':'Pending';
      lines.push([
        `"${(e.rep_name||'').replace(/"/g,'""')}"`,
        `"${(e.job_type||'').replace(/"/g,'""')}"`,
        e.clock_in.slice(0,10),
        ttFmtTime(e.clock_in),
        ttFmtTime(e.clock_out),
        ttFmtDecimal(e.duration_min),
        e.duration_min||0,
        `"${(e.notes||'').replace(/"/g,'""')}"`,
        status
      ].join(','));
    });
    const blob = new Blob([lines.join('\n')], { type:'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `timesheet_${from}_${to}.csv`;
    a.click(); URL.revokeObjectURL(url);
    ttToast(`Exported ${rows.filter(e=>e.clock_out).length} entries`);
  } catch { ttToast('Export failed'); }
}

// ── Init: load active entry on page load ──────────────────────────────────────
// Called from app_premium.js after login
window.ttInit = function() {
  ttLoadActiveEntry();
};
