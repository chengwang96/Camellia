'use strict';

function liveDelta(previous, next) {
  if (!next || !previous || next.runId !== previous.runId) return next;
  const result = { ...next };
  if (typeof next.text === 'string' && typeof previous.text === 'string' && next.text.startsWith(previous.text)) {
    delete result.text;
    result.textDelta = next.text.slice(previous.text.length);
    result.textBaseLength = previous.text.length;
    result.baseEventSeq = previous.eventSeq;
  }
  if (JSON.stringify(next.process) === JSON.stringify(previous.process)) delete result.process;
  return result;
}

function snapshotDelta(previous, next) {
  if (!previous || previous.instanceId !== next.instanceId) return next;
  const patch = { instanceId: next.instanceId, cursor: next.cursor, delta: true };
  for (const [key, value] of Object.entries(next)) {
    if (key === 'instanceId' || key === 'cursor') continue;
    if (JSON.stringify(value) === JSON.stringify(previous[key])) continue;
    patch[key] = key === 'live' ? liveDelta(previous.live, value) : value;
  }
  for (const key of Object.keys(previous)) if (!Object.hasOwn(next, key)) patch[key] = null;
  return patch;
}

module.exports = { snapshotDelta };
