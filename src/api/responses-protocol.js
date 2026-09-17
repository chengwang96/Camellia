'use strict';
const { randomUUID } = require('node:crypto');
const { StreamConverter, SSEParser, frame, convertResponse } = require('./api-protocol');

// Codex sends the full conversation over Responses. Adapt it to the existing
// same-model router; credentials, retries and usage accounting stay there.
function responseTools(tools = []) {
  return tools.flatMap(tool => tool.type === 'namespace'
    ? tool.tools.map(t => ({ ...t, namespace: tool.name })) : [tool]);
}
const wireName = tool => tool.namespace ? `${tool.namespace}__${tool.name}` : tool.name;
function responsesToChat(body) {
  if (body.previous_response_id) throw new Error('The shared router requires full Responses input, without previous_response_id');
  const tools = responseTools(body.tools), byName = new Map(tools.map(t => [wireName(t), t]));
  const messages = body.instructions ? [{ role: 'system', content: body.instructions }] : [];
  const content = value => typeof value === 'string' ? value : (value || []).map(part => {
    if (['input_text', 'output_text', 'text'].includes(part.type)) return { type: 'text', text: part.text };
    if (part.type === 'input_image') return { type: 'image_url', image_url: { url: part.image_url, ...(part.detail ? { detail: part.detail } : {}) } };
    if (part.type === 'refusal') return { type: 'text', text: part.refusal };
    throw new Error('Unsupported Responses content: ' + part.type);
  });
  const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input || [];
  let reasoning = '';
  const assistant = () => {
    let message = messages.at(-1);
    if (message?.role !== 'assistant') { message = { role: 'assistant', content: '' }; messages.push(message); }
    if (reasoning) { message.reasoning_content = (message.reasoning_content || '') + reasoning; reasoning = ''; }
    return message;
  };
  for (const item of input) {
    if (item.type === 'reasoning') {
      reasoning += (item.summary || []).map(part => part.text || '').join('');
      continue;
    }
    if (['function_call', 'custom_tool_call'].includes(item.type)) {
      const name = item.namespace ? `${item.namespace}__${item.name}` : item.name;
      (assistant().tool_calls ||= []).push({ id: item.call_id, type: 'function',
        function: { name, arguments: item.type === 'custom_tool_call' ? JSON.stringify({ input: item.input }) : item.arguments } });
    } else if (['function_call_output', 'custom_tool_call_output'].includes(item.type)) {
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: content(item.output) });
    } else if (item.role === 'assistant') assistant().content = content(item.content);
    else if (item.role) { reasoning = ''; messages.push({ role: item.role, content: content(item.content) }); }
    else throw new Error('Unsupported Responses input: ' + item.type);
  }
  const result = { model: body.model, messages, stream: Boolean(body.stream) };
  if (tools.length) result.tools = tools.map(tool => {
    if (!['function', 'custom'].includes(tool.type)) throw new Error('The shared route does not support this Responses tool: ' + tool.type);
    const description = tool.type === 'custom'
      ? (tool.description || '').replace('This is a FREEFORM tool, so do not wrap the patch in JSON.', '').trim()
        + '\nCall this function with an input string containing the complete raw tool input. The JSON input wrapper is decoded before the native tool executes; preserve all newlines and quotes inside the string.'
      : tool.description || '';
    return { type: 'function', function: { name: wireName(tool), description,
      parameters: tool.type === 'custom' ? { type: 'object', properties: { input: { type: 'string', description: 'The complete raw tool input' } }, required: ['input'], additionalProperties: false } : tool.parameters } };
  });
  if (body.tool_choice) result.tool_choice = typeof body.tool_choice === 'string' ? body.tool_choice : {
    type: 'function', function: { name: wireName(body.tool_choice) } };
  for (const key of ['temperature', 'top_p', 'parallel_tool_calls']) if (body[key] !== undefined) result[key] = body[key];
  if (body.max_output_tokens) result.max_tokens = body.max_output_tokens;
  if (body.reasoning?.effort && body.reasoning.effort !== 'none') result.reasoning_effort = body.reasoning.effort;
  if (body.text?.format?.type === 'json_schema') {
    const { type, ...schema } = body.text.format; result.response_format = { type, json_schema: schema };
  }
  if (result.stream) result.stream_options = { include_usage: true };
  return { body: result, tools: byName };
}

