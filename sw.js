const CACHE = 'rmf-v3';
const PRECACHE = [
  '/areapersonal.html',
  '/index.html',
  '/memorias.html',
  '/preinscripcion.html',
  '/manifest.json',
  '/icon.svg',
  '/icon-180.png',
  '/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  // Never intercept API calls or external resources
  if (
    url.includes('script.google.com') ||
    url.includes('googleapis.com') ||
    url.includes('googleusercontent.com') ||
    url.includes('fonts.googleapis.com') ||
    url.includes('fonts.gstatic.com') ||
    e.request.method !== 'GET'
  ) return;

  // Network-first: try live, fall back to cache
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() =>
        caches.match(e.request).then(r => r || caches.match('/areapersonal.html'))
      )
  );
});
