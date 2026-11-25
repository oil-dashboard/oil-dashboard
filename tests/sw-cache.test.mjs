import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const swSource = await fs.readFile(new URL('../sw.js', import.meta.url), 'utf8');
const origin = 'https://oil-dashboard.example';
const scope = `${origin}/oil-dashboard/`;
const html = body => new Response(body, { headers: { 'Content-Type': 'text/html' } });
const script = body => new Response(body, { headers: { 'Content-Type': 'application/javascript' } });

function loadServiceWorkerSandbox({ fetchImpl, cached = new Map(), source = swSource, putImpl, openImpl } = {}) {
  const handlers = new Map();
  const key = input => new URL(typeof input === 'string' ? input : input.url, scope).href;
  const cache = {
    addAll: async () => {},
    match: async input => cached.get(key(input))?.clone(),
    put: putImpl || (async (input, value) => cached.set(key(input), value.clone())),
  };
  const removed = [];
  const sandbox = {
    URL, Set, Response, console,
    self: {
      addEventListener: (event, handler) => handlers.set(event, handler),
      skipWaiting() {},
      clients: { claim: async () => {} },
      location: { origin, href: `${scope}sw.js` },
    },
    caches: { open: openImpl || (async () => cache), keys: async () => ['oil-dash-old', 'some-other-app'], delete: async name => { removed.push(name); return true; } },
    fetch: fetchImpl || (async () => { throw new Error('Network unavailable'); }),
  };
  vm.runInNewContext(source, sandbox, { filename: 'sw.js' });
  function dispatch(relative, { method = 'GET', mode = 'cors' } = {}) {
    let promise;
    handlers.get('fetch')({ request: { url: new URL(relative, scope).href, method, mode }, respondWith: value => { promise = value; } });
    return promise;
  }
  return { ...sandbox, dispatch, handlers, removed, cached };
}

test('service worker bypasses dynamic JSON/API and all cross-origin requests', () => {
  const sandbox = loadServiceWorkerSandbox();
  for (const url of ['https://oil-proxy.xzregproxy.workers.dev/?url=upstream', `${scope}api/market`, `${scope}data/oott.json`, `${scope}build-info.json`, `${scope}manifest.json`, `${scope}sw.js`, `${scope}private.js`]) {
    assert.equal(sandbox.shouldBypassCache(url), true, url);
    assert.equal(sandbox.dispatch(url), undefined, url);
  }
  assert.equal(sandbox.dispatch('api/health', { mode: 'navigate' }), undefined);
  assert.equal(sandbox.shouldBypassCache(`${scope}app.js`), false);
});

test('navigation refreshes online even when a cached shell exists', async () => {
  const cached = new Map([[`${scope}index.html`, html('old')]]);
  let fetches = 0;
  const sandbox = loadServiceWorkerSandbox({ cached, fetchImpl: async () => { fetches++; return html('new'); } });
  const response = await sandbox.dispatch('index.html', { mode: 'navigate' });
  assert.equal(await response.text(), 'new');
  assert.equal(fetches, 1);
  assert.equal(await cached.get(`${scope}index.html`).text(), 'new');
});

test('offline navigation can use the shell but missing JavaScript never receives HTML', async () => {
  const cached = new Map([[`${scope}index.html`, html('offline page')]]);
  const sandbox = loadServiceWorkerSandbox({ cached });
  assert.equal(await (await sandbox.dispatch('./', { mode: 'navigate' })).text(), 'offline page');
  await assert.rejects(sandbox.dispatch('app.js'), /Network unavailable/);
});

test('only exact fingerprinted static assets use cache-first and HTML impostors are discarded', async () => {
  const source = swSource.replace('const STATIC_ASSETS = [', 'const STATIC_ASSETS = [\'./app.js?v=abc123\',');
  let fetches = 0;
  const cached = new Map([[`${scope}app.js?v=abc123`, script('cached code')]]);
  const sandbox = loadServiceWorkerSandbox({ source, cached, fetchImpl: async () => { fetches++; return script('network code'); } });
  assert.equal(await (await sandbox.dispatch('app.js?v=abc123')).text(), 'cached code');
  assert.equal(fetches, 0);
  cached.set(`${scope}app.js?v=abc123`, html('wrong cached response'));
  assert.equal(await (await sandbox.dispatch('app.js?v=abc123')).text(), 'network code');
  assert.equal(fetches, 1);
});

test('HTTP errors and HTML responses for scripts are not cached', async () => {
  const sandbox = loadServiceWorkerSandbox({ fetchImpl: async () => html('upstream fallback') });
  await sandbox.dispatch('app.js');
  assert.equal(sandbox.cached.has(`${scope}app.js`), false);
  assert.equal(sandbox.isCacheableResponse({ url: `${scope}app.js` }, new Response('missing', { status: 404 })), false);
});

test('a full cache never replaces a successful fresh response with the old cached page', async () => {
  const cached = new Map([[`${scope}index.html`, html('old page')]]);
  const sandbox = loadServiceWorkerSandbox({ cached, fetchImpl: async () => html('fresh page'), putImpl: async () => { const error = new Error('Cache full'); error.name = 'QuotaExceededError'; throw error; } });
  assert.equal(await (await sandbox.dispatch('index.html', { mode: 'navigate' })).text(), 'fresh page');
});

test('slow or unavailable cache storage does not block serving successful network content', async () => {
  const slow = loadServiceWorkerSandbox({ fetchImpl: async () => script('fresh code'), putImpl: () => new Promise(() => {}) });
  const response = await Promise.race([slow.dispatch('app.js'), new Promise((_, reject) => setTimeout(() => reject(new Error('Cache write blocked response')), 50))]);
  assert.equal(await response.text(), 'fresh code');
  const unavailable = loadServiceWorkerSandbox({ fetchImpl: async () => script('network still works'), openImpl: async () => { throw new Error('Storage unavailable'); } });
  assert.equal(await (await unavailable.dispatch('app.js')).text(), 'network still works');
});

test('activation removes only old caches owned by this dashboard', async () => {
  const sandbox = loadServiceWorkerSandbox();
  let completion;
  sandbox.handlers.get('activate')({ waitUntil: value => { completion = value; } });
  await completion;
  assert.deepEqual(sandbox.removed, ['oil-dash-old']);
});
