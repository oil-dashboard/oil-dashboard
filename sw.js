const CACHE = 'oil-dash-v12';
const STATIC = ['./', './index.html', './style.css', './app.js', './manifest.json', './sources.json'];

function shouldBypassCache(url) {
  const parsed = new URL(url);
  if (parsed.origin !== self.location.origin) return true;
  if (parsed.searchParams.has('url') || parsed.searchParams.has('twitter')) return true;
  if (parsed.pathname.endsWith('.json')) return true;
  return false;
}

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || shouldBypassCache(e.request.url)) return;
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(resp => {
      const clone = resp.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
      return resp;
    }).catch(() => caches.match('./index.html')))
  );
});
