'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeJson } = require('../../shared/json-store');
const { UUID, LIMITS } = require('./schema');
const { directoryStat, fileStat, sameStat, readBoundedJson } = require('./payloads');
const matches = (row, d) => row.deliveryId === d.id && row.generation === d.generation
  && row.runtimeId === d.runtimeId && row.nativeId === d.nativeId;
function validateText(text) {
  if (typeof text !== 'string' || Buffer.byteLength(JSON.stringify(text)) > LIMITS.messageBytes)
    throw new Error('Invalid discussion records: text or text size');
}
function directory(root, id, create = false) {
  if (!UUID.test(id)) throw new Error('Invalid discussion ID');
  directoryStat(root);
  const dir = path.join(root, id + '.drafts');
  if (create) fs.mkdirSync(dir, { recursive: true });
  directoryStat(dir); return dir;
}
function loadDraft(root, id, d) {
  let row;
  try { row = readBoundedJson(path.join(directory(root, id), d.id + '.json'), LIMITS.messageBytes + 4096).value; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const keys = ['version', 'discussionId', 'deliveryId', 'generation', 'runtimeId', 'nativeId', 'revision', 'text'];
  if (!row || Object.keys(row).length !== keys.length || keys.some(k => !Object.hasOwn(row, k)) || row.version !== 1
    || row.discussionId !== id || !Number.isSafeInteger(row.revision) || row.revision < 1
    || !Number.isSafeInteger(row.generation) || row.generation < 1 || !UUID.test(row.deliveryId) || !UUID.test(row.runtimeId)
    || typeof row.nativeId !== 'string' || row.nativeId.length > 1024) throw new Error('Invalid discussion draft');
  validateText(row.text); return row;
}
function applyDrafts(root, state, live) {
  const baseRevision = state.revision;
  for (const d of state.deliveries) {
    if (!['running', 'stopping'].includes(d.status) || d.settlement || !d.nativeId) continue;
    const entry = live?.get(state.id + '/' + d.id);
    const row = entry && matches(entry.row, d) ? entry.row : loadDraft(root, state.id, d);
    if (!row || !matches(row, d) || row.revision < baseRevision) continue;
    d.partialText = row.text; state.revision = Math.max(state.revision, row.revision);
  }
  return state;
}

// UI updates are immediate; only this small per-delivery file is checkpointed.
// First text is saved synchronously, then at most once per checkpoint interval.
class DiscussionDrafts {
  constructor(store, { checkpointMs = 250, writeDraft = writeJson } = {}) {
    this.store = store; this.checkpointMs = checkpointMs; this.write = writeDraft;
    this.entries = new Map(); this.revisions = new Map();
  }
  merge(state) {
    applyDrafts(this.store.dir, state, this.entries);
    state.revision = Math.max(state.revision, this.revisions.get(state.id) || 0);
    return state;
  }
  partial(id, deliveryId, generation, text) {
    validateText(text);
    const key = id + '/' + deliveryId, stat = fileStat(this.store.file(id), this.store.maxRecordBytes + 64);
    let entry = this.entries.get(key);
    if (!entry || !sameStat(entry.stat, stat)) {
      const state = this.store.read(id), d = state.deliveries.find(d => d.id === deliveryId);
      if (!d || d.generation !== generation) throw new Error('Stale delivery');
      if (d.status !== 'running' || d.settlement) throw new Error('Delivery is not running');
      if (state.participants.find(p => p.id === d.participantId)?.session.generation !== generation) throw new Error('Stale generation');
      if (entry) clearTimeout(entry.timer);
      entry = { stat, row: { version: 1, discussionId: id, deliveryId, generation,
        runtimeId: d.runtimeId, nativeId: d.nativeId, revision: state.revision, text }, dirty: false };
      this.entries.set(key, entry);
    }
    if (entry.row.generation !== generation) throw new Error('Stale generation');
    if (entry.row.text === text && entry.saved) return;
    entry.row.text = text;
    entry.row.revision = Math.max(entry.row.revision, this.revisions.get(id) || 0) + 1;
    this.revisions.set(id, entry.row.revision); entry.dirty = true;
    if (!entry.saved) {
      try { this.flush(entry); }
      catch (error) {
        this.entries.delete(key);
        if (![...this.entries.values()].some(e => e.row.discussionId === id)) this.revisions.delete(id);
        throw error;
      }
    } else if (!entry.timer) {
      entry.timer = setTimeout(() => {
        entry.timer = null;
        try { this.flush(entry); } catch (error) { this.store.report(error); }
      }, this.checkpointMs);
      entry.timer.unref?.();
    }
  }
  flush(entry) {
    if (!entry.dirty) return;
    const { discussionId: id, deliveryId } = entry.row;
    // A second store/recovery may have committed while this timer waited.
    const stat = fileStat(this.store.file(id), this.store.maxRecordBytes + 64);
    if (!sameStat(entry.stat, stat)) {
      const state = this.store.read(id), d = state.deliveries.find(d => d.id === deliveryId);
      if (!d || d.status !== 'running' || d.settlement || !matches(entry.row, d)) {
        this.discard(id, deliveryId); return;
      }
      entry.stat = stat; entry.row.revision = Math.max(entry.row.revision, state.revision);
    }
    this.write(path.join(directory(this.store.dir, id, true), deliveryId + '.json'), entry.row);
    entry.saved = true; entry.dirty = false;
  }
  discard(id, deliveryId) {
    const key = id + '/' + deliveryId, entry = this.entries.get(key);
    if (entry) { clearTimeout(entry.timer); this.entries.delete(key); }
    const dir = path.join(this.store.dir, id + '.drafts');
    try {
      directory(this.store.dir, id); fs.unlinkSync(path.join(dir, deliveryId + '.json'));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { fs.rmdirSync(dir); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
  }
  committed(state) {
    const stat = fileStat(this.store.file(state.id), this.store.maxRecordBytes + 64);
    const deliveries = new Map(state.deliveries.map(d => [d.id, d])), ids = new Set();
    for (const entry of this.entries.values()) if (entry.row.discussionId === state.id) ids.add(entry.row.deliveryId);
    try {
      for (const name of fs.readdirSync(directory(this.store.dir, state.id))) {
        const id = name.endsWith('.json') ? name.slice(0, -5) : '';
        if (UUID.test(id)) ids.add(id);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const id of ids) {
      const d = deliveries.get(id), entry = this.entries.get(state.id + '/' + id);
      if (d?.status === 'running' && !d.settlement) {
        if (entry && matches(entry.row, d)) { entry.stat = stat; entry.row.revision = Math.max(entry.row.revision, state.revision); }
      } else this.discard(state.id, id);
    }
    if (![...this.entries.values()].some(e => e.row.discussionId === state.id)) this.revisions.delete(state.id);
    else this.revisions.set(state.id, state.revision);
  }
  close() {
    const errors = [];
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer);
      try { this.flush(entry); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Discussion draft checkpoints could not be saved');
    this.entries.clear(); this.revisions.clear();
  }
}

module.exports = { DiscussionDrafts, applyDrafts };
