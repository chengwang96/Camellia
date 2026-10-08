'use strict';

// Coalesce activity into one idle pass. Referenced old files require no timer;
// newly created files and retained backups get a wake-up at their age limit.
class AttachmentMaintenance {
  constructor({ cleanup, sweep = () => cleanup.sweepAttachments(), log = () => {}, delayMs = 30000, now = Date.now }) {
    Object.assign(this, { cleanup, sweep, log, delayMs, now });
    this.abort = new AbortController();
    cleanup.signal = cleanup.signal ? AbortSignal.any([cleanup.signal, this.abort.signal]) : this.abort.signal;
    this.version = 0; this.closed = false; this.running = null;
    this.markDirty();
  }
  schedule(delay) {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.run(); }, Math.max(1, Math.min(delay, 0x7fffffff)));
    this.timer.unref?.();
  }
  markDirty() {
    if (this.closed) return;
    this.version++;
    // A fresh change should bring forward a wake-up scheduled for file age.
    if (this.ageTimer) { clearTimeout(this.timer); this.timer = null; this.ageTimer = false; }
    this.schedule(this.delayMs);
  }
  async run() {
    if (this.closed || this.running) return;
    clearTimeout(this.timer); this.timer = null; this.ageTimer = false;
    const version = this.version;
    this.running = this.sweep();
    try {
      const result = await this.running;
      if (this.closed) return;
      if (result.files) this.log(`Reclaimed ${result.files} unused managed files (${result.bytes} bytes)`);
      for (const entry of result.errors || []) this.log('Storage maintenance: ' + entry.error);
      if (result.deferred || this.version !== version) this.schedule(this.delayMs);
      else if (result.nextSweepAt) { this.ageTimer = true; this.schedule(result.nextSweepAt - this.now()); }
    } catch (error) {
      if (!this.closed) {
        this.log('Storage maintenance deferred: ' + error.message);
        // Changed references get a new pass; a stable unreadable record waits
        // for another change or manual cleanup instead of rereading forever.
        if (this.version !== version) this.schedule(this.delayMs);
      }
    } finally { this.running = null; }
  }
  async close() {
    this.closed = true; clearTimeout(this.timer); this.timer = null;
    this.abort.abort();
    await this.running?.catch(() => {});
  }
}

module.exports = { AttachmentMaintenance };
