import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function computeWorkerDigest(rootDir = PROJECT_ROOT) {
  const directory = path.join(rootDir, 'workers');
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('Worker source directory must be a regular directory.');
  const entries = await readdir(directory);
  const files = [...entries.filter(name => name.endsWith('.js') && !name.startsWith('.')).map(name => `workers/${name}`), 'shared/market-core.js', 'shared/energy-calendar.js', 'wrangler.jsonc'].sort();
  if (!files.includes('workers/proxy.js')) throw new Error('Worker entrypoint is missing.');
  const digest = createHash('sha256');
  digest.update('oil-worker-source-v1\0');
  for (const file of files) {
    const absolute = path.join(rootDir, file);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Worker sources must be regular files: ${file}`);
    const content = await readFile(absolute);
    digest.update(`${file}\0${content.byteLength}\0`);
    digest.update(content);
  }
  return digest.digest('hex');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(await computeWorkerDigest()); }
  catch (error) { console.error(`Worker digest failed: ${error.message}`); process.exitCode = 1; }
}
