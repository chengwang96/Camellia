'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ClaudeGoal } = require('../src/engines/claude-goal');
const { createHarness } = require('./claude-harness.cjs');

function setup(t) {
  const h = createHarness(); t.after(() => h.cleanup());
  const timers = new Set(), prompts = [];
  let now = 1000, interrupts = 0;
  const session = { gen: 1, sessionId: null, running: false, sendUserMessage(prompt) { prompts.push(prompt); this.running = true; return true; },
    interrupt() { interrupts++; this.running = false; } };
  const options = { file: () => path.join(h.root, 'goal.json'), getSession: () => session, ensureSession: () => session,
    resolveWorkspace: p => p.workspaceId || null, onChange() {}, log() {},
    setTimer: fn => { timers.add(fn); return fn; }, clearTimer: fn => timers.delete(fn), now: () => now };
  const goal = new ClaudeGoal(options);
  const tick = () => { assert.equal(timers.size, 1); [...timers][0](); };
  const result = event => { session.running = false; goal.handleResult(event); };
  return { goal, session, options, prompts, timers, tick, result, advance: ms => { now += ms; }, interrupts: () => interrupts };
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
