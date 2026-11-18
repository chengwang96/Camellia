'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { assetStem, createTailnetUpdates } = require('../src/main/remote/tailnet-updates');
const { removeTree } = require('./test-fs.cjs');

const check = 'tailnet-update-check', install = 'tailnet-update-install', status = 'tailnet-update-status';
const releaseURL = 'https://github.com/chengwang96/Camellia/releases/download/v1.1.0/';
const binary = Buffer.from('example Camellia helper');
const notices = Buffer.from('example Tailnet notices');

function asset(stem, ext, bytes) {
  const name = stem + '.' + ext;
  return { name, browser_download_url: releaseURL + name, size: bytes.length,
    digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') };
}

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-tailnet-updates-'));
  context.after(() => removeTree(root));
  const options = { dataDir: path.join(root, 'profile'), bundle: path.join(root, 'bundle'), platform: 'win32', arch: 'x64' };
  fs.mkdirSync(options.bundle);
  const manifest = path.join(options.bundle, 'tailnet-version.json');
  const bundled = tailscale => fs.writeFileSync(manifest, JSON.stringify({ platform: options.platform, arch: options.arch, tailscale }));
  bundled('v1.98.6');
  const stem = assetStem('win32', 'x64', 'v1.104.7');
  const expected = [asset(stem, 'bin', binary), asset(stem, 'txt', notices)];
  const release = { tag_name: 'v1.1.0', assets: [...expected] };
  const calls = [];
  let payload = binary;
  options.connection = () => ({
    async fetch(url) {
      calls.push(url);
      if (url === 'https://api.github.com/repos/chengwang96/Camellia/releases/latest') return Response.json(release);
      if (url === expected[0].browser_download_url) return new Response(payload);
      if (url === expected[1].browser_download_url) return new Response(notices);
      throw new Error('Unexpected download URL');
    },
    close() {},
  });
  return { options, release, expected, calls, bundled, setPayload: value => { payload = value; } };
}

test('keeps the bundled helper until activation succeeds and prefers a newer bundled build', async context => {
  const { options, bundled, calls, expected, release } = fixture(context);
  release.assets.unshift(asset(assetStem('darwin', 'arm64', 'v1.999.0'), 'bin', binary));
  const updates = createTailnetUpdates(options);
  assert.equal((await updates.operate(status)).current, 'v1.98.6');
  assert.equal((await updates.operate(check)).available, 'v1.104.7');
  assert.equal((await updates.operate(install)).pending, 'v1.104.7');
  assert.equal((await updates.operate(status)).current, 'v1.98.6');
  assert.equal(updates.executable, null);
  assert.deepEqual(calls.slice(1), expected.map(entry => entry.browser_download_url));
  const beforeActivation = createTailnetUpdates(options);
  assert.equal(beforeActivation.executable, null);
  assert.equal((await beforeActivation.operate(status)).pending, 'v1.104.7');
  const installed = updates.pendingInstallation();
  assert.equal(installed.version, 'v1.104.7');
  assert.deepEqual(fs.readFileSync(installed.executable), binary);
  assert.equal((await updates.operate(status)).current, 'v1.98.6');
  assert.deepEqual(updates.activate(), { supported: true, current: 'v1.104.7', pending: null, busy: false, available: null });
  assert.equal(updates.executable, installed.executable);
  const restarted = createTailnetUpdates(options);
  assert.equal((await restarted.operate(status)).current, 'v1.104.7');
  assert.deepEqual(fs.readFileSync(restarted.executable), binary);
  assert.deepEqual(fs.readFileSync(path.join(path.dirname(restarted.executable), 'TAILNET-NOTICES.txt')), notices);
  assert.equal((await restarted.operate(check)).available, null);
  bundled('v1.105.0');
  const newerBundle = createTailnetUpdates(options);
  assert.equal(newerBundle.executable, null);
  assert.equal((await newerBundle.operate(check)).available, null);
});

test('requires official assets with digests and leaves the installed helper untouched after verification fails', async context => {
  const { options, release, expected, setPayload } = fixture(context);
  const updates = createTailnetUpdates(options);
  release.assets[1] = { ...release.assets[1], browser_download_url: 'https://untrusted.example/notice.txt' };
  assert.equal((await updates.operate(check)).unpublished, true);
  assert.equal((await updates.operate(status)).available, null);
  await assert.rejects(updates.operate(install), /Check for/);
  release.assets[1] = { ...expected[1], digest: null };
  assert.equal((await updates.operate(check)).unpublished, true);
  release.assets = expected;
  await updates.operate(check);
  setPayload(Buffer.alloc(binary.length));
  await assert.rejects(updates.operate(install), /verification/);
  assert.equal((await updates.operate(status)).pending, null);
  assert.equal(createTailnetUpdates(options).executable, null);
  setPayload(binary);
  await updates.operate(install);
  updates.activate();
  const installed = createTailnetUpdates(options).executable;
  fs.writeFileSync(installed, 'damaged');
  const fallback = createTailnetUpdates(options);
  assert.equal(fallback.executable, null);
  await fallback.operate(check);
  await fallback.operate(install);
  fallback.activate();
  assert.deepEqual(fs.readFileSync(createTailnetUpdates(options).executable), binary);
});
