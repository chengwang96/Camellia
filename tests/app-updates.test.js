'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { removeTree } = require('./test-fs.cjs');
const { createAppUpdates, selectAsset, sha256File } = require('../src/main/app-updates');

function scratch(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-app-update-'));
  context.after(() => removeTree(root));
  return root;
}

function release(overrides = {}) {
  return { tag_name: 'v1.4.0', name: 'Camellia 1.4.0', body: 'Fixed things.', html_url: 'https://example.test/release', published_at: '2026-09-01T00:00:00Z',
    assets: [{ name: 'Camellia-Setup-1.4.0-win-x64.exe', size: 104857600, digest: `sha256:${'a'.repeat(64)}`, browser_download_url: 'https://example.test/setup.exe' }], ...overrides };
}

function connectionFor(payload) {
  return { fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => payload,
    arrayBuffer: async () => Buffer.from('package') }), close: () => {} };
}

// install() first reads the release feed and then downloads the artifact, so
// these fakes answer both requests from one connection.
function installConnection(payload, bytes, size = 7) {
  return { fetch: async () => ({ ok: true, status: 200, headers: { get: () => String(size) },
    json: async () => payload, arrayBuffer: async () => bytes }), close: () => {} };
}

test('platform artifacts are matched only when they can replace this installation', () => {
  const assets = [
    { name: 'Camellia-Setup-1.4.0-win-x64.exe', browser_download_url: 'https://example.test/win.exe' },
    { name: 'Camellia-1.4.0-macOS-arm64.zip', browser_download_url: 'https://example.test/mac.zip' },
    { name: 'Camellia-1.4.0-macOS-arm64.dmg', browser_download_url: 'https://example.test/mac.dmg' },
  ];
  assert.equal(selectAsset(assets, 'win32', 'x64').kind, 'installer');
  assert.equal(selectAsset(assets, 'win32', 'x64').asset.name, 'Camellia-Setup-1.4.0-win-x64.exe');
  assert.equal(selectAsset(assets, 'darwin', 'arm64').kind, 'archive');
  assert.equal(selectAsset(assets, 'linux', 'x64'), null);
  assert.equal(selectAsset([], 'win32', 'x64'), null);
});

test('artifact names cannot escape the temporary directory', () => {
  const selected = selectAsset([{ name: '../../evil.exe', browser_download_url: 'https://example.test/e.exe' }], 'win32', 'x64');
  assert.equal(selected.asset.name, 'evil.exe');
});

test('a downloaded disk image is kept for the user to open', async context => {
  const root = scratch(context);
  const payload = release({ assets: [{ name: 'Camellia-1.4.0-macOS-arm64.dmg', size: 10, digest: null, browser_download_url: 'https://example.test/mac.dmg' }] });
  const revealed = [];
  const updates = createAppUpdates({ currentVersion: '1.0.0', platform: 'darwin', arch: 'arm64', platformSupported: true, appPath: path.join(root, 'Camellia.app'),
    connection: () => installConnection(payload, Buffer.from('dmg')), reveal: file => revealed.push(file) });
  const result = await updates.install();
  assert.equal(result.kind, 'disk-image');
  assert.equal(result.restarting, false);
  assert.equal(revealed[0], result.file);
  assert.ok(fs.existsSync(result.file), 'a downloaded installer must remain on disk');
  try { fs.unlinkSync(result.file); } catch {}
});

test('install reuses an already-fetched release instead of checking the feed twice', async context => {
  const root = scratch(context);
  const payload = release();
  const file = path.join(root, 'package.bin');
  fs.writeFileSync(file, 'package');
  payload.assets[0].digest = `sha256:${sha256File(file)}`;
  let checks = 0, quit = 0;
  const updates = createAppUpdates({ currentVersion: '1.0.0', platform: 'win32', platformSupported: true, appPath: root,
    connection: () => { checks++; return installConnection(payload, fs.readFileSync(file)); },
    launch: () => {}, quit: () => { quit++; } });
  const known = await updates.check();
  await updates.install(() => {}, known);
  assert.equal(checks, 2, 'one check plus one download');
  assert.equal(quit, 1);
});

