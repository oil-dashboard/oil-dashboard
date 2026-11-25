import '../shared/market-core.js';

const API_VERSION = 'market-v1';
const YAHOO_HOST = 'https://query1.finance.yahoo.com';
const TV_SCANNER = 'https://scanner.tradingview.com/futures/scan';
const RANGES = Object.freeze({
  // A NY-midnight Yahoo range=1d omits the Asian part of a futures session.
  // Fetch enough bars, then keep the quote's exchange trading date below.
  '1d': { range: '5d', interval: '5m' },
  '5d': { range: '5d', interval: '15m' },
  '1mo': { range: '1mo', interval: '60m' },
});
const INSTRUMENTS = Object.freeze({
  brent: { yahoo: 'BZ=F', tv: 'ICEEUR:BRN1!', root: 'ICEEUR:BRN', exchange: 'NYMEX', tvExchange: 'ICE Futures Europe', name: 'Brent' },
  wti: { yahoo: 'CL=F', tv: 'NYMEX:CL1!', root: 'NYMEX:CL', exchange: 'NYMEX', tvExchange: 'NYMEX', name: 'WTI' },
});
const SCANNER_COLUMNS = Object.freeze([
  'name', 'description', 'close', 'change', 'change_abs', 'update_mode',
  'last_bar_update_time', 'expiration', 'root', 'volume', 'timezone', 'currency', 'current_session',
]);

function finite(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
}

function readChart(payload, symbol) {
  const result = payload?.chart?.result?.[0];
  if (!result?.meta || result.meta.symbol !== symbol) throw new Error('invalid-instrument-response');
  return result;
}

function unavailable(instrument, now, reason = 'source-unavailable') {
  const config = INSTRUMENTS[instrument];
  return {
    instrument, symbol: config.yahoo, contract: 'continuous-front', exchange: config.exchange,
    currency: 'USD', source: 'yahoo', price: null, priceAt: null, fetchedAt: now,
    tradingDate: null, reference: null, change: null, changePercent: null,
    status: 'unavailable', marketState: 'unknown', series: [], reason,
  };
}

function dateKey(now, timeZone = 'America/New_York') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now * 1000));
}

function curveDate(instrument, now) {
  const session = globalThis.OilMarket.SESSION_CONFIGS[instrument === 'brent' ? 'ICE_BRENT' : 'NYMEX_ENERGY'];
  return globalThis.OilMarket.getTradingDate(now, session) || dateKey(now, session.timeZone);
}

function expirationDate(value) {
  const text = String(value ?? '');
  if (!/^\d{8}$/.test(text)) return null;
  const date = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
}

function deliveryMonth(symbol) {
  const match = /([FGHJKMNQUVXZ])(\d{4})$/.exec(symbol || '');
  if (!match) return null;
  const month = 'FGHJKMNQUVXZ'.indexOf(match[1]) + 1;
  return `${match[2]}-${String(month).padStart(2, '0')}`;
}

function scannerRows(payload) {
  if (!Array.isArray(payload?.data)) throw new Error('invalid-scanner-response');
  return payload.data.filter(row => typeof row?.s === 'string' && Array.isArray(row.d)).map(row => ({
    symbol: row.s,
    ...Object.fromEntries(SCANNER_COLUMNS.map((key, index) => [key, row.d[index]])),
  }));
}

function delaySeconds(updateMode) {
  const match = /^delayed_streaming_(\d+)$/.exec(updateMode || '');
  return match ? Number(match[1]) : null;
}

function marketSpread(instruments, now) {
  const { brent, wti } = instruments;
  const spread = globalThis.OilMarket.alignSpread(brent, wti, { now });
  spread.series = [];
  spread.source = brent?.source === wti?.source ? brent.source : null;
  spread.symbols = { brent: brent?.symbol || null, wti: wti?.symbol || null };
  if (brent?.source !== wti?.source || brent?.currency !== wti?.currency ||
      !Number.isFinite(brent?.priceAt) || !Number.isFinite(wti?.priceAt) ||
      brent.historySource !== brent.source || wti.historySource !== wti.source ||
      brent.historySymbol !== brent.symbol || wti.historySymbol !== wti.symbol) return spread;
  const wtiBars = new Map((wti.series || []).map(point => [point.time, point.value]));
  spread.series = (brent.series || []).filter(point => wtiBars.has(point.time))
    .map(point => ({ time: point.time, value: point.value - wtiBars.get(point.time) }));
  return spread;
}

function reclassify(payload, now, outage = false) {
  const next = structuredClone(payload);
  if (next.instruments) {
    for (const snapshot of Object.values(next.instruments)) {
      snapshot.status = globalThis.OilMarket.classifyFreshness(snapshot, now);
      if (outage) snapshot.cached = true;
    }
    next.spread = marketSpread(next.instruments, now);
  }
  next.cache = outage ? 'stale' : 'hit';
  return next;
}

