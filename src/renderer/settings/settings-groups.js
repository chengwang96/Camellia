'use strict';

// Topic boundaries are explicit. A new setting joins its related controls here;
// rows, their order, and whether a panel happens to be open never imply a topic.
(() => {
  const main = document.querySelector('.settings-main');
  if (!main) return;
  const get = id => document.getElementById(id);
  const resolve = (parent, selector) => {
    const node = typeof selector === 'function' ? selector() : parent.querySelector(selector);
    if (!node || !parent.contains(node)) return null;
    const row = node.closest('.setting-row, .engine-field');
    return row && parent.contains(row) ? row : node;
  };
  function group(parent, topic, nodes) {
    nodes = [...new Set(nodes.filter(node => {
      if (!node) return false;
      const owner = node.closest('[data-settings-group]');
      // Some older pages put multiple controls in one row. Keep that complete
      // row in its first topic instead of duplicating or splitting the controls.
      return owner?.parentElement !== parent || owner.dataset.settingsGroup === topic;
    }))];
    if (!nodes.length) return;
    parent.classList.add('settings-groups');
    let section = [...parent.children].find(node => node.dataset.settingsGroup === topic);
    if (!section) {
      section = document.createElement('section');
      section.className = 'settings-group'; section.dataset.settingsGroup = topic;
      parent.insertBefore(section, nodes[0]);
    }
    for (const node of nodes) if (node.parentElement !== section) section.append(node);
  }
  function arrange(id, topics) {
    const parent = get(id);
    if (!parent) return;
    for (const [topic, selectors] of topics) group(parent, topic, selectors.map(selector => resolve(parent, selector)));
  }
  // Provider editor headings contain actions; include the complete block up to
  // the next topic, and move existing nodes so their event handlers stay intact.
  function range(parent, topic, start, end, inclusive = false) {
    if (!start || !end || !parent.contains(start) || !parent.contains(end)) return [];
    const existing = start.closest('[data-settings-group]');
    if (existing?.parentElement === parent && existing.dataset.settingsGroup === topic) return [...existing.children];
    if (start.parentElement !== parent || end.parentElement !== parent) return [];
    const nodes = [];
    for (let node = start; node; node = node.nextElementSibling) {
      if (node === end) { if (inclusive) nodes.push(node); break; }
      nodes.push(node);
    }
    return nodes;
  }
  function providerEditor() {
    const editor = get('editor');
    if (!editor || editor.hidden || !get('pPriority')) return;
    const keysTitle = get('addKey')?.closest('.section-head');
    group(editor, 'provider-policy', range(editor, 'provider-policy', editor.querySelector('label[for="pPriority"]'), keysTitle));
    group(editor, 'api-keys', range(editor, 'api-keys', keysTitle, get('keyImport'), true));
    arrange('editor', [
      ['models', [() => get('modelChips')?.closest('.section')]],
      ['connection', ['#connectionAdvanced']],
      ['route-status', [() => get('routeRows')?.closest('details')]],
      ['remove-provider', ['#deleteProvider']],
    ]);
  }
  const fieldTopics = {
    permissionMode: 'permissions', approval_policy: 'permissions', sandbox_mode: 'permissions',
    'permissions.defaultMode': 'permissions', default_permission_mode: 'permissions',
    default_plan_mode: 'permissions', agentMode: 'permissions', toolPermission: 'permissions',
    thinkingBudget: 'model-behavior', contextWindow: 'model-behavior', model_reasoning_effort: 'model-behavior',
    effortLevel: 'model-behavior', web_search: 'model-behavior',
    language: 'responses', outputStyle: 'responses', instructions: 'responses',
    'loop_control.max_attempts_per_step': 'tasks-and-tools', 'background.max_running_tasks': 'tasks-and-tools',
    merge_all_available_skills: 'tasks-and-tools',
    cleanupPeriodDays: 'session-history', telemetry: 'usage-statistics', enableTelemetry: 'usage-statistics',
  };
  function engineFields() {
    const parent = get('engineCommon');
    if (!parent) return;
    const topics = new Map();
    for (const row of parent.querySelectorAll('.engine-field')) {
      const control = row.querySelector('[data-field], [data-desktop]');
      if (!control) continue;
      const topic = control.dataset.desktop === 'cwd' ? 'workbench-sessions'
        : control.dataset.desktop === 'contextWindow' ? 'model-behavior'
          : fieldTopics[control.dataset.field] || 'engine-preferences';
      if (!topics.has(topic)) topics.set(topic, []);
      topics.get(topic).push(row);
    }
    const title = parent.querySelector('.engine-common-title');
    if (title && topics.has('workbench-sessions')) topics.get('workbench-sessions').unshift(title);
    for (const [topic, rows] of topics) group(parent, topic, rows);
  }
  function organize() {
    arrange('generalPage', [
      ['shared-memory', ['#memoryDirectory']],
      ['appearance', ['#language', '#theme', '#chatContentWidth']],
      ['quota-refresh', ['#autoRefreshBalances', '#accountRefreshMinutes', '#antigravityAutoRefresh']],
      ['background-routing', ['#closeToTray']],
      ['conversation-handoff', ['#conversationMode', '.setting-note', '#conversationWarn', '#conversationOriginSetting']],
      ['python', ['#pythonCard']],
      ['application-updates', ['#version', '#checkAppUpdate', '#appUpdateDetails']],
      // Older installed releases keep data controls on General/Archived.
      ['local-data', ['#dataPath']],
      ['data-transfer', ['#dataMigrationSection']],
    ]);
    arrange('dataPage', [
      ['local-data', ['#dataDirectorySection']], ['data-transfer', ['#dataMigrationSection']], ['storage', ['#storageSection']],
    ]);
    const storage = get('storageSection');
    if (storage) {
      arrange('storageSection', [['plugin-caches', ['#maintainPluginCaches']]]);
      group(storage, 'unused-files', range(storage, 'unused-files', get('scanStorage')?.closest('.toolbar')?.previousElementSibling, get('cleanStorage'), true));
    }
    arrange('modelsPage', [
      ['api-routing', [() => get('multiKeyConcurrency')?.closest('.section')]],
      ['subscription-visibility', ['.subscription-models-section']],
      ['quick-switch', [() => get('quickSwitchModels')?.previousElementSibling, '#quickSwitchModels']],
      ['model-sessions', [() => get('conversationSessionTtl')?.closest('.section')]],
    ]);
    arrange('networkPage', [
      ['connection-mode', ['#networkMode', '#systemProxyStatus']], ['connectivity-test', ['.connectivity-section']],
    ]);
    arrange('providersPage', [
      ['provider-overview', ['#providersHeading', '#providers']], ['provider-editor', ['#editor']],
      ['router-options', ['.router-options']], ['account-balances', ['#balancesSection']],
    ]);
    providerEditor();
    const usage = get('usagePage');
    if (usage) {
      group(usage, 'usage-overview', range(usage, 'usage-overview', usage.querySelector('.usage-api-title'), get('subscriptionCostCard'), true));
      group(usage, 'usage-trends', range(usage, 'usage-trends', get('usageMetric')?.closest('.section-head'), get('usageChartNotes'), true));
      arrange('usagePage', [['usage-details', [() => get('exportUsage')?.closest('.section-head'), '.table-scroll']]]);
    }
    arrange('mobilePage', [
      ['mobile-connection', ['.mobile-connection-card']], ['device-pairing', ['.mobile-pair-card']],
      ['authorized-devices', [() => get('mobile-devices')?.closest('.mobile-section')]],
    ]);
    arrange('subscriptionAccounts', [
      ['chatgpt-accounts', ['#codexAccountPanel']], ['kimi-accounts', ['#kimiAccountPanel']], ['google-accounts', ['#googleAccountPanel']],
    ]);
    arrange('enginesPage', [
      ['engine-installation', ['.engine-runtime']], ['engine-configuration', ['.global-notice', '#engineLoading', '#engineContent']],
    ]);
    arrange('engineContent', [
      ['dsh-native-panel', ['#dshNative']], ['engine-preferences', ['#engineCommon']], ['native-documents', ['#nativeDocuments']],
    ]);
    engineFields();
    state.pending = false;
  }
  const state = window.CamelliaSettingsGroups = { pending: false, refresh: organize };
  let frame;
  new MutationObserver(() => {
    if (frame) return;
    state.pending = true;
    frame = requestAnimationFrame(() => { frame = null; organize(); });
  }).observe(main, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  organize();
})();
