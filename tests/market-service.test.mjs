import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarketService, marketServiceTestHooks } from '../workers/market-service.js';
import { createProxy } from '../workers/proxy.js';

const NOW = Date.parse('2026-11-25T15:00:00Z') / 1000;
const { SCANNER_COLUMNS } = marketServiceTestHooks;

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

function chart(symbol, range, interval, now = NOW) {
  const price = symbol === 'BZ=F' ? 89.73 : 83.11;
  const previous = symbol === 'BZ=F' ? 88.78 : 82.05;
  const daily = interval === '1d';
  return {
    chart: { result: [{
      meta: {
        symbol, currency: 'USD', exchangeName: 'NYM', exchangeTimezoneName: 'America/New_York',
        shortName: symbol === 'BZ=F' ? 'Brent Crude Oil Last Day Financial' : 'Crude Oil Jan 27',
        regularMarketPrice: price, regularMarketTime: now - 20,
        // The one-month range boundary is deliberately unrelated to yesterday's base.
        chartPreviousClose: range === '1mo' ? 110.74 : previous,
        ...(range === '1d' ? { previousClose: previous } : {}),
        currentTradingPeriod: { regular: { start: Date.parse('2026-11-25T05:00:00Z') / 1000 } },
      },
      timestamp: daily
        ? [Date.parse('2026-11-24T05:00:00Z') / 1000, Date.parse('2026-11-25T05:00:00Z') / 1000]
        : [now - 320, now - 20],
      indicators: { quote: [{ close: daily ? [previous, price] : [price - 0.1, price] }] },
    }], error: null },
  };
}

function scannerRow(symbol, values = {}) {
  const fields = {
    name: symbol.split(':')[1], description: symbol, close: 90, change: 1.12,
    change_abs: 1, update_mode: 'delayed_streaming_600', last_bar_update_time: NOW - 25,
    currency: 'USD', current_session: 'market', ...values,
  };
  return { s: symbol, d: SCANNER_COLUMNS.map(column => fields[column] ?? null) };
}

function mockYahoo({ failQuote = false, wrongSymbol = false } = {}) {
  return async (url, options) => {
    assert.equal(options.redirect, 'manual');
    if (String(url).includes('scanner.tradingview.com')) {
      const body = JSON.parse(options.body);
      const rows = (body.symbols?.tickers || []).map(symbol => scannerRow(symbol));
      return response({ data: rows });
    }
    const parsed = new URL(url);
    const symbol = decodeURIComponent(parsed.pathname.split('/').at(-1));
    const range = parsed.searchParams.get('range');
    const interval = parsed.searchParams.get('interval');
    if (failQuote && interval === '1m') return response({}, 503);
    return response(chart(wrongSymbol && interval === '1m' ? 'OTHER' : symbol, range, interval));
  };
}

test('market returns final same-symbol quotes, prior daily closes and matched history', async () => {
  const handle = createMarketService({ fetchImpl: mockYahoo(), now: () => NOW });
  const result = await handle(new Request('https://worker.test/api/market?range=5d'));
  assert.equal(result.status, 200);
  const data = await result.json();
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.instruments.brent.symbol, 'BZ=F');
  assert.equal(data.instruments.brent.reference.price, 88.78);
  assert.equal(data.instruments.brent.reference.date, '2026-11-24');
  assert.equal(data.instruments.brent.reference.type, 'previous-close');
  assert.equal(data.instruments.brent.reference.basis, 'daily-close');
  assert.equal(data.instruments.brent.historySymbol, 'BZ=F');
  assert.equal(data.instruments.brent.series.length, 2);
  assert.equal(data.instruments.wti.symbol, 'CL=F');
  assert.ok(Math.abs(data.spread.price - 6.62) < 1e-8);
  assert.equal(data.spread.series.length, 2);
  assert.deepEqual(data.spread.symbols, { brent: 'BZ=F', wti: 'CL=F' });
  assert.equal(data.spread.series[0].time, NOW - 320);
  assert.equal(data.provenance.referencePolicy, 'previous-completed-daily-bar-exact-symbol');
  assert.equal(data.instruments.brent.historyWarning, 'continuous-series-may-contain-roll-gap');
});

