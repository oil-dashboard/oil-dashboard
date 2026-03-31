// ========== Oil Dashboard — 前端实时数据引擎 ==========
// 所有数据从公开 API 直接拉取，5 分钟自动刷新
// 白名单配置在 sources.json，修改该文件即可增删信源

const API_BASE = 'https://skill.capduck.com/iran';
const CORS_PROXY = 'https://api.allorigins.win/raw?url=';
const REFRESH_MS = 5 * 60 * 1000;

let SOURCES = null; // 从 sources.json 加载
let lastFetchOk = true;

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
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function impactClass(impact) {
  if (impact >= 8) return 'impact-high';
  if (impact >= 5) return 'impact-mid';
  return 'impact-low';
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function safeFetch(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      try { return JSON.parse(text); } catch { return text; }
    } catch (e) {
      if (i === retries) { console.warn('Fetch failed after retries:', url, e); return null; }
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  return null;
}

// ========== Load sources.json ==========
async function loadSources() {
  const data = await safeFetch('sources.json', 0);
  if (data && typeof data === 'object') {
    SOURCES = data;
    renderSources();
  }
}

// ========== Price fetching ==========
function parseYahooPrice(data) {
  try {
    const result = data.chart.result[0];
    const quotes = result.indicators.quote[0];
    const closes = quotes.close.filter(c => c != null);
    const cur = closes[closes.length - 1];
    const prev = closes[closes.length - 2] || cur;
    const change = cur - prev;
    const pct = (change / prev) * 100;
    return { price: cur.toFixed(2), change: change.toFixed(2), pct: pct.toFixed(1), history: closes };
  } catch { return null; }
}

async function fetchPrices() {
  const brentUrl = CORS_PROXY + encodeURIComponent('https://query1.finance.yahoo.com/v8/finance/chart/BZ=F?range=7d&interval=1d');
  const wtiUrl = CORS_PROXY + encodeURIComponent('https://query1.finance.yahoo.com/v8/finance/chart/CL=F?range=7d&interval=1d');

  const [brentData, wtiData] = await Promise.all([safeFetch(brentUrl), safeFetch(wtiUrl)]);
  const brent = brentData ? parseYahooPrice(brentData) : null;
  const wti = wtiData ? parseYahooPrice(wtiData) : null;

  if (brent) {
    document.getElementById('brentPrice').textContent = `$${brent.price}`;
    const el = document.getElementById('brentChange');
    const up = parseFloat(brent.change) >= 0;
    el.textContent = `${up ? '▲' : '▼'} ${brent.change} (${brent.pct}%)`;
    el.className = 'price-change ' + (up ? 'price-up' : 'price-down');
  }
  if (wti) {
    document.getElementById('wtiPrice').textContent = `$${wti.price}`;
    const el = document.getElementById('wtiChange');
    const up = parseFloat(wti.change) >= 0;
    el.textContent = `${up ? '▲' : '▼'} ${wti.change} (${wti.pct}%)`;
    el.className = 'price-change ' + (up ? 'price-up' : 'price-down');
  }
  if (brent && wti) {
    document.getElementById('spreadValue').textContent = `$${(parseFloat(brent.price) - parseFloat(wti.price)).toFixed(2)}`;
  }
}

// ========== Iran briefing ==========
async function fetchIranBriefing() {
  const text = await safeFetch(API_BASE);
  if (!text || typeof text !== 'string') return;

  // Parse tension
  const tm = text.match(/Tension:\s*(\d+)\/10\s*(.+?)(?:\n|$)/);
  if (tm) {
    document.getElementById('tensionValue').textContent = tm[1] + '/10';
    document.getElementById('tensionDesc').textContent = tm[2].trim().substring(0, 50);
  }

  // Render in iran panel
  const el = document.getElementById('iranContent');
  const sections = text.split(/^##\s+/m).filter(s => s.trim());
  let html = '';
  for (const s of sections) {
    const lines = s.split('\n');
    const title = lines[0].trim();
    const body = lines.slice(1).join('\n').trim();
    if (!title) continue;
    html += `<div class="iran-section">
      <h3>${escapeHtml(title)}</h3>
      <div style="white-space:pre-wrap;font-size:13px;color:var(--text-dim);line-height:1.7">${escapeHtml(body)}</div>
    </div>`;
  }
  el.innerHTML = html || '<p style="color:var(--text-dim)">暂无数据</p>';
}

// ========== Events → Feed ==========
async function fetchEvents() {
  const text = await safeFetch(`${API_BASE}/events?impact=6&hours=24&limit=20`);
  if (!text || typeof text !== 'string') return [];

  const events = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^\-\s+\*\*\[(\d+)\]\s+(\w+)\*\*:\s+(.+)/);
    if (m) {
      if (cur) events.push(cur);
      cur = { type: 'event', impact: parseInt(m[1]), category: m[2], title: m[3], body: '', time: '', sources: 0 };
      const tm = line.match(/(\d+)h?\s*ago/);
      if (tm) cur.time = tm[0];
      const sm = line.match(/(\d+)\s*sources?/);
      if (sm) cur.sources = parseInt(sm[1]);
    } else if (cur && line.trim() && !line.startsWith('-') && !line.startsWith('>') && !line.startsWith('#')) {
      cur.body += line.trim() + ' ';
    }
  }
  if (cur) events.push(cur);
  return events;
}

