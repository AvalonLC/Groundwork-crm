// ═══════════════════════════════════════════════════════════════════════════
// GROUNDWORK — MARKETING OS
// Campaigns, audiences, brand kit, media library and inquiry forms.
//
// THE ONE RULE IN THIS FILE: it never builds email HTML.
//
// The editor below composes a document of typed blocks and posts it to
// /api/marketing/campaigns/:id/preview, then drops the server's response into
// an iframe. Everything you see in the preview pane was rendered by
// src/marketing/render.ts — the same function the send path uses — so the
// preview cannot drift from what lands in the inbox.
//
// AGENTS.md records what the alternative costs: the estimate portal is
// rendered both here and on the server, and keeping the two in step is a tax
// paid by every change since. An email is worse, because a drifted preview is
// discovered by the customer.
//
// Block palette, per-block edit forms and drag ordering ARE built here. That
// is editor chrome, not email markup.
//
// API: /api/marketing/* (see src/marketing/api.ts)
// ═══════════════════════════════════════════════════════════════════════════
(function(){
'use strict';

const M = window._MKT = {
  brand: null, campaigns: [], audiences: [], assets: [], forms: [],
  services: [], senders: [], blockTypes: [], overview: null,
  campaign: null, doc: null, dirty: false, previewTimer: null, selectedBlock: null,
};

// ── Roles ────────────────────────────────────────────────────────────────────
// Crew roles get nothing: campaign screens show client contact lists and
// revenue attribution, which UI INVARIANTS keeps away from crew.
const WRITE_ROLES = ['admin', 'office_manager'];
function _rep()     { return (window.getCurrentRep ? window.getCurrentRep() : null) || window._d1SessionRep || null; }
function canWrite() { const r = _rep(); return !r || WRITE_ROLES.includes(r.role); }

// ── Utils ────────────────────────────────────────────────────────────────────
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function toast(msg, type){ if (window.showToast) window.showToast(msg, type||'success'); }

// Cents are integers everywhere behind this line; this is the UI boundary.
function money(cents){
  const n = Number(cents || 0) / 100;
  return n.toLocaleString('en-US', { style:'currency', currency:'USD', maximumFractionDigits: n >= 1000 ? 0 : 2 });
}
function fmtDate(d){
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); }
  catch(e){ return String(d).slice(0,10); }
}
function pct(part, whole){
  const w = Number(whole||0); if (!w) return '—';
  return Math.round((Number(part||0) / w) * 100) + '%';
}

