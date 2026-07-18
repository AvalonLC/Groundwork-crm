// ── Groundwork CRM — Onboarding Wizard ───────────────────────────────────────
// 6-step modal: welcome → business profile → first client → first estimate
//               → payment setup teaser → done/launch
// Triggered: first login after signup (onboarding_completed = 0)
// Version: 20260711p48
// ─────────────────────────────────────────────────────────────────────────────

/* ── Industry seed data ─────────────────────────────────────────────────────── */
const _onbSeeds = {
  landscaping: {
    services: ['Lawn Mowing','Mulching & Bed Cleanup','Aeration & Seeding','Fertilization','Hedge Trimming','Leaf Removal','Irrigation Check'],
    estimateTitle: 'Spring Lawn Care Package',
    pipelineLabel: 'Site Walk Scheduled',
    crewLabel: 'Crew',
    workOrderLabel: 'Work Order',
    estimateNote: 'Price includes labor and materials. Additional charges may apply for disposal of debris.',
    tipText: 'Pro tip: Set up recurring mowing schedules in the Recurring Plans section — clients love the predictability.',
  },
  excavation: {
    services: ['Site Clearing','Grading & Leveling','Trenching','Foundation Digging','Driveway Grading','Pond Excavation','Retaining Wall Prep'],
    estimateTitle: 'Site Preparation — Grading & Clear',
    pipelineLabel: 'Site Assessment',
    crewLabel: 'Crew',
    workOrderLabel: 'Job',
    estimateNote: 'Estimate includes equipment, operator, and standard disposal. Rock or debris removal billed separately.',
    tipText: 'Pro tip: Attach equipment hour logs to work orders for accurate job costing.',
  },
  hvac: {
    services: ['AC Tune-Up','Furnace Inspection','Duct Cleaning','Filter Replacement','Refrigerant Recharge','System Installation','Emergency Service'],
    estimateTitle: 'HVAC Maintenance Service Call',
    pipelineLabel: 'Diagnostic Scheduled',
    crewLabel: 'Technician',
    workOrderLabel: 'Service Call',
    estimateNote: 'Parts not included unless specified. Service call fee applies if no work is authorized.',
    tipText: 'Pro tip: Sell maintenance agreements — use Recurring Plans to auto-schedule seasonal tune-ups.',
  },
  plumbing: {
    services: ['Drain Cleaning','Water Heater Service','Leak Detection','Fixture Installation','Re-Pipe','Sewer Line Inspection','Emergency Call'],
    estimateTitle: 'Plumbing Service Estimate',
    pipelineLabel: 'Inspection Scheduled',
    crewLabel: 'Plumber',
    workOrderLabel: 'Service Call',
    estimateNote: 'Parts and materials billed at cost plus 20%. Emergency rates apply after hours.',
    tipText: 'Pro tip: Add "Service Plan" upsells on every invoice — annual agreements drive predictable revenue.',
  },
  electrical: {
    services: ['Panel Upgrade','Outlet Installation','Lighting Install','Surge Protection','EV Charger Install','Code Compliance Work','Emergency Service'],
    estimateTitle: 'Electrical Work Estimate',
    pipelineLabel: 'Assessment Scheduled',
    crewLabel: 'Electrician',
    workOrderLabel: 'Service Call',
    estimateNote: 'All work performed to NEC standards. Permit fees billed separately if required.',
    tipText: 'Pro tip: Track permit numbers in the Work Order notes field for quick reference.',
  },
  painting: {
    services: ['Interior Painting','Exterior Painting','Cabinet Refinishing','Deck Staining','Power Washing','Drywall Repair & Paint','Commercial Painting'],
    estimateTitle: 'Painting Estimate',
    pipelineLabel: 'Walkthrough Scheduled',
    crewLabel: 'Crew',
    workOrderLabel: 'Job',
    estimateNote: 'Price includes labor and standard paint. Customer-selected premium paints billed separately.',
    tipText: 'Pro tip: Take before/after photos on every job — attach them to the estimate for client review.',
  },
  cleaning: {
    services: ['Standard Cleaning','Deep Clean','Move-In/Move-Out','Post-Construction','Window Cleaning','Carpet Cleaning','Commercial Cleaning'],
    estimateTitle: 'Cleaning Service Estimate',
    pipelineLabel: 'Walkthrough Scheduled',
    crewLabel: 'Team',
    workOrderLabel: 'Service',
    estimateNote: 'Price includes all supplies and equipment. Specialty products billed at cost.',
    tipText: 'Pro tip: Recurring cleanings are your best retention tool — set them up in Recurring Plans.',
  },
  home_services: {
    services: ['Initial Consultation','Service Visit','Repair Work','Maintenance Check','Installation','Emergency Call','Follow-Up Visit'],
    estimateTitle: 'Service Estimate',
    pipelineLabel: 'Site Visit Scheduled',
    crewLabel: 'Technician',
    workOrderLabel: 'Work Order',
    estimateNote: 'Estimate valid for 30 days. Actual costs may vary based on conditions found on-site.',
    tipText: 'Pro tip: Use the Estimates module to send professional proposals — clients can accept online.',
  },
};

function _onbSeed(type) {
  return _onbSeeds[type] || _onbSeeds.home_services;
}

/* ── State ─────────────────────────────────────────────────────────────────── */
let _onbState = {
  step: 0,
  totalSteps: 6,
  companyName: '',
  businessType: 'home_services',
  ownerName: '',
  phone: '',
  address: '',
  city: '',
  state: '',
  clientName: '',
  clientEmail: '',
  clientPhone: '',
  estimateTitle: '',
  estimateValue: '',
  crewCount: 1,
  divisionCount: 1,
};

