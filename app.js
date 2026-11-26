// Oil Dashboard: editorial feeds. Market arithmetic lives in shared/market-core.js.
// The Worker returns complete provider snapshots; this file never reconstructs price references.

const REFRESH_MS = 5 * 60 * 1000;
const OOTT_LIVE_CACHE_KEY = 'oil_oott_live_v1';
const OOTT_LIVE_CACHE_TTL_MS = 10 * 60 * 1000;
const OOTT_LIVE_LOOKBACK_MS = 72 * 60 * 60 * 1000;
const IRAN_CACHE_KEY = 'oil_iran_news_cache_v2';
const FEED_EVENTS_CACHE_KEY = 'oil_feed_news_market_cache_v2';
const FEED_POSTS_CACHE_KEY = 'oil_feed_news_geo_cache_v2';
const POLYMARKET_CACHE_KEY = 'oil_polymarket_gamma_cache_v2';
const POLYMARKET_API_URL = 'https://gamma-api.polymarket.com/events/keyset?closed=false&limit=8&tag_slug=oil';
const OOTT_FALLBACK_HANDLES = [
  'JuneGoh_Sparta', 'JavierBlas', 'JKempEnergy', 'HFI_Research', 'Rory_Johnston',
  'staunovo', 'TankerTrackers', 'OilHeadlineNews', 'Ole_S_Hansen',
];
// 部署 workers/proxy.js 到 Cloudflare 后填入 URL，留空则用公共代理
const CF_WORKER_URL = 'https://oil-proxy.xzregproxy.workers.dev';

const state = { sources: null, feedItems: [], countdownId: null, oottLoadPromise: null };

// ========== Utilities ==========
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function formatSGT(date) {
  if (!date) return '';
  try {
    return date.toLocaleString('zh-CN', {
      timeZone: 'Asia/Singapore', hour12: false,
      month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric'
    }) + ' SGT';
  } catch { return ''; }
}

function formatSGTPrecise(date) {
  if (!date) return '';
  try {
    return date.toLocaleString('zh-CN', {
      timeZone: 'Asia/Singapore', hour12: false,
      month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'
    }) + ' SGT';
  } catch { return ''; }
}

function formatSGTCompact(date) {
  if (!date) return '';
  try {
    return date.toLocaleString('zh-CN', {
      timeZone: 'Asia/Singapore', hour12: false,
      month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric'
    });
  } catch { return ''; }
}

function readStorageJson(key) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : null;
  } catch { return null; }
}

function writeStorageJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function readTextCache(key) {
  const cached = readStorageJson(key);
  return typeof cached?.text === 'string' ? cached : null;
}

function writeTextCache(key, text) {
  if (!key || typeof text !== 'string' || !text.trim()) return;
  writeStorageJson(key, { text, ts: Date.now() });
}

function parseDateMs(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function getDatePartsInTimeZone(dateLike = new Date(), timeZone = 'UTC') {
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value])
    );
    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
    };
  } catch { return null; }
}

function getSgtDateParts(dateLike = new Date()) {
  return getDatePartsInTimeZone(dateLike, 'Asia/Singapore');
}

function getSGTDayKey(dateLike) {
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(date.getTime())) return '';
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value])
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch { return ''; }
}

function getPolymarketConditionExpiryMs(label, now = new Date()) {
  const parts = getSgtDateParts(now);
  if (!parts) return null;

  let match = String(label || '').match(/^(\d{1,2})月(\d{1,2})日$/);
  if (match) {
    const [, month, day] = match.map(Number);
    return Date.UTC(parts.year, month - 1, day, 15, 59, 59, 999);
  }

  match = String(label || '').match(/^(\d{1,2})月底$/);
  if (match) {
    const month = Number(match[1]);
    return Date.UTC(parts.year, month, 0, 15, 59, 59, 999);
  }

  return null;
}

function filterActivePolymarketConditions(conditions, now = new Date()) {
  return (conditions || []).filter(condition => {
    const expiryMs = getPolymarketConditionExpiryMs(condition?.label, now);
    return expiryMs == null || expiryMs >= now.getTime();
  });
}

function normalizeOottPost(item, fallbackUsername = '') {
  if (!item || typeof item !== 'object') return null;
  const createdMs = parseDateMs(item.createdAt || item.created_at);
  if (!createdMs) return null;
  return {
    text: item.text || '',
    createdAt: new Date(createdMs).toISOString(),
    username: item.username || item.handle || fallbackUsername,
    url: safeHttpUrl(item.url),
    photos: Array.isArray(item.photos) ? item.photos : [],
    videos: Array.isArray(item.videos) ? item.videos : [],
    engagement: item.engagement || '',
  };
}