async function api(path, opts){
  const r = await fetch('/api/marketing' + path, Object.assign(
    { credentials:'include', headers:{'Content-Type':'application/json'} }, opts||{}
  ));
  const j = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

function setHeader(tab){
  if (typeof _gwSetHeader === 'function') {
    _gwSetHeader('Marketing', [
      {id:'marketingCampaigns', label:'Campaigns'},
      {id:'marketingAudiences', label:'Audiences'},
      {id:'marketingBrand',     label:'Brand Kit'},
      {id:'marketingMedia',     label:'Media'},
      {id:'marketingForms',     label:'Forms'},
      {id:'marketingAnalytics', label:'Analytics'},
    ], tab);
  }
}

function shell(title, subtitle, actions, bodyHtml){
  return `
  <div class="gwp-shell mkt-shell" style="padding-top:12px">
    <header class="gwp-header" style="margin-bottom:14px">
      <div class="gwp-header-left">
        <h1 class="gwp-title">${esc(title)}</h1>
        <span class="gwp-subtitle">${esc(subtitle||'')}</span>
      </div>
      <div class="gwp-header-actions">${actions||''}</div>
    </header>
    ${bodyHtml}
  </div>`;
}

function emptyState(msg, actionHtml){
  return `<div class="card" style="padding:48px;text-align:center;color:var(--gw-muted)">
    <div style="margin-bottom:14px">${esc(msg)}</div>${actionHtml||''}</div>`;
}

function view(){ return document.getElementById('view'); }

function loading(label){
  const v = view(); if (!v) return;
  v.innerHTML = `<div style="padding:60px;text-align:center;color:var(--gw-muted)">${esc(label||'Loading…')}</div>`;
}

function fail(e){
  const v = view(); if (!v) return;
  v.innerHTML = `<div style="padding:40px;text-align:center;color:#A05050">${esc(e.message || String(e))}</div>`;
}

// Marketing-specific styling, injected once.
function ensureStyles(){
  if (document.getElementById('mkt-styles')) return;
  const s = document.createElement('style');
  s.id = 'mkt-styles';
  s.textContent = `
  .mkt-table{width:100%;border-collapse:collapse}
  .mkt-th{text-align:left;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;
          color:var(--gw-muted);padding:10px 12px;border-bottom:1px solid var(--gw-line)}
  .mkt-td{padding:12px;border-bottom:1px solid var(--gw-line);font-size:14px;vertical-align:middle}
  .mkt-row:hover{background:var(--gw-surface-2)}
  .mkt-pill{display:inline-block;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:800;
            text-transform:uppercase;letter-spacing:.03em}
  .mkt-pill--draft{background:#3a3f4a;color:#cfd5df}
  .mkt-pill--ready{background:#2a4a6a;color:#cfe3ff}
  .mkt-pill--scheduled{background:#4a3f1a;color:#ffe9b0}
  .mkt-pill--sending{background:#1f4a3a;color:#b6f0d5}
  .mkt-pill--sent{background:#2f6b4a;color:#fff}
  .mkt-pill--paused{background:#4a3a1f;color:#ffd9a0}
  .mkt-pill--cancelled,.mkt-pill--failed{background:#5a2a2a;color:#ffc9c9}
  .mkt-field{display:block;margin-bottom:12px}
  .mkt-field>span{display:block;font-size:11px;font-weight:800;color:var(--gw-muted);
                  text-transform:uppercase;letter-spacing:.04em;margin-bottom:5px}
  .mkt-field input,.mkt-field textarea,.mkt-field select{width:100%;padding:9px 11px;border-radius:9px;
      border:1px solid var(--gw-line);background:var(--gw-surface-2);color:inherit;font:inherit}
  .mkt-field textarea{min-height:80px;resize:vertical}
  .mkt-editor{display:grid;grid-template-columns:300px 1fr 380px;gap:14px;align-items:start}
  @media (max-width:1300px){.mkt-editor{grid-template-columns:1fr}}
  .mkt-blocklist{max-height:70vh;overflow:auto}
  .mkt-block{padding:10px 12px;border:1px solid var(--gw-line);border-radius:9px;margin-bottom:7px;
             cursor:pointer;background:var(--gw-surface-2)}
  .mkt-block.sel{border-color:#2f6b4a;box-shadow:0 0 0 1px #2f6b4a inset}
  .mkt-block-t{font-size:12px;font-weight:800}
  .mkt-block-s{font-size:11px;color:var(--gw-muted);margin-top:2px;overflow:hidden;
               text-overflow:ellipsis;white-space:nowrap}
  .mkt-preview{width:100%;height:78vh;border:1px solid var(--gw-line);border-radius:10px;background:#fff}
  .mkt-blockers{background:#4a3a1f;color:#ffd9a0;border-radius:9px;padding:12px 14px;margin-bottom:12px;font-size:13px}
  .mkt-blockers ul{margin:6px 0 0 18px}
  .mkt-warn{background:#5a2a2a;color:#ffc9c9;border-radius:9px;padding:12px 14px;margin-bottom:12px;font-size:13px}
  .mkt-rule{display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:7px;margin-bottom:7px;align-items:center}
  .mkt-assets{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
  .mkt-asset{border:1px solid var(--gw-line);border-radius:9px;overflow:hidden;background:var(--gw-surface-2)}
  .mkt-asset img{width:100%;height:110px;object-fit:cover;display:block}
  .mkt-asset-b{padding:8px 10px;font-size:11px}
  `;
  document.head.appendChild(s);
}

// ══ Dispatcher ═══════════════════════════════════════════════════════════════

function gwMarketing(tab){
  ensureStyles();
  tab = tab || window._mktTab || 'marketingCampaigns';
  window._mktTab = tab;
  window._currentView = tab;
  setHeader(tab);
  if (tab === 'marketingAudiences') return renderAudiences();
  if (tab === 'marketingBrand')     return renderBrand();
  if (tab === 'marketingMedia')     return renderMedia();
  if (tab === 'marketingForms')     return renderForms();
  if (tab === 'marketingAnalytics') return renderAnalytics();
  return renderCampaigns();
}
window.gwMarketing = gwMarketing;
window.marketingCampaigns = () => gwMarketing('marketingCampaigns');
window.marketingAudiences = () => gwMarketing('marketingAudiences');
window.marketingBrand     = () => gwMarketing('marketingBrand');
window.marketingMedia     = () => gwMarketing('marketingMedia');
window.marketingForms     = () => gwMarketing('marketingForms');
window.marketingAnalytics = () => gwMarketing('marketingAnalytics');

// ══ Campaigns list ═══════════════════════════════════════════════════════════

async function renderCampaigns(){
  loading('Loading campaigns…');
  try {
    const [{ campaigns }, { brand }] = await Promise.all([api('/campaigns'), api('/brand')]);
    M.campaigns = campaigns; M.brand = brand;

    const setupWarning = (!brand || !brand.physical_address)
      ? `<div class="mkt-blockers">Set up your <a href="#" onclick="gwMarketing('marketingBrand');return false"
           style="color:inherit;text-decoration:underline">brand kit</a> before sending.
           Commercial email is required by law to carry a postal address.</div>`
      : '';

    const rows = campaigns.map(c => `
      <tr class="mkt-row" style="cursor:pointer" onclick="window._mktOpen('${esc(c.id)}')">
        <td class="mkt-td">
          <div style="font-weight:700">${esc(c.name)}</div>
          <div style="font-size:12px;color:var(--gw-muted)">${esc(c.subject || 'No subject yet')}</div>
        </td>
        <td class="mkt-td"><span class="mkt-pill mkt-pill--${esc(c.status)}">${esc(c.status)}</span></td>
        <td class="mkt-td">${esc(c.audience_name || '—')}</td>
        <td class="mkt-td">${Number(c.sent_count||0).toLocaleString()} / ${Number(c.recipient_count||0).toLocaleString()}</td>
        <td class="mkt-td">${fmtDate(c.sent_at || c.scheduled_at || c.updated_at)}</td>
      </tr>`).join('');

    view().innerHTML = shell('Campaigns',
      `${campaigns.length} total`,
      canWrite() ? `<button class="gwp-btn-primary" onclick="window._mktNewCampaign()">+ New Campaign</button>` : '',
      setupWarning + (campaigns.length ? `
        <div class="card" style="padding:0;overflow:hidden">
          <table class="mkt-table"><thead><tr>
            <th class="mkt-th">Campaign</th><th class="mkt-th">Status</th>
            <th class="mkt-th">Audience</th><th class="mkt-th">Sent</th><th class="mkt-th">Date</th>
          </tr></thead><tbody>${rows}</tbody></table>
        </div>`
        : emptyState('No campaigns yet.',
            canWrite() ? `<button class="gwp-btn-primary" onclick="window._mktNewCampaign()">Create your first campaign</button>` : ''))
    );
  } catch(e){ fail(e); }
}

window._mktNewCampaign = async function(){
  const name = prompt('Campaign name');
  if (!name) return;
  try {
    const { id } = await api('/campaigns', { method:'POST', body: JSON.stringify({ name }) });
    window._mktOpen(id);
  } catch(e){ toast(e.message, 'error'); }
};

window._mktOpen = function(id){ marketingCampaign(id); };

// ══ Campaign editor ══════════════════════════════════════════════════════════

async function marketingCampaign(id){
  ensureStyles();
  window._currentView = 'marketingCampaigns';
  setHeader('marketingCampaigns');
  loading('Loading campaign…');
  try {
    const [camp, aud, snd, blocks] = await Promise.all([
      api('/campaigns/' + encodeURIComponent(id)),
      api('/audiences'),
      api('/senders'),
      api('/campaigns/blocks'),
    ]);
    M.campaign = camp.campaign;
    M.doc = camp.campaign.content || { version:1, blocks:[] };
    M.blockers = camp.blockers || [];
    M.audiences = aud.audiences;
    M.senders = snd.senders;
    M.blockTypes = blocks.types;
    M.selectedBlock = M.doc.blocks.length ? M.doc.blocks[0].id : null;
    drawEditor();
    refreshPreview();
  } catch(e){ fail(e); }
}
window.marketingCampaign = marketingCampaign;

function drawEditor(){
  const c = M.campaign;
  const locked = ['sending','sent','cancelled'].includes(c.status);

  const blockerHtml = M.blockers.length
    ? `<div class="mkt-blockers"><strong>Before this can send:</strong><ul>${
        M.blockers.map(b => `<li>${esc(b)}</li>`).join('')}</ul></div>` : '';

  view().innerHTML = shell(c.name,
    `${c.status}${c.recipient_count ? ' · ' + Number(c.recipient_count).toLocaleString() + ' recipients' : ''}`,
    `<button class="gwp-btn-ghost" onclick="gwMarketing('marketingCampaigns')">← Campaigns</button>
     ${c.status === 'sent' || c.status === 'sending'
       ? `<button class="gwp-btn-ghost" onclick="window._mktReport('${esc(c.id)}')">View report</button>` : ''}
     ${!locked && canWrite()
       ? `<button class="gwp-btn-ghost" onclick="window._mktTestSend()">Send test</button>
          <button class="gwp-btn-ghost" onclick="window._mktSave()">Save</button>
          <button class="gwp-btn-primary" onclick="window._mktReview()">Review &amp; send</button>` : ''}`,
    blockerHtml + `
    <div class="mkt-editor">
      <div class="card" style="padding:14px">
        <div style="font-size:12px;font-weight:800;margin-bottom:10px">CONTENT</div>
        <div class="mkt-blocklist" id="mkt-blocks">${blockListHtml()}</div>
        ${!locked ? `<select id="mkt-addblock" class="mkt-addblock" style="width:100%;margin-top:10px;padding:9px;
             border-radius:9px;border:1px solid var(--gw-line);background:var(--gw-surface-2);color:inherit">
          <option value="">+ Add a block…</option>
          ${M.blockTypes.map(t => `<option value="${esc(t.type)}">${esc(t.label)}</option>`).join('')}
        </select>` : ''}
      </div>

      <div class="card" style="padding:14px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div style="font-size:12px;font-weight:800">PREVIEW</div>
          <div style="font-size:11px;color:var(--gw-muted)">Rendered by the server — identical to what sends</div>
        </div>
        <iframe class="mkt-preview" id="mkt-preview" sandbox=""></iframe>
      </div>

      <div class="card" style="padding:14px">
        <div style="font-size:12px;font-weight:800;margin-bottom:10px">SETTINGS</div>
        <label class="mkt-field"><span>Subject</span>
          <input id="mkt-subject" value="${esc(c.subject)}" ${locked?'disabled':''}></label>
        <label class="mkt-field"><span>Preheader</span>
          <input id="mkt-preheader" value="${esc(c.preheader)}" ${locked?'disabled':''}></label>
        <label class="mkt-field"><span>Audience</span>
          <select id="mkt-audience" ${locked?'disabled':''}>
            <option value="">— choose —</option>
            ${M.audiences.map(a => `<option value="${esc(a.id)}" ${a.id===c.audience_id?'selected':''}>${esc(a.name)}</option>`).join('')}
          </select></label>
        <label class="mkt-field"><span>Send from</span>
          <select id="mkt-sender" ${locked?'disabled':''}>
            <option value="">— choose —</option>
            ${M.senders.map(s => `<option value="${esc(s.id)}" ${s.id===c.sender_identity_id?'selected':''}>
              ${esc(s.from_email)}${s.verified ? '' : ' (unverified)'}</option>`).join('')}
          </select></label>
        <label class="mkt-field"><span>Theme</span>
          <select id="mkt-theme" ${locked?'disabled':''}>
            <option value="brand_dark" ${c.theme==='brand_dark'?'selected':''}>Dark</option>
            <option value="brand_light" ${c.theme==='brand_light'?'selected':''}>Light</option>
          </select></label>

        <div style="border-top:1px solid var(--gw-line);margin:14px 0;padding-top:14px">
          <div style="font-size:12px;font-weight:800;margin-bottom:8px">BLOCK</div>
          <div id="mkt-blockform">${blockFormHtml()}</div>
        </div>

        ${!locked && canWrite() ? `
        <div style="border-top:1px solid var(--gw-line);margin:14px 0;padding-top:14px">
          <div style="font-size:12px;font-weight:800;margin-bottom:8px">AI COPILOT</div>
          <label class="mkt-field"><span>What should this campaign do?</span>
            <textarea id="mkt-aiprompt" placeholder="A spring irrigation start-up campaign for residential clients who bought it last year"></textarea></label>
          <button class="gwp-btn-ghost" style="width:100%" onclick="window._mktAiDraft()">Draft with AI</button>
          <div id="mkt-airesult" style="font-size:12px;color:var(--gw-muted);margin-top:8px"></div>
        </div>` : ''}
      </div>
    </div>`);

  const add = document.getElementById('mkt-addblock');
  if (add) add.addEventListener('change', () => { if (add.value) { addBlock(add.value); add.value=''; } });

  ['mkt-subject','mkt-preheader','mkt-theme'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => { M.dirty = true; schedulePreview(); });
  });
  ['mkt-audience','mkt-sender'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => { M.dirty = true; });
  });
}

