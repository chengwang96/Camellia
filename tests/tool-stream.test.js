'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BufferedToolStream } = require('../src/api/buffered-tool-stream');
const { SSEParser, frame } = require('../src/api/api-protocol');
const { collectToolResults, failedToolResult } = require('../src/api/tool-results');
const { RequestScopes } = require('../src/api/request-scopes');

function fixture() {
  const events = [], parser = new SSEParser(event => events.push(event));
  const stream = new BufferedToolStream(data => parser.feed(Buffer.from(data)));
  const send = delta => stream.feed(frame({ id: 'reply', model: 'chosen', choices: [{ index: 0, delta }] }));
  return { events, stream, send };
}
test('Antigravity adapter streams text but buffers interleaved arguments, surrogate pairs and late signatures', () => {
  const { events, stream, send } = fixture();
  send({ role: 'assistant', content: 'Checking files' });
  assert.equal(events[0].choices[0].delta.content, 'Checking files');
  for (const index of [0, 1]) send({ tool_calls: [{ index, id: 'call' + index, type: 'function', function: { name: 'read', arguments: '' } }] });
  const inputs = ['{"path":"词🙂"}', '{"path":"other"}'];
  for (let i = 0; i < Math.max(...inputs.map(input => input.length)); i++) for (const index of [0, 1]) {
    if (inputs[index][i]) send({ tool_calls: [{ index, function: { arguments: inputs[index][i] } }] });
  }
  send({ tool_calls: [{ index: 1, extra_content: { google: { thought_signature: 'opaque' } } }] });
  stream.feed(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
  const usage = { prompt_tokens: 20, completion_tokens: 8 };
  stream.feed(frame({ choices: [], usage }));
  assert.equal(events.flatMap(e => e.choices || []).some(c => c.delta?.tool_calls), false, 'No execution before terminal marker');
  stream.feed(frame('[DONE]'));
  const calls = events.flatMap(e => e.choices || []).flatMap(c => c.delta?.tool_calls || []);
  assert.deepEqual(calls.map(call => call.id), ['call0', 'call1']);
  assert.deepEqual(calls.map(call => JSON.parse(call.function.arguments)), [{ path: '词🙂' }, { path: 'other' }]);
  assert.equal(calls[1].extra_content.google.thought_signature, 'opaque');
  assert.deepEqual(events.at(-2).usage, usage);
  assert.equal(events.at(-3).choices[0].finish_reason, 'tool_calls');
  assert.equal(events.at(-1), '[DONE]');
});

test('Antigravity adapter never releases truncated or malformed arguments as executable tools', () => {
  const { events, stream, send } = fixture();
  send({ tool_calls: [{ index: 0, id: 'bad', function: { name: 'write', arguments: '{"path":' } }] });
  assert.equal(events.length, 0);
  assert.throws(() => stream.feed(frame('[DONE]')));
  assert.equal(events.length, 0);
});

test('Tool diagnostics identify native failures without treating successfully read text as errors', () => {
  assert.equal(failedToolResult('read', 'Exit code: 7\nError in a sample log'), false);
  assert.equal(failedToolResult('pwsh', 'output\n[exit code: 0]'), false);
  assert.equal(failedToolResult('pwsh', 'output\n[exit code: 7]'), true);
  assert.equal(failedToolResult('run_command', '\nThe command exited with code 7.\nOutput:\nx'), true);
  assert.equal(failedToolResult('Bash', '<system>ERROR: Tool execution failed.</system>\nx'), true);
  assert.equal(failedToolResult('apply_patch', 'apply_patch verification failed: no match'), true);
  assert.equal(failedToolResult('Read', 'documentation mentions error and failure'), false);
  const body = { messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'edit', name: 'edit', input: { file_path: 'x' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit', is_error: true, content: [{ type: 'text', text: 'missing' }] }] },
  ] };
  const results = collectToolResults(body, 'anthropic');
  assert.equal(results[0].is_error, true); assert.equal(results[0].input.file_path, 'x');
  const observed = [], scope = new RequestScopes().create({ onToolResult: result => observed.push(result) });
  scope.scope.observeTools(body, 'anthropic'); scope.scope.observeTools(body, 'anthropic');
  assert.equal(observed.length, 1, 'Replayed history does not duplicate failures');
  scope.close(); scope.scope.observeTools(body, 'anthropic'); assert.equal(observed.length, 1);
});