function getCapduckProxyUrl(target) {
  return CF_WORKER_URL ? `${CF_WORKER_URL}?url=${encodeURIComponent(target)}` : null;
}

function buildCapduckCandidates(target) {
  const proxyUrl = getCapduckProxyUrl(target);
  if (proxyUrl) return [proxyUrl];
  return [target];
}

async function fetchTextWithCache(candidates, cacheKey) {
  let lastError = null;
  for (const url of candidates) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10000), cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      writeTextCache(cacheKey, text);
      return { text, cached: false, error: null };
    } catch (error) {
      lastError = error;
      console.warn('Fetch text fail:', url, error);
    }
  }
  const cached = readTextCache(cacheKey);
  if (cached?.text) return { text: cached.text, cached: true, error: lastError };
  return { text: null, cached: false, error: lastError };
}

async function fetchCapduckText(target, cacheKey) {
  return fetchTextWithCache(buildCapduckCandidates(target), cacheKey);
}

async function fetchJsonWithCache(target, cacheKey) {
  const result = await fetchTextWithCache(buildCapduckCandidates(target), cacheKey);
  if (!result.text || typeof result.text !== 'string') {
    return { data: null, cached: result.cached, error: result.error };
  }
  try {
    return { data: JSON.parse(result.text), cached: result.cached, error: null };
  } catch (error) {
    console.warn('Parse json fail:', target, error);
    return { data: null, cached: result.cached, error };
  }
}

function canonicalNewsUrl(value) {
  const safe = safeHttpUrl(value);
  if (!safe) return '';
  const url = new URL(safe);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|ref$)/i.test(key)) url.searchParams.delete(key);
  }
  return url.href;
}

function dedupeNewsItems(items) {
  const groups = [];
  for (const item of items || []) {
    if (!item?.title || !safeHttpUrl(item.link)) continue;
    const title = item.title.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const link = canonicalNewsUrl(item.link);
    const published = parseDateMs(item.pubDate);
    const existing = groups.find(group => (group.linkKey === link || group.titleKey === title) &&
      (published == null || group.published == null || Math.abs(published - group.published) <= 86400000));
    if (existing) {
      if (item.source) existing.sources.add(item.source);
      if ((published || 0) > (existing.published || 0)) {
        existing.item = { ...item };
        existing.published = published;
      }
    } else groups.push({ item: { ...item }, titleKey: title, linkKey: link, published, sources: new Set(item.source ? [item.source] : []) });
  }
  return groups.sort((a, b) => (b.published || 0) - (a.published || 0))
    .map(group => ({ ...group.item, relatedSources: [...group.sources] }));
}

function impactClass(value) { return value >= 8 ? 'impact-high' : value >= 5 ? 'impact-mid' : 'impact-low'; }

function categorizeNewsHeadline(title = '') {
  const lower = title.toLowerCase();
  if (/(iran|hormuz|tanker|shadow fleet|sanction|kharg)/.test(lower)) return 'Geo';
  if (/(refinery|diesel|gasoline|jet fuel|outage|crack)/.test(lower)) return 'Refinery';
  if (/(brent|wti|opec|crude|production|exports)/.test(lower)) return 'Market';
  return 'News';
}

function scoreNewsImpact(title = '') {
  const lower = title.toLowerCase();
  let score = 5;
  if (/(hormuz|blockade|closure|attack|strike|missile|seized|terminal|sanction)/.test(lower)) score += 3;
  if (/(opec|brent|wti|refinery|tanker|exports|production|supply)/.test(lower)) score += 1;
  if (/(analysis|opinion|explainer)/.test(lower)) score -= 1;
  return Math.max(3, Math.min(9, score));
}

function scoreIranTension(items) {
  let score = 4;
  for (const item of (items || []).slice(0, 6)) {
    const lower = String(item?.title || '').toLowerCase();
    if (/(hormuz|blockade|closure|attack|strike|missile|terminal|seized|sanction)/.test(lower)) score += 1;
    if (/(deal|talks|ceasefire|resume|reopen|easing)/.test(lower)) score -= 1;
  }
  return Math.max(1, Math.min(10, score));
}

