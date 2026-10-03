'use strict';

const { fail } = require('./access');
const { createHash } = require('node:crypto');
const { approval } = require('./commands');
const { projectOutput, cleanProcess } = require('../../shared/mobile-output');
const { settingsView } = require('./settings');
const { latestFilePreview } = require('./conversation-preview');
const { MAX_COUNT: MAX_ATTACHMENTS } = require('./attachments');

const TEXT_LIMIT = 256 * 1024;
function text(value) {
  const source = typeof value === 'string' ? value : '';
  return { text: source.slice(-TEXT_LIMIT), textTruncated: source.length > TEXT_LIMIT };
}
function compactionView(value) {
  if (!value || !['running', 'completed', 'failed', 'cancelled'].includes(value.state)) return null;
  const result = { state: value.state, native: value.native === true };
  if (['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi'].includes(value.engine)) result.engine = value.engine;
  if (['summarizing', 'saving'].includes(value.stage)) result.stage = value.stage;
  for (const key of ['seq', 'afterSeq', 'chunk', 'durationMs']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key];
  }
  if (value.finalChunk === true) result.finalChunk = true;
  return result;
}
function message(row) {
  let value = row.displayText ?? row.mobileText ?? row.text, process = cleanProcess(row.process);
  if (row.role === 'tool') {
    try { process = projectOutput([JSON.parse(row.text)], true).process; } catch {}
    value = '';
  }
  if (row.role === 'assistant' && Array.isArray(row.outputBlocks)) {
    value = row.outputBlocks.filter(block => block.phase === 'final_answer').map(block => block.text || '').join('\n\n');
    if (!process.length) process = cleanProcess(row.outputBlocks.filter(block => block.phase !== 'final_answer')
      .map(block => ({ type: 'text', text: block.text })));
  }
  const attachedFiles = (Array.isArray(row.attachments) ? row.attachments : []).filter(file => typeof file?.name === 'string')
    .slice(0, MAX_ATTACHMENTS).map(file => ({ name: file.name.replace(/[\\/\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '_').slice(0, 180), isImage: file.isImage === true }));
  const compaction = row.role === 'notice' && row.compaction
    ? compactionView({ ...row.compaction, state: row.compaction.state || 'completed', engine: row.engine, seq: row.seq }) : null;
  return { seq: row.seq, role: row.role, engine: row.engine, at: row.at, ...text(value), ...(compaction ? { compaction } : {}),
    ...(process.length ? { process } : {}), ...(attachedFiles.length ? { attachedFiles } : {}) };
}

function mobileGoal(goal, rows) {
  if (!goal) return null;
  const completedAt = goal.phase === 'complete' ? Number(goal.verified?.at || goal.updatedAt || 0) : 0;
  // The saved goal remains available on the computer. Its completion belongs
  // to the finished work, not every later turn (including after reconnecting).
  const datedCompletion = Number.isFinite(completedAt) && completedAt > 0;
  if (datedCompletion && rows.some(row => row.role === 'user' && row.at > completedAt)) return null;
  return { ...(goal.id ? { id: String(goal.id).slice(0, 100) } : {}),
    objective: String(goal.objective || '').slice(0, 2000), phase: goal.phase, roundsStarted: goal.roundsStarted, armed: goal.armed,
    ...(datedCompletion ? { completedAt } : {}) };
}

class RemoteReadModel {
  constructor(manager) { this.manager = manager; this.previewCache = new WeakMap(); this.compactions = new WeakMap(); }
  observeCompaction(update) {
    if (!update?.compaction && update?.type !== 'gui:compaction') return;
    const conversation = this.manager.items.get(update?.sessionId || update?.session_id);
    if (!conversation) return;
    const value = compactionView(update.type === 'gui:compaction'
      ? { state: update.state, native: true, engine: update.engine, seq: update.compactionSeq, durationMs: update.compactionDurationMs }
      : update.compaction);
    if (!value) return;
    const previous = this.compactions.get(conversation);
    value.afterSeq = previous?.value.state === 'running' ? previous.value.afterSeq : conversation.seq;
    this.compactions.set(conversation, { value, observedSeq: conversation.seq });
  }
  currentCompaction(conversation, active, transcript) {
    const saved = this.compactions.get(conversation);
    const last = conversation.lastCompaction;
    const current = compactionView(this.manager.switching?.get(conversation.id)?.compaction || active?.compaction
      || (['failed', 'cancelled'].includes(last?.outcome) && Number.isSafeInteger(last.boundary)
        && !transcript.some(row => row.role === 'user' && row.seq > last.boundary)
        ? { state: last.outcome, engine: last.engine || conversation.currentEngine,
        native: last.route === 'native' } : null));
    if (current) return { ...current, afterSeq: saved?.value.state === 'running' ? saved.value.afterSeq : conversation.seq };
    // A missing running state is not evidence of success. Terminal events survive
    // stream coalescing, but a later user turn retires this transient indicator.
    if (!saved || saved.value.state === 'running' || transcript.some(row => row.role === 'user' && row.seq > saved.observedSeq)) return null;
    return saved.value;
  }
  workspaces() {
    return this.manager.workspaces.sessionMeta().workspaces.map(({ id, name }) => ({ id, name }));
  }
  allowed(device, conversation, meta = this.manager.workspaces.sessionMeta(), includeArchived = false) {
    const workspaceId = meta.sessionWorkspace[conversation.id];
    if (meta.archived[conversation.id] && !includeArchived) return false;
    if (!workspaceId) return device.allWorkspaces === true || device.includeUnassigned === true;
    return Boolean((device.allWorkspaces === true || device.workspaceIds.includes(workspaceId))
      && meta.workspaces.some(workspace => workspace.id === workspaceId));
  }
  conversation(device, id) {
    const conversation = this.manager.items.get(id);
    if (!conversation || !this.allowed(device, conversation)) fail(404, 'Conversation not found');
    return conversation;
  }
  archived(device, offset = 0) {
    const meta = this.manager.workspaces.sessionMeta();
    const entries = [...this.manager.items.values()].filter(conversation => meta.archived[conversation.id] && this.allowed(device, conversation, meta, true))
      .sort((first, second) => meta.archived[second.id] - meta.archived[first.id] || first.id.localeCompare(second.id));
    return { conversations: entries.slice(offset, offset + 100).map(conversation => ({ ...this.summary(conversation, meta, true), archivedAt: meta.archived[conversation.id] })),
      nextOffset: entries.length > offset + 100 ? offset + 100 : null };
  }
  filePreview(conversation) {
    const previous = this.previewCache.get(conversation);
    if (previous && previous.seq === conversation.seq && previous.updatedAt === conversation.updatedAt) return previous.value;
    const rows = this.manager.rows ? this.manager.rows(conversation) : this.manager.messages(conversation);
    const value = latestFilePreview(rows);
    this.previewCache.set(conversation, { seq: conversation.seq, updatedAt: conversation.updatedAt, value });
    return value;
  }
  summary(conversation, meta = this.manager.workspaces.sessionMeta(), includePreview = false) {
    const filePreview = includePreview ? this.filePreview(conversation) : null;
    return { id: conversation.id, title: String(meta.titles[conversation.id] || conversation.title).slice(0, 200),
      engine: conversation.currentEngine, pinned: Boolean(meta.pinned[conversation.id]), workspaceId: meta.sessionWorkspace[conversation.id] || null,
      workspaceName: meta.workspaces.find(workspace => workspace.id === meta.sessionWorkspace[conversation.id])?.name || null,
      updatedAt: conversation.updatedAt, seq: conversation.seq, lastReplyAt: conversation.lastReplyAt || 0, replyReadAt: conversation.replyReadAt || 0,
      activity: this.manager.activity(conversation.id), ...(filePreview ? { filePreview } : {}) };
  }
  list(device, offset = 0) {
    const meta = this.manager.workspaces.sessionMeta();
    const conversations = [...this.manager.items.values()].filter(conversation => this.allowed(device, conversation, meta))
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
    for (const [group, order] of Object.entries(meta.sessionOrder)) {
      const ranks = new Map(order.map((id, index) => [id, index]));
      const slots = conversations.map((conversation, index) => (meta.pinned[conversation.id] ? 'pinned' : meta.sessionWorkspace[conversation.id] || 'recent') === group ? index : -1).filter(index => index >= 0);
      const sorted = slots.map(index => conversations[index]).sort((first, second) => (ranks.get(first.id) ?? -1) - (ranks.get(second.id) ?? -1));
      slots.forEach((slot, index) => { conversations[slot] = sorted[index]; });
    }
    conversations.sort((left, right) => Number(Boolean(meta.pinned[right.id])) - Number(Boolean(meta.pinned[left.id])));
    return { conversations: conversations.slice(offset, offset + 100).map(conversation => this.summary(conversation, meta, true)),
      nextOffset: conversations.length > offset + 100 ? offset + 100 : null };
  }
  listSnapshot(device) {
    const meta = this.manager.workspaces.sessionMeta();
    const hash = createHash('sha256');
    hash.update(JSON.stringify(meta.workspaces.filter(workspace => device.allWorkspaces === true || device.workspaceIds.includes(workspace.id)).map(({ id, name }) => ({ id, name }))));
    for (const conversation of this.manager.items.values()) {
      if (this.allowed(device, conversation, meta)) {
        const group = meta.pinned[conversation.id] ? 'pinned' : meta.sessionWorkspace[conversation.id] || 'recent';
        hash.update(JSON.stringify([this.summary(conversation, meta), group, (meta.sessionOrder[group] || []).indexOf(conversation.id)]));
      }
    }
    return { listVersion: hash.digest('hex') };
  }
  snapshot(device, id, before) {
    const conversation = this.conversation(device, id);
    const transcript = (this.manager.rows ? this.manager.rows(conversation) : this.manager.messages(conversation))
      .filter(row => !row.internal && ['user', 'assistant', 'notice', 'tool'].includes(row.role));
    const rows = transcript.filter(row => before === undefined || row.seq < before);
    const messages = [];
    let size = 0;
    for (const row of rows.slice(-200).reverse()) {
      const selected = message(row);
      size += selected.text.length + JSON.stringify(selected.process || []).length;
      if (messages.length && size > 1024 * 1024) break;
      messages.unshift(selected);
    }
    const active = this.manager.recovering.get(id) || this.manager.active.get(id);
    const output = active?.events?.length ? projectOutput(active.events) : null;
    const live = !before && active && !active.internal ? { runId: active.facade.gen, eventSeq: active.eventSeq,
      startedAt: active.startedAt, userSeq: active.userSeq, ...text(output ? output.text : active.text || active.assistant.join('\n\n')),
      ...(output?.process.length ? { process: output.process } : {}),
      pendingApprovals: active.permissions.size, approvals: device.permission === 'control' ? [...active.permissions.values()].map(approval) : [] } : null;
    const goal = this.manager.goalFor?.(id)?.view();
    const selected = active?.settings || this.manager.settings(conversation.currentEngine, id);
    const pressure = this.manager.contextPressure?.(conversation, conversation.currentEngine, selected, active);
    const compaction = before === undefined ? this.currentCompaction(conversation, active, transcript) : null;
    return { conversation: this.summary(conversation), messages, live, permission: device.permission,
      compaction,
      ...(pressure ? { context: { used: Math.max(0, Math.round(pressure.used)), cap: pressure.cap, source: pressure.source,
        compacting: compaction?.state === 'running', compactionState: compaction?.state || '' } } : {}),
      ...(this.manager.remoteQueue ? this.manager.remoteQueue.snapshot(id) : {}),
      automation: { goal: mobileGoal(goal, transcript),
        tasks: (this.manager.tasks?.list(id) || []).map(task => ({ id: task.id, instruction: String(task.instruction || '').slice(0, 500), status: task.status, state: task.state, intervalMinutes: task.intervalMinutes, lastResult: String(task.lastResult || '').slice(0, 600) })) },
      ...(device.permission === 'control' ? { settings: settingsView(this.manager, conversation) } : {}),
      nextBefore: rows.length > messages.length ? messages[0]?.seq ?? null : null };
  }
}

module.exports = { RemoteReadModel };
