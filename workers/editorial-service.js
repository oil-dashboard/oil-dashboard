const FEEDS = Object.freeze({
  market: [
    { name: 'Oilprice.com', url: 'https://oilprice.com/rss/main' },
    { name: 'The Guardian · Oil', url: 'https://www.theguardian.com/business/oil/rss' },
  ],
  geo: [
    { name: 'The Guardian · Iran', url: 'https://www.theguardian.com/world/iran/rss' },
    { name: 'Oilprice.com', url: 'https://oilprice.com/rss/main' },
  ],
});
const GEO_TERMS = /iran|hormuz|houthi|tanker|sanction|kharg|ras tanura|middle east|gulf|saudi/i;

function decode(value) {
  return String(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, key) => {
    if (key[0] === '#') {
      const number = key[1].toLowerCase() === 'x' ? Number.parseInt(key.slice(2), 16) : Number(key.slice(1));
      return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[key.toLowerCase()] || entity;
  }).trim();
}

export function parseRss(xml, feed, now) {
  if (typeof xml !== 'string' || !/<rss\b/i.test(xml)) return [];
  const field = (block, tag) => decode(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block)?.[1] || '');
  const rows = [];
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const title = field(match[1], 'title');
    const link = field(match[1], 'link');
    const published = Date.parse(field(match[1], 'pubDate')) / 1000;
    let parsed;
    try { parsed = new URL(link); } catch { continue; }
    if (!['http:', 'https:'].includes(parsed.protocol) || !title || !Number.isFinite(published) || published > now + 300 || now - published > 7 * 86400) continue;
    rows.push({ title: title.slice(0, 500), link: parsed.href, source: feed.name, sourceUrl: feed.url,
      pubDate: new Date(published * 1000).toISOString(), publishedAt: published });
  }
  return rows;
}

export function createEditorialService({ fetchImpl = globalThis.fetch, now = () => Date.now() / 1000 } = {}) {
  const cache = new Map();
  return async function editorialService(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/news') return null;
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    const respond = (data, status = 200) => new Response(request.method === 'HEAD' ? null : JSON.stringify(data), { status, headers });
    if (!['GET', 'HEAD'].includes(request.method)) return respond({ error: 'method-not-allowed' }, 405);
    const topic = url.searchParams.get('topic') || 'market';
    if (!Object.hasOwn(FEEDS, topic)) return respond({ error: 'invalid-topic' }, 400);
    const timestamp = now();
    const old = cache.get(topic);
    if (old && timestamp - old.fetchedAt < 300) return respond({ ...old, cache: 'hit' });
    const results = await Promise.allSettled(FEEDS[topic].map(async feed => {
      const response = await fetchImpl(feed.url, { redirect: 'manual', signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/rss+xml, application/xml, text/xml' } });
      if (!response.ok) throw new Error('feed-unavailable');
      const rows = parseRss(await response.text(), feed, timestamp);
      if (!rows.length) throw new Error('feed-empty');
      return rows;
    }));
    const items = results.flatMap(result => result.status === 'fulfilled' ? result.value : [])
      .filter(item => topic !== 'geo' || GEO_TERMS.test(item.title))
      .sort((a, b) => b.publishedAt - a.publishedAt);
    const unique = [...new Map(items.map(item => [item.link, item])).values()].slice(0, 30);
    if (!unique.length) {
      if (old && timestamp - old.fetchedAt < 6 * 3600) return respond({ ...old, cache: 'stale', status: 'cached' });
      return respond({ schemaVersion: 1, topic, status: 'unavailable', items: [], fetchedAt: timestamp }, 503);
    }
    const payload = { schemaVersion: 1, topic, status: results.every(result => result.status === 'fulfilled') ? 'available' : 'partial',
      fetchedAt: timestamp, latestPublishedAt: unique[0].publishedAt, items: unique,
      sources: FEEDS[topic], unavailableSources: results.flatMap((result, index) => result.status === 'rejected' ? [FEEDS[topic][index].name] : []) };
    cache.set(topic, payload);
    return respond({ ...payload, cache: 'miss' });
  };
}

export const editorialService = createEditorialService();
