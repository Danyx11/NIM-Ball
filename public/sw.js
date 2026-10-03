// Minimal offline shell for the installed PWA. Deliberately does NOT precache
// a hardcoded asset list: Vite hashes JS/CSS filenames per build, and this
// project's public/ tree (sfx, sprites, arena art) is large and changes
// often, so a static manifest would go stale immediately. Instead this
// populates its cache opportunistically from real traffic:
//   - navigations (the HTML page itself) go network-first, falling back to
//     the last cached copy when offline;
//   - same-origin GET requests (JS/CSS/images/audio) go cache-first, with a
//     background re-fetch to keep the cache warm for next time.
// Cross-origin requests (Nimiq Mini App SDK calls, the LIVE/WEEK Cloudflare
// Worker host) and non-GET requests are left untouched — this worker
// never intercepts them.
const CACHE_NAME = 'nim-curl-v1';

// ---- Why this worker needs bounds at all ----
// CACHE_NAME is a fixed string, so `activate`'s "delete every cache that
// isn't the current one" sweep never deletes anything: there has only ever
// been one cache and its name doesn't change between deploys. Nothing else
// removed entries either, so the cache only grew — every arena frame, every
// sfx clip, plus a fresh hashed index-*.js/css pair for each deploy, on top of
// a public/ tree in the tens of megabytes. That matters beyond disk use:
// when a browser decides an origin is over its storage budget it evicts the
// WHOLE origin, localStorage included — and localStorage is where the
// connected wallet address, the Custom match presets and, most expensively,
// src/alias.js's pending-alias-claim payment hash live. That hash exists
// precisely so a 30 NIM payment already sent to the chain can still be
// attributed after a reload or crash; losing it to a cache-driven eviction
// would strand real money. So: cap the number of entries, and never cache the
// handful of assets big enough to blow the budget on their own.
const MAX_ENTRIES = 220;
// Comfortably above every real asset here (the largest arena frame is ~1.6MB)
// and below the one outlier, public/rules/nimicurl-howto.mp4 at ~5.5MB — a
// 64-second tutorial video has no business sitting in an offline shell, and
// it is served by range request anyway, which this cache can't satisfy
// correctly from a stored full-body response.
const MAX_CACHEABLE_BYTES = 3 * 1024 * 1024;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => trim()).then(() => self.clients.claim())
  );
});

// Cache.keys() resolves in insertion order, so dropping from the front is a
// plain FIFO eviction — oldest-stored first. Good enough and predictable: the
// assets a session actually uses get re-fetched and re-inserted at the back on
// their next use, so what ages out is what stopped being requested (the
// superseded bundles of old deploys, mostly).
async function trim() {
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  if (keys.length <= MAX_ENTRIES) return;
  await Promise.all(keys.slice(0, keys.length - MAX_ENTRIES).map((key) => cache.delete(key)));
}

// Content-Length is absent on a chunked response, in which case this can't
// tell and lets it through — the entry cap above is the real backstop, this
// only keeps the known-huge files out in the first place.
function tooBigToCache(response) {
  const len = Number(response.headers.get('content-length'));
  return Number.isFinite(len) && len > MAX_CACHEABLE_BYTES;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;
  // A range request (the tutorial <video>) must reach the network: a cached
  // 200 full body is not a valid answer to one, and storing partial 206
  // responses isn't allowed by the Cache API either.
  if (request.headers.has('range')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(request).then((cached) => cached || caches.match('./')))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((response) => {
        if (response.ok && !tooBigToCache(response)) {
          const copy = response.clone();
          event.waitUntil(
            caches.open(CACHE_NAME)
              .then((cache) => cache.put(request, copy))
              .then(() => trim())
              .catch(() => {}),
          );
        }
        return response;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
