'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DiscussionStore } = require('./store');
const { bindingFingerprint } = require('./capabilities');
const { apiProviderRef } = require('./catalog');
const { nativeStorage: validateStorage, sameStorage } = require('./native-storage');
const { validateReply, validateIdentityPrompt } = require('./schema');
const { validateAttachments } = require('./assets');

const ENGINES = ['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi'];
const ACTIVE = new Set(['preparing', 'running', 'stopping']);
const OPEN = new Set(['queued', ...ACTIVE]);
const RETRYABLE = new Set(['failed', 'cancelled', 'interrupted']);
function required(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid ' + label);
  return value;
}
function profile(input) {
  if (!ENGINES.includes(input.engine) || !['api', 'subscription'].includes(input.connection)) throw new Error('Invalid member connection');
  if (!Number.isSafeInteger(input.contextWindow ?? 0) || (input.contextWindow ?? 0) < 0) throw new Error('Invalid context window');
  // Store references only; never persist arbitrary settings or credentials.
  return { engine: input.engine, connection: input.connection, model: required(input.model, 'model'),
    accountRef: input.accountRef == null ? null : required(input.accountRef, 'account reference'),
    thinking: String(input.thinking ?? ''), contextWindow: input.contextWindow ?? 0 };
}
function freshSession(generation = 1) {
  return { generation, runtimeId: randomUUID(), nativeId: null, coveredThroughSeq: 0, nativeOwnMessageIds: [], summaryRef: null };
}
function member(state, id) {
  const value = state.participants.find(entry => entry.id === id && !entry.removed);
  if (!value) throw new Error('Member not found');
  return value;
}
function availableMember(state, id) {
  const value = member(state, id);
  if (value.removalPending) throw new Error('Member is being removed');
  if (value.retiredSessions.some(s => s.recoveryRequired)) throw new Error('Member requires native activity recovery');
  return value;
}
function append(state, row) {
  const message = { ...row, id: randomUUID(), seq: ++state.seq, threadId: state.threadId };
  state.messages.push(message); return message;
}
function retire(participant, reason, recoveryRequired = false) {
  participant.retiredSessions.push({ ...participant.session, profile: profile(participant), reason, recoveryRequired });
  participant.session = freshSession(participant.session.generation + 1);
}
function stopped(delivery, proof) {
  if (proof?.stopped !== true || proof.released !== true || proof.runtimeId !== delivery.runtimeId
    || proof.deliveryId !== delivery.id || proof.generation !== delivery.generation) {
    throw new Error('Stop and resource release are not confirmed');
  }
}
function finishTools(delivery) {
  for (const tool of delivery.tools || []) if (['pending', 'running'].includes(tool.status)) tool.status = 'interrupted';
}

