import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { computeWorkerDigest } from '../scripts/worker-digest.mjs';
import { deployWorker } from '../scripts/deploy-worker.mjs';
import { REQUIRED_CAPABILITIES, verifyWorkerHealth } from '../scripts/verify-worker.mjs';
import { verifyDeployment } from '../scripts/verify-deployment.mjs';

async function fixture(t, reverse = false) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'oil-worker-release-test-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await mkdir(path.join(rootDir, 'workers'));
  await mkdir(path.join(rootDir, 'shared'));
  await mkdir(path.join(rootDir, 'data'));
  const files = [
    ['workers/proxy.js', 'export default {};'],
    ['workers/editorial-service.js', 'export const editorial = true;'],
    ['shared/market-core.js', 'globalThis.OilMarket = {};'],
    ['shared/energy-calendar.js', 'globalThis.OilCalendar = {};'],
    ['wrangler.jsonc', '{"name":"oil-proxy"}'],
    ['data/oott.json', '[]'],
    ['app.js', '// frontend'],
  ];
  for (const [file, text] of reverse ? files.reverse() : files) await writeFile(path.join(rootDir, file), text);
  return rootDir;
}

const jsonResponse = payload => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
const workerDigest = 'f'.repeat(64);
const healthy = { schemaVersion: 1, apiVersion: 1, status: 'ok', version: 'old-data-commit-is-allowed', workerDigest, capabilities: REQUIRED_CAPABILITIES };

test('Worker source digest is deterministic and unaffected by frontend or data-only commits', async t => {
  const rootDir = await fixture(t);
  const reverseRoot = await fixture(t, true);
  const before = await computeWorkerDigest(rootDir);
  assert.match(before, /^[a-f0-9]{64}$/);
  assert.equal(await computeWorkerDigest(reverseRoot), before);
  await writeFile(path.join(rootDir, 'data/oott.json'), '[{"text":"new post"}]');
  await writeFile(path.join(rootDir, 'app.js'), '// new frontend');
  assert.equal(await computeWorkerDigest(rootDir), before);
});

test('calendar, market, Worker modules and Wrangler config changes each invalidate the deployed identity', async t => {
  const rootDir = await fixture(t);
  for (const file of ['shared/energy-calendar.js', 'shared/market-core.js', 'workers/proxy.js', 'workers/editorial-service.js', 'wrangler.jsonc']) {
    const original = await readFile(path.join(rootDir, file), 'utf8');
    const before = await computeWorkerDigest(rootDir);
    await writeFile(path.join(rootDir, file), `${original}\n// source changed`);
    assert.notEqual(await computeWorkerDigest(rootDir), before, file);
    await writeFile(path.join(rootDir, file), original);
  }
  const before = await computeWorkerDigest(rootDir);
  await writeFile(path.join(rootDir, 'workers/new-service.js'), 'export const newService = true;');
  assert.notEqual(await computeWorkerDigest(rootDir), before);
});

test('deployment wrapper binds the actual source digest and commit without allowing source or identity overrides', async t => {
  const rootDir = await fixture(t);
  const gitSha = 'a'.repeat(40);
  let invocation;
  const identity = await deployWorker({ rootDir, gitSha, args: ['--dry-run', '--outdir', '.wrangler/test-bundle'], run: (command, args, options) => { invocation = { command, args, options }; return { status: 0 }; } });
  assert.equal(identity.workerDigest, await computeWorkerDigest(rootDir));
  assert.equal(invocation.command, process.execPath);
  assert.equal(invocation.options.cwd, rootDir);
  assert.equal(invocation.args[0], path.join(rootDir, 'node_modules/wrangler/bin/wrangler.js'));
  assert.ok(invocation.args.includes(`BUILD_SHA:${gitSha}`));
  assert.ok(invocation.args.includes(`WORKER_DIGEST:${identity.workerDigest}`));
  await assert.rejects(deployWorker({ rootDir, gitSha, args: ['--var', 'WORKER_DIGEST:spoof'] }), /Unsupported deployment override/);
  await assert.rejects(deployWorker({ rootDir, gitSha, args: ['--config', 'other.jsonc'] }), /Unsupported deployment override/);
  await assert.rejects(deployWorker({ rootDir, gitSha, run: () => ({ status: 1 }) }), /Wrangler deployment failed/);
});

test('Worker preflight requires compatible API, source identity and all required capabilities', async () => {
  assert.equal((await verifyWorkerHealth({ expectedDigest: workerDigest, fetchImpl: async () => jsonResponse(healthy) })).version, 'old-data-commit-is-allowed');
  for (const [payload, reason] of [
    [{ ...healthy, workerDigest: undefined }, /digest mismatch/],
    [{ ...healthy, workerDigest: 'e'.repeat(64) }, /digest mismatch/],
    [{ ...healthy, apiVersion: 2 }, /schema\/API version/],
    [{ ...healthy, schemaVersion: 2 }, /schema\/API version/],
    [{ ...healthy, capabilities: REQUIRED_CAPABILITIES.filter(value => value !== 'calendar') }, /missing required/],
    [{ ...healthy, capabilities: REQUIRED_CAPABILITIES.filter(value => value !== 'editorial') }, /missing required/],
  ]) await assert.rejects(verifyWorkerHealth({ expectedDigest: workerDigest, fetchImpl: async () => jsonResponse(payload) }), reason);
});

test('post-deployment verification rejects a healthy but older Worker and permits matching code across data commits', async () => {
  const html = '<html>site</html>';
  const metadata = { schemaVersion: 1, gitSha: 'b'.repeat(40), workerDigest, assets: [{ path: 'index.html', sha256: createHash('sha256').update(html).digest('hex'), contentType: 'text/html' }] };
  let health = { ...healthy, workerDigest: 'e'.repeat(64) };
  const fetchImpl = async url => url.pathname.endsWith('build-info.json') ? jsonResponse(metadata)
    : url.pathname === '/api/health' ? jsonResponse(health)
      : new Response(html, { headers: { 'Content-Type': 'text/html' } });
  const options = { baseUrl: 'https://site.test/oil/', expectedSha: metadata.gitSha, workerUrl: 'https://worker.test/', fetchImpl };
  await assert.rejects(verifyDeployment(options), /digest mismatch/);
  health = healthy;
  assert.equal((await verifyDeployment(options)).workerDigest, workerDigest);
  delete metadata.workerDigest;
  await assert.rejects(verifyDeployment(options), /missing a valid Worker source digest/);
});
