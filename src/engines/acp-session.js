'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { jsonLines } = require('../shared/json-lines');
const { StreamingSession } = require('./streaming-session');
const { validSessionId } = require('./claude-history');
const { failedToolResult } = require('../api/tool-results');
const { nativeMode } = require('./permission-levels');
const { NativeSubagents } = require('./native-subagents');

// ACP stays at the process boundary. The renderer receives the same stream and
// session events as the other harness, never upstream keys or CLI internals.
class AcpSession extends StreamingSession {
  constructor({ gen, settings, opts, exe, spec, spawn, log, history, onEvent, onSessionId, onResult, usageMeter, name = 'Kimi' }) {
    super();
    Object.assign(this, { gen, settings, opts, exe, spec, spawn, log, history, onEvent, onSessionId, onResult, usageMeter, name });
    this.sessionId = null;
    this.running = false;
    this.dead = false;
    this.sequence = 0;
    this.pending = new Map();
    this.permissions = new Map();
    this.tools = new Map();
    this.eventSeq = 0;
    this.subagents = new NativeSubagents(spec.modeEngine || name.toLowerCase(), (task, replacesIds) => {
      for (const request of this.permissions.values()) if (replacesIds?.includes(request.subagentId)) request.subagentId = task.id;
      this.emit({ type: 'gui:subagent', task, ...(replacesIds ? { replacesIds } : {}) });
    });
    this.children = this.subagents.children;
    if (spec.modeEngine === 'kimi' && spec.env?.KIMI_CODE_HOME)
      this.childHistory = new (require('./kimi-subagents').KimiSubagents)(this, spec.env.KIMI_CODE_HOME);
  }

  start(waitFor) {
    if (waitFor) {
      this.starting = waitFor.then(() => {
        if (this.dead) throw new Error(`${this.name} startup canceled`);
        this.spawnProcess();
      });
      this.starting.catch(() => {}); // open() reports startup errors to the turn.
    } else this.spawnProcess();
  }

