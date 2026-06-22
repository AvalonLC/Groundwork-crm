const data = window.AVALON_DATA;
const view = document.getElementById('view');
const navItems = [...document.querySelectorAll('.nav-item')];
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
  navItems.forEach(b=>b.classList.toggle('active', b.dataset.view===viewName));
  sidebar.classList.remove('open');
  const routes = {today, pipeline, lead, process, forms, scripts, templates, objections, calculator, academy, manager, settings};
  (routes[viewName] || today)(param);
  window.scrollTo({top:0, behavior:'smooth'});
}
window.show = show;

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
  const due = state.opportunities
    .filter(o=>o.nextFollowUp && o.nextFollowUp <= todayISO() && !['Sold / Activation','Closed Lost'].includes(o.status))
    .sort((a,b)=>a.nextFollowUp.localeCompare(b.nextFollowUp));
  const next = state.opportunities
    .filter(o=>o.nextFollowUp && o.nextFollowUp > todayISO() && !['Sold / Activation','Closed Lost'].includes(o.status))
    .sort((a,b)=>a.nextFollowUp.localeCompare(b.nextFollowUp)).slice(0,5);
  const recent = [...state.opportunities].sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||'')).slice(0,5);
  view.innerHTML = `
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
    </div>
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
  `;
  wireChecks();
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
  const filters = data.statuses;
  const grouped = filters.map(status => ({status, items: state.opportunities.filter(o=>o.status===status)})).filter(g=>g.items.length || ['New Lead','Discovery Scheduled','Proposal Sent','Follow-Up','Sold / Activation'].includes(g.status));
  view.innerHTML = `
    <div class="hero pipeline-hero">
      <div class="eyebrow">Day-to-Day Sales Tracker</div>
      <h1>Pipeline</h1>
      <p class="lede">Track leads from first inquiry through proposal, follow-up, and sold-job activation. This local prototype can be exported anytime from Settings.</p>
      <div class="quick-actions"><button class="primary-btn" onclick="show('lead')">+ Add Lead</button><button class="secondary-btn" onclick="exportCsv()">Export CSV</button><button class="secondary-btn" onclick="show('forms','follow-up')">Follow-Up Cadence</button></div>
    </div>
    ${statCards()}
    <div class="kanban mt">
      ${grouped.map(g=>`<section class="kanban-col"><h3>${escapeHtml(g.status)} <span>${g.items.length}</span></h3>${g.items.length ? g.items.map(oppCard).join('') : '<p class="muted small-text">No items</p>'}</section>`).join('')}
    </div>
  `;
}

function lead(){
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
        ${select('serviceLine','Service Line',data.serviceLines)}
        ${select('source','Lead Source',data.leadSources)}
        ${input('project','Project / Opportunity Name')}
        ${input('urgency','Urgency / Timing')}
        ${input('decisionMaker','Decision-Maker(s)')}
        ${input('budget','Budget language / range')}
        ${input('nextFollowUp','Next Follow-Up Date','date')}
        ${select('status','Status',data.statuses, 'New Lead')}
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
      <div class="detail-actions"><button class="primary-btn" onclick="saveOpportunity('${o.id}')">Save Changes</button><button class="secondary-btn" onclick="duplicateOpportunity('${o.id}')">Duplicate</button><button class="danger-btn" onclick="deleteOpportunity('${o.id}')">Delete</button></div>
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
  view.innerHTML = `
    <div class="eyebrow">Operating System</div><h1>12-Stage Sales Process</h1><p class="lede">Each stage has a purpose, owner, required artifact, gate, and red flags. Use this to know when an opportunity is truly ready to move forward.</p>
    <div class="grid grid-3 mt">${data.stages.map(s=>`<article class="card clickable" onclick="show('process',${s.id})"><div class="stage-number">${s.id}</div><h3>${escapeHtml(s.title)}</h3><p>${escapeHtml(s.purpose)}</p><p class="meta"><strong>Owner:</strong> ${escapeHtml(s.owner)}</p></article>`).join('')}</div>
  `;
}
function renderStage(s){
  view.innerHTML = `
    <button class="secondary-btn" onclick="show('process')">← Back to all stages</button>
    <h1><span class="stage-number">${s.id}</span> ${escapeHtml(s.title)}</h1><p class="lede">${escapeHtml(s.purpose)}</p>
    <div class="grid grid-2 mt"><div class="card"><h3>Owner</h3><p>${escapeHtml(s.owner)}</p></div><div class="card"><h3>Gate to Next Stage</h3><p>${escapeHtml(s.gate)}</p></div></div>
    <div class="grid grid-2 mt"><div class="card"><h3>What to Do</h3>${list(s.actions)}</div><div class="card"><h3>Required Artifact</h3><p>${escapeHtml(s.artifact)}</p><h3>Day-to-Day Use</h3><p>${escapeHtml(s.dayUse)}</p></div></div>
    <div class="card danger mt"><h3>Red Flags</h3>${list(s.redFlags)}</div>
    <div class="footer-actions">${s.id>1?`<button class="secondary-btn" onclick="show('process',${s.id-1})">Previous Stage</button>`:''}${s.id<12?`<button class="primary-btn" onclick="show('process',${s.id+1})">Next Stage</button>`:''}</div>`;
}

