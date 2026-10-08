'use strict';

const path = require('node:path');
const { bindingFingerprint } = require('./capabilities');
const { nativeStorage, storageKey, sameStorage } = require('./native-storage');
const { validateAttachments } = require('./assets');
const { createHash } = require('node:crypto');
const replyDigest = text => createHash('sha256').update(JSON.stringify(text)).digest('hex');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE = new Set(['preparing', 'running', 'stopping']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const PROFILE = ['engine', 'connection', 'model', 'accountRef', 'thinking', 'contextWindow'];
const SESSION = ['generation', 'runtimeId', 'nativeId', 'coveredThroughSeq', 'nativeOwnMessageIds', 'summaryRef'];
// Storage limits, not model token budgets. String limits include JSON escaping
// and quotes so Chinese, controls and lone surrogates cannot bypass byte bounds.
const LIMITS = Object.freeze({ recordBytes: 32 * 1024 * 1024, messageBytes: 256 * 1024,
  identityPromptLength: 4096,
  promptBytes: 1024 * 1024, members: 64, messages: 20000, requests: 10000,
  deliveries: 20000, pending: 128, retiredSessions: 1024,
  records: 1024, directoryEntries: 4096, inventoryBytes: 256 * 1024 * 1024 });
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
function invalid(label) { throw new Error('Invalid discussion records: ' + label); }
function check(condition, label) { if (!condition) invalid(label); }
function capacityError(message) { return Object.assign(new Error(message), { code: 'DISCUSSION_CAPACITY' }); }
function shape(value, required, optional = []) {
  check(value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'record object');
  const allowed = new Set([...required, ...optional]);
  check(required.every(key => Object.hasOwn(value, key))
    && Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.has(key)
      && Object.getOwnPropertyDescriptor(value, key).enumerable
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')
      && value[key] !== undefined), 'record fields');
}
function text(value, max = 4096, empty = false) {
  check(typeof value === 'string' && (empty || value.trim()) && jsonBytes(value) <= max, 'text or text size');
}
function integer(value, min, max = Number.MAX_SAFE_INTEGER) { check(Number.isSafeInteger(value) && value >= min && value <= max, 'integer'); }
function uuid(value) { check(typeof value === 'string' && UUID.test(value), 'ID'); }
function array(value, max) { check(Array.isArray(value) && value.length <= max, 'record count'); }
function unique(values) { check(new Set(values).size === values.length, 'duplicate reference'); }
function rows(values, max, uuidIds = true) {
  array(values, max);
  const result = new Map(), ids = new Set();
  for (const value of values) {
    check(value && typeof value === 'object', 'record object');
    if (uuidIds) uuid(value.id); else text(value.id, 1024);
    const key = uuidIds ? value.id.toLowerCase() : value.id;
    check(!ids.has(key), 'duplicate ID'); ids.add(key); result.set(value.id, value);
  }
  return result;
}
function profile(value, exact = true) {
  if (exact) shape(value, PROFILE);
  check(['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi'].includes(value.engine)
    && ['api', 'subscription'].includes(value.connection), 'member connection');
  text(value.model); if (value.accountRef !== null) text(value.accountRef);
  text(value.thinking, 1024, true); integer(value.contextWindow, 0);
}
function validateReply(value) { text(value, LIMITS.messageBytes); return value; }
function validateIdentityPrompt(value) {
  if (typeof value !== 'string' || value.length > LIMITS.identityPromptLength)
    throw new Error('Use an identity prompt of at most 4096 characters.');
  return value.trim();
}

