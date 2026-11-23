'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { removeTree } = require('./test-fs.cjs');
const { createWebSurfaceManager } = require('../src/main/web-surface.js');

async function until(check, timeout = 2000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for the web surface to become ready');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function harness({
  layoutAssistant = null, cache = null, historyMode = 'normal', holdStopLoading = false,
  pageReady = false, preservePageUrl = false, failFirstLoadPartitions = [],
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-web-surface-'));
  if (cache) fs.writeFileSync(path.join(root, 'web-sessions.json'), JSON.stringify(cache));
  const sessions = new Map();
  const ipcHandlers = new Map();
  const events = [];
  const external = [];
  const menuTemplates = [];
  class FakeContents extends EventEmitter {
    constructor(partition, holdStopLoading) {
      super();
      this.partition = partition;
      this.holdStopLoading = holdStopLoading;
      this.url = 'about:blank';
      this.title = '';
      this.destroyed = false;
      this.historyMode = historyMode;
      this.pageReady = pageReady;
      this.preservePageUrl = preservePageUrl;
      this.failFirstLoad = failFirstLoadPartitions.includes(partition);
      this.loadAttempts = 0;
      this.zoomFactor = 1;
      this.webRTCIPHandlingPolicy = null;
      this.executedScripts = [];
      this.userAgent = 'Mozilla/5.0 Electron/44.0.0 Camellia/1.1.0';
      this.navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack() {}, goForward() {} };
    }
    isDestroyed() { return this.destroyed; }
    getURL() { return this.url; }
    getTitle() { return this.title; }
    getUserAgent() { return this.userAgent; }
    setUserAgent(value) { this.userAgent = value; }
    getZoomFactor() { return this.zoomFactor; }
    setZoomFactor(value) { this.zoomFactor = value; }
    setWebRTCIPHandlingPolicy(value) { this.webRTCIPHandlingPolicy = value; }
    async capturePage() { return { toDataURL: () => 'data:image/png;base64,capture' }; }
    focus() {}
    setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
    setPermissionRequestHandler() {}
    setPermissionCheckHandler() {}
    async loadURL(url) {
      this.loadAttempts++;
      this.url = url;
      this.emit('did-start-loading');
      this.emit('did-start-navigation', {}, url, false, true);
      this.emit('dom-ready');
      if (this.failFirstLoad && this.loadAttempts === 1) {
        this.failFirstLoad = false;
        this.emit('did-fail-load', {}, -2, 'ERR_FAILED', url, true);
        throw Object.assign(new Error('ERR_FAILED'), { code: 'ERR_FAILED' });
      }
      if (!this.holdStopLoading) this.emit('did-stop-loading');
    }
    async insertCSS() { return 'css-key'; }
    reload() {
      this.emit('did-start-loading');
      this.emit('did-start-navigation', {}, this.url, false, true);
      this.emit('dom-ready');
      if (!this.holdStopLoading) this.emit('did-stop-loading');
    }
    close() { this.destroyed = true; }
    async executeJavaScript(source) {
      this.executedScripts.push(source);
      if (source.includes('cfg.moreSelector')) return { ok: true, action: 'session-action' };
      if (source.includes('candidates: [...candidates.values()]')) {
        return {
          url: 'https://chat.deepseek.com/a/chat/s/current',
          links: [{ path: '/a/chat/s/current' }],
          sidebars: [],
          candidates: [{ pattern: '/a/chat/s/:id', count: 1, classes: ['history-link'], samplePaths: ['/a/chat/s/current'] }],
        };
      }
      const transient = this.historyMode === 'transient';
      const fallback = this.historyMode === 'fallback';
      return {
        url: this.preservePageUrl ? this.url : (this.partition.includes('kimi')
          ? 'https://www.kimi.com/chat/kimi-current'
          : 'https://chat.deepseek.com/a/chat/s/current'),
        title: 'DeepSeek current',
        sessions: transient || fallback ? [] : [
          { url: 'https://chat.deepseek.com/a/chat/s/current?from=page', title: 'Current' },
          { url: 'https://chat.deepseek.com/a/chat/s/previous', title: 'Previous' },
        ],
        layout: { historyCount: transient || fallback ? 0 : 2, sidebarMarked: !fallback, pageReady: this.pageReady },
      };
    }
  }
  class FakeView {
    constructor({ webPreferences }) {
      this.webContents = new FakeContents(webPreferences.partition, holdStopLoading);
      this.visible = false;
      this.bounds = null;
      this.backgroundColors = [];
    }
    setBackgroundColor(value) { this.backgroundColors.push(value); }
    setVisible(value) { this.visible = value; }
    setBounds(value) { this.bounds = value; }
  }
  const window = {
    destroyed: false,
    zoomFactor: 1,
    webContents: {
      mainFrame: {},
      getZoomFactor: () => window.zoomFactor,
      send: (channel, payload) => events.push({ channel, payload }),
    },
    contentView: {
      children: [],
      addChildView(view) { this.children.push(view); },
      removeChildView(view) { this.children = this.children.filter(item => item !== view); },
    },
    getContentBounds: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
    setIgnoreMenuShortcuts() {},
    on() {},
    isDestroyed() { return this.destroyed; },
  };
  const fakeSession = {
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    async clearStorageData() { sessions.set('cleared', true); },
  };
  const app = {
    getPath: () => root,
    getName: () => 'Camellia',
  };
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false });
  const manager = createWebSurfaceManager({
    app,
    BrowserWindow: class {},
    WebContentsView: FakeView,
    Menu: {
      buildFromTemplate: template => {
        menuTemplates.push(template);
        return { popup: ({ callback }) => queueMicrotask(() => callback?.()) };
      },
    },
    session: { fromPartition: partition => { if (!sessions.has(partition)) sessions.set(partition, fakeSession); return sessions.get(partition); } },
    shell: { openExternal: async url => external.push(url) },
    ipcMain: {
      handle: (channel, handler) => ipcHandlers.set(channel, handler),
      removeHandler: channel => ipcHandlers.delete(channel),
    },
    nativeTheme,
    getWindow: () => window,
    layoutAssistant,
    log: () => {},
  });
  return { manager, window, sessions, ipcHandlers, events, external, menuTemplates, nativeTheme, root };
}

