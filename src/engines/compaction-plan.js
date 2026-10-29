'use strict';

const encode = history => JSON.stringify({ history });
const summaryLimit = budget => Math.min(12000, Math.floor(budget / 3));
// Partial summaries are merged afterwards, so each map answer stays small. The
// bound scales with the request budget but never exceeds what a single merge
// step can still accept without another nesting level.
const mapSummaryLimit = budget => Math.min(4000, Math.max(1024, Math.floor(budget / 8)));

// Measure rows separately and stop as soon as they cannot fit. Testing a large
// interaction must not first allocate its complete JSON representation.
function historyLength(rows, limit = Infinity) {
  let length = encode([]).length, count = 0;
  for (const row of rows) {
    if ((row.text?.length || 0) > limit - length) return Infinity;
    length += JSON.stringify(row).length + Number(count++ > 0);
    if (length > limit) return Infinity;
  }
  return length;
}

const compactionRow = row => ({ role: row.role, engine: row.engine, text: row.text || '', sourceSeq: row.seq,
  ...(row.attachments?.length ? { attachments: row.attachments } : {}) });

function planCompaction(rows, budget) {
  const groups = [];
  for (const row of rows) {
    if (!groups.length || row.role === 'user') groups.push([]);
    groups.at(-1).push(compactionRow(row));
  }
  const recent = [];
  const recentLimit = Math.min(12000, Math.floor(budget * 0.2));
  while (groups.length > 1 && recent.length < 2) {
    const candidate = [groups.at(-1), ...recent];
    if (historyLength(candidate.flat(), recentLimit) > recentLimit) break;
    recent.unshift(groups.pop());
  }
  return { units: groups, recent: recent.flat(), recentChars: recent.length ? encode(recent.flat()).length : 0 };
}

// readRows is replayable and accepts { reverse }. Inspect only the bounded
// recent tail up front; older history is read as the summary workers need it.
function planHistoryCompaction(readRows, budget) {
  const recentLimit = Math.min(12000, Math.floor(budget * 0.2)), groups = [];
  let group = [], groupStart, recentStart, length = encode([]).length, count = 0;
  for (const original of readRows({ reverse: true })) {
    if (group[0]?.role === 'user') {
      groups.unshift(group); recentStart = groupStart; group = [];
      if (groups.length === 2) break;
    }
    const row = compactionRow(original), cost = historyLength([row], recentLimit) - encode([]).length;
    length += cost + Number(count++ > 0);
    if (length > recentLimit) break;
    group.unshift(row); groupStart = original;
  }
  const recent = groups.flat(), recentSeq = recent[0]?.sourceSeq ?? Infinity;
  const plan = { recent, recentChars: recent.length ? historyLength(recent) : 0, inputChars: 2 };
  plan.units = { *[Symbol.iterator]() {
    plan.inputChars = 2;
    let pending = [], chars = 2, units = 0;
    for (const original of readRows({})) {
      if (recentStart?.historyIndex !== undefined ? original.historyIndex === recentStart.historyIndex : original.seq === recentSeq) break;
      const row = compactionRow(original);
      if (row.role === 'user' && pending.length) {
        plan.inputChars += chars + Number(units++ > 0);
        yield pending; pending = []; chars = 2;
      }
      chars += JSON.stringify(row).length + Number(pending.length > 0);
      pending.push(row);
      // A single long interaction is streamed too. The fragment selector below
      // splits oversized records losslessly and keeps their original offsets.
      if (chars > budget) {
        plan.inputChars += chars + Number(units++ > 0);
        yield pending; pending = []; chars = 2;
      }
    }
    if (pending.length) {
      plan.inputChars += chars + Number(units > 0);
      yield pending;
    }
  } };
  return plan;
}

// Select one fragment. `consumed` holds the records that the fragment carries,
// including the prefix of a split record, so a caller that has to shrink the
// budget afterwards can put the original records back and split them again
// instead of losing the text it already removed from `remaining`.
function selectFragment(units, limit) {
  const pending = units.map(group => [...group]);
  const selected = [];
  let splitRecords = 0;
  while (pending.length) {
    const group = pending[0];
    const selectedChars = historyLength(selected, limit);
    const groupChars = historyLength(group, limit);
    if (selectedChars + groupChars - encode([]).length + Number(selected.length > 0 && group.length > 0) <= limit) {
      selected.push(...group); pending.shift(); continue;
    }
    if (selected.length && groupChars <= limit) break;
    if (group.length > 1) {
      pending.splice(0, 1, ...group.map(row => [row]));
      continue;
    }
    const row = group[0];
    const offset = row.fragment?.offset || 0;
    const total = row.fragment?.total || row.text.length;
    const part = length => ({ ...row, text: row.text.slice(0, length), fragment: { offset, total } });
    let lower = 0, upper = Math.min(row.text.length, Math.max(0, limit - selectedChars));
    while (lower < upper) {
      const middle = Math.ceil((lower + upper) / 2);
      if (encode([...selected, part(middle)]).length <= limit) lower = middle;
      else upper = middle - 1;
    }
    if (lower < row.text.length && /[\uD800-\uDBFF]/.test(row.text[lower - 1] || '')) lower--;
    if (!lower && selected.length) break;
    if (!lower) throw new Error('A history record has metadata too large for the compaction budget; original history is retained.');
    selected.push(part(lower)); splitRecords++;
    if (lower === row.text.length) pending.shift();
    else pending[0] = [{ ...row, text: row.text.slice(lower), fragment: { offset: offset + lower, total } }];
    break;
  }
  return { text: encode(selected), consumed: selected, remaining: pending, splitRecords };
}

// Keep at most one look-ahead group and the current fragment in memory. The
// limit is read for every fragment so later work uses a learned smaller budget.
function* fragmentUnits(units, limit) {
  const source = units[Symbol.iterator]();
  let pending = [], done = false;
  try {
    while (pending.length || !done) {
      const cap = limit();
      while (!done && historyLength(pending.flat(), cap) <= cap) {
        const next = source.next();
        done = next.done;
        if (!done && next.value.length) pending.push(next.value);
      }
      if (!pending.length) break;
      const fragment = selectFragment(pending, cap);
      pending = fragment.remaining;
      yield fragment;
    }
  } finally { source.return?.(); }
}

// Greedy packing keeps one merge request inside the character budget while
// retaining the order of the summaries it merges.
function packSummaries(entries, limit) {
  const batches = [];
  let batch = [], size = 0;
  for (const text of entries) {
    const cost = String(text).length + 96;
    if (batch.length && size + cost > limit) { batches.push(batch); batch = []; size = 0; }
    batch.push(text); size += cost;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

// Kept as the single-fragment view used by callers that only need the text.
function takeFragment(units, limit) {
  const { text, remaining, splitRecords } = selectFragment(units, limit);
  return { text, remaining, splitRecords };
}

module.exports = { planCompaction, planHistoryCompaction, fragmentUnits, mapSummaryLimit, packSummaries, selectFragment, takeFragment, summaryLimit };
