'use strict';

const path = require('node:path');
const { RemoteAccess } = require('./access');
const { RemoteReadModel } = require('./read-model');
const { RemoteGateway } = require('./gateway');
const { RemoteCommands } = require('./commands');
const { randomBytes } = require('node:crypto');
const { EmbeddedNetwork } = require('./embedded-network');

function createRemoteDesktop({ app, BrowserWindow, ipcMain, nativeTheme, manager, rendererRoot, loadConfig, getSettingsWindow = () => null, networkFactory, apiRoutes = null }) {
  let window = null, gateway = null, access = null, busy = false, network = null, enabled = false, closed = false;
  let startupChecked = false, monitor = null;
  const reader = new RemoteReadModel(manager);
  function initialize() {
    if (gateway) return;
    access = new RemoteAccess({ file: path.join(app.getPath('userData'), 'remote', 'devices.json'), onRevoke: id => gateway.revoke(id) });
    const commands = new RemoteCommands({ file: path.join(app.getPath('userData'), 'remote', 'commands.json'), reader, access, publish: () => gateway.publish() });
    gateway = new RemoteGateway({ access, reader, commands, apiRoutes });
    const options = { app, onFailure: () => { enabled = false; void gateway.stop(); } };
    network = networkFactory ? networkFactory(options) : new EmbeddedNetwork({ ...options,
      safeStorage: require('electron').safeStorage, openExternal: url => require('electron').shell.openExternal(url) });
  }
  function state() {
    return { running: Boolean(gateway?.server), enabled, network: { ...network.snapshot }, address: gateway?.url || null, ...access.view(), workspaces: reader.workspaces(),
      closeToTray: loadConfig().closeToTray === true, theme: loadConfig().theme || 'system', language: loadConfig().language || 'zh-CN' };
  }
  async function refreshNetwork() {
    if (!enabled) return;
    const status = await network.status();
    if (!enabled || closed) return;
    if (status.state !== 'Running' || !status.address) {
      if (gateway.server) { enabled = false; await network.stop(); await gateway.stop(); }
      return;
    }
    if (gateway.server) {
      if (gateway.url !== `http://${status.address}:43127`) { enabled = false; await network.stop(); await gateway.stop(); }
      return;
    }
    try {
      const token = randomBytes(32).toString('hex');
      await gateway.start('127.0.0.1', 0, { address: status.address, token });
      if (!enabled || closed) { await gateway.stop(); return; }
      await network.listen(`http://127.0.0.1:${gateway.server.address().port}`, token);
    } catch (error) { enabled = false; await network.stop(); await gateway.stop(); throw error; }
  }
  async function startAccess(interactive) {
    try {
      enabled = true;
      await network.start();
      if (closed || !enabled) { await network.stop(); return; }
      const status = await network.status();
      if (closed || !enabled) { await network.stop(); return; }
      if (interactive && status.state === 'NeedsLogin') await network.login();
      await refreshNetwork();
      scheduleMonitor();
    } catch (error) {
      enabled = false;
      await network.stop(); await gateway.stop();
      network.snapshot.state = 'Error';
      throw error;
    }
  }
  function scheduleMonitor() {
    clearTimeout(monitor);
    if (closed) return;
    monitor = setTimeout(async () => {
      if (enabled && !busy) {
        busy = true;
        try { await refreshNetwork(); }
        catch { enabled = false; await network.stop(); await gateway.stop(); network.snapshot.state = 'Error'; }
        finally { busy = false; }
      }
      scheduleMonitor();
    }, enabled && !gateway?.server ? 250 : 5000);
    monitor.unref();
  }
  scheduleMonitor();
  ipcMain.handle('dsh:remote-control', async (event, { action, payload } = {}) => {
    const settings = getSettingsWindow();
    const authorized = [window, settings].some(candidate => candidate && !candidate.isDestroyed() && event.sender === candidate.webContents && event.senderFrame === candidate.webContents.mainFrame);
    if (!authorized) return { ok: false, error: 'Local remote-access or settings window required' };
    if (closed) return { ok: false, error: 'Camellia is closing' };
    if (busy) return action === 'state' && access ? { ok: true, result: state() } : { ok: false, error: 'Please wait for the current operation' };
    busy = true;
    try {
      initialize();
      let result;
      if (action === 'state') { await refreshNetwork(); result = state(); }
      else if (action === 'start') {
        await startAccess(true); result = state();
      }
      else if (action === 'login') { if (!enabled) throw new Error('Enable mobile access first'); await network.login(); result = state(); }
      else if (action === 'open-login') { if (!enabled) throw new Error('Enable mobile access first'); await network.openLogin(); result = state(); }
      else if (action === 'stop' || action === 'logout') {
        enabled = false;
        await gateway.stop();
        try { if (action === 'logout') await network.logout(); }
        finally { await network.stop(); }
        result = state();
      }
      else if (action === 'invite' || action === 'scope') {
        if (action === 'invite' && !gateway.server) throw new Error('Enable remote access first');
        const options = { allWorkspaces: true, includeUnassigned: true };
        if (action === 'scope') { access.setScope(payload?.id, [], options); result = state(); }
        else result = { ...access.invite([], options), address: gateway.url };
      } else if (action === 'approve') {
        const request = access.pending.get(payload?.id);
        if (!request || (!request.allWorkspaces && request.workspaceIds.some(id => !reader.workspaces().some(workspace => workspace.id === id)))) throw new Error('The workspace selection is no longer available');
        access.approve(payload.id); result = state();
      } else if (action === 'reject') { access.reject(payload?.id); result = state(); }
      else if (action === 'revoke') { access.revoke(payload?.id); result = state(); }
      else throw new Error('Unsupported remote-access action');
      return { ok: true, result };
    } catch (error) { return { ok: false, error: error.message }; }
    finally { busy = false; }
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
    async startTrustedDevices() {
      if (startupChecked || closed) return;
      startupChecked = true;
      if (busy || enabled) return;
      busy = true;
      try {
        initialize();
        if (!access.devices.some(device => typeof device.id === 'string' && device.id
          && typeof device.tokenDigest === 'string' && /^[a-f0-9]{64}$/.test(device.tokenDigest))) return;
        await startAccess(false);
      } finally { busy = false; }
    },
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
    publish() { gateway?.publish(); },
    async close() { closed = true; enabled = false; clearTimeout(monitor); await network?.stop(); await gateway?.stop(); },
  };
  return controller;
}

module.exports = { createRemoteDesktop };
