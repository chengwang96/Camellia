'use strict';

// ACP entry point: interactive native transport for chat, restricted print
// transport for the tool-free verification probe. Runs under bundled Node.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { permissionNotice } = require('./permission-notice.cjs');

const config = JSON.parse(process.env.CAMELLIA_ANTIGRAVITY_CLI);
if (Object.hasOwn(config, 'literalInput') && typeof config.literalInput !== 'boolean') throw new Error('Invalid literal input setting');
if (Object.hasOwn(config, 'skipPermissions') && typeof config.skipPermissions !== 'boolean') throw new Error('Invalid permission setting');
if (!config.discussion && !config.legacyStream) {
  require('./cli-interactive.cjs').run(config);
} else {
const env = { ...process.env };
delete env.CAMELLIA_ANTIGRAVITY_CLI;
let session, sessionFile, model = config.model || '', mode = 'default', cli, pending, streamed = '', previousUsage = {};
// stdout and stderr are independent pipes, so the CLI's native-denial notice can
// arrive after the stdout result that closes the turn. Keep such a notice for the
// turn it belongs to instead of dropping it for being a few milliseconds late.
let notices = [];
let canceled = false, closed, cliError;
let preparation, nativeReady, preparedId, prompted = false, preparationFailed = false;
const csrf = randomUUID();
let runtimeLog;
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
  if (canceled) current.resolve({ ...value, stopReason: 'cancelled' });
  else if (error) current.reject(error);
  else current.resolve(value);
}
function flushNotices() {
  for (const notice of notices.splice(0)) if (!canceled) update(notice);
}
function receive(event) {
  if (event.event === 'init') {
    if (typeof event.conversation_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(event.conversation_id)
      || session.conversationId && session.conversationId !== event.conversation_id) throw new Error('Antigravity native identity changed or is invalid');
    session.conversationId = event.conversation_id;
    saveSession();
    nativeReady?.resolve({ sessionId: session.id, conversationId: session.conversationId });
  } else if (event.event === 'step_update' && pending) {
    const step = event.step_update;
    if (step.usage) update({ sessionUpdate: 'camellia_usage', stepId: step.step_index, usage: step.usage });
    if (step.step_type === 'agent_response' && step.text_delta) { streamed += step.text_delta; text(step.text_delta); }
    else if (step.step_type !== 'agent_response' && step.step_type !== 'user_input') {
      const info = step.tool_info, output = info?.error?.message || step.text_delta;
      update({ sessionUpdate: 'tool_call_update', toolCallId: String(step.step_index),
        title: step.tool_name || info?.name || step.step_type.replace(/_/g, ' '),
        status: step.state === 'DONE' ? 'completed' : ['ERROR', 'CANCELED', 'INTERRUPTED'].includes(step.state) ? 'failed' : 'in_progress',
        ...(info?.parameters ? { rawInput: info.parameters } : {}),
        ...(output ? { content: [{ type: 'content', content: { type: 'text', text: output } }] } : {}) });
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
  if (config.discussion) {
    runtimeLog = path.join(config.home, 'cli-runtime', randomUUID() + '.log');
    fs.mkdirSync(path.dirname(runtimeLog), { recursive: true });
    args.push('--csrf_token', csrf, '--log-file', runtimeLog);
  }
  if (config.literalInput) args.push('--disable-slash-commands');
  if (config.discussion) args.push('--agent', 'camellia-discussion');
  // The Google base models take their reasoning effort from a separate flag,
  // so the CLI is pinned once at launch and Camellia skips the model
  // config-option it cannot express.
  if (config.effort) args.push('--effort', config.effort);
  if (session.conversationId) args.push('--conversation', session.conversationId);
  if (config.skipPermissions) args.push('--dangerously-skip-permissions');
  else if (mode === 'bypassPermissions') args.push('--mode', 'accept-edits', '--dangerously-skip-permissions');
  else if (mode !== 'default') args.push('--mode', mode === 'acceptEdits' ? 'accept-edits' : mode);
  cli = spawn(config.exe, args, { cwd: session.cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  const child = cli;
  let errorText = '';
  cliError = null;
  previousUsage = {};
  const lines = readline.createInterface({ input: child.stdout });
  const diagnostics = readline.createInterface({ input: child.stderr });
  diagnostics.on('line', line => {
    const notice = permissionNotice(line);
    if (!notice || canceled) return;
    // The notice can land just before or just after the turn's result, since it
    // travels on stderr. Forward it either way; a notice buffered after the turn
    // closed is released by the next flush.
    if (pending) update(notice); else { notices.push(notice); flushNotices(); }
  });
  lines.on('line', line => {
    try { receive(JSON.parse(line)); }
    catch (error) { cliError = error; void stopCli(); }
  });
  child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-4000); process.stderr.write(chunk); });
  child.once('error', error => { nativeReady?.reject(error); finish(error); });
  child.stdin.on('error', error => finish(error));
  closed = new Promise(resolve => child.once('close', code => {
    lines.close();
    diagnostics.close();
    if (cli === child) cli = null;
    const error = cliError || new Error(errorText.trim() || `Antigravity CLI exited (${code})`);
    nativeReady?.reject(error); finish(error);
    resolve();
  }));
}
function prepareNative() {
  if (preparationFailed) return Promise.reject(new Error('Native preparation has failed or stopped'));
  if (preparation) return preparation;
  if (prompted) return Promise.reject(new Error('Native preparation must precede the first prompt'));
  preparation = new Promise((resolve, reject) => {
    // Refreshing the native Google login and loading its model catalog can
    // exceed 25 seconds before the CLI emits init. Keep this cancellable.
    const timer = setTimeout(() => { nativeReady.reject(new Error('Native preparation timed out')); void stopCli(); }, 60000);
    nativeReady = {
      resolve(value) { if (preparationFailed) return; clearTimeout(timer); preparedId = value.conversationId; resolve(value); },
      reject(error) { preparationFailed = true; clearTimeout(timer); reject(error); },
    };
    try { startCli(); } catch (error) { nativeReady.reject(error); }
  });
  return preparation;
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
  if (runtimeLog) fs.rmSync(runtimeLog, { force: true });
}
async function handle(method, params) {
  if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: 'Antigravity CLI', version: '1' } };
  if (method === 'session/fork') throw new Error('The official Antigravity CLI does not support forks in headless mode. Start a new session instead.');
  if (method === 'session/new' || method === 'session/resume') {
    if (preparation) throw new Error('Prepared session identity is fixed');
    const id = method === 'session/new' ? 'agy-' + randomUUID() : params.sessionId;
    if (!/^agy-[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid Google subscription session');
    sessionFile = path.join(config.home, 'cli-sessions', id + '.json');
    session = method === 'session/new' ? { id, cwd: params.cwd } : JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    if (method === 'session/new') saveSession();
    return { sessionId: id };
  }
  if (method === 'session/set_config_option') {
    // The bridge pins the model at launch so --model and --effort stay a
    // matched pair. The model picker value is accepted and ignored.
    if (params.configId === 'model') {
      if (preparation && model !== params.value) throw new Error('Prepared session model is fixed');
      if (!config.effort) model = params.value;
    }
    return { configOptions: [] };
  }
  if (method === 'session/set_mode') {
    // CLI 1.2.3 implements --mode through slash expansion and ignores it when
    // expansion is disabled. Never silently claim to have applied that mode.
    if (config.literalInput && params.modeId !== 'default') throw new Error('Literal CLI input cannot apply native permission modes');
    if (preparation && mode !== params.modeId) throw new Error('Prepared session mode is fixed');
    mode = params.modeId; return {};
  }
  if (method === 'session/camellia_prepare') {
    if (!session || params.sessionId !== session.id) throw new Error('Native preparation identity mismatch');
    return prepareNative();
  }
  if (method === 'session/camellia_model_capabilities') {
    if (!config.discussion || !session || params.sessionId !== session.id || !preparedId || canceled || !cli)
      throw new Error('Native model capability lookup is unavailable');
    const port = fs.readFileSync(runtimeLog, 'utf8').match(/Language server listening on random port at (\d+) for HTTP\b/)?.[1];
    if (!port) throw new Error('Antigravity model catalog endpoint is unavailable');
    const response = await fetch('http://127.0.0.1:' + port + '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-codeium-csrf-token': csrf }, body: '{}', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Antigravity model catalog lookup failed');
    const selected = require('./cli-interactive.cjs').selection((await response.json()).clientModelConfigs || [], model, config.effort);
    // This describes the model for the separate interactive production path;
    // it does not advertise image support for this tool-free print transport.
    return { image: selected.supportsImages === true };
  }
  if (method === 'session/prompt') {
    if (preparation && (preparationFailed || !preparedId || !cli)) throw new Error('Native preparation has not succeeded');
    if (pending) throw new Error('A response is already running');
    if (params.prompt.some(part => part.type !== 'text')) throw new Error('Google subscription chat currently supports text and file paths, not image input.');
    canceled = false; streamed = '';
    prompted = true;
    if (!cli) startCli();
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
      cli.stdin.write(JSON.stringify({ event: 'user', message: { content: params.prompt } }) + '\n');
    });
  }
  if (method === 'session/cancel' || method === 'session/close') {
    canceled = true; nativeReady?.reject(new Error('Native preparation cancelled')); await stopCli(); return {};
  }
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
}
