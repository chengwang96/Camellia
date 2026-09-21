'use strict';

const fs = require('node:fs');
const { CodexClient } = require('./codex-client');
const { StreamingSession } = require('./streaming-session');
const { validSessionId } = require('./claude-history');

const PERMISSIONS = {
  default: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
  acceptEdits: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  plan: { approvalPolicy: 'never', sandbox: 'read-only' },
  bypassPermissions: { approvalPolicy: 'never', sandbox: 'danger-full-access' },
};
// Universal levels reuse the closest native combination.
const LEVEL_MODES = { ask: 'default', auto: 'acceptEdits', full: 'bypassPermissions' };
const permissionModeOf = settings => LEVEL_MODES[settings.permissionMode] || settings.permissionMode || 'default';

class CodexSession extends StreamingSession {
  constructor(options) {
    super(); Object.assign(this, options);
    this.name = 'Codex'; this.sessionId = null; this.running = false; this.dead = false;
    this.permissions = new Map(); this.eventSeq = 0;
  }
  start(waitFor) {
    this.starting = Promise.resolve(waitFor).then(() => {
      if (this.dead) throw new Error('Codex startup canceled');
      this.client = new CodexClient({ ...this.spec, spawnProcess: this.spawn, log: this.log,
        onNotification: (method, params) => this.notify(method, params),
        onRequest: request => this.requestApproval(request),
        onClose: error => { this.dead = true; this.finish({ subtype: this.cancelled ? 'stopped' : 'error', is_error: !this.cancelled, result: error.message }); },
      });
      return this.client.ready;
    });
    this.starting.catch(() => {});
  }
  async open() {
    await this.starting;
    const sourceId = this.opts.sessionId;
    const params = { cwd: this.settings.cwd, model: this.settings.model,
      ...(this.opts.goalBridge ? { config: { 'mcp_servers.camellia_goals': this.opts.goalBridge.config } } : {}),
      modelProvider: this.settings.connection === 'api' ? 'camellia' : 'openai',
      ...PERMISSIONS[permissionModeOf(this.settings)],
      ...(permissionModeOf(this.settings) === 'default' ? this.spec.permissions : {}) };
    const result = await this.client.request(sourceId ? this.opts.fork ? 'thread/fork' : 'thread/resume' : 'thread/start',
      { ...params, ...(sourceId ? { threadId: sourceId } : { allowProviderModelFallback: false }) });
    this.sessionId = result.thread.id;
    if (!validSessionId(this.sessionId)) throw new Error('Codex returned an invalid thread ID');
    if (this.opts.fork) {
      const source = this.history.find(sourceId);
      if (source) fs.copyFileSync(source, this.historyFile());
    }
    this.onSessionId(this.sessionId);
  }
  sendUserMessage(prompt, attachments = []) {
    if (this.running || this.dead) return false;
    this.running = true; this.cancelled = false; this.prompt = prompt; this.text = '';
    this.replayEvents = []; this.blockIndex = 0; this.activeBlock = null;
    this.turnId = null; this.items = new Map(); this.startedAt = Date.now(); this.usage = null;
    void this.run(prompt, attachments); return true;
  }
  async run(prompt, attachments) {
    try {
      await (this.ready ||= this.open());
      this.emit({ type: 'system', subtype: 'init', session_id: this.sessionId });
      if (this.cancelled) return this.finish({ subtype: 'stopped' });
      this.appendHistory('user', prompt); this.emitStream({ type: 'message_start' });
      const input = [{ type: 'text', text: prompt }, ...attachments.filter(a => a.isImage).map(a => ({ type: 'localImage', path: a.path }))];
      const params = { threadId: this.sessionId, input, model: this.settings.model };
      if (this.settings.thinkingBudget) params.effort = this.settings.thinkingBudget;
      if (this.settings.permissionMode === 'plan') params.collaborationMode = { mode: 'plan', settings: {
        model: this.settings.model, reasoning_effort: this.settings.thinkingBudget || null, developer_instructions: null } };
      const result = await this.client.request('turn/start', params);
      if (this.running) { this.turnId = result.turn.id; if (this.cancelled) this.interrupt(); }
    } catch (error) {
      this.finish({ subtype: this.cancelled ? 'stopped' : 'error', is_error: !this.cancelled, result: error.message });
      this.kill();
    }
  }
  async steerUserMessage(prompt, attachments = []) {
    if (!this.running || this.dead || this.cancelled || !this.turnId) throw new Error('The active turn is not ready or has already finished. Your message was not sent.');
    const turnId = this.turnId;
    const result = await this.client.request('turn/steer', {
      threadId: this.sessionId, expectedTurnId: turnId,
      input: [{ type: 'text', text: prompt }, ...attachments.filter(attachment => attachment.isImage).map(attachment => ({ type: 'localImage', path: attachment.path }))],
    });
    if (result?.turnId !== turnId) throw new Error('The engine did not confirm the expected turn. Check the conversation before retrying.');
    this.appendHistory('user', prompt);
    return { turnId };
  }
  textDelta(id, type, text) {
    if (!text) return;
    if (type === 'text') this.text += text;
    if (this.activeBlock?.id !== id || this.activeBlock.type !== type) {
      this.endBlock(); this.activeBlock = { id, type, index: this.blockIndex++ };
      this.emitStream({ type: 'content_block_start', index: this.activeBlock.index, content_block: { type } });
    }
    this.emitStream({ type: 'content_block_delta', index: this.activeBlock.index,
      delta: type === 'text' ? { type: 'text_delta', text } : { type: 'thinking_delta', thinking: text } });
  }
  notify(method, params) {
    if (!this.running || params.threadId !== this.sessionId) return;
    if (method === 'turn/started') { this.turnId = params.turn.id; if (this.cancelled) this.interrupt(); }
    else if (method === 'item/agentMessage/delta' || method === 'item/plan/delta') {
      this.items.set(params.itemId, true); this.textDelta(params.itemId, 'text', params.delta);
    } else if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      this.textDelta(params.itemId, 'thinking', params.delta);
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = params.item, complete = method === 'item/completed';
      if (['agentMessage', 'plan'].includes(item.type)) {
        if (complete && !this.items.has(item.id)) this.textDelta(item.id, 'text', item.text);
        if (complete) this.endBlock();
      } else if (!['userMessage', 'reasoning'].includes(item.type)) {
        this.endBlock();
        const output = item.aggregatedOutput ?? item.result ?? item.contentItems ?? (item.changes && item.changes.map(c => c.path + '\n' + c.diff).join('\n'));
        const failed = Boolean(item.error || ['failed', 'declined'].includes(item.status) || item.exitCode);
        this.emit({ type: 'gui:tool', id: item.id, name: item.tool || item.type,
          input: item.command ? { command: item.command, cwd: item.cwd } : item.arguments || item,
          output: typeof output === 'string' ? output : output ? JSON.stringify(output, null, 2) : '',
          status: complete ? failed ? 'failed' : 'completed' : 'in_progress', is_error: failed });
      }
    } else if (method === 'turn/plan/updated') {
      this.emit({ type: 'gui:plan', entries: params.plan.map(p => ({ content: p.step, status: p.status === 'inProgress' ? 'in_progress' : p.status })) });
    } else if (method === 'thread/tokenUsage/updated') {
      const usage = params.tokenUsage?.last;
      if (!usage) return;
      this.usage = { input_tokens: Math.max(0, usage.inputTokens - (usage.cachedInputTokens || 0)),
        cache_read_input_tokens: usage.cachedInputTokens || 0, output_tokens: usage.outputTokens,
        ...(params.tokenUsage.modelContextWindow ? { context_window: params.tokenUsage.modelContextWindow } : {}) };
      this.emit({ type: 'gui:usage', usage: this.usage });
    }
    else if (method === 'turn/completed') {
      const turn = params.turn, failed = turn.status === 'failed';
      this.finish({ subtype: this.cancelled || turn.status === 'interrupted' ? 'stopped' : failed ? 'error' : 'success',
        is_error: failed, ...(failed ? { result: turn.error?.message || 'Codex turn failed' } : {}),
        ...(this.usage ? { usage: this.usage } : {}) });
    }
  }
  requestApproval(request) {
    const { method, params, id } = request;
    if (!this.running || params.threadId !== this.sessionId || this.cancelled) {
      this.client.write({ id, error: { code: -32600, message: 'No active turn' } }); return;
    }
    const requestId = String(id);
    if (method === 'item/tool/requestUserInput') {
      this.permissions.set(requestId, request);
      this.emit({ type: 'gui:permission', requestId, toolName: 'Codex needs your input', questions: params.questions });
      return;
    }
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(method)) {
      this.client.write({ id, error: { code: -32601, message: 'This interaction is not supported by Camellia' } }); return;
    }
    this.permissions.set(requestId, request);
    this.emit({ type: 'gui:permission', requestId, toolName: method.split('/')[1], input: params,
      options: [{ optionId: 'accept', kind: 'allow_once', name: 'Allow once' }, { optionId: 'decline', kind: 'reject_once', name: 'Deny' }] });
  }
  answerPermission(requestId, allow, input, _message, optionId) {
    const request = this.permissions.get(requestId);
    if (!request || this.dead) return false;
    const approved = optionId ? optionId === 'accept' : allow;
    let result;
    if (request.method === 'item/tool/requestUserInput') {
      result = { answers: Object.fromEntries(request.params.questions.map(q => [q.id, { answers: approved ? [String(input?.[q.id] || '')] : [] }])) };
    } else if (request.method === 'item/permissions/requestApproval') result = { permissions: approved ? request.params.permissions : {}, scope: 'turn' };
    else result = { decision: approved ? 'accept' : 'decline' };
    this.client.write({ id: request.id, result }); this.permissions.delete(requestId);
    this.replayEvents = this.replayEvents.filter(e => e.type !== 'gui:permission' || e.requestId !== requestId);
    return true;
  }
  interrupt() {
    if (!this.running || this.dead) return;
    this.cancelled = true;
    for (const id of this.permissions.keys()) this.answerPermission(id, false);
    if (this.turnId) void this.client.request('turn/interrupt', { threadId: this.sessionId, turnId: this.turnId })
      .catch(error => { this.log('Codex: ' + error.message); this.kill(); });
    clearTimeout(this.cancelTimer); this.cancelTimer = setTimeout(() => this.kill(), 8000);
  }
  kill() {
    this.dead = true;
    this.finish({ subtype: this.cancelled ? 'stopped' : 'error', is_error: !this.cancelled, result: 'Codex process stopped' });
    return this.client?.shutdown();
  }
  async shutdown() { if (this.running) this.cancelled = true; await this.kill(); }
}

module.exports = { CodexSession, PERMISSIONS };
