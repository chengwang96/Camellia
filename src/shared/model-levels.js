'use strict';

// Reasoning-effort ladders for API-routed models, where neither the account
// catalog nor an ACP engine reports the supported levels. The provider's model
// list does not carry this information, so we infer from the model ID. Unknown
// models keep the conservative three-level default.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CamelliaModelLevels = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  const DEFAULT_LEVELS = ['low', 'medium', 'high'];
  // GPT-5.5 and newer (including 6.x) accept the wider ladder. Matches Codex's
  // ReasoningEffort enum minus the newest ultra/persistent levels.
  const WIDE_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  // Claude Code owns its effort flag, so its ladder is fixed instead of being
  // inferred from the routed model ID.
  const CLAUDE_LEVELS = ['off', 'low', 'medium', 'high', 'max'];
  function levelsFor(model) {
    const id = String(model || '').toLowerCase();
    if (/gpt-(5\.[5-9]|[6-9])/.test(id)) return WIDE_LEVELS.slice();
    if (/gpt-5|\bo[1-9]/.test(id)) return DEFAULT_LEVELS.slice();
    return DEFAULT_LEVELS.slice();
  }
  // Engine-aware ladder used by settings surfaces that do not have a composer
  // session to resolve account reasoning efforts from.
  function levelsForEngine(engine, model) {
    return engine === 'claude' ? CLAUDE_LEVELS.slice() : levelsFor(model);
  }
  return { levelsFor, levelsForEngine };
});
