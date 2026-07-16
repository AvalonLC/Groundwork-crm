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

  const pvOn = _prPvOn();

  // #view is overflow:auto (a scroll container that never actually scrolls —
  // the window does), which silently disables position:sticky for children.
  // Override it while the builder is open so the preview + rail stick, and
  // auto-restore the moment any other view replaces the builder.
  view.style.setProperty('overflow', 'visible', 'important');
  if (!window._prViewOverflowWatch) {
    window._prViewOverflowWatch = new MutationObserver(() => {
      const v = document.getElementById('view');
      if (v && v.style.overflow === 'visible' && !document.getElementById('pr-builder-shell')) v.style.removeProperty('overflow');
    });
    window._prViewOverflowWatch.observe(view, { childList: true });
  }

  view.innerHTML = `
  <div style="max-width:${pvOn ? '1760px' : '1120px'};margin:0 auto;padding:20px 18px 60px;display:flex;flex-wrap:wrap;gap:22px;align-items:flex-start" id="pr-builder-shell">
    <div style="flex:1 1 540px;min-width:0">

      <!-- Top nav -->
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
        <button class="est-btn-secondary" style="font-size:12.5px;padding:7px 12px" onclick="${p.opp_id ? `(window.show?show('pipeline','${_prEsc(p.opp_id)}'):proposals())` : 'proposals()'}">‹ ${p.opp_id ? 'Back to Lead' : 'Proposals'}</button>
        <div style="font-size:17px;font-weight:800">${isEdit ? `Edit ${_prEsc(p.prop_number || 'Proposal')}` : 'New Proposal'}</div>
        ${_prStatusPill(p.status)}
        <span id="pr-save-state" style="margin-left:auto;font-size:12px;color:var(--gw-text-subtle,#8A948C)"></span>
        <button class="est-btn-secondary" style="font-size:12px;padding:7px 12px;white-space:nowrap${pvOn ? ';background:var(--gw-teal,#4D8A86);color:#fff;border-color:transparent' : ''}" onclick="_prTogglePreview()" title="Show the client-facing document side-by-side, updating live as you type">${pvOn ? '✓ Live preview' : '👁 Live preview'}</button>
      </div>

      <!-- AI draft -->
      <section style="background:linear-gradient(135deg,#113931 0%,#1E5E52 100%);border-radius:12px;padding:16px 18px;margin-bottom:16px;color:#fff">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <div>
            <div style="font-size:13px;font-weight:800">✨ Draft with AI</div>
            <div style="font-size:11.5px;opacity:.85">Writes the whole document — from priced option quotes to formal bids or planning frameworks with investment ranges — using ${p.opp_id ? "this lead's notes and history" : 'your instructions'}. You review and edit everything before sending.</div>
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
        <div style="font-size:13px;font-weight:800;margin-bottom:4px">3 · Document Content</div>
        <div style="font-size:11.5px;color:var(--gw-text-subtle,#8A948C);margin-bottom:12px">Build the proposal from blocks — stack them in any order to match any format: formal bids, renovation proposals, planning frameworks, service programs, or anything else.</div>
        <div id="pr-sections">${_prSectionsHtml()}</div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          <button class="est-btn-secondary" style="font-size:12px;padding:7px 11px" onclick="_prAddSection('text')">+ Text</button>
          <button class="est-btn-secondary" style="font-size:12px;padding:7px 11px" onclick="_prAddSection('bullets')">+ Bullet list</button>
          <button class="est-btn-secondary" style="font-size:12px;padding:7px 11px" onclick="_prAddSection('option')">+ Priced option</button>
          <button class="est-btn-secondary" style="font-size:12px;padding:7px 11px" onclick="_prAddSection('table')">+ Custom table</button>
          <button class="est-btn-secondary" style="font-size:12px;padding:7px 11px" onclick="_prAddSection('cards')">+ Card menu</button>
          <button class="est-btn-secondary" style="font-size:12px;padding:7px 11px" onclick="_prAddSection('fields')">+ Info grid</button>
          <button class="est-btn-secondary" style="font-size:12px;padding:7px 11px" onclick="_prAddSection('price')">+ Price callout</button>
          <button class="est-btn-secondary" style="font-size:12px;padding:7px 11px" onclick="_prAddSection('signature')">+ Signature block</button>
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

    <!-- Live client preview -->
    <div id="pr-preview-col" style="flex:1 1 520px;min-width:340px;align-self:stretch;${pvOn ? '' : 'display:none'}">
      <div style="position:sticky;top:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px">
          <div style="font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--gw-text-subtle,#8A948C)">Client view · updates as you type</div>
          <button style="border:none;background:transparent;font-size:11.5px;color:var(--gw-text-subtle,#8A948C);cursor:pointer;text-decoration:underline" onclick="_prTogglePreview()">Hide</button>
        </div>
        <iframe id="pr-pv-frame" title="Live proposal preview" style="width:100%;height:calc(100vh - 100px);min-height:420px;border:1px solid var(--gw-border,#E4E0D6);border-radius:12px;background:#F5F3EE;box-shadow:0 8px 28px rgba(17,57,49,.08)"></iframe>
      </div>
    </div>

    <!-- Right rail -->
    <aside style="flex:${pvOn ? '1 1 220px;max-width:300px' : '0 0 300px'};min-width:220px">
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

  // Live preview: any keystroke anywhere in the builder refreshes the client
  // view (all field editors mutate _prDraft via inline oninput first, so a
  // delegated listener firing after them always sees fresh data).
  const shell = document.getElementById('pr-builder-shell');
  if (shell) {
    shell.addEventListener('input', _prPvQueue);
    shell.addEventListener('change', _prPvQueue);
  }
  if (pvOn) _prPvRender();
}

// ── SECTIONS EDITOR — universal block system ─────────────────────────────────
// Block types (any order, any count — shape any document):
//   text      — narrative paragraphs                          (all four PDFs)
//   bullets   — bullet list w/ optional intro                 (scope lists, exclusions, assumptions)
//   option    — priced table w/ editable columns + subtotal   (service programs, commercial bids)
//   table     — free-form table, any columns, no math         (plant schedules, scope/range tables)
//   cards     — card menu: name + price/range + description   (Sydney-style option menus)
//   fields    — label/value info grid                         (formal proposal metadata blocks)
//   price     — big price callout: label + amount + note      ("Total Investment: $15,000")
//   signature — acceptance & signature lines (1 or 2 parties) (all proposals)

const _PR_BLOCKS = {
  text:      { label: 'Text',          color: '#8A948C' },
  bullets:   { label: 'Bullet List',   color: '#6E8B74' },
  option:    { label: 'Priced Option', color: 'var(--gw-teal,#4D8A86)' },
  table:     { label: 'Custom Table',  color: '#7B6E9E' },
  cards:     { label: 'Card Menu',     color: '#4D7A9E' },
  fields:    { label: 'Info Grid',     color: '#9E7B4D' },
  price:     { label: 'Price Callout', color: '#1E5E3E' },
  signature: { label: 'Signature',     color: '#5A5E66' },
};

function _prSectionsHtml() {
  const secs = (_prDraft && _prDraft.sections) || [];
  if (!secs.length) {
    return `<div style="border:1px dashed var(--gw-border,#DDD8CE);border-radius:10px;padding:22px;text-align:center;font-size:12.5px;color:var(--gw-text-subtle,#8A948C)">No content yet — add blocks below, apply a template, or let AI draft the whole document.</div>`;
  }
  return secs.map((s, si) => _prBlockHtml(s, si)).join('');
}

function _prBlockHtml(s, si) {
  const meta = _PR_BLOCKS[s.type] || _PR_BLOCKS.text;
  const titlePh = {
    text: 'Section title — e.g. Project Overview / Scope Boundary / Warranty',
    bullets: 'Section title — e.g. Included Work / Exclusions / Assumptions',
    option: 'e.g. OPTION 1: Standard Program / Base Bid Summary',
    table: 'Table title — e.g. Plant Material Schedule / Preliminary Budget Breakdown',
    cards: 'Menu title — e.g. Option Menu / Project Directions',
    fields: 'Grid title — e.g. Proposal Details / Project Information',
    price: 'Callout title (optional) — e.g. Front Entry Landscape Renovation',
    signature: 'e.g. Acceptance & Authorization',
  }[s.type] || 'Section title';
  const head = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <span style="font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#fff;background:${meta.color};padding:3px 8px;border-radius:5px;white-space:nowrap">${meta.label}</span>
      <input class="est-input" style="flex:1;font-weight:700" value="${_prEsc(s.title || '')}" placeholder="${titlePh}" oninput="_prDraft.sections[${si}].title=this.value">
      <button title="Move up" style="border:none;background:transparent;cursor:pointer;font-size:14px;color:var(--gw-text-subtle,#8A948C)" onclick="_prMoveSection(${si},-1)">↑</button>
      <button title="Move down" style="border:none;background:transparent;cursor:pointer;font-size:14px;color:var(--gw-text-subtle,#8A948C)" onclick="_prMoveSection(${si},1)">↓</button>
      <button title="Duplicate" style="border:none;background:transparent;cursor:pointer;font-size:13px;color:var(--gw-text-subtle,#8A948C)" onclick="_prDupSection(${si})">⧉</button>
      <button title="Remove section" style="border:none;background:transparent;cursor:pointer;font-size:16px;color:#B4482E" onclick="_prRemoveSection(${si})">×</button>
    </div>`;
  const wrap = (inner) => `<div style="border:1px solid var(--gw-border,#E4E0D6);border-radius:10px;padding:14px;margin-bottom:12px">${head}${inner}</div>`;

  // ── TEXT ──
  if (s.type === 'text' || !_PR_BLOCKS[s.type]) {
    return wrap(`<textarea class="est-input" rows="4" style="resize:vertical" placeholder="Section content — paragraphs separated by blank lines…" oninput="_prDraft.sections[${si}].body=this.value">${_prEsc(s.body || '')}</textarea>`);
  }

  // ── BULLETS ──
  if (s.type === 'bullets') {
    const items = Array.isArray(s.items) ? s.items : (s.items = []);
    return wrap(`
      <input class="est-input" style="margin-bottom:8px;font-size:12.5px" value="${_prEsc(s.intro || '')}" placeholder="Intro line (optional) — e.g. Unless specifically added by written amendment, the following are excluded:" oninput="_prDraft.sections[${si}].intro=this.value">
      ${items.map((it, ii) => `
      <div style="display:flex;gap:6px;margin-bottom:6px;align-items:start">
        <span style="padding-top:9px;color:var(--gw-text-subtle,#8A948C);font-size:13px">•</span>
        <textarea class="est-input" rows="1" style="flex:1;font-size:12.5px;resize:vertical;min-height:34px" placeholder="Bullet item — a bold lead-in before a colon renders as a heading" oninput="_prDraft.sections[${si}].items[${ii}]=this.value">${_prEsc(it || '')}</textarea>
        <button title="Remove" style="border:none;background:transparent;cursor:pointer;font-size:15px;color:#B4482E;padding-top:6px" onclick="_prDraft.sections[${si}].items.splice(${ii},1);_prSectionsRefresh()">×</button>
      </div>`).join('')}
      <button class="est-btn-secondary" style="font-size:12px;padding:6px 11px;margin-top:2px" onclick="_prDraft.sections[${si}].items.push('');_prSectionsRefresh()">+ Add bullet</button>`);
  }

  // ── OPTION (priced table, editable column headers) ──
  if (s.type === 'option') {
    const rows = Array.isArray(s.rows) ? s.rows : (s.rows = []);
    const subtotal = rows.reduce((t, r) => t + (Number(r.price) || 0), 0);
    const c1 = s.col1 || 'Application', c2 = s.col2 || 'Included Service', c3 = s.col3 || 'Price';
    return wrap(`
      <input class="est-input" style="margin-bottom:10px;font-size:12.5px" value="${_prEsc(s.goal || '')}" placeholder="Goal / lead-in (optional) — e.g. Maintain healthy turf with balanced fertilization" oninput="_prDraft.sections[${si}].goal=this.value">
      <div style="display:grid;grid-template-columns:1fr 1.4fr 110px 26px;gap:6px;margin-bottom:6px">
        <input class="est-input" style="font-size:10.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;padding:5px 8px" value="${_prEsc(c1)}" title="Column 1 header — rename to fit your industry" oninput="_prDraft.sections[${si}].col1=this.value">
        <input class="est-input" style="font-size:10.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;padding:5px 8px" value="${_prEsc(c2)}" title="Column 2 header" oninput="_prDraft.sections[${si}].col2=this.value">
        <input class="est-input" style="font-size:10.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;padding:5px 8px;text-align:right" value="${_prEsc(c3)}" title="Column 3 header" oninput="_prDraft.sections[${si}].col3=this.value">
        <span></span>
      </div>
      ${rows.map((r, ri) => `
      <div style="display:grid;grid-template-columns:1fr 1.4fr 110px 26px;gap:6px;margin-bottom:6px;align-items:start">
        <input class="est-input" style="font-size:12.5px" value="${_prEsc(r.app || '')}" placeholder="${_prEsc(c1)}" oninput="_prDraft.sections[${si}].rows[${ri}].app=this.value">
        <input class="est-input" style="font-size:12.5px" value="${_prEsc(r.service || '')}" placeholder="${_prEsc(c2)}" oninput="_prDraft.sections[${si}].rows[${ri}].service=this.value">
        <input class="est-input" type="number" min="0" step="0.01" style="font-size:12.5px;text-align:right" value="${r.price != null && r.price !== '' ? r.price : ''}" placeholder="0.00" oninput="_prDraft.sections[${si}].rows[${ri}].price=parseFloat(this.value)||0;_prOptionSubtotalRefresh(${si})">
        <button title="Remove row" style="border:none;background:transparent;cursor:pointer;font-size:15px;color:#B4482E;padding-top:6px" onclick="_prRemoveRow(${si},${ri})">×</button>
      </div>`).join('')}
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px">
        <button class="est-btn-secondary" style="font-size:12px;padding:6px 11px" onclick="_prAddRow(${si})">+ Add row</button>
        <span id="pr-opt-subtotal-${si}" style="font-size:12.5px;font-weight:800;font-variant-numeric:tabular-nums">Option total: ${_prFmt(subtotal)}</span>
      </div>
      <input class="est-input" style="margin-top:10px;font-size:12px" value="${_prEsc(s.footnote || '')}" placeholder="Footnote (optional) — e.g. *Prices include all materials and labor" oninput="_prDraft.sections[${si}].footnote=this.value">`);
  }

  // ── CUSTOM TABLE (any columns, free text cells, no math) ──
  if (s.type === 'table') {
    const cols = Array.isArray(s.columns) && s.columns.length ? s.columns : (s.columns = ['Item', 'Description']);
    const rows = Array.isArray(s.rows) ? s.rows : (s.rows = []);
    rows.forEach(r => { if (!Array.isArray(r.cells)) r.cells = []; while (r.cells.length < cols.length) r.cells.push(''); });
    const grid = cols.map(() => '1fr').join(' ') + ' 26px';
    return wrap(`
      <div style="display:grid;grid-template-columns:${grid};gap:6px;margin-bottom:6px">
        ${cols.map((cName, ci) => `
        <div style="display:flex;gap:2px;align-items:center">
          <input class="est-input" style="font-size:10.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;padding:5px 8px;flex:1;min-width:0" value="${_prEsc(cName)}" oninput="_prDraft.sections[${si}].columns[${ci}]=this.value">
          ${cols.length > 1 ? `<button title="Remove column" style="border:none;background:transparent;cursor:pointer;font-size:12px;color:#B4482E;padding:0 2px;flex:none" onclick="_prTableDelCol(${si},${ci})">×</button>` : ''}
        </div>`).join('')}
        <button title="Add column" style="border:1px dashed var(--gw-border,#CFC9BC);background:transparent;border-radius:6px;cursor:pointer;font-size:13px;color:var(--gw-text-subtle,#8A948C)" onclick="_prTableAddCol(${si})">+</button>
      </div>
      ${rows.map((r, ri) => `
      <div style="display:grid;grid-template-columns:${grid};gap:6px;margin-bottom:6px;align-items:start">
        ${cols.map((_, ci) => `<textarea class="est-input" rows="1" style="font-size:12.5px;resize:vertical;min-height:34px" oninput="_prDraft.sections[${si}].rows[${ri}].cells[${ci}]=this.value">${_prEsc(r.cells[ci] || '')}</textarea>`).join('')}
        <button title="Remove row" style="border:none;background:transparent;cursor:pointer;font-size:15px;color:#B4482E;padding-top:6px" onclick="_prRemoveRow(${si},${ri})">×</button>
      </div>`).join('')}
      <button class="est-btn-secondary" style="font-size:12px;padding:6px 11px;margin-top:2px" onclick="_prDraft.sections[${si}].rows.push({cells:_prDraft.sections[${si}].columns.map(function(){return ''})});_prSectionsRefresh()">+ Add row</button>
      <input class="est-input" style="margin-top:10px;font-size:12px" value="${_prEsc(s.footnote || '')}" placeholder="Footnote (optional) — e.g. Final placement will be field-adjusted…" oninput="_prDraft.sections[${si}].footnote=this.value">`);
  }

  // ── CARD MENU ──
  if (s.type === 'cards') {
    const cards = Array.isArray(s.cards) ? s.cards : (s.cards = []);
    return wrap(`
      <input class="est-input" style="margin-bottom:10px;font-size:12.5px" value="${_prEsc(s.intro || '')}" placeholder="Intro line (optional) — e.g. Each item can stand alone or combine into a first phase." oninput="_prDraft.sections[${si}].intro=this.value">
      ${cards.map((cd, ci) => `
      <div style="border:1px solid var(--gw-border-soft,#EDEAE2);border-radius:8px;padding:10px;margin-bottom:8px;background:var(--gw-bg,#FAF9F5)">
        <div style="display:flex;gap:6px;margin-bottom:6px">
          <input class="est-input" style="flex:1.4;font-size:12.5px;font-weight:700" value="${_prEsc(cd.head || '')}" placeholder="Card name — e.g. Backyard Perimeter Planting" oninput="_prDraft.sections[${si}].cards[${ci}].head=this.value">
          <input class="est-input" style="flex:1;font-size:12.5px" value="${_prEsc(cd.price || '')}" placeholder="Price / range — e.g. $6,500–$15,000" oninput="_prDraft.sections[${si}].cards[${ci}].price=this.value">
          <button title="Remove card" style="border:none;background:transparent;cursor:pointer;font-size:15px;color:#B4482E" onclick="_prDraft.sections[${si}].cards.splice(${ci},1);_prSectionsRefresh()">×</button>
        </div>
        <textarea class="est-input" rows="2" style="font-size:12px;resize:vertical" placeholder="Description — what's included, scope, notes…" oninput="_prDraft.sections[${si}].cards[${ci}].body=this.value">${_prEsc(cd.body || '')}</textarea>
      </div>`).join('')}
      <button class="est-btn-secondary" style="font-size:12px;padding:6px 11px" onclick="_prDraft.sections[${si}].cards.push({head:'',price:'',body:''});_prSectionsRefresh()">+ Add card</button>`);
  }

  // ── INFO GRID (label / value pairs) ──
  if (s.type === 'fields') {
    const pairs = Array.isArray(s.pairs) ? s.pairs : (s.pairs = []);
    return wrap(`
      ${pairs.map((pv, pi) => `
      <div style="display:grid;grid-template-columns:1fr 1.6fr 26px;gap:6px;margin-bottom:6px;align-items:start">
        <input class="est-input" style="font-size:12.5px;font-weight:700" value="${_prEsc(pv.k || '')}" placeholder="Label — e.g. Proposal Number / Bid Due / Design Stage" oninput="_prDraft.sections[${si}].pairs[${pi}].k=this.value">
        <input class="est-input" style="font-size:12.5px" value="${_prEsc(pv.v || '')}" placeholder="Value" oninput="_prDraft.sections[${si}].pairs[${pi}].v=this.value">
        <button title="Remove" style="border:none;background:transparent;cursor:pointer;font-size:15px;color:#B4482E;padding-top:6px" onclick="_prDraft.sections[${si}].pairs.splice(${pi},1);_prSectionsRefresh()">×</button>
      </div>`).join('')}
      <button class="est-btn-secondary" style="font-size:12px;padding:6px 11px" onclick="_prDraft.sections[${si}].pairs.push({k:'',v:''});_prSectionsRefresh()">+ Add field</button>`);
  }

  // ── PRICE CALLOUT ──
  if (s.type === 'price') {
    return wrap(`
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
        <input class="est-input" style="font-size:12.5px" value="${_prEsc(s.label || '')}" placeholder="Label — e.g. Total Investment / Base Bid Amount / Estimated Phase 1" oninput="_prDraft.sections[${si}].label=this.value">
        <input class="est-input" style="font-size:14px;font-weight:800" value="${_prEsc(s.amount || '')}" placeholder="Amount — e.g. $15,000 or $12,000–$18,500" oninput="_prDraft.sections[${si}].amount=this.value;_prRailRefresh()">
      </div>
      <input class="est-input" style="font-size:12px" value="${_prEsc(s.note || '')}" placeholder="Note (optional) — e.g. Preliminary planning range only — not final construction pricing" oninput="_prDraft.sections[${si}].note=this.value">`);
  }

  // ── SIGNATURE ──
  if (s.type === 'signature') {
    return wrap(`
      <textarea class="est-input" rows="2" style="font-size:12.5px;resize:vertical;margin-bottom:8px" placeholder="Acceptance language (optional) — e.g. Acceptance of this proposal indicates agreement with the scope, pricing, and terms herein…" oninput="_prDraft.sections[${si}].body=this.value">${_prEsc(s.body || '')}</textarea>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <input class="est-input" style="font-size:12.5px" value="${_prEsc(s.party1 || '')}" placeholder="Party 1 — e.g. Client / Authorized Representative" oninput="_prDraft.sections[${si}].party1=this.value">
        <input class="est-input" style="font-size:12.5px" value="${_prEsc(s.party2 || '')}" placeholder="Party 2 (optional) — e.g. Avalon Landscape Construction" oninput="_prDraft.sections[${si}].party2=this.value">
      </div>
      <div style="font-size:11px;color:var(--gw-text-subtle,#8A948C);margin-top:6px">Renders as signature / printed name / date lines for each party on the client page. Leave Party 2 blank for a single-signer block.</div>`);
  }

  return wrap('');
}

