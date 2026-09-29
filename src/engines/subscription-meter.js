'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const number = value => Number.isFinite(value) && value >= 0 ? value : 0;
function codexTokens(raw) {
  if (!raw || !Number.isFinite(raw.inputTokens) || !Number.isFinite(raw.outputTokens)) return null;
  return { input: number(raw.inputTokens), output: number(raw.outputTokens), cacheRead: number(raw.cachedInputTokens),
    cacheWrite: number(raw.cacheWriteInputTokens), reasoning: number(raw.reasoningOutputTokens) };
}
function antigravityTokens(raw) {
  if (!raw || !Number.isFinite(raw.input_tokens) || !Number.isFinite(raw.output_tokens)) return null;
  // agy's input bucket excludes cached input; output already includes thinking.
  return { input: number(raw.input_tokens) + number(raw.cache_read_tokens) + number(raw.cache_write_tokens),
    output: number(raw.output_tokens), cacheRead: number(raw.cache_read_tokens), cacheWrite: number(raw.cache_write_tokens),
    reasoning: number(raw.thinking_tokens), aggregate: true };
}
async function directories(dir) {
  try { return (await fs.readdir(dir, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function kimiFiles(home, sessionId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId || '')) return [];
  const root = path.join(home, 'sessions'), found = [];
  const groups = await directories(root);
  if (groups.length > 2000) throw new Error('Too many Kimi workspace directories');
  // CLI versions use either sessions/<workspace>/<session> or sessions/<session>.
  const candidates = [path.join(root, sessionId), ...groups.filter(group => group.name !== sessionId).map(group => path.join(root, group.name, sessionId))];
  async function walk(dir, depth) {
    const info = await fs.lstat(dir).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!info?.isDirectory() || info.isSymbolicLink()) return;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === 'wire.jsonl') {
        found.push({ file, size: (await fs.stat(file)).size });
        if (found.length > 256) throw new Error('Too many Kimi usage journals');
      } else if (entry.isDirectory() && depth < 4) await walk(file, depth + 1);
    }
  }
  for (const dir of candidates) await walk(dir, 0);
  return found;
}
async function readKimiUsage(home, sessionId, baseline, { model, version = '' } = {}) {
  const samples = [], files = await kimiFiles(home, sessionId);
  let incomplete = false, settled = false, readBytes = 0;
  for (const { file, size } of files) {
    const start = baseline.get(file) || 0;
    if (size < start) { incomplete = true; continue; } // rewritten history is not new consumption
    const length = size - start;
    if (!length) continue;
    readBytes += length;
    if (readBytes > 64 * 1024 * 1024) { incomplete = true; break; }
    const handle = await fs.open(file, 'r');
    let text;
    try {
      const buffer = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const result = await handle.read(buffer, offset, length - offset, start + offset);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      text = buffer.subarray(0, offset).toString('utf8');
      if (offset < length) incomplete = true;
    } finally { await handle.close(); }
    const owner = path.basename(path.dirname(file));
    const primary = ['main', 'root', sessionId].includes(owner);
    for (const line of text.split('\n')) {
      if (!/usage\.record|StatusUpdate|prompt\.completed|turn\.ended|turn\.prompt|TurnEnd/.test(line)) continue;
      let row;
      try { row = JSON.parse(line); } catch { incomplete = true; continue; }
      if (primary && row.type === 'turn.prompt') settled = false;
      if (primary && ['prompt.completed', 'turn.ended', 'TurnEnd'].includes(row.type)) settled = true;
      let usage;
      if (row.type === 'usage.record') {
        // 0.x writes a second cumulative session record; v2's scopes identify
        // the request's origin (including compaction), and are all deltas.
        if (Number.parseInt(version, 10) < 2 && row.usageScope !== 'turn') continue;
        if (!version && row.usageScope !== 'turn') { incomplete = true; continue; }
        usage = row.usage;
      } else if (row.type === 'StatusUpdate') {
        const value = row.payload?.token_usage;
        if (value) usage = { inputOther: value.input_other, output: value.output,
          inputCacheRead: value.input_cache_read, inputCacheCreation: value.input_cache_creation };
      }
      if (!usage || !Number.isFinite(usage.inputOther) || !Number.isFinite(usage.output)) continue;
      const cacheRead = number(usage.inputCacheRead), cacheWrite = number(usage.inputCacheCreation);
      samples.push({ model: row.model || model, input: number(usage.inputOther) + cacheRead + cacheWrite,
        output: number(usage.output), cacheRead, cacheWrite });
    }
  }
  return { samples, incomplete, settled };
}

