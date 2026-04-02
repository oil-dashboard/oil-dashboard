// ========== Oil Dashboard — 前端实时引擎 v3 ==========
// v3: 价格对齐同一时点 + 5分钟K线 + 日涨跌幅 + 刷新倒计时

const API_BASE = 'https://skill.capduck.com/iran';
const REFRESH_MS = 5 * 60 * 1000;
let SOURCES = null;
let countdownInterval = null;

// ========== Tab switching ==========
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab + 'Panel').classList.add('active');
  });
});

// ========== Utilities ==========
function escapeHtml(t) {
  if (!t) return '';
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
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
function sgtTime(isoStr) {
  if (!isoStr) return '';
  try { return formatSGT(new Date(isoStr)); } catch { return isoStr; }
}
function impactClass(n) {
  if (n >= 8) return 'impact-high';
  if (n >= 5) return 'impact-mid';
  return 'impact-low';
}
async function safeFetch(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      try { return JSON.parse(text); } catch { return text; }
    } catch (e) {
      if (i === retries) { console.warn('Fetch fail:', url, e); return null; }
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

// ========== Load sources.json ==========
async function loadSources() {
  const d = await safeFetch('sources.json', 0);
  if (d && typeof d === 'object') { SOURCES = d; }
}

// ========== Prices: 对齐 Brent/WTI 到同一时间点 ==========
async function fetchRawChartData(symbol) {
  // 用 5分钟K线，匹配5分钟刷新周期
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=2d&interval=5m`;
  const proxies = [
    `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
    `https://corsproxy.io/?${encodeURIComponent(url)}`,
    `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
    `https://proxy.cors.sh/${url}`,
  ];
  for (const proxyUrl of proxies) {
    try {
      const r = await fetch(proxyUrl, { signal: AbortSignal.timeout(12000) });
      if (!r.ok) continue;
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { continue; }
      if (data.contents) {
        try { data = JSON.parse(data.contents); } catch { continue; }
      }
      const result = data?.chart?.result?.[0];
      if (!result) continue;
      const timestamps = result.timestamp || [];
      const closes = result.indicators?.quote?.[0]?.close || [];
      const meta = result.meta || {};
      if (timestamps.length < 2) continue;
      return { timestamps, closes, meta };
    } catch (e) { continue; }
  }
  return null;
}

function extractSinglePrice(raw) {
  const pairs = [];
  for (let i = 0; i < raw.timestamps.length; i++) {
    if (raw.closes[i] != null) pairs.push({ ts: raw.timestamps[i], close: raw.closes[i] });
  }
  if (pairs.length < 1) return null;
  const latest = pairs[pairs.length - 1];
  const prevClose = raw.meta?.chartPreviousClose || raw.meta?.previousClose
    || (pairs.length >= 2 ? pairs[pairs.length - 2].close : latest.close);
  const chg = latest.close - prevClose;
  return {
    price: latest.close.toFixed(2), change: chg.toFixed(2),
    pct: ((chg / prevClose) * 100).toFixed(1),
    dataTime: formatSGT(new Date(latest.ts * 1000)), cached: false
  };
}

function renderPrice(id, data) {
  if (!data) return;
  document.getElementById(id + 'Price').textContent = `$${data.price}`;
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

async function fetchPrices() {
  // 并行拉取两个品种的原始K线数据
  const [brentRaw, wtiRaw] = await Promise.all([
    fetchRawChartData('BZ=F'),
    fetchRawChartData('CL=F'),
  ]);

  let brentData = null, wtiData = null, aligned = false;

  if (brentRaw && wtiRaw) {
    // 构建 timestamp → close 映射（仅非null值）
    const bMap = new Map(), wMap = new Map();
    for (let i = 0; i < brentRaw.timestamps.length; i++) {
      if (brentRaw.closes[i] != null) bMap.set(brentRaw.timestamps[i], brentRaw.closes[i]);
    }
    for (let i = 0; i < wtiRaw.timestamps.length; i++) {
      if (wtiRaw.closes[i] != null) wMap.set(wtiRaw.timestamps[i], wtiRaw.closes[i]);
    }

    // 找到共同时间戳（两个品种都有数据），按时间倒序
    const commonTs = [...bMap.keys()].filter(ts => wMap.has(ts)).sort((a, b) => b - a);

    if (commonTs.length >= 1) {
      const latestTs = commonTs[0];
      const bCur = bMap.get(latestTs), wCur = wMap.get(latestTs);
      const dataTime = formatSGT(new Date(latestTs * 1000));

      // 用 chartPreviousClose 计算日涨跌（更有意义）
      const bPrev = brentRaw.meta?.chartPreviousClose || brentRaw.meta?.previousClose
        || (commonTs.length >= 2 ? bMap.get(commonTs[1]) : bCur);
      const wPrev = wtiRaw.meta?.chartPreviousClose || wtiRaw.meta?.previousClose
        || (commonTs.length >= 2 ? wMap.get(commonTs[1]) : wCur);

      const bChg = bCur - bPrev, wChg = wCur - wPrev;
      brentData = {
        price: bCur.toFixed(2), change: bChg.toFixed(2),
        pct: ((bChg / bPrev) * 100).toFixed(1), dataTime, cached: false
      };
      wtiData = {
        price: wCur.toFixed(2), change: wChg.toFixed(2),
        pct: ((wChg / wPrev) * 100).toFixed(1), dataTime, cached: false
      };
      aligned = true;

      // 缓存对齐结果
      try { localStorage.setItem('oil_aligned', JSON.stringify({ brent: brentData, wti: wtiData, ts: Date.now() })); } catch {}
    }
  }

  // 对齐失败时，回退到单独提取
  if (!brentData && brentRaw) brentData = extractSinglePrice(brentRaw);
  if (!wtiData && wtiRaw) wtiData = extractSinglePrice(wtiRaw);

  // 都失败时，读 localStorage 缓存（30分钟有效）
  if (!brentData || !wtiData) {
    try {
      const cached = JSON.parse(localStorage.getItem('oil_aligned'));
      if (cached && Date.now() - cached.ts < 30 * 60 * 1000) {
        if (!brentData && cached.brent) brentData = { ...cached.brent, cached: true };
        if (!wtiData && cached.wti) wtiData = { ...cached.wti, cached: true };
      }
    } catch {}
  }

  renderPrice('brent', brentData);
  renderPrice('wti', wtiData);

  // Spread + 对齐状态
  if (brentData && wtiData) {
    document.getElementById('spreadValue').textContent = `$${(parseFloat(brentData.price) - parseFloat(wtiData.price)).toFixed(2)}`;
  }
  const alignEl = document.getElementById('priceAlignStatus');
  if (alignEl) {
    if (aligned) {
      alignEl.textContent = `✅ 同时点 · ${brentData?.dataTime || ''}`;
      alignEl.style.color = 'var(--up)';
    } else if (brentData || wtiData) {
      alignEl.textContent = '⚠️ 时点未对齐';
      alignEl.style.color = 'var(--accent-gold)';
    } else {
      alignEl.textContent = '❌ 数据获取失败';
      alignEl.style.color = 'var(--down)';
    }
  }
}

// ========== Countdown 倒计时 ==========
function startCountdown() {
  const el = document.getElementById('countdownTimer');
  if (!el) return;
  let remaining = REFRESH_MS;
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    remaining -= 1000;
    if (remaining <= 0) { remaining = REFRESH_MS; }
    const m = Math.floor(remaining / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    el.textContent = `${m}:${s.toString().padStart(2, '0')}`;
  }, 1000);
}

// ========== Iran Briefing ==========
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
    const lines = s.split('\n');
    const title = lines[0].trim();
    const body = lines.slice(1).join('\n').trim();
    if (!title) continue;
    html += `<div class="iran-section"><h3>${escapeHtml(title)}</h3>
      <div style="white-space:pre-wrap;font-size:13px;color:var(--text-dim);line-height:1.7">${escapeHtml(body)}</div></div>`;
  }
  el.innerHTML = html || '<p style="color:var(--text-dim)">暂无数据</p>';
}