function _prSectionsRefresh() {
  const el = document.getElementById('pr-sections');
  if (el) el.innerHTML = _prSectionsHtml();
  _prRailRefresh();
  _prPvQueue();
}
function _prAddSection(type) {
  if (!_prDraft) return;
  const blocks = {
    text:      { type: 'text', title: '', body: '' },
    bullets:   { type: 'bullets', title: '', intro: '', items: [''] },
    option:    null, // handled below (needs numbering)
    table:     { type: 'table', title: '', columns: ['Item', 'Description'], rows: [{ cells: ['', ''] }], footnote: '' },
    cards:     { type: 'cards', title: '', intro: '', cards: [{ head: '', price: '', body: '' }] },
    fields:    { type: 'fields', title: '', pairs: [{ k: '', v: '' }, { k: '', v: '' }] },
    price:     { type: 'price', title: '', label: 'Total Investment', amount: '', note: '' },
    signature: { type: 'signature', title: 'Acceptance & Authorization', body: '', party1: 'Client', party2: '' },
  };
  if (type === 'option') {
    const n = _prDraft.sections.filter(s => s.type === 'option').length + 1;
    _prDraft.sections.push({ type: 'option', title: `OPTION ${n}: `, goal: '', col1: 'Application', col2: 'Included Service', col3: 'Price', rows: [{ app: '', service: '', price: 0 }], footnote: '' });
  } else {
    _prDraft.sections.push(blocks[type] || blocks.text);
  }
  _prSectionsRefresh();
}
function _prDupSection(si) {
  const s = _prDraft.sections[si];
  if (!s) return;
  _prDraft.sections.splice(si + 1, 0, JSON.parse(JSON.stringify(s)));
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
  if (s.type === 'table') s.rows.push({ cells: (s.columns || []).map(() => '') });
  else s.rows.push({ app: '', service: '', price: 0 });
  _prSectionsRefresh();
}
function _prRemoveRow(si, ri) {
  const s = _prDraft.sections[si];
  if (!s || !Array.isArray(s.rows)) return;
  s.rows.splice(ri, 1);
  _prSectionsRefresh();
}
function _prTableAddCol(si) {
  const s = _prDraft.sections[si];
  if (!s || s.type !== 'table') return;
  s.columns.push('Column ' + (s.columns.length + 1));
  (s.rows || []).forEach(r => { if (!Array.isArray(r.cells)) r.cells = []; r.cells.push(''); });
  _prSectionsRefresh();
}
function _prTableDelCol(si, ci) {
  const s = _prDraft.sections[si];
  if (!s || s.type !== 'table' || (s.columns || []).length <= 1) return;
  s.columns.splice(ci, 1);
  (s.rows || []).forEach(r => { if (Array.isArray(r.cells)) r.cells.splice(ci, 1); });
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
  if (opts.length) return opts.length === 1 ? opts[0] : Math.max(...opts);
  // No priced option tables — fall back to the first numeric price callout
  // (e.g. "Total Investment: $15,000") so the pipeline still sees a value.
  const callout = (_prDraft.sections || []).find(s => s.type === 'price' && s.amount);
  if (callout) {
    const m = String(callout.amount).replace(/,/g, '').match(/\$?\s*([0-9]+(?:\.[0-9]+)?)/);
    if (m) return Number(m[1]) || 0;
  }
  return 0;
}
function _prFirstCalloutAmount() {
  const callout = (_prDraft.sections || []).find(s => s.type === 'price' && s.amount);
  return callout ? String(callout.amount) : '';
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
    <div style="display:flex;justify-content:space-between;font-size:12.5px;padding:4px 0"><span>Content blocks</span><strong>${(p.sections || []).length}</strong></div>
    ${opts.length ? `<div style="display:flex;justify-content:space-between;font-size:12.5px;padding:4px 0"><span>Priced options</span><strong>${opts.length}</strong></div>` : ''}
    <div style="display:flex;justify-content:space-between;font-size:14px;padding:8px 0;border-top:1px solid var(--gw-border-soft,#F0EEE8);margin-top:6px"><span style="font-weight:700">${opts.length > 1 ? 'Top option value' : 'Proposal value'}</span><strong>${opts.length ? (total > 0 ? _prFmt(total) : '—') : (_prEsc(_prFirstCalloutAmount()) || (total > 0 ? _prFmt(total) : '—'))}</strong></div>
    ${sched.length ? sched.map(s2 => `<div style="display:flex;justify-content:space-between;font-size:11.5px;color:var(--gw-text-subtle,#6F7E6A);padding:2px 0"><span>${_prEsc(s2.label || 'Payment')}</span><span>${Number(s2.pct) || 0}%${total ? ' · ' + _prFmt(total * (Number(s2.pct) || 0) / 100) : ''}</span></div>`).join('') : ''}
    ${p.portal_token ? `<div style="margin-top:10px;font-size:11px;color:var(--gw-text-subtle,#8A948C);word-break:break-all">Client link ready ✓</div>` : ''}`;
}
function _prRailRefresh() {
  const el = document.getElementById('pr-rail-summary');
  if (el) el.innerHTML = _prRailHtml();
  _prPvQueue();
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

// ── LIVE PREVIEW — client-side mirror of the portal renderer ─────────────────
// Renders the current draft into the side iframe exactly the way the client
// portal will show it, updating (debounced) on every keystroke. Persisted
// on/off per user via localStorage.

function _prPvOn() {
  try { return localStorage.getItem('gwProposalPreviewV1') === '1'; } catch (_) { return false; }
}

function _prTogglePreview() {
  try { localStorage.setItem('gwProposalPreviewV1', _prPvOn() ? '0' : '1'); } catch (_) {}
  _prRenderBuilder();          // re-layout builder with/without the preview column
}

let _prPvTimer = null;
function _prPvQueue() {        // debounced refresh — called from every input
  if (!_prPvOn()) return;
  clearTimeout(_prPvTimer);
  _prPvTimer = setTimeout(_prPvRender, 220);
}

function _prPvBrand() {
  const b = window._scBrand || {};
  const boot = (window._gwBootstrap && window._gwBootstrap.company) || {};
  return {
    name: b.name || boot.name || 'Your Company',
    tagline: b.tagline || '',
    logo_url: b.logo_url || '',
    brand_color: b.brand_color || '#113931',
    phone: b.phone || '',
    website: b.website || '',
  };
}

function _prPvFmtDate(d) {
  if (!d) return '';
  try { return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); } catch (_) { return d; }
}

function _prPvBullet(raw) {
  const t = String(raw || '');
  const ci = t.indexOf(':');
  if (ci > 0 && ci < 90) return `<strong>${_prEsc(t.slice(0, ci))}:</strong>${_prEsc(t.slice(ci + 1))}`;
  return _prEsc(t);
}

function _prPvSectionHtml(s, si, optCount) {
  const esc = _prEsc, money = _prFmt;
  const t = s.type;
  if (t === 'text' || !t) {
    return `<div class="pp-section"><h2>${esc(s.title || '')}</h2><p class="pp-body-text">${esc(s.body || '').replace(/\n/g, '<br>')}</p></div>`;
  }
  if (t === 'bullets') {
    const items = (Array.isArray(s.items) ? s.items : []).filter(it => String(it || '').trim());
    return `<div class="pp-section"><h2>${esc(s.title || '')}</h2>
      ${s.intro ? `<p class="pp-body-text" style="margin-bottom:10px">${esc(s.intro)}</p>` : ''}
      <ul class="pp-bullets">${items.map(it => `<li>${_prPvBullet(it)}</li>`).join('')}</ul></div>`;
  }
  if (t === 'option') {
    const rows = Array.isArray(s.rows) ? s.rows : [];
    const subtotal = rows.reduce((tt, r) => tt + Number(r.price || 0), 0);
    return `<div class="pp-section">
      <h2>${esc(s.title || `Option ${si + 1}`)}</h2>
      ${s.goal ? `<p class="pp-goal">${esc(s.goal)}</p>` : ''}
      <table class="pp-table">
        <thead><tr><th>${esc(s.col1 || 'Application')}</th><th>${esc(s.col2 || 'Included Service')}</th><th class="pp-price-col">${esc(s.col3 || 'Price')}</th></tr></thead>
        <tbody>${rows.map(r => `<tr><td>${esc(r.app || '')}</td><td>${esc(r.service || '')}</td><td class="pp-price-col">${r.price !== '' && r.price != null ? money(Number(r.price)) : ''}</td></tr>`).join('')}</tbody>
        ${subtotal > 0 ? `<tfoot><tr><td colspan="2"><strong>Option Total</strong></td><td class="pp-price-col"><strong>${money(subtotal)}</strong></td></tr></tfoot>` : ''}
      </table>
      ${s.footnote ? `<p class="pp-footnote">${esc(s.footnote)}</p>` : ''}
      ${optCount > 1 ? `<button class="pp-accept-btn" disabled style="opacity:.55;cursor:default">Accept ${esc(s.title || `Option ${si + 1}`)}</button>` : ''}
    </div>`;
  }
  if (t === 'table') {
    const cols = (Array.isArray(s.columns) && s.columns.length) ? s.columns : ['Item', 'Description'];
    const rows = Array.isArray(s.rows) ? s.rows : [];
    return `<div class="pp-section"><h2>${esc(s.title || '')}</h2>
      <table class="pp-table">
        <thead><tr>${cols.map(cn => `<th>${esc(cn)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(r => `<tr>${cols.map((_, ci) => `<td>${esc((r.cells || [])[ci] || '').replace(/\n/g, '<br>')}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>
      ${s.footnote ? `<p class="pp-footnote">${esc(s.footnote)}</p>` : ''}</div>`;
  }
  if (t === 'cards') {
    const cards = (Array.isArray(s.cards) ? s.cards : []).filter(cd => (cd.head || '').trim() || (cd.body || '').trim());
    return `<div class="pp-section"><h2>${esc(s.title || '')}</h2>
      ${s.intro ? `<p class="pp-body-text" style="margin-bottom:14px">${esc(s.intro)}</p>` : ''}
      <div class="pp-cards">${cards.map(cd => `<div class="pp-card">
        <div class="pp-card-head">${esc(cd.head || '')}</div>
        ${cd.price ? `<div class="pp-card-price">${esc(cd.price)}</div>` : ''}
        ${cd.body ? `<div class="pp-card-body">${esc(cd.body).replace(/\n/g, '<br>')}</div>` : ''}
      </div>`).join('')}</div></div>`;
  }
  if (t === 'fields') {
    const pairs = (Array.isArray(s.pairs) ? s.pairs : []).filter(pv => (pv.k || '').trim() || (pv.v || '').trim());
    return `<div class="pp-section">${s.title ? `<h2>${esc(s.title)}</h2>` : ''}
      <div class="pp-fields">${pairs.map(pv => `<div class="pp-field"><div class="k">${esc(pv.k || '')}</div><div class="v">${esc(pv.v || '')}</div></div>`).join('')}</div></div>`;
  }
  if (t === 'price') {
    return `<div class="pp-price-callout">
      ${s.title ? `<div class="pp-price-title">${esc(s.title)}</div>` : ''}
      <div class="pp-price-line">${s.label ? `<span class="pp-price-label">${esc(s.label)}:</span> ` : ''}<span class="pp-price-amount">${esc(s.amount || '')}</span></div>
      ${s.note ? `<div class="pp-price-note">${esc(s.note)}</div>` : ''}</div>`;
  }
  if (t === 'signature') {
    const sig = (party) => `<div class="pp-sig-party">
      <div class="pp-sig-name">${_prEsc(party)}</div>
      <div class="pp-sig-line"><span>Signature</span></div>
      <div class="pp-sig-line"><span>Printed Name</span></div>
      <div class="pp-sig-row"><div class="pp-sig-line" style="flex:1"><span>Title</span></div><div class="pp-sig-line" style="flex:1"><span>Date</span></div></div>
    </div>`;
    return `<div class="pp-section"><h2>${esc(s.title || 'Acceptance & Authorization')}</h2>
      ${s.body ? `<p class="pp-body-text" style="margin-bottom:18px;font-size:12.5px">${esc(s.body).replace(/\n/g, '<br>')}</p>` : ''}
      <div class="pp-sig-grid" style="grid-template-columns:${s.party2 ? '1fr 1fr' : '1fr'}">${sig(s.party1 || 'Client')}${s.party2 ? sig(s.party2) : ''}</div></div>`;
  }
  return '';
}

function _prPvRender() {
  const frame = document.getElementById('pr-pv-frame');
  if (!frame || !_prDraft) return;
  const p = _prDraft, esc = _prEsc, money = _prFmt;
  const brand = _prPvBrand();
  const bc = brand.brand_color;
  const sections = Array.isArray(p.sections) ? p.sections : [];
  const sched = Array.isArray(p.payment_schedule) ? p.payment_schedule : [];
  const optCount = sections.filter(s => s.type === 'option').length;
  const total = _prComputeTotal();

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',-apple-system,sans-serif;background:#F5F3EE;color:#1F2A2B;line-height:1.6}
  .pp-hero{background:${bc};color:#fff;padding:34px 20px 30px;text-align:center}
  .pp-logo{height:44px;margin-bottom:12px}
  .pp-hero .pp-co{font-size:11px;letter-spacing:.24em;text-transform:uppercase;opacity:.85;font-weight:600}
  .pp-hero h1{font-size:22px;font-weight:800;margin-top:8px;letter-spacing:.02em}
  .pp-hero .pp-sub{font-size:13px;opacity:.8;margin-top:5px}
  .pp-wrap{max-width:720px;margin:0 auto;padding:0 16px 60px}
  .pp-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1px;background:#DDD8CE;border:1px solid #DDD8CE;margin:-22px auto 28px;max-width:680px;border-radius:12px;overflow:hidden;box-shadow:0 8px 32px rgba(17,57,49,.12)}
  .pp-meta-cell{background:#fff;padding:13px 15px}
  .pp-meta-cell .k{font-size:9.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#6F7E6A;margin-bottom:3px}
  .pp-meta-cell .v{font-size:13px;font-weight:600;color:#1F2A2B}
  .pp-section{background:#fff;border:1px solid #E4E0D6;border-radius:12px;padding:22px 24px;margin-bottom:16px}
  .pp-section h2{font-size:13.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:${bc};border-bottom:2px solid ${bc}22;padding-bottom:8px;margin-bottom:12px}
  .pp-body-text{font-size:13px;color:#3D4A46}
  .pp-goal{font-size:12.5px;color:#5A675F;margin-bottom:12px}
  .pp-table{width:100%;border-collapse:collapse;font-size:12.5px}
  .pp-table th{text-align:left;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#fff;background:${bc};padding:8px 10px}
  .pp-table td{padding:9px 10px;border-bottom:1px solid #EDEAE2;color:#37423E;vertical-align:top}
  .pp-table tfoot td{border-top:2px solid ${bc}33;border-bottom:none;padding-top:10px}
  .pp-price-col{text-align:right;white-space:nowrap;width:100px}
  .pp-footnote{font-size:11px;color:#77826F;margin-top:8px;font-style:italic}
  .pp-accept-btn{margin-top:14px;background:${bc};color:#fff;border:none;border-radius:8px;padding:10px 18px;font-size:13px;font-weight:700;font-family:inherit}
  .pp-actions{background:#fff;border:1px solid #E4E0D6;border-radius:12px;padding:22px;text-align:center}
  .pp-decline-btn{background:transparent;color:#8B5A4A;border:1.5px solid #D8BBB0;border-radius:8px;padding:9px 18px;font-size:12px;font-weight:600;margin:5px 7px;font-family:inherit}
  .pp-sched-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #EDEAE2;font-size:12.5px}
  .pp-sched-row:last-child{border-bottom:none}
  .pp-bullets{padding-left:18px;font-size:13px;color:#3D4A46}
  .pp-bullets li{margin-bottom:7px}
  .pp-bullets li:last-child{margin-bottom:0}
  .pp-bullets b,.pp-bullets strong{color:#1F2A2B}
  .pp-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-top:4px}
  .pp-card{border:1px solid #E4E0D6;border-radius:10px;padding:14px 15px;background:#FBFAF7}
  .pp-card-head{font-size:12.5px;font-weight:700;color:#1F2A2B;margin-bottom:3px}
  .pp-card-price{font-size:13px;font-weight:800;color:${bc};margin-bottom:7px}
  .pp-card-body{font-size:11.5px;color:#5A675F;line-height:1.55}
  .pp-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:1px;background:#EDEAE2;border:1px solid #EDEAE2;border-radius:10px;overflow:hidden}
  .pp-field{background:#fff;padding:11px 14px}
  .pp-field .k{font-size:9.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#6F7E6A;margin-bottom:2px}
  .pp-field .v{font-size:12.5px;font-weight:600;color:#1F2A2B}
  .pp-price-callout{background:#fff;border:1px solid #E4E0D6;border-left:4px solid ${bc};border-radius:12px;padding:22px 24px;margin-bottom:16px;text-align:center}
  .pp-price-title{font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#6F7E6A;margin-bottom:8px}
  .pp-price-line{display:flex;align-items:baseline;justify-content:center;gap:12px;flex-wrap:wrap}
  .pp-price-label{font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#6F7E6A}
  .pp-price-amount{font-size:25px;font-weight:800;color:${bc};letter-spacing:-.01em}
  .pp-price-note{font-size:11.5px;color:#77826F;margin-top:7px;font-style:italic}
  .pp-sig-grid{display:grid;gap:28px;margin-top:18px}
  .pp-sig-party{min-width:0}
  .pp-sig-name{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#5A675F;margin-bottom:28px}
  .pp-sig-row{display:flex;gap:18px}
  .pp-sig-line{flex:1;border-bottom:1.5px solid #B8B2A4;padding-bottom:3px;margin-bottom:15px;min-height:28px;display:flex;align-items:flex-end}
  .pp-sig-line span{font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#8A948C}
  .pp-footer{text-align:center;font-size:11px;color:#8A948C;margin-top:28px}
</style></head>
<body>
  <div class="pp-hero">
    ${brand.logo_url ? `<img class="pp-logo" src="${esc(brand.logo_url)}" alt="">` : ''}
    <div class="pp-co">${esc(brand.name)}${brand.tagline ? ' — ' + esc(brand.tagline) : ''}</div>
    <h1>${esc(p.title || 'Service Proposal')}</h1>
    ${p.subtitle ? `<div class="pp-sub">${esc(p.subtitle)}</div>` : ''}
  </div>
  <div class="pp-wrap">
    <div class="pp-meta">
      <div class="pp-meta-cell"><div class="k">Prepared For</div><div class="v">${esc(p.client_name || '—')}</div></div>
      <div class="pp-meta-cell"><div class="k">Proposal Date</div><div class="v">${esc(_prPvFmtDate(p.proposal_date) || '—')}</div></div>
      ${p.property_addr ? `<div class="pp-meta-cell"><div class="k">Property</div><div class="v">${esc(p.property_addr)}</div></div>` : ''}
      ${p.valid_through ? `<div class="pp-meta-cell"><div class="k">Valid Through</div><div class="v">${esc(_prPvFmtDate(p.valid_through))}</div></div>` : ''}
    </div>
    ${p.overview ? `<div class="pp-section"><h2>Overview</h2><p class="pp-body-text">${esc(p.overview).replace(/\n/g, '<br>')}</p></div>` : ''}
    ${sections.map((s, si) => _prPvSectionHtml(s, si, optCount)).join('')}
    ${sched.length ? `<div class="pp-section"><h2>Payment Schedule</h2>${sched.map(sp =>
      `<div class="pp-sched-row"><span>${esc(sp.label || 'Payment')}</span><strong>${Number(sp.pct || 0)}%${total ? ' — ' + money(total * Number(sp.pct || 0) / 100) : ''}</strong></div>`).join('')}</div>` : ''}
    ${p.terms ? `<div class="pp-section"><h2>Terms</h2><p class="pp-body-text" style="font-size:11.5px">${esc(p.terms).replace(/\n/g, '<br>')}</p></div>` : ''}
    <div class="pp-actions">
      <div style="font-size:13px;font-weight:600;margin-bottom:7px">Ready to move forward?</div>
      <button class="pp-accept-btn" disabled style="opacity:.55">Accept Proposal</button>
      <button class="pp-decline-btn" disabled style="opacity:.55">Decline</button>
    </div>
    <div class="pp-footer">${esc(brand.name)}${brand.phone ? ' · ' + esc(brand.phone) : ''}${brand.website ? ' · ' + esc(brand.website) : ''}</div>
  </div>
</body></html>`;

  // Preserve the reader's scroll position across refreshes
  let scrollY = 0;
  try { scrollY = frame.contentWindow?.scrollY || 0; } catch (_) {}
  frame.srcdoc = html;
  frame.onload = () => { try { frame.contentWindow.scrollTo(0, scrollY); } catch (_) {} };
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
    <textarea class="est-input" id="pr-ai-instructions" rows="5" style="resize:vertical;margin-bottom:8px" placeholder="Describe the document you want — a priced quote with 2 option tiers, a formal bid with project details and signature lines, a planning framework with investment ranges, an options menu with price ranges… e.g. 'Preliminary planning framework: patio, drainage and lighting areas with investment ranges, total range callout, no fixed pricing.'"></textarea>
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
window._prDupSection           = _prDupSection;
window._prAddRow               = _prAddRow;
window._prRemoveRow            = _prRemoveRow;
window._prTableAddCol          = _prTableAddCol;
window._prTableDelCol          = _prTableDelCol;
window._prSectionsRefresh      = _prSectionsRefresh;
window._prOptionSubtotalRefresh = _prOptionSubtotalRefresh;
window._prPaySchedAdd          = _prPaySchedAdd;
window._prPaySchedRefresh      = _prPaySchedRefresh;
window._prPaySchedSumRefresh   = _prPaySchedSumRefresh;
window._prRailRefresh          = _prRailRefresh;
window._prCopyPortalLink       = _prCopyPortalLink;
window._prPreview              = _prPreview;
window._prTogglePreview        = _prTogglePreview;
window._prPvRender             = _prPvRender;
window._prSendModal            = _prSendModal;
window._prDoSend               = _prDoSend;
window._prAiModal              = _prAiModal;
window._prAiGenerate           = _prAiGenerate;
window._prApplyTemplate        = _prApplyTemplate;
window._prSaveAsTemplate       = _prSaveAsTemplate;
window._prDeleteTemplate       = _prDeleteTemplate;
