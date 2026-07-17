// ── Groundwork CRM — Recurring Service Plans v2 ───────────────────────────────
// Full-featured: plan builder · subscription management · per-visit detail
// visit scheduling · crew/employee assignment · priority notes with ACK gate
// task checklists · photo attach · complete-visit flow
// ─────────────────────────────────────────────────────────────────────────────

/* ── Frequency helpers ─────────────────────────────────────────────────────── */
const _rpFreqLabels = {
  weekly:'Weekly', biweekly:'Bi-Weekly', monthly:'Monthly',
  bimonthly:'Every 2 Months', quarterly:'Quarterly',
  semiannual:'Semi-Annual', annual:'Annual', custom:'Custom',
};
const _rpFreqDays = { weekly:7,biweekly:14,monthly:30,bimonthly:60,quarterly:91,semiannual:182,annual:365 };

function _rpFmt(n)  { return '$'+(Number(n)||0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,','); }
function _rpDate(d) {
  if(!d) return '—';
  const dt=new Date(d+'T00:00:00');
  return dt.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
}
function _rpDateShort(d) {
  if(!d) return '—';
  const dt=new Date(d+'T00:00:00');
  return dt.toLocaleDateString('en-US',{month:'short',day:'numeric'});
}
function _rpDaysUntil(d) {
  if(!d) return null;
  const ms=new Date(d+'T00:00:00').getTime()-new Date(new Date().toDateString()).getTime();
  return Math.round(ms/86400000);
}
function _rpParseJSON(str, fallback) {
  if(!str) return fallback;
  try { return JSON.parse(str); } catch(_) { return fallback; }
}
function _rpStatusBadge(status) {
  const cfg = {
    active:    {cls:'rp-badge--active',    label:'Active'},
    paused:    {cls:'rp-badge--paused',    label:'Paused'},
    cancelled: {cls:'rp-badge--cancelled', label:'Cancelled'},
    completed: {cls:'rp-badge--completed', label:'Completed'},
    scheduled: {cls:'rp-badge--scheduled', label:'Scheduled'},
    in_progress:{cls:'rp-badge--inprog',  label:'In Progress'},
    skipped:   {cls:'rp-badge--skipped',  label:'Skipped'},
  };
  const s=cfg[status]||cfg.scheduled;
  return `<span class="rp-badge ${s.cls}">${s.label}</span>`;
}

/* ── State ─────────────────────────────────────────────────────────────────── */
let _rpTab = 'visits'; // 'plans' | 'subscriptions' | 'visits'

/* ══ Main entry point ════════════════════════════════════════════════════════ */
window.gwRecurringPlans = function() {
  const panel = document.getElementById('view') ||
                document.getElementById('contentArea') ||
                document.getElementById('premiumContent');
  if (!panel) return;
  _rpInjectCSS();
  panel.innerHTML = _rpShell();
  _rpLoadTab(_rpTab);
};

function _rpShell() {
  return `<div class="gwp-shell rp-wrap">
    <header class="gwp-header">
      <div class="gwp-header-left">
        <h1 class="gwp-title" style="display:flex;align-items:center;gap:9px">${gwIcon('repeat',20,'#2D7A55')} Recurring Services</h1>
        <span class="gwp-subtitle">Plans, subscriptions &amp; scheduled visits</span>
      </div>
      <div id="rpTopbarActions" class="gwp-header-actions"></div>
    </header>
    <div class="gwp-tab-bar rp-tab-bar" style="max-width:420px">
      <button class="gwp-tab rp-tab${_rpTab==='visits'?' gwp-tab--active':''}" onclick="_rpLoadTab('visits')">${gwIcon('calendar',13,'currentColor')} Schedule</button>
      <button class="gwp-tab rp-tab${_rpTab==='subscriptions'?' gwp-tab--active':''}" onclick="_rpLoadTab('subscriptions')">${gwIcon('user',13,'currentColor')} Clients</button>
      <button class="gwp-tab rp-tab${_rpTab==='plans'?' gwp-tab--active':''}" onclick="_rpLoadTab('plans')">${gwIcon('list',13,'currentColor')} Plans</button>
    </div>
    <div id="rpContent" class="rp-content">
      <div class="rp-loading">${gwIcon('hourglass',20,'#9CA3AF')} Loading…</div>
    </div>
  </div>`;
}

window._rpLoadTab = function(tab) {
  _rpTab = tab;
  document.querySelectorAll('.rp-tab').forEach(t => {
    const on = (tab==='visits'&&t.textContent.includes('Schedule'))||
      (tab==='subscriptions'&&t.textContent.includes('Clients'))||
      (tab==='plans'&&t.textContent.includes('Plans'));
    t.classList.toggle('rp-tab--active', on);
    t.classList.toggle('gwp-tab--active', on);
  });
  const actions = document.getElementById('rpTopbarActions');
  if (actions) {
    actions.innerHTML =
      tab==='plans'         ? `<button class="gwp-btn-primary" onclick="_rpOpenPlanBuilder(null)">${gwIcon('plus',13,'#fff')} New Plan</button>` :
      tab==='subscriptions' ? `<button class="gwp-btn-primary" onclick="_rpOpenSubscribeModal()">${gwIcon('plus',13,'#fff')} Subscribe Client</button>` :
      `<button class="gwp-btn-primary" onclick="_rpOpenScheduleVisit()">${gwIcon('plus',13,'#fff')} Schedule Visit</button>`;
  }
  if (tab==='plans')         _rpLoadPlans();
  if (tab==='subscriptions') _rpLoadSubscriptions();
  if (tab==='visits')        _rpLoadVisits();
};

/* ══════════════════════════════════════════════════════════════════════════════
   TAB 1 — VISIT SCHEDULE
   List upcoming + overdue visits with full detail access
   ══════════════════════════════════════════════════════════════════════════════ */
async function _rpLoadVisits() {
  const content = document.getElementById('rpContent');
  if (!content) return;
  content.innerHTML = `<div class="rp-loading">${gwIcon('hourglass',20,'#9CA3AF')} Loading visits…</div>`;

  const today = new Date().toISOString().split('T')[0];
  const in60  = new Date(Date.now()+60*86400000).toISOString().split('T')[0];
  const from30 = new Date(Date.now()-30*86400000).toISOString().split('T')[0];

  const res = await fetch(`/api/plan-visits?from=${from30}&to=${in60}&limit=200`, { credentials:'include' });
  const visits = res.ok ? await res.json() : [];

  if (!visits.length) {
    content.innerHTML = `<div class="rp-empty">
      <div class="rp-empty-icon">${gwIcon('calendar',48,'#D1D5DB')}</div>
      <div class="rp-empty-title">No visits scheduled</div>
      <div class="rp-empty-sub">Subscribe a client to a plan and schedule their first visit.</div>
      <button class="rp-btn-primary" style="margin-top:16px" onclick="_rpLoadTab('subscriptions')">
        ${gwIcon('user-plus',13,'#fff')} Subscribe a Client
      </button>
    </div>`;
    return;
  }

  const overdue  = visits.filter(v => v.status==='scheduled' && v.scheduled_date < today);
  const upcoming = visits.filter(v => v.status==='scheduled' && v.scheduled_date >= today);
  const recent   = visits.filter(v => v.status==='completed');

  function visitCard(v) {
    const due    = _rpDaysUntil(v.scheduled_date);
    const isOver = v.scheduled_date < today && v.status==='scheduled';
    const hasPri = !!v.priority_note;
    const crews  = v.crew_name || v.default_crew_name || '';
    const emps   = _rpParseJSON(v.employee_names, []);
    return `<div class="rp-visit-card${isOver?' rp-visit-overdue':''}${hasPri?' rp-visit-priority':''}">
      ${hasPri ? `<div class="rp-priority-banner">
        <span>${gwIcon('alert',12,'#92400E')} Priority Note — requires acknowledgement</span>
        <span class="rp-priority-peek">${v.priority_note.slice(0,80)}${v.priority_note.length>80?'…':''}</span>
      </div>` : ''}
      <div class="rp-vc-main">
        <div class="rp-vc-date-col">
          <div class="rp-vc-date">${_rpDateShort(v.scheduled_date)}</div>
          ${v.status==='scheduled' ? `<div class="rp-vc-due${isOver?' rp-vc-due-over':due<=3?' rp-vc-due-soon':''}">${isOver?'Overdue':due===0?'Today':due===1?'Tomorrow':`In ${due}d`}</div>` : _rpStatusBadge(v.status)}
        </div>
        <div class="rp-vc-body">
          <div class="rp-vc-client">${v.client_name||'—'}</div>
          <div class="rp-vc-plan">${gwIcon('repeat',10,'#9CA3AF')} ${v.plan_name||'Plan'}</div>
          ${crews ? `<div class="rp-vc-crew">${gwIcon('users',10,'#6B7280')} ${crews}${emps.length?` · ${emps.join(', ')}`:''}</div>` : '<div class="rp-vc-crew rp-vc-crew-unset">${gwIcon(\'users\',10,\'#D1D5DB\')} No crew assigned</div>'}
          ${v.address||v.service_address ? `<div class="rp-vc-addr">${gwIcon('map-pin',10,'#6B7280')} ${v.address||v.service_address}</div>` : ''}
        </div>
        <div class="rp-vc-right">
          ${v.budgeted_hours ? `<div class="rp-vc-hours">${gwIcon('clock',10,'#9CA3AF')} ${v.budgeted_hours}h</div>` : ''}
          <button class="rp-btn-sm rp-btn-detail" onclick="_rpOpenVisitDetail('${v.id}')">Open</button>
          ${v.status==='scheduled' ? `<button class="rp-btn-sm rp-btn-complete" onclick="_rpStartCompleteVisit('${v.id}')">
            ${gwIcon('check',11,'#2D7A55')} Complete
          </button>` : ''}
        </div>
      </div>
    </div>`;
  }

  content.innerHTML = `<div class="rp-visits-wrap">
    ${overdue.length ? `<div class="rp-visits-section">
      <div class="rp-visits-hdr rp-visits-hdr-over">${gwIcon('alert',14,'#DC2626')} Overdue — ${overdue.length} visit${overdue.length!==1?'s':''}</div>
      ${overdue.map(visitCard).join('')}
    </div>` : ''}
    ${upcoming.length ? `<div class="rp-visits-section">
      <div class="rp-visits-hdr">${gwIcon('calendar',14,'#2D7A55')} Upcoming — ${upcoming.length} visit${upcoming.length!==1?'s':''}</div>
      ${upcoming.map(visitCard).join('')}
    </div>` : ''}
    ${recent.length ? `<div class="rp-visits-section">
      <div class="rp-visits-hdr rp-visits-hdr-done">${gwIcon('check-circle',14,'#6B7280')} Recently Completed — ${recent.length}</div>
      ${recent.slice(0,10).map(visitCard).join('')}
    </div>` : ''}
  </div>`;
}

