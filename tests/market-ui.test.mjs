import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const CORE = readFileSync(new URL('../shared/market-core.js', import.meta.url), 'utf8');
const UI = readFileSync(new URL('../market-ui.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const NOW = Date.parse('2026-11-25T15:00:00Z') / 1000;
const clone = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));

class Element {
  constructor(id = '', dataset = {}) { this.id = id; this.dataset = dataset; this.textContent = ''; this.innerHTML = ''; this.className = ''; this.hidden = false; this.style = {}; this.attributes = {}; this.listeners = new Map(); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  click() { return Promise.all([...(this.listeners.get('click') || [])].map(fn => fn({ target: this }))); }
  getBoundingClientRect() { return { width: 700, height: 255 }; }
}

function harness(fetchImpl) {
  let clock = NOW * 1000;
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const elements = new Map([...HTML.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element(match[1])]));
  const controls = {};
  for (const [attribute, key, values] of [['data-chart-range', 'chartRange', ['1d', '5d', '1mo']], ['data-chart-instrument', 'chartInstrument', ['brent', 'wti', 'spread']], ['data-curve-instrument', 'curveInstrument', ['brent', 'wti']]]) controls[`[${attribute}]`] = values.map(value => new Element('', { [key]: value }));
  const intervals = new Map(), storage = new Map(), charts = [], observers = [], requests = [], markerPlugins = [];
  let timerId = 0;
  const context = vm.createContext({
    Date: ClockDate, Intl, Map, Set, URL, AbortController, console, OIL_API_BASE: 'https://market.test',
    document: { getElementById: id => elements.get(id), querySelectorAll: selector => controls[selector] || [] },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    setTimeout, clearTimeout, setInterval: fn => { const id = ++timerId; intervals.set(id, fn); return id; }, clearInterval: id => intervals.delete(id),
    fetch: async (url, options) => { requests.push(String(url)); return fetchImpl ? fetchImpl(String(url), options) : response(String(url).includes('/api/curve') ? curve() : payload()); },
    ResizeObserver: class { constructor(fn) { this.fn = fn; observers.push(this); } observe() { this.observed = true; } disconnect() { this.disconnected = true; } },
    LightweightCharts: {
      LineSeries: { type: 'line' }, TickMarkType: { Year: 0, Month: 1, DayOfMonth: 2, Time: 3 },
      createSeriesMarkers(series, markers) {
        const plugin = { series, values: clone(markers), updates: 0, setMarkers(items) { this.values = clone(items); this.updates++; }, detach() { this.detached = true; } };
        markerPlugins.push(plugin); return plugin;
      },
      createChart(container, options) {
        const series = { data: [], lines: new Set(), removed: [], setData(data) { this.data = clone(data); }, applyOptions(value) { this.options = value; }, createPriceLine(value) { this.lines.add(value); return value; }, removePriceLine(value) { this.removed.push(value); this.lines.delete(value); } };
        const scale = { visible: null, fits: 0, getVisibleLogicalRange() { return this.visible; }, setVisibleLogicalRange(value) { this.visible = value; }, fitContent() { this.fits++; } };
        const chart = { container, options, series, scale, addSeries(type) { assert.equal(type.type, 'line'); return series; }, subscribeCrosshairMove(fn) { this.crosshair = fn; }, timeScale() { return scale; }, resize(w, h) { this.size = [w, h]; }, remove() { this.removed = true; } };
        charts.push(chart); return chart;
      },
    },
  });
  vm.runInContext(CORE, context); vm.runInContext(UI, context);
  return { context, ui: context.OilMarketUI, hooks: context.__oilMarketUITestHooks, elements, controls, storage, charts, observers, requests, markerPlugins, intervals, advance(seconds) { clock += seconds * 1000; }, tick() { for (const fn of intervals.values()) fn(); } };
}
function response(data, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => clone(data) }; }
function quote(instrument = 'brent', overrides = {}) {
  const price = instrument === 'brent' ? 91 : 85, symbol = instrument === 'brent' ? 'BZ=F' : 'CL=F';
  return { instrument, symbol, contract: 'continuous-front', exchange: 'NYMEX', currency: 'USD', source: 'yahoo', price, priceAt: NOW - 20, fetchedAt: NOW, tradingDate: '2026-11-25', reference: { price: price - 1, date: '2026-11-24', type: 'previous-close', basis: 'daily-close', source: 'yahoo', symbol }, change: 1, changePercent: 100 / (price - 1), status: 'fresh', marketState: 'unknown', delaySeconds: 0, providerUpdatedAt: null, timeBasis: 'market-time', historySource: 'yahoo', historySymbol: symbol, series: [{ time: NOW - 320, value: price - .2 }, { time: NOW - 20, value: price }], ...overrides };
}
function syncSpread(data) {
  const a = data.instruments.brent, b = data.instruments.wti;
  const aligned = a.source === b.source && a.currency === b.currency && Number.isFinite(a.priceAt) && Number.isFinite(b.priceAt);
  const history = aligned && a.historySource === a.source && b.historySource === b.source && a.historySymbol === a.symbol && b.historySymbol === b.symbol;
  const right = new Map(b.series.map(point => [point.time, point.value]));
  data.spread = { source: a.source === b.source ? a.source : null, symbols: { brent: a.symbol, wti: b.symbol }, price: aligned ? a.price - b.price : null, priceAt: aligned ? Math.min(a.priceAt, b.priceAt) : null, status: aligned ? 'fresh' : 'unavailable', series: history ? a.series.filter(point => right.has(point.time)).map(point => ({ time: point.time, value: point.value - right.get(point.time) })) : [] };
  return data;
}
function payload(overrides = {}) {
  const data = { schemaVersion: 1, generatedAt: NOW, range: '1d', instruments: { brent: quote(), wti: quote('wti') }, ...overrides };
  return Object.hasOwn(overrides, 'spread') ? data : syncSpread(data);
}
function curve(overrides = {}) {
  const instrument = overrides.instrument || 'brent', root = instrument === 'brent' ? 'ICEEUR:BRN' : 'NYMEX:CL', exchange = instrument === 'brent' ? 'ICE Futures Europe' : 'NYMEX';
  return { schemaVersion: 1, instrument, source: 'tradingview', exchange, status: 'available', cache: 'miss', contracts: [0, 1, 2].map(i => ({ symbol: `${root}${'FGH'[i]}2027`, contract: instrument, exchange, deliveryMonth: `2027-0${i + 1}`, expiration: `2026-12-${20 + i}`, price: 90 - i, priceAt: null, providerUpdatedAt: NOW - 20, timeBasis: 'provider-update', fetchedAt: NOW, source: 'tradingview', currency: 'USD', delaySeconds: 600, status: 'delayed' })), spreads: { m1m2: 1, m1m3: 2 }, ...overrides };
}

