import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import '../shared/market-core.js';

const M = globalThis.OilMarket;
const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/market/november-2026.json', import.meta.url), 'utf8'));
const ny = M.SESSION_CONFIGS.NYMEX_ENERGY;
const london = M.SESSION_CONFIGS.ICE_BRENT;
const ts = value => Date.parse(value) / 1000;
const now = ts('2026-11-25T14:00:00+08:00');

function quote(symbol = 'BZ=F', at = now, price = 89.73, previousClose = 88.78) {
  return { meta: { symbol, regularMarketTime: at, regularMarketPrice: price, previousClose,
    chartPreviousClose: previousClose, range: '1d', dataGranularity: '1m', exchangeTimezoneName: 'America/New_York' } };
}

function daily(symbol, closes = [87, 88.78, 89.73]) {
  return { meta: { symbol, exchangeTimezoneName: 'America/New_York', range: '1mo', chartPreviousClose: 115.81 },
    timestamp: ['2026-11-23T00:00:00-05:00', '2026-11-24T00:00:00-05:00', '2026-11-25T00:00:00-05:00'].map(ts),
    indicators: { quote: [{ close: closes }] } };
}

function yahoo(overrides = {}) {
  return M.normalizeYahooSnapshot({ instrument: 'brent', symbol: 'BZ=F', contract: 'continuous-front-month', exchange: 'NYMEX',
    quoteRaw: quote(), dailyRaw: daily('BZ=F'), now, sessionConfig: ny, ...overrides });
}

test('New York 18:00 begins the next trading date without waiting for midnight', () => {
  assert.equal(M.getTradingDate(ts('2026-11-24T17:59:00-05:00'), ny), '2026-11-24');
  assert.equal(M.getTradingDate(ts('2026-11-24T18:00:00-05:00'), ny), '2026-11-25');
  for (const at of ['2026-11-25T09:00:00+08:00', '2026-11-25T14:00:00+08:00']) {
    assert.equal(M.getTradingDate(ts(at), ny), '2026-11-25');
  }
});

test('IANA zones follow summer time and the actual DST transition', () => {
  assert.equal(M.getTradingDate(ts('2026-07-22T18:00:00-04:00'), ny), '2026-07-23');
  assert.equal(M.getTradingDate(ts('2026-07-23T06:00:00+08:00'), ny), '2026-07-23');
  assert.equal(M.getTradingDate(ts('2026-11-01T18:00:00-05:00'), ny), '2026-11-02');
  assert.equal(M.getTradingDate(ts('2026-11-02T06:59:00+08:00'), ny), null);
});

test('London Brent hours are a separate session configuration', () => {
  assert.equal(M.getSessionState(ts('2026-11-25T00:30:00Z'), london).state, 'closed');
  assert.equal(M.getSessionState(ts('2026-11-25T00:30:00Z'), ny).state, 'unknown');
  assert.equal(M.getTradingDate(ts('2026-11-25T01:00:00Z'), london), '2026-11-25');
  assert.equal(M.getSessionState(ts('2026-07-22T23:30:00Z'), london).state, 'closed');
  assert.equal(M.getSessionState(now, {}).state, 'unknown');
});

test('weekends and daily maintenance have explicit boundaries', () => {
  assert.equal(M.getSessionState(ts('2026-11-27T18:00:00-05:00'), ny).state, 'closed');
  assert.equal(M.getTradingDate(ts('2026-11-29T18:00:00-05:00'), ny), '2026-11-30');
  assert.equal(M.getSessionState(ts('2026-11-25T17:00:00-05:00'), ny).state, 'maintenance');
  assert.equal(M.getSessionState(ts('2026-11-25T18:00:00-05:00'), ny).state, 'unknown');
});

test('holiday calendars, early closes, and incomplete coverage remain explicit', () => {
  const cfg = { ...ny, calendar: { from: '2026-11-01', to: '2026-11-30', closedDates: ['2026-11-26'], earlyCloses: { '2026-11-27': 13 } } };
  assert.equal(M.getSessionState(ts('2026-11-25T18:00:00-05:00'), cfg).reason, 'holiday');
  assert.equal(M.getTradingDate(ts('2026-11-26T10:00:00-05:00'), cfg), null);
  assert.equal(M.getSessionState(ts('2026-11-27T13:00:00-05:00'), cfg).reason, 'early-close');
  assert.equal(M.getSessionState(ts('2026-11-25T10:00:00-05:00'), cfg).state, 'open');
  assert.equal(M.getSessionState(ts('2026-12-01T10:00:00-05:00'), cfg).state, 'unknown');
});

