'use strict';

// Both conversation surfaces use the same native, theme-styled menu. Choosing
// a discussion navigates to its own records; it is not a conversation engine.
window.CamelliaChatModeSelect = Object.freeze({
  populate(select, current) {
    select.replaceChildren(...[
      ['claude', 'Claude Code'], ['codex', 'Codex CLI'], ['dsh', 'DeepSeek Harness'],
      ['kimi', 'Kimi Code'], ['antigravity', 'Antigravity'], ['pi', 'Pi'],
      ['discussions', 'Agent discussions (beta)'],
    ].map(([value, label]) => {
      const option = document.createElement('option');
      option.value = value; option.textContent = label;
      if (value === 'discussions') option.dataset.i18n = '';
      return option;
    }));
    select.value = current;
  },
});
