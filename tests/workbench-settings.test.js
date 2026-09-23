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

test('the balance and quota refresh interval is global, validated, and preserved by partial saves', () => {
  const first = createHarness();
  try {
    assert.equal(first.call('workbench-settings').accountRefreshMinutes, 15);
    assert.equal(first.call('workbench-save-settings', { language: 'en', theme: 'system', autoRefreshBalances: true, accountRefreshMinutes: 5 }).ok, true);
    assert.equal(first.call('workbench-settings').accountRefreshMinutes, 5);
    // An unsupported cadence is ignored instead of being written or crashing.
    assert.equal(first.call('workbench-save-settings', { accountRefreshMinutes: 7 }).ok, true);
    assert.equal(first.call('workbench-settings').accountRefreshMinutes, 5);
    // Callers that never knew about the key keep the saved cadence.
    assert.equal(first.call('workbench-save-settings', { theme: 'dark' }).ok, true);
    assert.equal(first.call('workbench-settings').accountRefreshMinutes, 5);
    const reopened = createHarness(first.root);
    assert.equal(reopened.call('workbench-settings').accountRefreshMinutes, 5);
    reopened.cleanup();
  } finally { first.cleanup(); }
});

// The router's quota probe is what keeps an exhausted key out of rotation, so it
// must follow the switch and cadence that drive it — and nothing else.
test('only the quota switch and cadence re-run the router quota check', async () => {
  const first = createHarness();
  try {
    const port = await new Promise(resolve => {
      const server = require('node:net').createServer();
      server.listen(0, '127.0.0.1', () => { const found = server.address().port; server.close(() => resolve(found)); });
    });
    const { normalizeConfig, writeConfig } = require('../src/api/api-router-config');
    const file = path.join(first.home, '.dsh', 'ollama-proxy.json');
    writeConfig(file, normalizeConfig({ port, enabled: true, providers: [{
      id: 'test', name: 'Local test', baseUrl: 'http://127.0.0.1:19099/v1', protocol: 'openai',
      models: [{ id: 'test-model', upstream: 'test-model' }], keys: [{ id: 'test-key', key: 'isolated-test-key' }],
    }] }));
    await first.call('api-router-save-config', JSON.parse(fs.readFileSync(file, 'utf8')));
    assert.equal(first.call('api-router-get-state').running, true);
    const routerEvents = () => first.events.filter(event => event.channel === 'dsh:api-router-state').length;
    const quotaCheck = () => first.call('api-router-get-state').quotaCheck;
    const settle = () => new Promise(resolve => setTimeout(resolve, 50));
    first.events.length = 0;
    await first.call('workbench-save-settings', { language: 'zh-CN', theme: 'dark', closeToTray: true });
    await settle();
    assert.equal(routerEvents(), 0, 'an unrelated preference save must not re-probe account quota');
    // The interval and the switch that feed the probe still reach the router.
    await first.call('workbench-save-settings', { language: 'zh-CN', theme: 'dark', accountRefreshMinutes: 30 });
    await settle();
    assert.equal(quotaCheck().intervalMs, 30 * 60000);
    assert.ok(routerEvents() > 0, 'a cadence change must update the running router');
    await first.call('workbench-save-settings', { language: 'en', theme: 'dark', autoRefreshBalances: false });
    await settle();
    assert.equal(quotaCheck().enabled, false);
  } finally {
    await first.api.stopRouter();
    first.cleanup();
  }
});