function forms(formId){
  if(formId){ const f = data.forms.find(x=>x.id===formId); if(f) return renderFormTool(f); }
  view.innerHTML = `<div class="eyebrow">Field Tools</div><h1>Forms & Checklists</h1><p class="lede">These are the reusable day-to-day tools your team should open before calls, site visits, proposal reviews, follow-up, sold-job activation, and closeout.</p><div class="grid grid-3 mt">${data.forms.map(f=>`<article class="card clickable" onclick="show('forms','${f.id}')"><span class="badge">Tool</span><h3>${escapeHtml(f.title)}</h3><p>${escapeHtml(f.when)}</p></article>`).join('')}</div><h2>Recurring Team Checklists</h2><div class="grid grid-2">${data.checklists.map(c=>`<article class="card"><h3>${escapeHtml(c.title)}</h3>${renderChecklist(c,true)}</article>`).join('')}</div>`;
  wireChecks();
}
function renderFormTool(f){
  view.innerHTML = `<button class="secondary-btn" onclick="show('forms')">← Back to Forms</button><div class="eyebrow">Daily Tool</div><h1>${escapeHtml(f.title)}</h1><p class="lede"><strong>When to use:</strong> ${escapeHtml(f.when)}</p><div class="grid grid-2 mt"><section class="card"><h2>Fields to Capture</h2>${list(f.fields)}<button class="secondary-btn" onclick="copyText('${escapeForJs(f.fields.map(x=>'- '+x+':').join('\n'))}')">Copy Field Template</button></section><section class="card"><h2>Completion Checklist</h2>${renderChecklist({id:f.id,items:f.checklist},true)}</section></div><section class="card mt"><h2>Copy-Ready Working Note</h2><div class="script-box">${nl2br(f.fields.map(x=>`${x}:`).join('\n\n'))}</div><button class="primary-btn mt8" onclick="copyText('${escapeForJs(f.fields.map(x=>x+':').join('\n\n'))}')">Copy Note Template</button></section>`;
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
  view.innerHTML = `<div class="eyebrow">Training Path</div><h1>Avalon Sales Academy</h1><p class="lede">Nine modules that turn the manual into onboarding, team training, and manager sign-off.</p><div class="grid grid-3 mt">${data.modules.map(m=>`<article class="card"><span class="badge">Module ${escapeHtml(m.id.slice(1))}</span><h3>${escapeHtml(m.title)}</h3><p>${escapeHtml(m.objective)}</p><h4>Lessons</h4>${list(m.lessons)}<h4>Quick Quiz</h4>${list(m.quiz)}<label class="check-item"><input type="checkbox" data-key="module-${m.id}"><span>Mark module complete</span></label></article>`).join('')}</div>`;
  wireChecks();
}
function manager(){
  view.innerHTML = `<div class="eyebrow">Leadership Rhythm</div><h1>Manager Tools</h1><p class="lede">Inspect process weekly, not just revenue monthly. Use these tools to coach behavior, not just outcomes.</p>${statCards()}<div class="grid grid-2 mt"><article class="card"><h2>Weekly Sales Meeting Agenda</h2>${list(data.managerAgenda)}</article><article class="card"><h2>Sales KPIs</h2>${list(data.kpis)}</article><article class="card"><h2>Stuck Deal Questions</h2>${list(['What stage is this opportunity actually in?','What is the client’s core buying reason?','Who decides, and have we spoken with them?','What objection is real vs vague?','What is the next yes/no/adjust decision?','What date is the next follow-up?'])}</article><article class="card"><h2>Non-Negotiables</h2>${list(data.nonNegotiables)}</article><article class="card"><h2>Lost Job Debrief</h2>${list(['What did the client choose instead?','Was the issue budget, trust, timing, scope, or fit?','Did we understand the decision process?','Did we follow up properly?','What should change in training, pricing, or process?'])}</article><article class="card"><h2>Production Feedback Review</h2>${list(['What did sales miss?','What did estimating miss?','Where did labor exceed expectation?','Where was the client confused?','What should become a new checklist item?'])}</article></div>`;
}
function settings(){
  view.innerHTML = `<div class="eyebrow">Data and Setup</div><h1>Export / Settings</h1><p class="lede">This static prototype saves data locally in the browser. Export data regularly, especially before moving devices or clearing browser storage.</p><div class="grid grid-2 mt"><section class="card"><h2>Export</h2><p>Download your local pipeline, notes, and settings.</p><div class="footer-actions"><button class="primary-btn" onclick="exportJson()">Download JSON Backup</button><button class="secondary-btn" onclick="exportCsv()">Download Pipeline CSV</button></div></section><section class="card"><h2>Import</h2><p>Restore a JSON backup from this same app.</p><input id="importFile" type="file" accept="application/json"><button class="secondary-btn mt8" onclick="importJson()">Import Backup</button></section><section class="card"><h2>Reset</h2><p>This clears local opportunities, notes, and checklist progress on this browser only.</p><button class="danger-btn" onclick="resetAll()">Reset All Local Data</button></section><section class="card"><h2>App Notes</h2>${list(['Open index.html in a browser.','Use the Install button when available for app-style access.','To share with the team, host the folder on an internal site or migrate into Softr/Notion/Trainual.','For shared manager visibility, connect a future version to Airtable, Google Sheets, or a CRM.'])}</section></div>`;
}
function exportJson(){ const blob = new Blob([JSON.stringify(state,null,2)],{type:'application/json'}); downloadBlob(blob,`avalon-sales-hub-backup-${todayISO()}.json`); }
function exportCsv(){ const headers=['client','phone','email','address','serviceLine','source','project','urgency','decisionMaker','budget','status','nextFollowUp','createdAt','updatedAt']; const rows=state.opportunities.map(o=>headers.map(h=>`"${String(o[h]||'').replace(/"/g,'""')}"`).join(',')); downloadBlob(new Blob([[headers.join(','),...rows].join('\n')],{type:'text/csv'}),`avalon-pipeline-${todayISO()}.csv`); }
function downloadBlob(blob,filename){ const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename; a.click(); URL.revokeObjectURL(a.href); }
function importJson(){ const file=document.getElementById('importFile').files[0]; if(!file) return showToast('Choose a JSON file first'); const reader=new FileReader(); reader.onload=()=>{ try{ state={...DEFAULT_STATE,...JSON.parse(reader.result)}; saveState(); showToast('Imported'); show('today'); }catch(e){ showToast('Import failed'); } }; reader.readAsText(file); }
function resetAll(){ if(!confirm('Reset all local Sales Hub data and checklist progress?')) return; localStorage.clear(); state=structuredClone(DEFAULT_STATE); saveState(); showToast('Reset complete'); show('today'); }

function buildSearchIndex(){
  const items=[];
  data.stages.forEach(s=>items.push({type:'Stage',title:`${s.id}. ${s.title}`,text:[s.purpose,s.owner,s.artifact,s.gate,s.dayUse,...s.actions,...s.redFlags].join(' '),action:()=>show('process',s.id)}));
  data.forms.forEach(f=>items.push({type:'Form',title:f.title,text:[f.when,...f.fields,...f.checklist].join(' '),action:()=>show('forms',f.id)}));
  data.scripts.forEach(s=>items.push({type:s.category,title:s.title,text:s.body,action:()=>show('scripts')}));
  data.templates.forEach(t=>items.push({type:`Template: ${t.category}`,title:t.title,text:[t.subject,t.body].join(' '),action:()=>show('templates')}));
  data.objections.forEach(o=>items.push({type:'Objection',title:o.title,text:[o.meaning,o.say,...o.response].join(' '),action:()=>show('objections')}));
  data.modules.forEach(m=>items.push({type:'Training',title:m.title,text:[m.objective,...m.lessons,...m.quiz].join(' '),action:()=>show('academy')}));
  data.checklists.forEach(c=>items.push({type:'Checklist',title:c.title,text:c.items.join(' '),action:()=>show('forms')}));
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
