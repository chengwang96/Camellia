'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { readJson, writeJson } = require('../../shared/json-store');

const PROTOCOL_VERSION = 1;
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_LAUNCH_GRACE_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_STATUS_FRESH_MS = 15_000;

function absolute(value) {
  return typeof value === 'string' && value && path.isAbsolute(value);
}

async function writeEphemeral(file, value) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.promises.writeFile(temporary, JSON.stringify(value) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.promises.rename(temporary, file);
  } finally {
    try { await fs.promises.unlink(temporary); } catch { /* A completed rename already removed it. */ }
  }
}

function processMatches(pid, executable) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(false);
  const windows = process.platform === 'win32';
  const file = windows ? 'tasklist.exe' : 'ps';
  const args = windows ? ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'] : ['-p', String(pid), '-o', 'comm='];
  return new Promise(resolve => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true }, (error, output) => {
      if (error) { resolve(false); return; }
      const name = windows ? `"${path.basename(executable).toLowerCase()}"` : path.basename(executable).toLowerCase();
      resolve(windows ? output.toLowerCase().includes(name) : path.basename(output.trim()).toLowerCase() === name);
    });
  });
}

class RemoteGuard {
  constructor({ directory, executable, appCommand, setAutoStart = () => {}, getAutoStart = () => false,
    powerSaveBlocker = null, log = () => {}, spawnProcess = spawn, heartbeatMs = DEFAULT_HEARTBEAT_MS,
    staleMs = DEFAULT_STALE_MS, launchGraceMs = DEFAULT_LAUNCH_GRACE_MS, statusFreshMs = DEFAULT_STATUS_FRESH_MS,
    now = Date.now }) {
    Object.assign(this, { directory, executable, appCommand, setAutoStart, getAutoStart, powerSaveBlocker, log,
      spawnProcess, heartbeatMs, staleMs, launchGraceMs, statusFreshMs, now });
    this.pending = false;
    this.settingsFile = path.join(directory, 'settings.json');
    this.specFile = path.join(directory, 'spec.json');
    this.heartbeatFile = path.join(directory, 'heartbeat.json');
    this.stopFile = path.join(directory, 'stop');
    this.statusFile = path.join(directory, 'status.json');
    this.lockFile = path.join(directory, 'guard.lock');
    this.heartbeatTimer = null;
    this.spawnedAt = 0;
    this.blockerId = null;
    this.child = null;
    this.heartbeatWrite = null;
    this.heartbeatEpoch = 0;
    this.checking = null;
  }

  supported() {
    return ['win32', 'darwin'].includes(process.platform);
  }

  available() {
    return this.supported() && absolute(this.executable) && fs.existsSync(this.executable);
  }

  enabled() {
    try {
      const saved = readJson(this.settingsFile, null);
      return saved?.version === PROTOCOL_VERSION && saved.enabled === true;
    } catch (error) {
      this.log('Remote guard preference: ' + error.message);
      return false;
    }
  }

  command() {
    const command = this.appCommand;
    if (!command || !absolute(command.executable) || !absolute(command.cwd)
        || !Array.isArray(command.args) || command.args.some(value => typeof value !== 'string')) return null;
    return command;
  }

  setPreference(enabled) {
    writeJson(this.settingsFile, { version: PROTOCOL_VERSION, enabled: enabled === true });
  }

  writeSpec() {
    const command = this.command();
    if (!command) throw new Error('Remote guard launch details are unavailable');
    writeJson(this.specFile, {
      version: PROTOCOL_VERSION,
      app: command.executable,
      args: command.args,
      cwd: command.cwd,
      heartbeat: this.heartbeatFile,
      stop: this.stopFile,
      status: this.statusFile,
      lock: this.lockFile,
      log: path.join(path.dirname(this.directory), 'logs', 'remote-guard.log'),
      staleMs: this.staleMs,
      launchGraceMs: this.launchGraceMs,
    });
  }

  writeHeartbeat() {
    const epoch = this.heartbeatEpoch;
    const write = async () => {
      if (epoch === this.heartbeatEpoch)
        await writeEphemeral(this.heartbeatFile, { version: PROTOCOL_VERSION, pid: process.pid, at: this.now() });
    };
    this.heartbeatWrite = (this.heartbeatWrite || Promise.resolve()).then(write, write);
    return this.heartbeatWrite;
  }

  startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatEpoch++;
    this.writeHeartbeat().catch(error => this.log('Remote guard heartbeat: ' + error.message));
    this.heartbeatTimer = setInterval(() => {
      this.writeHeartbeat().catch(error => this.log('Remote guard heartbeat: ' + error.message));
    }, this.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  stopHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.heartbeatEpoch++;
  }

  startPowerBlocker() {
    if (this.blockerId !== null || !this.powerSaveBlocker || typeof this.powerSaveBlocker.start !== 'function') return;
    try {
      this.blockerId = this.powerSaveBlocker.start('prevent-app-suspension');
    } catch (error) {
      this.log('Remote guard power setting: ' + error.message);
    }
  }

