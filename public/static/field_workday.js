/**
 * Groundwork CRM — Phase 9: Field Time / Workday Clock
 *
 * 9A: Header clock pill + field-first dashboard for laborers/foremen
 * 9B: Schedule-linked job selection on clock-in
 * 9C: Admin timesheet roll-up + workday settings
 *
 * Depends on: field_mode.js (_currentRep, _isFieldRole, _getMyWorkOrders,
 *             _getMySchedule, GW_FIELD_ROLES), time_tracker.js (_ttState,
 *             ttQuickClockIn, ttQuickClockOut, ttElapsedStr, ttElapsed)
 */

'use strict';

// ── Shared helpers ────────────────────────────────────────────────────────────

function _fwE(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _fwTodayISO() { return new Date().toISOString().slice(0, 10); }

function _fwFmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function _fwElapsedStr(clockInIso) {
  if (!clockInIso) return '00:00:00';
  const diff = Math.floor((Date.now() - new Date(clockInIso).getTime()) / 1000);
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function _fwIsFieldRole() {
  if (typeof _isFieldRole === 'function') return _isFieldRole();
  const rep = window._d1SessionRep;
  return rep && ['foreman', 'field_supervisor', 'laborer'].includes(rep.role);
}

function _fwRep() {
  // Field Preview: office roles viewing a worker's dashboard render AS that worker
  if (window._fieldPreviewRep) return window._fieldPreviewRep;
  if (typeof _currentRep === 'function') return _currentRep();
  return window._d1SessionRep || null;
}

// ══════════════════════════════════════════════════════════════════════════════
// 9A — HEADER CLOCK PILL
// ══════════════════════════════════════════════════════════════════════════════

// State: what workday status state we're in
// 'not-in' | 'clocked-in' | 'on-break' | 'clocked-out'
let _gwPillState = 'not-in';
let _gwPillTickInterval = null;
let _gwPillActiveBreak = null;   // open break_entry if on break

// Initialize clock pill after auth — called from bootstrapD1Auth completion
window.gwInitClockPill = async function gwInitClockPill() {
  const pill = document.getElementById('gw-clock-pill');
  if (!pill) return;

  // Show pill for all authenticated users
  pill.style.display = 'flex';

  // Load active time entry state
  await _gwPillSyncState();

  // Start tick for live timer
  if (_gwPillTickInterval) clearInterval(_gwPillTickInterval);
  _gwPillTickInterval = setInterval(_gwPillTick, 1000);
};

// Sync workday state from server
async function _gwPillSyncState() {
  try {
    const [entryRes, breakRes] = await Promise.all([
      fetch('/api/time/active', { credentials: 'include' }),
      fetch('/api/time/break/active', { credentials: 'include' })
    ]);
    const entryJ = await entryRes.json();
    const breakJ = await breakRes.json();

    const active = (entryJ.ok && entryJ.data) ? entryJ.data : null;
    const openBreak = (breakJ.ok && breakJ.data) ? breakJ.data : null;

    // Sync into _ttState so sidebar widget stays aligned
    if (window._ttState) {
      window._ttState.activeEntry = active;
    }

    _gwPillActiveBreak = openBreak;

    if (openBreak) {
      _gwPillState = 'on-break';
    } else if (active) {
      _gwPillState = 'clocked-in';
    } else {
      _gwPillState = 'not-in';
    }

    gwRenderClockPill(_gwPillState);
  } catch (e) {
    console.warn('[GW Clock Pill] sync failed:', e.message);
  }
}

// Render the pill's static parts (dot, label). Timer is updated by tick.
window.gwRenderClockPill = function gwRenderClockPill(state) {
  _gwPillState = state;
  const pill  = document.getElementById('gw-clock-pill');
  const dot   = document.getElementById('gw-clock-dot');
  const label = document.getElementById('gw-clock-label');
  const timer = document.getElementById('gw-clock-timer');
  if (!pill) return;

  // Remove all state classes
  pill.classList.remove('clocked-in', 'on-break', 'clocked-out');

  const entry = window._ttState && window._ttState.activeEntry;

  switch (state) {
    case 'clocked-in':
      pill.classList.add('clocked-in');
      label.textContent = 'Clocked In';
      timer.style.display = 'inline';
      timer.textContent = entry ? _fwElapsedStr(entry.clock_in) : '00:00:00';
      break;
    case 'on-break':
      pill.classList.add('on-break');
      label.textContent = 'On Break';
      timer.style.display = 'inline';
      timer.textContent = _gwPillActiveBreak ? _fwElapsedStr(_gwPillActiveBreak.break_start) : '00:00';
      break;
    case 'clocked-out':
      pill.classList.add('clocked-out');
      label.textContent = 'Done';
      timer.style.display = 'none';
      break;
    default: // not-in
      label.textContent = 'Clock In';
      timer.style.display = 'none';
      break;
  }
};

// Called every second by setInterval
function _gwPillTick() {
  const timer = document.getElementById('gw-clock-timer');
  if (!timer) return;
  const entry = window._ttState && window._ttState.activeEntry;

  if (_gwPillState === 'clocked-in' && entry) {
    timer.textContent = _fwElapsedStr(entry.clock_in);
    // Also update field dashboard hero timer if visible
    const fdTimer = document.getElementById('fd-hero-timer');
    if (fdTimer) fdTimer.textContent = _fwElapsedStr(entry.clock_in);
  } else if (_gwPillState === 'on-break' && _gwPillActiveBreak) {
    timer.textContent = _fwElapsedStr(_gwPillActiveBreak.break_start);
    const fdTimer = document.getElementById('fd-hero-timer');
    if (fdTimer) fdTimer.textContent = _fwElapsedStr(_gwPillActiveBreak.break_start);
  }
}

// Toggle clock dropdown menu
window.gwClockPillClick = function gwClockPillClick() {
  const menu = document.getElementById('gw-clock-menu');
  if (!menu) return;
  const isOpen = menu.style.display !== 'none';
  if (isOpen) {
    menu.style.display = 'none';
    return;
  }
  // Render menu actions
  const inner = document.getElementById('gw-clock-menu-inner');
  if (inner) inner.innerHTML = _gwClockMenuHTML(_gwPillState);
  menu.style.display = 'block';

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function _closeMenu(e) {
      if (!menu.contains(e.target)) {
        menu.style.display = 'none';
        document.removeEventListener('click', _closeMenu);
      }
    });
  }, 0);
};

// Build dropdown HTML based on current state
function _gwClockMenuHTML(state) {
  const entry = window._ttState && window._ttState.activeEntry;
  const clockedInAt = entry ? _fwFmtTime(entry.clock_in) : null;
  const job = entry ? (entry.job_type || entry.job_label || '') : '';
  const woId = entry ? entry.work_order_id : null;

  switch (state) {
    case 'not-in':
      return `
        <div class="gw-clock-menu-hd">Start Your Day</div>
        <button class="gw-clock-menu-action" onclick="gwClockPillMenu_clockIn()">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          Clock In
        </button>
        <div class="gw-clock-menu-divider"></div>
        <button class="gw-clock-menu-action" onclick="show('timeTracker');document.getElementById('gw-clock-menu').style.display='none'">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          View Timesheet
        </button>`;

    case 'clocked-in':
      return `
        ${clockedInAt ? `<div class="gw-clock-menu-status">Clocked in at ${_fwE(clockedInAt)}</div>` : ''}
        ${job ? `<div class="gw-clock-menu-job">${_fwE(job)}</div>` : ''}
        <button class="gw-clock-menu-action" onclick="gwClockPillMenu_startBreak()">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8h1a4 4 0 010 8h-1"/><path d="M2 8h16v9a4 4 0 01-4 4H6a4 4 0 01-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>
          Start Break
        </button>
        ${woId ? `
        <button class="gw-clock-menu-action" onclick="gwClockPillMenu_switchJob()">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/></svg>
          Switch Job
        </button>` : ''}
        <div class="gw-clock-menu-divider"></div>
        <button class="gw-clock-menu-action danger" onclick="gwClockPillMenu_clockOut()">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          Clock Out
        </button>
        <div class="gw-clock-menu-divider"></div>
        <button class="gw-clock-menu-action" onclick="show('timeTracker');document.getElementById('gw-clock-menu').style.display='none'">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          View Timesheet
        </button>`;

    case 'on-break':
      return `
        <div class="gw-clock-menu-status">On break</div>
        <button class="gw-clock-menu-action" onclick="gwClockPillMenu_endBreak()">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          End Break
        </button>
        <div class="gw-clock-menu-divider"></div>
        <button class="gw-clock-menu-action danger" onclick="gwClockPillMenu_clockOut()">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          Clock Out
        </button>`;

    case 'clocked-out':
      return `
        <div class="gw-clock-menu-status">Shift ended</div>
        <button class="gw-clock-menu-action" onclick="show('timeTracker');document.getElementById('gw-clock-menu').style.display='none'">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          View Timesheet
        </button>`;

    default: return '';
  }
}

// ── Pill menu action handlers ──────────────────────────────────────────────────

window.gwClockPillMenu_clockIn = function() {
  document.getElementById('gw-clock-menu').style.display = 'none';
  const todayJobs = (typeof _getMySchedule === 'function') ? _getMySchedule() : [];
  if (todayJobs.length > 0) {
    // Show job selection if there are scheduled jobs
    fdShowJobSelect(todayJobs, async function(selectedWOs) {
      if (selectedWOs.length === 0) {
        await _gwPillClockInGeneric();
      } else {
        await fdClockInWithJobs(selectedWOs);
      }
    });
  } else {
    _gwPillClockInGeneric();
  }
};

async function _gwPillClockInGeneric() {
  try {
    const res = await fetch('/api/time/clock-in', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobType: 'General Work' })
    });
    const j = await res.json();
    if (j.ok) {
      if (window._ttState) {
        window._ttState.activeEntry = { id: j.data.id, clock_in: j.data.clock_in, job_type: 'General Work' };
      }
      _gwPillState = 'clocked-in';
      gwRenderClockPill('clocked-in');
      if (typeof ttRenderSidebarWidget === 'function') ttRenderSidebarWidget();
      if (typeof ttStartRing === 'function') ttStartRing();
      if (typeof showToast === 'function') showToast('Clocked in ✓', 'success');
      // Refresh field dashboard if active
      if (window._currentView === 'fieldDashboard') fieldDashboard();
    } else {
      if (typeof showToast === 'function') showToast(j.error || 'Could not clock in', 'error');
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast('Network error', 'error');
  }
}

