'use strict';

// Chat keeps its existing renderer as the authority. During a response, only
// the unfinished suffix is parsed; comments mark its DOM range without adding
// layout wrappers. A final reconciliation also handles syntax spanning blocks.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CamelliaStreamingMarkdown = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  const selections = new WeakMap();
  function observeSelection(doc) {
    if (selections.has(doc)) return;
    const state = { ranges: [] };
    selections.set(doc, state);
    const update = () => {
      const selection = doc.getSelection();
      const count = selection?.rangeCount || 0;
      state.ranges = Array.from({ length: count }, (_, index) => selection.getRangeAt(index));
    };
    // Querying Selection while mutating the DOM can force layout. Read it on
    // selection changes and retain the live ranges for later text-node merges.
    doc.addEventListener('selectionchange', update);
    update();
  }
  function sameKind(a, b) {
    return a.nodeType === b.nodeType && a.nodeName === b.nodeName;
  }

  function patchText(node, value) {
    if (node.data === value) return false;
    if (value.startsWith(node.data)) node.appendData(value.slice(node.length));
    else node.replaceData(0, node.length, value);
    return true;
  }

  function joinText(node, other) {
    const offset = node.length;
    const doc = node.ownerDocument;
    const ranges = [];
    for (const range of selections.get(doc)?.ranges || []) {
      if (range.startContainer === other || range.endContainer === other) ranges.push({ range,
        start: range.startContainer === other ? offset + range.startOffset : null,
        end: range.endContainer === other ? offset + range.endOffset : null });
    }
    node.appendData(other.data);
    for (const { range, start, end } of ranges) {
      if (end !== null) range.setEnd(node, end);
      if (start !== null) range.setStart(node, start);
    }
    other.remove();
  }

  function patchNode(node, next, onCodeChange) {
    if (node.nodeType === 3) { patchText(node, next.data); return; }
    if (node.nodeType !== 1) return;
    if (node.classList.contains('md-code-block') && next.classList.contains('md-code-block')
      && node.querySelector('.md-code-header > span')?.textContent === next.querySelector('.md-code-header > span')?.textContent) {
      // Wrap, copy feedback, focus and the formula panel belong to the user.
      const code = node.querySelector('.md-code > code');
      const value = next.querySelector('.md-code > code').textContent;
      if (!code.firstChild) code.appendChild(node.ownerDocument.createTextNode(''));
      while (code.firstChild.nextSibling) joinText(code.firstChild, code.firstChild.nextSibling);
      if (patchText(code.firstChild, value)) onCodeChange?.(node);
      return;
    }
    if (node.isEqualNode(next)) return;
    for (const attr of [...node.attributes]) if (!next.hasAttribute(attr.name)) node.removeAttribute(attr.name);
    for (const attr of next.attributes) if (node.getAttribute(attr.name) !== attr.value) node.setAttribute(attr.name, attr.value);
    patchChildren(node, next, onCodeChange);
  }

  function patchChildren(parent, next, onCodeChange, after = null, before = null) {
    let node = after ? after.nextSibling : parent.firstChild;
    const children = [];
    for (const fresh of [...next.childNodes]) {
      const last = children.at(-1);
      if (fresh.nodeType === 3 && last?.nodeType === 3) last.appendData(fresh.data);
      else children.push(fresh);
    }
    for (const fresh of children) {
      // Independently parsed prose can leave adjacent text nodes. Coalesce only
      // at reconciliation, retaining the first node and the surrounding blocks.
      if (fresh.nodeType === 3 && node?.nodeType === 3) {
        while (node.nextSibling !== before && node.nextSibling?.nodeType === 3) {
          joinText(node, node.nextSibling);
        }
      }
      if (node && node !== before && sameKind(node, fresh)) {
        patchNode(node, fresh, onCodeChange);
        node = node.nextSibling;
      } else {
        parent.insertBefore(fresh, node || before);
      }
    }
    while (node && node !== before) { const old = node; node = node.nextSibling; old.remove(); }
  }

  function fragment(element, html) {
    const template = element.ownerDocument.createElement('template');
    template.innerHTML = html;
    return template.content;
  }

  function reconcile(element, html, onCodeChange) {
    observeSelection(element.ownerDocument);
    patchChildren(element, fragment(element, html), onCodeChange);
  }

  // Blank lines are safe only outside unfinished inline and block syntax.
  // Lines are scanned once, including a long line arriving in many deltas.
  class Boundaries {
    constructor() { this.reset(); }
    reset() {
      this.searched = this.lineStart = this.cut = 0;
      this.fence = this.math = '';
      this.emphasis = { '$': 0 };
      this.delimiters = { '*': [], '_': [], '~': [] };
      this.brackets = this.parens = this.blank = 0;
      this.indented = false;
    }
    scan(source) {
      let end;
      while ((end = source.indexOf('\n', this.searched)) !== -1) {
        const line = source.slice(this.lineStart, end);
        this.line(line);
        if (!line.trim()) {
          this.blank++;
          if (!this.fence && !this.math && !this.brackets && !this.parens
            && !Object.values(this.emphasis).some(Boolean) && !Object.values(this.delimiters).some(stack => stack.length)
            && (!this.indented || this.blank > 1)) this.cut = end + 1;
        } else this.blank = 0;
        this.lineStart = this.searched = end + 1;
      }
      this.searched = source.length;
      return this.cut;
    }
    line(line) {
      if (!this.fence && !this.math && /^(?: {4}|\t)\S|^ {4}\s*\S/.test(line)) { this.indented = true; return; }
      if (line.trim()) this.indented = false;
      // A list marker is block syntax, rather than an open emphasis delimiter.
      line = line.replace(/^\s{0,3}[*+-]\s+/, '');
      if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) return;
      let inlineCode = false;
      for (let i = 0; i < line.length; i++) {
        if (line.startsWith('```', i)) { this.fence = this.fence ? '' : '```'; i += 2; continue; }
        if (this.fence) continue;
        if (this.math) {
          if (line.startsWith(this.math, i)) { i++; this.math = ''; }
          // Escaped TeX dollars and row spacing (\\[2pt]) do not close math.
          else if (line[i] === '\\') i++;
          continue;
        }
        if (line[i] === '\\') {
          if (!inlineCode && (line[i + 1] === '[' || line[i + 1] === '(')) {
            this.math = line[i + 1] === '[' ? '\\]' : '\\)'; i++;
          }
          else i++;
          continue;
        }
        if (line[i] === '`') { inlineCode = !inlineCode; continue; }
        if (inlineCode) continue;
        if (line.startsWith('$$', i)) { this.math = '$$'; i++; continue; }
        if (line[i] === '[') this.brackets++;
        else if (line[i] === ']') this.brackets = Math.max(0, this.brackets - 1);
        else if (line[i] === '(') this.parens++;
        else if (line[i] === ')') this.parens = Math.max(0, this.parens - 1);
        else if (line[i] === '*' || line[i] === '_' || line[i] === '~') {
          const start = i, char = line[i];
          while (line[i + 1] === char) i++;
          const count = i - start + 1;
          if (char === '~' && count !== 2) continue;
          const prev = line[start - 1] || '\n', next = line[i + 1] || '\n';
          const prevSpace = /\s/.test(prev), nextSpace = /\s/.test(next);
          const prevPunct = /[\p{P}\p{S}]/u.test(prev), nextPunct = /[\p{P}\p{S}]/u.test(next);
          const left = !nextSpace && (!nextPunct || prevSpace || prevPunct);
          const right = !prevSpace && (!prevPunct || nextSpace || nextPunct);
          const open = char === '_' ? left && (!right || prevPunct) : left;
          const close = char === '_' ? right && (!left || nextPunct) : right;
          const stack = this.delimiters[char];
          if (close && stack.at(-1) === count) stack.pop();
          else if (open) stack.push(count);
        }
        else if (Object.hasOwn(this.emphasis, line[i])) this.emphasis[line[i]] ^= 1;
      }
      if (inlineCode) this.emphasis.unfinishedCode = 1;
    }
  }

  class Stream {
    constructor(element, { render, codeBlock, onCodeChange } = {}) {
      observeSelection(element.ownerDocument);
      this.element = element;
      this.render = render;
      this.codeBlock = codeBlock;
      this.onCodeChange = onCodeChange;
      this.tail = '';
      this.committed = 0;
      this.boundaries = new Boundaries();
      this.anchor = element.ownerDocument.createComment('stream-tail');
      this.cursor = element.ownerDocument.createElement('span');
      this.cursor.className = 'cursor';
      element.prepend(this.anchor);
      element.appendChild(this.cursor);
      this.lastParsed = 0;
      this.hasContent = false;
    }
    append(delta, source) {
      this.tail = source === undefined ? this.tail + delta : source.slice(this.committed);
      this.boundaries.scan(this.tail);
    }
    paint(html) {
      const fresh = fragment(this.element, html);
      this.hasContent ||= /\S/.test(fresh.textContent) || !!fresh.querySelector('.chat-inline-image');
      patchChildren(this.element, fresh, this.onCodeChange, this.anchor, this.cursor);
    }
    consume(length) {
      this.element.insertBefore(this.anchor, this.cursor);
      this.committed += length;
      this.tail = this.tail.slice(length);
      this.boundaries.reset();
      this.boundaries.scan(this.tail);
      this.lastParsed = 0;
      this.code = this.table = this.literal = null;
      this.tableDisabled = false;
    }
    flush() {
      while (this.tail) {
        if (this.flushCode()) { if (this.code) return; else continue; }
        const cut = this.boundaries.cut;
        if (cut) { this.paint(this.render(this.tail.slice(0, cut))); this.consume(cut); continue; }
        if (this.flushTable()) return;
        // A single unfinished paragraph/list may be arbitrarily large. Parse
        // it at geometric growth intervals and show every intervening delta as
        // text. This bounds parse volume without dropping or hiding output.
        const growth = this.tail.length - this.lastParsed;
        if (this.tail.length <= 8192 || growth >= Math.max(512, this.lastParsed / 8)
          || /(?:```|\$\$|\\\])/.test(this.tail.slice(Math.max(0, this.lastParsed - 2)))) {
          this.paint(this.render(this.tail));
          this.lastParsed = this.tail.length;
          this.literal = null;
        } else if (growth) {
          if (!this.literal) { this.literal = this.element.ownerDocument.createTextNode(''); this.element.insertBefore(this.literal, this.cursor); }
          patchText(this.literal, this.tail.slice(this.lastParsed));
          this.hasContent ||= /\S/.test(this.literal.data);
        }
        return;
      }
      this.paint('');
    }
    flushCode() {
      if (!this.codeBlock) return false;
      if (!this.code) {
        const header = /^```(\w*)[ \t]*\n/.exec(this.tail);
        if (!header) return false;
        this.paint(this.codeBlock(header[1], ''));
        const block = this.anchor.nextSibling;
        const code = block.querySelector('.md-code > code');
        if (!code.firstChild) code.appendChild(this.element.ownerDocument.createTextNode(''));
        this.code = { block, text: code.firstChild, start: header[0].length, shown: header[0].length, searched: header[0].length };
      }
      const state = this.code;
      const close = this.tail.indexOf('```', state.searched);
      let end = close === -1 ? this.tail.length : close;
      while (end > state.start && this.tail[end - 1] === '\n') end--;
      let changed = false;
      if (end > state.shown) { state.text.appendData(this.tail.slice(state.shown, end)); changed = true; }
      else if (end < state.shown) { state.text.deleteData(end - state.start, state.shown - end); changed = true; }
      state.shown = end;
      state.searched = Math.max(state.start, this.tail.length - 2);
      this.hasContent ||= end > state.start || !!state.block.querySelector('.md-code-header > span')?.textContent;
      if (changed) this.onCodeChange?.(state.block);
      if (close !== -1) this.consume(close + 3);
      return true;
    }
    flushTable() {
      if (this.tableDisabled) return false;
      if (!this.table) {
        const match = /^([^\n]*\|[^\n]*)\n([| :\-]+)\n/.exec(this.tail);
        if (!match || /```|\$\$|\\\[/.test(match[0])) return false;
        const html = this.render(match[0]);
        const fresh = fragment(this.element, html);
        if (!fresh.querySelector('.md-table')) return false;
        this.paint(html);
        this.table = { header: match[0], offset: match[0].length, row: null };
        // The active table can follow earlier completed tables in this block.
        this.table.body = this.anchor.nextSibling.querySelector('tbody');
        this.table.after = this.anchor.nextSibling.nextSibling;
        if (this.table.after?.nodeType !== 3) {
          this.table.after = this.element.ownerDocument.createTextNode('');
          this.element.insertBefore(this.table.after, this.cursor);
        }
      }
      const state = this.table;
      let offset = state.offset;
      while (offset < this.tail.length) {
        const newline = this.tail.indexOf('\n', offset);
        const end = newline === -1 ? this.tail.length : newline;
        const row = this.tail.slice(offset, end);
        if ((!row.trim() || !row.includes('|')) && newline === -1) {
          patchText(state.after, '\n' + row);
          return true;
        }
        if (!row.trim() || !row.includes('|') || /```|\$\$|\\\[/.test(row)) {
          this.table = null; this.tableDisabled = true; return false;
        }
        const fresh = fragment(this.element, this.render(state.header + row)).querySelector('tbody > tr');
        if (!fresh) { this.table = null; return false; }
        if (state.row) patchNode(state.row, fresh, this.onCodeChange);
        else { state.row = fresh; state.body.appendChild(fresh); }
        patchText(state.after, newline === -1 ? '' : '\n');
        if (newline === -1) break;
        offset = state.offset = newline + 1;
        state.row = null;
      }
      return true;
    }
    finish(source) {
      this.anchor.remove(); this.cursor.remove();
      reconcile(this.element, this.render(source), this.onCodeChange);
      this.dispose();
    }
    dispose() {
      this.anchor?.remove(); this.cursor?.remove();
      this.tail = '';
      this.code = this.table = this.literal = this.boundaries = null;
      this.element = this.render = this.codeBlock = this.onCodeChange = null;
    }
  }

  return { create: (element, options) => new Stream(element, options), reconcile, Boundaries };
});
