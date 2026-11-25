import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { computeWorkerDigest, PROJECT_ROOT } from './worker-digest.mjs';

function validateArguments(args) {
  for (let index = 0; index < args.length; index++) {
    if (['--dry-run', '--minify', '--keep-vars'].includes(args[index])) continue;
    if (args[index] === '--outdir' && args[index + 1] && !args[index + 1].startsWith('--')) { index++; continue; }
    if (args[index].startsWith('--outdir=')) continue;
    throw new Error(`Unsupported deployment override: ${args[index]}. Deploy the checked project configuration without overriding its source or identity.`);
  }
}

export async function deployWorker({ rootDir = PROJECT_ROOT, args = [], gitSha, run = spawnSync } = {}) {
  validateArguments(args);
  const sha = gitSha || process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{7,40}$/i.test(sha)) throw new Error('A valid Git commit SHA is required for Worker deployment.');
  const workerDigest = await computeWorkerDigest(rootDir);
  const command = [path.join(rootDir, 'node_modules/wrangler/bin/wrangler.js'), 'deploy', ...args, '--var', `BUILD_SHA:${sha}`, '--var', `WORKER_DIGEST:${workerDigest}`];
  const result = run(process.execPath, command, { cwd: rootDir, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Wrangler deployment failed (${result.signal || result.status}).`);
  return { gitSha: sha, workerDigest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await deployWorker({ args: process.argv.slice(2) }), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
