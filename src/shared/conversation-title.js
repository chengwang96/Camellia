'use strict';

const shortTitle = value => [...String(value || '').replace(/^[\s"'`#*-]+|[\s"'`#*-.。！!？?：:]+$/gu, '').replace(/\s+/g, ' ').trim()].slice(0, 10).join('');

// A readable provisional name is available even with no API routes. The model
// can replace it later; only visible user text belongs in this fallback.
function messageTitle(message) {
  const line = String(message || '').split(/\r?\n/).map(value => value.trim()).find(Boolean) || '';
  const topic = line.replace(/^(?:你好[，,！!\s]*|您好[，,！!\s]*|请(?:帮我|你)?|麻烦(?:你)?|帮我|能否|可以(?:帮我|请你)?|我们现在)[，,\s]*/u, '')
    .replace(/^(?:hello|hi)[,!\s]+|^(?:please|could you|can you)\s+/iu, '');
  return shortTitle(topic || line);
}

module.exports = { shortTitle, messageTitle };
