'use strict';

const LIMIT = 96 * 1024;
const clip = value => typeof value === 'string' ? value.slice(-LIMIT) : '';
function printable(value) {
  if (typeof value === 'string') return clip(value);
  if (Array.isArray(value)) return clip(value.map(part => typeof part === 'string' ? part : part?.text || '').filter(Boolean).join('\n'));
  return '';
}

function projectOutput(events = [], finished = false) {
  const entries = [], tools = new Map();
  let blocks = new Map();
  const add = entry => { entries.push(entry); return entry; };
  const tool = value => {
    const id = String(value.id || value.tool_use_id || `tool-${entries.length}`);
    let entry = tools.get(id);
    if (!entry) { entry = add({ type: 'tool', id, title: 'Tool', text: '', status: 'in_progress' }); tools.set(id, entry); }
    if (typeof value.name === 'string') entry.title = value.name.slice(0, 120);
    if (value.status) entry.status = value.status;
    if (value.is_error) entry.status = 'failed';
    const input = value.input;
    const command = input && typeof input === 'object' ? input.command || input.file_path || input.path || input.pattern || input.description : input;
    if (typeof command === 'string') entry.input = clip(command);
    if (value.output !== undefined) entry.text = printable(value.output);
    return entry;
  };
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'stream_event') {
      const update = event.event || {};
      if (update.type === 'message_start') blocks = new Map();
      if (update.type === 'content_block_start') {
        const block = update.content_block || {};
        let entry;
        if (block.type === 'text') entry = add({ type: 'text', phase: block.phase || '', text: clip(block.text) });
        if (block.type === 'thinking') entry = add({ type: 'thinking', text: clip(block.thinking) });
        if (block.type === 'tool_use') entry = tool(block);
        if (entry) blocks.set(update.index, entry);
      }
      if (update.type === 'content_block_delta') {
        const delta = update.delta || {};
        let entry = blocks.get(update.index);
        if (!entry && ['text_delta', 'thinking_delta'].includes(delta.type)) {
          entry = add({ type: delta.type === 'thinking_delta' ? 'thinking' : 'text', text: '', phase: '' }); blocks.set(update.index, entry);
        }
        if (entry && delta.type === 'text_delta') entry.text = clip(entry.text + (delta.text || ''));
        if (entry && delta.type === 'thinking_delta') entry.text = clip(entry.text + (delta.thinking || ''));
        if (entry && delta.type === 'input_json_delta') {
          entry.partial = clip((entry.partial || '') + (delta.partial_json || ''));
          try { tool({ id: entry.id, input: JSON.parse(entry.partial) }); } catch {}
        }
      }
    } else if (event.type === 'gui:message-phase') {
      const entry = blocks.get(event.index); if (entry) entry.phase = event.phase;
    } else if (event.type === 'gui:tool' || event.type === 'tool_use') tool(event);
    else if (event.type === 'gui:plan') {
      add({ type: 'plan', title: 'Plan', text: clip((event.entries || []).map(entry => `${entry.status || ''} · ${entry.content || entry.step || ''}`).join('\n')) });
    } else if (event.type === 'user') {
      for (const result of Array.isArray(event.message?.content) ? event.message.content : []) {
        if (result.type === 'tool_result') tool({ id: result.tool_use_id, output: result.content, status: result.is_error ? 'failed' : 'completed' });
      }
    } else if (event.type === 'assistant') {
      for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
        if (block.type === 'tool_use') tool(block);
        else if (block.type === 'text' || block.type === 'thinking') {
          const value = clip(block.text || block.thinking);
          if (value && ![...blocks.values()].some(entry => entry.type === block.type && entry.text === value))
            add({ type: block.type, phase: block.phase || '', text: value });
        }
      }
    }
  }
  const texts = entries.filter(entry => entry.type === 'text' && entry.phase !== 'commentary' && entry.text.trim());
  let visible = texts.slice(-1);
  if (finished) {
    const lastActivity = entries.findLastIndex(entry => entry.type !== 'text');
    if (lastActivity >= 0) visible = texts.filter(entry => entry.phase === 'final_answer' || entries.indexOf(entry) > lastActivity);
    else if (texts.some(entry => entry.phase === 'final_answer')) visible = texts.filter(entry => entry.phase === 'final_answer');
  }
  return { text: visible.map(entry => entry.text).join('\n\n'), process: cleanProcess(entries.filter(entry => !visible.includes(entry))) };
}

function cleanProcess(entries) {
  let budget = LIMIT;
  const result = [];
  for (const entry of (Array.isArray(entries) ? entries : []).slice(-120).reverse()) {
    if (!entry || !['text', 'thinking', 'tool', 'plan'].includes(entry.type)) continue;
    const body = clip(entry.text), input = clip(entry.input);
    const content = body.slice(-budget); budget -= content.length;
    const command = input.slice(-Math.max(0, budget));
    const safeInput = budget > 0 ? command : ''; budget -= safeInput.length;
    result.unshift({ type: entry.type, title: typeof entry.title === 'string' ? entry.title.slice(0, 120) : '',
      text: content, ...(safeInput ? { input: safeInput } : {}),
      status: ['in_progress', 'completed', 'failed', 'cancelled'].includes(entry.status) ? entry.status : '',
      truncated: entry.truncated === true || content.length < (entry.text?.length || 0) || safeInput.length < (entry.input?.length || 0) });
    if (budget <= 0) break;
  }
  return result;
}

module.exports = { projectOutput, cleanProcess };
