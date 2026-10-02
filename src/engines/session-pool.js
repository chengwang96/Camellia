'use strict';

const { validSessionId } = require('./claude-history');

// A native process belongs to one logical conversation. The legacy slot is
// retained for native-only IPC; shared conversations never replace that slot.
class SessionPool {
  constructor() { this.sessions = new Map(); }
  setAccessGuard(guard) {
    if (this.accessGuard || typeof guard !== 'function') throw new Error('Session access guard is already set or invalid');
    this.accessGuard = guard;
  }
  assertAccess(opts = {}) {
    const result = this.accessGuard?.(opts);
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).catch(() => {});
      throw new Error('Session access guard must be synchronous');
    }
    if (result === false) throw new Error('Session access denied');
  }
  key(opts = {}) {
    if (!opts.conversationId) return 'legacy';
    if (!validSessionId(opts.conversationId)) throw new Error('Invalid conversation');
    return opts.conversationId;
  }
  get(opts) { return this.sessions.get(this.key(opts)) || null; }
  set(opts, session) {
    const key = this.key(opts);
    if (session) this.assertAccess(opts);
    const current = this.sessions.get(key);
    if (current?.opts?.discussionLaunch && current !== session && current.opts.discussionLaunch !== opts?.discussionLaunch) {
      throw new Error('Discussion resources must be replaced by their owner');
    }
    if (session) this.sessions.set(key, session); else this.sessions.delete(key);
  }
  get legacy() { return this.get(); }
  set legacy(session) { this.set({}, session); }
  get active() { return [...this.sessions.values()].some(session => !session.dead); }
  get running() { return [...this.sessions.values()].some(session => session.running); }
  async release(opts) {
    const key = this.key(opts), session = this.sessions.get(key);
    if (!session) return;
    if (session.opts?.discussionLaunch && session.opts.discussionLaunch !== opts?.discussionLaunch) {
      throw new Error('Discussion resources must be released by their owner');
    }
    if (session.running) throw new Error('Stop the response before releasing this conversation');
    if (session.shutdown) await session.shutdown(); else await session.kill();
    if (this.sessions.get(key) === session) this.sessions.delete(key);
  }
  async shutdown() {
    const sessions = [...this.sessions.values()];
    // Global shutdown may request termination, but cannot discard a discussion
    // owner's handle before its independent stop verifier releases the slot.
    // Retention also keeps ordinary/idle cleanup paths from reusing that slot.
    for (const [key, session] of this.sessions) if (!session.opts?.discussionLaunch) this.sessions.delete(key);
    await Promise.allSettled(sessions.map(async session => {
      if (session.shutdown) await session.shutdown(); else session.kill();
    }));
  }
}

module.exports = { SessionPool };
