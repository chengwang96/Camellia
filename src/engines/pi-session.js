'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { StreamingSession } = require('./streaming-session');
const { SessionPool } = require('./session-pool');
const { ClaudeHistory, validSessionId } = require('./claude-history');
const { writeJson } = require('../shared/json-store');
const { modelId } = require('../api/api-router-config');

function piSpec({ runtime, home, sessionId, settings, route, env, goalBridge }) {
  fs.mkdirSync(home, { recursive: true });
  writeJson(path.join(home, 'models.json'), { providers: { camellia: {
    api: 'anthropic-messages', baseUrl: route.baseUrl, apiKey: 'proxy-managed',
    models: [{ id: settings.model, name: settings.model, reasoning: true, input: ['text', 'image'],
      contextWindow: Number(settings.contextWindow) || 65536, maxTokens: 32768 }],
  } } });
  const extension = path.join(__dirname, 'pi-extension.mjs').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  const args = [runtime.file, '--mode', 'rpc', '--provider', 'camellia', '--model', settings.model,
    '--session', path.join(home, sessionId + '.jsonl'), '--no-extensions', '-e', extension];
  if (settings.instructions) args.push('--append-system-prompt', settings.instructions);
  if (['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(settings.thinkingBudget)) args.push('--thinking', settings.thinkingBudget);
  return { args, env: { ...env, PI_CODING_AGENT_DIR: home, CAMELLIA_PI_PERMISSION: settings.permissionMode,
    CAMELLIA_PI_EFFORT: settings.thinkingBudget || '',
    CAMELLIA_GOAL_ENDPOINT: '', CAMELLIA_GOAL_TOKEN: '', ...goalBridge?.config.env } };
}

class PiSession extends StreamingSession {
  constructor(options) {
    super();
    Object.assign(this, options);
    this.name = 'Pi'; this.running = false; this.dead = false; this.sequence = 0; this.eventSeq = 0;
    this.permissions = new Map(); this.pending = new Map(); this.tools = new Map(); this.replayEvents = [];
  }
  async open() {
    await this.previous;
    if (this.dead) throw new Error('Pi startup cancelled');
    this.proc = this.spawn(this.exe, this.spec.args, { cwd: this.settings.cwd, env: this.spec.env,
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', chunk => {
      buffer += chunk;
      let boundary;
      while ((boundary = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        try { this.receive(JSON.parse(line)); } catch (error) { this.close(error); }
      }
    });
    this.proc.stderr.on('data', chunk => this.log('Pi: ' + String(chunk).trim()));
    this.proc.on('error', error => this.close(error));
    this.proc.on('close', code => this.close(new Error(`Pi process exited (${code})`)));
    this.proc.stdin.on('error', error => this.close(error));
    await this.request('get_state');
  }
  write(record) {
    if (this.dead || !this.proc) throw new Error('Pi process is unavailable');
    this.proc.stdin.write(JSON.stringify(record) + '\n');
  }
  request(type, fields = {}) {
    return new Promise((resolve, reject) => {
      const id = String(++this.sequence);
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Pi request timed out: ${type}`)); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, type, ...fields }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  receive(record) {
    if (record.type === 'response') {
      const pending = this.pending.get(record.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(record.id);
      if (record.success) pending.resolve(record.data);
      else pending.reject(new Error(record.error || 'Pi command failed'));
      return;
    }
    if (record.type === 'extension_ui_request') {
      if (record.method === 'confirm' && this.running && !this.cancelled) {
        this.permissions.set(record.id, record);
        this.emit({ type: 'gui:permission', requestId: record.id, toolName: record.title, input: { description: record.message } });
      } else if (['confirm', 'select', 'input', 'editor'].includes(record.method))
        this.write({ type: 'extension_ui_response', id: record.id, cancelled: true });
      return;
    }
    if (!this.running) return;
    if (record.type === 'message_update') {
      const update = record.assistantMessageEvent;
      const type = update?.type === 'text_delta' ? 'text' : update?.type === 'thinking_delta' ? 'thinking' : null;
      if (!type) return;
      if (type === 'text') this.text += update.delta;
      if (this.activeBlock?.type !== type) {
        this.endBlock(); this.activeBlock = { type, index: this.blockIndex++ };
        this.emitStream({ type: 'content_block_start', index: this.activeBlock.index, content_block: { type } });
      }
      this.emitStream({ type: 'content_block_delta', index: this.activeBlock.index,
        delta: type === 'text' ? { type: 'text_delta', text: update.delta } : { type: 'thinking_delta', thinking: update.delta } });
    } else if (record.type.startsWith('tool_execution_')) {
      this.endBlock();
      const tool = this.tools.get(record.toolCallId) || { type: 'gui:tool', id: record.toolCallId, name: record.toolName, input: record.args };
      const result = record.result || record.partialResult;
      if (result) tool.output = (result.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
      tool.status = record.type === 'tool_execution_end' ? record.isError ? 'failed' : 'completed' : 'in_progress';
      tool.is_error = Boolean(record.isError); this.tools.set(tool.id, tool); this.emit({ ...tool });
    } else if (record.type === 'message_end') {
      this.endBlock();
      if (record.message?.role === 'assistant' && record.message.stopReason === 'error') this.failure = record.message.errorMessage || 'Pi model request failed';
    } else if (record.type === 'agent_end') {
      this.finish({ subtype: this.cancelled ? 'stopped' : this.failure ? 'error' : 'success', is_error: Boolean(this.failure),
        ...(this.failure ? { result: this.failure } : {}) });
    }
  }
  sendUserMessage(prompt, attachments = []) {
    if (this.running || this.dead) return false;
    this.running = true; this.prompt = prompt; this.text = ''; this.failure = null; this.cancelled = false;
    this.blockIndex = 0; this.activeBlock = null; this.replayEvents = []; this.tools.clear(); this.startedAt = Date.now();
    void this.run(prompt, attachments);
    return true;
  }
  // The benchmark spawns a session per trial and never sends more than one
  // message, so startup is lazy. These two hooks keep Pi on the same contract
  // as the other transports, which the benchmark drives directly.
  start() {
    this.ready = this.open().catch(error => { this.close(error); throw error; });
    this.ready.catch(() => {});
  }
  kill() {
    this.cancelled = true;
    this.close(new Error('Pi process stopped'));
  }
  async run(prompt, attachments) {
    try {
      await (this.ready ||= this.open());
      this.emit({ type: 'system', subtype: 'init', session_id: this.sessionId });
      if (this.cancelled) { this.finish({ subtype: 'stopped' }); return; }
      const images = attachments.filter(attachment => attachment.isImage).map(attachment => {
        const mimeType = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[path.extname(attachment.path).toLowerCase()];
        if (!mimeType) throw new Error('Unsupported Pi image format');
        return { type: 'image', mimeType, data: fs.readFileSync(attachment.path).toString('base64') };
      });
      this.appendHistory('user', prompt); this.emitStream({ type: 'message_start' });
      await this.request('prompt', { message: prompt, images });
    } catch (error) { this.close(error); }
  }
  answerPermission(requestId, allow) {
    if (!this.permissions.has(requestId) || this.dead) return false;
    this.write({ type: 'extension_ui_response', id: requestId, confirmed: Boolean(allow) });
    this.permissions.delete(requestId);
    this.replayEvents = this.replayEvents.filter(event => event.type !== 'gui:permission' || event.requestId !== requestId);
    return true;
  }
  interrupt() {
    if (!this.running || this.dead) return;
    this.cancelled = true;
    for (const id of this.permissions.keys()) this.answerPermission(id, false);
    if (this.proc) void this.request('abort').catch(error => this.close(error));
    this.cancelTimer = setTimeout(() => this.close(new Error('Pi cancellation timed out')), 5000);
  }
  close(error) {
    if (this.dead) return;
    this.dead = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.finish({ subtype: this.cancelled ? 'stopped' : 'error', is_error: !this.cancelled, result: error.message });
    this.proc?.kill();
  }
  async shutdown() {
    this.cancelled = true;
    this.close(new Error('Pi session closed'));
  }
}

function createPiChat({ dataDir, loadConfig, saveConfig, getRoute, getModels, runtime, node, environment, onEvent, log = () => {}, instructions = () => '', nativeRevision = () => '' }) {
  const sessions = new SessionPool();
  const history = new ClaudeHistory(path.join(dataDir, 'pi-history'));
  let generation = 0;
  const settings = () => ({ model: '', permissionMode: 'ask', connection: 'api', ...loadConfig().pi });
  function saveSettings(patch) {
    if (patch.connection !== undefined && patch.connection !== 'api') throw new Error('Pi supports API connections only');
    const value = settings();
    for (const key of ['model', 'permissionMode', 'thinkingBudget', 'contextWindow']) if (patch[key] !== undefined) value[key] = String(patch[key]);
    if (!['ask', 'auto', 'full'].includes(value.permissionMode)) throw new Error('Invalid Pi permission mode');
    saveConfig({ pi: value }); return value;
  }
  function ensure(opts) {
    sessions.assertAccess(opts);
    const selected = { ...settings(), ...opts.settings, cwd: opts.cwd, instructions: instructions(), nativeRevision: nativeRevision() };
    if (selected.connection !== 'api') throw new Error('Pi supports API connections only');
    selected.model = modelId(selected.model);
    if (!selected.model || !getModels().includes(selected.model)) throw new Error('Select a configured model first');
    if (!['ask', 'auto', 'full'].includes(selected.permissionMode)) throw new Error('Invalid Pi permission mode');
    const current = sessions.get(opts);
    if (current && !current.dead && current.opts.goalBridge === opts.goalBridge && current.sessionId === opts.sessionId && JSON.stringify(current.settings) === JSON.stringify(selected)) return current;
    if (opts.sessionId && !validSessionId(opts.sessionId)) throw new Error('Invalid Pi session ID');
    const sessionId = opts.sessionId || randomUUID();
    const home = path.join(dataDir, 'pi', sessionId);
    const spec = piSpec({ runtime: runtime(), home, sessionId, settings: selected, route: getRoute(), env: environment(), goalBridge: opts.goalBridge });
    const session = new PiSession({ gen: ++generation, sessionId, settings: selected, opts, spec, exe: node(), spawn, history, log,
      previous: current?.shutdown(), onResult: () => {},
      onEvent: event => { if (sessions.get(opts) === session) onEvent({ ...event, conversationId: opts.conversationId }); } });
    sessions.set(opts, session); return session;
  }
  return { history, settings, saveSettings, ensure, sessions, shutdown: () => sessions.shutdown() };
}

module.exports = { PiSession, createPiChat, piSpec };
