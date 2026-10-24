'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { ClaudeGoal, verifySignal } = require('../src/engines/claude-goal');
const { createHarness } = require('./claude-harness.cjs');

function setup(t, extra = {}) {
  const h = createHarness(); t.after(() => h.cleanup());
  const timers = new Set(), prompts = [];
  let now = 1000, interrupts = 0, timerDelay;
  const session = { gen: 1, sessionId: null, running: false, sendUserMessage(prompt) { prompts.push(prompt); this.running = true; return true; },
    interrupt() { interrupts++; this.running = false; } };
  const options = { file: () => path.join(h.root, 'goal.json'), getSession: () => session, ensureSession: () => session,
    resolveWorkspace: p => p.workspaceId || null, onChange() {}, log() {},
    setTimer: (fn, delay) => { timers.add(fn); timerDelay = delay; return fn; }, clearTimer: fn => timers.delete(fn), now: () => now, ...extra };
  const goal = new ClaudeGoal(options);
  const tick = () => { assert.equal(timers.size, 1); [...timers][0](); };
  const result = event => { session.running = false; goal.handleResult(event); };
  const settle = async () => { await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); };
  return { goal, session, options, prompts, timers, tick, result, settle, advance: ms => { now += ms; }, delay: () => timerDelay, interrupts: () => interrupts };
}

test('ongoing operations back off checks even as their progress changes, then productive work resets the delay', t => {
  const h = setup(t); h.goal.start({ objective: 'Monitor the experiment until its output is ready' }); h.tick();
  for (const [index, delay] of [60000, 120000, 240000, 480000, 900000, 900000].entries()) {
    const reason = `Experiment still running: ${index + 1} outputs written`;
    h.result(index % 2 ? { result: `<goal:waiting> ${reason}` } : { goalReport: { status: 'waiting', reason } });
    assert.equal(h.goal.view().phase, 'active'); assert.equal(h.goal.view().armed, true);
    assert.equal(h.goal.view().blockerStreak, 0); assert.equal(h.goal.view().waitStreak, index + 1);
    assert.deepEqual(h.goal.view().waiting, { reason, until: h.options.now() + delay });
    assert.equal(h.delay(), delay); assert.equal(h.goal.drive(), false);
    h.advance(delay - 1); h.tick(); assert.equal(h.delay(), 1); assert.equal(h.prompts.length, index + 1);
    h.advance(1); h.tick(); assert.equal(h.prompts.length, index + 2);
    assert.equal(h.goal.view().waiting, null); assert.match(h.prompts.at(-1), /Previous check found work still in progress/);
    assert.ok(h.prompts.at(-1).includes(reason));
  }
  h.result({ result: 'Output ready; completed the analysis and started validation' });
  assert.equal(h.goal.view().waitStreak, 0); assert.equal(h.goal.view().lastWait, null); assert.equal(h.delay(), 1200);
  h.tick(); h.result({ goalReport: { status: 'waiting', reason: 'Validation running' } });
  assert.equal(h.delay(), 60000);
});

test('waiting honors a later expected completion time and immediate user instructions bypass the delay', t => {
  const h = setup(t); h.goal.start({ objective: 'Finish' }); h.tick();
  h.result({ goalReport: { status: 'waiting', reason: 'Next checkpoint in ten minutes', wait_seconds: 600 } });
  assert.equal(h.delay(), 600000);
  assert.equal(h.goal.drive({ prompt: 'Inspect another output now' }), true);
  assert.equal(h.prompts.length, 2); assert.equal(h.timers.size, 0);
  assert.equal(h.goal.view().waiting, null); assert.equal(h.goal.view().waitStreak, 0);
  assert.equal(h.goal.view().lastWait, null);
  h.result({ goalReport: { status: 'waiting', reason: 'Still running' } }); assert.equal(h.delay(), 60000);
});