/* ── Entry: check and launch ──────────────────────────────────────────────────
   Call this after login. It fetches branding to check onboarding_completed.
   If company is new (onboarding_completed=0), shows the wizard.
   ─────────────────────────────────────────────────────────────────────────── */
window.gwCheckOnboarding = async function() {
  try {
    const res = await fetch('/api/company/branding', { credentials: 'include' });
    if (!res.ok) return;
    const _raw = await res.json();
    const co = (_raw && _raw.data) ? _raw.data : _raw;  // API wraps payload in {ok, data}
    // Only trigger for admin role and uncompleted onboarding
    const rep = window._d1SessionRep;
    if (!rep || rep.role !== 'admin') return;
    if (rep.company_id === 'groundwork_platform') return; // platform owner: no tenant onboarding
    // Treat missing field (undefined) as completed — only show for explicit 0
    if (co.onboarding_completed !== 0 || co.onboarding_step >= 6 || co.phone || co.address_line1) {
      // Wizard done (or existing account) → show Getting Started checklist launcher instead
      try { _gwGettingStartedInit(); } catch(e) {}
      return;
    }
    // Pre-fill state from existing company data
    _onbState.companyName   = co.name || '';
    _onbState.businessType  = co.business_type || 'home_services';
    _onbState.phone         = co.phone || '';
    _onbState.address       = co.address_line1 || '';
    _onbState.city          = co.address_city || '';
    _onbState.state         = co.address_state || '';
    _onbState.ownerName     = rep.name || '';
    _onbState.step          = co.onboarding_step || 0;
    // Load platform-defined custom questions (non-blocking)
    try {
      const cr = await fetch('/api/onboarding/wizard-config', { credentials: 'include' });
      if (cr.ok) {
        const cd = await cr.json();
        const list = (cd && cd.data) ? cd.data : cd;
        _onbState.customSteps = Array.isArray(list) ? list : [];
      }
    } catch(e) { _onbState.customSteps = []; }
    gwLaunchOnboarding();
  } catch(e) {
    console.warn('[Onboarding] Check failed:', e.message);
  }
};

window.gwLaunchOnboarding = function() {
  _onbShowStep(_onbState.step);
};

/* ── Overlay management ───────────────────────────────────────────────────── */
function _onbCreateOverlay() {
  document.getElementById('onb-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'onb-overlay';
  overlay.className = 'onb-overlay';
  return overlay;
}

/* ── Step router ──────────────────────────────────────────────────────────── */
function _onbShowStep(step) {
  _onbState.step = step;
  const overlay = _onbCreateOverlay();
  document.body.appendChild(overlay);

  const steps = [
    _onbStep0_Welcome,
    _onbStep1_BusinessProfile,
    _onbStep2_FirstClient,
    _onbStep3_FirstEstimate,
    _onbStep4_TeamSetup,
    _onbStep5_Done,
  ];

  const fn = steps[step] || _onbStep5_Done;
  overlay.innerHTML = fn();

  // Save progress to server (non-blocking)
  _onbSaveProgress(step);
}

async function _onbSaveProgress(step) {
  try {
    await fetch('/api/company/branding', {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ onboarding_step: step })
    });
  } catch(e) {}
}

function _onbProgressBar(step) {
  const pct = Math.round((step / (_onbState.totalSteps - 1)) * 100);
  return `<div class="onb-progress-track"><div class="onb-progress-fill" style="width:${pct}%"></div></div>
  <div class="onb-progress-label">Step ${step + 1} of ${_onbState.totalSteps}</div>`;
}

function _onbHeader(title, sub) {
  return `<div class="onb-header">
    <div class="onb-logo-mark">${gwIcon('home',18,'#fff')}</div>
    <div class="onb-header-text">
      <div class="onb-title">${title}</div>
      ${sub ? `<div class="onb-sub">${sub}</div>` : ''}
    </div>
  </div>`;
}

function _onbFooter(backStep, nextLabel, nextFn, skipFn) {
  return `<div class="onb-footer">
    ${backStep >= 0 ? `<button class="onb-btn-ghost" onclick="_onbShowStep(${backStep})">← Back</button>` : '<span></span>'}
    <div style="display:flex;gap:10px;align-items:center">
      ${skipFn ? `<button class="onb-btn-ghost" onclick="${skipFn}">Skip</button>` : ''}
      <button class="onb-btn-primary" onclick="${nextFn}">${nextLabel} →</button>
    </div>
  </div>`;
}

/* ── Step 0: Welcome ───────────────────────────────────────────────────────── */
function _onbStep0_Welcome() {
  const seed = _onbSeed(_onbState.businessType);
  return `<div class="onb-modal">
    ${_onbProgressBar(0)}
    <div class="onb-welcome-hero">
      <div class="onb-welcome-icon">${gwIcon('company',48,'#2D7A55')}</div>
      <h1 class="onb-welcome-title">Welcome to Groundwork${_onbState.companyName ? `, ${_onbState.companyName}` : ''}!</h1>
      <p class="onb-welcome-body">You're moments away from your first client, estimate, and invoice. Let's get your account set up — it takes about 3 minutes.</p>
    </div>
    <div class="onb-welcome-checklist">
      <div class="onb-check-item">${gwIcon('check-circle',18,'#2D7A55')} Set up your company profile</div>
      <div class="onb-check-item">${gwIcon('check-circle',18,'#2D7A55')} Add your first client</div>
      <div class="onb-check-item">${gwIcon('check-circle',18,'#2D7A55')} Send your first estimate</div>
      <div class="onb-check-item">${gwIcon('check-circle',18,'#2D7A55')} Configure your team</div>
    </div>
    <div class="onb-tip-box">${gwIcon('idea',16,'#8B6914')} ${seed.tipText}</div>
    ${_onbFooter(-1, "Let's Go", '_onbShowStep(1)')}
  </div>`;
}

