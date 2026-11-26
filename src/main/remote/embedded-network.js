'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { jsonLines } = require('../../shared/json-lines');
const { isTailscaleIPv4 } = require('./tailscale');

function bundleDirectory(app) {
  return app.isPackaged ? path.join(process.resourcesPath, 'runtime') : path.resolve(__dirname, '../../../build/runtime-assets');
}

function loginURL(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'login.tailscale.com' && !url.username && !url.password && !url.port) return url.href;
  } catch {}
  return null;
}

function tailscaleHostname(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 63).replace(/-+$/g, '');
}

// Tailscale normally resolves an HTTP proxy from the environment and, on
// Windows, from WinHTTP. That is useful for the system Tailscale client but
// wrong for this node: the remote channel must not depend on a model proxy
// that can disappear independently. The feature must be disabled before the
// helper's process starts; TS_DISABLE_FEATURE is read during init.
const EMBEDDED_NETWORK_ENV = {
  TS_NO_LOGS_NO_SUPPORT: 'true',
  TS_DISABLE_FEATURE: 'useproxy',
  HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
  http_proxy: '', https_proxy: '', all_proxy: '',
  NO_PROXY: '*', no_proxy: '*',
  npm_config_proxy: '', npm_config_https_proxy: '', npm_config_noproxy: '*',
};

function embeddedNetworkEnvironment(source = process.env) {
  const env = Object.fromEntries(Object.entries(source).filter(([name]) => !/^TS(?:NET)?_/i.test(name)));
  return { ...env, ...EMBEDDED_NETWORK_ENV };
}

function storageKey(directory, safeStorage) {
  if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
    throw new Error('Secure system storage is unavailable. Unlock your system keychain before using embedded networking.');
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'key.enc');
  if (fs.existsSync(file)) {
    const key = safeStorage.decryptString(fs.readFileSync(file));
    if (Buffer.from(key, 'base64').length !== 32) throw new Error('Invalid embedded network storage key');
    return key;
  }
  const key = randomBytes(32).toString('base64');
  fs.writeFileSync(file, safeStorage.encryptString(key), { flag: 'wx', mode: 0o600 });
  return key;
}

function promoteHelper(executable) {
  const staged = executable + '.pending';
  // A running Windows helper cannot be replaced. A source-build update can
  // stage it until the next start, after the previous helper has exited.
  if (fs.existsSync(staged)) fs.renameSync(staged, executable);
  return executable;
}

