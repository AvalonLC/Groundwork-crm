/**
 * Avalon Sales Hub — Integrations Module
 * Google Workspace (Gmail, Calendar, Drive) + Homeworks/CopilotCRM (Zapier webhook)
 *
 * ARCHITECTURE:
 *  - Google OAuth2: popup flow → access token stored in localStorage (BYOK — user supplies Client ID)
 *  - Homeworks CRM: Zapier Webhook URL (user pastes their Zapier webhook URL)
 *  - All secrets stay client-side in localStorage (no server storage needed for this pattern)
 *
 * USER SETUP REQUIRED:
 *  1. Google: Create OAuth2 Client ID at console.cloud.google.com
 *  2. Homeworks: Create Zapier Zap with "Webhook" trigger, paste the webhook URL here
 */

// ── Storage keys ──────────────────────────────────────────────────────────────
const INT_KEY = 'avalonIntegrationsV1';

// Pre-configured defaults (baked in at build time)
const INT_DEFAULTS = {
  zapierWebhookUrl: 'https://hooks.zapier.com/hooks/catch/26716050/422r11e/',
  googleClientId: '523041652927-q3aq6i98knrr10kf956rposcvacvmdlf.apps.googleusercontent.com'
};

function loadIntState() {
  try {
    const stored = JSON.parse(localStorage.getItem(INT_KEY)) || {};
    // Merge defaults so pre-configured values are available on first load
    return { ...INT_DEFAULTS, ...stored };
  }
  catch(e) { return { ...INT_DEFAULTS }; }
}
function saveIntState(patch) {
  const cur = loadIntState();
  localStorage.setItem(INT_KEY, JSON.stringify({ ...cur, ...patch }));
}
function getIntState(key) { return loadIntState()[key]; }

// Bootstrap: write defaults to localStorage on first load so everything works immediately
(function bootstrapDefaults() {
  const stored = JSON.parse(localStorage.getItem(INT_KEY) || '{}');
  const needsBootstrap = Object.keys(INT_DEFAULTS).some(k => !stored[k]);
  if (needsBootstrap) {
    localStorage.setItem(INT_KEY, JSON.stringify({ ...INT_DEFAULTS, ...stored }));
  }
})();

// ── Google OAuth2 ─────────────────────────────────────────────────────────────
// Scopes: Gmail read/compose, Calendar read/write, Drive read
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'email', 'profile'
].join(' ');

function getGoogleToken() { return getIntState('googleToken'); }
function getGoogleExpiry() { return getIntState('googleExpiry') || 0; }
function isGoogleConnected() { return !!getGoogleToken() && Date.now() < getGoogleExpiry(); }
function getGoogleClientId() { return getIntState('googleClientId') || ''; }
function getGoogleUserEmail() { return getIntState('googleEmail') || ''; }

async function googleOAuthConnect() {
  const clientId = getGoogleClientId();
  if (!clientId) {
    showIntToast('⚠️ Paste your Google Client ID first (see setup guide)', 'warn');
    return false;
  }
  const redirectUri = `${location.origin}/auth/google/callback`;
  const state = Math.random().toString(36).slice(2);
  const nonce = Math.random().toString(36).slice(2);
  saveIntState({ googleOAuthState: state });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'token',
    scope: GOOGLE_SCOPES,
    state,
    include_granted_scopes: 'true',
    prompt: 'select_account'
  });
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  const popup = window.open(authUrl, 'googleAuth', 'width=520,height=620,left=200,top=100');
  if (!popup) {
    showIntToast('Popup blocked — please allow popups for this site', 'warn');
    return false;
  }

  return new Promise((resolve) => {
    const timer = setInterval(async () => {
      try {
        if (popup.closed) {
          clearInterval(timer);
          resolve(isGoogleConnected());
          return;
        }
        const hash = popup.location.hash;
        if (hash && hash.includes('access_token')) {
          const hp = new URLSearchParams(hash.slice(1));
          const token = hp.get('access_token');
          const expiresIn = parseInt(hp.get('expires_in') || '3600', 10);
          if (token) {
            popup.close();
            clearInterval(timer);
            saveIntState({
              googleToken: token,
              googleExpiry: Date.now() + expiresIn * 1000
            });
            // Fetch user email
            try {
              const r = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
                headers: { Authorization: `Bearer ${token}` }
              });
              const u = await r.json();
              saveIntState({ googleEmail: u.email || '' });
            } catch(_) {}
            showIntToast('✅ Google connected!', 'success');
            resolve(true);
          }
        }
      } catch(_) { /* cross-origin until redirect */ }
    }, 300);
    // Timeout after 3 minutes
    setTimeout(() => { clearInterval(timer); popup.closed || popup.close(); resolve(false); }, 180000);
  });
}

function googleDisconnect() {
  saveIntState({ googleToken: null, googleExpiry: 0, googleEmail: '' });
  showIntToast('Google disconnected');
}

// ── Google API helpers ────────────────────────────────────────────────────────
async function gFetch(url, options = {}) {
  const token = getGoogleToken();
  if (!token) throw new Error('Not connected to Google');
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (res.status === 401) {
    googleDisconnect();
    throw new Error('Google session expired — please reconnect');
  }
  return res;
}

// ── Gmail ─────────────────────────────────────────────────────────────────────
async function gmailListThreads(maxResults = 10) {
  const r = await gFetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads?maxResults=${maxResults}&labelIds=INBOX`);
  return r.json();
}

async function gmailGetThread(id) {
  const r = await gFetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`);
  return r.json();
}

async function gmailSendEmail({ to, subject, body, replyToMessageId }) {
  const fromEmail = getGoogleUserEmail();
  let rawEmail = `From: ${fromEmail}\r\nTo: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${body}`;
  if (replyToMessageId) rawEmail += `\r\nIn-Reply-To: ${replyToMessageId}`;
  const encoded = btoa(rawEmail).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const payload = { raw: encoded };
  if (replyToMessageId) payload.threadId = replyToMessageId;
  const r = await gFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const err = await r.json();
    throw new Error(err.error?.message || 'Failed to send email');
  }
  return r.json();
}

function gmailComposeUrl(to, subject, body) {
  const params = new URLSearchParams({ view: 'cm', to, su: subject, body });
  return `https://mail.google.com/mail/?${params}`;
}

// ── Google Calendar ───────────────────────────────────────────────────────────
async function calListUpcoming(maxResults = 10) {
  const now = new Date().toISOString();
  const r = await gFetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=${maxResults}&timeMin=${encodeURIComponent(now)}&singleEvents=true&orderBy=startTime`);
  return r.json();
}

async function calCreateEvent({ summary, description, startDate, startTime, durationHours = 1, attendees = [] }) {
  const start = new Date(`${startDate}T${startTime || '09:00'}:00`);
  const end = new Date(start.getTime() + durationHours * 3600000);
  const body = {
    summary,
    description,
    start: { dateTime: start.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    end: { dateTime: end.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    attendees: attendees.filter(Boolean).map(email => ({ email }))
  };
  const r = await gFetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    body: JSON.stringify(body)
  });
  if (!r.ok) { const e = await r.json(); throw new Error(e.error?.message || 'Calendar error'); }
  return r.json();
}

// ── Google Drive ──────────────────────────────────────────────────────────────
async function driveListFiles(query = '', maxResults = 10) {
  const q = query ? `name contains '${query.replace(/'/g, "\\'")}' and ` : '';
  const params = new URLSearchParams({
    q: `${q}trashed=false`,
    pageSize: maxResults,
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink,size)',
    orderBy: 'modifiedTime desc'
  });
  const r = await gFetch(`https://www.googleapis.com/drive/v3/files?${params}`);
  return r.json();
}

// ── Homeworks / CopilotCRM (Zapier Webhook Bridge) ────────────────────────────
function getZapierWebhookUrl() { return getIntState('zapierWebhookUrl') || ''; }
function isHomeworksConnected() { return !!getZapierWebhookUrl(); }

// Split "First Last" or "Business Name" into Homeworks-compatible fields
function splitName(fullName = '') {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: '', lastName: '', businessName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(' '), businessName: fullName };
}

// Parse "123 Main St, Vienna, VA 22180" into address components
function parseAddress(address = '') {
  const parts = address.split(',').map(s => s.trim());
  const street = parts[0] || '';
  const city = parts[1] || '';
  const stateZip = (parts[2] || '').trim().split(/\s+/);
  const state = stateZip[0] || 'VA';
  const zip = stateZip[1] || '';
  return { street, city, state, zip };
}

// Map Avalon service line → Homeworks service type tag
function mapServiceLine(serviceLine = '') {
  const map = {
    'Landscape Design': 'landscape_design',
    'Hardscape': 'hardscape',
    'Lawn Maintenance': 'lawn_maintenance',
    'Tree & Shrub': 'tree_shrub',
    'Irrigation': 'irrigation',
    'Outdoor Lighting': 'outdoor_lighting',
    'Drainage': 'drainage',
    'Seasonal Cleanup': 'seasonal_cleanup',
    'Snow Removal': 'snow_removal',
    'Other': 'other'
  };
  return map[serviceLine] || serviceLine.toLowerCase().replace(/\s+/g, '_');
}

async function sendToHomeworks(eventType, payload) {
  const url = getZapierWebhookUrl();
  if (!url) throw new Error('Homeworks webhook URL not configured');
  const body = {
    event: eventType,
    source: 'avalon-sales-hub',
    timestamp: new Date().toISOString(),
    data: payload
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    mode: 'no-cors'
  });
  return { success: true };
}

