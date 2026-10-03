'use strict';

// Ordinary conversations use the six-harness menu. Discussion groups are
// opened from their sidebar section or the home page and have no mode menu.
window.CamelliaChatModeSelect = Object.freeze({
  populate(select, current) {
    select.replaceChildren(...[
      ['claude', 'Claude Code'], ['codex', 'Codex CLI'], ['dsh', 'DeepSeek Harness'],
      ['kimi', 'Kimi Code'], ['antigravity', 'Antigravity'], ['pi', 'Pi'],
    ].map(([value, label]) => {
      const option = document.createElement('option');
      option.value = value; option.textContent = label;
      return option;
    }));
    select.value = current;
  },
});
