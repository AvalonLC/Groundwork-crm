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
  admin: ['today','myDashboard','pipeline','lead','process','forms','scripts','templates','objections','calculator','academy','manager','integrations','settings'],
  office_manager: ['today','myDashboard','pipeline','lead','process','forms','scripts','templates','objections','calculator','academy','manager','integrations','settings'],
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
  const perms = loadNavPerms();
  const allowed = perms[rep.role] || DEFAULT_NAV_PERMS[rep.role] || [];
  return allowed.includes(viewName);
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
function showToast(message){ toastEl.textContent = message; toastEl.hidden = false; setTimeout(()=>toastEl.hidden=true, 2200); }
function copyText(text){ navigator.clipboard?.writeText(text).then(()=>showToast('Copied to clipboard')).catch(()=>showToast('Select and copy manually')); }
function show(viewName='today', param){
  // ── Permission gate (admin-configurable) ─────────────────
  if (viewName !== 'settings' && !canViewTab(viewName)) {
    const _rep = window.getCurrentRep ? window.getCurrentRep() : null;
    const _viewLabels = {today:'Today',myDashboard:'My Dashboard',pipeline:'Pipeline',lead:'Add Lead',process:'Sales Process',forms:'Forms & Checklists',scripts:'Scripts',templates:'Email Templates',objections:'Objection Handling',calculator:'Pricing Tools',academy:'Sales Academy',manager:'Manager Tools',integrations:'Integrations',settings:'Settings'};
    view.innerHTML = `<div style="text-align:center;padding:64px 24px;margin-top:40px">
      <div style="font-size:52px;margin-bottom:18px">🔒</div>
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
  const routes = {today, pipeline, lead, process, forms, scripts, templates, objections, calculator, academy, manager, settings, ...intRoute, ...repRoute};
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
  const open = state.opportunities.filter(o=>!['Sold / Activation','Closed Lost'].includes(o.status)).length;
  const proposals = state.opportunities.filter(o=>o.status==='Proposal Sent' || o.status==='Follow-Up').length;
  const overdue = state.opportunities.filter(o=>o.nextFollowUp && o.nextFollowUp < todayISO() && !['Sold / Activation','Closed Lost'].includes(o.status)).length;
  const sold = state.opportunities.filter(o=>o.status==='Sold / Activation').length;
  return `<div class="grid grid-4 stat-grid">
    <article class="stat"><span>Open</span><strong>${open}</strong></article>
    <article class="stat"><span>Proposals</span><strong>${proposals}</strong></article>
    <article class="stat ${overdue?'bad':''}"><span>Overdue</span><strong>${overdue}</strong></article>
    <article class="stat"><span>Sold</span><strong>${sold}</strong></article>
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
            <button class="secondary-btn small" onclick="show('manager')">Manager Review</button>
            <button class="secondary-btn small" onclick="show('academy')">Training Path</button>
          </div>
        </aside>
      </div>
    </div>`;
  view.innerHTML = `${_heroBlock}
    ${statCards()}
    <div class="grid grid-2 mt">
      <section class="card app-card">
        <div class="section-head"><h2>Due Now</h2>${badge(`${due.length} follow-up${due.length===1?'':'s'}`, due.length?'warn-badge':'')}</div>
        ${due.length ? due.map(oppCard).join('') : empty('No follow-ups due today. Review the pipeline or add next steps.')}
      </section>
      <section class="card app-card">
        <h2>Daily Sales Start-Up</h2>
        ${renderChecklist(data.checklists.find(c=>c.id==='daily'), true)}
      </section>
    </div>
    <div class="grid grid-2 mt">
      <section class="card"><h2>Coming Up</h2>${next.length ? next.map(oppMini).join('') : empty('No future follow-ups scheduled.')}</section>
      <section class="card"><h2>Recently Updated</h2>${recent.length ? recent.map(oppMini).join('') : empty('No opportunities yet. Add your first lead.')}</section>
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

function empty(text){ return `<div class="empty">${escapeHtml(text)}</div>`; }
function oppMini(o){ return `<button class="mini-row" onclick="show('pipeline','${o.id}')"><strong>${escapeHtml(o.client||'Unnamed')}</strong><span>${escapeHtml(o.status||'New Lead')}</span><em>${escapeHtml(o.project||o.serviceLine||'Opportunity')}</em></button>`; }
function oppCard(o){
  return `<article class="opp-card">
    <div><h3>${escapeHtml(o.client||'Unnamed Lead')}</h3><p>${escapeHtml(o.project||o.serviceLine||'Opportunity')} • ${escapeHtml(o.address||'No address')}</p></div>
    <div class="opp-meta">${badge(o.status||'New Lead')}<span>Next: ${prettyDate(o.nextFollowUp)}</span></div>
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

  const filters = data.statuses;
  const grouped = filters.map(status => ({status, items: opps.filter(o=>o.status===status)})).filter(g=>g.items.length || ['New Lead','Contacted','Discovery Scheduled','Proposal / Estimate Sent','Follow-Up','Sold / Activation'].includes(g.status));

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
        <button class="tab ${activeTypeFilter==='Residential'?'active':''}" onclick="window._pipelineTypeFilter='Residential';show('pipeline')">🏡 Residential</button>
        <button class="tab ${activeTypeFilter==='Commercial'?'active':''}" onclick="window._pipelineTypeFilter='Commercial';show('pipeline')">🏢 Commercial</button>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <span style="font-size:12px;color:var(--muted);align-self:center">Work:</span>
        <button class="tab ${activeCatFilter==='all'?'active':''}" onclick="window._pipelineCatFilter='all';show('pipeline')">All Work</button>
        <button class="tab ${activeCatFilter==='landscape'?'active':''}" onclick="window._pipelineCatFilter='landscape';show('pipeline')">🌿 Landscape</button>
        <button class="tab ${activeCatFilter==='maintenance'?'active':''}" onclick="window._pipelineCatFilter='maintenance';show('pipeline')">✂️ Maintenance</button>
        <button class="tab ${activeCatFilter==='snow'?'active':''}" onclick="window._pipelineCatFilter='snow';show('pipeline')">❄️ Snow & Ice</button>
      </div>
    </div>
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
  view.innerHTML = `
    <div class="eyebrow">Stage 1</div>
    <h1>Lead Intake</h1>
    <p class="lede">Capture enough information to route the opportunity correctly and set the right next step.</p>
    <form class="card form" id="leadForm">
      <div class="form-grid">
        ${input('client','Client Name',true)}
        ${input('phone','Phone')}
        ${input('email','Email','email')}
        ${input('address','Property Address')}
        ${select('clientType','Client Type',['Residential','Commercial'])}
        ${select('projectCategory','Project Category',['Landscape / Enhancement','Maintenance - One Time','Maintenance - Recurring','Hardscape','Drainage','Design / Build','Irrigation','Outdoor Lighting','Other'])}
        ${select('serviceLine','Service Line',data.serviceLines)}
        ${select('source','Lead Source',data.leadSources)}
        ${select('leadSource','Commission Lead Source',['company_lead','self_generated','assisted'],'company_lead')}
        ${select('workType','Work Type (commission)',['landscape','maintenance_onetime','maintenance_recurring','maintenance_upsell','hardscape','drainage','design_build'],'landscape')}
        ${input('jobValue','Estimated Job Value ($)','number')}

        ${input('project','Project / Opportunity Name')}
        ${input('urgency','Urgency / Timing')}
        ${input('decisionMaker','Decision-Maker(s)')}
        ${input('budget','Budget language / range')}
        ${input('nextFollowUp','Next Follow-Up Date','date')}
        ${select('status','Status',data.statuses, 'New Lead')}
        ${(()=>{
          const _cr = window.getCurrentRep ? window.getCurrentRep() : null;
          const _ia = _cr && (_cr.role === 'admin' || _cr.role === 'office_manager');
          if (!_ia) return `<input type="hidden" name="repId" value="${_cr ? _cr.id : ''}">`;
          return `<label><span>Assigned Rep</span><select name="repId">
            <option value="">— Select rep —</option>
            ${(window.REPS||[]).map(r=>`<option value="${r.id}">${r.avatar} ${r.name}</option>`).join('')}
          </select></label>`;
        })()}
      </div>
      ${textarea('prompt','What prompted the inquiry?')}
      ${textarea('desiredOutcome','Desired outcome / what good looks like')}
      ${textarea('fitConcerns','Fit concerns / risk flags')}
      <div class="footer-actions"><button class="primary-btn" type="submit">Save Lead</button><button type="button" class="secondary-btn" onclick="show('forms','lead-intake')">Open Intake Checklist</button></div>
    </form>
  `;
  document.getElementById('leadForm').addEventListener('submit', e=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    const opp = Object.fromEntries(fd.entries());
    opp.id = uid('opp'); opp.createdAt = new Date().toISOString(); opp.updatedAt = opp.createdAt;
    if(!opp.status) opp.status = 'New Lead';
    if(!opp.repId && currentRep) opp.repId = currentRep.id;
    state.opportunities.unshift(opp); saveState(); showToast('Lead saved'); show('pipeline', opp.id);
  });
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
    <div class="detail-head">
      <div><div class="eyebrow">Opportunity</div><h1>${escapeHtml(o.client||'Unnamed Lead')}</h1><p class="lede">${escapeHtml(o.project||o.serviceLine||'Opportunity')} • ${escapeHtml(o.address||'No address')}</p></div>
      <div class="detail-actions">
        <button class="primary-btn" onclick="saveOpportunity('${o.id}')">Save Changes</button>
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
      <section class="card"><h2>Opportunity Notes</h2><div id="noteList">${renderNotes(o.id)}</div><textarea id="newNote" rows="4" placeholder="Add call note, site note, objection, or next step..."></textarea><button class="primary-btn mt8" onclick="addNote('${o.id}')">Add Note</button></section>
      <section class="card"><h2>Useful Tools</h2><div class="tool-list"><button onclick="show('forms','discovery')">Discovery Planner</button><button onclick="show('forms','site-walk')">Site Walk Checklist</button><button onclick="show('forms','proposal-review')">Proposal Review</button><button onclick="show('templates')">Follow-Up Templates</button><button onclick="show('objections')">Objection Handling</button><button onclick="show('forms','handoff')">Sold Job Activation</button></div></section>
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
              <span style="font-size:13px">${_ca.commissionApproved ? '✅ Approved' : '⏳ Pending approval'}</span>
            </label>
          </div>` : `
          <div style="opacity:.5">
            <label style="display:block;font-size:12px;color:#64748b;margin-bottom:6px">Commission Approved</label>
            <span style="font-size:12px;color:#64748b">🔒 Tyler (Owner) only</span>
          </div>`;
      const _borderColor = _isAdm ? '#00d4ff' : '#f59e0b';
      const _panelTitle  = _isAdm ? '🔑 Admin Controls <span style="font-size:11px;font-weight:400;color:#64748b;margin-left:6px">Tyler Only</span>' : '📋 Office Controls <span style="font-size:11px;font-weight:400;color:#64748b;margin-left:6px">Jen — Sales Ops</span>';
      return `<section class="card" style="border:2px solid ${_borderColor}">
        <h2>${_panelTitle}</h2>
        <div class="grid grid-3" style="gap:12px;margin-top:12px">
          ${_commApprovedHtml}
          <div>
            <label style="display:block;font-size:12px;color:#64748b;margin-bottom:6px">Payment Collected</label>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <input type="checkbox" id="payCollected" ${_ca.collected?'checked':''} onchange="setOppField('${o.id}','collected',this.checked);showToast('Collection status updated')">
              <span style="font-size:13px">${_ca.collected ? '✅ Collected' : '⏳ Outstanding'}</span>
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
          💡 Commission is paid only after both "Commission Approved" and "Payment Collected" are checked. Commission approval is Tyler's decision only. Jen can mark payment collected and reassign reps.
        </div>
      </section>`;
    })()}
    </div>
    <div class="mt">
      <section class="card" style="border:1px solid #1e4d6b">
        <h2>🔗 Quick Actions — Integrations</h2>
        <p style="font-size:13px;color:var(--muted);margin-bottom:14px">Push this lead to your CRM or create a Google Calendar event or Gmail draft instantly.</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          <button class="secondary-btn" onclick="intPushOppToHomeworks('${o.id}')">🏡 Push to Homeworks CRM</button>
          <button class="secondary-btn" onclick="intScheduleForLead('${escapeHtml(o.client||'Lead')}','${escapeHtml(o.email||'')}','${escapeHtml(o.nextFollowUp||'')}')">📅 Schedule in Google Calendar</button>
          <button class="secondary-btn" onclick="intComposeToLead('${escapeHtml(o.email||'')}','${escapeHtml(o.client||'')}')">📧 Gmail Compose</button>
        </div>
        <p style="font-size:11px;color:var(--muted);margin-top:12px">Not connected yet? Go to <button class="link-btn" onclick="show('integrations')" style="color:var(--accent);background:none;border:none;cursor:pointer;font-size:11px;padding:0">🔗 Integrations</button> to set up.</p>
      </section>
    </div>
  `;
}
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
function renderNotes(oppId){ const notes = state.notes.filter(n=>n.oppId===oppId); return notes.length ? notes.map(n=>`<article class="note"><time>${new Date(n.createdAt).toLocaleString()}</time><p>${nl2br(n.body)}</p></article>`).join('') : empty('No notes yet.'); }

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
    <div class="grid grid-3 mt">${data.stages.map(s=>`<article class="card clickable" onclick="show('process',${s.id})">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        <div class="stage-number">${s.id}</div>
        ${s.processStep ? `<span class="badge" style="font-size:.7rem;background:rgba(0,212,255,.12);color:#00d4ff">${escapeHtml(s.processStep)}</span>` : ''}
      </div>
      <h3>${escapeHtml(s.title)}</h3>
      <p style="font-size:.85rem">${escapeHtml(s.purpose)}</p>
      <p class="meta"><strong>Owner:</strong> ${escapeHtml(s.owner)}</p>
    </article>`).join('')}</div>
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
    <div class="card danger mt"><h3>🚩 Red Flags — Do Not Advance Until Resolved</h3>${list(s.redFlags)}</div>
    ${stageChecklist ? `<div class="card mt"><h3>✅ ${escapeHtml(stageChecklist.title)}</h3>${renderChecklist(stageChecklist, true)}</div>` : ''}
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
  <div class="grid grid-2">${stageChecklists.map(c=>`<article class="card"><h3>${escapeHtml(c.title)}</h3><p class="muted small-text">Stage ${c.stage}</p>${renderChecklist(c,true)}</article>`).join('')}</div>
  <h2 class="mt">Daily & Weekly Tools</h2>
  <div class="grid grid-2">${utilChecklists.map(c=>`<article class="card"><h3>${escapeHtml(c.title)}</h3>${renderChecklist(c,true)}</article>`).join('')}</div>`;
  wireChecks();
}
function renderFormTool(f){
  const stageChecklist = (data.checklists||[]).find(c=>c.stage===f.stage);
  const fieldLabels = f.fields.map(x=>x.label);
  view.innerHTML = `<button class="secondary-btn" onclick="show('forms')">← Back to Forms</button><div class="eyebrow">Daily Tool · Stage ${f.stage||'—'}</div><h1>${escapeHtml(f.title)}</h1><div class="grid grid-2 mt"><section class="card"><h2>Fields to Capture</h2>${list(fieldLabels)}<button class="secondary-btn mt8" onclick="copyText('${escapeForJs(fieldLabels.map(x=>'- '+x+':').join('\n'))}')">Copy Field Template</button></section><section class="card"><h2>${stageChecklist ? escapeHtml(stageChecklist.title) : 'Stage Checklist'}</h2>${stageChecklist ? renderChecklist(stageChecklist, true) : '<p class="muted">No checklist for this stage.</p>'}</section></div><section class="card mt"><h2>Copy-Ready Working Note</h2><div class="script-box">${nl2br(fieldLabels.map(x=>`${x}:`).join('\n\n'))}</div><button class="primary-btn mt8" onclick="copyText('${escapeForJs(fieldLabels.map(x=>x+':').join('\n\n'))}')">Copy Note Template</button></section>`;
  wireChecks();
}
function escapeForJs(str){ return String(str).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/\n/g,'\\n'); }
function renderChecklist(c, persist=false){ return `<div class="checklist">${c.items.map((item,i)=>{ const key=`check-${c.id}-${i}`; return `<label class="check-item"><input type="checkbox" ${persist?`data-key="${key}"`:''}><span>${escapeHtml(item)}</span></label>`; }).join('')}</div>`; }
function wireChecks(){ document.querySelectorAll('.check-item input[data-key]').forEach(cb=>{ cb.checked = localStorage.getItem(cb.dataset.key)==='true'; cb.addEventListener('change',()=>localStorage.setItem(cb.dataset.key, cb.checked)); }); }

