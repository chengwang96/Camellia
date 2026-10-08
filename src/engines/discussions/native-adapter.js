'use strict';

const { evaluateCapability, bindingFingerprint } = require('./capabilities');
const path = require('node:path');
const { validSessionId } = require('../claude-history');
const { NativeSessionOwnership } = require('./native-ownership');
const { createDiscussionLaunch, revokeDiscussionLaunch } = require('./native-launch');
const { nativeStorage, sameStorage } = require('./native-storage');
const { validateAttachments } = require('./assets');

const IDENTITY_FIELDS = ['discussionId', 'threadId', 'participantId', 'requestId',
  'deliveryId', 'generation', 'runtimeId', 'bindingFingerprint'];
const abortError = () => Object.assign(new Error('Discussion activity cancelled'), { name: 'AbortError' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Bridge for the existing Codex/ACP session contracts. A reviewed policy must
// configure enforcement BEFORE ensure(), verify the opened session and prove
// all activity stopped. None is supplied by default. Labels such as plan and
// session.dead/running are deliberately not treated as policy or stop proof.
class NativeDiscussionAdapter {
  constructor({ engine, driver, runtime, evidence = () => null, policy = null, ownership = null }) {
    this.engine = engine; this.driver = driver; this.runtime = runtime;
    this.reviewedEvidence = evidence; this.policy = policy; this.ownership = ownership;
    this.active = new Map(); this.owned = new Set();
    this.activities = new Set();
  }
  evidence(binding) {
    if (binding.engine !== this.engine || !(this.ownership instanceof NativeSessionOwnership)
      || !['prepare', 'verify', 'confirmStopped'].every(key => typeof this.policy?.[key] === 'function')) return null;
    return this.reviewedEvidence(binding);
  }
  gate(binding) {
    const capability = evaluateCapability(binding, this.runtime, this.evidence(binding));
    if (!capability.available) throw new Error('Discussion connection unavailable: ' + capability.reason);
    return capability;
  }
  create(input) {
    // Allocation only; no process, account lookup or inference until execute().
    if (!input || ['discussionId', 'threadId', 'participantId', 'deliveryId', 'runtimeId'].some(key => !UUID.test(input[key]))
      || typeof input.requestId !== 'string' || !input.requestId.trim()
      || !Number.isSafeInteger(input.generation) || input.generation < 1
      || !input.profile || typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)
      || input.nativeId != null && !validSessionId(input.nativeId)) throw new Error('Invalid native discussion identity');
    const identity = Object.freeze(Object.fromEntries(IDENTITY_FIELDS.map(key => [key, input[key]])));
    if (this.engine === 'antigravity' && input.nativeId && input.nativeStorage === undefined) throw new Error('Antigravity continuation requires persisted native storage');
    if (input.nativeStorage !== undefined && (this.engine !== 'antigravity' || !input.nativeId
      || nativeStorage(input.nativeStorage).connection !== input.profile.connection)) throw new Error('Invalid native discussion storage');
    if (identity.bindingFingerprint !== bindingFingerprint(input.profile)) throw new Error('Discussion binding mismatch');
    return new NativeActivity(this, { ...structuredClone(input), identity });
  }
  capture(engine, event) {
    if (engine !== this.engine || !this.owned.has(event?.conversationId)) return false;
    // Consume even stale events so they cannot fall through to ordinary chat.
    this.active.get(event.conversationId)?.capture(event);
    return true;
  }
}

class NativeActivity {
  constructor(adapter, input) {
    this.adapter = adapter; this.input = input; this.identity = input.identity;
    this.cancelled = false; this.closed = false; this.blocks = new Map(); this.lastSeq = 0;
    this.completion = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    // Startup/verification can still be pending when cancellation rejects it.
    this.completion.catch(() => {});
  }
  emit(type, data = {}) {
    const accepted = this.onEvent({ ...data, ...this.identity, type });
    // Acknowledge synchronously: start/control events are durable, while answer
    // drafts are checkpointed. A pending promise cannot authorize dispatch or
    // leak its rejection into the driver's event loop.
    if (accepted && typeof accepted.then === 'function') {
      Promise.resolve(accepted).catch(() => {}); return false;
    }
    return accepted;
  }
  check() { if (this.cancelled || this.signal?.aborted) throw abortError(); }
  execute(args) {
    if (this.executing || this.closed || this.cancelled) return Promise.reject(new Error('Native discussion activity already dispatched or stopped'));
    this.executing = true;
    this.adapter.activities.add(this);
    this.execution = this.run(args);
    return this.execution;
  }
  async run({ plan, signal, onEvent }) {
    this.signal = signal; this.onEvent = onEvent;
    const { adapter, input, identity } = this;
    const opts = { conversationId: identity.runtimeId, sessionId: input.nativeId, cwd: input.cwd,
      workspaceId: null, goalBridge: undefined };
    this.opts = opts;
    const abort = () => { void this.cancel(); };
    signal?.addEventListener('abort', abort, { once: true }); this.detachAbort = () => signal?.removeEventListener('abort', abort);
    try {
      this.check();
      if (typeof plan?.prompt !== 'string' || !plan.prompt.trim()) throw new Error('Native discussion input requires a validated text plan');
      validateAttachments(plan.attachments || [], 256);
      if (plan.attachments?.length && adapter.gate(input.profile).mode !== 'native-tools') throw new Error('Attachments require native tool mode');
      if (adapter.active.has(identity.runtimeId) || adapter.driver.sessions.get(opts)) throw new Error('Native runtime is already occupied');
      adapter.gate(input.profile);
      this.ownershipLease = adapter.ownership.reserve({ ...identity, engine: adapter.engine, nativeId: input.nativeId });
      adapter.owned.add(identity.runtimeId);
      // Policy preparation may resolve a referenced account, but must not infer
      // or modify global settings. It must return enforced launch settings.
      this.preparing = true;
      const prepared = await adapter.policy.prepare({ identity, profile: structuredClone(input.profile), cwd: input.cwd, signal, permissionMode: input.permissionMode || 'ask' });
      this.check();
      adapter.ownership.assert(this.ownershipLease);
      const capability = adapter.gate(input.profile);
      const settings = prepared?.settings;
      if (!settings || settings.model !== input.profile.model || settings.connection !== input.profile.connection
        || (settings.thinkingBudget || '') !== input.profile.thinking
        || (input.profile.connection === 'subscription' && settings.subscriptionId !== input.profile.accountRef)) {
        throw new Error('Native policy changed the member binding');
      }
      opts.discussionLaunch = createDiscussionLaunch({ engine: adapter.engine, identity, cwd: input.cwd,
        nativeId: input.nativeId, settings, launch: prepared.launch });
      // Recheck after await; never replace a concurrently occupied pool slot.
      if (adapter.active.has(identity.runtimeId) || adapter.driver.sessions.get(opts)) throw new Error('Native runtime is already occupied');
      adapter.active.set(identity.runtimeId, this); adapter.owned.add(identity.runtimeId);
      this.claimed = true;
      try { this.session = adapter.driver.ensure({ ...opts, settings }); }
      catch (error) { this.session = adapter.driver.sessions.get(opts); throw error; }
      const session = this.session;
      if (!session || adapter.driver.sessions.get(opts) !== session || !Number.isSafeInteger(session.gen)) throw new Error('Invalid native discussion session');
      if (session.opts?.goalBridge || session.opts?.conversationId !== identity.runtimeId
        || session.opts?.discussionLaunch !== opts.discussionLaunch) throw new Error('Native discussion session is not isolated');
      adapter.ownership.claimProcess(this.ownershipLease, session.gen);
      if (typeof session.open !== 'function') throw new Error('Native session cannot be prepared before dispatch');
      await (session.ready ||= session.open());
      this.check(); adapter.gate(input.profile);
      let preparedNativeId;
      if (adapter.engine === 'antigravity') {
        if (typeof session.prepareNativeStorage !== 'function') throw new Error('Native storage preparation is unavailable');
        preparedNativeId = await session.prepareNativeStorage();
        this.check(); adapter.gate(input.profile);
      }
      if (await adapter.policy.verify({ session, profile: structuredClone(input.profile), capability, signal }) !== true) throw new Error('Native enforcement or binding could not be verified');
      this.check(); adapter.gate(input.profile);
      if (!validSessionId(session.sessionId) || input.nativeId && session.sessionId !== input.nativeId) throw new Error('Native continuation changed without a new generation');
      const storage = adapter.ownership.claimNative(this.ownershipLease, session.sessionId);
      if (adapter.engine === 'antigravity' && storage?.conversationId !== preparedNativeId) throw new Error('Prepared native identity does not match verified storage');
      if (input.nativeStorage && !sameStorage(input.nativeStorage, storage)
        || storage && storage.connection !== input.profile.connection) throw new Error('Native storage binding changed');
      // Ownership is committed by the scheduler before any turn input is sent.
      if (this.emit('started', { nativeId: session.sessionId, ...(storage ? { nativeStorage: storage } : {}) }) !== true) throw new Error('Native discussion start was rejected');
      this.started = true; this.check();
      adapter.ownership.assert(this.ownershipLease);
      if (plan.attachments?.some(a => a.isImage) && capability.supportsImages !== true) throw new Error('This connection does not support image input.');
      if (!session.sendUserMessage(plan.prompt, plan.attachments || [])) throw new Error('Native engine did not accept the discussion input');
      return await this.completion;
    } finally {
      this.closed = true; this.executionFinished = true; this.detachAbort?.();
    }
  }
  finish(error, result) {
    if (this.ended) return;
    this.ended = true; this.closed = true;
    if (error) this.reject(error); else this.resolve(result);
  }
  respond({ requestId, runId, allow, input, optionId }) {
    if (!this.started || this.closed || this.cancelled || this.session?.gen !== runId) return false;
    return this.session.answerPermission?.(requestId, allow, input, undefined, optionId) === true;
  }
  capture(event) {
    const session = this.session;
    if (this.closed || this.cancelled || !session || event.runId !== session.gen) return;
    if (event.session_id && event.session_id !== session.sessionId) return;
    if (!Number.isSafeInteger(event.eventSeq) || event.eventSeq <= this.lastSeq) return;
    this.lastSeq = event.eventSeq;
    try {
      if (event.type === 'gui:permission') {
        if (this.started && this.adapter.gate(this.input.profile).mode === 'native-tools') {
          const permission = Object.fromEntries(['requestId', 'runId', 'toolName', 'input', 'options', 'questions', 'reason'].filter(key => event[key] !== undefined).map(key => [key, event[key]]));
          if (this.emit('permission', { permission }) !== true) throw new Error('Native permission request was rejected');
          return;
        }
        // Read-only discussion cannot escalate. Runtime policy is the primary
        // control; rejecting an unexpected interaction is an additional guard.
        session.answerPermission?.(event.requestId, false);
        throw new Error('Unexpected native permission request in discussion');
      }
      if (event.type === 'gui:tool' && this.adapter.gate(this.input.profile).mode === 'tool-free') {
        throw new Error('Unexpected native tool activity in text-only discussion');
      }
      if (!this.started) return;
      if (event.type === 'gui:tool') {
        if (event.permissionBlocked) this.permissionBlockedText = event.output;
        if (this.emit('tool', { tool: event }) !== true) throw new Error('Native tool event was rejected');
        return;
      }
      // Claude streams native tool_use/tool_result content blocks instead of
      // the normalized GUI tool events used by the other transports.
      if (this.adapter.engine === 'claude' && ['assistant', 'user'].includes(event.type)) {
        for (const block of event.message?.content || []) {
          if (block.type === 'tool_use') this.emit('tool', { tool: { id: block.id, name: block.name, input: block.input, status: 'running' } });
          if (block.type === 'tool_result') this.emit('tool', { tool: { id: block.tool_use_id, output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content), status: block.is_error ? 'failed' : 'completed' } });
        }
      }
      if (event.type === 'result') {
        if (event.is_error || event.subtype !== 'success') {
          this.finish(new Error(typeof event.result === 'string' && event.result.trim()
            ? event.result.slice(0, 1000) : 'Native discussion response did not complete'));
        } else {
          const text = Array.isArray(event.outputBlocks)
            ? event.outputBlocks.filter(block => block.type === 'text' && block.phase === 'final_answer').map(block => block.text).join('\n\n')
            : event.result;
          if (typeof text !== 'string' || !text.trim()) throw new Error(this.permissionBlockedText || 'Native discussion response has no public answer');
          this.finish(null, { text });
        }
      } else if (event.type === 'stream_event') {
        const item = event.event;
        if (!Number.isSafeInteger(item?.index)) return;
        if (item.type === 'content_block_start') {
          this.blocks.set(item.index, item.content_block?.type === 'text' ? String(item.content_block.text || '') : null);
        } else if (item.type === 'content_block_delta' && item.delta?.type === 'text_delta'
          && typeof item.delta.text === 'string' && typeof this.blocks.get(item.index) === 'string') {
          this.blocks.set(item.index, this.blocks.get(item.index) + item.delta.text);
        } else return;
        const text = [...this.blocks.values()].filter(value => typeof value === 'string').join('\n\n');
        if (text && this.emit('answer', { text }) !== true) throw new Error('Native discussion text was rejected');
      }
    } catch (error) {
      this.finish(error);
      void this.cancel();
    }
  }
  cancel() {
    if (this.cancelled) return;
    this.cancelled = true; this.finish(abortError());
    try { this.session?.interrupt(); } catch { /* shutdown and proof still required */ }
    // Proactively close the process so a lost result cannot wedge cancellation.
    // This promise is awaited by stop(); its resolution is NOT a stop proof.
    if (this.session && !this.shutdown) {
      this.shutdown = Promise.resolve().then(() => this.session.shutdown());
      this.shutdown.catch(() => {});
    }
  }
  stop() {
    if (this.stopped) return Promise.resolve(this.stopped);
    if (this.stopping) return this.stopping;
    if (!this.executionFinished) this.cancel();
    this.stopping = (async () => {
      // Also safe when called directly during preparation/open: wait until no
      // continuation can create a process after the stop proof was returned.
      try { await this.execution; } catch { /* failure still requires drain */ }
      return this.drain();
    })().finally(() => { this.stopping = null; });
    return this.stopping;
  }
  async drain() {
    this.closed = true;
    const { adapter, identity, session } = this;
    if (session) {
      if (!this.shutdown) this.shutdown = Promise.resolve().then(() => session.shutdown());
      try { await this.shutdown; } catch (error) { this.shutdown = null; throw error; }
    }
    if (this.preparing) {
      // Preparation itself may allocate a supervisor or isolated state. Even
      // a rejected binding or aborted prepare must drain those resources.
      // ensure() may throw after launching but before returning a pool entry.
      // A missing handle is not evidence that no native activity was created.
      const proof = await adapter.policy.confirmStopped({ session: session || null, identity });
      if (proof?.stopped !== true || proof.runtimeId !== identity.runtimeId
        || proof.deliveryId !== identity.deliveryId || proof.generation !== identity.generation) throw new Error('Native activity stop is not confirmed');
    }
    if (session) {
      // Never release a replacement owned by a different activity.
      const current = adapter.driver.sessions.get(this.opts);
      if (current && current !== session) throw new Error('Native pool ownership changed during stop');
      if (current) await adapter.driver.sessions.release(this.opts);
      if (adapter.driver.sessions.get(this.opts)) throw new Error('Native session was not released');
    }
    if (this.claimed && adapter.active.get(identity.runtimeId) === this) adapter.active.delete(identity.runtimeId);
    if (this.ownershipLease) { adapter.ownership.release(this.ownershipLease); this.ownershipLease = null; }
    revokeDiscussionLaunch(this.opts?.discussionLaunch);
    adapter.activities.delete(this);
    this.detachAbort?.();
    return (this.stopped = { runtimeId: identity.runtimeId, deliveryId: identity.deliveryId,
      generation: identity.generation, stopped: true, released: true });
  }
}

module.exports = { NativeDiscussionAdapter };
