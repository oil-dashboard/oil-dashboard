import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const swSource = await fs.readFile(new URL('../sw.js', import.meta.url), 'utf8');

function loadServiceWorkerSandbox() {
  const sandbox = {
    URL,
    console,
    self: {
      addEventListener() {},
      skipWaiting() {},
      clients: { claim() {} },
      location: { origin: 'https://oil-dashboard.example' },
    },
    caches: {
      open: async () => ({ addAll() {}, put() {} }),
      keys: async () => [],
      delete: async () => true,
      match: async () => undefined,
    },
    fetch: async () => {
      throw new Error('fetch should not run in unit tests');
    },
  };

  vm.runInNewContext(swSource, sandbox, { filename: 'sw.js' });
  return sandbox;
}

test('service worker bypasses cache for the Cloudflare Yahoo proxy', () => {
  const { shouldBypassCache } = loadServiceWorkerSandbox();
  assert.equal(typeof shouldBypassCache, 'function');

  const proxyUrl = 'https://oil-proxy.xzregproxy.workers.dev/?url=https%3A%2F%2Fquery1.finance.yahoo.com%2Fv8%2Ffinance%2Fchart%2FBZ%3DF%3Frange%3D2d%26interval%3D5m';
  assert.equal(shouldBypassCache(proxyUrl), true);
});

test('service worker still caches same-origin static assets', () => {
  const { shouldBypassCache } = loadServiceWorkerSandbox();
  assert.equal(shouldBypassCache('https://oil-dashboard.example/app.js'), false);
});
