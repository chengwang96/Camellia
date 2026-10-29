'use strict';

const { mergeTask } = require('../shared/subagents');
const ACTIVE = new Set(['starting', 'running', 'waiting']);
const text = value => typeof value === 'string' ? value : Array.isArray(value)
  ? value.map(part => part.text || part.content?.text || '').filter(Boolean).join('\n') : '';
const object = value => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; }
};
const field = (value, key) => new RegExp('^' + key + ':\\s*(.+)$', 'mi').exec(value)?.[1]?.trim();
const status = value => ({ pending: 'starting', pendingInit: 'starting', in_progress: 'running', running: 'running',
  waiting: 'waiting', completed: 'completed', success: 'completed', failed: 'failed', error: 'failed',
  errored: 'failed', timed_out: 'failed', lost: 'unavailable', cancelled: 'stopped', canceled: 'stopped',
  killed: 'stopped', stopped: 'stopped', aborted: 'stopped', interrupted: 'stopped' })[value];

// Native tool calls and native lifecycle events share one stable display identity.
// A background launch receipt is never evidence that the child has finished.
class NativeSubagents {
  constructor(engine, emit) {
    this.engine = engine; this.emit = emit; this.children = new Map();
    this.calls = new Map(); this.aliases = new Map(); this.identities = new Map();
    this.epoch = 0;
  }
  begin() { this.epoch++; this.calls.clear(); }
  resolve(id) { return this.aliases.get(id) || id; }
  nativeId(id) { return this.identities.get(this.resolve(id)) || id; }
  bind(nativeId, id) {
    if (typeof nativeId !== 'string' || !nativeId) return;
    id = this.resolve(id);
    const oldId = this.aliases.get(nativeId) || nativeId;
    const old = oldId !== id && this.children.get(oldId);
    this.aliases.set(nativeId, id); this.identities.set(id, nativeId);
    if (old) {
      const current = this.children.get(id);
      this.children.delete(oldId); this.identities.delete(oldId);
      for (const [alias, value] of this.aliases) if (value === oldId) this.aliases.set(alias, id);
      this.aliases.set(oldId, id);
      for (const call of this.calls.values()) call.ids = call.ids.map(value => value === oldId ? id : value);
      const task = mergeTask(current, { ...old, ...current, id,
        status: old.status, progress: old.progress || current?.progress, result: old.result || current?.result,
        turnId: old.turnId || current?.turnId,
        approvals: (old.approvals || current?.approvals || []).map(approval => ({ ...approval, subagentId: id })),
      }, { engine: this.engine });
      if (task) { this.children.set(id, task); this.emit(task, [oldId]); }
    }
  }
  update(id, update) {
    id = this.resolve(id);
    const previous = this.children.get(id);
    const task = mergeTask(previous, { ...update, id,
      ...(update.parentId ? { parentId: this.resolve(update.parentId) } : {}) }, { engine: this.engine });
    if (!task) return;
    if (!ACTIVE.has(task.status)) { task.canStop = false; task.approvals = []; }
    if (previous && JSON.stringify({ ...previous, updatedAt: 0 }) === JSON.stringify({ ...task, updatedAt: 0 })) return task;
    this.children.set(id, task); this.emit(task); return task;
  }
  native(nativeId, update) {
    const call = update.toolCallId && this.calls.get(update.toolCallId);
    const id = (Number.isSafeInteger(update.slot) && call?.ids[update.slot])
      || (call?.ids.length === 1 ? call.ids[0] : this.aliases.get(nativeId) || nativeId);
    this.bind(nativeId, id);
    if (update.toolCallId && !call) this.calls.set(update.toolCallId, { ids: [id], args: {}, native: true });
    return this.update(id, update);
  }
  attach(nativeId, update) {
    if (!this.aliases.has(nativeId) && !this.children.has(nativeId)) {
      const candidates = [...this.children.values()].filter(task => ACTIVE.has(task.status) && !this.identities.has(task.id)
        && ((update.goal && task.goal === update.goal) || (update.title && task.title === update.title)));
      if (candidates.length === 1) this.bind(nativeId, candidates[0].id);
    }
    return this.native(nativeId, update);
  }
  observe(tool, update = {}) {
    let call = this.calls.get(tool.id);
    const args = object(tool.input ?? tool.output), name = tool.name || '';
    if (!call) {
      const spawn = this.engine === 'claude' ? /^(Agent|Task)$/.test(name)
        : this.engine === 'kimi' ? /^(Agent|AgentSwarm)$|^Launching (?:background )?.+ agent:|^Launching agent swarm:/.test(name)
        : this.engine === 'dsh' ? /^(subagent|fork_subagent)$/.test(name)
        : this.engine === 'grok' ? /^spawn_subagent$|^spawn subagent\b/i.test(name)
        : this.engine === 'antigravity' && /^(invoke_subagent|start_subagent|Invoke Subagent)$/i.test(name);
      if (!spawn) return false;
      if (this.engine === 'kimi' && !Object.keys(args).length) return false;
      const swarm = this.engine === 'kimi' && (name === 'AgentSwarm' || /^Launching agent swarm:/.test(name));
      const batch = this.engine === 'antigravity' && Array.isArray(args.Subagents);
      const entries = batch ? args.Subagents.slice(0, 128).map(entry => ({ title: entry.Role || entry.TypeName, prompt: entry.Prompt })) : swarm ? [
        ...Object.entries(args.resume_agent_ids || {}).map(([nativeId, prompt]) => ({ nativeId, prompt, title: args.description })),
        ...(args.items || []).slice(0, 128).map(item => ({ title: String(item), prompt: (args.prompt_template || '').replaceAll('{{item}}', String(item)) })),
      ] : [{ nativeId: args.resume || args.resume_from, title: args.description || args.Description || args.subagent_type,
        prompt: args.prompt || args.Task || args.task || '' }];
      // Kimi's first arguments delta can precede its complete AgentSwarm input.
      if (!entries.length) return false;
      call = { ids: [], args, swarm, background: batch || args.run_in_background === true || (this.engine === 'grok' && args.run_in_background !== false) };
      this.calls.set(tool.id, call);
      for (const [index, entry] of entries.entries()) {
        const id = entry.nativeId ? this.resolve(entry.nativeId) : 'tool:' + this.epoch + ':' + tool.id + (swarm || batch ? ':' + index : '');
        call.ids.push(id); this.bind(entry.nativeId, id);
        this.update(id, { title: entry.title, goal: entry.prompt, status: tool.status === 'pending' ? 'starting' : 'running',
          turnId: tool.id, canReply: false, canStop: false, result: '', approvals: [] });
      }
    }
    if (args.description && !call.swarm) for (const id of call.ids) this.update(id, {
      title: args.description, ...(args.prompt ? { goal: args.prompt } : {}),
    });
    const output = tool.output || '', raw = object(update.rawOutput ?? update.result);
    if (call.swarm && /<agent_swarm_result>/.test(output)) {
      call.terminal = true;
      const rows = [...output.matchAll(/<subagent\b([^>]*)>([\s\S]*?)<\/subagent>/g)];
      rows.forEach(([_, attributes, result], index) => {
        const id = call.ids[index]; if (!id) return;
        const attr = key => new RegExp('\\b' + key + '="([^"]*)"').exec(attributes)?.[1];
        this.bind(attr('agent_id'), id);
        this.update(id, { status: status(attr('outcome')) || 'unavailable', progress: result, result });
      });
      return true;
    }
    const nativeId = raw.agentId || raw.agent_id || raw.subagentId || raw.subagent_id || raw.task_id
      || field(output, 'agent_id') || field(output, 'subagent_id') || field(output, 'task_id');
    if (call.ids.length === 1) this.bind(nativeId, call.ids[0]);
    const nativeStatus = status(raw.status || field(output, 'status'));
    const background = call.background || raw.isAsync === true || raw.status === 'async_launched' || raw.kind === 'background'
      || raw.kind === 'continuable' || /^started (?:background subagent job|subagent)\s/.test(output);
    for (const id of call.ids) {
      const completed = ['completed', 'failed'].includes(tool.status);
      const previous = this.children.get(id);
      if (call.native && !nativeStatus || completed && background && previous && !ACTIVE.has(previous.status)) continue;
      const state = tool.is_error || tool.status === 'failed' ? 'failed'
        : nativeStatus || (completed ? background ? 'running' : 'completed' : 'running');
      if (completed && !ACTIVE.has(state)) call.terminal = true;
      this.update(id, { status: state, ...(output && completed ? { progress: output } : {}),
        ...(['completed', 'failed', 'stopped'].includes(state) ? { result: output } : {}),
        ...(this.engine === 'claude' && this.identities.has(id) ? { canStop: ACTIVE.has(state) } : {}) });
    }
    return true;
  }
  disconnect() {
    for (const [id, task] of this.children) this.update(id, { canReply: false, canStop: false, approvals: [],
      ...(ACTIVE.has(task.status) ? { status: 'unavailable' } : {}) });
  }
}
module.exports = { NativeSubagents, ACTIVE, nativeStatus: status, contentText: text };
