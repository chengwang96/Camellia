'use strict';

// Shared by account checks and the CLI bridges run by standalone Node from
// app.asar.unpacked. Keep this module independent of the Electron app sources.
function headlessEnvironment(env) {
  return { ...env, AGY_CLI_NONINTERACTIVE_HEADLESS: 'true' };
}

function cliNetworkError(output) {
  const text = String(output || '');
  if (/\binvalid_grant\b/i.test(text)) return null;
  if (/token (?:refresh|validation) failed due to network error/i.test(text)
    || /https:\/\/oauth2\.googleapis\.com\/token["\s\S]{0,200}(?:\bEOF\b|TLS handshake timeout|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timed?\s*out|context deadline exceeded|connection reset|fetch failed)/i.test(text))
    return new Error('Could not connect to Google. Check your network or proxy settings and retry.');
  return null;
}

// A failed token refresh request is not evidence that the login was revoked.
// Classify it before the interactive-login fallback that the CLI emits next.
function cliAuthenticationError(output) {
  const network = cliNetworkError(output);
  if (network) return network;
  if (/headless auth|no valid auth|authentication required|not authenticated|invalid_grant/i.test(String(output || '')))
    return new Error('Google sign-in has expired or is invalid. Sign in again and retry.');
  return null;
}

function describeCliFailure(errors, output, code) {
  const text = (errors || '').trim() || (output || '').trim();
  return cliAuthenticationError(`${errors || ''}\n${output || ''}`)?.message || text || `Antigravity CLI exited (${code})`;
}

module.exports = { headlessEnvironment, cliNetworkError, cliAuthenticationError, describeCliFailure };
