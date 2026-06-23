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

// ── Per-user Google token helpers ────────────────────────────────────────────
// All Google auth now reads from avalonUserGoogleV1[userId] so each rep
// sees only their own Gmail / Calendar / Drive. Falls back to the old shared
// avalonIntegrationsV1 token if a per-user entry doesn't exist yet (migration).
function _getUserGoogleRecord() {
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  if (!rep) return null;
  try {
    const map = JSON.parse(localStorage.getItem('avalonUserGoogleV1') || '{}');
    return map[rep.id] || null;
  } catch(e) { return null; }
}
function getGoogleToken() {
  const rec = _getUserGoogleRecord();
  if (rec && rec.token && Date.now() < (rec.expiry || 0)) return rec.token;
  // Legacy fallback — shared token from old integration flow
  const legacy = getIntState('googleToken');
  if (legacy && Date.now() < (getIntState('googleExpiry') || 0)) return legacy;
  return null;
}
function getGoogleExpiry() {
  const rec = _getUserGoogleRecord();
  if (rec) return rec.expiry || 0;
  return getIntState('googleExpiry') || 0;
}
function isGoogleConnected() { return !!getGoogleToken(); }
function getGoogleClientId() { return getIntState('googleClientId') || ''; }
function getGoogleUserEmail() {
  const rec = _getUserGoogleRecord();
  if (rec && rec.email) return rec.email;
  return getIntState('googleEmail') || '';
}

async function googleOAuthConnect() {
  const clientId = getGoogleClientId();
  if (!clientId) {
    showIntToast('Paste your Google Client ID first (see setup guide)', 'warn');
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
            showIntToast('Google connected', 'success');
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
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  if (rep) {
    try {
      const map = JSON.parse(localStorage.getItem('avalonUserGoogleV1') || '{}');
      delete map[rep.id];
      localStorage.setItem('avalonUserGoogleV1', JSON.stringify(map));
    } catch(e) {}
  }
  // Also clear legacy shared token so old data doesn't leak
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
  // Fetch upcoming events only (for quick widgets)
  const now = new Date().toISOString();
  const r = await gFetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=${maxResults}&timeMin=${encodeURIComponent(now)}&singleEvents=true&orderBy=startTime`);
  return r.json();
}

async function calListAll(maxResults = 250) {
  // Fetch ALL events — past, present, future — ordered by start time.
  // No timeMin so past events are included. updatedMin not set so cancelled events show.
  const r = await gFetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=${maxResults}&singleEvents=true&orderBy=startTime`);
  return r.json();
}

async function calDeleteEvent(eventId) {
  const r = await gFetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE'
  });
  if (!r.ok && r.status !== 204) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error?.message || 'Failed to delete event');
  }
  return true;
}

async function calUpdateEvent(eventId, fields) {
  const r = await gFetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    body: JSON.stringify(fields)
  });
  if (!r.ok) { const e = await r.json(); throw new Error(e.error?.message || 'Update failed'); }
  return r.json();
}

async function gmailGetMessage(messageId) {
  const r = await gFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`);
  return r.json();
}

async function gmailTrashThread(threadId) {
  const r = await gFetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}/trash`, { method: 'POST' });
  if (!r.ok) { const e = await r.json(); throw new Error(e.error?.message || 'Failed to trash thread'); }
  return r.json();
}

