'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');

function createMarkdownRenderer({ fork }) {
  const pending = new Map();

  async function render(sender, payload = {}) {
    const source = String(payload.source || '');
    if (Buffer.byteLength(source, 'utf8') > 24 * 1024 * 1024) throw new Error('Markdown preview is too large');
    const requestId = typeof payload.requestId === 'string' && /^[\w-]{1,100}$/.test(payload.requestId)
      ? payload.requestId : randomUUID();
    const child = fork(path.join(__dirname, 'markdown-render-worker.js'), [], { stdio: 'ignore' });
    let rejectRender;
    const done = new Promise((resolve, reject) => {
      rejectRender = reject;
      child.on('message', data => {
        if (data?.chunk !== undefined && !sender.isDestroyed())
          sender.send('dsh:markdown-preview-chunk', { requestId, chunk: data.chunk });
        else if (data?.error) reject(new Error(data.error));
        else if (data?.done) resolve();
      });
      child.once('error', reject);
      child.once('exit', code => {
        if (code) reject(new Error('Markdown renderer exited early (' + code + ')'));
      });
    });
    pending.set(requestId, { sender, child, reject: rejectRender });
    try {
      child.postMessage({ source, options: payload.options || {} });
      await done;
      return { ok: true };
    } finally {
      pending.delete(requestId);
      child.kill();
    }
  }

  function cancel(sender, requestId) {
    const current = pending.get(requestId);
    if (!current || current.sender !== sender) return { ok: true };
    const error = new Error('Preview rendering was cancelled.');
    error.name = 'AbortError';
    current.reject(error);
    current.child.kill();
    return { ok: true };
  }

  return { render, cancel };
}

module.exports = { createMarkdownRenderer };
