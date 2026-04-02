// ========== Cloudflare Worker — Yahoo Finance CORS Proxy ==========
// 部署方式 (任选其一):
//   1. npx wrangler deploy workers/proxy.js --name oil-proxy
//   2. Cloudflare Dashboard → Workers → Create → 粘贴此代码
// 部署后将 URL 填入 app.js 的 CF_WORKER_URL 变量
// 免费额度: 100,000 次/天

export default {
  async fetch(request) {
    const url = new URL(request.url);
    // 处理 CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
      });
    }
    const target = url.searchParams.get('url');
    if (!target) return new Response('Missing ?url= param', { status: 400 });
    // 白名单: 仅允许 Yahoo Finance
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
