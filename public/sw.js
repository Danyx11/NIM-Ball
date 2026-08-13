// Minimal offline shell for the installed PWA. Deliberately does NOT precache
// a hardcoded asset list: Vite hashes JS/CSS filenames per build, and this
// project's public/ tree (sfx, sprites, arena art) is large and changes
// often, so a static manifest would go stale immediately. Instead this
// populates its cache opportunistically from real traffic:
//   - navigations (the HTML page itself) go network-first, falling back to
//     the last cached copy when offline;
//   - same-origin GET requests (JS/CSS/images/audio) go cache-first, with a
//     background re-fetch to keep the cache warm for next time.
// Cross-origin requests (Nimiq Mini App SDK calls, the PartyKit/wrangler
// network-match host) and non-GET requests are left untouched — this worker
// never intercepts them.
const CACHE_NAME = 'nim-curl-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(request).then((cached) => cached || caches.match('./')))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((response) => {
        if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
        return response;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
