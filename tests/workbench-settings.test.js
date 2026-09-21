'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHarness } = require('./claude-harness.cjs');

test('settings places General immediately before Engine Settings and shows it initially', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/settings/api-settings.html'), 'utf8');
  const categories = [...html.matchAll(/<button data-view="([^"]+)"/g)].map(match => match[1]);
  assert.equal(categories.indexOf('general') + 1, categories.indexOf('engines'));
  assert.match(html, /<button data-view="general" class="active" aria-current="page"/);
  assert.match(html, /<section id="generalPage" class="page">/);
  assert.match(html, /<section id="providersPage" class="page" hidden>/);
});

test('settings navigation defaults to General and preserves explicit destinations', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/settings/api-settings.js'), 'utf8');
  const navigation = source.slice(source.indexOf('function navigateSettings('), source.indexOf('const engineUI ='));
  const calls = [];
  const context = vm.createContext({ setView: (...args) => calls.push(args) });
  vm.runInContext(navigation, context);
  context.navigateSettings();
  context.navigateSettings({});
  context.navigateSettings({ page: 'engines', engine: 'codex', focus: 'account' });
  context.navigateSettings({ page: 'providers' });
  assert.deepEqual(calls, [
    ['general', undefined, undefined],
    ['general', undefined, undefined],
    ['engines', 'codex', 'account'],
    ['providers', undefined, undefined],
  ]);
});

test('close-to-tray preference defaults off, persists, and survives partial saves', () => {
  const first = createHarness();
  try {
    assert.equal(first.call('workbench-settings').closeToTray, false);
    assert.equal(first.call('workbench-save-settings', { language: 'en', theme: 'system', autoRefreshBalances: false, closeToTray: true }).ok, true);
    assert.equal(first.call('workbench-settings').closeToTray, true);
    const reopened = createHarness(first.root);
    assert.equal(reopened.call('workbench-settings').closeToTray, true);
    // Older callers that do not send the key must retain the saved choice.
    assert.equal(reopened.call('workbench-save-settings', { theme: 'dark' }).ok, true);
    assert.equal(reopened.call('workbench-settings').closeToTray, true);
    assert.equal(reopened.call('workbench-save-settings', { language: 'en', theme: 'system', autoRefreshBalances: false, closeToTray: false }).ok, true);
    assert.equal(reopened.call('workbench-settings').closeToTray, false);
  } finally { first.cleanup(); }
});
