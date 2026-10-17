'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// Tool payloads are evidence, not conversation prose. Keep the full event on
// disk, but never clone, render or replay megabytes of XML/diffs as a message.
const INLINE_CHARS = 128 * 1024;
const PREVIEW_CHARS = 32 * 1024;
const STRING_CHARS = 8 * 1024;

function oversized(value, remaining = { chars: INLINE_CHARS, nodes: 10000 }) {
  if (--remaining.nodes < 0) return true;
  if (typeof value === 'string') remaining.chars -= value.length;
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      remaining.chars -= key.length + 8;
      if (remaining.chars < 0 || oversized(item, remaining)) return true;
    }
  }
  return remaining.chars < 0;
}

function preview(value, budget = { chars: PREVIEW_CHARS, nodes: 2048 }, depth = 0) {
  if (--budget.nodes < 0) return '[Tool data retained in the complete record]';
  if (typeof value === 'string') {
    const limit = Math.max(0, Math.min(STRING_CHARS, budget.chars));
    budget.chars -= Math.min(value.length, limit);
    if (value.length <= limit) return value;
    const head = Math.floor(limit * 0.75), tail = limit - head;
    return value.slice(0, head) + '\n[Preview shortened; ' + value.length + ' original characters]\n' + (tail ? value.slice(-tail) : '');
  }
  if (!value || typeof value !== 'object') return value;
  if (depth >= 12) return '[Nested tool data retained in the complete record]';
  const entries = Object.entries(value);
  const limited = [];
  for (const [key, item] of entries.slice(0, 128)) {
    if (budget.nodes <= 0 || budget.chars <= 0) break;
    budget.chars -= key.length + 8;
    limited.push([key.slice(0, 256), preview(item, budget, depth + 1)]);
  }
  if (Array.isArray(value)) {
    const result = limited.map(([, item]) => item);
    if (entries.length > limited.length) result.push('[Additional tool entries retained in the complete record]');
    return result;
  }
  return Object.fromEntries(limited);
}

function projectEvent(event, reference) {
  const result = preview(event);
  // Identifiers and lifecycle fields must survive even after the text budget
  // was consumed by tool arguments.
  for (const key of ['type', 'id', 'name', 'status', 'is_error', 'runId', 'eventSeq', 'session_id', 'conversationId'])
    if (event[key] !== undefined) result[key] = event[key];
  result.fullOutput = reference;
  result.output = (typeof result.output === 'string' ? result.output : '')
    + '\n[Tool preview shortened. Complete record: ' + reference.path
    + (reference.offset === undefined ? '' : '; byte offset ' + reference.offset + ', length ' + reference.length) + ']';
  return result;
}

function retainEvent(event, directory) {
  if (event.type !== 'gui:tool' || !oversized(event)) return event;
  const text = JSON.stringify(event);
  const hash = createHash('sha256').update(text).digest('hex');
  fs.mkdirSync(directory, { recursive: true });
  // Treat the complete event as a transcript record, so data import streams it
  // instead of trying to rewrite it as bounded configuration JSON.
  const file = path.join(directory, hash + '.jsonl');
  try { fs.writeFileSync(file, text, { flag: 'wx', mode: 0o600, flush: true }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const saved = fs.lstatSync(file);
    if (!saved.isFile() || saved.isSymbolicLink() || saved.nlink !== 1 || saved.size !== Buffer.byteLength(text))
      throw new Error('The complete tool record is unavailable: ' + file);
  }
  return projectEvent(event, { path: file });
}

function projectRow(row, reference) {
  if (row.role !== 'tool' || typeof row.text !== 'string' || row.text.length <= INLINE_CHARS) return row;
  let event;
  // Older adapters also used tool rows for plain text. Do not reinterpret that
  // prose or malformed records as structured file-change events.
  try { event = JSON.parse(row.text); } catch { return row; }
  if (!event || typeof event !== 'object' || event.type !== 'gui:tool') return row;
  return { ...row, text: JSON.stringify(projectEvent(event, reference)) };
}

module.exports = { INLINE_CHARS, PREVIEW_CHARS, oversized, retainEvent, projectRow };