// ========== Events ==========
function parseEvents(text) {
  if (!text || typeof text !== 'string') return [];
  const events = [];
  const blocks = text.split(/^## /m).filter(s => s.trim());
  for (const block of blocks) {
    const lines = block.split('\n');
    const header = lines[0];
    const m = header.match(/[🔴🟡🟢⚪]\s*\[(\d+)\]\s*(\w+):\s*(.+)/);
    if (!m) continue;
    const body = [];
    let time = '', sources = 0, sentiment = '';
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i];
      const timeM = l.match(/Time:\s*(.+?)(?:\s*\||$)/);
      if (timeM) time = timeM[1].trim();
      const srcM = l.match(/Sources\s*\((\d+)\)/);
      if (srcM) sources = parseInt(srcM[1]);
      const sentM = l.match(/Sentiment:\s*(\w+)/);
      if (sentM) sentiment = sentM[1];
      if (l.startsWith('>') && l.includes('Drill down')) continue;
      if (l.startsWith('>') && !l.includes('Drill down')) {
        body.push(l.replace(/^>\s*/, ''));
      } else if (!l.startsWith('-') && !l.startsWith('#') && !l.startsWith('>') && l.trim() && !l.match(/^(ID|Time|Sources|Sentiment|Confidence):/)) {
        body.push(l.trim());
      }
    }
    events.push({
      type: 'event', impact: parseInt(m[1]), category: m[2],
      title: m[3].trim(), body: body.join(' ').substring(0, 300),
      time, sources, sentiment
    });
  }
  return events;
}