/* ── Visit Detail Modal ─────────────────────────────────────────────────────── */
window._rpOpenVisitDetail = async function(visitId) {
  const overlay = _rpCreateOverlay('rp-visit-overlay');
  overlay.innerHTML = `<div class="rp-modal rp-visit-modal">
    <div class="rp-modal-header">
      <div class="rp-modal-title">${gwIcon('calendar',18,'#2D7A55')} Visit Detail</div>
      <button class="rp-modal-close" onclick="document.getElementById('rp-visit-overlay').remove()">×</button>
    </div>
    <div class="rp-modal-body"><div class="rp-loading">${gwIcon('hourglass',20,'#9CA3AF')} Loading…</div></div>
  </div>`;
  document.body.appendChild(overlay);

  const res = await fetch(`/api/plan-visits/${visitId}`, { credentials:'include' });
  if (!res.ok) { overlay.querySelector('.rp-modal-body').innerHTML = '<p style="color:red">Failed to load</p>'; return; }
  const v = await res.json();
  _rpRenderVisitDetail(overlay, v);
};

function _rpRenderVisitDetail(overlay, v) {
  const tasks        = _rpParseJSON(v.plan_tasks, []);
  const checkState   = _rpParseJSON(v.checklist_state, {});
  const empIds       = _rpParseJSON(v.employee_ids, []);
  const empNames     = _rpParseJSON(v.employee_names, []);
  const photos       = _rpParseJSON(v.photos, []);
  const isCompleted  = v.status === 'completed';
  const hasPriNote   = !!v.priority_note;
  const isAcked      = !!v.priority_ack;

  overlay.querySelector('.rp-modal-body').innerHTML = `
    <!-- Priority Note — shown at TOP, prominent -->
    ${hasPriNote ? `<div class="rp-pri-box ${isAcked?'rp-pri-acked':''}">
      <div class="rp-pri-label">${gwIcon('alert',14,isAcked?'#166534':'#92400E')} Priority Note ${isAcked?'<span class="rp-pri-acked-tag">✓ Acknowledged</span>':''}</div>
      <div class="rp-pri-text" id="vd-pri-text">${v.priority_note}</div>
      ${!isAcked && !isCompleted ? `<button class="rp-btn-ack" onclick="_rpAckPriorityNote('${v.id}')">
        ${gwIcon('check',13,'#fff')} I've Read and Understood This Note
      </button>` : isAcked ? `<div class="rp-pri-ack-info">Acknowledged by ${v.priority_ack_by||'crew'} on ${v.priority_ack_at ? new Date(v.priority_ack_at).toLocaleString() : '—'}</div>` : ''}
    </div>` : ''}

    <!-- Visit header info -->
    <div class="rp-vd-meta-grid">
      <div class="rp-kv"><span>Client</span><strong>${v.client_name||'—'}</strong></div>
      <div class="rp-kv"><span>Plan</span>${v.plan_name||'—'}</div>
      <div class="rp-kv"><span>Scheduled</span><strong>${_rpDate(v.scheduled_date)}</strong></div>
      <div class="rp-kv"><span>Frequency</span>${_rpFreqLabels[v.frequency]||v.frequency||'—'}</div>
      <div class="rp-kv"><span>Status</span>${_rpStatusBadge(v.status)}</div>
      <div class="rp-kv"><span>Budgeted Hours</span>${v.budgeted_hours||'—'}</div>
    </div>

    <!-- Service Address -->
    <div class="rp-vd-section">
      <div class="rp-vd-section-title">${gwIcon('map-pin',13,'#2D7A55')} Service Address</div>
      ${!isCompleted ? `<input class="rp-input" id="vd-address" value="${(v.address||v.service_address||'').replace(/"/g,'&quot;')}" placeholder="Service address for this visit">` : `<div class="rp-vd-val">${v.address||v.service_address||'—'}</div>`}
      ${v.property_access ? `<div class="rp-access-note">${gwIcon('lock',11,'#9CA3AF')} ${v.property_access}</div>` : ''}
    </div>

    <!-- Crew & Employees -->
    ${!isCompleted ? `<div class="rp-vd-section">
      <div class="rp-vd-section-title">${gwIcon('users',13,'#2D7A55')} Crew &amp; Employees</div>
      <div class="rp-row2">
        <div class="rp-field-group">
          <label class="rp-label">Assigned Crew</label>
          <div id="vd-crew-wrap">
            <input class="rp-input" id="vd-crew-name" value="${(v.crew_name||v.default_crew_name||'').replace(/"/g,'&quot;')}" placeholder="Crew name or number">
          </div>
        </div>
        <div class="rp-field-group">
          <label class="rp-label">Budgeted Hours</label>
          <input class="rp-input" type="number" id="vd-hours" value="${v.budgeted_hours||v.plan_hours||''}" min="0" step="0.5" placeholder="2.0">
        </div>
      </div>
      <div class="rp-field-group">
        <label class="rp-label">Employees Assigned</label>
        <div id="vd-emp-tags" class="rp-emp-tags">
          ${empNames.map((n,i)=>`<span class="rp-emp-tag">${n}<button onclick="_rpRemoveEmp(${i})">&times;</button></span>`).join('')}
        </div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <input class="rp-input" id="vd-emp-input" placeholder="Employee name…" style="flex:1">
          <button class="rp-btn-ghost" onclick="_rpAddEmp()">${gwIcon('plus',12,'#2D7A55')} Add</button>
        </div>
      </div>
    </div>` : `<div class="rp-vd-section">
      <div class="rp-vd-section-title">${gwIcon('users',13,'#2D7A55')} Crew &amp; Employees</div>
      <div class="rp-vd-val">${v.crew_name||'—'}${empNames.length?` &middot; ${empNames.join(', ')}`:''}</div>
    </div>`}

    <!-- Priority Note editor (for office/admin only when viewing an incomplete visit) -->
    ${!isCompleted ? `<div class="rp-vd-section">
      <div class="rp-vd-section-title">${gwIcon('alert',13,'#D97706')} Priority / Special Note for This Visit
        <span class="rp-vd-section-hint">Crew MUST acknowledge before completing</span>
      </div>
      <textarea class="rp-textarea" id="vd-priority-note" rows="3" placeholder="e.g. Gate code changed to 4521. Watch for dog in backyard. Client asked to skip east bed this week.">${v.priority_note||''}</textarea>
    </div>` : (v.priority_note ? `<div class="rp-vd-section">
      <div class="rp-vd-section-title">${gwIcon('alert',13,'#D97706')} Priority Note</div>
      <div class="rp-pri-text">${v.priority_note}</div>
    </div>` : '')}

    <!-- Visit Notes -->
    <div class="rp-vd-section">
      <div class="rp-vd-section-title">${gwIcon('document',13,'#2D7A55')} Visit Notes</div>
      ${!isCompleted
        ? `<textarea class="rp-textarea" id="vd-notes" rows="3" placeholder="Notes specific to this occurrence (gate was open, client was home, etc.)">${v.visit_notes||''}</textarea>`
        : `<div class="rp-vd-val">${v.visit_notes||'<span style="color:#9CA3AF">No notes recorded</span>'}</div>`}
    </div>

    <!-- Task Checklist -->
    ${tasks.length ? `<div class="rp-vd-section">
      <div class="rp-vd-section-title">${gwIcon('check-circle',13,'#2D7A55')} Visit Checklist</div>
      <div id="vd-checklist" class="rp-checklist">
        ${tasks.map((t,i) => {
          const done = !!checkState[`t${i}`];
          return `<label class="rp-check-row${done?' rp-check-done':''}${isCompleted?' rp-check-readonly':''}">
            <input type="checkbox" ${done?'checked':''} ${isCompleted?'disabled':''} onchange="_rpCheckTask(this,'t${i}')" id="vd-ck-t${i}">
            <span>${t.title||t}</span>
          </label>`;
        }).join('')}
      </div>
    </div>` : ''}

    <!-- Photos -->
    <div class="rp-vd-section">
      <div class="rp-vd-section-title">${gwIcon('camera',13,'#2D7A55')} Photos</div>
      <div id="vd-photos" class="rp-photos-grid">
        ${photos.length
          ? photos.map(p=>`<div class="rp-photo-thumb">
              <img src="${p.url}" alt="${p.caption||'Photo'}" onerror="this.style.display='none'">
              ${p.caption?`<div class="rp-photo-cap">${p.caption}</div>`:''}
            </div>`).join('')
          : '<div style="font-size:12px;color:#9CA3AF">No photos yet.</div>'}
      </div>
      ${!isCompleted ? `<div style="margin-top:10px;display:flex;gap:8px;align-items:center">
        <input class="rp-input" type="url" id="vd-photo-url" placeholder="Paste photo URL…" style="flex:1">
        <input class="rp-input" id="vd-photo-cap" placeholder="Caption (optional)" style="flex:1">
        <button class="rp-btn-ghost" onclick="_rpAddPhoto('${v.id}')">${gwIcon('plus',12,'#2D7A55')} Add</button>
      </div>` : ''}
    </div>

    <!-- Footer -->
    <div class="rp-modal-footer">
      <button class="rp-btn-ghost" onclick="document.getElementById('rp-visit-overlay').remove()">Close</button>
      ${!isCompleted ? `
        <button class="rp-btn-ghost" onclick="_rpSaveVisitChanges('${v.id}')" style="border-color:#2D7A55;color:#2D7A55">
          ${gwIcon('floppy',13,'#2D7A55')} Save
        </button>
        <button class="rp-btn-complete-big" onclick="_rpStartCompleteVisit('${v.id}')">
          ${gwIcon('check-circle',14,'#fff')} Complete Visit
        </button>` : ''}
    </div>`;

  // Store employee list for editing
  window._vdEmpList = { ids: [...empIds], names: [...empNames] };
}

/* ── Employee tag management inside detail modal ────────────────────────────── */
window._rpAddEmp = function() {
  const inp = document.getElementById('vd-emp-input');
  const name = inp?.value?.trim();
  if (!name) return;
  window._vdEmpList = window._vdEmpList || { ids:[], names:[] };
  window._vdEmpList.names.push(name);
  window._vdEmpList.ids.push(`emp_${Date.now()}`);
  inp.value = '';
  _rpRefreshEmpTags();
};
window._rpRemoveEmp = function(idx) {
  window._vdEmpList.names.splice(idx, 1);
  window._vdEmpList.ids.splice(idx, 1);
  _rpRefreshEmpTags();
};
function _rpRefreshEmpTags() {
  const wrap = document.getElementById('vd-emp-tags');
  if (!wrap) return;
  wrap.innerHTML = (window._vdEmpList?.names||[]).map((n,i)=>
    `<span class="rp-emp-tag">${n}<button onclick="_rpRemoveEmp(${i})">&times;</button></span>`).join('');
}

/* ── Acknowledge priority note ───────────────────────────────────────────────── */
window._rpAckPriorityNote = async function(visitId) {
  const who = prompt('Your name (who is acknowledging this note):');
  if (!who) return;
  const res = await fetch(`/api/plan-visits/${visitId}/acknowledge`, {
    method:'POST', credentials:'include',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ acknowledged_by: who })
  });
  if (!res.ok) { showToast('Failed to save acknowledgement', 'error'); return; }
  showToast('Priority note acknowledged ✓', 'success');
  // Refresh visit detail
  const res2 = await fetch(`/api/plan-visits/${visitId}`, { credentials:'include' });
  if (res2.ok) {
    const v = await res2.json();
    const overlay = document.getElementById('rp-visit-overlay');
    if (overlay) _rpRenderVisitDetail(overlay, v);
  }
};

/* ── Task checkbox ───────────────────────────────────────────────────────────── */
window._rpCheckState = {};
window._rpCheckTask = function(cb, key) {
  window._rpCheckState[key] = cb.checked;
  const row = cb.closest('.rp-check-row');
  if (row) row.classList.toggle('rp-check-done', cb.checked);
};

/* ── Add photo to visit ──────────────────────────────────────────────────────── */
window._rpAddPhoto = async function(visitId) {
  const url = document.getElementById('vd-photo-url')?.value?.trim();
  const cap = document.getElementById('vd-photo-cap')?.value?.trim();
  if (!url) { showToast('Enter a photo URL', 'error'); return; }
  const res = await fetch(`/api/plan-visits/${visitId}/photos`, {
    method:'POST', credentials:'include',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ photos: [{ url, caption: cap }] })
  });
  if (!res.ok) { showToast('Failed to add photo', 'error'); return; }
  const data = await res.json();
  showToast('Photo added', 'success');
  const grid = document.getElementById('vd-photos');
  if (grid) {
    const photos = data.photos || [];
    grid.innerHTML = photos.map(p=>`<div class="rp-photo-thumb">
      <img src="${p.url}" alt="${p.caption||'Photo'}" onerror="this.style.display='none'">
      ${p.caption?`<div class="rp-photo-cap">${p.caption}</div>`:''}
    </div>`).join('');
  }
  if (document.getElementById('vd-photo-url')) document.getElementById('vd-photo-url').value='';
  if (document.getElementById('vd-photo-cap')) document.getElementById('vd-photo-cap').value='';
};

/* ── Save visit changes (crew, address, note, checklist) ─────────────────────── */
window._rpSaveVisitChanges = async function(visitId) {
  const g = id => document.getElementById(id)?.value?.trim()||'';
  const checkState = {};
  document.querySelectorAll('#vd-checklist input[type=checkbox]').forEach(cb => {
    const key = cb.id.replace('vd-ck-','');
    checkState[key] = cb.checked;
    window._rpCheckState[key] = cb.checked;
  });
  const payload = {
    crew_name:     g('vd-crew-name'),
    budgeted_hours: parseFloat(document.getElementById('vd-hours')?.value||0)||0,
    employee_names: window._vdEmpList?.names || [],
    employee_ids:   window._vdEmpList?.ids   || [],
    address:        g('vd-address'),
    priority_note:  g('vd-priority-note'),
    visit_notes:    g('vd-notes'),
    checklist_state: checkState,
  };
  const res = await fetch(`/api/plan-visits/${visitId}`, {
    method:'PUT', credentials:'include',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload)
  });
  if (!res.ok) { showToast('Failed to save', 'error'); return; }
  showToast('Visit saved', 'success');
};

/* ── Complete visit flow ──────────────────────────────────────────────────────── */
window._rpStartCompleteVisit = async function(visitId) {
  // Save any open changes first
  const hasCrew = !!document.getElementById('vd-crew-name');
  if (hasCrew) await window._rpSaveVisitChanges(visitId);

  // Check if priority note needs ACK
  const res = await fetch(`/api/plan-visits/${visitId}`, { credentials:'include' });
  const v = await res.json();

  if (v.priority_note && !v.priority_ack) {
    // Show ACK-required gate
    const overlay2 = _rpCreateOverlay('rp-ack-overlay');
    overlay2.innerHTML = `<div class="rp-modal" style="max-width:420px">
      <div class="rp-modal-header">
        <div class="rp-modal-title" style="color:#92400E">${gwIcon('alert',18,'#D97706')} Action Required</div>
        <button class="rp-modal-close" onclick="document.getElementById('rp-ack-overlay').remove()">×</button>
      </div>
      <div class="rp-modal-body">
        <div class="rp-pri-box" style="margin-bottom:16px">
          <div class="rp-pri-label">${gwIcon('alert',14,'#92400E')} Priority Note</div>
          <div class="rp-pri-text">${v.priority_note}</div>
        </div>
        <p style="font-size:13px;color:#374151;margin-bottom:16px">You must acknowledge this note before the visit can be marked complete.</p>
        <div class="rp-field-group">
          <label class="rp-label">Your Name</label>
          <input class="rp-input" id="ackName" placeholder="Enter your name…">
        </div>
      </div>
      <div class="rp-modal-footer">
        <button class="rp-btn-ghost" onclick="document.getElementById('rp-ack-overlay').remove()">Cancel</button>
        <button class="rp-btn-ack" onclick="_rpAckAndComplete('${visitId}')">
          ${gwIcon('check',13,'#fff')} Acknowledge &amp; Continue to Complete
        </button>
      </div>
    </div>`;
    document.body.appendChild(overlay2);
    return;
  }

  _rpOpenCompleteModal(visitId);
};

window._rpAckAndComplete = async function(visitId) {
  const who = document.getElementById('ackName')?.value?.trim();
  if (!who) { showToast('Enter your name', 'error'); return; }
  const res = await fetch(`/api/plan-visits/${visitId}/acknowledge`, {
    method:'POST', credentials:'include',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ acknowledged_by: who })
  });
  if (!res.ok) { showToast('Failed', 'error'); return; }
  document.getElementById('rp-ack-overlay')?.remove();
  _rpOpenCompleteModal(visitId);
};

async function _rpOpenCompleteModal(visitId) {
  const res = await fetch(`/api/plan-visits/${visitId}`, { credentials:'include' });
  const v = await res.json();
  const tasks = _rpParseJSON(v.plan_tasks, []);
  const checkState = { ...(_rpParseJSON(v.checklist_state,{})), ...(window._rpCheckState||{}) };

  const overlay = _rpCreateOverlay('rp-complete-overlay');
  overlay.innerHTML = `<div class="rp-modal" style="max-width:500px">
    <div class="rp-modal-header">
      <div class="rp-modal-title">${gwIcon('check-circle',18,'#2D7A55')} Complete Visit</div>
      <button class="rp-modal-close" onclick="document.getElementById('rp-complete-overlay').remove()">×</button>
    </div>
    <div class="rp-modal-body">
      <div class="rp-comp-client">${v.client_name||'Client'} — ${_rpDate(v.scheduled_date)}</div>

      ${tasks.length ? `<div class="rp-field-group">
        <label class="rp-label">${gwIcon('check',12,'#2D7A55')} Final Checklist</label>
        <div class="rp-checklist">
          ${tasks.map((t,i)=>{
            const key=`t${i}`;
            const done=!!checkState[key];
            return `<label class="rp-check-row${done?' rp-check-done':''}">
              <input type="checkbox" id="comp-ck-${i}" ${done?'checked':''} onchange="this.closest('.rp-check-row').classList.toggle('rp-check-done',this.checked)">
              <span>${t.title||t}</span>
            </label>`;
          }).join('')}
        </div>
      </div>` : ''}

      <div class="rp-row2">
        <div class="rp-field-group">
          <label class="rp-label">Actual Hours</label>
          <input class="rp-input" type="number" id="comp-hours" value="${v.budgeted_hours||''}" min="0" step="0.5" placeholder="0.0">
        </div>
        <div class="rp-field-group">
          <label class="rp-label">Visit Date</label>
          <input class="rp-input" type="date" id="comp-date" value="${v.scheduled_date||new Date().toISOString().split('T')[0]}">
        </div>
      </div>
      <div class="rp-field-group">
        <label class="rp-label">Completion Notes</label>
        <textarea class="rp-textarea" id="comp-notes" rows="3" placeholder="What was done? Any issues? Gate condition, customer feedback…">${v.visit_notes||''}</textarea>
      </div>
    </div>
    <div class="rp-modal-footer">
      <button class="rp-btn-ghost" onclick="document.getElementById('rp-complete-overlay').remove()">Cancel</button>
      <button class="rp-btn-complete-big" onclick="_rpFinalizeComplete('${visitId}')">
        ${gwIcon('check-circle',14,'#fff')} Mark Visit Complete
      </button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
}

