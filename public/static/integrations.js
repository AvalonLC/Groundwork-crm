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
  // no-cors returns opaque response — we assume success if no throw
  return { success: true };
}

async function pushLeadToHomeworks(opportunity) {
  return sendToHomeworks('new_lead', {
    name: opportunity.client,
    phone: opportunity.phone,
    email: opportunity.email,
    address: opportunity.address,
    service: opportunity.serviceLine,
    source: opportunity.source,
    project: opportunity.project,
    budget: opportunity.budget,
    notes: opportunity.notes,
    status: opportunity.status,
    created: opportunity.createdAt,
    avalonId: opportunity.id
  });
}

async function pushStatusUpdateToHomeworks(opportunity) {
  return sendToHomeworks('status_update', {
    name: opportunity.client,
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
      <h3 style="margin:0 0 8px">Setup (one-time)</h3>
      <ol style="padding-left:20px;font-size:13px;line-height:1.8;color:var(--muted)">
        <li>Go to <a href="https://zapier.com/apps/homeworks/integrations" target="_blank" rel="noopener" style="color:var(--accent)">zapier.com → Homeworks integrations</a></li>
        <li>Create a Zap: Trigger = <strong>Webhooks by Zapier → Catch Hook</strong></li>
        <li>Action = <strong>Homeworks → Create Customer</strong> (or Create Lead)</li>
        <li>Copy the <strong>Zapier Webhook URL</strong> from step 2 and paste below</li>
        <li>Map fields: name → data.name, email → data.email, phone → data.phone, etc.</li>
      </ol>
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
    <div style="border-top:1px solid #334155;padding-top:16px;margin-top:8px">
      <h3 style="margin:0 0 12px">Push Leads to Homeworks</h3>
      <p style="font-size:13px;color:var(--muted)">Select any open opportunity to push it to your CRM:</p>
      <div id="int-hw-opps" style="max-height:320px;overflow-y:auto">${renderHwOpps()}</div>
    </div>
    ` : ''}
  </section>

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

// ── Render Homeworks opportunity list ─────────────────────────────────────────
function renderHwOpps() {
  const opps = (window._avalonState?.opportunities || []).filter(o =>
    !['Sold / Activation', 'Closed Lost'].includes(o.status)
  );
  if (!opps.length) return '<p style="color:var(--muted);font-size:13px">No open opportunities yet. Add a lead first.</p>';
  return opps.map(o => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#0f172a;border-radius:8px;margin-bottom:8px">
      <div>
        <div style="font-weight:600;font-size:14px">${escapeHtml(o.client)}</div>
        <div style="font-size:12px;color:var(--muted)">${escapeHtml(o.serviceLine || '')} · ${escapeHtml(o.status)}</div>
      </div>
      <button class="secondary-btn" style="font-size:12px;padding:6px 12px" onclick="intPushLead('${escapeHtml(o.id)}')">
        Push to CRM
      </button>
    </div>
  `).join('');
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
      return `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:10px 12px;background:#0f172a;border-radius:8px;margin-bottom:6px;gap:12px">
          <div style="min-width:0">
            <div style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(subj)}</div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px">${escapeHtml(from.split('<')[0].trim())} · ${d}</div>
          </div>
          <a href="https://mail.google.com/mail/#inbox/${thread.id}" target="_blank" rel="noopener"
            style="font-size:11px;color:var(--accent);white-space:nowrap;text-decoration:none">Open →</a>
        </div>
      `;
    }).join('');
  } catch(e) {
    el.innerHTML = `<p style="color:#f87171;font-size:13px">Error: ${escapeHtml(e.message)}</p>`;
  }
}

async function intLoadCalendar() {
  const el = document.getElementById('int-cal-list');
  if (!el) return;
  el.innerHTML = '<div class="spinner-wrap"><div class="spinner"></div></div>';
  try {
    const result = await calListUpcoming(8);
    const events = result.items || [];
    if (!events.length) { el.innerHTML = '<p style="color:var(--muted);font-size:13px">No upcoming events.</p>'; return; }
    el.innerHTML = events.map(ev => {
      const start = ev.start?.dateTime || ev.start?.date || '';
      const d = start ? new Date(start).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '';
      const t = ev.start?.dateTime ? new Date(ev.start.dateTime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
      return `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:10px 12px;background:#0f172a;border-radius:8px;margin-bottom:6px;gap:12px">
          <div style="min-width:0">
            <div style="font-weight:600;font-size:13px">${escapeHtml(ev.summary || '(no title)')}</div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px">${d}${t ? ' · ' + t : ''}</div>
          </div>
          ${ev.htmlLink ? `<a href="${escapeHtml(ev.htmlLink)}" target="_blank" rel="noopener" style="font-size:11px;color:var(--accent);white-space:nowrap;text-decoration:none">Open →</a>` : ''}
        </div>
      `;
    }).join('');
  } catch(e) {
    el.innerHTML = `<p style="color:#f87171;font-size:13px">Error: ${escapeHtml(e.message)}</p>`;
  }
}

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
      const modified = f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
      return `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#0f172a;border-radius:8px;margin-bottom:6px;gap:12px">
          <div style="display:flex;align-items:center;gap:8px;min-width:0">
            <span style="font-size:18px">${icon}</span>
            <div style="min-width:0">
              <div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(f.name)}</div>
              <div style="font-size:11px;color:var(--muted)">${modified}</div>
            </div>
          </div>
          ${f.webViewLink ? `<a href="${escapeHtml(f.webViewLink)}" target="_blank" rel="noopener" style="font-size:11px;color:var(--accent);white-space:nowrap;text-decoration:none">Open →</a>` : ''}
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
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#0f172a;border-radius:8px;margin-bottom:6px;gap:12px">
          <div style="display:flex;align-items:center;gap:8px;min-width:0">
            <span style="font-size:18px">${icon}</span>
            <div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(f.name)}</div>
          </div>
          ${f.webViewLink ? `<a href="${escapeHtml(f.webViewLink)}" target="_blank" rel="noopener" style="font-size:11px;color:var(--accent);white-space:nowrap;text-decoration:none">Open →</a>` : ''}
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
