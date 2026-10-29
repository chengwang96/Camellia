'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { ACTIVE, contentText } = require('./native-subagents');
const ID = /^[a-zA-Z0-9_-]{1,160}$/;

// Kimi's ACP adapter currently follows only the main agent. Its append-only
// journals retain the real child lifecycle, including background completions.
// Read bounded increments without touching the native registry or its locks.
class KimiSubagents {
  constructor(session, home) {
    this.session = session; this.home = home; this.files = new Map(); this.agentTurns = new Map();
    this.finished = new Set();
  }
  async locate() {
    if (this.dir || !ID.test(this.session.sessionId || '')) return this.dir;
    const root = path.join(this.home, 'sessions');
    let groups;
    try { groups = await fs.readdir(root, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const candidates = [path.join(root, this.session.sessionId), ...groups.filter(row => row.isDirectory() && !row.isSymbolicLink()).slice(0, 2000)
      .map(row => path.join(root, row.name, this.session.sessionId))];
    const realRoot = await fs.realpath(root);
    for (const dir of candidates) {
      const info = await fs.lstat(dir).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (!info?.isDirectory() || info.isSymbolicLink()) continue;
      const real = await fs.realpath(dir);
      if (!path.relative(realRoot, real).startsWith('..')) { this.dir = dir; return dir; }
    }
  }
  async addAgent(id, baseline = false) {
    if (!this.dir || !ID.test(id) || this.files.has(id)) return;
    const file = path.join(this.dir, 'agents', id, 'wire.jsonl');
    const record = { file, offset: 0, partial: '', decoder: new StringDecoder('utf8') };
    if (baseline) record.offset = (await fs.stat(file).catch(error => { if (error.code !== 'ENOENT') throw error; }))?.size || 0;
    this.files.set(id, record);
  }
  async begin() {
    await this.locate();
    if (this.dir && !this.files.size) await this.addAgent('main', true);
    this.start();
  }
  start() {
    if (this.timer || this.session.dead) return;
    this.timer = setInterval(() => { void this.poll().catch(error => this.session.log('Kimi subtasks: ' + error.message)); }, 500);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  poll() {
    if (this.polling) return this.polling;
    this.polling = this.read().finally(() => { this.polling = null; });
    return this.polling;
  }
  async read() {
    if (this.session.dead) return;
    if (!await this.locate()) return;
    if (!this.files.size) await this.addAgent('main');
    let budget = 2 * 1024 * 1024;
    for (const [agentId, file] of this.files) {
      if (budget <= 0 || this.session.dead) break;
      const real = await fs.realpath(file.file).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (!real || path.relative(await fs.realpath(this.dir), real).startsWith('..')) continue;
      const handle = await fs.open(real, 'r');
      try {
        const stat = await handle.stat();
        if (stat.size < file.offset) { file.offset = 0; file.partial = ''; file.decoder = new StringDecoder('utf8'); }
        const length = Math.min(stat.size - file.offset, 512 * 1024, budget);
        if (length <= 0) continue;
        const buffer = Buffer.alloc(length), { bytesRead } = await handle.read(buffer, 0, length, file.offset);
        file.offset += bytesRead; budget -= bytesRead;
        const lines = (file.partial + file.decoder.write(buffer.subarray(0, bytesRead))).split('\n');
        file.partial = lines.pop();
        if (file.partial.length > 1024 * 1024) file.partial = '';
        for (const line of lines) {
          let row; try { row = JSON.parse(line); } catch { continue; }
          this.row(agentId, row);
        }
      } finally { await handle.close(); }
    }
    if (!this.session.running && ![...this.session.children.values()].some(task => ACTIVE.has(task.status))) this.stop();
  }
  row(agentId, row) {
    if (this.session.dead || typeof row?.type !== 'string') return;
    const tracker = this.session.subagents;
    if (row.type === 'turn.prompt') this.agentTurns.set(agentId, String(row.turnId));
    if (row.type === 'subagent.spawned' && ID.test(row.subagentId || '')) {
      const caller = row.parentAgentId || row.callerAgentId || agentId;
      const toolCallId = this.agentTurns.get(caller) + ':' + row.parentToolCallId;
      const call = tracker.calls.get(toolCallId);
      const slot = row.swarmIndex - 1; // The pinned Kimi wire numbers swarm entries from one.
      if (call?.swarm && !tracker.aliases.has(row.subagentId) && call.ids[slot]) tracker.bind(row.subagentId, call.ids[slot]);
      const previous = tracker.children.get(tracker.resolve(row.subagentId));
      const terminal = call?.terminal && previous && !ACTIVE.has(previous.status);
      if (terminal) this.finished.add(row.subagentId); else this.finished.delete(row.subagentId);
      tracker.native(row.subagentId, { toolCallId, title: row.description || row.subagentName,
        parentId: caller === 'main' ? this.session.sessionId : caller, status: terminal ? previous.status : 'running',
        turnId: toolCallId, canStop: false, canReply: false,
        ...(terminal ? {} : { progress: '', result: '' }), approvals: [] });
      if (this.files.size < 256) void this.addAgent(row.subagentId).catch(error => this.session.log('Kimi subtasks: ' + error.message));
      return;
    }
    if (row.type.startsWith('subagent.') && tracker.children.has(tracker.resolve(row.subagentId))) {
      const state = { 'subagent.started': 'running', 'subagent.completed': 'completed', 'subagent.failed': 'failed', 'subagent.cancelled': 'stopped' }[row.type];
      if (state === 'running' && this.finished.has(row.subagentId)) return;
      if (state && state !== 'running') this.finished.add(row.subagentId);
      if (state) tracker.update(row.subagentId, { status: state, ...(row.resultSummary || row.error ? {
        result: row.resultSummary || row.error, progress: row.resultSummary || row.error,
      } : {}) });
      return;
    }
    const task = tracker.children.get(tracker.resolve(agentId));
    if (!task || this.finished.has(agentId)) return;
    if (row.type === 'turn.prompt') tracker.update(agentId, { goal: contentText(row.input), turnId: String(row.turnId), status: 'running' });
    if (row.type === 'agent.message.appended') {
      const message = row.message?.message;
      const value = message?.role === 'assistant' && contentText(message.content);
      if (value) tracker.update(agentId, { progress: value, history: [...(task.history || []), { type: 'agentMessage', text: value }] });
    }
    if (row.type === 'turn.ended') tracker.update(agentId, { status: row.reason === 'completed' ? 'completed' : row.reason === 'cancelled' ? 'stopped' : 'failed',
      ...(task.progress ? { result: task.progress } : {}) });
  }
}
module.exports = { KimiSubagents };
