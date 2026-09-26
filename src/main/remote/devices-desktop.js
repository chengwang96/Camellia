'use strict';

const path = require('node:path');
const { EmbeddedNetwork } = require('./embedded-network');
const { DeviceClient } = require('./device-client');
const { createApiImportClient } = require('./api-import-client');
const { readAttachment, createAttachmentTray, downloadName, saveDownload } = require('./device-files');
const { randomUUID } = require('node:crypto');

function createDevicesDesktop({ app, ipcMain, safeStorage, shell, dialog, nativeImage, getSettingsWindow, getSurfaces = () => [], openSettings, authorizedSender, loadConfig, apiSource,
  networkFactory = ({ onFailure }) => new EmbeddedNetwork({ app, safeStorage, directory: path.join(app.getPath('userData'), 'remote', 'tailnet'),
    openExternal: url => shell.openExternal(url), onFailure }), clientFactory = options => new DeviceClient(options) }) {
  let network = null, client = null, imports = null, closed = false, busy = false, generation = 0;
  const watches = new Map();
  const tray = createAttachmentTray(), downloads = new Map();
  function cancelDownloads() { for (const entry of downloads.values()) entry.abort.abort(); }
  const surfaces = () => getSurfaces().filter(contents => contents && !contents.isDestroyed());
  const authorized = event => surfaces().some(contents => event.sender === contents) && event.senderFrame === event.sender.mainFrame;
  const mayOpen = webContents => authorizedSender ? Boolean(authorizedSender(webContents)) : false;
  const broadcast = (channel, payload) => { for (const contents of surfaces()) { try { contents.send(channel, payload); } catch { /* consumer closed */ } } };
  function stopWatches() { for (const abort of watches.values()) abort.abort(); watches.clear(); }
  function initialize() {
    if (client) return;
    network = networkFactory({ onFailure: () => {
      stopWatches(); cancelDownloads();
      broadcast('camellia:device-event', { type: 'offline' });
    } });
    client = clientFactory({ file: path.join(app.getPath('userData'), 'remote', 'outgoing-devices.json'), safeStorage, network });
    if (apiSource) imports = createApiImportClient({ client, source: apiSource });
  }
  async function watch(deviceId, conversationId, watchId) {
    stopWatches();
    if (typeof watchId !== 'string' || watchId.length > 100) throw new Error('Invalid watch ID');
    const streamGeneration = generation;
    for (const target of conversationId ? [null, conversationId] : [null]) {
      const abort = new AbortController();
      watches.set(target, abort);
      void (async () => {
        try {
          for await (const event of client.events(deviceId, target, abort.signal)) {
            if (abort.signal.aborted || generation !== streamGeneration) break;
            broadcast('camellia:device-event', { deviceId, conversationId: target, watchId, type: 'changed' });
          }
          if (!abort.signal.aborted && generation === streamGeneration) broadcast('camellia:device-event', { deviceId, watchId, type: 'offline' });
        } catch {
          if (!abort.signal.aborted && generation === streamGeneration) broadcast('camellia:device-event', { deviceId, watchId, type: 'offline' });
        } finally { if (watches.get(target) === abort) watches.delete(target); }
      })();
    }
    return { watching: true };
  }
  ipcMain.handle('camellia:devices', async (event, request = {}) => {
    if (!authorized(event) || closed) return { ok: false, error: 'Local CLI devices window required' };
    if (!request || typeof request !== 'object' || Array.isArray(request)) return { ok: false, error: 'Invalid device request' };
    if (request.action === 'download-cancel') {
      const download = downloads.get(request.payload?.id);
      if (download) download.abort.abort();
      return { ok: true, result: {} };
    }
    if (busy) return { ok: false, error: 'Please wait for the current device operation' };
    const { action, payload = {} } = request;
    const requestGeneration = generation;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, error: 'Invalid device payload' };
    busy = true;
    try {
      initialize();
      let result;
      if (action === 'state') result = { devices: client.list(), network: await network.status(), theme: loadConfig().theme || 'system', language: loadConfig().language || 'zh-CN' };
      else if (action === 'network-start') { await network.start(); const state = await network.status(); if (state.state === 'NeedsLogin') await network.login(); result = await network.status(); }
      else if (action === 'network-login') { await network.login(); result = await network.status(); }
      else if (action === 'open-login') { await network.openLogin(); result = {}; }
      else if (action === 'open-output-link') {
        const url = new URL(payload.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || String(payload.url).length > 8192) throw new Error('Only HTTP(S) links without credentials can be opened');
        const answer = await dialog.showMessageBox(getSettingsWindow() || undefined, { type: 'question', message: 'Open this remote-output link in your local browser?', detail: url.href, buttons: ['Cancel', 'Open'], defaultId: 0, cancelId: 0, noLink: true });
        if (answer.response === 1 && requestGeneration === generation && !closed) await shell.openExternal(url.href);
        result = {};
      }
      else if (action === 'network-stop') { stopWatches(); cancelDownloads(); tray.clear(); await network.stop(); result = {}; }
      else if (action === 'pair') {
        result = await client.pair(payload);
        if (requestGeneration !== generation || closed) { await client.cancelPairing(result.id); throw new Error('Pairing window closed'); }
      }
      else if (action === 'claim') result = await client.claim(payload.id);
      else if (action === 'cancel-pair') { await client.cancelPairing(payload.id); result = {}; }
      else if (action === 'forget') { stopWatches(); cancelDownloads(); tray.clear(); await client.forget(payload.id); result = {}; }
      else if (action === 'conversations') result = await client.conversations(payload.deviceId, payload.offset || 0);
      else if (action === 'archived') result = await client.archived(payload.deviceId, payload.offset || 0);
      else if (action === 'native-settings-get') result = await client.nativeSettings(payload.deviceId, payload.engine);
      else if (action === 'native-settings-save') result = await client.saveNativeSettings(payload.deviceId, payload.settings);
      else if (action === 'snapshot') result = await client.snapshot(payload.deviceId, payload.conversationId, payload.before);
      else if (action === 'attachments-select') {
        await client.snapshot(payload.deviceId, payload.conversationId);
        const choice = await dialog.showOpenDialog(getSettingsWindow() || undefined, { title: 'Attach files to remote conversation', properties: ['openFile', 'multiSelections'] });
        if (choice.canceled) result = { files: [] };
        else {
          if (choice.filePaths.length > 9) throw new Error('Select up to 9 files');
          const files = [];
          for (const file of choice.filePaths) files.push(await readAttachment(file, nativeImage));
          if (requestGeneration !== generation || closed) throw new Error('Device window closed');
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
        const choice = await dialog.showSaveDialog(getSettingsWindow() || undefined, { title: `Download from ${device?.name || 'CLI device'}`, defaultPath: downloadName(artifact.name), properties: ['showOverwriteConfirmation'] });
        if (choice.canceled || !choice.filePath) result = { canceled: true };
        else {
          if (requestGeneration !== generation || closed) throw new Error('Device window closed');
          const id = randomUUID(), abort = new AbortController();
          const send = value => { if (requestGeneration === generation) broadcast('camellia:device-transfer', { id, deviceId: payload.deviceId, name: downloadName(artifact.name), ...value }); };
          const entry = { abort }; downloads.set(id, entry);
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
        result = await imports.prepare(payload.deviceId);
        if (requestGeneration !== generation || closed) { imports.cancel(result.id); throw new Error('Import window closed'); }
      }
      else if (action === 'import-apply' && imports) result = await imports.apply(payload.deviceId, payload.id);
      else if (action === 'import-cancel' && imports) { imports.cancel(payload.id); result = {}; }
      else if (action === 'command') {
        const allowed = ['create', 'create-workspace', 'delete-workspace', 'rename-workspace', 'send', 'stop', 'approve', 'configure', 'rename', 'pin', 'archive', 'restore', 'delete'];
        if (!allowed.includes(payload.command?.action)) throw new Error('Unsupported device command');
        const command = { ...payload.command };
        if (command.attachments !== undefined) throw new Error('Choose attachments through the local file picker');
        if (payload.attachmentIds?.length) {
          if (command.action !== 'send' || command.images !== undefined || command.image !== undefined) throw new Error('Invalid attachment command');
          command.attachments = tray.resolve(payload.deviceId, payload.conversationId, payload.attachmentIds);
        }
        result = await client.command(payload.deviceId, payload.conversationId ?? null, command);
        if (result.ok && payload.attachmentIds) tray.remove(payload.attachmentIds);
      } else if (action === 'watch') result = await watch(payload.deviceId, payload.conversationId, payload.watchId);
      else if (action === 'unwatch') { stopWatches(); result = {}; }
      else throw new Error('Unsupported device operation');
      return { ok: true, result };
    } catch (error) { return { ok: false, error: String(error.message).slice(0, 300) }; }
    finally { busy = false; }
  });
  ipcMain.handle('camellia:open-devices', event => {
    if (closed || !mayOpen(event.sender) || event.senderFrame !== event.sender.mainFrame) return { ok: false, error: 'Local workbench required' };
    try { openSettings({ page: 'devices' }); return { ok: true }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
  const controller = {
    open() { if (!closed) openSettings({ page: 'devices' }); },
    // The page lives in the settings document now: closing that window stops
    // streams and transfers, but paired credentials and the network stay warm.
    detach() {
      generation++; stopWatches(); cancelDownloads(); tray.clear(); imports?.clear();
      if (client) for (const id of [...client.pending.keys()]) void client.cancelPairing(id).catch(() => {});
    },
    async close() {
      closed = true; this.detach();
      await client?.close(); await network?.stop();
      await Promise.allSettled([...downloads.values()].map(entry => entry.promise));
    },
  };
  return controller;
}

module.exports = { createDevicesDesktop };