function buildFeedEventFromNews(item) {
  return {
    type: 'event',
    impact: scoreNewsImpact(item.title),
    category: categorizeNewsHeadline(item.title),
    title: item.title,
    body: (item.relatedSources || []).length > 1 ? `同题报道：${item.relatedSources.join(' · ')}` : '',
    time: formatSGT(new Date(item.pubDate)),
    publishedAt: (parseDateMs(item.pubDate) || 0) / 1000,
    sources: item.relatedSources?.length || (item.source ? 1 : 0),
    sentiment: item.source || '',
    link: item.link,
  };
}

function parsePolymarketProbPct(market) {
  try {
    const outcomes = JSON.parse(market?.outcomes || '[]');
    const prices = JSON.parse(market?.outcomePrices || '[]').map(Number);
    const yesIndex = outcomes.findIndex(outcome => String(outcome).toLowerCase() === 'yes');
    const value = yesIndex >= 0 ? prices[yesIndex] : prices[0];
    if (!Number.isFinite(value)) return null;
    return `${Math.round(value * 100)}%`;
  } catch {
    return null;
  }
}

function isRelevantOilPolymarketEvent(event) {
  const marketTitles = Array.isArray(event?.markets) ? event.markets.map(market => market?.question || '').join(' ') : '';
  const haystack = `${event?.title || ''} ${event?.slug || ''} ${marketTitles}`.toLowerCase();
  return /(oil|crude|hormuz|kharg|iran|tanker|reserves|brent|wti)/.test(haystack);
}

function buildPolymarketContracts(payload) {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  const nowMs = Date.now();
  return events.filter(isRelevantOilPolymarketEvent).map(event => {
    const markets = Array.isArray(event?.markets) ? event.markets : [];
    const conditions = markets.map(market => ({
      label: market.groupItemTitle || market.question || 'Yes',
      prob: parsePolymarketProbPct(market),
      dir: market.endDate ? `结算 ${formatSGTCompact(new Date(market.endDate))}` : '',
      expiryMs: parseDateMs(market.endDate) || null,
    })).filter(condition => condition.prob && (condition.expiryMs == null || condition.expiryMs >= nowMs))
      .map(({ expiryMs, ...condition }) => condition);
    return {
      question: event.title,
      link: event.slug ? `https://polymarket.com/event/${event.slug}` : 'https://polymarket.com/',
      conditions,
      endDate: parseDateMs(event.endDate) || 0,
    };
  }).filter(contract => contract.conditions.length).sort((a, b) => a.endDate - b.endDate);
}

function getOriginDebugHint() {
  if (typeof location !== 'undefined' && location.protocol === 'file:') {
    return '当前是 file:// 本地直开，浏览器会拦截更多跨域请求；建议改用 http://127.0.0.1:8080 打开。';
  }
  return '';
}

function renderUnavailableState(label, extra = '') {
  const hint = [extra, getOriginDebugHint()].filter(Boolean).join(' ');
  return `<div class="loading-spinner"><span style="color:var(--text-dim)">${escapeHtml(label)} 暂时不可用</span>${
    hint ? `<div style="font-size:12px;color:var(--text-muted);margin-top:8px;line-height:1.5">${escapeHtml(hint)}</div>` : ''
  }</div>`;
}

function getLatestCreatedMs(posts) {
  let latest = 0;
  for (const post of posts || []) {
    const ms = parseDateMs(post?.createdAt);
    if (ms && ms > latest) latest = ms;
  }
  return latest;
}

function needsLiveOottRefresh(posts, now = new Date()) {
  const latestMs = getLatestCreatedMs(posts);
  if (!latestMs) return true;
  return getSGTDayKey(latestMs) !== getSGTDayKey(now);
}

