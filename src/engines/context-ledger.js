'use strict';

const { FLAGS, tokens } = require('./conversation-history');
const { isStreamingToolRow } = require('./tool-history');

const CATEGORY_ORDER = [
  'instructions', 'conversation', 'tool-calls', 'tool-results', 'attachments',
  'compaction', 'pending', 'engine-managed',
];
const CATEGORY_LABELS = {
  instructions: 'Instructions',
  conversation: 'Conversation',
  'tool-calls': 'Tool calls',
  'tool-results': 'Tool results',
  attachments: 'Attachments',
  compaction: 'Compaction',
  pending: 'Pending input',
  'engine-managed': 'Engine-managed',
};
const NODE_LIMIT = 100;
const ROW_LIMIT = 600;
const EVENT_LIMIT = 60;
const PREVIEW_CHARS = 320;
const CONTENT_CHARS = 8192;

const SECRET_PATTERNS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\b(\s*[:=]\s*)(["']?)[^\s"',}]{6,}\3/gi,
];

function redact(value) {
  let text = String(value ?? '');
  text = text.replace(SECRET_PATTERNS[0], '[redacted]');
  text = text.replace(SECRET_PATTERNS[1], '[redacted]');
  text = text.replace(SECRET_PATTERNS[2], '$1$2[redacted]');
  return text;
}

function clip(value, limit) {
  const text = redact(value);
  return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false };
}

function effectiveText(row) {
  if (!row || typeof row !== 'object') return '';
  if (row.role === 'assistant' && row.runResult && (!row.text || row.text === row.runResult.result))
    return String(row.runResult.result || '');
  return String(row.text ?? '');
}

