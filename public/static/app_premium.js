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
const DEFAULT_STATE = { opportunities: [], tasks: [], notes: [], settings: { repName: '', email: '' } };
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
  admin: ['today','myDashboard','pipeline','lead','process','forms','scripts','templates','objections','calculator','academy','manager','integrations','settings','revenueAdmin'],
  office_manager: ['today','myDashboard','pipeline','lead','process','forms','scripts','templates','objections','calculator','academy','manager','integrations','settings','revenueAdmin'],
  rep: ['today','myDashboard','pipeline','lead','process','forms','scripts','templates','objections','calculator','academy']
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
  const val = Number(opp?.jobValue || 0);
  if (!val) return 0;
  const rates = { landscape:.08, maintenance_onetime:.06, maintenance_recurring:.10, hardscape:.07, drainage:.07, design_build:.07 };
  return val * (rates[opp?.workType] || .07);
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
    const _viewLabels = {today:'Today',myDashboard:'My Dashboard',pipeline:'Pipeline',lead:'Add Lead',process:'Sales Process',forms:'Forms & Checklists',scripts:'Scripts',templates:'Email Templates',objections:'Objection Handling',calculator:'Pricing Tools',academy:'Sales Academy',manager:'Manager Tools',integrations:'Integrations',settings:'Settings'};
    view.innerHTML = `<div style="text-align:center;padding:64px 24px;margin-top:40px">
      <div style="font-size:32px;margin-bottom:18px;color:#64748b;font-weight:300;letter-spacing:-2px">&#x2715;</div>
      <h2 style="color:#f87171;margin-bottom:10px">${_viewLabels[viewName] || viewName} — Access Restricted</h2>
      <p style="color:#64748b;max-width:420px;margin:0 auto 24px">Tyler (Owner) has restricted access to this section for your role.<br>Ask Tyler to enable it in <strong style="color:#e2e8f0">Settings → Permission Controls</strong>.</p>
      <button class="secondary-btn" onclick="show('today')">← Back to Today</button>
    </div>`;
    activateNav(viewName);
    sidebar.classList.remove('open');
    window.scrollTo({top:0, behavior:'smooth'});
    return;
  }
  // ────────────────────────────────────────────────────────
  activateNav(viewName);
  sidebar.classList.remove('open');
  // integrations is loaded from integrations.js
  const intRoute = (typeof integrations === 'function') ? {integrations} : {};
  // repDashboard is loaded from reps.js
  const repRoute = (typeof repDashboard === 'function') ? {myDashboard: repDashboard} : {};
  const revenueRoute = (typeof revenueAdmin === 'function') ? {revenueAdmin} : {};
  const routes = {today, pipeline, lead, process, forms, scripts, templates, objections, calculator, academy, manager, settings, ...intRoute, ...repRoute, ...revenueRoute};
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
        footer.innerHTML = `<span style="color:${rep.color};font-weight:700">${rep.avatar} ${rep.name}${roleBadge}</span><br><span style="font-size:11px;color:#64748b">${rep.title}</span><br><button onclick="logoutRep();renderLoginScreen()" style="margin-top:6px;background:none;border:1px solid #334155;border-radius:6px;color:#64748b;font-size:11px;padding:4px 10px;cursor:pointer;width:100%">Switch Account</button>`;
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

  if(staleOpps.length) suggestions.push({icon:'⏱',title:`${staleOpps.length} stale lead${staleOpps.length>1?'s':''} with no recent activity`,cta:'Review',onclick:`show('pipeline')`});
  if(proposalsPending.length) suggestions.push({icon:'',title:`${proposalsPending.length} proposal${proposalsPending.length>1?'s':''} awaiting a decision — follow up`,cta:'Open Proposals',onclick:`window._pipelineStatusFilter='proposals';show('pipeline')`});
  if(noNextStep.length) suggestions.push({icon:'',title:`${noNextStep.length} lead${noNextStep.length>1?'s':''} missing a next follow-up date`,cta:'Set Follow-Up',onclick:`show('pipeline')`});
  if(unassigned.length) suggestions.push({icon:'',title:`${unassigned.length} unassigned lead${unassigned.length>1?'s':''} with no rep`,cta:'Assign Now',onclick:`show('pipeline')`});

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
    <div class="hero">
      <div class="hero-grid">
        <div>
          <div class="hero-title-line"><div class="eyebrow">Avalon Sales OS · Office</div><span class="pill">Sales Operations</span></div>
          <h1>Keep the pipeline moving.</h1>
          <p class="lede">Route leads, chase proposals, confirm deposits, and hand sold jobs to production — all from here.</p>
          <div class="quick-actions">
            <button class="primary-btn" onclick="show('lead')">+ New Lead</button>
            <button class="secondary-btn" onclick="show('pipeline')">Full Pipeline</button>
            <button class="secondary-btn" onclick="show('templates')">Email Templates</button>
            <button class="secondary-btn" onclick="show('myDashboard')">My Ops Dashboard</button>
          </div>
          <div class="dashboard-strip">
            <div class="dash-tile"><strong>1. Receive</strong><span>Log inbound leads, route to right rep</span></div>
            <div class="dash-tile"><strong>2. Support</strong><span>Gather scope, pricing, proposal info</span></div>
            <div class="dash-tile"><strong>3. Chase</strong><span>Follow up on open estimates &amp; signatures</span></div>
            <div class="dash-tile"><strong>4. Convert</strong><span>Confirm deposit, hand off to schedule</span></div>
          </div>
        </div>
        <aside class="hero-panel">
          <div>
            <div class="hero-logo"><img src="/static/avalon-logo.png" alt="Avalon logo"></div>
            <h3 class="mt">Office standard</h3>
            <p class="muted">Every lead gets a response. Every proposal gets a follow-up. Every deposit gets a handoff.</p>
          </div>
          <div class="footer-actions">
            <button class="secondary-btn small" onclick="show('myDashboard')">Ops Dashboard</button>
            <button class="secondary-btn small" onclick="show('manager')">Pipeline Review</button>
          </div>
        </aside>
      </div>
    </div>` : `
    <div class="hero">
      <div class="hero-grid">
        <div>
          <div class="hero-title-line"><div class="eyebrow">Avalon Sales OS</div><span class="pill">Mobile-ready internal app</span></div>
          <h1>Run sales the Avalon way.</h1>
          <p class="lede">A daily operating hub for lead intake, discovery, site walks, proposals, follow-up, sold-job activation, and manager coaching.</p>
          <div class="quick-actions">
            <button class="primary-btn" onclick="show('lead')">+ New Lead</button>
            <button class="secondary-btn" onclick="show('pipeline')">Open Pipeline</button>
            <button class="secondary-btn" onclick="show('forms','discovery')">Discovery Planner</button>
            <button class="secondary-btn" onclick="show('forms','site-walk')">Site Walk Checklist</button>
            <button class="secondary-btn" onclick="show('templates')">Email Templates</button>
          </div>
          <div class="dashboard-strip">
            <div class="dash-tile"><strong>1. Qualify</strong><span>Lead fit, source, urgency, decision-maker</span></div>
            <div class="dash-tile"><strong>2. Discover</strong><span>Buying reasons, budget comfort, priorities</span></div>
            <div class="dash-tile"><strong>3. Package</strong><span>Scope, price, exclusions, next step</span></div>
            <div class="dash-tile"><strong>4. Activate</strong><span>Signed approval, deposit, clean handoff</span></div>
          </div>
        </div>
        <aside class="hero-panel">
          <div>
            <div class="hero-logo"><img src="/static/avalon-logo.png" alt="Avalon logo"></div>
            <h3 class="mt">Daily standard</h3>
            <p class="muted">No opportunity moves forward without a clear next step, documented assumptions, and ownership.</p>
          </div>
          <div class="footer-actions">
            <button class="secondary-btn small" onclick="show('manager')"
              style="border-color:rgba(0,167,225,.25)" aria-label="Open Manager Review">
              Manager Review
            </button>
            <button class="primary-btn small" onclick="show('academy')"
              style="display:inline-flex;align-items:center;gap:6px"
              aria-label="Open Training Path — Sales Academy">
              Training Path
            </button>
          </div>
        </aside>
      </div>
    </div>`;
  view.innerHTML = `${_heroBlock}
    ${statCards()}
    <div class="grid grid-2 mt">
      <section class="card app-card">
        <div class="section-head"><h2>Due Now</h2>${badge(`${due.length} follow-up${due.length===1?'':'s'}`, due.length?'warn-badge':'')}</div>
        ${due.length ? due.map(oppCard).join('') : `<div class="due-now-clear">
          
          <p style="color:#4ade80;font-weight:600;margin:0 0 10px;font-size:14px">No follow-ups due today.</p>
        </div>
        ${buildSuggestedActions(_todayRep)}`}
      </section>
      <section class="card app-card">
        <h2>Daily Sales Start-Up</h2>
        ${renderChecklist(data.checklists.find(c=>c.id==='daily'), true)}
      </section>
    </div>
    <div class="grid grid-2 mt">
      <section class="card"><h2>Coming Up</h2>${next.length ? next.map(oppMini).join('') : empty('No upcoming follow-ups.', '', `<button class="secondary-btn small" onclick="show('pipeline')">View Pipeline</button>`)}</section>
      <section class="card"><h2>Recently Updated</h2>${recent.length ? recent.map(oppMini).join('') : empty('No leads yet.', '', `<button class="primary-btn small" onclick="show('lead')">+ Add First Lead</button>`)}</section>
    </div>
    ${renderTodayActivityWidget()}
  `;
  wireChecks();
}

function renderTodayActivityWidget(){
  const currentRep = window.getCurrentRep ? window.getCurrentRep() : null;
  const targets = window.AVALON_DATA.activityTargets;
  // Office manager (Jen) has no personal activity targets — suppress widget entirely
  if(currentRep && currentRep.role === 'office_manager') return '';
  if(!currentRep || !targets[currentRep.id]) {
    // Show generic KPI strip for admin
    return `<div class="card mt">
      <h3>Weekly KPI Targets (Ryan)</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin-top:10px">
        ${Object.entries(targets.ryan||{}).map(([k,v])=>`<div style="background:var(--bg2);border-radius:8px;padding:12px">
          <div style="font-size:.75rem;color:var(--muted);margin-bottom:4px">${escapeHtml(v.label)}</div>
          <div style="font-size:1.1rem;font-weight:700;color:var(--accent)">${v.target !== undefined ? (v.floor ? '0 stale' : v.target+'/wk') : (v.min === v.max ? v.min : (v.min||'—')+'–'+(v.max||'—'))}</div>
        </div>`).join('')}
      </div>
    </div>`;
  }
  const repTargets = targets[currentRep.id];
  if(!repTargets) return '';
  return `<div class="card mt" style="border-left:3px solid ${currentRep.color||'#00d4ff'}">
    <h3>${currentRep.avatar} ${escapeHtml(currentRep.name)}'s Weekly Activity Targets</h3>
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
  return `<button class="mini-row ${isOverdue?'mini-row-overdue':''}" onclick="show('pipeline','${o.id}')">
    <strong>${urgencyDot}${escapeHtml(o.client||'Unnamed')}</strong>
    <span class="status-chip ${statusCssClass(o.status||'')}" style="font-size:10px;padding:1px 6px">${escapeHtml(o.status||'New Lead')}</span>
    <em>${escapeHtml(o.project||o.serviceLine||'Opportunity')}</em>
    ${daysSince !== null ? `<span style="font-size:10px;color:#475569;margin-left:auto">${daysSince===0?'Today':daysSince+'d ago'}</span>` : ''}
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
  return `<article class="opp-card ${isOverdue ? 'opp-overdue' : isStale ? 'opp-stale' : ''}">
    <div class="opp-card-top">
      <h3>${escapeHtml(o.client||'Unnamed Lead')}</h3>
      ${urgencyBadge}
    </div>
    <p class="opp-project">${escapeHtml(o.project||o.serviceLine||'Opportunity')} • ${escapeHtml(o.address||'No address')}</p>
    <div class="opp-meta">
      ${badge(o.status||'New Lead')}
      <span>Next: ${prettyDate(o.nextFollowUp)}</span>
      ${o.jobValue ? `<span style="color:#4ade80;font-weight:600">${money(Number(o.jobValue))}</span>` : ''}
      ${repObj ? `<span title="${escapeHtml(repObj.name)}">${repObj.avatar}</span>` : ''}
    </div>
    <button class="secondary-btn small" onclick="show('pipeline','${o.id}')">Open</button>
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

  view.innerHTML = `
    <div class="hero pipeline-hero">
      <div class="eyebrow">Day-to-Day Sales Tracker</div>
      <h1>Pipeline</h1>
      <p class="lede">Track leads from first inquiry through proposal, follow-up, and sold-job activation.</p>
      <div class="quick-actions">
        <button class="primary-btn" onclick="show('lead')">+ Add Lead</button>
        <button class="secondary-btn" onclick="exportCsv()">Export CSV</button>
        <button class="secondary-btn" onclick="show('forms','follow-up')">Follow-Up Cadence</button>
      </div>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:20px;align-items:center">
      ${(()=>{
        const _cr = window.getCurrentRep ? window.getCurrentRep() : null;
        const _ia = _cr && (_cr.role === 'admin' || _cr.role === 'office_manager');
        if (!_ia) return ''; // Ryan (rep): no rep filter — always sees only his own
        return `<div style="display:flex;gap:6px;flex-wrap:wrap">
          <span style="font-size:12px;color:var(--muted);align-self:center">Rep:</span>
          <button class="tab ${activeRepFilter==='all'?'active':''}" onclick="window._pipelineRepFilter='all';show('pipeline')">All</button>
          ${(window.REPS||[]).map(r=>`<button class="tab ${activeRepFilter===r.id?'active':''}" onclick="window._pipelineRepFilter='${r.id}';show('pipeline')">${r.avatar} ${r.name}</button>`).join('')}
        </div>`;
      })()}
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <span style="font-size:12px;color:var(--muted);align-self:center">Client:</span>
        <button class="tab ${activeTypeFilter==='all'?'active':''}" onclick="window._pipelineTypeFilter='all';show('pipeline')">All</button>
        <button class="tab ${activeTypeFilter==='Residential'?'active':''}" onclick="window._pipelineTypeFilter='Residential';show('pipeline')">Residential</button>
        <button class="tab ${activeTypeFilter==='Commercial'?'active':''}" onclick="window._pipelineTypeFilter='Commercial';show('pipeline')">Commercial</button>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <span style="font-size:12px;color:var(--muted);align-self:center">Work:</span>
        <button class="tab ${activeCatFilter==='all'?'active':''}" onclick="window._pipelineCatFilter='all';show('pipeline')">All Work</button>
        <button class="tab ${activeCatFilter==='landscape'?'active':''}" onclick="window._pipelineCatFilter='landscape';show('pipeline')">Landscape</button>
        <button class="tab ${activeCatFilter==='maintenance'?'active':''}" onclick="window._pipelineCatFilter='maintenance';show('pipeline')">Maintenance</button>
        <button class="tab ${activeCatFilter==='snow'?'active':''}" onclick="window._pipelineCatFilter='snow';show('pipeline')">Snow & Ice</button>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <span style="font-size:12px;color:var(--muted);align-self:center">Sort:</span>
        <button class="tab ${activeSort==='urgent'?'active':''}" onclick="window._pipelineSort='urgent';show('pipeline')">Urgent</button>
        <button class="tab ${activeSort==='recent'?'active':''}" onclick="window._pipelineSort='recent';show('pipeline')">Recent</button>
        <button class="tab ${activeSort==='value'?'active':''}" onclick="window._pipelineSort='value';show('pipeline')">Value</button>
      </div>
    </div>
    ${activeStatusFilter ? `<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;padding:8px 14px;background:#0f172a;border:1px solid #334155;border-radius:10px;font-size:13px">
      <span style="color:#94a3b8">Filtered: <strong style="color:#e2e8f0">${activeStatusFilter}</strong></span>
      <button class="secondary-btn small" style="margin-left:auto" onclick="window._pipelineStatusFilter=null;show('pipeline')">× Clear Filter</button>
    </div>` : ''}
    ${statCards()}
    <div class="kanban mt">
      ${grouped.map(g=>`<section class="kanban-col"><h3>${escapeHtml(g.status)} <span>${g.items.length}</span></h3>${g.items.length ? g.items.map(oppCard).join('') : '<p class="muted small-text">No items</p>'}</section>`).join('')}
    </div>
  `;
}