test('instrument switches replace series and reference lines, including unavailable bases and spread', () => {
  const h = harness(), data = payload();
  data.instruments.wti.reference = null; data.instruments.wti.change = data.instruments.wti.changePercent = null;
  h.ui.renderSnapshot(data);
  const { series, scale } = h.charts[0];
  assert.equal(series.lines.size, 1);
  assert.equal(h.elements.get('brentPrice').textContent, '$91.00');
  assert.match(h.elements.get('brentInstrument').textContent, /BZ=F/);
  h.ui.selectInstrument('wti');
  assert.equal(series.data.at(-1).value, 85);
  assert.equal(series.lines.size, 0);
  assert.equal(h.elements.get('wtiChange').textContent, '—');
  assert.match(h.elements.get('wtiReference').textContent, /日线前收暂不可用/);
  h.ui.selectInstrument('spread');
  assert.equal(series.data.at(-1).value, 6);
  assert.equal(h.elements.get('chartSymbol').textContent, 'Brent − WTI');
  assert.equal(series.lines.size, 0);
  assert.equal(scale.fits, 3);
  assert.match(h.elements.get('chartDataRows').innerHTML, /6.00/);
});

test('a daily-close reference without a valid prior trading date is rejected', () => {
  const h = harness(), data = payload(); data.instruments.brent.reference.date = null;
  h.ui.renderSnapshot(data);
  assert.equal(h.elements.get('brentChange').textContent, '—');
  assert.match(h.elements.get('brentReference').textContent, /日线前收暂不可用/);
  assert.doesNotMatch(h.elements.get('brentReference').textContent, /待确认/);
  assert.equal(h.charts.length, 0);
});

