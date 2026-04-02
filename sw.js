const CACHE = 'oil-dash-v5';
const STATIC = ['./', './index.html', './style.css', './app.js', './manifest.json', './sources.json'];

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
  const url = e.request.url;
  // 不缓存 API 请求
  if (url.includes('yahoo') || url.includes('capduck') || url.includes('allorigins')
    || url.includes('corsproxy') || url.includes('codetabs') || url.includes('cors.sh')) return;
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(resp => {
      const clone = resp.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
      return resp;
    }).catch(() => caches.match('./index.html')))
  );
});
