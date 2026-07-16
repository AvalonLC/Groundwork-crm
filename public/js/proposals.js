/* ═══════════════════════════════════════════════════════════════════════════
   GROUNDWORK — PROPOSALS MODULE
   Internal proposal maker: high-level, clean client-facing documents tied to a
   lead (and optionally an estimate). Mirrors the Avalon PDF layout:
   header meta (PREPARED FOR / PROPOSAL DATE / PROPERTY / VALID THROUGH),
   OVERVIEW block, then OPTION tables (APPLICATION | INCLUDED SERVICE | PRICE).
   Supports reusable templates with quick-fill, custom payment schedules,
   portal links, and Gmail sending.
   Server API: /api/proposals CRUD · /api/proposal-templates · portal page at
   /portal/proposal/:token
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

// ── Utilities ─────────────────────────────────────────────────────────────────

function _prEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function _prFmt(n) {
  return '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function _prToast(msg, type) { if (typeof showToast === 'function') showToast(msg, type || 'info'); }
function _prState() {
  return window._avalonState || (typeof state !== 'undefined' ? state : null);
}
function _prStatusPill(status) {
  const map = {
    draft:    ['Draft', '#8A948C', '#F0EEE8'],
    sent:     ['Sent', '#2D6CA8', '#E7F0F9'],
    viewed:   ['Viewed', '#8A6D1F', '#F7F0DC'],
    accepted: ['Accepted', '#1E5E3E', '#E5F2E9'],
    declined: ['Declined', '#8B4432', '#F7E8E3'],
  };
  const [label, fg, bg] = map[status] || map.draft;
  return `<span style="display:inline-block;font-size:11px;font-weight:700;letter-spacing:.04em;padding:3px 9px;border-radius:99px;color:${fg};background:${bg}">${label}</span>`;
}

// ── In-memory draft ───────────────────────────────────────────────────────────

let _prDraft = null;
let _prTemplates = [];
let _prLinkableEstimates = [];

function _prBlankDraft() {
  return {
    id: null, prop_number: '',
    title: '', subtitle: '', overview: '',
    client_id: '', client_name: '', client_email: '', client_phone: '', property_addr: '',
    opp_id: '', estimate_id: '',
    status: 'draft',
    sections: [],
    payment_schedule: [],
    total: 0,
    terms: '', internal_notes: '',
    proposal_date: new Date().toISOString().slice(0, 10),
    valid_through: '',
    portal_token: '',
  };
}

// ── LIST PAGE ─────────────────────────────────────────────────────────────────

async function proposals() {
  const view = document.getElementById('view');
  if (!view) return;
  view.innerHTML = `
  <div style="max-width:1080px;margin:0 auto;padding:22px 18px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;flex-wrap:wrap;gap:10px">
      <div>
        <h1 style="font-size:22px;font-weight:800;margin:0">Proposals</h1>
        <span id="pr-list-sub" style="font-size:12.5px;color:var(--gw-text-subtle,#8A948C)">Loading…</span>
      </div>
      <button class="est-btn-primary" onclick="proposalBuilder()">+ New Proposal</button>
    </div>
    <div id="pr-list-body"><div style="padding:40px;text-align:center;color:var(--gw-text-subtle,#8A948C)">Loading proposals…</div></div>
  </div>`;

  try {
    const r = await fetch('/api/proposals', { credentials: 'include' });
    const j = await r.json();
    const rows = j.data || [];
    const sub = document.getElementById('pr-list-sub');
    if (sub) sub.textContent = rows.length + ' proposal' + (rows.length !== 1 ? 's' : '');
    const body = document.getElementById('pr-list-body');
    if (!body) return;
    if (!rows.length) {
      body.innerHTML = `
      <div style="background:var(--gw-surface,#fff);border:1px dashed var(--gw-border,#DDD8CE);border-radius:14px;padding:48px 24px;text-align:center">
        <div style="font-size:15px;font-weight:700;margin-bottom:6px">No proposals yet</div>
        <div style="font-size:13px;color:var(--gw-text-subtle,#8A948C);margin-bottom:16px">Create polished, high-level proposals for your leads — or start one right from a lead's Quick Actions bar.</div>
        <button class="est-btn-primary" onclick="proposalBuilder()">Create your first proposal</button>
      </div>`;
      return;
    }
    body.innerHTML = `
    <div style="background:var(--gw-surface,#fff);border:1px solid var(--gw-border,#E4E0D6);border-radius:14px;overflow:hidden">
      ${rows.map(p => `
      <div onclick="proposalBuilder('${_prEsc(p.id)}')" style="display:flex;align-items:center;gap:14px;padding:14px 18px;border-bottom:1px solid var(--gw-border-soft,#F0EEE8);cursor:pointer" onmouseover="this.style.background='var(--gw-bg,#FAF9F5)'" onmouseout="this.style.background=''">
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_prEsc(p.title || 'Untitled Proposal')}</div>
          <div style="font-size:12px;color:var(--gw-text-subtle,#8A948C)">${_prEsc(p.prop_number)} · ${_prEsc(p.client_name || 'No client')}${p.total ? ' · ' + _prFmt(p.total) : ''}</div>
        </div>
        ${_prStatusPill(p.status)}
        <span style="font-size:11.5px;color:var(--gw-text-subtle,#8A948C);white-space:nowrap">${_prEsc((p.updated_at || '').slice(0, 10))}</span>
      </div>`).join('')}
    </div>`;
  } catch (e) {
    console.error('[proposals list]', e);
    const body = document.getElementById('pr-list-body');
    if (body) body.innerHTML = '<div style="padding:30px;text-align:center;color:#B4482E">Failed to load proposals.</div>';
  }
}

// ── ENTRY FROM LEAD ───────────────────────────────────────────────────────────

async function proposalBuilderForLead(oppId) {
  const st = _prState();
  const o = ((st && st.opportunities) || []).find(x => x.id === oppId);
  await proposalBuilder(null, o ? {
    opp_id: o.id,
    client_id: o.clientId || '',
    client_name: o.client || '',
    client_email: o.email || '',
    client_phone: o.phone || '',
    property_addr: o.address || '',
    title: (o.project || o.serviceLine) ? `${o.project || o.serviceLine} Proposal` : (o.client ? `Proposal for ${o.client}` : ''),
  } : null);
  if (o) _prToast(`New proposal started for ${o.client || 'lead'} — linked to this lead`, 'success');
}

// ── BUILDER ───────────────────────────────────────────────────────────────────

async function proposalBuilder(id, prefill) {
  const view = document.getElementById('view');
  if (!view) return;
  view.innerHTML = '<div style="padding:60px;text-align:center;color:var(--gw-text-subtle,#8A948C)">Loading proposal builder…</div>';

  _prDraft = _prBlankDraft();

  if (id) {
    try {
      const r = await fetch(`/api/proposals/${id}`, { credentials: 'include' });
      if (r.ok) { const j = await r.json(); if (j.data) _prDraft = Object.assign(_prBlankDraft(), j.data); }
    } catch (e) { console.warn('[proposalBuilder] fetch', e); }
  } else if (prefill) {
    Object.assign(_prDraft, prefill);
  }
  if (!Array.isArray(_prDraft.sections)) _prDraft.sections = [];
  if (!Array.isArray(_prDraft.payment_schedule)) _prDraft.payment_schedule = [];

  // Load templates + linkable estimates in parallel (non-blocking failures)
  _prTemplates = []; _prLinkableEstimates = [];
  const loads = [
    fetch('/api/proposal-templates', { credentials: 'include' }).then(r => r.json()).then(j => { _prTemplates = j.data || []; }).catch(() => {}),
  ];
  if (_prDraft.opp_id) {
    loads.push(fetch(`/api/estimates?opp_id=${encodeURIComponent(_prDraft.opp_id)}`, { credentials: 'include' }).then(r => r.json()).then(j => { _prLinkableEstimates = j.data || []; }).catch(() => {}));
  }
  await Promise.all(loads);

  _prRenderBuilder();
}

function _prRenderBuilder() {
  const view = document.getElementById('view');
  if (!view) return;
  const p = _prDraft;
  const isEdit = !!p.id;

  view.innerHTML = `
  <div style="max-width:1120px;margin:0 auto;padding:20px 18px 60px;display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:22px" id="pr-builder-shell">
    <div style="min-width:0">

      <!-- Top nav -->
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
        <button class="est-btn-secondary" style="font-size:12.5px;padding:7px 12px" onclick="${p.opp_id ? `(window.show?show('pipeline','${_prEsc(p.opp_id)}'):proposals())` : 'proposals()'}">‹ ${p.opp_id ? 'Back to Lead' : 'Proposals'}</button>
        <div style="font-size:17px;font-weight:800">${isEdit ? `Edit ${_prEsc(p.prop_number || 'Proposal')}` : 'New Proposal'}</div>
        ${_prStatusPill(p.status)}
        <span id="pr-save-state" style="margin-left:auto;font-size:12px;color:var(--gw-text-subtle,#8A948C)"></span>
      </div>

      <!-- AI draft -->
      <section style="background:linear-gradient(135deg,#113931 0%,#1E5E52 100%);border-radius:12px;padding:16px 18px;margin-bottom:16px;color:#fff">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <div>
            <div style="font-size:13px;font-weight:800">✨ Draft with AI</div>
            <div style="font-size:11.5px;opacity:.85">Writes the whole proposal — overview, option tables with pricing, payment schedule &amp; terms — from ${p.opp_id ? "this lead's notes and history" : 'your instructions'}. You review and edit everything before sending.</div>
          </div>
          <button id="pr-ai-btn" style="background:#fff;color:#113931;border:none;border-radius:8px;padding:9px 16px;font-size:13px;font-weight:800;cursor:pointer;white-space:nowrap" onclick="_prAiModal()">Draft it for me</button>
        </div>
      </section>

      <!-- Templates quick-fill -->
      <section style="background:var(--gw-surface,#fff);border:1px solid var(--gw-border,#E4E0D6);border-radius:12px;padding:16px 18px;margin-bottom:16px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
          <div>
            <div style="font-size:13px;font-weight:800">Templates</div>
            <div style="font-size:11.5px;color:var(--gw-text-subtle,#8A948C)">Quick-fill the whole proposal from a saved template, or save this one for reuse.</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <select id="pr-template-select" class="est-input" style="font-size:12.5px;min-width:180px">
              <option value="">${_prTemplates.length ? 'Choose a template…' : 'No templates saved yet'}</option>
              ${_prTemplates.map(t => `<option value="${_prEsc(t.id)}">${_prEsc(t.name)}</option>`).join('')}
            </select>
            <button class="est-btn-secondary" style="font-size:12px;padding:7px 11px" onclick="_prApplyTemplate()">Apply</button>
            <button class="est-btn-secondary" style="font-size:12px;padding:7px 11px" onclick="_prSaveAsTemplate()">Save as template</button>
            ${_prTemplates.length ? `<button style="border:none;background:transparent;font-size:11.5px;color:#B4482E;cursor:pointer;text-decoration:underline" onclick="_prDeleteTemplate()">Delete selected</button>` : ''}
          </div>
        </div>
      </section>

      <!-- Header / client -->
      <section style="background:var(--gw-surface,#fff);border:1px solid var(--gw-border,#E4E0D6);border-radius:12px;padding:18px;margin-bottom:16px">
        <div style="font-size:13px;font-weight:800;margin-bottom:12px">1 · Header &amp; Client</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div style="grid-column:1/-1">
            <label class="est-label">Proposal Title</label>
            <input class="est-input" id="pr-title" value="${_prEsc(p.title)}" placeholder="e.g. Turf Care Program — 2026 Season" oninput="_prDraft.title=this.value">
          </div>
          <div style="grid-column:1/-1">
            <label class="est-label">Subtitle <span style="font-weight:400;color:var(--gw-text-subtle,#8A948C)">(optional)</span></label>
            <input class="est-input" id="pr-subtitle" value="${_prEsc(p.subtitle)}" placeholder="e.g. Prepared exclusively for the Carney Residence" oninput="_prDraft.subtitle=this.value">
          </div>
          <div>
            <label class="est-label">Prepared For (Client) *</label>
            <input class="est-input" id="pr-client-name" value="${_prEsc(p.client_name)}" placeholder="Client name" oninput="_prDraft.client_name=this.value">
          </div>
          <div>
            <label class="est-label">Client Email</label>
            <input class="est-input" id="pr-client-email" type="email" value="${_prEsc(p.client_email)}" placeholder="client@email.com" oninput="_prDraft.client_email=this.value">
          </div>
          <div>
            <label class="est-label">Property Address</label>
            <input class="est-input" id="pr-property" value="${_prEsc(p.property_addr)}" placeholder="123 Main St" oninput="_prDraft.property_addr=this.value">
          </div>
          <div>
            <label class="est-label">Client Phone</label>
            <input class="est-input" id="pr-client-phone" value="${_prEsc(p.client_phone)}" placeholder="(555) 555-5555" oninput="_prDraft.client_phone=this.value">
          </div>
          <div>
            <label class="est-label">Proposal Date</label>
            <input class="est-input" id="pr-date" type="date" value="${_prEsc(p.proposal_date)}" oninput="_prDraft.proposal_date=this.value">
          </div>
          <div>
            <label class="est-label">Valid Through</label>
            <input class="est-input" id="pr-valid" type="date" value="${_prEsc(p.valid_through)}" oninput="_prDraft.valid_through=this.value">
          </div>
        </div>
      </section>

      <!-- Overview -->
      <section style="background:var(--gw-surface,#fff);border:1px solid var(--gw-border,#E4E0D6);border-radius:12px;padding:18px;margin-bottom:16px">
        <div style="font-size:13px;font-weight:800;margin-bottom:4px">2 · Overview</div>
        <div style="font-size:11.5px;color:var(--gw-text-subtle,#8A948C);margin-bottom:10px">The high-level pitch the client reads first — what you observed, what you recommend, and why.</div>
        <textarea class="est-input" id="pr-overview" rows="5" placeholder="Thank you for the opportunity to care for your property. Based on our walkthrough…" oninput="_prDraft.overview=this.value" style="resize:vertical">${_prEsc(p.overview)}</textarea>
      </section>

      <!-- Sections -->
      <section style="background:var(--gw-surface,#fff);border:1px solid var(--gw-border,#E4E0D6);border-radius:12px;padding:18px;margin-bottom:16px">
        <div style="font-size:13px;font-weight:800;margin-bottom:4px">3 · Program Options &amp; Content</div>
        <div style="font-size:11.5px;color:var(--gw-text-subtle,#8A948C);margin-bottom:12px">Option tables render like your PDF: APPLICATION · INCLUDED SERVICE · PRICE. Add text blocks for narrative sections.</div>
        <div id="pr-sections">${_prSectionsHtml()}</div>
        <div style="display:flex;gap:10px;margin-top:12px">
          <button class="est-btn-secondary" style="font-size:12.5px;padding:8px 13px" onclick="_prAddSection('option')">+ Option table</button>
          <button class="est-btn-secondary" style="font-size:12.5px;padding:8px 13px" onclick="_prAddSection('text')">+ Text block</button>
        </div>
      </section>

      <!-- Payment schedule -->
      <section style="background:var(--gw-surface,#fff);border:1px solid var(--gw-border,#E4E0D6);border-radius:12px;padding:18px;margin-bottom:16px">
        <div style="font-size:13px;font-weight:800;margin-bottom:4px">4 · Payment Schedule <span style="font-weight:500;color:var(--gw-text-subtle,#8A948C)">(optional)</span></div>
        <div style="font-size:11.5px;color:var(--gw-text-subtle,#8A948C);margin-bottom:12px">Any number of payments — percentages must total 100%.</div>
        <div id="pr-paysched">${_prPaySchedHtml()}</div>
      </section>

      <!-- Terms + internal notes -->
      <section style="background:var(--gw-surface,#fff);border:1px solid var(--gw-border,#E4E0D6);border-radius:12px;padding:18px;margin-bottom:16px">
        <div style="font-size:13px;font-weight:800;margin-bottom:10px">5 · Terms &amp; Notes</div>
        <label class="est-label">Terms (shown to client)</label>
        <textarea class="est-input" rows="3" style="resize:vertical;margin-bottom:12px" placeholder="Pricing valid through the date above. Applications weather-dependent…" oninput="_prDraft.terms=this.value">${_prEsc(p.terms)}</textarea>
        <label class="est-label">Internal Notes (never shown to client)</label>
        <textarea class="est-input" rows="2" style="resize:vertical" oninput="_prDraft.internal_notes=this.value">${_prEsc(p.internal_notes)}</textarea>
      </section>

      <!-- Action bar -->
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <button class="est-btn-primary" onclick="_prSave('save')">${isEdit ? 'Update Proposal' : 'Create Proposal'}</button>
        <button class="est-btn-secondary" onclick="_prSave('draft')">Save Draft</button>
        ${p.portal_token ? `
        <button class="est-btn-secondary" onclick="_prCopyPortalLink()">Copy client link</button>
        <button class="est-btn-secondary" onclick="_prPreview()">Preview</button>
        <button class="est-btn-secondary" style="background:var(--gw-teal,#4D8A86);color:#fff;border-color:transparent" onclick="_prSendModal()">Send to client…</button>` : `
        <span style="font-size:11.5px;color:var(--gw-text-subtle,#8A948C)">Save first to unlock preview, client link &amp; sending.</span>`}
        ${isEdit ? `<button style="margin-left:auto;border:none;background:transparent;font-size:12px;color:#B4482E;cursor:pointer;text-decoration:underline" onclick="_prDelete()">Delete proposal</button>` : ''}
      </div>
    </div>

    <!-- Right rail -->
    <aside>
      <div style="background:var(--gw-surface,#fff);border:1px solid var(--gw-border,#E4E0D6);border-radius:12px;padding:16px;position:sticky;top:16px">
        <div style="font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--gw-text-subtle,#8A948C);margin-bottom:10px">Summary</div>
        <div id="pr-rail-summary">${_prRailHtml()}</div>
        <div style="border-top:1px solid var(--gw-border-soft,#F0EEE8);margin:14px 0;padding-top:14px">
          <div style="font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--gw-text-subtle,#8A948C);margin-bottom:8px">Linked Estimate</div>
          ${_prDraft.opp_id ? `
          <select class="est-input" id="pr-estimate-link" style="font-size:12.5px" onchange="_prDraft.estimate_id=this.value;_prRailRefresh()">
            <option value="">Not linked</option>
            ${_prLinkableEstimates.map(e => `<option value="${_prEsc(e.id)}" ${p.estimate_id === e.id ? 'selected' : ''}>${_prEsc(e.est_number)} — ${_prFmt(e.total)}</option>`).join('')}
          </select>
          ${!_prLinkableEstimates.length ? `<div style="font-size:11.5px;color:var(--gw-text-subtle,#8A948C);margin-top:6px">No estimates on this lead yet. <a href="#" onclick="event.preventDefault();estimateBuilderForLead&&estimateBuilderForLead('${_prEsc(p.opp_id)}')" style="color:var(--gw-teal,#4D8A86)">Create one</a></div>` : ''}` : `
          <div style="font-size:11.5px;color:var(--gw-text-subtle,#8A948C)">Open a proposal from a lead to link its estimates.</div>`}
        </div>
      </div>
    </aside>
  </div>`;
}

// ── SECTIONS EDITOR ───────────────────────────────────────────────────────────

function _prSectionsHtml() {
  const secs = (_prDraft && _prDraft.sections) || [];
  if (!secs.length) {
    return `<div style="border:1px dashed var(--gw-border,#DDD8CE);border-radius:10px;padding:22px;text-align:center;font-size:12.5px;color:var(--gw-text-subtle,#8A948C)">No sections yet — add an option table or text block below.</div>`;
  }
  return secs.map((s, si) => {
    const head = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span style="font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#fff;background:${s.type === 'option' ? 'var(--gw-teal,#4D8A86)' : '#8A948C'};padding:3px 8px;border-radius:5px">${s.type === 'option' ? 'Option Table' : 'Text Block'}</span>
        <input class="est-input" style="flex:1;font-weight:700" value="${_prEsc(s.title || '')}" placeholder="${s.type === 'option' ? 'e.g. OPTION 1: Standard 5-Application Program' : 'Section title'}" oninput="_prDraft.sections[${si}].title=this.value">
        <button title="Move up" style="border:none;background:transparent;cursor:pointer;font-size:14px;color:var(--gw-text-subtle,#8A948C)" onclick="_prMoveSection(${si},-1)">↑</button>
        <button title="Move down" style="border:none;background:transparent;cursor:pointer;font-size:14px;color:var(--gw-text-subtle,#8A948C)" onclick="_prMoveSection(${si},1)">↓</button>
        <button title="Remove section" style="border:none;background:transparent;cursor:pointer;font-size:16px;color:#B4482E" onclick="_prRemoveSection(${si})">×</button>
      </div>`;

    if (s.type === 'text') {
      return `
      <div style="border:1px solid var(--gw-border,#E4E0D6);border-radius:10px;padding:14px;margin-bottom:12px">
        ${head}
        <textarea class="est-input" rows="4" style="resize:vertical" placeholder="Section content…" oninput="_prDraft.sections[${si}].body=this.value">${_prEsc(s.body || '')}</textarea>
      </div>`;
    }

    // option table
    const rows = Array.isArray(s.rows) ? s.rows : (s.rows = []);
    const subtotal = rows.reduce((t, r) => t + (Number(r.price) || 0), 0);
    return `
    <div style="border:1px solid var(--gw-border,#E4E0D6);border-radius:10px;padding:14px;margin-bottom:12px">
      ${head}
      <input class="est-input" style="margin-bottom:10px;font-size:12.5px" value="${_prEsc(s.goal || '')}" placeholder="Program goal (optional) — e.g. Maintain healthy turf with balanced fertilization" oninput="_prDraft.sections[${si}].goal=this.value">
      <div style="display:grid;grid-template-columns:1fr 1.4fr 110px 26px;gap:6px;margin-bottom:6px">
        <span style="font-size:10.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--gw-text-subtle,#8A948C)">Application</span>
        <span style="font-size:10.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--gw-text-subtle,#8A948C)">Included Service</span>
        <span style="font-size:10.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--gw-text-subtle,#8A948C);text-align:right">Price</span>
        <span></span>
      </div>
      ${rows.map((r, ri) => `
      <div style="display:grid;grid-template-columns:1fr 1.4fr 110px 26px;gap:6px;margin-bottom:6px;align-items:start">
        <input class="est-input" style="font-size:12.5px" value="${_prEsc(r.app || '')}" placeholder="Round 1 — Early Spring" oninput="_prDraft.sections[${si}].rows[${ri}].app=this.value">
        <input class="est-input" style="font-size:12.5px" value="${_prEsc(r.service || '')}" placeholder="Pre-emergent + balanced fertilizer" oninput="_prDraft.sections[${si}].rows[${ri}].service=this.value">
        <input class="est-input" type="number" min="0" step="0.01" style="font-size:12.5px;text-align:right" value="${r.price != null && r.price !== '' ? r.price : ''}" placeholder="0.00" oninput="_prDraft.sections[${si}].rows[${ri}].price=parseFloat(this.value)||0;_prOptionSubtotalRefresh(${si})">
        <button title="Remove row" style="border:none;background:transparent;cursor:pointer;font-size:15px;color:#B4482E;padding-top:6px" onclick="_prRemoveRow(${si},${ri})">×</button>
      </div>`).join('')}
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px">
        <button class="est-btn-secondary" style="font-size:12px;padding:6px 11px" onclick="_prAddRow(${si})">+ Add row</button>
        <span id="pr-opt-subtotal-${si}" style="font-size:12.5px;font-weight:800;font-variant-numeric:tabular-nums">Option total: ${_prFmt(subtotal)}</span>
      </div>
      <input class="est-input" style="margin-top:10px;font-size:12px" value="${_prEsc(s.footnote || '')}" placeholder="Footnote (optional) — e.g. *Prices include all materials and labor" oninput="_prDraft.sections[${si}].footnote=this.value">
    </div>`;
  }).join('');
}

function _prSectionsRefresh() {
  const el = document.getElementById('pr-sections');
  if (el) el.innerHTML = _prSectionsHtml();
  _prRailRefresh();
}
function _prAddSection(type) {
  if (!_prDraft) return;
  if (type === 'option') {
    const n = _prDraft.sections.filter(s => s.type === 'option').length + 1;
    _prDraft.sections.push({ type: 'option', title: `OPTION ${n}: `, goal: '', rows: [{ app: '', service: '', price: 0 }], footnote: '' });
  } else {
    _prDraft.sections.push({ type: 'text', title: '', body: '' });
  }
  _prSectionsRefresh();
}
function _prRemoveSection(si) {
  if (!_prDraft) return;
  _prDraft.sections.splice(si, 1);
  _prSectionsRefresh();
}
function _prMoveSection(si, dir) {
  const secs = _prDraft.sections;
  const j = si + dir;
  if (j < 0 || j >= secs.length) return;
  [secs[si], secs[j]] = [secs[j], secs[si]];
  _prSectionsRefresh();
}
function _prAddRow(si) {
  const s = _prDraft.sections[si];
  if (!s) return;
  if (!Array.isArray(s.rows)) s.rows = [];
  s.rows.push({ app: '', service: '', price: 0 });
  _prSectionsRefresh();
}
function _prRemoveRow(si, ri) {
  const s = _prDraft.sections[si];
  if (!s || !Array.isArray(s.rows)) return;
  s.rows.splice(ri, 1);
  _prSectionsRefresh();
}
function _prOptionSubtotalRefresh(si) {
  const s = _prDraft.sections[si];
  if (!s) return;
  const subtotal = (s.rows || []).reduce((t, r) => t + (Number(r.price) || 0), 0);
  const el = document.getElementById('pr-opt-subtotal-' + si);
  if (el) el.textContent = 'Option total: ' + _prFmt(subtotal);
  _prRailRefresh();
}

// ── PROPOSAL TOTAL + RAIL ─────────────────────────────────────────────────────

function _prComputeTotal() {
  // Sum of the largest-option OR sum of all options? Use: sum of ALL option
  // tables when exactly one, else the highest option (client picks one).
  const opts = (_prDraft.sections || []).filter(s => s.type === 'option')
    .map(s => (s.rows || []).reduce((t, r) => t + (Number(r.price) || 0), 0));
  if (!opts.length) return 0;
  return opts.length === 1 ? opts[0] : Math.max(...opts);
}

function _prRailHtml() {
  const p = _prDraft;
  const opts = (p.sections || []).filter(s => s.type === 'option');
  const total = _prComputeTotal();
  p.total = total;
  const sched = p.payment_schedule || [];
  return `
    <div style="font-size:13px;font-weight:700;margin-bottom:2px">${_prEsc(p.client_name || 'No client set')}</div>
    ${p.property_addr ? `<div style="font-size:11.5px;color:var(--gw-text-subtle,#8A948C);margin-bottom:8px">${_prEsc(p.property_addr)}</div>` : '<div style="margin-bottom:8px"></div>'}
    <div style="display:flex;justify-content:space-between;font-size:12.5px;padding:4px 0"><span>Sections</span><strong>${(p.sections || []).length}</strong></div>
    <div style="display:flex;justify-content:space-between;font-size:12.5px;padding:4px 0"><span>Options offered</span><strong>${opts.length}</strong></div>
    <div style="display:flex;justify-content:space-between;font-size:14px;padding:8px 0;border-top:1px solid var(--gw-border-soft,#F0EEE8);margin-top:6px"><span style="font-weight:700">${opts.length > 1 ? 'Top option value' : 'Proposal value'}</span><strong>${_prFmt(total)}</strong></div>
    ${sched.length ? sched.map(s2 => `<div style="display:flex;justify-content:space-between;font-size:11.5px;color:var(--gw-text-subtle,#6F7E6A);padding:2px 0"><span>${_prEsc(s2.label || 'Payment')}</span><span>${Number(s2.pct) || 0}%${total ? ' · ' + _prFmt(total * (Number(s2.pct) || 0) / 100) : ''}</span></div>`).join('') : ''}
    ${p.portal_token ? `<div style="margin-top:10px;font-size:11px;color:var(--gw-text-subtle,#8A948C);word-break:break-all">Client link ready ✓</div>` : ''}`;
}
function _prRailRefresh() {
  const el = document.getElementById('pr-rail-summary');
  if (el) el.innerHTML = _prRailHtml();
}

// ── PAYMENT SCHEDULE (proposal) ───────────────────────────────────────────────

function _prPaySchedHtml() {
  const sched = (_prDraft && _prDraft.payment_schedule) || [];
  const total = _prComputeTotal();
  const sum = sched.reduce((s, p) => s + (Number(p.pct) || 0), 0);
  const ok = Math.abs(sum - 100) <= 0.01;
  return `
    <div style="display:flex;justify-content:flex-end;margin-bottom:8px">
      <span id="pr-paysched-sum" style="font-size:12.5px;font-weight:800;color:${sched.length === 0 ? 'var(--gw-text-subtle,#8A948C)' : (ok ? '#1E5E3E' : '#B4482E')};font-variant-numeric:tabular-nums">${sched.length ? sum.toFixed(sum % 1 ? 1 : 0) + '% / 100%' + (ok ? ' ✓' : '') : 'No schedule set'}</span>
    </div>
    ${sched.map((p, i) => `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
      <input class="est-input" type="text" style="flex:1;font-size:12.5px" placeholder="Payment ${i + 1} label" value="${_prEsc(p.label || '')}" oninput="_prDraft.payment_schedule[${i}].label=this.value">
      <div style="position:relative;width:100px;flex:none">
        <input class="est-input" type="number" min="0" max="100" step="0.1" style="width:100%;font-size:12.5px;padding-right:24px" value="${p.pct != null ? p.pct : ''}" oninput="_prDraft.payment_schedule[${i}].pct=parseFloat(this.value)||0;_prPaySchedSumRefresh()">
        <span style="position:absolute;right:9px;top:50%;transform:translateY(-50%);font-size:12px;color:var(--gw-text-subtle,#8A948C);pointer-events:none">%</span>
      </div>
      <span style="width:88px;flex:none;text-align:right;font-size:12px;color:var(--gw-text-subtle,#6F7E6A);font-variant-numeric:tabular-nums">${total > 0 ? _prFmt(total * (Number(p.pct) || 0) / 100) : '—'}</span>
      <button style="border:none;background:transparent;color:#B4482E;cursor:pointer;font-size:16px;padding:4px" onclick="_prDraft.payment_schedule.splice(${i},1);_prPaySchedRefresh()">×</button>
    </div>`).join('')}
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="est-btn-secondary" style="font-size:12px;padding:7px 12px" onclick="_prPaySchedAdd()">+ Add payment</button>
      ${!sched.length ? `
      <button style="border:1px dashed var(--gw-border,#CFC9BC);background:transparent;border-radius:8px;font-size:12px;padding:7px 12px;cursor:pointer;color:var(--gw-text-subtle,#5A675F)" onclick="_prDraft.payment_schedule=[{label:'Deposit',pct:50},{label:'On completion',pct:50}];_prPaySchedRefresh()">50 / 50</button>
      <button style="border:1px dashed var(--gw-border,#CFC9BC);background:transparent;border-radius:8px;font-size:12px;padding:7px 12px;cursor:pointer;color:var(--gw-text-subtle,#5A675F)" onclick="_prDraft.payment_schedule=[{label:'Deposit',pct:34},{label:'Mid-program',pct:33},{label:'Final payment',pct:33}];_prPaySchedRefresh()">Thirds</button>` : `
      <button style="border:none;background:transparent;font-size:12px;cursor:pointer;color:#B4482E;text-decoration:underline" onclick="_prDraft.payment_schedule=[];_prPaySchedRefresh()">Clear</button>`}
    </div>`;
}
function _prPaySchedRefresh() {
  const el = document.getElementById('pr-paysched');
  if (el) el.innerHTML = _prPaySchedHtml();
  _prRailRefresh();
}
function _prPaySchedSumRefresh() {
  const sched = _prDraft.payment_schedule || [];
  const sum = sched.reduce((s, p) => s + (Number(p.pct) || 0), 0);
  const ok = Math.abs(sum - 100) <= 0.01;
  const el = document.getElementById('pr-paysched-sum');
  if (el) { el.textContent = sum.toFixed(sum % 1 ? 1 : 0) + '% / 100%' + (ok ? ' ✓' : ''); el.style.color = ok ? '#1E5E3E' : '#B4482E'; }
  _prRailRefresh();
}
function _prPaySchedAdd() {
  const sched = _prDraft.payment_schedule;
  const sum = sched.reduce((s, p) => s + (Number(p.pct) || 0), 0);
  sched.push({ label: '', pct: Math.max(0, Math.round((100 - sum) * 10) / 10) });
  _prPaySchedRefresh();
}

// ── SAVE / DELETE ─────────────────────────────────────────────────────────────

async function _prSave(action) {
  if (!_prDraft) return;
  const p = _prDraft;

  if (!(p.client_name || '').trim()) { _prToast('Client name is required', 'error'); return; }

  // Validate payment schedule
  const sched = (p.payment_schedule || []).filter(s => (s.label || '').trim() || Number(s.pct));
  if (sched.length) {
    const sum = sched.reduce((s, x) => s + (Number(x.pct) || 0), 0);
    if (Math.abs(sum - 100) > 0.01) { _prToast(`Payment schedule must total 100% (currently ${sum.toFixed(1)}%)`, 'error'); return; }
  }
  p.payment_schedule = sched;
  p.total = _prComputeTotal();

  const saveEl = document.getElementById('pr-save-state');
  if (saveEl) saveEl.textContent = 'Saving…';

  const isEdit = !!p.id;
  try {
    const r = await fetch(isEdit ? `/api/proposals/${p.id}` : '/api/proposals', {
      method: isEdit ? 'PUT' : 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || 'Save failed');
    if (!isEdit && j.data) {
      p.id = j.data.id;
      p.prop_number = j.data.prop_number;
      p.portal_token = j.data.portal_token;
    }
    if (saveEl) { saveEl.textContent = 'Saved ✓'; setTimeout(() => { if (saveEl) saveEl.textContent = ''; }, 3000); }
    _prToast(isEdit ? 'Proposal updated' : `Proposal ${p.prop_number} created`, 'success');
    if (action === 'save') _prRenderBuilder(); // re-render to unlock send/link buttons
  } catch (e) {
    console.error('[_prSave]', e);
    if (saveEl) saveEl.textContent = 'Save failed';
    _prToast(e.message || 'Failed to save proposal', 'error');
  }
}

async function _prDelete() {
  if (!_prDraft?.id) return;
  if (!confirm('Delete this proposal? This cannot be undone.')) return;
  try {
    await fetch(`/api/proposals/${_prDraft.id}`, { method: 'DELETE', credentials: 'include' });
    _prToast('Proposal deleted', 'success');
    proposals();
  } catch (e) { _prToast('Failed to delete', 'error'); }
}

// ── PORTAL LINK / PREVIEW ─────────────────────────────────────────────────────

function _prPortalUrl() {
  return _prDraft?.portal_token ? `${location.origin}/portal/proposal/${_prDraft.portal_token}` : '';
}
function _prCopyPortalLink() {
  const url = _prPortalUrl();
  if (!url) { _prToast('Save the proposal first', 'error'); return; }
  (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(
    () => _prToast('Client link copied to clipboard', 'success'),
    () => { prompt('Copy this link:', url); }
  );
}
function _prPreview() {
  const url = _prPortalUrl();
  if (url) window.open(url, '_blank');
}

// ── SEND (Gmail if connected, mailto fallback) ────────────────────────────────

function _prSendModal() {
  const p = _prDraft;
  if (!p?.portal_token) { _prToast('Save the proposal first', 'error'); return; }
  document.getElementById('pr-send-modal')?.remove();
  const gmailOk = typeof isGoogleConnected === 'function' && isGoogleConnected();
  const defBody = `Hi ${(p.client_name || '').split(' ')[0] || 'there'},\n\nThank you for the opportunity! Your proposal${p.title ? ` — ${p.title}` : ''} is ready to review here:\n\n${_prPortalUrl()}\n\nYou can accept it right from that page. Let me know if you have any questions!\n\nBest,\n${(window.getCurrentRep ? (window.getCurrentRep()?.name || '') : '')}`;
  const wrap = document.createElement('div');
  wrap.id = 'pr-send-modal';
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(20,28,26,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
  wrap.innerHTML = `
  <div style="background:#fff;border-radius:14px;max-width:520px;width:100%;padding:22px;box-shadow:0 24px 64px rgba(0,0,0,.25)" onclick="event.stopPropagation()">
    <div style="font-size:16px;font-weight:800;margin-bottom:4px">Send proposal to client</div>
    <div style="font-size:12px;color:var(--gw-text-subtle,#8A948C);margin-bottom:14px">${gmailOk ? 'Sends from your connected Gmail and logs to the lead.' : 'Gmail not connected — this will open your email app instead.'}</div>
    <label class="est-label">To</label>
    <input class="est-input" id="pr-send-to" type="email" value="${_prEsc(p.client_email || '')}" placeholder="client@email.com" style="margin-bottom:10px">
    <label class="est-label">Subject</label>
    <input class="est-input" id="pr-send-subject" value="${_prEsc(p.title ? `Your Proposal — ${p.title}` : 'Your Proposal')}" style="margin-bottom:10px">
    <label class="est-label">Message</label>
    <textarea class="est-input" id="pr-send-body" rows="8" style="resize:vertical;margin-bottom:16px">${_prEsc(defBody)}</textarea>
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button class="est-btn-secondary" onclick="document.getElementById('pr-send-modal').remove()">Cancel</button>
      <button class="est-btn-primary" onclick="_prDoSend()">${gmailOk ? 'Send via Gmail' : 'Open in email app'}</button>
    </div>
  </div>`;
  wrap.addEventListener('click', () => wrap.remove());
  document.body.appendChild(wrap);
}

async function _prDoSend() {
  const p = _prDraft;
  const to = document.getElementById('pr-send-to')?.value?.trim();
  const subject = document.getElementById('pr-send-subject')?.value || 'Your Proposal';
  const body = document.getElementById('pr-send-body')?.value || _prPortalUrl();
  if (!to) { _prToast('Enter the client email', 'error'); return; }

  const gmailOk = typeof isGoogleConnected === 'function' && isGoogleConnected() && typeof gmailSendEmail === 'function';
  let sentViaGmail = false;
  try {
    if (gmailOk) {
      await gmailSendEmail({ to, subject, body });
      sentViaGmail = true;
    } else {
      window.location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    }
  } catch (e) {
    console.error('[_prDoSend]', e);
    _prToast('Gmail send failed — opening email app instead', 'error');
    window.location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  // Mark as sent + log to lead comms
  try {
    p.status = p.status === 'draft' ? 'sent' : p.status;
    await fetch(`/api/proposals/${p.id}`, {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, p, { status: 'sent' })),
    });
    p.status = 'sent';
  } catch (e) {}

  if (p.opp_id) {
    try {
      const st = _prState();
      if (st) {
        if (!st.communications) st.communications = [];
        st.communications.push({
          id: 'comm_' + Date.now() + '_' + Math.random().toString(16).slice(2, 6),
          oppId: p.opp_id, type: 'proposal', direction: 'out',
          subject: subject,
          body: `Proposal ${p.prop_number || ''} sent to ${to}\n${_prPortalUrl()}`,
          ts: new Date().toISOString(),
          sentBy: (window.getCurrentRep ? window.getCurrentRep() : null)?.name || 'Rep',
          gmailSent: sentViaGmail,
          files: [],
        });
        if (typeof window.saveState === 'function') window.saveState();
      }
    } catch (e) {}
  }

  document.getElementById('pr-send-modal')?.remove();
  _prToast(sentViaGmail ? 'Proposal sent via Gmail ✓' : 'Proposal handed to your email app', 'success');
  _prRenderBuilder();
}

// ── AI PROPOSAL DRAFTING ──────────────────────────────────────────────────────

function _prAiLeadContext() {
  // Gather everything the AI needs about the linked lead from client state
  const st = _prState();
  const p = _prDraft;
  const o = p.opp_id ? ((st && st.opportunities) || []).find(x => x.id === p.opp_id) : null;
  const lead = o ? {
    client: o.client || p.client_name, address: o.address || p.property_addr,
    project: o.project || '', serviceLine: o.serviceLine || '',
    stage: o.status || '', value: o.value || '',
  } : {
    client: p.client_name, address: p.property_addr, project: p.title, serviceLine: '', stage: '', value: '',
  };

  let notes = '';
  if (o && st) {
    const noteLines = (st.notes || []).filter(n => n.oppId === o.id)
      .map(n => '- ' + (n.note || n.body || n.text || '')).filter(x => x.length > 2).slice(0, 25);
    const commLines = (st.communications || []).filter(c => c.oppId === o.id)
      .sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 15)
      .map(c => `- [${c.type || 'note'} ${c.direction || ''}] ${(c.subject ? c.subject + ': ' : '')}${(c.body || '').slice(0, 300)}`);
    notes = [
      noteLines.length ? 'NOTES:\n' + noteLines.join('\n') : '',
      commLines.length ? 'RECENT COMMUNICATIONS (newest first):\n' + commLines.join('\n') : '',
    ].filter(Boolean).join('\n\n');
  }
  const est = p.estimate_id ? _prLinkableEstimates.find(e => e.id === p.estimate_id) : null;
  const estimate = est ? {
    est_number: est.est_number, title: est.title, total: est.total,
    line_items: (typeof est.line_items === 'string' ? (function(){ try { return JSON.parse(est.line_items); } catch(e){ return []; } })() : est.line_items) || [],
    scope_of_work: est.scope_of_work || '',
  } : null;
  return { lead, notes, estimate };
}

function _prAiModal() {
  document.getElementById('pr-ai-modal')?.remove();
  const hasLead = !!_prDraft.opp_id;
  const hasEst = !!_prDraft.estimate_id;
  const wrap = document.createElement('div');
  wrap.id = 'pr-ai-modal';
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(20,28,26,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
  wrap.innerHTML = `
  <div style="background:#fff;border-radius:14px;max-width:540px;width:100%;padding:24px;box-shadow:0 24px 64px rgba(0,0,0,.3)" onclick="event.stopPropagation()">
    <div style="font-size:17px;font-weight:800;margin-bottom:4px">✨ Draft this proposal with AI</div>
    <div style="font-size:12.5px;color:var(--gw-text-subtle,#8A948C);margin-bottom:14px">
      The AI will use ${hasLead ? '<strong>this lead\u2019s details, notes and recent communications</strong>' : 'the client info entered above'}${hasEst ? ' plus the <strong>linked estimate\u2019s services and pricing</strong>' : ''} to write a complete draft. Nothing is sent to the client — you review and edit first.
    </div>
    <label class="est-label">Tell the AI what you want (optional but recommended)</label>
    <textarea class="est-input" id="pr-ai-instructions" rows="5" style="resize:vertical;margin-bottom:8px" placeholder="e.g. 5-application turf program plus a premium option with grub control and aeration. Around $1,200 for the standard tier. Mention their concern about crabgrass in the front yard. 50/50 payment split."></textarea>
    <div style="font-size:11px;color:var(--gw-text-subtle,#8A948C);margin-bottom:16px">⚠️ Applying the draft replaces the title, overview, sections, payment schedule and terms currently in the builder. Client info is kept.</div>
    <div style="display:flex;gap:10px;justify-content:flex-end;align-items:center">
      <span id="pr-ai-status" style="margin-right:auto;font-size:12px;color:var(--gw-text-subtle,#8A948C)"></span>
      <button class="est-btn-secondary" onclick="document.getElementById('pr-ai-modal').remove()">Cancel</button>
      <button class="est-btn-primary" id="pr-ai-go" onclick="_prAiGenerate()">Generate draft</button>
    </div>
  </div>`;
  wrap.addEventListener('click', () => wrap.remove());
  document.body.appendChild(wrap);
  setTimeout(() => document.getElementById('pr-ai-instructions')?.focus(), 50);
}

async function _prAiGenerate() {
  const btn = document.getElementById('pr-ai-go');
  const status = document.getElementById('pr-ai-status');
  const instructions = document.getElementById('pr-ai-instructions')?.value || '';
  if (btn) { btn.disabled = true; btn.textContent = 'Writing…'; btn.style.opacity = '.6'; }
  if (status) status.textContent = 'Reading lead history & drafting — usually 10–30s…';

  try {
    const ctx = _prAiLeadContext();
    const r = await fetch('/api/ai/generate-proposal', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lead: ctx.lead, notes: ctx.notes, estimate: ctx.estimate, instructions }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) {
      throw new Error(j.message || j.error || 'Generation failed');
    }
    const d = j.data || {};
    // Apply draft — keep client info, replace content
    if (d.title) _prDraft.title = d.title;
    if (d.subtitle) _prDraft.subtitle = d.subtitle;
    if (d.overview) _prDraft.overview = d.overview;
    if (Array.isArray(d.sections) && d.sections.length) _prDraft.sections = d.sections;
    if (Array.isArray(d.payment_schedule)) _prDraft.payment_schedule = d.payment_schedule;
    if (d.terms) _prDraft.terms = d.terms;
    document.getElementById('pr-ai-modal')?.remove();
    _prRenderBuilder();
    _prToast('AI draft ready ✨ — review the options and prices, then save & send', 'success');
    // Scroll to overview so the user starts reviewing at the top of the content
    setTimeout(() => document.getElementById('pr-overview')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 150);
  } catch (e) {
    console.error('[_prAiGenerate]', e);
    if (status) { status.textContent = ''; }
    if (btn) { btn.disabled = false; btn.textContent = 'Generate draft'; btn.style.opacity = '1'; }
    _prToast(e.message || 'AI drafting failed — try again', 'error');
  }
}

// ── TEMPLATES ─────────────────────────────────────────────────────────────────

function _prApplyTemplate() {
  const sel = document.getElementById('pr-template-select');
  const t = _prTemplates.find(x => x.id === sel?.value);
  if (!t) { _prToast('Choose a template first', 'error'); return; }
  const c = t.content || {};
  if (!confirm(`Apply "${t.name}"? This fills title, overview, sections, payment schedule and terms (client info is kept).`)) return;
  if (c.title != null) _prDraft.title = c.title;
  if (c.subtitle != null) _prDraft.subtitle = c.subtitle;
  if (c.overview != null) _prDraft.overview = c.overview;
  if (Array.isArray(c.sections)) _prDraft.sections = JSON.parse(JSON.stringify(c.sections));
  if (Array.isArray(c.payment_schedule)) _prDraft.payment_schedule = JSON.parse(JSON.stringify(c.payment_schedule));
  if (c.terms != null) _prDraft.terms = c.terms;
  _prRenderBuilder();
  _prToast(`Template "${t.name}" applied — adjust quantities & prices as needed`, 'success');
}

async function _prSaveAsTemplate() {
  const name = prompt('Template name (e.g. "5-App Turf Program"):', _prDraft.title || '');
  if (!name || !name.trim()) return;
  try {
    const r = await fetch('/api/proposal-templates', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        description: _prDraft.subtitle || '',
        content: {
          title: _prDraft.title, subtitle: _prDraft.subtitle, overview: _prDraft.overview,
          sections: _prDraft.sections, payment_schedule: _prDraft.payment_schedule, terms: _prDraft.terms,
        },
      }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'Failed');
    _prToast(`Template "${name.trim()}" saved`, 'success');
    // refresh template list in place
    try { const rr = await fetch('/api/proposal-templates', { credentials: 'include' }); const jj = await rr.json(); _prTemplates = jj.data || []; } catch (e) {}
    _prRenderBuilder();
  } catch (e) { _prToast('Failed to save template', 'error'); }
}

async function _prDeleteTemplate() {
  const sel = document.getElementById('pr-template-select');
  const t = _prTemplates.find(x => x.id === sel?.value);
  if (!t) { _prToast('Choose a template to delete', 'error'); return; }
  if (!confirm(`Delete template "${t.name}"?`)) return;
  try {
    await fetch(`/api/proposal-templates/${t.id}`, { method: 'DELETE', credentials: 'include' });
    _prTemplates = _prTemplates.filter(x => x.id !== t.id);
    _prToast('Template deleted', 'success');
    _prRenderBuilder();
  } catch (e) { _prToast('Failed to delete template', 'error'); }
}

// ── EXPORTS ───────────────────────────────────────────────────────────────────

window.proposals               = proposals;
window.proposalBuilder         = proposalBuilder;
window.proposalBuilderForLead  = proposalBuilderForLead;
window._prSave                 = _prSave;
window._prDelete               = _prDelete;
window._prAddSection           = _prAddSection;
window._prRemoveSection        = _prRemoveSection;
window._prMoveSection          = _prMoveSection;
window._prAddRow               = _prAddRow;
window._prRemoveRow            = _prRemoveRow;
window._prOptionSubtotalRefresh = _prOptionSubtotalRefresh;
window._prPaySchedAdd          = _prPaySchedAdd;
window._prPaySchedRefresh      = _prPaySchedRefresh;
window._prPaySchedSumRefresh   = _prPaySchedSumRefresh;
window._prRailRefresh          = _prRailRefresh;
window._prCopyPortalLink       = _prCopyPortalLink;
window._prPreview              = _prPreview;
window._prSendModal            = _prSendModal;
window._prDoSend               = _prDoSend;
window._prAiModal              = _prAiModal;
window._prAiGenerate           = _prAiGenerate;
window._prApplyTemplate        = _prApplyTemplate;
window._prSaveAsTemplate       = _prSaveAsTemplate;
window._prDeleteTemplate       = _prDeleteTemplate;