function blockLabel(type){
  const t = M.blockTypes.find(x => x.type === type);
  return t ? t.label : type;
}

function blockSummary(b){
  return b.headline || b.text || b.quote || b.caption || b.sign_off || b.body || '';
}

function blockListHtml(){
  if (!M.doc.blocks.length) return `<div style="color:var(--gw-muted);font-size:13px">No blocks yet. Add one below.</div>`;
  return M.doc.blocks.map((b, i) => `
    <div class="mkt-block ${b.id===M.selectedBlock?'sel':''}" onclick="window._mktSelect('${esc(b.id)}')">
      <div style="display:flex;justify-content:space-between;gap:6px;align-items:center">
        <div style="min-width:0">
          <div class="mkt-block-t">${esc(blockLabel(b.type))}</div>
          <div class="mkt-block-s">${esc(blockSummary(b) || '—')}</div>
        </div>
        <div style="display:flex;gap:2px;flex-shrink:0">
          <button class="gwp-btn-ghost" style="padding:2px 6px" title="Move up"
            onclick="event.stopPropagation();window._mktMove(${i},-1)">↑</button>
          <button class="gwp-btn-ghost" style="padding:2px 6px" title="Move down"
            onclick="event.stopPropagation();window._mktMove(${i},1)">↓</button>
          <button class="gwp-btn-ghost" style="padding:2px 6px" title="Remove"
            onclick="event.stopPropagation();window._mktRemove('${esc(b.id)}')">×</button>
        </div>
      </div>
    </div>`).join('');
}

