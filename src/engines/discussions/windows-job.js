'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Writable, PassThrough } = require('node:stream');
const { createInterface } = require('node:readline');
const { spawn } = require('node:child_process');
const { WindowsJobJournal, jobIdentity } = require('./windows-job-journal');

const BOOTSTRAP = "$ErrorActionPreference = 'Stop'; [Console]::InputEncoding = [Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine()))) -ReferencedAssemblies System.Web.Extensions; [Camellia.Discussions.WindowsJob]::Run()";
const MAX_OUTPUT = 8 * 1024 * 1024;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
};

// Private, per-delivery Windows 10+ supervisor. It contains CreateProcess
// descendants and independently queries job membership after termination.
// This is not a read-only policy or an IPC authority. Persistent records are
// allocated before the helper is launched, and never reused for another launch.
async function prepareWindowsJob({ identity, journal, signal, timeoutMs = 25000 }) {
  if (process.platform !== 'win32') throw new Error('Windows job supervision is unavailable on this platform');
  const scope = jobIdentity(identity);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new Error('Invalid job supervisor timeout');
  if (signal?.aborted) throw Object.assign(new Error('Discussion activity cancelled'), { name: 'AbortError' });
  if (!(journal instanceof WindowsJobJournal)) throw new Error('A trusted job launch journal is required');
  const source = fs.readFileSync(path.join(__dirname, 'windows-job.cs')).toString('base64');
  const record = journal.reserve(scope);
  const nonce = randomUUID(), ready = deferred(), confirmed = deferred();
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const host = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(BOOTSTRAP, 'utf16le').toString('base64')],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let proc, sealed = false, proof, broken, stopping, hostClosed = false, readyReceived = false, exitReceived = false;
  let diagnostics = '';
  const lines = createInterface({ input: host.stdout });
  const send = message => {
    if (hostClosed || host.stdin.destroyed || host.stdin.writableEnded) throw new Error('Job supervisor is unavailable');
    return host.stdin.write(JSON.stringify({ ...message, nonce }) + '\n');
  };
  const failProcess = error => {
    if (!proc || proc.failed) return;
    proc.failed = true;
    // Driver listeners are installed immediately after spawn returns.
    queueMicrotask(() => proc.emit('error', error));
  };
  const invalid = error => {
    broken ||= error; sealed = true;
    ready.reject(error); confirmed.reject(error); failProcess(error);
    host.kill();
  };
  const abort = () => { void stop().catch(() => {}); };
  const timeout = setTimeout(() => invalid(new Error('Job supervisor preparation timed out')), timeoutMs);
  function closeProcess() {
    if (!proc || proc.closed) return;
    proc.closed = true; proc.stdout.end(); proc.stderr.end();
    if (proc.exitCode === null) proc.exitCode = -1;
    proc.emit('close', proc.exitCode, null);
  }
  lines.on('line', line => {
    try {
      const event = JSON.parse(line);
      if (event.nonce !== nonce || broken) throw new Error('Invalid job supervisor event');
      if (event.type === 'failure') {
        const error = new Error('Job supervisor: ' + String(event.message).slice(0, 500));
        failProcess(error);
        if (!readyReceived) ready.reject(error);
      } else if (event.type === 'ready') {
        if (readyReceived) throw new Error('Repeated job supervisor readiness');
        readyReceived = true; clearTimeout(timeout); ready.resolve();
      } else if (!readyReceived) throw new Error('Job supervisor was not prepared');
      else if (event.type === 'spawned') {
        if (!proc || proc.pid || !Number.isSafeInteger(event.pid) || event.pid <= 0) throw new Error('Invalid supervised process identity');
        proc.pid = event.pid; proc.emit('spawn');
      } else if (event.type === 'stdout' || event.type === 'stderr') {
        if (!proc || !proc.pid || typeof event.data !== 'string') throw new Error('Invalid supervised output');
        const stream = proc[event.type];
        if (stream.readableLength + stream.writableLength > MAX_OUTPUT) {
          failProcess(new Error('Supervised output exceeded the unread buffer limit')); abort();
        } else stream.write(Buffer.from(event.data, 'base64'));
      } else if (event.type === 'exit') {
        if (!proc?.pid || exitReceived || !Number.isSafeInteger(event.code) || event.code < 0) throw new Error('Invalid supervised exit');
        exitReceived = true; proc.exitCode = event.code; proc.emit('exit', event.code, null);
      } else if (event.type === 'stopped') {
        if (proof || event.sealed !== true || event.activeProcesses !== 0 || !Number.isSafeInteger(event.totalProcesses)
          || event.totalProcesses < 0 || proc?.pid && !exitReceived) throw new Error('Invalid job stop proof');
        sealed = true;
        proof = Object.freeze({ ...scope, stopped: true, kind: 'windows-job', activeProcesses: 0,
          totalProcesses: event.totalProcesses, supervisorPid: host.pid, rootPid: proc?.pid || null });
        closeProcess(); host.stdin.end();
      } else throw new Error('Unknown job supervisor event');
    } catch (error) { invalid(error); }
  });
  host.stderr.on('data', data => { diagnostics = (diagnostics + data.toString()).slice(-1500); });
  host.on('error', invalid);
  host.stdin.on('error', error => { if (!proof) invalid(error); });
  host.once('close', code => {
    hostClosed = true; sealed = true; clearTimeout(timeout); signal?.removeEventListener('abort', abort); lines.close();
    if (!broken && proof && code === 0) confirmed.resolve(proof);
    else {
      const error = broken || new Error('Job supervisor exited without verified stop' + (diagnostics ? ': ' + diagnostics : ''));
      broken = error; ready.reject(error); confirmed.reject(error); failProcess(error);
    }
    closeProcess();
  });
  function stop() {
    if (stopping) return stopping;
    sealed = true;
    stopping = (async () => {
      await ready.promise;
      if (!proof && !hostClosed) send({ type: 'stop' });
      let timer;
      try {
        return await Promise.race([confirmed.promise, new Promise((_, reject) => {
          timer = setTimeout(() => { const error = new Error('Job stop could not be confirmed'); invalid(error); reject(error); }, timeoutMs);
        })]);
      } finally { clearTimeout(timer); }
    })();
    stopping.catch(() => {});
    return stopping;
  }
  signal?.addEventListener('abort', abort, { once: true });
  host.stdin.write(source + '\n');
  send({ type: 'initialize', ...record });
  await ready.promise;
  if (signal?.aborted) { await stop(); throw Object.assign(new Error('Discussion activity cancelled'), { name: 'AbortError' }); }
  function spawnProcess(exe, args, options) {
    if (sealed || proc) throw new Error('Job launcher is stopped or already used');
    if (typeof exe !== 'string' || !path.isAbsolute(exe) || exe.includes('\0') || !Array.isArray(args)
      || args.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !path.isAbsolute(options?.cwd || '')
      || options.cwd.includes('\0') || !options.env || typeof options.env !== 'object' || Array.isArray(options.env)
      || Object.entries(options.env).some(([key, value]) => !key || /[=\0]/.test(key) || typeof value !== 'string' || value.includes('\0'))
      || new Set(Object.keys(options.env).map(key => key.toLowerCase())).size !== Object.keys(options.env).length
      || options.shell || options.detached || options.windowsVerbatimArguments
      || JSON.stringify(options.stdio) !== '["pipe","pipe","pipe"]') throw new Error('Invalid supervised process launch');
    proc = new EventEmitter();
    // ensure() can throw before a driver has returned/attached its listeners.
    // Keep that startup failure contained; stop still requires the job proof.
    proc.on('error', () => {});
    Object.assign(proc, { pid: undefined, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
    proc.stdin = new Writable({ write(chunk, encoding, done) {
      try {
        if (sealed) throw new Error('Supervised process is stopping');
        for (let offset = 0; offset < chunk.length; offset += 65536) send({ type: 'input', data: chunk.subarray(offset, offset + 65536).toString('base64') });
        done();
      } catch (error) { done(error); }
    }, final(done) {
      try { if (!sealed) send({ type: 'end' }); done(); } catch (error) { done(error); }
    } });
    proc.kill = () => { abort(); return true; };
    send({ type: 'spawn', exe, args, cwd: options.cwd, env: options.env });
    return proc;
  }
  return Object.freeze({ identity: scope, spawn: spawnProcess, stop, supervisorPid: host.pid });
}

// Only a trusted startup/recovery coordinator should call this, with dispatch
// fenced and the journal used for the original delivery. A missing record is
// not proof of no launch, and the result does not release any session-pool slot.
async function recoverWindowsJob({ identity, journal, timeoutMs = 30000 }) {
  if (process.platform !== 'win32') throw new Error('Windows job recovery is unavailable on this platform');
  const scope = jobIdentity(identity);
  if (!(journal instanceof WindowsJobJournal) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new Error('Invalid job recovery journal or timeout');
  const record = journal.read(scope), nonce = randomUUID();
  const source = fs.readFileSync(path.join(__dirname, 'windows-job.cs')).toString('base64');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const host = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(BOOTSTRAP, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: host.stdout });
    let proof, failure, diagnostics = '';
    const fail = error => { failure ||= error; host.kill(); };
    const timer = setTimeout(() => fail(new Error('Job recovery could not be confirmed')), timeoutMs);
    host.on('error', fail); host.stdin.on('error', fail);
    host.stderr.on('data', data => { diagnostics = (diagnostics + data.toString()).slice(-1500); });
    lines.on('line', line => {
      try {
        const event = JSON.parse(line);
        if (event.nonce !== nonce || proof) throw new Error('Invalid job recovery identity');
        if (event.type === 'failure') throw new Error('Job recovery: ' + String(event.message).slice(0, 500));
        if (event.type !== 'recovered' || event.sealed !== true || event.activeProcesses !== 0
          || typeof event.jobAbsent !== 'boolean' || !Number.isSafeInteger(event.totalProcesses) || event.totalProcesses < 0) throw new Error('Invalid job recovery proof');
        proof = Object.freeze({ ...scope, stopped: true, kind: 'windows-job-recovery', sealed: true,
          activeProcesses: 0, totalProcesses: event.totalProcesses, jobAbsent: event.jobAbsent });
      } catch (error) { fail(error); }
    });
    host.once('close', code => {
      clearTimeout(timer); lines.close();
      if (failure || !proof || code !== 0) reject(failure || new Error('Job recovery exited without proof' + (diagnostics ? ': ' + diagnostics : '')));
      else resolve(proof);
    });
    host.stdin.end(source + '\n' + JSON.stringify({ type: 'recover', nonce, ...record }) + '\n');
  });
}

module.exports = { prepareWindowsJob, recoverWindowsJob };
