'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHarness } = require('./claude-harness.cjs');

test('global memory validates a user folder, persists across restart and partial saves, and clears', () => {
  const first = createHarness();
  try {
    assert.equal(first.call('workbench-settings').memoryDirectory, '');
    const directory = first.folder('shared memory 记忆');
    assert.equal(first.call('workbench-save-settings', { memoryDirectory: '  ' + directory + '  ' }).ok, true);
    assert.equal(first.call('workbench-settings').memoryDirectory, directory);
    assert.equal(first.call('workbench-save-settings', { theme: 'dark' }).ok, true);
    const reopened = createHarness(first.root);
    assert.equal(reopened.call('workbench-settings').memoryDirectory, directory);
    const file = path.join(directory, 'MEMORY.md');
    fs.writeFileSync(file, 'User-owned memory rules');
    for (const memoryDirectory of [null, {}, 42, 'relative/folder', file, directory + '-missing', directory + '\n']) {
      assert.equal(reopened.call('workbench-save-settings', { memoryDirectory }).ok, false);
      assert.equal(reopened.call('workbench-settings').memoryDirectory, directory);
    }
    assert.equal(reopened.call('workbench-save-settings', { memoryDirectory: '' }).ok, true);
    assert.equal(reopened.call('workbench-settings').memoryDirectory, '');
    assert.equal(fs.readFileSync(file, 'utf8'), 'User-owned memory rules');
  } finally { first.cleanup(); }
});

test('settings separates general, engine and model preferences and starts on General', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/settings/api-settings.html'), 'utf8');
  const categories = [...html.matchAll(/<button data-view="([^"]+)"/g)].map(match => match[1]);
  // Network owns the connection settings and sits between General and the
  // per-engine pages; the general preferences page stays first and active.
  assert.deepEqual(categories, ['subscriptions', 'providers', 'usage', 'general', 'network',
    'engines', 'models', 'archived', 'mobile', 'devices']);
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

test('subscription accounts and API keys have separate navigation and page containers', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/settings/api-settings.html'), 'utf8');
  const subscriptions = html.slice(html.indexOf('<section id="subscriptionsPage"'), html.indexOf('<section id="providersPage"'));
  const providers = html.slice(html.indexOf('<section id="providersPage"'), html.indexOf('<section id="usagePage"'));
  assert.match(html, /data-view="subscriptions"/);
  assert.match(html, /data-view="providers"/);
  assert.match(subscriptions, /id="subscriptionAccounts"/);
  assert.doesNotMatch(subscriptions, /id="addProvider"|id="bulkKeys"/);
  assert.match(providers, /id="addProvider"/);
  assert.doesNotMatch(providers, /id="subscriptionAccounts"/);
});

