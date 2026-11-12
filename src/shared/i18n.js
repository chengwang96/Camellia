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
  const reverseCounts = new Map();
  for (const [key, value] of dictionary) if (key !== value) reverseCounts.set(value, (reverseCounts.get(value) || 0) + 1);
  const reverse = new Map([...dictionary]
    .filter(([key, value]) => key !== value && reverseCounts.get(value) === 1).map(([key, value]) => [value, key]));
  const reversePatterns = [...dictionary]
    .filter(([key, value]) => key !== value && reverseCounts.get(value) === 1 && /\{\d+\}/.test(value))
    .sort(([, a], [, b]) => specificity(b) - specificity(a)).map(([key, value]) => {
    const slots = [];
    const source = value.split(/(\{\d+\})/).map(part => {
      if (/^\{\d+\}$/.test(part)) { slots.push(part); return '([\\s\\S]+?)'; }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('');
    return { match: new RegExp('^' + source + '$'), slots, key };
  });
  function untranslate(text) {
    const key = text.trim();
    let source = reverse.get(key);
    if (source === undefined) {
      for (const pattern of reversePatterns) {
        const match = pattern.match.exec(key);
        if (!match) continue;
        source = pattern.key.replace(/\{\d+\}/g, slot => match[pattern.slots.indexOf(slot) + 1]);
        break;
      }
    }
    return source === undefined ? text
      : text.slice(0, text.indexOf(key)) + source + text.slice(text.indexOf(key) + key.length);
  }
  function translate(text, language) {
    if (!text) return text;
    const source = /[\u3400-\u9fff]/.test(text) ? untranslate(text) : text;
    if (normalizeLanguage(language) === 'en') return source;
    const key = source.trim();
    let value = dictionary.get(key);
    if (value === undefined) {
      for (const pattern of patterns) {
        const match = pattern.match.exec(key);
        if (!match) continue;
        value = pattern.value.replace(/\{\d+\}/g, slot => match[pattern.slots.indexOf(slot) + 1]);
        break;
      }
    }
    return value === undefined ? source : source.slice(0, source.indexOf(key)) + value + source.slice(source.indexOf(key) + key.length);
  }
  return { normalizeLanguage, translate };
});