// ========== Posts ==========
function parsePosts(text) {
  if (!text || typeof text !== 'string') return [];
  const posts = [];
  const blocks = text.split(/^## /m).filter(s => s.trim());
  for (const block of blocks) {
    const lines = block.split('\n');
    const header = lines[0];
    const m = header.match(/\*\*(.+?)\*\*\s*\[(.+?)\]\s*@?(\S+)?/);
    if (!m) continue;
    let time = '', platform = '', link = '', engagement = '';
    const zhLines = [], origLines = [];
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i];
      const timeM = l.match(/Time:\s*(.+)/);
      if (timeM) { time = timeM[1].trim(); continue; }
      const platM = l.match(/Platform:\s*(\w+)/);
      if (platM) { platform = platM[1]; continue; }
      const linkM = l.match(/Link:\s*(https?\S+)/);
      if (linkM) { link = linkM[1]; continue; }
      const engM = l.match(/Engagement:\s*(.+)/);
      if (engM) { engagement = engM[1].trim(); continue; }
      if (l.startsWith('- ') || l.startsWith('---') || !l.trim()) continue;
      if (l.startsWith('>')) { zhLines.push(l.replace(/^>\s*/, '')); }
      else if (l.trim()) { origLines.push(l.trim()); }
    }
    posts.push({
      type: 'post', author: m[1], category: m[2], handle: m[3] || '',
      time, platform, link, engagement,
      zhBody: zhLines.join('\n').substring(0, 500),
      origBody: origLines.join('\n').substring(0, 500),
      body: (zhLines.length ? zhLines : origLines).join('\n').substring(0, 500)
    });
  }
  return posts;
}

