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
