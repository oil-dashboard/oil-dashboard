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

function loadAppContext() {
  const elements = new Map();
  const store = new Map();
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
    localStorage: {
      getItem(key) { return store.has(key) ? store.get(key) : null; },
      setItem(key, value) { store.set(key, String(value)); },
    },
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
  return { hooks: sandbox.__oilDashboardTestHooks, store };
}

function loadAppHooks() {
  return loadAppContext().hooks;
}

test('reference close label uses previous session end in Singapore time', () => {
  const hooks = loadAppHooks();
  const info = hooks.getReferenceCloseInfo({
    meta: {
      chartPreviousClose: 94.79,
      tradingPeriods: [
        [{ start: 1776139200, end: 1776225540 }],
        [{ start: 1776225600, end: 1776311940 }],
      ],
    },
  });

  assert.equal(info.prevClose, 94.79);
  assert.equal(info.referenceLabel, '对比 4/15 11:59 收盘');
});

test('reference close label falls back gracefully when trading periods are missing', () => {
  const hooks = loadAppHooks();
  const info = hooks.getReferenceCloseInfo({
    meta: { previousClose: 72.31 },
  });

  assert.equal(info.prevClose, 72.31);
  assert.equal(info.referenceLabel, '对比上一交易时段收盘');
});

test('price chart fetch uses the stable Yahoo intraday range', () => {
  const hooks = loadAppHooks();

  assert.equal(hooks.PRICE_CHART_RANGE, '5d');
  assert.equal(hooks.PRICE_CHART_INTERVAL, '5m');
});

test('tradingview fallback turns on when yahoo has not entered the current session', () => {
  const hooks = loadAppHooks();
  const raw = {
    timestamps: [1776459300, 1776459599],
    closes: [91.19, 90.38],
    meta: {
      currentTradingPeriod: {
        regular: { start: 1776657600 },
      },
    },
  };

  assert.equal(hooks.shouldUseTradingViewFallback(raw, 1776660000), true);
  assert.equal(hooks.shouldUseTradingViewFallback(raw, 1776658000), false);
});

test('singapore daily reference rolls at local midnight instead of exchange close', () => {
  const { hooks } = loadAppContext();

  const first = hooks.applySgtDailyReference(
    'brent',
    { price: '92.00', change: '0.00', pct: '0.0', referenceLabel: '对比上一交易时段收盘' },
    new Date('2026-04-20T23:55:00+08:00')
  );
  const second = hooks.applySgtDailyReference(
    'brent',
    { price: '93.50', change: '0.00', pct: '0.0', referenceLabel: '对比上一交易时段收盘' },
    new Date('2026-04-21T00:05:00+08:00')
  );

  assert.equal(first.referenceLabel, '对比上一交易时段收盘');
  assert.equal(second.referenceLabel, '对比 4/20 SGT 日收盘');
  assert.equal(second.change, '1.50');
});