test('check reports the newer version, package and notes without touching the disk', async context => {
  const root = scratch(context);
  const updates = createAppUpdates({ currentVersion: '1.3.0', platform: 'win32', arch: 'x64', platformSupported: true,
    connection: () => connectionFor(release()), appPath: path.join(root, 'app') });
  const state = await updates.check();
  assert.equal(state.latest, '1.4.0');
  assert.equal(state.updateAvailable, true);
  assert.equal(state.supported, true);
  assert.equal(state.kind, 'installer');
  assert.equal(state.name, 'Camellia-Setup-1.4.0-win-x64.exe');
  assert.equal(state.sha256, 'a'.repeat(64));
  assert.equal(state.notes, 'Fixed things.');
});

test('the same version and an older release are not offered as updates', async () => {
  const current = createAppUpdates({ currentVersion: '1.4.0', platform: 'win32', platformSupported: true, connection: () => connectionFor(release()) });
  assert.equal((await current.check()).updateAvailable, false);
  const older = createAppUpdates({ currentVersion: '2.0.0', platform: 'win32', platformSupported: true, connection: () => connectionFor(release()) });
  assert.equal((await older.check()).updateAvailable, false);
});

test('a repository without releases reports a clear error instead of a crash', async () => {
  const updates = createAppUpdates({ currentVersion: '1.0.0', platformSupported: true,
    connection: () => ({ fetch: async () => ({ ok: false, status: 404 }), close: () => {} }) });
  await assert.rejects(updates.check(), /no published releases/);
});

test('platforms without an in-place package report an update but refuse to install it', async () => {
  const updates = createAppUpdates({ currentVersion: '1.0.0', platform: 'linux', arch: 'x64', platformSupported: false,
    connection: () => connectionFor(release({ assets: [{ name: 'Camellia-1.4.0.AppImage', browser_download_url: 'https://example.test/app.AppImage' }] })) });
  assert.equal((await updates.check()).supported, false);
  await assert.rejects(updates.install(), /no package for this platform/);
});

test('a mismatched checksum stops the update before anything is applied', async context => {
  const root = scratch(context);
  const payload = release();
  payload.assets[0].digest = `sha256:${'b'.repeat(64)}`;
  let quit = 0;
  const leftovers = () => fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('camellia-update-')).length;
  const before = leftovers();
  const updates = createAppUpdates({ currentVersion: '1.0.0', platform: 'win32', platformSupported: true, appPath: root,
    connection: () => installConnection(payload, Buffer.from('package')), quit: () => { quit++; } });
  await assert.rejects(updates.install(), /failed its checksum/);
  assert.equal(quit, 0);
  assert.equal(leftovers(), before, 'a rejected download must not leave its temporary file behind');
});

test('a verified installer is launched and the app exits without a competing relaunch', async context => {
  const root = scratch(context);
  const payload = release();
  const file = path.join(root, 'package.bin');
  fs.writeFileSync(file, 'package');
  payload.assets[0].digest = `sha256:${sha256File(file)}`;
  let quit = 0, relaunch = 0;
  const launched = [];
  const updates = createAppUpdates({ currentVersion: '1.0.0', platform: 'win32', platformSupported: true, appPath: root,
    connection: () => installConnection(payload, fs.readFileSync(file)),
    launch: (exe, args) => launched.push([exe, ...args]),
    quit: () => { quit++; }, relaunch: () => { relaunch++; } });
  const result = await updates.install();
  assert.equal(result.restarting, true);
  assert.equal(result.kind, 'installer');
  assert.equal(launched.length, 1);
  assert.ok(launched[0][0].endsWith('.exe'), launched[0][0]);
  assert.equal(quit, 1);
  assert.equal(relaunch, 0);
  // The installer owns its file now, so it must still be on disk to run.
  assert.ok(fs.existsSync(launched[0][0]), 'a launched installer must not be deleted before it runs');
});

