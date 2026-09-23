'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { StreamingSession } = require('./streaming-session');
const { validSessionId } = require('./claude-history');
const { failedToolResult } = require('../api/tool-results');
const { nativeMode } = require('./permission-levels');

// ACP stays at the process boundary. The renderer receives the same stream and
// session events as the other harness, never upstream keys or CLI internals.
class AcpSession extends StreamingSession {
  constructor({ gen, settings, opts, exe, spec, spawn, log, history, onEvent, onSessionId, onResult, name = 'Kimi' }) {
    super();
    Object.assign(this, { gen, settings, opts, exe, spec, spawn, log, history, onEvent, onSessionId, onResult, name });
    this.sessionId = null;
    this.running = false;
    this.dead = false;
    this.sequence = 0;
    this.pending = new Map();
    this.permissions = new Map();
    this.tools = new Map();
    this.eventSeq = 0;
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
    this.lines = readline.createInterface({ input: this.proc.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); }
      catch { this.log(this.name + ': ignored a non-JSON stdout line'); return; }
      // One bad message or handler must not kill the readline loop.
      try { this.receive(message); }
      catch (error) { this.log(this.name + ': event handling failed: ' + error.message); }
    });
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
      if (message.method === 'session/update' && message.params.sessionId === this.sessionId && this.running) this.update(message.params.update);
      else if (message.id !== undefined) {
        if (message.method === 'session/request_permission' && message.params.sessionId === this.sessionId && this.running && !this.cancelled && !this.compaction) {
          const requestId = String(message.id);
          this.permissions.set(requestId, message);
          const tool = message.params.toolCall || {};
          const content = toolContent(tool.content);
          this.emit({ type: 'gui:permission', requestId, toolName: tool.title || tool.kind || '',
            input: tool.rawInput || (content ? { command: content } : tool.locations?.length ? { paths: tool.locations.map(loc => loc.path).join('\n') } : {}),
            options: message.params.options });
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
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }

  async open() {
    await this.starting;
    const initResult = await this.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'Camellia', version: '0.1.0' } });
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
    if (this.settings.thinkingBudget) config = await this.request('session/set_config_option', {
      sessionId: this.sessionId, configId: this.spec.thinkingId || 'thinking', value: this.settings.thinkingBudget });
    if (!this.spec.noModes) await this.request('session/set_mode', { sessionId: this.sessionId, modeId: nativeMode(this.spec.modeEngine || 'kimi', this.settings.permissionMode || 'default') });
    this.onSessionId(this.sessionId);
    this.emit({ type: 'gui:config', options: config.configOptions });
  }

  sendUserMessage(prompt, attachments = []) {
    if (this.running || this.dead) return false;
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
    clearTimeout(operation.timer); clearTimeout(this.cancelTimer);
    if (error || this.cancelled) operation.reject(error || new Error('Compaction canceled'));
    else operation.resolve({ ok: true });
  }

  update(update) {
    const kind = update.sessionUpdate;
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
      tool.is_error = tool.status === 'failed' || (tool.status === 'completed' && failedToolResult(tool.name, tool.output || ''));
      if (tool.is_error) tool.status = 'failed';
      this.tools.set(tool.id, tool);
      this.emit({ ...tool });
    } else if (kind === 'config_option_update') this.emit({ type: 'gui:config', options: update.configOptions });
    else if (kind === 'plan') this.emit({ type: 'gui:plan', entries: update.entries });
  }

  answerPermission(requestId, allow, _input, _message, optionId) {
    const request = this.permissions.get(requestId);
    if (!request || this.dead) return false;
    const options = request.params.options;
    const chosen = optionId ? options.find(o => o.optionId === optionId) : options.find(o => o.kind === (allow ? 'allow_once' : 'reject_once'));
    if (optionId && !chosen) return false;
    this.write({ id: request.id, result: { outcome: chosen ? { outcome: 'selected', optionId: chosen.optionId } : { outcome: 'cancelled' } } });
    this.permissions.delete(requestId);
    this.replayEvents = this.replayEvents.filter(event => event.type !== 'gui:permission' || event.requestId !== requestId);
    return true;
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
    clearTimeout(this.cancelTimer);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.permissions.clear();
    this.lines?.close();
  }

  kill() {
    this.close(new Error(`${this.name} process stopped`));
    this.proc?.kill();
  }

  async shutdown() {
    if (!this.dead && this.sessionId) {
      if (this.running) this.interrupt();
      try { await this.request('session/close', { sessionId: this.sessionId }, 5000); }
      catch (error) { this.log(this.name + ': close failed: ' + error.message); }
    }
    this.kill();
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
