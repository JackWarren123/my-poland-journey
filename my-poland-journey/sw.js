const CACHE = 'poland-journey-v44';

const PRECACHE = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/map.js',
  '/js/auth.js',
  '/data/cities.json',
  '/data/content.json',
  '/data/poland_modern.geojson',
  '/data/poland_1939.geojson',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/icon-512.svg',
  '/assets/profile-circle.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Only handle same-origin GET requests — let YouTube, Supabase, CDN go through
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Cache successful same-origin responses
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