window._rpFinalizeComplete = async function(visitId) {
  const tasks = document.querySelectorAll('[id^="comp-ck-"]');
  const checkState = {};
  tasks.forEach(cb => { checkState[`t${cb.id.replace('comp-ck-','')}`] = cb.checked; });

  const payload = {
    actual_hours:  parseFloat(document.getElementById('comp-hours')?.value||0)||0,
    visit_notes:   document.getElementById('comp-notes')?.value?.trim()||'',
    checklist_state: checkState,
  };

  const res = await fetch(`/api/plan-visits/${visitId}/complete`, {
    method:'POST', credentials:'include',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) {
    if (data.code === 'ACK_REQUIRED') {
      showToast('Priority note must be acknowledged first', 'error');
    } else {
      showToast('Failed to complete visit', 'error');
    }
    return;
  }
  showToast(`Visit complete! Next visit: ${_rpDate(data.next_visit_date)}`, 'success');
  document.getElementById('rp-complete-overlay')?.remove();
  document.getElementById('rp-visit-overlay')?.remove();
  _rpLoadVisits();
};

/* ── Schedule a Visit Modal (quick-schedule from header button) ──────────────── */
window._rpOpenScheduleVisit = async function(prefillSubId) {
  const [subRes] = await Promise.all([
    fetch('/api/recurring-subscriptions?status=active', { credentials:'include' }),
  ]);
  const subs = subRes.ok ? await subRes.json() : [];
  const today = new Date().toISOString().split('T')[0];

  const overlay = _rpCreateOverlay('rp-sched-overlay');
  overlay.innerHTML = `<div class="rp-modal" style="max-width:480px">
    <div class="rp-modal-header">
      <div class="rp-modal-title">${gwIcon('calendar',18,'#2D7A55')} Schedule a Visit</div>
      <button class="rp-modal-close" onclick="document.getElementById('rp-sched-overlay').remove()">×</button>
    </div>
    <div class="rp-modal-body">
      <div class="rp-field-group">
        <label class="rp-label">Client Subscription <span class="rp-req">*</span></label>
        <select class="rp-select" id="sched-sub" onchange="_rpSchedSubChange(this)">
          <option value="">Select active subscription…</option>
          ${subs.map(s=>`<option value="${s.id}"
            data-plan="${s.plan_id}" data-client="${s.client_id}"
            data-next="${s.next_visit_date||today}"
            data-crew="${s.default_crew_name||''}"
            data-addr="${(s.service_address||'').replace(/"/g,'&quot;')}"
            ${prefillSubId===String(s.id)?'selected':''}
          >${s.client_name||'?'} — ${s.plan_name||'Plan'} (${_rpFreqLabels[s.frequency]||s.frequency})</option>`).join('')}
        </select>
      </div>
      <div class="rp-row2">
        <div class="rp-field-group">
          <label class="rp-label">Scheduled Date <span class="rp-req">*</span></label>
          <input class="rp-input" type="date" id="sched-date" value="${today}">
        </div>
        <div class="rp-field-group">
          <label class="rp-label">Budgeted Hours</label>
          <input class="rp-input" type="number" id="sched-hours" value="" min="0" step="0.5" placeholder="2.0">
        </div>
      </div>
      <div class="rp-field-group">
        <label class="rp-label">Crew / Team</label>
        <input class="rp-input" id="sched-crew" placeholder="Crew name or number">
      </div>
      <div class="rp-field-group">
        <label class="rp-label">Service Address</label>
        <input class="rp-input" id="sched-addr" placeholder="Leave blank to use subscription default">
      </div>
      <div class="rp-field-group">
        <label class="rp-label">${gwIcon('alert',12,'#D97706')} Priority Note for This Visit</label>
        <textarea class="rp-textarea" id="sched-pri" rows="2" placeholder="Special instructions crew must acknowledge before completing…"></textarea>
      </div>
      <div class="rp-field-group">
        <label class="rp-label">General Notes</label>
        <textarea class="rp-textarea" id="sched-notes" rows="2" placeholder="Additional details for this visit…"></textarea>
      </div>
    </div>
    <div class="rp-modal-footer">
      <button class="rp-btn-ghost" onclick="document.getElementById('rp-sched-overlay').remove()">Cancel</button>
      <button class="rp-btn-primary" onclick="_rpSaveScheduledVisit()">
        ${gwIcon('calendar',13,'#fff')} Schedule Visit
      </button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  if (prefillSubId) _rpSchedSubChange(document.getElementById('sched-sub'));
};

window._rpSchedSubChange = function(sel) {
  const opt = sel.options[sel.selectedIndex];
  if (!opt || !opt.value) return;
  const next = opt.getAttribute('data-next');
  const crew = opt.getAttribute('data-crew');
  const addr = opt.getAttribute('data-addr');
  if (next && document.getElementById('sched-date')) document.getElementById('sched-date').value = next;
  if (crew && document.getElementById('sched-crew')) document.getElementById('sched-crew').value = crew;
  if (addr && document.getElementById('sched-addr')) document.getElementById('sched-addr').value = addr;
};

window._rpSaveScheduledVisit = async function() {
  const subSel = document.getElementById('sched-sub');
  const subId  = subSel?.value;
  if (!subId) { showToast('Select a subscription', 'error'); return; }
  const date = document.getElementById('sched-date')?.value;
  if (!date) { showToast('Select a date', 'error'); return; }

  // Get plan_id + client_id from subscription
  const subRes = await fetch(`/api/recurring-subscriptions/${subId}`, { credentials:'include' });
  const sub = subRes.ok ? await subRes.json() : null;

  const payload = {
    subscription_id: subId,
    plan_id:         sub?.plan_id   || '',
    client_id:       sub?.client_id || '',
    scheduled_date:  date,
    crew_name:       document.getElementById('sched-crew')?.value?.trim()||'',
    budgeted_hours:  parseFloat(document.getElementById('sched-hours')?.value||0)||0,
    address:         document.getElementById('sched-addr')?.value?.trim()||'',
    priority_note:   document.getElementById('sched-pri')?.value?.trim()||'',
    visit_notes:     document.getElementById('sched-notes')?.value?.trim()||'',
  };

  const res = await fetch('/api/plan-visits', {
    method:'POST', credentials:'include',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload)
  });
  if (!res.ok) { showToast('Failed to schedule visit', 'error'); return; }
  showToast('Visit scheduled!', 'success');
  document.getElementById('rp-sched-overlay')?.remove();
  _rpLoadVisits();
};

/* ══════════════════════════════════════════════════════════════════════════════
   TAB 2 — CLIENT SUBSCRIPTIONS
   ══════════════════════════════════════════════════════════════════════════════ */
async function _rpLoadSubscriptions() {
  const content = document.getElementById('rpContent');
  if (!content) return;
  content.innerHTML = `<div class="rp-loading">${gwIcon('hourglass',20,'#9CA3AF')} Loading…</div>`;

  const [subRes, planRes] = await Promise.all([
    fetch('/api/recurring-subscriptions', { credentials:'include' }),
    fetch('/api/recurring-plans', { credentials:'include' })
  ]);
  const subs  = subRes.ok  ? await subRes.json()  : [];
  const plans = planRes.ok ? await planRes.json() : [];
  const planMap = {};
  plans.forEach(p => { planMap[p.id] = p; });

  if (!subs.length) {
    content.innerHTML = `<div class="rp-empty">
      <div class="rp-empty-icon">${gwIcon('user',48,'#D1D5DB')}</div>
      <div class="rp-empty-title">No client subscriptions yet</div>
      <div class="rp-empty-sub">Subscribe a client to a recurring plan to auto-schedule their visits.</div>
      <button class="rp-btn-primary" style="margin-top:16px" onclick="_rpOpenSubscribeModal()">
        ${gwIcon('plus',13,'#fff')} Subscribe a Client
      </button>
    </div>`;
    return;
  }

  content.innerHTML = `<div class="rp-sub-list">
    ${subs.map(s => {
      const plan = planMap[s.plan_id] || {};
      const due  = _rpDaysUntil(s.next_visit_date);
      const isOverdue = s.next_visit_date && due !== null && due < 0;
      return `<div class="rp-sub-card ${s.status!=='active'?'rp-sub-inactive':''}">
        <div class="rp-sub-card-top">
          <div class="rp-sub-identity">
            <div class="rp-sub-client">${s.client_name||'—'}</div>
            <div class="rp-sub-plan">${gwIcon('repeat',10,'#9CA3AF')} ${plan.name||'—'} &middot; ${_rpFreqLabels[plan.frequency]||plan.frequency||'—'}</div>
          </div>
          ${_rpStatusBadge(s.status)}
        </div>
        <div class="rp-sub-row2">
          <div class="rp-kv2"><span>Next Visit</span>
            <strong class="${isOverdue?'rp-text-red':due!==null&&due<=3?'rp-text-amber':''}">${_rpDate(s.next_visit_date)}${isOverdue?' (Overdue)':due===0?' (Today)':due===1?' (Tomorrow)':''}</strong>
          </div>
          <div class="rp-kv2"><span>Last Visit</span>${_rpDate(s.last_visit_date)}</div>
          <div class="rp-kv2"><span>Total Visits</span>${s.visit_count||0}</div>
          <div class="rp-kv2"><span>Price</span>${_rpFmt(s.custom_price||plan.price||0)}</div>
        </div>
        ${s.service_address ? `<div class="rp-sub-addr">${gwIcon('map-pin',10,'#9CA3AF')} ${s.service_address}</div>` : ''}
        ${s.property_access ? `<div class="rp-sub-access">${gwIcon('lock',10,'#9CA3AF')} ${s.property_access}</div>` : ''}
        <div class="rp-sub-actions">
          <button class="rp-btn-sm" onclick="_rpOpenSubEdit('${s.id}')">${gwIcon('edit',11,'#6B7280')} Manage</button>
          <button class="rp-btn-sm" onclick="_rpOpenScheduleVisit('${s.id}')">${gwIcon('calendar',11,'#2D7A55')} Schedule Visit</button>
          ${s.status==='active'
            ? `<button class="rp-btn-sm rp-btn-pause" onclick="_rpUpdateSubStatus('${s.id}','paused')">${gwIcon('pause',11,'#D97706')} Pause</button>`
            : s.status==='paused'
            ? `<button class="rp-btn-sm rp-btn-activate" onclick="_rpUpdateSubStatus('${s.id}','active')">${gwIcon('play',11,'#2D7A55')} Activate</button>`
            : ''}
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

/* ── Subscribe modal ────────────────────────────────────────────────────────── */
window._rpOpenSubscribeModal = async function(prefillPlanId) {
  const [planRes, clientRes] = await Promise.all([
    fetch('/api/recurring-plans?active=1', { credentials:'include' }),
    fetch('/api/clients?limit=500', { credentials:'include' })
  ]);
  const plans   = planRes.ok   ? await planRes.json()                    : [];
  const cData   = clientRes.ok ? await clientRes.json()                  : [];
  const clients = Array.isArray(cData) ? cData : (cData.clients || cData.data || []);
  const today   = new Date().toISOString().split('T')[0];

  const overlay = _rpCreateOverlay('rp-sub-overlay');
  overlay.innerHTML = `<div class="rp-modal rp-sub-modal">
    <div class="rp-modal-header">
      <div class="rp-modal-title">${gwIcon('user-plus',18,'#2D7A55')} Subscribe Client</div>
      <button class="rp-modal-close" onclick="document.getElementById('rp-sub-overlay').remove()">×</button>
    </div>
    <div class="rp-modal-body">
      <div class="rp-row2">
        <div class="rp-field-group">
          <label class="rp-label">Client <span class="rp-req">*</span></label>
          <select class="rp-select" id="rpSubClient">
            <option value="">Select client…</option>
            ${clients.map(c=>`<option value="${c.id}" data-name="${(c.name||'').replace(/"/g,'&quot;')}">${c.name}</option>`).join('')}
          </select>
        </div>
        <div class="rp-field-group">
          <label class="rp-label">Plan <span class="rp-req">*</span></label>
          <select class="rp-select" id="rpSubPlan">
            <option value="">Select plan…</option>
            ${plans.map(p=>`<option value="${p.id}" data-freq="${p.frequency}" data-price="${p.price}" ${String(prefillPlanId)===String(p.id)?'selected':''}>${p.name}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="rp-row2">
        <div class="rp-field-group">
          <label class="rp-label">Start Date</label>
          <input class="rp-input" type="date" id="rpSubStart" value="${today}">
        </div>
        <div class="rp-field-group">
          <label class="rp-label">Custom Price (optional)</label>
          <input class="rp-input" type="number" id="rpSubCustomPrice" placeholder="Use plan price" min="0" step="0.01">
        </div>
      </div>
      <div class="rp-field-group">
        <label class="rp-label">Service Address</label>
        <input class="rp-input" id="rpSubAddr" placeholder="123 Main St, Richmond VA">
      </div>
      <div class="rp-row2">
        <div class="rp-field-group">
          <label class="rp-label">Default Crew</label>
          <input class="rp-input" id="rpSubCrew" placeholder="Crew A, Crew 3…">
        </div>
        <div class="rp-field-group">
          <label class="rp-label">Property Access / Gate Code</label>
          <input class="rp-input" id="rpSubAccess" placeholder="Gate code 1234, back entrance…">
        </div>
      </div>
      <div class="rp-field-group">
        <label class="rp-label">Notes</label>
        <textarea class="rp-textarea" id="rpSubNotes" rows="2" placeholder="Special instructions for this client's recurring visits…"></textarea>
      </div>
      <div class="rp-modal-footer">
        <button class="rp-btn-ghost" onclick="document.getElementById('rp-sub-overlay').remove()">Cancel</button>
        <button class="rp-btn-primary" onclick="_rpSaveSubscription()">
          ${gwIcon('check',13,'#fff')} Subscribe Client
        </button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(overlay);
};

window._rpSaveSubscription = async function() {
  const clientSel  = document.getElementById('rpSubClient');
  const planSel    = document.getElementById('rpSubPlan');
  const clientId   = clientSel?.value;
  const planId     = planSel?.value;
  const clientName = clientSel?.options[clientSel.selectedIndex]?.getAttribute('data-name') || '';
  const freq       = planSel?.options[planSel.selectedIndex]?.getAttribute('data-freq') || 'monthly';
  const startDate  = document.getElementById('rpSubStart')?.value || '';
  const customPrc  = parseFloat(document.getElementById('rpSubCustomPrice')?.value||'0')||0;
  const notes      = document.getElementById('rpSubNotes')?.value?.trim()||'';
  const addr       = document.getElementById('rpSubAddr')?.value?.trim()||'';
  const crew       = document.getElementById('rpSubCrew')?.value?.trim()||'';
  const access     = document.getElementById('rpSubAccess')?.value?.trim()||'';

  if (!clientId) { showToast('Select a client','error'); return; }
  if (!planId)   { showToast('Select a plan','error'); return; }

  const start   = startDate || new Date().toISOString().split('T')[0];
  const days    = _rpFreqDays[freq] || 30;
  const nextVis = new Date(new Date(start+'T00:00:00').getTime()+days*86400000).toISOString().split('T')[0];

  const res = await fetch('/api/recurring-subscriptions', {
    method:'POST', credentials:'include',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      plan_id: planId, client_id: clientId, client_name: clientName,
      start_date: start, next_visit_date: nextVis,
      custom_price: customPrc, notes, status: 'active'
    })
  });
  if (!res.ok) { showToast('Failed to create subscription','error'); return; }

  // Save assignment details
  const sub = await res.json();
  if (sub && (addr || crew || access)) {
    await fetch(`/api/recurring-subscriptions/${sub.id}/assignment`, {
      method:'PUT', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        default_crew_name: crew, default_employees: [],
        service_address: addr, property_access: access
      })
    });
  }

  showToast(`${clientName} subscribed!`, 'success');
  document.getElementById('rp-sub-overlay')?.remove();
  _rpLoadSubscriptions();
};

/* ── Edit Subscription Modal ────────────────────────────────────────────────── */
window._rpOpenSubEdit = async function(subId) {
  const res = await fetch(`/api/recurring-subscriptions/${subId}`, { credentials:'include' });
  if (!res.ok) return;
  const sub = await res.json();

  const overlay = _rpCreateOverlay('rp-subedit-overlay');
  overlay.innerHTML = `<div class="rp-modal rp-sub-modal">
    <div class="rp-modal-header">
      <div class="rp-modal-title">${gwIcon('edit',18,'#2D7A55')} ${sub.client_name||'Client'} — Subscription</div>
      <button class="rp-modal-close" onclick="document.getElementById('rp-subedit-overlay').remove()">×</button>
    </div>
    <div class="rp-modal-body">
      <div class="rp-vd-meta-grid" style="margin-bottom:16px">
        <div class="rp-kv"><span>Plan</span>${sub.plan_name||'—'}</div>
        <div class="rp-kv"><span>Frequency</span>${_rpFreqLabels[sub.frequency]||sub.frequency||'—'}</div>
        <div class="rp-kv"><span>Total Visits</span>${sub.visit_count||0}</div>
        <div class="rp-kv"><span>Status</span>${_rpStatusBadge(sub.status)}</div>
      </div>
      <div class="rp-field-group">
        <label class="rp-label">Service Address</label>
        <input class="rp-input" id="se-addr" value="${(sub.service_address||'').replace(/"/g,'&quot;')}" placeholder="Service address">
      </div>
      <div class="rp-row2">
        <div class="rp-field-group">
          <label class="rp-label">Default Crew</label>
          <input class="rp-input" id="se-crew" value="${(sub.default_crew_name||'').replace(/"/g,'&quot;')}" placeholder="Crew name">
        </div>
        <div class="rp-field-group">
          <label class="rp-label">Next Visit Date</label>
          <input class="rp-input" type="date" id="se-nextvis" value="${sub.next_visit_date||''}">
        </div>
      </div>
      <div class="rp-field-group">
        <label class="rp-label">Property Access / Gate Info</label>
        <input class="rp-input" id="se-access" value="${(sub.property_access||'').replace(/"/g,'&quot;')}" placeholder="Access code, entry notes…">
      </div>
      <div class="rp-field-group">
        <label class="rp-label">Notes</label>
        <textarea class="rp-textarea" id="se-notes" rows="3">${sub.notes||''}</textarea>
      </div>
      <div style="margin:12px 0;padding:12px;background:#F9FAFB;border-radius:10px">
        <div style="font-size:11px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Change Status</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${['active','paused','cancelled'].map(s=>`<button class="rp-btn-ghost ${sub.status===s?'rp-status-btn-active':''}" style="font-size:12px;padding:6px 12px" onclick="_rpUpdateSubStatus('${subId}','${s}')">${s.charAt(0).toUpperCase()+s.slice(1)}</button>`).join('')}
        </div>
      </div>
      <div class="rp-modal-footer">
        <button class="rp-btn-ghost" onclick="document.getElementById('rp-subedit-overlay').remove()">Cancel</button>
        <button class="rp-btn-primary" onclick="_rpSaveSubEdit('${subId}')">
          ${gwIcon('floppy',13,'#fff')} Save Changes
        </button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(overlay);
};

