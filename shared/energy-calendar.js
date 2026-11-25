(function (root) {
  'use strict';

  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const EIA_URL = 'https://www.eia.gov/petroleum/supply/weekly/schedule.php';
  const API_URL = 'https://www.api.org/energy-insights/statistics/wsb';
  const VERIFIED_AT = Date.parse('2026-11-25T15:45:00Z') / 1000;
  const VERIFIED = {
    checkedAt: VERIFIED_AT,
    coverage: { from: '2026-01-01', to: '2026-12-31' },
    eiaExceptions: [
      ['2026-01-16', '2026-01-22', 12], ['2026-02-13', '2026-02-19', 12],
      ['2026-05-22', '2026-05-28', 12], ['2026-09-04', '2026-09-10', 12],
      ['2026-10-09', '2026-10-15', 12], ['2026-11-06', '2026-11-12', 12],
    ],
    apiPublicationDates: ['2026-11-24', '2026-12-01', '2026-12-08', '2026-12-15', '2026-12-22', '2026-12-29'],
    apiSchedule: 'https://apidam.widen.net/content/tmdaz5guc6/pdf/APIorg_Documents_WSB-Schedule-of-Releases-2026_20260930.pdf',
    reports: [
      { id: 'iea-2026-12', title: 'IEA 月度油市报告', date: '2026-12-11', source: 'IEA', sourceUrl: 'https://www.iea.org/events/oil-market-report-december-2026' },
      { id: 'opec-2026-12', title: 'OPEC 月度油市报告', date: '2026-12-14', source: 'OPEC', sourceUrl: 'https://www.opec.org/monthly-oil-market-report.html' },
    ],
  };

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function dateKey(date) { return date.toISOString().slice(0, 10); }
  function shift(date, days) { return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000); }

  // Convert a wall-clock event in its source time zone. Iterate the UTC offset so
  // US daylight-saving transitions do not become a fixed SGT release hour.
  function zonedTime(date, hour, minute, timeZone) {
    const target = Date.parse(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
    let utc = target;
    for (let i = 0; i < 3; i++) {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      }).formatToParts(new Date(utc)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
      const represented = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
      utc += target - represented;
    }
    return utc / 1000;
  }

  function parseEnglishDate(text) {
    const match = String(text).trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/);
    if (!match) return null;
    const month = MONTHS.indexOf(match[1].toLowerCase());
    if (month < 0) return null;
    const date = `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[2].padStart(2, '0')}`;
    const parsed = new Date(`${date}T12:00:00Z`);
    return Number.isFinite(parsed.getTime()) && dateKey(parsed) === date ? date : null;
  }

  function parseEiaSchedule(html, checkedAt) {
    if (typeof html !== 'string' || !/10:30\s*a\.m\./i.test(html) || !/Wednesday/.test(html)) return null;
    const exceptions = [];
    for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map(cell => cell[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
      if (cells.length < 4) continue;
      const weekEnding = parseEnglishDate(cells[0]);
      const publicationDate = parseEnglishDate(cells[1]);
      const time = cells[3].match(/(\d{1,2}):(\d{2})\s*([ap])\.m\./i);
      if (!weekEnding || !publicationDate || !time) continue;
      const hour = Number(time[1]) % 12 + (time[3].toLowerCase() === 'p' ? 12 : 0);
      exceptions.push([weekEnding, publicationDate, hour, Number(time[2])]);
    }
    if (!exceptions.length) return null;
    const counts = new Map();
    for (const row of exceptions) { const year = Number(row[0].slice(0, 4)); counts.set(year, (counts.get(year) || 0) + 1); }
    // A trailing single January exception is not evidence of a complete annual schedule.
    const years = [...counts].filter(([, count]) => count >= 3).map(([year]) => year);
    if (!years.length) years.push(Number(new Date(checkedAt * 1000).getUTCFullYear()));
    return {
      checkedAt, exceptions,
      coverage: { from: `${Math.min(...years)}-01-01`, to: `${Math.max(...years)}-12-31` },
    };
  }

  function buildCalendar({ now = Date.now() / 1000, eiaSchedule = null, days = 21 } = {}) {
    const eia = eiaSchedule || { exceptions: VERIFIED.eiaExceptions, coverage: VERIFIED.coverage, checkedAt: VERIFIED.checkedAt };
    const start = now - 86400;
    const end = now + Math.min(60, Math.max(1, days)) * 86400;
    const events = [];
    const first = new Date(start * 1000);
    first.setUTCHours(12, 0, 0, 0);
    for (let offset = -10; offset <= days; offset++) {
      const day = new Date(first.getTime() + offset * 86400000);
      if (day.getUTCDay() !== 5) continue;
      const weekEnding = dateKey(day);
      if (weekEnding < eia.coverage.from || weekEnding > eia.coverage.to) continue;
      const exception = eia.exceptions.find(row => row[0] === weekEnding);
      const date = exception?.[1] || dateKey(shift(weekEnding, 5));
      const at = zonedTime(date, exception?.[2] ?? 10, exception?.[3] ?? (exception ? 0 : 30), 'America/New_York');
      if (at < start || at > end) continue;
      events.push({ id: `eia-${weekEnding}`, title: 'EIA 周度石油库存', source: 'EIA', sourceUrl: EIA_URL,
        date, at, dateOnly: false, approximate: false, weekEnding, checkedAt: eia.checkedAt,
        scheduleBasis: exception ? 'official-holiday-exception' : 'official-weekly-rule',
        actual: null, consensus: null, previous: null });
    }
    for (const date of VERIFIED.apiPublicationDates) {
      const at = zonedTime(date, 16, 30, 'America/New_York');
      if (at < start || at > end) continue;
      events.push({ id: `api-${date}`, title: 'API 周度石油库存', source: 'API', sourceUrl: API_URL,
        scheduleUrl: VERIFIED.apiSchedule, date, at, dateOnly: false, approximate: true,
        checkedAt: VERIFIED.checkedAt, scheduleBasis: 'official-annual-calendar', actual: null, consensus: null, previous: null });
    }
    for (const report of VERIFIED.reports) {
      const sortingAt = Date.parse(`${report.date}T00:00:00Z`) / 1000;
      if (sortingAt < start || sortingAt > end) continue;
      events.push({ ...report, at: null, dateOnly: true, approximate: false, checkedAt: VERIFIED.checkedAt,
        scheduleBasis: 'official-date-only', actual: null, consensus: null, previous: null });
    }
    events.sort((a, b) => (a.at ?? Date.parse(`${a.date}T00:00:00Z`) / 1000) - (b.at ?? Date.parse(`${b.date}T00:00:00Z`) / 1000));
    return {
      schemaVersion: 1, generatedAt: now, checkedAt: eia.checkedAt,
      status: eiaSchedule ? 'verified' : 'cached-schedule', events,
      coverage: eia.coverage,
      sourceCoverage: { eia: eia.coverage, api: VERIFIED.coverage, monthlyReports: VERIFIED.coverage },
      note: '日程不代表数据已经发布。前值、预期、实际尚无已核验数据时显示 —；月报未公布时刻不猜时间。',
      sources: [
        { name: 'EIA', url: EIA_URL }, { name: 'API', url: API_URL },
        { name: 'IEA', url: 'https://www.iea.org/events' },
        { name: 'OPEC', url: 'https://www.opec.org/monthly-oil-market-report.html' },
      ],
    };
  }

  const state = { baseUrl: 'https://oil-proxy.xzregproxy.workers.dev', pending: null, metadataLoaded: false };
  function formatTime(at) {
    return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Singapore', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at * 1000));
  }
  function render(calendar) {
    const el = root.document?.getElementById('energyCalendar');
    if (!el) return;
    const items = Array.isArray(calendar?.events) ? calendar.events : [];
    const now = Date.now() / 1000;
    const rows = items.map(event => {
      const time = event.dateOnly ? `${event.date} · 时刻待确认` : `${formatTime(event.at)} SGT${event.approximate ? ' 左右' : ''}`;
      const status = event.dateOnly ? '日期已确认' : (event.at < now ? '到达计划时点' : '计划发布');
      const url = /^https:\/\//.test(event.sourceUrl || '') ? event.sourceUrl : '#';
      return `<tr><th scope="row"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(event.title)}</a><small>${esc(event.source)} · ${esc(status)}</small></th><td>${esc(time)}</td><td>—</td><td>—</td><td>—</td></tr>`;
    }).join('');
    el.innerHTML = `<div class="calendar-table-wrap"><table class="calendar-table"><caption class="sr-only">官方能源发布日历；前值预期和实际无已核验数据时为空</caption><thead><tr><th scope="col">事件 / 原始来源</th><th scope="col">发布时间</th><th scope="col">前值</th><th scope="col">预期</th><th scope="col">实际</th></tr></thead><tbody>${rows || '<tr><td colspan="5">当前覆盖范围内暂无已确认日程</td></tr>'}</tbody></table></div><p class="calendar-note">${esc(calendar?.note || '')} 日程核验：${calendar?.checkedAt ? esc(formatTime(calendar.checkedAt)) + ' SGT' : '待确认'}${calendar?.status === 'cached-schedule' ? ' · 使用已核验日程存档' : ''}。</p>`;
  }
  async function loadMetadata() {
    if (state.metadataLoaded) return;
    try {
      const response = await fetch('build-info.json', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!response.ok) return;
      const data = await response.json();
      const version = root.document?.getElementById('dataVersion');
      const last = root.document?.getElementById('dataLastSuccess');
      const deploy = root.document?.getElementById('deploymentInfo');
      if (version) version.textContent = `版本 ${String(data.gitSha || data.commit || '开发版').slice(0, 8)}`;
      const built = data.builtAt || data.buildTime;
      if (deploy && built) deploy.textContent = `构建 ${formatTime(Date.parse(built) / 1000)} SGT`;
      const latest = data.oott?.latestPostAt || data.data?.oott?.latestPostAt || data.oottLatestPostAt;
      if (last) last.textContent = latest ? `资讯原文最新 ${formatTime(Date.parse(latest) / 1000)} SGT` : '资讯更新以原文时间为准';
      state.metadataLoaded = true;
    } catch { /* Local source preview has no build metadata. */ }
  }
  function init(options = {}) { if (options.baseUrl) state.baseUrl = options.baseUrl.replace(/\/$/, ''); }
  async function refresh() {
    if (state.pending) return state.pending;
    state.pending = (async () => {
      const metadata = loadMetadata();
      let calendar;
      try {
        const response = await fetch(`${state.baseUrl}/api/calendar`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error('calendar-unavailable');
        calendar = await response.json();
        if (calendar.schemaVersion !== 1 || !Array.isArray(calendar.events)) throw new Error('calendar-invalid');
      } catch { calendar = buildCalendar(); }
      render(calendar);
      await metadata;
      return calendar;
    })();
    try { return await state.pending; } finally { state.pending = null; }
  }

  root.OilEnergy = { init, refresh, render, buildCalendar, parseEiaSchedule, zonedTime, VERIFIED };
})(globalThis);
