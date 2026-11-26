'use strict';

const { randomBytes, randomUUID, createHash, timingSafeEqual } = require('node:crypto');
const { readJson, writeJson } = require('../../shared/json-store');
const { cleanIdentity } = require('./tailnet-trust');

const secret = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
function matches(value, digest) {
  if (typeof value !== 'string' || value.length > 512 || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) return false;
  return timingSafeEqual(Buffer.from(hash(value), 'hex'), Buffer.from(digest, 'hex'));
}
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function cleanName(value, { required = true } = {}) {
  if (typeof value !== 'string') { if (required) fail(400, 'Device name must contain 1–80 characters'); return null; }
  const trimmed = value.trim();
  if (!trimmed) { if (required) fail(400, 'Device name must contain 1–80 characters'); return null; }
  if (trimmed.length > 80 || /[\x00-\x1f\x7f-\x9f]/.test(trimmed)) fail(400, 'Device name must contain 1–80 printable characters');
  return trimmed;
}

class RemoteAccess {
  constructor({ file, now = Date.now, onRevoke = () => {}, tailnetTrust = null }) {
    Object.assign(this, { file, now, onRevoke, tailnetTrust });
    const stored = readJson(file, { devices: [] });
    if (!Array.isArray(stored.devices)) throw new Error('Invalid remote device store');
    this.devices = stored.devices;
    this.lastSeenAt = new Map(this.devices
      .map(device => [device.id, Number(device.lastSeenAt) || Number(device.createdAt) || 0])
      .filter(([, timestamp]) => timestamp > 0));
    this.lastSeenPersistedAt = new Map(this.devices
      .map(device => [device.id, Number(device.lastSeenAt) || 0])
      .filter(([, timestamp]) => timestamp > 0));
    if (this.devices.some(device => device.permission !== 'control')) {
      this.save(this.devices.map(device => ({ ...device, permission: 'control' })));
    }
    this.pending = new Map();
    this.invitation = null;
  }
  save(devices) { writeJson(this.file, { devices }); this.devices = devices; }
  markSeen(id, timestamp) {
    this.lastSeenAt.set(id, timestamp);
    const persisted = this.lastSeenPersistedAt.get(id) || 0;
    if (timestamp - persisted < 60_000) return;
    try {
      this.save(this.devices.map(device => device.id === id ? { ...device, lastSeenAt: timestamp } : device));
      this.lastSeenPersistedAt.set(id, timestamp);
    } catch { }
  }
  prune() {
    for (const [id, request] of this.pending) if (request.expiresAt <= this.now()) this.pending.delete(id);
    if (this.invitation?.expiresAt <= this.now()) this.invitation = null;
  }
  scope(workspaceIds, { allWorkspaces = false, includeUnassigned = false } = {}) {
    if (typeof allWorkspaces !== 'boolean' || typeof includeUnassigned !== 'boolean' || !Array.isArray(workspaceIds)
      || workspaceIds.some(id => typeof id !== 'string' || !id) || (!workspaceIds.length && !allWorkspaces && !includeUnassigned)) fail(400, 'Select at least one workspace or independent conversations');
    return { workspaceIds: [...new Set(workspaceIds)], allWorkspaces, includeUnassigned };
  }
  invite(workspaceIds, options) {
    const scope = this.scope(workspaceIds, options);
    const computerName = cleanName(options?.computerName, { required: false });
    for (const [id, request] of this.pending) if (request.auth !== 'tailnet') this.pending.delete(id);
    const code = randomBytes(12).toString('hex');
    this.invitation = { digest: hash(code), ...scope, computerName, expiresAt: this.now() + 5 * 60_000 };
    return { code, computerName, expiresAt: this.invitation.expiresAt };
  }
  request({ code, name } = {}) {
    this.prune();
    if (!this.invitation || !matches(code, this.invitation.digest)) fail(401, 'Invalid or expired pairing code');
    const deviceName = cleanName(name);
    const id = randomUUID(), claim = secret();
    this.pending.set(id, { id, name: deviceName, computerName: this.invitation.computerName, claimDigest: hash(claim), auth: 'pairing',
      workspaceIds: this.invitation.workspaceIds,
      allWorkspaces: this.invitation.allWorkspaces, includeUnassigned: this.invitation.includeUnassigned,
      expiresAt: this.invitation.expiresAt, state: 'pending' });
    this.invitation = null;
    return { id, claim, computerName: this.pending.get(id).computerName, expiresAt: this.pending.get(id).expiresAt };
  }
  requestTailnet({ name } = {}, identity) {
    this.prune();
    const deviceName = cleanName(name);
    if (!this.tailnetTrust) fail(403, 'Tailnet trust is unavailable on this computer');
    const peer = cleanIdentity(identity);
    const decision = this.tailnetTrust.evaluate(peer);
    if (!decision.allowed) {
      fail(403, decision.reason === 'disabled' ? 'Tailnet trust is disabled on this computer'
        : decision.reason === 'identity_unavailable' ? 'Tailnet identity is unavailable; update and restart the desktop'
        : 'This Tailnet device is not allowed to connect');
    }
    if (!peer.nodeId || !peer.userId) fail(403, 'Tailnet identity is unavailable');
    if (this.devices.length >= 32) fail(409, 'Revoke an existing device before adding another');
    if (this.devices.some(device => device.tailnet?.nodeId === peer.nodeId)) {
      fail(409, 'This Tailnet device is already authorized; revoke it on the computer before pairing again');
    }
    // A retry replaces an unclaimed request from the same Tailscale node. The
    // previous claim secret is intentionally not recoverable.
    for (const [id, request] of this.pending) {
      if (request.auth === 'tailnet' && request.tailnet?.nodeId === peer.nodeId) this.pending.delete(id);
    }
    const id = randomUUID(), claim = secret();
    const request = { id, name: deviceName, claimDigest: hash(claim), auth: 'tailnet', tailnet: peer,
      workspaceIds: [], allWorkspaces: true, includeUnassigned: true,
      expiresAt: this.now() + 5 * 60_000, state: decision.autoApprove ? 'approved' : 'pending' };
    this.pending.set(id, request);
    return { id, claim, state: request.state, auth: 'tailnet', tailnet: peer, expiresAt: request.expiresAt };
  }
  approve(id) {
    this.prune();
    const request = this.pending.get(id);
    if (!request || request.state !== 'pending') fail(409, 'Pairing request is no longer pending');
    if (this.devices.length >= 32) fail(409, 'Revoke an existing device before adding another');
    request.state = 'approved';
  }
  reject(id) {
    const request = this.pending.get(id);
    if (!request || request.state === 'rejected') return;
    request.state = 'rejected';
  }
  claim(id, claim, identity = null) {
    this.prune();
    const request = this.pending.get(id);
    if (!request || !matches(claim, request.claimDigest)) fail(401, 'Invalid or expired pairing request');
    if (request.auth === 'tailnet') {
      if (!identity || identity.nodeId !== request.tailnet?.nodeId) fail(403, 'Tailnet device changed; request access again');
    }
    if (request.state === 'rejected') fail(401, 'Pairing request was rejected');
    if (request.state === 'pending') return { state: 'pending' };
    if (!request.token) {
      if (request.auth === 'tailnet' && this.devices.length >= 32) fail(409, 'Revoke an existing device before adding another');
      const token = secret();
      const createdAt = this.now();
      this.save([...this.devices, { id, name: request.name, tokenDigest: hash(token), auth: request.auth || 'pairing',
        ...(request.tailnet ? { tailnet: request.tailnet } : {}), workspaceIds: request.workspaceIds,
        allWorkspaces: request.allWorkspaces, includeUnassigned: request.includeUnassigned,
        createdAt, lastSeenAt: createdAt, permission: 'control' }]);
      this.lastSeenAt.set(id, createdAt);
      this.lastSeenPersistedAt.set(id, createdAt);
      request.token = token;
    }
    return { state: 'approved', deviceId: id, token: request.token, permission: 'control',
      auth: request.auth || 'pairing', ...(request.tailnet ? { tailnet: request.tailnet } : {}) };
  }
  enroll(name, { workspaceIds = [], allWorkspaces = true, includeUnassigned = true } = {}) {
    this.prune();
    const deviceName = cleanName(name);
    if (this.devices.length >= 32) fail(409, 'Revoke an existing device before adding another');
    const id = randomUUID(), token = secret();
    const createdAt = this.now();
    const scope = this.scope(workspaceIds, { allWorkspaces, includeUnassigned });
    this.save([...this.devices, { id, name: deviceName, tokenDigest: hash(token), auth: 'lan', ...scope,
      createdAt, lastSeenAt: createdAt, permission: 'control' }]);
    this.lastSeenAt.set(id, createdAt);
    this.lastSeenPersistedAt.set(id, createdAt);
    return { deviceId: id, token, permission: 'control', auth: 'lan' };
  }
  authenticate(token) {
    const device = this.devices.find(device => matches(token, device.tokenDigest));
    if (!device) fail(401, 'Device authentication required');
    this.pending.delete(device.id);
    this.markSeen(device.id, this.now());
    return device;
  }
  revoke(id) {
    this.save(this.devices.filter(device => device.id !== id));
    this.lastSeenAt.delete(id); this.lastSeenPersistedAt.delete(id);
    this.pending.delete(id);
    this.onRevoke(id);
  }
  setScope(id, workspaceIds, options) {
    if (!this.devices.some(device => device.id === id)) fail(400, 'Invalid device');
    const scope = this.scope(workspaceIds, options);
    this.save(this.devices.map(device => device.id === id ? { ...device, ...scope } : device));
    this.onRevoke(id);
  }
  // A paired device owns the name it reports for itself. The desktop can keep
  // a private label, but that label never changes what the device calls itself
  // or what the device sees for this computer.
  renameSelf(id, name) {
    const value = cleanName(name);
    if (!this.devices.some(device => device.id === id)) fail(400, 'Invalid device');
    this.save(this.devices.map(device => device.id === id ? { ...device, name: value } : device));
    return { id, name: value };
  }
  remark(id, label) {
    const value = cleanName(label, { required: false });
    if (!this.devices.some(device => device.id === id)) fail(400, 'Invalid device');
    this.save(this.devices.map(device => {
      if (device.id !== id) return device;
      if (value) return { ...device, remark: value };
      const { remark, ...rest } = device;
      return rest;
    }));
    return { id, remark: value };
  }
  view() {
    this.prune();
    return { devices: this.devices.map(({ id, name, remark, workspaceIds, allWorkspaces, includeUnassigned, createdAt, permission, auth, tailnet }) => ({ id, name, ...(remark ? { remark } : {}), workspaceIds, allWorkspaces, includeUnassigned, createdAt, lastSeenAt: this.lastSeenAt.get(id) || createdAt, permission, auth: auth || 'pairing', ...(tailnet ? { tailnet } : {}) })),
      pending: [...this.pending.values()].filter(request => (request.state === 'pending' || request.state === 'approved' || request.state === 'rejected')
        && !this.devices.some(device => device.id === request.id))
        .map(({ id, name, computerName, workspaceIds, allWorkspaces, includeUnassigned, expiresAt, state, auth, tailnet }) => ({ id, name, computerName, workspaceIds, allWorkspaces, includeUnassigned, expiresAt, state, auth: auth || 'pairing', ...(tailnet ? { tailnet } : {}) })) };
  }
  clearPairing() { this.invitation = null; this.pending.clear(); }
}

module.exports = { RemoteAccess, fail };