window.filterPipelineByRep = function(repId) {
  window._pipelineRepFilter = repId;
  show('pipeline');
};

function lead(){
  const currentRep = window.getCurrentRep ? window.getCurrentRep() : null;

  // Rep picker HTML (admin/manager only)
  const _cr = window.getCurrentRep ? window.getCurrentRep() : null;
  const _ia = _cr && (_cr.role === 'admin' || _cr.role === 'office_manager');
  const repPickerHtml = _ia
    ? '<label class="lf-field"><span class="lf-label">Assigned Rep</span><select name="repId" class="lf-select"><option value="">— Select rep —</option>'
        + (window.REPS||[]).map(r=>'<option value="' + r.id + '">' + r.avatar + ' ' + r.name + '</option>').join('')
        + '</select></label>'
    : '<input type="hidden" name="repId" value="' + (_cr ? _cr.id : '') + '">';

  // Project category tile data
  const _cats = [
    {v:'Landscape / Enhancement', icon:'', short:'Landscape'},
    {v:'Maintenance - Recurring',  icon:'', short:'Recurring Maint.'},
    {v:'Maintenance - One Time',   icon:'', short:'One-Time Maint.'},
    {v:'Hardscape',                icon:'', short:'Hardscape'},
    {v:'Drainage',                 icon:'', short:'Drainage'},
    {v:'Design / Build',           icon:'', short:'Design / Build'},
    {v:'Irrigation',               icon:'', short:'Irrigation'},
    {v:'Outdoor Lighting',         icon:'', short:'Lighting'},
    {v:'Other',                    icon:'', short:'Other'},
  ];
  const catTilesHtml = _cats.map(c =>
    '<button type="button" class="cat-tile" data-cat="' + c.v + '">'
    + c.icon ? '<span class="cat-tile-icon">' + c.icon + '</span>' : ''
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
      + '<div class="lf-hero-eyebrow">New Opportunity</div>'
      + '<h1 class="lf-hero-title">Let\'s capture this lead</h1>'
      + '<p class="lf-hero-sub">Every great project starts here. Fill in what you know — you can always add more later.</p>'
    + '</div>'
    + '<form id="leadForm">'

      // ── Section 1: Who is it? ──
      + '<div class="lf-section">'
        + '<div class="lf-section-header">'
          + '<span class="lf-section-num">1</span>'
          + '<div>'
            + '<div class="lf-section-title">Who is it?</div>'
            + '<div class="lf-section-sub">Contact details for the prospect</div>'
          + '</div>'
        + '</div>'
        + '<div class="lf-fields">'
          + '<label class="lf-field lf-field--full">'
            + '<span class="lf-label">Client Name <span class="lf-required">*</span></span>'
            + '<input name="client" type="text" required class="lf-input lf-input--lg" placeholder="e.g. Sarah Johnson">'
          + '</label>'
          + '<label class="lf-field">'
            + '<span class="lf-label">Phone</span>'
            + '<input name="phone" type="tel" class="lf-input" placeholder="(555) 000-0000">'
          + '</label>'
          + '<label class="lf-field">'
            + '<span class="lf-label">Email</span>'
            + '<input name="email" type="email" class="lf-input" placeholder="name@example.com">'
          + '</label>'
          + '<label class="lf-field lf-field--full">'
            + '<span class="lf-label">Property Address</span>'
            + '<input name="address" type="text" class="lf-input" placeholder="Street, City, State">'
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
            + '<span class="lf-comm-icon">$</span>'
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

  // T35: Commission preview — wire live calc after DOM settles
  setTimeout(() => {
    const jvInput = document.querySelector('[name="jobValue"]');
    const wtSelect = document.querySelector('[name="workType"]');
    const preview = document.getElementById('commPreview');
    const previewText = document.getElementById('commPreviewText');
    function updateCommPreview() {
      if (!preview) return;
      const val = Number(jvInput?.value || 0);
      const wt  = wtSelect?.value || '';
      if (!val) { preview.style.display = 'none'; return; }
      const rates = { landscape:.08, maintenance_onetime:.06, maintenance_recurring:.10, hardscape:.07, drainage:.07, design_build:.07 };
      const rate = rates[wt] || .07;
      const est  = val * rate;
      const commStr = est.toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0});
      if (previewText) previewText.textContent = 'Est. commission: ' + commStr + ' (' + Math.round(rate*100) + '%)';
      preview.style.display = 'flex';
    }
    if (jvInput)  jvInput.addEventListener('input', updateCommPreview);
    if (wtSelect) wtSelect.addEventListener('change', updateCommPreview);
  }, 150);

  document.getElementById('leadForm').addEventListener('submit', e=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    const opp = Object.fromEntries(fd.entries());
    opp.id = uid('opp'); opp.createdAt = new Date().toISOString(); opp.updatedAt = opp.createdAt;
    if(!opp.status) opp.status = 'New Lead';
    if(!opp.repId && currentRep) opp.repId = currentRep.id;
    state.opportunities.unshift(opp); saveState(); showToast('Lead saved'); show('pipeline', opp.id);
  });

  // T36: Duplicate detection — blur event on client name + address inputs
  setTimeout(() => {
    function checkDuplicates() {
      const nameEl = document.querySelector('[name="client"]');
      const addrEl = document.querySelector('[name="address"]');
      const name = (nameEl?.value || '').toLowerCase().trim();
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
      warn.id = 'dup-warn';
      warn.className = 'dup-warn';
      warn.innerHTML = '<strong>Possible duplicate' + (dupes.length > 1 ? 's' : '') + '</strong> — similar lead' + (dupes.length > 1 ? 's' : '') + ' already in pipeline:<br>' +
        dupes.map(o => '<span onclick="show(\'pipeline\',\'' + o.id + '\')" style="cursor:pointer;color:#00d4ff;text-decoration:underline">' + escapeHtml(o.client||'—') + ' · ' + escapeHtml(o.status||'') + '</span>').join('<br>');
      const form = document.getElementById('leadForm');
      if (form) form.prepend(warn);
    }
    const nameEl = document.querySelector('[name="client"]');
    const addrEl = document.querySelector('[name="address"]');
    if (nameEl) nameEl.addEventListener('blur', checkDuplicates);
    if (addrEl) addrEl.addEventListener('blur', checkDuplicates);
  }, 200);
}
function input(name,label,type='text'){ const required = type===true; const actualType = required ? 'text' : type; return `<label><span>${label}${required?' *':''}</span><input name="${name}" type="${actualType}" ${required?'required':''}></label>`; }
function select(name,label,options,selected=''){ return `<label><span>${label}</span><select name="${name}"><option value="">Select...</option>${options.map(o=>`<option ${o===selected?'selected':''}>${escapeHtml(o)}</option>`).join('')}</select></label>`; }
function textarea(name,label,value=''){ return `<label class="full"><span>${label}</span><textarea name="${name}" rows="4">${escapeHtml(value)}</textarea></label>`; }

