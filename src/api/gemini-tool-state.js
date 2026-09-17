'use strict';

const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

// Some harnesses retain standard tool IDs but discard provider-specific fields.
// Keep Google's opaque thought signatures with those IDs, including on resume.
class GeminiToolState {
  constructor(file) {
    this.file = file;
    this.signatures = new Map();
    if (fs.existsSync(file)) for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      const entry = JSON.parse(line);
      this.signatures.set(entry.model + '/' + entry.id, entry.signature);
    }
  }

  restore(body, model) {
    for (const message of body.messages || []) for (const tool of message.tool_calls || []) {
      const signature = tool.extra_content?.google?.thought_signature || this.signatures.get(model + '/' + tool.id);
      if (signature) tool.extra_content = { ...tool.extra_content, google: { ...tool.extra_content?.google, thought_signature: signature } };
    }
    // Claude's generic thinking flag is not a Gemini Chat Completions option.
    delete body.thinking;
    if (['max', 'xhigh'].includes(body.reasoning_effort)) body.reasoning_effort = 'high';
    return body;
  }

  response(model) {
    const calls = new Map();
    return body => {
      if (!body || typeof body !== 'object') return;
      for (const choice of body.choices || []) {
        const message = choice.message || choice.delta;
        for (const [offset, tool] of (message?.tool_calls || []).entries()) {
          const index = (choice.index || 0) + '/' + (tool.index ?? offset);
          let id = calls.get(index);
          if (!id) { id = 'call_' + randomUUID().replaceAll('-', ''); calls.set(index, id); }
          // Supply the stable ID even if Google sends the signature in a later frame.
          if (tool.id || choice.message) tool.id = id;
          const signature = tool.extra_content?.google?.thought_signature;
          if (signature && this.signatures.get(model + '/' + id) !== signature) {
            fs.appendFileSync(this.file, JSON.stringify({ model, id, signature }) + '\n', { mode: 0o600 });
            this.signatures.set(model + '/' + id, signature);
          }
        }
      }
    };
  }
}

module.exports = { GeminiToolState };