test('1d history keeps the full exchange trading session including Singapore morning', async () => {
  const priorSession = Date.parse('2026-11-24T21:00:00Z') / 1000; // NY 16:00, trading date 11/24.
  const asiaMorning = Date.parse('2026-11-25T01:00:00Z') / 1000; // SGT09, NY20:00, trading date 11/25.
  const nyAfterMidnight = Date.parse('2026-11-25T05:05:00Z') / 1000;
  const handle = createMarketService({ now: () => NOW, fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'manual');
    const parsed = new URL(url);
    const symbol = decodeURIComponent(parsed.pathname.split('/').at(-1));
    const range = parsed.searchParams.get('range'), interval = parsed.searchParams.get('interval');
    const payload = chart(symbol, range, interval);
    if (interval === '5m') {
      assert.equal(range, '5d');
      const result = payload.chart.result[0];
      result.timestamp = [priorSession, asiaMorning, nyAfterMidnight, NOW - 20];
      result.indicators.quote[0].close = [88, 89, 90, 89.73];
    }
    return response(payload);
  } });
  const data = await (await handle(new Request('https://worker.test/api/market?range=1d'))).json();
  assert.deepEqual(data.instruments.brent.series.map(point => point.time), [asiaMorning, nyAfterMidnight, NOW - 20]);
});

test('upstream redirects are rejected in workerd-compatible manual mode', async () => {
  let calls = 0;
  const handle = createMarketService({ now: () => NOW, fetchImpl: async (url, options) => {
    calls += 1;
    assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1' } });
  } });
  const result = await handle(new Request('https://worker.test/api/market'));
  assert.equal(result.status, 503);
  assert.equal(calls, 7); // Six concurrent Yahoo reads and one independent scanner request; no redirects followed.
});

test('independent TradingView fallback carries its own basis and provider update time without Yahoo history', async () => {
  const handle = createMarketService({ fetchImpl: mockYahoo({ failQuote: true }), now: () => NOW });
  const result = await handle(new Request('https://worker.test/api/market'));
  const data = await result.json();
  const brent = data.instruments.brent;
  assert.equal(brent.symbol, 'ICEEUR:BRN1!');
  assert.equal(brent.source, 'tradingview');
  assert.equal(brent.price, 90);
  assert.equal(brent.priceAt, null);
  assert.equal(brent.providerUpdatedAt, NOW - 25);
  assert.equal(brent.delaySeconds, 600);
  assert.equal(brent.status, 'delayed');
  assert.equal(brent.reference, null);
  assert.equal(brent.change, null);
  assert.equal(brent.changePercent, null);
  assert.deepEqual(brent.series, []);
  assert.equal(brent.historySource, null);
  assert.equal(data.spread.price, null);
  assert.deepEqual(data.spread.series, []);
});

test('a response for a different Yahoo symbol is rejected before normalization', async () => {
  const handle = createMarketService({ fetchImpl: mockYahoo({ wrongSymbol: true }), now: () => NOW });
  const data = await (await handle(new Request('https://worker.test/api/market'))).json();
  assert.equal(data.instruments.brent.source, 'tradingview');
  assert.equal(data.instruments.brent.symbol, 'ICEEUR:BRN1!');
});