window.gwClockPillMenu_startBreak = async function() {
  document.getElementById('gw-clock-menu').style.display = 'none';
  try {
    const res = await fetch('/api/time/break/start', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const j = await res.json();
    if (j.ok) {
      _gwPillActiveBreak = { id: j.data.id, break_start: j.data.break_start };
      _gwPillState = 'on-break';
      gwRenderClockPill('on-break');
      if (typeof showToast === 'function') showToast('Break started', 'info');
      if (window._currentView === 'fieldDashboard') fieldDashboard();
    } else {
      if (typeof showToast === 'function') showToast(j.error || 'Could not start break', 'error');
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast('Network error', 'error');
  }
};

window.gwClockPillMenu_endBreak = async function() {
  document.getElementById('gw-clock-menu').style.display = 'none';
  try {
    const res = await fetch('/api/time/break/end', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const j = await res.json();
    if (j.ok) {
      _gwPillActiveBreak = null;
      _gwPillState = 'clocked-in';
      gwRenderClockPill('clocked-in');
      if (typeof showToast === 'function') showToast('Break ended', 'success');
      if (window._currentView === 'fieldDashboard') fieldDashboard();
    } else {
      if (typeof showToast === 'function') showToast(j.error || 'Could not end break', 'error');
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast('Network error', 'error');
  }
};

window.gwClockPillMenu_clockOut = async function() {
  document.getElementById('gw-clock-menu').style.display = 'none';
  const entry = window._ttState && window._ttState.activeEntry;
  if (!entry) { if (typeof showToast === 'function') showToast('Not clocked in', 'error'); return; }
  try {
    const res = await fetch(`/api/time/clock-out/${entry.id}`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const j = await res.json();
    if (j.ok) {
      if (window._ttState) window._ttState.activeEntry = null;
      _gwPillActiveBreak = null;
      _gwPillState = 'clocked-out';
      gwRenderClockPill('clocked-out');
      if (typeof ttRenderSidebarWidget === 'function') ttRenderSidebarWidget();
      if (typeof ttStopRing === 'function') ttStopRing();
      if (typeof showToast === 'function') showToast('Clocked out ✓', 'success');
      if (window._currentView === 'fieldDashboard') fieldDashboard();
    } else {
      if (typeof showToast === 'function') showToast(j.error || 'Could not clock out', 'error');
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast('Network error', 'error');
  }
};

window.gwClockPillMenu_switchJob = function() {
  document.getElementById('gw-clock-menu').style.display = 'none';
  const todayJobs = (typeof _getMySchedule === 'function') ? _getMySchedule() : [];
  const entry = window._ttState && window._ttState.activeEntry;
  // Filter out currently active job
  const available = todayJobs.filter(j => !entry || j.id !== entry.work_order_id);
  if (available.length === 0) {
    if (typeof showToast === 'function') showToast('No other jobs scheduled today', 'info');
    return;
  }
  fdShowJobSelect(available, async function(selected) {
    if (selected.length > 0) await fdSwitchJob(selected[0].id);
  }, { singleSelect: true, title: 'Switch to Job' });
};

// ══════════════════════════════════════════════════════════════════════════════
// 9A — FIELD DASHBOARD
// ══════════════════════════════════════════════════════════════════════════════

window.fieldDashboard = function fieldDashboard() {
  const viewEl = document.getElementById('view');
  if (!viewEl) return;

  const rep = _fwRep();
  if (!rep) {
    viewEl.innerHTML = '<div style="padding:40px;text-align:center;color:var(--gw-muted)">Loading…</div>';
    return;
  }

  const isSupervisor = rep.role === 'foreman' || rep.role === 'field_supervisor';
  const todayJobs    = (typeof _getMySchedule === 'function') ? _getMySchedule() : [];
  const state        = window._gwPillState || 'not-in';
  const entry        = window._ttState && window._ttState.activeEntry;

  // ── Crew / foreman context ────────────────────────────────────────────────
  // WO schema: wo.crew is a plain string (crew name / lead name), not a rep ID.
  // For laborers: show the crew/foreman string from their first today job.
  // For supervisors: collect unique crew strings across all today's jobs.

  // Laborer: foreman = wo.crew string from first job
  let foremanName = null;
  if (!isSupervisor && todayJobs.length > 0) {
    foremanName = todayJobs[0].crew || null;
  }

  // Supervisor: unique crew member strings across today's jobs
  let crewNames = [];
  if (isSupervisor && todayJobs.length > 0) {
    const seen = new Set();
    todayJobs.forEach(wo => {
      if (wo.crew && !seen.has(wo.crew)) {
        seen.add(wo.crew);
        crewNames.push(wo.crew);
      }
    });
  }

  // ── Hero status section ───────────────────────────────────────────────────

  const stateInfo = {
    'not-in':     { cls: 'not-in',    label: 'Not Clocked In' },
    'clocked-in': { cls: 'clocked-in', label: 'Clocked In' },
    'on-break':   { cls: 'on-break',  label: 'On Break' },
    'clocked-out':{ cls: 'clocked-out', label: 'Done for Today' },
  }[state] || { cls: 'not-in', label: 'Not Clocked In' };

  const greetHour = new Date().getHours();
  const greet = greetHour < 12 ? 'Good morning' : greetHour < 17 ? 'Good afternoon' : 'Good evening';

  const heroTimerHTML = (state === 'clocked-in' || state === 'on-break') ? `
    <div class="fd-timer" id="fd-hero-timer">${entry ? _fwElapsedStr(entry.clock_in) : '00:00:00'}</div>
    <div class="fd-timer-sub">${state === 'on-break' ? 'Break timer running' : 'Time on the clock'}</div>` : '';

  // ── CTA buttons ───────────────────────────────────────────────────────────

  let ctaHTML = '';
  switch (state) {
    case 'not-in':
      ctaHTML = `
        <div class="fd-cta-row">
          <button class="fd-btn-primary" onclick="gwClockPillMenu_clockIn()">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            Clock In${todayJobs.length > 0 ? ' — ' + todayJobs.length + ' Job' + (todayJobs.length > 1 ? 's' : '') : ''}
          </button>
        </div>`;
      break;
    case 'clocked-in':
      ctaHTML = `
        <div class="fd-cta-row">
          <button class="fd-btn-primary break" onclick="gwClockPillMenu_startBreak()">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8h1a4 4 0 010 8h-1"/><path d="M2 8h16v9a4 4 0 01-4 4H6a4 4 0 01-4-4V8z"/></svg>
            Break
          </button>
          <button class="fd-btn-primary clock-out" onclick="gwClockPillMenu_clockOut()">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            Clock Out
          </button>
        </div>`;
      break;
    case 'on-break':
      ctaHTML = `
        <div class="fd-cta-row">
          <button class="fd-btn-primary end-break" onclick="gwClockPillMenu_endBreak()">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            End Break
          </button>
          <button class="fd-btn-secondary" onclick="gwClockPillMenu_clockOut()">Clock Out</button>
        </div>`;
      break;
    case 'clocked-out':
      ctaHTML = `
        <div class="fd-cta-row">
          <button class="fd-btn-secondary" onclick="show('timeTracker')">View My Timesheet</button>
        </div>`;
      break;
  }

  // ── Active job display ────────────────────────────────────────────────────

  const activeJobHTML = (entry && entry.work_order_id) ? (() => {
    const rState = window._avalonState || {};
    const wo = (rState.workOrders || []).find(w => w.id === entry.work_order_id);
    if (!wo) return '';
    return `
      <div class="fd-section">
        <div class="fd-section-hd">Active Job</div>
        <div class="fd-card">
          <div class="fd-card-row">
            <div class="fd-card-icon" style="background:#dcfce7">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/></svg>
            </div>
            <div style="flex:1;min-width:0">
              <div class="fd-card-label">Currently working on</div>
              <div class="fd-card-value">${_fwE(wo.title || 'Work Order #' + wo.id.slice(-4))}</div>
              ${wo.address ? `<div class="fd-card-meta">${_fwE(wo.address)}</div>` : ''}
            </div>
            <button class="fd-btn-secondary" style="font-size:11px;padding:6px 10px" onclick="gwClockPillMenu_switchJob()">Switch</button>
          </div>
        </div>
      </div>`;
  })() : '';

  // ── Today's schedule section ──────────────────────────────────────────────

  const scheduleHTML = todayJobs.length > 0 ? `
    <div class="fd-section">
      <div class="fd-section-hd">Today's Jobs (${todayJobs.length})</div>
      ${todayJobs.map(wo => `
        <div class="fd-card" style="cursor:pointer" onclick="show('workOrderList')">
          <div class="fd-card-row">
            <div class="fd-card-icon" style="background:var(--gw-surface-2,#F5F3EE)">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--gw-muted,#5E6E6F)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/></svg>
            </div>
            <div style="flex:1;min-width:0">
              <div class="fd-card-value">${_fwE(wo.title || 'Work Order #' + wo.id.slice(-4))}</div>
              <div class="fd-card-meta">${_fwE(wo.address || wo.client || '')}${wo.startTime ? ' · ' + wo.startTime : ''}</div>
            </div>
            <span style="font-size:11px;padding:3px 8px;border-radius:8px;background:var(--gw-surface-2,#F0EDE5);color:var(--gw-muted,#5E6E6F);font-weight:600;white-space:nowrap">${_fwE(wo.status || 'scheduled')}</span>
          </div>
        </div>`).join('')}
    </div>` : `
    <div class="fd-section">
      <div class="fd-section-hd">Today's Jobs</div>
      <div class="fd-card" style="text-align:center;padding:20px;color:var(--gw-muted,#5E6E6F)">
        <div style="margin-bottom:6px;font-size:13px">No jobs scheduled today</div>
        <button class="fd-btn-secondary" style="font-size:12px" onclick="show('scheduleBoard')">View Schedule</button>
      </div>
    </div>`;

  // ── Foreman / Crew section ────────────────────────────────────────────────

  let contextHTML = '';
  if (!isSupervisor && foremanName) {
    const initials = foremanName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    contextHTML = `
      <div class="fd-section">
        <div class="fd-section-hd">Your Crew / Foreman Today</div>
        <div class="fd-card">
          <div class="fd-card-row">
            <div style="width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#4D8A86,#2D7A55);display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;font-weight:800;flex-shrink:0">${_fwE(initials)}</div>
            <div style="flex:1;min-width:0">
              <div class="fd-card-value">${_fwE(foremanName)}</div>
              <div class="fd-card-meta">Crew / Foreman</div>
            </div>
          </div>
        </div>
      </div>`;
  } else if (isSupervisor && crewNames.length > 0) {
    contextHTML = `
      <div class="fd-section">
        <div class="fd-section-hd">Today's Crew (${crewNames.length})</div>
        <div class="fd-card">
          ${crewNames.map((name, i) => {
            const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
            const colors = ['#4D8A86','#2D7A55','#8B6914','#4B7BB5','#8B3A2A'];
            const color  = colors[i % colors.length];
            return `
              <div class="fd-card-row" style="${i < crewNames.length - 1 ? 'margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid var(--gw-line,#F0EDE5)' : ''}">
                <div style="width:32px;height:32px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:800;flex-shrink:0">${_fwE(initials)}</div>
                <div style="flex:1;min-width:0">
                  <div class="fd-card-value" style="font-size:13px">${_fwE(name)}</div>
                  <div class="fd-card-meta">Crew Member</div>
                </div>
              </div>`;
          }).join('')}
        </div>
      </div>`;
  }

  // ── Quick links ───────────────────────────────────────────────────────────

  const linksHTML = `
    <div class="fd-section">
      <div class="fd-section-hd">Quick Links</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <button class="fd-card" style="text-align:center;cursor:pointer;border:none;padding:14px 10px" onclick="show('scheduleBoard')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--gw-accent,#4D8A86)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom:6px"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          <div style="font-size:12px;font-weight:600;color:var(--gw-ink,#1F2A2B)">Schedule</div>
        </button>
        <button class="fd-card" style="text-align:center;cursor:pointer;border:none;padding:14px 10px" onclick="show('workOrderList')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--gw-accent,#4D8A86)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom:6px"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/></svg>
          <div style="font-size:12px;font-weight:600;color:var(--gw-ink,#1F2A2B)">Work Orders</div>
        </button>
        <button class="fd-card" style="text-align:center;cursor:pointer;border:none;padding:14px 10px" onclick="show('timeTracker')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--gw-accent,#4D8A86)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom:6px"><circle cx="12" cy="13" r="7"/><path d="M12 9v4l2.5 2M9 1h6M12 1v3"/></svg>
          <div style="font-size:12px;font-weight:600;color:var(--gw-ink,#1F2A2B)">Timesheet</div>
        </button>
        ${isSupervisor ? `
        <button class="fd-card" style="text-align:center;cursor:pointer;border:none;padding:14px 10px" onclick="show('crewView')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--gw-accent,#4D8A86)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom:6px"><circle cx="9" cy="7" r="3"/><circle cx="15" cy="7" r="3"/><path d="M3 21c0-3.3 2.7-6 6-6h6c3.3 0 6 2.7 6 6"/></svg>
          <div style="font-size:12px;font-weight:600;color:var(--gw-ink,#1F2A2B)">Crew</div>
        </button>` : `
        <button class="fd-card" style="text-align:center;cursor:pointer;border:none;padding:14px 10px" onclick="show('fieldMode')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--gw-accent,#4D8A86)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom:6px"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
          <div style="font-size:12px;font-weight:600;color:var(--gw-ink,#1F2A2B)">Field Mode</div>
        </button>`}
      </div>
    </div>`;

  // ── Report/AAR action buttons ─────────────────────────────────────────────

  const fieldActionsHTML = `
    <div class="fd-section">
      <div class="fd-section-hd">Field Actions</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="fd-card" style="display:flex;align-items:center;gap:12px;text-align:left;cursor:pointer;border:none;padding:14px 16px" onclick="fdOpenEquipReport()">
          <div style="width:36px;height:36px;border-radius:10px;background:#fef3c7;display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:700;color:var(--gw-ink,#1F2A2B)">Equipment / Supply Report</div>
            <div style="font-size:11px;color:var(--gw-muted,#5E6E6F)">Report a broken tool, truck issue, or supply request</div>
          </div>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--gw-muted,#5E6E6F)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <button class="fd-card" style="display:flex;align-items:center;gap:12px;text-align:left;cursor:pointer;border:none;padding:14px 16px" onclick="fdOpenAAR()">
          <div style="width:36px;height:36px;border-radius:10px;background:#dcfce7;display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:700;color:var(--gw-ink,#1F2A2B)">End-of-Day Report</div>
            <div style="font-size:11px;color:var(--gw-muted,#5E6E6F)">5-min after action report — required before clock-out</div>
          </div>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--gw-muted,#5E6E6F)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </div>
    </div>`;

  // ── Assemble view ─────────────────────────────────────────────────────────

  viewEl.innerHTML = `
    <div class="fd-shell">
      <!-- Hero / Clock status -->
      <div class="fd-hero">
        <div class="fd-hero-greeting">${greet}</div>
        <div class="fd-hero-name">${_fwE(rep.name || 'Field User')}</div>
        <div class="fd-status-badge ${stateInfo.cls}">
          <span class="gw-clock-dot" style="position:static;animation:${state === 'clocked-in' ? 'gw-pulse 1.5s infinite' : 'none'}"></span>
          ${_fwE(stateInfo.label)}
        </div>
        ${heroTimerHTML}
        ${ctaHTML}
      </div>

      ${activeJobHTML}
      ${scheduleHTML}
      ${contextHTML}
      <div id="fd-tasks-widget"></div>
      ${linksHTML}
      ${fieldActionsHTML}
    </div>`;

  // Load tasks async after render
  _fdLoadTasksWidget();
};

// ══════════════════════════════════════════════════════════════════════════════
// 9A-EXT — TASKS WIDGET (personal tasks for today)
// ══════════════════════════════════════════════════════════════════════════════

async function _fdLoadTasksWidget() {
  const el = document.getElementById('fd-tasks-widget');
  if (!el) return;
  const _T = (typeof window._t === 'function') ? window._t : (s => s);
  try {
    const r = await fetch('/api/tasks?scope=mine&limit=10', { credentials: 'include' });
    const d = await r.json();
    const tasks = (d.ok && d.data) ? d.data : [];
    const open = tasks.filter(t => t.status !== 'done' && t.status !== 'completed');
    if (open.length === 0) {
      el.innerHTML = `
        <div class="fd-section">
          <div class="fd-section-hd">${_T('My Tasks')}</div>
          <div class="fd-card" style="text-align:center;padding:16px;color:var(--gw-muted,#5E6E6F);font-size:13px">
            ${_T('No open tasks today')}
          </div>
        </div>`;
      return;
    }
    el.innerHTML = `
      <div class="fd-section">
        <div class="fd-section-hd" style="display:flex;justify-content:space-between;align-items:center">
          ${_T('My Tasks')}
          <span style="font-size:11px;font-weight:600;background:var(--gw-accent,#4D8A86);color:#fff;padding:2px 8px;border-radius:10px">${open.length}</span>
        </div>
        ${open.map(t => `
          <div class="fd-card" style="cursor:pointer;margin-bottom:6px" onclick="_fdToggleTask('${_fwE(t.id)}',this)">
            <div class="fd-card-row" style="gap:10px">
              <div style="width:20px;height:20px;border-radius:50%;border:2px solid ${t.priority==='high'?'#dc2626':'var(--gw-accent,#4D8A86)'};display:flex;align-items:center;justify-content:center;flex-shrink:0">
                ${t.status==='in_progress'?`<div style="width:8px;height:8px;border-radius:50%;background:var(--gw-accent,#4D8A86)"></div>`:''}
              </div>
              <div style="flex:1;min-width:0">
                <div style="font-size:13px;font-weight:600;color:var(--gw-ink,#1F2A2B)">${_fwE(t.title||'Task')}</div>
                ${t.due_date ? `<div style="font-size:11px;color:var(--gw-muted,#5E6E6F)">Due ${t.due_date}</div>` : ''}
              </div>
              ${t.priority==='high' ? `<span style="font-size:10px;font-weight:700;color:#dc2626;background:#fee2e2;padding:2px 6px;border-radius:6px">${_T('HIGH')}</span>` : ''}
            </div>
          </div>`).join('')}
      </div>`;
  } catch(e) {
    // silently fail — tasks not critical
    document.getElementById('fd-tasks-widget') && (document.getElementById('fd-tasks-widget').innerHTML = '');
  }
}

window._fdToggleTask = async function(taskId, el) {
  try {
    const _T5 = (typeof window._t === 'function') ? window._t : (s => s);
    // Use the /complete endpoint which marks status='archived' so tasks stay
    // gone after reload (PATCH is not supported — PUT /complete is the correct path)
    await fetch(`/api/tasks/${taskId}/complete`, {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    el.style.opacity = '0.4';
    el.style.textDecoration = 'line-through';
    setTimeout(() => { el.remove(); }, 800);
    if (typeof showToast === 'function') showToast(_T5('Task marked done ✓'), 'success');
  } catch(e) {}
};

// ══════════════════════════════════════════════════════════════════════════════
// 9A-EXT — EQUIPMENT / SUPPLY REPORT (bottom-sheet)
// ══════════════════════════════════════════════════════════════════════════════

window.fdOpenEquipReport = function fdOpenEquipReport() {
  document.getElementById('fd-equip-modal')?.remove();
  const _T = (typeof window._t === 'function') ? window._t : (s => s);

  const overlay = document.createElement('div');
  overlay.id = 'fd-equip-modal';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10001;display:flex;flex-direction:column;justify-content:flex-end;background:rgba(0,0,0,.5)';
  overlay.addEventListener('click', function(e){ if(e.target===overlay) overlay.remove(); });

  const sheet = document.createElement('div');
  sheet.style.cssText = 'background:var(--gw-surface,#fff);border-radius:20px 20px 0 0;max-height:90vh;overflow:auto;padding:0 0 40px';

  sheet.innerHTML = `
    <div style="display:flex;justify-content:center;padding:12px 0 8px">
      <div style="width:40px;height:4px;border-radius:2px;background:var(--gw-line,#D0CCC3)"></div>
    </div>
    <div style="padding:0 20px 16px;display:flex;align-items:center;gap:10px">
      <div style="width:36px;height:36px;border-radius:10px;background:#fef3c7;display:flex;align-items:center;justify-content:center;flex-shrink:0">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      </div>
      <div>
        <div style="font-size:17px;font-weight:700;color:var(--gw-ink,#1F2A2B)">${_T('Equipment / Supply Report')}</div>
        <div style="font-size:12px;color:var(--gw-muted,#5E6E6F)">${_T('Notify management of an issue or request')}</div>
      </div>
    </div>
    <form id="fd-equip-form" style="padding:0 20px">
      <!-- Report type -->
      <div style="margin-bottom:14px">
        <label style="font-size:12px;font-weight:600;color:var(--gw-ink,#1F2A2B);display:block;margin-bottom:6px">${_T('Report Type')} *</label>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">
          ${[
            {val:'tool',    label:_T('Broken Tool'),   icon:(typeof gwIcon==='function')?gwIcon('wrench',22,'#8B6914'):''},
            {val:'vehicle', label:_T('Truck/Vehicle'),  icon:(typeof gwIcon==='function')?gwIcon('truck',22,'#4D8A86'):''},
            {val:'supply',  label:_T('Supply Request'), icon:(typeof gwIcon==='function')?gwIcon('package',22,'#6F7E6A'):''},
          ].map(opt=>`
            <label style="display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 6px;border:2px solid var(--gw-line,#E0DDD5);border-radius:10px;cursor:pointer;font-size:11px;font-weight:600;color:var(--gw-ink,#1F2A2B);text-align:center" id="er-type-lbl-${opt.val}">
              <input type="radio" name="report_type" value="${opt.val}" style="display:none" onchange="document.querySelectorAll('[id^=er-type-lbl-]').forEach(l=>l.style.borderColor='var(--gw-line,#E0DDD5)');document.getElementById('er-type-lbl-${opt.val}').style.borderColor='#d97706'">
              <span style="display:flex;align-items:center;justify-content:center;height:22px">${opt.icon}</span>
              ${opt.label}
            </label>`).join('')}
        </div>
      </div>
      <!-- Asset / item description -->
      <div style="margin-bottom:14px">
        <label style="font-size:12px;font-weight:600;color:var(--gw-ink,#1F2A2B);display:block;margin-bottom:6px">${_T('What item / asset?')} *</label>
        <input type="text" name="asset_name" placeholder="${_T('e.g. Milwaukee Drill M18, F-250 Truck #3, Gloves')}" maxlength="120"
          style="width:100%;padding:10px 12px;border:1px solid var(--gw-line,#E0DDD5);border-radius:8px;font-size:13px;color:var(--gw-ink,#1F2A2B);background:var(--gw-surface,#fff);box-sizing:border-box" required>
      </div>
      <!-- Priority -->
      <div style="margin-bottom:14px">
        <label style="font-size:12px;font-weight:600;color:var(--gw-ink,#1F2A2B);display:block;margin-bottom:6px">${_T('Urgency')}</label>
        <select name="priority" style="width:100%;padding:10px 12px;border:1px solid var(--gw-line,#E0DDD5);border-radius:8px;font-size:13px;color:var(--gw-ink,#1F2A2B);background:var(--gw-surface,#fff);box-sizing:border-box">
          <option value="normal">${_T('Normal — handle when possible')}</option>
          <option value="high">${_T('High — need it soon')}</option>
          <option value="urgent">${_T('Urgent — blocking work today')}</option>
        </select>
      </div>
      <!-- Notes -->
      <div style="margin-bottom:20px">
        <label style="font-size:12px;font-weight:600;color:var(--gw-ink,#1F2A2B);display:block;margin-bottom:6px">${_T('Description / Notes')}</label>
        <textarea name="notes" rows="3" placeholder="${_T('Describe the issue or what you need...')}" maxlength="500"
          style="width:100%;padding:10px 12px;border:1px solid var(--gw-line,#E0DDD5);border-radius:8px;font-size:13px;color:var(--gw-ink,#1F2A2B);background:var(--gw-surface,#fff);resize:none;box-sizing:border-box"></textarea>
      </div>
      <button type="button" onclick="fdSubmitEquipReport()" style="width:100%;padding:14px;background:#d97706;border:0;border-radius:12px;color:#fff;font-size:15px;font-weight:700;cursor:pointer">
        ${_T('Submit Report')}
      </button>
      <button type="button" onclick="document.getElementById('fd-equip-modal').remove()" style="width:100%;margin-top:8px;padding:10px;background:transparent;border:0;color:var(--gw-muted,#5E6E6F);font-size:13px;cursor:pointer">${_T('Cancel')}</button>
    </form>`;

  overlay.appendChild(sheet);
  document.body.appendChild(overlay);
};

window.fdSubmitEquipReport = async function() {
  const form = document.getElementById('fd-equip-form');
  if (!form) return;
  const typeEl = form.querySelector('[name=report_type]:checked');
  const assetEl = form.querySelector('[name=asset_name]');
  const priorityEl = form.querySelector('[name=priority]');
  const notesEl = form.querySelector('[name=notes]');
  const _T2 = (typeof window._t === 'function') ? window._t : (s => s);
  if (!typeEl) { if (typeof showToast==='function') showToast(_T2('Please select a report type'), 'error'); return; }
  if (!assetEl.value.trim()) { if (typeof showToast==='function') showToast(_T2('Please describe the item or asset'), 'error'); return; }
  const btn = document.querySelector('#fd-equip-form + button, #fd-equip-form button[onclick="fdSubmitEquipReport()"]') ||
              form.querySelector('button[onclick="fdSubmitEquipReport()"]');
  if (btn) { btn.disabled = true; btn.textContent = _T2('Submitting…'); }
  try {
    const r = await fetch('/api/field-reports', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        report_type: typeEl.value,
        asset_name:  assetEl.value.trim(),
        priority:    priorityEl.value,
        notes:       notesEl.value.trim(),
      })
    });
    const j = await r.json();
    if (j.ok) {
      document.getElementById('fd-equip-modal')?.remove();
      if (typeof showToast==='function') showToast(_T2('Report submitted — management has been notified ✓'), 'success');
    } else {
      if (typeof showToast==='function') showToast(j.error || _T2('Submit failed'), 'error');
      if (btn) { btn.disabled = false; btn.textContent = _T2('Submit Report'); }
    }
  } catch(e) {
    if (typeof showToast==='function') showToast(_T2('Network error — try again'), 'error');
    if (btn) { btn.disabled = false; btn.textContent = _T2('Submit Report'); }
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// 9A-EXT — AFTER ACTION REPORT (AAR)
// Required before clock-out. Template fetched from /api/aar-template.
// ══════════════════════════════════════════════════════════════════════════════

// Public entry — opens AAR sheet directly
window.fdOpenAAR = async function fdOpenAAR(onComplete) {
  document.getElementById('fd-aar-modal')?.remove();
  const _T = (typeof window._t === 'function') ? window._t : (s => s);

  // Check if already submitted today
  let alreadyDone = false;
  try {
    const chk = await fetch('/api/aar-check-today', { credentials: 'include' });
    const chkJ = await chk.json();
    if (chkJ.submitted) {
      if (typeof showToast === 'function') showToast(_T('End-of-day report already submitted for today ✓'), 'success');
      if (onComplete) onComplete();
      return;
    }
  } catch(_) {}

  // Fetch template
  let questions = [];
  try {
    const tr = await fetch('/api/aar-template', { credentials: 'include' });
    const tj = await tr.json();
    if (tj.ok && tj.template && tj.template.questions) {
      questions = tj.template.questions;
    }
  } catch(_) {}

  if (!questions.length) {
    // Default 5-question template as fallback
    questions = [
      { id: 'q1', type: 'yesno',   text: _T('Did you complete all assigned work orders today?') },
      { id: 'q2', type: 'yesno',   text: _T('Were there any safety incidents or near-misses today?') },
      { id: 'q3', type: 'text',    text: _T('Any issues or concerns from today that need follow-up?') },
      { id: 'q4', type: 'rating',  text: _T('Overall how did today go? (1 = rough, 5 = great)') },
      { id: 'q5', type: 'text',    text: _T('Any materials, tools, or supplies needed for tomorrow?') },
    ];
  }

  const overlay = document.createElement('div');
  overlay.id = 'fd-aar-modal';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10002;display:flex;flex-direction:column;justify-content:flex-end;background:rgba(0,0,0,.6)';

  const sheet = document.createElement('div');
  sheet.style.cssText = 'background:var(--gw-surface,#fff);border-radius:20px 20px 0 0;max-height:92vh;overflow:auto;padding:0 0 48px';

  const qHTML = questions.map((q, i) => {
    const qId = `aar-q-${i}`;
    let inputHTML = '';
    switch(q.type) {
      case 'yesno':
        inputHTML = `
          <div style="display:flex;gap:8px">
            <label style="flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:10px;border:2px solid var(--gw-line,#E0DDD5);border-radius:10px;cursor:pointer;font-size:13px;font-weight:600" id="${qId}-yes-lbl">
              <input type="radio" name="${qId}" value="yes" style="display:none" onchange="document.getElementById('${qId}-yes-lbl').style.borderColor='#16a34a';document.getElementById('${qId}-no-lbl').style.borderColor='var(--gw-line,#E0DDD5)'">
              <span style="display:inline-flex;align-items:center">${(typeof gwIcon==='function')?gwIcon('check',15,'#16a34a'):''}</span> ${_T('Yes')}
            </label>
            <label style="flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:10px;border:2px solid var(--gw-line,#E0DDD5);border-radius:10px;cursor:pointer;font-size:13px;font-weight:600" id="${qId}-no-lbl">
              <input type="radio" name="${qId}" value="no" style="display:none" onchange="document.getElementById('${qId}-no-lbl').style.borderColor='#dc2626';document.getElementById('${qId}-yes-lbl').style.borderColor='var(--gw-line,#E0DDD5)'">
              <span style="display:inline-flex;align-items:center">${(typeof gwIcon==='function')?gwIcon('close',15,'#dc2626'):''}</span> ${_T('No')}
            </label>
          </div>`;
        break;
      case 'rating':
        inputHTML = `
          <div style="display:flex;gap:6px;justify-content:center">
            ${[1,2,3,4,5].map(n=>`
              <button type="button" id="${qId}-r${n}" onclick="_aarRating('${qId}',${n})"
                style="width:44px;height:44px;border-radius:50%;border:2px solid var(--gw-line,#E0DDD5);background:transparent;font-size:16px;font-weight:700;cursor:pointer;color:var(--gw-ink,#1F2A2B)">${n}</button>`).join('')}
          </div>
          <input type="hidden" name="${qId}" id="${qId}-val">`;
        break;
      case 'checklist':
        const items = Array.isArray(q.options) ? q.options : [];
        inputHTML = items.map(opt=>`
          <label style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--gw-line,#F0EDE5);cursor:pointer">
            <input type="checkbox" name="${qId}" value="${_fwE(opt)}" style="width:16px;height:16px;accent-color:var(--gw-accent,#4D8A86)">
            <span style="font-size:13px;color:var(--gw-ink,#1F2A2B)">${_fwE(opt)}</span>
          </label>`).join('');
        break;
      case 'select':
        const opts = Array.isArray(q.options) ? q.options : [];
        inputHTML = `
          <select name="${qId}" style="width:100%;padding:10px 12px;border:1px solid var(--gw-line,#E0DDD5);border-radius:8px;font-size:13px;color:var(--gw-ink,#1F2A2B);background:var(--gw-surface,#fff);box-sizing:border-box">
            <option value="">${_T('— Select —')}</option>
            ${opts.map(o=>`<option value="${_fwE(o)}">${_fwE(o)}</option>`).join('')}
          </select>`;
        break;
      default: // text
        inputHTML = `<textarea name="${qId}" rows="2" placeholder="${_T('Your answer…')}" maxlength="500"
          style="width:100%;padding:10px 12px;border:1px solid var(--gw-line,#E0DDD5);border-radius:8px;font-size:13px;color:var(--gw-ink,#1F2A2B);background:var(--gw-surface,#fff);resize:none;box-sizing:border-box"></textarea>`;
    }
    return `
      <div style="margin-bottom:20px" data-qid="${_fwE(q.id||qId)}" data-qtype="${_fwE(q.type)}">
        <div style="font-size:13px;font-weight:600;color:var(--gw-ink,#1F2A2B);margin-bottom:8px">
          <span style="color:var(--gw-accent,#4D8A86);font-size:11px;font-weight:700;margin-right:4px">${i+1}</span>
          ${_fwE(q.text)}
          ${q.required ? '<span style="color:#dc2626;margin-left:2px">*</span>' : ''}
        </div>
        ${inputHTML}
      </div>`;
  }).join('');

  sheet.innerHTML = `
    <div style="display:flex;justify-content:center;padding:12px 0 8px">
      <div style="width:40px;height:4px;border-radius:2px;background:var(--gw-line,#D0CCC3)"></div>
    </div>
    <div style="padding:0 20px 16px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--gw-line,#F0EDE5)">
      <div style="width:36px;height:36px;border-radius:10px;background:#dcfce7;display:flex;align-items:center;justify-content:center;flex-shrink:0">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
      </div>
      <div>
        <div style="font-size:17px;font-weight:700;color:var(--gw-ink,#1F2A2B)">${_T('End-of-Day Report')}</div>
        <div style="font-size:12px;color:var(--gw-muted,#5E6E6F)">${questions.length} ${_T('questions')} · ~5 min</div>
      </div>
    </div>
    <form id="fd-aar-form" style="padding:20px" data-total="${questions.length}">
      ${qHTML}
      <button type="button" id="fd-aar-submit-btn" onclick="fdSubmitAAR()" style="width:100%;padding:14px;background:#16a34a;border:0;border-radius:12px;color:#fff;font-size:15px;font-weight:700;cursor:pointer">
        ${_T('Submit & Clock Out')}
      </button>
      <button type="button" onclick="fdAARSkip()" style="width:100%;margin-top:8px;padding:10px;background:transparent;border:0;color:var(--gw-muted,#5E6E6F);font-size:12px;cursor:pointer">${_T('Save progress for later')}</button>
    </form>`;

  // Store onComplete callback on overlay
  overlay._onComplete = onComplete;
  overlay.appendChild(sheet);
  document.body.appendChild(overlay);
};

// Rating button helper
window._aarRating = function(qId, n) {
  document.getElementById(qId+'-val').value = n;
  for (let i=1; i<=5; i++) {
    const btn = document.getElementById(`${qId}-r${i}`);
    if (!btn) continue;
    btn.style.background = i <= n ? 'var(--gw-accent,#4D8A86)' : 'transparent';
    btn.style.color = i <= n ? '#fff' : 'var(--gw-ink,#1F2A2B)';
    btn.style.borderColor = i <= n ? 'var(--gw-accent,#4D8A86)' : 'var(--gw-line,#E0DDD5)';
  }
};

window.fdSubmitAAR = async function() {
  const form = document.getElementById('fd-aar-form');
  if (!form) return;
  const total = parseInt(form.dataset.total || '0');
  const answers = [];
  // Collect answers from each question block
  form.querySelectorAll('[data-qid]').forEach((block, i) => {
    const qId = block.dataset.qid;
    const qType = block.dataset.qtype;
    const fieldName = `aar-q-${i}`;
    let value = '';
    if (qType === 'yesno') {
      const sel = block.querySelector(`input[name="${fieldName}"]:checked`);
      value = sel ? sel.value : '';
    } else if (qType === 'rating') {
      const hidVal = block.querySelector(`#${fieldName}-val`);
      value = hidVal ? hidVal.value : '';
    } else if (qType === 'checklist') {
      const checked = [...block.querySelectorAll(`input[name="${fieldName}"]:checked`)].map(c => c.value);
      value = checked.join(', ');
    } else if (qType === 'select') {
      const sel = block.querySelector(`select[name="${fieldName}"]`);
      value = sel ? sel.value : '';
    } else {
      const ta = block.querySelector(`textarea[name="${fieldName}"]`);
      value = ta ? ta.value.trim() : '';
    }
    answers.push({ question_id: qId, value });
  });

  const _T3 = (typeof window._t === 'function') ? window._t : (s => s);
  const submitBtn = document.getElementById('fd-aar-submit-btn');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = _T3('Submitting…'); }

  try {
    const r = await fetch('/api/aar-submissions', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers })
    });
    const j = await r.json();
    if (j.ok) {
      const overlay = document.getElementById('fd-aar-modal');
      const cb = overlay?._onComplete;
      overlay?.remove();
      if (typeof showToast === 'function') showToast(_T3('End-of-day report submitted ✓'), 'success');
      if (cb) cb();
    } else {
      if (typeof showToast === 'function') showToast(j.error || _T3('Submit failed'), 'error');
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = _T3('Submit & Clock Out'); }
    }
  } catch(e) {
    if (typeof showToast === 'function') showToast(_T3('Network error — try again'), 'error');
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = _T3('Submit & Clock Out'); }
  }
};

window.fdAARSkip = function() {
  document.getElementById('fd-aar-modal')?.remove();
};

// ── Clock-out gate: require AAR before allowing clock-out ─────────────────────
// Override the clock-out flow to check AAR requirement first.
window._fdAARGateClockOut = async function(proceedFn) {
  try {
    const r = await fetch('/api/aar-check-today', { credentials: 'include' });
    const j = await r.json();
    if (!j.required || j.submitted) {
      // Not required or already done — proceed normally
      if (proceedFn) proceedFn();
      return;
    }
    // Required and not submitted — show AAR first, then clock out on complete
    const _T4 = (typeof window._t === 'function') ? window._t : (s => s);
    if (typeof showToast === 'function') showToast(_T4('Please complete your end-of-day report before clocking out'), 'info');
    window.fdOpenAAR(function() {
      // AAR submitted — now proceed with clock-out
      if (proceedFn) proceedFn();
    });
  } catch(_) {
    // On error, allow clock-out (don't block)
    if (proceedFn) proceedFn();
  }
};

// Wrap the existing gwClockPillMenu_clockOut to gate through AAR
(function _installAARGate() {
  function _installGate() {
    const _origClockOut = window.gwClockPillMenu_clockOut;
    if (typeof _origClockOut === 'function' && !_origClockOut._aarGated) {
      window.gwClockPillMenu_clockOut = function() {
        window._fdAARGateClockOut(function() {
          _origClockOut.call(window);
        });
      };
      window.gwClockPillMenu_clockOut._aarGated = true;
    }
  }
  // Try immediately; also retry after bootstrap in case clock pill loads later
  _installGate();
  if (window._d1BootstrapReady && typeof window._d1BootstrapReady.then === 'function') {
    window._d1BootstrapReady.then(() => { setTimeout(_installGate, 300); }).catch(()=>{});
  }
})();

// ══════════════════════════════════════════════════════════════════════════════
// 9B — JOB SELECTION
// ══════════════════════════════════════════════════════════════════════════════

/**
 * fdShowJobSelect(jobs, onConfirm, opts)
 * Shows a bottom-sheet modal with job items for selection.
 * onConfirm(selectedJobs) called with array of selected WO objects.
 */
window.fdShowJobSelect = function fdShowJobSelect(jobs, onConfirm, opts) {
  opts = opts || {};
  const singleSelect = opts.singleSelect || false;
  const title = opts.title || 'Select Today\'s Job' + (jobs.length > 1 && !singleSelect ? 's' : '');

  // Remove existing
  document.getElementById('fd-job-modal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'fd-job-modal';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;flex-direction:column;justify-content:flex-end;background:rgba(0,0,0,.5)';

  const sheet = document.createElement('div');
  sheet.style.cssText = 'background:var(--gw-surface,#fff);border-radius:20px 20px 0 0;max-height:85vh;overflow:auto;padding:0 0 40px';

  const jobsHTML = jobs.map(wo => `
    <div class="fd-job-item" id="fd-ji-${_fwE(wo.id)}" onclick="fdToggleJobItem('${_fwE(wo.id)}',${singleSelect})">
      <div class="fd-job-check">
        <svg width="10" height="10" viewBox="0 0 12 10" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 5 4 8 11 1"/></svg>
      </div>
      <div class="fd-job-body">
        <div class="fd-job-name">${_fwE(wo.title || 'Work Order #' + wo.id.slice(-4))}</div>
        <div class="fd-job-meta">${_fwE(wo.address || wo.client || '')}${wo.date ? ' · ' + wo.date : ''}</div>
      </div>
      ${wo.startTime ? `<div class="fd-job-time">${_fwE(wo.startTime)}</div>` : ''}
    </div>`).join('');

  const selectAllBtn = (!singleSelect && jobs.length > 1) ? `
    <button onclick="fdSelectAllJobs()" style="width:100%;padding:10px;background:transparent;border:1px solid var(--gw-line,#E0DDD5);border-radius:8px;font-size:12px;font-weight:600;color:var(--gw-muted,#5E6E6F);cursor:pointer;margin-bottom:8px">
      Select All (${jobs.length} jobs)
    </button>` : '';

  sheet.innerHTML = `
    <div style="display:flex;justify-content:center;padding:12px 0 8px">
      <div style="width:40px;height:4px;border-radius:2px;background:var(--gw-line,#D0CCC3)"></div>
    </div>
    <div style="padding:0 20px 16px">
      <div style="font-size:17px;font-weight:700;color:var(--gw-ink,#1F2A2B);margin-bottom:4px">${_fwE(title)}</div>
      <div style="font-size:12px;color:var(--gw-muted,#5E6E6F)">
        ${singleSelect ? 'Tap a job to select it.' : 'Tap jobs to select, then confirm.'}
      </div>
    </div>
    <div style="padding:0 20px">
      ${selectAllBtn}
      <div id="fd-job-list">${jobsHTML}</div>
      <div style="margin-top:16px;display:flex;gap:10px">
        <button onclick="fdConfirmJobSelect()" style="flex:1;padding:14px;background:#16a34a;border:0;border-radius:12px;color:#fff;font-size:15px;font-weight:700;cursor:pointer">
          ${singleSelect ? 'Select' : 'Clock In'}
        </button>
        <button onclick="fdCancelJobSelect()" style="padding:14px 18px;background:var(--gw-surface-2,#F5F3EE);border:1px solid var(--gw-line,#E0DDD5);border-radius:12px;color:var(--gw-muted,#5E6E6F);font-size:14px;font-weight:600;cursor:pointer">Cancel</button>
      </div>
      ${!singleSelect ? `<button onclick="fdSkipJobSelect()" style="width:100%;margin-top:8px;padding:10px;background:transparent;border:0;color:var(--gw-muted,#5E6E6F);font-size:12px;cursor:pointer">Clock in without selecting a job</button>` : ''}
    </div>`;

  overlay.appendChild(sheet);
  document.body.appendChild(overlay);

  // Store callback
  window._fdJobSelectCallback = onConfirm;
  window._fdJobSelectJobs = jobs;

  // Close on backdrop
  overlay.addEventListener('click', e => { if (e.target === overlay) fdCancelJobSelect(); });
};

window.fdToggleJobItem = function(woId, singleSelect) {
  if (singleSelect) {
    // Deselect all first
    document.querySelectorAll('.fd-job-item.selected').forEach(el => el.classList.remove('selected'));
  }
  const el = document.getElementById('fd-ji-' + woId);
  if (el) el.classList.toggle('selected');
};

window.fdSelectAllJobs = function() {
  document.querySelectorAll('.fd-job-item').forEach(el => el.classList.add('selected'));
};

window.fdConfirmJobSelect = function() {
  const selected = [...document.querySelectorAll('.fd-job-item.selected')].map(el => {
    const id = el.id.replace('fd-ji-', '');
    return (window._fdJobSelectJobs || []).find(j => j.id === id);
  }).filter(Boolean);

  document.getElementById('fd-job-modal')?.remove();
  if (typeof window._fdJobSelectCallback === 'function') {
    window._fdJobSelectCallback(selected);
  }
  window._fdJobSelectCallback = null;
  window._fdJobSelectJobs = null;
};

window.fdCancelJobSelect = function() {
  document.getElementById('fd-job-modal')?.remove();
  window._fdJobSelectCallback = null;
  window._fdJobSelectJobs = null;
};

window.fdSkipJobSelect = function() {
  document.getElementById('fd-job-modal')?.remove();
  if (typeof window._fdJobSelectCallback === 'function') {
    window._fdJobSelectCallback([]);
  }
  window._fdJobSelectCallback = null;
  window._fdJobSelectJobs = null;
};

/**
 * fdClockInWithJobs(selectedWOs)
 * Clock in against an array of scheduled work orders.
 * Primary job = first selected; remaining jobs are noted.
 */
window.fdClockInWithJobs = async function fdClockInWithJobs(selectedWOs) {
  if (!selectedWOs || selectedWOs.length === 0) {
    await _gwPillClockInGeneric();
    return;
  }
  const primary = selectedWOs[0];
  const jobLabel = primary.title || 'Work Order #' + primary.id.slice(-4);
  const notes = selectedWOs.length > 1
    ? 'Jobs: ' + selectedWOs.map(w => w.title || w.id).join(', ')
    : '';

  try {
    const res = await fetch('/api/time/clock-in/job', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workOrderId: primary.id,
        jobLabel,
        jobType: 'General Work',
        notes
      })
    });
    const j = await res.json();
    if (j.ok) {
      if (window._ttState) {
        window._ttState.activeEntry = {
          id: j.data.id,
          clock_in: j.data.clock_in,
          job_type: 'General Work',
          job_label: jobLabel,
          work_order_id: j.data.work_order_id
        };
      }
      _gwPillState = 'clocked-in';
      gwRenderClockPill('clocked-in');
      if (typeof ttRenderSidebarWidget === 'function') ttRenderSidebarWidget();
      if (typeof ttStartRing === 'function') ttStartRing();
      if (typeof showToast === 'function') showToast('Clocked in — ' + jobLabel, 'success');
      if (window._currentView === 'fieldDashboard') fieldDashboard();
    } else {
      if (typeof showToast === 'function') showToast(j.error || 'Could not clock in', 'error');
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast('Network error', 'error');
  }
};

