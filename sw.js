const CACHE_VERSION = 'oil-dash-development';
const STATIC_ASSETS = ['./', './index.html', './style.css', './app.js', './market-ui.js', './shared/market-core.js', './shared/energy-calendar.js', './vendor/lightweight-charts.standalone.production.js'];
const CACHE_PREFIX = 'oil-dash-';
const SCOPE_URL = new URL('./', self.location.href);
const STATIC_URLS = new Set(STATIC_ASSETS.map(asset => new URL(asset, SCOPE_URL).href));

function shouldBypassCache(url) {
  const parsed = new URL(url, SCOPE_URL);
  if (parsed.origin !== self.location.origin) return true;
  if (parsed.pathname.includes('/api/') || parsed.pathname.endsWith('.json') || parsed.pathname.endsWith('/sw.js')) return true;
  if (parsed.searchParams.has('url') || parsed.searchParams.has('twitter')) return true;
  return !STATIC_URLS.has(parsed.href);
}

function isCacheableResponse(request, response) {
  if (!response?.ok || response.type === 'opaque') return false;
  const pathname = new URL(request.url).pathname;
  const type = response.headers.get('content-type') || '';
  if (pathname.endsWith('.js')) return /(?:java|ecma)script/i.test(type);
  if (pathname.endsWith('.css')) return /text\/css/i.test(type);
  return request.mode === 'navigate' || /text\/html/i.test(type);
}

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_VERSION).then(cache => cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION).map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const navigation = request.mode === 'navigate' && new URL(request.url).origin === self.location.origin;
  if (shouldBypassCache(request.url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION).catch(() => null);
    const candidate = cache ? await cache.match(request).catch(() => null) : null;
    const cached = candidate && isCacheableResponse(request, candidate) ? candidate : null;
    const versioned = new URL(request.url).searchParams.has('v');
    if (!navigation && versioned && cached) return cached;
    try {
      const response = await fetch(request, { cache: 'no-store' });
      if (cache && isCacheableResponse(request, response)) {
        try {
          const update = cache.put(request, response.clone()).catch(() => {});
          if (typeof event.waitUntil === 'function') event.waitUntil(update);
        } catch { /* Cache failures must never replace a successful network response. */ }
      }
      return response;
    } catch (error) {
      if (cached) return cached;
      if (navigation && cache) {
        const shell = await cache.match(new URL('./index.html', SCOPE_URL).href).catch(() => null);
        if (shell) return shell;
      }
      throw error;
    }
  })());
});