// Per-block edit form. This is editor chrome — it edits fields on the block
// object. It never produces email markup.
function blockFormHtml(){
  const b = M.doc.blocks.find(x => x.id === M.selectedBlock);
  if (!b) return `<div style="color:var(--gw-muted);font-size:13px">Select a block to edit it.</div>`;
  const f = (key, label, type) => {
    if (!(key in b)) return '';
    const v = esc(b[key] == null ? '' : b[key]);
    if (type === 'area') return `<label class="mkt-field"><span>${esc(label)}</span>
      <textarea data-bk="${key}">${v}</textarea></label>`;
    return `<label class="mkt-field"><span>${esc(label)}</span>
      <input data-bk="${key}" value="${v}"></label>`;
  };
  const cta = ('cta' in b) ? `
    <label class="mkt-field"><span>Button label</span>
      <input data-bcta="label" value="${esc(b.cta ? b.cta.label : '')}"></label>
    <label class="mkt-field"><span>Button link</span>
      <input data-bcta="url" placeholder="https://…" value="${esc(b.cta ? b.cta.url : '')}"></label>` : '';
  const items = ('items' in b) ? `
    <label class="mkt-field"><span>Items — one per line, "Title | description"</span>
      <textarea data-bitems="1">${esc((b.items||[]).map(i => i.title + (i.body ? ' | ' + i.body : '')).join('\n'))}</textarea></label>` : '';
  const image = ('image_asset_id' in b) ? `
    <label class="mkt-field"><span>Image</span>
      <input data-bk="image_asset_id" placeholder="asset id" value="${esc(b.image_asset_id||'')}"></label>
    <button class="gwp-btn-ghost" style="width:100%;margin-bottom:12px" onclick="window._mktPickImage()">Choose from media…</button>` : '';

  return `<div style="font-size:11px;color:var(--gw-muted);margin-bottom:8px">${esc(blockLabel(b.type))}</div>
    ${f('headline','Headline')}${f('subhead','Subhead')}${f('text','Text','area')}
    ${f('body','Body','area')}${f('quote','Quote','area')}${f('attribution','Attribution')}
    ${f('role','Role')}${f('caption','Caption')}${f('sign_off','Sign-off','area')}
    ${image}${items}${cta}`;
}

function bindBlockForm(){
  const b = M.doc.blocks.find(x => x.id === M.selectedBlock);
  if (!b) return;
  document.querySelectorAll('#mkt-blockform [data-bk]').forEach(el => {
    el.addEventListener('input', () => { b[el.dataset.bk] = el.value; M.dirty = true; refreshBlockList(); schedulePreview(); });
  });
  document.querySelectorAll('#mkt-blockform [data-bcta]').forEach(el => {
    el.addEventListener('input', () => {
      const label = document.querySelector('#mkt-blockform [data-bcta="label"]');
      const url   = document.querySelector('#mkt-blockform [data-bcta="url"]');
      const l = label ? label.value.trim() : '', u = url ? url.value.trim() : '';
      b.cta = (l && u) ? { label:l, url:u } : null;
      M.dirty = true; schedulePreview();
    });
  });
  const items = document.querySelector('#mkt-blockform [data-bitems]');
  if (items) items.addEventListener('input', () => {
    b.items = items.value.split('\n').filter(l => l.trim()).map(line => {
      const parts = line.split('|');
      return { title: (parts[0]||'').trim(), body: (parts[1]||'').trim() };
    });
    M.dirty = true; schedulePreview();
  });
}

function refreshBlockList(){
  const el = document.getElementById('mkt-blocks');
  if (el) el.innerHTML = blockListHtml();
}
function refreshBlockForm(){
  const el = document.getElementById('mkt-blockform');
  if (el) { el.innerHTML = blockFormHtml(); bindBlockForm(); }
}

window._mktSelect = function(id){ M.selectedBlock = id; refreshBlockList(); refreshBlockForm(); };
window._mktMove = function(i, dir){
  const j = i + dir;
  if (j < 0 || j >= M.doc.blocks.length) return;
  const tmp = M.doc.blocks[i]; M.doc.blocks[i] = M.doc.blocks[j]; M.doc.blocks[j] = tmp;
  M.dirty = true; refreshBlockList(); schedulePreview();
};
window._mktRemove = function(id){
  M.doc.blocks = M.doc.blocks.filter(b => b.id !== id);
  if (M.selectedBlock === id) M.selectedBlock = M.doc.blocks.length ? M.doc.blocks[0].id : null;
  M.dirty = true; refreshBlockList(); refreshBlockForm(); schedulePreview();
};

function addBlock(type){
  const tpl = M.blockTypes.find(t => t.type === type);
  if (!tpl) return;
  const b = JSON.parse(JSON.stringify(tpl.template));
  b.id = type + '_' + Math.random().toString(36).slice(2, 9);
  M.doc.blocks.push(b);
  M.selectedBlock = b.id;
  M.dirty = true;
  refreshBlockList(); refreshBlockForm(); schedulePreview();
}

// ── Preview: always a server round-trip ──────────────────────────────────────

function schedulePreview(){
  clearTimeout(M.previewTimer);
  M.previewTimer = setTimeout(refreshPreview, 350);
}

async function refreshPreview(){
  const frame = document.getElementById('mkt-preview');
  if (!frame || !M.campaign) return;
  const subj = document.getElementById('mkt-subject');
  const pre  = document.getElementById('mkt-preheader');
  const thm  = document.getElementById('mkt-theme');
  try {
    const res = await api('/campaigns/' + encodeURIComponent(M.campaign.id) + '/preview', {
      method:'POST',
      body: JSON.stringify({
        content: M.doc,
        subject: subj ? subj.value : undefined,
        preheader: pre ? pre.value : undefined,
        theme: thm ? thm.value : undefined,
      }),
    });
    // srcdoc + sandbox: the preview is inert, and the bytes are the server's.
    frame.srcdoc = res.html;
  } catch(e){
    frame.srcdoc = '<p style="font-family:sans-serif;padding:20px;color:#a05050">Preview failed: '
      + esc(e.message) + '</p>';
  }
}

// ── Save / review / approve ──────────────────────────────────────────────────

function collectSettings(){
  const g = id => { const el = document.getElementById(id); return el ? el.value : ''; };
  return {
    name: M.campaign.name,
    subject: g('mkt-subject'),
    preheader: g('mkt-preheader'),
    theme: g('mkt-theme'),
    audience_id: g('mkt-audience'),
    sender_identity_id: g('mkt-sender'),
    content: M.doc,
    content_revision: M.campaign.content_revision,
  };
}

window._mktSave = async function(){
  try {
    const res = await api('/campaigns/' + encodeURIComponent(M.campaign.id), {
      method:'PUT', body: JSON.stringify(collectSettings()),
    });
    M.campaign.content_revision = res.content_revision;
    M.dirty = false;
    toast('Saved');
  } catch(e){
    if (/another tab/.test(e.message)) toast('This campaign changed elsewhere — reload before saving.', 'error');
    else toast(e.message, 'error');
  }
};

window._mktTestSend = async function(){
  const to = prompt('Send a test to which address?');
  if (!to) return;
  try {
    await window._mktSave();
    await api('/campaigns/' + encodeURIComponent(M.campaign.id) + '/test-send', {
      method:'POST', body: JSON.stringify({ to }),
    });
    toast('Test sent to ' + to);
  } catch(e){ toast(e.message, 'error'); }
};

