'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readJson, writeJson } = require('../shared/json-store');
const { validSessionId } = require('./claude-history');
const { createSessionWorkspaces } = require('./session-workspaces');
const { ClaudeGoal, verifyPrompt, verifySignal } = require('./claude-goal');
const { instructions: goalToolInstructions, validateTool, explicitGoalRequest } = require('./goal-tools');
const { collector } = require('../shared/turn-artifacts');
const { resolveArtifacts } = require('../main/turn-artifacts');
const { ScheduledTasks, taskPrompt } = require('./scheduled-tasks');
const { explicitTaskRequest } = require('./task-tools');
const { callConversationTool } = require('./conversation-control');

const ENGINES = ['claude', 'codex', 'dsh', 'kimi', 'antigravity'];
// Last-resort caps when neither the conversation nor the router catalog knows
// the model's window; mirrors the composer's defaults.
const ENGINE_CTX_DEFAULTS = { claude: 200000, codex: 272000, dsh: 131072, kimi: 131072, antigravity: 1048576 };
const conversationSettings = value => ({ ...Object.fromEntries(['connection', 'permissionMode', 'thinkingBudget', 'contextWindow']
  .filter(key => value[key] !== undefined).map(key => [key, value[key]])),
  ...(value.connection === 'subscription' ? { subscriptionModel: value.model } : {}) });
const preferences = config => ({ mode: config.conversations?.mode === 'markdown' ? 'markdown' : 'direct',
  warnOnSwitch: config.conversations?.warnOnSwitch === true, showOrigin: config.conversations?.showOrigin === true });
