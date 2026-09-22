'use strict';

const encode = history => JSON.stringify({ history });
const summaryLimit = budget => Math.min(12000, Math.floor(budget / 3));

function planCompaction(rows, budget) {
  const groups = [];
  for (const row of rows) {
    if (!groups.length || row.role === 'user') groups.push([]);
    groups.at(-1).push({ role: row.role, engine: row.engine, text: row.text || '', sourceSeq: row.seq,
      ...(row.attachments?.length ? { attachments: row.attachments } : {}) });
  }
  const recent = [];
  const recentLimit = Math.min(12000, Math.floor(budget * 0.2));
  while (groups.length > 1 && recent.length < 2) {
    const candidate = [groups.at(-1), ...recent];
    if (encode(candidate.flat()).length > recentLimit) break;
    recent.unshift(groups.pop());
  }
  return { units: groups, recent: recent.flat(), recentChars: recent.length ? encode(recent.flat()).length : 0 };
}

function takeFragment(units, limit) {
  const pending = units.map(group => [...group]);
  const selected = [];
  let splitRecords = 0;
  while (pending.length) {
    const group = pending[0];
    if (encode([...selected, ...group]).length <= limit) {
      selected.push(...group); pending.shift(); continue;
    }
    if (selected.length && encode(group).length <= limit) break;
    if (group.length > 1) {
      pending.splice(0, 1, ...group.map(row => [row]));
      continue;
    }
    const row = group[0];
    const offset = row.fragment?.offset || 0;
    const total = row.fragment?.total || row.text.length;
    const part = length => ({ ...row, text: row.text.slice(0, length), fragment: { offset, total } });
    let lower = 0, upper = row.text.length;
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
  return { text: encode(selected), remaining: pending, splitRecords };
}

module.exports = { planCompaction, takeFragment, summaryLimit };
