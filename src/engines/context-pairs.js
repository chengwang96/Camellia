'use strict';

const PAIR_IDS = Symbol('camellia.contextPairIds');

function eventOf(row) {
  if (!row || row.role !== 'tool' || typeof row.text !== 'string') return null;
  try {
    const value = JSON.parse(row.text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function toolIds(row) {
  const event = eventOf(row);
  const ids = new Set();
  if (!event) return ids;
  if (typeof event.id === 'string' && (event.type === 'tool_use' || event.type === 'gui:tool')) ids.add(event.id);
  if (typeof event.tool_use_id === 'string') ids.add(event.tool_use_id);
  if (typeof event.toolCallId === 'string') ids.add(event.toolCallId);
  const content = Array.isArray(event.message?.content) ? event.message.content
    : Array.isArray(event.content) ? event.content : [];
  for (const block of content) {
    if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') ids.add(block.tool_use_id);
    if (block?.type === 'tool_use' && typeof block.id === 'string') ids.add(block.id);
  }
  return ids;
}

function withPairIds(row, source = row) {
  const ids = [...toolIds(source)];
  if (ids.length) Object.defineProperty(row, PAIR_IDS, { value: ids, enumerable: true, configurable: true });
  return row;
}

// Split a compaction group into atomic chunks. Tool call and result rows that
// share an id stay in one chunk, including any rows between them. Unpaired
// rows remain individual chunks so the normal packing path stays untouched.
function pairSafeParts(rows) {
  const positions = new Map();
  rows.forEach((row, index) => {
    const ids = row[PAIR_IDS] || toolIds(row);
    for (const id of ids) {
      if (!positions.has(id)) positions.set(id, []);
      positions.get(id).push(index);
    }
  });
  const ranges = [...positions.values()].filter(indexes => indexes.length > 1)
    .map(indexes => [Math.min(...indexes), Math.max(...indexes)])
    .sort((first, second) => first[0] - second[0] || first[1] - second[1]);
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], range[1]);
    else merged.push(range.slice());
  }
  const parts = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    while (cursor < start) parts.push([rows[cursor++]]);
    parts.push(rows.slice(start, end + 1));
    cursor = end + 1;
  }
  while (cursor < rows.length) parts.push([rows[cursor++]]);
  return parts;
}

module.exports = { PAIR_IDS, toolIds, withPairIds, pairSafeParts };
