'use strict';

const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { RemoteAccess } = require('./access');
const { RemoteReadModel } = require('./read-model');
const { RemoteGateway } = require('./gateway');
const { RemoteCommands } = require('./commands');

function createRemoteService({ dataDir, manager, networkFactory, apiRoutes = null, apiImport = null, nativeSettings = null, management = null, getDiscussions = null,
  preferences = () => ({}), setComputerName = () => '' }) {
  let gateway = null, access = null, network = null, busy = false, enabled = false, closed = false;
  let startupChecked = false, monitor = null, attachmentMaintenance = null, retryDelay = 1000, retryAt = 0;
  let recovering = null;
  const attachmentReferences = () => ({
    references: [gateway?.commands?.queue.entries || [], ...(gateway?.commands?.pendingAttachments.values() || []),
      ...(gateway?.discussions?.pendingAttachments.values() || [])],
    active: Boolean(gateway?.commands?.pendingAttachments.size || gateway?.discussions?.pendingAttachments.size),
  });
  const reader = new RemoteReadModel(manager);
  function initialize() {
    if (gateway) return;
    access = new RemoteAccess({ file: path.join(dataDir, 'remote', 'devices.json'), onRevoke: id => gateway.revoke(id) });
    const commands = new RemoteCommands({ file: path.join(dataDir, 'remote', 'commands.json'), reader, access,
      publish: () => { gateway.publish(); attachmentMaintenance?.markDirty(); } });
    const discussions = getDiscussions ? new (require('./discussions').RemoteDiscussions)({
      file: path.join(dataDir, 'remote', 'discussion-commands.json'), getService: getDiscussions, access,
      publish: () => { gateway?.publish(); attachmentMaintenance?.markDirty(); } }) : null;
    gateway = new RemoteGateway({ access, reader, commands, apiRoutes, apiImport, nativeSettings, management, discussions });
    try { network = networkFactory({ onFailure: () => {
      if (closed || !enabled) return;
      recovering = gateway.stop();
      retryAt = Date.now() + retryDelay;
      scheduleMonitor();
    } }); }
    catch (error) { gateway = null; access = null; throw error; }
  }
  function state() {
    return { ...preferences(), running: Boolean(gateway?.server), enabled, network: { ...network.snapshot },
      address: gateway?.url || null, ...access.view(), workspaces: reader.workspaces() };
  }
  async function refreshNetwork() {
    if (!enabled) return;
    if (recovering) { await recovering; recovering = null; }
    if (Date.now() < retryAt) return;
    if (['Stopped', 'Error'].includes(network.snapshot.state)) await network.start();
    const status = await network.status();
    if (!enabled || closed) return;
    if (status.state !== 'Running' || !status.address) {
      if (gateway.server) await gateway.stop();
      return;
    }
    if (gateway.server) {
      if (gateway.url === `http://${status.address}:43127`) return;
      await gateway.stop();
    }
    try {
      const token = randomBytes(32).toString('hex');
      await gateway.start('127.0.0.1', 0, { address: status.address, token });
      if (!enabled || closed) { await gateway.stop(); return; }
      await network.listen(`http://127.0.0.1:${gateway.server.address().port}`, token);
      if (!enabled || closed) { await network.stop(); await gateway.stop(); }
      else { retryDelay = 1000; retryAt = 0; }
    } catch (error) { await gateway.stop(); throw error; }
  }
  async function startAccess(interactive) {
    try {
      enabled = true;
      retryAt = 0;
      await network.start();
      if (closed || !enabled) { await network.stop(); return; }
      const status = await network.status();
      if (closed || !enabled) { await network.stop(); return; }
      if (interactive && status.state === 'NeedsLogin') await network.login();
      await refreshNetwork();
      scheduleMonitor();
    } catch (error) {
      await gateway.stop();
      retryAt = Date.now() + retryDelay;
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
        catch {
          await gateway.stop(); network.snapshot.state = 'Error';
          retryAt = Date.now() + retryDelay; retryDelay = Math.min(30_000, retryDelay * 2);
        }
        finally { busy = false; }
      }
      scheduleMonitor();
    }, enabled && !gateway?.server ? Math.max(250, retryAt - Date.now()) : 5000);
    monitor.unref();
  }
  return {
    async command(action, payload) {
      if (closed) return { ok: false, error: 'Camellia is closing' };
      if (busy && (action === 'stop' || action === 'logout')) {
        enabled = false; retryAt = 0;
        await gateway?.stop();
        try { if (action === 'logout') await network?.logout(); }
        finally { await network?.stop(); }
        return { ok: true, result: state() };
      }
      if (busy) return action === 'state' && network ? { ok: true, result: state() } : { ok: false, error: 'Please wait for the current operation' };
      busy = true;
      try {
        initialize();
        let result;
        if (action === 'state') { await refreshNetwork(); result = state(); }
        else if (action === 'start') { await startAccess(true); result = state(); }
        else if (action === 'login') { if (!enabled) throw new Error('Enable mobile access first'); await network.login(); result = state(); }
        else if (action === 'open-login') { if (!enabled) throw new Error('Enable mobile access first'); await network.openLogin(); result = state(); }
        else if (action === 'stop' || action === 'logout') {
          enabled = false;
          await gateway.stop();
          try { if (action === 'logout') await network.logout(); }
          finally { await network.stop(); }
          result = state();
        } else if (action === 'invite' || action === 'scope') {
          if (action === 'invite' && !gateway.server) throw new Error('Enable remote access first');
          const options = { allWorkspaces: true, includeUnassigned: true };
          if (action === 'scope') { access.setScope(payload?.id, [], options); result = state(); }
          else result = { ...access.invite([], { ...options, computerName: preferences().computerName }), address: gateway.url };
        } else if (action === 'set-name') {
          result = { ...state(), computerName: setComputerName(payload?.name) };
        } else if (action === 'rename') {
          access.rename(payload?.id, payload?.name); result = state();
        } else if (action === 'approve') {
          const request = access.pending.get(payload?.id);
          if (!request || (!request.allWorkspaces && request.workspaceIds.some(id => !reader.workspaces().some(workspace => workspace.id === id)))) throw new Error('The workspace selection is no longer available');
          access.approve(payload.id); result = state();
        } else if (action === 'reject') { access.reject(payload?.id); result = state(); }
        else if (action === 'revoke') { access.revoke(payload?.id); result = state(); }
        else throw new Error('Unsupported remote-access action');
        return { ok: true, result };
      } catch (error) {
        if (enabled && network && ['state', 'start'].includes(action)) {
          retryAt = Date.now() + retryDelay; retryDelay = Math.min(30_000, retryDelay * 2);
          network.snapshot.state = 'Error';
        }
        return { ok: false, error: error.message };
      }
      finally { busy = false; scheduleMonitor(); }
    },
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
      } finally { busy = false; scheduleMonitor(); }
    },
    attachmentReferences,
    attachmentsChanged() { attachmentMaintenance?.markDirty(); },
    maintainAttachments(cleanup, log, isBlocked = () => false) {
      if (attachmentMaintenance || closed) return;
      const { StorageCleanup } = require('../storage-cleanup');
      const { AttachmentMaintenance } = require('../attachment-maintenance');
      // An independent cleaner preserves a user's manual preview while an idle
      // pass checks the same reference sources and active upload leases.
      const backgroundCleanup = new StorageCleanup({ ...cleanup,
        isActive: () => closed || busy || isBlocked() || cleanup.isActive() || attachmentReferences().active,
        references: async () => {
          const saved = await cleanup.references(), remote = attachmentReferences();
          return { references: [saved, remote.references], active: Boolean(saved?.active || remote.active) };
        } });
      attachmentMaintenance = new AttachmentMaintenance({ log, cleanup: backgroundCleanup, sweep: () => backgroundCleanup.sweepRetention() });
    },
    publish(update) {
      reader.observeCompaction(update); gateway?.publish(update);
      if (!update || update.type?.startsWith('conversation:')) attachmentMaintenance?.markDirty();
    },
    async close() {
      closed = true; enabled = false; clearTimeout(monitor);
      await attachmentMaintenance?.close();
      try { await network?.stop(); }
      finally { await gateway?.stop(); }
    },
  };
}

module.exports = { createRemoteService };
