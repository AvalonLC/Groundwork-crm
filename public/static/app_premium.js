const data = window.AVALON_DATA;
const view = document.getElementById('view');
const navItems = [...document.querySelectorAll('.nav-item')];
function activateNav(viewName) {
  navItems.forEach(b => {
    const isActive = b.dataset.view === viewName;
    b.classList.toggle('active', isActive);
    if (isActive) {
      // auto-open the parent <details> group
      const group = b.closest('details.nav-group');
      if (group) group.open = true;
    }
  });
}
const sidebar = document.getElementById('sidebar');
const menuBtn = document.getElementById('menuBtn');
const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');
const installBtn = document.getElementById('installBtn');
const toastEl = document.getElementById('toast');
let deferredPrompt;

const STORAGE_KEY = 'avalonSalesHubStateV3';
const DEFAULT_STATE = { opportunities: [], tasks: [], notes: [], communications: [], settings: { repName: '', email: '' } };
let state = loadState();

function loadState(){
  try { return {...DEFAULT_STATE, ...(JSON.parse(localStorage.getItem(STORAGE_KEY)) || {})}; }
  catch(e){ return structuredClone(DEFAULT_STATE); }
}
function saveState(){
  // Always save to localStorage (instant, works offline)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  // Expose state for integrations module
  window._avalonState = state;
}

// ── D1 Write Engine ───────────────────────────────────────────────────────────
// Phase A: Structured logging with context (op type, entity id, error detail)
// Phase B: 1 automatic retry after 2 s; pending queue survives navigation
// Phase C: D1 is the write authority — localStorage is a read-cache only
//
// All writes go through _d1Write(op, fn).
// On success:  [D1 ✓] op entity_id
// On failure:  [D1 ✗] op entity_id — error message  (queued for retry)
// On retry ok: [D1 ↺] op entity_id recovered

const _d1PendingQueue = [];   // { op, entityId, fn, attempts } — survives SPA nav
let   _d1FlushTimer   = null;

async function _d1Write(op, entityId, fn) {
  if (!window.DB || !window._d1Ready) {
    // Not ready yet — queue for when D1 becomes ready
    _d1PendingQueue.push({ op, entityId, fn, attempts: 0 });
    console.info(`[D1 ⏳] ${op} ${entityId} — queued (D1 not ready)`);
    return;
  }
  try {
    await fn();
    console.info(`[D1 ✓] ${op} ${entityId}`);
  } catch(e) {
    console.warn(`[D1 ✗] ${op} ${entityId} — ${e.message} (queued for retry)`);
    _d1PendingQueue.push({ op, entityId, fn, attempts: 1 });
    _d1ScheduleFlush();
  }
}

function _d1ScheduleFlush() {
  if (_d1FlushTimer) return;
  _d1FlushTimer = setTimeout(_d1FlushQueue, 2000);
}

async function _d1FlushQueue() {
  _d1FlushTimer = null;
  if (!window.DB || !window._d1Ready || !_d1PendingQueue.length) return;
  const items = _d1PendingQueue.splice(0); // drain queue atomically
  for (const item of items) {
    try {
      await item.fn();
      console.info(`[D1 ↺] ${item.op} ${item.entityId} recovered after retry`);
    } catch(e) {
      item.attempts++;
      if (item.attempts < 3) {
        console.warn(`[D1 ✗] ${item.op} ${item.entityId} retry ${item.attempts} failed — ${e.message}`);
        _d1PendingQueue.push(item);
        _d1ScheduleFlush();
      } else {
        console.error(`[D1 ✗✗] ${item.op} ${item.entityId} DROPPED after 3 attempts — ${e.message}`);
        // Show subtle persistent toast so user knows to re-save
        showToast(`gwIcon('warning',16) Cloud sync failed for ${item.entityId} — check connection`, 6000);
      }
    }
  }
}

// Flush pending queue as soon as D1 becomes ready (called by bootstrap)
window._d1FlushQueue = _d1FlushQueue;

// ── D1 write helpers ──────────────────────────────────────────────────────────
function _d1SaveOpp(opp) {
  return _d1Write('save-opp', opp.id || 'new', () => window.DB.opportunities.save(opp));
}

function _d1DeleteOpp(id) {
  return _d1Write('delete-opp', id, () => window.DB.opportunities.delete(id));
}

function _d1SaveNote(oppId, noteBody, repId, noteId) {
  return _d1Write('save-note', noteId || oppId, () => window.DB.notes.add(oppId, noteBody, repId));
}

function _d1SaveClient(client) {
  return _d1Write('save-client', client.id || client.name, () => window.DB.clients.save(client));
}

function _d1DeleteClient(id) {
  return _d1Write('delete-client', id, () => window.DB.clients.delete(id));
}

window._d1SaveOpp     = _d1SaveOpp;
window._d1DeleteOpp   = _d1DeleteOpp;
window._d1SaveNote    = _d1SaveNote;
window._d1SaveClient  = _d1SaveClient;
window._d1DeleteClient= _d1DeleteClient;
// ── Nav Permission System ──────────────────────────────────────────────────
// All views always visible in sidebar. Tyler controls access per role here.
const NAV_PERMS_KEY = 'avalonNavPermissions';

// Default permissions by role. Tyler can override from Settings.
const DEFAULT_NAV_PERMS = {
  admin: ['today','myDashboard','pipeline','lead','clients','process','forms','scripts','templates','objections','calculator','academy','manager','revenueAdmin','integrations','userManagement','settings','ai'],
  office_manager: ['today','myDashboard','pipeline','lead','clients','process','forms','scripts','templates','objections','calculator','academy','manager','integrations','settings','ai'],
  rep: ['today','myDashboard','pipeline','lead','clients','process','forms','scripts','templates','objections','calculator','academy','integrations','settings','ai']
};

function loadNavPerms() {
  try { return JSON.parse(localStorage.getItem(NAV_PERMS_KEY)) || structuredClone(DEFAULT_NAV_PERMS); }
  catch(e) { return structuredClone(DEFAULT_NAV_PERMS); }
}
function saveNavPerms(perms) { localStorage.setItem(NAV_PERMS_KEY, JSON.stringify(perms)); }
function canViewTab(viewName) {
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  if (!rep) return false;
  // Admin always has full access (bypass localStorage perms for admin role)
  if (rep.role === 'admin') return true;
  const perms = loadNavPerms();
  // If this viewName is new and not in saved perms, fall back to DEFAULT_NAV_PERMS
  const savedAllowed = perms[rep.role] || [];
  const defaultAllowed = DEFAULT_NAV_PERMS[rep.role] || [];
  // A view is allowed if either saved perms include it, OR
  // saved perms don't have it listed at all (new view — use default)
  if (savedAllowed.includes(viewName)) return true;
  if (!savedAllowed.includes(viewName) && defaultAllowed.includes(viewName)) return true;
  return false;
}
window.loadNavPerms = loadNavPerms;
window.saveNavPerms = saveNavPerms;
window.DEFAULT_NAV_PERMS = DEFAULT_NAV_PERMS;

function escapeHtml(str=''){
  return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
}
function nl2br(str=''){ return escapeHtml(str).replace(/\n/g,'<br>'); }
function uid(prefix='id'){ return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2,8)}`; }
function todayISO(){ return new Date().toISOString().slice(0,10); }
function prettyDate(dateStr){ if(!dateStr) return 'Not set'; const d = new Date(`${dateStr}T12:00:00`); return d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}); }
function list(items){ return `<ul class="list">${items.map(i=>`<li>${escapeHtml(i)}</li>`).join('')}</ul>`; }
function badge(text, cls=''){ return `<span class="badge ${cls}">${escapeHtml(text)}</span>`; }
function statusCssClass(status){
  const map = {
    'New Lead':'new-lead','Contacted':'contacted',
    'Discovery Scheduled':'discovery','Discovery Complete':'discovery','Site Walk':'discovery',
    'Proposal / Estimate Sent':'proposal','Proposal Sent':'proposal',
    'Follow-Up':'follow-up','Negotiation':'negotiation','Verbal Approval':'verbal',
    'Sold / Activation':'sold','Closed Lost':'lost'
  };
  return map[status] || 'pending';
}
function estCommission(opp){
  // Delegate to the master engine (COMM-08: no page-level hardcoded math)
  if (typeof window.estimateCommission === 'function') {
    const rep = window.getCurrentRep ? window.getCurrentRep() : null;
    const planId = rep?.commissionPlan || 'ryan';
    const result = window.estimateCommission({
      planId,
      workType:   opp?.workType   || 'landscape',
      leadSource: opp?.leadSource || 'company_lead',
      jobValue:   Number(opp?.jobValue || 0),
      collected:  !!opp?.collected,
      approved:   !!opp?.commissionApproved
    });
    return result.amount;
  }
  // Fallback before reps.js loads
  const val = Number(opp?.jobValue || 0);
  if (!val) return 0;
  const rates = { landscape:.06, maintenance_onetime:.04, maintenance_recurring:.20, hardscape:.06, drainage:.06, design_build:.06 };
  return val * (rates[opp?.workType] || .06);
}
function showToast(message, duration){ toastEl.textContent = message; toastEl.hidden = false; setTimeout(()=>toastEl.hidden=true, duration || 2200); }
function copyText(text, btnEl){
  const doFeedback = () => {
    showToast('Copied to clipboard!');
    if(btnEl){
      const orig = btnEl.textContent;
      btnEl.textContent = 'Copied!';
      btnEl.classList.add('btn-copied');
      setTimeout(()=>{ btnEl.textContent=orig; btnEl.classList.remove('btn-copied'); }, 2000);
    }
  };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(doFeedback).catch(()=>{
      fallbackCopy(text); doFeedback();
    });
  } else { fallbackCopy(text); doFeedback(); }
}
function fallbackCopy(text){
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position='fixed'; ta.style.opacity='0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch(e){}
  document.body.removeChild(ta);
}
function show(viewName='today', param){
  // ── Permission gate (admin-configurable) ─────────────────
  if (viewName !== 'settings' && !canViewTab(viewName)) {
    const _rep = window.getCurrentRep ? window.getCurrentRep() : null;
    const _viewLabels = {today:'Today',myDashboard:'My Dashboard',pipeline:'Pipeline',lead:'Add Lead',clients:'Clients & Properties',process:'Sales Process',forms:'Forms & Checklists',scripts:'Scripts',templates:'Email Templates',objections:'Objection Handling',calculator:'Pricing Tools',academy:'Sales Academy',manager:'Manager Tools',revenueAdmin:'Financial Data Hub',integrations:'Integrations',userManagement:'User Management',settings:'Settings',ai:'AI Sales Assistant',ai:'AI Sales Assistant',ai:'AI Sales Assistant'};
    view.innerHTML = `<div style="text-align:center;padding:64px 24px;margin-top:40px">
      <div style="font-size:32px;margin-bottom:18px;color:#6F7E6A;font-weight:300;letter-spacing:-2px">&#x2715;</div>
      <h2 style="color:#C97B6A;margin-bottom:10px">${_viewLabels[viewName] || viewName} — Access Restricted</h2>
      <p style="color:#6F7E6A;max-width:420px;margin:0 auto 24px">Tyler (Owner) has restricted access to this section for your role.<br>Ask Tyler to enable it in <strong style="color:#E8E4D9">Settings → Permission Controls</strong>.</p>
      <button class="secondary-btn" onclick="show('today')">← Back to Today</button>
    </div>`;
    activateNav(viewName);
    sidebar.classList.remove('open'); document.getElementById('sidebarScrim')?.classList.remove('visible');
    window.scrollTo({top:0, behavior:'smooth'});
    return;
  }
  // ────────────────────────────────────────────────────────
  activateNav(viewName);
  sidebar.classList.remove('open'); document.getElementById('sidebarScrim')?.classList.remove('visible');
  // integrations is loaded from integrations.js
  const intRoute = (typeof integrations === 'function') ? {integrations} : {};
  // repDashboard is loaded from reps.js
  const repRoute = (typeof repDashboard === 'function') ? {myDashboard: repDashboard} : {};
  const revenueRoute = (typeof revenueAdmin === 'function') ? {revenueAdmin} : {};
  const umRoute = (typeof userManagement === 'function') ? {userManagement} : {};
  const saRoute = (typeof superAdmin === 'function') ? {superAdmin} : {};
  const routes = {today, pipeline, lead, clients, process, forms, scripts, templates, objections, calculator, academy, manager, settings, ...intRoute, ...repRoute, ...revenueRoute, ...umRoute, ...saRoute, ai};
  (routes[viewName] || today)(param);
  window.scrollTo({top:0, behavior:'smooth'});
  if (typeof window._avalonState !== 'undefined') window._avalonState = state;
}
window.show = show;

// Inject current rep name into sidebar
(function updateSidebarRep() {
  try {
    const rep = window.getCurrentRep ? window.getCurrentRep() : null;
    if (rep) {
      const isAdmin = rep.role === 'admin';
      const isOM = rep.role === 'office_manager';
      // Footer: show rep identity + role badge
      const footer = document.querySelector('.sidebar-footer');
      if (footer) {
        const initials = (rep.name || 'U').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2);
        const roleLabel = isAdmin ? 'Owner / Admin' : isOM ? 'Office Manager' : (rep.title || 'Sales Rep');
        footer.innerHTML = `
          <div style="width:32px;height:32px;border-radius:50%;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.25);color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;flex-shrink:0;cursor:pointer;letter-spacing:-.01em" onclick="logoutRep();renderLoginScreen()" title="Switch account">${initials}</div>
          <div style="min-width:0;flex:1">
            <strong style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;font-size:13px;color:#ffffff">${rep.name}</strong>
            <span style="font-size:11px;color:rgba(255,255,255,.50)">${roleLabel}</span>
          </div>`;
      }
      // Nav items: always fully visible — access controlled by Permission Matrix in Settings
    }
  } catch(e) {}
})();

function statCards(){
  const openOpps = state.opportunities.filter(o=>!['Sold / Activation','Closed Lost'].includes(o.status));
  const proposalOpps = state.opportunities.filter(o=>['Proposal / Estimate Sent','Proposal Sent','Follow-Up'].includes(o.status));
  const overdueOpps = state.opportunities.filter(o=>o.nextFollowUp && o.nextFollowUp < todayISO() && !['Sold / Activation','Closed Lost'].includes(o.status));
  const soldOpps = state.opportunities.filter(o=>o.status==='Sold / Activation');
  return `<div class="grid grid-4 stat-grid">
    <article class="stat dash-card-clickable" title="Click to filter: Open leads" onclick="window._pipelineStatusFilter='open';show('pipeline')" style="cursor:pointer">
      <span>Open</span><strong>${openOpps.length}</strong>
    </article>
    <article class="stat dash-card-clickable" title="Click to filter: Proposals" onclick="window._pipelineStatusFilter='proposals';show('pipeline')" style="cursor:pointer">
      <span>Proposals</span><strong>${proposalOpps.length}</strong>
    </article>
    <article class="stat ${overdueOpps.length?'bad':''} dash-card-clickable" title="Click to filter: Overdue" onclick="window._pipelineStatusFilter='overdue';show('pipeline')" style="cursor:pointer">
      <span>Overdue</span><strong>${overdueOpps.length}</strong>
    </article>
    <article class="stat dash-card-clickable" title="Click to filter: Sold" onclick="window._pipelineStatusFilter='sold';show('pipeline')" style="cursor:pointer">
      <span>Sold</span><strong>${soldOpps.length}</strong>
    </article>
  </div>`;
}

function buildSuggestedActions(currentRep){
  const suggestions = [];
  const isRep = currentRep && currentRep.role === 'rep';
  const myOpps = isRep ? state.opportunities.filter(o => o.repId === currentRep.id) : state.opportunities;
  const _today = todayISO();
  const staleOpps = myOpps.filter(o =>
    !['Sold / Activation','Closed Lost'].includes(o.status) &&
    o.updatedAt && Math.floor((Date.now()-new Date(o.updatedAt).getTime())/86400000) >= 7
  ).slice(0,3);
  const noNextStep = myOpps.filter(o =>
    !['Sold / Activation','Closed Lost'].includes(o.status) && !o.nextFollowUp
  ).slice(0,2);
  const proposalsPending = myOpps.filter(o =>
    ['Proposal / Estimate Sent','Proposal Sent'].includes(o.status)
  ).slice(0,3);
  const unassigned = (!isRep) ? state.opportunities.filter(o => !o.repId && !['Sold / Activation','Closed Lost'].includes(o.status)) : [];

  if(staleOpps.length) suggestions.push({icon:'<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="10" r="6" stroke="#8B6914" stroke-width="1.5"/><path d="M9 7v4l2 1.5" stroke="#8B6914" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 2h6" stroke="#8B6914" stroke-width="1.3" stroke-linecap="round" opacity=".5"/></svg>',title:`${staleOpps.length} stale lead${staleOpps.length>1?'s':''} with no recent activity`,cta:'Review',onclick:`show('pipeline')`});
  if(proposalsPending.length) suggestions.push({icon:'<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="2" y="4" width="14" height="11" rx="1.5" stroke="#4D8A86" stroke-width="1.5"/><path d="M2 8h14" stroke="#4D8A86" stroke-width="1.3" opacity=".5"/><path d="M6 2v4M12 2v4" stroke="#4D8A86" stroke-width="1.4" stroke-linecap="round" opacity=".6"/><circle cx="13" cy="13" r="2.5" fill="#C97B6A" stroke="#113931" stroke-width="1"/><path d="M13 11.5v1.5M13 14h.01" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/></svg>',title:`${proposalsPending.length} proposal${proposalsPending.length>1?'s':''} awaiting a decision — follow up`,cta:'Open Proposals',onclick:`window._pipelineStatusFilter='proposals';show('pipeline')`});
  if(noNextStep.length) suggestions.push({icon:'<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="2" y="4" width="14" height="11" rx="1.5" stroke="#8B6914" stroke-width="1.5"/><path d="M2 8h14" stroke="#8B6914" stroke-width="1.3" opacity=".5"/><path d="M6 2v4M12 2v4" stroke="#8B6914" stroke-width="1.4" stroke-linecap="round" opacity=".6"/><path d="M7 12h4M9 10v4" stroke="#8B6914" stroke-width="1.4" stroke-linecap="round" opacity=".7"/></svg>',title:`${noNextStep.length} lead${noNextStep.length>1?'s':''} missing a next follow-up date`,cta:'Set Follow-Up',onclick:`show('pipeline')`});
  if(unassigned.length) suggestions.push({icon:'<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="7" r="3" stroke="#6F7E6A" stroke-width="1.5"/><path d="M3 16c0-3 2.7-5 6-5s6 2 6 5" stroke="#6F7E6A" stroke-width="1.5" stroke-linecap="round"/><path d="M14 4v4M12 6h4" stroke="#8B6914" stroke-width="1.4" stroke-linecap="round"/></svg>',title:`${unassigned.length} unassigned lead${unassigned.length>1?'s':''} with no rep`,cta:'Assign Now',onclick:`show('pipeline')`});

  if(!suggestions.length) return '';
  return `<div class="suggested-actions">
    <div class="sa-header">Suggested Next Actions</div>
    ${suggestions.map(s=>`
      <div class="sa-row">
        <span class="sa-icon">${s.icon}</span>
        <span class="sa-text">${s.title}</span>
        <button class="secondary-btn small" onclick="${s.onclick}">${s.cta}</button>
      </div>`).join('')}
  </div>`;
}

function today(){
  const _todayRep = window.getCurrentRep ? window.getCurrentRep() : null;
  const _isOM = _todayRep && _todayRep.role === 'office_manager';
  const due = state.opportunities
    .filter(o=>o.nextFollowUp && o.nextFollowUp <= todayISO() && !['Sold / Activation','Closed Lost'].includes(o.status))
    .sort((a,b)=>a.nextFollowUp.localeCompare(b.nextFollowUp));
  const next = state.opportunities
    .filter(o=>o.nextFollowUp && o.nextFollowUp > todayISO() && !['Sold / Activation','Closed Lost'].includes(o.status))
    .sort((a,b)=>a.nextFollowUp.localeCompare(b.nextFollowUp)).slice(0,5);
  const recent = [...state.opportunities].sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||'')).slice(0,5);
  const _heroBlock = _isOM ? `
    <div class="pl-page-header">
      <div class="pl-page-title">
        <h1 class="pl-title">Today</h1>
        <span class="pl-subtitle">Office operations · ${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}</span>
      </div>
      <div class="pl-page-actions">
        <button class="primary-btn small" onclick="show('lead')">+ New Lead</button>
        <button class="secondary-btn small" onclick="show('pipeline')">Full Pipeline</button>
        <button class="secondary-btn small" onclick="show('myDashboard')">Ops Dashboard</button>
      </div>
    </div>` : `
    <div class="pl-page-header">
      <div class="pl-page-title">
        <h1 class="pl-title">Today</h1>
        <span class="pl-subtitle">${_todayRep ? escapeHtml(_todayRep.name) + ' · ' : ''}${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}</span>
      </div>
      <div class="pl-page-actions">
        <button class="primary-btn small" onclick="show('lead')">+ New Lead</button>
        <button class="secondary-btn small" onclick="show('pipeline')">Open Pipeline</button>
        <button class="secondary-btn small" onclick="show('forms','discovery')">Discovery Planner</button>
        <button class="secondary-btn small" onclick="show('forms','site-walk')">Site Walk</button>
      </div>
    </div>`;
  view.innerHTML = `${_heroBlock}
    ${statCards()}
    <div class="grid grid-2 mt">
      <section class="card app-card">
        <div class="section-head">
          <h2>Due Now</h2>
          ${due.length
            ? badge(`${due.length} follow-up${due.length===1?'':'s'}`, 'warn-badge')
            : `<span class="badge neutral-badge">All clear</span>`}
        </div>
        ${due.length ? due.map(oppCard).join('') : `<div class="due-now-clear">No follow-ups due today.</div>
        ${buildSuggestedActions(_todayRep)}`}
      </section>
      <section class="card app-card">
        <div class="section-head"><h2>Daily Sales Start-Up</h2></div>
        ${renderChecklist(data.checklists.find(c=>c.id==='daily'), true)}
      </section>
    </div>
    <div class="grid grid-2 mt">
      <section class="card">
        <div class="section-head"><h2>Coming Up</h2></div>
        ${next.length ? next.map(oppMini).join('') : empty('No upcoming follow-ups.', '', `<button class="secondary-btn small" onclick="show('pipeline')">View Pipeline</button>`)}
      </section>
      <section class="card">
        <div class="section-head"><h2>Recently Updated</h2></div>
        ${recent.length ? recent.map(oppMini).join('') : empty('No leads yet.', '', `<button class="primary-btn small" onclick="show('lead')">+ Add First Lead</button>`)}
      </section>
    </div>
    ${renderTodayActivityWidget()}
  `;
  wireChecks();
}

function renderTodayActivityWidget(){
  const currentRep = window.getCurrentRep ? window.getCurrentRep() : null;
  const targets = window.AVALON_DATA.activityTargets;
  // Admin (Tyler) and office manager (Jen) — no personal KPI widget on Today; Ryan sees his own below
  if(!currentRep || currentRep.role === 'admin' || currentRep.role === 'office_manager') return '';
  const repTargets = targets[currentRep.id];
  if(!repTargets) return '';
  return `<div class="card mt" style="border-left:3px solid ${currentRep.color||'#4D8A86'}">
    <h3>${escapeHtml(currentRep.name)}'s Weekly Activity Targets</h3>
    <p class="muted small-text">Track these weekly — activity creates opportunity. Log in daily.</p>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px;margin-top:12px">
      ${Object.entries(repTargets).map(([k,v])=>`<div style="background:var(--bg2);border-radius:8px;padding:12px">
        <div style="font-size:.75rem;color:var(--muted);margin-bottom:4px">${escapeHtml(v.label)}</div>
        <div style="font-size:1.2rem;font-weight:700;color:${currentRep.color||'#4D8A86'}">${v.target !== undefined ? (v.floor ? '0 stale' : v.target+(v.frequency==='daily'?'/day':'/wk')) : (v.min === v.max ? v.min : (v.min||'—')+'–'+(v.max||'—'))}</div>
        ${v.description ? `<div style="font-size:.7rem;color:#6F7E6A;margin-top:4px">${escapeHtml(v.description)}</div>` : ''}
      </div>`).join('')}
    </div>
    <div class="footer-actions mt">
      <button class="secondary-btn small" onclick="show('myDashboard')">View Full Dashboard</button>
    </div>
  </div>`;
}

function empty(text, icon, ctaHtml){
  if(icon !== undefined){
    return `<div class="empty-state">
      <div style="font-size:2.4rem;margin-bottom:10px">${icon}</div>
      <p style="margin:0 0 14px;font-size:14px;color:var(--text-muted)">${escapeHtml(text)}</p>
      ${ctaHtml || ''}
    </div>`;
  }
  return `<div class="empty">${escapeHtml(text)}</div>`;
}
function oppMini(o){
  const _today = todayISO();
  const isOverdue = o.nextFollowUp && o.nextFollowUp < _today && !['Sold / Activation','Closed Lost'].includes(o.status);
  const daysSince = o.updatedAt ? Math.floor((Date.now()-new Date(o.updatedAt).getTime())/86400000) : null;
  // Urgency dot inline — small colored dot before client name
  const urgencyDot = isOverdue
    ? `<span style="display:inline-block;width:6px;height:6px;background:#C97B6A;border-radius:50%;flex-shrink:0;margin-top:1px"></span>`
    : '';
  const repObj = (window.REPS||[]).find(r => r.id === o.repId);
  // Rep pill — color-coded, uses class + minimal inline for the brand color
  const repPill = repObj
    ? `<span class="opp-rep-pill" style="color:${repObj.color||'#4D8A86'};background:${repObj.color||'#4D8A86'}18;border:1px solid ${repObj.color||'#4D8A86'}40">${escapeHtml(repObj.name)}</span>`
    : `<span class="opp-rep-pill" style="color:#8B6914;background:#8B691415;border:1px solid rgba(139,105,20,.22)">Unassigned</span>`;
  // Time label
  const timeLabel = daysSince !== null
    ? `<span class="mini-row-time">${daysSince===0?'Today':daysSince===1?'Yesterday':daysSince+'d ago'}</span>`
    : '';
  return `<button class="mini-row ${isOverdue?'mini-row-overdue':''}" onclick="show('pipeline','${o.id}')">
    <strong>${urgencyDot}${escapeHtml(o.client||'Unnamed Lead')}</strong>
    <span class="status-chip ${statusCssClass(o.status||'')}">${escapeHtml(o.status||'New Lead')}</span>
    <em>${escapeHtml(o.project||o.serviceLine||'Opportunity')}</em>
    <span class="mini-row-meta">${repPill}${timeLabel}</span>
  </button>`;
}
function oppCard(o){
  const _today = todayISO();
  const isOverdue = o.nextFollowUp && o.nextFollowUp < _today && !['Sold / Activation','Closed Lost'].includes(o.status);
  const daysSinceUpdate = o.updatedAt ? Math.floor((Date.now() - new Date(o.updatedAt).getTime()) / 86400000) : 999;
  const isStale = daysSinceUpdate >= 14 && !['Sold / Activation','Closed Lost'].includes(o.status);
  const repObj = (window.REPS||[]).find(r => r.id === o.repId);
  const urgencyBadge = isOverdue
    ? `<span class="urgency-badge overdue">OVERDUE</span>`
    : isStale
    ? `<span class="urgency-badge stale">STALE ${daysSinceUpdate}d</span>`
    : '';
  return `<article class="opp-card ${isOverdue ? 'opp-overdue' : isStale ? 'opp-stale' : ''}" onclick="show('pipeline','${o.id}')" style="cursor:pointer">
    <div class="opp-card-top">
      <h3>${escapeHtml(o.client||'Unnamed Lead')}</h3>
      ${urgencyBadge}
    </div>
    <p class="opp-project">${escapeHtml(o.project||o.serviceLine||'Opportunity')}${o.address ? ` · ${escapeHtml(o.address)}` : ''}</p>
    <div class="opp-meta">
      ${badge(o.status||'New Lead')}
      ${o.nextFollowUp ? `<span class="opp-next">Next: ${prettyDate(o.nextFollowUp)}</span>` : ''}
      ${o.jobValue ? `<span class="opp-value">${money(Number(o.jobValue))}</span>` : ''}
      ${repObj
        ? `<span class="opp-rep-pill" style="color:${repObj.color||'#4D8A86'};background:${repObj.color||'#4D8A86'}18;border:1px solid ${repObj.color||'#4D8A86'}40;margin-left:auto">${escapeHtml(repObj.name)}</span>`
        : `<span class="opp-rep-pill" style="color:#8B6914;background:#8B691415;border:1px solid rgba(139,105,20,.22);margin-left:auto">Unassigned</span>`}
    </div>
  </article>`;
}

function pipeline(selectedId){
  if(selectedId){ return opportunityDetail(selectedId); }

  const currentRep = window.getCurrentRep ? window.getCurrentRep() : null;
  const adminView = currentRep?.role === 'admin' || currentRep?.role === 'office_manager';
  const activeRepFilter = window._pipelineRepFilter || (adminView ? 'all' : (currentRep?.id || 'all'));
  const activeTypeFilter = window._pipelineTypeFilter || 'all';
  const activeCatFilter = window._pipelineCatFilter || 'all';

  let opps = state.opportunities;
  if (activeRepFilter !== 'all') opps = opps.filter(o => o.repId === activeRepFilter);
  if (activeTypeFilter !== 'all') opps = opps.filter(o => o.clientType === activeTypeFilter);
  if (activeCatFilter === 'landscape') opps = opps.filter(o => {
    const cat = (o.projectCategory||'').toLowerCase();
    return cat.includes('landscape') || cat.includes('hardscape') || cat.includes('drainage') || cat.includes('design') || cat.includes('irrigation') || cat.includes('lighting') || cat.includes('enhancement');
  });
  if (activeCatFilter === 'maintenance') opps = opps.filter(o => {
    const cat = (o.projectCategory||'').toLowerCase();
    return cat.includes('maintenance');
  });
  if (activeCatFilter === 'snow') opps = opps.filter(o => {
    const cat = (o.projectCategory||'').toLowerCase();
    const div = (data.projectCategories||[]).find(pc => pc.name === o.projectCategory);
    return cat.includes('snow') || (div && div.division === 'snow');
  });

  // T28: Status quick-filter from stat cards
  const activeStatusFilter = window._pipelineStatusFilter || null;
  if (activeStatusFilter === 'open') opps = opps.filter(o => !['Sold / Activation','Closed Lost'].includes(o.status));
  else if (activeStatusFilter === 'proposals') opps = opps.filter(o => ['Proposal / Estimate Sent','Proposal Sent','Follow-Up'].includes(o.status));
  else if (activeStatusFilter === 'overdue') opps = opps.filter(o => o.nextFollowUp && o.nextFollowUp < todayISO() && !['Sold / Activation','Closed Lost'].includes(o.status));
  else if (activeStatusFilter === 'sold') opps = opps.filter(o => o.status === 'Sold / Activation');

  // T47: Sort
  const activeSort = window._pipelineSort || 'urgent';
  function sortOpps(items){
    if(activeSort==='recent') return [...items].sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||''));
    if(activeSort==='value') return [...items].sort((a,b)=>Number(b.jobValue||0)-Number(a.jobValue||0));
    const _t = todayISO();
    return [...items].sort((a,b)=>{
      const ao=a.nextFollowUp&&a.nextFollowUp<_t?0:1; const bo=b.nextFollowUp&&b.nextFollowUp<_t?0:1;
      if(ao!==bo) return ao-bo;
      return (a.nextFollowUp||'9999').localeCompare(b.nextFollowUp||'9999');
    });
  }

  const filters = data.statuses;
  const grouped = filters.map(status => ({status, items: sortOpps(opps.filter(o=>o.status===status))})).filter(g=>g.items.length || ['New Lead','Contacted','Discovery Scheduled','Proposal / Estimate Sent','Follow-Up','Sold / Activation'].includes(g.status));

  const _repFilterHtml = (()=>{
    const _cr = window.getCurrentRep ? window.getCurrentRep() : null;
    const _ia = _cr && (_cr.role === 'admin' || _cr.role === 'office_manager');
    if (!_ia) return '';
    return `<div class="pl-filter-group">
      <span class="pl-filter-label">Rep</span>
      <button class="pl-filter-btn ${activeRepFilter==='all'?'pl-active':''}" onclick="window._pipelineRepFilter='all';show('pipeline')">All</button>
      ${(window.REPS||[]).map(r=>`<button class="pl-filter-btn ${activeRepFilter===r.id?'pl-active':''}" onclick="window._pipelineRepFilter='${r.id}';show('pipeline')">${r.name.split(' ')[0]}</button>`).join('')}
    </div><div class="pl-filter-divider"></div>`;
  })();

  view.innerHTML = `
    <div class="pl-page-header">
      <div class="pl-page-title">
        <h1 class="pl-title">Pipeline</h1>
        <span class="pl-subtitle">Day-to-day sales tracker</span>
      </div>
      <div class="pl-page-actions">
        <button class="primary-btn small" onclick="show('lead')">+ Add Lead</button>
        <button class="secondary-btn small" onclick="exportCsv()">Export CSV</button>
        <button class="secondary-btn small" onclick="show('forms','follow-up')">Follow-Up Cadence</button>
      </div>
    </div>

    <div class="pl-toolbar">
      ${_repFilterHtml}
      <div class="pl-filter-group">
        <span class="pl-filter-label">Client</span>
        <button class="pl-filter-btn ${activeTypeFilter==='all'?'pl-active':''}" onclick="window._pipelineTypeFilter='all';show('pipeline')">All</button>
        <button class="pl-filter-btn ${activeTypeFilter==='Residential'?'pl-active':''}" onclick="window._pipelineTypeFilter='Residential';show('pipeline')">Residential</button>
        <button class="pl-filter-btn ${activeTypeFilter==='Commercial'?'pl-active':''}" onclick="window._pipelineTypeFilter='Commercial';show('pipeline')">Commercial</button>
      </div>
      <div class="pl-filter-divider"></div>
      <div class="pl-filter-group">
        <span class="pl-filter-label">Division</span>
        <button class="pl-filter-btn ${activeCatFilter==='all'?'pl-active':''}" onclick="window._pipelineCatFilter='all';show('pipeline')">All</button>
        <button class="pl-filter-btn ${activeCatFilter==='landscape'?'pl-active':''}" onclick="window._pipelineCatFilter='landscape';show('pipeline')">Landscape</button>
        <button class="pl-filter-btn ${activeCatFilter==='maintenance'?'pl-active':''}" onclick="window._pipelineCatFilter='maintenance';show('pipeline')">Maintenance</button>
        <button class="pl-filter-btn ${activeCatFilter==='snow'?'pl-active':''}" onclick="window._pipelineCatFilter='snow';show('pipeline')">Snow & Ice</button>
      </div>
      <div class="pl-filter-divider"></div>
      <div class="pl-filter-group">
        <span class="pl-filter-label">Sort</span>
        <button class="pl-filter-btn ${activeSort==='urgent'?'pl-active':''}" onclick="window._pipelineSort='urgent';show('pipeline')">Urgent</button>
        <button class="pl-filter-btn ${activeSort==='recent'?'pl-active':''}" onclick="window._pipelineSort='recent';show('pipeline')">Recent</button>
        <button class="pl-filter-btn ${activeSort==='value'?'pl-active':''}" onclick="window._pipelineSort='value';show('pipeline')">Value</button>
      </div>
    </div>

    ${activeStatusFilter ? `<div class="pl-active-filter-bar">
      <span>Showing: <strong>${activeStatusFilter}</strong></span>
      <button class="pl-clear-filter" onclick="window._pipelineStatusFilter=null;show('pipeline')">× Clear</button>
    </div>` : ''}

    ${statCards()}

    <div class="kanban mt">
      ${grouped.map(g=>`<section class="kanban-col"><h3>${escapeHtml(g.status)} <span class="kanban-count">${g.items.length}</span></h3>${g.items.length ? g.items.map(oppCard).join('') : '<p class="muted small-text">No items</p>'}</section>`).join('')}
    </div>
  `;
}

window.filterPipelineByRep = function(repId) {
  window._pipelineRepFilter = repId;
  show('pipeline');
};


// ── buildDivisionPipeline() ─────────────────────────────────────────────────
// Calculates per-division pipeline metrics from state.opportunities[]
// Division mapping: projectCategory / workType → landscape / maintenance / snow
function buildDivisionPipeline() {
  const opps = (window.avalonState && window.avalonState.opportunities) || (typeof state !== 'undefined' ? state.opportunities : []) || [];
  const todayStr = typeof todayISO === 'function' ? todayISO() : new Date().toISOString().slice(0,10);
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);

  // Map an opportunity to a division key
  function getDiv(o) {
    const cat = (o.projectCategory || '').toLowerCase();
    const wt  = (o.workType || '').toLowerCase();
    const sl  = (o.serviceLine || '').toLowerCase();
    if (cat.includes('snow') || wt.includes('snow') || sl.includes('snow')) return 'snow';
    if (cat.includes('mainten') || wt.includes('mainten') || sl.includes('mainten')) return 'maintenance';
    if (cat.includes('landscape') || cat.includes('design') || cat.includes('hardscape') ||
        cat.includes('drainage') || wt.includes('landscape') || wt.includes('hardscape') ||
        wt.includes('drainage') || wt.includes('design')) return 'landscape';
    // fallback by service line
    if (sl.includes('landscape') || sl.includes('hardscape') || sl.includes('drainage')) return 'landscape';
    return 'landscape'; // default
  }

  // Win probability by stage (mirrors HubSpot pipeline)
  const STAGE_WIN_PROB = {
    'New Lead': 0.10,
    'Contacted': 0.15,
    'Site Visit Scheduled': 0.25,
    'Site Visit Complete': 0.35,
    'Estimating': 0.45,
    'Estimate Sent': 0.55,
    'Proposal Under Review': 0.65,
    'Negotiating': 0.75,
    'Follow-Up': 0.50,
    'Decision Pending': 0.70,
    'Sold / Activation': 1.0,
    'Closed Lost': 0.0,
  };
  function winProb(o) {
    return STAGE_WIN_PROB[o.status] || 0.20;
  }

  // "Paper on the Street" statuses — formal estimates/proposals in front of customers
  const POTS_ESTIMATE_STATUSES = ['sent','revised','viewed','awaiting_response','awaiting response'];
  const POTS_STAGES = ['Estimate Sent','Proposal Under Review','Negotiating','Decision Pending','Follow-Up'];

  const OPEN_STAGES_EXCL = ['Sold / Activation','Closed Lost'];

  const divKeys = ['landscape','maintenance','snow'];
  const divLabels = { landscape:'Landscape', maintenance:'Maintenance', snow:'Snow & Ice' };
  const divColors = { landscape:'#4D8A86', maintenance:'#2D7A55', snow:'#4D8A86' };

  const result = {};
  divKeys.forEach(k => {
    result[k] = {
      key: k,
      label: divLabels[k],
      color: divColors[k],
      openValue: 0,           // total open pipeline value (all active opps)
      openEstimateValue: 0,   // value of opps with a formal estimate out
      paperOnStreet: 0,       // active quoted/proposed value not yet sold or lost
      weightedPipeline: 0,    // openValue * win probability
      openCount: 0,           // # active opportunities
      openEstimateCount: 0,   // # opps with estimate sent/active
      estimateAgeDays: [],    // array of ages (in days) for open estimates
      sevenDayRisk: 0,        // # open opps with follow-up due within 7 days
      soldThisMonth: 0,       // sold value this calendar month
      soldCountThisMonth: 0,
      totalSold: 0,           // all time sold value (for close rate)
      totalClosed: 0,         // sold + lost (for close rate denominator)
    };
  });

  opps.forEach(o => {
    const div = getDiv(o);
    const d = result[div];
    if (!d) return;
    const val = parseFloat(o.jobValue || 0);
    const estAmt = parseFloat(o.estimateAmount || val); // fall back to jobValue if no estimateAmount

    const isSold = o.status === 'Sold / Activation';
    const isLost = o.status === 'Closed Lost';
    const isOpen = !isSold && !isLost;

    // Close rate denominator
    if (isSold || isLost) d.totalClosed++;
    if (isSold) {
      d.totalSold += val;
      // Sold this month?
      if (o.updatedAt && o.updatedAt.slice(0,10) >= startOfMonth) {
        d.soldThisMonth += val;
        d.soldCountThisMonth++;
      }
    }

    if (!isOpen) return;

    // Open pipeline
    d.openCount++;
    d.openValue += val;
    d.weightedPipeline += val * winProb(o);

    // Estimate open?
    const estStatus = (o.estimateStatus || '').toLowerCase().replace(/ /g,'_');
    const hasOpenEstimate = POTS_ESTIMATE_STATUSES.includes(estStatus) ||
                             POTS_ESTIMATE_STATUSES.includes((o.estimateStatus||'').toLowerCase()) ||
                             POTS_STAGES.includes(o.status);
    if (hasOpenEstimate && estAmt > 0) {
      d.openEstimateCount++;
      d.openEstimateValue += estAmt;

      // Paper on the Street: active quoted value in front of customer
      d.paperOnStreet += estAmt;

      // Estimate age
      const sentDate = o.estimateSentDate || o.updatedAt || o.createdAt;
      if (sentDate) {
        const sent = new Date(sentDate);
        const ageMs = now - sent;
        const ageDays = Math.floor(ageMs / 86400000);
        if (ageDays >= 0) d.estimateAgeDays.push(ageDays);
      }
    }

    // 7-day follow-up risk
    if (o.nextFollowUp) {
      const followDate = new Date(o.nextFollowUp + 'T12:00:00');
      const daysUntil = Math.floor((followDate - now) / 86400000);
      if (daysUntil >= 0 && daysUntil <= 7) d.sevenDayRisk++;
    }
  });

  // Compute derived stats
  divKeys.forEach(k => {
    const d = result[k];
    d.avgEstimateAge = d.estimateAgeDays.length > 0
      ? Math.round(d.estimateAgeDays.reduce((a,b) => a+b, 0) / d.estimateAgeDays.length)
      : null;
    d.oldestEstimateAge = d.estimateAgeDays.length > 0
      ? Math.max(...d.estimateAgeDays)
      : null;
    d.closeRate = d.totalClosed > 0
      ? Math.round((d.totalSold > 0 ? (d.soldCountThisMonth > 0 ? 1 : 0) : 0) * 100) / 100
      : null;
    // Better close rate: sold / (sold + lost) by count
    const soldCount = opps.filter(o => o.status === 'Sold / Activation' && getDiv(o) === k).length;
    const lostCount = opps.filter(o => o.status === 'Closed Lost'        && getDiv(o) === k).length;
    d.closeRatePct = (soldCount + lostCount) > 0
      ? Math.round((soldCount / (soldCount + lostCount)) * 100)
      : null;
  });

  // Totals row
  result.total = {
    label: 'Total',
    color: '#E8E4D9',
    openValue:         divKeys.reduce((a,k) => a + result[k].openValue, 0),
    openEstimateValue: divKeys.reduce((a,k) => a + result[k].openEstimateValue, 0),
    paperOnStreet:     divKeys.reduce((a,k) => a + result[k].paperOnStreet, 0),
    weightedPipeline:  divKeys.reduce((a,k) => a + result[k].weightedPipeline, 0),
    openCount:         divKeys.reduce((a,k) => a + result[k].openCount, 0),
    openEstimateCount: divKeys.reduce((a,k) => a + result[k].openEstimateCount, 0),
    soldThisMonth:     divKeys.reduce((a,k) => a + result[k].soldThisMonth, 0),
    sevenDayRisk:      divKeys.reduce((a,k) => a + result[k].sevenDayRisk, 0),
  };

  return { divisions: result, keys: divKeys };
}
// ────────────────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
//  CLIENTS & PROPERTIES
//  Storage key: 'avalonClientsV1'  (separate from opportunities)
//  Schema per client:
//    id, name, firstName, lastName, company, type (Residential|Commercial|HOA|Vendor),
//    status (Active|Inactive|Lead), email, phone, mobile,
//    street, street2, city, state, zip,
//    since, tags[], notes, homeworksId, properties[]
//  Schema per property (sub-object):
//    id, label, street, street2, city, state, zip, notes
// ══════════════════════════════════════════════════════════════════════════════

const CLIENTS_KEY = 'avalonClientsV1';

function loadClients() {
  try { return JSON.parse(localStorage.getItem(CLIENTS_KEY)) || []; }
  catch(e) { return []; }
}
function saveClients(list) {
  // Phase C: localStorage = read-cache; D1 = write authority
  localStorage.setItem(CLIENTS_KEY, JSON.stringify(list));
  // Write-through to D1 via write engine (logged, retried on failure)
  list.forEach(client => _d1SaveClient(client));
}
function clientId() { return 'cl_' + Date.now() + '_' + Math.random().toString(36).slice(2,7); }
function propId()   { return 'pr_' + Date.now() + '_' + Math.random().toString(36).slice(2,7); }

// ── Parse a Homeworks-style CSV row into our client schema ──────────────────
function parseClientCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = parseCsvRow(lines[0]);
  const idx = h => headers.findIndex(x => x.toLowerCase().trim() === h.toLowerCase().trim());
  const iName=idx('Name'), iFirst=idx('First Name'), iLast=idx('Last Name'),
        iType=idx('Type'), iStatus=idx('Status'), iEmail=idx('Email'),
        iPhone=idx('Phone'), iMobile=idx('Mobile'), iFax=idx('Fax'),
        iStreet=idx('Street'), iStreet2=idx('Street2'), iCity=idx('City'),
        iState=idx('State'), iZip=idx('Postal Code'), iSince=idx('Since'),
        iTags=idx('Tags'), iNotes=idx('Notes'), iHwId=idx('Client ID'),
        iCompany=idx('Customer Company Name');
  const clients = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const r = parseCsvRow(lines[i]);
    const name = (r[iName]||r[iCompany]||'').trim();
    if (!name) continue;
    // Map Homeworks type → our type
    const rawType = (r[iType]||'').trim();
    let type = 'Residential';
    if (/commercial/i.test(rawType))    type = 'Commercial';
    else if (/vendor/i.test(rawType))   type = 'Vendor';
    else if (/hoa|association/i.test(name)) type = 'HOA';
    else if (r[iCompany] && r[iCompany].trim() !== name && /LLC|Inc\.|Corp|Assoc|HOA|Properties|Management/i.test(name)) type = 'Commercial';
    // Map status
    const rawStatus = (r[iStatus]||'').trim();
    const status = rawStatus === 'Active' ? 'Active' : rawStatus === 'Inactive' ? 'Inactive' : 'Active';
    // Parse tags — include 'Annual Maintenance Client' etc.
    const rawTags = (r[iTags]||'').trim();
    const tags = rawTags ? rawTags.split(',').map(t=>t.trim()).filter(Boolean) : [];
    // Strip HTML from notes
    const rawNotes = (r[iNotes]||'').trim().replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
    clients.push({
      id: clientId(),
      name,
      firstName: (r[iFirst]||'').trim(),
      lastName:  (r[iLast]||'').trim(),
      company:   (r[iCompany]||'').trim(),
      type, status,
      email:   (r[iEmail]||'').trim(),
      phone:   (r[iPhone]||'').trim(),
      mobile:  (r[iMobile]||'').trim(),
      street:  (r[iStreet]||'').trim(),
      street2: (r[iStreet2]||'').trim(),
      city:    (r[iCity]||'').trim(),
      state:   (r[iState]||'').trim(),
      zip:     (r[iZip]||'').trim(),
      since:   (r[iSince]||'').trim(),
      tags,
      notes:   rawNotes,
      homeworksId: (r[iHwId]||'').trim(),
      properties: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }
  return clients;
}

// Minimal CSV row parser (handles quoted fields with commas/newlines)
function parseCsvRow(row) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === '"') { if (inQ && row[i+1]==='"') { cur+='"'; i++; } else inQ=!inQ; }
    else if (c === ',' && !inQ) { result.push(cur); cur=''; }
    else cur += c;
  }
  result.push(cur);
  return result.map(s => s.replace(/^"|"$/g,'').trim());
}

// ── Export clients to CSV ──────────────────────────────────────────────────
function exportClientsCsv() {
  const list = loadClients();
  if (!list.length) { showToast('No clients to export'); return; }
  const headers = ['Name','First Name','Last Name','Company','Type','Status','Email','Phone','Mobile','Street','Street2','City','State','Zip','Since','Tags','Notes','Homeworks ID'];
  const esc = v => '"' + String(v||'').replace(/"/g,'""') + '"';
  const rows = list.map(c => [
    c.name, c.firstName, c.lastName, c.company, c.type, c.status,
    c.email, c.phone, c.mobile, c.street, c.street2, c.city, c.state, c.zip,
    c.since, (c.tags||[]).join(', '), c.notes, c.homeworksId
  ].map(esc).join(','));
  const csv = [headers.join(','), ...rows].join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = 'avalon-clients-' + new Date().toISOString().slice(0,10) + '.csv';
  a.click();
  showToast('Exported ' + list.length + ' clients');
}
window.exportClientsCsv = exportClientsCsv;

// ── Type badge color map ────────────────────────────────────────────────────
function clientTypeBadge(type) {
  const map = {
    'Residential': 'cl-badge-residential',
    'Commercial':  'cl-badge-commercial',
    'HOA':         'cl-badge-hoa',
    'Vendor':      'cl-badge-vendor'
  };
  return `<span class="cl-badge ${map[type]||'cl-badge-residential'}">${escapeHtml(type||'Residential')}</span>`;
}
function clientStatusDot(status) {
  const color = status==='Active' ? '#2D7A55' : status==='Inactive' ? '#6F7E6A' : '#8B6914';
  return `<span class="cl-status-dot" style="background:${color}" title="${escapeHtml(status||'Active')}"></span>`;
}

// ── Main clients() view ─────────────────────────────────────────────────────
function clients(selectedId) {
  if (selectedId) return clientDetail(selectedId);

  const list = loadClients();
  const q = (window._clientSearch||'').toLowerCase();
  const typeFilter = window._clientTypeFilter || 'all';
  const statusFilter = window._clientStatusFilter || 'all';

  let filtered = list.filter(c => {
    if (typeFilter !== 'all' && c.type !== typeFilter) return false;
    if (statusFilter !== 'all' && c.status !== statusFilter) return false;
    if (!q) return true;
    return [c.name, c.email, c.phone, c.mobile, c.street, c.city, c.tags?.join(' '), c.company]
      .some(f => (f||'').toLowerCase().includes(q));
  });

  // Sort: alphabetical by name
  filtered.sort((a,b) => (a.name||'').localeCompare(b.name||''));

  const counts = { total: list.length, residential: 0, commercial: 0, hoa: 0, vendor: 0, active: 0 };
  list.forEach(c => {
    if (c.status==='Active') counts.active++;
    const t = (c.type||'Residential').toLowerCase().replace(/ /g,'');
    if (counts[t] !== undefined) counts[t]++;
  });

  // ── Toolbar filter pills ──────────────────────────────────────────────────
  const typePills = ['all','Residential','Commercial','HOA','Vendor'].map(t =>
    `<button class="pl-filter-btn ${typeFilter===t?'pl-active':''}"
      onclick="window._clientTypeFilter='${t}';show('clients')">${t==='all'?'All Types':escapeHtml(t)}</button>`
  ).join('');

  const statusPills = ['all','Active','Inactive'].map(s =>
    `<button class="pl-filter-btn ${statusFilter===s?'pl-active':''}"
      onclick="window._clientStatusFilter='${s}';show('clients')">${s==='all'?'All Statuses':escapeHtml(s)}</button>`
  ).join('');

  const hasFilter = q || typeFilter!=='all' || statusFilter!=='all';
  const activeFilterBar = hasFilter ? `
    <div class="pl-active-filter-bar">
      <span>Showing ${filtered.length} of ${list.length}</span>
      <button class="pl-clear-filter" onclick="window._clientSearch='';window._clientTypeFilter='all';window._clientStatusFilter='all';show('clients')">✕ Clear filters</button>
    </div>` : '';

  // ── Client rows ───────────────────────────────────────────────────────────
  const rows = filtered.length ? filtered.map(c => {
    const addr = [c.street, c.city, c.state].filter(Boolean).join(', ');
    const contact = c.email || c.phone || c.mobile || '—';
    const tagHtml = (c.tags||[]).slice(0,2).map(t => `<span class="cl-tag">${escapeHtml(t)}</span>`).join('');
    const linkedOpps = state.opportunities.filter(o =>
      o.clientId === c.id || (o.client||'').toLowerCase() === (c.name||'').toLowerCase()
    ).length;
    return `<tr class="cl-row" onclick="show('clients','${c.id}')" title="Open ${escapeHtml(c.name)}">
      <td class="cl-cell-name">
        <div class="cl-name-wrap">
          <span class="cl-avatar">${escapeHtml((c.name||'?')[0].toUpperCase())}</span>
          <div>
            <div class="cl-name">${escapeHtml(c.name)}</div>
            ${c.company && c.company !== c.name ? `<div class="cl-sub">${escapeHtml(c.company)}</div>` : ''}
          </div>
        </div>
      </td>
      <td>${clientTypeBadge(c.type)}</td>
      <td>${clientStatusDot(c.status)} <span style="font-size:12px;color:#5C6B58">${escapeHtml(c.status||'Active')}</span></td>
      <td class="cl-cell-addr">${addr ? escapeHtml(addr) : '<span class="cl-empty-cell">—</span>'}</td>
      <td class="cl-cell-contact">
        ${c.email ? `<a class="cl-link" href="mailto:${escapeHtml(c.email)}" onclick="event.stopPropagation()">${escapeHtml(c.email)}</a>` : ''}
        ${(c.phone||c.mobile) && c.email ? '<br>' : ''}
        ${escapeHtml(c.phone||c.mobile||(!c.email?'—':''))}
      </td>
      <td>${tagHtml}</td>
      <td style="text-align:center">${linkedOpps ? `<span class="cl-opp-count">${linkedOpps}</span>` : '<span style="color:#6F7E6A;font-size:12px">—</span>'}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="7" style="text-align:center;padding:48px 24px;color:#6F7E6A;font-size:14px">
    ${q||typeFilter!=='all'||statusFilter!=='all' ? 'No clients match your filters.' : 'No clients yet — import from Homeworks or add manually.'}
  </td></tr>`;

  view.innerHTML = `
    <div class="pl-page-header">
      <div class="pl-page-title">
        <h1 class="pl-title">Clients &amp; Properties</h1>
        <span class="pl-subtitle">${counts.total} total · ${counts.active} active · ${counts.residential} residential · ${counts.commercial} commercial</span>
      </div>
      <div class="pl-page-actions">
        <button class="primary-btn small" onclick="showClientForm()">+ Add Client</button>
        <button class="secondary-btn small" onclick="exportClientsCsv()">Export CSV</button>
        <button class="secondary-btn small" onclick="triggerClientImport()">Import CSV</button>
      </div>
    </div>

    <input type="file" id="clientImportInput" accept=".csv,text/csv,text/plain" style="display:none"
      onchange="handleClientImport(this)">

    <div class="pl-toolbar" style="margin-bottom:10px">
      <div class="cl-search-wrap">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);pointer-events:none;opacity:.45">
          <circle cx="5.5" cy="5.5" r="4" stroke="#5C6B58" stroke-width="1.4"/>
          <path d="M9 9l3 3" stroke="#5C6B58" stroke-width="1.4" stroke-linecap="round"/>
        </svg>
        <input id="clientSearchInput" class="cl-search-input" type="search" placeholder="Search clients, addresses, emails…"
          value="${escapeHtml(window._clientSearch||'')}"
          oninput="window._clientSearch=this.value;show('clients')">
      </div>
      <div class="pl-filter-divider"></div>
      <div class="pl-filter-group">
        <span class="pl-filter-label">Type</span>
        ${typePills}
      </div>
      <div class="pl-filter-divider"></div>
      <div class="pl-filter-group">
        <span class="pl-filter-label">Status</span>
        ${statusPills}
      </div>
    </div>
    ${activeFilterBar}

    <div class="cl-table-wrap card" style="padding:0;overflow:hidden">
      <table class="cl-table">
        <thead>
          <tr>
            <th style="width:26%">Client</th>
            <th style="width:11%">Type</th>
            <th style="width:9%">Status</th>
            <th style="width:22%">Address</th>
            <th style="width:20%">Contact</th>
            <th style="width:8%">Tags</th>
            <th style="width:4%;text-align:center" title="Linked pipeline opportunities">Opps</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    <div style="margin-top:10px;font-size:11px;color:#6F7E6A;text-align:right">
      ${filtered.length} client${filtered.length===1?'':'s'} shown
    </div>
  `;

  // Auto-focus search
  const si = document.getElementById('clientSearchInput');
  if (si && !window._clientSearch) { /* don't steal focus on load */ }
}
window._clientSearch = window._clientSearch || '';
window._clientTypeFilter = window._clientTypeFilter || 'all';
window._clientStatusFilter = window._clientStatusFilter || 'all';

// ── Trigger file input ──────────────────────────────────────────────────────
window.triggerClientImport = function() {
  document.getElementById('clientImportInput')?.click();
};

// ── Handle imported CSV ─────────────────────────────────────────────────────
window.handleClientImport = function(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    const text = e.target.result;
    const imported = parseClientCsv(text);
    if (!imported.length) { showToast('No valid clients found in CSV'); return; }
    const existing = loadClients();
    // Deduplicate by homeworksId or name match
    let added = 0, skipped = 0;
    imported.forEach(c => {
      const dup = existing.find(x =>
        (c.homeworksId && x.homeworksId && x.homeworksId === c.homeworksId) ||
        x.name.toLowerCase() === c.name.toLowerCase()
      );
      if (dup) { skipped++; }
      else { existing.push(c); added++; }
    });
    saveClients(existing);
    showToast(`Imported ${added} clients${skipped?' ('+skipped+' duplicates skipped)':''}`);
    input.value = '';
    show('clients');
  };
  reader.readAsText(file);
};

// ── Add / Edit client form ──────────────────────────────────────────────────
window.showClientForm = function(clientIdToEdit) {
  const c = clientIdToEdit ? loadClients().find(x => x.id === clientIdToEdit) : null;
  const isEdit = !!c;
  const modal = document.createElement('div');
  modal.id = 'clientFormModal';
  modal.className = 'cl-modal-overlay';
  modal.innerHTML = `
    <div class="cl-modal">
      <div class="cl-modal-header">
        <h3>${isEdit ? 'Edit Client' : 'Add Client'}</h3>
        <button class="cl-modal-close" onclick="document.getElementById('clientFormModal').remove()">✕</button>
      </div>
      <div class="cl-modal-body">
        <div class="cl-form-grid">
          <label class="cl-form-label full"><span>Name <span style="color:#8B3A2A">*</span></span>
            <input id="clf-name" class="cl-input" value="${escapeHtml(c?.name||'')}" placeholder="Full name or company name">
          </label>
          <label class="cl-form-label"><span>First Name</span>
            <input id="clf-first" class="cl-input" value="${escapeHtml(c?.firstName||'')}" placeholder="First">
          </label>
          <label class="cl-form-label"><span>Last Name</span>
            <input id="clf-last" class="cl-input" value="${escapeHtml(c?.lastName||'')}" placeholder="Last">
          </label>
          <label class="cl-form-label"><span>Type</span>
            <select id="clf-type" class="cl-input">
              ${['Residential','Commercial','HOA','Vendor'].map(t => `<option ${(c?.type||'Residential')===t?'selected':''}>${t}</option>`).join('')}
            </select>
          </label>
          <label class="cl-form-label"><span>Status</span>
            <select id="clf-status" class="cl-input">
              ${['Active','Inactive','Lead'].map(s => `<option ${(c?.status||'Active')===s?'selected':''}>${s}</option>`).join('')}
            </select>
          </label>
          <label class="cl-form-label"><span>Email</span>
            <input id="clf-email" class="cl-input" type="email" value="${escapeHtml(c?.email||'')}" placeholder="client@email.com">
          </label>
          <label class="cl-form-label"><span>Phone</span>
            <input id="clf-phone" class="cl-input" value="${escapeHtml(c?.phone||'')}" placeholder="703-xxx-xxxx">
          </label>
          <label class="cl-form-label"><span>Mobile</span>
            <input id="clf-mobile" class="cl-input" value="${escapeHtml(c?.mobile||'')}" placeholder="Mobile">
          </label>
          <label class="cl-form-label full"><span>Street Address</span>
            <input id="clf-street" class="cl-input" value="${escapeHtml(c?.street||'')}" placeholder="123 Main St">
          </label>
          <label class="cl-form-label"><span>City</span>
            <input id="clf-city" class="cl-input" value="${escapeHtml(c?.city||'')}" placeholder="Vienna">
          </label>
          <label class="cl-form-label" style="grid-template-columns:80px 1fr;gap:8px">
            <div><span>State</span><input id="clf-state" class="cl-input" value="${escapeHtml(c?.state||'VA')}" placeholder="VA" maxlength="2"></div>
            <div><span>Zip</span><input id="clf-zip" class="cl-input" value="${escapeHtml(c?.zip||'')}" placeholder="22180"></div>
          </label>
          <label class="cl-form-label full"><span>Tags <span style="color:#6F7E6A;font-weight:400">(comma-separated)</span></span>
            <input id="clf-tags" class="cl-input" value="${escapeHtml((c?.tags||[]).join(', '))}" placeholder="Annual Maintenance Client, HOA, etc.">
          </label>
          <label class="cl-form-label full"><span>Notes</span>
            <textarea id="clf-notes" class="cl-input" rows="3" placeholder="Property access, billing notes, contacts…">${escapeHtml(c?.notes||'')}</textarea>
          </label>
          <label class="cl-form-label"><span>Homeworks ID</span>
            <input id="clf-hwid" class="cl-input" value="${escapeHtml(c?.homeworksId||'')}" placeholder="CRM reference ID">
          </label>
          <label class="cl-form-label"><span>Client Since</span>
            <input id="clf-since" class="cl-input" value="${escapeHtml(c?.since||'')}" placeholder="Jan 2025">
          </label>
        </div>
      </div>
      <div class="cl-modal-footer">
        ${isEdit ? `<button class="danger-btn small" onclick="deleteClient('${c.id}')">Delete</button>` : ''}
        <button class="secondary-btn small" onclick="document.getElementById('clientFormModal').remove()">Cancel</button>
        <button class="primary-btn small" onclick="saveClientForm('${isEdit?c.id:''}')">
          ${isEdit ? 'Save Changes' : 'Add Client'}
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  document.getElementById('clf-name').focus();
};

window.saveClientForm = function(existingId) {
  const val = id => (document.getElementById(id)?.value||'').trim();
  const name = val('clf-name');
  if (!name) { showToast('Name is required'); return; }
  const tags = val('clf-tags').split(',').map(t=>t.trim()).filter(Boolean);
  const list = loadClients();
  if (existingId) {
    const idx = list.findIndex(x => x.id === existingId);
    if (idx < 0) return;
    Object.assign(list[idx], {
      name, firstName:val('clf-first'), lastName:val('clf-last'),
      type:val('clf-type'), status:val('clf-status'),
      email:val('clf-email'), phone:val('clf-phone'), mobile:val('clf-mobile'),
      street:val('clf-street'), city:val('clf-city'), state:val('clf-state'), zip:val('clf-zip'),
      tags, notes:val('clf-notes'), homeworksId:val('clf-hwid'), since:val('clf-since'),
      updatedAt:new Date().toISOString()
    });
  } else {
    list.push({
      id:clientId(), name, firstName:val('clf-first'), lastName:val('clf-last'),
      company:'', type:val('clf-type'), status:val('clf-status'),
      email:val('clf-email'), phone:val('clf-phone'), mobile:val('clf-mobile'),
      street:val('clf-street'), street2:'', city:val('clf-city'), state:val('clf-state'), zip:val('clf-zip'),
      since:val('clf-since'), tags, notes:val('clf-notes'), homeworksId:val('clf-hwid'),
      properties:[], createdAt:new Date().toISOString(), updatedAt:new Date().toISOString()
    });
  }
  saveClients(list);
  document.getElementById('clientFormModal')?.remove();
  showToast(existingId ? 'Client updated' : 'Client added');
  show('clients', existingId || undefined);
};

window.deleteClient = function(id) {
  if (!confirm('Delete this client? This cannot be undone.')) return;
  const list = loadClients().filter(x => x.id !== id);
  // Update localStorage cache without triggering a save-all to D1
  localStorage.setItem(CLIENTS_KEY, JSON.stringify(list));
  // Delete from D1 via write engine (logged, retried on failure)
  _d1DeleteClient(id);
  document.getElementById('clientFormModal')?.remove();
  showToast('Client deleted');
  show('clients');
};

// ── Client detail view ──────────────────────────────────────────────────────
function clientDetail(id) {
  const list = loadClients();
  const c = list.find(x => x.id === id);
  if (!c) { show('clients'); return; }

  // Linked pipeline opportunities
  const linkedOpps = state.opportunities.filter(o =>
    o.clientId === c.id || (o.client||'').toLowerCase() === (c.name||'').toLowerCase()
  );

  const addr = [c.street, c.street2, c.city, c.state, c.zip].filter(Boolean).join(', ');
  const tagHtml = (c.tags||[]).map(t => `<span class="cl-tag">${escapeHtml(t)}</span>`).join('');

  const propertiesHtml = (c.properties||[]).length ? c.properties.map(p => `
    <div class="cl-property-card">
      <div class="cl-property-label">${escapeHtml(p.label||'Property')}</div>
      <div class="cl-property-addr">${escapeHtml([p.street,p.street2,p.city,p.state,p.zip].filter(Boolean).join(', '))}</div>
      ${p.notes ? `<div class="cl-property-notes">${escapeHtml(p.notes)}</div>` : ''}
      <button class="cl-property-delete" onclick="deleteProperty('${c.id}','${p.id}')">Remove</button>
    </div>`).join('') : `<p class="muted" style="font-size:13px">No additional properties. The primary address above is the main service location.</p>`;

  const oppsHtml = linkedOpps.length ? linkedOpps.map(o => {
    const _repO = (window.REPS||[]).find(r => r.id === o.repId);
    const _repPill = _repO
      ? `<span style="font-size:10px;font-weight:600;color:${_repO.color||'#6F7E6A'};background:${_repO.color||'#6F7E6A'}18;border:1px solid ${_repO.color||'#6F7E6A'}40;border-radius:20px;padding:1px 7px;white-space:nowrap;flex-shrink:0">${escapeHtml(_repO.name)}</span>`
      : `<span style="font-size:10px;font-weight:600;color:#8B6914;background:#8B691418;border:1px solid rgba(139,105,20,.25);border-radius:20px;padding:1px 7px;white-space:nowrap;flex-shrink:0">gwIcon('warning',16) Unassigned</span>`;
    return `<button class="mini-row" onclick="show('pipeline','${o.id}')">
      <strong>${escapeHtml(o.client||'Unnamed')}</strong>
      <span class="status-chip ${statusCssClass(o.status||'')}" style="font-size:10px">${escapeHtml(o.status||'New Lead')}</span>
      <em>${escapeHtml(o.project||o.serviceLine||'Opportunity')}</em>
      <span style="display:flex;align-items:center;gap:5px;margin-left:auto;flex-shrink:0">
        ${_repPill}
        ${o.nextFollowUp ? `<span style="font-size:10px;color:#5C6B58">${prettyDate(o.nextFollowUp)}</span>` : ''}
      </span>
    </button>`;
  }).join('')
  : `<p class="muted" style="font-size:13px">No pipeline opportunities linked to this client yet.</p>`;

  view.innerHTML = `
    <div class="pl-page-header" style="margin-bottom:14px">
      <div class="pl-page-title">
        <button class="cl-back-btn" onclick="show('clients')">← Clients</button>
        <h1 class="pl-title" style="margin-top:4px">${escapeHtml(c.name)}</h1>
        <span class="pl-subtitle">${clientTypeBadge(c.type)} ${clientStatusDot(c.status)} ${escapeHtml(c.status||'Active')}${c.since?' · Since '+escapeHtml(c.since):''}</span>
      </div>
      <div class="pl-page-actions">
        <button class="primary-btn small" onclick="show('lead')">+ New Opportunity</button>
        <button class="secondary-btn small" onclick="showClientForm('${c.id}')">Edit</button>
      </div>
    </div>

    <div class="grid grid-2 mt">
      <!-- Contact card -->
      <section class="card">
        <div class="section-head"><h2>Contact Info</h2></div>
        <dl class="cl-dl">
          ${c.email  ? `<dt>Email</dt><dd><a class="cl-link" href="mailto:${escapeHtml(c.email)}">${escapeHtml(c.email)}</a></dd>` : ''}
          ${c.phone  ? `<dt>Phone</dt><dd>${escapeHtml(c.phone)}</dd>` : ''}
          ${c.mobile ? `<dt>Mobile</dt><dd>${escapeHtml(c.mobile)}</dd>` : ''}
          ${addr     ? `<dt>Address</dt><dd>${escapeHtml(addr)}</dd>` : ''}
          ${c.homeworksId ? `<dt>Homeworks ID</dt><dd style="color:#6F7E6A;font-size:12px">${escapeHtml(c.homeworksId)}</dd>` : ''}
        </dl>
        ${tagHtml ? `<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">${tagHtml}</div>` : ''}
        ${c.notes ? `<div class="cl-notes-block">${escapeHtml(c.notes)}</div>` : ''}
      </section>

      <!-- Pipeline opportunities -->
      <section class="card">
        <div class="section-head">
          <h2>Pipeline</h2>
          <span class="badge ${linkedOpps.length?'':'neutral-badge'}">${linkedOpps.length} opp${linkedOpps.length===1?'':'s'}</span>
        </div>
        ${oppsHtml}
        ${linkedOpps.length ? `<div style="margin-top:10px"><button class="secondary-btn small" onclick="show('lead')">+ New Opportunity</button></div>` : ''}
      </section>
    </div>

    <!-- Properties -->
    <section class="card mt">
      <div class="section-head">
        <h2>Service Properties</h2>
        <button class="secondary-btn small" onclick="showAddProperty('${c.id}')">+ Add Property</button>
      </div>
      <div class="cl-properties-grid">${propertiesHtml}</div>
    </section>
  `;
}

// ── Add property modal ──────────────────────────────────────────────────────
window.showAddProperty = function(clientId) {
  const existing = document.getElementById('addPropertyModal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'addPropertyModal';
  modal.className = 'cl-modal-overlay';
  modal.innerHTML = `
    <div class="cl-modal" style="max-width:480px">
      <div class="cl-modal-header">
        <h3>Add Service Property</h3>
        <button class="cl-modal-close" onclick="document.getElementById('addPropertyModal').remove()">✕</button>
      </div>
      <div class="cl-modal-body">
        <div class="cl-form-grid">
          <label class="cl-form-label full"><span>Label</span>
            <input id="prop-label" class="cl-input" placeholder="e.g. Main Residence, Rental Property, Back Lot">
          </label>
          <label class="cl-form-label full"><span>Street</span>
            <input id="prop-street" class="cl-input" placeholder="123 Service Rd">
          </label>
          <label class="cl-form-label"><span>City</span>
            <input id="prop-city" class="cl-input" placeholder="Vienna">
          </label>
          <label class="cl-form-label" style="display:grid;grid-template-columns:80px 1fr;gap:8px">
            <div><span>State</span><input id="prop-state" class="cl-input" value="VA" maxlength="2"></div>
            <div><span>Zip</span><input id="prop-zip" class="cl-input" placeholder="22180"></div>
          </label>
          <label class="cl-form-label full"><span>Notes</span>
            <textarea id="prop-notes" class="cl-input" rows="2" placeholder="Gate code, access notes, service area…"></textarea>
          </label>
        </div>
      </div>
      <div class="cl-modal-footer">
        <button class="secondary-btn small" onclick="document.getElementById('addPropertyModal').remove()">Cancel</button>
        <button class="primary-btn small" onclick="saveProperty('${clientId}')">Add Property</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  document.getElementById('prop-label').focus();
};

window.saveProperty = function(clientId) {
  const val = id => (document.getElementById(id)?.value||'').trim();
  const list = loadClients();
  const c = list.find(x => x.id === clientId);
  if (!c) return;
  c.properties = c.properties || [];
  c.properties.push({
    id: propId(),
    label: val('prop-label') || 'Property',
    street: val('prop-street'), street2: '',
    city: val('prop-city'), state: val('prop-state'), zip: val('prop-zip'),
    notes: val('prop-notes')
  });
  c.updatedAt = new Date().toISOString();
  saveClients(list);
  document.getElementById('addPropertyModal')?.remove();
  showToast('Property added');
  show('clients', clientId);
};

window.deleteProperty = function(clientId, propIdToDelete) {
  if (!confirm('Remove this property?')) return;
  const list = loadClients();
  const c = list.find(x => x.id === clientId);
  if (!c) return;
  c.properties = (c.properties||[]).filter(p => p.id !== propIdToDelete);
  c.updatedAt = new Date().toISOString();
  saveClients(list);
  showToast('Property removed');
  show('clients', clientId);
};

// ────────────────────────────────────────────────────────────────────────────

function lead(){
  const currentRep = window.getCurrentRep ? window.getCurrentRep() : null;

  // Rep picker HTML (admin/manager only)
  const _cr = window.getCurrentRep ? window.getCurrentRep() : null;
  const _ia = _cr && (_cr.role === 'admin' || _cr.role === 'office_manager');
  const repPickerHtml = _ia
    ? '<label class="lf-field"><span class="lf-label">Assigned Rep</span><select name="repId" class="lf-select"><option value="">— Select rep —</option>'
        + (window.REPS||[]).map(r=>'<option value="' + r.id + '">' + r.name + '</option>').join('')
        + '</select></label>'
    : '<input type="hidden" name="repId" value="' + (_cr ? _cr.id : '') + '">';

  // Project category tile data
  const _cats = [
    {v:'Landscape / Enhancement', icon:'<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 17V10M10 10C10 10 5 10 3 5c3.5 0 7 2 7 5zm0 0c0 0 5 0 7-5-3.5 0-7 2-7 5z" stroke="#2D7A55" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 17c-2 0-3.5-.5-4-1" stroke="#2D7A55" stroke-width="1.4" stroke-linecap="round" opacity=".5"/></svg>', short:'Landscape'},
    {v:'Maintenance - Recurring',  icon:'<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M14 4a3.5 3.5 0 00-3 5.2L4.6 15.6a1 1 0 001.4 1.4l6.4-6.4A3.5 3.5 0 0016 7.5a3.5 3.5 0 00-.5-1.8l-2 2-1.5-1.5 2-2A3.5 3.5 0 0014 4z" stroke="#4D8A86" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>', short:'Recurring Maint.'},
    {v:'Maintenance - One Time',   icon:'<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M14 4a3.5 3.5 0 00-3 5.2L4.6 15.6a1 1 0 001.4 1.4l6.4-6.4A3.5 3.5 0 0016 7.5a3.5 3.5 0 00-.5-1.8l-2 2-1.5-1.5 2-2A3.5 3.5 0 0014 4z" stroke="#4D8A86" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>', short:'One-Time Maint.'},
    {v:'Hardscape',                icon:'<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4" width="6" height="3" rx=".5" stroke="#8B6914" stroke-width="1.4"/><rect x="11" y="4" width="6" height="3" rx=".5" stroke="#8B6914" stroke-width="1.4"/><rect x="6.5" y="9" width="7" height="3" rx=".5" stroke="#8B6914" stroke-width="1.4"/><rect x="3" y="14" width="4" height="3" rx=".5" stroke="#8B6914" stroke-width="1.4" opacity=".7"/><rect x="9" y="14" width="5" height="3" rx=".5" stroke="#8B6914" stroke-width="1.4" opacity=".7"/></svg>', short:'Hardscape'},
    {v:'Drainage',                 icon:'<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 3L13 8a3.5 3.5 0 11-6 0L10 3z" stroke="#4D8A86" stroke-width="1.5" stroke-linejoin="round"/><path d="M4 16h12" stroke="#4D8A86" stroke-width="1.5" stroke-linecap="round"/><path d="M7 16l1.5-3M13 16l-1.5-3" stroke="#4D8A86" stroke-width="1.3" stroke-linecap="round" opacity=".6"/></svg>', short:'Drainage'},
    {v:'Design / Build',           icon:'<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 16L15 5" stroke="#4D8A86" stroke-width="1.5" stroke-linecap="round"/><path d="M13 3l4 4-2 2-4-4 2-2z" stroke="#4D8A86" stroke-width="1.3" stroke-linejoin="round"/><path d="M4 16l-1 1 1-1zm0 0l2-1-1 1z" stroke="#4D8A86" stroke-width="1.3" stroke-linecap="round"/><rect x="3" y="12" width="8" height="2.5" rx=".5" transform="rotate(-45 3 12)" stroke="#4D8A86" stroke-width="1.3" opacity=".5"/></svg>', short:'Design / Build'},
    {v:'Irrigation',               icon:'<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 15 Q8 8 14 6" stroke="#4D8A86" stroke-width="1.5" stroke-linecap="round"/><circle cx="14" cy="6" r="1.3" fill="#4D8A86"/><path d="M10 4 Q12 3 14 4" stroke="#4D8A86" stroke-width="1.3" stroke-linecap="round" opacity=".6"/><path d="M12 7 Q15 5 17 6" stroke="#4D8A86" stroke-width="1.3" stroke-linecap="round" opacity=".6"/><path d="M11 10 Q14 9 16 10" stroke="#4D8A86" stroke-width="1.3" stroke-linecap="round" opacity=".4"/><path d="M3 16 Q4 14 5 15" stroke="#4D8A86" stroke-width="1.4" stroke-linecap="round"/></svg>', short:'Irrigation'},
    {v:'Outdoor Lighting',         icon:'<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 3a5 5 0 014 8l-1 1v1H7v-1L6 11a5 5 0 014-8z" stroke="#8B6914" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 16h4" stroke="#8B6914" stroke-width="1.4" stroke-linecap="round"/><path d="M8.5 16.5 Q10 18 11.5 16.5" stroke="#8B6914" stroke-width="1.3" stroke-linecap="round"/><circle cx="3" cy="5" r="1" fill="#8B6914" opacity=".4"/><circle cx="17" cy="5" r="1" fill="#8B6914" opacity=".4"/><circle cx="10" cy="1.5" r="1" fill="#8B6914" opacity=".4"/></svg>', short:'Lighting'},
    {v:'Other',                    icon:'<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="7" stroke="#6F7E6A" stroke-width="1.4"/><circle cx="7" cy="10" r="1.2" fill="#6F7E6A"/><circle cx="10" cy="10" r="1.2" fill="#6F7E6A"/><circle cx="13" cy="10" r="1.2" fill="#6F7E6A"/></svg>', short:'Other'},
  ];
  const catTilesHtml = _cats.map(c =>
    '<button type="button" class="cat-tile" data-cat="' + c.v + '">'
    + '<span class="cat-tile-label">' + c.short + '</span>'
    + '</button>'
  ).join('');

  // Service line options
  const slOptions = (data.serviceLines||[]).map(o => '<option>' + escapeHtml(o) + '</option>').join('');

  // Status options
  const stOptions = (data.statuses||[]).map(o => '<option' + (o==='New Lead'?' selected':'') + '>' + escapeHtml(o) + '</option>').join('');

  // Lead source options
  const lsOptions = (data.leadSources||[]).map(o => '<option>' + escapeHtml(o) + '</option>').join('');

  view.innerHTML =
    '<div class="lf-hero">'
      + '<span class="lf-hero-eyebrow">New Opportunity</span>'
      + '<h1 class="lf-hero-title">Add Lead</h1>'
    + '</div>'
    + '<form id="leadForm">'

      // ── Section 1: Who is it? ──
      + '<div class="lf-section">'
        + '<div class="lf-section-header">'
          + '<span class="lf-section-num">1</span>'
          + '<div>'
            + '<div class="lf-section-title">Who is it?</div>'
            + '<div class="lf-section-sub">Search existing clients or enter a new contact</div>'
          + '</div>'
        + '</div>'
        + '<div class="lf-fields">'
          + '<div class="lf-field lf-field--full" style="position:relative">'
            + '<span class="lf-label">Client Name <span class="lf-required">*</span></span>'
            + '<div class="lf-client-search-wrap">'
              + '<input name="client" id="lf-client-input" type="text" required autocomplete="off"'
              + ' class="lf-input lf-input--lg" placeholder="Search existing clients or type a new name…">'
              + '<div class="lf-client-status" id="lf-client-status"></div>'
            + '</div>'
            + '<div class="lf-client-dropdown" id="lf-client-dropdown" style="display:none"></div>'
            + '<input type="hidden" name="clientId" id="lf-client-id">'
            + '<input type="hidden" name="clientIsNew" id="lf-client-is-new" value="1">'
          + '</div>'
          + '<label class="lf-field">'
            + '<span class="lf-label">Phone</span>'
            + '<input name="phone" id="lf-phone" type="tel" class="lf-input" placeholder="(555) 000-0000">'
          + '</label>'
          + '<label class="lf-field">'
            + '<span class="lf-label">Email</span>'
            + '<input name="email" id="lf-email" type="email" class="lf-input" placeholder="name@example.com">'
          + '</label>'
          + '<label class="lf-field lf-field--full">'
            + '<span class="lf-label">Property Address</span>'
            + '<input name="address" id="lf-address" type="text" class="lf-input" placeholder="Street, City, State">'
          + '</label>'
          + '<div class="lf-field lf-field--full">'
            + '<span class="lf-label">Client Type</span>'
            + '<div class="lf-toggle-group">'
              + '<input type="radio" name="clientType" id="ct-res" value="Residential" checked class="lf-toggle-radio">'
              + '<label for="ct-res" class="lf-toggle-btn">Residential</label>'
              + '<input type="radio" name="clientType" id="ct-com" value="Commercial" class="lf-toggle-radio">'
              + '<label for="ct-com" class="lf-toggle-btn">Commercial</label>'
            + '</div>'
          + '</div>'
        + '</div>'
      + '</div>'

      // ── Section 2: What's the job? ──
      + '<div class="lf-section">'
        + '<div class="lf-section-header">'
          + '<span class="lf-section-num">2</span>'
          + '<div>'
            + '<div class="lf-section-title">What\'s the job?</div>'
            + '<div class="lf-section-sub">Project type, scope, and value</div>'
          + '</div>'
        + '</div>'
        + '<div class="lf-fields">'
          + '<div class="lf-field lf-field--full">'
            + '<span class="lf-label">Project Category</span>'
            + '<div class="lf-cat-tiles">' + catTilesHtml + '</div>'
            + '<input type="hidden" name="projectCategory" id="projectCategoryInput">'
          + '</div>'
          + '<label class="lf-field">'
            + '<span class="lf-label">Service Line</span>'
            + '<select name="serviceLine" class="lf-select"><option value="">Select...</option>' + slOptions + '</select>'
          + '</label>'
          + '<label class="lf-field">'
            + '<span class="lf-label">Project / Opportunity Name</span>'
            + '<input name="project" type="text" class="lf-input" placeholder="e.g. Backyard renovation">'
          + '</label>'
          + '<label class="lf-field">'
            + '<span class="lf-label">Estimated Job Value ($)</span>'
            + '<input name="jobValue" type="number" class="lf-input lf-input--value" placeholder="0" min="0" step="100">'
          + '</label>'
          + '<div id="commPreview" class="lf-comm-preview" style="display:none">'
            + '<span class="lf-comm-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="#2D7A55" stroke-width="1.3"/><path d="M8 3v10M6 11c0 1 .9 1.5 2 1.5S10 12 10 11s-1-1.5-2-1.5S6 8 6 7s.9-1.5 2-1.5S10 5 10 6" stroke="#2D7A55" stroke-width="1.2" stroke-linecap="round"/></svg></span>'
            + '<span id="commPreviewText"></span>'
          + '</div>'
          + '<label class="lf-field">'
            + '<span class="lf-label">Work Type <span class="lf-hint">(for commission)</span></span>'
            + '<select name="workType" class="lf-select">'
              + '<option value="landscape" selected>Landscape</option>'
              + '<option value="maintenance_onetime">Maintenance – One Time</option>'
              + '<option value="maintenance_recurring">Maintenance – Recurring</option>'
              + '<option value="maintenance_upsell">Maintenance – Upsell</option>'
              + '<option value="hardscape">Hardscape</option>'
              + '<option value="drainage">Drainage</option>'
              + '<option value="design_build">Design / Build</option>'
            + '</select>'
          + '</label>'
        + '</div>'
      + '</div>'

      // ── Section 3: Routing & next step ──
      + '<div class="lf-section">'
        + '<div class="lf-section-header">'
          + '<span class="lf-section-num">3</span>'
          + '<div>'
            + '<div class="lf-section-title">Routing &amp; next step</div>'
            + '<div class="lf-section-sub">Where does this go, and what happens next?</div>'
          + '</div>'
        + '</div>'
        + '<div class="lf-fields">'
          + '<label class="lf-field">'
            + '<span class="lf-label">Lead Source</span>'
            + '<select name="source" class="lf-select"><option value="">Select...</option>' + lsOptions + '</select>'
          + '</label>'
          + '<label class="lf-field">'
            + '<span class="lf-label">Commission Source</span>'
            + '<select name="leadSource" class="lf-select">'
              + '<option value="company_lead" selected>Company Lead</option>'
              + '<option value="self_generated">Self-Generated</option>'
              + '<option value="assisted">Assisted</option>'
            + '</select>'
          + '</label>'
          + '<label class="lf-field">'
            + '<span class="lf-label">Urgency / Timing</span>'
            + '<input name="urgency" type="text" class="lf-input" placeholder="e.g. Wants it done by June">'
          + '</label>'
          + '<label class="lf-field">'
            + '<span class="lf-label">Decision-Maker(s)</span>'
            + '<input name="decisionMaker" type="text" class="lf-input" placeholder="Who signs off?">'
          + '</label>'
          + '<label class="lf-field">'
            + '<span class="lf-label">Budget</span>'
            + '<input name="budget" type="text" class="lf-input" placeholder="Budget range or language">'
          + '</label>'
          + '<label class="lf-field">'
            + '<span class="lf-label">Next Follow-Up</span>'
            + '<input name="nextFollowUp" type="date" class="lf-input">'
          + '</label>'
          + '<label class="lf-field">'
            + '<span class="lf-label">Status</span>'
            + '<select name="status" class="lf-select"><option value="">Select...</option>' + stOptions + '</select>'
          + '</label>'
          + repPickerHtml
        + '</div>'
      + '</div>'


      // ── Section 4: Estimate (optional, collapsible) ──
      + '<div class="lf-section">'  
        + '<div class="lf-section-header">'  
          + '<span class="lf-section-num" style="background:linear-gradient(135deg,#B8744F,#1A4740)">4</span>'  
          + '<div>'  
            + '<div class="lf-section-title">Estimate</div>'  
            + '<div class="lf-section-sub">Track what\'s on the street — formal quotes and proposals</div>'  
          + '</div>'  
        + '</div>'  
        + '<div class="lf-fields">'  
          + '<label class="lf-field">'  
            + '<span class="lf-label">Estimate Status</span>'  
            + '<select name="estimateStatus" class="lf-select">'  
              + '<option value="">Not started</option>'  
              + '<option value="draft">Draft — not yet sent</option>'  
              + '<option value="sent">Sent — awaiting response</option>'  
              + '<option value="revised">Revised &amp; resent</option>'  
              + '<option value="viewed">Viewed by customer</option>'  
              + '<option value="awaiting_response">Awaiting response</option>'  
              + '<option value="accepted">Accepted</option>'  
              + '<option value="declined">Declined</option>'  
              + '<option value="expired">Expired</option>'  
            + '</select>'  
          + '</label>'  
          + '<label class="lf-field">'  
            + '<span class="lf-label">Estimate Amount ($)</span>'  
            + '<input name="estimateAmount" type="number" class="lf-input lf-input--value" placeholder="Quoted amount" min="0" step="100">'  
          + '</label>'  
          + '<label class="lf-field">'  
            + '<span class="lf-label">Date Sent to Customer</span>'  
            + '<input name="estimateSentDate" type="date" class="lf-input">'  
          + '</label>'  
          + '<label class="lf-field">'  
            + '<span class="lf-label"># of Estimates Issued</span>'  
            + '<input name="estimateCount" type="number" class="lf-input" placeholder="e.g. 1" min="0" step="1" value="0">'  
          + '</label>'  
        + '</div>'  
      + '</div>'

      // ── Optional detail toggle ──
      + '<div class="lf-detail-toggle" id="detailToggle" onclick="window._toggleLeadDetail()">'
        + '<span id="detailToggleLabel">+ Add notes &amp; context</span>'
        + '<span class="lf-detail-chevron" id="detailChevron">›</span>'
      + '</div>'
      + '<div class="lf-detail-panel" id="detailPanel" style="display:none">'
        + '<div class="lf-fields">'
          + '<label class="lf-field lf-field--full">'
            + '<span class="lf-label">What prompted the inquiry?</span>'
            + '<textarea name="prompt" rows="3" class="lf-textarea" placeholder="How did they hear about us? What triggered the call?"></textarea>'
          + '</label>'
          + '<label class="lf-field lf-field--full">'
            + '<span class="lf-label">Desired outcome / what good looks like</span>'
            + '<textarea name="desiredOutcome" rows="3" class="lf-textarea" placeholder="What does success look like for the client?"></textarea>'
          + '</label>'
          + '<label class="lf-field lf-field--full">'
            + '<span class="lf-label">Fit concerns / risk flags</span>'
            + '<textarea name="fitConcerns" rows="3" class="lf-textarea" placeholder="Anything that might be a problem?"></textarea>'
          + '</label>'
        + '</div>'
      + '</div>'

      // ── Footer actions ──
      + '<div class="lf-footer">'
        + '<button class="primary-btn lf-save-btn" type="submit">Save Lead →</button>'
        + '<button type="button" class="secondary-btn" onclick="show(\'forms\',\'lead-intake\')">Open Intake Checklist</button>'
      + '</div>'

    + '</form>';

  // Detail panel toggle
  window._toggleLeadDetail = function() {
    const panel = document.getElementById('detailPanel');
    const label = document.getElementById('detailToggleLabel');
    const chev  = document.getElementById('detailChevron');
    if (!panel) return;
    const open = panel.style.display !== 'none';
    panel.style.display = open ? 'none' : 'block';
    if (label) label.textContent = open ? '+ Add notes & context' : '− Hide notes';
    if (chev)  chev.style.transform = open ? '' : 'rotate(90deg)';
  };

  // Category tile selection
  setTimeout(() => {
    const catInput = document.getElementById('projectCategoryInput');
    document.querySelectorAll('.cat-tile').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.cat-tile').forEach(b => b.classList.remove('cat-tile--active'));
        btn.classList.add('cat-tile--active');
        if (catInput) catInput.value = btn.dataset.cat;
      });
    });
  }, 50);

  // T35: Commission preview — engine-driven, reads work type + commission source (COMM-07/08)
  setTimeout(() => {
    const jvInput  = document.querySelector('[name="jobValue"]');
    const wtSelect = document.querySelector('[name="workType"]');
    const lsSelect = document.querySelector('[name="leadSource"]'); // commission source
    const preview  = document.getElementById('commPreview');
    const previewText = document.getElementById('commPreviewText');
    function updateCommPreview() {
      if (!preview) return;
      const val = Number(jvInput?.value || 0);
      const wt  = wtSelect?.value  || 'landscape';
      const src = lsSelect?.value  || 'company_lead';
      if (!val) { preview.style.display = 'none'; return; }
      // Use master engine in preview mode (no collection gate)
      let commStr, noteStr;
      if (typeof window.estimateCommission === 'function') {
        const rep = window.getCurrentRep ? window.getCurrentRep() : null;
        const result = window.estimateCommission({
          planId:     rep?.commissionPlan || 'ryan',
          workType:   wt,
          leadSource: src,
          jobValue:   val,
          collected:  false,
          approved:   false,
          preview:    true
        });
        const est = result.amount;
        commStr = est.toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0});
        // Build short explanation: rule + cap flag
        const pct = result.rate > 0 ? ` (${Math.round(result.rate*100)}%)` : '';
        const capNote = result.capApplied ? ' · capped' : '';
        const approvalNote = result.requiresApproval ? ' · approval required' : '';
        noteStr = `Est. commission: ${commStr}${pct}${capNote}${approvalNote}`;
        // If recurring, show tiered note
        if (wt === 'maintenance_recurring') {
          noteStr = `Est. commission: ${commStr} (tiered first-month${capNote})`;
        }
      } else {
        // Fallback pre-load
        const rates = { landscape:.06, maintenance_onetime:.04, maintenance_recurring:.20, hardscape:.06, drainage:.06, design_build:.06 };
        const rate = rates[wt] || .06;
        const est  = val * rate;
        commStr = est.toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0});
        noteStr = `Est. commission: ${commStr} (${Math.round(rate*100)}%)`;
      }
      if (previewText) previewText.textContent = noteStr;
      preview.style.display = 'flex';
    }
    if (jvInput)  jvInput.addEventListener('input',  updateCommPreview);
    if (wtSelect) wtSelect.addEventListener('change', updateCommPreview);
    if (lsSelect) lsSelect.addEventListener('change', updateCommPreview);
  }, 150);

  document.getElementById('leadForm').addEventListener('submit', e=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    const opp = Object.fromEntries(fd.entries());
    opp.id = uid('opp'); opp.createdAt = new Date().toISOString(); opp.updatedAt = opp.createdAt;
    if(!opp.status) opp.status = 'New Lead';
    if(!opp.repId && currentRep) opp.repId = currentRep.id;

    // ── Client record: link existing or create new ─────────────────────────
    const isNew = opp.clientIsNew === '1';
    delete opp.clientIsNew;
    if (isNew && opp.client) {
      // Auto-create a client record from the entered data
      const newClient = {
        id: clientId(),
        name: opp.client,
        firstName: '', lastName: '', company: '',
        type: opp.clientType || 'Residential',
        status: 'Active',
        email: opp.email || '',
        phone: opp.phone || '',
        mobile: '',
        street: opp.address || '',
        street2: '', city: '', state: 'VA', zip: '',
        since: new Date().toLocaleDateString('en-US',{month:'short',year:'numeric'}),
        tags: [], notes: '', homeworksId: '',
        properties: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      const clientList = loadClients();
      // Only create if truly no match exists
      const alreadyExists = clientList.find(c => c.name.toLowerCase() === newClient.name.toLowerCase());
      if (!alreadyExists) {
        clientList.push(newClient);
        saveClients(clientList);
        opp.clientId = newClient.id;
      } else {
        opp.clientId = alreadyExists.id;
      }
    }
    // clientId already set by autocomplete selection if existing client was picked

    state.opportunities.unshift(opp); saveState();
    // Write-through to D1
    _d1SaveOpp(opp);
    showToast('Lead saved'); show('pipeline', opp.id);
  });

  // ── Client name autocomplete + prefill ─────────────────────────────────────
  setTimeout(() => {
    const input   = document.getElementById('lf-client-input');
    const dropdown= document.getElementById('lf-client-dropdown');
    const idField = document.getElementById('lf-client-id');
    const isNewField = document.getElementById('lf-client-is-new');
    const statusEl = document.getElementById('lf-client-status');
    if (!input || !dropdown) return;

    let _selectedClientId = null;

    function setClientStatus(c) {
      if (!statusEl) return;
      if (!c) {
        statusEl.innerHTML = '';
        return;
      }
      const addr = [c.street, c.city, c.state].filter(Boolean).join(', ');
      statusEl.innerHTML =
        '<span class="lf-client-chip">'
        + clientTypeBadge(c.type)
        + ' <strong>' + escapeHtml(c.name) + '</strong>'
        + (addr ? ' · ' + escapeHtml(addr) : '')
        + ' <button type="button" class="lf-client-chip-clear" title="Clear selection" onclick="window._lfClearClient()">✕</button>'
        + '</span>';
    }

    window._lfClearClient = function() {
      _selectedClientId = null;
      if (idField) { idField.value = ''; }
      if (isNewField) { isNewField.value = '1'; }
      if (input) { input.value = ''; input.readOnly = false; input.focus(); }
      if (statusEl) { statusEl.innerHTML = ''; }
    };

    function prefillFromClient(c) {
      _selectedClientId = c.id;
      if (idField) idField.value = c.id;
      if (isNewField) isNewField.value = '0';
      input.value = c.name;
      input.readOnly = true;
      setClientStatus(c);
      // Prefill contact fields only if currently empty
      const phone = document.getElementById('lf-phone');
      const email = document.getElementById('lf-email');
      const addr  = document.getElementById('lf-address');
      if (phone && !phone.value) phone.value = c.phone || c.mobile || '';
      if (email && !email.value) email.value = c.email || '';
      if (addr  && !addr.value) {
        const parts = [c.street, c.city, c.state].filter(Boolean);
        addr.value = parts.join(', ');
      }
      // Set client type radio
      const typeVal = c.type === 'Commercial' || c.type === 'HOA' ? 'Commercial' : 'Residential';
      const radio = document.querySelector('[name="clientType"][value="' + typeVal + '"]');
      if (radio) radio.checked = true;
      // Hide dropdown
      dropdown.style.display = 'none';
    }

    function renderDropdown(q) {
      const all = loadClients();
      const results = q.length < 1 ? [] : all.filter(c =>
        [c.name, c.email, c.phone, c.mobile, c.street, c.city]
          .some(f => (f||'').toLowerCase().includes(q.toLowerCase()))
      ).slice(0, 8);

      if (!q) { dropdown.style.display = 'none'; return; }

      let html = '';
      if (results.length) {
        html += results.map(c => {
          const addr = [c.street, c.city, c.state].filter(Boolean).join(', ');
          const contact = c.email || c.phone || c.mobile || '';
          return '<button type="button" class="lf-cd-item" data-id="' + c.id + '">'
            + '<span class="lf-cd-avatar">' + escapeHtml((c.name||'?')[0].toUpperCase()) + '</span>'
            + '<span class="lf-cd-info">'
              + '<span class="lf-cd-name">' + escapeHtml(c.name) + '</span>'
              + (addr || contact
                  ? '<span class="lf-cd-sub">' + escapeHtml(addr || contact) + '</span>'
                  : '')
            + '</span>'
            + '<span class="lf-cd-badge">' + clientTypeBadge(c.type) + '</span>'
            + '</button>';
        }).join('');
        html += '<div class="lf-cd-divider"></div>';
      }
      // Always show "create new" option at bottom
      html += '<button type="button" class="lf-cd-new" id="lf-cd-create">'
        + '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="7" y1="1" x2="7" y2="13"/><line x1="1" y1="7" x2="13" y2="7"/></svg>'
        + ' Create new client &ldquo;' + escapeHtml(q) + '&rdquo;'
        + '</button>';

      dropdown.innerHTML = html;
      dropdown.style.display = 'block';

      // Wire existing client clicks
      dropdown.querySelectorAll('.lf-cd-item').forEach(btn => {
        btn.addEventListener('mousedown', ev => {
          ev.preventDefault();
          const c = loadClients().find(x => x.id === btn.dataset.id);
          if (c) prefillFromClient(c);
        });
      });
      // Wire "create new" click — just keeps typed name as new client
      const createBtn = document.getElementById('lf-cd-create');
      if (createBtn) {
        createBtn.addEventListener('mousedown', ev => {
          ev.preventDefault();
          if (idField) idField.value = '';
          if (isNewField) isNewField.value = '1';
          dropdown.style.display = 'none';
          // Show inline badge indicating "new client will be created"
          if (statusEl) {
            statusEl.innerHTML = '<span class="lf-client-chip lf-client-chip--new">'
              + '<svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="7" y1="1" x2="7" y2="13"/><line x1="1" y1="7" x2="13" y2="7"/></svg>'
              + ' New client record will be created'
              + '</span>';
          }
        });
      }
    }

    input.addEventListener('input', () => {
      _selectedClientId = null;
      if (idField) idField.value = '';
      if (isNewField) isNewField.value = '1';
      if (statusEl) statusEl.innerHTML = '';
      renderDropdown(input.value.trim());
    });

    input.addEventListener('focus', () => {
      if (!_selectedClientId && input.value.trim()) renderDropdown(input.value.trim());
    });

    input.addEventListener('blur', () => {
      // Slight delay so mousedown fires first
      setTimeout(() => { dropdown.style.display = 'none'; }, 180);
    });

    // Close on outside click
    document.addEventListener('click', ev => {
      if (!dropdown.contains(ev.target) && ev.target !== input) {
        dropdown.style.display = 'none';
      }
    });

    // T36: Duplicate detection (pipeline opps only) — keep existing logic
    function checkDuplicates() {
      const name = (input?.value || '').toLowerCase().trim();
      const addrEl = document.getElementById('lf-address');
      const addr = (addrEl?.value || '').toLowerCase().trim();
      const existing = document.getElementById('dup-warn');
      if (existing) existing.remove();
      if (!name && !addr) return;
      const dupes = (state.opportunities || []).filter(o => {
        const oName = (o.client || '').toLowerCase();
        const oAddr = (o.address || '').toLowerCase();
        if (name.length > 2 && oName.includes(name)) return true;
        if (addr.length > 4 && oAddr.includes(addr)) return true;
        return false;
      }).slice(0, 3);
      if (!dupes.length) return;
      const warn = document.createElement('div');
      warn.id = 'dup-warn'; warn.className = 'dup-warn';
      warn.innerHTML = '<strong>Possible duplicate' + (dupes.length > 1 ? 's' : '') + '</strong> — similar lead already in pipeline:<br>'
        + dupes.map(o => '<span onclick="show(\'pipeline\',\'' + o.id + '\')" style="cursor:pointer;color:#4D8A86;text-decoration:underline">' + escapeHtml(o.client||'—') + ' · ' + escapeHtml(o.status||'') + '</span>').join('<br>');
      const form = document.getElementById('leadForm');
      if (form) form.prepend(warn);
    }
    input.addEventListener('blur', checkDuplicates);
    const addrEl2 = document.getElementById('lf-address');
    if (addrEl2) addrEl2.addEventListener('blur', checkDuplicates);
  }, 200);
}
function input(name,label,type='text'){ const required = type===true; const actualType = required ? 'text' : type; return `<label><span>${label}${required?' *':''}</span><input name="${name}" type="${actualType}" ${required?'required':''}></label>`; }
function select(name,label,options,selected=''){ return `<label><span>${label}</span><select name="${name}"><option value="">Select...</option>${options.map(o=>`<option ${o===selected?'selected':''}>${escapeHtml(o)}</option>`).join('')}</select></label>`; }
function textarea(name,label,value=''){ return `<label class="full"><span>${label}</span><textarea name="${name}" rows="4">${escapeHtml(value)}</textarea></label>`; }

function opportunityDetail(id){
  const o = state.opportunities.find(x=>x.id===id);
  if(!o){ return pipeline(); }
  const stageGuess   = Math.max(1, data.statuses.indexOf(o.status)+1);
  const _activeTab   = window._leadTab || 'overview';
  const _repObj      = (window.REPS||[]).find(r=>r.id===o.repId);
  const _repName     = _repObj ? _repObj.name : 'Unassigned';
  const _isOvd       = o.nextFollowUp && o.nextFollowUp < todayISO() && !['Sold / Activation','Closed Lost'].includes(o.status);
  const _estComm     = estCommission(o);
  const _cr          = window.getCurrentRep ? window.getCurrentRep() : null;
  const _isAdm       = _cr && _cr.role === 'admin';
  const _isOM        = _cr && _cr.role === 'office_manager';
  const _commsCnt    = (state.communications||[]).filter(c=>c.oppId===o.id).length;
  const _filesCnt    = (state.communications||[]).filter(c=>c.oppId===o.id&&c.files&&c.files.length).reduce((a,c)=>a+c.files.length,0);
  const _notesCnt    = (o.notes||[]).length;
  const _lastComm    = (state.communications||[]).filter(c=>c.oppId===o.id).sort((a,b)=>new Date(b.ts)-new Date(a.ts))[0];
  const _isSold      = o.status === 'Sold / Activation';
  const _isClosed    = o.status === 'Closed Lost';

  // ── Stat chip helper ─────────────────────────────────────────────────────
  const statChip = (icon, label, value, accent='') =>
    `<div class="ld-stat-chip${accent?' ld-stat-chip--'+accent:''}">
      <span class="ld-stat-icon">${icon}</span>
      <div class="ld-stat-body">
        <span class="ld-stat-label">${label}</span>
        <span class="ld-stat-val">${value}</span>
      </div>
    </div>`;

  // ── Right-rail activity snapshot ─────────────────────────────────────────
  const TYPE_ICON = { sms: gwIcon('message',14,'#4D8A86'), email: gwIcon('email',14,'#113931'), call: gwIcon('call',14,'#2D7A55'), note: gwIcon('checklist',14,'#8B6914'), proposal: gwIcon('document',14,'#4D8A86') };
  const recentComms = (state.communications||[]).filter(c=>c.oppId===o.id)
    .sort((a,b)=>new Date(b.ts)-new Date(a.ts)).slice(0,5);
  const railActivityHtml = recentComms.length ? recentComms.map(m => {
    const fmt = dt => { try{ return new Date(dt).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); }catch(e){return '';} };
    const preview = (m.subject ? m.subject : (m.body||'').slice(0,60)) || '(no content)';
    return `<div class="rail-activity-item">
      <div class="rail-act-icon">${TYPE_ICON[m.type]||gwIcon('checklist',14,'#6F7E6A')}</div>
      <div class="rail-act-body">
        <div class="rail-act-type">${m.type.toUpperCase()} <span class="rail-act-dir">${m.direction==='out'?'↑ Sent':'↓ Received'}</span></div>
        <div class="rail-act-preview">${escapeHtml(preview)}</div>
        <div class="rail-act-time">${fmt(m.ts)}</div>
      </div>
    </div>`;
  }).join('') : `<div class="rail-empty"><p>No activity yet</p></div>`;

  // ── Stage checklist for right rail ───────────────────────────────────────
  const stageChecklist = (window.AVALON_DATA.checklists||[]).find(c=>c.stage===stageGuess);

  view.innerHTML = `
  <!-- ══ STICKY LEAD HEADER ══════════════════════════════════════════════ -->
  <div class="ld-sticky-header" id="ldStickyHeader">
    <div class="ld-sticky-inner">
      <button class="ld-back-btn" onclick="show('pipeline')">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 11L4 7l5-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Pipeline
      </button>
      <div class="ld-sticky-identity">
        <div class="ld-sticky-avatar">${(o.client||'?')[0].toUpperCase()}</div>
        <div>
          <div class="ld-sticky-name">${escapeHtml(o.client||'Unnamed Lead')}</div>
          <div class="ld-sticky-sub">
            <span class="status-chip ${statusCssClass(o.status||'')}" style="font-size:10px;padding:2px 8px">${escapeHtml(o.status||'New Lead')}</span>
            <span style="color:#6F7E6A;font-size:12px">${escapeHtml(_repName)}</span>
            ${o.jobValue ? `<span style="color:#2D7A55;font-size:12px;font-weight:700">${money(Number(o.jobValue))}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="ld-sticky-actions">
        <button class="ld-action-save" onclick="saveOpportunity('${o.id}')">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 7.5L5.5 11 12 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Save
        </button>
        ${!_isSold && !_isClosed ? `<button class="ld-action-sold" onclick="openMarkSoldModal('${o.id}')">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1l1.5 4h4l-3.2 2.4 1.2 4L7 9l-3.5 2.4 1.2-4L1.5 5h4z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
          Mark Sold
        </button>` : _isSold ? `<span class="ld-sold-badge">✓ Sold</span>` : ''}
        ${_isAdm||_isOM ? `<div class="ld-overflow-wrap">
          <button class="ld-overflow-btn" onclick="toggleLeadOverflow(this)" title="More actions">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="3" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="13" r="1.2" fill="currentColor"/></svg>
          </button>
          <div class="ld-overflow-menu" style="display:none">
            <button onclick="duplicateOpportunity('${o.id}');toggleLeadOverflow()">
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><rect x="4" y="4" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M2 10V2h8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
              Duplicate
            </button>
            ${_isAdm ? `<button class="danger" onclick="deleteOpportunity('${o.id}')">
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M2 4h10M5 4V2h4v2M11 4l-.75 8H3.75L3 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
              Delete Lead
            </button>` : ''}
          </div>
        </div>` : ''}
      </div>
    </div>
  </div>

  <!-- ══ HERO IDENTITY BLOCK ════════════════════════════════════════════ -->
  <div class="ld-hero">
    <div class="ld-hero-left">
      <div class="ld-hero-avatar">${(o.client||'?').split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase()}</div>
      <div class="ld-hero-info">
        <div class="ld-eyebrow">
          <span>OPPORTUNITY</span>
          ${o.source ? `<span class="ld-source-pill">${escapeHtml(o.source)}</span>` : ''}
        </div>
        <h1 class="ld-name">${escapeHtml(o.client||'Unnamed Lead')}</h1>
        <p class="ld-subtitle">
          ${escapeHtml(o.project||o.serviceLine||'Opportunity')}
          ${o.address ? `<span class="ld-subtitle-sep">·</span> ${escapeHtml(o.address)}` : ''}
        </p>
        <div class="ld-stat-chips">
          ${statChip('<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M2 11V5l5-3 5 3v6H9V8H5v3H2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>', 'Stage', escapeHtml(o.status||'New Lead'))}
          ${statChip('<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="5" r="3" stroke="currentColor" stroke-width="1.3"/><path d="M1 13c0-3 2.7-5 6-5s6 2 6 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>', 'Rep', escapeHtml(_repName))}
          ${o.jobValue ? statChip('<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M7 1v12M4.5 9.5c0 1.1.67 2 2.5 2s2.5-.9 2.5-2-1-1.8-2.5-2-2.5-.9-2.5-2 .67-2 2.5-2 2.5.9 2.5 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>', 'Est. Value', money(Number(o.jobValue)), 'green') : ''}
          ${_estComm > 0 ? statChip('<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M2 12L7 2l5 10M4.5 8h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>', 'Commission', money(_estComm), 'blue') : ''}
          ${statChip('<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><rect x="2" y="2.5" width="10" height="9" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M5 1.5v2M9 1.5v2M2 6h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>', 'Follow-Up', prettyDate(o.nextFollowUp), _isOvd?'red':'')}
          ${statChip('<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M7 2l5.5 10H1.5L7 2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M7 6v3M7 10.5h.01" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>', 'Commission', o.commissionApproved?'Approved':'Pending', o.commissionApproved?'green':'amber')}
        </div>
      </div>
    </div>
    <div class="ld-hero-actions">
      <button class="ld-btn-primary" onclick="saveOpportunity('${o.id}')">
        <svg width="15" height="15" viewBox="0 0 14 14" fill="none"><path d="M2 7.5L5.5 11 12 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Save Changes
      </button>
      ${!_isSold && !_isClosed ? `<button class="ld-btn-sold" onclick="openMarkSoldModal('${o.id}')">
        <svg width="15" height="15" viewBox="0 0 14 14" fill="none"><path d="M7 1l1.5 4h4l-3.2 2.4 1.2 4L7 9l-3.5 2.4 1.2-4L1.5 5h4z" fill="currentColor" opacity=".9"/></svg>
        Mark Sold
      </button>` : _isSold ? `<span class="ld-sold-badge-large">✓ Sold</span>` : ''}
      ${_isAdm||_isOM ? `<div class="ld-overflow-wrap ld-overflow-hero">
        <button class="ld-btn-secondary" onclick="toggleLeadOverflow(this)">More</button>
        <div class="ld-overflow-menu" style="display:none">
          <button onclick="duplicateOpportunity('${o.id}');toggleLeadOverflow()">
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><rect x="4" y="4" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M2 10V2h8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
            Duplicate Lead
          </button>
          <button onclick="show('integrations')">
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.3"/><path d="M7 4v3l2 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
            Manage Integrations
          </button>
          ${_isAdm ? `<button class="danger" onclick="if(confirm('Delete this lead? This cannot be undone.')) deleteOpportunity('${o.id}')">
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M2 4h10M5 4V2h4v2M11 4l-.75 8H3.75L3 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
            Delete Lead
          </button>` : ''}
        </div>
      </div>` : ''}
    </div>
  </div>

  <!-- ══ PRIMARY TABS ════════════════════════════════════════════════════ -->
  <div class="ld-tab-bar">
    <button class="ld-tab ${_activeTab==='overview'?'ld-tab-active':''}" onclick="window._leadTab='overview';show('pipeline','${o.id}')">
      <svg width="15" height="15" viewBox="0 0 14 14" fill="none"><rect x="1.5" y="2" width="11" height="10" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M4 5h6M4 7.5h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
      Overview
    </button>
    <button class="ld-tab ${_activeTab==='comms'?'ld-tab-active':''}" onclick="window._leadTab='comms';show('pipeline','${o.id}')">
      <svg width="15" height="15" viewBox="0 0 14 14" fill="none"><path d="M2 2.5A.5.5 0 012.5 2h9a.5.5 0 01.5.5v6a.5.5 0 01-.5.5H8L5.5 12V9H2.5A.5.5 0 012 8.5v-6z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
      Communications
      ${_commsCnt ? `<span class="ld-tab-count">${_commsCnt}</span>` : ''}
    </button>
    <button class="ld-tab ${_activeTab==='files'?'ld-tab-active':''}" onclick="window._leadTab='files';show('pipeline','${o.id}')">
      <svg width="15" height="15" viewBox="0 0 14 14" fill="none"><path d="M3 2h5.5L11 4.5V12H3V2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 2v3h3" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" opacity=".5"/></svg>
      Files
      ${_filesCnt ? `<span class="ld-tab-count">${_filesCnt}</span>` : ''}
    </button>
    <button class="ld-tab ${_activeTab==='notes'?'ld-tab-active':''}" onclick="window._leadTab='notes';show('pipeline','${o.id}')">
      <svg width="15" height="15" viewBox="0 0 14 14" fill="none"><rect x="2" y="2" width="10" height="10" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 5h5M4.5 7.5h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
      Notes
      ${_notesCnt ? `<span class="ld-tab-count">${_notesCnt}</span>` : ''}
    </button>
    <button class="ld-tab ${_activeTab==='activity'?'ld-tab-active':''}" onclick="window._leadTab='activity';show('pipeline','${o.id}')">
      <svg width="15" height="15" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.3"/><path d="M7 4.5V7l2 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
      Activity
    </button>
  </div>

  <!-- ══ TWO-COLUMN BODY ═════════════════════════════════════════════════ -->
  <div class="ld-body">

    <!-- Main working column -->
    <div class="ld-main">

      <!-- TAB: Overview -->
      <div id="ldTabOverview" style="display:${_activeTab==='overview'?'block':'none'}">

        <!-- Contact & Opportunity Info -->
        <div class="ld-section-head">
          <svg width="15" height="15" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="5" r="3" stroke="currentColor" stroke-width="1.3"/><path d="M1 13c0-3 2.7-5 6-5s6 2 6 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
          Contact &amp; Opportunity
        </div>
        <form class="ld-card ld-form" id="oppForm">
          <div class="ld-form-grid">
            ${inputEdit('client','Client Name',o.client)}
            ${inputEdit('phone','Phone',o.phone)}
            ${inputEdit('email','Email',o.email,'email')}
            ${inputEdit('address','Property Address',o.address)}
            ${selectEdit('serviceLine','Service Line',data.serviceLines,o.serviceLine)}
            ${selectEdit('source','Lead Source',data.leadSources,o.source)}
            ${inputEdit('project','Project / Opportunity',o.project)}
            ${inputEdit('urgency','Urgency / Timing',o.urgency)}
            ${inputEdit('decisionMaker','Decision-Maker(s)',o.decisionMaker)}
            ${inputEdit('budget','Budget Range',o.budget)}
          </div>
        </form>

        <!-- Stage & Scheduling -->
        <div class="ld-section-head" style="margin-top:20px">
          <svg width="15" height="15" viewBox="0 0 14 14" fill="none"><rect x="2" y="2.5" width="10" height="9" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M5 1.5v2M9 1.5v2M2 6h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
          Stage &amp; Scheduling
        </div>
        <div class="ld-card-row">
          <div class="ld-card ld-card-sm">
            <div class="ld-card-label">Pipeline Stage</div>
            ${selectWithId('statusEdit',data.statuses,o.status)}
            <button class="ld-inline-btn" onclick="setOppField('${o.id}','status',document.getElementById('statusEdit').value)">Update Stage</button>
          </div>
          <div class="ld-card ld-card-sm">
            <div class="ld-card-label">Next Follow-Up</div>
            <input id="followEdit" type="date" value="${escapeHtml(o.nextFollowUp||'')}">
            <button class="ld-inline-btn" onclick="setOppField('${o.id}','nextFollowUp',document.getElementById('followEdit').value)">Set Date</button>
          </div>
          <div class="ld-card ld-card-sm">
            <div class="ld-card-label">Stage Guide</div>
            <p style="font-size:12px;color:#6F7E6A;margin:6px 0 10px;line-height:1.5">See what this stage requires before moving forward.</p>
            <button class="ld-inline-btn" onclick="show('process',${Math.min(stageGuess,12)})">Open Stage ${stageGuess} Guide</button>
          </div>
        </div>

        <!-- Estimate Tracking -->
        <div class="ld-section-head" style="margin-top:20px">
          <svg width="15" height="15" viewBox="0 0 14 14" fill="none"><rect x="2" y="2" width="10" height="10" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 7l1.5 1.5L9.5 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Estimate Tracking
          <span class="ld-section-sub">Paper on the street</span>
        </div>
        <div class="ld-card ld-form">
          <div class="ld-form-grid">
            <label><span>Estimate Status</span>
              <select id="estimateStatusEdit" name="estimateStatus">
                <option value="" ${!o.estimateStatus?'selected':''}>Not started</option>
                <option value="draft" ${o.estimateStatus==='draft'?'selected':''}>Draft — not yet sent</option>
                <option value="sent" ${o.estimateStatus==='sent'?'selected':''}>Sent — awaiting response</option>
                <option value="revised" ${o.estimateStatus==='revised'?'selected':''}>Revised &amp; resent</option>
                <option value="viewed" ${o.estimateStatus==='viewed'?'selected':''}>Viewed by customer</option>
                <option value="awaiting_response" ${o.estimateStatus==='awaiting_response'?'selected':''}>Awaiting response</option>
                <option value="accepted" ${o.estimateStatus==='accepted'?'selected':''}>Accepted</option>
                <option value="declined" ${o.estimateStatus==='declined'?'selected':''}>Declined</option>
                <option value="expired" ${o.estimateStatus==='expired'?'selected':''}>Expired</option>
              </select>
            </label>
            ${inputEdit('estimateAmount','Amount ($)',o.estimateAmount,'number')}
            ${inputEdit('estimateSentDate','Date Sent',o.estimateSentDate,'date')}
            ${inputEdit('estimateCount','# Estimates Issued',o.estimateCount,'number')}
          </div>
        </div>

        <!-- Qualification Notes -->
        <div class="ld-section-head" style="margin-top:20px">
          <svg width="15" height="15" viewBox="0 0 14 14" fill="none"><path d="M2 2.5A.5.5 0 012.5 2h9a.5.5 0 01.5.5v9a.5.5 0 01-.5.5h-9A.5.5 0 012 11.5v-9z" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 5h5M4.5 7.5h5M4.5 10h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
          Qualification Notes
        </div>
        <div class="ld-card ld-qual-notes-card">
          ${[
            {field:'prompt',       label:'What prompted the inquiry?',             icon:'M7 1l.9 2.6H11L8.5 5.2l.9 2.7L7 6.5l-2.4 1.4.9-2.7L3 3.6h3.1z'},
            {field:'desiredOutcome',label:'Desired outcome / what good looks like', icon:'M2 11l3.5-3.5 2.5 2.5L12 4'},
            {field:'fitConcerns',  label:'Fit concerns / risk flags',               icon:'M7 2v5M7 9.5v.5'}
          ].map(({field,label,icon})=>{
            const val = escapeHtml(o[field]||'');
            const placeholder = {
              prompt:'e.g. Referred by a neighbour, saw an ad, urgent project deadline…',
              desiredOutcome:'e.g. Full kitchen renovation complete before the holidays, budget under $30k…',
              fitConcerns:'e.g. Budget may be tight, decision-maker not confirmed, competing quotes…'
            }[field];
            return `<div class="ld-qual-field" id="qf-${field}-${o.id}">
              <div class="ld-qual-view" id="qfview-${field}-${o.id}">
                <div class="ld-qual-header">
                  <span class="ld-qual-label">
                    <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="${icon}" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    ${label}
                  </span>
                  <button class="ld-qual-edit-btn" onclick="ldQualEdit('${field}','${o.id}')" title="Edit">
                    <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M9.5 2.5l2 2-7 7H2.5v-2l7-7z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
                    Edit
                  </button>
                </div>
                <div class="ld-qual-content" id="qfcontent-${field}-${o.id}">${val || `<span class="ld-qual-empty">${placeholder}</span>`}</div>
              </div>
              <div class="ld-qual-edit" id="qfedit-${field}-${o.id}" style="display:none">
                <div class="ld-qual-header">
                  <span class="ld-qual-label">
                    <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="${icon}" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    ${label}
                  </span>
                  <div style="display:flex;gap:6px">
                    <button class="ld-qual-save-btn" onclick="ldQualSave('${field}','${o.id}')">
                      <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M2 7.5L5.5 11 12 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
                      Save
                    </button>
                    <button class="ld-qual-cancel-btn" onclick="ldQualCancel('${field}','${o.id}')">Cancel</button>
                  </div>
                </div>
                <textarea id="qfta-${field}-${o.id}" rows="4" placeholder="${placeholder}" class="ld-qual-textarea">${o[field]||''}</textarea>
              </div>
            </div>`;
          }).join('<div class="ld-qual-divider"></div>')}
        </div>

        <!-- Quick Actions -->
        <div class="ld-section-head" style="margin-top:20px">
          <svg width="15" height="15" viewBox="0 0 14 14" fill="none"><path d="M7 1l1.5 4h4l-3.2 2.4 1.2 4L7 9l-3.5 2.4 1.2-4L1.5 5h4z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
          Quick Actions
        </div>
        <div class="ld-qa-grid">
          <button class="ld-qa-btn" id="qa_homeworks_${o.id}" onclick="qaAction('homeworks','${o.id}',this)">
            <svg width="18" height="18" viewBox="0 0 14 14" fill="none"><path d="M7 1L1 5v8h4V9h4v4h4V5L7 1z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
            <div><div class="ld-qa-title">Push to Homeworks</div><div class="ld-qa-sub">Sync to CRM</div></div>
          </button>
          <button class="ld-qa-btn" id="qa_calendar_${o.id}" onclick="qaAction('calendar','${o.id}',this)">
            <svg width="18" height="18" viewBox="0 0 14 14" fill="none"><rect x="2" y="2.5" width="10" height="9" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M5 1.5v2M9 1.5v2M2 6h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
            <div><div class="ld-qa-title">Schedule Event</div><div class="ld-qa-sub">Google Calendar</div></div>
          </button>
          <button class="ld-qa-btn" id="qa_gmail_${o.id}" onclick="qaAction('gmail','${o.id}',this)">
            <svg width="18" height="18" viewBox="0 0 14 14" fill="none"><rect x="1.5" y="3" width="11" height="8" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M1.5 5l5.5 3.5L12.5 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
            <div><div class="ld-qa-title">Compose Email</div><div class="ld-qa-sub">Gmail draft</div></div>
          </button>
          <button class="ld-qa-btn" onclick="window._leadTab='comms';show('pipeline','${o.id}')">
            <svg width="18" height="18" viewBox="0 0 14 14" fill="none"><path d="M7 1a5.5 5.5 0 110 11 5.5 5.5 0 010-11z" stroke="currentColor" stroke-width="1.3"/><path d="M7 4.5V7l2 1.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
            <div><div class="ld-qa-title">Log Call</div><div class="ld-qa-sub">Record outcome</div></div>
          </button>
          <button class="ld-qa-btn" onclick="window._leadTab='notes';show('pipeline','${o.id}')">
            <svg width="18" height="18" viewBox="0 0 14 14" fill="none"><rect x="2" y="2" width="10" height="10" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 5h5M4.5 7.5h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
            <div><div class="ld-qa-title">Add Note</div><div class="ld-qa-sub">Save observation</div></div>
          </button>
        </div>

        <!-- Admin / Office Controls (role-gated) -->
        ${(()=>{
          if (!_isAdm && !_isOM) return '';
          const _ca = o;
          const _commApprovedHtml = _isAdm
            ? `<label class="ld-toggle-row"><input type="checkbox" id="commApproved" ${_ca.commissionApproved?'checked':''} onchange="setOppField('${o.id}','commissionApproved',this.checked);showToast('Commission approval updated')"><span>Commission Approved</span></label>`
            : `<div class="ld-locked-field">Commission Approved — Tyler (Owner) only</div>`;
          const _borderColor = _isAdm ? '#4D8A86' : '#8B6914';
          const _panelTitle  = _isAdm ? 'Admin Controls' : 'Office Controls';
          return `<div class="ld-section-head" style="margin-top:20px;border-color:${_borderColor}40">
            <svg width="15" height="15" viewBox="0 0 14 14" fill="none"><path d="M7 1l5.5 3v4c0 2.8-2 5-5.5 6C2 14 0 11.8 0 9V4L7 1z" stroke="${_borderColor}" stroke-width="1.3" stroke-linejoin="round"/></svg>
            <span style="color:${_borderColor}">${_panelTitle}</span>
          </div>
          <div class="ld-card" style="border-color:${_borderColor}40">
            <div class="ld-form-grid ld-form-grid-3">
              <div>${_commApprovedHtml}</div>
              <div><label class="ld-toggle-row"><input type="checkbox" id="payCollected" ${_ca.collected?'checked':''} onchange="setOppField('${o.id}','collected',this.checked);showToast('Collection status updated')"><span>Payment Collected</span></label></div>
              <div>
                <div class="ld-card-label">Reassign Rep</div>
                <select onchange="setOppField('${o.id}','repId',this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:10px;font-size:13px">
                  <option value="">— Assign —</option>
                  ${(window.REPS||[]).map(r=>`<option value="${r.id}" ${o.repId===r.id?'selected':''}>${r.name}</option>`).join('')}
                </select>
              </div>
            </div>
            <p style="font-size:11.5px;color:#6F7E6A;margin:12px 0 0;padding-top:10px;border-top:1px solid var(--line)">Commission paid only when both Approved + Collected are checked. Approval is Tyler's decision.</p>
          </div>`;
        })()}

      </div><!-- /ldTabOverview -->

      <!-- TAB: Communications -->
      <div id="ldTabComms" style="display:${_activeTab==='comms'?'block':'none'}">
        ${commsBoardHtml(o.id, o)}
      </div>

      <!-- TAB: Files -->
      <div id="ldTabFiles" style="display:${_activeTab==='files'?'block':'none'}">
        ${filesTabHtml(o.id, o)}
      </div>

      <!-- TAB: Notes -->
      <div id="ldTabNotes" style="display:${_activeTab==='notes'?'block':'none'}">
        <div class="ld-card" style="margin-top:16px">
          <div class="ld-section-head" style="border:none;margin:0 0 12px;padding:0">
            <svg width="15" height="15" viewBox="0 0 14 14" fill="none"><rect x="2" y="2" width="10" height="10" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 5h5M4.5 7.5h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
            Activity &amp; Notes
          </div>
          <div id="noteList" style="margin-bottom:16px">${renderNotes(o.id)}</div>
          <textarea id="newNote" rows="4" placeholder="Add call note, site observation, objection, or next step…" style="width:100%;border:1px solid var(--line);border-radius:12px;padding:12px;font-size:13px;resize:vertical"></textarea>
          <button class="ld-btn-primary" style="margin-top:10px" onclick="addNote('${o.id}')">Add Note</button>
        </div>
      </div>

      <!-- TAB: Activity -->
      <div id="ldTabActivity" style="display:${_activeTab==='activity'?'block':'none'}">
        <div class="ld-card" style="margin-top:16px">
          <div class="ld-section-head" style="border:none;margin:0 0 16px;padding:0">
            <svg width="15" height="15" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.3"/><path d="M7 4.5V7l2 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
            Full Activity Log
          </div>
          ${(state.communications||[]).filter(c=>c.oppId===o.id).length === 0 ?
            `<div style="text-align:center;padding:40px;color:#6F7E6A">
              <div style="font-size:28px;margin-bottom:12px">gwIcon('checklist',16)</div>
              <p style="font-weight:600;margin:0 0 6px">No activity yet</p>
              <p style="font-size:12.5px;color:#5C6B58;margin:0">Activity will appear here as you log calls, emails, and notes.</p>
            </div>` :
            (state.communications||[]).filter(c=>c.oppId===o.id)
              .sort((a,b)=>new Date(b.ts)-new Date(a.ts))
              .map(m => {
                const fmt = dt => { try{ return new Date(dt).toLocaleString(undefined,{weekday:'short',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); }catch(e){return '';} };
                const typeColors = {sms:'#2D7A55',email:'#1A4740',call:'#8B6914',note:'#6F7E6A',proposal:'#B8744F'};
                const tc = typeColors[m.type]||'#6F7E6A';
                return `<div class="ld-activity-item">
                  <div class="ld-act-dot" style="background:${tc}22;border-color:${tc}44;color:${tc}">${TYPE_ICON[m.type]||gwIcon('checklist',14,'#6F7E6A')}</div>
                  <div class="ld-act-content">
                    <div class="ld-act-header">
                      <span class="ld-act-type" style="color:${tc}">${m.type.toUpperCase()}</span>
                      <span class="ld-act-dir">${m.direction==='out'?'↑ Outbound':'↓ Inbound'}</span>
                      <span class="ld-act-time">${fmt(m.ts)}</span>
                    </div>
                    ${m.subject ? `<div class="ld-act-subject">${escapeHtml(m.subject)}</div>` : ''}
                    <div class="ld-act-body">${escapeHtml((m.body||'').slice(0,160))}${(m.body||'').length>160?'…':''}</div>
                    ${m.sentBy ? `<div class="ld-act-actor">by ${escapeHtml(m.sentBy)}</div>` : ''}
                  </div>
                </div>`;
              }).join('')
          }
        </div>
      </div>

    </div><!-- /ld-main -->

    <!-- ── RIGHT CONTEXT RAIL ──────────────────────────────────────── -->
    <aside class="ld-rail">

      <!-- Follow-up card -->
      <div class="ld-rail-card ${_isOvd?'ld-rail-card--alert':''}">
        <div class="ld-rail-card-head">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="2" y="2.5" width="10" height="9" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M5 1.5v2M9 1.5v2M2 6h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
          Next Follow-Up
        </div>
        <div class="ld-rail-follow-date ${_isOvd?'overdue':''}">${prettyDate(o.nextFollowUp)}</div>
        ${_isOvd ? '<div class="ld-rail-overdue-badge">gwIcon('warning',16) Overdue</div>' : ''}
        <input type="date" id="railFollowEdit" value="${escapeHtml(o.nextFollowUp||'')}" style="width:100%;margin-top:10px;padding:7px 10px;border:1px solid var(--line);border-radius:9px;font-size:12px">
        <button class="ld-rail-btn" onclick="setOppField('${o.id}','nextFollowUp',document.getElementById('railFollowEdit').value);showToast('Follow-up updated')">Update</button>
      </div>

      <!-- Last contact card -->
      <div class="ld-rail-card">
        <div class="ld-rail-card-head">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 2.5A.5.5 0 012.5 2h9a.5.5 0 01.5.5v6a.5.5 0 01-.5.5H8L5.5 12V9H2.5A.5.5 0 012 8.5v-6z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
          Last Contact
        </div>
        ${_lastComm ? `
          <div class="ld-rail-last-type">${TYPE_ICON[_lastComm.type]||gwIcon('checklist',14,'#6F7E6A')} ${_lastComm.type.toUpperCase()}</div>
          <div class="ld-rail-last-time">${(()=>{ try{ return new Date(_lastComm.ts).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); }catch(e){return '—';} })()}</div>
          <div class="ld-rail-last-preview">${escapeHtml((_lastComm.subject||_lastComm.body||'').slice(0,80))}${(_lastComm.subject||_lastComm.body||'').length>80?'…':''}</div>
        ` : '<div class="ld-rail-empty">No contact logged yet</div>'}
        <button class="ld-rail-btn" onclick="window._leadTab='comms';show('pipeline','${o.id}')">
          Go to Communications →
        </button>
      </div>

      <!-- Stage checklist preview -->
      ${stageChecklist ? `<div class="ld-rail-card">
        <div class="ld-rail-card-head">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 7.5L5.5 11 12 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Stage ${stageGuess} Checklist
        </div>
        <div style="font-size:12px;color:#6F7E6A;margin-bottom:8px">${escapeHtml(stageChecklist.title)}</div>
        ${renderChecklist(stageChecklist, true, o.id)}
      </div>` : ''}

      <!-- Pipeline stats card -->
      <div class="ld-rail-card">
        <div class="ld-rail-card-head">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 12V8M5.5 12V5M9 12V7M12.5 12V3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          Lead Snapshot
        </div>
        <div class="ld-rail-stats">
          <div class="ld-rail-stat"><span>${_commsCnt}</span><label>Messages</label></div>
          <div class="ld-rail-stat"><span>${_filesCnt}</span><label>Files</label></div>
          <div class="ld-rail-stat"><span>${_notesCnt}</span><label>Notes</label></div>
          <div class="ld-rail-stat"><span>${o.jobValue ? money(Number(o.jobValue)) : '—'}</span><label>Value</label></div>
        </div>
      </div>

      <!-- Recent activity mini-feed -->
      <div class="ld-rail-card">
        <div class="ld-rail-card-head">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.3"/><path d="M7 4.5V7l2 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
          Recent Activity
        </div>
        ${railActivityHtml}
        ${_commsCnt > 5 ? `<button class="ld-rail-btn" onclick="window._leadTab='activity';show('pipeline','${o.id}')">View all ${_commsCnt} →</button>` : ''}
      </div>

    </aside>

  </div><!-- /ld-body -->
  `;

  // Wire up Communications compose after render
  if(_activeTab==='comms') wireCommsCompose(o.id, o);

  // ── Lazy-load D1 notes when Notes tab is active or becomes active ──────────
  // Fire immediately if notes tab is visible; otherwise wire the tab button click
  if (_activeTab === 'notes' && window._d1Ready) {
    _d1LoadNotes(o.id); // async, refreshes #noteList when done
  }
  const _notesTabBtn = document.querySelector('[data-tab="notes"]');
  if (_notesTabBtn && window._d1Ready) {
    _notesTabBtn.addEventListener('click', () => {
      setTimeout(() => _d1LoadNotes(o.id), 50);
    }, { once: true });
  }

  // Sticky header scroll behavior
  const stickyEl = document.getElementById('ldStickyHeader');
  const heroEl   = view.querySelector('.ld-hero');
  if(stickyEl && heroEl){
    const obs = new IntersectionObserver(([e])=>{
      stickyEl.classList.toggle('ld-sticky-visible', !e.isIntersecting);
    }, { threshold:0, rootMargin:'-60px 0px 0px 0px' });
    obs.observe(heroEl);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMUNICATIONS BOARD — per-lead conversation, messages, calls, emails, files
// ═══════════════════════════════════════════════════════════════════════════

function commsBoardHtml(oppId, opp){
  const msgs = (state.communications||[]).filter(c=>c.oppId===oppId).sort((a,b)=>new Date(a.ts)-new Date(b.ts));
  const clientName = escapeHtml(opp.client||'Lead');
  const clientEmail = escapeHtml(opp.email||'');
  const clientPhone = escapeHtml(opp.phone||'');

  const TYPE_META = {
    sms:   { label:'SMS',      color:'#2D7A55', icon:'<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 2.5A.5.5 0 012.5 2h9a.5.5 0 01.5.5v6a.5.5 0 01-.5.5H8L5.5 12V9H2.5A.5.5 0 012 8.5v-6z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>' },
    email: { label:'Email',    color:'#1A4740', icon:'<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1.5" y="3" width="11" height="8" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M1.5 5l5.5 3.5L12.5 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>' },
    call:  { label:'Call',     color:'#8B6914', icon:'<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M4.5 2C4.5 2 5 4 4 5S2 5.5 2 5.5C2 8 6 12 8.5 12c0 0 .5-2 1.5-2s3 .5 3 .5-.5 2-2 2C7 13 1 7 1 3.5c0 0 2 .5 3-1S4.5 2 4.5 2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>' },
    note:  { label:'Note',     color:'#6F7E6A', icon:'<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 2.5A.5.5 0 012.5 2h9a.5.5 0 01.5.5v6a.5.5 0 01-.5.5H8L5.5 12V9H2.5A.5.5 0 012 8.5v-6z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>' },
    proposal:{ label:'Proposal', color:'#B8744F', icon:'<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 2h5.5L11 4.5V12H3V2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 2v3h3" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" opacity=".6"/></svg>' },
  };

  // Group messages by date
  function groupByDate(msgs){
    const groups = {};
    msgs.forEach(m => {
      const d = m.ts ? new Date(m.ts).toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'}) : 'Unknown';
      if(!groups[d]) groups[d] = [];
      groups[d].push(m);
    });
    return groups;
  }

  function fileChips(files){
    if(!files||!files.length) return '';
    return '<div class="comm-file-chips">' + files.map(f=>{
      const ext = (f.name||'').split('.').pop().toLowerCase();
      const isImg = ['jpg','jpeg','png','gif','webp'].includes(ext);
      const isPdf = ext==='pdf';
      const icon = isImg ? gwIcon('image',14,'#4D8A86') : isPdf ? gwIcon('document',14,'#8B3A2A') : ext==='docx'||ext==='doc' ? gwIcon('note',14,'#113931') : gwIcon('attachment',14,'#6F7E6A');
      return '<span class="comm-file-chip" title="'+escapeHtml(f.name)+'">' + icon + ' <span>'+escapeHtml(f.name)+'</span></span>';
    }).join('') + '</div>';
  }

  function renderMsg(m){
    const meta = TYPE_META[m.type] || TYPE_META.note;
    const isOut = m.direction === 'out';
    const fmt = dt => { try{ return new Date(dt).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}); }catch(e){return '';} };
    return '<div class="comm-msg comm-msg-'+(isOut?'out':'in')+'">' +
      '<div class="comm-bubble">' +
        '<div class="comm-meta-row">' +
          '<span class="comm-type-badge" style="background:'+meta.color+'22;color:'+meta.color+';border-color:'+meta.color+'44">'+meta.icon+' '+meta.label+'</span>' +
          (m.gmailSent ? '<span class="comm-gmail-badge">gwIcon('success',16) Sent via Gmail</span>' : (m.type==='email'&&m.direction==='out' ? '<span class="comm-gmail-badge comm-gmail-local">gwIcon('checklist',16) Logged locally</span>' : '')) +
          (m.subject ? '<span class="comm-subject">'+escapeHtml(m.subject)+'</span>' : '') +
          '<span class="comm-time">'+fmt(m.ts)+'</span>' +
          '<button class="comm-delete-btn" title="Delete" onclick="deleteComm(\''+m.id+'\',\''+oppId+'\')">×</button>' +
        '</div>' +
        '<div class="comm-body">'+nl2br(m.body||'')+'</div>' +
        fileChips(m.files) +
        (m.callDuration ? '<div class="comm-call-dur">⏱ '+escapeHtml(m.callDuration)+'</div>' : '') +
      '</div>' +
    '</div>';
  }

  // Generate initials for avatar
  const initials = (clientName||'?').split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase();
  const msgCount = msgs.length;

  const groups = groupByDate(msgs);
  const threadHtml = Object.keys(groups).length === 0
    ? '<div class="comm-empty">' +
        '<div class="comm-empty-icon">gwIcon('message',16)</div>' +
        '<p>No communications yet for '+clientName+'.</p>' +
        '<p style="color:#4A5947;font-size:12.5px;max-width:320px;line-height:1.6">Use the compose bar below to log a call, send an SMS, draft an email, or attach a proposal.</p>' +
      '</div>'
    : Object.keys(groups).map(date =>
        '<div class="comm-date-divider"><span>'+date+'</span></div>' +
        groups[date].map(renderMsg).join('')
      ).join('');

  return '<div class="comms-board">' +
    /* ── Header ── */
    '<div class="comms-header">' +
      '<div class="comms-header-top">' +
        '<div class="comms-header-identity">' +
          '<div class="comms-avatar">'+initials+'</div>' +
          '<div>' +
            '<div class="comms-header-name">'+clientName+'</div>' +
            '<div class="comms-header-sub">'+(clientPhone||clientEmail||'No contact info')+(opp.serviceLine?' &middot; '+escapeHtml(opp.serviceLine):'')+'</div>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          (msgCount > 0 ? '<div class="comms-header-status"><div class="comms-header-status-dot"></div>'+msgCount+' message'+(msgCount!==1?'s':'')+'</div>' : '') +
        '</div>' +
      '</div>' +
      '<div class="comms-contact-chips">' +
        (clientPhone ? '<a class="comm-contact-chip" href="tel:'+opp.phone+'">' +
          '<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M4.5 2C4.5 2 5 4 4 5S2 5.5 2 5.5C2 8 6 12 8.5 12c0 0 .5-2 1.5-2s3 .5 3 .5-.5 2-2 2C7 13 1 7 1 3.5c0 0 2 .5 3-1S4.5 2 4.5 2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>' +
          clientPhone+'</a>' : '') +
        (clientEmail ? '<a class="comm-contact-chip" href="mailto:'+opp.email+'">' +
          '<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><rect x="1.5" y="3" width="11" height="8" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M1.5 5l5.5 3.5L12.5 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>' +
          clientEmail+'</a>' : '') +
      '</div>' +
    '</div>' +
    /* ── Thread ── */
    '<div class="comms-thread" id="commsThread">'+threadHtml+'</div>' +
    /* ── Compose ── */
    '<div class="comms-compose" id="commsCompose">' +
      /* Type switcher */
      '<div class="compose-type-tabs" id="composeTypeTabs">' +
        '<button class="ctype-btn ctype-active" data-ctype="sms">' +
          '<svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M2 2.5A.5.5 0 012.5 2h9a.5.5 0 01.5.5v6a.5.5 0 01-.5.5H8L5.5 12V9H2.5A.5.5 0 012 8.5v-6z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>' +
          'SMS' +
        '</button>' +
        '<button class="ctype-btn" data-ctype="email">' +
          '<svg width="13" height="13" viewBox="0 0 14 14" fill="none"><rect x="1.5" y="3" width="11" height="8" rx="1" stroke="currentColor" stroke-width="1.4"/><path d="M1.5 5l5.5 3.5L12.5 5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>' +
          'Email' +
        '</button>' +
        '<button class="ctype-btn" data-ctype="call">' +
          '<svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M4.5 2C4.5 2 5 4 4 5S2 5.5 2 5.5C2 8 6 12 8.5 12c0 0 .5-2 1.5-2s3 .5 3 .5-.5 2-2 2C7 13 1 7 1 3.5c0 0 2 .5 3-1S4.5 2 4.5 2z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>' +
          'Log Call' +
        '</button>' +
        '<button class="ctype-btn" data-ctype="note">' +
          '<svg width="13" height="13" viewBox="0 0 14 14" fill="none"><rect x="2" y="2" width="10" height="10" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M4.5 5h5M4.5 7.5h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>' +
          'Note' +
        '</button>' +
        '<button class="ctype-btn" data-ctype="proposal">' +
          '<svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M3 2h5.5L11 4.5V12H3V2z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 2v3h3" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" opacity=".6"/></svg>' +
          'Proposal' +
        '</button>' +
      '</div>' +
      /* Subject (email only) */
      '<div id="composeSubjectRow" style="display:none">' +
        '<input id="composeSubject" type="text" class="compose-field" placeholder="Subject line…">' +
      '</div>' +
      /* Call duration (call only) */
      '<div id="composeCallDurRow" style="display:none">' +
        '<input id="composeCallDur" type="text" class="compose-field" placeholder="Call duration (e.g. 4 min 30 sec)…">' +
      '</div>' +
      /* Body */
      '<div class="compose-body-row">' +
        '<textarea id="composeBody" rows="3" placeholder="Type your message…"></textarea>' +
      '</div>' +
      /* Actions row */
      '<div class="compose-actions-row">' +
        '<label class="compose-attach-btn" title="Attach file">' +
          '<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M14 8.5l-6.5 6.5a4.243 4.243 0 01-6-6l7-7a2.5 2.5 0 013.5 3.5L5.5 12A1 1 0 014 10.5l6-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          'Attach' +
          '<input type="file" id="composeFileInput" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.csv" style="display:none">' +
        '</label>' +
        '<div id="attachPreview" class="attach-preview-row"></div>' +
        '<div style="margin-left:auto;display:flex;gap:6px;align-items:center">' +
          /* Direction toggle */
          '<div class="compose-dir-toggle" id="composeDirToggle">' +
            '<button id="dirOutBtn" class="dir-active" onclick="setCommDir(\'out\')">↑ Out</button>' +
            '<button id="dirInBtn" onclick="setCommDir(\'in\')">↓ In</button>' +
          '</div>' +
          /* Hidden select for compatibility */
          '<select id="composeDirection" style="display:none">' +
            '<option value="out">out</option>' +
            '<option value="in">in</option>' +
          '</select>' +
          '<button class="comms-send-btn" onclick="sendComm(\''+oppId+'\')">' +
            '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 8l12-6-6 12V9L2 8z" fill="currentColor"/></svg>' +
            'Send / Log' +
          '</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function filesTabHtml(oppId, opp){
  const allMsgs = (state.communications||[]).filter(c=>c.oppId===oppId && c.files && c.files.length);
  const allFiles = [];
  allMsgs.forEach(m => m.files.forEach(f => allFiles.push({...f, ts:m.ts, type:m.type, commId:m.id})));
  allFiles.sort((a,b)=>new Date(b.ts)-new Date(a.ts));

  const fmt = dt => { try{ return new Date(dt).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); }catch(e){return '';} };

  if(!allFiles.length) return '<div class="comms-board"><div class="comm-empty"><div class="comm-empty-icon">gwIcon('folder',16)</div><p>No files attached yet.</p><p style="color:#4A5947;font-size:12.5px;max-width:300px;line-height:1.6">Attach photos, PDFs, proposals, and documents from the Communications tab.</p></div></div>';

  const ext2icon = ext => {
    const e = (ext||'').toLowerCase();
    if(['jpg','jpeg','png','gif','webp'].includes(e)) return gwIcon('image',16,'#4D8A86');
    if(e==='pdf') return gwIcon('document',16,'#8B3A2A');
    if(['doc','docx'].includes(e)) return gwIcon('note',16,'#113931');
    if(['xls','xlsx'].includes(e)) return gwIcon('spreadsheet',16,'#2D7A55');
    return gwIcon('attachment',16,'#6F7E6A');
  };

  const clientInitials = (opp.client||'?').split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase();
  return '<div class="comms-board">' +
    '<div class="comms-header">' +
      '<div class="comms-header-top">' +
        '<div class="comms-header-identity">' +
          '<div class="comms-avatar" style="background:linear-gradient(135deg,#4D8A86,#4D8A86)">'+clientInitials+'</div>' +
          '<div>' +
            '<div class="comms-header-name">Files &amp; Attachments</div>' +
            '<div class="comms-header-sub">'+allFiles.length+' file'+(allFiles.length!==1?'s':'')+' &middot; '+escapeHtml(opp.client||'Lead')+'</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="files-grid">' +
    allFiles.map(f=>{
      const ext = (f.name||'').split('.').pop();
      const isImg = ['jpg','jpeg','png','gif','webp'].includes(ext.toLowerCase());
      return '<div class="file-card">' +
        '<div class="file-card-icon">'+(isImg&&f.dataUrl?'<img src="'+f.dataUrl+'" alt="'+escapeHtml(f.name)+'" style="width:100%;height:80px;object-fit:cover;border-radius:6px;">':ext2icon(ext)+'<span style="font-size:.65rem;color:#6F7E6A;display:block;margin-top:4px">'+ext.toUpperCase()+'</span>')+'</div>' +
        '<div class="file-card-name" title="'+escapeHtml(f.name)+'">'+escapeHtml(f.name)+'</div>' +
        '<div class="file-card-meta">'+fmt(f.ts)+'</div>' +
        (f.dataUrl ? '<a class="file-card-dl" href="'+f.dataUrl+'" download="'+escapeHtml(f.name)+'" target="_blank">Download</a>' : '<span class="file-card-dl muted" style="opacity:.4">No preview</span>') +
      '</div>';
    }).join('') +
    '</div></div>';
}

function wireCommsCompose(oppId){
  const typeTabs = document.querySelectorAll('.ctype-btn');
  let currentType = 'sms';
  const subjectRow = document.getElementById('composeSubjectRow');
  const callDurRow = document.getElementById('composeCallDurRow');
  const fileInput  = document.getElementById('composeFileInput');
  const preview    = document.getElementById('attachPreview');
  let pendingFiles = [];

  // Inject a Gmail status banner above the compose bar (email type only)
  function updateGmailBanner(type){
    let banner = document.getElementById('gmailStatusBanner');
    if(type !== 'email'){
      if(banner) banner.remove();
      return;
    }
    if(!banner){
      banner = document.createElement('div');
      banner.id = 'gmailStatusBanner';
      const compose = document.getElementById('commsCompose');
      if(compose) compose.insertBefore(banner, compose.firstChild);
    }
    const googleConnected = (typeof isGoogleConnected === 'function') && isGoogleConnected();
    const fromEmail = (typeof getGoogleUserEmail === 'function') ? getGoogleUserEmail() : '';
    if(googleConnected && fromEmail){
      banner.style.cssText = 'padding:8px 14px;background:#2D7A5518;border:1px solid #2D7A5544;border-radius:8px;font-size:12px;color:#2D7A55;display:flex;align-items:center;gap:8px;margin-bottom:2px';
      banner.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1.5" y="3" width="11" height="8" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M1.5 5l5.5 3.5L12.5 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg> Emails will be sent from <strong style="margin-left:4px;color:#B8DEC9">' + escapeHtml(fromEmail) + '</strong> via Gmail &nbsp;<span style="opacity:.6;font-size:11px">— to lead\'s email address on file</span>';
    } else {
      banner.style.cssText = 'padding:8px 14px;background:#8B691418;border:1px solid #8B691444;border-radius:8px;font-size:12px;color:#8B6914;display:flex;align-items:center;gap:8px;margin-bottom:2px;flex-wrap:wrap';
      banner.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2l5.5 10H1.5L7 2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M7 6v3M7 10.5h.01" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg> Google not connected — email will be <strong style="margin:0 4px">logged locally only</strong> and not actually sent. <button onclick="show(\'integrations\')" style="background:rgba(139,105,20,.19);border:1px solid #8B691466;border-radius:6px;color:#8B6914;padding:2px 10px;font-size:11px;font-weight:700;cursor:pointer;margin-left:4px">Connect Google →</button>';
    }
  }

  typeTabs.forEach(btn=>{
    btn.addEventListener('click',()=>{
      typeTabs.forEach(b=>b.classList.remove('ctype-active'));
      btn.classList.add('ctype-active');
      currentType = btn.dataset.ctype;
      if(subjectRow) subjectRow.style.display = currentType==='email'?'block':'none';
      if(callDurRow) callDurRow.style.display = currentType==='call'?'block':'none';
      updateGmailBanner(currentType);
      const body = document.getElementById('composeBody');
      if(body){
        const placeholders = {
          sms: 'Type your SMS message…',
          email: 'Type your email body…',
          call: 'Call notes, outcome, what was discussed…',
          note: 'Internal note (not sent to client)…',
          proposal: 'Proposal details, scope summary, pricing notes…'
        };
        body.placeholder = placeholders[currentType]||'Type…';
      }
    });
  });

  if(fileInput){
    fileInput.addEventListener('change', ()=>{
      Array.from(fileInput.files).forEach(file=>{
        const reader = new FileReader();
        reader.onload = e=>{
          pendingFiles.push({ name:file.name, size:file.size, dataUrl:e.target.result });
          renderAttachPreview();
        };
        reader.readAsDataURL(file);
      });
      fileInput.value='';
    });
  }

  function renderAttachPreview(){
    if(!preview) return;
    preview.innerHTML = pendingFiles.map((f,i)=>{
      const ext = f.name.split('.').pop().toLowerCase();
      const isImg = ['jpg','jpeg','png','gif','webp'].includes(ext);
      return '<span class="attach-chip">'+(isImg ? gwIcon('image',14,'#4D8A86') : gwIcon('attachment',14,'#6F7E6A'))+' <span>'+escapeHtml(f.name)+'</span><button onclick="removePendingFile('+i+')" title="Remove">×</button></span>';
    }).join('');
  }

  window.removePendingFile = function(idx){
    pendingFiles.splice(idx,1);
    renderAttachPreview();
  };

  window._commsPendingFiles = pendingFiles;
  window._commsCurrentType  = function(){ return currentType; };

  // Direction toggle wiring
  window.setCommDir = function(dir){
    const sel = document.getElementById('composeDirection');
    if(sel) sel.value = dir;
    const outBtn = document.getElementById('dirOutBtn');
    const inBtn  = document.getElementById('dirInBtn');
    if(outBtn) outBtn.classList.toggle('dir-active', dir==='out');
    if(inBtn)  inBtn.classList.toggle('dir-active', dir==='in');
  };
}

window.sendComm = async function(oppId){
  const body      = (document.getElementById('composeBody')||{}).value||'';
  const subject   = (document.getElementById('composeSubject')||{}).value||'';
  const callDur   = (document.getElementById('composeCallDur')||{}).value||'';
  const direction = (document.getElementById('composeDirection')||{}).value||'out';
  const type      = window._commsCurrentType ? window._commsCurrentType() : 'note';
  const files     = window._commsPendingFiles || [];
  const opp       = state.opportunities.find(x=>x.id===oppId);

  if(!body.trim() && !files.length){
    showToast('Type a message or attach a file first');
    return;
  }

  // ── Gmail send: attempt real send when type=email, Google connected, and outbound ──
  if(type === 'email' && direction === 'out'){
    const googleConnected = (typeof isGoogleConnected === 'function') && isGoogleConnected();
    if(!googleConnected){
      // Warn the user — email will be logged only, not sent
      showToast('Google not connected — email logged locally only. Connect in Integrations to send real emails.');
    } else {
      // Require a To address and subject
      const toAddr = opp ? opp.email : '';
      if(!toAddr){
        showToast('No email address on this lead — add one in the lead form first');
        return;
      }
      if(!subject.trim()){
        showToast('Add a subject line before sending');
        return;
      }
      // Disable send button while sending
      const sendBtn = document.querySelector('.comms-send-btn');
      const origHtml = sendBtn ? sendBtn.innerHTML : '';
      if(sendBtn){ sendBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" style="animation:spin .8s linear infinite"><path d="M8 1.5A6.5 6.5 0 111.5 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg> Sending…'; sendBtn.disabled = true; }
      try {
        const htmlBody = body.replace(/\n/g,'<br>');
        await gmailSendEmail({ to: toAddr, subject: subject.trim(), body: htmlBody });
        showToast('Email sent via Gmail gwIcon('success',16) — from ' + (getGoogleUserEmail ? getGoogleUserEmail() : 'your Google account'));
      } catch(e){
        showToast('Gmail error: ' + (e.message||'Send failed') + ' — email logged locally.');
        if(sendBtn){ sendBtn.innerHTML = origHtml; sendBtn.disabled = false; }
        // Still log locally even if send fails
      }
      if(sendBtn){ sendBtn.innerHTML = origHtml; sendBtn.disabled = false; }
    }
  }

  const msg = {
    id: uid('comm'),
    oppId,
    type,
    direction,
    body: body.trim(),
    subject: subject.trim()||null,
    callDuration: callDur.trim()||null,
    files: files.map(f=>({name:f.name, size:f.size, dataUrl:f.dataUrl})),
    ts: new Date().toISOString(),
    sentBy: (window.getCurrentRep ? window.getCurrentRep() : null)?.name || 'Rep',
    // Track whether this was actually sent via Gmail
    gmailSent: (type==='email' && direction==='out' && typeof isGoogleConnected==='function' && isGoogleConnected() && !!(opp&&opp.email) && !!subject.trim())
  };

  if(!state.communications) state.communications = [];
  state.communications.push(msg);

  // Mirror a short note into the lead's activity timeline
  if(opp){
    const notePrefix = { sms:'[SMS]', email:'[Email]', call:'[Call]', note:'[Note]', proposal:'[Proposal]' }[type]||'[Comm]';
    const shortBody  = (subject ? subject+': ' : '') + (body||'').slice(0,120);
    opp.notes = opp.notes||[];
    opp.notes.push({ id:uid('note'), text:notePrefix+' '+shortBody, createdAt:msg.ts, type });
    opp.updatedAt = new Date().toISOString();
  }

  saveState();

  const typeLabels = { sms:'SMS sent', email:'Email logged', call:'Call logged', note:'Note saved', proposal:'Proposal logged' };
  if(type !== 'email') showToast((typeLabels[type]||'Logged') + (files.length?' + '+files.length+' file(s)':''));

  window._commsPendingFiles = [];
  window._leadTab = 'comms';
  show('pipeline', oppId);
};

window.deleteComm = function(commId, oppId){
  if(!confirm('Delete this communication entry?')) return;
  state.communications = (state.communications||[]).filter(c=>c.id!==commId);
  saveState();
  showToast('Deleted');
  window._leadTab = 'comms';
  show('pipeline', oppId);
};

// ── T6: Quick Action button orchestrator — loading + success states ──────────
window.qaAction = function(type, oppId, btn) {
  const o = (window.state && window.state.opportunities || []).find(x => x.id === oppId);
  if (!btn || !o) return;

  // Set loading state
  btn.classList.add('loading');
  btn.disabled = true;

  const done = (ok, msg) => {
    btn.classList.remove('loading');
    btn.disabled = false;
    if (ok) {
      btn.classList.add('success');
      showToast(msg || 'Done');
      setTimeout(() => btn.classList.remove('success'), 2800);
    } else {
      showToast(msg || 'Action failed — check Integrations setup');
    }
  };

  if (type === 'homeworks') {
    // Call existing integration function; wrap with done()
    try {
      if (typeof intPushOppToHomeworks === 'function') {
        intPushOppToHomeworks(oppId);
        setTimeout(() => done(true, 'Pushed to Homeworks CRM'), 600);
      } else {
        done(false, 'Homeworks not connected — visit Integrations to set up');
      }
    } catch(e) { done(false); }

  } else if (type === 'calendar') {
    try {
      if (typeof intScheduleForLead === 'function') {
        intScheduleForLead(o.client || 'Lead', o.email || '', o.nextFollowUp || '');
        setTimeout(() => done(true, 'Calendar event created'), 600);
      } else {
        done(false, 'Google Calendar not connected — visit Integrations');
      }
    } catch(e) { done(false); }

  } else if (type === 'gmail') {
    try {
      if (typeof intComposeToLead === 'function') {
        intComposeToLead(o.email || '', o.client || '');
        setTimeout(() => done(true, 'Gmail compose opened'), 600);
      } else {
        done(false, 'Gmail not connected — visit Integrations');
      }
    } catch(e) { done(false); }
  }
};

function selectWithId(id,options,selected){ return `<select id="${id}">${options.map(o=>`<option ${o===selected?'selected':''}>${escapeHtml(o)}</option>`).join('')}</select>`; }
function inputEdit(name,label,value='',type='text'){ return `<label><span>${label}</span><input name="${name}" type="${type}" value="${escapeHtml(value||'')}"></label>`; }
function selectEdit(name,label,options,value=''){ return `<label><span>${label}</span><select name="${name}"><option value="">Select...</option>${options.map(o=>`<option ${o===value?'selected':''}>${escapeHtml(o)}</option>`).join('')}</select></label>`; }
function saveOpportunity(id){
  const o = state.opportunities.find(x=>x.id===id); if(!o) return;
  const fd = new FormData(document.getElementById('oppForm'));

  // COMM-14: Track commission-driving fields before save to detect material changes
  const commFields = ['workType','leadSource','jobValue','repId','collected'];
  const before = {};
  commFields.forEach(f => before[f] = o[f]);

  Object.assign(o, Object.fromEntries(fd.entries()), {updatedAt:new Date().toISOString()});

  // COMM-14: If this is a sold opp and any commission-driving field changed,
  // flag for reapproval so Tyler must re-review the commission amount.
  // Respects COMM-17 feature flag — autoReapprovalEnabled (default: true).
  const _commFlags = window.getCommissionFlags ? window.getCommissionFlags() : { autoReapprovalEnabled: true };
  if (o.status === 'Sold / Activation' && _commFlags.autoReapprovalEnabled) {
    const changed = commFields.some(f => String(before[f]||'') !== String(o[f]||''));
    if (changed) {
      const lcStatus = window.getCommissionStatus ? window.getCommissionStatus(o) : null;
      // Only flag if it was previously approved/paid — don't downgrade pending items
      if (lcStatus === 'approved' || lcStatus === 'paid') {
        if (o.commissionLifecycle) {
          o.commissionLifecycle.status = 'pending_reapproval';
          o.commissionLifecycle.history = [{
            ts:    new Date().toISOString(),
            actor: window.getCurrentRep ? (window.getCurrentRep()?.id || 'system') : 'system',
            from:  lcStatus,
            to:    'pending_reapproval',
            note:  `Commission-driving field changed (${commFields.filter(f => String(before[f]||'') !== String(o[f]||'')).join(', ')}) — reapproval required`
          }, ...(o.commissionLifecycle.history || [])].slice(0, 20);
        }
        // Sync legacy boolean
        o.commissionApproved = false;
        showToast('Commission flagged for re-approval — key deal fields changed', 'warning');
      }
    }
  }

  saveState(); showToast('Opportunity saved'); show('pipeline', id);
}
function setOppField(id,field,value){
  const o = state.opportunities.find(x=>x.id===id);
  if(!o) return;
  o[field]=value;
  o.updatedAt=new Date().toISOString();
  saveState();
  // Write-through to D1
  _d1SaveOpp(o);
  showToast('Updated');
  show('pipeline', id);
}
function duplicateOpportunity(id){
  const o = state.opportunities.find(x=>x.id===id);
  if(!o) return;
  const copy={...o,id:uid('opp'),client:`${o.client||'Lead'} Copy`,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  state.opportunities.unshift(copy);
  saveState();
  _d1SaveOpp(copy);
  showToast('Duplicated');
  show('pipeline',copy.id);
}
function deleteOpportunity(id){
  if(!confirm('Delete this opportunity?')) return;
  state.opportunities = state.opportunities.filter(o=>o.id!==id);
  state.notes = state.notes.filter(n=>n.oppId!==id);
  saveState();
  _d1DeleteOpp(id);
  showToast('Deleted');
  show('pipeline');
}
window.toggleLeadOverflow = function(btn){
  // Close all open overflow menus first
  document.querySelectorAll('.ld-overflow-menu').forEach(m=>{ if(m!=(btn&&btn.nextElementSibling)) m.style.display='none'; });
  if(!btn) return;
  const menu = btn.nextElementSibling;
  if(menu) menu.style.display = menu.style.display==='none' ? 'block' : 'none';
  // Click-outside to close
  if(menu && menu.style.display==='block'){
    const close = (e)=>{ if(!menu.contains(e.target)&&e.target!==btn){ menu.style.display='none'; document.removeEventListener('click',close,true); } };
    setTimeout(()=>document.addEventListener('click',close,true),0);
  }
};
function addNote(oppId){
  const el = document.getElementById('newNote');
  if(!el || !el.value.trim()) return;
  const noteBody = el.value.trim();
  const repId = window.getCurrentRep ? window.getCurrentRep()?.id : null;
  const note = {id:uid('note'),oppId,body:noteBody,createdAt:new Date().toISOString()};
  state.notes.unshift(note);
  const o=state.opportunities.find(x=>x.id===oppId);
  if(o) o.updatedAt=new Date().toISOString();
  saveState();
  // Write-through to D1 via write engine (logged, retried on failure)
  _d1SaveNote(oppId, noteBody, repId, note.id);
  showToast('Note added');
  show('pipeline', oppId);
}

// ── Qualification Notes view/edit helpers ─────────────────────────────────────
function ldQualEdit(field, oppId){
  document.getElementById('qfview-'+field+'-'+oppId).style.display = 'none';
  const editEl = document.getElementById('qfedit-'+field+'-'+oppId);
  editEl.style.display = 'block';
  const ta = document.getElementById('qfta-'+field+'-'+oppId);
  if(ta){ ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}
function ldQualCancel(field, oppId){
  document.getElementById('qfedit-'+field+'-'+oppId).style.display = 'none';
  document.getElementById('qfview-'+field+'-'+oppId).style.display = 'block';
  // restore textarea to saved value
  const o = state.opportunities.find(x=>x.id===oppId);
  const ta = document.getElementById('qfta-'+field+'-'+oppId);
  if(ta && o) ta.value = o[field]||'';
}
function ldQualSave(field, oppId){
  const ta = document.getElementById('qfta-'+field+'-'+oppId);
  if(!ta) return;
  const val = ta.value.trim();
  const o = state.opportunities.find(x=>x.id===oppId);
  if(o){ o[field]=val; o.updatedAt=new Date().toISOString(); saveState(); _d1SaveOpp(o); }
  // update view content without full re-render
  const contentEl = document.getElementById('qfcontent-'+field+'-'+oppId);
  const placeholders = {
    prompt:'e.g. Referred by a neighbour, saw an ad, urgent project deadline…',
    desiredOutcome:'e.g. Full kitchen renovation complete before the holidays, budget under $30k…',
    fitConcerns:'e.g. Budget may be tight, decision-maker not confirmed, competing quotes…'
  };
  if(contentEl) contentEl.innerHTML = val ? escapeHtml(val) : `<span class="ld-qual-empty">${placeholders[field]||''}</span>`;
  document.getElementById('qfedit-'+field+'-'+oppId).style.display = 'none';
  document.getElementById('qfview-'+field+'-'+oppId).style.display = 'block';
  showToast('Qualification note saved');
}
// ── D1 lazy note loader — called after lead detail renders ────────────────────
// Fetches notes from D1 for oppId, merges into state.notes, refreshes #noteList
async function _d1LoadNotes(oppId) {
  if (!window.DB || !window._d1Ready) return;
  try {
    const d1Notes = await window.DB.notes.list(oppId);
    if (!d1Notes || !d1Notes.length) return;
    // Merge into state.notes: D1 wins on id conflicts
    const d1Ids = new Set(d1Notes.map(n => n.id));
    state.notes = [
      ...d1Notes.map(n => ({
        id: n.id, oppId: n.opp_id || oppId,
        body: n.body || n.text || '',
        repId: n.rep_id || null,
        createdAt: n.created_at || new Date().toISOString()
      })),
      ...(state.notes || []).filter(n => n.oppId !== oppId || !d1Ids.has(n.id))
    ];
    // Refresh the note list DOM if it's still visible for this opp
    const el = document.getElementById('noteList');
    if (el) el.innerHTML = renderNotes(oppId);
  } catch(e) {
    console.warn('[D1] notes load failed for', oppId, e.message);
  }
}
window._d1LoadNotes = _d1LoadNotes;

function renderNotes(oppId) {
  const opp   = state.opportunities.find(x => x.id === oppId);
  const notes = state.notes.filter(n => n.oppId === oppId);
  const fmt   = dt => { try { return new Date(dt).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); } catch(e) { return dt || ''; } };

  // Build a unified timeline: creation + status changes (from opp.history if present) + notes
  const events = [];

  // Lead created event
  if (opp && opp.createdAt) {
    events.push({
      type: 'created', ts: opp.createdAt,
      title: 'Lead created',
      detail: `${escapeHtml(opp.client || 'Unnamed lead')} · ${escapeHtml(opp.status || 'New')}`
    });
  }

  // Stage history (stored in opp.history array if available)
  if (opp && Array.isArray(opp.history)) {
    opp.history.forEach(h => {
      events.push({ type:'stage', ts:h.ts, title:`Stage → ${escapeHtml(h.to||'')}`, detail:h.note||'' });
    });
  }

  // Sold event
  if (opp && opp.soldAt) {
    events.push({
      type:'sold', ts:opp.soldAt,
      title:'Marked Sold',
      detail: opp.soldAmount ? `$${Number(opp.soldAmount).toLocaleString()}${opp.division ? ' · '+opp.division : ''}` : ''
    });
  }

  // Notes
  notes.forEach(n => events.push({
    type:'note', ts:n.createdAt,
    title:'Note added',
    detail: escapeHtml(n.body || '')
  }));

  // Sort newest → oldest
  events.sort((a,b) => new Date(b.ts) - new Date(a.ts));

  if (!events.length) return empty('No activity yet for this lead.');

  const dotClass = { note:'note', stage:'stage', sold:'sold', created:'created', admin:'admin' };
  const dotIcon  = { note:'<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 2.5A.5.5 0 012.5 2h9a.5.5 0 01.5.5v6a.5.5 0 01-.5.5H8L5.5 12V9H2.5A.5.5 0 012 8.5v-6z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>', stage:'<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 3l4 4-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>', sold:'<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 7l2 2 3-3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>', created:'<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v2M7 11v2M1 7h2M11 7h2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M3 3l1.4 1.4M9.6 9.6L11 11M11 3l-1.4 1.4M4.4 9.6L3 11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".6"/></svg>', admin:'<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="5" cy="6" r="2.5" stroke="currentColor" stroke-width="1.3"/><path d="M7 7.5l5 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M10.5 9.5v1.5M9 10.5h2.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>' };

  const items = events.map(e => `
    <li class="timeline-item">
      <div class="timeline-dot ${dotClass[e.type]||''}">
        <span>${dotIcon[e.type]||'•'}</span>
      </div>
      <div class="timeline-body">
        <time>${fmt(e.ts)}</time>
        <div class="tl-title">${e.title}</div>
        ${e.detail ? `<div class="tl-detail">${e.detail}</div>` : ''}
      </div>
    </li>`).join('');

  return `<ul class="timeline">${items}</ul>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Sales Toolkit — Sales Process, Forms, Scripts, Templates, Objections,
//                 Pricing Tools, AI Sales Assistant
// ═══════════════════════════════════════════════════════════════════════════

// ─── Shared helpers ───────────────────────────────────────────────────────────
function escapeForJs(str){ return String(str).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/\n/g,'\\n'); }
function money(n){ return n.toLocaleString(undefined,{style:'currency',currency:'USD',maximumFractionDigits:0}); }

function renderChecklist(c, persist=false, scopeId=''){
  const prefix = scopeId ? `check-${c.id}-${scopeId}` : `check-${c.id}`;
  const total = c.items.length;
  const done  = persist ? c.items.filter((_,i)=>localStorage.getItem(`${prefix}-${i}`)==='1').length : 0;
  const pct   = total ? Math.round((done/total)*100) : 0;
  const barColor = pct===100?'#2D7A55':pct>=50?'#8B6914':'#4D8A86';
  const chipBg   = pct===100?'#EAF1EE':pct>=50?'#FAF6E8':'#E5F0EF';
  const chipTxt  = pct===100?'#1A4740':pct>=50?'#7A5C10':'#1A4740';

  const progressBlock = persist ? `
    <div class="ld-cl-progress">
      <div class="ld-cl-bar-wrap">
        <div class="ld-cl-bar-track">
          <div id="cpbar-${prefix}" class="ld-cl-bar-fill" style="width:${pct}%;background:${barColor}"></div>
        </div>
        <span id="cplabel-${prefix}" class="ld-cl-count" style="color:${barColor}">${done}/${total}</span>
      </div>
      <span class="ld-cl-chip" style="background:${chipBg};color:${chipTxt}">${pct===100?'Complete':pct+'% done'}</span>
    </div>` : '';

  const items = c.items.map((item,i)=>{
    const key = `${prefix}-${i}`;
    const checked = persist ? (localStorage.getItem(key) === '1') : false;
    return `<label class="check-item${checked?' check-item--done':''}">
      <input type="checkbox" ${persist?`data-key="${key}"`:''}${checked?' checked':''}><span>${escapeHtml(item)}</span>
    </label>`;
  });

  return `${progressBlock}<div class="checklist" id="clist-${prefix}">${items.join('')}</div>`;
}

function wireChecks(){
  document.querySelectorAll('.check-item input[data-key]').forEach(cb=>{
    const key = cb.dataset.key;
    cb.checked = localStorage.getItem(key) === '1';
    const rowEl = cb.closest('.check-item');
    if(rowEl) rowEl.classList.toggle('check-item--done', cb.checked);

    cb.addEventListener('change', ()=>{
      localStorage.setItem(key, cb.checked ? '1' : '0');
      if(rowEl) rowEl.classList.toggle('check-item--done', cb.checked);
      // Write-through to D1 checklist via write engine (logged, retried)
      if (cb.dataset.oppId && cb.dataset.checklistId) {
        const oppId = cb.dataset.oppId, clId = cb.dataset.checklistId;
        const idx = parseInt(cb.dataset.itemIndex || '0'), checked = cb.checked;
        _d1Write('save-checklist', `${oppId}:${clId}:${idx}`,
          () => window.DB.checklist.set(oppId, clId, idx, checked));
      }
      // Live-update progress bar
      const prefixMatch = key.match(/^(.+)-\d+$/);
      if (!prefixMatch) return;
      const prefix = prefixMatch[1];
      const allBoxes = document.querySelectorAll(`input[data-key^="${prefix}-"]`);
      if (!allBoxes.length) return;
      const total = allBoxes.length;
      const done  = [...allBoxes].filter(x=>x.checked).length;
      const pct   = Math.round((done/total)*100);
      const color = pct===100?'#2D7A55':pct>=50?'#8B6914':'#4D8A86';
      const chipBg  = pct===100?'#EAF1EE':pct>=50?'#FAF6E8':'#E5F0EF';
      const chipTxt = pct===100?'#1A4740':pct>=50?'#7A5C10':'#1A4740';
      const barEl   = document.getElementById('cpbar-'+prefix);
      const lblEl   = document.getElementById('cplabel-'+prefix);
      const progress = barEl ? barEl.closest('.ld-cl-progress') : null;
      const chipEl  = progress ? progress.querySelector('.ld-cl-chip') : null;
      if (barEl){ barEl.style.width = pct+'%'; barEl.style.background = color; }
      if (lblEl){ lblEl.textContent = done+'/'+total; lblEl.style.color = color; }
      if (chipEl){ chipEl.textContent = pct===100?'Complete':pct+'% done'; chipEl.style.background=chipBg; chipEl.style.color=chipTxt; }
    });
  });
}

// ── Lead Picker Modal (shared by Scripts, Templates, Objections, Pricing) ──
function openLeadPicker(onSelect){
  const open = state.opportunities.filter(o => !['Sold / Activation','Closed Lost'].includes(o.status));
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding-top:80px';
  modal.innerHTML = `
    <div class="gw-modal-card" style="max-width:480px;margin:0 16px;border-color:var(--gw-sky)">
      <h3 style="margin:0 0 14px;color:#EDEAE0;font-size:1.1rem">Select a Lead</h3>
      <input id="lpSearch" type="text" placeholder="Search by client or project..."
        class="gw-input-sm" style="width:100%;margin-bottom:12px;box-sizing:border-box;font-size:14px;outline:none">
      <div id="lpList" style="max-height:320px;overflow-y:auto;display:flex;flex-direction:column;gap:6px"></div>
      <button class="secondary-btn mt8" style="margin-top:14px;width:100%" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
    </div>`;
  document.body.appendChild(modal);
  const listEl = modal.querySelector('#lpList');
  const searchEl = modal.querySelector('#lpSearch');
  function renderList(filter){
    filter = filter || '';
    const filtered = open.filter(function(o){
      return !filter ||
        (o.client||'').toLowerCase().includes(filter.toLowerCase()) ||
        (o.project||'').toLowerCase().includes(filter.toLowerCase());
    });
    listEl.innerHTML = filtered.slice(0,20).map(function(o){
      return '<button class="mini-row" style="text-align:left;width:100%">' +
        '<strong>' + escapeHtml(o.client||'Unnamed') + '</strong>' +
        '<span class="status-chip ' + statusCssClass(o.status||'') + '" style="font-size:10px;padding:1px 6px">' + escapeHtml(o.status||'') + '</span>' +
        '<em>' + escapeHtml(o.project||'') + '</em>' +
        '</button>';
    }).join('') || '<p class="muted" style="padding:12px">No matching leads.</p>';
    listEl.querySelectorAll('.mini-row').forEach(function(btn, idx){
      btn.addEventListener('click', function(){
        const opp = filtered[idx];
        modal.remove();
        if(opp) onSelect(opp.id);
      });
    });
  }
  renderList();
  searchEl.addEventListener('input', function(e){ renderList(e.target.value); });
  searchEl.focus();
}
window.openLeadPicker = openLeadPicker;

// ── Merge template fields from a live lead ──
function mergeTemplate(body, opp){
  const rep = (window.REPS||[]).find(function(r){ return r.id===opp.repId; }) || { name: 'Your Name' };
  const followDate = opp.nextFollowUp ? prettyDate(opp.nextFollowUp) : 'a time that works for you';
  return body
    .replace(/\[Name\]/gi, opp.client||'[Name]')
    .replace(/\[First Name\]/gi, (opp.client||'').split(' ')[0]||'[Name]')
    .replace(/\[Your Name\]/gi, rep.name)
    .replace(/\[service lines?\]/gi, opp.serviceLine||opp.projectCategory||'landscaping services')
    .replace(/\[project\]/gi, opp.project||'your project')
    .replace(/\[date\]/gi, followDate)
    .replace(/\[address\]/gi, opp.address||'[address]')
    .replace(/\[job value\]/gi, opp.jobValue ? money(Number(opp.jobValue)) : '[amount]');
}
window.mergeTemplate = mergeTemplate;

// ─── Sales Process ────────────────────────────────────────────────────────────
function process(stageId){
  const sp = data.salesProcess;
  if(stageId){ const s = data.stages.find(x=>x.id===Number(stageId)); if(s) return renderStage(s); }
  const stepColors = ['#1A4740','#2D7A55','#8B6914','#8B3A2A','#B8744F','#B8744F'];
  view.innerHTML = `
<div class="eyebrow">Operating System</div>
<h1 style="color:var(--ink)">Avalon Sales Process</h1>
<p class="lede">${escapeHtml(sp.subtitle)}</p>

<div style="display:flex;align-items:center;gap:10px;margin:24px 0 8px">
  <h2 style="margin:0;font-size:.85rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)">6-Step Avalon Method</h2>
  <div style="flex:1;height:1px;background:var(--line)"></div>
  <span style="font-size:.75rem;color:var(--muted)">Click any step to explore</span>
</div>

<div class="grid grid-3" style="gap:12px">
  ${sp.steps.map((s,i)=>`
  <article class="card" style="border-top:3px solid ${stepColors[i]};padding:18px;cursor:pointer;transition:transform .15s,box-shadow .15s"
    onclick="processShowStep(${i})"
    onmouseenter="this.style.transform='translateY(-2px)';this.style.boxShadow='0 8px 24px rgba(0,0,0,.08)'"
    onmouseleave="this.style.transform='';this.style.boxShadow=''">
    <div style="font-size:2rem;font-weight:900;color:${stepColors[i]};line-height:1;margin-bottom:6px">Step ${s.num}</div>
    <h3 style="margin:0 0 4px;color:var(--ink)">${escapeHtml(s.title)}</h3>
    <p style="font-size:.8rem;color:var(--muted);margin:0 0 10px">${escapeHtml(s.tagline)}</p>
    <p style="font-size:.85rem;margin:0;color:var(--ink)">${escapeHtml((s.description||'').slice(0,110))}…</p>
    <div style="margin-top:10px;font-size:.75rem;font-weight:600;color:${stepColors[i]}">Explore Step ${s.num} →</div>
  </article>`).join('')}
</div>

<!-- Step detail panel (hidden until clicked) -->
<div id="stepDetailPanel" style="display:none;margin-top:20px"></div>

<div style="display:flex;align-items:center;gap:10px;margin:28px 0 8px">
  <h2 style="margin:0;font-size:.85rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)">12-Stage Operating Procedures</h2>
  <div style="flex:1;height:1px;background:var(--line)"></div>
</div>
<p style="font-size:.88rem;color:var(--muted);margin:0 0 16px">Each stage has a purpose, owner, required artifact, stage gate, questions, and red flags. Tap any stage to open the full procedure.</p>

<div class="grid grid-3" style="gap:12px">
${data.stages.map(s=>{
  const stageOpps = (state.opportunities||[]).filter(o=>o.status===s.title&&!['Sold / Activation','Closed Lost'].includes(o.status));
  const cnt = stageOpps.length;
  return `<article class="card clickable" onclick="show('process',${s.id})" style="transition:transform .15s,box-shadow .15s"
    onmouseenter="this.style.transform='translateY(-2px)';this.style.boxShadow='0 8px 24px rgba(0,0,0,.08)'"
    onmouseleave="this.style.transform='';this.style.boxShadow=''">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;justify-content:space-between">
      <div style="display:flex;align-items:center;gap:8px">
        <div class="stage-number">${s.id}</div>
        ${s.processStep ? `<span class="badge" style="font-size:.68rem">${escapeHtml(s.processStep)}</span>` : ''}
      </div>
      ${cnt > 0 ? `<span class="live-count-badge">${cnt}</span>` : '<span class="live-count-badge empty">0</span>'}
    </div>
    <h3 style="color:var(--ink)">${escapeHtml(s.title)}</h3>
    <p style="font-size:.85rem;color:var(--muted)">${escapeHtml(s.purpose)}</p>
    <p style="font-size:.78rem;color:var(--muted);margin:0"><strong style="color:var(--ink)">Owner:</strong> ${escapeHtml(s.owner)}</p>
  </article>`;
}).join('')}
</div>`;

  const stepColors2 = ['#1A4740','#2D7A55','#8B6914','#8B3A2A','#B8744F','#B8744F'];
  window.processShowStep = function(idx){
    const s = sp.steps[idx];
    const panel = document.getElementById('stepDetailPanel');
    if (!s || !panel) return;
    if (panel._idx === idx && panel.style.display !== 'none') {
      panel.style.display = 'none'; panel._idx = null; return;
    }
    panel._idx = idx;
    const color = stepColors2[idx];
    const tappoHtml = s.tappo?.length ? `
      <div style="margin-top:16px">
        <div style="font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:${color};margin-bottom:8px">T.A.P.P.O. Components</div>
        ${s.tappo.map(t=>`<div style="padding:10px 12px;background:${color}0d;border-left:3px solid ${color};border-radius:0 8px 8px 0;margin-bottom:6px">
          <strong style="color:${color}">${escapeHtml(t.letter||'')} — ${escapeHtml(t.title||t.name||'')}</strong>
          ${t.description ? `<p style="font-size:.83rem;margin:4px 0 0;color:var(--muted)">${escapeHtml(t.description)}</p>` : ''}
        </div>`).join('')}
      </div>` : '';
    const nlpHtml = s.nlpTips?.length ? `
      <div style="margin-top:16px">
        <div style="font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:${color};margin-bottom:8px">Language &amp; NLP Tips</div>
        ${s.nlpTips.map(t=>`<div style="font-size:.84rem;padding:6px 10px;background:${color}08;border-radius:6px;margin-bottom:4px;color:var(--ink)">→ ${escapeHtml(t)}</div>`).join('')}
      </div>` : '';
    const qHtml = s.cbrQuestions?.length ? `
      <div style="margin-top:16px">
        <div style="font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:${color};margin-bottom:8px">Discovery Questions</div>
        ${s.cbrQuestions.map(q=>`<div style="font-size:.84rem;padding:6px 10px;background:${color}08;border-radius:6px;margin-bottom:4px;color:var(--ink)">"${escapeHtml(q)}"</div>`).join('')}
      </div>` : '';
    panel.innerHTML = `
      <div class="card" style="border-top:3px solid ${color};animation:fadeInUp .2s ease">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <div>
            <div style="font-size:2rem;font-weight:900;color:${color};line-height:1">Step ${s.num}</div>
            <h2 style="margin:4px 0 2px;color:var(--ink)">${escapeHtml(s.title)}</h2>
            <p style="font-size:.84rem;color:var(--muted);margin:0">${escapeHtml(s.tagline)}</p>
          </div>
          <button onclick="document.getElementById('stepDetailPanel').style.display='none'" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:1.2rem;padding:4px 8px" title="Close">✕</button>
        </div>
        <p style="font-size:.9rem;color:var(--ink);line-height:1.6">${escapeHtml(s.description||'')}</p>
        ${tappoHtml}${nlpHtml}${qHtml}
        <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="primary-btn" onclick="show('process',${idx+1})" style="font-size:.82rem">Go to Stage ${idx+1} →</button>
          <button class="secondary-btn" onclick="show('scripts')" style="font-size:.82rem">Scripts for this step</button>
          <button class="secondary-btn" onclick="show('ai')" style="font-size:.82rem">' + gwIcon('ai-spark',14,'currentColor') + ' AI Coach</button>
        </div>
      </div>`;
    panel.style.display = 'block';
    panel.scrollIntoView({behavior:'smooth', block:'nearest'});
  };
}

function renderStage(s){
  const stageChecklist = (window.AVALON_DATA.checklists||[]).find(c=>c.stage===s.id);
  view.innerHTML = `
<button class="secondary-btn" onclick="show('process')">← Back to all stages</button>
<div style="display:flex;align-items:center;gap:12px;margin:16px 0 4px">
  <div class="stage-number" style="font-size:1.1rem;width:36px;height:36px">${s.id}</div>
  <div>
    <h1 style="margin:0;color:var(--ink)">${escapeHtml(s.title)}</h1>
    ${s.processStep ? `<div class="eyebrow" style="margin:2px 0 0">${escapeHtml(s.processStep)}</div>` : ''}
  </div>
</div>
<p class="lede">${escapeHtml(s.purpose)}</p>
<div class="grid grid-2 mt">
  <div class="card"><h3>Owner</h3><p style="color:var(--ink)">${escapeHtml(s.owner)}</p></div>
  <div class="card"><h3>Gate to Next Stage</h3><p style="color:var(--ink)">${escapeHtml(s.gate)}</p></div>
</div>
<div class="grid grid-2 mt">
  <div class="card"><h3>Required Actions</h3>${list(s.actions)}${s.approvalMatrix?`<h4 style="margin-top:12px">Approval Authority</h4><table style="width:100%;font-size:.83rem;border-collapse:collapse">${s.approvalMatrix.map(a=>`<tr style="border-bottom:1px solid var(--border)"><td style="padding:4px 8px 4px 0;color:var(--muted)">${escapeHtml(a.range)}</td><td style="padding:4px 0;color:var(--ink)">${escapeHtml(a.approval)}</td></tr>`).join('')}</table>`:''}</div>
  <div class="card">
    <h3>Required Artifact</h3><p style="color:var(--ink)">${escapeHtml(s.artifact)}</p>
    ${s.questions?.length?`<h3 style="margin-top:12px">Questions to Use</h3>${list(s.questions)}`:''}
    ${s.followUpCadence?`<h3 style="margin-top:12px">Follow-Up Cadence</h3>${s.followUpCadence.map(f=>`<div style="display:flex;gap:8px;margin:4px 0;font-size:.83rem"><strong style="color:var(--blue);min-width:50px">${escapeHtml(f.day)}</strong><span style="color:var(--ink)">${escapeHtml(f.action)}</span></div>`).join('')}`:''}
    ${s.objectionFramework?`<h3 style="margin-top:12px">Objection Framework</h3>${list(s.objectionFramework)}`:''}
    ${s.proposalStructure?`<h3 style="margin-top:12px">Proposal Structure</h3>${list(s.proposalStructure)}`:''}
  </div>
</div>
<div class="card danger mt"><h3>Red Flags — Do Not Advance Until Resolved</h3>${list(s.redFlags)}</div>
${stageChecklist?`<div class="card mt"><h3>${escapeHtml(stageChecklist.title)}</h3><p style="font-size:.8rem;color:var(--muted);margin-bottom:12px">Check off items as you work through this stage. Progress saves automatically.</p>${renderChecklist(stageChecklist, true)}</div>`:''}
${(()=>{
  const atStage=(state.opportunities||[]).filter(o=>o.status===s.title&&!['Sold / Activation','Closed Lost'].includes(o.status));
  if(!atStage.length) return '';
  return `<div class="card mt" style="border-left:3px solid var(--blue)"><h3 style="color:var(--blue);margin-bottom:10px">${atStage.length} Lead${atStage.length>1?'s':''} at This Stage</h3>
    <div style="display:flex;flex-direction:column;gap:6px">${atStage.slice(0,5).map(o=>`<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--surface);border:1px solid var(--line);border-radius:8px;cursor:pointer;transition:background .15s" onclick="show('pipeline','${o.id}')" onmouseenter="this.style.background='var(--line)'" onmouseleave="this.style.background='var(--surface)'">
      <div><div style="font-weight:600;color:var(--ink)">${escapeHtml(o.client||'—')}</div><div style="font-size:.75rem;color:var(--muted)">${o.jobValue?money(Number(o.jobValue)):''} ${o.nextFollowUp?'· Follow-up: '+prettyDate(o.nextFollowUp):''}</div></div>
      <span style="font-size:.8rem;color:var(--blue)">→</span>
    </div>`).join('')}
    ${atStage.length>5?`<div style="font-size:.78rem;color:var(--muted);text-align:center">+${atStage.length-5} more · <span onclick="show('pipeline')" style="color:var(--blue);cursor:pointer">View all →</span></div>`:''}
    </div></div>`;
})()}
<div class="footer-actions mt">
  ${s.id>1?`<button class="secondary-btn" onclick="show('process',${s.id-1})">← Previous Stage</button>`:''}
  ${s.id<12?`<button class="primary-btn" onclick="show('process',${s.id+1})">Next Stage →</button>`:''}
</div>`;
  wireChecks();
}

// ─── Forms & Checklists ───────────────────────────────────────────────────────
function forms(formId){
  if(formId){ const f=data.forms.find(x=>x.id===formId); if(f) return renderFormTool(f); const c=data.checklists.find(x=>x.id===formId); if(c) return renderChecklistPage(c); }
  const stageChecklists = (data.checklists||[]).filter(c=>c.stage>0);
  const utilChecklists  = (data.checklists||[]).filter(c=>c.stage===0);

  function formProgress(f){
    const sc = (data.checklists||[]).find(c=>c.stage===f.stage);
    if(!sc) return null;
    const prefix = `check-${sc.id}`;
    const done = sc.items.filter((_,i)=>localStorage.getItem(`${prefix}-${i}`)==='1').length;
    return { done, total: sc.items.length, pct: sc.items.length ? Math.round((done/sc.items.length)*100) : 0 };
  }
  function checklistProgress(c){
    const prefix = `check-${c.id}`;
    const done = c.items.filter((_,i)=>localStorage.getItem(`${prefix}-${i}`)==='1').length;
    return { done, total: c.items.length, pct: c.items.length ? Math.round((done/c.items.length)*100) : 0 };
  }

  view.innerHTML = `
<div class="eyebrow">Field Tools</div>
<h1 style="color:var(--ink)">Forms &amp; Checklists</h1>
<p class="lede">Your reusable day-to-day tools. Open before calls, site visits, proposal reviews, follow-up, sold-job activation, and closeout. Checkboxes save your progress automatically.</p>

<div style="display:flex;align-items:center;gap:10px;margin:24px 0 8px">
  <h2 style="margin:0;font-size:.85rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)">Daily Field Tools</h2>
  <div style="flex:1;height:1px;background:var(--line)"></div>
</div>
<div class="grid grid-3" style="gap:12px">
${data.forms.map(f=>{
  const prog = formProgress(f);
  const stageNum = f.stage ? ` · Stage ${f.stage}` : '';
  const barColor = prog ? (prog.pct===100?'#2D7A55':prog.pct>=50?'#8B6914':'#4D8A86') : '#4D8A86';
  return `<article class="card clickable" onclick="show('forms','${f.id}')" style="transition:transform .15s,box-shadow .15s"
    onmouseenter="this.style.transform='translateY(-2px)';this.style.boxShadow='0 8px 24px rgba(0,0,0,.08)'"
    onmouseleave="this.style.transform='';this.style.boxShadow=''">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:8px">
      <div>
        <span class="badge" style="font-size:.68rem;margin-bottom:6px;display:inline-block">Tool${stageNum}</span>
        <h3 style="margin:0;color:var(--ink)">${escapeHtml(f.title)}</h3>
      </div>
      ${prog ? `<div style="text-align:center;flex-shrink:0;min-width:42px">
        <div style="font-size:1.1rem;font-weight:700;color:${barColor}">${prog.pct}%</div>
        <div style="font-size:.6rem;color:var(--muted)">done</div>
      </div>` : ''}
    </div>
    <p style="font-size:.82rem;color:var(--muted);margin:0 0 10px">${f.fields.slice(0,3).map(x=>x.label).join(', ')}…</p>
    ${prog ? `<div style="height:5px;background:var(--line);border-radius:4px;overflow:hidden">
      <div style="height:100%;width:${prog.pct}%;background:${barColor};border-radius:4px;transition:width .4s"></div>
    </div>
    <div style="font-size:.7rem;color:var(--muted);margin-top:4px">${prog.done}/${prog.total} checklist items</div>` : ''}
  </article>`;
}).join('')}
</div>

<div style="display:flex;align-items:center;gap:10px;margin:28px 0 8px">
  <h2 style="margin:0;font-size:.85rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)">Stage Checklists</h2>
  <div style="flex:1;height:1px;background:var(--line)"></div>
  <span style="font-size:.72rem;color:var(--muted)">Progress saves per checklist</span>
</div>
<div class="grid grid-2" style="gap:12px">
${stageChecklists.map(c=>{
  const p = checklistProgress(c);
  const barColor = p.pct===100?'#2D7A55':p.pct>=50?'#8B6914':'#4D8A86';
  return `<article class="card clickable" onclick="show('forms','${c.id}')" style="border-left:3px solid ${barColor};transition:transform .15s,box-shadow .15s"
    onmouseenter="this.style.transform='translateY(-2px)';this.style.boxShadow='0 8px 24px rgba(0,0,0,.08)'"
    onmouseleave="this.style.transform='';this.style.boxShadow=''">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
      <h3 style="margin:0;color:var(--ink)">${escapeHtml(c.title)}</h3>
      <span style="font-size:1rem;font-weight:700;color:${barColor}">${p.pct}%</span>
    </div>
    <p style="font-size:.75rem;color:var(--muted);margin:0 0 8px">Stage ${c.stage}</p>
    <div style="height:5px;background:var(--line);border-radius:4px;overflow:hidden;margin-bottom:6px">
      <div style="height:100%;width:${p.pct}%;background:${barColor};border-radius:4px;transition:width .4s"></div>
    </div>
    <div style="font-size:.72rem;color:var(--muted)">${p.done}/${p.total} complete · click to open</div>
  </article>`;
}).join('')}
</div>

<div style="display:flex;align-items:center;gap:10px;margin:28px 0 8px">
  <h2 style="margin:0;font-size:.85rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)">Daily &amp; Weekly Tools</h2>
  <div style="flex:1;height:1px;background:var(--line)"></div>
</div>
<div class="grid grid-2" style="gap:12px">
${utilChecklists.map(c=>{
  const p = checklistProgress(c);
  const barColor = p.pct===100?'#2D7A55':p.pct>=50?'#8B6914':'#2D7A55';
  return `<article class="card clickable" onclick="show('forms','${c.id}')" style="border-left:3px solid ${barColor};transition:transform .15s,box-shadow .15s"
    onmouseenter="this.style.transform='translateY(-2px)';this.style.boxShadow='0 8px 24px rgba(0,0,0,.08)'"
    onmouseleave="this.style.transform='';this.style.boxShadow=''">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
      <h3 style="margin:0;color:var(--ink)">${escapeHtml(c.title)}</h3>
      <span style="font-size:1rem;font-weight:700;color:${barColor}">${p.pct}%</span>
    </div>
    <div style="height:5px;background:var(--line);border-radius:4px;overflow:hidden;margin-bottom:6px">
      <div style="height:100%;width:${p.pct}%;background:${barColor};border-radius:4px;transition:width .4s"></div>
    </div>
    <div style="font-size:.72rem;color:var(--muted)">${p.done}/${p.total} complete · click to open</div>
  </article>`;
}).join('')}
</div>`;
}

function renderChecklistPage(c){
  view.innerHTML = `
<button class="secondary-btn" onclick="show('forms')">← Back to Forms</button>
<div class="eyebrow" style="margin-top:16px">${c.stage > 0 ? 'Stage '+c.stage+' Checklist' : 'Daily Tool'}</div>
<h1 style="color:var(--ink)">${escapeHtml(c.title)}</h1>
<p class="lede">Check items off as you work through this stage. Progress saves automatically in your browser.</p>
<div class="card" style="max-width:680px">
  ${renderChecklist(c, true)}
  <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
    <button class="secondary-btn" onclick="resetChecklist('${c.id}', ${c.items.length})">Reset Checklist</button>
    <button class="secondary-btn" onclick="show('ai')">' + gwIcon('ai-spark',14,'currentColor') + ' AI Coach</button>
  </div>
</div>`;
  wireChecks();
  window.resetChecklist = function(id, len){
    if(!confirm('Reset this checklist? All checkmarks will be cleared.')) return;
    for(let i=0;i<len;i++) localStorage.removeItem(`check-${id}-${i}`);
    show('forms', id);
    showToast('Checklist reset');
  };
}

function renderFormTool(f){
  const stageChecklist = (data.checklists||[]).find(c=>c.stage===f.stage);
  const fieldLabels = f.fields.map(x=>x.label);
  const _fieldCopyStr = fieldLabels.map(x=>'- '+x+':').join('\n');
  const _noteCopyStr  = fieldLabels.map(x=>x+':').join('\n\n');
  const _noteHtml     = nl2br(fieldLabels.map(x=>x+':').join('\n\n'));
  const _scTitle      = stageChecklist ? escapeHtml(stageChecklist.title) : 'Stage Checklist';
  const _scHtml       = stageChecklist ? renderChecklist(stageChecklist, true) : '<p style="color:var(--muted)">No checklist for this stage.</p>';

  view.innerHTML = `
<button class="secondary-btn" onclick="show('forms')">← Back to Forms</button>
<div class="eyebrow" style="margin-top:16px">Daily Tool · Stage ${f.stage||'—'}</div>
<h1 style="color:var(--ink)">${escapeHtml(f.title)}</h1>

<div class="grid grid-2 mt">
  <section class="card">
    <h2>Fields to Capture</h2>
    ${list(fieldLabels)}
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <button class="secondary-btn" onclick="copyText('${escapeForJs(_fieldCopyStr)}',this)">Copy Field Template</button>
      <button class="secondary-btn" onclick="show('ai')">' + gwIcon('ai-spark',14,'currentColor') + ' AI Draft</button>
    </div>
  </section>
  <section class="card">
    <h2>${_scTitle}</h2>
    <p style="font-size:.8rem;color:var(--muted);margin:0 0 10px">Check items off as you work through this stage. Progress saves automatically.</p>
    ${_scHtml}
    ${stageChecklist ? `<button class="secondary-btn" style="margin-top:10px;font-size:.8rem" onclick="resetChecklist('${stageChecklist.id}', ${stageChecklist.items.length})">Reset Checklist</button>` : ''}
  </section>
</div>

<section class="card mt">
  <h2>Copy-Ready Working Note</h2>
  <p style="font-size:.83rem;color:var(--muted);margin:0 0 10px">Paste this into your CRM, notes app, or use with a lead below.</p>
  <div class="script-box">${_noteHtml}</div>
  <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
    <button class="primary-btn" onclick="copyText('${escapeForJs(_noteCopyStr)}')">Copy Note Template</button>
    <button class="secondary-btn" onclick="openLeadPicker(function(id){show('pipeline',id);setTimeout(()=>{const el=document.getElementById('newNote');if(el){el.value=${JSON.stringify(_noteCopyStr)};el.focus();showToast('Note template loaded into lead');}},400);})">Load into Lead Note</button>
  </div>
</section>`;
  wireChecks();
  window.resetChecklist = function(id, len){
    if(!confirm('Reset this checklist?')) return;
    for(let i=0;i<len;i++) localStorage.removeItem(`check-${id}-${i}`);
    show('forms', f.id);
    showToast('Checklist reset');
  };
}

// ─── Scripts Library ──────────────────────────────────────────────────────────
function scripts(){
  const cats = ['All', ...new Set(data.scripts.map(s=>s.category))];
  const FAV_KEY = 'avalonScriptFavs';
  function loadFavs(){ try{ return JSON.parse(localStorage.getItem(FAV_KEY)||'[]'); }catch(e){ return []; } }
  function saveFavs(arr){ localStorage.setItem(FAV_KEY, JSON.stringify(arr)); }

  view.innerHTML = `
<div class="eyebrow">Talk Tracks</div>
<h1 style="color:var(--ink)">Scripts Library</h1>
<p class="lede">Built-in language for every stage. Keep the intent, adapt the words, sound human. Use with live leads to prep and log your call.</p>

<div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:center">
  <input id="scriptSearch" type="search" placeholder="Search scripts…" style="flex:1;min-width:180px;max-width:280px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;font-size:.88rem;color:var(--ink);background:var(--surface)">
  <div class="tabs" style="margin:0;flex:1">${cats.map((c,i)=>`<button class="tab ${i===0?'active':''}" data-cat="${c}">${escapeHtml(c)}</button>`).join('')}</div>
  <button id="favToggle" class="secondary-btn" style="font-size:.8rem;white-space:nowrap"> Favorites</button>
</div>

<div id="scriptList" class="grid grid-2" style="gap:14px"></div>`;

  const box    = document.getElementById('scriptList');
  const search = document.getElementById('scriptSearch');
  let currentCat = 'All';
  let showFavs = false;

  function render(){
    let list = data.scripts;
    if(showFavs){ const favs = loadFavs(); list = list.filter(s=>favs.includes(s.title)); }
    if(currentCat !== 'All') list = list.filter(s=>s.category===currentCat);
    const q = search.value.toLowerCase().trim();
    if(q) list = list.filter(s=>(s.title+' '+s.body+' '+(s.situation||'')).toLowerCase().includes(q));

    if(!list.length){ box.innerHTML = `<div style="grid-column:1/-1;padding:40px;text-align:center;color:var(--muted)">No scripts match your filter.</div>`; return; }

    box.innerHTML = list.map(s=>{
      const favs = loadFavs();
      const isFav = favs.includes(s.title);
      const verbatim = s.category && s.category.toLowerCase().includes('verbatim');
      return `<article class="card" style="position:relative;border:1px solid var(--line);border-top:3px solid ${verbatim?'#8B6914':'var(--blue)'}">
        <button onclick="toggleScriptFav('${escapeForJs(s.title)}')" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;font-size:1rem;color:${isFav?'#8B6914':'var(--muted)'}" title="${isFav?'Remove from favorites':'Add to favorites'}">${isFav ? gwIcon('star',14,'#8B6914') : gwIcon('star',14,'#C8C3B6')}</button>
        ${verbatim?`<div style="display:inline-block;font-size:.68rem;font-weight:700;background:#8B691422;color:#8B6914;border:1px solid #8B691444;border-radius:4px;padding:2px 7px;margin-bottom:6px">VERBATIM — Do Not Deviate</div>`:''}
        <span class="badge" style="display:block;margin-bottom:6px">${escapeHtml(s.category)}</span>
        <h3 style="color:var(--ink);margin:0 0 6px;padding-right:28px">${escapeHtml(s.title)}</h3>
        ${s.situation?`<p style="font-size:.8rem;color:#1A4740;font-weight:600;margin:0 0 8px;font-style:italic">When: ${escapeHtml(s.situation)}</p>`:''}
        <div class="script-box" style="font-size:.84rem">${nl2br(s.body)}</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">
          <button class="secondary-btn" style="font-size:.78rem" onclick="copyText('${escapeForJs(s.body)}',this)">Copy Script</button>
          <button class="secondary-btn" style="font-size:.78rem" onclick="scriptUseForLead('${escapeForJs(s.title)}','${escapeForJs(s.body)}')">Link to Lead</button>
          <button class="secondary-btn" style="font-size:.78rem" onclick="scriptToAI('${escapeForJs(s.title)}','${escapeForJs(s.situation||'')}')">' + gwIcon('ai-spark',14,'currentColor') + ' AI Coach</button>
        </div>
      </article>`;
    }).join('');
  }

  render();
  search.addEventListener('input', render);
  view.querySelector('.tabs').addEventListener('click',e=>{
    if(!e.target.matches('.tab')) return;
    view.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    e.target.classList.add('active');
    currentCat = e.target.dataset.cat;
    render();
  });
  document.getElementById('favToggle').addEventListener('click',()=>{
    showFavs = !showFavs;
    document.getElementById('favToggle').style.color = showFavs ? '#8B6914' : '';
    document.getElementById('favToggle').style.borderColor = showFavs ? '#8B6914' : '';
    render();
  });

  window.toggleScriptFav = function(title){
    const favs = loadFavs();
    const idx = favs.indexOf(title);
    if(idx>=0) favs.splice(idx,1); else favs.push(title);
    saveFavs(favs);
    render();
  };
  window.scriptUseForLead = function(title, body){
    openLeadPicker(function(id){
      const opp = state.opportunities.find(x=>x.id===id);
      if(!opp) return;
      const note = { id:'n'+Date.now(), text:'[Script: '+title+']\n\n'+body.slice(0,400), createdAt:new Date().toISOString(), type:'script' };
      opp.notes = opp.notes || [];
      opp.notes.push(note);
      opp.updatedAt = new Date().toISOString();
      saveState();
      showToast('Script linked to '+escapeHtml(opp.client||'lead'));
    });
  };
  window.scriptToAI = function(title, situation){
    window._aiPreload = { type:'script', title, situation };
    show('ai');
  };
}

// ─── Email Templates ──────────────────────────────────────────────────────────
function templates(){
  const cats = ['All', ...new Set(data.templates.map(t=>t.category))];
  view.innerHTML = `
<div class="eyebrow">Copy-Ready Communication</div>
<h1 style="color:var(--ink)">Email Templates</h1>
<p class="lede">Templates for every stage of the sales conversation. Personalize with a live lead to auto-fill client name, project, service line, and follow-up date.</p>

<div style="display:flex;gap:10px;margin-bottom:14px;align-items:center;flex-wrap:wrap">
  <input id="tmplSearch" type="search" placeholder="Search templates…" style="flex:1;min-width:180px;max-width:280px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;font-size:.88rem;color:var(--ink);background:var(--surface)">
  <div class="tabs" style="margin:0;flex:1">${cats.map((c,i)=>`<button class="tab ${i===0?'active':''}" data-cat="${c}">${escapeHtml(c)}</button>`).join('')}</div>
</div>

<div id="templateList" class="grid grid-2" style="gap:14px"></div>`;

  const box    = document.getElementById('templateList');
  const search = document.getElementById('tmplSearch');
  let currentCat = 'All';

  function render(){
    let list = data.templates;
    if(currentCat !== 'All') list = list.filter(t=>t.category===currentCat);
    const q = search.value.toLowerCase().trim();
    if(q) list = list.filter(t=>(t.title+' '+t.subject+' '+t.body+' '+(t.category||'')).toLowerCase().includes(q));

    if(!list.length){ box.innerHTML = `<div style="grid-column:1/-1;padding:40px;text-align:center;color:var(--muted)">No templates match.</div>`; return; }

    box.innerHTML = list.map(t=>`
      <article class="card" style="border:1px solid var(--line);border-top:3px solid #2D7A55">
        <span class="badge" style="display:block;margin-bottom:6px">${escapeHtml(t.category)}</span>
        <h3 style="color:var(--ink);margin:0 0 6px">${escapeHtml(t.title)}</h3>
        <p style="font-size:.82rem;margin:0 0 10px"><strong style="color:var(--muted)">Subject:</strong> <span style="color:var(--ink)">${escapeHtml(t.subject)}</span></p>
        <div class="script-box" style="font-size:.83rem;max-height:160px;overflow:hidden;position:relative">
          ${nl2br(t.body)}
          <div style="position:absolute;bottom:0;left:0;right:0;height:40px;background:linear-gradient(transparent,var(--surface))"></div>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">
          <button class="secondary-btn" style="font-size:.78rem" onclick="copyText('${escapeForJs(t.subject)}',this)">Copy Subject</button>
          <button class="primary-btn" style="font-size:.78rem" onclick="copyText('${escapeForJs(t.body)}',this)">Copy Body</button>
          <button class="secondary-btn" style="font-size:.78rem" onclick="tmplPersonalize('${escapeForJs(t.subject)}','${escapeForJs(t.body)}')">' + gwIcon('ai-spark',14,'currentColor') + ' Personalize + Copy</button>
          <button class="secondary-btn" style="font-size:.78rem" onclick="tmplUseForLead('${escapeForJs(t.subject)}','${escapeForJs(t.body)}')">Link to Lead</button>
          <button class="secondary-btn" style="font-size:.78rem" onclick="tmplToAI('${escapeForJs(t.title)}','${escapeForJs(t.category)}')">' + gwIcon('ai-spark',14,'currentColor') + ' AI Refine</button>
        </div>
      </article>`).join('');
  }

  render();
  search.addEventListener('input', render);
  view.querySelector('.tabs').addEventListener('click',e=>{
    if(!e.target.matches('.tab')) return;
    view.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    e.target.classList.add('active');
    currentCat = e.target.dataset.cat;
    render();
  });

  window.tmplPersonalize = function(subj, body){
    openLeadPicker(function(id){
      const opp=state.opportunities.find(x=>x.id===id);
      if(!opp) return;
      const merged = mergeTemplate(body, opp);
      const mergedSubj = mergeTemplate(subj, opp);
      navigator.clipboard.writeText('Subject: '+mergedSubj+'\n\n'+merged).catch(()=>{});
      showToast('Personalized for '+escapeHtml(opp.client||'lead')+' — copied to clipboard');
    });
  };
  window.tmplUseForLead = function(subj, body){
    openLeadPicker(function(id){
      const opp = state.opportunities.find(x=>x.id===id);
      if(!opp) return;
      const note = { id:'n'+Date.now(), text:'[Email: '+subj+']\n\n'+body.slice(0,400), createdAt:new Date().toISOString(), type:'template' };
      opp.notes = opp.notes || [];
      opp.notes.push(note);
      opp.updatedAt = new Date().toISOString();
      saveState();
      showToast('Template linked to '+escapeHtml(opp.client||'lead'));
    });
  };
  window.tmplToAI = function(title, category){
    window._aiPreload = { type:'template', title, category };
    show('ai');
  };
}

// ─── Objection Handling ───────────────────────────────────────────────────────
function objections(){
  const SEVERITY = { 'Your price is too high.':'high', 'I got a cheaper quote.':'high', 'Can you do it cheaper?':'high', 'I need to think about it.':'medium', 'I\'m not sure this is the right time.':'medium', 'I want to get a few more quotes.':'low' };
  const SEVERITY_COLORS = { high:'#8B3A2A', medium:'#8B6914', low:'#2D7A55' };
  const SEVERITY_LABELS = { high:'Price/Budget', medium:'Timing/Commitment', low:'Shopping' };

  view.innerHTML = `
<div class="eyebrow">Decision Management</div>
<h1 style="color:var(--ink)">Objection Handling</h1>
<p class="lede">Do not argue. Clarify, reconnect to the buying reason, protect scope quality, and guide the client toward a clear decision.</p>

<div style="display:flex;gap:8px;margin-bottom:18px;flex-wrap:wrap">
  <button class="tab active" data-sev="all">All Objections</button>
  <button class="tab" data-sev="high" style="border-color:#8B3A2A44">Price / Budget</button>
  <button class="tab" data-sev="medium" style="border-color:#8B691444">Timing / Commitment</button>
  <button class="tab" data-sev="low" style="border-color:#2D7A5544">Shopping</button>
</div>

<div id="objList" class="grid grid-2" style="gap:14px"></div>`;

  function renderObjs(sev='all'){
    const list = sev === 'all' ? data.objections : data.objections.filter(o=>SEVERITY[o.title]===sev);
    document.getElementById('objList').innerHTML = list.map(o=>{
      const s = SEVERITY[o.title] || 'medium';
      const c = SEVERITY_COLORS[s];
      const lbl = SEVERITY_LABELS[s];
      return `<article class="card" style="border:1px solid var(--line);border-left:4px solid ${c}">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <h3 style="margin:0;flex:1;color:var(--ink)">${escapeHtml(o.title)}</h3>
          <span style="font-size:.68rem;font-weight:700;background:${c}18;color:${c};border:1px solid ${c}44;border-radius:99px;padding:2px 8px;white-space:nowrap">${lbl}</span>
        </div>
        <p style="font-size:.82rem;color:var(--muted);margin:0 0 10px"><strong>What it may mean:</strong> ${escapeHtml(o.meaning)}</p>
        <details>
          <summary style="cursor:pointer;font-size:.82rem;font-weight:600;color:var(--blue);user-select:none;margin-bottom:8px;list-style:none">How to respond</summary>
          <div style="margin-top:8px">${list_(o.response)}</div>
        </details>
        <h4 style="font-size:.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:10px 0 6px">Say This</h4>
        <div class="script-box" style="font-size:.84rem">${escapeHtml(o.say)}</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">
          <button class="secondary-btn" style="font-size:.78rem" onclick="copyText('${escapeForJs(o.say)}',this)">Copy Response</button>
          <button class="secondary-btn" style="font-size:.78rem" onclick="objLogToLead('${escapeForJs(o.title)}','${escapeForJs(o.say)}')">Link to Lead</button>
          <button class="secondary-btn" style="font-size:.78rem" onclick="objToAI('${escapeForJs(o.title)}','${escapeForJs(o.say)}')">' + gwIcon('ai-spark',14,'currentColor') + ' AI Refine Reply</button>
        </div>
      </article>`;
    }).join('') || `<div style="grid-column:1/-1;padding:40px;text-align:center;color:var(--muted)">No objections in this category.</div>`;
  }

  // helper to avoid naming conflict
  function list_(arr){ return `<ul style="margin:0;padding-left:18px">${arr.map(x=>`<li style="font-size:.83rem;color:var(--ink);margin-bottom:4px">${escapeHtml(x)}</li>`).join('')}</ul>`; }

  renderObjs();
  view.querySelectorAll('.tab[data-sev]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      view.querySelectorAll('.tab[data-sev]').forEach(t=>t.classList.remove('active'));
      btn.classList.add('active');
      renderObjs(btn.dataset.sev);
    });
  });

  window.objLogToLead = function(title, say){
    openLeadPicker(function(id){
      const opp = state.opportunities.find(x=>x.id===id);
      if(!opp) return;
      const text = say ? '[Objection: '+title+']\n\nSay this: '+say.slice(0,400) : 'Objection raised: '+title;
      const note = { id:'n'+Date.now(), text:text, createdAt:new Date().toISOString(), type:'objection' };
      opp.notes = opp.notes || [];
      opp.notes.push(note);
      opp.updatedAt = new Date().toISOString();
      saveState();
      showToast('Objection linked to '+escapeHtml(opp.client||'lead'));
    });
  };
  window.objToAI = function(title, say){
    window._aiPreload = { type:'objection', title, say };
    show('ai');
  };
}

// ─── Pricing Tools ────────────────────────────────────────────────────────────
function calculator(){
  view.innerHTML = `
<div class="eyebrow">Quick Pricing Checks</div>
<h1 style="color:var(--ink)">Pricing Tools</h1>
<p class="lede">Use these for quick internal checks only. Final pricing should still follow Avalon estimating and margin review standards.</p>
<div class="grid grid-2 mt">
  <section class="card form">
    <h2>Margin Calculator</h2>
    <label><span>Estimated Cost</span><input id="cost" type="number" min="0" step="0.01" placeholder="Materials + labor + subs + overhead"></label>
    <label><span>Target Gross Margin %</span><input id="margin" type="number" min="1" max="95" step="1" value="45"></label>
    <button class="primary-btn" onclick="calcMargin()">Calculate Price</button>
    <div id="marginResult" class="result-box"></div>
  </section>
  <section class="card form">
    <h2>Labor Revenue Check</h2>
    <label><span>Labor Hours</span><input id="hours" type="number" min="0" step="0.5"></label>
    <label><span>Hourly Billing / Internal Rate</span><input id="rate" type="number" min="0" step="1" value="75"></label>
    <button class="primary-btn" onclick="calcLabor()">Calculate Labor Line</button>
    <div id="laborResult" class="result-box"></div>
  </section>
</div>
<div class="card warn mt">
  <h3>Reminder</h3>
  ${list(['Do not discount without changing scope or phasing.','Do not skip contingency on complex work.','Do not send price until scope, assumptions, exclusions, and decision path are clear.'])}
</div>`;
}
window.calcMargin = function(){
  const cost=Number(document.getElementById('cost').value||0);
  const m=Number(document.getElementById('margin').value||0)/100;
  if(!cost||!m||m>=1){ document.getElementById('marginResult').innerHTML='Enter valid cost and margin.'; return; }
  const price=cost/(1-m); const gp=price-cost;
  const estComm = price * 0.07;
  window._lastCalcResult = { price, gp, estComm, cost };
  document.getElementById('marginResult').innerHTML=`
    <strong>Suggested sales price:</strong> ${money(price)}<br>
    <strong>Gross profit:</strong> ${money(gp)}<br>
    <strong>Markup on cost:</strong> ${Math.round((price/cost-1)*100)}%<br>
    <strong style="color:#2D7A55">Est. commission (~7%):</strong> <span style="color:#2D7A55">${money(estComm)}</span>
    <div style="margin-top:10px">
      <button class="primary-btn small" onclick="window.saveCalcToLead()">Save to Lead</button>
    </div>`;
};
window.saveCalcToLead = function(){
  if(!window._lastCalcResult) return showToast('Run a calculation first');
  const r = window._lastCalcResult;
  openLeadPicker(function(id){
    const opp = state.opportunities.find(x=>x.id===id);
    if(!opp) return;
    const note = { id:'n'+Date.now(), text:'Pricing estimate:\nCost: '+money(r.cost)+'\nPrice: '+money(r.price)+'\nGross Profit: '+money(r.gp)+'\nEst. Commission: '+money(r.estComm), createdAt: new Date().toISOString(), type:'pricing' };
    opp.notes=opp.notes||[]; opp.notes.push(note);
    opp.jobValue = Math.round(r.price);
    opp.updatedAt=new Date().toISOString();
    saveState();
    showToast('Pricing saved to '+escapeHtml(opp.client||'lead')+' · Job Value updated');
  });
};
window.calcLabor = function(){
  const h=Number(document.getElementById('hours').value||0), r=Number(document.getElementById('rate').value||0);
  document.getElementById('laborResult').innerHTML = h&&r ? `<strong>Labor line:</strong> ${money(h*r)}<br><span>${h} hours × ${money(r)}/hr</span>` : 'Enter labor hours and rate.';
};

// ─── AI Sales Assistant ───────────────────────────────────────────────────────
function ai(){
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  const preload = window._aiPreload || {};
  window._aiPreload = null; // consume

  const SITUATIONS = [
    { id:'reply_email',     label:'Reply to a Client Email',        icon: gwIcon('email',18,'#fff'), color:'#1A4740' },
    { id:'follow_up',       label:'Follow-Up After No Response',    icon: gwIcon('sync',18,'#fff'),  color:'#4D8A86' },
    { id:'proposal_intro',  label:'Proposal Introduction Email',    icon: gwIcon('checklist',18,'#fff'), color:'#2D7A55' },
    { id:'objection_reply', label:'Handle an Objection',            icon: gwIcon('shield',18,'#fff'), color:'#8B6914' },
    { id:'discovery_prep',  label:'Discovery Call Prep',            icon: gwIcon('target',18,'#fff'), color:'#B8744F' },
    { id:'site_walk_recap', label:'Post-Site Walk Summary',         icon: gwIcon('pin',18,'#fff'),    color:'#B8744F' },
    { id:'closing_email',   label:'Closing / Decision Ask',         icon: gwIcon('handshake',18,'#fff'), color:'#8B3A2A' },
    { id:'referral_ask',    label:'Ask for a Referral',             icon: gwIcon('star',18,'#fff'),  color:'#8B6914' },
    { id:'custom',          label:'Custom Situation',               icon: gwIcon('ai-spark',18,'#fff'), color:'#6F7E6A' },
  ];

  const openLeads = (state.opportunities||[]).filter(o=>!['Sold / Activation','Closed Lost'].includes(o.status));

  view.innerHTML = `
<div class="eyebrow">AI-Powered Sales</div>
<h1 style="color:var(--ink)">AI Sales Assistant</h1>
<p class="lede">Generate perfect sales emails, follow-ups, objection replies, and more. Select a situation, optionally link a lead for auto-fill, then customize and copy.</p>

<div style="display:grid;grid-template-columns:1fr 1.5fr;gap:20px;align-items:start;margin-top:20px" id="aiGrid">

  <!-- Left: Situation Picker + Options -->
  <div style="display:flex;flex-direction:column;gap:14px">
    <div class="card" style="padding:16px">
      <div style="font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:10px">1. Choose Situation</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
        ${SITUATIONS.map(s=>`
        <button id="sit-${s.id}" onclick="aiSelectSit('${s.id}')"
          style="display:flex;align-items:center;gap:8px;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:var(--surface);cursor:pointer;transition:all .15s;font-size:.82rem;font-weight:500;color:var(--ink);text-align:left"
          onmouseenter="this.style.borderColor='${s.color}';this.style.background='${s.color}0d'"
          onmouseleave="if(!this.classList.contains('ai-sit-active')){this.style.borderColor='var(--line)';this.style.background='var(--surface)'}">
          <span style="font-size:.95rem">${s.icon}</span>
          <span style="line-height:1.3">${escapeHtml(s.label)}</span>
        </button>`).join('')}
      </div>
    </div>

    <div class="card" style="padding:16px">
      <div style="font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:10px">2. Link a Lead (optional)</div>
      <select id="aiLeadSelect" style="width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;font-size:.85rem;color:var(--ink);background:var(--surface)">
        <option value="">— No lead — use placeholders —</option>
        ${openLeads.map(o=>`<option value="${o.id}">${escapeHtml(o.client||'Unnamed')} · ${escapeHtml(o.status||'')}</option>`).join('')}
      </select>
      <div id="aiLeadPreview" style="margin-top:8px;font-size:.78rem;color:var(--muted)"></div>
    </div>

    <div class="card" style="padding:16px">
      <div style="font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:10px">3. Context (optional)</div>
      <textarea id="aiContext" rows="3" placeholder="Paste their message, add notes, or describe the situation in detail…"
        style="width:100%;box-sizing:border-box;font-size:.83rem;border:1px solid var(--line);border-radius:8px;padding:8px 10px;color:var(--ink);resize:vertical;font-family:inherit;background:var(--surface)"></textarea>
    </div>

    <div class="card" style="padding:16px">
      <div style="font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:10px">4. Tone</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${['Warm &amp; Consultative','Direct &amp; Confident','Empathetic','Urgent but Not Pushy','Follow-Up'].map((t,i)=>`
        <button class="ai-tone-btn${i===0?' active':''}" data-tone="${t.replace(/&amp;/g,'&')}"
          style="padding:5px 12px;border-radius:99px;border:1px solid var(--line);font-size:.78rem;cursor:pointer;background:${i===0?'var(--blue)':'var(--surface)'};color:${i===0?'#fff':'var(--ink)'};transition:all .15s"
          onclick="aiSelectTone(this)">${t}</button>`).join('')}
      </div>
    </div>

    <button class="primary-btn" style="font-size:.95rem;padding:13px" onclick="aiGenerate()">
      ' + gwIcon('ai-spark',16,'currentColor') + ' Generate
    </button>
  </div>

  <!-- Right: Output -->
  <div style="display:flex;flex-direction:column;gap:14px">
    <div class="card" style="padding:16px;min-height:320px" id="aiOutputCard">
      <div style="font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:12px">Output</div>
      <div id="aiOutput" style="font-size:.88rem;color:var(--muted);font-style:italic">
        Select a situation and click Generate to build your email or reply. The output is crafted from Avalon's own scripts, tone guidelines, and your lead data.
      </div>
      <div id="aiOutputActions" style="display:none;margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="primary-btn" style="font-size:.82rem" onclick="copyText(document.getElementById('aiOutputText').value||'',this)">Copy Output</button>
        <button class="secondary-btn" style="font-size:.82rem" onclick="aiLoadIntoLead()">Load into Lead Note</button>
        <button class="secondary-btn" style="font-size:.82rem" onclick="aiRegenerate()">↻ Regenerate</button>
      </div>
      <textarea id="aiOutputText" style="display:none"></textarea>
    </div>

    <div class="card" style="padding:14px;background:rgba(99,102,241,.04);border-color:rgba(99,102,241,.2)" id="aiPromptCard">
      <div style="font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#1A4740;margin-bottom:8px">Prompt Preview</div>
      <div id="aiPromptPreview" style="font-size:.78rem;color:var(--muted);font-family:monospace;white-space:pre-wrap;max-height:160px;overflow:auto">
        Your prompt will appear here before generation. You can copy and paste it into ChatGPT, Claude, or any AI tool.
      </div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="secondary-btn" style="font-size:.78rem" onclick="copyText(document.getElementById('aiPromptPreview').textContent||'',this)">Copy Prompt</button>
        <a href="https://chat.openai.com" target="_blank" rel="noopener" style="font-size:.78rem;padding:6px 12px;border:1px solid var(--line);border-radius:6px;color:var(--ink);text-decoration:none;display:inline-flex;align-items:center;gap:4px">Open ChatGPT ↗</a>
        <a href="https://claude.ai" target="_blank" rel="noopener" style="font-size:.78rem;padding:6px 12px;border:1px solid var(--line);border-radius:6px;color:var(--ink);text-decoration:none;display:inline-flex;align-items:center;gap:4px">Open Claude ↗</a>
      </div>
    </div>

    <div class="card" style="padding:14px">
      <div style="font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:8px">Quick Prompt Library</div>
      <div style="display:grid;gap:6px">
        ${[
          ['Re-engage a ghost', 'Write a re-engagement email for a prospect who went dark after a proposal. Keep it short, reference our last conversation about their project, and give them a no-pressure out.'],
          ['Budget objection reply', 'Write a response to a client who said our price is too high. Reconnect to their Core Buying Reason, protect scope, avoid discounting, and offer a phasing option if appropriate.'],
          ['After site walk', 'Write a post-site walk follow-up email confirming what we discussed, setting clear next steps, and building anticipation for the proposal.'],
          ['Ask for referral', 'Write a referral request email for a happy client after job completion. Keep it natural, low-pressure, and give them a simple way to refer.'],
          ['Proposal follow-up', 'Write a follow-up email 3 days after sending a proposal where I haven\'t heard back. Warm, curious, not pushy — ask what questions they have.'],
        ].map(([lbl,prompt])=>`
        <button onclick="aiLoadQuickPrompt('${escapeForJs(prompt)}')" style="text-align:left;padding:8px 10px;border:1px solid var(--line);border-radius:6px;font-size:.8rem;cursor:pointer;background:var(--surface);color:var(--ink);transition:background .15s"
          onmouseenter="this.style.background='var(--line)'" onmouseleave="this.style.background='var(--surface)'">
          ${escapeHtml(lbl)} →
        </button>`).join('')}
      </div>
    </div>
  </div>
</div>

<!-- Responsive: collapse grid on small screens -->
<style>
@media(max-width:720px){
  #aiGrid{ grid-template-columns:1fr !important; }
}
</style>`;

  // State
  let selectedSit  = preload.type === 'objection' ? 'objection_reply' : preload.type === 'template' ? 'reply_email' : preload.type === 'script' ? (preload.situation?'discovery_prep':'reply_email') : null;
  let selectedTone = 'Warm & Consultative';

  if(preload.type === 'objection' && preload.say){
    document.getElementById('aiContext').value = 'Client objection: "'+preload.title+'"\n\nAvalon response framework:\n'+preload.say;
  }
  if(preload.type === 'script' && preload.situation){
    document.getElementById('aiContext').value = 'Situation: '+preload.situation;
  }
  if(selectedSit) aiSelectSit(selectedSit);

  // Lead preview
  document.getElementById('aiLeadSelect').addEventListener('change', function(){
    const opp = state.opportunities.find(x=>x.id===this.value);
    if(!opp){ document.getElementById('aiLeadPreview').textContent = ''; return; }
    document.getElementById('aiLeadPreview').innerHTML = `
      <strong style="color:var(--ink)">${escapeHtml(opp.client||'—')}</strong> · ${escapeHtml(opp.status||'')}
      ${opp.project?'<br>Project: '+escapeHtml(opp.project):''}
      ${opp.jobValue?'<br>Value: '+money(Number(opp.jobValue)):''}
      ${opp.serviceLine?'<br>Service: '+escapeHtml(opp.serviceLine):''}`;
  });

  window.aiSelectSit = function(id){
    selectedSit = id;
    view.querySelectorAll('[id^="sit-"]').forEach(btn=>{
      const sitId = btn.id.replace('sit-','');
      const sit = SITUATIONS.find(s=>s.id===sitId);
      if(sitId===id){
        btn.classList.add('ai-sit-active');
        btn.style.borderColor = sit?.color||'var(--blue)';
        btn.style.background  = (sit?.color||'#1A4740')+'18';
        btn.style.fontWeight  = '700';
      } else {
        btn.classList.remove('ai-sit-active');
        btn.style.borderColor = 'var(--line)';
        btn.style.background  = 'var(--surface)';
        btn.style.fontWeight  = '';
      }
    });
    buildPrompt();
  };

  window.aiSelectTone = function(btn){
    view.querySelectorAll('.ai-tone-btn').forEach(b=>{ b.style.background='var(--surface)'; b.style.color='var(--ink)'; b.classList.remove('active'); });
    btn.classList.add('active'); btn.style.background='var(--blue)'; btn.style.color='#fff';
    selectedTone = btn.dataset.tone;
    buildPrompt();
  };

  function buildPrompt(){
    const sit = SITUATIONS.find(s=>s.id===selectedSit);
    const leadId = document.getElementById('aiLeadSelect')?.value;
    const opp = leadId ? state.opportunities.find(x=>x.id===leadId) : null;
    const context = document.getElementById('aiContext')?.value?.trim();
    const repName = rep?.name || 'Your Name';

    if(!sit){ document.getElementById('aiPromptPreview').textContent = 'Select a situation above to see the prompt.'; return; }

    const leadBlock = opp ? `\nClient: ${opp.client||'[Name]'}\nProject: ${opp.project||'[Project]'}\nService: ${opp.serviceLine||'[Service Line]'}\nValue: ${opp.jobValue?money(Number(opp.jobValue)):'[Amount]'}\nStatus: ${opp.status||'[Stage]'}\n` : '\n[No lead linked — use placeholders]\n';

    const situationGuides = {
      reply_email:    'Write a professional, consultative reply to a client email. Acknowledge their message, advance the conversation, and set a clear next step.',
      follow_up:      'Write a follow-up email to a prospect who hasn\'t responded. Keep it short (3–5 sentences), reference the last touchpoint, and give a low-pressure re-engagement path.',
      proposal_intro: 'Write a proposal introduction email. Frame the proposal around the client\'s Core Buying Reasons, build anticipation, and set up a verbal walkthrough rather than an email read.',
      objection_reply:'Write a response to a client objection. Follow the Acknowledge → Reframe → Forward-Question framework. Reconnect to their emotional buying reason, protect scope, do not discount.',
      discovery_prep: 'Write a pre-discovery call prep note and a T.A.P.P.O. opening statement. Include confirmation of Time, Agenda, People, Process, and Outcome.',
      site_walk_recap:'Write a post-site walk summary email confirming what was discussed, key takeaways, project scope direction, and next steps with a timeline.',
      closing_email:  'Write a closing email asking for a decision. Reference the client\'s Core Buying Reason, make the ask clear but not aggressive, and offer a simple path to yes.',
      referral_ask:   'Write a referral request email for a happy client. Keep it natural, acknowledge their project outcome, and give them a simple way to refer without feeling pressured.',
      custom:         'Write a custom sales communication based on the context below.'
    };

    const prompt = `You are an expert sales coach for Avalon Landscape Construction — a consultative, process-driven landscape company. You write in a warm, professional, human tone. Never sound salesy or pushy. Always protect scope and margin. Never discount without changing scope.

TASK: ${situationGuides[selectedSit]||'Write a professional sales communication.'}

TONE: ${selectedTone}

REP NAME: ${repName}
COMPANY: Avalon Landscape Construction
${leadBlock}
${context ? 'ADDITIONAL CONTEXT:\n'+context+'\n' : ''}
INSTRUCTIONS:
- Write the complete email/message, ready to send
- Use [brackets] for any remaining variables the rep should fill in
- Open with the client's name
- Keep it conversational, not corporate
- End with a clear, single next step
- Sign off as ${repName}, Avalon Landscape Construction`;

    document.getElementById('aiPromptPreview').textContent = prompt;
    window._currentAiPrompt = prompt;
    return prompt;
  }

  function buildOutput(){
    const leadId = document.getElementById('aiLeadSelect')?.value;
    const opp = leadId ? state.opportunities.find(x=>x.id===leadId) : null;
    const repName = rep ? rep.name : 'Your Name';
    const clientName = opp && opp.client ? opp.client.split(' ')[0] : '[Client Name]';
    const project = (opp && opp.project) ? opp.project : '[Project]';
    const context = (document.getElementById('aiContext') ? document.getElementById('aiContext').value.trim() : '') || '';
    const sig = '\n\n' + repName + '\nAvalon Landscape Construction';
    const hi = 'Hi ' + clientName + ',\n\n';

    var out = '';
    if (selectedSit === 'reply_email') {
      out = hi
        + 'Thank you for reaching out — I appreciate you taking the time.\n\n'
        + (context ? 'Based on what you shared, ' : '')
        + 'I would love to learn more about your project and make sure we are thinking about it the right way before we discuss anything further.\n\n'
        + 'Would you be available for a quick 15-minute call this week? I am flexible on timing — just let me know what works for you.\n\n'
        + 'Looking forward to connecting,' + sig;

    } else if (selectedSit === 'follow_up') {
      out = hi
        + 'I wanted to follow up on our last conversation — I know things get busy.\n\n'
        + 'I am still very interested in learning more about your ' + project + ' project and seeing whether Avalon might be a good fit. No pressure at all — if the timing is not right, just let me know and I will check back when it makes sense.\n\n'
        + 'Worth a quick call this week?' + sig;

    } else if (selectedSit === 'proposal_intro') {
      out = hi
        + 'I have put together the proposal for your ' + project + ' project and wanted to walk you through it personally rather than just sending a PDF.\n\n'
        + 'The proposal reflects everything we discussed — especially [Core Buying Reason]. I want to make sure we are aligned before you spend time reading through it, and I have a few things I would like to clarify with you.\n\n'
        + 'Are you available for a 20-minute call ' + (context ? context : 'this week') + ' to review it together?' + sig;

    } else if (selectedSit === 'objection_reply') {
      var objBody = (context.toLowerCase().includes('price') || context.toLowerCase().includes('cheaper'))
        ? 'Before I respond, can I ask what you are comparing it to? Price only tells part of the story — scope, warranty, supervision, and what is actually included can vary significantly between proposals. I want to make sure we are comparing the same thing.\n\nIf you are open to it, walk me through what the other number includes and I can give you a straightforward answer about what is different.'
        : 'That is completely fair. Help me understand — is it the price, the scope, the timing, or something else? I would rather have a real conversation about your concern than have you sitting on something I could probably clear up in five minutes.';
      out = hi + 'I hear you — and I appreciate you being direct with me.\n\n' + objBody + sig;

    } else if (selectedSit === 'discovery_prep') {
      out = 'DISCOVERY CALL PREP — ' + clientName
        + '\n\nT.A.P.P.O. OPENING:\n"Thanks for having me out. Just to confirm: we have about [X] minutes today (Time). My goal is to [Agenda]. I would like to have both [decision-makers] on the same page (People). By the end, we will agree on whether it makes sense to move to the next step (Process and Outcome). Does that sound good?"'
        + '\n\nKEY CBR QUESTIONS:\n- "What prompted you to reach out now — what has changed?"\n- "Walk me through what matters most about this project."\n- "What would it mean to you if this project came out exactly right?"\n- "What is your biggest concern going into this?"'
        + '\n\nBUDGET FRAMING:\n"Before we go further, so I can make sure we are building something realistic for you — do you have a rough investment range in mind for this?"'
        + '\n\nNEXT STEP GATE:\n- Site walk scheduled, or reason to move forward confirmed';

    } else if (selectedSit === 'site_walk_recap') {
      out = hi
        + 'Thank you for having me out today — I really enjoyed walking the site and getting a clearer picture of what you are trying to accomplish.\n\n'
        + 'Here is a quick recap of what we covered:\n\n'
        + '- Project scope: ' + project + '\n'
        + '- Key priorities: [What mattered most to them]\n'
        + '- Site conditions: [Any constraints or access notes]\n'
        + '- Timeline discussed: [What they shared]\n'
        + '- Must-haves confirmed: [List from conversation]\n\n'
        + 'Next step: We will have the estimate ready for you by [date]. I will reach out to set up a time to walk through it together.\n\n'
        + 'In the meantime, if anything comes to mind or anything changes, do not hesitate to reach out.' + sig;

    } else if (selectedSit === 'closing_email') {
      out = hi
        + 'I wanted to check in on the proposal — I know you have had some time to look it over.\n\n'
        + 'Based on everything we discussed — especially [Core Buying Reason] — I believe we have built the right scope to get you exactly what you are looking for.\n\n'
        + 'Are you ready to move forward, or is there anything you would like to talk through before making a decision?\n\n'
        + 'Either way, I would love to hear where you are at.' + sig;

    } else if (selectedSit === 'referral_ask') {
      out = hi
        + 'It has been great working with you on ' + project + '. I hope you are thrilled with how it turned out.\n\n'
        + 'If you know anyone — a neighbor, friend, or colleague — who is thinking about a similar project, I would love an introduction. We do our best work for people who come in with a clear idea of what they want, which is exactly how you came to us.\n\n'
        + 'No obligation at all — just wanted you to know we appreciate the trust, and we are always open to a quick conversation with anyone you would send our way.\n\nThanks again,' + sig;

    } else {
      out = hi
        + (context ? '[Based on your context: ' + context.slice(0,100) + '...]\n\n' : '')
        + '[Draft your message here — use the prompt above in ChatGPT or Claude for a fully AI-generated version tailored to your situation.]' + sig;
    }
    return out;
  }

  window.aiGenerate = function(){
    const prompt = buildPrompt();
    if(!selectedSit){ showToast('Select a situation first'); return; }
    const output = buildOutput();
    const outEl = document.getElementById('aiOutput');
    const outTa = document.getElementById('aiOutputText');
    const actEl = document.getElementById('aiOutputActions');
    outEl.style.fontStyle = 'normal';
    outEl.style.color = 'var(--ink)';
    outEl.innerHTML = `<pre style="white-space:pre-wrap;font-family:inherit;font-size:.88rem;margin:0;line-height:1.65">${escapeHtml(output)}</pre>`;
    outTa.value = output;
    actEl.style.display = 'flex';
    showToast('Output generated — copy, edit, or load into a lead');
  };

  window.aiRegenerate = window.aiGenerate;

  window.aiLoadIntoLead = function(){
    const output = document.getElementById('aiOutputText')?.value;
    if(!output) return showToast('Generate output first');
    openLeadPicker(function(id){
      show('pipeline',id);
      setTimeout(()=>{
        const el=document.getElementById('newNote');
        if(el){ el.value=output.slice(0,600); el.focus(); showToast('Output loaded into lead note'); }
      },400);
    });
  };

  window.aiLoadQuickPrompt = function(prompt){
    document.getElementById('aiContext').value = prompt;
    if(!selectedSit){ aiSelectSit('custom'); }
    buildPrompt();
    showToast('Quick prompt loaded — click Generate');
  };

  // Build initial prompt preview
  buildPrompt();
}

// ═══════════════════════════════════════════════════════════════════════════
// Sales Academy 2.0 — View Layer  (app_premium.js)
// Light-mode palette · SVG graphics · role-gated admin · rich lesson renderer
// ═══════════════════════════════════════════════════════════════════════════

// ─── SVG Badge Shape Renderer ────────────────────────────────────────────────
function svgBadgeShape(shape, color, size) {
  size = size || 48;
  const h = Math.round(size * 0.866);
  switch (shape) {
    case 'hex':
      return `<svg width="${size}" height="${h}" viewBox="0 0 100 87" fill="none" xmlns="http://www.w3.org/2000/svg">
        <polygon points="50,2 98,26 98,74 50,98 2,74 2,26" fill="${color}22" stroke="${color}" stroke-width="4"/>
        <polygon points="50,14 86,33 86,71 50,90 14,71 14,33" fill="${color}44"/>
      </svg>`;
    case 'star':
      return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
        <polygon points="50,5 61,35 95,35 68,57 79,91 50,70 21,91 32,57 5,35 39,35" fill="${color}33" stroke="${color}" stroke-width="3"/>
      </svg>`;
    case 'shield':
      return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M50 8 L90 22 L90 52 C90 72 68 88 50 96 C32 88 10 72 10 52 L10 22 Z" fill="${color}22" stroke="${color}" stroke-width="4"/>
        <path d="M50 20 L78 31 L78 52 C78 65 65 76 50 82 C35 76 22 65 22 52 L22 31 Z" fill="${color}44"/>
      </svg>`;
    case 'flame':
      return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M50 95 C25 95 10 78 10 62 C10 46 22 40 28 30 C30 44 38 48 42 44 C36 34 42 16 50 8 C54 22 46 34 58 42 C62 28 66 20 72 14 C78 28 90 40 90 62 C90 78 75 95 50 95 Z" fill="${color}44" stroke="${color}" stroke-width="3"/>
      </svg>`;
    case 'bolt':
      return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
        <polygon points="58,5 20,55 46,55 42,95 80,45 54,45" fill="${color}44" stroke="${color}" stroke-width="3"/>
      </svg>`;
    case 'trophy':
      return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="35" y="75" width="30" height="8" rx="2" fill="${color}66" stroke="${color}" stroke-width="2"/>
        <rect x="28" y="83" width="44" height="8" rx="3" fill="${color}66" stroke="${color}" stroke-width="2"/>
        <path d="M25 15 L75 15 L75 50 C75 65 63 75 50 75 C37 75 25 65 25 50 Z" fill="${color}33" stroke="${color}" stroke-width="3"/>
        <path d="M25 20 C10 20 10 42 25 42" stroke="${color}" stroke-width="3" fill="none"/>
        <path d="M75 20 C90 20 90 42 75 42" stroke="${color}" stroke-width="3" fill="none"/>
      </svg>`;
    case 'check':
    default:
      return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="50" cy="50" r="44" fill="${color}22" stroke="${color}" stroke-width="4"/>
        <polyline points="28,50 44,66 72,34" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      </svg>`;
  }
}

// ─── SVG Phase Icon Renderer ──────────────────────────────────────────────────
function svgPhaseIcon(phaseOrder, color, size) {
  size = size || 40;
  if (phaseOrder === 1) {
    // Seedling / sprout shape
    return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <line x1="50" y1="90" x2="50" y2="40" stroke="${color}" stroke-width="5" stroke-linecap="round"/>
      <path d="M50 65 C50 65 30 60 22 44 C36 36 52 44 50 65 Z" fill="${color}66" stroke="${color}" stroke-width="2"/>
      <path d="M50 55 C50 55 70 48 76 32 C62 25 48 34 50 55 Z" fill="${color}44" stroke="${color}" stroke-width="2"/>
    </svg>`;
  } else if (phaseOrder === 2) {
    // Gear / execution
    return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="50" cy="50" r="14" fill="${color}44" stroke="${color}" stroke-width="4"/>
      <path d="M50 20 L54 30 L64 28 L68 38 L78 40 L76 50 L84 56 L80 66 L70 66 L64 74 L54 70 L50 80 L46 70 L36 74 L30 66 L20 66 L16 56 L24 50 L22 40 L32 38 L36 28 L46 30 Z" fill="${color}22" stroke="${color}" stroke-width="3"/>
    </svg>`;
  } else {
    // Trophy / mastery
    return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <polygon points="50,12 58,36 84,36 64,52 72,76 50,60 28,76 36,52 16,36 42,36" fill="${color}44" stroke="${color}" stroke-width="3"/>
    </svg>`;
  }
}

// ─── SVG Level Indicator ──────────────────────────────────────────────────────
function svgLevelIcon(levelId, color, size) {
  size = size || 22;
  const n = parseInt(levelId.replace('l',''), 10) || 1;
  // Draw n filled dots up to 9
  const dots = [];
  for (let i = 0; i < 9; i++) {
    dots.push(`<circle cx="${8 + i * 10}" cy="6" r="${i < n ? 5 : 3}" fill="${i < n ? color : color+'44'}"/>`);
  }
  return `<svg width="${8 + 9*10}" height="12" viewBox="0 0 96 12" fill="none" xmlns="http://www.w3.org/2000/svg">${dots.join('')}</svg>`;
}

// ─── SVG status icons (no emojis) ────────────────────────────────────────────
const SVG_LOCK = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
const SVG_CHECK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const SVG_PLAY = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
const SVG_ARROW = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`;
const SVG_TEAM = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
const SVG_NOTE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`;
const SVG_STAR = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;

function academy(param) {
  if (!window.Academy) {
    view.innerHTML = `<div class="card mt"><p style="color:var(--muted)">Academy engine loading…</p></div>`;
    return;
  }
  try {
    if (param && param.startsWith('phase:'))  return academyPhaseDetail(param.replace('phase:', ''));
    if (param && param.startsWith('module:')) return academyModuleWorkspace(param.replace('module:', ''));
    if (param === 'badges')         return academyBadgesView();
    if (param === 'practice')       return academyPracticeArena();
    if (param === 'profile')        return academyRepProfile();
    if (param === 'certifications') return academyCertificationsPage();
    if (param === 'admin') {
      const rep = window.getCurrentRep ? window.getCurrentRep() : null;
      if (!rep || rep.role !== 'admin') { academy(); return; }
      return academyAdminDashboard();
    }
    return academyHome();
  } catch(e) {
    console.error('[Academy] render error:', e);
    view.innerHTML = `<div class="card mt" style="border-color:#8B3A2A">
      <h3 style="color:#8B3A2A;margin-top:0">Academy Error</h3>
      <p style="color:var(--muted);font-family:monospace;font-size:.8rem">${escapeHtml(e.message)}</p>
      <button class="secondary-btn" onclick="localStorage.removeItem('avalonAcademyContentV1');location.reload()">Clear Cache &amp; Reload</button>
    </div>`;
  }
}

// ─── Shared Academy Styles (SA-201 through SA-207 design system) ─────────────
const ACAD_STYLES = `
<style id="acad-styles">
/* ══ Design tokens ════════════════════════════════════════════════════════════ */
/* Uses app vars: --bg, --card, --line, --ink, --muted, --blue */

/* ══ SA-101 Academy Home ═══════════════════════════════════════════════════════ */

/* Dashboard hero banner */
.acad-banner{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:28px 32px 24px;margin-bottom:24px;box-shadow:0 2px 12px rgba(14,23,32,.07);position:relative;overflow:hidden}
.acad-banner::before{content:'';position:absolute;top:0;right:0;width:260px;height:100%;background:linear-gradient(135deg,transparent 60%,rgba(0,167,225,.04) 100%);pointer-events:none}
.acad-banner-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.acad-banner-left{flex:1;min-width:0}
.acad-banner-eyebrow{font-size:.68rem;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:var(--blue);margin-bottom:6px}
.acad-banner-title{font-size:1.75rem;font-weight:800;color:var(--ink);margin:0 0 6px;line-height:1.1}
.acad-banner-sub{font-size:.9rem;color:var(--muted);line-height:1.5;margin:0}
.acad-banner-right{display:flex;flex-direction:column;align-items:flex-end;gap:8px;flex-shrink:0}

/* Level badge */
.acad-level-badge{display:inline-flex;align-items:center;gap:9px;border-radius:12px;padding:8px 16px;font-size:.88rem;font-weight:700;border:1.5px solid;transition:box-shadow .2s}
.acad-streak-badge{display:inline-flex;align-items:center;gap:7px;background:rgba(139,105,20,.08);border:1.5px solid rgba(139,105,20,.3);border-radius:99px;padding:6px 14px;font-size:.82rem;font-weight:700;color:#8B6914}

/* Stat row */
.acad-stat-row{display:flex;gap:0;margin-top:20px;padding-top:18px;border-top:1px solid var(--line);flex-wrap:wrap}
.acad-stat-pill{display:flex;flex-direction:column;align-items:center;padding:0 20px;border-right:1px solid var(--line)}
.acad-stat-pill:first-child{padding-left:0}
.acad-stat-pill:last-child{border-right:none}
.acad-stat-pill-num{font-size:1.6rem;font-weight:800;color:var(--ink);line-height:1}
.acad-stat-pill-label{font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-top:4px}

/* Level progress strip */
.acad-level-progress{margin-top:18px;padding-top:16px;border-top:1px solid var(--line)}
.acad-level-progress-labels{display:flex;justify-content:space-between;align-items:center;margin-bottom:7px}
.acad-level-progress-current{font-size:.82rem;font-weight:700}
.acad-level-progress-next{font-size:.78rem;color:var(--muted)}
.acad-level-bar{height:8px;background:var(--line);border-radius:6px;overflow:hidden}
.acad-level-bar-fill{height:100%;border-radius:6px;transition:width .7s cubic-bezier(.4,0,.2,1)}

/* Section headings */
.acad-sh{font-size:.7rem;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:0 0 14px;display:flex;align-items:center;gap:8px}
.acad-sh::after{content:'';flex:1;height:1px;background:var(--line)}

/* Continue card (CTA) */
.acad-continue-card{background:linear-gradient(135deg,rgba(0,167,225,.07) 0%,rgba(99,102,241,.05) 100%);border:1.5px solid rgba(0,167,225,.25);border-radius:14px;padding:18px 22px;display:flex;align-items:center;gap:18px;cursor:pointer;transition:border-color .2s,box-shadow .2s,transform .15s;margin-bottom:24px}
.acad-continue-card:hover{border-color:var(--blue);box-shadow:0 6px 24px rgba(0,167,225,.12);transform:translateY(-2px)}
.acad-continue-icon{width:52px;height:52px;border-radius:14px;background:var(--blue);display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 4px 12px rgba(0,167,225,.25)}
.acad-continue-body{flex:1;min-width:0}
.acad-continue-eyebrow{font-size:.66rem;font-weight:800;text-transform:uppercase;letter-spacing:.09em;color:var(--blue);margin-bottom:4px}
.acad-continue-title{font-size:1.02rem;font-weight:700;color:var(--ink);margin-bottom:3px}
.acad-continue-meta{font-size:.8rem;color:var(--muted)}
.acad-continue-arrow{color:var(--blue);flex-shrink:0}

/* ══ SA-203 Phase Cards ════════════════════════════════════════════════════════ */
.acad-phase-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:24px}
@media(max-width:900px){.acad-phase-grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:580px){.acad-phase-grid{grid-template-columns:1fr}}

.acad-phase-card{background:var(--card);border:1.5px solid var(--line);border-radius:16px;padding:0;cursor:pointer;transition:border-color .2s,box-shadow .2s,transform .15s;position:relative;overflow:hidden;display:flex;flex-direction:column}
.acad-phase-card:hover:not(.acad-phase-locked){border-color:var(--blue);box-shadow:0 6px 24px rgba(14,23,32,.1);transform:translateY(-3px)}
.acad-phase-card.acad-phase-locked{opacity:.55;cursor:not-allowed}
.acad-phase-card.acad-phase-complete{border-color:rgba(16,185,129,.35)}

/* Color bar top */
.acad-phase-bar{height:5px;width:100%;border-radius:16px 16px 0 0}
.acad-phase-body{padding:20px 20px 16px;flex:1;display:flex;flex-direction:column}
.acad-phase-header{display:flex;align-items:flex-start;gap:12px;margin-bottom:12px}
.acad-phase-icon-wrap{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.acad-phase-meta{flex:1;min-width:0}
.acad-phase-eyebrow{font-size:.64rem;font-weight:800;text-transform:uppercase;letter-spacing:.09em;margin-bottom:3px}
.acad-phase-name{font-size:1.05rem;font-weight:800;color:var(--ink);margin:0;line-height:1.2}
.acad-phase-desc{font-size:.82rem;color:var(--muted);line-height:1.55;margin:0 0 16px;flex:1}

/* Progress bar in phase card */
.acad-phase-prog{margin-top:auto}
.acad-phase-prog-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.acad-phase-prog-label{font-size:.72rem;color:var(--muted)}
.acad-phase-prog-pct{font-size:.8rem;font-weight:800;color:var(--ink)}
.acad-phase-prog-track{height:7px;background:var(--line);border-radius:6px;overflow:hidden}
.acad-phase-prog-fill{height:100%;border-radius:6px;transition:width .6s ease}
.acad-phase-prog-sub{font-size:.71rem;color:var(--muted);margin-top:6px}

/* Phase CTA row */
.acad-phase-cta{display:flex;align-items:center;justify-content:space-between;padding:12px 20px;border-top:1px solid var(--line);margin-top:0}

/* SA-204 Status chips */
.sa-chip{display:inline-flex;align-items:center;gap:5px;border-radius:99px;padding:3px 10px;font-size:.67rem;font-weight:700;letter-spacing:.03em;white-space:nowrap}
.sa-chip-not-started{background:var(--line);color:var(--muted)}
.sa-chip-in-progress{background:rgba(245,158,11,.1);color:#7A5C10;border:1px solid rgba(245,158,11,.3)}
.sa-chip-complete{background:rgba(16,185,129,.1);color:#2D7A55;border:1px solid rgba(16,185,129,.3)}
.sa-chip-locked{background:rgba(100,116,139,.08);color:#6F7E6A;border:1px solid rgba(100,116,139,.2)}
.sa-chip-certified{background:rgba(245,158,11,.12);color:#7A5C10;border:1px solid rgba(245,158,11,.35)}
.sa-chip-beginner{background:rgba(99,102,241,.08);color:#1A4740;border:1px solid rgba(99,102,241,.2)}
.sa-chip-intermediate{background:rgba(14,165,233,.08);color:#4D8A86;border:1px solid rgba(14,165,233,.2)}
.sa-chip-advanced{background:rgba(239,68,68,.07);color:#8B3A2A;border:1px solid rgba(239,68,68,.2)}

/* SA-204 CTA Buttons */
.sa-btn-primary{display:inline-flex;align-items:center;gap:8px;border:none;border-radius:10px;padding:10px 20px;font-size:.88rem;font-weight:700;cursor:pointer;background:var(--blue);color:#fff;transition:opacity .15s,transform .1s,box-shadow .15s;box-shadow:0 2px 8px rgba(0,167,225,.2)}
.sa-btn-primary:hover{opacity:.9;transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,167,225,.3)}
.sa-btn-primary:disabled{opacity:.4;cursor:not-allowed;transform:none;box-shadow:none}
.sa-btn-secondary{display:inline-flex;align-items:center;gap:7px;border:1.5px solid var(--line);border-radius:10px;padding:9px 18px;font-size:.85rem;font-weight:600;cursor:pointer;background:var(--card);color:var(--ink);transition:border-color .15s,background .15s}
.sa-btn-secondary:hover{border-color:var(--blue);background:rgba(0,167,225,.04)}
.sa-btn-ghost{display:inline-flex;align-items:center;gap:6px;border:none;border-radius:8px;padding:7px 14px;font-size:.82rem;font-weight:600;cursor:pointer;background:transparent;color:var(--muted);transition:color .15s,background .15s}
.sa-btn-ghost:hover{background:var(--line);color:var(--ink)}

/* Sidebar cards */
.acad-sidebar-card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:14px}
.acad-sidebar-card-head{font-size:.7rem;font-weight:800;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);margin-bottom:12px;display:flex;align-items:center;gap:7px}

/* Badge mini-rows (upcoming) */
.acad-badge-row{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1.5px solid var(--line);border-radius:11px;margin-bottom:8px;cursor:pointer;transition:border-color .2s,background .15s;background:var(--bg)}
.acad-badge-row:hover{border-color:var(--blue);background:rgba(0,167,225,.03)}
.acad-badge-row-text{flex:1;min-width:0}
.acad-badge-row-name{font-size:.85rem;font-weight:700;color:var(--ink);margin-bottom:2px}
.acad-badge-row-desc{font-size:.73rem;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Recently completed row */
.acad-recent-row{display:flex;align-items:center;gap:11px;padding:10px 0;border-bottom:1px solid var(--line);cursor:pointer;transition:opacity .15s}
.acad-recent-row:last-child{border-bottom:none}
.acad-recent-row:hover{opacity:.78}
.acad-recent-check{width:28px;height:28px;border-radius:50%;background:rgba(16,185,129,.1);border:1.5px solid #2D7A55;display:flex;align-items:center;justify-content:center;color:#2D7A55;flex-shrink:0}

/* Onboarding path */
.acad-onboarding{background:rgba(0,167,225,.04);border:1.5px solid rgba(0,167,225,.18);border-radius:14px;padding:22px;margin-bottom:0}
.acad-onboarding-title{font-size:1rem;font-weight:700;color:var(--ink);margin:0 0 14px;display:flex;align-items:center;gap:9px}
.acad-onboarding-step{display:flex;align-items:flex-start;gap:11px;padding:9px 0;border-bottom:1px solid rgba(0,167,225,.1);font-size:.84rem;color:var(--ink);line-height:1.5}
.acad-onboarding-step:last-child{border-bottom:none;padding-bottom:0}
.acad-onboarding-num{width:22px;height:22px;border-radius:50%;background:var(--blue);color:#fff;font-size:.67rem;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}

/* ══ SA-102 Phase Detail Page ══════════════════════════════════════════════════ */

/* Phase hero */
.acad-phase-hero{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:28px 32px;margin-bottom:22px;position:relative;overflow:hidden;box-shadow:0 2px 10px rgba(14,23,32,.06)}
.acad-phase-hero-bar{position:absolute;top:0;left:0;right:0;height:4px}
.acad-phase-hero-inner{display:flex;align-items:flex-start;gap:20px;flex-wrap:wrap}
.acad-phase-hero-icon{width:60px;height:60px;border-radius:16px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.acad-phase-hero-body{flex:1;min-width:0}
.acad-phase-hero-eyebrow{font-size:.68rem;font-weight:800;text-transform:uppercase;letter-spacing:.1em;margin-bottom:5px}
.acad-phase-hero-title{font-size:1.6rem;font-weight:800;color:var(--ink);margin:0 0 8px;line-height:1.1}
.acad-phase-hero-desc{font-size:.9rem;color:var(--muted);line-height:1.6;margin:0}

/* SA-202 Progress card */
.acad-progress-card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 24px;margin-bottom:22px}
.acad-progress-card-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px}
.acad-progress-card-label{font-size:.92rem;font-weight:700;color:var(--ink)}
.acad-progress-card-pct{font-size:1.4rem;font-weight:800}
.acad-progress-bar{height:10px;background:var(--line);border-radius:8px;overflow:hidden;margin-bottom:10px}
.acad-progress-bar-fill{height:100%;border-radius:8px;transition:width .6s ease}
.acad-progress-meta{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.acad-progress-meta-item{font-size:.8rem;color:var(--muted);display:flex;align-items:center;gap:5px}

/* SA-203 Module card (roadmap) */
.acad-module-card{display:flex;align-items:stretch;gap:0;background:var(--card);border:1.5px solid var(--line);border-radius:14px;margin-bottom:10px;overflow:hidden;cursor:pointer;transition:border-color .2s,box-shadow .2s,transform .15s}
.acad-module-card:hover:not(.acad-module-locked){border-color:var(--blue);box-shadow:0 4px 18px rgba(14,23,32,.09);transform:translateY(-2px)}
.acad-module-card.acad-module-locked{opacity:.55;cursor:not-allowed}
.acad-module-card.acad-module-complete{border-color:rgba(16,185,129,.3)}
.acad-module-card-accent{width:5px;flex-shrink:0}
.acad-module-card-step{width:52px;display:flex;align-items:center;justify-content:center;flex-shrink:0;padding:20px 0}
.acad-module-card-num{width:36px;height:36px;border-radius:50%;border:2.5px solid;display:flex;align-items:center;justify-content:center;font-size:.82rem;font-weight:800}
.acad-module-card-body{flex:1;min-width:0;padding:18px 16px}
.acad-module-card-title{font-size:.97rem;font-weight:700;color:var(--ink);margin-bottom:5px}
.acad-module-card-desc{font-size:.82rem;color:var(--muted);line-height:1.5;margin-bottom:10px}
.acad-module-card-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.acad-module-card-cta{display:flex;align-items:center;padding:18px 20px 18px 12px;flex-shrink:0}

/* Locked reason tooltip */
.acad-lock-reason{display:flex;align-items:center;gap:7px;margin-top:8px;font-size:.76rem;color:var(--muted);font-style:italic}

/* ══ SA-103 Module Workspace ═══════════════════════════════════════════════════ */

/* Workspace breadcrumb */
.acad-breadcrumb{display:flex;align-items:center;gap:7px;margin-bottom:18px;flex-wrap:wrap}
.acad-breadcrumb-item{font-size:.82rem;color:var(--muted);cursor:pointer;transition:color .15s;white-space:nowrap}
.acad-breadcrumb-item:hover{color:var(--blue)}
.acad-breadcrumb-sep{color:var(--line);font-size:.9rem}
.acad-breadcrumb-current{font-size:.82rem;color:var(--ink);font-weight:600}

/* Module header bar */
.acad-ws-header{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px 24px;margin-bottom:18px}
.acad-ws-header-inner{display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap}
.acad-ws-header-body{flex:1;min-width:0}
.acad-ws-mod-eyebrow{font-size:.65rem;font-weight:800;text-transform:uppercase;letter-spacing:.09em;margin-bottom:4px}
.acad-ws-mod-title{font-size:1.28rem;font-weight:800;color:var(--ink);margin:0 0 4px;line-height:1.2}
.acad-ws-mod-sub{font-size:.84rem;color:var(--muted);margin:0}
.acad-ws-header-progress{display:flex;align-items:center;gap:10px;margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}
.acad-ws-header-pct-label{font-size:.75rem;color:var(--muted);white-space:nowrap}
.acad-ws-header-pct{font-size:.9rem;font-weight:800;color:var(--ink);white-space:nowrap;min-width:38px;text-align:right}
.acad-ws-progress-bar{flex:1;height:7px;background:var(--line);border-radius:5px;overflow:hidden}
.acad-ws-progress-fill{height:100%;border-radius:5px;transition:width .5s ease}

/* Workspace split layout */
.workspace-layout{display:grid;grid-template-columns:240px 1fr;gap:0;min-height:560px;border:1.5px solid var(--line);border-radius:16px;overflow:hidden;background:var(--bg)}
@media(max-width:760px){.workspace-layout{grid-template-columns:1fr}}

/* Left nav (SA-205) */
.workspace-nav{background:var(--card);border-right:1px solid var(--line);display:flex;flex-direction:column}
.workspace-nav-header{padding:18px 16px 14px;border-bottom:1px solid var(--line)}
.workspace-nav-title{font-size:.63rem;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:8px}
.workspace-nav-pct{font-size:1.5rem;font-weight:800;color:var(--ink);line-height:1}
.workspace-nav-sub{font-size:.72rem;color:var(--muted);margin-top:3px}
.workspace-nav-bar{height:6px;background:var(--line);border-radius:4px;margin-top:10px;overflow:hidden}
.workspace-nav-fill{height:100%;border-radius:4px;transition:width .5s ease}

/* Nav items */
.ws-nav-item{display:flex;align-items:center;gap:10px;padding:11px 14px 11px 12px;cursor:pointer;border-left:3px solid transparent;transition:all .15s;font-size:.82rem;color:var(--muted);line-height:1.3}
.ws-nav-item:hover{background:rgba(0,167,225,.04);color:var(--ink)}
.ws-nav-item.active-section{background:rgba(0,167,225,.07);border-left-color:var(--blue);color:var(--ink);font-weight:700}
.ws-nav-item.done-section{color:#2D7A55}
.ws-nav-item.done-section:hover{background:rgba(16,185,129,.04)}
.ws-nav-dot{width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.6rem;font-weight:800;flex-shrink:0;background:var(--line);color:var(--muted);border:2px solid var(--line);transition:all .2s}
.ws-nav-dot.done{background:rgba(16,185,129,.12);color:#2D7A55;border-color:#2D7A55}
.ws-nav-dot.active{background:rgba(0,167,225,.12);color:var(--blue);border-color:var(--blue)}
.ws-nav-type-badge{font-size:.55rem;font-weight:800;text-transform:uppercase;letter-spacing:.05em;opacity:.6}

/* Main content area */
.workspace-main{padding:30px 34px;overflow-y:auto;overflow-x:hidden;background:var(--bg);min-width:0;box-sizing:border-box}

/* Lesson content */
.ws-section-type{font-size:.65rem;text-transform:uppercase;letter-spacing:.12em;color:var(--blue);margin-bottom:6px;font-weight:800;display:flex;align-items:center;gap:7px}
.ws-section-type::before{content:'';display:inline-block;width:18px;height:2px;background:var(--blue);border-radius:2px}
.ws-section-title{font-size:1.38rem;font-weight:800;color:var(--ink);margin:0 0 20px;line-height:1.2}
.ws-body{color:var(--ink);line-height:1.78;font-size:.93rem;margin-bottom:20px}
.ws-body p{margin:0 0 14px}
.ws-body p:last-child{margin-bottom:0}
.ws-body strong{font-weight:700;color:var(--ink)}

.ws-key-point{display:flex;gap:11px;padding:12px 16px;background:rgba(0,167,225,.06);border-left:3px solid var(--blue);border-radius:0 10px 10px 0;margin-bottom:9px;font-size:.88rem;color:var(--ink);line-height:1.55}
.ws-key-point-dot{width:8px;height:8px;border-radius:50%;background:var(--blue);flex-shrink:0;margin-top:5px}

.ws-callout{border-radius:12px;padding:16px 20px;margin:20px 0;border-left:4px solid}
.ws-callout.principle{background:rgba(0,167,225,.05);border-color:var(--blue)}
.ws-callout.warning{background:rgba(239,68,68,.04);border-color:#8B3A2A}
.ws-callout.list{background:rgba(16,185,129,.04);border-color:#2D7A55}
.ws-callout-title{font-size:.75rem;font-weight:800;text-transform:uppercase;letter-spacing:.07em;margin-bottom:9px}
.ws-callout.principle .ws-callout-title{color:var(--blue)}
.ws-callout.warning .ws-callout-title{color:#8B3A2A}
.ws-callout.list .ws-callout-title{color:#2D7A55}
.ws-callout-body{font-size:.88rem;color:var(--ink);line-height:1.65}
.ws-callout-list{margin:0;padding-left:0;list-style:none}
.ws-callout-list li{padding:6px 0;font-size:.87rem;color:var(--ink);line-height:1.55;border-bottom:1px solid rgba(0,0,0,.05);display:flex;align-items:flex-start;gap:8px}
.ws-callout-list li::before{content:'';display:inline-block;width:6px;height:6px;border-radius:50%;background:#2D7A55;flex-shrink:0;margin-top:7px}
.ws-callout-list li:last-child{border-bottom:none}

.ws-examples{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:20px 0}
@media(max-width:600px){.ws-examples{grid-template-columns:1fr}}
.ws-example{background:var(--card);border:1.5px solid var(--line);border-radius:11px;padding:15px 17px}
.ws-example-label{font-size:.68rem;font-weight:800;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px;color:var(--blue)}
.ws-example-text{font-size:.86rem;color:var(--ink);line-height:1.6;font-style:italic}

.ws-note-prompt{background:var(--card);border:1.5px solid var(--line);border-radius:12px;padding:16px 18px;margin:20px 0}
.ws-note-prompt-label{font-size:.7rem;font-weight:800;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:9px;display:flex;align-items:center;gap:7px}
.ws-note-textarea{width:100%;min-height:96px;border:1.5px solid var(--line);border-radius:9px;padding:11px 13px;font-size:.88rem;color:var(--ink);background:var(--bg);resize:vertical;font-family:inherit;box-sizing:border-box;transition:border-color .2s}
.ws-note-textarea:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px rgba(0,167,225,.08)}

.ws-complete-btn{display:inline-flex;align-items:center;gap:9px;border:none;border-radius:11px;padding:12px 24px;font-size:.92rem;font-weight:700;cursor:pointer;margin-top:22px;transition:opacity .15s,transform .1s,box-shadow .15s;color:#fff;box-shadow:0 3px 10px rgba(0,0,0,.15)}
.ws-complete-btn:hover{opacity:.9;transform:translateY(-1px);box-shadow:0 6px 18px rgba(0,0,0,.18)}
.ws-complete-btn:disabled{opacity:.4;cursor:not-allowed;transform:none;box-shadow:none}
.ws-done-badge{display:inline-flex;align-items:center;gap:9px;background:rgba(16,185,129,.1);border:1.5px solid rgba(16,185,129,.4);color:#2D7A55;border-radius:11px;padding:11px 20px;font-size:.9rem;font-weight:700;margin-top:18px}
.ws-next-hint{margin-top:26px;padding:14px 18px;background:var(--card);border:1.5px solid var(--line);border-radius:11px;cursor:pointer;transition:border-color .15s,background .15s;display:flex;align-items:center;gap:12px}
.ws-next-hint:hover{border-color:var(--blue);background:rgba(0,167,225,.03)}
.ws-next-hint-eyebrow{font-size:.65rem;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;font-weight:700;margin-bottom:3px}
.ws-next-hint-title{font-size:.9rem;font-weight:700;color:var(--ink)}

/* ══ SA-303 Quiz redesign ══════════════════════════════════════════════════════ */
.quiz-container{background:var(--card);border:1.5px solid var(--line);border-radius:14px;padding:24px;width:100%;box-sizing:border-box}
.quiz-q{margin-bottom:28px;width:100%}
.quiz-q-num{font-size:.65rem;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:7px;display:flex;align-items:center;gap:8px}
.quiz-q-num-badge{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:var(--line);font-size:.6rem;font-weight:800;color:var(--muted)}
.quiz-q-prompt{font-weight:700;color:var(--ink);margin-bottom:14px;line-height:1.5;font-size:.97rem;word-wrap:break-word}
.quiz-choice{display:flex;align-items:center;gap:13px;padding:13px 16px;border:1.5px solid var(--line);border-radius:10px;cursor:pointer;margin-bottom:9px;transition:border-color .15s,background .15s;background:var(--bg);width:100%;box-sizing:border-box;text-align:left}
.quiz-choice:hover{border-color:var(--blue);background:rgba(0,167,225,.04)}
.quiz-choice.selected{border-color:var(--blue);background:rgba(0,167,225,.07)}
.quiz-choice.correct{border-color:#2D7A55;background:rgba(16,185,129,.07)}
.quiz-choice.wrong{border-color:#8B3A2A;background:rgba(239,68,68,.06)}
.quiz-choice input[type=radio]{margin:0;flex-shrink:0;width:16px;height:16px;accent-color:var(--blue);cursor:pointer}
.quiz-choice-text{font-size:.88rem;color:var(--ink);line-height:1.5;flex:1;min-width:0;word-wrap:break-word}
.quiz-submit-btn{background:var(--blue);color:#fff;border:none;border-radius:11px;padding:13px 30px;font-size:.95rem;font-weight:700;cursor:pointer;margin-top:20px;transition:opacity .15s,transform .1s,box-shadow .15s;box-shadow:0 2px 8px rgba(0,167,225,.2);display:inline-flex;align-items:center;gap:9px}
.quiz-submit-btn:hover{opacity:.9;transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,167,225,.3)}
.quiz-submit-btn:disabled{opacity:.4;cursor:not-allowed;transform:none;box-shadow:none}
.quiz-result{border-radius:14px;padding:20px;margin-top:20px}
.quiz-result.pass{background:rgba(16,185,129,.06);border:1.5px solid rgba(16,185,129,.3)}
.quiz-result.fail{background:rgba(239,68,68,.04);border:1.5px solid rgba(239,68,68,.2)}
.quiz-result-score{font-size:2.2rem;font-weight:800;line-height:1}
.quiz-feedback-item{padding:10px 14px;border-radius:10px;margin-bottom:8px;font-size:.84rem;border-left:3.5px solid}
.quiz-feedback-item.correct{background:rgba(16,185,129,.06);border-left-color:#2D7A55}
.quiz-feedback-item.wrong{background:rgba(239,68,68,.05);border-left-color:#8B3A2A}
.quiz-feedback-verdict{font-size:.75rem;font-weight:800;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}
.quiz-feedback-item.correct .quiz-feedback-verdict{color:#2D7A55}
.quiz-feedback-item.wrong .quiz-feedback-verdict{color:#8B3A2A}
.quiz-explanation{font-size:.82rem;color:var(--muted);margin-top:5px;line-height:1.5}
.prev-attempts-chip{display:inline-flex;align-items:center;gap:6px;font-size:.75rem;color:var(--muted);background:var(--line);border-radius:99px;padding:4px 12px;margin-bottom:16px}

/* ══ SA-206 Badges & Certifications ══════════════════════════════════════════ */
.acad-badges-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px;margin-bottom:24px}
.acad-badge-card{background:var(--card);border:1.5px solid var(--line);border-radius:14px;padding:20px 16px;text-align:center;transition:border-color .2s,transform .15s,box-shadow .15s;cursor:default;position:relative;overflow:hidden}
.acad-badge-card.earned{cursor:pointer}
.acad-badge-card.earned:hover{transform:translateY(-3px);box-shadow:0 8px 24px rgba(14,23,32,.1)}
.acad-badge-card.locked{opacity:.45}
.acad-badge-card-icon{display:flex;justify-content:center;margin-bottom:12px}
.acad-badge-card-name{font-size:.88rem;font-weight:700;margin-bottom:5px}
.acad-badge-card-desc{font-size:.73rem;color:var(--muted);line-height:1.45}
.acad-badge-card-type{font-size:.62rem;font-weight:800;text-transform:uppercase;letter-spacing:.07em;margin-top:10px;opacity:.6}

/* ══ SA-401 Admin Dashboard ═══════════════════════════════════════════════════ */
.admin-rep-card{background:var(--card);border:1.5px solid var(--line);border-radius:14px;margin-bottom:12px;overflow:hidden}
.admin-rep-header{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;gap:12px;flex-wrap:wrap;border-bottom:1px solid var(--line);cursor:pointer;transition:background .15s}
.admin-rep-header:hover{background:rgba(0,167,225,.03)}
.admin-mod-matrix{overflow-x:auto;padding:12px 18px 16px;display:flex;flex-wrap:wrap;gap:6px}
.admin-mod-cell{display:inline-flex;flex-direction:column;align-items:center;justify-content:center;width:60px;min-width:54px;border:1.5px solid var(--line);border-radius:9px;padding:8px 4px;font-size:.72rem;font-weight:700;text-align:center;background:var(--bg);transition:border-color .15s;cursor:default}
.admin-mod-cell.completed{background:rgba(16,185,129,.08);border-color:#2D7A55;color:#2D7A55}
.admin-mod-cell.in-progress{background:rgba(245,158,11,.08);border-color:#8B6914;color:#7A5C10}
.admin-action-btn{font-size:.76rem;padding:6px 12px;border:1.5px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);cursor:pointer;font-weight:600;transition:border-color .15s,background .15s;display:inline-flex;align-items:center;gap:6px}
.admin-action-btn:hover{border-color:var(--blue);background:rgba(0,167,225,.06)}
.admin-action-btn.danger:hover{border-color:#8B3A2A;background:rgba(239,68,68,.05);color:#8B3A2A}

/* Team summary metric cards */
.admin-metric-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:22px}
@media(max-width:760px){.admin-metric-cards{grid-template-columns:repeat(2,1fr)}}
.admin-metric-card{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:18px 20px}
.admin-metric-val{font-size:1.8rem;font-weight:800;color:var(--ink);line-height:1}
.admin-metric-label{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-top:5px}

/* ══ SA-104 Practice Arena ═══════════════════════════════════════════════════ */
.acad-practice-challenge{background:linear-gradient(135deg,#113931 0%,#113931 100%);border-radius:16px;padding:24px 28px;margin-bottom:22px;display:flex;align-items:center;gap:20px;color:#fff;box-shadow:0 4px 20px rgba(0,0,0,.15)}
.acad-practice-challenge-icon{width:56px;height:56px;border-radius:14px;background:rgba(255,255,255,.12);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.acad-practice-challenge-body{flex:1;min-width:0}
.acad-practice-challenge-title{font-size:1.1rem;font-weight:800;margin-bottom:4px}
.acad-practice-challenge-sub{font-size:.84rem;opacity:.75;line-height:1.4}
.acad-practice-item{background:var(--card);border:1.5px solid var(--line);border-radius:12px;padding:15px 18px;margin-bottom:10px;display:flex;align-items:center;gap:14px;cursor:pointer;transition:border-color .2s,box-shadow .15s,transform .1s}
.acad-practice-item:hover{border-color:var(--blue);box-shadow:0 3px 14px rgba(14,23,32,.08);transform:translateY(-1px)}
.acad-practice-item-icon{width:42px;height:42px;border-radius:11px;background:var(--line);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.acad-practice-item-body{flex:1;min-width:0}
.acad-practice-item-title{font-size:.9rem;font-weight:700;color:var(--ink);margin-bottom:3px}
.acad-practice-item-meta{font-size:.76rem;color:var(--muted);display:flex;align-items:center;gap:8px;flex-wrap:wrap}

/* ══ SA-403 Rep Profile ══════════════════════════════════════════════════════ */
.acad-profile-hero{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:26px 30px;margin-bottom:22px;display:flex;align-items:flex-start;gap:20px;flex-wrap:wrap}
.acad-profile-avatar{width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1.5rem;font-weight:800;color:#fff;flex-shrink:0}
.acad-profile-body{flex:1;min-width:0}
.acad-profile-name{font-size:1.3rem;font-weight:800;color:var(--ink);margin-bottom:4px}
.acad-profile-level{display:inline-flex;align-items:center;gap:7px;font-size:.84rem;font-weight:700;margin-bottom:12px}
.acad-profile-stats{display:flex;gap:0;flex-wrap:wrap;padding-top:14px;border-top:1px solid var(--line)}
.acad-profile-stat{padding:0 18px;border-right:1px solid var(--line);text-align:center}
.acad-profile-stat:first-child{padding-left:0}
.acad-profile-stat:last-child{border-right:none}
.acad-profile-stat-num{font-size:1.5rem;font-weight:800;color:var(--ink)}
.acad-profile-stat-label{font-size:.68rem;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-top:3px}

/* ══ SA-207 Empty/Loading/Locked states ══════════════════════════════════════ */
.acad-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 24px;text-align:center;background:var(--card);border:1.5px solid var(--line);border-radius:16px}
.acad-empty-icon{margin-bottom:16px;opacity:.4}
.acad-empty-title{font-size:1.05rem;font-weight:700;color:var(--ink);margin-bottom:8px}
.acad-empty-desc{font-size:.86rem;color:var(--muted);line-height:1.55;max-width:320px;margin:0 auto 18px}
.acad-locked-state{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:44px 24px;text-align:center;background:rgba(100,116,139,.04);border:1.5px solid rgba(100,116,139,.18);border-radius:16px}
.acad-locked-title{font-size:1.05rem;font-weight:700;color:var(--ink);margin:14px 0 8px}
.acad-locked-desc{font-size:.86rem;color:var(--muted);line-height:1.55;max-width:320px;margin:0 auto 18px}

/* Skeleton loader */
@keyframes acad-shimmer{0%{background-position:-400px 0}100%{background-position:400px 0}}
.acad-skeleton{border-radius:8px;background:linear-gradient(90deg,var(--line) 25%,rgba(0,0,0,.06) 50%,var(--line) 75%);background-size:800px 100%;animation:acad-shimmer 1.4s infinite linear}

/* ══ SA-501 Visual QA helpers ════════════════════════════════════════════════ */
/* Responsive: 2-col sidebar layout */
.acad-home-grid{display:grid;grid-template-columns:1fr 300px;gap:20px;align-items:start}
@media(max-width:1000px){.acad-home-grid{grid-template-columns:1fr}}
.acad-home-main{min-width:0}
.acad-home-sidebar{min-width:0}
@media(max-width:1000px){.acad-home-sidebar{display:grid;grid-template-columns:1fr 1fr;gap:14px}}
@media(max-width:620px){.acad-home-sidebar{grid-template-columns:1fr}}
</style>`;

// ─── Academy Home (SA-101) ────────────────────────────────────────────────────
function academyHome() {
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  const repId = rep ? rep.id : 'ryan';
  const hd = window.Academy.getHomeData(repId);
  const level = hd.level;
  const nextLevel = hd.nextLevel;
  const pointsToNext = nextLevel ? nextLevel.minPoints - hd.points : 0;
  const levelPct = nextLevel
    ? Math.min(100, Math.round(((hd.points - level.minPoints) / (nextLevel.minPoints - level.minPoints)) * 100))
    : 100;
  const isAdmin = rep && (rep.role === 'admin' || rep.role === 'office_manager');

  // ── SA-203 Phase cards ──
  const phaseCards = hd.phaseProgress.map(ph => {
    const phIcon = svgPhaseIcon(ph.sort_order, ph.color, 26);
    const statusChip = ph.pct === 100
      ? `<span class="sa-chip sa-chip-complete">${SVG_CHECK} Complete</span>`
      : ph.inProgress
      ? `<span class="sa-chip sa-chip-in-progress">In Progress</span>`
      : ph.locked
      ? `<span class="sa-chip sa-chip-locked">${SVG_LOCK} Locked</span>`
      : `<span class="sa-chip sa-chip-not-started">Not Started</span>`;
    const ctaLabel = ph.pct === 100 ? 'Review' : ph.inProgress ? 'Continue' : ph.locked ? 'Locked' : 'Start';
    const ctaColor = ph.pct === 100 ? '#2D7A55' : ph.locked ? 'var(--muted)' : ph.color;
    return `<article class="acad-phase-card${ph.locked?' acad-phase-locked':''}${ph.pct===100?' acad-phase-complete':''}" ${ph.locked?'':` onclick="show('academy','phase:${ph.id}')"`}>
      <div class="acad-phase-bar" style="background:${ph.color}"></div>
      <div class="acad-phase-body">
        <div class="acad-phase-header">
          <div class="acad-phase-icon-wrap" style="background:${ph.color}18">${phIcon}</div>
          <div class="acad-phase-meta">
            <div class="acad-phase-eyebrow" style="color:${ph.color}">Phase ${ph.sort_order}</div>
            <div class="acad-phase-name">${escapeHtml(ph.title)}</div>
          </div>
        </div>
        <p class="acad-phase-desc">${escapeHtml(ph.short_description)}</p>
        <div class="acad-phase-prog">
          <div class="acad-phase-prog-top">
            <span class="acad-phase-prog-label">${ph.modulesCompleted} of ${ph.totalModules} modules</span>
            <span class="acad-phase-prog-pct" style="color:${ph.color}">${ph.pct}%</span>
          </div>
          <div class="acad-phase-prog-track"><div class="acad-phase-prog-fill" style="width:${ph.pct}%;background:${ph.color}"></div></div>
        </div>
      </div>
      <div class="acad-phase-cta">
        ${statusChip}
        ${!ph.locked ? `<span style="font-size:.8rem;font-weight:700;color:${ctaColor};display:flex;align-items:center;gap:5px">${ctaLabel} ${SVG_ARROW}</span>` : `<span style="font-size:.75rem;color:var(--muted)">Complete Phase ${ph.sort_order-1}</span>`}
      </div>
    </article>`;
  }).join('');

  // ── Continue card ──
  const continueCard = hd.nextModule
    ? `<div class="acad-continue-card" onclick="show('academy','module:${hd.nextModule.id}')">
        <div class="acad-continue-icon">
          ${svgPhaseIcon(hd.nextModule.phase_id==='phase_1'?1:hd.nextModule.phase_id==='phase_2'?2:3,'#fff',22)}
        </div>
        <div class="acad-continue-body">
          <div class="acad-continue-eyebrow">${(window.Academy.getModuleProgress(repId,hd.nextModule.id)||{}).status==='in_progress'?'Continue where you left off':'Up next in your training'}</div>
          <div class="acad-continue-title">${escapeHtml(hd.nextModule.title)}</div>
          <div class="acad-continue-meta">Module ${hd.nextModule.sort_order} · ~${hd.nextModule.estimated_minutes||35} min · ${hd.nextModule.difficulty||'Beginner'}</div>
        </div>
        <div class="acad-continue-arrow">${SVG_ARROW}</div>
      </div>`
    : hd.overallPct === 100
    ? `<div class="acad-continue-card" style="background:linear-gradient(135deg,rgba(16,185,129,.08),rgba(5,150,105,.05));border-color:rgba(16,185,129,.3);cursor:default">
        <div class="acad-continue-icon" style="background:#2D7A55">${svgBadgeShape('trophy','#fff',24)}</div>
        <div class="acad-continue-body">
          <div class="acad-continue-eyebrow" style="color:#2D7A55">Academy Complete</div>
          <div class="acad-continue-title">All 9 modules finished</div>
          <div class="acad-continue-meta">You've mastered the full Avalon Sales Academy curriculum.</div>
        </div>
      </div>`
    : '';

  // ── Upcoming badges ──
  const upcomingBadgesHtml = hd.upcomingBadges.length
    ? hd.upcomingBadges.map(b => `
      <div class="acad-badge-row" onclick="show('academy','badges')">
        <div style="flex-shrink:0">${svgBadgeShape(b.shape,b.color,32)}</div>
        <div class="acad-badge-row-text">
          <div class="acad-badge-row-name">${escapeHtml(b.name)}</div>
          <div class="acad-badge-row-desc">${escapeHtml(b.desc)}</div>
        </div>
        <span style="color:var(--blue);flex-shrink:0">${SVG_ARROW}</span>
      </div>`).join('')
    : `<div class="acad-empty" style="padding:24px"><div class="acad-empty-title" style="font-size:.9rem">All badges earned</div></div>`;

  // ── Recently completed ──
  const recentHtml = hd.recentlyCompleted.length
    ? hd.recentlyCompleted.map(m => `
      <div class="acad-recent-row" onclick="show('academy','module:${m.id}')">
        <div class="acad-recent-check">${SVG_CHECK}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:.86rem;font-weight:700;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(m.title)}</div>
          <div style="font-size:.73rem;color:var(--muted)">Module ${m.sort_order} · ${(window.Academy.getModuleProgress(repId,m.id)||{}).quiz_best_score!=null?'Quiz: '+(window.Academy.getModuleProgress(repId,m.id)||{}).quiz_best_score+'%':''}</div>
        </div>
      </div>`).join('')
    : `<p style="color:var(--muted);font-size:.85rem;margin:0">No modules completed yet.</p>`;

  // ── Onboarding steps ──
  const onboardingSteps = ['Complete all 3 Phase 1 modules to understand the Avalon sales system.','Shadow one intake call, one discovery call, one site walk, and one proposal review.','Pass each module quiz at 75% or higher.','Role-play discovery, budget discussion, proposal delivery, and objection handling.','Build one sample scope and proposal with manager review.','Own a low-complexity opportunity under supervision.','Review first won/lost opportunities in weekly coaching.'];
  const onboardingHtml = onboardingSteps.map((s,i) => `
    <div class="acad-onboarding-step">
      <div class="acad-onboarding-num">${i+1}</div>
      <span>${escapeHtml(s)}</span>
    </div>`).join('');

  view.innerHTML = ACAD_STYLES + `

<!-- ── Dashboard Banner (SA-101) ── -->
<div class="acad-banner">
  <div class="acad-banner-row">
    <div class="acad-banner-left">
      <div class="acad-banner-eyebrow">Sales Training</div>
      <h1 class="acad-banner-title">Avalon Sales Academy</h1>
      <p class="acad-banner-sub">Master consultative selling, close more deals, and earn your certifications.</p>
    </div>
    <div class="acad-banner-right">
      <div class="acad-level-badge" style="border-color:${level.color}22;background:${level.color}0d;color:${level.color}">
        ${svgLevelIcon(level.id, level.color, 22)}
        <span>${escapeHtml(level.name)}</span>
      </div>
      ${hd.streak_days > 0 ? `<div class="acad-streak-badge">${svgBadgeShape('flame','#8B6914',16)} ${hd.streak_days}-day streak</div>` : ''}
      ${isAdmin ? `<button class="sa-btn-secondary" style="font-size:.78rem;padding:7px 14px" onclick="show('academy','admin')">${SVG_TEAM} Team Progress</button>` : ''}
    </div>
  </div>

  <div class="acad-stat-row">
    <div class="acad-stat-pill">
      <span class="acad-stat-pill-num">${hd.overallPct}%</span>
      <span class="acad-stat-pill-label">Complete</span>
    </div>
    <div class="acad-stat-pill">
      <span class="acad-stat-pill-num">${hd.completedModules}<span style="font-size:1rem;font-weight:600;color:var(--muted)">/${hd.totalModules}</span></span>
      <span class="acad-stat-pill-label">Modules</span>
    </div>
    <div class="acad-stat-pill">
      <span class="acad-stat-pill-num">${hd.points}</span>
      <span class="acad-stat-pill-label">Points</span>
    </div>
    <div class="acad-stat-pill">
      <span class="acad-stat-pill-num">${hd.badgesEarned}<span style="font-size:1rem;font-weight:600;color:var(--muted)">/${hd.totalBadges}</span></span>
      <span class="acad-stat-pill-label">Badges</span>
    </div>
    <div class="acad-stat-pill">
      <span class="acad-stat-pill-num">${hd.quizzesPassed}</span>
      <span class="acad-stat-pill-label">Quizzes</span>
    </div>
  </div>

  ${nextLevel
    ? `<div class="acad-level-progress">
        <div class="acad-level-progress-labels">
          <span class="acad-level-progress-current" style="color:${level.color}">${escapeHtml(level.name)}</span>
          <span class="acad-level-progress-next">${pointsToNext} pts → <strong style="color:${nextLevel.color}">${escapeHtml(nextLevel.name)}</strong></span>
        </div>
        <div class="acad-level-bar"><div class="acad-level-bar-fill" style="width:${levelPct}%;background:linear-gradient(90deg,${level.color},${nextLevel.color})"></div></div>
      </div>`
    : `<div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line);font-size:.86rem;color:#8B6914;font-weight:700;display:inline-flex;align-items:center;gap:7px">${svgBadgeShape('star','#8B6914',18)} Maximum Level Reached — Mentor</div>`}
</div>

<!-- ── Continue CTA ── -->
${continueCard}

<!-- ── Two-column home grid ── -->
<div class="acad-home-grid">
  <div class="acad-home-main">

    <div class="acad-sh">Training Phases</div>
    <div class="acad-phase-grid">${phaseCards}</div>

    <!-- Onboarding path -->
    <div class="acad-onboarding">
      <div class="acad-onboarding-title">
        <svg width="18" height="18" viewBox="0 0 14 14" fill="none"><path d="M7 1l1.5 4h4l-3.2 2.4 1.2 4L7 9l-3.5 2.4 1.2-4L1.5 5h4z" stroke="var(--blue)" stroke-width="1.4" stroke-linejoin="round"/></svg>
        New Hire Onboarding Path
      </div>
      ${onboardingHtml}
    </div>
  </div>

  <div class="acad-home-sidebar">
    <!-- Upcoming badges -->
    <div class="acad-sidebar-card">
      <div class="acad-sidebar-card-head">
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M7 1l1.5 4h4l-3.2 2.4 1.2 4L7 9l-3.5 2.4 1.2-4L1.5 5h4z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
        Upcoming Badges
      </div>
      ${upcomingBadgesHtml}
      <button class="sa-btn-ghost" style="width:100%;justify-content:center;margin-top:8px" onclick="show('academy','badges')">View All ${hd.totalBadges} Badges ${SVG_ARROW}</button>
    </div>

    <!-- Recently completed -->
    <div class="acad-sidebar-card">
      <div class="acad-sidebar-card-head">
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M2 7.5L5.5 11 12 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Recently Completed
      </div>
      ${recentHtml}
    </div>

    <!-- Quick links -->
    <div class="acad-sidebar-card">
      <div class="acad-sidebar-card-head">
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.3"/><path d="M7 4.5V7l2 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        Quick Links
      </div>
      <button class="sa-btn-ghost" style="width:100%;justify-content:flex-start;margin-bottom:4px" onclick="show('academy','badges')">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1l1.5 4h4l-3.2 2.4 1.2 4L7 9l-3.5 2.4 1.2-4L1.5 5h4z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
        Badges &amp; Achievements
      </button>
      <button class="sa-btn-ghost" style="width:100%;justify-content:flex-start;margin-bottom:4px" onclick="show('academy','profile')">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="5" r="3" stroke="currentColor" stroke-width="1.3"/><path d="M1 13c0-3 2.7-5 6-5s6 2 6 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        My Progress Profile
      </button>
      <button class="sa-btn-ghost" style="width:100%;justify-content:flex-start" onclick="show('academy','practice')">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M4 2v10l8-5-8-5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
        Practice Arena
      </button>
    </div>
  </div>
</div>`;
}

// ─── Phase Detail — SA-102 ─────────────────────────────────────────────────────
function academyPhaseDetail(phaseId) {
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  const repId = rep ? rep.id : 'ryan';
  const content = window.Academy.getContent();
  const ph = content.phases.find(p => p.id === phaseId);
  if (!ph) { academy(); return; }

  const rp = window.Academy.getRepProgress(repId);
  const phaseMods = content.modules.filter(m => m.phase_id === phaseId).sort((a,b) => a.sort_order - b.sort_order);
  const completedCount = phaseMods.filter(m => (rp.modules[m.id] || {}).status === 'completed').length;
  const inProgCount    = phaseMods.filter(m => (rp.modules[m.id] || {}).status === 'in_progress').length;
  const pct = phaseMods.length ? Math.round((completedCount / phaseMods.length) * 100) : 0;
  const totalMins = phaseMods.reduce((s, m) => s + (m.estimated_minutes || 0), 0);
  const doneMins  = phaseMods.filter(m => (rp.modules[m.id]||{}).status==='completed').reduce((s,m)=>s+(m.estimated_minutes||0),0);
  const remMins   = totalMins - doneMins;

  // ── SA-203 Module cards ──────────────────────────────────────────────────────
  const moduleCards = phaseMods.map((m, i) => {
    const mp     = rp.modules[m.id] || {};
    const status = mp.status || 'not_started';
    const isLocked = window.Academy.isModuleLocked(m.id, repId);

    // Step indicator
    let numHtml, accentColor;
    if (status === 'completed') {
      accentColor = '#2D7A55';
      numHtml = `<div class="acad-module-card-num" style="background:#2D7A55;border-color:#2D7A55;color:#fff">${SVG_CHECK}</div>`;
    } else if (status === 'in_progress') {
      accentColor = '#8B6914';
      numHtml = `<div class="acad-module-card-num" style="background:rgba(245,158,11,.12);border-color:#8B6914;color:#8B6914">${SVG_PLAY}</div>`;
    } else if (isLocked) {
      accentColor = 'var(--line)';
      numHtml = `<div class="acad-module-card-num" style="background:var(--line);border-color:var(--line);color:var(--muted)">${SVG_LOCK}</div>`;
    } else {
      accentColor = ph.color;
      numHtml = `<div class="acad-module-card-num" style="background:${ph.color}18;border-color:${ph.color}55;color:${ph.color}"><span style="font-size:.75rem;font-weight:800">${i+1}</span></div>`;
    }

    // Status chip
    const statusChip = status === 'completed'
      ? `<span class="sa-chip sa-chip-complete">Complete</span>`
      : status === 'in_progress'
      ? `<span class="sa-chip sa-chip-in-progress">In Progress</span>`
      : isLocked
      ? `<span class="sa-chip sa-chip-locked">${SVG_LOCK} Locked</span>`
      : `<span class="sa-chip sa-chip-not-started">Not Started</span>`;

    // Difficulty chip
    const diff = (m.difficulty||'').toLowerCase();
    const diffChip = diff
      ? `<span class="sa-chip sa-chip-${diff==='beginner'?'beginner':diff==='intermediate'?'intermediate':'advanced'}">${m.difficulty}</span>`
      : '';

    // Quiz chip
    const quizChip = mp.quiz_best_score != null
      ? `<span class="sa-chip" style="background:${mp.quiz_passed?'rgba(16,185,129,.1)':'rgba(239,68,68,.08)'};color:${mp.quiz_passed?'#2D7A55':'#8B3A2A'};border-color:${mp.quiz_passed?'rgba(16,185,129,.3)':'rgba(239,68,68,.3)'}">Quiz ${mp.quiz_best_score}%</span>`
      : '';

    // Time chip
    const timeChip = m.estimated_minutes
      ? `<span class="sa-chip">~${m.estimated_minutes} min</span>`
      : '';

    // Lock reason
    const lockReason = isLocked
      ? `<div class="acad-lock-reason">${SVG_LOCK} Complete all modules in the previous phase to unlock</div>`
      : '';

    // CTA
    let ctaHtml;
    if (isLocked) {
      ctaHtml = `<div class="acad-module-card-cta" style="justify-content:flex-start">
        <span class="sa-chip sa-chip-locked" style="pointer-events:none">${SVG_LOCK} Locked</span>
      </div>`;
    } else if (status === 'completed') {
      ctaHtml = `<div class="acad-module-card-cta">
        <span class="sa-chip sa-chip-complete">${SVG_CHECK} Complete</span>
        <button class="sa-btn-ghost" onclick="show('academy','module:${m.id}')">Review ${SVG_ARROW}</button>
      </div>`;
    } else if (status === 'in_progress') {
      ctaHtml = `<div class="acad-module-card-cta">
        <button class="sa-btn-primary" style="background:${ph.color}" onclick="show('academy','module:${m.id}')">Resume ${SVG_ARROW}</button>
        ${mp.percent_complete ? `<span class="sa-chip">${mp.percent_complete}% done</span>` : ''}
      </div>`;
    } else {
      ctaHtml = `<div class="acad-module-card-cta">
        <button class="sa-btn-primary" style="background:${ph.color}" onclick="show('academy','module:${m.id}')">Start Module ${SVG_ARROW}</button>
      </div>`;
    }

    const extraClass = status==='completed' ? ' acad-module-complete' : isLocked ? ' acad-module-locked' : '';

    return `<article class="acad-module-card${extraClass}" style="${isLocked?'cursor:not-allowed;':'cursor:pointer;'}">
      <div class="acad-module-card-accent" style="background:${accentColor}"></div>
      <div class="acad-module-card-step">
        ${numHtml}
      </div>
      <div class="acad-module-card-body" ${isLocked?'':` onclick="show('academy','module:${m.id}')"`}>
        <div class="acad-module-card-title">Module ${m.sort_order} — ${escapeHtml(m.title)}</div>
        <div class="acad-module-card-desc">${escapeHtml(m.short_description||'')}</div>
        <div class="acad-module-card-chips">
          ${statusChip}${diffChip}${timeChip}${quizChip}
        </div>
        ${lockReason}
      </div>
      ${ctaHtml}
    </article>`;
  }).join('');

  // ── Phase status chip ────────────────────────────────────────────────────────
  const phaseStatusChip = pct === 100
    ? `<span class="sa-chip sa-chip-complete">${SVG_CHECK} Complete</span>`
    : inProgCount > 0
    ? `<span class="sa-chip sa-chip-in-progress">${SVG_PLAY} In Progress</span>`
    : `<span class="sa-chip sa-chip-not-started">Not Started</span>`;

  view.innerHTML = ACAD_STYLES + `
<nav class="acad-breadcrumb">
  <span class="acad-breadcrumb-item" onclick="show('academy')" style="cursor:pointer">Academy</span>
  <span class="acad-breadcrumb-sep">›</span>
  <span class="acad-breadcrumb-current">Phase ${ph.sort_order} — ${escapeHtml(ph.title)}</span>
</nav>

<!-- SA-201 Phase Hero -->
<div class="acad-phase-hero" style="border-color:${ph.color}33">
  <div class="acad-phase-hero-bar" style="background:${ph.color}"></div>
  <div class="acad-phase-hero-inner">
    <div class="acad-phase-hero-icon">${svgPhaseIcon(ph.sort_order, ph.color, 48)}</div>
    <div class="acad-phase-hero-body">
      <div class="acad-phase-hero-eyebrow" style="color:${ph.color}">Phase ${ph.sort_order} · ${phaseStatusChip}</div>
      <h1 class="acad-phase-hero-title">${escapeHtml(ph.title)}</h1>
      <p class="acad-phase-hero-desc">${escapeHtml(ph.long_description)}</p>
    </div>
  </div>
</div>

<!-- SA-202 Progress Card -->
<div class="acad-progress-card">
  <div class="acad-progress-card-top">
    <div>
      <div class="acad-progress-card-label">Phase Progress</div>
      <div class="acad-progress-meta">${completedCount} of ${phaseMods.length} modules complete${remMins > 0 ? ` · ~${remMins} min remaining` : ''}</div>
    </div>
    <div class="acad-progress-card-pct" style="color:${ph.color}">${pct}%</div>
  </div>
  <div class="acad-progress-bar">
    <div class="acad-progress-bar-fill" style="width:${pct}%;background:${ph.color}"></div>
  </div>
</div>

<!-- SA-203 Module Roadmap -->
<div class="acad-sh">Module Roadmap</div>
<div style="display:flex;flex-direction:column;gap:12px;margin-top:4px">
  ${moduleCards}
</div>`;
}

// ─── Module Workspace — SA-103 ────────────────────────────────────────────────
function academyModuleWorkspace(moduleId) {
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  const repId = rep ? rep.id : 'ryan';
  const content = window.Academy.getContent();
  const mod = content.modules.find(m => m.id === moduleId);
  if (!mod) { academy(); return; }

  const ph = content.phases.find(p => p.id === mod.phase_id);
  const mp = window.Academy.getModuleProgress(repId, moduleId);
  const isLocked = window.Academy.isModuleLocked(moduleId, repId);
  const phColor = ph ? ph.color : 'var(--blue)';

  if (isLocked) {
    view.innerHTML = ACAD_STYLES + `
<nav class="acad-breadcrumb">
  <span class="acad-breadcrumb-item" onclick="show('academy')" style="cursor:pointer">Academy</span>
  <span class="acad-breadcrumb-sep">›</span>
  <span class="acad-breadcrumb-item" onclick="show('academy','phase:${mod.phase_id}')" style="cursor:pointer">${escapeHtml(ph ? ph.title : 'Phase')}</span>
  <span class="acad-breadcrumb-sep">›</span>
  <span class="acad-breadcrumb-current">${escapeHtml(mod.title)}</span>
</nav>
<div class="acad-locked-state">
  <div class="acad-empty-icon" style="background:rgba(99,102,241,.08);border-color:rgba(99,102,241,.2)">${SVG_LOCK}</div>
  <div class="acad-locked-title">Module Locked</div>
  <div class="acad-locked-desc">Complete all modules in ${ph && ph.sort_order > 1 ? `Phase ${ph.sort_order - 1}` : 'the previous phase'} to unlock this module.</div>
  <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:6px">
    <button class="sa-btn-primary" style="background:${phColor}" onclick="show('academy','phase:${mod.phase_id}')">View Phase Roadmap</button>
    <button class="sa-btn-secondary" onclick="show('academy')">Back to Academy</button>
  </div>
</div>`;
    return;
  }

  const _sectionId = `acad_active_${moduleId}`;
  const activeSectionId = localStorage.getItem(_sectionId) || (mod.sections[0] && mod.sections[0].id);
  const activeSection = mod.sections.find(s => s.id === activeSectionId) || mod.sections[0];

  // Determine module-level status for chips
  const modStatus = mp.status || 'not_started';
  const statusChip = modStatus === 'completed'
    ? `<span class="sa-chip sa-chip-complete">${SVG_CHECK} Complete</span>`
    : modStatus === 'in_progress'
    ? `<span class="sa-chip sa-chip-in-progress">${SVG_PLAY} In Progress</span>`
    : `<span class="sa-chip sa-chip-not-started">Not Started</span>`;

  const diffChip = mod.difficulty
    ? `<span class="sa-chip sa-chip-${mod.difficulty.toLowerCase()==='beginner'?'beginner':mod.difficulty.toLowerCase()==='intermediate'?'intermediate':'advanced'}">${mod.difficulty}</span>`
    : '';
  const timeChip = mod.estimated_minutes
    ? `<span class="sa-chip">~${mod.estimated_minutes} min</span>`
    : '';

  const navItems = mod.sections.map((s, si) => {
    const done = mp.sections_completed.includes(s.id);
    const isActive = s.id === (activeSection && activeSection.id);
    const typeLabel = s.section_type === 'overview' ? 'OV' : s.section_type === 'lesson' ? 'L' : s.section_type === 'quiz' ? 'Q' : 'S';
    return `<div class="ws-nav-item ${isActive ? 'active-section' : done ? 'done-section' : ''}" onclick="academyShowSection('${moduleId}','${s.id}')" id="ws-nav-${s.id}">
      <div class="ws-nav-dot ${done ? 'done' : isActive ? 'active' : ''}" style="${isActive&&!done?`background:${phColor};border-color:${phColor}`:''}">
        ${done ? SVG_CHECK : `<span style="font-size:.6rem;font-weight:800">${typeLabel}</span>`}
      </div>
      <span style="line-height:1.35">${escapeHtml(s.title)}</span>
    </div>`;
  }).join('');

  view.innerHTML = ACAD_STYLES + `
<nav class="acad-breadcrumb">
  <span class="acad-breadcrumb-item" onclick="show('academy')" style="cursor:pointer">Academy</span>
  <span class="acad-breadcrumb-sep">›</span>
  <span class="acad-breadcrumb-item" onclick="show('academy','phase:${mod.phase_id}')" style="cursor:pointer">${escapeHtml(ph ? ph.title : 'Phase')}</span>
  <span class="acad-breadcrumb-sep">›</span>
  <span class="acad-breadcrumb-current">Module ${mod.sort_order}</span>
</nav>

<!-- SA-103 Module workspace header -->
<div class="acad-ws-header" style="border-color:${phColor}33">
  <div class="acad-ws-header-inner">
    <div style="flex-shrink:0">${svgPhaseIcon(ph ? ph.sort_order : 1, phColor, 40)}</div>
    <div class="acad-ws-header-body">
      <div class="acad-ws-mod-eyebrow" style="color:${phColor}">
        ${escapeHtml(ph ? ph.title : 'Phase')} · Module ${mod.sort_order}
        &nbsp;${statusChip}${diffChip}${timeChip}
      </div>
      <h1 class="acad-ws-mod-title">${escapeHtml(mod.title)}</h1>
      <p class="acad-ws-mod-sub">${escapeHtml(mod.short_description||'')}</p>
    </div>
    <div class="acad-ws-header-progress">
      <div id="ws-pct" style="font-size:1.5rem;font-weight:800;color:${phColor};line-height:1">${mp.percent_complete}%</div>
      <div style="font-size:.72rem;color:var(--muted);margin-top:2px">complete</div>
      <div class="acad-ws-progress-bar" style="margin-top:8px;width:80px">
        <div class="acad-ws-progress-fill" id="ws-bar" style="width:${mp.percent_complete}%;background:${phColor}"></div>
      </div>
    </div>
  </div>
</div>

<div class="workspace-layout">
  <nav class="workspace-nav" id="ws-nav">
    <div class="workspace-nav-header">
      <div class="workspace-nav-title">${mod.sections.length} Sections</div>
      <div class="workspace-nav-sub">${mp.sections_completed.length} of ${mod.sections.length} done</div>
      <div class="workspace-nav-bar"><div class="workspace-nav-fill" style="width:${mp.percent_complete}%;background:${phColor}"></div></div>
    </div>
    ${navItems}
  </nav>
  <main class="workspace-main" id="ws-main">
    ${renderWorkspaceSection(mod, activeSection, mp, repId, ph)}
  </main>
</div>`;

  window.academyShowSection = function(modId, sectId) {
    localStorage.setItem(`acad_active_${modId}`, sectId);
    const c = window.Academy.getContent();
    const m = c.modules.find(x => x.id === modId);
    const sec = m && m.sections.find(s => s.id === sectId);
    if (!m || !sec) return;
    const r = window.getCurrentRep ? window.getCurrentRep() : null;
    const rId = r ? r.id : 'ryan';
    const mpNow = window.Academy.getModuleProgress(rId, modId);
    const phNow = c.phases.find(p => p.id === m.phase_id);
    const main = document.getElementById('ws-main');
    if (main) main.innerHTML = renderWorkspaceSection(m, sec, mpNow, rId, phNow);
    // Refresh nav active state
    document.querySelectorAll('.ws-nav-item').forEach(el => {
      if (el.id === `ws-nav-${sectId}`) {
        el.classList.add('active-section');
      } else {
        el.classList.remove('active-section');
      }
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
}

// ─── Section Content Renderer ─────────────────────────────────────────────────
function renderWorkspaceSection(mod, section, mp, repId, ph) {
  if (!section) return '<p style="color:var(--muted)">Select a section from the left.</p>';
  const isDone = mp.sections_completed.includes(section.id);
  const phColor = ph ? ph.color : 'var(--blue)';

  if (section.section_type === 'quiz') {
    return renderQuizSection(mod, mp, repId, ph);
  }

  let body = '';

  if (section.section_type === 'overview') {
    const obj = section.content && section.content.objective ? section.content.objective : '';
    const kps = section.content && section.content.keyPoints ? section.content.keyPoints : [];
    body = `
<div class="ws-body"><p>${escapeHtml(obj)}</p></div>
${kps.length ? `<h4 style="color:var(--ink);font-size:.9rem;margin:20px 0 10px;font-weight:700">Key Takeaways</h4>
${kps.map(kp => `<div class="ws-key-point">${escapeHtml(kp)}</div>`).join('')}` : ''}`;
  } else if (section.section_type === 'lesson') {
    // Try rich lesson data from Academy engine first
    const richData = window.Academy.RICH_LESSONS && window.Academy.RICH_LESSONS[mod.id]
      ? window.Academy.RICH_LESSONS[mod.id].find(l => l.id === section.id)
      : null;

    if (richData) {
      // ── Callout block ──
      let calloutHtml = '';
      if (richData.callout) {
        const ct = richData.callout;
        if (ct.type === 'list' && ct.items) {
          calloutHtml = `<div class="ws-callout list">
            <div class="ws-callout-title">${escapeHtml(ct.title||'')}</div>
            <ul class="ws-callout-list">${ct.items.map(it => `<li>${escapeHtml(it)}</li>`).join('')}</ul>
          </div>`;
        } else {
          calloutHtml = `<div class="ws-callout ${ct.type||'principle'}">
            <div class="ws-callout-title">${escapeHtml(ct.title||'')}</div>
            <div class="ws-callout-body">${escapeHtml(ct.body||'')}</div>
          </div>`;
        }
      }
      // ── Examples ──
      let examplesHtml = '';
      if (richData.examples && richData.examples.length) {
        examplesHtml = `<h4 style="font-size:.82rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin:20px 0 10px">Examples</h4>
        <div class="ws-examples">
          ${richData.examples.map(ex => `<div class="ws-example">
            <div class="ws-example-label">${escapeHtml(ex.label)}</div>
            <div class="ws-example-text">${escapeHtml(ex.text)}</div>
          </div>`).join('')}
        </div>`;
      }
      // ── Note prompt ──
      let noteHtml = '';
      if (richData.note_prompt) {
        const noteKey = `acad_note_${mod.id}_${section.id}_${repId}`;
        const savedNote = localStorage.getItem(noteKey) || '';
        noteHtml = `<div class="ws-note-prompt">
          <div class="ws-note-prompt-label">${SVG_NOTE} Your Notes</div>
          <p style="font-size:.84rem;color:var(--muted);margin:0 0 8px;line-height:1.5">${escapeHtml(richData.note_prompt)}</p>
          <textarea class="ws-note-textarea" id="note-ta-${section.id}" placeholder="Write your notes here…" onchange="localStorage.setItem('${noteKey}',this.value)">${escapeHtml(savedNote)}</textarea>
        </div>`;
      }
      body = `<div class="ws-body">${richData.body||''}</div>${calloutHtml}${examplesHtml}${noteHtml}`;
    } else {
      // Fallback: plain content
      const rawBody = section.content && section.content.body ? section.content.body : '';
      body = `<div class="ws-body"><p>${escapeHtml(rawBody)}</p></div>
      <div style="margin-top:14px;padding:13px 16px;background:rgba(0,167,225,.05);border-radius:9px;border:1px solid var(--line)">
        <p style="font-size:.83rem;color:var(--muted);margin:0;line-height:1.5">Apply this lesson's concepts in your next real or practice opportunity.</p>
      </div>`;
    }
  }

  const completeBtn = isDone
    ? `<div class="ws-done-badge">${SVG_CHECK} Section Complete</div>`
    : `<button class="ws-complete-btn" style="background:${phColor}" onclick="academyCompleteSection('${mod.id}','${section.id}')">Mark Section Complete ${SVG_ARROW}</button>`;

  const sectionIdx = mod.sections.findIndex(s => s.id === section.id);
  const nextSec = mod.sections[sectionIdx + 1];
  const nextHint = nextSec
    ? `<div style="margin-top:22px;padding:13px 16px;background:var(--card);border:1px solid var(--line);border-radius:9px;cursor:pointer;transition:border-color .15s" onclick="academyShowSection('${mod.id}','${nextSec.id}')" onmouseenter="this.style.borderColor='var(--blue)'" onmouseleave="this.style.borderColor='var(--line)'">
        <div style="font-size:.68rem;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;margin-bottom:3px">Up Next</div>
        <div style="color:var(--ink);font-size:.87rem;font-weight:600;display:flex;align-items:center;gap:6px">${escapeHtml(nextSec.title)} <span style="color:var(--blue)">${SVG_ARROW}</span></div>
      </div>`
    : '';

  return `
<div class="ws-section-type">${section.section_type.replace(/_/g,' ').toUpperCase()}</div>
<h2 class="ws-section-title">${escapeHtml(section.title)}</h2>
${body}
${completeBtn}
${nextHint}`;
}

// ─── Quiz Section Renderer ────────────────────────────────────────────────────
function renderQuizSection(mod, mp, repId, ph) {
  const quiz = mod.quiz;
  if (!quiz) return '<p style="color:var(--muted)">No quiz for this module.</p>';
  const phColor = ph ? ph.color : 'var(--blue)';
  const prevAttempts = window.Academy.getQuizAttempts(repId, quiz.id);
  const alreadyPassed = mp.quiz_passed;

  const attemptsHtml = prevAttempts.length > 0
    ? `<div class="prev-attempts-chip">${svgBadgeShape('check','var(--muted)',14)} ${prevAttempts.length} previous attempt${prevAttempts.length>1?'s':''} — Best: ${Math.max(...prevAttempts.map(a=>a.percent_score))}%</div>`
    : '';

  const questionsHtml = quiz.questions.map((q, qi) => `
<div class="quiz-q" id="qq_${q.id}">
  <div class="quiz-q-num">Question ${qi+1} of ${quiz.questions.length}</div>
  <div class="quiz-q-prompt">${escapeHtml(q.prompt)}</div>
  ${q.choices.map(ch => `
  <label class="quiz-choice" id="qc_${q.id}_${ch.value}" onclick="academySelectChoice('${q.id}','${ch.value}')">
    <input type="radio" name="q_${q.id}" value="${ch.value}">
    <span class="quiz-choice-text">${escapeHtml(ch.text)}</span>
  </label>`).join('')}
</div>`).join('');

  return `
<div class="ws-section-type">KNOWLEDGE CHECK</div>
<h2 class="ws-section-title">Module Quiz</h2>
<p style="color:var(--muted);font-size:.88rem;margin:0 0 14px">${quiz.questions.length} questions — ${quiz.pass_score}% required to pass.</p>
${attemptsHtml}
${alreadyPassed ? `<div class="ws-done-badge" style="margin-bottom:16px">${SVG_CHECK} Quiz Passed — ${mp.quiz_best_score}%</div>` : ''}
<div class="quiz-container" id="quiz-form-${quiz.id}">
  ${questionsHtml}
  <button class="quiz-submit-btn" id="quiz-submit-btn" onclick="academySubmitQuiz('${mod.id}','${quiz.id}','${repId}')">Submit Quiz</button>
</div>
<div id="quiz-result-area"></div>`;
}

// ─── Quiz Interaction Handlers ────────────────────────────────────────────────
window.academySelectChoice = function(questionId, value) {
  document.querySelectorAll(`[id^="qc_${questionId}_"]`).forEach(el => el.classList.remove('selected'));
  const chosen = document.getElementById(`qc_${questionId}_${value}`);
  if (chosen) chosen.classList.add('selected');
};

window.academyCompleteSection = function(moduleId, sectionId) {
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  const repId = rep ? rep.id : 'ryan';
  window.Academy.markSectionComplete(repId, moduleId, sectionId);

  const btn = document.querySelector('.ws-complete-btn');
  if (btn) btn.outerHTML = `<div class="ws-done-badge">${SVG_CHECK} Section Complete</div>`;

  const navDot = document.querySelector(`#ws-nav-${sectionId} .ws-nav-dot`);
  if (navDot) { navDot.classList.remove('active'); navDot.classList.add('done'); navDot.innerHTML = SVG_CHECK; }
  const navItem = document.getElementById(`ws-nav-${sectionId}`);
  if (navItem) navItem.classList.add('done-section');

  const mp = window.Academy.getModuleProgress(repId, moduleId);
  const pctEl = document.getElementById('ws-pct');
  const barEl = document.getElementById('ws-bar');
  if (pctEl) pctEl.textContent = mp.percent_complete + '%';
  if (barEl) barEl.style.width = mp.percent_complete + '%';

  const content = window.Academy.getContent();
  const mod = content.modules.find(m => m.id === moduleId);
  if (mod) {
    const idx = mod.sections.findIndex(s => s.id === sectionId);
    const next = mod.sections[idx + 1];
    if (next) setTimeout(() => window.academyShowSection(moduleId, next.id), 400);
  }
};

window.academySubmitQuiz = function(moduleId, quizId, repId) {
  const content = window.Academy.getContent();
  const mod = content.modules.find(m => m.id === moduleId);
  if (!mod) return;

  const answers = {};
  mod.quiz.questions.forEach(q => {
    const sel = document.querySelector(`input[name="q_${q.id}"]:checked`);
    if (sel) answers[q.id] = sel.value;
  });

  const unanswered = mod.quiz.questions.filter(q => !answers[q.id]);
  if (unanswered.length > 0) {
    showToast(`Please answer all ${unanswered.length} remaining question${unanswered.length>1?'s':''}.`);
    return;
  }

  const submitBtn = document.getElementById('quiz-submit-btn');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Scoring…'; }

  const result = window.Academy.submitQuizAttempt(repId, quizId, moduleId, answers);
  const resultArea = document.getElementById('quiz-result-area');
  const formEl = document.getElementById(`quiz-form-${quizId}`);

  // Apply correct/wrong styling — v2 schema: ch.correct (not ch.is_correct)
  if (formEl) {
    result.feedback.forEach(f => {
      mod.quiz.questions.forEach(q => {
        if (q.id !== f.questionId) return;
        q.choices.forEach(ch => {
          const el = document.getElementById(`qc_${q.id}_${ch.value}`);
          if (!el) return;
          if (ch.correct) el.classList.add('correct');
          else if (answers[q.id] === ch.value && !ch.correct) el.classList.add('wrong');
        });
      });
    });
    if (submitBtn) submitBtn.style.display = 'none';
  }

  const passed = result.passed;
  const score = result.percentScore;
  const passedCount = result.feedback.filter(f => f.correct).length;
  const totalCount = result.feedback.length;
  const ph = content.phases.find(p => p.id === mod.phase_id);

  if (resultArea) {
    resultArea.innerHTML = `
<div class="quiz-result ${passed ? 'pass' : 'fail'}">
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
    <div>${svgBadgeShape(passed?'check':'bolt', passed?'#2D7A55':'#8B3A2A', 40)}</div>
    <div>
      <div style="font-size:1.1rem;font-weight:700;color:${passed?'#2D7A55':'#8B3A2A'}">${passed ? 'Quiz Passed!' : 'Not quite yet'}</div>
      <div style="font-size:.85rem;color:var(--muted)">${score}% — ${passedCount} of ${totalCount} correct${passed ? ' — module progress updated.' : ` — ${mod.quiz.pass_score}% required.`}</div>
    </div>
  </div>
  ${result.feedback.map(f => {
    const q = mod.quiz.questions.find(qq => qq.id === f.questionId);
    return `<div class="quiz-feedback-item ${f.correct ? 'correct' : 'wrong'}">
      <div style="font-weight:700;font-size:.82rem;color:${f.correct?'#2D7A55':'#8B3A2A'};margin-bottom:3px">${f.correct ? 'Correct' : 'Incorrect'}</div>
      <div class="quiz-explanation">${escapeHtml(q && q.explanation ? q.explanation : '')}</div>
    </div>`;
  }).join('')}
  <div style="margin-top:14px">
    ${passed
      ? `<button class="ws-complete-btn" style="background:${ph?ph.color:'var(--blue)'}" onclick="show('academy','phase:${mod.phase_id}')">← Back to Phase Overview</button>`
      : `<button class="ws-complete-btn" style="background:var(--muted)" onclick="show('academy','module:${moduleId}')">Review &amp; Retry Quiz</button>`}
  </div>
</div>`;
  }
};

// ─── Badges View — SA-206 ─────────────────────────────────────────────────────
function academyBadgesView() {
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  const repId = rep ? rep.id : 'ryan';
  const rp = window.Academy.getRepProgress(repId);
  const lvlInfo = window.Academy.calcLevel(rp.points || 0);
  const earned = new Set(rp.badges || []);
  const earnedBadges = window.Academy.BADGE_DEFS.filter(b => earned.has(b.id));
  const lockedBadges = window.Academy.BADGE_DEFS.filter(b => !earned.has(b.id));
  const totalBadges = window.Academy.BADGE_DEFS.length;
  const earnedPct = Math.round((earnedBadges.length / totalBadges) * 100);

  const badgeCard = (b, isEarned) => `
  <article class="acad-badge-card ${isEarned ? 'earned' : 'locked'}" style="${isEarned ? `border-color:${b.color}44;background:${b.color}06` : ''}">
    <div style="display:flex;justify-content:center;margin-bottom:14px;position:relative">
      ${svgBadgeShape(b.shape, isEarned ? b.color : 'var(--muted)', 56)}
      ${isEarned ? `<div style="position:absolute;bottom:-4px;right:calc(50% - 28px - 4px);width:18px;height:18px;border-radius:50%;background:#2D7A55;border:2px solid var(--card);display:flex;align-items:center;justify-content:center;color:#fff">${SVG_CHECK}</div>` : ''}
    </div>
    <div style="font-weight:700;font-size:.92rem;color:${isEarned ? b.color : 'var(--muted)'};margin-bottom:5px;text-align:center">${escapeHtml(b.name)}</div>
    <div style="font-size:.76rem;color:var(--muted);line-height:1.5;text-align:center;margin-bottom:10px">${escapeHtml(b.desc)}</div>
    <div style="display:flex;justify-content:center">
      <span class="sa-chip" style="${isEarned ? `color:${b.color};border-color:${b.color}44;background:${b.color}10` : ''}">${b.type||'achievement'}</span>
    </div>
  </article>`;

  const emptyEarned = `
  <div class="acad-empty" style="grid-column:1/-1;padding:36px 20px">
    <div class="acad-empty-icon">${svgBadgeShape('bolt','var(--muted)',36)}</div>
    <div class="acad-empty-title">No badges earned yet</div>
    <div class="acad-empty-desc">Complete modules, pass quizzes, and maintain streaks to start earning badges.</div>
    <button class="sa-btn-primary" onclick="show('academy')">Go to Training</button>
  </div>`;

  view.innerHTML = ACAD_STYLES + `
<nav class="acad-breadcrumb">
  <span class="acad-breadcrumb-item" onclick="show('academy')" style="cursor:pointer">Academy</span>
  <span class="acad-breadcrumb-sep">›</span>
  <span class="acad-breadcrumb-current">Badges &amp; Achievements</span>
</nav>

<!-- Hero -->
<div class="acad-phase-hero" style="border-color:rgba(99,102,241,.2)">
  <div class="acad-phase-hero-bar" style="background:linear-gradient(90deg,#1A4740,#4D8A86)"></div>
  <div class="acad-phase-hero-inner">
    <div class="acad-phase-hero-icon">${svgBadgeShape('shield','#1A4740',48)}</div>
    <div class="acad-phase-hero-body">
      <div class="acad-phase-hero-eyebrow" style="color:#1A4740">Achievement Center</div>
      <h1 class="acad-phase-hero-title">Badges &amp; Achievements</h1>
      <p class="acad-phase-hero-desc">Earn badges by completing modules, passing quizzes, maintaining streaks, and reaching new levels.</p>
    </div>
  </div>
</div>

<!-- Progress summary -->
<div class="acad-progress-card" style="margin-bottom:28px">
  <div class="acad-progress-card-top">
    <div>
      <div class="acad-progress-card-label">Badge Collection</div>
      <div class="acad-progress-meta">${earnedBadges.length} of ${totalBadges} badges earned · Level: ${escapeHtml(lvlInfo ? lvlInfo.name : '—')}</div>
    </div>
    <div class="acad-progress-card-pct" style="color:#1A4740">${earnedPct}%</div>
  </div>
  <div class="acad-progress-bar">
    <div class="acad-progress-bar-fill" style="width:${earnedPct}%;background:linear-gradient(90deg,#1A4740,#4D8A86)"></div>
  </div>
</div>

${earnedBadges.length ? `
<div class="acad-sh">Earned Badges (${earnedBadges.length})</div>
<div class="acad-badges-grid" style="margin-bottom:32px">
  ${earnedBadges.map(b => badgeCard(b, true)).join('')}
</div>` : `<div class="acad-badges-grid" style="margin-bottom:32px">${emptyEarned}</div>`}

<div class="acad-sh">Locked Badges (${lockedBadges.length})</div>
<div class="acad-badges-grid">
  ${lockedBadges.map(b => badgeCard(b, false)).join('')}
</div>`;
}

// ─── Practice Arena — SA-104 ──────────────────────────────────────────────────
function academyPracticeArena() {
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  const repId = rep ? rep.id : 'ryan';
  const content = window.Academy.getContent();
  const rp = window.Academy.getRepProgress(repId);

  // Build drills from modules the rep has started or completed
  const allMods = content.modules || [];
  const availableMods = allMods.filter(m => !window.Academy.isModuleLocked(m.id, repId));
  const startedMods   = availableMods.filter(m => (rp.modules[m.id]||{}).status === 'in_progress');
  const completedMods = availableMods.filter(m => (rp.modules[m.id]||{}).status === 'completed');
  const notStarted    = availableMods.filter(m => !(rp.modules[m.id]||{}).status || (rp.modules[m.id]||{}).status === 'not_started');

  // Failed quizzes — prime retry candidates
  const failedQuizMods = completedMods.filter(m => {
    const mp = rp.modules[m.id] || {};
    return mp.quiz_best_score != null && !mp.quiz_passed;
  });

  // Featured mastery challenge — pick a completed module with the lowest quiz score
  const masteryCandidate = completedMods
    .filter(m => (rp.modules[m.id]||{}).quiz_best_score != null)
    .sort((a,b) => (rp.modules[a.id]||{}).quiz_best_score - (rp.modules[b.id]||{}).quiz_best_score)[0]
    || completedMods[0] || availableMods[0];

  const ph = masteryCandidate ? content.phases.find(p => p.id === masteryCandidate.phase_id) : null;
  const masteryScore = masteryCandidate ? ((rp.modules[masteryCandidate.id]||{}).quiz_best_score || 0) : 0;

  const SVG_LIGHTNING = `<svg width="18" height="18" viewBox="0 0 24 24" fill="#8B6914" stroke="none"><path d="M13 2L4.5 13.5H11L10 22L20.5 10H14L13 2Z"/></svg>`;
  const SVG_REPEAT    = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`;
  const SVG_BOOK      = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`;

  // Practice items from started/unlocked modules
  const practiceItems = [...startedMods, ...notStarted.slice(0, 3)].slice(0, 6).map(m => {
    const mp  = rp.modules[m.id] || {};
    const mph = content.phases.find(p => p.id === m.phase_id);
    const pct = mp.percent_complete || 0;
    const isInProg = mp.status === 'in_progress';
    return `<div class="acad-practice-item" onclick="show('academy','module:${m.id}')">
      <div class="acad-practice-item-icon" style="background:${mph ? mph.color : 'var(--blue)'}18;color:${mph ? mph.color : 'var(--blue)'}">${svgPhaseIcon(mph ? mph.sort_order : 1, mph ? mph.color : 'var(--blue)', 22)}</div>
      <div class="acad-practice-item-body">
        <div class="acad-practice-item-title">${escapeHtml(m.title)}</div>
        <div class="acad-practice-item-meta">
          <span class="sa-chip ${isInProg ? 'sa-chip-in-progress' : 'sa-chip-not-started'}">${isInProg ? SVG_PLAY+' Resume' : 'Start'}</span>
          <span class="sa-chip">~${m.estimated_minutes||'?'} min</span>
          ${pct > 0 ? `<span class="sa-chip">${pct}% done</span>` : ''}
        </div>
      </div>
      <div style="color:var(--blue);flex-shrink:0">${SVG_ARROW}</div>
    </div>`;
  }).join('');

  // Retry candidates
  const retryItems = failedQuizMods.slice(0, 4).map(m => {
    const mp  = rp.modules[m.id] || {};
    const mph = content.phases.find(p => p.id === m.phase_id);
    return `<div class="acad-practice-item" onclick="show('academy','module:${m.id}')">
      <div class="acad-practice-item-icon" style="background:rgba(239,68,68,.08);color:#8B3A2A">${SVG_REPEAT}</div>
      <div class="acad-practice-item-body">
        <div class="acad-practice-item-title">Retry Quiz — ${escapeHtml(m.title)}</div>
        <div class="acad-practice-item-meta">
          <span class="sa-chip" style="color:#8B3A2A;border-color:rgba(239,68,68,.3);background:rgba(239,68,68,.07)">Best: ${mp.quiz_best_score}%</span>
          <span class="sa-chip">${mp.quiz_passed?'Passed':'Not Passed'}</span>
        </div>
      </div>
      <div style="color:var(--blue);flex-shrink:0">${SVG_ARROW}</div>
    </div>`;
  }).join('');

  const noItems = `<div class="acad-empty">
    <div class="acad-empty-icon">${SVG_BOOK}</div>
    <div class="acad-empty-title">Nothing to practice yet</div>
    <div class="acad-empty-desc">Start your first module to unlock practice drills here.</div>
    <button class="sa-btn-primary" onclick="show('academy')">Go to Training</button>
  </div>`;

  view.innerHTML = ACAD_STYLES + `
<nav class="acad-breadcrumb">
  <span class="acad-breadcrumb-item" onclick="show('academy')" style="cursor:pointer">Academy</span>
  <span class="acad-breadcrumb-sep">›</span>
  <span class="acad-breadcrumb-current">Practice Arena</span>
</nav>

<!-- SA-201-style hero -->
<div class="acad-phase-hero" style="border-color:rgba(245,158,11,.25)">
  <div class="acad-phase-hero-bar" style="background:linear-gradient(90deg,#8B6914,#8B6914)"></div>
  <div class="acad-phase-hero-inner">
    <div class="acad-phase-hero-icon">${SVG_LIGHTNING}</div>
    <div class="acad-phase-hero-body">
      <div class="acad-phase-hero-eyebrow" style="color:#8B6914">Skill Building</div>
      <h1 class="acad-phase-hero-title">Practice Arena</h1>
      <p class="acad-phase-hero-desc">Sharpen your skills with drills, quiz retries, and mastery challenges. Focus on the areas that move your numbers.</p>
    </div>
  </div>
</div>

${masteryCandidate ? `
<!-- Mastery Challenge Banner -->
<div class="acad-practice-challenge">
  <div class="acad-practice-challenge-icon" style="background:linear-gradient(135deg,#8B6914,#8B6914)">${SVG_LIGHTNING}</div>
  <div class="acad-practice-challenge-body">
    <div class="acad-practice-challenge-title">
      Mastery Challenge
      <span class="sa-chip" style="background:rgba(245,158,11,.12);color:#8B6914;border-color:rgba(245,158,11,.3);font-size:.68rem">${masteryScore > 0 ? `Best: ${masteryScore}%` : 'Not attempted'}</span>
    </div>
    <div class="acad-practice-challenge-sub">${escapeHtml(masteryCandidate.title)} — ${escapeHtml(masteryCandidate.short_description||'')}</div>
    <div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap">
      <button class="sa-btn-primary" style="background:#8B6914" onclick="show('academy','module:${masteryCandidate.id}')">
        ${masteryScore > 0 ? 'Retry Challenge' : 'Start Challenge'} ${SVG_ARROW}
      </button>
      ${ph ? `<button class="sa-btn-ghost" onclick="show('academy','phase:${ph.id}')">View Phase</button>` : ''}
    </div>
  </div>
</div>` : ''}

<div class="acad-home-grid" style="margin-top:0">
  <div class="acad-home-main">
    <div class="acad-sh">Continue Practicing</div>
    <div style="display:flex;flex-direction:column;gap:10px;margin-top:4px">
      ${practiceItems || noItems}
    </div>
  </div>
  <div class="acad-home-sidebar">
    ${failedQuizMods.length ? `
    <div class="acad-sidebar-card">
      <div class="acad-sidebar-card-head">
        <span style="font-size:.78rem;font-weight:700;color:#8B3A2A">Quiz Retries</span>
        <span class="sa-chip" style="color:#8B3A2A;border-color:rgba(239,68,68,.3);background:rgba(239,68,68,.07)">${failedQuizMods.length}</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:2px">
        ${retryItems}
      </div>
    </div>` : ''}
    <div class="acad-sidebar-card">
      <div class="acad-sidebar-card-head">
        <span style="font-size:.78rem;font-weight:700;color:var(--ink)">Quick Links</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:4px">
        <button class="sa-btn-ghost" style="width:100%;justify-content:flex-start" onclick="show('academy')">← Academy Home</button>
        <button class="sa-btn-ghost" style="width:100%;justify-content:flex-start" onclick="show('academy','badges')">gwIcon('badge',16) Badges &amp; Achievements</button>
        <button class="sa-btn-ghost" style="width:100%;justify-content:flex-start" onclick="show('academy','certifications')">gwIcon('academy',16) Certifications</button>
        <button class="sa-btn-ghost" style="width:100%;justify-content:flex-start" onclick="show('academy','profile')">gwIcon('user',16) My Progress Profile</button>
      </div>
    </div>
  </div>
</div>`;
}

// ─── Rep Profile — SA-403 ─────────────────────────────────────────────────────
function academyRepProfile() {
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  const repId = rep ? rep.id : 'ryan';
  const rp = window.Academy.getRepProgress(repId);
  const content = window.Academy.getContent();

  const allMods = content.modules || [];
  const completedMods = allMods.filter(m => (rp.modules[m.id]||{}).status === 'completed').length;
  const inProgMods    = allMods.filter(m => (rp.modules[m.id]||{}).status === 'in_progress').length;
  const totalMods     = allMods.length;
  const overallPct    = totalMods ? Math.round((completedMods / totalMods) * 100) : 0;

  const lvlInfo  = window.Academy.calcLevel(rp.points || 0);
  const nextLvl  = window.Academy.nextLevel(rp.points || 0);
  const nextPts  = nextLvl ? nextLvl.min_points : null;
  const currPts  = rp.points || 0;
  const lvlFloor = lvlInfo ? lvlInfo.min_points : 0;
  const lvlRange = nextPts ? nextPts - lvlFloor : 500;
  const lvlPct   = nextPts ? Math.min(100, Math.round(((currPts - lvlFloor) / lvlRange) * 100)) : 100;
  const lvlColor = lvlInfo ? lvlInfo.color : 'var(--blue)';

  const earned = new Set(rp.badges || []);
  const earnedBadges = window.Academy.BADGE_DEFS.filter(b => earned.has(b.id));
  const nextBadges   = window.Academy.BADGE_DEFS.filter(b => !earned.has(b.id)).slice(0, 3);

  // Quiz performance across all attempted modules
  const quizAttemptedMods = allMods.filter(m => (rp.modules[m.id]||{}).quiz_best_score != null);
  const quizAvg = quizAttemptedMods.length
    ? Math.round(quizAttemptedMods.reduce((s,m)=>s+(rp.modules[m.id].quiz_best_score||0),0)/quizAttemptedMods.length)
    : null;

  // Recent achievements
  const recentEvents = (rp.events || []).slice(-5).reverse();

  // Phase progress
  const phaseProgress = (content.phases||[]).map(ph => {
    const phMods = allMods.filter(m => m.phase_id === ph.id);
    const phDone = phMods.filter(m => (rp.modules[m.id]||{}).status === 'completed').length;
    const phPct  = phMods.length ? Math.round((phDone / phMods.length) * 100) : 0;
    return { ph, phDone, phTotal: phMods.length, phPct };
  });

  // Avatar initials
  const repName = rep && rep.name ? rep.name : 'Rep';
  const initials = repName.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2);

  const SVG_STAR = `<svg width="14" height="14" viewBox="0 0 24 24" fill="#8B6914" stroke="none"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;

  view.innerHTML = ACAD_STYLES + `
<nav class="acad-breadcrumb">
  <span class="acad-breadcrumb-item" onclick="show('academy')" style="cursor:pointer">Academy</span>
  <span class="acad-breadcrumb-sep">›</span>
  <span class="acad-breadcrumb-current">My Profile</span>
</nav>

<!-- Profile Hero -->
<div class="acad-profile-hero">
  <div class="acad-profile-avatar" style="background:linear-gradient(135deg,${lvlColor},${lvlColor}99)">${initials}</div>
  <div class="acad-profile-body">
    <div class="acad-profile-name">${escapeHtml(repName)}</div>
    <div class="acad-profile-level">
      ${svgLevelIcon(lvlInfo ? lvlInfo.id : 'rookie', lvlColor, 18)}
      <span style="color:${lvlColor};font-weight:700">${lvlInfo ? escapeHtml(lvlInfo.name) : 'Rookie'}</span>
      ${rp.streak_days > 0 ? `<span class="acad-streak-badge" style="font-size:.75rem;padding:3px 10px">${rp.streak_days}-day streak gwIcon('streak',16)</span>` : ''}
    </div>
    <div class="acad-profile-stats">
      <div class="acad-profile-stat">
        <div class="acad-profile-stat-num" style="color:${lvlColor}">${currPts.toLocaleString()}</div>
        <div class="acad-profile-stat-label">Points</div>
      </div>
      <div class="acad-profile-stat">
        <div class="acad-profile-stat-num">${completedMods}</div>
        <div class="acad-profile-stat-label">Modules Done</div>
      </div>
      <div class="acad-profile-stat">
        <div class="acad-profile-stat-num">${earnedBadges.length}</div>
        <div class="acad-profile-stat-label">Badges</div>
      </div>
      <div class="acad-profile-stat">
        <div class="acad-profile-stat-num" style="color:${quizAvg!=null?(quizAvg>=75?'#2D7A55':'#8B3A2A'):'var(--muted)'}">${quizAvg != null ? quizAvg+'%' : '—'}</div>
        <div class="acad-profile-stat-label">Quiz Avg</div>
      </div>
    </div>
  </div>
</div>

<!-- Level Progress -->
<div class="acad-progress-card" style="margin-bottom:24px">
  <div class="acad-progress-card-top">
    <div>
      <div class="acad-progress-card-label">Level Progress — ${lvlInfo ? escapeHtml(lvlInfo.name) : 'Rookie'}</div>
      <div class="acad-progress-meta">${currPts.toLocaleString()} pts${nextPts ? ` · ${(nextPts - currPts).toLocaleString()} to ${escapeHtml(nextLvl.name)}` : ' · Max level reached'}</div>
    </div>
    <div class="acad-progress-card-pct" style="color:${lvlColor}">${lvlPct}%</div>
  </div>
  <div class="acad-progress-bar">
    <div class="acad-progress-bar-fill" style="width:${lvlPct}%;background:${lvlColor}"></div>
  </div>
</div>

<div class="acad-home-grid">
  <div class="acad-home-main">
    <!-- Overall completion -->
    <div class="acad-progress-card" style="margin-bottom:20px">
      <div class="acad-progress-card-top">
        <div>
          <div class="acad-progress-card-label">Academy Completion</div>
          <div class="acad-progress-meta">${completedMods} of ${totalMods} modules · ${inProgMods > 0 ? `${inProgMods} in progress` : 'none in progress'}</div>
        </div>
        <div class="acad-progress-card-pct" style="color:var(--blue)">${overallPct}%</div>
      </div>
      <div class="acad-progress-bar">
        <div class="acad-progress-bar-fill" style="width:${overallPct}%;background:var(--blue)"></div>
      </div>
    </div>

    <!-- Phase breakdown -->
    <div class="acad-sh">Phase Progress</div>
    <div style="display:flex;flex-direction:column;gap:10px;margin-top:4px">
      ${phaseProgress.map(({ph, phDone, phTotal, phPct}) => `
      <div class="acad-sidebar-card" style="cursor:pointer" onclick="show('academy','phase:${ph.id}')">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          ${svgPhaseIcon(ph.sort_order, ph.color, 28)}
          <div style="flex:1">
            <div style="font-size:.88rem;font-weight:700;color:var(--ink)">${escapeHtml(ph.title)}</div>
            <div style="font-size:.73rem;color:var(--muted)">${phDone} of ${phTotal} modules</div>
          </div>
          <span class="sa-chip" style="color:${ph.color};border-color:${ph.color}44;background:${ph.color}10">${phPct}%</span>
          <div style="color:var(--blue);flex-shrink:0">${SVG_ARROW}</div>
        </div>
        <div class="acad-progress-bar" style="margin-top:0">
          <div class="acad-progress-bar-fill" style="width:${phPct}%;background:${ph.color}"></div>
        </div>
      </div>`).join('')}
    </div>
  </div>

  <div class="acad-home-sidebar">
    <!-- Earned badges -->
    <div class="acad-sidebar-card">
      <div class="acad-sidebar-card-head">
        <span style="font-size:.78rem;font-weight:700;color:var(--ink)">Earned Badges</span>
        <button class="sa-btn-ghost" style="font-size:.72rem;padding:2px 8px" onclick="show('academy','badges')">View All</button>
      </div>
      ${earnedBadges.length ? earnedBadges.slice(0,5).map(b => `
      <div class="acad-badge-row">
        <div>${svgBadgeShape(b.shape, b.color, 28)}</div>
        <div class="acad-badge-row-text">
          <div class="acad-badge-row-name" style="color:${b.color}">${escapeHtml(b.name)}</div>
          <div class="acad-badge-row-desc">${escapeHtml(b.desc)}</div>
        </div>
      </div>`).join('') : `<p style="font-size:.82rem;color:var(--muted);margin:8px 0 0">No badges yet. Keep training!</p>`}
    </div>

    <!-- Next badges -->
    ${nextBadges.length ? `
    <div class="acad-sidebar-card">
      <div class="acad-sidebar-card-head">
        <span style="font-size:.78rem;font-weight:700;color:var(--ink)">Up Next — Badges</span>
      </div>
      ${nextBadges.map(b => `
      <div class="acad-badge-row" style="opacity:.6">
        <div>${svgBadgeShape(b.shape, 'var(--muted)', 28)}</div>
        <div class="acad-badge-row-text">
          <div class="acad-badge-row-name">${escapeHtml(b.name)}</div>
          <div class="acad-badge-row-desc">${escapeHtml(b.desc)}</div>
        </div>
        <div>${SVG_LOCK}</div>
      </div>`).join('')}
    </div>` : ''}

    <!-- Quick nav -->
    <div class="acad-sidebar-card">
      <div class="acad-sidebar-card-head"><span style="font-size:.78rem;font-weight:700;color:var(--ink)">Quick Links</span></div>
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:4px">
        <button class="sa-btn-ghost" style="width:100%;justify-content:flex-start" onclick="show('academy')">← Academy Home</button>
        <button class="sa-btn-ghost" style="width:100%;justify-content:flex-start" onclick="show('academy','practice')">gwIcon('streak',16) Practice Arena</button>
        <button class="sa-btn-ghost" style="width:100%;justify-content:flex-start" onclick="show('academy','certifications')">gwIcon('academy',16) Certifications</button>
      </div>
    </div>
  </div>
</div>`;
}

// ─── Certifications Page — SA-105 ─────────────────────────────────────────────
function academyCertificationsPage() {
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  const repId = rep ? rep.id : 'ryan';
  const content = window.Academy.getContent();
  const rp = window.Academy.getRepProgress(repId);
  const allMods = content.modules || [];

  const CERT_KEY = 'avalonAcademyCerts';
  function loadCerts() { try { return JSON.parse(localStorage.getItem(CERT_KEY)||'{}'); } catch(e){ return {}; } }
  const certs = loadCerts();
  const repCerts = certs[repId] || {};

  const SVG_CERT_ICON = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="6"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/><path d="M8 21l4-2 4 2v-6H8z"/></svg>`;
  const SVG_SCROLL    = `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`;

  function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' });
  }

  const certCards = (content.phases || []).map(ph => {
    const phMods    = allMods.filter(m => ph.module_ids && ph.module_ids.includes(m.id));
    const doneCount = phMods.filter(m => (rp.modules[m.id]||{}).status === 'completed').length;
    const pct       = phMods.length ? Math.round((doneCount / phMods.length) * 100) : 0;
    const certData  = repCerts[ph.id] || null;
    const isEarned  = !!certData;
    const allDone   = doneCount === phMods.length && phMods.length > 0;
    const certName  = ph.certification_name || `${ph.title} Certification`;

    let statusBadge, ctaHtml;
    if (isEarned) {
      statusBadge = `<span class="sa-chip sa-chip-certified">${SVG_CHECK} Certified</span>`;
      ctaHtml = `
        <div style="margin-top:14px;padding:12px 16px;background:rgba(16,185,129,.05);border:1px solid rgba(16,185,129,.2);border-radius:10px">
          <div style="font-size:.78rem;color:#2D7A55;font-weight:700;margin-bottom:2px">${SVG_CHECK} Certification Awarded</div>
          <div style="font-size:.75rem;color:var(--muted)">${fmtDate(certData.at)} · Verified by ${escapeHtml(certData.by||'Admin')}</div>
        </div>`;
    } else if (allDone) {
      statusBadge = `<span class="sa-chip" style="color:#8B6914;border-color:rgba(245,158,11,.3);background:rgba(245,158,11,.08)">Ready for Review</span>`;
      ctaHtml = `
        <div style="margin-top:14px;padding:12px 16px;background:rgba(245,158,11,.05);border:1px solid rgba(245,158,11,.2);border-radius:10px">
          <div style="font-size:.78rem;color:#8B6914;font-weight:700;margin-bottom:2px">⏳ Awaiting Admin Certification</div>
          <div style="font-size:.75rem;color:var(--muted)">All modules complete — your manager or admin will issue this certification.</div>
        </div>`;
    } else {
      statusBadge = pct > 0
        ? `<span class="sa-chip sa-chip-in-progress">${SVG_PLAY} In Progress</span>`
        : `<span class="sa-chip sa-chip-not-started">Not Started</span>`;
      ctaHtml = `
        <div style="margin-top:14px">
          <button class="sa-btn-primary" style="background:${ph.color}" onclick="show('academy','phase:${ph.id}')">
            ${pct > 0 ? 'Continue Phase' : 'Start Phase'} ${SVG_ARROW}
          </button>
        </div>`;
    }

    return `<div class="acad-sidebar-card" style="${isEarned ? `border-color:rgba(16,185,129,.3);background:rgba(16,185,129,.02)` : ''}padding:20px">
      <div style="display:flex;align-items:flex-start;gap:14px">
        <div style="width:52px;height:52px;border-radius:14px;background:${ph.color}18;border:1.5px solid ${ph.color}44;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:${ph.color}">
          ${svgPhaseIcon(ph.sort_order, ph.color, 28)}
        </div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">
            <div style="font-size:.72rem;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:${ph.color}">Phase ${ph.sort_order}</div>
            ${statusBadge}
          </div>
          <div style="font-weight:700;font-size:1rem;color:var(--ink);margin-bottom:4px">${escapeHtml(certName)}</div>
          <div style="font-size:.82rem;color:var(--muted);line-height:1.5;margin-bottom:10px">${escapeHtml(ph.long_description||ph.description||'')}</div>
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
            <div style="flex:1">
              <div class="acad-progress-bar" style="height:6px">
                <div class="acad-progress-bar-fill" style="width:${pct}%;background:${isEarned?'#2D7A55':ph.color}"></div>
              </div>
            </div>
            <span style="font-size:.78rem;font-weight:700;color:${isEarned?'#2D7A55':ph.color};white-space:nowrap">${doneCount}/${phMods.length} modules</span>
          </div>
          ${ctaHtml}
        </div>
      </div>
    </div>`;
  }).join('');

  const earnedCount = Object.keys(repCerts).length;

  view.innerHTML = ACAD_STYLES + `
<nav class="acad-breadcrumb">
  <span class="acad-breadcrumb-item" onclick="show('academy')" style="cursor:pointer">Academy</span>
  <span class="acad-breadcrumb-sep">›</span>
  <span class="acad-breadcrumb-current">Certifications</span>
</nav>

<div class="acad-phase-hero" style="border-color:rgba(245,158,11,.25)">
  <div class="acad-phase-hero-bar" style="background:linear-gradient(90deg,#8B6914,#2D7A55)"></div>
  <div class="acad-phase-hero-inner">
    <div class="acad-phase-hero-icon" style="color:#8B6914">${SVG_CERT_ICON}</div>
    <div class="acad-phase-hero-body">
      <div class="acad-phase-hero-eyebrow" style="color:#8B6914">Achievement Record</div>
      <h1 class="acad-phase-hero-title">Certifications</h1>
      <p class="acad-phase-hero-desc">Complete each phase and earn your certification. Certifications are issued by your manager or admin upon phase completion.</p>
    </div>
  </div>
</div>

<!-- Summary progress -->
<div class="acad-progress-card" style="margin-bottom:28px">
  <div class="acad-progress-card-top">
    <div>
      <div class="acad-progress-card-label">Certification Progress</div>
      <div class="acad-progress-meta">${earnedCount} of ${(content.phases||[]).length} certifications earned</div>
    </div>
    <div class="acad-progress-card-pct" style="color:#8B6914">${(content.phases||[]).length ? Math.round((earnedCount/(content.phases||[]).length)*100) : 0}%</div>
  </div>
  <div class="acad-progress-bar">
    <div class="acad-progress-bar-fill" style="width:${(content.phases||[]).length ? Math.round((earnedCount/(content.phases||[]).length)*100) : 0}%;background:linear-gradient(90deg,#8B6914,#2D7A55)"></div>
  </div>
</div>

<div class="acad-sh">Phase Certifications</div>
<div style="display:flex;flex-direction:column;gap:16px;margin-top:4px">
  ${certCards || `<div class="acad-empty"><div class="acad-empty-icon">${SVG_SCROLL}</div><div class="acad-empty-title">No certifications available</div><div class="acad-empty-desc">Complete the available phases to unlock certification tracks.</div></div>`}
</div>

<div style="margin-top:24px;padding:16px 20px;background:rgba(99,102,241,.04);border:1px solid rgba(99,102,241,.15);border-radius:12px">
  <div style="font-size:.8rem;font-weight:700;color:#1A4740;margin-bottom:6px">${SVG_CERT_ICON} How Certifications Work</div>
  <div style="font-size:.82rem;color:var(--muted);display:grid;gap:5px">
    <div>1. Complete all modules in a phase</div>
    <div>2. Your status changes to "Ready for Review"</div>
    <div>3. Your manager or admin issues your certification</div>
    <div>4. The certification is permanently stamped with the date and issuer</div>
  </div>
</div>`;
}

// ─── Admin Progress Dashboard ─────────────────────────────────────────────────
function academyAdminDashboard() {
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  if (!rep || rep.role !== 'admin') {
    view.innerHTML = `<div class="card"><p style="color:var(--muted)">Admin access required.</p></div>`;
    return;
  }

  const allReps   = window.Academy.getAllRepsProgress();
  const content   = window.Academy.getContent();
  const avgPct    = allReps.length ? Math.round(allReps.reduce((s,r)=>s+r.pct,0)/allReps.length) : 0;
  const totalQuizAvgs = allReps.filter(r=>r.quizAvg!=null);
  const teamQuizAvg   = totalQuizAvgs.length ? Math.round(totalQuizAvgs.reduce((s,r)=>s+r.quizAvg,0)/totalQuizAvgs.length) : null;
  const activeStreaks  = allReps.filter(r=>(r.streak||0)>0).length;
  const CERT_KEY  = 'avalonAcademyCerts';

  function loadCerts() { try { return JSON.parse(localStorage.getItem(CERT_KEY)||'{}'); } catch(e){ return {}; } }
  function saveCerts(d) { localStorage.setItem(CERT_KEY, JSON.stringify(d)); }
  function loadNote(repId) { return localStorage.getItem('acad_admin_note_'+repId) || ''; }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' });
  }
  function fmtRelative(iso) {
    if (!iso) return 'Never';
    const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return diff+'d ago';
  }
  function truncate(str, n) { return str && str.length > n ? str.slice(0,n)+'…' : (str||''); }

  const SVG_FLAME = `<svg width="13" height="13" viewBox="0 0 24 24" fill="#8B6914" stroke="none"><path d="M12 2C8 7 6 10 6 14a6 6 0 0 0 12 0c0-4-2-7-6-12zM9.5 17c-.3-1.2.5-2.4 2.5-3-.5 1.5.2 2.5 1 3 .3-1 1-1.8 1-3 1 .8 1.5 2 1 3a4 4 0 0 1-5.5 0z"/></svg>`;
  const SVG_CERT  = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8B6914" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="6"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/><path d="M8 21l4-2 4 2v-6H8z"/></svg>`;
  const SVG_BULK  = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/><polyline points="20 12 9 23 4 18"/></svg>`;

  const certs = loadCerts();

  // Build phase rows with Certify + Bulk Complete controls
  const phaseRows = content.phases.map(ph => {
    const phMods = content.modules.filter(m => ph.module_ids.includes(m.id));
    const certRow = allReps.map(r => {
      const isCert = !!(certs[r.rep.id] && certs[r.rep.id][ph.id]);
      const certData = isCert ? certs[r.rep.id][ph.id] : null;
      const allDone = phMods.every(m => (r.moduleDetail[m.id]||{}).status === 'completed');
      return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)">
        <div style="width:110px;font-size:.8rem;font-weight:600;color:var(--ink)">${escapeHtml(r.rep.name)}</div>
        <div style="flex:1">
          ${isCert
            ? `<span style="font-size:.75rem;color:#8B6914;font-weight:600">${SVG_CERT} Certified ${fmtDate(certData.at)} by ${escapeHtml(certData.by)}</span>`
            : (allDone
                ? `<button class="admin-action-btn" style="background:rgba(245,158,11,.12);color:#8B6914;border-color:rgba(245,158,11,.35)" onclick="academyAdminCertifyPhase('${r.rep.id}','${ph.id}','${escapeHtml(r.rep.name)}','${escapeHtml(ph.certification_name||ph.title)}')">${SVG_CERT} Certify ${escapeHtml(ph.certification_name||ph.title)}</button>`
                : `<span style="font-size:.75rem;color:var(--muted)">Modules not yet complete</span>`
              )
          }
        </div>
        <button class="admin-action-btn" style="font-size:.72rem" onclick="academyAdminBulkPhase('${r.rep.id}','${ph.id}','${escapeHtml(r.rep.name)}','${escapeHtml(ph.title)}')">${SVG_BULK} Bulk Complete ${escapeHtml(ph.title)}</button>
      </div>`;
    }).join('');

    return `<details style="margin-bottom:10px;border:1px solid ${ph.borderColor||'var(--line)'};border-radius:10px;overflow:hidden">
      <summary style="cursor:pointer;padding:12px 16px;background:${ph.color}0d;display:flex;align-items:center;gap:10px;list-style:none;user-select:none">
        <span style="width:10px;height:10px;border-radius:50%;background:${ph.color};display:inline-block;flex-shrink:0"></span>
        <span style="font-weight:700;color:var(--ink);flex:1">${escapeHtml(ph.title)} Phase</span>
        <span style="font-size:.72rem;color:var(--muted)">${ph.module_ids.join(', ')} · click to expand</span>
      </summary>
      <div style="padding:12px 16px;background:#fff">
        <div style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:8px">Certifications &amp; Bulk Actions</div>
        ${certRow}
      </div>
    </details>`;
  }).join('');

  // Per-rep expandable cards
  const repCards = allReps.map(r => {
    const rp = window.Academy.getRepProgress(r.rep.id);
    const note = loadNote(r.rep.id);
    const streak = r.streak || 0;
    const streakChip = streak > 0
      ? `<span style="display:inline-flex;align-items:center;gap:3px;font-size:.72rem;font-weight:600;color:#8B6914;background:rgba(139,105,20,.10);border:1px solid rgba(139,105,20,.3);border-radius:99px;padding:2px 8px">${SVG_FLAME}${streak}-day streak</span>`
      : '';

    // Module cells — clickable for quiz drill-down
    const modCells = content.modules.map(m => {
      const md   = r.moduleDetail[m.id] || {};
      const ms   = md.status || 'not_started';
      const qScore = md.quiz_best;
      const isComp   = ms === 'completed';
      const isInProg = ms === 'in_progress';
      const hasAttempts = (md.quiz_attempts||0) > 0;
      return `<div class="admin-mod-cell${isComp ? ' completed' : isInProg ? ' in-progress' : ''}"
        style="cursor:${hasAttempts?'pointer':'default'}"
        onclick="${hasAttempts ? `academyAdminShowQuizDrill('${r.rep.id}','${m.id}')` : ''}"
        title="${escapeHtml(m.title)} — ${ms}${qScore!=null?' | Quiz: '+qScore+'%':''}${hasAttempts?' | Click for quiz detail':''}">
        <div style="font-size:.68rem;font-weight:700;color:inherit">${m.id}</div>
        <div style="margin-top:3px">${isComp ? SVG_CHECK : isInProg ? SVG_PLAY : '–'}</div>
        ${qScore != null ? `<div style="font-size:.6rem;margin-top:2px;color:${isComp&&qScore>=75?'#2D7A55':'var(--muted)'}">${qScore}%</div>` : ''}
      </div>`;
    }).join('');

    // Mark complete buttons — full module title
    const markBtns = content.modules
      .filter(m => (r.moduleDetail[m.id]||{}).status !== 'completed')
      .map(m => {
        const label = m.id + ': ' + truncate(m.title, 22);
        return `<button class="admin-action-btn" onclick="academyAdminMarkModule('${r.rep.id}','${m.id}','${escapeHtml(m.title)}')" title="Mark complete: ${escapeHtml(m.title)}">${SVG_CHECK} ${escapeHtml(label)}</button>`;
      }).join(' ');

    return `<div class="admin-rep-card">
      <div class="admin-rep-header" onclick="toggleAdminRepDetail('${r.rep.id}')">
        <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0">
          <div>
            <div style="font-weight:700;color:var(--ink)">${escapeHtml(r.rep.name)}</div>
            <div style="font-size:.72rem;color:var(--muted);text-transform:capitalize">${r.rep.role}</div>
          </div>
          <div style="flex:1;min-width:120px;max-width:220px">
            <div style="height:6px;background:var(--line);border-radius:4px;overflow:hidden">
              <div style="height:100%;width:${r.pct}%;background:${r.pct===100?'#2D7A55':'var(--blue)'};border-radius:4px;transition:width .5s"></div>
            </div>
            <div style="font-size:.7rem;color:var(--muted);margin-top:3px">${r.completedMods}/${r.totalMods} modules</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          ${streakChip}
          <div style="text-align:center">
            <div style="font-size:.72rem;color:var(--muted)">${fmtRelative(r.last_activity)}</div>
            <div style="font-size:.6rem;color:var(--muted)">last active</div>
          </div>
          <div style="text-align:center">
            <div style="font-size:1.1rem;font-weight:700;color:${r.pct===100?'#2D7A55':'var(--ink)'}">${r.pct}%</div>
            <div style="font-size:.65rem;color:var(--muted)">done</div>
          </div>
          <div style="text-align:center">
            <div style="font-size:1.1rem;font-weight:700;color:var(--ink)">${r.points}</div>
            <div style="font-size:.65rem;color:var(--muted)">pts</div>
          </div>
          <div style="text-align:center">
            <span style="font-size:.78rem;font-weight:600;padding:3px 10px;border-radius:99px;background:${r.level.color}18;color:${r.level.color};border:1px solid ${r.level.color}44">${escapeHtml(r.level.name)}</span>
          </div>
          <div style="text-align:center">
            <div style="font-size:1rem;font-weight:700;color:${r.quizAvg!=null?(r.quizAvg>=75?'#2D7A55':'#8B3A2A'):'var(--muted)'}">${r.quizAvg != null ? r.quizAvg+'%' : '—'}</div>
            <div style="font-size:.65rem;color:var(--muted)">quiz avg</div>
          </div>
          <div style="color:var(--muted);font-size:.8rem">${SVG_ARROW}</div>
        </div>
      </div>

      <div id="rep-detail-${r.rep.id}" style="display:none">
        <!-- Module matrix -->
        <div class="admin-mod-matrix">
          <div style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);padding:12px 0 4px">Module Status — click a cell with quiz data for drill-down</div>
          <div style="display:flex;flex-wrap:wrap">${modCells}</div>
        </div>

        <!-- Quiz drill-down panel (hidden until cell clicked) -->
        <div id="quiz-drill-${r.rep.id}" style="display:none;padding:12px 16px;background:#FDFCF9;border-top:1px solid var(--line)"></div>

        <!-- Mark complete buttons -->
        <div style="padding:10px 16px;border-top:1px solid var(--line);display:flex;flex-wrap:wrap;gap:8px;align-items:center">
          <span style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-right:4px">Mark Complete:</span>
          ${markBtns || `<span style="font-size:.8rem;color:#2D7A55">${SVG_CHECK} All modules complete</span>`}
        </div>

        <!-- Coaching notes -->
        <div style="padding:10px 16px;border-top:1px solid var(--line)">
          <div style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:6px">${SVG_NOTE} Coaching Notes (private, admin only)</div>
          <textarea
            id="note-${r.rep.id}"
            rows="3"
            placeholder="Add private coaching notes for ${escapeHtml(r.rep.name)}…"
            style="width:100%;box-sizing:border-box;font-size:.83rem;border:1px solid var(--line);border-radius:8px;padding:8px 10px;color:var(--ink);resize:vertical;font-family:inherit"
            oninput="localStorage.setItem('acad_admin_note_${r.rep.id}',this.value)"
          >${escapeHtml(note)}</textarea>
        </div>

        <!-- Danger zone -->
        <div style="padding:10px 16px 14px;border-top:1px solid var(--line);display:flex;flex-wrap:wrap;gap:8px;align-items:center">
          <span style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#8B3A2A;margin-right:4px">Danger:</span>
          <button class="admin-action-btn danger" onclick="academyAdminResetRep('${r.rep.id}','${escapeHtml(r.rep.name)}')">Reset All Progress</button>
        </div>
      </div>
    </div>`;
  }).join('');

  view.innerHTML = ACAD_STYLES + `
<nav class="acad-breadcrumb">
  <span class="acad-breadcrumb-item" onclick="show('academy')" style="cursor:pointer">Academy</span>
  <span class="acad-breadcrumb-sep">›</span>
  <span class="acad-breadcrumb-current">Admin Dashboard</span>
</nav>

<!-- SA-401 Phase Hero -->
<div class="acad-phase-hero" style="border-color:rgba(99,102,241,.2);margin-bottom:20px">
  <div class="acad-phase-hero-bar" style="background:linear-gradient(90deg,#1A4740,#1A4740)"></div>
  <div class="acad-phase-hero-inner">
    <div class="acad-phase-hero-icon">${SVG_TEAM}</div>
    <div class="acad-phase-hero-body">
      <div class="acad-phase-hero-eyebrow" style="color:#1A4740">Admin View</div>
      <h1 class="acad-phase-hero-title" style="font-size:1.4rem">Team Academy Progress</h1>
      <p class="acad-phase-hero-desc">Monitor team completion, quiz performance, streaks, and certifications across all reps.</p>
    </div>
  </div>
</div>

<!-- SA-401 Metric cards -->
<div class="admin-metric-cards">
  <div class="admin-metric-card">
    <div class="admin-metric-card-num" style="color:var(--ink)">${allReps.length}</div>
    <div class="admin-metric-card-icon" style="background:rgba(99,102,241,.1);color:#1A4740">${SVG_TEAM}</div>
    <div class="admin-metric-card-label">Team Members</div>
  </div>
  <div class="admin-metric-card">
    <div class="admin-metric-card-num" style="color:#2D7A55">${allReps.filter(r=>r.pct===100).length}</div>
    <div class="admin-metric-card-icon" style="background:rgba(16,185,129,.1);color:#2D7A55">${SVG_CHECK}</div>
    <div class="admin-metric-card-label">Academy Complete</div>
  </div>
  <div class="admin-metric-card">
    <div class="admin-metric-card-num" style="color:var(--blue)">${avgPct}%</div>
    <div class="admin-metric-card-icon" style="background:rgba(0,167,225,.1);color:var(--blue)">${SVG_PLAY}</div>
    <div class="admin-metric-card-label">Avg Completion</div>
  </div>
  <div class="admin-metric-card">
    <div class="admin-metric-card-num" style="color:#8B6914">${teamQuizAvg != null ? teamQuizAvg+'%' : '—'}</div>
    <div class="admin-metric-card-icon" style="background:rgba(245,158,11,.1);color:#8B6914">${SVG_NOTE}</div>
    <div class="admin-metric-card-label">Team Quiz Avg</div>
  </div>
  <div class="admin-metric-card">
    <div class="admin-metric-card-num" style="color:#8B6914">${activeStreaks}</div>
    <div class="admin-metric-card-icon" style="background:rgba(139,105,20,.10);color:#8B6914">${SVG_FLAME}</div>
    <div class="admin-metric-card-label">Active Streaks</div>
  </div>
</div>

<div class="acad-sh" style="margin-top:8px">Rep Progress — click a row to expand</div>
${repCards}

<div class="acad-section-label" style="margin-top:24px">Phase Certifications &amp; Bulk Actions</div>
${phaseRows}

<div class="card" style="margin-top:18px;border-color:rgba(99,102,241,.2);background:rgba(99,102,241,.03)">
  <div style="font-size:.78rem;font-weight:700;color:#1A4740;margin-bottom:8px">Admin Controls Guide</div>
  <div style="font-size:.82rem;color:var(--muted);display:grid;gap:6px">
    <div><strong style="color:var(--ink)">Module cells</strong> — click any cell that shows a quiz score to see the full question-by-question drill-down for that rep.</div>
    <div><strong style="color:var(--ink)">Mark Complete</strong> — credit a specific module for a rep (e.g. after an in-person session). Shows full module title so you know exactly what you're marking.</div>
    <div><strong style="color:var(--ink)">Coaching Notes</strong> — private textarea per rep, saved in your browser. Notes are never visible to the rep.</div>
    <div><strong style="color:var(--ink)">Certify Phase</strong> — stamp your approval once all modules in a phase are done. Saved permanently with your name and date.</div>
    <div><strong style="color:var(--ink)">Bulk Complete Phase</strong> — instantly mark every module in a phase done for a rep (useful after in-person bootcamps).</div>
    <div><strong style="color:var(--ink)">Reset All Progress</strong> — wipes all academy data for that rep, including certifications. Cannot be undone.</div>
  </div>
</div>`;

  // ── Handlers ────────────────────────────────────────────────────────────────

  window.toggleAdminRepDetail = function(repId) {
    const el = document.getElementById('rep-detail-'+repId);
    if (!el) return;
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
  };

  window.academyAdminShowQuizDrill = function(repId, moduleId) {
    const panel = document.getElementById('quiz-drill-'+repId);
    if (!panel) return;
    // Toggle off if already showing same module
    if (panel._moduleId === moduleId && panel.style.display !== 'none') {
      panel.style.display = 'none';
      panel._moduleId = null;
      return;
    }
    panel._moduleId = moduleId;
    panel.style.display = 'block';

    const content = window.Academy.getContent();
    const mod = content.modules.find(m=>m.id===moduleId);
    if (!mod || !mod.quiz) { panel.innerHTML = '<p style="color:var(--muted);font-size:.83rem">No quiz data.</p>'; return; }

    const attempts = window.Academy.getQuizAttempts(repId, 'quiz_'+moduleId);
    if (!attempts.length) { panel.innerHTML = '<p style="color:var(--muted);font-size:.83rem">No quiz attempts yet.</p>'; return; }

    panel._attemptIdx = attempts.length - 1; // show latest attempt first
    function renderAttempt(idx) {
      const att = attempts[idx];
      const fb  = att.feedback || [];
      const questionsHtml = fb.map(f => {
        const q = mod.quiz.questions.find(x=>x.id===f.questionId) || {};
        const repAnswerVal = (att.answers||{})[f.questionId];
        const repAnswerText = (q.choices||[]).find(c=>c.value===repAnswerVal)?.text || repAnswerVal || '—';
        const correctText   = (q.choices||[]).find(c=>c.correct)?.text || f.correct_answer || '—';
        return `<div style="margin-bottom:12px;padding:10px;border-radius:8px;background:${f.correct?'rgba(16,185,129,.06)':'rgba(239,68,68,.06)'};border:1px solid ${f.correct?'rgba(16,185,129,.2)':'rgba(239,68,68,.2)'}">
          <div style="font-size:.83rem;font-weight:600;color:var(--ink);margin-bottom:6px">${escapeHtml(q.prompt||f.questionId)}</div>
          <div style="font-size:.78rem;color:${f.correct?'#2D7A55':'#8B3A2A'};margin-bottom:4px">
            ${f.correct ? SVG_CHECK+' Correct' : '✗ Incorrect'}
            &nbsp;·&nbsp; Rep answered: <em>${escapeHtml(repAnswerText)}</em>
            ${!f.correct ? `&nbsp;·&nbsp; Correct: <em>${escapeHtml(correctText)}</em>` : ''}
          </div>
          ${f.explanation ? `<div style="font-size:.75rem;color:var(--muted);margin-top:4px">${escapeHtml(f.explanation)}</div>` : ''}
        </div>`;
      }).join('');

      panel.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:8px">
          <div style="font-weight:700;font-size:.85rem;color:var(--ink)">Quiz Drill-Down: ${moduleId} — ${escapeHtml(mod.title)}</div>
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:.78rem;color:var(--muted)">Attempt ${idx+1} of ${attempts.length} · ${fmtDate(att.submitted_at)} · Score: <strong style="color:${att.passed?'#2D7A55':'#8B3A2A'}">${att.percent_score}%</strong> ${att.passed?'PASSED':'FAILED'}</span>
            ${idx > 0 ? `<button class="admin-action-btn" onclick="academyAdminShowAttempt('${repId}','${moduleId}',${idx-1})">← Older</button>` : ''}
            ${idx < attempts.length-1 ? `<button class="admin-action-btn" onclick="academyAdminShowAttempt('${repId}','${moduleId}',${idx+1})">Newer →</button>` : ''}
            <button class="admin-action-btn" onclick="document.getElementById('quiz-drill-${repId}').style.display='none'">Close ✕</button>
          </div>
        </div>
        ${questionsHtml || '<p style="color:var(--muted);font-size:.83rem">No question detail available.</p>'}
      `;
      panel._attemptIdx = idx;
    }

    window.academyAdminShowAttempt = function(rId, mId, aidx) {
      if (rId !== repId || mId !== moduleId) return;
      renderAttempt(aidx);
    };

    renderAttempt(panel._attemptIdx);
  };

  window.academyAdminMarkModule = function(repId, moduleId, moduleTitle) {
    const titleDisplay = moduleTitle || moduleId;
    if (!confirm('Mark "' + titleDisplay + '" complete for this rep?\n\nThis cannot be undone.')) return;
    if (!window.Academy.adminMarkModuleComplete) return showToast('Admin function unavailable');
    window.Academy.adminMarkModuleComplete(repId, moduleId);
    showToast(moduleId + ' marked complete.');
    academyAdminDashboard();
  };

  window.academyAdminBulkPhase = function(repId, phaseId, repName, phaseTitle) {
    if (!confirm('Mark ALL modules in the ' + phaseTitle + ' phase complete for ' + repName + '?\n\nThis is for in-person bootcamp use. Cannot be undone.')) return;
    const content = window.Academy.getContent();
    const ph = content.phases.find(p=>p.id===phaseId);
    if (!ph) return showToast('Phase not found');
    ph.module_ids.forEach(mId => {
      window.Academy.adminMarkModuleComplete(repId, mId);
    });
    showToast('All ' + phaseTitle + ' modules marked complete for ' + repName + '.');
    academyAdminDashboard();
  };

  window.academyAdminCertifyPhase = function(repId, phaseId, repName, certName) {
    if (!confirm('Certify "' + certName + '" for ' + repName + '?\n\nThis stamps your approval with today\'s date.')) return;
    const certs = loadCerts();
    if (!certs[repId]) certs[repId] = {};
    certs[repId][phaseId] = { at: new Date().toISOString(), by: rep.name };
    saveCerts(certs);
    showToast(certName + ' certified for ' + repName + '.');
    academyAdminDashboard();
  };

  window.academyAdminResetRep = function(repId, repName) {
    if (!confirm('Reset ALL academy progress for ' + repName + '?\n\nThis also clears all phase certifications for this rep. Cannot be undone.')) return;
    if (!window.Academy.adminResetRepProgress) return showToast('Admin function unavailable');
    window.Academy.adminResetRepProgress(repId);
    // Also clear certs for this rep
    const certs = loadCerts();
    delete certs[repId];
    saveCerts(certs);
    showToast('Progress reset for ' + repName + '.');
    academyAdminDashboard();
  };
}
function manager(){
  const fy = getResolvedFY();
  const annual = fy.annual;
  const divs = fy.divisions;
  const pd = data.pricingDiscipline;
  const rc = data.reviewCadence;
  const tylerCard = data.repData && data.repData.tyler;

  function fmtM(n){ return n != null ? n.toLocaleString(undefined,{style:'currency',currency:'USD',maximumFractionDigits:0}) : '\u2014'; }

  function pbar(actual, target){
    const pct = target > 0 ? Math.min(100, Math.round((actual/target)*100)) : 0;
    const fillClass = pct >= 100 ? '' : pct >= 70 ? ' warn' : ' alert';
    return `<div class="gw-pbar-track"><div class="gw-pbar-fill${fillClass}" style="width:${pct}%"></div></div><div class="gw-pbar-pct">${pct}% of target</div>`;
  }

  const DIV_SVG = {
    landscape:   '<svg width="20" height="20" viewBox="0 0 18 18" fill="none"><path d="M9 15V9.5M9 9.5C9 9.5 5 9.5 3 5c3 0 6 2 6 4.5zm0 0c0 0 4 0 6-4.5-3 0-6 2-6 4.5z" stroke="#2D7A55" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    maintenance: '<svg width="20" height="20" viewBox="0 0 18 18" fill="none"><path d="M12.5 3a3 3 0 00-2.5 4.5L3.8 13.8a.8.8 0 001.2 1.2l6.5-5.7A3 3 0 0014 10a3 3 0 00-.5-1.5l-1.8 1.8-1.2-1.2 1.8-1.8A3 3 0 0012.5 3z" stroke="#4D8A86" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    snow:        '<svg width="20" height="20" viewBox="0 0 18 18" fill="none"><path d="M9 2.5v13M2.5 9h13M4.5 4.5l9 9M13.5 4.5l-9 9" stroke="#B8C8C7" stroke-width="1.5" stroke-linecap="round"/><circle cx="9" cy="2.5" r="1" fill="#B8C8C7"/><circle cx="9" cy="15.5" r="1" fill="#B8C8C7"/><circle cx="2.5" cy="9" r="1" fill="#B8C8C7"/><circle cx="15.5" cy="9" r="1" fill="#B8C8C7"/></svg>',
  };
  function divTile(div){
    const abovePlan = div.remaining <= 0;
    const gmOk = div.grossMarginPct >= div.grossMarginFloor;
    const divKey = div.name ? div.name.toLowerCase().replace(/[^a-z]/g,'') : '';
    const divSvg = divKey.includes('landscape') ? DIV_SVG.landscape : divKey.includes('snow') ? DIV_SVG.snow : divKey.includes('maint') ? DIV_SVG.maintenance : '';
    return `<article class="gw-div-tile${abovePlan?' above-plan':''}">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;margin-top:4px">${divSvg} <span style="font-weight:700;font-size:1rem">${div.name}</span>
        ${abovePlan ? '<span style="background:var(--gw-emerald);color:#fff;font-size:10px;font-weight:700;border-radius:20px;padding:2px 8px;margin-left:8px">\u2713 ABOVE PLAN</span>' : ''}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px">
        <div><div class="gw-div-tile-meta">Target</div><div class="gw-div-tile-val">${fmtM(div.target)}</div></div>
        <div><div class="gw-div-tile-meta">Actual (5/21)</div><div class="gw-div-tile-val" style="color:${abovePlan?'var(--gw-emerald)':'var(--gw-sky)'}">${fmtM(div.actual)}</div></div>
        <div><div class="gw-div-tile-meta">GM Floor</div><div style="font-size:1rem;font-weight:700;color:#8B6914">${Math.round(div.grossMarginFloor*100)}%</div></div>
        <div><div class="gw-div-tile-meta">Actual GM</div><div style="font-size:1rem;font-weight:700;color:${gmOk?'var(--gw-emerald)':'#8B3A2A'}">${Math.round(div.grossMarginPct*100)}%</div></div>
      </div>
      ${pbar(div.actual, div.target)}
      ${div.remaining > 0 ? `<div class="gw-div-tile-remaining">Remaining: <strong>${fmtM(div.remaining)}</strong></div>` : `<div class="gw-div-tile-over">+${fmtM(Math.abs(div.remaining))} over plan</div>`}
    </article>`;
  }

  const ytdBudgeted = fy.monthlyBudget.filter(m=>m.actual!=null).reduce((a,m)=>a+m.budgeted,0);
  const ytdVariance = annual.actualRevenue - ytdBudgeted;

  // T41: Count missing past months for banner
  const todayM = new Date();
  const allMonthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const missingPastMonths = fy.monthlyBudget.filter(m => {
    if (m.actual != null) return false;
    const mIdx = allMonthNames.indexOf(m.month.slice(0,3));
    if (mIdx < 0) return false;
    const mDate = new Date(2026, mIdx, 1);
    return mDate < todayM;
  });

  const monthRows = fy.monthlyBudget.map(m => {
    const hasActual = m.actual != null;
    const varSign = m.variance > 0 ? '+' : '';
    const varColor = m.variance == null ? '#4A5947' : m.variance >= 0 ? '#2D7A55' : '#C97B6A';
    const mIdx2 = allMonthNames.indexOf(m.month.slice(0,3));
    const isPastMonth = mIdx2 >= 0 && new Date(2026, mIdx2, 1) < todayM;
    const missingBadge = !hasActual && isPastMonth ? '<span class="missing-data-badge">Missing</span>' : '';
    return `<tr>
      <td style="padding:8px 10px;font-weight:600">${m.month} ${missingBadge}</td>
      <td style="padding:8px 10px;text-align:right">${fmtM(m.budgeted)}</td>
      <td style="padding:8px 10px;text-align:right;color:${hasActual?'var(--gw-sky)':'var(--gw-line)'}">${hasActual ? fmtM(m.actual) : '\u2014'}</td>
      <td style="padding:8px 10px;text-align:right;color:${varColor}">${m.variance != null ? varSign+fmtM(m.variance) : '\u2014'}</td>
    </tr>`;
  }).join('');

  view.innerHTML = `
    <div class="eyebrow">Leadership Rhythm \u2014 FY2026</div>
    <h1>Manager Tools <span style="font-size:13px;color:#6F7E6A;font-weight:400;margin-left:8px">${escapeHtml(fy.budgetVersion)}</span>${(()=>{ const _cr = window.getCurrentRep ? window.getCurrentRep() : null; return (_cr && _cr.role === 'office_manager') ? '<span style="font-size:12px;color:#8B6914;font-weight:400;margin-left:10px;vertical-align:middle;background:#8B691418;border:1px solid rgba(139,105,20,.25);border-radius:8px;padding:2px 8px">Office Manager View — Read Only</span>' : ''; })()}</h1>
    <p class="lede">Real division P&amp;L, monthly actuals, HubSpot pipeline gates, pricing discipline, and team scorecard.</p>

    <div class="gw-kpi-banner">
      <div class="gw-kpi-banner-cell">
        <div class="gw-kpi-banner-label">FY2026 Budget</div>
        <div class="gw-kpi-banner-val">${fmtM(annual.budgetedRevenue)}</div>
      </div>
      <div class="gw-kpi-banner-cell">
        <div class="gw-kpi-banner-label">Actual (5/21)</div>
        <div class="gw-kpi-banner-val" style="color:var(--gw-sky)">${fmtM(annual.actualRevenue)}</div>
      </div>
      <div class="gw-kpi-banner-cell">
        <div class="gw-kpi-banner-label">Remaining</div>
        <div class="gw-kpi-banner-val" style="color:#8B3A2A">${fmtM(annual.remaining)}</div>
      </div>
      <div class="gw-kpi-banner-cell">
        <div class="gw-kpi-banner-label">Needed / Month</div>
        <div class="gw-kpi-banner-val" style="color:#8B6914">${fmtM(annual.avgNeededPerMonth)}</div>
        <div class="gw-kpi-banner-sub">${annual.monthsLeft} months remaining</div>
      </div>
      <div class="gw-kpi-banner-cell">
        <div class="gw-kpi-banner-label">Operating GM</div>
        <div class="gw-kpi-banner-val" style="color:#4D8A86">${Math.round(annual.grossMarginPct*100)}%</div>
      </div>
      <div class="gw-kpi-banner-cell">
        <div class="gw-kpi-banner-label">True Net Income</div>
        <div class="gw-kpi-banner-val" style="font-size:1.5rem;color:var(--gw-emerald)">${fmtM(annual.trueNetIncome)}</div>
        <div class="gw-kpi-banner-sub">after ${fmtM(annual.loanMonthly)}/mo loans</div>
      </div>
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-top:28px;margin-bottom:0">
      <h2 style="font-size:1rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0">Division P&amp;L \u2014 Actual vs Target</h2>
      <button class="primary-btn" onclick="show('revenueAdmin')" style="font-size:12px;padding:6px 14px;background:linear-gradient(135deg,var(--gw-pine),var(--gw-pine-light))">Edit Monthly Revenue</button>
    </div>
    <div class="grid grid-3 mt" style="gap:16px">
      ${divTile(divs.landscape)}
      ${divTile(divs.maintenance)}
      ${divTile(divs.snow)}
    </div>

    <div class="card mt">
      <h2>\u2702\ufe0f Maintenance Growth Pipeline \u2014 Ryan\u2019s ${fmtM(divs.maintenance.growthTarget)} Target</h2>
      <p class="muted small-text">Contracted base entering 2026: ${fmtM(divs.maintenance.contractedBase)} (${divs.maintenance.contractedCommercialAccounts} comm + ${divs.maintenance.contractedResidentialAccounts} res accounts). Additional ${fmtM(divs.maintenance.growthTarget)} to sell.</p>
      <div style="overflow-x:auto;margin-top:12px">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr><th style="padding:8px 12px;text-align:left">Growth Bucket</th><th style="padding:8px 12px;text-align:center">Segment</th><th style="padding:8px 12px;text-align:right">Target</th></tr></thead>
          <tbody>${(divs.maintenance.growthPipeline||[]).map(b=>`<tr><td style="padding:8px 12px">${escapeHtml(b.bucket)}</td><td style="padding:8px 12px;text-align:center">${escapeHtml(b.segment)}</td><td style="padding:8px 12px;text-align:right;font-weight:700;color:var(--gw-emerald)">${fmtM(b.target)}</td></tr>`).join('')}</tbody>
        </table>
      </div>
    </div>

    ${missingPastMonths.length > 0 ? `<div class="missing-data-alert"><strong>${missingPastMonths.length} past month${missingPastMonths.length>1?'s':''} missing actuals:</strong> ${missingPastMonths.map(m=>m.month).join(', ')} — <button onclick="show('revenueAdmin','division')" style="background:none;border:none;color:#4D8A86;cursor:pointer;font-size:inherit;text-decoration:underline;padding:0">Enter data →</button></div>` : ''}
    <div class="card mt">
      <h2>Monthly Revenue — Budget vs Actual (Jan–Dec 2026)</h2>
      <p class="muted small-text">Actuals through 5/21/2026. Remaining months show budget target only.</p>
      <div style="overflow-x:auto;margin-top:12px">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr>
            <th style="padding:8px 12px;text-align:left">Month</th>
            <th style="padding:8px 12px;text-align:right">Budgeted</th>
            <th style="padding:8px 12px;text-align:right;color:var(--gw-sky)">Actual</th>
            <th style="padding:8px 12px;text-align:right">Variance</th>
          </tr></thead>
          <tbody>${monthRows}</tbody>
          <tfoot><tr>
            <td style="padding:10px 12px;font-weight:700">YTD Total</td>
            <td style="padding:10px 12px;text-align:right;font-weight:700">${fmtM(ytdBudgeted)}</td>
            <td style="padding:10px 12px;text-align:right;font-weight:700;color:var(--gw-sky)">${fmtM(annual.actualRevenue)}</td>
            <td style="padding:10px 12px;text-align:right;font-weight:700;color:${ytdVariance>=0?'var(--gw-emerald)':'#8B3A2A'}">${ytdVariance>=0?'+':''}${fmtM(ytdVariance)}</td>
          </tr></tfoot>
        </table>
      </div>
    </div>

    <!-- ── DIVISION PIPELINE / PAPER ON THE STREET ── -->
    <div class="card mt" id="divPipelineSection">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;flex-wrap:wrap;gap:8px">
        <div>
          <h2 style="margin:0;font-size:16px">Pipeline by Division</h2>
          <div style="font-size:11px;color:#6F7E6A;margin-top:3px">
            <strong style="color:#4D8A86">Paper on the Street</strong>
            <span style="color:#5C6B58"> = active quoted / proposed value currently in front of customers, not yet sold or lost</span>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <select id="dpRepFilter" onchange="window._renderDpTable&&window._renderDpTable()" class="gw-select">
            <option value="">All Reps</option>
            ${(window.REPS||[]).filter(r=>r.role==='rep').map(r=>'<option value="'+r.id+'">'+r.name+'</option>').join('')}
          </select>
          <select id="dpEstFilter" onchange="window._renderDpTable&&window._renderDpTable()" class="gw-select">
            <option value="">All Estimate Statuses</option>
            <option value="sent">Sent</option>
            <option value="revised">Revised</option>
            <option value="viewed">Viewed</option>
            <option value="awaiting_response">Awaiting Response</option>
          </select>
        </div>
      </div>

      <div id="dpTableWrap" style="overflow-x:auto;margin-top:8px"></div>

      <div style="margin-top:20px;border-top:1px solid var(--gw-line);padding-top:16px">
        <h3 style="font-size:13px;font-weight:700;color:#6F7E6A;margin:0 0 10px;text-transform:uppercase;letter-spacing:.08em">Estimate Aging — Open Paper</h3>
        <div id="dpAgingWrap" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px"></div>
      </div>
    </div>


    <div class="card mt">
      <h2>\ud83d\udd35 HubSpot 7-Stage Pipeline \u2014 Win Probabilities &amp; Gate Fields</h2>
      <p class="muted small-text">${escapeHtml((data.hubspotPipeline||{}).description||'')}</p>
      <div style="overflow-x:auto;margin-top:12px">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr>
            <th style="padding:8px 10px;text-align:center">#</th>
            <th style="padding:8px 10px;text-align:left">Stage Name</th>
            <th style="padding:8px 10px;text-align:center">Win %</th>
            <th style="padding:8px 10px;text-align:left">Mandatory Gate Fields</th>
          </tr></thead>
          <tbody>${((data.hubspotPipeline||{}).stages||[]).map(s=>{
            const pct = Math.round(s.winProb*100);
            const barC = pct>=80?'#2D7A55':pct>=60?'#8B6914':pct>=40?'#4D8A86':'#6F7E6A';
            return `<tr>
              <td style="padding:8px 10px;text-align:center;font-weight:800;color:${barC}">${s.num}</td>
              <td style="padding:8px 10px;font-weight:600">${escapeHtml(s.name)}</td>
              <td style="padding:8px 10px;text-align:center">
                <div style="display:flex;align-items:center;gap:6px;justify-content:center">
<div style="width:48px;height:5px;background:var(--gw-line);border-radius:3px"><div style="width:${pct}%;height:5px;background:${barC};border-radius:3px"></div></div>
                  <span style="font-weight:700;color:${barC};font-size:11px">${pct}%</span>
                </div>
              </td>
              <td style="padding:8px 10px;font-size:11px;color:var(--gw-muted)">${(s.gates||[]).join(' \u00b7 ')}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>
      <div style="margin-top:12px"><h4 style="font-size:12px;color:#6F7E6A;margin-bottom:6px">Hygiene Rules</h4>${list((data.hubspotPipeline||{}).hygieneRules||[])}</div>
    </div>

    <div class="grid grid-2 mt">
      <div class="card">
        <h2>\ud83d\udcb2 Pricing Discipline \u2014 GM Floors</h2>
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:8px">
          <thead><tr><th style="padding:8px 10px;text-align:left">Division</th><th style="padding:8px 10px;text-align:center">Floor</th><th style="padding:8px 10px;text-align:left">Current Status</th></tr></thead>
          <tbody>${(pd.grossMarginFloors||[]).map(g=>`<tr><td style="padding:8px 10px;font-weight:600">${escapeHtml(g.division)}</td><td style="padding:8px 10px;text-align:center;font-weight:800;color:var(--gw-emerald)">${escapeHtml(g.floor)}</td><td style="padding:8px 10px;font-size:11px;color:var(--gw-muted)">${escapeHtml(g.current)}</td></tr>`).join('')}</tbody>
        </table>
        <h4 style="font-size:12px;color:#6F7E6A;margin-top:16px;margin-bottom:6px">Labor Recovery Rules</h4>
        ${list(pd.laborRecoveryRules||[])}
      </div>
      <div class="card">
        <h2>\ud83d\udccb Cost Recovery by Division</h2>
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:8px">
            <thead><tr><th style="padding:6px 8px;text-align:left">Category</th><th style="padding:6px 8px;text-align:center;color:#4D8A86">Landscape</th><th style="padding:6px 8px;text-align:center;color:var(--gw-emerald)">Maintenance</th><th style="padding:6px 8px;text-align:center;color:#B8C8C7">Snow</th></tr></thead>
            <tbody>${(pd.activityCostRecovery||[]).map(r=>`<tr><td style="padding:6px 8px;color:var(--gw-muted)">${escapeHtml(r.category)}</td><td style="padding:6px 8px;text-align:center;font-weight:600">${escapeHtml(r.landscape)}</td><td style="padding:6px 8px;text-align:center;font-weight:600">${escapeHtml(r.maintenance)}</td><td style="padding:6px 8px;text-align:center;font-weight:600">${escapeHtml(r.snow)}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="grid grid-2 mt">
      <div class="card">
        <h2>\ud83d\udc64 Tyler \u2014 Leadership Scorecard</h2>
        <p class="muted small-text">Owner / CEO \u00b7 Total cost: $${((tylerCard&&tylerCard.totalEmployeeCost)||0).toLocaleString()}/yr</p>
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:12px">
          <thead><tr><th style="padding:8px 10px;text-align:left">Metric</th><th style="padding:8px 10px;text-align:left">Target</th><th style="padding:8px 10px;text-align:center">Cadence</th></tr></thead>
          <tbody>${((tylerCard&&tylerCard.leadershipScorecard)||[]).map(sc=>`<tr><td style="padding:8px 10px;font-weight:600">${escapeHtml(sc.metric)}</td><td style="padding:8px 10px;color:var(--gw-emerald);font-weight:700">${escapeHtml(sc.target)}</td><td style="padding:8px 10px;text-align:center;color:var(--gw-muted);font-size:11px">${escapeHtml(sc.cadence)}</td></tr>`).join('')}</tbody>
        </table>
      </div>
      <div class="card">
        <h2>\ud83d\uddd3 Review Cadence</h2>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
          ${(rc||[]).map(r=>`<div style="display:flex;gap:10px;align-items:flex-start;padding:8px;background:var(--bg2);border-radius:8px">
            <span style="font-size:10px;font-weight:700;color:#8B6914;background:rgba(245,158,11,.12);padding:2px 8px;border-radius:10px;min-width:60px;text-align:center">${escapeHtml(r.cadence)}</span>
            <div><div style="font-size:13px;font-weight:600;color:#E8E4D9">${escapeHtml(r.meeting)}</div><div style="font-size:11px;color:#6F7E6A">${escapeHtml(r.attendees)} \u00b7 ${escapeHtml(r.output)}</div></div>
          </div>`).join('')}
        </div>
      </div>
    </div>

    <div class="grid grid-2 mt">
      <article class="card"><h2>Weekly Sales Meeting Agenda</h2>${list(data.managerAgenda)}</article>
      <div>
        <article class="card"><h2>Stuck Deal Questions</h2>${list(['What stage is this opportunity actually in?','What is the client\'s core buying reason?','Who decides, and have we spoken with them?','What objection is real vs vague?','What is the next yes/no/adjust decision?','What date is the next follow-up?'])}</article>
        <article class="card mt"><h2>Non-Negotiables</h2>${list(data.nonNegotiables.slice(0,6))}</article>
      </div>
    </div>
    ${statCards()}

  `;
  setTimeout(window._renderDpTable, 80);
}

// ── Division Pipeline table render ────────────────────────────────────────
window._renderDpTable = function() {
    const repFilter = (document.getElementById('dpRepFilter')||{}).value || '';
    const estFilter = (document.getElementById('dpEstFilter')||{}).value || '';
    const opps = (typeof state !== 'undefined' ? state.opportunities : []) || [];
    const POTS_STATUSES = ['sent','revised','viewed','awaiting_response','awaiting response'];
    const POTS_STAGES   = ['Estimate Sent','Proposal Under Review','Negotiating','Decision Pending','Follow-Up'];

    function getDiv(o) {
      const cat = (o.projectCategory||'').toLowerCase();
      const wt  = (o.workType||'').toLowerCase();
      const sl  = (o.serviceLine||'').toLowerCase();
      if (cat.includes('snow')||wt.includes('snow')||sl.includes('snow')) return 'snow';
      if (cat.includes('mainten')||wt.includes('mainten')||sl.includes('mainten')) return 'maintenance';
      return 'landscape';
    }

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);
    const STAGE_WIN = {'New Lead':.10,'Contacted':.15,'Site Visit Scheduled':.25,'Site Visit Complete':.35,
      'Estimating':.45,'Estimate Sent':.55,'Proposal Under Review':.65,'Negotiating':.75,
      'Follow-Up':.50,'Decision Pending':.70,'Sold / Activation':1.0,'Closed Lost':0.0};

    const KEYS = ['landscape','maintenance','snow'];
    const LABELS = {landscape:'Landscape',maintenance:'Maintenance',snow:'Snow & Ice'};
    const COLORS = {landscape:'#4D8A86',maintenance:'#2D7A55',snow:'#4D8A86'};

    const stats = {};
    KEYS.forEach(k => { stats[k] = {openVal:0,estVal:0,pots:0,weighted:0,openCt:0,estCt:0,ageDays:[],risk7:0,soldMo:0,soldMoCt:0,sold:0,soldCt:0,lost:0,lostCt:0}; });

    opps.forEach(o => {
      if (repFilter && o.repId !== repFilter) return;
      const estSt = (o.estimateStatus||'').toLowerCase().replace(/ /g,'_');
      if (estFilter && estSt !== estFilter) return;

      const d = stats[getDiv(o)];
      if (!d) return;
      const val = parseFloat(o.jobValue||0);
      const estAmt = parseFloat(o.estimateAmount||val);
      const isSold = o.status==='Sold / Activation';
      const isLost = o.status==='Closed Lost';

      if (isSold) { d.sold+=val; d.soldCt++; if ((o.updatedAt||'').slice(0,10)>=startOfMonth){d.soldMo+=val;d.soldMoCt++;} }
      if (isLost) { d.lostCt++; }
      if (isSold||isLost) return;

      d.openCt++; d.openVal+=val; d.weighted+=val*(STAGE_WIN[o.status]||0.20);
      const hasEst = POTS_STATUSES.includes(estSt)||POTS_STATUSES.includes((o.estimateStatus||'').toLowerCase())||POTS_STAGES.includes(o.status);
      if (hasEst&&estAmt>0) {
        d.estCt++; d.estVal+=estAmt; d.pots+=estAmt;
        const sentDate = o.estimateSentDate||o.updatedAt||o.createdAt;
        if (sentDate) { const age=Math.floor((now-new Date(sentDate))/86400000); if(age>=0)d.ageDays.push(age); }
      }
      if (o.nextFollowUp) { const days=Math.floor((new Date(o.nextFollowUp+'T12:00:00')-now)/86400000); if(days>=0&&days<=7)d.risk7++; }
    });

    function fm(n){ return n!=null?n.toLocaleString(undefined,{style:'currency',currency:'USD',maximumFractionDigits:0}):'—'; }
    function cr(d){ const tot=d.soldCt+d.lostCt; return tot>0?Math.round(d.soldCt/tot*100)+'%':'—'; }
    function avgAge(d){ return d.ageDays.length>0?Math.round(d.ageDays.reduce((a,b)=>a+b,0)/d.ageDays.length):null; }
    function maxAge(d){ return d.ageDays.length>0?Math.max(...d.ageDays):null; }
    function ageColor(days){ if(days==null)return'#5C6B58'; if(days<=7)return'#2D7A55'; if(days<=14)return'#8B6914'; if(days<=30)return'#8B6914'; return'#C97B6A'; }

    const totals = {
      openVal:KEYS.reduce((a,k)=>a+stats[k].openVal,0),
      estVal:KEYS.reduce((a,k)=>a+stats[k].estVal,0),
      pots:KEYS.reduce((a,k)=>a+stats[k].pots,0),
      weighted:KEYS.reduce((a,k)=>a+stats[k].weighted,0),
      openCt:KEYS.reduce((a,k)=>a+stats[k].openCt,0),
      estCt:KEYS.reduce((a,k)=>a+stats[k].estCt,0),
      risk7:KEYS.reduce((a,k)=>a+stats[k].risk7,0),
      soldMo:KEYS.reduce((a,k)=>a+stats[k].soldMo,0),
    };

    const headerRow = `<tr>
      <th style="padding:8px 10px;text-align:left;font-size:11px">Division</th>
      <th style="padding:8px 10px;text-align:right;font-size:11px">Open Pipeline</th>
      <th style="padding:8px 10px;text-align:right;color:#4D8A86;font-size:11px" title="Active quoted/proposed value in front of customers, not yet sold or lost">Paper on the Street</th>
      <th style="padding:8px 10px;text-align:right;font-size:11px">Open Est. Value</th>
      <th style="padding:8px 10px;text-align:right;font-size:11px">Weighted</th>
      <th style="padding:8px 10px;text-align:center;font-size:11px">Active Opps</th>
      <th style="padding:8px 10px;text-align:center;font-size:11px">Open Ests</th>
      <th style="padding:8px 10px;text-align:center;font-size:11px">Avg Age</th>
      <th style="padding:8px 10px;text-align:center;font-size:11px">Oldest</th>
      <th style="padding:8px 10px;text-align:center;font-size:11px">7d Risk</th>
      <th style="padding:8px 10px;text-align:right;font-size:11px">Sold Mo.</th>
      <th style="padding:8px 10px;text-align:center;font-size:11px">Close Rate</th>
    </tr>`;

    const divRows = KEYS.map(k => {
      const d = stats[k]; const avg=avgAge(d); const mx=maxAge(d);
      return `<tr>
        <td style="padding:8px 10px;font-weight:700;color:${COLORS[k]}">${LABELS[k]}</td>
        <td style="padding:8px 10px;text-align:right;font-weight:600">${fm(d.openVal)}</td>
        <td style="padding:8px 10px;text-align:right;font-weight:800;color:#4D8A86">${fm(d.pots)}</td>
        <td style="padding:8px 10px;text-align:right;color:#6F7E6A">${fm(d.estVal)}</td>
        <td style="padding:8px 10px;text-align:right;color:#6F7E6A">${fm(d.weighted)}</td>
        <td style="padding:8px 10px;text-align:center">${d.openCt}</td>
        <td style="padding:8px 10px;text-align:center">${d.estCt}</td>
        <td style="padding:8px 10px;text-align:center;color:${ageColor(avg)};font-weight:600">${avg!=null?avg+'d':'—'}</td>
        <td style="padding:8px 10px;text-align:center;color:${ageColor(mx)};font-weight:600">${mx!=null?mx+'d':'—'}</td>
        <td style="padding:8px 10px;text-align:center;color:${d.risk7>0?'#8B6914':'#2D7A55'};font-weight:700">${d.risk7}</td>
        <td style="padding:8px 10px;text-align:right;color:#2D7A55;font-weight:700">${fm(d.soldMo)}</td>
        <td style="padding:8px 10px;text-align:center;font-weight:700;color:#4D8A86">${cr(d)}</td>
      </tr>`;
    }).join('');

    const totRow = `<tr style="border-top:2px solid var(--gw-line)">
      <td style="padding:9px 10px;font-weight:800">Total</td>
      <td style="padding:9px 10px;text-align:right;font-weight:800">${fm(totals.openVal)}</td>
      <td style="padding:9px 10px;text-align:right;font-weight:900;color:#4D8A86">${fm(totals.pots)}</td>
      <td style="padding:9px 10px;text-align:right;font-weight:700;color:var(--gw-muted)">${fm(totals.estVal)}</td>
      <td style="padding:9px 10px;text-align:right;color:var(--gw-muted)">${fm(totals.weighted)}</td>
      <td style="padding:9px 10px;text-align:center;font-weight:700">${totals.openCt}</td>
      <td style="padding:9px 10px;text-align:center;font-weight:700">${totals.estCt}</td>
      <td colspan="2" style="padding:9px 10px;text-align:center;color:#5C6B58">—</td>
      <td style="padding:9px 10px;text-align:center;font-weight:700;color:${totals.risk7>0?'#8B6914':'#2D7A55'}">${totals.risk7}</td>
      <td style="padding:9px 10px;text-align:right;font-weight:800;color:#2D7A55">${fm(totals.soldMo)}</td>
      <td style="padding:9px 10px"></td>
    </tr>`;

    const tableWrap = document.getElementById('dpTableWrap');
    if (tableWrap) {
      tableWrap.innerHTML = `<table class="gw-data-table" style="min-width:700px">
        <thead>${headerRow}</thead>
        <tbody>${divRows}${totRow}</tbody>
      </table>`;
    }

    // Aging buckets
    const allAgeDays = KEYS.flatMap(k => {
      const d = stats[k];
      return d.ageDays.map(age => ({age, label:LABELS[k], color:COLORS[k], val:0}));
    });
    // Re-compute aging by day bucket across all opps
    const buckets = [{label:'0–7 days',max:7,count:0,val:0,color:'#2D7A55'},{label:'8–14 days',min:8,max:14,count:0,val:0,color:'#8B6914'},{label:'15–30 days',min:15,max:30,count:0,val:0,color:'#8B6914'},{label:'30+ days',min:31,count:0,val:0,color:'#C97B6A'}];
    const POTS_S = ['sent','revised','viewed','awaiting_response','awaiting response'];
    const POTS_ST = ['Estimate Sent','Proposal Under Review','Negotiating','Decision Pending','Follow-Up'];
    opps.forEach(o => {
      if (repFilter && o.repId !== repFilter) return;
      const estSt2 = (o.estimateStatus||'').toLowerCase().replace(/ /g,'_');
      if (estFilter && estSt2 !== estFilter) return;
      if (['Sold / Activation','Closed Lost'].includes(o.status)) return;
      const hasEst2 = POTS_S.includes(estSt2)||POTS_S.includes((o.estimateStatus||'').toLowerCase())||POTS_ST.includes(o.status);
      if (!hasEst2) return;
      const sentDate2 = o.estimateSentDate||o.updatedAt||o.createdAt;
      if (!sentDate2) return;
      const age2 = Math.floor((now-new Date(sentDate2))/86400000);
      const estAmt2 = parseFloat(o.estimateAmount||o.jobValue||0);
      const b = age2<=7?buckets[0]:age2<=14?buckets[1]:age2<=30?buckets[2]:buckets[3];
      b.count++; b.val+=estAmt2;
    });

    const agingWrap = document.getElementById('dpAgingWrap');
    if (agingWrap) {
      agingWrap.innerHTML = buckets.map(b => `
        <div class="gw-aging-bucket">
          <div class="gw-aging-bucket-label">${b.label}</div>
          <div class="gw-aging-bucket-count" style="color:${b.color}">${b.count}</div>
          <div class="gw-aging-bucket-sub">estimates</div>
          <div style="font-size:13px;font-weight:700;color:${b.color};margin-top:4px">${b.val>0?b.val.toLocaleString(undefined,{style:'currency',currency:'USD',maximumFractionDigits:0}):'—'}</div>
        </div>`).join('');
    }
  }

function settings(){
  const _cr = window.getCurrentRep ? window.getCurrentRep() : null;
  const _ia = _cr && _cr.role === 'admin';
  const _iom = _cr && _cr.role === 'office_manager';
  const adminSections = _ia ? `
    <section class="card" style="border:1px solid #4A5947">
      <h2>Import</h2>
      <p>Restore a JSON backup from this same app. <strong style="color:#C97B6A">Admin only.</strong></p>
      <input id="importFile" type="file" accept="application/json">
      <button class="secondary-btn mt8" onclick="importJson()">Import Backup</button>
    </section>
    <section class="card" style="border:1px solid #5C2318">
      <h2>Reset All Data</h2>
      <p>Clears all opportunities, notes, and checklist progress on this browser. <strong style="color:#C97B6A">Admin only — cannot be undone.</strong></p>
      <button class="danger-btn" onclick="confirmReset()">Reset All Local Data</button>
    </section>` : _iom ? `
    <section class="card" style="border:1px solid rgba(139,105,20,.19);opacity:.75">
      <h2>Import / Reset</h2>
      <p class="muted">Import and data reset are restricted to Tyler (Owner / Admin). Contact Tyler if a data restore is needed.</p>
    </section>` : `
    <section class="card" style="opacity:.6">
      <h2>Import / Reset</h2>
      <p class="muted">Import and data reset are restricted to Tyler (Admin).</p>
    </section>`;

  const _viewLabel = _ia
    ? '<span style="font-size:13px;color:#4D8A86;font-weight:400;margin-left:8px">· Owner / Admin View</span>'
    : _iom
    ? '<span style="font-size:13px;color:#8B6914;font-weight:400;margin-left:8px">· Office Manager View</span>'
    : '<span style="font-size:13px;color:#6F7E6A;font-weight:400;margin-left:8px">· Rep View</span>';

  view.innerHTML = `
    <div class="eyebrow">Data and Setup</div>
    <h1>Settings ${_viewLabel}</h1>
    <p class="lede">Export your pipeline data for backup or reporting. Data is saved locally in the browser.</p>
    <div class="grid grid-2 mt">
      <section class="card">
        <h2>Export</h2>
        <p>Download your local pipeline, notes, and settings.</p>
        <div class="footer-actions">
          <button class="primary-btn" onclick="exportJson()">Download JSON Backup</button>
          <button class="secondary-btn" onclick="exportCsv()">Download Pipeline CSV</button>
        </div>
      </section>
      ${adminSections}
      <section class="card">
        <h2>App Notes</h2>
        ${list(['Access via browser — bookmark for quick daily use.','Install via the Install button for app-style access on mobile.','Data is stored locally in this browser — export regularly.','Contact Tyler to transfer data between devices or reps.'])}
      </section>
    </div>
    ${_ia ? `<div class="gw-comm-tools" style="margin-top:20px">
      <div>
        <div class="gw-comm-tools-title" style="margin-bottom:2px">Admin Controls</div>
        <div style="font-size:12px;color:var(--gw-muted);margin-top:2px">Manage users, roles, permissions, and Google Workspace connections.</div>
      </div>
      <button class="secondary-btn" onclick="show('userManagement')" style="font-size:13px">gwIcon('settings',16)️ User &amp; Access Management →</button>
    </div>
    <!-- Commission Rules Manager (COMM-01) -->
    <div style="margin-top:16px" id="comm-rules-panel">
      ${renderCommissionRulesPanel()}
    </div>
    <!-- Commission Simulator (COMM-05) -->
    <div style="margin-top:16px" id="comm-sim-panel">
      ${renderCommissionSimulator()}
    </div>
    <!-- Commission Audit Trail (COMM-04) -->
    <div style="margin-top:16px" id="comm-audit-panel">
      ${renderCommissionAuditTrail()}
    </div>
    <!-- Commission Admin Tools (COMM-16 migration · COMM-18 QA · COMM-17 flags) -->
    <div class="gw-comm-tools" style="margin-top:16px">
      <div class="gw-comm-tools-title">gwIcon('settings',16)️ Commission Admin Tools</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        <button onclick="window._runMigrationFromUI()" class="gw-admin-btn">
          gwIcon('package',16) Run Data Migration
        </button>
        <button onclick="window._runQAFromUI()" class="gw-admin-btn">
          gwIcon('search',16) Run QA Self-Check
        </button>
        <button onclick="window._showFlagPanel()" class="gw-admin-btn">
          gwIcon('flag',16) Feature Flags
        </button>
      </div>
      <div id="comm-tool-result" class="gw-tool-result"></div>
    </div>` : ''}
  `;
}

// renderPermMatrix removed — permissions are now managed exclusively in
// User Management → Roles & Permissions tab (user_management.js).
// Keeping stubs so any stray calls don't throw.
function renderPermMatrix() { return ''; }

// ── Commission Rules Manager (COMM-01) ────────────────────────────────────────
// Admin-only panel in Settings. Reads active rules, lets Tyler edit tier rates,
// caps, and approval thresholds. Saves to avalonCommissionRulesV1.
function renderCommissionRulesPanel() {
  const override = (typeof window.loadActiveCommissionRules === 'function') ? window.loadActiveCommissionRules() : null;
  const basePlan = (typeof window.COMMISSION_PLANS !== 'undefined') ? window.COMMISSION_PLANS.ryan : null;
  const active = (override && override.plans && override.plans.ryan) ? override.plans.ryan : basePlan;
  if (!active) return '<p style="color:#6F7E6A;font-size:13px">Commission engine not loaded yet — reload the page.</p>';

  const updatedInfo = override
    ? `<span style="color:#8B6914;font-size:12px"> gwIcon('settings',16) Custom rules active — last edited ${new Date(override.updatedAt||'').toLocaleDateString()} by ${override.updatedBy||'admin'}</span>`
    : `<span style="color:#2D7A55;font-size:12px"> ✓ Using default Avalon commission structure</span>`;

  const lTiers = active.landscape.tiers;
  const ot = active.maintenance.oneTime;
  const rec = active.maintenance.recurring;
  const softCap = active.landscape.softApprovalPayoutThreshold || 1500;
  const hardCap = active.landscape.hardCapPayout || 2500;

  // Build editable tier rows
  const tierRows = lTiers.map((t, i) => {
    const label = t.max ? `$${t.min.toLocaleString()}–$${t.max.toLocaleString()}` : `$${t.min.toLocaleString()}+`;
    if (t.selfGen === null || t.selfGen === undefined) {
      return `<tr class="gw-table-row">
        <td style="padding:7px 10px;font-size:12px;color:var(--gw-muted)">${label}</td>
        <td colspan="3" style="padding:7px 10px;font-size:12px;color:#8B6914;text-align:center">Management approval required</td>
      </tr>`;
    }
    return `<tr class="gw-table-row">
      <td style="padding:7px 10px;font-size:12px;color:var(--gw-muted)">${label}</td>
      <td style="padding:4px 6px"><input type="number" id="cr-ls-sg-${i}" value="${Math.round(t.selfGen*100)}" min="0" max="50" step="0.5"
        class="gw-input-sm" style="width:60px;color:var(--gw-emerald);font-weight:700;text-align:center"> %</td>
      <td style="padding:4px 6px"><input type="number" id="cr-ls-cl-${i}" value="${Math.round(t.companyLead*100)}" min="0" max="50" step="0.5"
        class="gw-input-sm" style="width:60px;color:#4D8A86;font-weight:700;text-align:center"> %</td>
      <td style="padding:4px 6px"><input type="number" id="cr-ls-as-${i}" value="${Math.round(t.assisted*100)}" min="0" max="50" step="0.5"
        class="gw-input-sm" style="width:60px;font-weight:700;text-align:center"> %</td>
    </tr>`;
  }).join('');

  function recInputs(srcKey, colorClass, idPrefix) {
    const r = rec[srcKey];
    if (!r) return '';
    return `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
      <span style="font-size:11px;color:${colorClass};font-weight:700;min-width:90px">${srcKey === 'selfGen' ? 'Self-Generated' : srcKey === 'companyLead' ? 'Company Lead' : 'Assisted'}</span>
      <label class="gw-label">T1%: <input type="number" id="${idPrefix}-t1" value="${Math.round(r.t1Rate*100)}" min="0" max="100" step="1"
        class="gw-input-sm" style="width:48px;text-align:center"></label>
      <label class="gw-label">T2%: <input type="number" id="${idPrefix}-t2" value="${Math.round(r.t2Rate*100)}" min="0" max="100" step="1"
        class="gw-input-sm" style="width:48px;text-align:center"></label>
      <label class="gw-label">T3%: <input type="number" id="${idPrefix}-t3" value="${Math.round(r.t3Rate*100)}" min="0" max="100" step="1"
        class="gw-input-sm" style="width:48px;text-align:center"></label>
      <label class="gw-label">Cap $: <input type="number" id="${idPrefix}-cap" value="${r.cap}" min="0" max="5000" step="25"
        class="gw-input-sm" style="width:60px;color:#8B6914;text-align:center"></label>
      <label class="gw-label">Bonus $: <input type="number" id="${idPrefix}-bonus" value="${r.retentionBonus}" min="0" max="500" step="5"
        class="gw-input-sm" style="width:55px;color:var(--gw-emerald);text-align:center"></label>
    </div>`;
  }

  return `
  <div class="gw-comm-panel">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:16px">
      <div>
        <div style="font-size:14px;font-weight:800;color:#E8E4D9">gwIcon('revenue',16) Commission Rules Manager</div>
        <div style="font-size:12px;color:#6F7E6A;margin-top:2px">Edit rates, caps, and thresholds. Changes apply immediately to all commission calculations.${updatedInfo}</div>
      </div>
      <div style="display:flex;gap:8px">
        <button onclick="window._saveCommRules()" class="gw-btn-primary">Save Rules</button>
        ${override ? `<button onclick="window._resetCommRules()" class="gw-btn-danger-ghost">Reset to Defaults</button>` : ''}
      </div>
    </div>

    <!-- Landscape tiers -->
    <div style="margin-bottom:16px">
      <div style="font-size:10px;font-weight:700;color:#5C6B58;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px">Landscape / Enhancement Tiers</div>
      <div style="overflow-x:auto">
        <table class="gw-data-table" style="border-radius:8px;overflow:hidden;font-size:12px">
          <thead><tr>
            <th style="padding:8px 10px;text-align:left;font-size:10px;letter-spacing:.05em">RANGE</th>
            <th style="padding:8px 10px;text-align:center;color:var(--gw-emerald);font-size:10px">SELF-GEN %</th>
            <th style="padding:8px 10px;text-align:center;color:#4D8A86;font-size:10px">CO. LEAD %</th>
            <th style="padding:8px 10px;text-align:center;font-size:10px">ASSISTED %</th>
          </tr></thead>
          <tbody>${tierRows}</tbody>
        </table>
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:8px">
        <label class="gw-label">Soft approval at payout $: <input type="number" id="cr-soft-cap" value="${softCap}" min="0" max="10000" step="50"
          class="gw-input-sm" style="width:80px;color:#8B6914;text-align:center"></label>
        <label class="gw-label">Hard cap $: <input type="number" id="cr-hard-cap" value="${hardCap}" min="0" max="20000" step="100"
          class="gw-input-sm" style="width:80px;color:#C97B6A;text-align:center"></label>
      </div>
    </div>

    <!-- Maintenance one-time -->
    <div style="margin-bottom:16px">
      <div style="font-size:10px;font-weight:700;color:#5C6B58;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px">Maintenance — One-Time / Seasonal</div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center">
        <label style="font-size:11px;color:var(--gw-emerald)">Self-Gen %: <input type="number" id="cr-ot-sg" value="${Math.round(ot.selfGen*100)}" min="0" max="50" step="0.5"
          class="gw-input-sm" style="width:55px;color:var(--gw-emerald);font-weight:700;text-align:center"></label>
        <label style="font-size:11px;color:#4D8A86">Co. Lead %: <input type="number" id="cr-ot-cl" value="${Math.round(ot.companyLead*100)}" min="0" max="50" step="0.5"
          class="gw-input-sm" style="width:55px;color:#4D8A86;font-weight:700;text-align:center"></label>
        <label style="font-size:11px;color:var(--gw-muted)">Assisted %: <input type="number" id="cr-ot-as" value="${Math.round(ot.assisted*100)}" min="0" max="50" step="0.5"
          class="gw-input-sm" style="width:55px;font-weight:700;text-align:center"></label>
        <label style="font-size:11px;color:#8B6914">Approval above $: <input type="number" id="cr-ot-approval" value="${ot.approvalAbove || 750}" min="0" max="5000" step="50"
          class="gw-input-sm" style="width:70px;color:#8B6914;text-align:center"></label>
      </div>
    </div>

    <!-- Recurring maintenance -->
    <div>
      <div style="font-size:10px;font-weight:700;color:#5C6B58;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px">Recurring Maintenance — Tiered First-Month</div>
      ${recInputs('selfGen',     '#2D7A55', 'cr-rec-sg')}
      ${recInputs('companyLead', '#4D8A86', 'cr-rec-cl')}
      ${recInputs('assisted',    '#6F7E6A', 'cr-rec-as')}
    </div>
  </div>`;
}
window.renderCommissionRulesPanel = renderCommissionRulesPanel;

// Save handler — reads all inputs and writes to avalonCommissionRulesV1
window._saveCommRules = function() {
  try {
    const basePlan = window.COMMISSION_PLANS ? window.COMMISSION_PLANS.ryan : null;
    if (!basePlan) { if (window.showToast) window.showToast('Engine not loaded', 'error'); return; }

    // Deep clone the base plan
    const plan = JSON.parse(JSON.stringify(basePlan));

    // Landscape tiers
    plan.landscape.tiers.forEach((t, i) => {
      if (t.selfGen !== null && t.selfGen !== undefined) {
        const sg = parseFloat(document.getElementById(`cr-ls-sg-${i}`)?.value || t.selfGen*100) / 100;
        const cl = parseFloat(document.getElementById(`cr-ls-cl-${i}`)?.value || t.companyLead*100) / 100;
        const as = parseFloat(document.getElementById(`cr-ls-as-${i}`)?.value || t.assisted*100) / 100;
        plan.landscape.tiers[i].selfGen     = sg;
        plan.landscape.tiers[i].companyLead = cl;
        plan.landscape.tiers[i].assisted    = as;
      }
    });
    plan.landscape.softApprovalPayoutThreshold = parseFloat(document.getElementById('cr-soft-cap')?.value || 1500);
    plan.landscape.hardCapPayout = parseFloat(document.getElementById('cr-hard-cap')?.value || 2500);

    // One-time
    plan.maintenance.oneTime.selfGen     = parseFloat(document.getElementById('cr-ot-sg')?.value || 6) / 100;
    plan.maintenance.oneTime.companyLead = parseFloat(document.getElementById('cr-ot-cl')?.value || 4) / 100;
    plan.maintenance.oneTime.assisted    = parseFloat(document.getElementById('cr-ot-as')?.value || 1.5) / 100;
    plan.maintenance.oneTime.approvalAbove = parseFloat(document.getElementById('cr-ot-approval')?.value || 750);

    // Recurring
    ['sg','cl','as'].forEach((k, idx) => {
      const srcKey = ['selfGen','companyLead','assisted'][idx];
      const prefix = `cr-rec-${k}`;
      const r = plan.maintenance.recurring[srcKey];
      if (!r) return;
      r.t1Rate = parseFloat(document.getElementById(`${prefix}-t1`)?.value || r.t1Rate*100) / 100;
      r.t2Rate = parseFloat(document.getElementById(`${prefix}-t2`)?.value || r.t2Rate*100) / 100;
      r.t3Rate = parseFloat(document.getElementById(`${prefix}-t3`)?.value || r.t3Rate*100) / 100;
      r.cap    = parseFloat(document.getElementById(`${prefix}-cap`)?.value || r.cap);
      r.retentionBonus = parseFloat(document.getElementById(`${prefix}-bonus`)?.value || r.retentionBonus);
    });

    // Save to localStorage
    const rules = { version: 1, plans: { ryan: plan } };
    if (typeof window.saveCommissionRules === 'function') window.saveCommissionRules(rules);
    else localStorage.setItem('avalonCommissionRulesV1', JSON.stringify({ ...rules, updatedAt: new Date().toISOString() }));
    if (window.showToast) window.showToast('Commission rules saved ✓');
    settings(); // re-render to show "Custom rules active" label
  } catch(e) { if (window.showToast) window.showToast('Error saving rules: ' + e.message, 'error'); }
};

window._resetCommRules = function() {
  if (!confirm('Reset commission rules to Avalon defaults? This removes any custom rates Tyler set.')) return;
  localStorage.removeItem('avalonCommissionRulesV1');
  if (window.showToast) window.showToast('Rules reset to defaults ✓');
  settings();
};

// ── Commission Admin Tool handlers (COMM-16, 17, 18) ─────────────────────────
window._runMigrationFromUI = function() {
  const result = window._migrateCommissionLifecycle ? window._migrateCommissionLifecycle() : null;
  const el = document.getElementById('comm-tool-result');
  if (!result) { if (el) el.textContent = 'Migration function not loaded — refresh and try again.'; return; }
  if (el) el.innerHTML = `<span style="color:#2D7A55">✓ Migration complete: ${result.migrated} opps updated, ${result.skipped} already migrated.</span>`;
  if (window.showToast) window.showToast(`Migration: ${result.migrated} updated, ${result.skipped} skipped ✓`);
};

window._runQAFromUI = function() {
  const el = document.getElementById('comm-tool-result');
  if (!window._commQA) { if (el) el.textContent = 'QA function not loaded — refresh and try again.'; return; }
  const { passed, failed, warnings, results } = window._commQA();
  const failItems = results.filter(r => r.status !== 'PASS');
  const statusColor = failed > 0 ? '#C97B6A' : warnings > 0 ? '#8B6914' : '#2D7A55';
  const icon = failed > 0 ? gwIcon('alert',16,'#C97B6A') : warnings > 0 ? gwIcon('warning',16,'#8B6914') : gwIcon('success',16,'#2D7A55');
  if (el) {
    el.innerHTML = `
      <div style="color:${statusColor};font-weight:700;margin-bottom:4px">${icon} QA: ${passed} passed · ${warnings} warnings · ${failed} failed</div>
      ${failItems.map(r => `<div style="color:${r.status==='PASS'?'#2D7A55':r.status==='WARN'?'#8B6914':'#C97B6A'};margin-left:8px">• ${r.name}${r.detail ? ' — ' + r.detail : ''}</div>`).join('')}
      <div style="color:#5C6B58;margin-top:4px;font-size:10px">Full report in browser console (F12)</div>`;
  }
};

window._showFlagPanel = function() {
  const flags = window.getCommissionFlags ? window.getCommissionFlags() : {};
  const el    = document.getElementById('comm-tool-result');
  if (!el) return;
  const rows = Object.entries(flags).map(([k, v]) => `
    <div class="gw-flag-row">
      <span style="font-size:12px;color:#6F7E6A">${k}</span>
      <button onclick="window._setCommFlag('${k}', ${!v}); window._showFlagPanel();"
        style="background:${v ? '#113931' : '#5C2318'};border:none;color:${v ? '#2D7A55' : '#C97B6A'};border-radius:6px;padding:3px 10px;font-size:11px;cursor:pointer;font-weight:700">
        ${v ? 'ON' : 'OFF'}
      </button>
    </div>`).join('');
  el.innerHTML = `
    <div class="gw-flag-panel">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <span style="font-size:12px;font-weight:700;color:#E8E4D9">Feature Flags</span>
        <button onclick="window._resetCommFlags();window._showFlagPanel();"
          style="font-size:10px;color:#C97B6A;background:none;border:none;cursor:pointer">Reset all</button>
      </div>
      ${rows}
    </div>`;
};

// ── COMM-05: Commission Simulator ─────────────────────────────────────────────
// Admin-only hypothetical calculator in Settings. Lets Tyler input any scenario
// and see exactly what the engine would calculate — rate matched, cap behavior,
// approval requirement, and note text — without touching any real deal.
function renderCommissionSimulator() {
  return `
  <div class="gw-sim-panel">
    <div class="gw-sim-header">
      <div>
        <div style="font-size:14px;font-weight:800;color:#E8E4D9">gwIcon('calculator',16) Commission Simulator</div>
        <div style="font-size:11px;color:#6F7E6A;margin-top:2px">Hypothetical — no data is saved or changed</div>
      </div>
      <button onclick="window._runCommSim()" class="gw-btn-primary">Calculate →</button>
    </div>

    <div style="padding:16px 18px;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px">

      <!-- Work Type -->
      <div>
        <label style="font-size:11px;font-weight:700;color:#6F7E6A;text-transform:uppercase;letter-spacing:.05em">Work Type</label>
        <select id="sim-workType" class="gw-select" style="width:100%;margin-top:5px">
          <option value="landscape">Landscape / Enhancement</option>
          <option value="maintenance_onetime">Maintenance — One-Time</option>
          <option value="maintenance_recurring">Maintenance — Recurring</option>
          <option value="maintenance_upsell">Maintenance — Upsell</option>
          <option value="hardscape">Hardscape</option>
          <option value="drainage">Drainage</option>
          <option value="design_build">Design-Build</option>
        </select>
      </div>

      <!-- Lead Source -->
      <div>
        <label style="font-size:11px;font-weight:700;color:#6F7E6A;text-transform:uppercase;letter-spacing:.05em">Lead Source</label>
        <select id="sim-leadSource" class="gw-select" style="width:100%;margin-top:5px">
          <option value="company_lead">Company Lead</option>
          <option value="self_generated">Self-Generated</option>
          <option value="assisted">Assisted</option>
        </select>
      </div>

      <!-- Job Value -->
      <div>
        <label style="font-size:11px;font-weight:700;color:#6F7E6A;text-transform:uppercase;letter-spacing:.05em">Job Value ($)</label>
        <input id="sim-jobValue" type="number" min="0" step="100" value="5000"
          class="gw-select" style="width:100%;margin-top:5px;box-sizing:border-box">
      </div>

      <!-- Collected -->
      <div>
        <label style="font-size:11px;font-weight:700;color:#6F7E6A;text-transform:uppercase;letter-spacing:.05em">Payment Collected?</label>
        <select id="sim-collected" class="gw-select" style="width:100%;margin-top:5px">
          <option value="yes">Yes — payment received</option>
          <option value="no">No — pending collection</option>
        </select>
      </div>

      <!-- Pre-approved -->
      <div>
        <label style="font-size:11px;font-weight:700;color:#6F7E6A;text-transform:uppercase;letter-spacing:.05em">Tyler Pre-Approved?</label>
        <select id="sim-approved" class="gw-select" style="width:100%;margin-top:5px">
          <option value="yes">Yes — approved</option>
          <option value="no">No — not yet approved</option>
        </select>
      </div>

    </div>

    <!-- Result panel — populated by _runCommSim() -->
    <div id="sim-result" class="gw-sim-result">
      Set your scenario above and click <strong>Calculate →</strong>
    </div>
  </div>`;
}
window.renderCommissionSimulator = renderCommissionSimulator;

window._runCommSim = function() {
  const workType   = document.getElementById('sim-workType')?.value   || 'landscape';
  const leadSource = document.getElementById('sim-leadSource')?.value || 'company_lead';
  const jobValue   = parseFloat(document.getElementById('sim-jobValue')?.value || 0);
  const collected  = document.getElementById('sim-collected')?.value  === 'yes';
  const approved   = document.getElementById('sim-approved')?.value   === 'yes';

  if (!window.calculateCommission) {
    document.getElementById('sim-result').innerHTML = '<span style="color:#C97B6A">Engine not loaded — refresh and try again.</span>';
    return;
  }

  const r = window.calculateCommission({ planId: 'ryan', workType, leadSource, jobValue, collected, approved, preview: false });

  const fmtC = n => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const fmtP = n => Math.round(n * 100) + '%';

  const amountColor = r.amount > 0 ? '#2D7A55' : (r.requiresApproval ? '#8B6914' : '#C97B6A');
  const capBadge    = r.capApplied ? `<span style="font-size:10px;background:#C97B6A;color:#fff;border-radius:10px;padding:2px 7px;margin-left:6px">CAPPED at ${fmtC(r.cap)}</span>` : '';
  const appBadge    = r.requiresApproval ? `<span style="font-size:10px;background:#7A5C10;color:#8B6914;border-radius:10px;padding:2px 7px;margin-left:6px">APPROVAL REQUIRED</span>` : '';
  const bonusEl     = r.retentionBonus > 0 ? `<div style="margin-top:8px;font-size:12px;color:#2D7A55">+ ${fmtC(r.retentionBonus)} retention bonus eligible after 90-day active period</div>` : '';
  const gateEl      = !collected && !r.requiresApproval && r.amount === 0
    ? `<div style="margin-top:6px;font-size:11px;color:#8B6914">gwIcon('warning',16) Collection gate: commission held until payment is received</div>` : '';

  document.getElementById('sim-result').innerHTML = `
    <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:8px">
      <span style="font-size:28px;font-weight:800;color:${amountColor}">${fmtC(r.amount)}</span>
      ${capBadge}${appBadge}
      <span style="font-size:13px;color:#6F7E6A">at ${fmtP(r.rate)} effective rate</span>
    </div>
    <div style="font-size:12px;color:#6F7E6A;margin-bottom:4px"><strong style="color:#6F7E6A">Rule applied:</strong> ${r.ruleApplied}</div>
    <div style="font-size:12px;color:#6F7E6A"><strong style="color:#6F7E6A">Explanation:</strong> ${r.note}</div>
    ${r.approvalReason ? `<div style="margin-top:6px;font-size:11px;color:#8B6914">gwIcon('warning',16) ${r.approvalReason}</div>` : ''}
    ${gateEl}${bonusEl}`;
};

// ── COMM-04: Commission Audit Trail Viewer ─────────────────────────────────────
function renderCommissionAuditTrail() {
  const audit = (typeof window.loadCommissionAudit === 'function') ? window.loadCommissionAudit() : [];
  if (!audit.length) {
    return `
    <div class="gw-audit-panel" style="padding:16px 18px">
      <div style="font-size:14px;font-weight:800;margin-bottom:6px">gwIcon('checklist',16) Commission Rule Audit Trail</div>
      <p style="color:var(--gw-muted);font-size:13px;margin:0">No rule changes recorded yet. Changes appear here when Tyler edits and saves commission rates.</p>
    </div>`;
  }

  const fmt = ts => { try { return new Date(ts).toLocaleString(undefined, { month:'short', day:'numeric', year:'numeric', hour:'2-digit', minute:'2-digit' }); } catch(e) { return ts; } };
  const rows = audit.slice(0, 10).map((entry, i) => {
    const isCreate = entry.action === 'rules_created';
    const color    = isCreate ? '#2D7A55' : '#4D8A86';
    const label    = isCreate ? 'Rules Created' : `Rules Updated → v${entry.after?.version || '?'}`;
    const actor    = entry.actor || 'admin';
    return `
    <div class="gw-audit-entry">
      <div style="width:8px;height:8px;border-radius:50%;background:${color};margin-top:5px;flex-shrink:0"></div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-size:12px;font-weight:700;color:${color}">${label}</span>
          <span style="font-size:11px;color:#5C6B58">by ${actor}</span>
          <span style="font-size:10px;color:#4A5947">${fmt(entry.ts)}</span>
        </div>
        ${entry.before ? `<div style="font-size:10px;color:#4A5947;margin-top:2px">Previous version: v${entry.before.version || 0}</div>` : ''}
      </div>
      ${i === 0 ? `<button onclick="window._showAuditDiff(${i})" class="gw-ghost-btn">View diff</button>` : ''}
    </div>`;
  }).join('');

  return `
  <div class="gw-audit-panel">
    <div class="gw-audit-panel-header">
      <div>
        <div style="font-size:14px;font-weight:800;color:#E8E4D9">gwIcon('checklist',16) Commission Rule Audit Trail</div>
        <div style="font-size:11px;color:#6F7E6A;margin-top:2px">${audit.length} change${audit.length !== 1 ? 's' : ''} recorded</div>
      </div>
    </div>
    <div style="padding:4px 18px 14px">${rows}</div>
    ${audit.length > 10 ? `<div style="padding:0 18px 12px;font-size:11px;color:#5C6B58">Showing 10 of ${audit.length} entries — last 50 retained</div>` : ''}
  </div>`;
}
window.renderCommissionAuditTrail = renderCommissionAuditTrail;

// Show a simple before/after diff modal for the most recent audit entry
window._showAuditDiff = function(idx) {
  const audit = (typeof window.loadCommissionAudit === 'function') ? window.loadCommissionAudit() : [];
  const entry = audit[idx];
  if (!entry) return;
  const before = entry.before ? JSON.stringify(entry.before, null, 2) : '(first save — no prior version)';
  const after  = JSON.stringify(entry.after,  null, 2);
  const modal  = document.createElement('div');
  modal.className = 'gw-modal-overlay';
  modal.innerHTML = `
    <div class="gw-diff-modal-box">
      <button onclick="this.closest('div[style]').remove()"
        style="position:absolute;top:12px;right:14px;background:transparent;border:none;color:#6F7E6A;font-size:22px;cursor:pointer;line-height:1">×</button>
      <h3 style="margin:0 0 16px;font-size:16px;color:#E8E4D9">Rule Change — ${new Date(entry.ts).toLocaleString()}</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div>
          <div style="font-size:11px;font-weight:700;color:#C97B6A;margin-bottom:6px;text-transform:uppercase">Before</div>
          <pre class="gw-diff-pre">${before}</pre>
        </div>
        <div>
          <div style="font-size:11px;font-weight:700;color:#2D7A55;margin-bottom:6px;text-transform:uppercase">After</div>
          <pre class="gw-diff-pre">${after}</pre>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
};

function _renderPermMatrixOld_deleted() {
  const perms = loadNavPerms();
  const roles = [
    { key: 'office_manager', label: 'Jen — Office Manager', color: '#8B6914' },
    { key: 'rep',            label: 'Ryan — Sales Rep',     color: '#2D7A55' }
  ];
  const views = [
    { key: 'today',       label: 'Today',              group: 'Home' },
    { key: 'myDashboard', label: 'My Dashboard',       group: 'Home' },
    { key: 'pipeline',    label: 'Pipeline',           group: 'Pipeline' },
    { key: 'lead',        label: 'Add Lead',           group: 'Pipeline' },
    { key: 'process',     label: 'Sales Process',      group: 'Sales Toolkit' },
    { key: 'forms',       label: 'Forms & Checklists', group: 'Sales Toolkit' },
    { key: 'scripts',     label: 'Scripts',            group: 'Sales Toolkit' },
    { key: 'templates',   label: 'Email Templates',    group: 'Sales Toolkit' },
    { key: 'objections',  label: 'Objection Handling', group: 'Sales Toolkit' },
    { key: 'calculator',  label: 'Pricing Tools',      group: 'Sales Toolkit' },
    { key: 'academy',     label: 'Sales Academy',      group: 'Learning' },
    { key: 'clients',      label: 'Clients & Properties',group: 'Pipeline' },
    { key: 'manager',     label: 'Manager Tools',      group: 'Admin' },
    { key: 'revenueAdmin',label: 'Financial Data Hub', group: 'Admin' },
    { key: 'integrations',label: 'Integrations',       group: 'Admin' },
    { key: 'settings',    label: 'Settings',           group: 'Admin' }
  ];

  const groups = [...new Set(views.map(v => v.group))];

  const tableRows = groups.map(group => {
    const groupViews = views.filter(v => v.group === group);
    return `
      <tr class=\"perm-group-row\"><td colspan=\"${roles.length + 1}\">${group}</td></tr>
      ${groupViews.map(v => `
      <tr style="border-bottom:1px solid var(--gw-line)">
        <td class="perm-section">${v.label}</td>
        ${roles.map(r => {
          const checked = (perms[r.key] || DEFAULT_NAV_PERMS[r.key] || []).includes(v.key);
          const isAdminView = v.key === 'settings';
          return `<td style="text-align:center;padding:10px">
            <input type="checkbox" ${checked ? 'checked' : ''} ${isAdminView ? 'disabled title="Settings always visible"' : ''}
              onchange="window._toggleNavPerm('${r.key}','${v.key}',this.checked)"
              style="accent-color:${r.color};cursor:${isAdminView ? 'not-allowed' : 'pointer'}">
          </td>`;
        }).join('')}
      </tr>`).join('')}
    `;
  }).join('');

  return `
  <section class="card" style="margin-top:20px;border:1px solid #4A5947">
    <h2>Permission Controls <span style="font-size:13px;color:#6F7E6A;font-weight:400;margin-left:8px">— Tyler (Owner) only</span></h2>
    <p style="color:#6F7E6A;font-size:13px;margin-bottom:16px">Control which sections each role can access. Changes take effect immediately. Tyler (Owner) always has full access.</p>
    <div style="overflow-x:auto">
      <table class="perm-table">
        <thead>
          <tr>
            <th>Section</th>
            ${roles.map(r => `<th style="color:${r.color}">${r.label}</th>`).join('')}
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
    <div style="margin-top:16px;display:flex;flex-wrap:wrap;gap:8px;align-items:center">
      <span style="font-size:11px;font-weight:700;color:#6F7E6A;text-transform:uppercase;letter-spacing:.05em;margin-right:4px">Quick Presets:</span>
      <button class="secondary-btn" style="font-size:11px" onclick="window._applyPermPreset('office_manager','full')">Jen · Full Access</button>
      <button class="secondary-btn" style="font-size:11px" onclick="window._applyPermPreset('office_manager','standard')">Jen · Standard</button>
      <button class="secondary-btn" style="font-size:11px" onclick="window._applyPermPreset('office_manager','view')">Jen · View Only</button>
      <span style="color:#4A5947">|</span>
      <button class="secondary-btn" style="font-size:11px" onclick="window._applyPermPreset('rep','full')">Ryan · Full Access</button>
      <button class="secondary-btn" style="font-size:11px" onclick="window._applyPermPreset('rep','standard')">Ryan · Standard</button>
      <button class="secondary-btn" style="font-size:11px" onclick="window._applyPermPreset('rep','view')">Ryan · View Only</button>
      <button class="secondary-btn" style="font-size:12px;margin-left:8px" onclick="window._resetNavPerms()">↺ Reset All Defaults</button>
    </div>
    <div style="font-size:11px;color:#5C6B58;margin-top:6px">Presets save instantly. Full = all tabs · Standard = hide admin/finance · View Only = today + pipeline only.</div>
  </section>`;
}

// _toggleNavPerm / _resetNavPerms / _applyPermPreset are now in user_management.js
// Keeping thin stubs here in case any legacy onclick= strings reference them.
window._toggleNavPerm = function(role, viewKey, enabled) {
  const perms = loadNavPerms();
  if (!perms[role]) perms[role] = [...(DEFAULT_NAV_PERMS[role] || [])];
  if (enabled) { if (!perms[role].includes(viewKey)) perms[role].push(viewKey); }
  else { perms[role] = perms[role].filter(v => v !== viewKey); }
  saveNavPerms(perms);
  showToast('Permission updated');
};
// ── Mark Sold Modal ───────────────────────────────────────────────────────────
function openMarkSoldModal(oppId) {
  const o = state.opportunities.find(x => x.id === oppId);
  if (!o) return;
  const backdrop = document.createElement('div');
  backdrop.className = 'sold-modal-backdrop';
  backdrop.id = 'soldModalBackdrop';
  backdrop.innerHTML = `
    <div class="sold-modal">
      <button class="sold-modal-close" onclick="closeMarkSoldModal()" title="Close">×</button>
      <div style="font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#2D7A55;margin-bottom:8px">Mark as Sold</div>
      <h2>${escapeHtml(o.client || 'Lead')} — Closed Won</h2>
      <p style="color:var(--muted);font-size:14px;margin-bottom:20px">${escapeHtml(o.project || o.serviceLine || 'Opportunity')} · ${escapeHtml(o.address || '')}</p>
      <div class="form-grid" style="gap:14px">
        <label style="display:grid;gap:6px">
          <span style="font-size:12px;font-weight:700;color:var(--blue-dark)">Sold Amount *</span>
          <input id="sm_amount" type="number" min="0" step="100" placeholder="e.g. 24500" style="border:1px solid var(--line);border-radius:10px;padding:10px 12px;font-size:15px;font-weight:600">
        </label>
        <label style="display:grid;gap:6px">
          <span style="font-size:12px;font-weight:700;color:var(--blue-dark)">Sold Date *</span>
          <input id="sm_date" type="date" value="${todayISO()}" style="border:1px solid var(--line);border-radius:10px;padding:10px 12px">
        </label>
        <label style="display:grid;gap:6px">
          <span style="font-size:12px;font-weight:700;color:var(--blue-dark)">Division / Service Line</span>
          <select id="sm_division" style="border:1px solid var(--line);border-radius:10px;padding:10px 12px">
            <option value="">— Select —</option>
            ${(window.AVALON_DATA?.serviceLines || ['Landscape','Maintenance','Snow & Ice']).map(s => `<option value="${escapeHtml(s)}" ${o.serviceLine===s?'selected':''}>${escapeHtml(s)}</option>`).join('')}
          </select>
        </label>
        <label style="display:grid;gap:6px">
          <span style="font-size:12px;font-weight:700;color:var(--blue-dark)">Contract Type</span>
          <select id="sm_contract" style="border:1px solid var(--line);border-radius:10px;padding:10px 12px">
            <option value="">— Select —</option>
            <option value="One-Time">One-Time Project</option>
            <option value="Recurring">Recurring Contract</option>
            <option value="Design-Build">Design / Build</option>
          </select>
        </label>
        <label style="display:grid;gap:6px;grid-column:1/-1">
          <span style="font-size:12px;font-weight:700;color:var(--blue-dark)">Sold Notes / Win Reason</span>
          <textarea id="sm_notes" rows="3" placeholder="What closed this deal?" style="border:1px solid var(--line);border-radius:10px;padding:10px 12px;resize:vertical"></textarea>
        </label>
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer">
          <input type="checkbox" id="sm_deposit" style="width:16px;height:16px;accent-color:#2D7A55">
          <span style="font-size:13px;font-weight:600">Deposit Collected</span>
        </label>
        <label style="display:grid;gap:6px">
          <span style="font-size:12px;font-weight:700;color:var(--blue-dark)">Expected Start Date</span>
          <input id="sm_startdate" type="date" style="border:1px solid var(--line);border-radius:10px;padding:10px 12px">
        </label>
      </div>
      <div style="display:flex;gap:10px;margin-top:24px">
        <button class="primary-btn" style="background:linear-gradient(135deg,#2D7A55,#2D7A55);flex:1;font-size:15px" onclick="confirmMarkSold('${oppId}')">Confirm — Mark Sold</button>
        <button class="secondary-btn" onclick="closeMarkSoldModal()">Cancel</button>
      </div>
    </div>
  `;
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeMarkSoldModal(); });
  document.body.appendChild(backdrop);
  document.getElementById('sm_amount').focus();
}

function closeMarkSoldModal() {
  const el = document.getElementById('soldModalBackdrop');
  if (el) el.remove();
}

function confirmMarkSold(oppId) {
  const amount = parseFloat(document.getElementById('sm_amount')?.value || '0');
  const date   = document.getElementById('sm_date')?.value || todayISO();
  if (!amount || amount <= 0) { showToast('Enter a sold amount first'); return; }
  const o = state.opportunities.find(x => x.id === oppId);
  if (!o) return;
  // Preserve previous stage for audit
  o.previousStatus  = o.status;
  o.status          = 'Sold / Activation';
  o.soldAmount      = amount;
  o.soldDate        = date;
  o.soldDivision    = document.getElementById('sm_division')?.value || o.serviceLine || '';
  o.contractType    = document.getElementById('sm_contract')?.value || '';
  o.soldNotes       = document.getElementById('sm_notes')?.value || '';
  o.depositCollected = document.getElementById('sm_deposit')?.checked || false;
  o.expectedStart   = document.getElementById('sm_startdate')?.value || '';
  o.updatedAt       = new Date().toISOString();
  saveState();
  closeMarkSoldModal();
  showToast(`${o.client} marked as sold — $${amount.toLocaleString()}`);
  show('pipeline', oppId);
}
window.openMarkSoldModal = openMarkSoldModal;
window.closeMarkSoldModal = closeMarkSoldModal;
window.confirmMarkSold = confirmMarkSold;

function exportJson(){ const blob = new Blob([JSON.stringify(state,null,2)],{type:'application/json'}); downloadBlob(blob,`groundwork-crm-backup-${todayISO()}.json`); }
function exportCsv(){ const headers=['client','phone','email','address','serviceLine','source','project','urgency','decisionMaker','budget','status','nextFollowUp','createdAt','updatedAt']; const rows=state.opportunities.map(o=>headers.map(h=>`"${String(o[h]||'').replace(/"/g,'""')}"`).join(',')); downloadBlob(new Blob([[headers.join(','),...rows].join('\n')],{type:'text/csv'}),`avalon-pipeline-${todayISO()}.csv`); }
function downloadBlob(blob,filename){ const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename; a.click(); URL.revokeObjectURL(a.href); }
function importJson(){ const file=document.getElementById('importFile').files[0]; if(!file) return showToast('Choose a JSON file first'); const reader=new FileReader(); reader.onload=()=>{ try{ state={...DEFAULT_STATE,...JSON.parse(reader.result)}; saveState(); showToast('Imported'); show('today'); }catch(e){ showToast('Import failed'); } }; reader.readAsText(file); }
function resetAll(){ localStorage.clear(); state=structuredClone(DEFAULT_STATE); saveState(); showToast('Reset complete'); show('today'); }
window.confirmReset = function(){
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal" style="max-width:420px;border:2px solid #5C2318">
      
      <h3 style="color:#C97B6A;text-align:center;margin:0 0 8px">Permanent Data Reset</h3>
      <p style="font-size:13px;color:#6F7E6A;text-align:center;margin:0 0 20px">This will delete <strong style="color:#C97B6A">all pipeline leads, notes, financials, and settings</strong> permanently. There is no undo.</p>
      <p style="font-size:12px;color:#6F7E6A;margin:0 0 8px">Type <strong style="color:#E8E4D9">RESET</strong> to confirm:</p>
      <input id="resetConfirmInput" type="text" placeholder="Type RESET here"
        class="gw-input-sm" style="width:100%;border-color:#5C2318;color:#C97B6A;font-size:14px;font-weight:700;letter-spacing:.1em;box-sizing:border-box;margin-bottom:14px;padding:10px 12px">
      <div style="display:flex;gap:8px">
        <button class="secondary-btn" style="flex:1" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
        <button class="danger-btn" id="resetConfirmBtn" style="flex:1;opacity:.4;pointer-events:none" onclick="window.doResetAll()">Reset All Data</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  document.getElementById('resetConfirmInput').addEventListener('input', function(){
    const btn = document.getElementById('resetConfirmBtn');
    const ready = this.value.trim() === 'RESET';
    btn.style.opacity = ready ? '1' : '.4';
    btn.style.pointerEvents = ready ? 'auto' : 'none';
  });
};
window.doResetAll = function(){
  document.querySelector('.modal-overlay')?.remove();
  resetAll();
};

function buildSearchIndex(){
  const items=[];
  data.stages.forEach(s=>items.push({type:'Stage',title:`${s.id}. ${s.title}`,text:[s.purpose,s.owner,s.artifact,s.gate,...(s.actions||[]),...(s.redFlags||[]),...(s.questions||[])].join(' '),action:()=>show('process',s.id)}));
  data.forms.forEach(f=>items.push({type:'Form',title:f.title,text:[...(f.fields||[]).map(x=>x.label)].join(' '),action:()=>show('forms',f.id)}));
  data.scripts.forEach(s=>items.push({type:s.category,title:s.title,text:s.body,action:()=>show('scripts')}));
  data.templates.forEach(t=>items.push({type:`Template: ${t.category}`,title:t.title,text:[t.subject,t.body].join(' '),action:()=>show('templates')}));
  data.objections.forEach(o=>items.push({type:'Objection',title:o.title,text:[o.meaning,o.say,...o.response].join(' '),action:()=>show('objections')}));
  data.modules.forEach(m=>items.push({type:'Training',title:m.title,text:[m.objective,...(m.lessons||[]),...(m.quiz||[]),...(m.keyPoints||[])].join(' '),action:()=>show('academy')}));
  data.checklists.forEach(c=>items.push({type:'Checklist',title:c.title,text:c.items.join(' '),action:()=>show('forms')}));
  (data.salesProcess?.steps||[]).forEach(s=>items.push({type:'6-Step Process',title:`Step ${s.num}: ${s.title}`,text:[s.tagline,s.description,...(s.tappo||[]).map(t=>t.description||''),...(s.nlpTips||[]),...(s.cbrQuestions||[])].join(' '),action:()=>show('process')}));
  return items;
}
const searchIndex = buildSearchIndex();
searchInput.addEventListener('input',()=>{
  const q=searchInput.value.trim().toLowerCase();
  if(q.length<2){ searchResults.hidden=true; return; }
  const results=searchIndex.filter(item=>`${item.title} ${item.text} ${item.type}`.toLowerCase().includes(q)).slice(0,10);
  searchResults.innerHTML = results.length ? results.map((r,i)=>`<button class="result" data-i="${i}"><div class="result-type">${escapeHtml(r.type)}</div><div class="result-title">${escapeHtml(r.title)}</div><div class="result-text">${escapeHtml(r.text.slice(0,160))}...</div></button>`).join('') : '<div class="result-text" style="padding:12px;">No results found.</div>';
  searchResults.hidden=false;
  [...searchResults.querySelectorAll('.result')].forEach((btn, i) => {
    btn.addEventListener('click', () => {
      searchResults.hidden = true;
      searchInput.value = '';
      searchIndex[Number(btn.dataset.i)].action();
    });
  });
});
document.addEventListener('click', e => {
  if (!e.target.closest('.search-wrap')) searchResults.hidden = true;
});

const sidebarScrim = document.getElementById('sidebarScrim');
function openSidebar()  { sidebar.classList.add('open');    if (sidebarScrim) sidebarScrim.classList.add('visible'); }
function closeSidebar() { sidebar.classList.remove('open'); if (sidebarScrim) sidebarScrim.classList.remove('visible'); }
menuBtn.addEventListener('click', (e) => { e.stopPropagation(); sidebar.classList.contains('open') ? closeSidebar() : openSidebar(); });
if (sidebarScrim) sidebarScrim.addEventListener('click', closeSidebar);
document.addEventListener('click', e => {
  if (sidebar.classList.contains('open') && !sidebar.contains(e.target) && !menuBtn.contains(e.target)) closeSidebar();
});

// ── + New dropdown ──────────────────────────────────────────────────────────
const _newBtn  = document.getElementById('topbarNewBtn');
const _newDrop = document.getElementById('topbarNewDropdown');
const _newWrap = document.getElementById('topbarNewWrap');
window._closeNewMenu = function() {
  if (_newDrop) { _newDrop.hidden = true; _newBtn.setAttribute('aria-expanded','false'); _newWrap.classList.remove('tnd-open'); }
};
if (_newBtn && _newDrop) {
  _newBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !_newDrop.hidden;
    if (isOpen) { window._closeNewMenu(); }
    else { _newDrop.hidden = false; _newBtn.setAttribute('aria-expanded','true'); _newWrap.classList.add('tnd-open'); }
  });
  document.addEventListener('click', (e) => {
    if (!_newWrap.contains(e.target)) window._closeNewMenu();
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// UNIVERSAL EXPORT MODAL — showExportModal(title, buildDataFn)
// Opens an overlay with 3 format buttons: CSV / Excel (.xlsx) / PDF
// buildDataFn must return { headers: [...], rows: [[...], ...], title: '...' }
// ══════════════════════════════════════════════════════════════════════════════

window.showExportModal = function(title, buildDataFn) {
  // Remove any existing export modal
  const existing = document.getElementById('exportModalOverlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'exportModalOverlay';
  overlay.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;
    display:flex;align-items:center;justify-content:center;padding:20px
  `;
  overlay.innerHTML = `
    <div class="gw-modal-card" style="max-width:400px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
        <div>
          <div style="font-size:10px;font-weight:700;color:#6F7E6A;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">Export Data</div>
          <h2 style="margin:0;color:#EDEAE0;font-size:1.1rem">${escapeHtml(title)}</h2>
        </div>
        <button onclick="document.getElementById('exportModalOverlay').remove()"
          class="gw-ghost-btn" style="padding:6px 10px;font-size:16px;line-height:1">×</button>
      </div>
      <p style="color:#6F7E6A;font-size:13px;margin:0 0 20px">Choose your preferred format:</p>
      <div style="display:grid;gap:10px">
        <button onclick="exportAsCSV('${escapeHtml(title)}', window._exportDataFn)"
          class="gw-export-btn"
          onmouseover="this.style.borderColor='var(--gw-sky)'" onmouseout="this.style.borderColor='var(--gw-line)'">
          
          <div>
            <div>CSV</div>
            <div style="font-size:11px;font-weight:400;color:#6F7E6A">Comma-separated, opens in Excel / Sheets</div>
          </div>
        </button>
        <button onclick="exportAsXLSX('${escapeHtml(title)}', window._exportDataFn)"
          class="gw-export-btn"
          onmouseover="this.style.borderColor='var(--gw-emerald)'" onmouseout="this.style.borderColor='var(--gw-line)'">
          
          <div>
            <div>Excel (.xlsx)</div>
            <div style="font-size:11px;font-weight:400;color:#6F7E6A">Native Excel workbook with formatting</div>
          </div>
        </button>
        <button onclick="exportAsPDF('${escapeHtml(title)}', window._exportDataFn)"
          class="gw-export-btn"
          onmouseover="this.style.borderColor='#C97B6A'" onmouseout="this.style.borderColor='var(--gw-line)'">
          
          <div>
            <div>PDF</div>
            <div style="font-size:11px;font-weight:400;color:#6F7E6A">Print-ready formatted report</div>
          </div>
        </button>
      </div>
    </div>
  `;
  // Store data builder so buttons can call it
  window._exportDataFn = buildDataFn;
  document.body.appendChild(overlay);
  // Close on backdrop click
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
};

// ── CSV Export ─────────────────────────────────────────────────────────────
window.exportAsCSV = function(title, buildDataFn) {
  const { headers, rows } = buildDataFn();
  const escape = v => `"${String(v == null ? '' : v).replace(/"/g,'""')}"`;
  const lines = [headers.map(escape).join(','), ...rows.map(r => r.map(escape).join(','))];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = title.replace(/[^a-z0-9]/gi, '-').toLowerCase() + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);
  document.getElementById('exportModalOverlay')?.remove();
  showToast('CSV exported — ' + title);
};

// ── Excel (.xlsx) Export — pure JS, no dependencies ────────────────────────
// Builds a minimal but valid .xlsx file using the OOXML spec.
// Cells with numeric values use number format; headers are bold.
window.exportAsXLSX = function(title, buildDataFn) {
  const { headers, rows } = buildDataFn();

  // Helper: encode XML chars
  const xe = s => String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&apos;');

  // Build shared strings table
  const strings = [];
  const strIdx = {};
  const si = v => {
    const s = String(v == null ? '' : v);
    if (strIdx[s] == null) { strIdx[s] = strings.length; strings.push(s); }
    return strIdx[s];
  };

  // Pre-register all strings
  headers.forEach(h => si(h));
  rows.forEach(row => row.forEach(cell => {
    const n = parseFloat(String(cell));
    if (isNaN(n) || String(cell).trim() === '') si(cell);
  }));

  // Worksheet rows XML
  const colLetter = i => {
    let s = '', n = i;
    while (n >= 0) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; }
    return s;
  };

  const buildRow = (rowData, rowNum, styleId) => {
    const cells = rowData.map((cell, ci) => {
      const col = colLetter(ci);
      const ref = `${col}${rowNum}`;
      const n = parseFloat(String(cell));
      const isNum = !isNaN(n) && String(cell).trim() !== '' && cell !== '';
      if (isNum) {
        return `<c r="${ref}" s="${styleId}" t="n"><v>${n}</v></c>`;
      } else {
        return `<c r="${ref}" s="${styleId}" t="s"><v>${si(cell)}</v></c>`;
      }
    });
    return `<row r="${rowNum}">${cells.join('')}</row>`;
  };

  const wsRows = [
    buildRow(headers, 1, 1), // style 1 = bold header
    ...rows.map((r, i) => buildRow(r, i + 2, 0))
  ].join('');

  const dimension = `A1:${colLetter(headers.length - 1)}${rows.length + 1}`;

  // XML parts
  const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">
${strings.map(s => `<si><t>${xe(s)}</t></si>`).join('')}
</sst>`;

  const worksheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="${dimension}"/>
  <sheetData>${wsRows}</sheetData>
</worksheet>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/></font>
  </fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/>
  </cellXfs>
</styleSheet>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="${xe(title.substring(0,31))}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  // Build zip using JSZip if available, otherwise fall back to CSV with .xlsx extension notice
  const doZip = (JSZip) => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', contentTypesXml);
    zip.file('_rels/.rels', relsXml);
    zip.file('xl/workbook.xml', workbookXml);
    zip.file('xl/_rels/workbook.xml.rels', workbookRels);
    zip.file('xl/worksheets/sheet1.xml', worksheetXml);
    zip.file('xl/sharedStrings.xml', sharedStringsXml);
    zip.file('xl/styles.xml', stylesXml);
    zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      .then(blob => {
        const fn = title.replace(/[^a-z0-9]/gi, '-').toLowerCase() + '.xlsx';
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = fn;
        a.click();
        URL.revokeObjectURL(a.href);
        document.getElementById('exportModalOverlay')?.remove();
        showToast('Excel exported — ' + title);
      });
  };

  if (window.JSZip) {
    doZip(window.JSZip);
  } else {
    // Load JSZip from CDN on demand (only when user actually clicks Excel)
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
    script.onload = () => doZip(window.JSZip);
    script.onerror = () => {
      showToast('Excel export unavailable — using CSV instead');
      window.exportAsCSV(title, buildDataFn);
    };
    document.head.appendChild(script);
  }
};

// ── PDF Export — print-styled hidden div ───────────────────────────────────
window.exportAsPDF = function(title, buildDataFn) {
  const { headers, rows } = buildDataFn();
  const xe = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const tableRows = rows.map((r, ri) => `
    <tr style="background:${ri % 2 === 0 ? '#FDFCF9' : '#ffffff'}">
      ${r.map(cell => `<td style="padding:7px 10px;border:1px solid #E8E4D9;font-size:12px;color:#113931">${xe(cell)}</td>`).join('')}
    </tr>`).join('');

  const printDiv = document.createElement('div');
  printDiv.id = 'avalonPrintArea';
  printDiv.innerHTML = `
    <div style="font-family:'Segoe UI',Arial,sans-serif;padding:24px;max-width:900px;margin:0 auto">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px;padding-bottom:14px;border-bottom:2px solid #113931">
        <div>
          <div style="font-size:10px;font-weight:700;color:#6F7E6A;text-transform:uppercase;letter-spacing:.08em;margin-bottom:2px">Avalon Landscaping</div>
          <h1 style="margin:0;font-size:20px;color:#113931;font-weight:800">${xe(title)}</h1>
          <div style="font-size:11px;color:#6F7E6A;margin-top:4px">Generated ${new Date().toLocaleDateString('en-US',{weekday:'short',year:'numeric',month:'long',day:'numeric'})}</div>
        </div>
        <div style="font-size:10px;color:#6F7E6A;text-align:right">FY 2026</div>
      </div>
      <table style="width:100%;border-collapse:collapse;font-family:inherit">
        <thead>
          <tr style="background:#113931">
            ${headers.map(h => `<th style="padding:9px 10px;text-align:left;color:#fff;font-size:12px;font-weight:700;border:1px solid #1A4740">${xe(h)}</th>`).join('')}
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
      <div style="margin-top:20px;font-size:10px;color:#6F7E6A;border-top:1px solid #E8E4D9;padding-top:10px">
        Avalon Landscaping — Confidential — ${new Date().getFullYear()}
      </div>
    </div>`;

  // Inject print CSS
  const style = document.createElement('style');
  style.id = 'avalonPrintStyle';
  style.textContent = `
    @media print {
      body > *:not(#avalonPrintArea) { display: none !important; }
      #avalonPrintArea { display: block !important; position: fixed; inset: 0; background: #fff; z-index: 99999; }
      @page { margin: 1cm; size: A4 landscape; }
    }
    #avalonPrintArea { display: none; }
  `;

  document.head.appendChild(style);
  document.body.appendChild(printDiv);
  document.getElementById('exportModalOverlay')?.remove();

  setTimeout(() => {
    window.print();
    // Clean up after print dialog closes
    setTimeout(() => {
      printDiv.remove();
      style.remove();
    }, 1000);
  }, 150);
};

// ── Financial Data Storage Keys ────────────────────────────────────────────────
const REV_ACTUALS_KEY      = 'avalonRevenueActuals';      // { "Jan": 21100, "note_Jan": "...", ... }
const DIV_ACTUALS_KEY      = 'avalonDivisionActuals';     // { landscape:{ Jan:{revenue,cogs,gmPct} }, maintenance:{...}, snow:{...} }
const ANNUAL_OVERRIDES_KEY = 'avalonAnnualOverrides';     // { grossMarginPct, trueNetIncome, loanMonthly, cogs, grossProfit, ... }
const PNL_FILES_KEY        = 'avalonPnlFiles';            // [{ id, name, date, type, size, data(base64 or csv-text) }]

function loadRevenueActuals() {
  try { return JSON.parse(localStorage.getItem(REV_ACTUALS_KEY)) || {}; }
  catch(e) { return {}; }
}
function saveRevenueActuals(actuals) {
  localStorage.setItem(REV_ACTUALS_KEY, JSON.stringify(actuals));
}
function loadDivisionActuals() {
  try { return JSON.parse(localStorage.getItem(DIV_ACTUALS_KEY)) || {}; }
  catch(e) { return {}; }
}
function saveDivisionActuals(d) {
  localStorage.setItem(DIV_ACTUALS_KEY, JSON.stringify(d));
}
function loadAnnualOverrides() {
  try { return JSON.parse(localStorage.getItem(ANNUAL_OVERRIDES_KEY)) || {}; }
  catch(e) { return {}; }
}
function saveAnnualOverrides(o) {
  localStorage.setItem(ANNUAL_OVERRIDES_KEY, JSON.stringify(o));
}
function loadPnlFiles() {
  try { return JSON.parse(localStorage.getItem(PNL_FILES_KEY)) || []; }
  catch(e) { return []; }
}
function savePnlFiles(files) {
  localStorage.setItem(PNL_FILES_KEY, JSON.stringify(files));
}

/**
 * getResolvedFY() — STRICT CASCADE
 * Data flows ONE WAY: avalonDivisionActuals → monthly totals → annual totals.
 * Division entries are the ONLY input for revenue. Monthly and annual values
 * are always computed — never independently overridden.
 *
 * avalonRevenueActuals  → stores ONLY note_* keys (no revenue values)
 * avalonDivisionActuals → per-division monthly revenue/COGS (the source of truth)
 * avalonAnnualOverrides → non-revenue fields only (expenses, loans, etc.)
 */
function getResolvedFY() {
  const raw = window.AVALON_DATA.fy2026;
  const fy  = JSON.parse(JSON.stringify(raw)); // deep clone

  const savedDivisions = loadDivisionActuals();
  const savedNotes     = loadRevenueActuals();   // ONLY note_* keys are used
  const savedAnnual    = loadAnnualOverrides();

  const DIVKEYS   = ['landscape', 'maintenance', 'snow'];
  const MONTH_ORD = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // STEP 1: Per-division YTD totals — sum all months from avalonDivisionActuals
  DIVKEYS.forEach(dk => {
    if (!fy.divisions[dk]) return;
    const divData = savedDivisions[dk] || {};
    let totalRev = 0, totalCogs = 0, hasAnyEntry = false;
    MONTH_ORD.forEach(mon => {
      const e = divData[mon];
      if (!e) return;
      hasAnyEntry = true;
      if (e.revenue != null) totalRev  += e.revenue;
      if (e.cogs    != null) totalCogs += e.cogs;
    });
    if (hasAnyEntry) {
      fy.divisions[dk].actual    = totalRev;
      fy.divisions[dk].cogs      = totalCogs;
      fy.divisions[dk].remaining = fy.divisions[dk].target - totalRev;
      fy.divisions[dk].grossMarginPct = totalRev > 0 ? (totalRev - totalCogs) / totalRev : 0;
    }
    // Division-level overrides (target, gmFloor only — not actual/cogs which come from division entries)
    const divOvr = (savedAnnual._divOverrides || {})[dk] || {};
    if (divOvr.grossMarginFloor != null) fy.divisions[dk].grossMarginFloor = divOvr.grossMarginFloor;
    if (divOvr.target           != null) fy.divisions[dk].target           = divOvr.target;
  });

  // STEP 2: Monthly totals — ALWAYS sum from division entries (no company-level override)
  fy.monthlyBudget = fy.monthlyBudget.map(m => {
    let monthTotal = null;
    DIVKEYS.forEach(dk => {
      const e = (savedDivisions[dk] || {})[m.month];
      if (e && e.revenue != null) {
        monthTotal = (monthTotal === null ? 0 : monthTotal) + e.revenue;
      }
    });
    // If no division data exists for this month, fall back to data.js seed value
    const hasDivData = DIVKEYS.some(dk => {
      const e = (savedDivisions[dk] || {})[m.month];
      return e !== undefined;
    });
    const actual   = hasDivData ? monthTotal : m.actual;
    const note     = savedNotes['note_' + m.month] || '';
    const variance = actual != null ? actual - m.budgeted : null;
    return { ...m, actual, variance, note };
  });

  // STEP 3: Annual revenue — always sum from completed months (never overridden)
  const completedMonths = fy.monthlyBudget.filter(m => m.actual != null);
  const pendingMonths   = fy.monthlyBudget.filter(m => m.actual == null);
  const ytdActual   = completedMonths.reduce((s, m) => s + m.actual, 0);
  const ytdBudgeted = completedMonths.reduce((s, m) => s + m.budgeted, 0);

  fy.annual = { ...fy.annual };
  fy.annual.actualRevenue     = ytdActual;
  fy.annual.remaining         = fy.annual.budgetedRevenue - ytdActual;
  fy.annual.ytdVariance       = ytdActual - ytdBudgeted;
  fy.annual.monthsLeft        = pendingMonths.length;
  fy.annual.avgNeededPerMonth = pendingMonths.length > 0
    ? Math.round(fy.annual.remaining / pendingMonths.length) : 0;

  // STEP 4: Non-revenue annual overrides only (expenses, loans, margins)
  const NON_REV_KEYS = ['cogs','grossProfit','grossMarginPct','totalExpenses',
                        'netOperatingIncome','netIncome','loans','loanMonthly','trueNetIncome'];
  NON_REV_KEYS.forEach(k => {
    if (savedAnnual[k] != null) fy.annual[k] = savedAnnual[k];
  });

  return fy;
}
window.getResolvedFY = getResolvedFY;


// ── Revenue Admin Tab State ───────────────────────────────────────────────────
let _revTab = 'monthly'; // 'monthly' | 'division' | 'annuals' | 'pnl'

// T40: Month drilldown modal — division breakdown + notes
window.showMonthDrilldown = function(monthKey) {
  const fy = getResolvedFY();
  const divActuals = loadDivisionActuals();
  const monthBudget = (fy.monthlyBudget || []).find(m => m.month === monthKey) || {};
  const notes = (loadRevenueActuals() || {})['note_' + monthKey] || '';
  const DIVISIONS = [
    { key:'landscape',   label:'Landscape',   icon:'<svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 15V9.5M9 9.5C9 9.5 5 9.5 3 5c3 0 6 2 6 4.5zm0 0c0 0 4 0 6-4.5-3 0-6 2-6 4.5z" stroke="#2D7A55" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>', color:'#2D7A55' },
    { key:'maintenance', label:'Maintenance',  icon:'<svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12.5 3a3 3 0 00-2.5 4.5L3.8 13.8a.8.8 0 001.2 1.2l6.5-5.7A3 3 0 0014 10a3 3 0 00-.5-1.5l-1.8 1.8-1.2-1.2 1.8-1.8A3 3 0 0012.5 3z" stroke="#4D8A86" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>', color:'#4D8A86' },
    { key:'snow',        label:'Snow & Ice',   icon:'<svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 2.5v13M2.5 9h13M4.5 4.5l9 9M13.5 4.5l-9 9" stroke="#B8C8C7" stroke-width="1.5" stroke-linecap="round"/><circle cx="9" cy="2.5" r="1" fill="#B8C8C7"/><circle cx="9" cy="15.5" r="1" fill="#B8C8C7"/><circle cx="2.5" cy="9" r="1" fill="#B8C8C7"/><circle cx="15.5" cy="9" r="1" fill="#B8C8C7"/></svg>', color:'#4D8A86' }
  ];
  function fmtM(n){ return n!=null ? n.toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}) : '—'; }
  const rows = DIVISIONS.map(d => {
    const entry = (divActuals[d.key]||{})[monthKey] || {};
    const rev = entry.revenue ?? null;
    const cogs = entry.cogs ?? null;
    const gm = (rev != null && cogs != null) ? rev - cogs : null;
    const gmPct = (gm != null && rev > 0) ? Math.round((gm/rev)*100) : null;
    return `<tr class="gw-table-row">
      <td style="padding:10px 12px;font-weight:600">${d.icon} ${d.label}</td>
      <td style="padding:10px 12px;text-align:right;color:${d.color};font-weight:700">${fmtM(rev)}</td>
      <td style="padding:10px 12px;text-align:right;color:#6F7E6A">${fmtM(cogs)}</td>
      <td style="padding:10px 12px;text-align:right;color:${gmPct!=null&&gmPct>=30?'#2D7A55':'#C97B6A'}">${gmPct!=null?gmPct+'%':'—'}</td>
    </tr>`;
  }).join('');
  const total = DIVISIONS.reduce((a,d) => a + ((divActuals[d.key]||{})[monthKey]?.revenue ?? 0), 0);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box" style="max-width:580px">
      <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button>
      <div style="font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#4D8A86;margin-bottom:6px">Month Drilldown</div>
      <h2 style="margin:0 0 4px">${monthKey} 2026</h2>
      <div style="display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap">
        <div><div style="font-size:10px;color:#6F7E6A;text-transform:uppercase;letter-spacing:.05em">Budgeted</div><div style="font-size:1.3rem;font-weight:800;color:#E8E4D9">${fmtM(monthBudget.budgeted)}</div></div>
        <div><div style="font-size:10px;color:#6F7E6A;text-transform:uppercase;letter-spacing:.05em">Actual</div><div style="font-size:1.3rem;font-weight:800;color:#4D8A86">${fmtM(monthBudget.actual)}</div></div>
        <div><div style="font-size:10px;color:#6F7E6A;text-transform:uppercase;letter-spacing:.05em">Variance</div><div style="font-size:1.3rem;font-weight:800;color:${(monthBudget.variance||0)>=0?'#2D7A55':'#C97B6A'}">${monthBudget.variance!=null?((monthBudget.variance>=0?'+':'')+fmtM(monthBudget.variance)):'—'}</div></div>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px">
        <thead><tr>
          <th style="padding:8px 12px;text-align:left">Division</th>
          <th style="padding:8px 12px;text-align:right">Revenue</th>
          <th style="padding:8px 12px;text-align:right">COGS</th>
          <th style="padding:8px 12px;text-align:right">GM%</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr style="border-top:2px solid var(--gw-line)">
          <td style="padding:10px 12px;font-weight:700">Total</td>
          <td style="padding:10px 12px;text-align:right;color:#4D8A86">${fmtM(total)}</td>
          <td colspan="2"></td>
        </tr></tfoot>
      </table>
      ${notes ? `<div class="gw-ann-field" style="font-size:13px;color:var(--gw-muted)"><strong>Notes:</strong> ${escapeHtml(notes)}</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="primary-btn" onclick="this.closest('.modal-overlay').remove();revenueAdmin('division')">Edit Division Data</button>
        <button class="secondary-btn" onclick="this.closest('.modal-overlay').remove()">Close</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
};

function revenueAdmin(tab) {
  if (tab) _revTab = tab;
  const fy = getResolvedFY();
  const savedActuals   = loadRevenueActuals();
  const savedDivisions = loadDivisionActuals();
  const savedAnnual    = loadAnnualOverrides();
  const pnlFiles       = loadPnlFiles();
  const months = (fy.monthlyBudget || []).map((m, idx) => ({ ...m, idx }));

  function fmtM(n) { return n != null ? n.toLocaleString(undefined, { style:'currency', currency:'USD', maximumFractionDigits:0 }) : '—'; }

  const ytdBudget  = months.filter(m => m.actual != null).reduce((a,m) => a + m.budgeted, 0);
  const ytdActual  = months.filter(m => m.actual != null).reduce((a,m) => a + m.actual, 0);
  const ytdVar     = ytdActual - ytdBudget;
  const ytdVarColor= ytdVar >= 0 ? '#2D7A55' : '#C97B6A';
  const dynamicMonthsLeft = months.filter(m => m.actual == null).length;

  // ── Tab Nav ──
  const tabNav = `
    <div class="gw-tab-nav">
      ${[['monthly','Monthly Totals'],['division','Division Entry'],['annuals','Annual Financials'],['pnl','P&L Files']].map(([t,label]) =>
        `<button onclick="revenueAdmin('${t}')" class="gw-tab-pill${_revTab===t?' active':''}">${label}</button>`
      ).join('')}
    </div>`;

  // ── Summary Banner (always shown) ──
  const banner = `
    <div class="gw-rev-banner">
      <div class="gw-rev-banner-grid">
        <div class="gw-rev-banner-cell">
          <div class="gw-kpi-banner-label">YTD Budget</div>
          <div id="rev_ytd_budget" class="gw-kpi-banner-val">${fmtM(ytdBudget)}</div>
        </div>
        <div class="gw-rev-banner-cell">
          <div class="gw-kpi-banner-label">YTD Actual</div>
          <div id="rev_ytd_actual" class="gw-kpi-banner-val" style="color:var(--gw-sky)">${fmtM(ytdActual)}</div>
        </div>
        <div class="gw-rev-banner-cell">
          <div class="gw-kpi-banner-label">YTD Variance</div>
          <div id="rev_ytd_var" class="gw-kpi-banner-val" style="color:${ytdVarColor}">${ytdVar >= 0 ? '+' : ''}${fmtM(ytdVar)}</div>
        </div>
        <div class="gw-rev-banner-cell">
          <div class="gw-kpi-banner-label">Remaining</div>
          <div class="gw-kpi-banner-val" style="color:#8B3A2A">${fmtM(fy.annual.remaining)}</div>
        </div>
        <div class="gw-rev-banner-cell">
          <div class="gw-kpi-banner-label">Needed / Mo</div>
          <div class="gw-kpi-banner-val" style="color:#8B6914">${fmtM(fy.annual.avgNeededPerMonth)}</div>
          <div class="gw-kpi-banner-sub">${dynamicMonthsLeft} months left</div>
        </div>
        <div class="gw-rev-banner-cell">
          <div class="gw-kpi-banner-label">Annual Budget</div>
          <div class="gw-kpi-banner-val" style="color:#4D8A86">${fmtM(fy.annual.budgetedRevenue)}</div>
        </div>
      </div>
    </div>`;

  // ── Tab: Monthly Totals ──
  function renderMonthlyTab() {
    // Revenue values are READ-ONLY — computed by summing division entries.
    // Only the Notes column is editable. To change revenue, use Division Entry tab.
    const savedNotes = loadRevenueActuals(); // only note_* keys
    const tableRows = months.map(m => {
      const hasActual = m.actual != null;
      const varColor  = m.variance == null ? '#4A5947' : m.variance >= 0 ? '#2D7A55' : '#C97B6A';
      const varSign   = m.variance != null && m.variance > 0 ? '+' : '';
      // Determine which divisions contributed data for this month
      const divs = loadDivisionActuals();
      const divBreakdown = ['landscape','maintenance','snow'].map(dk => {
        const e = (divs[dk]||{})[m.month];
        return (e && e.revenue != null) ? e.revenue : null;
      });
      const hasDivData = divBreakdown.some(v => v != null);
      return `<tr style="cursor:pointer" onclick="showMonthDrilldown('${m.month}')" title="Click for ${m.month} division breakdown">
        <td><span class="rev-month-tag">${escapeHtml(m.month)}</span>${hasActual ? '<span class="rev-locked-badge">auto</span>' : ''}</td>
        <td class="right" style="color:#6F7E6A">${fmtM(m.budgeted)}</td>
        <td class="right">
          <div style="font-weight:700;color:${hasActual ? '#4D8A86' : '#5C6B58'};font-size:14px;padding:6px 4px">
            ${hasActual ? fmtM(m.actual) : '<span style="color:#4A5947">—</span>'}
          </div>
          ${hasDivData ? `<div style="font-size:10px;color:#5C6B58;line-height:1.4">
            ${fmtM(divBreakdown[0])} · ${fmtM(divBreakdown[1])} · ${fmtM(divBreakdown[2])}
          </div>` : ''}
        </td>
        <td class="right" style="color:${varColor};font-weight:700">${m.variance != null ? varSign + fmtM(m.variance) : '—'}</td>
        <td>
          <input style="background:transparent;border:none;border-bottom:1px solid var(--gw-line);width:100%;color:var(--gw-muted);font-size:12px;padding:4px 0"
            placeholder="notes…"
            id="rev_note_text_${m.idx}"
            value="${escapeHtml(savedNotes['note_'+m.month]||'')}">
        </td>
      </tr>`;
    }).join('');

    return `
      <div class="gw-admin-panel">
        <div class="gw-admin-panel-header">
          <h2 style="margin:0;font-size:1rem">Budget vs Actual — Jan–Dec 2026</h2>
          <div style="display:flex;gap:8px">
            <button class="secondary-btn small" onclick="revSaveNotes()" style="background:#2D7A55;border-color:#2D7A55;color:#fff">Save Notes</button>
            <button class="secondary-btn small" onclick="showExportModal('Monthly Revenue', buildMonthlyExportData)">Export</button>
          </div>
        </div>
        <div style="overflow-x:auto">
          <table class="rev-editor-table" id="revTable">
            <thead><tr>
              <th>Month</th><th class="right">Budgeted</th><th class="right">Actual Revenue <span style="font-size:10px;color:#5C6B58;font-weight:400">(from divisions)</span></th><th class="right">Variance</th><th>Notes</th>
            </tr></thead>
            <tbody>${tableRows}</tbody>
            <tfoot>
              <tr>
                <td style="padding:12px;font-weight:700">YTD Total</td>
                <td class="right" style="padding:12px;color:var(--gw-muted)">${fmtM(ytdBudget)}</td>
                <td class="right" style="padding:12px;color:var(--gw-sky)">${fmtM(ytdActual)}</td>
                <td class="right" style="padding:12px;color:${ytdVarColor}">${ytdVar >= 0 ? '+' : ''}${fmtM(ytdVar)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
      <p style="color:#6F7E6A;font-size:12px;margin-top:8px">
        Monthly totals are <strong style="color:#4D8A86">automatically computed</strong> from division entries — they cannot be edited directly.
        To change revenue, go to the <strong style="color:#4D8A86">Division Entry</strong> tab.
      </p>`;
  }



  // ── Tab: Division Entry ──
  const DIVISIONS_META = [
    { key: 'landscape',   label: 'Landscape',    icon: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 15V9.5M9 9.5C9 9.5 5 9.5 3 5c3 0 6 2 6 4.5zm0 0c0 0 4 0 6-4.5-3 0-6 2-6 4.5z" stroke="#2D7A55" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>', color: '#2D7A55' },
    { key: 'maintenance', label: 'Maintenance',   icon: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12.5 3a3 3 0 00-2.5 4.5L3.8 13.8a.8.8 0 001.2 1.2l6.5-5.7A3 3 0 0014 10a3 3 0 00-.5-1.5l-1.8 1.8-1.2-1.2 1.8-1.8A3 3 0 0012.5 3z" stroke="#4D8A86" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>', color: '#4D8A86' },
    { key: 'snow',        label: 'Snow & Ice',    icon: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 2.5v13M2.5 9h13M4.5 4.5l9 9M13.5 4.5l-9 9" stroke="#B8C8C7" stroke-width="1.5" stroke-linecap="round"/><circle cx="9" cy="2.5" r="1" fill="#B8C8C7"/><circle cx="9" cy="15.5" r="1" fill="#B8C8C7"/><circle cx="2.5" cy="9" r="1" fill="#B8C8C7"/><circle cx="15.5" cy="9" r="1" fill="#B8C8C7"/></svg>', color: '#4D8A86' }
  ];
  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function renderDivisionTab() {
    const divSections = DIVISIONS_META.map(div => {
      const divData = savedDivisions[div.key] || {};
      const rows = MONTH_NAMES.map(mon => {
        const entry = divData[mon] || {};
        const rev  = entry.revenue != null ? entry.revenue : '';
        const cogs = entry.cogs    != null ? entry.cogs    : '';
        const gmPctCalc = (entry.revenue && entry.cogs != null)
          ? Math.round(((entry.revenue - entry.cogs) / entry.revenue) * 100) : '';
        return `<tr>
          <td><span class="rev-month-tag">${mon}</span></td>
          <td><input class="rev-editor-input" type="number" min="0" step="500"
            id="div_${div.key}_rev_${mon}" value="${rev}" placeholder="revenue"
            oninput="divUpdateRow('${div.key}','${mon}')"></td>
          <td><input class="rev-editor-input" type="number" min="0" step="500"
            id="div_${div.key}_cogs_${mon}" value="${cogs}" placeholder="COGS"
            oninput="divUpdateRow('${div.key}','${mon}')"></td>
          <td class="right" id="div_${div.key}_gm_${mon}" style="color:${gmPctCalc !== '' ? (gmPctCalc >= 30 ? '#2D7A55' : '#C97B6A') : '#4A5947'};font-weight:700">
            ${gmPctCalc !== '' ? gmPctCalc + '%' : '—'}
          </td>
        </tr>`;
      }).join('');

      // Totals
      let totalRev = 0, totalCogs = 0;
      MONTH_NAMES.forEach(mon => {
        const e = divData[mon] || {};
        if (e.revenue != null) totalRev  += e.revenue;
        if (e.cogs    != null) totalCogs += e.cogs;
      });
      const totalGm = totalRev > 0 ? Math.round(((totalRev - totalCogs) / totalRev) * 100) : 0;
      const divObj = fy.divisions[div.key] || {};

      return `
        <div class="gw-div-section">
          <div class="gw-div-section-header">
            <div style="display:flex;align-items:center;gap:10px">
              <span style="font-size:20px">${div.icon}</span>
              <div>
                <div style="font-weight:700;color:#E8E4D9;font-size:15px">${div.label}</div>
                <div style="font-size:11px;color:#6F7E6A">Target: ${fmtM(divObj.target)} · Actual YTD: <span style="color:${div.color}">${fmtM(totalRev || divObj.actual)}</span></div>
              </div>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <span style="font-size:11px;font-weight:700;color:${div.color}">${totalGm}% GM</span>
              <button class="secondary-btn small" onclick="divSaveDivision('${div.key}')" style="background:#1A4740;border-color:#1A4740;color:#4D8A86;font-size:11px">Save ${div.label}</button>
            </div>
          </div>
          <div style="overflow-x:auto">
            <table class="rev-editor-table" id="divTable_${div.key}">
              <thead><tr>
                <th>Month</th><th class="right">Revenue</th><th class="right">COGS</th><th class="right">GM %</th>
              </tr></thead>
              <tbody>${rows}</tbody>
              <tfoot>
                <tr>
                  <td style="padding:10px;font-weight:700">Totals</td>
                  <td class="right" style="padding:10px;color:var(--gw-sky)" id="div_${div.key}_total_rev">${fmtM(totalRev||null)}</td>
                  <td class="right" style="padding:10px;color:#6F7E6A" id="div_${div.key}_total_cogs">${fmtM(totalCogs||null)}</td>
                  <td class="right" style="padding:10px;color:${totalGm >= 30 ? '#2D7A55' : '#C97B6A'};font-weight:700" id="div_${div.key}_total_gm">${totalRev > 0 ? totalGm + '%' : '—'}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>`;
    }).join('');

    return `
      <p class="lede" style="margin-bottom:16px">Enter revenue and COGS for each division per month. Monthly totals auto-sum to the company total in the Monthly Totals tab.</p>
      <div style="display:flex;gap:8px;margin-bottom:16px">
        <button class="secondary-btn" onclick="divSaveAllDivisions()" style="background:#2D7A55;border-color:#2D7A55;color:#fff">Save All Divisions</button>
        <button class="secondary-btn" onclick="showExportModal('Division Actuals 2026', buildDivisionExportData)">Export</button>
      </div>
      ${divSections}`;
  }

  // ── Tab: Annual Financials ──
  function renderAnnualsTab() {
    const a = fy.annual;
    const fields = [
      { key:'grossMarginPct',      label:'Gross Margin %',       val: a.grossMarginPct != null ? Math.round(a.grossMarginPct*100) : '', unit:'%',  step:'1', placeholder:'e.g. 39',  note:'Overall company GM' },
      { key:'cogs',                label:'Total COGS',            val: a.cogs || '',             unit:'$',  step:'1000', placeholder:'e.g. 776854', note:'Total cost of goods sold' },
      { key:'grossProfit',         label:'Gross Profit',          val: a.grossProfit || '',       unit:'$',  step:'1000', placeholder:'e.g. 504287', note:'Revenue minus COGS' },
      { key:'totalExpenses',       label:'Total Expenses',        val: a.totalExpenses || '',     unit:'$',  step:'1000', placeholder:'e.g. 394792', note:'Operating expenses' },
      { key:'netOperatingIncome',  label:'Net Operating Income',  val: a.netOperatingIncome || '',unit:'$',  step:'1000', placeholder:'e.g. 109495', note:'After expenses' },
      { key:'netIncome',           label:'Net Income',            val: a.netIncome || '',         unit:'$',  step:'1000', placeholder:'e.g. 111783', note:'Before loan payments' },
      { key:'loans',               label:'Total Loans',           val: a.loans || '',             unit:'$',  step:'1000', placeholder:'e.g. 89059',  note:'Annual loan obligations' },
      { key:'loanMonthly',         label:'Monthly Loan Payment',  val: a.loanMonthly || '',       unit:'$',  step:'100',  placeholder:'e.g. 7421',   note:'Monthly principal+interest' },
      { key:'trueNetIncome',       label:'True Net Income',       val: a.trueNetIncome || '',     unit:'$',  step:'1000', placeholder:'e.g. 22723',  note:'Net income minus loans' },
    ];

    const divFinancials = DIVISIONS_META.map(div => {
      const d = fy.divisions[div.key] || {};
      return `
        <div class="gw-ann-field" style="margin-bottom:12px">
          <div style="font-weight:700;font-size:14px;margin-bottom:12px">${div.icon} ${div.label} Division</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px">
            <div>
              <label style="font-size:11px;color:#6F7E6A;display:block;margin-bottom:4px">Revenue Target</label>
              <input class="rev-editor-input" type="number" id="ann_${div.key}_target" value="${d.target||''}" placeholder="target" step="1000" style="width:100%">
            </div>
            <div>
              <label style="font-size:11px;color:#6F7E6A;display:block;margin-bottom:4px">Actual YTD Revenue <span style="font-size:9px;color:#5C6B58">(auto)</span></label>
              <div style="padding:8px 10px;background:var(--gw-surface-2);border:1px solid var(--gw-line);border-radius:8px;color:var(--gw-sky);font-weight:700;font-size:14px">${d.actual != null ? d.actual.toLocaleString(undefined,{style:'currency',currency:'USD',maximumFractionDigits:0}) : '—'}</div>
            </div>
            <div>
              <label style="font-size:11px;color:#6F7E6A;display:block;margin-bottom:4px">GM Floor %</label>
              <input class="rev-editor-input" type="number" id="ann_${div.key}_gmfloor" value="${d.grossMarginFloor != null ? Math.round(d.grossMarginFloor*100) : ''}" placeholder="floor %" step="1" min="0" max="100" style="width:100%">
            </div>
            <div>
              <label style="font-size:11px;color:#6F7E6A;display:block;margin-bottom:4px">Actual GM %</label>
              <input class="rev-editor-input" type="number" id="ann_${div.key}_gmpct" value="${d.grossMarginPct != null ? Math.round(d.grossMarginPct*100) : ''}" placeholder="actual GM %" step="1" min="0" max="100" style="width:100%">
            </div>
            <div>
              <label style="font-size:11px;color:#6F7E6A;display:block;margin-bottom:4px">COGS YTD</label>
              <input class="rev-editor-input" type="number" id="ann_${div.key}_cogs" value="${d.cogs||''}" placeholder="COGS" step="1000" style="width:100%">
            </div>
          </div>
        </div>`;
    }).join('');

    return `
      <p class="lede" style="margin-bottom:16px">Edit company-wide and division-level annual financial figures. Changes persist to localStorage and reflect in all dashboards.</p>

      <div style="margin-bottom:20px">
        <h3 style="color:#EDEAE0;font-size:14px;margin-bottom:12px">Company Annual Figures</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
          ${fields.map(f => `
          <div class="gw-ann-field">
            <label style="font-size:11px;color:var(--gw-muted);display:block;margin-bottom:4px">${f.label}</label>
            <div style="display:flex;align-items:center;gap:6px">
              ${f.unit === '$' ? '<span style="color:#6F7E6A;font-size:13px">$</span>' : ''}
              <input class="rev-editor-input" type="number" id="ann_${f.key}"
                value="${f.val}" placeholder="${f.placeholder}" step="${f.step}"
                style="flex:1">
              ${f.unit === '%' ? '<span style="color:#6F7E6A;font-size:13px">%</span>' : ''}
            </div>
            <div style="font-size:10px;color:#5C6B58;margin-top:4px">${f.note}</div>
          </div>`).join('')}
        </div>
      </div>

      <div style="margin-bottom:20px">
        <h3 style="color:#EDEAE0;font-size:14px;margin-bottom:12px">Division Annual Figures</h3>
        ${divFinancials}
      </div>

      <div style="display:flex;gap:8px">
        <button class="secondary-btn" onclick="annSaveAll()" style="background:#2D7A55;border-color:#2D7A55;color:#fff">Save All Annual Figures</button>
        <button class="secondary-btn" onclick="showExportModal('Annual Financials 2026', buildAnnualExportData)">Export</button>
        <button class="secondary-btn" onclick="annResetOverrides()" style="background:#5C2318;border-color:#7A2E20;color:#F5D5C8">Reset to Budget Defaults</button>
      </div>`;
  }

  // ── Tab: P&L Files ──
  function renderPnlTab() {
    const fileList = pnlFiles.length === 0
      ? '<p style="color:#6F7E6A;font-size:13px">No files uploaded yet. Upload a monthly P&L CSV or PDF below.</p>'
      : pnlFiles.map(f => `
        <div class="gw-pnl-file-row">
          <span style="font-size:20px">${f.type === 'csv' ? 'CSV' : 'DOC'}</span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:13px;color:#E8E4D9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(f.name)}</div>
            <div style="font-size:11px;color:#6F7E6A">${f.date} · ${f.size} · ${f.type.toUpperCase()}</div>
            ${f.period ? `<div style="font-size:11px;color:#4D8A86">Period: ${escapeHtml(f.period)}</div>` : ''}
          </div>
          <div style="display:flex;gap:6px">
            ${f.type === 'csv' ? `<button class="secondary-btn small" onclick="pnlImportCsv('${f.id}')" style="font-size:11px">Import to Divisions</button>` : ''}
            <button class="secondary-btn small" onclick="pnlDeleteFile('${f.id}')" style="background:#5C2318;border-color:#7A2E20;color:#F5D5C8;font-size:11px">×</button>
          </div>
        </div>`).join('');

    return `
      <p class="lede" style="margin-bottom:16px">Upload monthly P&L statements or financial reports. CSV files can be auto-imported into division actuals.</p>

      <div class="gw-upload-zone">
        
        <div style="color:#E8E4D9;font-weight:600;margin-bottom:4px">Upload P&L File</div>
        <div style="color:#6F7E6A;font-size:12px;margin-bottom:16px">CSV (auto-parsed) or PDF (stored as attachment) · Max 5MB</div>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-bottom:14px">
          <div>
            <label class="gw-label">Period Label</label>
            <input id="pnl_period" placeholder="e.g. June 2026" class="gw-input-sm" style="width:160px">
          </div>
        </div>
        <label style="cursor:pointer;display:inline-block">
          <input type="file" id="pnlFileInput" accept=".csv,.pdf" style="display:none" onchange="pnlHandleUpload(this)">
          <span class="gw-upload-choose">Choose File</span>
        </label>
      </div>

      <div style="margin-bottom:20px">
        <h3 class="gw-section-label" style="font-size:14px;margin-bottom:12px">Uploaded Files (${pnlFiles.length})</h3>
        ${fileList}
      </div>

      <div class="gw-ann-field">
        <h3 style="font-size:13px;margin-top:0;margin-bottom:8px">CSV Import Format</h3>
        <p style="color:#6F7E6A;font-size:12px;margin:0 0 8px">For auto-import to work, your CSV should include these columns:</p>
        <code class="gw-code-block">
          Month, Division, Revenue, COGS<br>
          Jan, Landscape, 25000, 14500<br>
          Jan, Maintenance, 40000, 28400<br>
          Jan, Snow, 18000, 7200
        </code>
        <p style="color:#6F7E6A;font-size:11px;margin-top:8px">Division values: Landscape / Maintenance / Snow (or Snow &amp; Ice)</p>
      </div>`;
  }

  // ── Render selected tab ──
  let tabContent = '';
  if (_revTab === 'monthly')   tabContent = renderMonthlyTab();
  else if (_revTab === 'division') tabContent = renderDivisionTab();
  else if (_revTab === 'annuals')  tabContent = renderAnnualsTab();
  else if (_revTab === 'pnl')      tabContent = renderPnlTab();

  view.innerHTML = `
    <button class="secondary-btn" onclick="show('manager')">← Back to Manager Tools</button>
    <div class="eyebrow" style="margin-top:16px">Admin — FY2026</div>
    <h1>Financial Data Hub</h1>
    <p class="lede">Division-first data entry · Monthly totals · Annual P&amp;L · Uploaded statements — all in one place.</p>
    ${banner}
    ${tabNav}
    ${tabContent}
  `;
}

// ── Monthly Tab helpers ───────────────────────────────────────────────────────
window.revUpdateRow = function(idx) {
  const fy = window.AVALON_DATA.fy2026;
  const months = fy.monthlyBudget || [];
  const m = months[idx];
  if (!m) return;
  const input = document.getElementById('rev_actual_' + idx);
  const rawVal = input?.value;
  const actual = rawVal !== '' && rawVal != null ? parseFloat(rawVal) : null;
  const variance = actual != null ? actual - m.budgeted : null;
  const varColor = variance == null ? '#4A5947' : variance >= 0 ? '#2D7A55' : '#C97B6A';
  const varSign  = variance != null && variance > 0 ? '+' : '';
  function fmtM(n) { return n != null ? n.toLocaleString(undefined, { style:'currency', currency:'USD', maximumFractionDigits:0 }) : '—'; }
  const varEl = document.getElementById('rev_var_' + idx);
  if (varEl) { varEl.textContent = variance != null ? varSign + fmtM(variance) : '—'; varEl.style.color = varColor; }
  // Recompute YTD from all current inputs
  let ytdBudget = 0, ytdActual = 0;
  months.forEach((mb, i) => {
    const inp = document.getElementById('rev_actual_' + i);
    const v = inp?.value !== '' && inp?.value != null ? parseFloat(inp.value) : null;
    if (v != null) { ytdBudget += mb.budgeted; ytdActual += v; }
  });
  const ytdVar = ytdActual - ytdBudget;
  const ytdVarColor = ytdVar >= 0 ? '#2D7A55' : '#C97B6A';
  const setEl = (id, txt, color) => { const el = document.getElementById(id); if (el) { el.textContent = txt; if (color) el.style.color = color; } };
  setEl('rev_ytd_budget', fmtM(ytdBudget));
  setEl('rev_ytd_actual', fmtM(ytdActual), '#4D8A86');
  setEl('rev_ytd_var', (ytdVar >= 0 ? '+' : '') + fmtM(ytdVar), ytdVarColor);
  setEl('rev_tfoot_budget', fmtM(ytdBudget));
  setEl('rev_tfoot_actual', fmtM(ytdActual));
  setEl('rev_tfoot_var', (ytdVar >= 0 ? '+' : '') + fmtM(ytdVar), ytdVarColor);
};

window.revSaveNotes = function() {
  // Under the strict cascade architecture, only notes are saved here.
  // Revenue values come exclusively from Division Entry (avalonDivisionActuals).
  const fy = window.AVALON_DATA.fy2026;
  const months = fy.monthlyBudget || [];
  const savedNotes = loadRevenueActuals(); // only note_* keys
  months.forEach((m, idx) => {
    const noteInp = document.getElementById('rev_note_text_' + idx);
    if (noteInp) {
      if (noteInp.value.trim()) savedNotes['note_' + m.month] = noteInp.value.trim();
      else delete savedNotes['note_' + m.month];
    }
    // Ensure no revenue keys sneak in
    delete savedNotes[m.month];
  });
  saveRevenueActuals(savedNotes);
  showToast('Monthly notes saved');
};

// Keep legacy revSaveAll as alias so any stale HTML references don't break
window.revSaveAll = window.revSaveNotes;

window.revExportCsv = function() {
  showExportModal('Monthly Revenue 2026', buildMonthlyExportData);
};

// Data builder for monthly export (CSV / Excel / PDF)
window.buildMonthlyExportData = function() {
  const fy = getResolvedFY();
  const headers = ['Month','Budgeted','Actual','Variance','Notes'];
  const rows = (fy.monthlyBudget || []).map(m => [
    m.month,
    m.budgeted != null ? m.budgeted : '',
    m.actual   != null ? m.actual   : '',
    m.variance != null ? m.variance : '',
    m.note     || ''
  ]);
  return { headers, rows, title: 'Monthly Revenue 2026' };
};

// Data builder for division export
window.buildDivisionExportData = function() {
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const DIVS   = [{key:'landscape',label:'Landscape'},{key:'maintenance',label:'Maintenance'},{key:'snow',label:'Snow'}];
  const all    = loadDivisionActuals();
  const headers = ['Month','Division','Revenue','COGS','GM%'];
  const rows = [];
  MONTHS.forEach(mon => {
    DIVS.forEach(d => {
      const e = (all[d.key] || {})[mon] || {};
      const rev  = e.revenue != null ? e.revenue : '';
      const cogs = e.cogs    != null ? e.cogs    : '';
      const gm   = (e.revenue && e.cogs != null)
        ? Math.round(((e.revenue - e.cogs) / e.revenue) * 100) + '%' : '';
      rows.push([mon, d.label, rev, cogs, gm]);
    });
  });
  return { headers, rows, title: 'Division Actuals 2026' };
};

// Data builder for annual financials export
window.buildAnnualExportData = function() {
  const fy = getResolvedFY();
  const a  = fy.annual;
  const headers = ['Metric','Value'];
  const rows = [
    ['Budgeted Revenue', a.budgetedRevenue || ''],
    ['Actual Revenue (YTD)', a.actualRevenue || ''],
    ['YTD Variance', a.ytdVariance || ''],
    ['Remaining', a.remaining || ''],
    ['Months Left', a.monthsLeft || ''],
    ['Avg Needed / Month', a.avgNeededPerMonth || ''],
    ['Gross Margin %', a.grossMarginPct != null ? Math.round(a.grossMarginPct*100)+'%' : ''],
    ['Total COGS', a.cogs || ''],
    ['Gross Profit', a.grossProfit || ''],
    ['Total Expenses', a.totalExpenses || ''],
    ['Net Operating Income', a.netOperatingIncome || ''],
    ['Net Income', a.netIncome || ''],
    ['Total Loans', a.loans || ''],
    ['Monthly Loan Payment', a.loanMonthly || ''],
    ['True Net Income', a.trueNetIncome || ''],
  ];
  return { headers, rows, title: 'Annual Financials 2026' };
};

// ── Division Tab helpers ──────────────────────────────────────────────────────
window.divUpdateRow = function(divKey, mon) {
  function fmtM(n) { return n != null ? n.toLocaleString(undefined, { style:'currency', currency:'USD', maximumFractionDigits:0 }) : '—'; }
  const revEl  = document.getElementById(`div_${divKey}_rev_${mon}`);
  const cogsEl = document.getElementById(`div_${divKey}_cogs_${mon}`);
  const gmEl   = document.getElementById(`div_${divKey}_gm_${mon}`);
  if (!revEl || !cogsEl || !gmEl) return;
  const rev  = revEl.value  !== '' ? parseFloat(revEl.value)  : null;
  const cogs = cogsEl.value !== '' ? parseFloat(cogsEl.value) : null;
  if (rev != null && cogs != null) {
    const gm = Math.round(((rev - cogs) / rev) * 100);
    gmEl.textContent = gm + '%';
    gmEl.style.color = gm >= 30 ? '#2D7A55' : '#C97B6A';
  } else {
    gmEl.textContent = '—';
    gmEl.style.color = '#4A5947';
  }
  // Recompute division totals
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  let totalRev = 0, totalCogs = 0;
  MONTHS.forEach(m => {
    const re = document.getElementById(`div_${divKey}_rev_${m}`);
    const ce = document.getElementById(`div_${divKey}_cogs_${m}`);
    const rv = re?.value !== '' && re ? parseFloat(re.value) : null;
    const cv = ce?.value !== '' && ce ? parseFloat(ce.value) : null;
    if (rv != null) totalRev  += rv;
    if (cv != null) totalCogs += cv;
  });
  const totalGm = totalRev > 0 ? Math.round(((totalRev - totalCogs) / totalRev) * 100) : 0;
  const setEl = (id, txt, color) => { const el = document.getElementById(id); if (el) { el.textContent = txt; if (color) el.style.color = color; } };
  setEl(`div_${divKey}_total_rev`,  fmtM(totalRev  || null));
  setEl(`div_${divKey}_total_cogs`, fmtM(totalCogs || null));
  setEl(`div_${divKey}_total_gm`,   totalRev > 0 ? totalGm + '%' : '—', totalGm >= 30 ? '#2D7A55' : '#C97B6A');
};

window.divSaveDivision = function(divKey) {
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const all = loadDivisionActuals();
  if (!all[divKey]) all[divKey] = {};
  MONTHS.forEach(mon => {
    const re = document.getElementById(`div_${divKey}_rev_${mon}`);
    const ce = document.getElementById(`div_${divKey}_cogs_${mon}`);
    if (!re) return;
    const rev  = re.value  !== '' ? parseFloat(re.value)  : null;
    const cogs = ce?.value !== '' ? parseFloat(ce.value) : null;
    if (rev != null || cogs != null) {
      all[divKey][mon] = {};
      if (rev  != null) all[divKey][mon].revenue = rev;
      if (cogs != null) all[divKey][mon].cogs    = cogs;
    } else {
      delete all[divKey][mon];
    }
  });
  saveDivisionActuals(all);
  // Update division header YTD display live
  let totalRev = 0, totalCogs = 0;
  MONTHS.forEach(mon => {
    const e = all[divKey][mon] || {};
    if (e.revenue != null) totalRev  += e.revenue;
    if (e.cogs    != null) totalCogs += e.cogs;
  });
  function fmtM(n) { return n != null ? n.toLocaleString(undefined,{style:'currency',currency:'USD',maximumFractionDigits:0}) : '—'; }
  // Also update the banner summary after save via re-rendering
  const label = divKey.charAt(0).toUpperCase() + divKey.slice(1);
  showToast(`${label} saved — monthly totals updated`);
};

window.divSaveAllDivisions = function() {
  ['landscape','maintenance','snow'].forEach(dk => window.divSaveDivision(dk));
  showToast('All division data saved — dashboards updated');
};

window.divExportCsv = function() {
  showExportModal('Division Actuals 2026', buildDivisionExportData);
};

// ── Annual Financials Tab helpers ─────────────────────────────────────────────
window.annSaveAll = function() {
  const overrides = loadAnnualOverrides();
  const FIELDS = ['grossMarginPct','cogs','grossProfit','totalExpenses','netOperatingIncome','netIncome','loans','loanMonthly','trueNetIncome'];
  FIELDS.forEach(k => {
    const el = document.getElementById('ann_' + k);
    if (!el) return;
    const v = el.value !== '' ? parseFloat(el.value) : null;
    if (v !== null && !isNaN(v)) {
      // grossMarginPct is entered as %, convert to decimal
      overrides[k] = (k === 'grossMarginPct') ? v / 100 : v;
    } else {
      delete overrides[k];
    }
  });
  // Division overrides
  const DIVKEYS = ['landscape','maintenance','snow'];
  const divActuals = loadDivisionActuals();
  DIVKEYS.forEach(dk => {
    if (!divActuals[dk]) divActuals[dk] = {};
    const ta  = document.getElementById(`ann_${dk}_target`);
    const ac  = document.getElementById(`ann_${dk}_actual`);
    const gmf = document.getElementById(`ann_${dk}_gmfloor`);
    const gmp = document.getElementById(`ann_${dk}_gmpct`);
    const cg  = document.getElementById(`ann_${dk}_cogs`);
    // Store division overrides inside a special key in avalonAnnualOverrides
    if (!overrides._divOverrides) overrides._divOverrides = {};
    if (!overrides._divOverrides[dk]) overrides._divOverrides[dk] = {};
    if (ta?.value !== '')  overrides._divOverrides[dk].target        = parseFloat(ta.value);
    if (ac?.value !== '')  overrides._divOverrides[dk].actual        = parseFloat(ac.value);
    if (gmf?.value !== '') overrides._divOverrides[dk].grossMarginFloor = parseFloat(gmf.value) / 100;
    if (gmp?.value !== '') overrides._divOverrides[dk].grossMarginPct   = parseFloat(gmp.value) / 100;
    if (cg?.value !== '')  overrides._divOverrides[dk].cogs             = parseFloat(cg.value);
  });
  saveAnnualOverrides(overrides);
  showToast('Annual financial figures saved — dashboards updated');
};

window.annResetOverrides = function() {
  if (!confirm('Reset all annual overrides to budget defaults? This cannot be undone.')) return;
  saveAnnualOverrides({});
  showToast('Annual figures reset to budget defaults');
  revenueAdmin('annuals');
};

// ── P&L Files Tab helpers ─────────────────────────────────────────────────────
window.pnlHandleUpload = function(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { showToast('File too large — max 5MB'); return; }
  const periodEl = document.getElementById('pnl_period');
  const period = periodEl ? periodEl.value.trim() : '';
  const reader = new FileReader();
  const isCsv = file.name.toLowerCase().endsWith('.csv');
  reader.onload = function(e) {
    const files = loadPnlFiles();
    const newFile = {
      id: 'pnl_' + Date.now(),
      name: file.name,
      period,
      date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      type: isCsv ? 'csv' : 'pdf',
      size: (file.size / 1024).toFixed(0) + ' KB',
      data: e.target.result
    };
    files.unshift(newFile);
    savePnlFiles(files);
    showToast('File uploaded: ' + file.name);
    if (isCsv) {
      showToast('CSV detected — use "Import to Divisions" to auto-parse data');
    }
    revenueAdmin('pnl');
  };
  if (isCsv) reader.readAsText(file);
  else reader.readAsDataURL(file);
};

window.pnlDeleteFile = function(fileId) {
  const files = loadPnlFiles().filter(f => f.id !== fileId);
  savePnlFiles(files);
  showToast('File removed');
  revenueAdmin('pnl');
};

window.pnlImportCsv = function(fileId) {
  const files = loadPnlFiles();
  const f = files.find(x => x.id === fileId);
  if (!f || f.type !== 'csv') return;
  const lines = f.data.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) { showToast('CSV is empty or unreadable'); return; }
  // Parse header
  const header = lines[0].split(',').map(h => h.replace(/"/g,'').trim().toLowerCase());
  const colIdx = { month: header.indexOf('month'), division: header.indexOf('division'), revenue: header.indexOf('revenue'), cogs: header.indexOf('cogs') };
  if (colIdx.month === -1 || colIdx.division === -1 || colIdx.revenue === -1) {
    showToast('CSV must have Month, Division, Revenue columns'); return;
  }
  const DIVMAP = { landscape: 'landscape', maintenance: 'maintenance', 'snow & ice': 'snow', snow: 'snow' };
  const all = loadDivisionActuals();
  let imported = 0;
  lines.slice(1).forEach(line => {
    const cols = line.split(',').map(c => c.replace(/"/g,'').trim());
    const mon  = cols[colIdx.month];
    const divLabel = (cols[colIdx.division] || '').toLowerCase().trim();
    const divKey = DIVMAP[divLabel];
    if (!divKey || !mon) return;
    if (!all[divKey]) all[divKey] = {};
    const rev  = parseFloat(cols[colIdx.revenue]) || null;
    const cogs = colIdx.cogs !== -1 ? (parseFloat(cols[colIdx.cogs]) || null) : null;
    if (rev != null) {
      all[divKey][mon] = { revenue: rev };
      if (cogs != null) all[divKey][mon].cogs = cogs;
      imported++;
    }
  });
  saveDivisionActuals(all);
  showToast(`Imported ${imported} entries from CSV into division actuals`);
  revenueAdmin('division');
};

window.revenueAdmin = revenueAdmin;

// ── Seed baseline actuals from data.js on first load ──────────────────────────
// Runs once: if localStorage keys are empty, pre-populates from AVALON_DATA's
// divisionMonthlyActuals + monthlyBudget so dashboards show real numbers immediately.
// User edits always take priority — this never overwrites existing data.
(function seedBaselineActuals() {
  // Runs once on first load: pre-populates avalonDivisionActuals from data.js if empty.
  // avalonRevenueActuals is NOT seeded with revenue — only division data is the source of truth.
  const raw = window.AVALON_DATA && window.AVALON_DATA.fy2026;
  if (!raw) return;

  // Seed avalonDivisionActuals from data.js divisionMonthlyActuals
  const existingDiv = loadDivisionActuals();
  const hasAnyDiv = Object.keys(existingDiv).some(k => Object.keys(existingDiv[k] || {}).length > 0);
  if (!hasAnyDiv && raw.divisionMonthlyActuals) {
    saveDivisionActuals(raw.divisionMonthlyActuals);
  }

  // Clean up any legacy revenue values from avalonRevenueActuals (keep only note_* keys)
  const existingRev = loadRevenueActuals();
  const hasLegacyRevenue = Object.keys(existingRev).some(k => !k.startsWith('note_'));
  if (hasLegacyRevenue) {
    const notesOnly = {};
    Object.keys(existingRev).forEach(k => {
      if (k.startsWith('note_')) notesOnly[k] = existingRev[k];
    });
    saveRevenueActuals(notesOnly);
  }
})();

// ── SUPER-ADMIN PLATFORM DASHBOARD ───────────────────────────────────────────
async function superAdmin() {
  const view = document.getElementById('view');
  if (!view) return;

  // Gate: only super admins may enter
  const d1Rep = window._d1SessionRep;
  const isSA = d1Rep && (d1Rep.is_super_admin === 1 || d1Rep.is_super_admin === true);
  if (!isSA) {
    view.innerHTML = `<div style="text-align:center;padding:80px 24px">
      <div style="font-size:48px;margin-bottom:16px">gwIcon('lock',16)</div>
      <h2 style="color:#C97B6A;margin-bottom:8px">Access Denied</h2>
      <p style="color:#6F7E6A">Platform Admin is restricted to super-administrators.</p>
      <button class="secondary-btn" style="margin-top:24px" onclick="show('today')">← Back to Today</button>
    </div>`;
    return;
  }

  // Loading state
  view.innerHTML = `<div style="padding:40px 24px;text-align:center;color:#6F7E6A">
    <div style="font-size:32px;margin-bottom:12px">gwIcon('shield',16)</div>Loading Platform Data…</div>`;

  // Fetch stats + company list in parallel
  let stats = {}, companies = [];
  try {
    const [sRes, cRes] = await Promise.all([
      fetch('/api/admin/stats',     { credentials: 'include' }),
      fetch('/api/admin/companies', { credentials: 'include' })
    ]);
    if (!sRes.ok || !cRes.ok) {
      const errBody = !sRes.ok ? await sRes.json().catch(()=>({})) : await cRes.json().catch(()=>({}));
      throw new Error(errBody.error || `HTTP ${!sRes.ok ? sRes.status : cRes.status}`);
    }
    const sData = await sRes.json();
    const cData = await cRes.json();
    // API wraps results in { ok: true, data: ... }
    stats     = sData.data  ?? sData;
    companies = cData.data  ?? cData;
    if (!Array.isArray(companies)) companies = [];
  } catch(e) {
    view.innerHTML = `<div style="padding:40px 24px;text-align:center">
      <p style="color:#C97B6A">Failed to load platform data: ${e.message}</p>
      <button class="secondary-btn" style="margin-top:16px" onclick="superAdmin()">↺ Retry</button>
    </div>`;
    return;
  }

  const fmt = n => (n ?? 0).toLocaleString();
  const dateStr = d => d ? new Date(d).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—';
  const planBadge = p => {
    const colors = { trial:'#8B6914', starter:'#1A4740', pro:'#4D8A86', enterprise:'#2D7A55' };
    const c = colors[p] || '#6F7E6A';
    return `<span style="display:inline-block;background:${c}22;color:${c};border:1px solid ${c}44;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;letter-spacing:.05em;text-transform:uppercase">${p || 'free'}</span>`;
  };

  const companyRows = companies.map(co => `
    <tr class="gw-table-row">
      <td style="padding:14px 12px">
        <div style="font-weight:700;color:#E8E4D9;margin-bottom:2px">${co.name || '—'}</div>
        <div style="font-size:11px;color:#5C6B58">${co.slug || ''}</div>
      </td>
      <td style="padding:14px 12px;text-align:center">${planBadge(co.plan)}</td>
      <td style="padding:14px 12px;text-align:center">
        <span style="color:${co.active ? '#2D7A55':'#C97B6A'};font-size:12px;font-weight:700">${co.active ? ' Active':' Inactive'}</span>
      </td>
      <td style="padding:14px 12px;text-align:center;color:#6F7E6A">${fmt(co.rep_count)}</td>
      <td style="padding:14px 12px;text-align:center;color:#6F7E6A">${fmt(co.opp_count)}</td>
      <td style="padding:14px 12px;text-align:center;color:#5C6B58;font-size:12px">${dateStr(co.last_activity)}</td>
      <td style="padding:14px 12px;text-align:center">
        <button onclick="window._saImpersonate('${co.id}','${(co.name||'').replace(/'/g,"\\'")}')"
          style="padding:6px 14px;background:#8B691422;border:1px solid #8B691444;border-radius:8px;color:#8B6914;font-size:12px;font-weight:700;cursor:pointer"
          onmouseover="this.style.background='#8B691433'" onmouseout="this.style.background='#8B691422'">
          Impersonate
        </button>
      </td>
    </tr>
  `).join('');

  view.innerHTML = `
  <div style="max-width:1200px;margin:0 auto;padding:32px 20px">

    <!-- Header -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:32px;flex-wrap:wrap;gap:16px">
      <div>
        <h1 style="font-size:28px;font-weight:800;color:#E8E4D9;margin:0 0 4px">gwIcon('shield',16) Platform Admin</h1>
        <p style="color:#6F7E6A;margin:0;font-size:14px">Groundwork CRM · All tenants · Super-admin view</p>
      </div>
      <button onclick="superAdmin()" class="gw-admin-btn" style="padding:8px 18px">↺ Refresh</button>
    </div>

    <!-- Stat Cards -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:36px">
      ${[
        { label:'Companies',      value: fmt(stats.companies),        icon: gwIcon('building',16,'#1A4740'), color:'#1A4740' },
        { label:'Active Tenants', value: fmt(stats.active_companies),  icon: gwIcon('success',16,'#2D7A55'), color:'#2D7A55' },
        { label:'Total Reps',     value: fmt(stats.reps),              icon: gwIcon('users',16,'#4D8A86'), color:'#4D8A86' },
        { label:'Opportunities',  value: fmt(stats.opportunities),     icon: gwIcon('reports',16,'#8B6914'), color:'#8B6914' },
        { label:'Notes',          value: fmt(stats.notes),             icon: gwIcon('note',16,'#4D8A86'), color:'#4D8A86' },
      ].map(s => `
        <div class="gw-div-tile" style="border-color:${s.color}44">
          <div style="font-size:24px;margin-bottom:8px">${s.icon}</div>
          <div style="font-size:28px;font-weight:800;color:${s.color};margin-bottom:4px">${s.value}</div>
          <div style="font-size:12px;color:#6F7E6A;font-weight:600;text-transform:uppercase;letter-spacing:.05em">${s.label}</div>
        </div>
      `).join('')}
    </div>

    <!-- Companies Table -->
    <div class="gw-admin-panel" style="border-radius:16px">
      <div class="gw-admin-panel-header" style="padding:20px 20px 16px">
        <h2 style="font-size:16px;font-weight:700;color:#E8E4D9;margin:0">All Companies (${companies.length})</h2>
        <a href="/onboard" target="_blank" style="padding:7px 16px;background:rgba(77,138,134,.13);border:1px solid #4D8A8644;border-radius:8px;color:#4D8A86;font-size:12px;font-weight:700;text-decoration:none">+ New Company</a>
      </div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead>
            <tr>
              <th style="padding:12px;text-align:left;color:#5C6B58;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em">Company</th>
              <th style="padding:12px;text-align:center;color:#5C6B58;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em">Plan</th>
              <th style="padding:12px;text-align:center;color:#5C6B58;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em">Status</th>
              <th style="padding:12px;text-align:center;color:#5C6B58;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em">Reps</th>
              <th style="padding:12px;text-align:center;color:#5C6B58;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em">Opps</th>
              <th style="padding:12px;text-align:center;color:#5C6B58;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em">Last Activity</th>
              <th style="padding:12px;text-align:center;color:#5C6B58;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${companyRows || '<tr><td colspan="7" style="padding:40px;text-align:center;color:#5C6B58">No companies found</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Quick Actions -->
    <div class="gw-admin-panel" style="margin-top:24px;padding:20px;border-radius:16px">
      <h3 style="font-size:14px;font-weight:700;color:#6F7E6A;margin:0 0 14px;text-transform:uppercase;letter-spacing:.05em">Quick Actions</h3>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <a href="/onboard" target="_blank"
          style="padding:10px 20px;background:rgba(32,74,67,.13);border:1px solid #1A474044;border-radius:10px;color:#1A4740;font-size:13px;font-weight:700;text-decoration:none">
          gwIcon('building',16) New Company Onboarding
        </a>
        <button onclick="superAdmin()"
          class="gw-admin-btn" style="padding:10px 20px">
          ↺ Reload Data
        </button>
      </div>
    </div>

    <!-- Impersonate confirm overlay -->
    <div id="saImpersonateOverlay" class="gw-modal-overlay" style="display:none">
      <div class="gw-modal-card" style="border-radius:20px">
        <h2 style="color:#E8E4D9;margin:0 0 8px;font-size:20px;font-weight:800">Impersonate Company</h2>
        <p id="saImpersonateMsg" style="color:#6F7E6A;margin:0 0 24px;font-size:14px"></p>
        <div style="display:flex;gap:12px">
          <button id="saImpersonateConfirmBtn"
            style="flex:1;padding:12px;background:#8B6914;border:none;border-radius:10px;color:#113931;font-size:14px;font-weight:800;cursor:pointer">
            Confirm Impersonate
          </button>
          <button onclick="document.getElementById('saImpersonateOverlay').style.display='none'"
            class="gw-admin-btn" style="padding:12px 20px">
            Cancel
          </button>
        </div>
      </div>
    </div>

  </div>`;

  // Wire up impersonate handler
  window._saImpersonate = async function(companyId, companyName) {
    const overlay = document.getElementById('saImpersonateOverlay');
    const msg     = document.getElementById('saImpersonateMsg');
    const btn     = document.getElementById('saImpersonateConfirmBtn');
    if (!overlay) return;
    msg.textContent = `You will be switched to view "${companyName}" as a member of that company. Your own session remains unchanged — refresh to return.`;
    overlay.style.display = 'flex';
    btn.onclick = async () => {
      btn.textContent = 'Switching…'; btn.disabled = true;
      try {
        const res = await fetch('/api/admin/impersonate', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ companyId })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed');
        // Server already set the httpOnly session cookie — just reload
        window._d1Ready       = false;
        window._d1SessionRep  = null;
        window._companyId     = companyId;
        showToast(`Switched to ${companyName} — reloading…`, 3000);
        overlay.style.display = 'none';
        setTimeout(() => location.reload(), 1000);
      } catch(e) {
        showToast('Impersonate failed: ' + e.message, 4000);
        btn.textContent = 'Confirm Impersonate'; btn.disabled = false;
      }
    };
  };
}
window.superAdmin = superAdmin;

show('today');
