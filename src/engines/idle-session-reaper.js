'use strict';

// Idle native sessions each own a live engine process (a Codex app-server, a
// Claude CLI, a Kimi CLI, ...). Conversations are only released when they are
// deleted, so a long-running window accumulates one backend per conversation and
// never gives the memory back. This reaper stops *only* the native process of
// conversations that have been idle for a while; the transcript is untouched and
// the engine restarts from stored history on the next message.
class IdleSessionReaper {
  constructor(pools, { timeoutMs = 30 * 60 * 1000, intervalMs = 60 * 1000, now = Date.now,
    isBlocked = () => false, onRelease = () => {}, log = () => {} } = {}) {
    Object.assign(this, { pools, timeoutMs, intervalMs, now, isBlocked, onRelease, log });
    this.lastActive = new Map();
    this.releasing = new Set();
    this.timer = null;
  }
  // A pool counts a conversation as active while it holds a session reference,
  // which is exactly what `active` reports. Running or otherwise busy work is
  // protected by `isBlocked` and by `release` itself, which refuses to stop a
  // running session.
  active(id) {
    for (const pool of this.pools) if (pool.get({ conversationId: id })) return true;
    return false;
  }
  isReapable(id) {
    if (!id || this.releasing.has(id)) return false;
    const stamp = this.lastActive.get(id);
    if (stamp === undefined) { this.lastActive.set(id, this.now()); return false; }
    if (this.now() - stamp < this.timeout()) return false;
    if (this.isBlocked(id)) return false;
    return this.active(id);
  }
  timeout() { return typeof this.timeoutMs === 'function' ? this.timeoutMs() : this.timeoutMs; }
  async sweep() {
    const released = [];
    for (const pool of this.pools) {
      for (const id of [...pool.sessions.keys()]) {
        if (id === 'legacy' || !this.isReapable(id)) continue;
        this.releasing.add(id);
        const session = pool.get({ conversationId: id });
        try {
          await pool.release({ conversationId: id });
          released.push(id);
          this.lastActive.set(id, this.now());
        } catch (error) {
          // Running work, a failed teardown or a session that replaced itself
          // while releasing is left alone and retried on the next sweep.
          if (!session || !session.dead) this.lastActive.set(id, this.now());
          this.log(`Idle session ${id} was not released: ${error.message}`);
        } finally { this.releasing.delete(id); }
      }
    }
    if (released.length) { try { this.onRelease(released); } catch (error) { this.log('Idle release notification failed: ' + error.message); } }
    return released;
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sweep().catch(error => this.log('Idle session sweep failed: ' + error.message)); }, this.intervalMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}

module.exports = { IdleSessionReaper };