test('TradingView fallback displays source update and ten-minute delay while clearing old chart and spread', () => {
  const h = harness(); h.ui.renderSnapshot(payload());
  const tv = instrument => h.context.OilMarket.normalizeTVSnapshot({ instrument, symbol: instrument === 'brent' ? 'ICEEUR:BRN1!' : 'NYMEX:CL1!', now: NOW, raw: { symbol: instrument === 'brent' ? 'ICEEUR:BRN1!' : 'NYMEX:CL1!', close: 90, changeAbs: 1, providerUpdatedAt: NOW - 20, delaySeconds: 600 } });
  const data = payload({ instruments: { brent: tv('brent'), wti: tv('wti') } });
  h.ui.renderSnapshot(data);
  assert.match(h.elements.get('brentTime').textContent, /源更新.*SGT · 成交时间未提供/);
  assert.match(h.elements.get('brentStatus').textContent, /延迟 10 分钟/);
  assert.match(h.elements.get('brentReference').textContent, /日线前收暂不可用/);
  assert.equal(h.elements.get('spreadValue').textContent, '—');
  assert.equal(h.charts[0].series.data.length, 0);
  assert.equal(h.charts[0].series.lines.size, 0);
  assert.equal(h.elements.get('chartEmpty').hidden, false);
  assert.notEqual(h.elements.get('liveDot').style.backgroundColor, 'var(--up)');
});

test('cache validates final snapshots, range, provenance and source-time freshness', async () => {
  const h = harness(async () => { throw new Error('offline'); });
  const key = h.hooks.CACHE_PREFIX + '1d';
  const bad = payload(); bad.instruments.brent.reference.source = 'tradingview';
  h.storage.set(key, JSON.stringify({ storedAt: NOW * 1000, payload: bad }));
  assert.equal(h.hooks.readCache(), null);
  assert.equal((await h.ui.refresh()).status, 'unavailable');
  assert.equal(h.elements.get('brentPrice').textContent, '—');
  const old = payload();
  for (const snapshot of Object.values(old.instruments)) { snapshot.priceAt = NOW - 4000; snapshot.series = []; snapshot.status = 'stale'; }
  syncSpread(old);
  h.hooks.writeCache(old);
  assert.equal((await h.ui.refresh()).status, 'stale');
  assert.match(h.elements.get('brentStatus').textContent, /缓存 · 数据过期/);
  assert.equal(h.elements.get('spreadValue').textContent, '—');
  assert.notEqual(h.elements.get('sourceStatus').className, 'source-status source-live');
  h.ui.destroy();
});

test('cached provider timestamps age even when cache was just stored', async () => {
  const h = harness(async () => { throw new Error('offline'); });
  const data = payload();
  for (const [instrument, snapshot] of Object.entries(data.instruments)) data.instruments[instrument] = h.context.OilMarket.normalizeTVSnapshot({ instrument, symbol: snapshot.symbol, now: NOW, raw: { symbol: snapshot.symbol, close: 90, providerUpdatedAt: NOW - 4000, delaySeconds: 600 } });
  syncSpread(data);
  h.hooks.writeCache(data);
  const result = await h.ui.refresh();
  assert.equal(result.status, 'stale');
  assert.match(h.elements.get('brentTime').textContent, /源更新/);
  h.ui.destroy();
});

