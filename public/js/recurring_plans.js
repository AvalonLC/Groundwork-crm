// ── Groundwork CRM — Recurring Service Plans ──────────────────────────────────
// Plan builder + subscription management + visit scheduling dashboard
// Version: 20260711p48
// Depends on: gw-icons.js, app_premium.js (showToast, gwIcon)
// ─────────────────────────────────────────────────────────────────────────────

/* ── Frequency display helpers ─────────────────────────────────────────────── */
const _rpFreqLabels = {
  weekly:     'Weekly',
  biweekly:   'Bi-Weekly',
  monthly:    'Monthly',
  bimonthly:  'Every 2 Months',
  quarterly:  'Quarterly',
  semiannual: 'Semi-Annual',
  annual:     'Annual',
  custom:     'Custom',
};

function _rpFmt(n)    { return '$' + (Number(n)||0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,','); }
function _rpDate(d)   { if(!d) return '—'; const dt=new Date(d+'T00:00:00'); return dt.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); }
function _rpAgo(d)    { if(!d) return ''; const ms=Date.now()-new Date(d).getTime(); const days=Math.floor(ms/86400000); return days===0?'Today':days===1?'Yesterday':`${days}d ago`; }

function _rpStatusBadge(status) {
  const cfg = {
    active:    { cls:'rp-badge--active',    icon:'check-circle', label:'Active'    },
    paused:    { cls:'rp-badge--paused',    icon:'timer',        label:'Paused'    },
    cancelled: { cls:'rp-badge--cancelled', icon:'status-declined', label:'Cancelled' },
    completed: { cls:'rp-badge--completed', icon:'status-accepted', label:'Completed' },
  };
  const s = cfg[status] || cfg.active;
  return `<span class="rp-badge ${s.cls}">${gwIcon(s.icon,10,'currentColor')}&nbsp;${s.label}</span>`;
}

/* ── State ─────────────────────────────────────────────────────────────────── */
let _rpActiveTab = 'plans'; // 'plans' | 'subscriptions' | 'visits'

/* ── Main entry point ─────────────────────────────────────────────────────── */
window.gwRecurringPlans = function() {
  const panel = document.getElementById('contentArea') || document.getElementById('premiumContent');
  if (!panel) return;
  panel.innerHTML = _rpSkeleton();
  _rpLoadTab(_rpActiveTab);
};

function _rpSkeleton() {
  return `<div class="rp-wrap">
    <div class="rp-topbar">
      <div class="rp-title-row">
        ${gwIcon('repeat',22,'#1C3A2B')}
        <h1 class="rp-page-title">Recurring Service Plans</h1>
      </div>
      <div class="rp-topbar-actions" id="rpTopbarActions"></div>
    </div>
    <div class="rp-tab-bar">
      <button class="rp-tab ${_rpActiveTab==='plans'?'rp-tab--active':''}" onclick="_rpLoadTab('plans')">
        ${gwIcon('list',13)} Plans
      </button>
      <button class="rp-tab ${_rpActiveTab==='subscriptions'?'rp-tab--active':''}" onclick="_rpLoadTab('subscriptions')">
        ${gwIcon('user',13)} Client Subscriptions
      </button>
      <button class="rp-tab ${_rpActiveTab==='visits'?'rp-tab--active':''}" onclick="_rpLoadTab('visits')">
        ${gwIcon('calendar',13)} Upcoming Visits
      </button>
    </div>
    <div id="rpContent" class="rp-content">
      <div class="rp-loading">${gwIcon('hourglass',20,'#9CA3AF')}&nbsp;Loading…</div>
    </div>
  </div>`;
}

window._rpLoadTab = function(tab) {
  _rpActiveTab = tab;
  document.querySelectorAll('.rp-tab').forEach(t => t.classList.remove('rp-tab--active'));
  document.querySelectorAll('.rp-tab').forEach(t => {
    if (t.textContent.toLowerCase().includes(tab === 'plans' ? 'plan' : tab === 'subscriptions' ? 'client' : 'visit'))
      t.classList.add('rp-tab--active');
  });

  const actions = document.getElementById('rpTopbarActions');
  if (actions) {
    actions.innerHTML = tab === 'plans'
      ? `<button class="rp-btn-primary" onclick="_rpOpenPlanBuilder(null)">${gwIcon('plus',13,'#fff')} New Plan</button>`
      : tab === 'subscriptions'
      ? `<button class="rp-btn-primary" onclick="_rpOpenSubscribeModal()">${gwIcon('plus',13,'#fff')} Add Subscription</button>`
      : '';
  }

  if (tab === 'plans')         _rpLoadPlans();
  if (tab === 'subscriptions') _rpLoadSubscriptions();
  if (tab === 'visits')        _rpLoadVisits();
};