function mergeOottPosts(staticPosts, livePosts) {
  const deduped = new Map();
  for (const post of [...(staticPosts || []), ...(livePosts || [])]) {
    const normalized = normalizeOottPost(post, post?.username || post?.handle || '');
    if (!normalized) continue;
    const key = normalized.url || `${normalized.username}|${normalized.createdAt}|${normalized.text}`;
    const existing = deduped.get(key);
    if (!existing || parseDateMs(normalized.createdAt) > parseDateMs(existing.createdAt)) deduped.set(key, normalized);
  }
  return [...deduped.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getOottHandles(staticPosts = []) {
  const fromStatic = [...new Set((staticPosts || []).map(post => post?.username).filter(Boolean))];
  if (fromStatic.length >= 4) return fromStatic;

  const fromSources = [];
  if (state.sources && typeof state.sources === 'object') {
    for (const group of Object.values(state.sources)) {
      if (!Array.isArray(group?.accounts)) continue;
      for (const account of group.accounts) {
        const handle = account?.handle?.replace(/^@/, '');
        if (handle) fromSources.push(handle);
      }
    }
  }
  return [...new Set((fromSources.length ? fromSources : OOTT_FALLBACK_HANDLES))];
}

function readCachedLiveOott(handles) {
  try {
    const cached = JSON.parse(localStorage.getItem(OOTT_LIVE_CACHE_KEY));
    if (!cached || Date.now() - cached.ts > OOTT_LIVE_CACHE_TTL_MS) return null;
    const cachedHandles = Array.isArray(cached.handles) ? cached.handles.join(',') : '';
    if (cachedHandles !== handles.join(',')) return null;
    return Array.isArray(cached.posts) ? cached.posts : null;
  } catch { return null; }
}

function writeCachedLiveOott(handles, posts) {
  try {
    localStorage.setItem(OOTT_LIVE_CACHE_KEY, JSON.stringify({ handles, posts, ts: Date.now() }));
  } catch {}
}

async function safeFetch(url, retries = 1) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      try { return JSON.parse(text); } catch { return text; }
    } catch (e) {
      if (i === retries) { console.warn('Fetch fail:', url, e); return null; }
      await new Promise(r => setTimeout(r, 800));
    }
  }
}

async function fetchLiveOottPosts(handles, staticLatestMs = 0) {
  if (!CF_WORKER_URL || !handles.length) return [];
  const cacheKeyHandles = [...handles].sort();
  const cached = readCachedLiveOott(cacheKeyHandles);
  if (cached) return cached;

  const responses = await Promise.all(handles.map(async handle => {
    const data = await safeFetch(`${CF_WORKER_URL}?twitter=${encodeURIComponent(handle)}`, 0);
    if (!Array.isArray(data)) return [];
    return data.map(post => normalizeOottPost(post, handle)).filter(Boolean);
  }));

  const cutoff = staticLatestMs
    ? Math.max(staticLatestMs - 12 * 60 * 60 * 1000, Date.now() - OOTT_LIVE_LOOKBACK_MS)
    : Date.now() - OOTT_LIVE_LOOKBACK_MS;
  const posts = mergeOottPosts([], responses.flat().filter(post => parseDateMs(post.createdAt) >= cutoff));
  writeCachedLiveOott(cacheKeyHandles, posts);
  return posts;
}

async function loadOottSnapshot() {
  if (state.oottLoadPromise) return state.oottLoadPromise;
  state.oottLoadPromise = (async () => {
    const staticData = await safeFetch('data/oott.json?t=' + Date.now(), 0);
    const staticPosts = Array.isArray(staticData) ? staticData.map(post => normalizeOottPost(post)).filter(Boolean) : [];
    let posts = staticPosts;
    let usingLiveSupplement = false;

    if (needsLiveOottRefresh(staticPosts)) {
      const livePosts = await fetchLiveOottPosts(getOottHandles(staticPosts), getLatestCreatedMs(staticPosts));
      if (livePosts.length) {
        posts = mergeOottPosts(staticPosts, livePosts);
        usingLiveSupplement = getLatestCreatedMs(posts) > getLatestCreatedMs(staticPosts);
      }
    }

    return { posts, usingLiveSupplement };
  })();

  try {
    return await state.oottLoadPromise;
  } finally {
    state.oottLoadPromise = null;
  }
}

// ========== Tab switching ==========
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab + 'Panel').classList.add('active');
  });
});

// ========== Keyboard shortcuts ==========
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'r' || e.key === 'R') { e.preventDefault(); refresh(); }
  if (e.key >= '1' && e.key <= '4') {
    e.preventDefault();
    const tabs = document.querySelectorAll('.tab');
    if (tabs[parseInt(e.key) - 1]) tabs[parseInt(e.key) - 1].click();
  }
});

// ========== Market snapshots ==========
async function loadSources() {
  const data = await safeFetch('sources.json', 0);
  if (data && typeof data === 'object') state.sources = data;
}

async function fetchPrices(options = {}) {
  if (!globalThis.OilMarketUI) {
    const el = document.getElementById('sourceStatus');
    if (el) el.textContent = '行情模块未加载';
    return { status: 'unavailable' };
  }
  return globalThis.OilMarketUI.refresh(options);
}

