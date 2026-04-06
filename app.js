// ========== Oil Dashboard v4 — 全面优化版 ==========
// Sparkline · 价格闪动 · Feed过滤 · 键盘快捷键 · PWA · 数据源状态 · CF Worker优先

const API_BASE = 'https://skill.capduck.com/iran';
const REFRESH_MS = 5 * 60 * 1000;
const CACHE_KEY = 'oil_v4_aligned';
// 部署 workers/proxy.js 到 Cloudflare 后填入 URL，留空则用公共代理
const CF_WORKER_URL = 'https://oil-proxy.xzregproxy.workers.dev';

const state = { sources: null, feedItems: [], countdownId: null, priceSource: 'unknown' };

// ========== Utilities ==========
function escapeHtml(t) { return t ? t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : ''; }

function formatSGT(date) {
  if (!date) return '';
  try {
    return date.toLocaleString('zh-CN', {
      timeZone: 'Asia/Singapore', hour12: false,
      month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric'
    }) + ' SGT';
  } catch { return ''; }
}

function impactClass(n) { return n >= 8 ? 'impact-high' : n >= 5 ? 'impact-mid' : 'impact-low'; }

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

// ========== Sparkline SVG ==========
function renderSparkline(containerId, closes, up) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!closes || closes.length < 3) { el.innerHTML = ''; return; }
  const w = 120, h = 28;
  const min = Math.min(...closes), max = Math.max(...closes), range = max - min || 1;
  const step = w / (closes.length - 1);
  const pts = closes.map((v, i) =>
    `${(i * step).toFixed(1)},${(h - ((v - min) / range) * (h - 4) - 2).toFixed(1)}`
  ).join(' ');
  const color = up ? '#4ade80' : '#ff6b6b';
  el.innerHTML = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block">
    <defs><linearGradient id="sg${containerId}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <polygon points="0,${h} ${pts} ${w},${h}" fill="url(#sg${containerId})"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`;
}

// ========== Sources ==========
async function loadSources() {
  const d = await safeFetch('sources.json', 0);
  if (d && typeof d === 'object') state.sources = d;
}

// ========== Prices: 对齐 + Sparkline + 闪动 ==========
async function fetchRawChartData(symbol) {
  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=2d&interval=5m`;
  const proxies = [];
  if (CF_WORKER_URL) proxies.push(`${CF_WORKER_URL}?url=${encodeURIComponent(yahooUrl)}`);
  proxies.push(
    `https://api.allorigins.win/get?url=${encodeURIComponent(yahooUrl)}`,
    `https://corsproxy.io/?${encodeURIComponent(yahooUrl)}`,
    `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(yahooUrl)}`,
  );
  for (const proxyUrl of proxies) {
    try {
      const r = await fetch(proxyUrl, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      let data; try { data = JSON.parse(await r.text()); } catch { continue; }
      if (data.contents) { try { data = JSON.parse(data.contents); } catch { continue; } }
      const result = data?.chart?.result?.[0];
      if (!result) continue;
      const ts = result.timestamp || [], cl = result.indicators?.quote?.[0]?.close || [];
      if (ts.length < 2) continue;
      return { timestamps: ts, closes: cl, meta: result.meta || {} };
    } catch { continue; }
  }
  return null;
}

function renderPrice(id, data) {
  if (!data) return;
  const priceEl = document.getElementById(id + 'Price');
  const oldText = priceEl.textContent;
  const newText = `$${data.price}`;
  priceEl.textContent = newText;
  // 价格闪动
  if (oldText !== '—' && oldText !== newText) {
    const box = document.getElementById(id + 'Box');
    const cls = parseFloat(data.price) > parseFloat(oldText.replace('$','')) ? 'price-flash-up' : 'price-flash-down';
    box.classList.remove('price-flash-up', 'price-flash-down');
    void box.offsetWidth;
    box.classList.add(cls);
    setTimeout(() => box.classList.remove(cls), 1200);
  }
  const el = document.getElementById(id + 'Change');
  const up = parseFloat(data.change) >= 0;
  el.textContent = `${up?'▲':'▼'} ${data.change} (${data.pct}%)`;
  el.className = 'price-change ' + (up ? 'price-up' : 'price-down');
  const timeEl = document.getElementById(id + 'Time');
  if (data.dataTime) {
    timeEl.textContent = data.cached ? `⏳ 缓存 ${data.dataTime}` : `📅 ${data.dataTime}`;
    timeEl.style.color = data.cached ? 'var(--accent-gold)' : '';
  }
}

