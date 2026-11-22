'use strict';

const { randomUUID } = require('node:crypto');
const { readJson, writeJson } = require('../../shared/json-store');
const { fail } = require('./access');

const QUEUE_STATES = new Set(['queued', 'starting', 'paused', 'failed']);
const compareEntries = (first, second) =>
  (Number(first.order) || 0) - (Number(second.order) || 0)
  || (Number(first.at) || 0) - (Number(second.at) || 0)
  || String(first.id).localeCompare(String(second.id));

// Messages accepted from the desktop and paired devices share one computer-owned
// queue. A single monotonic order is what makes the next turn deterministic even
// when both sources add work while the conversation is busy.
class RemoteMessageQueue {
  constructor({ file, manager, authorize, send }) {
    Object.assign(this, { file, manager });
    this.transport = { authorize, send };
    const saved = readJson(file, []);
    this.entries = Array.isArray(saved) ? saved : [];
    this.starting = new Set();
    this.scheduled = new Set();
    this.closed = false;
    this.revision = Date.now();
    this.order = 0;
    this.entries = this.entries
      .filter(entry => manager.items.has(entry.conversationId) && !this.committed(entry))
      .map((entry, index) => this.normalize(entry, index))
      .sort(compareEntries);
    for (const entry of this.entries) {
      this.order = Math.max(this.order, entry.order);
      entry.state = 'paused';
      entry.error = 'Computer restarted. Review and resume the queue.';
    }
    this.save();
  }

  normalize(entry, index = 0) {
    const source = entry.source === 'desktop' ? 'desktop' : 'mobile';
    const at = Number.isFinite(entry.at) ? entry.at : Date.now() + index;
    return {
      ...entry,
      source,
      payload: entry.payload && typeof entry.payload === 'object' ? entry.payload : {},
      state: QUEUE_STATES.has(entry.state) ? entry.state : 'queued',
      at,
      order: Number.isFinite(entry.order) ? entry.order : at + index,
    };
  }

  setTransport({ authorize, send } = {}) {
    this.transport = { authorize, send };
  }

  nextOrder(at = Date.now()) {
    this.order = Math.max(Number(at) || Date.now(), this.order + 1);
    return this.order;
  }

  save() { writeJson(this.file, this.entries); }

  committed(entry) {
    const conversation = this.manager.items.get(entry.conversationId);
    return conversation && this.manager.rawRows(conversation).some(row => row.queueId === entry.id);
  }

  view(id, { source, redactAttachments = false } = {}) {
    return this.entries
      .filter(entry => entry.conversationId === id && (!source || entry.source === source))
      .sort(compareEntries)
      .map(entry => {
        const payload = entry.payload || {};
        const desktop = entry.source === 'desktop';
        return {
          id: entry.id,
          source: entry.source,
          text: desktop
            ? payload.displayText ?? payload.text ?? ''
            : payload.displayText ?? payload.prompt ?? '',
          state: entry.state,
          at: entry.at,
          order: entry.order,
          ...(entry.error ? { error: entry.error } : {}),
          ...(desktop && !redactAttachments ? {
            displayText: payload.displayText ?? payload.text ?? '',
            attachments: (payload.attachments || []).map(file => ({ ...file })),
          } : {
            attachments: (payload.attachments || []).map(file => ({ name: file.name, isImage: file.isImage === true })),
          }),
        };
      });
  }

  changed(id) {
    this.save();
    this.revision++;
    if (this.manager.items.has(id)) this.manager.onEvent({ type: 'conversation:remote-queue', session_id: id, ...this.snapshot(id) });
  }

  snapshot(id, options) {
    return { queue: this.view(id, options), queueVersion: this.revision };
  }

  add(deviceId, id, payload) {
    return this.addEntry({ id, source: 'mobile', deviceId, payload });
  }

  addDesktop(id, payload) {
    return this.addEntry({ id, source: 'desktop', payload });
  }

