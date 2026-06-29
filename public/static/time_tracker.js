/**
 * Groundwork CRM — Time Tracker Module v2.0
 * Complete redesign: 4-tab system with circular timer, date slider, calendar,
 * payroll leaderboard, insights charts. Inspired by ClockShark, Toggl, Harvest,
 * Monday.com, Tick, Miquido.
 */

// ─────────────────────────────────────────────────────────────────────────────
//  GLOBAL STATE
// ─────────────────────────────────────────────────────────────────────────────
window._ttState = window._ttState || {
  activeEntry:    null,
  timerInterval:  null,
  ringInterval:   null,
  currentTab:     'timesheet',
  weekOffset:     0,
  calOffset:      0,
  payrollOffset:  0,
  selectedDate:   null,        // ISO date string, e.g. "2026-06-29"
  allEntries:     [],
  teamEntries:    [],
  selected:       new Set(),   // selected entry ids for batch ops
  calEntries:     [],
  editingId:      null,
};

const TT_JOB_TYPES = [
  'General Work','Sales Visit','Site Estimate',
  'Admin / Office','Training','Drive Time','Meeting','Other'
];

// Color palette for job types / calendar blocks
const TT_COLORS = {
  'General Work':  { bg:'#E0F0FF', border:'#4B9EE6', text:'#1A5FA6' },
  'Sales Visit':   { bg:'#FFF0E0', border:'#E68A4B', text:'#A65C1A' },
  'Site Estimate': { bg:'#E0FFE8', border:'#4BE67A', text:'#1A7A3C' },
  'Admin / Office':{ bg:'#F0E0FF', border:'#9B4BE6', text:'#5C1AA6' },
  'Training':      { bg:'#FFFFE0', border:'#E6D44B', text:'#8A7C10' },
  'Drive Time':    { bg:'#FFE0F0', border:'#E64B9B', text:'#A61A5C' },
  'Meeting':       { bg:'#E0FFFC', border:'#4BE6D4', text:'#1A8A7C' },
  'Other':         { bg:'#F0F0F0', border:'#909090', text:'#444444' },
};

// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function ttFmt(min) {
  if (min == null || isNaN(min)) return '—';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h ${m.toString().padStart(2,'0')}m`;
}
function ttFmtDecimal(min) { return min ? (min/60).toFixed(2) : '0.00'; }
function ttFmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',hour12:true});
}
function ttFmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
}
function ttFmtDateShort(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US',{month:'short',day:'numeric'});
}
function ttFmtDateFull(d) {
  return d.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
}
function ttElapsed(clockInIso) {
  const diff = Math.floor((Date.now() - new Date(clockInIso).getTime()) / 1000);
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  return { h, m, s, total: diff };
}
function ttElapsedStr(clockInIso) {
  const { h, m, s } = ttElapsed(clockInIso);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function ttWeekRange(offset = 0) {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1) + offset * 7);
  monday.setHours(0,0,0,0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23,59,59,999);
  return {
    from: monday.toISOString().slice(0,10),
    to:   sunday.toISOString().slice(0,10),
    monday,
    sunday,
    label: `${ttFmtDateShort(monday.toISOString())} – ${ttFmtDateShort(sunday.toISOString())}`
  };
}
function ttE(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function ttToast(msg) {
  if (typeof window.showToast === 'function') window.showToast(msg);
}
function ttColorForJob(job) {
  return TT_COLORS[job] || TT_COLORS['Other'];
}
function ttDaysInWeek(offset) {
  const { monday } = ttWeekRange(offset);
  return Array.from({length:7}, (_,i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}
function ttIsToday(dateObj) {
  const t = new Date();
  return dateObj.getFullYear() === t.getFullYear() &&
         dateObj.getMonth() === t.getMonth() &&
         dateObj.getDate() === t.getDate();
}

// ─────────────────────────────────────────────────────────────────────────────
//  RING TIMER (SVG circular — ClockShark style)
// ─────────────────────────────────────────────────────────────────────────────
function ttRingUpdate() {
  const st = window._ttState;
  if (!st.activeEntry) return;
  const { h, m, s } = ttElapsed(st.activeEntry.clock_in);

  // Update digits
  ['tt-ring-h','tt-ring-m','tt-ring-s'].forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.textContent = [h, m, s][i].toString().padStart(2,'0');
  });

  // Update SVG ring arcs (progress within each unit)
  const sProgress = (s / 60);
  const mProgress = ((m * 60 + s) / 3600);
  const hProgress = ((h % 12) / 12 + m / 720);

  const updateArc = (id, progress) => {
    const el = document.getElementById(id);
    if (!el) return;
    const r = parseFloat(el.getAttribute('r') || 40);
    const circ = 2 * Math.PI * r;
    el.style.strokeDasharray = circ;
    el.style.strokeDashoffset = circ * (1 - Math.min(progress, 1));
  };
  updateArc('tt-arc-s', sProgress);
  updateArc('tt-arc-m', mProgress);
  updateArc('tt-arc-h', hProgress);

  // Update sidebar widget timer
  const sw = document.getElementById('tt-sidebar-elapsed');
  if (sw) sw.textContent = `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
}

