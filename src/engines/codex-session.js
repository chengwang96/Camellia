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
    this.children = new Map();
    this.childReads = new Set();
  }
  start(waitFor) {
    this.starting = Promise.resolve(waitFor).then(() => {
      if (this.dead) throw new Error('Codex startup canceled');
      this.client = new CodexClient({ ...this.spec, spawnProcess: this.spawn, log: this.log,
        onNotification: (method, params) => this.notify(method, params),
        onRequest: request => this.requestApproval(request),
        onClose: error => {
          this.dead = true; clearTimeout(this.childTimer);
          for (const [id, task] of this.children) this.childUpdate(id, { canReply: false, canStop: false, approvals: [],
            ...(['starting', 'running', 'waiting'].includes(task.status) ? { status: 'unavailable' } : {}) });
          this.finish({ subtype: this.cancelled ? 'stopped' : 'error', is_error: !this.cancelled, result: error.message });
        },
      });
      return this.client.ready;
    });
    this.starting.catch(() => {});
  }
  async open() {
    await this.starting;
    const sourceId = this.opts.sessionId;
    const params = { cwd: this.settings.cwd, model: this.spec.model || this.settings.model,
      ...(this.spec.discussionInstructions ? { baseInstructions: this.spec.discussionInstructions } : {}),
      ...(this.spec.developerInstructions ? { developerInstructions: this.spec.developerInstructions } : {}),
      ...(this.settings.connection === 'subscription' ? { serviceTier: this.settings.serviceTier || null } : {}),
      ...(this.opts.goalBridge ? { config: { 'mcp_servers.camellia_goals': this.opts.goalBridge.config } } : {}),
      modelProvider: this.settings.connection === 'api' ? 'camellia' : 'openai',
      ...PERMISSIONS[permissionModeOf(this.settings)],
      ...((this.settings.permissionMode || 'default') === 'default' ? this.spec.permissions : {}) };
    const result = await this.client.request(sourceId ? this.opts.fork ? 'thread/fork' : 'thread/resume' : 'thread/start',
      { ...params, ...(sourceId ? { threadId: sourceId, ...(this.opts.lastTurnId ? { lastTurnId: this.opts.lastTurnId } : {}) } : { allowProviderModelFallback: false }) });
    if (this.opts.lastTurnId && result.thread.turns?.at(-1)?.id !== this.opts.lastTurnId)
      throw new Error('Codex could not restore the selected turn boundary. Update the Codex runtime before retrying. Nothing was sent.');
    this.sessionId = result.thread.id;
    this.lastTurnId = result.thread.turns?.at(-1)?.id || null;
    this.threadTurns = result.thread.turns || [];
    if (!validSessionId(this.sessionId)) throw new Error('Codex returned an invalid thread ID');
    if (this.opts.fork && !this.opts.lastTurnId) {
      const source = this.history.find(sourceId);
      if (source) fs.copyFileSync(source, this.historyFile());
    }
    this.onSessionId(this.sessionId);
  }
  async editBoundary(prompt) {
    await (this.ready ||= this.open());
    // The process can have completed many Goal turns since open(). Query the
    // persisted thread instead of matching against that stale initial snapshot.
    const result = await this.client.request('thread/read', { threadId: this.sessionId, includeTurns: true });
    const turns = result.thread?.turns || [];
    const latest = turns.at(-1);
    const users = latest?.items?.filter(item => item.type === 'userMessage') || [];
    const text = users[0]?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
    if (users.length !== 1 || !text || text.includes('Conversation context from earlier turns follows as JSON data.')
        || !(text === prompt || text.endsWith('\n\n' + prompt))) return null;
    return turns.at(-2)?.id || null;
  }
  sendUserMessage(prompt, attachments = []) {
    if (this.running || this.dead) return false;
    this.running = true; this.cancelled = false; this.prompt = prompt; this.text = '';
    this.replayEvents = []; this.blockIndex = 0; this.activeBlock = null;
    this.outputBlocks = []; this.outputItems = new Map(); this.lastOutputItem = null;
    this.turnId = null; this.items = new Map(); this.startedAt = Date.now(); this.usage = null;
    void this.run(prompt, attachments); return true;
  }
  compact({ onProgress = () => {}, timeoutMs = 120000 } = {}) {
    if (this.running || this.dead) return Promise.reject(new Error('Codex is busy or unavailable'));
    this.running = true; this.cancelled = false; this.turnId = null;
    const done = new Promise((resolve, reject) => {
      this.compaction = { resolve, reject, onProgress, timer: setTimeout(() => {
        this.finish({ subtype: 'error', is_error: true, result: 'Codex context compaction timed out; the original thread is retained.' });
        void this.kill();
      }, timeoutMs) };
    });
    const operation = this.compaction;
    void (async () => {
      try {
        await (this.ready ||= this.open());
        if (this.compaction !== operation) return;
        if (this.cancelled) { this.finish({ subtype: 'stopped' }); return; }
        await this.usageMeter?.begin(this.sessionId, () => this.compaction === operation && !this.dead && !this.cancelled);
        if (this.compaction !== operation) return;
        if (this.cancelled) { this.finish({ subtype: 'stopped' }); return; }
        await this.client.request('thread/compact/start', { threadId: this.sessionId });
      } catch (error) {
        if (this.compaction !== operation) return;
        this.finish({ subtype: this.cancelled ? 'stopped' : 'error', is_error: !this.cancelled,
          result: error.message, code: error.code });
        if (error.code !== -32601) void this.kill();
      }
    })();
    return done;
  }
  async run(prompt, attachments) {
    try {
      await (this.ready ||= this.open());
      if (this.usageMeter) await this.usageMeter.begin(this.sessionId, () => this.running && !this.dead && !this.cancelled);
      if (!this.running) return;
      this.emit({ type: 'system', subtype: 'init', session_id: this.sessionId, editBaseTurnId: this.lastTurnId });
      if (this.cancelled) return this.finish({ subtype: 'stopped' });
      this.appendHistory('user', prompt); this.emitStream({ type: 'message_start' });
      const input = [{ type: 'text', text: prompt }, ...attachments.filter(a => a.isImage).map(a => ({ type: 'localImage', path: a.path }))];
      const params = { threadId: this.sessionId, input, model: this.spec.model || this.settings.model };
      // Explicit null clears the previous thread tier when the toggle is off.
      if (this.settings.connection === 'subscription') params.serviceTier = this.settings.serviceTier || null;
      if (this.settings.thinkingBudget) params.effort = this.settings.thinkingBudget;
      if (this.settings.permissionMode === 'plan') params.collaborationMode = { mode: 'plan', settings: {
        model: this.spec.model || this.settings.model, reasoning_effort: this.settings.thinkingBudget || null, developer_instructions: null } };
      const result = await this.client.request('turn/start', params);
      if (this.running) { this.turnId = result.turn.id; this.lastTurnId = result.turn.id; if (this.cancelled) this.interrupt(); }
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
      const output = type === 'text' ? this.outputItems?.get(id) : null;
      if (output) output.indices.push(this.activeBlock.index);
      this.emitStream({ type: 'content_block_start', index: this.activeBlock.index,
        content_block: { type, ...(output ? { phase: output.phase || 'commentary' } : {}) } });
    }
    this.emitStream({ type: 'content_block_delta', index: this.activeBlock.index,
      delta: type === 'text' ? { type: 'text_delta', text } : { type: 'thinking_delta', thinking: text } });
  }
  outputItem(id, phase, kind) {
    let output = this.outputItems.get(id);
    if (!output) {
      output = { type: 'text', text: '', phase: phase || null, kind: kind || null, indices: [] };
      this.outputItems.set(id, output); this.outputBlocks.push(output);
    } else {
      if (phase) output.phase = phase;
      if (kind) output.kind = kind;
    }
    this.lastOutputItem = output;
    return output;
  }
  finish(result) {
    if (!this.running) return;
    if (this.compaction) {
      const operation = this.compaction;
      void this.usageMeter?.end(result);
      this.compaction = null; this.running = false;
      clearTimeout(operation.timer); clearTimeout(this.cancelTimer);
      if (result.subtype === 'success' && !result.is_error && !this.cancelled) operation.resolve({ ok: true });
      else operation.reject(Object.assign(new Error(result.result || 'Codex compaction canceled'), { code: result.code }));
      return;
    }
    if (this.autoCompacting) {
      this.autoCompacting = false;
      this.emit({ type: 'gui:compaction', state: this.cancelled ? 'cancelled' : 'failed' });
    }
    if (this.outputBlocks) {
      const success = result.subtype === 'success' && !result.is_error && !this.cancelled;
      const hasFinalAnswer = this.outputBlocks.some(block => block.text && block.phase === 'final_answer');
      const outputBlocks = this.outputBlocks.filter(block => block.text).map(block => {
        const terminalAgentMessage = success && !hasFinalAnswer && block === this.lastOutputItem && block.kind === 'agentMessage';
        const phase = terminalAgentMessage ? 'final_answer'
          : block.phase || (success && block === this.lastOutputItem ? 'final_answer' : 'commentary');
        for (const index of block.indices) this.emit({ type: 'gui:message-phase', index, phase });
        return { type: 'text', text: block.text, phase };
      });
      this.text = outputBlocks.filter(block => block.phase === 'final_answer').map(block => block.text).join('\n\n');
      result = { ...result, outputBlocks };
    }
    const childPermissions = [...this.permissions].filter(([, request]) => this.children.has(request.params.threadId));
    super.finish(result);
    for (const [id, request] of childPermissions) this.permissions.set(id, request);
    if (!this.running) {
      this.outputItems?.clear();
      this.outputBlocks = [];
      this.lastOutputItem = null;
    }
  }
  notify(method, params) {
    if (this.dead) return;
    if (method === 'thread/started') {
      const thread = params.thread, source = thread?.source?.subAgent || thread?.source?.subagent;
      const parent = source?.thread_spawn?.parent_thread_id;
      if (parent === this.sessionId || this.children.has(parent)) this.childUpdate(thread.id, {
        parentId: parent, title: thread.name || thread.agentNickname || thread.agentRole || undefined, status: 'starting' });
    }
    if (params.threadId !== this.sessionId && this.children.has(params.threadId)) {
      const id = params.threadId;
      if (method === 'turn/started') this.childUpdate(id, { turnId: params.turn.id, status: 'running' });
      if (method === 'turn/completed') this.childUpdate(id, { status: params.turn.status === 'completed' ? 'completed' : params.turn.status === 'interrupted' ? 'stopped' : 'failed', canStop: false, progress: params.turn.error?.message || undefined });
      if (method === 'item/agentMessage/delta') this.childUpdate(id, { progress: ((this.children.get(id)?.progress || '') + params.delta).slice(-16000) });
      return;
    }
    if (!this.running || params.threadId !== this.sessionId) return;
    // Resume/fork can replay the previous turn's usage while a new turn opens.
    // It is historical context, not consumption caused by this prompt.
    if (method === 'thread/tokenUsage/updated' && params.turnId && params.turnId !== this.turnId) return;
    if (method === 'thread/tokenUsage/updated') this.usageMeter?.codex(params.tokenUsage);
    if (method === 'model/rerouted') {
      this.usageMeter?.reroute(params.toModel);
      if (this.spec.discussionInstructions && params.toModel !== this.settings.model) {
        this.interrupt(); this.finish({ subtype: 'error', is_error: true, result: 'The provider changed the discussion model. Add a member with the available model explicitly.' });
        return;
      }
    }
    if (method === 'item/started' && /collab/i.test(params.item?.type || '')) this.usageMeter?.incomplete();
    if (this.compaction) {
      if (method === 'turn/started') { this.turnId = params.turn.id; if (this.cancelled) this.interrupt(); }
      else if (['item/started', 'item/completed'].includes(method) && params.item?.type === 'contextCompaction') {
        this.compaction.onProgress({ state: 'running' });
      } else if (method === 'turn/completed') {
        this.finish({ subtype: params.turn.status === 'completed' ? 'success' : params.turn.status === 'interrupted' ? 'stopped' : 'error',
          result: params.turn.error?.message });
      }
      return;
    }
    if (method === 'turn/started') { this.turnId = params.turn.id; this.lastTurnId = params.turn.id; if (this.cancelled) this.interrupt(); }
    else if (method === 'item/agentMessage/delta' || method === 'item/plan/delta') {
      const kind = method === 'item/plan/delta' ? 'plan' : 'agentMessage';
      const output = this.outputItem(params.itemId, kind === 'plan' ? 'commentary' : null, kind);
      output.text += params.delta;
      this.items.set(params.itemId, true); this.textDelta(params.itemId, 'text', params.delta);
    } else if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      this.textDelta(params.itemId, 'thinking', params.delta);
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = params.item, complete = method === 'item/completed';
      if (item.type === 'collabAgentToolCall') {
        for (const id of new Set([...(item.receiverThreadIds || []), ...Object.keys(item.agentsStates || {})])) {
          const state = item.agentsStates?.[id], statuses = { pendingInit: 'starting', running: 'running', completed: 'completed', errored: 'failed', interrupted: 'stopped', shutdown: 'stopped', notFound: 'unavailable' };
          this.childUpdate(id, { parentId: item.senderThreadId || this.sessionId, ...(item.tool === 'spawnAgent' ? { goal: item.prompt || '' } : {}),
            ...(state ? { status: statuses[state.status] || 'unavailable', progress: state.message || '',
              ...(state.status === 'completed' ? { result: state.message || '' } : {}) } : {}) });
        }
      } else if (item.type === 'subAgentActivity') this.childUpdate(item.agentThreadId, { title: item.agentPath,
        status: item.kind === 'interrupted' ? 'stopped' : item.kind === 'completed' ? 'completed' : 'running',
        ...(['completed', 'interrupted'].includes(item.kind) ? { canStop: false } : {}) });
      if (['agentMessage', 'plan'].includes(item.type)) {
        const output = this.outputItem(item.id, item.type === 'plan' ? 'commentary' : item.phase, item.type);
        if (complete && !this.items.has(item.id)) {
          output.text = item.text || ''; this.textDelta(item.id, 'text', item.text);
        }
        if (complete) {
          if (output.phase) for (const index of output.indices) this.emit({ type: 'gui:message-phase', index, phase: output.phase });
          this.endBlock();
        }
      } else if (item.type === 'contextCompaction') {
        this.autoCompacting = !complete;
        this.emit({ type: 'gui:compaction', state: complete ? 'completed' : 'running' });
      } else if (!['userMessage', 'reasoning'].includes(item.type)) {
        this.lastOutputItem = null;
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
        ...(!failed && turn.id === this.turnId ? { nativeContextRetained: true } : {}),
        is_error: failed, ...(failed ? { result: turn.error?.message || 'Codex turn failed' } : {}),
        ...(this.usage ? { usage: this.usage } : {}) });
    }
  }
  requestApproval(request) {
    const { method, params, id } = request;
    const child = this.children.get(params.threadId);
    if (this.compaction && !child) {
      this.client.write({ id, error: { code: -32600, message: 'Interactions are unavailable during compaction' } }); return;
    }
    if ((!child && (!this.running || params.threadId !== this.sessionId || this.cancelled)) || this.dead) {
      this.client.write({ id, error: { code: -32600, message: 'No active turn' } }); return;
    }
    const requestId = String(id);
    if (method === 'item/tool/requestUserInput') {
      this.permissions.set(requestId, request);
      const event = { type: 'gui:permission', requestId, toolName: 'Codex needs your input', questions: params.questions };
      if (child) this.childApproval(child.id, event); else this.emit(event);
      return;
    }
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(method)) {
      this.client.write({ id, error: { code: -32601, message: 'This interaction is not supported by Camellia' } }); return;
    }
    this.permissions.set(requestId, request);
    const event = { type: 'gui:permission', requestId, toolName: method.split('/')[1], input: params,
      options: [{ optionId: 'accept', kind: 'allow_once', name: 'Allow once' }, { optionId: 'decline', kind: 'reject_once', name: 'Deny' }] };
    if (child) this.childApproval(child.id, event); else this.emit(event);
  }
  answerPermission(requestId, allow, input, _message, optionId) {
    const request = this.permissions.get(requestId);
    if (!request || this.dead) return false;
    const approved = optionId ? optionId === 'accept' : allow;
    let result;
    if (request.method === 'item/tool/requestUserInput') {
      result = { answers: Object.fromEntries(request.params.questions.map(q => {
        const value = input?.[q.id];
        const answers = approved ? (Array.isArray(value) ? value : [value]).filter(answer => typeof answer === 'string' && answer.trim()) : [];
        if (approved && !answers.length) throw new Error('Answer each question before submitting');
        return [q.id, { answers }];
      })) };
    } else if (request.method === 'item/permissions/requestApproval') result = { permissions: approved ? request.params.permissions : {}, scope: 'turn' };
    else result = { decision: approved ? 'accept' : 'decline' };
    this.client.write({ id: request.id, result }); this.permissions.delete(requestId);
    const child = this.children.get(request.params.threadId);
    if (child) {
      const approvals = (child.approvals || []).filter(event => event.requestId !== requestId);
      this.childUpdate(child.id, { approvals, status: approvals.length ? 'waiting' : 'running' });
    }
    this.replayEvents = (this.replayEvents || []).filter(e => e.type !== 'gui:permission' || e.requestId !== requestId);
    return true;
  }
  interrupt() {
    if (!this.running || this.dead) return;
    this.cancelled = true;
    for (const [id, request] of this.permissions) if (request.params.threadId === this.sessionId) this.answerPermission(id, false);
    if (this.turnId) void this.client.request('turn/interrupt', { threadId: this.sessionId, turnId: this.turnId })
      .catch(error => { this.log('Codex: ' + error.message); this.kill(); });
    clearTimeout(this.cancelTimer); this.cancelTimer = setTimeout(() => this.kill(), 8000);
  }
  kill() {
    this.dead = true;
    clearTimeout(this.childTimer);
    for (const id of this.children.keys()) this.childUpdate(id, { canReply: false, canStop: false,
      ...(['starting', 'running', 'waiting'].includes(this.children.get(id).status) ? { status: 'unavailable' } : {}) });
    this.finish({ subtype: this.cancelled ? 'stopped' : 'error', is_error: !this.cancelled, result: 'Codex process stopped' });
    return this.client?.shutdown();
  }
  async shutdown() { if (this.running) this.cancelled = true; await this.kill(); await this.usageMeter?.flush(); }
  childUpdate(id, update) {
    if (typeof id !== 'string' || !id || id === this.sessionId) return;
    const previous = this.children.get(id);
    const child = require('../shared/subagents').mergeTask(previous, { ...update, id }, { engine: 'codex' });
    if (!child) return;
    if (previous && JSON.stringify({ ...previous, updatedAt: 0 }) === JSON.stringify({ ...child, updatedAt: 0 })) return;
    this.children.set(id, child);
    if (update.status && update.status !== previous?.status) this.childReads.add(id);
    this.emit({ type: 'gui:subagent', task: child });
    if (!this.childTimer && !this.childPolling && !this.dead) { this.childTimer = setTimeout(() => this.pollChildren(), 2000); this.childTimer.unref?.(); }
  }
  childApproval(id, event) {
    const child = this.children.get(id), approvals = (child.approvals || []).filter(row => row.requestId !== event.requestId);
    approvals.push({ ...event, subagentId: id }); this.childUpdate(id, { approvals, status: 'waiting' });
  }
  async pollChildren() {
    this.childTimer = null;
    if (this.dead) return;
    this.childPolling = true;
    for (const child of this.children.values()) {
      if (!['starting', 'running', 'waiting'].includes(child.status) && !this.childReads.has(child.id)) continue;
      this.childReads.delete(child.id);
      try {
        const { thread } = await this.client.request('thread/read', { threadId: child.id, includeTurns: true }, 8000);
        if (this.dead || !this.children.has(child.id)) break;
        if (this.children.get(child.id) !== child) { this.childReads.add(child.id); continue; }
        const turn = thread.turns?.at(-1), items = turn?.items || [];
        const messages = items.filter(item => item.type === 'agentMessage');
        const history = items.slice(-40).map(item => ({ type: item.type, text: item.text || item.command || item.aggregatedOutput || (item.changes || []).map(file => file.path).join('\n') }));
        const artifacts = items.flatMap(item => item.type === 'fileChange' ? (item.changes || []).map(file => ({ path: file.path })) : []);
        const waiting = (child.approvals || []).length || (thread.status?.activeFlags || []).some(flag => ['waitingOnApproval', 'waitingOnUserInput'].includes(flag));
        const status = waiting ? 'waiting' : turn?.status === 'inProgress' ? 'running' : turn?.status === 'completed' ? 'completed'
          : turn?.status === 'interrupted' ? 'stopped' : turn?.status === 'failed' ? 'failed' : child.status;
        this.childUpdate(child.id, { title: thread.name || thread.agentNickname || child.title, turnId: turn?.id || child.turnId,
          progress: messages.at(-1)?.text || child.progress, ...(status === 'completed' ? { result: messages.filter(item => item.phase === 'final_answer').map(item => item.text).join('\n\n') || messages.at(-1)?.text || child.result } : {}),
          status, history, artifacts, canReply: thread.canAcceptDirectInput === true, canStop: turn?.status === 'inProgress' });
      } catch (error) { this.childReads.add(child.id); this.log('Codex child status: ' + error.message); }
    }
    this.childPolling = false;
    if (!this.dead && (this.childReads.size || [...this.children.values()].some(child => ['starting', 'running', 'waiting'].includes(child.status)))) {
      clearTimeout(this.childTimer); this.childTimer = setTimeout(() => this.pollChildren(), 3000); this.childTimer.unref?.();
    }
  }
  async controlChild(id, { operation, prompt, expectedTurnId, approvalId, response }) {
    const child = this.children.get(id);
    if (!child || this.dead) throw new Error('This subtask is no longer connected');
    if (operation === 'approve') {
      const request = this.permissions.get(approvalId);
      if (!request || request.params.threadId !== id || !this.answerPermission(approvalId, response.allow, response.input, '', response.optionId)) throw new Error('The subtask request changed');
      return;
    }
    if (!child.turnId || child.turnId !== expectedTurnId) throw new Error('The subtask changed; refresh before responding');
    if (operation === 'stop') {
      if (!child.canStop) throw new Error('This subtask is not running');
      await this.client.request('turn/interrupt', { threadId: id, turnId: child.turnId });
    } else if (operation === 'reply') {
      if (!child.canReply || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32000) throw new Error('Direct input is unavailable for this subtask');
      await this.client.request(child.canStop ? 'turn/steer' : 'turn/start', { threadId: id,
        input: [{ type: 'text', text: prompt, text_elements: [] }], ...(child.canStop ? { expectedTurnId: child.turnId } : {}) });
      this.childUpdate(id, { status: 'running', progress: prompt, canStop: false });
    } else throw new Error('Unsupported subtask action');
  }
}

module.exports = { CodexSession, PERMISSIONS };