test('parked session retention settings default, clamp, persist and survive partial saves', () => {
  const first = createHarness();
  try {
    assert.equal(first.call('workbench-settings').conversations.sessionTtlMinutes, 30);
    assert.equal(first.call('workbench-settings').conversations.sessionLimit, 4);
    assert.equal(first.call('workbench-save-settings', { conversations: { mode: 'direct', sessionTtlMinutes: 5, sessionLimit: 2 } }).ok, true);
    assert.equal(first.call('workbench-settings').conversations.sessionTtlMinutes, 5);
    assert.equal(first.call('workbench-settings').conversations.sessionLimit, 2);
    // Out-of-range values are clamped instead of dropped; partial saves keep them.
    assert.equal(first.call('workbench-save-settings', { conversations: { mode: 'direct', sessionTtlMinutes: 0, sessionLimit: 0 } }).ok, true);
    assert.equal(first.call('workbench-settings').conversations.sessionTtlMinutes, 1);
    assert.equal(first.call('workbench-settings').conversations.sessionLimit, 1);
    assert.equal(first.call('workbench-save-settings', { theme: 'dark' }).ok, true);
    assert.equal(first.call('workbench-settings').conversations.sessionLimit, 1);
    const reopened = createHarness(first.root);
    assert.equal(reopened.call('workbench-settings').conversations.sessionTtlMinutes, 1);
    assert.equal(reopened.call('workbench-settings').conversations.sessionLimit, 1);
    reopened.cleanup();
  } finally { first.cleanup(); }
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

const WIDTH_EVENT = 'dsh:chat-content-width-changed';

test('conversation width defaults to standard, validates, persists, and survives partial saves', () => {
  const first = createHarness();
  try {
    assert.equal(first.call('workbench-settings').chatContentWidth, 'standard');
    // Unknown values fall back to the default instead of being written.
    assert.equal(first.call('workbench-save-settings', { chatContentWidth: 'gigantic' }).ok, true);
    assert.equal(first.call('workbench-settings').chatContentWidth, 'standard');
    assert.equal(first.call('workbench-save-settings', { chatContentWidth: 'wide' }).ok, true);
    assert.equal(first.call('workbench-settings').chatContentWidth, 'wide');
    // Callers that do not know about the key keep the saved width.
    assert.equal(first.call('workbench-save-settings', { theme: 'dark' }).ok, true);
    assert.equal(first.call('workbench-settings').chatContentWidth, 'wide');
    const reopened = createHarness(first.root);
    assert.equal(reopened.call('workbench-settings').chatContentWidth, 'wide');
    reopened.cleanup();
  } finally { first.cleanup(); }
});

test('only a real conversation-width change broadcasts to the open workbench', () => {
  const harness = createHarness();
  try {
    harness.events.length = 0;
    harness.call('workbench-save-settings', { chatContentWidth: 'standard' });
    assert.equal(harness.events.filter(event => event.channel === WIDTH_EVENT).length, 0, 'an unchanged width must not re-broadcast');
    harness.call('workbench-save-settings', { chatContentWidth: 'full' });
    const widths = harness.events.filter(event => event.channel === WIDTH_EVENT).map(event => event.data);
    assert.deepEqual(widths, ['full']);
    harness.call('workbench-save-settings', { theme: 'light' });
    assert.deepEqual(harness.events.filter(event => event.channel === WIDTH_EVENT).map(event => event.data), ['full'],
      'a partial save keeps the width and stays silent');
  } finally { harness.cleanup(); }
});

test('General exposes the conversation width selector and the chat column reads the variable', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/settings/api-settings.html'), 'utf8');
  const general = html.slice(html.indexOf('<section id="generalPage"'), html.indexOf('<section id="networkPage"'));
  assert.match(general, /<select id="chatContentWidth"[^>]*>/);
  assert.match(general, /<option value="standard"[^>]*>Standard width</);
  assert.match(general, /<option value="wide"[^>]*>Wider</);
  assert.match(general, /<option value="full"[^>]*>Full width</);
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/settings/api-settings.js'), 'utf8');
  assert.ok(source.includes("chatContentWidth: $('chatContentWidth').value"));
  assert.ok(source.includes("$('chatContentWidth').value = preferences.chatContentWidth"));
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/claude.css'), 'utf8');
  assert.match(css, /\.column \{ width: 100%; max-width: var\(--content-width\); margin: 0 auto; \}/);
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


test('quick-switch defaults persist per engine, clear independently, and preserve other preferences', () => {
  const harness = createHarness();
  try {
    assert.deepEqual({ ...harness.call('workbench-settings').quickSwitchModels }, {});
    assert.deepEqual({ ...harness.call('workbench-settings').quickSwitchLevels }, {});
    harness.call('workbench-save-settings', { theme: 'dark', autoRefreshBalances: false });
    assert.equal(harness.call('workbench-save-settings', { quickSwitchModels: { codex: 'model-a', claude: 'model-b' } }).ok, true);
    harness.call('workbench-save-settings', { quickSwitchModels: { codex: 'model-c' } });
    const saved = harness.call('workbench-settings');
    assert.deepEqual({ ...saved.quickSwitchModels }, { codex: 'model-c', claude: 'model-b' });
    assert.equal(saved.theme, 'dark');
    assert.equal(saved.autoRefreshBalances, false);
    assert.equal(harness.call('workbench-save-settings', { quickSwitchLevels: { codex: 'high', claude: 'medium' } }).ok, true);
    harness.call('workbench-save-settings', { quickSwitchLevels: { codex: 'xhigh' } });
    assert.deepEqual({ ...harness.call('workbench-settings').quickSwitchLevels }, { codex: 'xhigh', claude: 'medium' });
    // A model change leaves the level of other engines, and the level itself, alone.
    harness.call('workbench-save-settings', { quickSwitchModels: { codex: 'model-d' } });
    assert.deepEqual({ ...harness.call('workbench-settings').quickSwitchLevels }, { codex: 'xhigh', claude: 'medium' });
    const reopened = createHarness(harness.root);
    assert.deepEqual({ ...reopened.call('workbench-settings').quickSwitchModels }, { codex: 'model-d', claude: 'model-b' });
    assert.deepEqual({ ...reopened.call('workbench-settings').quickSwitchLevels }, { codex: 'xhigh', claude: 'medium' });
    reopened.call('workbench-save-settings', { quickSwitchModels: { codex: '' } });
    assert.deepEqual({ ...reopened.call('workbench-settings').quickSwitchModels }, { claude: 'model-b' });
    reopened.call('workbench-save-settings', { quickSwitchLevels: { codex: '' } });
    assert.deepEqual({ ...reopened.call('workbench-settings').quickSwitchLevels }, { claude: 'medium' });
    for (const invalid of [[], null, { unknown: 'model' }, { codex: 123 }]) {
      assert.equal(reopened.call('workbench-save-settings', { quickSwitchModels: invalid }).ok, false);
      assert.equal(reopened.call('workbench-save-settings', { quickSwitchLevels: invalid }).ok, false);
    }
    assert.deepEqual({ ...reopened.call('workbench-settings').quickSwitchModels }, { claude: 'model-b' });
    assert.deepEqual({ ...reopened.call('workbench-settings').quickSwitchLevels }, { claude: 'medium' });
  } finally { harness.cleanup(); }
});
