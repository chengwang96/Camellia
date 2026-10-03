'use strict';

const { createHash } = require('node:crypto');
const { readJson, writeJson } = require('../../shared/json-store');
const { fail } = require('./access');
const { decodeAttachments } = require('./attachments');
const { approval, answer } = require('./approvals');
const { listArtifacts, openArtifact } = require('./artifacts');

const UUID = /^[a-f0-9-]{36}$/;
const fields = {
  create: ['title'], rename: ['title'], pin: ['pinned'], delete: [],
  'add-member': ['bindingId', 'name', 'identityPrompt'], 'remove-member': ['participantId'],
  'set-identity': ['participantId', 'identityPrompt'], 'verify-member': ['participantId'],
  'cancel-member-verification': ['participantId'],
  send: ['text', 'participantIds', 'mode', 'attachments'], stop: ['deliveryId', 'participantId'],
  retry: ['deliveryId'], 'resolve-serial': ['deliveryId', 'resolution'],
  'set-permission': ['permissionMode'],
  'permission-response': ['deliveryId', 'runId', 'approvalId', 'fingerprint', 'allow', 'input', 'optionId'],
};
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));

// This is an adapter for the host's existing discussions, not a second store or
// scheduler. Never expose local-only actions (paths, imports, native sessions).
class RemoteDiscussions {
  constructor({ file, getService, access, publish = () => {} }) {
    Object.assign(this, { file, getService, access, publish });
    this.generation = 0;
    this.entries = readJson(file, []).slice(-2000).map(entry => entry.state === 'pending'
      ? { ...entry, state: 'interrupted', error: 'The host restarted. Check the discussion before trying again.' } : entry);
    this.save();
  }
  save() { writeJson(this.file, this.entries); }
  cancelPending() { this.generation++; }
  authorize(device) {
    const current = this.access.devices.find(row => row.id === device.id);
    if (!current || current.permission !== 'control' || current.allWorkspaces !== true) fail(403, 'Discussions require full-device control permission');
    return current;
  }
  list(device, offset = 0) {
    this.authorize(device);
    const groups = this.getService().list();
    return { groups: groups.slice(offset, offset + 100), nextOffset: offset + 100 < groups.length ? offset + 100 : null,
      listVersion: hash(groups) };
  }
  snapshot(device, id, before) {
    this.authorize(device);
    const service = this.getService();
    let state;
    try { state = service.manager.get(id); } catch { fail(404, 'Discussion not found'); }
    const view = service.view(state);
    const candidates = view.messages.filter(message => before === undefined || message.seq < before);
    const messages = [];
    let bytes = 0;
    for (const message of candidates.slice().reverse()) {
      const safe = { ...pick(message, ['id', 'seq', 'role', 'speakerId', 'speakerName', 'requestId', 'deliveryId', 'text']),
        attachments: message.attachments.map(a => pick(a, ['id', 'name', 'isImage', 'size'])) };
      const size = Buffer.byteLength(JSON.stringify(safe));
      if (messages.length && (bytes + size > 512 * 1024 || messages.length >= 80)) break;
      bytes += size; messages.unshift(safe);
    }
    const requestIds = new Set(messages.map(message => message.requestId));
    // Tool-heavy histories must stay below the phone's response limit. Share a
    // budget across the page, starting with the newest deliveries, and do not
    // repeat completed answers (already present in messages) as partial output.
    let detailBudget = 512 * 1024;
    const preview = (value, limit, tail = false) => {
      const source = String(value || ''), length = Math.min(limit, Math.max(0, Math.floor(detailBudget / 4)));
      const text = length ? (tail ? source.slice(-length) : source.slice(0, length)) : '';
      detailBudget -= Buffer.byteLength(text); return text;
    };
    const deliveries = view.deliveries.filter(d => requestIds.has(d.requestId) || ['queued', 'preparing', 'running', 'stopping'].includes(d.status))
      .slice().reverse().map(d => ({ ...pick(d, ['id', 'participantId', 'requestId', 'status', 'phase', 'reason', 'serialResolution']),
        partialText: d.status === 'completed' ? '' : preview(d.partialText, 128 * 1024, true),
        toolsTruncated: (d.tools || []).length > 24,
        tools: (d.tools || []).slice(-24).reverse().map(t => {
          const rawInput = JSON.stringify(t.input || {}, null, 2), rawOutput = String(t.output || '');
          const output = preview(rawOutput, 8000, true), inputText = preview(rawInput, 8000);
          return { ...pick(t, ['id', 'name', 'status']), inputText, output,
            detailsTruncated: rawInput.length > inputText.length || rawOutput.length > output.length };
        }).reverse() })).reverse();
    return { group: { ...pick(view, ['id', 'title', 'pinned', 'revision', 'seq', 'stopping', 'verifying', 'permissionMode', 'participants']),
      active: service.busy(id, state), messages, deliveries,
      requests: view.requests.filter(r => requestIds.has(r.id)),
      pendingApprovals: view.permissions.map(p => ({ ...approval(p), ...pick(p, ['participantId', 'deliveryId', 'runId']) })) },
      nextBefore: messages.length < candidates.length ? messages[0]?.seq : null };
  }
  async catalog(device) {
    this.authorize(device);
    const values = await this.getService().catalog();
    this.authorize(device);
    return { bindings: values.map(row => ({ ...pick(row, ['id', 'label', 'providerId', 'providerLabel', 'accountLabel', 'capability']),
      binding: pick(row.binding, ['engine', 'connection', 'model', 'thinking', 'contextWindow']) })) };
  }
  artifactReader() {
    return {
      conversation: (device, id) => { this.authorize(device); try { return this.getService().manager.get(id); } catch { fail(404, 'Discussion not found'); } },
      manager: { rows: state => state.messages.flatMap(message => {
        const delivery = state.deliveries.find(d => d.id === message.deliveryId);
        const attached = (message.attachments || []).map(a => ({ path: a.path }));
        const generated = delivery?.status === 'completed' ? (delivery.tools || [])
          .filter(t => t.status === 'completed' && /write|edit|create|save|output|export|patch/i.test(t.name))
          .flatMap(t => [t.input?.file_path, t.input?.TargetFile, t.input?.path, t.input?.output_path].filter(p => typeof p === 'string').map(path => ({ path }))) : [];
        return [{ ...message, role: 'assistant', text: message.role === 'assistant' ? message.text : '', artifacts: [...attached, ...generated] }];
      }) },
    };
  }
  artifacts(device, id, offset = 0) { return listArtifacts(this.artifactReader(), device, id, offset); }
  openArtifact(device, id, fileId) { return openArtifact(this.artifactReader(), device, id, fileId); }
  receipt(device, requestId) {
    this.authorize(device);
    const entry = this.entries.find(e => e.deviceId === device.id && e.requestId === requestId);
    if (!entry) fail(404, 'Discussion command receipt not found');
    return pick(entry, ['requestId', 'state', 'groupId', 'error']);
  }
  submit(device, payload, instanceId) {
    this.authorize(device);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail(400, 'Invalid discussion command');
    const { requestId, action, id, parameters = {} } = payload;
    if (!UUID.test(requestId || '') || !Object.hasOwn(fields, action) || typeof parameters !== 'object' || !parameters || Array.isArray(parameters)
      || Object.keys(parameters).some(key => !fields[action].includes(key))
      || Object.keys(payload).some(key => !['requestId', 'instanceId', 'action', 'id', 'parameters'].includes(key))
      || (action === 'create' ? id !== undefined : !UUID.test(id || ''))) fail(400, 'Invalid discussion command');
    const fingerprint = hash([payload.instanceId, action, id, fields[action].map(key => parameters[key])]);
    const prior = this.entries.find(e => e.deviceId === device.id && e.requestId === requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) fail(409, 'Request ID was already used');
      return this.receipt(device, requestId);
    }
    if (payload.instanceId !== instanceId) fail(409, 'Host restarted; refresh before sending');
    if (this.entries.length >= 5000) fail(429, 'Discussion command history is full; restart the host before continuing');
    const service = this.getService();
    if (id) { try { service.manager.get(id); } catch { fail(404, 'Discussion not found'); } }
    const entry = { deviceId: device.id, requestId, fingerprint, groupId: id, state: 'pending' };
    this.entries.push(entry);
    try { this.save(); }
    catch { this.entries.pop(); fail(503, 'Cannot save the discussion command; no action was started'); }
    const generation = this.generation;
    const authorize = () => {
      this.authorize(device);
      if (generation !== this.generation) fail(409, 'Remote access stopped before the discussion command could finish');
    };
    const args = { ...parameters, ...(id ? { id } : {}), requestId, actionId: requestId };
    // A slow connection check must not hold an HTTP request open. The client
    // queries this durable receipt; it never sends a fresh command on timeout.
    void Promise.resolve().then(() => {
      authorize();
      if (action === 'send' && parameters.attachments?.length) {
        if (parameters.attachments.length > 16) fail(400, 'Choose at most 16 discussion attachments');
        const entries = decodeAttachments(parameters.attachments);
        args.attachments = service.assets.importData(id, entries);
      } else if (action === 'send' && parameters.attachments !== undefined && !Array.isArray(parameters.attachments)) fail(400, 'Invalid attachments');
      if (action === 'permission-response') {
        const permission = service.scheduler.permissions(id).find(p => p.deliveryId === parameters.deliveryId
          && p.runId === parameters.runId && p.requestId === parameters.approvalId);
        if (!permission) fail(409, 'This request is no longer active');
        Object.assign(args, answer(permission, parameters), { requestId: parameters.approvalId });
      }
      return service.call(action, args, { authorize });
    }).then(result => {
      entry.state = 'completed'; entry.groupId = result.group?.id || id;
    }, error => {
      entry.state = 'failed'; entry.error = String(error.message || 'Discussion command failed').slice(0, 1500);
    }).then(() => {
      try { this.save(); }
      catch {
        entry.state = 'interrupted';
        entry.error = 'The action may have completed, but its receipt could not be saved. Check the discussion before trying again.';
      }
      this.publish();
    }).catch(() => {});
    return this.receipt(device, requestId);
  }
}

module.exports = { RemoteDiscussions };
