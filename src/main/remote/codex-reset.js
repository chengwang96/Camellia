'use strict';

const { fail } = require('./access');

// Reset allowance belongs to a desktop account, so only a device trusted with
// the whole computer may use it. Resolve the conversation's account on the
// desktop; a phone cannot name an unrelated account or change the preference.
function resetAccount(manager, conversation) {
  const driver = manager.drivers.codex;
  if (!driver?.resetCredits) fail(409, 'Update the desktop to use Codex reset credits');
  if (conversation.currentEngine !== 'codex') fail(409, 'Choose a Codex subscription conversation first');
  const selected = manager.settings('codex', conversation.id);
  if (selected.connection !== 'subscription') fail(409, 'Choose a Codex subscription conversation first');
  const state = driver.subscriptionAccounts();
  const id = selected.subscriptionId || conversation.segments?.codex?.contextSettings?.subscriptionId || state.activeId;
  if (!state.accounts?.some(account => account.id === id && account.signedIn && !account.loginPending))
    fail(409, 'Sign in to this ChatGPT account on the desktop first');
  return { driver, id };
}

function resetError(error) {
  const message = String(error?.message || '');
  // Do not return arbitrary native errors (which can contain desktop paths).
  if (/unknown|Retry this request/.test(message)) return 'The reset result is unknown. Open reset credits again to retry the same request.';
  if (/confirmation|confirm again|account changed|signed-in account changed/i.test(message))
    return 'The account or confirmation changed. Open reset credits again and confirm.';
  if (/Wait for the reset/.test(message)) return 'Wait for the reset request to finish';
  return 'Could not query or use reset credits. Check the desktop network or proxy and try again.';
}

async function codexReset(manager, conversation, payload, authorize) {
  const { driver, id } = resetAccount(manager, conversation);
  if (payload.action === 'codex-reset-consume' && (payload.confirmed !== true || payload.accountId !== id
    || typeof payload.confirmationToken !== 'string' || !/^[a-f0-9-]{36}$/.test(payload.confirmationToken)))
    fail(409, 'The account or confirmation changed. Open reset credits again and confirm.');
  try {
    if (payload.action === 'codex-reset-preview') {
      const result = await driver.resetCredits.preview({ id });
      authorize();
      if (resetAccount(manager, conversation).id !== id) fail(409, 'The account changed. Open reset credits again.');
      return { ok: true, state: 'accepted', resetPreview: { ...result.preview, accountId: id } };
    }
    // The native account service persists its idempotency key before consuming
    // and reuses it after a timeout, reconnect, or desktop restart.
    const result = await driver.resetCredits.consume({ id, confirmed: true, confirmationToken: payload.confirmationToken,
      beforeConsume: () => {
        authorize();
        if (resetAccount(manager, conversation).id !== id) fail(409, 'The account changed. Open reset credits again.');
      } });
    authorize();
    return { ok: true, state: 'accepted', outcome: result.outcome, warning: result.warning || null };
  } catch (error) {
    if (error.status) throw error;
    fail(409, resetError(error));
  }
}

module.exports = { codexReset };
