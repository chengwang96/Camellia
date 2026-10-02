'use strict';

const { evaluateCapability, bindingFingerprint } = require('./capabilities');
const { NativeDiscussionAdapter } = require('./native-adapter');
const { NativeSessionOwnership } = require('./native-ownership');

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

// Constructed and populated by reviewed main-process code only. Evidence is a
// copied bundle tied to exact bindings and runtime/policy versions, never a
// renderer setting or a live callback supplied by a participant. Empty by
// default. Production bindings are admitted only after online verification.
class DiscussionAdapterRegistry {
  constructor({ ownership }) {
    if (!(ownership instanceof NativeSessionOwnership)) throw new Error('Shared native ownership registry is required');
    this.ownership = ownership; this.entries = new Map(); this.retired = [];
  }
  register({ engine, driver, runtime, policy, bindings = [] }) {
    if (this.entries.has(engine)) throw new Error('Discussion adapter is already registered');
    if (!['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi'].includes(engine)
      || !driver?.sessions || typeof driver.ensure !== 'function'
      || !['prepare', 'verify', 'confirmStopped'].every(key => typeof policy?.[key] === 'function')
      || !runtime?.version || !runtime.policyVersion || !Array.isArray(bindings)) throw new Error('Invalid discussion adapter registration');
    const version = freeze(structuredClone(runtime)), evidence = new Map();
    for (const row of bindings) {
      const copy = freeze(structuredClone(row));
      if (copy?.binding?.engine !== engine || !evaluateCapability(copy.binding, version, copy.evidence).available) {
        throw new Error('Unverified discussion adapter binding');
      }
      const fingerprint = bindingFingerprint(copy.binding);
      if (evidence.has(fingerprint)) throw new Error('Duplicate discussion adapter binding');
      evidence.set(fingerprint, copy.evidence);
    }
    // Preserve policy functions and their receiver in a private, immutable
    // registration snapshot. Mutating a caller's bundle cannot silently replace
    // the enforcement or stop verifier of an already admitted activity.
    const enforcement = Object.freeze(Object.fromEntries(['prepare', 'verify', 'confirmStopped']
      .map(key => [key, policy[key].bind(policy)])));
    const entry = { enabled: true, adapter: null, evidence, runtime: version };
    entry.adapter = new NativeDiscussionAdapter({ engine, driver, runtime: version, policy: enforcement,
      ownership: this.ownership, evidence: binding => entry.enabled ? evidence.get(bindingFingerprint(binding)) || null : null });
    this.entries.set(engine, entry);
    return entry.adapter;
  }
  get(engine) { return this.entries.get(engine)?.adapter || null; }
  // Main-process online verification supplies this result; it is never accepted
  // from IPC or a saved participant's permission flags.
  admit(binding, evidence) {
    const entry = this.entries.get(binding.engine);
    if (!entry?.enabled || !evaluateCapability(binding, entry.runtime, evidence).available) throw new Error('Invalid discussion verification result');
    entry.evidence.set(bindingFingerprint(binding), freeze(structuredClone(evidence)));
  }
  revoke(engine) {
    const entry = this.entries.get(engine);
    if (!entry) return;
    entry.enabled = false;
    // Includes policy preparation/opening, not only sessions already in pools.
    // Cancellation is a request; unregister still requires successful drain.
    for (const activity of entry.adapter.activities) activity.cancel();
  }
  unregister(engine) {
    const entry = this.entries.get(engine);
    if (!entry) return;
    if (entry.enabled) throw new Error('Revoke the discussion adapter before unregistering');
    if (entry.adapter.activities.size) throw new Error('Discussion adapter still requires stop confirmation');
    this.entries.delete(engine); this.retired.push(entry.adapter);
  }
  capture(engine, event) {
    // Prefer the current owner when a member resumes after re-registration.
    // Shared ownership retains process generations across adapter lifetimes,
    // so a reused runId is refused before dispatch. Retired adapters only consume
    // events whose runtime is not claimed by the current adapter.
    for (const adapter of [...[...this.entries.values()].map(entry => entry.adapter), ...this.retired]) {
      if (adapter.capture(engine, event)) return true;
    }
    return false;
  }
}

module.exports = { DiscussionAdapterRegistry };
