'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { projectOutput, cleanProcess } = require('../src/shared/mobile-output');
const start = (index, type, phase) => ({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type, phase } } });
const delta = (index, type, value) => ({ type: 'stream_event', event: { type: 'content_block_delta', index,
  delta: type === 'thinking' ? { type: 'thinking_delta', thinking: value } : { type: 'text_delta', text: value } } });

test('mobile folding follows desktop commentary, thinking, tools and explicit final answers', () => {
  const events = [start(0, 'thinking'), delta(0, 'thinking', 'Published reasoning'),
    start(1, 'text', 'commentary'), delta(1, 'text', 'Checking the project'),
    { type: 'gui:tool', id: 'tool1', name: 'Shell', input: { command: 'echo test', cwd: 'private', apiKey: 'secret' }, status: 'in_progress' }];
  assert.equal(projectOutput(events).text, '');
  assert.equal(projectOutput(events).process.length, 3);
  events.push({ type: 'gui:tool', id: 'tool1', output: 'test', status: 'completed' },
    start(2, 'text'), delta(2, 'text', 'Final reply'), { type: 'gui:message-phase', index: 2, phase: 'final_answer' });
  const output = projectOutput(events, true);
  assert.equal(output.text, 'Final reply');
  assert.equal(output.process.filter(entry => entry.type === 'tool').length, 1);
  assert.equal(output.process[2].status, 'completed'); assert.equal(output.process[2].text, 'test');
  assert.ok(!JSON.stringify(output).includes('private')); assert.ok(!JSON.stringify(output).includes('secret'));
});

test('mobile stream snapshots coalesce final assistant envelopes and preserve process-only turns', () => {
  const events = [start(0, 'text', 'commentary'), delta(0, 'text', 'Progress'),
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Progress' }] } }];
  const output = projectOutput(events, true);
  assert.equal(output.text, ''); assert.equal(output.process.length, 1);
  const tools = projectOutput([{ type: 'tool_use', id: 'id', name: 'Read', input: { path: '/test' } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'id', content: [{ type: 'text', text: 'result' }] }] } }], true);
  assert.equal(tools.process.length, 1); assert.equal(tools.process[0].text, 'result');
});

test('mobile process excludes signatures and bounds output', () => {
  const output = cleanProcess([{ type: 'thinking', text: 'x'.repeat(200000), signature: 'secret-signature' },
    { type: 'redacted_thinking', text: 'private' }]);
  assert.equal(output.length, 1); assert.ok(JSON.stringify(output).length < 100000);
  assert.ok(!JSON.stringify(output).includes('secret-signature'));
});
