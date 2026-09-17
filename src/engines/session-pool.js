'use strict';

const { validSessionId } = require('./claude-history');

// A native process belongs to one logical conversation. The legacy slot is
// retained for native-only IPC; shared conversations never replace that slot.
class SessionPool {
  constructor() { this.sessions = new Map(); }
  key(opts = {}) {
    if (!opts.conversationId) return 'legacy';
    if (!validSessionId(opts.conversationId)) throw new Error('Invalid conversation');
    return opts.conversationId;
  }
  get(opts) { return this.sessions.get(this.key(opts)) || null; }
  set(opts, session) {
    const key = this.key(opts);
    if (session) this.sessions.set(key, session); else this.sessions.delete(key);
  }
  get legacy() { return this.get(); }
  set legacy(session) { this.set({}, session); }
  get active() { return [...this.sessions.values()].some(session => !session.dead); }
  get running() { return [...this.sessions.values()].some(session => session.running); }
  async shutdown() {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map(async session => {
      if (session.shutdown) await session.shutdown(); else session.kill();
    }));
  }
}

module.exports = { SessionPool };
