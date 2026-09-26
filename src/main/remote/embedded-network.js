'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { createInterface } = require('node:readline');
const { isTailscaleIPv4 } = require('./tailscale');
const { DeviceTransport, deviceAddress } = require('./device-transport');

function loginURL(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'login.tailscale.com' && !url.username && !url.password && !url.port) return url.href;
  } catch {}
  return null;
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

class EmbeddedNetwork {
  constructor({ app, safeStorage, directory, executable, keyProvider, hostname, openExternal, onFailure = () => {}, spawnProcess = spawn }) {
    if (hostname !== undefined && (typeof hostname !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname))) throw new Error('Invalid Tailscale hostname');
    Object.assign(this, { app, safeStorage, directory, executable, keyProvider, hostname, openExternal, onFailure, spawnProcess });
    this.pending = new Map();
    this.connections = new Set();
    this.sequence = 0;
    this.snapshot = { state: 'Stopped', loginUrl: null, address: null };
  }
  async start() {
    if (this.child) return;
    const directory = this.directory || path.join(this.app.getPath('userData'), 'remote', 'tailnet');
    const executable = this.executable || path.join(this.app.isPackaged ? path.join(process.resourcesPath, 'runtime') : path.resolve(__dirname, '../../../build/runtime-assets'),
      process.platform === 'win32' ? 'camellia-tailnet.exe' : 'camellia-tailnet');
    if (!fs.existsSync(executable)) throw new Error('Embedded network helper is missing. Reinstall Camellia; source builds must run npm run build:tailnet.');
    const key = this.keyProvider ? this.keyProvider(directory) : storageKey(directory, this.safeStorage);
    if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, 'base64').length !== 32) throw new Error('Invalid embedded network storage key');
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^TS(?:NET)?_/i.test(name)));
    const child = this.spawnProcess(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, TS_NO_LOGS_NO_SUPPORT: 'true' } });
    this.child = child;
    this.snapshot = { state: 'Starting', loginUrl: null, address: null };
    const fail = () => {
      if (this.child !== child) return;
      this.child = null;
      this.snapshot = { state: 'Error', loginUrl: null, address: null };
      this.rejectPending(new Error('Embedded network stopped unexpectedly. Disable and enable mobile access to retry.'));
      this.closeConnections();
      child.kill();
      this.onFailure();
    };
    child.on('error', fail);
    child.on('exit', fail);
    child.stdin.on('error', fail);
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let response;
      try { response = JSON.parse(line); } catch { fail(); return; }
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.error) pending.reject(new Error(response.error));
      else pending.resolve(response.result);
    });
    try { await this.request('init', { directory, key, ...(this.hostname ? { hostname: this.hostname } : {}) }); }
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
      this.snapshot = { state: String(result.state), loginUrl: loginURL(result.loginUrl), address: isTailscaleIPv4(result.address) ? result.address : null };
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
  async connect(address) {
    deviceAddress(address);
    if (!this.child) throw new Error('Start and sign into embedded networking before connecting a device');
    const child = this.child;
    const token = randomBytes(32).toString('hex');
    const result = await this.request('connect', { target: address, token });
    if (this.child !== child) throw new Error('Network changed while connecting');
    let connection;
    try {
      connection = new DeviceTransport({ url: result.url, token, disconnect: async () => {
        this.connections.delete(connection);
        if (this.child === child) await this.request('disconnect', { token });
      } });
    } catch (error) { await this.request('disconnect', { token }); throw error; }
    this.connections.add(connection);
    return connection;
  }
  closeConnections() {
    for (const connection of this.connections) {
      connection.disconnect = null;
      void connection.close();
    }
    this.connections.clear();
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
    this.closeConnections();
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

module.exports = { EmbeddedNetwork, loginURL, storageKey };
