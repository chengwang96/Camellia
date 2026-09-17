'use strict';

const { StringDecoder } = require('node:string_decoder');
const { randomUUID } = require('node:crypto');
const unsupported = type => { throw new Error(`Protocol conversion for this route does not support ${type}. Configure a native protocol route for the same model.`); };
const list = content => typeof content === 'string' ? [{ type: 'text', text: content }] : (content || []);
const textOnly = content => list(content).map(b => b.type === 'text' ? b.text : unsupported(b.type)).join('\n');

function toOpenAIContent(content) {
  if (typeof content === 'string') return content;
  const parts = list(content).map(b => {
    if (b.type === 'text') return { type: 'text', text: b.text };
    if (b.type === 'image' && b.source?.type === 'base64') return { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } };
    if (b.type === 'image' && b.source?.type === 'url') return { type: 'image_url', image_url: { url: b.source.url } };
    return unsupported(b.type);
  });
  return parts.every(p => p.type === 'text') ? parts.map(p => p.text).join('\n') : parts;
}
function toAnthropicContent(content) {
  return list(content).map(b => {
    if (b.type === 'text') return { type: 'text', text: b.text };
    if (b.type === 'image_url') {
      const url = b.image_url?.url || b.image_url;
      const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
      return { type: 'image', source: match ? { type: 'base64', media_type: match[1], data: match[2] } : { type: 'url', url } };
    }
    return unsupported(b.type);
  });
}

function anthropicToOpenAI(body) {
  const messages = [];
  if (body.system) messages.push({ role: 'system', content: textOnly(body.system) });
  for (const m of body.messages || []) {
    if (m.role === 'assistant') {
      const blocks = list(m.content);
      const tools = blocks.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
      const reasoning = blocks.filter(b => b.type === 'thinking').map(b => b.thinking).join('');
      const content = toOpenAIContent(blocks.filter(b => !['tool_use', 'thinking'].includes(b.type)));
      messages.push({ role: 'assistant', content, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(tools.length ? { tool_calls: tools } : {}) });
    } else {
      let pending = [];
      const flush = () => { if (pending.length) messages.push({ role: m.role, content: toOpenAIContent(pending) }); pending = []; };
      for (const b of list(m.content)) {
        if (b.type === 'tool_result') {
          flush();
          let content = toOpenAIContent(b.content || '');
          if (b.is_error) content = typeof content === 'string' ? 'Tool error: ' + content : [{ type: 'text', text: 'Tool error:' }, ...content];
          messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content });
        } else pending.push(b);
      }
      flush();
    }
  }
  const out = { model: body.model, messages, stream: !!body.stream };
  for (const k of ['max_tokens', 'temperature', 'top_p']) if (body[k] !== undefined) out[k] = body[k];
  if (body.stop_sequences) out.stop = body.stop_sequences;
  if (body.tools?.length) out.tools = body.tools.map(t => {
    if (!t.name || !t.input_schema) return unsupported(t.type || 'server tool');
    return { type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema } };
  });
  if (body.tool_choice) {
    const t = body.tool_choice;
    out.tool_choice = t.type === 'tool' ? { type: 'function', function: { name: t.name } } : t.type === 'any' ? 'required' : t.type;
    if (t.disable_parallel_tool_use !== undefined) out.parallel_tool_calls = !t.disable_parallel_tool_use;
  }
  if (body.thinking) out.thinking = { type: body.thinking.type === 'disabled' ? 'disabled' : 'enabled' };
  if (body.output_config?.effort) out.reasoning_effort = body.output_config.effort;
  if (body.output_config?.format?.type === 'json_schema') out.response_format = { type: 'json_schema', json_schema: { name: 'response', schema: body.output_config.format.schema } };
  if (out.stream) out.stream_options = { include_usage: true };
  return out;
}

