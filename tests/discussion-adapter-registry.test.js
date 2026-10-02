'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { SessionPool } = require('../src/engines/session-pool');
const { DiscussionAdapterRegistry } = require('../src/engines/discussions/adapter-registry');
const { NativeSessionOwnership } = require('../src/engines/discussions/native-ownership');
const { evaluateCapability, bindingFingerprint } = require('../src/engines/discussions/capabilities');

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const ownership = new NativeSessionOwnership({ readOwners: () => [] }), registry = new DiscussionAdapterRegistry({ ownership });
  const binding = { engine: 'codex', model: 'fixture', connection: 'subscription', accountRef: 'test-account', thinking: '', contextWindow: 0 };
  const runtime = { version: 'fixture-runtime', policyVersion: 'fixture-policy' };
  // Synthetic declarations exercise registration; they are never installed in
  // an application registry and do not establish real execution enforcement.
  const evidence = { kind: 'real', reference: 'synthetic-test-only', bindingFingerprint: bindingFingerprint(binding),
    runtimeVersion: runtime.version, policyVersion: runtime.policyVersion, mode: 'tool-free',
    checks: Object.fromEntries(['isolatedSession', 'pinnedBinding', 'continuation', 'stopConfirmed', 'shellRestricted',
      'mcpRestricted', 'subagentsRestricted', 'escalationDisabled', 'conversationControlDisabled', 'toolsDisabled'].map(key => [key, true])) };
  const calls = [], events = [], state = { generation: 0, stopped: true, verifies: 0 };
  const policy = {
    async prepare({ profile }) { return { settings: { model: profile.model, connection: profile.connection,
      permissionMode: 'plan', thinkingBudget: profile.thinking, proxyUrl: '', contextWindow: profile.contextWindow,
      subscriptionId: profile.accountRef }, launch: { buildSpec() { throw new Error('No native fixture process'); },
        spawn() { throw new Error('No native fixture process'); } } }; },
    async verify() { state.verifies++; return true; },
    async confirmStopped({ identity }) { return { ...identity, stopped: state.stopped }; },
  };
  const sessions = new SessionPool();
  const driver = { sessions, ensure(opts) {
    const session = { opts, gen: ++state.generation, seq: 0, sends: 0, running: false,
      async open() { session.sessionId = opts.sessionId || randomUUID(); },
      sendUserMessage() { session.sends++; session.running = true; return true; },
      interrupt() { session.interrupts = (session.interrupts || 0) + 1; },
      async shutdown() { session.running = false; session.dead = true; },
      emit(event) { return registry.capture('codex', { conversationId: opts.conversationId, runId: session.gen,
        eventSeq: ++session.seq, session_id: session.sessionId, ...event }); },
      finish(text = 'Public answer') { return session.emit({ type: 'result', subtype: 'success', result: text }); },
    };
    calls.push(session); sessions.set(opts, session); return session;
  } };
  const registration = { engine: 'codex', driver, policy, runtime, bindings: [{ binding, evidence }] };
  const input = { discussionId: randomUUID(), threadId: randomUUID(), participantId: randomUUID(), deliveryId: randomUUID(),
    requestId: 'test', runtimeId: randomUUID(), generation: 1, bindingFingerprint: bindingFingerprint(binding),
    profile: binding, cwd: process.cwd(), nativeId: null };
  const start = (value = input) => {
    const handle = registry.get('codex').create(value);
    const done = handle.execute({ plan: { prompt: 'Saved prompt' }, signal: new AbortController().signal,
      onEvent: event => { events.push(event); return true; } });
    done.catch(() => {}); return { handle, done };
  };
  return { registry, ownership, registration, binding, evidence, runtime, policy, state, calls, events, input, start };
}

test('the registry starts disabled and copies exact binding, runtime and evidence snapshots', async () => {
  assert.throws(() => new DiscussionAdapterRegistry({}), /ownership registry/);
  const h = fixture();
  assert.equal(h.registry.get('codex'), null);
  assert.equal(h.registry.capture('codex', { conversationId: randomUUID() }), false);
  const adapter = h.registry.register(h.registration);
  h.runtime.version = 'changed'; h.evidence.checks.toolsDisabled = false;
  h.registration.bindings.length = 0; h.policy.verify = async () => false;
  assert.equal(evaluateCapability(h.binding, adapter.runtime, adapter.evidence(h.binding)).available, true);
  assert.throws(() => { adapter.evidence(h.binding).checks.toolsDisabled = false; }, TypeError);
  assert.equal(adapter.evidence({ ...h.binding, accountRef: 'different-account' }), null);
  assert.equal(adapter.evidence({ ...h.binding, thinking: 'different-effort' }), null);
  const run = h.start(); await tick();
  assert.equal(h.state.verifies, 1); h.calls[0].finish(); await run.done; await run.handle.stop();
});