// One meter per native session. begin() snapshots existing history before a
// prompt; end() captures the current turn before another turn can reuse it.
function createSubscriptionMeter({ engine, accountId = 'default', model, home, version, record, log = () => {} }) {
  let turn, previousCodex, pending = Promise.resolve();
  async function begin(sessionId, isActive = () => true) {
    await pending;
    if (!isActive()) return false;
    const current = { id: randomUUID(), at: new Date(), sessionId, model, samples: [], incomplete: false, baseline: new Map(), steps: new Map() };
    if (engine === 'kimi') {
      try { current.baseline = new Map((await kimiFiles(home, sessionId)).map(entry => [entry.file, entry.size])); }
      catch (error) { current.incomplete = true; current.skipLogs = true; log(`Kimi usage: ${error.message}`); }
    }
    // Cancellation while the previous journal flushes must not open a new turn.
    if (!isActive()) return false;
    turn = current;
    return true;
  }
  function codex(raw) {
    if (!turn) return;
    const total = codexTokens(raw?.total), last = codexTokens(raw?.last);
    if (!last) return;
    let sample = last;
    if (total && previousCodex) {
      if (Object.keys(total).every(key => total[key] === previousCodex[key])) return;
      const decreased = Object.keys(total).some(key => total[key] < previousCodex[key]);
      if (decreased) { previousCodex = total; turn.incomplete = true; return; }
      if (!decreased) sample = Object.fromEntries(Object.keys(total).map(key => [key, total[key] - previousCodex[key]]));
      // A reset/compaction snapshot can repeat the last request; do not bill it twice.
    } else if (!total) turn.incomplete = true;
    previousCodex = total;
    if (sample.input || sample.output) turn.samples.push({ ...sample, model: turn.model });
  }
  function reroute(next) { if (turn && next) turn.model = next; }
  function incomplete() { if (turn) turn.incomplete = true; }
  function antigravityStep(id, raw) {
    if (!turn || !Number.isInteger(id)) return;
    const sample = antigravityTokens(raw);
    if (sample) turn.steps.set(id, { ...sample, aggregate: false, model: turn.model });
  }
  function end(result) {
    if (!turn) return pending;
    const current = turn; turn = null;
    pending = (async () => {
      if (engine === 'kimi' && !current.skipLogs) {
        try {
          // Kimi's journal writer buffers independently of its ACP response.
          // Wait for the native completion marker, not an arbitrary first read.
          const deadline = Date.now() + 1500;
          let usage;
          do {
            usage = await readKimiUsage(home, current.sessionId, current.baseline, { model: current.model, version });
            if (usage.settled || Date.now() >= deadline) break;
            await new Promise(resolve => setTimeout(resolve, 50));
          } while (true);
          current.samples.push(...usage.samples); current.incomplete ||= usage.incomplete || !usage.settled;
        } catch (error) { current.incomplete = true; log(`Kimi usage: ${error.message}`); }
      } else if (engine === 'antigravity') {
        const usage = antigravityTokens(result.usage);
        const steps = [...current.steps.values()];
        const sum = steps.reduce((total, sample) => {
          for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) total[key] = (total[key] || 0) + sample[key];
          return total;
        }, {});
        if (steps.length && (!usage || ['input', 'output', 'cacheRead', 'cacheWrite'].every(key => sum[key] === usage[key]))) {
          current.samples.push(...steps);
          if (!usage) current.incomplete = true;
        } else if (usage) current.samples.push({ ...usage, model: current.model });
      }
      const outcome = result.subtype === 'stopped' ? 'cancelled' : result.is_error || result.subtype !== 'success' ? 'failures' : 'requests';
      record({ ...current, engine, accountId, outcome });
    })().catch(error => log(`Subscription usage could not be saved: ${error.message}`));
    return pending;
  }
  return { begin, codex, reroute, incomplete, antigravityStep, end, flush: () => pending };
}

module.exports = { createSubscriptionMeter, readKimiUsage, kimiFiles, codexTokens, antigravityTokens };
