'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CamelliaProviderBrands = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  const TYPES = {
    ollama: 'ollama', deepseek: 'deepseek', kimi: 'kimi', 'kimi-code': 'kimi',
    gemini: 'gemini', commandcode: 'commandcode', mimo: 'mimo',
    'mimo-token-plan-cn': 'mimo', 'mimo-token-plan-sgp': 'mimo', 'mimo-token-plan-ams': 'mimo',
    opencode: 'opencode', 'opencode-go': 'opencode', qclaw: 'qclaw',
  };
  const HOSTS = [
    [/(^|\.)ollama\.com$/, 'ollama'],
    [/(^|\.)deepseek\.com$/, 'deepseek'],
    [/(^|\.)moonshot\.(cn|ai)$/, 'kimi'],
    [/(^|\.)kimi\.com$/, 'kimi'],
    [/(^|\.)generativelanguage\.googleapis\.com$/, 'gemini'],
    [/(^|\.)commandcode\.ai$/, 'commandcode'],
    [/(^|\.)nvidia\.com$/, 'nvidia'],
    [/(^|\.)xiaomimimo\.com$/, 'mimo'],
    [/(^|\.)opencode\.ai$/, 'opencode'],
    [/(^|\.)qclaw\.qq\.com$/, 'qclaw'],
  ];
  const NAMES = [
    [/\bollama\b/i, 'ollama'],
    [/\bdeepseek\b/i, 'deepseek'],
    [/\b(kimi|moonshot)\b/i, 'kimi'],
    [/\b(gemini|google ai)\b/i, 'gemini'],
    [/\bnvidia\b/i, 'nvidia'],
    [/\bcommand\s*code\b/i, 'commandcode'],
    [/\bmi\s*mo\b/i, 'mimo'],
    [/\bopencode\b/i, 'opencode'],
    [/\bqclaw\b/i, 'qclaw'],
  ];
  function host(value) {
    try { return new URL(String(value || '').trim()).hostname.toLowerCase(); } catch { return ''; }
  }
  function providerBrand(provider = {}) {
    const type = String(provider.type || '').toLowerCase();
    if (TYPES[type]) return TYPES[type];
    for (const value of [provider.baseUrl, provider.anthropicBaseUrl]) {
      const name = host(value);
      const match = HOSTS.find(([pattern]) => pattern.test(name));
      if (match) return match[1];
    }
    const name = String(provider.name || '');
    const match = NAMES.find(([pattern]) => pattern.test(name));
    return match ? match[1] : '';
  }
  return { providerBrand };
});
