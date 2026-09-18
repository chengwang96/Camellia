'use strict';

// Three automation levels shared by every harness:
//   ask  — confirm before acting; only reads run on their own
//   auto — routine changes and commands run on their own; risky ones ask
//   full — never ask; every action and judgment runs on its own
// Engines keep accepting their native legacy values so saved configurations
// and tests stay valid; a level (or legacy value) maps to the closest native
// mode at the session boundary.
const LEVELS = ['ask', 'auto', 'full'];
const TO_NATIVE = {
  claude: { ask: 'default', auto: 'acceptEdits', full: 'bypassPermissions' },
  codex: { ask: 'default', auto: 'acceptEdits', full: 'bypassPermissions' },
  kimi: { ask: 'default', auto: 'auto', full: 'yolo' },
  antigravity: { ask: 'default', auto: 'acceptEdits', full: 'bypassPermissions' },
  dsh: { ask: 'read-only', auto: 'workspace-write', full: 'danger-full-access' },
};
// Native values each engine's sessions already understand.
const NATIVE_VALUES = {
  claude: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
  codex: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
  kimi: ['default', 'plan', 'auto', 'yolo'],
  antigravity: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
  dsh: ['default', 'bypassPermissions'],
};
function valid(engine, value) {
  return LEVELS.includes(value) || (NATIVE_VALUES[engine] || []).includes(value);
}
function nativeMode(engine, value, fallback = 'ask') {
  if (LEVELS.includes(value)) return TO_NATIVE[engine][value];
  if (valid(engine, value)) return value;
  return TO_NATIVE[engine][fallback] || TO_NATIVE[engine].ask;
}
module.exports = { LEVELS, valid, nativeMode };
