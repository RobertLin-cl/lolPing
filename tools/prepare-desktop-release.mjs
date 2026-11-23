import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';

const require = createRequire(import.meta.url);
const { GitHubProvider } = require('electron-updater/out/providers/GitHubProvider');
const { NsisUpdater } = require('electron-updater/out/NsisUpdater');
const { parseUpdateInfo } = require('electron-updater/out/providers/Provider');
const root = resolve(import.meta.dirname, '..');
const directory = resolve(process.argv[2] ?? join(root, 'out/desktop-pilot/legacy-electron-0.6.7'));
const tag = process.argv[3] ?? 'desktop-v1.0.0';
assert.match(tag, /^desktop-(?:pilot-)?v\d+\.\d+\.\d+$/);
if (tag !== 'desktop-v1.0.0') assert.match(tag, /^desktop-pilot-v/, 'Use the tag prefix recognized by installed Rust updaters');
const source = JSON.parse(await readFile(join(directory, 'release.json'), 'utf8'));
const original = await readFile(join(directory, 'latest.yml'));
const metadata = source.assets.filter((asset) => asset.name === 'latest.yml');
assert.equal(source.tagName, 'v0.6.7');
assert.equal(metadata.length, 1);
assert.equal(original.length, metadata[0].size);
assert.equal(`sha256:${createHash('sha256').update(original).digest('hex')}`, metadata[0].digest);
const name = 'lolPing-Setup-0.6.7.exe';
const asset = source.assets.filter((item) => item.name === name);
assert.equal(asset.length, 1);
assert.equal(asset[0].url, `https://github.com/RobertLin-cl/lolPing/releases/download/v0.6.7/${name}`);
const originalInfo = parseUpdateInfo(original.toString('utf8'), 'latest.yml', 'fixture');
assert.equal(originalInfo.path, name);
assert.equal(originalInfo.files.length, 1);
assert.equal(originalInfo.files[0].url, name);
assert.equal(originalInfo.files[0].size, asset[0].size);
assert.equal(originalInfo.sha512, originalInfo.files[0].sha512);
assert.equal(Buffer.from(originalInfo.sha512, 'base64').length, 64);

// GitHubProvider resolves this relative path to the original release, including its blockmap.
const pinned = `../v0.6.7/${name}`;
const yaml = original.toString('utf8').replaceAll(name, pinned);
const info = parseUpdateInfo(yaml, 'latest.yml', 'fixture');
assert.equal(info.version, '0.6.7');
assert.equal(info.path, pinned);
assert.equal(info.files[0].url, pinned);
assert.equal(info.files[0].size, originalInfo.files[0].size);
assert.equal(info.files[0].sha512, originalInfo.files[0].sha512);
assert.equal(info.sha512, originalInfo.sha512);

async function check(current, autoDownload) {
  const userDataPath = join(root, 'out/desktop-pilot/release-check', current);
  await mkdir(userDataPath, { recursive: true });
  const updater = new NsisUpdater(null, { version: current, isPackaged: true, userDataPath, whenReady: async () => {} });
  updater.logger = null;
  updater.autoDownload = autoDownload;
  updater.autoInstallOnAppQuit = false;
  let downloads = 0;
  updater.downloadUpdate = async () => { downloads++; throw new Error('A check must not download an installer'); };
  const requests = [];
  const provider = new GitHubProvider({ provider: 'github', owner: 'RobertLin-cl', repo: 'lolPing' }, updater, {
    platform: 'win32',
    executor: { request: async (options) => {
      requests.push(options.path);
      if (options.path === '/RobertLin-cl/lolPing/releases.atom') {
        return `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Rust release</title><link href="https://github.com/RobertLin-cl/lolPing/releases/tag/${tag}"/><content>Rust release</content></entry></feed>`;
      }
      if (options.path === '/RobertLin-cl/lolPing/releases/latest') return JSON.stringify({ tag_name: tag });
      if (options.path === `/RobertLin-cl/lolPing/releases/download/${tag}/latest.yml`) return yaml;
      throw new Error(`Unexpected request: ${options.path}`);
    } },
  });
  updater.clientPromise = Promise.resolve(provider);
  const result = await updater.checkForUpdates();
  assert.equal(downloads, 0);
  assert.equal(result.updateInfo.version, '0.6.7');
  assert.equal(result.downloadPromise ?? null, null);
  assert.equal(requests.length, 3);
  const files = provider.resolveFiles(result.updateInfo);
  assert.equal(files.length, 1);
  assert.equal(files[0].url.href, asset[0].url);
  assert.equal(provider.getBlockMapFiles(files[0].url, current, '0.6.7')[1].href, `${asset[0].url}.blockmap`);
  return result.isUpdateAvailable;
}

assert.equal(await check('0.6.7', true), false);
assert.equal(await check('0.6.7', false), false);
assert.equal(await check('0.6.6', false), true);
const output = join(directory, 'compat');
await mkdir(output, { recursive: true });
await writeFile(join(output, 'latest.yml'), yaml);
console.log('Verified: Electron 0.6.7 finds no update or download; 0.6.6 resolves the original Electron 0.6.7 installer.');
console.log(`Compatibility metadata: ${join(output, 'latest.yml')}`);