function validateDiscussion(state, id) {
  shape(state, ['version', 'revision', 'id', 'threadId', 'cwd', 'title', 'seq', 'participants', 'messages', 'deliveries', 'requests'], ['stopPending', 'pinned', 'permissionMode', 'lastMessageAt']);
  check(state.version === 1 && state.id === id, 'state version or identity'); uuid(id); uuid(state.threadId);
  integer(state.revision, 1); integer(state.seq, 0, LIMITS.messages);
  if (state.lastMessageAt !== undefined) integer(state.lastMessageAt, 0);
  text(state.cwd, 32768); check(path.isAbsolute(state.cwd) && !state.cwd.includes('\0'), 'working directory'); text(state.title);
  if (state.stopPending !== undefined) check(typeof state.stopPending === 'boolean', 'stop state');
  if (state.pinned !== undefined) check(typeof state.pinned === 'boolean', 'pinned state');
  if (state.permissionMode !== undefined) check(['ask', 'auto', 'full'].includes(state.permissionMode), 'permission mode');
  const members = rows(state.participants, LIMITS.members), messages = rows(state.messages, LIMITS.messages);
  const deliveries = rows(state.deliveries, LIMITS.deliveries), requests = rows(state.requests, LIMITS.requests, false);
  check(state.messages.length === state.seq, 'sequence');
  const sessions = new Map(), nativeIds = new Set(), storageIds = new Set(), activeMembers = new Set();
  const completedBySession = new Map(), unfinishedBySession = new Map(), interruptedBySession = new Map();
  let pending = 0;
  for (const p of state.participants) {
    shape(p, ['id', 'name', ...PROFILE, 'configVersion', 'removed', 'session', 'retiredSessions'], ['removalPending', 'accountLabel', 'identityPrompt']);
    profile(p, false); text(p.name); integer(p.configVersion, 1); check(typeof p.removed === 'boolean', 'member removal');
    if (p.accountLabel !== undefined) text(p.accountLabel);
    if (p.identityPrompt !== undefined) validateIdentityPrompt(p.identityPrompt);
    if (p.removalPending !== undefined) check(typeof p.removalPending === 'boolean' && !p.removed, 'member removal');
    array(p.retiredSessions, LIMITS.retiredSessions);
    check(!p.removed || p.retiredSessions.every(s => s && !s.recoveryRequired), 'removed member recovery');
    for (const [index, s] of [...p.retiredSessions, p.session].entries()) {
      const retired = index < p.retiredSessions.length;
      shape(s, [...SESSION, ...(retired ? ['profile', 'reason', 'recoveryRequired'] : [])], ['nativeStorage', 'executionMode', ...(retired ? ['resourcesReleased'] : [])]);
      if (s.executionMode !== undefined) check(['tool-free', 'workspace-read-only', 'native-tools'].includes(s.executionMode), 'execution mode');
      integer(s.generation, 1); check(s.generation === index + 1, 'session generation'); uuid(s.runtimeId);
      check(!sessions.has(s.runtimeId.toLowerCase()), 'duplicate runtime ID');
      const binding = retired ? s.profile : p;
      if (retired) {
        profile(s.profile); check(['configuration', 'snapshot', 'failed', 'cancelled', 'interrupted'].includes(s.reason), 'retirement reason');
        check(typeof s.recoveryRequired === 'boolean' && (!s.recoveryRequired || s.reason === 'interrupted'), 'recovery state');
        if (s.resourcesReleased !== undefined) check(s.resourcesReleased === true && !s.recoveryRequired && s.reason === 'interrupted', 'resource release');
      }
      if (s.nativeId !== null) {
        text(s.nativeId, 1024);
        const key = JSON.stringify([binding.engine, process.platform === 'win32' ? s.nativeId.toLowerCase() : s.nativeId]);
        check(!nativeIds.has(key), 'duplicate native identity'); nativeIds.add(key);
      }
      integer(s.coveredThroughSeq, 0, state.seq); array(s.nativeOwnMessageIds, LIMITS.messages); unique(s.nativeOwnMessageIds);
      s.nativeOwnMessageIds.forEach(uuid);
      if (s.summaryRef !== null) { text(s.summaryRef, 32768); check(!s.summaryRef.includes('\0'), 'summary reference'); }
      if (s.nativeStorage !== undefined) {
        const storage = nativeStorage(s.nativeStorage);
        text(storage.storageDir, 32768);
        check(binding.engine === 'antigravity' && binding.connection === storage.connection && s.nativeId, 'native storage binding');
        const key = storageKey(storage); check(!storageIds.has(key), 'duplicate native storage'); storageIds.add(key);
      }
      sessions.set(s.runtimeId.toLowerCase(), { session: s, binding, participant: p, retired });
      completedBySession.set(s.runtimeId, []);
    }
  }
  for (const [index, m] of state.messages.entries()) {
    check(['user', 'assistant'].includes(m.role), 'message role');
    shape(m, ['id', 'seq', 'threadId', 'role', 'speakerId', 'requestId', 'text', ...(m.role === 'assistant' ? ['speakerName', 'deliveryId'] : [])], ['attachments']);
    if (m.attachments !== undefined) validateAttachments(m.attachments);
    check(m.seq === index + 1 && m.threadId === state.threadId, 'message sequence or thread'); validateReply(m.text);
    const request = requests.get(m.requestId); check(request, 'message request');
    if (m.role === 'user') check(m.speakerId === null && request.messageId === m.id, 'user message ownership');
    else {
      text(m.speakerName); const d = deliveries.get(m.deliveryId);
      check(members.has(m.speakerId) && d && d.status === 'completed' && d.resultId === m.id
        && d.participantId === m.speakerId && d.requestId === m.requestId, 'reply ownership');
    }
  }
  const assigned = new Set();
  for (const r of state.requests) {
    shape(r, ['id', 'fingerprint', 'messageId', 'mode', 'deliveryIds']);
    check(['parallel', 'serial'].includes(r.mode), 'request mode');
    const m = messages.get(r.messageId); check(m?.role === 'user' && m.requestId === r.id, 'request message');
    array(r.deliveryIds, LIMITS.deliveries); unique(r.deliveryIds);
    const originals = [];
    for (const [index, deliveryId] of r.deliveryIds.entries()) {
      const d = deliveries.get(deliveryId); check(d?.requestId === r.id && !assigned.has(deliveryId), 'request delivery');
      assigned.add(deliveryId);
      if (d.retryOf === undefined) originals.push(d.participantId);
      else {
        const prior = deliveries.get(r.deliveryIds[index - 1]);
        check(r.mode === 'serial' && prior && prior.id === d.retryOf && prior.serialResolution === 'retry'
          && prior.retryDeliveryId === d.id && prior.participantId === d.participantId, 'retry chain');
      }
    }
    unique(originals);
    check(r.fingerprint === JSON.stringify({ text: m.text, participantIds: originals, mode: r.mode, ...(m.attachments?.length ? { attachments: m.attachments } : {}) }), 'request fingerprint');
  }
  check(assigned.size === deliveries.size, 'unassigned delivery');
  for (const d of state.deliveries) {
    shape(d, ['id', 'requestId', 'participantId', 'status', 'inputThroughSeq', 'generation', 'resultId'],
      ['profile', 'configVersion', 'runtimeId', 'bindingFingerprint', 'inputPlan', 'nativeId', 'nativeStorage', 'phase', 'identityPrompt', 'permissionMode', 'tools',
        'partialText', 'settlement', 'unavailableReason', 'failureReason', 'serialResolution', 'resolutionActionId', 'retryDeliveryId', 'retryOf']);
    const p = members.get(d.participantId), r = requests.get(d.requestId), m = messages.get(r?.messageId);
    if (d.identityPrompt !== undefined) validateIdentityPrompt(d.identityPrompt);
    if (d.permissionMode !== undefined) check(['ask', 'auto', 'full'].includes(d.permissionMode), 'delivery permission');
    if (d.tools !== undefined) { array(d.tools, 256); for (const tool of d.tools) {
      shape(tool, ['id', 'name', 'input', 'output', 'status'], ['permissionBlocked']);
      text(tool.id, 1024); text(tool.name, 2048, true); text(tool.output, 131072, true);
      check(jsonBytes(tool.input) <= 65536 && ['pending', 'running', 'completed', 'failed', 'interrupted'].includes(tool.status), 'tool record');
    } }
    check(p && r && (d.status === 'queued' || ACTIVE.has(d.status) || TERMINAL.has(d.status)), 'delivery owner or status');
    if (d.status === 'queued' || ACTIVE.has(d.status)) { pending++; check(!p.removed, 'removed member activity'); }
    if (ACTIVE.has(d.status)) {
      check(!activeMembers.has(p.id) && d.generation === p.session.generation && d.configVersion === p.configVersion, 'active session');
      activeMembers.add(p.id);
    }
    if (state.stopPending) check(d.status !== 'queued' && !['preparing', 'running'].includes(d.status), 'stop activity');
    if (d.generation === null) {
      check(!ACTIVE.has(d.status) && d.status !== 'completed', 'unprepared status');
      for (const key of ['runtimeId', 'configVersion', 'bindingFingerprint', 'inputPlan', 'nativeId', 'nativeStorage', 'partialText', 'settlement', 'phase']) check(!Object.hasOwn(d, key), 'unprepared fields');
      check(d.profile === undefined || d.unavailableReason !== undefined, 'unprepared binding');
      if (d.status === 'failed') check(d.unavailableReason !== undefined, 'unavailable reason');
    } else {
      integer(d.generation, 1); integer(d.configVersion, 1, p.configVersion); uuid(d.runtimeId); profile(d.profile);
      const owner = sessions.get(d.runtimeId.toLowerCase());
      check(owner && owner.participant === p && owner.session.runtimeId === d.runtimeId && owner.session.generation === d.generation
        && bindingFingerprint(owner.binding) === bindingFingerprint(d.profile)
        && d.bindingFingerprint === bindingFingerprint(d.profile), 'delivery session or binding');
      check(d.status !== 'queued', 'prepared queue');
      if (d.nativeId !== undefined) {
        text(d.nativeId, 1024); check(d.nativeId === owner.session.nativeId && d.inputPlan && d.status !== 'preparing', 'delivery native identity');
        if (owner.session.nativeStorage !== undefined) check(sameStorage(owner.session.nativeStorage, d.nativeStorage), 'missing delivery native storage');
      }
      if (d.nativeStorage !== undefined) {
        nativeStorage(d.nativeStorage);
        check(d.nativeId && sameStorage(owner.session.nativeStorage, d.nativeStorage), 'delivery native storage binding');
      }
      if (d.status === 'completed') completedBySession.get(d.runtimeId).push(d);
      else {
        // A failed/interrupted turn retires the generation. There cannot be a
        // second unfinished native attempt in that same generation.
        check(!unfinishedBySession.has(d.runtimeId), 'duplicate native attempt');
        unfinishedBySession.set(d.runtimeId, d);
      }
      if (d.status === 'interrupted') interruptedBySession.set(d.runtimeId, (interruptedBySession.get(d.runtimeId) || 0) + 1);
    }
    if (r.mode === 'parallel') check(d.inputThroughSeq === m.seq, 'parallel snapshot');
    else if (d.generation === null) check(d.inputThroughSeq === null, 'unprepared snapshot');
    else integer(d.inputThroughSeq, m.seq, state.seq);
    if (d.inputPlan !== undefined) {
      shape(d.inputPlan, ['prompt', 'inputThroughSeq'], ['attachments']); text(d.inputPlan.prompt, LIMITS.promptBytes);
      if (d.inputPlan.attachments !== undefined) validateAttachments(d.inputPlan.attachments, 256);
      check(d.inputPlan.inputThroughSeq === d.inputThroughSeq, 'input snapshot');
    }
    if (d.partialText !== undefined) { text(d.partialText, LIMITS.messageBytes, true); check(d.nativeId, 'partial reply identity'); }
    if (d.status === 'running' || d.status === 'completed') check(d.inputPlan && d.nativeId, 'started input');
    if (d.phase !== undefined) check((d.status === 'preparing' ? ['context', 'summary'] : d.status === 'running' ? ['answer', 'approval'] : d.status === 'stopping' ? ['stopping'] : []).includes(d.phase), 'activity phase');
    if (d.unavailableReason !== undefined) { text(d.unavailableReason); profile(d.profile); check(d.status === 'failed' && d.generation === null, 'unavailable delivery'); }
    if (d.failureReason !== undefined) { text(d.failureReason); check(d.status === 'failed' && d.generation !== null, 'failure reason'); }
    if (d.settlement !== undefined) {
      const s = d.settlement;
      check(s && ['completed', 'failed', 'cancelled'].includes(s.status), 'settlement status');
      if (s.status === 'completed' && s.resultId !== undefined) {
        shape(s, ['status', 'resultId', 'sha256']);
        const result = messages.get(s.resultId);
        check(d.status === 'completed' && s.resultId === d.resultId && d.partialText === undefined
          && result && typeof s.sha256 === 'string' && /^[0-9a-f]{64}$/.test(s.sha256) && s.sha256 === replyDigest(result.text), 'settlement answer');
      } else {
        shape(s, ['status', ...(s.status === 'completed' ? ['text'] : [])]);
        if (s.status === 'completed') { validateReply(s.text); check(d.nativeId && d.inputPlan && d.partialText === s.text, 'settlement answer'); }
      }
      if (['completed', 'failed', 'cancelled'].includes(d.status)) check(s.status === d.status, 'settlement outcome');
    }
    if (d.status === 'completed') {
      const result = messages.get(d.resultId);
      check(result?.deliveryId === d.id && result.seq > d.inputThroughSeq
        && (d.settlement === undefined || d.settlement.resultId === result.id || d.settlement.text === result.text), 'completed reply');
    } else check(d.resultId === null, 'uncommitted reply');
    if (d.serialResolution !== undefined) {
      check(r.mode === 'serial' && ['failed', 'cancelled', 'interrupted'].includes(d.status)
        && ['skip', 'retry'].includes(d.serialResolution), 'serial resolution'); text(d.resolutionActionId, 1024);
      if (d.serialResolution === 'retry') {
        const next = deliveries.get(d.retryDeliveryId); check(next?.retryOf === d.id && next.requestId === r.id, 'serial retry');
      } else check(d.retryDeliveryId === undefined, 'skipped retry');
    } else check(d.resolutionActionId === undefined && d.retryDeliveryId === undefined, 'resolution fields');
  }
  check(pending <= LIMITS.pending, 'pending delivery count');
  for (const { session: s, retired } of sessions.values()) {
    const completed = completedBySession.get(s.runtimeId).sort((a, b) => messages.get(a.resultId).seq - messages.get(b.resultId).seq);
    let previousReply = 0;
    for (const d of completed) {
      check(d.inputThroughSeq >= previousReply, 'native future context');
      previousReply = messages.get(d.resultId).seq;
    }
    const unfinished = unfinishedBySession.get(s.runtimeId);
    if (unfinished) check(unfinished.inputThroughSeq >= previousReply, 'native future context');
    check(s.coveredThroughSeq === (completed.at(-1)?.inputThroughSeq ?? 0)
      && JSON.stringify(s.nativeOwnMessageIds) === JSON.stringify(completed.map(d => d.resultId)), 'session coverage');
    if (retired && (s.recoveryRequired || s.resourcesReleased)) {
      check(interruptedBySession.get(s.runtimeId) === 1, 'recovery identity');
    }
  }
  return state;
}

