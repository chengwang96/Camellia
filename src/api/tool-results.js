'use strict';

const resultText = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(part => part.type === 'text').map(part => part.text || '').join('\n')
    : content == null ? '' : JSON.stringify(content);

// Use explicit native error envelopes, not words such as "error" found in a
// successfully read file. Shell exit formats are limited to shell tools.
function failedToolResult(name, output, explicit = false) {
  if (explicit) return true;
  if (/^(?:Tool error: |<tool_use_error>|<system>ERROR: Tool execution failed\.<\/system>|Error invalid tool call:)/.test(output)) return true;
  if (name === 'apply_patch' && /^(?:apply_patch verification failed:|Invalid patch:|Failed to apply patch)/.test(output)) return true;
  const exit = name === 'pwsh' ? /\[exit code: (-?\d+)\]\s*$/.exec(output)
    : ['shell_command', 'exec_command', 'run_command', 'Bash'].includes(name)
      ? /^\s*(?:Exit code: ?|The command exited with code |Process exited with code )(-?\d+)/.exec(output) : null;
  return Boolean(exit && Number(exit[1]) !== 0);
}

function collectToolResults(body, protocol) {
  const calls = new Map(), results = [];
  const call = (id, name, input) => calls.set(id, { id, name, input });
  const result = (id, value, is_error) => {
    const tool = calls.get(id); if (!tool) return;
    const output = resultText(value);
    const failed = failedToolResult(tool.name, output, is_error);
    results.push({ ...tool, output, is_error: failed, status: failed ? 'failed' : 'completed' });
  };
  if (protocol === 'responses') {
    for (const item of Array.isArray(body.input) ? body.input : []) {
      if (['function_call', 'custom_tool_call'].includes(item.type)) call(item.call_id, item.name, item.arguments ?? item.input);
      else if (['function_call_output', 'custom_tool_call_output'].includes(item.type)) result(item.call_id, item.output);
    }
  } else for (const message of body.messages || []) {
    if (protocol === 'anthropic') {
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type === 'tool_use') call(block.id, block.name, block.input);
        else if (block.type === 'tool_result') result(block.tool_use_id, block.content, block.is_error);
      }
    } else {
      for (const tool of message.tool_calls || []) call(tool.id, tool.function?.name, tool.function?.arguments);
      if (message.role === 'tool') result(message.tool_call_id, message.content);
    }
  }
  return results;
}
module.exports = { collectToolResults, failedToolResult };
