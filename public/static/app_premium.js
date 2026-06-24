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
function saveState(){ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
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
function showToast(message){ toastEl.textContent = message; toastEl.hidden = false; setTimeout(()=>toastEl.hidden=true, 2200); }
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
      <div style="font-size:32px;margin-bottom:18px;color:#64748b;font-weight:300;letter-spacing:-2px">&#x2715;</div>
      <h2 style="color:#f87171;margin-bottom:10px">${_viewLabels[viewName] || viewName} — Access Restricted</h2>
      <p style="color:#64748b;max-width:420px;margin:0 auto 24px">Tyler (Owner) has restricted access to this section for your role.<br>Ask Tyler to enable it in <strong style="color:#e2e8f0">Settings → Permission Controls</strong>.</p>
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
  const routes = {today, pipeline, lead, clients, process, forms, scripts, templates, objections, calculator, academy, manager, settings, ...intRoute, ...repRoute, ...revenueRoute, ...umRoute, ai};
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
        const roleBadge = isAdmin
          ? `<span style="display:inline-block;background:#00d4ff;color:#0a0f1a;font-size:9px;font-weight:800;padding:1px 6px;border-radius:10px;letter-spacing:.05em;vertical-align:middle;margin-left:4px">OWNER</span>`
          : isOM
          ? `<span style="display:inline-block;background:#f59e0b;color:#0a0f1a;font-size:9px;font-weight:800;padding:1px 6px;border-radius:10px;letter-spacing:.05em;vertical-align:middle;margin-left:4px">OFFICE MGR</span>`
          : '';
        footer.innerHTML = `<span style="color:${rep.color};font-weight:700">${rep.name}${roleBadge}</span><br><span style="font-size:11px;color:#64748b">${rep.title}</span><br><button onclick="logoutRep();renderLoginScreen()" style="margin-top:6px;background:none;border:1px solid #334155;border-radius:6px;color:#64748b;font-size:11px;padding:4px 10px;cursor:pointer;width:100%">Switch Account</button>`;
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

  if(staleOpps.length) suggestions.push({icon:'<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="10" r="6" stroke="#fbbf24" stroke-width="1.5"/><path d="M9 7v4l2 1.5" stroke="#fbbf24" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 2h6" stroke="#fbbf24" stroke-width="1.3" stroke-linecap="round" opacity=".5"/></svg>',title:`${staleOpps.length} stale lead${staleOpps.length>1?'s':''} with no recent activity`,cta:'Review',onclick:`show('pipeline')`});
  if(proposalsPending.length) suggestions.push({icon:'<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="2" y="4" width="14" height="11" rx="1.5" stroke="#60a5fa" stroke-width="1.5"/><path d="M2 8h14" stroke="#60a5fa" stroke-width="1.3" opacity=".5"/><path d="M6 2v4M12 2v4" stroke="#60a5fa" stroke-width="1.4" stroke-linecap="round" opacity=".6"/><circle cx="13" cy="13" r="2.5" fill="#f87171" stroke="#0f172a" stroke-width="1"/><path d="M13 11.5v1.5M13 14h.01" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/></svg>',title:`${proposalsPending.length} proposal${proposalsPending.length>1?'s':''} awaiting a decision — follow up`,cta:'Open Proposals',onclick:`window._pipelineStatusFilter='proposals';show('pipeline')`});
  if(noNextStep.length) suggestions.push({icon:'<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="2" y="4" width="14" height="11" rx="1.5" stroke="#f59e0b" stroke-width="1.5"/><path d="M2 8h14" stroke="#f59e0b" stroke-width="1.3" opacity=".5"/><path d="M6 2v4M12 2v4" stroke="#f59e0b" stroke-width="1.4" stroke-linecap="round" opacity=".6"/><path d="M7 12h4M9 10v4" stroke="#f59e0b" stroke-width="1.4" stroke-linecap="round" opacity=".7"/></svg>',title:`${noNextStep.length} lead${noNextStep.length>1?'s':''} missing a next follow-up date`,cta:'Set Follow-Up',onclick:`show('pipeline')`});
  if(unassigned.length) suggestions.push({icon:'<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="7" r="3" stroke="#94a3b8" stroke-width="1.5"/><path d="M3 16c0-3 2.7-5 6-5s6 2 6 5" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round"/><path d="M14 4v4M12 6h4" stroke="#f59e0b" stroke-width="1.4" stroke-linecap="round"/></svg>',title:`${unassigned.length} unassigned lead${unassigned.length>1?'s':''} with no rep`,cta:'Assign Now',onclick:`show('pipeline')`});

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
  return `<div class="card mt" style="border-left:3px solid ${currentRep.color||'#00d4ff'}">
    <h3>${escapeHtml(currentRep.name)}'s Weekly Activity Targets</h3>
    <p class="muted small-text">Track these weekly — activity creates opportunity. Log in daily.</p>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px;margin-top:12px">
      ${Object.entries(repTargets).map(([k,v])=>`<div style="background:var(--bg2);border-radius:8px;padding:12px">
        <div style="font-size:.75rem;color:var(--muted);margin-bottom:4px">${escapeHtml(v.label)}</div>
        <div style="font-size:1.2rem;font-weight:700;color:${currentRep.color||'#00d4ff'}">${v.target !== undefined ? (v.floor ? '0 stale' : v.target+(v.frequency==='daily'?'/day':'/wk')) : (v.min === v.max ? v.min : (v.min||'—')+'–'+(v.max||'—'))}</div>
        ${v.description ? `<div style="font-size:.7rem;color:#64748b;margin-top:4px">${escapeHtml(v.description)}</div>` : ''}
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
  const urgencyDot = isOverdue ? `<span style="display:inline-block;width:7px;height:7px;background:#f87171;border-radius:50%;margin-right:4px;vertical-align:middle;flex-shrink:0"></span>` : '';
  const repObj = (window.REPS||[]).find(r => r.id === o.repId);
  const repPill = repObj
    ? `<span class="opp-rep-pill" style="display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:600;color:${repObj.color||'#94a3b8'};background:${repObj.color||'#94a3b8'}18;border:1px solid ${repObj.color||'#94a3b8'}40;border-radius:20px;padding:1px 7px;white-space:nowrap;flex-shrink:0">${escapeHtml(repObj.name)}</span>`
    : `<span class="opp-rep-pill" style="display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:600;color:#f59e0b;background:#f59e0b18;border:1px solid #f59e0b40;border-radius:20px;padding:1px 7px;white-space:nowrap;flex-shrink:0">⚠ Unassigned</span>`;
  return `<button class="mini-row ${isOverdue?'mini-row-overdue':''}" onclick="show('pipeline','${o.id}')">
    <strong>${urgencyDot}${escapeHtml(o.client||'Unnamed')}</strong>
    <span class="status-chip ${statusCssClass(o.status||'')}" style="font-size:10px;padding:1px 6px">${escapeHtml(o.status||'New Lead')}</span>
    <em>${escapeHtml(o.project||o.serviceLine||'Opportunity')}</em>
    <span style="display:flex;align-items:center;gap:6px;margin-left:auto;flex-shrink:0">
      ${repPill}
      ${daysSince !== null ? `<span style="font-size:10px;color:#475569">${daysSince===0?'Today':daysSince+'d ago'}</span>` : ''}
    </span>
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
    ? `<span class="urgency-badge stale">⏱ STALE ${daysSinceUpdate}d</span>`
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
        ? `<span class="opp-rep-pill" style="display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:600;color:${repObj.color||'#94a3b8'};background:${repObj.color||'#94a3b8'}18;border:1px solid ${repObj.color||'#94a3b8'}40;border-radius:20px;padding:1px 8px;white-space:nowrap;margin-left:auto">${escapeHtml(repObj.name)}</span>`
        : `<span class="opp-rep-pill" style="display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:600;color:#f59e0b;background:#f59e0b18;border:1px solid #f59e0b40;border-radius:20px;padding:1px 8px;white-space:nowrap;margin-left:auto">⚠ Unassigned</span>`}
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
  const divColors = { landscape:'#22d3ee', maintenance:'#4ade80', snow:'#60a5fa' };

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
    color: '#e2e8f0',
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
  localStorage.setItem(CLIENTS_KEY, JSON.stringify(list));
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
  const color = status==='Active' ? '#22c55e' : status==='Inactive' ? '#94a3b8' : '#f59e0b';
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
      <td>${clientStatusDot(c.status)} <span style="font-size:12px;color:#475569">${escapeHtml(c.status||'Active')}</span></td>
      <td class="cl-cell-addr">${addr ? escapeHtml(addr) : '<span class="cl-empty-cell">—</span>'}</td>
      <td class="cl-cell-contact">
        ${c.email ? `<a class="cl-link" href="mailto:${escapeHtml(c.email)}" onclick="event.stopPropagation()">${escapeHtml(c.email)}</a>` : ''}
        ${(c.phone||c.mobile) && c.email ? '<br>' : ''}
        ${escapeHtml(c.phone||c.mobile||(!c.email?'—':''))}
      </td>
      <td>${tagHtml}</td>
      <td style="text-align:center">${linkedOpps ? `<span class="cl-opp-count">${linkedOpps}</span>` : '<span style="color:#94a3b8;font-size:12px">—</span>'}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="7" style="text-align:center;padding:48px 24px;color:#94a3b8;font-size:14px">
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
          <circle cx="5.5" cy="5.5" r="4" stroke="#475569" stroke-width="1.4"/>
          <path d="M9 9l3 3" stroke="#475569" stroke-width="1.4" stroke-linecap="round"/>
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

    <div style="margin-top:10px;font-size:11px;color:#94a3b8;text-align:right">
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
          <label class="cl-form-label full"><span>Name <span style="color:#dc2626">*</span></span>
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
          <label class="cl-form-label full"><span>Tags <span style="color:#94a3b8;font-weight:400">(comma-separated)</span></span>
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
  saveClients(list);
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
      ? `<span style="font-size:10px;font-weight:600;color:${_repO.color||'#94a3b8'};background:${_repO.color||'#94a3b8'}18;border:1px solid ${_repO.color||'#94a3b8'}40;border-radius:20px;padding:1px 7px;white-space:nowrap;flex-shrink:0">${escapeHtml(_repO.name)}</span>`
      : `<span style="font-size:10px;font-weight:600;color:#f59e0b;background:#f59e0b18;border:1px solid #f59e0b40;border-radius:20px;padding:1px 7px;white-space:nowrap;flex-shrink:0">⚠ Unassigned</span>`;
    return `<button class="mini-row" onclick="show('pipeline','${o.id}')">
      <strong>${escapeHtml(o.client||'Unnamed')}</strong>
      <span class="status-chip ${statusCssClass(o.status||'')}" style="font-size:10px">${escapeHtml(o.status||'New Lead')}</span>
      <em>${escapeHtml(o.project||o.serviceLine||'Opportunity')}</em>
      <span style="display:flex;align-items:center;gap:5px;margin-left:auto;flex-shrink:0">
        ${_repPill}
        ${o.nextFollowUp ? `<span style="font-size:10px;color:#475569">${prettyDate(o.nextFollowUp)}</span>` : ''}
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
          ${c.homeworksId ? `<dt>Homeworks ID</dt><dd style="color:#64748b;font-size:12px">${escapeHtml(c.homeworksId)}</dd>` : ''}
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
    {v:'Landscape / Enhancement', icon:'<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 17V10M10 10C10 10 5 10 3 5c3.5 0 7 2 7 5zm0 0c0 0 5 0 7-5-3.5 0-7 2-7 5z" stroke="#4ade80" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 17c-2 0-3.5-.5-4-1" stroke="#4ade80" stroke-width="1.4" stroke-linecap="round" opacity=".5"/></svg>', short:'Landscape'},
    {v:'Maintenance - Recurring',  icon:'<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M14 4a3.5 3.5 0 00-3 5.2L4.6 15.6a1 1 0 001.4 1.4l6.4-6.4A3.5 3.5 0 0016 7.5a3.5 3.5 0 00-.5-1.8l-2 2-1.5-1.5 2-2A3.5 3.5 0 0014 4z" stroke="#22d3ee" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>', short:'Recurring Maint.'},
    {v:'Maintenance - One Time',   icon:'<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M14 4a3.5 3.5 0 00-3 5.2L4.6 15.6a1 1 0 001.4 1.4l6.4-6.4A3.5 3.5 0 0016 7.5a3.5 3.5 0 00-.5-1.8l-2 2-1.5-1.5 2-2A3.5 3.5 0 0014 4z" stroke="#22d3ee" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>', short:'One-Time Maint.'},
    {v:'Hardscape',                icon:'<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4" width="6" height="3" rx=".5" stroke="#f59e0b" stroke-width="1.4"/><rect x="11" y="4" width="6" height="3" rx=".5" stroke="#f59e0b" stroke-width="1.4"/><rect x="6.5" y="9" width="7" height="3" rx=".5" stroke="#f59e0b" stroke-width="1.4"/><rect x="3" y="14" width="4" height="3" rx=".5" stroke="#f59e0b" stroke-width="1.4" opacity=".7"/><rect x="9" y="14" width="5" height="3" rx=".5" stroke="#f59e0b" stroke-width="1.4" opacity=".7"/></svg>', short:'Hardscape'},
    {v:'Drainage',                 icon:'<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 3L13 8a3.5 3.5 0 11-6 0L10 3z" stroke="#60a5fa" stroke-width="1.5" stroke-linejoin="round"/><path d="M4 16h12" stroke="#60a5fa" stroke-width="1.5" stroke-linecap="round"/><path d="M7 16l1.5-3M13 16l-1.5-3" stroke="#60a5fa" stroke-width="1.3" stroke-linecap="round" opacity=".6"/></svg>', short:'Drainage'},
    {v:'Design / Build',           icon:'<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 16L15 5" stroke="#a78bfa" stroke-width="1.5" stroke-linecap="round"/><path d="M13 3l4 4-2 2-4-4 2-2z" stroke="#a78bfa" stroke-width="1.3" stroke-linejoin="round"/><path d="M4 16l-1 1 1-1zm0 0l2-1-1 1z" stroke="#a78bfa" stroke-width="1.3" stroke-linecap="round"/><rect x="3" y="12" width="8" height="2.5" rx=".5" transform="rotate(-45 3 12)" stroke="#a78bfa" stroke-width="1.3" opacity=".5"/></svg>', short:'Design / Build'},
    {v:'Irrigation',               icon:'<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 15 Q8 8 14 6" stroke="#60a5fa" stroke-width="1.5" stroke-linecap="round"/><circle cx="14" cy="6" r="1.3" fill="#60a5fa"/><path d="M10 4 Q12 3 14 4" stroke="#60a5fa" stroke-width="1.3" stroke-linecap="round" opacity=".6"/><path d="M12 7 Q15 5 17 6" stroke="#60a5fa" stroke-width="1.3" stroke-linecap="round" opacity=".6"/><path d="M11 10 Q14 9 16 10" stroke="#60a5fa" stroke-width="1.3" stroke-linecap="round" opacity=".4"/><path d="M3 16 Q4 14 5 15" stroke="#60a5fa" stroke-width="1.4" stroke-linecap="round"/></svg>', short:'Irrigation'},
    {v:'Outdoor Lighting',         icon:'<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 3a5 5 0 014 8l-1 1v1H7v-1L6 11a5 5 0 014-8z" stroke="#fbbf24" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 16h4" stroke="#fbbf24" stroke-width="1.4" stroke-linecap="round"/><path d="M8.5 16.5 Q10 18 11.5 16.5" stroke="#fbbf24" stroke-width="1.3" stroke-linecap="round"/><circle cx="3" cy="5" r="1" fill="#fbbf24" opacity=".4"/><circle cx="17" cy="5" r="1" fill="#fbbf24" opacity=".4"/><circle cx="10" cy="1.5" r="1" fill="#fbbf24" opacity=".4"/></svg>', short:'Lighting'},
    {v:'Other',                    icon:'<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="7" stroke="#64748b" stroke-width="1.4"/><circle cx="7" cy="10" r="1.2" fill="#64748b"/><circle cx="10" cy="10" r="1.2" fill="#64748b"/><circle cx="13" cy="10" r="1.2" fill="#64748b"/></svg>', short:'Other'},
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
            + '<span class="lf-comm-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="#4ade80" stroke-width="1.3"/><path d="M8 3v10M6 11c0 1 .9 1.5 2 1.5S10 12 10 11s-1-1.5-2-1.5S6 8 6 7s.9-1.5 2-1.5S10 5 10 6" stroke="#4ade80" stroke-width="1.2" stroke-linecap="round"/></svg></span>'
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
          + '<span class="lf-section-num" style="background:linear-gradient(135deg,#7c3aed,#6d28d9)">4</span>'  
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

    state.opportunities.unshift(opp); saveState(); showToast('Lead saved'); show('pipeline', opp.id);
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
        + dupes.map(o => '<span onclick="show(\'pipeline\',\'' + o.id + '\')" style="cursor:pointer;color:#00d4ff;text-decoration:underline">' + escapeHtml(o.client||'—') + ' · ' + escapeHtml(o.status||'') + '</span>').join('<br>');
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
  const stageGuess = Math.max(1, data.statuses.indexOf(o.status)+1);
  const _activeTab = window._leadTab || 'overview';

  view.innerHTML = `
    <button class="secondary-btn" onclick="show('pipeline')">← Back to Pipeline</button>
    ${(()=>{
      const _repObj = (window.REPS||[]).find(r=>r.id===o.repId);
      const _repName = _repObj ? _repObj.name : null;
      const _repAvatar = '';
      const _isOvd = o.nextFollowUp && o.nextFollowUp < todayISO() && !['Sold / Activation','Closed Lost'].includes(o.status);
      const _estComm = estCommission(o);
      return `<div class="lead-header-bar">
        <div class="lhb-cell">
          <span class="lhb-label">Stage</span>
          <span class="status-chip ${statusCssClass(o.status||'')}" style="font-size:11px">${escapeHtml(o.status||'New Lead')}</span>
        </div>
        <div class="lhb-cell">
          <span class="lhb-label">Rep</span>
          <span>${escapeHtml(_repName||'Unassigned')}</span>
        </div>
        <div class="lhb-cell">
          <span class="lhb-label">Est. Value</span>
          <strong>${o.jobValue ? money(Number(o.jobValue)) : '—'}</strong>
        </div>
        <div class="lhb-cell">
          <span class="lhb-label">Est. Commission</span>
          <strong style="color:#4ade80">${_estComm > 0 ? money(_estComm) : '—'}</strong>
        </div>
        <div class="lhb-cell">
          <span class="lhb-label">Next Follow-Up</span>
          <span class="${_isOvd ? 'overdue-chip' : ''}">${prettyDate(o.nextFollowUp)}</span>
        </div>
        <div class="lhb-cell">
          <span class="lhb-label">Commission</span>
          <span class="status-chip ${o.commissionApproved ? 'sold' : 'pending'}" style="font-size:10px">${o.commissionApproved ? 'Approved' : '⏳ Pending'}</span>
        </div>
      </div>`;
    })()}
    <div class="detail-head">
      <div><div class="eyebrow">Opportunity</div><h1>${escapeHtml(o.client||'Unnamed Lead')}</h1><p class="lede">${escapeHtml(o.project||o.serviceLine||'Opportunity')} • ${escapeHtml(o.address||'No address')}</p></div>
      <div class="detail-actions">
        <button class="primary-btn" onclick="saveOpportunity('${o.id}')">Save Changes</button>
        ${o.status !== 'Sold / Activation' && o.status !== 'Closed Lost' ? `<button class="primary-btn" style="background:linear-gradient(135deg,#16a34a,#15803d);box-shadow:0 8px 20px rgba(22,163,74,.25)" onclick="openMarkSoldModal('${o.id}')">Mark Sold</button>` : o.status === 'Sold / Activation' ? `<span style="background:#16a34a18;border:1px solid #16a34a40;border-radius:999px;padding:8px 14px;font-size:13px;font-weight:700;color:#16a34a">Sold</span>` : ''}
        ${(()=>{ const _cr = window.getCurrentRep ? window.getCurrentRep() : null; const _ia = _cr && _cr.role === 'admin'; const _iom = _cr && _cr.role === 'office_manager'; return _ia ? `<button class="secondary-btn" onclick="duplicateOpportunity('${o.id}')">Duplicate</button><button class="danger-btn" onclick="deleteOpportunity('${o.id}')">Delete</button>` : _iom ? `<button class="secondary-btn" onclick="duplicateOpportunity('${o.id}')">Duplicate</button>` : ''; })()}
      </div>
    </div>

    <!-- Lead Tab Bar -->
    <div class="lead-tab-bar">
      <button class="lead-tab ${_activeTab==='overview'?'lead-tab-active':''}" onclick="window._leadTab='overview';show('pipeline','${o.id}')">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1.5" y="2" width="11" height="10" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M4 5h6M4 7.5h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        Overview
      </button>
      <button class="lead-tab ${_activeTab==='comms'?'lead-tab-active':''}" onclick="window._leadTab='comms';show('pipeline','${o.id}')">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 2.5A.5.5 0 012.5 2h9a.5.5 0 01.5.5v6a.5.5 0 01-.5.5H8L5.5 12V9H2.5A.5.5 0 012 8.5v-6z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
        Communications
        ${(()=>{ const _cnt=(state.communications||[]).filter(c=>c.oppId===o.id).length; return _cnt ? '<span class="lead-tab-badge">'+_cnt+'</span>' : ''; })()}
      </button>
      <button class="lead-tab ${_activeTab==='files'?'lead-tab-active':''}" onclick="window._leadTab='files';show('pipeline','${o.id}')">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 2h5.5L11 4.5V12H3V2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 2v3h3" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" opacity=".6"/></svg>
        Files & Attachments
        ${(()=>{ const _acnt=(state.communications||[]).filter(c=>c.oppId===o.id&&c.files&&c.files.length).reduce((a,c)=>a+c.files.length,0); return _acnt ? '<span class="lead-tab-badge">'+_acnt+'</span>' : ''; })()}
      </button>
    </div>

    <!-- TAB: Overview (all existing content) -->
    <div id="leadTabOverview" style="display:${_activeTab==='overview'?'block':'none'}">
    <div class="grid grid-3 mt">
      <article class="card"><h3>Status</h3>${selectWithId('statusEdit',data.statuses,o.status)}<button class="secondary-btn small mt8" onclick="setOppField('${o.id}','status',document.getElementById('statusEdit').value)">Update Status</button></article>
      <article class="card"><h3>Next Follow-Up</h3><input id="followEdit" type="date" value="${escapeHtml(o.nextFollowUp||'')}"><button class="secondary-btn small mt8" onclick="setOppField('${o.id}','nextFollowUp',document.getElementById('followEdit').value)">Update Follow-Up</button></article>
      <article class="card"><h3>Quick Stage Help</h3><p class="muted">Use the process page to confirm what this stage requires before moving forward.</p><button class="secondary-btn small" onclick="show('process',${Math.min(stageGuess,12)})">Open likely stage</button></article>
    </div>
    <form class="card form mt" id="oppForm">
      <div class="form-grid">
        ${inputEdit('client','Client Name',o.client)}${inputEdit('phone','Phone',o.phone)}${inputEdit('email','Email',o.email,'email')}${inputEdit('address','Property Address',o.address)}
        ${selectEdit('serviceLine','Service Line',data.serviceLines,o.serviceLine)}${selectEdit('source','Lead Source',data.leadSources,o.source)}${inputEdit('project','Project / Opportunity Name',o.project)}${inputEdit('urgency','Urgency / Timing',o.urgency)}${inputEdit('decisionMaker','Decision-Maker(s)',o.decisionMaker)}${inputEdit('budget','Budget language / range',o.budget)}
      </div>
      <div class="form-grid" style="margin-top:16px;padding-top:16px;border-top:1px solid #1e293b">
        <div style="grid-column:1/-1;margin-bottom:4px">
          <span style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#7c3aed">Estimate Tracking</span>
          <span style="font-size:11px;color:#475569;margin-left:8px">Paper on the Street data</span>
        </div>
        <label><span>Estimate Status</span>
          <select id="estimateStatusEdit" name="estimateStatus">
            <option value="" ${!o.estimateStatus?'selected':''}>Not started</option>
            <option value="draft"             ${o.estimateStatus==='draft'?'selected':''}>Draft — not yet sent</option>
            <option value="sent"              ${o.estimateStatus==='sent'?'selected':''}>Sent — awaiting response</option>
            <option value="revised"           ${o.estimateStatus==='revised'?'selected':''}>Revised &amp; resent</option>
            <option value="viewed"            ${o.estimateStatus==='viewed'?'selected':''}>Viewed by customer</option>
            <option value="awaiting_response" ${o.estimateStatus==='awaiting_response'?'selected':''}>Awaiting response</option>
            <option value="accepted"          ${o.estimateStatus==='accepted'?'selected':''}>Accepted</option>
            <option value="declined"          ${o.estimateStatus==='declined'?'selected':''}>Declined</option>
            <option value="expired"           ${o.estimateStatus==='expired'?'selected':''}>Expired</option>
          </select>
        </label>
        ${inputEdit('estimateAmount','Estimate Amount ($)',o.estimateAmount,'number')}
        ${inputEdit('estimateSentDate','Date Sent to Customer',o.estimateSentDate,'date')}
        ${inputEdit('estimateCount','# Estimates Issued',o.estimateCount,'number')}
      </div>
      ${textarea('prompt','What prompted the inquiry?',o.prompt)}${textarea('desiredOutcome','Desired outcome / what good looks like',o.desiredOutcome)}${textarea('fitConcerns','Fit concerns / risk flags',o.fitConcerns)}
    </form>
    <div class="grid grid-2 mt">
      <section class="card"><h2>Activity & Notes</h2><div id="noteList">${renderNotes(o.id)}</div><textarea id="newNote" rows="4" placeholder="Add call note, site note, objection, or next step..."></textarea><button class="primary-btn mt8" onclick="addNote('${o.id}')">Add Note</button></section>
      ${(()=>{
        const stageNum = Math.max(1, data.statuses.indexOf(o.status)+1);
        const stageChecklist = (window.AVALON_DATA.checklists||[]).find(c=>c.stage===stageNum);
        if (!stageChecklist) return '<section class="card"><h2>Stage Checklist</h2><p class="muted">No checklist for this stage.</p></section>';
        return `<section class="card"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px"><h2 style="margin:0">${escapeHtml(stageChecklist.title)}</h2><span class="badge" style="font-size:.7rem;background:rgba(0,212,255,.12);color:#00d4ff">Stage ${stageNum}</span></div>${renderChecklist(stageChecklist, true, o.id)}</section>`;
      })()}
    ${(()=>{
      const _cr = window.getCurrentRep ? window.getCurrentRep() : null;
      const _isAdm = _cr && _cr.role === 'admin';
      const _isOM  = _cr && _cr.role === 'office_manager';
      if (!_isAdm && !_isOM) return '';
      const _ca = state.opportunities.find(x=>x.id==='${o.id}') || {};
      // Commission Approved checkbox — Tyler (admin) only
      const _commApprovedHtml = _isAdm ? `
          <div>
            <label style="display:block;font-size:12px;color:#64748b;margin-bottom:6px">Commission Approved</label>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <input type="checkbox" id="commApproved" ${_ca.commissionApproved?'checked':''} onchange="setOppField('${o.id}','commissionApproved',this.checked);showToast('Commission approval updated')">
              <span style="font-size:13px">${_ca.commissionApproved ? 'Approved' : 'Pending approval'}</span>
            </label>
          </div>` : `
          <div style="opacity:.5">
            <label style="display:block;font-size:12px;color:#64748b;margin-bottom:6px">Commission Approved</label>
            <span style="font-size:12px;color:#64748b">Tyler (Owner) only</span>
          </div>`;
      const _borderColor = _isAdm ? '#00d4ff' : '#f59e0b';
      const _panelTitle  = _isAdm ? 'Admin Controls <span style="font-size:11px;font-weight:400;color:#64748b;margin-left:6px">Tyler Only</span>' : 'Office Controls <span style="font-size:11px;font-weight:400;color:#64748b;margin-left:6px">Jen — Sales Ops</span>';
      return `<section class="card" style="border:2px solid ${_borderColor}">
        <h2>${_panelTitle}</h2>
        <div class="grid grid-3" style="gap:12px;margin-top:12px">
          ${_commApprovedHtml}
          <div>
            <label style="display:block;font-size:12px;color:#64748b;margin-bottom:6px">Payment Collected</label>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <input type="checkbox" id="payCollected" ${_ca.collected?'checked':''} onchange="setOppField('${o.id}','collected',this.checked);showToast('Collection status updated')">
              <span style="font-size:13px">${_ca.collected ? 'Collected' : 'Outstanding'}</span>
            </label>
          </div>
          <div>
            <label style="display:block;font-size:12px;color:#64748b;margin-bottom:6px">Reassign Rep</label>
            <select onchange="setOppField('${o.id}','repId',this.value)" style="width:100%;padding:6px 8px;background:#1e293b;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px">
              <option value="">— Assign —</option>
              ${(window.REPS||[]).map(r=>`<option value="${r.id}" ${_ca.repId===r.id?'selected':''}>${r.name}</option>`).join('')}
            </select>
          </div>
        </div>
        <div style="margin-top:12px;padding:10px;background:#0f172a;border-radius:8px;font-size:12px;color:#64748b">
          Commission is paid only after both "Commission Approved" and "Payment Collected" are checked. Commission approval is Tyler's decision only. Jen can mark payment collected and reassign reps.
        </div>
      </section>`;
    })()}
    </div>
    <div class="mt">
      <section class="card" style="border:1px solid rgba(0,167,225,.2)">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:12px">
          <h2 style="margin:0">Quick Actions</h2>
          <button class="secondary-btn small" onclick="show('integrations')" style="font-size:11px">Manage Integrations</button>
        </div>
        <p style="font-size:13px;color:var(--muted);margin-bottom:16px">Push this lead to your connected tools — CRM, calendar, or email.</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px">
          <button class="int-action-btn" id="qa_homeworks_${o.id}"
            onclick="qaAction('homeworks','${o.id}',this)"
            aria-label="Push ${escapeHtml(o.client||'lead')} to Homeworks CRM">
            
            <div style="text-align:left">
              <div style="font-weight:700;font-size:13px">Push to Homeworks</div>
              <div style="font-size:11px;color:var(--muted);font-weight:400">Sync to CRM</div>
            </div>
          </button>
          <button class="int-action-btn" id="qa_calendar_${o.id}"
            onclick="qaAction('calendar','${o.id}',this)"
            aria-label="Schedule Google Calendar event for ${escapeHtml(o.client||'lead')}">
            
            <div style="text-align:left">
              <div style="font-weight:700;font-size:13px">Schedule Event</div>
              <div style="font-size:11px;color:var(--muted);font-weight:400">Google Calendar</div>
            </div>
          </button>
          <button class="int-action-btn" id="qa_gmail_${o.id}"
            onclick="qaAction('gmail','${o.id}',this)"
            aria-label="Open Gmail compose for ${escapeHtml(o.client||'lead')}">
            
            <div style="text-align:left">
              <div style="font-weight:700;font-size:13px">Compose Email</div>
              <div style="font-size:11px;color:var(--muted);font-weight:400">Gmail draft</div>
            </div>
          </button>
        </div>
      </section>
    </div>
    </div><!-- /leadTabOverview -->

    <!-- TAB: Communications -->
    <div id="leadTabComms" style="display:${_activeTab==='comms'?'block':'none'}">
      ${commsBoardHtml(o.id, o)}
    </div>

    <!-- TAB: Files & Attachments -->
    <div id="leadTabFiles" style="display:${_activeTab==='files'?'block':'none'}">
      ${filesTabHtml(o.id, o)}
    </div>
  `;

  // Wire up Communications compose after render
  if(_activeTab==='comms') wireCommsCompose(o.id, o);
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
    sms:   { label:'SMS',      color:'#10b981', icon:'<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 2.5A.5.5 0 012.5 2h9a.5.5 0 01.5.5v6a.5.5 0 01-.5.5H8L5.5 12V9H2.5A.5.5 0 012 8.5v-6z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>' },
    email: { label:'Email',    color:'#6366f1', icon:'<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1.5" y="3" width="11" height="8" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M1.5 5l5.5 3.5L12.5 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>' },
    call:  { label:'Call',     color:'#f59e0b', icon:'<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M4.5 2C4.5 2 5 4 4 5S2 5.5 2 5.5C2 8 6 12 8.5 12c0 0 .5-2 1.5-2s3 .5 3 .5-.5 2-2 2C7 13 1 7 1 3.5c0 0 2 .5 3-1S4.5 2 4.5 2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>' },
    note:  { label:'Note',     color:'#64748b', icon:'<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 2.5A.5.5 0 012.5 2h9a.5.5 0 01.5.5v6a.5.5 0 01-.5.5H8L5.5 12V9H2.5A.5.5 0 012 8.5v-6z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>' },
    proposal:{ label:'Proposal', color:'#a855f7', icon:'<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 2h5.5L11 4.5V12H3V2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 2v3h3" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" opacity=".6"/></svg>' },
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
      const icon = isImg ? '🖼' : isPdf ? '📄' : ext==='docx'||ext==='doc' ? '📝' : '📎';
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
          (m.gmailSent ? '<span class="comm-gmail-badge">✅ Sent via Gmail</span>' : (m.type==='email'&&m.direction==='out' ? '<span class="comm-gmail-badge comm-gmail-local">📋 Logged locally</span>' : '')) +
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
        '<div class="comm-empty-icon">💬</div>' +
        '<p>No communications yet for '+clientName+'.</p>' +
        '<p style="color:#334155;font-size:12.5px;max-width:320px;line-height:1.6">Use the compose bar below to log a call, send an SMS, draft an email, or attach a proposal.</p>' +
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

  if(!allFiles.length) return '<div class="comms-board"><div class="comm-empty"><div class="comm-empty-icon">📁</div><p>No files attached yet.</p><p style="color:#334155;font-size:12.5px;max-width:300px;line-height:1.6">Attach photos, PDFs, proposals, and documents from the Communications tab.</p></div></div>';

  const ext2icon = ext => {
    const e = (ext||'').toLowerCase();
    if(['jpg','jpeg','png','gif','webp'].includes(e)) return '🖼';
    if(e==='pdf') return '📄';
    if(['doc','docx'].includes(e)) return '📝';
    if(['xls','xlsx'].includes(e)) return '📊';
    return '📎';
  };

  const clientInitials = (opp.client||'?').split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase();
  return '<div class="comms-board">' +
    '<div class="comms-header">' +
      '<div class="comms-header-top">' +
        '<div class="comms-header-identity">' +
          '<div class="comms-avatar" style="background:linear-gradient(135deg,#0ea5e9,#0284c7)">'+clientInitials+'</div>' +
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
        '<div class="file-card-icon">'+(isImg&&f.dataUrl?'<img src="'+f.dataUrl+'" alt="'+escapeHtml(f.name)+'" style="width:100%;height:80px;object-fit:cover;border-radius:6px;">':ext2icon(ext)+'<span style="font-size:.65rem;color:#64748b;display:block;margin-top:4px">'+ext.toUpperCase()+'</span>')+'</div>' +
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
      banner.style.cssText = 'padding:8px 14px;background:#10b98118;border:1px solid #10b98144;border-radius:8px;font-size:12px;color:#34d399;display:flex;align-items:center;gap:8px;margin-bottom:2px';
      banner.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1.5" y="3" width="11" height="8" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M1.5 5l5.5 3.5L12.5 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg> Emails will be sent from <strong style="margin-left:4px;color:#6ee7b7">' + escapeHtml(fromEmail) + '</strong> via Gmail &nbsp;<span style="opacity:.6;font-size:11px">— to lead\'s email address on file</span>';
    } else {
      banner.style.cssText = 'padding:8px 14px;background:#f59e0b18;border:1px solid #f59e0b44;border-radius:8px;font-size:12px;color:#fbbf24;display:flex;align-items:center;gap:8px;margin-bottom:2px;flex-wrap:wrap';
      banner.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2l5.5 10H1.5L7 2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M7 6v3M7 10.5h.01" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg> Google not connected — email will be <strong style="margin:0 4px">logged locally only</strong> and not actually sent. <button onclick="show(\'integrations\')" style="background:#f59e0b30;border:1px solid #f59e0b66;border-radius:6px;color:#fbbf24;padding:2px 10px;font-size:11px;font-weight:700;cursor:pointer;margin-left:4px">Connect Google →</button>';
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
      return '<span class="attach-chip">'+(isImg?'🖼':'📎')+' <span>'+escapeHtml(f.name)+'</span><button onclick="removePendingFile('+i+')" title="Remove">×</button></span>';
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
      showToast('⚠️ Google not connected — email logged locally only. Connect in Integrations to send real emails.');
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
        showToast('Email sent via Gmail ✅ — from ' + (getGoogleUserEmail ? getGoogleUserEmail() : 'your Google account'));
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
function setOppField(id,field,value){ const o = state.opportunities.find(x=>x.id===id); if(!o) return; o[field]=value; o.updatedAt=new Date().toISOString(); saveState(); showToast('Updated'); show('pipeline', id); }
function duplicateOpportunity(id){ const o = state.opportunities.find(x=>x.id===id); if(!o) return; const copy={...o,id:uid('opp'),client:`${o.client||'Lead'} Copy`,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}; state.opportunities.unshift(copy); saveState(); showToast('Duplicated'); show('pipeline',copy.id); }
function deleteOpportunity(id){ if(!confirm('Delete this opportunity?')) return; state.opportunities = state.opportunities.filter(o=>o.id!==id); state.notes = state.notes.filter(n=>n.oppId!==id); saveState(); showToast('Deleted'); show('pipeline'); }
function addNote(oppId){ const el = document.getElementById('newNote'); if(!el.value.trim()) return; state.notes.unshift({id:uid('note'),oppId,body:el.value.trim(),createdAt:new Date().toISOString()}); const o=state.opportunities.find(x=>x.id===oppId); if(o) o.updatedAt=new Date().toISOString(); saveState(); showToast('Note added'); show('pipeline', oppId); }
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
  const items = c.items.map((item,i)=>{
    const key = `${prefix}-${i}`;
    const checked = persist ? (localStorage.getItem(key) === '1') : false;
    return `<label class="check-item"><input type="checkbox" ${persist?`data-key="${key}"`:''}${checked?' checked':''}><span>${escapeHtml(item)}</span></label>`;
  });
  const total = c.items.length;
  const done  = persist ? c.items.filter((_,i)=>localStorage.getItem(`${prefix}-${i}`)==='1').length : 0;
  const pct   = total ? Math.round((done/total)*100) : 0;
  const barColor = pct===100?'#10b981':pct>=50?'#f59e0b':'#3b82f6';
  const progressBar = persist ? `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
      <div style="flex:1;height:7px;background:var(--line,#e2e8f0);border-radius:4px;overflow:hidden">
        <div id="cpbar-${prefix}" style="height:100%;width:${pct}%;background:${barColor};border-radius:4px;transition:width .35s ease"></div>
      </div>
      <span id="cplabel-${prefix}" style="font-size:.72rem;font-weight:700;color:${barColor};white-space:nowrap">${done}/${total} complete</span>
    </div>` : '';
  return `${progressBar}<div class="checklist" id="clist-${prefix}">${items.join('')}</div>`;
}

function wireChecks(){
  document.querySelectorAll('.check-item input[data-key]').forEach(cb=>{
    const key = cb.dataset.key;
    cb.checked = localStorage.getItem(key) === '1';
    cb.addEventListener('change', ()=>{
      localStorage.setItem(key, cb.checked ? '1' : '0');
      // Live-update progress bar for this checklist
      const prefixMatch = key.match(/^(.+)-\d+$/);
      if (!prefixMatch) return;
      const prefix = prefixMatch[1];
      const allBoxes = document.querySelectorAll(`input[data-key^="${prefix}-"]`);
      if (!allBoxes.length) return;
      const total = allBoxes.length;
      const done  = [...allBoxes].filter(x=>x.checked).length;
      const pct   = Math.round((done/total)*100);
      const color = pct===100?'#10b981':pct>=50?'#f59e0b':'#3b82f6';
      const barEl  = document.getElementById('cpbar-'+prefix);
      const lblEl  = document.getElementById('cplabel-'+prefix);
      if (barEl){ barEl.style.width = pct+'%'; barEl.style.background = color; }
      if (lblEl){ lblEl.textContent = done+'/'+total+' complete'; lblEl.style.color = color; }
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
    <div style="background:#0f172a;border:1px solid #1e4d6b;border-radius:14px;padding:24px;width:100%;max-width:480px;box-shadow:0 25px 60px rgba(0,0,0,0.6);margin:0 16px">
      <h3 style="margin:0 0 14px;color:#f1f5f9;font-size:1.1rem">Select a Lead</h3>
      <input id="lpSearch" type="text" placeholder="Search by client or project..."
        style="width:100%;padding:9px 12px;background:#1e293b;border:1px solid #334155;border-radius:8px;color:#e2e8f0;margin-bottom:12px;box-sizing:border-box;font-size:14px;outline:none">
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
  const stepColors = ['#6366f1','#10b981','#f59e0b','#ef4444','#a855f7','#ec4899'];
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

  const stepColors2 = ['#6366f1','#10b981','#f59e0b','#ef4444','#a855f7','#ec4899'];
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
          <button class="secondary-btn" onclick="show('ai')" style="font-size:.82rem">✦ AI Coach</button>
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
  const barColor = prog ? (prog.pct===100?'#10b981':prog.pct>=50?'#f59e0b':'#3b82f6') : '#3b82f6';
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
  const barColor = p.pct===100?'#10b981':p.pct>=50?'#f59e0b':'#3b82f6';
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
  const barColor = p.pct===100?'#10b981':p.pct>=50?'#f59e0b':'#10b981';
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
    <button class="secondary-btn" onclick="show('ai')">✦ AI Coach for this stage</button>
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
      <button class="secondary-btn" onclick="show('ai')">✦ AI Draft from Fields</button>
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
  <button id="favToggle" class="secondary-btn" style="font-size:.8rem;white-space:nowrap">★ Favorites</button>
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
      return `<article class="card" style="position:relative;border:1px solid var(--line);border-top:3px solid ${verbatim?'#f59e0b':'var(--blue)'}">
        <button onclick="toggleScriptFav('${escapeForJs(s.title)}')" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;font-size:1rem;color:${isFav?'#f59e0b':'var(--muted)'}" title="${isFav?'Remove from favorites':'Add to favorites'}">${isFav?'★':'☆'}</button>
        ${verbatim?`<div style="display:inline-block;font-size:.68rem;font-weight:700;background:#f59e0b22;color:#f59e0b;border:1px solid #f59e0b44;border-radius:4px;padding:2px 7px;margin-bottom:6px">VERBATIM — Do Not Deviate</div>`:''}
        <span class="badge" style="display:block;margin-bottom:6px">${escapeHtml(s.category)}</span>
        <h3 style="color:var(--ink);margin:0 0 6px;padding-right:28px">${escapeHtml(s.title)}</h3>
        ${s.situation?`<p style="font-size:.8rem;color:#6366f1;font-weight:600;margin:0 0 8px;font-style:italic">When: ${escapeHtml(s.situation)}</p>`:''}
        <div class="script-box" style="font-size:.84rem">${nl2br(s.body)}</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">
          <button class="secondary-btn" style="font-size:.78rem" onclick="copyText('${escapeForJs(s.body)}',this)">Copy Script</button>
          <button class="secondary-btn" style="font-size:.78rem" onclick="scriptUseForLead('${escapeForJs(s.title)}','${escapeForJs(s.body)}')">Link to Lead</button>
          <button class="secondary-btn" style="font-size:.78rem" onclick="scriptToAI('${escapeForJs(s.title)}','${escapeForJs(s.situation||'')}')">✦ AI Coach</button>
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
    document.getElementById('favToggle').style.color = showFavs ? '#f59e0b' : '';
    document.getElementById('favToggle').style.borderColor = showFavs ? '#f59e0b' : '';
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
      <article class="card" style="border:1px solid var(--line);border-top:3px solid #10b981">
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
          <button class="secondary-btn" style="font-size:.78rem" onclick="tmplPersonalize('${escapeForJs(t.subject)}','${escapeForJs(t.body)}')">✦ Personalize + Copy</button>
          <button class="secondary-btn" style="font-size:.78rem" onclick="tmplUseForLead('${escapeForJs(t.subject)}','${escapeForJs(t.body)}')">Link to Lead</button>
          <button class="secondary-btn" style="font-size:.78rem" onclick="tmplToAI('${escapeForJs(t.title)}','${escapeForJs(t.category)}')">✦ AI Refine</button>
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
  const SEVERITY_COLORS = { high:'#ef4444', medium:'#f59e0b', low:'#10b981' };
  const SEVERITY_LABELS = { high:'Price/Budget', medium:'Timing/Commitment', low:'Shopping' };

  view.innerHTML = `
<div class="eyebrow">Decision Management</div>
<h1 style="color:var(--ink)">Objection Handling</h1>
<p class="lede">Do not argue. Clarify, reconnect to the buying reason, protect scope quality, and guide the client toward a clear decision.</p>

<div style="display:flex;gap:8px;margin-bottom:18px;flex-wrap:wrap">
  <button class="tab active" data-sev="all">All Objections</button>
  <button class="tab" data-sev="high" style="border-color:#ef444444">Price / Budget</button>
  <button class="tab" data-sev="medium" style="border-color:#f59e0b44">Timing / Commitment</button>
  <button class="tab" data-sev="low" style="border-color:#10b98144">Shopping</button>
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
          <summary style="cursor:pointer;font-size:.82rem;font-weight:600;color:var(--blue);user-select:none;margin-bottom:8px;list-style:none">How to respond ▾</summary>
          <div style="margin-top:8px">${list_(o.response)}</div>
        </details>
        <h4 style="font-size:.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:10px 0 6px">Say This</h4>
        <div class="script-box" style="font-size:.84rem">${escapeHtml(o.say)}</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">
          <button class="secondary-btn" style="font-size:.78rem" onclick="copyText('${escapeForJs(o.say)}',this)">Copy Response</button>
          <button class="secondary-btn" style="font-size:.78rem" onclick="objLogToLead('${escapeForJs(o.title)}','${escapeForJs(o.say)}')">Link to Lead</button>
          <button class="secondary-btn" style="font-size:.78rem" onclick="objToAI('${escapeForJs(o.title)}','${escapeForJs(o.say)}')">✦ AI Refine Reply</button>
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
    <strong style="color:#10b981">Est. commission (~7%):</strong> <span style="color:#10b981">${money(estComm)}</span>
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
    { id:'reply_email',     label:'Reply to a Client Email',        icon:'✉️',  color:'#6366f1' },
    { id:'follow_up',       label:'Follow-Up After No Response',    icon:'🔄',  color:'#3b82f6' },
    { id:'proposal_intro',  label:'Proposal Introduction Email',    icon:'📋',  color:'#10b981' },
    { id:'objection_reply', label:'Handle an Objection',            icon:'🛡️',  color:'#f59e0b' },
    { id:'discovery_prep',  label:'Discovery Call Prep',            icon:'🎯',  color:'#a855f7' },
    { id:'site_walk_recap', label:'Post-Site Walk Summary',         icon:'📍',  color:'#ec4899' },
    { id:'closing_email',   label:'Closing / Decision Ask',         icon:'🤝',  color:'#ef4444' },
    { id:'referral_ask',    label:'Ask for a Referral',             icon:'⭐',  color:'#f97316' },
    { id:'custom',          label:'Custom Situation',               icon:'✦',   color:'#64748b' },
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
      ✦ Generate Email / Reply
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
      <div style="font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#6366f1;margin-bottom:8px">Prompt Preview</div>
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
        btn.style.background  = (sit?.color||'#6366f1')+'18';
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
    if (param && param.startsWith('phase:')) return academyPhaseDetail(param.replace('phase:', ''));
    if (param && param.startsWith('module:')) return academyModuleWorkspace(param.replace('module:', ''));
    if (param === 'badges') return academyBadgesView();
    if (param === 'admin') {
      const rep = window.getCurrentRep ? window.getCurrentRep() : null;
      if (!rep || rep.role !== 'admin') { academy(); return; }
      return academyAdminDashboard();
    }
    return academyHome();
  } catch(e) {
    console.error('[Academy] render error:', e);
    view.innerHTML = `<div class="card mt" style="border-color:#ef4444">
      <h3 style="color:#ef4444;margin-top:0">Academy Error</h3>
      <p style="color:var(--muted);font-family:monospace;font-size:.8rem">${escapeHtml(e.message)}</p>
      <button class="secondary-btn" onclick="localStorage.removeItem('avalonAcademyContentV1');location.reload()">Clear Cache &amp; Reload</button>
    </div>`;
  }
}

// ─── Shared Academy Styles ────────────────────────────────────────────────────
const ACAD_STYLES = `
<style id="acad-styles">
/* ── Academy light-mode base ── */
.acad-header{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px 28px;margin-bottom:20px;box-shadow:0 1px 4px rgba(14,23,32,.06)}
.acad-header-top{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
.acad-level-chip{display:inline-flex;align-items:center;gap:8px;background:var(--bg);border:1px solid var(--line);border-radius:99px;padding:6px 14px;font-size:.85rem;font-weight:600;color:var(--ink)}
.acad-stats{display:flex;gap:24px;flex-wrap:wrap;margin-top:18px;padding-top:16px;border-top:1px solid var(--line)}
.acad-stat{text-align:center}
.acad-stat-num{font-size:1.5rem;font-weight:700;color:var(--ink)}
.acad-stat-label{font-size:.68rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-top:2px}
.acad-level-bar-wrap{margin-top:14px}
.acad-level-bar-track{height:7px;background:var(--line);border-radius:4px;overflow:hidden;margin-top:4px}
.acad-level-bar-fill{height:100%;border-radius:4px;transition:width .6s ease}
.acad-section-label{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:12px}
/* ── Phase cards ── */
.phase-card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;cursor:pointer;transition:border-color .2s,box-shadow .2s,transform .15s;position:relative;overflow:hidden}
.phase-card:hover:not(.phase-locked){border-color:var(--blue);box-shadow:0 4px 16px rgba(0,167,225,.1);transform:translateY(-2px)}
.phase-card.phase-locked{opacity:.5;cursor:not-allowed}
.phase-card-accent{position:absolute;top:0;left:0;width:4px;height:100%}
.phase-card-header{display:flex;align-items:flex-start;gap:12px;margin-bottom:12px}
.phase-num{font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:3px}
.phase-title{font-size:1.02rem;font-weight:700;color:var(--ink);margin:0}
.phase-desc{font-size:.82rem;color:var(--muted);margin:0 0 14px;line-height:1.55}
.phase-prog-row{display:flex;align-items:center;gap:8px}
.phase-prog-track{flex:1;height:5px;background:var(--line);border-radius:4px;overflow:hidden}
.phase-prog-fill{height:100%;border-radius:4px;transition:width .5s}
.phase-prog-pct{font-size:.75rem;font-weight:700;color:var(--ink);min-width:34px;text-align:right}
.phase-mod-count{font-size:.71rem;color:var(--muted);margin-top:6px}
.phase-status-chip{display:inline-flex;align-items:center;gap:5px;font-size:.68rem;font-weight:700;border-radius:99px;padding:3px 9px;margin-top:8px}
/* ── Next up card ── */
.acad-next-card{background:var(--card);border:2px solid var(--blue);border-radius:12px;padding:16px 20px;display:flex;align-items:center;gap:16px;cursor:pointer;transition:border-color .2s,box-shadow .2s;box-shadow:0 2px 8px rgba(0,167,225,.08)}
.acad-next-card:hover{box-shadow:0 4px 16px rgba(0,167,225,.18)}
.acad-next-label{font-size:.68rem;text-transform:uppercase;letter-spacing:.07em;color:var(--blue);font-weight:700;margin-bottom:3px}
.acad-next-title{font-size:1rem;font-weight:700;color:var(--ink);margin-bottom:2px}
.acad-next-sub{font-size:.8rem;color:var(--muted)}
/* ── Recently completed ── */
.recently-item{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line);cursor:pointer;transition:background .15s}
.recently-item:last-child{border-bottom:none}
.recently-check{width:26px;height:26px;background:rgba(16,185,129,.12);border:1.5px solid #10b981;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#10b981;flex-shrink:0}
/* ── Badge chips ── */
.badge-upcoming-row{display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--line);border-radius:10px;margin-bottom:8px;cursor:pointer;transition:border-color .2s;background:var(--bg)}
.badge-upcoming-row:hover{border-color:var(--blue)}
/* ── Module workspace ── */
.workspace-layout{display:grid;grid-template-columns:230px 1fr;gap:0;min-height:520px;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--bg)}
@media(max-width:700px){.workspace-layout{grid-template-columns:1fr}}
.workspace-nav{background:var(--card);border-right:1px solid var(--line);padding:0}
.workspace-nav-header{padding:16px 16px 12px;border-bottom:1px solid var(--line)}
.workspace-nav-title{font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:6px}
.workspace-nav-pct{font-size:1.4rem;font-weight:700;color:var(--ink)}
.workspace-nav-bar{height:5px;background:var(--line);border-radius:4px;margin-top:6px;overflow:hidden}
.workspace-nav-fill{height:100%;border-radius:4px;transition:width .4s}
.ws-nav-item{display:flex;align-items:center;gap:9px;padding:11px 14px;cursor:pointer;border-left:3px solid transparent;transition:all .15s;font-size:.82rem;color:var(--muted)}
.ws-nav-item:hover{background:var(--bg);color:var(--ink)}
.ws-nav-item.active-section{background:var(--bg);border-left-color:var(--blue);color:var(--ink);font-weight:600}
.ws-nav-item.done-section{color:#10b981}
.ws-nav-dot{width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.62rem;font-weight:700;flex-shrink:0;background:var(--line);color:var(--muted);border:1.5px solid var(--line)}
.ws-nav-dot.done{background:rgba(16,185,129,.12);color:#10b981;border-color:#10b981}
.ws-nav-dot.active{background:rgba(0,167,225,.12);color:var(--blue);border-color:var(--blue)}
.workspace-main{padding:28px 32px;overflow-y:auto;overflow-x:hidden;background:var(--bg);min-width:0;box-sizing:border-box}
/* ── Lesson content ── */
.ws-section-type{font-size:.68rem;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);margin-bottom:6px;font-weight:700}
.ws-section-title{font-size:1.3rem;font-weight:700;color:var(--ink);margin:0 0 16px}
.ws-body{color:var(--ink);line-height:1.72;font-size:.93rem;margin-bottom:18px}
.ws-body p{margin:0 0 12px}
.ws-key-point{display:flex;gap:10px;padding:11px 15px;background:rgba(0,167,225,.06);border-left:3px solid var(--blue);border-radius:0 8px 8px 0;margin-bottom:8px;font-size:.88rem;color:var(--ink);line-height:1.5}
.ws-callout{border-radius:10px;padding:14px 18px;margin:16px 0;border-left:4px solid}
.ws-callout.principle{background:rgba(0,167,225,.06);border-color:var(--blue)}
.ws-callout.warning{background:rgba(239,68,68,.05);border-color:#ef4444}
.ws-callout.list{background:rgba(16,185,129,.05);border-color:#10b981}
.ws-callout-title{font-size:.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
.ws-callout.principle .ws-callout-title{color:var(--blue)}
.ws-callout.warning .ws-callout-title{color:#ef4444}
.ws-callout.list .ws-callout-title{color:#10b981}
.ws-callout-body{font-size:.88rem;color:var(--ink);line-height:1.6}
.ws-callout-list{margin:0;padding-left:0;list-style:none}
.ws-callout-list li{padding:4px 0 4px 0;font-size:.87rem;color:var(--ink);line-height:1.5;border-bottom:1px solid var(--line)}
.ws-callout-list li:last-child{border-bottom:none}
.ws-examples{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:16px 0}
@media(max-width:600px){.ws-examples{grid-template-columns:1fr}}
.ws-example{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:13px 15px}
.ws-example-label{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;color:var(--blue)}
.ws-example-text{font-size:.85rem;color:var(--ink);line-height:1.55;font-style:italic}
.ws-note-prompt{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:16px 0}
.ws-note-prompt-label{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:8px;display:flex;align-items:center;gap:6px}
.ws-note-textarea{width:100%;min-height:90px;border:1.5px solid var(--line);border-radius:7px;padding:10px 12px;font-size:.87rem;color:var(--ink);background:var(--bg);resize:vertical;font-family:inherit;box-sizing:border-box;transition:border-color .2s}
.ws-note-textarea:focus{outline:none;border-color:var(--blue)}
.ws-complete-btn{display:inline-flex;align-items:center;gap:8px;border:none;border-radius:10px;padding:11px 22px;font-size:.9rem;font-weight:600;cursor:pointer;margin-top:18px;transition:opacity .15s,transform .1s;color:#fff}
.ws-complete-btn:hover{opacity:.88;transform:translateY(-1px)}
.ws-complete-btn:disabled{opacity:.45;cursor:not-allowed;transform:none}
.ws-done-badge{display:inline-flex;align-items:center;gap:8px;background:rgba(16,185,129,.1);border:1.5px solid #10b981;color:#10b981;border-radius:10px;padding:10px 18px;font-size:.88rem;font-weight:600;margin-top:16px}
/* ── Quiz ── */
.quiz-container{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:22px;width:100%;box-sizing:border-box}
.quiz-q{margin-bottom:24px;width:100%}
.quiz-q-num{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:6px}
.quiz-q-prompt{font-weight:600;color:var(--ink);margin-bottom:12px;line-height:1.45;font-size:.95rem;word-wrap:break-word}
.quiz-choice{display:flex;align-items:center;gap:12px;padding:12px 16px;border:1.5px solid var(--line);border-radius:9px;cursor:pointer;margin-bottom:8px;transition:border-color .15s,background .15s;background:var(--bg);width:100%;box-sizing:border-box;text-align:left}
.quiz-choice:hover{border-color:var(--blue);background:rgba(0,167,225,.04)}
.quiz-choice.selected{border-color:var(--blue);background:rgba(0,167,225,.07)}
.quiz-choice.correct{border-color:#10b981;background:rgba(16,185,129,.07)}
.quiz-choice.wrong{border-color:#ef4444;background:rgba(239,68,68,.06)}
.quiz-choice input[type=radio]{margin:0;flex-shrink:0;width:16px;height:16px;accent-color:var(--blue);cursor:pointer}
.quiz-choice-text{font-size:.88rem;color:var(--ink);line-height:1.5;flex:1;min-width:0;word-wrap:break-word}
.quiz-submit-btn{background:var(--blue);color:#fff;border:none;border-radius:10px;padding:12px 28px;font-size:.95rem;font-weight:600;cursor:pointer;margin-top:18px;transition:opacity .15s,transform .1s}
.quiz-submit-btn:hover{opacity:.88;transform:translateY(-1px)}
.quiz-submit-btn:disabled{opacity:.45;cursor:not-allowed;transform:none}
.quiz-result{border-radius:12px;padding:18px;margin-top:18px}
.quiz-result.pass{background:rgba(16,185,129,.07);border:1.5px solid rgba(16,185,129,.3)}
.quiz-result.fail{background:rgba(239,68,68,.05);border:1.5px solid rgba(239,68,68,.2)}
.quiz-feedback-item{padding:9px 13px;border-radius:8px;margin-bottom:7px;font-size:.84rem;border-left:3px solid}
.quiz-feedback-item.correct{background:rgba(16,185,129,.07);border-left-color:#10b981}
.quiz-feedback-item.wrong{background:rgba(239,68,68,.06);border-left-color:#ef4444}
.quiz-explanation{font-size:.8rem;color:var(--muted);margin-top:4px;line-height:1.45}
.prev-attempts-chip{display:inline-flex;align-items:center;gap:5px;font-size:.76rem;color:var(--muted);background:var(--line);border-radius:99px;padding:3px 11px;margin-bottom:14px}
/* ── Admin dashboard ── */
.admin-rep-card{background:var(--card);border:1px solid var(--line);border-radius:12px;margin-bottom:14px;overflow:hidden}
.admin-rep-header{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;gap:12px;flex-wrap:wrap;border-bottom:1px solid var(--line);cursor:pointer;transition:background .15s}
.admin-rep-header:hover{background:var(--bg)}
.admin-mod-matrix{overflow-x:auto;padding:0 16px 14px}
.admin-mod-cell{display:inline-flex;flex-direction:column;align-items:center;justify-content:center;width:58px;min-width:52px;border:1px solid var(--line);border-radius:7px;padding:7px 4px;font-size:.72rem;font-weight:600;text-align:center;background:var(--bg);margin:4px 2px;transition:border-color .15s;cursor:default}
.admin-mod-cell.completed{background:rgba(16,185,129,.08);border-color:#10b981;color:#10b981}
.admin-mod-cell.in-progress{background:rgba(245,158,11,.08);border-color:#f59e0b;color:#f59e0b}
.admin-action-btn{font-size:.75rem;padding:5px 11px;border:1.5px solid var(--line);border-radius:7px;background:var(--bg);color:var(--ink);cursor:pointer;font-weight:600;transition:border-color .15s,background .15s}
.admin-action-btn:hover{border-color:var(--blue);background:rgba(0,167,225,.06)}
.admin-action-btn.danger:hover{border-color:#ef4444;background:rgba(239,68,68,.06);color:#ef4444}
</style>`;

// ─── Academy Home ─────────────────────────────────────────────────────────────
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
  const isAdmin = rep && rep.role === 'admin';

  const phaseCards = hd.phaseProgress.map(ph => {
    const phIcon = svgPhaseIcon(ph.sort_order, ph.color, 36);
    const completeChip = ph.pct === 100
      ? `<span class="phase-status-chip" style="background:rgba(16,185,129,.1);color:#10b981;border:1px solid rgba(16,185,129,.3)">${SVG_CHECK} Complete</span>`
      : ph.inProgress
      ? `<span class="phase-status-chip" style="background:rgba(245,158,11,.1);color:#b45309;border:1px solid rgba(245,158,11,.3)">In Progress</span>`
      : '';
    const lockBadge = ph.locked
      ? `<span class="phase-status-chip" style="background:var(--line);color:var(--muted);border:none">${SVG_LOCK} Complete Phase ${ph.sort_order - 1} to unlock</span>`
      : '';
    return `<article class="phase-card${ph.locked ? ' phase-locked' : ''}" ${ph.locked ? '' : `onclick="show('academy','phase:${ph.id}')"`}>
      <div class="phase-card-accent" style="background:${ph.color}"></div>
      <div class="phase-card-header">
        <div style="flex-shrink:0">${phIcon}</div>
        <div style="flex:1;min-width:0">
          <div class="phase-num">Phase ${ph.sort_order}</div>
          <div class="phase-title">${escapeHtml(ph.title)}</div>
        </div>
        <div>${completeChip}</div>
      </div>
      <p class="phase-desc">${escapeHtml(ph.short_description)}</p>
      <div class="phase-prog-row">
        <div class="phase-prog-track"><div class="phase-prog-fill" style="width:${ph.pct}%;background:${ph.color}"></div></div>
        <span class="phase-prog-pct">${ph.pct}%</span>
      </div>
      <div class="phase-mod-count">${ph.modulesCompleted} of ${ph.totalModules} modules complete</div>
      ${lockBadge}
    </article>`;
  }).join('');

  const nextCard = hd.nextModule
    ? `<div style="margin-bottom:20px">
        <div class="acad-section-label">Recommended Next</div>
        <div class="acad-next-card" onclick="show('academy','module:${hd.nextModule.id}')">
          <div style="flex-shrink:0">${svgPhaseIcon(hd.nextModule.phase_id === 'phase_1' ? 1 : hd.nextModule.phase_id === 'phase_2' ? 2 : 3, 'var(--blue)', 40)}</div>
          <div style="flex:1;min-width:0">
            <div class="acad-next-label">Continue Learning</div>
            <div class="acad-next-title">${escapeHtml(hd.nextModule.title)}</div>
            <div class="acad-next-sub">${escapeHtml((hd.nextModule.short_description||'').substring(0,90))}…</div>
          </div>
          <div style="flex-shrink:0;color:var(--blue)">${SVG_ARROW}</div>
        </div>
      </div>`
    : hd.overallPct === 100
    ? `<div style="margin-bottom:20px">
        <div class="acad-next-card" style="border-color:#10b981;cursor:default">
          <div style="flex-shrink:0">${svgBadgeShape('trophy','#10b981',44)}</div>
          <div>
            <div class="acad-next-label" style="color:#10b981">Academy Complete</div>
            <div class="acad-next-title">All 9 modules finished</div>
            <div class="acad-next-sub">You've mastered the full Avalon Sales Academy curriculum.</div>
          </div>
        </div>
      </div>`
    : '';

  const upcomingBadgesHtml = hd.upcomingBadges.length
    ? hd.upcomingBadges.map(b => `
      <div class="badge-upcoming-row" onclick="show('academy','badges')">
        <div style="flex-shrink:0">${svgBadgeShape(b.shape, b.color, 32)}</div>
        <div>
          <div style="font-weight:600;font-size:.85rem;color:var(--ink)">${escapeHtml(b.name)}</div>
          <div style="font-size:.72rem;color:var(--muted)">${escapeHtml(b.desc)}</div>
        </div>
      </div>`).join('')
    : `<p style="color:var(--muted);font-size:.85rem">All badges earned — well done.</p>`;

  const recentHtml = hd.recentlyCompleted.length
    ? hd.recentlyCompleted.map(m => `
      <div class="recently-item" onclick="show('academy','module:${m.id}')">
        <div class="recently-check">${SVG_CHECK}</div>
        <div>
          <div style="font-size:.85rem;font-weight:600;color:var(--ink)">${escapeHtml(m.title)}</div>
          <div style="font-size:.72rem;color:var(--muted)">Module ${m.sort_order}</div>
        </div>
      </div>`).join('')
    : `<p style="color:var(--muted);font-size:.85rem">No modules completed yet — start with Phase 1.</p>`;

  view.innerHTML = ACAD_STYLES + `
<div class="acad-header">
  <div class="acad-header-top">
    <div>
      <div class="eyebrow" style="margin-bottom:4px">Training Path</div>
      <h1 style="margin:0;font-size:1.55rem;color:var(--ink)">Avalon Sales Academy</h1>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <div class="acad-level-chip" style="border-color:${level.color};color:${level.color}">
        ${svgLevelIcon(level.id, level.color, 20)}
        <span>${escapeHtml(level.name)}</span>
      </div>
      ${hd.streak_days > 0 ? `<div class="acad-level-chip" style="border-color:#f97316;color:#f97316">${svgBadgeShape('flame','#f97316',18)} ${hd.streak_days}-day streak</div>` : ''}
      ${isAdmin ? `<button class="secondary-btn" style="font-size:.78rem;padding:6px 12px;display:inline-flex;align-items:center;gap:6px" onclick="show('academy','admin')">${SVG_TEAM} Team Progress</button>` : ''}
    </div>
  </div>

  <div class="acad-stats">
    <div class="acad-stat">
      <div class="acad-stat-num">${hd.overallPct}%</div>
      <div class="acad-stat-label">Overall</div>
    </div>
    <div class="acad-stat">
      <div class="acad-stat-num">${hd.completedModules}/${hd.totalModules}</div>
      <div class="acad-stat-label">Modules</div>
    </div>
    <div class="acad-stat">
      <div class="acad-stat-num">${hd.points}</div>
      <div class="acad-stat-label">Points</div>
    </div>
    <div class="acad-stat">
      <div class="acad-stat-num">${hd.badgesEarned}</div>
      <div class="acad-stat-label">Badges</div>
    </div>
    <div class="acad-stat">
      <div class="acad-stat-num">${hd.quizzesPassed}</div>
      <div class="acad-stat-label">Quizzes</div>
    </div>
  </div>

  ${nextLevel
    ? `<div class="acad-level-bar-wrap">
        <div style="display:flex;justify-content:space-between;font-size:.72rem;color:var(--muted);margin-bottom:4px">
          <span style="color:${level.color};font-weight:600">${escapeHtml(level.name)}</span>
          <span>${pointsToNext} pts to <strong style="color:${nextLevel.color}">${escapeHtml(nextLevel.name)}</strong></span>
        </div>
        <div class="acad-level-bar-track">
          <div class="acad-level-bar-fill" style="width:${levelPct}%;background:${level.color}"></div>
        </div>
      </div>`
    : `<div style="margin-top:12px;font-size:.85rem;color:#f59e0b;font-weight:600;display:inline-flex;align-items:center;gap:6px">${svgBadgeShape('star','#f59e0b',18)} Maximum Level — Mentor</div>`}
</div>

${nextCard}

<div class="acad-section-label">Training Phases</div>
<div class="grid grid-3 mt" style="margin-top:0;margin-bottom:22px">${phaseCards}</div>

<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:22px">
  <div class="card">
    <div class="acad-section-label">Upcoming Badges</div>
    ${upcomingBadgesHtml}
    <button class="secondary-btn" style="width:100%;margin-top:8px;font-size:.78rem" onclick="show('academy','badges')">View All Badges</button>
  </div>
  <div class="card">
    <div class="acad-section-label">Recently Completed</div>
    ${recentHtml}
  </div>
</div>

<div class="card" style="border-color:rgba(0,167,225,.2);background:rgba(0,167,225,.03)">
  <h3 style="margin-top:0;color:var(--ink)">New Hire Onboarding Path</h3>
  ${list(['Complete all 3 Phase 1 modules to understand the Avalon sales system.','Shadow one intake call, one discovery call, one site walk, and one proposal review.','Pass each module quiz at 75% or higher.','Role-play discovery, budget discussion, proposal delivery, and objection handling.','Build one sample scope and proposal with manager review.','Own a low-complexity opportunity under supervision.','Review first won/lost opportunities in weekly coaching.'])}
</div>`;
}

// ─── Phase Detail ─────────────────────────────────────────────────────────────
function academyPhaseDetail(phaseId) {
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  const repId = rep ? rep.id : 'ryan';
  const content = window.Academy.getContent();
  const ph = content.phases.find(p => p.id === phaseId);
  if (!ph) { academy(); return; }

  const rp = window.Academy.getRepProgress(repId);
  const phaseMods = content.modules.filter(m => m.phase_id === phaseId).sort((a,b) => a.sort_order - b.sort_order);
  const completedCount = phaseMods.filter(m => (rp.modules[m.id] || {}).status === 'completed').length;
  const pct = Math.round((completedCount / phaseMods.length) * 100);

  const moduleRows = phaseMods.map((m, i) => {
    const mp = rp.modules[m.id] || {};
    const status = mp.status || 'not_started';
    const isLocked = window.Academy.isModuleLocked(m.id, repId);

    let stepEl, stepBg, stepBorder, stepColor;
    if (status === 'completed') {
      stepBg = 'rgba(16,185,129,.12)'; stepBorder = '#10b981'; stepColor = '#10b981';
      stepEl = SVG_CHECK;
    } else if (status === 'in_progress') {
      stepBg = 'rgba(245,158,11,.1)'; stepBorder = '#f59e0b'; stepColor = '#f59e0b';
      stepEl = SVG_PLAY;
    } else if (isLocked) {
      stepBg = 'var(--line)'; stepBorder = 'var(--line)'; stepColor = 'var(--muted)';
      stepEl = SVG_LOCK;
    } else {
      stepBg = 'var(--bg)'; stepBorder = 'var(--line)'; stepColor = 'var(--muted)';
      stepEl = `<span style="font-size:.8rem;font-weight:700">${i+1}</span>`;
    }

    const statusTag = status === 'completed'
      ? `<span style="font-size:.7rem;background:rgba(16,185,129,.1);color:#10b981;border:1px solid rgba(16,185,129,.25);border-radius:99px;padding:2px 9px;font-weight:600">Complete</span>`
      : status === 'in_progress'
      ? `<span style="font-size:.7rem;background:rgba(245,158,11,.1);color:#b45309;border:1px solid rgba(245,158,11,.3);border-radius:99px;padding:2px 9px;font-weight:600">In Progress</span>`
      : isLocked
      ? `<span style="font-size:.7rem;background:var(--line);color:var(--muted);border-radius:99px;padding:2px 9px">Locked</span>`
      : `<span style="font-size:.7rem;background:var(--line);color:var(--muted);border-radius:99px;padding:2px 9px">Not Started</span>`;

    const quizTag = mp.quiz_best_score != null
      ? `<span style="font-size:.7rem;background:${mp.quiz_passed?'rgba(16,185,129,.1)':'rgba(239,68,68,.08)'};color:${mp.quiz_passed?'#10b981':'#ef4444'};border:1px solid ${mp.quiz_passed?'rgba(16,185,129,.25)':'rgba(239,68,68,.25)'};border-radius:99px;padding:2px 9px;font-weight:600">Quiz: ${mp.quiz_best_score}%</span>`
      : '';
    const pctTag = status !== 'not_started'
      ? `<span style="font-size:.7rem;background:var(--line);color:var(--muted);border-radius:99px;padding:2px 9px">${mp.percent_complete||0}% done</span>`
      : '';

    return `<article style="display:flex;align-items:flex-start;gap:14px;padding:14px 16px;border-radius:12px;cursor:${isLocked?'not-allowed':'pointer'};border:1.5px solid var(--line);margin-bottom:8px;background:var(--card);transition:border-color .2s,box-shadow .2s;opacity:${isLocked?.5:1}"
      ${isLocked ? '' : `onclick="show('academy','module:${m.id}')" onmouseenter="this.style.borderColor='var(--blue)'" onmouseleave="this.style.borderColor='var(--line)'"`}>
      <div style="width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;background:${stepBg};border:2px solid ${stepBorder};color:${stepColor}">${stepEl}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;color:var(--ink);margin-bottom:3px">Module ${m.sort_order} — ${escapeHtml(m.title)}</div>
        <div style="font-size:.82rem;color:var(--muted);margin-bottom:8px;line-height:1.45">${escapeHtml(m.short_description||'')}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          ${statusTag}${pctTag}${quizTag}
          <span style="font-size:.7rem;background:var(--line);color:var(--muted);border-radius:99px;padding:2px 9px">~${m.estimated_minutes||'?'} min</span>
          <span style="font-size:.7rem;background:var(--line);color:var(--muted);border-radius:99px;padding:2px 9px">${m.difficulty||''}</span>
        </div>
      </div>
      ${isLocked ? '' : `<div style="color:var(--blue);align-self:center;flex-shrink:0">${SVG_ARROW}</div>`}
    </article>`;
  }).join('');

  view.innerHTML = ACAD_STYLES + `
<button class="secondary-btn" style="margin-bottom:16px" onclick="show('academy')">← Academy Home</button>
<div style="display:flex;align-items:center;gap:14px;margin-bottom:8px">
  <div style="flex-shrink:0">${svgPhaseIcon(ph.sort_order, ph.color, 44)}</div>
  <div>
    <div class="eyebrow" style="color:${ph.color}">Phase ${ph.sort_order}</div>
    <h1 style="margin:0;color:var(--ink)">${escapeHtml(ph.title)}</h1>
  </div>
</div>
<p class="lede" style="margin-bottom:18px;color:var(--muted)">${escapeHtml(ph.long_description)}</p>

<div class="card" style="margin-bottom:20px">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
    <span style="font-weight:600;color:var(--ink)">Phase Progress</span>
    <span style="font-weight:700;color:${ph.color}">${pct}%</span>
  </div>
  <div style="height:8px;background:var(--line);border-radius:4px;overflow:hidden">
    <div style="height:100%;width:${pct}%;background:${ph.color};border-radius:4px;transition:width .5s"></div>
  </div>
  <div style="margin-top:8px;font-size:.8rem;color:var(--muted)">${completedCount} of ${phaseMods.length} modules complete</div>
</div>

<div class="acad-section-label">Module Roadmap</div>
${moduleRows}`;
}

// ─── Module Workspace ─────────────────────────────────────────────────────────
function academyModuleWorkspace(moduleId) {
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  const repId = rep ? rep.id : 'ryan';
  const content = window.Academy.getContent();
  const mod = content.modules.find(m => m.id === moduleId);
  if (!mod) { academy(); return; }

  const ph = content.phases.find(p => p.id === mod.phase_id);
  const mp = window.Academy.getModuleProgress(repId, moduleId);
  const isLocked = window.Academy.isModuleLocked(moduleId, repId);

  if (isLocked) {
    view.innerHTML = ACAD_STYLES + `
<button class="secondary-btn" style="margin-bottom:16px" onclick="show('academy','phase:${mod.phase_id}')">← ${escapeHtml(ph ? ph.title : 'Phase')}</button>
<div class="card" style="text-align:center;padding:40px">
  <div style="margin-bottom:16px">${svgBadgeShape('shield','var(--muted)',52)}</div>
  <h2 style="color:var(--ink)">Module Locked</h2>
  <p style="color:var(--muted)">Complete all modules in Phase ${ph ? ph.sort_order - 1 : ''} to unlock this module.</p>
  <button class="primary-btn" onclick="show('academy')">Back to Academy</button>
</div>`;
    return;
  }

  const _sectionId = `acad_active_${moduleId}`;
  const activeSectionId = localStorage.getItem(_sectionId) || (mod.sections[0] && mod.sections[0].id);
  const activeSection = mod.sections.find(s => s.id === activeSectionId) || mod.sections[0];
  const phColor = ph ? ph.color : 'var(--blue)';

  const navItems = mod.sections.map(s => {
    const done = mp.sections_completed.includes(s.id);
    const isActive = s.id === (activeSection && activeSection.id);
    const typeLabel = s.section_type === 'overview' ? 'OV' : s.section_type === 'lesson' ? 'L' : s.section_type === 'quiz' ? 'Q' : 'S';
    return `<div class="ws-nav-item ${isActive ? 'active-section' : done ? 'done-section' : ''}" onclick="academyShowSection('${moduleId}','${s.id}')" id="ws-nav-${s.id}">
      <div class="ws-nav-dot ${done ? 'done' : isActive ? 'active' : ''}">
        ${done ? SVG_CHECK : `<span style="font-size:.6rem;font-weight:700">${typeLabel}</span>`}
      </div>
      <span style="line-height:1.35">${escapeHtml(s.title)}</span>
    </div>`;
  }).join('');

  view.innerHTML = ACAD_STYLES + `
<div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap">
  <button class="secondary-btn" onclick="show('academy','phase:${mod.phase_id}')">← ${escapeHtml(ph ? ph.title : 'Phase')}</button>
  <span style="color:var(--muted);font-size:.85rem">›</span>
  <span style="color:var(--muted);font-size:.85rem">Module ${mod.sort_order}</span>
</div>

<h1 style="font-size:1.38rem;margin:0 0 4px;color:var(--ink)">${escapeHtml(mod.title)}</h1>
<p style="color:var(--muted);font-size:.88rem;margin:0 0 18px">${escapeHtml(mod.short_description||'')}</p>

<div class="workspace-layout">
  <nav class="workspace-nav" id="ws-nav">
    <div class="workspace-nav-header">
      <div class="workspace-nav-title">Progress</div>
      <div class="workspace-nav-pct" id="ws-pct">${mp.percent_complete}%</div>
      <div class="workspace-nav-bar"><div class="workspace-nav-fill" id="ws-bar" style="width:${mp.percent_complete}%;background:${phColor}"></div></div>
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
    <div>${svgBadgeShape(passed?'check':'bolt', passed?'#10b981':'#ef4444', 40)}</div>
    <div>
      <div style="font-size:1.1rem;font-weight:700;color:${passed?'#10b981':'#ef4444'}">${passed ? 'Quiz Passed!' : 'Not quite yet'}</div>
      <div style="font-size:.85rem;color:var(--muted)">${score}% — ${passedCount} of ${totalCount} correct${passed ? ' — module progress updated.' : ` — ${mod.quiz.pass_score}% required.`}</div>
    </div>
  </div>
  ${result.feedback.map(f => {
    const q = mod.quiz.questions.find(qq => qq.id === f.questionId);
    return `<div class="quiz-feedback-item ${f.correct ? 'correct' : 'wrong'}">
      <div style="font-weight:700;font-size:.82rem;color:${f.correct?'#10b981':'#ef4444'};margin-bottom:3px">${f.correct ? 'Correct' : 'Incorrect'}</div>
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

// ─── Badges View ──────────────────────────────────────────────────────────────
function academyBadgesView() {
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  const repId = rep ? rep.id : 'ryan';
  const rp = window.Academy.getRepProgress(repId);
  const earned = new Set(rp.badges || []);
  const earnedBadges = window.Academy.BADGE_DEFS.filter(b => earned.has(b.id));
  const lockedBadges = window.Academy.BADGE_DEFS.filter(b => !earned.has(b.id));

  const badgeCard = (b, isEarned) => `
  <article class="card" style="text-align:center;${isEarned ? `border-color:${b.color}44;background:${b.color}08` : 'opacity:.5'}">
    <div style="display:flex;justify-content:center;margin-bottom:10px">${svgBadgeShape(b.shape, isEarned ? b.color : 'var(--muted)', 52)}</div>
    <div style="font-weight:700;font-size:.92rem;color:${isEarned ? b.color : 'var(--muted)'};margin-bottom:5px">${escapeHtml(b.name)}</div>
    <div style="font-size:.78rem;color:var(--muted);line-height:1.45">${escapeHtml(b.desc)}</div>
    <div style="font-size:.66rem;margin-top:8px;text-transform:uppercase;letter-spacing:.06em;color:${isEarned ? b.color+'aa' : 'var(--muted)'};font-weight:700">${b.type}</div>
  </article>`;

  view.innerHTML = ACAD_STYLES + `
<button class="secondary-btn" style="margin-bottom:16px" onclick="show('academy')">← Academy Home</button>
<div class="eyebrow">Achievements</div>
<h1 style="color:var(--ink)">Badges &amp; Achievements</h1>
<p class="lede" style="color:var(--muted)">${earnedBadges.length} of ${window.Academy.BADGE_DEFS.length} badges earned</p>

${earnedBadges.length ? `
<div class="acad-section-label">Earned Badges (${earnedBadges.length})</div>
<div class="grid grid-3 mt" style="margin-top:0;margin-bottom:26px">
  ${earnedBadges.map(b => badgeCard(b, true)).join('')}
</div>` : `<div class="card" style="text-align:center;padding:30px;margin-bottom:22px">
  <div style="display:flex;justify-content:center;margin-bottom:12px">${svgBadgeShape('bolt','var(--muted)',44)}</div>
  <p style="color:var(--muted)">No badges earned yet — complete modules to start earning.</p>
</div>`}

<div class="acad-section-label">Locked Badges (${lockedBadges.length})</div>
<div class="grid grid-3 mt" style="margin-top:0">
  ${lockedBadges.map(b => badgeCard(b, false)).join('')}
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

  const SVG_FLAME = `<svg width="13" height="13" viewBox="0 0 24 24" fill="#f97316" stroke="none"><path d="M12 2C8 7 6 10 6 14a6 6 0 0 0 12 0c0-4-2-7-6-12zM9.5 17c-.3-1.2.5-2.4 2.5-3-.5 1.5.2 2.5 1 3 .3-1 1-1.8 1-3 1 .8 1.5 2 1 3a4 4 0 0 1-5.5 0z"/></svg>`;
  const SVG_CERT  = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="6"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/><path d="M8 21l4-2 4 2v-6H8z"/></svg>`;
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
            ? `<span style="font-size:.75rem;color:#f59e0b;font-weight:600">${SVG_CERT} Certified ${fmtDate(certData.at)} by ${escapeHtml(certData.by)}</span>`
            : (allDone
                ? `<button class="admin-action-btn" style="background:rgba(245,158,11,.12);color:#f59e0b;border-color:rgba(245,158,11,.35)" onclick="academyAdminCertifyPhase('${r.rep.id}','${ph.id}','${escapeHtml(r.rep.name)}','${escapeHtml(ph.certification_name||ph.title)}')">${SVG_CERT} Certify ${escapeHtml(ph.certification_name||ph.title)}</button>`
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
      ? `<span style="display:inline-flex;align-items:center;gap:3px;font-size:.72rem;font-weight:600;color:#f97316;background:rgba(249,115,22,.1);border:1px solid rgba(249,115,22,.3);border-radius:99px;padding:2px 8px">${SVG_FLAME}${streak}-day streak</span>`
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
        ${qScore != null ? `<div style="font-size:.6rem;margin-top:2px;color:${isComp&&qScore>=75?'#10b981':'var(--muted)'}">${qScore}%</div>` : ''}
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
              <div style="height:100%;width:${r.pct}%;background:${r.pct===100?'#10b981':'var(--blue)'};border-radius:4px;transition:width .5s"></div>
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
            <div style="font-size:1.1rem;font-weight:700;color:${r.pct===100?'#10b981':'var(--ink)'}">${r.pct}%</div>
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
            <div style="font-size:1rem;font-weight:700;color:${r.quizAvg!=null?(r.quizAvg>=75?'#10b981':'#ef4444'):'var(--muted)'}">${r.quizAvg != null ? r.quizAvg+'%' : '—'}</div>
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
        <div id="quiz-drill-${r.rep.id}" style="display:none;padding:12px 16px;background:#f8fafc;border-top:1px solid var(--line)"></div>

        <!-- Mark complete buttons -->
        <div style="padding:10px 16px;border-top:1px solid var(--line);display:flex;flex-wrap:wrap;gap:8px;align-items:center">
          <span style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-right:4px">Mark Complete:</span>
          ${markBtns || `<span style="font-size:.8rem;color:#10b981">${SVG_CHECK} All modules complete</span>`}
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
          <span style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#ef4444;margin-right:4px">Danger:</span>
          <button class="admin-action-btn danger" onclick="academyAdminResetRep('${r.rep.id}','${escapeHtml(r.rep.name)}')">Reset All Progress</button>
        </div>
      </div>
    </div>`;
  }).join('');

  view.innerHTML = ACAD_STYLES + `
<button class="secondary-btn" style="margin-bottom:16px" onclick="show('academy')">← Academy Home</button>
<div class="eyebrow">Admin Dashboard</div>
<h1 style="color:var(--ink)">Team Academy Progress</h1>

<div class="grid grid-3 mt" style="margin-bottom:22px;grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">
  <div class="card" style="text-align:center">
    <div style="font-size:1.7rem;font-weight:700;color:var(--ink)">${allReps.length}</div>
    <div style="font-size:.75rem;color:var(--muted);margin-top:4px">Team Members</div>
  </div>
  <div class="card" style="text-align:center">
    <div style="font-size:1.7rem;font-weight:700;color:#10b981">${allReps.filter(r=>r.pct===100).length}</div>
    <div style="font-size:.75rem;color:var(--muted);margin-top:4px">Academy Complete</div>
  </div>
  <div class="card" style="text-align:center">
    <div style="font-size:1.7rem;font-weight:700;color:var(--blue)">${avgPct}%</div>
    <div style="font-size:.75rem;color:var(--muted);margin-top:4px">Avg Completion</div>
  </div>
  <div class="card" style="text-align:center">
    <div style="font-size:1.7rem;font-weight:700;color:#f59e0b">${teamQuizAvg != null ? teamQuizAvg+'%' : '—'}</div>
    <div style="font-size:.75rem;color:var(--muted);margin-top:4px">Team Quiz Avg</div>
  </div>
  <div class="card" style="text-align:center">
    <div style="font-size:1.7rem;font-weight:700;color:#f97316">${activeStreaks}</div>
    <div style="font-size:.75rem;color:var(--muted);margin-top:4px">Active Streaks</div>
  </div>
</div>

<div class="acad-section-label" style="margin-top:4px">Rep Progress — click a row to expand</div>
${repCards}

<div class="acad-section-label" style="margin-top:24px">Phase Certifications &amp; Bulk Actions</div>
${phaseRows}

<div class="card" style="margin-top:18px;border-color:rgba(99,102,241,.2);background:rgba(99,102,241,.03)">
  <div style="font-size:.78rem;font-weight:700;color:#6366f1;margin-bottom:8px">Admin Controls Guide</div>
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
          <div style="font-size:.78rem;color:${f.correct?'#10b981':'#ef4444'};margin-bottom:4px">
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
            <span style="font-size:.78rem;color:var(--muted)">Attempt ${idx+1} of ${attempts.length} · ${fmtDate(att.submitted_at)} · Score: <strong style="color:${att.passed?'#10b981':'#ef4444'}">${att.percent_score}%</strong> ${att.passed?'PASSED':'FAILED'}</span>
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
    const barColor = pct >= 100 ? '#4ade80' : pct >= 70 ? '#fbbf24' : '#f87171';
    return `<div style="height:6px;background:#1e293b;border-radius:4px;margin-top:6px"><div style="height:6px;width:${pct}%;background:${barColor};border-radius:4px;transition:width .5s"></div></div><div style="font-size:10px;color:#64748b;margin-top:3px">${pct}% of target</div>`;
  }

  const DIV_SVG = {
    landscape:   '<svg width="20" height="20" viewBox="0 0 18 18" fill="none"><path d="M9 15V9.5M9 9.5C9 9.5 5 9.5 3 5c3 0 6 2 6 4.5zm0 0c0 0 4 0 6-4.5-3 0-6 2-6 4.5z" stroke="#4ade80" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    maintenance: '<svg width="20" height="20" viewBox="0 0 18 18" fill="none"><path d="M12.5 3a3 3 0 00-2.5 4.5L3.8 13.8a.8.8 0 001.2 1.2l6.5-5.7A3 3 0 0014 10a3 3 0 00-.5-1.5l-1.8 1.8-1.2-1.2 1.8-1.8A3 3 0 0012.5 3z" stroke="#22d3ee" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    snow:        '<svg width="20" height="20" viewBox="0 0 18 18" fill="none"><path d="M9 2.5v13M2.5 9h13M4.5 4.5l9 9M13.5 4.5l-9 9" stroke="#93c5fd" stroke-width="1.5" stroke-linecap="round"/><circle cx="9" cy="2.5" r="1" fill="#93c5fd"/><circle cx="9" cy="15.5" r="1" fill="#93c5fd"/><circle cx="2.5" cy="9" r="1" fill="#93c5fd"/><circle cx="15.5" cy="9" r="1" fill="#93c5fd"/></svg>',
  };
  function divTile(div){
    const abovePlan = div.remaining <= 0;
    const gmOk = div.grossMarginPct >= div.grossMarginFloor;
    const divKey = div.name ? div.name.toLowerCase().replace(/[^a-z]/g,'') : '';
    const divSvg = divKey.includes('landscape') ? DIV_SVG.landscape : divKey.includes('snow') ? DIV_SVG.snow : divKey.includes('maint') ? DIV_SVG.maintenance : '';
    return `<article style="background:#0f172a;border:1px solid ${abovePlan?'#16a34a':'#1e293b'};border-radius:14px;padding:20px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">${divSvg} <span style="font-weight:700;font-size:1rem">${div.name}</span>
        ${abovePlan ? '<span style="background:#16a34a;color:#fff;font-size:10px;font-weight:700;border-radius:20px;padding:2px 8px;margin-left:8px">\u2713 ABOVE PLAN</span>' : ''}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px">
        <div><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.05em">Target</div><div style="font-size:1.3rem;font-weight:800;color:#e2e8f0">${fmtM(div.target)}</div></div>
        <div><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.05em">Actual (5/21)</div><div style="font-size:1.3rem;font-weight:800;color:${abovePlan?'#4ade80':'#00d4ff'}">${fmtM(div.actual)}</div></div>
        <div><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.05em">GM Floor</div><div style="font-size:1rem;font-weight:700;color:#f59e0b">${Math.round(div.grossMarginFloor*100)}%</div></div>
        <div><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.05em">Actual GM</div><div style="font-size:1rem;font-weight:700;color:${gmOk?'#4ade80':'#f87171'}">${Math.round(div.grossMarginPct*100)}%</div></div>
      </div>
      ${pbar(div.actual, div.target)}
      ${div.remaining > 0 ? `<div style="font-size:11px;color:#64748b;margin-top:6px">Remaining: <strong style="color:#e2e8f0">${fmtM(div.remaining)}</strong></div>` : `<div style="font-size:11px;color:#4ade80;margin-top:6px;font-weight:700">+${fmtM(Math.abs(div.remaining))} over plan</div>`}
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
    const varColor = m.variance == null ? '#334155' : m.variance >= 0 ? '#4ade80' : '#f87171';
    const mIdx2 = allMonthNames.indexOf(m.month.slice(0,3));
    const isPastMonth = mIdx2 >= 0 && new Date(2026, mIdx2, 1) < todayM;
    const missingBadge = !hasActual && isPastMonth ? '<span class="missing-data-badge">Missing</span>' : '';
    return `<tr style="border-bottom:1px solid #0f172a">
      <td style="padding:8px 10px;color:#e2e8f0;font-weight:600">${m.month} ${missingBadge}</td>
      <td style="padding:8px 10px;text-align:right">${fmtM(m.budgeted)}</td>
      <td style="padding:8px 10px;text-align:right;color:${hasActual?'#00d4ff':'#334155'}">${hasActual ? fmtM(m.actual) : '\u2014'}</td>
      <td style="padding:8px 10px;text-align:right;color:${varColor}">${m.variance != null ? varSign+fmtM(m.variance) : '\u2014'}</td>
    </tr>`;
  }).join('');

  view.innerHTML = `
    <div class="eyebrow">Leadership Rhythm \u2014 FY2026</div>
    <h1>Manager Tools <span style="font-size:13px;color:#64748b;font-weight:400;margin-left:8px">${escapeHtml(fy.budgetVersion)}</span>${(()=>{ const _cr = window.getCurrentRep ? window.getCurrentRep() : null; return (_cr && _cr.role === 'office_manager') ? '<span style="font-size:12px;color:#f59e0b;font-weight:400;margin-left:10px;vertical-align:middle;background:#f59e0b18;border:1px solid #f59e0b40;border-radius:8px;padding:2px 8px">Office Manager View — Read Only</span>' : ''; })()}</h1>
    <p class="lede">Real division P&amp;L, monthly actuals, HubSpot pipeline gates, pricing discipline, and team scorecard.</p>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:12px;margin-bottom:28px;background:linear-gradient(135deg,#0a1628,#0f172a);border:1px solid #1e4d6b;border-radius:14px;padding:20px">
      <div style="text-align:center">
        <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.07em">FY2026 Budget</div>
        <div style="font-size:1.9rem;font-weight:900;color:#e2e8f0">${fmtM(annual.budgetedRevenue)}</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.07em">Actual (5/21)</div>
        <div style="font-size:1.9rem;font-weight:900;color:#00d4ff">${fmtM(annual.actualRevenue)}</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.07em">Remaining</div>
        <div style="font-size:1.9rem;font-weight:900;color:#f87171">${fmtM(annual.remaining)}</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.07em">Needed / Month</div>
        <div style="font-size:1.9rem;font-weight:900;color:#f59e0b">${fmtM(annual.avgNeededPerMonth)}</div>
        <div style="font-size:10px;color:#64748b">${annual.monthsLeft} months remaining</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.07em">Operating GM</div>
        <div style="font-size:1.9rem;font-weight:900;color:#a78bfa">${Math.round(annual.grossMarginPct*100)}%</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.07em">True Net Income</div>
        <div style="font-size:1.5rem;font-weight:900;color:#4ade80">${fmtM(annual.trueNetIncome)}</div>
        <div style="font-size:10px;color:#64748b">after ${fmtM(annual.loanMonthly)}/mo loans</div>
      </div>
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-top:28px;margin-bottom:0">
      <h2 style="font-size:1rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0">Division P&amp;L \u2014 Actual vs Target</h2>
      <button class="primary-btn" onclick="show('revenueAdmin')" style="font-size:12px;padding:6px 14px;background:linear-gradient(135deg,#1d4ed8,#1e40af)">Edit Monthly Revenue</button>
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
          <thead><tr style="background:#0f172a"><th style="padding:8px 12px;text-align:left;color:#64748b;border-bottom:1px solid #1e293b">Growth Bucket</th><th style="padding:8px 12px;text-align:center;color:#64748b;border-bottom:1px solid #1e293b">Segment</th><th style="padding:8px 12px;text-align:right;color:#64748b;border-bottom:1px solid #1e293b">Target</th></tr></thead>
          <tbody>${(divs.maintenance.growthPipeline||[]).map(b=>`<tr style="border-bottom:1px solid #0f172a"><td style="padding:8px 12px">${escapeHtml(b.bucket)}</td><td style="padding:8px 12px;text-align:center">${escapeHtml(b.segment)}</td><td style="padding:8px 12px;text-align:right;font-weight:700;color:#4ade80">${fmtM(b.target)}</td></tr>`).join('')}</tbody>
        </table>
      </div>
    </div>

    ${missingPastMonths.length > 0 ? `<div class="missing-data-alert"><strong>${missingPastMonths.length} past month${missingPastMonths.length>1?'s':''} missing actuals:</strong> ${missingPastMonths.map(m=>m.month).join(', ')} — <button onclick="show('revenueAdmin','division')" style="background:none;border:none;color:#00d4ff;cursor:pointer;font-size:inherit;text-decoration:underline;padding:0">Enter data →</button></div>` : ''}
    <div class="card mt">
      <h2>Monthly Revenue — Budget vs Actual (Jan–Dec 2026)</h2>
      <p class="muted small-text">Actuals through 5/21/2026. Remaining months show budget target only.</p>
      <div style="overflow-x:auto;margin-top:12px">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="background:#0f172a">
            <th style="padding:8px 12px;text-align:left;color:#64748b;border-bottom:1px solid #1e293b">Month</th>
            <th style="padding:8px 12px;text-align:right;color:#64748b;border-bottom:1px solid #1e293b">Budgeted</th>
            <th style="padding:8px 12px;text-align:right;color:#00d4ff;border-bottom:1px solid #1e293b">Actual</th>
            <th style="padding:8px 12px;text-align:right;color:#64748b;border-bottom:1px solid #1e293b">Variance</th>
          </tr></thead>
          <tbody>${monthRows}</tbody>
          <tfoot><tr style="background:#0f172a;font-weight:700">
            <td style="padding:10px 12px;color:#e2e8f0">YTD Total</td>
            <td style="padding:10px 12px;text-align:right">${fmtM(ytdBudgeted)}</td>
            <td style="padding:10px 12px;text-align:right;color:#00d4ff">${fmtM(annual.actualRevenue)}</td>
            <td style="padding:10px 12px;text-align:right;color:${ytdVariance>=0?'#4ade80':'#f87171'}">${ytdVariance>=0?'+':''}${fmtM(ytdVariance)}</td>
          </tr></tfoot>
        </table>
      </div>
    </div>

    <!-- ── DIVISION PIPELINE / PAPER ON THE STREET ── -->
    <div class="card mt" id="divPipelineSection">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;flex-wrap:wrap;gap:8px">
        <div>
          <h2 style="margin:0;font-size:16px">Pipeline by Division</h2>
          <div style="font-size:11px;color:#64748b;margin-top:3px">
            <strong style="color:#a78bfa">Paper on the Street</strong>
            <span style="color:#475569"> = active quoted / proposed value currently in front of customers, not yet sold or lost</span>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <select id="dpRepFilter" onchange="window._renderDpTable&&window._renderDpTable()" style="padding:5px 10px;background:#0f172a;border:1px solid #1e293b;border-radius:8px;color:#e2e8f0;font-size:11px">
            <option value="">All Reps</option>
            ${(window.REPS||[]).filter(r=>r.role==='rep').map(r=>'<option value="'+r.id+'">'+r.name+'</option>').join('')}
          </select>
          <select id="dpEstFilter" onchange="window._renderDpTable&&window._renderDpTable()" style="padding:5px 10px;background:#0f172a;border:1px solid #1e293b;border-radius:8px;color:#e2e8f0;font-size:11px">
            <option value="">All Estimate Statuses</option>
            <option value="sent">Sent</option>
            <option value="revised">Revised</option>
            <option value="viewed">Viewed</option>
            <option value="awaiting_response">Awaiting Response</option>
          </select>
        </div>
      </div>

      <div id="dpTableWrap" style="overflow-x:auto;margin-top:8px"></div>

      <div style="margin-top:20px;border-top:1px solid #1e293b;padding-top:16px">
        <h3 style="font-size:13px;font-weight:700;color:#94a3b8;margin:0 0 10px;text-transform:uppercase;letter-spacing:.08em">Estimate Aging — Open Paper</h3>
        <div id="dpAgingWrap" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px"></div>
      </div>
    </div>


    <div class="card mt">
      <h2>\ud83d\udd35 HubSpot 7-Stage Pipeline \u2014 Win Probabilities &amp; Gate Fields</h2>
      <p class="muted small-text">${escapeHtml((data.hubspotPipeline||{}).description||'')}</p>
      <div style="overflow-x:auto;margin-top:12px">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="background:#0f172a">
            <th style="padding:8px 10px;text-align:center;color:#64748b;border-bottom:1px solid #1e293b">#</th>
            <th style="padding:8px 10px;text-align:left;color:#64748b;border-bottom:1px solid #1e293b">Stage Name</th>
            <th style="padding:8px 10px;text-align:center;color:#64748b;border-bottom:1px solid #1e293b">Win %</th>
            <th style="padding:8px 10px;text-align:left;color:#64748b;border-bottom:1px solid #1e293b">Mandatory Gate Fields</th>
          </tr></thead>
          <tbody>${((data.hubspotPipeline||{}).stages||[]).map(s=>{
            const pct = Math.round(s.winProb*100);
            const barC = pct>=80?'#4ade80':pct>=60?'#fbbf24':pct>=40?'#60a5fa':'#94a3b8';
            return `<tr style="border-bottom:1px solid #0f172a">
              <td style="padding:8px 10px;text-align:center;font-weight:800;color:${barC}">${s.num}</td>
              <td style="padding:8px 10px;font-weight:600;color:#e2e8f0">${escapeHtml(s.name)}</td>
              <td style="padding:8px 10px;text-align:center">
                <div style="display:flex;align-items:center;gap:6px;justify-content:center">
                  <div style="width:48px;height:5px;background:#1e293b;border-radius:3px"><div style="width:${pct}%;height:5px;background:${barC};border-radius:3px"></div></div>
                  <span style="font-weight:700;color:${barC};font-size:11px">${pct}%</span>
                </div>
              </td>
              <td style="padding:8px 10px;font-size:11px;color:#94a3b8">${(s.gates||[]).join(' \u00b7 ')}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>
      <div style="margin-top:12px"><h4 style="font-size:12px;color:#64748b;margin-bottom:6px">Hygiene Rules</h4>${list((data.hubspotPipeline||{}).hygieneRules||[])}</div>
    </div>

    <div class="grid grid-2 mt">
      <div class="card">
        <h2>\ud83d\udcb2 Pricing Discipline \u2014 GM Floors</h2>
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:8px">
          <thead><tr style="background:#0f172a"><th style="padding:8px 10px;text-align:left;color:#64748b;border-bottom:1px solid #1e293b">Division</th><th style="padding:8px 10px;text-align:center;color:#64748b;border-bottom:1px solid #1e293b">Floor</th><th style="padding:8px 10px;text-align:left;color:#64748b;border-bottom:1px solid #1e293b">Current Status</th></tr></thead>
          <tbody>${(pd.grossMarginFloors||[]).map(g=>`<tr style="border-bottom:1px solid #0f172a"><td style="padding:8px 10px;font-weight:600">${escapeHtml(g.division)}</td><td style="padding:8px 10px;text-align:center;font-weight:800;color:#4ade80">${escapeHtml(g.floor)}</td><td style="padding:8px 10px;font-size:11px;color:#94a3b8">${escapeHtml(g.current)}</td></tr>`).join('')}</tbody>
        </table>
        <h4 style="font-size:12px;color:#64748b;margin-top:16px;margin-bottom:6px">Labor Recovery Rules</h4>
        ${list(pd.laborRecoveryRules||[])}
      </div>
      <div class="card">
        <h2>\ud83d\udccb Cost Recovery by Division</h2>
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:8px">
            <thead><tr style="background:#0f172a"><th style="padding:6px 8px;text-align:left;color:#64748b;border-bottom:1px solid #1e293b">Category</th><th style="padding:6px 8px;text-align:center;color:#22d3ee;border-bottom:1px solid #1e293b">Landscape</th><th style="padding:6px 8px;text-align:center;color:#4ade80;border-bottom:1px solid #1e293b">Maintenance</th><th style="padding:6px 8px;text-align:center;color:#60a5fa;border-bottom:1px solid #1e293b">Snow</th></tr></thead>
            <tbody>${(pd.activityCostRecovery||[]).map(r=>`<tr style="border-bottom:1px solid #0f172a"><td style="padding:6px 8px;color:#94a3b8">${escapeHtml(r.category)}</td><td style="padding:6px 8px;text-align:center;font-weight:600">${escapeHtml(r.landscape)}</td><td style="padding:6px 8px;text-align:center;font-weight:600">${escapeHtml(r.maintenance)}</td><td style="padding:6px 8px;text-align:center;font-weight:600">${escapeHtml(r.snow)}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="grid grid-2 mt">
      <div class="card">
        <h2>\ud83d\udc64 Tyler \u2014 Leadership Scorecard</h2>
        <p class="muted small-text">Owner / CEO \u00b7 Total cost: $${((tylerCard&&tylerCard.totalEmployeeCost)||0).toLocaleString()}/yr</p>
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:12px">
          <thead><tr style="background:#0f172a"><th style="padding:8px 10px;text-align:left;color:#64748b;border-bottom:1px solid #1e293b">Metric</th><th style="padding:8px 10px;text-align:left;color:#64748b;border-bottom:1px solid #1e293b">Target</th><th style="padding:8px 10px;text-align:center;color:#64748b;border-bottom:1px solid #1e293b">Cadence</th></tr></thead>
          <tbody>${((tylerCard&&tylerCard.leadershipScorecard)||[]).map(sc=>`<tr style="border-bottom:1px solid #0f172a"><td style="padding:8px 10px;font-weight:600;color:#e2e8f0">${escapeHtml(sc.metric)}</td><td style="padding:8px 10px;color:#4ade80;font-weight:700">${escapeHtml(sc.target)}</td><td style="padding:8px 10px;text-align:center;color:#94a3b8;font-size:11px">${escapeHtml(sc.cadence)}</td></tr>`).join('')}</tbody>
        </table>
      </div>
      <div class="card">
        <h2>\ud83d\uddd3 Review Cadence</h2>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
          ${(rc||[]).map(r=>`<div style="display:flex;gap:10px;align-items:flex-start;padding:8px;background:var(--bg2);border-radius:8px">
            <span style="font-size:10px;font-weight:700;color:#f59e0b;background:rgba(245,158,11,.12);padding:2px 8px;border-radius:10px;min-width:60px;text-align:center">${escapeHtml(r.cadence)}</span>
            <div><div style="font-size:13px;font-weight:600;color:#e2e8f0">${escapeHtml(r.meeting)}</div><div style="font-size:11px;color:#64748b">${escapeHtml(r.attendees)} \u00b7 ${escapeHtml(r.output)}</div></div>
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
    const COLORS = {landscape:'#22d3ee',maintenance:'#4ade80',snow:'#60a5fa'};

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
    function ageColor(days){ if(days==null)return'#475569'; if(days<=7)return'#4ade80'; if(days<=14)return'#fbbf24'; if(days<=30)return'#f97316'; return'#f87171'; }

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

    const headerRow = `<tr style="background:#0f172a">
      <th style="padding:8px 10px;text-align:left;color:#64748b;border-bottom:1px solid #1e293b;font-size:11px">Division</th>
      <th style="padding:8px 10px;text-align:right;color:#64748b;border-bottom:1px solid #1e293b;font-size:11px">Open Pipeline</th>
      <th style="padding:8px 10px;text-align:right;color:#a78bfa;border-bottom:1px solid #1e293b;font-size:11px" title="Active quoted/proposed value in front of customers, not yet sold or lost">Paper on the Street</th>
      <th style="padding:8px 10px;text-align:right;color:#64748b;border-bottom:1px solid #1e293b;font-size:11px">Open Est. Value</th>
      <th style="padding:8px 10px;text-align:right;color:#64748b;border-bottom:1px solid #1e293b;font-size:11px">Weighted</th>
      <th style="padding:8px 10px;text-align:center;color:#64748b;border-bottom:1px solid #1e293b;font-size:11px">Active Opps</th>
      <th style="padding:8px 10px;text-align:center;color:#64748b;border-bottom:1px solid #1e293b;font-size:11px">Open Ests</th>
      <th style="padding:8px 10px;text-align:center;color:#64748b;border-bottom:1px solid #1e293b;font-size:11px">Avg Age</th>
      <th style="padding:8px 10px;text-align:center;color:#64748b;border-bottom:1px solid #1e293b;font-size:11px">Oldest</th>
      <th style="padding:8px 10px;text-align:center;color:#64748b;border-bottom:1px solid #1e293b;font-size:11px">7d Risk</th>
      <th style="padding:8px 10px;text-align:right;color:#64748b;border-bottom:1px solid #1e293b;font-size:11px">Sold Mo.</th>
      <th style="padding:8px 10px;text-align:center;color:#64748b;border-bottom:1px solid #1e293b;font-size:11px">Close Rate</th>
    </tr>`;

    const divRows = KEYS.map(k => {
      const d = stats[k]; const avg=avgAge(d); const mx=maxAge(d);
      return `<tr style="border-bottom:1px solid #0f172a">
        <td style="padding:8px 10px;font-weight:700;color:${COLORS[k]}">${LABELS[k]}</td>
        <td style="padding:8px 10px;text-align:right;font-weight:600">${fm(d.openVal)}</td>
        <td style="padding:8px 10px;text-align:right;font-weight:800;color:#a78bfa">${fm(d.pots)}</td>
        <td style="padding:8px 10px;text-align:right;color:#94a3b8">${fm(d.estVal)}</td>
        <td style="padding:8px 10px;text-align:right;color:#94a3b8">${fm(d.weighted)}</td>
        <td style="padding:8px 10px;text-align:center">${d.openCt}</td>
        <td style="padding:8px 10px;text-align:center">${d.estCt}</td>
        <td style="padding:8px 10px;text-align:center;color:${ageColor(avg)};font-weight:600">${avg!=null?avg+'d':'—'}</td>
        <td style="padding:8px 10px;text-align:center;color:${ageColor(mx)};font-weight:600">${mx!=null?mx+'d':'—'}</td>
        <td style="padding:8px 10px;text-align:center;color:${d.risk7>0?'#fbbf24':'#4ade80'};font-weight:700">${d.risk7}</td>
        <td style="padding:8px 10px;text-align:right;color:#4ade80;font-weight:700">${fm(d.soldMo)}</td>
        <td style="padding:8px 10px;text-align:center;font-weight:700;color:#00d4ff">${cr(d)}</td>
      </tr>`;
    }).join('');

    const totRow = `<tr style="background:#0d1829;border-top:2px solid #1e293b">
      <td style="padding:9px 10px;font-weight:800;color:#e2e8f0">Total</td>
      <td style="padding:9px 10px;text-align:right;font-weight:800;color:#e2e8f0">${fm(totals.openVal)}</td>
      <td style="padding:9px 10px;text-align:right;font-weight:900;color:#a78bfa">${fm(totals.pots)}</td>
      <td style="padding:9px 10px;text-align:right;font-weight:700;color:#94a3b8">${fm(totals.estVal)}</td>
      <td style="padding:9px 10px;text-align:right;color:#94a3b8">${fm(totals.weighted)}</td>
      <td style="padding:9px 10px;text-align:center;font-weight:700">${totals.openCt}</td>
      <td style="padding:9px 10px;text-align:center;font-weight:700">${totals.estCt}</td>
      <td colspan="2" style="padding:9px 10px;text-align:center;color:#475569">—</td>
      <td style="padding:9px 10px;text-align:center;font-weight:700;color:${totals.risk7>0?'#fbbf24':'#4ade80'}">${totals.risk7}</td>
      <td style="padding:9px 10px;text-align:right;font-weight:800;color:#4ade80">${fm(totals.soldMo)}</td>
      <td style="padding:9px 10px"></td>
    </tr>`;

    const tableWrap = document.getElementById('dpTableWrap');
    if (tableWrap) {
      tableWrap.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px;min-width:700px">
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
    const buckets = [{label:'0–7 days',max:7,count:0,val:0,color:'#4ade80'},{label:'8–14 days',min:8,max:14,count:0,val:0,color:'#fbbf24'},{label:'15–30 days',min:15,max:30,count:0,val:0,color:'#f97316'},{label:'30+ days',min:31,count:0,val:0,color:'#f87171'}];
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
        <div style="background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px">${b.label}</div>
          <div style="font-size:22px;font-weight:800;color:${b.color}">${b.count}</div>
          <div style="font-size:12px;color:#94a3b8;margin-top:2px">estimates</div>
          <div style="font-size:13px;font-weight:700;color:${b.color};margin-top:4px">${b.val>0?b.val.toLocaleString(undefined,{style:'currency',currency:'USD',maximumFractionDigits:0}):'—'}</div>
        </div>`).join('');
    }
  }

function settings(){
  const _cr = window.getCurrentRep ? window.getCurrentRep() : null;
  const _ia = _cr && _cr.role === 'admin';
  const _iom = _cr && _cr.role === 'office_manager';
  const adminSections = _ia ? `
    <section class="card" style="border:1px solid #334155">
      <h2>Import</h2>
      <p>Restore a JSON backup from this same app. <strong style="color:#f87171">Admin only.</strong></p>
      <input id="importFile" type="file" accept="application/json">
      <button class="secondary-btn mt8" onclick="importJson()">Import Backup</button>
    </section>
    <section class="card" style="border:1px solid #7f1d1d">
      <h2>Reset All Data</h2>
      <p>Clears all opportunities, notes, and checklist progress on this browser. <strong style="color:#f87171">Admin only — cannot be undone.</strong></p>
      <button class="danger-btn" onclick="confirmReset()">Reset All Local Data</button>
    </section>` : _iom ? `
    <section class="card" style="background:#0a0f1a;border:1px solid #f59e0b30;opacity:.75">
      <h2>Import / Reset</h2>
      <p class="muted">Import and data reset are restricted to Tyler (Owner / Admin). Contact Tyler if a data restore is needed.</p>
    </section>` : `
    <section class="card" style="background:#0a0f1a;border:1px solid #1e293b;opacity:.6">
      <h2>Import / Reset</h2>
      <p class="muted">Import and data reset are restricted to Tyler (Admin).</p>
    </section>`;

  const _viewLabel = _ia
    ? '<span style="font-size:13px;color:#00d4ff;font-weight:400;margin-left:8px">· Owner / Admin View</span>'
    : _iom
    ? '<span style="font-size:13px;color:#f59e0b;font-weight:400;margin-left:8px">· Office Manager View</span>'
    : '<span style="font-size:13px;color:#64748b;font-weight:400;margin-left:8px">· Rep View</span>';

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
    ${_ia ? `<div style="margin-top:20px;padding:14px 18px;background:#0a0f1a;border:1px solid #1e293b;border-radius:10px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
      <div>
        <div style="font-size:13px;font-weight:700;color:#e2e8f0">Admin Controls</div>
        <div style="font-size:12px;color:#64748b;margin-top:2px">Manage users, roles, permissions, and Google Workspace connections.</div>
      </div>
      <button class="secondary-btn" onclick="show('userManagement')" style="font-size:13px">⚙️ User &amp; Access Management →</button>
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
    <div style="margin-top:16px;background:#0f172a;border:1px solid #1e293b;border-radius:14px;padding:16px 18px">
      <div style="font-size:13px;font-weight:700;color:#94a3b8;margin-bottom:12px">⚙️ Commission Admin Tools</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        <button onclick="window._runMigrationFromUI()"
          style="background:#1e293b;border:1px solid #334155;color:#e2e8f0;border-radius:8px;padding:7px 14px;font-size:12px;cursor:pointer">
          📦 Run Data Migration
        </button>
        <button onclick="window._runQAFromUI()"
          style="background:#1e293b;border:1px solid #334155;color:#e2e8f0;border-radius:8px;padding:7px 14px;font-size:12px;cursor:pointer">
          🔍 Run QA Self-Check
        </button>
        <button onclick="window._showFlagPanel()"
          style="background:#1e293b;border:1px solid #334155;color:#e2e8f0;border-radius:8px;padding:7px 14px;font-size:12px;cursor:pointer">
          🚩 Feature Flags
        </button>
      </div>
      <div id="comm-tool-result" style="margin-top:10px;font-size:12px;color:#64748b"></div>
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
  if (!active) return '<p style="color:#64748b;font-size:13px">Commission engine not loaded yet — reload the page.</p>';

  const updatedInfo = override
    ? `<span style="color:#f59e0b;font-size:12px"> ⚙ Custom rules active — last edited ${new Date(override.updatedAt||'').toLocaleDateString()} by ${override.updatedBy||'admin'}</span>`
    : `<span style="color:#4ade80;font-size:12px"> ✓ Using default Avalon commission structure</span>`;

  const lTiers = active.landscape.tiers;
  const ot = active.maintenance.oneTime;
  const rec = active.maintenance.recurring;
  const softCap = active.landscape.softApprovalPayoutThreshold || 1500;
  const hardCap = active.landscape.hardCapPayout || 2500;

  // Build editable tier rows
  const tierRows = lTiers.map((t, i) => {
    const label = t.max ? `$${t.min.toLocaleString()}–$${t.max.toLocaleString()}` : `$${t.min.toLocaleString()}+`;
    if (t.selfGen === null || t.selfGen === undefined) {
      return `<tr style="border-bottom:1px solid #1e293b">
        <td style="padding:7px 10px;font-size:12px;color:#94a3b8">${label}</td>
        <td colspan="3" style="padding:7px 10px;font-size:12px;color:#f59e0b;text-align:center">Management approval required</td>
      </tr>`;
    }
    return `<tr style="border-bottom:1px solid #1e293b">
      <td style="padding:7px 10px;font-size:12px;color:#94a3b8">${label}</td>
      <td style="padding:4px 6px"><input type="number" id="cr-ls-sg-${i}" value="${Math.round(t.selfGen*100)}" min="0" max="50" step="0.5"
        style="width:60px;padding:4px 6px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#4ade80;font-weight:700;font-size:12px;text-align:center"> %</td>
      <td style="padding:4px 6px"><input type="number" id="cr-ls-cl-${i}" value="${Math.round(t.companyLead*100)}" min="0" max="50" step="0.5"
        style="width:60px;padding:4px 6px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#60a5fa;font-weight:700;font-size:12px;text-align:center"> %</td>
      <td style="padding:4px 6px"><input type="number" id="cr-ls-as-${i}" value="${Math.round(t.assisted*100)}" min="0" max="50" step="0.5"
        style="width:60px;padding:4px 6px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#94a3b8;font-weight:700;font-size:12px;text-align:center"> %</td>
    </tr>`;
  }).join('');

  function recInputs(srcKey, colorClass, idPrefix) {
    const r = rec[srcKey];
    if (!r) return '';
    return `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
      <span style="font-size:11px;color:${colorClass};font-weight:700;min-width:90px">${srcKey === 'selfGen' ? 'Self-Generated' : srcKey === 'companyLead' ? 'Company Lead' : 'Assisted'}</span>
      <label style="font-size:11px;color:#64748b">T1%: <input type="number" id="${idPrefix}-t1" value="${Math.round(r.t1Rate*100)}" min="0" max="100" step="1"
        style="width:48px;padding:3px 5px;background:#1e293b;border:1px solid #334155;border-radius:5px;color:#e2e8f0;font-size:11px;text-align:center"></label>
      <label style="font-size:11px;color:#64748b">T2%: <input type="number" id="${idPrefix}-t2" value="${Math.round(r.t2Rate*100)}" min="0" max="100" step="1"
        style="width:48px;padding:3px 5px;background:#1e293b;border:1px solid #334155;border-radius:5px;color:#e2e8f0;font-size:11px;text-align:center"></label>
      <label style="font-size:11px;color:#64748b">T3%: <input type="number" id="${idPrefix}-t3" value="${Math.round(r.t3Rate*100)}" min="0" max="100" step="1"
        style="width:48px;padding:3px 5px;background:#1e293b;border:1px solid #334155;border-radius:5px;color:#e2e8f0;font-size:11px;text-align:center"></label>
      <label style="font-size:11px;color:#64748b">Cap $: <input type="number" id="${idPrefix}-cap" value="${r.cap}" min="0" max="5000" step="25"
        style="width:60px;padding:3px 5px;background:#1e293b;border:1px solid #334155;border-radius:5px;color:#f59e0b;font-size:11px;text-align:center"></label>
      <label style="font-size:11px;color:#64748b">Bonus $: <input type="number" id="${idPrefix}-bonus" value="${r.retentionBonus}" min="0" max="500" step="5"
        style="width:55px;padding:3px 5px;background:#1e293b;border:1px solid #334155;border-radius:5px;color:#4ade80;font-size:11px;text-align:center"></label>
    </div>`;
  }

  return `
  <div style="background:#0a0f1a;border:1px solid #00A7E140;border-radius:14px;padding:20px">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:16px">
      <div>
        <div style="font-size:14px;font-weight:800;color:#e2e8f0">💰 Commission Rules Manager</div>
        <div style="font-size:12px;color:#64748b;margin-top:2px">Edit rates, caps, and thresholds. Changes apply immediately to all commission calculations.${updatedInfo}</div>
      </div>
      <div style="display:flex;gap:8px">
        <button onclick="window._saveCommRules()" style="background:#00A7E1;border:none;color:#fff;border-radius:8px;padding:7px 16px;font-size:13px;font-weight:700;cursor:pointer">Save Rules</button>
        ${override ? `<button onclick="window._resetCommRules()" style="background:#0f172a;border:1px solid #f87171;color:#f87171;border-radius:8px;padding:7px 14px;font-size:12px;cursor:pointer">Reset to Defaults</button>` : ''}
      </div>
    </div>

    <!-- Landscape tiers -->
    <div style="margin-bottom:16px">
      <div style="font-size:10px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px">Landscape / Enhancement Tiers</div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;background:#0f172a;border-radius:8px;overflow:hidden;font-size:12px">
          <thead><tr style="background:#1e293b">
            <th style="padding:8px 10px;text-align:left;color:#64748b;font-size:10px;letter-spacing:.05em">RANGE</th>
            <th style="padding:8px 10px;text-align:center;color:#4ade80;font-size:10px">SELF-GEN %</th>
            <th style="padding:8px 10px;text-align:center;color:#60a5fa;font-size:10px">CO. LEAD %</th>
            <th style="padding:8px 10px;text-align:center;color:#94a3b8;font-size:10px">ASSISTED %</th>
          </tr></thead>
          <tbody>${tierRows}</tbody>
        </table>
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:8px">
        <label style="font-size:11px;color:#64748b">Soft approval at payout $: <input type="number" id="cr-soft-cap" value="${softCap}" min="0" max="10000" step="50"
          style="width:80px;padding:4px 6px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#f59e0b;font-size:12px;text-align:center"></label>
        <label style="font-size:11px;color:#64748b">Hard cap $: <input type="number" id="cr-hard-cap" value="${hardCap}" min="0" max="20000" step="100"
          style="width:80px;padding:4px 6px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#f87171;font-size:12px;text-align:center"></label>
      </div>
    </div>

    <!-- Maintenance one-time -->
    <div style="margin-bottom:16px">
      <div style="font-size:10px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px">Maintenance — One-Time / Seasonal</div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center">
        <label style="font-size:11px;color:#4ade80">Self-Gen %: <input type="number" id="cr-ot-sg" value="${Math.round(ot.selfGen*100)}" min="0" max="50" step="0.5"
          style="width:55px;padding:4px 6px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#4ade80;font-weight:700;font-size:12px;text-align:center"></label>
        <label style="font-size:11px;color:#60a5fa">Co. Lead %: <input type="number" id="cr-ot-cl" value="${Math.round(ot.companyLead*100)}" min="0" max="50" step="0.5"
          style="width:55px;padding:4px 6px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#60a5fa;font-weight:700;font-size:12px;text-align:center"></label>
        <label style="font-size:11px;color:#94a3b8">Assisted %: <input type="number" id="cr-ot-as" value="${Math.round(ot.assisted*100)}" min="0" max="50" step="0.5"
          style="width:55px;padding:4px 6px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#94a3b8;font-weight:700;font-size:12px;text-align:center"></label>
        <label style="font-size:11px;color:#f59e0b">Approval above $: <input type="number" id="cr-ot-approval" value="${ot.approvalAbove || 750}" min="0" max="5000" step="50"
          style="width:70px;padding:4px 6px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#f59e0b;font-size:12px;text-align:center"></label>
      </div>
    </div>

    <!-- Recurring maintenance -->
    <div>
      <div style="font-size:10px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px">Recurring Maintenance — Tiered First-Month</div>
      ${recInputs('selfGen',     '#4ade80', 'cr-rec-sg')}
      ${recInputs('companyLead', '#60a5fa', 'cr-rec-cl')}
      ${recInputs('assisted',    '#94a3b8', 'cr-rec-as')}
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
  if (!result) { if (el) el.textContent = '⚠ Migration function not loaded — refresh and try again.'; return; }
  if (el) el.innerHTML = `<span style="color:#4ade80">✓ Migration complete: ${result.migrated} opps updated, ${result.skipped} already migrated.</span>`;
  if (window.showToast) window.showToast(`Migration: ${result.migrated} updated, ${result.skipped} skipped ✓`);
};

window._runQAFromUI = function() {
  const el = document.getElementById('comm-tool-result');
  if (!window._commQA) { if (el) el.textContent = '⚠ QA function not loaded — refresh and try again.'; return; }
  const { passed, failed, warnings, results } = window._commQA();
  const failItems = results.filter(r => r.status !== 'PASS');
  const statusColor = failed > 0 ? '#f87171' : warnings > 0 ? '#f59e0b' : '#4ade80';
  const icon = failed > 0 ? '❌' : warnings > 0 ? '⚠️' : '✅';
  if (el) {
    el.innerHTML = `
      <div style="color:${statusColor};font-weight:700;margin-bottom:4px">${icon} QA: ${passed} passed · ${warnings} warnings · ${failed} failed</div>
      ${failItems.map(r => `<div style="color:${r.status==='PASS'?'#4ade80':r.status==='WARN'?'#f59e0b':'#f87171'};margin-left:8px">• ${r.name}${r.detail ? ' — ' + r.detail : ''}</div>`).join('')}
      <div style="color:#475569;margin-top:4px;font-size:10px">Full report in browser console (F12)</div>`;
  }
};

window._showFlagPanel = function() {
  const flags = window.getCommissionFlags ? window.getCommissionFlags() : {};
  const el    = document.getElementById('comm-tool-result');
  if (!el) return;
  const rows = Object.entries(flags).map(([k, v]) => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:5px 0;border-bottom:1px solid #1e293b">
      <span style="font-size:12px;color:#94a3b8">${k}</span>
      <button onclick="window._setCommFlag('${k}', ${!v}); window._showFlagPanel();"
        style="background:${v ? '#064e3b' : '#450a0a'};border:none;color:${v ? '#4ade80' : '#f87171'};border-radius:6px;padding:3px 10px;font-size:11px;cursor:pointer;font-weight:700">
        ${v ? 'ON' : 'OFF'}
      </button>
    </div>`).join('');
  el.innerHTML = `
    <div style="background:#0a0f1a;border:1px solid #1e293b;border-radius:8px;padding:10px;margin-top:4px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <span style="font-size:12px;font-weight:700;color:#e2e8f0">Feature Flags</span>
        <button onclick="window._resetCommFlags();window._showFlagPanel();"
          style="font-size:10px;color:#f87171;background:none;border:none;cursor:pointer">Reset all</button>
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
  <div style="background:#0f172a;border:1px solid #1e40af;border-radius:14px;overflow:hidden">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px;background:#0c1a3a;border-bottom:1px solid #1e40af">
      <div>
        <div style="font-size:14px;font-weight:800;color:#e2e8f0">🧮 Commission Simulator</div>
        <div style="font-size:11px;color:#64748b;margin-top:2px">Hypothetical — no data is saved or changed</div>
      </div>
      <button onclick="window._runCommSim()" style="background:#1d4ed8;border:none;color:#fff;border-radius:8px;padding:7px 16px;font-size:13px;font-weight:700;cursor:pointer">Calculate →</button>
    </div>

    <div style="padding:16px 18px;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px">

      <!-- Work Type -->
      <div>
        <label style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em">Work Type</label>
        <select id="sim-workType" style="width:100%;margin-top:5px;padding:8px 10px;background:#1e293b;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px">
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
        <label style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em">Lead Source</label>
        <select id="sim-leadSource" style="width:100%;margin-top:5px;padding:8px 10px;background:#1e293b;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px">
          <option value="company_lead">Company Lead</option>
          <option value="self_generated">Self-Generated</option>
          <option value="assisted">Assisted</option>
        </select>
      </div>

      <!-- Job Value -->
      <div>
        <label style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em">Job Value ($)</label>
        <input id="sim-jobValue" type="number" min="0" step="100" value="5000"
          style="width:100%;margin-top:5px;padding:8px 10px;background:#1e293b;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px;box-sizing:border-box">
      </div>

      <!-- Collected -->
      <div>
        <label style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em">Payment Collected?</label>
        <select id="sim-collected" style="width:100%;margin-top:5px;padding:8px 10px;background:#1e293b;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px">
          <option value="yes">Yes — payment received</option>
          <option value="no">No — pending collection</option>
        </select>
      </div>

      <!-- Pre-approved -->
      <div>
        <label style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em">Tyler Pre-Approved?</label>
        <select id="sim-approved" style="width:100%;margin-top:5px;padding:8px 10px;background:#1e293b;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px">
          <option value="yes">Yes — approved</option>
          <option value="no">No — not yet approved</option>
        </select>
      </div>

    </div>

    <!-- Result panel — populated by _runCommSim() -->
    <div id="sim-result" style="margin:0 18px 16px;padding:14px;background:#060a12;border:1px solid #1e293b;border-radius:10px;min-height:60px;font-size:13px;color:#64748b">
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
    document.getElementById('sim-result').innerHTML = '<span style="color:#f87171">Engine not loaded — refresh and try again.</span>';
    return;
  }

  const r = window.calculateCommission({ planId: 'ryan', workType, leadSource, jobValue, collected, approved, preview: false });

  const fmtC = n => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const fmtP = n => Math.round(n * 100) + '%';

  const amountColor = r.amount > 0 ? '#4ade80' : (r.requiresApproval ? '#f59e0b' : '#f87171');
  const capBadge    = r.capApplied ? `<span style="font-size:10px;background:#f87171;color:#fff;border-radius:10px;padding:2px 7px;margin-left:6px">CAPPED at ${fmtC(r.cap)}</span>` : '';
  const appBadge    = r.requiresApproval ? `<span style="font-size:10px;background:#92400e;color:#fbbf24;border-radius:10px;padding:2px 7px;margin-left:6px">APPROVAL REQUIRED</span>` : '';
  const bonusEl     = r.retentionBonus > 0 ? `<div style="margin-top:8px;font-size:12px;color:#4ade80">+ ${fmtC(r.retentionBonus)} retention bonus eligible after 90-day active period</div>` : '';
  const gateEl      = !collected && !r.requiresApproval && r.amount === 0
    ? `<div style="margin-top:6px;font-size:11px;color:#f59e0b">⚠ Collection gate: commission held until payment is received</div>` : '';

  document.getElementById('sim-result').innerHTML = `
    <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:8px">
      <span style="font-size:28px;font-weight:800;color:${amountColor}">${fmtC(r.amount)}</span>
      ${capBadge}${appBadge}
      <span style="font-size:13px;color:#64748b">at ${fmtP(r.rate)} effective rate</span>
    </div>
    <div style="font-size:12px;color:#94a3b8;margin-bottom:4px"><strong style="color:#64748b">Rule applied:</strong> ${r.ruleApplied}</div>
    <div style="font-size:12px;color:#94a3b8"><strong style="color:#64748b">Explanation:</strong> ${r.note}</div>
    ${r.approvalReason ? `<div style="margin-top:6px;font-size:11px;color:#f59e0b">⚠ ${r.approvalReason}</div>` : ''}
    ${gateEl}${bonusEl}`;
};

// ── COMM-04: Commission Audit Trail Viewer ─────────────────────────────────────
function renderCommissionAuditTrail() {
  const audit = (typeof window.loadCommissionAudit === 'function') ? window.loadCommissionAudit() : [];
  if (!audit.length) {
    return `
    <div style="background:#0f172a;border:1px solid #1e293b;border-radius:14px;padding:16px 18px">
      <div style="font-size:14px;font-weight:800;color:#e2e8f0;margin-bottom:6px">📋 Commission Rule Audit Trail</div>
      <p style="color:#475569;font-size:13px;margin:0">No rule changes recorded yet. Changes appear here when Tyler edits and saves commission rates.</p>
    </div>`;
  }

  const fmt = ts => { try { return new Date(ts).toLocaleString(undefined, { month:'short', day:'numeric', year:'numeric', hour:'2-digit', minute:'2-digit' }); } catch(e) { return ts; } };
  const rows = audit.slice(0, 10).map((entry, i) => {
    const isCreate = entry.action === 'rules_created';
    const color    = isCreate ? '#4ade80' : '#00d4ff';
    const label    = isCreate ? 'Rules Created' : `Rules Updated → v${entry.after?.version || '?'}`;
    const actor    = entry.actor || 'admin';
    return `
    <div style="padding:10px 0;border-bottom:1px solid #1e293b;display:flex;align-items:flex-start;gap:12px">
      <div style="width:8px;height:8px;border-radius:50%;background:${color};margin-top:5px;flex-shrink:0"></div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-size:12px;font-weight:700;color:${color}">${label}</span>
          <span style="font-size:11px;color:#475569">by ${actor}</span>
          <span style="font-size:10px;color:#334155">${fmt(entry.ts)}</span>
        </div>
        ${entry.before ? `<div style="font-size:10px;color:#334155;margin-top:2px">Previous version: v${entry.before.version || 0}</div>` : ''}
      </div>
      ${i === 0 ? `<button onclick="window._showAuditDiff(${i})" style="font-size:10px;color:#64748b;background:#1e293b;border:none;border-radius:6px;padding:3px 8px;cursor:pointer">View diff</button>` : ''}
    </div>`;
  }).join('');

  return `
  <div style="background:#0f172a;border:1px solid #1e293b;border-radius:14px;overflow:hidden">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #1e293b">
      <div>
        <div style="font-size:14px;font-weight:800;color:#e2e8f0">📋 Commission Rule Audit Trail</div>
        <div style="font-size:11px;color:#64748b;margin-top:2px">${audit.length} change${audit.length !== 1 ? 's' : ''} recorded</div>
      </div>
    </div>
    <div style="padding:4px 18px 14px">${rows}</div>
    ${audit.length > 10 ? `<div style="padding:0 18px 12px;font-size:11px;color:#475569">Showing 10 of ${audit.length} entries — last 50 retained</div>` : ''}
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
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:9999;display:flex;align-items:center;justify-content:center';
  modal.innerHTML = `
    <div style="background:#1e293b;border-radius:16px;padding:24px;width:min(700px,95vw);max-height:85vh;overflow-y:auto;position:relative">
      <button onclick="this.closest('div[style]').remove()"
        style="position:absolute;top:12px;right:14px;background:transparent;border:none;color:#64748b;font-size:22px;cursor:pointer;line-height:1">×</button>
      <h3 style="margin:0 0 16px;font-size:16px;color:#e2e8f0">Rule Change — ${new Date(entry.ts).toLocaleString()}</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div>
          <div style="font-size:11px;font-weight:700;color:#f87171;margin-bottom:6px;text-transform:uppercase">Before</div>
          <pre style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:12px;font-size:10px;color:#94a3b8;overflow-x:auto;white-space:pre-wrap;margin:0">${before}</pre>
        </div>
        <div>
          <div style="font-size:11px;font-weight:700;color:#4ade80;margin-bottom:6px;text-transform:uppercase">After</div>
          <pre style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:12px;font-size:10px;color:#94a3b8;overflow-x:auto;white-space:pre-wrap;margin:0">${after}</pre>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
};

function _renderPermMatrixOld_deleted() {
  const perms = loadNavPerms();
  const roles = [
    { key: 'office_manager', label: 'Jen — Office Manager', color: '#f59e0b' },
    { key: 'rep',            label: 'Ryan — Sales Rep',     color: '#4ade80' }
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
      <tr style="border-bottom:1px solid #0f172a">
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
  <section class="card" style="margin-top:20px;border:1px solid #334155">
    <h2>Permission Controls <span style="font-size:13px;color:#64748b;font-weight:400;margin-left:8px">— Tyler (Owner) only</span></h2>
    <p style="color:#64748b;font-size:13px;margin-bottom:16px">Control which sections each role can access. Changes take effect immediately. Tyler (Owner) always has full access.</p>
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
      <span style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-right:4px">Quick Presets:</span>
      <button class="secondary-btn" style="font-size:11px" onclick="window._applyPermPreset('office_manager','full')">Jen · Full Access</button>
      <button class="secondary-btn" style="font-size:11px" onclick="window._applyPermPreset('office_manager','standard')">Jen · Standard</button>
      <button class="secondary-btn" style="font-size:11px" onclick="window._applyPermPreset('office_manager','view')">Jen · View Only</button>
      <span style="color:#334155">|</span>
      <button class="secondary-btn" style="font-size:11px" onclick="window._applyPermPreset('rep','full')">Ryan · Full Access</button>
      <button class="secondary-btn" style="font-size:11px" onclick="window._applyPermPreset('rep','standard')">Ryan · Standard</button>
      <button class="secondary-btn" style="font-size:11px" onclick="window._applyPermPreset('rep','view')">Ryan · View Only</button>
      <button class="secondary-btn" style="font-size:12px;margin-left:8px" onclick="window._resetNavPerms()">↺ Reset All Defaults</button>
    </div>
    <div style="font-size:11px;color:#475569;margin-top:6px">Presets save instantly. Full = all tabs · Standard = hide admin/finance · View Only = today + pipeline only.</div>
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
      <div style="font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#16a34a;margin-bottom:8px">Mark as Sold</div>
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
          <input type="checkbox" id="sm_deposit" style="width:16px;height:16px;accent-color:#16a34a">
          <span style="font-size:13px;font-weight:600">Deposit Collected</span>
        </label>
        <label style="display:grid;gap:6px">
          <span style="font-size:12px;font-weight:700;color:var(--blue-dark)">Expected Start Date</span>
          <input id="sm_startdate" type="date" style="border:1px solid var(--line);border-radius:10px;padding:10px 12px">
        </label>
      </div>
      <div style="display:flex;gap:10px;margin-top:24px">
        <button class="primary-btn" style="background:linear-gradient(135deg,#16a34a,#15803d);flex:1;font-size:15px" onclick="confirmMarkSold('${oppId}')">Confirm — Mark Sold</button>
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

function exportJson(){ const blob = new Blob([JSON.stringify(state,null,2)],{type:'application/json'}); downloadBlob(blob,`avalon-sales-hub-backup-${todayISO()}.json`); }
function exportCsv(){ const headers=['client','phone','email','address','serviceLine','source','project','urgency','decisionMaker','budget','status','nextFollowUp','createdAt','updatedAt']; const rows=state.opportunities.map(o=>headers.map(h=>`"${String(o[h]||'').replace(/"/g,'""')}"`).join(',')); downloadBlob(new Blob([[headers.join(','),...rows].join('\n')],{type:'text/csv'}),`avalon-pipeline-${todayISO()}.csv`); }
function downloadBlob(blob,filename){ const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename; a.click(); URL.revokeObjectURL(a.href); }
function importJson(){ const file=document.getElementById('importFile').files[0]; if(!file) return showToast('Choose a JSON file first'); const reader=new FileReader(); reader.onload=()=>{ try{ state={...DEFAULT_STATE,...JSON.parse(reader.result)}; saveState(); showToast('Imported'); show('today'); }catch(e){ showToast('Import failed'); } }; reader.readAsText(file); }
function resetAll(){ localStorage.clear(); state=structuredClone(DEFAULT_STATE); saveState(); showToast('Reset complete'); show('today'); }
window.confirmReset = function(){
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal" style="max-width:420px;border:2px solid #7f1d1d">
      
      <h3 style="color:#f87171;text-align:center;margin:0 0 8px">Permanent Data Reset</h3>
      <p style="font-size:13px;color:#94a3b8;text-align:center;margin:0 0 20px">This will delete <strong style="color:#f87171">all pipeline leads, notes, financials, and settings</strong> permanently. There is no undo.</p>
      <p style="font-size:12px;color:#64748b;margin:0 0 8px">Type <strong style="color:#e2e8f0">RESET</strong> to confirm:</p>
      <input id="resetConfirmInput" type="text" placeholder="Type RESET here"
        style="width:100%;padding:10px 12px;background:#1e293b;border:1px solid #7f1d1d;border-radius:8px;color:#f87171;font-size:14px;font-weight:700;letter-spacing:.1em;box-sizing:border-box;margin-bottom:14px">
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
    <div style="background:#0f172a;border:1px solid #1e4d6b;border-radius:16px;padding:28px;width:100%;max-width:400px;box-shadow:0 25px 60px rgba(0,0,0,0.6)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
        <div>
          <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">Export Data</div>
          <h2 style="margin:0;color:#f1f5f9;font-size:1.1rem">${escapeHtml(title)}</h2>
        </div>
        <button onclick="document.getElementById('exportModalOverlay').remove()"
          style="background:#1e293b;border:1px solid #334155;border-radius:8px;color:#94a3b8;cursor:pointer;padding:6px 10px;font-size:16px;line-height:1">×</button>
      </div>
      <p style="color:#64748b;font-size:13px;margin:0 0 20px">Choose your preferred format:</p>
      <div style="display:grid;gap:10px">
        <button onclick="exportAsCSV('${escapeHtml(title)}', window._exportDataFn)"
          style="display:flex;align-items:center;gap:14px;padding:14px 18px;background:#0a1628;border:1px solid #1e293b;border-radius:12px;cursor:pointer;color:#e2e8f0;font-size:14px;font-weight:600;text-align:left;transition:border-color .15s"
          onmouseover="this.style.borderColor='#22d3ee'" onmouseout="this.style.borderColor='#1e293b'">
          
          <div>
            <div>CSV</div>
            <div style="font-size:11px;font-weight:400;color:#64748b">Comma-separated, opens in Excel / Sheets</div>
          </div>
        </button>
        <button onclick="exportAsXLSX('${escapeHtml(title)}', window._exportDataFn)"
          style="display:flex;align-items:center;gap:14px;padding:14px 18px;background:#0a1628;border:1px solid #1e293b;border-radius:12px;cursor:pointer;color:#e2e8f0;font-size:14px;font-weight:600;text-align:left;transition:border-color .15s"
          onmouseover="this.style.borderColor='#4ade80'" onmouseout="this.style.borderColor='#1e293b'">
          
          <div>
            <div>Excel (.xlsx)</div>
            <div style="font-size:11px;font-weight:400;color:#64748b">Native Excel workbook with formatting</div>
          </div>
        </button>
        <button onclick="exportAsPDF('${escapeHtml(title)}', window._exportDataFn)"
          style="display:flex;align-items:center;gap:14px;padding:14px 18px;background:#0a1628;border:1px solid #1e293b;border-radius:12px;cursor:pointer;color:#e2e8f0;font-size:14px;font-weight:600;text-align:left;transition:border-color .15s"
          onmouseover="this.style.borderColor='#f87171'" onmouseout="this.style.borderColor='#1e293b'">
          
          <div>
            <div>PDF</div>
            <div style="font-size:11px;font-weight:400;color:#64748b">Print-ready formatted report</div>
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
    <tr style="background:${ri % 2 === 0 ? '#f8fafc' : '#ffffff'}">
      ${r.map(cell => `<td style="padding:7px 10px;border:1px solid #e2e8f0;font-size:12px;color:#1e293b">${xe(cell)}</td>`).join('')}
    </tr>`).join('');

  const printDiv = document.createElement('div');
  printDiv.id = 'avalonPrintArea';
  printDiv.innerHTML = `
    <div style="font-family:'Segoe UI',Arial,sans-serif;padding:24px;max-width:900px;margin:0 auto">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px;padding-bottom:14px;border-bottom:2px solid #0e3044">
        <div>
          <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.08em;margin-bottom:2px">Avalon Landscaping</div>
          <h1 style="margin:0;font-size:20px;color:#0e3044;font-weight:800">${xe(title)}</h1>
          <div style="font-size:11px;color:#64748b;margin-top:4px">Generated ${new Date().toLocaleDateString('en-US',{weekday:'short',year:'numeric',month:'long',day:'numeric'})}</div>
        </div>
        <div style="font-size:10px;color:#94a3b8;text-align:right">FY 2026</div>
      </div>
      <table style="width:100%;border-collapse:collapse;font-family:inherit">
        <thead>
          <tr style="background:#0e3044">
            ${headers.map(h => `<th style="padding:9px 10px;text-align:left;color:#fff;font-size:12px;font-weight:700;border:1px solid #1e4d6b">${xe(h)}</th>`).join('')}
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
      <div style="margin-top:20px;font-size:10px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:10px">
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
    { key:'landscape',   label:'Landscape',   icon:'<svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 15V9.5M9 9.5C9 9.5 5 9.5 3 5c3 0 6 2 6 4.5zm0 0c0 0 4 0 6-4.5-3 0-6 2-6 4.5z" stroke="#4ade80" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>', color:'#4ade80' },
    { key:'maintenance', label:'Maintenance',  icon:'<svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12.5 3a3 3 0 00-2.5 4.5L3.8 13.8a.8.8 0 001.2 1.2l6.5-5.7A3 3 0 0014 10a3 3 0 00-.5-1.5l-1.8 1.8-1.2-1.2 1.8-1.8A3 3 0 0012.5 3z" stroke="#22d3ee" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>', color:'#22d3ee' },
    { key:'snow',        label:'Snow & Ice',   icon:'<svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 2.5v13M2.5 9h13M4.5 4.5l9 9M13.5 4.5l-9 9" stroke="#93c5fd" stroke-width="1.5" stroke-linecap="round"/><circle cx="9" cy="2.5" r="1" fill="#93c5fd"/><circle cx="9" cy="15.5" r="1" fill="#93c5fd"/><circle cx="2.5" cy="9" r="1" fill="#93c5fd"/><circle cx="15.5" cy="9" r="1" fill="#93c5fd"/></svg>', color:'#a78bfa' }
  ];
  function fmtM(n){ return n!=null ? n.toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}) : '—'; }
  const rows = DIVISIONS.map(d => {
    const entry = (divActuals[d.key]||{})[monthKey] || {};
    const rev = entry.revenue ?? null;
    const cogs = entry.cogs ?? null;
    const gm = (rev != null && cogs != null) ? rev - cogs : null;
    const gmPct = (gm != null && rev > 0) ? Math.round((gm/rev)*100) : null;
    return `<tr style="border-bottom:1px solid #1e293b">
      <td style="padding:10px 12px;font-weight:600">${d.icon} ${d.label}</td>
      <td style="padding:10px 12px;text-align:right;color:${d.color};font-weight:700">${fmtM(rev)}</td>
      <td style="padding:10px 12px;text-align:right;color:#64748b">${fmtM(cogs)}</td>
      <td style="padding:10px 12px;text-align:right;color:${gmPct!=null&&gmPct>=30?'#4ade80':'#f87171'}">${gmPct!=null?gmPct+'%':'—'}</td>
    </tr>`;
  }).join('');
  const total = DIVISIONS.reduce((a,d) => a + ((divActuals[d.key]||{})[monthKey]?.revenue ?? 0), 0);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box" style="max-width:580px">
      <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button>
      <div style="font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#22d3ee;margin-bottom:6px">Month Drilldown</div>
      <h2 style="margin:0 0 4px">${monthKey} 2026</h2>
      <div style="display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap">
        <div><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.05em">Budgeted</div><div style="font-size:1.3rem;font-weight:800;color:#e2e8f0">${fmtM(monthBudget.budgeted)}</div></div>
        <div><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.05em">Actual</div><div style="font-size:1.3rem;font-weight:800;color:#22d3ee">${fmtM(monthBudget.actual)}</div></div>
        <div><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.05em">Variance</div><div style="font-size:1.3rem;font-weight:800;color:${(monthBudget.variance||0)>=0?'#4ade80':'#f87171'}">${monthBudget.variance!=null?((monthBudget.variance>=0?'+':'')+fmtM(monthBudget.variance)):'—'}</div></div>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px">
        <thead><tr style="background:#0f172a">
          <th style="padding:8px 12px;text-align:left;color:#64748b;border-bottom:1px solid #1e293b">Division</th>
          <th style="padding:8px 12px;text-align:right;color:#64748b;border-bottom:1px solid #1e293b">Revenue</th>
          <th style="padding:8px 12px;text-align:right;color:#64748b;border-bottom:1px solid #1e293b">COGS</th>
          <th style="padding:8px 12px;text-align:right;color:#64748b;border-bottom:1px solid #1e293b">GM%</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr style="background:#0f172a;font-weight:700;border-top:2px solid #1e293b">
          <td style="padding:10px 12px;color:#e2e8f0">Total</td>
          <td style="padding:10px 12px;text-align:right;color:#22d3ee">${fmtM(total)}</td>
          <td colspan="2"></td>
        </tr></tfoot>
      </table>
      ${notes ? `<div style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:12px;font-size:13px;color:#94a3b8"><strong style="color:#e2e8f0">Notes:</strong> ${escapeHtml(notes)}</div>` : ''}
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
  const ytdVarColor= ytdVar >= 0 ? '#4ade80' : '#f87171';
  const dynamicMonthsLeft = months.filter(m => m.actual == null).length;

  // ── Tab Nav ──
  const tabNav = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px">
      ${[['monthly','Monthly Totals'],['division','Division Entry'],['annuals','Annual Financials'],['pnl','P&L Files']].map(([t,label]) =>
        `<button onclick="revenueAdmin('${t}')" style="padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid ${_revTab===t?'#22d3ee':'#1e293b'};background:${_revTab===t?'#0e3044':'#0f172a'};color:${_revTab===t?'#22d3ee':'#94a3b8'}">${label}</button>`
      ).join('')}
    </div>`;

  // ── Summary Banner (always shown) ──
  const banner = `
    <div style="background:linear-gradient(135deg,#0a1628,#0f172a);border:1px solid #1e4d6b;border-radius:14px;padding:18px;margin-bottom:20px">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px">
        <div style="text-align:center">
          <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.07em">YTD Budget</div>
          <div id="rev_ytd_budget" style="font-size:1.4rem;font-weight:900;color:#e2e8f0">${fmtM(ytdBudget)}</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.07em">YTD Actual</div>
          <div id="rev_ytd_actual" style="font-size:1.4rem;font-weight:900;color:#22d3ee">${fmtM(ytdActual)}</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.07em">YTD Variance</div>
          <div id="rev_ytd_var" style="font-size:1.4rem;font-weight:900;color:${ytdVarColor}">${ytdVar >= 0 ? '+' : ''}${fmtM(ytdVar)}</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.07em">Remaining</div>
          <div style="font-size:1.4rem;font-weight:900;color:#f87171">${fmtM(fy.annual.remaining)}</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.07em">Needed / Mo</div>
          <div style="font-size:1.4rem;font-weight:900;color:#f59e0b">${fmtM(fy.annual.avgNeededPerMonth)}</div>
          <div style="font-size:9px;color:#64748b">${dynamicMonthsLeft} months left</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.07em">Annual Budget</div>
          <div style="font-size:1.4rem;font-weight:900;color:#a78bfa">${fmtM(fy.annual.budgetedRevenue)}</div>
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
      const varColor  = m.variance == null ? '#334155' : m.variance >= 0 ? '#4ade80' : '#f87171';
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
        <td class="right" style="color:#64748b">${fmtM(m.budgeted)}</td>
        <td class="right">
          <div style="font-weight:700;color:${hasActual ? '#22d3ee' : '#475569'};font-size:14px;padding:6px 4px">
            ${hasActual ? fmtM(m.actual) : '<span style="color:#334155">—</span>'}
          </div>
          ${hasDivData ? `<div style="font-size:10px;color:#475569;line-height:1.4">
            ${fmtM(divBreakdown[0])} · ${fmtM(divBreakdown[1])} · ${fmtM(divBreakdown[2])}
          </div>` : ''}
        </td>
        <td class="right" style="color:${varColor};font-weight:700">${m.variance != null ? varSign + fmtM(m.variance) : '—'}</td>
        <td>
          <input style="background:transparent;border:none;border-bottom:1px solid #1e293b;width:100%;color:#94a3b8;font-size:12px;padding:4px 0"
            placeholder="notes…"
            id="rev_note_text_${m.idx}"
            value="${escapeHtml(savedNotes['note_'+m.month]||'')}">
        </td>
      </tr>`;
    }).join('');

    return `
      <div class="card" style="background:#0a0f1a;border:1px solid #1e293b;padding:0;overflow:hidden">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #1e293b">
          <h2 style="margin:0;color:#f1f5f9;font-size:1rem">Budget vs Actual — Jan–Dec 2026</h2>
          <div style="display:flex;gap:8px">
            <button class="secondary-btn small" onclick="revSaveNotes()" style="background:#16a34a;border-color:#16a34a;color:#fff">Save Notes</button>
            <button class="secondary-btn small" onclick="showExportModal('Monthly Revenue', buildMonthlyExportData)">Export</button>
          </div>
        </div>
        <div style="overflow-x:auto">
          <table class="rev-editor-table" id="revTable">
            <thead><tr>
              <th>Month</th><th class="right">Budgeted</th><th class="right">Actual Revenue <span style="font-size:10px;color:#475569;font-weight:400">(from divisions)</span></th><th class="right">Variance</th><th>Notes</th>
            </tr></thead>
            <tbody>${tableRows}</tbody>
            <tfoot>
              <tr style="background:#0f172a;font-weight:700;border-top:2px solid #1e293b">
                <td style="padding:12px;color:#e2e8f0">YTD Total</td>
                <td class="right" style="padding:12px;color:#64748b">${fmtM(ytdBudget)}</td>
                <td class="right" style="padding:12px;color:#22d3ee">${fmtM(ytdActual)}</td>
                <td class="right" style="padding:12px;color:${ytdVarColor}">${ytdVar >= 0 ? '+' : ''}${fmtM(ytdVar)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
      <p style="color:#64748b;font-size:12px;margin-top:8px">
        Monthly totals are <strong style="color:#22d3ee">automatically computed</strong> from division entries — they cannot be edited directly.
        To change revenue, go to the <strong style="color:#22d3ee">Division Entry</strong> tab.
      </p>`;
  }



  // ── Tab: Division Entry ──
  const DIVISIONS_META = [
    { key: 'landscape',   label: 'Landscape',    icon: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 15V9.5M9 9.5C9 9.5 5 9.5 3 5c3 0 6 2 6 4.5zm0 0c0 0 4 0 6-4.5-3 0-6 2-6 4.5z" stroke="#4ade80" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>', color: '#4ade80' },
    { key: 'maintenance', label: 'Maintenance',   icon: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12.5 3a3 3 0 00-2.5 4.5L3.8 13.8a.8.8 0 001.2 1.2l6.5-5.7A3 3 0 0014 10a3 3 0 00-.5-1.5l-1.8 1.8-1.2-1.2 1.8-1.8A3 3 0 0012.5 3z" stroke="#22d3ee" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>', color: '#22d3ee' },
    { key: 'snow',        label: 'Snow & Ice',    icon: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 2.5v13M2.5 9h13M4.5 4.5l9 9M13.5 4.5l-9 9" stroke="#93c5fd" stroke-width="1.5" stroke-linecap="round"/><circle cx="9" cy="2.5" r="1" fill="#93c5fd"/><circle cx="9" cy="15.5" r="1" fill="#93c5fd"/><circle cx="2.5" cy="9" r="1" fill="#93c5fd"/><circle cx="15.5" cy="9" r="1" fill="#93c5fd"/></svg>', color: '#a78bfa' }
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
          <td class="right" id="div_${div.key}_gm_${mon}" style="color:${gmPctCalc !== '' ? (gmPctCalc >= 30 ? '#4ade80' : '#f87171') : '#334155'};font-weight:700">
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
        <div class="card" style="background:#0a0f1a;border:1px solid #1e293b;padding:0;overflow:hidden;margin-bottom:16px">
          <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #1e293b;background:linear-gradient(90deg,#0a1628,#0f172a)">
            <div style="display:flex;align-items:center;gap:10px">
              <span style="font-size:20px">${div.icon}</span>
              <div>
                <div style="font-weight:700;color:#e2e8f0;font-size:15px">${div.label}</div>
                <div style="font-size:11px;color:#64748b">Target: ${fmtM(divObj.target)} · Actual YTD: <span style="color:${div.color}">${fmtM(totalRev || divObj.actual)}</span></div>
              </div>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <span style="font-size:11px;font-weight:700;color:${div.color}">${totalGm}% GM</span>
              <button class="secondary-btn small" onclick="divSaveDivision('${div.key}')" style="background:#1e4d6b;border-color:#1e4d6b;color:#22d3ee;font-size:11px">Save ${div.label}</button>
            </div>
          </div>
          <div style="overflow-x:auto">
            <table class="rev-editor-table" id="divTable_${div.key}">
              <thead><tr>
                <th>Month</th><th class="right">Revenue</th><th class="right">COGS</th><th class="right">GM %</th>
              </tr></thead>
              <tbody>${rows}</tbody>
              <tfoot>
                <tr style="background:#0f172a;font-weight:700;border-top:2px solid #1e293b">
                  <td style="padding:10px;color:#e2e8f0">Totals</td>
                  <td class="right" style="padding:10px;color:#22d3ee" id="div_${div.key}_total_rev">${fmtM(totalRev||null)}</td>
                  <td class="right" style="padding:10px;color:#64748b" id="div_${div.key}_total_cogs">${fmtM(totalCogs||null)}</td>
                  <td class="right" style="padding:10px;color:${totalGm >= 30 ? '#4ade80' : '#f87171'};font-weight:700" id="div_${div.key}_total_gm">${totalRev > 0 ? totalGm + '%' : '—'}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>`;
    }).join('');

    return `
      <p class="lede" style="margin-bottom:16px">Enter revenue and COGS for each division per month. Monthly totals auto-sum to the company total in the Monthly Totals tab.</p>
      <div style="display:flex;gap:8px;margin-bottom:16px">
        <button class="secondary-btn" onclick="divSaveAllDivisions()" style="background:#16a34a;border-color:#16a34a;color:#fff">Save All Divisions</button>
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
        <div style="background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:14px;margin-bottom:12px">
          <div style="font-weight:700;font-size:14px;color:#e2e8f0;margin-bottom:12px">${div.icon} ${div.label} Division</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px">
            <div>
              <label style="font-size:11px;color:#64748b;display:block;margin-bottom:4px">Revenue Target</label>
              <input class="rev-editor-input" type="number" id="ann_${div.key}_target" value="${d.target||''}" placeholder="target" step="1000" style="width:100%">
            </div>
            <div>
              <label style="font-size:11px;color:#64748b;display:block;margin-bottom:4px">Actual YTD Revenue <span style="font-size:9px;color:#475569">(auto)</span></label>
              <div style="padding:8px 10px;background:#0a0f1a;border:1px solid #0f172a;border-radius:8px;color:#22d3ee;font-weight:700;font-size:14px">${d.actual != null ? d.actual.toLocaleString(undefined,{style:'currency',currency:'USD',maximumFractionDigits:0}) : '—'}</div>
            </div>
            <div>
              <label style="font-size:11px;color:#64748b;display:block;margin-bottom:4px">GM Floor %</label>
              <input class="rev-editor-input" type="number" id="ann_${div.key}_gmfloor" value="${d.grossMarginFloor != null ? Math.round(d.grossMarginFloor*100) : ''}" placeholder="floor %" step="1" min="0" max="100" style="width:100%">
            </div>
            <div>
              <label style="font-size:11px;color:#64748b;display:block;margin-bottom:4px">Actual GM %</label>
              <input class="rev-editor-input" type="number" id="ann_${div.key}_gmpct" value="${d.grossMarginPct != null ? Math.round(d.grossMarginPct*100) : ''}" placeholder="actual GM %" step="1" min="0" max="100" style="width:100%">
            </div>
            <div>
              <label style="font-size:11px;color:#64748b;display:block;margin-bottom:4px">COGS YTD</label>
              <input class="rev-editor-input" type="number" id="ann_${div.key}_cogs" value="${d.cogs||''}" placeholder="COGS" step="1000" style="width:100%">
            </div>
          </div>
        </div>`;
    }).join('');

    return `
      <p class="lede" style="margin-bottom:16px">Edit company-wide and division-level annual financial figures. Changes persist to localStorage and reflect in all dashboards.</p>

      <div style="margin-bottom:20px">
        <h3 style="color:#f1f5f9;font-size:14px;margin-bottom:12px">Company Annual Figures</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
          ${fields.map(f => `
          <div style="background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:12px">
            <label style="font-size:11px;color:#64748b;display:block;margin-bottom:4px">${f.label}</label>
            <div style="display:flex;align-items:center;gap:6px">
              ${f.unit === '$' ? '<span style="color:#64748b;font-size:13px">$</span>' : ''}
              <input class="rev-editor-input" type="number" id="ann_${f.key}"
                value="${f.val}" placeholder="${f.placeholder}" step="${f.step}"
                style="flex:1">
              ${f.unit === '%' ? '<span style="color:#64748b;font-size:13px">%</span>' : ''}
            </div>
            <div style="font-size:10px;color:#475569;margin-top:4px">${f.note}</div>
          </div>`).join('')}
        </div>
      </div>

      <div style="margin-bottom:20px">
        <h3 style="color:#f1f5f9;font-size:14px;margin-bottom:12px">Division Annual Figures</h3>
        ${divFinancials}
      </div>

      <div style="display:flex;gap:8px">
        <button class="secondary-btn" onclick="annSaveAll()" style="background:#16a34a;border-color:#16a34a;color:#fff">Save All Annual Figures</button>
        <button class="secondary-btn" onclick="showExportModal('Annual Financials 2026', buildAnnualExportData)">Export</button>
        <button class="secondary-btn" onclick="annResetOverrides()" style="background:#7f1d1d;border-color:#991b1b;color:#fca5a5">Reset to Budget Defaults</button>
      </div>`;
  }

  // ── Tab: P&L Files ──
  function renderPnlTab() {
    const fileList = pnlFiles.length === 0
      ? '<p style="color:#64748b;font-size:13px">No files uploaded yet. Upload a monthly P&L CSV or PDF below.</p>'
      : pnlFiles.map(f => `
        <div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:#0f172a;border:1px solid #1e293b;border-radius:10px;margin-bottom:8px">
          <span style="font-size:20px">${f.type === 'csv' ? 'CSV' : 'DOC'}</span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:13px;color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(f.name)}</div>
            <div style="font-size:11px;color:#64748b">${f.date} · ${f.size} · ${f.type.toUpperCase()}</div>
            ${f.period ? `<div style="font-size:11px;color:#22d3ee">Period: ${escapeHtml(f.period)}</div>` : ''}
          </div>
          <div style="display:flex;gap:6px">
            ${f.type === 'csv' ? `<button class="secondary-btn small" onclick="pnlImportCsv('${f.id}')" style="font-size:11px">Import to Divisions</button>` : ''}
            <button class="secondary-btn small" onclick="pnlDeleteFile('${f.id}')" style="background:#7f1d1d;border-color:#991b1b;color:#fca5a5;font-size:11px">×</button>
          </div>
        </div>`).join('');

    return `
      <p class="lede" style="margin-bottom:16px">Upload monthly P&L statements or financial reports. CSV files can be auto-imported into division actuals.</p>

      <div class="card" style="background:#0a0f1a;border:2px dashed #1e4d6b;border-radius:14px;padding:24px;text-align:center;margin-bottom:20px">
        
        <div style="color:#e2e8f0;font-weight:600;margin-bottom:4px">Upload P&L File</div>
        <div style="color:#64748b;font-size:12px;margin-bottom:16px">CSV (auto-parsed) or PDF (stored as attachment) · Max 5MB</div>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-bottom:14px">
          <div>
            <label style="font-size:11px;color:#64748b;display:block;margin-bottom:4px">Period Label</label>
            <input id="pnl_period" placeholder="e.g. June 2026" style="padding:8px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px;width:160px">
          </div>
        </div>
        <label style="cursor:pointer;display:inline-block">
          <input type="file" id="pnlFileInput" accept=".csv,.pdf" style="display:none" onchange="pnlHandleUpload(this)">
          <span style="display:inline-block;padding:10px 24px;background:#1e4d6b;border:1px solid #22d3ee;border-radius:8px;color:#22d3ee;font-weight:600;font-size:13px">Choose File</span>
        </label>
      </div>

      <div style="margin-bottom:20px">
        <h3 style="color:#f1f5f9;font-size:14px;margin-bottom:12px">Uploaded Files (${pnlFiles.length})</h3>
        ${fileList}
      </div>

      <div style="background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:16px">
        <h3 style="color:#f1f5f9;font-size:13px;margin-top:0;margin-bottom:8px">CSV Import Format</h3>
        <p style="color:#64748b;font-size:12px;margin:0 0 8px">For auto-import to work, your CSV should include these columns:</p>
        <code style="display:block;background:#0a0f1a;padding:10px 12px;border-radius:6px;color:#22d3ee;font-size:11px;line-height:1.6">
          Month, Division, Revenue, COGS<br>
          Jan, Landscape, 25000, 14500<br>
          Jan, Maintenance, 40000, 28400<br>
          Jan, Snow, 18000, 7200
        </code>
        <p style="color:#64748b;font-size:11px;margin-top:8px">Division values: Landscape / Maintenance / Snow (or Snow &amp; Ice)</p>
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
  const varColor = variance == null ? '#334155' : variance >= 0 ? '#4ade80' : '#f87171';
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
  const ytdVarColor = ytdVar >= 0 ? '#4ade80' : '#f87171';
  const setEl = (id, txt, color) => { const el = document.getElementById(id); if (el) { el.textContent = txt; if (color) el.style.color = color; } };
  setEl('rev_ytd_budget', fmtM(ytdBudget));
  setEl('rev_ytd_actual', fmtM(ytdActual), '#22d3ee');
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
    gmEl.style.color = gm >= 30 ? '#4ade80' : '#f87171';
  } else {
    gmEl.textContent = '—';
    gmEl.style.color = '#334155';
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
  setEl(`div_${divKey}_total_gm`,   totalRev > 0 ? totalGm + '%' : '—', totalGm >= 30 ? '#4ade80' : '#f87171');
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

show('today');
