'use strict';
const { SSEParser, frame } = require('./api-protocol');
const ANTIGRAVITY_API_TOOL_PROFILE = 'buffered-tool-arguments-v1';

// Antigravity SDK 0.1.16's OpenAI transport corrupts interleaved tool deltas
// and separately decoded UTF-16 surrogates. Give it all complete calls in one
// delta, after the upstream terminal marker; keep ordinary text streaming.
// This is an opt-in client adapter, not a change to the provider or tool schema.
class BufferedToolStream {
  constructor(write) {
    this.write = write;
    this.calls = new Map();
    this.tail = [];
    this.bytes = 0;
    this.parser = new SSEParser((obj, event) => this.push(obj, event));
  }
  feed(data) { this.parser.feed(Buffer.from(data)); }
  push(obj, event) {
    if (obj === '[DONE]') {
      if (this.calls.size) {
        const choices = [...this.calls].map(([index, calls]) => ({ index, delta: { tool_calls: [...calls.values()] }, finish_reason: null }));
        for (const choice of choices) for (const call of choice.delta.tool_calls) {
          if (!call.id || !call.function.name) throw new Error('Incomplete streamed tool identity');
          JSON.parse(call.function.arguments); // Do not execute truncated arguments.
        }
        this.write(frame({ ...this.envelope, choices }));
      }
      for (const item of this.tail) this.write(item);
      this.write(frame(obj, event));
      return;
    }
    const copy = structuredClone(obj);
    for (const choice of copy.choices || []) {
      if (!choice.delta?.tool_calls?.length) continue;
      const { choices: _choices, usage: _usage, ...envelope } = copy;
      this.envelope = envelope;
      let calls = this.calls.get(choice.index);
      if (!calls) { calls = new Map(); this.calls.set(choice.index, calls); }
      for (const delta of choice.delta.tool_calls) {
        this.bytes += Buffer.byteLength(JSON.stringify(delta));
        if (this.bytes > 16 * 1024 * 1024) throw new Error('Streamed tool calls exceeded the size limit');
        const previous = calls.get(delta.index) || { index: delta.index, id: '', type: 'function', function: { name: '', arguments: '' } };
        calls.set(delta.index, { ...previous, ...delta, id: previous.id + (delta.id || ''), function: {
          ...previous.function, ...delta.function,
          name: previous.function.name + (delta.function?.name || ''),
          arguments: previous.function.arguments + (delta.function?.arguments || ''),
        } });
      }
      delete choice.delta.tool_calls;
    }
    if (!copy.usage && copy.choices?.length && copy.choices.every(choice => !choice.finish_reason && choice.delta && !Object.keys(choice.delta).length)) return;
    const encoded = frame(copy, event);
    if (this.tail.length || (this.calls.size && copy.choices?.some(choice => choice.finish_reason))) {
      this.bytes += Buffer.byteLength(encoded);
      if (this.bytes > 16 * 1024 * 1024) throw new Error('Streamed tool calls exceeded the size limit');
      this.tail.push(encoded);
    } else this.write(encoded);
  }
}
module.exports = { BufferedToolStream, ANTIGRAVITY_API_TOOL_PROFILE };
