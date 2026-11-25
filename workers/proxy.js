import { marketService } from './market-service.js';
import { getEnergyCalendar } from './calendar-service.js';
import { editorialService } from './editorial-service.js';

const PUBLIC_HEADERS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff',
});
const ALLOWED_HOSTS = new Set([
  'query1.finance.yahoo.com', 'finance.yahoo.com', 'skill.capduck.com',
  'news.google.com', 'gamma-api.polymarket.com',
]);

function json(payload, status = 200, head = false) {
  return new Response(head ? null : JSON.stringify(payload), {
    status, headers: { ...PUBLIC_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export function createProxy({ fetchImpl = globalThis.fetch, service = marketService, calendar = getEnergyCalendar } = {}) {
  return {
    async fetch(request, env = {}, context = {}) {
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: PUBLIC_HEADERS });
      const editorialResponse = await editorialService(request);
      if (editorialResponse) return editorialResponse;
      const marketResponse = await service(request, env, context);
      if (marketResponse) return marketResponse;
      const head = request.method === 'HEAD';
      if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'method-not-allowed' }, 405, head);
      if (url.pathname === '/api/calendar') {
        try {
          return json(await calendar({ fetchImpl, now: Date.now() / 1000 }), 200, head);
        } catch { return json({ schemaVersion: 1, status: 'unavailable', error: 'calendar-unavailable' }, 503, head); }
      }
      if (url.pathname.startsWith('/api/')) return json({ error: 'not-found' }, 404, head);

      const twitterHandle = url.searchParams.get('twitter');
      if (twitterHandle) {
        if (!/^[A-Za-z0-9_]{1,15}$/.test(twitterHandle)) return json({ error: 'invalid-handle' }, 400, head);
        try {
          const response = await fetchImpl(`https://syndication.twitter.com/srv/timeline-profile/screen-name/${twitterHandle}`, {
            redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0' },
          });
          if (!response.ok) return json({ error: 'twitter-upstream-unavailable' }, 502, head);
          const html = await response.text();
          const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
          if (!match) return json({ error: 'twitter-data-unavailable' }, 502, head);
          const entries = JSON.parse(match[1])?.props?.pageProps?.timeline?.entries || [];
          const posts = [];
          for (const entry of entries) {
            const tweet = entry?.content?.tweet;
            if (!tweet?.id_str || !tweet.user?.screen_name) continue;
            const media = tweet.entities?.media || [];
            posts.push({
              id: tweet.id_str, author: tweet.user.name, handle: tweet.user.screen_name,
              text: tweet.text || '', createdAt: tweet.created_at,
              url: `https://x.com/${tweet.user.screen_name}/status/${tweet.id_str}`,
              photos: media.filter(item => item.type === 'photo').map(item => item.media_url_https),
              videos: media.filter(item => ['video', 'animated_gif'].includes(item.type)).map(item => item.media_url_https),
              engagement: (tweet.favorite_count || 0) + (tweet.retweet_count || 0) + (tweet.reply_count || 0),
            });
          }
          return json(posts, 200, head);
        } catch { return json({ error: 'twitter-upstream-unavailable' }, 502, head); }
      }

      // Compatibility endpoint. Price and all metadata come from one exact scanner row.
      const tvKind = url.searchParams.get('tvsymbol');
      if (tvKind) {
        const symbols = { brent: 'ICEEUR:BRN1!', wti: 'NYMEX:CL1!' };
        if (!Object.hasOwn(symbols, tvKind)) return json({ error: 'invalid-tvsymbol' }, 400, head);
        try {
          const columns = ['close', 'change', 'change_abs', 'last_bar_update_time', 'update_mode'];
          const response = await fetchImpl('https://scanner.tradingview.com/futures/scan', {
            method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(7000),
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
            body: JSON.stringify({ symbols: { tickers: [symbols[tvKind]], query: { types: [] } }, columns }),
          });
          if (!response.ok) return json({ error: 'tradingview-upstream-unavailable' }, 502, head);
          const payload = await response.json();
          const row = payload?.data?.find(item => item.s === symbols[tvKind]);
          if (!row || typeof row.d?.[0] !== 'number' || !Number.isFinite(row.d[0])) return json({ error: 'tradingview-data-unavailable' }, 502, head);
          return json({
            kind: tvKind, symbol: row.s, price: row.d[0], changePercent: row.d[1], change: row.d[2],
            priceAt: null, providerUpdatedAt: row.d[3], timeBasis: 'provider-update',
            updateMode: row.d[4], delaySeconds: /^delayed_streaming_(\d+)$/.exec(row.d[4] || '')?.[1] * 1 || null,
            barTime: null, fetchedAt: Date.now() / 1000, source: 'tradingview',
          }, 200, head);
        } catch { return json({ error: 'tradingview-upstream-unavailable' }, 502, head); }
      }

      const target = url.searchParams.get('url');
      if (!target) return json({ error: 'missing-target', endpoints: ['/api/market', '/api/curve', '/api/calendar', '/api/health'] }, 400, head);
      let parsedTarget;
      try { parsedTarget = new URL(target); }
      catch { return json({ error: 'invalid-url' }, 400, head); }
      if (parsedTarget.protocol !== 'https:' || parsedTarget.username || parsedTarget.password ||
          (parsedTarget.port && parsedTarget.port !== '443') || !ALLOWED_HOSTS.has(parsedTarget.hostname)) {
        return json({ error: 'target-not-allowed' }, 403, head);
      }
      try {
        const headers = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json,text/plain,*/*' };
        if (parsedTarget.hostname === 'gamma-api.polymarket.com') {
          headers.Origin = 'https://polymarket.com';
          headers.Referer = 'https://polymarket.com/';
        }
        const response = await fetchImpl(parsedTarget.href, {
          headers, redirect: 'manual', signal: AbortSignal.timeout(12000),
        });
        if (response.status >= 300 && response.status < 400) return json({ error: 'upstream-redirect-rejected' }, 502, head);
        return new Response(head ? null : response.body, {
          status: response.status,
          headers: { ...PUBLIC_HEADERS, 'Content-Type': response.headers.get('Content-Type') || 'text/plain; charset=utf-8' },
        });
      } catch { return json({ error: 'upstream-unavailable' }, 502, head); }
    },
  };
}

export default createProxy();