test('range changes clear mismatched history, supersede old requests and keep UTC timestamps', async () => {
  let resolveOld;
  const h = harness(url => {
    if (url.includes('/api/curve')) return response(curve());
    if (url.includes('range=5d')) return new Promise(resolve => { resolveOld = resolve; });
    return response(payload({ range: '1mo' }));
  });
  h.ui.renderSnapshot(payload());
  const oldRequest = h.ui.setRange('5d');
  assert.equal(h.charts[0].series.data.length, 0);
  assert.match(h.elements.get('chartEmpty').textContent, /正在加载所选范围/);
  await h.ui.setRange('1mo');
  resolveOld(response(payload({ range: '5d' })));
  assert.equal((await oldRequest).status, 'superseded');
  assert.equal(h.hooks.state.range, '1mo');
  assert.equal(h.charts[0].series.data[0].time, NOW - 320);
  assert.match(h.charts[0].options.localization.timeFormatter(NOW), /23:00.*SGT/);
  assert.match(h.charts[0].options.timeScale.tickMarkFormatter(NOW, 2), /11.*25/);
  assert.equal(h.controls['[data-chart-range]'][2].attributes['aria-pressed'], 'true');
  h.ui.destroy();
});

test('failed fetch removes unavailable state on retry and restores refresh button', async () => {
  let fail = true;
  const h = harness(url => url.includes('/api/curve') ? response(curve()) : fail ? response({}, 503) : response(payload()));
  await h.ui.refresh();
  assert.equal(h.elements.get('brentPrice').textContent, '—');
  assert.equal(h.elements.get('marketRefresh').disabled, false);
  assert.equal(h.elements.get('marketRefresh').attributes['aria-busy'], undefined);
  fail = false;
  await h.elements.get('marketRefresh').click();
  assert.equal(h.elements.get('brentPrice').textContent, '$91.00');
  assert.equal(h.elements.get('chartEmpty').hidden, true);
  assert.equal(h.elements.get('sourceStatus').className, 'source-status source-live');
  h.ui.destroy();
});

test('API routing honors explicit same-origin base and local preview origin', async () => {
  const explicit = harness(); explicit.context.OIL_API_BASE = '';
  await explicit.ui.refresh();
  assert.equal(explicit.requests[0], '/api/market?range=1d');
  explicit.ui.destroy();
  const local = harness(); delete local.context.OIL_API_BASE;
  local.context.location = { hostname: '127.0.0.1', origin: 'http://127.0.0.1:8082' };
  await local.ui.refresh();
  assert.equal(local.requests[0], 'http://127.0.0.1:8082/api/market?range=1d');
  local.ui.destroy();
});

test('range-mismatched API and mixed history cannot become the final cached snapshot', async () => {
  const wrong = payload({ range: '5d' });
  const h = harness(url => url.includes('/api/curve') ? response(curve()) : response(wrong));
  await h.ui.refresh();
  assert.equal(h.elements.get('brentPrice').textContent, '—');
  assert.equal(h.storage.size, 0);
  const mixed = payload(); mixed.instruments.brent.historySymbol = 'OTHER';
  assert.equal(h.hooks.validatePayload(mixed), false);
  mixed.instruments.brent.historySymbol = 'BZ=F'; mixed.instruments.brent.historySource = 'tradingview';
  assert.equal(h.hooks.validatePayload(mixed), false);
  h.ui.destroy();
});

test('curve shows verified expiry, source update and delay, and removes stale or invalid spreads', () => {
  const h = harness(); h.hooks.renderCurve(curve());
  assert.match(h.elements.get('curveRows').innerHTML, /到期 2026-12-20/);
  assert.match(h.elements.get('curveRows').innerHTML, /源更新 · 延迟 10 分钟/);
  assert.match(h.elements.get('curveSummary').innerHTML, /\+1.00/);
  h.hooks.renderCurve(curve({ status: 'stale', cache: 'stale' }));
  assert.doesNotMatch(h.elements.get('curveSummary').innerHTML, /\+1.00/);
  assert.match(h.elements.get('curveStatus').textContent, /过期报价/);
  h.hooks.renderCurve(curve({ spreads: { m1m2: 99, m1m3: 98 } }));
  assert.match(h.elements.get('curveSummary').innerHTML, /待核对/);
  h.hooks.renderCurve({ status: 'unavailable' });
  assert.match(h.elements.get('curveRows').innerHTML, /暂无/);
  assert.match(h.elements.get('curveStatus').textContent, /重试/);
});

