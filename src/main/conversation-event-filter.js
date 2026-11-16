'use strict';

const { validSessionId } = require('../engines/claude-history');

// History and remote clients retain the complete stream. Only the desktop's
// content subscription changes when its renderer opens another conversation.
class ConversationEventFilter {
  constructor() { this.views = new WeakMap(); }

  watch(contents, { sessionId = null, pending = false } = {}) {
    if (sessionId !== null && !validSessionId(sessionId)) throw new Error('Invalid conversation');
    this.views.set(contents, { sessionId, pending: pending === true });
  }

  allows(contents, event) {
    // List, activity, approval and task lifecycle notifications remain global.
    if (!event.session_id || event.type?.startsWith('conversation:')) return true;
    const view = this.views.get(contents);
    // An older renderer has no subscription. A new/forked send temporarily
    // accepts content until its response supplies the new conversation id.
    return !view || view.pending || event.session_id === view.sessionId;
  }
}

module.exports = { ConversationEventFilter };