window._rpSaveSubEdit = async function(subId) {
  const addr   = document.getElementById('se-addr')?.value?.trim()||'';
  const crew   = document.getElementById('se-crew')?.value?.trim()||'';
  const access = document.getElementById('se-access')?.value?.trim()||'';
  const notes  = document.getElementById('se-notes')?.value?.trim()||'';
  const nxtVis = document.getElementById('se-nextvis')?.value||'';

  await Promise.all([
    fetch(`/api/recurring-subscriptions/${subId}`, {
      method:'PUT', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ notes, next_visit_date: nxtVis })
    }),
    fetch(`/api/recurring-subscriptions/${subId}/assignment`, {
      method:'PUT', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ default_crew_name: crew, service_address: addr, property_access: access, default_employees: [] })
    })
  ]);
  showToast('Subscription updated', 'success');
  document.getElementById('rp-subedit-overlay')?.remove();
  _rpLoadSubscriptions();
};

window._rpUpdateSubStatus = async function(subId, status) {
  await fetch(`/api/recurring-subscriptions/${subId}`, {
    method:'PUT', credentials:'include',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ status })
  });
  showToast(`Subscription ${status}`, 'success');
  document.getElementById('rp-subedit-overlay')?.remove();
  _rpLoadSubscriptions();
};

