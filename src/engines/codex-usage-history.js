'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { accountHome } = require('./subscription-accounts');
const { dayId } = require('../api/api-usage');

const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'];
const RAW_FIELDS = ['input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'reasoning_output_tokens'];
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const ACCOUNT = /^[a-z0-9][a-z0-9-]{0,31}$/;
const keyOf = (account, day, model) => JSON.stringify([account, day, model]);
function tokens(raw) {
  if (!raw || !['input_tokens', 'output_tokens'].every(field => Number.isFinite(raw[field]))) return null;
  if (!RAW_FIELDS.every(field => raw[field] === undefined || Number.isFinite(raw[field]) && raw[field] >= 0)) return null;
  return Object.fromEntries(FIELDS.map((field, i) => [field, raw[RAW_FIELDS[i]] || 0]));
}
async function rolloutFiles(dir, budget, depth = 0) {
  if (depth > 4) throw new Error('Too many Codex usage directories');
  const info = await fs.promises.lstat(dir).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!info?.isDirectory() || info.isSymbolicLink()) return [];
  const result = [];
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    if (++budget.entries > 20000) throw new Error('Too many Codex usage files');
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) result.push(...await rolloutFiles(file, budget, depth + 1));
    else if (entry.isFile() && /^rollout-.+\.jsonl$/.test(entry.name)) result.push(file);
  }
  return result;
}

// Only token metadata and turn boundaries are retained. Native history is
// read-only. Unmatched, changed, damaged or oversized history falls back to
// a labelled aggregate estimate instead of partially importing its tokens.
async function readCodexPricingHistory({ userData, targets, maxBytes = 2 * 1024 ** 3 }) {
  if (!userData) return [];
  const wanted = new Set(targets.map(row => keyOf(row.account, row.day, row.model)));
  const accounts = new Map(targets.filter(row => row.engine === 'codex' && ACCOUNT.test(row.accountId)
    && row.account === `codex:${row.accountId}`).map(row => [row.account, row.accountId]));
  const groups = new Map(), seen = new Map(), blocked = new Set(), budget = { entries: 0, bytes: 0 };
  for (const [account, id] of accounts) {
    const home = accountHome({ userData, engine: 'codex', id, root: path.join(userData, 'codex', 'subscription') });
    let files;
    try { files = [...await rolloutFiles(path.join(home, 'sessions'), budget), ...await rolloutFiles(path.join(home, 'archived_sessions'), budget)]; }
    catch { continue; }
    for (const file of files) {
      const fileGroups = [], turnIds = new Map();
      let current = null, previous = null, model = null, owned = false, broken = false;
      function finish() {
        if (!current) return;
        const key = keyOf(account, current.day, current.model);
        if (wanted.has(key)) fileGroups.push({ key, ...current });
        current = null;
      }
      let input, lines;
      try {
        const before = await fs.promises.lstat(file);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) continue;
        budget.bytes += before.size;
        if (budget.bytes > maxBytes) return [];
        input = fs.createReadStream(file, { start: 0, end: Math.max(0, before.size - 1) });
        lines = readline.createInterface({ input, crlfDelay: Infinity });
        for await (const line of lines) {
          // Ignore message and tool rows without parsing their large contents.
          if (!/"type"\s*:\s*"(?:event_msg|session_meta|turn_context)"/.test(line.slice(0, 160))) continue;
          let row;
          try { row = JSON.parse(line); } catch { broken = true; break; }
          const value = row.payload || {};
          if (row.type === 'session_meta') {
            owned = value.originator === 'camellia' && UUID.test(value.id)
              && typeof value.source === 'string' && (!value.model_provider || value.model_provider === 'openai');
            if (!owned) break;
          } else if (!owned) { broken = true; break; }
          else if (row.type === 'turn_context') {
            if (typeof value.model !== 'string' || !UUID.test(value.turn_id)) { broken = true; break; }
            model = value.model;
            if (current && current.id === value.turn_id) current.model = model;
          } else if (row.type === 'event_msg' && value.type === 'task_started') {
            finish();
            const date = new Date(row.timestamp);
            if (!UUID.test(value.turn_id) || !Number.isFinite(date.getTime())) { broken = true; break; }
            current = { account, id: value.turn_id, day: dayId(date), model, samples: [] };
          } else if (row.type === 'event_msg' && ['task_complete', 'turn_aborted'].includes(value.type)) {
            if (current && value.turn_id && current.id !== value.turn_id) { broken = true; break; }
            finish();
          } else if (row.type === 'event_msg' && value.type === 'token_count' && value.info && current) {
            const total = tokens(value.info.total_token_usage), last = tokens(value.info.last_token_usage);
            if (!last) { broken = true; break; }
            let sample = last;
            // Same de-duplication and compaction reset rules as the live meter.
            if (total && previous) {
              if (FIELDS.every(field => total[field] === previous[field])) continue;
              if (FIELDS.some(field => total[field] < previous[field])) { previous = total; continue; }
              sample = Object.fromEntries(FIELDS.map(field => [field, total[field] - previous[field]]));
            }
            previous = total;
            if (sample.input || sample.output) current.samples.push(sample);
          }
        }
        // An unfinished native turn has not entered the saved usage totals.
        const after = await fs.promises.lstat(file);
        if (broken || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) continue;
        for (const turn of fileGroups) {
          const id = JSON.stringify([account, turn.id]);
          const signature = JSON.stringify([turn.key, turn.samples]);
          const old = seen.get(id) || turnIds.get(id);
          if (old && old !== signature) { broken = true; break; }
          turnIds.set(id, signature);
        }
        if (broken) {
          // Conflicting fork copies cannot verify a daily bucket.
          for (const turn of fileGroups) { groups.delete(turn.key); blocked.add(turn.key); }
          for (const turn of fileGroups) seen.set(JSON.stringify([account, turn.id]), 'conflict');
          continue;
        }
        for (const turn of fileGroups) {
          if (blocked.has(turn.key)) continue;
          const id = JSON.stringify([account, turn.id]);
          if (seen.has(id)) continue;
          seen.set(id, turnIds.get(id));
          const group = groups.get(turn.key) || { account, day: turn.day, model: turn.model, turns: 0, samples: [] };
          group.turns++; group.samples.push(...turn.samples); groups.set(turn.key, group);
        }
      } catch { /* Missing or unreadable history keeps the aggregate fallback. */ }
      finally { lines?.close(); input?.destroy(); }
    }
  }
  return [...groups.values()];
}

module.exports = { readCodexPricingHistory };
