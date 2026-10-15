'use strict';

const { formatWithOptions } = require('node:util');
const installed = new WeakMap();
const closedOutput = error => ['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END'].includes(error?.code);

// Electron reports rejected IPC handlers through console.error. A launcher can
// close its stdout/stderr pipes while the desktop is still running, so logging
// must not turn that ordinary rejection into an uncaught main-process error.
function installDiagnosticOutput({ runtime = process, targetConsole = console } = {}) {
  if (installed.has(runtime)) return installed.get(runtime);
  const pending = [], restore = [];
  let logger, reporting = false, disposed = false, dropped = 0;
  function record(message) {
    if (reporting) return;
    message = message.slice(0, 16 * 1024);
    if (!logger) {
      if (pending.length === 32) { pending.shift(); dropped++; }
      pending.push(message);
      return;
    }
    reporting = true;
    try { logger(message); } catch { /* A diagnostic sink must never replace the original error. */ }
    finally { reporting = false; }
  }
  for (const name of ['stdout', 'stderr']) {
    const stream = runtime[name];
    if (!stream?.write || !stream.on) continue;
    const original = stream.write;
    let broken = false;
    function unavailable(error) {
      if (!broken) { broken = true; record(`Diagnostic ${name} closed (${error.code}); continuing with file logging.`); }
    }
    function onError(error) {
      if (closedOutput(error)) unavailable(error);
      else throw error;
    }
    function ignored(args) {
      const callback = args.at(-1);
      if (typeof callback === 'function') queueMicrotask(() => callback());
      return true;
    }
    function write(...args) {
      if (broken) return ignored(args);
      try { return original.apply(this, args); }
      catch (error) {
        if (!closedOutput(error)) throw error;
        unavailable(error);
        return ignored(args);
      }
    }
    stream.on('error', onError);
    stream.write = write;
    restore.push(() => { if (stream.write === write) stream.write = original; stream.removeListener('error', onError); });
  }
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    const original = targetConsole[method];
    if (typeof original !== 'function') continue;
    function write(...args) {
      let text;
      try { text = formatWithOptions({ depth: 4, maxStringLength: 16 * 1024, customInspect: false }, ...args); }
      catch { text = '[Unprintable console diagnostic]'; }
      record(`[console.${method}] ${text}`);
      try { return original.apply(this, args); }
      catch (error) {
        if (!closedOutput(error)) throw error;
        record(`Diagnostic console.${method} output closed (${error.code}); continuing with file logging.`);
      }
    }
    targetConsole[method] = write;
    restore.push(() => { if (targetConsole[method] === write) targetConsole[method] = original; });
  }
  const output = {
    setLogger(next) {
      logger = next;
      if (dropped) { record(`Dropped ${dropped} console diagnostics before file logging was ready.`); dropped = 0; }
      for (const message of pending.splice(0)) record(message);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const undo of restore.reverse()) undo();
      installed.delete(runtime);
    }
  };
  installed.set(runtime, output);
  return output;
}

module.exports = { installDiagnosticOutput };
