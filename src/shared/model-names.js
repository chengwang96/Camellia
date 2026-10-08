'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CamelliaModelNames = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  // Normalize spelling and owner namespaces, never a model's version, tier,
  // date, quantization or moving alias. Unknown/private namespaces stay intact.
  const families = [
    { model: /^(?:gpt-|o[1-9](?:-|$)|chatgpt-)/, owners: ['openai'] },
    { model: /^claude-/, owners: ['anthropic'] },
    { model: /^kimi-/, owners: ['moonshotai', 'moonshot', 'kimi'] },
    { model: /^deepseek-/, owners: ['deepseek', 'deepseek-ai'] },
    { model: /^glm-/, owners: ['z-ai', 'zai', 'zai-org', 'zhipuai', 'thudm'] },
    { model: /^mimo-/, owners: ['xiaomi', 'xiaomimimo', 'mimo'] },
    { model: /^gemini-/, owners: ['google'] },
  ];
  function canonicalModelId(value) {
    const id = String(value || '').trim().replace(/:cloud$/i, '');
    const parts = id.toLowerCase().split('/'), name = parts.at(-1);
    const family = families.find(entry => entry.model.test(name));
    return family && parts.slice(0, -1).every(owner => family.owners.includes(owner)) ? name : id;
  }
  return { canonicalModelId };
});