function extractSinglePrice(raw) {
  const pairs = [];
  for (let i = 0; i < raw.timestamps.length; i++) {
    if (raw.closes[i] != null) pairs.push({ ts: raw.timestamps[i], close: raw.closes[i] });
  }
  if (!pairs.length) return null;
  const latest = pairs[pairs.length - 1];
  const prev = raw.meta?.chartPreviousClose || raw.meta?.previousClose
    || (pairs.length >= 2 ? pairs[pairs.length - 2].close : latest.close);
  const chg = latest.close - prev;
  return { price: latest.close.toFixed(2), change: chg.toFixed(2),
    pct: ((chg / prev) * 100).toFixed(1), dataTime: formatSGT(new Date(latest.ts * 1000)), cached: false };
}

async function fetchPrices() {
  const [brentRaw, wtiRaw] = await Promise.all([fetchRawChartData('BZ=F'), fetchRawChartData('CL=F')]);
  let brentData = null, wtiData = null, aligned = false;

  if (brentRaw && wtiRaw) {
    const bMap = new Map(), wMap = new Map();
    for (let i = 0; i < brentRaw.timestamps.length; i++)
      if (brentRaw.closes[i] != null) bMap.set(brentRaw.timestamps[i], brentRaw.closes[i]);
    for (let i = 0; i < wtiRaw.timestamps.length; i++)
      if (wtiRaw.closes[i] != null) wMap.set(wtiRaw.timestamps[i], wtiRaw.closes[i]);

    const commonTs = [...bMap.keys()].filter(ts => wMap.has(ts)).sort((a, b) => b - a);
    if (commonTs.length >= 1) {
      const lt = commonTs[0], bCur = bMap.get(lt), wCur = wMap.get(lt);
      const dataTime = formatSGT(new Date(lt * 1000));
      const bPrev = brentRaw.meta?.chartPreviousClose || brentRaw.meta?.previousClose
        || (commonTs.length >= 2 ? bMap.get(commonTs[1]) : bCur);
      const wPrev = wtiRaw.meta?.chartPreviousClose || wtiRaw.meta?.previousClose
        || (commonTs.length >= 2 ? wMap.get(commonTs[1]) : wCur);
      const bChg = bCur - bPrev, wChg = wCur - wPrev;
      brentData = { price: bCur.toFixed(2), change: bChg.toFixed(2),
        pct: ((bChg/bPrev)*100).toFixed(1), dataTime, cached: false };
      wtiData = { price: wCur.toFixed(2), change: wChg.toFixed(2),
        pct: ((wChg/wPrev)*100).toFixed(1), dataTime, cached: false };
      aligned = true;
      state.priceSource = 'live';

      // Sparkline: 最近 48 个共同时点
      const sparkTs = commonTs.slice(0, 48).reverse();
      renderSparkline('brentSpark', sparkTs.map(ts => bMap.get(ts)), bChg >= 0);
      renderSparkline('wtiSpark', sparkTs.map(ts => wMap.get(ts)), wChg >= 0);

      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ brent: brentData, wti: wtiData, ts: Date.now() })); } catch {}
    }
  }

  if (!brentData && brentRaw) brentData = extractSinglePrice(brentRaw);
  if (!wtiData && wtiRaw) wtiData = extractSinglePrice(wtiRaw);

  if (!brentData || !wtiData) {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY));
      if (c && Date.now() - c.ts < 30 * 60 * 1000) {
        if (!brentData && c.brent) brentData = { ...c.brent, cached: true };
        if (!wtiData && c.wti) wtiData = { ...c.wti, cached: true };
        state.priceSource = 'cached';
      }
    } catch {}
  }

  if (!brentData && !wtiData) state.priceSource = 'offline';
  renderPrice('brent', brentData);
  renderPrice('wti', wtiData);

  if (brentData && wtiData)
    document.getElementById('spreadValue').textContent = `$${(parseFloat(brentData.price) - parseFloat(wtiData.price)).toFixed(2)}`;

  updateSourceStatus();
}

