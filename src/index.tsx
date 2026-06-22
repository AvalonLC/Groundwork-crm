import { Hono } from 'hono'
import { serveStatic } from 'hono/cloudflare-workers'

const app = new Hono()

// Serve static files
app.use('/static/*', serveStatic({ root: './public' }))
app.use('/sw.js', serveStatic({ root: './public', path: 'sw.js' }))

// Google OAuth2 callback page — receives access token from Google's implicit flow,
// posts it back to the opener window, then closes itself.
app.get('/auth/google/callback', (c) => {
  return c.html(`<!DOCTYPE html>
<html>
<head>
  <title>Connecting to Google…</title>
  <style>
    body { font-family: Inter, sans-serif; background: #0f172a; color: #e2e8f0;
           display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; flex-direction: column; gap: 16px; }
    .spinner { width: 40px; height: 40px; border: 3px solid #334155; border-top-color: #00A7E1; border-radius: 50%; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    p { color: #94a3b8; font-size: 14px; margin: 0; }
  </style>
</head>
<body>
  <div class="spinner"></div>
  <p>Connecting to Google — you can close this window if it doesn't close automatically.</p>
  <script>
    // The access token arrives in the URL hash via Google's implicit flow.
    // The opener (integrations.js) polls this page's location.hash to read it.
    // Nothing needs to happen here — just stay open so the polling can read the hash.
    
    // Auto-close after 5 seconds as a fallback
    if (window.opener) {
      // Let the opener read our hash, then close
      setTimeout(() => window.close(), 5000);
    }
  </script>
</body>
</html>`)
})

// Main app - serve the Avalon Sales Hub
app.get('/', (c) => {
  return c.html(getHtml())
})

function getHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Avalon Sales Hub</title>
  <link rel="icon" type="image/png" href="/static/avalon-logo.png" />
  <meta name="theme-color" content="#00A7E1" />
  <meta name="description" content="Avalon Landscape Construction internal sales operating hub." />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/static/premium.css">
</head>
<body>
<div class="app-shell">
  <aside class="sidebar" id="sidebar">
    <div class="brand">
      <div class="brand-mark">
        <img src="/static/avalon-logo.png" alt="Avalon logo" style="width:42px;height:42px;object-fit:contain;">
      </div>
      <div>
        <div class="brand-name">Avalon</div>
        <div class="brand-subtitle">Landscape Construction</div>
        <div class="brand-kicker">Sales Hub</div>
      </div>
    </div>
    <nav class="nav" id="mainNav" role="navigation">

      <details class="nav-group" open>
        <summary class="nav-summary">🏠 Home</summary>
        <div class="nav-items">
          <button class="nav-item active" data-view="today" onclick="show('today')">Today</button>
          <button class="nav-item" data-view="myDashboard" onclick="show('myDashboard')">My Dashboard</button>
        </div>
      </details>

      <details class="nav-group" open>
        <summary class="nav-summary">📊 Pipeline</summary>
        <div class="nav-items">
          <button class="nav-item" data-view="pipeline" onclick="show('pipeline')">Pipeline</button>
          <button class="nav-item" data-view="lead" onclick="show('lead')">Add Lead</button>
        </div>
      </details>

      <details class="nav-group">
        <summary class="nav-summary">🛠️ Sales Toolkit</summary>
        <div class="nav-items">
          <button class="nav-item" data-view="process" onclick="show('process')">Sales Process</button>
          <button class="nav-item" data-view="forms" onclick="show('forms')">Forms &amp; Checklists</button>
          <button class="nav-item" data-view="scripts" onclick="show('scripts')">Scripts</button>
          <button class="nav-item" data-view="templates" onclick="show('templates')">Email Templates</button>
          <button class="nav-item" data-view="objections" onclick="show('objections')">Objection Handling</button>
          <button class="nav-item" data-view="calculator" onclick="show('calculator')">Pricing Tools</button>
        </div>
      </details>

      <details class="nav-group">
        <summary class="nav-summary">🎓 Learning</summary>
        <div class="nav-items">
          <button class="nav-item" data-view="academy" onclick="show('academy')">Sales Academy</button>
        </div>
      </details>

      <details class="nav-group">
        <summary class="nav-summary">⚙️ Admin</summary>
        <div class="nav-items">
          <button class="nav-item" data-view="manager" onclick="show('manager')">Manager Tools</button>
          <button class="nav-item" data-view="integrations" onclick="show('integrations')">Integrations</button>
          <button class="nav-item" data-view="settings" onclick="show('settings')">Settings</button>
        </div>
      </details>

    </nav>
    <div class="sidebar-footer">
      <strong>Avalon Sales OS</strong><br>
      Consultative. Profitable.<br>Operationally clean. Easy to trust.
    </div>
  </aside>
  <main class="main" role="main">
    <header class="topbar">
      <button class="menu-btn" id="menuBtn" onclick="document.getElementById('sidebar').classList.toggle('open')" aria-label="Toggle menu">☰</button>
      <div class="search-wrap">
        <input id="searchInput" type="search" placeholder="Search scripts, forms, stages, templates..." autocomplete="off" aria-label="Search">
        <div id="searchResults" class="search-results" hidden></div>
      </div>
      <button class="install-btn" id="installBtn" hidden>Install App</button>
    </header>
    <div class="view" id="view" role="region" aria-live="polite"></div>
  </main>
</div>
<div id="toast" class="toast" hidden role="alert" aria-live="assertive"></div>

<script src="/static/data.js"></script>
<script src="/static/reps.js"></script>
<script src="/static/app_premium.js"></script>
<script src="/static/integrations.js"></script>
<script>
  // Service Worker registration
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  
  // PWA install prompt
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    window.deferredPrompt = e;
    const btn = document.getElementById('installBtn');
    if (btn) {
      btn.hidden = false;
      btn.onclick = () => { e.prompt(); btn.hidden = true; };
    }
  });

  // Expose state to integrations module
  window._avalonState = state;

  // Auth gate — show login screen if no rep is logged in
  (function() {
    if (!window.getCurrentRep || !window.getCurrentRep()) {
      // Small delay to let all scripts initialize
      setTimeout(() => {
        if (!window.getCurrentRep()) {
          window.renderLoginScreen();
        }
      }, 100);
    }
  })();
</script>
</body>
</html>`
}

export default app
