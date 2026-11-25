'use strict';

// Keep the official CLI responsible for Google authentication, model selection,
// native tools and permission policy. Its local, CSRF-authenticated Connect
// interface carries media and pending interactions that print mode cannot carry.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { jsonLines } = require('../../shared/json-lines');
const { setTimeout: delay } = require('node:timers/promises');
const http = require('node:http');
const { cliAuthenticationError, describeCliFailure } = require('./cli-auth.cjs');
const { assertSubscriptionPromptFits } = require('./prompt-limit.cjs');
// This agent is exclusively for authenticated loopback IPC. Model traffic
// stays in the native CLI and continues to honor the user's proxy settings.
const localAgent = new http.Agent({ proxyEnv: {} });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function nativeHistoryUnavailable(message) {
  return Object.assign(new Error(message), { nativeHistoryUnavailable: true });
}
const DONE = new Set(['CORTEX_STEP_STATUS_DONE', 'CORTEX_STEP_STATUS_ERROR', 'CORTEX_STEP_STATUS_CANCELED']);
const OPTIONS = [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }];
const idle = status => ['CASCADE_RUN_STATUS_IDLE', 'CASCADE_RUN_STATUS_DONE', 'CASCADE_RUN_STATUS_CANCELED'].includes(status);
const titlePreview = value => String(value || '').trim().toLowerCase().replace(/\s+/gu, ' ').replace(/[.。…]+$/u, '').trimEnd();
const connectionError = error => ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.cause?.code || error.code)
  || /^(?:TimeoutError|AbortError)$/.test(error.name);
