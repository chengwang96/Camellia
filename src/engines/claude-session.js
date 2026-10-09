'use strict';

const { StringDecoder } = require('node:string_decoder');
const { nativeMode } = require('./permission-levels');

// Owns one CLI process. Application state stays in main; the callbacks below
// also make process failures and fragmented output testable without Electron.
class ClaudeSession {
  constructor({ gen, settings, opts, exe, spec, spawn, log = () => {}, onEvent, onSessionId, onResult,
    setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { gen, settings, opts, exe, spec, spawn, log, onEvent, onSessionId, onResult, setTimer, clearTimer });
    this.sessionId = opts.sessionId || null;
    this.proc = null;
    this.running = false;
    this.dead = false;
    this.closed = false;
    this.initialized = false;
    this.watchdog = null;
    this.cancelTimer = null;
    this.cancelled = false;
    this.stdoutBuf = '';
    this.stdoutDecoder = new StringDecoder('utf8');
    this.stderrDecoder = new StringDecoder('utf8');
    this.controlSeq = 0;
    this.permissions = new Map();
    this.children = new Map();
    this.childTools = new Map();
    this.childControls = new Map();
  }

  start() {
    const { exe, spec } = this;
    // Print mode otherwise denies operations that need approval without ever
    // sending can_use_tool to our existing permission handler.
    const args = spec.args.includes('--permission-prompt-tool') ? [...spec.args] : [...spec.args, '--permission-prompt-tool', 'stdio'];
    // In the app, Allow all is the user's chosen execution mode. EnterPlanMode
    // silently replaces it with read-only planning inside a persistent CLI.
    // Keep this UI choice stable; users can still select Plan only themselves.
    if (this.opts.lockPermissionMode && nativeMode('claude', this.settings.permissionMode) === 'bypassPermissions') args.push('--disallowedTools', 'EnterPlanMode');
    this.log(`claude: persistent session gen=${this.gen} resume=${this.opts.sessionId || 'no'} ${args.join(' ')}`);
    if (this.opts.goalBridge) args.push('--mcp-config', JSON.stringify({ mcpServers: { camellia_goals: this.opts.goalBridge.config } }));
    const proc = this.spawn(exe, args, { cwd: spec.cwd, env: spec.env, windowsHide: true, shell: exe === 'claude' });
    this.proc = proc;
    proc.stdout.on('data', chunk => {
      if (this.closed) return;
      this.stdoutBuf += this.stdoutDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      this.drain();
    });
    proc.stderr.on('data', chunk => {
      const text = this.stderrDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)).trimEnd();
      if (text) this.log(`[claude stderr] ${text}`);
    });
    proc.stdin.on('error', err => this.fail('stdin_error', err.message));
    proc.on('error', err => this.fail('spawn_error', err.message));
    // close follows stdout's final data; exit may arrive before those bytes.
    proc.on('close', (code, signal) => {
      if (this.closed) return;
      this.dead = true;
      this.stdoutBuf += this.stdoutDecoder.end();
      this.drain(true);
      const stderr = this.stderrDecoder.end().trimEnd();
      if (stderr) this.log(`[claude stderr] ${stderr}`);
      for (const [id, task] of this.children) this.childUpdate(id, { canReply: false, canStop: false, approvals: [],
        ...(['starting', 'running', 'waiting'].includes(task.status) ? { status: 'unavailable' } : {}) });
      if (this.running) this.complete({ type: 'result', is_error: true,
        subtype: code === null ? 'stopped' : 'exit_' + code,
        result: code === null ? `Stopped (signal ${signal || ''})` : `Claude exited before returning a result (exit code ${code})` });
      this.closed = true;
      this.clearWatchdog();
    });
  }

  drain(final = false) {
    let index;
    while (!this.closed && (index = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, index);
      this.stdoutBuf = this.stdoutBuf.slice(index + 1);
      // A throwing event handler must not wedge the parser loop; log it and
      // continue with the next buffered line.
      try { this.emitLine(line); }
      catch (err) { this.log(`claude: event handling failed: ${err.message}`); }
    }
    if (final && this.stdoutBuf.trim()) this.emitLine(this.stdoutBuf);
    if (final) this.stdoutBuf = '';
    if (this.stdoutBuf.length > 16 * 1024 * 1024) this.fail('protocol_error', "A Claude event exceeded the size limit");
  }

  sendChannel(obj) {
    if (!this.closed) this.onEvent?.({ ...obj, runId: this.gen, workspaceId: this.opts.workspaceId || null, cwd: this.settings.cwd });
  }

  rememberSession(id) {
    this.sessionId = id || this.sessionId;
    try { this.onSessionId?.(this.sessionId); }
    catch (err) { this.log(`claude: session metadata save failed: ${err.message}`); }
  }

  complete(obj) {
    if (!this.running) return;
    this.running = false;
    this.clearWatchdog();
    this.clearTimer(this.cancelTimer); this.cancelTimer = null;
    for (const [id, request] of this.permissions) if (!request.subagentId) this.permissions.delete(id);
    this.rememberSession(obj.session_id);
    const errorText = Array.isArray(obj.errors) ? obj.errors.filter(e => typeof e === 'string').join('\n') : '';
    const result = { ...obj, result: obj.result || (obj.is_error ? errorText : '') || '', session_id: this.sessionId,
      ...(this.cancelled ? { subtype: 'stopped', is_error: false } : {}) };
    if (this.compaction) {
      const operation = this.compaction; this.compaction = null;
      this.clearTimer(operation.timer);
      if (!this.cancelled && !result.is_error && result.subtype === 'success' && operation.boundary) operation.resolve({ ok: true });
      else operation.reject(new Error(result.result || 'Claude compaction failed or canceled; no completed compaction was confirmed.'));
      return;
    }
    try { this.onResult?.(result); }
    catch (err) { this.log(`claude result hook failed: ${err.message}`); }
    this.sendChannel(result);
  }

  fail(subtype, message) {
    if (this.closed) return;
    this.dead = true;
    this.log(`claude: ${subtype}: ${message}`);
    this.complete({ type: 'result', is_error: true, subtype, result: String(message) });
    this.kill();
  }

  emitLine(line) {
    if (this.closed || !line.trim()) return;
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    if (!obj || typeof obj !== 'object') return;
    if (obj.type === 'control_request') { this.onControlRequest(obj); return; }
    if (obj.type === 'control_response') {
      const response = obj.response, pending = this.childControls.get(response?.request_id);
      if (pending) {
        this.childControls.delete(response.request_id); this.clearTimer(pending.timer);
        if (response.subtype === 'success') pending.resolve();
        else pending.reject(new Error(response.error || 'The subtask operation failed'));
      }
      return;
    }
    if (obj.type === 'system' && obj.subtype === 'init') {
      this.initialized = true;
      this.clearWatchdog();
      this.rememberSession(obj.session_id);
    }
    if (obj.type === 'result') { this.complete(obj); return; }
    if (obj.type === 'system' && obj.subtype === 'compact_boundary') {
      if (this.compaction) this.compaction.boundary = true;
      else this.sendChannel({ type: 'gui:compaction', state: 'completed' });
    }
    if (this.compaction) return;
    if (obj.type === 'system' && ['task_started', 'task_progress', 'task_notification', 'task_updated'].includes(obj.subtype) && obj.task_id) {
      if (obj.task_type && !['local_agent', 'remote_agent', 'local_workflow', 'in_process_teammate'].includes(obj.task_type)) return;
      if (obj.subtype !== 'task_started' && !this.children.has(obj.task_id)) return;
      if (obj.tool_use_id) this.childTools.set(obj.tool_use_id, obj.task_id);
      const native = obj.patch || obj;
      const status = ({ pending: 'starting', running: 'running', completed: 'completed', failed: 'failed', stopped: 'stopped' }[native.status]) || this.children.get(obj.task_id)?.status || 'running';
      this.childUpdate(obj.task_id, {
        ...(obj.parent_task_id ? { parentId: obj.parent_task_id } : {}),
        ...(obj.subtype === 'task_started' ? { turnId: obj.run_id || 'child-start-' + ++this.controlSeq } : {}),
        title: obj.description || undefined, goal: obj.subtype === 'task_started' ? obj.description : undefined,
        progress: obj.summary || obj.description || undefined,
        status, ...(status === 'completed' ? { result: obj.summary || undefined } : {}),
        canReply: false, canStop: ['starting', 'running', 'waiting'].includes(status),
        history: [...(this.children.get(obj.task_id)?.history || []), { type: obj.subtype, text: obj.summary || obj.description || native.status || '' }],
        ...(!['starting', 'running', 'waiting'].includes(status) ? { approvals: [] } : {}),
      });
      return;
    }
    if (obj.parent_tool_use_id || obj.agent_id) {
      const id = obj.agent_id || this.childTools.get(obj.parent_tool_use_id);
      if (id && this.children.has(id)) {
        const text = obj.message?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') || obj.event?.delta?.text;
        if (text) this.childUpdate(id, { progress: text, history: [...(this.children.get(id).history || []), { type: obj.type, text }] });
      }
      return;
    }
    this.sendChannel(obj);
  }

  onControlRequest(msg) {
    const req = msg.request || {};
    if (req.subtype === 'initialize') {
      this.initialized = true;
      this.clearWatchdog();
      this.answer(msg.request_id, {});
    } else if (req.subtype === 'can_use_tool') {
      const childId = typeof req.agent_id === 'string' ? req.agent_id : null;
      if ((!childId && (!this.running || this.cancelled || this.compaction)) || this.dead) {
        this.answer(msg.request_id, { behavior: 'deny', message: 'This response was stopped or is no longer active.' });
        return;
      }
      const input = req.input || {};
      const questions = req.tool_name === 'AskUserQuestion' && Array.isArray(input.questions)
        ? input.questions.map((question, index) => ({ ...question, id: 'claude-question-' + index })) : undefined;
      this.permissions.set(msg.request_id, { input, questions, subagentId: childId });
      const event = { type: 'gui:permission', requestId: msg.request_id, toolName: req.tool_name || '',
        input, ...(questions?.length ? { questions } : {}), permissionSuggestions: req.permission_suggestions || null,
        reason: req.decision_reason || req.blocked_path && ('Protected path: ' + req.blocked_path) || '', permissionMode: this.settings.permissionMode };
      if (childId) this.childUpdate(childId, { status: 'waiting', canReply: false, canStop: true,
        ...(!this.children.has(childId) ? { turnId: 'child-start-' + ++this.controlSeq } : {}),
        approvals: [...(this.children.get(childId)?.approvals || []), { ...event, subagentId: childId }] });
      else this.sendChannel(event);
    } else {
      this.log(`claude: control_request subtype=${req.subtype} → auto-success`);
      this.answer(msg.request_id, {});
    }
  }

  write(obj) {
    if (this.dead || !this.proc?.stdin.writable) {
      this.fail('stdin_error', "Claude input channel is closed");
      return false;
    }
    try {
      this.proc.stdin.write(JSON.stringify(obj) + '\n', err => { if (err) this.fail('stdin_error', err.message); });
      return !this.dead;
    } catch (err) { this.fail('stdin_error', err.message); return false; }
  }

  answer(requestId, response) {
    return this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  }

  answerPermission(requestId, allow, input, message) {
    if (!this.permissions.has(requestId)) return false;
    const { input: originalInput, questions, subagentId } = this.permissions.get(requestId);
    let updatedInput = input ?? originalInput;
    if (allow && questions?.length) {
      const answers = Object.fromEntries(questions.map(question => {
        const answer = input?.[question.id];
        const value = Array.isArray(answer) ? answer.filter(v => typeof v === 'string' && v.trim()).join(', ') : answer;
        if (typeof value !== 'string' || !value.trim()) throw new Error('Answer each question before submitting');
        return [question.question, value];
      }));
      // AskUserQuestion needs the original schema plus answers keyed by the
      // question text. Treating this as a plain Allow loses the user's answer.
      updatedInput = { ...originalInput, answers };
    }
    this.permissions.delete(requestId);
    if (subagentId) {
      const approvals = (this.children.get(subagentId)?.approvals || []).filter(event => event.requestId !== requestId);
      this.childUpdate(subagentId, { status: approvals.length ? 'waiting' : 'running', approvals });
    }
    return this.answer(requestId, allow
      ? { behavior: 'allow', updatedInput }
      : { behavior: 'deny', message: message || "The user denied this action in the desktop interface" });
  }

  sendUserMessage(text, attachments = []) {
    if (this.dead || this.running) return false;
    const content = [{ type: 'text', text }];
    const { IMAGE_TYPES } = require('./discussions/assets');
    for (const file of attachments) if (file.isImage) {
      const media_type = IMAGE_TYPES[require('node:path').extname(file.path).toLowerCase()];
      if (!media_type) throw new Error('Unsupported image format');
      content.push({ type: 'image', source: { type: 'base64', media_type, data: require('node:fs').readFileSync(file.path).toString('base64') } });
    }
    this.cancelled = false;
    this.running = true;
    if (!this.initialized) {
      this.watchdog = this.setTimer(() => this.fail('session_timeout', "Claude did not initialize within 25 seconds (stream-json handshake failed)."), 25_000);
    }
    return this.write({ type: 'user', message: { role: 'user', content } });
  }

  interrupt() {
    if (!this.running || this.cancelled) return false;
    this.cancelled = true;
    for (const [requestId, request] of this.permissions) if (!request.subagentId) this.answerPermission(requestId, false, undefined, 'The user stopped this response.');
    const sent = this.write({ type: 'control_request', request_id: `gui-interrupt-${++this.controlSeq}`, request: { subtype: 'interrupt' } });
    if (this.running) this.cancelTimer = this.setTimer(() => {
      if (!this.running) return;
      this.log('claude: interrupt was not acknowledged within 8 seconds; stopping this session process');
      const finish = () => { this.complete({ type: 'result', subtype: 'stopped', result: 'Stopped' }); this.kill(); };
      if (process.platform === 'win32' && this.proc?.pid) {
        try {
          const taskkill = require('node:path').join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
          const killer = this.spawn(taskkill, ['/PID', String(this.proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.once('error', finish); killer.once('close', finish);
          this.cancelTimer = this.setTimer(finish, 3000);
        } catch { finish(); }
      } else finish();
    }, 8000);
    return sent;
  }

  compact({ timeoutMs = 120000 } = {}) {
    if (this.running || this.dead) return Promise.reject(new Error('Claude is busy or unavailable'));
    const done = new Promise((resolve, reject) => {
      this.compaction = { resolve, reject, boundary: false, timer: this.setTimer(() => {
        this.fail('compaction_timeout', 'Claude context compaction timed out; the original session is retained.');
      }, timeoutMs) };
    });
    this.sendUserMessage('/compact');
    return done;
  }

  clearWatchdog() { this.clearTimer(this.watchdog); this.watchdog = null; }

  childUpdate(id, update) {
    const task = require('../shared/subagents').mergeTask(this.children.get(id), { ...update, id }, { engine: 'claude' });
    if (!task) return;
    this.children.set(id, task); this.sendChannel({ type: 'gui:subagent', task });
  }

  async controlChild(id, { operation, approvalId, response, expectedTurnId }) {
    const task = this.children.get(id);
    if (!task || this.dead) throw new Error('This subtask is no longer connected');
    if (operation === 'approve') {
      if (this.permissions.get(approvalId)?.subagentId !== id || !this.answerPermission(approvalId, response.allow, response.input)) throw new Error('The subtask request changed');
      return;
    }
    if (task.turnId !== expectedTurnId) throw new Error('The subtask changed; refresh before responding');
    if (operation !== 'stop' || !task.canStop) throw new Error('This subtask does not support that action');
    const requestId = 'gui-child-' + ++this.controlSeq;
    await new Promise((resolve, reject) => {
      const timer = this.setTimer(() => { this.childControls.delete(requestId); reject(new Error('The subtask stop was not confirmed')); }, 12000);
      timer?.unref?.(); this.childControls.set(requestId, { resolve, reject, timer });
      if (!this.write({ type: 'control_request', request_id: requestId, request: { subtype: 'stop_task', task_id: id } })) {
        this.childControls.delete(requestId); this.clearTimer(timer); reject(new Error('Claude input channel is closed'));
      }
    });
  }

  kill() {
    if (this.compaction) this.complete({ type: 'result', subtype: 'stopped', is_error: true, result: 'Claude process stopped during compaction' });
    this.dead = true;
    this.closed = true;
    this.running = false;
    this.permissions.clear();
    for (const pending of this.childControls.values()) { this.clearTimer(pending.timer); pending.reject(new Error('The subtask is no longer connected')); }
    this.childControls.clear();
    this.stdoutBuf = '';
    this.clearWatchdog();
    this.clearTimer(this.cancelTimer); this.cancelTimer = null;
    try { this.proc?.kill(); } catch { /* already gone */ }
  }
}

module.exports = { ClaudeSession };