  addEntry({ id, source, deviceId, payload }) {
    if (this.closed) fail(409, 'Camellia is closing');
    if (this.entries.length >= 200 || this.view(id).length >= 50) fail(409, 'Message queue is full');
    const paused = this.entries.some(entry => entry.conversationId === id && ['paused', 'failed'].includes(entry.state));
    const at = Date.now();
    const entry = {
      id: randomUUID(),
      conversationId: id,
      source,
      ...(deviceId ? { deviceId } : {}),
      payload,
      state: paused ? 'paused' : 'queued',
      at,
      order: this.nextOrder(at),
    };
    this.entries.push(entry);
    this.entries.sort(compareEntries);
    try { this.changed(id); }
    catch (error) {
      const index = this.entries.indexOf(entry);
      if (index >= 0) this.entries.splice(index, 1);
      throw error;
    }
    this.schedule(id);
    return { ok: true, state: entry.state, queueId: entry.id, ...this.snapshot(id) };
  }

  remove(id, queueId, { source } = {}) {
    const entry = this.entries.find(entry => entry.conversationId === id && entry.id === queueId);
    if (!entry || source && entry.source !== source) fail(409, 'Queued message changed; refresh before removing it');
    if (entry.state === 'starting') fail(409, 'This message is already starting');
    const index = this.entries.indexOf(entry);
    this.entries.splice(index, 1);
    try { this.changed(id); }
    catch (error) {
      this.entries.splice(index, 0, entry);
      this.entries.sort(compareEntries);
      throw error;
    }
    this.schedule(id);
    return { ok: true, ...this.snapshot(id) };
  }

  // Either device can edit in place without changing ownership or queue order.
  edit(id, queueId, text, expectedText, { source } = {}) {
    const entry = this.entries.find(entry => entry.conversationId === id && entry.id === queueId);
    if (!entry || source && entry.source !== source
      || typeof expectedText !== 'string'
      || (entry.payload.displayText ?? entry.payload.text ?? entry.payload.prompt ?? '') !== expectedText)
      fail(409, 'Queued message changed; refresh before editing it');
    if (entry.state === 'starting') fail(409, 'This message is already starting');
    if (typeof text !== 'string' || !text.trim() || text.length > 16_000) fail(400, 'Enter a message of at most 16000 characters');
    const previous = entry.payload;
    const prompt = String(previous.prompt || '');
    const original = String(previous.text ?? previous.displayText ?? previous.prompt ?? '');
    // Desktop display text can be a card label, while text contains the actual
    // prompt. Keep the prepared attachment context after that original text.
    const boundary = original.length || prompt.indexOf('\n\n');
    const suffix = boundary >= 0 ? prompt.slice(boundary) : '';
    entry.payload = { ...previous, prompt: text.trim() + suffix, displayText: text.trim(),
      ...(entry.source === 'desktop' ? { text: text.trim() } : {}) };
    try { this.changed(id); }
    catch (error) { entry.payload = previous; throw error; }
    return { ok: true, ...this.snapshot(id) };
  }

  takeDesktop(id, queueId) {
    const entry = this.entries.find(entry => entry.conversationId === id && entry.id === queueId && entry.source === 'desktop');
    if (!entry) fail(409, 'Queued message changed; refresh before editing it');
    if (entry.state === 'starting') fail(409, 'This message is already starting');
    const index = this.entries.indexOf(entry);
    this.entries.splice(index, 1);
    try { this.changed(id); }
    catch (error) {
      this.entries.splice(index, 0, entry);
      this.entries.sort(compareEntries);
      throw error;
    }
    return {
      ok: true,
      entry: {
        id: entry.id,
        text: entry.payload.text ?? entry.payload.displayText ?? entry.payload.prompt ?? '',
        displayText: entry.payload.displayText ?? entry.payload.text ?? '',
        attachments: (entry.payload.attachments || []).map(file => ({ ...file })),
      },
      ...this.snapshot(id),
    };
  }

  authorizeEntry(entry, id) {
    if (entry.source === 'desktop') return this.manager.get(id);
    if (typeof this.transport.authorize !== 'function') fail(503, 'Mobile access is not ready');
    return this.transport.authorize(entry.deviceId, id);
  }