test('bounded last-good cache retains original observation time during a complete upstream outage', async () => {
  let clock = NOW;
  let outage = false;
  let requests = 0;
  const goodFetch = mockYahoo();
  const handle = createMarketService({
    now: () => clock,
    fetchImpl: async (...args) => {
      requests += 1;
      return outage ? response({}, 503) : goodFetch(...args);
    },
  });
  const first = await (await handle(new Request('https://worker.test/api/market'))).json();
  const count = requests;
  clock += 20;
  const hit = await (await handle(new Request('https://worker.test/api/market'))).json();
  assert.equal(requests, count);
  assert.equal(hit.cache, 'hit');
  assert.equal(hit.instruments.brent.cached, undefined);
  clock += 50;
  outage = true;
  const stale = await (await handle(new Request('https://worker.test/api/market'))).json();
  assert.equal(stale.warning, 'upstream-unavailable-cached-observation');
  assert.equal(stale.cache, 'stale');
  assert.equal(stale.instruments.brent.cached, true);
  assert.equal(stale.generatedAt, first.generatedAt);
  assert.equal(stale.instruments.brent.priceAt, first.instruments.brent.priceAt);
  assert.equal(stale.instruments.brent.fetchedAt, first.instruments.brent.fetchedAt);
  clock = NOW + 1801;
  assert.equal((await handle(new Request('https://worker.test/api/market'))).status, 503);
});

test('verified expiration curve is ordered by actual expiry and never assumes the continuous front month', async () => {
  let scannerBody;
  const handle = createMarketService({ now: () => NOW, fetchImpl: async (url, options) => {
    scannerBody = JSON.parse(options.body);
    return response({ data: [
      scannerRow('ICEEUR:BRNH2027', { root: 'ICEEUR:BRN', close: 87.2, expiration: 20270129 }),
      scannerRow('ICEEUR:BRNF2027', { root: 'ICEEUR:BRN', close: 93.24, expiration: 20261130 }),
      scannerRow('ICEEUR:BRNG2027', { root: 'ICEEUR:BRN', close: 89.76, expiration: 20261230 }),
      scannerRow('NYMEX:CLF2027', { root: 'NYMEX:CL', close: 83.19, expiration: 20261221 }),
    ] });
  } });
  const data = await (await handle(new Request('https://worker.test/api/curve?instrument=brent'))).json();
  assert.equal(scannerBody.filter[0].right, 'ICEEUR:BRN');
  assert.deepEqual(data.contracts.map(item => item.deliveryMonth), ['2027-01', '2027-02', '2027-03']);
  assert.deepEqual(data.contracts.map(item => item.expiration), ['2026-11-30', '2026-12-30', '2027-01-29']);
  assert.equal(data.basis, 'nearest-unexpired-contracts');
  assert.equal(data.spreads.m1m2, 3.48);
  assert.equal(data.contracts[0].priceAt, null);
  assert.equal(data.contracts[0].providerUpdatedAt, NOW - 25);
  assert.equal(data.contracts[0].delaySeconds, 600);
});

test('curve suppresses spreads between observations with incompatible update times', async () => {
  const handle = createMarketService({ now: () => NOW, fetchImpl: async () => response({ data: [
    scannerRow('NYMEX:CLF2027', { root: 'NYMEX:CL', expiration: 20261221 }),
    scannerRow('NYMEX:CLG2027', { root: 'NYMEX:CL', expiration: 20270120, last_bar_update_time: NOW - 1000 }),
  ] }) });
  const data = await (await handle(new Request('https://worker.test/api/curve?instrument=wti'))).json();
  assert.equal(data.spreads.m1m2, null);
});

test('method, range and instrument validation makes no upstream requests', async () => {
  const handle = createMarketService({ now: () => NOW, fetchImpl: () => { throw new Error('must not fetch'); } });
  assert.equal((await handle(new Request('https://worker.test/api/market?range=2y'))).status, 400);
  assert.equal((await handle(new Request('https://worker.test/api/curve?instrument=gas'))).status, 400);
  assert.equal((await handle(new Request('https://worker.test/api/market', { method: 'POST' }))).status, 405);
  const health = await handle(new Request('https://worker.test/api/health'), { BUILD_SHA: 'abc123' });
  assert.equal((await health.json()).version, 'abc123');
  assert.equal((await handle(new Request('https://worker.test/api/health', { method: 'HEAD' }))).status, 200);
  assert.equal(await (await handle(new Request('https://worker.test/api/health', { method: 'HEAD' }))).text(), '');
  assert.equal(await handle(new Request('https://worker.test/other')), null);
});

test('expiration dates are real calendar dates', () => {
  assert.equal(marketServiceTestHooks.expirationDate(20260230), null);
  assert.equal(marketServiceTestHooks.expirationDate(20261221), '2026-12-21');
});