// Push new customer/lead — maps to Homeworks "Add New Customer" form fields
async function pushLeadToHomeworks(opportunity) {
  const { firstName, lastName, businessName } = splitName(opportunity.client);
  const { street, city, state, zip } = parseAddress(opportunity.address);
  return sendToHomeworks('new_customer', {
    // Homeworks "Add New Customer" fields
    title: '',
    type: 'Customer',
    contact_first_name: firstName,
    contact_last_name: lastName,
    business_name: businessName,
    email: opportunity.email || '',
    mobile_phone: opportunity.phone || '',
    tags: mapServiceLine(opportunity.serviceLine),
    // Address fields
    address1: street,
    city: city || 'Vienna',
    state: state || 'VA',
    zip: zip || '',
    country: 'United States',
    // Internal notes
    notes: [
      opportunity.project ? `Project: ${opportunity.project}` : '',
      opportunity.source ? `Source: ${opportunity.source}` : '',
      opportunity.budget ? `Budget: ${opportunity.budget}` : '',
      opportunity.urgency ? `Urgency: ${opportunity.urgency}` : '',
      opportunity.decisionMaker ? `Decision maker: ${opportunity.decisionMaker}` : '',
      opportunity.prompt ? `Inquiry: ${opportunity.prompt}` : '',
    ].filter(Boolean).join('\n'),
    // Avalon meta
    avalon_id: opportunity.id,
    avalon_status: opportunity.status,
    lead_source: opportunity.source || '',
    created_at: opportunity.createdAt
  });
}

// Push estimate — maps to Homeworks "New Estimate" form fields
async function pushEstimateToHomeworks(opportunity) {
  const { firstName, lastName, businessName } = splitName(opportunity.client);
  const { street, city, state, zip } = parseAddress(opportunity.address);
  return sendToHomeworks('new_estimate', {
    // Customer identification
    customer_name: businessName,
    customer_first_name: firstName,
    customer_last_name: lastName,
    customer_email: opportunity.email || '',
    customer_phone: opportunity.phone || '',
    // Estimate fields
    estimate_title: opportunity.project || `${opportunity.serviceLine || 'Landscape'} — ${opportunity.client}`,
    estimate_date: new Date().toISOString().slice(0, 10),
    service_type: opportunity.serviceLine || '',
    service_tag: mapServiceLine(opportunity.serviceLine),
    // Property
    property_address: street,
    property_city: city || 'Vienna',
    property_state: state || 'VA',
    property_zip: zip || '',
    // Notes visible to customer
    customer_notes: opportunity.desiredOutcome || '',
    // Internal terms / notes
    internal_notes: [
      opportunity.budget ? `Budget discussed: ${opportunity.budget}` : '',
      opportunity.fitConcerns ? `Fit concerns: ${opportunity.fitConcerns}` : '',
      opportunity.urgency ? `Urgency: ${opportunity.urgency}` : '',
    ].filter(Boolean).join('\n'),
    // Avalon meta
    avalon_id: opportunity.id,
    avalon_status: opportunity.status,
    next_follow_up: opportunity.nextFollowUp || ''
  });
}

// Push site visit — maps to Homeworks "Create New Visit" form fields
async function pushVisitToHomeworks(opportunity, visitDate, visitTime = '09:00', notes = '') {
  const { firstName, lastName, businessName } = splitName(opportunity.client);
  const { street, city, state } = parseAddress(opportunity.address);
  return sendToHomeworks('new_visit', {
    // Visit fields
    visit_title: `Site Walk — ${opportunity.client}`,
    visit_type: 'Site Walk',
    visit_date: visitDate,
    visit_time: visitTime,
    budgeted_hours: '1',
    billing_option: 'Invoice services',
    // Customer
    customer_name: businessName,
    customer_first_name: firstName,
    customer_last_name: lastName,
    customer_email: opportunity.email || '',
    customer_phone: opportunity.phone || '',
    // Property
    property_address: street,
    property_city: city || 'Vienna',
    property_state: state || 'VA',
    location: opportunity.address || '',
    // Notes
    description: notes || `Site walk for ${opportunity.project || opportunity.serviceLine || 'landscape project'}. ${opportunity.desiredOutcome || ''}`.trim(),
    // Line item
    service_item: opportunity.serviceLine || 'Site Walk / Consultation',
    // Avalon meta
    avalon_id: opportunity.id,
    avalon_status: opportunity.status
  });
}

async function pushStatusUpdateToHomeworks(opportunity) {
  return sendToHomeworks('status_update', {
    customer_name: opportunity.client,
    email: opportunity.email,
    avalonId: opportunity.id,
    newStatus: opportunity.status,
    nextFollowUp: opportunity.nextFollowUp,
    updated: opportunity.updatedAt
  });
}

