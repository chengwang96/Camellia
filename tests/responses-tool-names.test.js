'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { responsesToChat, ResponsesStream, chatToResponse } = require('../src/api/responses-protocol');

function setup(tools) {
  const converted = responsesToChat({ model: 'mimo-v2.6-pro', input: 'Run a diagnostic.', tools });
  return { ...converted, converter: new ResponsesStream('openai', 'mimo-v2.6-pro', converted.tools, () => {}) };
}

const commandTool = { type: 'function', name: 'exec_command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } };
const namespace = (name, tools = [commandTool]) => ({ type: 'namespace', name, tools });
const toolDelta = (name, args = '', id = 'call-diagnostic') => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] } }] });

test('MiMo unqualified streamed tool names restore the unique Responses namespace', () => {
  const { body, converter } = setup([namespace('functions')]);
  assert.equal(body.tools[0].function.name, 'functions__exec_command');
  converter.push(toolDelta('exec_command'));
  converter.push(toolDelta(null, '{"cmd":', null));
  converter.push(toolDelta(null, '"pwd"}', null));
  converter.push('[DONE]');
  assert.equal(converter.response.status, 'completed');
  const call = converter.response.output[0];
  assert.equal(call.name, 'exec_command');
  assert.equal(call.namespace, 'functions');
  assert.equal(call.call_id, 'call-diagnostic');
  assert.deepEqual(JSON.parse(call.arguments), { cmd: 'pwd' });
  const continuation = responsesToChat({ model: 'mimo-v2.6-pro', input: [call, { type: 'function_call_output', call_id: call.call_id, output: 'workspace' }], tools: [namespace('functions')] });
  assert.equal(continuation.body.messages[0].tool_calls[0].function.name, 'functions__exec_command');
});

test('non-streaming MiMo custom tool names retain namespace and decode input', () => {
  const { tools } = setup([namespace('functions', [{ type: 'custom', name: 'apply_patch' }])]);
  const response = chatToResponse({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'patch-call', type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify({ input: '*** Begin Patch\n*** End Patch' }) } }] }, finish_reason: 'tool_calls' }] }, 'openai', 'mimo-v2.6-pro', tools);
  assert.equal(response.output[0].type, 'custom_tool_call');
  assert.equal(response.output[0].namespace, 'functions');
  assert.equal(response.output[0].input, '*** Begin Patch\n*** End Patch');
});

test('ambiguous or unknown unqualified tool names are never guessed', () => {
  const { converter } = setup([namespace('functions'), namespace('other')]);
  assert.throws(() => converter.push(toolDelta('exec_command')), /unknown tool/);
  assert.throws(() => converter.push(toolDelta('not_registered')), /unknown tool/);
  converter.push(toolDelta('other__exec_command', '{}'));
  converter.end();
  assert.equal(converter.response.output[0].namespace, 'other');
});

test('an exact unqualified tool name takes precedence over namespace fallback', () => {
  const { converter } = setup([namespace('functions'), commandTool]);
  converter.push(toolDelta('exec_command', '{}'));
  converter.end();
  assert.equal(converter.response.output[0].name, 'exec_command');
  assert.equal(converter.response.output[0].namespace, undefined);
});
