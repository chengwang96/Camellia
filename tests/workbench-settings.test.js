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

test('settings separates general, data, engine and model preferences and starts on General', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/settings/api-settings.html'), 'utf8');
  const categories = [...html.matchAll(/<button data-view="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(categories, ['subscriptions', 'providers', 'usage', 'general', 'data', 'network',
    'engines', 'models', 'archived', 'mobile', 'devices']);
  assert.match(html, /<button data-view="general" class="active" aria-current="page"/);
  assert.match(html, /<section id="generalPage" class="page">/);
  assert.match(html, /<section id="providersPage" class="page" hidden>/);
  assert.match(html, /<section id="dataPage" class="page" hidden>/);
});

test('data directory, transfer and cleanup controls live only on the data page', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/settings/api-settings.html'), 'utf8');
  const general = html.slice(html.indexOf('<section id="generalPage"'), html.indexOf('<section id="dataPage"'));
  const data = html.slice(html.indexOf('<section id="dataPage"'), html.indexOf('<section id="modelsPage"'));
  const archived = html.slice(html.indexOf('<section id="archivedPage"'), html.indexOf('<section id="devicesPage"'));
  for (const id of ['dataPath', 'migrateDataDirectory', 'openLogs', 'exportData', 'importData', 'storageSection', 'scanStorage', 'cleanStorage']) {
    assert.ok(data.includes(`id="${id}"`), id + ' belongs to Data & backups');
    assert.ok(!general.includes(`id="${id}"`), id + ' does not belong to General');
    assert.ok(!archived.includes(`id="${id}"`), id + ' does not belong to Archived');
    assert.equal(html.split(`id="${id}"`).length - 1, 1, id + ' has one control');
  }
  for (const id of ['memoryDirectory', 'language', 'theme', 'checkAppUpdate', 'version']) assert.ok(general.includes(`id="${id}"`));
  assert.match(archived, /id="archivedList"/);
  assert.match(archived, /id="deleteAllArchived"/);
});