/* ── Step 1: Business Profile ──────────────────────────────────────────────── */
function _onbStep1_BusinessProfile() {
  return `<div class="onb-modal">
    ${_onbProgressBar(1)}
    ${_onbHeader('Your Business Profile', 'This appears on estimates, invoices, and your client portal.')}
    <div class="onb-body">
      <div class="onb-field-group">
        <label class="onb-label">Company Name</label>
        <input class="onb-input" type="text" id="onbCompanyName" value="${_escOnb(_onbState.companyName)}" placeholder="Avalon Landscaping LLC">
      </div>
      <div class="onb-field-group">
        <label class="onb-label">Business Type</label>
        <select class="onb-select" id="onbBusinessType" onchange="_onbUpdateType()">
          <option value="landscaping"     ${_onbState.businessType==='landscaping'?'selected':''}>Landscaping & Lawn Care</option>
          <option value="excavation"      ${_onbState.businessType==='excavation'?'selected':''}>Excavation & Grading</option>
          <option value="hvac"            ${_onbState.businessType==='hvac'?'selected':''}>HVAC</option>
          <option value="plumbing"        ${_onbState.businessType==='plumbing'?'selected':''}>Plumbing</option>
          <option value="electrical"      ${_onbState.businessType==='electrical'?'selected':''}>Electrical</option>
          <option value="painting"        ${_onbState.businessType==='painting'?'selected':''}>Painting</option>
          <option value="cleaning"        ${_onbState.businessType==='cleaning'?'selected':''}>Cleaning Services</option>
          <option value="roofing"         ${_onbState.businessType==='roofing'?'selected':''}>Roofing</option>
          <option value="tree_service"    ${_onbState.businessType==='tree_service'?'selected':''}>Tree Service</option>
          <option value="pest_control"    ${_onbState.businessType==='pest_control'?'selected':''}>Pest Control</option>
          <option value="pool_service"    ${_onbState.businessType==='pool_service'?'selected':''}>Pool Service</option>
          <option value="home_services"   ${_onbState.businessType==='home_services'?'selected':''}>General Home Services</option>
        </select>
      </div>
      <div class="onb-row2">
        <div class="onb-field-group">
          <label class="onb-label">Phone Number</label>
          <input class="onb-input" type="tel" id="onbPhone" value="${_escOnb(_onbState.phone)}" placeholder="(703) 555-0100">
        </div>
        <div class="onb-field-group">
          <label class="onb-label">Your Name</label>
          <input class="onb-input" type="text" id="onbOwnerName" value="${_escOnb(_onbState.ownerName)}" placeholder="Tyler Smith">
        </div>
      </div>
      <div class="onb-field-group">
        <label class="onb-label">Business Address</label>
        <input class="onb-input" type="text" id="onbAddress" value="${_escOnb(_onbState.address)}" placeholder="123 Main St">
      </div>
      <div class="onb-row2">
        <div class="onb-field-group">
          <label class="onb-label">City</label>
          <input class="onb-input" type="text" id="onbCity" value="${_escOnb(_onbState.city)}" placeholder="Herndon">
        </div>
        <div class="onb-field-group">
          <label class="onb-label">State</label>
          <input class="onb-input" type="text" id="onbState" value="${_escOnb(_onbState.state)}" placeholder="VA" maxlength="2">
        </div>
      </div>
    </div>
    ${_onbFooter(0, 'Save & Continue', '_onbSaveStep1()')}
  </div>`;
}

window._onbUpdateType = function() {
  _onbState.businessType = document.getElementById('onbBusinessType')?.value || 'home_services';
};

window._onbSaveStep1 = async function() {
  _onbState.companyName  = document.getElementById('onbCompanyName')?.value?.trim() || _onbState.companyName;
  _onbState.businessType = document.getElementById('onbBusinessType')?.value || 'home_services';
  _onbState.phone        = document.getElementById('onbPhone')?.value?.trim() || '';
  _onbState.ownerName    = document.getElementById('onbOwnerName')?.value?.trim() || '';
  _onbState.address      = document.getElementById('onbAddress')?.value?.trim() || '';
  _onbState.city         = document.getElementById('onbCity')?.value?.trim() || '';
  _onbState.state        = document.getElementById('onbState')?.value?.trim() || '';

  if (!_onbState.companyName) { _onbFlash('Company name is required'); return; }

  // Save to D1
  try {
    await fetch('/api/company/branding', {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: _onbState.companyName,
        business_type: _onbState.businessType,
        phone: _onbState.phone,
        address_line1: _onbState.address,
        address_city: _onbState.city,
        address_state: _onbState.state,
        onboarding_step: 2
      })
    });
    // Update page title / company name display
    if (window._companyName !== undefined) window._companyName = _onbState.companyName;
    const kicker = document.getElementById('brandKicker');
    if (kicker) kicker.textContent = _onbState.companyName;
  } catch(e) {}
  _onbShowStep(2);
};