// Owns discussion state and admission fences, never driver execution. Creating
// a member or queuing a request here cannot start inference.
class DiscussionManager {
  constructor(options) {
    this.store = options.store || new DiscussionStore(options);
    // Fail-closed admission while an intent cannot be written. These fences
    // supplement durable state; a disk failure must not admit replacement work.
    this.controls = new Map();
  }
  control(id) {
    if (!this.controls.has(id)) this.controls.set(id, { all: false, members: new Set(), deliveries: new Set() });
    return this.controls.get(id);
  }
  isStopping(id) { return this.controls.get(id)?.all === true; }
  checkAdmission(id, participantId, deliveryId) {
    const control = this.controls.get(id);
    if (control?.all) throw new Error('Discussion is stopping');
    if (control?.members.has(participantId)) throw new Error('Member is being removed');
    if (control?.deliveries.has(deliveryId)) throw new Error('Delivery is stopping');
  }
  create({ cwd, title = 'Agent discussion' }) {
    required(cwd, 'working directory');
    if (!path.isAbsolute(cwd)) throw new Error('Working directory must be absolute');
    return this.store.create({ version: 1, revision: 1, id: randomUUID(), threadId: randomUUID(), cwd,
      title: required(title, 'title'), seq: 0, participants: [], messages: [], deliveries: [], requests: [] });
  }
  get(id) { return this.store.read(id); }
  list() { return this.store.list(); }
  rename(id, title) {
    title = required(title, 'title').trim();
    if (title.length > 120) throw new Error('Use a discussion title of at most 120 characters.');
    this.store.update(id, state => { state.title = title; });
  }
  setPinned(id, pinned) {
    if (typeof pinned !== 'boolean') throw new Error('Invalid pinned state');
    this.store.update(id, state => { state.pinned = pinned; });
  }
  remove(id) {
    const state = this.get(id);
    if (this.isStopping(id) || state.stopPending || state.deliveries.some(d => OPEN.has(d.status))
      || state.participants.some(p => p.retiredSessions.some(s => s.recoveryRequired))) {
      throw new Error('Stop all replies before deleting this discussion.');
    }
    this.store.remove(id); this.controls.delete(id);
  }
  addMember(id, input) {
    const settings = profile(input);
    const identityPrompt = validateIdentityPrompt(input.identityPrompt ?? '');
    return this.store.update(id, state => {
      const participant = { id: randomUUID(), name: required(input.name, 'member name'), ...settings,
        configVersion: 1, removed: false, identityPrompt, session: freshSession(), retiredSessions: [] };
      if (input.accountLabel) participant.accountLabel = String(input.accountLabel).slice(0, 200);
      state.participants.push(participant); return participant;
    }, { admission: true });
  }
  configureMember(id, participantId, input) {
    this.checkAdmission(id, participantId);
    return this.store.update(id, state => {
      const participant = availableMember(state, participantId);
      if (state.deliveries.some(d => d.participantId === participantId && OPEN.has(d.status))) throw new Error('Member has pending requests');
      const next = profile({ ...participant, ...input });
      if (JSON.stringify(profile(participant)) !== JSON.stringify(next)) retire(participant, 'configuration');
      Object.assign(participant, next, { name: required(input.name ?? participant.name, 'member name') });
      if (input.accountLabel !== undefined) participant.accountLabel = String(input.accountLabel).slice(0, 200);
      participant.configVersion++; return participant;
    }, { admission: true });
  }
  setIdentityPrompt(id, participantId, value) {
    const identityPrompt = validateIdentityPrompt(value);
    this.checkAdmission(id, participantId);
    return this.store.update(id, state => {
      const participant = availableMember(state, participantId);
      if (state.deliveries.some(d => d.participantId === participantId && OPEN.has(d.status)))
        throw new Error('Wait for this member to finish replying or stop it before editing its identity.');
      if ((participant.identityPrompt || '') === identityPrompt) return participant;
      // A fresh native context prevents the previous persona from remaining
      // active after an edit. Public group history is retained and replayed.
      retire(participant, 'configuration');
      participant.identityPrompt = identityPrompt; participant.configVersion++;
      return participant;
    }, { admission: true });
  }
  beginRemoval(id, participantId) {
    this.control(id).members.add(participantId);
    return this.store.update(id, state => {
      const participant = member(state, participantId);
      participant.removalPending = true;
      for (const delivery of state.deliveries) {
        if (delivery.participantId === participantId && delivery.status === 'queued') delivery.status = 'cancelled';
      }
      return participant;
    });
  }
  removeMember(id, participantId) {
    const result = this.store.update(id, state => {
      const participant = member(state, participantId);
      if (state.deliveries.some(d => d.participantId === participantId && ACTIVE.has(d.status))) throw new Error('Stop member before removal');
      if (participant.retiredSessions.some(s => s.recoveryRequired)) throw new Error('Member requires native activity recovery');
      for (const delivery of state.deliveries) if (delivery.participantId === participantId && delivery.status === 'queued') delivery.status = 'cancelled';
      participant.removed = true; delete participant.removalPending; return participant;
    });
    this.control(id).members.delete(participantId);
    return result;
  }
  setPermission(id, permissionMode) {
    if (!['ask', 'auto', 'full'].includes(permissionMode)) throw new Error('Invalid permission mode');
    return this.store.update(id, state => {
      if (state.deliveries.some(d => OPEN.has(d.status))) throw new Error('Stop replies before changing permissions.');
      if ((state.permissionMode || 'ask') === permissionMode) return;
      for (const p of state.participants.filter(p => !p.removed)) { availableMember(state, p.id); retire(p, 'configuration'); p.configVersion++; }
      state.permissionMode = permissionMode;
    });
  }
  enqueue(id, { requestId, text, participantIds = [], mode = 'parallel', attachments = [] }) {
    required(requestId, 'request ID'); validateReply(required(text, 'message'));
    validateAttachments(attachments);
    if (!Array.isArray(participantIds) || new Set(participantIds).size !== participantIds.length || !['parallel', 'serial'].includes(mode)) throw new Error('Invalid discussion targets');
    const fingerprint = JSON.stringify({ text, participantIds, mode, ...(attachments.length ? { attachments } : {}) });
    return this.store.update(id, state => {
      const existing = state.requests.find(r => r.id === requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error('Request ID reused with different input');
        return existing;
      }
      if (participantIds.length && state.stopPending) throw new Error('Discussion is stopping');
      participantIds.forEach(target => { this.checkAdmission(id, target); availableMember(state, target); });
      const message = append(state, { role: 'user', speakerId: null, requestId, text, ...(attachments.length ? { attachments: structuredClone(attachments) } : {}) });
      const request = { id: requestId, fingerprint, messageId: message.id, mode, deliveryIds: [] };
      for (const participantId of participantIds) {
        const delivery = { id: randomUUID(), requestId, participantId, status: 'queued',
          inputThroughSeq: mode === 'parallel' ? message.seq : null, generation: null, resultId: null };
        request.deliveryIds.push(delivery.id); state.deliveries.push(delivery);
      }
      state.requests.push(request); return request;
    }, { admission: true });
  }
  prepare(id, deliveryId, executionMode) {
    return this.store.update(id, state => {
      const delivery = state.deliveries.find(d => d.id === deliveryId);
      if (!delivery || delivery.status !== 'queued') throw new Error('Delivery is not queued');
      this.checkAdmission(id, delivery.participantId, deliveryId);
      if (state.stopPending) throw new Error('Discussion is stopping');
      const participant = availableMember(state, delivery.participantId);
      if (executionMode && participant.session.executionMode !== executionMode) {
        if (participant.session.nativeId) retire(participant, 'configuration');
      }
      if (state.deliveries.some(d => d.participantId === participant.id && ACTIVE.has(d.status))) throw new Error('Member is busy');
      if (state.deliveries.slice(0, state.deliveries.indexOf(delivery)).some(d => d.participantId === participant.id && d.status === 'queued')) throw new Error('Earlier member request is queued');
      const request = state.requests.find(r => r.id === delivery.requestId);
      if (request.mode === 'serial') {
        const prior = request.deliveryIds.slice(0, request.deliveryIds.indexOf(deliveryId));
        if (prior.some(key => {
          const previous = state.deliveries.find(d => d.id === key);
          return previous.status !== 'completed' && !previous.serialResolution;
        })) throw new Error('Previous serial member has not completed');
        delivery.inputThroughSeq = state.seq;
      }
      // A queued parallel snapshot can predate this member's last answer.
      // Rebuild rather than leaking future native context into that snapshot.
      const ownFuture = state.messages.some(m => m.seq > delivery.inputThroughSeq && participant.session.nativeOwnMessageIds.includes(m.id));
      if (participant.session.coveredThroughSeq > delivery.inputThroughSeq || ownFuture) retire(participant, 'snapshot');
      if (executionMode) participant.session.executionMode = executionMode;
      delivery.status = 'preparing'; delivery.generation = participant.session.generation;
      delivery.configVersion = participant.configVersion;
      delivery.profile = profile(participant);
      delivery.identityPrompt = participant.identityPrompt || '';
      delivery.permissionMode = state.permissionMode || 'ask';
      delivery.bindingFingerprint = bindingFingerprint(delivery.profile);
      delivery.runtimeId = participant.session.runtimeId;
      return delivery;
    }, { admission: true });
  }
  saveInput(id, deliveryId, generation, plan) {
    return this.store.update(id, state => {
      const { delivery } = this.active(state, deliveryId, generation);
      if (delivery.status !== 'preparing' || delivery.inputPlan) throw new Error('Input plan is already fixed');
      if (!plan || typeof plan.prompt !== 'string' || !plan.prompt.trim()
        || plan.inputThroughSeq !== delivery.inputThroughSeq) throw new Error('Invalid input plan');
      if (plan.attachments !== undefined) validateAttachments(plan.attachments, 256);
      // Exact serialized dispatch text, not merely the intended upper bound.
      // P3 adds coverage, attachment, summary and per-binding budget validation.
      delivery.inputPlan = { prompt: plan.prompt, inputThroughSeq: plan.inputThroughSeq, ...(plan.attachments?.length ? { attachments: structuredClone(plan.attachments) } : {}) };
      return delivery.inputPlan;
    });
  }
  activity(id, deliveryId, generation, phase) {
    return this.store.update(id, state => {
      const { delivery } = this.active(state, deliveryId, generation);
      const allowed = delivery.status === 'preparing' ? ['context', 'summary']
        : delivery.status === 'running' ? ['answer', 'approval'] : [];
      if (!allowed.includes(phase)) throw new Error('Invalid activity phase');
      delivery.phase = phase; return delivery;
    });
  }
  tool(id, deliveryId, generation, value) {
    return this.store.update(id, state => {
      const { delivery } = this.active(state, deliveryId, generation);
      if (delivery.status !== 'running') throw new Error('Delivery is not running');
      const tools = delivery.tools ||= [], prior = tools.find(tool => tool.id === value.id);
      const tool = { id: String(value.id), name: String(value.name || prior?.name || 'Tool').slice(0, 500),
        input: value.input ?? prior?.input ?? {}, output: String(value.output ?? prior?.output ?? '').slice(0, 24000),
        status: ['completed', 'failed', 'interrupted'].includes(value.status) ? value.status : 'running',
        ...(value.permissionBlocked ? { permissionBlocked: true } : {}) };
      if (JSON.stringify(tool.input).length > 12000) tool.input = { preview: JSON.stringify(tool.input).slice(0, 12000) };
      if (prior) Object.assign(prior, tool); else tools.push(tool);
      return tool;
    });
  }
  partial(id, deliveryId, generation, text) {
    if (typeof text !== 'string') throw new Error('Invalid partial reply');
    return this.store.update(id, state => {
      const { delivery } = this.active(state, deliveryId, generation);
      if (delivery.status !== 'running') throw new Error('Delivery is not running');
      // Only adapter-filtered public answer text belongs here, never reasoning
      // or raw tool events. Partial text is not part of the input transcript.
      delivery.partialText = text; return delivery;
    });
  }
  stop(id, deliveryId) {
    this.control(id).deliveries.add(deliveryId);
    const result = this.store.update(id, state => {
      const delivery = state.deliveries.find(d => d.id === deliveryId);
      if (!delivery) throw new Error('Delivery not found');
      if (delivery.status === 'queued') delivery.status = 'cancelled';
      else if (ACTIVE.has(delivery.status)) { delivery.status = 'stopping'; delivery.phase = 'stopping'; }
      return delivery;
    });
    if (!ACTIVE.has(result.status)) this.control(id).deliveries.delete(deliveryId);
    return result;
  }
  beginStopAll(id) {
    this.control(id).all = true;
    return this.store.update(id, state => {
      state.stopPending = true;
      for (const delivery of state.deliveries) {
        if (delivery.status === 'queued') delivery.status = 'cancelled';
        else if (ACTIVE.has(delivery.status)) { delivery.status = 'stopping'; delivery.phase = 'stopping'; }
      }
      return state.deliveries.filter(d => d.status === 'stopping');
    });
  }
  finishStopAll(id) {
    const result = this.store.update(id, state => {
      if (state.deliveries.some(d => OPEN.has(d.status))) throw new Error('Discussion is still stopping');
      if (state.participants.some(p => p.retiredSessions.some(s => s.recoveryRequired))) throw new Error('Discussion requires native activity recovery');
      delete state.stopPending; return state.id;
    });
    const control = this.control(id);
    control.all = false; control.deliveries.clear();
    return result;
  }
  confirmRetiredStop(id, participantId, runtimeId, confirmation) {
    if (confirmation?.stopped !== true || confirmation.released !== true || confirmation.runtimeId !== runtimeId) throw new Error('Retired stop is not confirmed');
    return this.store.update(id, state => {
      const participant = member(state, participantId);
      const retired = participant.retiredSessions.find(s => s.runtimeId === runtimeId);
      if (!retired) throw new Error('Retired session not found');
      // A previous successful turn may share this runtime/native ID. Recovery
      // must prove termination of the last interrupted delivery, not reuse the
      // proof from the earlier turn or infer shutdown from a missing handle.
      const interrupted = state.deliveries.filter(d => d.runtimeId === runtimeId
        && d.generation === retired.generation && d.status === 'interrupted');
      // Serial retries can be inserted before a later completed request in the
      // log. Array position is not necessarily native execution order.
      if (interrupted.length !== 1) throw new Error('Retired activity identity is not confirmed');
      stopped(interrupted[0], confirmation);
      retired.recoveryRequired = false; retired.resourcesReleased = true; return retired;
    });
  }
  confirmStop(id, deliveryId, generation, confirmation) {
    // The adapter must establish termination of the entire activity (including
    // summary/approval/tools). A cancel request or timeout is not confirmation.
    if (confirmation?.runtimeId == null || confirmation.stopped !== true) throw new Error('Stop is not confirmed');
    const delivery = this.get(id).deliveries.find(d => d.id === deliveryId);
    if (delivery?.status !== 'stopping' || delivery.runtimeId !== confirmation.runtimeId) throw new Error('Stale stop confirmation');
    return this.fail(id, deliveryId, generation, 'cancelled', confirmation);
  }
  resolveSerial(id, deliveryId, action, actionId) {
    required(actionId, 'action ID');
    if (!['skip', 'retry'].includes(action)) throw new Error('Invalid serial action');
    return this.store.update(id, state => {
      const delivery = state.deliveries.find(d => d.id === deliveryId);
      const request = state.requests.find(r => r.id === delivery?.requestId);
      if (request?.mode !== 'serial' || !RETRYABLE.has(delivery.status)) throw new Error('Serial delivery is not retryable');
      if (delivery.serialResolution) {
        if (delivery.resolutionActionId !== actionId || delivery.serialResolution !== action) throw new Error('Serial failure already resolved');
        return action === 'retry' ? state.deliveries.find(d => d.id === delivery.retryDeliveryId) : delivery;
      }
      const index = request.deliveryIds.indexOf(deliveryId);
      if (request.deliveryIds.slice(index + 1).some(key => state.deliveries.find(d => d.id === key).status !== 'queued')) throw new Error('Serial successors already changed');
      if (action === 'skip') {
        delivery.serialResolution = action; delivery.resolutionActionId = actionId; return delivery;
      }
      if (state.stopPending) throw new Error('Discussion is stopping');
      this.checkAdmission(id, delivery.participantId);
      const participant = availableMember(state, delivery.participantId);
      if (delivery.profile) {
        const previous = { ...delivery.profile }, current = profile(participant);
        // Retry a pre-migration failure against the same provider pool. All
        // other model, route, subscription and budget checks remain exact.
        if (current.connection === 'api' && current.accountRef && apiProviderRef(previous.accountRef) === current.accountRef)
          previous.accountRef = current.accountRef;
        if (JSON.stringify(previous) !== JSON.stringify(current)) throw new Error('Retry binding changed');
      }
      const retry = { id: randomUUID(), requestId: request.id, participantId: participant.id, status: 'queued',
        inputThroughSeq: null, generation: null, resultId: null, retryOf: delivery.id };
      delivery.serialResolution = action; delivery.resolutionActionId = actionId; delivery.retryDeliveryId = retry.id;
      request.deliveryIds.splice(index + 1, 0, retry.id);
      state.deliveries.splice(state.deliveries.indexOf(delivery) + 1, 0, retry);
      return retry;
    }, { admission: true });
  }
  start(id, deliveryId, generation, nativeId, storage) {
    required(nativeId, 'native ID');
    return this.store.update(id, state => {
      const { delivery, participant } = this.active(state, deliveryId, generation);
      if (delivery.status !== 'preparing') throw new Error('Delivery is not preparing');
      if (!delivery.inputPlan) throw new Error('Input plan must be saved before dispatch');
      this.checkAdmission(id, delivery.participantId, deliveryId);
      if (participant.session.nativeId && participant.session.nativeId !== nativeId) throw new Error('Native session changed without a new generation');
      const nativeStorage = storage === undefined ? participant.session.nativeStorage : validateStorage(storage);
      if (nativeStorage && (participant.engine !== 'antigravity' || nativeStorage.connection !== participant.connection)) throw new Error('Native storage binding mismatch');
      if (participant.session.nativeStorage && !sameStorage(participant.session.nativeStorage, nativeStorage)) throw new Error('Native storage changed without a new generation');
      // The store is a synchronous main-process single writer: inspect every
      // group before committing ownership, including removed/retired authors.
      const groups = [state, ...this.store.list().filter(group => group.id !== id)];
      if (groups.some(group => group.participants.some(p =>
        ((group.id !== id || p.id !== participant.id) && p.engine === participant.engine
          && (p.session.nativeId === nativeId || sameStorage(p.session.nativeStorage, nativeStorage)))
        || p.retiredSessions.some(s => s.profile.engine === participant.engine && (s.nativeId === nativeId || sameStorage(s.nativeStorage, nativeStorage)))))) {
        throw new Error('Native session already belongs to another member');
      }
      participant.session.nativeId = nativeId; delivery.nativeId = nativeId;
      if (nativeStorage) { participant.session.nativeStorage = validateStorage(nativeStorage); delivery.nativeStorage = validateStorage(nativeStorage); }
      delivery.status = 'running'; delivery.phase = 'answer'; return delivery;
    });
  }
  active(state, deliveryId, generation) {
    const delivery = state.deliveries.find(d => d.id === deliveryId);
    if (!delivery || !ACTIVE.has(delivery.status) || delivery.generation !== generation) throw new Error('Stale delivery');
    const participant = member(state, delivery.participantId);
    if (participant.session.generation !== generation) throw new Error('Stale generation');
    return { delivery, participant };
  }
  rejectQueued(id, deliveryId, reason) {
    required(reason, 'unavailable reason');
    return this.store.update(id, state => {
      const delivery = state.deliveries.find(d => d.id === deliveryId);
      if (!delivery || delivery.status !== 'queued') throw new Error('Delivery is not queued');
      delivery.status = 'failed'; delivery.unavailableReason = reason;
      delivery.profile = profile(member(state, delivery.participantId));
      return delivery;
    });
  }
  recordSettlement(id, deliveryId, generation, outcome) {
    if (!outcome || !['completed', 'failed', 'cancelled'].includes(outcome.status)) throw new Error('Invalid settlement');
    const intent = outcome.status === 'completed'
      ? { status: outcome.status, text: validateReply(required(outcome.text, 'reply')) } : { status: outcome.status };
    return this.store.update(id, state => {
      const existing = state.deliveries.find(d => d.id === deliveryId);
      if (existing?.generation === generation && existing.settlement) {
        if (JSON.stringify(existing.settlement) !== JSON.stringify(intent)) throw new Error('Conflicting settlement');
        return existing.settlement;
      }
      const { delivery } = this.active(state, deliveryId, generation);
      if (intent.status === 'completed') {
        if (!delivery.nativeId || !delivery.inputPlan) throw new Error('Delivery has not started');
        delivery.partialText = intent.text;
      }
      delivery.settlement = intent; return intent;
    });
  }
  complete(id, deliveryId, generation, text, confirmation) {
    validateReply(required(text, 'reply'));
    const result = this.store.update(id, state => {
      const existing = state.deliveries.find(d => d.id === deliveryId);
      if (existing?.status === 'completed' && existing.generation === generation) {
        const result = state.messages.find(m => m.id === existing.resultId);
        if (result.text !== text) throw new Error('Conflicting completion');
        return result;
      }
      const { delivery, participant } = this.active(state, deliveryId, generation);
      if (delivery.status !== 'running' && !(delivery.status === 'stopping' && delivery.settlement?.status === 'completed')) throw new Error('Delivery is not running');
      if (delivery.settlement && (delivery.settlement.status !== 'completed' || delivery.settlement.text !== text)) throw new Error('Conflicting settlement');
      stopped(delivery, confirmation);
      const result = append(state, { role: 'assistant', speakerId: participant.id, speakerName: participant.name,
        requestId: delivery.requestId, deliveryId, text });
      delivery.resultId = result.id; delivery.status = 'completed'; delete delivery.phase;
      finishTools(delivery);
      participant.session.coveredThroughSeq = delivery.inputThroughSeq;
      participant.session.nativeOwnMessageIds.push(result.id);
      return result;
    });
    this.control(id).deliveries.delete(deliveryId);
    return result;
  }
  fail(id, deliveryId, generation, status = 'failed', confirmation = null, reason = null) {
    if (!['failed', 'cancelled'].includes(status)) throw new Error('Invalid terminal state');
    const result = this.store.update(id, state => {
      const existing = state.deliveries.find(d => d.id === deliveryId);
      if (existing?.status === status && existing.generation === generation) return existing;
      const { delivery, participant } = this.active(state, deliveryId, generation);
      stopped(delivery, confirmation);
      if (delivery.settlement && delivery.settlement.status !== status) throw new Error('Conflicting settlement');
      delivery.status = status; delete delivery.phase;
      finishTools(delivery);
      if (status === 'failed' && reason) delivery.failureReason = String(reason).slice(0, 600);
      // Call only after driver stop confirmation. Public history is retained;
      // an uncertain native input must not be reused by the next request.
      retire(participant, status); return delivery;
    });
    this.control(id).deliveries.delete(deliveryId);
    return result;
  }
  recover() {
    // Startup only, before any drivers run. No inference or automatic retries.
    for (const state of this.store.list()) {
      if (!state.deliveries.some(d => OPEN.has(d.status))) continue;
      this.store.update(state.id, value => {
        for (const delivery of value.deliveries) if (OPEN.has(delivery.status)) {
          // A restarted app has lost process handles. Retiring the context is
          // not proof that a native process or its descendants have stopped.
          if (ACTIVE.has(delivery.status)) retire(member(value, delivery.participantId), 'interrupted', true);
          delivery.status = 'interrupted'; delete delivery.phase;
          finishTools(delivery);
        }
        return value.id;
      });
    }
  }
}

module.exports = { DiscussionManager };
