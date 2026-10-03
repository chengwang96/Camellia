'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { DiscussionManager } = require('./manager');
const { DiscussionScheduler } = require('./scheduler');
const { evaluateCapability, bindingFingerprint } = require('./capabilities');
const { prepareTextInput } = require('./context');
const { validateReply } = require('./schema');
const { DiscussionAssets } = require('./assets');
const { resolveArtifacts } = require('../../main/turn-artifacts');

const { ENGINES: SUPPORTED_ENGINES, apiProviderRef } = require('./catalog');
const ENGINES = new Set(SUPPORTED_ENGINES);
const OPEN = new Set(['queued', 'preparing', 'running', 'stopping']);
function input(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid discussion request');
  return value;
}

class DiscussionService {
  constructor({ dataDir, registry, production, getCatalog = () => [], onEvent = () => {}, onError = () => {}, manager, adapters, platform = process.platform }) {
    this.onError = onError;
    this.platform = platform; this.getCatalog = getCatalog; this.onEvent = onEvent;
    this.root = path.join(dataDir, 'discussions');
    this.assets = new DiscussionAssets(this.root);
    this.manager = manager || new DiscussionManager({ dir: this.root });
    this.registry = registry; this.production = production; this.adapters = adapters || {};
    this.pendingStarts = new Map();
    this.memberChecks = new Map();
    this.verificationErrors = new Map();
    this.scheduler = new DiscussionScheduler({ manager: this.manager, registry, adapters: this.adapters,
      prepareInput: (state, delivery, signal, capability) => {
        const plan = prepareTextInput(state, delivery, signal, capability);
        if (plan.attachments?.length) this.assets.resolve(state.id, plan.attachments, 256);
        return plan;
      }, onError, onEvent: event => this.publish(event.discussionId, event) });
    this.manager.recover();
  }
  publish(id, event = {}) {
    try { this.onEvent({ ...event, discussionId: id, type: event.type || 'changed' }); }
    catch { /* rendering cannot undo a committed write */ }
  }
  capability(binding) {
    const adapter = this.registry ? this.registry.get(binding.engine) : this.adapters[binding.engine];
    const value = evaluateCapability(binding, adapter?.runtime, adapter?.evidence?.(binding));
    return !value.available && this.production ? { ...value, detail: this.production.reason(binding),
      canVerify: this.production.canVerify(binding), supported: this.production.canVerify(binding) } : value;
  }
  async catalog() {
    this.production?.refresh();
    const values = await this.getCatalog();
    return values.filter(row => ENGINES.has(row.binding?.engine) && ['api', 'subscription'].includes(row.binding.connection))
      .map(row => ({ id: bindingFingerprint(row.binding), label: String(row.label || row.binding.model),
        providerId: String(row.providerId || ''), providerLabel: String(row.providerLabel || ''),
        accountLabel: String(row.accountLabel || ''), binding: { engine: row.binding.engine, connection: row.binding.connection,
          model: row.binding.model, accountRef: row.binding.accountRef ?? null, thinking: row.binding.thinking || '',
          contextWindow: row.binding.contextWindow || 0 }, capability: this.capability(row.binding) }));
  }
  view(state) {
    // The renderer needs public discussion state, not native IDs, directories,
    // generated input plans, account homes, launch credentials or ownership records.
    return { id: state.id, title: state.title, pinned: Boolean(state.pinned), revision: state.revision, seq: state.seq, stopping: Boolean(state.stopPending),
      cwd: state.cwd, permissionMode: state.permissionMode || 'ask', permissions: this.scheduler.permissions(state.id),
      verifying: [...this.pendingStarts.values()].some(row => row.id === state.id),
      participants: state.participants.map(p => ({ id: p.id, name: p.name, engine: p.engine, connection: p.connection,
        model: p.model, accountLabel: p.accountLabel || '', identityPrompt: p.identityPrompt || '', thinking: p.thinking, contextWindow: p.contextWindow, removed: p.removed,
        removalPending: Boolean(p.removalPending), recoveryRequired: p.retiredSessions.some(s => s.recoveryRequired),
        verifying: [...this.pendingStarts.values()].some(row => row.id === state.id && row.participantIds.includes(p.id)),
        verificationError: this.verificationErrors.get(p.id) || null,
        coveredThroughSeq: p.session.coveredThroughSeq, capability: this.capability(p) })),
      messages: state.messages.map(m => ({ id: m.id, seq: m.seq, role: m.role, speakerId: m.speakerId,
        speakerName: m.speakerName, requestId: m.requestId, deliveryId: m.deliveryId, text: m.text, attachments: m.attachments || [] })),
      deliveries: state.deliveries.map(d => ({ id: d.id, participantId: d.participantId, requestId: d.requestId,
        status: d.status, phase: d.phase, partialText: d.partialText, reason: d.unavailableReason || d.failureReason,
        serialResolution: d.serialResolution, inputThroughSeq: d.inputThroughSeq, tools: d.tools || [] })),
      requests: state.requests.map(r => ({ id: r.id, mode: r.mode, messageId: r.messageId, deliveryIds: r.deliveryIds })),
    };
  }
  list() {
    return this.manager.list().map(s => ({ id: s.id, title: s.title, pinned: Boolean(s.pinned), revision: s.revision, seq: s.seq,
      members: s.participants.filter(p => !p.removed).length, active: this.busy(s.id, s),
      preview: (s.messages.at(-1)?.text || '').slice(0, 120) }))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned));
  }
  busy(id, state = this.manager.get(id)) {
    return state.stopPending || state.deliveries.some(d => OPEN.has(d.status))
      || [...this.pendingStarts.values()].some(row => row.id === id)
      || [...this.memberChecks.values()].some(row => row.id === id)
      || [...this.scheduler.runs.values()].some(run => run.identity.discussionId === id)
      || state.participants.some(p => this.production?.checks.has(bindingFingerprint(p)) || p.retiredSessions.some(s => s.recoveryRequired));
  }
  upgradeApiMember(id, member, catalog) {
    if (member.connection !== 'api' || member.removed || member.removalPending) return member;
    const accountRef = apiProviderRef(member.accountRef);
    if (!accountRef || accountRef === member.accountRef) return member;
    const row = catalog.find(row => row.binding.accountRef === accountRef
      && ['engine', 'connection', 'model', 'thinking'].every(key => (row.binding[key] ?? '') === (member[key] ?? '')));
    if (!row) return member;
    // Older beta members pinned an individual key. Preserve their provider,
    // model, route and public history; rebuild native context under the new
    // provider binding through the existing configuration-change lifecycle.
    return this.manager.configureMember(id, member.id, { accountRef, accountLabel: row.accountLabel,
      contextWindow: member.contextWindow || row.binding.contextWindow });
  }
  async prepareMembers(id, participantIds, dispatch) {
    // Adding a member, explicit verification and sending can check connections.
    // Loading a saved group never starts a check. Keep the user's text
    // uncommitted until every selected connection can actually answer.
    if (!this.production || !participantIds.length) return dispatch();
    const pending = { id, participantIds: [...participantIds], cancelled: false };
    const token = randomUUID(); this.pendingStarts.set(token, pending); this.publish(id);
    try {
      this.production.refresh();
      const catalog = await this.getCatalog();
      const members = participantIds.map(participantId => {
        let member = this.manager.get(id).participants.find(p => p.id === participantId && !p.removed);
        if (!member) throw new Error('Member not found');
        this.manager.checkAdmission(id, member.id);
        if (member.removalPending || member.retiredSessions.some(s => s.recoveryRequired)) throw new Error('Member requires native activity recovery');
        member = this.upgradeApiMember(id, member, catalog);
        // Early beta records saved a zero context window. Fill only that
        // missing metadata from the same model/account; never swap bindings.
        if (!member.contextWindow) {
          const row = catalog.find(row => ['engine', 'connection', 'model', 'accountRef', 'thinking']
            .every(key => (row.binding[key] ?? '') === (member[key] ?? '')) && row.binding.contextWindow > 0);
          if (row) member = this.manager.configureMember(id, member.id, { contextWindow: row.binding.contextWindow });
        }
        const capability = this.capability(member);
        if (!capability.available && !capability.canVerify) throw new Error(capability.detail || 'This connection cannot be verified in this version.');
        if (!member.contextWindow) throw new Error('Set a context window for this model before sending.');
        return member;
      });
      if (pending.cancelled) throw new Error('Discussion cancelled');
      for (const member of members) {
        if (pending.cancelled) throw new Error('Discussion cancelled');
        if (!this.capability(member).available) await this.production.verify(member);
      }
      if (pending.cancelled) throw new Error('Discussion cancelled');
      return dispatch();
    } finally { this.pendingStarts.delete(token); this.publish(id); }
  }
  verifyMember(id, participantId) {
    const current = this.memberChecks.get(participantId);
    if (current) return current.promise;
    this.verificationErrors.delete(participantId);
    const promise = this.prepareMembers(id, [participantId], () => {}).catch(error => {
      const member = this.manager.get(id).participants.find(p => p.id === participantId);
      if (member && !member.removed) this.verificationErrors.set(participantId, String(error.message || error));
      throw error;
    }).finally(() => { this.memberChecks.delete(participantId); this.publish(id); });
    this.memberChecks.set(participantId, { id, promise });
    return promise;
  }
  async call(action, payload = {}, { authorize = () => {} } = {}) {
    input(payload);
    authorize();
    if (this.platform !== 'win32') throw new Error('Agent discussions are currently available on Windows desktop.');
    if (action === 'catalog') return { bindings: await this.catalog() };
    if (action === 'cancel-verification') { this.production?.cancel(payload.bindingId); return {}; }
    if (action === 'verify-binding') {
      const row = (await this.catalog()).find(row => row.id === payload.bindingId);
      if (!row || !this.production) throw new Error('This connection cannot be verified in this version.');
      await this.production.verify(row.binding);
      this.publish(null);
      return { bindings: await this.catalog() };
    }
    if (action === 'list') return { groups: this.list() };
    if (action === 'create') {
      const title = String(payload.title || '').trim() || 'Agent discussion';
      if (title.length > 120) throw new Error('Use a discussion title of at most 120 characters.');
      const work = path.join(this.root, 'work', randomUUID()); fs.mkdirSync(work, { recursive: true });
      const state = this.manager.create({ title, cwd: work });
      this.publish(state.id); return { group: this.view(state) };
    }
    const state = this.manager.get(payload.id);
    if (action === 'import-attachments') return { attachments: this.assets.import(state.id, payload.paths) };
    if (action === 'artifacts') {
      const delivery = state.deliveries.find(d => d.id === payload.deliveryId);
      const message = state.messages.find(m => m.deliveryId === delivery?.id);
      if (!delivery || delivery.status !== 'completed') return { files: [] };
      return { files: resolveArtifacts({ text: message?.text || '', cwd: state.cwd,
        paths: (delivery.tools || []).filter(t => t.status === 'completed' && /write|edit|create|save|output|export|patch/i.test(t.name))
          .flatMap(t => [t.input?.file_path, t.input?.TargetFile, t.input?.path, t.input?.output_path].filter(p => typeof p === 'string')) }) };
    }
    if (action === 'load') {
      this.production?.refresh();
      if (!this.busy(state.id, state) && state.participants.some(p => p.connection === 'api' && apiProviderRef(p.accountRef) && apiProviderRef(p.accountRef) !== p.accountRef)) {
        const catalog = await this.getCatalog(), current = this.manager.get(state.id);
        if (!this.busy(state.id, current)) for (const member of current.participants) this.upgradeApiMember(state.id, member, catalog);
      }
      return { group: this.view(this.manager.get(state.id)) };
    }
    if (action === 'delete') {
      if (this.busy(state.id, state)) throw new Error('Stop all replies before deleting this discussion.');
      this.manager.remove(state.id);
      for (const member of state.participants) this.verificationErrors.delete(member.id);
      try { this.assets.remove(state.id); } catch (error) { this.onError(error); }
      this.publish(state.id, { type: 'deleted' });
      return { deletedId: state.id, groups: this.list() };
    }
    if (action === 'verify-member') {
      const member = state.participants.find(p => p.id === payload.participantId && !p.removed);
      if (!member || !this.production) throw new Error('This connection cannot be verified in this version.');
      await this.verifyMember(state.id, member.id);
      this.publish(state.id); return { group: this.view(this.manager.get(state.id)), groups: this.list() };
    }
    if (action === 'cancel-member-verification') {
      for (const pending of this.pendingStarts.values()) if (pending.id === state.id && pending.participantIds.includes(payload.participantId)) pending.cancelled = true;
      const member = state.participants.find(p => p.id === payload.participantId);
      if (member) this.production?.cancel(bindingFingerprint(member));
      return {};
    }
    if (action === 'permission-response') {
      this.scheduler.answerPermission(state.id, payload);
    } else if (action === 'set-permission') {
      if (this.busy(state.id, state)) throw new Error('Stop replies before changing permissions.');
      this.manager.setPermission(state.id, payload.permissionMode);
    } else if (action === 'rename') {
      if (typeof payload.title !== 'string' || !payload.title.trim()) throw new Error('Enter a discussion title.');
      this.manager.rename(state.id, payload.title);
    } else if (action === 'pin') {
      this.manager.setPinned(state.id, payload.pinned);
    } else if (action === 'set-identity') {
      const member = state.participants.find(p => p.id === payload.participantId && !p.removed);
      if (!member) throw new Error('Member not found');
      if ([...this.pendingStarts.values()].some(row => row.id === state.id && row.participantIds.includes(member.id))
        || this.production?.checks.has(bindingFingerprint(member)))
        throw new Error('Wait for this member to finish replying or stop it before editing its identity.');
      this.manager.setIdentityPrompt(state.id, member.id, payload.identityPrompt);
    } else if (action === 'add-member') {
      if (state.participants.filter(p => !p.removed).length >= 4) throw new Error('A discussion can have at most 4 members.');
      const row = (await this.catalog()).find(b => b.id === payload.bindingId);
      authorize();
      if (!row) throw new Error('This model or account is no longer available. Refresh the member list.');
      if (row.capability.supported === false) throw new Error(row.capability.detail);
      // Re-read after the asynchronous catalog lookup so concurrent additions
      // cannot both consume the last member slot.
      if (this.manager.get(state.id).participants.filter(p => !p.removed).length >= 4) throw new Error('A discussion can have at most 4 members.');
      const name = String(payload.name || row.binding.model).trim();
      if (!name || name.length > 80) throw new Error('Use a member name between 1 and 80 characters.');
      const member = this.manager.addMember(state.id, { ...row.binding, accountLabel: row.accountLabel, name, identityPrompt: payload.identityPrompt });
      // Save immediately, then check in the background. Verification failures
      // belong to the saved member and must not turn a successful add into an
      // error or cause the UI to add the same member again.
      if (this.production && !row.capability.available && row.capability.canVerify) {
        void this.verifyMember(state.id, member.id).catch(() => {});
      }
    } else if (action === 'remove-member') {
      for (const pending of this.pendingStarts.values()) if (pending.id === state.id && pending.participantIds.includes(payload.participantId)) pending.cancelled = true;
      const member = state.participants.find(p => p.id === payload.participantId);
      if (member) this.production?.cancel(bindingFingerprint(member));
      await this.scheduler.removeMember(state.id, payload.participantId);
      this.verificationErrors.delete(payload.participantId);
    } else if (action === 'send') {
      const attachments = this.assets.resolve(state.id, payload.attachments || []);
      if (typeof payload.text !== 'string') throw new Error('Enter a message.');
      if (!payload.text.trim() && attachments.length) payload = { ...payload, text: 'Please review and process these attachments.' };
      if (!payload.text.trim()) throw new Error('Enter a message.');
      validateReply(payload.text);
      if (typeof payload.requestId !== 'string' || !payload.requestId.trim() || Buffer.byteLength(JSON.stringify(payload.requestId)) > 1024) throw new Error('Invalid request ID');
      if (!Array.isArray(payload.participantIds) || new Set(payload.participantIds).size !== payload.participantIds.length
        || !['parallel', 'serial'].includes(payload.mode || 'parallel')) throw new Error('Choose the members to mention.');
      if (state.requests.some(r => r.id === payload.requestId)) {
        this.scheduler.enqueue(state.id, { requestId: payload.requestId, text: payload.text, participantIds: payload.participantIds, mode: payload.mode || 'parallel', attachments });
      } else await this.prepareMembers(state.id, payload.participantIds, () => {
        authorize();
        const current = this.manager.get(state.id);
        const historyAttachments = [...new Map([...current.messages.flatMap(m => m.attachments || []), ...attachments].map(a => [a.id, a])).values()];
        this.assets.resolve(state.id, historyAttachments, 256);
        if (historyAttachments.some(a => a.isImage)) for (const p of current.participants.filter(p => payload.participantIds.includes(p.id))) {
          if (this.capability(p).supportsImages !== true) throw new Error(p.name + ': This connection does not support image input.');
        }
        return this.scheduler.enqueue(state.id, { requestId: payload.requestId, text: payload.text, participantIds: payload.participantIds, mode: payload.mode || 'parallel', attachments });
      });
    } else if (action === 'stop') {
      for (const pending of this.pendingStarts.values()) if (pending.id === state.id
        && (!payload.participantId || pending.participantIds.includes(payload.participantId))) pending.cancelled = true;
      for (const member of state.participants) if (!payload.participantId || member.id === payload.participantId) this.production?.cancel(bindingFingerprint(member));
      if (payload.deliveryId) await this.scheduler.stop(state.id, payload.deliveryId);
      else {
        const results = await this.scheduler.stopAll(state.id, payload.participantId || null);
        if (results.some(r => r.status === 'rejected')) throw new Error('Some activities have not confirmed stopping. Try Stop again.');
      }
    } else if (action === 'resolve-serial') {
      this.scheduler.resolveSerial(state.id, payload.deliveryId, payload.resolution, payload.actionId);
    } else if (action === 'retry') {
      const delivery = state.deliveries.find(d => d.id === payload.deliveryId);
      const request = state.requests.find(r => r.id === delivery?.requestId);
      if (!delivery || !['failed', 'cancelled', 'interrupted'].includes(delivery.status)) throw new Error('This response cannot be retried.');
      await this.prepareMembers(state.id, [delivery.participantId], () => {
        authorize();
        if (request.mode === 'serial') this.scheduler.resolveSerial(state.id, delivery.id, 'retry', payload.actionId);
        else this.scheduler.enqueue(state.id, { requestId: payload.actionId, participantIds: [delivery.participantId],
          text: state.messages.find(m => m.id === request.messageId).text, attachments: state.messages.find(m => m.id === request.messageId).attachments || [], mode: 'parallel' });
      });
    } else throw Object.assign(new Error('Unknown discussion action'), { code: 'DISCUSSION_ACTION_UNSUPPORTED' });
    this.publish(state.id); return { group: this.view(this.manager.get(state.id)), groups: this.list() };
  }
  get active() { return this.scheduler.runs.size > 0 || this.pendingStarts.size > 0 || this.memberChecks.size > 0 || Boolean(this.production?.checks.size); }
  async shutdown() {
    const token = this.scheduler.suspend({ reason: 'app-exit' });
    for (const pending of this.pendingStarts.values()) pending.cancelled = true;
    await this.production?.shutdown();
    await Promise.allSettled([...this.memberChecks.values()].map(check => check.promise));
    return this.scheduler.drainSuspension(token);
  }
}

module.exports = { DiscussionService };
