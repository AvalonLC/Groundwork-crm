/**
 * Groundwork CRM — Integrations Module
 * Google Workspace (Gmail, Calendar, Drive)
 *
 * ARCHITECTURE:
 *  - Google OAuth2 authorization-code flow: popup → ?code → server exchange →
 *    refresh token stored server-side (D1 google_tokens) → PERSISTENT connection.
 *    Access tokens auto-refresh via POST /api/google/refresh — the user stays
 *    connected forever until they manually disconnect.
 *  - Falls back to legacy implicit-flow token in localStorage during migration.
 *
 * USER SETUP REQUIRED (admin, once):
 *  1. Create OAuth2 Client ID + Client Secret at console.cloud.google.com
 *  2. Save both in the Admin Setup panel (stored in company settings server-side)
 */

// ── Storage keys ──────────────────────────────────────────────────────────────
const INT_KEY = 'avalonIntegrationsV1';

// Pre-configured defaults (baked in at build time)
const INT_DEFAULTS = {

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
// Scopes: Gmail read/compose/settings, Calendar read/write, Drive read
// gmail.settings.basic allows reading sendAs addresses (→ email signature)
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.settings.basic',
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

// ── Effective Client ID resolver ───────────────────────────────────────
// Asks the server which Google OAuth Client ID applies to this company:
// company-scoped setting → legacy setting → PLATFORM DEFAULT (env secret).
// With a platform default configured, brand-new companies can hit
// "Sign in with Google" with ZERO Google Cloud setup.
async function gwResolveGoogleClientId() {
  const local = getGoogleClientId();
  if (local) return local;
  try {
    const r = await fetch('/api/google/client-id', { credentials: 'include' });
    if (!r.ok) return '';
    const j = await r.json();
    const cid = j?.data?.client_id || '';
    if (cid) {
      // Cache so sync call-sites (getGoogleClientId) see it immediately
      saveIntState({ googleClientId: cid, googleClientIdSource: j.data.source || 'server' });
    }
    return cid;
  } catch (_) { return ''; }
}
window.gwResolveGoogleClientId = gwResolveGoogleClientId;
function getGoogleUserEmail() {
  const rec = _getUserGoogleRecord();
  if (rec && rec.email) return rec.email;
  return getIntState('googleEmail') || '';
}

// ── Store a fresh access token + email + signature in the per-user record ────
async function _gwStoreAccessToken(token, expiresIn, emailHint) {
  const curRep = window.getCurrentRep ? window.getCurrentRep() : null;
  let email = emailHint || '';
  if (!email) {
    try {
      const r = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${token}` } });
      const u = await r.json(); email = u.email || '';
    } catch(_) {}
  }
  let sig = '';
  try {
    const sigR = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs', { headers: { Authorization: `Bearer ${token}` } });
    if (sigR.ok) {
      const sigJ = await sigR.json();
      const primary = (sigJ.sendAs||[]).find(s=>s.isDefault) || (sigJ.sendAs||[])[0];
      sig = primary?.signature || '';
    }
  } catch(_) {}
  if (curRep) {
    try {
      const m2 = JSON.parse(localStorage.getItem('avalonUserGoogleV1') || '{}');
      if (!m2[curRep.id]) m2[curRep.id] = {};
      m2[curRep.id].token  = token;
      m2[curRep.id].expiry = Date.now() + (expiresIn||3600) * 1000;
      m2[curRep.id].email  = email;
      if (sig) m2[curRep.id].signature = sig;
      localStorage.setItem('avalonUserGoogleV1', JSON.stringify(m2));
    } catch(e2) {}
  }
  // Legacy mirror so old call sites keep working
  saveIntState({ googleToken: token, googleExpiry: Date.now() + (expiresIn||3600) * 1000, googleEmail: email });
  return email;
}

// ── PERSISTENT CONNECT: authorization-code flow ───────────────────────────────
// Popup → Google consent (access_type=offline) → ?code → server exchange →
// refresh token stored in D1 → user stays connected until manual disconnect.
async function googleOAuthConnect() {
  // Resolve company creds → platform default before giving up
  const clientId = getGoogleClientId() || await gwResolveGoogleClientId();
  if (!clientId) {
    showIntToast('Paste your Google Client ID first (see setup guide)', 'warn');
    return false;
  }
  const redirectUri = `${location.origin}/auth/google/callback`;
  const state = Math.random().toString(36).slice(2);
  saveIntState({ googleOAuthState: state });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent select_account',
    scope: GOOGLE_SCOPES,
    state,
    include_granted_scopes: 'true'
  });
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  const popup = window.open(authUrl, 'googleAuth', 'width=520,height=620,left=200,top=100');
  if (!popup) {
    showIntToast('Popup blocked — please allow popups for this site', 'warn');
    return false;
  }

  return new Promise((resolve) => {
    let settled = false;
    async function handleCode(code) {
      if (settled) return; settled = true;
      clearInterval(timer);
      try { popup.close(); } catch(_){}
      try {
        const r = await fetch('/api/google/exchange', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, redirect_uri: redirectUri })
        });
        const j = await r.json();
        if (!r.ok || !j.ok) {
          // Server exchange unavailable (no client secret configured) — cannot persist.
          showIntToast(j.error || 'Google connect failed — check Admin Setup', 'warn');
          resolve(false);
          return;
        }
        await _gwStoreAccessToken(j.data.access_token, j.data.expires_in, j.data.email);
        showIntToast('Google connected — you\'ll stay signed in' + (j.data.has_refresh ? '' : ' (this session)'), 'success');
        window.removeEventListener('message', onMsg);
        resolve(true);
      } catch(e){
        showIntToast('Google connect failed: ' + (e.message||'error'), 'warn');
        resolve(false);
      }
    }
    function onMsg(ev){
      if (ev.origin !== location.origin || !ev.data) return;
      if (ev.data.type === 'gw_google_code' && ev.data.code) handleCode(ev.data.code);
      if (ev.data.type === 'gw_google_error') { if(!settled){settled=true;clearInterval(timer);showIntToast('Google: '+ev.data.error,'warn');resolve(false);} }
    }
    window.addEventListener('message', onMsg);
    const timer = setInterval(() => {
      try {
        if (popup.closed) { clearInterval(timer); window.removeEventListener('message', onMsg); if(!settled) resolve(isGoogleConnected()); return; }
        // Same-origin once redirected back — poll the hash for the code (fallback to postMessage)
        const hash = popup.location.hash;
        if (hash && hash.includes('gcode=')) {
          const hp = new URLSearchParams(hash.slice(1));
          const code = hp.get('gcode');
          if (code) handleCode(code);
        }
      } catch(_) { /* cross-origin until redirect */ }
    }, 300);
    setTimeout(() => { clearInterval(timer); window.removeEventListener('message', onMsg); try{ popup.closed || popup.close(); }catch(_){} if(!settled) resolve(false); }, 180000);
  });
}

// ── Silent refresh: mint a new access token from the server-stored refresh token ──
let _gwRefreshInflight = null;
async function googleTryRefresh() {
  if (_gwRefreshInflight) return _gwRefreshInflight;
  _gwRefreshInflight = (async () => {
    try {
      const r = await fetch('/api/google/refresh', { method: 'POST' });
      if (!r.ok) return null;
      const j = await r.json();
      if (!j.ok || !j.data || !j.data.access_token) return null;
      await _gwStoreAccessToken(j.data.access_token, j.data.expires_in, j.data.email);
      return j.data.access_token;
    } catch(e){ return null; }
    finally { setTimeout(()=>{ _gwRefreshInflight = null; }, 500); }
  })();
  return _gwRefreshInflight;
}

// ── Auto-restore on login/page load: if a refresh token exists server-side,
//    silently reconnect so the user NEVER has to press Connect again. ─────────
async function googleRestoreConnection() {
  if (isGoogleConnected()) return true;          // still have a valid access token
  const t = await googleTryRefresh();            // server has refresh token? → reconnect
  if (t) console.log('[Integrations] Google connection restored from server refresh token');
  return !!t;
}
window.googleRestoreConnection = googleRestoreConnection;
// Kick off restore shortly after load (getCurrentRep must be ready)
setTimeout(() => { try { googleRestoreConnection(); } catch(e){} }, 2500);

async function googleDisconnect(alsoServer) {
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
  // MANUAL disconnect → revoke + delete the server-side refresh token too
  if (alsoServer !== false) {
    try { await fetch('/api/google/disconnect', { method: 'DELETE' }); } catch(e){}
  }
  showIntToast('Google disconnected');
}

// ── Google API helpers ────────────────────────────────────────────────────────
async function gFetch(url, options = {}) {
  let token = getGoogleToken();
  // Expired/missing local token → try silent server refresh BEFORE failing
  if (!token) {
    token = await googleTryRefresh();
    if (!token) throw new Error('Not connected to Google');
  }
  const doFetch = (tok) => fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${tok}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  let res = await doFetch(token);
  if (res.status === 401) {
    // Token revoked/expired mid-session → one silent refresh retry, then give up
    const fresh = await googleTryRefresh();
    if (fresh) {
      res = await doFetch(fresh);
      if (res.status !== 401) return res;
    }
    await googleDisconnect(false); // local only — keep server refresh token for next attempt
    throw new Error('Google session expired — please reconnect');
  }
  return res;
}

// ── Gmail Signature helpers ─────────────────────────────────────────────────
// Fetch the user's Gmail sendAs signature via the Gmail Settings API.
// Requires gmail.settings.basic scope.
// Returns the HTML string, or '' if not available / scope missing.
// Sets window._gmailSigScopeError = true if a 403 is returned (scope not granted).
window._gmailSigScopeError = false;

async function gmailFetchSendAsSignature() {
  try {
    const r = await gFetch('https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs');
    if (r.status === 403) {
      // Scope not granted — existing token predates gmail.settings.basic being added.
      // User needs to reconnect to get the new scope.
      window._gmailSigScopeError = true;
      console.warn('[Groundwork] Gmail signature: 403 — token missing gmail.settings.basic scope. User needs to reconnect Google.');
      return '';
    }
    if (!r.ok) {
      console.warn('[Groundwork] Gmail signature: HTTP', r.status);
      return '';
    }
    window._gmailSigScopeError = false;
    const j = await r.json();
    const sendAsEntries = j.sendAs || [];
    // Prefer the "default" / verified sender; fall back to first entry
    const primary = sendAsEntries.find(s => s.isDefault) || sendAsEntries[0];
    return primary?.signature || '';
  } catch(e) {
    console.warn('[Groundwork] Could not fetch Gmail signature:', e.message);
    return '';
  }
}

// Get the active signature for the current user.
// Priority: 1) Gmail API (if token+scope available and cached), 2) D1 rep record.
// Result is cached in avalonUserGoogleV1[repId].signature for the session.
window.gmailGetSignature = async function() {
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  if (!rep) return '';

  // Check localStorage cache first (avoids repeat API calls)
  try {
    const map = JSON.parse(localStorage.getItem('avalonUserGoogleV1') || '{}');
    const gc  = map[rep.id];
    if (gc && gc.signature !== undefined && gc.signature !== null) {
      return gc.signature;  // may be '' (empty Gmail sig) or actual HTML
    }
  } catch(e) {}

  // Try to fetch from Gmail API
  if (isGoogleConnected()) {
    const sig = await gmailFetchSendAsSignature();
    // Cache result (even if empty — prevents repeat calls)
    try {
      const map = JSON.parse(localStorage.getItem('avalonUserGoogleV1') || '{}');
      if (!map[rep.id]) map[rep.id] = {};
      map[rep.id].signature = sig;
      localStorage.setItem('avalonUserGoogleV1', JSON.stringify(map));
    } catch(e) {}
    if (sig) return sig;
  }

  // Fall back to rep.email_signature from D1 (loaded when rep record was fetched)
  return rep.email_signature || '';
};

// Force-refresh signature from Gmail API (ignores cache)
window.gmailRefreshSignature = async function() {
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  if (!rep) return '';
  if (!isGoogleConnected()) return rep.email_signature || '';

  const sig = await gmailFetchSendAsSignature();
  try {
    const map = JSON.parse(localStorage.getItem('avalonUserGoogleV1') || '{}');
    if (!map[rep.id]) map[rep.id] = {};
    map[rep.id].signature = sig;
    localStorage.setItem('avalonUserGoogleV1', JSON.stringify(map));
  } catch(e) {}
  return sig;
};

// ── Gmail ─────────────────────────────────────────────────────────────────────
async function gmailListThreads(maxResults = 10) {
  const r = await gFetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads?maxResults=${maxResults}&labelIds=INBOX`);
  return r.json();
}

async function gmailGetThread(id) {
  const r = await gFetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`);
  return r.json();
}

// ── Unicode-safe base64url encoder ─────────────────────────────────────────────
// btoa() only handles Latin-1. For emails with Unicode (emoji, accented chars,
// HTML entities from signatures, etc.) we use TextEncoder + manual base64.
function _gwBase64url(str) {
  // Encode the string as UTF-8 bytes, then base64url-encode the bytes
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── MIME builder helpers ────────────────────────────────────────────────────────
function _gwMimeBoundary() {
  return '----=_GW_' + Math.random().toString(36).slice(2) + Date.now();
}

async function gmailSendEmail({ to, cc, bcc, subject, body, replyToMessageId, attachments }) {
  const fromEmail = getGoogleUserEmail();
  attachments = attachments || [];

  // ── Encode subject as UTF-8 quoted-printable base64 (RFC 2047) ─────────────
  // This handles special chars in subject lines correctly
  const encSubject = '=?UTF-8?B?' + btoa(unescape(encodeURIComponent(subject))) + '?=';

  let rawEmail;

  if (attachments.length === 0) {
    // ── Simple HTML-only email (no attachments) ─────────────────────────────
    const headers = [
      `From: ${fromEmail}`,
      `To: ${to}`,
      cc  ? `Cc: ${cc}`   : null,
      bcc ? `Bcc: ${bcc}` : null,
      `Subject: ${encSubject}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/html; charset=UTF-8`,
      `Content-Transfer-Encoding: base64`,
      replyToMessageId ? `In-Reply-To: ${replyToMessageId}` : null,
    ].filter(Boolean).join('\r\n');

    // base64 the body in chunks of 76 chars (RFC 2045)
    const bodyB64 = _gwBase64url(body)
      .replace(/-/g, '+').replace(/_/g, '/') // undo url-safe for Content-Transfer-Encoding
      .match(/.{1,76}/g)?.join('\r\n') || '';

    rawEmail = headers + '\r\n\r\n' + bodyB64;

  } else {
    // ── Multipart/mixed (message + attachments) ─────────────────────────────
    const boundary = _gwMimeBoundary();
    const headers = [
      `From: ${fromEmail}`,
      `To: ${to}`,
      cc  ? `Cc: ${cc}`   : null,
      bcc ? `Bcc: ${bcc}` : null,
      `Subject: ${encSubject}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      replyToMessageId ? `In-Reply-To: ${replyToMessageId}` : null,
    ].filter(Boolean).join('\r\n');

    // HTML part
    const bodyB64 = _gwBase64url(body)
      .replace(/-/g, '+').replace(/_/g, '/')
      .match(/.{1,76}/g)?.join('\r\n') || '';

    let parts = `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${bodyB64}\r\n`;

    // Attachment parts
    for (const att of attachments) {
      const attB64 = att.data.match(/.{1,76}/g)?.join('\r\n') || att.data;
      parts += `--${boundary}\r\nContent-Type: ${att.mimeType}; name="${att.name}"\r\nContent-Disposition: attachment; filename="${att.name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${attB64}\r\n`;
    }
    parts += `--${boundary}--`;

    rawEmail = headers + '\r\n\r\n' + parts;
  }

  // ── Send via Gmail API using base64url-encoded raw RFC 2822 message ─────────
  const encoded = _gwBase64url(rawEmail);
  const payload = { raw: encoded };
  if (replyToMessageId) payload.threadId = replyToMessageId;

  const r = await gFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const errData = await r.json().catch(() => ({}));
    throw new Error(errData.error?.message || 'Failed to send email');
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
  // Fetch events in a rolling window: 2 months back → 12 months forward.
  // Google Calendar requires timeMin/timeMax for consistent ordering and results.
  const past   = new Date(); past.setMonth(past.getMonth() - 2);
  const future = new Date(); future.setFullYear(future.getFullYear() + 1);
  const tMin = encodeURIComponent(past.toISOString());
  const tMax = encodeURIComponent(future.toISOString());
  const r = await gFetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events` +
    `?maxResults=${maxResults}&singleEvents=true&orderBy=startTime` +
    `&timeMin=${tMin}&timeMax=${tMax}`
  );
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

// ── Toast helper (local to integrations) ─────────────────────────────────────
function showIntToast(msg, type = 'info') {
  if (window.showToast) { window.showToast(msg); return; }
  console.log(`[${type}] ${msg}`);
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function connBadge(connected, label) {
  return connected
    ? `<span class="badge" style="background:#2D7A55;color:#fff">Connected: ${label}</span>`
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
  const googleEmail = getGoogleUserEmail();
  const currentRep = window.getCurrentRep ? window.getCurrentRep() : null;
  const repName = currentRep ? (currentRep.name || 'You') : 'You';
  const repColor = currentRep ? (currentRep.color || '#4D8A86') : '#4D8A86';
  // Company-saved Client ID, or the platform-wide default served by the API —
  // either one makes the "Sign in with Google" button live.
  let clientIdConfigured = !!getGoogleClientId();
  if (!clientIdConfigured && !googleOk) {
    clientIdConfigured = !!(await gwResolveGoogleClientId());
  }

  if (!googleOk) {
    // ── NOT CONNECTED — show connect screen ───────────────────────────────────
    intView.innerHTML = `
<div class="eyebrow">Connected Tools</div>
<h1>Google Workspace</h1>
<p class="lede">Connect <strong>${escapeHtml(repName)}'s</strong> Google account to access Gmail, Calendar, and Drive directly inside the hub. Each team member connects their own account — completely private.</p>

<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px;margin-top:24px">
  <div class="gw-int-panel" style="border-radius:16px;padding:28px">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px">
      <img src="https://www.google.com/favicon.ico" style="width:32px;height:32px" alt="Google">
      <div>
        <div style="font-weight:800;font-size:18px;color:var(--gds-ink,#1F2A2B)">Connect ${escapeHtml(repName)}'s Google</div>
        <div style="font-size:12px;color:${repColor};margin-top:2px;font-weight:600">${escapeHtml(repName)}'s workspace — private to you</div>
      </div>
    </div>
    <p style="color:#6F7E6A;font-size:13px;line-height:1.7;margin:0 0 20px">
      Sign in with your Google account. Your Gmail, Calendar, and Drive are fully accessible inside the hub.
      Other users connect their own accounts separately — no shared access.
    </p>
    ${!clientIdConfigured ? `
    <div style="padding:12px 14px;background:rgba(139,105,20,.07);border:1px solid rgba(139,105,20,.25);border-radius:8px;margin-bottom:16px;font-size:13px;color:var(--gds-amber,#7A5C10)">
      ${gwIcon('warning',16)} Google Client ID not configured yet — set it up in the <strong>Admin Setup</strong> panel below.
    </div>` : ''}
    <button class="primary-btn" style="width:100%;justify-content:center;font-size:14px;padding:12px 20px;${!clientIdConfigured?'opacity:.5;cursor:not-allowed':''}"
      ${!clientIdConfigured?'disabled':''} onclick="intSaveClientIdAndConnect()">
      <svg width="18" height="18" viewBox="0 0 18 18" style="vertical-align:-3px;margin-right:8px"><path d="M16.51 8H8.98v3h4.3c-.18 1-.74 1.48-1.6 2.04v2.01h2.6A7.8 7.8 0 0 0 17 9c0-.46-.05-.86-.09-1z" fill="#4285F4"/><path d="M8.98 17c2.16 0 3.97-.72 5.3-1.94l-2.6-2.04c-.71.48-1.62.77-2.7.77-2.08 0-3.84-1.4-4.47-3.28H1.8v2.07A8 8 0 0 0 8.98 17z" fill="#34A853"/><path d="M4.51 10.51A4.8 4.8 0 0 1 4.26 9c0-.53.09-1.04.25-1.51V5.42H1.8A8 8 0 0 0 .98 9c0 1.29.31 2.51.82 3.58l2.71-2.07z" fill="#FBBC05"/><path d="M8.98 3.58c1.17 0 2.23.4 3.06 1.2l2.3-2.3A8 8 0 0 0 8.98 1 8 8 0 0 0 1.8 5.42l2.71 2.07c.63-1.89 2.39-3.91 4.47-3.91z" fill="#EA4335"/></svg>
      Sign in with Google
    </button>

    <div class="gw-info-strip" style="margin-top:20px;border-radius:10px">
      <div style="font-size:11px;font-weight:700;color:#5C6B58;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">What you'll get access to</div>
      ${[[gwIcon('email',16,'#204A43'),'Gmail','Read, compose, reply, and send emails directly inside the hub'],
         [gwIcon('calendar',16,'#204A43'),'Calendar','Full calendar — past, present, future. Create and edit events in-hub'],
         [gwIcon('folder',16),'Drive','Browse, search, and open your Drive files without leaving the app']
        ].map(([ic,nm,desc])=>`
      <div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--gw-line)">
        <span style="font-size:18px;flex-shrink:0">${ic}</span>
        <div><div style="font-weight:600;font-size:13px;color:var(--gds-pine,#204A43)">${nm}</div><div style="font-size:12px;color:var(--gds-muted,#5E6E6F);margin-top:1px">${desc}</div></div>
      </div>`).join('')}
    </div>
  </div>

  <!-- Admin: Google OAuth Client ID setup -->
  <div class="gw-int-panel" style="border-radius:16px;padding:28px;min-width:0;overflow:hidden">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--gds-pine,#204A43)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>
      <div style="font-size:15px;font-weight:800;color:var(--gds-ink,#1F2A2B)">Admin Setup</div>
      <span style="margin-left:auto;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--gds-muted,#5E6E6F);background:var(--gds-surface-3,#F2EFE9);border:1px solid var(--gds-line,#E0DDD5);border-radius:4px;padding:2px 7px">Admin only</span>
    </div>
    <p style="font-size:13px;color:var(--gds-muted,#5E6E6F);line-height:1.6;margin:0 0 16px">
      Set the shared Google OAuth Client ID once here. All team members can then connect their own individual Google accounts via this page.
    </p>
    <label style="font-size:11px;font-weight:700;color:var(--gds-muted,#5E6E6F);text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:6px">Google OAuth Client ID</label>
    <div style="display:flex;gap:8px;margin-bottom:8px">
      <input id="int-admin-client-id" type="text"
        value="${escapeHtml(getGoogleClientId())}"
        placeholder="523041…apps.googleusercontent.com"
        style="flex:1;padding:9px 12px;background:var(--gds-surface,#FFFFFF);border:1px solid var(--gds-line-2,#CCC9C0);border-radius:8px;color:var(--gds-ink,#1F2A2B);font-size:12px;font-family:monospace;box-sizing:border-box">
      <button class="primary-btn" style="font-size:12px;padding:8px 14px;flex-shrink:0" onclick="intAdminSaveClientId()">
        Save
      </button>
    </div>
    <div style="font-size:11px;color:var(--gds-muted,#5E6E6F);margin-bottom:16px">Get your Client ID at <a href="https://console.cloud.google.com/apis/credentials" target="_blank" style="color:var(--gds-teal,#4D8A86)">Google Cloud Console → Credentials</a>.</div>

    <label style="font-size:11px;font-weight:700;color:var(--gds-muted,#5E6E6F);text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:6px">Google OAuth Client Secret <span style="font-weight:500;text-transform:none;letter-spacing:0">(enables stay-signed-in)</span></label>
    <div style="display:flex;gap:8px;margin-bottom:8px">
      <input id="int-admin-client-secret" type="password"
        placeholder="GOCSPX-…"
        style="flex:1;padding:9px 12px;background:var(--gds-surface,#FFFFFF);border:1px solid var(--gds-line-2,#CCC9C0);border-radius:8px;color:var(--gds-ink,#1F2A2B);font-size:12px;font-family:monospace;box-sizing:border-box">
    </div>
    <div style="font-size:11px;color:var(--gds-muted,#5E6E6F);line-height:1.6;margin-bottom:12px">With the Client Secret saved, everyone's Google connection becomes <strong>permanent</strong> — no re-connecting every login. It's stored server-side in your company settings, never in the browser. From the same Google Cloud credential page, copy the Client Secret.</div>
    <button class="primary-btn" style="font-size:12px;padding:8px 14px" onclick="intAdminSaveGoogleCreds()">Save Google Credentials</button>
    <span id="int-admin-creds-status" style="font-size:11px;color:#2D7A55;margin-left:10px"></span>

    <div style="border-top:1px solid var(--gds-line,#E0DDD5);margin:18px 0 14px"></div>
    <label style="font-size:11px;font-weight:700;color:var(--gds-muted,#5E6E6F);text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:6px">AI API Key <span style="font-weight:500;text-transform:none;letter-spacing:0">(enables ✨ AI proposal drafting)</span></label>
    <div style="display:flex;gap:8px;margin-bottom:8px">
      <input id="int-admin-ai-key" type="password"
        placeholder="sk-…"
        style="flex:1;padding:9px 12px;background:var(--gds-surface,#FFFFFF);border:1px solid var(--gds-line-2,#CCC9C0);border-radius:8px;color:var(--gds-ink,#1F2A2B);font-size:12px;font-family:monospace;box-sizing:border-box">
      <button class="primary-btn" style="font-size:12px;padding:8px 14px;flex-shrink:0" onclick="intAdminSaveAiKey()">Save</button>
    </div>
    <div style="font-size:11px;color:var(--gds-muted,#5E6E6F);line-height:1.6">An OpenAI API key (from <a href="https://platform.openai.com/api-keys" target="_blank" style="color:var(--gds-teal,#4D8A86)">platform.openai.com</a>) powers "Draft with AI" in the proposal builder. Stored server-side in company settings — never in the browser.</div>
    <span id="int-admin-ai-status" style="font-size:11px;color:#2D7A55"></span>
  </div><!-- /Admin Setup gw-int-panel -->
</div>`;
    return;
  }

  // ── CONNECTED — render full workspace hub ─────────────────────────────────
  intView.innerHTML = `
<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:20px">
  <div>
    <div class="eyebrow">Google Workspace</div>
    <h1 style="margin:2px 0 0">Workspace Hub</h1>
    <div style="font-size:13px;color:#6F7E6A;margin-top:3px">
      Signed in as <strong style="color:${repColor}">${escapeHtml(googleEmail)}</strong> · ${escapeHtml(repName)}'s private connection
    </div>
  </div>
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
    <button class="secondary-btn" style="font-size:12px" onclick="intGoogleDisconnect()">Disconnect Google</button>
  </div>
</div>

<!-- Tab bar -->
<div style="display:flex;gap:0;border-bottom:2px solid var(--gw-line);margin-bottom:0">
  ${[['gmail','Gmail'],['calendar','Calendar'],['drive','Drive']].map(([id,label])=>`
  <button id="gw-tab-${id}" onclick="gwSwitchTab('${id}')"
    style="padding:10px 20px;font-size:13px;font-weight:600;background:none;border:none;cursor:pointer;border-bottom:2px solid ${_gwTab===id?'#4D8A86':'transparent'};color:${_gwTab===id?'#4D8A86':'#6F7E6A'};margin-bottom:-2px;transition:all .15s">
    ${label}
  </button>`).join('')}
</div>

<!-- Tab content panels -->
<div id="gw-panel-gmail"  style="display:${_gwTab==='gmail'   ?'block':'none'};padding-top:20px"></div>
<div id="gw-panel-calendar" style="display:${_gwTab==='calendar'?'block':'none'};padding-top:20px"></div>
<div id="gw-panel-drive"  style="display:${_gwTab==='drive'   ?'block':'none'};padding-top:20px"></div>

<!-- ── Compose Email Modal ────────────────────────────────────────────── -->
${_buildComposeModalHTML()}

<!-- ── Create Calendar Event Modal ───────────────────────────────────── -->
<div id="int-cal-modal" style="display:none;position:fixed;inset:0;background:#00000088;z-index:9999;align-items:center;justify-content:center;padding:20px">
  <div class="gw-modal-card" style="border-radius:16px;padding:28px;width:100%;max-width:480px;box-shadow:0 24px 64px #000a">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
      <h3 style="margin:0;font-size:17px;font-weight:800;color:var(--gds-ink,#1F2A2B)">${gwIcon('calendar',16)} New Event</h3>
      <button onclick="document.getElementById('int-cal-modal').style.display='none'" style="background:none;border:none;color:#6F7E6A;font-size:22px;cursor:pointer;line-height:1">×</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:12px">
      <div>
        <label style="font-size:11px;font-weight:700;color:#6F7E6A;text-transform:uppercase;letter-spacing:.05em">Title</label>
        <input id="int-cal-title" type="text" placeholder="Event title"
          style="width:100%;margin-top:5px;padding:9px 12px;background:var(--gw-surface-3);border:1px solid var(--gw-line);border-radius:8px;color:var(--gw-ink);font-size:13px;box-sizing:border-box">
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div>
          <label style="font-size:11px;font-weight:700;color:#6F7E6A;text-transform:uppercase;letter-spacing:.05em">Date</label>
          <input id="int-cal-date" type="date"
            style="width:100%;margin-top:5px;padding:9px 12px;background:var(--gw-surface-3);border:1px solid var(--gw-line);border-radius:8px;color:var(--gw-ink);font-size:13px;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:#6F7E6A;text-transform:uppercase;letter-spacing:.05em">Time</label>
          <input id="int-cal-time" type="time" value="09:00"
            style="width:100%;margin-top:5px;padding:9px 12px;background:var(--gw-surface-3);border:1px solid var(--gw-line);border-radius:8px;color:var(--gw-ink);font-size:13px;box-sizing:border-box">
        </div>
      </div>
      <div>
        <label style="font-size:11px;font-weight:700;color:#6F7E6A;text-transform:uppercase;letter-spacing:.05em">Duration (hours)</label>
        <input id="int-cal-duration" type="number" min="0.25" max="24" step="0.25" value="1"
          style="width:100%;margin-top:5px;padding:9px 12px;background:var(--gw-surface-3);border:1px solid var(--gw-line);border-radius:8px;color:var(--gw-ink);font-size:13px;box-sizing:border-box">
      </div>
      <div>
        <label style="font-size:11px;font-weight:700;color:#6F7E6A;text-transform:uppercase;letter-spacing:.05em">Invite (email)</label>
        <input id="int-cal-attendee" type="email" placeholder="attendee@example.com (optional)"
          style="width:100%;margin-top:5px;padding:9px 12px;background:var(--gw-surface-3);border:1px solid var(--gw-line);border-radius:8px;color:var(--gw-ink);font-size:13px;box-sizing:border-box">
      </div>
      <div>
        <label style="font-size:11px;font-weight:700;color:#6F7E6A;text-transform:uppercase;letter-spacing:.05em">Notes</label>
        <textarea id="int-cal-notes" rows="3" placeholder="Description or notes (optional)"
          style="width:100%;margin-top:5px;padding:9px 12px;background:var(--gw-surface-3);border:1px solid var(--gw-line);border-radius:8px;color:var(--gw-ink);font-size:13px;resize:vertical;box-sizing:border-box;font-family:inherit"></textarea>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px">
        <button onclick="document.getElementById('int-cal-modal').style.display='none'" class="secondary-btn">Cancel</button>
        <button onclick="intSubmitCalEvent()" class="primary-btn">Create Event ${gwIcon('success',16)}</button>
      </div>
    </div>
  </div>
</div>
`;

  // Load active tab
  gwRenderActiveTab();
}

// ── Tab switching ─────────────────────────────────────────────────────────────
window.gwSwitchTab = function(tab) {
  _gwTab = tab;
  ['gmail','calendar','drive'].forEach(id => {
    const panel = document.getElementById(`gw-panel-${id}`);
    const btn   = document.getElementById(`gw-tab-${id}`);
    if (panel) panel.style.display = id === tab ? 'block' : 'none';
    if (btn)   { btn.style.borderBottomColor = id===tab?'#4D8A86':'transparent'; btn.style.color = id===tab?'#4D8A86':'#6F7E6A'; }
  });
  gwRenderActiveTab();
};

function gwRenderActiveTab() {
  if (_gwTab === 'homeworks') _gwTab = 'gmail'; // legacy tab removed
  if (_gwTab === 'gmail')      gwRenderGmail();
  if (_gwTab === 'calendar')   gwRenderCalendar();
  if (_gwTab === 'drive')      gwRenderDrive();
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
      ${_gmailLabel===l?'background:#4D8A86;color:#fff;border:1.5px solid #4D8A86':'background:var(--gw-surface-2);color:var(--gw-muted);border:1.5px solid var(--gw-line)'}">
      ${label}
    </button>`).join('')}
  </div>
  <button class="primary-btn" style="font-size:12px;padding:7px 14px" onclick="gwOpenCompose()">${gwIcon('email',16)} Compose</button>
