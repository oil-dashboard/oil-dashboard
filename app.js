// ========== Oil Dashboard — 前端实时引擎 v2 ==========
// 修复 API 解析 + 加入 posts 信息流 + Polymarket 正确解析

const API_BASE = 'https://skill.capduck.com/iran';
const CORS_PROXIES = [
  'https://corsproxy.io/?',
  'https://api.allorigins.win/raw?url=',
  'https://thingproxy.freeboard.io/fetch/',
];
let corsProxy = CORS_PROXIES[0];
const REFRESH_MS = 5 * 60 * 1000;
let SOURCES = null;

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
function sgtTime(isoStr) {
  if (!isoStr) return '';
  try {
    return new Date(isoStr).toLocaleString('zh-CN', { timeZone: 'Asia/Singapore', hour12: false });
  } catch { return isoStr; }
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

// ========== Prices (Twelve Data free API — native CORS, no proxy needed) ==========
async function fetchPrices() {
  const ts = Date.now(); // cache bust
  const brentUrl = `https://api.twelvedata.com/quote?symbol=BZ1!&apikey=demo&source=docs&_=${ts}`;
  const wtiUrl = `https://api.twelvedata.com/quote?symbol=CL1!&apikey=demo&source=docs&_=${ts}`;

  const [bd, wd] = await Promise.all([
    safeFetch(brentUrl, 1),
    safeFetch(wtiUrl, 1),
  ]);

  function parseTwelve(d) {
    if (!d || d.code || !d.close) return null;
    const cur = parseFloat(d.close);
    const prev = parseFloat(d.previous_close) || cur;
    const chg = cur - prev;
    const pct = prev ? (chg / prev) * 100 : 0;
    const dataTime = d.datetime ? new Date(d.datetime + ' UTC').toLocaleString('zh-CN', {
      timeZone: 'Asia/Singapore', hour12: false,
      month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric'
    }) + ' SGT' : '';
    return { price: cur.toFixed(2), change: chg.toFixed(2), pct: pct.toFixed(1), dataTime };
  }

  const b = parseTwelve(bd);
  const w = parseTwelve(wd);
  if (b) {
    document.getElementById('brentPrice').textContent = `$${b.price}`;
    const el = document.getElementById('brentChange');
    const up = parseFloat(b.change) >= 0;
    el.textContent = `${up?'▲':'▼'} ${b.change} (${b.pct}%)`;
    el.className = 'price-change ' + (up?'price-up':'price-down');
    if (b.dataTime) document.getElementById('brentTime').textContent = `📅 ${b.dataTime}`;
  }
  if (w) {
    document.getElementById('wtiPrice').textContent = `$${w.price}`;
    const el = document.getElementById('wtiChange');
    const up = parseFloat(w.change) >= 0;
    el.textContent = `${up?'▲':'▼'} ${w.change} (${w.pct}%)`;
    el.className = 'price-change ' + (up?'price-up':'price-down');
    if (w.dataTime) document.getElementById('wtiTime').textContent = `📅 ${w.dataTime}`;
  }
  if (b && w) document.getElementById('spreadValue').textContent = `$${(parseFloat(b.price)-parseFloat(w.price)).toFixed(2)}`;
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
  // Render in iran panel
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

// ========== Events parsing (real format: ## 🔴 [7] CONFLICT: title) ==========
function parseEvents(text) {
  if (!text || typeof text !== 'string') return [];
  const events = [];
  const blocks = text.split(/^## /m).filter(s => s.trim());
  for (const block of blocks) {
    const lines = block.split('\n');
    const header = lines[0];
    // Match: 🔴 [7] CONFLICT: title  or  🟡 [6] DIPLOMACY: title
    const m = header.match(/[🔴🟡🟢⚪]\s*\[(\d+)\]\s*(\w+):\s*(.+)/);
    if (!m) continue;
    const body = [];
    let time = '', sources = 0, sentiment = '', link = '';
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

// ========== Posts parsing — separate Chinese translation from original ==========
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
      if (l.startsWith('>')) {
        zhLines.push(l.replace(/^>\s*/, ''));
      } else if (l.trim()) {
        origLines.push(l.trim());
      }
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

  // Merge & sort: posts first (more recent), then events
  const items = [...posts.map((p,i) => ({...p, order: i})), ...events.map((e,i) => ({...e, order: i + 100}))];
  // Interleave: alternate posts and events for variety
  const merged = [];
  let pi = 0, ei = 0;
  const postArr = posts, evtArr = events;
  while (pi < postArr.length || ei < evtArr.length) {
    if (pi < postArr.length) merged.push(postArr[pi++]);
    if (pi < postArr.length) merged.push(postArr[pi++]);
    if (ei < evtArr.length) merged.push(evtArr[ei++]);
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
      // Post card — Chinese translation first, original smaller
      const zhPart = item.zhBody ? `<div class="card-body" style="white-space:pre-wrap">${escapeHtml(item.zhBody)}</div>` : '';
      const origPart = item.origBody ? `<div class="card-body" style="white-space:pre-wrap;font-size:11px;color:var(--text-muted);margin-top:6px;border-top:1px solid var(--border);padding-top:6px">${escapeHtml(item.origBody)}</div>` : '';
      // If no zhBody, show origBody as main
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

// ========== Polymarket (real format: ## 标题 + - Conditions: + items) ==========
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
      // Match: "  - 年底: **66%** Yes ↓9% (range: 34%-80%)"
      const condM = l.match(/^\s+-\s+(.+?):\s+\*\*(\d+%)\*\*\s*(Yes|No)?\s*(.*)/);
      if (condM) {
        conditions.push({
          label: condM[1],
          prob: condM[2],
          dir: condM[4] || ''
        });
      }
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

// ========== OOTT 油市推文 (from data/oott.json) ==========
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

  // Sort by time descending
  const sorted = [...data].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  let html = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;padding:4px 8px">
    📊 共 ${sorted.length} 条推文 · 来自 ${new Set(sorted.map(t=>t.username)).size} 个白名单信源
  </div>`;

  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    const delay = Math.min(i * 0.04, 0.8);
    const timeStr = t.createdAt ? new Date(t.createdAt).toLocaleString('zh-CN', {
      timeZone: 'Asia/Singapore', hour12: false,
      month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric'
    }) + ' SGT' : '';

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
  document.getElementById('updateTime').textContent =
    new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Singapore', hour12: false }) + ' SGT';
  await Promise.allSettled([fetchPrices(), fetchIranBriefing(), buildFeed(), fetchPolymarket(), fetchOOTT()]);
}

(async () => {
  await loadSources();
  await refresh();
  setInterval(refresh, REFRESH_MS);
})();
