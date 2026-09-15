'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { validSessionId } = require('./claude-history');

// ACP stays at the process boundary. The renderer receives the same stream and
// session events as the other harness, never upstream keys or CLI internals.
class KimiSession {
  constructor({ gen, settings, opts, exe, spec, spawn, log, history, onEvent, onSessionId, onResult }) {
    Object.assign(this, { gen, settings, opts, exe, spec, spawn, log, history, onEvent, onSessionId, onResult });
    this.sessionId = null;
    this.running = false;
    this.dead = false;
    this.sequence = 0;
    this.pending = new Map();
    this.permissions = new Map();
    this.eventSeq = 0;
  }

  start(waitFor) {
    if (waitFor) {
      this.starting = waitFor.then(() => {
        if (this.dead) throw new Error("Kimi startup canceled");
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
      catch { this.log('kimi: ignored a non-JSON stdout line'); return; }
      this.receive(message);
    });
    this.proc.stderr.on('data', chunk => this.log('kimi: ' + String(chunk).trim()));
    this.proc.on('error', error => this.close(error));
    this.proc.on('exit', code => this.close(new Error("Kimi process exited (" + code + ")")));
    this.proc.stdin.on('error', error => this.close(error));
  }

  write(message) {
    if (this.dead) throw new Error("Kimi process is unavailable");
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }

  request(method, params, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = timeout ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Kimi request timed out: " + method));
      }, timeout) : null;
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  receive(message) {
    if (message.method) {
      if (message.method === 'session/update' && message.params.sessionId === this.sessionId && this.running) this.update(message.params.update);
      else if (message.id !== undefined) {
        if (message.method === 'session/request_permission' && message.params.sessionId === this.sessionId && this.running && !this.cancelled) {
          const requestId = String(message.id);
          this.permissions.set(requestId, message);
          const tool = message.params.toolCall;
          this.emit({ type: 'gui:permission', requestId, toolName: tool.title,
            input: tool.rawInput || { command: toolContent(tool.content) }, options: message.params.options });
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
    await this.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'Harness Workbench', version: '0.1.0' } });
    let sourceId = this.opts.sessionId;
    if (!sourceId && this.opts.resumeLast) sourceId = (await this.history.list())[0]?.id;
    const method = sourceId ? this.opts.fork ? 'session/fork' : 'session/resume' : 'session/new';
    const result = await this.request(method, { ...(sourceId ? { sessionId: sourceId } : {}), cwd: this.cwd, mcpServers: [] });
    this.sessionId = result.sessionId || sourceId;
    if (!validSessionId(this.sessionId)) throw new Error("Kimi returned an invalid session ID");
    if (this.opts.fork) {
      const source = this.history.find(sourceId);
      if (source) fs.copyFileSync(source, this.historyFile());
    }
    // Native resume keeps its model and permission state; always apply the
    // workbench selection explicitly, including on forks.
    let config = await this.request('session/set_config_option', { sessionId: this.sessionId, configId: 'model', value: this.settings.model });
    if (this.settings.thinkingBudget) config = await this.request('session/set_config_option', {
      sessionId: this.sessionId, configId: 'thinking', value: this.settings.thinkingBudget });
    await this.request('session/set_mode', { sessionId: this.sessionId, modeId: this.settings.permissionMode || 'default' });
    this.onSessionId(this.sessionId);
    this.emit({ type: 'gui:config', options: config.configOptions });
  }