class ResponsesStream {
  constructor(source, model, tools, write) {
    Object.assign(this, { model, tools, write });
    this.response = { id: 'resp_' + randomUUID(), object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model, output: [] };
    this.calls = new Map(); this.sequence = 0; this.usage = {};
    if (source === 'anthropic') {
      const parser = new SSEParser(obj => this.chat(obj));
      this.converter = new StreamConverter('anthropic', 'openai', model, data => parser.feed(Buffer.from(data)));
    }
  }
  event(type, data) { this.write(frame({ type, sequence_number: this.sequence++, ...data }, type)); }
  add(item) {
    const index = this.response.output.length; this.response.output.push(item);
    this.event('response.output_item.added', { output_index: index, item: structuredClone(item) }); return index;
  }
  push(obj, event) { if (this.converter) this.converter.push(obj, event); else this.chat(obj); }
  chat(obj) {
    if (this.done) return;
    if (obj === '[DONE]') { this.end(); return; }
    if (!this.started) { this.started = true; this.event('response.created', { response: { ...this.response, output: [] } }); }
    if (obj.usage) this.usage = { ...this.usage, ...obj.usage };
    const choice = obj.choices?.[0]; if (!choice) return;
    if (choice.finish_reason === 'length' || choice.finish_reason === 'content_filter') this.incomplete = choice.finish_reason;
    const delta = choice.delta || {};
    if (delta.reasoning_content) {
      if (this.reasoningIndex === undefined) {
        this.reasoningIndex = this.add({ id: 'rs_' + randomUUID(), type: 'reasoning', summary: [] });
        const item = this.response.output[this.reasoningIndex];
        item.summary.push({ type: 'summary_text', text: '' });
        this.event('response.reasoning_summary_part.added', { item_id: item.id, output_index: this.reasoningIndex, summary_index: 0, part: { type: 'summary_text', text: '' } });
      }
      const item = this.response.output[this.reasoningIndex]; item.summary[0].text += delta.reasoning_content;
      this.event('response.reasoning_summary_text.delta', { item_id: item.id, output_index: this.reasoningIndex, summary_index: 0, delta: delta.reasoning_content });
    }
    if (delta.content) {
      if (this.textIndex === undefined) {
        this.textIndex = this.add({ id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', status: 'in_progress', content: [] });
        this.response.output[this.textIndex].content.push({ type: 'output_text', text: '', annotations: [] });
        this.event('response.content_part.added', { item_id: this.response.output[this.textIndex].id, output_index: this.textIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      }
      const item = this.response.output[this.textIndex]; item.content[0].text += delta.content;
      this.event('response.output_text.delta', { item_id: item.id, output_index: this.textIndex, content_index: 0, delta: delta.content });
    }
    for (const call of delta.tool_calls || []) {
      let state = this.calls.get(call.index);
      if (!state) {
        const tool = this.tools.get(call.function?.name);
        if (!tool) throw new Error('The provider returned an unknown tool: ' + call.function?.name);
        const custom = tool.type === 'custom';
        const item = { id: 'fc_' + randomUUID(), type: custom ? 'custom_tool_call' : 'function_call', call_id: call.id || 'call_' + randomUUID(),
          name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}), status: 'in_progress', [custom ? 'input' : 'arguments']: '' };
        state = { item, custom, index: this.add(item), arguments: '' }; this.calls.set(call.index, state);
      }
      const text = call.function?.arguments || ''; state.arguments += text;
      if (!state.custom && text) this.event('response.function_call_arguments.delta', { item_id: state.item.id, output_index: state.index, delta: text });
    }
  }
  end() {
    if (this.done) return;
    // Anthropic conversion calls back with [DONE] from end().
    if (this.converter && !this.ending) { this.ending = true; this.converter.end(); }
    if (this.done) return;
    for (const state of this.calls.values()) {
      const field = state.custom ? 'input' : 'arguments';
      state.item[field] = state.custom ? JSON.parse(state.arguments).input : state.arguments;
      if (typeof state.item[field] !== 'string') throw new Error('The provider returned invalid custom tool input');
      if (state.custom) this.event('response.custom_tool_call_input.delta', { item_id: state.item.id, output_index: state.index, delta: state.item.input });
      this.event(state.custom ? 'response.custom_tool_call_input.done' : 'response.function_call_arguments.done',
        { item_id: state.item.id, output_index: state.index, [field]: state.item[field] });
    }
    this.response.output.forEach((item, index) => {
      item.status = 'completed';
      if (item.type === 'message') {
        this.event('response.output_text.done', { item_id: item.id, output_index: index, content_index: 0, text: item.content[0].text });
        this.event('response.content_part.done', { item_id: item.id, output_index: index, content_index: 0, part: item.content[0] });
      } else if (item.type === 'reasoning') {
        this.event('response.reasoning_summary_text.done', { item_id: item.id, output_index: index, summary_index: 0, text: item.summary[0].text });
        this.event('response.reasoning_summary_part.done', { item_id: item.id, output_index: index, summary_index: 0, part: item.summary[0] });
      }
      this.event('response.output_item.done', { output_index: index, item });
    });
    this.response.status = this.incomplete ? 'incomplete' : 'completed';
    if (this.incomplete) this.response.incomplete_details = { reason: this.incomplete === 'length' ? 'max_output_tokens' : 'content_filter' };
    this.response.usage = { input_tokens: this.usage.prompt_tokens || 0, output_tokens: this.usage.completion_tokens || 0,
      total_tokens: (this.usage.prompt_tokens || 0) + (this.usage.completion_tokens || 0),
      input_tokens_details: { cached_tokens: this.usage.prompt_tokens_details?.cached_tokens || 0 }, output_tokens_details: { reasoning_tokens: this.usage.completion_tokens_details?.reasoning_tokens || 0 } };
    this.event('response.' + this.response.status, { response: this.response }); this.done = true;
  }
  fail(message) {
    if (this.done) return;
    this.response.status = 'failed'; this.response.error = { code: 'server_error', message };
    this.event('response.failed', { response: this.response }); this.done = true;
  }
}
function chatToResponse(body, source, model, tools) {
  const chat = convertResponse(body, source, 'openai', model);
  const converter = new ResponsesStream('openai', model, tools, () => {});
  converter.chat({ choices: [{ delta: { ...chat.choices[0].message, tool_calls: chat.choices[0].message.tool_calls?.map((t, index) => ({ ...t, index })) }, finish_reason: chat.choices[0].finish_reason }], usage: chat.usage });
  converter.end(); return converter.response;
}
module.exports = { responsesToChat, ResponsesStream, chatToResponse };
