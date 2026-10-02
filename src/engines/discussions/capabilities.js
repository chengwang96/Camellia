'use strict';

const { createHash } = require('node:crypto');

const CONNECTIONS = Object.freeze({
  claude: ['api'], codex: ['api', 'subscription'], dsh: ['api'],
  kimi: ['api', 'subscription'], antigravity: ['api', 'subscription'], pi: ['api'],
});

function bindingFingerprint(binding) {
  // Fixed field order; no credentials or arbitrary renderer settings.
  return createHash('sha256').update(JSON.stringify([
    binding.engine, binding.connection, binding.model, binding.accountRef ?? null,
    binding.thinking ?? '', binding.contextWindow ?? 0,
  ])).digest('hex');
}

// Evidence must come from a reviewed main-process adapter registry, never an
// IPC payload, participant profile, model output or persisted permission flag.
// Production evidence comes from the main-process online verifier, never from
// renderer declarations. The scheduler must recheck before every activity.
function evaluateCapability(binding, runtime, evidence = null) {
  const denied = reason => ({ available: false, mode: null, reason });
  if (!binding || !CONNECTIONS[binding.engine]?.includes(binding.connection)) return denied('unsupported-connection');
  if (typeof binding.model !== 'string' || !binding.model.trim()
    || (binding.connection === 'subscription' && (typeof binding.accountRef !== 'string' || !binding.accountRef.trim()))) {
    return denied('unresolved-binding');
  }
  if (!runtime?.version || !runtime.policyVersion) return denied('unknown-runtime-policy');
  if (!evidence || evidence.kind !== 'real' || !evidence.reference) return denied('unverified-connection');
  if (evidence.bindingFingerprint !== bindingFingerprint(binding)
    || evidence.runtimeVersion !== runtime.version || evidence.policyVersion !== runtime.policyVersion) return denied('evidence-mismatch');
  if (!['tool-free', 'workspace-read-only', 'native-tools'].includes(evidence.mode)) return denied('unverified-execution-mode');
  if (evidence.mode === 'native-tools') {
    if (['isolatedSession', 'pinnedBinding', 'continuation', 'stopConfirmed', 'permissionsRouted', 'workspaceQueue']
      .some(key => evidence.checks?.[key] !== true)) return denied('incomplete-enforcement');
    return { available: true, mode: evidence.mode, reason: null, evidenceRef: evidence.reference, supportsImages: evidence.supportsImages === true };
  }
  const required = ['isolatedSession', 'pinnedBinding', 'continuation', 'stopConfirmed',
    'shellRestricted', 'mcpRestricted', 'subagentsRestricted', 'escalationDisabled', 'conversationControlDisabled'];
  required.push(evidence.mode === 'tool-free' ? 'toolsDisabled' : 'workspaceWritesDenied');
  if (required.some(key => evidence.checks?.[key] !== true)) return denied('incomplete-enforcement');
  return { available: true, mode: evidence.mode, reason: null, evidenceRef: evidence.reference };
}

module.exports = { bindingFingerprint, evaluateCapability };