function ttStartRing() {
  if (window._ttState.ringInterval) clearInterval(window._ttState.ringInterval);
  window._ttState.ringInterval = setInterval(ttRingUpdate, 1000);
  ttRingUpdate();
}
function ttStopRing() {
  if (window._ttState.ringInterval) { clearInterval(window._ttState.ringInterval); window._ttState.ringInterval = null; }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SIDEBAR WIDGET
// ─────────────────────────────────────────────────────────────────────────────
function ttRenderSidebarWidget() {
  const widget = document.getElementById('tt-sidebar-widget');
  if (!widget) return;
  const st = window._ttState;

  if (st.activeEntry) {
    const { h, m, s } = ttElapsed(st.activeEntry.clock_in);
    widget.innerHTML = `
      <div style="margin:0 0 6px;padding:10px 12px;background:linear-gradient(135deg,#1A3A2A 0%,#0F2419 100%);border:1px solid #2D7A5540;border-radius:12px;cursor:pointer" onclick="show('timeTracker')">
        <div style="display:flex;align-items:center;gap:7px;margin-bottom:7px">
          <div style="width:7px;height:7px;border-radius:50%;background:#4ade80;box-shadow:0 0 6px #4ade80aa;flex-shrink:0;animation:tt-pulse 1.5s infinite ease-in-out"></div>
          <span style="font-size:10px;font-weight:700;letter-spacing:.08em;color:#4ade80;text-transform:uppercase">Live — Clocked In</span>
        </div>
        <div style="font-size:22px;font-weight:900;font-variant-numeric:tabular-nums;letter-spacing:.05em;color:#fff;line-height:1;margin-bottom:5px">
          <span id="tt-sidebar-elapsed">${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}</span>
        </div>
        <div style="font-size:10px;color:#86efac;margin-bottom:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${ttE(st.activeEntry.job_type||'General Work')}</div>
        <div style="display:flex;gap:5px">
          <button onclick="event.stopPropagation();ttShowBreakModal()" style="flex:1;background:#1e40af22;border:1px solid #3b82f640;color:#93c5fd;border-radius:7px;padding:5px 4px;font-size:10px;font-weight:700;cursor:pointer">Break</button>
          <button onclick="event.stopPropagation();ttQuickClockOut()" style="flex:1;background:#be123c22;border:1px solid #f4375040;color:#fda4af;border-radius:7px;padding:5px 4px;font-size:10px;font-weight:700;cursor:pointer">Clock Out</button>
        </div>
      </div>`;
    // Start sidebar timer
    if (window._ttState.timerInterval) clearInterval(window._ttState.timerInterval);
    window._ttState.timerInterval = setInterval(() => {
      const el = document.getElementById('tt-sidebar-elapsed');
      if (el && window._ttState.activeEntry) {
        const { h, m, s } = ttElapsed(window._ttState.activeEntry.clock_in);
        el.textContent = `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
      }
    }, 1000);
  } else {
    if (window._ttState.timerInterval) { clearInterval(window._ttState.timerInterval); window._ttState.timerInterval = null; }
    widget.innerHTML = `
      <button onclick="ttQuickClockIn()"
        style="width:100%;display:flex;align-items:center;justify-content:center;gap:7px;padding:9px 14px;background:var(--gw-surface-2,#1e2a22);border:1.5px dashed #4D8A8660;border-radius:10px;color:var(--gw-muted,#7a9080);font-size:11px;font-weight:600;cursor:pointer;transition:all .15s;margin-bottom:6px"
        onmouseover="this.style.borderColor='#4D8A86';this.style.color='#4D8A86';this.style.background='#4D8A8610'"
        onmouseout="this.style.borderColor='#4D8A8660';this.style.color='var(--gw-muted,#7a9080)';this.style.background='var(--gw-surface-2,#1e2a22)'">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        Clock In
      </button>`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  CLOCK IN / OUT API
// ─────────────────────────────────────────────────────────────────────────────
async function ttLoadActiveEntry() {
  try {
    const res = await fetch('/api/time/active', { credentials:'include' });
    const j   = await res.json();
    window._ttState.activeEntry = (j.ok && j.data) ? j.data : null;
  } catch { window._ttState.activeEntry = null; }
  ttRenderSidebarWidget();
  if (window._ttState.activeEntry) ttStartRing();
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
      window._ttState.activeEntry = { id: j.data.id, clock_in: j.data.clock_in, job_type: 'General Work' };
      ttRenderSidebarWidget();
      ttStartRing();
      ttToast('Clocked in ✓');
      ttRefreshCurrent();
    } else { ttToast(j.error || 'Could not clock in'); }
  } catch { ttToast('Network error'); }
}

async function ttQuickClockOut() {
  const st = window._ttState;
  if (!st.activeEntry) return;
  try {
    const res = await fetch(`/api/time/clock-out/${st.activeEntry.id}`, {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({})
    });
    const j = await res.json();
    if (j.ok) {
      st.activeEntry = null;
      ttRenderSidebarWidget();
      ttStopRing();
      ttResetRingDisplay();
      ttToast('Clocked out ✓');
      ttRefreshCurrent();
    } else { ttToast(j.error || 'Could not clock out'); }
  } catch { ttToast('Network error'); }
}

function ttResetRingDisplay() {
  ['tt-ring-h','tt-ring-m','tt-ring-s'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '00';
  });
  ['tt-arc-h','tt-arc-m','tt-arc-s'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.style.strokeDashoffset = el.style.strokeDasharray; }
  });
}

function ttShowBreakModal() { ttToast('Break tracking coming soon'); }

function ttRefreshCurrent() {
  const tab = window._ttState.currentTab;
  if      (tab === 'timesheet') ttLoadTimesheet();
  else if (tab === 'calendar')  ttLoadCalendar();
  else if (tab === 'payroll')   ttLoadPayroll();
  else if (tab === 'insights')  ttLoadInsights();
}

// ─────────────────────────────────────────────────────────────────────────────
//  CLOCK IN MODAL (full form)
// ─────────────────────────────────────────────────────────────────────────────
function ttShowClockInModal() {
  const jobOpts = TT_JOB_TYPES.map(j => `<option value="${ttE(j)}">${ttE(j)}</option>`).join('');
  const now = new Date();
  const isoLocal = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}T${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  ttShowModal(`
    <div style="padding:28px 28px 24px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px">
        <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#4ade80,#22c55e);display:flex;align-items:center;justify-content:center">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </div>
        <div>
          <div style="font-size:16px;font-weight:800;color:var(--gw-text,#E8E4D9)">Clock In</div>
          <div style="font-size:11px;color:var(--gw-muted,#9a9a8a)">Start tracking your time</div>
        </div>
      </div>
      <div style="display:grid;gap:14px">
        <div>
          <label style="font-size:11px;font-weight:700;letter-spacing:.05em;color:var(--gw-muted,#9a9a8a);text-transform:uppercase;display:block;margin-bottom:5px">Job Type</label>
          <select id="tt-ci-job" style="width:100%;padding:9px 12px;background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:8px;color:var(--gw-text,#E8E4D9);font-size:13px;font-weight:600">
            ${jobOpts}
          </select>
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;letter-spacing:.05em;color:var(--gw-muted,#9a9a8a);text-transform:uppercase;display:block;margin-bottom:5px">Start Time</label>
          <input type="datetime-local" id="tt-ci-start" value="${isoLocal}" style="width:100%;padding:9px 12px;background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:8px;color:var(--gw-text,#E8E4D9);font-size:13px;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;letter-spacing:.05em;color:var(--gw-muted,#9a9a8a);text-transform:uppercase;display:block;margin-bottom:5px">Notes <span style="opacity:.5;font-weight:400">(optional)</span></label>
          <textarea id="tt-ci-notes" rows="2" placeholder="What are you working on?" style="width:100%;padding:9px 12px;background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:8px;color:var(--gw-text,#E8E4D9);font-size:13px;resize:vertical;font-family:inherit;box-sizing:border-box"></textarea>
        </div>
        <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:#4ade8010;border:1px solid #4ade8030;border-radius:8px">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
          <span style="font-size:12px;color:#4ade80;font-weight:600">Billable</span>
          <div style="margin-left:auto">
            <label style="position:relative;display:inline-block;width:36px;height:20px;cursor:pointer">
              <input type="checkbox" id="tt-ci-billable" checked style="opacity:0;width:0;height:0;position:absolute">
              <span id="tt-ci-billable-track" style="position:absolute;inset:0;border-radius:20px;background:#4ade80;transition:background .2s"></span>
              <span id="tt-ci-billable-thumb" style="position:absolute;top:2px;left:18px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .2s;box-shadow:0 1px 3px rgba(0,0,0,.3)"></span>
            </label>
          </div>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-top:20px">
        <button onclick="ttCloseModal()" style="flex:1;padding:10px;background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:8px;color:var(--gw-muted,#9a9a8a);font-size:13px;font-weight:600;cursor:pointer">Cancel</button>
        <button onclick="ttDoClockIn()" style="flex:2;padding:10px;background:linear-gradient(135deg,#22c55e,#16a34a);border:none;border-radius:8px;color:#fff;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 2px 12px #22c55e40">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;margin-right:5px"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          Clock In Now
        </button>
      </div>
    </div>
  `);

  // wire billable toggle
  const cb = document.getElementById('tt-ci-billable');
  if (cb) {
    cb.addEventListener('change', () => {
      const track = document.getElementById('tt-ci-billable-track');
      const thumb = document.getElementById('tt-ci-billable-thumb');
      if (track) track.style.background = cb.checked ? '#4ade80' : '#4a4a5a';
      if (thumb) thumb.style.left = cb.checked ? '18px' : '2px';
    });
  }
}

async function ttDoClockIn() {
  const job      = document.getElementById('tt-ci-job')?.value || 'General Work';
  const startVal = document.getElementById('tt-ci-start')?.value;
  const notes    = document.getElementById('tt-ci-notes')?.value || '';
  const billable = document.getElementById('tt-ci-billable')?.checked ? 1 : 0;
  const clockIn  = startVal ? new Date(startVal).toISOString() : new Date().toISOString();

  try {
    const res = await fetch('/api/time/clock-in', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ jobType: job, clockIn, notes, billable })
    });
    const j = await res.json();
    if (j.ok) {
      window._ttState.activeEntry = { id: j.data.id, clock_in: j.data.clock_in, job_type: job };
      ttRenderSidebarWidget();
      ttStartRing();
      ttCloseModal();
      ttToast('Clocked in ✓');
      ttRefreshCurrent();
    } else { ttToast(j.error || 'Could not clock in'); }
  } catch { ttToast('Network error'); }
}

// Clock Out Modal
function ttShowClockOutModal() {
  const st = window._ttState;
  if (!st.activeEntry) return;
  const elapsed = ttElapsedStr(st.activeEntry.clock_in);
  const now = new Date();
  const isoLocal = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}T${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  ttShowModal(`
    <div style="padding:28px 28px 24px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px">
        <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#f87171,#dc2626);display:flex;align-items:center;justify-content:center">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
        </div>
        <div>
          <div style="font-size:16px;font-weight:800;color:var(--gw-text,#E8E4D9)">Clock Out</div>
          <div style="font-size:11px;color:var(--gw-muted,#9a9a8a)">Elapsed: <strong style="color:#f87171">${elapsed}</strong></div>
        </div>
      </div>
      <div style="display:grid;gap:14px">
        <div>
          <label style="font-size:11px;font-weight:700;letter-spacing:.05em;color:var(--gw-muted,#9a9a8a);text-transform:uppercase;display:block;margin-bottom:5px">End Time</label>
          <input type="datetime-local" id="tt-co-end" value="${isoLocal}" style="width:100%;padding:9px 12px;background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:8px;color:var(--gw-text,#E8E4D9);font-size:13px;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;letter-spacing:.05em;color:var(--gw-muted,#9a9a8a);text-transform:uppercase;display:block;margin-bottom:5px">Job Type</label>
          <select id="tt-co-job" style="width:100%;padding:9px 12px;background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:8px;color:var(--gw-text,#E8E4D9);font-size:13px;font-weight:600">
            ${TT_JOB_TYPES.map(j => `<option value="${ttE(j)}" ${j === st.activeEntry.job_type ? 'selected' : ''}>${ttE(j)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;letter-spacing:.05em;color:var(--gw-muted,#9a9a8a);text-transform:uppercase;display:block;margin-bottom:5px">Notes</label>
          <textarea id="tt-co-notes" rows="2" placeholder="What did you work on?" style="width:100%;padding:9px 12px;background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:8px;color:var(--gw-text,#E8E4D9);font-size:13px;resize:vertical;font-family:inherit;box-sizing:border-box">${ttE(st.activeEntry.notes||'')}</textarea>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-top:20px">
        <button onclick="ttCloseModal()" style="flex:1;padding:10px;background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:8px;color:var(--gw-muted,#9a9a8a);font-size:13px;font-weight:600;cursor:pointer">Cancel</button>
        <button onclick="ttDoClockOut()" style="flex:2;padding:10px;background:linear-gradient(135deg,#f87171,#dc2626);border:none;border-radius:8px;color:#fff;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 2px 12px #dc262640">
          Clock Out Now
        </button>
      </div>
    </div>
  `);
}

async function ttDoClockOut() {
  const st = window._ttState;
  if (!st.activeEntry) return;
  const endVal  = document.getElementById('tt-co-end')?.value;
  const job     = document.getElementById('tt-co-job')?.value;
  const notes   = document.getElementById('tt-co-notes')?.value || '';
  const clockOut = endVal ? new Date(endVal).toISOString() : new Date().toISOString();

  try {
    const res = await fetch(`/api/time/clock-out/${st.activeEntry.id}`, {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ clockOut, jobType: job, notes })
    });
    const j = await res.json();
    if (j.ok) {
      st.activeEntry = null;
      ttRenderSidebarWidget();
      ttStopRing();
      ttResetRingDisplay();
      ttCloseModal();
      ttToast('Clocked out ✓');
      ttRefreshCurrent();
    } else { ttToast(j.error || 'Could not clock out'); }
  } catch { ttToast('Network error'); }
}

// ─────────────────────────────────────────────────────────────────────────────
//  MODAL CONTAINER
// ─────────────────────────────────────────────────────────────────────────────
function ttShowModal(html) {
  let overlay = document.getElementById('tt-modal-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'tt-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)';
    overlay.addEventListener('click', e => { if (e.target === overlay) ttCloseModal(); });
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `
    <div style="background:var(--gw-surface,#141f1a);border:1px solid var(--gw-line,#2a3a30);border-radius:16px;min-width:340px;max-width:460px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,.6);animation:tt-modal-in .15s ease-out">
      ${html}
    </div>`;
  overlay.style.display = 'flex';
}

function ttCloseModal() {
  const overlay = document.getElementById('tt-modal-overlay');
  if (overlay) overlay.style.display = 'none';
}

// ─────────────────────────────────────────────────────────────────────────────
//  DATE SLIDER (Miquido style)
// ─────────────────────────────────────────────────────────────────────────────
function ttBuildDateSlider(offset, selectedDate) {
  const days = ttDaysInWeek(offset);
  const selStr = selectedDate || days[0].toISOString().slice(0,10);

  return `
    <div style="display:flex;gap:7px;overflow-x:auto;padding-bottom:4px;scrollbar-width:none;-ms-overflow-style:none" id="tt-date-slider">
      ${days.map(d => {
        const iso = d.toISOString().slice(0,10);
        const isToday = ttIsToday(d);
        const isSel = iso === selStr;
        const dayName = d.toLocaleDateString('en-US',{weekday:'short'});
        const dayNum  = d.getDate();
        const month   = d.toLocaleDateString('en-US',{month:'short'});
        return `
          <button onclick="ttSelectDate('${iso}')" style="flex-shrink:0;min-width:52px;padding:10px 8px;border-radius:12px;border:2px solid ${isSel ? '#2563EB' : isToday ? '#4ade8040' : 'var(--gw-line,#2a3a30)'};background:${isSel ? '#2563EB' : isToday ? '#4ade8008' : 'var(--gw-surface-2,#1a2820)'};cursor:pointer;transition:all .15s;text-align:center">
            <div style="font-size:10px;font-weight:700;letter-spacing:.05em;color:${isSel ? 'rgba(255,255,255,.7)' : isToday ? '#4ade80' : 'var(--gw-muted,#9a9a8a)'};margin-bottom:3px">${dayName}</div>
            <div style="font-size:18px;font-weight:900;color:${isSel ? '#fff' : 'var(--gw-text,#E8E4D9)';};line-height:1">${dayNum}</div>
            <div style="font-size:9px;color:${isSel ? 'rgba(255,255,255,.6)' : 'var(--gw-muted,#9a9a8a)'};margin-top:2px">${month}</div>
          </button>`;
      }).join('')}
    </div>`;
}

function ttSelectDate(iso) {
  window._ttState.selectedDate = iso;
  ttLoadTimesheet();
}

// ─────────────────────────────────────────────────────────────────────────────
//  TAB NAV BAR
// ─────────────────────────────────────────────────────────────────────────────
function ttTabNav(active) {
  const tabs = [
    { id:'timesheet', label:'My Timesheet', icon:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline>' },
    { id:'calendar',  label:'Calendar',     icon:'<rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line>' },
    { id:'payroll',   label:'Payroll Hub',  icon:'<line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path>' },
    { id:'insights',  label:'Insights',     icon:'<line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line>' },
  ];
  return `
    <div style="display:flex;gap:4px;background:var(--gw-surface-2,#1a2820);border-radius:12px;padding:4px;margin-bottom:20px;border:1px solid var(--gw-line,#2a3a30)">
      ${tabs.map(t => `
        <button onclick="ttSwitchTab('${t.id}')" style="flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:9px 8px;border-radius:9px;border:none;background:${active===t.id ? 'var(--gw-surface,#141f1a)' : 'transparent'};color:${active===t.id ? 'var(--gw-text,#E8E4D9)' : 'var(--gw-muted,#9a9a8a)'};font-size:12px;font-weight:${active===t.id ? '700' : '500'};cursor:pointer;transition:all .15s;white-space:nowrap;box-shadow:${active===t.id ? '0 1px 4px rgba(0,0,0,.3)' : 'none'}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${t.icon}</svg>
          <span style="display:none" class="tt-tab-label">${t.label}</span>
        </button>`).join('')}
    </div>`;
}

function ttSwitchTab(tab) {
  window._ttState.currentTab = tab;
  window.timeTracker(tab);
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────
window.timeTracker = function timeTracker(tab) {
  const st = window._ttState;
  tab = tab || st.currentTab || 'timesheet';
  st.currentTab = tab;

  const container = document.getElementById('main-content') || document.getElementById('view-content');
  if (!container) return;

  // Inject global styles
  ttInjectStyles();

  // Build shell
  container.innerHTML = `
    <div id="tt-root" style="display:flex;gap:0;height:100%;min-height:0;overflow:hidden">
      <!-- Left: Main area -->
      <div id="tt-main" style="flex:1;overflow-y:auto;padding:20px 22px;min-width:0">
        <!-- Header row -->
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;gap:12px;flex-wrap:wrap">
          <div>
            <h1 style="font-size:20px;font-weight:900;color:var(--gw-text,#E8E4D9);margin:0;letter-spacing:-.02em">Time Tracker</h1>
            <div style="font-size:11px;color:var(--gw-muted,#9a9a8a);margin-top:2px">${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})}</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center" id="tt-header-actions">
            <!-- Filled by tab -->
          </div>
        </div>
        <!-- Tab nav -->
        ${ttTabNav(tab)}
        <!-- Tab content -->
        <div id="tt-tab-content">
          <div style="text-align:center;padding:40px 0;color:var(--gw-muted,#9a9a8a)">Loading…</div>
        </div>
      </div>

      <!-- Right: Ring timer panel -->
      <div id="tt-ring-panel" style="width:220px;flex-shrink:0;background:var(--gw-surface-2,#0f1a15);border-left:1px solid var(--gw-line,#2a3a30);padding:20px 16px;display:flex;flex-direction:column;align-items:center;overflow-y:auto">
        ${ttBuildRingPanel()}
      </div>
    </div>`;

  // Load tab content
  if      (tab === 'timesheet') ttLoadTimesheet();
  else if (tab === 'calendar')  ttLoadCalendar();
  else if (tab === 'payroll')   ttLoadPayroll();
  else if (tab === 'insights')  ttLoadInsights();

  // Start ring if clocked in
  if (st.activeEntry) ttStartRing();
};

// ─────────────────────────────────────────────────────────────────────────────
//  RING PANEL (right sidebar)
// ─────────────────────────────────────────────────────────────────────────────
function ttBuildRingPanel() {
  const st = window._ttState;
  const isClockedIn = !!st.activeEntry;

  // SVG ring — 3 concentric arcs: hours (outer), minutes (mid), seconds (inner)
  const rH = 76, rM = 58, rS = 40;
  const cH = 2 * Math.PI * rH;
  const cM = 2 * Math.PI * rM;
  const cS = 2 * Math.PI * rS;

  return `
    <div style="width:100%;text-align:center">
      <div style="font-size:10px;font-weight:700;letter-spacing:.1em;color:var(--gw-muted,#9a9a8a);text-transform:uppercase;margin-bottom:14px">
        ${isClockedIn ? 'Live Timer' : 'Ready'}
      </div>

      <!-- Concentric ring SVG -->
      <div style="position:relative;width:190px;height:190px;margin:0 auto 16px">
        <svg width="190" height="190" viewBox="0 0 190 190" style="transform:rotate(-90deg)">
          <!-- Track rings -->
          <circle cx="95" cy="95" r="${rH}" fill="none" stroke="#ffffff08" stroke-width="8"/>
          <circle cx="95" cy="95" r="${rM}" fill="none" stroke="#ffffff08" stroke-width="8"/>
          <circle cx="95" cy="95" r="${rS}" fill="none" stroke="#ffffff08" stroke-width="8"/>
          <!-- Progress arcs -->
          <circle id="tt-arc-h" cx="95" cy="95" r="${rH}" fill="none" stroke="#60a5fa" stroke-width="8" stroke-linecap="round"
            style="stroke-dasharray:${cH};stroke-dashoffset:${cH};transition:stroke-dashoffset .5s linear"/>
          <circle id="tt-arc-m" cx="95" cy="95" r="${rM}" fill="none" stroke="#4ade80" stroke-width="8" stroke-linecap="round"
            style="stroke-dasharray:${cM};stroke-dashoffset:${cM};transition:stroke-dashoffset .5s linear"/>
          <circle id="tt-arc-s" cx="95" cy="95" r="${rS}" fill="none" stroke="#f472b6" stroke-width="8" stroke-linecap="round"
            style="stroke-dasharray:${cS};stroke-dashoffset:${cS};transition:stroke-dashoffset .15s linear"/>
        </svg>
        <!-- Center digits -->
        <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
          <div style="display:flex;gap:2px;align-items:baseline">
            <div style="text-align:center">
              <div id="tt-ring-h" style="font-size:20px;font-weight:900;font-variant-numeric:tabular-nums;color:#60a5fa;line-height:1">00</div>
              <div style="font-size:8px;color:#60a5fa80;letter-spacing:.06em">HRS</div>
            </div>
            <div style="font-size:16px;font-weight:900;color:#ffffff40;margin:0 1px;padding-bottom:10px">:</div>
            <div style="text-align:center">
              <div id="tt-ring-m" style="font-size:20px;font-weight:900;font-variant-numeric:tabular-nums;color:#4ade80;line-height:1">00</div>
              <div style="font-size:8px;color:#4ade8080;letter-spacing:.06em">MIN</div>
            </div>
            <div style="font-size:16px;font-weight:900;color:#ffffff40;margin:0 1px;padding-bottom:10px">:</div>
            <div style="text-align:center">
              <div id="tt-ring-s" style="font-size:20px;font-weight:900;font-variant-numeric:tabular-nums;color:#f472b6;line-height:1">00</div>
              <div style="font-size:8px;color:#f472b680;letter-spacing:.06em">SEC</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Ring legend -->
      <div style="display:flex;flex-direction:column;gap:5px;margin-bottom:16px;width:100%">
        ${[['#60a5fa','Hours'],['#4ade80','Minutes'],['#f472b6','Seconds']].map(([c,l]) => `
          <div style="display:flex;align-items:center;gap:7px">
            <div style="width:10px;height:10px;border-radius:50%;background:${c};flex-shrink:0"></div>
            <span style="font-size:10px;color:var(--gw-muted,#9a9a8a)">${l}</span>
          </div>`).join('')}
      </div>

      <!-- Job type pill (when clocked in) -->
      ${isClockedIn && st.activeEntry?.job_type ? `
        <div style="padding:5px 10px;border-radius:20px;background:#2563EB20;border:1px solid #2563EB40;font-size:10px;font-weight:700;color:#60a5fa;margin-bottom:14px;max-width:100%;text-overflow:ellipsis;overflow:hidden;white-space:nowrap">
          ${ttE(st.activeEntry.job_type)}
        </div>` : ''}

      <!-- Action buttons -->
      <div style="display:flex;flex-direction:column;gap:8px;width:100%" id="tt-ring-actions">
        ${isClockedIn ? `
          <button onclick="ttShowClockOutModal()" style="width:100%;padding:11px 0;background:linear-gradient(135deg,#dc2626,#991b1b);border:none;border-radius:10px;color:#fff;font-size:13px;font-weight:800;cursor:pointer;box-shadow:0 4px 14px #dc262640;letter-spacing:.02em">
            ■ Clock Out
          </button>
          <button onclick="ttShowBreakModal()" style="width:100%;padding:9px 0;background:#1e40af22;border:1px solid #3b82f640;border-radius:10px;color:#93c5fd;font-size:12px;font-weight:700;cursor:pointer">
            ⏸ Start Break
          </button>
          <button onclick="ttShowSwitchModal()" style="width:100%;padding:9px 0;background:#5b21b622;border:1px solid #8b5cf640;border-radius:10px;color:#c4b5fd;font-size:12px;font-weight:700;cursor:pointer">
            ⇄ Switch Task
          </button>
        ` : `
          <button onclick="ttShowClockInModal()" style="width:100%;padding:11px 0;background:linear-gradient(135deg,#22c55e,#16a34a);border:none;border-radius:10px;color:#fff;font-size:13px;font-weight:800;cursor:pointer;box-shadow:0 4px 14px #22c55e40;letter-spacing:.02em">
            ▶ Clock In
          </button>
          <button onclick="ttShowManualModal()" style="width:100%;padding:9px 0;background:var(--gw-surface,#141f1a);border:1px solid var(--gw-line,#2a3a30);border-radius:10px;color:var(--gw-muted,#9a9a8a);font-size:12px;font-weight:700;cursor:pointer">
            + Add Entry
          </button>
        `}
      </div>

      <!-- Today summary -->
      <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--gw-line,#2a3a30);width:100%">
        <div style="font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--gw-muted,#9a9a8a);text-transform:uppercase;margin-bottom:10px">Today</div>
        <div id="tt-today-summary" style="display:flex;flex-direction:column;gap:7px">
          <div style="text-align:center;font-size:10px;color:var(--gw-muted,#9a9a8a)">Loading…</div>
        </div>
      </div>

      <!-- Week progress bar -->
      <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--gw-line,#2a3a30);width:100%">
        <div style="font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--gw-muted,#9a9a8a);text-transform:uppercase;margin-bottom:8px">This Week</div>
        <div id="tt-week-progress-wrap">
          <div style="height:6px;background:#ffffff10;border-radius:3px;overflow:hidden;margin-bottom:6px">
            <div id="tt-week-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#4ade80,#22d3ee);border-radius:3px;transition:width 1s ease"></div>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--gw-muted,#9a9a8a)">
            <span id="tt-week-total">0h 00m</span>
            <span style="opacity:.5">Goal: 40h</span>
          </div>
        </div>
      </div>
    </div>`;
}

async function ttLoadRingPanelData() {
  try {
    const res = await fetch('/api/time/entries?period=week', { credentials:'include' });
    const j   = await res.json();
    if (!j.ok) return;

    const entries = j.data || [];
    const today = new Date().toISOString().slice(0,10);

    // Today entries
    const todayEntries = entries.filter(e => (e.clock_in||'').slice(0,10) === today);
    const todayMin = todayEntries.reduce((s,e) => s + (e.duration_min || 0), 0);

    // Week total
    const weekMin = entries.reduce((s,e) => s + (e.duration_min || 0), 0);
    const weekGoal = 40 * 60;
    const weekPct = Math.min(100, (weekMin / weekGoal * 100)).toFixed(1);

    // Job breakdown today
    const byJob = {};
    todayEntries.forEach(e => {
      const j = e.job_type || 'General Work';
      byJob[j] = (byJob[j] || 0) + (e.duration_min || 0);
    });

    const todaySummEl = document.getElementById('tt-today-summary');
    if (todaySummEl) {
      if (todayMin === 0) {
        todaySummEl.innerHTML = `<div style="text-align:center;font-size:11px;color:var(--gw-muted,#9a9a8a)">No time logged</div>`;
      } else {
        todaySummEl.innerHTML = `
          <div style="font-size:22px;font-weight:900;color:var(--gw-text,#E8E4D9);text-align:center;margin-bottom:6px">${ttFmt(todayMin)}</div>
          ${Object.entries(byJob).slice(0,3).map(([job, min]) => {
            const col = ttColorForJob(job);
            return `<div style="display:flex;align-items:center;gap:6px">
              <div style="width:8px;height:8px;border-radius:50%;background:${col.border};flex-shrink:0"></div>
              <span style="font-size:10px;color:var(--gw-muted,#9a9a8a);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${ttE(job)}</span>
              <span style="font-size:10px;font-weight:700;color:var(--gw-text,#E8E4D9)">${ttFmt(min)}</span>
            </div>`;
          }).join('')}`;
      }
    }

    const weekBarEl = document.getElementById('tt-week-bar');
    const weekTotalEl = document.getElementById('tt-week-total');
    if (weekBarEl) weekBarEl.style.width = weekPct + '%';
    if (weekTotalEl) weekTotalEl.textContent = ttFmt(weekMin);
  } catch { /* ignore */ }
}

function ttShowSwitchModal() { ttToast('Switch task: clock out first, then clock in to a new task.'); }

// ─────────────────────────────────────────────────────────────────────────────
//  TAB 1: MY TIMESHEET
// ─────────────────────────────────────────────────────────────────────────────
async function ttLoadTimesheet() {
  const st = window._ttState;
  const container = document.getElementById('tt-tab-content');
  const headerActions = document.getElementById('tt-header-actions');
  if (!container) return;

  // Set header actions
  if (headerActions) {
    const { from, to, label } = ttWeekRange(st.weekOffset);
    headerActions.innerHTML = `
      <button onclick="window._ttState.weekOffset--;ttLoadTimesheet()" style="${ttNavBtnStyle()}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
      </button>
      <span style="font-size:12px;font-weight:700;color:var(--gw-text,#E8E4D9);white-space:nowrap">${label}</span>
      <button onclick="window._ttState.weekOffset++;ttLoadTimesheet()" style="${ttNavBtnStyle()}" ${st.weekOffset >= 0 ? 'disabled style="'+ttNavBtnStyle()+';opacity:.3"' : ''}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
      </button>
      <button onclick="window._ttState.weekOffset=0;ttLoadTimesheet()" style="${ttSecondaryBtnStyle()}">Today</button>
      <button onclick="ttExportCSV()" style="${ttSecondaryBtnStyle()}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
        Export
      </button>`;
  }

  container.innerHTML = `<div style="text-align:center;padding:40px;color:var(--gw-muted,#9a9a8a)">
    <div style="width:28px;height:28px;border:3px solid #4ade8030;border-top-color:#4ade80;border-radius:50%;animation:tt-spin 1s linear infinite;margin:0 auto 12px"></div>
    Loading…
  </div>`;

  try {
    const { from, to } = ttWeekRange(st.weekOffset);
    const res = await fetch(`/api/time/entries?from=${from}&to=${to}`, { credentials:'include' });
    const j   = await res.json();
    const entries = j.ok ? (j.data || []) : [];
    st.allEntries = entries;

    // Init selected date if needed
    if (!st.selectedDate) st.selectedDate = from;

    container.innerHTML = ttBuildTimesheetHTML(entries, st.weekOffset);
    ttLoadRingPanelData();
  } catch(e) {
    container.innerHTML = `<div style="padding:20px;color:#f87171">Error loading entries: ${ttE(e.message)}</div>`;
  }
}

function ttNavBtnStyle() {
  return 'padding:7px 10px;background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:8px;color:var(--gw-text,#E8E4D9);cursor:pointer;display:inline-flex;align-items:center;gap:4px';
}
function ttSecondaryBtnStyle() {
  return 'padding:7px 12px;background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:8px;color:var(--gw-muted,#9a9a8a);cursor:pointer;font-size:11px;font-weight:600;display:inline-flex;align-items:center;gap:5px';
}

function ttBuildTimesheetHTML(entries, offset) {
  const days = ttDaysInWeek(offset);
  const st = window._ttState;
  const selDate = st.selectedDate || days[0].toISOString().slice(0,10);

  // Map entries by date
  const byDate = {};
  days.forEach(d => { byDate[d.toISOString().slice(0,10)] = []; });
  entries.forEach(e => {
    const key = (e.clock_in||'').slice(0,10);
    if (byDate[key]) byDate[key].push(e);
  });

  // Daily totals
  const dayTotals = {};
  days.forEach(d => {
    const key = d.toISOString().slice(0,10);
    dayTotals[key] = byDate[key].reduce((s,e) => s + (e.duration_min||0), 0);
  });
  const weekTotal = Object.values(dayTotals).reduce((a,b) => a+b, 0);

  // Job type breakdown for stacked bar
  const jobTotals = {};
  entries.forEach(e => {
    const j = e.job_type || 'General Work';
    jobTotals[j] = (jobTotals[j] || 0) + (e.duration_min || 0);
  });

  const selEntries = byDate[selDate] || [];
  const selTotal   = dayTotals[selDate] || 0;

  return `
    <!-- Date Slider -->
    <div style="margin-bottom:18px">
      ${ttBuildDateSlider(offset, selDate)}
    </div>

    <!-- Two-column layout: daily entries + week grid -->
    <div style="display:grid;grid-template-columns:1fr 200px;gap:16px;align-items:start">

      <!-- Left: Day entries -->
      <div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <div>
            <div style="font-size:13px;font-weight:800;color:var(--gw-text,#E8E4D9)">${ttFmtDateFull(new Date(selDate + 'T12:00:00'))}</div>
            <div style="font-size:11px;color:var(--gw-muted,#9a9a8a);margin-top:2px">${selEntries.length} ${selEntries.length===1?'entry':'entries'} · ${ttFmt(selTotal)}</div>
          </div>
          <button onclick="ttShowManualModalForDate('${selDate}')" style="padding:8px 14px;background:linear-gradient(135deg,#2563EB,#1d4ed8);border:none;border-radius:8px;color:#fff;font-size:12px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:5px;box-shadow:0 2px 8px #2563eb40">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            Add Entry
          </button>
        </div>

        ${selEntries.length === 0 ? `
          <div style="text-align:center;padding:32px 20px;background:var(--gw-surface-2,#1a2820);border:2px dashed var(--gw-line,#2a3a30);border-radius:14px">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--gw-muted,#9a9a8a)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom:10px"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <div style="font-size:13px;font-weight:600;color:var(--gw-muted,#9a9a8a);margin-bottom:4px">No time logged</div>
            <div style="font-size:11px;color:var(--gw-muted,#9a9a8a);opacity:.6">Click "Add Entry" or Clock In to start</div>
          </div>
        ` : `
          <div style="display:flex;flex-direction:column;gap:8px">
            ${selEntries.map(e => ttBuildEntryCard(e)).join('')}
          </div>`}
      </div>

      <!-- Right: Week Summary Grid -->
      <div style="background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:14px;padding:14px;position:sticky;top:0">
        <div style="font-size:11px;font-weight:700;letter-spacing:.05em;color:var(--gw-muted,#9a9a8a);text-transform:uppercase;margin-bottom:12px">Week Summary</div>
        <div style="font-size:24px;font-weight:900;color:var(--gw-text,#E8E4D9);margin-bottom:4px">${ttFmt(weekTotal)}</div>
        <div style="font-size:10px;color:var(--gw-muted,#9a9a8a);margin-bottom:14px">${ttFmtDecimal(weekTotal)} hrs billed</div>

        <!-- Daily bars -->
        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">
          ${days.map(d => {
            const key = d.toISOString().slice(0,10);
            const min = dayTotals[key] || 0;
            const pct = weekTotal > 0 ? (min / Math.max(...Object.values(dayTotals), 1) * 100) : 0;
            const isToday = ttIsToday(d);
            const isSel = key === selDate;
            const dayLbl = d.toLocaleDateString('en-US',{weekday:'short'});
            return `
              <div onclick="ttSelectDate('${key}')" style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:4px 6px;border-radius:6px;background:${isSel?'#2563EB15':'transparent'};transition:background .1s">
                <div style="font-size:10px;font-weight:${isToday?'800':'500'};color:${isToday?'#4ade80':isSel?'#60a5fa':'var(--gw-muted,#9a9a8a)'};width:26px;flex-shrink:0">${dayLbl}</div>
                <div style="flex:1;height:6px;background:#ffffff0a;border-radius:3px;overflow:hidden">
                  <div style="height:100%;width:${pct}%;background:${isSel?'#2563EB':'#4ade80'};border-radius:3px;transition:width .5s ease"></div>
                </div>
                <div style="font-size:10px;font-weight:700;color:${min>0?'var(--gw-text,#E8E4D9)':'var(--gw-muted,#9a9a8a)'};width:42px;text-align:right;flex-shrink:0">${min>0?ttFmt(min):'—'}</div>
              </div>`;
          }).join('')}
        </div>

        <!-- Job type breakdown -->
        ${Object.entries(jobTotals).length > 0 ? `
          <div style="border-top:1px solid var(--gw-line,#2a3a30);padding-top:12px">
            <div style="font-size:10px;font-weight:700;letter-spacing:.05em;color:var(--gw-muted,#9a9a8a);text-transform:uppercase;margin-bottom:8px">By Job Type</div>
            ${Object.entries(jobTotals).slice(0,5).map(([job,min]) => {
              const col = ttColorForJob(job);
              const pct = weekTotal > 0 ? (min/weekTotal*100).toFixed(0) : 0;
              return `
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
                  <div style="width:8px;height:8px;border-radius:50%;background:${col.border};flex-shrink:0"></div>
                  <div style="font-size:9px;color:var(--gw-muted,#9a9a8a);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${ttE(job)}</div>
                  <div style="font-size:9px;font-weight:700;color:var(--gw-text,#E8E4D9)">${pct}%</div>
                </div>`;
            }).join('')}
          </div>` : ''}

        <!-- Stacked bar -->
        ${weekTotal > 0 ? `
          <div style="height:8px;border-radius:4px;overflow:hidden;display:flex;margin-top:8px">
            ${Object.entries(jobTotals).map(([job,min]) => {
              const col = ttColorForJob(job);
              const pct = (min/weekTotal*100).toFixed(1);
              return `<div style="width:${pct}%;background:${col.border};flex-shrink:0" title="${job}: ${ttFmt(min)}"></div>`;
            }).join('')}
          </div>` : ''}
      </div>
    </div>`;
}

function ttBuildEntryCard(e) {
  const col = ttColorForJob(e.job_type);
  const isOpen = !e.clock_out;
  const approvalBadge = e.approved === 1
    ? `<span style="font-size:9px;font-weight:700;color:#4ade80;background:#4ade8015;border:1px solid #4ade8030;border-radius:20px;padding:2px 7px">✓ Approved</span>`
    : e.approved === 2
    ? `<span style="font-size:9px;font-weight:700;color:#f87171;background:#f8717115;border:1px solid #f8717130;border-radius:20px;padding:2px 7px">✗ Rejected</span>`
    : `<span style="font-size:9px;font-weight:700;color:#fbbf24;background:#fbbf2415;border:1px solid #fbbf2430;border-radius:20px;padding:2px 7px">⏳ Pending</span>`;

  return `
    <div style="background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:12px;padding:12px 14px;transition:border-color .15s;position:relative;overflow:hidden"
      onmouseover="this.style.borderColor='${col.border}40'" onmouseout="this.style.borderColor='var(--gw-line,#2a3a30)'">
      <!-- Left accent bar -->
      <div style="position:absolute;left:0;top:0;bottom:0;width:3px;background:${col.border};border-radius:12px 0 0 12px"></div>
      <div style="padding-left:8px">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:8px">
          <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">
            <!-- Job type pill -->
            <span style="font-size:10px;font-weight:700;color:${col.text};background:${col.bg};border:1px solid ${col.border}50;border-radius:20px;padding:2px 8px">${ttE(e.job_type||'General Work')}</span>
            ${isOpen ? `<span style="font-size:9px;font-weight:800;color:#4ade80;background:#4ade8010;border:1px solid #4ade8030;border-radius:20px;padding:2px 7px;animation:tt-pulse 2s infinite">● Live</span>` : ''}
            ${approvalBadge}
          </div>
          <div style="display:flex;gap:5px;flex-shrink:0">
            <button onclick="ttEditEntry('${ttE(e.id)}')" style="padding:4px 8px;background:transparent;border:1px solid var(--gw-line,#2a3a30);border-radius:6px;color:var(--gw-muted,#9a9a8a);font-size:10px;font-weight:600;cursor:pointer">Edit</button>
            <button onclick="ttDeleteEntry('${ttE(e.id)}')" style="padding:4px 8px;background:transparent;border:1px solid #f8717130;border-radius:6px;color:#f87171;font-size:10px;font-weight:600;cursor:pointer">✕</button>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:12px">
          <div>
            <div style="font-size:18px;font-weight:900;color:var(--gw-text,#E8E4D9);font-variant-numeric:tabular-nums">${isOpen ? `<span id="tt-entry-timer-${ttE(e.id)}" style="color:#4ade80">${ttElapsedStr(e.clock_in)}</span>` : ttFmt(e.duration_min)}</div>
            <div style="font-size:10px;color:var(--gw-muted,#9a9a8a);margin-top:1px">${ttFmtTime(e.clock_in)} → ${isOpen ? 'Now' : ttFmtTime(e.clock_out)}</div>
          </div>
          ${e.notes ? `<div style="font-size:11px;color:var(--gw-muted,#9a9a8a);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-left:1px solid var(--gw-line,#2a3a30);padding-left:12px">${ttE(e.notes)}</div>` : ''}
        </div>
      </div>
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  MANUAL ENTRY MODAL
// ─────────────────────────────────────────────────────────────────────────────
function ttShowManualModal() {
  const today = new Date().toISOString().slice(0,10);
  ttShowManualModalForDate(today);
}

function ttShowManualModalForDate(date) {
  const jobOpts = TT_JOB_TYPES.map(j => `<option value="${ttE(j)}">${ttE(j)}</option>`).join('');
  const startVal = `${date}T09:00`;
  const endVal   = `${date}T17:00`;

  ttShowModal(`
    <div style="padding:24px 24px 20px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:18px">
        <div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#2563EB,#1d4ed8);display:flex;align-items:center;justify-content:center">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
        </div>
        <div style="font-size:15px;font-weight:800;color:var(--gw-text,#E8E4D9)">Add Time Entry</div>
      </div>

      <!-- Increment buttons -->
      <div style="margin-bottom:14px">
        <label style="font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--gw-muted,#9a9a8a);text-transform:uppercase;display:block;margin-bottom:8px">Quick Adjust Duration</label>
        <div style="display:flex;gap:6px">
          ${['-1h','-15m','+15m','+1h'].map(lbl => `
            <button onclick="ttAdjustTime('${lbl}')" style="flex:1;padding:8px 6px;background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:8px;color:var(--gw-text,#E8E4D9);font-size:11px;font-weight:700;cursor:pointer;transition:all .1s"
              onmouseover="this.style.background='#2563EB20';this.style.borderColor='#2563EB50'"
              onmouseout="this.style.background='var(--gw-surface-2,#1a2820)';this.style.borderColor='var(--gw-line,#2a3a30)'">${lbl}</button>`).join('')}
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
        <div>
          <label style="font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--gw-muted,#9a9a8a);text-transform:uppercase;display:block;margin-bottom:5px">Start</label>
          <input type="datetime-local" id="tt-me-start" value="${startVal}" style="width:100%;padding:8px 10px;background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:8px;color:var(--gw-text,#E8E4D9);font-size:12px;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--gw-muted,#9a9a8a);text-transform:uppercase;display:block;margin-bottom:5px">End</label>
          <input type="datetime-local" id="tt-me-end" value="${endVal}" style="width:100%;padding:8px 10px;background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:8px;color:var(--gw-text,#E8E4D9);font-size:12px;box-sizing:border-box">
        </div>
      </div>
      <div style="margin-bottom:12px">
        <label style="font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--gw-muted,#9a9a8a);text-transform:uppercase;display:block;margin-bottom:5px">Job Type</label>
        <select id="tt-me-job" style="width:100%;padding:8px 10px;background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:8px;color:var(--gw-text,#E8E4D9);font-size:13px;font-weight:600">${jobOpts}</select>
      </div>

      <!-- Tag pills -->
      <div style="margin-bottom:12px">
        <label style="font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--gw-muted,#9a9a8a);text-transform:uppercase;display:block;margin-bottom:6px">Tags</label>
        <div style="display:flex;flex-wrap:wrap;gap:5px" id="tt-me-tags">
          ${['Billable','Internal','Overtime','Remote','On-site'].map(tag => `
            <button onclick="this.classList.toggle('active');this.style.background=this.classList.contains('active')?'#2563EB':'var(--gw-surface-2,#1a2820)';this.style.color=this.classList.contains('active')?'#fff':'var(--gw-muted,#9a9a8a)';this.style.borderColor=this.classList.contains('active')?'#2563EB':'var(--gw-line,#2a3a30)'"
              style="padding:4px 10px;border-radius:20px;border:1px solid var(--gw-line,#2a3a30);background:var(--gw-surface-2,#1a2820);color:var(--gw-muted,#9a9a8a);font-size:11px;font-weight:600;cursor:pointer;transition:all .1s" data-tag="${ttE(tag)}">${ttE(tag)}</button>`).join('')}
        </div>
      </div>

      <div style="margin-bottom:14px">
        <label style="font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--gw-muted,#9a9a8a);text-transform:uppercase;display:block;margin-bottom:5px">Notes</label>
        <textarea id="tt-me-notes" rows="2" style="width:100%;padding:8px 10px;background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:8px;color:var(--gw-text,#E8E4D9);font-size:12px;resize:vertical;font-family:inherit;box-sizing:border-box" placeholder="Optional notes…"></textarea>
      </div>
      <div style="display:flex;gap:8px">
        <button onclick="ttCloseModal()" style="flex:1;padding:10px;background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:8px;color:var(--gw-muted,#9a9a8a);font-size:13px;font-weight:600;cursor:pointer">Cancel</button>
        <button onclick="ttDoManualEntry()" style="flex:2;padding:10px;background:linear-gradient(135deg,#2563EB,#1d4ed8);border:none;border-radius:8px;color:#fff;font-size:13px;font-weight:700;cursor:pointer">Save Entry</button>
      </div>
    </div>`);
}

function ttAdjustTime(amt) {
  const endEl = document.getElementById('tt-me-end');
  if (!endEl || !endEl.value) return;
  const d = new Date(endEl.value);
  const mins = amt === '-1h' ? -60 : amt === '-15m' ? -15 : amt === '+15m' ? 15 : 60;
  d.setMinutes(d.getMinutes() + mins);
  const pad = n => String(n).padStart(2,'0');
  endEl.value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function ttDoManualEntry() {
  const startVal = document.getElementById('tt-me-start')?.value;
  const endVal   = document.getElementById('tt-me-end')?.value;
  const job      = document.getElementById('tt-me-job')?.value || 'General Work';
  const notes    = document.getElementById('tt-me-notes')?.value || '';
  if (!startVal || !endVal) { ttToast('Please set start and end time'); return; }

  const clockIn  = new Date(startVal).toISOString();
  const clockOut = new Date(endVal).toISOString();

  try {
    // Clock in then immediately clock out
    const r1 = await fetch('/api/time/clock-in', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ jobType: job, clockIn, notes })
    });
    const j1 = await r1.json();
    if (!j1.ok) { ttToast(j1.error || 'Failed to save'); return; }

    const r2 = await fetch(`/api/time/clock-out/${j1.data.id}`, {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ clockOut, jobType: job, notes })
    });
    const j2 = await r2.json();
    if (j2.ok) {
      ttCloseModal();
      ttToast('Entry saved ✓');
      ttLoadTimesheet();
    } else { ttToast(j2.error || 'Failed to save'); }
  } catch { ttToast('Network error'); }
}

// Edit entry
async function ttEditEntry(id) {
  const entry = window._ttState.allEntries.find(e => e.id === id)
             || window._ttState.teamEntries.find(e => e.id === id);
  if (!entry) { ttToast('Entry not found'); return; }

  const pad = n => String(n).padStart(2,'0');
  const toLocal = iso => {
    if (!iso) return '';
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const jobOpts = TT_JOB_TYPES.map(j => `<option value="${ttE(j)}" ${j===entry.job_type?'selected':''}>${ttE(j)}</option>`).join('');

  ttShowModal(`
    <div style="padding:24px 24px 20px">
      <div style="font-size:15px;font-weight:800;color:var(--gw-text,#E8E4D9);margin-bottom:16px">Edit Entry</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
        <div>
          <label style="font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--gw-muted,#9a9a8a);text-transform:uppercase;display:block;margin-bottom:5px">Start</label>
          <input type="datetime-local" id="tt-ed-start" value="${toLocal(entry.clock_in)}" style="width:100%;padding:8px 10px;background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:8px;color:var(--gw-text,#E8E4D9);font-size:12px;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--gw-muted,#9a9a8a);text-transform:uppercase;display:block;margin-bottom:5px">End</label>
          <input type="datetime-local" id="tt-ed-end" value="${toLocal(entry.clock_out)}" style="width:100%;padding:8px 10px;background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:8px;color:var(--gw-text,#E8E4D9);font-size:12px;box-sizing:border-box">
        </div>
      </div>
      <!-- Increment buttons -->
      <div style="display:flex;gap:5px;margin-bottom:10px">
        ${['-1h','-15m','+15m','+1h'].map(lbl => `
          <button onclick="ttAdjustTimeEd('${lbl}')" style="flex:1;padding:7px 4px;background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:7px;color:var(--gw-text,#E8E4D9);font-size:10px;font-weight:700;cursor:pointer">${lbl}</button>`).join('')}
      </div>
      <div style="margin-bottom:10px">
        <label style="font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--gw-muted,#9a9a8a);text-transform:uppercase;display:block;margin-bottom:5px">Job Type</label>
        <select id="tt-ed-job" style="width:100%;padding:8px 10px;background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:8px;color:var(--gw-text,#E8E4D9);font-size:13px">${jobOpts}</select>
      </div>
      <div style="margin-bottom:14px">
        <label style="font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--gw-muted,#9a9a8a);text-transform:uppercase;display:block;margin-bottom:5px">Notes</label>
        <textarea id="tt-ed-notes" rows="2" style="width:100%;padding:8px 10px;background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:8px;color:var(--gw-text,#E8E4D9);font-size:12px;resize:vertical;font-family:inherit;box-sizing:border-box">${ttE(entry.notes||'')}</textarea>
      </div>
      <div style="display:flex;gap:8px">
        <button onclick="ttCloseModal()" style="flex:1;padding:10px;background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:8px;color:var(--gw-muted,#9a9a8a);font-size:13px;font-weight:600;cursor:pointer">Cancel</button>
        <button onclick="ttDoEditEntry('${ttE(id)}')" style="flex:2;padding:10px;background:linear-gradient(135deg,#2563EB,#1d4ed8);border:none;border-radius:8px;color:#fff;font-size:13px;font-weight:700;cursor:pointer">Save Changes</button>
      </div>
    </div>`);
}

function ttAdjustTimeEd(amt) {
  const endEl = document.getElementById('tt-ed-end');
  if (!endEl || !endEl.value) return;
  const d = new Date(endEl.value);
  const mins = amt === '-1h' ? -60 : amt === '-15m' ? -15 : amt === '+15m' ? 15 : 60;
  d.setMinutes(d.getMinutes() + mins);
  const pad = n => String(n).padStart(2,'0');
  endEl.value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function ttDoEditEntry(id) {
  const startVal = document.getElementById('tt-ed-start')?.value;
  const endVal   = document.getElementById('tt-ed-end')?.value;
  const job      = document.getElementById('tt-ed-job')?.value;
  const notes    = document.getElementById('tt-ed-notes')?.value || '';

  try {
    const body = { jobType: job, notes };
    if (startVal) body.clockIn = new Date(startVal).toISOString();
    if (endVal)   body.clockOut = new Date(endVal).toISOString();

    const res = await fetch(`/api/time/entries/${id}`, {
      method:'PUT', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    const j = await res.json();
    if (j.ok) {
      ttCloseModal();
      ttToast('Entry updated ✓');
      ttRefreshCurrent();
    } else { ttToast(j.error || 'Could not update'); }
  } catch { ttToast('Network error'); }
}

async function ttDeleteEntry(id) {
  if (!confirm('Delete this time entry?')) return;
  try {
    const res = await fetch(`/api/time/entries/${id}`, { method:'DELETE', credentials:'include' });
    const j   = await res.json();
    if (j.ok) { ttToast('Entry deleted'); ttRefreshCurrent(); }
    else ttToast(j.error || 'Could not delete');
  } catch { ttToast('Network error'); }
}

// ─────────────────────────────────────────────────────────────────────────────
//  TAB 2: CALENDAR VIEW (Harvest/Toggl style)
// ─────────────────────────────────────────────────────────────────────────────
async function ttLoadCalendar() {
  const st = window._ttState;
  const container = document.getElementById('tt-tab-content');
  const headerActions = document.getElementById('tt-header-actions');
  if (!container) return;

  const { from, to, label } = ttWeekRange(st.calOffset);

  if (headerActions) {
    headerActions.innerHTML = `
      <button onclick="window._ttState.calOffset--;ttLoadCalendar()" style="${ttNavBtnStyle()}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
      </button>
      <span style="font-size:12px;font-weight:700;color:var(--gw-text,#E8E4D9);white-space:nowrap">${label}</span>
      <button onclick="window._ttState.calOffset++;ttLoadCalendar()" style="${ttNavBtnStyle()}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
      </button>
      <button onclick="window._ttState.calOffset=0;ttLoadCalendar()" style="${ttSecondaryBtnStyle()}">This Week</button>`;
  }

  container.innerHTML = `<div style="text-align:center;padding:40px;color:var(--gw-muted,#9a9a8a)">
    <div style="width:28px;height:28px;border:3px solid #4ade8030;border-top-color:#4ade80;border-radius:50%;animation:tt-spin 1s linear infinite;margin:0 auto 12px"></div>
    Loading calendar…
  </div>`;

  try {
    const res = await fetch(`/api/time/entries?from=${from}&to=${to}`, { credentials:'include' });
    const j   = await res.json();
    const entries = j.ok ? (j.data || []) : [];
    st.calEntries = entries;
    container.innerHTML = ttBuildCalendarHTML(entries, st.calOffset);
    ttLoadRingPanelData();
  } catch(e) {
    container.innerHTML = `<div style="padding:20px;color:#f87171">Error: ${ttE(e.message)}</div>`;
  }
}

function ttBuildCalendarHTML(entries, offset) {
  const days = ttDaysInWeek(offset);
  const HOURS = Array.from({length:13}, (_,i) => i + 7); // 7am to 7pm

  // Map entries by day
  const byDay = {};
  days.forEach(d => { byDay[d.toISOString().slice(0,10)] = []; });
  entries.forEach(e => {
    const key = (e.clock_in||'').slice(0,10);
    if (byDay[key]) byDay[key].push(e);
  });

  // Daily totals
  const dayTotals = {};
  days.forEach(d => {
    const key = d.toISOString().slice(0,10);
    dayTotals[key] = byDay[key].reduce((s,e) => s + (e.duration_min||0), 0);
  });

  const weekTotal = Object.values(dayTotals).reduce((a,b)=>a+b,0);

  // Col width
  const colW = 100 / (days.length + 1); // +1 for time column

  return `
    <div style="overflow-x:auto">
      <!-- Week total bar -->
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:10px;margin-bottom:14px">
        <div style="font-size:12px;color:var(--gw-muted,#9a9a8a)">Week Total</div>
        <div style="font-size:16px;font-weight:900;color:var(--gw-text,#E8E4D9)">${ttFmt(weekTotal)}</div>
      </div>

      <div style="display:grid;grid-template-columns:50px ${days.map(()=>'1fr').join(' ')};border:1px solid var(--gw-line,#2a3a30);border-radius:12px;overflow:hidden;background:var(--gw-surface-2,#1a2820);min-width:600px">
        <!-- Header row -->
        <div style="background:var(--gw-surface,#141f1a);border-bottom:1px solid var(--gw-line,#2a3a30);padding:10px 6px;text-align:center">
          <div style="font-size:9px;color:var(--gw-muted,#9a9a8a)">TIME</div>
        </div>
        ${days.map(d => {
          const iso = d.toISOString().slice(0,10);
          const isToday = ttIsToday(d);
          const tot = dayTotals[iso] || 0;
          return `
            <div style="background:${isToday?'#4ade8008':'var(--gw-surface,#141f1a)'};border-bottom:1px solid var(--gw-line,#2a3a30);border-left:1px solid var(--gw-line,#2a3a30);padding:10px 8px;text-align:center">
              <div style="font-size:10px;font-weight:700;color:${isToday?'#4ade80':'var(--gw-muted,#9a9a8a)'}">${d.toLocaleDateString('en-US',{weekday:'short'})}</div>
              <div style="font-size:16px;font-weight:900;color:${isToday?'#4ade80':'var(--gw-text,#E8E4D9)'}">${d.getDate()}</div>
              <div style="font-size:10px;color:var(--gw-muted,#9a9a8a);margin-top:2px">${tot > 0 ? ttFmt(tot) : '—'}</div>
            </div>`;
        }).join('')}

        <!-- Hour rows -->
        ${HOURS.map(hour => {
          const label12 = hour > 12 ? `${hour-12} PM` : hour === 12 ? `12 PM` : `${hour} AM`;
          return `
            <div style="border-top:1px solid var(--gw-line,#2a3a30);padding:0 4px;display:flex;align-items:flex-start;justify-content:flex-end;padding-top:6px;min-height:56px">
              <span style="font-size:9px;color:var(--gw-muted,#9a9a8a);white-space:nowrap">${label12}</span>
            </div>
            ${days.map(d => {
              const iso = d.toISOString().slice(0,10);
              const dayEntries = byDay[iso] || [];
              // Find entries that overlap this hour
              const hourEntries = dayEntries.filter(e => {
                if (!e.clock_in) return false;
                const eStart = new Date(e.clock_in);
                const eEnd   = e.clock_out ? new Date(e.clock_out) : new Date();
                return eStart.getHours() <= hour && eEnd.getHours() >= hour;
              });

              return `
                <div style="border-top:1px solid var(--gw-line,#2a3a30);border-left:1px solid var(--gw-line,#2a3a30);min-height:56px;position:relative;padding:3px">
                  ${hourEntries.map(e => {
                    const col = ttColorForJob(e.job_type);
                    const isOpen = !e.clock_out;
                    // Position within hour (rough)
                    const startH = new Date(e.clock_in).getHours();
                    const startM = new Date(e.clock_in).getMinutes();
                    const topOffset = startH === hour ? Math.round(startM / 60 * 100) : 0;
                    return `
                      <div onclick="ttEditEntry('${ttE(e.id)}')" style="position:relative;margin-top:${topOffset}%;padding:4px 6px;background:${col.bg};border-left:3px solid ${col.border};border-radius:0 5px 5px 0;cursor:pointer;font-size:9px;font-weight:700;color:${col.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 3px rgba(0,0,0,.1)"
                        title="${ttE(e.job_type)} · ${ttFmt(e.duration_min)}">
                        ${ttE(e.job_type||'General Work')} ${isOpen ? '●' : ''}
                        ${e.duration_min ? `<span style="opacity:.7">· ${ttFmt(e.duration_min)}</span>` : ''}
                      </div>`;
                  }).join('')}
                </div>`;
            }).join('')}`;
        }).join('')}
      </div>
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  TAB 3: PAYROLL HUB
// ─────────────────────────────────────────────────────────────────────────────
async function ttLoadPayroll() {
  const st = window._ttState;
  const container = document.getElementById('tt-tab-content');
  const headerActions = document.getElementById('tt-header-actions');
  if (!container) return;

  const { from, to, label } = ttWeekRange(st.payrollOffset);
  if (headerActions) {
    headerActions.innerHTML = `
      <button onclick="window._ttState.payrollOffset--;ttLoadPayroll()" style="${ttNavBtnStyle()}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
      </button>
      <span style="font-size:12px;font-weight:700;color:var(--gw-text,#E8E4D9);white-space:nowrap">${label}</span>
      <button onclick="window._ttState.payrollOffset++;ttLoadPayroll()" style="${ttNavBtnStyle()}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
      </button>
      <button onclick="window._ttState.payrollOffset=0;ttLoadPayroll()" style="${ttSecondaryBtnStyle()}">This Week</button>
      <button onclick="ttExportCSV()" style="${ttSecondaryBtnStyle()}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
        Export CSV
      </button>`;
  }

  container.innerHTML = `<div style="text-align:center;padding:40px;color:var(--gw-muted,#9a9a8a)">
    <div style="width:28px;height:28px;border:3px solid #4ade8030;border-top-color:#4ade80;border-radius:50%;animation:tt-spin 1s linear infinite;margin:0 auto 12px"></div>
    Loading payroll data…
  </div>`;

  try {
    const res = await fetch(`/api/time/team-summary?from=${from}&to=${to}`, { credentials:'include' });
    const j   = await res.json();
    if (!j.ok) { container.innerHTML = `<div style="padding:20px;color:#f87171">${ttE(j.error||'Failed to load payroll data')}</div>`; return; }

    const users = j.data || [];
    st.teamEntries = [];
    users.forEach(u => { if (u.entries) st.teamEntries.push(...u.entries); });
    st.selected = new Set();

    container.innerHTML = ttBuildPayrollHTML(users);
    ttLoadRingPanelData();
  } catch(e) {
    container.innerHTML = `<div style="padding:20px;color:#f87171">Error: ${ttE(e.message)}</div>`;
  }
}

function ttBuildPayrollHTML(users) {
  const totalMin = users.reduce((s,u) => s + (u.total_min||0), 0);
  const maxMin   = Math.max(...users.map(u => u.total_min||0), 1);
  const goalMin  = 40 * 60;

  return `
    <!-- Stats row -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px">
      ${[
        { label:'Team Hours', val: ttFmt(totalMin),          color:'#60a5fa', icon:'<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>' },
        { label:'Active Reps', val: users.length,            color:'#4ade80', icon:'<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle>' },
        { label:'Pending Approval', val: users.reduce((s,u)=>(u.entries||[]).filter(e=>e.approved===0).length + s,0), color:'#fbbf24', icon:'<circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>' },
        { label:'Approved', val: users.reduce((s,u)=>(u.entries||[]).filter(e=>e.approved===1).length + s,0),         color:'#4ade80', icon:'<polyline points="20 6 9 17 4 12"></polyline>' },
      ].map(stat => `
        <div style="background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:12px;padding:14px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <div style="width:28px;height:28px;border-radius:8px;background:${stat.color}18;display:flex;align-items:center;justify-content:center;flex-shrink:0">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="${stat.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${stat.icon}</svg>
            </div>
            <div style="font-size:10px;font-weight:600;color:var(--gw-muted,#9a9a8a)">${stat.label}</div>
          </div>
          <div style="font-size:22px;font-weight:900;color:var(--gw-text,#E8E4D9)">${stat.val}</div>
        </div>`).join('')}
    </div>

    <!-- Leaderboard -->
    <div style="background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:14px;overflow:hidden;margin-bottom:16px">
      <div style="padding:14px 16px;border-bottom:1px solid var(--gw-line,#2a3a30);display:flex;align-items:center;justify-content:space-between">
        <div style="font-size:13px;font-weight:800;color:var(--gw-text,#E8E4D9)">Team Leaderboard</div>
        <div style="display:flex;gap:6px" id="tt-payroll-batch-btns" style="display:none">
          <button onclick="ttBatchApprove()" style="padding:6px 12px;background:#4ade8020;border:1px solid #4ade8050;border-radius:7px;color:#4ade80;font-size:11px;font-weight:700;cursor:pointer">✓ Approve Selected</button>
          <button onclick="ttBatchReject()" style="padding:6px 12px;background:#f8717120;border:1px solid #f8717150;border-radius:7px;color:#f87171;font-size:11px;font-weight:700;cursor:pointer">✗ Reject Selected</button>
        </div>
      </div>

      ${users.length === 0 ? `
        <div style="text-align:center;padding:32px;color:var(--gw-muted,#9a9a8a)">No time data for this week</div>
      ` : users.map((u, idx) => {
        const pct = (u.total_min || 0) / maxMin * 100;
        const goalPct = Math.min(100, (u.total_min||0) / goalMin * 100);
        const overGoal = (u.total_min||0) > goalMin;
        const pendCount = (u.entries||[]).filter(e=>e.approved===0).length;
        const approvedCount = (u.entries||[]).filter(e=>e.approved===1).length;

        return `
          <div style="padding:14px 16px;border-bottom:1px solid var(--gw-line,#2a3a30);display:grid;grid-template-columns:24px auto 1fr auto;gap:12px;align-items:center">
            <!-- Rank -->
            <div style="width:22px;height:22px;border-radius:50%;background:${idx===0?'#fbbf24':idx===1?'#d1d5db':idx===2?'#a78028':'#ffffff10'};display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:900;color:${idx<3?'#000':'var(--gw-muted,#9a9a8a)'};flex-shrink:0">${idx+1}</div>
            <!-- Avatar + Name -->
            <div style="min-width:100px;max-width:130px">
              <div style="display:flex;align-items:center;gap:7px">
                <div style="width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#2563EB,#7c3aed);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:#fff;flex-shrink:0">${(u.name||'?')[0].toUpperCase()}</div>
                <div>
                  <div style="font-size:12px;font-weight:700;color:var(--gw-text,#E8E4D9);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:90px">${ttE(u.name||u.rep_id)}</div>
                  <div style="font-size:9px;color:var(--gw-muted,#9a9a8a)">${pendCount} pending · ${approvedCount} approved</div>
                </div>
              </div>
            </div>
            <!-- Progress bar -->
            <div style="display:flex;flex-direction:column;gap:3px">
              <div style="height:8px;background:#ffffff0a;border-radius:4px;overflow:hidden;position:relative">
                <div style="height:100%;width:${pct.toFixed(1)}%;background:${overGoal?'#f59e0b':'linear-gradient(90deg,#2563EB,#4ade80)'};border-radius:4px;transition:width 1s ease"></div>
                <!-- Goal marker -->
                <div style="position:absolute;top:0;bottom:0;left:${Math.min(100, (goalMin/maxMin*100)).toFixed(1)}%;width:2px;background:#ffffff40"></div>
              </div>
              <div style="display:flex;gap:4px;flex-wrap:wrap">
                ${pendCount > 0 ? `<span style="font-size:9px;font-weight:700;color:#fbbf24;background:#fbbf2415;border:1px solid #fbbf2430;border-radius:20px;padding:1px 6px">${pendCount} pending</span>` : ''}
                ${overGoal ? `<span style="font-size:9px;font-weight:700;color:#f59e0b;background:#f59e0b15;border:1px solid #f59e0b30;border-radius:20px;padding:1px 6px">OT ${ttFmt((u.total_min||0)-goalMin)}</span>` : ''}
              </div>
            </div>
            <!-- Hours + actions -->
            <div style="text-align:right;flex-shrink:0">
              <div style="font-size:18px;font-weight:900;color:var(--gw-text,#E8E4D9);font-variant-numeric:tabular-nums">${ttFmt(u.total_min||0)}</div>
              <div style="font-size:9px;color:var(--gw-muted,#9a9a8a)">${ttFmtDecimal(u.total_min||0)} hrs</div>
              ${pendCount > 0 ? `
                <div style="display:flex;gap:4px;justify-content:flex-end;margin-top:6px">
                  <button onclick="ttApproveUser('${ttE(u.rep_id)}')" style="padding:4px 8px;background:#4ade8015;border:1px solid #4ade8040;border-radius:6px;color:#4ade80;font-size:9px;font-weight:700;cursor:pointer">✓ All</button>
                </div>` : ''}
            </div>
          </div>

          <!-- Expandable entry rows -->
          ${(u.entries||[]).length > 0 ? `
            <div style="margin:0 16px 12px;padding:10px;background:var(--gw-surface,#141f1a);border:1px solid var(--gw-line,#2a3a30);border-radius:10px;display:flex;flex-direction:column;gap:6px">
              ${(u.entries||[]).slice(0,5).map(e => `
                <div style="display:flex;align-items:center;gap:8px">
                  <input type="checkbox" id="tt-chk-${ttE(e.id)}" onchange="ttToggleSelect('${ttE(e.id)}')" style="accent-color:#2563EB;flex-shrink:0">
                  <div style="flex:1;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                    <span style="font-size:10px;font-weight:700;color:${ttColorForJob(e.job_type).text};background:${ttColorForJob(e.job_type).bg};border:1px solid ${ttColorForJob(e.job_type).border}40;border-radius:20px;padding:2px 7px">${ttE(e.job_type||'General Work')}</span>
                    <span style="font-size:10px;color:var(--gw-muted,#9a9a8a)">${ttFmtDate(e.clock_in)}</span>
                    <span style="font-size:10px;color:var(--gw-muted,#9a9a8a)">${ttFmtTime(e.clock_in)} → ${ttFmtTime(e.clock_out)}</span>
                    ${e.notes ? `<span style="font-size:10px;color:var(--gw-muted,#9a9a8a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px">${ttE(e.notes)}</span>` : ''}
                  </div>
                  <div style="font-size:11px;font-weight:700;color:var(--gw-text,#E8E4D9);white-space:nowrap">${ttFmt(e.duration_min)}</div>
                  ${e.approved === 0 ? `
                    <button onclick="ttApproveEntry('${ttE(e.id)}')" style="padding:3px 7px;background:#4ade8015;border:1px solid #4ade8040;border-radius:5px;color:#4ade80;font-size:9px;font-weight:700;cursor:pointer">✓</button>
                    <button onclick="ttRejectEntry('${ttE(e.id)}')" style="padding:3px 7px;background:#f8717115;border:1px solid #f8717140;border-radius:5px;color:#f87171;font-size:9px;font-weight:700;cursor:pointer">✗</button>
                  ` : `<span style="font-size:9px;font-weight:700;color:${e.approved===1?'#4ade80':'#f87171'}">${e.approved===1?'✓ OK':'✗ Rej'}</span>`}
                </div>`).join('')}
              ${(u.entries||[]).length > 5 ? `<div style="font-size:10px;color:var(--gw-muted,#9a9a8a);text-align:center;padding-top:4px">+${(u.entries||[]).length-5} more entries</div>` : ''}
            </div>` : ''}`;
      }).join('')}
    </div>

    <!-- Floating batch action bar -->
    <div id="tt-float-bar" style="display:none;position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:100;background:#1a2820;border:1px solid #2a3a30;border-radius:30px;padding:10px 20px;box-shadow:0 8px 32px rgba(0,0,0,.5);display:none;align-items:center;gap:12px">
      <span id="tt-float-count" style="font-size:12px;font-weight:700;color:#fff">0 selected</span>
      <div style="width:1px;height:20px;background:#2a3a30"></div>
      <button onclick="ttBatchApprove()" style="padding:7px 16px;background:#4ade8020;border:1px solid #4ade8050;border-radius:20px;color:#4ade80;font-size:11px;font-weight:700;cursor:pointer">✓ Approve</button>
      <button onclick="ttBatchReject()" style="padding:7px 16px;background:#f8717120;border:1px solid #f8717150;border-radius:20px;color:#f87171;font-size:11px;font-weight:700;cursor:pointer">✗ Reject</button>
      <button onclick="ttExportCSVSelected()" style="padding:7px 16px;background:#60a5fa20;border:1px solid #60a5fa50;border-radius:20px;color:#60a5fa;font-size:11px;font-weight:700;cursor:pointer">↓ Export</button>
      <button onclick="ttClearSelection()" style="padding:4px 8px;background:transparent;border:none;color:var(--gw-muted,#9a9a8a);font-size:16px;cursor:pointer;line-height:1">×</button>
    </div>`;
}

function ttToggleSelect(id) {
  const cb = document.getElementById(`tt-chk-${id}`);
  if (cb && cb.checked) {
    window._ttState.selected.add(id);
  } else {
    window._ttState.selected.delete(id);
  }
  ttUpdateFloatBar();
}

function ttUpdateFloatBar() {
  const bar = document.getElementById('tt-float-bar');
  const count = document.getElementById('tt-float-count');
  if (!bar) return;
  const n = window._ttState.selected.size;
  if (n > 0) {
    bar.style.display = 'flex';
    if (count) count.textContent = `${n} selected`;
  } else {
    bar.style.display = 'none';
  }
}

function ttClearSelection() {
  window._ttState.selected = new Set();
  document.querySelectorAll('[id^="tt-chk-"]').forEach(cb => { cb.checked = false; });
  ttUpdateFloatBar();
}

async function ttApproveEntry(id) {
  try {
    await fetch(`/api/time/approve/${id}`, { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ approved:1 }) });
    ttToast('Approved ✓');
    ttLoadPayroll();
  } catch { ttToast('Network error'); }
}

async function ttRejectEntry(id) {
  try {
    await fetch(`/api/time/approve/${id}`, { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ approved:2 }) });
    ttToast('Rejected');
    ttLoadPayroll();
  } catch { ttToast('Network error'); }
}

async function ttApproveUser(repId) {
  const entries = window._ttState.teamEntries.filter(e => e.rep_id === repId && e.approved === 0);
  const ids = entries.map(e => e.id);
  if (ids.length === 0) { ttToast('No pending entries'); return; }
  try {
    await fetch('/api/time/approve-batch', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ ids, approved:1 })
    });
    ttToast(`${ids.length} entries approved ✓`);
    ttLoadPayroll();
  } catch { ttToast('Network error'); }
}

async function ttBatchApprove() {
  const ids = [...window._ttState.selected];
  if (ids.length === 0) { ttToast('Select entries first'); return; }
  try {
    await fetch('/api/time/approve-batch', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ ids, approved:1 })
    });
    ttToast(`${ids.length} entries approved ✓`);
    ttClearSelection();
    ttLoadPayroll();
  } catch { ttToast('Network error'); }
}