/* ══════════════════════════════════════════════════════════════════════════════
   TAB 3 — PLANS
   ══════════════════════════════════════════════════════════════════════════════ */
async function _rpLoadPlans() {
  const content = document.getElementById('rpContent');
  if (!content) return;
  content.innerHTML = `<div class="rp-loading">${gwIcon('hourglass',20,'#9CA3AF')} Loading plans…</div>`;

  const res = await fetch('/api/recurring-plans', { credentials:'include' });
  const plans = res.ok ? await res.json() : [];

  if (!plans.length) {
    content.innerHTML = `<div class="rp-empty">
      <div class="rp-empty-icon">${gwIcon('repeat',48,'#D1D5DB')}</div>
      <div class="rp-empty-title">No service plans yet</div>
      <div class="rp-empty-sub">Create a plan template (e.g. Weekly Lawn Maintenance) then subscribe clients to it.</div>
      <button class="rp-btn-primary" style="margin-top:16px" onclick="_rpOpenPlanBuilder(null)">
        ${gwIcon('plus',13,'#fff')} Create First Plan
      </button>
    </div>`;
    return;
  }

  content.innerHTML = `<div class="rp-plans-grid">
    ${plans.map(p => {
      const tasks = _rpParseJSON(p.tasks, []);
      return `<div class="rp-plan-card ${!p.is_active?'rp-plan-inactive':''}">
        <div class="rp-plan-card-top">
          <div>
            <div class="rp-plan-name">${p.name}</div>
            <div class="rp-plan-freq">${gwIcon('repeat',11,'#9CA3AF')} ${_rpFreqLabels[p.frequency]||p.frequency}</div>
          </div>
          <div class="rp-plan-price">${_rpFmt(p.price)}<span class="rp-plan-price-unit">/${p.frequency==='monthly'?'mo':p.frequency==='weekly'?'wk':p.frequency==='annual'?'yr':'visit'}</span></div>
        </div>
        ${p.description ? `<div class="rp-plan-desc">${p.description}</div>` : ''}
        <div class="rp-plan-details">
          ${p.estimated_hours ? `<span>${gwIcon('clock',10,'#9CA3AF')} ${p.estimated_hours}h/visit</span>` : ''}
          ${p.crew_size>1 ? `<span>${gwIcon('users',10,'#9CA3AF')} ${p.crew_size} crew</span>` : ''}
          ${p.service_type ? `<span>${p.service_type}</span>` : ''}
        </div>
        ${tasks.length ? `<div class="rp-plan-tasks">
          ${tasks.slice(0,4).map(t=>`<div class="rp-plan-task">${gwIcon('check',10,'#2D7A55')} ${t.title||t}</div>`).join('')}
          ${tasks.length>4?`<div class="rp-plan-task" style="color:#9CA3AF">+${tasks.length-4} more tasks</div>`:''}
        </div>`:''}
        <div class="rp-plan-card-footer">
          <div class="rp-plan-status ${p.is_active?'rp-plan-status-active':'rp-plan-status-inactive'}">${p.is_active?'Active':'Inactive'}</div>
          <div class="rp-plan-actions">
            <button class="rp-action-btn" onclick="_rpOpenPlanBuilder('${p.id}')" title="Edit">${gwIcon('edit',13,'#6B7280')}</button>
            <button class="rp-action-btn" onclick="_rpOpenSubscribeModal('${p.id}')" title="Subscribe client">${gwIcon('user-plus',13,'#2D7A55')}</button>
            <button class="rp-action-btn" onclick="_rpTogglePlan('${p.id}',${p.is_active?0:1})" title="${p.is_active?'Deactivate':'Activate'}">${gwIcon(p.is_active?'pause':'play',13,'#9CA3AF')}</button>
          </div>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

/* ── Plan Builder Modal ─────────────────────────────────────────────────────── */
window._rpOpenPlanBuilder = async function(planId) {
  let plan = null;
  if (planId) {
    const res = await fetch(`/api/recurring-plans/${planId}`, { credentials:'include' });
    if (res.ok) plan = await res.json();
  }
  const overlay = _rpCreateOverlay('rp-builder-overlay');
  overlay.innerHTML = `<div class="rp-modal rp-builder-modal">
    <div class="rp-modal-header">
      <div class="rp-modal-title">${gwIcon('repeat',18,'#2D7A55')} ${planId ? 'Edit Plan' : 'New Recurring Plan'}</div>
      <button class="rp-modal-close" onclick="document.getElementById('rp-builder-overlay').remove()">×</button>
    </div>
    <div class="rp-modal-body">
      ${_rpPlanBuilderForm(plan)}
    </div>
  </div>`;
  document.body.appendChild(overlay);
  window._rpTaskCount = _rpParseJSON(plan?.tasks, []).length || 1;
};

function _rpPlanBuilderForm(plan) {
  const tasks = _rpParseJSON(plan?.tasks, []);
  return `<form id="rpPlanForm">
    <div class="rp-field-group">
      <label class="rp-label">Plan Name <span class="rp-req">*</span></label>
      <input class="rp-input" type="text" id="rpPlanName" value="${plan?.name||''}" placeholder="Weekly Lawn Maintenance">
    </div>
    <div class="rp-field-group">
      <label class="rp-label">Description</label>
      <textarea class="rp-textarea" id="rpPlanDesc" rows="2" placeholder="What does this plan include?">${plan?.description||''}</textarea>
    </div>
    <div class="rp-row2">
      <div class="rp-field-group">
        <label class="rp-label">Visit Frequency</label>
        <select class="rp-select" id="rpFrequency" onchange="_rpUpdateFreqDays()">
          ${Object.entries(_rpFreqLabels).map(([k,v])=>`<option value="${k}" ${plan?.frequency===k?'selected':''}>${v}</option>`).join('')}
        </select>
      </div>
      <div class="rp-field-group" id="rpCustomDaysGroup" style="display:${plan?.frequency==='custom'?'block':'none'}">
        <label class="rp-label">Every N Days</label>
        <input class="rp-input" type="number" id="rpFreqDays" value="${plan?.frequency_days||30}" min="1">
      </div>
    </div>
    <div class="rp-row2">
      <div class="rp-field-group">
        <label class="rp-label">Price per Visit ($)</label>
        <input class="rp-input" type="number" id="rpPrice" value="${plan?.price||''}" min="0" step="0.01" placeholder="0.00">
      </div>
      <div class="rp-field-group">
        <label class="rp-label">Estimated Hours / Visit</label>
        <input class="rp-input" type="number" id="rpHours" value="${plan?.estimated_hours||''}" min="0" step="0.5" placeholder="2.0">
      </div>
    </div>
    <div class="rp-row2">
      <div class="rp-field-group">
        <label class="rp-label">Crew Size</label>
        <input class="rp-input" type="number" id="rpCrewSize" value="${plan?.crew_size||1}" min="1" max="20">
      </div>
      <div class="rp-field-group">
        <label class="rp-label">Service Type</label>
        <input class="rp-input" type="text" id="rpServiceType" value="${plan?.service_type||''}" placeholder="Lawn Care, Maintenance…">
      </div>
    </div>

    <div class="rp-field-group">
      <label class="rp-label">${gwIcon('check',12,'#2D7A55')} Task Checklist (per visit)</label>
      <div class="rp-task-hint">Crew checks off each task when completing a visit</div>
      <div id="rpTasksWrap">
        ${tasks.map((t,i)=>_rpTaskRow(t.title||t,i)).join('')}
        ${!tasks.length ? _rpTaskRow('',0) : ''}
      </div>
      <button type="button" class="rp-add-task-btn" onclick="_rpAddTask()">
        ${gwIcon('plus',12,'#2D7A55')} Add Task
      </button>
    </div>

    <label class="rp-toggle-label">
      <input type="checkbox" id="rpIsActive" ${!plan||plan.is_active?'checked':''}> Active (clients can subscribe)
    </label>

    <div class="rp-modal-footer">
      <button type="button" class="rp-btn-ghost" onclick="document.getElementById('rp-builder-overlay').remove()">Cancel</button>
      <button type="button" class="rp-btn-primary" onclick="_rpSavePlan('${plan?.id||''}')">
        ${gwIcon('floppy',13,'#fff')} ${plan ? 'Save Changes' : 'Create Plan'}
      </button>
    </div>
  </form>`;
}

function _rpTaskRow(val, idx) {
  return `<div class="rp-task-row" id="rpTask_${idx}">
    <input class="rp-input rp-task-input" type="text" placeholder="e.g. Mow and edge lawn" value="${(val||'').replace(/"/g,'&quot;')}">
    <button type="button" class="rp-task-remove" onclick="document.getElementById('rpTask_${idx}').remove()">${gwIcon('trash',12,'#9CA3AF')}</button>
  </div>`;
}

let _rpTaskCount = 1;
window._rpAddTask = function() {
  const wrap = document.getElementById('rpTasksWrap');
  if (!wrap) return;
  const div = document.createElement('div');
  div.innerHTML = _rpTaskRow('', _rpTaskCount++);
  wrap.appendChild(div.firstElementChild);
};

window._rpUpdateFreqDays = function() {
  const freq = document.getElementById('rpFrequency')?.value;
  const group = document.getElementById('rpCustomDaysGroup');
  if (group) group.style.display = freq==='custom' ? 'block' : 'none';
};

window._rpSavePlan = async function(planId) {
  const name = document.getElementById('rpPlanName')?.value?.trim();
  if (!name) { showToast('Plan name is required','error'); return; }
  const tasks = [];
  document.querySelectorAll('.rp-task-input').forEach(inp => {
    const v = inp.value.trim();
    if (v) tasks.push({ title: v });
  });
  const freq = document.getElementById('rpFrequency')?.value || 'monthly';
  const data = {
    name,
    description:     document.getElementById('rpPlanDesc')?.value?.trim()||'',
    frequency:       freq,
    frequency_days:  freq==='custom' ? parseInt(document.getElementById('rpFreqDays')?.value||30) : (_rpFreqDays[freq]||30),
    price:           parseFloat(document.getElementById('rpPrice')?.value||0)||0,
    estimated_hours: parseFloat(document.getElementById('rpHours')?.value||0)||0,
    crew_size:       parseInt(document.getElementById('rpCrewSize')?.value||1)||1,
    service_type:    document.getElementById('rpServiceType')?.value?.trim()||'',
    tasks:           JSON.stringify(tasks),
    is_active:       document.getElementById('rpIsActive')?.checked ? 1 : 0,
  };
  const method = planId ? 'PUT' : 'POST';
  const url    = planId ? `/api/recurring-plans/${planId}` : '/api/recurring-plans';
  const res = await fetch(url, { method, credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) });
  if (!res.ok) { showToast('Failed to save plan','error'); return; }
  showToast(planId ? 'Plan updated' : 'Plan created!', 'success');
  document.getElementById('rp-builder-overlay')?.remove();
  _rpLoadPlans();
};

