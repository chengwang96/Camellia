'use strict';

const path = require('node:path');
const { EmbeddedNetwork } = require('./embedded-network');
const { DeviceClient } = require('./device-client');
const { createApiImportClient } = require('./api-import-client');
const { readAttachment, bufferAttachments, createAttachmentTray, downloadName, saveDownload } = require('./device-files');
const { randomUUID } = require('node:crypto');

function createDevicesDesktop({ app, ipcMain, BrowserWindow, safeStorage, shell, dialog, nativeImage, getSettingsWindow, getSurfaces = () => [], openSettings, authorizedSender, loadConfig, apiSource,
  networkFactory = ({ onFailure }) => new EmbeddedNetwork({ app, safeStorage, directory: path.join(app.getPath('userData'), 'remote', 'tailnet'),
    openExternal: url => shell.openExternal(url), onFailure }), clientFactory = options => new DeviceClient(options) }) {
  let network = null, client = null, imports = null, closed = false, generation = 0;
  const windows = new Map(), serverContents = new Map(), busySenders = new Set(), trays = new Map(), surfaceVersions = new WeakMap();
  const watches = new Map();
  const downloads = new Map();
  function cancelDownloads() { for (const entry of downloads.values()) entry.abort.abort(); }
  function settingsSurfaces() {
    try { return getSurfaces().filter(contents => contents && !contents.isDestroyed()); }
    catch (error) {
      if (/Object has been destroyed/i.test(error.message)) return [];
      throw error;
    }
  }
  const surfaces = () => [...settingsSurfaces(), ...serverContents.keys()].filter(contents => !contents.isDestroyed());
  const trustedSurface = contents => Boolean(contents && !contents.isDestroyed() && (serverContents.has(contents) || settingsSurfaces().includes(contents)));
  function mainFrame(event) {
    if (!event.sender || event.sender.isDestroyed()) return false;
    try { return event.senderFrame === event.sender.mainFrame; }
    catch (error) { if (/Object has been destroyed|frame was disposed/i.test(error.message)) return false; throw error; }
  }
  const authorized = event => mainFrame(event) && trustedSurface(event.sender);
  const mayOpen = contents => Boolean(contents && !contents.isDestroyed() && (trustedSurface(contents) || authorizedSender?.(contents)));
  const broadcast = (channel, payload) => { for (const contents of surfaces()) { try { contents.send(channel, payload); } catch { /* consumer closed */ } } };
  function stopWatches(owner) {
    for (const [key, entry] of watches) if (!owner || entry.owner === owner) { entry.abort.abort(); watches.delete(key); }
  }
  function detachSurface(owner) {
    surfaceVersions.set(owner, (surfaceVersions.get(owner) || 0) + 1);
    stopWatches(owner); trays.get(owner)?.clear(); trays.delete(owner);
    for (const entry of downloads.values()) if (entry.owner === owner) entry.abort.abort();
  }
  function initialize() {
    if (client) return;
    network = networkFactory({ onFailure: () => {
      stopWatches(); cancelDownloads();
      broadcast('camellia:device-event', { type: 'offline' });
    } });
    client = clientFactory({ file: path.join(app.getPath('userData'), 'remote', 'outgoing-devices.json'), safeStorage, network });
    if (apiSource) imports = createApiImportClient({ client, source: apiSource });
  }
  async function watch(owner, deviceId, conversationId, watchId) {
    stopWatches(owner);
    if (typeof watchId !== 'string' || watchId.length > 100) throw new Error('Invalid watch ID');
    const streamGeneration = generation;
    for (const target of conversationId ? [null, conversationId] : [null]) {
      const abort = new AbortController();
      const key = { owner, target };
      watches.set(key, { owner, abort });
      const notify = type => { if (!owner.isDestroyed()) owner.send('camellia:device-event', { deviceId, conversationId: target, watchId, type }); };
      void (async () => {
        try {
          for await (const event of client.events(deviceId, target, abort.signal)) {
            if (abort.signal.aborted || generation !== streamGeneration) break;
            notify('changed');
          }
          if (!abort.signal.aborted && generation === streamGeneration) notify('offline');
        } catch {
          if (!abort.signal.aborted && generation === streamGeneration) notify('offline');
        } finally { watches.delete(key); }
      })();
    }
    return { watching: true };
  }
  ipcMain.handle('camellia:devices', async (event, request = {}) => {
    if (!authorized(event) || closed) return { ok: false, error: 'Local CLI devices window required' };
    if (!request || typeof request !== 'object' || Array.isArray(request)) return { ok: false, error: 'Invalid device request' };
    const owner = event.sender;
    const surfaceVersion = surfaceVersions.get(owner) || 0;
    const detached = () => owner.isDestroyed() || surfaceVersion !== (surfaceVersions.get(owner) || 0);
    const boundDevice = serverContents.get(owner);
    if (boundDevice && (request.payload?.deviceId && request.payload.deviceId !== boundDevice || ['pair', 'claim', 'cancel-pair', 'forget', 'preferences'].includes(request.action))) return { ok: false, error: 'Use connection settings to manage CLI servers' };
    if (!trays.has(owner)) trays.set(owner, createAttachmentTray());
    const tray = trays.get(owner);
    if (request.action === 'download-cancel') {
      const download = downloads.get(request.payload?.id);
      if (download?.owner === owner) download.abort.abort();
      return { ok: true, result: {} };
    }
    if (busySenders.has(owner)) return { ok: false, error: 'Please wait for the current device operation' };
    const { action, payload = {} } = request;
    const requestGeneration = generation;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, error: 'Invalid device payload' };
    busySenders.add(owner);
    try {
      initialize();
      let result;
      if (action === 'state') result = { devices: client.list(), network: await network.status(), theme: loadConfig().theme || 'system', language: loadConfig().language || 'zh-CN' };
      else if (action === 'preferences') result = client.preferences(payload.deviceId, payload);
      else if (action === 'server-manage') {
        if (!require('./server-management').ACTIONS.has(payload.request?.action)) throw new Error('Unsupported server settings action');
        result = await client.manage(payload.deviceId, payload.request);
      }
      else if (action === 'server-job') result = await client.managementJob(payload.deviceId, payload.id);
      else if (action === 'network-start') { await network.start(); const state = await network.status(); if (state.state === 'NeedsLogin') await network.login(); result = await network.status(); }
      else if (action === 'network-login') { await network.login(); result = await network.status(); }
      else if (action === 'open-login') { await network.openLogin(); result = {}; }
      else if (action === 'open-output-link') {
        const url = new URL(payload.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || String(payload.url).length > 8192) throw new Error('Only HTTP(S) links without credentials can be opened');
        const answer = await dialog.showMessageBox(BrowserWindow?.fromWebContents(owner) || getSettingsWindow() || undefined, { type: 'question', message: 'Open this remote-output link in your local browser?', detail: url.href, buttons: ['Cancel', 'Open'], defaultId: 0, cancelId: 0, noLink: true });
        if (answer.response === 1 && requestGeneration === generation && !closed && !detached()) await shell.openExternal(url.href);
        result = {};
      }
      else if (action === 'network-stop') { stopWatches(); cancelDownloads(); tray.clear(); await network.stop(); result = {}; }
      else if (action === 'pair') {
        result = await client.pair(payload);
        if (requestGeneration !== generation || closed || detached()) { await client.cancelPairing(result.id); throw new Error('Pairing window closed'); }
      }
      else if (action === 'claim') result = await client.claim(payload.id);
      else if (action === 'cancel-pair') { await client.cancelPairing(payload.id); result = {}; }
      else if (action === 'forget') { windows.get(payload.id)?.close(); await client.forget(payload.id); result = {}; }
      else if (action === 'conversations') result = await client.conversations(payload.deviceId, payload.offset || 0);
      else if (action === 'archived') result = await client.archived(payload.deviceId, payload.offset || 0);
      else if (action === 'native-settings-get') result = await client.nativeSettings(payload.deviceId, payload.engine);
      else if (action === 'native-settings-save') result = await client.saveNativeSettings(payload.deviceId, payload.settings);
      else if (action === 'snapshot') result = await client.snapshot(payload.deviceId, payload.conversationId, payload.before);
      else if (action === 'attachments-add') {
        const files = bufferAttachments(payload.files, nativeImage);
        if (files.reduce((total, file) => total + file.size, 0) > 8 * 1024 * 1024) throw new Error('Attachments exceed 8 MiB total');
        await client.snapshot(payload.deviceId, payload.conversationId);
        if (closed || detached()) throw new Error('Device window closed');
        result = { files: tray.add(payload.deviceId, payload.conversationId, files) };
      }
      else if (action === 'attachments-select') {
        await client.snapshot(payload.deviceId, payload.conversationId);
        const choice = await dialog.showOpenDialog(BrowserWindow?.fromWebContents(owner) || getSettingsWindow() || undefined, { title: 'Attach files to remote conversation', properties: ['openFile', 'multiSelections'] });
        if (choice.canceled) result = { files: [] };
        else {
          if (choice.filePaths.length > 9) throw new Error('Select up to 9 files');
          const files = [];
          for (const file of choice.filePaths) files.push(await readAttachment(file, nativeImage));
          if (requestGeneration !== generation || closed || detached()) throw new Error('Device window closed');
          if (files.reduce((sum, file) => sum + file.size, 0) > 8 * 1024 * 1024) throw new Error('Attachments exceed 8 MiB total');
          result = { files: tray.add(payload.deviceId, payload.conversationId, files) };
        }
      }
      else if (action === 'attachments-remove') { tray.remove(payload.ids); result = {}; }
      else if (action === 'artifacts') result = await client.artifacts(payload.deviceId, payload.conversationId, payload.offset || 0);
      else if (action === 'download') {
        if (downloads.size >= 2) throw new Error('Wait for another download to finish');
        const page = await client.artifacts(payload.deviceId, payload.conversationId, payload.offset || 0);
        const artifact = page.artifacts.find(entry => entry.id === payload.artifactId);
        if (!artifact || !Number.isSafeInteger(artifact.size) || artifact.size < 0 || artifact.size > 512 * 1024 * 1024) throw new Error('Artifact unavailable or larger than 512 MiB');
        const device = client.list().find(entry => entry.id === payload.deviceId);
        const choice = await dialog.showSaveDialog(BrowserWindow?.fromWebContents(owner) || getSettingsWindow() || undefined, { title: `Download from ${device?.name || 'CLI device'}`, defaultPath: downloadName(artifact.name), properties: ['showOverwriteConfirmation'] });
        if (choice.canceled || !choice.filePath) result = { canceled: true };
        else {
          if (requestGeneration !== generation || closed || detached()) throw new Error('Device window closed');
          const id = randomUUID(), abort = new AbortController();
          const send = value => { if (requestGeneration === generation && !owner.isDestroyed()) owner.send('camellia:device-transfer', { id, deviceId: payload.deviceId, name: downloadName(artifact.name), ...value }); };
          const entry = { abort, owner }; downloads.set(id, entry);
          entry.promise = (async () => {
            try {
              const response = await client.artifact(payload.deviceId, payload.conversationId, artifact.id, abort.signal);
              await saveDownload({ response, file: choice.filePath, expectedSize: artifact.size, signal: abort.signal, onProgress: (received, total) => send({ state: 'downloading', received, total }) });
              send({ state: 'complete', received: artifact.size, total: artifact.size });
            } catch { send({ state: abort.signal.aborted ? 'cancelled' : 'failed' }); }
            finally { downloads.delete(id); }
          })();
          result = { id, name: downloadName(artifact.name), size: artifact.size };
        }
      }
      else if (action === 'import-preview' && imports) {
        result = await imports.prepare(payload.deviceId, payload.policy);
        if (requestGeneration !== generation || closed || detached()) { imports.cancel(result.id); throw new Error('Import window closed'); }
      }
      else if (action === 'import-apply' && imports) result = await imports.apply(payload.deviceId, payload.id);
      else if (action === 'import-cancel' && imports) { imports.cancel(payload.id); result = {}; }
      else if (action === 'command') {
        const allowed = ['create', 'create-workspace', 'delete-workspace', 'rename-workspace', 'send', 'resend', 'move', 'stop', 'approve', 'configure', 'rename', 'pin', 'archive', 'restore', 'delete', 'fork', 'switch-engine', 'compact', 'goal-control', 'task-control'];
        if (!allowed.includes(payload.command?.action)) throw new Error('Unsupported device command');
        const command = { ...payload.command };
        if (command.attachments !== undefined) throw new Error('Choose attachments through the local file picker');
        if (payload.attachmentIds?.length) {
          if (command.action !== 'send' || command.images !== undefined || command.image !== undefined) throw new Error('Invalid attachment command');
          command.attachments = tray.resolve(payload.deviceId, payload.conversationId, payload.attachmentIds);
        }
        result = await client.command(payload.deviceId, payload.conversationId ?? null, command);
        if (result.ok && payload.attachmentIds) tray.remove(payload.attachmentIds);
      } else if (action === 'watch') result = await watch(owner, payload.deviceId, payload.conversationId, payload.watchId);
      else if (action === 'unwatch') { stopWatches(owner); result = {}; }
      else throw new Error('Unsupported device operation');
      return { ok: true, result };
    } catch (error) { return { ok: false, error: String(error.message).slice(0, 300) }; }
    finally { busySenders.delete(owner); }
  });
  ipcMain.handle('camellia:list-servers', event => {
    if (closed || !mainFrame(event) || !mayOpen(event.sender)) return { ok: false, error: 'Local workbench required' };
    try { initialize(); return { ok: true, devices: client.list(), language: loadConfig().language || 'zh-CN' }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('camellia:open-server', async (event, { deviceId } = {}) => {
    if (closed || !mainFrame(event) || !mayOpen(event.sender)) return { ok: false, error: 'Local workbench required' };
    try {
      initialize();
      const device = client.list().find(entry => entry.id === deviceId);
      if (!device) throw new Error('CLI device not found');
      const existing = windows.get(deviceId);
      if (existing && !existing.isDestroyed()) { if (existing.isMinimized()) existing.restore(); existing.show(); existing.focus(); return { ok: true }; }
      const window = new BrowserWindow({ width: 1440, height: 960, minWidth: 800, minHeight: 600, show: false,
        icon: path.join(__dirname, '../../../assets/icon-256.png'),
        title: `${device.name} — Camellia`, webPreferences: { preload: path.join(__dirname, 'devices-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
      windows.set(deviceId, window);
      const contents = window.webContents;
      serverContents.set(contents, deviceId);
      const detach = () => {
        if (!serverContents.delete(contents)) return;
        detachSurface(contents);
        if (windows.get(deviceId) === window) windows.delete(deviceId);
      };
      contents.once('destroyed', detach);
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-navigate', navigation => navigation.preventDefault());
      window.on('closed', detach);
      try { await window.loadFile(path.join(__dirname, '../../renderer/devices/devices.html'), { query: { device: deviceId } }); }
      catch (error) { if (!window.isDestroyed()) window.close(); throw error; }
      if (!window.isDestroyed()) window.show();
      return { ok: true };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('camellia:open-devices', event => {
    if (closed || !mainFrame(event) || !mayOpen(event.sender)) return { ok: false, error: 'Local workbench required' };
    try { openSettings({ page: 'devices' }); return { ok: true }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
  const controller = {
    open() { if (!closed) openSettings({ page: 'devices' }); },
    detach(contentsList = settingsSurfaces()) {
      for (const contents of contentsList) if (contents) detachSurface(contents);
      if (client) for (const id of [...client.pending.keys()]) void client.cancelPairing(id).catch(() => {});
    },
    async close() {
      closed = true; this.detach(); generation++; stopWatches(); cancelDownloads(); imports?.clear();
      for (const window of windows.values()) if (!window.isDestroyed()) window.close();
      serverContents.clear(); windows.clear();
      for (const tray of trays.values()) tray.clear(); trays.clear();
      await client?.close(); await network?.stop();
      await Promise.allSettled([...downloads.values()].map(entry => entry.promise));
    },
  };
  return controller;
}

module.exports = { createDevicesDesktop };
