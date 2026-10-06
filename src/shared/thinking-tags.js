'use strict';

// Some providers cannot carry native reasoning blocks, so a replayed turn hands
// the previous model's thinking back as ordinary text inside `<thinking>`
// delimiters. The model then mimics that shape. Split the delimiters back out
// here so callers can render the answer alone and fold the reasoning away.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CamelliaThinkingTags = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  // A closed block, or one still arriving in a stream, runs to the end of input.
  const OPEN = /<think(?:ing)?(?:\s[^>]*)?>/i;
  const CLOSE = /<\/think(?:ing)?\s*>/i;
  // Prefixes of an opening or closing tag that a stream may have cut short, so
  // a half-written delimiter is not shown as literal text mid-render. A bare
  // "<" is left alone: it is far more likely to be ordinary prose.
  const PARTIAL = [
    ...['t', 'th', 'thi', 'thin', 'think', 'thinki', 'thinkin', 'thinking'].map(part => '<' + part),
    ...['/', '/t', '/th', '/thi', '/thin', '/think', '/thinki', '/thinkin', '/thinking'].map(part => '<' + part),
  ];

  function literalRanges(source) {
    const ranges = [];
    const markers = /^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)|^(?: {4}|\t)[^\r\n]*|`+|\\[\\`<]/gm;
    let marker;
    while ((marker = markers.exec(source))) {
      let end = markers.lastIndex;
      if (marker[1]) {
        const fence = marker[1];
        const closing = new RegExp('^ {0,3}' + fence[0] + '{' + fence.length + ',}[ \\t]*(?:\\r?\\n|$)', 'gm');
        closing.lastIndex = end;
        const match = closing.exec(source);
        end = match ? closing.lastIndex : source.length;
      } else if (marker[0][0] === '`') {
        const ticks = /`+/g;
        ticks.lastIndex = end;
        let closing;
        while ((closing = ticks.exec(source)) && closing[0].length !== marker[0].length) {}
        end = closing ? ticks.lastIndex : source.length;
      }
      ranges.push({ start: marker.index, end });
      markers.lastIndex = end;
    }
    return ranges;
  }

  function isLiteral(index, ranges) {
    return ranges.some(range => range.start <= index && index < range.end);
  }

  function findTag(pattern, source, offset, ranges) {
    const matcher = new RegExp(pattern.source, 'gi');
    matcher.lastIndex = offset;
    let match;
    while ((match = matcher.exec(source))) {
      if (!isLiteral(match.index, ranges)) return match;
    }
    return null;
  }

  // Hold back only a delimiter that sits at the very end of the streamed text.
  function holdPartial(text) {
    const lower = text.toLowerCase();
    const at = lower.lastIndexOf('<');
    if (at === -1) return text;
    return PARTIAL.includes(lower.slice(at)) && !isLiteral(at, literalRanges(text)) ? text.slice(0, at) : text;
  }

  function split(text, { latestOnly = false } = {}) {
    const source = typeof text === 'string' ? text : text == null ? '' : String(text);
    const kept = [];
    const ranges = literalRanges(source);
    let offset = 0, thinking = '';
    for (;;) {
      const open = findTag(OPEN, source, offset, ranges);
      if (!open) break;
      kept.push(source.slice(offset, open.index));
      const start = open.index + open[0].length;
      const close = findTag(CLOSE, source, start, ranges);
      const segment = source.slice(start, close ? close.index : source.length);
      thinking = latestOnly ? segment : thinking + (thinking ? '\n\n' : '') + segment;
      offset = close ? close.index + close[0].length : source.length;
      if (!close) break;
    }
    // Preserve author spacing; only the streamed partial tag is trimmed.
    return { body: holdPartial(kept.join('') + source.slice(offset)), thinking };
  }

  const api = { split };
  return api;
});