function opportunityDetail(id){
  const o = state.opportunities.find(x=>x.id===id);
  if(!o){ return pipeline(); }
  const stageGuess = Math.max(1, data.statuses.indexOf(o.status)+1);
  view.innerHTML = `
    <button class="secondary-btn" onclick="show('pipeline')">← Back to Pipeline</button>
    ${(()=>{
      const _repObj = (window.REPS||[]).find(r=>r.id===o.repId);
      const _repName = _repObj ? _repObj.name : null;
      const _repAvatar = _repObj ? _repObj.avatar : '—';
      const _isOvd = o.nextFollowUp && o.nextFollowUp < todayISO() && !['Sold / Activation','Closed Lost'].includes(o.status);
      const _estComm = estCommission(o);
      return `<div class="lead-header-bar">
        <div class="lhb-cell">
          <span class="lhb-label">Stage</span>
          <span class="status-chip ${statusCssClass(o.status||'')}" style="font-size:11px">${escapeHtml(o.status||'New Lead')}</span>
        </div>
        <div class="lhb-cell">
          <span class="lhb-label">Rep</span>
          <span>${_repAvatar} ${escapeHtml(_repName||'Unassigned')}</span>
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
              ${(window.REPS||[]).map(r=>`<option value="${r.id}" ${_ca.repId===r.id?'selected':''}>${r.avatar} ${r.name}</option>`).join('')}
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
  `;
}

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
  Object.assign(o, Object.fromEntries(fd.entries()), {updatedAt:new Date().toISOString()});
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
  const dotIcon  = { note:'·', stage:'·', sold:'·', created:'·', admin:'·' };

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

function process(stageId){
  if(stageId){ return renderStage(data.stages.find(s=>s.id===Number(stageId))); }
  const sp = data.salesProcess;
  const stepColors = ['#00d4ff','#4ade80','#f59e0b','#ef4444','#a855f7','#ec4899'];
  view.innerHTML = `
    <div class="eyebrow">Operating System</div>
    <h1>Avalon Sales Process</h1>
    <p class="lede">${escapeHtml(sp.subtitle)}</p>
    <div class="card warn mt" style="text-align:center"><strong style="font-size:1.1rem">${escapeHtml(sp.stat)}</strong></div>
    <h2 class="mt" style="font-size:1rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)">6-Step Avalon Method</h2>
    <div class="grid grid-3 mt" style="gap:12px">
      ${sp.steps.map((s,i)=>`<article class="card" style="border-top:3px solid ${stepColors[i]};padding:16px">
        <div style="font-size:2rem;font-weight:900;color:${stepColors[i]};line-height:1">Step ${s.num}</div>
        <h3 style="margin:6px 0 4px">${escapeHtml(s.title)}</h3>
        <p class="muted small-text">${escapeHtml(s.tagline)}</p>
        <p style="font-size:.85rem;margin-top:8px">${escapeHtml(s.description.slice(0,120))}…</p>
      </article>`).join('')}
    </div>
    <h2 class="mt" style="font-size:1rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)">12-Stage Operating Procedures</h2>
    <p class="lede" style="font-size:.9rem">Each stage has a purpose, owner, required artifact, stage gate, questions, and red flags. Tap any stage to open the full procedure.</p>
    <div class="grid grid-3 mt">${data.stages.map(s=>{
      const stageOpps = (state.opportunities||[]).filter(o => o.status === s.title && !['Sold / Activation','Closed Lost'].includes(o.status));
      const cnt = stageOpps.length;
      return `<article class="card clickable" onclick="show('process',${s.id})">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;justify-content:space-between">
          <div style="display:flex;align-items:center;gap:8px">
            <div class="stage-number">${s.id}</div>
            ${s.processStep ? `<span class="badge" style="font-size:.7rem;background:rgba(0,212,255,.12);color:#00d4ff">${escapeHtml(s.processStep)}</span>` : ''}
          </div>
          ${cnt > 0 ? `<span class="live-count-badge">${cnt}</span>` : '<span class="live-count-badge empty">0</span>'}
        </div>
        <h3>${escapeHtml(s.title)}</h3>
        <p style="font-size:.85rem">${escapeHtml(s.purpose)}</p>
        <p class="meta"><strong>Owner:</strong> ${escapeHtml(s.owner)}</p>
      </article>`;
    }).join('')}</div>
  `;
}
function renderStage(s){
  const stageChecklist = (window.AVALON_DATA.checklists||[]).find(c=>c.stage===s.id);
  view.innerHTML = `
    <button class="secondary-btn" onclick="show('process')">← Back to all stages</button>
    <h1><span class="stage-number">${s.id}</span> ${escapeHtml(s.title)}</h1>
    ${s.processStep ? `<div class="eyebrow">${escapeHtml(s.processStep)}</div>` : ''}
    <p class="lede">${escapeHtml(s.purpose)}</p>
    <div class="grid grid-2 mt">
      <div class="card"><h3>Owner</h3><p>${escapeHtml(s.owner)}</p></div>
      <div class="card"><h3>Gate to Next Stage</h3><p>${escapeHtml(s.gate)}</p></div>
    </div>
    <div class="grid grid-2 mt">
      <div class="card"><h3>Required Actions</h3>${list(s.actions)}${s.approvalMatrix ? `<h4 style="margin-top:12px">Approval Authority</h4><table style="width:100%;font-size:.83rem;border-collapse:collapse">${s.approvalMatrix.map(a=>`<tr style="border-bottom:1px solid var(--border)"><td style="padding:4px 8px 4px 0;color:var(--muted)">${escapeHtml(a.range)}</td><td style="padding:4px 0">${escapeHtml(a.approval)}</td></tr>`).join('')}</table>` : ''}</div>
      <div class="card">
        <h3>Required Artifact</h3><p>${escapeHtml(s.artifact)}</p>
        ${s.questions && s.questions.length ? `<h3 style="margin-top:12px">Questions to Use</h3>${list(s.questions)}` : ''}
        ${s.followUpCadence ? `<h3 style="margin-top:12px">Follow-Up Cadence</h3>${s.followUpCadence.map(f=>`<div style="display:flex;gap:8px;margin:4px 0;font-size:.83rem"><strong style="color:var(--accent);min-width:50px">${escapeHtml(f.day)}</strong><span>${escapeHtml(f.action)}</span></div>`).join('')}` : ''}
        ${s.objectionFramework ? `<h3 style="margin-top:12px">Objection Framework</h3>${list(s.objectionFramework)}` : ''}
        ${s.proposalStructure ? `<h3 style="margin-top:12px">Proposal Structure</h3>${list(s.proposalStructure)}` : ''}
      </div>
    </div>
    <div class="card danger mt"><h3>Red Flags — Do Not Advance Until Resolved</h3>${list(s.redFlags)}</div>
    ${stageChecklist ? `<div class="card mt"><h3>${escapeHtml(stageChecklist.title)}</h3>${renderChecklist(stageChecklist, true)}</div>` : ''}
    ${(()=>{
      const atStage = (state.opportunities||[]).filter(o => o.status === s.title && !['Sold / Activation','Closed Lost'].includes(o.status));
      if (!atStage.length) return '';
      return `<div class="card mt" style="border-left:3px solid #00d4ff"><h3 style="color:#00d4ff;margin-bottom:10px">${atStage.length} Lead${atStage.length>1?'s':''} at This Stage</h3>
        <div style="display:flex;flex-direction:column;gap:8px">${atStage.slice(0,5).map(o=>`<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:#0f172a;border-radius:8px;cursor:pointer" onclick="show('pipeline','${o.id}')">
          <div>
            <div style="font-weight:600;color:#e2e8f0">${escapeHtml(o.client||'—')}</div>
            <div style="font-size:11px;color:#64748b">${o.jobValue?money(Number(o.jobValue)):''} ${o.nextFollowUp?'· Follow-up: '+prettyDate(o.nextFollowUp):''}</div>
          </div>
          <span style="font-size:11px;color:#00d4ff">→</span>
        </div>`).join('')}
        ${atStage.length>5?`<div style="font-size:12px;color:#64748b;text-align:center">+${atStage.length-5} more · <span onclick="window._pipelineStatusFilter=null;show('pipeline')" style="color:#00d4ff;cursor:pointer">View all in pipeline →</span></div>`:''}
      </div>`;
    })()}
    <div class="footer-actions mt">
      ${s.id>1?`<button class="secondary-btn" onclick="show('process',${s.id-1})">← Previous Stage</button>`:''}
      ${s.id<12?`<button class="primary-btn" onclick="show('process',${s.id+1})">Next Stage →</button>`:''}
    </div>`;
  wireChecks();
}

function forms(formId){
  if(formId){ const f = data.forms.find(x=>x.id===formId); if(f) return renderFormTool(f); }
  const stageChecklists = (data.checklists||[]).filter(c=>c.stage>0);
  const utilChecklists = (data.checklists||[]).filter(c=>c.stage===0);
  view.innerHTML = `<div class="eyebrow">Field Tools</div><h1>Forms & Checklists</h1><p class="lede">These are the reusable day-to-day tools your team should open before calls, site visits, proposal reviews, follow-up, sold-job activation, and closeout.</p>
  <div class="grid grid-3 mt">${data.forms.map(f=>{
    const stageNum = f.stage ? ` · Stage ${f.stage}` : '';
    return `<article class="card clickable" onclick="show('forms','${f.id}')"><span class="badge">Tool${stageNum}</span><h3>${escapeHtml(f.title)}</h3><p style="font-size:.85rem">${f.fields.slice(0,3).map(x=>x.label).join(', ')}…</p></article>`;
  }).join('')}</div>
  <h2 class="mt">Stage Checklists</h2>
  <div class="grid grid-2">${stageChecklists.map(c=>`<article class="card clickable" style="border-left:3px solid #00d4ff;transition:border-color .2s" onclick="show('forms','${c.id}')"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px"><h3 style="margin:0">${escapeHtml(c.title)}</h3><span style="color:#00d4ff;font-size:1.1rem;font-weight:700">→</span></div><p class="muted small-text">Stage ${c.stage}</p>${renderChecklist(c,true)}</article>`).join('')}</div>
  <h2 class="mt">Daily & Weekly Tools</h2>
  <div class="grid grid-2">${utilChecklists.map(c=>`<article class="card clickable" style="border-left:3px solid #4ade80;transition:border-color .2s" onclick="show('forms','${c.id}')"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px"><h3 style="margin:0">${escapeHtml(c.title)}</h3><span style="color:#4ade80;font-size:1.1rem;font-weight:700">→</span></div>${renderChecklist(c,true)}</article>`).join('')}</div>`;
  wireChecks();
}
function renderFormTool(f){
  const stageChecklist = (data.checklists||[]).find(c=>c.stage===f.stage);
  const fieldLabels = f.fields.map(x=>x.label);
  const _fieldCopyStr = fieldLabels.map(x=>'- '+x+':').join('\n');
  const _noteCopyStr  = fieldLabels.map(x=>x+':').join('\n\n');
  const _noteHtml     = nl2br(fieldLabels.map(x=>x+':').join('\n\n'));
  const _scTitle      = stageChecklist ? escapeHtml(stageChecklist.title) : 'Stage Checklist';
  const _scHtml       = stageChecklist ? renderChecklist(stageChecklist, true) : '<p class="muted">No checklist for this stage.</p>';
  view.innerHTML =
    '<button class="secondary-btn" onclick="show(\'forms\')">← Back to Forms</button>'
    +'<div class="eyebrow">Daily Tool · Stage '+(f.stage||'—')+'</div>'
    +'<h1>'+escapeHtml(f.title)+'</h1>'
    +'<div class="grid grid-2 mt">'
    +'<section class="card"><h2>Fields to Capture</h2>'+list(fieldLabels)
    +'<button class="secondary-btn mt8" onclick="copyText(\''+ escapeForJs(_fieldCopyStr) +'\',this)">Copy Field Template</button></section>'
    +'<section class="card"><h2>'+_scTitle+'</h2>'+_scHtml+'</section></div>'
    +'<section class="card mt"><h2>Copy-Ready Working Note</h2>'
    +'<div class="script-box">'+_noteHtml+'</div>'
    +'<button class="primary-btn mt8" onclick="copyText(\''+ escapeForJs(_noteCopyStr) +'\')">Copy Note Template</button></section>';
  wireChecks();
}
function escapeForJs(str){ return String(str).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/\n/g,'\\n'); }
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
  const barColor = pct===100?'#4ade80':pct>=50?'#fbbf24':'#60a5fa';
  const progressBar = persist ? `<div class="checklist-progress"><div class="cp-bar" style="width:${pct}%;background:${barColor}"></div></div><div class="cp-label">${done}/${total} complete</div>` : '';
  return `${progressBar}<div class="checklist">${items.join('')}</div>`;
}
function wireChecks(){ document.querySelectorAll('.check-item input[data-key]').forEach(cb=>{ cb.checked = localStorage.getItem(cb.dataset.key)==='true'; cb.addEventListener('change',()=>localStorage.setItem(cb.dataset.key, cb.checked)); }); }

// ── T31: Lead Picker Modal (shared by Scripts, Templates, Objections, Pricing) ──
function openLeadPicker(onSelect){
  const open = state.opportunities.filter(o => !['Sold / Activation','Closed Lost'].includes(o.status));
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal" style="max-width:480px">
      <h3 style="margin:0 0 12px">Select a Lead</h3>
      <input id="lpSearch" type="text" placeholder="Search by client or project..."
        style="width:100%;padding:8px 12px;background:#1e293b;border:1px solid #334155;border-radius:8px;color:#e2e8f0;margin-bottom:12px;box-sizing:border-box">
      <div id="lpList" style="max-height:320px;overflow-y:auto;display:flex;flex-direction:column;gap:6px"></div>
      <button class="secondary-btn mt8" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
    </div>`;
  document.body.appendChild(modal);
  const listEl = modal.querySelector('#lpList');
  const searchEl = modal.querySelector('#lpSearch');
  function renderList(filter=''){
    const filtered = open.filter(o => !filter ||
      (o.client||'').toLowerCase().includes(filter.toLowerCase()) ||
      (o.project||'').toLowerCase().includes(filter.toLowerCase())
    );
    listEl.innerHTML = filtered.slice(0,20).map(o =>
      `<button class="mini-row" style="text-align:left;width:100%"
        onclick="document.querySelector('.modal-overlay').remove()">
        <strong>${escapeHtml(o.client||'Unnamed')}</strong>
        <span class="status-chip ${statusCssClass(o.status||'')}" style="font-size:10px;padding:1px 6px">${escapeHtml(o.status||'')}</span>
        <em>${escapeHtml(o.project||'')}</em>
      </button>`
    ).join('') || '<p class="muted" style="padding:12px">No matching leads.</p>';
    // Re-wire clicks after render
    listEl.querySelectorAll('.mini-row').forEach((btn, idx) => {
      btn.addEventListener('click', () => {
        const opp = filtered[idx];
        if(opp) onSelect(opp.id);
      });
    });
  }
  renderList();
  searchEl.addEventListener('input', e => renderList(e.target.value));
  searchEl.focus();
}
window.openLeadPicker = openLeadPicker;