window._rpTogglePlan = async function(planId, active) {
  await fetch(`/api/recurring-plans/${planId}`, { method:'PUT', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ is_active: active }) });
  showToast(active ? 'Plan activated' : 'Plan deactivated', 'success');
  _rpLoadPlans();
};

/* ── Utilities ───────────────────────────────────────────────────────────────── */
function _rpCreateOverlay(id) {
  document.getElementById(id)?.remove();
  const overlay = document.createElement('div');
  overlay.id = id;
  overlay.className = 'rp-overlay';
  overlay.addEventListener('click', e => { if(e.target===overlay) overlay.remove(); });
  return overlay;
}

/* ══════════════════════════════════════════════════════════════════════════════
   CSS
   ══════════════════════════════════════════════════════════════════════════════ */
function _rpInjectCSS() {
  document.getElementById('rp-styles')?.remove();
  const style = document.createElement('style');
  style.id = 'rp-styles';
  style.textContent = `
/* ── Shell ── */
.rp-wrap { }
.rp-topbar { display:flex;align-items:center;justify-content:space-between;padding:20px 0 0;gap:12px;flex-wrap:wrap; }
.rp-title-row { display:flex;align-items:center;gap:10px; }
.rp-page-title { font-size:20px;font-weight:800;color:var(--gw-ink);letter-spacing:-.02em; }
.rp-topbar-actions { display:flex;gap:8px; }
.rp-tab-bar { }
.rp-tab { }
.rp-tab--active { }

.rp-content { margin-top:16px; }
.rp-loading { text-align:center;padding:40px;color:var(--gw-muted);font-size:13px;display:flex;align-items:center;justify-content:center;gap:8px; }

/* ── Visit cards ── */
.rp-visits-wrap { display:flex;flex-direction:column;gap:20px; }
.rp-visits-section {}
.rp-visits-hdr { display:flex;align-items:center;gap:7px;font-size:13px;font-weight:700;color:var(--gw-ink);margin-bottom:10px;padding-bottom:7px;border-bottom:1.5px solid var(--gw-line); }
.rp-visits-hdr-over { color:#DC2626; }
.rp-visits-hdr-done { color:var(--gw-muted); }

.rp-visit-card { background:var(--gw-surface);border:1.5px solid var(--gw-line);border-radius:14px;overflow:hidden;margin-bottom:8px;transition:border-color .15s; }
.rp-visit-card:hover { border-color:#2D7A55; }
.rp-visit-overdue { border-color:#FCA5A5!important;background:rgba(220,38,38,.04); }
.rp-visit-priority { border-color:#F59E0B!important; }

.rp-priority-banner { display:flex;flex-direction:column;gap:3px;padding:9px 14px 9px;background:rgba(245,158,11,.12);border-bottom:1.5px solid rgba(245,158,11,.3); }
.rp-priority-banner > span:first-child { display:flex;align-items:center;gap:5px;font-size:11px;font-weight:800;color:#92400E;text-transform:uppercase;letter-spacing:.04em; }
.rp-priority-peek { font-size:12px;color:#92400E;line-height:1.4; }

.rp-vc-main { display:flex;align-items:center;gap:14px;padding:13px 16px; }
.rp-vc-date-col { flex-shrink:0;width:72px;text-align:center; }
.rp-vc-date { font-size:14px;font-weight:800;color:var(--gw-ink); }
.rp-vc-due { font-size:11px;font-weight:700;color:#2D7A55;margin-top:3px; }
.rp-vc-due-soon { color:#D97706; }
.rp-vc-due-over { color:#DC2626; }
.rp-vc-body { flex:1;min-width:0; }
.rp-vc-client { font-size:15px;font-weight:700;color:var(--gw-ink); }
.rp-vc-plan { font-size:11px;color:var(--gw-muted);display:flex;align-items:center;gap:3px;margin-top:2px; }
.rp-vc-crew { font-size:11px;color:var(--gw-muted);display:flex;align-items:center;gap:3px;margin-top:2px; }
.rp-vc-crew-unset { color:#D1D5DB; }
.rp-vc-addr { font-size:11px;color:var(--gw-muted);display:flex;align-items:center;gap:3px;margin-top:2px; }
.rp-vc-right { display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0; }
.rp-vc-hours { font-size:11px;color:var(--gw-muted);display:flex;align-items:center;gap:3px; }

/* ── Visit detail modal ── */
.rp-visit-modal { max-width:620px; }
.rp-vd-meta-grid { display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;background:var(--gw-surface-2);border-radius:10px;padding:14px;margin-bottom:16px; }
.rp-vd-section { margin-bottom:16px; }
.rp-vd-section-title { display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:var(--gw-ink);margin-bottom:8px; }
.rp-vd-section-hint { font-size:10px;font-weight:400;color:var(--gw-muted);margin-left:4px; }
.rp-vd-val { font-size:13px;color:var(--gw-ink);padding:4px 0; }
.rp-access-note { font-size:11px;color:var(--gw-muted);margin-top:6px;display:flex;align-items:center;gap:4px; }
.rp-comp-client { font-size:15px;font-weight:700;color:var(--gw-ink);margin-bottom:16px; }

/* ── Priority note box ── */
.rp-pri-box { padding:14px 16px;background:rgba(245,158,11,.1);border:1.5px solid rgba(245,158,11,.4);border-radius:12px;margin-bottom:16px; }
.rp-pri-box.rp-pri-acked { background:rgba(45,122,85,.08);border-color:rgba(45,122,85,.3); }
.rp-pri-label { display:flex;align-items:center;gap:6px;font-size:12px;font-weight:800;color:#92400E;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px; }
.rp-pri-box.rp-pri-acked .rp-pri-label { color:#166534; }
.rp-pri-text { font-size:14px;color:var(--gw-ink);line-height:1.6;font-weight:500; }
.rp-pri-acked-tag { font-size:10px;background:#DCFCE7;color:#166534;border:1px solid #BBF7D0;border-radius:99px;padding:2px 8px;font-weight:700;letter-spacing:0;text-transform:none;margin-left:4px; }
.rp-pri-ack-info { font-size:11px;color:var(--gw-muted);margin-top:8px; }
.rp-btn-ack { display:inline-flex;align-items:center;gap:6px;margin-top:12px;padding:9px 18px;background:#2D7A55;color:#fff;border:none;border-radius:9px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit; }
.rp-btn-ack:hover { background:#256645; }

/* ── Checklist ── */
.rp-checklist { display:flex;flex-direction:column;gap:2px; }
.rp-check-row { display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;cursor:pointer;font-size:13px;color:var(--gw-ink);border:1.5px solid transparent;transition:all .15s; }
.rp-check-row:hover { background:var(--gw-surface-2); }
.rp-check-row input[type=checkbox] { width:16px;height:16px;accent-color:#2D7A55;flex-shrink:0;cursor:pointer; }
.rp-check-done { text-decoration:line-through;color:var(--gw-muted); }
.rp-check-readonly { cursor:default; }

/* ── Photos ── */
.rp-photos-grid { display:flex;flex-wrap:wrap;gap:10px;margin-bottom:8px; }
.rp-photo-thumb { width:90px;border-radius:8px;overflow:hidden;border:1.5px solid var(--gw-line); }
.rp-photo-thumb img { width:100%;height:70px;object-fit:cover;display:block; }
.rp-photo-cap { font-size:10px;color:var(--gw-muted);padding:4px;text-align:center;background:var(--gw-surface-2); }

/* ── Employee tags ── */
.rp-emp-tags { display:flex;flex-wrap:wrap;gap:6px;min-height:32px;padding:4px 0; }
.rp-emp-tag { display:inline-flex;align-items:center;gap:4px;background:var(--gw-surface-2);border:1.5px solid var(--gw-line);border-radius:20px;padding:3px 10px;font-size:12px;font-weight:600;color:var(--gw-ink); }
.rp-emp-tag button { background:none;border:none;cursor:pointer;font-size:14px;color:var(--gw-muted);padding:0;line-height:1; }
.rp-emp-tag button:hover { color:#DC2626; }

/* ── Subscriptions list ── */
.rp-sub-list { display:flex;flex-direction:column;gap:10px; }
.rp-sub-card { background:var(--gw-surface);border:1.5px solid var(--gw-line);border-radius:14px;padding:16px 18px;transition:border-color .15s; }
.rp-sub-card:hover { border-color:#2D7A55; }
.rp-sub-inactive { opacity:.6; }
.rp-sub-card-top { display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px;gap:10px; }
.rp-sub-identity {}
.rp-sub-client { font-size:16px;font-weight:800;color:var(--gw-ink); }
.rp-sub-plan { font-size:12px;color:var(--gw-muted);margin-top:3px;display:flex;align-items:center;gap:4px; }
.rp-sub-row2 { display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px; }
.rp-kv2 { display:flex;flex-direction:column;gap:3px; }
.rp-kv2 span { font-size:10px;font-weight:700;color:var(--gw-muted);text-transform:uppercase;letter-spacing:.06em; }
.rp-kv2 strong { font-size:13px;color:var(--gw-ink); }
.rp-sub-addr { font-size:12px;color:var(--gw-muted);margin-bottom:4px;display:flex;align-items:center;gap:4px; }
.rp-sub-access { font-size:12px;color:var(--gw-muted);margin-bottom:8px;display:flex;align-items:center;gap:4px; }
.rp-sub-actions { display:flex;gap:6px;flex-wrap:wrap; }

/* ── Plans grid ── */
.rp-plans-grid { display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px; }
.rp-plan-card { background:var(--gw-surface);border:1.5px solid var(--gw-line);border-radius:16px;padding:18px;transition:border-color .15s; }
.rp-plan-card:hover { border-color:#2D7A55; }
.rp-plan-inactive { opacity:.55; }
.rp-plan-card-top { display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px; }
.rp-plan-name { font-size:15px;font-weight:800;color:var(--gw-ink); }
.rp-plan-freq { display:flex;align-items:center;gap:4px;font-size:11px;color:var(--gw-muted);margin-top:3px; }
.rp-plan-price { font-size:18px;font-weight:800;color:#2D7A55;white-space:nowrap; }
.rp-plan-price-unit { font-size:11px;color:var(--gw-muted);font-weight:500; }
.rp-plan-desc { font-size:12px;color:var(--gw-muted);margin-bottom:10px;line-height:1.5; }
.rp-plan-details { display:flex;gap:10px;flex-wrap:wrap;font-size:11px;color:var(--gw-muted);margin-bottom:8px; }
.rp-plan-tasks { margin-bottom:10px; }
.rp-plan-task { display:flex;align-items:center;gap:5px;font-size:12px;color:var(--gw-ink);padding:2px 0; }
.rp-plan-card-footer { display:flex;align-items:center;justify-content:space-between;padding-top:12px;border-top:1px solid var(--gw-line); }
.rp-plan-status { font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em; }
.rp-plan-status-active { color:#2D7A55; }
.rp-plan-status-inactive { color:var(--gw-muted); }
.rp-plan-actions { display:flex;gap:4px; }
.rp-task-hint { font-size:11px;color:var(--gw-muted);margin-bottom:8px; }

/* ── Badges ── */
.rp-badge { display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:12px;font-size:11px;font-weight:700; }
.rp-badge--active    { background:rgba(22,101,52,.12);color:#166534; }
.rp-badge--paused    { background:rgba(217,119,6,.12);color:#92400E; }
.rp-badge--cancelled { background:rgba(220,38,38,.1);color:#991B1B; }
.rp-badge--completed { background:var(--gw-surface-2);color:var(--gw-muted); }
.rp-badge--scheduled { background:rgba(59,130,246,.1);color:#1D4ED8; }
.rp-badge--inprog    { background:rgba(45,122,85,.12);color:#2D7A55; }
.rp-badge--skipped   { background:var(--gw-surface-2);color:var(--gw-muted); }

/* ── Empty ── */
.rp-empty { text-align:center;padding:60px 20px;background:var(--gw-surface);border:1.5px dashed var(--gw-line);border-radius:14px; }
.rp-empty-icon { margin-bottom:12px;opacity:.3; }
.rp-empty-title { font-size:17px;font-weight:700;color:var(--gw-ink);margin-bottom:6px; }
.rp-empty-sub { font-size:13px;color:var(--gw-muted); }

/* ── Buttons ── */
.rp-btn-primary { display:inline-flex;align-items:center;gap:6px;padding:9px 16px;background:#2D7A55;color:#fff;border:none;border-radius:9px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;transition:background .15s; }
.rp-btn-primary:hover { background:#256645; }
.rp-btn-ghost { display:inline-flex;align-items:center;gap:6px;padding:8px 13px;background:var(--gw-surface);color:var(--gw-ink);border:1.5px solid var(--gw-line);border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;transition:border-color .15s; }
.rp-btn-ghost:hover { border-color:var(--gw-muted); }
.rp-btn-sm { display:inline-flex;align-items:center;gap:4px;padding:5px 10px;background:var(--gw-surface-2);color:var(--gw-ink);border:1.5px solid var(--gw-line);border-radius:7px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;transition:border-color .15s; }
.rp-btn-sm:hover { border-color:#2D7A55;color:#2D7A55; }
.rp-btn-detail { }
.rp-btn-complete { background:rgba(45,122,85,.1);color:#2D7A55;border-color:rgba(45,122,85,.3); }
.rp-btn-complete:hover { background:rgba(45,122,85,.18); }
.rp-btn-complete-big { display:inline-flex;align-items:center;gap:7px;padding:10px 20px;background:#2D7A55;color:#fff;border:none;border-radius:9px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;transition:background .15s; }
.rp-btn-complete-big:hover { background:#256645; }
.rp-btn-pause { color:#D97706;border-color:rgba(217,119,6,.35); }
.rp-btn-activate { color:#2D7A55;border-color:rgba(45,122,85,.35); }
.rp-action-btn { width:30px;height:30px;border:1.5px solid var(--gw-line);background:var(--gw-surface);border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:border-color .15s; }
.rp-action-btn:hover { border-color:#2D7A55; }

/* ── Modal ── */
.rp-overlay { position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9990;display:flex;align-items:flex-start;justify-content:center;padding:32px 16px;overflow-y:auto; }
.rp-modal { background:var(--gw-surface);border-radius:18px;width:100%;box-shadow:0 24px 80px rgba(0,0,0,.35); }
.rp-builder-modal { max-width:580px; }
.rp-sub-modal { max-width:520px; }
.rp-modal-header { display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1.5px solid var(--gw-line); }
.rp-modal-title { display:flex;align-items:center;gap:10px;font-size:16px;font-weight:800;color:var(--gw-ink); }
.rp-modal-close { width:32px;height:32px;border:none;background:var(--gw-surface-2);border-radius:8px;font-size:18px;cursor:pointer;color:var(--gw-muted);display:flex;align-items:center;justify-content:center; }
.rp-modal-body { padding:22px; }
.rp-modal-footer { display:flex;align-items:center;justify-content:flex-end;gap:10px;padding-top:16px;border-top:1.5px solid var(--gw-line);margin-top:16px; }

/* ── Form ── */
.rp-field-group { margin-bottom:14px; }
.rp-label { display:block;font-size:11px;font-weight:700;color:var(--gw-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px; }
.rp-req { color:#EF4444; }
.rp-input { width:100%;padding:8px 11px;border:1.5px solid var(--gw-line);border-radius:9px;font-size:13px;font-family:inherit;color:var(--gw-ink);background:var(--gw-surface);outline:none;transition:border-color .15s;box-sizing:border-box; }
.rp-input:focus { border-color:#2D7A55;box-shadow:0 0 0 3px rgba(45,122,85,.1); }
.rp-select { width:100%;padding:8px 11px;border:1.5px solid var(--gw-line);border-radius:9px;font-size:13px;font-family:inherit;color:var(--gw-ink);background:var(--gw-surface);outline:none; }
.rp-textarea { width:100%;padding:8px 11px;border:1.5px solid var(--gw-line);border-radius:9px;font-size:13px;font-family:inherit;color:var(--gw-ink);background:var(--gw-surface);outline:none;resize:vertical;box-sizing:border-box; }
.rp-textarea:focus,.rp-select:focus { border-color:#2D7A55; }
.rp-row2 { display:grid;grid-template-columns:1fr 1fr;gap:12px; }
.rp-toggle-label { display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--gw-ink);cursor:pointer; }
.rp-toggle-label input { accent-color:#2D7A55;width:15px;height:15px; }

/* Tasks */
.rp-task-row { display:grid;grid-template-columns:1fr 30px;gap:8px;align-items:center;margin-bottom:6px; }
.rp-task-remove { width:30px;height:30px;border:1.5px solid var(--gw-line);background:var(--gw-surface);border-radius:7px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0; }
.rp-task-remove:hover { border-color:#EF4444; }
.rp-add-task-btn { display:flex;align-items:center;gap:6px;padding:7px 12px;background:transparent;border:1.5px dashed var(--gw-line);border-radius:9px;font-size:12px;font-weight:600;color:#2D7A55;cursor:pointer;font-family:inherit;width:100%;justify-content:center;margin-top:4px; }
.rp-add-task-btn:hover { border-color:#2D7A55;background:rgba(45,122,85,.05); }

/* Colors */
.rp-text-red { color:#DC2626; }
.rp-text-amber { color:#D97706; }
.rp-status-btn-active { border-color:#2D7A55!important;color:#2D7A55!important;background:rgba(45,122,85,.08)!important; }

/* KV meta */
.rp-kv { font-size:13px;color:var(--gw-ink);display:flex;flex-direction:column;gap:3px; }
.rp-kv > span:first-child { font-size:10px;font-weight:700;color:var(--gw-muted);text-transform:uppercase;letter-spacing:.06em; }

@media(max-width:640px){
  .rp-vc-main { gap:10px; }
  .rp-vc-date-col { width:56px; }
  .rp-sub-row2 { grid-template-columns:1fr 1fr; }
  .rp-plans-grid { grid-template-columns:1fr; }
  .rp-vd-meta-grid { grid-template-columns:1fr 1fr; }
  .rp-row2 { grid-template-columns:1fr; }
  .rp-tab { padding:8px 10px;font-size:12px; }
}
  `;
  document.head.appendChild(style);
}
