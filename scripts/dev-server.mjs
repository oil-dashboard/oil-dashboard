import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };
const SOURCE_ROOT_FILES = new Set(['index.html', 'style.css', 'app.js', 'market-ui.js', 'sw.js', 'sources.json', 'manifest.json', 'build-info.json']);

export function createDevServer({ rootDir, workerUrl = 'https://oil-proxy.xzregproxy.workers.dev', fetchImpl = fetch } = {}) {
  const canonicalRoot = realpath(path.resolve(rootDir));
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed'); return; }
    try {
      const root = await canonicalRoot;
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        const upstream = new URL(`${url.pathname}${url.search}`, workerUrl);
        const fetched = await fetchImpl(upstream, { signal: AbortSignal.timeout(25000) });
        response.writeHead(fetched.status, { 'Content-Type': fetched.headers.get('content-type') || 'application/json' });
        response.end(request.method === 'HEAD' ? undefined : Buffer.from(await fetched.arrayBuffer()));
        return;
      }
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const allowed = SOURCE_ROOT_FILES.has(relative)
        || /^shared\/[\w-]+\.js$/.test(relative)
        || /^data\/[\w-]+\.json$/.test(relative)
        || /^vendor\/(?:lightweight-charts\.standalone\.production\.js|LICENSE\.lightweight-charts|NOTICE\.lightweight-charts)$/.test(relative);
      if (!allowed) { response.writeHead(404).end('Not found'); return; }
      const absolute = await realpath(path.join(root, relative));
      if (!absolute.startsWith(`${root}${path.sep}`) || !(await stat(absolute)).isFile()) { response.writeHead(404).end('Not found'); return; }
      const body = await readFile(absolute);
      response.writeHead(200, { 'Content-Type': TYPES[path.extname(relative)] || 'text/plain; charset=utf-8', 'Content-Length': body.byteLength });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      const missing = ['ENOENT', 'ENOTDIR', 'URIError'].includes(error.code || error.name);
      response.writeHead(missing ? 404 : 502, { 'Content-Type': 'text/plain; charset=utf-8' }).end(missing ? 'Not found' : 'Upstream request failed');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const rootDir = path.resolve(option('--root', args.includes('--dist') ? path.join(projectRoot, 'dist') : projectRoot));
  const port = Number(option('--port', process.env.PORT || '8082'));
  const host = option('--host', '127.0.0.1');
  const server = createDevServer({ rootDir, workerUrl: option('--worker-url', process.env.OIL_WORKER_URL || 'https://oil-proxy.xzregproxy.workers.dev') });
  server.listen(port, host, () => console.log(`Oil Dashboard preview: http://${host}:${port}/ (${rootDir})`));
}