function interactiveLaunch(exe, args, platform = process.platform) {
  if (platform === 'win32') return { exe, args, stdin: 'ignore' };
  // On Unix the native interactive reader exits on /dev/null, while a plain
  // pipe blocks its prompt auto-detection. Keep a private PTY open instead.
  // Node implements child stdin with a socketpair on macOS; BSD script rejects
  // tcgetattr on that socket. cat gives script a real pipe without closing it.
  // Positional arguments keep executable paths and model IDs out of shell code.
  if (platform === 'darwin') return { exe: '/bin/sh',
    args: ['-c', '/bin/cat | exec /usr/bin/script -q /dev/null "$@"', 'camellia-antigravity', exe, ...args], stdin: 'pipe' };
  const command = 'exec ' + [exe, ...args].map(value => "'" + value.replace(/'/g, "'\\''") + "'").join(' ');
  return { exe: '/usr/bin/script', args: ['-q', '-e', '-c', command, '/dev/null'], stdin: 'pipe' };
}
async function loopbackAddress(port) {
  const errors = [];
  // Probe the socket before any RPC. Some hosts omit ::1 from localhost DNS
  // even though the native server listens there; never replay a stateful call.
  for (const host of ['127.0.0.1', '::1']) {
    try {
      await new Promise((resolve, reject) => {
        const socket = require('node:net').createConnection({ host, port: Number(port) });
        socket.setTimeout(1000, () => socket.destroy(new Error('Loopback connection timed out')));
        socket.once('connect', () => { socket.destroy(); resolve(); });
        socket.once('error', reject);
      });
      return 'http://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + port;
    } catch (error) { errors.push(error); }
  }
  throw new AggregateError(errors, 'Antigravity local server is unavailable: ' + errors.map(error => error.code || error.message).join(', '));
}
function ownedTrajectories(summaries, root) {
  return Object.entries(summaries || {}).filter(([id, value]) => id === root || value.trajectoryMetadata?.rootConversationId === root);
}
function selection(catalog, model, effort) {
  const id = effort && catalog.some(row => row.modelId === model + '-' + effort) ? model + '-' + effort : model;
  const row = catalog.find(item => item.modelId === id);
  if (!row?.modelOrAlias?.model) throw new Error('Antigravity: invalid model selection: ' + model);
  return row;
}
function questionFields(requested) {
  return requested.askQuestion?.questions?.map((question, index) => ({ id: 'agy-question-' + index, question: question.question,
    multiSelect: Boolean(question.isMultiSelect), options: (question.options || []).map(option => ({ label: option.text })) }));
}
function permissionReply(requested, allow, answers = {}) {
  if (requested.askQuestion) return { askQuestion: { cancelled: !allow, responses: allow
    ? (requested.askQuestion.questions || []).map((question, index) => {
      const input = answers['agy-question-' + index], values = Array.isArray(input) ? input : [input];
      const options = question.options || [], selected = options.filter(option => values.includes(option.text));
      const text = values.filter(value => typeof value === 'string' && value && !options.some(option => option.text === value));
      return { ...question, selectedOptionIds: selected.map(option => option.id), writeInResponse: text.join('\n'), skipped: !selected.length && !text.length };
    }) : [] } };
  if (requested.permission) return { permission: { allow, scope: 'PERMISSION_SCOPE_ONCE' } };
  if (requested.filePermission) return { filePermission: { allow, scope: 'PERMISSION_SCOPE_ONCE', absolutePathUri: requested.filePermission.absolutePathUri } };
  const kind = Object.keys(requested).find(key => ['runCommand', 'mcp', 'readUrlContent', 'openBrowserUrl', 'browserAction',
    'runExtensionCode', 'executeBrowserJavascript', 'captureBrowserScreenshot', 'clickBrowserPixel', 'sendCommandInput',
    'openBrowserSetup', 'confirmBrowserSetup', 'approvalInteraction'].includes(key));
  if (!kind) throw new Error('Antigravity requested an unsupported interaction: ' + Object.keys(requested).join(', '));
  return { [kind]: { confirm: allow } };
}
function toolInput(step) {
  try { if (step.metadata?.toolCall?.argumentsJson) return JSON.parse(step.metadata.toolCall.argumentsJson); } catch { /* native generic arguments below */ }
  return step.generic?.args || (step.requestedInteraction?.permission ? { resource: step.requestedInteraction.permission.resource,
    description: step.requestedInteraction.permission.actionDescription } : {});
}
function stepOutput(step) {
  const direct = step.error?.shortError || step.error?.fullError || step.errorMessage?.error?.userErrorMessage || step.errorMessage?.error?.message || step.generic?.error?.message
    || step.runCommand?.combinedOutput?.full || step.runCommand?.combinedOutput?.truncated
    || step.generic?.result || step.generic?.output || '';
  if (direct) return direct;
  const diff = step.codeAction?.actionResult?.edit?.diff?.unifiedDiff?.lines;
  if (diff) return diff.map(line => (line.type?.endsWith('INSERT') ? '+' : line.type?.endsWith('DELETE') ? '-' : ' ') + (line.text || '')).join('\n');
  // Native tools have typed payloads (viewFile, runCommand, MCP, search, ...).
  // Keep their actual results visible even if they have no generic text field.
  const payload = Object.fromEntries(Object.entries(step).filter(([key]) => !['type', 'status', 'metadata', 'permissions',
    'requestedInteraction', 'completedInteractions', 'plannerResponse', 'userInput'].includes(key)));
  return Object.keys(payload).length ? JSON.stringify(payload, null, 2) : '';
}

class InteractiveCli {
  constructor(config, write) {
    this.config = config; this.write = write; this.mode = 'default'; this.requests = new Map();
    this.model = config.model || ''; this.csrf = randomUUID(); this.closed = false;
    this.children = new Map();
    this.stoppingChildren = new Set();
  }
  update(value) { this.write({ method: 'session/update', params: { sessionId: this.session.id, update: value } }); }
  childUpdate(id, patch) {
    const task = { ...this.children.get(id), id, parentId: this.session.conversationId, canReply: false, ...patch };
    if (JSON.stringify(task) === JSON.stringify(this.children.get(id))) return;
    this.children.set(id, task); this.update({ sessionUpdate: 'camellia_subagent', task });
  }
  save() { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.session) + '\n'); }
  async rpc(method, body = {}, signal = AbortSignal.timeout(30000)) {
    if (!this.address || this.closed) throw new Error('Antigravity interactive connection is unavailable');
    try {
      const payload = JSON.stringify(body);
      return await new Promise((resolve, reject) => {
        const request = http.request(this.address + '/exa.language_server_pb.LanguageServerService/' + method, {
          method: 'POST', agent: localAgent, signal, headers: { 'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload), 'x-codeium-csrf-token': this.csrf },
        }, response => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', chunk => { text += chunk; });
          response.once('error', reject);
          response.once('end', () => {
            try {
              const data = JSON.parse(text);
              if (response.statusCode < 200 || response.statusCode >= 300)
                reject(Object.assign(new Error('HTTP ' + response.statusCode + (data.message ? ' ' + data.message : '')),
                  { connectCode: data.code, status: response.statusCode }));
              else resolve(data);
            } catch (error) { reject(error); }
          });
        });
        request.once('error', reject); request.end(payload);
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error('Antigravity local ' + method + ': ' + error.message + (error.code ? ' (' + error.code + ')' : ''), { cause: error });
    }
  }
  async prepare() {
    return this.preparing ||= this.start().catch(async error => { await this.stop(); throw error; });
  }
  async generateTitle({ prompt = '', attempts = 60, delayTitle = ms => delay(ms) } = {}) {
    if (!this.session || this.closed) return { title: '' };
    // Share CLI startup with the first prompt, including when resuming a cascade.
    await this.prepare();
    if (!this.session.conversationId || this.closed) return { title: '' };
    // The CLI generates its own summary with the signed-in Google account.
    // Until then the index can expose the first prompt as a preview.
    const deadline = Date.now() + 45000;
    const visiblePrompt = titlePreview(prompt);
    for (let attempt = 0; attempt < attempts && !this.closed && Date.now() < deadline; attempt++) {
      const { trajectorySummaries } = await this.rpc('GetAllCascadeTrajectories', {}, AbortSignal.timeout(5000));
      const summary = trajectorySummaries?.[this.session.conversationId];
      const title = [summary?.summary, summary?.title].find(value => {
        if (typeof value !== 'string') return false;
        const preview = titlePreview(value);
        return preview && !/^(?:new (?:session|conversation|chat)|starting a conversation|untitled)$/u.test(preview)
          && !visiblePrompt.startsWith(preview) && !this.firstTitleInput?.startsWith(preview);
      });
      if (title) return { title };
      if (attempt + 1 < attempts) await delayTitle(750);
    }
    return { title: '' };
  }
  async start() {
    if (this.closed) throw new Error('Antigravity session closed');
    const folder = path.join(this.config.home, 'cli-runtime'); fs.mkdirSync(folder, { recursive: true });
    this.logFile = path.join(folder, randomUUID() + '.log');
    const args = ['--csrf_token', this.csrf, '--log-file', this.logFile, '--model', this.model];
    if (this.config.effort) args.push('--effort', this.config.effort);
    if (this.config.skipPermissions || this.mode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
    else if (this.mode !== 'default') args.push('--mode', this.mode === 'acceptEdits' ? 'accept-edits' : this.mode);
    const env = { ...process.env, AGY_CLI_INTERACTIVE_HEADLESS: '1', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };
    delete env.CAMELLIA_ANTIGRAVITY_CLI; delete env.AGY_CLI_NONINTERACTIVE_HEADLESS;
    const launch = interactiveLaunch(this.config.exe, args);
    const child = this.child = spawn(launch.exe, launch.args, { cwd: this.session.cwd, env, windowsHide: true,
      detached: process.platform !== 'win32', stdio: [launch.stdin, 'pipe', 'pipe'] });
    let diagnostic = '';
    child.stdout.resume();
    child.stderr.on('data', chunk => {
      diagnostic = (diagnostic + chunk).slice(-4000);
      const error = cliAuthenticationError(diagnostic);
      if (error && !this.processError) {
        this.processError = error; this.turn?.controller.abort(error); void this.stop();
      }
    });
    this.exited = new Promise(resolve => {
      child.once('error', error => { this.processError = error; });
      child.once('close', code => {
        this.processError ||= new Error(describeCliFailure(diagnostic, '', code));
        this.turn?.controller.abort(this.processError); resolve();
      });
    });
    const deadline = Date.now() + 60000;
    while (!this.address) {
      if (this.closed || this.processError) throw this.processError || new Error('Antigravity startup cancelled');
      const log = fs.existsSync(this.logFile) ? fs.readFileSync(this.logFile, 'utf8') : '';
      const port = log.match(/Language server listening on random port at (\d+) for HTTP\b/)?.[1];
      if (port) this.address = await loopbackAddress(port);
      else if (Date.now() > deadline) throw new Error('Antigravity interactive startup timed out');
      else await delay(50);
    }
    // Auth/catalog initialization follows the socket opening. Wait for the CLI's
    // own catalog, never substitute an API key or a different model.
    let catalog;
    while (!catalog?.clientModelConfigs?.length) {
      if (this.closed || this.processError) throw this.processError || new Error('Antigravity startup cancelled');
      catalog = await this.rpc('GetCascadeModelConfigData');
      if (!catalog.clientModelConfigs?.length) {
        if (Date.now() > deadline) throw new Error('Antigravity model catalog timed out');
        await delay(100);
      }
    }
    this.selected = selection(catalog.clientModelConfigs, this.model, this.config.effort);
    if (this.session.conversationId) {
      const saved = await this.trajectory();
      if (saved.trajectory?.cascadeId !== this.session.conversationId)
        throw nativeHistoryUnavailable('Antigravity native identity changed');
    }
    else {
      const created = await this.rpc('StartCascade', { source: 'CORTEX_TRAJECTORY_SOURCE_CLI',
        workspaceUris: [pathToFileURL(this.session.cwd).href], requestedModel: this.selected.modelOrAlias.model,
        customAgentSpec: { builtinAgent: { defaultAgent: { isGoogle: true, isInteractive: true } } } });
      if (!UUID.test(created.cascadeId)) throw new Error('Antigravity returned an invalid native identity');
      this.session.conversationId = created.cascadeId; this.save();
    }
    return { sessionId: this.session.id, conversationId: this.session.conversationId };
  }
  async trajectory(signal) {
    const cascadeId = this.session.conversationId;
    let saved;
    try {
      saved = await this.rpc('GetCascadeTrajectory', { cascadeId, trajectoryVerbosity: 'CLIENT_TRAJECTORY_VERBOSITY_PROD_UI' }, signal);
    } catch (error) {
      if (error.cause?.connectCode === 'not_found')
        throw nativeHistoryUnavailable('Antigravity native conversation is missing');
      throw error;
    }
    return saved;
  }
  async expandSkill(parts, signal) {
    // Discussion/context messages are literal input, never user invocations.
    if (this.config.literalInput || this.config.discussion) return parts;
    const index = parts.findIndex(part => part.type === 'text');
    const command = index < 0 ? null : parts[index].text?.match(/^\s*\/(\S+)(?:\s|$)/u);
    if (!command) return parts;
    let catalog;
    try { catalog = await this.rpc('GetAllSkills', { workspaceUris: [pathToFileURL(this.session.cwd).href] }, signal); }
    catch (error) {
      if (/unimplemented|unknown (?:method|service)/i.test(error.message)) return parts;
      throw error;
    }
    const skill = catalog.skills?.find(value => value.name === command[1]);
    if (!skill || skill.disableSlashCommand || typeof skill.content !== 'string' || !skill.content.trim()) return parts;
    // Use the native catalog's resolved content and precedence. Do not scan
    // arbitrary local paths or turn a skill into a system-level instruction.
    return parts.map((part, at) => at !== index ? part : { ...part,
      text: part.text + '\n\n<skill_instructions>\nSource: ' + skill.path + '\n' + skill.content + '\n</skill_instructions>' });
  }
  async prompt(parts, checkpoint) {
    await this.cancelling;
    if (this.turn) throw new Error('A response is already running');
    const textParts = input => input.filter(part => part.type === 'text').map(part => part.text).join('\n');
    assertSubscriptionPromptFits(textParts(parts));
    const turn = this.turn = { controller: new AbortController(), sent: new Map(), thoughts: new Map(),
      tools: new Map(), permissions: new Set(), usage: {}, canceled: false,
      childResults: new Map(), childErrors: new Map() };
    const signal = turn.controller.signal;
    const bounded = () => AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    const read = async (method, params) => {
      for (let attempt = 0;; attempt++) {
        try { return await this.rpc(method, params, bounded()); }
        catch (error) {
          if (signal.aborted || !connectionError(error) || attempt === 2) throw error;
          await delay(250 * (attempt + 1), null, { signal });
        }
      }
    };
    try {
      if (checkpoint && (!this.session.conversationId ||
          checkpoint.cascadeId && checkpoint.cascadeId !== this.session.conversationId))
        throw nativeHistoryUnavailable('Antigravity native conversation identity is missing or changed');
      await this.prepare();
      if (turn.canceled || this.closed) return { stopReason: 'cancelled' };
      const expanded = await this.expandSkill(parts, turn.controller.signal);
      if (expanded !== parts) assertSubscriptionPromptFits(textParts(expanded));
      const items = [], media = [];
      for (const part of expanded) {
        if (part.type === 'text') items.push({ text: part.text });
        else if (part.type === 'image') {
          if (!this.selected.supportsImages) throw new Error('The selected Antigravity model does not support image input');
          if (!/^image\/(png|jpeg|gif|webp)$/.test(part.mimeType) || typeof part.data !== 'string') throw new Error('Invalid Antigravity image input');
          media.push({ mimeType: part.mimeType, inlineData: part.data });
        } else throw new Error('Unsupported Antigravity input: ' + part.type);
      }
      const cascadeId = this.session.conversationId;
      const before = await this.trajectory(turn.controller.signal);
      const offset = before.numTotalSteps || 0;
      if (checkpoint && (before.trajectory?.cascadeId !== cascadeId || offset < (checkpoint.stepCount || 0)))
        throw nativeHistoryUnavailable('Antigravity native history is behind its saved checkpoint (expected ' +
          (checkpoint.stepCount || 0) + ' steps, found ' + offset + ')');
      const baseline = new Map(ownedTrajectories((await read('GetAllCascadeTrajectories', {})).trajectorySummaries, cascadeId)
        .map(([id, value]) => [id, value.stepCount || 0]));
      this.firstTitleInput ||= titlePreview(items.map(item => item.text).join('\n'));
      let deliveryError;
      const request = { cascadeId, items, media, cascadeConfig: { plannerConfig: { planModel: this.selected.modelOrAlias.model } } };
      for (let attempt = 0;; attempt++) {
        try { await this.rpc('SendUserCascadeMessage', request, bounded()); turn.delivery = 'accepted'; break; }
        catch (error) {
          const cause = error.cause || error;
          if (signal.aborted || !(connectionError(error) || cause.status >= 500 || [408, 499].includes(cause.status)
              || cause instanceof SyntaxError)) throw error;
          // A refused TCP connect cannot have written this request.
          if (cause.code === 'ECONNREFUSED' && cause.syscall === 'connect') {
            if (attempt === 2) throw new Error('Could not connect to Antigravity after three attempts. Nothing was sent. Retry this message when the connection is available.', { cause: error });
            await delay(250 * (attempt + 1), null, { signal });
            continue;
          }
          deliveryError = error;
          turn.delivery = 'unknown';
          break;
        }
      }
      const confirmBy = Date.now() + 10000;
      let sawInput = false;
      turn.observing = true;
      while (!turn.canceled && !this.closed) {
        const all = await read('GetAllCascadeTrajectories', {});
        const result = all.trajectorySummaries?.[cascadeId];
        if (!result) throw new Error('Antigravity native conversation disappeared');
        if (deliveryError && !sawInput) {
          const { steps = [] } = await read('GetCascadeTrajectorySteps', { cascadeId, stepOffset: offset });
          // This bridge is the sole writer of the cascade. The next user step
          // after the saved offset establishes acceptance even if the ACK was lost.
          const input = steps[0];
          const echoedText = input?.userInput?.userResponse;
          if (result.stepCount > offset && (input?.type === 'CORTEX_STEP_TYPE_USER_INPUT' || input?.userInput)
              && (typeof echoedText !== 'string' || echoedText === textParts(expanded))) {
            sawInput = true;
            turn.delivery = 'accepted';
          }
          else if (Date.now() >= confirmBy) throw deliveryError;
          else { await delay(250, null, { signal }); continue; }
        }
        sawInput ||= result.stepCount > offset;
        // Retrieve only this turn, skipping its potentially large uploaded media.
        // PROD_UI verbosity strips completed tool arguments, so use full steps.
        const { steps = [] } = await read('GetCascadeTrajectorySteps', { cascadeId, stepOffset: offset + 1 });
        for (let index = 0; index < steps.length; index++) this.step(turn, result, steps[index], offset + 1 + index, cascadeId);
        const children = ownedTrajectories(all.trajectorySummaries, cascadeId).filter(([id, summary]) => id !== cascadeId
          && (!idle(summary.status) || summary.stepCount > (baseline.get(id) || 0)));
        for (const [childId, summary] of children) {
          const previous = this.children.get(childId), turnId = offset + ':' + childId;
          if (previous?.turnId !== turnId) this.stoppingChildren.delete(childId);
          this.childUpdate(childId, { title: summary.summary || summary.title || this.children.get(childId)?.title || 'Subtask',
            turnId, ...(previous?.turnId !== turnId ? { status: 'running', canStop: true, result: '', history: [] } : {}) });
          const start = baseline.get(childId) || 0;
          const child = await read('GetCascadeTrajectorySteps', { cascadeId: childId, stepOffset: start });
          for (const [index, step] of (child.steps || []).entries()) this.step(turn, summary, step, start + index, childId);
          if (idle(summary.status)) this.childUpdate(childId, { status: /CANCELED/.test(summary.status) || this.stoppingChildren.has(childId) ? 'stopped'
            : turn.childErrors.has(childId) ? 'failed' : 'completed', canStop: false,
            result: turn.childErrors.get(childId) || turn.childResults.get(childId) || '' });
        }
        if (sawInput && idle(result.status) && children.every(([, summary]) => idle(summary.status))) {
          turn.observing = false;
          if (turn.error) throw new Error(turn.error);
          return { stopReason: result.status.endsWith('CANCELED') ? 'cancelled' : 'end_turn', usage: turn.usage,
            ...(Number.isSafeInteger(result.stepCount) && UUID.test(cascadeId)
              ? { nativeHistoryCheckpoint: { cascadeId, stepCount: result.stepCount } } : {}) };
        }
        await delay(150, null, { signal: turn.controller.signal });
      }
      return { stopReason: 'cancelled', usage: turn.usage };
    } catch (error) {
      if (turn.canceled) return { stopReason: 'cancelled', usage: turn.usage };
      await this.stop();
      if (turn.delivery === 'unknown')
        throw Object.assign(new Error('Antigravity could not confirm whether it received this message. Check the conversation and any file changes before resending.', { cause: error }), { submission: 'unknown' });
      if (turn.delivery === 'accepted' && turn.observing)
        throw Object.assign(new Error('Antigravity received this message, but the reply connection was lost. Check the conversation and any file changes before resending.', { cause: error }), { submission: 'accepted' });
      throw error;
    } finally {
      for (const [id, request] of this.requests) if (request.turn === turn) this.requests.delete(id);
      this.turn = null;
    }
  }
  step(turn, trajectory, step, index, cascadeId = this.session.conversationId) {
    const key = trajectory.trajectoryId || trajectory.id || this.session.conversationId;
    const id = key + ':' + index;
    const response = step.plannerResponse?.modifiedResponse || step.plannerResponse?.response || '';
    const thinking = step.plannerResponse?.thinking || '';
    const old = turn.sent.get(id) || '';
    const tool = step.metadata?.toolCall;
    const child = cascadeId !== this.session.conversationId;
    if (child) {
      turn.childResults ||= new Map(); turn.childErrors ||= new Map();
      const previous = this.children.get(cascadeId);
      if (!previous) this.childUpdate(cascadeId, { title: trajectory.summary || trajectory.title || 'Subtask',
        status: 'running', turnId: key, canStop: true, history: [] });
      if (response && response !== turn.sent.get(id)) {
        turn.childResults.set(cascadeId, response); turn.sent.set(id, response);
        this.childUpdate(cascadeId, { progress: response });
      }
      if (step.errorMessage?.error || step.error && !tool) turn.childErrors.set(cascadeId, stepOutput(step));
    }
    if (!this.config.discussion && cascadeId === this.session.conversationId && thinking && thinking !== response) {
      turn.thoughts ||= new Map();
      const previous = turn.thoughts.get(id) || '';
      if (thinking.startsWith(previous) && thinking.length > previous.length) {
        const delta = thinking.slice(previous.length);
        turn.thoughts.set(id, thinking);
        this.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: delta } });
      }
    }
    if (cascadeId === this.session.conversationId && response.startsWith(old) && response.length > old.length) {
      this.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: response.slice(old.length) } }); turn.sent.set(id, response);
    }
    if (cascadeId === this.session.conversationId && (step.errorMessage?.error || step.error && !tool))
      turn.error = stepOutput(step) || 'Antigravity response failed';
    if (tool || step.requestedInteraction) {
      const output = stepOutput(step), input = toolInput(step);
      const value = { sessionUpdate: 'tool_call_update', toolCallId: id, title: tool?.name || step.type,
        status: /ERROR|CANCELED/.test(step.status) ? 'failed' : DONE.has(step.status) ? 'completed' : 'in_progress',
        rawInput: input, ...(output ? { content: [{ type: 'content', content: { type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output) } }] } : {}) };
      const serialized = JSON.stringify(value);
      if (turn.tools.get(id) !== serialized) {
        if (child) {
          const task = this.children.get(cascadeId), detail = typeof output === 'string' ? output : JSON.stringify(output);
          this.childUpdate(cascadeId, { progress: detail || value.title, history: [
            ...(task.history || []), { type: 'tool_call_update', text: (value.title + '\n' + detail).slice(-1800) },
          ].slice(-40) });
        } else this.update(value);
        turn.tools.set(id, serialized);
      }
      if (step.status === 'CORTEX_STEP_STATUS_WAITING' && step.requestedInteraction && !turn.permissions.has(id)) {
        permissionReply(step.requestedInteraction, false); // Do not silently approve an unknown interaction.
        turn.permissions.add(id);
        const requestId = 'agy-permission-' + randomUUID();
        this.requests.set(requestId, { turn, cascadeId, trajectoryId: key, stepIndex: index, requested: step.requestedInteraction });
        if (child) this.childUpdate(cascadeId, { status: 'waiting' });
        this.write({ id: requestId, method: 'session/request_permission', params: { sessionId: this.session.id,
          toolCall: { toolCallId: id, title: tool?.name || 'Antigravity approval', rawInput: input }, options: OPTIONS,
          ...(child ? { _meta: { camelliaSubagentId: cascadeId } } : {}),
          ...(step.requestedInteraction.askQuestion ? { questions: questionFields(step.requestedInteraction) } : {}) } });
      }
    }
    const usage = step.metadata?.modelUsage;
    if (usage) {
      turn.usageSteps ||= new Map(); turn.usageSteps.set(id, usage);
      turn.usage = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0 };
      for (const value of turn.usageSteps.values()) {
        turn.usage.input_tokens += Number(value.inputTokens || 0); turn.usage.output_tokens += Number(value.outputTokens || 0);
        turn.usage.thinking_tokens += Number(value.thinkingTokens || 0); turn.usage.cache_read_tokens += Number(value.cacheReadTokens || 0);
      }
    }
  }
  async reply(message) {
    const request = this.requests.get(message.id);
    if (!request) return;
    this.requests.delete(message.id);
    if (request.turn !== this.turn || request.turn.canceled || this.closed) return;
    const outcome = message.result?.outcome;
    const allow = outcome?.outcome === 'selected' && outcome.optionId === 'allow';
    try {
      await this.rpc('HandleCascadeUserInteraction', { cascadeId: request.cascadeId,
        interaction: { trajectoryId: request.trajectoryId, stepIndex: request.stepIndex, ...permissionReply(request.requested, allow, message.result?.input) } }, request.turn.controller.signal);
      if (this.children.get(request.cascadeId)?.status === 'waiting') this.childUpdate(request.cascadeId, { status: 'running' });
    } catch (error) {
      // Stop may abort the automatic denial while it is in flight. That is an
      // expected cancellation, not a reason to destroy the reusable bridge.
      if (request.turn === this.turn && !request.turn.canceled && !this.closed) request.turn.controller.abort(error);
    }
  }
  async cancel(user = true) {
    if (this.turn) { if (user) this.turn.canceled = true; this.turn.controller.abort(); }
    this.requests.clear();
    if (this.address && this.session.conversationId && !this.processError) {
      const cascadeId = this.session.conversationId, signal = AbortSignal.timeout(2500);
      try {
        await this.rpc('CancelCascadeInvocation', { cascadeId, killBackgroundTasks: true }, signal);
        // The native cancel RPC acknowledges the request before its executor
        // stops. Keep the next prompt behind this.cancelling until the root and
        // its owned children are idle, without replaying a stateful send.
        if (user) while (!this.closed && !this.processError) {
          const summaries = (await this.rpc('GetAllCascadeTrajectories', {}, signal)).trajectorySummaries;
          if (!summaries?.[cascadeId]) throw new Error('Antigravity native conversation disappeared while stopping');
          if (ownedTrajectories(summaries, cascadeId).every(([, summary]) => idle(summary.status))) {
            for (const [id] of ownedTrajectories(summaries, cascadeId)) {
              if (['starting', 'running', 'waiting'].includes(this.children.get(id)?.status)) this.childUpdate(id, { status: 'stopped', canStop: false });
            }
            break;
          }
          await delay(50, null, { signal });
        }
      } catch { if (user) await this.stop(); }
    }
  }
  async stop() {
    return this.stopping ||= this.shutdown();
  }
  async shutdown() {
    await this.cancel(false);
    this.closed = true;
    if (this.child && this.child.exitCode === null) {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/pid', String(this.child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => this.child.kill());
      } else { try { process.kill(-this.child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
      await this.exited;
    }
    if (this.logFile) fs.rmSync(this.logFile, { force: true });
  }
  async handle(method, params) {
    if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
      agentInfo: { name: 'Antigravity CLI', version: 'interactive-1' } };
    if (method === 'session/fork') throw new Error('The official Antigravity CLI does not support forks in headless mode. Start a new session instead.');
    if (method === 'session/new' || method === 'session/resume') {
      if (this.session || this.closed) throw new Error('Antigravity session is already initialized or closed');
      const id = method === 'session/new' ? 'agy-' + randomUUID() : params.sessionId;
      if (typeof id !== 'string' || !id.startsWith('agy-') || !UUID.test(id.slice(4))) throw new Error('Invalid Google subscription session');
      this.file = path.join(this.config.home, 'cli-sessions', id + '.json');
      try {
        this.session = method === 'session/new' ? { id, cwd: params.cwd } : JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') throw nativeHistoryUnavailable('Antigravity native session mapping is missing');
        throw error;
      }
      if (this.session.id !== id || this.session.conversationId && !UUID.test(this.session.conversationId)) throw new Error('Invalid saved Antigravity identity');
      if (typeof this.session.cwd !== 'string' || !path.isAbsolute(this.session.cwd) || this.session.cwd !== params.cwd)
        throw new Error('Antigravity working directory changed');
      if (method === 'session/new') this.save();
      return { sessionId: id };
    }
    if (!this.session || params.sessionId !== this.session.id) throw new Error('Antigravity session identity mismatch');
    if (method === 'session/set_config_option') {
      if (params.configId === 'model') {
        if (this.preparing && params.value !== this.model) throw new Error('Prepared session model is fixed');
        this.model = params.value;
      }
      return { configOptions: [] };
    }
    if (method === 'session/set_mode') {
      if (!['default', 'acceptEdits', 'bypassPermissions', 'plan'].includes(params.modeId)) throw new Error('Invalid Antigravity permission mode');
      if (this.preparing && this.mode !== params.modeId) throw new Error('Prepared session mode is fixed');
      this.mode = params.modeId; return {};
    }
    if (method === 'session/camellia_prepare') return this.prepare();
    if (method === 'session/camellia_generate_title') return this.generateTitle({ prompt: params.prompt });
    if (method === 'session/prompt') return this.prompt(params.prompt, params.nativeHistoryCheckpoint);
    if (method === 'session/camellia_subagent_cancel') {
      const task = this.children.get(params.taskId);
      if (!task?.canStop || task.turnId !== params.turnId || params.taskId === this.session.conversationId)
        throw new Error('This subtask changed or is no longer running');
      await this.rpc('CancelCascadeInvocation', { cascadeId: params.taskId, killBackgroundTasks: true });
      this.stoppingChildren.add(params.taskId);
      return {};
    }
    if (method === 'session/cancel') { await (this.cancelling ||= this.cancel().finally(() => { this.cancelling = null; })); return {}; }
    if (method === 'session/close') { await this.stop(); return {}; }
    throw new Error('Unsupported ACP method: ' + method);
  }
}
function run(config) {
  const write = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const bridge = new InteractiveCli(config, write);
  const input = jsonLines(process.stdin);
  input.on('data', async line => {
    let message;
    try {
      message = JSON.parse(line);
      if (!message.method) { await bridge.reply(message); return; }
      const result = await bridge.handle(message.method, message.params || {});
      if (message.id !== undefined) write({ id: message.id, result });
    } catch (error) {
      if (message?.method && message.id !== undefined) write({ id: message.id, error: { code: -32603, message: error.message,
        ...(error.nativeHistoryUnavailable || error.submission ? { data: {
          ...(error.nativeHistoryUnavailable ? { nativeHistoryUnavailable: true } : {}),
          ...(error.submission ? { submission: error.submission } : {}) } } : {}) } });
      else { process.stderr.write(error.message + '\n'); await bridge.stop(); }
    }
  });
  input.once('close', () => { void bridge.stop(); });
}
module.exports = { InteractiveCli, run, selection, permissionReply, questionFields, toolInput, ownedTrajectories, interactiveLaunch };