</div>
<div id="gw-gmail-list" style="min-height:200px"><div class="spinner-wrap"><div class="spinner"></div></div></div>`;

  gwLoadGmail();

  // Pre-warm the Gmail signature in the background so compose opens instantly.
  // Clears any stale cached value first so we always get a fresh check on page load.
  if (isGoogleConnected()) {
    (async () => {
      try {
        const rep = window.getCurrentRep ? window.getCurrentRep() : null;
        if (rep) {
          // Clear stale signature cache so we re-fetch on this page load
          const m = JSON.parse(localStorage.getItem('avalonUserGoogleV1') || '{}');
          if (m[rep.id]) { delete m[rep.id].signature; localStorage.setItem('avalonUserGoogleV1', JSON.stringify(m)); }
        }
        window._gmailSigScopeError = false;
        const sig = await gmailFetchSendAsSignature();
        if (rep && sig !== undefined) {
          const m2 = JSON.parse(localStorage.getItem('avalonUserGoogleV1') || '{}');
          if (!m2[rep.id]) m2[rep.id] = {};
          m2[rep.id].signature = sig;
          localStorage.setItem('avalonUserGoogleV1', JSON.stringify(m2));
        }
      } catch(_) {}
    })();
  }
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
    if (!threads.length) { el.innerHTML = `<div style="text-align:center;padding:40px;color:#5C6B58">No messages in ${_gmailLabel.toLowerCase()}.</div>`; return; }

    const metaList = await Promise.all(
      threads.map(t => gmailGetThread(t.id).catch(() => null))
    );
    _gmailThreads = metaList.filter(Boolean);
    gwRenderThreadList(el);
  } catch(e) {
    el.innerHTML = `<div style="color:#C97B6A;padding:20px;font-size:13px">Error loading Gmail: ${escapeHtml(e.message)}</div>`;
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
      style="display:flex;align-items:flex-start;gap:12px;padding:12px 14px;border-bottom:1px solid var(--gw-line);cursor:pointer;background:${isUnread?'var(--gw-surface-2)':'var(--gw-surface)'};transition:background .1s"
      onmouseover="this.style.background='var(--gw-surface-3)'" onmouseout="this.style.background='${isUnread?'var(--gw-surface-2)':'var(--gw-surface)'}'">
      <div style="width:8px;height:8px;border-radius:50%;background:${isUnread?'#4D8A86':'transparent'};border:${isUnread?'none':'1px solid var(--gw-line)'};margin-top:6px;flex-shrink:0"></div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
          <div style="font-size:13px;font-weight:${isUnread?'700':'500'};color:${isUnread?'var(--gds-ink,#1F2A2B)':'var(--gds-muted,#5E6E6F)'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(sender)}</div>
          <div style="font-size:11px;color:#5C6B58;flex-shrink:0">${d}${count>1?` <span style="background:var(--gw-surface-3);border-radius:10px;padding:1px 5px">${count}</span>`:''}</div>
        </div>
        <div style="font-size:13px;color:${isUnread?'var(--gds-ink,#1F2A2B)':'var(--gds-muted,#5E6E6F)'};font-weight:${isUnread?'600':'400'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px">${escapeHtml(subj)}</div>
        <div style="font-size:12px;color:var(--gds-muted,#5E6E6F);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px">${escapeHtml(snippet)}</div>
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
    el.innerHTML = `<div style="color:#C97B6A;padding:20px">${escapeHtml(e.message)}</div>`;
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
    if (!thread) { el.innerHTML = '<div style="color:#C97B6A;padding:20px">Thread not found</div>'; return; }
  }

  const msgs = thread.messages || [];
  const firstHeaders = msgs[0]?.payload?.headers || [];
  const subj = firstHeaders.find(h=>h.name==='Subject')?.value || '(no subject)';

  el.innerHTML = `