/* ── Step 2: First Client ──────────────────────────────────────────────────── */
function _onbStep2_FirstClient() {
  return `<div class="onb-modal">
    ${_onbProgressBar(2)}
    ${_onbHeader('Add Your First Client', 'You can import a full CSV list later — start with one to see how it works.')}
    <div class="onb-body">
      <div class="onb-field-group">
        <label class="onb-label">Client Name <span class="onb-required">*</span></label>
        <input class="onb-input" type="text" id="onbClientName" value="${_escOnb(_onbState.clientName)}" placeholder="Jane Smith" required>
      </div>
      <div class="onb-row2">
        <div class="onb-field-group">
          <label class="onb-label">Email</label>
          <input class="onb-input" type="email" id="onbClientEmail" value="${_escOnb(_onbState.clientEmail)}" placeholder="jane@example.com">
        </div>
        <div class="onb-field-group">
          <label class="onb-label">Phone</label>
          <input class="onb-input" type="tel" id="onbClientPhone" value="${_escOnb(_onbState.clientPhone)}" placeholder="(703) 555-0200">
        </div>
      </div>
      <div class="onb-info-box">
        ${gwIcon('info',14,'#5B7FA6')}
        <span>Already have a client list? After setup, go to <strong>Clients → Import CSV</strong> to bulk-import hundreds of clients at once.</span>
      </div>
    </div>
    ${_onbFooter(1, 'Add Client', '_onbSaveStep2()', '_onbShowStep(3)')}
  </div>`;
}

window._onbSaveStep2 = async function() {
  _onbState.clientName  = document.getElementById('onbClientName')?.value?.trim() || '';
  _onbState.clientEmail = document.getElementById('onbClientEmail')?.value?.trim() || '';
  _onbState.clientPhone = document.getElementById('onbClientPhone')?.value?.trim() || '';

  if (!_onbState.clientName) { _onbFlash('Client name is required'); return; }

  // Create client in D1
  try {
    const id = `cl_onb_${Date.now()}`;
    await fetch('/api/clients', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        name: _onbState.clientName,
        email: _onbState.clientEmail,
        phone: _onbState.clientPhone,
        type: 'Residential',
        status: 'Active',
      })
    });
    _onbState._clientId = id;
  } catch(e) {}
  _onbShowStep(3);
};

/* ── Step 3: First Estimate ───────────────────────────────────────────────── */
function _onbStep3_FirstEstimate() {
  const seed = _onbSeed(_onbState.businessType);
  return `<div class="onb-modal">
    ${_onbProgressBar(3)}
    ${_onbHeader('Create Your First Estimate', 'Send a professional proposal to your first client — takes 30 seconds.')}
    <div class="onb-body">
      <div class="onb-field-group">
        <label class="onb-label">Estimate Title</label>
        <input class="onb-input" type="text" id="onbEstTitle"
          value="${_escOnb(_onbState.estimateTitle || seed.estimateTitle)}"
          placeholder="${seed.estimateTitle}">
      </div>
      <div class="onb-field-group">
        <label class="onb-label">Estimated Value ($)</label>
        <input class="onb-input" type="number" id="onbEstValue"
          value="${_onbState.estimateValue || ''}" placeholder="1500" min="0" step="0.01">
      </div>
      <div class="onb-services-preview">
        <div class="onb-services-label">${gwIcon('list',13,'#6B7280')} Common ${_onbState.businessType.replace(/_/g,' ')} services:</div>
        <div class="onb-services-chips">
          ${seed.services.map(s => `<span class="onb-service-chip" onclick="_onbSetTitle('${s}')">${s}</span>`).join('')}
        </div>
      </div>
      <div class="onb-info-box">
        ${gwIcon('info',14,'#5B7FA6')}
        <span>Your client gets a link to view, accept, or request changes online. You'll be notified instantly.</span>
      </div>
    </div>
    ${_onbFooter(2, 'Create Estimate', '_onbSaveStep3()', '_onbShowStep(4)')}
  </div>`;
}

window._onbSetTitle = function(title) {
  const el = document.getElementById('onbEstTitle');
  if (el) { el.value = title; _onbState.estimateTitle = title; }
};

window._onbSaveStep3 = async function() {
  _onbState.estimateTitle = document.getElementById('onbEstTitle')?.value?.trim() || '';
  _onbState.estimateValue = document.getElementById('onbEstValue')?.value || '';

  if (!_onbState.estimateTitle) { _onbFlash('Estimate title is required'); return; }

  const total = parseFloat(_onbState.estimateValue) || 0;
  const seed = _onbSeed(_onbState.businessType);

  try {
    const id = `est_onb_${Date.now()}`;
    const portalToken = `onb_${Math.random().toString(36).slice(2)}${Date.now()}`;
    await fetch('/api/estimates', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        title: _onbState.estimateTitle,
        client_name: _onbState.clientName,
        client_email: _onbState.clientEmail,
        client_phone: _onbState.clientPhone,
        client_id: _onbState._clientId || '',
        status: 'draft',
        subtotal: total,
        total,
        balance_due: total,
        notes: seed.estimateNote,
        line_items: total > 0 ? [{
          description: _onbState.estimateTitle,
          qty: 1, unit_price: total, total
        }] : [],
        portal_token: portalToken,
        valid_until: new Date(Date.now() + 30*24*3600*1000).toISOString().split('T')[0],
      })
    });
    _onbState._estimateId = id;
  } catch(e) {}
  _onbShowStep(4);
};