test('stopping or revising a waiting goal cancels its pending check and clears backoff', t => {
  for (const action of ['pause', 'complete', 'clear', 'block', 'revise']) {
    const h = setup(t); h.goal.start({ objective: 'Finish' }); h.tick();
    h.result({ result: '<goal:waiting> Operation running' });
    const staleTimer = [...h.timers][0];
    if (action === 'clear') h.goal.clear();
    else if (action === 'block') h.goal.block('missing-input', 'Credentials expired');
    else if (action === 'revise') h.goal.revise({ objective: 'Inspect a different operation', reason: 'Changed scope', user_request: 'Inspect another operation' });
    else h.goal.setPhase(action === 'pause' ? 'paused' : 'complete');
    assert.equal(h.goal.view()?.waiting || null, null); assert.equal(h.goal.view()?.waitStreak || 0, 0);
    if (action === 'revise') { assert.equal(h.timers.size, 1); assert.equal(h.delay(), 100); }
    else {
      staleTimer(); assert.equal(h.timers.size, 0); assert.equal(h.prompts.length, 1);
      if (action === 'pause' || action === 'block') {
        h.goal.resume(); h.tick(); h.result({ result: '<goal:waiting> Operation running' }); assert.equal(h.delay(), 60000);
      }
    }
  }
});

test('restart loads a waiting goal paused with no pending check', t => {
  const h = setup(t); h.goal.start({ objective: 'Finish' }); h.tick();
  h.result({ result: '<goal:waiting> Operation running' }); h.goal.cancelTimer();
  const restarted = new ClaudeGoal(h.options); restarted.load();
  assert.equal(restarted.view().phase, 'paused'); assert.equal(restarted.view().armed, false);
  assert.equal(restarted.view().waiting, null); assert.equal(restarted.view().waitStreak, 0);
  restarted.drive(); assert.equal(h.timers.size, 0); assert.equal(h.prompts.length, 1);
});

test('completion after waiting still requires independent verification', async t => {
  let checks = 0;
  const h = setup(t, { verifyCompletion: async () => { checks++; return { pass: true, reason: 'Output checked' }; } });
  h.goal.start({ objective: 'Finish' }); h.tick(); h.result({ result: '<goal:waiting> Operation running' });
  assert.equal(checks, 0); h.advance(h.delay()); h.tick();
  h.result({ goalReport: { status: 'complete', reason: 'Output ready' } }); await h.settle();
  assert.equal(checks, 1); assert.equal(h.goal.view().phase, 'complete');
  assert.equal(h.goal.view().waiting, null); assert.equal(h.timers.size, 0);
});

test('errors and blockers after waiting reset backoff and retain their existing retry limits', t => {
  for (const event of [{ is_error: true, subtype: 'network' }, { result: '<goal:blocked> Credentials expired' }]) {
    const h = setup(t); h.goal.start({ objective: 'Finish' }); h.tick(); h.result({ result: '<goal:waiting> Operation running' });
    h.advance(h.delay()); h.tick(); h.result(event);
    assert.equal(h.goal.view().waiting, null); assert.equal(h.goal.view().waitStreak, 0); assert.equal(h.delay(), 1200);
    h.tick(); h.result({ result: '<goal:waiting> Operation running' });
    assert.equal(h.delay(), 60000); assert.equal(h.goal.view().errorStreak, 0); assert.equal(h.goal.view().blockerStreak, 0);
  }
});

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

