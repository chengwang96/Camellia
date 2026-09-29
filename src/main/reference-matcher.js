'use strict';

function referenceMatcher(terms) {
  const pending = new Set(terms), found = new Set(), root = new Map(), prefixes = new Set();
  for (const term of pending) {
    if (!term) continue;
    prefixes.add([...term].slice(0, 8).join(''));
    let node = root;
    for (const character of term) {
      if (!node.has(character)) node.set(character, new Map());
      node = node.get(character);
    }
    node.term = term;
  }
  const patterns = [...prefixes].map(prefix => prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const expression = patterns.length ? new RegExp(patterns.join('|'), 'gu') : null;
  return {
    found,
    inspect(text) {
      if (!pending.size || !expression) return;
      expression.lastIndex = 0;
      let match;
      while ((match = expression.exec(text))) {
        let node = root;
        for (const character of text.slice(match.index)) {
          node = node.get(character);
          if (!node) break;
          if (node.term) { found.add(node.term); pending.delete(node.term); }
        }
        expression.lastIndex = match.index + (text.codePointAt(match.index) > 0xffff ? 2 : 1);
      }
    },
  };
}

module.exports = { referenceMatcher };