// ========== Countdown ==========
function startCountdown() {
  if (state.countdownId) clearInterval(state.countdownId);
  let remaining = REFRESH_MS;
  const el = document.getElementById('countdownTimer');
  if (!el) return;
  el.title = '资讯每 5 分钟刷新；行情每分钟检查，切回页面时自动补刷新';
  el.setAttribute?.('aria-label', '资讯刷新倒计时；行情每分钟检查');
  state.countdownId = setInterval(() => {
    remaining -= 1000;
    if (remaining <= 0) remaining = REFRESH_MS;
    const m = Math.floor(remaining / 60000), s = Math.floor((remaining % 60000) / 1000);
    el.textContent = `${m}:${s.toString().padStart(2, '0')}`;
  }, 1000);
}

function marketApiBase() {
  return globalThis.OIL_API_BASE ?? (typeof location !== 'undefined' && ['localhost', '127.0.0.1'].includes(location.hostname) ? location.origin : CF_WORKER_URL);
}

async function fetchEditorialNews(topic, cacheKey) {
  try {
    const response = await fetch(`${marketApiBase()}/api/news?topic=${topic}`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error('editorial-unavailable');
    const payload = await response.json();
    if (payload.schemaVersion !== 1 || payload.topic !== topic || !Array.isArray(payload.items)) throw new Error('editorial-invalid');
    const items = payload.items.filter(item => item?.title && safeHttpUrl(item.link) && parseDateMs(item.pubDate));
    if (!items.length) throw new Error('editorial-empty');
    const result = { items, fetchedAt: payload.fetchedAt, cached: payload.cache === 'stale' };
    writeStorageJson(cacheKey + '_rss_v1', result);
    return result;
  } catch {
    const cached = readStorageJson(cacheKey + '_rss_v1');
    if (cached && Number.isFinite(cached.fetchedAt) && Date.now() / 1000 - cached.fetchedAt < 6 * 3600 && cached.fetchedAt <= Date.now() / 1000 + 60 && Array.isArray(cached.items)) return { ...cached, cached: true };
    return { items: [], cached: false };
  }
}

// ========== Iran ==========
async function fetchIranBriefing() {
  const result = await fetchEditorialNews('geo', IRAN_CACHE_KEY);
  const items = dedupeNewsItems(result.items).slice(0, 6);
  const el = document.getElementById('iranContent');
  if (!items.length) {
    document.getElementById('tensionValue').textContent = '—';
    document.getElementById('tensionDesc').textContent = 'Iran 新闻流暂不可用';
    el.innerHTML = renderUnavailableState('伊朗简报', 'Iran 关键词新闻源当前不可用。');
    return;
  }
  const top = items[0];
  document.getElementById('tensionValue').textContent = `${scoreIranTension(items)}/10`;
  document.getElementById('tensionDesc').textContent = top.title.substring(0, 40);

  let html = `<div style="font-size:12px;color:${result.cached ? 'var(--accent-gold)' : 'var(--text-muted)'};margin-bottom:12px;padding:4px 8px">
    🇮🇷 已刷新 ${formatSGT(new Date())} · Iran / Hormuz / 制裁 · 原始来源见各条新闻${result.cached ? ' · 使用上次成功缓存' : ''}</div>`;
  for (const item of items) {
    html += `<a class="iran-section" href="${escapeHtml(item.link)}" target="_blank" rel="noopener noreferrer" style="display:block;text-decoration:none;color:inherit">
      <h3>${escapeHtml(item.title)}</h3>
      <div style="font-size:13px;color:var(--text-dim);line-height:1.7">${escapeHtml(item.source || 'Google News')} · ${escapeHtml(formatSGT(new Date(item.pubDate)))}</div></a>`;
  }
  el.innerHTML = html || '<p style="color:var(--text-dim)">暂无数据</p>';
}

// ========== Events / Posts parsing ==========
function parseEvents(text) {
  if (!text || typeof text !== 'string') return [];
  const events = [], blocks = text.split(/^## /m).filter(s => s.trim());
  for (const block of blocks) {
    const lines = block.split('\n'), header = lines[0];
    const m = header.match(/[🔴🟡🟢⚪]\s*\[(\d+)\]\s*(\w+):\s*(.+)/);
    if (!m) continue;
    const body = []; let time = '', sources = 0, sentiment = '';
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i];
      const tm = l.match(/Time:\s*(.+?)(?:\s*\||$)/); if (tm) time = tm[1].trim();
      const sm = l.match(/Sources\s*\((\d+)\)/); if (sm) sources = parseInt(sm[1]);
      const se = l.match(/Sentiment:\s*(\w+)/); if (se) sentiment = se[1];
      if (l.startsWith('>') && l.includes('Drill down')) continue;
      if (l.startsWith('>')) body.push(l.replace(/^>\s*/, ''));
      else if (!l.startsWith('-') && !l.startsWith('#') && !l.startsWith('>') && l.trim()
        && !l.match(/^(ID|Time|Sources|Sentiment|Confidence):/)) body.push(l.trim());
    }
    events.push({ type:'event', impact:parseInt(m[1]), category:m[2],
      title:m[3].trim(), body:body.join(' ').substring(0,300), time, sources, sentiment });
  }
  return events;
}

