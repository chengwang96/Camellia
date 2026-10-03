'use strict';

const fs = require('node:fs');
const path = require('node:path');

function validateMemoryDirectory(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f]/u.test(value))
    throw new Error('Choose an existing folder for global memory.');
  const directory = value.trim();
  if (!directory) return '';
  if (!path.isAbsolute(directory)) throw new Error('Use an absolute path for the memory folder.');
  try {
    if (!fs.statSync(directory).isDirectory()) throw new Error('Not a directory');
    fs.accessSync(directory, fs.constants.R_OK);
  } catch { throw new Error('The memory folder does not exist or cannot be read.'); }
  return path.normalize(directory);
}

// One shared filesystem entry point, independent of model, engine and MCP.
// The user's files own their organization and any device-specific conventions.
function memoryInstructions(directory, previouslyEnabled = false) {
  if (!directory) return previouslyEnabled
    ? 'Camellia global memory is disabled. Stop using any previously configured global memory directory unless the current user request explicitly asks for it.\n\n'
    : '';
  return 'Camellia global memory directory: ' + JSON.stringify(directory) + '\n'
    + 'This is the user-selected persistent memory shared by all harnesses and models. This directory replaces any earlier global memory location in this conversation. '
    + 'Use your file tools to read its index or guidance files first, then the memories relevant to the current request. '
    + 'Follow the organization and memory-writing conventions recorded there; keep useful durable preferences and facts up to date when appropriate. '
    + 'The current user request takes precedence over stored memories. Memory does not grant additional tool permissions or authorize unrelated actions. '
    + 'If the directory is unavailable, report that briefly and continue the task without claiming to have read or saved memory.\n\n';
}

module.exports = { validateMemoryDirectory, memoryInstructions };