function scripts(){
  const cats = ['All', ...new Set(data.scripts.map(s=>s.category))];
  view.innerHTML = `<div class="eyebrow">Talk Tracks</div><h1>Scripts Library</h1><p class="lede">Use these as flexible language. Keep the intent, adapt the words, and sound human.</p><div class="tabs">${cats.map((c,i)=>`<button class="tab ${i===0?'active':''}" data-cat="${c}">${escapeHtml(c)}</button>`).join('')}</div><div id="scriptList" class="grid grid-2"></div>`;
  const box = document.getElementById('scriptList');
  function render(cat='All'){ box.innerHTML = data.scripts.filter(s=>cat==='All'||s.category===cat).map(s=>`<article class="card"><span class="badge">${escapeHtml(s.category)}</span><h3>${escapeHtml(s.title)}</h3><div class="script-box">${nl2br(s.body)}</div><button class="secondary-btn mt8" onclick="copyText('${escapeForJs(s.body)}')">Copy Script</button></article>`).join(''); }
  render();
  document.querySelector('.tabs').addEventListener('click',e=>{ if(!e.target.matches('.tab')) return; document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active')); e.target.classList.add('active'); render(e.target.dataset.cat); });
}
function templates(){
  const cats = ['All', ...new Set(data.templates.map(t=>t.category))];
  view.innerHTML = `<div class="eyebrow">Copy-Ready Communication</div><h1>Email Templates</h1><p class="lede">Templates for daily sales communication. Copy, personalize, and send through Gmail or your CRM.</p><div class="tabs">${cats.map((c,i)=>`<button class="tab ${i===0?'active':''}" data-cat="${c}">${escapeHtml(c)}</button>`).join('')}</div><div id="templateList" class="grid grid-2"></div>`;
  const box = document.getElementById('templateList');
  function render(cat='All'){ box.innerHTML = data.templates.filter(t=>cat==='All'||t.category===cat).map(t=>`<article class="card"><span class="badge">${escapeHtml(t.category)}</span><h3>${escapeHtml(t.title)}</h3><p><strong>Subject:</strong> ${escapeHtml(t.subject)}</p><div class="script-box">${nl2br(t.body)}</div><div class="footer-actions"><button class="secondary-btn" onclick="copyText('${escapeForJs(t.subject)}')">Copy Subject</button><button class="primary-btn" onclick="copyText('${escapeForJs(t.body)}')">Copy Body</button></div></article>`).join(''); }
  render();
  document.querySelector('.tabs').addEventListener('click',e=>{ if(!e.target.matches('.tab')) return; document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active')); e.target.classList.add('active'); render(e.target.dataset.cat); });
}
function objections(){
  view.innerHTML = `<div class="eyebrow">Decision Management</div><h1>Objection Handling</h1><p class="lede">Do not argue. Clarify, reconnect to the buying reason, protect scope quality, and guide the client toward a clear decision.</p><div class="grid grid-2 mt">${data.objections.map(o=>`<article class="card"><h3>${escapeHtml(o.title)}</h3><p class="muted"><strong>What it may mean:</strong> ${escapeHtml(o.meaning)}</p><h4>How to respond</h4>${list(o.response)}<h4>Say this</h4><div class="script-box">${escapeHtml(o.say)}</div><button class="secondary-btn mt8" onclick="copyText('${escapeForJs(o.say)}')">Copy Response</button></article>`).join('')}</div>`;
}

function calculator(){
  view.innerHTML = `<div class="eyebrow">Quick Pricing Checks</div><h1>Pricing Tools</h1><p class="lede">Use these for quick internal checks only. Final pricing should still follow Avalon estimating and margin review standards.</p><div class="grid grid-2 mt"><section class="card form"><h2>Margin Calculator</h2><label><span>Estimated Cost</span><input id="cost" type="number" min="0" step="0.01" placeholder="Materials + labor + subs + overhead"></label><label><span>Target Gross Margin %</span><input id="margin" type="number" min="1" max="95" step="1" value="45"></label><button class="primary-btn" onclick="calcMargin()">Calculate Price</button><div id="marginResult" class="result-box"></div></section><section class="card form"><h2>Labor Revenue Check</h2><label><span>Labor Hours</span><input id="hours" type="number" min="0" step="0.5"></label><label><span>Hourly Billing / Internal Rate</span><input id="rate" type="number" min="0" step="1" value="75"></label><button class="primary-btn" onclick="calcLabor()">Calculate Labor Line</button><div id="laborResult" class="result-box"></div></section></div><div class="card warn mt"><h3>Reminder</h3>${list(['Do not discount without changing scope or phasing.','Do not skip contingency on complex work.','Do not send price until scope, assumptions, exclusions, and decision path are clear.'])}</div>`;
}
window.calcMargin = function(){ const cost=Number(document.getElementById('cost').value||0); const m=Number(document.getElementById('margin').value||0)/100; if(!cost||!m||m>=1){ document.getElementById('marginResult').innerHTML='Enter valid cost and margin.'; return;} const price=cost/(1-m); const gp=price-cost; document.getElementById('marginResult').innerHTML=`<strong>Suggested sales price:</strong> ${money(price)}<br><strong>Gross profit:</strong> ${money(gp)}<br><strong>Markup on cost:</strong> ${Math.round((price/cost-1)*100)}%`; }
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
      <h3>📋 New Hire Onboarding Path</h3>
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
      <h3>📚 Sales Manual — Quick Reference</h3>
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
  const fy = data.fy2026;
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

  const monthRows = fy.monthlyBudget.map(m => {
    const hasActual = m.actual != null;
    const varSign = m.variance > 0 ? '+' : '';
    const varColor = m.variance == null ? '#334155' : m.variance >= 0 ? '#4ade80' : '#f87171';
    return `<tr style="border-bottom:1px solid #0f172a">
      <td style="padding:8px 10px;color:#e2e8f0;font-weight:600">${m.month}</td>
      <td style="padding:8px 10px;text-align:right">${fmtM(m.budgeted)}</td>
      <td style="padding:8px 10px;text-align:right;color:${hasActual?'#00d4ff':'#334155'}">${hasActual ? fmtM(m.actual) : '\u2014'}</td>
      <td style="padding:8px 10px;text-align:right;color:${varColor}">${m.variance != null ? varSign+fmtM(m.variance) : '\u2014'}</td>
    </tr>`;
  }).join('');

  view.innerHTML = `
    <div class="eyebrow">Leadership Rhythm \u2014 FY2026</div>
    <h1>Manager Tools <span style="font-size:13px;color:#64748b;font-weight:400;margin-left:8px">${escapeHtml(fy.budgetVersion)}</span>${(()=>{ const _cr = window.getCurrentRep ? window.getCurrentRep() : null; return (_cr && _cr.role === 'office_manager') ? '<span style="font-size:12px;color:#f59e0b;font-weight:400;margin-left:10px;vertical-align:middle;background:#f59e0b18;border:1px solid #f59e0b40;border-radius:8px;padding:2px 8px">📋 Office Manager View — Read Only</span>' : ''; })()}</h1>
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
        <div style="font-size:10px;color:#64748b">Jun \u2013 Dec (${annual.monthsLeft} months)</div>
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

    <h2 class="mt" style="font-size:1rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)">Division P&amp;L \u2014 Actual vs Target</h2>
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

    <div class="card mt">
      <h2>\ud83d\udcc5 Monthly Revenue \u2014 Budget vs Actual (Jan\u2013Dec 2026)</h2>
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
      <h2>📥 Import</h2>
      <p>Restore a JSON backup from this same app. <strong style="color:#f87171">Admin only.</strong></p>
      <input id="importFile" type="file" accept="application/json">
      <button class="secondary-btn mt8" onclick="importJson()">Import Backup</button>
    </section>
    <section class="card" style="border:1px solid #7f1d1d">
      <h2>⚠️ Reset All Data</h2>
      <p>Clears all opportunities, notes, and checklist progress on this browser. <strong style="color:#f87171">Admin only — cannot be undone.</strong></p>
      <button class="danger-btn" onclick="resetAll()">Reset All Local Data</button>
    </section>` : _iom ? `
    <section class="card" style="background:#0a0f1a;border:1px solid #f59e0b30;opacity:.75">
      <h2>🔒 Import / Reset</h2>
      <p class="muted">Import and data reset are restricted to Tyler (Owner / Admin). Contact Tyler if a data restore is needed.</p>
    </section>` : `
    <section class="card" style="background:#0a0f1a;border:1px solid #1e293b;opacity:.6">
      <h2>🔒 Import / Reset</h2>
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
        <h2>📤 Export</h2>
        <p>Download your local pipeline, notes, and settings.</p>
        <div class="footer-actions">
          <button class="primary-btn" onclick="exportJson()">Download JSON Backup</button>
          <button class="secondary-btn" onclick="exportCsv()">Download Pipeline CSV</button>
        </div>
      </section>
      ${adminSections}
      <section class="card">
        <h2>ℹ️ App Notes</h2>
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
    { key: 'today',       label: '🏠 Today',              group: 'Home' },
    { key: 'myDashboard', label: '👤 My Dashboard',       group: 'Home' },
    { key: 'pipeline',    label: '📊 Pipeline',           group: 'Pipeline' },
    { key: 'lead',        label: '➕ Add Lead',           group: 'Pipeline' },
    { key: 'process',     label: '📋 Sales Process',      group: 'Sales Toolkit' },
    { key: 'forms',       label: '📝 Forms & Checklists', group: 'Sales Toolkit' },
    { key: 'scripts',     label: '💬 Scripts',            group: 'Sales Toolkit' },
    { key: 'templates',   label: '📧 Email Templates',    group: 'Sales Toolkit' },
    { key: 'objections',  label: '🛡️ Objection Handling', group: 'Sales Toolkit' },
    { key: 'calculator',  label: '🧮 Pricing Tools',      group: 'Sales Toolkit' },
    { key: 'academy',     label: '🎓 Sales Academy',      group: 'Learning' },
    { key: 'manager',     label: '👔 Manager Tools',      group: 'Admin' },
    { key: 'integrations',label: '🔗 Integrations',       group: 'Admin' },
    { key: 'settings',    label: '⚙️ Settings',           group: 'Admin' }
  ];

  const groups = [...new Set(views.map(v => v.group))];

  const tableRows = groups.map(group => {
    const groupViews = views.filter(v => v.group === group);
    return `
      <tr><td colspan="${roles.length + 1}" style="padding:14px 12px 4px;font-size:10px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:#475569;border-bottom:1px solid #1e293b">${group}</td></tr>
      ${groupViews.map(v => `
      <tr style="border-bottom:1px solid #0f172a">
        <td style="padding:10px 12px;font-size:13px;color:#e2e8f0;white-space:nowrap">${v.label}</td>
        ${roles.map(r => {
          const checked = (perms[r.key] || DEFAULT_NAV_PERMS[r.key] || []).includes(v.key);
          const isAdminView = v.key === 'settings';
          return `<td style="text-align:center;padding:10px">
            <input type="checkbox" ${checked ? 'checked' : ''} ${isAdminView ? 'disabled title="Settings always visible"' : ''}
              onchange="window._toggleNavPerm('${r.key}','${v.key}',this.checked)"
              style="width:16px;height:16px;accent-color:${r.color};cursor:${isAdminView ? 'not-allowed' : 'pointer'}">
          </td>`;
        }).join('')}
      </tr>`).join('')}
    `;
  }).join('');

  return `
  <section class="card" style="margin-top:20px;border:1px solid #334155">
    <h2>🔐 Permission Controls <span style="font-size:13px;color:#64748b;font-weight:400;margin-left:8px">— Tyler (Owner) only</span></h2>
    <p style="color:#64748b;font-size:13px;margin-bottom:16px">Control which sections each role can access. Changes take effect immediately. Tyler (Owner) always has full access.</p>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;min-width:480px">
        <thead>
          <tr style="border-bottom:2px solid #1e293b">
            <th style="text-align:left;padding:10px 12px;font-size:12px;color:#64748b;font-weight:700">Section</th>
            ${roles.map(r => `<th style="text-align:center;padding:10px 12px;font-size:12px;font-weight:700;color:${r.color}">${r.label}</th>`).join('')}
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
    <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap">
      <button class="secondary-btn" style="font-size:12px" onclick="window._resetNavPerms()">↺ Reset to Defaults</button>
      <span style="font-size:11px;color:#475569;align-self:center">Changes save instantly. Reps see the lock screen when they try to access a restricted tab.</span>
    </div>
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
function exportJson(){ const blob = new Blob([JSON.stringify(state,null,2)],{type:'application/json'}); downloadBlob(blob,`avalon-sales-hub-backup-${todayISO()}.json`); }
function exportCsv(){ const headers=['client','phone','email','address','serviceLine','source','project','urgency','decisionMaker','budget','status','nextFollowUp','createdAt','updatedAt']; const rows=state.opportunities.map(o=>headers.map(h=>`"${String(o[h]||'').replace(/"/g,'""')}"`).join(',')); downloadBlob(new Blob([[headers.join(','),...rows].join('\n')],{type:'text/csv'}),`avalon-pipeline-${todayISO()}.csv`); }
function downloadBlob(blob,filename){ const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename; a.click(); URL.revokeObjectURL(a.href); }
function importJson(){ const file=document.getElementById('importFile').files[0]; if(!file) return showToast('Choose a JSON file first'); const reader=new FileReader(); reader.onload=()=>{ try{ state={...DEFAULT_STATE,...JSON.parse(reader.result)}; saveState(); showToast('Imported'); show('today'); }catch(e){ showToast('Import failed'); } }; reader.readAsText(file); }
function resetAll(){ if(!confirm('Reset all local Sales Hub data and checklist progress?')) return; localStorage.clear(); state=structuredClone(DEFAULT_STATE); saveState(); showToast('Reset complete'); show('today'); }

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

show('today');