// ========== Build combined feed ==========
async function buildFeed() {
  const [evtText, postText] = await Promise.all([
    safeFetch(`${API_BASE}/events?impact=5&hours=24&limit=15`),
    safeFetch(`${API_BASE}/posts?limit=15`),
  ]);
  const events = parseEvents(evtText);
  const posts = parsePosts(postText);
  const merged = [];
  let pi = 0, ei = 0;
  while (pi < posts.length || ei < events.length) {
    if (pi < posts.length) merged.push(posts[pi++]);
    if (pi < posts.length) merged.push(posts[pi++]);
    if (ei < events.length) merged.push(events[ei++]);
  }
  const el = document.getElementById('feedList');
  if (!merged.length) {
    el.innerHTML = '<div class="loading-spinner"><span style="color:var(--text-dim)">暂无新事件 — 5分钟后刷新</span></div>';
    return;
  }
  let html = '';
  for (let i = 0; i < merged.length; i++) {
    const item = merged[i];
    const delay = Math.min(i * 0.05, 1);
    if (item.type === 'event') {
      html += `<a class="feed-card" style="animation-delay:${delay}s" href="https://skill.capduck.com/iran/events" target="_blank">
        <div class="card-header">
          <span class="card-type event">${escapeHtml(item.category)}</span>
          <span class="card-time">${escapeHtml(item.time)}</span>
        </div>
        <div class="card-title">${escapeHtml(item.title)}</div>
        ${item.body ? `<div class="card-body">${escapeHtml(item.body)}</div>` : ''}
        <div class="card-meta">
          <span class="impact ${impactClass(item.impact)}">Impact ${item.impact}</span>
          ${item.sources ? `<span class="sources-count">📡 ${item.sources} sources</span>` : ''}
          ${item.sentiment ? `<span style="color:var(--text-muted)">${item.sentiment}</span>` : ''}
        </div>
      </a>`;
    } else {
      const zhPart = item.zhBody ? `<div class="card-body" style="white-space:pre-wrap">${escapeHtml(item.zhBody)}</div>` : '';
      const origPart = item.origBody ? `<div class="card-body" style="white-space:pre-wrap;font-size:11px;color:var(--text-muted);margin-top:6px;border-top:1px solid var(--border);padding-top:6px">${escapeHtml(item.origBody)}</div>` : '';
      const mainBody = zhPart || `<div class="card-body" style="white-space:pre-wrap">${escapeHtml(item.origBody || '')}</div>`;
      html += `<a class="feed-card" style="animation-delay:${delay}s" href="${escapeHtml(item.link)}" target="_blank">
        <div class="card-header">
          <span class="card-type tweet">${escapeHtml(item.platform || 'post')}</span>
          <span class="card-time">${escapeHtml(item.time)}</span>
        </div>
        <div class="card-title">
          <span style="color:var(--accent-blue)">@${escapeHtml(item.handle)}</span>
          <span style="color:var(--text-muted);font-size:12px;margin-left:6px">${escapeHtml(item.author)}</span>
          <span style="color:var(--text-muted);font-size:11px;margin-left:6px">[${escapeHtml(item.category)}]</span>
        </div>
        ${mainBody}
        ${zhPart ? origPart : ''}
        ${item.engagement ? `<div class="card-meta"><span class="engagement">📊 ${escapeHtml(item.engagement)}</span></div>` : ''}
      </a>`;
    }
  }
  el.innerHTML = html;
}