test('macOS archives replace the bundle in place, then relaunch', async context => {
  const root = scratch(context);
  const payload = release({ assets: [{ name: 'Camellia-1.4.0-macOS-arm64.zip', size: 10, digest: null, browser_download_url: 'https://example.test/mac.zip' }] });
  const commands = [];
  let relaunch = 0;
  const updates = createAppUpdates({ currentVersion: '1.0.0', platform: 'darwin', arch: 'arm64', platformSupported: true, appPath: path.join(root, 'Camellia.app'),
    connection: () => installConnection(payload, Buffer.from('zip')),
    runCommand: async (exe, args) => {
      commands.push([exe, ...args]);
      if (args[0] === '-x') {
        fs.mkdirSync(path.join(args[3], 'Camellia.app'), { recursive: true });
        fs.writeFileSync(path.join(args[3], 'Camellia.app', 'Camellia'), 'binary');
      }
    },
    relaunch: () => { relaunch++; } });
  const result = await updates.install();
  assert.equal(result.kind, 'archive');
  assert.equal(relaunch, 1);
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0].slice(0, 3), ['ditto', '-x', '-k']);
  assert.ok(commands[1][1].endsWith('Camellia.app'));
  assert.equal(commands[1][2], path.join(root, 'Camellia.app'));
});

test('an archive without a bundle is rejected instead of touching the installation', async context => {
  const root = scratch(context);
  const payload = release({ assets: [{ name: 'Camellia-1.4.0-macOS-arm64.zip', size: 10, digest: null, browser_download_url: 'https://example.test/mac.zip' }] });
  let relaunch = 0;
  const updates = createAppUpdates({ currentVersion: '1.0.0', platform: 'darwin', arch: 'arm64', platformSupported: true, appPath: path.join(root, 'Camellia.app'),
    connection: () => installConnection(payload, Buffer.from('zip')),
    runCommand: async () => {}, relaunch: () => { relaunch++; } });
  await assert.rejects(updates.install(), /does not contain Camellia\.app/);
  assert.equal(relaunch, 0);
});

test('an unreachable update server surfaces the failure and stays reusable', async () => {
  let attempts = 0;
  const updates = createAppUpdates({ currentVersion: '1.0.0', platform: 'win32', platformSupported: true,
    connection: () => ({ fetch: async () => { attempts++; throw new Error('offline'); }, close: () => {} }) });
  await assert.rejects(updates.check(), /offline/);
  await assert.rejects(updates.check(), /offline/);
  assert.equal(attempts, 2);
});

test('sha256File hashes files larger than one chunk without loading them whole', async context => {
  const root = scratch(context);
  const file = path.join(root, 'large.bin');
  const data = Buffer.alloc((1 << 20) * 3 + 17, 7);
  fs.writeFileSync(file, data);
  assert.equal(sha256File(file), createHash('sha256').update(data).digest('hex'));
});

// The confirmation lives in the main process, next to the engine-busy check that
// decides which warning the dialog shows.
test('the install action confirms in a native dialog and cancels cleanly', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const section = main.slice(main.indexOf("'app-update-install'"), main.indexOf("'runtime-update'"));
  assert.match(section, /showMessageBox/, 'installing must confirm before replacing the installation');
  assert.match(section, /text\('Install and restart'\)|Install and restart/, 'the destructive action must be an explicit button');
  assert.match(section, /cancelId: 0/, 'the dialog must have an explicit cancel option');
  assert.match(section, /canceled: true/, 'cancelling must report a canceled result rather than throwing');
  assert.match(section, /engineBusy/, 'the warning must account for running responses');
  assert.match(section, /install\(send, available\)/, 'the confirmed release must be reused instead of fetched twice');
});

test('the main process and preload expose the application update channels', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '../src/main/preload.js'), 'utf8');
  assert.match(main, /'app-update-check'/);
  assert.match(main, /'app-update-install'/);
  assert.match(main, /'dsh:app-update-state'/);
  assert.match(preload, /appUpdateCheck:/);
  assert.match(preload, /appUpdateInstall:/);
  assert.match(preload, /onAppUpdateState:/);
});

test('the General page renders update controls that stay inactive until a check succeeds', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/settings/api-settings.html'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/settings/api-settings.js'), 'utf8');
  for (const id of ['checkAppUpdate', 'installAppUpdate', 'appUpdateStatus', 'appUpdateProgress', 'appUpdateDetails', 'appUpdateNotes']) {
    assert.match(html, new RegExp(`id="${id}"`), `missing control: ${id}`);
  }
  assert.match(html, /id="installAppUpdate" class="primary" hidden/, 'installing must start hidden until an update is found');
  assert.match(source, /api\.onAppUpdateState/, 'progress must follow main-process broadcasts');
  assert.match(source, /appUpdate\.supported/, 'unsupported platforms must not offer to install');
});
