'use strict';

const { fail } = require('./access');
const { createHash } = require('node:crypto');
const { approval } = require('./commands');
const { projectOutput, cleanProcess } = require('../../shared/mobile-output');
const { mobileTurnDetails } = require('../../shared/mobile-turn-details');
const { settingsView } = require('./settings');
const { latestFilePreview } = require('./conversation-preview');
const { MAX_COUNT: MAX_ATTACHMENTS } = require('./attachments');

const TEXT_LIMIT = 256 * 1024;
function boundedSubtasks(tasks) {
  const budget = Math.floor(512 * 1024 / Math.max(1, tasks.length));
  return tasks.map(task => {
    const value = { ...task, history: [...(task.history || [])], approvals: [...(task.approvals || [])] };
    while (Buffer.byteLength(JSON.stringify(value)) > budget) {
      value.detailsTruncated = true;
      if (value.history.length) value.history.shift();
      else if (value.approvals.length) value.approvals.pop();
      else {
        const key = ['goal', 'progress', 'result'].sort((a, b) => (value[b]?.length || 0) - (value[a]?.length || 0))[0];
        if (!value[key]?.length) break;
        value[key] = value[key].slice(-Math.floor(value[key].length / 2));
      }
    }
    return value;
  });
}
function text(value) {
  const source = typeof value === 'string' ? value : '';
  return { text: source.slice(-TEXT_LIMIT), textTruncated: source.length > TEXT_LIMIT };
}
const VISUALIZATION_STYLES = new Set(['whale', 'editorial', 'paper', 'sketch', 'terminal']);
const VISUALIZATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function visualizationValue(value, depth = 0) {
  if (depth > 6 || value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{')) return null;
    try { return visualizationValue(JSON.parse(trimmed), depth + 1); }
    catch { return null; }
  }
  if (typeof value !== 'object') return null;
  if (value.ok !== false && value.visualize) return value.visualize;
  if (typeof value.output === 'string') {
    const card = visualizationValue(value.output, depth + 1);
    if (card) return card;
  }
  if (Array.isArray(value.content)) {
    for (const item of value.content) {
      const card = visualizationValue(item?.text ?? item?.structuredContent ?? item, depth + 1);
      if (card) return card;
    }
  }
  if (value.structuredContent) return visualizationValue(value.structuredContent, depth + 1);
  return null;
}
function visualizationsFromProcess(process) {
  const cards = new Map();
  for (const entry of Array.isArray(process) ? process : []) {
    if (!entry || entry.type !== 'tool' || !/(?:^|__)camellia_visualize$/.test(String(entry.title || ''))) continue;
    const card = visualizationValue(entry.text);
    if (!card || !VISUALIZATION_ID.test(String(card.cardId || ''))) continue;
    const title = String(card.title || '').trim().slice(0, 120);
    if (!title) continue;
    const revision = Number.isSafeInteger(card.revision) && card.revision > 0 ? card.revision : 1;
    const current = cards.get(card.cardId);
    if (current && current.revision > revision) continue;
    cards.set(card.cardId, {
      cardId: card.cardId,
      title,
      summary: String(card.summary || '').slice(0, 500),
      mode: card.mode === 'wide' ? 'wide' : 'card',
      style: VISUALIZATION_STYLES.has(card.style) ? card.style : 'whale',
      revision,
    });
  }
  return [...cards.values()];
}
function compactionView(value) {
  if (!value || !['running', 'completed', 'failed', 'cancelled'].includes(value.state)) return null;
  const result = { state: value.state, native: value.native === true };
  if (['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'grok'].includes(value.engine)) result.engine = value.engine;
  if (['summarizing', 'saving'].includes(value.stage)) result.stage = value.stage;
  if (['map', 'reduce'].includes(value.summaryPhase)) result.summaryPhase = value.summaryPhase;
  for (const key of ['seq', 'afterSeq', 'chunk', 'durationMs', 'startedAt', 'elapsedMs', 'completedChunks', 'totalChunks']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key];
  }
  if (typeof value.totalChunksKnown === 'boolean') result.totalChunksKnown = value.totalChunksKnown;
  // Reconnecting phones receive a current duration without depending on their
  // clock agreeing with the host. The phone advances it locally between events.
  if (result.state === 'running' && result.startedAt !== undefined)
    result.elapsedMs = Math.max(0, Date.now() - result.startedAt);
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
    const answer = row.outputBlocks.filter(block => block.phase === 'final_answer').map(block => block.text || '').join('\n\n');
    if (!row.runResult) value = answer;
    else if (!row.mobileText) value = answer && answer !== row.runResult.result
      ? [answer, row.runResult.result].filter(Boolean).join('\n\n') : row.runResult.result || answer;
    if (!process.length) process = cleanProcess(row.outputBlocks.filter(block => block.phase !== 'final_answer')
      .map(block => ({ type: 'text', text: block.text })));
  }
  const attachedFiles = (Array.isArray(row.attachments) ? row.attachments : []).filter(file => typeof file?.name === 'string')
    .slice(0, MAX_ATTACHMENTS).map(file => ({ name: file.name.replace(/[\\/\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '_').slice(0, 180),
      isImage: file.isImage === true, ...(Number.isSafeInteger(file.size) && file.size >= 0 ? { size: file.size } : {}) }));
  const compaction = row.role === 'notice' && row.compaction
    ? compactionView({ ...row.compaction, state: row.compaction.state || 'completed', engine: row.engine, seq: row.seq }) : null;
  const turnDetails = mobileTurnDetails(row);
  const visualizations = visualizationsFromProcess(process);
  return { seq: row.seq, role: row.role, engine: row.engine, at: row.at, ...text(value), ...(compaction ? { compaction } : {}),
    ...(turnDetails ? { turnDetails } : {}),
    ...(Array.isArray(row.sources) && row.sources.length ? { sources: row.sources } : {}),
    ...(process.length ? { process } : {}), ...(visualizations.length ? { visualizations } : {}),
    ...(attachedFiles.length ? { attachedFiles } : {}) };
}

function mobileGoal(goal, rows, info) {
  if (!goal) return null;
  const completedAt = goal.phase === 'complete' ? Number(goal.verified?.at || goal.updatedAt || 0) : 0;
  // The saved goal remains available on the computer. Its completion belongs
  // to the finished work, not every later turn (including after reconnecting).
  const datedCompletion = Number.isFinite(completedAt) && completedAt > 0;
  if (datedCompletion && (info ? info.userAt > completedAt : rows.some(row => row.role === 'user' && row.at > completedAt))) return null;
  const waiting = goal.phase === 'active' && goal.armed === true && goal.waiting
    && Number.isSafeInteger(goal.waiting.until) && goal.waiting.until > 0
    ? { reason: typeof goal.waiting.reason === 'string' ? goal.waiting.reason.slice(0, 2000) : '', until: goal.waiting.until } : null;
  return { ...(goal.id ? { id: String(goal.id).slice(0, 100) } : {}),
    objective: String(goal.objective || '').slice(0, 2000), phase: goal.phase, roundsStarted: goal.roundsStarted, armed: goal.armed,
    ...(waiting ? { waiting } : {}),
    ...(datedCompletion ? { completedAt } : {}) };
}

class RemoteReadModel {
  constructor(manager) { this.manager = manager; this.previewCache = new WeakMap(); this.compactions = new WeakMap(); }
  observeCompaction(update) {
    if (!update?.compaction && update?.type !== 'gui:compaction') return;
    const conversation = this.manager.items.get(update?.sessionId || update?.session_id);
    if (!conversation) return;
    const value = compactionView(update.type === 'gui:compaction'
      ? { state: update.state, native: true, engine: update.engine, seq: update.compactionSeq, durationMs: update.compactionDurationMs,
        startedAt: update.compactionStartedAt, elapsedMs: update.compactionElapsedMs }
      : update.compaction);
    if (!value) return;
    const previous = this.compactions.get(conversation);
    value.afterSeq = previous?.value.state === 'running' ? previous.value.afterSeq : conversation.seq;
    this.compactions.set(conversation, { value, observedSeq: conversation.seq });
  }
  currentCompaction(conversation, active, transcript, info) {
    const saved = this.compactions.get(conversation);
    const last = conversation.lastCompaction;
    const current = compactionView(this.manager.switching?.get(conversation.id)?.compaction || active?.compaction
      || (['failed', 'cancelled'].includes(last?.outcome) && Number.isSafeInteger(last.boundary)
        && !(info ? info.userSeq > last.boundary : transcript.some(row => row.role === 'user' && row.seq > last.boundary))
        ? { state: last.outcome, engine: last.engine || conversation.currentEngine,
        native: last.route === 'native' } : null));
    if (current) return { ...current, afterSeq: saved?.value.state === 'running' ? saved.value.afterSeq : conversation.seq };
    // A missing running state is not evidence of success. Terminal events survive
    // stream coalescing, but a later user turn retires this transient indicator.
    if (!saved || saved.value.state === 'running' || (info ? info.userSeq > saved.observedSeq : transcript.some(row => row.role === 'user' && row.seq > saved.observedSeq))) return null;
    return saved.value;
  }
  workspaces() {
    return this.manager.workspaces.sessionMeta().workspaces.map(({ id, name }) => ({ id, name }));
  }
  allowed(device, conversation, meta = this.manager.workspaces.sessionMeta(), includeArchived = false) {
    if (conversation.internal) return false;
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
  conversationState(device, conversation) {
    const archivedAt = this.manager.workspaces.sessionMeta().archived[conversation.id] || 0;
    return { permission: archivedAt ? 'read' : device.permission,
      ...(archivedAt ? { archived: { at: archivedAt } } : {}) };
  }
  // The one write an archived detail page may perform. Restoring ends the
  // read-only state; every other command still goes through conversation().
  canRestore(device, conversation) {
    return device.permission === 'control'
      && Boolean(this.manager.workspaces.sessionMeta().archived[conversation.id]);
  }
  // Archived conversations are readable, but they are not a second control
  // surface. The stream checks this rather than `allowed()` so a heartbeat does
  // not turn an intentionally read-only transcript into a 404.
  readable(device, conversation, meta = this.manager.workspaces.sessionMeta()) {
    return this.allowed(device, conversation, meta, true);
  }
  readableConversation(device, id) {
    const conversation = this.manager.items.get(id);
    if (!conversation || !this.readable(device, conversation)) fail(404, 'Conversation not found');
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
    const source = this.manager.historyInfo?.(conversation)?.source;
    const previous = this.previewCache.get(conversation);
    if (previous && previous.seq === conversation.seq && previous.updatedAt === conversation.updatedAt && previous.source === source) return previous.value;
    let value = null;
    if (this.manager.latestPreviewRows) {
      for (const row of this.manager.latestPreviewRows(conversation)) { value = latestFilePreview([row]); if (value) break; }
    } else value = latestFilePreview(this.manager.rows ? this.manager.rows(conversation) : this.manager.messages(conversation));
    this.previewCache.set(conversation, { seq: conversation.seq, updatedAt: conversation.updatedAt, source, value });
    return value;
  }
  summary(conversation, meta = this.manager.workspaces.sessionMeta(), includePreview = false) {
    const filePreview = includePreview ? this.filePreview(conversation) : null;
    const backgroundWork = this.manager.backgroundStatus?.(conversation.id) || null;
    const selected = this.manager.settings?.(conversation.currentEngine, conversation.id);
    const model = typeof selected?.model === 'string' ? selected.model : '';
    const choice = model && this.manager.conversationModels?.(conversation.currentEngine, selected).find(choice => choice.id === model);
    const modelName = typeof choice?.name === 'string' && choice.name.trim() ? choice.name : model;
    return { id: conversation.id, title: String(meta.titles[conversation.id] || conversation.title).slice(0, 200),
      engine: conversation.currentEngine, model, modelName, pinned: Boolean(meta.pinned[conversation.id]), workspaceId: meta.sessionWorkspace[conversation.id] || null,
      workspaceName: meta.workspaces.find(workspace => workspace.id === meta.sessionWorkspace[conversation.id])?.name || null,
      updatedAt: conversation.updatedAt, seq: conversation.seq, lastReplyAt: conversation.lastReplyAt || 0, replyReadAt: conversation.replyReadAt || 0,
      activity: this.manager.activity(conversation.id), ...(meta.archived[conversation.id] ? { archivedAt: meta.archived[conversation.id] } : {}),
      ...(backgroundWork ? { backgroundWork } : {}), ...(filePreview ? { filePreview } : {}) };
  }
  list(device, offset = 0, limit = 100, query = '') {
    const meta = this.manager.workspaces.sessionMeta();
    const conversations = [...this.manager.items.values()].filter(conversation => this.allowed(device, conversation, meta)
      && (!query || String(meta.titles[conversation.id] || conversation.title).toLowerCase().includes(query)))
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
    for (const [group, order] of Object.entries(meta.sessionOrder)) {
      const ranks = new Map(order.map((id, index) => [id, index]));
      const slots = conversations.map((conversation, index) => (meta.pinned[conversation.id] ? 'pinned' : meta.sessionWorkspace[conversation.id] || 'recent') === group ? index : -1).filter(index => index >= 0);
      const sorted = slots.map(index => conversations[index]).sort((first, second) => (ranks.get(first.id) ?? -1) - (ranks.get(second.id) ?? -1));
      slots.forEach((slot, index) => { conversations[slot] = sorted[index]; });
    }
    conversations.sort((left, right) => Number(Boolean(meta.pinned[right.id])) - Number(Boolean(meta.pinned[left.id])));
    return { conversations: conversations.slice(offset, offset + limit).map(conversation => this.summary(conversation, meta, true)),
      query, nextOffset: conversations.length > offset + limit ? offset + limit : null };
  }
  workbench(device) {
    const meta = this.manager.workspaces.sessionMeta();
    const entries = [...this.manager.items.values()]
      .filter(conversation => this.allowed(device, conversation, meta))
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
    const active = [], recent = [];
    for (const conversation of entries) {
      const activity = this.manager.activity(conversation.id);
      const backgroundTaskCount = (this.manager.backgroundStatus?.(conversation.id)?.tasks || []).filter(task => task?.id).length;
      const running = ['running', 'permission', 'question'].includes(activity) || backgroundTaskCount > 0;
      if (!running && recent.length >= 10) continue;
      const summary = this.summary(conversation, meta);
      // Home never needs transcripts, file previews, task commands or stream counters.
      const { id, title, engine, model, modelName, workspaceName, updatedAt } = summary;
      (running ? active : recent).push({ id, title, engine, model, modelName, workspaceName, updatedAt, activity, backgroundTaskCount });
    }
    const conversations = [...active, ...recent];
    const listVersion = createHash('sha256').update(JSON.stringify(conversations)).digest('hex');
    return { conversations, listVersion };
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
  snapshot(device, id, before, previousHistoryVersion) {
    const conversation = this.manager.items.get(id);
    if (!conversation || !this.readable(device, conversation)) fail(404, 'Conversation not found');
    const state = this.conversationState(device, conversation);
    const permission = state.permission;
    const info = this.manager.remoteHistoryRows && this.manager.historyInfo(conversation);
    const transcript = info ? [] : (this.manager.rows ? this.manager.rows(conversation) : this.manager.messages(conversation))
      .filter(row => !row.internal && ['user', 'assistant', 'notice', 'tool'].includes(row.role));
    const rows = transcript.filter(row => before === undefined || row.seq < before);
    const historyVersion = createHash('sha256').update(JSON.stringify(info
      ? [info.generation, info.source] : transcript)).digest('hex');
    const unchanged = before === undefined && (previousHistoryVersion === null || previousHistoryVersion === historyVersion);
    const build = () => {
      const messages = []; let size = 0, older = false;
      const source = info ? this.manager.remoteHistoryRows(conversation, before) : rows.slice(-200).reverse();
      for (const row of source) {
        if (messages.length === 200) { older = true; break; }
        const selected = message(this.manager.withRequestUsage?.(conversation, row) || row);
        size += selected.text.length + JSON.stringify(selected.process || []).length
          + JSON.stringify(selected.visualizations || []).length;
        if (messages.length && size > 1024 * 1024) { older = true; break; }
        messages.unshift(selected);
      }
      return { messages, nextBefore: older || !info && rows.length > messages.length ? messages[0]?.seq ?? null : null };
    };
    const saved = unchanged ? {} : info ? this.manager.historyStore.projection(id, 'remote:' + (before ?? 'latest'), build) : build();
    const { messages, nextBefore } = saved;
    const active = this.manager.recovering.get(id) || this.manager.active.get(id);
    const output = active?.events?.length ? projectOutput(active.events) : null;
    const live = !before && active && !active.internal ? { runId: active.facade.gen, eventSeq: active.eventSeq,
      startedAt: active.startedAt, userSeq: active.userSeq, ...text(output ? output.text : active.text || active.assistant.join('\n\n')),
      ...(output?.process.length ? { process: output.process } : {}),
      pendingApprovals: active.permissions.size, approvals: permission === 'control' ? [...active.permissions.values()].map(approval) : [] } : null;
    const goal = this.manager.goalFor?.(id)?.view();
    const selected = active?.settings || this.manager.settings(conversation.currentEngine, id);
    const pressure = this.manager.contextPressure?.(conversation, conversation.currentEngine, selected, active);
    const compaction = before === undefined ? this.currentCompaction(conversation, active, transcript, info) : null;
    const start = this.manager.controlStarts?.get(id);
    const subagents = boundedSubtasks((this.manager.subagentView?.(id) || []).filter(task => !task.managedConversationId
      || this.manager.items.has(task.managedConversationId) && this.allowed(device, this.manager.items.get(task.managedConversationId))).map(task => {
      const { artifacts, approvals, ...rest } = task;
      return { ...rest, approvals: permission === 'control' ? approvals : [],
        pendingApprovals: approvals.length, canReply: permission === 'control' && task.canReply,
        canStop: permission === 'control' && task.canStop };
    }));
    return { conversation: this.summary(conversation), historyVersion, ...(unchanged ? {} : { messages, nextBefore }), live, permission,
      canRestore: this.canRestore(device, conversation),
      ...(state.archived ? { archived: state.archived } : {}),
      subagents,
      preparation: start && !start.cancelled && typeof start.startId === 'string' ? { startId: start.startId } : null,
      compaction,
      ...(pressure ? { context: { used: Math.max(0, Math.round(pressure.used)), cap: pressure.cap, source: pressure.source,
        compacting: compaction?.state === 'running', compactionState: compaction?.state || '' } } : {}),
      ...(permission === 'control' && this.manager.remoteQueue
        ? this.manager.remoteQueue.snapshot(id, { redactAttachments: true }) : {}),
      queueSteering: permission === 'control' && goal?.id && goal.armed && goal.phase === 'active'
        ? { goalId: goal.id } : null,
      automation: { goal: mobileGoal(goal, transcript, info),
        tasks: (this.manager.tasks?.list(id) || []).map(task => ({ id: task.id, instruction: String(task.instruction || '').slice(0, 500), status: task.status, state: task.state, intervalMinutes: task.intervalMinutes, lastResult: String(task.lastResult || '').slice(0, 600) })) },
      ...(permission === 'control' ? { settings: settingsView(this.manager, conversation) } : {}),
      };
  }
}

module.exports = { RemoteReadModel };
