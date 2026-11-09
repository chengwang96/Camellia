'use strict';

// Read-only reconciliation belongs to a native process, independently of its
// visible reply. Object identity fences each read against newer live events.
class BackgroundTaskMonitor {
  constructor({ tasks, read, apply, publish, closed, log = () => {}, intervalMs = 30000, timeoutMs = 10000,
    setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { tasks, read, apply, publish, closed, log, intervalMs, timeoutMs, setTimer, clearTimer });
    this.timer = null;
    this.pending = null;
    this.stopped = false;
  }

  changed() {
    if (this.timer && (!this.tasks.size || this.closed() || this.stopped)) {
      this.clearTimer(this.timer); this.timer = null;
    }
    if (this.stopped || this.closed() || !this.tasks.size || this.timer || this.pending) return;
    this.timer = this.setTimer(() => { this.timer = null; void this.check(); }, this.intervalMs);
    this.timer?.unref?.();
  }

  check() {
    if (this.pending) return this.pending;
    if (this.stopped || this.closed() || !this.tasks.size) return Promise.resolve();
    this.clearTimer(this.timer); this.timer = null;
    const before = new Map(this.tasks), controller = new AbortController();
    this.controller = controller;
    const operation = Promise.resolve().then(async () => {
      if (this.stopped || this.closed() || controller.signal.aborted) return;
      let timer, cancel;
      try {
        const deadline = new Promise((_, reject) => {
          cancel = () => reject(new Error('Background task status could not be verified'));
          controller.signal.addEventListener('abort', cancel, { once: true });
          timer = this.setTimer(() => controller.abort(), this.timeoutMs);
          timer?.unref?.();
        });
        const rows = await Promise.race([this.read([...before.keys()], controller.signal), deadline]);
        if (!Array.isArray(rows) || rows.some(row => !row || typeof row.id !== 'string' || !row.id))
          throw new Error('Invalid native background task snapshot');
        const snapshot = new Map(rows.map(row => [row.id, row]));
        if (snapshot.size !== rows.length) throw new Error('Duplicate native background task identities');
        if (this.stopped || this.closed() || controller.signal.aborted) return;
        let changed = false;
        for (const [id, previous] of before) {
          if (this.tasks.get(id) !== previous) continue;
          this.apply(id, snapshot.get(id) || { id, status: 'unavailable' });
          changed = true;
        }
        if (changed) this.notify();
      } catch (error) {
        controller.abort();
        if (this.stopped || this.closed()) return;
        let changed = false;
        for (const [id, previous] of before) {
          if (this.tasks.get(id) !== previous || previous.status === 'unknown') continue;
          this.apply(id, { ...previous, status: 'unknown' }); changed = true;
        }
        if (changed) { this.log(error.message); this.notify(); }
      } finally {
        this.clearTimer(timer);
        controller.signal.removeEventListener('abort', cancel);
      }
    }).finally(() => {
      if (this.pending === operation) { this.pending = null; this.controller = null; }
      this.changed();
    });
    this.pending = operation;
    return operation;
  }

  stop() {
    this.stopped = true;
    this.clearTimer(this.timer); this.timer = null;
    this.controller?.abort();
  }

  notify() {
    try { this.publish(); }
    catch (error) { this.log('Background status publication failed: ' + error.message); }
  }
}

module.exports = { BackgroundTaskMonitor };
