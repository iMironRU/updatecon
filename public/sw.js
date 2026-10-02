/**
 * sw.js — Апдейкон as an installable app.
 *
 * Network first, cache as the fallback: online everything is as fresh as
 * without a service worker; offline the app opens and shows the data from
 * the last visit (responses then carry X-Updatecon-Offline: 1 and the page
 * says so). Only the public site is touched — the admin panel (any address),
 * downloads and everything else go straight to the network.
 */
const CACHE = 'updatecon-v1';
const SHELL = '/';                                   // every app page is the same index.html
const APP_PAGE = /^\/(catalog|news|stats|platform|settings|chain|config\/[^/]+)?\/?$/;
const API = /^\/api\/(configs|versions|patches|chain|transitions|tags|site|news|platform|platform-check|stats|stats\/more|stats\/releases)$/;
const STATIC = /^\/(favicon\.svg|manifest\.webmanifest|icons\/.+)$/;
const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([SHELL, '/manifest.webmanifest', '/favicon.svg', '/icons/icon-192.png'])));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function timeout(ms) { return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)); }

function markOffline(res) {
  const headers = new Headers(res.headers);
  headers.set('X-Updatecon-Offline', '1');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// The network; if it fails or takes longer than `ms`, the cached copy (marked
// as offline). Nothing cached — keep waiting for the network: a slow answer
// is better than none.
async function networkFirst(req, key, ms) {
  const cache = await caches.open(CACHE);
  const net = fetch(req).then((res) => { if (res.ok) cache.put(key, res.clone()); return res; });
  net.catch(() => {});
  try {
    return await Promise.race([net, timeout(ms)]);
  } catch {
    const hit = await cache.match(key);
    return hit ? markOffline(hit) : net;
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const net = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; }).catch(() => hit);
  return hit || net;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') {
      if (APP_PAGE.test(url.pathname)) e.respondWith(networkFirst(req, SHELL, 5000));
      return;                                        // the admin panel and anything else: untouched
    }
    if (API.test(url.pathname)) { e.respondWith(networkFirst(req, req, 8000)); return; }
    if (STATIC.test(url.pathname)) { e.respondWith(staleWhileRevalidate(req)); return; }
    return;
  }
  if (FONTS.test(req.url)) e.respondWith(staleWhileRevalidate(req));
});