<div style="margin-bottom:16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
  <button onclick="gwBackToList()" class="gw-back-btn" style="border-radius:8px;padding:7px 14px;cursor:pointer;font-size:13px">← Back</button>
  <div style="font-size:16px;font-weight:700;color:var(--gds-ink,#1F2A2B);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(subj)}</div>
  <button onclick="gwTrashThread('${threadId}')" style="background:transparent;border:1px solid #F5D5C8;color:#C97B6A;border-radius:8px;padding:6px 12px;cursor:pointer;font-size:12px">${gwIcon('trash',16)} Trash</button>
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

  return `<div class="gw-gmail-thread" style="border-radius:10px;overflow:hidden">
    <div style="display:flex;align-items:center;gap:10px;padding:12px 14px;${collapsed?'cursor:pointer':''}"
      ${collapsed?`onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'"`:''}>
      <div style="width:32px;height:32px;border-radius:50%;background:var(--gw-surface-3);display:flex;align-items:center;justify-content:center;font-weight:700;color:var(--gw-muted);font-size:13px;flex-shrink:0">${escapeHtml(sender[0]?.toUpperCase()||'?')}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:13px;color:var(--gds-ink,#1F2A2B)">${escapeHtml(sender)}</div>
        <div style="font-size:11px;color:var(--gds-muted,#5E6E6F)">to ${escapeHtml(to)} · ${dt}</div>
      </div>
      ${collapsed?'<span style="color:#5C6B58;font-size:12px">click to expand</span>':''}
    </div>
    <div style="padding:0 14px 14px;${collapsed?'display:none':''}">
      ${bodyRaw
        ? `<iframe srcdoc="${bodyRaw.replace(/"/g,'&quot;').replace(/\n/g,' ')}"
            style="width:100%;min-height:200px;border:none;background:#fff;border-radius:6px"
            onload="this.style.height=Math.min(this.contentDocument.body.scrollHeight+20,600)+'px'"></iframe>`
        : `<div style="font-size:13px;color:var(--gds-muted,#5E6E6F);padding:8px 0">${escapeHtml(msg.snippet||'(no content)')}</div>`
      }
    </div>
  </div>`;
}).join('')}
</div>
<div class="gw-int-panel" style="border-radius:12px;padding:16px;margin-top:16px" id="gw-reply-box">
  <div style="font-size:12px;font-weight:600;color:var(--gds-muted,#5E6E6F);margin-bottom:8px">Reply</div>
  <textarea id="gw-reply-body" rows="4" placeholder="Write your reply…"
    style="width:100%;padding:10px 12px;background:var(--gw-surface-3);border:1px solid var(--gw-line);border-radius:8px;color:var(--gw-ink);font-size:13px;box-sizing:border-box;resize:vertical;font-family:inherit"></textarea>
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
    showIntToast('Reply sent');
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
// Track whether the signature is currently included in the compose window
window._intSigActive   = false;
window._intSigHtml     = '';
window._intSigSource   = '';  // 'gmail' | 'manual' | ''
window._intAttachments = [];  // [{ name, mimeType, data: base64 }]

// Build the compose modal HTML string (used both by integrations() template
// and by gwEnsureComposeModal for self-contained injection)
function _buildComposeModalHTML() {
  return `
<style>
#int-compose-modal * { box-sizing: border-box; }
/* ── Rich-text toolbar ── */
.gw-compose-toolbar {
  display: flex; flex-wrap: wrap; align-items: center; gap: 2px;
  padding: 6px 8px; background: var(--gw-surface-2,#1e2e2a);
  border: 1px solid var(--gw-line,#2e4040); border-bottom: none;
  border-radius: 8px 8px 0 0;
}
.gw-compose-toolbar button {
  background: none; border: none; color: var(--gw-muted,#6F7E6A);
  cursor: pointer; border-radius: 4px; padding: 3px 6px;
  font-size: 13px; font-weight: 700; transition: background .12s, color .12s;
  display: flex; align-items: center; min-width: 26px; justify-content: center;
}
.gw-compose-toolbar button:hover { background: var(--gw-surface-3,#263532); color: var(--gw-ink,#E8E4D9); }
.gw-compose-toolbar button.active { background: var(--gw-teal,#4D8A86); color: #fff; }
.gw-compose-toolbar .tb-sep { width: 1px; height: 18px; background: var(--gw-line,#2e4040); margin: 0 3px; flex-shrink: 0; }
.gw-compose-toolbar select {
  background: var(--gw-surface-3,#263532); border: 1px solid var(--gw-line,#2e4040);
  color: var(--gw-ink,#E8E4D9); border-radius: 4px; font-size: 12px;
  padding: 2px 4px; cursor: pointer;
}
/* ── Editor body ── */
#int-email-editor {
  min-height: 180px; max-height: 300px; overflow-y: auto;
  padding: 10px 12px; background: var(--gw-surface-3,#263532);
  border: 1px solid var(--gw-line,#2e4040); border-top: none;
  border-radius: 0 0 8px 8px; color: var(--gw-ink,#E8E4D9);
  font-size: 13.5px; line-height: 1.6; outline: none;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
#int-email-editor:empty:before {
  content: attr(data-placeholder); color: var(--gw-muted,#6F7E6A); pointer-events: none;
}
#int-email-editor ul, #int-email-editor ol { padding-left: 20px; margin: 4px 0; }
#int-email-editor blockquote { border-left: 3px solid var(--gw-line); margin: 4px 0 4px 6px; padding-left: 10px; color: var(--gw-muted); }
/* ── Recipient chips ── */
.gw-chip-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 6px 10px; background: var(--gw-surface-3,#263532); border: 1px solid var(--gw-line,#2e4040); border-radius: 8px; cursor: text; min-height: 38px; }
.gw-chip { display:inline-flex; align-items:center; gap:4px; background:var(--gw-surface-2,#1e2e2a); border:1px solid var(--gw-line,#2e4040); border-radius:20px; padding:2px 8px; font-size:12px; color:var(--gw-ink,#E8E4D9); }
.gw-chip-x { cursor:pointer; color:var(--gw-muted,#6F7E6A); font-size:14px; line-height:1; padding: 0 1px; }
.gw-chip-x:hover { color: #C97B6A; }
.gw-chip-input { flex:1; min-width:120px; border:none; background:transparent; color:var(--gw-ink,#E8E4D9); font-size:13px; outline:none; padding:0; }
/* ── Autocomplete dropdown ── */
.gw-ac-list { position:absolute; z-index:10001; background:var(--gw-surface-2,#1e2e2a); border:1px solid var(--gw-line,#2e4040); border-radius:8px; box-shadow:0 8px 24px #0008; max-height:180px; overflow-y:auto; min-width:240px; }
.gw-ac-item { padding:8px 12px; cursor:pointer; font-size:13px; color:var(--gw-ink,#E8E4D9); border-bottom:1px solid var(--gw-line,#2e4040); display:flex; flex-direction:column; gap:1px; }
.gw-ac-item:last-child { border-bottom:none; }
.gw-ac-item:hover, .gw-ac-item.active { background:var(--gw-teal,#4D8A86); color:#fff; }
.gw-ac-item:hover .gw-ac-sub, .gw-ac-item.active .gw-ac-sub { color:rgba(255,255,255,.7); }
.gw-ac-sub { font-size:11px; color:var(--gw-muted,#6F7E6A); }
/* ── Attachment pills ── */
.gw-attach-pill { display:inline-flex; align-items:center; gap:5px; background:var(--gw-surface-2,#1e2e2a); border:1px solid var(--gw-line,#2e4040); border-radius:6px; padding:3px 8px 3px 10px; font-size:11px; color:var(--gw-ink,#E8E4D9); }
.gw-attach-pill-x { cursor:pointer; color:var(--gw-muted,#6F7E6A); font-size:13px; }
.gw-attach-pill-x:hover { color:#C97B6A; }
/* ── Bottom bar ── */
.gw-compose-bottom { display:flex; align-items:center; gap:8px; padding-top:10px; border-top:1px solid var(--gw-line,#2e4040); margin-top:10px; flex-wrap:wrap; }
/* ── Link-to-Lead picker ── */
#gw-link-lead-row { display:flex; align-items:center; gap:0; }
#gw-link-lead-input { flex:1; padding:7px 10px; background:var(--gw-surface-3,#263532); border:1px solid var(--gw-line,#2e4040); border-radius:8px; color:var(--gw-ink,#E8E4D9); font-size:13px; outline:none; }
#gw-link-lead-input::placeholder { color:var(--gw-muted,#6F7E6A); }
#gw-link-lead-badge { display:none; align-items:center; gap:6px; background:#1A4740; border:1px solid #2D7A55; border-radius:20px; padding:3px 10px 3px 8px; font-size:12px; color:#5CC8A8; font-weight:600; }
#gw-link-lead-badge-x { cursor:pointer; color:#5CC8A8; font-size:14px; line-height:1; margin-left:4px; opacity:.7; }
#gw-link-lead-badge-x:hover { opacity:1; }
#gw-link-lead-ac { position:absolute; z-index:10002; background:var(--gw-surface-2,#1e2e2a); border:1px solid var(--gw-line,#2e4040); border-radius:8px; box-shadow:0 8px 24px #0008; max-height:200px; overflow-y:auto; min-width:280px; left:52px; right:0; top:100%; margin-top:2px; }
</style>

<div id="int-compose-modal" style="display:none;position:fixed;inset:0;background:#00000099;z-index:9999;align-items:center;justify-content:center;padding:16px">
  <div class="gw-modal-card" style="border-radius:16px;padding:24px;width:100%;max-width:680px;box-shadow:0 24px 64px #000c;max-height:95vh;overflow-y:auto;display:flex;flex-direction:column;gap:0">

    <!-- Header -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <h3 style="margin:0;font-size:16px;font-weight:800;color:var(--gds-ink,#1F2A2B);display:flex;align-items:center;gap:7px">
        <svg width="15" height="15" viewBox="0 0 20 20" fill="none" style="flex-shrink:0"><rect x="1" y="4" width="18" height="13" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M1 7l9 6 9-6" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
        New Email
      </h3>
      <div style="display:flex;align-items:center;gap:10px">
        <div id="int-sig-status" style="font-size:10px;color:#6F7E6A"></div>
        <button onclick="document.getElementById('int-compose-modal').style.display='none'" style="background:none;border:none;color:#6F7E6A;font-size:22px;cursor:pointer;line-height:1;padding:0 4px">×</button>
      </div>
    </div>

    <div style="display:flex;flex-direction:column;gap:10px">

      <!-- TO field with chip autocomplete -->
      <div style="position:relative">
        <div style="display:flex;align-items:center;gap:0">
          <span style="font-size:11px;font-weight:700;color:#6F7E6A;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap;width:52px;flex-shrink:0">To</span>
          <div class="gw-chip-row" id="gw-to-chips" style="flex:1" onclick="_gwChipRowClick('to')">
            <input id="int-to-input" class="gw-chip-input" type="text" placeholder="Name or email…" autocomplete="off"
              oninput="_gwChipInputChange('to')" onkeydown="_gwChipInputKey(event,'to')">
          </div>
          <button onclick="_gwToggleCcBcc()" id="gw-ccbcc-btn" style="background:none;border:none;color:#6F7E6A;font-size:11px;font-weight:700;cursor:pointer;padding:0 0 0 8px;white-space:nowrap">CC BCC</button>
        </div>
        <div id="gw-to-ac" class="gw-ac-list" style="display:none;left:52px;right:0;top:100%;margin-top:2px"></div>
      </div>

      <!-- CC field -->
      <div style="position:relative;display:none" id="gw-cc-row">
        <div style="display:flex;align-items:center;gap:0">
          <span style="font-size:11px;font-weight:700;color:#6F7E6A;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap;width:52px;flex-shrink:0">CC</span>
          <div class="gw-chip-row" id="gw-cc-chips" style="flex:1" onclick="_gwChipRowClick('cc')">
            <input id="int-cc-input" class="gw-chip-input" type="text" placeholder="CC recipients…" autocomplete="off"
              oninput="_gwChipInputChange('cc')" onkeydown="_gwChipInputKey(event,'cc')">
          </div>
        </div>
        <div id="gw-cc-ac" class="gw-ac-list" style="display:none;left:52px;right:0;top:100%;margin-top:2px"></div>
      </div>

      <!-- BCC field -->
      <div style="position:relative;display:none" id="gw-bcc-row">
        <div style="display:flex;align-items:center;gap:0">
          <span style="font-size:11px;font-weight:700;color:#6F7E6A;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap;width:52px;flex-shrink:0">BCC</span>
          <div class="gw-chip-row" id="gw-bcc-chips" style="flex:1" onclick="_gwChipRowClick('bcc')">
            <input id="int-bcc-input" class="gw-chip-input" type="text" placeholder="BCC recipients…" autocomplete="off"
              oninput="_gwChipInputChange('bcc')" onkeydown="_gwChipInputKey(event,'bcc')">
          </div>
        </div>
        <div id="gw-bcc-ac" class="gw-ac-list" style="display:none;left:52px;right:0;top:100%;margin-top:2px"></div>
      </div>

      <!-- Subject -->
      <div style="display:flex;align-items:center;gap:0">
        <span style="font-size:11px;font-weight:700;color:#6F7E6A;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap;width:52px;flex-shrink:0">Subject</span>
        <input id="int-email-subject" type="text" placeholder="Email subject"
          style="flex:1;padding:8px 12px;background:var(--gw-surface-3,#263532);border:1px solid var(--gw-line,#2e4040);border-radius:8px;color:var(--gw-ink,#E8E4D9);font-size:13px;outline:none">
      </div>

      <!-- Link to Lead picker -->
      <div style="position:relative" id="gw-link-lead-row">
        <div style="display:flex;align-items:center;gap:0">
          <span style="font-size:11px;font-weight:700;color:#6F7E6A;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap;width:52px;flex-shrink:0">Lead</span>
          <!-- Badge shown when a lead is linked -->
          <div id="gw-link-lead-badge" style="display:none">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M3 2h5.5L11 4.5V12H3V2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 2v3h3" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" opacity=".6"/></svg>
            <span id="gw-link-lead-label">—</span>
            <span id="gw-link-lead-badge-x" onclick="_gwLinkLeadClear()" title="Remove lead link">×</span>
          </div>
          <!-- Search input shown when no lead linked -->
          <input id="gw-link-lead-input" type="text" placeholder="Search leads to link this email…" autocomplete="off"
            oninput="_gwLinkLeadInputChange()" onkeydown="_gwLinkLeadInputKey(event)" onfocus="_gwLinkLeadInputChange()">
        </div>
        <div id="gw-link-lead-ac" class="gw-ac-list" style="display:none"></div>
      </div>

      <!-- Rich text editor -->
      <div style="margin-top:4px">
        <!-- Toolbar -->
        <div class="gw-compose-toolbar" id="gw-rte-toolbar">
          <!-- Font family -->
          <select onchange="document.execCommand('fontName',false,this.value)" title="Font">
            <option value="Arial" selected>Arial</option>
            <option value="Georgia">Georgia</option>
            <option value="'Courier New'">Courier New</option>
            <option value="Verdana">Verdana</option>
            <option value="'Times New Roman'">Times New Roman</option>
          </select>
          <!-- Font size -->
          <select onchange="_gwRteFontSize(this.value)" title="Size" style="margin-left:2px;width:52px">
            <option value="1">10</option>
            <option value="2" selected>13</option>
            <option value="3">16</option>
            <option value="4">18</option>
            <option value="5">24</option>
            <option value="6">32</option>
          </select>
          <div class="tb-sep"></div>
          <!-- Format -->
          <button onclick="_gwRteCmd('bold')" title="Bold (Ctrl+B)" id="gw-tb-bold"><b>B</b></button>
          <button onclick="_gwRteCmd('italic')" title="Italic (Ctrl+I)" id="gw-tb-italic"><i>I</i></button>
          <button onclick="_gwRteCmd('underline')" title="Underline (Ctrl+U)" id="gw-tb-underline" style="text-decoration:underline">U</button>
          <button onclick="_gwRteCmd('strikeThrough')" title="Strikethrough" style="text-decoration:line-through">S</button>
          <div class="tb-sep"></div>
          <!-- Text color -->
          <button onclick="document.getElementById('gw-tb-color-inp').click()" title="Text color" style="font-size:16px;position:relative">
            <span id="gw-tb-color-icon" style="font-size:12px;font-weight:800;border-bottom:3px solid #E8E4D9">A</span>
            <input type="color" id="gw-tb-color-inp" value="#E8E4D9" style="position:absolute;opacity:0;width:1px;height:1px;top:0;left:0;pointer-events:none"
              onchange="_gwRteForeColor(this.value)">
          </button>
          <!-- Highlight color -->
          <button onclick="document.getElementById('gw-tb-hl-inp').click()" title="Highlight" style="font-size:16px;position:relative">
            <span style="font-size:12px;font-weight:800;background:#FFFF00;padding:0 2px;color:#111">H</span>
            <input type="color" id="gw-tb-hl-inp" value="#FFFF00" style="position:absolute;opacity:0;width:1px;height:1px;top:0;left:0;pointer-events:none"
              onchange="document.execCommand('backColor',false,this.value)">
          </button>
          <div class="tb-sep"></div>
          <!-- Lists & alignment -->
          <button onclick="_gwRteCmd('insertUnorderedList')" title="Bullet list" id="gw-tb-ul">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="4" y="2" width="9" height="1.5" rx=".7"/><rect x="4" y="6.2" width="9" height="1.5" rx=".7"/><rect x="4" y="10.4" width="9" height="1.5" rx=".7"/><circle cx="1.5" cy="2.75" r="1.2"/><circle cx="1.5" cy="6.95" r="1.2"/><circle cx="1.5" cy="11.15" r="1.2"/></svg>
          </button>
          <button onclick="_gwRteCmd('insertOrderedList')" title="Numbered list" id="gw-tb-ol">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="5" y="2" width="8" height="1.5" rx=".7"/><rect x="5" y="6.2" width="8" height="1.5" rx=".7"/><rect x="5" y="10.4" width="8" height="1.5" rx=".7"/><text x="0" y="4" font-size="4.5" font-family="Arial">1.</text><text x="0" y="8.5" font-size="4.5" font-family="Arial">2.</text><text x="0" y="13" font-size="4.5" font-family="Arial">3.</text></svg>
          </button>
          <button onclick="_gwRteCmd('indent')" title="Indent">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="0" y="1" width="13" height="1.5" rx=".7"/><rect x="3" y="5" width="10" height="1.5" rx=".7"/><rect x="3" y="9" width="10" height="1.5" rx=".7"/><rect x="0" y="12.5" width="13" height="1.5" rx=".7"/></svg>
          </button>
          <button onclick="_gwRteCmd('outdent')" title="Outdent">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="0" y="1" width="13" height="1.5" rx=".7"/><rect x="0" y="5" width="10" height="1.5" rx=".7"/><rect x="0" y="9" width="10" height="1.5" rx=".7"/><rect x="0" y="12.5" width="13" height="1.5" rx=".7"/></svg>
          </button>
          <div class="tb-sep"></div>
          <!-- Alignment -->
          <button onclick="_gwRteCmd('justifyLeft')" title="Align left">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="currentColor"><rect x="0" y="0" width="13" height="1.4" rx=".5"/><rect x="0" y="3.8" width="9" height="1.4" rx=".5"/><rect x="0" y="7.5" width="13" height="1.4" rx=".5"/><rect x="0" y="11.2" width="7" height="1.4" rx=".5"/></svg>
          </button>
          <button onclick="_gwRteCmd('justifyCenter')" title="Center">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="currentColor"><rect x="0" y="0" width="13" height="1.4" rx=".5"/><rect x="2" y="3.8" width="9" height="1.4" rx=".5"/><rect x="0" y="7.5" width="13" height="1.4" rx=".5"/><rect x="3" y="11.2" width="7" height="1.4" rx=".5"/></svg>
          </button>
          <div class="tb-sep"></div>
          <!-- Link -->
          <button onclick="_gwRteInsertLink()" title="Insert link">
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7.5 12.5a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66L9 5.34"/><path d="M12.5 7.5a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66L11 14.66"/></svg>
          </button>
          <!-- Blockquote -->
          <button onclick="_gwRteCmd('formatBlock','blockquote')" title="Blockquote" style="font-size:15px;font-weight:900;color:#6F7E6A">"</button>
        </div>
        <!-- Editable content area -->
        <div id="int-email-editor" contenteditable="true" data-placeholder="Write your message…"
          onkeydown="_gwRteKeyDown(event)"
          onmouseup="_gwRteUpdateToolbar()" onkeyup="_gwRteUpdateToolbar()">
        </div>
      </div>

      <!-- Signature section -->
      <div id="int-sig-section" style="display:none">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <div style="display:flex;align-items:center;gap:6px;flex:1">
            <div style="width:28px;height:1px;background:var(--gw-line)"></div>
            <span style="font-size:10px;font-weight:700;color:#6F7E6A;text-transform:uppercase;letter-spacing:.05em">Signature</span>
            <div style="flex:1;height:1px;background:var(--gw-line)"></div>
          </div>
          <button onclick="intToggleSig()" id="int-sig-toggle-btn"
            style="font-size:10px;font-weight:700;color:#6F7E6A;background:none;border:1px solid var(--gw-line);border-radius:5px;padding:2px 8px;cursor:pointer;margin-left:10px">
            Remove
          </button>
        </div>
        <div id="int-sig-preview"
          style="padding:10px 12px;background:var(--gw-surface-3,#263532);border:1px solid var(--gw-line);border-radius:8px;font-size:12px;line-height:1.5;color:var(--gw-ink,#1F2A2B);overflow:hidden;max-height:160px;overflow-y:auto">
        </div>
        <div id="int-sig-cta" style="display:none;padding:10px 12px;background:var(--gw-surface-3,#263532);border:1px solid var(--gw-line);border-radius:8px;font-size:12px;color:#6F7E6A"></div>
        <div style="font-size:10px;color:#6F7E6A;margin-top:4px" id="int-sig-source-label"></div>
      </div>

      <!-- Attachment pills -->
      <div id="gw-attach-list" style="display:none;display:flex;flex-wrap:wrap;gap:6px;min-height:0"></div>

      <!-- Bottom action bar -->
      <div class="gw-compose-bottom">
        <!-- Send button -->
        <button onclick="intSendEmail()" class="primary-btn" id="int-send-btn" style="display:flex;align-items:center;gap:6px;padding:8px 18px">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 10L17 3l-4 14-3-7-7-3z"/></svg>
          Send
        </button>

        <!-- Attach file -->
        <label title="Attach file" style="cursor:pointer;display:flex;align-items:center;gap:5px;color:#6F7E6A;font-size:12px;padding:6px 8px;border-radius:6px;transition:background .12s" onmouseover="this.style.background='var(--gw-surface-2)'" onmouseout="this.style.background='none'">
          <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M16.5 10.5l-6.5 6.5a5 5 0 0 1-7.07-7.07l7.78-7.78a3 3 0 0 1 4.24 4.24L7.17 14.17a1 1 0 0 1-1.41-1.41L12 6.5"/></svg>
          Attach
          <input type="file" id="gw-attach-input" multiple style="display:none" onchange="_gwHandleAttachments(event)">
        </label>

        <div style="flex:1"></div>
        <button onclick="document.getElementById('int-compose-modal').style.display='none'" class="secondary-btn" style="padding:8px 14px">Discard</button>
      </div>
    </div>
  </div>
</div>`;
}

// Ensure the compose modal exists in the DOM — inject into body if not yet rendered
// (handles calls from outside the Integrations view)
function gwEnsureComposeModal() {
  if (document.getElementById('int-compose-modal')) return;
  const div = document.createElement('div');
  div.innerHTML = _buildComposeModalHTML();
  // The template contains a <style> block FIRST and the modal <div> after it —
  // append ALL top-level children, not just the first (which was only the <style>,
  // leaving the modal out of the DOM and breaking compose from the lead screen).
  while (div.firstElementChild) document.body.appendChild(div.firstElementChild);
}

window.gwOpenCompose = async function(prefillTo='', prefillSubject='', prefillOppId='', prefillOppLabel='') {
  // Self-heal: inject modal into DOM if integrations() hasn't been called yet
  gwEnsureComposeModal();

  const modal = document.getElementById('int-compose-modal');
  if (!modal) { showIntToast('Could not open compose window', 'warn'); return; }

  // ── Reset chip recipients ─────────────────────────────────────────────────
  window._gwChips = { to: [], cc: [], bcc: [] };
  window._intAttachments = [];
  ['to','cc','bcc'].forEach(function(field) {
    const inp = document.getElementById('int-' + field + '-input');
    if (inp) inp.value = '';
    const row = document.getElementById('gw-' + field + '-chips');
    if (row) {
      // Remove all chips, keep the input
      Array.from(row.querySelectorAll('.gw-chip')).forEach(c => c.remove());
    }
  });

  // Prefill To if provided
  if (prefillTo) _gwChipAdd('to', prefillTo);

  // ── Reset subject ─────────────────────────────────────────────────────────
  const subjEl = document.getElementById('int-email-subject');
  if (subjEl) subjEl.value = prefillSubject || '';

  // ── Reset rich text editor ────────────────────────────────────────────────
  const editor = document.getElementById('int-email-editor');
  if (editor) editor.innerHTML = '';

  // ── Reset CC/BCC rows ─────────────────────────────────────────────────────
  const ccRow  = document.getElementById('gw-cc-row');
  const bccRow = document.getElementById('gw-bcc-row');
  if (ccRow)  ccRow.style.display  = 'none';
  if (bccRow) bccRow.style.display = 'none';

  // ── Reset attachments ─────────────────────────────────────────────────────
  const attachList = document.getElementById('gw-attach-list');
  if (attachList) { attachList.innerHTML = ''; attachList.style.display = 'none'; }
  const attachInput = document.getElementById('gw-attach-input');
  if (attachInput) attachInput.value = '';

  // ── Reset / pre-populate Link-to-Lead picker ──────────────────────────────
  window._gwComposeLinkedOppId    = prefillOppId    || '';
  window._gwComposeLinkedOppLabel = prefillOppLabel || '';
  _gwLinkLeadRender();

  // ── Reset sig state while loading ─────────────────────────────────────────
  const sigSection = document.getElementById('int-sig-section');
  const sigPreview = document.getElementById('int-sig-preview');
  const sigCta     = document.getElementById('int-sig-cta');
  const sigStatus  = document.getElementById('int-sig-status');
  const sigSrcLbl  = document.getElementById('int-sig-source-label');
  const sigToggle  = document.getElementById('int-sig-toggle-btn');

  if (sigSection) sigSection.style.display = 'none';
  if (sigPreview) sigPreview.innerHTML = '';
  if (sigCta)     { sigCta.style.display = 'none'; sigCta.innerHTML = ''; }
  if (sigStatus)  sigStatus.textContent = 'Loading signature…';
  if (sigSrcLbl)  sigSrcLbl.textContent = '';
  if (sigToggle)  { sigToggle.textContent = 'Remove'; sigToggle.style.display = ''; }
  window._intSigActive = false;
  window._intSigHtml   = '';
  window._intSigSource = '';

  // ── Reset send button ─────────────────────────────────────────────────────
  const sendBtn = document.getElementById('int-send-btn');
  if (sendBtn) { sendBtn.disabled = false; sendBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 10L17 3l-4 14-3-7-7-3z"/></svg> Send'; }

  // Show modal immediately — signature loads async below
  modal.style.display = 'flex';
  // Focus the To input (if empty) or Subject
  setTimeout(function() {
    if (!window._gwChips?.to?.length) {
      const toInp = document.getElementById('int-to-input');
      if (toInp) toInp.focus();
    } else {
      if (subjEl) subjEl.focus();
    }
  }, 80);

  // ── Async: load signature (Gmail API → manual fallback) ──────────────────
  try {
    let sig    = '';
    let source = '';

    if (isGoogleConnected()) {
      // Reset scope-error flag before each attempt so reconnected users get a
      // fresh result instead of seeing a stale error state
      window._gmailSigScopeError = false;
      const apiSig = await gmailFetchSendAsSignature();
      if (apiSig) {
        sig    = apiSig;
        source = 'gmail';
        // Cache in per-user record for future opens
        try {
          const rep = window.getCurrentRep ? window.getCurrentRep() : null;
          if (rep) {
            const m = JSON.parse(localStorage.getItem('avalonUserGoogleV1') || '{}');
            if (!m[rep.id]) m[rep.id] = {};
            m[rep.id].signature = apiSig;
            localStorage.setItem('avalonUserGoogleV1', JSON.stringify(m));
          }
        } catch(_) {}
      }
    }

    // Fall back to manual D1 rep signature
    if (!sig) {
      const rep = window.getCurrentRep ? window.getCurrentRep() : null;
      const manualSig = rep?.email_signature || '';
      if (manualSig) { sig = manualSig; source = 'manual'; }
    }

    if (sigStatus) sigStatus.textContent = '';

    if (sig) {
      // ── Happy path: we have a signature ──────────────────────────────────
      window._intSigHtml   = sig;
      window._intSigSource = source;
      window._intSigActive = true;

      if (sigPreview) { sigPreview.style.display = 'block'; sigPreview.innerHTML = sig; }
      if (sigCta)     sigCta.style.display = 'none';
      if (sigSection) sigSection.style.display = 'block';
      if (sigToggle)  sigToggle.textContent = 'Remove';
      if (sigSrcLbl)  sigSrcLbl.textContent = source === 'gmail'
        ? '✓ Synced from your Gmail signature'
        : '✓ Using your saved email signature';

    } else if (isGoogleConnected() && window._gmailSigScopeError) {
      // ── Scope error: token lacks gmail.settings.basic — show reconnect CTA
      if (sigPreview) sigPreview.style.display = 'none';
      if (sigCta) {
        sigCta.style.display = 'block';
        sigCta.innerHTML = `
          <div style="display:flex;align-items:flex-start;gap:10px">
            <span style="flex-shrink:0;display:flex;align-items:center">${(typeof gwIcon==='function')?gwIcon('sync',16,'#4D8A86'):''}</span>
            <div>
              <div style="font-weight:700;color:var(--gds-ink,#1F2A2B);margin-bottom:4px">Reconnect Google to sync your Gmail signature</div>
              <div style="font-size:11px;color:#6F7E6A;margin-bottom:8px">Your Google connection was made before email signature access was added. A quick reconnect grants the new permission — takes 5 seconds.</div>
              <button onclick="gwSigReconnect()" style="font-size:11px;font-weight:700;padding:5px 12px;background:#4D8A86;color:#fff;border:none;border-radius:6px;cursor:pointer">Reconnect Google →</button>
            </div>
          </div>`;
      }
      if (sigSection) sigSection.style.display = 'block';
      if (sigToggle)  sigToggle.style.display = 'none';
      if (sigSrcLbl)  sigSrcLbl.textContent = '';

    } else {
      // ── No signature at all: show a setup CTA so user knows the feature exists
      if (sigPreview) sigPreview.style.display = 'none';
      if (sigCta) {
        sigCta.style.display = 'block';
        if (isGoogleConnected()) {
          sigCta.innerHTML = `
            <div style="display:flex;align-items:flex-start;gap:10px">
              <span style="flex-shrink:0;display:flex;align-items:center">${(typeof gwIcon==='function')?gwIcon('signoff',16,'#4D8A86'):''}</span>
              <div>
                <div style="font-weight:700;color:var(--gds-ink,#1F2A2B);margin-bottom:4px">No signature found</div>
                <div style="font-size:11px;color:#6F7E6A;margin-bottom:8px">Your Gmail account has no default signature set, or it's empty. Add one in Gmail settings, or set a manual signature in Groundwork Settings.</div>
                <button onclick="gwSigRefreshAndReopen('${(prefillTo||'').replace(/'/g,"\\'")}','${(prefillSubject||'').replace(/'/g,"\\'")}'); document.getElementById('int-compose-modal').style.display='none';" style="font-size:11px;font-weight:700;padding:5px 12px;background:var(--gw-surface-3);color:#6F7E6A;border:1px solid var(--gw-line);border-radius:6px;cursor:pointer">Retry sync</button>
              </div>
            </div>`;
        } else {
          sigCta.innerHTML = `
            <div style="display:flex;align-items:flex-start;gap:10px">
              <span style="flex-shrink:0;display:flex;align-items:center">${(typeof gwIcon==='function')?gwIcon('signoff',16,'#4D8A86'):''}</span>
              <div>
                <div style="font-weight:700;color:var(--gds-ink,#1F2A2B);margin-bottom:4px">Add your email signature</div>
                <div style="font-size:11px;color:#6F7E6A;margin-bottom:8px">Set up a signature in <strong>Settings → Google &amp; Signature</strong> to have it auto-added to every email you send from Groundwork.</div>
                <button onclick="window.navigate&&window.navigate('settings');document.getElementById('int-compose-modal').style.display='none'" style="font-size:11px;font-weight:700;padding:5px 12px;background:#4D8A86;color:#fff;border:none;border-radius:6px;cursor:pointer">Go to Settings →</button>
              </div>
            </div>`;
        }
      }
      if (sigSection) sigSection.style.display = 'block';
      if (sigToggle)  sigToggle.style.display = 'none';
      if (sigSrcLbl)  sigSrcLbl.textContent = '';
    }
  } catch(e) {
    if (sigStatus) sigStatus.textContent = '';
    console.warn('[Groundwork] Signature load failed:', e.message);
  }
};

// Reconnect Google — re-runs OAuth to pick up gmail.settings.basic scope
window.gwSigReconnect = async function() {
  const cta = document.getElementById('int-sig-cta');
  if (cta) cta.innerHTML = '<div style="color:#6F7E6A;font-size:12px">Opening Google sign-in…</div>';
  const ok = await googleOAuthConnect();
  if (ok) {
    showIntToast('Google reconnected ✓', 'success');
    // Re-trigger the signature load in the currently open compose window
    const subjEl = document.getElementById('int-email-subject');
    const subj   = subjEl?.value || '';
    const to     = (window._gwChips?.to || [])[0] || '';
    // Brief pause then reopen
    setTimeout(() => window.gwOpenCompose(to, subj), 300);
  } else {
    showIntToast('Could not reconnect Google', 'warn');
    if (cta) cta.innerHTML = '<div style="color:#c0392b;font-size:12px">Reconnect failed — please try again</div>';
  }
};

// Refresh signature from Gmail and re-open compose
window.gwSigRefreshAndReopen = async function(to='', subj='') {
  window._gmailSigScopeError = false;
  try {
    const rep = window.getCurrentRep ? window.getCurrentRep() : null;
    if (rep) {
      const m = JSON.parse(localStorage.getItem('avalonUserGoogleV1') || '{}');
      if (m[rep.id]) { delete m[rep.id].signature; localStorage.setItem('avalonUserGoogleV1', JSON.stringify(m)); }
    }
  } catch(_) {}
  await window.gwOpenCompose(to, subj);
};

function intToggleSig() {
  window._intSigActive = !window._intSigActive;
  const sigSection = document.getElementById('int-sig-section');
  const sigToggle  = document.getElementById('int-sig-toggle-btn');
  if (sigSection) sigSection.style.display = window._intSigActive ? 'block' : 'none';
  if (sigToggle)  sigToggle.textContent    = window._intSigActive ? 'Remove' : 'Add back';
  if (!window._intSigActive && sigSection) {
    // Keep section visible but visually dim when toggled off, just hide the preview
    sigSection.style.display = 'none';
  } else if (window._intSigActive && window._intSigHtml) {
    sigSection.style.display = 'block';
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// COMPOSE HELPERS — chip recipients, rich-text editor, attachments
// ══════════════════════════════════════════════════════════════════════════════

// ── Link-to-Lead picker ───────────────────────────────────────────────────────
window._gwComposeLinkedOppId    = '';
window._gwComposeLinkedOppLabel = '';

function _gwLinkLeadRender() {
  const badge  = document.getElementById('gw-link-lead-badge');
  const input  = document.getElementById('gw-link-lead-input');
  const label  = document.getElementById('gw-link-lead-label');
  const ac     = document.getElementById('gw-link-lead-ac');
  if (!badge || !input) return;
  if (window._gwComposeLinkedOppId) {
    badge.style.display = 'flex';
    input.style.display = 'none';
    if (label) label.textContent = window._gwComposeLinkedOppLabel || 'Lead';
    if (ac) ac.style.display = 'none';
  } else {
    badge.style.display = 'none';
    input.style.display = '';
    input.value = '';
    if (ac) ac.style.display = 'none';
  }
}

function _gwLinkLeadClear() {
  window._gwComposeLinkedOppId    = '';
  window._gwComposeLinkedOppLabel = '';
  _gwLinkLeadRender();
  const input = document.getElementById('gw-link-lead-input');
  if (input) { input.value = ''; input.focus(); }
}

function _gwLinkLeadSelect(oppId, oppLabel) {
  window._gwComposeLinkedOppId    = oppId;
  window._gwComposeLinkedOppLabel = oppLabel;
  _gwLinkLeadRender();
}

function _gwLinkLeadInputChange() {
  const input = document.getElementById('gw-link-lead-input');
  const ac    = document.getElementById('gw-link-lead-ac');
  if (!input || !ac) return;
  const q = (input.value || '').toLowerCase().trim();
  const opps = window._avalonState?.opportunities || [];
  const matches = opps.filter(function(o) {
    if (!o.id) return false;
    const name  = (o.client || o.name || '').toLowerCase();
    const email = (o.email || '').toLowerCase();
    const proj  = (o.project || '').toLowerCase();
    return !q || name.includes(q) || email.includes(q) || proj.includes(q);
  }).slice(0, 12);

  if (!matches.length) { ac.style.display = 'none'; return; }

  ac.innerHTML = matches.map(function(o, idx) {
    const name    = escapeHtml(o.client || o.name || 'Lead');
    const sub     = escapeHtml((o.project || o.serviceLine || o.status || '').slice(0, 50));
    const email   = escapeHtml(o.email || '');
    return `<div class="gw-ac-item" data-idx="${idx}" onmousedown="_gwLinkLeadSelect('${o.id.replace(/'/g,"\\'")}','${name.replace(/'/g,"\\'")}')" style="cursor:pointer">
      <span>${name}</span>
      <span class="gw-ac-sub">${sub}${email ? (sub ? ' · ' : '') + email : ''}</span>
    </div>`;
  }).join('');
  ac.style.display = 'block';
}

function _gwLinkLeadInputKey(event) {
  if (event.key === 'Escape') {
    const ac = document.getElementById('gw-link-lead-ac');
    if (ac) ac.style.display = 'none';
  }
}

window._gwLinkLeadClear        = _gwLinkLeadClear;
window._gwLinkLeadSelect       = _gwLinkLeadSelect;
window._gwLinkLeadInputChange  = _gwLinkLeadInputChange;
window._gwLinkLeadInputKey     = _gwLinkLeadInputKey;

// ── Chip recipient system ─────────────────────────────────────────────────────
window._gwChips = { to: [], cc: [], bcc: [] };

function _gwGetContactList() {
  // Merge leads + clients into a searchable contact list
  const contacts = [];
  try {
    const opps = window._avalonState?.opportunities || [];
    opps.forEach(function(o) {
      if (o.email) contacts.push({ name: o.client || o.name || '', email: o.email });
      else if (o.client) contacts.push({ name: o.client, email: '' });
    });
  } catch(_) {}
  try {
    const clients = JSON.parse(localStorage.getItem('avalonClientsV1') || '[]');
    clients.forEach(function(c) {
      if (c.email) contacts.push({ name: c.name || (c.firstName + ' ' + (c.lastName || '')).trim(), email: c.email });
    });
  } catch(_) {}
  // Deduplicate by email
  const seen = new Set();
  return contacts.filter(function(c) {
    if (!c.email) return false;
    const key = c.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function _gwChipAdd(field, value) {
  value = value.trim();
  if (!value) return;
  if (!window._gwChips) window._gwChips = { to: [], cc: [], bcc: [] };
  if (window._gwChips[field].includes(value)) return;
  window._gwChips[field].push(value);

  // Render chip in DOM
  const row = document.getElementById('gw-' + field + '-chips');
  const inp = document.getElementById('int-' + field + '-input');
  if (!row || !inp) return;
  const chip = document.createElement('span');
  chip.className = 'gw-chip';
  chip.dataset.email = value;
  chip.innerHTML = escapeHtml(value) + '<span class="gw-chip-x" onclick="_gwChipRemove(\'' + field + '\',\'' + value.replace(/'/g, "\\'") + '\',this.parentElement)">×</span>';
  row.insertBefore(chip, inp);
  inp.value = '';
}

window._gwChipRemove = function(field, value, chipEl) {
  if (!window._gwChips) return;
  window._gwChips[field] = (window._gwChips[field] || []).filter(function(v) { return v !== value; });
  if (chipEl) chipEl.remove();
};

function _gwChipCommit(field) {
  const inp = document.getElementById('int-' + field + '-input');
  if (!inp) return;
  const val = inp.value.trim();
  if (val) _gwChipAdd(field, val);
}

window._gwChipRowClick = function(field) {
  const inp = document.getElementById('int-' + field + '-input');
  if (inp) inp.focus();
};

window._gwChipInputKey = function(event, field) {
  const inp = event.target;
  if (event.key === 'Enter' || event.key === ',' || event.key === 'Tab') {
    event.preventDefault();
    const val = inp.value.trim().replace(/,+$/, '');
    if (val) _gwChipAdd(field, val);
    _gwAcHide(field);
  } else if (event.key === 'Backspace' && !inp.value) {
    // Remove last chip on backspace when input is empty
    const chips = window._gwChips?.[field] || [];
    if (chips.length) _gwChipRemove(field, chips[chips.length - 1], document.querySelector('#gw-' + field + '-chips .gw-chip:last-of-type'));
  } else if (event.key === 'ArrowDown') {
    _gwAcMoveFocus(field, 1);
  } else if (event.key === 'ArrowUp') {
    _gwAcMoveFocus(field, -1);
  } else if (event.key === 'Escape') {
    _gwAcHide(field);
  }
};

window._gwChipInputChange = function(field) {
  const inp = document.getElementById('int-' + field + '-input');
  if (!inp) return;
  const q = inp.value.toLowerCase().trim();
  if (q.length < 1) { _gwAcHide(field); return; }
  const contacts = _gwGetContactList();
  const matches = contacts.filter(function(c) {
    return c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q);
  }).slice(0, 8);
  if (!matches.length) { _gwAcHide(field); return; }
  _gwAcShow(field, matches, inp);
};

let _gwAcActive = null; // { field, items, focusIdx }

function _gwAcShow(field, items, anchorEl) {
  _gwAcHide(field);
  const list = document.getElementById('gw-' + field + '-ac');
  if (!list) return;
  list.innerHTML = items.map(function(c, i) {
    return '<div class="gw-ac-item" data-idx="' + i + '" data-email="' + escapeHtml(c.email) + '"' +
      ' onclick="_gwAcSelect(\'' + field + '\',' + i + ')">' +
      '<span>' + escapeHtml(c.name || c.email) + '</span>' +
      (c.name && c.email !== c.name ? '<span class="gw-ac-sub">' + escapeHtml(c.email) + '</span>' : '') +
      '</div>';
  }).join('');
  list.style.display = 'block';
  _gwAcActive = { field, items, focusIdx: -1 };
}

function _gwAcHide(field) {
  const list = document.getElementById('gw-' + (field || (_gwAcActive && _gwAcActive.field) || 'to') + '-ac');
  if (list) list.style.display = 'none';
  _gwAcActive = null;
}

window._gwAcSelect = function(field, idx) {
  if (!_gwAcActive) return;
  const item = _gwAcActive.items[idx];
  if (item) _gwChipAdd(field, item.email);
  _gwAcHide(field);
};

function _gwAcMoveFocus(field, dir) {
  if (!_gwAcActive) return;
  const items = document.querySelectorAll('#gw-' + field + '-ac .gw-ac-item');
  if (!items.length) return;
  _gwAcActive.focusIdx = Math.max(0, Math.min(items.length - 1, _gwAcActive.focusIdx + dir));
  items.forEach(function(el, i) { el.classList.toggle('active', i === _gwAcActive.focusIdx); });
  // Enter selects focused
  const focused = items[_gwAcActive.focusIdx];
  if (focused) {
    const overrideKey = function(e) {
      if (e.key === 'Enter') { e.preventDefault(); _gwAcSelect(field, _gwAcActive.focusIdx); document.removeEventListener('keydown', overrideKey); }
    };
    document.addEventListener('keydown', overrideKey, { once: true });
  }
}

// Close autocomplete on outside click
document.addEventListener('click', function(e) {
  if (_gwAcActive && !e.target.closest('.gw-chip-row') && !e.target.closest('.gw-ac-list')) {
    _gwAcHide(_gwAcActive.field);
  }
}, true);

// ── CC / BCC toggle ───────────────────────────────────────────────────────────
window._gwToggleCcBcc = function() {
  const ccRow  = document.getElementById('gw-cc-row');
  const bccRow = document.getElementById('gw-bcc-row');
  const btn    = document.getElementById('gw-ccbcc-btn');
  if (!ccRow || !bccRow) return;
  const showing = ccRow.style.display !== 'none';
  ccRow.style.display  = showing ? 'none' : '';
  bccRow.style.display = showing ? 'none' : '';
  if (btn) btn.textContent = showing ? 'CC BCC' : 'Hide';
  if (!showing) {
    const ccInp = document.getElementById('int-cc-input');
    if (ccInp) ccInp.focus();
  }
};

// ── Rich-text editor helpers ──────────────────────────────────────────────────
window._gwRteCmd = function(cmd, val) {
  const editor = document.getElementById('int-email-editor');
  if (!editor) return;
  editor.focus();
  document.execCommand(cmd, false, val || null);
  _gwRteUpdateToolbar();
};

window._gwRteFontSize = function(size) {
  document.execCommand('fontSize', false, size);
};

window._gwRteForeColor = function(color) {
  document.execCommand('foreColor', false, color);
  const icon = document.getElementById('gw-tb-color-icon');
  if (icon) icon.style.borderBottomColor = color;
};

window._gwRteUpdateToolbar = function() {
  try {
    ['bold','italic','underline'].forEach(function(cmd) {
      const btn = document.getElementById('gw-tb-' + cmd);
      if (btn) btn.classList.toggle('active', document.queryCommandState(cmd));
    });
  } catch(_) {}
};

window._gwRteKeyDown = function(e) {
  // Tab → indent (don't lose focus)
  if (e.key === 'Tab') {
    e.preventDefault();
    document.execCommand('insertHTML', false, '&nbsp;&nbsp;&nbsp;&nbsp;');
  }
};

window._gwRteInsertLink = function() {
  const url = prompt('Enter URL:', 'https://');
  if (url) document.execCommand('createLink', false, url);
};

// ── Attachment handler ────────────────────────────────────────────────────────
window._gwHandleAttachments = function(event) {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;
  const listEl = document.getElementById('gw-attach-list');
  if (!listEl) return;
  listEl.style.display = 'flex';

  files.forEach(function(file) {
    const reader = new FileReader();
    reader.onload = function(e) {
      // Strip data URI prefix to get raw base64
      const b64 = e.target.result.split(',')[1];
      const att = { name: file.name, mimeType: file.type || 'application/octet-stream', data: b64 };
      window._intAttachments = window._intAttachments || [];
      window._intAttachments.push(att);

      // Render pill
      const pill = document.createElement('span');
      pill.className = 'gw-attach-pill';
      const sizeStr = file.size > 1024*1024 ? (file.size/1024/1024).toFixed(1)+'MB' : (file.size/1024).toFixed(0)+'KB';
      pill.innerHTML = ((typeof gwIcon==='function')?gwIcon('attachment',12):'') + ' ' + escapeHtml(file.name) + ' <span style="color:var(--gw-muted);font-size:10px">(' + sizeStr + ')</span>' +
        '<span class="gw-attach-pill-x" onclick="_gwRemoveAttachment(\'' + escapeHtml(file.name).replace(/'/g,"\\'") + '\',this.parentElement)">×</span>';
      listEl.appendChild(pill);
    };
    reader.readAsDataURL(file);
  });
};

window._gwRemoveAttachment = function(name, pillEl) {
  window._intAttachments = (window._intAttachments || []).filter(function(a) { return a.name !== name; });
  if (pillEl) pillEl.remove();
  const listEl = document.getElementById('gw-attach-list');
  if (listEl && !listEl.children.length) listEl.style.display = 'none';
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
      ${_calView===v?'background:#4D8A86;color:#fff;border:1.5px solid #4D8A86':'background:var(--gw-surface-2);color:var(--gw-muted);border:1.5px solid var(--gw-line)'}">
      ${l}
    </button>`).join('')}
  </div>
  <div style="display:flex;gap:6px;align-items:center">
    <button onclick="gwCalPrev()" class="gw-cal-nav-btn" style="border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px">‹</button>
    <span id="gw-cal-label" style="font-size:13px;font-weight:700;color:var(--gw-ink,#1F2A2B);min-width:140px;text-align:center"></span>
    <button onclick="gwCalNext()" class="gw-cal-nav-btn" style="border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px">›</button>
    <button onclick="gwCalGoToday()" class="gw-cal-today-btn" style="border-radius:6px;padding:6px 12px;cursor:pointer;font-size:12px;font-weight:700">Today</button>
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
    el.innerHTML = `<div style="color:#C97B6A;padding:20px;font-size:13px">Error: ${escapeHtml(e.message)}</div>`;
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
      btn.style.background = v===_calView?'#4D8A86':'var(--gw-surface-2)';
      btn.style.color      = v===_calView?'#fff':'#6F7E6A';
      btn.style.borderColor= v===_calView?'#4D8A86':'var(--gw-line)';
    }
  });

  // Update label
  const labelEl = document.getElementById('gw-cal-label');
  if (labelEl) {
    const today = new Date();
    if (_calView==='agenda') {
    const td = new Date();
    labelEl.textContent = td.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric',year:'numeric'});
  }
    else if (_calView==='week') {
      const ws = new Date(today); ws.setDate(today.getDate() - today.getDay() + _calWeekOffset*7);
      const we = new Date(ws); we.setDate(ws.getDate()+6);
      labelEl.textContent = ws.toLocaleDateString(undefined,{month:'short',day:'numeric'})+' – '+we.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});
    } else {
      const d = new Date(today.getFullYear(), today.getMonth()+_calMonthOffset, 1);
      labelEl.textContent = d.toLocaleDateString(undefined,{month:'long',year:'numeric'});
    }
  }

  if (_calView==='agenda') el.innerHTML = gwRenderAgendaDay();
  else if (_calView==='week') el.innerHTML = gwRenderWeek();
  else el.innerHTML = gwRenderMonth();
}

function gwEventColor(ev) {
  // Google Calendar's real event palette — vivid, high-contrast colors that
  // stand out against the app's green theme (old palette was all theme-greens
  // and events blended into the background).
  const colors = {
    1:'#7986CB',  // Lavender
    2:'#33B679',  // Sage
    3:'#8E24AA',  // Grape
    4:'#E67C73',  // Flamingo
    5:'#F6BF26',  // Banana
    6:'#F4511E',  // Tangerine
    7:'#039BE5',  // Peacock
    8:'#616161',  // Graphite
    9:'#3F51B5',  // Blueberry
    10:'#0B8043', // Basil
    11:'#D50000'  // Tomato
  };
  if (ev.colorId && colors[ev.colorId]) return colors[ev.colorId];
  return '#1967D2'; // Default: Google Calendar blue — distinct from the app's green UI
}

// Pick readable text color (dark ink on light fills like Banana, white on dark fills)
function gwEventTextColor(bg) {
  const hex = (bg||'').replace('#','');
  if (hex.length < 6) return '#fff';
  const r=parseInt(hex.slice(0,2),16), g=parseInt(hex.slice(2,4),16), b=parseInt(hex.slice(4,6),16);
  const yiq = (r*299 + g*587 + b*114) / 1000;
  return yiq >= 160 ? '#1F2A2B' : '#fff';
}

function gwRenderAgendaDay() {
  // Show only today's events (agenda = day view for today)
  const today = new Date();
  today.setHours(0,0,0,0);
  const todayEnd = new Date(today); todayEnd.setHours(23,59,59,999);

  const todayEvs = _calEvents.filter(ev => {
    const start = ev.start?.dateTime || ev.start?.date || '';
    if (!start) return false;
    // For all-day events the date string is "YYYY-MM-DD"; parse as local midnight
    let evStart;
    if (ev.start?.date && !ev.start?.dateTime) {
      const [yr,mo,dy] = ev.start.date.split('-').map(Number);
      evStart = new Date(yr, mo-1, dy);
    } else {
      evStart = new Date(start);
    }
    return evStart >= today && evStart <= todayEnd;
  });

  if (!todayEvs.length) {
    return '<div style="text-align:center;padding:56px 20px;background:var(--gw-surface-2);border-radius:10px;border:1px solid var(--gw-line)">' +
           `<div style="font-size:36px;margin-bottom:12px">${gwIcon('calendar',16)}</div>` +
           '<div style="font-size:15px;font-weight:700;color:#6F7E6A">No events today</div>' +
           '<div style="font-size:13px;margin-top:6px;color:#6F7E6A">Your calendar is clear — enjoy the day.</div>' +
           '</div>';
  }

  // Sort by start time
  todayEvs.sort((a,b) => {
    const ta = a.start?.dateTime||a.start?.date||'';
    const tb = b.start?.dateTime||b.start?.date||'';
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });

  return `<div style="display:flex;flex-direction:column;gap:8px;max-height:70vh;overflow-y:auto;padding-right:4px">` +
    todayEvs.map(ev => {
      const start = ev.start?.dateTime || ev.start?.date || '';
      const end   = ev.end?.dateTime   || ev.end?.date   || '';
      const isAllDay = !ev.start?.dateTime;
      const color = gwEventColor(ev);
      const timeStr = isAllDay ? 'All day' :
        new Date(start).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}) +
        (end ? ' – '+new Date(end).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}) : '');
      return `<div onclick="gwCalEventClick('${escapeHtml(ev.id)}')"
        style="display:flex;gap:12px;padding:12px 14px;border-radius:10px;cursor:pointer;
        background:var(--gw-surface-3);border:1px solid var(--gw-line);border-left:4px solid ${color};transition:background .15s"
        onmouseover="this.style.background='var(--gw-surface-3)'" onmouseout="this.style.background='var(--gw-surface-3)'">
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:700;color:var(--gw-ink,#1F2A2B);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(ev.summary||'(No title)')}</div>
          <div style="font-size:12px;color:#6F7E6A;margin-top:4px">${timeStr}${ev.location?' · '+gwIcon('pin',16)+escapeHtml(ev.location.slice(0,50)):''}</div>
          ${ev.description?`<div style="font-size:12px;color:#6F7E6A;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(ev.description.slice(0,100))}</div>`:''}
        </div>
        <span style="font-size:10px;font-weight:700;color:${gwEventTextColor(color)};background:${color};border-radius:10px;padding:3px 10px;flex-shrink:0;align-self:center">TODAY</span>
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

  let html = `<div style="overflow-x:auto;border-radius:8px;border:1px solid var(--gw-line);overflow:hidden"><div style="display:grid;grid-template-columns:52px repeat(7,1fr);min-width:600px">
    <div style="background:var(--gw-surface-3);border-bottom:1px solid var(--gw-line)"></div>
    ${days.map(d => {
      const isToday = d.toDateString()===today.toDateString();
      const isPast  = d < today && !isToday;
      return `<div style="padding:8px 4px;text-align:center;border-bottom:1px solid var(--gw-line);border-left:1px solid var(--gw-line);background:var(--gw-surface-3)">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:${isToday?'#4D8A86':isPast?'#4A5947':'#6F7E6A'}">${dowLabels[d.getDay()]}</div>
        <div style="font-size:18px;font-weight:800;color:${isToday?'#fff':isPast?'#9AA6A0':'var(--gw-ink,#1F2A2B)'};width:32px;height:32px;border-radius:50%;background:${isToday?'#4D8A86':'transparent'};display:flex;align-items:center;justify-content:center;margin:2px auto 0">${d.getDate()}</div>
      </div>`;
    }).join('')}
    ${hours.map(h => {
      const label = h===0?'12 AM':h<12?`${h} AM`:h===12?'12 PM':`${h-12} PM`;
      const isCurrentHour = h===today.getHours() && _calWeekOffset===0;
      return `
        <div style="padding:2px 6px;text-align:right;font-size:10px;font-weight:600;border-top:1px solid var(--gw-line);line-height:40px;height:40px;box-sizing:border-box;color:${isCurrentHour?'#4D8A86':'#5C6B58'};background:var(--gw-surface)">${label}</div>
        ${days.map(d => {
          const cellEvs = _calEvents.filter(ev => {
            if (ev.start?.dateTime) {
              const s = new Date(ev.start.dateTime);
              return s.getFullYear()===d.getFullYear()&&s.getMonth()===d.getMonth()&&s.getDate()===d.getDate()&&s.getHours()===h;
            }
            // All-day events: show in the 12 AM (h===0) row for their date
            if (ev.start?.date && h===0) {
              const [yr,mo,dy] = ev.start.date.split('-').map(Number);
              return yr===d.getFullYear()&&(mo-1)===d.getMonth()&&dy===d.getDate();
            }
            return false;
          });
          const isNowCell = isCurrentHour && d.toDateString()===today.toDateString();
          const isTodayCol = d.toDateString()===today.toDateString();
          const cellBg = isNowCell ? '#4D8A8628' : isTodayCol ? 'var(--gw-surface-2)' : 'var(--gw-surface)';
          return `<div style="border-top:1px solid var(--gw-line);border-left:1px solid var(--gw-line);height:40px;position:relative;background:${cellBg}">
            ${cellEvs.map(ev=>{
              const color=gwEventColor(ev);
              const txt=gwEventTextColor(color);
              const t=ev.start?.dateTime?new Date(ev.start.dateTime).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}):'All day';
              return `<div onclick="gwCalEventClick('${escapeHtml(ev.id)}')" title="${escapeHtml(ev.summary||'')}" style="position:absolute;inset:1px 2px auto;background:${color};border-radius:4px;padding:2px 5px;font-size:10px;font-weight:700;color:${txt};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;z-index:1;${txt==='#fff'?'text-shadow:0 1px 2px #0006;':''}box-shadow:0 1px 3px rgba(0,0,0,.25)">${t} ${escapeHtml((ev.summary||'Event').slice(0,20))}</div>`;
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

  let html = `<div style="display:grid;grid-template-columns:repeat(7,1fr);border-left:1px solid var(--gw-line);border-top:1px solid var(--gw-line);border-radius:8px;overflow:hidden">
    ${dowLabels.map(d=>`<div style="padding:8px 4px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--gw-muted);border-right:1px solid var(--gw-line);border-bottom:1px solid var(--gw-line);background:var(--gw-surface-3)">${d}</div>`).join('')}
    ${Array.from({length:firstDay},()=>`<div style="border-right:1px solid var(--gw-line);border-bottom:1px solid var(--gw-line);min-height:90px;background:var(--gw-surface)"></div>`).join('')}
    ${Array.from({length:daysInMonth},(_,i)=>{
      const day=i+1;
      const cellDate=new Date(year,month,day);
      const isToday=cellDate.toDateString()===today.toDateString();
      const isPast=cellDate<new Date(today.getFullYear(),today.getMonth(),today.getDate());
      const dayEvs=_calEvents.filter(ev=>{
        if (ev.start?.dateTime) {
          const d=new Date(ev.start.dateTime);
          return d.getFullYear()===year&&d.getMonth()===month&&d.getDate()===day;
        }
        if (ev.start?.date) {
          const [yr,mo,dy]=ev.start.date.split('-').map(Number);
          return yr===year&&(mo-1)===month&&dy===day;
        }
        return false;
      });
      const cellBg = isToday ? '#4D8A8618' : isPast ? 'var(--gw-surface)' : 'var(--gw-surface-2)';
      const numColor = isToday ? '#4D8A86' : isPast ? '#4A5947' : '#6F7E6A';
      const numBg = isToday ? '#4D8A86' : 'transparent';
      const numTextColor = isToday ? '#fff' : numColor;
      return `<div style="border-right:1px solid var(--gw-line);border-bottom:1px solid var(--gw-line);min-height:90px;padding:5px;background:${cellBg}">
        <div style="font-size:13px;font-weight:700;color:${numTextColor};width:26px;height:26px;border-radius:50%;background:${numBg};display:flex;align-items:center;justify-content:center;margin-bottom:4px">${day}</div>
        ${dayEvs.slice(0,3).map(ev=>{
          const color=gwEventColor(ev);
          const txt=gwEventTextColor(color);
          const isAllDay=!ev.start?.dateTime;
          const t=isAllDay?'All day':new Date(ev.start.dateTime).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
          return `<div onclick="gwCalEventClick('${escapeHtml(ev.id)}')" title="${escapeHtml(ev.summary||'')}"
            style="background:${color};border-radius:4px;padding:2px 5px;font-size:10px;font-weight:700;color:${txt};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;margin-bottom:2px;${txt==='#fff'?'text-shadow:0 1px 2px #0004;':''}box-shadow:0 1px 2px rgba(0,0,0,.18)">
            ${t} ${escapeHtml((ev.summary||'Event').slice(0,18))}
          </div>`;
        }).join('')}
        ${dayEvs.length>3?`<div style="font-size:10px;color:#6F7E6A;padding-left:2px;font-weight:600">+${dayEvs.length-3} more</div>`:''}
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
<div class="gw-modal-card" style="border-radius:16px;padding:24px;width:min(480px,100%);max-height:85vh;overflow-y:auto">
  <div style="display:flex;justify-content:space-between;margin-bottom:16px">
    <div style="display:flex;gap:10px;align-items:flex-start">
      <div style="width:4px;background:${color};border-radius:2px;align-self:stretch;min-height:20px"></div>
      <div>
        <div style="font-weight:800;font-size:17px;color:var(--gw-ink,#1F2A2B)">${escapeHtml(ev.summary||'(No title)')}</div>
        <div style="font-size:12px;color:#6F7E6A;margin-top:4px">${timeStr}</div>
        ${ev.location?`<div style="font-size:12px;color:#6F7E6A;margin-top:2px">${gwIcon('pin',16)} ${escapeHtml(ev.location)}</div>`:''}
      </div>
    </div>
    <button onclick="document.getElementById('gw-event-modal').remove()" style="background:none;border:none;color:#6F7E6A;cursor:pointer;font-size:20px;padding:0 4px;flex-shrink:0">✕</button>
  </div>
  ${ev.description?`<div style="font-size:13px;color:var(--gw-muted);background:var(--gw-surface-3);border-radius:8px;padding:12px;margin-bottom:14px;line-height:1.6">${escapeHtml(ev.description)}</div>`:''}
  ${ev.attendees?.length?`<div style="margin-bottom:14px"><div style="font-size:11px;font-weight:700;color:#5C6B58;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Attendees</div>
    ${ev.attendees.map(a=>`<div style="font-size:12px;color:#6F7E6A;padding:3px 0">${escapeHtml(a.displayName||a.email)} ${a.responseStatus==='accepted'?gwIcon('success',16):a.responseStatus==='declined'?gwIcon('close',16):a.responseStatus==='tentative'?gwIcon('thinking',16):''}</div>`).join('')}</div>`:''}
  <div style="display:flex;gap:8px;flex-wrap:wrap">
    ${ev.htmlLink?`<a href="${escapeHtml(ev.htmlLink)}" target="_blank" rel="noopener" class="secondary-btn" style="font-size:12px">Open in Google Calendar →</a>`:''}
    <button class="secondary-btn" style="font-size:12px" onclick="gwEditEvent('${escapeHtml(ev.id)}')">${gwIcon('pencil',16)} Edit</button>
    <button class="danger-btn" style="font-size:12px" onclick="gwDeleteEvent('${escapeHtml(ev.id)}')">${gwIcon('trash',16)} Delete</button>
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
<div class="gw-modal-card" style="border-radius:16px;padding:24px;width:min(480px,100%);max-height:85vh;overflow-y:auto">
  <div style="display:flex;justify-content:space-between;margin-bottom:18px">
    <h3 style="margin:0">Edit Event</h3>
    <button onclick="document.getElementById('gw-edit-modal').remove()" style="background:none;border:none;color:#6F7E6A;cursor:pointer;font-size:20px">✕</button>
  </div>
  <div style="display:flex;flex-direction:column;gap:12px">
    <div><label style="font-size:11px;font-weight:600;color:#6F7E6A;text-transform:uppercase;letter-spacing:.05em">Title</label>
      <input id="gw-edit-title" class="um-input" type="text" value="${escapeHtml(ev.summary||'')}" style="margin-top:6px"></div>
    <div><label style="font-size:11px;font-weight:600;color:#6F7E6A;text-transform:uppercase;letter-spacing:.05em">${isAllDay?'Date':'Start'}</label>
      <input id="gw-edit-start" class="um-input" type="${isAllDay?'date':'datetime-local'}" value="${startVal}" style="margin-top:6px"></div>
    ${!isAllDay?`<div><label style="font-size:11px;font-weight:600;color:#6F7E6A;text-transform:uppercase;letter-spacing:.05em">End</label>
      <input id="gw-edit-end" class="um-input" type="datetime-local" value="${endVal}" style="margin-top:6px"></div>`:''}
    <div><label style="font-size:11px;font-weight:600;color:#6F7E6A;text-transform:uppercase;letter-spacing:.05em">Location</label>
      <input id="gw-edit-loc" class="um-input" type="text" value="${escapeHtml(ev.location||'')}" style="margin-top:6px"></div>
    <div><label style="font-size:11px;font-weight:600;color:#6F7E6A;text-transform:uppercase;letter-spacing:.05em">Description</label>
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
    showIntToast('Event updated');
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
    style="flex:1;min-width:200px;padding:9px 14px;background:var(--gw-surface-2);border:1px solid var(--gw-line);border-radius:8px;color:var(--gw-ink);font-size:13px"
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
    el.innerHTML = `<div style="color:#C97B6A;padding:20px;font-size:13px">Error: ${escapeHtml(e.message)}</div>`;
  }
}

window.gwSearchDrive = async function() {
  const q = document.getElementById('gw-drive-search')?.value?.trim();
  gwLoadDrive(q);
};

const DRIVE_ICONS = {
  'application/vnd.google-apps.folder':       {icon:gwIcon('folder',16),label:'Folder',color:'#8B6914'},
  'application/vnd.google-apps.document':     {icon:gwIcon('document',16),label:'Doc',color:'#4D8A86'},
  'application/vnd.google-apps.spreadsheet':  {icon:gwIcon('reports',16),label:'Sheet',color:'#2D7A55'},
  'application/vnd.google-apps.presentation': {icon:gwIcon('document',16),label:'Slides',color:'#8B6914'},
  'application/vnd.google-apps.form':         {icon:gwIcon('note',16),label:'Form',color:'#B8744F'},
  'application/pdf':                           {icon:gwIcon('book',16),label:'PDF',color:'#8B3A2A'},
  'image/jpeg':                                {icon: gwIcon('image',16,'#4D8A86'),label:'Image',color:'#B8744F'},
  'image/png':                                 {icon: gwIcon('image',16,'#4D8A86'),label:'Image',color:'#B8744F'},
  'video/mp4':                                 {icon:gwIcon('movie',16),label:'Video',color:'#4D8A86'},
};

function gwRenderDriveList(el, files) {
  if (!files.length) { el.innerHTML = '<div style="text-align:center;padding:40px;color:#5C6B58">No files found.</div>'; return; }
  el.innerHTML = `<div style="display:flex;flex-direction:column;gap:4px">` +
  files.map(f => {
    const mime = f.mimeType || '';
    const info = DRIVE_ICONS[mime] || {icon:gwIcon('attachment',16),label:mime.split('/').pop()?.slice(0,6)||'File',color:'#6F7E6A'};
    const modified = f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}) : '';
    const size = f.size ? (f.size>1048576?(f.size/1048576).toFixed(1)+'MB':f.size>1024?(f.size/1024).toFixed(0)+'KB':f.size+'B') : '';
    return `<div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--gw-surface-2);border:1px solid var(--gw-line);border-radius:8px;transition:background .1s"
      onmouseover="this.style.background='var(--gw-surface-3)'" onmouseout="this.style.background='var(--gw-surface-2)'">
      <span style="font-size:22px;flex-shrink:0">${info.icon}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:#E8E4D9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(f.name)}</div>
        <div style="font-size:11px;color:#5C6B58;margin-top:1px">${info.label}${modified?' · Modified '+modified:''}${size?' · '+size:''}</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        ${f.webViewLink?`<a href="${escapeHtml(f.webViewLink)}" target="_blank" rel="noopener"
          style="padding:5px 12px;background:var(--gw-surface-3);border:1px solid var(--gw-line);border-radius:6px;color:var(--gw-muted);font-size:12px;text-decoration:none;font-weight:600">
          Open →
        </a>`:''}
      </div>
    </div>`;
  }).join('') + '</div>';
}

// Expose for legacy call sites
window.intSearchDrive = window.gwSearchDrive;
// ── Google interactions (legacy compat) ───────────────────────────────────────
function intGoogleDisconnect() { googleDisconnect(); integrations(); }

// ── Compose Email (global modal) ──────────────────────────────────────────────
function intComposeFromTemplateModal(prefillTo = '') {
  window.gwOpenCompose(prefillTo || '', '');
}
function intFillTemplate() {
  const idx = parseInt(document.getElementById('int-tmpl-select')?.value, 10);
  if (isNaN(idx)) return;
  const tmpl = (window.AVALON_DATA?.templates || [])[idx];
  if (!tmpl) return;
  const subj   = document.getElementById('int-email-subject');
  const editor = document.getElementById('int-email-editor');
  if (subj)   subj.value = tmpl.subject || '';
  if (editor) {
    // Templates may be plain text or HTML — normalise to HTML for RTE
    const html = (tmpl.body || '').includes('<') ? tmpl.body : (tmpl.body || '').replace(/\n/g, '<br>');
    editor.innerHTML = html;
  }
}
function intOpenInGmail() {
  _gwChipCommit('to');
  const to      = (window._gwChips?.to || []).join(', ');
  const subject = document.getElementById('int-email-subject')?.value || '';
  const editor  = document.getElementById('int-email-editor');
  const body    = editor ? editor.innerText : '';
  window.open(gmailComposeUrl(to, subject, body), '_blank', 'width=800,height=600');
}
async function intSendEmail() {
  // ── Gather recipients ──────────────────────────────────────────────────────
  // Commit any typed-but-not-chipped addresses first
  _gwChipCommit('to');
  _gwChipCommit('cc');
  _gwChipCommit('bcc');

  const toList  = (window._gwChips?.to  || []);
  const ccList  = (window._gwChips?.cc  || []);
  const bccList = (window._gwChips?.bcc || []);

  if (!toList.length) { showIntToast('Add at least one recipient in the To field', 'warn'); return; }

  const subject = document.getElementById('int-email-subject')?.value?.trim();
  if (!subject)   { showIntToast('Add a subject line', 'warn'); return; }

  const editor = document.getElementById('int-email-editor');
  const bodyHtml = editor ? editor.innerHTML.trim() : '';
  if (!bodyHtml || bodyHtml === '<br>') { showIntToast('Write your message first', 'warn'); return; }

  if (!isGoogleConnected()) { showIntToast('Connect Google first', 'warn'); return; }

  // Build full HTML body: message content + optional signature
  let fullHtml = `<div style="font-family:Arial,sans-serif;font-size:13.5px;line-height:1.6;color:#202124">${bodyHtml}</div>`;
  if (window._intSigActive && window._intSigHtml) {
    fullHtml += `<br><div style="border-top:1px solid #e0e0e0;padding-top:8px;margin-top:8px">${window._intSigHtml}</div>`;
  }

  const btn = document.getElementById('int-send-btn');
  try {
    if (btn) { btn.innerHTML = 'Sending…'; btn.disabled = true; }

    await gmailSendEmail({
      to:      toList.join(', '),
      cc:      ccList.join(', ')  || null,
      bcc:     bccList.join(', ') || null,
      subject,
      body:    fullHtml,
      attachments: window._intAttachments || []
    });

    // ── Log to linked lead (if one was selected) ───────────────────────────
    const linkedOppId    = window._gwComposeLinkedOppId    || '';
    const linkedOppLabel = window._gwComposeLinkedOppLabel || '';
    if (linkedOppId) {
      try {
        const repName = (window.getCurrentRep ? window.getCurrentRep() : null)?.name || 'Rep';
        const repId   = (window.getCurrentRep ? window.getCurrentRep() : null)?.id   || null;

        // 1. Write to D1 via the comms API endpoint
        const commPayload = {
          type:      'email',
          direction: 'out',
          subject:   subject,
          body:      bodyHtml.slice(0, 4000),   // truncate for DB storage
          repId:     repId
        };
        try {
          await fetch('/api/opportunities/' + encodeURIComponent(linkedOppId) + '/comms', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(commPayload)
          });
        } catch(dbErr) {
          console.warn('[gwCompose] D1 comms write failed:', dbErr);
        }

        // 2. Push to local state.communications so the comms tab updates immediately
        const localComm = {
          id:        'comm_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
          oppId:     linkedOppId,
          type:      'email',
          direction: 'out',
          subject:   subject,
          body:      bodyHtml.slice(0, 2000),
          callDuration: null,
          files:     [],
          ts:        new Date().toISOString(),
          sentBy:    repName,
          gmailSent: true,
          linkedViaCompose: true   // flag so we can distinguish compose-modal sends
        };
        const st = window._avalonState || window.state;
        if (st) {
          if (!st.communications) st.communications = [];
          st.communications.push(localComm);
          // Persist to localStorage if saveState is available
          if (typeof saveState === 'function') try { saveState(); } catch(_) {}
        }

        showIntToast('Email sent & linked to "' + linkedOppLabel + '" ✓', 'success');
      } catch(linkErr) {
        console.warn('[gwCompose] Lead link failed:', linkErr);
        showIntToast('Email sent ✓ (lead link failed)', 'warn');
      }
    } else {
      showIntToast('Email sent ✓', 'success');
    }

    document.getElementById('int-compose-modal').style.display = 'none';
    if (_gwTab === 'gmail') gwLoadGmail();
  } catch(e) {
    showIntToast(e.message || 'Send failed', 'error');
    if (btn) { btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 10L17 3l-4 14-3-7-7-3z"/></svg> Send'; btn.disabled = false; }
  }
}

// ── Calendar event create modal ───────────────────────────────────────────────
function intCreateCalendarEvent(prefill = {}) {
  const modal = document.getElementById('int-cal-modal');
  if (!modal) { showIntToast('Calendar unavailable — reload the Integrations page', 'warn'); return; }
  // Reset fields
  const todayStr = new Date().toISOString().slice(0,10);
  const titleEl    = document.getElementById('int-cal-title');
  const dateEl     = document.getElementById('int-cal-date');
  const timeEl     = document.getElementById('int-cal-time');
  const durEl      = document.getElementById('int-cal-duration');
  const attendeeEl = document.getElementById('int-cal-attendee');
  const notesEl    = document.getElementById('int-cal-notes');
  if (titleEl)    titleEl.value    = prefill.title    || '';
  if (dateEl)     dateEl.value     = prefill.date     || todayStr;
  if (timeEl)     timeEl.value     = prefill.time     || '09:00';
  if (durEl)      durEl.value      = prefill.duration || '1';
  if (attendeeEl) attendeeEl.value = prefill.attendee || '';
  if (notesEl)    notesEl.value    = prefill.notes    || '';
  modal.style.display = 'flex';
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
    showIntToast('Event created');
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

// Connect handler for the "Sign in with Google" button on the connect screen.
// Delegates to _umMyConnect (the module-level OAuth launcher set by user_management.js)
// with a fallback to the local googleOAuthConnect helper.
async function intSaveClientIdAndConnect() {
  if (typeof window._umMyConnect === 'function') {
    await window._umMyConnect();
    // Give the OAuth popup time to resolve then re-render the hub
    setTimeout(() => integrations(), 1200);
  } else {
    // Fallback: call the local OAuth connect and re-render on success
    const ok = await googleOAuthConnect();
    if (ok) integrations();
  }
}

// ── intAdminSaveClientId — saves Google OAuth Client ID from Integrations page ──
function intAdminSaveClientId() {
  const val = document.getElementById('int-admin-client-id')?.value?.trim();
  if (!val) { showIntToast('Paste a valid Google Client ID first', 'warn'); return; }
  let st = {};
  try { st = JSON.parse(localStorage.getItem('avalonIntegrationsV1') || '{}'); } catch(e) {}
  st.googleClientId = val;
  localStorage.setItem('avalonIntegrationsV1', JSON.stringify(st));
  // Mirror to server settings so all devices/users share it
  try { fetch('/api/settings', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ key:'google_client_id', value: val }) }); } catch(e){}
  showIntToast('Google Client ID saved ✓', 'success');
  // Re-render so the connect button becomes active
  setTimeout(() => integrations(), 400);
}
window.intAdminSaveClientId = intAdminSaveClientId;

// ── intAdminSaveGoogleCreds — save Client ID + Secret to server settings ──────
// The secret enables the authorization-code flow → PERSISTENT connections.
async function intAdminSaveGoogleCreds() {
  const id = document.getElementById('int-admin-client-id')?.value?.trim();
  const secret = document.getElementById('int-admin-client-secret')?.value?.trim();
  if (!id) { showIntToast('Paste your Google Client ID first', 'warn'); return; }
  // Local mirror of client ID (public value)
  let st = {};
  try { st = JSON.parse(localStorage.getItem('avalonIntegrationsV1') || '{}'); } catch(e) {}
  st.googleClientId = id;
  localStorage.setItem('avalonIntegrationsV1', JSON.stringify(st));
  try {
    const r = await fetch('/api/settings', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ key:'google_client_id', value: id }) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (secret) {
      const r2 = await fetch('/api/settings', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ key:'google_client_secret', value: secret }) });
      if (!r2.ok) throw new Error('HTTP ' + r2.status);
    }
    const statusEl = document.getElementById('int-admin-creds-status');
    if (statusEl) statusEl.textContent = secret ? '✓ Saved — stay-signed-in enabled' : '✓ Client ID saved (add the Secret to enable stay-signed-in)';
    showIntToast(secret ? 'Google credentials saved — connections are now permanent' : 'Client ID saved', 'success');
  } catch(e){
    showIntToast('Save failed: ' + (e.message||'error'), 'warn');
  }
}
window.intAdminSaveGoogleCreds = intAdminSaveGoogleCreds;

// ── intAdminSaveAiKey — save OpenAI API key for ✨ AI proposal drafting ────────
async function intAdminSaveAiKey() {
  const key = document.getElementById('int-admin-ai-key')?.value?.trim();
  if (!key) { showIntToast('Paste your AI API key first', 'warn'); return; }
  try {
    const r = await fetch('/api/settings', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ key:'openai_api_key', value: key }) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const el = document.getElementById('int-admin-ai-status');
    if (el) el.textContent = '✓ Saved — AI proposal drafting is now enabled for your team';
    const input = document.getElementById('int-admin-ai-key');
    if (input) input.value = '';
    showIntToast('AI API key saved — "Draft with AI" is live in the proposal builder', 'success');
  } catch(e){
    showIntToast('Save failed: ' + (e.message||'error'), 'warn');
  }
}
window.intAdminSaveAiKey = intAdminSaveAiKey;

// ── Pull the shared Client ID from server settings if this browser lacks it ──
setTimeout(async () => {
  try {
    if (getGoogleClientId()) return;
    // Resolves company setting → legacy setting → platform default env secret,
    // and caches into localStorage so every sync call-site sees it.
    const cid = await gwResolveGoogleClientId();
    if (cid) console.log('[Integrations] Google Client ID resolved from server');
  } catch(e){}
}, 2000);

// ── intComposeToLead — called from Quick Actions "Compose Email" on a lead ─────
// Pre-fills the Gmail compose modal with the lead's email address AND links the
// email internally to that lead's Communications tab.
function intComposeToLead(toEmail, clientName, oppId, oppLabel) {
  if (isGoogleConnected()) {
    // Open the compose modal (works from any view — gwEnsureComposeModal handles DOM injection)
    gwEnsureComposeModal();
    if (typeof gwOpenCompose === 'function') {
      gwOpenCompose(toEmail || '', '', oppId || '', oppLabel || clientName || '');
    }
  } else {
    // Not connected — open mailto: as fallback
    const url = 'mailto:' + encodeURIComponent(toEmail || '') + (clientName ? '?body=Hi ' + encodeURIComponent(clientName) + ',' : '');
    window.open(url, '_blank');
  }
}
window.intComposeToLead = intComposeToLead;

// ══════════════════════════════════════════════════════════════════════════════
// LEAD SCHEDULER — schedule client meetings + send booking-page links, tied to a lead
// Opened by the Schedule quick-action on the lead page and the Meetings rail.
// ══════════════════════════════════════════════════════════════════════════════

function _gwGetMyBookingPages() {
  // Rep's Google Calendar booking-page links — stored per user in localStorage
  // and mirrored to server settings (key bookings_<repId>) for cross-device use.
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  if (!rep) return [];
  try {
    const map = JSON.parse(localStorage.getItem('gwBookingPagesV1') || '{}');
    return map[rep.id] || [];
  } catch(e){ return []; }
}

function _gwSaveMyBookingPages(list) {
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  if (!rep) return;
  try {
    const map = JSON.parse(localStorage.getItem('gwBookingPagesV1') || '{}');
    map[rep.id] = list;
    localStorage.setItem('gwBookingPagesV1', JSON.stringify(map));
  } catch(e){}
  try { fetch('/api/settings', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ key:'bookings_'+rep.id, value: JSON.stringify(list) }) }); } catch(e){}
}

// Sync booking pages from server on load (cross-device)
setTimeout(async () => {
  try {
    const rep = window.getCurrentRep ? window.getCurrentRep() : null;
    if (!rep || _gwGetMyBookingPages().length) return;
    const r = await fetch('/api/settings'); if (!r.ok) return;
    const j = await r.json();
    const raw = j.data ? j.data['bookings_'+rep.id] : null;
    if (raw) { try { _gwSaveMyBookingPages(JSON.parse(raw)); } catch(e){} }
  } catch(e){}
}, 3000);

function intScheduleForLead(oppId) {
  const opps = (window._avalonState?.opportunities) || (typeof state!=="undefined" && state.opportunities) || [];
  const opp = opps.find(o => o.id === oppId);
  if (!opp) { showIntToast('Lead not found', 'warn'); return; }
  // Remove any prior instance
  document.getElementById('gw-lead-sched-modal')?.remove();
  const googleOk = isGoogleConnected();
  const pages = _gwGetMyBookingPages();
  const esc = s => (window.escapeHtml ? escapeHtml(String(s||'')) : String(s||''));
  const today = new Date().toISOString().slice(0,10);

  const wrap = document.createElement('div');
  wrap.id = 'gw-lead-sched-modal';
  wrap.style.cssText = 'position:fixed;inset:0;background:#000000A0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
  wrap.innerHTML = `
  <div class="gw-modal-card" style="border-radius:16px;padding:26px;width:100%;max-width:560px;max-height:90vh;overflow-y:auto;box-shadow:0 24px 64px #000a">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
      <h3 style="margin:0;font-size:17px;font-weight:800;color:var(--gds-ink,#1F2A2B)">Schedule with ${esc(opp.client||'Lead')}</h3>
      <button onclick="document.getElementById('gw-lead-sched-modal').remove()" style="background:none;border:none;font-size:22px;cursor:pointer;color:var(--gds-muted,#5E6E6F);line-height:1">×</button>
    </div>
    <div style="font-size:12px;color:var(--gds-muted,#5E6E6F);margin-bottom:16px">${esc(opp.email||'no email')} ${opp.phone?'· '+esc(opp.phone):''}</div>

    ${!googleOk ? `<div style="padding:10px 14px;background:rgba(139,105,20,.08);border:1px solid rgba(139,105,20,.3);border-radius:8px;font-size:12.5px;color:#8B6914;margin-bottom:14px">Google not connected — meetings will save to this lead but won't appear on your Google Calendar. <button onclick="document.getElementById('gw-lead-sched-modal').remove();show('integrations')" style="background:none;border:none;color:#8B6914;font-weight:800;cursor:pointer;text-decoration:underline;padding:0">Connect →</button></div>` : ''}

    <!-- Create a meeting -->
    <div style="font-size:11px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:var(--gds-teal,#4D8A86);margin-bottom:10px">Create Client Meeting</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
      <label style="font-size:11px;font-weight:700;color:var(--gds-muted,#5E6E6F);display:block">TYPE
        <select id="gw-ls-type" style="width:100%;margin-top:4px;padding:9px 10px;border:1px solid var(--gds-line-2,#CCC9C0);border-radius:8px;font-size:13px;background:var(--gds-surface,#fff);color:var(--gds-ink,#1F2A2B)">
          <option value="In-Person Meeting">In-person meeting</option>
          <option value="Phone Call">Phone call</option>
          <option value="Site Walk">Site walk</option>
          <option value="Video Call">Video call</option>
        </select>
      </label>
      <label style="font-size:11px;font-weight:700;color:var(--gds-muted,#5E6E6F);display:block">DURATION
        <select id="gw-ls-dur" style="width:100%;margin-top:4px;padding:9px 10px;border:1px solid var(--gds-line-2,#CCC9C0);border-radius:8px;font-size:13px;background:var(--gds-surface,#fff);color:var(--gds-ink,#1F2A2B)">
          <option value="0.5">30 minutes</option>
          <option value="1" selected>1 hour</option>
          <option value="1.5">1.5 hours</option>
          <option value="2">2 hours</option>
        </select>
      </label>
      <label style="font-size:11px;font-weight:700;color:var(--gds-muted,#5E6E6F);display:block">DATE
        <input id="gw-ls-date" type="date" value="${today}" style="width:100%;margin-top:4px;padding:9px 10px;border:1px solid var(--gds-line-2,#CCC9C0);border-radius:8px;font-size:13px;background:var(--gds-surface,#fff);color:var(--gds-ink,#1F2A2B);box-sizing:border-box">
      </label>
      <label style="font-size:11px;font-weight:700;color:var(--gds-muted,#5E6E6F);display:block">TIME
        <input id="gw-ls-time" type="time" value="09:00" style="width:100%;margin-top:4px;padding:9px 10px;border:1px solid var(--gds-line-2,#CCC9C0);border-radius:8px;font-size:13px;background:var(--gds-surface,#fff);color:var(--gds-ink,#1F2A2B);box-sizing:border-box">
      </label>
    </div>
    <label style="font-size:11px;font-weight:700;color:var(--gds-muted,#5E6E6F);display:block;margin-bottom:10px">NOTES (added to the calendar event)
      <textarea id="gw-ls-notes" rows="2" placeholder="Agenda, address, what to bring…" style="width:100%;margin-top:4px;padding:9px 10px;border:1px solid var(--gds-line-2,#CCC9C0);border-radius:8px;font-size:13px;background:var(--gds-surface,#fff);color:var(--gds-ink,#1F2A2B);box-sizing:border-box;resize:vertical;font-family:inherit"></textarea>
    </label>
    <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--gds-ink,#1F2A2B);margin-bottom:12px;cursor:pointer">
      <input id="gw-ls-invite" type="checkbox" ${opp.email?'checked':'disabled'}>
      Invite ${esc(opp.client||'client')} (${opp.email?esc(opp.email):'no email on lead'}) — Google sends them the invitation
    </label>
    <button class="primary-btn" style="width:100%;justify-content:center;padding:11px" onclick="intSubmitLeadMeeting('${oppId}')">
      ${googleOk ? 'Create Meeting on Google Calendar' : 'Save Meeting to Lead'}
    </button>

    <!-- Booking pages -->
    <div style="border-top:1px solid var(--gds-line,#E0DDD5);margin:20px 0 14px"></div>
    <div style="font-size:11px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:var(--gds-teal,#4D8A86);margin-bottom:8px">Send a Booking Page Link</div>
    <p style="font-size:12px;color:var(--gds-muted,#5E6E6F);line-height:1.6;margin:0 0 10px">Let ${esc(opp.client||'the client')} pick their own time from your Google Calendar booking page. Sending logs it to this lead's communications.</p>
    <div id="gw-ls-pages">
      ${pages.length ? pages.map((p,i)=>`
      <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--gds-line,#E0DDD5);border-radius:8px;margin-bottom:6px">
        <span style="font-size:12.5px;font-weight:700;color:var(--gds-ink,#1F2A2B);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</span>
        <button class="secondary-btn" style="font-size:11px;padding:5px 10px;flex-shrink:0" onclick="intCopyBookingLink('${oppId}',${i})">Copy</button>
        ${opp.email?`<button class="primary-btn" style="font-size:11px;padding:5px 10px;flex-shrink:0" onclick="intEmailBookingLink('${oppId}',${i})">Email to client</button>`:''}
        <button title="Remove" style="background:none;border:none;color:#C97B6A;cursor:pointer;font-size:15px;padding:0 2px;flex-shrink:0" onclick="intRemoveBookingPage('${oppId}',${i})">×</button>
      </div>`).join('') : '<div style="font-size:12px;color:var(--gds-muted,#5E6E6F);padding:6px 0 2px">No booking pages saved yet — add the one you send clients regularly:</div>'}
    </div>
    <div style="display:flex;gap:8px;margin-top:8px">
      <input id="gw-ls-page-name" type="text" placeholder="Name (e.g. 30-min consult)" style="flex:0 0 38%;padding:8px 10px;border:1px solid var(--gds-line-2,#CCC9C0);border-radius:8px;font-size:12px;background:var(--gds-surface,#fff);color:var(--gds-ink,#1F2A2B);box-sizing:border-box">
      <input id="gw-ls-page-url" type="url" placeholder="https://calendar.app.google/…" style="flex:1;padding:8px 10px;border:1px solid var(--gds-line-2,#CCC9C0);border-radius:8px;font-size:12px;background:var(--gds-surface,#fff);color:var(--gds-ink,#1F2A2B);box-sizing:border-box">
      <button class="secondary-btn" style="font-size:12px;padding:8px 12px;flex-shrink:0" onclick="intAddBookingPage('${oppId}')">Add</button>
    </div>
    <div style="font-size:11px;color:var(--gds-muted,#5E6E6F);margin-top:6px">Create booking pages at <a href="https://calendar.google.com/calendar/u/0/r/appointment" target="_blank" style="color:var(--gds-teal,#4D8A86)">Google Calendar → Appointment schedules</a>, then paste the share link here.</div>
  </div>`;
  document.body.appendChild(wrap);
  wrap.addEventListener('click', e => { if (e.target === wrap) wrap.remove(); });
}

async function intSubmitLeadMeeting(oppId) {
  const opps = (window._avalonState?.opportunities) || (typeof state!=="undefined" && state.opportunities) || [];
  const opp = opps.find(o => o.id === oppId);
  if (!opp) return;
  const type  = document.getElementById('gw-ls-type')?.value || 'In-Person Meeting';
  const date  = document.getElementById('gw-ls-date')?.value;
  const time  = document.getElementById('gw-ls-time')?.value || '09:00';
  const dur   = parseFloat(document.getElementById('gw-ls-dur')?.value || '1');
  const notes = document.getElementById('gw-ls-notes')?.value?.trim() || '';
  const invite = document.getElementById('gw-ls-invite')?.checked && opp.email;
  if (!date) { showIntToast('Pick a date', 'warn'); return; }
  const summary = `${type} — ${opp.client||'Lead'}`;
  const description = [notes, opp.address ? 'Property: '+opp.address : '', 'Groundwork lead: '+(opp.client||'')+' ['+oppId+']'].filter(Boolean).join('\n');
  let calOk = false;
  try {
    if (isGoogleConnected()) {
      await calCreateEvent({ summary, description, startDate: date, startTime: time, durationHours: dur, attendees: invite ? [opp.email] : [] });
      calOk = true;
    }
  } catch(e){ showIntToast('Calendar error: ' + (e.message||''), 'warn'); }
  // Track the meeting on the lead itself (renders in the Dates rail)
  try {
    opp.meetings = opp.meetings || [];
    opp.meetings.push({ id: 'mtg_'+Date.now(), type, date, time, durationHours: dur, notes, invited: !!invite, calSynced: calOk, createdAt: new Date().toISOString() });
    opp.updatedAt = new Date().toISOString();
    if (typeof window.saveState === 'function') window.saveState();
  } catch(e){}
  showIntToast(calOk ? 'Meeting created on Google Calendar' + (invite ? ' — invitation sent' : '') : 'Meeting saved to lead');
  document.getElementById('gw-lead-sched-modal')?.remove();
  // Refresh the lead page so the Meetings list updates
  if (typeof window.show === 'function') { window.show('pipeline', oppId); }
}

function intAddBookingPage(oppId) {
  const name = document.getElementById('gw-ls-page-name')?.value?.trim();
  const url  = document.getElementById('gw-ls-page-url')?.value?.trim();
  if (!name || !url) { showIntToast('Enter a name and the booking link', 'warn'); return; }
  if (!/^https?:\/\//i.test(url)) { showIntToast('Booking link must start with https://', 'warn'); return; }
  const pages = _gwGetMyBookingPages();
  pages.push({ name, url });
  _gwSaveMyBookingPages(pages);
  intScheduleForLead(oppId); // re-render modal
}

function intRemoveBookingPage(oppId, idx) {
  const pages = _gwGetMyBookingPages();
  pages.splice(idx, 1);
  _gwSaveMyBookingPages(pages);
  intScheduleForLead(oppId);
}

function intCopyBookingLink(oppId, idx) {
  const p = _gwGetMyBookingPages()[idx];
  if (!p) return;
  navigator.clipboard.writeText(p.url).then(()=>showIntToast('Booking link copied'), ()=>showIntToast('Copy failed','warn'));
  _gwLogBookingSend(oppId, p, 'copied');
}

async function intEmailBookingLink(oppId, idx) {
  const p = _gwGetMyBookingPages()[idx];
  const opps = (window._avalonState?.opportunities) || (typeof state!=="undefined" && state.opportunities) || [];
  const opp = opps.find(o => o.id === oppId);
  if (!p || !opp || !opp.email) return;
  const rep = window.getCurrentRep ? window.getCurrentRep() : null;
  const subject = 'Pick a time that works for you — ' + (rep?.name || 'Groundwork');
  const body = 'Hi ' + ((opp.client||'').split(' ')[0] || 'there') + ',<br><br>' +
    'You can grab a time on my calendar that works best for you here:<br>' +
    '<a href="' + p.url + '">' + p.url + '</a><br><br>' +
    'Looking forward to it!<br>' + (rep?.name || '');
  if (isGoogleConnected()) {
    try {
      await gmailSendEmail({ to: opp.email, subject, body });
      showIntToast('Booking link emailed to ' + opp.email);
      _gwLogBookingSend(oppId, p, 'emailed');
      return;
    } catch(e){ showIntToast('Gmail error: '+(e.message||'')+' — opening mail client instead','warn'); }
  }
  window.open('mailto:' + opp.email + '?subject=' + encodeURIComponent(subject.replace(/<[^>]*>/g,'')) + '&body=' + encodeURIComponent('Pick a time here: ' + p.url));
  _gwLogBookingSend(oppId, p, 'emailed');
}

function _gwLogBookingSend(oppId, page, how) {
  // Tie every booking-page send to the lead's communications
  try {
    const st = window._avalonState || (typeof state!=="undefined" ? state : null); if (!st) return;
    if (!st.communications) st.communications = [];
    st.communications.push({
      id: 'comm_'+Date.now()+'_'+Math.random().toString(16).slice(2,6),
      oppId, type: 'email', direction: 'out',
      subject: 'Booking page link ' + how,
      body: 'Booking page "' + page.name + '" ' + how + ': ' + page.url,
      ts: new Date().toISOString(),
      sentBy: (window.getCurrentRep ? window.getCurrentRep() : null)?.name || 'Rep',
      gmailSent: how === 'emailed' && typeof isGoogleConnected==='function' && isGoogleConnected(),
      files: []
    });
    if (typeof window.saveState === 'function') window.saveState();
  } catch(e){}
}

window.intScheduleForLead   = intScheduleForLead;
window.intSubmitLeadMeeting = intSubmitLeadMeeting;
window.intAddBookingPage    = intAddBookingPage;
window.intRemoveBookingPage = intRemoveBookingPage;
window.intCopyBookingLink   = intCopyBookingLink;
window.intEmailBookingLink  = intEmailBookingLink;

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
window.intSearchDrive = intSearchDrive;
window.intLoadGmail = intLoadGmail;
window.intLoadCalendar = intLoadCalendar;
window.intLoadDrive = intLoadDrive;