test('curve switches clear old rows immediately, ignore obsolete responses and support retry', async () => {
  let resolveBrent, failWti = false;
  const h = harness(url => {
    if (url.includes('/api/market')) return response(payload());
    if (url.includes('instrument=brent')) return new Promise(resolve => { resolveBrent = resolve; });
    return failWti ? response({}, 503) : response(curve({ instrument: 'wti' }));
  });
  await h.ui.refresh();
  const button = h.controls['[data-curve-instrument]'][1];
  await button.click(); await flush();
  resolveBrent(response(curve())); await flush();
  assert.equal(h.hooks.state.curveSnapshot.instrument, 'wti');
  assert.equal(button.attributes['aria-pressed'], 'true');
  failWti = true; await h.elements.get('curveRefresh').click(); await flush();
  assert.match(h.elements.get('curveRows').innerHTML, /暂无/);
  assert.equal(h.elements.get('curveRefresh').disabled, false);
  failWti = false; await h.elements.get('curveRefresh').click(); await flush();
  assert.match(h.elements.get('curveSummary').innerHTML, /\+1.00/);
  h.ui.destroy();
});

test('age refresh reclassifies observations and destroy releases chart, observers, timers and handlers', () => {
  const h = harness(); h.ui.init(); h.ui.init(); h.ui.renderSnapshot(payload());
  assert.equal(h.intervals.size, 1);
  assert.equal(h.elements.get('marketRefresh').listeners.get('click').size, 1);
  h.advance(4000); h.tick();
  assert.match(h.elements.get('brentStatus').textContent, /数据过期/);
  assert.equal(h.elements.get('spreadValue').textContent, '—');
  assert.equal(h.charts[0].series.lines.size, 1);
  h.ui.destroy();
  assert.equal(h.charts[0].removed, true);
  assert.equal(h.observers[0].disconnected, true);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.elements.get('marketRefresh').listeners.get('click').size, 0);
});

