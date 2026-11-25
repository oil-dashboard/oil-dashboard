import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { computeWorkerDigest } from './worker-digest.mjs';

export const REQUIRED_CAPABILITIES = ['atomic-quotes', 'same-symbol-history', 'verified-expiration-curve', 'editorial', 'calendar'];

export async function verifyWorkerHealth({ workerUrl = 'https://oil-proxy.xzregproxy.workers.dev', expectedDigest, fetchImpl = fetch } = {}) {
  if (!/^[a-f0-9]{64}$/.test(expectedDigest || '')) throw new Error('A valid expected Worker source digest is required.');
  const url = new URL('/api/health', workerUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Worker URL must use HTTP(S).');
  const response = await fetchImpl(url, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Worker health: HTTP ${response.status}`);
  if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('Worker health is not JSON.');
  const health = await response.json();
  if (health.schemaVersion !== 1 || health.apiVersion !== 1 || health.status !== 'ok') throw new Error('Worker health schema/API version is incompatible.');
  if (health.workerDigest !== expectedDigest) throw new Error(`Worker source digest mismatch: expected ${expectedDigest}, received ${health.workerDigest || 'missing'}`);
  if (!Array.isArray(health.capabilities) || REQUIRED_CAPABILITIES.some(capability => !health.capabilities.includes(capability))) throw new Error('Worker is missing required dashboard capabilities.');
  return health;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const attempts = Math.min(18, Math.max(1, Number(option('--attempts', '1')) || 1));
  try {
    const expectedDigest = option('--expected-digest', await computeWorkerDigest());
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const health = await verifyWorkerHealth({ workerUrl: option('--worker-url', 'https://oil-proxy.xzregproxy.workers.dev'), expectedDigest });
        console.log(JSON.stringify({ verified: true, workerDigest: health.workerDigest, apiVersion: health.apiVersion, capabilities: health.capabilities }, null, 2));
        break;
      } catch (error) {
        if (attempt === attempts) throw error;
        console.log(`Worker deployment not ready (${attempt}/${attempts}): ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }
  } catch (error) { console.error(`Worker preflight failed: ${error.message}`); process.exitCode = 1; }
}