test('web surface creates a private view, extracts independent history and persists state', async () => {
  const fixture = harness();
  try {
    const shown = await fixture.manager.command('show', {
      provider: 'deepseek',
      bounds: { x: 260, y: 64, width: 1180, height: 836 },
    });
    assert.equal(shown.ok, true);
    assert.equal(fixture.window.contentView.children.length, 1);
    const view = fixture.window.contentView.children[0];
    await until(() => view.visible === true);
    assert.equal(fixture.manager.publicState().ready, true);
    assert.deepEqual(view.bounds, { x: 260, y: 64, width: 1180, height: 836 });
    assert.doesNotMatch(view.webContents.userAgent, /Electron\/|Camellia\//);
    assert.deepEqual(view.backgroundColors, ['#ffffff']);
    fixture.nativeTheme.shouldUseDarkColors = true;
    fixture.nativeTheme.emit('updated');
    assert.equal(view.backgroundColors.at(-1), '#151517');

    const state = await fixture.manager.command('refresh-sessions');
    assert.equal(state.ok, true);
    assert.equal(state.state.sessions.length, 2);
    assert.equal(state.state.activeId, 'current');
    assert.equal(state.state.layout.sidebarMarked, true);
    assert.equal(state.state.layout.status, 'ok');
    assert.ok(fixture.ipcHandlers.has('dsh:web-surface-command'));
    const contentWidth = await fixture.manager.command('content-width', { width: 900 });
    assert.equal(contentWidth.ok, true);
    assert.match(view.webContents.executedScripts.at(-1), /--camellia-chat-content-width/);
    assert.match(view.webContents.executedScripts.at(-1), /900px/);
    assert.equal((await fixture.manager.command('content-width', { width: 20 })).ok, false);
    const providerMenu = await fixture.manager.command('provider-menu', { x: 400, y: 60 });
    assert.equal(providerMenu.ok, true);
    assert.deepEqual(fixture.menuTemplates[0].map(item => item.label), ['DeepSeek Web', 'Kimi Web']);
    assert.equal(fixture.menuTemplates[0][0].checked, true);
    assert.equal((await fixture.manager.command('session-action', {
      sessionId: 'current', action: 'share',
    })).ok, true);
    assert.equal((await fixture.manager.command('session-action', {
      sessionId: 'current', action: 'rename', value: 'Renamed',
    })).ok, true);

    await new Promise(resolve => setTimeout(resolve, 320));
    const saved = JSON.parse(fs.readFileSync(path.join(fixture.root, 'web-sessions.json'), 'utf8'));
    assert.equal(saved.providers.deepseek.sessions.length, 2);
    assert.equal(saved.currentProvider, 'deepseek');

    view.webContents.historyMode = 'transient';
    const manual = await fixture.manager.command('refresh-sessions');
    assert.equal(manual.state.sessions.length, 0);
    assert.equal(manual.state.layout.status, 'error');
  } finally {
    fixture.manager.dispose();
    removeTree(fixture.root);
  }
});

test('a provider view stays hidden until history and layout are ready', async () => {
  const fixture = harness({
    historyMode: 'transient',
    cache: {
      version: 1,
      currentProvider: 'deepseek',
      providers: {
        deepseek: {
          sessions: [{ id: 'previous', title: 'Previous conversation', url: 'https://chat.deepseek.com/a/chat/s/previous' }],
        },
      },
    },
  });
  try {
    await fixture.manager.command('show', {
      provider: 'deepseek',
      bounds: { x: 260, y: 64, width: 900, height: 700 },
    });
    const view = fixture.window.contentView.children[0];
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(view.visible, false);
    assert.equal(fixture.manager.publicState().ready, false);
    view.webContents.historyMode = 'normal';
    await until(() => view.visible === true);
    assert.equal(fixture.manager.publicState().ready, true);
  } finally {
    fixture.manager.dispose();
    removeTree(fixture.root);
  }
});

test('a provider view waits for the document load to stop before revealing', async () => {
  const fixture = harness({ holdStopLoading: true });
  try {
    await fixture.manager.command('show', {
      provider: 'deepseek',
      bounds: { x: 260, y: 64, width: 900, height: 700 },
    });
    const view = fixture.window.contentView.children[0];
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.equal(view.visible, false);
    assert.equal(fixture.manager.publicState().ready, false);
    view.webContents.emit('did-stop-loading');
    await until(() => view.visible === true);
    assert.equal(fixture.manager.publicState().ready, true);
  } finally {
    fixture.manager.dispose();
    removeTree(fixture.root);
  }
});

test('a provider home page reveals from rendered content without waiting for cached history', async () => {
  for (const provider of ['deepseek', 'kimi']) {
    const startUrl = provider === 'kimi' ? 'https://www.kimi.com/' : 'https://chat.deepseek.com/';
    const sessionUrl = provider === 'kimi'
      ? 'https://www.kimi.com/chat/cached'
      : 'https://chat.deepseek.com/a/chat/s/cached';
    const fixture = harness({
      holdStopLoading: true,
      historyMode: 'transient',
      pageReady: true,
      preservePageUrl: true,
      cache: {
        version: 1,
        currentProvider: provider,
        providers: {
          [provider]: {
            sessions: [{ id: 'cached', title: 'Cached', url: sessionUrl }],
          },
        },
      },
    });
    try {
      await fixture.manager.command('show', {
        provider,
        bounds: { x: 260, y: 64, width: 900, height: 700 },
      });
      const view = fixture.window.contentView.children[0];
      await until(() => view.visible === true, 1500);
      assert.equal(fixture.manager.publicState().currentUrl, startUrl);
      assert.equal(fixture.manager.publicState().ready, true);
      assert.equal(fixture.manager.publicState().loading, true);
    } finally {
      fixture.manager.dispose();
      removeTree(fixture.root);
    }
  }
});

test('web view bounds and zoom follow the workbench renderer scale', async () => {
  const fixture = harness();
  try {
    await fixture.manager.command('show', {
      provider: 'deepseek',
      bounds: { x: 100, y: 50, width: 900, height: 700 },
    });
    const view = fixture.window.contentView.children[0];
    fixture.window.zoomFactor = 1.25;
    await fixture.manager.command('bounds', {
      bounds: { x: 100, y: 50, width: 900, height: 700 },
    });
    assert.equal(view.webContents.zoomFactor, 1.25);
    assert.deepEqual(view.bounds, { x: 125, y: 63, width: 1125, height: 837 });
  } finally {
    fixture.manager.dispose();
    removeTree(fixture.root);
  }
});

test('opening a web provider starts at the new-conversation page instead of the cached conversation', async () => {
  const fixture = harness({
    cache: {
      version: 1,
      currentProvider: 'deepseek',
      providers: {
        deepseek: {
          sessions: [{ id: 'previous', title: 'Previous conversation', url: 'https://chat.deepseek.com/a/chat/s/previous' }],
          lastUrl: 'https://chat.deepseek.com/a/chat/s/previous',
          lastTitle: 'Previous conversation',
        },
      },
    },
  });
  try {
    const initial = fixture.manager.publicState();
    assert.equal(initial.currentUrl, 'https://chat.deepseek.com/');
    assert.equal(initial.title, 'DeepSeek Web');
    assert.equal(initial.sessions.length, 1);
    await fixture.manager.command('show', {
      provider: 'deepseek',
      bounds: { x: 260, y: 64, width: 900, height: 700 },
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    const view = fixture.window.contentView.children[0];
    assert.equal(view.webContents.url, 'https://chat.deepseek.com/');
  } finally {
    fixture.manager.dispose();
    removeTree(fixture.root);
  }
});

test('preload opens both provider home pages hidden without changing the active provider', async () => {
  const fixture = harness();
  try {
    const result = fixture.manager.preload();
    assert.equal(result.ok, true);
    assert.deepEqual(result.providers, ['deepseek', 'kimi']);
    assert.equal(fixture.window.contentView.children.length, 2);
    assert.equal(fixture.window.contentView.children.every(view => view.visible === false), true);
    assert.equal(fixture.manager.publicState().provider, 'deepseek');
    assert.deepEqual(
      fixture.window.contentView.children.map(view => view.webContents.url),
      ['https://chat.deepseek.com/', 'https://www.kimi.com/'],
    );
  } finally {
    fixture.manager.dispose();
    removeTree(fixture.root);
  }
});

test('provider menu snapshots the current page before hiding the native view', async () => {
  const fixture = harness();
  try {
    await fixture.manager.command('show', {
      provider: 'deepseek',
      bounds: { x: 260, y: 64, width: 900, height: 700 },
    });
    const view = fixture.window.contentView.children[0];
    await until(() => view.visible === true);
    const frozen = await fixture.manager.command('freeze-menu');
    assert.equal(frozen.ok, true);
    assert.equal(frozen.image, 'data:image/png;base64,capture');
    assert.equal(view.visible, false);
    assert.equal(fixture.manager.publicState().visible, false);
  } finally {
    fixture.manager.dispose();
    removeTree(fixture.root);
  }
});

test('preload verifies both providers while the current Web page is visible', async () => {
  const fixture = harness();
  try {
    await fixture.manager.command('show', {
      provider: 'deepseek',
      bounds: { x: 260, y: 64, width: 900, height: 700 },
    });
    await until(() => fixture.window.contentView.children[0].visible === true);
    const result = fixture.manager.preload();
    assert.equal(result.ok, true);
    assert.deepEqual(result.providers, ['deepseek', 'kimi']);
    assert.equal(fixture.window.contentView.children.length, 2);
    assert.equal(fixture.window.contentView.children[0].visible, true);
    assert.equal(fixture.window.contentView.children[1].visible, false);
    assert.equal(fixture.manager.publicState().provider, 'deepseek');
    assert.deepEqual(
      fixture.window.contentView.children.map(view => view.webContents.url),
      ['https://chat.deepseek.com/', 'https://www.kimi.com/'],
    );
  } finally {
    fixture.manager.dispose();
    removeTree(fixture.root);
  }
});

test('preload retries only a provider whose first load failed', async () => {
  const fixture = harness({ failFirstLoadPartitions: ['persist:camellia-web-kimi'] });
  try {
    const first = fixture.manager.preload();
    assert.deepEqual(first.providers, ['deepseek', 'kimi']);
    await until(() => fixture.window.contentView.children.length === 2);
    const [deepseek, kimi] = fixture.window.contentView.children;
    await until(() => kimi.webContents.loadAttempts === 1);
    assert.equal(kimi.webContents.url, 'https://www.kimi.com/');
    assert.equal(deepseek.webContents.loadAttempts, 1);

    const second = fixture.manager.preload();
    assert.deepEqual(second.providers, ['deepseek', 'kimi']);
    await until(() => kimi.webContents.loadAttempts === 2);
    assert.equal(deepseek.webContents.loadAttempts, 1);
    assert.equal(kimi.webContents.url, 'https://www.kimi.com/');
  } finally {
    fixture.manager.dispose();
    removeTree(fixture.root);
  }
});

test('web surface switches providers without sharing views and rejects foreign navigation', async () => {
  const fixture = harness();
  try {
    await fixture.manager.command('show', { provider: 'deepseek', bounds: { x: 260, y: 64, width: 900, height: 700 } });
    assert.equal(fixture.window.contentView.children[0].webContents.webRTCIPHandlingPolicy, null);
    const selected = await fixture.manager.command('provider', { provider: 'kimi' });
    assert.equal(selected.ok, true);
    assert.equal(fixture.window.contentView.children.length, 2);
    assert.equal(fixture.window.contentView.children[0].visible, false);
    await until(() => fixture.window.contentView.children[1].visible === true);
    assert.equal(
      fixture.window.contentView.children[1].webContents.webRTCIPHandlingPolicy,
      'disable_non_proxied_udp',
    );
    const rejected = await fixture.manager.command('navigate', { url: 'https://example.com/not-allowed' });
    assert.equal(rejected.ok, false);
    const external = await fixture.manager.command('external');
    assert.equal(external.ok, true);
    assert.match(fixture.external[0], /^https:\/\/(www\.)?kimi\.com\//);
  } finally {
    fixture.manager.dispose();
    removeTree(fixture.root);
  }
});

test('provider popups cannot navigate outside the provider and auth allowlist', async () => {
  const fixture = harness();
  try {
    await fixture.manager.command('show', {
      provider: 'kimi',
      bounds: { x: 260, y: 64, width: 900, height: 700 },
    });
    const view = fixture.window.contentView.children[0];
    const child = Object.assign(new EventEmitter(), {
      destroyed: false,
      focus() {},
      setMenuBarVisibility() {},
      isDestroyed() { return this.destroyed; },
    });
    child.webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler(handler) { this.windowOpenHandler = handler; },
    });
    view.webContents.emit('did-create-window', child);

    const allowed = { prevented: false, preventDefault() { this.prevented = true; } };
    child.webContents.emit('will-navigate', allowed, 'https://accounts.google.com/o/oauth2/auth');
    assert.equal(allowed.prevented, false);

    const blocked = { prevented: false, preventDefault() { this.prevented = true; } };
    child.webContents.emit('will-redirect', blocked, 'https://example.com/not-allowed');
    assert.equal(blocked.prevented, true);
    assert.deepEqual(fixture.external, ['https://example.com/not-allowed']);
  } finally {
    fixture.manager.dispose();
    removeTree(fixture.root);
  }
});

test('model-assisted layout repair only accepts a restricted profile', async () => {
  let received = null;
  const fixture = harness({
    layoutAssistant: {
      listModels: () => ['layout-model'],
      complete: async payload => {
        received = payload;
        return '```json\n{"historyAnchorSelector":"a.history-link","titleSelector":".title","css":"[data-hidden]{display:none}"}\n```';
      },
    },
  });
  try {
    await fixture.manager.command('show', { provider: 'deepseek', bounds: { x: 0, y: 0, width: 900, height: 700 } });
    const view = fixture.window.contentView.children[0];
    const models = await fixture.manager.command('layout-models');
    assert.deepEqual(models.models, ['layout-model']);
    const repaired = await fixture.manager.command('repair-layout-model', { model: 'layout-model' });
    assert.equal(repaired.ok, true);
    assert.equal(repaired.proposal.historyAnchorSelector, 'a.history-link');
    assert.equal(repaired.proposal.titleSelector, '.title');
    assert.equal(received.model, 'layout-model');
    assert.match(received.prompt, /Sanitized diagnostics/);
    assert.doesNotMatch(received.prompt, /Conversation text|cookie=/i);
    const diagnosticSource = view.webContents.executedScripts.find(source => source.includes('candidates: [...candidates.values()]'));
    assert.ok(diagnosticSource);
    assert.doesNotMatch(diagnosticSource, /document\.title/);
  } finally {
    fixture.manager.dispose();
    removeTree(fixture.root);
  }
});