/**
 * Review freezes the audience and renders. The count it returns is the number
 * the operator then has to confirm — the server rejects an approve whose
 * expected_recipient_count does not match, so this is not a formality.
 */
window._mktReview = async function(){
  try {
    await window._mktSave();
    const r = await api('/campaigns/' + encodeURIComponent(M.campaign.id) + '/review', { method:'POST' });
    if (r.blockers && r.blockers.length) {
      M.blockers = r.blockers;
      drawEditor(); bindBlockForm(); refreshPreview();
      toast('Not ready to send yet', 'error');
      return;
    }
    const warn = (r.warnings && r.warnings.length)
      ? '\n\nWarnings:\n' + r.warnings.join('\n') : '';
    const ok = confirm(
      `Send "${M.campaign.name}" to ${r.recipients.toLocaleString()} recipients?\n\n` +
      `${r.suppressed} suppressed address(es) were excluded.\n` +
      `This cannot be undone once sending starts.${warn}`
    );
    if (!ok) return;

    await api('/campaigns/' + encodeURIComponent(M.campaign.id) + '/approve', {
      method:'POST',
      body: JSON.stringify({ confirm: true, expected_recipient_count: r.recipients }),
    });
    toast('Sending started');
    gwMarketing('marketingCampaigns');
  } catch(e){
    if (/audience changed/.test(e.message)) toast('The audience changed while you were reviewing — review again.', 'error');
    else toast(e.message, 'error');
  }
};

window._mktAiDraft = async function(){
  const el = document.getElementById('mkt-aiprompt');
  const out = document.getElementById('mkt-airesult');
  const prompt = el ? el.value.trim() : '';
  if (!prompt) { toast('Describe what the campaign should do first', 'error'); return; }
  out.textContent = 'Drafting…';
  try {
    const r = await fetch('/api/marketing/ai/copilot', {
      method:'POST', credentials:'include', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ prompt, campaign_id: M.campaign.id }),
    });
    const j = await r.json();
    if (!r.ok || j.ok === false) throw new Error(j.message || j.error || 'AI failed');
    const d = j.draft;
    M.doc = d.content;
    M.selectedBlock = M.doc.blocks.length ? M.doc.blocks[0].id : null;
    if (d.subject) M.campaign.subject = d.subject;
    if (d.preheader) M.campaign.preheader = d.preheader;
    if (d.audience_id) M.campaign.audience_id = d.audience_id;
    M.dirty = true;
    drawEditor(); bindBlockForm(); refreshPreview();
    const note = document.getElementById('mkt-airesult');
    if (note) note.textContent = d.rationale || 'Draft ready — review it before sending.';
    toast('Draft ready — review before sending');
  } catch(e){ out.textContent = e.message; toast(e.message, 'error'); }
};

window._mktPickImage = async function(){
  try {
    const { assets } = await api('/assets?approved=1');
    if (!assets.length) { toast('No approved images yet — add some in Media', 'error'); return; }
    const choice = prompt('Asset id:\n\n' + assets.slice(0,20).map(a => a.id + '  ' + a.file_name).join('\n'));
    if (!choice) return;
    const b = M.doc.blocks.find(x => x.id === M.selectedBlock);
    if (b && 'image_asset_id' in b) { b.image_asset_id = choice.trim(); M.dirty = true; refreshBlockForm(); schedulePreview(); }
  } catch(e){ toast(e.message, 'error'); }
};

// ══ Report ═══════════════════════════════════════════════════════════════════

window._mktReport = async function(id){
  loading('Loading report…');
  try {
    const r = await api('/campaigns/' + encodeURIComponent(id) + '/report');
    const d = r.delivery || {}, o = r.outcomes || {};
    const kpi = (v, l) => `<div class="gwp-kpi-card"><div class="gwp-kpi-body">
      <div class="gwp-kpi-value">${v}</div><div class="gwp-kpi-label">${esc(l)}</div></div></div>`;

    view().innerHTML = shell(r.campaign.name, r.campaign.subject,
      `<button class="gwp-btn-ghost" onclick="window._mktOpen('${esc(id)}')">← Campaign</button>`,
      `<div class="gwp-kpi-row" style="margin-bottom:14px">
        ${kpi(Number(d.sent||0).toLocaleString(), 'Sent')}
        ${kpi(pct(d.delivered, d.sent), 'Delivered')}
        ${kpi(pct(d.opened, d.sent), 'Opened')}
        ${kpi(pct(d.clicked, d.sent), 'Clicked')}
        ${kpi(Number((o.inquiry||{}).count||0), 'Inquiries')}
        ${kpi(Number((o.job_sold||{}).count||0), 'Jobs sold')}
        ${kpi(money((o.job_sold||{}).amount_cents||0), 'Revenue')}
        ${kpi(money(r.revenue_per_recipient_cents||0), 'Per recipient')}
      </div>
      <div class="card" style="padding:0;overflow:hidden;margin-bottom:14px">
        <table class="mkt-table"><thead><tr>
          <th class="mkt-th">Link</th><th class="mkt-th">Destination</th><th class="mkt-th">Clicks</th>
        </tr></thead><tbody>
        ${(r.links||[]).map(l => `<tr><td class="mkt-td">${esc(l.label)}</td>
          <td class="mkt-td" style="font-size:12px;color:var(--gw-muted)">${esc(l.target_url)}</td>
          <td class="mkt-td">${Number(l.clicks||0)}</td></tr>`).join('')
          || `<tr><td class="mkt-td" colspan="3" style="color:var(--gw-muted)">No tracked links.</td></tr>`}
        </tbody></table>
      </div>
      <div class="card" style="padding:14px;font-size:13px;color:var(--gw-muted)">
        ${Number(d.bounced||0)} bounced · ${Number(d.suppressed||0)} suppressed ·
        ${Number(d.unsubscribed||0)} unsubscribed · ${Number(d.complained||0)} complaints ·
        ${Number(d.failed||0)} failed · ${Number(d.pending||0)} still queued
      </div>`);
  } catch(e){ fail(e); }
};

// ══ Audiences ════════════════════════════════════════════════════════════════