// ========== 数据源状态指示 ==========
function updateSourceStatus() {
  const el = document.getElementById('sourceStatus');
  if (!el) return;
  const m = { live: ['🟢 Live','source-live'], cached: ['🟡 缓存','source-cached'], offline: ['🔴 离线','source-offline'], unknown: ['⏳',''] };
  const [text, cls] = m[state.priceSource] || m.unknown;
  el.textContent = text;
  el.className = 'source-status ' + cls;
}

// ========== Countdown ==========
function startCountdown() {
  if (state.countdownId) clearInterval(state.countdownId);
  let remaining = REFRESH_MS;
  const el = document.getElementById('countdownTimer');
  if (!el) return;
  state.countdownId = setInterval(() => {
    remaining -= 1000;
    if (remaining <= 0) remaining = REFRESH_MS;
    const m = Math.floor(remaining / 60000), s = Math.floor((remaining % 60000) / 1000);
    el.textContent = `${m}:${s.toString().padStart(2, '0')}`;
  }, 1000);
}

// ========== Iran ==========
async function fetchIranBriefing() {
  const text = await safeFetch(API_BASE);
  if (!text || typeof text !== 'string') return;
  const tm = text.match(/Tension:\s*(\d+)\/10\s*(.+?)(?:\n|$)/);
  if (tm) {
    document.getElementById('tensionValue').textContent = tm[1]+'/10';
    document.getElementById('tensionDesc').textContent = tm[2].trim().substring(0,50);
  }
  const el = document.getElementById('iranContent');
  const sections = text.split(/^## /m).filter(s => s.trim());
  let html = '';
  for (const s of sections) {
    const lines = s.split('\n'), title = lines[0].trim(), body = lines.slice(1).join('\n').trim();
    if (!title) continue;
    html += `<div class="iran-section"><h3>${escapeHtml(title)}</h3>
      <div style="white-space:pre-wrap;font-size:13px;color:var(--text-dim);line-height:1.7">${escapeHtml(body)}</div></div>`;
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
      html += `<a class="feed-card" style="animation-delay:${delay}s" href="https://skill.capduck.com/iran/events" target="_blank">
        <div class="card-header"><span class="card-type event">${escapeHtml(item.category)}</span><span class="card-time">${escapeHtml(item.time)}</span></div>
        <div class="card-title">${escapeHtml(item.title)}</div>
        ${item.body?`<div class="card-body">${escapeHtml(item.body)}</div>`:''}
        <div class="card-meta"><span class="impact ${impactClass(item.impact)}">Impact ${item.impact}</span>
          ${item.sources?`<span class="sources-count">📡 ${item.sources} sources</span>`:''}
          ${item.sentiment?`<span style="color:var(--text-muted)">${item.sentiment}</span>`:''}</div></a>`;
    } else {
      const zh = item.zhBody ? `<div class="card-body" style="white-space:pre-wrap">${escapeHtml(item.zhBody)}</div>` : '';
      const orig = item.origBody ? `<div class="card-body" style="white-space:pre-wrap;font-size:11px;color:var(--text-muted);margin-top:6px;border-top:1px solid var(--border);padding-top:6px">${escapeHtml(item.origBody)}</div>` : '';
      const main = zh || `<div class="card-body" style="white-space:pre-wrap">${escapeHtml(item.origBody||'')}</div>`;
      html += `<a class="feed-card" style="animation-delay:${delay}s" href="${escapeHtml(item.link)}" target="_blank">
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
  const [evtText, postText] = await Promise.all([
    safeFetch(`${API_BASE}/events?impact=5&hours=24&limit=15`),
    safeFetch(`${API_BASE}/posts?limit=15`),
  ]);
  const events = parseEvents(evtText), posts = parsePosts(postText);
  const merged = []; let pi=0, ei=0;
  while (pi < posts.length || ei < events.length) {
    if (pi < posts.length) merged.push(posts[pi++]);
    if (pi < posts.length) merged.push(posts[pi++]);
    if (ei < events.length) merged.push(events[ei++]);
  }
  state.feedItems = merged;
  renderFeedItems(merged);
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
  const text = await safeFetch(`${API_BASE}/polymarket`);
  const el = document.getElementById('polyContent');
  if (!text || typeof text !== 'string') { el.innerHTML = '<p style="color:var(--text-dim)">暂无数据</p>'; return; }
  const contracts = [], blocks = text.split(/^## /m).filter(s => s.trim());
  for (const block of blocks) {
    const lines = block.split('\n'), question = lines[0].trim();
    if (!question || question.startsWith('#')) continue;
    const conditions = []; let link = '';
    for (const l of lines.slice(1)) {
      const lm = l.match(/Link:\s*(https?\S+)/); if (lm) { link = lm[1]; continue; }
      const cm = l.match(/^\s+-\s+(.+?):\s+\*\*(\d+%)\*\*\s*(Yes|No)?\s*(.*)/);
      if (cm) conditions.push({ label:cm[1], prob:cm[2], dir:cm[4]||'' });
    }
    if (conditions.length) contracts.push({ question, link, conditions });
  }
  let html = '';
  for (const c of contracts) {
    html += `<a class="poly-card" href="${escapeHtml(c.link)}" target="_blank" style="text-decoration:none;color:inherit;display:block">
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
  el.innerHTML = html || '<p style="color:var(--text-dim)">暂无 Polymarket 数据</p>';
}

// ========== 油市推文 (读取 data/oott.json，由 OOTT skill 定时更新) ==========
async function fetchOOTT() {
  const data = await safeFetch('data/oott.json', 0);
  const el = document.getElementById('oottFeed');
  if (!data || !Array.isArray(data) || !data.length) {
    el.innerHTML = `<div class="loading-spinner"><span style="color:var(--text-dim)">暂无油市推文数据</span>
      <a href="https://x.com/JavierBlas" target="_blank" style="color:var(--accent-blue);font-size:12px;margin-top:8px">查看 @JavierBlas →</a></div>`;
    return;
  }
  const sorted = [...data].sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  const handles = new Set(sorted.map(t => t.username));
  let html = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;padding:4px 8px">
    🛢️ 共 ${sorted.length} 条 · 来自 ${handles.size} 个白名单信源</div>`;
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i], delay = Math.min(i * 0.04, 0.8);
    const timeStr = t.createdAt ? formatSGT(new Date(t.createdAt)) : '';
    const media = (t.photos?.length || t.videos?.length) ? '<span style="color:var(--accent-cyan);font-size:11px;margin-left:6px">📷</span>' : '';
    html += `<a class="feed-card" style="animation-delay:${delay}s" href="${escapeHtml(t.url || '#')}" target="_blank">
      <div class="card-header"><span class="card-type tweet">OOTT</span><span class="card-time">${escapeHtml(timeStr)}</span></div>
      <div class="card-title"><span style="color:var(--accent-blue)">@${escapeHtml(t.username || '')}</span>${media}</div>
      <div class="card-body" style="white-space:pre-wrap">${escapeHtml((t.text || '').substring(0, 500))}</div></a>`;
  }
  el.innerHTML = html;
}

// ========== Main ==========
async function refresh() {
  const statusEl = document.getElementById('refreshStatus');
  if (statusEl) { statusEl.textContent = '刷新中...'; statusEl.style.opacity = '1'; }
  document.getElementById('updateTime').textContent = formatSGT(new Date());
  await Promise.allSettled([fetchPrices(), fetchIranBriefing(), buildFeed(), fetchPolymarket(), fetchOOTT()]);
  if (statusEl) { statusEl.textContent = '✓'; setTimeout(() => { statusEl.style.opacity = '0'; }, 2000); }
  startCountdown();
}

(async () => {
  // 先显示缓存价格（瞬间），后台刷新
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (c) {
      if (c.brent) renderPrice('brent', { ...c.brent, cached: true });
      if (c.wti) renderPrice('wti', { ...c.wti, cached: true });
      if (c.brent && c.wti)
        document.getElementById('spreadValue').textContent = `$${(parseFloat(c.brent.price) - parseFloat(c.wti.price)).toFixed(2)}`;
    }
  } catch {}
  await loadSources();
  refresh(); // 不 await，让页面先响应
  setInterval(refresh, REFRESH_MS);
  // PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW register failed:', e));
  }
})();
