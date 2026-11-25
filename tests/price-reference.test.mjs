import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../app.js', import.meta.url), 'utf8');
function loadApp(marketUI) {
  const elements = new Map();
  const sandbox = {
    console, URL, Date, Math, JSON, Intl,
    AbortSignal: { timeout() { return {}; } },
    setTimeout() {}, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {},
    fetch() { return new Promise(() => {}); },
    localStorage: { getItem() { return null; }, setItem() {} }, navigator: {}, window: {},
    OilMarketUI: marketUI,
    document: {
      querySelectorAll() { return []; }, addEventListener() {},
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', style: {}, className: '' });
        return elements.get(id);
      },
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'app.js' });
  return { hooks: sandbox.__oilDashboardTestHooks, elements };
}

test('production market refresh delegates to the validated snapshot renderer without overwriting its status', async () => {
  let calls = 0;
  const marketUI = { init() {}, async refresh() { calls++; return { status: 'delayed' }; } };
  const { hooks, elements } = loadApp(marketUI);
  elements.set('sourceStatus', { textContent: '延迟 10 分钟' });
  const result = await hooks.fetchPrices();
  assert.equal(calls, 1);
  assert.equal(result.status, 'delayed');
  assert.equal(elements.get('sourceStatus').textContent, '延迟 10 分钟');
});

test('missing market module is visibly unavailable rather than leaving a live label', async () => {
  const { hooks, elements } = loadApp(undefined);
  const result = await hooks.fetchPrices();
  assert.equal(result.status, 'unavailable');
  assert.equal(elements.get('sourceStatus').textContent, '行情模块未加载');
});

test('feed merges matching headlines across sources but preserves opposing reports and later-day events', () => {
  const { hooks } = loadApp();
  const rows = hooks.dedupeNewsItems([
    { title: 'Oil exports rise', link: 'https://a.example/one?utm_source=feed', source: 'Reuters', pubDate: '2026-11-25T08:00:00Z' },
    { title: 'Oil exports rise!', link: 'https://b.example/two', source: 'Bloomberg', pubDate: '2026-11-25T09:00:00Z' },
    { title: 'Oil exports fall', link: 'https://c.example/three', source: 'AP', pubDate: '2026-11-25T09:00:00Z' },
    { title: 'Oil exports rise', link: 'https://d.example/four', source: 'Reuters', pubDate: '2026-11-20T08:00:00Z' },
  ]);
  assert.equal(rows.length, 3);
  const combined = rows.find(item => item.relatedSources.length === 2);
  assert.equal(combined.title, 'Oil exports rise!');
  assert.equal(hooks.buildFeedEventFromNews(combined).sources, 2);
});

test('feed URLs reject script schemes and escape untrusted attribute text', () => {
  const { hooks } = loadApp();
  assert.equal(hooks.safeHttpUrl('javascript:alert(1)'), '');
  assert.equal(hooks.normalizeOottPost({ createdAt: '2026-11-25T08:00:00Z', url: 'javascript:alert(1)' }).url, '');
  assert.equal(hooks.escapeHtml('"<x>&\''), '&quot;&lt;x&gt;&amp;&#39;');
});

test('polymarket date windows remain tied to Singapore dates', () => {
  const { hooks } = loadApp();
  const filtered = hooks.filterActivePolymarketConditions([
    { label: '4月7日', prob: '89%' }, { label: '4月15日', prob: '83%' },
    { label: '4月底', prob: '85%' }, { label: '↑$120', prob: '9%' },
  ], new Date('2026-04-20T12:00:00+08:00'));
  assert.deepEqual(Array.from(filtered, row => row.label), ['4月底', '↑$120']);
});

test('upstream editorial requests retain the configured Worker proxy', () => {
  const { hooks } = loadApp();
  assert.deepEqual(Array.from(hooks.buildCapduckCandidates('https://skill.capduck.com/iran/polymarket')), [
    'https://oil-proxy.xzregproxy.workers.dev?url=https%3A%2F%2Fskill.capduck.com%2Firan%2Fpolymarket',
  ]);
});

test('news events render through the production feed with impact labels, original links and escaped text', () => {
  const { hooks, elements } = loadApp();
  hooks.renderFeedItems([hooks.buildFeedEventFromNews({ title: 'Oil exports rise & Iran sanctions tighten', link: 'https://publisher.example/news', source: 'Publisher', pubDate: '2026-11-25T08:00:00Z' })]);
  const html = elements.get('feedList').innerHTML;
  assert.match(html, /impact-high/);
  assert.match(html, /Oil exports rise &amp; Iran sanctions tighten/);
  assert.match(html, /https:\/\/publisher.example\/news/);
  assert.match(html, /rel="noopener noreferrer"/);
});
