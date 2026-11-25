import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyWorkerHealth } from './verify-worker.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function baseAddress(value) {
  const url = new URL(value.endsWith('/') ? value : `${value}/`);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Expected an HTTP(S) deployment URL.');
  return url;
}

async function get(url, fetchImpl, type) {
  const response = await fetchImpl(url, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${url.pathname}: HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  if (type && !contentType.toLowerCase().includes(type.toLowerCase())) throw new Error(`${url.pathname}: expected ${type}, received ${contentType || 'no content-type'}`);
  return response;
}

export async function verifyDeployment({ baseUrl, expectedSha, workerUrl = 'https://oil-proxy.xzregproxy.workers.dev', checkHealth = true, fetchImpl = fetch } = {}) {
  const base = baseAddress(baseUrl);
  const metadata = await (await get(new URL(`build-info.json?verify=${Date.now()}`, base), fetchImpl, 'application/json')).json();
  if (metadata.schemaVersion !== 1 || typeof metadata.gitSha !== 'string' || !Array.isArray(metadata.assets)) throw new Error('Invalid build-info schema.');
  if (!/^[a-f0-9]{64}$/.test(metadata.workerDigest || '')) throw new Error('Build-info is missing a valid Worker source digest.');
  if (expectedSha && metadata.gitSha !== expectedSha) throw new Error(`Wrong deployed commit: expected ${expectedSha}, received ${metadata.gitSha}`);
  if (!metadata.assets.length || !metadata.assets.some(asset => asset.path === 'index.html')) throw new Error('Build-info does not describe a complete static site.');
  for (const asset of metadata.assets) {
    if (typeof asset.path !== 'string' || !/^[\w./-]+$/.test(asset.path) || asset.path.startsWith('/') || asset.path.split('/').includes('..')) throw new Error('Unsafe public asset path in build-info.');
    if (!/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error(`Invalid SHA256 for ${asset.path}`);
    const url = new URL(asset.path, base);
    url.searchParams.set('verify', metadata.version);
    const response = await get(url, fetchImpl, asset.contentType);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== asset.sha256) throw new Error(`${asset.path}: content hash does not match the deployed build`);
  }
  let health = null;
  if (checkHealth) {
    health = await verifyWorkerHealth({ workerUrl, expectedDigest: metadata.workerDigest, fetchImpl });
  }
  return { gitSha: metadata.gitSha, workerDigest: metadata.workerDigest, version: metadata.version, assets: metadata.assets.length, worker: health?.version || null };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const baseUrl = option('--base-url', 'https://oil-dashboard.github.io/oil-dashboard/');
  const expectedSha = option('--expected-sha', process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  const attempts = Math.min(8, Math.max(1, Number(option('--attempts', '1')) || 1));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await verifyDeployment({ baseUrl, expectedSha, workerUrl: option('--worker-url', 'https://oil-proxy.xzregproxy.workers.dev'), checkHealth: !args.includes('--skip-worker') });
      console.log(JSON.stringify({ verified: true, ...result }, null, 2));
      break;
    } catch (error) {
      if (attempt === attempts) { console.error(`Deployment verification failed: ${error.message}`); process.exitCode = 1; }
      else { console.log(`Deployment not ready (${attempt}/${attempts}): ${error.message}`); await sleep(10000); }
    }
  }
}
