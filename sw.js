// Caches the app so it opens fast and works with a weak signal. Bump VERSION to ship an update.
const VERSION = 'sbdnj-hq-v2';
const CORE = ['./', './index.html', './edit.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.hostname === 'api.anthropic.com') return;
  e.respondWith(caches.open(VERSION).then(async c => {
    const hit = await c.match(e.request);
    const net = fetch(e.request).then(r => { if (r.ok && (u.origin === location.origin || u.hostname.endsWith('jsdelivr.net') || u.hostname.endsWith('gstatic.com') || u.hostname.endsWith('googleapis.com'))) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
