'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWindowChrome } = require('../src/main/window-chrome');
const { translate } = require('../src/shared/i18n');

function fixture(platform = 'win32') {
  const handlers = new Map(), sent = [], popups = [];
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false });
  const config = { language: 'en', theme: 'system' };
  const menu = { items: ['Application', 'Edit'].map(label => ({ label, submenu: {
    popup(options) { popups.push(options); options.callback(); },
  } })) };
  const chrome = createWindowChrome({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    Menu: { getApplicationMenu: () => menu }, nativeTheme, loadConfig: () => config, translate, platform });
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, getZoomFactor: () => 1.25,
    send: (channel, state) => sent.push({ channel, state }) });
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false,
    isFullScreen: () => false, getContentBounds: () => ({ width: 1000, height: 700 }),
    setMenuBarVisibility(value) { this.menuVisible = value; }, setTitleBarOverlay(value) { this.overlay = value; } });
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const call = (name, payload, sender = event) => handlers.get('camellia:window-chrome-' + name)(sender, payload);
  chrome.start(); chrome.attach(window);
  return { chrome, call, config, nativeTheme, window, sent, popups, menu };
}

test('Windows caption matches the workspace and tracks theme, locale and fullscreen without a second menu row', () => {
  const f = fixture();
  assert.deepEqual(f.chrome.options(), { titleBarStyle: 'hidden', titleBarOverlay: { color: '#ffffff', symbolColor: '#61666b', height: 40 }, autoHideMenuBar: false });
  assert.equal(f.window.menuVisible, false);
  f.config.language = 'zh-CN'; f.nativeTheme.shouldUseDarkColors = true;
  f.nativeTheme.emit('updated');
  assert.equal(f.window.overlay.color, '#151517');
  assert.equal(f.call('state').label, '应用菜单');
  assert.equal(f.call('state').zoomFactor, 1.25);
  f.window.isFullScreen = () => true;
  f.window.emit('enter-full-screen');
  assert.equal(f.sent.at(-1).state.height, 0);
  f.window.isFullScreen = () => false;
  f.window.emit('leave-full-screen');
  assert.equal(f.sent.at(-1).state.height, 40);
});

test('a modal backdrop dims native caption backgrounds and symbols, follows theme changes and restores on close', () => {
  const f = fixture();
  f.chrome.setDimmed(f.window, true);
  assert.deepEqual(f.window.overlay, { color: '#c2c2c2', symbolColor: '#4a4e51', height: 40 });
  f.chrome.refresh();
  assert.equal(f.window.overlay.color, '#c2c2c2', 'menu refresh must retain the backdrop color');
  f.nativeTheme.shouldUseDarkColors = true;
  f.nativeTheme.emit('updated');
  assert.deepEqual(f.window.overlay, { color: '#0a0a0b', symbolColor: '#67696b', height: 40 });
  f.chrome.setDimmed(f.window, false);
  assert.deepEqual(f.window.overlay, { color: '#151517', symbolColor: '#cfd3d6', height: 40 });
  f.nativeTheme.shouldUseDarkColors = false;
  f.nativeTheme.emit('updated');
  assert.deepEqual(f.window.overlay, { color: '#ffffff', symbolColor: '#61666b', height: 40 });
});

test('caption dimming is scoped to its modal owner and ignores unavailable native surfaces', () => {
  const f = fixture();
  const otherContents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false,
    getZoomFactor: () => 1, send() {} });
  const other = Object.assign(new EventEmitter(), { webContents: otherContents, isDestroyed: () => false,
    isFullScreen: () => false, getContentBounds: f.window.getContentBounds,
    setMenuBarVisibility: f.window.setMenuBarVisibility, setTitleBarOverlay: f.window.setTitleBarOverlay });
  f.chrome.attach(other);
  f.chrome.setDimmed(f.window, true); f.chrome.refresh();
  assert.equal(f.window.overlay.color, '#c2c2c2');
  assert.equal(other.overlay.color, '#ffffff', 'another desktop window has no modal backdrop');
  f.window.webContents.isDestroyed = () => true;
  assert.doesNotThrow(() => f.chrome.setDimmed(f.window, false), 'parent contents may be disposed before its modal closes');
  assert.doesNotThrow(() => f.chrome.refresh());
  f.chrome.setDimmed({}, true);
  for (const platform of ['darwin', 'linux']) {
    const native = fixture(platform);
    native.chrome.setDimmed(native.window, true);
    assert.equal(native.window.overlay, undefined);
  }
});

test('menu popups target the requesting window and convert page coordinates at non-default zoom', async () => {
  const f = fixture();
  assert.deepEqual(await f.call('menu', { index: 1, x: 80, y: 30 }), { ok: true });
  assert.equal(f.popups[0].window, f.window);
  assert.equal(f.popups[0].x, 100);
  assert.equal(f.popups[0].y, 38);
  assert.deepEqual(await f.call('menu', { index: 100, x: 0, y: 0 }), { ok: false });
  assert.deepEqual(await f.call('menu', { index: 0, x: NaN, y: 0 }), { ok: false });
});

test('subframes, foreign windows and closed windows cannot open application menus', () => {
  const f = fixture(), payload = { index: 0, x: 0, y: 30 };
  for (const sender of [{ sender: f.window.webContents, senderFrame: {} }, { sender: {}, senderFrame: {} }]) {
    assert.deepEqual(f.call('state', null, sender), { enabled: false });
    assert.deepEqual(f.call('menu', payload, sender), { ok: false });
  }
  f.window.emit('closed');
  assert.deepEqual(f.call('state'), { enabled: false });
  f.chrome.refresh();
  assert.equal(f.sent.length, 0);
});

test('Alt and F10 focus the custom menu while macOS and Linux keep their native frame', () => {
  const f = fixture();
  let prevented = 0;
  for (const key of ['Alt', 'F10']) for (const type of ['keyDown', 'keyUp'])
    f.window.webContents.emit('before-input-event', { preventDefault: () => prevented++ }, { key, type });
  assert.equal(prevented, 4);
  assert.equal(f.sent.filter(event => event.channel === 'camellia:window-chrome-focus').length, 2);
  for (const input of [{key:'Alt',type:'keyDown'}, {key:'x',type:'keyDown',alt:true}, {key:'Alt',type:'keyUp'}])
    f.window.webContents.emit('before-input-event', { preventDefault() {} }, input);
  assert.equal(f.sent.filter(event => event.channel === 'camellia:window-chrome-focus').length, 2, 'Alt combinations do not steal composer focus');
  for (const platform of ['darwin', 'linux']) {
    const native = fixture(platform);
    assert.deepEqual(native.chrome.options(), {});
    assert.deepEqual(native.call('state'), { enabled: false });
    assert.equal(native.nativeTheme.listenerCount('updated'), 0);
  }
});