async function ttBatchReject() {
  const ids = [...window._ttState.selected];
  if (ids.length === 0) { ttToast('Select entries first'); return; }
  try {
    await fetch('/api/time/approve-batch', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ ids, approved:2 })
    });
    ttToast(`${ids.length} entries rejected`);
    ttClearSelection();
    ttLoadPayroll();
  } catch { ttToast('Network error'); }
}

// ─────────────────────────────────────────────────────────────────────────────
//  TAB 4: INSIGHTS
// ─────────────────────────────────────────────────────────────────────────────
async function ttLoadInsights() {
  const st = window._ttState;
  const container = document.getElementById('tt-tab-content');
  const headerActions = document.getElementById('tt-header-actions');
  if (!container) return;

  if (headerActions) {
    headerActions.innerHTML = `
      <button onclick="window._ttState.weekOffset=window._ttState.weekOffset-4;ttLoadInsights()" style="${ttNavBtnStyle()}">← 4 weeks</button>
      <button onclick="window._ttState.weekOffset=0;ttLoadInsights()" style="${ttSecondaryBtnStyle()}">Current Month</button>`;
  }

  container.innerHTML = `<div style="text-align:center;padding:40px;color:var(--gw-muted,#9a9a8a)">
    <div style="width:28px;height:28px;border:3px solid #4ade8030;border-top-color:#4ade80;border-radius:50%;animation:tt-spin 1s linear infinite;margin:0 auto 12px"></div>
    Loading insights…
  </div>`;

  try {
    // Load 4 weeks of data
    const fetches = [-3,-2,-1,0].map(w => {
      const { from, to } = ttWeekRange(st.weekOffset + w);
      return fetch(`/api/time/entries?from=${from}&to=${to}`, { credentials:'include' })
        .then(r => r.json())
        .then(j => j.ok ? (j.data||[]) : []);
    });
    const weeks = await Promise.all(fetches);
    const allEntries = weeks.flat();

    // Team summary for user leaderboard
    const { from, to } = ttWeekRange(st.weekOffset);
    const teamRes = await fetch(`/api/time/team-summary?from=${from}&to=${to}`, { credentials:'include' });
    const teamJ   = await teamRes.json();
    const teamData = teamJ.ok ? (teamJ.data||[]) : [];

    container.innerHTML = ttBuildInsightsHTML(allEntries, weeks, teamData);
    ttDrawInsightCharts(allEntries, weeks, teamData);
    ttLoadRingPanelData();
  } catch(e) {
    container.innerHTML = `<div style="padding:20px;color:#f87171">Error: ${ttE(e.message)}</div>`;
  }
}