async function gmailMarkRead(messageId) {
  const r = await gFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`, {
    method: 'POST',
    body: JSON.stringify({ removeLabelIds: ['UNREAD'] })
  });
  if (!r.ok) { const e = await r.json(); throw new Error(e.error?.message || 'Failed to mark read'); }
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
    ? `<span class="badge" style="background:#00c853;color:#fff">Connected: ${label}</span>`
    : `<span class="badge" style="background:#6b7280;color:#fff">Not Connected</span>`;
}
function iconBtn(icon, label, onclick) {
  return `<button class="secondary-btn" style="gap:6px;display:inline-flex;align-items:center" onclick="${onclick}">${icon} ${label}</button>`;
}

// ── MAIN VIEW: integrations() ─────────────────────────────────────────────────
// State for the workspace hub
let _gwTab = 'gmail';           // 'gmail' | 'calendar' | 'drive'
let _calView = 'month';         // 'agenda' | 'week' | 'month'
let _calEvents = [];
let _calWeekOffset = 0;
let _calMonthOffset = 0;
let _gmailThreads = [];
let _gmailOpenThread = null;    // currently expanded thread id
let _gmailLabel = 'INBOX';      // current label
let _driveFiles = [];

async function integrations() {
  const intView = document.getElementById('view');
  const googleOk = isGoogleConnected();
  const hwOk = isHomeworksConnected();
  const googleEmail = getGoogleUserEmail();
  const currentRep = window.getCurrentRep ? window.getCurrentRep() : null;
  const repName = currentRep ? (currentRep.name || 'You') : 'You';
  const repColor = currentRep ? (currentRep.color || '#00A7E1') : '#00A7E1';
  const clientIdConfigured = !!getGoogleClientId();

  if (!googleOk) {
    // ── NOT CONNECTED — show connect screen ───────────────────────────────────
    intView.innerHTML = `
<div class="eyebrow">Connected Tools</div>
<h1>Google Workspace</h1>
<p class="lede">Connect <strong>${escapeHtml(repName)}'s</strong> Google account to access Gmail, Calendar, and Drive directly inside the hub. Each team member connects their own account — completely private.</p>

<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px;margin-top:24px">
  <div style="background:#0f172a;border:1px solid #1e293b;border-radius:16px;padding:28px">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px">
      <img src="https://www.google.com/favicon.ico" style="width:32px;height:32px" alt="Google">
      <div>
        <div style="font-weight:800;font-size:18px;color:#e2e8f0">Connect ${escapeHtml(repName)}'s Google</div>
        <div style="font-size:12px;color:${repColor};margin-top:2px;font-weight:600">${escapeHtml(repName)}'s workspace — private to you</div>
      </div>
    </div>
    <p style="color:#64748b;font-size:13px;line-height:1.7;margin:0 0 20px">
      Sign in with your Google account. Your Gmail, Calendar, and Drive are fully accessible inside the hub.
      Other users connect their own accounts separately — no shared access.
    </p>
    ${!clientIdConfigured ? `
    <div style="padding:12px 14px;background:#1c1a0a;border:1px solid #f59e0b40;border-radius:8px;margin-bottom:16px;font-size:13px;color:#f59e0b">
      ⚠ Google Client ID not configured. Ask Tyler (Admin) to set it up in
      <strong>Admin → User Management → Workspace Connections</strong>.
    </div>` : ''}
    <button class="primary-btn" style="width:100%;justify-content:center;font-size:14px;padding:12px 20px;${!clientIdConfigured?'opacity:.5;cursor:not-allowed':''}"
      ${!clientIdConfigured?'disabled':''} onclick="intSaveClientIdAndConnect()">
      <svg width="18" height="18" viewBox="0 0 18 18" style="vertical-align:-3px;margin-right:8px"><path d="M16.51 8H8.98v3h4.3c-.18 1-.74 1.48-1.6 2.04v2.01h2.6A7.8 7.8 0 0 0 17 9c0-.46-.05-.86-.09-1z" fill="#4285F4"/><path d="M8.98 17c2.16 0 3.97-.72 5.3-1.94l-2.6-2.04c-.71.48-1.62.77-2.7.77-2.08 0-3.84-1.4-4.47-3.28H1.8v2.07A8 8 0 0 0 8.98 17z" fill="#34A853"/><path d="M4.51 10.51A4.8 4.8 0 0 1 4.26 9c0-.53.09-1.04.25-1.51V5.42H1.8A8 8 0 0 0 .98 9c0 1.29.31 2.51.82 3.58l2.71-2.07z" fill="#FBBC05"/><path d="M8.98 3.58c1.17 0 2.23.4 3.06 1.2l2.3-2.3A8 8 0 0 0 8.98 1 8 8 0 0 0 1.8 5.42l2.71 2.07c.63-1.89 2.39-3.91 4.47-3.91z" fill="#EA4335"/></svg>
      Sign in with Google
    </button>

    <div style="margin-top:20px;padding:14px;background:#0a0f1a;border:1px solid #1e293b;border-radius:10px">
      <div style="font-size:11px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">What you'll get access to</div>
      ${[['✉️','Gmail','Read, compose, reply, and send emails directly inside the hub'],
         ['📅','Calendar','Full calendar — past, present, future. Create and edit events in-hub'],
         ['📁','Drive','Browse, search, and open your Drive files without leaving the app']
        ].map(([ic,nm,desc])=>`
      <div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #1e293b">
        <span style="font-size:18px;flex-shrink:0">${ic}</span>
        <div><div style="font-weight:600;font-size:13px;color:#e2e8f0">${nm}</div><div style="font-size:12px;color:#64748b;margin-top:1px">${desc}</div></div>
      </div>`).join('')}
    </div>
  </div>

  <!-- Homeworks always accessible -->
  <div style="background:#0f172a;border:1px solid #1e293b;border-radius:16px;padding:28px">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
      <div style="width:32px;height:32px;background:#1e293b;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px">🏗️</div>
      <div>
        <div style="font-weight:800;font-size:16px;color:#e2e8f0">Homeworks CRM</div>
        ${hwOk?`<div style="font-size:11px;font-weight:700;color:#4ade80;margin-top:2px">● Connected via Zapier</div>`:`<div style="font-size:11px;color:#64748b;margin-top:2px">Not connected</div>`}
      </div>
    </div>
    <p style="color:#64748b;font-size:13px;line-height:1.7;margin:0 0 14px">Push leads, estimates, and site visits to Homeworks CRM via Zapier webhook.</p>
    <label style="font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.05em">ZAPIER WEBHOOK URL</label>
    <input id="zapierWebhookInput" type="url"
      placeholder="https://hooks.zapier.com/hooks/catch/…"
      value="${escapeHtml(getZapierWebhookUrl())}"
      style="width:100%;margin-top:6px;padding:10px 12px;background:#1e293b;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px;box-sizing:border-box">
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="primary-btn" onclick="intSaveZapierUrl()">Save URL</button>
      ${hwOk?`<button class="secondary-btn" onclick="intTestZapier()">Send Test Ping</button>`:''}
    </div>
  </div>
</div>`;
    return;
  }

  // ── CONNECTED — render full workspace hub ─────────────────────────────────
  intView.innerHTML = `
<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:20px">
  <div>
    <div class="eyebrow">Google Workspace</div>
    <h1 style="margin:2px 0 0">Workspace Hub</h1>
    <div style="font-size:13px;color:#64748b;margin-top:3px">
      Signed in as <strong style="color:${repColor}">${escapeHtml(googleEmail)}</strong> · ${escapeHtml(repName)}'s private connection
    </div>
  </div>
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
    <button class="secondary-btn" style="font-size:12px" onclick="intGoogleDisconnect()">Disconnect Google</button>
  </div>
</div>

<!-- Tab bar -->
<div style="display:flex;gap:0;border-bottom:2px solid #1e293b;margin-bottom:0">
  ${[['gmail','✉️ Gmail'],['calendar','📅 Calendar'],['drive','📁 Drive'],['homeworks','🏗️ Homeworks']].map(([id,label])=>`
  <button id="gw-tab-${id}" onclick="gwSwitchTab('${id}')"
    style="padding:10px 20px;font-size:13px;font-weight:600;background:none;border:none;cursor:pointer;border-bottom:2px solid ${_gwTab===id?'#00A7E1':'transparent'};color:${_gwTab===id?'#00A7E1':'#64748b'};margin-bottom:-2px;transition:all .15s">
    ${label}
  </button>`).join('')}
</div>

<!-- Tab content panels -->
<div id="gw-panel-gmail"  style="display:${_gwTab==='gmail'   ?'block':'none'};padding-top:20px"></div>
<div id="gw-panel-calendar" style="display:${_gwTab==='calendar'?'block':'none'};padding-top:20px"></div>
<div id="gw-panel-drive"  style="display:${_gwTab==='drive'   ?'block':'none'};padding-top:20px"></div>
<div id="gw-panel-homeworks" style="display:${_gwTab==='homeworks'?'block':'none'};padding-top:20px"></div>
`;

  // Load active tab
  gwRenderActiveTab();
}

// ── Tab switching ─────────────────────────────────────────────────────────────
window.gwSwitchTab = function(tab) {
  _gwTab = tab;
  ['gmail','calendar','drive','homeworks'].forEach(id => {
    const panel = document.getElementById(`gw-panel-${id}`);
    const btn   = document.getElementById(`gw-tab-${id}`);
    if (panel) panel.style.display = id === tab ? 'block' : 'none';
    if (btn)   { btn.style.borderBottomColor = id===tab?'#00A7E1':'transparent'; btn.style.color = id===tab?'#00A7E1':'#64748b'; }
  });
  gwRenderActiveTab();
};

function gwRenderActiveTab() {
  if (_gwTab === 'gmail')      gwRenderGmail();
  if (_gwTab === 'calendar')   gwRenderCalendar();
  if (_gwTab === 'drive')      gwRenderDrive();
  if (_gwTab === 'homeworks')  gwRenderHomeworks();
}

// ════════════════════════════════════════════════════════════════════════════════
// GMAIL PANEL
// ════════════════════════════════════════════════════════════════════════════════
function gwRenderGmail() {
  const el = document.getElementById('gw-panel-gmail');
  if (!el) return;
  el.innerHTML = `
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:10px">
  <div style="display:flex;gap:6px;flex-wrap:wrap">
    ${[['INBOX','Inbox'],['SENT','Sent'],['STARRED','Starred'],['UNREAD','Unread'],['DRAFT','Drafts']].map(([l,label])=>`
    <button onclick="gwGmailSetLabel('${l}')"
      style="padding:5px 14px;border-radius:20px;font-size:12px;font-weight:600;cursor:pointer;transition:all .12s;
      ${_gmailLabel===l?'background:#00A7E1;color:#fff;border:1.5px solid #00A7E1':'background:#0f172a;color:#94a3b8;border:1.5px solid #1e293b'}">
      ${label}
    </button>`).join('')}
  </div>
  <button class="primary-btn" style="font-size:12px;padding:7px 14px" onclick="gwOpenCompose()">✉️ Compose</button>
</div>
<div id="gw-gmail-list" style="min-height:200px"><div class="spinner-wrap"><div class="spinner"></div></div></div>`;

  gwLoadGmail();
}

window.gwGmailSetLabel = function(label) {
  _gmailLabel = label;
  _gmailOpenThread = null;
  gwRenderGmail();
};

async function gwLoadGmail() {
  const el = document.getElementById('gw-gmail-list');
  if (!el) return;
  el.innerHTML = '<div class="spinner-wrap"><div class="spinner"></div></div>';
  try {
    const labelParam = _gmailLabel === 'UNREAD' ? '&q=is:unread' : `&labelIds=${_gmailLabel}`;
    const r = await gFetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads?maxResults=20${labelParam}`);
    const data = await r.json();
    const threads = data.threads || [];
    if (!threads.length) { el.innerHTML = `<div style="text-align:center;padding:40px;color:#475569">No messages in ${_gmailLabel.toLowerCase()}.</div>`; return; }

    const metaList = await Promise.all(
      threads.map(t => gmailGetThread(t.id).catch(() => null))
    );
    _gmailThreads = metaList.filter(Boolean);
    gwRenderThreadList(el);
  } catch(e) {
    el.innerHTML = `<div style="color:#f87171;padding:20px;font-size:13px">Error loading Gmail: ${escapeHtml(e.message)}</div>`;
  }
}

