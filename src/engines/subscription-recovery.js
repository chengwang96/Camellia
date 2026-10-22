'use strict';

// Classify terminal provider errors only; tool output must never trigger rotation.
function subscriptionFailure(event, engine) {
  if (!event?.is_error || event.type && event.type !== 'result') return null;
  const text = String(event.result || '');
  if (/\b401\b|unauthorized|authentication (?:failed|required)|(?:access|refresh|authentication)[ _-]?token.{0,40}(?:expired|invalid|revoked)|(?:sign|log)[ -]?in again/i.test(text)) return 'auth';
  if (/\b429\b|usage[_ ]limit[_ ]reached|rate[_ -]?limit|quota.{0,40}(?:exceed|exhaust|reach)|(?:exceed|exhaust).{0,40}quota|insufficient[_ ]quota|usage limit|额度.{0,12}(?:用尽|不足|超)/i.test(text)) return 'quota';
  if (engine === 'codex' && (event.codexErrorInfo === 'responseTooManyFailedAttempts'
      || event.codexErrorInfo && Object.hasOwn(event.codexErrorInfo, 'responseTooManyFailedAttempts')
      || /\b(?:exceeded (?:the )?retry limit|retry limit (?:reached|exceeded)|(?:retries|retry attempts) exhausted|too many failed attempts|failed after \d+ (?:retries|attempts))\b/i.test(text))) return 'retry';
  return null;
}

function subscriptionRecoveryMessage(failure) {
  if (failure === 'auth') return 'Subscription login expired. Sign in again in Settings → Subscription accounts. Switching to another signed-in account and retrying…';
  if (failure === 'retry') return 'Subscription retries exhausted. Switching to another signed-in account and continuing…';
  return 'Subscription quota reached. Switching to another signed-in account and retrying…';
}

function availableAccount(state, excluded = []) {
  const candidates = (state?.accounts || []).filter(account => account.signedIn && !account.exhausted
    && !account.loginPending && !excluded.includes(account.id));
  return candidates.find(account => account.id === state.activeId)?.id || candidates[0]?.id;
}

module.exports = { subscriptionFailure, subscriptionRecoveryMessage, availableAccount };