// ── T39: Merge template fields from a live lead ──
function mergeTemplate(body, opp){
  const rep = (window.REPS||[]).find(r=>r.id===opp.repId) || { name: 'Your Name' };
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

function scripts(){
  const cats = ['All', ...new Set(data.scripts.map(s=>s.category))];
  view.innerHTML = `<div class="eyebrow">Talk Tracks</div><h1>Scripts Library</h1><p class="lede">Use these as flexible language. Keep the intent, adapt the words, and sound human.</p><div class="tabs">${cats.map((c,i)=>`<button class="tab ${i===0?'active':''}" data-cat="${c}">${escapeHtml(c)}</button>`).join('')}</div><div id="scriptList" class="grid grid-2"></div>`;
  const box = document.getElementById('scriptList');
  function render(cat='All'){ box.innerHTML = data.scripts.filter(s=>cat==='All'||s.category===cat).map(s=>`<article class="card"><span class="badge">${escapeHtml(s.category)}</span><h3>${escapeHtml(s.title)}</h3><div class="script-box">${nl2br(s.body)}</div><div class="footer-actions" style="margin-top:8px;gap:6px"><button class="secondary-btn" onclick="copyText('${escapeForJs(s.body)}', this)">Copy Script</button><button class="secondary-btn" onclick="openLeadPicker(function(id){show('pipeline',id);setTimeout(()=>{const el=document.getElementById('newNote');if(el){el.value='[Script: ${escapeForJs(s.title)}]\n\n${escapeForJs(s.body.slice(0,300))}';el.focus();showToast('Script loaded — add your note and save');}},400);})">Use for Lead</button></div></article>`).join(''); }
  render();
  document.querySelector('.tabs').addEventListener('click',e=>{ if(!e.target.matches('.tab')) return; document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active')); e.target.classList.add('active'); render(e.target.dataset.cat); });
}
function templates(){
  const cats = ['All', ...new Set(data.templates.map(t=>t.category))];
  view.innerHTML = `<div class="eyebrow">Copy-Ready Communication</div><h1>Email Templates</h1><p class="lede">Templates for daily sales communication. Copy, personalize, and send through Gmail or your CRM.</p><div class="tabs">${cats.map((c,i)=>`<button class="tab ${i===0?'active':''}" data-cat="${c}">${escapeHtml(c)}</button>`).join('')}</div><div id="templateList" class="grid grid-2"></div>`;
  const box = document.getElementById('templateList');
  function render(cat='All'){ box.innerHTML = data.templates.filter(t=>cat==='All'||t.category===cat).map(t=>`<article class="card"><span class="badge">${escapeHtml(t.category)}</span><h3>${escapeHtml(t.title)}</h3><p><strong>Subject:</strong> ${escapeHtml(t.subject)}</p><div class="script-box">${nl2br(t.body)}</div><div class="footer-actions" style="flex-wrap:wrap;gap:6px"><button class="secondary-btn" onclick="copyText('${escapeForJs(t.subject)}', this)">Copy Subject</button><button class="primary-btn" onclick="copyText('${escapeForJs(t.body)}', this)">Copy Body</button><button class="secondary-btn" onclick="openLeadPicker(function(id){const opp=state.opportunities.find(x=>x.id===id);if(!opp)return;const merged=mergeTemplate('${escapeForJs(t.body)}',opp);navigator.clipboard.writeText('Subject: ${escapeForJs(t.subject)}\n\n'+merged).catch(()=>{});showToast('Personalized copy ready for '+(opp.client||'lead'));})">Personalize + Copy</button><button class="secondary-btn" onclick="openLeadPicker(function(id){show('pipeline',id);setTimeout(()=>{const el=document.getElementById('newNote');if(el){el.value='Subject: ${escapeForJs(t.subject)}\n\n${escapeForJs(t.body.slice(0,300))}';el.focus();showToast('Template loaded into note field');}},400);})">Use for Lead</button></div></article>`).join(''); }
  render();
  document.querySelector('.tabs').addEventListener('click',e=>{ if(!e.target.matches('.tab')) return; document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active')); e.target.classList.add('active'); render(e.target.dataset.cat); });
}
function objections(){
  view.innerHTML = `<div class="eyebrow">Decision Management</div><h1>Objection Handling</h1><p class="lede">Do not argue. Clarify, reconnect to the buying reason, protect scope quality, and guide the client toward a clear decision.</p><div class="grid grid-2 mt">${data.objections.map(o=>`<article class="card"><h3>${escapeHtml(o.title)}</h3><p class="muted"><strong>What it may mean:</strong> ${escapeHtml(o.meaning)}</p><h4>How to respond</h4>${list(o.response)}<h4>Say this</h4><div class="script-box">${escapeHtml(o.say)}</div><div class="footer-actions" style="margin-top:10px;gap:6px"><button class="secondary-btn" onclick="copyText('${escapeForJs(o.say)}', this)">Copy Response</button><button class="secondary-btn" onclick="openLeadPicker(function(id){const opp=state.opportunities.find(x=>x.id===id);if(!opp)return;const note={id:'n'+Date.now(),text:'Objection raised: ${escapeForJs(o.title)}',createdAt:new Date().toISOString(),type:'objection'};opp.notes=opp.notes||[];opp.notes.push(note);opp.updatedAt=new Date().toISOString();saveState();showToast('Objection logged to '+escapeHtml(opp.client||'lead'));})">Log to Lead</button></div></article>`).join('')}</div>`;
}

function calculator(){
  view.innerHTML = `<div class="eyebrow">Quick Pricing Checks</div><h1>Pricing Tools</h1><p class="lede">Use these for quick internal checks only. Final pricing should still follow Avalon estimating and margin review standards.</p><div class="grid grid-2 mt"><section class="card form"><h2>Margin Calculator</h2><label><span>Estimated Cost</span><input id="cost" type="number" min="0" step="0.01" placeholder="Materials + labor + subs + overhead"></label><label><span>Target Gross Margin %</span><input id="margin" type="number" min="1" max="95" step="1" value="45"></label><button class="primary-btn" onclick="calcMargin()">Calculate Price</button><div id="marginResult" class="result-box"></div></section><section class="card form"><h2>Labor Revenue Check</h2><label><span>Labor Hours</span><input id="hours" type="number" min="0" step="0.5"></label><label><span>Hourly Billing / Internal Rate</span><input id="rate" type="number" min="0" step="1" value="75"></label><button class="primary-btn" onclick="calcLabor()">Calculate Labor Line</button><div id="laborResult" class="result-box"></div></section></div><div class="card warn mt"><h3>Reminder</h3>${list(['Do not discount without changing scope or phasing.','Do not skip contingency on complex work.','Do not send price until scope, assumptions, exclusions, and decision path are clear.'])}</div>`;
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
    <strong style="color:#4ade80">Est. commission (~7%):</strong> <span style="color:#4ade80">${money(estComm)}</span>
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
window.calcLabor = function(){ const h=Number(document.getElementById('hours').value||0), r=Number(document.getElementById('rate').value||0); document.getElementById('laborResult').innerHTML = h&&r ? `<strong>Labor line:</strong> ${money(h*r)}<br><span>${h} hours × ${money(r)}/hr</span>` : 'Enter labor hours and rate.'; }
function money(n){ return n.toLocaleString(undefined,{style:'currency',currency:'USD',maximumFractionDigits:0}); }

function academy(){
  const onboardingPath = [
    "Read Sections 1–4 to understand the Avalon sales system.",
    "Shadow one intake call, one discovery call, one site walk, and one proposal review.",
    "Complete the stage checklists using a real or sample opportunity.",
    "Role-play discovery, budget discussion, proposal delivery, and objection handling.",
    "Build one sample scope and proposal with manager review.",
    "Own a low-complexity opportunity under supervision.",
    "Review first won/lost opportunities in weekly coaching."
  ];
  view.innerHTML = `
    <div class="eyebrow">Training Path</div>
    <h1>Avalon Sales Academy</h1>
    <p class="lede">Nine modules that turn the Avalon Sales Manual and 6-Step Process into real skill — onboarding, team training, and manager sign-off certification.</p>
    <div class="card mt" style="background:rgba(0,212,255,.06);border:1px solid rgba(0,212,255,.2)">
      <h3>New Hire Onboarding Path</h3>
      ${list(onboardingPath)}
    </div>
    <div class="grid grid-3 mt">
      ${data.modules.map(m=>{
        const num = parseInt(m.id.slice(1));
        return `<article class="card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
            <span class="badge">Module ${num}</span>
            <label class="check-item" style="margin:0"><input type="checkbox" data-key="module-${m.id}"><span style="font-size:.75rem">Complete</span></label>
          </div>
          <h3>${escapeHtml(m.title)}</h3>
          <p style="font-size:.85rem;color:var(--muted)">${escapeHtml(m.objective)}</p>
          ${m.keyPoints && m.keyPoints.length ? `<h4>Key Takeaways</h4>${list(m.keyPoints)}` : ''}
          <h4>Lessons</h4>${list(m.lessons)}
          <details style="margin-top:10px">
            <summary style="cursor:pointer;color:var(--accent);font-size:.85rem;font-weight:600">Quiz Questions</summary>
            ${list(m.quiz)}
          </details>
        </article>`;
      }).join('')}
    </div>
    <div class="card mt">
      <h3>Sales Manual — Quick Reference</h3>
      <div class="grid grid-2" style="gap:12px;margin-top:10px">
        <div>
          <h4>Core Sales Beliefs</h4>
          ${list(['A qualified no is better than a confusing maybe that burns estimating time.','Budget conversations protect the client and Avalon when handled professionally.','The best proposal is not the longest — it is the clearest decision tool.','Objections are not attacks — they are signals that something needs clarification.','A signed proposal is not a finished sale until the job is activated and ready for production.'])}
        </div>
        <div>
          <h4>Objection Handling Framework</h4>
          ${list(['1. Pause and acknowledge — do not defend immediately.','2. Clarify the real issue: price, scope, timing, trust, or decision process.','3. Reconnect to the client\'s Core Buying Reasons.','4. Offer a path: proceed, revise scope, phase, hold, or close out.','5. Confirm the next step and date.'])}
        </div>
      </div>
    </div>
  `;
  wireChecks();
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

  function divTile(div){
    const abovePlan = div.remaining <= 0;
    const gmOk = div.grossMarginPct >= div.grossMarginFloor;
    return `<article style="background:#0f172a;border:1px solid ${abovePlan?'#16a34a':'#1e293b'};border-radius:14px;padding:20px">
      <div style="font-size:22px;margin-bottom:6px">${div.icon} <span style="font-weight:700;font-size:1rem">${div.name}</span>
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
    ${_ia ? renderPermMatrix() : ''}
  `;
}

function renderPermMatrix() {
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
    { key: 'manager',     label: 'Manager Tools',      group: 'Admin' },
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

window._toggleNavPerm = function(role, viewKey, enabled) {
  const perms = loadNavPerms();
  if (!perms[role]) perms[role] = [...(DEFAULT_NAV_PERMS[role] || [])];
  if (enabled) {
    if (!perms[role].includes(viewKey)) perms[role].push(viewKey);
  } else {
    perms[role] = perms[role].filter(v => v !== viewKey);
  }
  saveNavPerms(perms);
  showToast('Permission updated');
};

window._resetNavPerms = function() {
  if (!confirm('Reset all permissions to defaults?')) return;
  localStorage.removeItem(NAV_PERMS_KEY);
  showToast('Permissions reset to defaults');
  show('settings');
};

window._applyPermPreset = function(role, preset) {
  const ALL_VIEWS = ['today','myDashboard','pipeline','lead','process','forms','scripts','templates','objections','calculator','academy','manager','integrations','settings'];
  const STANDARD  = ['today','myDashboard','pipeline','lead','process','forms','scripts','templates','objections','calculator','academy','settings'];
  const VIEW_ONLY = ['today','pipeline','settings'];
  let views;
  if (preset === 'full')     views = [...ALL_VIEWS];
  else if (preset === 'standard') views = [...STANDARD];
  else views = [...VIEW_ONLY];
  const perms = loadNavPerms();
  perms[role] = views;
  saveNavPerms(perms);
  const roleLabel = role === 'office_manager' ? 'Jen' : 'Ryan';
  const presetLabel = preset === 'full' ? 'Full Access' : preset === 'standard' ? 'Standard' : 'View Only';
  showToast(roleLabel + ' set to ' + presetLabel);
  show('settings');
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

menuBtn.addEventListener('click', () => sidebar.classList.toggle('open'));
document.addEventListener('click', e => {
  if (!sidebar.contains(e.target) && !menuBtn.contains(e.target)) sidebar.classList.remove('open');
});

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
    { key:'landscape',   label:'Landscape',   icon:'', color:'#4ade80' },
    { key:'maintenance', label:'Maintenance',  icon:'', color:'#22d3ee' },
    { key:'snow',        label:'Snow & Ice',   icon:'', color:'#a78bfa' }
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
    { key: 'landscape',   label: 'Landscape',    icon: '', color: '#4ade80' },
    { key: 'maintenance', label: 'Maintenance',   icon: '', color: '#22d3ee' },
    { key: 'snow',        label: 'Snow & Ice',    icon: '', color: '#a78bfa' }
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