  stopPowerBlocker() {
    if (this.blockerId === null || !this.powerSaveBlocker || typeof this.powerSaveBlocker.stop !== 'function') return;
    try {
      if (typeof this.powerSaveBlocker.isStarted !== 'function' || this.powerSaveBlocker.isStarted(this.blockerId)) {
        this.powerSaveBlocker.stop(this.blockerId);
      }
    } catch (error) {
      this.log('Remote guard power cleanup: ' + error.message);
    } finally {
      this.blockerId = null;
    }
  }

  updateAutoStart(enabled) {
    try { this.setAutoStart(enabled === true); }
    catch (error) { this.log('Remote guard login item: ' + error.message); }
  }

  readStatus() {
    try {
      const value = readJson(this.statusFile, null);
      if (value?.product !== 'camellia-remote-guard' || value.version !== PROTOCOL_VERSION
          || !Number.isInteger(value.pid) || value.pid <= 0 || !Number.isFinite(value.at)) return null;
      return { ...value, fresh: this.now() - value.at <= this.statusFreshMs };
    } catch { return null; }
  }

  async removeStaleGuard(status) {
    const pid = status?.pid;
    if (pid !== process.pid && await processMatches(pid, this.executable)) {
      try { process.kill(pid); }
      catch (error) { this.log('Remote guard stale process: ' + error.message); }
    }
    for (const file of [this.statusFile, this.lockFile]) {
      try { await fs.promises.unlink(file); } catch { /* Already absent. */ }
    }
  }

  spawnGuard() {
    const child = this.spawnProcess(this.executable, [this.specFile], {
      detached: true, windowsHide: true, stdio: 'ignore',
    });
    this.child = child;
    this.spawnedAt = this.now();
    child.once('error', error => this.log('Remote guard process: ' + error.message));
    child.once('exit', () => { if (this.child === child) this.child = null; });
    child.unref();
  }

  async ensureStarted() {
    if (this.checking) return this.checking;
    const check = async () => {
      const epoch = this.heartbeatEpoch;
      if (!this.enabled() || !this.available()) return false;
      const status = this.readStatus();
      if (status?.fresh) return false;
      if (!this.pending && this.spawnedAt && this.now() - this.spawnedAt < this.statusFreshMs) return false;
      let lockAge = Infinity;
      try { lockAge = this.now() - (await fs.promises.stat(this.lockFile)).mtimeMs; } catch { /* No lock. */ }
      if (!this.pending && lockAge < this.statusFreshMs) return false;
      await this.removeStaleGuard(status);
      if (epoch !== this.heartbeatEpoch) return false;
      try {
        this.spawnGuard();
        this.pending = false;
        return true;
      } catch (error) {
        this.pending = false;
        this.log('Remote guard launch: ' + error.message);
        return false;
      }
    };
    this.checking = check();
    try { return await this.checking; }
    finally { this.checking = null; }
  }

  start() {
    if (!this.enabled()) return false;
    if (!this.available()) throw new Error('Remote guard helper is missing. Run npm run build:remote-guard or reinstall Camellia.');
    const command = this.command();
    if (!command) throw new Error('Remote guard launch details are unavailable');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try { fs.unlinkSync(this.stopFile); } catch { /* Already absent. */ }
    this.writeSpec();
    this.startHeartbeat();
    this.startPowerBlocker();
    this.updateAutoStart(true);
    this.ensureStarted();
    return true;
  }

  enable() {
    if (!this.supported()) throw new Error('Remote online guard is available on desktop only');
    if (!this.available()) throw new Error('Remote guard helper is missing. Run npm run build:remote-guard or reinstall Camellia.');
    this.setPreference(true);
    try { return this.start(); }
    catch (error) {
      try { this.setPreference(false); } catch { /* Preserve the original launch failure. */ }
      throw error;
    }
  }

  pause() {
    this.pending = false;
    this.spawnedAt = 0;
    this.stopHeartbeat();
    this.stopPowerBlocker();
    if (!fs.existsSync(this.heartbeatFile) && fs.existsSync(this.stopFile) && !this.child) return;
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.stopFile, `${this.now()}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.unlinkSync(this.heartbeatFile);
    } catch (error) {
      if (error.code !== 'ENOENT') this.log('Remote guard pause: ' + error.message);
    }
    if (this.child) {
      try { this.child.kill(); } catch { /* The guard may already have exited. */ }
      this.child = null;
    }
  }

  disable() {
    this.setPreference(false);
    this.pause();
    this.updateAutoStart(false);
  }

  view() {
    const status = this.readStatus();
    let autoStart = false;
    try { autoStart = Boolean(this.getAutoStart()); }
    catch (error) { this.log('Remote guard login state: ' + error.message); }
    let heartbeatAt = null;
    try {
      const value = readJson(this.heartbeatFile, null);
      if (value?.version === PROTOCOL_VERSION && Number.isFinite(value.at)) heartbeatAt = value.at;
    } catch { /* A partial heartbeat is no more useful than an absent one. */ }
    return {
      supported: this.supported(),
      available: this.available(),
      enabled: this.enabled(),
      running: Boolean(status?.fresh),
      retrying: status?.state === 'retrying',
      launches: Number.isInteger(status?.launches) ? status.launches : 0,
      autoStart,
      heartbeatAt,
    };
  }

  close() {
    this.pause();
  }
}

module.exports = { RemoteGuard, PROTOCOL_VERSION, DEFAULT_STALE_MS, DEFAULT_HEARTBEAT_MS };