function ttBuildInsightsHTML(allEntries, weeks, teamData) {
  const totalMin = allEntries.reduce((s,e)=>s+(e.duration_min||0),0);
  const teamMin  = teamData.reduce((s,u)=>s+(u.total_min||0),0);

  // Job breakdown
  const jobTotals = {};
  allEntries.forEach(e => {
    const j = e.job_type || 'General Work';
    jobTotals[j] = (jobTotals[j]||0) + (e.duration_min||0);
  });

  // Per user
  const maxUserMin = Math.max(...teamData.map(u=>u.total_min||0), 1);

  return `
    <!-- Big number + trend header -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:20px">
      <div style="background:linear-gradient(135deg,#0f2d1f 0%,#1a3a2a 100%);border:1px solid #2D7A5540;border-radius:14px;padding:20px">
        <div style="font-size:10px;font-weight:700;letter-spacing:.06em;color:#4ade8080;text-transform:uppercase;margin-bottom:8px">Work Time (4 weeks)</div>
        <div style="font-size:36px;font-weight:900;color:#fff;line-height:1;margin-bottom:4px">${ttFmt(totalMin)}</div>
        <div style="font-size:11px;color:#4ade8080">${ttFmtDecimal(totalMin)} hrs logged</div>
      </div>
      <div style="background:linear-gradient(135deg,#0f1d2d 0%,#1a2a3a 100%);border:1px solid #2563EB40;border-radius:14px;padding:20px">
        <div style="font-size:10px;font-weight:700;letter-spacing:.06em;color:#60a5fa80;text-transform:uppercase;margin-bottom:8px">Team Total (this week)</div>
        <div style="font-size:36px;font-weight:900;color:#fff;line-height:1;margin-bottom:4px">${ttFmt(teamMin)}</div>
        <div style="font-size:11px;color:#60a5fa80">${teamData.length} active reps</div>
      </div>
    </div>

    <!-- Two-column: Chart + User leaderboard -->
    <div style="display:grid;grid-template-columns:1fr 280px;gap:16px;align-items:start">

      <!-- Left: Charts -->
      <div style="display:flex;flex-direction:column;gap:14px">

        <!-- Line chart: daily hours (4-week trend) -->
        <div style="background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:14px;padding:16px">
          <div style="font-size:12px;font-weight:800;color:var(--gw-text,#E8E4D9);margin-bottom:4px">4-Week Trend</div>
          <div style="font-size:10px;color:var(--gw-muted,#9a9a8a);margin-bottom:14px">Daily hours logged</div>
          <canvas id="tt-line-chart" height="140" style="width:100%"></canvas>
        </div>

        <!-- Stacked bar chart: by job type per week -->
        <div style="background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:14px;padding:16px">
          <div style="font-size:12px;font-weight:800;color:var(--gw-text,#E8E4D9);margin-bottom:4px">Hours by Job Type</div>
          <div style="font-size:10px;color:var(--gw-muted,#9a9a8a);margin-bottom:14px">Weekly breakdown</div>
          <canvas id="tt-bar-chart" height="160" style="width:100%"></canvas>
          <!-- Legend -->
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px">
            ${Object.entries(jobTotals).map(([job]) => {
              const col = ttColorForJob(job);
              return `<div style="display:flex;align-items:center;gap:5px">
                <div style="width:10px;height:10px;border-radius:2px;background:${col.border}"></div>
                <span style="font-size:10px;color:var(--gw-muted,#9a9a8a)">${ttE(job)}</span>
              </div>`;
            }).join('')}
          </div>
        </div>

        <!-- Job type breakdown pills -->
        <div style="background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:14px;padding:16px">
          <div style="font-size:12px;font-weight:800;color:var(--gw-text,#E8E4D9);margin-bottom:14px">By Job Type</div>
          <div style="display:flex;flex-direction:column;gap:10px">
            ${Object.entries(jobTotals).sort((a,b)=>b[1]-a[1]).map(([job,min]) => {
              const col = ttColorForJob(job);
              const pct = totalMin > 0 ? (min/totalMin*100).toFixed(1) : 0;
              // Budget badge: if >100% "over budget", else green
              const budgetColor = pct > 80 ? '#f59e0b' : '#4ade80';
              const budgetBg    = pct > 80 ? '#f59e0b15' : '#4ade8015';
              const budgetBorder= pct > 80 ? '#f59e0b40' : '#4ade8040';
              return `
                <div>
                  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px">
                    <div style="display:flex;align-items:center;gap:7px">
                      <div style="width:10px;height:10px;border-radius:50%;background:${col.border};flex-shrink:0"></div>
                      <span style="font-size:12px;font-weight:600;color:var(--gw-text,#E8E4D9)">${ttE(job)}</span>
                    </div>
                    <div style="display:flex;align-items:center;gap:8px">
                      <!-- Budget badge -->
                      <span style="font-size:9px;font-weight:700;color:${budgetColor};background:${budgetBg};border:1px solid ${budgetBorder};border-radius:20px;padding:2px 7px">${pct}%</span>
                      <span style="font-size:11px;font-weight:700;color:var(--gw-text,#E8E4D9)">${ttFmt(min)}</span>
                    </div>
                  </div>
                  <div style="height:5px;background:#ffffff08;border-radius:3px;overflow:hidden">
                    <div style="height:100%;width:${pct}%;background:${col.border};border-radius:3px;transition:width 1s ease"></div>
                  </div>
                </div>`;
            }).join('')}
          </div>
        </div>
      </div>

      <!-- Right: User leaderboard -->
      <div style="background:var(--gw-surface-2,#1a2820);border:1px solid var(--gw-line,#2a3a30);border-radius:14px;padding:14px;position:sticky;top:0">
        <div style="font-size:11px;font-weight:800;color:var(--gw-text,#E8E4D9);margin-bottom:14px">${teamData.length} Users</div>
        <div style="display:flex;flex-direction:column;gap:10px">
          ${teamData.sort((a,b)=>(b.total_min||0)-(a.total_min||0)).map((u,i) => {
            const pct = (u.total_min||0)/maxUserMin*100;
            return `
              <div>
                <div style="display:flex;align-items:center;gap:7px;margin-bottom:4px">
                  <div style="width:24px;height:24px;border-radius:50%;background:linear-gradient(135deg,#2563EB,#7c3aed);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:#fff;flex-shrink:0">${(u.name||'?')[0].toUpperCase()}</div>
                  <div style="flex:1;min-width:0">
                    <div style="font-size:11px;font-weight:700;color:var(--gw-text,#E8E4D9);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${ttE(u.name||u.rep_id)}</div>
                  </div>
                  <div style="font-size:12px;font-weight:800;color:var(--gw-text,#E8E4D9);white-space:nowrap">${ttFmt(u.total_min||0)}</div>
                </div>
                <div style="height:6px;background:#ffffff0a;border-radius:3px;overflow:hidden">
                  <div style="height:100%;width:${pct.toFixed(1)}%;background:linear-gradient(90deg,#2563EB,#4ade80);border-radius:3px;transition:width 1s ease"></div>
                </div>
              </div>`;
          }).join('')}
        </div>

        <!-- Projects section -->
        <div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--gw-line,#2a3a30)">
          <div style="font-size:10px;font-weight:700;letter-spacing:.05em;color:var(--gw-muted,#9a9a8a);text-transform:uppercase;margin-bottom:10px">${teamData.length} Projects</div>
          <div style="display:flex;flex-direction:column;gap:5px">
            ${Object.entries(jobTotals).slice(0,4).map(([job,min]) => {
              const col = ttColorForJob(job);
              const pct = totalMin > 0 ? (min/totalMin*100).toFixed(0) : 0;
              return `
                <div style="display:flex;align-items:center;gap:6px;padding:4px 0">
                  <div style="width:8px;height:8px;border-radius:2px;background:${col.border};flex-shrink:0"></div>
                  <div style="font-size:10px;color:var(--gw-muted,#9a9a8a);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${ttE(job)}</div>
                  <div style="font-size:10px;font-weight:700;color:var(--gw-text,#E8E4D9)">${ttFmt(min)}</div>
                </div>`;
            }).join('')}
          </div>

          <!-- On-time badge -->
          <div style="margin-top:12px;padding:10px;background:#4ade8010;border:1px solid #4ade8030;border-radius:10px;text-align:center">
            <div style="font-size:10px;color:#4ade80;font-weight:700;margin-bottom:2px">On Time</div>
            <div style="font-size:22px;font-weight:900;color:#4ade80">${teamData.length}</div>
          </div>
        </div>
      </div>
    </div>`;
}

