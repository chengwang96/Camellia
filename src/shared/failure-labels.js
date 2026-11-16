'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CamelliaFailureLabels = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  // Machine-readable routing failures and their default English wording. The
  // router stores the kind; the renderer translates it, so one state can read
  // correctly in every language. The English text stays as a fallback for
  // older records that only stored a reason string.
  const FAILURE_LABELS = {
    auth: 'Key authentication failed',
    quota: 'Quota exhausted or plan unavailable',
    rate_limit: 'Provider rate limit',
    model_unavailable: 'Model temporarily unavailable',
    upstream: 'Provider temporarily unavailable',
    network: 'Connection failed or timed out',
    protocol: 'This route cannot handle the request format',
  };

  const failureText = kind => FAILURE_LABELS[kind] || '';

  // New records carry `kind`; old records carry only `reason`. Prefer the kind
  // so a translated UI wins over a stale stored sentence.
  const failureLabel = (entry, translate = value => value) => {
    const text = failureText(entry?.kind) || (typeof entry?.reason === 'string' ? entry.reason : '');
    return text ? translate(text) : '';
  };

  return { FAILURE_LABELS, failureText, failureLabel };
});
