'use strict';

const STRING_CHUNK = 16 * 1024;
const NUMBER_END = new Set(['zero', 'integer', 'fraction', 'exponent']);
const ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

// Validate JSONL while exposing decoded string chunks. Neither a giant tool
// string nor a numeric token is materialized. Scan every key/value, including
// shadowed object keys: extra protected references are safer than lost ones.
class JsonReferenceScanner {
  constructor(onString, { maxDepth = 1024 } = {}) {
    this.onString = onString;
    this.maxDepth = maxDepth;
    this.stack = [];
    this.root = 'value';
    this.token = null;
    this.special = /["\\\x00-\x1f]/g;
    this.parts = [];
    this.chars = 0;
  }
  invalid() { throw new SyntaxError('Invalid reference JSON; cleanup was stopped'); }
  expected() { return this.stack.at(-1)?.expect || this.root; }
  completed() {
    const parent = this.stack.at(-1);
    if (parent) parent.expect = 'commaOrEnd';
    else this.root = 'done';
  }
  stringPart(text) {
    for (let offset = 0; offset < text.length; offset += STRING_CHUNK) {
      const part = text.slice(offset, offset + STRING_CHUNK);
      this.parts.push(part); this.chars += part.length;
      if (this.chars >= STRING_CHUNK) this.flushString(false);
    }
  }
  flushString(last) {
    let text = this.parts.join('');
    this.parts = []; this.chars = 0;
    // Keep a surrogate pair together across a chunk/escape boundary.
    if (!last && /[\ud800-\udbff]$/.test(text)) {
      this.parts.push(text.slice(-1)); this.chars = 1; text = text.slice(0, -1);
    }
    if (text || last) {
      this.onString(text, this.firstStringChunk, last);
      this.firstStringChunk = false;
    }
  }
  number(character) {
    const digit = character >= '0' && character <= '9';
    switch (this.numberState) {
      case 'sign':
        if (digit) { this.numberState = character === '0' ? 'zero' : 'integer'; return true; }
        break;
      case 'integer': if (digit) return true; // falls through
      case 'zero':
        if (character === '.') { this.numberState = 'point'; return true; }
        if (character === 'e' || character === 'E') { this.numberState = 'e'; return true; }
        if (digit) this.invalid();
        break;
      case 'point':
        if (digit) { this.numberState = 'fraction'; return true; }
        break;
      case 'fraction':
        if (digit) return true;
        if (character === 'e' || character === 'E') { this.numberState = 'e'; return true; }
        break;
      case 'e':
        if (character === '+' || character === '-') { this.numberState = 'exponentSign'; return true; }
        if (digit) { this.numberState = 'exponent'; return true; }
        break;
      case 'exponentSign':
        if (digit) { this.numberState = 'exponent'; return true; }
        break;
      case 'exponent': if (digit) return true; break;
      default: this.invalid();
    }
    if (!NUMBER_END.has(this.numberState)) this.invalid();
    this.token = null; this.completed();
    return false;
  }
  write(text) {
    let index = 0;
    while (index < text.length) {
      const character = text[index];
      if (this.token === 'string') {
        if (this.unicode !== null) {
          if (!/[a-fA-F0-9]/.test(character)) this.invalid();
          this.unicode += character; index++;
          if (this.unicode.length === 4) {
            this.stringPart(String.fromCharCode(parseInt(this.unicode, 16)));
            this.unicode = null;
          }
        } else if (this.escaped) {
          this.escaped = false; index++;
          if (character === 'u') this.unicode = '';
          else if (Object.hasOwn(ESCAPES, character)) this.stringPart(ESCAPES[character]);
          else this.invalid();
        } else if (character === '"') {
          this.flushString(true); this.token = null; index++;
          if (this.key) this.stack.at(-1).expect = 'colon'; else this.completed();
        } else if (character === '\\') {
          this.escaped = true; index++;
        } else {
          this.special.lastIndex = index;
          const next = this.special.exec(text)?.index ?? text.length;
          if (next === index) this.invalid();
          this.stringPart(text.slice(index, next)); index = next;
        }
        continue;
      }
      if (this.token === 'number') {
        if (this.number(character)) index++;
        continue;
      }
      if (this.token === 'literal') {
        if (character !== this.literal[this.literalIndex++]) this.invalid();
        index++;
        if (this.literalIndex === this.literal.length) { this.token = null; this.completed(); }
        continue;
      }
      if (character === '\n') {
        if (this.stack.length || this.root !== 'done' && this.root !== 'value') this.invalid();
        this.root = 'value'; index++; continue;
      }
      if (character === ' ' || character === '\t' || character === '\r') { index++; continue; }
      const parent = this.stack.at(-1), expected = this.expected();
      if (character === '}' || character === ']') {
        const object = character === '}';
        if (!parent || parent.object !== object || expected !== 'commaOrEnd'
          && expected !== (object ? 'keyOrEnd' : 'valueOrEnd')) this.invalid();
        this.stack.pop(); this.completed(); index++; continue;
      }
      if (character === ':') {
        if (expected !== 'colon') this.invalid();
        parent.expect = 'value'; index++; continue;
      }
      if (character === ',') {
        if (!parent || expected !== 'commaOrEnd') this.invalid();
        parent.expect = parent.object ? 'key' : 'value'; index++; continue;
      }
      const key = expected === 'key' || expected === 'keyOrEnd';
      if (key && character !== '"') this.invalid();
      if (!key && expected !== 'value' && expected !== 'valueOrEnd') this.invalid();
      if (character === '"') {
        this.key = key; this.token = 'string'; this.firstStringChunk = true;
        this.unicode = null; this.escaped = false; index++; continue;
      }
      if (character === '{' || character === '[') {
        if (this.stack.length >= this.maxDepth) this.invalid();
        this.stack.push({ object: character === '{', expect: character === '{' ? 'keyOrEnd' : 'valueOrEnd' });
        index++; continue;
      }
      const literal = { t: 'true', f: 'false', n: 'null' }[character];
      if (literal) {
        this.token = 'literal'; this.literal = literal; this.literalIndex = 1;
        index++; continue;
      }
      if (character === '-' || character >= '0' && character <= '9') {
        this.token = 'number';
        this.numberState = character === '-' ? 'sign' : character === '0' ? 'zero' : 'integer';
        index++; continue;
      }
      this.invalid();
    }
  }
  end() {
    if (this.token === 'number') {
      if (!NUMBER_END.has(this.numberState)) this.invalid();
      this.token = null; this.completed();
    }
    if (this.token || this.stack.length) this.invalid();
  }
}

module.exports = { JsonReferenceScanner };
