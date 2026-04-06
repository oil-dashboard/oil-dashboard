// ========== Cloudflare Worker — Yahoo Finance & Twitter Headless Proxy ==========
// 部署方式: npx wrangler deploy workers/proxy.js --name oil-proxy --compatibility-date 2024-04-03
//
export default {
  async fetch(request) {
    const url = new URL(request.url);

    // 1. CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
      });
    }

    // 2. Twitter Syndication API Proxy
    const twitterHandle = url.searchParams.get('twitter');
    if (twitterHandle) {
      if (!/^[A-Za-z0-9_]{1,15}$/.test(twitterHandle)) {
        return new Response('Invalid handle', { status: 400 });
      }
      try {
        const syndicationUrl = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${twitterHandle}`;
        const resp = await fetch(syndicationUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36' },
        });
        if (!resp.ok) return new Response('Twitter Syndication API non-200', { status: 502 });

        const html = await resp.text();
        const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
        if (!match) return new Response('No NEXT_DATA found', { status: 502 });

        const data = JSON.parse(match[1]);
        const entries = data?.props?.pageProps?.timeline?.entries || [];

        const posts = [];
        for (const entry of entries) {
          const tweet = entry?.content?.tweet;
          if (!tweet) continue;
          
          posts.push({
            id: tweet.id_str,
            author: tweet.user?.name,
            handle: tweet.user?.screen_name,
            text: tweet.text || '',
            createdAt: tweet.created_at,
            url: `https://x.com/${tweet.user?.screen_name}/status/${tweet.id_str}`,
            photos: (tweet.entities?.media || []).filter(m => m.type === 'photo').map(m => m.media_url_https),
            videos: (tweet.entities?.media || []).filter(m => m.type === 'video' || m.type === 'animated_gif').map(m => m.media_url_https),
            engagement: (tweet.favorite_count || 0) + (tweet.retweet_count || 0) + (tweet.reply_count || 0)
          });
        }

        return new Response(JSON.stringify(posts), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=120',
          },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } });
      }
    }

    // 3. Yahoo Finance Proxy
    const target = url.searchParams.get('url');
    if (!target) return new Response('Missing ?url= or ?twitter= param', { status: 400 });

    try {
      const t = new URL(target);
      if (!t.hostname.endsWith('yahoo.com')) return new Response('Domain not allowed', { status: 403 });
    } catch { return new Response('Invalid URL', { status: 400 }); }

    const resp = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible)' } });
    return new Response(await resp.text(), {
      status: resp.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=60',
      },
    });
  },
};