class EmbeddedNetwork {
  constructor({ app, safeStorage, directory, executable, keyProvider, hostname, openExternal, onFailure = () => {}, spawnProcess = spawn }) {
    if (hostname !== undefined && typeof hostname !== 'function'
        && (typeof hostname !== 'string' || (hostname && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)))) throw new Error('Invalid Tailscale hostname');
    Object.assign(this, { app, safeStorage, directory, executable, keyProvider, hostname, openExternal, onFailure, spawnProcess });
    this.pending = new Map();
    this.sequence = 0;
    this.snapshot = { state: 'Stopped', loginUrl: null, address: null };
  }
  async start() {
    if (this.child) return;
    const directory = this.directory || path.join(this.app.getPath('userData'), 'remote', 'tailnet');
    const executable = this.executable || promoteHelper(path.join(bundleDirectory(this.app),
      process.platform === 'win32' ? 'camellia-tailnet.exe' : 'camellia-tailnet'));
    if (!fs.existsSync(executable)) throw new Error('Embedded network helper is missing. Reinstall Camellia; source builds must run npm run build:tailnet.');
    const key = this.keyProvider ? this.keyProvider(directory) : storageKey(directory, this.safeStorage);
    if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, 'base64').length !== 32) throw new Error('Invalid embedded network storage key');
    // Callers pass a DNS label, not the display name. An unusable value is
    // omitted so the helper keeps its own platform fallback.
    const savedHostname = typeof this.hostname === 'function' ? this.hostname() : this.hostname;
    const requestedHostname = typeof savedHostname === 'string'
      && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(savedHostname) ? savedHostname : '';
    const child = this.spawnProcess(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: embeddedNetworkEnvironment() });
    this.child = child;
    this.snapshot = { state: 'Starting', loginUrl: null, address: null };
    const fail = () => {
      if (this.child !== child) return;
      this.child = null;
      this.snapshot = { state: 'Error', loginUrl: null, address: null };
      this.rejectPending(new Error('Embedded network stopped unexpectedly. Disable and enable mobile access to retry.'));
      child.kill();
      this.onFailure();
    };
    child.on('error', fail);
    child.on('exit', fail);
    child.stdin.on('error', fail);
    child.stderr.resume();
    const lines = jsonLines(child.stdout);
    lines.on('data', line => {
      let response;
      try { response = JSON.parse(line); } catch { fail(); return; }
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.error) pending.reject(new Error(response.error));
      else pending.resolve(response.result);
    });
    try { await this.request('init', { directory, key, ...(requestedHostname ? { hostname: requestedHostname } : {}) }); }
    catch (error) { await this.stop(); throw error; }
  }
  request(action, payload = {}) {
    if (!this.child) return Promise.reject(new Error('Embedded network is not running'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Embedded network operation timed out'));
        void this.stop().then(() => this.onFailure());
      }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...payload, id, action }) + '\n');
    });
  }
  async status() {
    if (this.child) {
      const result = await this.request('status');
      this.snapshot = { state: String(result.state), loginUrl: loginURL(result.loginUrl), address: isTailscaleIPv4(result.address) ? result.address : null,
        deviceId: typeof result.deviceId === 'string' ? result.deviceId : '', hostName: typeof result.hostName === 'string' ? result.hostName : '',
        online: result.online === true, health: Array.isArray(result.health) ? result.health.filter(value => typeof value === 'string') : [],
        selfUserId: typeof result.selfUserId === 'string' ? result.selfUserId : '',
        selfLoginName: typeof result.selfLoginName === 'string' ? result.selfLoginName : '',
        selfDisplayName: typeof result.selfDisplayName === 'string' ? result.selfDisplayName : '',
        tailnet: typeof result.tailnet === 'string' ? result.tailnet : '' };
    }
    return { ...this.snapshot };
  }
  async login() {
    await this.start();
    if (!this.snapshot.loginUrl) await this.request('login');
    return this.status();
  }
  async openLogin() {
    const status = await this.status();
    const url = loginURL(status.loginUrl);
    if (!url) throw new Error('Login link is not ready. Wait a moment and retry.');
    await this.openExternal(url);
  }
  async listen(target, token) { return this.request('listen', { target, token }); }
  async setHostname(hostname) {
    if (!this.child) return { hostName: '' };
    // Null keeps the node's registered name: there is nothing to send and an
    // empty string would tell the helper to restore its platform fallback.
    if (hostname === null) return { hostName: '' };
    hostname = tailscaleHostname(hostname);
    if (!hostname) return { hostName: '' };
    const result = await this.request('set-hostname', { hostname });
    const hostName = typeof result?.hostName === 'string' ? result.hostName : '';
    if (hostName) this.snapshot = { ...this.snapshot, hostName };
    return { hostName };
  }
  identity() {
    return { deviceId: this.snapshot.deviceId || '', hostName: this.snapshot.hostName || '', address: this.snapshot.address || null,
      userId: this.snapshot.selfUserId || '', login: this.snapshot.selfLoginName || '',
      displayName: this.snapshot.selfDisplayName || '', tailnet: this.snapshot.tailnet || '' };
  }
  async diagnosePeer(address) {
    if (!isTailscaleIPv4(address)) throw new Error('Invalid diagnostic peer address');
    if (!this.child) throw new Error('Enable mobile access first');
    try { return await this.request('diagnose-peer', { target: address }); }
    catch (error) {
      if (error.message === 'unsupported network action') throw new Error('Network diagnostics require the updated helper. Fully quit Camellia, including the tray, and restart it.');
      throw error;
    }
  }
  async logout() {
    await this.start();
    await this.request('logout');
    await this.stop();
  }
  rejectPending(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  async stop() {
    const child = this.child;
    this.child = null;
    this.snapshot = { state: 'Stopped', loginUrl: null, address: null };
    this.rejectPending(new Error('Embedded network stopped'));
    if (!child) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
  }
}

module.exports = { EmbeddedNetwork, bundleDirectory, loginURL, storageKey, promoteHelper, tailscaleHostname, embeddedNetworkEnvironment, EMBEDDED_NETWORK_ENV };
