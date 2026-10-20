'use strict';

const { randomUUID } = require('node:crypto');
const { readJson, writeJson } = require('../shared/json-store');

const OUTCOMES = new Set(['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit']);
const CONFIRMATION_TTL = 5 * 60 * 1000;
const PREVIEW_TIMEOUT = 30000;
const READ_TIMEOUT = 15000;
const QUERY_TIMEOUT_MESSAGE = 'Reset credit query timed out. Check your network or proxy settings and try again.';
const timestamp = value => Number.isSafeInteger(value) && value > 0 ? value : null;

function resetCredits(value) {
  if (!Number.isSafeInteger(value?.availableCount) || value.availableCount < 0) return null;
  return { availableCount: value.availableCount, credits: Array.isArray(value.credits) ? value.credits
    .filter(credit => credit && typeof credit.id === 'string' && credit.id)
    .map(credit => ({ id: credit.id, resetType: credit.resetType, status: credit.status,
      grantedAt: timestamp(credit.grantedAt), expiresAt: timestamp(credit.expiresAt),
      title: typeof credit.title === 'string' ? credit.title : null,
      description: typeof credit.description === 'string' ? credit.description : null })) : null };
}

function availableCredits(summary, now = Date.now()) {
  return (summary?.credits || []).filter(credit => credit.status === 'available' && credit.resetType === 'codexRateLimits'
    && (!credit.expiresAt || credit.expiresAt * 1000 > now))
    .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) || (a.grantedAt ?? 0) - (b.grantedAt ?? 0));
}

function quotaPatch(result) {
  return { rateLimits: result.rateLimitsByLimitId || (result.rateLimits ? { codex: result.rateLimits } : null),
    rateLimitResetCredits: resetCredits(result.rateLimitResetCredits), quotaError: null, verifiedAt: new Date().toISOString() };
}

// Every profile owns its journal. An ambiguous network result must reuse its
// original idempotency key, including after a restart or reopening the dialog.
function createResetCredits({ file, getClient, publish, now = () => Date.now() }) {
  let saved = readJson(file, null), prepared = null, running = null, runningToken = null, previewGeneration = 0, readGeneration = 0;
  if (saved && (typeof saved.token !== 'string' || typeof saved.identity !== 'string' || !saved.attempted)) {
    throw new Error('Cannot read the saved reset request');
  }
  async function readSnapshot(client, signal) {
    signal?.throwIfAborted();
    const request = ++readGeneration;
    // Reading account identity should not force a network token refresh. The
    // rate-limit request still uses Codex's managed authentication lifecycle.
    const { account } = await client.request('account/read', { refreshToken: false }, READ_TIMEOUT);
    signal?.throwIfAborted();
    if (account?.type !== 'chatgpt' || !account.email) throw new Error('Sign in to this ChatGPT account first');
    const limits = await client.request('account/rateLimits/read', {}, READ_TIMEOUT);
    signal?.throwIfAborted();
    const identity = JSON.stringify([account.email.toLowerCase(), limits.accountId ?? null]);
    if (request === readGeneration) publish({ account, ...quotaPatch(limits) });
    return { account, limits, identity };
  }
  function view(snapshot, attempt) {
    return { account: { email: snapshot.account.email, plan: snapshot.account.planType },
      credits: resetCredits(snapshot.limits.rateLimitResetCredits),
      confirmationToken: attempt?.token || null, creditId: attempt?.creditId || null,
      retry: Boolean(attempt?.attempted && !attempt.outcome) };
  }
  async function preview() {
    if (running) throw new Error('Wait for the reset request to finish');
    const request = ++previewGeneration;
    const controller = new AbortController();
    let timer, snapshot;
    try {
      // Include app-server startup in the deadline and prevent a timed-out
      // read from publishing stale account state when it eventually returns.
      snapshot = await Promise.race([
        (async () => readSnapshot(await getClient(), controller.signal))(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort(new Error(QUERY_TIMEOUT_MESSAGE));
            reject(controller.signal.reason);
          }, PREVIEW_TIMEOUT);
        }),
      ]);
    } finally { clearTimeout(timer); }
    // A canceled dialog can be reopened while its original read is in flight.
    // That older read must not invalidate the newer confirmation.
    if (request !== previewGeneration || running) return view(snapshot, null);
    const summary = resetCredits(snapshot.limits.rateLimitResetCredits);
    // Never replace an unresolved request with a fresh redemption.
    if (saved?.identity === snapshot.identity && !saved.outcome) prepared = saved;
    else if (summary?.availableCount > 0) prepared = { token: randomUUID(), identity: snapshot.identity,
      creditId: availableCredits(summary, now())[0]?.id || null, createdAt: now(), attempted: false, outcome: null };
    else prepared = null;
    return view(snapshot, prepared);
  }
  async function redeem(attempt, beforeConsume) {
    const client = await getClient();
    if (!attempt.outcome) {
      const snapshot = await readSnapshot(client);
      if (snapshot.identity !== attempt.identity) {
        prepared = null;
        throw new Error('The signed-in account changed. Open the reset dialog again.');
      }
      // Remote control may be revoked while the identity read is in flight.
      // Recheck its authority immediately before the irreversible request.
      beforeConsume?.();
      attempt.attempted = true;
      // Persist before sending. Failure to save cannot consume a credit.
      writeJson(file, attempt); saved = attempt;
      let result;
      try { result = await client.request('account/rateLimitResetCredit/consume', {
        idempotencyKey: attempt.token, ...(attempt.creditId ? { creditId: attempt.creditId } : {}) }); }
      catch (error) { throw new Error('The reset result is unknown. Retry this request to check it.', { cause: error }); }
      if (!OUTCOMES.has(result?.outcome)) throw new Error('The reset result is unknown. Retry this request to check it.');
      attempt.outcome = result.outcome;
    }
    const warnings = [];
    try { writeJson(file, attempt); saved = attempt; }
    catch { warnings.push('The reset result could not be saved.'); }
    // The outcome alone does not describe the new quota windows or card count.
    try { await readSnapshot(client); }
    catch {
      publish({ rateLimitResetCredits: null });
      warnings.push('Quota refresh failed. Refresh the account to see the latest usage.');
    }
    return { outcome: attempt.outcome, warning: warnings.join(' ') || null };
  }
  function consume({ confirmed, confirmationToken, beforeConsume } = {}) {
    if (confirmed !== true) return Promise.reject(new Error('Confirm before using a reset credit'));
    // An already-attempted token is durable. A phone's original command can
    // recover it after a desktop restart without minting a second redemption.
    const attempt = prepared?.token === confirmationToken ? prepared
      : saved?.attempted && saved.token === confirmationToken ? saved : null;
    if (!attempt) return Promise.reject(new Error('Open the reset dialog and confirm again'));
    if (!attempt.attempted && now() - attempt.createdAt > CONFIRMATION_TTL) {
      prepared = null;
      return Promise.reject(new Error('The confirmation expired. Open the reset dialog again.'));
    }
    if (running) return runningToken === attempt.token ? running : Promise.reject(new Error('Wait for the reset request to finish'));
    previewGeneration++;
    runningToken = attempt.token;
    running = redeem(attempt, beforeConsume).finally(() => { running = null; runningToken = null; });
    return running;
  }
  return { preview, consume, invalidate: () => { prepared = null; previewGeneration++; }, get busy() { return Boolean(running); } };
}

module.exports = { resetCredits, availableCredits, quotaPatch, createResetCredits };
