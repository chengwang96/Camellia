'use strict';

// Classify terminal provider errors only; tool output must never trigger rotation.
function subscriptionFailure(event) {
  if (!event?.is_error) return null;
  const text = String(event.result || '');
  if (/\b401\b|unauthorized|authentication (?:failed|required)|(?:access|refresh|authentication)[ _-]?token.{0,40}(?:expired|invalid|revoked)|(?:sign|log)[ -]?in again/i.test(text)) return 'auth';
  if (/\b429\b|usage[_ ]limit[_ ]reached|rate[_ -]?limit|quota.{0,40}(?:exceed|exhaust|reach)|(?:exceed|exhaust).{0,40}quota|insufficient[_ ]quota|usage limit|额度.{0,12}(?:用尽|不足|超)/i.test(text)) return 'quota';
  return null;
}

function availableAccount(state, excluded = []) {
  const candidates = (state?.accounts || []).filter(account => account.signedIn && !account.exhausted
    && !account.loginPending && !excluded.includes(account.id));
  return candidates.find(account => account.id === state.activeId)?.id || candidates[0]?.id;
}

module.exports = { subscriptionFailure, availableAccount };
