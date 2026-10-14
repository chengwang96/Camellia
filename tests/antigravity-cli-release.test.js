'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { removeTree } = require('./test-fs.cjs');
const { manifestUrl, validateRelease, latestAntigravityCli, upgradeAntigravityCli } = require('../src/main/antigravity-cli-release');

const bytes = Buffer.from('verified native CLI fixture');
const release = { version: '1.3.5', url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.3.5-123/windows-x64/cli_windows_x64.exe',
  sha512: createHash('sha512').update(bytes).digest('hex') };
function fixture(t, platform = 'win32') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-cli-update-'));
  t.after(() => removeTree(dir));
  const cli = path.join(dir, 'cli'); fs.mkdirSync(cli);
  const file = path.join(cli, platform === 'win32' ? 'agy.exe' : 'agy');
  fs.writeFileSync(file, 'previous CLI');
  const marker = path.join(cli, 'installed.json'); fs.writeFileSync(marker, '{"version":"1.2.14"}\n');
  const connection = { env: { HTTPS_PROXY: 'http://127.0.0.1:7890' }, fetch: async url => {
    assert.equal(url, release.url); return new Response(bytes);
  } };
  return { dir, cli, file, marker, connection, platform, release, run: async () => assert.fail('No archive extraction on Windows'),
    probe: async (candidate, env) => { assert.deepEqual(fs.readFileSync(candidate), bytes); assert.equal(env, connection.env); return release.version; } };
}

test('CLI manifests use the official installer platform names and validate Google artifact integrity metadata', () => {
  assert.match(manifestUrl('win32', 'x64'), /\/windows_amd64\.json$/);
  assert.match(manifestUrl('darwin', 'arm64'), /\/darwin_arm64\.json$/);
  assert.match(manifestUrl('linux', 'arm64'), /\/linux_arm64\.json$/);
  assert.throws(() => manifestUrl('other', 'x64'), /unavailable/);
  assert.deepEqual(validateRelease(release), release);
  for (const url of ['http://storage.googleapis.com/antigravity-public/antigravity-cli/x.exe',
    'https://storage.googleapis.com.evil.invalid/antigravity-public/antigravity-cli/x.exe',
    'https://user:password@storage.googleapis.com/antigravity-public/antigravity-cli/x.exe',
    'https://storage.googleapis.com/other-bucket/x.exe']) assert.throws(() => validateRelease({ ...release, url }), /official/);
  assert.throws(() => validateRelease({ ...release, sha512: 'bad' }), /checksum/);
  assert.throws(() => validateRelease({ ...release, version: 'latest' }), /version/);
});

test('CLI checks retry transient GET failures and never turn a failed manifest into up-to-date', async () => {
  let requests = 0;
  const connection = { fetch: async () => {
    requests++;
    if (requests === 1) return new Response('temporarily unavailable', { status: 503 });
    return Response.json(release);
  } };
  assert.deepEqual(await latestAntigravityCli(connection), release);
  assert.equal(requests, 2);
  requests = 0;
  await assert.rejects(() => latestAntigravityCli({ fetch: async () => { requests++; return new Response('', { status: 404 }); } }), /HTTP 404/);
  assert.equal(requests, 1);
  await assert.rejects(() => latestAntigravityCli({ fetch: async () => Response.json({ ...release, sha512: 'bad' }) }), /checksum/);
});

test('native CLI upgrades verify before replacement, retain rollback binary and update the actual CLI marker', async t => {
  const f = fixture(t);
  const result = await upgradeAntigravityCli(f);
  assert.equal(result.version, '1.3.5');
  assert.deepEqual(fs.readFileSync(f.file), bytes);
  assert.equal(fs.readFileSync(result.backup, 'utf8'), 'previous CLI');
  assert.equal(JSON.parse(fs.readFileSync(f.marker)).version, '1.3.5');
  assert.equal(fs.readdirSync(f.cli).some(name => name.startsWith('.update-')), false);
});

test('corrupt downloads and protocol/version mismatches keep the installed CLI and marker unchanged', async t => {
  const f = fixture(t);
  await assert.rejects(() => upgradeAntigravityCli({ ...f, release: { ...release, sha512: '0'.repeat(128) } }), /checksum mismatch/);
  await assert.rejects(() => upgradeAntigravityCli({ ...f, probe: async () => '1.2.14' }), /version mismatch/);
  await assert.rejects(() => upgradeAntigravityCli({ ...f, probe: async () => { throw new Error('CLI transport unavailable'); } }), /transport unavailable/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'previous CLI');
  assert.equal(fs.readFileSync(f.marker, 'utf8'), '{"version":"1.2.14"}\n');
  assert.deepEqual(fs.readdirSync(f.cli).sort(), ['agy.exe', 'installed.json']);
});

test('a failed executable promotion restores the previous CLI and cleans its staging directory', async t => {
  const f = fixture(t), rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.dirname(from).startsWith(path.join(f.cli, '.update-')) && to === f.file)
      throw Object.assign(new Error('locked executable'), { code: 'EBUSY' });
    return rename(from, to);
  });
  await assert.rejects(() => upgradeAntigravityCli(f), /Close external Antigravity CLI windows/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'previous CLI');
  assert.equal(fs.readFileSync(f.marker, 'utf8'), '{"version":"1.2.14"}\n');
  assert.deepEqual(fs.readdirSync(f.cli).sort(), ['agy.exe', 'installed.json']);
});

test('Unix upgrades extract only the official executable into private staging before promotion', async t => {
  const f = fixture(t, 'linux');
  const unixRelease = { ...release, url: release.url.replace('windows-x64/cli_windows_x64.exe', 'linux-x64/cli_linux_x64.tar.gz') };
  f.connection.fetch = async url => { assert.equal(url, unixRelease.url); return new Response(bytes); };
  const result = await upgradeAntigravityCli({ ...f, release: unixRelease, run: async (exe, args) => {
    assert.equal(exe, 'tar'); assert.equal(args.at(-1), 'antigravity');
    const staging = args[args.indexOf('-C') + 1]; assert.equal(path.dirname(staging), f.cli);
    fs.writeFileSync(path.join(staging, 'antigravity'), bytes);
  } });
  assert.equal(result.version, '1.3.5');
  assert.deepEqual(fs.readFileSync(f.file), bytes);
});