// ========== Polymarket ==========
async function fetchPolymarket() {
  const text = await safeFetch(`${API_BASE}/polymarket`);
  const el = document.getElementById('polyContent');
  if (!text || typeof text !== 'string') {
    el.innerHTML = '<p style="color:var(--text-dim)">暂无数据</p>';
    return;
  }
  const contracts = [];
  const blocks = text.split(/^## /m).filter(s => s.trim());
  for (const block of blocks) {
    const lines = block.split('\n');
    const question = lines[0].trim();
    if (!question || question.startsWith('#')) continue;
    const conditions = [];
    let link = '';
    for (const l of lines.slice(1)) {
      const linkM = l.match(/Link:\s*(https?\S+)/);
      if (linkM) { link = linkM[1]; continue; }
      const condM = l.match(/^\s+-\s+(.+?):\s+\*\*(\d+%)\*\*\s*(Yes|No)?\s*(.*)/);
      if (condM) conditions.push({ label: condM[1], prob: condM[2], dir: condM[4] || '' });
    }
    if (conditions.length) contracts.push({ question, link, conditions });
  }
  let html = '';
  for (const c of contracts) {
    html += `<a class="poly-card" href="${escapeHtml(c.link)}" target="_blank" style="text-decoration:none;color:inherit;display:block">
      <div class="poly-question">${escapeHtml(c.question)}</div>
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:8px">`;
    for (const cond of c.conditions) {
      const probNum = parseInt(cond.prob);
      const color = probNum >= 50 ? 'var(--up)' : probNum >= 20 ? 'var(--accent-gold)' : 'var(--text-muted)';
      html += `<div style="background:var(--bg);padding:8px 12px;border-radius:8px;border:1px solid var(--border)">
        <div style="font-size:11px;color:var(--text-dim)">${escapeHtml(cond.label)}</div>
        <div style="font-size:20px;font-weight:800;color:${color}">${cond.prob}</div>
        <div style="font-size:10px;color:var(--text-muted)">${escapeHtml(cond.dir)}</div>
      </div>`;
    }
    html += '</div></a>';
  }
  el.innerHTML = html || '<p style="color:var(--text-dim)">暂无 Polymarket 数据</p>';
}

// ========== OOTT ==========
async function fetchOOTT() {
  const data = await safeFetch('data/oott.json', 0);
  const el = document.getElementById('oottFeed');
  if (!data || !Array.isArray(data) || data.length === 0) {
    el.innerHTML = `<div class="loading-spinner">
      <span style="color:var(--text-dim)">暂无推文数据 — 等待下次抓取</span>
      <a href="https://x.com/JavierBlas" target="_blank" style="color:var(--accent-blue);font-size:12px;margin-top:8px">查看 @JavierBlas →</a>
    </div>`;
    return;
  }
  const sorted = [...data].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  let html = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;padding:4px 8px">
    📊 共 ${sorted.length} 条推文 · 来自 ${new Set(sorted.map(t=>t.username)).size} 个白名单信源
  </div>`;
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    const delay = Math.min(i * 0.04, 0.8);
    const timeStr = t.createdAt ? formatSGT(new Date(t.createdAt)) : '';
    const hasMedia = (t.photos && t.photos.length > 0) || (t.videos && t.videos.length > 0);
    const mediaTag = hasMedia ? '<span style="color:var(--accent-cyan);font-size:11px;margin-left:6px">📷 含图</span>' : '';
    html += `<a class="feed-card" style="animation-delay:${delay}s" href="${escapeHtml(t.url || '#')}" target="_blank">
      <div class="card-header">
        <span class="card-type tweet">OOTT</span>
        <span class="card-time">${escapeHtml(timeStr)}</span>
      </div>
      <div class="card-title">
        <span style="color:var(--accent-blue)">@${escapeHtml(t.username || '')}</span>
        ${mediaTag}
      </div>
      <div class="card-body" style="white-space:pre-wrap">${escapeHtml((t.text || '').substring(0, 500))}</div>
    </a>`;
  }
  el.innerHTML = html;
}

// ========== Main ==========
async function refresh() {
  // 显示刷新状态
  const statusEl = document.getElementById('refreshStatus');
  if (statusEl) { statusEl.textContent = '刷新中...'; statusEl.style.opacity = '1'; }

  document.getElementById('updateTime').textContent = formatSGT(new Date());
  await Promise.allSettled([fetchPrices(), fetchIranBriefing(), buildFeed(), fetchPolymarket(), fetchOOTT()]);

  if (statusEl) {
    statusEl.textContent = '✓ 已刷新';
    setTimeout(() => { statusEl.style.opacity = '0'; }, 2000);
  }
  startCountdown();
}

(async () => {
  await loadSources();
  await refresh();
  setInterval(refresh, REFRESH_MS);
})();