function ttDrawInsightCharts(allEntries, weeks, teamData) {
  // Line chart: daily hours over 4 weeks
  const lineCanvas = document.getElementById('tt-line-chart');
  if (lineCanvas) {
    // Build daily points
    const dailyMap = {};
    allEntries.forEach(e => {
      const key = (e.clock_in||'').slice(0,10);
      dailyMap[key] = (dailyMap[key]||0) + (e.duration_min||0);
    });

    // Generate last 28 days of labels
    const now = new Date();
    const labels = [];
    const values = [];
    for (let i = 27; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const iso = d.toISOString().slice(0,10);
      labels.push(i % 7 === 0 ? d.toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '');
      values.push((dailyMap[iso]||0) / 60); // hours
    }

    ttDrawLineChart(lineCanvas, labels, values, '#4ade80');
  }

  // Stacked bar chart: job types per week
  const barCanvas = document.getElementById('tt-bar-chart');
  if (barCanvas) {
    const weekLabels = [-3,-2,-1,0].map(w => {
      const { from } = ttWeekRange(window._ttState.weekOffset + w);
      const d = new Date(from + 'T12:00:00');
      return d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
    });

    const jobTypes = Object.keys(TT_COLORS);
    const datasets = jobTypes.map(job => ({
      label: job,
      color: TT_COLORS[job]?.border || '#888',
      values: weeks.map(weekEntries =>
        weekEntries.filter(e => (e.job_type||'General Work') === job)
          .reduce((s,e)=>s+(e.duration_min||0),0) / 60
      )
    }));

    ttDrawStackedBarChart(barCanvas, weekLabels, datasets);
  }
}

