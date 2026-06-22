import { Hono } from 'hono'
import { serveStatic } from 'hono/cloudflare-workers'

const app = new Hono()

// Serve static files
app.use('/static/*', serveStatic({ root: './public' }))
app.use('/sw.js', serveStatic({ root: './public', path: 'sw.js' }))

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
    <nav class="nav" role="navigation">
      <button class="nav-item active" data-view="today" onclick="show('today')">🏠 Today</button>
      <button class="nav-item" data-view="pipeline" onclick="show('pipeline')">📊 Pipeline</button>
      <button class="nav-item" data-view="lead" onclick="show('lead')">➕ Add Lead</button>
      <button class="nav-item" data-view="process" onclick="show('process')">📋 Sales Process</button>
      <button class="nav-item" data-view="forms" onclick="show('forms')">📝 Forms & Checklists</button>
      <button class="nav-item" data-view="scripts" onclick="show('scripts')">💬 Scripts</button>
      <button class="nav-item" data-view="templates" onclick="show('templates')">📧 Email Templates</button>
      <button class="nav-item" data-view="objections" onclick="show('objections')">🛡️ Objection Handling</button>
      <button class="nav-item" data-view="calculator" onclick="show('calculator')">🧮 Pricing Tools</button>
      <button class="nav-item" data-view="academy" onclick="show('academy')">🎓 Sales Academy</button>
      <button class="nav-item" data-view="manager" onclick="show('manager')">👔 Manager Tools</button>
      <button class="nav-item" data-view="settings" onclick="show('settings')">⚙️ Settings</button>
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
<script src="/static/app_premium.js"></script>
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
</script>
</body>
</html>`
}

export default app
