'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8').replace(/\r\n/g, '\n');
const openSettings = /function openSettingsWindow\(target = \{\}\) \{([\s\S]*?)\n\}\n\nfunction createMainWindow/.exec(main)[1];

test('the settings window is created hidden and centered so it never flashes at the default position', () => {
  assert.match(openSettings, /new BrowserWindow\(\{/);
  assert.match(openSettings, /\n    show: false,\n/);
  assert.match(openSettings, /\n    center: true,\n/);
  assert.match(openSettings, /settingsWindow\.once\('ready-to-show', \(\) => \{[\s\S]*?settingsWindow\.center\(\);[\s\S]*?settingsWindow\.show\(\);/);
});

test('the settings window is not shown before its renderer has painted', () => {
  const showCalls = [...openSettings.matchAll(/settingsWindow\.show\(\)/g)];
  assert.equal(showCalls.length, 2, 'shown only for an existing window and from ready-to-show');
  const existing = openSettings.indexOf('if (settingsWindow && !settingsWindow.isDestroyed()) {');
  const ready = openSettings.indexOf("once('ready-to-show'");
  assert.ok(existing < showCalls[0].index && existing < ready);
  assert.ok(showCalls[1].index > ready, 'the creation path shows the window from ready-to-show only');
  assert.ok(openSettings.indexOf('loadFile') > ready);
});

test('the main window keeps the same hidden-until-ready pattern', () => {
  const createMain = /function createMainWindow\(\) \{([\s\S]*?)\n\}/.exec(main)[1];
  assert.match(createMain, /\n    show: false,\n/);
  assert.match(createMain, /mainWindow\.once\('ready-to-show', \(\) => \{ mainWindow\.show\(\); \}\);/);
});