test('Singapore morning and afternoon use the same completed prior daily close', () => {
  const f = fixture.morningAfternoon;
  const raw = { meta: { symbol: f.symbol, exchangeTimezoneName: 'America/New_York' },
    timestamps: f.dailyDates.map(ts), closes: f.dailyCloses };
  const snapshots = [f.morning, f.afternoon].map(at => yahoo({ symbol: f.symbol,
    quoteRaw: quote(f.symbol, ts(at), f.price, f.previousClose), dailyRaw: raw, now: ts(at) }));
  for (const s of snapshots) {
    assert.equal(s.tradingDate, '2026-11-25');
    assert.ok(Math.abs(s.reference.price - 91.4) < 1e-5);
    assert.equal(s.reference.type, 'previous-close');
    assert.equal(s.reference.basis, 'daily-close');
    assert.equal(s.reference.date, '2026-11-24');
    assert.ok(Math.abs(s.change - 1.96) < 1e-5);
    assert.ok(Math.abs(s.changePercent - 2.14442013) < 1e-5);
  }
});

test('daily baseline advances at the exchange session boundary, not Singapore midnight', () => {
  const dailyRaw = daily('BZ=F', [87, 88.78, 89.73]);
  const before = ts('2026-11-25T06:59:00+08:00');
  const after = ts('2026-11-25T07:00:00+08:00');
  const priorSession = yahoo({ quoteRaw: quote('BZ=F', before), dailyRaw, now: before });
  const nextSession = yahoo({ quoteRaw: quote('BZ=F', after), dailyRaw, now: after });
  assert.equal(priorSession.tradingDate, '2026-11-24');
  assert.equal(priorSession.reference.date, '2026-11-23');
  assert.equal(nextSession.tradingDate, '2026-11-25');
  assert.equal(nextSession.reference.date, '2026-11-24');
});

test('daily close controls change even when quote previousClose differs around a continuous roll', () => {
  const f = fixture.continuousRangeReference;
  const s = yahoo({ dailyRaw: daily(f.symbol, [87, f.previousDailyClose, f.price]) });
  assert.equal(s.reference.price, f.previousDailyClose);
  assert.equal(s.reference.date, '2026-11-24');
  assert.ok(Math.abs(s.change - (f.price - f.previousDailyClose)) < 1e-9);
  assert.notEqual(s.reference.price, f.monthlyChartPreviousClose);
  assert.notEqual(s.reference.price, f.quotePreviousClose);
});

test('quote previousClose and monthly chartPreviousClose cannot replace missing daily history', () => {
  const q = quote();
  const s = yahoo({ quoteRaw: q, dailyRaw: null });
  assert.equal(s.price, 89.73);
  assert.equal(s.reference, null);
  assert.equal(s.change, null);
  assert.equal(s.changePercent, null);
});

test('holiday reference dates come from actual bars, not subtracting one calendar day', () => {
  const q = quote('BZ=F', ts('2026-12-28T12:00:00-05:00'));
  const s = yahoo({ now: q.meta.regularMarketTime, quoteRaw: q, dailyRaw: {
    meta: { symbol: 'BZ=F', exchangeTimezoneName: 'America/New_York' },
    timestamp: [ts('2026-12-24T00:00:00-05:00')], indicators: { quote: [{ close: [88.78] }] },
  } });
  assert.equal(s.reference.date, '2026-12-24');
  assert.equal(s.reference.type, 'previous-close');
  assert.equal(s.reference.basis, 'daily-close');
});

test('other-source or other-contract daily data never supplies a reference or history', () => {
  const s = yahoo({ dailyRaw: daily('BZF27.NYM'), historyRaw: daily('CL=F') });
  assert.equal(s.reference, null);
  assert.equal(s.change, null);
  assert.equal(s.changePercent, null);
  assert.deepEqual(s.series, []);
  assert.equal(yahoo({ quoteRaw: quote('CL=F') }).price, null);
  assert.equal(yahoo({ quoteRaw: { ...quote(), source: 'tradingview' } }).status, 'unavailable');
  const unidentified = daily('BZ=F');
  delete unidentified.meta.symbol;
  assert.equal(yahoo({ dailyRaw: unidentified }).reference, null);
});

test('TV provider change is suppressed without a same-symbol completed daily close', () => {
  const s = M.normalizeTVSnapshot({ instrument: 'brent', symbol: 'ICEEUR:BRN1!', exchange: 'ICE', now, sessionConfig: london,
    raw: { symbol: 'ICEEUR:BRN1!', price: 89.73, changeAbs: 0.95, changePercent: 1.07,
      last_bar_update_time: now - 5, update_mode: 'delayed_streaming_600' } });
  assert.equal(s.priceAt, null);
  assert.equal(s.providerUpdatedAt, now - 5);
  assert.equal(s.timeBasis, 'provider-update');
  assert.equal(s.status, 'delayed');
  assert.equal(s.reference, null);
  assert.equal(s.change, null);
  assert.equal(s.changePercent, null);
  assert.equal(M.validateSnapshot(s).valid, true);
});

test('TV without a source update time never uses fetchedAt or an ambiguous priceAt as proof', () => {
  const s = M.normalizeTVSnapshot({ instrument: 'brent', symbol: 'ICEEUR:BRN1!', now,
    raw: { symbol: 'ICEEUR:BRN1!', price: 89.73, priceAt: now, fetchedAt: now } });
  assert.equal(s.price, 89.73);
  assert.equal(s.priceAt, null);
  assert.equal(s.providerUpdatedAt, null);
  assert.equal(s.status, 'unavailable');
});