// ── Toast helper (local to integrations) ─────────────────────────────────────
function showIntToast(msg, type = 'info') {
  if (window.showToast) { window.showToast(msg); return; }
  console.log(`[${type}] ${msg}`);
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function connBadge(connected, label) {
  return connected
    ? `<span class="badge" style="background:#00c853;color:#fff">✓ ${label} Connected</span>`
    : `<span class="badge" style="background:#6b7280;color:#fff">○ Not Connected</span>`;
}
function iconBtn(icon, label, onclick) {
  return `<button class="secondary-btn" style="gap:6px;display:inline-flex;align-items:center" onclick="${onclick}">${icon} ${label}</button>`;
}

// ── MAIN VIEW: integrations() ─────────────────────────────────────────────────
async function integrations() {
  const intView = document.getElementById('view');
  const googleOk = isGoogleConnected();
  const hwOk = isHomeworksConnected();
  const googleEmail = getGoogleUserEmail();

  intView.innerHTML = `
<div class="eyebrow">Connected Tools</div>
<h1>Integrations</h1>
<p class="lede">Connect the Avalon Sales Hub to Google Workspace and your Homeworks CRM. All credentials stay in this browser — nothing is sent to any server.</p>

<div class="grid grid-2 mt" style="gap:28px">

  <!-- ── GOOGLE WORKSPACE ────────────────────────────────── -->
  <section class="card" id="int-google-card">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
      <img src="https://www.google.com/favicon.ico" style="width:28px;height:28px" alt="Google">
      <h2 style="margin:0">Google Workspace</h2>
      ${connBadge(googleOk, googleEmail || 'Google')}
    </div>
    <p>Access Gmail, Google Calendar, and Google Drive directly from the Sales Hub. Uses your personal Google account — no data is shared with Avalon servers.</p>

    <div id="int-google-setup" style="${googleOk ? 'display:none' : ''}">
      <h3 style="margin:12px 0 6px">Setup (one-time)</h3>
      <ol style="padding-left:20px;font-size:13px;line-height:1.8;color:var(--muted)">
        <li>Go to <a href="https://console.cloud.google.com/" target="_blank" rel="noopener" style="color:var(--accent)">console.cloud.google.com</a></li>
        <li>Create a project → Enable <strong>Gmail API</strong>, <strong>Calendar API</strong>, <strong>Drive API</strong></li>
        <li>OAuth consent screen → External → add your email as test user</li>
        <li>Credentials → Create OAuth 2.0 Client ID → Web application</li>
        <li>Add <code style="background:#1e293b;padding:2px 6px;border-radius:4px">${location.origin}/auth/google/callback</code> as Authorised redirect URI</li>
        <li>Copy your <strong>Client ID</strong> and paste below</li>
      </ol>
      <div style="margin:12px 0">
        <label style="font-size:12px;font-weight:600;color:var(--muted)">GOOGLE CLIENT ID</label>
        <input id="gClientIdInput" type="text" placeholder="1234567890-abc...apps.googleusercontent.com"
          value="${escapeHtml(getGoogleClientId())}"
          style="width:100%;margin-top:6px;padding:10px 12px;background:#1e293b;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px;box-sizing:border-box">
      </div>
      <button class="primary-btn" onclick="intSaveClientIdAndConnect()" style="margin-top:4px">
        Connect Google Account
      </button>
    </div>

    <div id="int-google-connected" style="${googleOk ? '' : 'display:none'}">
      <div class="connected-features" style="margin:12px 0">
        <div style="font-size:11px;font-weight:700;color:#4ade80;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px">✅ Connected as ${googleEmail||'your Google account'} — What you can do:</div>
        <div class="cf-row"><span class="cf-icon">📧</span><div><strong>Gmail</strong> — Read recent threads, compose follow-up emails from templates</div></div>
        <div class="cf-row"><span class="cf-icon">📅</span><div><strong>Calendar</strong> — View upcoming events, schedule site walks and follow-ups</div></div>
        <div class="cf-row"><span class="cf-icon">📂</span><div><strong>Drive</strong> — Search and link proposal docs, contracts, and site photos</div></div>
        <div class="cf-row"><span class="cf-icon">🔀</span><div><strong>Template Merge</strong> — Personalize email templates with live lead data and send via Gmail</div></div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px">
        ${iconBtn('📧', 'Gmail', "intShowGmail()")}
        ${iconBtn('📅', 'Calendar', "intShowCalendar()")}
        ${iconBtn('📂', 'Drive', "intShowDrive()")}
        <button class="danger-btn" onclick="intGoogleDisconnect()" style="margin-left:auto">Disconnect</button>
      </div>
    </div>

    <!-- Gmail panel -->
    <div id="int-gmail-panel" style="display:none;margin-top:20px;border-top:1px solid #334155;padding-top:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="margin:0">📧 Recent Gmail Threads</h3>
        <button class="secondary-btn" onclick="intComposeFromTemplate()" style="font-size:12px">+ Compose from Template</button>
      </div>
      <div id="int-gmail-list"><div class="spinner-wrap"><div class="spinner"></div></div></div>
    </div>

    <!-- Calendar panel -->
    <div id="int-cal-panel" style="display:none;margin-top:20px;border-top:1px solid #334155;padding-top:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="margin:0">📅 Upcoming Events</h3>
        <button class="secondary-btn" onclick="intCreateCalendarEvent()" style="font-size:12px">+ New Event</button>
      </div>
      <div id="int-cal-list"><div class="spinner-wrap"><div class="spinner"></div></div></div>
    </div>

    <!-- Drive panel -->
    <div id="int-drive-panel" style="display:none;margin-top:20px;border-top:1px solid #334155;padding-top:16px">
      <h3 style="margin:0 0 12px">📂 Google Drive Files</h3>
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <input id="int-drive-search" type="text" placeholder="Search files…"
          style="flex:1;padding:8px 12px;background:#1e293b;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px">
        <button class="secondary-btn" onclick="intSearchDrive()">Search</button>
      </div>
      <div id="int-drive-list"><div class="spinner-wrap"><div class="spinner"></div></div></div>
    </div>
  </section>

  <!-- ── HOMEWORKS / COPILOTCRM ──────────────────────────── -->
  <section class="card" id="int-hw-card">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
      <span style="font-size:28px">🏡</span>
      <h2 style="margin:0">Homeworks CRM</h2>
      ${connBadge(hwOk, 'Homeworks')}
    </div>
    <p>Push leads and status updates to your Homeworks (CopilotCRM) account via a Zapier webhook. Set up once — then sync with one click from any opportunity.</p>

    <div style="margin:16px 0">
      ${!hwOk ? `<div class="int-onboarding-state">
        <div style="font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#f59e0b;margin-bottom:8px">🚀 Get Started — 4 Steps</div>
        <div class="setup-steps">
          <div style="display:flex;gap:12px;align-items:flex-start;margin-bottom:12px">
            <div class="step-num">1</div>
            <div><strong>Create a Zapier account</strong> (free tier works) at <a href="https://zapier.com" target="_blank" rel="noopener" style="color:var(--accent)">zapier.com</a></div>
          </div>
          <div style="display:flex;gap:12px;align-items:flex-start;margin-bottom:12px">
            <div class="step-num">2</div>
            <div><strong>New Zap:</strong> Trigger = <em>Webhooks by Zapier → Catch Hook</em> — copy the webhook URL Zapier gives you</div>
          </div>
          <div style="display:flex;gap:12px;align-items:flex-start;margin-bottom:12px">
            <div class="step-num">3</div>
            <div><strong>Action:</strong> <em>Homeworks → Create Customer</em> — map: name → data.name, email → data.email, phone → data.phone, address → data.address</div>
          </div>
          <div style="display:flex;gap:12px;align-items:flex-start;margin-bottom:12px">
            <div class="step-num">4</div>
            <div><strong>Paste your webhook URL below</strong> and click Save — then one-click push any lead to Homeworks</div>
          </div>
        </div>
      </div>` : ''}
      <h3 style="margin:0 0 8px">${hwOk ? '⚙️ Webhook Settings' : 'Your Zapier Webhook URL'}</h3>
      <label style="font-size:12px;font-weight:600;color:var(--muted)">ZAPIER WEBHOOK URL</label>
      <input id="zapierWebhookInput" type="url"
        placeholder="https://hooks.zapier.com/hooks/catch/XXXXXXX/XXXXXXX/"
        value="${escapeHtml(getZapierWebhookUrl())}"
        style="width:100%;margin-top:6px;padding:10px 12px;background:#1e293b;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px;box-sizing:border-box">
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="primary-btn" onclick="intSaveZapierUrl()">Save Webhook URL</button>
        ${hwOk ? `<button class="secondary-btn" onclick="intTestZapier()">Send Test Ping</button>` : ''}
      </div>
    </div>

      ${hwOk ? `
    <!-- Homeworks KPI Dashboard Strip -->
    <div style="border-top:1px solid #334155;padding-top:16px;margin-top:8px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <h3 style="margin:0">📊 Account Standing <span style="font-size:11px;font-weight:400;color:var(--muted);margin-left:8px">from Homeworks My Day</span></h3>
        <a href="https://secure.copilotcrm.com" target="_blank" rel="noopener"
          style="font-size:11px;color:var(--accent);text-decoration:none">Open Homeworks →</a>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px">
        <div style="background:#1a0a0a;border:1px solid #7f1d1d;border-radius:10px;padding:12px;text-align:center">
          <div style="font-size:10px;font-weight:700;color:#fca5a5;letter-spacing:.05em;text-transform:uppercase">Past Due</div>
          <div style="font-size:18px;font-weight:800;color:#f87171;margin-top:4px">$11,082</div>
          <div style="font-size:10px;color:var(--muted);margin-top:2px">Action needed</div>
        </div>
        <div style="background:#0c1a2e;border:1px solid #1e3a5f;border-radius:10px;padding:12px;text-align:center">
          <div style="font-size:10px;font-weight:700;color:#93c5fd;letter-spacing:.05em;text-transform:uppercase">Outstanding</div>
          <div style="font-size:18px;font-weight:800;color:#60a5fa;margin-top:4px">$78,116</div>
          <div style="font-size:10px;color:var(--muted);margin-top:2px">Awaiting payment</div>
        </div>
        <div style="background:#0a1a0a;border:1px solid #1a3a1a;border-radius:10px;padding:12px;text-align:center">
          <div style="font-size:10px;font-weight:700;color:#86efac;letter-spacing:.05em;text-transform:uppercase">Credit</div>
          <div style="font-size:18px;font-weight:800;color:#4ade80;margin-top:4px">$0</div>
          <div style="font-size:10px;color:var(--muted);margin-top:2px">Customer credits</div>
        </div>
        <div style="background:#0a1a0e;border:1px solid #14532d;border-radius:10px;padding:12px;text-align:center">
          <div style="font-size:10px;font-weight:700;color:#6ee7b7;letter-spacing:.05em;text-transform:uppercase">Paid</div>
          <div style="font-size:18px;font-weight:800;color:#34d399;margin-top:4px">$636K</div>
          <div style="font-size:10px;color:var(--muted);margin-top:2px">Total collected</div>
        </div>
      </div>

      <!-- Homeworks Quick Links -->
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px">
        <a href="https://secure.copilotcrm.com/customers/add-new-customer" target="_blank" rel="noopener"
          style="display:inline-flex;align-items:center;gap:6px;padding:7px 12px;background:#1e293b;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:12px;text-decoration:none;font-weight:500">
          👤 Add Customer
        </a>
        <a href="https://secure.copilotcrm.com/assets/add-new-asset" target="_blank" rel="noopener"
          style="display:inline-flex;align-items:center;gap:6px;padding:7px 12px;background:#1e293b;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:12px;text-decoration:none;font-weight:500">
          🏡 Add Property
        </a>
        <a href="https://secure.copilotcrm.com/finances/estimates/add" target="_blank" rel="noopener"
          style="display:inline-flex;align-items:center;gap:6px;padding:7px 12px;background:#1e293b;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:12px;text-decoration:none;font-weight:500">
          📋 New Estimate
        </a>
        <a href="https://secure.copilotcrm.com/scheduler/addvisit" target="_blank" rel="noopener"
          style="display:inline-flex;align-items:center;gap:6px;padding:7px 12px;background:#1e293b;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:12px;text-decoration:none;font-weight:500">
          📅 Schedule Visit
        </a>
        <a href="https://secure.copilotcrm.com/finances/estimates" target="_blank" rel="noopener"
          style="display:inline-flex;align-items:center;gap:6px;padding:7px 12px;background:#1e293b;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:12px;text-decoration:none;font-weight:500">
          📊 Estimates List
        </a>
        <a href="https://secure.copilotcrm.com/scheduler/month" target="_blank" rel="noopener"
          style="display:inline-flex;align-items:center;gap:6px;padding:7px 12px;background:#1e293b;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:12px;text-decoration:none;font-weight:500">
          🗓️ Calendar
        </a>
      </div>

      <!-- 3-Action Opportunity Sync List -->
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <h3 style="margin:0;font-size:14px">Sync Opportunities → Homeworks</h3>
        <span style="font-size:11px;color:var(--muted)">Push as Customer · Estimate · Visit</span>
      </div>
      <div id="int-hw-opps" style="max-height:420px;overflow-y:auto">${renderHwOpps()}</div>
    </div>
    ` : ''}
  </section>

</div>

<!-- ── SCHEDULE VISIT MODAL (Homeworks) ──────────────────────────── -->
<div id="int-visit-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:1001;align-items:center;justify-content:center">
  <div style="background:#1e293b;border-radius:16px;padding:32px;width:min(580px,95vw);max-height:90vh;overflow-y:auto;position:relative">
    <button onclick="document.getElementById('int-visit-modal').style.display='none'"
      style="position:absolute;top:16px;right:16px;background:transparent;border:none;color:#94a3b8;font-size:20px;cursor:pointer">✕</button>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px">
      <span style="font-size:24px">📅</span>
      <div>
        <h2 style="margin:0;font-size:18px">Schedule Site Visit</h2>
        <div id="int-visit-client-label" style="font-size:13px;color:var(--muted);margin-top:2px"></div>
      </div>
    </div>
    <input type="hidden" id="int-visit-opp-id">
    <div style="display:flex;flex-direction:column;gap:14px">
      <div>
        <label style="font-size:12px;font-weight:600;color:var(--muted)">VISIT TITLE / DESCRIPTION</label>
        <input id="int-visit-title" type="text" placeholder="e.g. Site Walk — Landscape Design Consult"
          style="width:100%;margin-top:6px;padding:10px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px;box-sizing:border-box">
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div>
          <label style="font-size:12px;font-weight:600;color:var(--muted)">VISIT DATE</label>
          <input id="int-visit-date" type="date"
            style="width:100%;margin-top:6px;padding:10px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:12px;font-weight:600;color:var(--muted)">TIME</label>
          <input id="int-visit-time" type="time" value="09:00"
            style="width:100%;margin-top:6px;padding:10px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px;box-sizing:border-box">
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div>
          <label style="font-size:12px;font-weight:600;color:var(--muted)">BUDGETED HOURS</label>
          <input id="int-visit-hours" type="number" value="1" min="0.5" max="8" step="0.5"
            style="width:100%;margin-top:6px;padding:10px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:12px;font-weight:600;color:var(--muted)">BILLING OPTION</label>
          <select id="int-visit-billing"
            style="width:100%;margin-top:6px;padding:10px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px">
            <option value="Invoice services">Invoice services</option>
            <option value="No charge">No charge</option>
            <option value="Flat rate">Flat rate</option>
          </select>
        </div>
      </div>
      <div>
        <label style="font-size:12px;font-weight:600;color:var(--muted)">VISIT TYPE</label>
        <select id="int-visit-type"
          style="width:100%;margin-top:6px;padding:10px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px">
          <option value="Site Walk">Site Walk</option>
          <option value="Consultation">Consultation</option>
          <option value="Estimate Review">Estimate Review</option>
          <option value="Follow-up Visit">Follow-up Visit</option>
          <option value="Maintenance Visit">Maintenance Visit</option>
        </select>
      </div>
      <div>
        <label style="font-size:12px;font-weight:600;color:var(--muted)">NOTES / DESCRIPTION</label>
        <textarea id="int-visit-notes" rows="3" placeholder="Scope, property details, what to bring…"
          style="width:100%;margin-top:6px;padding:10px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px;box-sizing:border-box;resize:vertical"></textarea>
      </div>
      <div id="int-visit-also-gcal" style="display:flex;align-items:center;gap:10px;padding:12px;background:#0f172a;border-radius:8px;border:1px solid #334155">
        <input type="checkbox" id="int-visit-gcal-check" checked style="width:16px;height:16px;cursor:pointer">
        <label for="int-visit-gcal-check" style="font-size:13px;cursor:pointer">
          📅 Also add to <strong>Google Calendar</strong> ${isGoogleConnected() ? '<span style="color:#4ade80;font-size:11px">● Connected</span>' : '<span style="color:#94a3b8;font-size:11px">(connect Google first)</span>'}
        </label>
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:4px">
        <button class="secondary-btn" onclick="document.getElementById('int-visit-modal').style.display='none'">Cancel</button>
        <button class="primary-btn" onclick="intSubmitVisit()">
          📅 Push Visit to Homeworks
        </button>
      </div>
    </div>
  </div>
</div>

<!-- ── PUSH ESTIMATE MODAL (Homeworks) ──────────────────────────── -->
<div id="int-estimate-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:1001;align-items:center;justify-content:center">
  <div style="background:#1e293b;border-radius:16px;padding:32px;width:min(560px,95vw);max-height:90vh;overflow-y:auto;position:relative">
    <button onclick="document.getElementById('int-estimate-modal').style.display='none'"
      style="position:absolute;top:16px;right:16px;background:transparent;border:none;color:#94a3b8;font-size:20px;cursor:pointer">✕</button>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px">
      <span style="font-size:24px">📋</span>
      <div>
        <h2 style="margin:0;font-size:18px">Push as Estimate</h2>
        <div id="int-est-client-label" style="font-size:13px;color:var(--muted);margin-top:2px"></div>
      </div>
    </div>
    <input type="hidden" id="int-est-opp-id">
    <div style="display:flex;flex-direction:column;gap:14px">
      <div>
        <label style="font-size:12px;font-weight:600;color:var(--muted)">ESTIMATE TITLE / DESCRIPTION</label>
        <input id="int-est-title" type="text" placeholder="e.g. Landscape Design — Smith Residence"
          style="width:100%;margin-top:6px;padding:10px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px;box-sizing:border-box">
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div>
          <label style="font-size:12px;font-weight:600;color:var(--muted)">ESTIMATE DATE</label>
          <input id="int-est-date" type="date"
            style="width:100%;margin-top:6px;padding:10px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:12px;font-weight:600;color:var(--muted)">SERVICE TYPE</label>
          <select id="int-est-service"
            style="width:100%;margin-top:6px;padding:10px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px">
            <option value="Landscape Design">Landscape Design</option>
            <option value="Hardscape">Hardscape</option>
            <option value="Lawn Maintenance">Lawn Maintenance</option>
            <option value="Tree & Shrub">Tree &amp; Shrub</option>
            <option value="Irrigation">Irrigation</option>
            <option value="Outdoor Lighting">Outdoor Lighting</option>
            <option value="Drainage">Drainage</option>
            <option value="Seasonal Cleanup">Seasonal Cleanup</option>
            <option value="Snow Removal">Snow Removal</option>
            <option value="Other">Other</option>
          </select>
        </div>
      </div>
      <div>
        <label style="font-size:12px;font-weight:600;color:var(--muted)">NOTES VISIBLE TO CUSTOMER</label>
        <textarea id="int-est-customer-notes" rows="2" placeholder="Scope of work visible to client…"
          style="width:100%;margin-top:6px;padding:10px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px;box-sizing:border-box;resize:vertical"></textarea>
      </div>
      <div>
        <label style="font-size:12px;font-weight:600;color:var(--muted)">INTERNAL NOTES</label>
        <textarea id="int-est-internal-notes" rows="2" placeholder="Internal context, budget discussed, concerns…"
          style="width:100%;margin-top:6px;padding:10px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px;box-sizing:border-box;resize:vertical"></textarea>
      </div>
      <div style="padding:10px 14px;background:#0f172a;border:1px solid #334155;border-radius:8px;font-size:12px;color:var(--muted)">
        ℹ️ This creates the estimate record in Homeworks. Open Homeworks to add line items, pricing, and send to client.
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:4px">
        <button class="secondary-btn" onclick="document.getElementById('int-estimate-modal').style.display='none'">Cancel</button>
        <button class="primary-btn" onclick="intSubmitEstimate()">
          📋 Push Estimate to Homeworks
        </button>
      </div>
    </div>
  </div>
</div>

<!-- ── COMPOSE EMAIL MODAL ────────────────────────────────────── -->
<div id="int-compose-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:1000;align-items:center;justify-content:center">
  <div style="background:#1e293b;border-radius:16px;padding:32px;width:min(680px,95vw);max-height:90vh;overflow-y:auto;position:relative">
    <button onclick="document.getElementById('int-compose-modal').style.display='none'"
      style="position:absolute;top:16px;right:16px;background:transparent;border:none;color:#94a3b8;font-size:20px;cursor:pointer">✕</button>
    <h2 style="margin:0 0 20px">Compose Email</h2>
    <div style="display:flex;flex-direction:column;gap:12px">
      <div>
        <label style="font-size:12px;font-weight:600;color:var(--muted)">TEMPLATE</label>
        <select id="int-tmpl-select" onchange="intFillTemplate()" style="width:100%;margin-top:6px;padding:10px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px">
          <option value="">— Choose a template —</option>
          ${(window.AVALON_DATA?.templates || []).map((t,i) => `<option value="${i}">${escapeHtml(t.title)}</option>`).join('')}
        </select>
      </div>
      <div>
        <label style="font-size:12px;font-weight:600;color:var(--muted)">TO</label>
        <input id="int-email-to" type="email" placeholder="client@email.com"
          style="width:100%;margin-top:6px;padding:10px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px;box-sizing:border-box">
      </div>
      <div>
        <label style="font-size:12px;font-weight:600;color:var(--muted)">SUBJECT</label>
        <input id="int-email-subject" type="text" placeholder="Subject line"
          style="width:100%;margin-top:6px;padding:10px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px;box-sizing:border-box">
      </div>
      <div>
        <label style="font-size:12px;font-weight:600;color:var(--muted)">BODY</label>
        <textarea id="int-email-body" rows="10" placeholder="Email body…"
          style="width:100%;margin-top:6px;padding:10px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px;box-sizing:border-box;resize:vertical"></textarea>
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button class="secondary-btn" onclick="intOpenInGmail()">Open in Gmail</button>
        <button class="primary-btn" onclick="intSendEmail()">Send via Gmail API</button>
      </div>
    </div>
  </div>
</div>

<!-- ── CREATE CALENDAR EVENT MODAL ──────────────────────────────── -->
<div id="int-cal-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:1000;align-items:center;justify-content:center">
  <div style="background:#1e293b;border-radius:16px;padding:32px;width:min(560px,95vw);max-height:90vh;overflow-y:auto;position:relative">
    <button onclick="document.getElementById('int-cal-modal').style.display='none'"
      style="position:absolute;top:16px;right:16px;background:transparent;border:none;color:#94a3b8;font-size:20px;cursor:pointer">✕</button>
    <h2 style="margin:0 0 20px">Create Calendar Event</h2>
    <div style="display:flex;flex-direction:column;gap:12px">
      <div>
        <label style="font-size:12px;font-weight:600;color:var(--muted)">EVENT TITLE</label>
        <input id="int-cal-title" type="text" placeholder="e.g. Site Walk — Smith Residence"
          style="width:100%;margin-top:6px;padding:10px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px;box-sizing:border-box">
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div>
          <label style="font-size:12px;font-weight:600;color:var(--muted)">DATE</label>
          <input id="int-cal-date" type="date"
            style="width:100%;margin-top:6px;padding:10px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:12px;font-weight:600;color:var(--muted)">TIME</label>
          <input id="int-cal-time" type="time" value="09:00"
            style="width:100%;margin-top:6px;padding:10px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px;box-sizing:border-box">
        </div>
      </div>
      <div>
        <label style="font-size:12px;font-weight:600;color:var(--muted)">DURATION (hours)</label>
        <input id="int-cal-duration" type="number" value="1" min="0.5" max="8" step="0.5"
          style="width:100%;margin-top:6px;padding:10px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px;box-sizing:border-box">
      </div>
      <div>
        <label style="font-size:12px;font-weight:600;color:var(--muted)">INVITE (optional — client email)</label>
        <input id="int-cal-attendee" type="email" placeholder="client@email.com"
          style="width:100%;margin-top:6px;padding:10px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px;box-sizing:border-box">
      </div>
      <div>
        <label style="font-size:12px;font-weight:600;color:var(--muted)">NOTES / DESCRIPTION</label>
        <textarea id="int-cal-notes" rows="3" placeholder="Job address, scope, etc."
          style="width:100%;margin-top:6px;padding:10px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px;box-sizing:border-box;resize:vertical"></textarea>
      </div>
      <button class="primary-btn" onclick="intSubmitCalEvent()">Create Event</button>
    </div>
  </div>
</div>
`;

  // Load Google data if connected
  if (googleOk) {
    intLoadGmail();
    intLoadCalendar();
    intLoadDrive();
  }
}

// ── Render Homeworks opportunity list (3-action: Customer | Estimate | Visit) ──
function renderHwOpps() {
  const opps = (window._avalonState?.opportunities || []).filter(o =>
    !['Closed Lost'].includes(o.status)
  );
  if (!opps.length) return '<p style="color:var(--muted);font-size:13px">No opportunities yet. Add a lead first.</p>';

  const stageColor = {
    'New Lead': '#6366f1',
    'Contacted': '#8b5cf6',
    'Meeting Set': '#3b82f6',
    'Proposal / Estimate Sent': '#f59e0b',
    'Negotiation': '#ef4444',
    'Sold / Activation': '#10b981',
  };

  return opps.map(o => {
    const color = stageColor[o.status] || '#64748b';
    const addr = (o.address || '').split(',')[0] || '—';
    return `
    <div style="background:#0f172a;border-radius:10px;margin-bottom:10px;overflow:hidden;border:1px solid #1e293b">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid #1e293b">
        <div style="display:flex;align-items:center;gap:10px;min-width:0">
          <div style="width:10px;height:10px;border-radius:50%;background:${color};flex-shrink:0"></div>
          <div style="min-width:0">
            <div style="font-weight:700;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(o.client)}</div>
            <div style="font-size:11px;color:var(--muted);margin-top:1px">
              ${escapeHtml(o.serviceLine || '—')} · ${escapeHtml(addr)}
            </div>
          </div>
        </div>
        <span style="font-size:10px;font-weight:600;padding:3px 8px;border-radius:20px;background:${color}22;color:${color};flex-shrink:0;margin-left:8px">
          ${escapeHtml(o.status)}
        </span>
      </div>
      <div style="display:flex;gap:6px;padding:10px 14px;flex-wrap:wrap">
        <button onclick="intPushLead('${escapeHtml(o.id)}')"
          style="flex:1;min-width:90px;padding:7px 10px;background:#1e3a5f;border:1px solid #2563eb;border-radius:7px;color:#93c5fd;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap">
          👤 Customer
        </button>
        <button onclick="intOpenEstimateModal('${escapeHtml(o.id)}')"
          style="flex:1;min-width:90px;padding:7px 10px;background:#1c2a14;border:1px solid #4d7c0f;border-radius:7px;color:#86efac;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap">
          📋 Estimate
        </button>
        <button onclick="intOpenVisitModal('${escapeHtml(o.id)}')"
          style="flex:1;min-width:90px;padding:7px 10px;background:#1a1030;border:1px solid #6d28d9;border-radius:7px;color:#c4b5fd;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap">
          📅 Visit
        </button>
        ${o.email ? `<a href="mailto:${escapeHtml(o.email)}"
          style="flex:none;padding:7px 10px;background:#1a1a1a;border:1px solid #334155;border-radius:7px;color:#94a3b8;font-size:11px;font-weight:600;cursor:pointer;text-decoration:none;white-space:nowrap">
          ✉️
        </a>` : ''}
      </div>
    </div>
    `;
  }).join('');
}

// ── Google interactions ───────────────────────────────────────────────────────
function intShowGmail() {
  const gPanel = document.getElementById('int-gmail-panel');
  const cPanel = document.getElementById('int-cal-panel');
  const dPanel = document.getElementById('int-drive-panel');
  const showing = gPanel.style.display !== 'none';
  gPanel.style.display = showing ? 'none' : 'block';
  cPanel.style.display = 'none';
  dPanel.style.display = 'none';
  if (!showing) intLoadGmail();
}
function intShowCalendar() {
  const gPanel = document.getElementById('int-gmail-panel');
  const cPanel = document.getElementById('int-cal-panel');
  const dPanel = document.getElementById('int-drive-panel');
  const showing = cPanel.style.display !== 'none';
  cPanel.style.display = showing ? 'none' : 'block';
  gPanel.style.display = 'none';
  dPanel.style.display = 'none';
  if (!showing) intLoadCalendar();
}
function intShowDrive() {
  const gPanel = document.getElementById('int-gmail-panel');
  const cPanel = document.getElementById('int-cal-panel');
  const dPanel = document.getElementById('int-drive-panel');
  const showing = dPanel.style.display !== 'none';
  dPanel.style.display = showing ? 'none' : 'block';
  gPanel.style.display = 'none';
  cPanel.style.display = 'none';
  if (!showing) intLoadDrive();
}

async function intLoadGmail() {
  const el = document.getElementById('int-gmail-list');
  if (!el) return;
  el.innerHTML = '<div class="spinner-wrap"><div class="spinner"></div></div>';
  try {
    const result = await gmailListThreads(8);
    const threads = result.threads || [];
    if (!threads.length) { el.innerHTML = '<p style="color:var(--muted);font-size:13px">No recent threads.</p>'; return; }
    // Fetch metadata for each thread
    const metaList = await Promise.all(
      threads.slice(0, 6).map(t => gmailGetThread(t.id).catch(() => null))
    );
    el.innerHTML = metaList.filter(Boolean).map(thread => {
      const msg = thread.messages?.[thread.messages.length - 1];
      const headers = msg?.payload?.headers || [];
      const subj = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
      const from = headers.find(h => h.name === 'From')?.value || '';
      const date = headers.find(h => h.name === 'Date')?.value || '';
      const d = date ? new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
      const sender = from.split('<')[0].trim().replace(/"/g,'') || from;
      return `
        <div class="int-list-row">
          <div style="min-width:0;flex:1">
            <div class="int-list-row-title">✉️ ${escapeHtml(subj)}</div>
            <div class="int-list-row-meta">From: ${escapeHtml(sender)}${d ? ' · ' + d : ''}</div>
          </div>
          <a href="https://mail.google.com/mail/#inbox/${thread.id}" target="_blank" rel="noopener" class="int-list-row-link">Open →</a>
        </div>
      `;
    }).join('');
  } catch(e) {
    el.innerHTML = `<p style="color:#f87171;font-size:13px">Error: ${escapeHtml(e.message)}</p>`;
  }
}

// Calendar view state ('agenda' | 'week' | 'month')
let _calView = 'agenda';
let _calEvents = [];
let _calWeekOffset = 0; // weeks from today
let _calMonthOffset = 0; // months from today

async function intLoadCalendar() {
  const el = document.getElementById('int-cal-list');
  if (!el) return;
  el.innerHTML = '<div class="spinner-wrap"><div class="spinner"></div></div>';
  try {
    // Fetch up to 50 events so we have enough for week/month grids
    const result = await calListUpcoming(50);
    _calEvents = result.items || [];
    intRenderCalView(el);
  } catch(e) {
    el.innerHTML = `<p style="color:#f87171;font-size:13px">Error: ${escapeHtml(e.message)}</p>`;
  }
}

function intRenderCalView(el) {
  if (!el) el = document.getElementById('int-cal-list');
  if (!el) return;

  // Build the view toggle header
  const navHtml = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
    <div class="cal-view-toggle">
      <button class="cal-view-btn ${_calView==='month'?'active':''}" onclick="intSetCalView('month')">Month</button>
      <button class="cal-view-btn ${_calView==='week'?'active':''}" onclick="intSetCalView('week')">Week</button>
      <button class="cal-view-btn ${_calView==='agenda'?'active':''}" onclick="intSetCalView('agenda')">Agenda</button>
    </div>
    <div style="display:flex;gap:6px;align-items:center">
      <button onclick="intCalPrev()" style="background:transparent;border:1px solid #334155;color:#94a3b8;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:13px">‹</button>
      <span id="cal-view-label" style="font-size:12px;font-weight:700;color:#94a3b8;min-width:100px;text-align:center"></span>
      <button onclick="intCalNext()" style="background:transparent;border:1px solid #334155;color:#94a3b8;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:13px">›</button>
      <button onclick="intCalToday()" style="background:transparent;border:1px solid #334155;color:#60a5fa;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:11px;font-weight:700">Today</button>
    </div>
  </div>`;

  let bodyHtml = '';
  if (_calView === 'agenda') bodyHtml = intRenderAgenda();
  else if (_calView === 'week') bodyHtml = intRenderWeek();
  else bodyHtml = intRenderMonth();

  el.innerHTML = navHtml + bodyHtml;
  // Update the label
  const labelEl = document.getElementById('cal-view-label');
  if (labelEl) {
    const today = new Date();
    if (_calView === 'agenda') labelEl.textContent = 'Upcoming';
    else if (_calView === 'week') {
      const weekStart = new Date(today);
      weekStart.setDate(today.getDate() - today.getDay() + _calWeekOffset * 7);
      labelEl.textContent = weekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } else {
      const d = new Date(today.getFullYear(), today.getMonth() + _calMonthOffset, 1);
      labelEl.textContent = d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    }
  }
}

function intRenderAgenda() {
  const events = _calEvents;
  if (!events.length) return '<p style="color:var(--muted);font-size:13px">No upcoming events.</p>';
  const byDay = {};
  events.forEach(ev => {
    const start = ev.start?.dateTime || ev.start?.date || '';
    const dayKey = start ? new Date(start).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : 'Unknown';
    if (!byDay[dayKey]) byDay[dayKey] = [];
    byDay[dayKey].push(ev);
  });
  return Object.entries(byDay).map(([day, dayEvents]) => `
    <div style="margin-bottom:14px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#64748b;margin-bottom:6px;padding:0 2px">${day}</div>
      ${dayEvents.map(ev => {
        const t = ev.start?.dateTime ? new Date(ev.start.dateTime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : 'All day';
        const end = ev.end?.dateTime ? new Date(ev.end.dateTime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
        return `<div class="int-list-row">
          <div style="min-width:0;flex:1">
            <div class="int-list-row-title">📅 ${escapeHtml(ev.summary || '(no title)')}</div>
            <div class="int-list-row-meta">${t}${end ? ' – ' + end : ''}${ev.location ? ' · 📍 ' + escapeHtml(ev.location) : ''}</div>
          </div>
          ${ev.htmlLink ? `<a href="${escapeHtml(ev.htmlLink)}" target="_blank" rel="noopener" class="int-list-row-link">Open →</a>` : ''}
        </div>`;
      }).join('')}
    </div>
  `).join('');
}

function intRenderWeek() {
  const today = new Date();
  const todayNum = today.getDate();
  const todayMonth = today.getMonth();
  const todayYear = today.getFullYear();
  // Week starts Sunday
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay() + _calWeekOffset * 7);
  weekStart.setHours(0,0,0,0);

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    days.push(d);
  }
  const dowLabels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const hours = [];
  for (let h = 7; h <= 19; h++) hours.push(h); // 7am – 7pm

  // Header row
  let html = `<div class="cal-week-grid">
    <div class="cal-week-header" style="background:#0a0f1a"></div>
    ${days.map(d => {
      const isToday = d.getDate()===todayNum && d.getMonth()===todayMonth && d.getFullYear()===todayYear;
      const domHtml = isToday
        ? `<div class="dom today-num">${d.getDate()}</div>`
        : `<div class="dom">${d.getDate()}</div>`;
      return `<div class="cal-week-header"><div class="dow">${dowLabels[d.getDay()]}</div>${domHtml}</div>`;
    }).join('')}`;

  // Time rows
  hours.forEach(h => {
    const label = h === 12 ? '12 PM' : h > 12 ? `${h-12} PM` : `${h} AM`;
    html += `<div class="cal-week-time-label">${label}</div>`;
    days.forEach(d => {
      // Find events in this hour
      const cellEvents = _calEvents.filter(ev => {
        if (!ev.start?.dateTime) return false;
        const eStart = new Date(ev.start.dateTime);
        return eStart.getFullYear()===d.getFullYear() &&
               eStart.getMonth()===d.getMonth() &&
               eStart.getDate()===d.getDate() &&
               eStart.getHours()===h;
      });
      const evHtml = cellEvents.map(ev => {
        const t = new Date(ev.start.dateTime).toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
        return `<a href="${escapeHtml(ev.htmlLink||'#')}" target="_blank" rel="noopener" class="cal-week-event" title="${escapeHtml(ev.summary||'')}">${t} ${escapeHtml((ev.summary||'(no title)').slice(0,20))}</a>`;
      }).join('');
      html += `<div class="cal-week-cell">${evHtml}</div>`;
    });
  });
  html += '</div>';
  return html;
}

function intRenderMonth() {
  const today = new Date();
  const viewDate = new Date(today.getFullYear(), today.getMonth() + _calMonthOffset, 1);
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstDay = new Date(year, month, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const dowLabels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  let html = `<div class="cal-month-grid">
    ${dowLabels.map(d => `<div class="cal-month-day-header">${d}</div>`).join('')}`;

  // Pad empty cells before day 1
  for (let i = 0; i < firstDay; i++) {
    html += `<div class="cal-month-cell other-month"></div>`;
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const isToday = day === today.getDate() && month === today.getMonth() && year === today.getFullYear();
    const dayEvents = _calEvents.filter(ev => {
      const s = ev.start?.dateTime || ev.start?.date;
      if (!s) return false;
      const d = new Date(s);
      return d.getFullYear()===year && d.getMonth()===month && d.getDate()===day;
    });
    const evChips = dayEvents.slice(0,3).map(ev =>
      `<div class="cal-event-chip" title="${escapeHtml(ev.summary||'')}" onclick="window.open('${escapeHtml(ev.htmlLink||'')}','_blank')">${escapeHtml((ev.summary||'Event').slice(0,16))}</div>`
    ).join('');
    const moreCount = dayEvents.length - 3;
    html += `<div class="cal-month-cell${isToday?' today':''}">
      <div class="cal-month-cell-num">${day}</div>
      ${evChips}
      ${moreCount > 0 ? `<div style="font-size:10px;color:#64748b;margin-top:1px">+${moreCount} more</div>` : ''}
    </div>`;
  }

  // Pad to complete final week row
  const totalCells = firstDay + daysInMonth;
  const remaining = (7 - (totalCells % 7)) % 7;
  for (let i = 0; i < remaining; i++) {
    html += `<div class="cal-month-cell other-month"></div>`;
  }
  html += '</div>';
  return html;
}

window.intSetCalView = function(v) { _calView = v; intRenderCalView(); };
window.intCalPrev = function() {
  if (_calView === 'week') _calWeekOffset--;
  else if (_calView === 'month') _calMonthOffset--;
  intRenderCalView();
};
window.intCalNext = function() {
  if (_calView === 'week') _calWeekOffset++;
  else if (_calView === 'month') _calMonthOffset++;
  intRenderCalView();
};
window.intCalToday = function() {
  _calWeekOffset = 0; _calMonthOffset = 0;
  intRenderCalView();
};

async function intLoadDrive() {
  const el = document.getElementById('int-drive-list');
  if (!el) return;
  el.innerHTML = '<div class="spinner-wrap"><div class="spinner"></div></div>';
  try {
    const result = await driveListFiles('', 10);
    const files = result.files || [];
    if (!files.length) { el.innerHTML = '<p style="color:var(--muted);font-size:13px">No files found.</p>'; return; }
    el.innerHTML = files.map(f => {
      const icon = f.mimeType?.includes('folder') ? '📁' :
        f.mimeType?.includes('pdf') ? '📄' :
        f.mimeType?.includes('sheet') ? '📊' :
        f.mimeType?.includes('document') ? '📝' :
        f.mimeType?.includes('image') ? '🖼️' : '📎';
      const modified = f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
      const typeLabel = f.mimeType?.includes('folder') ? 'Folder' : f.mimeType?.split('/').pop()?.replace('vnd.google-apps.','').replace('vnd.openxmlformats-officedocument.','') || 'File';
      return `
        <div class="int-list-row">
          <div style="display:flex;align-items:center;gap:10px;min-width:0;flex:1">
            <span style="font-size:22px;flex-shrink:0">${icon}</span>
            <div style="min-width:0">
              <div class="int-list-row-title">${escapeHtml(f.name)}</div>
              <div class="int-list-row-meta">${typeLabel}${modified ? ' · Modified ' + modified : ''}</div>
            </div>
          </div>
          ${f.webViewLink ? `<a href="${escapeHtml(f.webViewLink)}" target="_blank" rel="noopener" class="int-list-row-link">Open →</a>` : ''}
        </div>
      `;
    }).join('');
  } catch(e) {
    el.innerHTML = `<p style="color:#f87171;font-size:13px">Error: ${escapeHtml(e.message)}</p>`;
  }
}

async function intSearchDrive() {
  const query = document.getElementById('int-drive-search')?.value || '';
  const el = document.getElementById('int-drive-list');
  if (!el) return;
  el.innerHTML = '<div class="spinner-wrap"><div class="spinner"></div></div>';
  try {
    const result = await driveListFiles(query, 15);
    const files = result.files || [];
    if (!files.length) { el.innerHTML = '<p style="color:var(--muted);font-size:13px">No files matching that search.</p>'; return; }
    el.innerHTML = files.map(f => {
      const icon = f.mimeType?.includes('folder') ? '📁' :
        f.mimeType?.includes('pdf') ? '📄' :
        f.mimeType?.includes('sheet') ? '📊' :
        f.mimeType?.includes('document') ? '📝' :
        f.mimeType?.includes('image') ? '🖼️' : '📎';
      return `
        <div class="int-list-row">
          <div style="display:flex;align-items:center;gap:10px;min-width:0;flex:1">
            <span style="font-size:20px;flex-shrink:0">${icon}</span>
            <div style="min-width:0">
              <div class="int-list-row-title">${escapeHtml(f.name)}</div>
              <div class="int-list-row-meta">File</div>
            </div>
          </div>
          ${f.webViewLink ? `<a href="${escapeHtml(f.webViewLink)}" target="_blank" rel="noopener" class="int-list-row-link">Open →</a>` : ''}
        </div>
      `;
    }).join('');
  } catch(e) {
    el.innerHTML = `<p style="color:#f87171;font-size:13px">Error: ${escapeHtml(e.message)}</p>`;
  }
}

// ── Google OAuth connect ──────────────────────────────────────────────────────
async function intSaveClientIdAndConnect() {
  const clientId = document.getElementById('gClientIdInput')?.value?.trim();
  if (!clientId) { showIntToast('Paste your Google Client ID first', 'warn'); return; }
  saveIntState({ googleClientId: clientId });
  const ok = await googleOAuthConnect();
  if (ok) integrations();
}

function intGoogleDisconnect() {
  googleDisconnect();
  integrations();
}

// ── Compose Email ─────────────────────────────────────────────────────────────
function intComposeFromTemplate(prefillTo = '') {
  const modal = document.getElementById('int-compose-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  if (prefillTo) { const el = document.getElementById('int-email-to'); if(el) el.value = prefillTo; }
}

function intFillTemplate() {
  const idx = parseInt(document.getElementById('int-tmpl-select')?.value, 10);
  if (isNaN(idx)) return;
  const tmpl = (window.AVALON_DATA?.templates || [])[idx];
  if (!tmpl) return;
  const subj = document.getElementById('int-email-subject');
  const body = document.getElementById('int-email-body');
  if (subj) subj.value = tmpl.subject || '';
  if (body) body.value = (tmpl.body || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
}

function intOpenInGmail() {
  const to = document.getElementById('int-email-to')?.value || '';
  const subject = document.getElementById('int-email-subject')?.value || '';
  const body = document.getElementById('int-email-body')?.value || '';
  window.open(gmailComposeUrl(to, subject, body), '_blank', 'width=800,height=600');
}

async function intSendEmail() {
  const to = document.getElementById('int-email-to')?.value?.trim();
  const subject = document.getElementById('int-email-subject')?.value?.trim();
  const body = document.getElementById('int-email-body')?.value?.trim();
  if (!to || !subject || !body) { showIntToast('Fill in To, Subject, and Body', 'warn'); return; }
  if (!isGoogleConnected()) { showIntToast('Connect Google first', 'warn'); return; }
  try {
    const htmlBody = body.replace(/\n/g, '<br>');
    await gmailSendEmail({ to, subject, body: htmlBody });
    showIntToast('✅ Email sent!', 'success');
    document.getElementById('int-compose-modal').style.display = 'none';
    intLoadGmail();
  } catch(e) {
    showIntToast(`❌ ${e.message}`, 'error');
  }
}

// ── Calendar event ────────────────────────────────────────────────────────────
function intCreateCalendarEvent(prefill = {}) {
  const modal = document.getElementById('int-cal-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  if (prefill.title) { const el = document.getElementById('int-cal-title'); if(el) el.value = prefill.title; }
  if (prefill.date) { const el = document.getElementById('int-cal-date'); if(el) el.value = prefill.date; }
  if (prefill.attendee) { const el = document.getElementById('int-cal-attendee'); if(el) el.value = prefill.attendee; }
  if (prefill.notes) { const el = document.getElementById('int-cal-notes'); if(el) el.value = prefill.notes; }
}

async function intSubmitCalEvent() {
  const summary = document.getElementById('int-cal-title')?.value?.trim();
  const startDate = document.getElementById('int-cal-date')?.value;
  const startTime = document.getElementById('int-cal-time')?.value || '09:00';
  const durationHours = parseFloat(document.getElementById('int-cal-duration')?.value || '1');
  const attendee = document.getElementById('int-cal-attendee')?.value?.trim();
  const description = document.getElementById('int-cal-notes')?.value?.trim();
  if (!summary || !startDate) { showIntToast('Title and date are required', 'warn'); return; }
  if (!isGoogleConnected()) { showIntToast('Connect Google first', 'warn'); return; }
  try {
    const ev = await calCreateEvent({ summary, description, startDate, startTime, durationHours, attendees: attendee ? [attendee] : [] });
    showIntToast('✅ Event created!', 'success');
    document.getElementById('int-cal-modal').style.display = 'none';
    if (ev.htmlLink) window.open(ev.htmlLink, '_blank');
    intLoadCalendar();
  } catch(e) {
    showIntToast(`❌ ${e.message}`, 'error');
  }
}

// ── Homeworks Visit Modal ─────────────────────────────────────────────────────
function intOpenVisitModal(oppId) {
  const opps = window._avalonState?.opportunities || [];
  const opp = opps.find(o => o.id === oppId);
  if (!opp) { showIntToast('Opportunity not found'); return; }

  const modal = document.getElementById('int-visit-modal');
  if (!modal) return;

  // Pre-fill from opportunity data
  const titleEl = document.getElementById('int-visit-title');
  const dateEl = document.getElementById('int-visit-date');
  const notesEl = document.getElementById('int-visit-notes');
  const clientLabel = document.getElementById('int-visit-client-label');
  const oppIdEl = document.getElementById('int-visit-opp-id');
  const typeEl = document.getElementById('int-visit-type');

  if (oppIdEl) oppIdEl.value = oppId;
  if (clientLabel) clientLabel.textContent = `${opp.client} · ${opp.serviceLine || opp.status}`;
  if (titleEl) titleEl.value = `Site Walk — ${opp.client}`;
  if (dateEl) dateEl.value = opp.nextFollowUp ? opp.nextFollowUp.slice(0,10) : todayISO();
  if (notesEl) notesEl.value = [
    opp.project ? `Project: ${opp.project}` : '',
    opp.desiredOutcome ? `Desired outcome: ${opp.desiredOutcome}` : '',
    opp.address ? `Property: ${opp.address}` : '',
  ].filter(Boolean).join('\n');
  if (typeEl) typeEl.value = 'Site Walk';

  modal.style.display = 'flex';
}

async function intSubmitVisit() {
  const oppId = document.getElementById('int-visit-opp-id')?.value;
  const visitTitle = document.getElementById('int-visit-title')?.value?.trim();
  const visitDate = document.getElementById('int-visit-date')?.value;
  const visitTime = document.getElementById('int-visit-time')?.value || '09:00';
  const visitHours = document.getElementById('int-visit-hours')?.value || '1';
  const visitType = document.getElementById('int-visit-type')?.value || 'Site Walk';
  const visitBilling = document.getElementById('int-visit-billing')?.value || 'Invoice services';
  const visitNotes = document.getElementById('int-visit-notes')?.value?.trim();
  const alsoGcal = document.getElementById('int-visit-gcal-check')?.checked;

  if (!visitDate) { showIntToast('Visit date is required', 'warn'); return; }

  const opps = window._avalonState?.opportunities || [];
  const opp = opps.find(o => o.id === oppId);
  if (!opp) { showIntToast('Opportunity not found'); return; }

  try {
    // Push to Homeworks via Zapier with all visit fields
    await sendToHomeworks('new_visit', {
      visit_title: visitTitle || `Site Walk — ${opp.client}`,
      visit_type: visitType,
      visit_date: visitDate,
      visit_time: visitTime,
      budgeted_hours: visitHours,
      billing_option: visitBilling,
      // Customer fields (Homeworks "Customer *" and "Property *" dropdowns)
      customer_name: opp.client,
      ...splitName(opp.client),
      customer_email: opp.email || '',
      customer_phone: opp.phone || '',
      // Property / Location (maps to Homeworks "Location" field)
      location: opp.address || '',
      ...parseAddress(opp.address || ''),
      // Line item (Homeworks "Name" in Line Items table)
      service_item: opp.serviceLine || 'Site Walk / Consultation',
      // Notes (Homeworks "Description" field)
      description: visitNotes || `Site walk for ${opp.project || opp.serviceLine || 'landscape project'}. ${opp.desiredOutcome || ''}`.trim(),
      // Color indicator for calendar (green = Visit)
      color: '#4ade80',
      // Scheduling type
      scheduling_type: 'Single Visit',
      // Avalon meta
      avalon_id: opp.id,
      avalon_status: opp.status,
      avalon_service_line: opp.serviceLine || ''
    });

    showIntToast(`✅ Visit scheduled for ${opp.client} in Homeworks!`, 'success');

    // Optionally also add to Google Calendar
    if (alsoGcal && isGoogleConnected()) {
      try {
        await calCreateEvent({
          summary: visitTitle || `Site Walk — ${opp.client}`,
          description: [
            visitNotes,
            opp.address ? `Address: ${opp.address}` : '',
            opp.phone ? `Phone: ${opp.phone}` : '',
          ].filter(Boolean).join('\n'),
          startDate: visitDate,
          startTime: visitTime,
          durationHours: parseFloat(visitHours),
          attendees: opp.email ? [opp.email] : []
        });
        showIntToast('✅ Also added to Google Calendar!', 'success');
      } catch(gcalErr) {
        showIntToast(`⚠️ Homeworks ✓ but Calendar failed: ${gcalErr.message}`, 'warn');
      }
    }

    document.getElementById('int-visit-modal').style.display = 'none';
  } catch(e) {
    showIntToast(`❌ ${e.message}`, 'error');
  }
}

// ── Homeworks Estimate Modal ──────────────────────────────────────────────────
function intOpenEstimateModal(oppId) {
  const opps = window._avalonState?.opportunities || [];
  const opp = opps.find(o => o.id === oppId);
  if (!opp) { showIntToast('Opportunity not found'); return; }

  const modal = document.getElementById('int-estimate-modal');
  if (!modal) return;

  const titleEl = document.getElementById('int-est-title');
  const dateEl = document.getElementById('int-est-date');
  const serviceEl = document.getElementById('int-est-service');
  const customerNotesEl = document.getElementById('int-est-customer-notes');
  const internalNotesEl = document.getElementById('int-est-internal-notes');
  const clientLabel = document.getElementById('int-est-client-label');
  const oppIdEl = document.getElementById('int-est-opp-id');

  if (oppIdEl) oppIdEl.value = oppId;
  if (clientLabel) clientLabel.textContent = `${opp.client} · ${opp.serviceLine || opp.status}`;
  if (titleEl) titleEl.value = opp.project || `${opp.serviceLine || 'Landscape'} — ${opp.client}`;
  if (dateEl) dateEl.value = todayISO();
  if (serviceEl && opp.serviceLine) serviceEl.value = opp.serviceLine;
  if (customerNotesEl) customerNotesEl.value = opp.desiredOutcome || '';
  if (internalNotesEl) internalNotesEl.value = [
    opp.budget ? `Budget discussed: ${opp.budget}` : '',
    opp.urgency ? `Urgency: ${opp.urgency}` : '',
    opp.fitConcerns ? `Fit concerns: ${opp.fitConcerns}` : '',
    opp.decisionMaker ? `Decision maker: ${opp.decisionMaker}` : '',
  ].filter(Boolean).join('\n');

  modal.style.display = 'flex';
}

async function intSubmitEstimate() {
  const oppId = document.getElementById('int-est-opp-id')?.value;
  const estTitle = document.getElementById('int-est-title')?.value?.trim();
  const estDate = document.getElementById('int-est-date')?.value;
  const estService = document.getElementById('int-est-service')?.value;
  const customerNotes = document.getElementById('int-est-customer-notes')?.value?.trim();
  const internalNotes = document.getElementById('int-est-internal-notes')?.value?.trim();

  const opps = window._avalonState?.opportunities || [];
  const opp = opps.find(o => o.id === oppId);
  if (!opp) { showIntToast('Opportunity not found'); return; }

  try {
    const { firstName, lastName, businessName } = splitName(opp.client);
    const { street, city, state, zip } = parseAddress(opp.address || '');

    await sendToHomeworks('new_estimate', {
      // Homeworks "Estimate Title / Description" field
      estimate_title: estTitle || `${opp.serviceLine || 'Landscape'} — ${opp.client}`,
      // Homeworks "Customer" dropdown — looked up by name
      customer_name: businessName,
      customer_first_name: firstName,
      customer_last_name: lastName,
      customer_email: opp.email || '',
      customer_phone: opp.phone || '',
      // Homeworks "Estimate Date" field
      estimate_date: estDate || todayISO(),
      // Homeworks "Time Estimate Requested" — defaults to Now
      time_estimate_requested: 'Now',
      // Service / item fields
      service_type: estService || opp.serviceLine || '',
      service_tag: mapServiceLine(estService || opp.serviceLine || ''),
      // Property (Homeworks "Property not assigned" → property address)
      property_address: street,
      property_city: city || 'Vienna',
      property_state: state || 'VA',
      property_zip: zip || '',
      // Homeworks "Notes Visible for Customer" field
      customer_notes: customerNotes || opp.desiredOutcome || '',
      // Internal notes (not shown to customer)
      internal_notes: internalNotes || [
        opp.budget ? `Budget discussed: ${opp.budget}` : '',
        opp.urgency ? `Urgency: ${opp.urgency}` : '',
        opp.source ? `Source: ${opp.source}` : '',
      ].filter(Boolean).join('\n'),
      // Homeworks "Enable Pay in Full Option" — default checked
      enable_pay_in_full: true,
      // Discount % — default 0
      discount_percent: '0.00',
      // Avalon meta
      avalon_id: opp.id,
      avalon_status: opp.status,
      next_follow_up: opp.nextFollowUp || ''
    });

    showIntToast(`✅ Estimate pushed to Homeworks for ${opp.client}!`, 'success');
    document.getElementById('int-estimate-modal').style.display = 'none';

    // Open Homeworks estimates list so they can add line items
    setTimeout(() => {
      if (confirm('Estimate created! Open Homeworks to add pricing and line items?')) {
        window.open('https://secure.copilotcrm.com/finances/estimates', '_blank');
      }
    }, 500);
  } catch(e) {
    showIntToast(`❌ ${e.message}`, 'error');
  }
}

// ── Homeworks interactions ────────────────────────────────────────────────────
function intSaveZapierUrl() {
  const url = document.getElementById('zapierWebhookInput')?.value?.trim();
  if (!url || !url.startsWith('https://hooks.zapier.com')) {
    showIntToast('Paste a valid Zapier webhook URL (https://hooks.zapier.com/…)', 'warn');
    return;
  }
  saveIntState({ zapierWebhookUrl: url });
  showIntToast('✅ Webhook URL saved!', 'success');
  setTimeout(() => integrations(), 600);
}

async function intTestZapier() {
  try {
    await sendToHomeworks('test_ping', { message: 'Hello from Avalon Sales Hub!', time: new Date().toISOString() });
    showIntToast('✅ Test ping sent — check your Zapier task history');
  } catch(e) {
    showIntToast(`❌ ${e.message}`, 'error');
  }
}

async function intPushLead(oppId) {
  const opps = window._avalonState?.opportunities || [];
  const opp = opps.find(o => o.id === oppId);
  if (!opp) { showIntToast('Opportunity not found'); return; }
  try {
    await pushLeadToHomeworks(opp);
    showIntToast(`✅ ${opp.client} pushed to Homeworks CRM`);
  } catch(e) {
    showIntToast(`❌ ${e.message}`, 'error');
  }
}

// ── Quick-access functions exposed for use from other views ───────────────────
// Call these from opportunity cards, email template buttons, etc.
window.intComposeToLead = function(email, clientName) {
  show('integrations');
  setTimeout(() => {
    if (!isGoogleConnected()) {
      showIntToast('Connect Google on the Integrations page first');
      return;
    }
    intComposeFromTemplate(email);
    const subj = document.getElementById('int-email-subject');
    if (subj && !subj.value) subj.value = `Following up — Avalon Landscape Construction`;
  }, 100);
};

window.intScheduleForLead = function(clientName, email, date) {
  show('integrations');
  setTimeout(() => {
    if (!isGoogleConnected()) {
      showIntToast('Connect Google on the Integrations page first');
      return;
    }
    intCreateCalendarEvent({
      title: `Follow-up — ${clientName}`,
      date: date || todayISO(),
      attendee: email || '',
      notes: `Sales follow-up for ${clientName}`
    });
  }, 100);
};

window.intPushOppToHomeworks = function(oppId) {
  intPushLead(oppId);
};

// Expose integrations as a view route
window.integrations = integrations;
window.intSaveClientIdAndConnect = intSaveClientIdAndConnect;
window.intGoogleDisconnect = intGoogleDisconnect;
window.intShowGmail = intShowGmail;
window.intShowCalendar = intShowCalendar;
window.intShowDrive = intShowDrive;
window.intComposeFromTemplate = intComposeFromTemplate;
window.intFillTemplate = intFillTemplate;
window.intOpenInGmail = intOpenInGmail;
window.intSendEmail = intSendEmail;
window.intCreateCalendarEvent = intCreateCalendarEvent;
window.intSubmitCalEvent = intSubmitCalEvent;
window.intSaveZapierUrl = intSaveZapierUrl;
window.intTestZapier = intTestZapier;
window.intPushLead = intPushLead;
window.intSearchDrive = intSearchDrive;
window.intLoadGmail = intLoadGmail;
window.intLoadCalendar = intLoadCalendar;
window.intLoadDrive = intLoadDrive;
// Homeworks enhanced actions
window.intOpenVisitModal = intOpenVisitModal;
window.intSubmitVisit = intSubmitVisit;
window.intOpenEstimateModal = intOpenEstimateModal;
window.intSubmitEstimate = intSubmitEstimate;