/* ── Plans list ─────────────────────────────────────────────────────────────── */
async function _rpLoadPlans() {
  const content = document.getElementById('rpContent');
  if (!content) return;
  content.innerHTML = `<div class="rp-loading">${gwIcon('hourglass',20,'#9CA3AF')}&nbsp;Loading plans…</div>`;

  const res = await fetch('/api/recurring-plans', { credentials: 'include' });
  const plans = res.ok ? await res.json() : [];

  if (!plans.length) {
    content.innerHTML = `<div class="rp-empty">
      <div class="rp-empty-icon">${gwIcon('repeat',48,'#D1D5DB')}</div>
      <div class="rp-empty-title">No recurring plans yet</div>
      <div class="rp-empty-sub">Create a plan to offer clients automatic scheduled services.</div>
      <button class="rp-btn-primary" style="margin-top:16px" onclick="_rpOpenPlanBuilder(null)">
        ${gwIcon('plus',13,'#fff')} Create First Plan
      </button>
    </div>`;
    return;
  }

  content.innerHTML = `<div class="rp-plans-grid">
    ${plans.map(p => {
      const tasks = _rpParseTasks(p.tasks);
      return `<div class="rp-plan-card ${!p.is_active?'rp-plan-inactive':''}">
        <div class="rp-plan-card-top">
          <div>
            <div class="rp-plan-name">${p.name}</div>
            <div class="rp-plan-freq">${gwIcon('repeat',11,'#9CA3AF')} ${_rpFreqLabels[p.frequency]||p.frequency}</div>
          </div>
          <div class="rp-plan-price">${_rpFmt(p.price)}<span class="rp-plan-price-unit">/${p.frequency==='monthly'?'mo':p.frequency==='weekly'?'wk':p.frequency==='annual'?'yr':'visit'}</span></div>
        </div>
        ${p.description ? `<div class="rp-plan-desc">${p.description}</div>` : ''}
        ${tasks.length ? `<div class="rp-plan-tasks">
          ${tasks.slice(0,3).map(t=>`<div class="rp-plan-task">${gwIcon('check',10,'#2D7A55')} ${t.title}</div>`).join('')}
          ${tasks.length>3?`<div class="rp-plan-task rp-plan-task-more">+${tasks.length-3} more tasks</div>`:''}
        </div>`:''}
        <div class="rp-plan-card-footer">
          <div class="rp-plan-status ${p.is_active?'rp-plan-status-active':'rp-plan-status-inactive'}">${p.is_active?'Active':'Inactive'}</div>
          <div class="rp-plan-actions">
            <button class="rp-action-btn" onclick="_rpOpenPlanBuilder('${p.id}')" title="Edit">${gwIcon('edit',13,'#6B7280')}</button>
            <button class="rp-action-btn" onclick="_rpOpenSubscribeModal('${p.id}')" title="Subscribe client">${gwIcon('user-plus',13,'#2D7A55')}</button>
            <button class="rp-action-btn rp-action-toggle" onclick="_rpTogglePlan('${p.id}',${p.is_active?0:1})" title="${p.is_active?'Deactivate':'Activate'}">${gwIcon(p.is_active?'pause':'play',13,'#6B7280')}</button>
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
    const res = await fetch(`/api/recurring-plans/${planId}`, { credentials: 'include' });
    if (res.ok) plan = await res.json();
  }
  const overlay = _rpCreateOverlay('rp-builder-overlay');
  overlay.innerHTML = `<div class="rp-modal rp-builder-modal">
    <div class="rp-modal-header">
      <div class="rp-modal-title">${gwIcon('repeat',18,'#1C3A2B')} ${planId ? 'Edit Plan' : 'New Recurring Plan'}</div>
      <button class="rp-modal-close" onclick="document.getElementById('rp-builder-overlay').remove()">×</button>
    </div>
    <div class="rp-modal-body">
      ${_rpPlanBuilderForm(plan)}
    </div>
  </div>`;
  document.body.appendChild(overlay);
};

