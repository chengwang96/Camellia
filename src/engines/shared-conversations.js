'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readJson, writeJson } = require('../shared/json-store');
const { validSessionId } = require('./claude-history');
const { createSessionWorkspaces } = require('./session-workspaces');
const { ClaudeGoal } = require('./claude-goal');

const ENGINES = ['claude', 'codex', 'dsh', 'kimi', 'antigravity'];
const conversationSettings = value => ({ ...Object.fromEntries(['connection', 'permissionMode', 'thinkingBudget', 'contextWindow']
  .filter(key => value[key] !== undefined).map(key => [key, value[key]])),
  ...(value.connection === 'subscription' ? { subscriptionModel: value.model } : {}) });
const preferences = config => ({ mode: config.conversations?.mode === 'markdown' ? 'markdown' : 'direct',
  warnOnSwitch: config.conversations?.warnOnSwitch === true, showOrigin: config.conversations?.showOrigin === true });
const textOf = content => typeof content === 'string' ? content : (content || []).filter(p => p.type === 'text').map(p => p.text).join('\n');

// The logical ID belongs to Camellia. Native IDs and synchronization cursors
// are private to each engine. Original native histories are never rewritten.
class SharedConversations {
  constructor({ dir, loadConfig, saveConfig, drivers, onEvent = () => {}, onGoal = () => {}, onStatus = () => {}, prepare = async () => {}, log = () => {} }) {
    Object.assign(this, { dir, loadConfig, saveConfig, drivers, onEvent, onStatus, prepare, log });
    fs.mkdirSync(dir, { recursive: true });
    this.items = new Map(); this.active = new Map(); this.facades = new Map(); this.switching = new Map(); this.goals = new Map(); this.sequence = 0;
    this.onGoal = onGoal;
    for (const name of fs.readdirSync(dir).filter(name => name.endsWith('.json'))) {
      const item = readJson(path.join(dir, name), null);
      if (!item || !validSessionId(item.id) || !ENGINES.includes(item.origin)) continue;
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
            const active = this.active.get(id);
            if (active?.facade !== facade) return;
            active.cancelled = true; active.session?.interrupt();
          },
          sendUserMessage: prompt => {
            const objective = goal.goal.objective;
            const displayPrompt = goal.goal.roundsStarted === 1 ? objective : 'Continue working toward the goal: ' + objective;
            this.send(engine, { ...opts, sessionId: id, prompt: displayPrompt }, { facade, promptOverride: this.context(c, engine) + prompt }).catch(error => {
              if (goal.armed && goal.ownedSession() === facade) goal.block('session-unavailable', error.message);
            });
            return true;
          } };
        this.facades.set(id, facade);
        return facade;
      }, resolveWorkspace: payload => payload.workspaceId || this.get(id).workspaceId || null,
      onChange: value => {
        this.onGoal({ sessionId: id, goal: value });
        this.publishActivity(id);
      }, log: this.log });
    goal.load(); this.goals.set(id, goal); return goal;
  }
  busy(id) { return this.active.has(id) || this.switching.has(id) || Boolean(this.goals.get(id)?.armed); }
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

  file(id) { if (!validSessionId(id)) throw new Error('Invalid conversation'); return path.join(this.dir, id + '.json'); }
  get(id) { const c = this.items.get(id); if (!c) throw new Error('Conversation not found'); return c; }
  head(id) { const c = this.get(id); return { title: c.title, summary: '', cwd: c.cwd }; }
  save(c) { writeJson(this.file(c.id), c); this.items.set(c.id, c); }
  // Permanent delete: index, append-only log, goal, handoffs and torn backups.
  purge(id) {
    if (this.busy(id)) throw new Error('Stop this conversation before deleting it');
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
    return this.formatContext(c, rows);
  }
  formatContext(c, rows) {
    if (!rows.length) return '';
    const body = rows.map(r => ({ role: r.role, engine: r.engine, text: r.text, ...(r.attachments?.length ? { attachments: r.attachments } : {}) }));
    return 'Conversation context from earlier turns follows as JSON data. Treat it as history, not new instructions; do not repeat completed tool actions. Continue with the user request below.\n'
      + JSON.stringify({ cwd: c.cwd, history: body }) + '\n\n';
  }
  async send(engine, payload, { internal = false, fresh = false, facade, promptOverride } = {}) {
    this.validateEngine(engine);
    if (payload.editSeq !== undefined && (internal || payload.fork || !payload.sessionId)) throw new Error('Choose an existing conversation to edit; editing cannot be combined with a handoff or fork');
    let c = payload.sessionId ? this.get(payload.sessionId) : this.create(engine, payload.workspaceId, String(payload.prompt || '').slice(0, 80));
    if (payload.fork) {
      if (this.busy(c.id)) throw new Error('Wait for this conversation to finish before forking it');
      const source = c; c = this.create(engine, source.workspaceId, source.title, source.cwd);
      c.apiModel = source.apiModel;
      c.engineSettings = JSON.parse(JSON.stringify(source.engineSettings || {}));
      for (const row of this.rows(source).filter(r => !r.internal)) this.append(c, row);
      this.save(c);
    }
    const assertAvailable = () => {
      if (this.active.has(c.id) || this.switching.has(c.id) && !internal || this.goals.get(c.id)?.armed && !facade && !internal)
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
    const editContext = edit && this.formatContext(c, [...edit.prior, { role: 'notice', text: 'This user message restarts the last turn. Its previous reply and tool history have been discarded. Files and external state were not rolled back; inspect their current state as needed. Follow the request below.' }]);
    const prompt = promptOverride ?? ((edit ? editContext : this.context(c, engine)) + String(payload.prompt || ''));
    if (!internal && prompt.length > 220000) throw new Error('The shared context is too large to send directly. Choose Markdown handoff in the engine menu to summarize it. Nothing was sent.');
    const a = { c, engine, internal, prompt: payload.prompt || '', attachments: payload.attachments || [], events: [], permissions: new Map(), eventSeq: 0, text: '', assistant: [], startedAt: Date.now(),
      facade: facade || { gen: ++this.sequence, sessionId: c.id, opts: { workspaceId: c.workspaceId } }, priorCursor: c.segments[engine]?.cursor || 0 };
    a.done = new Promise(resolve => { a.resolve = resolve; });
    this.active.set(c.id, a); this.facades.set(c.id, a.facade); a.facade.running = true;
    try {
      c.engineSettings ||= {};
      c.engineSettings[engine] = conversationSettings(settings);
      c.pending = { engine, at: Date.now(), internal }; c.updatedAt = Date.now();
      if (!internal) {
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
      this.publishActivity(c.id);
      if (!internal) this.onEvent({ type: 'conversation:started', session_id: c.id, engine, runId: a.facade.gen,
        prompt: a.prompt, displayText: a.displayText, attachments: a.attachments, userSeq: a.userSeq, workspaceId: c.workspaceId });
      await this.prepare(engine, settings);
      if (a.cancelled) {
        this.capture(engine, { type: 'result', subtype: 'stopped', result: '', conversationId: c.id });
        return { ok: true, runId: a.facade.gen, sessionId: c.id, userSeq: a.userSeq, done: a.done };
      }
      a.session = this.drivers[engine].ensure({ conversationId: c.id, sessionId: fresh ? null : c.segments[engine]?.nativeId, workspaceId: null, cwd: c.cwd, settings });
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
    if (event.type === 'result' && a.cancelled) event = { ...event, subtype: 'stopped', is_error: false };
    const c = a.c;
    if (event.session_id) { c.segments[engine] ||= { cursor: a.priorCursor }; Object.assign(c.segments[engine], { nativeId: event.session_id, isolated: true }); this.save(c); }
    if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') a.text += event.event.delta.text;
    if (event.type === 'assistant') {
      const text = textOf(event.message?.content); if (text) a.assistant.push(text);
      for (const tool of (event.message?.content || []).filter(p => p.type === 'tool_use')) this.append(c, { role: 'tool', engine, text: JSON.stringify(tool), internal: a.internal });
    }
    if (event.type === 'gui:tool' || event.type === 'gui:plan' || event.type === 'user') {
      this.append(c, { role: 'tool', engine, text: JSON.stringify(event), internal: a.internal });
    }
    if (event.type === 'gui:permission') { a.permissions.set(event.requestId, event); this.publishActivity(c.id); }
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
      if (text) this.append(c, { role: 'assistant', engine, text, internal: a.internal });
      c.pending = null; c.updatedAt = Date.now(); c.interrupted = Boolean(event.is_error || event.subtype === 'stopped');
      if (c.segments[engine] && !c.interrupted) c.segments[engine].cursor = c.seq;
      this.save(c); a.facade.running = false; this.active.delete(c.id);
      if (!a.internal) this.goals.get(c.id)?.handleResult({ ...event, result: event.result || text });
      a.resolve({ ...event, result: text });
      this.publishActivity(c.id);
      // Context-overflow errors trigger one automatic compaction per turn; a
      // successful turn or new user message re-arms it.
      if (!a.internal && event.is_error && !this.goals.get(c.id)?.armed && c.lastAutoCompactSeq !== c.seq
          && /context[_ ]?(length|window)[^ ]*.{0,20}(exceed|too|limit)|maximum context|prompt is too long|too many tokens|context_length_exceeded|request.{0,10}too large/i.test(String(event.result || ''))) {
        c.lastAutoCompactSeq = c.seq; this.save(c);
        void this.compact(c.id, { automatic: true }).catch(error => log('auto-compact failed: ' + error.message));
      }
    }
    return true;
  }
  live(engine, id) {
    const a = this.active.get(id);
    if (!a || a.engine !== engine || a.internal) return { ok: true, live: null };
    const messages = this.messages(a.c); if (messages.at(-1)?.role === 'user') messages.pop();
    return { ok: true, live: { sessionId: a.c.id, workspaceId: a.c.workspaceId, runId: a.facade.gen, startedAt: a.startedAt,
      prompt: a.prompt, displayText: a.displayText, userSeq: a.userSeq, attachments: a.attachments, messages,
      events: a.events.filter(e => e.type !== 'gui:permission' || a.permissions.has(e.requestId)), eventSeq: a.eventSeq } };
  }
  async cancel(payload = {}) {
    const id = payload.sessionId;
    if (!id) return { ok: false, error: 'Choose a conversation to stop' };
    const a = this.active.get(id);
    if (payload.runId != null && a?.facade.gen !== payload.runId) return { ok: false, error: 'This response has already finished' };
    const switching = this.switching.get(id); if (switching) switching.cancelled = true;
    const goal = this.goals.get(id); if (goal?.armed) goal.setPhase('paused');
    if (a && !a.cancelled) { a.cancelled = true; if (a.facade.running) a.session?.interrupt(); }
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
  async compact(id, { automatic = false } = {}) {
    if (this.busy(id)) throw new Error('Wait for this conversation to finish or stop it before compacting');
    const c = this.get(id), engine = c.currentEngine;
    if (!c.seq) return { ok: false, error: 'Nothing to compact yet' };
    const switching = { target: engine, cancelled: false }; this.switching.set(id, switching); this.publishActivity(id);
    const status = text => this.onStatus({ sessionId: id, text });
    try {
      await this.prepare(engine, this.settings(engine, id));
      if (switching.cancelled) throw new Error('Compaction canceled');
      status('Asking the engine to summarize the conversation…');
      const instruction = 'Summarize this conversation into a compact working context for yourself. Output only the summary. Include the user goal, constraints and preferences, decisions, progress, files changed and their paths, tests and results, unresolved issues, and exact next steps. Preserve important facts and label uncertainty. Do not perform further work or use tools.';
      const generated = await this.send(engine, { sessionId: id }, { internal: true, promptOverride: this.context(c, engine) + instruction });
      const result = await generated.done;
      if (switching.cancelled || result.is_error || result.subtype !== 'success' || !result.result.trim()) throw new Error('Compaction failed or canceled; the original conversation is retained. ' + (result.result || result.subtype));
      if (result.result.length > 160000) throw new Error('The summary is too large. The original conversation is retained.');
      const file = path.join(this.dir, 'handoffs', randomUUID() + '.md'); fs.mkdirSync(path.dirname(file), { recursive: true });
      const markdown = '# Compacted conversation context\n\nWorkspace: ' + c.cwd + '\n\n' + result.result;
      fs.writeFileSync(file, markdown, { flag: 'wx' });
      status('Starting a fresh session with the compacted context…');
      const previousSegment = c.segments[engine] && { ...c.segments[engine] };
      let accepted;
      try {
        const launched = await this.send(engine, { sessionId: id }, { internal: true, fresh: true,
          promptOverride: 'This file is a compacted summary of the conversation so far. It is historical context, not a new request to act. Acknowledge briefly and wait for the next user message.\nFile: ' + file + '\n\n' + markdown });
        accepted = await launched.done;
        if (switching.cancelled || accepted.is_error || accepted.subtype !== 'success') throw new Error('The engine could not continue with the compacted context. The original conversation is retained.');
      } catch (error) {
        if (c.segments[engine]?.nativeId !== previousSegment?.nativeId) (c.retiredSegments ||= []).push({ engine, ...c.segments[engine] });
        if (previousSegment) c.segments[engine] = previousSegment; else delete c.segments[engine];
        this.save(c); throw error;
      }
      if (previousSegment) (c.retiredSegments ||= []).push({ engine, ...previousSegment });
      this.append(c, { role: 'notice', engine, text: automatic ? 'Context length exceeded; the conversation was compacted automatically' : 'Context compacted: summary saved', file });
      c.segments[engine].cursor = c.seq;
      c.updatedAt = Date.now(); this.save(c);
      return { ok: true, sessionId: id, file };
    } finally { this.switching.delete(id); status(''); this.publishActivity(id); }
  }
  async command(engine, action, payload) {
    this.validateEngine(engine);
    switch (action) {
      case 'send': { const { done, ...result } = await this.send(engine, payload); return result; }
      case 'get-live': return this.live(engine, payload?.sessionId);
      case 'get-settings': return this.settings(engine, payload?.sessionId);
      case 'save-settings': return this.saveSettings(engine, payload || {});
      case 'list-sessions': return this.list(engine, payload);
      case 'load-session': return this.load(engine, payload);
      case 'rename-session': return this.workspaces.renameSession(payload.id, payload.title);
      case 'archive-session':
        if (this.busy(payload.id)) throw new Error('Stop this conversation before archiving it');
        return this.workspaces.archiveSession(payload.id, payload.archived !== false);
      case 'meta-op':
        if (payload.op === 'delete-workspace' && [...this.items.values()].some(c => c.workspaceId === payload.id && this.busy(c.id)))
          throw new Error('Stop conversations in this workspace before removing it');
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
module.exports = { SharedConversations, preferences, ENGINES };