/**
 * fdSwitchJob(newWorkOrderId)
 * Mid-day job switch: clock out of current entry, clock in on new one.
 */
window.fdSwitchJob = async function fdSwitchJob(newWorkOrderId) {
  const entry = window._ttState && window._ttState.activeEntry;
  if (!entry) { if (typeof showToast === 'function') showToast('Not clocked in', 'error'); return; }

  const rState = window._avalonState || {};
  const wo = (rState.workOrders || []).find(w => w.id === newWorkOrderId);
  const jobLabel = wo ? (wo.title || 'Work Order #' + wo.id.slice(-4)) : 'New Job';

  try {
    // Clock out of current
    await fetch(`/api/time/clock-out/${entry.id}`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: 'Switched to: ' + jobLabel })
    });

    // Clock into new job
    const res = await fetch('/api/time/clock-in/job', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workOrderId: newWorkOrderId, jobLabel, jobType: 'General Work' })
    });
    const j = await res.json();
    if (j.ok) {
      if (window._ttState) {
        window._ttState.activeEntry = {
          id: j.data.id,
          clock_in: j.data.clock_in,
          job_type: 'General Work',
          job_label: jobLabel,
          work_order_id: newWorkOrderId
        };
      }
      _gwPillState = 'clocked-in';
      gwRenderClockPill('clocked-in');
      if (typeof ttRenderSidebarWidget === 'function') ttRenderSidebarWidget();
      if (typeof showToast === 'function') showToast('Switched to ' + jobLabel, 'success');
      if (window._currentView === 'fieldDashboard') fieldDashboard();
    } else {
      if (typeof showToast === 'function') showToast(j.error || 'Switch failed', 'error');
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast('Network error', 'error');
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// 9C — ADMIN TIMESHEET ROLL-UP
// ══════════════════════════════════════════════════════════════════════════════

window.gwTimesheetAdmin = async function gwTimesheetAdmin() {
  const viewEl = document.getElementById('view');
  if (!viewEl) return;

  // Date range defaults: current week Mon–Sun
  const now   = new Date();
  const day   = now.getDay();
  const mon   = new Date(now); mon.setDate(now.getDate() - (day === 0 ? 6 : day - 1)); mon.setHours(0,0,0,0);
  const sun   = new Date(mon); sun.setDate(mon.getDate() + 6);
  const from  = window._gwTsFrom || mon.toISOString().slice(0, 10);
  const to    = window._gwTsTo   || sun.toISOString().slice(0, 10);

  function fmtMin(min) {
    if (!min) return '—';
    const h = Math.floor(min / 60); const m = min % 60;
    return `${h}h ${String(m).padStart(2, '0')}m`;
  }
  function fmtDec(min) { return min ? (min / 60).toFixed(2) : '0.00'; }

  viewEl.innerHTML = `
    <div class="view-wrap">
      <div class="page-header" style="margin-bottom:20px">
        <div>
          <h1 class="page-title">Timesheet Review</h1>
          <p class="page-sub">Employee time by period — review, approve, flag exceptions.</p>
        </div>
        <button class="primary-btn" onclick="gwWorkdaySettings()">Workday Settings</button>
      </div>

      <!-- Date range picker -->
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:6px;background:var(--gw-surface,#fff);border:1px solid var(--gw-line,#E0DDD5);border-radius:8px;padding:6px 10px">
          <label style="font-size:11px;font-weight:700;color:var(--gw-muted,#5E6E6F);text-transform:uppercase;letter-spacing:.06em">From</label>
          <input type="date" id="ts-from" value="${from}" style="border:0;font-size:13px;color:var(--gw-ink,#1F2A2B);background:transparent;cursor:pointer">
        </div>
        <span style="font-size:13px;color:var(--gw-muted)">→</span>
        <div style="display:flex;align-items:center;gap:6px;background:var(--gw-surface,#fff);border:1px solid var(--gw-line,#E0DDD5);border-radius:8px;padding:6px 10px">
          <label style="font-size:11px;font-weight:700;color:var(--gw-muted,#5E6E6F);text-transform:uppercase;letter-spacing:.06em">To</label>
          <input type="date" id="ts-to" value="${to}" style="border:0;font-size:13px;color:var(--gw-ink,#1F2A2B);background:transparent;cursor:pointer">
        </div>
        <button onclick="_gwTsRefresh()" class="secondary-btn">Refresh</button>
        <div style="margin-left:auto;display:flex;gap:8px">
          <button class="secondary-btn" onclick="_gwTsWeek(-1)">← Prev Week</button>
          <button class="secondary-btn" onclick="_gwTsWeek(0)">This Week</button>
          <button class="secondary-btn" onclick="_gwTsWeek(1)">Next Week →</button>
        </div>
      </div>

      <!-- Summary + Exceptions tabs -->
      <div style="display:flex;gap:4px;margin-bottom:16px;border-bottom:2px solid var(--gw-line,#E0DDD5)">
        <button id="ts-tab-summary" onclick="_gwTsTab('summary')" style="padding:8px 16px;font-size:13px;font-weight:600;background:transparent;border:0;cursor:pointer;color:var(--gw-accent,#4D8A86);border-bottom:2px solid var(--gw-accent,#4D8A86);margin-bottom:-2px">Summary</button>
        <button id="ts-tab-exceptions" onclick="_gwTsTab('exceptions')" style="padding:8px 16px;font-size:13px;font-weight:600;background:transparent;border:0;cursor:pointer;color:var(--gw-muted,#5E6E6F)">Exceptions</button>
      </div>

      <div id="ts-content">
        <div style="padding:40px;text-align:center;color:var(--gw-muted)">Loading…</div>
      </div>
    </div>`;

  window._gwTsFrom = from;
  window._gwTsTo   = to;
  window._gwTsActiveTab = window._gwTsActiveTab || 'summary';
  await _gwTsLoad();
};

window._gwTsRefresh = async function() {
  window._gwTsFrom = document.getElementById('ts-from')?.value;
  window._gwTsTo   = document.getElementById('ts-to')?.value;
  await _gwTsLoad();
};

window._gwTsWeek = function(offset) {
  const now   = new Date();
  const day   = now.getDay();
  const mon   = new Date(now);
  mon.setDate(now.getDate() - (day === 0 ? 6 : day - 1) + offset * 7);
  mon.setHours(0, 0, 0, 0);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  window._gwTsFrom = mon.toISOString().slice(0, 10);
  window._gwTsTo   = sun.toISOString().slice(0, 10);
  const fi = document.getElementById('ts-from'); if (fi) fi.value = window._gwTsFrom;
  const ti = document.getElementById('ts-to');   if (ti) ti.value = window._gwTsTo;
  _gwTsLoad();
};

window._gwTsTab = function(tab) {
  window._gwTsActiveTab = tab;
  document.getElementById('ts-tab-summary')?.setAttribute('style',
    `padding:8px 16px;font-size:13px;font-weight:600;background:transparent;border:0;cursor:pointer;${tab==='summary'?'color:var(--gw-accent,#4D8A86);border-bottom:2px solid var(--gw-accent,#4D8A86);margin-bottom:-2px':'color:var(--gw-muted,#5E6E6F)'}`);
  document.getElementById('ts-tab-exceptions')?.setAttribute('style',
    `padding:8px 16px;font-size:13px;font-weight:600;background:transparent;border:0;cursor:pointer;${tab==='exceptions'?'color:var(--gw-accent,#4D8A86);border-bottom:2px solid var(--gw-accent,#4D8A86);margin-bottom:-2px':'color:var(--gw-muted,#5E6E6F)'}`);
  _gwTsLoad();
};

async function _gwTsLoad() {
  const content = document.getElementById('ts-content');
  if (!content) return;
  const from = window._gwTsFrom || new Date(Date.now() - 7*86400000).toISOString().slice(0,10);
  const to   = window._gwTsTo   || new Date().toISOString().slice(0,10);
  const tab  = window._gwTsActiveTab || 'summary';

  content.innerHTML = '<div style="padding:40px;text-align:center;color:var(--gw-muted)">Loading…</div>';

  function fmtMin(min) {
    if (!min) return '—';
    const h = Math.floor(min / 60); const m = min % 60;
    return `${h}h ${String(m).padStart(2, '0')}m`;
  }
  function fmtDec(min) { return min ? (min / 60).toFixed(2) : '0.00'; }

  try {
    if (tab === 'summary') {
      const res  = await fetch(`/api/time/timesheet-summary?from=${from}&to=${to}`, { credentials: 'include' });
      const j    = await res.json();
      const rows = j.ok ? (j.data || []) : [];

      if (rows.length === 0) {
        content.innerHTML = '<div style="padding:40px;text-align:center;color:var(--gw-muted)">No time entries in this range.</div>';
        return;
      }

      const totalMin  = rows.reduce((s, r) => s + (r.total_minutes || 0), 0);
      const totalBreak = rows.reduce((s, r) => s + (r.total_break_minutes || 0), 0);
      const openCount  = rows.reduce((s, r) => s + (r.open_entries || 0), 0);

      content.innerHTML = `
        <!-- KPI row -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:20px">
          <div style="background:var(--gw-surface,#fff);border:1px solid var(--gw-line,#E0DDD5);border-radius:10px;padding:14px 16px">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--gw-muted,#5E6E6F);margin-bottom:4px">Total Hours</div>
            <div style="font-size:22px;font-weight:800;color:var(--gw-ink,#1F2A2B)">${fmtMin(totalMin)}</div>
          </div>
          <div style="background:var(--gw-surface,#fff);border:1px solid var(--gw-line,#E0DDD5);border-radius:10px;padding:14px 16px">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--gw-muted,#5E6E6F);margin-bottom:4px">Break Time</div>
            <div style="font-size:22px;font-weight:800;color:var(--gw-ink,#1F2A2B)">${fmtMin(totalBreak)}</div>
          </div>
          <div style="background:var(--gw-surface,#fff);border:1px solid var(--gw-line,#E0DDD5);border-radius:10px;padding:14px 16px">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--gw-muted,#5E6E6F);margin-bottom:4px">Employees</div>
            <div style="font-size:22px;font-weight:800;color:var(--gw-ink,#1F2A2B)">${rows.length}</div>
          </div>
          ${openCount > 0 ? `
          <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:14px 16px">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#c2410c;margin-bottom:4px">Open Entries</div>
            <div style="font-size:22px;font-weight:800;color:#ea580c">${openCount}</div>
          </div>` : ''}
        </div>

        <!-- Employee table -->
        <div style="background:var(--gw-surface,#fff);border:1px solid var(--gw-line,#E0DDD5);border-radius:12px;overflow:hidden">
          <table class="ts-table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Role</th>
                <th>Entries</th>
                <th>Total Time</th>
                <th>Break</th>
                <th>Net Time</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(r => {
                const netMin = (r.total_minutes || 0) - (r.total_break_minutes || 0);
                const overHours = netMin > 8 * 60 * (r.entry_count || 1);
                const hasPending = r.pending_approval > 0;
                const hasOpen    = r.open_entries > 0;
                return `<tr>
                  <td style="font-weight:600">${_fwE(r.rep_name || r.rep_id)}</td>
                  <td style="color:var(--gw-muted,#5E6E6F)">${_fwE(r.rep_role || '')}</td>
                  <td>${r.entry_count || 0}</td>
                  <td>${fmtMin(r.total_minutes)}</td>
                  <td style="color:var(--gw-muted,#5E6E6F)">${fmtMin(r.total_break_minutes)}</td>
                  <td style="font-weight:600">${fmtMin(netMin)}</td>
                  <td>
                    ${hasOpen    ? '<span class="ts-badge open">Open</span> '    : ''}
                    ${hasPending ? '<span class="ts-badge pending">Pending</span> ' : ''}
                    ${overHours  ? '<span class="ts-badge overtime">OT</span>'   : ''}
                    ${!hasOpen && !hasPending && !overHours ? '<span class="ts-badge approved">OK</span>' : ''}
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>`;
    } else {
      // Exceptions tab
      const res = await fetch(`/api/time/exceptions?from=${from}&to=${to}`, { credentials: 'include' });
      const j   = await res.json();
      const exc = j.ok ? j.data : { missed_clock_out: [], overtime: [] };
      const missed   = exc.missed_clock_out || [];
      const overtime = exc.overtime || [];

      if (missed.length === 0 && overtime.length === 0) {
        content.innerHTML = '<div style="padding:40px;text-align:center;color:var(--gw-muted)">No exceptions in this range. All clean.</div>';
        return;
      }

      content.innerHTML = `
        ${missed.length > 0 ? `
        <div style="margin-bottom:20px">
          <div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#991b1b;margin-bottom:8px">Missed Clock-Out (${missed.length})</div>
          <div style="background:var(--gw-surface,#fff);border:1px solid #fecaca;border-radius:12px;overflow:hidden">
            <table class="ts-table">
              <thead><tr><th>Employee</th><th>Clocked In</th><th>Duration (estimated)</th><th>Action</th></tr></thead>
              <tbody>
                ${missed.map(e => `<tr>
                  <td style="font-weight:600">${_fwE(e.rep_name || e.rep_id)}</td>
                  <td>${_fwE(new Date(e.clock_in).toLocaleString())}</td>
                  <td>
                    <span class="ts-badge missed">Missed punch</span>
                  </td>
                  <td>
                    <button onclick="_gwTsForceClockOut('${_fwE(e.id)}')" style="font-size:11px;padding:4px 10px;border:1px solid var(--gw-line,#E0DDD5);border-radius:6px;background:var(--gw-surface-2,#FAFAF8);cursor:pointer;color:var(--gw-ink,#1F2A2B)">Force Close</button>
                  </td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>` : ''}

        ${overtime.length > 0 ? `
        <div>
          <div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#c2410c;margin-bottom:8px">Overtime Flags (${overtime.length})</div>
          <div style="background:var(--gw-surface,#fff);border:1px solid #fed7aa;border-radius:12px;overflow:hidden">
            <table class="ts-table">
              <thead><tr><th>Employee</th><th>Date</th><th>Total Time</th><th>Job</th></tr></thead>
              <tbody>
                ${overtime.map(e => `<tr>
                  <td style="font-weight:600">${_fwE(e.rep_name || e.rep_id)}</td>
                  <td>${_fwE(e.clock_in ? new Date(e.clock_in).toLocaleDateString() : '—')}</td>
                  <td><span class="ts-badge overtime">${Math.round((e.duration_min||0)/60*10)/10}h</span></td>
                  <td style="color:var(--gw-muted,#5E6E6F)">${_fwE(e.work_order_id || e.job_type || '—')}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>` : ''}`;
    }
  } catch (e) {
    content.innerHTML = `<div style="padding:40px;text-align:center;color:var(--gw-muted)">Error loading timesheet data.</div>`;
    console.error('[gwTimesheetAdmin]', e);
  }
}

window._gwTsForceClockOut = async function(entryId) {
  if (!confirm('Force clock-out this entry? This will set clock_out to now and calculate duration.')) return;
  try {
    const res = await fetch(`/api/time/clock-out/${entryId}`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: 'Admin force close — missed clock-out' })
    });
    const j = await res.json();
    if (j.ok) {
      if (typeof showToast === 'function') showToast('Entry closed.', 'success');
      _gwTsLoad();
    } else {
      if (typeof showToast === 'function') showToast(j.error || 'Failed', 'error');
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast('Network error', 'error');
  }
};

// ── 9C: Workday Settings ──────────────────────────────────────────────────────

window.gwWorkdaySettings = async function gwWorkdaySettings() {
  const viewEl = document.getElementById('view');
  if (!viewEl) return;

  viewEl.innerHTML = `
    <div class="view-wrap">
      <div class="page-header" style="margin-bottom:24px">
        <div>
          <h1 class="page-title">Workday Settings</h1>
          <p class="page-sub">Configure shift hours, overtime rules, and field prompting behavior.</p>
        </div>
        <button class="secondary-btn" onclick="gwTimesheetAdmin()">← Timesheet</button>
      </div>
      <div id="wd-form-area">
        <div style="padding:40px;text-align:center;color:var(--gw-muted)">Loading…</div>
      </div>
    </div>`;

  try {
    const res = await fetch('/api/workday-settings', { credentials: 'include' });
    const j   = await res.json();
    const s   = (j.ok && j.data) ? j.data : {
      working_days: '1,2,3,4,5', shift_start: '07:00', shift_end: '17:00',
      lunch_minutes: 30, grace_period_minutes: 10, late_threshold_minutes: 15,
      overtime_threshold_hours: 8.0, missed_punch_flag: 1, prompt_clock_in: 1
    };

    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const activeDays = new Set((s.working_days || '1,2,3,4,5').split(',').map(Number));
    const dayBtns = [1,2,3,4,5,6,0].map(d => `
      <button type="button" id="wd-day-${d}" onclick="_gwWdToggleDay(${d})"
        style="padding:7px 10px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;border:1.5px solid ${activeDays.has(d) ? 'var(--gw-accent,#4D8A86)' : 'var(--gw-line,#E0DDD5)'};background:${activeDays.has(d) ? 'var(--gw-accent,#4D8A86)12' : 'transparent'};color:${activeDays.has(d) ? 'var(--gw-accent,#4D8A86)' : 'var(--gw-muted,#5E6E6F)'}">
        ${dayNames[d]}
      </button>`).join('');

    document.getElementById('wd-form-area').innerHTML = `
      <form id="wd-form" onsubmit="_gwWdSave(event)">
        <!-- Working days -->
        <div style="background:var(--gw-surface,#fff);border:1px solid var(--gw-line,#E0DDD5);border-radius:12px;padding:20px;margin-bottom:14px">
          <div style="font-size:12px;font-weight:700;color:var(--gw-muted,#5E6E6F);text-transform:uppercase;letter-spacing:.07em;margin-bottom:12px">Working Days</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">${dayBtns}</div>
          <input type="hidden" id="wd-working-days" name="working_days" value="${_fwE(s.working_days || '1,2,3,4,5')}">
        </div>

        <!-- Shift times -->
        <div style="background:var(--gw-surface,#fff);border:1px solid var(--gw-line,#E0DDD5);border-radius:12px;padding:20px;margin-bottom:14px">
          <div style="font-size:12px;font-weight:700;color:var(--gw-muted,#5E6E6F);text-transform:uppercase;letter-spacing:.07em;margin-bottom:12px">Shift Hours</div>
          <div class="wd-settings-grid">
            <div class="wd-field">
              <label>Shift Start</label>
              <input type="time" name="shift_start" value="${_fwE(s.shift_start || '07:00')}">
            </div>
            <div class="wd-field">
              <label>Shift End</label>
              <input type="time" name="shift_end" value="${_fwE(s.shift_end || '17:00')}">
            </div>
            <div class="wd-field">
              <label>Lunch / Unpaid Break (min)</label>
              <input type="number" name="lunch_minutes" value="${s.lunch_minutes ?? 30}" min="0" max="120">
            </div>
            <div class="wd-field">
              <label>Grace Period (min)</label>
              <input type="number" name="grace_period_minutes" value="${s.grace_period_minutes ?? 10}" min="0" max="60">
            </div>
          </div>
        </div>

        <!-- Overtime / late thresholds -->
        <div style="background:var(--gw-surface,#fff);border:1px solid var(--gw-line,#E0DDD5);border-radius:12px;padding:20px;margin-bottom:14px">
          <div style="font-size:12px;font-weight:700;color:var(--gw-muted,#5E6E6F);text-transform:uppercase;letter-spacing:.07em;margin-bottom:12px">Rules &amp; Thresholds</div>
          <div class="wd-settings-grid">
            <div class="wd-field">
              <label>Late Threshold (min after start)</label>
              <input type="number" name="late_threshold_minutes" value="${s.late_threshold_minutes ?? 15}" min="0" max="120">
            </div>
            <div class="wd-field">
              <label>OT Threshold (hours/day)</label>
              <input type="number" name="overtime_threshold_hours" value="${s.overtime_threshold_hours ?? 8}" step="0.5" min="4" max="16">
            </div>
          </div>
        </div>

        <!-- Prompting toggles -->
        <div style="background:var(--gw-surface,#fff);border:1px solid var(--gw-line,#E0DDD5);border-radius:12px;padding:20px;margin-bottom:20px">
          <div style="font-size:12px;font-weight:700;color:var(--gw-muted,#5E6E6F);text-transform:uppercase;letter-spacing:.07em;margin-bottom:4px">Prompting &amp; Flags</div>
          <div class="wd-toggle-row">
            <div>
              <div class="wd-toggle-label">Prompt field users to clock in</div>
              <div class="wd-toggle-sub">Show clock-in reminder on field dashboard if shift has started</div>
            </div>
            <label style="position:relative;display:inline-block;width:44px;height:24px;flex-shrink:0">
              <input type="checkbox" name="prompt_clock_in" id="wd-prompt" ${s.prompt_clock_in ? 'checked' : ''} style="opacity:0;width:0;height:0">
              <span onclick="_gwWdToggleCheck('wd-prompt')" style="position:absolute;inset:0;border-radius:12px;background:${s.prompt_clock_in ? 'var(--gw-accent,#4D8A86)' : '#ccc'};cursor:pointer;transition:.2s" id="wd-prompt-track">
                <span style="position:absolute;top:2px;left:${s.prompt_clock_in ? '22' : '2'}px;width:20px;height:20px;border-radius:50%;background:#fff;transition:.2s" id="wd-prompt-knob"></span>
              </span>
            </label>
          </div>
          <div class="wd-toggle-row">
            <div>
              <div class="wd-toggle-label">Flag missed clock-outs</div>
              <div class="wd-toggle-sub">Mark entries still open past end-of-shift as missed punch</div>
            </div>
            <label style="position:relative;display:inline-block;width:44px;height:24px;flex-shrink:0">
              <input type="checkbox" name="missed_punch_flag" id="wd-missed" ${s.missed_punch_flag ? 'checked' : ''} style="opacity:0;width:0;height:0">
              <span onclick="_gwWdToggleCheck('wd-missed')" style="position:absolute;inset:0;border-radius:12px;background:${s.missed_punch_flag ? 'var(--gw-accent,#4D8A86)' : '#ccc'};cursor:pointer;transition:.2s" id="wd-missed-track">
                <span style="position:absolute;top:2px;left:${s.missed_punch_flag ? '22' : '2'}px;width:20px;height:20px;border-radius:50%;background:#fff;transition:.2s" id="wd-missed-knob"></span>
              </span>
            </label>
          </div>
        </div>

        <button type="submit" class="primary-btn" style="min-width:160px">Save Settings</button>
      </form>`;

    // Store active days for toggle
    window._gwWdActiveDays = new Set(activeDays);
  } catch (e) {
    document.getElementById('wd-form-area').innerHTML = '<div style="padding:40px;text-align:center;color:var(--gw-muted)">Error loading settings.</div>';
  }
};

window._gwWdToggleDay = function(dayNum) {
  if (!window._gwWdActiveDays) window._gwWdActiveDays = new Set();
  const btn = document.getElementById('wd-day-' + dayNum);
  if (!btn) return;
  const active = window._gwWdActiveDays.has(dayNum);
  if (active) {
    window._gwWdActiveDays.delete(dayNum);
    btn.style.borderColor = 'var(--gw-line,#E0DDD5)';
    btn.style.background  = 'transparent';
    btn.style.color       = 'var(--gw-muted,#5E6E6F)';
  } else {
    window._gwWdActiveDays.add(dayNum);
    btn.style.borderColor = 'var(--gw-accent,#4D8A86)';
    btn.style.background  = 'var(--gw-accent,#4D8A86)12';
    btn.style.color       = 'var(--gw-accent,#4D8A86)';
  }
  const inp = document.getElementById('wd-working-days');
  if (inp) inp.value = [...window._gwWdActiveDays].sort().join(',');
};

window._gwWdToggleCheck = function(id) {
  const chk   = document.getElementById(id);
  const track = document.getElementById(id + '-track');
  const knob  = document.getElementById(id + '-knob');
  if (!chk) return;
  chk.checked = !chk.checked;
  const on = chk.checked;
  if (track) track.style.background = on ? 'var(--gw-accent,#4D8A86)' : '#ccc';
  if (knob)  knob.style.left = on ? '22px' : '2px';
};

window._gwWdSave = async function(e) {
  e.preventDefault();
  const form = document.getElementById('wd-form');
  if (!form) return;
  const fd = new FormData(form);
  const payload = {
    working_days:             fd.get('working_days') || '1,2,3,4,5',
    shift_start:              fd.get('shift_start') || '07:00',
    shift_end:                fd.get('shift_end') || '17:00',
    lunch_minutes:            parseInt(fd.get('lunch_minutes')) || 30,
    grace_period_minutes:     parseInt(fd.get('grace_period_minutes')) || 10,
    late_threshold_minutes:   parseInt(fd.get('late_threshold_minutes')) || 15,
    overtime_threshold_hours: parseFloat(fd.get('overtime_threshold_hours')) || 8.0,
    missed_punch_flag:        document.getElementById('wd-missed')?.checked ? 1 : 0,
    prompt_clock_in:          document.getElementById('wd-prompt')?.checked ? 1 : 0,
  };
  try {
    const res = await fetch('/api/workday-settings', {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const j = await res.json();
    if (j.ok) {
      window._gwWorkdaySettings = payload;
      if (typeof showToast === 'function') showToast('Workday settings saved.', 'success');
    } else {
      if (typeof showToast === 'function') showToast(j.error || 'Save failed', 'error');
    }
  } catch (err) {
    if (typeof showToast === 'function') showToast('Network error', 'error');
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// INIT — called after D1 bootstrap resolves
// ══════════════════════════════════════════════════════════════════════════════

// Hook into D1 bootstrap promise to init the clock pill
(function _gwFieldWorkdayInit() {
  if (window._d1BootstrapReady && typeof window._d1BootstrapReady.then === 'function') {
    window._d1BootstrapReady.then(() => {
      setTimeout(() => {
        if (typeof window.gwInitClockPill === 'function') {
          window.gwInitClockPill();
        }
      }, 200);
    }).catch(() => {});
  } else {
    // Fallback: try after DOMContentLoaded
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(() => { if (typeof window.gwInitClockPill === 'function') window.gwInitClockPill(); }, 1500);
    });
  }
})();

console.info('[GW Field Workday] Phase 9 initialized — clock pill + field dashboard + job selection + timesheet admin.');
