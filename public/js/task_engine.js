// ══════════════════════════════════════════════════════════════════════════════
// task_engine.js — Unified Task / To-Do Engine  (Phase 10)
// ══════════════════════════════════════════════════════════════════════════════
// Single source of truth for task types, statuses, record types, and all
// task CRUD helpers. Loaded before app_premium.js so all views can call
// window.gwTask.* without worrying about load order.
// ══════════════════════════════════════════════════════════════════════════════

(function() {
'use strict';

// ── CONSTANTS ─────────────────────────────────────────────────────────────────

const TASK_TYPES = [
  { id: 'follow_up',       label: 'Follow-Up'        },
  { id: 'call',            label: 'Call'              },
  { id: 'email',           label: 'Email'             },
  { id: 'meeting',         label: 'Meeting'           },
  { id: 'site_visit',      label: 'Site Visit'        },
  { id: 'estimate_task',   label: 'Estimate Task'     },
  { id: 'job_task',        label: 'Job Task'          },
  { id: 'payment_reminder',label: 'Payment Reminder'  },
  { id: 'internal',        label: 'Internal Task'     },
  { id: 'ops_task',        label: 'Ops Task'          },
];

// Calendar push candidates — these types are most likely to become calendar events
const CALENDAR_PUSH_TYPES = new Set(['meeting', 'site_visit', 'call']);

const TASK_STATUSES = [
  { id: 'open',      label: 'Open'      },
  { id: 'completed', label: 'Completed' },
  { id: 'archived',  label: 'Archived'  },
];

const LINKABLE_RECORD_TYPES = [
  { id: 'lead',       label: 'Lead / Opportunity' },
  { id: 'client',     label: 'Client'             },
  { id: 'work_order', label: 'Work Order'         },
  { id: 'estimate',   label: 'Estimate'           },
  { id: 'invoice',    label: 'Invoice'            },
  { id: 'internal',   label: 'Internal'           },
];

const CALENDAR_SYNC_STATES = [
  { id: 'none',    label: 'CRM Only'         },
  { id: 'pending', label: 'Pending Sync'     },
  { id: 'synced',  label: 'Synced'           },
  { id: 'error',   label: 'Sync Error'       },
];

const PRIORITY_LABELS = { low: 'Low', normal: 'Normal', high: 'High' };

// ── IN-MEMORY CACHE ───────────────────────────────────────────────────────────
// state.tasks is managed here. Views read from it; mutations write through to D1.
// Scoped per-screen (loaded on demand, not at bootstrap).

function _getCache() {
  if (typeof window !== 'undefined' && window._avalonState) {
    if (!window._avalonState.tasks) window._avalonState.tasks = [];
    return window._avalonState.tasks;
  }
  // Fallback: use the app's shared state object
  if (typeof state !== 'undefined') {
    if (!state.tasks) state.tasks = [];
    return state.tasks;
  }
  return [];
}

function _setCache(tasks) {
  if (typeof window !== 'undefined' && window._avalonState) {
    window._avalonState.tasks = tasks;
  }
  if (typeof state !== 'undefined') {
    state.tasks = tasks;
  }
}

function _mergeIntoCache(incoming) {
  const cache = _getCache();
  const map = new Map(cache.map(t => [t.id, t]));
  incoming.forEach(t => map.set(t.id, t));
  const merged = Array.from(map.values());
  _setCache(merged);
  return merged;
}

function _patchCache(id, patch) {
  const cache = _getCache();
  const idx = cache.findIndex(t => t.id === id);
  if (idx >= 0) {
    cache[idx] = { ...cache[idx], ...patch };
    _setCache(cache);
  }
}

function _removeFromCache(id) {
  _setCache(_getCache().filter(t => t.id !== id));
}

// ── DATE HELPERS ──────────────────────────────────────────────────────────────

function _todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function _taskDueState(task) {
  // Returns: 'overdue' | 'due_today' | 'upcoming' | 'no_date'
  if (!task.due_date) return 'no_date';
  const today = _todayISO();
  if (task.due_date < today)  return 'overdue';
  if (task.due_date === today) return 'due_today';
  return 'upcoming';
}

function _prettyDate(iso) {
  if (!iso) return '—';
  if (typeof window.prettyDate === 'function') return window.prettyDate(iso.slice(0, 10));
  try {
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return iso; }
}

function _taskTypeLabel(typeId) {
  const t = TASK_TYPES.find(x => x.id === typeId);
  return t ? t.label : typeId || 'Task';
}

function _recordTypeLabel(typeId) {
  const t = LINKABLE_RECORD_TYPES.find(x => x.id === typeId);
  return t ? t.label : typeId || '';
}

// ── API HELPERS ───────────────────────────────────────────────────────────────

async function _apiFetch(method, path, body) {
  const opts = {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || 'API error');
  return j.data;
}

// ── PUBLIC API ────────────────────────────────────────────────────────────────

/**
 * Load tasks for the current user's Today view.
 * Fetches open tasks assigned to the current rep + completed today.
 * Merges result into cache. Returns array.
 */
async function gwTasksLoadToday() {
  const rep = typeof window.getCurrentRep === 'function' ? window.getCurrentRep() : null;
  if (!rep) return [];
  try {
    // Only fetch open tasks — completed tasks are immediately archived server-side
    // so they never reappear on reload. Never fetch status=completed here.
    const open = await _apiFetch('GET',
      `/api/tasks?assignedUserId=${encodeURIComponent(rep.id)}&status=open`
    );
    const all = open || [];
    // Replace cache with fresh open-only list (evicts any stale completed/archived entries)
    _setCache(all);
    return all;
  } catch(e) {
    console.warn('[TaskEngine] gwTasksLoadToday failed:', e.message);
    return _getCache().filter(t => t.assigned_user_id === rep.id && t.status === 'open');
  }
}

/**
 * Load tasks for a specific record (e.g. a lead page).
 * Always fetches open + completed so the full panel can render.
 */
async function gwTasksLoadForRecord(recordType, recordId) {
  if (!recordType || !recordId) return [];
  try {
    const open = await _apiFetch('GET',
      `/api/tasks?recordType=${encodeURIComponent(recordType)}&recordId=${encodeURIComponent(recordId)}&status=open`
    );
    const completed = await _apiFetch('GET',
      `/api/tasks?recordType=${encodeURIComponent(recordType)}&recordId=${encodeURIComponent(recordId)}&status=completed`
    );
    const all = [...(open || []), ...(completed || [])];
    _mergeIntoCache(all);
    return all;
  } catch(e) {
    console.warn('[TaskEngine] gwTasksLoadForRecord failed:', e.message);
    return _getCache().filter(t => t.linked_record_type === recordType && t.linked_record_id === recordId);
  }
}

/**
 * Load team task summary (admin/manager only).
 * Returns array of { assigned_user_id, assigned_user_label, open_count, overdue_count, due_today_count, completed_today_count }
 */
async function gwTasksLoadTeamSummary() {
  try {
    return await _apiFetch('GET', '/api/tasks/team-summary');
  } catch(e) {
    console.warn('[TaskEngine] gwTasksLoadTeamSummary failed:', e.message);
    return [];
  }
}

/**
 * Create a task. Returns the created task object.
 */
async function gwTaskCreate(data) {
  const task = await _apiFetch('POST', '/api/tasks', data);
  _mergeIntoCache([task]);
  return task;
}

/**
 * Update a task. Returns updated task.
 */
async function gwTaskUpdate(id, patch) {
  const task = await _apiFetch('PUT', `/api/tasks/${id}`, patch);
  _patchCache(id, task);
  return task;
}

/**
 * Mark a task complete. Returns { id, status, completed_at }.
 */
async function gwTaskComplete(id) {
  const result = await _apiFetch('PUT', `/api/tasks/${id}/complete`, {});
  // Server now archives on complete so task never reappears on reload
  _patchCache(id, { status: 'archived', completed_at: result.completed_at });
  return result;
}

/**
 * Archive a task. Returns { id, status, archived_at }.
 */
async function gwTaskArchive(id) {
  const result = await _apiFetch('PUT', `/api/tasks/${id}/archive`, {});
  _patchCache(id, { status: 'archived', archived_at: result.archived_at });
  return result;
}

/**
 * Calendar push stub — foundation only.
 * Sets calendarSyncState='pending' in DB; actual push is future work.
 */
async function gwTaskCalendarPush(id) {
  try {
    await gwTaskUpdate(id, { calendarSyncState: 'pending' });
    if (typeof window.showToast === 'function') {
      window.showToast('Calendar sync queued — coming soon', 'info');
    }
  } catch(e) {
    console.warn('[TaskEngine] gwTaskCalendarPush failed:', e.message);
  }
}

// ── QUICK-ACCESS FILTERS (on the in-memory cache) ─────────────────────────────

function gwTasksForRecord(recordType, recordId) {
  return _getCache().filter(t =>
    t.linked_record_type === recordType && t.linked_record_id === recordId
  );
}

function gwTasksForUser(userId) {
  return _getCache().filter(t => t.assigned_user_id === userId);
}

function gwTasksOpenForUser(userId) {
  return _getCache().filter(t => t.assigned_user_id === userId && t.status === 'open');
}

function gwTasksDueTodayForUser(userId) {
  const today = _todayISO();
  return _getCache().filter(t =>
    t.assigned_user_id === userId && t.status === 'open' && t.due_date === today
  );
}

function gwTasksOverdueForUser(userId) {
  const today = _todayISO();
  return _getCache().filter(t =>
    t.assigned_user_id === userId && t.status === 'open' &&
    t.due_date && t.due_date < today
  );
}

function gwTasksCompletedTodayForUser(userId) {
  const today = _todayISO();
  return _getCache().filter(t =>
    t.assigned_user_id === userId && t.status === 'completed' &&
    t.completed_at && t.completed_at.slice(0, 10) === today
  );
}

// ── TASK MODAL ────────────────────────────────────────────────────────────────
// Shared create/edit modal used from both the record page and Today.

let _modalCallback = null;

/**
 * Open the task create/edit modal.
 * opts: { task (existing task for edit), defaults: { linkedRecordType, linkedRecordId, linkedRecordLabel, assignedUserId, assignedUserLabel, dueDate } }
 * onSave(task) — called with created/updated task
 */
function gwTaskModal(opts, onSave) {
  opts = opts || {};
  const task = opts.task || null;
  const def  = opts.defaults || {};
  _modalCallback = onSave || null;

  const isEdit = !!task;
  const title  = isEdit ? 'Edit Task' : 'New Task';

  const rep = typeof window.getCurrentRep === 'function' ? window.getCurrentRep() : null;
  const reps = window.REPS || [];

  const taskTypeOptions = TASK_TYPES.map(t =>
    `<option value="${t.id}" ${(task?.task_type || def.taskType || 'follow_up') === t.id ? 'selected' : ''}>${_esc(t.label)}</option>`
  ).join('');

  const recordTypeOptions = `<option value="">— none —</option>` + LINKABLE_RECORD_TYPES.map(r =>
    `<option value="${r.id}" ${(task?.linked_record_type || def.linkedRecordType || '') === r.id ? 'selected' : ''}>${_esc(r.label)}</option>`
  ).join('');

  const repOptions = reps.map(r =>
    `<option value="${r.id}" ${(task?.assigned_user_id || def.assignedUserId || rep?.id || '') === r.id ? 'selected' : ''}>${_esc(r.name)}</option>`
  ).join('');

  const calType = task?.task_type || def.taskType || 'follow_up';
  const showCal = CALENDAR_PUSH_TYPES.has(calType);
  const calChecked = task?.calendar_sync_state && task.calendar_sync_state !== 'none' ? 'checked' : '';

  // Remove any existing modal
  const existing = document.getElementById('gwTaskModalOverlay');
  if (existing) existing.remove();

  const el = document.createElement('div');
  el.id = 'gwTaskModalOverlay';
  el.className = 'gw-task-modal-overlay';
  el.innerHTML = `
    <div class="gw-task-modal" role="dialog" aria-modal="true" aria-label="${_esc(title)}">
      <div class="gw-task-modal-head">
        <h3 class="gw-task-modal-title">${_esc(title)}</h3>
        <button class="gw-task-modal-close" onclick="window._gwTaskModalClose()" aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="gw-task-modal-body">
        <div class="gw-task-field">
          <label class="gw-task-label" for="gtmTitle">Task Title</label>
          <input id="gtmTitle" class="gw-task-input" type="text" placeholder="What needs to happen?" value="${_esc(task?.title || '')}" autocomplete="off">
        </div>
        <div class="gw-task-row-2">
          <div class="gw-task-field">
            <label class="gw-task-label" for="gtmType">Type</label>
            <select id="gtmType" class="gw-task-select" onchange="window._gwTaskModalTypeChange(this.value)">${taskTypeOptions}</select>
          </div>
          <div class="gw-task-field">
            <label class="gw-task-label" for="gtmDue">Due Date</label>
            <input id="gtmDue" class="gw-task-input" type="date" value="${_esc(task?.due_date || def.dueDate || '')}">
          </div>
        </div>
        <div class="gw-task-row-2">
          <div class="gw-task-field">
            <label class="gw-task-label" for="gtmPriority">Priority</label>
            <select id="gtmPriority" class="gw-task-select">
              <option value="low"    ${(task?.priority || 'normal') === 'low'    ? 'selected' : ''}>Low</option>
              <option value="normal" ${(task?.priority || 'normal') === 'normal' ? 'selected' : ''}>Normal</option>
              <option value="high"   ${(task?.priority || 'normal') === 'high'   ? 'selected' : ''}>High</option>
            </select>
          </div>
          <div class="gw-task-field">
            <label class="gw-task-label" for="gtmAssign">Assigned To</label>
            <select id="gtmAssign" class="gw-task-select">${repOptions}</select>
          </div>
        </div>
        <div class="gw-task-row-2">
          <div class="gw-task-field">
            <label class="gw-task-label" for="gtmRecordType">Linked Record Type</label>
            <select id="gtmRecordType" class="gw-task-select">${recordTypeOptions}</select>
          </div>
          <div class="gw-task-field">
            <label class="gw-task-label" for="gtmRecordLabel">Linked Record</label>
            <input id="gtmRecordLabel" class="gw-task-input" type="text" placeholder="e.g. Smith Backyard Project" value="${_esc(task?.linked_record_label || def.linkedRecordLabel || '')}">
            <input id="gtmRecordId" type="hidden" value="${_esc(task?.linked_record_id || def.linkedRecordId || '')}">
          </div>
        </div>
        <div class="gw-task-field">
          <label class="gw-task-label" for="gtmNotes">Notes</label>
          <textarea id="gtmNotes" class="gw-task-input gw-task-textarea" rows="3" placeholder="What this is about, context, follow-up details…">${_esc(task?.description || '')}</textarea>
        </div>
        <div id="gtmCalRow" class="gw-task-cal-row" style="${showCal ? '' : 'display:none'}">
          <label class="gw-task-toggle-row">
            <input id="gtmCalPush" type="checkbox" ${calChecked}>
            <span>Push to Google Calendar</span>
            <span class="gw-task-cal-hint">Meetings, site visits, and calls can be added to your calendar.</span>
          </label>
        </div>
      </div>
      <div class="gw-task-modal-foot">
        <button class="gw-task-btn gw-task-btn--ghost" onclick="window._gwTaskModalClose()">Cancel</button>
        <button class="gw-task-btn gw-task-btn--primary" onclick="window._gwTaskModalSave('${task?.id || ''}')">
          ${isEdit ? 'Save Changes' : 'Create Task'}
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(el);
  el.addEventListener('click', e => { if (e.target === el) window._gwTaskModalClose(); });
  setTimeout(() => document.getElementById('gtmTitle')?.focus(), 60);
}

window._gwTaskModalClose = function() {
  const el = document.getElementById('gwTaskModalOverlay');
  if (el) { el.classList.add('closing'); setTimeout(() => el.remove(), 180); }
};

window._gwTaskModalTypeChange = function(typeId) {
  const calRow = document.getElementById('gtmCalRow');
  if (calRow) calRow.style.display = CALENDAR_PUSH_TYPES.has(typeId) ? '' : 'none';
};

window._gwTaskModalSave = async function(existingId) {
  const titleEl = document.getElementById('gtmTitle');
  const title = (titleEl?.value || '').trim();
  if (!title) { titleEl?.classList.add('gw-task-input--error'); titleEl?.focus(); return; }

  const assignEl  = document.getElementById('gtmAssign');
  const assignId  = assignEl?.value || '';
  const assignName = assignEl?.options[assignEl.selectedIndex]?.text || '';

  const calPush = document.getElementById('gtmCalPush')?.checked;
  const calState = calPush ? 'pending' : 'none';

  const payload = {
    title,
    description:       (document.getElementById('gtmNotes')?.value || '').trim(),
    taskType:          document.getElementById('gtmType')?.value    || 'follow_up',
    dueDate:           document.getElementById('gtmDue')?.value     || null,
    priority:          document.getElementById('gtmPriority')?.value || 'normal',
    assignedUserId:    assignId,
    assignedUserLabel: assignName,
    linkedRecordType:  document.getElementById('gtmRecordType')?.value || null,
    linkedRecordId:    document.getElementById('gtmRecordId')?.value   || null,
    linkedRecordLabel: document.getElementById('gtmRecordLabel')?.value || '',
    calendarSyncState: calState,
  };
  if (!payload.linkedRecordType) { payload.linkedRecordType = null; payload.linkedRecordId = null; }

  const saveBtn = document.querySelector('.gw-task-btn--primary');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

  try {
    let saved;
    if (existingId) {
      saved = await gwTaskUpdate(existingId, payload);
    } else {
      saved = await gwTaskCreate(payload);
    }
    if (typeof window.showToast === 'function') {
      window.showToast(existingId ? 'Task updated' : 'Task created', 'success');
    }
    window._gwTaskModalClose();
    if (_modalCallback) _modalCallback(saved);
  } catch(e) {
    if (typeof window.showToast === 'function') window.showToast('Save failed: ' + e.message, 'error');
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = existingId ? 'Save Changes' : 'Create Task'; }
  }
};

// ── TASK ROW RENDERER ─────────────────────────────────────────────────────────
// Renders a single task as a row for Today and record pages.
// opts: { showRecord, showCompleteBtn, showEditBtn, onComplete, onEdit, onArchive }

function gwRenderTaskRow(task, opts) {
  opts = opts || {};
  const dueState  = _taskDueState(task);
  const isOvd     = dueState === 'overdue';
  const isDueToday = dueState === 'due_today';
  const isDone    = task.status === 'completed';
  const isArchived = task.status === 'archived';

  const typeLabel = _taskTypeLabel(task.task_type);
  const dateLabel = task.due_date ? _prettyDate(task.due_date) : '';

  const dueChipClass = isOvd ? 'gw-task-due-chip--overdue'
    : isDueToday ? 'gw-task-due-chip--today'
    : 'gw-task-due-chip--upcoming';

  const hasRecordNav = task.linked_record_type && task.linked_record_id && ['lead','client','work_order','estimate','invoice'].includes(task.linked_record_type);
  const recordChip = (opts.showRecord !== false) && task.linked_record_label
    ? (hasRecordNav
        ? `<span class="gw-task-record-chip" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:2px" title="Open ${_esc(task.linked_record_label)}"
             onclick="window._gwTaskOpenRecord(event,'${task.linked_record_type}','${task.linked_record_id}')">${_esc(task.linked_record_label)} →</span>`
        : `<span class="gw-task-record-chip">${_esc(task.linked_record_label)}</span>`)
    : '';

  const dueChip = dateLabel
    ? `<span class="gw-task-due-chip ${dueChipClass}">${_esc(dateLabel)}</span>`
    : '';

  const typeChip = `<span class="gw-task-type-chip">${_esc(typeLabel)}</span>`;

  const prioClass = task.priority === 'high' ? 'gw-task-prio--high'
    : task.priority === 'low' ? 'gw-task-prio--low'
    : '';

  // AI follow-up: for open follow-up/email tasks linked to a lead, offer the
  // transcript → AI-drafted email → Gmail send → auto-complete flow.
  const aiBtn = (!isDone && !isArchived
      && task.linked_record_id
      && (task.linked_record_type === 'opportunity' || task.linked_record_type === 'lead')
      && (task.task_type === 'follow_up' || task.task_type === 'email'))
    ? `<button class="gw-task-action-btn gw-task-action-btn--ai" title="AI Follow-Up email"
          style="color:#7B5EA7"
          onclick="event.stopPropagation();window.gwAiFollowupOpen&&window.gwAiFollowupOpen({taskId:'${task.id}',oppId:'${task.linked_record_id}',oppLabel:'${_esc(task.linked_record_label||'').replace(/'/g,'')}'})">${(typeof gwIcon==='function')?gwIcon('sparkle',13,'currentColor'):''}</button>`
    : '';

  const completeBtn = (!isDone && !isArchived && opts.showCompleteBtn !== false)
    ? `<button class="gw-task-action-btn gw-task-action-btn--complete"
          title="Mark complete"
          onclick="window._gwTaskCompleteClick(event,'${task.id}')">
         <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M2 7.5l3.5 3.5 6.5-7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
       </button>`
    : '';

  const editBtn = (!isArchived && opts.showEditBtn !== false)
    ? `<button class="gw-task-action-btn" title="Edit task"
          onclick="window._gwTaskEditClick(event,'${task.id}')">
         <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M10 2l2 2-8 8H2v-2L10 2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
       </button>`
    : '';

  const archiveBtn = (isDone && opts.showArchiveBtn !== false)
    ? `<button class="gw-task-action-btn gw-task-action-btn--archive" title="Archive"
          onclick="window._gwTaskArchiveClick(event,'${task.id}')">
         <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><rect x="2" y="4" width="10" height="8" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M1.5 4h11M5 4V2.5h4V4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
       </button>`
    : '';

  const calIcon = task.calendar_sync_state && task.calendar_sync_state !== 'none'
    ? `<svg class="gw-task-cal-icon" width="11" height="11" viewBox="0 0 14 14" fill="none" title="${_esc(task.calendar_sync_state)}"><rect x="2" y="2.5" width="10" height="9" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M5 1.5v2M9 1.5v2M2 6h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`
    : '';

  return `<div class="gw-task-row ${isDone ? 'gw-task-row--done' : ''} ${isOvd ? 'gw-task-row--overdue' : ''} ${isDueToday ? 'gw-task-row--today' : ''} ${prioClass}" data-task-id="${task.id}">
    <div class="gw-task-row-left">
      ${completeBtn}
      <div class="gw-task-row-body" ${hasRecordNav ? `style="cursor:pointer" onclick="window._gwTaskOpenRecord(event,'${task.linked_record_type}','${task.linked_record_id}')" title="Open ${_esc(task.linked_record_label||'record')}"` : ''}>
        <div class="gw-task-row-title">${_esc(task.title)}${calIcon}</div>
        <div class="gw-task-row-meta">
          ${typeChip}${dueChip}${recordChip}
          ${task.description ? `<span class="gw-task-row-notes">${_esc(task.description.slice(0, 80))}${task.description.length > 80 ? '…' : ''}</span>` : ''}
        </div>
      </div>
    </div>
    <div class="gw-task-row-actions">
      ${aiBtn}${editBtn}${archiveBtn}
    </div>
  </div>`;
}

// ── TASK PANEL RENDERER (for record pages) ─────────────────────────────────────
// Renders the full "Tasks" rail card for an opp/lead/client detail page.

function gwRenderRecordTaskPanel(recordType, recordId, recordLabel) {
  const all   = gwTasksForRecord(recordType, recordId);
  const open  = all.filter(t => t.status === 'open').sort((a, b) => {
    // Overdue first, then by due date, then no date last
    const da = a.due_date || '9999';
    const db = b.due_date || '9999';
    return da.localeCompare(db);
  });
  const done  = all.filter(t => t.status === 'completed').sort((a, b) =>
    (b.completed_at || '').localeCompare(a.completed_at || '')
  ).slice(0, 5);

  const rep = typeof window.getCurrentRep === 'function' ? window.getCurrentRep() : null;

  const openHtml = open.length
    ? open.map(t => gwRenderTaskRow(t, { showRecord: false, showCompleteBtn: true, showEditBtn: true, showArchiveBtn: false })).join('')
    : `<div class="gw-task-empty">No open tasks.</div>`;

  const doneHtml = done.length
    ? `<details class="gw-task-done-details">
         <summary class="gw-task-done-summary">Completed (${done.length}${done.length === 5 ? '+' : ''})</summary>
         ${done.map(t => gwRenderTaskRow(t, { showRecord: false, showCompleteBtn: false, showEditBtn: false, showArchiveBtn: true })).join('')}
       </details>`
    : '';

  return `<div class="gw-task-panel" id="gwTaskPanel_${recordId}">
    <div class="gw-task-panel-header">
      <span class="gw-task-panel-title">Tasks</span>
      <span class="gw-task-panel-count">${open.length > 0 ? open.length + ' open' : 'none'}</span>
      <button class="gw-task-add-btn" onclick="window._gwTaskAddForRecord('${_esc(recordType)}','${_esc(recordId)}','${_esc(recordLabel)}')">
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
        Add Task
      </button>
    </div>
    <div class="gw-task-panel-body">
      ${openHtml}
      ${doneHtml}
    </div>
  </div>`;
}

// ── RECORD PAGE GLOBAL HANDLERS ────────────────────────────────────────────────

window._gwTaskAddForRecord = function(recordType, recordId, recordLabel) {
  const rep = typeof window.getCurrentRep === 'function' ? window.getCurrentRep() : null;
  gwTaskModal({
    defaults: {
      linkedRecordType: recordType,
      linkedRecordId:   recordId,
      linkedRecordLabel: recordLabel,
      assignedUserId:   rep?.id || '',
    }
  }, function(savedTask) {
    // Refresh the panel in-place
    _refreshRecordPanel(recordType, recordId, recordLabel);
    // If Today is cached, it will pick up the new task on next load
  });
};

window._gwTaskCompleteClick = async function(event, taskId) {
  event.stopPropagation();
  const row = document.querySelector(`.gw-task-row[data-task-id="${taskId}"]`);
  if (row) { row.style.opacity = '0.5'; row.style.pointerEvents = 'none'; }
  try {
    await gwTaskComplete(taskId);

    // Set timestamp so _gwTodayRender skips the loadToday() re-fetch for 3s,
    // preventing a race between the D1 write and the next render cycle.
    window._gwTaskLastCompletedAt = Date.now();

    // ── Remove the task from in-memory cache immediately ──────────────────────
    // Using _removeFromCache ensures the task won't reappear when the Today
    // workspace re-renders from cache. The next fresh D1 fetch will also
    // correctly exclude it (status='completed', not returned in open fetch).
    _removeFromCache(taskId);

    // ── Instantly remove the row from the DOM ─────────────────────────────────
    // This gives immediate visual feedback without waiting for a re-fetch.
    // We update group label counts in place rather than doing a full re-render
    // that would trigger another loadToday() → possible race with D1 write.
    if (row) {
      // Animate out, then remove
      row.style.transition = 'opacity 0.2s, transform 0.2s';
      row.style.transform = 'translateX(6px)';
      row.style.opacity = '0';
      setTimeout(function() {
        row.remove();
        // Update overdue / due-today group label counts in place
        _gwUpdateTaskGroupCounts();
      }, 220);
    }

    // Refresh record panel (lead page sidebar) if task was linked to a record
    const cachedTask = _getCache().find(t => t.id === taskId);
    if (cachedTask) _refreshRecordPanel(cachedTask.linked_record_type, cachedTask.linked_record_id, cachedTask.linked_record_label);

    if (typeof window.showToast === 'function') window.showToast('Task completed ✓', 'success');
  } catch(e) {
    if (row) { row.style.opacity = ''; row.style.pointerEvents = ''; row.style.transform = ''; }
    if (typeof window.showToast === 'function') window.showToast('Could not complete task', 'error');
  }
};

// ── Update group header counts after a task is removed from the DOM ───────────
// Counts the remaining visible rows in each group and updates the label,
// hiding the entire group header + rows when count reaches zero.
function _gwUpdateTaskGroupCounts() {
  const workspace = document.querySelector('.gw-task-workspace');
  if (!workspace) return;
  const labels = workspace.querySelectorAll('.gw-today-group-label');
  labels.forEach(function(label) {
    // The rows for this group are siblings between this label and the next label
    let count = 0;
    let el = label.nextElementSibling;
    while (el && !el.classList.contains('gw-today-group-label') && !el.classList.contains('gw-task-done-details')) {
      if (el.classList.contains('gw-task-row')) count++;
      el = el.nextElementSibling;
    }
    if (count === 0) {
      label.style.display = 'none';
    } else {
      // Update count in parentheses: "Overdue (6)" → "Overdue (5)"
      label.textContent = label.textContent.replace(/\(\d+\)/, '(' + count + ')');
      label.style.display = '';
    }
  });
  // Also update the overdue badge in the section header
  const overdueBadge = document.querySelector('.section-head .bad-badge');
  const overdueLabel = workspace.querySelector('.gw-today-group-label--overdue');
  if (overdueBadge && overdueLabel) {
    const m = overdueLabel.textContent.match(/\((\d+)\)/);
    if (m) {
      const n = parseInt(m[1], 10);
      overdueBadge.textContent = n + ' overdue';
      overdueBadge.style.display = n > 0 ? '' : 'none';
    }
  }
}

window._gwTaskArchiveClick = async function(event, taskId) {
  event.stopPropagation();
  const row = document.querySelector(`.gw-task-row[data-task-id="${taskId}"]`);
  if (row) { row.style.opacity = '0.5'; row.style.pointerEvents = 'none'; }
  try {
    const cachedTask = _getCache().find(t => t.id === taskId);
    await gwTaskArchive(taskId);
    // Remove from cache and DOM immediately (same approach as complete)
    _removeFromCache(taskId);
    window._gwTaskLastCompletedAt = Date.now();
    if (row) {
      row.style.transition = 'opacity 0.2s, transform 0.2s';
      row.style.transform = 'translateX(6px)';
      row.style.opacity = '0';
      setTimeout(function() {
        row.remove();
        _gwUpdateTaskGroupCounts();
      }, 220);
    }
    if (cachedTask) _refreshRecordPanel(cachedTask.linked_record_type, cachedTask.linked_record_id, cachedTask.linked_record_label);
    if (typeof window.showToast === 'function') window.showToast('Task archived', 'success');
  } catch(e) {
    if (row) { row.style.opacity = ''; row.style.pointerEvents = ''; row.style.transform = ''; }
    if (typeof window.showToast === 'function') window.showToast('Could not archive task', 'error');
  }
};

window._gwTaskEditClick = function(event, taskId) {
  event.stopPropagation();
  const task = _getCache().find(t => t.id === taskId);
  if (!task) return;
  gwTaskModal({ task }, function(saved) {
    _refreshRecordPanel(saved.linked_record_type, saved.linked_record_id, saved.linked_record_label);
    if (typeof window._gwTodayRefreshIfActive === 'function') window._gwTodayRefreshIfActive();
  });
};

// ── Click-through: open the linked record from any task row ───────────────────
window._gwTaskOpenRecord = function(event, recordType, recordId) {
  if (event) event.stopPropagation();
  try {
    switch (recordType) {
      case 'lead':       window._leadTab = 'overview'; window.show('pipeline', recordId); break;
      case 'client':     window.show('clients', recordId); break;
      case 'work_order': window.show('workOrderDetail', recordId); break;
      case 'estimate':   window.show('estimates', recordId); break;
      case 'invoice':    window.show('invoices', recordId); break;
      default: return;
    }
  } catch(e) { console.warn('[TaskEngine] open record failed', e); }
};

function _refreshRecordPanel(recordType, recordId, recordLabel) {
  if (!recordId) return;
  const container = document.getElementById(`gwTaskPanel_${recordId}`);
  if (!container) return;
  container.outerHTML = gwRenderRecordTaskPanel(recordType, recordId, recordLabel || '');
}

// ── INTERNAL ESCAPE ───────────────────────────────────────────────────────────

function _esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── EXPORT ────────────────────────────────────────────────────────────────────

window.GW_TASK_TYPES          = TASK_TYPES;
window.GW_TASK_STATUSES       = TASK_STATUSES;
window.GW_LINKABLE_RECORD_TYPES = LINKABLE_RECORD_TYPES;
window.GW_CALENDAR_SYNC_STATES  = CALENDAR_SYNC_STATES;
window.GW_CALENDAR_PUSH_TYPES   = CALENDAR_PUSH_TYPES;

window.gwTask = {
  // Loading
  loadToday:        gwTasksLoadToday,
  loadForRecord:    gwTasksLoadForRecord,
  loadTeamSummary:  gwTasksLoadTeamSummary,
  // CRUD
  create:    gwTaskCreate,
  update:    gwTaskUpdate,
  complete:  gwTaskComplete,
  archive:   gwTaskArchive,
  calPush:   gwTaskCalendarPush,
  // Cache filters
  forRecord:       gwTasksForRecord,
  forUser:         gwTasksForUser,
  openForUser:     gwTasksOpenForUser,
  dueTodayForUser: gwTasksDueTodayForUser,
  overdueForUser:  gwTasksOverdueForUser,
  completedToday:  gwTasksCompletedTodayForUser,
  dueState:        _taskDueState,
  typeLabel:       _taskTypeLabel,
  prettyDate:      _prettyDate,
  // Rendering
  modal:           gwTaskModal,
  renderRow:       gwRenderTaskRow,
  renderRecordPanel: gwRenderRecordTaskPanel,
};

console.log('[TaskEngine] Loaded — window.gwTask ready');
})();
