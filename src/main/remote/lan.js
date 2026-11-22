'use strict';

const fs = require('node:fs');
const dgram = require('node:dgram');
const os = require('node:os');
const path = require('node:path');
const { X509Certificate, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } = require('node:crypto');
const selfsigned = require('selfsigned');
const { Bonjour } = require('bonjour-service');
const { readJson, writeJson } = require('../../shared/json-store');
const { fail } = require('./access');

const PROTOCOL_VERSION = 1;
const PIN_PATTERN = /^\d{6}$/;
const MAX_FAILURES = 5;
const LOCK_MS = 10 * 60_000;
const DISCOVERY_PORT = 52638;
const DISCOVERY_MESSAGE = 'CAMELLIA_DISCOVER_V1';
const DISCOVERY_MULTICAST = '239.192.52.63';
const PRIVATE_NAME = /^(?:10\.|127\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
const VIRTUAL_NAME = /(?:vethernet|virtual|vmware|virtualbox|docker|wsl|hyper-v|loopback|tailscale|zerotier|bluetooth|^(?:utun|bridge|vmnet|tap|tun)\d+$)/i;

function isPrivateIPv4(value) {
  if (typeof value !== 'string') return false;
  const address = value.startsWith('::ffff:') ? value.slice(7) : value;
  if (!PRIVATE_NAME.test(address)) return false;
  const parts = address.split('.');
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function normalizePin(value) {
  if (typeof value !== 'string' || !PIN_PATTERN.test(value.trim())) throw new Error('The LAN PIN must contain exactly six digits');
  return value.trim();
}

function secureFile(file) {
  try { fs.chmodSync(file, 0o600); } catch { /* Windows ACLs cover this file. */ }
}

function writePrivateJson(file, value) {
  writeJson(file, value);
  secureFile(file);
}

function hashPin(pin, salt) {
  return scryptSync(pin, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
}

function equalHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function randomPin() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function interfaceScore(name, address) {
  let score = 0;
  if (VIRTUAL_NAME.test(name)) score -= 100;
  if (/(?:wi-?fi|wlan|wireless)/i.test(name)) score += 20;
  else if (/(?:ethernet|eth|lan|^en\d+$)/i.test(name)) score += 10;
  if (address.startsWith('192.168.')) score += 4;
  else if (address.startsWith('10.')) score += 2;
  return score;
}

function lanAddresses(interfaces = os.networkInterfaces()) {
  const result = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const entry of addresses || []) {
      const family = typeof entry.family === 'string' ? entry.family : entry.family === 4 ? 'IPv4' : '';
      if (family !== 'IPv4' || entry.internal || !isPrivateIPv4(entry.address)) continue;
      result.push({ name, address: entry.address, netmask: entry.netmask || '', score: interfaceScore(name, entry.address) });
    }
  }
  return result.sort((left, right) => right.score - left.score || left.address.localeCompare(right.address));
}

function chooseLanAddress(interfaces = os.networkInterfaces()) {
  return lanAddresses(interfaces)[0]?.address || null;
}

function addressSignature(interfaces = os.networkInterfaces()) {
  return lanAddresses(interfaces).map(entry => `${entry.name}:${entry.address}`).join('|');
}

class LanAccess {
  constructor({ file, access, safeStorage = null, now = Date.now, log = () => {} }) {
    Object.assign(this, { file, access, safeStorage, now, log });
    this.state = readJson(file, null);
    if (this.state && this.state.version !== PROTOCOL_VERSION) this.state = null;
    this.failures = new Map();
  }

  save() {
    writePrivateJson(this.file, this.state);
  }

  ensureState() {
    if (this.state) return this.state;
    this.state = {
      version: PROTOCOL_VERSION,
      computerId: randomUUID(),
      enabled: false,
      allowJoin: true,
      pinSalt: '',
      pinHash: '',
      sealedPin: '',
      createdAt: this.now(),
    };
    this.save();
    return this.state;
  }

  enabled() {
    return this.ensureState().enabled === true;
  }

  computerId() {
    return this.ensureState().computerId;
  }

  hasPin() {
    return /^[a-f0-9]{64}$/.test(this.ensureState().pinHash) && /^[a-f0-9]{32}$/.test(this.ensureState().pinSalt);
  }

  decodePin() {
    const sealed = this.ensureState().sealedPin;
    if (!sealed || !this.safeStorage?.isEncryptionAvailable?.()) return '';
    try { return this.safeStorage.decryptString(Buffer.from(sealed, 'base64')); }
    catch (error) { this.log('LAN PIN could not be decrypted: ' + error.message); return ''; }
  }

  view() {
    const state = this.ensureState();
    return {
      enabled: state.enabled === true,
      allowJoin: state.allowJoin !== false,
      hasPin: this.hasPin(),
      pin: this.decodePin(),
      computerId: state.computerId,
    };
  }

  setEnabled(value) {
    const state = this.ensureState();
    state.enabled = value === true;
    this.save();
    return this.view();
  }

  setAllowJoin(value) {
    const state = this.ensureState();
    state.allowJoin = value === true;
    this.save();
    return this.view();
  }

  setPin(value) {
    const pin = normalizePin(value);
    const state = this.ensureState();
    const salt = randomBytes(16).toString('hex');
    state.pinSalt = salt;
    state.pinHash = hashPin(pin, salt);
    state.sealedPin = '';
    try {
      if (this.safeStorage?.isEncryptionAvailable?.()) {
        state.sealedPin = this.safeStorage.encryptString(pin).toString('base64');
      }
    } catch (error) {
      this.log('LAN PIN could not be sealed: ' + error.message);
    }
    this.failures.clear();
    this.save();
    return this.view();
  }

  ensurePin() {
    if (!this.hasPin()) return this.setPin(randomPin());
    return this.view();
  }

  lockKey(remoteAddress) {
    return typeof remoteAddress === 'string' && remoteAddress ? remoteAddress : 'unknown';
  }

  verifyPin(pin, remoteAddress) {
    const state = this.ensureState();
    if (!this.hasPin()) fail(409, 'Set a LAN PIN on the desktop first');
    const key = this.lockKey(remoteAddress);
    const prior = this.failures.get(key);
    if (prior?.until > this.now()) fail(429, 'Too many incorrect LAN PIN attempts; try again later');
    if (prior?.until && prior.until <= this.now()) this.failures.delete(key);
    let supplied;
    try { supplied = normalizePin(pin); }
    catch { fail(401, 'Incorrect LAN PIN'); }
    if (!equalHex(hashPin(supplied, state.pinSalt), state.pinHash)) {
      const next = this.failures.get(key) || { count: 0, until: 0 };
      next.count++;
      if (next.count >= MAX_FAILURES) {
        next.count = 0;
        next.until = this.now() + LOCK_MS;
      }
      this.failures.set(key, next);
      fail(401, 'Incorrect LAN PIN');
    }
    this.failures.delete(key);
  }

  join({ pin, name, token, remoteAddress } = {}) {
    const state = this.ensureState();
    if (state.enabled !== true) fail(403, 'LAN access is disabled');
    this.verifyPin(pin, remoteAddress);
    if (typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)) {
      try {
        const device = this.access.authenticate(token);
        return { deviceId: device.id, token, permission: device.permission };
      } catch { /* A revoked token still joins with the shared PIN. */ }
    }
    if (state.allowJoin === false) fail(403, 'New LAN devices are not allowed');
    return this.access.enroll(name);
  }
}

