/* Oil Dashboard market workspace. UTC observations in, traceable SGT labels out. */
(function (root) {
  'use strict';

  const RANGES = new Set(['1d', '5d', '1mo']);
  const INSTRUMENTS = new Set(['brent', 'wti', 'spread']);
  const CACHE_PREFIX = 'oil_market_snapshot_v3:';
  const CACHE_TTL_MS = 30 * 60 * 1000;
  const QUOTE_REFRESH_MS = 60 * 1000;
  const STATUS_LABELS = { fresh: '最新报价', delayed: '延迟报价', stale: '数据过期', closed: '休市', unavailable: '暂无报价' };
  const state = {
    initialized: false, range: '1d', instrument: 'brent', curveInstrument: 'brent',
    snapshot: null, cached: false, lastSuccessAt: null, lastRequestAt: null, promise: null, pendingRange: null,
    requestId: 0, controller: null, curveRequestId: 0, curveController: null,
    chart: null, series: null, referenceLine: null, chartIdentity: null, resizeObserver: null,
    ageTimer: null, handlers: [], curveSnapshot: null, events: [], markers: null, markerIdentity: null,
  };

  function element(id) { return root.document?.getElementById(id) || null; }
  function text(id, value) { const el = element(id); if (el) el.textContent = value == null ? '' : String(value); }
  function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
  function nowSeconds() { return Math.floor(Date.now() / 1000); }
  function core() { return root.OilMarket; }
  function apiBase() {
    if (root.OIL_API_BASE !== undefined) return String(root.OIL_API_BASE ?? '').replace(/\/$/, '');
    if (['localhost', '127.0.0.1', '[::1]'].includes(root.location?.hostname)) return root.location.origin;
    return 'https://oil-proxy.xzregproxy.workers.dev';
  }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function money(value, signed = false) {
    if (!finite(value)) return '—';
    const rounded = Number(value.toFixed(2)) || 0;
    return `${signed && rounded > 0 ? '+' : ''}${rounded.toFixed(2)}`;
  }
  function formatTime(timestamp, options = {}) {
    if (!finite(timestamp) || timestamp <= 0) return '时间不可用';
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Singapore', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
        ...options,
      }).format(new Date(timestamp * 1000)) + ' SGT';
    } catch { return '时间不可用'; }
  }
  function formatDateLabel(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value.slice(5).replace('-', '/') : null;
  }
  function shortTime(timestamp) {
    if (!finite(timestamp) || timestamp <= 0) return '—';
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(timestamp * 1000));
  }
  function chartTick(time, tickType) {
    if (!finite(time)) return '—';
    const type = root.LightweightCharts?.TickMarkType;
    if (state.range !== '1d' || tickType === type?.DayOfMonth || tickType === type?.Month || tickType === type?.Year) {
      return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Singapore', month: '2-digit', day: '2-digit' }).format(new Date(time * 1000));
    }
    return shortTime(time);
  }
  function observationTime(snapshot) {
    return snapshot?.timeBasis === 'provider-update' ? snapshot.providerUpdatedAt : snapshot?.priceAt;
  }
  function timeLabel(snapshot) {
    return snapshot?.timeBasis === 'provider-update'
      ? '源更新 ' + formatTime(snapshot.providerUpdatedAt) + ' · 成交时间未提供'
      : '行情更新 ' + formatTime(snapshot?.priceAt);
  }
  function validReference(snapshot) {
    const ref = snapshot?.reference;
    return Boolean(ref && ref.type === 'previous-close' && ref.basis === 'daily-close' && finite(ref.price) && ref.price > 0
      && ref.symbol === snapshot.symbol && ref.source === snapshot.source
      && /^\d{4}-\d{2}-\d{2}$/.test(ref.date || '') && snapshot.tradingDate && ref.date < snapshot.tradingDate);
  }
  function referenceText(snapshot) {
    if (!validReference(snapshot)) return '日线前收暂不可用 · 涨跌幅暂不显示';
    const ref = snapshot.reference;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(ref.date || '') ? ref.date.slice(5).replace('-', '/') : null;
    return `较 ${date} 日线收盘 $${money(ref.price)}`;
  }
  function quoteStatus(snapshot) {
    if (!snapshot || !finite(snapshot.price)) return 'unavailable';
    if (core()?.classifyFreshness) {
      try {
        const status = core().classifyFreshness(snapshot, nowSeconds());
        if (Object.hasOwn(STATUS_LABELS, status)) return status;
      } catch { /* The observation's own status remains visible if a classifier is unavailable. */ }
    }
    return Object.hasOwn(STATUS_LABELS, snapshot.status) ? snapshot.status : 'unavailable';
  }
  function statusLabel(snapshot, status = quoteStatus(snapshot)) {
    if (status === 'delayed') {
      const delay = Number(snapshot?.delaySeconds ?? snapshot?.marketDataDelaySeconds);
      if (delay > 0 && Number.isFinite(delay)) return `延迟 ${Math.ceil(delay / 60)} 分钟`;
      const mode = String(snapshot?.updateMode || snapshot?.update_mode || '').match(/delayed_streaming_(\d+)/);
      if (mode) return `延迟 ${Math.ceil(Number(mode[1]) / 60)} 分钟`;
    }
    return STATUS_LABELS[status] || STATUS_LABELS.unavailable;
  }
  function normalizedSeries(series) {
    const points = new Map();
    for (const point of Array.isArray(series) ? series : []) {
      if (finite(point?.time) && point.time > 0 && finite(point?.value)) points.set(Math.floor(point.time), point.value);
    }
    return [...points].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }));
  }
  function spreadSeriesFromLegs(payload) {
    const a = payload?.instruments?.brent, b = payload?.instruments?.wti;
    if (!a || !b || !core()?.validateSnapshot(a).valid || !core()?.validateSnapshot(b).valid
      || a.source !== b.source || a.currency !== b.currency || !finite(a.priceAt) || !finite(b.priceAt)
      || a.historySource !== a.source || b.historySource !== b.source
      || a.historySymbol !== a.symbol || b.historySymbol !== b.symbol) return [];
    const right = new Map(b.series.map(point => [point.time, point.value]));
    return a.series.filter(point => right.has(point.time)).map(point => ({ time: point.time, value: point.value - right.get(point.time) }));
  }
  function validSpread(payload) {
    const spread = payload.spread, a = payload.instruments.brent, b = payload.instruments.wti;
    if (!spread || !Array.isArray(spread.series) || spread.source !== (a.source === b.source ? a.source : null)
      || spread.symbols?.brent !== a.symbol || spread.symbols?.wti !== b.symbol) return false;
    if (spread.price !== null && (!finite(spread.price) || !finite(a.price) || !finite(b.price)
      || a.source !== b.source || a.currency !== b.currency || !finite(a.priceAt) || !finite(b.priceAt)
      || Math.abs(spread.price - (a.price - b.price)) > 1e-8 || spread.priceAt !== Math.min(a.priceAt, b.priceAt))) return false;
    if (spread.price === null && spread.priceAt !== null) return false;
    const expected = spreadSeriesFromLegs(payload);
    return spread.series.length === expected.length && spread.series.every((point, i) =>
      finite(point?.time) && finite(point?.value) && point.time === expected[i].time && Math.abs(point.value - expected[i].value) <= 1e-8);
  }
  function validatePayload(payload, expectedRange) {
    if (!payload || payload.schemaVersion !== 1 || !payload.instruments || !core()?.validateSnapshot) return false;
    if (!RANGES.has(payload.range) || (expectedRange && payload.range !== expectedRange)) return false;
    let count = 0;
    for (const key of ['brent', 'wti']) {
      const snapshot = payload.instruments[key];
      if (!snapshot || snapshot.instrument !== key) return false;
      const validation = core().validateSnapshot(snapshot, { instrument: key, now: nowSeconds() });
      if (!validation?.valid) return false;
      if (snapshot.fetchedAt > nowSeconds() + 120 || observationTime(snapshot) > nowSeconds() + 120) return false;
      if (snapshot.historySource && snapshot.historySource !== snapshot.source) return false;
      if (snapshot.historySymbol && snapshot.historySymbol !== snapshot.symbol) return false;
      if (snapshot.timeBasis === 'provider-update' && snapshot.series.length) return false;
      if (finite(snapshot.price)) count += 1;
    }
    return count > 0 && validSpread(payload);
  }
  function readCache(range = state.range, nowMs = Date.now()) {
    try {
      const stored = JSON.parse(root.localStorage?.getItem(CACHE_PREFIX + range) || 'null');
      if (!stored || !finite(stored.storedAt) || stored.storedAt > nowMs + 1000 || nowMs - stored.storedAt > CACHE_TTL_MS || !validatePayload(stored.payload, range)) return null;
      return stored;
    } catch { return null; }
  }
  function writeCache(payload, range = state.range) {
    if (!validatePayload(payload, range)) return;
    try { root.localStorage?.setItem(CACHE_PREFIX + range, JSON.stringify({ storedAt: Date.now(), payload })); } catch { /* Storage is optional. */ }
  }
  function overallStatus(payload) {
    const statuses = ['brent', 'wti'].map(key => quoteStatus(payload?.instruments?.[key]));
    if (statuses.every(status => status === 'unavailable')) return 'unavailable';
    if (statuses.includes('unavailable') || statuses.includes('stale')) return 'stale';
    if (statuses.every(status => status === 'closed')) return 'closed';
    if (statuses.includes('delayed')) return 'delayed';
    return 'fresh';
  }
  function sourceLabel(snapshot) {
    const source = snapshot?.source;
    if (!source) return '来源不可用';
    const names = { yahoo: 'Yahoo Finance', 'yahoo-finance': 'Yahoo Finance', tradingview: 'TradingView' };
    return names[source] || source;
  }
  function renderQuote(key, snapshot) {
    const status = quoteStatus(snapshot);
    const price = finite(snapshot?.price) ? snapshot.price : null;
    text(key + 'Price', price == null ? '—' : '$' + money(price));
    text(key + 'Instrument', [snapshot?.symbol, snapshot?.contract === 'continuous-front' ? '连续近月' : snapshot?.contract, snapshot?.exchange].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' · ') || '合约信息加载中');
    const hasChange = validReference(snapshot) && finite(snapshot?.change) && finite(snapshot?.changePercent);
    const displayedChange = hasChange ? Number(snapshot.change.toFixed(2)) || 0 : null;
    const displayedPercent = displayedChange === 0 ? 0 : snapshot?.changePercent;
    const changeEl = element(key + 'Change');
    if (changeEl) {
      changeEl.textContent = hasChange ? `${displayedChange > 0 ? '▲' : displayedChange < 0 ? '▼' : '＝'} ${money(displayedChange, true)} (${money(displayedPercent, true)}%)` : '—';
      changeEl.className = 'price-change ' + (hasChange && displayedChange > 0 ? 'price-up' : hasChange && displayedChange < 0 ? 'price-down' : 'price-neutral');
    }
    const statusEl = element(key + 'Status');
    const cached = state.cached || snapshot?.cached;
    if (statusEl) { statusEl.textContent = (cached ? '缓存 · ' : '') + statusLabel(snapshot, status); statusEl.className = 'quote-status status-' + (cached && status === 'fresh' ? 'delayed' : status); }
    text(key + 'Reference', referenceText(snapshot));
    text(key + 'Time', timeLabel(snapshot));
    const detail = [sourceLabel(snapshot), snapshot?.currency ? `${snapshot.currency} / 桶` : '', snapshot?.tradingDate ? `交易日 ${snapshot.tradingDate}` : '交易日不可用'];
    text(key + 'Source', detail.filter(Boolean).join(' · '));
  }
  function alignedSpread(payload) {
    const brent = payload?.instruments?.brent, wti = payload?.instruments?.wti;
    if (!brent || !wti || !core()?.alignSpread) return null;
    try { return core().alignSpread(brent, wti, { now: nowSeconds() }); } catch { return null; }
  }
  function renderSpread(payload) {
    const spread = alignedSpread(payload);
    const value = finite(spread?.price) ? spread.price : finite(spread?.value) ? spread.value : null;
    text('spreadValue', value == null ? '—' : '$' + money(value));
    const status = value == null ? 'unavailable' : (spread.status || 'fresh');
    const el = element('spreadStatus');
    const cached = state.cached || payload?.instruments?.brent?.cached || payload?.instruments?.wti?.cached;
    if (el) { el.textContent = value == null ? '未能对齐' : (cached ? '缓存 · ' : '') + '已对齐'; el.className = 'quote-status status-' + (cached && status === 'fresh' ? 'delayed' : status); }
    const a = payload?.instruments?.brent, b = payload?.instruments?.wti;
    text('spreadReference', value == null ? '两地行情未满足时间与口径核对条件' : `报价时差 ${Math.abs(Math.round((a?.priceAt || 0) - (b?.priceAt || 0)))} 秒`);
    text('spreadTime', value == null ? '单位：美元 / 桶' : '行情更新 ' + formatTime(spread.priceAt));
    text('spreadSource', value == null ? '' : `${a.symbol} − ${b.symbol}`);
    return spread;
  }
  function renderStatus(payload, error) {
    const status = overallStatus(payload);
    const hasCachedLeg = ['brent', 'wti'].some(key => payload?.instruments?.[key]?.cached);
    const live = status === 'fresh' && !state.cached && !hasCachedLeg;
    const badge = element('sourceStatus');
    if (badge) {
      badge.textContent = state.cached || hasCachedLeg ? '行情缓存' : { fresh: '行情已更新', delayed: '行情有延迟', stale: '行情待核对', closed: '市场休市', unavailable: '行情不可用' }[status];
      badge.className = 'source-status ' + (live ? 'source-live' : status === 'unavailable' ? 'source-offline' : 'source-cached');
    }
    const dot = element('liveDot');
    if (dot) dot.style.backgroundColor = live ? 'var(--up)' : status === 'unavailable' ? 'var(--text-muted)' : 'var(--accent-gold)';
    const message = element('marketDataStatus');
    if (message) {
      message.dataset.status = status;
      let description = {
        fresh: '涨跌以同一合约上一交易日的日线收盘价为基准；新加坡早晚使用同一交易日口径。',
        delayed: '行情源提供延迟报价；源更新时间与实际成交时间分别标注，涨跌仍以同合约日线收盘价为基准。',
        stale: '部分行情已过期或缺失，比较前请核对来源与行情时间。',
        closed: '市场休市，显示最后可核对的报价与比较基准。',
        unavailable: '行情暂不可用，价格与涨跌幅将在恢复后显示。',
      }[status];
      if (state.cached || hasCachedLeg) description = (error || payload?.warning ? '连接暂不可用，' : '') + '正在显示最近一次已核对的缓存。' + description;
      if (error && !state.cached) description = '行情服务暂不可用，请稍后刷新。';
      message.textContent = description;
    }
    text('marketLastSuccess', state.lastSuccessAt ? '最近获取 ' + formatTime(state.lastSuccessAt) : '尚未成功获取行情');
    return status;
  }
  function chartData(payload) {
    if (payload?.range && payload.range !== state.range) return { points: [], label: state.instrument === 'spread' ? 'Brent − WTI' : state.instrument.toUpperCase(), reason: '正在加载所选范围的走势…' };
    if (state.instrument === 'spread') {
      const spread = alignedSpread(payload);
      if (!finite(spread?.price) && !finite(spread?.value)) return { points: [], label: 'Brent − WTI', reason: '两地行情未对齐，暂不绘制价差' };
      return { points: normalizedSeries(spreadSeriesFromLegs(payload)), label: 'Brent − WTI', reason: '暂无同源、同时点价差历史' };
    }
    const snapshot = payload?.instruments?.[state.instrument];
    const points = snapshot?.timeBasis === 'provider-update' ? [] : normalizedSeries(snapshot?.series);
    return { points, snapshot, label: snapshot?.symbol || state.instrument.toUpperCase(), reason: '当前行情源未提供可核对的同合约历史走势' };
  }
  function createChart() {
    if (state.chart || !root.LightweightCharts || !element('marketChart')) return;
    const L = root.LightweightCharts;
    const container = element('marketChart');
    try {
      state.chart = L.createChart(container, {
        autoSize: false, width: Math.max(1, Math.floor(container.getBoundingClientRect().width)), height: Math.max(1, Math.floor(container.getBoundingClientRect().height)),
        layout: { background: { type: 'solid', color: '#0b1018' }, textColor: '#93a4b7', fontSize: 10, attributionLogo: true },
        grid: { vertLines: { visible: false }, horzLines: { color: '#1b2633' } },
        crosshair: { mode: L.CrosshairMode?.Normal ?? 0, vertLine: { color: '#587085', labelBackgroundColor: '#24384d' }, horzLine: { color: '#587085', labelBackgroundColor: '#24384d' } },
        rightPriceScale: { borderVisible: false, scaleMargins: { top: .15, bottom: .12 } },
        timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, tickMarkFormatter: chartTick },
        localization: { locale: 'zh-CN', timeFormatter: time => formatTime(typeof time === 'number' ? time : NaN), priceFormatter: value => money(value) },
        handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      });
      state.series = state.chart.addSeries(L.LineSeries, { color: '#d6b579', lineWidth: 2, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: true });
      state.chart.subscribeCrosshairMove(param => {
        const point = param?.seriesData?.get(state.series);
        if (point && finite(point.value)) { text('chartValue', '$' + money(point.value)); text('chartTime', formatTime(typeof param.time === 'number' ? param.time : null)); }
        else renderChartReadout();
      });
      if (root.ResizeObserver) {
        state.resizeObserver = new root.ResizeObserver(() => {
          const box = container.getBoundingClientRect();
          if (box.width > 0 && box.height > 0) state.chart?.resize(Math.floor(box.width), Math.floor(box.height));
        });
        state.resizeObserver.observe(container);
      } else bind(root, 'resize', () => { const box = container.getBoundingClientRect(); state.chart?.resize(Math.max(1, Math.floor(box.width)), Math.max(1, Math.floor(box.height))); });
    } catch {
      if (state.chart) state.chart.remove();
      state.chart = state.series = null;
    }
  }
  function renderChartReadout() {
    const data = chartData(state.snapshot);
    const point = data.points[data.points.length - 1];
    text('chartSymbol', data.label);
    text('chartValue', point ? '$' + money(point.value) : '');
    text('chartTime', point ? formatTime(point.time) : '');
  }
  function clearEventMarkers() {
    if (state.markers) { state.markers.setMarkers([]); state.markers.detach(); }
    state.markers = state.markerIdentity = null;
    const events = element('chartEvents');
    if (events) events.hidden = true;
    const list = element('chartEventList');
    if (list) list.innerHTML = '';
  }
  function eventsForSeries(data) {
    const snapshot = data.snapshot, points = data.points;
    if (state.instrument === 'spread' || !points.length || !snapshot || !core()?.validateSnapshot(snapshot).valid
      || !finite(snapshot.priceAt) || snapshot.timeBasis === 'provider-update'
      || snapshot.source !== snapshot.historySource || snapshot.symbol !== snapshot.historySymbol) return [];
    const last = points[points.length - 1].time;
    return state.events.flatMap(event => {
      if (event.publishedAt > nowSeconds() || event.publishedAt > last) return [];
      let start = 0, end = points.length;
      while (start < end) { const mid = Math.floor((start + end) / 2); if (points[mid].time < event.publishedAt) start = mid + 1; else end = mid; }
      const bar = points[start];
      return bar && bar.time - event.publishedAt <= 30 * 60 ? [{ ...event, barTime: bar.time }] : [];
    });
  }
  function renderEventMarkers(data, identity) {
    const events = eventsForSeries(data);
    if (!events.length || !state.series || !root.LightweightCharts?.createSeriesMarkers) { clearEventMarkers(); return 0; }
    if (state.markerIdentity !== identity) clearEventMarkers();
    const grouped = new Map();
    for (const event of events) grouped.set(event.barTime, (grouped.get(event.barTime) || 0) + 1);
    const markers = [...grouped].sort((a, b) => a[0] - b[0]).map(([time, count]) => ({
      time, position: 'aboveBar', color: '#d6b579', shape: 'circle', text: count > 1 ? `事件 ×${count}` : '事件',
    }));
    if (!state.markers) state.markers = root.LightweightCharts.createSeriesMarkers(state.series, markers);
    else state.markers.setMarkers(markers);
    state.markerIdentity = identity;
    const container = element('chartEvents');
    if (container) container.hidden = false;
    text('chartEventsSummary', `对应发布事件（${events.length}）`);
    const list = element('chartEventList');
    if (list) list.innerHTML = events.map(event => `<p class="utility-text">${escapeHtml(formatTime(event.publishedAt))} · <a href="${escapeHtml(event.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(event.title)}</a></p>`).join('');
    const description = element('chartDescription');
    if (description) description.textContent += ` 发布事件：${events.map(event => event.title).join('；')}。标记对应发布时间，不表示价格因果关系。`;
    return events.length;
  }
  function setEvents(events) {
    const seen = new Set();
    state.events = (Array.isArray(events) ? events : []).flatMap(event => {
      if (typeof event?.title !== 'string' || !event.title.trim() || typeof event.link !== 'string'
        || !finite(event.publishedAt) || event.publishedAt <= 0 || event.publishedAt > nowSeconds()) return [];
      let url;
      try { url = new URL(event.link); } catch { return []; }
      if (!['https:', 'http:'].includes(url.protocol)) return [];
      const key = `${url.href}:${event.publishedAt}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ title: event.title.trim(), link: url.href, publishedAt: event.publishedAt }];
    }).sort((a, b) => a.publishedAt - b.publishedAt);
    renderChart();
  }
  function renderChart() {
    const data = chartData(state.snapshot);
    renderChartReadout();
    const details = element('chartDataDetails');
    if (details) details.hidden = !data.points.length;
    const table = element('chartDataRows');
    if (table) table.innerHTML = data.points.map(point => `<tr><td>${escapeHtml(formatTime(point.time))}</td><td>${money(point.value)}</td></tr>`).join('');
    const first = data.points[0], last = data.points[data.points.length - 1];
    text('chartDescription', first ? `${data.label}，${data.points.length} 个同源观测点；起点 ${formatTime(first.time)}，$${money(first.value)}；终点 ${formatTime(last.time)}，$${money(last.value)}。完整时间与价格可在下方数据表查看。` : data.reason);
    const empty = element('chartEmpty');
    if (!data.points.length) {
      clearEventMarkers();
      if (state.series) state.series.setData([]);
      if (state.referenceLine && state.series) state.series.removePriceLine(state.referenceLine);
      state.referenceLine = null;
      state.chartIdentity = null;
      if (empty) { empty.hidden = false; empty.textContent = data.reason; }
      text('chartBasis', '时间：SGT · 单位：美元 / 桶');
      return;
    }
    createChart();
    if (!state.chart || !state.series) {
      clearEventMarkers();
      if (empty) { empty.hidden = false; empty.textContent = '图表组件暂不可用，报价与基准仍可在上方核对'; }
      return;
    }
    const identity = state.range + ':' + state.instrument + ':' + (data.snapshot?.symbol || 'spread') + ':' + (data.snapshot?.source || '');
    const oldRange = state.chartIdentity === identity ? state.chart.timeScale().getVisibleLogicalRange() : null;
    state.series.applyOptions({ color: state.instrument === 'wti' ? '#a3c8ef' : state.instrument === 'spread' ? '#a6c6b4' : '#d6b579' });
    state.series.setData(data.points);
    if (oldRange) state.chart.timeScale().setVisibleLogicalRange(oldRange); else state.chart.timeScale().fitContent();
    state.chartIdentity = identity;
    if (state.referenceLine) state.series.removePriceLine(state.referenceLine);
    state.referenceLine = null;
    if (validReference(data.snapshot)) {
      state.referenceLine = state.series.createPriceLine({ price: data.snapshot.reference.price, color: '#8e9eaf', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '日线前收' });
    }
    if (empty) empty.hidden = true;
    const historyDate = formatDateLabel(data.snapshot?.historyTradingDate);
    const historyBasis = historyDate ? `图表交易日 ${historyDate} · ` : '';
    const basis = historyBasis + (validReference(data.snapshot) ? referenceText(data.snapshot) + ' · SGT' : '时间：SGT · 单位：美元 / 桶');
    const eventCount = renderEventMarkers(data, identity);
    text('chartBasis', basis + (data.snapshot?.historyWarning === 'continuous-series-may-contain-roll-gap' ? ' · 连续合约换月可能产生跳空' : '') + (eventCount ? ' · 事件按发布时间标记' : ''));
  }
  function renderSnapshot(payload, options = {}) {
    if (!validatePayload(payload, state.range)) payload = unavailablePayload();
    state.snapshot = payload;
    state.cached = Boolean(options.cached);
    if (finite(options.lastSuccessAt)) state.lastSuccessAt = options.lastSuccessAt;
    for (const key of ['brent', 'wti']) renderQuote(key, payload?.instruments?.[key]);
    renderSpread(payload);
    const status = renderStatus(payload, options.error);
    renderChart();
    return { status, snapshot: payload, cached: state.cached };
  }
  function unavailablePayload() { return { schemaVersion: 1, range: state.range, instruments: { brent: null, wti: null }, spread: null }; }
  async function fetchJson(url, controller) {
    const timeout = root.setTimeout(() => controller.abort(), 16000);
    try {
      const response = await root.fetch(url, { signal: controller.signal, cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return await response.json();
    } finally { root.clearTimeout(timeout); }
  }
  function refresh(options = {}) {
    init();
    const range = RANGES.has(options.range) ? options.range : state.range;
    if (state.promise && state.pendingRange === range && !options.force) return state.promise;
    if (options.ifDue && !options.force && (root.document?.visibilityState === 'hidden'
      || (range === state.range && state.lastRequestAt != null && Date.now() - state.lastRequestAt < QUOTE_REFRESH_MS))) {
      return Promise.resolve({ status: overallStatus(state.snapshot), snapshot: state.snapshot, cached: state.cached });
    }
    state.range = range;
    updatePressed();
    renderChart();
    state.controller?.abort();
    const controller = new root.AbortController();
    state.controller = controller;
    const requestId = ++state.requestId;
    state.pendingRange = range;
    state.lastRequestAt = Date.now();
    const button = element('marketRefresh');
    if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
    state.promise = (async () => {
      try {
        const payload = await fetchJson(apiBase() + '/api/market?range=' + encodeURIComponent(range), controller);
        if (!validatePayload(payload, range)) throw new Error('Invalid market snapshot');
        if (requestId !== state.requestId) return { status: 'superseded', snapshot: state.snapshot, cached: state.cached };
        writeCache(payload, range);
        const result = renderSnapshot(payload, { lastSuccessAt: nowSeconds() });
        void loadCurve();
        return result;
      } catch (error) {
        if (requestId !== state.requestId) return { status: 'superseded', snapshot: state.snapshot, cached: state.cached };
        const cache = readCache(range);
        const result = cache ? renderSnapshot(cache.payload, { cached: true, lastSuccessAt: cache.storedAt / 1000, error }) : renderSnapshot(unavailablePayload(), { error });
        void loadCurve();
        return { ...result, error: error.name === 'AbortError' ? 'timeout' : 'unavailable' };
      } finally {
        if (requestId === state.requestId) {
          state.promise = null;
          state.pendingRange = null;
          if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
        }
      }
    })();
    return state.promise;
  }
  function curveMessage(reason) {
    const known = {
      unavailable: '合约数据暂不可用，可点击重试', 'no-verified-contracts': '合约到期日待核对，暂不计算月差',
      stale: '合约报价已过期，暂不计算月差', unaligned: '合约报价时间未对齐，暂不计算月差',
    };
    return known[reason] || '合约价格或到期日未通过核对，暂不计算月差';
  }
  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  function curveConfig(instrument) {
    return instrument === 'brent' ? { symbol: /^ICEEUR:BRN([FGHJKMNQUVXZ])(\d{4})$/, exchange: 'ICE Futures Europe', session: core()?.SESSION_CONFIGS.ICE_BRENT }
      : instrument === 'wti' ? { symbol: /^NYMEX:CL([FGHJKMNQUVXZ])(\d{4})$/, exchange: 'NYMEX', session: core()?.SESSION_CONFIGS.NYMEX_ENERGY } : null;
  }
  function curveTradingDate(config) {
    return core()?.getTradingDate(nowSeconds(), config.session) || new Intl.DateTimeFormat('en-CA', {
      timeZone: config.session.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(nowSeconds() * 1000));
  }
  function validCurveContract(item, payload) {
    const config = curveConfig(payload?.instrument);
    const symbol = config?.symbol.exec(item?.symbol || '');
    if (!config?.session || payload.instrument !== state.curveInstrument || payload.source !== 'tradingview'
      || payload.exchange !== config.exchange || item?.exchange !== config.exchange || !symbol) return false;
    const month = `${symbol[2]}-${String('FGHJKMNQUVXZ'.indexOf(symbol[1]) + 1).padStart(2, '0')}`;
    return finite(item.price) && item.source === payload.source && item.currency === 'USD'
      && item.deliveryMonth === month && validDate(month + '-01') && validDate(item.expiration)
      && item.expiration >= curveTradingDate(config) && item.expiration.slice(0, 7) <= month
      && finite(observationTime(item)) && observationTime(item) > 0 && observationTime(item) <= nowSeconds() + 120;
  }
  function validCurveContracts(payload) {
    const contracts = payload?.contracts;
    if (payload?.schemaVersion !== 1 || !Array.isArray(contracts) || !contracts.every(item => validCurveContract(item, payload))) return false;
    const symbols = new Set(), months = new Set();
    return contracts.every((item, i) => {
      if (symbols.has(item.symbol) || months.has(item.deliveryMonth)
        || (i && (item.expiration <= contracts[i - 1].expiration || item.deliveryMonth <= contracts[i - 1].deliveryMonth))) return false;
      symbols.add(item.symbol); months.add(item.deliveryMonth);
      return true;
    });
  }
  function curveSpread(payload, rightIndex) {
    if (payload?.status !== 'available' || payload?.cache === 'stale' || !validCurveContracts(payload)) return null;
    const left = payload.contracts?.[0], right = payload.contracts?.[rightIndex];
    if (![left, right].every(item => validCurveContract(item, payload)) || [left, right].some(item => !['fresh', 'delayed'].includes(quoteStatus(item)))
      || left.source !== right.source || left.currency !== right.currency || left.delaySeconds !== right.delaySeconds
      || Math.abs(observationTime(left) - observationTime(right)) > 300) return null;
    const value = payload.spreads?.[rightIndex === 1 ? 'm1m2' : 'm1m3'];
    return finite(value) && Math.abs(left.price - right.price - value) < .02 ? value : null;
  }
  function renderCurve(payload, options = {}) {
    state.curveSnapshot = payload;
    const rows = element('curveRows'), summary = element('curveSummary');
    const contracts = validCurveContracts(payload) ? payload.contracts : [];
    if (rows) rows.innerHTML = contracts.length ? contracts.map(item => `<tr><td>${escapeHtml(item.deliveryMonth || item.contract)}<span class="contract-symbol">${escapeHtml(item.symbol)}<br>到期 ${escapeHtml(item.expiration)}</span></td><td>$${money(item.price)}</td><td>${escapeHtml(formatTime(observationTime(item)))}<span class="contract-symbol">${item.timeBasis === 'provider-update' ? '源更新 · ' : '行情 · '}${escapeHtml(statusLabel(item))}</span></td></tr>`).join('') : `<tr><td colspan="3" class="table-empty">${options.loading ? '正在核对所选品种的合约报价…' : '暂无通过核对的合约报价'}</td></tr>`;
    const m1m2 = curveSpread(payload, 1), m1m3 = curveSpread(payload, 2);
    if (summary) {
      const parts = [];
      if (finite(m1m2)) parts.push(`<div>M1 − M2<strong>${money(m1m2, true)}</strong></div>`);
      if (finite(m1m3)) parts.push(`<div>M1 − M3<strong>${money(m1m3, true)}</strong></div>`);
      if (finite(m1m2)) parts.push(`<span class="curve-shape">${m1m2 > 0 ? '近月升水' : m1m2 < 0 ? '远月升水' : '曲线平坦'}</span>`);
      summary.innerHTML = parts.length ? parts.join('') : '<span>近远月价差待核对</span>';
    }
    const hasSpread = finite(m1m2) || finite(m1m3);
    const stale = payload?.status === 'stale' || contracts.some(item => ['stale', 'unavailable'].includes(quoteStatus(item)));
    const description = options.loading ? '正在核对合约报价…' : contracts.length
      ? `${sourceLabel(payload)} · 最近未到期合约，与连续主力换月口径不同。${stale ? '缓存或过期报价，月差暂不显示。' : hasSpread ? '月差按源更新时间对齐；源更新时间并非成交时间。' : '源更新时间或价格未对齐，月差暂不显示。'}`
      : curveMessage(payload?.reason || payload?.status);
    text('curveStatus', description);
    const section = element('curveRows');
    if (section) section.setAttribute('aria-busy', String(Boolean(options.loading)));
  }
  async function loadCurve() {
    state.curveController?.abort();
    const controller = new root.AbortController();
    state.curveController = controller;
    const id = ++state.curveRequestId;
    const selected = state.curveInstrument;
    renderCurve(null, { loading: true });
    const button = element('curveRefresh');
    if (button) button.disabled = true;
    try {
      const payload = await fetchJson(apiBase() + '/api/curve?instrument=' + selected, controller);
      if (id !== state.curveRequestId || selected !== state.curveInstrument) return;
      if (payload.schemaVersion !== 1 || payload.instrument !== selected || !['available', 'unavailable', 'stale'].includes(payload.status)) throw new Error('Invalid curve instrument');
      renderCurve(payload);
    } catch {
      if (id === state.curveRequestId) renderCurve({ status: 'unavailable' });
    } finally {
      if (id === state.curveRequestId && button) button.disabled = false;
    }
  }
  function updatePressed() {
    for (const el of root.document?.querySelectorAll('[data-chart-range]') || []) el.setAttribute('aria-pressed', String(el.dataset.chartRange === state.range));
    for (const el of root.document?.querySelectorAll('[data-chart-instrument]') || []) el.setAttribute('aria-pressed', String(el.dataset.chartInstrument === state.instrument));
    for (const el of root.document?.querySelectorAll('[data-curve-instrument]') || []) el.setAttribute('aria-pressed', String(el.dataset.curveInstrument === state.curveInstrument));
  }
  function setRange(range) {
    if (!RANGES.has(range)) return Promise.resolve(null);
    return refresh({ range });
  }
  function selectInstrument(instrument) {
    if (!INSTRUMENTS.has(instrument)) return;
    state.instrument = instrument;
    updatePressed();
    renderChart();
  }
  function bind(el, event, handler) {
    if (!el?.addEventListener) return;
    el.addEventListener(event, handler);
    state.handlers.push([el, event, handler]);
  }
  function init() {
    if (state.initialized) return;
    state.initialized = true;
    for (const el of root.document?.querySelectorAll('[data-chart-range]') || []) bind(el, 'click', () => setRange(el.dataset.chartRange));
    for (const el of root.document?.querySelectorAll('[data-chart-instrument]') || []) bind(el, 'click', () => selectInstrument(el.dataset.chartInstrument));
    for (const el of root.document?.querySelectorAll('[data-curve-instrument]') || []) bind(el, 'click', () => {
      if (!['brent', 'wti'].includes(el.dataset.curveInstrument)) return;
      state.curveInstrument = el.dataset.curveInstrument;
      updatePressed();
      text('curveStatus', '正在核对合约报价…');
      loadCurve();
    });
    bind(element('marketRefresh'), 'click', () => refresh({ force: true }));
    bind(element('curveRefresh'), 'click', () => loadCurve());
    bind(root.document, 'visibilitychange', () => {
      if (root.document.visibilityState !== 'hidden') return refresh({ ifDue: true });
    });
    state.ageTimer = root.setInterval(() => {
      if (state.snapshot) renderSnapshot(state.snapshot, { cached: state.cached });
      if (state.curveSnapshot) renderCurve(state.curveSnapshot);
      if (root.document?.visibilityState !== 'hidden') return refresh({ ifDue: true });
    }, QUOTE_REFRESH_MS);
    updatePressed();
  }
  function destroy() {
    state.controller?.abort(); state.curveController?.abort();
    for (const [el, event, handler] of state.handlers) el.removeEventListener?.(event, handler);
    state.handlers = [];
    root.clearInterval(state.ageTimer);
    state.resizeObserver?.disconnect();
    clearEventMarkers();
    state.chart?.remove();
    state.chart = state.series = state.referenceLine = state.resizeObserver = null;
    state.chartIdentity = null;
    state.initialized = false;
    state.lastRequestAt = null;
    state.requestId += 1; state.curveRequestId += 1;
    state.promise = state.pendingRange = null;
  }
  root.OilMarketUI = { init, refresh, renderSnapshot, setRange, selectInstrument, setEvents, destroy };
  root.__oilMarketUITestHooks = { validReference, referenceText, normalizedSeries, validatePayload, readCache, writeCache, quoteStatus, overallStatus, renderCurve, chartData, chartTick, formatTime, state, CACHE_PREFIX, CACHE_TTL_MS };
})(globalThis);