function parsePosts(text) {
  if (!text || typeof text !== 'string') return [];
  const posts = [], blocks = text.split(/^## /m).filter(s => s.trim());
  for (const block of blocks) {
    const lines = block.split('\n'), header = lines[0];
    const m = header.match(/\*\*(.+?)\*\*\s*\[(.+?)\]\s*@?(\S+)?/);
    if (!m) continue;
    let time='', platform='', link='', engagement='';
    const zhLines=[], origLines=[];
    for (let i=1; i<lines.length; i++) {
      const l = lines[i];
      let r; if ((r=l.match(/Time:\s*(.+)/))) { time=r[1].trim(); continue; }
      if ((r=l.match(/Platform:\s*(\w+)/))) { platform=r[1]; continue; }
      if ((r=l.match(/Link:\s*(https?\S+)/))) { link=r[1]; continue; }
      if ((r=l.match(/Engagement:\s*(.+)/))) { engagement=r[1].trim(); continue; }
      if (l.startsWith('- ')||l.startsWith('---')||!l.trim()) continue;
      if (l.startsWith('>')) zhLines.push(l.replace(/^>\s*/,''));
      else if (l.trim()) origLines.push(l.trim());
    }
    posts.push({ type:'post', author:m[1], category:m[2], handle:m[3]||'',
      time, platform, link, engagement,
      zhBody:zhLines.join('\n').substring(0,500), origBody:origLines.join('\n').substring(0,500),
      body:(zhLines.length?zhLines:origLines).join('\n').substring(0,500) });
  }
  return posts;
}

// ========== Feed rendering + filtering ==========
function renderFeedItems(items) {
  const el = document.getElementById('feedList');
  if (!items.length) {
    el.innerHTML = '<div class="loading-spinner"><span style="color:var(--text-dim)">暂无新事件 — 5分钟后刷新</span></div>';
    return;
  }
  let html = '';
  for (let i = 0; i < items.length; i++) {
    const item = items[i], delay = Math.min(i * 0.05, 1);
    if (item.type === 'event') {
      html += `<a class="feed-card" style="animation-delay:${delay}s" href="${escapeHtml(item.link || '#')}" target="_blank" rel="noopener noreferrer">
        <div class="card-header"><span class="card-type event">${escapeHtml(item.category)}</span><span class="card-time">${escapeHtml(item.time)}</span></div>
        <div class="card-title">${escapeHtml(item.title)}</div>
        ${item.body?`<div class="card-body">${escapeHtml(item.body)}</div>`:''}
        <div class="card-meta"><span class="impact ${impactClass(item.impact)}">Impact ${item.impact}</span>
          ${item.sources?`<span class="sources-count">📡 ${item.sources} sources</span>`:''}
          ${item.sentiment?`<span style="color:var(--text-muted)">${escapeHtml(item.sentiment)}</span>`:''}</div></a>`;
    } else {
      const zh = item.zhBody ? `<div class="card-body" style="white-space:pre-wrap">${escapeHtml(item.zhBody)}</div>` : '';
      const orig = item.origBody ? `<div class="card-body" style="white-space:pre-wrap;font-size:11px;color:var(--text-muted);margin-top:6px;border-top:1px solid var(--border);padding-top:6px">${escapeHtml(item.origBody)}</div>` : '';
      const main = zh || `<div class="card-body" style="white-space:pre-wrap">${escapeHtml(item.origBody||'')}</div>`;
      html += `<a class="feed-card" style="animation-delay:${delay}s" href="${escapeHtml(item.link)}" target="_blank" rel="noopener noreferrer">
        <div class="card-header"><span class="card-type tweet">${escapeHtml(item.platform||'post')}</span><span class="card-time">${escapeHtml(item.time)}</span></div>
        <div class="card-title"><span style="color:var(--accent-blue)">@${escapeHtml(item.handle)}</span>
          <span style="color:var(--text-muted);font-size:12px;margin-left:6px">${escapeHtml(item.author)}</span>
          <span style="color:var(--text-muted);font-size:11px;margin-left:6px">[${escapeHtml(item.category)}]</span></div>
        ${main}${zh?orig:''}
        ${item.engagement?`<div class="card-meta"><span class="engagement">📊 ${escapeHtml(item.engagement)}</span></div>`:''}</a>`;
    }
  }
  el.innerHTML = html;
}

async function buildFeed() {
  const [marketResult, geoResult, oottSnapshot] = await Promise.all([
    fetchEditorialNews('market', FEED_EVENTS_CACHE_KEY),
    fetchEditorialNews('geo', FEED_POSTS_CACHE_KEY),
    loadOottSnapshot(),
  ]);
  const events = dedupeNewsItems([
    ...(marketResult.items || []),
    ...(geoResult.items || []),
  ]).slice(0, 10).map(buildFeedEventFromNews);
  const posts = [...(oottSnapshot?.posts || [])].slice(0, 6).map(post => ({
    type: 'post',
    author: post.username,
    category: 'OOTT',
    handle: post.username || '',
    time: formatSGT(new Date(post.createdAt)),
    platform: 'OOTT',
    link: post.url,
    engagement: post.engagement ? `${post.engagement} 互动` : '',
    zhBody: '',
    origBody: post.text,
    body: post.text,
  }));
  const el = document.getElementById('feedList');
  if (!events.length && !posts.length) {
    el.innerHTML = renderUnavailableState('信息流', '新闻源与 OOTT 当前都不可用。');
    return;
  }
  const merged = []; let pi=0, ei=0;
  while (pi < posts.length || ei < events.length) {
    if (pi < posts.length) merged.push(posts[pi++]);
    if (pi < posts.length) merged.push(posts[pi++]);
    if (ei < events.length) merged.push(events[ei++]);
  }
  state.feedItems = merged;
  globalThis.OilMarketUI?.setEvents?.(events);
  renderFeedItems(merged);
  if (el && merged.length) {
    const cacheNote = (marketResult.cached || geoResult.cached) ? ' · 使用上次成功缓存' : '';
    el.innerHTML = `<div style="font-size:12px;color:${(marketResult.cached || geoResult.cached) ? 'var(--accent-gold)' : 'var(--text-muted)'};margin-bottom:12px;padding:4px 8px">
      📡 已刷新 ${formatSGT(new Date())} · 新闻来自 Oilprice / Guardian，推文来自 OOTT 白名单${cacheNote}</div>` + el.innerHTML;
  }
}

// 全局供 HTML onclick 调用
window.filterFeed = function(type) {
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === type));
  const items = type === 'all' ? state.feedItems
    : type === 'high' ? state.feedItems.filter(i => i.type === 'event' && i.impact >= 7)
    : state.feedItems.filter(i => i.type === type);
  renderFeedItems(items);
};