  sendUserMessage(prompt, attachments = []) {
    if (this.running || this.dead) return false;
    this.running = true;
    this.prompt = prompt;
    this.replayEvents = [];
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
        if (attachment.isImage && mimeType) parts.push({ type: 'image', mimeType, data: fs.readFileSync(attachment.path).toString('base64') });
      }
      const response = await this.request('session/prompt', { sessionId: this.sessionId, prompt: parts }, 0);
      const stopped = this.cancelled || response.stopReason === 'cancelled';
      const failed = ['refusal', 'max_tokens', 'max_turn_requests'].includes(response.stopReason);
      this.finish({ subtype: stopped ? 'stopped' : failed ? response.stopReason : 'success', is_error: failed });
    } catch (error) {
      this.finish({ subtype: this.cancelled ? 'stopped' : 'error', is_error: !this.cancelled, result: error.message });
      // A failed initialization cannot be reused. Prompt errors may be retried
      // by resuming the native session in a fresh process.
      this.kill();
    }
  }

  update(update) {
    const kind = update.sessionUpdate;
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
      this.emit({ type: 'gui:tool', id: update.toolCallId, name: update.title, input: update.rawInput,
        output: toolContent(update.content), status: update.status, is_error: update.status === 'failed' });
    } else if (kind === 'config_option_update') this.emit({ type: 'gui:config', options: update.configOptions });
    else if (kind === 'plan') this.emit({ type: 'gui:plan', entries: update.entries });
  }

  endBlock() {
    if (this.activeBlock) this.emitStream({ type: 'content_block_stop', index: this.activeBlock.index });
    this.activeBlock = null;
  }

  historyFile() {
    const dir = path.join(this.history.root, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, this.sessionId + '.jsonl');
  }

  appendHistory(role, text) {
    fs.appendFileSync(this.historyFile(), JSON.stringify({ type: role, cwd: this.settings.cwd,
      message: { role, content: [{ type: 'text', text }] } }) + '\n');
  }

  finish(result) {
    if (!this.running) return;
    clearTimeout(this.cancelTimer);
    this.endBlock();
    if (this.sessionId && this.text) {
      try { this.appendHistory('assistant', this.text); }
      catch (error) { this.log('kimi: history write failed: ' + error.message); result = { subtype: 'error', is_error: true, result: "Could not save session history: " + error.message }; }
    }
    this.permissions.clear();
    this.running = false;
    const event = { type: 'result', session_id: this.sessionId, result: this.text, duration_ms: Date.now() - this.startedAt, ...result };
    this.emit(event);
    this.onResult(event);
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
    for (const id of this.permissions.keys()) this.answerPermission(id, false);
    if (this.sessionId) this.write({ method: 'session/cancel', params: { sessionId: this.sessionId } });
    // A stuck tool must not leave the stop button spinning forever.
    this.cancelTimer = setTimeout(() => this.kill(), 8000);
  }

  emit(event) {
    const message = { ...event, runId: this.gen, eventSeq: ++this.eventSeq, workspaceId: this.opts.workspaceId || null };
    if (this.running) {
      const last = this.replayEvents.at(-1);
      const delta = message.event?.delta;
      // Keep only the current turn for reattachment, coalescing token chunks.
      if (delta && last?.event?.index === message.event.index && last.event.delta?.type === delta.type) {
        const key = delta.type === 'text_delta' ? 'text' : 'thinking';
        last.event.delta[key] += delta[key];
        last.eventSeq = message.eventSeq;
      } else this.replayEvents.push(structuredClone(message));
    }
    this.onEvent(message);
  }
  emitStream(event) { this.emit({ type: 'stream_event', event }); }

  async liveState() {
    if (!this.running) return null;
    const file = this.sessionId && this.history.find(this.sessionId);
    const { messages = [] } = file ? await this.history.transcript(this.sessionId) : {};
    if (!this.running) return null;
    if (messages.at(-1)?.role === 'user' && messages.at(-1).text === this.prompt) messages.pop();
    return { sessionId: this.sessionId, workspaceId: this.opts.workspaceId || null, runId: this.gen,
      messages, prompt: this.prompt, events: this.replayEvents, eventSeq: this.eventSeq };
  }

  close(error) {
    this.dead = true;
    clearTimeout(this.cancelTimer);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.permissions.clear();
    this.lines?.close();
  }

  kill() {
    this.close(new Error("Kimi process stopped"));
    this.proc?.kill();
  }

  async shutdown() {
    if (!this.dead && this.sessionId) {
      if (this.running) this.interrupt();
      try { await this.request('session/close', { sessionId: this.sessionId }, 5000); }
      catch (error) { this.log('kimi: close failed: ' + error.message); }
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

// The runtime reads only this app-owned config. All real credentials stay in
// the router; even child agents see only the one selected model alias.
function kimiSpawnSpec({ home, runtime, model, contextWindow = 131072, route, config = {}, mcp = '', env = process.env }) {
  fs.mkdirSync(home, { recursive: true });
  if (process.platform === 'win32') home = fs.realpathSync.native(home);
  const { stringify } = require('smol-toml');
  const { routeKimi } = require('./engine-settings');
  // Native tools, hooks and permissions are retained; only this session's route is pinned.
  const merged = routeKimi({ telemetry: false, ...config, providers: {}, models: {} }, { route, model, contextWindow });
  fs.writeFileSync(path.join(home, 'config.toml'), stringify(merged));
  fs.writeFileSync(path.join(home, 'mcp.json'), mcp || '{"mcpServers":{}}');
  return { args: [runtime, 'acp'], env: { ...env, KIMI_CODE_HOME: home, KIMI_DISABLE_TELEMETRY: merged.telemetry ? '0' : '1' } };
}

module.exports = { KimiSession, kimiSpawnSpec };