test('resuming a stopped goal can adopt the current turn once and preserve accumulated progress', t => {
  for (const phase of ['paused', 'blocked']) {
    const h = setup(t);
    h.goal.start({ objective: 'Finish', criterion: 'Tests pass', engine: 'claude' }); h.tick();
    h.advance(4000); h.result({ result: 'First step done' });
    if (phase === 'blocked') h.goal.block('missing-input', 'Need input'); else h.goal.setPhase('paused');
    const original = h.goal.view(); h.advance(10000);
    h.session.gen++; h.session.running = true;
    assert.equal(h.goal.resume().ok, false);
    assert.equal(h.goal.resume({ adoptSession: { ...h.session } }).ok, false);
    const result = h.goal.resume({ adoptSession: h.session, engine: 'codex' });
    assert.equal(result.ok, true); assert.equal(result.resumed, true);
    for (const key of ['id', 'objective', 'criterion', 'createdAt', 'elapsedMs', 'revision', 'lastRevision'])
      assert.deepEqual(result.goal[key], original[key], key);
    assert.equal(result.goal.phase, 'active'); assert.equal(result.goal.armed, true); assert.equal(result.goal.engine, 'codex');
    assert.equal(result.goal.roundsStarted, original.roundsStarted + 1); assert.equal(result.goal.blockedReason, null);
    assert.equal(h.goal.ownedSession(), h.session); assert.equal(h.timers.size, 0); assert.equal(h.prompts.length, 1);
    const resumed = h.goal.view(); h.advance(2000);
    assert.equal(h.goal.resume({ adoptSession: h.session }).resumed, false); assert.deepEqual(h.goal.view(), resumed);
    h.result({ result: 'Next step done' }); assert.equal(h.timers.size, 1);
    h.tick(); assert.match(h.prompts.at(-1), /Goal continuation.*Finish/);
    assert.equal(h.goal.view().roundsStarted, original.roundsStarted + 2);
    h.goal.setPhase('paused'); assert.equal(h.goal.view().elapsedMs, original.elapsedMs + 2000);
  }
});

test('conversation controls stop automatic work while allowing the current reply to acknowledge them', t => {
  for (const action of ['pause', 'complete', 'remove']) {
    let checks = 0;
    const h = setup(t, { verifyCompletion: async () => { checks++; return { pass: true }; } });
    h.goal.start({ objective: 'Finish', criterion: 'Tests pass' }); h.tick(); h.advance(3000);
    const original = h.goal.view();
    const result = action === 'remove' ? h.goal.clear({ interrupt: false })
      : h.goal.setPhase(action === 'pause' ? 'paused' : 'complete', { interrupt: false });
    assert.equal(result.ok, true); assert.equal(h.interrupts(), 0); assert.equal(h.session.running, true);
    assert.equal(h.goal.armed, false); assert.equal(h.timers.size, 0);
    if (action === 'remove') {
      assert.equal(h.goal.view(), null); assert.equal(fs.existsSync(h.options.file()), false);
    } else {
      assert.equal(result.goal.id, original.id); assert.equal(result.goal.criterion, original.criterion);
      assert.equal(result.goal.phase, action === 'pause' ? 'paused' : 'complete');
      assert.equal(result.goal.elapsedMs, 3000); assert.equal(result.goal.roundsStarted, original.roundsStarted);
      assert.equal(result.goal.verified, null);
    }
    h.result({ goalReport: { status: 'complete', reason: 'Stale claim' }, result: '<goal:complete>' });
    assert.equal(checks, 0); assert.equal(h.timers.size, 0);
    assert.equal(h.goal.view()?.phase || null, action === 'remove' ? null : action === 'pause' ? 'paused' : 'complete');
  }
});

test('pausing and resuming the same reply does not count the round twice', t => {
  const h = setup(t); h.goal.start({ objective: 'Finish' }); h.tick(); h.advance(3000);
  for (let i = 0; i < 2; i++) {
    h.goal.setPhase('paused', { interrupt: false });
    assert.equal(h.goal.resume({ adoptSession: h.session }).ok, true);
    assert.equal(h.goal.view().roundsStarted, 1); assert.equal(h.goal.view().elapsedMs, 3000);
    assert.equal(h.timers.size, 0); assert.equal(h.interrupts(), 0);
  }
  h.result({ result: 'Continue next round' }); h.tick(); assert.equal(h.goal.view().roundsStarted, 2);
});

