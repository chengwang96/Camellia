'use strict';

const path = require('node:path');
const { EmbeddedNetwork, bundleDirectory } = require('./embedded-network');
const { createRemoteService } = require('./service');
const { createLanFirewall } = require('./lan-firewall');
const { createMacLanPermissions } = require('./mac-lan-permissions');
const { createTailnetUpdates } = require('./tailnet-updates');

function createRemoteDesktop({ app, BrowserWindow, ipcMain, nativeTheme, windowChrome, manager, rendererRoot, loadConfig, getSettingsWindow = () => null, getMainWindow = () => null, networkFactory, apiRoutes = null, getDiscussions = null,
  computerName = () => '', saveComputerName = () => {}, networkHostname, downloadConnection, createUpdates = createTailnetUpdates, assertTailnetUpdateAllowed = () => {},
  prepareRestart = async () => {}, accountUsage = null, guard = null, log = () => {} }) {
  let window = null, tailnetOperation = false;
  const updates = createUpdates({ bundle: bundleDirectory(app), dataDir: app.getPath('userData'), connection: downloadConnection });
  const updatingTailnet = () => tailnetOperation;
  // Pairing stores the display name on the invitation; an explicit edit stores it
  // as a local preference. Both funnel through here so the snapshot is never empty.
  const setComputerName = value => {
    const saved = typeof value === 'string' ? saveComputerName(value) : undefined;
    return typeof saved === 'string' && saved ? saved : computerName() || 'Camellia desktop';
  };
  const desktopRestart = require('./desktop-restart').createDesktopRestart({ file: path.join(app.getPath('userData'), 'remote', 'desktop-restarts.json'),
    prepare: prepareRestart, restart: () => { app.relaunch(); app.quit(); }, log });
  const service = createRemoteService({ dataDir: app.getPath('userData'), manager, apiRoutes, setComputerName, getDiscussions, desktopRestart, accountUsage, guard, log,
    lanFirewall: createLanFirewall(),
    macLanPermissions: createMacLanPermissions({ openExternal: url => require('electron').shell.openExternal(url) }),
    safeStorage: require('electron').safeStorage, openExternal: url => require('electron').shell.openExternal(url),
    preferences: () => ({ closeToTray: loadConfig().closeToTray === true, theme: loadConfig().theme || 'system', language: loadConfig().language || 'zh-CN',
      computerName: computerName() }),
    networkFactory: ({ onFailure, ...rest }) => {
      // The service supplies the saved hostname; keep it for the default
      // EmbeddedNetwork constructor instead of dropping it with extra options.
      const options = { ...rest, app, onFailure, executable: updates.executable,
        hostname: networkHostname ?? rest.hostname };
      return networkFactory ? networkFactory(options) : new EmbeddedNetwork({ ...options,
        safeStorage: require('electron').safeStorage, openExternal: url => require('electron').shell.openExternal(url) });
    } });
  async function installTailnet() {
    assertTailnetUpdateAllowed();
    const result = await updates.operate('tailnet-update-install');
    if (!result.pending) return result;
    assertTailnetUpdateAllowed();
    const installed = updates.pendingInstallation();
    return service.restartNetwork(installed.executable, remote => ({
      ...updates.activate(), updated: installed.version, reconnected: remote.running,
    }));
  }
  ipcMain.handle('dsh:remote-control', async (event, { action, payload } = {}) => {
    const settings = getSettingsWindow();
    const authorized = [window, settings].some(candidate => candidate && !candidate.isDestroyed() && event.sender === candidate.webContents && event.senderFrame === candidate.webContents.mainFrame);
    if (!authorized) return { ok: false, error: 'Local remote-access or settings window required' };
    const inSettings = settings && !settings.isDestroyed() && event.sender === settings.webContents;
    if (inSettings && ['tailnet-update-check', 'tailnet-update-install'].includes(action)) {
      if (updatingTailnet()) return { ok: false, error: 'An embedded network update is already in progress' };
      tailnetOperation = true;
      try {
        const result = action === 'tailnet-update-install' ? await installTailnet() : await updates.operate(action);
        return { ok: true, result };
      } catch (error) { return { ok: false, error: error.message }; }
      finally { tailnetOperation = false; }
    }
    const response = await service.command(action, payload);
    if (inSettings && action === 'state' && response.ok) {
      const status = await updates.operate('tailnet-update-status');
      response.result.tailnetUpdate = { ...status, busy: updatingTailnet() };
    }
    return response;
  });
  ipcMain.handle('dsh:open-mobile-access', event => {
    const authorized = [getMainWindow(), getSettingsWindow()].some(candidate => candidate && !candidate.isDestroyed()
      && event.sender === candidate.webContents && event.senderFrame === candidate.webContents.mainFrame);
    if (!authorized) {
      return { ok: false, error: 'Local desktop or settings window required' };
    }
    try { controller.open(); return { ok: true }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
  const controller = {
    startTrustedDevices: () => service.startTrustedDevices(),
    updateHostname: name => service.updateHostname(name),
    updatingTailnet,
    attachmentReferences: () => service.attachmentReferences(),
    attachmentRevision: () => service.attachmentRevision(),
    attachmentsChanged: () => service.attachmentsChanged(),
    maintainAttachments: (cleanup, log) => service.maintainAttachments(cleanup, log),
    open() {
      if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
      const created = new BrowserWindow({ width: 640, height: 760, minWidth: 480, minHeight: 520,
        // Hidden until the first paint, otherwise the window briefly appears at
        // the OS default position before moving to its final place.
        show: false, center: true,
        title: 'Mobile access — Camellia', autoHideMenuBar: true,
        ...windowChrome?.options(),
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#151517' : '#ffffff',
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
      window = created;
      windowChrome?.attach(created);
      created.once('ready-to-show', () => { if (!created.isDestroyed()) created.show(); });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.on('closed', () => { window = null; });
      void window.loadFile(path.join(rendererRoot, 'remote/remote.html'));
    },
    publish: update => service.publish(update),
    close: () => service.close(),
  };
  return controller;
}

module.exports = { createRemoteDesktop };
