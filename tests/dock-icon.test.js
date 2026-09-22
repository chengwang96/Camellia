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

for (const isPackaged of [false, true]) {
  test(`macOS startup sets the Camellia Dock icon (packaged=${isPackaged})`, () => {
    const icons = [];
    vm.runInNewContext(dockStartup, {
      process: { platform: 'darwin' },
      app: { isPackaged, dock: { setIcon(icon) { icons.push(icon); } } },
      path,
      APP_ROOT: root,
    });
    assert.deepEqual(icons, [path.join(root, 'assets/icon-1024.png')]);
  });
}

for (const platform of ['win32', 'linux']) {
  test(`${platform} startup does not access the macOS Dock API`, () => {
    vm.runInNewContext(dockStartup, {
      process: { platform },
      app: { get dock() { assert.fail('Dock is macOS-only'); } },
      path,
      APP_ROOT: root,
    });
  });
}

test('startup tolerates an unavailable Dock API', () => {
  vm.runInNewContext(dockStartup, {
    process: { platform: 'darwin' }, app: {}, path, APP_ROOT: root,
  });
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