test('manual stopping actions cancel verification and ignore a late passing verdict', async t => {
  for (const action of ['pause', 'complete', 'remove']) {
    let resolveCheck, signal;
    const h = setup(t, { verifyCompletion: (_, options) => {
      signal = options.signal; return new Promise(resolve => { resolveCheck = resolve; });
    } });
    h.goal.start({ objective: 'Finish' }); h.tick(); h.result({ result: '<goal:complete>' });
    assert.ok(h.goal.view().verifying);
    if (action === 'remove') h.goal.clear({ interrupt: false });
    else h.goal.setPhase(action === 'pause' ? 'paused' : 'complete', { interrupt: false });
    assert.equal(signal.aborted, true);
    resolveCheck({ pass: true, reason: 'Old evidence' }); await h.settle();
    assert.equal(h.goal.view()?.phase || null, action === 'remove' ? null : action === 'pause' ? 'paused' : 'complete');
    assert.equal(h.goal.view()?.verified || null, null); assert.equal(h.timers.size, 0);
  }
});

test('resume never adopts a stale turn, steals an active goal or reopens a completed goal', t => {
  const h = setup(t); h.session.running = true;
  assert.equal(h.goal.resume({ adoptSession: h.session }).ok, false);
  h.session.running = false; h.goal.start({ objective: 'Finish' });
  h.session.running = true;
  assert.equal(h.goal.resume({ adoptSession: h.session }).ok, false);
  h.session.running = false; h.tick(); h.result({ result: '<goal:complete>' });
  h.session.gen++; h.session.running = true;
  assert.equal(h.goal.resume({ adoptSession: h.session }).ok, false);
  assert.equal(h.goal.view().phase, 'complete'); assert.equal(h.timers.size, 0);
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
  for (const text of ['Use <goal:complete> when done', '> <goal:complete>', '    <goal:complete>', '~~~text\n<goal:complete>\n~~~', '```text\n<goal:complete>', '> <goal:waiting>', '```\n<goal:waiting>\n```']) {
    h.tick(); h.result({ result: text }); assert.equal(h.goal.view().phase, 'active'); assert.equal(h.goal.view().waiting, null);
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

test('revising an active goal preserves its identity, ownership and accumulated progress', t => {
  const h = setup(t);
  h.goal.start({ objective: 'Build a website', criterion: 'Browser test passes', sessionId: 'conversation', workspaceId: 'workspace', engine: 'codex' });
  h.tick(); h.advance(5000);
  h.goal.touch({ errorStreak: 2, lastErrorSubtype: 'network', blockerStreak: 2, lastBlocker: 'Old blocker', verifyStreak: 2, lastVerify: 'Old criterion unmet', verified: { evidence: 'Old evidence' } });
  const before = h.goal.view(), owner = h.goal.owner;
  const update = { objective: ' Build a library ', criterion: ' Library tests pass ', reason: 'The user changed the deliverable', user_request: '改成库' };
  const revised = h.goal.revise(update);
  assert.equal(revised.ok, true); assert.equal(revised.updated, true);
  for (const key of ['id', 'createdAt', 'roundsStarted', 'elapsedMs', 'activeSince', 'sessionId', 'workspaceId', 'engine', 'phase', 'armed'])
    assert.equal(revised.goal[key], before[key], key);
  assert.equal(h.goal.owner, owner); assert.equal(h.goal.ownedSession(), h.session);
  assert.equal(h.interrupts(), 0); assert.equal(h.timers.size, 0);
  assert.equal(revised.goal.revision, 1); assert.equal(revised.goal.objective, 'Build a library');
  assert.deepEqual(revised.goal.lastRevision, { at: 6000, reason: update.reason, userRequest: update.user_request,
    previousObjective: 'Build a website', previousCriterion: 'Browser test passes' });
  assert.equal(revised.goal.errorStreak, 0); assert.equal(revised.goal.blockerStreak, 0); assert.equal(revised.goal.verifyStreak, 0);
  assert.equal(revised.goal.lastVerify, null); assert.equal(revised.goal.verified, null);
  const saved = fs.readFileSync(h.options.file(), 'utf8');
  assert.equal(JSON.parse(saved).criterion, 'Library tests pass');
  h.advance(1000);
  assert.equal(h.goal.revise(update).updated, false);
  assert.equal(fs.readFileSync(h.options.file(), 'utf8'), saved);
  h.result({ result: 'Updated the deliverable' }); h.tick();
  assert.match(h.prompts.at(-1), /Goal continuation.*Build a library/);
  assert.match(h.prompts.at(-1), /Completion criterion.*Library tests pass/);
  assert.match(h.prompts.at(-1), /Latest user instruction: 改成库/);
  assert.doesNotMatch(h.prompts.at(-1), /Build a website|Browser test passes|Old criterion/);
});

test('paused and blocked goal revisions stay stopped and persist across restart', t => {
  for (const phase of ['paused', 'blocked']) {
    const h = setup(t); h.goal.start({ objective: 'Original', criterion: 'Original criterion' });
    h.goal.setPhase(phase);
    const revised = h.goal.revise({ criterion: '', reason: 'The user removed the criterion', user_request: '不要这个条件' });
    assert.equal(revised.ok, true); assert.equal(revised.goal.objective, 'Original'); assert.equal(revised.goal.criterion, null);
    assert.equal(revised.goal.phase, phase); assert.equal(revised.goal.armed, false); assert.equal(h.timers.size, 0);
    const restored = new ClaudeGoal(h.options); restored.load();
    assert.equal(restored.view().criterion, null); assert.equal(restored.view().revision, 1);
    assert.equal(restored.view().phase, phase); assert.equal(restored.view().armed, false);
  }
});

test('missing, complete and invalid goals cannot be revised', t => {
  const h = setup(t), update = { objective: 'New', reason: 'Changed scope', user_request: 'New request' };
  assert.equal(h.goal.revise(update).ok, false);
  h.goal.start({ objective: 'Original' });
  const expected = h.goal.view();
  for (const bad of [{ ...update, objective: '' }, { ...update, objective: null }, { ...update, criterion: 1 },
    { ...update, reason: '' }, { ...update, user_request: '' }, { reason: 'No fields', user_request: 'New request' }]) {
    assert.equal(h.goal.revise(bad).ok, false); assert.deepEqual(h.goal.view(), expected);
  }
  h.goal.setPhase('complete'); assert.equal(h.goal.revise(update).ok, false);
  assert.equal(h.goal.view().objective, 'Original'); assert.equal(h.goal.view().phase, 'complete');
});

test('goals saved before revision support can be revised without migration', t => {
  const h = setup(t); h.goal.start({ objective: 'Legacy goal', criterion: 'Keep this criterion' }); h.goal.setPhase('paused');
  const saved = JSON.parse(fs.readFileSync(h.options.file(), 'utf8')); delete saved.revision; delete saved.lastRevision;
  fs.writeFileSync(h.options.file(), JSON.stringify(saved));
  const restored = new ClaudeGoal(h.options); restored.load();
  const updated = restored.revise({ objective: 'Current goal', reason: 'Changed scope', user_request: 'New scope' });
  assert.equal(updated.ok, true); assert.equal(updated.goal.revision, 1); assert.equal(updated.goal.criterion, 'Keep this criterion');
  assert.equal(updated.goal.id, saved.id); assert.equal(updated.goal.phase, 'paused');
});

test('a revision aborts old verification and ignores late success, rejection and errors', async t => {
  for (const outcome of [{ pass: true, reason: 'Old success' }, { pass: false, reason: 'Old failure' }, new Error('Old error')]) {
    const checks = [];
    const h = setup(t, { verifyCompletion: (claim, { signal }) => new Promise((resolve, reject) => checks.push({ claim, signal, resolve, reject })) });
    h.goal.start({ objective: 'Original', criterion: 'Old criterion' }); h.tick(); h.result({ result: '<goal:complete>' });
    assert.equal(h.goal.revise({ objective: 'Revised', criterion: 'New criterion', reason: 'Changed scope', user_request: 'Use the new scope' }).ok, true);
    assert.equal(checks[0].signal.aborted, true); assert.equal(h.goal.view().verifying, null);
    const expected = h.goal.view();
    if (outcome instanceof Error) checks[0].reject(outcome); else checks[0].resolve(outcome);
    await h.settle(); assert.deepEqual(h.goal.view(), expected); assert.equal(h.timers.size, 1);
    h.tick(); h.result({ goalReport: { status: 'complete', reason: 'Revised work checked' } });
    assert.equal(checks[1].claim.objective, 'Revised'); assert.equal(checks[1].claim.criterion, 'New criterion');
    checks[1].resolve({ pass: true, reason: 'New evidence' }); await h.settle();
    assert.equal(h.goal.view().phase, 'complete'); assert.equal(h.goal.view().verified.evidence, 'New evidence');
  }
});

test('a revision replaces a pending verification retry with work toward the current goal', async t => {
  let checks = 0;
  const h = setup(t, { verifyCompletion: async () => { checks++; return { error: 'Temporary network failure' }; } });
  h.goal.start({ objective: 'Original' }); h.tick(); h.result({ result: '<goal:complete>' }); await h.settle();
  h.goal.revise({ objective: 'Revised', reason: 'Changed scope', user_request: 'New scope' }); h.tick(); await h.settle();
  assert.equal(checks, 1); assert.equal(h.prompts.length, 2); assert.match(h.prompts.at(-1), /Revised/);
});

test('verify verdicts ignore fenced or quoted markers', () => {
  assert.equal(verifySignal('```\n<verify:pass>\n```'), null);
  assert.equal(verifySignal('> <verify:pass>'), null);
  assert.deepEqual(verifySignal('Checked.\n<verify:fail> tests missing'), { type: 'fail', reason: 'tests missing' });
  assert.deepEqual(verifySignal('<verify:pass> all green'), { type: 'pass', reason: 'all green' });
});

function denyGoalWrites(t, h) {
  const write = fs.writeFileSync;
  return t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (String(file).startsWith(h.options.file() + '.')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return write(file, ...args);
  });
}

test('failed adopted resume preserves saved progress and stops the adopted response', t => {
  const h = setup(t); h.goal.start({ objective: 'Finish' }); h.goal.setPhase('paused');
  const original = fs.readFileSync(h.options.file(), 'utf8');
  h.session.gen++; h.session.running = true;
  const write = denyGoalWrites(t, h), result = h.goal.resume({ adoptSession: h.session, engine: 'codex' });
  assert.equal(result.ok, false); assert.match(result.error, /disk full/);
  assert.equal(h.goal.armed, false); assert.equal(h.goal.ownedSession(), null);
  assert.equal(h.interrupts(), 1); assert.equal(h.timers.size, 0);
  assert.equal(fs.readFileSync(h.options.file(), 'utf8'), original);
  write.mock.restore();
});

test('failed revision persistence keeps the saved objective and stops its owned response', t => {
  const h = setup(t); h.goal.start({ objective: 'Original', criterion: 'Original criterion' }); h.tick();
  const saved = fs.readFileSync(h.options.file(), 'utf8'), write = denyGoalWrites(t, h);
  const revised = h.goal.revise({ objective: 'Revised', reason: 'Changed scope', user_request: 'New scope' });
  assert.equal(revised.ok, false); assert.match(revised.error, /disk full/);
  assert.equal(h.goal.view().objective, 'Original'); assert.equal(h.goal.view().revision, 0);
  assert.equal(h.goal.view().armed, false); assert.equal(h.interrupts(), 1); assert.equal(h.timers.size, 0);
  assert.equal(fs.readFileSync(h.options.file(), 'utf8'), saved); write.mock.restore();
});

test('a goal that cannot be saved never starts or reports success', t => {
  const changes = [], h = setup(t, { onChange: (goal, error) => changes.push({ goal, error }) });
  const write = denyGoalWrites(t, h);
  const result = h.goal.start({ objective: 'Finish' });
  assert.equal(result.ok, false); assert.match(result.error, /disk full/);
  assert.equal(h.goal.view(), null); assert.equal(h.goal.armed, false);
  assert.equal(h.timers.size, 0); assert.equal(h.prompts.length, 0);
  assert.match(changes.at(-1).error, /Could not save goal/);
  write.mock.restore();
  assert.equal(h.goal.start({ objective: 'Try again' }).ok, true);
});

test('failure to persist a continuation stops before sending another model request', t => {
  const h = setup(t); h.goal.start({ objective: 'Finish' });
  const original = fs.readFileSync(h.options.file(), 'utf8'), write = denyGoalWrites(t, h);
  h.tick();
  assert.equal(h.prompts.length, 0); assert.equal(h.timers.size, 0);
  assert.equal(h.goal.view().phase, 'blocked'); assert.equal(h.goal.view().blockedReason.code, 'storage-error');
  assert.equal(h.goal.view().roundsStarted, 0);
  assert.equal(fs.readFileSync(h.options.file(), 'utf8'), original);
  write.mock.restore();
});

for (const action of ['setPhase', 'clear']) for (const interrupt of [true, false]) test('failed goal ' + action + ' with interrupt=' + interrupt + ' keeps the saved record and still stops its owned turn', t => {
  const h = setup(t); h.goal.start({ objective: 'Finish' }); h.tick();
  const original = fs.readFileSync(h.options.file(), 'utf8');
  const write = denyGoalWrites(t, h), unlink = fs.unlinkSync;
  const exists = fs.existsSync;
  const hidden = t.mock.method(fs, 'existsSync', file => file === h.options.file() ? false : exists(file));
  const remove = t.mock.method(fs, 'unlinkSync', (file, ...args) => {
    if (file === h.options.file()) throw Object.assign(new Error('cannot remove goal'), { code: 'EACCES' });
    return unlink(file, ...args);
  });
  const result = action === 'clear' ? h.goal.clear({ interrupt }) : h.goal.setPhase('complete', { interrupt });
  assert.equal(result.ok, false); assert.ok(result.error);
  assert.equal(h.goal.armed, false); assert.equal(h.timers.size, 0); assert.equal(h.interrupts(), 1);
  assert.notEqual(h.goal.view().phase, 'complete');
  assert.equal(fs.readFileSync(h.options.file(), 'utf8'), original);
  h.result({ result: '<goal:complete>' }); assert.equal(h.timers.size, 0);
  write.mock.restore(); remove.mock.restore(); hidden.mock.restore();
  assert.equal(h.goal.clear().ok, true);
});

test('verifier transport failure retries verification without rerunning the completed work', async t => {
  let checks = 0;
  const h = setup(t, { verifyCompletion: async () => ++checks === 1 ? { error: 'Temporary network failure' } : { pass: true, reason: 'Verified files' } });
  h.goal.start({ objective: 'Finish' }); h.tick(); h.result({ result: '<goal:complete> Done' });
  await h.settle(); h.tick(); await h.settle();
  assert.equal(checks, 2); assert.equal(h.prompts.length, 1);
  assert.equal(h.goal.view().phase, 'complete');
});

test('a corrupt goal is retained separately and does not prevent a new goal', t => {
  const warnings = [], h = setup(t, { onLoadError: error => warnings.push(error) });
  const damaged = '{"objective":"keep this'; fs.writeFileSync(h.options.file(), damaged);
  h.goal.load();
  assert.equal(h.goal.view(), null); assert.equal(warnings.length, 1);
  assert.equal(fs.readFileSync(warnings[0].backupFile, 'utf8'), damaged);
  assert.equal(h.goal.start({ objective: 'New work' }).ok, true);
});