// ========== Polymarket ==========
async function fetchPolymarket() {
  const result = await fetchJsonWithCache(POLYMARKET_API_URL, POLYMARKET_CACHE_KEY);
  const el = document.getElementById('polyContent');
  const contracts = buildPolymarketContracts(result.data).slice(0, 6);
  if (!contracts.length) {
    el.innerHTML = renderUnavailableState('预测市场', 'Polymarket oil 市场当前不可用。');
    return;
  }
  let hiddenExpiredCount = 0;
  let html = '';
  for (const c of contracts) {
    html += `<a class="poly-card" href="${escapeHtml(c.link)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;color:inherit;display:block">
      <div class="poly-question">${escapeHtml(c.question)}</div><div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:8px">`;
    for (const d of c.conditions) {
      const p = parseInt(d.prob), color = p>=50?'var(--up)':p>=20?'var(--accent-gold)':'var(--text-muted)';
      html += `<div style="background:var(--bg);padding:8px 12px;border-radius:8px;border:1px solid var(--border)">
        <div style="font-size:11px;color:var(--text-dim)">${escapeHtml(d.label)}</div>
        <div style="font-size:20px;font-weight:800;color:${color}">${d.prob}</div>
        <div style="font-size:10px;color:var(--text-muted)">${escapeHtml(d.dir)}</div></div>`;
    }
    html += '</div></a>';
  }
  if (!html) {
    el.innerHTML = '<p style="color:var(--text-dim)">暂无 Polymarket 数据</p>';
    return;
  }
  const extraNote = hiddenExpiredCount ? ` · 已隐藏 ${hiddenExpiredCount} 个过期窗口` : '';
  const cacheNote = result.cached ? ' · 使用上次成功缓存' : '';
  el.innerHTML = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;padding:4px 8px">
    📊 已刷新 ${formatSGT(new Date())} · Polymarket oil tag · 新版 keyset 接口${extraNote}${cacheNote}</div>` + html;
}

// ========== 油市推文 (读 data/oott.json，由 OOTT cron 自动同步) ==========
async function fetchOOTT() {
  const el = document.getElementById('oottFeed');
  const snapshot = await loadOottSnapshot();
  const posts = snapshot?.posts || [];
  const usingLiveSupplement = Boolean(snapshot?.usingLiveSupplement);

  if (!posts.length) {
    el.innerHTML = `<div class="loading-spinner"><span style="color:var(--text-dim)">暂无油市推文</span>
      <a href="https://x.com/JavierBlas" target="_blank" rel="noopener noreferrer" style="color:var(--accent-blue);font-size:12px;margin-top:8px">查看 @JavierBlas →</a></div>`;
    return;
  }
  const sorted = [...posts].sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  const handles = new Set(sorted.map(t => t.username));
  const sourceLabel = usingLiveSupplement ? 'OOTT 自动同步 + 今日补拉' : 'OOTT 自动同步';
  const latestPostAt = getLatestCreatedMs(sorted);
  const lastEl = document.getElementById('dataLastSuccess');
  if (lastEl && latestPostAt) lastEl.textContent = '资讯原文最新 ' + formatSGTPrecise(new Date(latestPostAt));
  let html = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;padding:4px 8px">
    🛢️ ${sorted.length} 条 · ${handles.size} 个白名单信源 · ${sourceLabel} · 原文最新 ${escapeHtml(latestPostAt ? formatSGT(new Date(latestPostAt)) : '待确认')}</div>`;
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i], delay = Math.min(i * 0.04, 0.8);
    const timeStr = t.createdAt ? formatSGT(new Date(t.createdAt)) : '';
    const media = (t.photos?.length || t.videos?.length) ? '<span style="color:var(--accent-cyan);font-size:11px;margin-left:6px">📷</span>' : '';
    const eng = t.engagement ? `<div class="card-meta"><span class="engagement">📊 ${t.engagement} 互动</span></div>` : '';
    html += `<a class="feed-card" style="animation-delay:${delay}s" href="${escapeHtml(t.url || '#')}" target="_blank" rel="noopener noreferrer">
      <div class="card-header"><span class="card-type tweet">OOTT</span><span class="card-time">${escapeHtml(timeStr)}</span></div>
      <div class="card-title"><span style="color:var(--accent-blue)">@${escapeHtml(t.username || '')}</span>${media}</div>
      <div class="card-body" style="white-space:pre-wrap">${escapeHtml((t.text || '').substring(0, 500))}</div>
      ${eng}</a>`;
  }
  el.innerHTML = html;
}


