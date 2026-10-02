'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bindingFingerprint, evaluateCapability } = require('../src/engines/discussions/capabilities');

// Synthetic evidence tests the gate only; it is not runtime verification.
const binding = { engine: 'codex', connection: 'subscription', model: 'model-a', accountRef: 'account-a' };
const runtime = { version: 'test-runtime', policyVersion: 'test-policy' };
function proof(mode = 'tool-free') {
  return { kind: 'real', reference: 'synthetic-test-only', bindingFingerprint: bindingFingerprint(binding),
    runtimeVersion: runtime.version, policyVersion: runtime.policyVersion, mode,
    checks: { isolatedSession: true, pinnedBinding: true, continuation: true, stopConfirmed: true,
      shellRestricted: true, mcpRestricted: true, subagentsRestricted: true, escalationDisabled: true,
      conversationControlDisabled: true, toolsDisabled: true, workspaceWritesDenied: true } };
}

test('all current connections remain unavailable without reviewed real evidence', () => {
  for (const engine of ['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi']) {
    for (const connection of ['api', 'subscription']) {
      assert.equal(evaluateCapability({ ...binding, engine, connection }, runtime).available, false);
    }
  }
  for (const kind of ['mock', 'native-fixture', 'unknown']) {
    assert.equal(evaluateCapability(binding, runtime, { ...proof(), kind }).available, false);
  }
  assert.equal(evaluateCapability({ ...binding, accountRef: null }, runtime, proof()).reason, 'unresolved-binding');
});

test('evidence cannot transfer across binding, runtime or policy changes', () => {
  const evidence = proof();
  assert.equal(evaluateCapability(binding, runtime, evidence).available, true);
  for (const change of [{ model: 'other' }, { accountRef: 'other' }, { engine: 'kimi' },
    { connection: 'api' }, { thinking: 'high' }, { contextWindow: 32000 }]) {
    assert.equal(evaluateCapability({ ...binding, ...change }, runtime, evidence).reason, 'evidence-mismatch');
  }
  for (const change of [{ version: 'new-runtime' }, { policyVersion: 'new-policy' }]) {
    assert.equal(evaluateCapability(binding, { ...runtime, ...change }, evidence).reason, 'evidence-mismatch');
  }
  assert.equal(evaluateCapability(binding, {}, evidence).available, false);
  assert.equal(bindingFingerprint(binding), bindingFingerprint({ ...binding, apiKey: 'never-store', thinking: '', contextWindow: 0 }));
});

test('plan labels and incomplete shell, MCP, child, stop or escalation controls cannot open the gate', () => {
  for (const mode of ['tool-free', 'workspace-read-only']) {
    const evidence = proof(mode);
    assert.equal(evaluateCapability(binding, runtime, evidence).mode, mode);
    const required = Object.keys(evidence.checks).filter(key => key !== (mode === 'tool-free' ? 'workspaceWritesDenied' : 'toolsDisabled'));
    for (const key of required) {
      assert.equal(evaluateCapability(binding, runtime, { ...evidence, checks: { ...evidence.checks, [key]: false } }).available, false, key);
    }
  }
  assert.equal(evaluateCapability(binding, runtime, { ...proof(), mode: 'plan' }).available, false);
});