function openAIToAnthropic(body) {
  const out = { model: body.model, messages: [], max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 8192, stream: !!body.stream };
  const system = [];
  for (const m of body.messages || []) {
    if (['developer', 'system'].includes(m.role)) { system.push(...toAnthropicContent(m.content)); continue; }
    if (m.role === 'tool') { out.messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: toAnthropicContent(m.content) }] }); continue; }
    const content = toAnthropicContent(m.content);
    if (m.reasoning_content) content.unshift({ type: 'thinking', thinking: m.reasoning_content, signature: '' });
    for (const t of m.tool_calls || []) {
      if (t.type !== 'function') unsupported(t.type);
      content.push({ type: 'tool_use', id: t.id, name: t.function.name, input: JSON.parse(t.function.arguments || '{}') });
    }
    out.messages.push({ role: m.role, content });
  }
  if (system.length) out.system = system;
  for (const k of ['temperature', 'top_p']) if (body[k] !== undefined) out[k] = body[k];
  if (body.stop) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.tools?.length) out.tools = body.tools.map(t => {
    if (t.type !== 'function') return unsupported(t.type);
    return { name: t.function.name, description: t.function.description || '', input_schema: t.function.parameters || { type: 'object', properties: {} } };
  });
  if (body.tool_choice) out.tool_choice = typeof body.tool_choice === 'string'
    ? { type: body.tool_choice === 'required' ? 'any' : body.tool_choice }
    : { type: 'tool', name: body.tool_choice.function.name };
  if (body.parallel_tool_calls === false) out.tool_choice = { ...(out.tool_choice || { type: 'auto' }), disable_parallel_tool_use: true };
  if (body.thinking) out.thinking = body.thinking;
  if (body.reasoning_effort) out.output_config = { effort: body.reasoning_effort };
  if (body.response_format && body.response_format.type !== 'text') unsupported('OpenAI response_format');
  if (body.n && body.n !== 1) unsupported('n > 1');
  return out;
}

function convertRequest(body, from, to) {
  if (from !== to) return from === 'anthropic' ? anthropicToOpenAI(body) : openAIToAnthropic(body);
  const result = structuredClone(body);
  if (to === 'openai') {
    for (const m of result.messages || []) if (m.role === 'developer') m.role = 'system';
    if (result.stream) result.stream_options = { ...result.stream_options, include_usage: true };
  }
  return result;
}

function openUsage(u = {}) {
  return { prompt_tokens: Number(u.input_tokens || 0) + Number(u.cache_read_input_tokens || 0) + Number(u.cache_creation_input_tokens || 0),
    completion_tokens: Number(u.output_tokens || 0),
    prompt_tokens_details: { cached_tokens: Number(u.cache_read_input_tokens || 0) } };
}
function anthropicUsage(u = {}) {
  const cached = Number(u.prompt_tokens_details?.cached_tokens || 0);
  return { input_tokens: Math.max(0, Number(u.prompt_tokens || 0) - cached), output_tokens: Number(u.completion_tokens || 0), cache_read_input_tokens: cached };
}
const stopToA = reason => ({ tool_calls: 'tool_use', length: 'max_tokens', stop: 'end_turn', content_filter: 'refusal' }[reason] || 'end_turn');
const stopToO = reason => ({ tool_use: 'tool_calls', max_tokens: 'length' }[reason] || 'stop');
function convertResponse(body, from, to, model) {
  if (from === 'openai' ? !body?.choices?.[0]?.message || typeof body.choices[0].message !== 'object'
    : body?.role !== 'assistant' || !Array.isArray(body.content)) throw new Error("The provider returned an invalid model response");
  if (from === to) return { ...body, model };
  if (to === 'anthropic') {
    const choice = body.choices[0];
    const m = choice.message;
    const content = [];
    if (m.reasoning_content) content.push({ type: 'thinking', thinking: m.reasoning_content, signature: '' });
    if (m.content) content.push(...toAnthropicContent(m.content));
    for (const t of m.tool_calls || []) content.push({ type: 'tool_use', id: t.id, name: t.function.name, input: JSON.parse(t.function.arguments || '{}') });
    return { id: body.id || 'msg_' + randomUUID(), type: 'message', role: 'assistant', model, content, stop_reason: stopToA(choice.finish_reason), stop_sequence: null, usage: anthropicUsage(body.usage) };
  }
  const m = anthropicToOpenAI({ messages: [{ role: 'assistant', content: body.content }] }).messages[0];
  const usage = openUsage(body.usage);
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  return { id: body.id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: m, finish_reason: stopToO(body.stop_reason) }], usage };
}

// Parse frames across TCP/UTF-8 boundaries; never assume a chunk is a whole event.
class SSEParser {
  constructor(onFrame) { this.decoder = new StringDecoder('utf8'); this.buffer = ''; this.onFrame = onFrame; }
  feed(chunk) { this.buffer += this.decoder.write(chunk); this.drain(); }
  end() { this.buffer += this.decoder.end(); this.drain(); if (this.buffer.trim()) this.frame(this.buffer); this.buffer = ''; }
  drain() {
    let match;
    while ((match = /\r?\n\r?\n/.exec(this.buffer))) {
      const frame = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.frame(frame);
    }
    if (this.buffer.length > 16 * 1024 * 1024) throw new Error("SSE event exceeded the size limit");
  }
  frame(raw) {
    let event = '';
    const data = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length) {
      const value = data.join('\n');
      this.onFrame(value === '[DONE]' ? '[DONE]' : JSON.parse(value), event);
    }
  }
}
const frame = (obj, event = '') => (event ? `event: ${event}\n` : '') + `data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`;

