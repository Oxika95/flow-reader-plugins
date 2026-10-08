// Builds index.json from every `<Dir>/plugin.json` + `<Dir>/index.js` at the repo root.
// Usage: node scripts/build-index.mjs [--check]
//   --check  fail if the committed index.json is out of date (CI).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Plugin contract range the app accepts (app: PLUGIN_MIN_API_VERSION..PLUGIN_HOST_API_VERSION).
const HOST_API_VERSION = 3;
const MIN_API_VERSION = 3;
const ID = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const CAPABILITIES = new Set(['search', 'lists', 'auth', 'membership', 'progressSync', 'resolveUrl', 'updates']);
const REQUIRED_FUNCTIONS = {
  search: ['search'],
  lists: ['list'],
  auth: ['login', 'logout', 'session'],
  membership: ['setMembership'],
  progressSync: ['syncProgress'],
  resolveUrl: ['resolveUrl'],
  updates: ['checkUpdates'],
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function validate(dir, manifest, code) {
  const where = `${dir}/plugin.json`;
  const fail = (msg) => {
    throw new Error(`${where}: ${msg}`);
  };
  if (!ID.test(manifest.id || '')) fail(`invalid id "${manifest.id}"`);
  if (manifest.bookIdPrefix && !ID.test(manifest.bookIdPrefix)) fail('invalid bookIdPrefix');
  if (!/^\d+(\.\d+)*$/.test(manifest.version || '')) fail('version must be dotted numbers');
  const api = manifest.apiVersion;
  if (!Number.isInteger(api) || api < MIN_API_VERSION || api > HOST_API_VERSION) {
    fail(`apiVersion must be an integer from ${MIN_API_VERSION} to ${HOST_API_VERSION}`);
  }
  if (!Array.isArray(manifest.allowedHosts) || manifest.allowedHosts.length === 0) fail('allowedHosts is required');
  for (const cap of manifest.capabilities || []) {
    if (!CAPABILITIES.has(cap)) fail(`unknown capability "${cap}"`);
    for (const fn of REQUIRED_FUNCTIONS[cap]) {
      if (!new RegExp(`\\b${fn}\\s*\\(`).test(code)) fail(`capability "${cap}" needs function ${fn}()`);
    }
  }
  for (const fn of ['loadWork', 'loadChapter']) {
    if (!new RegExp(`\\b${fn}\\s*\\(`).test(code)) fail(`missing required function ${fn}()`);
  }
}

function build() {
  const plugins = [];
  const ids = new Set();
  for (const dir of readdirSync(ROOT).sort()) {
    const full = join(ROOT, dir);
    if (dir.startsWith('.') || !statSync(full).isDirectory()) continue;
    const manifestPath = join(full, 'plugin.json');
    const codePath = join(full, 'index.js');
    if (!existsSync(manifestPath) || !existsSync(codePath)) continue;
    const manifestBytes = readFileSync(manifestPath);
    const codeBytes = readFileSync(codePath);
    for (const [name, bytes] of [['plugin.json', manifestBytes], ['index.js', codeBytes]]) {
      // Pages serves the committed (LF) bytes; a CRLF working copy would hash differently.
      if (bytes.includes('\r\n')) throw new Error(`${dir}/${name}: use LF line endings`);
    }
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    validate(dir, manifest, codeBytes.toString('utf8'));
    if (ids.has(manifest.id)) throw new Error(`duplicate plugin id ${manifest.id}`);
    ids.add(manifest.id);
    plugins.push({
      id: manifest.id,
      name: manifest.name || manifest.id,
      description: manifest.description || '',
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      lang: manifest.lang || '',
      iconUrl: manifest.iconUrl || '',
      manifestUrl: `${dir}/plugin.json`,
      pluginUrl: `${dir}/index.js`,
      manifestSha256: sha256(manifestBytes),
      sha256: sha256(codeBytes),
    });
  }
  return JSON.stringify({ name: 'Flow Reader Official', apiVersion: HOST_API_VERSION, plugins }, null, 2) + '\n';
}

const out = build();
const target = join(ROOT, 'index.json');
if (process.argv.includes('--check')) {
  const current = existsSync(target) ? readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : '';
  if (current !== out) {
    console.error('index.json is out of date. Run: npm run build');
    process.exit(1);
  }
  console.log('index.json is up to date');
} else {
  writeFileSync(target, out);
  console.log(`Wrote index.json (${JSON.parse(out).plugins.length} plugin(s))`);
}