function _rpPlanBuilderForm(plan) {
  const tasks = _rpParseTasks(plan?.tasks);
  return `<form id="rpPlanForm">
    <div class="rp-field-group">
      <label class="rp-label">Plan Name <span class="rp-req">*</span></label>
      <input class="rp-input" type="text" id="rpPlanName" value="${plan?.name||''}" placeholder="Monthly Lawn Maintenance" required>
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
        <input class="rp-input" type="number" id="rpFreqDays" value="${plan?.frequency_days||30}" min="1" placeholder="30">
      </div>
    </div>
    <div class="rp-row2">
      <div class="rp-field-group">
        <label class="rp-label">Price per Visit ($)</label>
        <input class="rp-input" type="number" id="rpPrice" value="${plan?.price||''}" min="0" step="0.01" placeholder="0.00">
      </div>
      <div class="rp-field-group">
        <label class="rp-label">Estimated Hours</label>
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
        <input class="rp-input" type="text" id="rpServiceType" value="${plan?.service_type||''}" placeholder="Lawn Care, HVAC, etc.">
      </div>
    </div>

    <div class="rp-field-group">
      <label class="rp-label">${gwIcon('list',12,'#6B7280')} Task Checklist (per visit)</label>
      <div id="rpTasksWrap">
        ${tasks.map((t,i) => _rpTaskRow(t.title, i)).join('')}
        ${!tasks.length ? _rpTaskRow('', 0) : ''}
      </div>
      <button type="button" class="rp-add-task-btn" onclick="_rpAddTask()">
        ${gwIcon('plus',12,'#2D7A55')} Add Task
      </button>
    </div>

    <div class="rp-field-group">
      <label class="rp-toggle-label">
        <input type="checkbox" id="rpIsActive" ${!plan || plan.is_active ? 'checked' : ''}> Active (clients can subscribe)
      </label>
    </div>

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
    <input class="rp-input rp-task-input" type="text" placeholder="Task description…" value="${(val||'').replace(/"/g,'&quot;')}">
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
  if (group) group.style.display = freq === 'custom' ? 'block' : 'none';
};

window._rpSavePlan = async function(planId) {
  const name = document.getElementById('rpPlanName')?.value?.trim();
  if (!name) { showToast('Plan name is required', 'error'); return; }

  const tasks = [];
  document.querySelectorAll('.rp-task-input').forEach(inp => {
    const v = inp.value.trim();
    if (v) tasks.push({ title: v });
  });

  const freq = document.getElementById('rpFrequency')?.value || 'monthly';
  const freqDaysMap = { weekly:7, biweekly:14, monthly:30, bimonthly:60, quarterly:90, semiannual:180, annual:365 };

  const data = {
    name,
    description:     document.getElementById('rpPlanDesc')?.value?.trim() || '',
    frequency:       freq,
    frequency_days:  freq === 'custom' ? parseInt(document.getElementById('rpFreqDays')?.value||30) : (freqDaysMap[freq]||30),
    price:           parseFloat(document.getElementById('rpPrice')?.value||0) || 0,
    estimated_hours: parseFloat(document.getElementById('rpHours')?.value||0) || 0,
    crew_size:       parseInt(document.getElementById('rpCrewSize')?.value||1) || 1,
    service_type:    document.getElementById('rpServiceType')?.value?.trim() || '',
    tasks:           JSON.stringify(tasks),
    is_active:       document.getElementById('rpIsActive')?.checked ? 1 : 0,
  };

  const method = planId ? 'PUT' : 'POST';
  const url    = planId ? `/api/recurring-plans/${planId}` : '/api/recurring-plans';
  const res = await fetch(url, { method, credentials: 'include', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
  if (!res.ok) { showToast('Failed to save plan', 'error'); return; }
  showToast(planId ? 'Plan updated' : 'Plan created', 'success');
  document.getElementById('rp-builder-overlay')?.remove();
  _rpLoadPlans();
};

window._rpTogglePlan = async function(planId, active) {
  await fetch(`/api/recurring-plans/${planId}`, { method: 'PUT', credentials: 'include', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ is_active: active }) });
  showToast(active ? 'Plan activated' : 'Plan deactivated', 'success');
  _rpLoadPlans();
};

/* ── Subscriptions list ─────────────────────────────────────────────────────── */
async function _rpLoadSubscriptions() {
  const content = document.getElementById('rpContent');
  if (!content) return;
  content.innerHTML = `<div class="rp-loading">${gwIcon('hourglass',20,'#9CA3AF')}&nbsp;Loading subscriptions…</div>`;

  const [subRes, planRes] = await Promise.all([
    fetch('/api/recurring-subscriptions', { credentials: 'include' }),
    fetch('/api/recurring-plans', { credentials: 'include' })
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
        ${gwIcon('plus',13,'#fff')} Add Subscription
      </button>
    </div>`;
    return;
  }

  content.innerHTML = `<div class="rp-table-wrap">
    <table class="rp-table">
      <thead><tr>
        <th>Client</th><th>Plan</th><th>Frequency</th><th>Price</th>
        <th>Start Date</th><th>Next Visit</th><th>Visits</th><th>Status</th><th></th>
      </tr></thead>
      <tbody>
        ${subs.map(s => {
          const plan = planMap[s.plan_id] || {};
          return `<tr class="rp-row">
            <td class="rp-td-name">${s.client_name||'—'}</td>
            <td>${plan.name||'—'}</td>
            <td>${_rpFreqLabels[plan.frequency]||'—'}</td>
            <td>${_rpFmt(s.custom_price || plan.price || 0)}</td>
            <td>${_rpDate(s.start_date)}</td>
            <td class="${s.next_visit_date&&new Date(s.next_visit_date+'T00:00:00')<new Date()?'rp-overdue':''}">${_rpDate(s.next_visit_date)}</td>
            <td>${s.visit_count||0}</td>
            <td>${_rpStatusBadge(s.status)}</td>
            <td>
              <div class="rp-row-actions">
                <button class="rp-action-btn" onclick="_rpOpenSubDetail('${s.id}')" title="Manage">${gwIcon('edit',12,'#6B7280')}</button>
                <button class="rp-action-btn" onclick="_rpLogVisit('${s.id}','${s.client_name||''}')" title="Log visit">${gwIcon('check-circle',12,'#2D7A55')}</button>
              </div>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>`;
}

/* ── Subscribe Client Modal ─────────────────────────────────────────────────── */
window._rpOpenSubscribeModal = async function(prefillPlanId) {
  const [planRes, clientRes] = await Promise.all([
    fetch('/api/recurring-plans?active=1', { credentials: 'include' }),
    fetch('/api/clients?limit=500', { credentials: 'include' })
  ]);
  const plans   = planRes.ok   ? await planRes.json()   : [];
  const clients = clientRes.ok ? await clientRes.json() : [];

  const overlay = _rpCreateOverlay('rp-sub-overlay');
  const defaultDue = new Date().toISOString().split('T')[0];

  overlay.innerHTML = `<div class="rp-modal rp-sub-modal">
    <div class="rp-modal-header">
      <div class="rp-modal-title">${gwIcon('user-plus',18,'#1C3A2B')} Subscribe Client to Plan</div>
      <button class="rp-modal-close" onclick="document.getElementById('rp-sub-overlay').remove()">×</button>
    </div>
    <div class="rp-modal-body">
      <div class="rp-field-group">
        <label class="rp-label">Client <span class="rp-req">*</span></label>
        <select class="rp-select" id="rpSubClient">
          <option value="">Select client…</option>
          ${clients.map(c=>`<option value="${c.id}" data-name="${(c.name||'').replace(/"/g,'&quot;')}">${c.name}</option>`).join('')}
        </select>
      </div>
      <div class="rp-field-group">
        <label class="rp-label">Plan <span class="rp-req">*</span></label>
        <select class="rp-select" id="rpSubPlan" onchange="_rpUpdateSubPreview()">
          <option value="">Select plan…</option>
          ${plans.map(p=>`<option value="${p.id}" data-price="${p.price}" data-freq="${p.frequency}" ${prefillPlanId===p.id?'selected':''}>${p.name} — ${_rpFmt(p.price)}/${_rpFreqLabels[p.frequency]||p.frequency}</option>`).join('')}
        </select>
      </div>
      <div class="rp-row2">
        <div class="rp-field-group">
          <label class="rp-label">Start Date</label>
          <input class="rp-input" type="date" id="rpSubStart" value="${defaultDue}">
        </div>
        <div class="rp-field-group">
          <label class="rp-label">Custom Price (optional)</label>
          <input class="rp-input" type="number" id="rpSubCustomPrice" placeholder="Leave blank for plan price" min="0" step="0.01">
        </div>
      </div>
      <div class="rp-field-group">
        <label class="rp-label">Notes</label>
        <input class="rp-input" type="text" id="rpSubNotes" placeholder="Access code: 1234, gate at rear…">
      </div>
      <div class="rp-field-group">
        <label class="rp-toggle-label">
          <input type="checkbox" id="rpSubAutoInvoice"> Auto-create invoice after each visit
        </label>
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
  const clientSel = document.getElementById('rpSubClient');
  const planSel   = document.getElementById('rpSubPlan');
  const clientId  = clientSel?.value;
  const planId    = planSel?.value;
  const clientName= clientSel?.options[clientSel.selectedIndex]?.getAttribute('data-name') || '';
  const startDate = document.getElementById('rpSubStart')?.value || '';
  const customPrc = parseFloat(document.getElementById('rpSubCustomPrice')?.value||0) || 0;
  const notes     = document.getElementById('rpSubNotes')?.value?.trim() || '';
  const autoInv   = document.getElementById('rpSubAutoInvoice')?.checked ? 1 : 0;

  if (!clientId) { showToast('Select a client', 'error'); return; }
  if (!planId)   { showToast('Select a plan', 'error'); return; }

  // Calculate first next_visit_date
  const start = startDate || new Date().toISOString().split('T')[0];
  const planOpt = planSel?.options[planSel.selectedIndex];
  const freq = planOpt?.getAttribute('data-freq') || 'monthly';
  const freqDaysMap = { weekly:7,biweekly:14,monthly:30,bimonthly:60,quarterly:90,semiannual:180,annual:365 };
  const days = freqDaysMap[freq] || 30;
  const nextVisit = new Date(new Date(start+'T00:00:00').getTime() + days*86400000).toISOString().split('T')[0];

  const res = await fetch('/api/recurring-subscriptions', {
    method: 'POST', credentials: 'include',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      plan_id: planId, client_id: clientId, client_name: clientName,
      start_date: start, next_visit_date: nextVisit,
      custom_price: customPrc, notes, auto_invoice: autoInv, status: 'active'
    })
  });
  if (!res.ok) { showToast('Failed to create subscription', 'error'); return; }
  showToast(`${clientName} subscribed!`, 'success');
  document.getElementById('rp-sub-overlay')?.remove();
  _rpLoadSubscriptions();
};