async function buildFeed() {
  const events = await fetchEvents();
  const items = events.sort((a, b) => b.impact - a.impact);
  const el = document.getElementById('feedList');

  if (!items.length) {
    el.innerHTML = '<div class="loading-spinner"><span style="color:var(--text-dim)">暂无新事件 — 数据每5分钟刷新</span></div>';
    return;
  }

  let html = '';
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    html += `<div class="feed-card" style="animation-delay:${i * 0.06}s">
      <div class="card-header">
        <span class="card-type event">${escapeHtml(item.category)}</span>
        <span class="card-time">${item.time}</span>
      </div>
      <div class="card-title">${escapeHtml(item.title)}</div>
      ${item.body ? `<div class="card-body">${escapeHtml(item.body.trim().substring(0, 220))}</div>` : ''}
      <div class="card-meta">
        <span class="impact ${impactClass(item.impact)}">Impact ${item.impact}</span>
        ${item.sources ? `<span class="sources-count">📡 ${item.sources} sources</span>` : ''}
      </div>
    </div>`;
  }
  el.innerHTML = html;
}

// ========== Polymarket ==========
async function fetchPolymarket() {
  const text = await safeFetch(`${API_BASE}/polymarket`);
  const el = document.getElementById('polyContent');
  if (!text) { el.innerHTML = '<p style="color:var(--text-dim)">暂无数据</p>'; return; }

  if (typeof text === 'string') {
    const contracts = [];
    let cur = null;
    for (const line of text.split('\n')) {
      const qm = line.match(/^\*\*(.+?)\*\*/);
      if (qm && !line.startsWith('>')) {
        if (cur) contracts.push(cur);
        cur = { question: qm[1], prob: '', trend: '' };
        const pm = line.match(/(\d+\.?\d*)%/);
        if (pm) cur.prob = pm[1] + '%';
      } else if (cur && line.trim()) {
        if (/[↑↓→]/.test(line)) cur.trend += line.trim() + ' ';
      }
    }
    if (cur) contracts.push(cur);

    let html = '';
    for (const c of contracts.slice(0, 10)) {
      html += `<div class="poly-card">
        <div class="poly-question">${escapeHtml(c.question)}</div>
        ${c.prob ? `<div class="poly-prob">${c.prob}</div>` : ''}
        ${c.trend ? `<div class="poly-trend" style="color:var(--text-dim)">${escapeHtml(c.trend.trim())}</div>` : ''}
      </div>`;
    }
    el.innerHTML = html || '<p style="color:var(--text-dim)">暂无 Polymarket 数据</p>';
  }
}

// ========== Sources panel (from sources.json) ==========
function renderSources() {
  if (!SOURCES) return;
  const el = document.getElementById('sourcesContent');
  const groupOrder = ['tier0', 'analysts', 'investment', 'tanker', 'news'];
  let html = '';

  for (const key of groupOrder) {
    const group = SOURCES[key];
    if (!group || !group.accounts) continue;
    html += `<div class="source-group">
      <div class="source-group-title ${group.style || ''}">${escapeHtml(group.title)}</div>
      <div>`;
    for (const s of group.accounts) {
      const user = s.handle.replace('@', '');
      html += `<a class="source-item" href="https://x.com/${user}" target="_blank">
        ${escapeHtml(s.handle)} <span style="color:var(--text-muted);font-size:11px">${escapeHtml(s.org)}</span>
      </a>`;
    }
    html += '</div></div>';
  }

  // Iran linked sources
  const iran = SOURCES.iran_linked;
  if (iran && iran.groups) {
    html += `<div class="source-group">
      <div class="source-group-title ${iran.style || ''}">${escapeHtml(iran.title)}</div>
      <div>`;
    for (const g of iran.groups) {
      html += `<a class="source-item" href="https://skill.capduck.com/iran/notable" target="_blank"
        style="border-color:rgba(220,38,38,0.2)">
        ${escapeHtml(g.group)} <span style="color:var(--text-muted);font-size:11px">${escapeHtml(g.sources)}</span>
      </a>`;
    }
    html += '</div></div>';
  }

  el.innerHTML = html;
}

// ========== Main loop ==========
async function refresh() {
  document.getElementById('updateTime').textContent =
    new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Singapore' }) + ' SGT';

  try {
    await Promise.all([fetchPrices(), fetchIranBriefing(), buildFeed(), fetchPolymarket()]);
    lastFetchOk = true;
  } catch (e) {
    console.error('Refresh error:', e);
    lastFetchOk = false;
  }
}

// ========== Init ==========
(async () => {
  await loadSources();
  await refresh();
  setInterval(refresh, REFRESH_MS);
})();
