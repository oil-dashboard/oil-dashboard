import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { build, ROOT_FILES } from '../scripts/build.mjs';
import { createDevServer } from '../scripts/dev-server.mjs';
import { verifyDeployment } from '../scripts/verify-deployment.mjs';

const gitSha = 'a'.repeat(40);
const builtAt = '2026-11-25T15:00:00.000Z';
const swSource = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const digest = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'oil-build-test-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  for (const file of ROOT_FILES) {
    const data = file === 'index.html' ? '<html><link href="style.css"><script src="app.js?v=old"></script></html>'
      : file === 'sw.js' ? swSource : file.endsWith('.json') ? '{}' : '/* public asset */';
    await writeFile(path.join(rootDir, file), data);
  }
  for (const directory of ['shared', 'data', 'vendor', 'tests', 'workers', '.git', '.wrangler']) await mkdir(path.join(rootDir, directory));
  await writeFile(path.join(rootDir, 'shared/market-core.js'), 'globalThis.OilMarket = {};');
  await writeFile(path.join(rootDir, 'shared/energy-calendar.js'), 'globalThis.OilCalendar = {};');
  await writeFile(path.join(rootDir, 'workers/proxy.js'), 'export default {};');
  await writeFile(path.join(rootDir, 'wrangler.jsonc'), '{"name":"oil-proxy"}');
  await writeFile(path.join(rootDir, 'data/oott.json'), JSON.stringify([{ createdAt: '2026-11-25T14:06:12Z', text: 'test' }]));
  for (const name of ['lightweight-charts.standalone.production.js', 'LICENSE.lightweight-charts', 'NOTICE.lightweight-charts']) await writeFile(path.join(rootDir, 'vendor', name), `/* ${name} */`);
  for (const file of ['.env', 'task_plan.md', '.git/config', '.wrangler/oauth.json', 'tests/secret.js', 'workers/private.js', 'vendor/secret.json', 'data/.secret.json']) await writeFile(path.join(rootDir, file), 'MUST_NOT_SHIP');
  return rootDir;
}

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/`;
}

test('build ships only public regular files, fingerprints assets, and describes exact deployed bytes', async t => {
  const rootDir = await fixture(t);
  const metadata = await build({ rootDir, gitSha, builtAt, vendor: false });
  assert.equal(metadata.gitSha, gitSha);
  assert.equal(metadata.builtAt, builtAt);
  assert.match(metadata.workerDigest, /^[a-f0-9]{64}$/);
  assert.equal(metadata.data.oott.count, 1);
  assert.equal(metadata.data.oott.latestPostAt, '2026-11-25T14:06:12.000Z');
  const entries = await readdir(path.join(rootDir, 'dist'), { recursive: true });
  assert.equal(entries.some(file => /secret|\.git|\.wrangler|task_plan|tests|workers|\.env/.test(file)), false);
  assert.ok(entries.includes('vendor/LICENSE.lightweight-charts'));
  const html = await readFile(path.join(rootDir, 'dist/index.html'), 'utf8');
  assert.match(html, /app\.js\?v=[a-f0-9]{12}/);
  assert.doesNotMatch(html, /v=old/);
  const sw = await readFile(path.join(rootDir, 'dist/sw.js'), 'utf8');
  assert.ok(sw.includes(`oil-dash-${metadata.version}`));
  assert.ok(sw.includes(`./app.js?v=${digest('/* public asset */').slice(0, 12)}`));
  assert.doesNotMatch(sw.match(/const STATIC_ASSETS = \[[\s\S]*?\];/)[0], /oott|sources|build-info|manifest\.json/);
  for (const asset of metadata.assets) assert.equal(digest(await readFile(path.join(rootDir, 'dist', asset.path))), asset.sha256);
  const rebuilt = await build({ rootDir, gitSha, builtAt, vendor: false });
  assert.deepEqual(rebuilt, metadata);
});

test('build rejects symlinks that could expose files outside the public root', async t => {
  const rootDir = await fixture(t);
  await symlink(path.join(rootDir, '.env'), path.join(rootDir, 'shared/credentials.js'));
  await assert.rejects(build({ rootDir, gitSha, builtAt, vendor: false }), /regular files/);
});

test('build refuses to clear an output directory outside the project', async t => {
  const rootDir = await fixture(t);
  await assert.rejects(build({ rootDir, outDir: path.dirname(rootDir), gitSha, builtAt, vendor: false }), /subdirectory/);
});

test('build fails before publishing a page with missing assets or malformed JSON', async t => {
  const rootDir = await fixture(t);
  await writeFile(path.join(rootDir, 'index.html'), '<script src="shared/missing.js"></script>');
  await assert.rejects(build({ rootDir, gitSha, builtAt, vendor: false }), /not in the public build/);
  await writeFile(path.join(rootDir, 'index.html'), '<script src="app.js"></script>');
  await writeFile(path.join(rootDir, 'sources.json'), '{');
  await assert.rejects(build({ rootDir, gitSha, builtAt, vendor: false }), /Invalid JSON public asset/);
});

test('deployment verification checks commit and actual asset hashes through the preview server', async t => {
  const rootDir = await fixture(t);
  await build({ rootDir, gitSha, builtAt, vendor: false });
  const baseUrl = await listen(t, createDevServer({ rootDir: path.join(rootDir, 'dist') }));
  const result = await verifyDeployment({ baseUrl, expectedSha: gitSha, checkHealth: false });
  assert.equal(result.gitSha, gitSha);
  await assert.rejects(verifyDeployment({ baseUrl, expectedSha: 'b'.repeat(40), checkHealth: false }), /Wrong deployed commit/);
  await writeFile(path.join(rootDir, 'dist/app.js'), '/* stale CDN content */');
  await assert.rejects(verifyDeployment({ baseUrl, expectedSha: gitSha, checkHealth: false }), /content hash/);
});

test('deployment verification rejects HTML returned with HTTP 200 for a script', async () => {
  const metadata = { schemaVersion: 1, gitSha, workerDigest: 'f'.repeat(64), assets: [{ path: 'index.html', contentType: 'text/html', sha256: digest('<html></html>') }, { path: 'app.js', contentType: 'application/javascript', sha256: digest('code') }] };
  const fetchImpl = async url => url.pathname.endsWith('.json')
    ? new Response(JSON.stringify(metadata), { headers: { 'Content-Type': 'application/json' } })
    : new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } });
  await assert.rejects(verifyDeployment({ baseUrl: 'https://example.test/oil/', expectedSha: gitSha, checkHealth: false, fetchImpl }), /expected application\/javascript/);
});

test('preview never exposes repository files and proxies only the explicit API namespace', async t => {
  const rootDir = await fixture(t);
  const requests = [];
  const fetchImpl = async url => { requests.push(url.href); return new Response('{"status":"ok"}', { headers: { 'Content-Type': 'application/json' } }); };
  const baseUrl = await listen(t, createDevServer({ rootDir, workerUrl: 'http://127.0.0.1:8787', fetchImpl }));
  assert.equal((await fetch(new URL('.env', baseUrl))).status, 404);
  assert.equal((await fetch(new URL('.git/config', baseUrl))).status, 404);
  assert.equal((await fetch(new URL('workers/private.js', baseUrl))).status, 404);
  const response = await fetch(new URL('api/health?check=1', baseUrl));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(requests, ['http://127.0.0.1:8787/api/health?check=1']);
});
