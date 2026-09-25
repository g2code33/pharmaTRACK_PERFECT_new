/* PharmaTRACK public-shell service worker.
 * __PHARMATRACK_VERSION__ is replaced with package.json's version at build time.
 */
const CACHE_PREFIX = 'pharmatrack-shell-';
const CACHE_VERSION = `${CACHE_PREFIX}__PHARMATRACK_VERSION__`;
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.png',
  './logo.png',
];

function sameOrigin(url) {
  return url.origin === self.location.origin;
}

function isPublicAsset(request, url) {
  if (!sameOrigin(url) || request.method !== 'GET' || request.headers.has('authorization')) return false;
  // Vite's hashed bundles and the explicitly public branding assets are safe
  // to cache. API routes, auth callbacks, examination endpoints, user files,
  // and arbitrary document responses are intentionally excluded.
  if (/\/(?:api|auth|rest|functions|supabase|pharmaexam)(?:\/|$)/i.test(url.pathname)) return false;
  return /(?:^|\/)assets\//i.test(url.pathname) ||
    /(?:^|\/)(?:logo|icon|favicon)\.(?:png|jpg|jpeg|gif|webp|svg|ico)$/i.test(url.pathname);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => undefined),
  );
  // Do not skip waiting here. The app offers a deliberate, visible update
  // action so an examination or editing session is never replaced mid-flow.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || !sameOrigin(url)) return;

  if (request.mode === 'navigate') {
    // Network first keeps deployments fresh; the last public shell is the
    // offline fallback. Hash routes all resolve to this same index document.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE_VERSION).then((cache) => cache.put('./index.html', copy));
          }
          return response;
        })
        .catch(() => caches.match('./index.html').then((cached) => cached || caches.match('./'))),
    );
    return;
  }

  if (isPublicAsset(request, url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        });
      }),
    );
  }
});
