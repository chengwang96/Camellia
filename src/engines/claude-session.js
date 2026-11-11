'use strict';

const { StringDecoder } = require('node:string_decoder');
const { randomUUID } = require('node:crypto');
const { nativeMode } = require('./permission-levels');
const { NativeSubagents, ACTIVE, nativeStatus, contentText } = require('./native-subagents');
const { claudeEditBoundary } = require('./native-edit-boundary');
const { BackgroundTaskMonitor } = require('./background-task-monitor');
const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'stopped']);

// Owns one CLI process. Application state stays in main; the callbacks below
// also make process failures and fragmented output testable without Electron.
class ClaudeSession {
  constructor({ gen, settings, opts, exe, spec, spawn, log = () => {}, onEvent, onSessionId, onResult,
    setTimer = setTimeout, clearTimer = clearTimeout, nativeHistory }) {
    Object.assign(this, { gen, settings, opts, exe, spec, spawn, log, onEvent, onSessionId, onResult, setTimer, clearTimer, nativeHistory });
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
    this.subagents = new NativeSubagents('claude', (task, replacesIds) => {
      for (const request of this.permissions.values()) if (replacesIds?.includes(request.subagentId)) request.subagentId = task.id;
      for (const [key, id] of this.childTools || []) if (replacesIds?.includes(id)) this.childTools.set(key, task.id);
      this.sendChannel({ type: 'gui:subagent', task, ...(replacesIds ? { replacesIds } : {}) });
    });
    this.children = this.subagents.children;
    this.childTools = new Map();
    this.agentCalls = new Map();
    this.childControls = new Map();
    this.backgroundTasks = new Map();
    this.endedBackgroundTasks = new Map();
    this.backgroundRuns = new Map();
    this.foregroundTasks = new Set();
    this.backgroundMonitor = new BackgroundTaskMonitor({ tasks: this.backgroundTasks,
      closed: () => this.dead || this.closed, log: message => this.log('claude: ' + message),
      read: (_ids, signal) => this.readBackgroundTasks(signal),
      apply: (id, task) => this.reconcileBackgroundTask(id, task), publish: () => this.publishBackgroundTasks() });
  }