// ========== Main ==========
async function refresh(options = {}) {
  const statusEl = document.getElementById('refreshStatus');
  if (statusEl) { statusEl.textContent = '刷新中...'; statusEl.style.opacity = '1'; }
  document.getElementById('updateTime').textContent = '检查 ' + formatSGTPrecise(new Date());
  const results = await Promise.allSettled([fetchPrices({ ifDue: Boolean(options.scheduled) }), fetchIranBriefing(), buildFeed(), fetchPolymarket(), fetchOOTT(), globalThis.OilEnergy?.refresh()]);
  const failed = results.some(result => result.status === 'rejected');
  if (failed) console.error('Dashboard section update failed; other sections remain available.');
  if (statusEl) { statusEl.textContent = failed ? '部分更新失败' : '✓'; if (!failed) setTimeout(() => { statusEl.style.opacity = '0'; }, 2000); }
  startCountdown();
}

(async () => {
  globalThis.OilMarketUI?.init();
  globalThis.OilEnergy?.init({ baseUrl: marketApiBase() });
  await loadSources();
  refresh(); // 不 await，让页面先响应
  setInterval(() => refresh({ scheduled: true }), REFRESH_MS);
  // PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW register failed:', e));
  }
})();

if (typeof globalThis !== 'undefined') {
  globalThis.__oilDashboardTestHooks = {
    formatSGTCompact, getDatePartsInTimeZone, getSgtDateParts,
    normalizeOottPost, mergeOottPosts, needsLiveOottRefresh, getSGTDayKey,
    getPolymarketConditionExpiryMs, filterActivePolymarketConditions,
    buildCapduckCandidates, dedupeNewsItems, buildFeedEventFromNews,
    safeHttpUrl, escapeHtml, fetchPrices, refresh, renderFeedItems,
  };
}