// Mini canvas chart renderers (no external library)
function ttDrawLineChart(canvas, labels, values, color) {
  const ctx = canvas.getContext('2d');
  const W = canvas.offsetWidth || 400;
  const H = canvas.height || 140;
  canvas.width = W;
  canvas.height = H;

  const pad = { top:10, right:10, bottom:20, left:30 };
  const cW = W - pad.left - pad.right;
  const cH = H - pad.top - pad.bottom;
  const maxV = Math.max(...values, 1);

  ctx.clearRect(0,0,W,H);

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  [0.25,0.5,0.75,1].forEach(f => {
    const y = pad.top + cH * (1 - f);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + cW, y);
    ctx.stroke();
  });

  if (values.length === 0) return;

  const pts = values.map((v,i) => ({
    x: pad.left + (i / (values.length - 1)) * cW,
    y: pad.top + cH * (1 - v / maxV)
  }));

  // Fill area
  const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + cH);
  grad.addColorStop(0, color + '40');
  grad.addColorStop(1, color + '00');
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pad.top + cH);
  pts.forEach(p => ctx.lineTo(p.x, p.y));
  ctx.lineTo(pts[pts.length-1].x, pad.top + cH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    const cp1x = (pts[i-1].x + pts[i].x) / 2;
    ctx.bezierCurveTo(cp1x, pts[i-1].y, cp1x, pts[i].y, pts[i].x, pts[i].y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Labels
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'center';
  labels.forEach((lbl,i) => {
    if (!lbl) return;
    const x = pad.left + (i/(labels.length-1))*cW;
    ctx.fillText(lbl, x, H - 2);
  });

  // Y-axis labels
  ctx.textAlign = 'right';
  [0,Math.round(maxV/2),Math.round(maxV)].forEach((v,i) => {
    const y = pad.top + cH * (1 - v/maxV);
    ctx.fillText(`${v}h`, pad.left - 4, y + 3);
  });
}

function ttDrawStackedBarChart(canvas, labels, datasets) {
  const ctx = canvas.getContext('2d');
  const W = canvas.offsetWidth || 400;
  const H = canvas.height || 160;
  canvas.width = W;
  canvas.height = H;

  const pad = { top:10, right:10, bottom:24, left:30 };
  const cW = W - pad.left - pad.right;
  const cH = H - pad.top - pad.bottom;

  // Max stack height
  const stackTotals = labels.map((_,i) => datasets.reduce((s,d)=>s+(d.values[i]||0),0));
  const maxV = Math.max(...stackTotals, 1);

  ctx.clearRect(0,0,W,H);

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  [0.25,0.5,0.75,1].forEach(f => {
    const y = pad.top + cH*(1-f);
    ctx.beginPath(); ctx.moveTo(pad.left,y); ctx.lineTo(pad.left+cW,y); ctx.stroke();
  });

  const barW = cW / labels.length * 0.6;
  const barGap = cW / labels.length;

  labels.forEach((lbl,i) => {
    const x = pad.left + i * barGap + (barGap - barW) / 2;
    let stackY = pad.top + cH;

    datasets.forEach(ds => {
      const v = ds.values[i] || 0;
      if (v === 0) return;
      const bH = (v / maxV) * cH;
      stackY -= bH;
      ctx.fillStyle = ds.color;
      const r = 3;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x, stackY, barW, bH, [r,r,0,0]) : ctx.rect(x,stackY,barW,bH);
      ctx.fill();
    });

    // Label
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(lbl, x + barW/2, H - 6);

    // Stack total
    if (stackTotals[i] > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '9px sans-serif';
      ctx.fillText(`${stackTotals[i].toFixed(1)}h`, x + barW/2, stackY - 4);
    }
  });

  // Y labels
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.textAlign = 'right';
  ctx.font = '9px sans-serif';
  [0,Math.round(maxV/2),Math.round(maxV)].forEach(v => {
    const y = pad.top + cH*(1-v/maxV);
    ctx.fillText(`${v}h`, pad.left-4, y+3);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  CSV EXPORT
// ─────────────────────────────────────────────────────────────────────────────
function ttExportCSV() {
  const entries = window._ttState.allEntries;
  if (!entries.length) { ttToast('No entries to export'); return; }
  ttDownloadCSV(entries, 'timesheet_export.csv');
}

function ttExportCSVSelected() {
  const sel = window._ttState.selected;
  const all = [...window._ttState.allEntries, ...window._ttState.teamEntries];
  const entries = all.filter(e => sel.has(e.id));
  if (!entries.length) { ttToast('No entries selected'); return; }
  ttDownloadCSV(entries, 'selected_entries.csv');
}

function ttDownloadCSV(entries, filename) {
  const header = ['ID','Rep','Company','Job Type','Clock In','Clock Out','Duration (min)','Notes','Approved'];
  const rows = entries.map(e => [
    ttE(e.id), ttE(e.rep_id||''), ttE(e.company_id||''), ttE(e.job_type||''),
    ttE(e.clock_in||''), ttE(e.clock_out||''), e.duration_min||'',
    `"${(e.notes||'').replace(/"/g,'""')}"`,
    e.approved === 1 ? 'Approved' : e.approved === 2 ? 'Rejected' : 'Pending'
  ]);
  const csv = [header, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
  ttToast('CSV downloaded ✓');
}

// ─────────────────────────────────────────────────────────────────────────────
//  INJECT GLOBAL STYLES
// ─────────────────────────────────────────────────────────────────────────────
function ttInjectStyles() {
  if (document.getElementById('tt-styles')) return;
  const style = document.createElement('style');
  style.id = 'tt-styles';
  style.textContent = `
    @keyframes tt-pulse {
      0%,100% { opacity:1; transform:scale(1); }
      50%      { opacity:.5; transform:scale(1.15); }
    }
    @keyframes tt-spin {
      from { transform:rotate(0deg); }
      to   { transform:rotate(360deg); }
    }
    @keyframes tt-modal-in {
      from { opacity:0; transform:scale(.95) translateY(8px); }
      to   { opacity:1; transform:scale(1) translateY(0); }
    }
    #tt-date-slider::-webkit-scrollbar { display:none; }
    #tt-root { display:flex; }
    @media (max-width: 700px) {
      #tt-ring-panel { display:none !important; }
      #tt-root { flex-direction:column; }
    }
  `;
  document.head.appendChild(style);
}

// ─────────────────────────────────────────────────────────────────────────────
//  INIT (called after login)
// ─────────────────────────────────────────────────────────────────────────────
window.ttInit = function() {
  ttInjectStyles();
  ttLoadActiveEntry();
};
