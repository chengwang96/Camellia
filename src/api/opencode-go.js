'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { version } = require('../../package.json');

const GO_ROOT = 'https://opencode.ai/inference/go';

function isOpenCodeGoUrl(url) {
  return url.origin === 'https://opencode.ai'
    && /^\/(?:zen\/go|inference\/go(?:\/(?:openai|anthropic))?)\/v1(?:\/|$)/.test(url.pathname);
}

function openCodeGoHeaders(sessionKey = randomUUID()) {
  const id = createHash('sha256').update(sessionKey).digest('hex').slice(0, 32);
  return { 'user-agent': `Camellia/${version}`, 'x-opencode-session': 'ses_' + id };
}

module.exports = { GO_ROOT, isOpenCodeGoUrl, openCodeGoHeaders };