async function renderAudiences(){
  loading('Loading audiences…');
  try {
    const [{ audiences }, fields] = await Promise.all([api('/audiences'), api('/audiences/fields')]);
    M.audiences = audiences; M.audienceFields = fields;

    view().innerHTML = shell('Audiences', `${audiences.length} saved`,
      canWrite() ? `<button class="gwp-btn-primary" onclick="window._mktNewAudience()">+ New Audience</button>` : '',
      audiences.length ? `<div class="card" style="padding:0;overflow:hidden">
        <table class="mkt-table"><thead><tr>
          <th class="mkt-th">Name</th><th class="mkt-th">Targets</th><th class="mkt-th">Last count</th><th class="mkt-th"></th>
        </tr></thead><tbody>
        ${audiences.map(a => `<tr class="mkt-row">
          <td class="mkt-td"><div style="font-weight:700">${esc(a.name)}</div>
            <div style="font-size:12px;color:var(--gw-muted)">${esc(a.description||'')}</div></td>
          <td class="mkt-td" style="font-size:12px">${esc(a.description_text||'')}</td>
          <td class="mkt-td">${Number(a.last_count||0).toLocaleString()}</td>
          <td class="mkt-td" style="text-align:right">
            <button class="gwp-btn-ghost" onclick="window._mktCountAudience('${esc(a.id)}')">Count</button>
            ${canWrite()?`<button class="gwp-btn-ghost" onclick="window._mktEditAudience('${esc(a.id)}')">Edit</button>`:''}
          </td></tr>`).join('')}
        </tbody></table></div>`
      : emptyState('No audiences yet.',
          canWrite() ? `<button class="gwp-btn-primary" onclick="window._mktNewAudience()">Create one</button>` : ''));
  } catch(e){ fail(e); }
}

window._mktCountAudience = async function(id){
  const a = M.audiences.find(x => x.id === id);
  if (!a) return;
  try {
    const r = await api('/audiences/preview', { method:'POST', body: JSON.stringify({ filter: JSON.parse(a.filter_json) }) });
    alert(`${a.name}\n\n${r.count.toLocaleString()} people will receive this.\n` +
          `${r.suppressed} suppressed address(es) excluded.\n\n` +
          (r.warnings.length ? 'Warnings:\n' + r.warnings.join('\n') + '\n\n' : '') +
          'Sample:\n' + r.sample.slice(0,10).map(s => '· ' + (s.full_name||'') + ' <' + s.email + '>').join('\n'));
  } catch(e){ toast(e.message, 'error'); }
};

function audienceEditor(existing){
  const filter = existing ? JSON.parse(existing.filter_json) : { version:1, match:'all', sources:['contacts','clients'], rules:[] };
  M.editFilter = filter;
  M.editAudience = existing || null;

  const fieldOpts = (M.audienceFields.fields || []).map(f => `<option value="${esc(f.key)}">${esc(f.label)}</option>`).join('')
    + (M.audienceFields.history_fields || []).map(f => `<option value="${esc(f)}">${esc(f.replace(/_/g,' '))}</option>`).join('');

  view().innerHTML = shell(existing ? 'Edit audience' : 'New audience', '',
    `<button class="gwp-btn-ghost" onclick="gwMarketing('marketingAudiences')">← Audiences</button>`,
    `<div class="card" style="padding:16px;max-width:820px">
      <label class="mkt-field"><span>Name</span><input id="mkt-aud-name" value="${esc(existing?existing.name:'')}"></label>
      <label class="mkt-field"><span>Description</span><input id="mkt-aud-desc" value="${esc(existing?existing.description:'')}"></label>
      <label class="mkt-field"><span>Draw from</span>
        <select id="mkt-aud-sources">
          <option value="contacts,clients" ${(filter.sources||[]).join(',')==='contacts,clients'?'selected':''}>Clients and their contacts</option>
          <option value="contacts,clients,leads" ${(filter.sources||[]).join(',')==='contacts,clients,leads'?'selected':''}>Clients, contacts and unconverted leads</option>
          <option value="leads" ${(filter.sources||[]).join(',')==='leads'?'selected':''}>Unconverted leads only</option>
        </select></label>
      <label class="mkt-field"><span>Match</span>
        <select id="mkt-aud-match">
          <option value="all" ${filter.match==='all'?'selected':''}>All of these rules</option>
          <option value="any" ${filter.match==='any'?'selected':''}>Any of these rules</option>
        </select></label>

      <div style="font-size:11px;font-weight:800;color:var(--gw-muted);text-transform:uppercase;margin:14px 0 7px">Rules</div>
      <div id="mkt-rules"></div>
      <button class="gwp-btn-ghost" onclick="window._mktAddRule()">+ Add rule</button>

      <div style="border-top:1px solid var(--gw-line);margin-top:16px;padding-top:16px;display:flex;gap:8px">
        <button class="gwp-btn-ghost" onclick="window._mktPreviewAudience()">Preview count</button>
        <button class="gwp-btn-primary" onclick="window._mktSaveAudience()">Save audience</button>
      </div>
      <div id="mkt-aud-preview" style="margin-top:12px;font-size:13px;color:var(--gw-muted)"></div>
    </div>
    <template id="mkt-fieldopts">${fieldOpts}</template>`);
  drawRules();
}

function drawRules(){
  const host = document.getElementById('mkt-rules');
  const opts = document.getElementById('mkt-fieldopts').innerHTML;
  host.innerHTML = M.editFilter.rules.map((r, i) => `
    <div class="mkt-rule">
      <select data-r="${i}" data-k="field">${opts}</select>
      <select data-r="${i}" data-k="op">
        ${['in','not_in','eq','neq','contains','not_contains','before','after','is_empty','not_empty']
          .map(o => `<option value="${o}">${o.replace(/_/g,' ')}</option>`).join('')}
      </select>
      <input data-r="${i}" data-k="value" placeholder="value (comma-separated for lists)" value="${esc(Array.isArray(r.value)?r.value.join(', '):(r.value||''))}">
      <button class="gwp-btn-ghost" onclick="window._mktDelRule(${i})">×</button>
    </div>`).join('') || `<div style="color:var(--gw-muted);font-size:13px;margin-bottom:8px">No rules — everyone in the selected sources.</div>`;

  M.editFilter.rules.forEach((r, i) => {
    const fs = host.querySelector(`[data-r="${i}"][data-k="field"]`);
    const os = host.querySelector(`[data-r="${i}"][data-k="op"]`);
    if (fs) fs.value = r.field || '';
    if (os) os.value = r.op || 'in';
  });
  host.querySelectorAll('[data-r]').forEach(el => {
    el.addEventListener('input', () => {
      const i = Number(el.dataset.r), k = el.dataset.k;
      if (k === 'value') {
        M.editFilter.rules[i].value = el.value.includes(',')
          ? el.value.split(',').map(s => s.trim()).filter(Boolean)
          : el.value;
      } else {
        M.editFilter.rules[i][k] = el.value;
      }
    });
  });
}

window._mktAddRule = function(){ M.editFilter.rules.push({ field:'client_type', op:'in', value:'' }); drawRules(); };
window._mktDelRule = function(i){ M.editFilter.rules.splice(i,1); drawRules(); };

function currentFilter(){
  const g = id => { const el = document.getElementById(id); return el ? el.value : ''; };
  return Object.assign({}, M.editFilter, {
    match: g('mkt-aud-match'),
    sources: g('mkt-aud-sources').split(','),
  });
}

