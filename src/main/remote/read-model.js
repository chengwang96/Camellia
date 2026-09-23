'use strict';

const { fail } = require('./access');
const { createHash } = require('node:crypto');
const { approval } = require('./commands');
const { projectOutput, cleanProcess } = require('../../shared/mobile-output');
const { settingsView } = require('./settings');

const TEXT_LIMIT = 256 * 1024;
function text(value) {
  const source = typeof value === 'string' ? value : '';
  return { text: source.slice(-TEXT_LIMIT), textTruncated: source.length > TEXT_LIMIT };
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
  return { seq: row.seq, role: row.role, engine: row.engine, at: row.at, ...text(value), ...(process.length ? { process } : {}) };
}

class RemoteReadModel {
  constructor(manager) { this.manager = manager; }
  workspaces() {
    return this.manager.workspaces.sessionMeta().workspaces.map(({ id, name }) => ({ id, name }));
  }
  allowed(device, conversation, meta = this.manager.workspaces.sessionMeta()) {
    const workspaceId = meta.sessionWorkspace[conversation.id];
    if (meta.archived[conversation.id]) return false;
    if (!workspaceId) return device.allWorkspaces === true || device.includeUnassigned === true;
    return Boolean((device.allWorkspaces === true || device.workspaceIds.includes(workspaceId))
      && meta.workspaces.some(workspace => workspace.id === workspaceId));
  }
  conversation(device, id) {
    const conversation = this.manager.items.get(id);
    if (!conversation || !this.allowed(device, conversation)) fail(404, 'Conversation not found');
    return conversation;
  }
  summary(conversation, meta = this.manager.workspaces.sessionMeta()) {
    return { id: conversation.id, title: String(meta.titles[conversation.id] || conversation.title).slice(0, 200),
      engine: conversation.currentEngine, workspaceId: meta.sessionWorkspace[conversation.id] || null,
      workspaceName: meta.workspaces.find(workspace => workspace.id === meta.sessionWorkspace[conversation.id])?.name || null,
      updatedAt: conversation.updatedAt, seq: conversation.seq, activity: this.manager.activity(conversation.id) };
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
    return { conversations: conversations.slice(offset, offset + 100).map(conversation => this.summary(conversation, meta)),
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
    const rows = (this.manager.rows ? this.manager.rows(conversation).filter(row => !row.internal && ['user', 'assistant', 'notice', 'tool'].includes(row.role))
      : this.manager.messages(conversation)).filter(row => before === undefined || row.seq < before);
    const messages = [];
    let size = 0;
    for (const row of rows.slice(-100).reverse()) {
      const selected = message(row);
      size += selected.text.length + JSON.stringify(selected.process || []).length;
      if (messages.length && size > 512 * 1024) break;
      messages.unshift(selected);
    }
    const active = this.manager.recovering.get(id) || this.manager.active.get(id);
    const output = active?.events?.length ? projectOutput(active.events) : null;
    const live = !before && active && !active.internal ? { runId: active.facade.gen, eventSeq: active.eventSeq,
      startedAt: active.startedAt, userSeq: active.userSeq, ...text(output ? output.text : active.text || active.assistant.join('\n\n')),
      ...(output?.process.length ? { process: output.process } : {}),
      pendingApprovals: active.permissions.size, approvals: device.permission === 'control' ? [...active.permissions.values()].map(approval) : [] } : null;
    return { conversation: this.summary(conversation), messages, live, permission: device.permission,
      ...(device.permission === 'control' ? { settings: settingsView(this.manager, conversation) } : {}),
      nextBefore: rows.length > messages.length ? messages[0]?.seq ?? null : null };
  }
}

module.exports = { RemoteReadModel };
