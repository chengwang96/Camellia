'use strict';

const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { RemoteAccess } = require('./access');
const { RemoteReadModel } = require('./read-model');
const { RemoteGateway } = require('./gateway');
const { RemoteCommands } = require('./commands');
const { RemoteMessageQueue } = require('./message-queue');
const { TailscaleAPI } = require('./tailscale-api');
const { tailscaleHostname } = require('./embedded-network');

function createRemoteService({ dataDir, manager, networkFactory, apiRoutes = null, desktopRestart = null, getDiscussions = null, accountUsage = null,
  preferences = () => ({}), setComputerName = () => '', safeStorage = null, openExternal = null, log = () => {} }) {
  let gateway = null, access = null, network = null, busy = false, enabled = false, closed = false;
  let startupChecked = false, monitor = null, attachmentMaintenance = null, retryDelay = 1000, retryAt = 0;
  let recovering = null, diagnosing = false, sourceDeviceId = '', sourceAddress = '';
  const tailscale = new TailscaleAPI({ file: path.join(dataDir, 'remote', 'tailscale-oauth.json'), safeStorage, openExternal });
  const messageQueue = new RemoteMessageQueue({
    file: path.join(dataDir, 'remote', 'message-queue.json'),
    manager,
  });
  manager.remoteQueue = messageQueue;
  let tailscaleRevision = 0;
  function refreshTailscaleView() {
    const revision = ++tailscaleRevision;
    void tailscale.status({ sourceDeviceId, sourceAddress }).then(view => {
      if (!closed && revision === tailscaleRevision) tailscaleView = view;
    }).catch(error => {
      if (!closed && revision === tailscaleRevision) tailscaleView = { ...(tailscaleView || {}), state: 'error', error: error.message };
    });
  }
  function setSourceDeviceId(value, address = sourceAddress) {
    const nextId = typeof value === 'string' && value ? value : sourceDeviceId;
    const nextAddress = typeof address === 'string' && address ? address : sourceAddress;
    if (nextId === sourceDeviceId && nextAddress === sourceAddress) return;
    sourceDeviceId = nextId;
    sourceAddress = nextAddress;
    tailscale.statusCache = null;
    refreshTailscaleView();
  }
  let tailscaleView;
  try {
    const saved = tailscale.saved();
    tailscaleView = saved ? { configured: true, clientId: saved.clientId, state: 'checking', changedAcl: false }
      : { configured: false, state: 'unconfigured', changedAcl: false };
  } catch (error) {
    tailscaleView = { configured: true, state: 'invalid', error: error.message, changedAcl: false };
  }
  if (tailscaleView.state === 'checking') {
    refreshTailscaleView();
  }
  const attachmentReferences = () => ({
    references: [gateway?.commands?.queue.entries || [], ...(gateway?.commands?.pendingAttachments.values() || []),
      ...(gateway?.discussions?.pendingAttachments.values() || [])],
    active: Boolean(gateway?.commands?.pendingAttachments.size || gateway?.discussions?.pendingAttachments.size),
  });
  const reader = new RemoteReadModel(manager);
  function initialize() {
    if (gateway) return;
    access = new RemoteAccess({ file: path.join(dataDir, 'remote', 'devices.json'), onRevoke: id => gateway.revoke(id) });
    const commands = new RemoteCommands({ file: path.join(dataDir, 'remote', 'commands.json'), reader, access, queue: messageQueue,
      publish: () => { gateway.publish(); attachmentMaintenance?.markDirty(); } });
    const discussions = getDiscussions ? new (require('./discussions').RemoteDiscussions)({
      file: path.join(dataDir, 'remote', 'discussion-commands.json'), getService: getDiscussions, access,
      publish: () => { gateway?.publish(); attachmentMaintenance?.markDirty(); } }) : null;
    gateway = new RemoteGateway({ access, reader, commands, apiRoutes, desktopRestart, discussions, accountUsage });
    try { network = networkFactory({ onFailure: () => {
      if (closed || !enabled) return;
      recovering = gateway.stop();
      retryAt = Date.now() + retryDelay;
      scheduleMonitor();
    }, hostname: () => tailscaleHostname(preferences().computerName) }); }
    catch (error) { gateway = null; access = null; throw error; }
  }
  function state() {
    const view = access.view();
    return { ...preferences(), running: Boolean(gateway?.server), enabled, network: { ...network.snapshot },
      address: gateway?.url || null, ...view, workspaces: reader.workspaces(),
      diagnosticsAvailable: typeof network.diagnosePeer === 'function',
      ...(tailscaleView ? { tailscale: tailscaleView } : {}),
      devices: view.devices.map(device => ({ ...device, peerAddress: gateway.peerAddresses.get(device.id) || null })) };
  }
  async function refreshNetwork() {
    if (!enabled) return;
    if (recovering) { await recovering; recovering = null; }
    if (Date.now() < retryAt) return;
    if (['Stopped', 'Error'].includes(network.snapshot.state)) {
      if (network.snapshot.state === 'Error' && network.child) {
        log('Mobile access is restarting the embedded network helper after a failure');
        await network.stop();
      }
      await network.start();
    }
    const status = await network.status();
    // The helper's stable node ID can differ from the management API ID.
    // Publish its address in the same update so status can resolve that node.
    setSourceDeviceId(status.deviceId, status.address);
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
        catch (error) {
          log('Mobile access network check failed: ' + error.message);
          await gateway.stop(); network.snapshot.state = 'Error';
          retryAt = Date.now() + retryDelay; retryDelay = Math.min(30_000, retryDelay * 2);
        }
        finally { busy = false; }
      }
      scheduleMonitor();
    }, enabled && !gateway?.server ? Math.max(250, retryAt - Date.now()) : 5000);
    monitor.unref();
  }
  async function restartNetwork(executable, activate) {
    if (closed) throw new Error('Camellia is closing');
    if (busy || diagnosing) throw new Error('Please wait for the current mobile access operation');
    if (typeof executable !== 'string' || !executable) throw new Error('Updated embedded network helper is missing');
    busy = true;
    clearTimeout(monitor);
    let previous;
    try {
      initialize();
      previous = network.executable || null;
      await gateway.stop();
      await network.stop();
      network.executable = executable;
      retryAt = 0;
      retryDelay = 1000;
      if (enabled) await startAccess(false);
      if (closed) throw new Error('Camellia is closing');
      return activate(state());
    } catch (error) {
      let rollbackError = null;
      try {
        await gateway?.stop();
        await network?.stop();
        if (network) network.executable = previous || null;
        retryAt = 0;
        if (enabled && !closed && network) await startAccess(false);
      } catch (restoreError) { rollbackError = restoreError; }
      if (rollbackError) throw new Error(error.message + '; restoring the previous helper also failed: ' + rollbackError.message);
      throw error;
    } finally {
      busy = false;
      scheduleMonitor();
    }
  }
  return {
    setSourceDeviceId,
    async command(action, payload) {
      if (closed) return { ok: false, error: 'Camellia is closing' };
      if (['tailscale-status', 'tailscale-open-credentials', 'tailscale-save', 'tailscale-remove', 'tailscale-apply-peer-relay', 'tailscale-rename-device'].includes(action)) {
        try {
          if (action !== 'tailscale-open-credentials') ++tailscaleRevision;
          let result;
          if (action === 'tailscale-status') result = await tailscale.status({ sourceDeviceId, sourceAddress, force: true });
          else if (action === 'tailscale-open-credentials') { await tailscale.openCredentials(); result = { opened: true }; }
          else if (action === 'tailscale-save') result = await tailscale.verifyAndSave(payload, { sourceDeviceId, sourceAddress });
          else if (action === 'tailscale-apply-peer-relay') {
            // A stale renderer may still send only `enabled` while the selected
            // relay is known from the cached view. Resolve it here rather than
            // rejecting with "Choose a valid relay device".
            const relay = payload?.enabled && !payload?.deviceId
              ? (tailscaleView?.devices || []).find(device => device.relayGranted) : null;
            result = await tailscale.applyPeerRelay({ ...payload,
              ...(relay ? { deviceId: relay.id } : {}), sourceDeviceId, sourceAddress });
          }
          else if (action === 'tailscale-rename-device') result = await tailscale.renameDevice({ ...payload, sourceDeviceId, sourceAddress });
          else { tailscale.remove(); result = { configured: false, state: 'unconfigured', changedAcl: false }; }
          if (action !== 'tailscale-open-credentials') ++tailscaleRevision;
          if (action === 'tailscale-apply-peer-relay' || action === 'tailscale-rename-device') {
            if (result.state === 'connected') {
              tailscaleView = { ...result, applied: true };
              if (tailscale.statusCache?.clientId) tailscale.statusCache = { ...tailscale.statusCache,
                expiresAt: Date.now() + 60_000, view: tailscaleView };
            } else tailscaleView = result;
          } else if (action !== 'tailscale-open-credentials') {
            // status() can return an error view after a temporary network
            // failure. Preserve a successful verification during its cache
            // window so the settings summary does not flicker.
            if (!(action === 'tailscale-status' && result.state === 'error' && tailscaleView?.state === 'connected'
                && tailscale.statusCache?.expiresAt > Date.now())) tailscaleView = result;
          }
          return { ok: true, result };
        } catch (error) { return { ok: false, error: error.message }; }
      }
      if (action === 'diagnose') {
        if (diagnosing) return { ok: false, error: 'A connection probe is already running' };
        diagnosing = true;
        try {
          if (!enabled || !gateway?.server || network?.snapshot.state !== 'Running') throw new Error('Enable mobile access first');
          const device = access.devices.find(device => device.id === payload?.id);
          if (!device) throw new Error('Invalid device');
          const address = gateway.peerAddresses.get(device.id);
          if (!address) throw new Error('Open this computer on the phone first');
          if (typeof network.diagnosePeer !== 'function') throw new Error('Network diagnostics are unavailable');
          const result = await network.diagnosePeer(address);
          if (closed || !enabled || !gateway.server || !access.devices.some(item => item.id === device.id)
              || gateway.peerAddresses.get(device.id) !== address) throw new Error('The device connection changed; run diagnostics again');
          return { ok: true, result };
        } catch (error) { return { ok: false, error: error.message }; }
        finally { diagnosing = false; }
      }
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
          const requested = typeof payload?.name === 'string' ? payload.name.trim() : '';
          if (!requested || requested.length > 80) throw new Error('Enter a name of 1–80 characters');
          const savedName = setComputerName(requested);
          // The embedded node always receives the OS-safe form of the name;
          // the management API accepts the display name when it is already a
          // valid DNS label and otherwise reports that control-plane sync was
          // skipped. The local name is never rolled back after a sync failure.
          const hostname = tailscaleHostname(requested);
          let networkSync = { synced: false, reason: 'not-running' };
          if (hostname && network?.child) {
            try { networkSync = { synced: true, ...(await network.setHostname(hostname)) }; }
            catch (error) { networkSync = { synced: false, reason: 'error', error: error.message }; }
          }
          let tailscaleSync = { synced: false, reason: 'invalid-name' };
          if (/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(savedName)) {
            try { tailscaleSync = await tailscale.renameCurrentDevice({ name: savedName, sourceDeviceId, sourceAddress }); }
            catch (error) { tailscaleSync = { synced: false, reason: 'error', error: error.message }; }
            if (tailscaleSync.synced) tailscale.statusCache = null;
          }
          result = { ...state(), computerName: savedName, tailscaleSync, embeddedNetworkSync: networkSync };
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
          log(`Mobile access ${action} failed: ` + error.message);
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
    updateHostname: async hostname => network?.setHostname(hostname),
    restartNetwork,
    attachmentReferences,
    attachmentRevision: () => attachmentMaintenance?.version ?? 0,
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
