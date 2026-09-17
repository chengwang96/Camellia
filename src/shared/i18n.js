'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./i18n-messages.js'));
  else root.CamelliaLocale = factory(root.CamelliaMessages);
})(typeof window === 'object' ? window : globalThis, function (messages) {
  const normalizeLanguage = language => language === 'zh-CN' ? 'zh-CN' : 'en';
  const dictionary = new Map(Object.entries(messages));
  const specificity = key => key.replace(/\{\d+\}/g, '').length;
  const patterns = [...dictionary].filter(([key]) => /\{\d+\}/.test(key))
    .sort(([a], [b]) => specificity(b) - specificity(a)).map(([key, value]) => {
    const slots = [];
    const source = key.split(/(\{\d+\})/).map(part => {
      if (/^\{\d+\}$/.test(part)) { slots.push(part); return '([\\s\\S]+?)'; }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('');
    return { match: new RegExp('^' + source + '$'), slots, value };
  });
  function translate(text, language) {
    if (normalizeLanguage(language) === 'en' || !text) return text;
    const key = text.trim();
    let value = dictionary.get(key);
    if (value === undefined) {
      for (const pattern of patterns) {
        const match = pattern.match.exec(key);
        if (!match) continue;
        value = pattern.value.replace(/\{\d+\}/g, slot => match[pattern.slots.indexOf(slot) + 1]);
        break;
      }
    }
    return value === undefined ? text : text.slice(0, text.indexOf(key)) + value + text.slice(text.indexOf(key) + key.length);
  }
  return { normalizeLanguage, translate };
});
