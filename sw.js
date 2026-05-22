const CACHE = 'rmf-v4';

self.addEventListener('install', e => {
  // Precache only the main HTML pages — icon files cached on demand
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled([
        c.add('/areapersonal.html'),
        c.add('/index.html'),
        c.add('/manifest.json')
      ]))
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
  if (
    url.includes('script.google.com') ||
    url.includes('googleapis.com') ||
    url.includes('googleusercontent.com') ||
    url.includes('fonts.googleapis.com') ||
    url.includes('fonts.gstatic.com') ||
    e.request.method !== 'GET'
  ) return;

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