class LanIdentity {
  constructor({ file, log = () => {}, computerId = randomUUID() }) {
    Object.assign(this, { file, log, computerId });
    this.state = readJson(file, null);
    if (!this.valid(this.state)) this.state = null;
    else this.computerId = this.state.computerId;
  }

  valid(value) {
    return value && value.version === PROTOCOL_VERSION && /^[a-f0-9]{64}$/.test(value.fingerprint || '')
      && typeof value.certificate === 'string' && typeof value.privateKey === 'string' && value.computerId;
  }

  create() {
    const generated = selfsigned.generate([{ name: 'commonName', value: 'Camellia LAN' }], {
      keySize: 2048,
      days: 3650,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
      ],
    });
    const certificate = new X509Certificate(generated.cert);
    const fingerprint = certificate.fingerprint256.replace(/:/g, '').toLowerCase();
    this.state = {
      version: PROTOCOL_VERSION,
      computerId: this.computerId,
      certificate: generated.cert,
      privateKey: generated.private,
      fingerprint,
      createdAt: Date.now(),
    };
    writePrivateJson(this.file, this.state);
  }

  get() {
    if (!this.state) this.create();
    return this.state;
  }

  peek() {
    return { computerId: this.state?.computerId || this.computerId, fingerprint: this.state?.fingerprint || '' };
  }

  view() {
    const state = this.get();
    return { computerId: state.computerId, fingerprint: state.fingerprint };
  }
}