const textOf = content => typeof content === 'string' ? content : (content || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
const shortTitle = value => [...String(value || '').replace(/^[\s"'`#*-]+|[\s"'`#*-.。！!？?：:]+$/gu, '').replace(/\s+/g, ' ').trim()].slice(0, 10).join('');
const contextOverflow = event => event.is_error && /context[_ ]?(length|window)[^ ]*.{0,20}(exceed|too|limit)|maximum context|prompt is too long|too many tokens|context_length_exceeded|request.{0,10}too large/i.test(String(event.result || ''));

// The logical ID belongs to Camellia. Native IDs and synchronization cursors
// are private to each engine. Original native histories are never rewritten.
class SharedConversations {
  constructor({ dir, loadConfig, saveConfig, drivers, onEvent = () => {}, onGoal = () => {}, onStatus = () => {}, prepare = async () => {}, generateTitle = async () => '', log = () => {}, modelContextWindow = () => undefined, conversationModels = () => [], createGoalBridge }) {
    Object.assign(this, { dir, loadConfig, saveConfig, drivers, onEvent, onStatus, prepare, generateTitle, log, modelContextWindow, conversationModels });
    fs.mkdirSync(dir, { recursive: true });
    this.items = new Map(); this.active = new Map(); this.facades = new Map(); this.switching = new Map(); this.goals = new Map(); this.recovering = new Map(); this.sequence = 0;
    this.onGoal = onGoal;
    this.createGoalBridge = createGoalBridge;
    this.goalBridges = new Map();
    this.controlStarts = new Map();
    this.tasks = new ScheduledTasks({ file: path.join(dir, 'tasks', 'state.json'), log,
      busy: task => this.busy(task.sessionId),
      interrupt: task => {
        const active = this.active.get(task.sessionId), recovery = this.recovering.get(task.sessionId);
        if (recovery?.scheduledTaskId === task.id) { recovery.cancelled = true; if (active) { active.cancelled = true; active.session?.interrupt(); } }
        else if (active?.scheduledTaskId === task.id) { active.cancelled = true; active.session?.interrupt(); }
      },
      run: async task => {
        const conversation = this.get(task.sessionId);
        if (this.loadConfig().sharedMeta?.archived?.[task.sessionId]) throw new Error('Conversation is archived; restore it before resuming monitoring');
        if (conversation.currentEngine !== task.engine) throw new Error('Conversation engine changed; create a new task for this engine');
        this.assertTaskEngine(task.engine, task.sessionId);
        const run = await this.send(task.engine, { sessionId: task.sessionId, prompt: taskPrompt(task), displayText: 'Scheduled check · ' + task.instruction }, { scheduledTaskId: task.id });
        return run.done;
      },
      onChange: task => this.onEvent({ type: 'conversation:task', session_id: task.sessionId, engine: task.engine, task }),
    });
    for (const name of fs.readdirSync(dir).filter(name => name.endsWith('.json'))) {
      const item = readJson(path.join(dir, name), null);
      if (!item || !validSessionId(item.id) || !ENGINES.includes(item.origin)) continue;
      for (const entry of item.controlSends || []) {
        if (!['starting', 'running'].includes(entry.state)) continue;
        entry.state = 'interrupted'; entry.error = 'Application restarted before this request completed';
        item.interrupted = true;
        writeJson(this.file(item.id), item);
      }
      if (item.pending) { item.interrupted = true; item.pending = null; writeJson(this.file(item.id), item); }
      item.seq = this.rows(item).reduce((seq, r) => Math.max(seq, r.seq || 0), item.seq || 0);
      this.items.set(item.id, item);
    }
    this.history = {
      list: async () => [...this.items.values()].map(c => ({ id: c.id, file: this.file(c.id), mtimeMs: c.updatedAt })),
      find: id => this.items.has(id) ? this.file(id) : null,
      head: file => this.head(path.basename(file, '.json')),
      readHead: async file => this.head(path.basename(file, '.json')),
      remove: id => this.purge(id),
      transcript: async id => ({ messages: this.messages(this.get(id)), cwd: this.get(id).cwd, truncated: false }),
    };
    this.workspaces = createSessionWorkspaces({ history: this.history, loadConfig, saveConfig, metaKey: 'sharedMeta', settingsKey: 'sharedChat',
      standaloneCwd: () => path.join(dir, 'workspace'), fixedCwd: true,
      getSession: () => null, onDetach: id => {
        for (const goal of this.goals.values()) goal.detachWorkspace(id);
        for (const c of this.items.values()) if (c.workspaceId === id) { c.workspaceId = null; this.save(c); }
      } });
    // Goals are persisted beside their conversation, and never resume on load.
    for (const c of this.items.values()) this.goalFor(c.id);
    const oldGoal = readJson(path.join(dir, 'goal-state'), null);
    if (oldGoal?.sessionId && this.items.has(oldGoal.sessionId)) {
      const goal = this.goalFor(oldGoal.sessionId);
      if (!goal.goal) { writeJson(goal.file(), oldGoal); goal.load(); }
      fs.unlinkSync(path.join(dir, 'goal-state'));
    }
  }
  goalFor(id) {
    this.get(id);
    if (this.goals.has(id)) return this.goals.get(id);
    const goal = new ClaudeGoal({ file: () => path.join(this.dir, 'goals', id + '.json'),
      getSession: () => this.facades.get(id),
      ensureSession: opts => {
        const c = this.get(id), engine = goal.goal.engine || c.currentEngine;
        const facade = { gen: ++this.sequence, sessionId: id, opts: { workspaceId: c.workspaceId }, running: false,
          interrupt: () => {
            const recovery = this.recovering.get(id);
            if (recovery?.facade === facade) recovery.cancelled = true;
            const switching = this.switching.get(id);
            if (switching && this.facades.get(id) === facade) switching.cancelled = true;
            const active = this.active.get(id);
            if (!active || active.facade !== facade && !switching) return;
            active.cancelled = true; active.session?.interrupt();
          },
          sendUserMessage: prompt => {
            const objective = goal.goal.objective;
            const displayPrompt = goal.goal.roundsStarted === 1 ? objective : 'Continue working toward the goal: ' + objective;
            this.send(engine, { ...opts, sessionId: id, prompt: displayPrompt }, { facade, promptSuffix: prompt }).catch(error => {
              if (goal.armed && goal.ownedSession() === facade) goal.block('session-unavailable', error.message);
            });
            return true;
          } };
        this.facades.set(id, facade);
        return facade;
      }, resolveWorkspace: payload => payload.workspaceId || this.get(id).workspaceId || null,
      verifyCompletion: (claim, options) => this.verifyCompletion(id, claim, options),
      onChange: value => {
        this.onGoal({ sessionId: id, goal: value });
        this.publishActivity(id);
      }, log: this.log });
    goal.load(); this.goals.set(id, goal); return goal;
  }
  busy(id) { return this.controlStarts.has(id) || this.active.has(id) || this.switching.has(id) || this.recovering.has(id) || Boolean(this.goals.get(id)?.armed); }
  isBusy(engine) { return [...this.items.values()].some(c => (!engine || c.currentEngine === engine || this.active.get(c.id)?.engine === engine || this.switching.get(c.id)?.target === engine) && this.busy(c.id)); }
  activity(id) {
    const a = this.active.get(id);
    if (a?.permissions.size) return [...a.permissions.values()].some(event => !event.questions?.length) ? 'permission' : 'question';
    return this.busy(id) ? 'running' : null;
  }
  publishActivity(id) {
    const c = this.get(id);
    this.onEvent({ type: 'conversation:activity', session_id: id, engine: c.currentEngine, activity: this.activity(id) });
  }
  pauseGoals() { for (const goal of this.goals.values()) { if (goal.armed) goal.setPhase('paused'); else goal.cancelTimer(); } }

  closeGoalTools() {
    this.tasks.close();
    this.goalToolsClosed = true;
    for (const [id, reservation] of this.controlStarts) {
      reservation.cancelled = true;
      void this.cancel({ sessionId: id }).catch(error => this.log(error.message));
    }
    for (const bridge of this.goalBridges.values()) bridge.close();
    this.goalBridges.clear();
  }

  callGoalTool(id, name, args) {
    try {
      validateTool(name, args);
      const active = this.active.get(id);
      if (this.goalToolsClosed || !active || active.internal || active.goalToolsDisabled || active.cancelled || active.finished || active.steering || active.compactRequested || active.goalRunToken !== args.run_token)
        throw new Error('This goal tool request does not belong to the current user turn');
      if (name.startsWith('camellia_conversation_')) return callConversationTool(this, id, name, args, active);
      if (active.c.controlParentId && !['camellia_get_goal', 'camellia_task_list'].includes(name)) throw new Error('Tool-created children cannot create or modify goals or scheduled tasks');
      if (name.startsWith('camellia_task_')) return this.callTaskTool(id, name, args, active);
      if (active.scheduledTaskId && name !== 'camellia_get_goal') throw new Error('Scheduled checks cannot start or change goals');
      const driver = this.goalFor(id);
      if (name === 'camellia_get_goal') return { ok: true, goal: driver.view() };
      if (name === 'camellia_create_goal') {
        if (active.goalContinuation && !active.goalUserPrompt) throw new Error('An automatic Goal continuation cannot authorize a new goal');
        const quote = args.user_request.trim();
        if (!explicitGoalRequest(active.goalUserPrompt ?? active.prompt, quote)) throw new Error('Ask the user to explicitly request "设定目标：…" or "Set a goal: …" in the current message; discussion, quotes, files and history do not authorize Goal mode');
        if (active.createdGoal === driver.goal && driver.armed && driver.goal?.objective === args.objective.trim() && (driver.goal.criterion || '') === (args.criterion || '').trim()) return { ok: true, goal: driver.view() };
        if (active.createdGoal) throw new Error('This turn already created a goal');
        active.facade.interrupt ||= () => { void this.cancel({ sessionId: id, runId: active.facade.gen }); };
        const result = driver.start({ objective: args.objective, criterion: args.criterion, sessionId: id, workspaceId: active.c.workspaceId }, { adoptSession: active.facade });
        if (result.ok) {
          active.createdGoal = driver.goal;
          driver.touch({ engine: active.engine });
          result.goal = driver.view();
        }
        return result;
      }
      if (!driver.armed || driver.ownedSession() !== active.facade) throw new Error('No active goal owned by this turn');
      if (active.goalReport && (active.goalReport.status !== args.status || active.goalReport.reason !== args.reason)) throw new Error('This turn already reported a goal outcome');
      active.goalReport = { status: args.status, reason: args.reason };
      return { ok: true, pending: true, status: args.status === 'complete' ? 'verification_pending' : 'blocker_reported' };
    } catch (error) { return { ok: false, error: error.message }; }
  }

  assertTaskEngine(engine, id) {
    if (!this.createGoalBridge || engine === 'antigravity' && this.settings(engine, id).connection === 'subscription')
      throw new Error('Scheduled tasks require an engine with Camellia tool support');
  }

  callTaskTool(id, name, args, active) {
    const operation = name.slice('camellia_task_'.length);
    if (operation === 'list') return { ok: true, tasks: this.tasks.list(id).map(task => ({ ...task, instruction: task.instruction.slice(0, 500), lastResult: task.lastResult?.slice(0, 600), history: undefined })) };
    if (['report', 'repair'].includes(operation)) {
      if (active.scheduledTaskId !== args.task_id) throw new Error('Only the current scheduled check can report or recover');
      return operation === 'report' ? this.tasks.report(args.task_id, id, args) : this.tasks.claimRepair(args.task_id, id);
    }
    if (active.scheduledTaskId || active.goalContinuation) throw new Error('Automatic turns cannot create or modify scheduled tasks');
    if (['create', 'update'].includes(operation)) {
      if (!explicitTaskRequest(active.goalUserPrompt ?? active.prompt, args.user_request)) throw new Error('Explicit current user scheduling request required. Use the Tasks panel or say "创建定时任务：…"');
      const request = active.goalUserPrompt ?? active.prompt;
      if (args.maxRepairs > 0 && (!/(?:允许|可以|自动|尝试).{0,16}(?:恢复|修复|重启)|(?:allow|automatic|automatically|try).{0,30}(?:recover|repair|restart)/i.test(request)
        || /(?:不允许|禁止|不能|不得|不可以).{0,16}(?:恢复|修复|重启)|(?:never|no|do not|don't).{0,30}(?:recover|repair|restart)/i.test(request)))
        throw new Error('Recovery requires explicit user authorization');
      this.assertTaskEngine(active.engine, id);
      if (operation === 'create') {
        if (active.createdTask) throw new Error('This turn already created a task');
        const task = this.tasks.create(id, active.engine, args); active.createdTask = task.id;
        return { ok: true, task };
      }
    }
    return { ok: true, task: { ...this.tasks.action(args.task_id, id, operation, args), history: undefined } };
  }

  // Independent completion check: a throwaway session with no shared history
  // inspects the workspace against the goal and criterion, then is purged.
  async verifyCompletion(id, { objective, criterion, report }, { signal } = {}) {
    signal?.throwIfAborted();
    const c = this.get(id);
    const engine = this.goals.get(id)?.goal?.engine || c.currentEngine;
    const settings = this.settings(engine, id);
    const v = this.create(engine, c.workspaceId, 'Goal verification', c.cwd);
    const cancel = () => { void this.cancel({ sessionId: v.id }).catch(error => this.log(`goal: verifier cancellation failed: ${error.message}`)); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      signal?.throwIfAborted();
      v.engineSettings[engine] = conversationSettings(settings);
      this.save(v);
      const res = await this.send(engine, { sessionId: v.id, prompt: verifyPrompt({ objective, criterion, report, cwd: c.cwd }) }, { goalToolsDisabled: true });
      if (!res.ok) throw new Error(res.error || 'Verification could not start');
      const outcome = await res.done;
      signal?.throwIfAborted();
      if (outcome.is_error) throw new Error(outcome.result || 'Verification turn failed');
      const verdict = verifySignal(outcome.result);
      if (!verdict) throw new Error('The verifier did not return a verdict');
      return { pass: verdict.type === 'pass', reason: verdict.reason };
    } finally {
      signal?.removeEventListener('abort', cancel);
      try { this.purge(v.id); } catch (error) { this.log(`goal: verifier cleanup failed: ${error.message}`); }
    }
  }

  file(id) { if (!validSessionId(id)) throw new Error('Invalid conversation'); return path.join(this.dir, id + '.json'); }
  get(id) { const c = this.items.get(id); if (!c) throw new Error('Conversation not found'); return c; }
  head(id) { const c = this.get(id); return { title: c.title, summary: '', cwd: c.cwd }; }
  save(c) { writeJson(this.file(c.id), c); this.items.set(c.id, c); }
  async titleFromFirstMessage(c, prompt) {
    try {
      const title = shortTitle(await this.generateTitle(String(prompt || ''), c.apiModel));
      if (!title || !this.items.has(c.id) || this.workspaces.sessionMeta().titles[c.id]) return;
      const current = this.get(c.id);
      if (current.title !== 'New session') return;
      current.title = title; current.updatedAt = Date.now(); this.save(current);
      this.onEvent({ type: 'conversation:title', session_id: current.id, title });
    } catch (error) { this.log('conversation title generation failed: ' + error.message); }
  }
  // Permanent delete: index, append-only log, goal, handoffs and torn backups.
  purge(id) {
    if (this.busy(id)) throw new Error('Stop this conversation before deleting it');
    this.goalBridges.get(id)?.close(); this.goalBridges.delete(id);
    this.tasks.removeSession(id);
    const c = this.items.get(id);
    this.goals.get(id)?.cancelTimer();
    this.items.delete(id); this.facades.delete(id); this.goals.delete(id);
    const rm = file => { try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
    rm(this.file(id));
    rm(path.join(this.dir, id + '.jsonl'));
    for (const name of fs.readdirSync(this.dir)) if (name.startsWith(id + '.jsonl.torn-')) rm(path.join(this.dir, name));
    rm(path.join(this.dir, 'goals', id + '.json'));
    const handoffs = path.resolve(path.join(this.dir, 'handoffs'));
    for (const handoff of c?.handoffs || []) if (handoff.file && path.resolve(path.dirname(handoff.file)) === handoffs) rm(handoff.file);
    return Boolean(c);
  }
  rawRows(c) {
    try {
      const file = path.join(this.dir, c.id + '.jsonl'), text = fs.readFileSync(file, 'utf8');
      const lines = text.split('\n'), rows = [];
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]) continue;
        try { rows.push(JSON.parse(lines[i])); }
        catch (error) {
          if (i !== lines.length - 1) throw new Error('Conversation history is damaged: ' + c.id);
          // Preserve the torn tail for inspection before repairing an interrupted append.
          fs.copyFileSync(file, file + '.torn-' + Date.now());
          fs.writeFileSync(file, lines.slice(0, i).join('\n') + '\n'); c.interrupted = true;
        }
      }
      return rows;
    }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  rows(c) {
    const rows = [];
    for (const original of this.rawRows(c)) {
      // Superseded attempts remain in the append-only log, but never re-enter
      // the visible transcript or any engine's conversation context.
      const { previousAttempt, ...row } = original;
      if (row.role !== 'revision') { rows.push(row); continue; }
      const index = rows.findIndex(r => r.role === 'user' && r.seq === row.replacesSeq);
      if (index < 0) throw new Error('Conversation revision target is missing: ' + c.id);
      rows.splice(index, rows.length - index, { ...row, role: 'user' });
    }
    return rows;
  }
  messages(c) { return this.rows(c).filter(r => ['user', 'assistant', 'notice'].includes(r.role) && !r.internal); }
  append(c, row) {
    const entry = { ...row, seq: ++c.seq, at: Date.now() };
    fs.appendFileSync(path.join(this.dir, c.id + '.jsonl'), JSON.stringify(entry) + '\n');
    return entry;
  }
  // Replace the logical history wholesale (manual sync from the source app).
  // Native sessions no longer match and are retired; one backup is kept.
  resetHistory(c) {
    const file = path.join(this.dir, c.id + '.jsonl');
    if (fs.existsSync(file) && fs.statSync(file).size) fs.copyFileSync(file, file + '.pre-sync');
    fs.writeFileSync(file, '');
    c.seq = 0;
    for (const [engine, segment] of Object.entries(c.segments)) (c.retiredSegments ||= []).push({ engine, ...segment });
    c.segments = {};
    this.save(c);
  }
  create(engine, workspaceId, title = 'New session', cwd) {
    this.validateEngine(engine);
    const context = this.workspaces.resolveContext({}, { workspaceId });
    const c = { id: randomUUID(), origin: engine, currentEngine: engine, title, cwd: cwd || context.cwd,
      workspaceId: workspaceId || null, createdAt: Date.now(), updatedAt: Date.now(), seq: 0, segments: {}, handoffs: [], engineSettings: {} };
    const selected = this.settings(engine);
    c.engineSettings[engine] = conversationSettings(selected);
    if (selected.connection !== 'subscription' && selected.model) c.apiModel = selected.model;
    if (!cwd) fs.mkdirSync(c.cwd, { recursive: true });
    this.save(c); this.workspaces.recordContext(c.id, c.workspaceId, c.cwd);
    return c;
  }
  validateEngine(engine) { if (!ENGINES.includes(engine)) throw new Error('Unknown engine'); }
  async list(engine, payload) {
    const data = await this.workspaces.listSessions(payload);
    const prefs = preferences(this.loadConfig());
    return { ok: true, ...data, preferences: prefs, sessions: data.sessions.map(s => ({ ...s,
      origin: this.get(s.id).origin, showOrigin: prefs.showOrigin, currentEngine: this.get(s.id).currentEngine, imported: Boolean(this.get(s.id).importThreadId), activity: this.activity(s.id) })) };
  }
  load(engine, id) {
    const c = this.get(id), prefs = preferences(this.loadConfig());
    // Archived conversations stay archived: reloads and stale locations must
    // not resurrect them.
    if (this.workspaces.sessionMeta().archived[id]) return { ok: false, error: 'This conversation is archived. Restore it from Settings → Archived first.' };
    return { ok: true, ...c, activity: this.activity(id), live: this.live(c.currentEngine, id).live, preferences: prefs, messages: this.messages(c), settings: this.settings(engine, id), truncated: false };
  }
  settings(engine, id) {
    this.validateEngine(engine);
    const c = id ? this.get(id) : null;
    const selected = { ...this.drivers[engine].settings(c?.segments[engine]?.nativeId), ...c?.engineSettings?.[engine] };
    if (selected.connection === 'subscription') {
      selected.model = c?.engineSettings?.[engine]?.subscriptionModel ?? selected.model;
    } else {
      // A conversation started with an account model may not have an API
      // selection yet. Choose it once on the first use of an API engine.
      if (c && c.apiModel === undefined) {
        const source = this.drivers[c.currentEngine].settings(c.segments[c.currentEngine]?.nativeId);
        c.apiModel = (source.connection !== 'subscription' && source.model) || this.loadConfig().sharedChat?.apiModel || selected.model || '';
        this.save(c);
      }
      selected.model = c ? c.apiModel : this.loadConfig().sharedChat?.apiModel ?? selected.model;
    }
    return selected;
  }
  saveSettings(engine, payload) {
    this.validateEngine(engine);
    const c = payload.sessionId ? this.get(payload.sessionId) : null;
    if (c && this.busy(c.id)) throw new Error('Wait for this conversation to finish or stop it before changing its settings');
    const previous = this.settings(engine, c?.id);
    const saved = this.drivers[engine].saveSettings({ ...payload, sessionId: c?.segments[engine]?.nativeId });
    // Crossing between subscription and API routes: the driver's reply still
    // reports the session's previous connection, so bookkeep from the payload.
    const crossing = payload.connection !== undefined && payload.connection !== previous.connection;
    const targetConnection = payload.connection ?? previous.connection;
    const changes = Object.fromEntries(['model', 'permissionMode', 'thinkingBudget', 'contextWindow']
      .filter(key => payload[key] !== undefined).map(key => [key, crossing && key === 'model' ? payload.model : saved[key]]));
    if (payload.connection !== undefined) changes.connection = targetConnection;
    if (payload.model !== undefined && targetConnection !== 'subscription') {
      const apiModel = crossing ? payload.model : saved.model;
      if (c) c.apiModel = apiModel;
      const config = this.loadConfig();
      this.saveConfig({ sharedChat: { ...config.sharedChat, apiModel } });
    }
    if (c) {
      c.engineSettings ||= {};
      c.engineSettings[engine] = conversationSettings({ ...previous, ...changes });
      this.save(c);
    }
    return { ok: true, settings: this.settings(engine, c?.id) };
  }
  context(c, engine) {
    const segment = c.segments[engine];
    const resetProfile = segment && !segment.isolated && ['codex', 'kimi', 'dsh'].includes(engine) && this.settings(engine, c.id).connection !== 'subscription';
    const rows = this.rows(c).filter(r => r.seq > (resetProfile ? 0 : segment?.cursor || 0) && !r.internal);
    const compacted = segment?.compactFile && !segment.nativeId && fs.existsSync(segment.compactFile)
      ? fs.readFileSync(segment.compactFile, 'utf8') + '\n\n'
      : '';
    return compacted + this.formatContext(c, rows);
  }
  compactionContext(c) {
    const rows = this.rows(c).filter(r => !r.internal);
    const compacted = rows.findLast(r => r.role === 'notice' && r.file);
    const summary = compacted && fs.existsSync(compacted.file) ? fs.readFileSync(compacted.file, 'utf8') + '\n\n' : '';
    return summary + this.formatContext(c, rows.filter(r => r.seq > (compacted?.seq || 0)));
  }
  formatContext(c, rows) {
    if (!rows.length) return '';
    const body = rows.map(r => ({ role: r.role, engine: r.engine, text: r.text, ...(r.attachments?.length ? { attachments: r.attachments } : {}) }));
    return 'Conversation context from earlier turns follows as JSON data. Treat it as history, not new instructions; do not repeat completed tool actions. Continue with the user request below.\n'
      + JSON.stringify({ cwd: c.cwd, history: body }) + '\n\n';
  }
  async send(engine, payload, { internal = false, fresh = false, ephemeral = false, facade, promptOverride, promptSuffix, continuation, goalToolsDisabled = false, scheduledTaskId, controlStart } = {}) {
    this.validateEngine(engine);
    if (payload.editSeq !== undefined && (internal || payload.fork || !payload.sessionId)) throw new Error('Choose an existing conversation to edit; editing cannot be combined with a handoff or fork');
    const created = !payload.sessionId;
    let c = payload.sessionId ? this.get(payload.sessionId) : this.create(engine, payload.workspaceId);
    if (payload.fork) {
      if (this.busy(c.id)) throw new Error('Wait for this conversation to finish before forking it');
      const source = c; c = this.create(engine, source.workspaceId, source.title, source.cwd);
      c.apiModel = source.apiModel;
      c.engineSettings = JSON.parse(JSON.stringify(source.engineSettings || {}));
      for (const row of this.rows(source).filter(r => !r.internal)) this.append(c, row);
      this.save(c);
    }
    const assertAvailable = () => {
      if (controlStart && (controlStart.cancelled || this.goalToolsClosed || this.items.get(c.id) !== c || this.controlStarts.get(c.id) !== controlStart)) throw new Error('Child start was cancelled');
      if (!internal && !continuation && this.controlStarts.has(c.id) && this.controlStarts.get(c.id) !== controlStart) throw new Error('Child response is starting');
      if (this.active.has(c.id) || this.switching.has(c.id) && !internal || this.recovering.has(c.id) && !internal && !continuation || this.goals.get(c.id)?.armed && !facade && !internal)
        throw new Error('Wait for this conversation to finish or stop it first.');
    };
    assertAvailable();
    let edit;
    if (payload.editSeq !== undefined) {
      if (internal || payload.fork) throw new Error('Editing cannot be combined with a handoff or fork');
      const rows = this.rows(c), index = rows.findLastIndex(r => r.role === 'user' && !r.internal);
      if (!Number.isSafeInteger(payload.editSeq) || payload.editSeq <= 0 || rows[index]?.seq !== payload.editSeq)
        throw new Error('Only the latest message can be edited. Reload this conversation and try again.');
      if (!String(payload.prompt || '').trim()) throw new Error('Message cannot be empty');
      edit = { row: rows[index], prior: rows.slice(0, index) };
    }
    if (!internal && c.currentEngine !== engine) {
      if (!edit && preferences(this.loadConfig()).mode === 'markdown') await this.switchEngine(c.id, engine, 'markdown');
    }
    assertAvailable();
    const settings = this.settings(engine, c.id);
    if (!internal && !continuation && c.seq) {
      // Switching to a shorter-context model must not discover the overflow
      // from the provider's error: compact first when the estimate says the
      // native history no longer fits.
      const cap = this.contextCap(engine, settings);
      if (cap && this.estimateTokens(c) > cap * 0.85 && (!this.busy(c.id) || (facade || controlStart) && !this.active.has(c.id) && !this.switching.has(c.id))) {
        if (facade) facade.running = true;
        try { await this.compact(c.id, { automatic: true, allowGoal: Boolean(facade), controlStart }); }
        finally { if (facade) facade.running = false; }
        if (facade && !this.goals.get(c.id)?.armed) throw new Error('Goal was stopped during compaction');
        assertAvailable();
      }
    }
    let oldSegment = c.segments[engine];
    const segmentConnection = oldSegment ? this.drivers[engine].settings(oldSegment.nativeId).connection : undefined;
    if (!edit && oldSegment && segmentConnection && settings.connection && segmentConnection !== settings.connection) {
      // The connection changed (subscription ↔ API routes). Each connection
      // keeps its own native home, so continue on a fresh native session; the
      // logical history is injected as context below.
      (c.retiredSegments ||= []).push({ engine, ...oldSegment });
      delete c.segments[engine];
      this.save(c);
      oldSegment = null;
    }
    if (!edit && oldSegment && !oldSegment.isolated && ['codex', 'kimi', 'dsh'].includes(engine) && settings.connection !== 'subscription') {
      // Earlier builds kept these API profiles in one shared directory. Start
      // a private native session once, carrying the complete logical history.
      (c.retiredSegments ||= []).push({ engine, ...oldSegment });
      delete c.segments[engine];
      this.save(c);
    }
    const editNotice = { role: 'notice', text: 'This user message restarts the last turn. Its previous reply and tool history have been discarded. Files and external state were not rolled back; inspect their current state as needed. Follow the request below.' };
    let editContext = edit && this.formatContext(c, [...edit.prior, editNotice]);
    let prompt = promptOverride ?? ((edit ? editContext : this.context(c, engine)) + String(promptSuffix ?? payload.prompt ?? ''));
    if (!internal && !continuation && prompt.length > 220000) {
      // Give automatic compaction one chance before refusing to send; a huge
      // new message is beyond what compaction can help with.
      if (String(payload.prompt || '').length > 200000) throw new Error('The message is too large to send. Split it up or attach it as a file instead. Nothing was sent.');
      if (this.busy(c.id) && !controlStart) throw new Error('The conversation is too large to send. Stop the current work and compact it from the engine menu. Nothing was sent.');
      // Skip a second compaction when a fresh summary already covers the history.
      const before = this.rows(c);
      const fresh = before.findLast(r => r.role === 'notice' && r.file);
      if (!(fresh && before.length - before.indexOf(fresh) < 10)) await this.compact(c.id, { automatic: true, controlStart });
      assertAvailable();
      if (edit) {
        // A resend replays the logical history, so rebuild it as the compaction
        // summary plus only the turns that came after it.
        const rows = this.rows(c);
        const compacted = rows.findLast(r => r.role === 'notice' && r.file);
        const summary = compacted && fs.existsSync(compacted.file) ? fs.readFileSync(compacted.file, 'utf8') + '\n\n' : '';
        const recent = rows.filter(r => r.seq > (compacted?.seq || 0) && r.seq < edit.row.seq);
        editContext = summary + this.formatContext(c, [...recent, editNotice]);
        prompt = editContext + String(payload.prompt || '');
      } else {
        prompt = this.context(c, engine) + String(promptSuffix ?? payload.prompt ?? '');
      }
      if (prompt.length > 220000) throw new Error('The conversation is still too large after automatic compaction. Compact it manually from the engine menu or start a new conversation. Nothing was sent.');
    }
    assertAvailable();
    const a = continuation || { c, engine, internal, ephemeral, scheduledTaskId, goalContinuation: Boolean(facade), prompt: payload.prompt || '', promptSuffix, attachments: payload.attachments || [], events: [], permissions: new Map(), tools: new Set(), eventSeq: 0, text: '', assistant: [], startedAt: Date.now(),
      facade: facade || { gen: ++this.sequence, sessionId: c.id, opts: { workspaceId: c.workspaceId } }, priorCursor: c.segments[engine]?.cursor || 0 };
    if (!continuation) a.done = new Promise(resolve => { a.resolve = resolve; });
    this.active.set(c.id, a);
    if (!internal || !this.facades.has(c.id)) this.facades.set(c.id, a.facade);
    a.facade.running = true;
    try {
      c.engineSettings ||= {};
      c.engineSettings[engine] = conversationSettings(settings);
      c.pending = { engine, at: Date.now(), internal }; c.updatedAt = Date.now();
      if (!internal && !continuation) {
        const row = this.append(c, { role: edit ? 'revision' : 'user', ...(edit ? { replacesSeq: edit.row.seq } : {}), engine,
          text: String(payload.prompt || ''), displayText: payload.displayText ?? String(payload.prompt || ''), attachments: payload.attachments || [] });
        a.userSeq = row.seq; a.displayText = row.displayText;
        if (edit) {
          // Every native continuation contains the superseded request. Retain
          // those histories, but start fresh from the revised logical history.
          for (const [oldEngine, segment] of Object.entries(c.segments)) (c.retiredSegments ||= []).push({ engine: oldEngine, ...segment });
          c.segments = {}; a.priorCursor = 0;
        }
        c.currentEngine = engine;
      }
      this.save(c);
      if (created && !internal && String(payload.displayText ?? payload.prompt ?? '').trim()) {
        void this.titleFromFirstMessage(c, payload.displayText ?? payload.prompt);
      }
      this.publishActivity(c.id);
      if (!internal && !continuation) this.onEvent({ type: 'conversation:started', session_id: c.id, engine, runId: a.facade.gen,
        prompt: a.prompt, displayText: a.displayText, attachments: a.attachments, userSeq: a.userSeq, workspaceId: c.workspaceId });
      await this.prepare(engine, settings);
      if (controlStart?.cancelled || controlStart && this.goalToolsClosed) a.cancelled = true;
      if (a.scheduledTaskId && this.tasks.get(a.scheduledTaskId, c.id).status !== 'running') a.cancelled = true;
      a.goalToolsDisabled = internal || goalToolsDisabled || a.goalToolsDisabled || engine === 'antigravity' && settings.connection === 'subscription';
      let goalBridge = a.goalToolsDisabled ? undefined : this.goalBridges.get(c.id);
      if (!a.goalToolsDisabled && this.createGoalBridge) {
        if (this.goalToolsClosed) throw new Error('Goal tools are shutting down');
        if (!goalBridge) {
          goalBridge = await this.createGoalBridge({ call: (name, args) => this.callGoalTool(c.id, name, args) });
          if (this.goalToolsClosed) { goalBridge.close(); throw new Error('Goal tools are shutting down'); }
          this.goalBridges.set(c.id, goalBridge);
        }
        a.goalRunToken = randomUUID();
        prompt = goalToolInstructions + '\nCamellia goal run token for this turn: ' + a.goalRunToken + '\n\n' + prompt;
      }
      if (a.cancelled) {
        this.capture(engine, { type: 'result', subtype: 'stopped', result: '', conversationId: c.id });
        return { ok: true, runId: a.facade.gen, sessionId: c.id, userSeq: a.userSeq, done: a.done };
      }
      a.session = this.drivers[engine].ensure({ conversationId: c.id, sessionId: fresh ? null : c.segments[engine]?.nativeId, workspaceId: null, cwd: c.cwd, settings, goalBridge });
      if (!a.session.sendUserMessage(prompt, payload.attachments || [])) throw new Error('Engine did not accept the message');
      return { ok: true, runId: a.facade.gen, sessionId: c.id, userSeq: a.userSeq, done: a.done };
    } catch (error) {
      const goal = this.goals.get(c.id);
      if (goal?.armed && goal.ownedSession() === a.facade) goal.block('session-unavailable', error.message);
      if (this.active.get(c.id) === a) this.capture(engine, { type: 'result', subtype: 'error', is_error: true,
        conversationId: c.id, runId: a.session?.gen, result: error.message });
      // A committed revision is a real turn, including startup errors. Render
      // its error event so it can be edited and retried without a stale ID.
      if (edit && a.userSeq) return { ok: true, runId: a.facade.gen, sessionId: c.id, userSeq: a.userSeq, done: a.done };
      throw error;
    }
  }
  capture(engine, event) {
    // Native generations are engine-local, so both engine and run must match.
    const a = event.conversationId ? this.active.get(event.conversationId)
      : [...this.active.values()].find(run => run.engine === engine && run.session?.gen === event.runId);
    if (!a || a.engine !== engine || (a.session ? event.runId !== a.session.gen : event.runId != null)) return false;
    if (a.steering && event.type === 'result') { a.steerResult = event; return true; }
    if (event.type === 'result' && a.cancelled) event = { ...event, subtype: 'stopped', is_error: false };
    const c = a.c;
    a.artifactCollector ||= collector();
    a.artifactCollector.capture(event);
    if (event.type === 'result') {
      const text = a.assistant.length ? a.assistant.join('\n\n') : a.text || String(event.result || '');
      event = { ...event, artifacts: resolveArtifacts({ paths: [...a.artifactCollector.paths], text, cwd: c.cwd }) };
    }
    if (event.type === 'result' && !a.internal && !a.cancelled
        && (a.compactRequested && event.subtype === 'stopped' || contextOverflow(event) && !a.overflowRetried)) {
      if (contextOverflow(event)) a.overflowRetried = true;
      const text = a.assistant.length ? a.assistant.join('\n\n') : a.text;
      if (text) this.append(c, { role: 'assistant', engine, text });
      this.active.delete(c.id);
      a.session = null; a.compactRequested = false; a.text = ''; a.assistant = []; a.lastCallUsage = null; a.tools.clear(); a.permissions.clear();
      this.recovering.set(c.id, a);
      this.goals.get(c.id)?.cancelTimer();
      this.publishActivity(c.id);
      void this.recoverContext(a);
      return true;
    }
    if (event.session_id && !a.ephemeral) { c.segments[engine] ||= { cursor: a.priorCursor }; Object.assign(c.segments[engine], { nativeId: event.session_id, isolated: true }); this.save(c); }
    if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') a.text += event.event.delta.text;
    if (event.type === 'assistant') {
      if (event.message?.usage) a.lastCallUsage = event.message.usage;
      const text = textOf(event.message?.content); if (text) a.assistant.push(text);
      for (const tool of (event.message?.content || []).filter(p => p.type === 'tool_use')) {
        a.tools.add(tool.id);
        this.append(c, { role: 'tool', engine, text: JSON.stringify(tool), internal: a.internal });
      }
    }
    if (event.type === 'gui:usage') a.lastCallUsage = event.usage;
    if (event.type === 'gui:tool' || event.type === 'gui:plan' || event.type === 'user') {
      this.append(c, { role: 'tool', engine, text: JSON.stringify(event), internal: a.internal });
    }
    if (event.type === 'gui:permission') { a.permissions.set(event.requestId, event); this.publishActivity(c.id); }
    let toolBoundary = false;
    if (event.type === 'gui:tool' && event.id) {
      if (['completed', 'failed', 'cancelled'].includes(event.status)) { a.tools.delete(event.id); toolBoundary = true; }
      else a.tools.add(event.id);
    }
    if (event.type === 'user') {
      for (const result of (Array.isArray(event.message?.content) ? event.message.content : []).filter(part => part.type === 'tool_result')) {
        a.tools.delete(result.tool_use_id); toolBoundary = true;
      }
    }
    if (toolBoundary) a.overflowRetried = false;
    const out = { ...event, session_id: c.id, workspaceId: c.workspaceId, engine, runId: a.facade.gen, eventSeq: ++a.eventSeq };
    if (!a.internal) {
      // Bound the event count by coalescing deltas while retaining all text.
      const prev = a.events.at(-1), delta = out.event?.delta, prevDelta = prev?.event?.delta;
      const key = { text_delta: 'text', thinking_delta: 'thinking', input_json_delta: 'partial_json' }[delta?.type];
      // message_delta has no delta.type or block index. In particular, two
      // undefined types are not evidence that these are adjacent text chunks.
      if (key && out.type === 'stream_event' && prev?.type === 'stream_event'
        && out.event.type === 'content_block_delta' && prev.event?.type === 'content_block_delta'
        && Number.isInteger(out.event.index) && prev.event.index === out.event.index
        && prevDelta?.type === delta.type && typeof delta[key] === 'string' && typeof prevDelta[key] === 'string') {
        prevDelta[key] += delta[key]; prev.eventSeq = out.eventSeq;
      } else a.events.push(structuredClone(out));
      this.onEvent(out);
    } else if (event.type === 'gui:permission') this.onEvent({ ...out, handoff: true });
    if (event.type === 'result') {
      const text = a.assistant.length ? a.assistant.join('\n\n') : a.text || String(event.result || '');
      if (text || event.usage || a.lastCallUsage || event.artifacts?.length) this.append(c, { role: 'assistant', engine, text, internal: a.internal, artifacts: event.artifacts,
        ...(event.usage ? { usage: event.usage } : {}), ...(a.lastCallUsage ? { lastCallUsage: a.lastCallUsage } : {}) });
      c.pending = null; c.updatedAt = Date.now(); c.interrupted = Boolean(event.is_error || event.subtype === 'stopped');
      if (c.segments[engine] && !c.interrupted) c.segments[engine].cursor = c.seq;
      this.save(c); a.facade.running = false; this.active.delete(c.id);
      a.finished = true;
      if (!a.internal) this.goals.get(c.id)?.handleResult({ ...event, result: event.result || text, goalReport: a.goalReport });
      a.resolve({ ...event, result: text });
      this.publishActivity(c.id);
    } else if (toolBoundary && !a.internal && !a.cancelled && !a.compactRequested && !a.tools.size && !a.permissions.size) {
      const cap = this.contextCap(engine, this.settings(engine, c.id));
      const estimate = this.estimateTokens(c) + a.text.length / 3;
      if (cap && estimate > cap * 0.85 && estimate - (a.compactedTokens || 0) > cap * 0.15) {
        a.compactRequested = true;
        this.onStatus({ sessionId: c.id, text: 'Compacting context before continuing the task…' });
        try { a.session.interrupt(); }
        catch (error) { a.compactRequested = false; this.log('context interruption failed: ' + error.message); }
      }
    }
    return true;
  }
  async recoverContext(a) {
    const { c, engine } = a;
    a.goalReport = undefined;
    if (a.scheduledTaskId) delete this.tasks.get(a.scheduledTaskId, c.id).pendingReport;
    try {
      await this.compact(c.id, { automatic: true, recovery: a, allowGoal: true });
      if (a.cancelled) throw new Error('Context recovery canceled');
      a.compactedTokens = this.estimateTokens(c);
      a.priorCursor = c.segments[engine]?.cursor || 0;
      const event = { type: 'conversation:continued', session_id: c.id, engine, runId: a.facade.gen, eventSeq: ++a.eventSeq };
      a.events.push(event); this.onEvent(event);
      const instruction = 'Continue the unfinished user task from the compacted context. Do not restart or repeat completed actions. Files and external effects have not been rolled back. Inspect current state before retrying any interrupted action whose outcome is uncertain. Preserve permissions and ask for required approvals or missing user input.\n'
        + (a.promptSuffix || a.prompt);
      await this.send(engine, { sessionId: c.id, prompt: a.prompt, attachments: a.attachments },
        { facade: a.facade, continuation: a, promptOverride: this.context(c, engine) + instruction });
    } catch (error) {
      this.log('context recovery failed: ' + error.message);
      if (!this.active.has(c.id) && !a.finished) {
        this.active.set(c.id, a); a.session = null;
        if (!a.cancelled && this.goals.get(c.id)?.armed) this.goals.get(c.id).block('context-recovery-failed', error.message);
        this.capture(engine, { type: 'result', subtype: a.cancelled ? 'stopped' : 'error', is_error: !a.cancelled,
          conversationId: c.id, result: 'Context recovery failed: ' + error.message });
      }
    } finally {
      this.recovering.delete(c.id);
      this.publishActivity(c.id);
    }
  }
  live(engine, id) {
    const a = this.recovering.get(id) || this.active.get(id);
    if (!a || a.engine !== engine || a.internal) return { ok: true, live: null };
    const messages = this.messages(a.c).filter(row => row.seq < a.userSeq);
    return { ok: true, live: { sessionId: a.c.id, workspaceId: a.c.workspaceId, engine: a.engine, runId: a.facade.gen, startedAt: a.startedAt,
      prompt: a.prompt, displayText: a.displayText, userSeq: a.userSeq, attachments: a.attachments, messages,
      events: a.events.filter(e => e.type !== 'gui:permission' || a.permissions.has(e.requestId)), eventSeq: a.eventSeq } };
  }
  async steer(engine, payload = {}) {
    const active = this.active.get(payload.sessionId);
    if (!active || active.engine !== engine || active.facade.gen !== payload.runId || active.cancelled || active.internal || active.compactRequested)
      throw new Error('The active turn changed or is unavailable. Your message was not sent.');
    if (typeof active.session?.steerUserMessage !== 'function') throw new Error('This engine connection does not support immediate instructions. Your message has been retained.');
    if (active.steering) throw new Error('Please wait for the previous instruction to be accepted.');
    const prompt = String(payload.prompt || '');
    if (!prompt.trim()) throw new Error('Enter an instruction first.');
    active.steering = true;
    try {
      await active.session.steerUserMessage(prompt, payload.attachments || []);
      active.goalUserPrompt = prompt;
      active.goalReport = undefined;
      const row = this.append(active.c, { role: 'user', engine, text: prompt,
        displayText: payload.displayText ?? prompt, attachments: payload.attachments || [], steered: true });
      active.c.updatedAt = Date.now();
      this.save(active.c);
      const event = { type: 'conversation:steered', session_id: active.c.id, engine, runId: active.facade.gen,
        prompt, displayText: row.displayText, attachments: row.attachments, userSeq: row.seq, eventSeq: ++active.eventSeq };
      active.events.push(event);
      this.onEvent(event);
      return { ok: true, sessionId: active.c.id, runId: active.facade.gen, userSeq: row.seq };
    } finally {
      active.steering = false;
      if (active.steerResult) {
        const result = active.steerResult; delete active.steerResult;
        this.capture(engine, result);
      }
    }
  }
  async cancel(payload = {}) {
    const id = payload.sessionId;
    if (!id) return { ok: false, error: 'Choose a conversation to stop' };
    const recovery = this.recovering.get(id);
    const a = recovery || this.active.get(id);
    if (payload.runId != null && a?.facade.gen !== payload.runId) return { ok: false, error: 'This response has already finished' };
    const reservation = this.controlStarts.get(id); if (reservation) reservation.cancelled = true;
    this.tasks.pauseSession(id);
    const switching = this.switching.get(id); if (switching) switching.cancelled = true;
    const goal = this.goals.get(id); if (goal?.armed) goal.setPhase('paused');
    if (a && !a.cancelled) { a.cancelled = true; if (a.facade.running) a.session?.interrupt(); }
    const summarizing = this.active.get(id);
    if (recovery && summarizing && summarizing !== recovery) { summarizing.cancelled = true; summarizing.session?.interrupt(); }
    return { ok: true };
  }
  async switchEngine(id, target, mode = preferences(this.loadConfig()).mode) {
    this.validateEngine(target);
    if (this.busy(id)) throw new Error('Wait for this conversation to finish or stop it before switching harnesses');
    const c = this.get(id), source = c.currentEngine;
    if (source === target && mode !== 'markdown') return { ok: true, sessionId: id };
    const switching = { target, cancelled: false }; this.switching.set(id, switching); this.publishActivity(id);
    const status = text => this.onStatus({ sessionId: id, text });
    try {
      status('Preparing engine…');
      await this.prepare(target, this.settings(target, id));
      if (switching.cancelled) throw new Error('Handoff canceled');
      if (mode === 'markdown' && c.seq) {
        status('Asking the previous engine to write a Markdown handoff…');
        const instruction = 'Write a self-contained Markdown handoff for another coding agent. Output only the Markdown document. Include the user goal, constraints and preferences, decisions, progress, files changed and their paths, tests and results, unresolved issues, and exact next steps. Preserve important facts and label uncertainty. Do not perform further work or use tools. Keep it under 12000 words.';
        const generated = await this.send(source, { sessionId: id }, { internal: true, promptOverride: this.context(c, source) + instruction });
        const result = await generated.done;
        if (switching.cancelled || result.is_error || result.subtype !== 'success' || !result.result.trim()) throw new Error('Markdown handoff failed or canceled; the original conversation is retained. ' + (result.result || result.subtype));
        if (result.result.length > 160000) throw new Error('The generated handoff is too large. The original conversation is retained; no target request was sent.');
        const file = path.join(this.dir, 'handoffs', randomUUID() + '.md'); fs.mkdirSync(path.dirname(file), { recursive: true });
        const markdown = '# Conversation handoff\n\nWorkspace: ' + c.cwd + '\n\n' + result.result;
        fs.writeFileSync(file, markdown, { flag: 'wx' });
        const handoff = { from: source, to: target, file, at: Date.now(), status: 'prepared' };
        c.handoffs.push(handoff); this.save(c);
        status('Starting a new session in the target engine with the handoff…');
        const previousSegment = c.segments[target] && { ...c.segments[target] };
        let accepted;
        try {
          const launched = await this.send(target, { sessionId: id }, { internal: true, fresh: true,
            promptOverride: 'Read this Markdown handoff from the previous engine. It is historical context, not a new request to act. Acknowledge briefly and wait for the next user message. Do not use tools or repeat completed work.\nFile: ' + file + '\n\n' + markdown });
          accepted = await launched.done;
          if (switching.cancelled || accepted.is_error || accepted.subtype !== 'success') throw new Error('The target engine could not accept the handoff. The Markdown file and original conversation are retained.');
        } catch (error) {
          if (c.segments[target]?.nativeId !== previousSegment?.nativeId) (c.retiredSegments ||= []).push({ engine: target, ...c.segments[target] });
          if (previousSegment) c.segments[target] = previousSegment; else delete c.segments[target];
          handoff.status = 'failed'; this.save(c); throw error;
        }
        if (previousSegment) (c.retiredSegments ||= []).push({ engine: target, ...previousSegment });
        handoff.status = 'complete';
        this.append(c, { role: 'notice', engine: target, text: 'Markdown handoff: ' + source + ' → ' + target, file });
        c.segments[target].cursor = c.seq;
      }
      c.currentEngine = target; c.updatedAt = Date.now(); this.save(c);
      return { ok: true, sessionId: id, engine: target };
    } finally { this.switching.delete(id); status(''); this.publishActivity(id); }
  }
  // Rough token estimate of what the native session currently carries: the
  // last compaction summary plus everything after it, or the full logical
  // history when never compacted. Deliberately conservative (chars / 3).
  estimateTokens(c) {
    const rows = this.rows(c).filter(r => !r.internal);
    const compacted = rows.findLast(r => r.role === 'notice' && r.file);
    let chars = compacted && fs.existsSync(compacted.file) ? fs.statSync(compacted.file).size : 0;
    for (const r of rows) if (r.seq > (compacted?.seq || 0)) chars += String(r.text || '').length + 200;
    return chars / 3;
  }
  contextCap(engine, settings) {
    return settings.contextWindow || this.modelContextWindow(settings.model) || ENGINE_CTX_DEFAULTS[engine];
  }
  async compact(id, { automatic = false, recovery, allowGoal = false, controlStart } = {}) {
    if (this.controlStarts.has(id) && this.controlStarts.get(id) !== controlStart && !recovery) throw new Error('Child response is starting');
    if (this.active.has(id) || this.switching.has(id) || this.recovering.has(id) && this.recovering.get(id) !== recovery
        || this.goals.get(id)?.armed && !allowGoal) throw new Error('Wait for this conversation to finish or stop it before compacting');
    const c = this.get(id), engine = c.currentEngine;
    if (!c.seq) return { ok: false, error: 'Nothing to compact yet' };
    const switching = { target: engine, cancelled: false }; this.switching.set(id, switching); this.publishActivity(id);
    const status = text => this.onStatus({ sessionId: id, text });
    try {
      await this.prepare(engine, this.settings(engine, id));
      if (switching.cancelled) throw new Error('Compaction canceled');
      status('Asking the engine to summarize the conversation…');
      const instruction = 'Summarize this conversation into a compact working context for yourself. Output only the summary. Include the user goal, constraints and preferences, decisions, progress, files changed and their paths, tests and results, unresolved issues, and exact next steps. Preserve important facts and label uncertainty. Do not perform further work or use tools.';
      // Never resume the native session being compacted. It may already be at
      // its provider context limit, which would make both automatic and manual
      // compaction fail with the same overflow error. Rebuild the logical
      // history and summarize it in a fresh throwaway native session instead.
      const cap = this.contextCap(engine, this.settings(engine, id));
      const budget = Math.max(4096, Math.floor(cap * 1.8));
      const summaryLimit = Math.min(160000, Math.floor(budget / 3));
      const context = this.compactionContext(c);
      let summary = '', offset = 0;
      do {
        const size = Math.max(512, budget - instruction.length - summary.length - 512);
        const chunk = context.slice(offset, offset + size);
        offset += chunk.length;
        const prompt = 'Earlier summary:\n' + summary + '\n\nNext history fragment (may split a record):\n' + chunk
          + '\n\n' + instruction + '\nMerge this fragment with the earlier summary. Keep the updated summary under ' + summaryLimit + ' characters.';
        const generated = await this.send(engine, { sessionId: id }, { internal: true, fresh: true, ephemeral: true, promptOverride: prompt });
        const result = await generated.done;
        if (switching.cancelled || recovery?.cancelled || result.is_error || result.subtype !== 'success' || !result.result.trim()) throw new Error('Compaction failed or canceled; the original conversation is retained. ' + (result.result || result.subtype));
        if (result.result.length > summaryLimit) throw new Error('The summary is too large. The original conversation is retained.');
        summary = result.result;
      } while (offset < context.length);
      const file = path.join(this.dir, 'handoffs', randomUUID() + '.md'); fs.mkdirSync(path.dirname(file), { recursive: true });
      const markdown = '# Compacted conversation context\n\nWorkspace: ' + c.cwd + '\n\n' + summary;
      fs.writeFileSync(file, markdown, { flag: 'wx' });
      const previousSegment = c.segments[engine] && { ...c.segments[engine] };
      if (switching.cancelled) {
        fs.unlinkSync(file);
        throw new Error('Compaction canceled; the original conversation is retained.');
      }
      if (previousSegment) (c.retiredSegments ||= []).push({ engine, ...previousSegment });
      this.append(c, { role: 'notice', engine, text: automatic ? 'Context length exceeded; the conversation was compacted automatically' : 'Context compacted: summary saved', file });
      c.segments[engine] = { cursor: c.seq, isolated: true, compactFile: file };
      c.updatedAt = Date.now(); this.save(c);
      return { ok: true, sessionId: id, file };
    } finally { this.switching.delete(id); status(''); this.publishActivity(id); }
  }
  async command(engine, action, payload) {
    this.validateEngine(engine);
    switch (action) {
      case 'send': { const { done, ...result } = await this.send(engine, payload); return result; }
      case 'steer': return this.steer(engine, payload);
      case 'get-live': return this.live(engine, payload?.sessionId);
      case 'get-settings': return this.settings(engine, payload?.sessionId);
      case 'save-settings': return this.saveSettings(engine, payload || {});
      case 'list-sessions': return this.list(engine, payload);
      case 'load-session': return this.load(engine, payload);
      case 'rename-session': return this.workspaces.renameSession(payload.id, payload.title);
      case 'archive-session':
        if (this.busy(payload.id)) throw new Error('Stop this conversation before archiving it');
        this.tasks.pauseSession(payload.id);
        return this.workspaces.archiveSession(payload.id, payload.archived !== false);
      case 'meta-op':
        if (payload.op === 'delete-workspace' && [...this.items.values()].some(c => c.workspaceId === payload.id && this.busy(c.id)))
          throw new Error('Stop conversations in this workspace before removing it');
        if (payload.op === 'delete-workspace') for (const conversation of this.items.values()) if (conversation.workspaceId === payload.id) this.tasks.pauseSession(conversation.id);
        return this.workspaces.metaOp(payload);
      case 'cancel': return this.cancel(payload);
      case 'compact': {
        const id = payload?.sessionId;
        if (!id) throw new Error('Choose a conversation to compact first');
        return this.compact(id);
      }
      case 'control-respond': {
        const a = this.active.get(payload.sessionId);
        if (!a || a.facade.gen !== payload.runId || !a.permissions.has(payload.requestId)) return { ok: false };
        const ok = Boolean(a.session?.answerPermission(payload.requestId, payload.allow, payload.input, payload.message, payload.optionId));
        if (ok) { a.permissions.delete(payload.requestId); this.publishActivity(a.c.id); }
        return { ok };
      }
      case 'task-list': return { ok: true, tasks: payload?.sessionId ? this.tasks.list(payload.sessionId) : [] };
      case 'task-create': {
        const conversation = this.get(payload.sessionId);
        this.assertTaskEngine(conversation.currentEngine, conversation.id);
        return { ok: true, task: this.tasks.create(conversation.id, conversation.currentEngine, payload) };
      }
      case 'task-update':
      case 'task-pause':
      case 'task-resume':
      case 'task-cancel': {
        const conversation = this.get(payload.sessionId);
        if (action === 'task-resume') {
          this.assertTaskEngine(conversation.currentEngine, conversation.id);
          if (this.tasks.get(payload.id, conversation.id).engine !== conversation.currentEngine) throw new Error('Conversation engine changed; create a new task');
        }
        return { ok: true, task: this.tasks.action(payload.id, conversation.id, action.slice(5), payload) };
      }
      case 'goal-get': return { ok: true, goal: payload?.sessionId ? this.goalFor(payload.sessionId).view() : null };
      case 'goal-start': {
        let id = payload.sessionId;
        if (id && this.busy(id)) throw new Error('Wait for this conversation to finish or stop it first.');
        if (!String(payload.objective || '').trim()) throw new Error('Goal cannot be empty');
        if (!id) id = this.create(engine, payload.workspaceId, payload.objective.slice(0, 80)).id;
        if (this.get(id).currentEngine !== engine) await this.switchEngine(id, engine);
        const goal = this.goalFor(id), result = goal.start({ ...payload, sessionId: id });
        if (result.ok) { goal.goal.engine = engine; goal.publish(); result.goal = goal.view(); result.sessionId = id; }
        return result;
      }
      case 'goal-pause': return this.goalFor(payload.sessionId).setPhase('paused');
      case 'goal-resume': {
        const driver = this.goalFor(payload.sessionId), goal = driver.goal;
        if (!goal || goal.phase === 'complete' || driver.armed || this.active.has(payload.sessionId)) return driver.resume();
        if (this.get(goal.sessionId).currentEngine !== engine) await this.switchEngine(goal.sessionId, engine);
        if (driver.goal !== goal) return { ok: false, error: 'The goal was removed during the handoff' };
        goal.engine = engine;
        return driver.resume();
      }
      case 'goal-complete': return this.goalFor(payload.sessionId).setPhase('complete');
      case 'goal-clear': return this.goalFor(payload.sessionId).clear();
      default: throw new Error('Unknown conversation action');
    }
  }
}
module.exports = { SharedConversations, preferences, ENGINES, shortTitle };