window._mktPreviewAudience = async function(){
  const out = document.getElementById('mkt-aud-preview');
  out.textContent = 'Counting…';
  try {
    const r = await api('/audiences/preview', { method:'POST', body: JSON.stringify({ filter: currentFilter() }) });
    out.innerHTML = `<strong>${r.count.toLocaleString()}</strong> people · ${r.suppressed} suppressed and excluded<br>
      <span style="font-size:12px">${esc(r.description)}</span>
      ${r.warnings.length ? `<div class="mkt-warn" style="margin-top:8px">${r.warnings.map(esc).join('<br>')}</div>` : ''}
      ${r.sample.length ? `<div style="margin-top:8px;font-size:12px">${
        r.sample.slice(0,8).map(s => esc((s.full_name||'') + ' <' + s.email + '>')).join('<br>')}</div>` : ''}`;
  } catch(e){ out.textContent = e.message; }
};

window._mktSaveAudience = async function(){
  const name = document.getElementById('mkt-aud-name').value.trim();
  if (!name) { toast('Name is required', 'error'); return; }
  const payload = {
    name,
    description: document.getElementById('mkt-aud-desc').value,
    filter: currentFilter(),
  };
  try {
    if (M.editAudience) await api('/audiences/' + encodeURIComponent(M.editAudience.id), { method:'PUT', body: JSON.stringify(payload) });
    else await api('/audiences', { method:'POST', body: JSON.stringify(payload) });
    toast('Saved');
    gwMarketing('marketingAudiences');
  } catch(e){ toast(e.message, 'error'); }
};

window._mktNewAudience = function(){ audienceEditor(null); };
window._mktEditAudience = function(id){ audienceEditor(M.audiences.find(a => a.id === id)); };

// ══ Brand kit ════════════════════════════════════════════════════════════════

async function renderBrand(){
  loading('Loading brand kit…');
  try {
    const [{ brand }, { senders }, { profiles }] = await Promise.all([
      api('/brand'), api('/senders'), api('/service-profiles'),
    ]);
    M.brand = brand; M.senders = senders; M.services = profiles;
    const colors = brand ? (JSON.parse(brand.colors_json || '{}')) : {};

    view().innerHTML = shell('Brand Kit', 'How your campaigns look and who they come from', '',
      `<div class="card" style="padding:16px;max-width:760px;margin-bottom:14px">
        <label class="mkt-field"><span>Company name as it appears in email</span>
          <input id="mkt-b-name" value="${esc(brand?brand.name:'')}"></label>
        <label class="mkt-field"><span>Postal address — required by law in every campaign</span>
          <input id="mkt-b-addr" value="${esc(brand?brand.physical_address:'')}"
            placeholder="1420 Old Bridge Rd, Woodbridge, VA 22192"></label>
        <label class="mkt-field"><span>Accent colour</span>
          <input id="mkt-b-accent" type="text" placeholder="#2f6b4a" value="${esc(colors.accent||'')}"></label>
        <label class="mkt-field"><span>Logo asset id</span>
          <input id="mkt-b-logo" value="${esc(brand?(brand.logo_light_asset_id||''):'')}"></label>
        ${canWrite()?`<button class="gwp-btn-primary" onclick="window._mktSaveBrand()">Save brand kit</button>`:''}
      </div>

      <div class="card" style="padding:16px;max-width:760px;margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div style="font-weight:800">Sending addresses</div>
          ${canWrite()?`<button class="gwp-btn-ghost" onclick="window._mktNewSender()">+ Add address</button>`:''}
        </div>
        <div style="font-size:12px;color:var(--gw-muted);margin-bottom:10px">
          A campaign cannot be sent from an unverified domain — the mail would fail SPF and DKIM
          alignment and land in spam.
        </div>
        ${senders.map(s => `<div style="display:flex;justify-content:space-between;align-items:center;
             padding:10px 0;border-top:1px solid var(--gw-line)">
          <div><div style="font-weight:700">${esc(s.from_email)}</div>
            <div style="font-size:12px;color:var(--gw-muted)">${s.verified ? 'Verified' : 'Not verified — add the DNS records below'}</div></div>
          <div>
            <button class="gwp-btn-ghost" onclick="window._mktShowDns('${esc(s.id)}')">DNS</button>
            <button class="gwp-btn-ghost" onclick="window._mktVerifySender('${esc(s.id)}')">Verify</button>
          </div></div>`).join('') || `<div style="color:var(--gw-muted);font-size:13px">No sending address yet.</div>`}
      </div>

      <div class="card" style="padding:16px;max-width:760px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div style="font-weight:800">Services you market</div>
          ${canWrite()?`<button class="gwp-btn-ghost" onclick="window._mktNewService()">+ Add service</button>`:''}
        </div>
        <div style="font-size:12px;color:var(--gw-muted);margin-bottom:10px">
          What the AI copilot is allowed to say about each service, and what it must not claim.
        </div>
        ${profiles.map(p => `<div style="padding:10px 0;border-top:1px solid var(--gw-line)">
          <div style="font-weight:700">${esc(p.name)}</div>
          <div style="font-size:12px;color:var(--gw-muted)">${esc(p.season||'')} ${esc(p.customer_type||'')}</div>
        </div>`).join('') || `<div style="color:var(--gw-muted);font-size:13px">No service profiles yet.</div>`}
      </div>`);
  } catch(e){ fail(e); }
}

window._mktSaveBrand = async function(){
  const g = id => document.getElementById(id).value;
  try {
    await api('/brand', { method:'PUT', body: JSON.stringify({
      name: g('mkt-b-name'),
      physical_address: g('mkt-b-addr'),
      colors: g('mkt-b-accent') ? { accent: g('mkt-b-accent') } : {},
      logo_light_asset_id: g('mkt-b-logo'),
    })});
    toast('Brand kit saved');
    renderBrand();
  } catch(e){ toast(e.message, 'error'); }
};

window._mktNewSender = async function(){
  const email = prompt('Send campaigns from which address?\n\ne.g. hello@avalon-lc.com');
  if (!email) return;
  const name = prompt('Display name?') || '';
  try {
    const r = await api('/senders', { method:'POST', body: JSON.stringify({ from_email: email, from_name: name }) });
    alert('Add these DNS records to your domain, then press Verify:\n\n' +
      (r.records||[]).map(x => `${x.type}  ${x.host}  →  ${x.data}`).join('\n'));
    renderBrand();
  } catch(e){ toast(e.message, 'error'); }
};

