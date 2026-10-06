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
  const live = projectOutput(events);
  assert.equal(live.text, 'Checking the project');
  assert.deepEqual(live.process.map(entry => entry.type), ['thinking', 'tool']);
  events.push({ type: 'gui:tool', id: 'tool1', output: 'test', status: 'completed' },
    start(2, 'text'), delta(2, 'text', 'Final reply'), { type: 'gui:message-phase', index: 2, phase: 'final_answer' });
  const output = projectOutput(events, true);
  assert.equal(output.text, 'Final reply');
  assert.equal(output.process.filter(entry => entry.type === 'tool').length, 1);
  assert.equal(output.process[2].status, 'completed'); assert.equal(output.process[2].text, 'test');
  assert.deepEqual(output.process.filter(entry => entry.type === 'text').map(entry => entry.text), ['Checking the project']);
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

test('mobile folds thinking delimiters out of the answer text', () => {
  const events = [start(0, 'text', 'final_answer'),
    delta(0, 'text', '<thinking>**Narrowing search**</thinking>\n我在查找论文原稿。')];
  const output = projectOutput(events, true);
  assert.equal(output.text, '\n我在查找论文原稿。');
  assert.deepEqual(output.process.filter(entry => entry.type === 'thinking').map(entry => entry.text),
    ['**Narrowing search**']);
});

test('mobile preserves answers that discuss reasoning tags as code', () => {
  const answer = 'It is the new `<thinking>` parser.\n\n```xml\n<thinking>example</thinking>\n```\nThe complete answer.';
  const events = [start(0, 'text', 'final_answer'), delta(0, 'text', answer)];
  for (const finished of [false, true]) {
    const output = projectOutput(events, finished);
    assert.equal(output.text, answer);
    assert.deepEqual(output.process, []);
  }
});

test('mobile keeps real reasoning separate without hiding code in the answer', () => {
  const answer = 'Use `<thinking>` in text. The complete answer.';
  const events = [start(0, 'text', 'final_answer'), delta(0, 'text', '<thinking>Actual reasoning.</thinking>' + answer)];
  const output = projectOutput(events, true);
  assert.equal(output.text, answer);
  assert.deepEqual(output.process.filter(entry => entry.type === 'thinking').map(entry => entry.text), ['Actual reasoning.']);
});

test('mobile shows only the latest native or tagged reasoning and retains tool history', () => {
  const events = [start(0, 'thinking'), delta(0, 'thinking', 'Older native reasoning'),
    { type: 'gui:tool', id: 'first', name: 'Read', output: 'Read output', status: 'completed' },
    start(1, 'text', 'commentary'), delta(1, 'text', '<thinking>Older tagged reasoning</thinking>Progress'),
    start(2, 'text', 'final_answer'), delta(2, 'text', '<thinking>Previous reasoning</thinking><thinking>Latest reasoning</thinking>Answer')];
  for (const finished of [false, true]) {
    const output = projectOutput(events, finished);
    assert.equal(output.text, 'Answer');
    assert.deepEqual(output.process.map(entry => entry.type), ['tool', 'text', 'thinking']);
    assert.equal(output.process.find(entry => entry.type === 'thinking').text, 'Latest reasoning');
    assert.equal(output.process.find(entry => entry.type === 'tool').text, 'Read output');
  }
  events.push(start(3, 'thinking'), delta(3, 'thinking', 'Newest native reasoning'),
    delta(0, 'thinking', ' delayed update'), start(4, 'text', 'final_answer'), delta(4, 'text', 'Final answer'));
  const output = projectOutput(events, true);
  assert.deepEqual(output.process.filter(entry => entry.type === 'thinking').map(entry => entry.text), ['Newest native reasoning']);
});

test('stored mobile process entries also show only the latest reasoning', () => {
  const output = cleanProcess([
    { type: 'thinking', text: 'Older reasoning' },
    { type: 'tool', title: 'Read', text: 'Read output' },
    { type: 'thinking', text: 'Latest reasoning' },
    { type: 'text', text: 'Progress' },
  ]);
  assert.deepEqual(output.map(entry => entry.type), ['tool', 'thinking', 'text']);
  assert.equal(output[1].text, 'Latest reasoning');
});
