'use strict';

// The Google subscription CLI can silently drop the tail of a text message.
// Leave 10% headroom below its 192,000-byte limit. Inline media is separate.
const SUBSCRIPTION_PROMPT_BYTES = 172800;

function assertSubscriptionPromptFits(text) {
  if (Buffer.byteLength(text, 'utf8') > SUBSCRIPTION_PROMPT_BYTES)
    throw new Error('Antigravity Google subscription accepts up to 172,800 UTF-8 bytes per message in Camellia. Split the text or attach it as a file. Nothing was sent.');
}

module.exports = { SUBSCRIPTION_PROMPT_BYTES, assertSubscriptionPromptFits };