/* ── Log Visit ──────────────────────────────────────────────────────────────── */
window._rpLogVisit = async function(subId, clientName) {
  if (!confirm(`Log a completed visit for ${clientName}?`)) return;

  const res = await fetch(`/api/recurring-subscriptions/${subId}/log-visit`, {
    method: 'POST', credentials: 'include',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ completed_date: new Date().toISOString().split('T')[0], status: 'completed' })
  });
  const data = await res.json();
  if (!res.ok) { showToast('Failed to log visit', 'error'); return; }
  showToast(`Visit logged! Next visit: ${data.next_visit_date || 'TBD'}`, 'success');
  _rpLoadSubscriptions();
};

/* ── Subscription Detail Modal ───────────────────────────────────────────────── */
window._rpOpenSubDetail = async function(subId) {
  const res = await fetch(`/api/recurring-subscriptions/${subId}`, { credentials: 'include' });
  if (!res.ok) return;
  const sub = await res.json();

  const overlay = _rpCreateOverlay('rp-subdetail-overlay');
  overlay.innerHTML = `<div class="rp-modal rp-sub-modal">
    <div class="rp-modal-header">
      <div class="rp-modal-title">${gwIcon('user',18,'#1C3A2B')} ${sub.client_name||'Client'} — Subscription</div>
      <button class="rp-modal-close" onclick="document.getElementById('rp-subdetail-overlay').remove()">×</button>
    </div>
    <div class="rp-modal-body">
      <div class="rp-sub-detail-grid">
        <div class="rp-kv"><span>Status</span>${_rpStatusBadge(sub.status)}</div>
        <div class="rp-kv"><span>Start Date</span>${_rpDate(sub.start_date)}</div>
        <div class="rp-kv"><span>Next Visit</span><strong>${_rpDate(sub.next_visit_date)}</strong></div>
        <div class="rp-kv"><span>Last Visit</span>${_rpDate(sub.last_visit_date)}</div>
        <div class="rp-kv"><span>Total Visits</span>${sub.visit_count||0}</div>
        <div class="rp-kv"><span>Price</span>${_rpFmt(sub.custom_price||0)}</div>
      </div>
      ${sub.notes ? `<div class="rp-sub-notes">${gwIcon('document',13,'#6B7280')} ${sub.notes}</div>` : ''}
      <div class="rp-sub-status-actions">
        <div class="rp-sub-status-label">${gwIcon('settings',13,'#6B7280')} Change Status:</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${['active','paused','cancelled','completed'].map(s =>
            `<button class="rp-btn-ghost rp-status-btn ${sub.status===s?'rp-status-btn-active':''}"
              onclick="_rpUpdateSubStatus('${subId}','${s}')">${s.charAt(0).toUpperCase()+s.slice(1)}</button>`
          ).join('')}
        </div>
      </div>
    </div>
    <div class="rp-modal-footer">
      <button class="rp-btn-ghost" onclick="document.getElementById('rp-subdetail-overlay').remove()">Close</button>
      <button class="rp-btn-primary" onclick="_rpLogVisit('${subId}','${sub.client_name||'client'}');document.getElementById('rp-subdetail-overlay').remove()">
        ${gwIcon('check-circle',13,'#fff')} Log Visit
      </button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
};

window._rpUpdateSubStatus = async function(subId, status) {
  await fetch(`/api/recurring-subscriptions/${subId}`, { method: 'PUT', credentials: 'include', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ status }) });
  showToast(`Subscription ${status}`, 'success');
  document.getElementById('rp-subdetail-overlay')?.remove();
  _rpLoadSubscriptions();
};

/* ── Upcoming Visits ─────────────────────────────────────────────────────────── */
async function _rpLoadVisits() {
  const content = document.getElementById('rpContent');
  if (!content) return;
  content.innerHTML = `<div class="rp-loading">${gwIcon('hourglass',20,'#9CA3AF')}&nbsp;Loading upcoming visits…</div>`;

  const res = await fetch('/api/recurring-subscriptions?status=active&upcoming=1', { credentials: 'include' });
  const subs = res.ok ? await res.json() : [];

  // Sort by next_visit_date
  subs.sort((a,b) => (a.next_visit_date||'').localeCompare(b.next_visit_date||''));

  if (!subs.length) {
    content.innerHTML = `<div class="rp-empty">
      <div class="rp-empty-icon">${gwIcon('calendar',48,'#D1D5DB')}</div>
      <div class="rp-empty-title">No upcoming visits</div>
      <div class="rp-empty-sub">Subscribe clients to plans to see their scheduled visits here.</div>
    </div>`;
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  const thisWeekEnd = new Date(Date.now() + 7*86400000).toISOString().split('T')[0];
  const thisMonthEnd = new Date(Date.now() + 30*86400000).toISOString().split('T')[0];

  const overdue  = subs.filter(s => s.next_visit_date && s.next_visit_date < today);
  const thisWeek = subs.filter(s => s.next_visit_date >= today && s.next_visit_date <= thisWeekEnd);
  const upcoming = subs.filter(s => s.next_visit_date > thisWeekEnd && s.next_visit_date <= thisMonthEnd);

  function _rpVisitRow(s) {
    const isOverdue = s.next_visit_date < today;
    return `<div class="rp-visit-row ${isOverdue?'rp-visit-overdue':''}">
      <div class="rp-visit-date ${isOverdue?'rp-overdue':''}">
        ${_rpDate(s.next_visit_date)}
        ${isOverdue ? `<span class="rp-overdue-badge">Overdue</span>` : ''}
      </div>
      <div class="rp-visit-client">${s.client_name||'—'}</div>
      <div class="rp-visit-plan">${gwIcon('repeat',11,'#9CA3AF')} ${s.plan_name||'Plan'}</div>
      <div class="rp-visit-price">${_rpFmt(s.custom_price||s.plan_price||0)}</div>
      <div class="rp-visit-actions">
        <button class="rp-btn-sm" onclick="_rpLogVisit('${s.id}','${s.client_name||''}')">${gwIcon('check',11,'#2D7A55')} Done</button>
      </div>
    </div>`;
  }

  content.innerHTML = `<div class="rp-visits-wrap">
    ${overdue.length ? `
      <div class="rp-visits-section">
        <div class="rp-visits-section-title rp-overdue">${gwIcon('alert',14,'#DC2626')} Overdue (${overdue.length})</div>
        ${overdue.map(_rpVisitRow).join('')}
      </div>` : ''}
    ${thisWeek.length ? `
      <div class="rp-visits-section">
        <div class="rp-visits-section-title">${gwIcon('calendar',14,'#2D7A55')} This Week (${thisWeek.length})</div>
        ${thisWeek.map(_rpVisitRow).join('')}
      </div>` : ''}
    ${upcoming.length ? `
      <div class="rp-visits-section">
        <div class="rp-visits-section-title">${gwIcon('hourglass',14,'#6B7280')} Next 30 Days (${upcoming.length})</div>
        ${upcoming.map(_rpVisitRow).join('')}
      </div>` : ''}
  </div>`;
}

/* ── Helper ──────────────────────────────────────────────────────────────────── */
function _rpParseTasks(t) {
  if (!t) return [];
  try { return JSON.parse(t); } catch(_) { return []; }
}

function _rpCreateOverlay(id) {
  document.getElementById(id)?.remove();
  const overlay = document.createElement('div');
  overlay.id = id;
  overlay.className = 'rp-overlay';
  overlay.addEventListener('click', e => { if(e.target===overlay) overlay.remove(); });
  return overlay;
}

/* ── CSS ─────────────────────────────────────────────────────────────────────── */
(function _rpInjectCSS() {
  if (document.getElementById('rp-styles')) return;
  const style = document.createElement('style');
  style.id = 'rp-styles';
  style.textContent = `
.rp-wrap { padding:0 0 40px;max-width:1200px; }
.rp-topbar { display:flex;align-items:center;justify-content:space-between;padding:24px 0 0;gap:12px;flex-wrap:wrap; }
.rp-title-row { display:flex;align-items:center;gap:10px; }
.rp-page-title { font-size:22px;font-weight:800;color:#1C3A2B;letter-spacing:-.02em; }
.rp-topbar-actions { display:flex;gap:8px; }
.rp-tab-bar { display:flex;gap:4px;margin:16px 0 0;border-bottom:2px solid #E5E7EB;padding-bottom:0; }
.rp-tab { display:inline-flex;align-items:center;gap:6px;padding:9px 16px;background:transparent;border:none;border-bottom:2px solid transparent;margin-bottom:-2px;font-size:13px;font-weight:600;color:#6B7280;cursor:pointer;font-family:inherit;transition:all .15s; }
.rp-tab--active { color:#2D7A55;border-bottom-color:#2D7A55; }
.rp-tab:hover { color:#374151; }
.rp-content { margin-top:16px; }
.rp-loading { text-align:center;padding:40px;color:#9CA3AF;font-size:13px;display:flex;align-items:center;justify-content:center;gap:8px; }

/* Plans grid */
.rp-plans-grid { display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px; }
.rp-plan-card { background:#fff;border:1.5px solid #E5E7EB;border-radius:16px;padding:18px;transition:border-color .15s; }
.rp-plan-card:hover { border-color:#2D7A55; }
.rp-plan-inactive { opacity:.6; }
.rp-plan-card-top { display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px; }
.rp-plan-name { font-size:15px;font-weight:800;color:#1C3A2B; }
.rp-plan-freq { display:flex;align-items:center;gap:4px;font-size:11px;color:#9CA3AF;margin-top:3px; }
.rp-plan-price { font-size:18px;font-weight:800;color:#2D7A55;white-space:nowrap; }
.rp-plan-price-unit { font-size:11px;color:#9CA3AF;font-weight:500; }
.rp-plan-desc { font-size:12px;color:#6B7280;margin-bottom:10px;line-height:1.5; }
.rp-plan-tasks { margin-bottom:10px; }
.rp-plan-task { display:flex;align-items:center;gap:5px;font-size:12px;color:#374151;padding:2px 0; }
.rp-plan-task-more { color:#9CA3AF; }
.rp-plan-card-footer { display:flex;align-items:center;justify-content:space-between;padding-top:12px;border-top:1px solid #F3F4F6; }
.rp-plan-status { font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em; }
.rp-plan-status-active { color:#2D7A55; }
.rp-plan-status-inactive { color:#9CA3AF; }
.rp-plan-actions { display:flex;gap:4px; }

/* Table */
.rp-table-wrap { background:#fff;border:1.5px solid #E5E7EB;border-radius:14px;overflow:hidden; }
.rp-table { width:100%;border-collapse:collapse; }
.rp-table thead { background:#F9FAFB; }
.rp-table th { padding:10px 14px;font-size:11px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:.06em;text-align:left; }
.rp-table td { padding:12px 14px;font-size:13px;color:#374151;border-top:1px solid #F3F4F6; }
.rp-row:hover { background:#F9FAFB; }
.rp-td-name { font-weight:600;color:#111; }
.rp-overdue { color:#DC2626;font-weight:600; }
.rp-row-actions { display:flex;gap:4px;opacity:0;transition:opacity .15s; }
.rp-row:hover .rp-row-actions { opacity:1; }

/* Badges */
.rp-badge { display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:12px;font-size:11px;font-weight:700; }
.rp-badge--active    { background:#DCFCE7;color:#166534; }
.rp-badge--paused    { background:#FEF3C7;color:#92400E; }
.rp-badge--cancelled { background:#FEE2E2;color:#991B1B; }
.rp-badge--completed { background:#F3F4F6;color:#6B7280; }

/* Empty */
.rp-empty { text-align:center;padding:60px 20px;background:#fff;border:1.5px dashed #E5E7EB;border-radius:14px; }
.rp-empty-icon { margin-bottom:12px;opacity:.3; }
.rp-empty-title { font-size:17px;font-weight:700;color:#374151;margin-bottom:6px; }
.rp-empty-sub { font-size:13px;color:#9CA3AF; }

/* Buttons */
.rp-btn-primary { display:inline-flex;align-items:center;gap:6px;padding:9px 16px;background:#2D7A55;color:#fff;border:none;border-radius:9px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;transition:background .15s; }
.rp-btn-primary:hover { background:#256645; }
.rp-btn-ghost { display:inline-flex;align-items:center;gap:6px;padding:9px 14px;background:#fff;color:#374151;border:1.5px solid #E5E7EB;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;transition:border-color .15s; }
.rp-btn-ghost:hover { border-color:#9CA3AF; }
.rp-btn-sm { display:inline-flex;align-items:center;gap:4px;padding:5px 10px;background:#F0FAF4;color:#2D7A55;border:1.5px solid #A7D7BC;border-radius:7px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit; }
.rp-action-btn { width:28px;height:28px;border:1.5px solid #E5E7EB;background:#fff;border-radius:7px;cursor:pointer;display:flex;align-items:center;justify-content:center; }
.rp-action-btn:hover { border-color:#9CA3AF; }

/* Modal */
.rp-overlay { position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9990;display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;overflow-y:auto; }
.rp-modal { background:#fff;border-radius:18px;width:100%;box-shadow:0 24px 80px rgba(0,0,0,.3); }
.rp-builder-modal { max-width:580px; }
.rp-sub-modal { max-width:480px; }
.rp-modal-header { display:flex;align-items:center;justify-content:space-between;padding:20px 24px;border-bottom:1.5px solid #F3F4F6; }
.rp-modal-title { display:flex;align-items:center;gap:10px;font-size:16px;font-weight:800;color:#1C3A2B; }
.rp-modal-close { width:32px;height:32px;border:none;background:#F3F4F6;border-radius:8px;font-size:18px;cursor:pointer;color:#6B7280;display:flex;align-items:center;justify-content:center; }
.rp-modal-body { padding:24px; }
.rp-modal-footer { display:flex;align-items:center;justify-content:flex-end;gap:10px;padding-top:16px;border-top:1.5px solid #F3F4F6;margin-top:16px; }

/* Form elements */
.rp-field-group { margin-bottom:14px; }
.rp-label { display:block;font-size:11px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px; }
.rp-req { color:#EF4444; }
.rp-input { width:100%;padding:9px 12px;border:1.5px solid #E5E7EB;border-radius:9px;font-size:13px;font-family:inherit;color:#111;outline:none;transition:border-color .15s; }
.rp-input:focus { border-color:#2D7A55;box-shadow:0 0 0 3px rgba(45,122,85,.1); }
.rp-select { width:100%;padding:9px 12px;border:1.5px solid #E5E7EB;border-radius:9px;font-size:13px;font-family:inherit;color:#111;background:#fff;outline:none; }
.rp-textarea { width:100%;padding:9px 12px;border:1.5px solid #E5E7EB;border-radius:9px;font-size:13px;font-family:inherit;color:#111;outline:none;resize:vertical; }
.rp-row2 { display:grid;grid-template-columns:1fr 1fr;gap:12px; }
.rp-toggle-label { display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:#374151;cursor:pointer; }

/* Tasks */
.rp-task-row { display:grid;grid-template-columns:1fr 28px;gap:8px;align-items:center;margin-bottom:6px; }
.rp-task-remove { width:28px;height:28px;border:1.5px solid #E5E7EB;background:#fff;border-radius:7px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0; }
.rp-task-remove:hover { border-color:#EF4444; }
.rp-add-task-btn { display:flex;align-items:center;gap:6px;padding:7px 12px;background:transparent;border:1.5px dashed #D1D5DB;border-radius:9px;font-size:12px;font-weight:600;color:#2D7A55;cursor:pointer;font-family:inherit;width:100%;justify-content:center;margin-top:4px; }
.rp-add-task-btn:hover { border-color:#2D7A55;background:#F0FAF4; }

/* Visits */
.rp-visits-wrap { display:flex;flex-direction:column;gap:20px; }
.rp-visits-section {}
.rp-visits-section-title { display:flex;align-items:center;gap:6px;font-size:13px;font-weight:700;color:#374151;margin-bottom:10px;padding-bottom:6px;border-bottom:1.5px solid #E5E7EB; }
.rp-visit-row { display:grid;grid-template-columns:140px 1fr 160px 80px 80px;gap:12px;align-items:center;padding:12px;background:#fff;border:1.5px solid #E5E7EB;border-radius:10px;margin-bottom:6px; }
.rp-visit-overdue { border-color:#FCA5A5;background:#FFF5F5; }
.rp-visit-date { font-size:13px;font-weight:700;color:#1C3A2B; }
.rp-visit-client { font-size:14px;font-weight:600;color:#111; }
.rp-visit-plan { display:flex;align-items:center;gap:4px;font-size:12px;color:#6B7280; }
.rp-visit-price { font-size:13px;font-weight:600;color:#2D7A55; }
.rp-visit-actions { display:flex;justify-content:flex-end; }
.rp-overdue-badge { display:inline-block;background:#FEE2E2;color:#991B1B;font-size:9px;font-weight:700;padding:2px 6px;border-radius:8px;margin-left:5px;text-transform:uppercase;letter-spacing:.04em; }

/* Sub detail */
.rp-sub-detail-grid { display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;padding:14px;background:#F9FAFB;border-radius:10px; }
.rp-kv { font-size:13px;color:#374151;display:flex;flex-direction:column;gap:3px; }
.rp-kv span:first-child { font-size:10px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:.06em; }
.rp-sub-notes { padding:10px 12px;background:#FFFBEB;border:1.5px solid #FDE68A;border-radius:8px;font-size:13px;color:#92400E;display:flex;align-items:flex-start;gap:6px;margin-bottom:12px; }
.rp-sub-status-actions { margin-top:12px; }
.rp-sub-status-label { display:flex;align-items:center;gap:6px;font-size:11px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px; }
.rp-status-btn-active { border-color:#2D7A55;color:#2D7A55;background:#F0FAF4; }

@media(max-width:640px) {
  .rp-visit-row { grid-template-columns:1fr 1fr;grid-template-rows:auto auto;gap:6px; }
  .rp-sub-detail-grid { grid-template-columns:1fr; }
}
`;
  document.head.appendChild(style);
})();

console.log('[Groundwork] recurring_plans.js loaded v20260711p48');
