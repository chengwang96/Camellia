'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { settingsWindowSize, settingsWindowBounds, createSettingsWindowSizeCache } = require('../src/main/settings-window-size');

const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8').replace(/\r\n/g, '\n');
const openSettings = /function openSettingsWindow\(target = \{\}\) \{([\s\S]*?)\n\}\n\nfunction createMainWindow/.exec(main)[1];

test('settings opens hidden as a frameless modal panel and is positioned before it is shown', () => {
  assert.match(openSettings, /new BrowserWindow\(\{/);
  assert.match(openSettings, /const preferredSize = settingsWindowSizes\.size;/);
  assert.doesNotMatch(openSettings, /settingsWindowSize\(|getPrimaryDisplay\(/);
  assert.match(openSettings, /\n\s+show: false,\n/);
  assert.match(openSettings, /parent: owner, modal: true/);
  assert.match(openSettings, /frame: false/);
  assert.match(openSettings, /transparent: true/);
  assert.match(openSettings, /settingsWindow\.once\('ready-to-show', \(\) => \{[\s\S]*?settingsWindow\.setBounds\([\s\S]*?settingsWindow\.show\(\);/);
});

test('the floating panel stays centered inside small and secondary-monitor workbenches', () => {
  const preferred = { width: 1160, height: 960 };
  assert.deepEqual(settingsWindowBounds(preferred, { x: 100, y: 50, width: 1320, height: 900 }),
    { width: 1160, height: 852, x: 180, y: 74 });
  assert.deepEqual(settingsWindowBounds(preferred, { x: -1920, y: 0, width: 960, height: 680 }),
    { width: 912, height: 632, x: -1896, y: 24 });
  assert.deepEqual(settingsWindowBounds(preferred, { x: 0, y: 0, width: 2560, height: 1400 }),
    { width: 1160, height: 960, x: 700, y: 220 });
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
