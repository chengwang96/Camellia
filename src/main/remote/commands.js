'use strict';

const { createHash } = require('node:crypto');
const { readJson, writeJson } = require('../../shared/json-store');
const { fail } = require('./access');
const fs = require('node:fs');
const path = require('node:path');
const { configure } = require('./settings');

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function approval(event) {
  const details = JSON.stringify(event.input || {}, null, 2);
  const options = Array.isArray(event.options) ? event.options.filter(option => ['allow_once', 'reject_once'].includes(option.kind)) : [];
  return { requestId: event.requestId, fingerprint: digest(event), toolName: String(event.toolName || 'Tool approval'),
    details: details.slice(0, 32_000), actionable: !event.questions?.length && details.length <= 32_000 && (!event.options?.length || options.some(option => option.kind === 'allow_once')),
    options: options.map(({ optionId, kind, name }) => ({ optionId, kind, name })) };
}

class RemoteCommands {
  constructor({ file, reader, access, publish = () => {} }) {
    Object.assign(this, { file, reader, access, publish });
    this.entries = readJson(file, []);
    this.pending = new Map();
    this.reservations = new Map();
  }
  save() { writeJson(this.file, this.entries); }
  async acknowledgement(operation) {
    let timer;
    try {
      return await Promise.race([operation, new Promise(resolve => {
        timer = setTimeout(() => resolve({ ok: false, state: 'pending' }), 1000);
      })]);
    } finally { clearTimeout(timer); }
  }
  authorize(deviceId, id) {
    const device = this.access.devices.find(device => device.id === deviceId);
    if (!device || device.permission !== 'control') fail(403, 'Control permission required');
    return this.reader.conversation(device, id);
  }
  authorizeCreate(deviceId, workspaceId) {
    const device = this.access.devices.find(item => item.id === deviceId);
    if (!device || device.permission !== 'control') fail(403, 'Control permission required');
    if (workspaceId !== null && typeof workspaceId !== 'string') fail(400, 'Invalid workspace');
    if (workspaceId === null) {
      if (!device.allWorkspaces && !device.includeUnassigned) fail(403, 'Independent conversations are not authorized');
    } else if (!this.reader.workspaces().some(item => item.id === workspaceId) || !device.allWorkspaces && !device.workspaceIds.includes(workspaceId)) fail(403, 'Workspace is not authorized');
  }
  authorizeWorkspace(deviceId) {
    const device = this.access.devices.find(item => item.id === deviceId);
    if (!device || device.permission !== 'control' || device.allWorkspaces !== true) fail(403, 'Creating workspaces requires control of all workspaces');
  }
  async execute(device, id, payload, instanceId) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail(400, 'Invalid command');
    const { requestId, action } = payload;
    if (action === 'create-workspace' && id === null) this.authorizeWorkspace(device.id);
    else if (action === 'create' && id === null) this.authorizeCreate(device.id, payload.workspaceId);
    else this.authorize(device.id, id);
    if (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(requestId) || !['send', 'stop', 'approve', 'create', 'create-workspace', 'configure'].includes(action) || ['create', 'create-workspace'].includes(action) !== (id === null)) fail(400, 'Invalid command');
    const fields = ['requestId', 'action', 'instanceId', ...(action === 'create-workspace' ? ['name', 'path'] : action === 'configure' ? ['settings', 'expectedSettings'] : action === 'create' ? ['workspaceId', 'engine'] : action === 'send' ? ['prompt', 'expectedSeq', ...(payload.image === undefined ? [] : ['image'])] : action === 'stop' ? ['runId'] : ['runId', 'approvalId', 'fingerprint', 'allow'])];
    if (Object.keys(payload).some(key => !fields.includes(key))) fail(400, 'Unsupported command field');
    const fingerprint = digest([id, ...fields.map(field => payload[field])]);
    const key = device.id + ':' + requestId;
    const prior = this.entries.find(entry => entry.key === key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) fail(409, 'Request ID was already used');
      if (this.pending.has(key)) return this.acknowledgement(this.pending.get(key));
      return prior.result || { ok: false, state: 'unknown', error: 'Previous request outcome is uncertain; inspect the conversation. It will not be repeated.' };
    }
    if (payload.instanceId !== instanceId) fail(409, 'Server restarted; refresh before operating');
    if (this.entries.length >= 10_000) fail(409, 'Remote command journal is full; use the desktop');
    const entry = { key, fingerprint, at: Date.now() };
    this.entries.push(entry);
    try { this.save(); } catch (error) { this.entries.pop(); throw error; }
    const operation = this.perform(device.id, id, payload).then(result => {
      entry.result = result; this.save(); return result;
    }, error => {
      entry.result = { ok: false, state: 'failed', error: error.status ? error.message : 'Operation failed; inspect the conversation before sending another request.' };
      this.save(); return entry.result;
    }).finally(() => { this.pending.delete(key); this.publish(); });
    this.pending.set(key, operation);
    return this.acknowledgement(operation);
  }
  async perform(deviceId, id, payload) {
    if (payload.action === 'create-workspace') {
      this.authorizeWorkspace(deviceId);
      if (typeof payload.name !== 'string' || !payload.name.trim() || payload.name.length > 200 || /[\x00-\x1f\x7f]/.test(payload.name)
        || typeof payload.path !== 'string' || !payload.path.trim() || payload.path.length > 1024 || /[\x00-\x1f\x7f]/.test(payload.path)) fail(400, 'Invalid workspace name or computer folder');
      const result = this.reader.manager.workspaces.metaOp({ op: 'create-workspace', name: payload.name, path: payload.path });
      if (!result.ok) fail(400, result.error);
      this.reader.manager.onEvent({ type: 'conversation:workspaces' });
      return { ok: true, state: 'accepted', workspace: { id: result.workspace.id, name: result.workspace.name } };
    }
    if (payload.action === 'create') {
      this.authorizeCreate(deviceId, payload.workspaceId);
      if (!['claude', 'codex', 'dsh', 'kimi', 'antigravity'].includes(payload.engine)) fail(400, 'Invalid engine');
      const created = this.reader.manager.create(payload.engine, payload.workspaceId || undefined);
      return { ok: true, state: 'accepted', conversation: this.reader.summary(created) };
    }
    const conversation = this.authorize(deviceId, id), manager = this.reader.manager;
    if (payload.action === 'configure') return configure(manager, conversation, payload);
    if (payload.action === 'send') {
      if (typeof payload.prompt !== 'string' || !payload.prompt.trim() || payload.prompt.length > 16_000 || payload.expectedSeq !== conversation.seq) fail(409, 'Message or conversation changed; refresh before sending');
      if (manager.busy(id)) fail(409, 'Conversation is busy');
      const attachments = [];
      if (payload.image !== undefined) {
        if (typeof payload.image !== 'string' || payload.image.length > 1_400_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload.image)) fail(400, 'Invalid image');
        const bytes = Buffer.from(payload.image, 'base64');
        if (bytes.length > 1024 * 1024 || bytes.length < 4 || bytes.toString('base64') !== payload.image || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) fail(400, 'JPEG image required');
        const folder = path.join(path.dirname(this.file), 'mobile-images');
        fs.mkdirSync(folder, { recursive: true });
        const used = fs.readdirSync(folder).reduce((total, name) => total + fs.statSync(path.join(folder, name)).size, 0);
        if (used + bytes.length > 256 * 1024 * 1024) fail(409, 'Mobile image storage is full; manage attachments on the desktop');
        const target = path.join(folder, createHash('sha256').update(deviceId + ':' + payload.requestId).digest('hex') + '.jpg');
        fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
        attachments.push({ path: target, name: 'mobile-image.jpg', isImage: true });
      }
      const reservation = { cancelled: false, validate: () => this.authorize(deviceId, id) };
      manager.controlStarts.set(id, reservation);
      this.reservations.set(id, { deviceId, reservation });
      try {
        const { done, ...result } = await manager.send(conversation.currentEngine, { sessionId: id, prompt: payload.prompt, ...(attachments.length ? { attachments } : {}) }, { controlStart: reservation });
        return { ...result, state: 'accepted' };
      } finally {
        if (manager.controlStarts.get(id) === reservation) manager.controlStarts.delete(id);
        this.reservations.delete(id);
        manager.publishActivity(id);
      }
    }
    const active = manager.recovering.get(id) || manager.active.get(id);
    if (!Number.isSafeInteger(payload.runId) || !active || active.facade.gen !== payload.runId || active.cancelled) fail(409, 'This run is no longer active');
    if (payload.action === 'stop') return manager.cancel({ sessionId: id, runId: payload.runId });
    const event = active.permissions.get(payload.approvalId);
    if (!event || typeof payload.allow !== 'boolean' || payload.fingerprint !== digest(event) || !approval(event).actionable) fail(409, 'Approval changed or needs desktop input');
    const option = event.options?.find(option => option.kind === (payload.allow ? 'allow_once' : 'reject_once'));
    if (event.options?.length && !option) fail(409, 'This approval option is unavailable');
    const result = await manager.command(conversation.currentEngine, 'control-respond', { sessionId: id, runId: payload.runId, requestId: payload.approvalId,
      allow: payload.allow, optionId: option?.optionId });
    if (result.ok) manager.onEvent({ type: 'conversation:approval-resolved', session_id: id, runId: payload.runId, requestId: payload.approvalId, eventSeq: ++active.eventSeq });
    return result;
  }
  cancelPending(deviceId) {
    for (const entry of this.reservations.values()) if (!deviceId || entry.deviceId === deviceId) entry.reservation.cancelled = true;
  }
}

module.exports = { RemoteCommands, approval };