test('freshness follows source timestamps and declared delay, not recent HTTP fetches', () => {
  const s = yahoo();
  assert.equal(s.status, 'fresh');
  assert.equal(M.classifyFreshness(s, now + 121), 'delayed');
  assert.equal(M.classifyFreshness({ ...s, fetchedAt: now + 3600 }, now + 3600), 'stale');
  assert.equal(M.classifyFreshness({ ...s, delaySeconds: 600 }, now), 'delayed');
  assert.equal(M.classifyFreshness({ ...s, delaySeconds: 600 }, now + 1500), 'delayed');
  assert.equal(M.classifyFreshness({ ...s, delaySeconds: 600 }, now + 1801), 'stale');
  assert.equal(M.classifyFreshness({ ...s, priceAt: now + 121 }, now), 'unavailable');
});

test('closed-session quotes stay closed for a bounded period, not falsely live or indefinitely current', () => {
  const s = { ...yahoo(), marketState: 'closed' };
  assert.equal(M.classifyFreshness(s, now + 2 * 86400), 'closed');
  assert.equal(M.classifyFreshness(s, now + 5 * 86400), 'stale');
});

test('null, blank, boolean, and nonfinite prices do not become fabricated zero quotes', () => {
  for (const price of [null, '', false, NaN, Infinity, 'NaN']) {
    const s = yahoo({ quoteRaw: quote('BZ=F', now, price) });
    assert.equal(s.price, null);
    assert.equal(s.status, 'unavailable');
    assert.equal(s.change, null);
  }
  assert.equal(yahoo({ quoteRaw: quote('BZ=F', now, 0, 0) }).changePercent, null);
});

test('cache validation rejects corrupted identity, source/reference mismatch, invalid dates and NaN', () => {
  const s = JSON.parse(JSON.stringify(yahoo()));
  assert.equal(M.validateSnapshot(s, { instrument: 'brent', symbol: 'BZ=F', source: 'yahoo' }).valid, true);
  assert.equal(M.validateSnapshot(s, { symbol: 'CL=F' }).valid, false);
  assert.equal(M.validateSnapshot({ ...s, reference: { ...s.reference, source: 'tradingview' } }).valid, false);
  assert.equal(M.validateSnapshot({ ...s, reference: { ...s.reference, basis: undefined } }).valid, false);
  assert.equal(M.validateSnapshot({ ...s, reference: { ...s.reference, symbol: 'BZF27.NYM' } }).valid, false);
  assert.equal(M.validateSnapshot({ ...s, price: NaN }).valid, false);
  assert.equal(M.validateSnapshot({ ...s, changePercent: 1234 }).valid, false);
  assert.equal(M.validateSnapshot({ ...s, tradingDate: '2026-99-99' }).valid, false);
  assert.equal(M.validateSnapshot(s, { now: now + 3600, maxAgeSeconds: 1200 }).valid, false);
});

test('aligned spread requires same-source valid legs and comparable actual market times', () => {
  const b = yahoo();
  const w = yahoo({ instrument: 'wti', symbol: 'CL=F', quoteRaw: quote('CL=F', now - 60, 80, 79), dailyRaw: null });
  const spread = M.alignSpread(b, w, { now });
  assert.ok(Math.abs(spread.price - 9.73) < 1e-9);
  assert.equal(spread.priceAt, now - 60);
  assert.equal(spread.status, 'fresh');
  assert.equal(M.alignSpread(b, { ...w, priceAt: now - 301 }, { now }).reason, 'time-mismatch');
  assert.equal(M.alignSpread(b, { ...w, currency: 'EUR' }, { now }).reason, 'currency-mismatch');
  const otherSource = { ...w, source: 'tradingview', reference: { price: 79, date: '2026-11-24', type: 'previous-close', basis: 'daily-close', source: 'tradingview', symbol: 'CL=F' }, change: 1, changePercent: 100 / 79 };
  assert.equal(M.alignSpread(b, otherSource, { now }).reason, 'source-mismatch');
  assert.equal(M.alignSpread(b, w, { now: now + 3600 }).reason, 'stale-leg');
});

test('provider-update timestamps cannot masquerade as aligned trade times', () => {
  const tv = instrument => M.normalizeTVSnapshot({ instrument, symbol: instrument, now,
    raw: { symbol: instrument, price: 80, providerUpdatedAt: now, changeAbs: 1, delaySeconds: 600 } });
  assert.equal(M.alignSpread(tv('brent'), tv('wti'), { now }).price, null);
});

test('history drops null/NaN/future points and sorts and deduplicates timestamps', () => {
  const s = yahoo({ historyRaw: { meta: { symbol: 'BZ=F' }, timestamps: [now, now - 10, now - 10, now + 60, now - 20, now - 30],
    closes: [89.73, 89.6, 89.7, 99, null, NaN] } });
  assert.deepEqual(s.series, [{ time: now - 10, value: 89.7 }, { time: now, value: 89.73 }]);
  assert.equal(M.validateSnapshot(s).valid, true);
});
