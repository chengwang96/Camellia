'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { settingsWindowSize, settingsWindowBounds, createSettingsWindowSizeCache } = require('../src/main/settings-window-size');

const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8').replace(/\r\n/g, '\n');
const settingsHtml = fs.readFileSync(path.join(__dirname, '../src/renderer/settings/api-settings.html'), 'utf8');
const settingsFrame = fs.readFileSync(path.join(__dirname, '../src/renderer/settings/settings-frame.js'), 'utf8');
const openSettings = /function openSettingsWindow\(target = \{\}\) \{([\s\S]*?)\n\}\n\nfunction createMainWindow/.exec(main)[1];

test('settings opens hidden as a frameless child panel with an interactive owner and is positioned before it is shown', () => {
  assert.match(openSettings, /new BrowserWindow\(\{/);
  assert.match(openSettings, /const preferredSize = settingsWindowSizes\.size;/);
  assert.doesNotMatch(openSettings, /settingsWindowSize\(|getPrimaryDisplay\(/);
  assert.match(openSettings, /\n\s+show: false,\n/);
  assert.match(openSettings, /parent: owner/);
  assert.doesNotMatch(openSettings, /modal: true/);
  assert.match(openSettings, /frame: false/);
  assert.match(openSettings, /transparent: true/);
  assert.match(openSettings, /settingsWindow\.once\('ready-to-show', \(\) => \{[\s\S]*?settingsWindow\.setBounds\([\s\S]*?settingsWindow\.show\(\);/);
});

test('macOS settings has no native rounded frame behind the CSS outline', () => {
  // Evaluate the actual constructor options for each platform. A renderer
  // capture cannot see the AppKit frame that leaks through transparent corners.
  const constructor = /settingsWindow = (new BrowserWindow\(\{[\s\S]*?\n    \}\));/.exec(openSettings)[1];
  for (const [platform, nativeCorners] of [['darwin', false], ['win32', true], ['linux', true]]) {
    const owner = {};
    const options = vm.runInNewContext(constructor, {
      BrowserWindow: class { constructor(options) { return options; } },
      bounds: { x: 80, y: 24, width: 1160, height: 852 }, owner,
      process: { platform }, desktopZoom: () => ({ factor: 1 }),
      path, APP_ROOT: path.resolve(__dirname, '..'), APP_NAME: 'Camellia', __dirname,
    });
    assert.equal(options.roundedCorners, nativeCorners, platform);
    assert.equal(options.frame, false);
    assert.equal(options.transparent, true);
    assert.equal(options.backgroundColor, '#00000000');
    assert.equal(options.parent, owner);
  }
});

test('the native settings material is active before the first stylesheet', () => {
  const boot = '<script src="./settings-frame.js"></script>';
  const script = settingsHtml.indexOf(boot), stylesheet = settingsHtml.indexOf('<link rel="stylesheet"');
  assert.ok(script >= 0 && script < stylesheet, 'window mode must be set by a blocking script before CSS');
  assert.doesNotMatch(settingsHtml, /settings-frame\.js" defer/);
  const material = settingsFrame.indexOf("document.documentElement.dataset.settingsWindow = ''");
  const domWiring = settingsFrame.indexOf("document.getElementById('closeSettings')");
  assert.ok(material >= 0 && material < domWiring, 'the transparent rounded material must precede DOM setup');
  assert.match(settingsFrame, /document\.readyState === 'loading'\) document\.addEventListener\('DOMContentLoaded', initialize/);
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
  assert.match(ready, /settingsWindowSizes\.start\(\);\n\s+windowChrome\.start\(\);\n\s+try \{ await networkSettings\(\)\.initialize\(\);/);
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

test('the main window stays hidden until ready and when launched in the background', () => {
  const createMain = /function createMainWindow\(\) \{([\s\S]*?)\n\}/.exec(main)[1];
  assert.match(createMain, /\n    show: false,\n/);
  assert.match(createMain, /mainWindow\.once\('ready-to-show', \(\) => \{ if \(!backgroundLaunch\) mainWindow\.show\(\); \}\);/);
});

test('native caption painting is yielded before the backdrop and refreshed before modal construction', async () => {
  const source = /async function setSettingsBackdrop\(owner, visible\) \{[\s\S]*?\n\}/.exec(main)[0];
  const owner = {}, order = [];
  const contents = {
    send: (channel, visible) => order.push(['send', channel, visible]),
    executeJavaScript: async script => { order.push(['paint', script]); },
  };
  const setBackdrop = new Function('windowChrome', 'liveWebContents', 'log', 'setImmediate', `return ${source}`)(
    { setDimmed: (current, visible) => { assert.equal(current, owner); order.push(['dim', visible]); } },
    current => current === owner ? contents : null,
    () => {},
    callback => { order.push(['yield']); callback(); });

  await setBackdrop(owner, true);
  assert.deepEqual(order, [
    ['dim', true], ['yield'], ['send', 'dsh:settings-overlay', true], ['paint', 'window.paintSettingsBackdrop?.()'],
  ]);
  const refresh = openSettings.indexOf('windowChrome.setDimmed(owner, true)');
  const yieldBeforeModal = openSettings.indexOf('await new Promise(resolve => setImmediate(resolve))', refresh);
  const construct = openSettings.indexOf('settingsWindow = new BrowserWindow');
  assert.ok(refresh > 0 && yieldBeforeModal > refresh && construct > yieldBeforeModal);

  order.length = 0;
  await setBackdrop(owner, false);
  assert.deepEqual(order, [['dim', false], ['send', 'dsh:settings-overlay', false]]);
});

// Exercise the production lifecycle with controllable focus and an unfinished
// save. Hidden Electron windows cannot exercise Windows foreground ownership.
async function settingsCloseFixture() {
  const actions = [], timers = [];
  let finishSave;
  class Window extends EventEmitter {
    constructor() {
      super();
      this.visible = true; this.minimized = false; this.focused = false; this.destroyed = false;
      this.webContents = { isLoading: () => false, send() {}, isDestroyed: () => this.destroyed };
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    isFocused() { return this.focused; }
    getContentBounds() { return { x: 0, y: 0, width: 1320, height: 900 }; }
    setMenu() {}
    setBounds() {}
    show() { this.visible = true; }
    restore() { actions.push('restore'); this.minimized = false; }
    focus() {
      actions.push(this === owner ? 'focus-owner' : 'focus-settings');
      owner.focused = false; context.settingsWindow.focused = false;
      this.focused = true; this.emit('focus');
    }
    loadFile() {}
    close() {
      const event = { preventDefault() { this.defaultPrevented = true; } };
      this.emit('close', event);
      if (event.defaultPrevented) return;
      actions.push('close-settings'); this.destroyed = true; this.focused = false;
      this.emit('closed');
    }
  }
  const owner = new Window();
  const context = vm.createContext({
    mainWindow: owner, settingsWindow: null, settingsOpening: null, settingsCloseReady: false,
    settingsShowReady: false, appQuitting: false, nativeSettingsView: null, nativeSettingsLoad: null,
    BrowserWindow: Window, settingsWindowSizes: { size: { width: 1160, height: 860 } }, settingsWindowBounds,
    setSettingsBackdrop: async () => {}, windowChrome: { setDimmed() {} },
    flushSettingsWindow: () => new Promise(resolve => { finishSave = resolve; }),
    attachExternalNavigation() {}, desktopZoom: () => ({ factor: 1, attach() {} }),
    cliDevices: { detach() {} }, liveWebContents: () => null, shell: {}, log() {},
    setImmediate, setTimeout: callback => timers.push(callback),
    path, APP_ROOT: path.resolve(__dirname, '..'), APP_NAME: 'Camellia', RENDERER_ROOT: __dirname,
    __dirname, process: { platform: 'win32' },
  });
  vm.runInContext(`function openSettingsWindow(target = {}) {${openSettings}\n}`, context);
  context.openSettingsWindow();
  for (let attempt = 0; !context.settingsWindow && attempt < 20; attempt++) await new Promise(setImmediate);
  assert.ok(context.settingsWindow, 'settings constructor must complete');
  const settings = context.settingsWindow;
  settings.emit('ready-to-show');
  return { owner, settings, actions, timers, context,
    async save(ok = true) { finishSave(ok); await new Promise(setImmediate); } };
}

test('closing settings after switching away and back hands focus to the visible owner before destroying the child', async () => {
  const f = await settingsCloseFixture();
  f.settings.focused = false; f.settings.emit('blur'); // Another application.
  assert.equal(f.settings.isDestroyed(), false);
  f.settings.focus(); // Return to Camellia through Settings, not its owner.
  f.actions.length = 0;
  f.settings.close();
  assert.equal(f.settings.isDestroyed(), false, 'saving must finish first');
  await f.save();
  assert.deepEqual(f.actions, ['focus-owner', 'close-settings']);
  assert.equal(f.owner.isFocused(), true);
  assert.equal(f.owner.listenerCount('focus'), 0, 'handoff must not re-enter dismissal');
  f.owner.focused = false; // Switching away after dismissal must remain possible.
  f.owner.minimized = true;
  for (const timer of f.timers) timer();
  assert.deepEqual(f.actions, ['focus-owner', 'close-settings'], 'no delayed foreground activation');
  assert.equal(f.owner.isMinimized(), true, 'a subsequent minimize is preserved');
});

test('settings never activates the owner if the user switches away while saving', async () => {
  const f = await settingsCloseFixture();
  f.settings.focused = true;
  f.settings.close();
  f.settings.focused = false;
  await f.save();
  assert.deepEqual(f.actions, ['close-settings']);
});

test('settings close respects hidden/minimized owners and application shutdown', async () => {
  for (const state of ['hidden', 'minimized', 'destroyed', 'quitting', 'background']) {
    const f = await settingsCloseFixture();
    f.settings.focused = true;
    if (state === 'hidden') f.owner.visible = false;
    if (state === 'minimized') f.owner.minimized = true;
    if (state === 'destroyed') f.owner.destroyed = true;
    if (state === 'quitting') f.context.appQuitting = true;
    if (state === 'background') f.settings.focused = false;
    f.settings.close();
    await f.save();
    for (const timer of f.timers) timer();
    assert.deepEqual(f.actions, ['close-settings'], state);
  }
});

test('hiding or minimizing the workbench during a pending save is preserved', async () => {
  for (const state of ['hidden', 'minimized']) {
    const f = await settingsCloseFixture();
    f.settings.focused = true;
    f.settings.close();
    if (state === 'hidden') f.owner.visible = false;
    else f.owner.minimized = true;
    await f.save();
    for (const timer of f.timers) timer();
    assert.deepEqual(f.actions, ['close-settings'], state);
  }
});

test('owner caption dismissal stays focused without a redundant activation or repeated save', async () => {
  const f = await settingsCloseFixture();
  f.owner.focus();
  await f.save();
  assert.deepEqual(f.actions, ['focus-owner', 'close-settings']);
  assert.equal(f.owner.isFocused(), true);
  assert.equal(f.owner.listenerCount('focus'), 0);
});

test('failed saves keep settings open and a later successful close returns focus to its owner', async () => {
  const f = await settingsCloseFixture();
  f.settings.focused = true;
  f.settings.close();
  await f.save(false);
  assert.equal(f.settings.isDestroyed(), false);
  assert.equal(f.settings.isFocused(), true);
  f.actions.length = 0;
  f.settings.close();
  await f.save();
  assert.deepEqual(f.actions, ['focus-owner', 'close-settings']);
});
