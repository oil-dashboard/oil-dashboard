(function (root) {
  'use strict';

  const STATUSES = ['fresh', 'delayed', 'stale', 'closed', 'unavailable'];
  const REFERENCE_TYPES = ['previous-close'];
  const SESSION_CONFIGS = {
    NYMEX_ENERGY: {
      timeZone: 'America/New_York', sessionStartHour: 18, sessionEndHour: 17,
      tradingDateShift: 1, tradingWeekdays: [1, 2, 3, 4, 5], dailyBarTimeZone: 'America/New_York',
    },
    ICE_BRENT: {
      timeZone: 'Europe/London', sessionStartHour: 1, sessionEndHour: 23,
      tradingDateShift: 0, tradingWeekdays: [1, 2, 3, 4, 5], dailyBarTimeZone: 'Europe/London',
    },
  };

  function number(value) {
    if (value == null || value === '' || typeof value === 'boolean') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function seconds(value) {
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() / 1000 : null;
    if (typeof value === 'string' && !/^\d+(\.\d+)?$/.test(value)) {
      const n = Date.parse(value);
      return Number.isFinite(n) ? n / 1000 : null;
    }
    const n = number(value);
    return n != null && n > 0 ? (n > 1e11 ? n / 1000 : n) : null;
  }

  function dateParts(timestamp, timeZone) {
    const ts = seconds(timestamp);
    if (ts == null || !timeZone) return null;
    try {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      }).formatToParts(new Date(ts * 1000)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
      return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), second: Number(p.second) };
    } catch { return null; }
  }

  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  function shiftDate(value, days) {
    return new Date(Date.parse(`${value}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  }

  // A session template does not claim to include an exchange's holiday calendar.
  // Unknown calendar coverage remains unknown; explicit closures always win.
  function getSessionState(timestamp, config) {
    const p = dateParts(timestamp, config?.timeZone);
    const start = number(config?.sessionStartHour);
    const end = number(config?.sessionEndHour);
    if (!p || start == null || end == null || start < 0 || start >= 24 || end < 0 || end > 24) {
      return { tradingDate: null, state: 'unknown', reason: 'session-unconfigured' };
    }
    const startMin = start * 60 + (number(config.sessionStartMinute) || 0);
    let endMin = end * 60 + (number(config.sessionEndMinute) || 0);
    const overnight = startMin > endMin;
    const date = overnight && p.minutes >= startMin
      ? shiftDate(p.date, number(config.tradingDateShift) ?? 1) : p.date;
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const weekdays = config.tradingWeekdays || [1, 2, 3, 4, 5];
    if (!weekdays.includes(weekday)) return { tradingDate: null, state: 'closed', reason: 'weekend' };
    const calendar = config.calendar || {};
    if ([...(config.holidays || []), ...(calendar.closedDates || [])].includes(date)) {
      return { tradingDate: null, state: 'closed', reason: 'holiday' };
    }
    const early = calendar.earlyCloses?.[date];
    if (early != null) {
      const hour = number(typeof early === 'object' ? early.endHour : early);
      if (hour != null) endMin = hour * 60 + (number(early?.endMinute) || 0);
    }
    if (overnight && p.minutes >= endMin && p.minutes < startMin) {
      return { tradingDate: date, state: early != null ? 'closed' : 'maintenance', reason: early != null ? 'early-close' : 'daily-maintenance' };
    }
    if (!overnight && (p.minutes < startMin || p.minutes >= endMin)) {
      return { tradingDate: date, state: 'closed', reason: early != null ? 'early-close' : 'outside-session' };
    }
    const covered = validDate(calendar.from) && validDate(calendar.to) && date >= calendar.from && date <= calendar.to;
    return { tradingDate: date, state: covered ? 'open' : 'unknown', reason: covered ? 'regular-session' : 'holiday-calendar-unverified' };
  }

  function getTradingDate(timestamp, config) {
    return getSessionState(timestamp, config).tradingDate;
  }

  function result(raw) {
    return raw?.chart?.result?.[0] || raw?.result?.[0] || raw || null;
  }

  function sameIdentity(raw, symbol, source) {
    if (!raw) return false;
    const actualSymbol = raw.meta?.symbol || raw.symbol;
    return (!actualSymbol || actualSymbol === symbol) && (!raw.source || raw.source === source);
  }

  function seriesFrom(raw, symbol, source, priceAt) {
    const data = result(raw);
    if (!sameIdentity(data, symbol, source)) return [];
    const times = data.timestamps || data.timestamp || [];
    const closes = data.closes || data.indicators?.quote?.[0]?.close || [];
    const pairs = new Map();
    for (let i = 0; i < times.length; i++) {
      const time = seconds(times[i]), value = number(closes[i]);
      if (time != null && value != null && (priceAt == null || time <= priceAt)) pairs.set(time, value);
    }
    return [...pairs].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }));
  }

  function previousDailyClose(dailyRaw, snapshot, config) {
    const daily = result(dailyRaw);
    const dailySymbol = daily?.meta?.symbol || daily?.symbol;
    if (!snapshot.symbol || !snapshot.tradingDate || snapshot.priceAt == null
      || dailySymbol !== snapshot.symbol || (daily?.source && daily.source !== snapshot.source)
      || (daily?.meta?.dataGranularity && daily.meta.dataGranularity !== '1d')) return null;
    const zone = config?.dailyBarTimeZone || daily?.meta?.exchangeTimezoneName;
    const times = daily?.timestamps || daily?.timestamp || [];
    const closes = daily?.closes || daily?.indicators?.quote?.[0]?.close || [];
    const completed = [];
    for (let i = 0; i < times.length; i++) {
      const time = seconds(times[i]), price = number(closes[i]);
      const label = time == null ? null : dateParts(time, zone);
      // Yahoo labels historical daily candles at exchange-local midnight, but
      // can append the live quote at regularMarketTime to the same 1d array.
      // Its calendar date is still yesterday during the overnight session;
      // accepting it would compare the current price with itself all morning.
      if (time != null && time <= snapshot.priceAt && price != null && price > 0
        && label?.minutes === 0 && label.second === 0 && label.date < snapshot.tradingDate) {
        completed.push({ time, date: label.date, price });
      }
    }
    completed.sort((a, b) => a.time - b.time);
    const previous = completed[completed.length - 1];
    return previous ? { price: previous.price, date: previous.date } : null;
  }

  function baseSnapshot(input, source, actualSymbol) {
    const now = seconds(input.now) ?? Date.now() / 1000;
    return {
      instrument: input.instrument || null, symbol: actualSymbol || input.symbol || null,
      contract: input.contract || actualSymbol || input.symbol || null,
      exchange: input.exchange || null, currency: input.currency || 'USD', source,
      price: null, priceAt: null, fetchedAt: now, tradingDate: null,
      reference: null, change: null, changePercent: null, status: 'unavailable',
      marketState: 'unknown', series: [], delaySeconds: 0, providerUpdatedAt: null, timeBasis: 'market-time',
    };
  }

  function marketState(rawState, now, config) {
    if (['open', 'closed', 'maintenance'].includes(rawState)) return rawState;
    return getSessionState(now, config).state;
  }

  function setReference(snapshot, price, date, type, basis) {
    if (price == null || price <= 0 || snapshot.price == null || snapshot.price <= 0
      || !REFERENCE_TYPES.includes(type) || basis !== 'daily-close') return;
    snapshot.reference = { price, date: validDate(date) ? date : null, type, basis, source: snapshot.source, symbol: snapshot.symbol };
    // Yahoo daily closes carry float32 residue; these contracts quote in cents.
    const change = Number((snapshot.price - price).toFixed(2));
    snapshot.change = change === 0 ? 0 : change;
    snapshot.changePercent = snapshot.change != null && price > 0 ? snapshot.change / price * 100 : null;
  }

  function normalizeYahooSnapshot(input) {
    input = input || {};
    const quote = result(input.quoteRaw), meta = quote?.meta || {};
    const snapshot = baseSnapshot(input, 'yahoo', meta.symbol || quote?.symbol);
    if (!sameIdentity(quote, input.symbol || snapshot.symbol, 'yahoo')) return snapshot;
    snapshot.price = number(meta.regularMarketPrice);
    snapshot.priceAt = seconds(meta.regularMarketTime);
    snapshot.tradingDate = getTradingDate(snapshot.priceAt, input.sessionConfig);
    snapshot.marketState = marketState(input.marketState || meta.marketState, snapshot.fetchedAt, input.sessionConfig);
    snapshot.delaySeconds = Math.max(0, number(input.delaySeconds) ?? ((number(meta.exchangeDataDelayedBy) || 0) * 60));
    snapshot.series = seriesFrom(input.historyRaw, snapshot.symbol, 'yahoo', snapshot.priceAt);
    const previous = previousDailyClose(input.dailyRaw, snapshot, input.sessionConfig);
    if (previous) setReference(snapshot, previous.price, previous.date, 'previous-close', 'daily-close');
    snapshot.status = classifyFreshness(snapshot, snapshot.fetchedAt, input.freshness);
    return snapshot;
  }

  function normalizeTVSnapshot(input) {
    input = input || {};
    const raw = input.raw || {};
    const snapshot = baseSnapshot(input, 'tradingview', raw.symbol);
    if (!sameIdentity(raw, input.symbol || snapshot.symbol, 'tradingview')) return snapshot;
    snapshot.price = number(raw.price ?? raw.close);
    // Scanner last_bar_update_time describes the delayed feed's update, not the
    // actual trade time. Do not promote it (or fetchedAt) to priceAt.
    snapshot.priceAt = null;
    snapshot.providerUpdatedAt = seconds(raw.providerUpdatedAt ?? raw.last_bar_update_time);
    snapshot.timeBasis = 'provider-update';
    snapshot.tradingDate = validDate(raw.tradingDate) ? raw.tradingDate : null;
    snapshot.marketState = marketState(raw.marketState, snapshot.fetchedAt, input.sessionConfig);
    const delayMatch = String(raw.updateMode || raw.update_mode || '').match(/delayed[^\d]*(\d+)/);
    snapshot.delaySeconds = Math.max(0, number(raw.delaySeconds) ?? (delayMatch ? Number(delayMatch[1]) : 0));
    // Provider change fields are not a same-symbol completed daily bar.
    // A TV quote never borrows Yahoo's history or reference price.
    snapshot.series = Array.isArray(raw.series) ? raw.series.filter(p => seconds(p.time) != null && number(p.value) != null)
      .map(p => ({ time: seconds(p.time), value: number(p.value) })).filter(p => snapshot.priceAt == null || p.time <= snapshot.priceAt)
      .sort((a, b) => a.time - b.time) : [];
    snapshot.status = classifyFreshness(snapshot, snapshot.fetchedAt, input.freshness);
    return snapshot;
  }

  function classifyFreshness(snapshot, now, options) {
    options = options || {};
    const providerTime = snapshot?.timeBasis === 'provider-update' ? seconds(snapshot?.providerUpdatedAt) : null;
    const price = number(snapshot?.price), at = seconds(snapshot?.priceAt) ?? providerTime, clock = seconds(now) ?? Date.now() / 1000;
    if (price == null || at == null || at - clock > 120) return 'unavailable';
    const age = Math.max(0, clock - at);
    if (['closed', 'maintenance'].includes(snapshot.marketState)) {
      return age <= (number(options.maxClosedAgeSeconds) ?? 4 * 86400) ? 'closed' : 'stale';
    }
    const delay = Math.max(0, number(snapshot.delaySeconds) || 0);
    if (age > (number(options.staleSeconds) ?? 1200) + delay) return 'stale';
    if (providerTime != null || delay > 0 || age > (number(options.freshSeconds) ?? 120)) return 'delayed';
    return 'fresh';
  }

  function validateSnapshot(snapshot, options) {
    options = options || {};
    const errors = [];
    if (!snapshot || typeof snapshot !== 'object') return { valid: false, errors: ['snapshot-required'] };
    for (const field of ['instrument', 'symbol', 'source', 'currency']) {
      if (typeof snapshot[field] !== 'string' || !snapshot[field]) errors.push(`${field}-required`);
      if (options[field] && snapshot[field] !== options[field]) errors.push(`${field}-mismatch`);
    }
    if (!STATUSES.includes(snapshot.status)) errors.push('invalid-status');
    if (!['open', 'closed', 'maintenance', 'unknown'].includes(snapshot.marketState)) errors.push('invalid-marketState');
    for (const field of ['price', 'priceAt', 'change', 'changePercent']) {
      if (snapshot[field] !== null && (typeof snapshot[field] !== 'number' || !Number.isFinite(snapshot[field]))) errors.push(`invalid-${field}`);
    }
    if (typeof snapshot.fetchedAt !== 'number' || !Number.isFinite(snapshot.fetchedAt) || snapshot.fetchedAt <= 0) errors.push('invalid-fetchedAt');
    if (snapshot.priceAt != null && (snapshot.priceAt <= 0 || snapshot.priceAt > snapshot.fetchedAt + 120)) errors.push('invalid-priceAt');
    if (snapshot.providerUpdatedAt != null && (typeof snapshot.providerUpdatedAt !== 'number'
      || !Number.isFinite(snapshot.providerUpdatedAt) || snapshot.providerUpdatedAt <= 0
      || snapshot.providerUpdatedAt > snapshot.fetchedAt + 120)) errors.push('invalid-providerUpdatedAt');
    if (snapshot.tradingDate !== null && !validDate(snapshot.tradingDate)) errors.push('invalid-tradingDate');
    if (snapshot.status === 'fresh' && (snapshot.priceAt == null || snapshot.timeBasis === 'provider-update'
      || (number(snapshot.delaySeconds) || 0) > 0)) errors.push('unverified-fresh-status');
    if (snapshot.price == null && (snapshot.change !== null || snapshot.changePercent !== null)) errors.push('change-without-price');
    const ref = snapshot.reference;
    if (ref) {
      if (typeof ref.price !== 'number' || !Number.isFinite(ref.price) || ref.price <= 0) errors.push('invalid-reference-price');
      if (ref.source !== snapshot.source || ref.symbol !== snapshot.symbol) errors.push('reference-identity-mismatch');
      if (!REFERENCE_TYPES.includes(ref.type)) errors.push('invalid-reference-type');
      if (ref.basis !== 'daily-close') errors.push('invalid-reference-basis');
      if (!validDate(ref.date) || !snapshot.tradingDate || ref.date >= snapshot.tradingDate) errors.push('invalid-reference-date');
      if (snapshot.price == null || snapshot.price <= 0 || snapshot.change == null || snapshot.changePercent == null) errors.push('missing-daily-change');
      if (snapshot.price != null && snapshot.change != null && Math.abs(snapshot.price - ref.price - snapshot.change) > 0.02) errors.push('change-reference-mismatch');
      if (snapshot.changePercent != null && (ref.price <= 0 || snapshot.change == null
        || Math.abs(snapshot.changePercent - snapshot.change / ref.price * 100) > 0.02)) errors.push('percent-reference-mismatch');
    } else if (snapshot.change !== null || snapshot.changePercent !== null) errors.push('change-without-reference');
    if (!Array.isArray(snapshot.series) || snapshot.series.some((p, i, rows) =>
      typeof p?.time !== 'number' || !Number.isFinite(p.time) || p.time <= 0 || typeof p?.value !== 'number' || !Number.isFinite(p.value)
      || (i > 0 && p.time <= rows[i - 1].time) || (snapshot.priceAt != null && p.time > snapshot.priceAt))) errors.push('invalid-series');
    const sourceTime = snapshot.priceAt ?? (snapshot.timeBasis === 'provider-update' ? snapshot.providerUpdatedAt : null);
    if (options.maxAgeSeconds != null && seconds(options.now) != null && sourceTime != null
      && seconds(options.now) - sourceTime > options.maxAgeSeconds) errors.push('snapshot-expired');
    return { valid: errors.length === 0, errors };
  }

  function alignSpread(brent, wti, options) {
    options = options || {};
    const unavailable = reason => ({ price: null, priceAt: null, status: 'unavailable', reason });
    if (!validateSnapshot(brent).valid || !validateSnapshot(wti).valid || brent.price == null || wti.price == null
      || brent.priceAt == null || wti.priceAt == null) return unavailable('invalid-leg');
    if (brent.source !== wti.source) return unavailable('source-mismatch');
    if (brent.currency !== wti.currency) return unavailable('currency-mismatch');
    if (brent.instrument === wti.instrument) return unavailable('instrument-mismatch');
    if (Math.abs(brent.priceAt - wti.priceAt) > (number(options.maxSkewSeconds) ?? 300)) return unavailable('time-mismatch');
    const now = seconds(options.now) ?? Math.max(brent.fetchedAt, wti.fetchedAt);
    const states = [brent, wti].map(s => classifyFreshness(s, now, { staleSeconds: number(options.maxAgeSeconds) ?? 1200 }));
    if (states.some(s => ['stale', 'unavailable'].includes(s))) return unavailable('stale-leg');
    const status = states.every(s => s === 'closed') ? 'closed' : states.some(s => s === 'delayed' || s === 'closed') ? 'delayed' : 'fresh';
    return { price: brent.price - wti.price, priceAt: Math.min(brent.priceAt, wti.priceAt), status, reason: null };
  }

  root.OilMarket = Object.freeze({ SESSION_CONFIGS, getSessionState, getTradingDate,
    normalizeYahooSnapshot, normalizeTVSnapshot, classifyFreshness, validateSnapshot, alignSpread });
})(globalThis);
