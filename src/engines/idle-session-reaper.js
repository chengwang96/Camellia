'use strict';

const { performance } = require('node:perf_hooks');

// Stop idle native processes while preserving transcripts and native contexts.
// Activity is recorded by the pool at creation and by shared task lifecycle
// events. Merely looking up a session never extends its retention window.
class IdleSessionReaper {
  constructor(pools, { timeoutMs = 30 * 60 * 1000, intervalMs = 60 * 1000, now = () => performance.now(),
    isBlocked = () => false, onRelease = () => {}, log = () => {} } = {}) {
    Object.assign(this, { pools, timeoutMs, intervalMs, now, isBlocked, onRelease, log });
    this.observed = new Map();
    this.sweeping = null;
    this.timer = null;
  }
  isReapable(pool, id) {
    const session = pool.get({ conversationId: id });
    // Discussion processes are released only by their independently verified
    // owner. Ordinary idle maintenance must not attempt to close these handles.
    if (!session || id === 'legacy' || session.opts?.discussionLaunch) return false;
    const activity = pool.activity.get(session);
    let record = this.observed.get(session);
    if (!record) {
      record = { activity, at: activity?.at ?? this.now(), busy: false };
      this.observed.set(session, record);
    }
    const changed = record.activity !== activity;
    if (changed) { record.activity = activity; record.at = activity.at; }
    if (session.running || this.isBlocked(id)) { record.busy = true; return false; }
    // A busy-to-idle transition without a lifecycle notification still earns a
    // full idle window. Notified completions retain their precise event time.
    if (record.busy && !changed) record.at = this.now();
    record.busy = false;
    return this.now() - record.at >= this.timeout();
  }
  timeout() { return typeof this.timeoutMs === 'function' ? this.timeoutMs() : this.timeoutMs; }
  sweep() {
    if (!this.sweeping) this.sweeping = this.sweepSessions().finally(() => { this.sweeping = null; });
    return this.sweeping;
  }
  async sweepSessions() {
    const released = new Set();
    try {
      for (const pool of this.pools) {
        for (const id of [...pool.sessions.keys()]) {
          if (!this.isReapable(pool, id)) continue;
          const session = pool.get({ conversationId: id });
          try {
            const stopped = await pool.release({ conversationId: id }, {
              expected: session, canRelease: () => this.isReapable(pool, id),
            });
            if (stopped) { released.add(id); this.observed.delete(session); }
          } catch (error) {
            const record = this.observed.get(session);
            if (record) record.at = this.now();
            this.log(`Idle session ${id} was not released: ${error.message}`);
          }
        }
      }
    } finally {
      const retained = new Set(this.pools.flatMap(pool => [...pool.sessions.values()]));
      for (const session of this.observed.keys()) if (!retained.has(session)) this.observed.delete(session);
    }
    const ids = [...released];
    if (ids.length) { try { this.onRelease(ids); } catch (error) { this.log('Idle release notification failed: ' + error.message); } }
    return ids;
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sweep().catch(error => this.log('Idle session sweep failed: ' + error.message)); }, this.intervalMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } this.observed.clear(); }
}

module.exports = { IdleSessionReaper };
