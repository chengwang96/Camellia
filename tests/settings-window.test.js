'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { settingsWindowSize, createSettingsWindowSizeCache } = require('../src/main/settings-window-size');

const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8').replace(/\r\n/g, '\n');
const openSettings = /function openSettingsWindow\(target = \{\}\) \{([\s\S]*?)\n\}\n\nfunction createMainWindow/.exec(main)[1];

test('the settings window is created hidden and centered so it never flashes at the default position', () => {
  assert.match(openSettings, /new BrowserWindow\(\{/);
  assert.match(openSettings, /const \{ width, height \} = settingsWindowSizes\.size;/);
  assert.doesNotMatch(openSettings, /settingsWindowSize\(|getPrimaryDisplay\(/);
  assert.match(openSettings, /\n    width,\n    height,\n/);
  assert.match(openSettings, /\n    show: false,\n/);
  assert.match(openSettings, /\n    center: true,\n/);
  assert.match(openSettings, /settingsWindow\.once\('ready-to-show', \(\) => \{[\s\S]*?settingsWindow\.center\(\);[\s\S]*?settingsWindow\.show\(\);/);
});

test('the settings window follows the display work area within readable bounds', () => {
  assert.deepEqual(settingsWindowSize({ width: 2560, height: 1400 }), { width: 1160, height: 960 });
  assert.deepEqual(settingsWindowSize({ width: 1920, height: 1080 }), { width: 1160, height: 960 });
  assert.deepEqual(settingsWindowSize({ width: 1366, height: 768 }), { width: 1160, height: 720 });
  assert.deepEqual(settingsWindowSize({ width: 1024, height: 768 }), { width: 976, height: 720 });
  assert.deepEqual(settingsWindowSize({ width: 600, height: 480 }), { width: 760, height: 620 });
});

test('the size is cached at startup and refreshed in the background when displays change', () => {
  const screen = new EventEmitter();
  let workArea = { width: 1366, height: 768 };
  screen.getPrimaryDisplay = () => ({ workArea });
  const sizes = createSettingsWindowSizeCache({ screen });

  assert.deepEqual(sizes.size, { width: 1160, height: 860 });
  sizes.start();
  assert.deepEqual(sizes.size, { width: 1160, height: 720 });

  workArea = { width: 1920, height: 1080 };
  screen.emit('display-metrics-changed');
  assert.deepEqual(sizes.size, { width: 1160, height: 960 });
});

test('the settings size cache is prepared before the main window and every other startup task', () => {
  const ready = /app\.whenReady\(\)\.then\(async \(\) => \{([\s\S]*?)createMainWindow\(\);/.exec(main)[1];
  assert.match(ready, /^\s+settingsWindowSizes\.start\(\);/);
});

test('the settings window is not shown before its renderer has painted', () => {
  const showCalls = [...openSettings.matchAll(/(?:existingSettingsWindow|settingsWindow)\.show\(\)/g)];
  assert.equal(showCalls.length, 2, 'shown only for an existing window and from ready-to-show');
  const existing = openSettings.indexOf('if (settingsWindow && !settingsWindow.isDestroyed()) {');
  const ready = openSettings.indexOf("once('ready-to-show'");
  assert.ok(existing < showCalls[0].index && existing < ready);
  assert.ok(showCalls[1].index > ready, 'the creation path shows the window from ready-to-show only');
  assert.ok(openSettings.indexOf('loadFile') > ready);
});

test('navigation to an existing settings window waits for its renderer to finish loading', () => {
  assert.match(openSettings, /const existingSettingsWindow = settingsWindow;/);
  assert.match(openSettings, /if \(existingSettingsWindow\.webContents\.isLoading\(\)\) existingSettingsWindow\.webContents\.once\('did-finish-load', navigate\);/);
  assert.match(openSettings, /existingSettingsWindow\.webContents\.send\('dsh:settings-navigate', target\);/);
});

test('the main window keeps the same hidden-until-ready pattern', () => {
  const createMain = /function createMainWindow\(\) \{([\s\S]*?)\n\}/.exec(main)[1];
  assert.match(createMain, /\n    show: false,\n/);
  assert.match(createMain, /mainWindow\.once\('ready-to-show', \(\) => \{ mainWindow\.show\(\); \}\);/);
});
