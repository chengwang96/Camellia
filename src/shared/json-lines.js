'use strict';

const { Transform } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');

// JSONL frames end at LF (or CRLF). U+2028 and U+2029 are valid JSON string
// contents, but node:readline treats them as line endings and splits RPCs and
// saved history in the middle of a string. Decode UTF-8 across chunk boundaries
// and split only on the protocol delimiter, preserving the payload verbatim.
function jsonLines(input) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const lines = new Transform({
    readableObjectMode: true,
    transform(chunk, encoding, done) {
      const text = decoder.write(chunk);
      let start = 0;
      for (let end; (end = text.indexOf('\n', start)) !== -1; start = end + 1) {
        const line = pending + text.slice(start, end);
        pending = '';
        this.push(line.endsWith('\r') ? line.slice(0, -1) : line);
      }
      pending += text.slice(start);
      done();
    },
    flush(done) {
      pending += decoder.end();
      if (pending) this.push(pending.endsWith('\r') ? pending.slice(0, -1) : pending);
      pending = '';
      done();
    },
  });
  const fail = error => lines.destroy(error);
  input.on('error', fail);
  lines.once('close', () => { input.unpipe(lines); input.removeListener('error', fail); pending = ''; });
  return input.pipe(lines);
}

module.exports = { jsonLines };
