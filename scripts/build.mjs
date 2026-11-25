import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { computeWorkerDigest } from './worker-digest.mjs';

export const ROOT_FILES = ['index.html', 'style.css', 'app.js', 'market-ui.js', 'manifest.json', 'sources.json', 'sw.js'];
export const PUBLIC_DIRECTORIES = new Map([['shared', '.js'], ['data', '.json'], ['vendor', null]]);
const VENDOR_FILES = ['lightweight-charts.standalone.production.js', 'LICENSE.lightweight-charts', 'NOTICE.lightweight-charts'];
const CONTENT_TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
const hash = content => createHash('sha256').update(content).digest('hex');

async function regularFile(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Public assets must be regular files: ${file}`);
}

export async function prepareVendor(rootDir) {
  const packageDir = path.join(rootDir, 'node_modules/lightweight-charts');
  const metadata = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
  const expected = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8')).dependencies['lightweight-charts'];
  if (metadata.version !== expected) throw new Error(`Lightweight Charts version mismatch: expected ${expected}, installed ${metadata.version}`);
  const dest = path.join(rootDir, 'vendor');
  await mkdir(dest, { recursive: true });
  await cp(path.join(packageDir, 'dist/lightweight-charts.standalone.production.js'), path.join(dest, VENDOR_FILES[0]));
  await cp(path.join(packageDir, 'LICENSE'), path.join(dest, VENDOR_FILES[1]));
  // Verbatim upstream NOTICE at v5.3.0 (the npm tarball omits this file).
  const notice = `TradingView Lightweight Charts™\nCopyright (с) 2025 TradingView, Inc. https://www.tradingview.com/\n\nInstalled version: ${metadata.version}\nLicensed under Apache License 2.0; see LICENSE.lightweight-charts.\nhttps://github.com/tradingview/lightweight-charts/blob/v5.3.0/NOTICE\n\nThe chart interface retains a visible TradingView attribution link.\n`;
  await writeFile(path.join(dest, VENDOR_FILES[2]), notice);
}

export async function listPublicFiles(rootDir) {
  const files = [];
  for (const file of ROOT_FILES) {
    await regularFile(path.join(rootDir, file));
    files.push(file);
  }
  for (const [directory, extension] of PUBLIC_DIRECTORIES) {
    let entries;
    try {
      const directoryPath = path.join(rootDir, directory);
      const info = await lstat(directoryPath);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Public asset directories must not be symbolic links: ${directory}`);
      entries = await readdir(directoryPath, { withFileTypes: true });
    }
    catch (error) { if (error.code === 'ENOENT' && directory !== 'vendor') continue; throw error; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const allowed = directory === 'vendor' ? VENDOR_FILES.includes(entry.name) : entry.name.endsWith(extension);
      if (!allowed) continue;
      const relative = `${directory}/${entry.name}`;
      await regularFile(path.join(rootDir, relative));
      files.push(relative);
    }
  }
  for (const file of VENDOR_FILES) {
    if (!files.includes(`vendor/${file}`)) throw new Error(`Missing required vendor asset: ${file}`);
  }
  return files.sort();
}

export async function build({ rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), outDir, gitSha, builtAt, vendor = true } = {}) {
  const destination = path.resolve(outDir || path.join(rootDir, 'dist'));
  if (destination === path.resolve(rootDir) || !destination.startsWith(`${path.resolve(rootDir)}${path.sep}`)) {
    throw new Error('Build output must be a subdirectory of the project root.');
  }
  if (vendor) await prepareVendor(rootDir);
  const files = await listPublicFiles(rootDir);
  const source = new Map(await Promise.all(files.map(async file => [file, await readFile(path.join(rootDir, file))])));
  for (const [file, content] of source) {
    if (file.endsWith('.json')) {
      try { JSON.parse(content.toString()); }
      catch { throw new Error(`Invalid JSON public asset: ${file}`); }
    }
  }
  for (const match of source.get('index.html').toString().matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)=(['"])([^'"]+)\1/gi)) {
    const url = match[2];
    if (/^(?:[a-z]+:|\/\/|#)/i.test(url)) continue;
    const relative = url.replace(/^\.\//, '').split(/[?#]/)[0];
    if (!source.has(relative)) throw new Error(`HTML references an asset that is not in the public build: ${relative}`);
  }
  const sha = gitSha || process.env.BUILD_GIT_SHA || process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{7,40}$/i.test(sha)) throw new Error('A valid Git commit SHA is required.');
  const timestamp = builtAt || (process.env.SOURCE_DATE_EPOCH ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString() : new Date().toISOString());
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error('Invalid build timestamp.');
  const contentVersion = hash(files.map(file => `${file}:${hash(source.get(file))}`).join('\n')).slice(0, 12);
  const version = `${sha.slice(0, 12)}-${contentVersion}`;
  const fingerprints = new Map(files.filter(file => /\.(js|css)$/.test(file) && file !== 'sw.js').map(file => [file, hash(source.get(file)).slice(0, 12)]));
  const index = source.get('index.html').toString().replace(/\b(src|href)=(['"])([^'"#]+)\2/g, (match, attr, quote, url) => {
    const relative = url.replace(/^\.\//, '').split('?')[0];
    return fingerprints.has(relative) ? `${attr}=${quote}${relative}?v=${fingerprints.get(relative)}${quote}` : match;
  });
  source.set('index.html', Buffer.from(index));
  const precache = ['./', './index.html', ...fingerprints.keys()].map(file => file.startsWith('./') ? file : `./${file}?v=${fingerprints.get(file)}`);
  const sw = source.get('sw.js').toString()
    .replace(/const CACHE_VERSION = '[^']*';/, `const CACHE_VERSION = 'oil-dash-${version}';`)
    .replace(/const STATIC_ASSETS = \[[\s\S]*?\];/, `const STATIC_ASSETS = ${JSON.stringify(precache, null, 2)};`);
  source.set('sw.js', Buffer.from(sw));
  const assets = files.map(file => ({ path: file, sha256: hash(source.get(file)), bytes: source.get(file).byteLength, contentType: CONTENT_TYPES[path.extname(file)] || null }));
  let oott = null;
  if (source.has('data/oott.json')) {
    const payload = JSON.parse(source.get('data/oott.json').toString());
    const posts = Array.isArray(payload) ? payload : payload.posts || [];
    const dates = posts.map(post => Date.parse(post.createdAt || post.created_at || '')).filter(Number.isFinite);
    oott = { sha256: hash(source.get('data/oott.json')), count: posts.length, latestPostAt: dates.length ? new Date(Math.max(...dates)).toISOString() : null };
  }
  const workerDigest = await computeWorkerDigest(rootDir);
  const metadata = { schemaVersion: 1, gitSha: sha, workerDigest, version, builtAt: timestamp, assets, data: { oott } };
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const [file, content] of source) {
    await mkdir(path.dirname(path.join(destination, file)), { recursive: true });
    await writeFile(path.join(destination, file), content);
  }
  await writeFile(path.join(destination, 'build-info.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  await writeFile(path.join(destination, '.nojekyll'), '');
  return metadata;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    if (process.argv.includes('--vendor-only')) {
      await prepareVendor(rootDir);
      console.log('Vendored pinned Lightweight Charts with license and attribution notice.');
    } else {
      const result = await build({ rootDir });
      console.log(`Built ${result.assets.length} public assets in dist/ (${result.version}).`);
    }
  } catch (error) { console.error(`Build failed: ${error.message}`); process.exitCode = 1; }
}