  start() {
    const { exe, spec } = this;
    // Print mode otherwise denies operations that need approval without ever
    // sending can_use_tool to our existing permission handler.
    const args = spec.args.includes('--permission-prompt-tool') ? [...spec.args] : [...spec.args, '--permission-prompt-tool', 'stdio'];
    // In the app, Allow all is the user's chosen execution mode. EnterPlanMode
    // silently replaces it with read-only planning inside a persistent CLI.
    // Keep this UI choice stable; users can still select Plan only themselves.
    const disallowedTools = [];
    if (this.opts.lockPermissionMode && nativeMode('claude', this.settings.permissionMode) === 'bypassPermissions') disallowedTools.push('EnterPlanMode');
    if (this.opts.goalBridge?.webTools) disallowedTools.push('WebSearch', 'WebFetch');
    if (disallowedTools.length) args.push('--disallowedTools', disallowedTools.join(','));
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
      this.backgroundMonitor.stop();
      this.clearBackgroundTasks();
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

  editBoundary(prompt) {
    return claudeEditBoundary(this.nativeHistory?.find(this.sessionId), prompt, this.userMessageId);
  }

  complete(obj) {
    if (!this.running) return;
    if (!this.compaction && !this.cancelled && obj.subtype === 'success' && !obj.is_error && !this.turnHasActivity && !String(obj.result || '').trim()) {
      obj = { ...obj, subtype: 'empty_response', is_error: true, result: 'Claude returned no reply or tool activity.' };
    }
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

  // A native task-notification user event with no turn in progress means the
  // CLI is resuming the conversation by itself after background work ended.
  // Adopt that turn so its events reach a live run instead of being discarded.
  adoptBackgroundTurn(obj) {
    if (this.running || this.cancelled || this.dead) return false;
    const origin = obj.origin?.kind || obj.turnOrigin || '';
    if (!/^task[-_]notification$/.test(origin)
        && !/^\s*<task-notification>/.test(contentText(obj.message?.content))) return false;
    this.running = true;
    this.turnHasActivity = false;
    this.subagents.begin(); this.agentCalls.clear();
    this.log('claude: adopting native background turn');
    this.sendChannel({ type: 'gui:background-turn', session_id: this.sessionId });
    return true;
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
      if (obj.response?.request_id === this.backgroundRead?.requestId) {
        if (obj.response.subtype === 'success') this.backgroundRead.acknowledged = true;
        else this.backgroundRead.reject(new Error('Native background task refresh was rejected'));
        return;
      }
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
    const content = obj.message?.content, parentEvent = !obj.parent_tool_use_id && !obj.agent_id;
    if (parentEvent && obj.type === 'assistant' && Array.isArray(content) && content.some(block =>
      ['tool_use', 'server_tool_use'].includes(block.type) || block.type === 'text' && String(block.text || '').trim())) this.turnHasActivity = true;
    if (parentEvent && obj.type === 'stream_event' && obj.event?.delta?.type === 'text_delta' && String(obj.event.delta.text || '').trim()) this.turnHasActivity = true;
    if (obj.type === 'result') { this.complete(obj); return; }
    if (obj.type === 'system' && obj.subtype === 'compact_boundary') {
      if (this.compaction) this.compaction.boundary = true;
      else this.sendChannel({ type: 'gui:compaction', state: 'completed' });
    }
    if (obj.type === 'system' && obj.subtype === 'background_tasks_changed') {
      // A repeated initialize requests a read-only level snapshot. Reconcile
      // that response only with tasks that existed before this asynchronous
      // read, so it cannot remove work started by a newer live event.
      if (this.backgroundRead?.acknowledged) {
        if (!Array.isArray(obj.tasks)) this.backgroundRead.reject(new Error('Invalid native background task snapshot'));
        else this.backgroundRead.resolve(obj.tasks.map(task => ({ id: task.task_id, description: task.description,
          kind: task.task_type, nativeRunId: task.run_id, status: nativeStatus(task.status) || 'running' })));
        return;
      }
      if (!Array.isArray(obj.tasks)) return;
      const missing = new Set(this.backgroundTasks.keys());
      for (const task of obj.tasks) {
        if (!task || typeof task.task_id !== 'string' || !task.task_id) continue;
        missing.delete(task.task_id);
        const newRun = this.acceptBackgroundRun(task.task_id, task.run_id);
        if (newRun === null) continue;
        const status = this.observeBackgroundTask(task.task_id, { ...task, newRun, is_backgrounded: true });
        if (task.task_type && !/agent|workflow|teammate/.test(task.task_type)) continue;
        this.subagents.native(task.task_id, { title: task.description, status, canReply: false, canStop: ACTIVE.has(status),
          ...(task.run_id ? { turnId: task.run_id } : !this.children.has(this.subagents.resolve(task.task_id)) ? { turnId: 'child-start-' + ++this.controlSeq } : {}),
          ...(newRun ? { result: '', approvals: [] } : {}) });
      }
      for (const id of missing) {
        this.backgroundTasks.delete(id);
        const child = this.children.get(this.subagents.resolve(id));
        // A full snapshot proves this task is no longer tracked, not that it
        // succeeded. A later native notification may still supply its result.
        if (child && ACTIVE.has(child.status)) this.childUpdate(child.id, { status: 'unavailable', canStop: false, approvals: [] });
      }
      this.publishBackgroundTasks();
      return;
    }
    if (obj.type === 'system' && ['task_started', 'task_progress', 'task_notification', 'task_updated'].includes(obj.subtype) && obj.task_id) {
      const newRun = this.acceptBackgroundRun(obj.task_id, obj.run_id);
      if (newRun === null) return;
      const native = { ...obj, ...obj.patch };
      if (!native.status && (newRun || ['task_started', 'task_progress'].includes(obj.subtype))) {
        const child = this.children.get(this.subagents.resolve(obj.task_id));
        native.status = !newRun && ACTIVE.has(child?.status) ? child.status : 'running';
      }
      const status = this.observeBackgroundTask(obj.task_id, { ...native, newRun });
      this.publishBackgroundTasks();
      if (this.endedBackgroundTasks.has(obj.task_id) && !TERMINAL_TASK_STATES.has(nativeStatus(native.status))) return;
      if (obj.task_type && !/agent|workflow|teammate/.test(obj.task_type)) return;
      const known = this.subagents.resolve(obj.task_id);
      if (obj.subtype !== 'task_started' && !this.children.has(known) && !obj.subagent_type && !this.agentCalls.has(obj.tool_use_id)) return;
      const task = this.subagents.native(obj.task_id, { toolCallId: obj.tool_use_id,
        ...(obj.parent_task_id ? { parentId: obj.parent_task_id } : {}),
        ...(obj.run_id ? { turnId: obj.run_id } : obj.subtype === 'task_started' ? { turnId: 'child-start-' + ++this.controlSeq } : {}),
        ...(newRun ? { result: '', approvals: [] } : {}),
        title: obj.description || undefined, goal: obj.subtype === 'task_started' ? obj.prompt || obj.description : undefined,
        progress: obj.summary || obj.description || undefined,
        status, ...(status === 'completed' ? { result: obj.summary || undefined } : {}),
        canReply: false, canStop: ['starting', 'running', 'waiting'].includes(status),
        history: [...(this.children.get(known)?.history || []), { type: obj.subtype, text: obj.summary || obj.description || native.status || '' }],
        ...(!['starting', 'running', 'waiting'].includes(status) ? { approvals: [] } : {}),
      });
      if (task && obj.tool_use_id) this.childTools.set(obj.tool_use_id, task.id);
      return;
    }
    // Context compaction hides its own transcript, but must not hide lifecycle
    // events from work that continues independently of that operation.
    if (this.compaction) return;
    // The notification itself is forwarded below so the run records the
    // native trigger; the events after it belong to the adopted turn.
    if (obj.type === 'user') this.adoptBackgroundTurn(obj);
    if (obj.parent_tool_use_id || obj.agent_id) {
      const id = this.subagents.resolve(obj.agent_id || this.childTools.get(obj.parent_tool_use_id));
      if (id && this.children.has(id)) {
        const text = obj.message?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') || obj.event?.delta?.text;
        if (text) this.childUpdate(id, { progress: text, history: [...(this.children.get(id).history || []), { type: obj.type, text }] });
      }
      return;
    }
    this.observeAgentTools(obj);
    this.sendChannel(obj);
  }

  observeAgentTools(obj) {
    if (!Array.isArray(obj.message?.content)) return;
    for (const block of obj.message.content) {
      if (obj.type === 'assistant' && block.type === 'tool_use' && ['Agent', 'Task'].includes(block.name)) {
        const tool = { id: block.id, name: block.name, input: block.input, status: 'in_progress' };
        this.agentCalls.set(block.id, tool);
        this.subagents.observe(tool);
        this.childTools.set(block.id, this.subagents.calls.get(block.id)?.ids[0]);
      } else if (obj.type === 'user' && block.type === 'tool_result' && this.agentCalls.has(block.tool_use_id)) {
        const tool = { ...this.agentCalls.get(block.tool_use_id), output: contentText(block.content),
          status: block.is_error ? 'failed' : 'completed', is_error: block.is_error === true };
        this.subagents.observe(tool, { rawOutput: obj.tool_use_result || block.tool_use_result });
      }
    }
  }

  onControlRequest(msg) {
    const req = msg.request || {};
    if (req.subtype === 'initialize') {
      this.initialized = true;
      this.clearWatchdog();
      this.answer(msg.request_id, {});
    } else if (req.subtype === 'can_use_tool') {
      const childId = typeof req.agent_id === 'string' ? this.subagents.resolve(req.agent_id) : null;
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
    this.subagents.begin(); this.agentCalls.clear();
    const content = [{ type: 'text', text }];
    const { IMAGE_TYPES } = require('./discussions/assets');
    for (const file of attachments) if (file.isImage) {
      const media_type = IMAGE_TYPES[require('node:path').extname(file.path).toLowerCase()];
      if (!media_type) throw new Error('Unsupported image format');
      content.push({ type: 'image', source: { type: 'base64', media_type, data: require('node:fs').readFileSync(file.path).toString('base64') } });
    }
    this.turnHasActivity = false;
    this.cancelled = false;
    this.running = true;
    if (!this.initialized) {
      this.watchdog = this.setTimer(() => this.fail('session_timeout', "Claude did not initialize within 25 seconds (stream-json handshake failed)."), 25_000);
    }
    // The CLI may persist this input only after its first model response.
    // Its identity prevents an earlier identical request supplying our cut.
    this.userMessageId = randomUUID();
    return this.write({ type: 'user', uuid: this.userMessageId, message: { role: 'user', content } });
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
    return this.subagents.update(id, update);
  }

  observeBackgroundTask(id, task) {
    if (typeof id !== 'string' || !id) return;
    const child = this.children.get(this.subagents.resolve(id));
    if (task.newRun || task.is_backgrounded === true) this.foregroundTasks.delete(id);
    else if (task.is_backgrounded === false) this.foregroundTasks.add(id);
    let ended = task.newRun ? null : this.endedBackgroundTasks.get(id);
    // An explicit Agent resume starts another turn of the same native child.
    // Only that new tool-call identity can supersede a terminal receipt.
    if (ended && ACTIVE.has(child?.status) && child.turnId && child.turnId !== ended.turnId) {
      this.endedBackgroundTasks.delete(id); ended = null;
    }
    const status = ended?.status || (!task.newRun && TERMINAL_TASK_STATES.has(child?.status) ? child.status : null)
      || nativeStatus(task.status) || (ACTIVE.has(child?.status) ? child.status : this.backgroundTasks.get(id)?.status) || 'running';
    if (TERMINAL_TASK_STATES.has(status)) {
      this.backgroundTasks.delete(id);
      // Keep bounded terminal receipts so delayed progress/snapshots cannot
      // revive an ended native task or an agent's previous turn.
      this.endedBackgroundTasks.set(id, { status, turnId: child?.turnId });
      if (this.endedBackgroundTasks.size > 2048) this.endedBackgroundTasks.delete(this.endedBackgroundTasks.keys().next().value);
      this.foregroundTasks.delete(id);
    } else if (status === 'unavailable' || this.foregroundTasks.has(id)) this.backgroundTasks.delete(id);
    else this.backgroundTasks.set(id, { id, description: String(task.description || this.backgroundTasks.get(id)?.description || '').slice(0, 500),
      kind: task.task_type || this.backgroundTasks.get(id)?.kind || '', status, canStop: true });
    return status;
  }

  acceptBackgroundRun(id, runId) {
    if (typeof runId !== 'string' || !runId) return false;
    const previous = this.backgroundRuns.get(id);
    // The CLI contract orders run IDs lexically; a resumed task keeps its ID.
    if (previous && runId < previous) return null;
    const newRun = Boolean(previous && runId > previous);
    this.backgroundRuns.set(id, runId);
    if (this.backgroundRuns.size > 2048) this.backgroundRuns.delete(this.backgroundRuns.keys().next().value);
    if (newRun) this.endedBackgroundTasks.delete(id);
    return newRun;
  }

  publishBackgroundTasks() {
    this.sendChannel({ type: 'gui:background-work', tasks: [...this.backgroundTasks.values()] });
    this.backgroundMonitor.changed();
  }

  readBackgroundTasks(signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted || this.dead || this.closed) { reject(new Error('Native background task status is unavailable')); return; }
      const requestId = 'gui-background-' + ++this.controlSeq;
      const finish = (callback, value) => {
        if (this.backgroundRead?.requestId !== requestId) return;
        this.backgroundRead = null;
        signal.removeEventListener('abort', abort);
        callback(value);
      };
      const abort = () => finish(reject, new Error('Native background task refresh timed out'));
      this.backgroundRead = { requestId, acknowledged: false,
        resolve: rows => finish(resolve, rows), reject: error => finish(reject, error) };
      signal.addEventListener('abort', abort, { once: true });
      // The CLI's repeated-initialize contract sends a full live-task snapshot
      // immediately after its success response, even when the set is empty.
      if (!this.write({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } })) abort();
    });
  }

  reconcileBackgroundTask(id, task) {
    const child = this.children.get(this.subagents.resolve(id));
    const status = task.status === 'running' && child?.approvals?.length ? 'waiting' : task.status;
    const newRun = this.acceptBackgroundRun(id, task.nativeRunId);
    if (newRun === null) return;
    if (status === 'unavailable') this.backgroundTasks.delete(id);
    else if (status === 'unknown') this.backgroundTasks.set(id, { ...this.backgroundTasks.get(id), status });
    else this.observeBackgroundTask(id, { status, description: task.description, task_type: task.kind, newRun });
    if (!child || !newRun && TERMINAL_TASK_STATES.has(child.status)) return;
    if (status === 'unknown' && child.approvals?.length) return;
    this.childUpdate(child.id, { status: status === 'unknown' ? 'unavailable' : status,
      ...(task.nativeRunId ? { turnId: task.nativeRunId } : {}), ...(newRun ? { result: '', approvals: [] } : {}),
      canStop: ACTIVE.has(status), ...(!ACTIVE.has(status) ? { approvals: [] } : {}) });
  }
  clearBackgroundTasks() {
    if (!this.backgroundTasks.size) return;
    this.backgroundTasks.clear(); this.publishBackgroundTasks();
  }

  async stopBackgroundTasks(taskIds) {
    if (this.dead || this.closed) throw new Error('Background tasks are no longer connected');
    await Promise.all(taskIds.filter(id => this.backgroundTasks.has(id)).map(id => this.stopNativeTask(id)));
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
    return this.stopNativeTask(this.subagents.nativeId(id));
  }

  async stopNativeTask(taskId) {
    const requestId = 'gui-child-' + ++this.controlSeq;
    await new Promise((resolve, reject) => {
      const timer = this.setTimer(() => { this.childControls.delete(requestId); reject(new Error('The subtask stop was not confirmed')); }, 12000);
      timer?.unref?.(); this.childControls.set(requestId, { resolve, reject, timer });
      if (!this.write({ type: 'control_request', request_id: requestId, request: { subtype: 'stop_task', task_id: taskId } })) {
        this.childControls.delete(requestId); this.clearTimer(timer); reject(new Error('Claude input channel is closed'));
      }
    });
  }

  kill() {
    this.backgroundMonitor.stop();
    this.clearBackgroundTasks();
    if (this.compaction) this.complete({ type: 'result', subtype: 'stopped', is_error: true, result: 'Claude process stopped during compaction' });
    this.dead = true;
    this.subagents.disconnect();
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
