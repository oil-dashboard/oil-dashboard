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

  assert.equal(hooks.YAHOO_QUOTE_RANGE, '1d');
  assert.equal(hooks.YAHOO_QUOTE_INTERVAL, '1m');
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

test('tradingview daily reference rolls when the daily bar timestamp advances', () => {
  const { hooks } = loadAppContext();

  const first = hooks.applyTradingViewDailyReference(
    'brent',
    { price: '92.00', change: '0.00', pct: '0.0', referenceLabel: '对比上一交易时段收盘' },
    { price: 92.00, barTime: 1776643200, fetchedAt: 1776674400 },
    { timestamps: [1776459599], closes: [90.38], meta: {} }
  );
  const second = hooks.applyTradingViewDailyReference(
    'brent',
    { price: '93.50', change: '0.00', pct: '0.0', referenceLabel: '对比上一交易时段收盘' },
    { price: 93.50, barTime: 1776729600, fetchedAt: 1776762300 },
    { timestamps: [1776729300], closes: [93.25], meta: {} }
  );

  assert.equal(first.referenceLabel, '对比 4/17 收盘');
  assert.equal(second.referenceLabel, '对比 4/20 收盘');
  assert.equal(second.change, '1.50');
});

test('polymarket view hides expired dated windows but keeps future and price buckets', () => {
  const hooks = loadAppHooks();
  const filtered = hooks.filterActivePolymarketConditions(
    [
      { label: '4月7日', prob: '89%' },
      { label: '4月15日', prob: '83%' },
      { label: '4月底', prob: '85%' },
      { label: '↑$120', prob: '9%' },
    ],
    new Date('2026-04-20T12:00:00+08:00')
  );

  assert.deepEqual(filtered.map(item => item.label), ['4月底', '↑$120']);
});

test('yahoo quote data uses regular market price and previous close', () => {
  const hooks = loadAppHooks();
  const data = hooks.buildYahooQuoteData(
    { timestamps: [1776660000], closes: [95.48], meta: {} },
    {
      meta: {
        regularMarketPrice: 94.55,
        regularMarketTime: 1776752803,
        chartPreviousClose: 95.48,
        currentTradingPeriod: { regular: { start: 1776744000 } },
      },
    }
  );

  assert.equal(data.price, '94.55');
  assert.equal(data.change, '-0.93');
  assert.equal(data.referenceLabel, '对比 4/20 收盘');
});

test('yahoo quote data can anchor on the prior daily settlement', () => {
  const hooks = loadAppHooks();
  const data = hooks.buildYahooQuoteData(
    { timestamps: [1776990000], closes: [105.97], meta: {} },
    {
      meta: {
        regularMarketPrice: 99.53,
        regularMarketTime: 1777039308,
        currentTradingPeriod: { regular: { start: 1777003200 } },
        exchangeTimezoneName: 'America/New_York',
        chartPreviousClose: 104.49,
        previousClose: 99.35,
      },
    },
    {
      timestamps: [1776830400, 1776916800, 1777003200],
      closes: [101.91, 105.07, 99.53],
      meta: {
        currentTradingPeriod: { regular: { start: 1777003200 } },
        exchangeTimezoneName: 'America/New_York',
      },
    }
  );

  assert.equal(data.price, '99.53');
  assert.equal(data.change, '-5.54');
  assert.equal(data.referenceLabel, '对比 4/23 收盘');
});

test('yahoo previous trading day label follows exchange session boundary', () => {
  const hooks = loadAppHooks();
  const label = hooks.getPreviousTradingDayLabelFromMeta({
    exchangeTimezoneName: 'America/New_York',
    currentTradingPeriod: {
      regular: { start: 1776744000 },
    },
  });

  assert.equal(label, '4/20');
});

test('capduck requests try worker proxy before direct upstream', () => {
  const hooks = loadAppHooks();
  const candidates = Array.from(hooks.buildCapduckCandidates('https://skill.capduck.com/iran/polymarket'));

  assert.deepEqual(candidates, [
    'https://oil-proxy.xzregproxy.workers.dev?url=https%3A%2F%2Fskill.capduck.com%2Firan%2Fpolymarket',
  ]);
});