test('spread provenance, timestamps and arithmetic are rejected before render or cache', () => {
  const mutations = {
    'wrong source': data => { data.spread.source = 'tradingview'; },
    'wrong Brent symbol': data => { data.spread.symbols.brent = 'OTHER'; },
    'wrong WTI symbol': data => { data.spread.symbols.wti = 'OTHER'; },
    'forged history value': data => { data.spread.series[0].value = 999; },
    'future history time': data => { data.spread.series[1].time = NOW + 86400; },
    'unmatched history time': data => { data.spread.series[0].time -= 1; },
    'duplicate history time': data => { data.spread.series[1] = { ...data.spread.series[0] }; },
    'missing history point': data => { data.spread.series.pop(); },
    'incorrect quote value': data => { data.spread.price = 999; },
    'incorrect quote time': data => { data.spread.priceAt += 1; },
    'missing provenance': data => { delete data.spread.symbols; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const h = harness(), data = payload(); mutate(data);
    assert.equal(h.hooks.validatePayload(data), false, name);
    h.hooks.writeCache(data);
    assert.equal(h.storage.size, 0, name + ' was cached');
    h.storage.set(h.hooks.CACHE_PREFIX + '1d', JSON.stringify({ storedAt: NOW * 1000, payload: data }));
    assert.equal(h.hooks.readCache(), null, name + ' was read from cache');
    h.ui.renderSnapshot(payload()); h.ui.selectInstrument('spread'); h.ui.renderSnapshot(data);
    assert.equal(h.elements.get('spreadValue').textContent, '—', name + ' retained quote');
    assert.equal(h.charts[0].series.data.length, 0, name + ' retained chart');
  }
});

test('spread history uses exact common leg timestamps and accepts floating point rounding only', () => {
  const h = harness(), data = payload();
  data.instruments.wti.series[0].time += 1; syncSpread(data);
  data.spread.series[0].value += 1e-10;
  assert.equal(h.hooks.validatePayload(data), true);
  h.ui.renderSnapshot(data); h.ui.selectInstrument('spread');
  assert.equal(h.charts[0].series.data.length, 1);
  assert.equal(h.charts[0].series.data[0].time, NOW - 20);
  assert.equal(h.charts[0].series.data[0].value, 6);
  // Even direct chart-data reads derive history from validated legs.
  data.spread.series[0].value = 999;
  assert.equal(h.hooks.chartData(data).points[0].value, 6);
});

test('curve rejects wrong instruments, malformed or expired contracts, duplicates and bad ordering as a whole', () => {
  const mutations = {
    'wrong selected instrument': data => { data.instrument = 'wti'; },
    'wrong symbol root': data => { data.contracts[0].symbol = 'NYMEX:CLF2027'; },
    'unanchored symbol root': data => { data.contracts[0].symbol = 'ICEEUR:BRNXXXF2027'; },
    'invalid month and day': data => { data.contracts[0].expiration = '2026-99-99'; },
    'nonexistent calendar date': data => { data.contracts[0].expiration = '2027-02-31'; },
    'expired contract': data => { data.contracts[0].expiration = '2026-11-24'; },
    'delivery month mismatch': data => { data.contracts[0].deliveryMonth = '2027-02'; },
    'wrong provider': data => { data.source = data.contracts[0].source = 'yahoo'; },
    'cross-provider contract': data => { data.contracts[0].source = 'yahoo'; },
    'wrong currency': data => { data.contracts[0].currency = 'EUR'; },
    'wrong exchange': data => { data.contracts[0].exchange = 'NYMEX'; },
    'duplicate contract': data => { data.contracts[1] = { ...data.contracts[0] }; },
    'descending expiration': data => { [data.contracts[0], data.contracts[1]] = [data.contracts[1], data.contracts[0]]; },
    'duplicate expiration': data => { data.contracts[1].expiration = data.contracts[0].expiration; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const h = harness(), data = curve(); h.hooks.renderCurve(data); mutate(data); h.hooks.renderCurve(data);
    assert.match(h.elements.get('curveRows').innerHTML, /暂无/, name);
    assert.doesNotMatch(h.elements.get('curveRows').innerHTML, /ICEEUR|NYMEX|2026-99-99/, name);
    assert.equal(h.elements.get('curveSummary').innerHTML, '<span>近远月价差待核对</span>', name);
    assert.doesNotMatch(h.elements.get('curveStatus').textContent, /已核对|月差按源更新时间对齐/, name);
  }
  const h = harness(); h.hooks.state.curveInstrument = 'wti';
  h.hooks.renderCurve({ ...curve(), instrument: 'wti' });
  assert.match(h.elements.get('curveRows').innerHTML, /暂无/);
  h.hooks.renderCurve(curve({ instrument: 'wti' }));
  assert.match(h.elements.get('curveRows').innerHTML, /NYMEX:CLF2027/);
  assert.match(h.elements.get('curveSummary').innerHTML, /\+1.00/);
});

test('curve expiration follows the current instrument trading date across NY18:00 and DST', () => {
  for (const [before, after, expiration, symbol, deliveryMonth] of [
    ['2026-11-25T22:59:59Z', '2026-11-25T23:00:00Z', '2026-11-25', 'NYMEX:CLZ2026', '2026-12'],
    ['2026-07-23T21:59:59Z', '2026-07-23T22:00:00Z', '2026-07-23', 'NYMEX:CLQ2026', '2026-08'],
  ]) {
    const h = harness(); h.hooks.state.curveInstrument = 'wti';
    const data = curve({ instrument: 'wti' }); Object.assign(data.contracts[0], { symbol, deliveryMonth, expiration });
    const beforeSec = Date.parse(before) / 1000; h.advance(beforeSec - NOW);
    for (const item of data.contracts) { item.providerUpdatedAt = beforeSec - 20; item.fetchedAt = beforeSec; }
    h.hooks.renderCurve(data);
    assert.match(h.elements.get('curveRows').innerHTML, new RegExp(symbol), before);
    h.advance((Date.parse(after) - Date.parse(before)) / 1000);
    h.hooks.renderCurve(data);
    assert.match(h.elements.get('curveRows').innerHTML, /暂无/, after);
    assert.equal(h.elements.get('curveSummary').innerHTML, '<span>近远月价差待核对</span>');
  }
  // At the same UTC boundary, London still uses its own current trading date.
  const brent = harness(), at = Date.parse('2026-11-25T23:00:00Z') / 1000;
  brent.advance(at - NOW); const data = curve();
  Object.assign(data.contracts[0], { symbol: 'ICEEUR:BRNZ2026', deliveryMonth: '2026-12', expiration: '2026-11-25' });
  for (const item of data.contracts) { item.providerUpdatedAt = at - 20; item.fetchedAt = at; }
  brent.hooks.renderCurve(data);
  assert.match(brent.elements.get('curveRows').innerHTML, /ICEEUR:BRNZ2026/);
});

test('event markers use existing successor bars only, group duplicate bars and preserve price history', () => {
  const h = harness(); h.ui.renderSnapshot(payload());
  const initial = clone(h.charts[0].series.data);
  const event = (title, publishedAt, link = 'https://news.test/' + encodeURIComponent(title)) => ({ title, publishedAt, link });
  const match = event('EIA inventory release', NOW - 40);
  h.ui.setEvents([
    match, match, event('Oil supply update', NOW - 35), event('First observation', NOW - 320),
    event('Too far before first bar', NOW - 320 - 1801), event('After last quote', NOW - 10),
    event('Not yet published', NOW + 20), event('Unsafe link', NOW - 40, 'javascript:alert(1)'),
  ]);
  assert.deepEqual(h.charts[0].series.data, initial);
  assert.deepEqual(h.markerPlugins[0].values.map(item => [item.time, item.text]), [[NOW - 320, '事件'], [NOW - 20, '事件 ×2']]);
  assert.match(h.elements.get('chartBasis').textContent, /事件按发布时间标记/);
  assert.match(h.elements.get('chartDescription').textContent, /EIA inventory release.*Oil supply update/);
  assert.match(h.elements.get('chartEventList').innerHTML, /https:\/\/news.test\/EIA/);
  assert.doesNotMatch(h.elements.get('chartEventList').innerHTML, /Too far|After last|Not yet|javascript:/);
  assert.equal(h.elements.get('chartEvents').hidden, false);
});

test('event marker primitives update once per chart, detach on instrument/no-history changes and destroy', () => {
  const h = harness(); h.ui.renderSnapshot(payload());
  const events = [{ title: 'Published news', link: 'https://news.test/item', publishedAt: NOW - 30 }];
  h.ui.setEvents(events); h.ui.setEvents(events);
  assert.equal(h.markerPlugins.length, 1);
  assert.equal(h.markerPlugins[0].updates, 1);
  h.ui.selectInstrument('wti');
  assert.equal(h.markerPlugins[0].detached, true);
  assert.equal(h.markerPlugins[0].values.length, 0);
  assert.equal(h.markerPlugins.length, 2);
  h.ui.selectInstrument('spread');
  assert.equal(h.markerPlugins[1].detached, true);
  assert.equal(h.elements.get('chartEvents').hidden, true);
  assert.doesNotMatch(h.elements.get('chartBasis').textContent, /事件按发布时间标记/);
  h.ui.selectInstrument('brent');
  const plugin = h.markerPlugins.at(-1);
  h.ui.setEvents([]);
  assert.equal(plugin.detached, true);
  assert.equal(plugin.values.length, 0);
  h.ui.setEvents(events); h.ui.destroy();
  assert.equal(h.markerPlugins.at(-1).detached, true);
  assert.equal(h.markerPlugins.at(-1).values.length, 0);
});

test('events without verified matching source history never create chart markers', () => {
  const h = harness(), data = payload();
  data.instruments.brent.historySource = null; data.instruments.brent.historySymbol = null;
  syncSpread(data);
  h.ui.renderSnapshot(data);
  assert.equal(h.charts[0].series.data.length, 2);
  h.ui.setEvents([{ title: 'Published news', link: 'https://news.test/item', publishedAt: NOW - 30 }]);
  assert.equal(h.markerPlugins.length, 0);
  assert.equal(h.elements.get('chartEvents').hidden, true);
});