// Reserve before admitting work. Active turns need room for their fixed input,
// partial answer, immutable settlement, public reply, and retirement metadata.
// Current delivery/session bytes are already in the snapshot; subtract them.
// Control and settlement writes consume the reservation without readmitting it.
function admissionBytes(state) {
  const prettyBytes = (value, indent) => Buffer.byteLength(JSON.stringify(value, null, 2).replace(/\n/g, '\n' + ' '.repeat(indent)), 'utf8');
  let reserve = 4096;
  const active = new Set();
  for (const d of state.deliveries) {
    if (d.status === 'queued') reserve += Math.max(0, 32768 - prettyBytes(d, 4));
    if (!ACTIVE.has(d.status)) continue;
    active.add(d.participantId);
    const s = state.participants.find(p => p.id === d.participantId).session;
    const { nativeOwnMessageIds, summaryRef, ...metadata } = s;
    reserve += Math.max(0, LIMITS.promptBytes + 3 * LIMITS.messageBytes + 256 * 1024
      - prettyBytes(d, 4) - prettyBytes(metadata, 6));
  }
  if (state.messages.length + active.size > LIMITS.messages) throw capacityError('Discussion has insufficient reserved message count');
  if (state.participants.some(p => p.retiredSessions.length + Number(active.has(p.id)) > LIMITS.retiredSessions)) throw capacityError('Discussion has insufficient reserved session count');
  return reserve;
}

module.exports = { UUID, LIMITS, validateDiscussion, validateReply, validateIdentityPrompt, admissionBytes, capacityError, replyDigest };
