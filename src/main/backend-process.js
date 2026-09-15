'use strict';

const net = require('node:net');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { StringDecoder } = require('node:string_decoder');

// A successful HTTP request is not a port-availability test: non-HTTP servers
// also occupy ports. Binding also lets port 0 request an ephemeral local port.
function probePort(host, port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', err => err.code === 'EADDRINUSE' ? resolve(null) : reject(err));
    server.listen({ host, port, exclusive: true }, () => {
      const selected = server.address().port;
      server.close(err => err ? reject(err) : resolve(selected));
    });
  });
}

async function pickPort({ host, port = 3000 }) {
  const base = Number(port);
  if (!Number.isInteger(base) || base < 0 || base > 65535) throw new Error("Backend port must be between 0 and 65535");
  for (let candidate = base; candidate <= Math.min(base + 39, 65535); candidate++) {
    const available = await probePort(host, candidate);
    if (available !== null) return available;
  }
  throw new Error(`Port ${base} has no available nearby ports. Choose another port in settings.`);
}

function requestPageStatus(url, signal) {
  return new Promise(resolve => {
    const req = http.get(url, { timeout: 1500, signal }, res => { res.resume(); resolve(res.statusCode || 0); });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0));
  });
}

class BackendProcess {
  constructor({ spawn, log = () => {}, selectPort = pickPort, probe = requestPageStatus, pollMs = 700 }) {
    Object.assign(this, { spawn, log, selectPort, probe, pollMs });
    this.current = null;
  }

  start(options) {
    if (this.current?.key === options.key) return this.current.promise;
    this.stop();
    const run = { key: options.key, abort: new AbortController(), proc: null };
    this.current = run;
    run.promise = this.startRun(run, options);
    return run.promise;
  }

  async startRun(run, options) {
    const signal = run.abort.signal;
    try {
      const port = await this.selectPort(options);
      signal.throwIfAborted();
      const url = `http://${options.host.includes(':') && !options.host.startsWith('[') ? '[' + options.host + ']' : options.host}:${port}`;
      let launchUrl = url, authenticated = false;
      const args = options.args(port);
      this.log(`spawning node="${options.exe}" args="${args.join(' ')}" DSH_HOME=${options.env.DSH_HOME}`);
      const proc = this.spawn(options.exe, args, { cwd: options.cwd, env: options.env, windowsHide: true });
      run.proc = proc;
      let tail = '';
      for (const name of ['stdout', 'stderr']) {
        const decoder = new StringDecoder('utf8');
        let lineBuffer = '';
        const consume = line => {
          const match = line.match(/^dsh web: (https?:\/\/\S+)/);
          if (match) {
            const announced = new URL(match[1]);
            if (announced.origin === url && announced.searchParams.has('token')) { launchUrl = announced.href; authenticated = true; }
          }
          const safe = line.replace(/([?&]token=)[^&\s)]+/g, '$1[redacted]');
          if (safe.trimEnd()) this.log(`[backend ${name}] ${safe.trimEnd()}`);
          tail = (tail + safe + '\n').slice(-8000);
        };
        proc[name].on('data', chunk => {
          lineBuffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          let end;
          while ((end = lineBuffer.indexOf('\n')) !== -1) { consume(lineBuffer.slice(0, end)); lineBuffer = lineBuffer.slice(end + 1); }
        });
        proc[name].on('end', () => { lineBuffer += decoder.end(); if (lineBuffer) consume(lineBuffer); });
      }
      const exited = new Promise((_resolve, reject) => {
        const end = err => {
          if (this.current === run) this.current = null;
          reject(err);
          run.abort.abort();
        };
        proc.once('error', err => end(new Error(`Failed to start dsh web: ${err.message}`)));
        proc.once('exit', (code, signame) => {
          this.log(`backend exited code=${code} signal=${signame || ''}`);
          end(new Error(`dsh web exited (code=${code}, signal=${signame || 'none'}).\n${tail.trim()}`));
        });
      });
      const poll = async () => {
        const deadline = Date.now() + options.timeoutMs;
        while (Date.now() < deadline) {
          signal.throwIfAborted();
          const status = await this.probe(launchUrl, signal);
          if (status === 200 || (authenticated && status === 303)) {
            signal.throwIfAborted();
            return { url: launchUrl, origin: url };
          }
          await delay(this.pollMs, undefined, { signal });
        }
        throw new Error(`dsh web did not become ready at ${url} within ${options.timeoutMs / 1000}s`);
      };
      return await Promise.race([exited, poll()]);
    } catch (err) {
      if (this.current === run) this.current = null;
      run.abort.abort();
      try { if (run.proc && !run.proc.killed) run.proc.kill(); } catch { /* already gone */ }
      throw err;
    }
  }

  stop() {
    const run = this.current;
    this.current = null;
    if (!run) return;
    run.abort.abort();
    try { if (run.proc && !run.proc.killed) run.proc.kill(); } catch { /* already gone */ }
  }
}

module.exports = { BackendProcess, pickPort };
