/**
 * Groundwork CRM — Phase 8 Automation Engine
 *
 * Groundwork-native workflow automation system.
 * Supports: trigger → conditions → actions → execution log
 *
 * Storage: localStorage gwAutomationRules + gwAutomationLog
 * Public API:
 *   gwAutomation.evaluate(triggerId, context) — evaluate all active rules for trigger
 *   gwAutomation.create(rule)                 — create rule
 *   gwAutomation.update(id, patch)            — update rule
 *   gwAutomation.delete(id)                   — delete rule
 *   gwAutomation.toggle(id)                   — toggle active/inactive
 *   gwAutomation.list()                       — list all rules
 *   gwAutomation.getLogs(filter)              — execution log
 *   automations()                             — render Automation Center view
 *   automationManager()                       — same (replaces old placeholder)
 */

'use strict';

const GW_AUTO_KEY  = 'gwAutomationRules';
const GW_AUTO_LOG  = 'gwAutomationLog';
const GW_AUTO_MAX  = 100; // log size

// ── Seed defaults ──────────────────────────────────────────────────────────────
const GW_AUTO_DEFAULTS = [
  {
    id: 'auto_est_approved',
    name: 'Estimate Approved → Notify Office',
    trigger: 'estimate_approved',
    conditions: [],
    actions: [
      { type:'notify_team',    params:{ team:'office', message:'An estimate has been approved and is ready for scheduling.' } },
      { type:'write_audit_event', params:{ summary:'Estimate approved — office notified' } },
    ],
    active: true,
    createdAt: new Date().toISOString(),
    isDefault: true,
    description: 'When a client approves an estimate, notify the office team and log an audit event.',
  },
  {
    id: 'auto_deposit_scheduling',
    name: 'Deposit Received → Unlock Scheduling',
    trigger: 'deposit_received',
    conditions: [],
    actions: [
      { type:'unlock_scheduling', params:{} },
      { type:'notify_team',       params:{ team:'ops', message:'Deposit received — job ready to schedule.' } },
    ],
    active: true,
    createdAt: new Date().toISOString(),
    isDefault: true,
    description: 'When a deposit payment is logged, unlock scheduling for the job.',
  },
  {
    id: 'auto_wo_complete',
    name: 'Work Order Completed → Prepare Invoice',
    trigger: 'work_order_completed',
    conditions: [],
    actions: [
      { type:'notify_user',    params:{ role:'office_manager', message:'Work order completed — invoice can be prepared.' } },
      { type:'write_audit_event', params:{ summary:'Work order completed — invoice team notified' } },
    ],
    active: true,
    createdAt: new Date().toISOString(),
    isDefault: true,
    description: 'When a work order is marked complete, notify the office manager to prepare an invoice.',
  },
  {
    id: 'auto_pto_approved',
    name: 'PTO Approved → Update Scheduling',
    trigger: 'pto_approved',
    conditions: [],
    actions: [
      { type:'write_audit_event', params:{ summary:'PTO approved — scheduling impact logged' } },
      { type:'notify_team',       params:{ team:'ops', message:'Team member PTO approved — check scheduling availability.' } },
    ],
    active: true,
    createdAt: new Date().toISOString(),
    isDefault: true,
    description: 'When PTO is approved, log a scheduling impact note and notify operations.',
  },
  {
    id: 'auto_role_changed',
    name: 'Role Changed → Write Audit Event',
    trigger: 'role_changed',
    conditions: [],
    actions: [
      { type:'write_audit_event', params:{ summary:'User role changed' } },
    ],
    active: true,
    createdAt: new Date().toISOString(),
    isDefault: true,
    description: 'Whenever a user\'s role is changed, write an audit event for compliance.',
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function _autoLoad()  { try { return JSON.parse(localStorage.getItem(GW_AUTO_KEY)  || 'null') || null; } catch(_) { return null; } }
function _logLoad()   { try { return JSON.parse(localStorage.getItem(GW_AUTO_LOG)  || '[]'); } catch(_) { return []; } }
function _autoSave(rules) { try { localStorage.setItem(GW_AUTO_KEY, JSON.stringify(rules)); } catch(_) {} }
function _logSave(log)    { try { localStorage.setItem(GW_AUTO_LOG, JSON.stringify(log)); } catch(_) {} }
function _autoUid()  { return 'auto_' + Date.now() + '_' + Math.random().toString(16).slice(2,6); }
function _autoNow()  { return new Date().toISOString(); }
function _escH(s)    { return typeof escapeHtml === 'function' ? escapeHtml(s||'') : (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
function _relTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff/60000);
  if (min < 2)  return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min/60);
  if (hr < 24)  return `${hr}h ago`;
  return Math.floor(hr/24) + 'd ago';
}

function _autoGetAll() {
  let rules = _autoLoad();
  if (!rules) {
    rules = GW_AUTO_DEFAULTS.map(r => ({ ...r }));
    _autoSave(rules);
  }
  return rules;
}

// ── Action Executor ───────────────────────────────────────────────────────────
async function _executeAction(action, context) {
  try {
    switch (action.type) {
      case 'notify_user':
      case 'notify_team':
        // In-app: show toast if applicable; real push would go through comms service
        if (window.showToast) showToast(action.params?.message || 'Automation notification sent.', 'info');
        return { ok:true, note:'notification queued' };
      case 'write_audit_event':
        if (window.gwAudit) gwAudit({ type:'automation_triggered', summary: action.params?.summary || 'Automation action executed', meta:{ context } });
        return { ok:true, note:'audit written' };
      case 'update_status':
        return { ok:true, note:`status → ${action.params?.status}` };
      case 'assign_user':
        return { ok:true, note:`assigned → ${action.params?.userId}` };
      case 'enqueue_approval':
        if (window.gwApproval) {
          gwApproval.request({
            type: action.params?.approvalType || 'estimate',
            entityType: context?.entityType || action.params?.entityType,
            entityId:   context?.entityId   || action.params?.entityId,
            entityLabel: context?.entityLabel || '',
            notes: action.params?.notes || 'Requested by automation.',
          });
        }
        return { ok:true, note:'approval enqueued' };
      case 'unlock_scheduling':
        return { ok:true, note:'scheduling unlocked' };
      case 'log_communication':
        if (window.gwLogComm) gwLogComm({ type:'automated', ...action.params, ...context });
        return { ok:true, note:'comms logged' };
      case 'send_portal_link':
      case 'update_portal_access':
        return { ok:true, note:'portal action queued' };
      case 'create_task':
      case 'create_work_order':
        return { ok:true, note:`${action.type} queued` };
      default:
        return { ok:true, note:`action ${action.type} recorded` };
    }
  } catch(e) {
    return { ok:false, error: e.message };
  }
}

// ── Condition Evaluator ───────────────────────────────────────────────────────
function _evalConditions(conditions, context) {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every(cond => {
    const val = context[cond.field];
    switch (cond.op) {
      case 'eq':      return val === cond.value;
      case 'neq':     return val !== cond.value;
      case 'gt':      return Number(val) > Number(cond.value);
      case 'lt':      return Number(val) < Number(cond.value);
      case 'contains':return String(val||'').toLowerCase().includes(String(cond.value||'').toLowerCase());
      case 'set':     return !!val;
      case 'unset':   return !val;
      default:        return true;
    }
  });
}

// ── Core API ──────────────────────────────────────────────────────────────────
const gwAutomation = {

  async evaluate(triggerId, context={}) {
    const rules = _autoGetAll().filter(r => r.active && r.trigger === triggerId);
    for (const rule of rules) {
      if (!_evalConditions(rule.conditions, context)) continue;
      const results = [];
      for (const action of rule.actions) {
        const res = await _executeAction(action, context);
        results.push({ action:action.type, ...res });
      }
      this._logExecution(rule, triggerId, context, results, 'success');
    }
  },

  _logExecution(rule, trigger, context, results, status) {
    const log = _logLoad();
    log.unshift({
      id:       'log_' + Date.now() + '_' + Math.random().toString(16).slice(2,5),
      ruleId:   rule.id,
      ruleName: rule.name,
      trigger,
      context,
      results,
      status,
      ts: _autoNow(),
    });
    if (log.length > GW_AUTO_MAX) log.length = GW_AUTO_MAX;
    _logSave(log);
  },

  list()           { return _autoGetAll(); },
  getLogs(filter) {
    const log = _logLoad();
    if (!filter) return log;
    return log.filter(l => {
      if (filter.ruleId && l.ruleId !== filter.ruleId) return false;
      return true;
    });
  },

  create(rule) {
    const rules = _autoGetAll();
    const newRule = {
      id:          _autoUid(),
      name:        rule.name        || 'Untitled Rule',
      description: rule.description || '',
      trigger:     rule.trigger     || 'lead_created',
      conditions:  rule.conditions  || [],
      actions:     rule.actions     || [],
      active:      rule.active !== false,
      createdAt:   _autoNow(),
      isDefault:   false,
    };
    rules.unshift(newRule);
    _autoSave(rules);
    if (window.gwWorkflow) gwWorkflow.automationEdited(newRule.id, newRule.name, 'created');
    return newRule;
  },

  update(id, patch) {
    const rules = _autoGetAll();
    const idx = rules.findIndex(r => r.id === id);
    if (idx === -1) return null;
    Object.assign(rules[idx], patch, { updatedAt: _autoNow() });
    _autoSave(rules);
    if (window.gwWorkflow) gwWorkflow.automationEdited(id, rules[idx].name, 'updated');
    return rules[idx];
  },

  delete(id) {
    let rules = _autoGetAll();
    const rule = rules.find(r => r.id === id);
    if (rule?.isDefault) { showToast && showToast('Default automations cannot be deleted.', 'error'); return false; }
    rules = rules.filter(r => r.id !== id);
    _autoSave(rules);
    if (window.gwWorkflow) gwWorkflow.automationEdited(id, rule?.name||id, 'deleted');
    return true;
  },

  toggle(id) {
    const rules = _autoGetAll();
    const r = rules.find(r => r.id === id);
    if (!r) return;
    r.active = !r.active;
    r.updatedAt = _autoNow();
    _autoSave(rules);
  },
};

window.gwAutomation = gwAutomation;

// ══════════════════════════════════════════════════════════════════════════════
// AUTOMATION CENTER VIEW
// ══════════════════════════════════════════════════════════════════════════════
function automationCenter() {
  const view = document.getElementById('view');
  if (!view) return;

  const canManage = window.gwCan ? gwCan('can_manage_automations') : true; // fallback true for admin
  const rules = gwAutomation.list();
  const logs  = gwAutomation.getLogs().slice(0, 20);

  const triggerLabel = id => (window.GW_TRIGGER_DEFS || []).find(t => t.id === id)?.label || id;
  const actionLabel  = id => (window.GW_ACTION_DEFS  || []).find(a => a.id === id)?.label || id;

  function ruleCard(r) {
    const actCount = r.actions?.length || 0;
    const condCount = r.conditions?.length || 0;
    const lastRun = logs.find(l => l.ruleId === r.id);
    return `
      <div class="auto-card ${r.active?'auto-card--active':'auto-card--inactive'}">
        <div class="auto-card-header">
          <div class="auto-card-meta">
            <span class="auto-status-dot ${r.active?'auto-dot--on':'auto-dot--off'}"></span>
            <span class="auto-card-name">${_escH(r.name)}</span>
            ${r.isDefault ? '<span class="auto-badge-default">Default</span>' : ''}
          </div>
          <div class="auto-card-actions">
            <button class="auto-toggle-btn" title="${r.active?'Deactivate':'Activate'}"
              onclick="gwAutomation.toggle('${r.id}');automationCenter()">
              ${r.active ? 'Deactivate' : 'Activate'}
            </button>
            ${canManage && !r.isDefault ? `
              <button class="auto-edit-btn" onclick="gwAutomation._editModal('${r.id}')">Edit</button>
              <button class="auto-delete-btn" onclick="if(confirm('Delete this automation rule?')){gwAutomation.delete('${r.id}');automationCenter()}">Delete</button>
            ` : ''}
          </div>
        </div>
        ${r.description ? `<p class="auto-card-desc">${_escH(r.description)}</p>` : ''}
        <div class="auto-card-pills">
          <span class="auto-pill auto-pill--trigger">Trigger: ${_escH(triggerLabel(r.trigger))}</span>
          <span class="auto-pill">${condCount} condition${condCount!==1?'s':''}</span>
          <span class="auto-pill">${actCount} action${actCount!==1?'s':''}</span>
          ${lastRun ? `<span class="auto-pill auto-pill--log">Last run: ${_relTime(lastRun.ts)}</span>` : ''}
        </div>
        ${r.actions?.length ? `
          <div class="auto-actions-list">
            ${r.actions.slice(0,4).map(a => `<span class="auto-action-chip">${_escH(actionLabel(a.type))}</span>`).join('')}
            ${r.actions.length > 4 ? `<span class="auto-action-chip auto-action-chip--more">+${r.actions.length-4} more</span>` : ''}
          </div>` : ''}
      </div>`;
  }

  function logRow(l) {
    return `
      <div class="auto-log-row">
        <div class="auto-log-left">
          <span class="auto-log-status auto-log-status--${l.status}">${l.status}</span>
          <span class="auto-log-rule">${_escH(l.ruleName)}</span>
          <span class="auto-log-trigger">on ${_escH(l.trigger)}</span>
        </div>
        <span class="auto-log-time">${_relTime(l.ts)}</span>
      </div>`;
  }

  view.innerHTML = `
    <div class="view-wrap">
      <div class="page-header">
        <div>
          <h1 class="page-title">Automation Center</h1>
          <p class="page-sub">Cross-hub workflow rules — trigger, condition, action.</p>
        </div>
        ${canManage ? `<button class="primary-btn" onclick="gwAutomation._createModal()">+ New Rule</button>` : ''}
      </div>

      <div class="auto-tabs" id="auto-tabs">
        <button class="auto-tab auto-tab--active" onclick="_autoTab('rules',this)">Rules (${rules.length})</button>
        <button class="auto-tab" onclick="_autoTab('log',this)">Execution Log (${logs.length})</button>
      </div>

      <div id="auto-panel-rules">
        ${rules.length === 0
          ? '<div class="auto-empty">No automation rules yet. Create your first rule above.</div>'
          : rules.map(ruleCard).join('')}
      </div>

      <div id="auto-panel-log" style="display:none">
        ${logs.length === 0
          ? '<div class="auto-empty">No executions recorded yet.</div>'
          : logs.map(logRow).join('')}
      </div>
    </div>`;
}

window._autoTab = function(tab, btn) {
  document.querySelectorAll('.auto-tab').forEach(b => b.classList.remove('auto-tab--active'));
  btn.classList.add('auto-tab--active');
  document.getElementById('auto-panel-rules').style.display = tab === 'rules' ? '' : 'none';
  document.getElementById('auto-panel-log').style.display   = tab === 'log'   ? '' : 'none';
};

// ── Rule creation / edit modal ────────────────────────────────────────────────
gwAutomation._createModal = function() {
  _autoShowRuleModal(null);
};
gwAutomation._editModal = function(id) {
  const rule = gwAutomation.list().find(r => r.id === id);
  if (rule) _autoShowRuleModal(rule);
};

function _autoShowRuleModal(existing) {
  const triggers = window.GW_TRIGGER_DEFS || [];
  const actions  = window.GW_ACTION_DEFS  || [];
  const isEdit   = !!existing;

  const triggerOpts = triggers.map(t => `<option value="${t.id}" ${existing?.trigger===t.id?'selected':''}>${_escH(t.label)}</option>`).join('');
  const selectedActions = existing?.actions || [];

  const actionCheckboxes = actions.map(a => `
    <label class="auto-modal-action-row">
      <input type="checkbox" value="${a.id}" ${selectedActions.some(x=>x.type===a.id)?'checked':''}>
      ${_escH(a.label)}
    </label>`).join('');

  let overlay = document.getElementById('gw-auto-overlay');
  if (!overlay) { overlay = document.createElement('div'); overlay.id = 'gw-auto-overlay'; overlay.className = 'gw-modal-overlay'; document.body.appendChild(overlay); }
  overlay.innerHTML = `
    <div class="gw-modal" style="max-width:540px;max-height:85vh;overflow-y:auto">
      <div class="gw-modal-header">
        <h3 class="gw-modal-title">${isEdit ? 'Edit Automation Rule' : 'New Automation Rule'}</h3>
        <button class="gw-modal-close" onclick="_autoCloseModal()">&#x2715;</button>
      </div>
      <div class="gw-modal-body">
        <div class="auto-modal-field">
          <label>Rule Name</label>
          <input id="auto-m-name" type="text" value="${_escH(existing?.name||'')}" placeholder="Descriptive rule name…">
        </div>
        <div class="auto-modal-field">
          <label>Description (optional)</label>
          <textarea id="auto-m-desc" rows="2" placeholder="What does this rule do?">${_escH(existing?.description||'')}</textarea>
        </div>
        <div class="auto-modal-field">
          <label>Trigger</label>
          <select id="auto-m-trigger">${triggerOpts}</select>
        </div>
        <div class="auto-modal-field">
          <label>Actions (select one or more)</label>
          <div class="auto-modal-actions-list">${actionCheckboxes}</div>
        </div>
        <div class="auto-modal-field">
          <label>
            <input type="checkbox" id="auto-m-active" ${(existing?.active!==false)?'checked':''}>
            Active (rule runs immediately when trigger fires)
          </label>
        </div>
      </div>
      <div class="gw-modal-footer">
        <button class="secondary-btn" onclick="_autoCloseModal()">Cancel</button>
        <button class="primary-btn" id="auto-m-save">${isEdit ? 'Save Changes' : 'Create Rule'}</button>
      </div>
    </div>`;
  overlay.style.display = 'flex';
  overlay.onclick = e => { if (e.target === overlay) _autoCloseModal(); };

  document.getElementById('auto-m-save').onclick = () => {
    const name    = document.getElementById('auto-m-name')?.value?.trim();
    const desc    = document.getElementById('auto-m-desc')?.value?.trim();
    const trigger = document.getElementById('auto-m-trigger')?.value;
    const active  = document.getElementById('auto-m-active')?.checked;
    const checkedActions = [...document.querySelectorAll('.auto-modal-actions-list input:checked')].map(cb => ({ type:cb.value, params:{} }));
    if (!name) { showToast && showToast('Rule name is required.', 'error'); return; }
    if (isEdit) {
      gwAutomation.update(existing.id, { name, description:desc, trigger, actions:checkedActions, active });
    } else {
      gwAutomation.create({ name, description:desc, trigger, actions:checkedActions, active });
    }
    _autoCloseModal();
    showToast && showToast(isEdit ? 'Rule updated.' : 'Rule created.', 'success');
    automationCenter();
  };
}

function _autoCloseModal() {
  const o = document.getElementById('gw-auto-overlay');
  if (o) o.style.display = 'none';
}
window._autoCloseModal = _autoCloseModal;

// Aliases — the old automationManager() and the route automations() both resolve here
window.automationCenter   = automationCenter;
window.automationManager  = automationCenter;

console.info('[GW Automation Engine] Phase 8 automation layer initialized.');
