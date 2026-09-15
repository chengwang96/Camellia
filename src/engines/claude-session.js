'use strict';

const { StringDecoder } = require('node:string_decoder');

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
    this.stdoutBuf = '';
    this.stdoutDecoder = new StringDecoder('utf8');
    this.stderrDecoder = new StringDecoder('utf8');
    this.controlSeq = 0;
    this.permissions = new Map();
  }

  start() {
    const { exe, spec } = this;
    this.log(`claude: persistent session gen=${this.gen} resume=${this.opts.sessionId || (this.opts.resumeLast ? 'last' : 'no')} ${spec.args.join(' ')}`);
    const proc = this.spawn(exe, spec.args, { cwd: spec.cwd, env: spec.env, windowsHide: true, shell: exe === 'claude' });
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
      this.emitLine(line);
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
    this.permissions.clear();
    this.rememberSession(obj.session_id);
    const result = { ...obj, session_id: this.sessionId };
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
    if (obj.type === 'control_response') return;
    if (obj.type === 'system' && obj.subtype === 'init') {
      this.initialized = true;
      this.clearWatchdog();
      this.rememberSession(obj.session_id);
    }
    if (obj.type === 'result') { this.complete(obj); return; }
    this.sendChannel(obj);
  }

  onControlRequest(msg) {
    const req = msg.request || {};
    if (req.subtype === 'initialize') {
      this.initialized = true;
      this.clearWatchdog();
      this.answer(msg.request_id, {});
    } else if (req.subtype === 'can_use_tool') {
      this.permissions.set(msg.request_id, req.input || {});
      this.sendChannel({ type: 'gui:permission', requestId: msg.request_id, toolName: req.tool_name || '',
        input: req.input || {}, permissionSuggestions: req.permission_suggestions || null });
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
    const originalInput = this.permissions.get(requestId);
    this.permissions.delete(requestId);
    return this.answer(requestId, allow
      ? { behavior: 'allow', updatedInput: input ?? originalInput }
      : { behavior: 'deny', message: message || "The user denied this action in the desktop interface" });
  }

  sendUserMessage(text) {
    if (this.dead || this.running) return false;
    this.running = true;
    if (!this.initialized) {
      this.watchdog = this.setTimer(() => this.fail('session_timeout', "Claude did not initialize within 25 seconds (stream-json handshake failed)."), 25_000);
    }
    return this.write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
  }

  interrupt() {
    return this.write({ type: 'control_request', request_id: `gui-interrupt-${++this.controlSeq}`, request: { subtype: 'interrupt' } });
  }

  clearWatchdog() { this.clearTimer(this.watchdog); this.watchdog = null; }

  kill() {
    this.dead = true;
    this.closed = true;
    this.running = false;
    this.permissions.clear();
    this.stdoutBuf = '';
    this.clearWatchdog();
    try { this.proc?.kill(); } catch { /* already gone */ }
  }
}

module.exports = { ClaudeSession };
