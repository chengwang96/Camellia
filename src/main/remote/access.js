'use strict';

const { randomBytes, randomUUID, createHash, timingSafeEqual } = require('node:crypto');
const { readJson, writeJson } = require('../../shared/json-store');

const secret = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
function matches(value, digest) {
  if (typeof value !== 'string' || value.length > 512 || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) return false;
  return timingSafeEqual(Buffer.from(hash(value), 'hex'), Buffer.from(digest, 'hex'));
}
function fail(status, message) { throw Object.assign(new Error(message), { status }); }

class RemoteAccess {
  constructor({ file, now = Date.now, onRevoke = () => {} }) {
    Object.assign(this, { file, now, onRevoke });
    const stored = readJson(file, { devices: [] });
    if (!Array.isArray(stored.devices)) throw new Error('Invalid remote device store');
    this.devices = stored.devices;
    if (this.devices.some(device => device.permission !== 'control')) {
      this.save(this.devices.map(device => ({ ...device, permission: 'control' })));
    }
    this.pending = new Map();
    this.invitation = null;
  }
  save(devices) { writeJson(this.file, { devices }); this.devices = devices; }
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
    this.pending.clear();
    const code = randomBytes(12).toString('hex');
    this.invitation = { digest: hash(code), ...scope, expiresAt: this.now() + 5 * 60_000 };
    return { code, expiresAt: this.invitation.expiresAt };
  }
  request({ code, name } = {}) {
    this.prune();
    if (!this.invitation || !matches(code, this.invitation.digest)) fail(401, 'Invalid or expired pairing code');
    if (typeof name !== 'string' || !name.trim() || name.length > 80) fail(400, 'Device name must contain 1–80 characters');
    const id = randomUUID(), claim = secret();
    this.pending.set(id, { id, name: name.trim(), claimDigest: hash(claim), workspaceIds: this.invitation.workspaceIds,
      allWorkspaces: this.invitation.allWorkspaces, includeUnassigned: this.invitation.includeUnassigned,
      expiresAt: this.invitation.expiresAt, state: 'pending' });
    this.invitation = null;
    return { id, claim, expiresAt: this.pending.get(id).expiresAt };
  }
  approve(id) {
    this.prune();
    const request = this.pending.get(id);
    if (!request || request.state !== 'pending') fail(409, 'Pairing request is no longer pending');
    if (this.devices.length >= 32) fail(409, 'Revoke an existing device before adding another');
    request.state = 'approved';
  }
  reject(id) { this.pending.delete(id); }
  claim(id, claim) {
    this.prune();
    const request = this.pending.get(id);
    if (!request || !matches(claim, request.claimDigest)) fail(401, 'Invalid or expired pairing request');
    if (request.state === 'pending') return { state: 'pending' };
    if (!request.token) {
      const token = secret();
      this.save([...this.devices, { id, name: request.name, tokenDigest: hash(token), workspaceIds: request.workspaceIds,
        allWorkspaces: request.allWorkspaces, includeUnassigned: request.includeUnassigned,
        createdAt: this.now(), permission: 'control' }]);
      request.token = token;
    }
    return { state: 'approved', deviceId: id, token: request.token, permission: 'control' };
  }
  authenticate(token) {
    const device = this.devices.find(device => matches(token, device.tokenDigest));
    if (!device) fail(401, 'Device authentication required');
    this.pending.delete(device.id);
    return device;
  }
  revoke(id) {
    this.save(this.devices.filter(device => device.id !== id));
    this.pending.delete(id);
    this.onRevoke(id);
  }
  setScope(id, workspaceIds, options) {
    if (!this.devices.some(device => device.id === id)) fail(400, 'Invalid device');
    const scope = this.scope(workspaceIds, options);
    this.save(this.devices.map(device => device.id === id ? { ...device, ...scope } : device));
    this.onRevoke(id);
  }
  view() {
    this.prune();
    return { devices: this.devices.map(({ id, name, workspaceIds, allWorkspaces, includeUnassigned, createdAt, permission }) => ({ id, name, workspaceIds, allWorkspaces, includeUnassigned, createdAt, permission })),
      pending: [...this.pending.values()].filter(request => request.state === 'pending')
        .map(({ id, name, workspaceIds, allWorkspaces, includeUnassigned, expiresAt }) => ({ id, name, workspaceIds, allWorkspaces, includeUnassigned, expiresAt })) };
  }
  clearPairing() { this.invitation = null; this.pending.clear(); }
}

module.exports = { RemoteAccess, fail };
