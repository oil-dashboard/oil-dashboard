// ========== Cloudflare Worker — Yahoo Finance & Twitter Headless Proxy ==========
// 部署方式: npx wrangler deploy workers/proxy.js --name oil-proxy --compatibility-date 2024-04-03
//
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const jsonHeaders = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store, max-age=0',
    };

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
            'Cache-Control': 'no-store, max-age=0',
          },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } });
      }
    }

    // 3. TradingView Symbol Page Price Fallback
    const tvSymbol = url.searchParams.get('tvsymbol');
    if (tvSymbol) {
      const tvTargets = {
        brent: [
          'https://www.tradingview.com/symbols/TVC-UKOIL/',
          'https://www.tradingview.com/symbols/CAPITALCOM-OIL_BRENT/',
          'https://www.tradingview.com/symbols/BLACKBULL-BRENT/',
          'https://www.tradingview.com/symbols/PEPPERSTONE-SPOTBRENT/',
        ],
        wti: [
          'https://www.tradingview.com/symbols/NYMEX-CL1!/',
          'https://www.tradingview.com/symbols/TVC-USOIL/',
        ],
      };
      const pageUrls = tvTargets[tvSymbol];
      if (!pageUrls) return new Response('Invalid tvsymbol', { status: 400 });
      try {
        const candidates = [];
        for (const pageUrl of pageUrls) {
          const resp = await fetch(pageUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible)' },
          });
          if (!resp.ok) continue;
          const html = await resp.text();
          const matches = html.matchAll(/<script type="application\/prs\.init-data\+json">([\s\S]*?)<\/script>/g);
          for (const match of matches) {
            const root = JSON.parse(match[1]);
            for (const entry of Object.values(root || {})) {
              const symbol = entry?.data?.symbol;
              const price = symbol?.trade?.price ?? symbol?.daily_bar?.close;
              if (price == null) continue;
              candidates.push({
                price: Number(price),
                barTime: Number(symbol?.daily_bar?.time) || null,
                updateTime: Number(symbol?.daily_bar?.update_time || symbol?.daily_bar?.data_update_time) || null,
                symbol: symbol?.pro_symbol || symbol?.resolved_symbol || null,
              });
            }
          }
        }
        if (!candidates.length) {
          return new Response(JSON.stringify({ error: 'No TradingView symbol data found' }), { status: 502, headers: jsonHeaders });
        }
        const preferredPrice = candidates[0];
        const freshest = [...candidates].sort((a, b) => {
          const barDiff = (Number.isFinite(b.barTime) ? b.barTime : -Infinity) - (Number.isFinite(a.barTime) ? a.barTime : -Infinity);
          if (barDiff !== 0) return barDiff;
          return (Number.isFinite(b.updateTime) ? b.updateTime : -Infinity) - (Number.isFinite(a.updateTime) ? a.updateTime : -Infinity);
        })[0];
        return new Response(JSON.stringify({
          kind: tvSymbol,
          price: (tvSymbol === 'brent' ? preferredPrice : freshest).price,
          barTime: freshest.barTime,
          fetchedAt: Date.now() / 1000,
          source: 'tradingview',
          symbol: (tvSymbol === 'brent' ? preferredPrice : freshest).symbol,
        }), { headers: jsonHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: jsonHeaders });
      }
    }

    // 4. Generic upstream proxy for approved domains
    const target = url.searchParams.get('url');
    if (!target) return new Response('Missing ?url= or ?twitter= param', { status: 400 });

    let parsedTarget;
    try {
      parsedTarget = new URL(target);
    } catch { return new Response('Invalid URL', { status: 400 }); }

    const allowedHosts = ['query1.finance.yahoo.com', 'finance.yahoo.com', 'skill.capduck.com'];
    if (!allowedHosts.includes(parsedTarget.hostname)) {
      return new Response('Domain not allowed', { status: 403 });
    }

    const resp = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible)' } });
    const passthroughHeaders = new Headers();
    const contentType = resp.headers.get('content-type');
    if (contentType) passthroughHeaders.set('Content-Type', contentType);
    passthroughHeaders.set('Access-Control-Allow-Origin', '*');
    passthroughHeaders.set('Cache-Control', 'no-store, max-age=0');

    return new Response(await resp.text(), {
      status: resp.status,
      headers: passthroughHeaders,
    });
  },
};