  spawnProcess() {
    // libuv's Windows recursive watcher can abort on 8.3 paths. Use the same
    // physical cwd for both the child process and ACP, preserving UI metadata.
    this.cwd = process.platform === 'win32' ? fs.realpathSync.native(this.settings.cwd) : this.settings.cwd;
    this.proc = this.spawn(this.exe, this.spec.args, { env: this.spec.env, cwd: this.cwd,
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.lines = jsonLines(this.proc.stdout);
    this.lines.on('data', line => {
      let message;
      try { message = JSON.parse(line); }
      catch { this.log(this.name + ': ignored a non-JSON stdout line'); return; }
      // One bad message or handler must not stop subsequent messages.
      try { this.receive(message); }
      catch (error) { this.log(this.name + ': event handling failed: ' + error.message); }
    });
    this.lines.on('error', error => this.close(error));
    this.proc.stderr.on('data', chunk => this.log(this.name + ': ' + String(chunk).trim()));
    this.proc.on('error', error => this.close(error));
    // close follows the last stdout data; exit can precede the final ACP reply.
    this.proc.on('close', code => this.close(new Error(`${this.name} process exited (${code})`)));
    this.proc.stdin.on('error', error => this.close(error));
  }

  write(message) {
    if (this.dead) throw new Error(`${this.name} process is unavailable`);
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }

  request(method, params, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = timeout ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name} request timed out: ${method}`));
      }, timeout) : null;
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  receive(message) {
    if (message.method) {
      if (message.method === 'session/update' && message.params.update?.sessionUpdate === 'available_commands_update'
          && (!this.sessionId || message.params.sessionId === this.sessionId)) {
        this.availableCommands = message.params.update.availableCommands; return;
      }
      // A native-denial notice travels on the CLI's stderr, so it can reach us
      // just after the turn ended. It still describes the turn the user watched
      // — dropping it would hide a real refusal — so let that one update through
      // after `running` clears. Nothing else is admitted late.
      const lateDenial = this.running === false && !this.dead && !this.cancelled && !this.compaction
        && message.method === 'session/update' && message.params.update?.permissionBlocked === true;
      const childUpdate = message.params?.update?.sessionUpdate === 'camellia_subagent'
        && this.children.has(this.subagents.resolve(message.params.update.task?.id));
      if (message.method === 'session/update' && message.params.sessionId === this.sessionId && (this.running || lateDenial || childUpdate)) this.update(message.params.update);
      else if (message.id !== undefined) {
        const child = message.params?._meta?.camelliaSubagentId && this.children.get(this.subagents.resolve(message.params._meta.camelliaSubagentId));
        if (message.method === 'session/request_permission' && message.params.sessionId === this.sessionId
            && (this.running || child && ['starting', 'running', 'waiting'].includes(child.status)) && !this.cancelled && !this.compaction) {
          const requestId = String(message.id);
          this.permissions.set(requestId, message);
          const tool = message.params.toolCall || {};
          const content = toolContent(tool.content);
          const event = { type: 'gui:permission', requestId, toolName: tool.title || tool.kind || '',
            input: tool.rawInput || (content ? { command: content } : tool.locations?.length ? { paths: tool.locations.map(loc => loc.path).join('\n') } : {}),
            options: message.params.options, ...(Array.isArray(message.params.questions) ? { questions: message.params.questions } : {}) };
          const nativeId = message.params._meta?.camelliaSubagentId;
          const child = nativeId && this.children.get(this.subagents.resolve(nativeId));
          if (child) {
            message.subagentId = child.id;
            this.subagents.update(child.id, { status: 'waiting', approvals: [...(child.approvals || []), { ...event, subagentId: child.id }] });
          } else this.emit(event);
        } else if (message.method === 'session/request_permission') {
          this.write({ id: message.id, result: { outcome: { outcome: 'cancelled' } } });
        } else this.write({ id: message.id, error: { code: -32601, message: 'Unsupported client method: ' + message.method } });
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code, data: message.error.data }));
    else pending.resolve(message.result);
  }

  async open() {
    await this.starting;
    const initResult = await this.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'Camellia', version: '0.3.0' } });
    this.promptCapabilities = initResult?.agentCapabilities?.promptCapabilities || {};
    const sourceId = this.opts.sessionId;
    const method = sourceId ? this.opts.fork ? 'session/fork' : 'session/resume' : 'session/new';
    const bridge = this.opts.goalBridge?.config;
    const mcpServers = bridge ? [{ name: 'camellia_goals', command: bridge.command, args: bridge.args, env: Object.entries(bridge.env).map(([name, value]) => ({ name, value })) }] : [];
    const result = await this.request(method, { ...(sourceId ? { sessionId: sourceId } : {}), cwd: this.cwd, mcpServers });
    this.sessionId = result.sessionId || sourceId;
    if (!validSessionId(this.sessionId)) throw new Error(`${this.name} returned an invalid session ID`);
    if (this.opts.fork) {
      const source = this.history.find(sourceId);
      if (source) fs.copyFileSync(source, this.historyFile());
    }
    // Resume keeps native model and permission state; always apply the
    // workbench selection explicitly, including on forks.
    let config = await this.request('session/set_config_option', { sessionId: this.sessionId, configId: 'model', value: this.spec.modelValue || this.settings.model });
    if (this.settings.thinkingBudget && this.spec.applyThinking !== false) config = await this.request('session/set_config_option', {
      sessionId: this.sessionId, configId: this.spec.thinkingId || 'thinking', value: this.spec.thinkingValue || this.settings.thinkingBudget });
    if (!this.spec.noModes) await this.request('session/set_mode', { sessionId: this.sessionId, modeId: nativeMode(this.spec.modeEngine || 'kimi', this.settings.permissionMode || 'default') });
    this.onSessionId(this.sessionId);
    this.emit({ type: 'gui:config', options: config.configOptions });
  }

  async prepareNativeStorage() {
    if (this.spec.modeEngine !== 'antigravity' || this.running || this.dead || !this.sessionId)
      throw new Error('Native preparation is unavailable');
    const result = await this.request('session/camellia_prepare', { sessionId: this.sessionId }, this.spec.prepareTimeout || 30000);
    const pattern = this.sessionId.startsWith('agy-') ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/ : /^[0-9a-f]{32}$/;
    if (this.dead || this.running || result?.sessionId !== this.sessionId || typeof result.conversationId !== 'string' || !pattern.test(result.conversationId))
      throw new Error('Native preparation returned an invalid identity');
    return result.conversationId;
  }

  sendUserMessage(prompt, attachments = []) {
    if (this.running || this.dead) return false;
    this.subagents.begin();
    this.running = true;
    this.prompt = prompt;
    this.replayEvents = [];
    this.tools.clear();
    this.cancelled = false;
    this.text = '';
    this.blockIndex = 0;
    this.activeBlock = null;
    this.startedAt = Date.now();
    void this.run(prompt, attachments);
    return true;
  }

  async run(prompt, attachments) {
    try {
      await (this.ready ||= this.open());
      if (this.childHistory) await this.childHistory.begin().catch(error => this.log('Kimi subtasks: ' + error.message));
      if (this.usageMeter) await this.usageMeter.begin(this.sessionId, () => this.running && !this.dead && !this.cancelled);
      if (!this.running) return;
      if (this.dead) throw new Error(`${this.name} process stopped`);
      this.emit({ type: 'system', subtype: 'init', session_id: this.sessionId });
      if (this.cancelled) { this.finish({ subtype: 'stopped' }); return; }
      this.appendHistory('user', prompt);
      this.emitStream({ type: 'message_start' });
      const parts = [{ type: 'text', text: prompt }];
      const imageTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
      for (const attachment of attachments) {
        const mimeType = imageTypes[path.extname(attachment.path).toLowerCase()];
        if (!attachment.isImage || !mimeType) continue;
        if (this.promptCapabilities.image !== true)
          throw new Error(`${this.name} did not advertise inline image prompts; send this message without the image or use an engine with image input.`);
        parts.push({ type: 'image', mimeType, data: fs.readFileSync(attachment.path).toString('base64') });
      }
      const response = await this.request('session/prompt', { sessionId: this.sessionId, prompt: parts }, 0);
      if (this.childHistory) await this.childHistory.poll().catch(error => this.log('Kimi subtasks: ' + error.message));
      const stopped = this.cancelled || response.stopReason === 'cancelled';
      const failed = ['refusal', 'max_tokens', 'max_turn_requests'].includes(response.stopReason);
      this.finish({ subtype: stopped ? 'stopped' : failed ? response.stopReason : 'success', is_error: failed, ...(response.usage ? { usage: response.usage } : {}) });
    } catch (error) {
      this.finish({ subtype: this.cancelled ? 'stopped' : 'error', is_error: !this.cancelled, result: error.message });
      // A failed initialization cannot be reused. Prompt errors may be retried
      // by resuming the native session in a fresh process.
      this.kill();
    }
  }

  compact({ timeoutMs = 120000 } = {}) {
    if (this.running || this.dead) return Promise.reject(new Error(`${this.name} is busy or unavailable`));
    this.running = true; this.cancelled = false; this.replayEvents = [];
    const done = new Promise((resolve, reject) => {
      this.compaction = { resolve, reject, timer: setTimeout(() => {
        this.settleCompaction(new Error(`${this.name} context compaction timed out; the original session is retained.`));
        this.kill();
      }, timeoutMs) };
    });
    const operation = this.compaction;
    void (async () => {
      try {
        await (this.ready ||= this.open());
        if (this.compaction !== operation) return;
        if (this.cancelled) throw new Error('Compaction canceled');
        if (this.spec.modeEngine !== 'kimi' || !this.availableCommands?.some(command => command.name === 'compact'))
          throw Object.assign(new Error('Native manual compaction is not advertised by this harness'), { code: -32601 });
        await this.usageMeter?.begin(this.sessionId, () => this.compaction === operation && !this.dead && !this.cancelled);
        if (this.compaction !== operation) return;
        if (this.cancelled || this.dead) throw new Error('Compaction canceled');
        const response = await this.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text: '/compact' }] }, 0);
        if (this.compaction !== operation) return;
        if (response.stopReason !== 'end_turn') throw new Error('Native compaction was not accepted: ' + response.stopReason);
        operation.accepted = true;
        if (operation.completed) this.settleCompaction();
      } catch (error) {
        if (this.compaction === operation) {
          this.settleCompaction(error);
          if (error.code !== -32601) this.kill();
        }
      }
    })();
    return done;
  }

  settleCompaction(error) {
    const operation = this.compaction;
    if (!operation) return;
    this.compaction = null; this.running = false;
    void this.usageMeter?.end({ subtype: this.cancelled ? 'stopped' : error ? 'error' : 'success', is_error: Boolean(error) });
    clearTimeout(operation.timer); clearTimeout(this.cancelTimer);
    if (error || this.cancelled) operation.reject(error || new Error('Compaction canceled'));
    else operation.resolve({ ok: true });
  }

  update(update) {
    const kind = update.sessionUpdate;
    if (kind === 'camellia_subagent') {
      if (!this.compaction && update.task) this.subagents.native(update.task.id, { ...update.task, canReply: false,
        canStop: this.spec.nativeChildControl === true && update.task.canStop === true });
      return;
    }
    const child = update._meta?.camelliaSubagentId && this.children.get(this.subagents.resolve(update._meta.camelliaSubagentId));
    if (child && ['tool_call', 'tool_call_update'].includes(kind)) {
      const detail = toolContent(update.content) || update.title || '';
      this.subagents.update(child.id, { progress: detail, history: [...(child.history || []), { type: kind, text: detail }] });
      return;
    }
    if (kind === 'camellia_usage') { this.usageMeter?.antigravityStep(update.stepId, update.usage); return; }
    if (kind === 'available_commands_update') { this.availableCommands = update.availableCommands; return; }
    if (this.compaction) {
      if (kind === 'agent_message_chunk' && update.content?.type === 'text') {
        const text = update.content.text;
        if (/^Compaction completed\.\n- Messages compacted: [\d,]+\n- Tokens before: [\d,]+\n- Tokens after: [\d,]+$/.test(text)) {
          this.compaction.completed = true;
          if (this.compaction.accepted) this.settleCompaction();
        } else if (text === 'Compaction cancelled.' || text.startsWith('Compaction is blocked by the current turn;')) this.settleCompaction(new Error(text));
      }
      return;
    }
    if (kind === 'camellia_compaction') { this.emit({ type: 'gui:compaction', state: update.state }); return; }
    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      if (update.content.type !== 'text') return;
      const text = update.content.text;
      const type = kind === 'agent_message_chunk' ? 'text' : 'thinking';
      if (type === 'text') this.text += text;
      if (this.activeBlock?.type !== type) {
        this.endBlock();
        this.activeBlock = { type, index: this.blockIndex++ };
        this.emitStream({ type: 'content_block_start', index: this.activeBlock.index, content_block: { type } });
      }
      this.emitStream({ type: 'content_block_delta', index: this.activeBlock.index,
        delta: type === 'text' ? { type: 'text_delta', text } : { type: 'thinking_delta', thinking: text } });
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      this.endBlock();
      const tool = this.tools.get(update.toolCallId) || { type: 'gui:tool', id: update.toolCallId };
      if (update.title != null) tool.name = update.title;
      if (update.rawInput != null) tool.input = update.rawInput;
      if (update.content != null) tool.output = toolContent(update.content);
      if (update.status != null) tool.status = update.status;
      if (update.permissionBlocked === true) tool.permissionBlocked = true;
      tool.is_error = tool.status === 'failed' || (tool.status === 'completed' && failedToolResult(tool.name, tool.output || ''));
      if (tool.is_error) tool.status = 'failed';
      this.tools.set(tool.id, tool);
      if (!this.spec.nativeSubagentEvents) this.subagents.observe(tool, update);
      this.emit({ ...tool });
    } else if (kind === 'config_option_update') this.emit({ type: 'gui:config', options: update.configOptions });
    else if (kind === 'plan') this.emit({ type: 'gui:plan', entries: update.entries });
  }

  answerPermission(requestId, allow, input, _message, optionId) {
    const request = this.permissions.get(requestId);
    if (!request || this.dead) return false;
    const options = request.params.options;
    const chosen = optionId ? options.find(o => o.optionId === optionId) : options.find(o => o.kind === (allow ? 'allow_once' : 'reject_once'));
    if (optionId && !chosen) return false;
    this.write({ id: request.id, result: { outcome: chosen ? { outcome: 'selected', optionId: chosen.optionId } : { outcome: 'cancelled' },
      ...(request.params.questions?.length ? { input: allow ? input || {} : {} } : {}) } });
    this.permissions.delete(requestId);
    if (request.subagentId) {
      const task = this.children.get(request.subagentId);
      const approvals = (task?.approvals || []).filter(row => row.requestId !== requestId);
      this.subagents.update(request.subagentId, { approvals, status: approvals.length ? 'waiting' : 'running' });
    }
    this.replayEvents = this.replayEvents.filter(event => event.type !== 'gui:permission' || event.requestId !== requestId);
    return true;
  }

  async controlChild(id, { operation, approvalId, response, expectedTurnId }) {
    const task = this.children.get(id);
    if (!task || this.dead) throw new Error('This subtask is no longer connected');
    if (operation === 'approve') {
      if (this.permissions.get(approvalId)?.subagentId !== id || !this.answerPermission(approvalId, response.allow, response.input, undefined, response.optionId))
        throw new Error('The subtask request changed');
      return;
    }
    if (task.turnId !== expectedTurnId) throw new Error('The subtask changed; refresh before responding');
    if (operation !== 'stop' || !task.canStop || !this.spec.nativeChildControl) throw new Error('This subtask does not support that action');
    await this.request('session/camellia_subagent_cancel', { sessionId: this.sessionId, taskId: this.subagents.nativeId(id), turnId: expectedTurnId });
  }

  finish(result) {
    const approvals = [...this.permissions].filter(([, request]) => request.subagentId);
    super.finish(result);
    if (!this.dead) for (const [id, request] of approvals) this.permissions.set(id, request);
  }

  interrupt() {
    if (!this.running || this.dead) return;
    this.cancelled = true;
    if (this.compaction) { this.kill(); return; }
    for (const id of this.permissions.keys()) this.answerPermission(id, false);
    if (this.sessionId) this.write({ method: 'session/cancel', params: { sessionId: this.sessionId } });
    // A stuck tool must not leave the stop button spinning forever.
    this.cancelTimer = setTimeout(() => this.kill(), 8000);
  }

  close(error) {
    this.settleCompaction(error);
    this.dead = true;
    this.subagents.disconnect();
    this.childHistory?.stop();
    clearTimeout(this.cancelTimer);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.permissions.clear();
    this.lines?.destroy();
  }

  kill() {
    this.close(new Error(`${this.name} process stopped`));
    // A failed spawn has no PID. Never signal its native handle: PID zero
    // targets the calling process group on Unix.
    if (Number.isInteger(this.proc?.pid) && this.proc.pid > 0) this.proc.kill();
  }

  async shutdown() {
    if (!this.dead && this.sessionId) {
      if (this.running) this.interrupt();
      try { await this.request('session/close', { sessionId: this.sessionId }, 5000); }
      catch (error) { this.log(this.name + ': close failed: ' + error.message); }
    }
    this.kill();
    await Promise.resolve();
    await this.usageMeter?.flush();
  }
}

function toolContent(content) {
  return (content || []).map(part => {
    if (part.type === 'content' && part.content.type === 'text') return part.content.text;
    if (part.type === 'diff') return part.path + '\n' + (part.newText || '');
    return '';
  }).filter(Boolean).join('\n');
}

module.exports = { AcpSession };
