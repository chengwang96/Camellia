'use strict';

// Development launcher: runs Electron and hides only Chromium's per-request
// TLS handshake chatter. A background web preload can retry an unreachable
// host every few seconds and flood the terminal with identical lines. The
// desktop records the underlying failure itself and the web view shows its own
// error state, so no diagnostic is lost. Set CAMELLIA_DEV_VERBOSE=1 to see the
// raw lines again.
const { spawn } = require('node:child_process');
const electron = require('electron');
const { StringDecoder } = require('node:string_decoder');

// ERR_CONNECTION_CLOSED (-100) and ERR_CONNECTION_RESET (-101) during a TLS
// handshake. Other net_error values are different faults and stay visible.
const CHROMIUM_TLS_RETRY = /^\[[^\]]*:ERROR:net\\socket\\ssl_client_socket_impl\.cc:\d+\] handshake failed; returned -1, SSL error code \d+, net_error -(?:100|101)$/;

function isChromiumTlsRetry(line) {
  return CHROMIUM_TLS_RETRY.test(line.endsWith('\r') ? line.slice(0, -1) : line);
}

function filterStream(input, output, { verbose = false, endOutput = false } = {}) {
  if (verbose) {
    input.pipe(output, { end: endOutput });
    return () => input.unpipe(output);
  }
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const forward = line => {
    if (line !== '' && !isChromiumTlsRetry(line)) output.write(line + '\n');
  };
  const onData = chunk => {
    buffer += decoder.write(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) forward(line);
    // Chromium always terminates its log lines, but a writer that never does
    // must not turn this filter into an unbounded buffer.
    if (buffer.length > 64 * 1024) {
      forward(buffer);
      buffer = '';
    }
  };
  const onEnd = () => {
    buffer += decoder.end();
    if (buffer) forward(buffer);
    buffer = '';
    if (endOutput) output.end();
  };
  input.on('data', onData);
  input.on('end', onEnd);
  return () => {
    input.off('data', onData);
    input.off('end', onEnd);
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const verbose = process.env.CAMELLIA_DEV_VERBOSE === '1' || args.includes('--raw-output');
  const forwarded = args.filter(arg => arg !== '--raw-output');
  // The override exists so the launcher's filtering can be tested without
  // starting a real desktop window.
  const executable = process.env.CAMELLIA_DEV_ELECTRON || electron;
  const electronArgs = process.env.CAMELLIA_DEV_ELECTRON_SCRIPT
    ? [process.env.CAMELLIA_DEV_ELECTRON_SCRIPT, ...forwarded]
    : ['.', ...forwarded];
  const child = spawn(executable, electronArgs, {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: process.env,
  });
  let stopping = false;
  filterStream(child.stdout, process.stdout, { verbose });
  filterStream(child.stderr, process.stderr, { verbose });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      stopping = true;
      child.kill(signal);
    });
  }
  child.on('exit', (code, signal) => {
    if (stopping) process.exit(code ?? 0);
    if (!signal) process.exit(code ?? 0);
    try { process.kill(process.pid, signal); }
    catch { process.exit(1); }
  });
}

module.exports = { filterStream, isChromiumTlsRetry };
