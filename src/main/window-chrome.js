'use strict';

const { liveWebContents } = require('./live-web-contents');

const TITLEBAR_HEIGHT = 40;

// Windows keeps its native caption buttons, resize edges, snap menu and drag
// behavior. Only the application menus move into the renderer's caption row.
function createWindowChrome({ ipcMain, Menu, nativeTheme, loadConfig, translate, platform = process.platform }) {
  const windows = new Set();
  const dimmed = new WeakSet();
  const enabled = platform === 'win32';
  function palette(window) {
    const dark = nativeTheme.shouldUseDarkColors;
    const colors = dark ? { color: '#151517', symbolColor: '#cfd3d6' } : { color: '#ffffff', symbolColor: '#61666b' };
    if (!dimmed.has(window)) return colors;
    // Match --dsw-alias-bg-mask-1 in ui-theme.css. The renderer's backdrop
    // cannot cover Windows caption buttons, so composite their colors too.
    const alpha = dark ? 0x80 : 0x3d;
    return Object.fromEntries(Object.entries(colors).map(([key, color]) => [key,
      '#' + color.slice(1).match(/../g).map(channel => Math.round(parseInt(channel, 16) * (255 - alpha) / 255)
        .toString(16).padStart(2, '0')).join('')]));
  }
  function options() {
    return enabled ? { titleBarStyle: 'hidden', titleBarOverlay: { ...palette(), height: TITLEBAR_HEIGHT }, autoHideMenuBar: false } : {};
  }
  function state(window) {
    const language = loadConfig().language;
    return { enabled: true, height: window.isFullScreen() ? 0 : TITLEBAR_HEIGHT,
      zoomFactor: window.webContents.getZoomFactor(), theme: loadConfig().theme || 'system',
      label: translate('Application menu', language),
      menus: (Menu.getApplicationMenu()?.items || []).map((item, index) => ({ index, label: item.label })) };
  }
  function publish(window) {
    const contents = liveWebContents(window);
    if (!contents) return;
    window.setMenuBarVisibility(false);
    window.setTitleBarOverlay({ ...palette(window), height: TITLEBAR_HEIGHT });
    contents.send('camellia:window-chrome', state(window));
  }
  function owner(event) {
    return [...windows].find(window => {
      const contents = liveWebContents(window);
      return contents && event.sender === contents && event.senderFrame === contents.mainFrame;
    });
  }
  ipcMain.handle('camellia:window-chrome-state', event => {
    const window = owner(event);
    return window ? state(window) : { enabled: false };
  });
  ipcMain.handle('camellia:window-chrome-menu', (event, payload) => {
    const window = owner(event);
    if (!window || !Number.isInteger(payload?.index) || !Number.isFinite(payload.x) || !Number.isFinite(payload.y)) return { ok: false };
    const menu = Menu.getApplicationMenu()?.items[payload.index]?.submenu;
    if (!menu) return { ok: false };
    const zoom = window.webContents.getZoomFactor(), bounds = window.getContentBounds();
    return new Promise(resolve => menu.popup({ window,
      x: Math.round(Math.max(0, Math.min(bounds.width, payload.x * zoom))),
      y: Math.round(Math.max(0, Math.min(bounds.height, payload.y * zoom))),
      callback: () => resolve({ ok: true }) }));
  });
  return {
    options,
    setDimmed(window, value) {
      if (!windows.has(window)) return;
      if (value) dimmed.add(window); else dimmed.delete(window);
      publish(window);
    },
    start() { if (enabled) nativeTheme.on('updated', () => this.refresh()); },
    attach(window) {
      if (!enabled) return;
      windows.add(window);
      window.setMenuBarVisibility(false);
      window.webContents.on('dom-ready', () => publish(window));
      let menuKey = null;
      window.webContents.on('before-input-event', (event, input) => {
        // Do not let Alt reveal the old native menu on a second row.
        const focusKey = ['Alt', 'F10'].includes(input.key) && !input.shift && !input.control && !input.meta;
        if (focusKey) {
          event.preventDefault();
          if (input.type === 'keyDown') menuKey = input.key;
          else if (input.type === 'keyUp' && menuKey === input.key) {
            menuKey = null; window.webContents.send('camellia:window-chrome-focus');
          }
        } else if (input.type === 'keyDown') menuKey = null;
      });
      for (const event of ['enter-full-screen', 'leave-full-screen']) window.on(event, () => publish(window));
      window.once('closed', () => windows.delete(window));
    },
    refresh() { for (const window of windows) publish(window); },
  };
}

module.exports = { createWindowChrome, TITLEBAR_HEIGHT };