test('partial source outage preserves the failed leg with its original observation time', async () => {
  let clock = NOW;
  let brentOutage = false;
  const goodFetch = mockYahoo();
  const handle = createMarketService({ now: () => clock, fetchImpl: async (url, init) => {
    if (brentOutage && (String(url).includes('BZ%3DF') || String(url).includes('scanner.tradingview.com'))) return response({}, 503);
    return goodFetch(url, init);
  } });
  const first = await (await handle(new Request('https://worker.test/api/market'))).json();
  clock += 80;
  brentOutage = true;
  const next = await (await handle(new Request('https://worker.test/api/market'))).json();
  assert.equal(next.instruments.brent.cached, true);
  assert.equal(next.instruments.brent.fetchedAt, first.instruments.brent.fetchedAt);
  assert.equal(next.instruments.wti.cached, undefined);
  assert.equal(next.instruments.wti.fetchedAt, clock);
});

test('legacy proxy rejects credentials, non-HTTPS, custom ports and unapproved hosts before fetching', async () => {
  const proxy = createProxy({ service: async () => null, fetchImpl: async () => { throw new Error('must not fetch'); } });
  for (const target of [
    'http://query1.finance.yahoo.com/test', 'https://user:secret@query1.finance.yahoo.com/test',
    'https://query1.finance.yahoo.com:8443/test', 'https://127.0.0.1/test',
  ]) {
    const result = await proxy.fetch(new Request(`https://worker.test/?url=${encodeURIComponent(target)}`));
    assert.equal(result.status, 403);
    assert.equal(result.headers.get('Access-Control-Allow-Origin'), '*');
  }
});

test('legacy proxy refuses redirects and preserves content type for allowed successful sources', async () => {
  let redirected = true;
  const proxy = createProxy({ service: async () => null, fetchImpl: async (url, init) => {
    assert.equal(init.redirect, 'manual');
    return redirected ? new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1' } })
      : new Response('<rss/>', { headers: { 'Content-Type': 'application/rss+xml' } });
  } });
  const request = () => new Request('https://worker.test/?url=https%3A%2F%2Fnews.google.com%2Frss');
  assert.equal((await proxy.fetch(request())).status, 502);
  redirected = false;
  const result = await proxy.fetch(request());
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('Content-Type'), 'application/rss+xml');
  assert.equal(await result.text(), '<rss/>');
});

test('legacy TradingView endpoint keeps price and update metadata on the same exact row', async () => {
  const proxy = createProxy({ service: async () => null, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.symbols.tickers, ['ICEEUR:BRN1!']);
    return response({ data: [
      { s: 'OTHER:BRENT', d: [99, 9, 9, NOW, 'streaming'] },
      { s: 'ICEEUR:BRN1!', d: [89.7, 1.03, 0.92, NOW - 30, 'delayed_streaming_600'] },
    ] });
  } });
  const data = await (await proxy.fetch(new Request('https://worker.test/?tvsymbol=brent'))).json();
  assert.equal(data.symbol, 'ICEEUR:BRN1!');
  assert.equal(data.price, 89.7);
  assert.equal(data.providerUpdatedAt, NOW - 30);
  assert.equal(data.priceAt, null);
  assert.equal(data.barTime, null);
  assert.equal(data.delaySeconds, 600);
});

test('calendar route is compatible with API method and error behavior', async () => {
  const proxy = createProxy({ service: async () => null, calendar: async () => ({ schemaVersion: 1, events: [] }) });
  const get = await proxy.fetch(new Request('https://worker.test/api/calendar'));
  assert.deepEqual(await get.json(), { schemaVersion: 1, events: [] });
  assert.equal((await proxy.fetch(new Request('https://worker.test/api/calendar', { method: 'POST' }))).status, 405);
  const failing = createProxy({ service: async () => null, calendar: async () => { throw new Error('upstream down'); } });
  assert.equal((await failing.fetch(new Request('https://worker.test/api/calendar'))).status, 503);
});