/* ── Step 4: Team Setup ───────────────────────────────────────────────────── */
function _onbStep4_TeamSetup() {
  const seed = _onbSeed(_onbState.businessType);
  return `<div class="onb-modal">
    ${_onbProgressBar(4)}
    ${_onbHeader('Your Team', 'Tell us about the size of your operation — we\'ll configure Groundwork for you.')}
    <div class="onb-body">
      <div class="onb-row2">
        <div class="onb-field-group">
          <label class="onb-label">Number of ${seed.crewLabel}s</label>
          <select class="onb-select" id="onbCrewCount">
            ${[1,2,3,4,5,'6-10','10+'].map(n => `<option value="${n}" ${_onbState.crewCount==n?'selected':''}>${n} ${seed.crewLabel}${n!==1?'s':''}</option>`).join('')}
          </select>
        </div>
        <div class="onb-field-group">
          <label class="onb-label">Service Divisions</label>
          <select class="onb-select" id="onbDivisionCount">
            ${[1,2,3,4,5,'5+'].map(n => `<option value="${n}" ${_onbState.divisionCount==n?'selected':''}>${n} Division${n!==1?'s':''}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="onb-invite-note">
        <div class="onb-invite-title">${gwIcon('user-plus',16,'#2D7A55')} Invite Your Team</div>
        <p>After setup, go to <strong>Admin → User Management</strong> to invite your ${seed.crewLabel.toLowerCase()}s and office staff. They'll get an email with login instructions.</p>
      </div>
      <div class="onb-features-grid">
        <div class="onb-feature-card">
          ${gwIcon('schedule',20,'#2D7A55')}
          <div class="onb-feature-label">Schedule Board</div>
          <div class="onb-feature-sub">Drag & drop crew scheduling</div>
        </div>
        <div class="onb-feature-card">
          ${gwIcon('invoice',20,'#5B7FA6')}
          <div class="onb-feature-label">Invoices</div>
          <div class="onb-feature-sub">Send & collect payments</div>
        </div>
        <div class="onb-feature-card">
          ${gwIcon('repeat',20,'#8B6914')}
          <div class="onb-feature-label">Recurring Plans</div>
          <div class="onb-feature-sub">Auto-schedule repeat visits</div>
        </div>
        <div class="onb-feature-card">
          ${gwIcon('star',20,'#4D8A86')}
          <div class="onb-feature-label">Review Engine</div>
          <div class="onb-feature-sub">Auto-request Google reviews</div>
        </div>
      </div>
    </div>
    ${_onbFooter(3, 'Continue', '_onbSaveStep4()')}
  </div>`;
}

window._onbSaveStep4 = async function() {
  _onbState.crewCount     = document.getElementById('onbCrewCount')?.value || 1;
  _onbState.divisionCount = document.getElementById('onbDivisionCount')?.value || 1;
  try {
    await fetch('/api/company/branding', {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        crew_count:     parseInt(_onbState.crewCount) || 1,
        division_count: parseInt(_onbState.divisionCount) || 1,
        onboarding_step: 5
      })
    });
  } catch(e) {}
  // Platform-defined custom questions come before the Done screen (if any)
  const _cs = (_onbState.customSteps || []).filter(s => { try { return JSON.parse(s.fields||'[]').length > 0 } catch { return false } });
  if (_cs.length) _onbShowCustomStep(0);
  else _onbShowStep(5);
};

/* ── Custom question steps (defined in Platform Admin → Onboarding) ───────── */
function _onbShowCustomStep(idx) {
  const customs = (_onbState.customSteps || []).filter(s => { try { return JSON.parse(s.fields||'[]').length > 0 } catch { return false } });
  const step = customs[idx];
  if (!step) { _onbShowStep(5); return; }
  let questions = []; try { questions = JSON.parse(step.fields||'[]'); } catch {}

  const overlay = _onbCreateOverlay();
  document.body.appendChild(overlay);
  overlay.innerHTML = `<div class="onb-modal">
    ${_onbProgressBar(4)}
    ${_onbHeader(step.title || 'A few quick questions', step.description || 'This helps us tailor Groundwork to your business.')}
    <div class="onb-body">
      ${questions.map((q,i) => `
      <div class="onb-field-group" style="margin-bottom:14px">
        <label class="onb-label">${_escOnb(q.label||'')}</label>
        ${q.type === 'select'
          ? `<select class="onb-select" id="onbCQ_${i}"><option value="">Select…</option>${(q.options||[]).map(o=>`<option value="${_escOnb(o)}">${_escOnb(o)}</option>`).join('')}</select>`
          : `<input class="onb-input" id="onbCQ_${i}" placeholder="Your answer…">`}
      </div>`).join('')}
    </div>
    ${_onbFooter(4, idx < customs.length - 1 ? 'Continue' : 'Almost Done', `_onbSaveCustomStep(${idx})`, `_onbSkipCustomStep(${idx})`)}
  </div>`;
}

window._onbSaveCustomStep = async function(idx) {
  const customs = (_onbState.customSteps || []).filter(s => { try { return JSON.parse(s.fields||'[]').length > 0 } catch { return false } });
  const step = customs[idx];
  if (step) {
    let questions = []; try { questions = JSON.parse(step.fields||'[]'); } catch {}
    const answers = questions.map((q,i) => ({
      key: q.key || ('q'+(i+1)),
      question: q.label || '',
      answer: document.getElementById('onbCQ_'+i)?.value || ''
    })).filter(a => a.answer);
    if (answers.length) {
      try {
        await fetch('/api/onboarding/wizard-answers', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answers })
        });
      } catch(e) {}
    }
  }
  if (idx < customs.length - 1) _onbShowCustomStep(idx + 1);
  else _onbShowStep(5);
};
window._onbSkipCustomStep = function(idx) {
  const customs = (_onbState.customSteps || []).filter(s => { try { return JSON.parse(s.fields||'[]').length > 0 } catch { return false } });
  if (idx < customs.length - 1) _onbShowCustomStep(idx + 1);
  else _onbShowStep(5);
};

/* ── Step 5: Done / Launch ─────────────────────────────────────────────────── */
function _onbStep5_Done() {
  const seed = _onbSeed(_onbState.businessType);
  return `<div class="onb-modal onb-done-modal">
    ${_onbProgressBar(5)}
    <div class="onb-done-hero">
      <div class="onb-done-icon">${gwIcon('check-circle',64,'#2D7A55')}</div>
      <h1 class="onb-done-title">You're all set!</h1>
      <p class="onb-done-body">${_onbState.companyName || 'Your company'} is live on Groundwork. Here's what we set up for you:</p>
    </div>
    <div class="onb-done-summary">
      ${_onbState.clientName ? `<div class="onb-done-item">${gwIcon('user',16,'#2D7A55')} Client <strong>${_escOnb(_onbState.clientName)}</strong> added</div>` : ''}
      ${_onbState.estimateTitle ? `<div class="onb-done-item">${gwIcon('estimate',16,'#5B7FA6')} Estimate <strong>"${_escOnb(_onbState.estimateTitle)}"</strong> created as draft</div>` : ''}
      <div class="onb-done-item">${gwIcon('company',16,'#8B6914')} Company profile saved</div>
      <div class="onb-done-item">${gwIcon('check-circle',16,'#4D8A86')} Account ready for ${seed.crewLabel.toLowerCase()} invites</div>
    </div>
    <div class="onb-done-cta">
      <div class="onb-cta-title">What do you want to do first?</div>
      <div class="onb-cta-grid">
        <button class="onb-cta-card" onclick="_onbFinish('estimates')">
          ${gwIcon('estimate',24,'#2D7A55')}
          <div>View Estimates</div>
        </button>
        <button class="onb-cta-card" onclick="_onbFinish('clients')">
          ${gwIcon('user',24,'#5B7FA6')}
          <div>View Clients</div>
        </button>
        <button class="onb-cta-card" onclick="_onbFinish('invoices')">
          ${gwIcon('invoice',24,'#8B6914')}
          <div>View Invoices</div>
        </button>
        <button class="onb-cta-card" onclick="_onbFinish('gwDashboard')">
          ${gwIcon('home',24,'#4D8A86')}
          <div>Dashboard</div>
        </button>
      </div>
    </div>
  </div>`;
}

window._onbFinish = async function(view) {
  // Mark onboarding complete
  try {
    await fetch('/api/company/branding', {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ onboarding_completed: 1, onboarding_step: 6 })
    });
  } catch(e) {}
  document.getElementById('onb-overlay')?.remove();
  if (typeof show === 'function') show(view);
  // Hand off to the AI copilot: celebrate + surface the Getting Started launcher
  try {
    if (window.gwCopilot) window.gwCopilot.confetti(36);
    setTimeout(() => { try { _gwGettingStartedInit(); } catch(e) {} }, 1500);
  } catch(e) {}
};

/* ── Helpers ──────────────────────────────────────────────────────────────── */
function _onbFlash(msg) {
  // Show inline error
  let el = document.getElementById('onb-flash');
  if (!el) {
    el = document.createElement('div');
    el.id = 'onb-flash';
    el.className = 'onb-flash';
    const footer = document.querySelector('.onb-footer');
    if (footer) footer.parentNode.insertBefore(el, footer);
    else document.querySelector('.onb-body')?.appendChild(el);
  }
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { if (el) el.style.display = 'none'; }, 3000);
}

function _escOnb(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ── CSS ──────────────────────────────────────────────────────────────────── */
(function _onbInjectCSS() {
  if (document.getElementById('onb-styles')) return;
  const style = document.createElement('style');
  style.id = 'onb-styles';
  style.textContent = `
.onb-overlay { position:fixed;inset:0;background:rgba(13,35,24,.85);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px); }
.onb-modal { background:#fff;border-radius:20px;width:100%;max-width:520px;box-shadow:0 32px 100px rgba(0,0,0,.4);overflow:hidden;max-height:90vh;overflow-y:auto; }
.onb-done-modal { max-width:540px; }

/* Progress */
.onb-progress-track { height:4px;background:#E5E7EB;margin:0; }
.onb-progress-fill { height:100%;background:linear-gradient(90deg,#2D7A55,#4D8A86);transition:width .4s; }
.onb-progress-label { font-size:11px;color:#9CA3AF;text-align:right;padding:6px 20px 0;font-weight:600;letter-spacing:.04em; }

/* Header */
.onb-header { display:flex;align-items:center;gap:14px;padding:20px 24px 0; }
.onb-logo-mark { width:40px;height:40px;border-radius:10px;background:#2D7A55;display:flex;align-items:center;justify-content:center;flex-shrink:0; }
.onb-title { font-size:18px;font-weight:800;color:#1C3A2B;letter-spacing:-.02em; }
.onb-sub { font-size:13px;color:#6B7280;margin-top:2px; }

/* Welcome hero */
.onb-welcome-hero { text-align:center;padding:28px 24px 16px; }
.onb-welcome-icon { margin-bottom:14px; }
.onb-welcome-title { font-size:22px;font-weight:800;color:#1C3A2B;margin-bottom:10px;letter-spacing:-.02em; }
.onb-welcome-body { font-size:14px;color:#6B7280;line-height:1.6;max-width:380px;margin:0 auto; }
.onb-welcome-checklist { padding:0 24px 16px;display:flex;flex-direction:column;gap:10px; }
.onb-check-item { display:flex;align-items:center;gap:10px;font-size:14px;font-weight:600;color:#374151; }

/* Tip box */
.onb-tip-box { display:flex;align-items:flex-start;gap:10px;margin:0 24px 0;padding:14px;background:#FFFBEB;border:1.5px solid #FDE68A;border-radius:10px;font-size:13px;color:#92400E;line-height:1.5; }

/* Body */
.onb-body { padding:20px 24px; }
.onb-field-group { margin-bottom:14px; }
.onb-label { display:block;font-size:11px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px; }
.onb-required { color:#EF4444; }
.onb-input { width:100%;padding:10px 13px;border:1.5px solid #E5E7EB;border-radius:10px;font-size:14px;font-family:inherit;color:#111;outline:none;transition:border-color .15s; }
.onb-input:focus { border-color:#2D7A55;box-shadow:0 0 0 3px rgba(45,122,85,.1); }
.onb-select { width:100%;padding:10px 13px;border:1.5px solid #E5E7EB;border-radius:10px;font-size:14px;font-family:inherit;color:#111;background:#fff;outline:none; }
.onb-row2 { display:grid;grid-template-columns:1fr 1fr;gap:12px; }

/* Info box */
.onb-info-box { display:flex;align-items:flex-start;gap:10px;padding:12px;background:#EFF6FF;border:1.5px solid #BFDBFE;border-radius:10px;font-size:13px;color:#1E40AF;line-height:1.5;margin-top:4px; }

/* Services */
.onb-services-preview { margin-top:4px;margin-bottom:12px; }
.onb-services-label { display:flex;align-items:center;gap:6px;font-size:11px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px; }
.onb-services-chips { display:flex;flex-wrap:wrap;gap:6px; }
.onb-service-chip { padding:4px 12px;background:#F0FAF4;border:1.5px solid #A7D7BC;border-radius:20px;font-size:12px;font-weight:600;color:#1C3A2B;cursor:pointer;transition:background .15s; }
.onb-service-chip:hover { background:#2D7A55;color:#fff;border-color:#2D7A55; }

/* Team invite note */
.onb-invite-note { padding:14px;background:#F0FAF4;border:1.5px solid #A7D7BC;border-radius:10px;font-size:13px;color:#1C3A2B;line-height:1.6;margin-bottom:16px; }
.onb-invite-title { display:flex;align-items:center;gap:8px;font-weight:700;margin-bottom:6px; }

/* Features grid */
.onb-features-grid { display:grid;grid-template-columns:1fr 1fr;gap:10px; }
.onb-feature-card { display:flex;flex-direction:column;align-items:center;gap:6px;padding:14px 12px;background:#F9FAFB;border:1.5px solid #E5E7EB;border-radius:12px;text-align:center; }
.onb-feature-label { font-size:12px;font-weight:700;color:#374151; }
.onb-feature-sub { font-size:11px;color:#9CA3AF; }

/* Done */
.onb-done-hero { text-align:center;padding:32px 24px 16px; }
.onb-done-icon { margin-bottom:14px; }
.onb-done-title { font-size:26px;font-weight:800;color:#1C3A2B;margin-bottom:8px; }
.onb-done-body { font-size:14px;color:#6B7280;line-height:1.6; }
.onb-done-summary { padding:0 24px 16px;display:flex;flex-direction:column;gap:8px; }
.onb-done-item { display:flex;align-items:center;gap:10px;font-size:14px;color:#374151;padding:8px 12px;background:#F9FAFB;border-radius:8px; }
.onb-done-cta { padding:0 24px 24px; }
.onb-cta-title { font-size:13px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px; }
.onb-cta-grid { display:grid;grid-template-columns:1fr 1fr;gap:10px; }
.onb-cta-card { display:flex;flex-direction:column;align-items:center;gap:8px;padding:16px 12px;background:#fff;border:2px solid #E5E7EB;border-radius:14px;cursor:pointer;font-size:13px;font-weight:700;color:#374151;transition:all .15s;font-family:inherit; }
.onb-cta-card:hover { border-color:#2D7A55;background:#F0FAF4;color:#1C3A2B; }

/* Footer */
.onb-footer { display:flex;align-items:center;justify-content:space-between;padding:16px 24px;border-top:1.5px solid #F3F4F6;gap:12px; }
.onb-btn-primary { display:inline-flex;align-items:center;gap:6px;padding:11px 20px;background:#2D7A55;color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;transition:background .15s; }
.onb-btn-primary:hover { background:#256645; }
.onb-btn-ghost { display:inline-flex;align-items:center;gap:6px;padding:11px 16px;background:transparent;color:#6B7280;border:1.5px solid #E5E7EB;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit; }
.onb-btn-ghost:hover { border-color:#9CA3AF;color:#374151; }

/* Flash */
.onb-flash { background:#FEE2E2;color:#991B1B;border-radius:8px;padding:10px 14px;font-size:13px;margin:0 24px 12px;display:none; }

@media(max-width:480px) {
  .onb-row2 { grid-template-columns:1fr; }
  .onb-cta-grid { grid-template-columns:1fr 1fr; }
  .onb-features-grid { grid-template-columns:1fr 1fr; }
}
`;
  document.head.appendChild(style);
})();

/* ── Getting Started checklist (platform-defined, floating launcher) ─────────
Shown to tenant admins after the wizard until every item is done (or dismissed
for the session). Items auto-detect via /api/onboarding/checklist. ────────── */
async function _gwGettingStartedInit() {
  if (window._gwGSDismissed || document.getElementById('gwGSLauncher')) return;
  if (sessionStorage.getItem('gwGSDismissed')) return;
  let data;
  try {
    const r = await fetch('/api/onboarding/checklist', { credentials: 'include' });
    if (!r.ok) return;
    const raw = await r.json();
    data = (raw && raw.data) ? raw.data : raw;
  } catch(e) { return; }
  if (!data || !Array.isArray(data.items) || !data.items.length) return;
  if (data.done >= data.total) return; // all done — stay hidden forever

  const btn = document.createElement('button');
  btn.id = 'gwGSLauncher';
  btn.innerHTML = `🚀 Getting Started <span style="background:#fff;color:#2D7A55;border-radius:10px;padding:1px 8px;font-size:11px;font-weight:800;margin-left:6px">${data.done}/${data.total}</span>`;
  btn.style.cssText = 'position:fixed;bottom:22px;right:22px;z-index:8000;background:#2D7A55;color:#fff;border:none;border-radius:26px;padding:12px 20px;font-size:13.5px;font-weight:800;cursor:pointer;box-shadow:0 6px 24px rgba(29,58,43,.35);font-family:inherit;display:flex;align-items:center;transition:transform .15s';
  btn.onmouseover = () => btn.style.transform = 'translateY(-2px)';
  btn.onmouseout = () => btn.style.transform = '';
  btn.onclick = () => _gwGSOpenPanel();
  document.body.appendChild(btn);
}

async function _gwGSOpenPanel() {
  document.getElementById('gwGSPanel')?.remove();
  let data;
  try {
    const r = await fetch('/api/onboarding/checklist', { credentials: 'include' });
    const raw = await r.json();
    data = (raw && raw.data) ? raw.data : raw;
  } catch(e) { return; }
  const items = (data && data.items) || [];
  const pct = data.total ? Math.round(data.done / data.total * 100) : 0;

  const panel = document.createElement('div');
  panel.id = 'gwGSPanel';
  panel.style.cssText = 'position:fixed;bottom:80px;right:22px;z-index:8001;width:min(380px,calc(100vw - 44px));background:#fff;border:1.5px solid #E5E7EB;border-radius:18px;box-shadow:0 16px 48px rgba(0,0,0,.18);overflow:hidden;font-family:inherit';
  panel.innerHTML = `
  <div style="background:linear-gradient(135deg,#1C3A2B,#2D7A55);padding:18px 20px;color:#fff">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div style="font-size:15px;font-weight:800">Getting Started</div>
      <div style="display:flex;gap:8px;align-items:center">
        <button onclick="window._gwGSDismiss()" title="Hide for this session" style="background:rgba(255,255,255,.15);border:none;color:#fff;font-size:11px;font-weight:700;padding:4px 10px;border-radius:8px;cursor:pointer">Hide</button>
        <button onclick="document.getElementById('gwGSPanel').remove()" style="background:none;border:none;color:#fff;font-size:18px;cursor:pointer;line-height:1">✕</button>
      </div>
    </div>
    <div style="margin-top:10px;height:7px;background:rgba(255,255,255,.2);border-radius:4px;overflow:hidden"><div style="height:100%;width:${pct}%;background:#fff;border-radius:4px"></div></div>
    <div style="font-size:12px;margin-top:6px;opacity:.9">${data.done} of ${data.total} complete — ${pct}%</div>
  </div>
  <div style="max-height:340px;overflow-y:auto">
    ${items.map(it => {
      const hasTour = window.gwCopilot && window.gwCopilot.TOURS && window.gwCopilot.TOURS[it.id];
      return `
    <div style="display:flex;align-items:flex-start;gap:12px;padding:13px 18px;border-bottom:1px solid #F3F4F6;${it.done?'opacity:.55':''}">
      <div style="width:20px;height:20px;border-radius:50%;flex-shrink:0;margin-top:1px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;${it.done?'background:#2D7A55;color:#fff':'border:2px solid #D1D5DB;color:transparent'}">✓</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13.5px;font-weight:700;color:#1F2937;${it.done?'text-decoration:line-through':''}">${_escOnb(it.title)}</div>
        <div style="font-size:11.5px;color:#6B7280;margin-top:2px">${_escOnb(it.description||'')}</div>
      </div>
      ${!it.done ? `<div style="display:flex;flex-direction:column;gap:5px;flex-shrink:0;align-items:stretch">
        ${hasTour ? `<button onclick="document.getElementById('gwGSPanel').remove();window.gwCopilot.startTour('${_escOnb(it.id)}')" style="background:#2D7A55;border:none;color:#fff;font-size:11px;font-weight:800;padding:6px 12px;border-radius:9px;cursor:pointer;font-family:inherit;white-space:nowrap">✨ Show me</button>` : ''}
        ${it.view ? `<button onclick="document.getElementById('gwGSPanel').remove();if(typeof show==='function')show('${_escOnb(it.view)}')" style="background:#F0FAF4;border:1.5px solid #2D7A5533;color:#2D7A55;font-size:11px;font-weight:800;padding:6px 12px;border-radius:9px;cursor:pointer;font-family:inherit;white-space:nowrap">${_escOnb(it.cta||'Open')}</button>` : ''}
      </div>` : ''}
    </div>`;}).join('')}
  </div>
  ${window.gwCopilot ? `<div style="padding:11px 16px;background:#F7F9F7;border-top:1px solid #EDEDE8">
    <button onclick="document.getElementById('gwGSPanel').remove();window.gwCopilot.openChat()" style="width:100%;display:flex;align-items:center;justify-content:center;gap:8px;background:linear-gradient(135deg,#1C3A2B,#2D7A55);border:none;color:#fff;font-size:12.5px;font-weight:800;padding:11px;border-radius:11px;cursor:pointer;font-family:inherit">✨ Ask Groundwork AI — I'll walk you through it</button>
  </div>` : ''}`;
  document.body.appendChild(panel);
}

window._gwGSDismiss = function() {
  window._gwGSDismissed = true;
  try { sessionStorage.setItem('gwGSDismissed', '1'); } catch(e) {}
  document.getElementById('gwGSPanel')?.remove();
  document.getElementById('gwGSLauncher')?.remove();
};
window.gwGettingStarted = _gwGSOpenPanel;

console.log('[Groundwork] onboarding.js loaded v20260718t26');
