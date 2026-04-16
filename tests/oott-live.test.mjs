import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const appSource = await fs.readFile(new URL('../app.js', import.meta.url), 'utf8');

function makeElement() {
  return {
    textContent: '',
    innerHTML: '',
    className: '',
    style: {},
    dataset: {},
    addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} },
  };
}

function loadAppHooks() {
  const elements = new Map();
  const sandbox = {
    console,
    URL,
    Date,
    Math,
    JSON,
    Intl,
    AbortSignal: { timeout() { return {}; } },
    setTimeout() {},
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {},
    fetch: async () => ({ ok: true, status: 200, text: async () => '[]' }),
    localStorage: { getItem() { return null; }, setItem() {} },
    navigator: {},
    window: {},
    document: {
      querySelectorAll() { return []; },
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeElement());
        return elements.get(id);
      },
      addEventListener() {},
    },
  };

  vm.runInNewContext(appSource, sandbox, { filename: 'app.js' });
  return sandbox.__oilDashboardTestHooks;
}

test('stale OOTT data triggers live refresh on a new Singapore day', () => {
  const hooks = loadAppHooks();
  const staticPosts = [
    { createdAt: '2026-04-15T00:20:47+00:00', username: 'JuneGoh_Sparta', text: 'old' },
  ];

  assert.equal(
    hooks.needsLiveOottRefresh(staticPosts, new Date('2026-04-16T01:00:00+08:00')),
    true
  );
});

test('mergeOottPosts keeps newest live post first and removes duplicates by URL', () => {
  const hooks = loadAppHooks();
  const merged = hooks.mergeOottPosts(
    [
      {
        createdAt: '2026-04-15T00:20:47+00:00',
        username: 'JuneGoh_Sparta',
        url: 'https://x.com/example/status/1',
        text: 'yesterday static',
      },
    ],
    [
      {
        createdAt: 'Thu Apr 16 05:37:07 +0000 2026',
        handle: 'HFI_Research',
        url: 'https://x.com/example/status/2',
        text: 'today live',
      },
      {
        createdAt: 'Thu Apr 16 02:37:07 +0000 2026',
        handle: 'JuneGoh_Sparta',
        url: 'https://x.com/example/status/1',
        text: 'duplicate url should replace older',
      },
    ]
  );

  assert.equal(merged.length, 2);
  assert.equal(merged[0].username, 'HFI_Research');
  assert.equal(merged[0].text, 'today live');
  assert.equal(merged[1].text, 'duplicate url should replace older');
});