function gwRenderThreadList(el) {
  if (!el) el = document.getElementById('gw-gmail-list');
  if (!el) return;

  if (_gmailOpenThread) {
    gwRenderThreadDetail(el, _gmailOpenThread);
    return;
  }

  el.innerHTML = _gmailThreads.map(thread => {
    const msg = thread.messages?.[thread.messages.length - 1];
    const firstMsg = thread.messages?.[0];
    const headers = msg?.payload?.headers || [];
    const firstHeaders = firstMsg?.payload?.headers || [];
    const subj = (firstHeaders.find(h=>h.name==='Subject') || headers.find(h=>h.name==='Subject'))?.value || '(no subject)';
    const from = headers.find(h=>h.name==='From')?.value || '';
    const date = headers.find(h=>h.name==='Date')?.value || '';
    const isUnread = msg?.labelIds?.includes('UNREAD');
    const count = thread.messages?.length || 1;
    const sender = from.replace(/<[^>]+>/, '').replace(/"/g,'').trim() || from.match(/<(.+)>/)?.[1] || from;
    const d = date ? (() => {
      const dt = new Date(date);
      const now = new Date();
      if (dt.toDateString() === now.toDateString()) return dt.toLocaleTimeString(undefined, {hour:'numeric',minute:'2-digit'});
      return dt.toLocaleDateString(undefined, {month:'short', day:'numeric'});
    })() : '';

    // Snippet
    let snippet = '';
    try {
      const body = msg?.payload?.parts?.[0]?.body?.data || msg?.payload?.body?.data || '';
      if (body) snippet = atob(body.replace(/-/g,'+').replace(/_/g,'/')).replace(/<[^>]+>/g,'').trim().slice(0,80);
      else snippet = msg?.snippet || '';
    } catch(e) { snippet = msg?.snippet || ''; }

    return `<div onclick="gwOpenThread('${thread.id}')"
      style="display:flex;align-items:flex-start;gap:12px;padding:12px 14px;border-bottom:1px solid #1e293b;cursor:pointer;background:${isUnread?'#0f172a':'#0a0f1a'};transition:background .1s"
      onmouseover="this.style.background='#1e293b'" onmouseout="this.style.background='${isUnread?'#0f172a':'#0a0f1a'}'">
      <div style="width:8px;height:8px;border-radius:50%;background:${isUnread?'#00A7E1':'transparent'};border:${isUnread?'none':'1px solid #334155'};margin-top:6px;flex-shrink:0"></div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
          <div style="font-size:13px;font-weight:${isUnread?'700':'500'};color:${isUnread?'#e2e8f0':'#94a3b8'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(sender)}</div>
          <div style="font-size:11px;color:#475569;flex-shrink:0">${d}${count>1?` <span style="background:#1e293b;border-radius:10px;padding:1px 5px">${count}</span>`:''}</div>
        </div>
        <div style="font-size:13px;color:${isUnread?'#e2e8f0':'#64748b'};font-weight:${isUnread?'600':'400'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px">${escapeHtml(subj)}</div>
        <div style="font-size:12px;color:#475569;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px">${escapeHtml(snippet)}</div>
      </div>
    </div>`;
  }).join('');
}

window.gwOpenThread = async function(threadId) {
  _gmailOpenThread = threadId;
  const el = document.getElementById('gw-gmail-list');
  if (!el) return;
  el.innerHTML = '<div class="spinner-wrap"><div class="spinner"></div></div>';
  try {
    const r = await gFetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`);
    const thread = await r.json();
    gwRenderThreadDetail(el, threadId, thread);
  } catch(e) {
    el.innerHTML = `<div style="color:#f87171;padding:20px">${escapeHtml(e.message)}</div>`;
  }
};

function gwDecodeBody(payload) {
  // Recursively find the best body part (prefer text/html, fallback text/plain)
  function findParts(p, type) {
    if (p.mimeType === type && p.body?.data) return p.body.data;
    if (p.parts) { for (const sub of p.parts) { const r = findParts(sub, type); if (r) return r; } }
    return null;
  }
  const html = findParts(payload, 'text/html') || findParts(payload, 'text/plain');
  if (!html) return '';
  try {
    return atob(html.replace(/-/g,'+').replace(/_/g,'/'));
  } catch(e) { return ''; }
}

function gwRenderThreadDetail(el, threadId, thread) {
  if (!thread) {
    // Already have in cache — find from _gmailThreads
    thread = _gmailThreads.find(t => t.id === threadId);
    if (!thread) { el.innerHTML = '<div style="color:#f87171;padding:20px">Thread not found</div>'; return; }
  }

  const msgs = thread.messages || [];
  const firstHeaders = msgs[0]?.payload?.headers || [];
  const subj = firstHeaders.find(h=>h.name==='Subject')?.value || '(no subject)';

  el.innerHTML = `
<div style="margin-bottom:16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
  <button onclick="gwBackToList()" style="background:#0f172a;border:1px solid #334155;color:#94a3b8;border-radius:8px;padding:7px 14px;cursor:pointer;font-size:13px">← Back</button>
  <div style="font-size:16px;font-weight:700;color:#e2e8f0;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(subj)}</div>
  <button onclick="gwTrashThread('${threadId}')" style="background:transparent;border:1px solid #7f1d1d;color:#f87171;border-radius:8px;padding:6px 12px;cursor:pointer;font-size:12px">🗑 Trash</button>
</div>
<div style="display:flex;flex-direction:column;gap:10px;max-height:60vh;overflow-y:auto" id="gw-thread-msgs">
${msgs.map((msg, idx) => {
  const h = msg.payload?.headers || [];
  const from = h.find(x=>x.name==='From')?.value || '';
  const to   = h.find(x=>x.name==='To')?.value || '';
  const date = h.find(x=>x.name==='Date')?.value || '';
  const sender = from.replace(/<[^>]+>/,'').replace(/"/g,'').trim() || from;
  const dt = date ? new Date(date).toLocaleString(undefined, {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : '';
  const bodyRaw = gwDecodeBody(msg.payload);
  const isLast = idx === msgs.length - 1;
  const collapsed = !isLast && msgs.length > 1;

  return `<div style="background:#0f172a;border:1px solid #1e293b;border-radius:10px;overflow:hidden">
    <div style="display:flex;align-items:center;gap:10px;padding:12px 14px;${collapsed?'cursor:pointer':''}"
      ${collapsed?`onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'"`:''}>
      <div style="width:32px;height:32px;border-radius:50%;background:#1e293b;display:flex;align-items:center;justify-content:center;font-weight:700;color:#94a3b8;font-size:13px;flex-shrink:0">${escapeHtml(sender[0]?.toUpperCase()||'?')}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:13px;color:#e2e8f0">${escapeHtml(sender)}</div>
        <div style="font-size:11px;color:#475569">to ${escapeHtml(to)} · ${dt}</div>
      </div>
      ${collapsed?'<span style="color:#475569;font-size:12px">click to expand</span>':''}
    </div>
    <div style="padding:0 14px 14px;${collapsed?'display:none':''}">
      ${bodyRaw
        ? `<iframe srcdoc="${bodyRaw.replace(/"/g,'&quot;').replace(/\n/g,' ')}"
            style="width:100%;min-height:200px;border:none;background:#fff;border-radius:6px"
            onload="this.style.height=Math.min(this.contentDocument.body.scrollHeight+20,600)+'px'"></iframe>`
        : `<div style="font-size:13px;color:#94a3b8;padding:8px 0">${escapeHtml(msg.snippet||'(no content)')}</div>`
      }
    </div>
  </div>`;
}).join('')}
</div>
<div style="margin-top:16px;background:#0f172a;border:1px solid #334155;border-radius:12px;padding:16px" id="gw-reply-box">
  <div style="font-size:12px;font-weight:600;color:#64748b;margin-bottom:8px">Reply</div>
  <textarea id="gw-reply-body" rows="4" placeholder="Write your reply…"
    style="width:100%;padding:10px 12px;background:#1e293b;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px;box-sizing:border-box;resize:vertical;font-family:inherit"></textarea>
  <div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end">
    <button class="secondary-btn" onclick="gwOpenCompose('','${escapeHtml(subj).replace(/'/g,"\\'")}')">New Email</button>
    <button class="primary-btn" onclick="gwSendReply('${threadId}','${msgs[msgs.length-1]?.id||''}')">Send Reply</button>
  </div>
</div>`;
}

window.gwBackToList = function() {
  _gmailOpenThread = null;
  const el = document.getElementById('gw-gmail-list');
  if (el) gwRenderThreadList(el);
};

window.gwTrashThread = async function(threadId) {
  if (!confirm('Move this thread to Trash?')) return;
  try {
    await gmailTrashThread(threadId);
    showIntToast('Thread moved to Trash');
    _gmailOpenThread = null;
    _gmailThreads = _gmailThreads.filter(t => t.id !== threadId);
    const el = document.getElementById('gw-gmail-list');
    if (el) gwRenderThreadList(el);
  } catch(e) { showIntToast(e.message, 'error'); }
};

window.gwSendReply = async function(threadId, lastMessageId) {
  const body = document.getElementById('gw-reply-body')?.value?.trim();
  if (!body) { showIntToast('Write your reply first', 'warn'); return; }
  const thread = _gmailThreads.find(t=>t.id===threadId);
  const msgs = thread?.messages || [];
  const lastMsg = msgs[msgs.length-1];
  const headers = lastMsg?.payload?.headers || [];
  const from = headers.find(h=>h.name==='From')?.value || '';
  const subj = headers.find(h=>h.name==='Subject')?.value || '';
  const toAddr = from.match(/<(.+)>/)?.[1] || from;
  const replySubj = subj.startsWith('Re:') ? subj : `Re: ${subj}`;
  try {
    const btn = document.querySelector('#gw-reply-box .primary-btn');
    if (btn) { btn.textContent = 'Sending…'; btn.disabled = true; }
    await gmailSendEmail({ to: toAddr, subject: replySubj, body: body.replace(/\n/g,'<br>'), replyToMessageId: lastMessageId });
    showIntToast('Reply sent ✅');
    document.getElementById('gw-reply-body').value = '';
    // Refresh the thread
    setTimeout(() => gwOpenThread(threadId), 800);
  } catch(e) {
    showIntToast(e.message, 'error');
    const btn = document.querySelector('#gw-reply-box .primary-btn');
    if (btn) { btn.textContent = 'Send Reply'; btn.disabled = false; }
  }
};

// ── Compose modal ──────────────────────────────────────────────────────────────
window.gwOpenCompose = function(prefillTo='', prefillSubject='') {
  document.getElementById('int-compose-modal').style.display='flex';
  const toEl = document.getElementById('int-email-to');
  const subjEl = document.getElementById('int-email-subject');
  if (toEl && prefillTo) toEl.value = prefillTo;
  if (subjEl && prefillSubject) subjEl.value = prefillSubject;
};

// Keep legacy aliases
function intShowGmail()    { gwSwitchTab('gmail'); }
function intShowCalendar() { gwSwitchTab('calendar'); }
function intShowDrive()    { gwSwitchTab('drive'); }
function intComposeFromTemplate(prefillTo='') { gwOpenCompose(prefillTo); }
function intLoadGmail()    { gwLoadGmail(); }
function intLoadCalendar() { gwLoadCalendarEvents(); }
function intLoadDrive()    { gwLoadDrive(); }

// ════════════════════════════════════════════════════════════════════════════════
// CALENDAR PANEL
// ════════════════════════════════════════════════════════════════════════════════
function gwRenderCalendar() {
  const el = document.getElementById('gw-panel-calendar');
  if (!el) return;
  el.innerHTML = `
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:10px">
  <div style="display:flex;gap:4px">
    ${[['month','Month'],['week','Week'],['agenda','Agenda']].map(([v,l])=>`
    <button onclick="gwCalSetView('${v}')"
      style="padding:6px 14px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;
      ${_calView===v?'background:#00A7E1;color:#fff;border:1.5px solid #00A7E1':'background:#0f172a;color:#94a3b8;border:1.5px solid #1e293b'}">
      ${l}
    </button>`).join('')}
  </div>
  <div style="display:flex;gap:6px;align-items:center">
    <button onclick="gwCalPrev()" style="background:#0f172a;border:1px solid #334155;color:#94a3b8;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px">‹</button>
    <span id="gw-cal-label" style="font-size:13px;font-weight:700;color:#e2e8f0;min-width:140px;text-align:center"></span>
    <button onclick="gwCalNext()" style="background:#0f172a;border:1px solid #334155;color:#94a3b8;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px">›</button>
    <button onclick="gwCalGoToday()" style="background:#0f172a;border:1px solid #00A7E1;color:#00A7E1;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:12px;font-weight:700">Today</button>
  </div>
  <button class="primary-btn" style="font-size:12px;padding:7px 14px" onclick="intCreateCalendarEvent()">+ New Event</button>
</div>
<div id="gw-cal-body" style="min-height:300px"><div class="spinner-wrap"><div class="spinner"></div></div></div>`;

  gwLoadCalendarEvents();
}

async function gwLoadCalendarEvents() {
  const el = document.getElementById('gw-cal-body');
  if (!el) return;
  el.innerHTML = '<div class="spinner-wrap"><div class="spinner"></div></div>';
  try {
    // Fetch ALL events — past and future
    const data = await calListAll(250);
    _calEvents = data.items || [];
    gwRenderCalBody();
  } catch(e) {
    el.innerHTML = `<div style="color:#f87171;padding:20px;font-size:13px">Error: ${escapeHtml(e.message)}</div>`;
  }
}

window.gwCalSetView   = function(v) { _calView=v; gwRenderCalBody(); };
window.gwCalGoToday   = function() { _calWeekOffset=0; _calMonthOffset=0; gwRenderCalBody(); };
window.gwCalPrev      = function() { if(_calView==='week') _calWeekOffset--; else if(_calView==='month') _calMonthOffset--; gwRenderCalBody(); };
window.gwCalNext      = function() { if(_calView==='week') _calWeekOffset++; else if(_calView==='month') _calMonthOffset++; gwRenderCalBody(); };

// Keep legacy aliases
window.intSetCalView = window.gwCalSetView;
window.intCalPrev    = window.gwCalPrev;
window.intCalNext    = window.gwCalNext;
window.intCalToday   = window.gwCalGoToday;

function gwRenderCalBody() {
  const el = document.getElementById('gw-cal-body');
  if (!el) return;

  // Update view toggle active states
  ['month','week','agenda'].forEach(v => {
    const btn = document.querySelector(`button[onclick="gwCalSetView('${v}')"]`);
    if (btn) {
      btn.style.background = v===_calView?'#00A7E1':'#0f172a';
      btn.style.color      = v===_calView?'#fff':'#94a3b8';
      btn.style.borderColor= v===_calView?'#00A7E1':'#1e293b';
    }
  });

  // Update label
  const labelEl = document.getElementById('gw-cal-label');
  if (labelEl) {
    const today = new Date();
    if (_calView==='agenda') labelEl.textContent = 'All Events';
    else if (_calView==='week') {
      const ws = new Date(today); ws.setDate(today.getDate() - today.getDay() + _calWeekOffset*7);
      const we = new Date(ws); we.setDate(ws.getDate()+6);
      labelEl.textContent = ws.toLocaleDateString(undefined,{month:'short',day:'numeric'})+' – '+we.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});
    } else {
      const d = new Date(today.getFullYear(), today.getMonth()+_calMonthOffset, 1);
      labelEl.textContent = d.toLocaleDateString(undefined,{month:'long',year:'numeric'});
    }
  }

  if (_calView==='agenda') el.innerHTML = gwRenderAgendaAll();
  else if (_calView==='week') el.innerHTML = gwRenderWeek();
  else el.innerHTML = gwRenderMonth();
}

function gwEventColor(ev) {
  // Use Google's colorId if present
  const colors = {1:'#7986cb',2:'#33b679',3:'#8e24aa',4:'#e67c73',5:'#f6c026',6:'#f5511d',7:'#039be5',8:'#616161',9:'#3f51b5',10:'#0b8043',11:'#d60000'};
  if (ev.colorId && colors[ev.colorId]) return colors[ev.colorId];
  return '#00A7E1';
}

function gwRenderAgendaAll() {
  // Show ALL events grouped by month, with past events clearly labeled
  if (!_calEvents.length) return '<div style="text-align:center;padding:40px;color:#475569">No events found in your calendar.</div>';

  const today = new Date(); today.setHours(0,0,0,0);
  const byMonth = {};
  _calEvents.forEach(ev => {
    const start = ev.start?.dateTime || ev.start?.date || '';
    if (!start) return;
    const d = new Date(start);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    if (!byMonth[key]) byMonth[key] = [];
    byMonth[key].push(ev);
  });

  const keys = Object.keys(byMonth).sort();
  return `<div style="display:flex;flex-direction:column;gap:24px;max-height:70vh;overflow-y:auto;padding-right:4px">` +
  keys.map(key => {
    const [yr, mo] = key.split('-').map(Number);
    const monthDate = new Date(yr, mo-1, 1);
    const monthLabel = monthDate.toLocaleDateString(undefined,{month:'long',year:'numeric'});
    const isPast = new Date(yr, mo, 0) < today; // last day of month < today
    return `
    <div>
      <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:${isPast?'#475569':'#94a3b8'};margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #1e293b">
        ${monthLabel}${isPast?' · Past':''}
      </div>
      ${byMonth[key].map(ev => {
        const start = ev.start?.dateTime || ev.start?.date || '';
        const end   = ev.end?.dateTime   || ev.end?.date   || '';
        const isAllDay = !ev.start?.dateTime;
        const evDate = new Date(start);
        const isPastEv = evDate < today;
        const isToday  = evDate.toDateString()===new Date().toDateString();
        const color = gwEventColor(ev);
        const timeStr = isAllDay ? 'All day' :
          new Date(start).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}) +
          (end ? ' – '+new Date(end).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}) : '');
        const dayStr = evDate.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'});
        return `<div onclick="gwCalEventClick('${escapeHtml(ev.id)}')"
          style="display:flex;gap:12px;padding:10px 12px;border-radius:8px;cursor:pointer;
          background:${isToday?color+'18':isPastEv?'#0a0f1a':'#0f172a'};
          border:1px solid ${isToday?color+'60':isPastEv?'#1e293b':'#1e293b'};
          opacity:${isPastEv&&!isToday?.7:1};transition:background .1s"
          onmouseover="this.style.background='${color}18'" onmouseout="this.style.background='${isToday?color+'18':isPastEv?'#0a0f1a':'#0f172a'}'">
          <div style="width:3px;border-radius:2px;background:${color};flex-shrink:0;align-self:stretch;min-height:24px"></div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:${isPastEv&&!isToday?'#64748b':'#e2e8f0'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(ev.summary||'(No title)')}</div>
            <div style="font-size:11px;color:#475569;margin-top:2px">${dayStr} · ${timeStr}${ev.location?' · '+escapeHtml(ev.location.slice(0,40)):''}</div>
          </div>
          ${isToday?`<span style="font-size:10px;font-weight:700;color:${color};background:${color}22;border-radius:10px;padding:2px 8px;flex-shrink:0;align-self:center">TODAY</span>`:''}
        </div>`;
      }).join('')}
    </div>`;
  }).join('') + '</div>';
}

function gwRenderWeek() {
  const today = new Date();
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay() + _calWeekOffset*7);
  weekStart.setHours(0,0,0,0);
  const days = Array.from({length:7}, (_,i) => { const d=new Date(weekStart); d.setDate(weekStart.getDate()+i); return d; });
  const hours = Array.from({length:24}, (_,i) => i); // all 24h
  const dowLabels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  let html = `<div style="overflow-x:auto"><div style="display:grid;grid-template-columns:52px repeat(7,1fr);min-width:600px">
    <div style="background:#0a0f1a;border-bottom:1px solid #1e293b"></div>
    ${days.map(d => {
      const isToday = d.toDateString()===today.toDateString();
      const isPast  = d < today && !isToday;
      return `<div style="padding:8px 4px;text-align:center;border-bottom:1px solid #1e293b;border-left:1px solid #1e293b;background:#0a0f1a">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:${isPast?'#334155':'#64748b'}">${dowLabels[d.getDay()]}</div>
        <div style="font-size:18px;font-weight:800;color:${isToday?'#00A7E1':isPast?'#334155':'#e2e8f0'};width:28px;height:28px;border-radius:50%;background:${isToday?'#00A7E122':'transparent'};display:flex;align-items:center;justify-content:center;margin:2px auto 0">${d.getDate()}</div>
      </div>`;
    }).join('')}
    ${hours.map(h => {
      const label = h===0?'12 AM':h<12?`${h} AM`:h===12?'12 PM':`${h-12} PM`;
      const isCurrentHour = h===today.getHours() && _calWeekOffset===0;
      return `
        <div style="padding:2px 4px;text-align:right;font-size:10px;color:#475569;border-top:1px solid #0f172a;line-height:36px;height:36px;box-sizing:border-box;${isCurrentHour?'color:#00A7E1':''}">${label}</div>
        ${days.map(d => {
          const cellEvs = _calEvents.filter(ev => {
            if (!ev.start?.dateTime) return false;
            const s = new Date(ev.start.dateTime);
            return s.getFullYear()===d.getFullYear()&&s.getMonth()===d.getMonth()&&s.getDate()===d.getDate()&&s.getHours()===h;
          });
          const isNowCell = isCurrentHour && d.toDateString()===today.toDateString();
          return `<div style="border-top:1px solid #0f172a;border-left:1px solid #1e293b;height:36px;position:relative;background:${isNowCell?'#00A7E108':'transparent'}">
            ${cellEvs.map(ev=>{
              const color=gwEventColor(ev);
              const t=new Date(ev.start.dateTime).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
              return `<div onclick="gwCalEventClick('${escapeHtml(ev.id)}')" title="${escapeHtml(ev.summary||'')}" style="position:absolute;inset:1px 1px auto;background:${color};border-radius:3px;padding:1px 4px;font-size:10px;font-weight:600;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;z-index:1">${t} ${escapeHtml((ev.summary||'Event').slice(0,18))}</div>`;
            }).join('')}
          </div>`;
        }).join('')}`;
    }).join('')}
  </div></div>`;
  return html;
}

function gwRenderMonth() {
  const today = new Date();
  const viewDate = new Date(today.getFullYear(), today.getMonth()+_calMonthOffset, 1);
  const year=viewDate.getFullYear(), month=viewDate.getMonth();
  const firstDay = new Date(year,month,1).getDay();
  const daysInMonth = new Date(year,month+1,0).getDate();
  const dowLabels=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  let html = `<div style="display:grid;grid-template-columns:repeat(7,1fr);border-left:1px solid #1e293b;border-top:1px solid #1e293b">
    ${dowLabels.map(d=>`<div style="padding:6px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#475569;border-right:1px solid #1e293b;border-bottom:1px solid #1e293b">${d}</div>`).join('')}
    ${Array.from({length:firstDay},()=>`<div style="border-right:1px solid #1e293b;border-bottom:1px solid #1e293b;min-height:80px;background:#060a12"></div>`).join('')}
    ${Array.from({length:daysInMonth},(_,i)=>{
      const day=i+1;
      const cellDate=new Date(year,month,day);
      const isToday=cellDate.toDateString()===today.toDateString();
      const isPast=cellDate<new Date(today.getFullYear(),today.getMonth(),today.getDate());
      const dayEvs=_calEvents.filter(ev=>{
        const s=ev.start?.dateTime||ev.start?.date||''; if(!s) return false;
        const d=new Date(s); return d.getFullYear()===year&&d.getMonth()===month&&d.getDate()===day;
      });
      return `<div style="border-right:1px solid #1e293b;border-bottom:1px solid #1e293b;min-height:80px;padding:4px;background:${isToday?'#00A7E108':isPast?'#060a12':'#0a0f1a'}">
        <div style="font-size:13px;font-weight:${isToday?'800':'500'};color:${isToday?'#00A7E1':isPast?'#334155':'#94a3b8'};width:24px;height:24px;border-radius:50%;background:${isToday?'#00A7E133':'transparent'};display:flex;align-items:center;justify-content:center;margin-bottom:3px">${day}</div>
        ${dayEvs.slice(0,3).map(ev=>{
          const color=gwEventColor(ev);
          const isAllDay=!ev.start?.dateTime;
          const t=isAllDay?'All day':new Date(ev.start.dateTime).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
          return `<div onclick="gwCalEventClick('${escapeHtml(ev.id)}')" title="${escapeHtml(ev.summary||'')}"
            style="background:${color}22;border-left:2px solid ${color};border-radius:3px;padding:2px 4px;font-size:10px;font-weight:600;color:${color};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;margin-bottom:2px">
            ${t} ${escapeHtml((ev.summary||'Event').slice(0,16))}
          </div>`;
        }).join('')}
        ${dayEvs.length>3?`<div style="font-size:10px;color:#475569;padding-left:2px">+${dayEvs.length-3} more</div>`:''}
      </div>`;
    }).join('')}
  </div>`;
  return html;
}

window.gwCalEventClick = function(eventId) {
  const ev = _calEvents.find(e=>e.id===eventId);
  if (!ev) return;
  const isAllDay = !ev.start?.dateTime;
  const start = ev.start?.dateTime||ev.start?.date||'';
  const end   = ev.end?.dateTime||ev.end?.date||'';
  const color = gwEventColor(ev);
  const timeStr = isAllDay ? 'All day' :
    new Date(start).toLocaleString(undefined,{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+
    (end?' – '+new Date(end).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}):'');

  const modal = document.createElement('div');
  modal.id = 'gw-event-modal';
  modal.style.cssText='position:fixed;inset:0;background:#000000cc;z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
  modal.innerHTML=`
<div style="background:#0f172a;border:1px solid #334155;border-radius:16px;padding:24px;width:min(480px,100%);max-height:85vh;overflow-y:auto">
  <div style="display:flex;justify-content:space-between;margin-bottom:16px">
    <div style="display:flex;gap:10px;align-items:flex-start">
      <div style="width:4px;background:${color};border-radius:2px;align-self:stretch;min-height:20px"></div>
      <div>
        <div style="font-weight:800;font-size:17px;color:#e2e8f0">${escapeHtml(ev.summary||'(No title)')}</div>
        <div style="font-size:12px;color:#64748b;margin-top:4px">${timeStr}</div>
        ${ev.location?`<div style="font-size:12px;color:#94a3b8;margin-top:2px">📍 ${escapeHtml(ev.location)}</div>`:''}
      </div>
    </div>
    <button onclick="document.getElementById('gw-event-modal').remove()" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:20px;padding:0 4px;flex-shrink:0">✕</button>
  </div>
  ${ev.description?`<div style="font-size:13px;color:#94a3b8;background:#1e293b;border-radius:8px;padding:12px;margin-bottom:14px;line-height:1.6">${escapeHtml(ev.description)}</div>`:''}
  ${ev.attendees?.length?`<div style="margin-bottom:14px"><div style="font-size:11px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Attendees</div>
    ${ev.attendees.map(a=>`<div style="font-size:12px;color:#94a3b8;padding:3px 0">${escapeHtml(a.displayName||a.email)} ${a.responseStatus==='accepted'?'✅':a.responseStatus==='declined'?'❌':a.responseStatus==='tentative'?'🤔':'⏳'}</div>`).join('')}</div>`:''}
  <div style="display:flex;gap:8px;flex-wrap:wrap">
    ${ev.htmlLink?`<a href="${escapeHtml(ev.htmlLink)}" target="_blank" rel="noopener" class="secondary-btn" style="font-size:12px">Open in Google Calendar →</a>`:''}
    <button class="secondary-btn" style="font-size:12px" onclick="gwEditEvent('${escapeHtml(ev.id)}')">✏️ Edit</button>
    <button class="danger-btn" style="font-size:12px" onclick="gwDeleteEvent('${escapeHtml(ev.id)}')">🗑 Delete</button>
  </div>
</div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });
};

window.gwDeleteEvent = async function(eventId) {
  if (!confirm('Delete this event from your Google Calendar?')) return;
  try {
    await calDeleteEvent(eventId);
    _calEvents = _calEvents.filter(e=>e.id!==eventId);
    document.getElementById('gw-event-modal')?.remove();
    showIntToast('Event deleted');
    gwRenderCalBody();
  } catch(e) { showIntToast(e.message,'error'); }
};

window.gwEditEvent = function(eventId) {
  const ev = _calEvents.find(e=>e.id===eventId);
  if (!ev) return;
  document.getElementById('gw-event-modal')?.remove();
  const isAllDay = !ev.start?.dateTime;
  const startVal = isAllDay ? (ev.start?.date||'') : new Date(ev.start.dateTime).toISOString().slice(0,16);
  const endVal   = isAllDay ? (ev.end?.date||'')   : (ev.end?.dateTime ? new Date(ev.end.dateTime).toISOString().slice(0,16) : '');
  const modal=document.createElement('div');
  modal.id='gw-edit-modal';
  modal.style.cssText='position:fixed;inset:0;background:#000000cc;z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
  modal.innerHTML=`
<div style="background:#0f172a;border:1px solid #334155;border-radius:16px;padding:24px;width:min(480px,100%);max-height:85vh;overflow-y:auto">
  <div style="display:flex;justify-content:space-between;margin-bottom:18px">
    <h3 style="margin:0">Edit Event</h3>
    <button onclick="document.getElementById('gw-edit-modal').remove()" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:20px">✕</button>
  </div>
  <div style="display:flex;flex-direction:column;gap:12px">
    <div><label style="font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.05em">Title</label>
      <input id="gw-edit-title" class="um-input" type="text" value="${escapeHtml(ev.summary||'')}" style="margin-top:6px"></div>
    <div><label style="font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.05em">${isAllDay?'Date':'Start'}</label>
      <input id="gw-edit-start" class="um-input" type="${isAllDay?'date':'datetime-local'}" value="${startVal}" style="margin-top:6px"></div>
    ${!isAllDay?`<div><label style="font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.05em">End</label>
      <input id="gw-edit-end" class="um-input" type="datetime-local" value="${endVal}" style="margin-top:6px"></div>`:''}
    <div><label style="font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.05em">Location</label>
      <input id="gw-edit-loc" class="um-input" type="text" value="${escapeHtml(ev.location||'')}" style="margin-top:6px"></div>
    <div><label style="font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.05em">Description</label>
      <textarea id="gw-edit-desc" class="um-input" rows="3" style="margin-top:6px;resize:vertical">${escapeHtml(ev.description||'')}</textarea></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
      <button class="secondary-btn" onclick="document.getElementById('gw-edit-modal').remove()">Cancel</button>
      <button class="primary-btn" onclick="gwSubmitEditEvent('${escapeHtml(ev.id)}',${isAllDay})">Save Changes</button>
    </div>
  </div>
</div>`;
  document.body.appendChild(modal);
};

window.gwSubmitEditEvent = async function(eventId, isAllDay) {
  const title = document.getElementById('gw-edit-title')?.value?.trim();
  const start = document.getElementById('gw-edit-start')?.value;
  const end   = document.getElementById('gw-edit-end')?.value;
  const loc   = document.getElementById('gw-edit-loc')?.value?.trim();
  const desc  = document.getElementById('gw-edit-desc')?.value?.trim();
  if (!title||!start) { showIntToast('Title and start time required','warn'); return; }
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fields = {
    summary: title,
    location: loc||'',
    description: desc||''
  };
  if (isAllDay) {
    fields.start={date:start}; fields.end={date:end||start};
  } else {
    fields.start={dateTime:new Date(start).toISOString(),timeZone:tz};
    fields.end  ={dateTime:new Date(end||start).toISOString(),timeZone:tz};
  }
  try {
    const updated = await calUpdateEvent(eventId, fields);
    const idx = _calEvents.findIndex(e=>e.id===eventId);
    if (idx>=0) _calEvents[idx]={..._calEvents[idx],...updated};
    document.getElementById('gw-edit-modal')?.remove();
    showIntToast('Event updated ✅');
    gwRenderCalBody();
  } catch(e) { showIntToast(e.message,'error'); }
};

// ════════════════════════════════════════════════════════════════════════════════
// DRIVE PANEL
// ════════════════════════════════════════════════════════════════════════════════
function gwRenderDrive() {
  const el = document.getElementById('gw-panel-drive');
  if (!el) return;
  el.innerHTML = `
<div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;align-items:center">
  <input id="gw-drive-search" type="text" placeholder="Search files and folders…"
    style="flex:1;min-width:200px;padding:9px 14px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px"
    onkeydown="if(event.key==='Enter')gwSearchDrive()">
  <button class="primary-btn" style="font-size:12px;padding:9px 16px" onclick="gwSearchDrive()">Search</button>
  <button class="secondary-btn" style="font-size:12px;padding:9px 14px" onclick="gwLoadDrive()">Recent Files</button>
</div>
<div id="gw-drive-list" style="min-height:200px"><div class="spinner-wrap"><div class="spinner"></div></div></div>`;
  gwLoadDrive();
}

async function gwLoadDrive(query='') {
  const el = document.getElementById('gw-drive-list');
  if (!el) return;
  el.innerHTML = '<div class="spinner-wrap"><div class="spinner"></div></div>';
  try {
    const result = await driveListFiles(query, 30);
    _driveFiles = result.files || [];
    gwRenderDriveList(el, _driveFiles);
  } catch(e) {
    el.innerHTML = `<div style="color:#f87171;padding:20px;font-size:13px">Error: ${escapeHtml(e.message)}</div>`;
  }
}

window.gwSearchDrive = async function() {
  const q = document.getElementById('gw-drive-search')?.value?.trim();
  gwLoadDrive(q);
};

const DRIVE_ICONS = {
  'application/vnd.google-apps.folder':       {icon:'📁',label:'Folder',color:'#f59e0b'},
  'application/vnd.google-apps.document':     {icon:'📄',label:'Doc',color:'#4285f4'},
  'application/vnd.google-apps.spreadsheet':  {icon:'📊',label:'Sheet',color:'#0f9d58'},
  'application/vnd.google-apps.presentation': {icon:'📑',label:'Slides',color:'#f4b400'},
  'application/vnd.google-apps.form':         {icon:'📝',label:'Form',color:'#7c3aed'},
  'application/pdf':                           {icon:'📕',label:'PDF',color:'#ef4444'},
  'image/jpeg':                                {icon:'🖼️',label:'Image',color:'#ec4899'},
  'image/png':                                 {icon:'🖼️',label:'Image',color:'#ec4899'},
  'video/mp4':                                 {icon:'🎬',label:'Video',color:'#8b5cf6'},
};

function gwRenderDriveList(el, files) {
  if (!files.length) { el.innerHTML = '<div style="text-align:center;padding:40px;color:#475569">No files found.</div>'; return; }
  el.innerHTML = `<div style="display:flex;flex-direction:column;gap:4px">` +
  files.map(f => {
    const mime = f.mimeType || '';
    const info = DRIVE_ICONS[mime] || {icon:'📎',label:mime.split('/').pop()?.slice(0,6)||'File',color:'#64748b'};
    const modified = f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}) : '';
    const size = f.size ? (f.size>1048576?(f.size/1048576).toFixed(1)+'MB':f.size>1024?(f.size/1024).toFixed(0)+'KB':f.size+'B') : '';
    return `<div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:#0f172a;border:1px solid #1e293b;border-radius:8px;transition:background .1s"
      onmouseover="this.style.background='#1e293b'" onmouseout="this.style.background='#0f172a'">
      <span style="font-size:22px;flex-shrink:0">${info.icon}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(f.name)}</div>
        <div style="font-size:11px;color:#475569;margin-top:1px">${info.label}${modified?' · Modified '+modified:''}${size?' · '+size:''}</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        ${f.webViewLink?`<a href="${escapeHtml(f.webViewLink)}" target="_blank" rel="noopener"
          style="padding:5px 12px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#94a3b8;font-size:12px;text-decoration:none;font-weight:600">
          Open →
        </a>`:''}
      </div>
    </div>`;
  }).join('') + '</div>';
}

// Expose for legacy call sites
window.intSearchDrive = window.gwSearchDrive;

// ════════════════════════════════════════════════════════════════════════════════
// HOMEWORKS PANEL (unchanged from before, just moved into a panel)
// ════════════════════════════════════════════════════════════════════════════════
function gwRenderHomeworks() {
  const el = document.getElementById('gw-panel-homeworks');
  if (!el) return;
  const hwOk = isHomeworksConnected();
  el.innerHTML = `
<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px;margin-bottom:24px">
  <div style="background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:20px">
    <h3 style="margin:0 0 12px;font-size:15px">Webhook Settings</h3>
    <label style="font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.05em">ZAPIER WEBHOOK URL</label>
    <input id="zapierWebhookInput" type="url"
      placeholder="https://hooks.zapier.com/hooks/catch/…"
      value="${escapeHtml(getZapierWebhookUrl())}"
      style="width:100%;margin-top:6px;padding:10px 12px;background:#1e293b;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px;box-sizing:border-box">
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="primary-btn" onclick="intSaveZapierUrl()">Save URL</button>
      ${hwOk?`<button class="secondary-btn" onclick="intTestZapier()">Test Ping</button>`:''}
    </div>
  </div>
  ${hwOk?`
  <div style="background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:20px">
    <h3 style="margin:0 0 12px;font-size:15px">Quick Links</h3>
    <div style="display:flex;flex-wrap:wrap;gap:8px">
      ${[['Add Customer','https://secure.copilotcrm.com/customers/add-new-customer'],
         ['Add Property','https://secure.copilotcrm.com/assets/add-new-asset'],
         ['New Estimate','https://secure.copilotcrm.com/finances/estimates/add'],
         ['Schedule Visit','https://secure.copilotcrm.com/scheduler/addvisit'],
         ['Estimates','https://secure.copilotcrm.com/finances/estimates'],
         ['Calendar','https://secure.copilotcrm.com/scheduler/month']
        ].map(([l,u])=>`<a href="${u}" target="_blank" rel="noopener"
          style="padding:7px 12px;background:#1e293b;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:12px;text-decoration:none;font-weight:500">${l}</a>`).join('')}
    </div>
  </div>`:''}
</div>
${hwOk?`
<h3 style="font-size:15px;margin:0 0 12px">Sync Opportunities → Homeworks</h3>
<div style="max-height:500px;overflow-y:auto">${renderHwOpps()}</div>`
:'<div style="color:#64748b;font-size:13px;padding:20px 0">Add your Zapier webhook URL above to enable Homeworks sync.</div>'}
`;
}

// ── Google interactions (legacy compat) ───────────────────────────────────────
function intGoogleDisconnect() { googleDisconnect(); integrations(); }

// ── Compose Email (global modal) ──────────────────────────────────────────────
function intComposeFromTemplateModal(prefillTo = '') {
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
    const btn = document.querySelector('#int-compose-modal .primary-btn');
    if (btn) { btn.textContent = 'Sending…'; btn.disabled = true; }
    const htmlBody = body.replace(/\n/g, '<br>');
    await gmailSendEmail({ to, subject, body: htmlBody });
    showIntToast('Email sent ✅');
    document.getElementById('int-compose-modal').style.display = 'none';
    if (_gwTab === 'gmail') gwLoadGmail();
    if (btn) { btn.textContent = 'Send via Gmail'; btn.disabled = false; }
  } catch(e) {
    showIntToast(e.message, 'error');
    const btn = document.querySelector('#int-compose-modal .primary-btn');
    if (btn) { btn.textContent = 'Send via Gmail'; btn.disabled = false; }
  }
}

// ── Calendar event create modal ───────────────────────────────────────────────
function intCreateCalendarEvent(prefill = {}) {
  const modal = document.getElementById('int-cal-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  if (prefill.title) { const el = document.getElementById('int-cal-title'); if(el) el.value = prefill.title; }
  if (prefill.date)  { const el = document.getElementById('int-cal-date');  if(el) el.value = prefill.date; }
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
    showIntToast('Event created ✅');
    document.getElementById('int-cal-modal').style.display = 'none';
    // Add to local cache and re-render
    if (ev.id) {
      _calEvents.push(ev);
      _calEvents.sort((a,b) => {
        const da = a.start?.dateTime||a.start?.date||'';
        const db = b.start?.dateTime||b.start?.date||'';
        return da < db ? -1 : da > db ? 1 : 0;
      });
    }
    gwRenderCalBody();
  } catch(e) { showIntToast(e.message, 'error'); }
}

// ── Homeworks visit / estimate handlers (unchanged) ───────────────────────────
function intOpenVisitModal(oppId) {
  const opps = window._avalonState?.opportunities || [];
  const opp = opps.find(o => o.id === oppId);
  if (!opp) { showIntToast('Opportunity not found'); return; }
  const modal = document.getElementById('int-visit-modal');
  if (!modal) return;
  const titleEl    = document.getElementById('int-visit-title');
  const dateEl     = document.getElementById('int-visit-date');
  const notesEl    = document.getElementById('int-visit-notes');
  const clientLabel= document.getElementById('int-visit-client-label');
  const oppIdEl    = document.getElementById('int-visit-opp-id');
  const typeEl     = document.getElementById('int-visit-type');
  if (oppIdEl) oppIdEl.value = oppId;
  if (clientLabel) clientLabel.textContent = `${opp.client} · ${opp.serviceLine||opp.status}`;
  if (titleEl) titleEl.value = `Site Walk — ${opp.client}`;
  if (dateEl)  dateEl.value  = opp.nextFollowUp ? opp.nextFollowUp.slice(0,10) : (typeof todayISO === 'function' ? todayISO() : new Date().toISOString().slice(0,10));
  if (notesEl) notesEl.value = [
    opp.project ? `Project: ${opp.project}` : '',
    opp.desiredOutcome ? `Desired outcome: ${opp.desiredOutcome}` : '',
    opp.urgency ? `Urgency: ${opp.urgency}` : '',
    opp.source ? `Source: ${opp.source}` : '',
  ].filter(Boolean).join('\n');
  if (typeEl) typeEl.value = 'Site Walk';
  modal.style.display = 'flex';
}



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
