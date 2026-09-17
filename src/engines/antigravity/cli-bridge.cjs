'use strict';

// Standalone ACP adapter for the official CLI's documented stream-json mode.
// It runs under bundled Node, including outside Electron's asar filesystem.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

const config = JSON.parse(process.env.CAMELLIA_ANTIGRAVITY_CLI);
const env = { ...process.env };
delete env.CAMELLIA_ANTIGRAVITY_CLI;
let session, sessionFile, model, mode = 'default', cli, pending, streamed = '', previousUsage = {};
let canceled = false, closed, cliError;
const write = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const update = value => write({ method: 'session/update', params: { sessionId: session.id, update: value } });
const text = value => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } });
function saveSession() {
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, JSON.stringify(session) + '\n');
}
function finish(error, value) {
  if (!pending) return;
  const current = pending;
  pending = null;
  if (canceled) current.resolve({ stopReason: 'cancelled' });
  else if (error) current.reject(error);
  else current.resolve(value);
}
function receive(event) {
  if (event.event === 'init') {
    session.conversationId = event.conversation_id;
    saveSession();
  } else if (event.event === 'step_update' && pending) {
    const step = event.step_update;
    if (step.step_type === 'agent_response' && step.text_delta) { streamed += step.text_delta; text(step.text_delta); }
    else if (step.step_type !== 'agent_response' && step.step_type !== 'user_input') {
      update({ sessionUpdate: 'tool_call_update', toolCallId: String(step.step_index),
        title: step.step_type.replace(/_/g, ' '), status: step.state === 'DONE' ? 'completed' : 'in_progress',
        content: step.text_delta ? [{ type: 'content', content: { type: 'text', text: step.text_delta } }] : [] });
    }
  } else if (event.event === 'result' && pending) {
    const result = event.result;
    // Native counters accumulate across turns in one stream-json process.
    const usage = Object.fromEntries(Object.entries(result.usage || {}).map(([key, value]) => [key, Math.max(0, value - (previousUsage[key] || 0))]));
    previousUsage = result.usage || {};
    if (result.response?.startsWith(streamed) && result.response.length > streamed.length) text(result.response.slice(streamed.length));
    if (result.status === 'SUCCESS') finish(null, { stopReason: 'end_turn', usage });
    else if (['CANCELED', 'INTERRUPTED'].includes(result.status)) finish(null, { stopReason: 'cancelled', usage });
    else { cliError = new Error(result.error || `Antigravity: ${result.status}`); void stopCli(); }
  }
}
function startCli() {
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--model', model];
  if (session.conversationId) args.push('--conversation', session.conversationId);
  if (mode === 'bypassPermissions') args.push('--mode', 'accept-edits', '--dangerously-skip-permissions');
  else if (mode !== 'default') args.push('--mode', mode === 'acceptEdits' ? 'accept-edits' : mode);
  cli = spawn(config.exe, args, { cwd: session.cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  const child = cli;
  let errorText = '';
  cliError = null;
  previousUsage = {};
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    try { receive(JSON.parse(line)); }
    catch (error) { cliError = error; void stopCli(); }
  });
  child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-4000); process.stderr.write(chunk); });
  child.once('error', error => finish(error));
  child.stdin.on('error', error => finish(error));
  closed = new Promise(resolve => child.once('close', code => {
    lines.close();
    if (cli === child) cli = null;
    finish(cliError || new Error(errorText.trim() || `Antigravity CLI exited (${code})`));
    resolve();
  }));
}
async function stopCli() {
  if (!cli) return;
  const child = cli;
  // Stop this CLI's tools as well as the CLI itself; never target other sessions.
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    killer.once('error', () => child.kill());
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  await closed;
}
async function handle(method, params) {
  if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: 'Antigravity CLI', version: '1' } };
  if (method === 'session/fork') throw new Error('The official Antigravity CLI does not support forks in headless mode. Start a new session instead.');
  if (method === 'session/new' || method === 'session/resume') {
    const id = method === 'session/new' ? 'agy-' + randomUUID() : params.sessionId;
    if (!/^agy-[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid Google subscription session');
    sessionFile = path.join(config.home, 'cli-sessions', id + '.json');
    session = method === 'session/new' ? { id, cwd: params.cwd } : JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    if (method === 'session/new') saveSession();
    return { sessionId: id };
  }
  if (method === 'session/set_config_option') {
    if (params.configId === 'model') model = params.value;
    return { configOptions: [] };
  }
  if (method === 'session/set_mode') { mode = params.modeId; return {}; }
  if (method === 'session/prompt') {
    if (pending) throw new Error('A response is already running');
    if (params.prompt.some(part => part.type !== 'text')) throw new Error('Google subscription chat currently supports text and file paths, not image input.');
    canceled = false; streamed = '';
    if (!cli) startCli();
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
      cli.stdin.write(JSON.stringify({ event: 'user', message: { content: params.prompt } }) + '\n');
    });
  }
  if (method === 'session/cancel') { canceled = true; await stopCli(); return {}; }
  if (method === 'session/close') { canceled = true; await stopCli(); return {}; }
  throw new Error('Unsupported ACP method: ' + method);
}
const input = readline.createInterface({ input: process.stdin });
input.on('line', async line => {
  let request;
  try {
    request = JSON.parse(line);
    const result = await handle(request.method, request.params || {});
    if (request.id !== undefined) write({ id: request.id, result });
  } catch (error) {
    if (request?.id !== undefined) write({ id: request.id, error: { code: -32603, message: error.message } });
  }
});
input.once('close', () => { canceled = true; void stopCli(); });
