'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createHash } = require('node:crypto');
const { writeJson, readJson } = require('../shared/json-store');
const { VERSION, TASKS, SUITES, suiteHash, publicSuites, prepareTask, verifyTask } = require('./tasks');
const { ENGINES, NAMES, runEngine, isolatedEnvironment } = require('./engines');
const { DSH_MAX_OUTPUT_TOKENS } = require('../engines/dsh-session');
const { CODEX_API_TOOL_PROFILE } = require('../engines/codex-models');
const { ANTIGRAVITY_API_TOOL_PROFILE } = require('../api/buffered-tool-stream');
const { GRADER_VERSION } = require('./verifier');
const { publicTask } = require('./libraries');
const { verifyPythonTask, preflightPythonTasks, PYTHON_GRADER_VERSION } = require('./python-verifier');
const { taskWarnings, comparisonNotes } = require('./diagnostics');
const CHECK_SCORE_METHOD = 'mean-trial-check-fraction-v1';
const DEFAULT_TIMEOUT_SECONDS = { builtin: 300, ds1000: 600, scicode: 1800 };
const DEFAULT_TOKENS_PER_TASK = { builtin: 250000, ds1000: 500000, scicode: 1000000 };
const MAX_TOKEN_BUDGET = 1000000000;
const PREVIEW = Object.freeze({ suite: 'quick', repeats: 1, timeoutSeconds: 270, maxDurationSeconds: 300, maxTokensPerTask: 250000, tokenBudget: null });
const PREVIEW_TIME_ALLOCATION = Object.freeze({ mode: 'shared-preview', version: 1, reserveSeconds: 30 });
function trialTimeLimitMs(report, trial, now = Date.now()) {
  const allocation = report.timeAllocation;
  if (allocation?.mode !== 'shared-preview') return report.timeoutSeconds * 1000;
  const cutoffSeconds = report.maxDurationSeconds - allocation.reserveSeconds;
  return Math.max(0, Date.parse(report.startedAt) + cutoffSeconds * 1000 - now);
}
// -I removes the working/script directory and breaks ordinary agent self-tests
// such as `from solution import f`. The independent grader still uses -I.
const PYTHON_SCRATCH_FLAGS = ['-E', '-s', '-X', 'utf8'];

