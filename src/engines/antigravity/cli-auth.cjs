'use strict';

// Shared by account checks and the CLI bridges run by standalone Node from
// app.asar.unpacked. Keep this module independent of the Electron app sources.
function headlessEnvironment(env) {
  return { ...env, AGY_CLI_NONINTERACTIVE_HEADLESS: 'true' };
}

// Report failed unattended authentication as a sign-in problem. Explicit login
// remains an interactive account action.
function cliAuthenticationError(output) {
  if (/headless auth|no valid auth|authentication required|not authenticated|invalid_grant/i.test(String(output || '')))
    return new Error('Google sign-in has expired or is invalid. Sign in again and retry.');
  return null;
}

function describeCliFailure(errors, output, code) {
  const text = (errors || '').trim() || (output || '').trim();
  return cliAuthenticationError(text)?.message || text || `Antigravity CLI exited (${code})`;
}

module.exports = { headlessEnvironment, cliAuthenticationError, describeCliFailure };