  async steer(id, queueId, runId, goalId, { source } = {}) {
    if (this.closed) fail(409, 'Camellia is closing');
    const entry = this.entries.find(entry => entry.conversationId === id && entry.id === queueId);
    if (!entry || source && entry.source !== source) fail(409, 'Queued message changed; refresh before sending it');
    if (entry.state === 'starting' || this.starting.has(id)) fail(409, 'A queued message is already starting');
    const conversation = this.authorizeEntry(entry, id);
    const active = this.manager.active.get(id);
    const goal = goalId === undefined ? null : this.manager.goalFor(id);
    if (goal) {
      if (typeof goalId !== 'string' || !goalId || goal.goal?.id !== goalId || !goal.armed || goal.goal.phase !== 'active')
        fail(409, 'This goal is no longer active. Refresh before sending the instruction.');
    } else if (!Number.isSafeInteger(runId) || !active || active.facade.gen !== runId)
      fail(409, 'This run is no longer active. The message is still queued; send it after the current turn finishes.');
    this.starting.add(id);
    try {
      entry.state = 'starting'; this.changed(id);
      const payload = { ...entry.payload, sessionId: id, runId, queueId: entry.id, ...(goal ? { goalId } : {}) };
      const result = await (goal ? this.manager.steerGoal(conversation.currentEngine, payload) : this.manager.steer(conversation.currentEngine, payload));
      if (!result.ok) fail(409, result.error || 'The current task cannot accept an insert right now. The message is still queued.');
      const index = this.entries.indexOf(entry);
      if (index >= 0) this.entries.splice(index, 1);
      this.changed(id);
      return { ...result, ...this.snapshot(id) };
    } catch (error) {
      // A committed instruction must never become a second ordinary send, even
      // when saving or publishing its acknowledgement fails.
      if (this.committed(entry)) {
        const index = this.entries.indexOf(entry);
        if (index >= 0) this.entries.splice(index, 1);
      } else {
        entry.state = 'failed';
        entry.error = error.message;
      }
      // A failed handoff may have reached the engine before its connection
      // failed. Require review rather than replaying it when this turn ends.
      this.pause(id);
      this.changed(id);
      throw error;
    } finally {
      this.starting.delete(id);
      this.scheduleIfIdle(id);
    }
  }

  resume(id, { source } = {}) {
    const entries = this.entries.filter(entry => entry.conversationId === id && (!source || entry.source === source));
    for (const entry of entries) if (entry.source === 'mobile') this.authorizeEntry(entry, id);
    for (const entry of entries) if (entry.state !== 'starting') {
      entry.state = 'queued';
      delete entry.error;
    }
    this.changed(id);
    this.schedule(id);
    return { ok: true, ...this.snapshot(id) };
  }

  pause(id, reason = 'Queue paused. Review and resume when ready.', { source } = {}) {
    let changed = false;
    for (const entry of this.entries) if (entry.conversationId === id && entry.state === 'queued'
      && (!source || entry.source === source)) {
      entry.state = 'paused';
      entry.error = reason;
      changed = true;
    }
    if (changed) this.changed(id);
  }

  revoke(deviceId) {
    if (this.closed) return;
    const affected = new Set();
    for (const entry of this.entries) if (entry.source === 'mobile' && (!deviceId || entry.deviceId === deviceId)
      && entry.state !== 'starting') {
      entry.state = 'paused';
      entry.error = 'Remote access changed. Review the queue before resuming.';
      affected.add(entry.conversationId);
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

  async sendDesktop(id, entry) {
    const conversation = this.manager.get(id);
    const payload = { ...entry.payload, sessionId: id, queueId: entry.id };
    const goal = payload.goalId ? this.manager.goalFor(id) : null;
    if (goal && goal.goal?.id === payload.goalId && goal.armed && goal.goal.phase === 'active')
      return this.manager.steerGoal(conversation.currentEngine, payload);
    delete payload.goalId;
    return this.manager.send(conversation.currentEngine, payload);
  }

  async drain(id) {
    if (this.closed || this.manager.goalToolsClosed || this.starting.has(id) || this.manager.busy(id)) return;
    const entry = this.entries.find(entry => entry.conversationId === id);
    // Never skip a paused, failed or in-flight earlier entry: the queue is one
    // ordered stream even when the next item comes from a different source.
    if (!entry || entry.state !== 'queued') return;
    this.starting.add(id);
    try {
      this.authorizeEntry(entry, id);
      entry.state = 'starting';
      this.changed(id);
      const result = entry.source === 'desktop'
        ? await this.sendDesktop(id, entry)
        : await this.transport.send(entry.deviceId, id, { ...entry.payload, queueId: entry.id });
      if (!result.ok) throw new Error(result.error || 'Could not start the queued message');
      const index = this.entries.indexOf(entry);
      if (index >= 0) this.entries.splice(index, 1);
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
      } else {
        entry.state = 'failed';
        entry.error = error.message;
      }
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