window._mktShowDns = function(id){
  const s = M.senders.find(x => x.id === id);
  if (!s) return;
  let recs = [];
  try { recs = JSON.parse(s.dns_records_json || '[]'); } catch(e){}
  alert(recs.length
    ? 'Add these records to your DNS:\n\n' + recs.map(x => `${x.type}  ${x.host}  →  ${x.data}`).join('\n')
    : 'No DNS records recorded for this address.');
};

window._mktVerifySender = async function(id){
  try {
    const r = await api('/senders/' + encodeURIComponent(id) + '/verify', { method:'POST' });
    toast(r.verified ? 'Domain verified' : 'Not verified yet — DNS can take a while to propagate',
          r.verified ? 'success' : 'error');
    renderBrand();
  } catch(e){ toast(e.message, 'error'); }
};

window._mktNewService = async function(){
  const name = prompt('Service name');
  if (!name) return;
  try { await api('/service-profiles', { method:'POST', body: JSON.stringify({ name }) }); renderBrand(); }
  catch(e){ toast(e.message, 'error'); }
};

// ══ Media ════════════════════════════════════════════════════════════════════

async function renderMedia(){
  loading('Loading media…');
  try {
    const { assets } = await api('/assets');
    M.assets = assets;
    view().innerHTML = shell('Media', `${assets.length} images`,
      canWrite() ? `<label class="gwp-btn-primary" style="cursor:pointer">+ Upload
        <input type="file" accept="image/*" style="display:none" onchange="window._mktUpload(this)"></label>` : '',
      assets.length ? `<div class="mkt-assets">${assets.map(a => `
        <div class="mkt-asset">
          <img src="/m/a/${esc(a.id)}" alt="${esc(a.alt_text||a.file_name)}" loading="lazy">
          <div class="mkt-asset-b">
            <div style="font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.file_name)}</div>
            <div style="color:var(--gw-muted);margin:3px 0">${a.approved_for_marketing ? 'Approved' : 'Not approved'}</div>
            <div style="font-size:10px;color:var(--gw-muted);word-break:break-all">${esc(a.id)}</div>
            ${canWrite()?`<button class="gwp-btn-ghost" style="width:100%;margin-top:6px"
              onclick="window._mktToggleApprove('${esc(a.id)}',${a.approved_for_marketing?0:1})">
              ${a.approved_for_marketing?'Unapprove':'Approve'}</button>`:''}
          </div>
        </div>`).join('')}</div>`
      : emptyState('No marketing images yet. Upload one, or import from job photos.'));
  } catch(e){ fail(e); }
}

window._mktUpload = async function(input){
  const file = input.files && input.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  fd.append('approved_for_marketing', '1');
  try {
    const r = await fetch('/api/marketing/assets', { method:'POST', credentials:'include', body: fd });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Upload failed');
    toast('Uploaded');
    renderMedia();
  } catch(e){ toast(e.message, 'error'); }
};

window._mktToggleApprove = async function(id, approved){
  const a = M.assets.find(x => x.id === id) || {};
  try {
    await api('/assets/' + encodeURIComponent(id), { method:'PUT', body: JSON.stringify({
      alt_text: a.alt_text || '', tags: [], approved_for_marketing: !!approved,
    })});
    renderMedia();
  } catch(e){ toast(e.message, 'error'); }
};

// ══ Forms ════════════════════════════════════════════════════════════════════

async function renderForms(){
  loading('Loading forms…');
  try {
    const { forms } = await api('/forms');
    M.forms = forms;
    view().innerHTML = shell('Inquiry Forms', `${forms.length} forms`,
      canWrite() ? `<button class="gwp-btn-primary" onclick="window._mktNewForm()">+ New Form</button>` : '',
      forms.length ? `<div class="card" style="padding:0;overflow:hidden">
        <table class="mkt-table"><thead><tr>
          <th class="mkt-th">Form</th><th class="mkt-th">Public link</th>
          <th class="mkt-th">Submissions</th><th class="mkt-th">Active</th>
        </tr></thead><tbody>
        ${forms.map(f => `<tr class="mkt-row">
          <td class="mkt-td"><div style="font-weight:700">${esc(f.name)}</div>
            <div style="font-size:12px;color:var(--gw-muted)">${esc(f.headline||'')}</div></td>
          <td class="mkt-td"><a href="/f/${esc(f.public_token)}" target="_blank" rel="noopener"
            style="font-size:12px">/f/${esc(f.public_token)}</a></td>
          <td class="mkt-td">${Number(f.submission_count||0)}</td>
          <td class="mkt-td">${f.active ? 'Yes' : 'No'}</td>
        </tr>`).join('')}
        </tbody></table></div>`
      : emptyState('No inquiry forms yet. A form gives campaign buttons somewhere to point, and turns a click into a lead.',
          canWrite() ? `<button class="gwp-btn-primary" onclick="window._mktNewForm()">Create one</button>` : ''));
  } catch(e){ fail(e); }
}

window._mktNewForm = async function(){
  const name = prompt('Form name (internal)');
  if (!name) return;
  const headline = prompt('Headline shown to the visitor') || name;
  try {
    await api('/forms', { method:'POST', body: JSON.stringify({
      name, headline,
      fields: [{ key:'message', label:'What do you need?', type:'textarea', required:false }],
    })});
    renderForms();
  } catch(e){ toast(e.message, 'error'); }
};

// ══ Analytics ════════════════════════════════════════════════════════════════

async function renderAnalytics(){
  loading('Loading…');
  try {
    const o = await api('/overview');
    M.overview = o;
    const a = o.attribution || {}, c = o.campaigns || {};
    const kpi = (v, l) => `<div class="gwp-kpi-card"><div class="gwp-kpi-body">
      <div class="gwp-kpi-value">${v}</div><div class="gwp-kpi-label">${esc(l)}</div></div></div>`;

    view().innerHTML = shell('Marketing Analytics', 'Across every campaign', '',
      `<div class="gwp-kpi-row" style="margin-bottom:14px">
        ${kpi(Number(c.sent||0), 'Campaigns sent')}
        ${kpi(Number(c.in_flight||0), 'In flight')}
        ${kpi(Number((a.inquiry||{}).count||0), 'Inquiries')}
        ${kpi(Number((a.estimate_created||{}).count||0), 'Estimates')}
        ${kpi(Number((a.job_sold||{}).count||0), 'Jobs sold')}
        ${kpi(money((a.job_sold||{}).amount_cents||0), 'Attributed revenue')}
        ${kpi(Number(o.suppressed||0), 'Suppressed')}
      </div>
      <div class="card" style="padding:16px;font-size:13px;color:var(--gw-muted)">
        Attributed revenue counts jobs whose lead arrived through a campaign inquiry form.
        It updates nightly as estimates turn into sold work.
      </div>`);
  } catch(e){ fail(e); }
}

})();