function integer(value, fallback, min, max) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Expected an integer between ${min} and ${max}`);
  return n;
}
function checkFraction(trial) {
  if (trial.verification?.invalid || trial.status === 'grader_error') return null;
  if (['error', 'timeout', 'limit'].includes(trial.status)) return 0;
  if (!['passed', 'failed'].includes(trial.status)) return null;
  const checks = trial.verification?.checks;
  if (checks && Number.isInteger(checks.total) && checks.total > 0 && Number.isInteger(checks.passed)
    && checks.passed >= 0 && checks.passed <= checks.total) return checks.passed / checks.total;
  // A full pass is known even in older reports. A failed task without saved
  // check counts could have passed some checks, so its fraction is unknown.
  return trial.status === 'passed' ? 1 : null;
}
const percent = fraction => fraction === null ? null : Math.round(fraction * 1000) / 10;
function summarize(report) {
  return ENGINES.filter(id => report.trials.some(t => t.engine === id)).map(id => {
    const rows = report.trials.filter(t => t.engine === id), done = rows.filter(t => ['passed', 'failed', 'timeout', 'error', 'limit', 'grader_error'].includes(t.status));
    const invalid = done.filter(t => t.status === 'grader_error' || t.verification?.invalid).length;
    const passed = done.filter(t => t.status === 'passed').length;
    const complete = done.length === rows.length;
    const fractions = done.map(checkFraction), checkScored = fractions.filter(f => f !== null).length;
    const tokens = rows.reduce((sum, row) => sum + (row.usage?.input || 0) + (row.usage?.output || 0), 0);
    return { id, name: NAMES[id], version: report.versions[id], passed, completed: done.length, expected: rows.length,
      score: complete && !invalid ? percent(passed / rows.length) : null,
      checkScore: complete && checkScored === rows.length ? percent(fractions.reduce((sum, f) => sum + f, 0) / rows.length) : null,
      observedCheckScore: done.length && checkScored === done.length && !invalid ? percent(fractions.reduce((sum, f) => sum + f, 0) / done.length) : null,
      observedPassRate: done.length && !invalid ? percent(passed / done.length) : null,
      coverage: rows.length ? percent(done.length / rows.length) : 0,
      checkScored, invalid,
      tokens, unreported: rows.reduce((sum, row) => sum + (row.usage?.unreported || 0), 0),
      durationMs: rows.reduce((sum, row) => sum + (row.durationMs || 0), 0),
      errors: done.filter(t => ['error', 'timeout', 'limit'].includes(t.status)).length };
  });
}
function collectChanges(task, cwd) {
  const changes = []; let bytes = 0, visited = 0;
  // A Python solution accepted by the grader must remain available for offline
  // regrading, even if scratch files fill the normal diff capture budget.
  if (task.library) {
    const file = path.join(cwd, 'solution.py');
    try {
      if (fs.lstatSync(file).isFile() && fs.statSync(file).size <= 1024 * 1024) {
        const content = fs.readFileSync(file), after = content.toString('utf8');
        changes.push({ path: 'solution.py', before: task.files['solution.py'] ?? null, after,
          sha256: createHash('sha256').update(content).digest('hex') });
        bytes += content.length;
      }
    } catch { /* The verifier reports missing or invalid files. */ }
  }
  function visit(dir, prefix = '') {
    if (prefix.split('/').length > 12) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++visited > 1000 || changes.length >= 24 || bytes >= 128000) return;
      if (entry.isSymbolicLink() || entry.name.startsWith('.') || ['node_modules', '__pycache__'].includes(entry.name)) continue;
      const relative = prefix + entry.name, file = path.join(dir, entry.name);
      if (entry.isDirectory()) { visit(file, relative + '/'); continue; }
      if (!entry.isFile() || relative === 'TASK.md' || changes.some(c => c.path === relative) || fs.statSync(file).size > 32000) continue;
      const content = fs.readFileSync(file);
      if (content.includes(0) || /\.(pyc|npy|npz|png|jpg|jpeg|gif|pdf|h5)$/i.test(relative)) continue;
      const after = content.toString('utf8'), before = task.files[relative] ?? null;
      if (after !== before) { bytes += after.length; changes.push({ path: relative, before, after }); }
    }
  }
  visit(cwd);
  return changes;
}

class BenchmarkRunner {
  constructor({ directory, runtimes, node, getRouter, onChange = () => {}, execute = runEngine, verify = verifyTask, libraries = null, verifyPython = verifyPythonTask, preflightPython = preflightPythonTasks }) {
    Object.assign(this, { directory, runtimes, node, getRouter, onChange, execute, verify, libraries, verifyPython, preflightPython });
    this.active = null; this.controller = null; this.pending = null; this.timer = null;
    fs.mkdirSync(directory, { recursive: true });
    // An interrupted application never silently resumes billable calls.
    for (const name of fs.readdirSync(directory).filter(n => /^[\w-]+\.json$/.test(n))) {
      try {
        const report = readJson(path.join(directory, name));
        if (report?.version === VERSION && ['running', 'cancelling'].includes(report.status)) {
          report.status = 'interrupted'; report.finishedAt = new Date().toISOString();
          for (const row of report.trials) if (row.status === 'running') { row.status = 'cancelled'; row.error = 'Application closed during this task'; }
          writeJson(path.join(directory, name), report);
        }
      } catch { /* A corrupt report must not prevent opening other reports. */ }
    }
  }
  history() {
    return fs.readdirSync(this.directory).filter(n => /^[\w-]+\.json$/.test(n)).map(name => {
      try { const r = readJson(path.join(this.directory, name)); return r?.version === VERSION ? r : null; } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 30);
  }
  report(id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid benchmark run');
    const report = this.active?.id === id ? this.active : readJson(path.join(this.directory, id + '.json'));
    if (!report || report.id !== id || report.version !== VERSION) throw new Error('Benchmark report not found');
    const snapshot = structuredClone(report);
    for (const task of snapshot.tasks || []) {
      const warnings = taskWarnings(task.id, snapshot.library);
      if (!task.warnings && warnings.length) task.warnings = warnings;
    }
    snapshot.comparisonNotes = comparisonNotes(snapshot);
    snapshot.checkScoreMethod = CHECK_SCORE_METHOD;
    for (const trial of snapshot.trials) trial.checkScore = percent(checkFraction(trial));
    return { ...snapshot, engines: summarize(report) };
  }
  state() {
    const router = this.getRouter()?.getState();
    const engines = ENGINES.map(id => {
      const runtime = this.runtimes().locate(id, 'api');
      return { id, name: NAMES[id], ready: Boolean(runtime), version: runtime?.version || runtime?.sdk || null };
    });
    const models = (router?.enabled ? router.providers : []).filter(p => p.enabled && p.keys.some(k => k.enabled && !router.usage[k.id]?.blocked))
      .flatMap(p => p.models.map(m => ({ id: m.id, providerId: p.id, provider: p.name, upstream: m.upstream })));
    const history = this.history();
    return { engines, models, preview: PREVIEW, busy: Boolean(this.pending), libraryBusy: Boolean(this.libraries?.busy), routerReady: Boolean(router?.running && router.enabled),
      libraries: [{ id: 'builtin', name: 'Camellia built-in', ready: true, description: 'Small integration checks for coding and file tools.' }, ...(this.libraries?.state() || [])]
        .map(library => ({ ...library, defaultTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS[library.id] || DEFAULT_TIMEOUT_SECONDS.builtin,
          defaultTokensPerTask: DEFAULT_TOKENS_PER_TASK[library.id] || DEFAULT_TOKENS_PER_TASK.builtin })),
      suites: [...publicSuites().map(s => ({ ...s, library: 'builtin', count: s.taskIds.length })), ...(this.libraries?.suites() || [])],
      active: this.active ? this.report(this.active.id) : null,
      history: history.map(r => ({ id: r.id, model: r.model, provider: r.provider, suite: r.suite, repeats: r.repeats, status: r.status, startedAt: r.startedAt })),
      latest: !this.active && history.length ? this.report(history[0].id) : null };
  }
  emit(immediate = false) {
    if (this.timer && !immediate) return;
    clearTimeout(this.timer);
    const send = () => { this.timer = null; try { this.onChange(this.state()); } catch { /* a closed window is harmless */ } };
    if (immediate) send(); else this.timer = setTimeout(send, 250);
  }
  save() { if (this.active) writeJson(path.join(this.directory, this.active.id + '.json'), this.active); }
  start(options = {}) {
    if (this.pending) throw new Error('A benchmark is already running');
    if (this.libraries?.busy) throw new Error('Wait for question library preparation to finish');
    const mode = options.mode || 'custom';
    if (!['preview', 'full', 'custom'].includes(mode)) throw new Error('Unknown benchmark mode');
    if (mode === 'preview') options = { ...options, ...PREVIEW };
    if (mode === 'full') {
      const library = options.library || (['quick', 'standard', undefined].includes(options.suite) ? 'builtin' : options.suite.split('-')[0]);
      options = { ...options, suite: library === 'builtin' ? 'standard' : `${library}-full` };
    }
    const external = this.libraries?.resolve(options.suite);
    const suite = external?.suite || SUITES.find(s => s.id === (options.suite || 'quick'));
    if (!suite) throw new Error('Unknown benchmark suite');
    const repeats = integer(options.repeats, 1, 1, 3);
    if (![1, 3].includes(repeats)) throw new Error('Choose one or three attempts per task');
    const timeoutSeconds = integer(options.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS[external?.library?.id] || DEFAULT_TIMEOUT_SECONDS.builtin, 30, 3600);
    const maxTokensPerTask = integer(options.maxTokensPerTask, DEFAULT_TOKENS_PER_TASK[external?.library?.id] || DEFAULT_TOKENS_PER_TASK.builtin, 10000, 5000000);
    const tokenBudget = options.tokenBudget == null ? null : integer(options.tokenBudget, undefined, 10000, MAX_TOKEN_BUDGET);
    const state = this.state();
    const model = state.models.find(m => m.id === options.model && m.providerId === options.providerId);
    if (!state.routerReady || !model) throw new Error('Choose a model with an enabled API key in Settings');
    const missing = state.engines.filter(e => !e.ready);
    if (missing.length) throw new Error('Download the missing engines first: ' + missing.map(e => e.name).join(', '));
    const node = this.node();
    if (!node || !fs.existsSync(node)) throw new Error('Node.js is required for benchmarking');
    // Validate and capture the route before any report or billable work starts.
    const validation = this.getRouter().createScope({ model: model.id, providerId: model.providerId });
    const routeFingerprint = validation.scope.routeFingerprint;
    void validation.close();
    const id = randomUUID();
    const orderOffset = parseInt(id.slice(0, 2), 16) % ENGINES.length;
    const trials = [];
    for (let repeat = 0; repeat < repeats; repeat++) for (const [taskIndex, task] of suite.taskIds.entries()) {
      const offset = (orderOffset + taskIndex + repeat) % ENGINES.length;
      for (let n = 0; n < ENGINES.length; n++) trials.push({ id: trials.length + 1, engine: ENGINES[(n + offset) % ENGINES.length], task, repeat: repeat + 1, status: 'pending' });
    }
    const previous = this.active;
    const previousExecution = this.execution;
    const taskList = external?.tasks || suite.taskIds.map(id => TASKS.find(t => t.id === id));
    this.execution = { tasks: new Map(taskList.map(task => [task.id, task])), runtime: external?.runtime };
    this.active = { id, version: VERSION, suiteHash: external?.suiteHash || suiteHash,
      graderVersion: external ? PYTHON_GRADER_VERSION : GRADER_VERSION, checkScoreMethod: CHECK_SCORE_METHOD,
      library: external?.library || { id: 'builtin', name: 'Camellia built-in', revision: VERSION },
      tasks: taskList.map(publicTask), suiteName: suite.name,
      ...(external ? { verificationLimits: { maxMs: 120000, caseMs: 30000 } } : {}),
      routeFingerprint, model: model.id, upstream: model.upstream, providerId: model.providerId, provider: model.provider,
      suite: suite.id, mode, repeats, timeoutSeconds, tokenBudget, maxRequestsPerTask: 40, maxTokensPerTask,
      maxDurationSeconds: mode === 'preview' ? PREVIEW.maxDurationSeconds : null,
      ...(mode === 'preview' ? { timeAllocation: { ...PREVIEW_TIME_ALLOCATION } } : {}),
      execution: { mode: 'parallel-engines', maxConcurrentTrials: ENGINES.length, perEngineConcurrency: 1 },
      versions: Object.fromEntries(state.engines.map(e => [e.id, e.version])), platform: process.platform + '-' + process.arch,
      configuration: { claude: 'stream-json; native defaults', codex: `app-server; shared Responses adapter; ${CODEX_API_TOOL_PROFILE}`, dsh: `shipped headless profile; ${DSH_MAX_OUTPUT_TOKENS} output tokens per response`, kimi: 'ACP; native defaults', antigravity: `SDK over ACP; native defaults; ${ANTIGRAVITY_API_TOOL_PROFILE}`,
        environment: 'fresh local workspace and profile for every trial; native tools; no personal settings or external MCP servers', thinking: 'native defaults; not normalized across engines',
        ...(external ? { pythonSelfTest: PYTHON_SCRATCH_FLAGS.join(' '), scientificThreads: 1,
          referenceLookup: 'local and remote benchmark datasets/tests/solutions outside the task workspace prohibited by prompt; not an OS sandbox' } : {}) },
      status: 'running', startedAt: new Date().toISOString(), finishedAt: null, trials };
    this.controller = new AbortController();
    try { this.save(); } catch (error) { this.active = previous; this.execution = previousExecution; this.controller = null; throw error; }
    this.pending = Promise.resolve().then(() => this.run(node)).finally(() => { this.pending = null; this.controller = null; this.emit(true); });
    this.emit(true);
    return { id };
  }
  async run(node) {
    const report = this.active, controller = this.controller;
    // A run-wide deadline also covers engine startup, verification and time
    // between tasks. Cancellation keeps the runner busy until cleanup finishes.
    const deadline = report.maxDurationSeconds ? Date.parse(report.startedAt) + report.maxDurationSeconds * 1000 : null;
    const expire = () => {
      if (controller.signal.aborted) return;
      report.status = 'time_limit_reached';
      for (const trial of report.trials) {
        if (trial.status === 'running') { trial.status = 'timeout'; trial.failureKind = 'run_time_limit'; }
        else if (trial.status === 'pending') { trial.status = 'skipped'; trial.error = 'Not started before the five-minute budget ended'; }
      }
      controller.abort('Five-minute preview budget reached');
      try { save(); } catch { /* fail() already records the save failure. */ }
      this.emit(true);
    };
    const deadlineTimer = deadline ? setTimeout(expire, Math.max(0, deadline - Date.now())) : null;
    const fail = error => {
      if (report.status !== 'error') { report.status = 'error'; report.error = String(error.message).slice(0, 1000); }
      controller.abort('Benchmark stopped: ' + report.error);
    };
    const save = () => { try { this.save(); } catch (error) { fail(error); throw error; } };
    try {
      if (this.execution.runtime) {
        report.activity = 'Checking grader environment'; this.emit(true);
        await this.preflightPython([...this.execution.tasks.values()], this.execution.runtime, process.env, controller.signal);
        report.activity = '';
      }
      // Each engine owns a sequential queue. Faster engines can advance while
      // another engine is still working; all workers finish cleanup before exit.
      await Promise.all(ENGINES.map(async engine => {
        try {
          for (const trial of report.trials.filter(t => t.engine === engine)) {
            if (deadline && Date.now() >= deadline) expire();
            if (controller.signal.aborted) break;
            if (report.timeAllocation?.mode === 'shared-preview' && trialTimeLimitMs(report, trial) <= 0) {
              trial.status = 'skipped'; trial.failureKind = 'preview_time_limit'; trial.error = 'Not started before this engine used its preview time budget';
              save(); this.emit(true); continue;
            }
            await this.runTrial({ node, report, controller, trial, save });
          }
        } catch (error) { fail(error); }
      }));
      if (report.status === 'running') report.status = report.trials.some(t => t.failureKind === 'preview_time_limit') ? 'time_limit_reached' : 'completed';
      else if (report.status === 'cancelling') report.status = 'cancelled';
    } catch (error) {
      if (report.status === 'cancelling' && controller.signal.aborted) report.status = 'cancelled';
      else fail(error);
    }
    finally {
      clearTimeout(deadlineTimer);
      report.activity = '';
      report.finishedAt = new Date().toISOString();
      try { this.save(); } catch (error) { report.status = 'error'; report.error = 'Could not save the report: ' + String(error.message).slice(0, 1000); }
    }
  }
  async runTrial({ node, report, controller, trial, save }) {
    const task = this.execution.tasks.get(trial.task);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-bench-'));
    const cwd = path.join(root, 'workspace'), home = path.join(root, 'profile');
    let route, closing, timer;
    const closeRoute = () => {
      if (route && !closing) {
        closing = route.close();
        // Abort events cannot await cleanup. The trial awaits it below.
        void closing.catch(() => {});
      }
      return closing;
    };
    const control = new AbortController();
    const relay = () => control.abort(controller.signal.reason || 'Cancelled');
    const abortRoute = () => { clearTimeout(timer); closeRoute(); };
    controller.signal.addEventListener('abort', relay, { once: true });
    control.signal.addEventListener('abort', abortRoute, { once: true });
    if (controller.signal.aborted) relay();
    const started = Date.now();
    trial.status = 'running'; trial.startedAt = new Date().toISOString(); trial.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, unreported: 0 };
    trial.timeline = []; trial.apiRequests = [];
    let requestsInFlight = 0;
    const recordEvent = (type, detail) => {
      trial.timeline.push({ atMs: Date.now() - started, type, detail: String(detail).slice(0, 180) });
      if (trial.timeline.length > 80) { trial.timeline.shift(); trial.omittedEvents = (trial.omittedEvents || 0) + 1; }
    };
    const activity = value => {
      if (trial.activity !== value) { trial.activity = value; recordEvent('activity', value); this.emit(); }
    };
    const failedTools = new Map();
    const recordToolFailure = event => {
      if (!(event.status === 'failed' || event.is_error)) return;
      // Kimi ACP prefixes native call IDs with its turn number.
      const id = trial.engine === 'kimi' ? String(event.id || '').replace(/^\d+:/, '') : event.id;
      const previous = id && failedTools.get(id);
      const detail = { atMs: Date.now() - started, tool: String(event.name || 'tool').slice(0, 100),
        input: (typeof event.input === 'string' ? event.input : JSON.stringify(event.input ?? '')).slice(0, 1000), output: String(event.output || '').slice(0, 1500) };
      if (previous) { Object.assign(previous, detail); return; }
      trial.toolFailureCount = (trial.toolFailureCount || 0) + 1;
      (trial.toolFailures ||= []).push(detail);
      if (id) failedTools.set(id, detail);
      if (trial.toolFailures.length > 10) trial.toolFailures.shift();
      recordEvent('tool_error', `${detail.tool}: ${String(event.output || 'Tool failed').replace(/\s+/g, ' ').trim()}`);
    };
    const timedOut = () => {
      trial.timeoutContext = { activity: trial.activity || 'Starting engine', requestsInFlight };
      recordEvent('timeout', `${trial.timeoutContext.activity}; ${requestsInFlight} API request(s) in flight`);
    };
    control.signal.addEventListener('abort', () => { if (trial.status === 'timeout') timedOut(); }, { once: true });
    try {
      save(); this.emit(true);
      if (control.signal.aborted) throw new Error(String(control.signal.reason));
      prepareTask(task, cwd);
      activity('Starting engine');
      route = this.getRouter().createScope({ model: report.model, providerId: report.providerId, routeFingerprint: report.routeFingerprint,
        maxRequests: report.maxRequestsPerTask, maxTokens: report.maxTokensPerTask,
        onToolResult: recordToolFailure,
        onRequest: request => {
          requestsInFlight++;
          recordEvent('request_start', `API request ${request.sequence}`);
          activity('Waiting for model response');
        },
        onLimit: () => { if (!control.signal.aborted) { trial.status = 'limit'; control.abort('Per-task API limit reached'); } },
        onUsage: record => {
          requestsInFlight = Math.max(0, requestsInFlight - 1);
          trial.apiRequests.push({ sequence: record.sequence, outcome: record.outcome, durationMs: record.durationMs,
            finishReason: record.finishReason || null, failureKind: record.failureKind || null });
          if (trial.apiRequests.length > 40) trial.apiRequests.shift();
          recordEvent('request_end', `API request ${record.sequence || trial.usage.requests + 1}: ${record.outcome}${record.durationMs != null ? ` after ${(record.durationMs / 1000).toFixed(1)}s` : ''}`);
          trial.usage.requests++;
          for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) trial.usage[key] += record.tokens?.[key] || 0;
          if (!record.tokens?.reported) trial.usage.unreported++;
          trial.lastRequest = { outcome: record.outcome, finishReason: record.finishReason || null, maxOutputTokens: record.maxOutputTokens || null,
            ...(record.error ? { error: record.error } : {}) };
          // Native title/summary generation can finish after the task response.
          // Keep the latest tool-enabled agent request separate from that work.
          if (record.hasTools !== false) trial.lastAgentRequest = { ...trial.lastRequest };
          if (record.error) {
            trial.apiError = record.error; trial.apiFailures ||= {};
            const kind = record.failureKind || 'upstream'; trial.apiFailures[kind] = (trial.apiFailures[kind] || 0) + 1;
          } else if (record.outcome === 'success') delete trial.apiError;
          const total = report.trials.reduce((sum, row) => sum + (row.usage?.input || 0) + (row.usage?.output || 0), 0);
          if (report.tokenBudget != null && total >= report.tokenBudget && !controller.signal.aborted) { report.status = 'budget_exceeded'; controller.abort('Run token limit reached'); }
          this.emit();
        } });
      if (route.scope.upstream !== report.upstream) throw new Error('The provider model mapping changed; start a new benchmark');
      report.routeFingerprint = route.scope.routeFingerprint;
      const timeLimitMs = trialTimeLimitMs(report, trial);
      trial.timeoutSeconds = Math.ceil(timeLimitMs) / 1000;
      const timeout = () => {
        trial.status = 'timeout';
        if (report.timeAllocation?.mode === 'shared-preview') trial.failureKind = 'preview_time_limit';
        control.abort(trial.failureKind === 'preview_time_limit' ? 'This engine used its shared preview time budget' : 'Task time limit reached');
      };
      if (!timeLimitMs) { timeout(); throw new Error(String(control.signal.reason)); }
      timer = setTimeout(timeout, timeLimitMs);
      const result = await this.execute({ engine: trial.engine, runtime: this.runtimes().locate(trial.engine, 'api'), node, cwd, home,
        model: report.model, route, signal: control.signal,
        python: this.execution.runtime?.python,
        prompt: `Complete the task in ${cwd}. Read TASK.md and inspect the provided files. Use tools to make and check the required changes. Only work in this directory. Do not ask the user questions.\n\n${this.execution.runtime ? `Use this prepared Python interpreter with ${PYTHON_SCRATCH_FLAGS.join(' ')} for scratch tests: ${this.execution.runtime.python}. Imports from your task directory are supported. Required scientific packages are already installed. Solve from the supplied description and files. Do not retrieve or inspect benchmark datasets, hidden tests, expected targets, or reference solutions, either locally or on the network. Do not browse the application data or benchmark-library directories. The interpreter path is provided only for executing Python and importing installed packages, not for discovering the grader or its files.\n\n` : ''}${task.instruction}`,
        onEvent: event => {
          if (event.type === 'gui:tool') {
            const failed = event.status === 'failed' || event.is_error;
            activity(`${event.status === 'in_progress' ? 'Running' : failed ? 'Failed' : 'Completed'} tool: ${String(event.name || 'tool').slice(0, 100)}`);
            if (event.status !== 'in_progress' && failed) recordToolFailure(event);
          }
          else if (event.type === 'stream_event' && event.event?.content_block?.name) activity('Running tool: ' + event.event.content_block.name);
          else if (event.type === 'stream_event' && event.event?.type === 'content_block_delta') activity('Receiving model response');
        } });
      clearTimeout(timer);
      await closeRoute();
      trial.text = result.text || ''; trial.log = result.log || '';
      const lastAgentRequest = trial.lastAgentRequest || trial.lastRequest;
      if (result.exitCode !== undefined) trial.engineExitCode = result.exitCode;
      if (control.signal.aborted) {
        if (trial.status === 'running') trial.status = controller.signal.aborted ? 'cancelled' : 'error';
        trial.error = String(control.signal.reason || result.error || 'Cancelled');
      } else if (!result.ok || lastAgentRequest?.outcome === 'error') {
        // Kimi ACP 0.43.0 can return end_turn after a terminal HTTP error.
        // Observe the last tool-enabled request after route cleanup, so neither
        // this success signal nor a late title request can hide the API failure.
        trial.status = 'error'; trial.error = lastAgentRequest?.error || trial.apiError || result.error || 'Engine failed to complete the task';
        if (lastAgentRequest?.outcome === 'success' && ['length', 'max_tokens'].includes(lastAgentRequest.finishReason)) {
          trial.failureKind = 'output_limit';
          trial.error = `The model reached its single-response output limit${lastAgentRequest.maxOutputTokens ? ` (${lastAgentRequest.maxOutputTokens.toLocaleString('en')} tokens)` : ''} before the engine completed. This is separate from the per-task token budget.`;
        }
      } else {
        activity('Verifying checks'); this.emit(true);
        const verdict = this.execution.runtime
          ? await this.verifyPython(task, cwd, this.execution.runtime, isolatedEnvironment(home, node), control.signal, report.verificationLimits)
          : await this.verify(task, cwd, node, isolatedEnvironment(home, node));
        if (control.signal.aborted) throw new Error(String(control.signal.reason || 'Cancelled'));
        trial.status = verdict.invalid ? 'grader_error' : verdict.passed ? 'passed' : 'failed'; trial.detail = verdict.detail; trial.verification = verdict;
        if (verdict.invalid && !controller.signal.aborted) {
          report.status = 'error'; report.error = verdict.detail;
          controller.abort('Grader error; further model requests stopped');
        }
      }
    } catch (error) {
      if (!['timeout', 'limit'].includes(trial.status)) trial.status = control.signal.aborted ? 'cancelled' : 'error';
      trial.error = String(error.message).slice(0, 1000);
    }
    finally {
      clearTimeout(timer); controller.signal.removeEventListener('abort', relay);
      control.signal.removeEventListener('abort', abortRoute);
      try { await closeRoute(); }
      finally {
        try { trial.changes = collectChanges(task, cwd); } catch { /* Startup may fail before the workspace exists. */ }
        trial.durationMs = Date.now() - started; trial.activity = '';
        // This is exclusively the directory just created above. Never accept
        // an IPC path or a candidate-provided path as a cleanup target.
        if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('camellia-bench-')) {
          try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch { trial.cleanupPending = true; }
        }
        save(); this.emit(true);
      }
    }
  }
  cancel() {
    if (this.pending && this.controller && !this.controller.signal.aborted) {
      this.active.status = 'cancelling'; this.controller.abort('Cancelled by user'); this.save(); this.emit(true);
    }
    return { ok: true };
  }
  async shutdown() { this.cancel(); await this.pending; clearTimeout(this.timer); }
}

module.exports = { BenchmarkRunner, summarize, collectChanges, PYTHON_SCRATCH_FLAGS, PREVIEW, trialTimeLimitMs };
