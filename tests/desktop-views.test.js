'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createDesktopViews } = require('../src/main/desktop-views');

test('extracted desktop pages escape input and all generated scripts compile', () => {
  const injected = '<img src=x onerror="alert(1)">';
  const views = createDesktopViews({ appName: injected, isDark: () => false });
  for (const html of [views.welcomeHtml(), views.errorHtml(new Error(injected))]) {
    assert.ok(!html.includes(injected));
    assert.match(html, /&lt;img/);
    for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new vm.Script(match[1]));
  }
});

test('preload event subscriptions expose payloads and removable listeners, not Electron objects', () => {
  const ipc = new EventEmitter();
  let bridge;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src/main/preload.js'), 'utf8'), {
    process: { argv: [] },
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, api) => { bridge = api; } }, ipcRenderer: ipc, webUtils: {} }),
    window: { addEventListener() {} },
  });
  for (const [method, channel] of [['onClaudeEvent', 'dsh:claude-event'], ['onClaudeGoal', 'dsh:claude-goal'], ['onApiRouterState', 'dsh:api-router-state'], ['onProviderInsights', 'dsh:provider-insights']]) {
    const values = [];
    const unsubscribe = bridge[method](value => values.push(value));
    assert.equal(typeof unsubscribe, 'function');
    ipc.emit(channel, { sensitiveElectronObject: true }, { value: 'safe' });
    assert.deepEqual(values, [{ value: 'safe' }]);
    unsubscribe();
    assert.equal(ipc.listenerCount(channel), 0);
  }
});

test('settings load external scripts under CSP and no longer expose runtime path forms', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'src/renderer/settings/api-settings.html'), 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.ok(!/id="(?:dshBin|nodeExe|dshHome|dsBalance)"/.test(html));
  for (const file of ['src/renderer/settings/api-settings.js', 'src/renderer/settings/settings-charts.js']) assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(root, file), 'utf8')));
});