function curveDifference(left, right) {
  if (!left || !right || !Number.isFinite(left.price) || !Number.isFinite(right.price) ||
      !Number.isFinite(left.providerUpdatedAt) || !Number.isFinite(right.providerUpdatedAt) ||
      !['fresh', 'delayed'].includes(left.status) || !['fresh', 'delayed'].includes(right.status) ||
      Math.abs(left.providerUpdatedAt - right.providerUpdatedAt) > 300 ||
      left.delaySeconds !== right.delaySeconds || left.currency !== right.currency) return null;
  return Number((left.price - right.price).toFixed(4));
}

function reclassifyCurve(payload, now, outage = false) {
  const next = structuredClone(payload);
  for (const row of next.contracts || []) {
    row.status = globalThis.OilMarket.classifyFreshness({ ...row, marketState: 'unknown' }, now);
  }
  next.spreads = {
    m1m2: outage ? null : curveDifference(next.contracts?.[0], next.contracts?.[1]),
    m1m3: outage ? null : curveDifference(next.contracts?.[0], next.contracts?.[2]),
  };
  next.cache = outage ? 'stale' : 'hit';
  if (outage) next.status = 'stale';
  return next;
}

export function createMarketService({ fetchImpl = globalThis.fetch, now = () => Date.now() / 1000, cacheStorage } = {}) {
  const memory = new Map();

  async function requestJson(url, init = {}) {
    const response = await fetchImpl(url, {
      ...init,
      // workerd intentionally supports follow/manual only. Non-2xx, including
      // redirects, are rejected below without following a different origin.
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', ...init.headers },
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) throw new Error(`upstream-http-${response.status}`);
    return response.json();
  }

  async function yahoo(symbol, range, interval) {
    const url = new URL(`/v8/finance/chart/${encodeURIComponent(symbol)}`, YAHOO_HOST);
    url.searchParams.set('range', range);
    url.searchParams.set('interval', interval);
    return readChart(await requestJson(url.href), symbol);
  }

  async function scanner(body) {
    return scannerRows(await requestJson(TV_SCANNER, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, columns: SCANNER_COLUMNS }),
    }));
  }

  async function readCache(key) {
    const local = memory.get(key);
    if (local) return local;
    const cache = cacheStorage || globalThis.caches?.default;
    if (!cache) return null;
    try {
      const response = await cache.match(new Request(key));
      if (!response) return null;
      const record = await response.json();
      if (Number.isFinite(record?.storedAt) && record.payload) {
        memory.set(key, record);
        return record;
      }
    } catch { /* A cache miss must not make an upstream request fail. */ }
    return null;
  }

  async function writeCache(key, payload, storedAt, context) {
    const record = { storedAt, payload };
    if (memory.size >= 12) memory.delete(memory.keys().next().value);
    memory.set(key, record);
    const cache = cacheStorage || globalThis.caches?.default;
    if (!cache) return;
    const task = cache.put(new Request(key), new Response(JSON.stringify(record), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=1800' },
    })).catch(() => {});
    if (context?.waitUntil) context.waitUntil(task);
    else await task;
  }

  function tvSnapshot(instrument, row, fetchedAt) {
    const config = INSTRUMENTS[instrument];
    return globalThis.OilMarket.normalizeTVSnapshot({
      instrument, symbol: row.symbol, contract: 'continuous-front', exchange: config.tvExchange,
      currency: row.currency || 'USD', now: fetchedAt,
      sessionConfig: globalThis.OilMarket.SESSION_CONFIGS[instrument === 'brent' ? 'ICE_BRENT' : 'NYMEX_ENERGY'],
      raw: {
        symbol: row.symbol, price: finite(row.close), priceAt: null,
        providerUpdatedAt: finite(row.last_bar_update_time), timeBasis: 'provider-update',
        change: finite(row.change_abs), changePercent: finite(row.change),
        updateMode: row.update_mode, delaySeconds: delaySeconds(row.update_mode),
        sourceTimeType: 'bar-update', referenceType: 'provider-reference', referenceVerified: true,
        marketState: row.current_session === 'market' ? 'open' : undefined, series: [],
      },
    });
  }

  async function fetchMarket(range, fetchedAt) {
    const snapshots = await Promise.all(Object.entries(INSTRUMENTS).map(async ([instrument, config]) => {
      const requests = await Promise.allSettled([
        yahoo(config.yahoo, '1d', '1m'),
        yahoo(config.yahoo, '1mo', '1d'),
        yahoo(config.yahoo, RANGES[range].range, RANGES[range].interval),
      ]);
      const [quote, daily, history] = requests.map(result => result.status === 'fulfilled' ? result.value : null);
      if (!quote) return unavailable(instrument, fetchedAt);
      const snapshot = globalThis.OilMarket.normalizeYahooSnapshot({
        instrument, symbol: config.yahoo, contract: 'continuous-front', exchange: config.exchange,
        currency: quote.meta.currency || 'USD', quoteRaw: quote, dailyRaw: daily, historyRaw: history,
        now: fetchedAt, sessionConfig: globalThis.OilMarket.SESSION_CONFIGS.NYMEX_ENERGY,
      });
      snapshot.name = config.name;
      snapshot.description = quote.meta.shortName || quote.meta.longName || config.name;
      if (range === '1d') {
        snapshot.series = snapshot.tradingDate ? snapshot.series.filter(point =>
          globalThis.OilMarket.getTradingDate(point.time, globalThis.OilMarket.SESSION_CONFIGS.NYMEX_ENERGY) === snapshot.tradingDate) : [];
      }
      snapshot.historyStatus = history ? 'available' : 'unavailable';
      snapshot.historySource = 'yahoo';
      snapshot.historySymbol = config.yahoo;
      snapshot.historyWarning = 'continuous-series-may-contain-roll-gap';
      return snapshot;
    }));
    const instruments = Object.fromEntries(snapshots.map(snapshot => [snapshot.instrument, snapshot]));
    const missing = Object.keys(INSTRUMENTS).filter(key => !Number.isFinite(instruments[key]?.price) || instruments[key].status === 'unavailable');
    if (missing.length) {
      try {
        const rows = await scanner({ symbols: { tickers: missing.map(key => INSTRUMENTS[key].tv), query: { types: [] } } });
        for (const instrument of missing) {
          const row = rows.find(item => item.symbol === INSTRUMENTS[instrument].tv);
          if (!row) continue;
          const snapshot = tvSnapshot(instrument, row, fetchedAt);
          snapshot.historyStatus = 'unavailable';
          snapshot.historySource = null;
          snapshot.historySymbol = null;
          snapshot.reason = 'primary-source-unavailable';
          instruments[instrument] = snapshot;
        }
      } catch { /* Preserve explicitly unavailable instruments when both sources fail. */ }
    }
    return {
      schemaVersion: 1, version: API_VERSION, generatedAt: fetchedAt, range,
      instruments, spread: marketSpread(instruments, fetchedAt),
      provenance: {
        primary: 'Yahoo Finance · NYMEX continuous futures',
        fallback: 'TradingView · exact exchange continuous futures · provider-defined reference',
        referencePolicy: 'same-source-same-symbol',
      },
    };
  }

  async function fetchCurve(instrument, fetchedAt) {
    const config = INSTRUMENTS[instrument];
    const today = curveDate(instrument, fetchedAt);
    const rows = await scanner({
      filter: [
        { left: 'root', operation: 'equal', right: config.root },
        { left: 'expiration', operation: 'greater', right: Number(today.replaceAll('-', '')) - 1 },
      ],
      sort: { sortBy: 'expiration', sortOrder: 'asc' }, range: [0, 6],
    });
    const contracts = rows.filter(row => row.root === config.root && row.symbol.startsWith(config.root)
      && deliveryMonth(row.symbol) && expirationDate(row.expiration) >= today)
      .map(row => ({
        symbol: row.symbol, contract: row.name || row.symbol.split(':')[1],
        description: row.description || '', expiration: expirationDate(row.expiration),
        deliveryMonth: deliveryMonth(row.symbol), price: finite(row.close),
        priceAt: null, providerUpdatedAt: finite(row.last_bar_update_time), timeBasis: 'provider-update',
        fetchedAt, source: 'tradingview', sourceTimeType: 'bar-update',
        exchange: config.tvExchange, currency: row.currency || 'USD',
        delaySeconds: delaySeconds(row.update_mode), updateMode: row.update_mode,
      }))
      .sort((a, b) => a.expiration.localeCompare(b.expiration) || a.symbol.localeCompare(b.symbol))
      .filter((row, index, all) => all.findIndex(item => item.deliveryMonth === row.deliveryMonth) === index)
      .slice(0, 3);
    for (const row of contracts) row.status = globalThis.OilMarket.classifyFreshness({ ...row, marketState: 'unknown' }, fetchedAt);
    return {
      schemaVersion: 1, version: API_VERSION, generatedAt: fetchedAt, instrument,
      source: 'tradingview', exchange: config.tvExchange,
      status: contracts.some(row => Number.isFinite(row.price) && row.status !== 'unavailable') ? 'available' : 'unavailable',
      basis: 'nearest-unexpired-contracts', label: '最近未到期合约 · 与连续主力换月口径不同',
      contracts, spreads: { m1m2: curveDifference(contracts[0], contracts[1]), m1m3: curveDifference(contracts[0], contracts[2]) },
      reason: contracts.length ? null : 'no-verified-contracts',
    };
  }

  return async function handleMarketRequest(request, env = {}, context = {}) {
    const url = new URL(request.url);
    if (!['/api/market', '/api/curve', '/api/health'].includes(url.pathname)) return null;
    const fetchedAt = Math.floor(now());
    const headers = {
      'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    };
    const respond = (payload, status = 200) => new Response(request.method === 'HEAD' ? null : JSON.stringify(payload), { status, headers });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (!['GET', 'HEAD'].includes(request.method)) return respond({ error: 'method-not-allowed' }, 405);
    if (url.pathname === '/api/health') return respond({
      schemaVersion: 1, apiVersion: 1, status: 'ok', service: 'oil-market', version: env.BUILD_SHA || env.RELEASE_ID || API_VERSION,
      generatedAt: fetchedAt, workerDigest: env.WORKER_DIGEST || null,
      capabilities: ['atomic-quotes', 'same-symbol-history', 'verified-expiration-curve', 'editorial', 'calendar'],
    });
    const range = url.searchParams.get('range') || '1d';
    const instrument = url.searchParams.get('instrument') || 'brent';
    if (url.pathname === '/api/market' && !Object.hasOwn(RANGES, range)) return respond({ error: 'invalid-range', allowed: Object.keys(RANGES) }, 400);
    if (url.pathname === '/api/curve' && !Object.hasOwn(INSTRUMENTS, instrument)) return respond({ error: 'invalid-instrument', allowed: Object.keys(INSTRUMENTS) }, 400);
    const identity = url.pathname === '/api/market' ? `market/${range}` : `curve/${instrument}/${curveDate(instrument, fetchedAt)}`;
    const cacheKey = `${url.origin}/__oil_cache/${API_VERSION}/${encodeURIComponent(env.BUILD_SHA || 'default')}/${identity}`;
    const cached = await readCache(cacheKey);
    const lifetime = url.pathname === '/api/market' ? 45 : 180;
    if (cached && fetchedAt >= cached.storedAt && fetchedAt - cached.storedAt < lifetime) {
      const payload = url.pathname === '/api/market' ? reclassify(cached.payload, fetchedAt) : reclassifyCurve(cached.payload, fetchedAt);
      return respond(payload);
    }
    try {
      const payload = url.pathname === '/api/market' ? await fetchMarket(range, fetchedAt) : await fetchCurve(instrument, fetchedAt);
      // A healthy leg must not erase the last valid observation for a failed leg.
      // Its original fetchedAt/priceAt remain intact and impose the age limit.
      const currentLegAvailable = payload.instruments && Object.values(payload.instruments)
        .some(item => Number.isFinite(item.price) && item.status !== 'unavailable');
      if (currentLegAvailable && cached?.payload?.instruments) {
        for (const key of Object.keys(INSTRUMENTS)) {
          const current = payload.instruments[key], prior = cached.payload.instruments[key];
          if ((!Number.isFinite(current?.price) || current.status === 'unavailable') && prior &&
              Number.isFinite(prior.price) && fetchedAt >= prior.fetchedAt && fetchedAt - prior.fetchedAt <= 1800) {
            payload.instruments[key] = { ...structuredClone(prior), cached: true,
              status: globalThis.OilMarket.classifyFreshness(prior, fetchedAt), reason: 'upstream-unavailable-cached-observation' };
          }
        }
        payload.spread = marketSpread(payload.instruments, fetchedAt);
      }
      const hasData = payload.instruments ? Object.values(payload.instruments).some(item => Number.isFinite(item.price) && item.status !== 'unavailable')
        : payload.status === 'available';
      if (!hasData && cached && fetchedAt >= cached.storedAt && fetchedAt - cached.storedAt <= 1800) {
        const fallback = payload.instruments ? reclassify(cached.payload, fetchedAt, true) : reclassifyCurve(cached.payload, fetchedAt, true);
        fallback.warning = 'upstream-unavailable-cached-observation';
        return respond(fallback);
      }
      if (hasData) await writeCache(cacheKey, payload, fetchedAt, context);
      payload.cache = 'miss';
      return respond(payload, hasData ? 200 : 503);
    } catch {
      if (cached && fetchedAt >= cached.storedAt && fetchedAt - cached.storedAt <= 1800) {
        const payload = url.pathname === '/api/market' ? reclassify(cached.payload, fetchedAt, true) : reclassifyCurve(cached.payload, fetchedAt, true);
        payload.warning = 'upstream-unavailable-cached-observation';
        return respond(payload);
      }
      return respond({ schemaVersion: 1, generatedAt: fetchedAt, status: 'unavailable', error: 'source-unavailable' }, 503);
    }
  };
}

export const marketService = createMarketService();

export const marketServiceTestHooks = { expirationDate, deliveryMonth, scannerRows, readChart, INSTRUMENTS, SCANNER_COLUMNS };