test('registration rejects incomplete, mismatched or duplicate proof and never enables an empty bundle', () => {
  for (const change of [
    h => { h.evidence.kind = 'mock'; }, h => { h.evidence.runtimeVersion = 'stale'; },
    h => { h.evidence.policyVersion = 'stale'; }, h => { h.evidence.checks.mcpRestricted = false; },
    h => { h.registration.engine = 'antigravity'; }, h => { h.binding.model = 'changed'; },
    h => { h.registration.bindings.push(h.registration.bindings[0]); },
  ]) {
    const h = fixture(); change(h);
    assert.throws(() => h.registry.register(h.registration), /Unverified|Duplicate/);
    assert.equal(h.registry.entries.size, 0);
  }
  const h = fixture();
  assert.throws(() => h.registry.register({ ...h.registration, policy: {} }), /Invalid/);
  assert.throws(() => h.registry.register({ ...h.registration, engine: '__proto__', bindings: [] }), /Invalid/);
  const adapter = h.registry.register({ ...h.registration, bindings: [] });
  assert.equal(adapter.evidence(h.binding), null);
  assert.throws(() => h.registry.register(h.registration), /already registered/);
  assert.throws(() => h.registry.unregister('codex'), /Revoke/);
});

test('revocation cancels preparation and registration cannot be replaced before that activity drains', async () => {
  const h = fixture(), pending = deferred(), prepared = await h.policy.prepare({ profile: h.binding });
  h.policy.prepare = () => pending.promise;
  h.registry.register(h.registration);
  const run = h.start(); h.registry.revoke('codex');
  assert.equal(h.registry.get('codex').evidence(h.binding), null);
  assert.throws(() => h.registry.unregister('codex'), /stop confirmation/);
  pending.resolve(prepared); await assert.rejects(run.done, /cancelled/);
  assert.throws(() => h.registry.unregister('codex'), /stop confirmation/);
  await run.handle.stop(); h.registry.unregister('codex');
  assert.equal(h.calls.length, 0); assert.equal(h.ownership.active.size, 0);
  assert.equal(h.registry.get('codex'), null);
});

test('unconfirmed stop retains revoked adapters and late events are consumed after unregistering', async () => {
  const h = fixture(); h.registry.register(h.registration);
  const run = h.start(); await tick(); const session = h.calls[0];
  session.finish(); await run.done;
  h.state.stopped = false; h.registry.revoke('codex');
  await assert.rejects(run.handle.stop(), /not confirmed/);
  assert.throws(() => h.registry.unregister('codex'), /stop confirmation/);
  h.state.stopped = true; await run.handle.stop(); h.registry.unregister('codex');
  const count = h.events.length;
  assert.equal(session.finish('Stale'), true); assert.equal(h.events.length, count);
});

test('a replacement adapter can resume its own history without consuming old output as a new answer', async () => {
  const h = fixture(); h.registry.register(h.registration);
  const first = h.start(); await tick(); const old = h.calls[0];
  old.finish('One'); await first.done; await first.handle.stop();
  h.registry.revoke('codex'); h.registry.unregister('codex'); h.registry.register(h.registration);
  const second = h.start({ ...h.input, deliveryId: randomUUID(), requestId: 'next', nativeId: old.sessionId });
  await tick(); const current = h.calls[1], count = h.events.length;
  assert.ok(current.gen > old.gen); assert.equal(current.sends, 1);
  assert.equal(old.finish('Old answer'), true); assert.equal(h.events.length, count);
  current.finish('Two'); assert.deepEqual(await second.done, { text: 'Two' }); await second.handle.stop();
});

test('a driver generation reset across registrations requires a new member generation before sending', async () => {
  const h = fixture(); h.registry.register(h.registration);
  const first = h.start(); await tick(); h.calls[0].finish(); await first.done; await first.handle.stop();
  h.registry.revoke('codex'); h.registry.unregister('codex'); h.state.generation = 0;
  h.registry.register(h.registration);
  const next = h.start({ ...h.input, deliveryId: randomUUID(), nativeId: h.calls[0].sessionId });
  await assert.rejects(next.done, /generation was reused/);
  assert.equal(h.calls[1].sends, 0); await next.handle.stop();
});
