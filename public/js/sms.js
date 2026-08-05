/* ── Groundwork CRM — Text Messages Center ────────────────────────────────────
 * Two-way SMS for every company: conversation inbox, live thread, composer
 * with templates, delivery status, error log, and per-company Twilio setup.
 * Backend: /api/sms/* (see src/index.tsx SMS section).
 */
(function () {
  'use strict';

  const API = {
    async get(path) {
      const r = await fetch(path, { credentials: 'include' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      return j.data !== undefined ? j.data : j;
    },
    async send(path, method, body) {
      const r = await fetch(path, {
        method, credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      return j.data !== undefined ? j.data : j;
    }
  };

  const S = {
    tab: 'inbox',            // inbox | templates | errors | setup
    conversations: [],
    activeConvId: null,
    thread: null,            // { conversation, messages }
    templates: [],
    errors: [],
    config: null,            // { account_sid, from_number, token_set }
    status: null,            // { configured, from_number }
    search: '',
    unreadOnly: false,
    pollTimer: null
  };

  const esc = (s) => (typeof escapeHtml === 'function') ? escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s);
  const icon = (n, s) => (typeof gwIcon === 'function') ? gwIcon(n, s || 14, 'currentColor') : '';

  function fmtPhone(p) {
    const d = String(p || '').replace(/\D/g, '');
    if (d.length === 11 && d[0] === '1') return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
    return p || '';
  }
  function fmtTime(ts) {
    if (!ts) return '';
    try {
      const d = new Date(String(ts).replace(' ', 'T') + (String(ts).includes('Z') ? '' : 'Z'));
      const now = new Date();
      const sameDay = d.toDateString() === now.toDateString();
      if (sameDay) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      if (now.getTime() - d.getTime() < 6 * 86400000) return d.toLocaleDateString(undefined, { weekday: 'short' });
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch (e) { return ''; }
  }
  function initials(name, phone) {
    const n = String(name || '').trim();
    if (n) return n.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
    const d = String(phone || '').replace(/\D/g, '');
    return d.slice(-2) || '#';
  }
  const STATUS_LABEL = { queued: 'Queued', sent: 'Sent', delivered: 'Delivered', undelivered: 'Not delivered', failed: 'Failed', received: '' };

  function stopPoll() { if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; } }

  // ── Main view ───────────────────────────────────────────────────────────────
  async function smsCenter(tab) {
    stopPoll();
    if (tab) S.tab = tab;
    const view = document.getElementById('view');
    if (!view) return;

    try { S.status = await API.get('/api/sms/status'); } catch (e) { S.status = { configured: false }; }

    const isAdmin = (() => {
      const rep = window.getCurrentRep ? window.getCurrentRep() : null;
      const role = rep ? rep.role : (window._d1SessionRep ? window._d1SessionRep.role : '');
      return role === 'admin' || role === 'office_manager' || !!(window._d1SessionRep && window._d1SessionRep.is_super_admin);
    })();

    const TABS = [
      { id: 'inbox', label: 'Messages', ic: 'comms' },
      { id: 'templates', label: 'Templates', ic: 'note' },
      { id: 'errors', label: 'Error Log', ic: 'warning' }
    ];
    if (isAdmin) TABS.push({ id: 'setup', label: 'Setup', ic: 'settings' });
    if (!TABS.some(t => t.id === S.tab)) S.tab = 'inbox';

    view.innerHTML = `
<section id="sms-center" style="display:flex;flex-direction:column;height:calc(100vh - 190px);min-height:480px">
  <header style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
    <div>
      <div style="font-size:20px;font-weight:800;color:var(--gw-ink,#0F1C14)">Text Messages</div>
      <div style="font-size:12.5px;color:var(--gw-text-muted,#6F7E6A);margin-top:2px">
        ${S.status && S.status.configured
          ? `Sending from <strong>${esc(fmtPhone(S.status.from_number))}</strong>`
          : `Not configured yet${isAdmin ? ' — open <a href="#" onclick="smsCenter(\'setup\');return false" style="color:var(--gds-pine,#204A43);font-weight:600">Setup</a> to connect Twilio' : ' — ask your admin to enable texting'}`}
      </div>
    </div>
    <div style="display:flex;gap:6px;background:var(--gw-surface-2,#EDF2F0);border:1px solid var(--gw-line,#DCE5E0);border-radius:10px;padding:5px">
      ${TABS.map(t => `<button id="sms-tab-${t.id}" onclick="smsCenter('${t.id}')"
        style="display:inline-flex;align-items:center;gap:6px;border:none;border-radius:7px;padding:7px 13px;font-size:12.5px;cursor:pointer;font-weight:${t.id === S.tab ? '700' : '500'};${t.id === S.tab ? 'background:var(--gw-card,#fff);color:var(--gw-ink,#0F1C14);box-shadow:0 1px 3px rgba(31,42,43,.10)' : 'background:transparent;color:var(--gw-text-muted,#6F7E6A)'}">${icon(t.ic, 13)}${t.label}</button>`).join('')}
    </div>
  </header>
  <div id="sms-body" style="flex:1;min-height:0"></div>
</section>`;

    if (S.tab === 'inbox') await renderInbox();
    else if (S.tab === 'templates') await renderTemplates();
    else if (S.tab === 'errors') await renderErrors();
    else if (S.tab === 'setup') await renderSetup();
  }

  // ── Inbox (two-pane) ────────────────────────────────────────────────────────
  async function renderInbox() {
    const body = document.getElementById('sms-body');
    if (!body) return;
    body.innerHTML = `
<div style="display:grid;grid-template-columns:340px minmax(0,1fr);gap:0;height:100%;border:1px solid var(--gw-line,#DCE5E0);border-radius:14px;overflow:hidden;background:var(--gw-card,#fff)">
  <aside style="border-right:1px solid var(--gw-line,#DCE5E0);display:flex;flex-direction:column;min-height:0">
    <div style="padding:12px;border-bottom:1px solid var(--gw-line,#DCE5E0);display:flex;gap:8px;align-items:center">
      <div style="position:relative;flex:1">
        <input id="sms-search" type="text" placeholder="Search name or number" value="${esc(S.search)}"
          oninput="window._smsSearchDebounce(this.value)"
          style="width:100%;box-sizing:border-box;padding:8px 10px 8px 30px;border:1px solid var(--gw-line,#DCE5E0);border-radius:8px;font-size:13px;background:var(--gw-bg-app,#F7FAF8)">
        <span style="position:absolute;left:9px;top:8px;color:var(--gw-text-muted,#6F7E6A)">${icon('search', 13)}</span>
      </div>
      <button class="rp-btn" onclick="window._smsToggleUnread()" title="Show unread only"
        style="padding:8px 10px;font-size:12px;${S.unreadOnly ? 'background:var(--gds-pine,#204A43);color:#fff;border-color:var(--gds-pine,#204A43)' : ''}">Unread</button>
      <button class="rp-btn rp-btn--primary" onclick="smsNewMessage()" title="New message" style="padding:8px 10px">${icon('plus', 13)}</button>
    </div>
    <div id="sms-conv-list" style="flex:1;overflow-y:auto;min-height:0"></div>
  </aside>
  <main id="sms-thread-pane" style="display:flex;flex-direction:column;min-height:0"></main>
</div>`;
    await refreshConversations();
    renderThreadPane();
    // Light polling keeps the inbox and open thread fresh
    S.pollTimer = setInterval(async () => {
      if (S.tab !== 'inbox' || !document.getElementById('sms-conv-list')) { stopPoll(); return; }
      await refreshConversations(true);
      if (S.activeConvId) await openConversation(S.activeConvId, true);
    }, 12000);
  }

  async function refreshConversations(silent) {
    try {
      const qs = new URLSearchParams();
      if (S.search) qs.set('q', S.search);
      if (S.unreadOnly) qs.set('unread', '1');
      S.conversations = await API.get('/api/sms/conversations' + (qs.toString() ? '?' + qs.toString() : ''));
    } catch (e) { if (!silent) S.conversations = []; }
    const list = document.getElementById('sms-conv-list');
    if (!list) return;
    if (!S.conversations.length) {
      list.innerHTML = `<div style="padding:36px 20px;text-align:center;color:var(--gw-text-muted,#6F7E6A)">
        <div style="width:42px;height:42px;border-radius:11px;background:var(--gw-surface-2,#EDF2F0);display:flex;align-items:center;justify-content:center;margin:0 auto 12px">${icon('comms', 18)}</div>
        <div style="font-weight:700;font-size:13.5px;color:var(--gw-ink,#0F1C14);margin-bottom:4px">${S.search || S.unreadOnly ? 'No matches' : 'No conversations yet'}</div>
        <div style="font-size:12.5px;line-height:1.55">${S.search || S.unreadOnly ? 'Try a different search.' : 'Start a conversation with the + button above.'}</div>
      </div>`;
      return;
    }
    list.innerHTML = S.conversations.map(cv => {
      const active = cv.id === S.activeConvId;
      const name = cv.display_name || fmtPhone(cv.phone_e164);
      const unread = Number(cv.unread_count) > 0;
      return `<div onclick="window._smsOpenConv('${cv.id}')"
        style="display:flex;gap:10px;padding:11px 12px;cursor:pointer;border-bottom:1px solid var(--gw-line,#ECF1EE);${active ? 'background:var(--gw-surface-2,#EDF2F0)' : ''}"
        onmouseover="if(!${active})this.style.background='var(--gw-bg-app,#F7FAF8)'" onmouseout="this.style.background='${active ? 'var(--gw-surface-2,#EDF2F0)' : ''}'">
        <div style="width:38px;height:38px;border-radius:50%;background:${unread ? 'var(--gds-pine,#204A43)' : 'var(--gw-surface-2,#DCE5E0)'};color:${unread ? '#fff' : 'var(--gw-ink,#0F1C14)'};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0">${esc(initials(cv.display_name, cv.phone_e164))}</div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">
            <span style="font-weight:${unread ? '800' : '600'};font-size:13.5px;color:var(--gw-ink,#0F1C14);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(name)}</span>
            <span style="font-size:11px;color:var(--gw-text-muted,#6F7E6A);flex-shrink:0">${esc(fmtTime(cv.last_message_at))}</span>
          </div>
          <div style="display:flex;justify-content:space-between;gap:8px;margin-top:2px">
            <span style="font-size:12px;color:${unread ? 'var(--gw-ink,#0F1C14)' : 'var(--gw-text-muted,#6F7E6A)'};font-weight:${unread ? '600' : '400'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${cv.last_direction === 'out' ? 'You: ' : ''}${esc(cv.last_message_preview || '')}</span>
            ${unread ? `<span style="min-width:18px;height:18px;border-radius:9px;background:var(--gds-pine,#204A43);color:#fff;font-size:10.5px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 5px;flex-shrink:0">${cv.unread_count}</span>` : ''}
          </div>
        </div>
      </div>`;
    }).join('');
  }

  function renderThreadPane() {
    const pane = document.getElementById('sms-thread-pane');
    if (!pane) return;
    if (!S.activeConvId || !S.thread) {
      pane.innerHTML = `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--gw-text-muted,#6F7E6A);padding:24px;text-align:center">
        <div style="width:52px;height:52px;border-radius:14px;background:var(--gw-surface-2,#EDF2F0);display:flex;align-items:center;justify-content:center;margin-bottom:14px">${icon('comms', 22)}</div>
        <div style="font-weight:700;font-size:14.5px;color:var(--gw-ink,#0F1C14);margin-bottom:4px">Select a conversation</div>
        <div style="font-size:13px">Choose a thread on the left or start a new message.</div>
      </div>`;
      return;
    }
    const cv = S.thread.conversation;
    const msgs = S.thread.messages || [];
    const name = cv.display_name || fmtPhone(cv.phone_e164);
    pane.innerHTML = `
  <div style="padding:12px 16px;border-bottom:1px solid var(--gw-line,#DCE5E0);display:flex;align-items:center;gap:10px">
    <div style="width:34px;height:34px;border-radius:50%;background:var(--gw-surface-2,#DCE5E0);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px">${esc(initials(cv.display_name, cv.phone_e164))}</div>
    <div style="flex:1;min-width:0">
      <div style="font-weight:700;font-size:14px;color:var(--gw-ink,#0F1C14)">${esc(name)}</div>
      <div style="font-size:11.5px;color:var(--gw-text-muted,#6F7E6A)">${esc(fmtPhone(cv.phone_e164))}${cv.client_id ? ' · Linked client' : ''}</div>
    </div>
    ${cv.client_id ? `<button class="rp-btn" style="font-size:12px" onclick="(typeof customerDetail==='function')?customerDetail('${esc(cv.client_id)}'):null">View Client</button>` : ''}
    <button class="rp-btn" style="font-size:12px" onclick="window._smsArchive('${cv.id}')" title="Archive">${icon('archive', 13)}</button>
  </div>
  <div id="sms-msgs" style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px;background:var(--gw-bg-app,#F7FAF8)">
    ${msgs.length ? msgs.map(m => {
      const out = m.direction === 'out';
      const failed = m.status === 'failed' || m.status === 'undelivered';
      return `<div style="display:flex;${out ? 'justify-content:flex-end' : 'justify-content:flex-start'}">
        <div style="max-width:72%">
          <div style="padding:9px 13px;border-radius:${out ? '14px 14px 4px 14px' : '14px 14px 14px 4px'};font-size:13.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word;${out
            ? (failed ? 'background:#FAE8E4;color:#7A2E20;border:1px solid #E8C4BC' : 'background:var(--gds-pine,#204A43);color:#fff')
            : 'background:var(--gw-card,#fff);color:var(--gw-ink,#0F1C14);border:1px solid var(--gw-line,#DCE5E0)'}">${esc(m.body)}</div>
          <div style="font-size:10.5px;color:${failed ? '#B4472F' : 'var(--gw-text-muted,#6F7E6A)'};margin-top:3px;text-align:${out ? 'right' : 'left'}">
            ${esc(fmtTime(m.created_at))}${out && STATUS_LABEL[m.status] ? ' · ' + STATUS_LABEL[m.status] : ''}${failed && m.error_message ? ' — ' + esc(m.error_message) : ''}
          </div>
        </div>
      </div>`;
    }).join('') : `<div style="text-align:center;color:var(--gw-text-muted,#6F7E6A);font-size:13px;padding:24px">No messages yet — say hello below.</div>`}
  </div>
  <div style="padding:12px 14px;border-top:1px solid var(--gw-line,#DCE5E0);background:var(--gw-card,#fff)">
    <div style="display:flex;gap:8px;align-items:flex-end">
      <div style="flex:1">
        <textarea id="sms-compose" rows="2" placeholder="Type a message"
          oninput="window._smsCount(this)" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();window._smsSendThread()}"
          style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--gw-line,#DCE5E0);border-radius:10px;font-size:13.5px;resize:none;font-family:inherit"></textarea>
        <div style="display:flex;justify-content:space-between;margin-top:4px">
          <button class="rp-btn" style="font-size:11.5px;padding:4px 9px" onclick="window._smsPickTemplate()">${icon('note', 12)} Template</button>
          <span id="sms-char" style="font-size:11px;color:var(--gw-text-muted,#6F7E6A)"></span>
        </div>
      </div>
      <button class="rp-btn rp-btn--primary" id="sms-send-btn" onclick="window._smsSendThread()" style="padding:10px 16px;margin-bottom:26px" ${S.status && S.status.configured ? '' : 'disabled title="Texting is not configured"'}>${icon('send', 14)} Send</button>
    </div>
  </div>`;
    const box = document.getElementById('sms-msgs');
    if (box) box.scrollTop = box.scrollHeight;
  }

  async function openConversation(id, silent) {
    try {
      const wasActive = S.activeConvId === id;
      const prevCount = wasActive && S.thread ? (S.thread.messages || []).length : -1;
      const draft = silent ? (document.getElementById('sms-compose') || {}).value : undefined;
      const data = await API.get('/api/sms/conversations/' + id + '/messages');
      S.activeConvId = id;
      const newCount = (data.messages || []).length;
      S.thread = data;
      if (!silent || newCount !== prevCount) {
        renderThreadPane();
        if (silent && draft) { const el = document.getElementById('sms-compose'); if (el) { el.value = draft; window._smsCount(el); } }
        if (!silent) await refreshConversations(true);
      }
    } catch (e) {
      if (!silent && typeof showToast === 'function') showToast('Could not open conversation: ' + e.message, 'error');
    }
  }

  // ── Templates tab ───────────────────────────────────────────────────────────
  async function renderTemplates() {
    const body = document.getElementById('sms-body');
    if (!body) return;
    try { S.templates = await API.get('/api/sms/templates'); } catch (e) { S.templates = []; }
    body.innerHTML = `
<div style="max-width:820px">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
    <div style="font-size:13px;color:var(--gw-text-muted,#6F7E6A)">Reusable snippets your team can drop into any text. Placeholders: <code>{{name}}</code>, <code>{{company}}</code>, <code>{{rep}}</code>.</div>
    <button class="rp-btn rp-btn--primary" onclick="window._smsTplEdit()" style="flex-shrink:0">${icon('plus', 13)} New Template</button>
  </div>
  ${S.templates.length ? `<div style="display:grid;gap:10px">${S.templates.map(t => `
    <div style="border:1px solid var(--gw-line,#DCE5E0);border-radius:12px;padding:14px 16px;background:var(--gw-card,#fff);display:flex;gap:14px;align-items:flex-start">
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:13.5px;color:var(--gw-ink,#0F1C14)">${esc(t.name)}</div>
        <div style="font-size:12.5px;color:var(--gw-text-muted,#6F7E6A);margin-top:4px;white-space:pre-wrap">${esc(t.body)}</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button class="rp-btn" style="font-size:12px" onclick="window._smsTplEdit('${t.id}')">Edit</button>
        <button class="rp-btn" style="font-size:12px;color:#7A2E20" onclick="window._smsTplDelete('${t.id}')">Delete</button>
      </div>
    </div>`).join('')}</div>`
    : `<div style="border:1px dashed var(--gw-line,#DCE5E0);border-radius:12px;padding:36px;text-align:center;color:var(--gw-text-muted,#6F7E6A)">
        <div style="font-weight:700;color:var(--gw-ink,#0F1C14);margin-bottom:4px;font-size:13.5px">No templates yet</div>
        <div style="font-size:12.5px">Create your first template — appointment reminders, on-my-way notices, follow-ups.</div>
      </div>`}
</div>`;
  }

  // ── Error log tab ───────────────────────────────────────────────────────────
  async function renderErrors() {
    const body = document.getElementById('sms-body');
    if (!body) return;
    try { S.errors = await API.get('/api/sms/errors'); } catch (e) { S.errors = []; }
    body.innerHTML = `
<div style="max-width:980px">
  <div style="font-size:13px;color:var(--gw-text-muted,#6F7E6A);margin-bottom:14px">Messages that failed to send or could not be delivered by the carrier.</div>
  ${S.errors.length ? `
  <div style="border:1px solid var(--gw-line,#DCE5E0);border-radius:12px;overflow:hidden;background:var(--gw-card,#fff)">
    <table style="width:100%;border-collapse:collapse;font-size:12.5px">
      <thead><tr style="background:var(--gw-surface-2,#EDF2F0);text-align:left">
        <th style="padding:10px 14px;font-weight:700">When</th><th style="padding:10px 14px;font-weight:700">To</th>
        <th style="padding:10px 14px;font-weight:700">Message</th><th style="padding:10px 14px;font-weight:700">Status</th>
        <th style="padding:10px 14px;font-weight:700">Error</th>
      </tr></thead>
      <tbody>${S.errors.map(m => `<tr style="border-top:1px solid var(--gw-line,#ECF1EE)">
        <td style="padding:10px 14px;white-space:nowrap;color:var(--gw-text-muted,#6F7E6A)">${esc(fmtTime(m.created_at))}</td>
        <td style="padding:10px 14px;white-space:nowrap">${esc(m.display_name || fmtPhone(m.phone_e164))}</td>
        <td style="padding:10px 14px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.body)}</td>
        <td style="padding:10px 14px"><span style="background:#FAE8E4;color:#7A2E20;border-radius:5px;padding:2px 8px;font-weight:600;font-size:11px">${esc(m.status)}</span></td>
        <td style="padding:10px 14px;color:#7A2E20">${esc(m.error_code ? m.error_code + ' — ' : '')}${esc(m.error_message || '')}</td>
      </tr>`).join('')}</tbody>
    </table>
  </div>`
  : `<div style="border:1px dashed var(--gw-line,#DCE5E0);border-radius:12px;padding:36px;text-align:center;color:var(--gw-text-muted,#6F7E6A)">
      <div style="font-weight:700;color:var(--gw-ink,#0F1C14);margin-bottom:4px;font-size:13.5px">No delivery problems</div>
      <div style="font-size:12.5px">Failed and undelivered messages will show up here with carrier error details.</div>
    </div>`}
</div>`;
  }

  // ── Setup tab (admin) ───────────────────────────────────────────────────────
  async function renderSetup() {
    const body = document.getElementById('sms-body');
    if (!body) return;
    try { S.config = await API.get('/api/sms/config'); } catch (e) { S.config = { account_sid: '', from_number: '', token_set: false }; }
    const origin = window.location.origin;
    const companyId = (window._d1SessionRep && window._d1SessionRep.company_id) || '';
    body.innerHTML = `
<div style="max-width:680px">
  <div style="border:1px solid var(--gw-line,#DCE5E0);border-radius:14px;padding:22px 24px;background:var(--gw-card,#fff)">
    <div style="font-weight:800;font-size:15px;color:var(--gw-ink,#0F1C14);margin-bottom:4px">Twilio Connection</div>
    <p style="font-size:12.5px;color:var(--gw-text-muted,#6F7E6A);line-height:1.6;margin:0 0 18px">
      Texting runs on your company's own Twilio account and phone number.
      Find the Account SID and Auth Token on your <strong>Twilio Console dashboard</strong>, and buy an SMS-capable number under Phone Numbers.
    </p>
    <label style="font-size:11px;font-weight:700;color:var(--gw-text-muted,#6F7E6A);text-transform:uppercase;letter-spacing:.04em;display:block;margin-bottom:5px">Account SID</label>
    <input id="sms-cfg-sid" type="text" value="${esc(S.config.account_sid)}" placeholder="AC................................"
      style="width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid var(--gw-line,#DCE5E0);border-radius:8px;font-size:12.5px;font-family:monospace;margin-bottom:14px">
    <label style="font-size:11px;font-weight:700;color:var(--gw-text-muted,#6F7E6A);text-transform:uppercase;letter-spacing:.04em;display:block;margin-bottom:5px">Auth Token ${S.config.token_set ? '<span style="color:var(--gds-pine,#204A43);text-transform:none;font-weight:600">(saved — leave blank to keep)</span>' : ''}</label>
    <input id="sms-cfg-token" type="password" placeholder="${S.config.token_set ? 'Unchanged' : 'Your Twilio auth token'}"
      style="width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid var(--gw-line,#DCE5E0);border-radius:8px;font-size:12.5px;font-family:monospace;margin-bottom:14px">
    <label style="font-size:11px;font-weight:700;color:var(--gw-text-muted,#6F7E6A);text-transform:uppercase;letter-spacing:.04em;display:block;margin-bottom:5px">Sending Number</label>
    <input id="sms-cfg-from" type="tel" value="${esc(S.config.from_number)}" placeholder="+1 555 000 0000"
      style="width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid var(--gw-line,#DCE5E0);border-radius:8px;font-size:12.5px;margin-bottom:18px">
    <div style="display:flex;gap:10px;align-items:center">
      <button class="rp-btn rp-btn--primary" onclick="window._smsSaveConfig()">Save Connection</button>
      <span id="sms-cfg-status" style="font-size:12.5px;color:var(--gw-text-muted,#6F7E6A)"></span>
    </div>
  </div>

  <div style="border:1px solid var(--gw-line,#DCE5E0);border-radius:14px;padding:22px 24px;background:var(--gw-card,#fff);margin-top:16px">
    <div style="font-weight:800;font-size:14px;color:var(--gw-ink,#0F1C14);margin-bottom:4px">Twilio Webhooks</div>
    <p style="font-size:12.5px;color:var(--gw-text-muted,#6F7E6A);line-height:1.6;margin:0 0 14px">
      To receive replies inside Groundwork, set this URL as the <strong>"A message comes in"</strong> webhook (HTTP POST) on your Twilio phone number:
    </p>
    <code style="display:block;background:var(--gw-bg-app,#F7FAF8);border:1px solid var(--gw-line,#DCE5E0);border-radius:8px;padding:10px 12px;font-size:11.5px;word-break:break-all;margin-bottom:10px">${esc(origin)}/api/sms/webhook/inbound/${esc(companyId)}</code>
    <p style="font-size:12.5px;color:var(--gw-text-muted,#6F7E6A);line-height:1.6;margin:0 0 8px">Delivery receipts are reported automatically on every send — no extra setup needed.</p>
    <p style="font-size:11.5px;color:var(--gw-text-muted,#6F7E6A);line-height:1.6;margin:0">
      Note: texting US customers from a local number requires A2P 10DLC registration in the Twilio console (Messaging, Regulatory Compliance). Unregistered numbers get filtered by carriers.
    </p>
  </div>
</div>`;
  }

  // ── Actions ─────────────────────────────────────────────────────────────────
  let searchTimer = null;
  window._smsSearchDebounce = function (v) {
    S.search = v;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => refreshConversations(), 250);
  };
  window._smsToggleUnread = function () { S.unreadOnly = !S.unreadOnly; renderInbox(); };
  window._smsOpenConv = function (id) { openConversation(id); };
  window._smsCount = function (el) {
    const c = document.getElementById('sms-char');
    if (!c) return;
    const len = el.value.length;
    const segs = Math.ceil(len / 160) || 1;
    c.textContent = len ? `${len} chars · ${segs} segment${segs > 1 ? 's' : ''}` : '';
  };
  window._smsArchive = async function (id) {
    try {
      await API.send('/api/sms/conversations/' + id + '/archive', 'POST');
      if (S.activeConvId === id) { S.activeConvId = null; S.thread = null; }
      await refreshConversations();
      renderThreadPane();
      if (typeof showToast === 'function') showToast('Conversation archived', 'success');
    } catch (e) { if (typeof showToast === 'function') showToast(e.message, 'error'); }
  };
  window._smsSendThread = async function () {
    const el = document.getElementById('sms-compose');
    const btn = document.getElementById('sms-send-btn');
    if (!el || !S.thread) return;
    const text = el.value.trim();
    if (!text) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Sending'; }
    try {
      await API.send('/api/sms/send', 'POST', { to: S.thread.conversation.phone_e164, body: text, client_id: S.thread.conversation.client_id || '', opp_id: S.thread.conversation.opp_id || '' });
      el.value = '';
      await openConversation(S.activeConvId);
      await refreshConversations(true);
    } catch (e) {
      if (typeof showToast === 'function') showToast('Send failed: ' + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = icon('send', 14) + ' Send'; }
    }
  };

  window._smsPickTemplate = async function () {
    try { S.templates = await API.get('/api/sms/templates'); } catch (e) { S.templates = []; }
    if (!S.templates.length) { if (typeof showToast === 'function') showToast('No templates yet — create one in the Templates tab', 'info'); return; }
    const existing = document.getElementById('sms-tpl-pop');
    if (existing) { existing.remove(); return; }
    const rep = window.getCurrentRep ? window.getCurrentRep() : null;
    const companyName = (window._d1SessionRep && window._d1SessionRep.company_name) || (typeof state !== 'undefined' && state.companyName) || 'our team';
    const cvName = (S.thread && (S.thread.conversation.display_name || '')).split(' ')[0] || 'there';
    const pop = document.createElement('div');
    pop.id = 'sms-tpl-pop';
    pop.style.cssText = 'position:fixed;inset:0;background:rgba(15,28,20,.35);z-index:9000;display:flex;align-items:center;justify-content:center';
    pop.innerHTML = `<div style="background:var(--gw-card,#fff);border-radius:14px;max-width:460px;width:92%;max-height:70vh;overflow-y:auto;padding:18px 20px" onclick="event.stopPropagation()">
      <div style="font-weight:800;font-size:14.5px;margin-bottom:12px;color:var(--gw-ink,#0F1C14)">Insert Template</div>
      ${S.templates.map(t => `<div onclick='window._smsUseTemplate(${JSON.stringify(String(t.id))})' style="border:1px solid var(--gw-line,#DCE5E0);border-radius:10px;padding:11px 13px;margin-bottom:8px;cursor:pointer" onmouseover="this.style.background='var(--gw-bg-app,#F7FAF8)'" onmouseout="this.style.background=''">
        <div style="font-weight:700;font-size:12.5px;color:var(--gw-ink,#0F1C14)">${esc(t.name)}</div>
        <div style="font-size:12px;color:var(--gw-text-muted,#6F7E6A);margin-top:3px;white-space:pre-wrap">${esc(t.body.slice(0, 160))}</div>
      </div>`).join('')}
    </div>`;
    pop.onclick = () => pop.remove();
    document.body.appendChild(pop);
    window._smsTplContext = { name: cvName, company: companyName, rep: rep ? (rep.name || '') : '' };
  };
  window._smsUseTemplate = function (id) {
    const t = S.templates.find(x => x.id === id);
    document.getElementById('sms-tpl-pop')?.remove();
    if (!t) return;
    const ctx = window._smsTplContext || {};
    const text = String(t.body)
      .replace(/\{\{\s*name\s*\}\}/gi, ctx.name || '')
      .replace(/\{\{\s*company\s*\}\}/gi, ctx.company || '')
      .replace(/\{\{\s*rep\s*\}\}/gi, ctx.rep || '');
    const el = document.getElementById('sms-compose') || document.getElementById('sms-new-body');
    if (el) { el.value = (el.value ? el.value + ' ' : '') + text; el.focus(); if (el.id === 'sms-compose') window._smsCount(el); }
  };

  window._smsTplEdit = function (id) {
    const t = id ? S.templates.find(x => x.id === id) : null;
    const overlay = document.createElement('div');
    overlay.id = 'sms-tpl-editor';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,28,20,.35);z-index:9000;display:flex;align-items:center;justify-content:center';
    overlay.innerHTML = `<div style="background:var(--gw-card,#fff);border-radius:14px;max-width:480px;width:92%;padding:20px 22px" onclick="event.stopPropagation()">
      <div style="font-weight:800;font-size:15px;margin-bottom:14px;color:var(--gw-ink,#0F1C14)">${t ? 'Edit' : 'New'} Template</div>
      <label style="font-size:11px;font-weight:700;color:var(--gw-text-muted,#6F7E6A);text-transform:uppercase;display:block;margin-bottom:5px">Name</label>
      <input id="sms-tpl-name" type="text" value="${esc(t ? t.name : '')}" placeholder="Appointment reminder"
        style="width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid var(--gw-line,#DCE5E0);border-radius:8px;font-size:13px;margin-bottom:12px">
      <label style="font-size:11px;font-weight:700;color:var(--gw-text-muted,#6F7E6A);text-transform:uppercase;display:block;margin-bottom:5px">Message</label>
      <textarea id="sms-tpl-body" rows="4" placeholder="Hi {{name}}, this is {{rep}} from {{company}}."
        style="width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid var(--gw-line,#DCE5E0);border-radius:8px;font-size:13px;resize:vertical;font-family:inherit">${esc(t ? t.body : '')}</textarea>
      <div style="font-size:11px;color:var(--gw-text-muted,#6F7E6A);margin:6px 0 16px">Placeholders: {{name}} {{company}} {{rep}}</div>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="rp-btn" onclick="document.getElementById('sms-tpl-editor').remove()">Cancel</button>
        <button class="rp-btn rp-btn--primary" onclick="window._smsTplSave('${t ? t.id : ''}')">Save Template</button>
      </div>
    </div>`;
    overlay.onclick = () => overlay.remove();
    document.body.appendChild(overlay);
  };
  window._smsTplSave = async function (id) {
    const name = (document.getElementById('sms-tpl-name') || {}).value || '';
    const bodyTxt = (document.getElementById('sms-tpl-body') || {}).value || '';
    if (!name.trim() || !bodyTxt.trim()) { if (typeof showToast === 'function') showToast('Name and message are required', 'error'); return; }
    try {
      if (id) await API.send('/api/sms/templates/' + id, 'PUT', { name, body: bodyTxt });
      else await API.send('/api/sms/templates', 'POST', { name, body: bodyTxt });
      document.getElementById('sms-tpl-editor')?.remove();
      if (S.tab === 'templates') await renderTemplates();
      if (typeof showToast === 'function') showToast('Template saved', 'success');
    } catch (e) { if (typeof showToast === 'function') showToast(e.message, 'error'); }
  };
  window._smsTplDelete = async function (id) {
    if (!confirm('Delete this template?')) return;
    try {
      await API.send('/api/sms/templates/' + id, 'DELETE');
      await renderTemplates();
    } catch (e) { if (typeof showToast === 'function') showToast(e.message, 'error'); }
  };

  window._smsSaveConfig = async function () {
    const sid = (document.getElementById('sms-cfg-sid') || {}).value || '';
    const token = (document.getElementById('sms-cfg-token') || {}).value || '';
    const from = (document.getElementById('sms-cfg-from') || {}).value || '';
    const status = document.getElementById('sms-cfg-status');
    try {
      const payload = { account_sid: sid, from_number: from };
      if (token.trim()) payload.auth_token = token;
      const res = await API.send('/api/sms/config', 'PUT', payload);
      if (status) status.textContent = res.configured ? 'Saved — texting is live.' : 'Saved. Add all three fields to go live.';
      if (typeof showToast === 'function') showToast('Twilio settings saved', 'success');
      S.status = { configured: res.configured, from_number: res.from_number };
    } catch (e) {
      if (status) status.textContent = e.message;
      if (typeof showToast === 'function') showToast(e.message, 'error');
    }
  };

  // ── New message modal ───────────────────────────────────────────────────────
  window.smsNewMessage = function (prefill) {
    const overlay = document.createElement('div');
    overlay.id = 'sms-new-modal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,28,20,.35);z-index:9000;display:flex;align-items:center;justify-content:center';
    const clients = (typeof state !== 'undefined' && Array.isArray(state.clients)) ? state.clients.filter(c => c.phone) : [];
    overlay.innerHTML = `<div style="background:var(--gw-card,#fff);border-radius:14px;max-width:480px;width:92%;padding:20px 22px" onclick="event.stopPropagation()">
      <div style="font-weight:800;font-size:15px;margin-bottom:14px;color:var(--gw-ink,#0F1C14)">New Text Message</div>
      <label style="font-size:11px;font-weight:700;color:var(--gw-text-muted,#6F7E6A);text-transform:uppercase;display:block;margin-bottom:5px">To</label>
      <input id="sms-new-to" type="tel" list="sms-client-list" value="${esc(prefill && prefill.to || '')}" placeholder="Phone number or pick a client"
        style="width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid var(--gw-line,#DCE5E0);border-radius:8px;font-size:13px;margin-bottom:12px">
      <datalist id="sms-client-list">${clients.slice(0, 200).map(c => `<option value="${esc(c.phone)}">${esc(c.name)}</option>`).join('')}</datalist>
      <label style="font-size:11px;font-weight:700;color:var(--gw-text-muted,#6F7E6A);text-transform:uppercase;display:block;margin-bottom:5px">Message</label>
      <textarea id="sms-new-body" rows="4" placeholder="Type your message"
        style="width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid var(--gw-line,#DCE5E0);border-radius:8px;font-size:13px;resize:vertical;font-family:inherit">${esc(prefill && prefill.body || '')}</textarea>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px">
        <button class="rp-btn" style="font-size:11.5px" onclick="window._smsPickTemplate()">${icon('note', 12)} Template</button>
        <div style="display:flex;gap:8px">
          <button class="rp-btn" onclick="document.getElementById('sms-new-modal').remove()">Cancel</button>
          <button class="rp-btn rp-btn--primary" id="sms-new-send" onclick="window._smsNewSend()">${icon('send', 13)} Send</button>
        </div>
      </div>
    </div>`;
    overlay.onclick = () => overlay.remove();
    document.body.appendChild(overlay);
    document.getElementById('sms-new-to')?.focus();
  };
  window._smsNewSend = async function () {
    const to = (document.getElementById('sms-new-to') || {}).value || '';
    const bodyTxt = (document.getElementById('sms-new-body') || {}).value || '';
    const btn = document.getElementById('sms-new-send');
    if (!to.trim() || !bodyTxt.trim()) { if (typeof showToast === 'function') showToast('Phone number and message are required', 'error'); return; }
    const client = (typeof state !== 'undefined' && Array.isArray(state.clients))
      ? state.clients.find(c => String(c.phone || '').replace(/\D/g, '').slice(-10) === to.replace(/\D/g, '').slice(-10)) : null;
    if (btn) { btn.disabled = true; btn.textContent = 'Sending'; }
    try {
      const res = await API.send('/api/sms/send', 'POST', { to, body: bodyTxt, to_name: client ? client.name : '', client_id: client ? client.id : '' });
      document.getElementById('sms-new-modal')?.remove();
      if (typeof showToast === 'function') showToast('Message sent', 'success');
      if (S.tab === 'inbox' && document.getElementById('sms-conv-list')) {
        await refreshConversations();
        await openConversation(res.conversation_id);
      }
    } catch (e) {
      if (typeof showToast === 'function') showToast('Send failed: ' + e.message, 'error');
      if (btn) { btn.disabled = false; btn.innerHTML = icon('send', 13) + ' Send'; }
    }
  };

  // Public API for other modules (record pages, composer upgrade)
  window.smsCenter = smsCenter;
  window.gwSmsSend = async function (opts) {
    return API.send('/api/sms/send', 'POST', {
      to: opts.to, body: opts.body,
      to_name: opts.toName || '', client_id: opts.clientId || '', opp_id: opts.oppId || ''
    });
  };
  window.gwSmsStatus = async function () {
    try { return await API.get('/api/sms/status'); } catch (e) { return { configured: false }; }
  };
})();
