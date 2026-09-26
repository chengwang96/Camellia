'use strict';

const path = require('node:path');
const { EmbeddedNetwork } = require('./embedded-network');
const { createRemoteService } = require('./service');

function createRemoteDesktop({ app, BrowserWindow, ipcMain, nativeTheme, manager, rendererRoot, loadConfig, getSettingsWindow = () => null, networkFactory, apiRoutes = null }) {
  let window = null;
  const service = createRemoteService({ dataDir: app.getPath('userData'), manager, apiRoutes,
    preferences: () => ({ closeToTray: loadConfig().closeToTray === true, theme: loadConfig().theme || 'system', language: loadConfig().language || 'zh-CN' }),
    networkFactory: ({ onFailure }) => {
      const options = { app, onFailure };
      return networkFactory ? networkFactory(options) : new EmbeddedNetwork({ ...options,
        safeStorage: require('electron').safeStorage, openExternal: url => require('electron').shell.openExternal(url) });
    } });
  ipcMain.handle('dsh:remote-control', async (event, { action, payload } = {}) => {
    const settings = getSettingsWindow();
    const authorized = [window, settings].some(candidate => candidate && !candidate.isDestroyed() && event.sender === candidate.webContents && event.senderFrame === candidate.webContents.mainFrame);
    if (!authorized) return { ok: false, error: 'Local remote-access or settings window required' };
    return service.command(action, payload);
  });
  ipcMain.handle('dsh:open-mobile-access', event => {
    const settings = getSettingsWindow();
    if (!settings || settings.isDestroyed() || event.sender !== settings.webContents || event.senderFrame !== settings.webContents.mainFrame) {
      return { ok: false, error: 'Local settings window required' };
    }
    try { controller.open(); return { ok: true }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
  const controller = {
    startTrustedDevices: () => service.startTrustedDevices(),
    open() {
      if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
      window = new BrowserWindow({ width: 640, height: 760, minWidth: 480, minHeight: 520,
        title: 'Mobile access — Camellia', autoHideMenuBar: true,
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#151517' : '#ffffff',
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.on('closed', () => { window = null; });
      void window.loadFile(path.join(rendererRoot, 'remote/remote.html'));
    },
    publish: () => service.publish(),
    close: () => service.close(),
  };
  return controller;
}

module.exports = { createRemoteDesktop };
