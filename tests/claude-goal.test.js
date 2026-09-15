'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ClaudeGoal } = require('../src/engines/claude-goal');
const { createHarness } = require('./claude-harness.cjs');

function setup(t) {
  const h = createHarness(); t.after(() => h.cleanup());
  const timers = new Set(), prompts = [];
  const session = { gen: 1, sessionId: null, running: false, sendUserMessage(prompt) { prompts.push(prompt); this.running = true; return true; } };
  const options = { file: () => path.join(h.root, 'goal.json'), getSession: () => session, ensureSession: () => session,
    resolveWorkspace: p => p.workspaceId || null, onChange() {}, log() {},
    setTimer: fn => { timers.add(fn); return fn; }, clearTimer: fn => timers.delete(fn) };
  const goal = new ClaudeGoal(options);
  const tick = () => { assert.equal(timers.size, 1); [...timers][0](); };
  const result = event => { session.running = false; goal.handleResult(event); };
  return { goal, session, options, prompts, timers, tick, result };
}

test('goal rounds have one continuation timer and stop at their budget', t => {
  const h = setup(t);
  h.goal.start({ objective: 'Finish', maxRounds: 2 });
  h.tick(); h.result({ result: 'Continuing' });
  h.tick(); h.result({ result: 'Still working' });
  h.tick();
  assert.equal(h.prompts.length, 2);
  assert.equal(h.goal.view().blockedReason.code, 'rounds-exhausted');
  assert.equal(h.timers.size, 0);
});

test('pausing before init retains the goal conversation without scheduling another round', t => {
  const h = setup(t);
  h.goal.start({ objective: 'Finish' }); h.tick(); h.goal.setPhase('paused');
  h.session.sessionId = 'late-init'; h.goal.rememberSession(h.session);
  h.result({ result: '<goal:complete>' });
  assert.equal(h.goal.view().sessionId, 'late-init');
  assert.equal(h.goal.view().phase, 'paused');
  assert.equal(h.timers.size, 0);
  h.goal.resume(); assert.equal(h.timers.size, 1);
});

test('repeated errors block after three rounds and a manual resume starts a fresh error streak', t => {
  const h = setup(t);
  h.goal.start({ objective: 'Finish' });
  for (let i = 0; i < 3; i++) { h.tick(); h.result({ is_error: true, subtype: 'quota' }); }
  assert.equal(h.goal.view().phase, 'blocked');
  h.goal.resume(); h.tick(); h.result({ is_error: true, subtype: 'quota' });
  assert.equal(h.goal.view().phase, 'active');
  assert.equal(h.goal.view().errorStreak, 1);
  assert.equal(h.timers.size, 1);
});

test('restart disarms saved goals and markers in fenced examples do not complete a goal', t => {
  const h = setup(t);
  h.goal.start({ objective: 'Finish' }); h.tick();
  h.result({ result: '```\n<goal:complete>\n```' });
  assert.equal(h.goal.view().phase, 'active');
  h.goal.cancelTimer();
  const restarted = new ClaudeGoal(h.options); restarted.load(); restarted.drive();
  assert.equal(restarted.view().armed, false);
  assert.equal(h.prompts.length, 1);
  assert.equal(h.timers.size, 0);
  restarted.clear();
});
