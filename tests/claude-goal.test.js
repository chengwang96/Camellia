'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ClaudeGoal, verifySignal } = require('../src/engines/claude-goal');
const { createHarness } = require('./claude-harness.cjs');

function setup(t, extra = {}) {
  const h = createHarness(); t.after(() => h.cleanup());
  const timers = new Set(), prompts = [];
  let now = 1000, interrupts = 0;
  const session = { gen: 1, sessionId: null, running: false, sendUserMessage(prompt) { prompts.push(prompt); this.running = true; return true; },
    interrupt() { interrupts++; this.running = false; } };
  const options = { file: () => path.join(h.root, 'goal.json'), getSession: () => session, ensureSession: () => session,
    resolveWorkspace: p => p.workspaceId || null, onChange() {}, log() {},
    setTimer: fn => { timers.add(fn); return fn; }, clearTimer: fn => timers.delete(fn), now: () => now, ...extra };
  const goal = new ClaudeGoal(options);
  const tick = () => { assert.equal(timers.size, 1); [...timers][0](); };
  const result = event => { session.running = false; goal.handleResult(event); };
  const settle = async () => { await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); };
  return { goal, session, options, prompts, timers, tick, result, settle, advance: ms => { now += ms; }, interrupts: () => interrupts };
}

test('goals continue past the former 10, 25 and 50 turn limits and finish only on completion', t => {
  const h = setup(t);
  h.goal.start({ objective: 'Finish' });
  for (let i = 0; i < 60; i++) { h.tick(); h.result({ result: 'Working on step ' + i }); }
  assert.equal(h.prompts.length, 60);
  assert.equal(h.goal.view().phase, 'active');
  assert.equal(h.goal.view().maxRounds, undefined);
  assert.match(h.prompts[0], /<goal:complete>/);
  assert.match(h.prompts[0], /verify the result/);
  assert.doesNotMatch(h.prompts.at(-1), /budget:|Turn limit/);
  h.tick(); h.result({ result: 'Implemented and verified.\n<goal:complete>' });
  assert.equal(h.goal.view().phase, 'complete');
  assert.equal(h.goal.resume().ok, false);
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

test('three consecutive execution errors block even when subtypes differ; resume resets the streak', t => {
  const h = setup(t);
  h.goal.start({ objective: 'Finish' });
  for (const subtype of ['quota', 'network', 'error']) { h.tick(); h.result({ is_error: true, subtype }); }
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
  assert.equal(restarted.view().phase, 'paused');
  assert.equal(h.prompts.length, 1);
  assert.equal(h.timers.size, 0);
  restarted.clear();
});

test('quoted or fenced status markers and errors cannot falsely complete a goal', t => {
  const h = setup(t); h.goal.start({ objective: 'Finish' });
  for (const text of ['Use <goal:complete> when done', '> <goal:complete>', '    <goal:complete>', '~~~text\n<goal:complete>\n~~~', '```text\n<goal:complete>']) {
    h.tick(); h.result({ result: text }); assert.equal(h.goal.view().phase, 'active');
  }
  h.tick(); h.result({ is_error: true, subtype: 'network', result: '<goal:complete>' });
  assert.equal(h.goal.view().phase, 'active');
});

test('recoverable blockers are retried, progress resets the streak, and persistent blockers stop', t => {
  const h = setup(t); h.goal.start({ objective: 'Finish' });
  h.tick(); h.result({ result: '<goal:blocked> Missing data' });
  assert.equal(h.goal.view().phase, 'active');
  h.tick(); assert.match(h.prompts.at(-1), /Previous blocker report \(1\/3\): Missing data/);
  h.result({ result: 'Found the data and resumed work.' });
  assert.equal(h.goal.view().blockerStreak, 0);
  for (let i = 0; i < 3; i++) { h.tick(); h.result({ result: '<goal:blocked> Remote system is unavailable' }); }
  assert.equal(h.goal.view().phase, 'blocked');
  assert.equal(h.goal.view().blockedReason.message, 'Remote system is unavailable');
  assert.equal(h.timers.size, 0);
  h.goal.resume(); assert.equal(h.goal.view().blockerStreak, 0);
});

test('pause and clear interrupt the owned response and cannot be undone by a late result', t => {
  const h = setup(t); h.goal.start({ objective: 'Finish' }); h.tick();
  h.goal.setPhase('paused'); assert.equal(h.interrupts(), 1);
  h.result({ result: '<goal:complete>' }); assert.equal(h.goal.view().phase, 'paused');
  h.goal.resume(); h.tick(); h.goal.clear();
  assert.equal(h.interrupts(), 2);
  h.result({ result: '<goal:blocked> Too late' });
  assert.equal(h.goal.view(), null); assert.equal(h.timers.size, 0);
});

test('a stopped engine response pauses the goal instead of starting another response', t => {
  const h = setup(t); h.goal.start({ objective: 'Finish' }); h.tick();
  h.result({ subtype: 'stopped', result: '<goal:complete>' });
  assert.equal(h.goal.view().phase, 'paused'); assert.equal(h.timers.size, 0);
});

test('active time freezes when paused, resumes cumulatively, and stays fixed after completion', t => {
  const h = setup(t); h.goal.start({ objective: 'Finish' }); h.tick(); h.advance(5000);
  h.goal.setPhase('paused'); assert.equal(h.goal.view().elapsedMs, 5000);
  h.result({ subtype: 'stopped' }); h.advance(7200000);
  h.goal.resume(); h.tick(); h.advance(3000); h.result({ result: '<goal:complete>' });
  assert.equal(h.goal.view().elapsedMs, 8000);
  assert.equal(h.goal.view().activeSince, null);
});

test('a goal never interrupts a different conversation and session launch failures block', t => {
  const h = setup(t); h.goal.start({ objective: 'Finish' }); h.tick();
  h.session.gen++; h.goal.clear(); assert.equal(h.interrupts(), 0);
  h.session.running = false; h.goal.start({ objective: 'Next goal' });
  h.session.sendUserMessage = () => { throw new Error('Engine unavailable'); };
  h.tick(); assert.equal(h.goal.view().phase, 'blocked');
  assert.match(h.goal.view().blockedReason.message, /Engine unavailable/);
});

test('completion claims are verified independently; a pass completes with evidence recorded', async t => {
  const claims = [];
  const h = setup(t, { verifyCompletion: async claim => { claims.push(claim); return { pass: true, reason: 'tests green, diff reviewed' }; } });
  h.goal.start({ objective: 'Finish', criterion: 'npm test passes' });
  h.tick();
  assert.match(h.prompts[0], /Completion criterion.*npm test passes/);
  assert.match(h.prompts[0], /independent verifier/);
  h.result({ result: 'Done.\n<goal:complete>' });
  assert.equal(h.goal.view().phase, 'active');
  assert.ok(h.goal.view().verifying);
  await h.settle();
  assert.equal(claims.length, 1);
  assert.deepEqual({ objective: claims[0].objective, criterion: claims[0].criterion }, { objective: 'Finish', criterion: 'npm test passes' });
  assert.equal(h.goal.view().phase, 'complete');
  assert.equal(h.goal.view().verified.evidence, 'tests green, diff reviewed');
  assert.equal(h.timers.size, 0);
});

test('rejected claims feed back into the next round and three rejections block', async t => {
  const reasons = ['tests still failing', 'diff has no migration', 'criterion unmet'];
  const h = setup(t, { verifyCompletion: async () => ({ pass: false, reason: reasons.shift() }) });
  h.goal.start({ objective: 'Finish', criterion: 'all green' });
  for (let i = 1; i <= 2; i++) {
    h.tick(); h.result({ result: 'Done.\n<goal:complete>' });
    await h.settle();
    assert.equal(h.goal.view().phase, 'active');
    assert.equal(h.goal.view().verifyStreak, i);
  }
  h.tick(); assert.match(h.prompts.at(-1), /verifier rejected the completion claim \(2\/3\): diff has no migration/);
  h.result({ result: 'Done again.\n<goal:complete>' });
  await h.settle();
  assert.equal(h.goal.view().phase, 'blocked');
  assert.equal(h.goal.view().blockedReason.code, 'verification-failed');
  assert.equal(h.timers.size, 0);
  h.goal.resume(); assert.equal(h.goal.view().verifyStreak, 0);
});

test('a verifier that cannot run counts as an execution error and blocks after three', async t => {
  const h = setup(t, { verifyCompletion: async () => { throw new Error('engine down'); } });
  h.goal.start({ objective: 'Finish' });
  for (let i = 0; i < 3; i++) {
    h.tick(); h.result({ result: 'Done.\n<goal:complete>' });
    await h.settle();
  }
  assert.equal(h.goal.view().phase, 'blocked');
  assert.equal(h.goal.view().blockedReason.code, 'repeated-errors');
});

test('pausing mid-verification discards the verdict', async t => {
  let release;
  const h = setup(t, { verifyCompletion: () => new Promise(resolve => { release = resolve; }) });
  h.goal.start({ objective: 'Finish' });
  h.tick(); h.result({ result: 'Done.\n<goal:complete>' });
  assert.ok(h.goal.view().verifying);
  h.goal.setPhase('paused');
  release({ pass: true, reason: 'ok' });
  await h.settle();
  assert.equal(h.goal.view().phase, 'paused');
  assert.equal(h.goal.view().verified, null);
  assert.equal(h.timers.size, 0);
});

test('clearing and replacing a goal discards every stale verification outcome', async t => {
  for (const outcome of [{ pass: true, reason: 'old success' }, { pass: false, reason: 'old failure' }, new Error('old error')]) {
    let release, reject, signal;
    const harness = setup(t, { verifyCompletion: (claim, options) => {
      signal = options.signal;
      return new Promise((resolve, fail) => { release = resolve; reject = fail; });
    } });
    harness.goal.start({ objective: 'Old goal' }); harness.tick();
    harness.result({ result: '<goal:complete>' });
    const oldId = harness.goal.view().id;
    harness.goal.clear();
    assert.equal(signal.aborted, true);
    harness.goal.start({ objective: 'Replacement goal' });
    assert.equal(harness.goal.view().id, oldId);
    const expected = harness.goal.view();
    if (outcome instanceof Error) reject(outcome); else release(outcome);
    await harness.settle();
    assert.deepEqual(harness.goal.view(), expected);
    assert.equal(harness.timers.size, 1);
  }
});

test('pause and resume isolates a new verification from the old verdict', async t => {
  const pending = [];
  const harness = setup(t, { verifyCompletion: (claim, { signal }) => new Promise(resolve => pending.push({ signal, resolve })) });
  harness.goal.start({ objective: 'Finish' }); harness.tick();
  harness.result({ result: '<goal:complete>' });
  harness.goal.setPhase('paused');
  assert.equal(pending[0].signal.aborted, true);
  harness.goal.resume(); harness.tick();
  harness.result({ result: '<goal:complete>' });
  const expected = harness.goal.view();
  pending[0].resolve({ pass: true, reason: 'stale evidence' });
  await harness.settle();
  assert.deepEqual(harness.goal.view(), expected);
  assert.equal(pending[1].signal.aborted, false);
  pending[1].resolve({ pass: true, reason: 'current evidence' });
  await harness.settle();
  assert.equal(harness.goal.view().phase, 'complete');
  assert.equal(harness.goal.view().verified.evidence, 'current evidence');
});

test('verify verdicts ignore fenced or quoted markers', () => {
  assert.equal(verifySignal('```\n<verify:pass>\n```'), null);
  assert.equal(verifySignal('> <verify:pass>'), null);
  assert.deepEqual(verifySignal('Checked.\n<verify:fail> tests missing'), { type: 'fail', reason: 'tests missing' });
  assert.deepEqual(verifySignal('<verify:pass> all green'), { type: 'pass', reason: 'all green' });
});
