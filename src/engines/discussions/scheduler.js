'use strict';

const { evaluateCapability } = require('./capabilities');
const { validateReply } = require('./schema');
const OPEN = new Set(['queued', 'preparing', 'running', 'stopping']);
const matchesScope = (profile, scope) => Object.entries(scope).every(([key, value]) => profile?.[key] === value);

// Main-process dependencies only. An adapter's create() is synchronous and
// side-effect free; execute() owns preparation, inference and child activities.
// stop() must drain ALL of them and return matching stopped/released proof.
// No native adapters are registered by default. In particular interrupt() or
// a result event alone is not proof of termination.
class DiscussionScheduler {
  constructor({ manager, adapters = {}, registry = null, prepareInput, onEvent = () => {}, onError = () => {} }) {
    if (registry && Object.keys(adapters).length) throw new Error('Choose the discussion registry or injected test adapters');
    this.manager = manager; this.adapters = adapters; this.registry = registry; this.prepareInput = prepareInput;
    this.onEvent = onEvent; this.onError = onError; this.runs = new Map();
    this.suspensions = new Map();
  }
  publish(run, type, extra = {}) {
    try { Promise.resolve(this.onEvent({ ...extra, ...run.identity, type })).catch(error => this.report(error)); }
    catch (error) { this.report(error); }
  }
  report(error) {
    try { Promise.resolve(this.onError(error)).catch(() => {}); }
    catch { /* observers cannot change lifecycle */ }
  }
  enqueue(id, input) {
    const state = this.manager.get(id);
    if (!state.requests.some(request => request.id === input.requestId)) {
      for (const participantId of input.participantIds || []) {
        const participant = state.participants.find(p => p.id === participantId);
        if (this.suspended(participant)) throw new Error('Discussion connection is suspended');
      }
    }
    const request = this.manager.enqueue(id, input);
    this.pump(id); return request;
  }
  pump(id) {
    let state;
    try { state = this.manager.get(id); } catch (error) { this.report(error); return; }
    if (state.stopPending || this.manager.isStopping(id)) return;
    for (const d of state.deliveries) {
      if (d.status !== 'queued') continue;
      try { this.admit(id, d); } catch (error) { this.report(error); }
    }
  }
  admit(id, d) {
    const current = this.manager.get(id);
    if (current.deliveries.find(other => other.id === d.id)?.status !== 'queued') return;
    if (current.stopPending || this.manager.isStopping(id)) return;
    // A terminal disk record alone is not sufficient when the commit call
    // failed or a retained activity still needs recovery in this process.
    if (this.hasRuns(id, d.participantId)) return;
    if (current.deliveries.some(other => other.participantId === d.participantId
      && ['preparing', 'running', 'stopping'].includes(other.status))) return;
    if (current.deliveries.slice(0, current.deliveries.findIndex(other => other.id === d.id))
      .some(other => other.participantId === d.participantId && other.status === 'queued')) return;
    const request = current.requests.find(r => r.id === d.requestId);
    if (request.mode === 'serial' && request.deliveryIds.slice(0, request.deliveryIds.indexOf(d.id))
      .some(key => {
        const prior = current.deliveries.find(other => other.id === key);
        return this.runs.has(key) || prior.status !== 'completed' && !prior.serialResolution;
      })) return;
    const participant = current.participants.find(p => p.id === d.participantId);
    if (this.suspended(participant)) return;
    if (participant.removed || participant.removalPending || participant.retiredSessions.some(s => s.recoveryRequired)) return;
    this.manager.checkAdmission(id, participant.id, d.id);
    const adapter = this.registry ? this.registry.get(participant.engine) : this.adapters[participant.engine];
    let capability;
    try { capability = evaluateCapability(participant, adapter?.runtime, adapter?.evidence?.(participant)); }
    catch (error) { this.report(error); capability = { available: false, reason: 'capability-check-failed' }; }
    const reject = reason => {
      this.manager.rejectQueued(id, d.id, reason);
      this.publish({ identity: { discussionId: id, threadId: current.threadId, participantId: d.participantId,
        requestId: d.requestId, deliveryId: d.id } }, 'failed', { reason });
    };
    if (!capability.available) { reject(capability.reason); return; }
    // A native tool run may write or invoke a command. Keep one owner of this
    // group's directory until its entire process tree has drained.
    if ([...this.runs.values()].some(run => run.identity.discussionId === id
      && (capability.mode === 'native-tools' || run.capability.mode === 'native-tools'))) return;
    let delivery;
    try { delivery = this.manager.prepare(id, d.id, capability.mode); }
    catch (error) {
      if (error.code !== 'DISCUSSION_CAPACITY') throw error;
      reject('discussion-capacity-exceeded'); this.report(error); return;
    }
    const identity = Object.freeze({ discussionId: id, threadId: current.threadId,
      participantId: d.participantId, requestId: d.requestId, deliveryId: d.id,
      generation: delivery.generation, runtimeId: delivery.runtimeId,
      bindingFingerprint: delivery.bindingFingerprint });
    const run = { identity, delivery, adapter, capability, abort: new AbortController(), cancelled: false };
    this.runs.set(d.id, run);
    this.publish(run, 'phase', { phase: 'context' });
    // Defer execution until run.done exists, including synchronous callbacks.
    run.done = Promise.resolve().then(() => this.execute(run)).catch(error => this.report(error));
  }
  current(run) {
    return this.runs.get(run.delivery.id) === run && !run.cancelled && !run.eventsClosed;
  }
  event(run, event) {
    if (!this.current(run) || !event || Object.entries(run.identity).some(([key, value]) => event[key] !== value)) return false;
    const { discussionId: id, deliveryId, generation } = run.identity;
    try {
      if (event.type === 'started') this.manager.start(id, deliveryId, generation, event.nativeId, event.nativeStorage);
      else if (event.type === 'answer') this.manager.partial(id, deliveryId, generation, event.text);
      else if (event.type === 'phase') this.manager.activity(id, deliveryId, generation, event.phase);
      else if (event.type === 'tool') this.manager.tool(id, deliveryId, generation, event.tool);
      else if (event.type === 'permission') {
        (run.permissions ||= new Map()).set(event.permission.requestId, event.permission);
        this.manager.activity(id, deliveryId, generation, 'approval');
      }
      else return false; // Never forward private reasoning, tools or raw metadata.
    } catch (error) {
      // Drivers may swallow callback exceptions. Latch the failure and abort
      // here so a later success event cannot hide a lost durable transition.
      run.eventFailure ||= error;
      this.interrupt(run); return false;
    }
    this.publish(run, event.type, event.type === 'answer' ? { text: event.text }
      : event.type === 'phase' ? { phase: event.phase } : {});
    return true;
  }
  permissions(id) {
    return [...this.runs.values()].filter(run => run.identity.discussionId === id && this.current(run))
      .flatMap(run => [...(run.permissions?.values() || [])].map(permission => ({ ...permission, deliveryId: run.identity.deliveryId, participantId: run.identity.participantId })));
  }
  answerPermission(id, { deliveryId, runId, requestId, allow, input, optionId }) {
    const run = this.runs.get(deliveryId), pending = run?.permissions?.get(requestId);
    if (!run || run.identity.discussionId !== id || !this.current(run) || !pending || pending.runId !== runId)
      throw new Error('This request is no longer active');
    if (typeof allow !== 'boolean' || input != null && (typeof input !== 'object' || JSON.stringify(input).length > 64000)) throw new Error('Invalid permission answer');
    if (!run.handle.respond({ requestId, runId, allow, input, optionId })) throw new Error('This request is no longer active');
    run.permissions.delete(requestId);
    this.manager.activity(id, deliveryId, run.identity.generation, run.permissions.size ? 'approval' : 'answer');
    this.publish(run, 'changed');
  }
  async execute(run) {
    const { discussionId: id, deliveryId, generation } = run.identity;
    let result, failure;
    try {
      if (!run.cancelled) {
        if (typeof this.prepareInput !== 'function') throw new Error('Discussion context planner is unavailable');
        // Planner is pure/cancellable here. Model-backed summary activities must
        // supply their own drained lifecycle before this interface is extended.
        const plan = await this.prepareInput(this.manager.get(id), run.delivery, run.abort.signal, run.capability);
        if (!run.cancelled) {
          const savedPlan = this.manager.saveInput(id, deliveryId, generation, plan);
          // Recheck after asynchronous planning; never trust a stored flag.
          const gate = evaluateCapability(run.delivery.profile, run.adapter.runtime,
            run.adapter.evidence?.(run.delivery.profile));
          if (!gate.available) throw new Error('Discussion capability changed: ' + gate.reason);
          const state = this.manager.get(id);
          const session = state.participants.find(p => p.id === run.identity.participantId).session;
          run.handle = run.adapter.create({ ...run.identity, profile: structuredClone(run.delivery.profile),
            nativeId: session.nativeId, nativeStorage: session.nativeStorage, cwd: state.cwd, capability: gate, permissionMode: run.delivery.permissionMode || 'ask' });
          result = await run.handle.execute({ plan: savedPlan, signal: run.abort.signal,
            onEvent: event => this.event(run, event) });
        }
      }
    } catch (error) { failure = error; }
    run.eventsClosed = true;
    run.failure = run.eventFailure || failure;
    if (!run.cancelled && !run.failure && (typeof result?.text !== 'string' || !result.text.trim())) {
      run.failure = new Error('Discussion response has no public answer');
    }
    if (!run.cancelled && !run.failure) {
      // Reject an oversized answer before freezing a successful settlement;
      // otherwise no retry could ever persist that immutable outcome.
      try { validateReply(result.text); } catch (error) { run.failure = error; }
    }
    // Freeze once. A stop/drain/commit retry must never rewrite success as a
    // cancellation, even when saving this intent itself fails on disk.
    run.outcome = Object.freeze(run.cancelled ? { status: 'cancelled' }
      : run.failure ? { status: 'failed' } : { status: 'completed', text: result.text });
    try { await this.settle(run); }
    finally { run.finished = true; }
  }
  interrupt(run) {
    run.eventsClosed = true;
    run.abort.abort();
    if (run.cancelRequested) return;
    run.cancelRequested = true;
    // Request promptly, but do not wait on cancel() as a substitute for drain.
    try { Promise.resolve(run.handle?.cancel?.()).catch(error => this.report(error)); }
    catch (error) { this.report(error); }
  }
  cancel(run) {
    if (!run.outcome) run.cancelled = true;
    this.interrupt(run);
  }
  async settle(run) {
    const { discussionId: id, deliveryId, generation } = run.identity;
    // Even a successful result must be drained before the member is released.
    // Failure to stop leaves the durable slot occupied, for explicit recovery.
    try {
      let writeError;
      try { this.manager.recordSettlement(id, deliveryId, generation, run.outcome); }
      catch (error) { writeError = error; }
      // A failure to save intent must not prevent native termination either.
      try {
        if (!run.proof) {
          const proof = run.handle ? await run.handle.stop() : { ...run.identity, stopped: true, released: true };
          if (proof?.stopped !== true || proof.released !== true || proof.runtimeId !== run.identity.runtimeId
            || proof.deliveryId !== deliveryId || proof.generation !== generation) throw new Error('Stop and resource release are not confirmed');
          run.proof = Object.freeze({ runtimeId: proof.runtimeId, deliveryId, generation, stopped: true, released: true });
        }
      } catch (error) { if (writeError) this.report(writeError); throw error; }
      if (writeError) throw writeError;
      if (run.outcome.status === 'completed') this.manager.complete(id, deliveryId, generation, run.outcome.text, run.proof);
      else this.manager.fail(id, deliveryId, generation, run.outcome.status, run.proof, run.failure?.message);
      this.runs.delete(deliveryId);
      this.publish(run, run.outcome.status, run.failure ? { reason: run.failure.message } : {});
      if (run.failure) this.report(run.failure);
    } catch (error) {
      this.interrupt(run);
      // A failed disk write must not also lose the in-memory recovery handle.
      try { this.manager.stop(id, deliveryId); } catch (writeError) { this.report(writeError); }
      this.publish(run, 'stopping'); this.report(error); return;
    }
    // A later scheduling error must not relabel an already committed result.
    try {
      const state = this.manager.get(id);
      if ((state.stopPending || this.manager.isStopping(id)) && !this.hasRuns(id) && !state.deliveries.some(d => OPEN.has(d.status))
        && !state.participants.some(p => p.retiredSessions.some(s => s.recoveryRequired))) this.manager.finishStopAll(id);
      this.pump(id);
    } catch (error) { this.report(error); }
  }
  async stop(id, deliveryId) {
    const run = this.runs.get(deliveryId);
    if (run && run.identity.discussionId !== id) throw new Error('Discussion activity mismatch');
    // Abort from the known handle before any storage access can throw.
    if (run) { this.cancel(run); this.publish(run, 'stopping'); }
    let delivery, writeError;
    try { delivery = this.manager.stop(id, deliveryId); }
    catch (error) { writeError = error; this.report(error); }
    if (!run) {
      if (writeError) throw writeError;
      if (delivery.status === 'stopping') throw new Error('Activity requires recovery');
      return delivery;
    }
    if (run.finished) {
      run.finished = false;
      run.done = this.settle(run).finally(() => { run.finished = true; });
    }
    await run.done;
    if (writeError && this.runs.get(deliveryId) === run) throw writeError;
    return this.manager.get(id).deliveries.find(d => d.id === deliveryId);
  }
  hasRuns(id, participantId = null) {
    return [...this.runs.values()].some(run => run.identity.discussionId === id
      && (!participantId || run.identity.participantId === participantId));
  }
  suspended(profile) {
    return [...this.suspensions.values()].some(entry => matchesScope(profile, entry.scope));
  }
  suspend({ scope = {}, reason }) {
    if (!['account-change', 'network-change', 'runtime-change', 'app-exit'].includes(reason)
      || !scope || typeof scope !== 'object' || Array.isArray(scope)
      || Object.keys(scope).some(key => !['engine', 'connection', 'accountRef'].includes(key))
      || Object.hasOwn(scope, 'engine') && !['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi'].includes(scope.engine)
      || Object.hasOwn(scope, 'connection') && !['api', 'subscription'].includes(scope.connection)
      || Object.hasOwn(scope, 'accountRef') && (!scope.engine || typeof scope.accountRef !== 'string' || !scope.accountRef.trim())
      || reason === 'app-exit' && Object.keys(scope).length) throw new Error('Invalid discussion lifecycle suspension');
    const token = Object.freeze({});
    this.suspensions.set(token, { scope: Object.freeze({ ...scope }), reason, drained: false });
    // Install the fence before storage access or an await. A failed inventory
    // read must never prevent cancellation of a known activity.
    for (const run of this.runs.values()) if (matchesScope(run.delivery.profile, scope)) this.cancel(run);
    return token;
  }
  suspension(token) {
    const entry = this.suspensions.get(token);
    if (!entry) throw new Error('Unknown discussion lifecycle suspension');
    return entry;
  }
  suspensionStatus(entry) {
    if ([...this.runs.values()].some(run => matchesScope(run.delivery.profile, entry.scope))) return false;
    return !this.manager.list().some(state => state.deliveries.some(delivery => OPEN.has(delivery.status)
      && matchesScope(delivery.profile || state.participants.find(p => p.id === delivery.participantId), entry.scope))
      || state.participants.some(participant => participant.retiredSessions.some(session => session.recoveryRequired
        && matchesScope(session.profile, entry.scope))));
  }
  async drainSuspension(token) {
    const entry = this.suspension(token), targets = new Map(), errors = [];
    entry.drained = false;
    for (const run of this.runs.values()) {
      if (!matchesScope(run.delivery.profile, entry.scope)) continue;
      this.cancel(run); targets.set(run.identity.deliveryId, run.identity.discussionId);
    }
    try {
      for (const state of this.manager.list()) for (const delivery of state.deliveries) {
        if (OPEN.has(delivery.status) && matchesScope(delivery.profile
          || state.participants.find(p => p.id === delivery.participantId), entry.scope)) targets.set(delivery.id, state.id);
      }
    } catch (error) { errors.push(error); this.report(error); }
    const results = await Promise.allSettled([...targets].map(([deliveryId, id]) => this.stop(id, deliveryId)));
    for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
    try { entry.drained = this.suspensionStatus(entry) && errors.length === 0; }
    catch (error) { errors.push(error); this.report(error); }
    return { stopped: entry.drained, reason: entry.reason, errors };
  }
  resume(token) {
    const entry = this.suspension(token);
    if (entry.reason === 'app-exit') throw new Error('Discussion shutdown cannot be resumed');
    if (!entry.drained || !this.suspensionStatus(entry)) throw new Error('Discussion lifecycle stop is not confirmed');
    this.suspensions.delete(token);
    // Queued requests were cancelled by drain; resuming a connection does not
    // recreate them, replay input or silently call a model.
  }
  async stopAll(id, participantId = null) {
    // Install the admission fence before yielding. Abort all known runs even
    // if either persisting intent or reading queued deliveries fails.
    let storageError;
    if (!participantId) {
      try { this.manager.beginStopAll(id); } catch (error) { storageError = error; this.report(error); }
    }
    const ids = new Set();
    for (const run of this.runs.values()) {
      if (run.identity.discussionId !== id || participantId && run.identity.participantId !== participantId) continue;
      ids.add(run.identity.deliveryId); this.cancel(run);
    }
    try {
      for (const d of this.manager.get(id).deliveries) {
        if ((!participantId || d.participantId === participantId) && OPEN.has(d.status)) ids.add(d.id);
      }
    } catch (error) { storageError ||= error; this.report(error); }
    const results = await Promise.allSettled([...ids].map(key => this.stop(id, key)));
    if (!participantId && !this.hasRuns(id) && !this.manager.get(id).deliveries.some(d => OPEN.has(d.status))) {
      this.manager.finishStopAll(id);
    }
    if (storageError) results.push({ status: 'rejected', reason: storageError });
    return results;
  }
  async removeMember(id, participantId) {
    try { this.manager.beginRemoval(id, participantId); } catch (error) { this.report(error); }
    await this.stopAll(id, participantId);
    if (this.hasRuns(id, participantId)) throw new Error('Stop member before removal');
    return this.manager.removeMember(id, participantId);
  }
  resolveSerial(id, deliveryId, action, actionId) {
    const result = this.manager.resolveSerial(id, deliveryId, action, actionId);
    this.pump(id); return result;
  }
}

module.exports = { DiscussionScheduler };