function toolEvent(row) {
  if (!row || row.role !== 'tool' || typeof row.text !== 'string') return null;
  try {
    const value = JSON.parse(row.text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function categoryFor(row) {
  if (!row || row.internal || isStreamingToolRow(row)) return null;
  if (row.role === 'user') return 'conversation';
  if (row.role === 'assistant') return 'conversation';
  if (row.role === 'notice') {
    if (row.compaction || row.file || /^Context compacted\b/i.test(String(row.text || ''))) return 'compaction';
    return 'conversation';
  }
  if (row.role === 'tool') {
    const event = toolEvent(row);
    if (!event) return 'tool-calls';
    if (event.type === 'gui:tool') {
      if (event.output !== undefined || event.result !== undefined || ['completed', 'failed', 'cancelled'].includes(event.status))
        return 'tool-results';
      return 'tool-calls';
    }
    if (event.type === 'tool_use' || event.type === 'tool-call' || event.tool_use_id) return 'tool-calls';
    return event.type === 'tool_result' ? 'tool-results' : 'tool-results';
  }
  return null;
}

function categoryLabel(id) {
  return CATEGORY_LABELS[id] || id;
}

function nodeForRow(row, category) {
  const text = effectiveText(row);
  const clipped = clip(text, PREVIEW_CHARS);
  return {
    id: 'n:' + row.seq,
    category,
    label: categoryLabel(category),
    seq: row.seq,
    role: row.role || '',
    kind: category,
    tokens: Math.round(tokens(text)),
    chars: text.length,
    preview: clipped.text,
    observed: true,
    status: 'estimated',
    expandable: Boolean(text),
    redacted: redact(text) !== text,
  };
}

function nodeForAttachment(row) {
  const attachments = Array.isArray(row.attachments) ? row.attachments : [];
  if (!attachments.length) return null;
  const images = attachments.filter(item => item.isImage === true || /^image\//i.test(item.mimeType || item.mime || '')).length;
  const text = attachments.map(item => item.name || item.path || 'attachment').join(', ');
  return {
    id: 'n:' + row.seq + ':attachments',
    category: 'attachments',
    label: categoryLabel('attachments'),
    seq: row.seq,
    role: row.role || 'user',
    kind: 'attachments',
    tokens: images * 4096,
    chars: text.length,
    preview: clip(text, PREVIEW_CHARS).text,
    observed: true,
    status: images ? 'estimated' : 'observed',
    expandable: false,
    redacted: false,
    count: attachments.length,
  };
}

function usageFromRows(rows) {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    if (row && (row.lastCallUsage || row.usage)) return row.lastCallUsage || row.usage;
  }
  return null;
}

function cacheHitRate(usage) {
  if (!usage) return null;
  const input = Number(usage.input_tokens || usage.prompt_tokens || 0);
  const read = Number(usage.cache_read_input_tokens || 0);
  const write = Number(usage.cache_creation_input_tokens || 0);
  const total = input + read + write;
  return total > 0 && read >= 0 ? read / total * 100 : null;
}

function addCategory(categories, id, amount, status = 'estimated') {
  if (!amount || amount <= 0) return;
  const current = categories.get(id) || { id, label: categoryLabel(id), tokens: 0, status };
  current.tokens += amount;
  if (status === 'opaque') current.status = 'opaque';
  else if (current.status !== 'opaque' && status === 'observed') current.status = 'observed';
  categories.set(id, current);
}

function findTargetUser(historyStore, conversationId, turnSeq) {
  const before = Number.isFinite(turnSeq) ? Math.floor(turnSeq) + 1 : Infinity;
  let inspected = 0;
  for (const row of historyStore.iterate(conversationId, {
    mask: FLAGS.public, reverse: true, before, snapshot: true,
  })) {
    if (row.role === 'user') return row;
    if (++inspected >= ROW_LIMIT) break;
  }
  return null;
}

function rowsForTurn(historyStore, conversationId, target) {
  if (!target) return { rows: [], truncated: false };
  const rows = [];
  let truncated = false;
  for (const row of historyStore.iterate(conversationId, {
    mask: FLAGS.public, after: target.seq - 1, snapshot: true,
  })) {
    if (rows.length && row.role === 'user') break;
    rows.push(row);
    if (rows.length >= ROW_LIMIT) {
      truncated = true;
      break;
    }
  }
  return { rows, truncated };
}

function compactionEvent(row) {
  if (!row || row.role !== 'notice') return null;
  const text = String(row.text || '');
  if (row.compaction || row.file || /^Context compacted\b/i.test(text)) {
    return {
      id: 'e:' + row.seq,
      kind: 'compact',
      seq: row.seq,
      at: row.at || null,
      engine: row.engine || null,
      state: row.compaction?.state || (row.compaction?.native ? 'completed' : 'completed'),
      native: row.compaction?.native === true,
      source: 'compaction',
      beforeTokens: Number.isFinite(row.compaction?.beforeTokens) ? row.compaction.beforeTokens : null,
      afterTokens: Number.isFinite(row.compaction?.afterTokens) ? row.compaction.afterTokens : null,
      deltaTokens: Number.isFinite(row.compaction?.deltaTokens) ? row.compaction.deltaTokens : null,
      deltaSource: row.compaction?.deltaSource || null,
      text: clip(text || 'Context compacted', PREVIEW_CHARS).text,
    };
  }
  if (/^Markdown handoff:/i.test(text)) {
    return {
      id: 'e:' + row.seq,
      kind: 'handoff',
      seq: row.seq,
      at: row.at || null,
      engine: row.engine || null,
      state: 'completed',
      native: false,
      source: 'handoff',
      text: clip(text, PREVIEW_CHARS).text,
    };
  }
  return null;
}

function eventsForConversation(historyStore, conversation, limit = EVENT_LIMIT) {
  const events = [];
  const seen = new Set();
  const push = event => {
    if (!event || seen.has(event.id)) return;
    seen.add(event.id);
    events.push(event);
  };
  for (const handoff of conversation.handoffs || []) {
    push({
      id: 'handoff:' + handoff.at + ':' + (handoff.from || '') + ':' + (handoff.to || ''),
      kind: 'handoff',
      seq: null,
      at: handoff.at || null,
      engine: handoff.to || null,
      state: handoff.status || 'completed',
      native: Boolean(handoff.fullPath),
      source: 'handoff',
      text: clip('Handoff ' + (handoff.from || 'previous') + ' → ' + (handoff.to || 'next'), PREVIEW_CHARS).text,
    });
  }
  for (const settlement of conversation.childSettlements || []) {
    push({
      id: 'child-settle:' + (settlement.requestId || settlement.at) + ':' + (settlement.childConversationId || ''),
      kind: 'child-settle',
      seq: null,
      at: settlement.at || null,
      engine: null,
      state: settlement.status || 'completed',
      native: false,
      source: 'child',
      text: clip(settlement.summary || 'Child settled', PREVIEW_CHARS).text,
    });
  }
  for (const event of conversation.contextEvents || []) {
    const fields = Array.isArray(event.fields) && event.fields.length ? ' · ' + event.fields.join(', ') : '';
    const detail = event.kind === 'inject'
      ? 'Injected ' + (event.sources || []).join(', ') + ' (' + (event.chars || 0) + ' chars)'
      : event.kind === 'switch' ? 'Binding changed' + fields
        : event.kind === 'child-create' ? 'Child created' + (event.title ? ': ' + event.title : '')
          : event.kind === 'fork' ? 'Conversation forked' + (event.title ? ': ' + event.title : '')
            : event.kind || 'Context event';
    push({
      id: event.id || ('metadata:' + event.kind + ':' + event.at),
      kind: event.kind || 'event',
      seq: event.seq ?? null,
      at: event.at || null,
      engine: event.engine || null,
      state: event.state || 'completed',
      native: false,
      source: event.source || null,
      beforeTokens: Number.isFinite(event.beforeTokens) ? event.beforeTokens : null,
      afterTokens: Number.isFinite(event.afterTokens) ? event.afterTokens : null,
      deltaTokens: Number.isFinite(event.deltaTokens) ? event.deltaTokens : null,
      deltaSource: event.deltaSource || null,
      text: clip(event.text || detail, PREVIEW_CHARS).text,
    });
  }
  const max = Math.max(1, limit);
  if (events.length < max) {
    for (const row of historyStore.summaries(conversation.id, { limit: max - events.length })) {
      const event = compactionEvent(row);
      if (event) push(event);
    }
  }
  return events.slice(0, max);
}

function snapshotForConversation({
  historyStore, conversation, engine, settings = {}, pressure = null,
  turnSeq = null, pendingText = '', instructionsText = '', summaryText = '',
}) {
  const target = findTargetUser(historyStore, conversation.id, turnSeq);
  const selected = rowsForTurn(historyStore, conversation.id, target);
  const rows = selected.rows;
  const categories = new Map();
  const nodes = [];
  const summary = typeof summaryText === 'function' ? summaryText(target?.seq ?? Infinity) : summaryText;
  let warnings = [];
  let hiddenRows = 0;

  for (const row of rows) {
    const category = categoryFor(row);
    if (!category) {
      hiddenRows++;
      continue;
    }
    const text = effectiveText(row);
    const amount = Math.round(tokens(text));
    if (category === 'compaction' && row.file) {
      // The summary body is counted separately from the small transcript notice.
      hiddenRows++;
      continue;
    }
    addCategory(categories, category, amount);
    if (nodes.length < NODE_LIMIT) nodes.push(nodeForRow(row, category));
    const attachmentNode = nodeForAttachment(row);
    if (attachmentNode) {
      addCategory(categories, 'attachments', attachmentNode.tokens, attachmentNode.status);
      if (nodes.length < NODE_LIMIT) nodes.push(attachmentNode);
    }
  }

  addCategory(categories, 'instructions', Math.round(tokens(instructionsText)));
  addCategory(categories, 'compaction', Math.round(tokens(summary)));
  addCategory(categories, 'pending', Math.round(tokens(pendingText)));

  const knownTokens = [...categories.values()].reduce((total, category) => total + category.tokens, 0);
  const reportedUsed = pressure?.source === 'usage' && Number.isFinite(pressure.used) ? Math.max(0, pressure.used) : null;
  const total = Math.max(knownTokens, reportedUsed || 0);
  const opaque = Math.max(0, total - knownTokens);
  if (opaque > 0) addCategory(categories, 'engine-managed', opaque, 'opaque');

  const usage = usageFromRows(rows);
  const cap = Number.isFinite(pressure?.cap) && pressure.cap > 0
    ? pressure.cap
    : Number.isFinite(usage?.context_window) && usage.context_window > 0 ? usage.context_window : null;
  const pct = cap ? Math.min(100, total / cap * 100) : null;
  if (!reportedUsed) warnings.push('No provider usage was reported for this request; composition is estimated.');
  if (opaque > 0) warnings.push('Part of this request is managed by the native engine and is not individually observable.');
  if (selected.truncated || rows.length >= ROW_LIMIT) warnings.push('Only a bounded portion of the turn is shown.');
  if (hiddenRows > 0) warnings.push(hiddenRows + ' internal or synthetic row(s) are omitted.');

  const ordered = CATEGORY_ORDER
    .map(id => categories.get(id))
    .filter(Boolean)
    .sort((first, second) => first.id === 'engine-managed' ? 1 : second.id === 'engine-managed' ? -1 : 0);

  return {
    version: 1,
    conversationId: conversation.id,
    engine: engine || conversation.currentEngine || '',
    model: settings.model || conversation.apiModel || '',
    connection: settings.connection || 'api',
    turnSeq: target?.seq ?? null,
    at: Date.now(),
    usage: usage ? {
      inputTokens: Number(usage.input_tokens || usage.prompt_tokens || 0),
      outputTokens: Number(usage.output_tokens || 0),
      cacheReadTokens: Number(usage.cache_read_input_tokens || 0),
      cacheWriteTokens: Number(usage.cache_creation_input_tokens || 0),
      contextWindow: cap,
      cacheHitRate: cacheHitRate(usage),
    } : {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      contextWindow: cap, cacheHitRate: null,
    },
    pressure: {
      used: total,
      cap,
      pct,
      source: reportedUsed ? 'usage' : 'estimate',
    },
    categories: ordered,
    nodes,
    events: eventsForConversation(historyStore, conversation, 20),
    warnings: [...new Set(warnings)],
    truncated: selected.truncated || rows.length >= ROW_LIMIT,
  };
}

function nodeForConversation(historyStore, conversation, nodeId) {
  const match = /^n:(\d+)$/.exec(String(nodeId || ''));
  if (!match) throw new Error('This context node is not expandable');
  const seq = Number(match[1]);
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('Invalid context node');
  for (const row of historyStore.iterate(conversation.id, {
    mask: FLAGS.public, after: seq - 1, before: seq + 1, snapshot: true,
  })) {
    if (row.seq !== seq) continue;
    const text = effectiveText(row);
    const clipped = clip(text, CONTENT_CHARS);
    return {
      id: nodeId,
      seq,
      role: row.role || '',
      content: clipped.text,
      chars: text.length,
      truncated: clipped.truncated,
      redacted: redact(text) !== text,
    };
  }
  throw new Error('Context node not found');
}

module.exports = {
  CATEGORY_ORDER,
  CATEGORY_LABELS,
  redact,
  eventsForConversation,
  nodeForConversation,
  snapshotForConversation,
};