test('data navigation preserves older storage links and General targets', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/settings/api-settings.js'), 'utf8');
  const navigation = source.slice(source.indexOf('function setView('), source.indexOf('function navigateSettings('));
  const elements = new Map(), scrolled = [];
  const context = vm.createContext({
    isDirty: () => false,
    titles: { general: ['General', ''], data: ['Data & backups', ''], archived: ['Archived', ''] },
    $: id => {
      if (!elements.has(id)) elements.set(id, { closest: () => (['storageSection', 'exportData', 'dataPath'].includes(id) ? {} : null),
        scrollIntoView: () => scrolled.push(id) });
      return elements.get(id);
    },
    document: { querySelectorAll: () => [] },
    engineUI: { setVisible() {}, pythonPage() {} },
    window: { mobileAccessUI: { setVisible() {} } },
    requestAnimationFrame: callback => callback(),
  });
  vm.runInContext(navigation, context);
  for (const [page, focus] of [['data'], ['storage'], ['general', 'exportData'], ['general', 'dataPath']]) {
    context.setView(page, undefined, focus);
    assert.equal(context.view, 'data');
    assert.equal(elements.get('dataPage').hidden, false);
    assert.equal(elements.get('generalPage').hidden, true);
    assert.equal(elements.get('archivedPage').hidden, true);
  }
  assert.deepEqual(scrolled, ['storageSection', 'exportData', 'dataPath']);
  context.setView('data', undefined, 'memoryDirectory');
  assert.deepEqual(scrolled, ['storageSection', 'exportData', 'dataPath']);
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
  context.navigateSettings({ page: 'data' });
  assert.deepEqual(calls, [
    ['general', undefined, undefined],
    ['general', undefined, undefined],
    ['engines', 'codex', 'account'],
    ['providers', undefined, undefined],
    ['data', undefined, undefined],
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

test('the per-engine background quota refresh is opt-out only and survives partial saves', () => {
  const first = createHarness();
  try {
    // Every subscription engine refreshes by default.
    const defaults = first.call('workbench-settings').subscriptionAutoRefresh;
    assert.equal(defaults.antigravity, true); assert.equal(defaults.codex, true); assert.equal(defaults.kimi, true);
    // An opt-out is stored; a request to turn an engine back on clears the flag.
    assert.equal(first.call('workbench-save-settings', { subscriptionAutoRefresh: { antigravity: false } }).ok, true);
    assert.equal(first.call('workbench-settings').subscriptionAutoRefresh.antigravity, false);
    assert.equal(first.call('workbench-settings').subscriptionAutoRefresh.codex, true);
    // A partial save that never mentions the key keeps the choice.
    assert.equal(first.call('workbench-save-settings', { theme: 'dark' }).ok, true);
    assert.equal(first.call('workbench-settings').subscriptionAutoRefresh.antigravity, false);
    const reopened = createHarness(first.root);
    assert.equal(reopened.call('workbench-settings').subscriptionAutoRefresh.antigravity, false);
    assert.equal(reopened.call('workbench-save-settings', { subscriptionAutoRefresh: { antigravity: true } }).ok, true);
    assert.equal(reopened.call('workbench-settings').subscriptionAutoRefresh.antigravity, true);
    // An unknown engine or a non-boolean value is rejected without writing.
    assert.equal(reopened.call('workbench-save-settings', { subscriptionAutoRefresh: { gemini: false } }).ok, false);
    assert.equal(reopened.call('workbench-save-settings', { subscriptionAutoRefresh: { antigravity: 'no' } }).ok, false);
    assert.equal(reopened.call('workbench-settings').subscriptionAutoRefresh.antigravity, true);
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

test('settings navigation is available before API router configuration loads', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/settings/api-settings.js'), 'utf8');
  assert.match(source, /document\.querySelector\('\.settings-nav nav'\)\.onclick = e => \{ const button = e\.target\.closest\('\[data-view\]'\); if \(button\) setView\(button\.dataset\.view\); \};/);
  assert.match(source, /navigateSettings\(Object\.fromEntries\(new URLSearchParams\(location\.search\)\)\);\s*void refresh\(true\);/);
});

test('hidden subscription models persist by provider without changing routes or other preferences', () => {
  const first = createHarness();
  try {
    assert.deepEqual({ ...first.call('workbench-settings').hiddenSubscriptionModels }, {});
    first.events.length = 0;
    assert.equal(first.call('workbench-save-settings', { hiddenSubscriptionModels: { codex: ['gpt-a'], kimi: ['kimi-a'] } }).ok, true);
    assert.deepEqual(first.events.filter(event => event.channel === 'dsh:engine-settings-changed').map(event => event.data.engine), ['codex', 'kimi']);
    assert.equal(first.call('workbench-save-settings', { hiddenSubscriptionModels: { codex: ['gpt-b', 'gpt-b'] } }).ok, true);
    assert.deepEqual(first.call('workbench-settings').hiddenSubscriptionModels, { codex: ['gpt-b'], kimi: ['kimi-a'] });
    assert.equal(first.call('workbench-save-settings', { theme: 'dark' }).ok, true);
    const reopened = createHarness(first.root);
    assert.deepEqual(reopened.call('workbench-settings').hiddenSubscriptionModels, { codex: ['gpt-b'], kimi: ['kimi-a'] });
    assert.equal(reopened.call('workbench-save-settings', { hiddenSubscriptionModels: { codex: [] } }).ok, true);
    assert.deepEqual(reopened.call('workbench-settings').hiddenSubscriptionModels, { kimi: ['kimi-a'] });
    for (const value of [null, [], { claude: ['model'] }, { codex: 'model' }, { kimi: [42] }, { antigravity: [' '] },
      { codex: ['a'.repeat(257)] }]) {
      assert.equal(reopened.call('workbench-save-settings', { hiddenSubscriptionModels: value }).ok, false);
      assert.deepEqual(reopened.call('workbench-settings').hiddenSubscriptionModels, { kimi: ['kimi-a'] });
    }
  } finally { first.cleanup(); }
});

test('settings initialization preserves navigation made while preferences are loading', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/settings/api-settings.js'), 'utf8');
  const navigation = source.slice(source.indexOf('function setView('), source.indexOf('const engineUI ='));
  const startup = source.slice(source.indexOf('navigateSettings(Object.fromEntries(new URLSearchParams(location.search)))'), source.indexOf('// Closing the window'));
  for (const [initial, chosen, viaIpc, dirty] of [['mobile', null, false, false], ['general', 'mobile', false, false], ['mobile', 'general', false, false], ['general', 'mobile', true, false], ['general', 'mobile', false, true]]) {
    let finishLoading;
    let saves = 0;
    const panels = new Map();
    const context = vm.createContext({
      view: 'general', titles: { general: ['General', ''], mobile: ['Mobile access', ''] },
      $: id => { if (!panels.has(id)) panels.set(id, {}); return panels.get(id); },
      document: { querySelectorAll: () => [] },
      engineUI: { setVisible() {}, pythonPage() {} },
      window: { mobileAccessUI: { setVisible() {} } },
      isDirty: () => dirty,
      flushSave: async () => { saves++; },
      refresh: () => new Promise(resolve => { finishLoading = resolve; }),
      URLSearchParams, location: { search: '?page=' + initial },
    });
    vm.runInContext(navigation + '\n' + startup, context);
    assert.equal(context.view, initial);
    if (chosen) {
      if (viaIpc) context.navigateSettings({ page: chosen });
      else context.setView(chosen);
    }
    finishLoading();
    await new Promise(resolve => setImmediate(resolve));
    const expected = chosen || initial;
    assert.equal(context.view, expected);
    assert.equal(panels.get(expected + 'Page').hidden, false);
    assert.equal(saves, dirty ? (chosen ? 2 : 1) : 0);
  }
});
