'use strict';

const { randomUUID } = require('node:crypto');
const { readJson, writeJson } = require('../../shared/json-store');
const { fail } = require('./access');

// Accepted messages belong to the computer, not a phone connection or a
// renderer. Reserve the conversation before preparing a turn, and never replay
// a message that already has a committed user row.
class RemoteMessageQueue {
  constructor({ file, manager, authorize, send }) {
    Object.assign(this, { file, manager, authorize, send });
    this.entries = readJson(file, []);
    this.starting = new Set();
    this.scheduled = new Set();
    this.closed = false;
    this.revision = Date.now();
    this.entries = this.entries.filter(entry => manager.items.has(entry.conversationId) && !this.committed(entry));
    for (const entry of this.entries) {
      entry.state = 'paused';
      entry.error = 'Computer restarted. Review and resume the queue.';
    }
    this.save();
  }
  save() { writeJson(this.file, this.entries); }
  committed(entry) {
    const conversation = this.manager.items.get(entry.conversationId);
    return conversation && this.manager.rawRows(conversation).some(row => row.queueId === entry.id);
  }
  view(id) {
    return this.entries.filter(entry => entry.conversationId === id).map(entry => ({
      id: entry.id, text: entry.payload.displayText ?? entry.payload.prompt, state: entry.state, at: entry.at,
      ...(entry.error ? { error: entry.error } : {}),
      attachments: (entry.payload.attachments || []).map(file => ({ name: file.name, isImage: file.isImage === true })),
    }));
  }
  changed(id) {
    this.save();
    this.revision++;
    if (this.manager.items.has(id)) this.manager.onEvent({ type: 'conversation:remote-queue', session_id: id, ...this.snapshot(id) });
  }
  snapshot(id) { return { queue: this.view(id), queueVersion: this.revision }; }
  add(deviceId, id, payload) {
    if (this.closed) fail(409, 'Camellia is closing');
    if (this.entries.length >= 200 || this.view(id).length >= 50) fail(409, 'Message queue is full');
    const paused = this.entries.some(entry => entry.conversationId === id && ['paused', 'failed'].includes(entry.state));
    const entry = { id: randomUUID(), conversationId: id, deviceId, payload, state: paused ? 'paused' : 'queued', at: Date.now() };
    this.entries.push(entry);
    try { this.changed(id); }
    catch (error) { this.entries.splice(this.entries.indexOf(entry), 1); throw error; }
    this.schedule(id);
    return { ok: true, state: 'queued', queueId: entry.id, ...this.snapshot(id) };
  }
  remove(id, queueId) {
    const entry = this.entries.find(entry => entry.conversationId === id && entry.id === queueId);
    if (!entry) fail(409, 'Queued message changed; refresh before removing it');
    if (entry.state === 'starting') fail(409, 'This message is already starting');
    this.entries.splice(this.entries.indexOf(entry), 1);
    this.changed(id); this.schedule(id);
    return { ok: true, ...this.snapshot(id) };
  }
  resume(id) {
    const entries = this.entries.filter(entry => entry.conversationId === id);
    for (const entry of entries) this.authorize(entry.deviceId, id);
    for (const entry of entries) if (entry.state !== 'starting') { entry.state = 'queued'; delete entry.error; }
    this.changed(id); this.schedule(id);
    return { ok: true, ...this.snapshot(id) };
  }
  pause(id, reason = 'Queue paused. Review and resume when ready.') {
    let changed = false;
    for (const entry of this.entries) if (entry.conversationId === id && entry.state === 'queued') {
      entry.state = 'paused'; entry.error = reason; changed = true;
    }
    if (changed) this.changed(id);
  }
  revoke(deviceId) {
    if (this.closed) return;
    const affected = new Set();
    for (const entry of this.entries) if ((!deviceId || entry.deviceId === deviceId) && entry.state !== 'starting') {
      entry.state = 'paused'; entry.error = 'Remote access changed. Review the queue before resuming.'; affected.add(entry.conversationId);
    }
    for (const id of affected) this.changed(id);
  }
  schedule(id) {
    if (this.closed || this.scheduled.has(id) || this.starting.has(id) || !this.entries.some(entry => entry.conversationId === id)) return;
    this.scheduled.add(id);
    // Let result/goal/cancellation handlers finish before deciding to send.
    setImmediate(() => {
      this.scheduled.delete(id);
      void this.drain(id).catch(error => this.manager.log(error.message));
    });
  }
  async drain(id) {
    if (this.closed || this.manager.goalToolsClosed || this.starting.has(id) || this.manager.busy(id)) return;
    const entry = this.entries.find(entry => entry.conversationId === id);
    if (!entry || entry.state !== 'queued') return;
    this.starting.add(id);
    try {
      this.authorize(entry.deviceId, id);
      entry.state = 'starting'; this.changed(id);
      const result = await this.send(entry.deviceId, id, { ...entry.payload, queueId: entry.id });
      if (!result.ok) throw new Error(result.error || 'Could not start the queued message');
      this.entries.splice(this.entries.indexOf(entry), 1);
      this.changed(id);
      // A stopped or failed turn must not quietly launch the next request.
      result.done?.then(outcome => {
        if (this.closed) return;
        if (outcome.is_error || outcome.subtype === 'stopped') this.pause(id);
        else this.schedule(id);
      }).catch(error => { if (!this.closed) this.pause(id, error.message); });
    } catch (error) {
      if (this.committed(entry)) {
        const index = this.entries.indexOf(entry);
        if (index >= 0) this.entries.splice(index, 1);
      }
      else { entry.state = 'failed'; entry.error = error.message; }
      this.pause(id);
      this.changed(id);
    } finally {
      this.starting.delete(id);
      this.scheduleIfIdle(id);
    }
  }
  scheduleIfIdle(id) {
    if (this.entries.find(entry => entry.conversationId === id)?.state === 'queued' && !this.manager.busy(id)) this.schedule(id);
  }
  close() { this.closed = true; }
  discard(id) {
    this.entries = this.entries.filter(entry => entry.conversationId !== id);
    this.changed(id);
  }
}

module.exports = { RemoteMessageQueue };