class StreamConverter {
  constructor(from, to, model, write) {
    Object.assign(this, { from, to, model, write, started: false, done: false, blocks: new Map(), usage: {}, finish: 'stop', id: 'msg_' + randomUUID() });
  }
  a(type, fields = {}) { this.write(frame({ type, ...fields }, type)); }
  o(delta, finish = null, usage) {
    this.write(frame({ id: this.id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: this.model,
      choices: usage ? [] : [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) }));
  }
  block(key, content) {
    if (!this.blocks.has(key)) {
      const index = this.blocks.size;
      this.blocks.set(key, index);
      this.a('content_block_start', { index, content_block: content });
    }
    return this.blocks.get(key);
  }
  push(obj, event) {
    if (this.done) return;
    if (obj === '[DONE]') { this.end(); return; }
    if (obj.error || obj.type === 'error') throw new Error("The upstream service returned an error while streaming");
    if (this.from === this.to) {
      if (obj.model) obj = { ...obj, model: this.model };
      if (obj.message?.model) obj = { ...obj, message: { ...obj.message, model: this.model } };
      this.write(frame(obj, event));
      if (obj.type === 'message_stop') this.done = true;
      return;
    }
    if (this.to === 'anthropic') {
      if (!this.started) {
        this.started = true;
        this.a('message_start', { message: { id: this.id, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: anthropicUsage(obj.usage) } });
      }
      if (obj.usage) this.usage = { ...this.usage, ...obj.usage };
      const choice = obj.choices?.[0];
      const delta = choice?.delta || {};
      if (delta.reasoning_content) {
        const index = this.block('thinking', { type: 'thinking', thinking: '', signature: '' });
        this.a('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: delta.reasoning_content } });
      }
      if (delta.content) {
        const index = this.block('text', { type: 'text', text: '' });
        this.a('content_block_delta', { index, delta: { type: 'text_delta', text: delta.content } });
      }
      for (const t of delta.tool_calls || []) {
        const key = 'tool-' + t.index;
        if (!this.blocks.has(key) && (!t.id || !t.function?.name)) throw new Error("Tool call is missing an ID or name");
        const index = this.block(key, { type: 'tool_use', id: t.id, name: t.function?.name, input: {} });
        if (t.function?.arguments) this.a('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: t.function.arguments } });
      }
      if (choice?.finish_reason) this.finish = choice.finish_reason;
    } else {
      if (obj.type === 'message_start') {
        this.id = obj.message.id;
        this.usage = { ...obj.message.usage };
        this.o({ role: 'assistant', content: '' });
      } else if (obj.type === 'content_block_start') {
        const b = obj.content_block;
        if (b.type === 'tool_use') {
          const index = this.blocks.size;
          this.blocks.set(obj.index, index);
          this.o({ tool_calls: [{ index, id: b.id, type: 'function', function: { name: b.name, arguments: Object.keys(b.input || {}).length ? JSON.stringify(b.input) : '' } }] });
        } else if (b.type === 'text' && b.text) this.o({ content: b.text });
        else if (b.type === 'thinking' && b.thinking) this.o({ reasoning_content: b.thinking });
        else if (!['text', 'thinking'].includes(b.type)) unsupported(b.type);
      } else if (obj.type === 'content_block_delta') {
        const d = obj.delta;
        if (d.type === 'text_delta') this.o({ content: d.text });
        else if (d.type === 'thinking_delta') this.o({ reasoning_content: d.thinking });
        else if (d.type === 'input_json_delta') this.o({ tool_calls: [{ index: this.blocks.get(obj.index), function: { arguments: d.partial_json } }] });
      } else if (obj.type === 'message_delta') {
        this.usage = { ...this.usage, ...obj.usage };
        this.finish = stopToO(obj.delta?.stop_reason);
      } else if (obj.type === 'message_stop') this.end();
    }
  }
  end() {
    if (this.done) return;
    this.done = true;
    if (this.from === this.to) { if (this.to === 'openai') this.write(frame('[DONE]')); return; }
    if (this.to === 'anthropic') {
      for (const index of this.blocks.values()) this.a('content_block_stop', { index });
      this.a('message_delta', { delta: { stop_reason: stopToA(this.finish), stop_sequence: null }, usage: anthropicUsage(this.usage) });
      this.a('message_stop');
    } else {
      this.o({}, this.finish);
      const usage = openUsage(this.usage);
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
      this.o({}, null, usage);
      this.write(frame('[DONE]'));
    }
  }
}

module.exports = { convertRequest, convertResponse, SSEParser, StreamConverter, frame };
