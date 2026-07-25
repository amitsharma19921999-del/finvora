// Finvora service worker — PWA offline shell.
// Strategy: network-FIRST (bypassing the HTTP cache) for navigations, so a new
// deploy is always picked up immediately; cache-first only for hashed, immutable
// assets; never touches /api. Bump CACHE on any strategy change to evict old data.
const CACHE = 'finvora-v3';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;

  // Navigations (index.html): always fetch fresh, bypass HTTP cache; offline -> shell.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then((res) => { caches.open(CACHE).then((c) => c.put('/', res.clone())); return res; })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Hashed static assets are immutable — cache-first is safe and fast.
  e.respondWith(
    caches.match(e.request).then((hit) =>
      hit ||
      fetch(e.request).then((res) => {
        if (res.ok && url.origin === location.origin) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return res;
      })
    )
  );
});
