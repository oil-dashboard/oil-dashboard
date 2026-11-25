import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRss, createEditorialService } from '../workers/editorial-service.js';
const NOW = Date.parse('2026-11-25T16:00:00Z') / 1000;
const feed = { name: 'Publisher', url: 'https://publisher.example/rss' };
const item = (title = 'Oil inventories rise', link = 'https://publisher.example/article', pubDate = 'Wed, 25 Nov 2026 15:42:56 GMT') => `<item><title><![CDATA[${title}]]></title><link>${link}</link><pubDate>${pubDate}</pubDate></item>`;
const rss = rows => `<rss><channel>${rows}</channel></rss>`;

test('RSS preserves real publisher and original publication time without trusting markup or fetch time', () => {
  const rows = parseRss(rss(item('Oil &amp; gas <script>x</script>')), feed, NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'Publisher');
  assert.equal(rows[0].sourceUrl, feed.url);
  assert.equal(rows[0].pubDate, '2026-11-25T15:42:56.000Z');
  assert.equal(rows[0].title.includes('<script>'), false);
});

test('RSS refuses HTML impostors, script links, future dates and obsolete items', () => {
  assert.deepEqual(parseRss('<html>Sorry...</html>', feed, NOW), []);
  const xml = rss(item('bad', 'javascript:alert(1)') + item('future', undefined, 'Wed, 25 Nov 2026 17:00:00 GMT') + item('old', undefined, 'Wed, 11 Nov 2026 15:00:00 GMT'));
  assert.deepEqual(parseRss(xml, feed, NOW), []);
});

test('editorial API serves independent sources with source-time ordering and a bounded last-good fallback', async () => {
  let now = NOW, outage = false;
  const service = createEditorialService({ now: () => now, fetchImpl: async (_url, options) => {
    assert.equal(options.redirect, 'manual');
    if (outage) return new Response('', { status: 503 });
    return new Response(rss(item()));
  } });
  const request = new Request('https://worker.example/api/news?topic=market');
  let response = await service(request), payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.items.length, 1);
  assert.equal(payload.cache, 'miss');
  const fetchedAt = payload.fetchedAt;
  outage = true; now += 301;
  payload = await (await service(request)).json();
  assert.equal(payload.cache, 'stale');
  assert.equal(payload.fetchedAt, fetchedAt);
  assert.equal(payload.items[0].publishedAt, Date.parse('2026-11-25T15:42:56Z') / 1000);
  now += 6 * 3600;
  assert.equal((await service(request)).status, 503);
});

test('topic and method validation never requests upstream, while geographic news filters unrelated stories', async () => {
  let calls = 0;
  const service = createEditorialService({ now: () => NOW, fetchImpl: async () => { calls++; return new Response(rss(item('Iran tanker sanctions') + item('New phone launch', 'https://publisher.example/phone'))); } });
  assert.equal((await service(new Request('https://worker.example/api/news?topic=arbitrary'))).status, 400);
  assert.equal((await service(new Request('https://worker.example/api/news', { method: 'POST' }))).status, 405);
  assert.equal(calls, 0);
  const payload = await (await service(new Request('https://worker.example/api/news?topic=geo'))).json();
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].title, 'Iran tanker sanctions');
});
