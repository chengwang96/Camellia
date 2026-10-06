'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const manifest = require('../package.json');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
const readyMarker = 'app.whenReady().then(async () => {';
const readyStart = source.indexOf(readyMarker);
assert.notEqual(readyStart, -1);
const startupEnd = source.indexOf('    nativeTheme.themeSource', readyStart);
assert.notEqual(startupEnd, -1);
const dockStartup = source.slice(readyStart + readyMarker.length, startupEnd);

function runDockStartup(context) {
  return vm.runInNewContext('(async () => {' + dockStartup + '\n})()', {
    networkSettings: () => ({ initialize: async () => {} }),
    log: message => assert.fail('Unexpected startup error: ' + message),
    path,
    APP_ROOT: root,
    ...context,
  });
}

for (const isPackaged of [false, true]) {
  test(`macOS startup sets the Camellia Dock icon (packaged=${isPackaged})`, async () => {
    const icons = [];
    await runDockStartup({
      process: { platform: 'darwin' },
      app: { isPackaged, dock: { setIcon(icon) { icons.push(icon); } } },
    });
    assert.deepEqual(icons, [path.join(root, 'assets/icon-1024.png')]);
  });
}

for (const platform of ['win32', 'linux']) {
  test(`${platform} startup does not access the macOS Dock API`, async () => {
    await runDockStartup({
      process: { platform },
      app: { get dock() { assert.fail('Dock is macOS-only'); } },
    });
  });
}

test('startup tolerates an unavailable Dock API', async () => {
  await runDockStartup({
    process: { platform: 'darwin' }, app: {},
  });
});

test('Dock setup waits for asynchronous network initialization', async () => {
  const icons = [];
  let finishInitialization;
  const initialized = new Promise(resolve => { finishInitialization = resolve; });
  const pending = runDockStartup({
    process: { platform: 'darwin' },
    app: { dock: { setIcon(icon) { icons.push(icon); } } },
    networkSettings: () => ({ initialize: () => initialized }),
  });
  assert.deepEqual(icons, []);
  finishInitialization();
  await pending;
  assert.deepEqual(icons, [path.join(root, 'assets/icon-1024.png')]);
});

test('network initialization failure is logged without preventing Dock setup', async () => {
  const icons = [], logs = [];
  await runDockStartup({
    process: { platform: 'darwin' },
    app: { dock: { setIcon(icon) { icons.push(icon); } } },
    networkSettings: () => ({ initialize: async () => { throw new Error('Network unavailable'); } }),
    log: message => logs.push(message),
  });
  assert.deepEqual(logs, ['Network settings: Network unavailable']);
  assert.deepEqual(icons, [path.join(root, 'assets/icon-1024.png')]);
});

test('the high-resolution Dock icon is packaged and matches the macOS bundle icon', () => {
  const icon = 'assets/icon-1024.png';
  assert.ok(manifest.build.files.includes(icon));
  assert.equal(manifest.build.mac.icon, icon);
  const png = fs.readFileSync(path.join(root, icon));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 1024);
  assert.equal(png.readUInt32BE(20), 1024);
});

test('the Windows tray icon is packaged as a valid ICO resource', () => {
  const icon = 'assets/icon.ico';
  assert.ok(manifest.build.files.includes(icon));
  const ico = fs.readFileSync(path.join(root, icon));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.ok(ico.readUInt16LE(4) > 0);
});
