'use strict';

const { randomUUID } = require('node:crypto');
const { readJson, writeJson } = require('../../shared/json-store');
const { deviceAddress } = require('./device-transport');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const credential = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
function secureStorage(storage) {
  if (!storage?.isEncryptionAvailable() || storage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('Unlock secure system storage before adding CLI devices');
}
function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[\x00-\x1f\x7f-\x9f]/.test(value)) throw new Error('Device name must contain 1–80 printable characters');
  return value.trim();
}
function validRecord(record) {
  if (!record || !UUID.test(record.id) || !UUID.test(record.remoteDeviceId) || !credential(record.token)) throw new Error('Invalid saved CLI device');
  deviceAddress(record.address); name(record.name);
}

class DeviceClient {
  constructor({ file, safeStorage, network, now = Date.now }) {
    Object.assign(this, { file, safeStorage, network, now });
    this.records = null;
    this.connections = new Map();
    this.pending = new Map();
    this.closed = false;
  }
  load() {
    if (this.closed) throw new Error('Device client is closed');
    secureStorage(this.safeStorage);
    if (this.records) return this.records;
    const saved = readJson(this.file, null);
    if (!saved) { this.records = []; return this.records; }
    try {
      if (saved.version !== 1 || typeof saved.encrypted !== 'string') throw new Error();
      const records = JSON.parse(this.safeStorage.decryptString(Buffer.from(saved.encrypted, 'base64')));
      if (!Array.isArray(records) || records.length > 32) throw new Error();
      records.forEach(validRecord);
      if (new Set(records.map(record => record.id)).size !== records.length || new Set(records.map(record => record.address)).size !== records.length) throw new Error();
      this.records = records;
    } catch { throw new Error('Cannot unlock saved CLI devices; no credentials were changed'); }
    return this.records;
  }
  save(records) {
    secureStorage(this.safeStorage);
    records.forEach(validRecord);
    const encrypted = this.safeStorage.encryptString(JSON.stringify(records)).toString('base64');
    writeJson(this.file, { version: 1, encrypted });
    this.records = records;
  }
  list() {
    return this.load().map(({ id, name, address, createdAt }) => ({ id, name, address, createdAt }));
  }
  record(id) {
    const record = this.load().find(entry => entry.id === id);
    if (!record) throw new Error('CLI device not found');
    return record;
  }
  async connection(address) {
    if (this.closed) throw new Error('Device client is closed');
    const existing = this.connections.get(address);
    if (existing) {
      const connection = await existing;
      if (!connection.closed) return connection;
      this.connections.delete(address);
    }
    if (this.connections.size >= 8) throw new Error('Disconnect a CLI device before opening another connection');
    const promise = this.network.connect(address);
    this.connections.set(address, promise);
    try {
      const connection = await promise;
      if (this.closed || this.connections.get(address) !== promise) { await connection.close(); throw new Error('Device connection cancelled'); }
      return connection;
    } catch (error) {
      if (this.connections.get(address) === promise) this.connections.delete(address);
      throw error;
    }
  }
  async disconnect(address) {
    const pending = this.connections.get(address);
    this.connections.delete(address);
    if (pending) { const connection = await pending.catch(() => null); await connection?.close(); }
  }
  prune() {
    for (const [id, pending] of this.pending) if (pending.expiresAt <= this.now()) {
      this.pending.delete(id);
      void this.disconnect(pending.address).catch(() => {});
    }
  }
  async pair({ address, code, clientName, deviceName }) {
    deviceAddress(address); name(clientName); name(deviceName);
    if (!/^[a-f0-9]{24}$/.test(code)) throw new Error('Invalid one-time pairing code');
    const records = this.load();
    if (records.some(record => record.address === address)) throw new Error('This CLI device is already saved');
    if (records.length >= 32) throw new Error('Remove a saved CLI device before pairing another');
    this.prune();
    if (this.pending.size >= 8 || [...this.pending.values()].some(entry => entry.address === address)) throw new Error('Pairing is already pending or the pairing limit was reached');
    const id = randomUUID();
    const pending = { address, name: name(deviceName), expiresAt: this.now() + 5 * 60_000 };
    this.pending.set(id, pending);
    try {
      const connection = await this.connection(address);
      const result = await connection.json('/v1/pair/request', { method: 'POST', body: { code, name: name(clientName) } });
      if (!UUID.test(result.id) || !credential(result.claim) || !Number.isFinite(result.expiresAt)) throw new Error('Invalid pairing response');
      if (this.closed || !this.pending.has(id)) throw new Error('Pairing cancelled');
      Object.assign(pending, { requestId: result.id, claim: result.claim, expiresAt: Math.min(pending.expiresAt, result.expiresAt) });
      return { id, state: 'pending', expiresAt: pending.expiresAt };
    } catch (error) { this.pending.delete(id); await this.disconnect(address).catch(() => {}); throw error; }
  }
  async claim(id) {
    this.load(); this.prune();
    const pending = this.pending.get(id);
    if (!pending?.claim) throw new Error('Pairing is missing or expired');
    if (pending.busy) throw new Error('Pairing check already in progress');
    pending.busy = true;
    try {
      const connection = await this.connection(pending.address);
      const result = await connection.json('/v1/pair/claim', { method: 'POST', body: { id: pending.requestId, claim: pending.claim } });
      if (this.closed || this.pending.get(id) !== pending) throw new Error('Pairing cancelled');
      if (result.state === 'pending') return { id, state: 'pending', expiresAt: pending.expiresAt };
      if (result.state !== 'approved' || result.permission !== 'control' || !UUID.test(result.deviceId) || !credential(result.token)) throw new Error('Invalid pairing approval');
      const record = { id, remoteDeviceId: result.deviceId, address: pending.address, name: pending.name, token: result.token, createdAt: this.now() };
      const current = this.load();
      if (current.length >= 32 || current.some(entry => entry.address === record.address)) throw new Error('Device list changed; cancel and pair again');
      this.save([...current, record]);
      this.pending.delete(id);
      return { id, state: 'approved', device: this.list().find(entry => entry.id === id) };
    } finally { pending.busy = false; }
  }
  async cancelPairing(id) {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    if (pending) await this.disconnect(pending.address);
  }
  async forget(id) {
    const record = this.record(id);
    this.save(this.records.filter(entry => entry.id !== id));
    await this.disconnect(record.address);
  }
  async json(id, endpoint, options = {}) {
    const record = this.record(id);
    const connection = await this.connection(record.address);
    if (this.record(id) !== record) throw new Error('CLI device changed during connection');
    return connection.json(endpoint, { ...options, bearer: record.token });
  }
  status(id) { return this.json(id, '/v1/status'); }
  nativeSettings(id, engine) {
    if (!['claude', 'codex', 'kimi', 'dsh', 'antigravity'].includes(engine)) throw new Error('Invalid engine');
    return this.json(id, `/v1/native-settings/${engine}`);
  }
  saveNativeSettings(id, payload) {
    if (!['claude', 'codex', 'kimi', 'dsh', 'antigravity'].includes(payload?.engine)) throw new Error('Invalid engine');
    return this.json(id, `/v1/native-settings/${payload.engine}`, { method: 'POST', body: payload });
  }
  conversations(id, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid conversation offset');
    return this.json(id, `/v1/conversations?offset=${offset}`);
  }
  archived(id, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid archive offset');
    return this.json(id, `/v1/archived?offset=${offset}`);
  }
  snapshot(id, conversationId, before) {
    if (!UUID.test(conversationId)) throw new Error('Invalid conversation ID');
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) throw new Error('Invalid history cursor');
    return this.json(id, `/v1/conversations/${conversationId}${before === undefined ? '' : `?before=${before}`}`);
  }
  artifacts(id, conversationId, offset = 0) {
    if (!UUID.test(conversationId) || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid artifact request');
    return this.json(id, `/v1/conversations/${conversationId}/artifacts?offset=${offset}`);
  }
  async artifact(id, conversationId, artifactId, signal) {
    if (!UUID.test(conversationId) || !/^[a-f0-9]{64}$/.test(artifactId)) throw new Error('Invalid artifact ID');
    const record = this.record(id);
    const connection = await this.connection(record.address);
    if (this.record(id) !== record) throw new Error('CLI device changed during connection');
    return connection.open(`/v1/conversations/${conversationId}/artifacts/${artifactId}`, { bearer: record.token, signal });
  }
  async command(id, conversationId, payload) {
    if (conversationId !== null && !UUID.test(conversationId)) throw new Error('Invalid conversation ID');
    if (!payload || !UUID.test(payload.requestId) || !UUID.test(payload.instanceId)) throw new Error('Commands require a stable request ID and current server instance');
    return this.json(id, conversationId ? `/v1/conversations/${conversationId}/commands` : '/v1/commands', { method: 'POST', body: payload });
  }
  async *events(id, conversationId = null, signal) {
    if (conversationId !== null && !UUID.test(conversationId)) throw new Error('Invalid conversation ID');
    const record = this.record(id);
    const connection = await this.connection(record.address);
    if (this.record(id) !== record) throw new Error('CLI device changed during connection');
    yield* connection.events(conversationId ? `/v1/conversations/${conversationId}/events` : '/v1/conversations/events', { bearer: record.token, signal });
  }
  async close() {
    if (this.closed) return;
    this.closed = true; this.pending.clear(); this.records = null;
    await Promise.allSettled([...this.connections.keys()].map(address => this.disconnect(address)));
  }
}

module.exports = { DeviceClient };
