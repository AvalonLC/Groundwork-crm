/**
 * Groundwork CRM — Service Worker
 * sw.js v20260711p49
 *
 * Strategy:
 *  - Static assets (JS/CSS/fonts): Cache-first with versioned cache
 *  - API routes (/api/*): Network-first; serve stale on failure
 *  - HTML pages: Network-first; serve cached shell on offline
 *  - Images: Cache-first (long TTL)
 */

const CACHE_VERSION = 'gw-p49';
const STATIC_CACHE  = `${CACHE_VERSION}-static`;
const API_CACHE     = `${CACHE_VERSION}-api`;
const IMG_CACHE     = `${CACHE_VERSION}-img`;

// Core shell files — cached on install
const PRECACHE_URLS = [
  '/',
  '/static/premium.css',
  '/static/gw-icons.js',
  '/static/app_premium.js',
  '/static/estimates.js',
  '/static/invoices.js',
  '/static/recurring_plans.js',
  '/static/reviews.js',
];

// ── Install ────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => {
        // Precache with individual error handling — don't fail install on one miss
        return Promise.allSettled(
          PRECACHE_URLS.map(url =>
            cache.add(url).catch(err => console.warn('[SW] Precache miss:', url, err.message))
          )
        );
      })
      .then(() => self.skipWaiting())
  );
});

// ── Activate ───────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('gw-') && !k.startsWith(CACHE_VERSION))
          .map(k => {
            console.log('[SW] Deleting old cache:', k);
            return caches.delete(k);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch ──────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GET requests
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // ── API routes: network-first ────────────────────────────────────────────
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirstApi(request));
    return;
  }

  // ── Static assets (JS/CSS/fonts): cache-first ───────────────────────────
  if (
    url.pathname.startsWith('/static/') ||
    url.pathname.match(/\.(js|css|woff2?|ttf|otf)(\?.*)?$/)
  ) {
    event.respondWith(cacheFirstStatic(request));
    return;
  }

  // ── Images: cache-first with long TTL ───────────────────────────────────
  if (url.pathname.match(/\.(png|jpg|jpeg|webp|gif|svg|ico)(\?.*)?$/)) {
    event.respondWith(cacheFirstImage(request));
    return;
  }

  // ── HTML / navigation: network-first with offline shell ─────────────────
  if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(networkFirstHTML(request));
    return;
  }
});

// ── Strategy implementations ───────────────────────────────────────────────

async function networkFirstApi(request) {
  const cache = await caches.open(API_CACHE);
  try {
    const response = await fetch(request);
    // Only cache successful, non-401 responses
    if (response.ok) {
      const clone = response.clone();
      cache.put(request, clone).catch(() => {});
    }
    return response;
  } catch (err) {
    // Offline: try stale API cache
    const cached = await cache.match(request);
    if (cached) {
      console.log('[SW] Serving stale API:', request.url);
      return cached;
    }
    // Nothing cached — return offline JSON
    return new Response(
      JSON.stringify({ ok: false, error: 'Offline — no cached data available', offline: true }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

async function cacheFirstStatic(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone()).catch(() => {});
    return response;
  } catch (err) {
    return new Response('Resource unavailable offline', { status: 503 });
  }
}

async function cacheFirstImage(request) {
  const cache = await caches.open(IMG_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone()).catch(() => {});
    return response;
  } catch (err) {
    return new Response('', { status: 503 });
  }
}

async function networkFirstHTML(request) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone()).catch(() => {});
    return response;
  } catch (err) {
    // Try cached page first
    const cached = await cache.match(request);
    if (cached) return cached;
    // Fall back to cached root shell
    const shell = await cache.match('/');
    if (shell) return shell;
    return new Response(
      '<!DOCTYPE html><html><head><title>Groundwork CRM — Offline</title><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
      '<body style="font-family:system-ui;text-align:center;padding:60px 20px;color:#374151">' +
      '<h1 style="color:#2D7A55">Groundwork CRM</h1>' +
      '<p>You\'re offline. Please check your connection and try again.</p>' +
      '<button onclick="location.reload()" style="background:#2D7A55;color:#fff;border:none;border-radius:8px;padding:10px 24px;font-size:15px;cursor:pointer">Retry</button>' +
      '</body></html>',
      { status: 200, headers: { 'Content-Type': 'text/html' } }
    );
  }
}

// ── Push notifications (future) ────────────────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  let payload = { title: 'Groundwork CRM', body: 'New notification', icon: '/static/icon-192.png' };
  try { payload = { ...payload, ...event.data.json() }; } catch (_) {}
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: payload.icon || '/static/icon-192.png',
      badge: '/static/icon-192.png',
      tag: payload.tag || 'gw-notification',
      data: payload.data || {},
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      const existing = windowClients.find(c => c.url.startsWith(self.location.origin));
      if (existing) return existing.focus().then(w => w.navigate(url));
      return clients.openWindow(url);
    })
  );
});

console.log('[Groundwork SW] v20260711p49 installed');