class LanUdpDiscovery {
  constructor({ createSocket = type => dgram.createSocket(type), port = DISCOVERY_PORT, log = () => {} }) {
    Object.assign(this, { createSocket, port, log });
    this.socket = null;
    this.info = null;
  }

  start(info) {
    this.stop();
    this.info = { ...info };
    const socket = this.createSocket('udp4');
    this.socket = socket;
    socket.on('error', error => {
      this.log('LAN broadcast discovery: ' + error.message);
      if (this.socket === socket) {
        try { socket.close(); } catch { /* Already closed. */ }
        this.socket = null;
      }
    });
    socket.on('message', (message, remote) => {
      if (!this.info || Buffer.byteLength(message) !== Buffer.byteLength(DISCOVERY_MESSAGE)
          || message.toString('utf8') !== DISCOVERY_MESSAGE) return;
      if (!remote || !isPrivateIPv4(remote.address)) return;
      const info = this.info;
      const payload = JSON.stringify({
        v: PROTOCOL_VERSION,
        id: info.computerId,
        name: info.computerName || 'Camellia desktop',
        ip: info.address,
        port: info.port,
        fp: info.fingerprint,
        join: info.allowJoin === false ? 0 : 1,
      });
      try { socket.send(payload, remote.port, remote.address); }
      catch (error) { this.log('LAN broadcast reply: ' + error.message); }
    });
    socket.on('listening', () => {
      try { socket.addMembership(DISCOVERY_MULTICAST, this.info.address); }
      catch (error) { this.log('LAN multicast join: ' + error.message); }
    });
    try { socket.bind({ address: '0.0.0.0', port: this.port, exclusive: true }); }
    catch (error) {
      this.log('LAN broadcast discovery: ' + error.message);
      this.stop();
    }
  }

  update(info) {
    if (!this.socket) return this.start(info);
    this.info = { ...info };
  }

  stop() {
    const socket = this.socket;
    this.socket = null;
    this.info = null;
    if (!socket) return;
    try { socket.close(); } catch { /* Already closed. */ }
  }
}

class LanDiscovery {
  constructor({ createBonjour = (options, onError) => new Bonjour(options, onError), createUdpSocket,
    discoveryPort = DISCOVERY_PORT, log = () => {} }) {
    Object.assign(this, { createBonjour, log });
    this.bonjour = null;
    this.service = null;
    this.info = null;
    this.udp = new LanUdpDiscovery({ createSocket: createUdpSocket, port: discoveryPort, log });
  }

  start(info) {
    this.stop();
    const record = {
      name: `Camellia ${String(info.computerId || '').slice(0, 8)}`,
      type: 'camellia',
      port: info.port,
      disableIPv6: true,
      txt: {
        v: String(PROTOCOL_VERSION),
        id: info.computerId,
        ip: info.address,
        fp: info.fingerprint,
        name: info.computerName || 'Camellia',
        join: info.allowJoin === false ? '0' : '1',
      },
    };
    this.info = { ...info };
    this.udp.start(this.info);
    this.bonjour = this.createBonjour({}, error => this.log('LAN discovery: ' + error.message));
    this.service = this.bonjour.publish(record);
    this.service.on?.('error', error => this.log('LAN discovery service: ' + error.message));
    return record;
  }

  update(info) {
    if (!this.service) return this.start(info);
    const previous = this.info || {};
    const changed = previous.allowJoin !== info.allowJoin || previous.computerName !== info.computerName
      || previous.address !== info.address || previous.port !== info.port || previous.fingerprint !== info.fingerprint;
    Object.assign(this.info, info);
    this.udp.update(this.info);
    if (changed) this.start({ ...previous, ...info });
    return this.info;
  }

  stop() {
    this.udp.stop();
    try { this.service?.stop?.(); } catch (error) { this.log('LAN discovery stop: ' + error.message); }
    this.service = null;
    try { this.bonjour?.destroy?.(); } catch (error) { this.log('LAN discovery destroy: ' + error.message); }
    this.bonjour = null;
    this.info = null;
  }
}

module.exports = {
  DISCOVERY_MESSAGE,
  DISCOVERY_MULTICAST,
  DISCOVERY_PORT,
  LOCK_MS,
  MAX_FAILURES,
  PROTOCOL_VERSION,
  LanAccess,
  LanDiscovery,
  LanIdentity,
  LanUdpDiscovery,
  addressSignature,
  chooseLanAddress,
  isPrivateIPv4,
  lanAddresses,
  normalizePin,
  randomPin,
};
