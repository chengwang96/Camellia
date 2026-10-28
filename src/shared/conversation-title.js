'use strict';

const MAX_TITLE_CHARS = 20;
function shortTitle(value) {
  const text = String(value || '').replace(/^[\s"'`#*-]+|[\s"'`#*-.。！!？?：:]+$/gu, '').replace(/\s+/g, ' ').trim();
  const chars = [...text];
  if (chars.length <= MAX_TITLE_CHARS) return text;
  const clipped = chars.slice(0, MAX_TITLE_CHARS).join('');
  let boundary = -1;
  for (const mark of ['，', '。', '！', '？', '；', '：', ',', '.', '!', '?', ';', ':']) boundary = Math.max(boundary, clipped.lastIndexOf(mark));
  if (/^[A-Za-z0-9]$/.test(chars[MAX_TITLE_CHARS - 1]) && /^[A-Za-z0-9]$/.test(chars[MAX_TITLE_CHARS])) boundary = Math.max(boundary, clipped.lastIndexOf(' '));
  return (boundary >= 8 ? clipped.slice(0, boundary) : clipped).replace(/[\s，。！？；：,.!?;:]+$/u, '');
}

// A readable provisional name is available even with no API routes. The model
// can replace it later; only visible user text belongs in this fallback.
function messageTitle(message) {
  const line = String(message || '').split(/\r?\n/).map(value => value.trim()).find(Boolean) || '';
  const topic = line.replace(/^(?:你好[，,！!\s]*|您好[，,！!\s]*|请(?:帮我|你)?|麻烦(?:你)?|帮我|能否|可以(?:帮我|请你)?|我们现在)[，,\s]*/u, '')
    .replace(/^(?:为什么|为何|怎么|如何|什么是|是什么)[，,\s]*/u, '')
    .replace(/^(?:hello|hi)[,!\s]+|^(?:please|could you|can you|why|how(?: to)?|what(?: is| are)?)\s+/iu, '');
  return shortTitle(topic || line);
}

module.exports = { shortTitle, messageTitle, MAX_TITLE_CHARS };
