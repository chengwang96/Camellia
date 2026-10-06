'use strict';

(function(root) {
  const item = /^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/;
  const timestamp = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?:\s*[（(][^）)]*[）)])?$/;

  // A completed reply cannot make a native tool call. Recognize only a short
  // question followed by a final, simple choice list; ordinary lists stay text.
  function parse(text) {
    if (typeof text !== 'string' || text.length > 12000) return null;
    const lines = text.replace(/\r\n?/g, '\n').trim().split('\n');
    let end = lines.length;
    while (end && !lines[end - 1].trim()) end--;
    if (timestamp.test(lines[end - 1]?.trim() || '')) {
      end--;
      while (end && !lines[end - 1].trim()) end--;
    }
    let start = end;
    while (start && item.test(lines[start - 1])) start--;
    if (end - start < 2 || end - start > 4) return null;
    const options = lines.slice(start, end).map(line => item.exec(line)[1].replace(/^\*\*(.*?)\*\*$/, '$1').trim());
    if (options.some(option => !option || option.length > 120 || /<[^>]+>|`/.test(option))) return null;
    let promptEnd = start;
    while (promptEnd && !lines[promptEnd - 1].trim()) promptEnd--;
    let promptStart = promptEnd;
    while (promptStart && lines[promptStart - 1].trim()) promptStart--;
    const question = lines.slice(promptStart, promptEnd).join(' ').trim();
    if (!question || question.length > 600 || !/[?？]/.test(question) || /^(?:[-*•]|\d+[.)]|[>#`])\s/.test(question)) return null;
    if ((lines.slice(0, start).join('\n').match(/^\s*```/gm) || []).length % 2) return null;
    return { question, options };
  }

  const api = { parse };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CamelliaAssistantChoice = api;
})(typeof window === 'undefined' ? globalThis : window);
