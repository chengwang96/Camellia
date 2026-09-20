'use strict';

const fs = require('node:fs');
const { readJson, writeJson } = require('../shared/json-store');

// One driver owns its saved goal, continuation timer and in-flight turn.
// Loading a saved goal never grants permission to continue automatically.
class ClaudeGoal {
  constructor({ file, getSession, ensureSession, resolveWorkspace, onChange, log, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, verifyCompletion }) {
    Object.assign(this, { file, getSession, ensureSession, resolveWorkspace, onChange, log, setTimer, clearTimer, now, verifyCompletion });
    this.goal = null;
    this.armed = false;
    this.timer = null;
    this.owner = null;
  }

  load() {
    try {
      const saved = readJson(this.file(), null);
      if (saved && typeof saved.objective === 'string') {
        this.goal = saved;
        if (saved.phase === 'active') {
          // Count only time known to have elapsed before shutdown, never time offline.
          Object.assign(this.goal, this.stoppedClock(saved.updatedAt), { phase: 'paused' });
        }
      }
    }
    catch (err) { this.log(`goal: load failed: ${err.message}`); }
    this.armed = false;
  }

  view() { return this.goal ? { ...this.goal, armed: this.armed } : null; }

  publish() {
    try {
      if (this.goal) writeJson(this.file(), this.goal);
      else if (fs.existsSync(this.file())) fs.unlinkSync(this.file());
    } catch (err) { this.log(`goal: persist failed: ${err.message}`); }
    this.onChange(this.view());
  }

  touch(patch) {
    Object.assign(this.goal, patch, { updatedAt: this.now() });
    this.publish();
  }

  cancelTimer() {
    this.clearTimer(this.timer);
    this.timer = null;
  }

  schedule(delay) {
    this.cancelTimer();
    this.timer = this.setTimer(() => this.drive(), delay);
  }

  start(payload) {
    if (this.getSession()?.running) return { ok: false, error: "Wait for the response to finish or stop it before starting a goal" };
    const objective = String(payload.objective || '').trim();
    if (!objective) return { ok: false, error: "Goal cannot be empty" };
    if (this.goal && this.goal.phase !== 'complete') return { ok: false, error: "An unfinished goal already exists. Complete or clear it first." };
    this.goal = {
      id: 'goal-' + this.now().toString(36), objective, phase: 'active',
      criterion: String(payload.criterion || '').trim() || null,
      roundsStarted: 0, createdAt: this.now(), updatedAt: this.now(),
      elapsedMs: 0, activeSince: this.now(),
      blockedReason: null, errorStreak: 0, lastErrorSubtype: null,
      blockerStreak: 0, lastBlocker: null,
      verifyStreak: 0, lastVerify: null, verifying: null, verified: null,
      sessionId: payload.sessionId || null, workspaceId: this.resolveWorkspace(payload),
    };
    this.armed = true;
    this.owner = null;
    this.publish();
    this.schedule(100);
    return { ok: true, goal: this.view() };
  }

  setPhase(phase) {
    if (!this.goal) return { ok: false, error: "No current goal" };
    const session = this.ownedSession();
    this.armed = false;
    this.cancelTimer();
    this.touch({ ...this.stoppedClock(), phase, blockedReason: null, verifying: null });
    this.interrupt(session);
    return { ok: true, goal: this.view() };
  }

  resume() {
    if (!this.goal) return { ok: false, error: "No current goal" };
    if (this.goal.phase === 'complete') return { ok: false, error: "This goal is already complete. Start a new goal to do more work." };
    if (this.getSession()?.running) return { ok: false, error: "Wait for the response to finish or stop it before resuming the goal" };
    if (this.armed) return { ok: true, goal: this.view() };
    this.armed = true;
    this.touch({ phase: 'active', activeSince: this.now(), blockedReason: null, errorStreak: 0, lastErrorSubtype: null, blockerStreak: 0, lastBlocker: null, verifyStreak: 0, lastVerify: null, verifying: null });
    this.schedule(100);
    return { ok: true, goal: this.view() };
  }

  clear() {
    const session = this.ownedSession();
    this.goal = null;
    this.owner = null;
    this.armed = false;
    this.cancelTimer();
    this.publish();
    this.interrupt(session);
    return { ok: true, goal: null };
  }

  detachWorkspace(id) {
    if (this.goal?.workspaceId === id) this.touch({ workspaceId: null });
  }

  rememberSession(session) {
    if (this.owner?.goalId === this.goal?.id && this.owner?.gen === session.gen && session.sessionId && !this.goal.sessionId) {
      this.touch({ sessionId: session.sessionId });
    }
  }

  ownedSession() {
    const session = this.getSession();
    return this.owner && this.owner.goalId === this.goal?.id && this.owner.gen === session?.gen ? session : null;
  }

  interrupt(session) {
    if (!session?.running) return;
    try { session.interrupt?.(); }
    catch (error) { this.log(`goal: could not stop current response: ${error.message}`); }
  }

  stoppedClock(at = this.now()) {
    return { elapsedMs: (this.goal.elapsedMs || 0) + (Number.isFinite(this.goal.activeSince)
      ? Math.max(0, at - this.goal.activeSince) : 0), activeSince: null };
  }

  drive() {
    this.cancelTimer();
    if (!this.armed || this.goal?.phase !== 'active' || this.getSession()?.running) return;
    let session;
    try { session = this.ensureSession({ sessionId: this.goal.sessionId, workspaceId: this.goal.workspaceId }); }
    catch (err) { this.block('workspace-unavailable', err.message); return; }
    this.touch({ roundsStarted: this.goal.roundsStarted + 1 });
    this.owner = { goalId: this.goal.id, gen: session.gen };
    try {
      if (session.sendUserMessage(goalPrompt(this.goal))) this.rememberSession(session);
      else this.block('session-unavailable', "Session process is unavailable; cannot continue");
    } catch (error) { this.block('session-unavailable', error.message); }
  }

  block(code, message) {
    if (!this.goal) return;
    this.armed = false;
    this.cancelTimer();
    this.touch({ ...this.stoppedClock(), phase: 'blocked', blockedReason: { code, message } });
    this.log(`goal: blocked (${code}): ${message}`);
  }

  handleResult(event) {
    const session = this.getSession();
    if (!this.owner || this.owner.goalId !== this.goal?.id || this.owner.gen !== session?.gen) return;
    this.rememberSession(session);
    this.owner = null;
    if (!this.armed || this.goal.phase !== 'active') return;
    if (event.subtype === 'stopped') { this.setPhase('paused'); return; }
    if (event.is_error) {
      const subtype = event.subtype || 'unknown';
      const streak = (this.goal.errorStreak || 0) + 1;
      this.touch({ errorStreak: streak, lastErrorSubtype: subtype, blockerStreak: 0, lastBlocker: null });
      if (streak >= 3) { this.block('repeated-errors', `Execution failed 3 times in a row. ${event.result || subtype}`); return; }
      this.schedule(1200 * streak);
      return;
    }
    const signal = goalSignal(event.result);
    if (signal?.type === 'complete') { void this.verify(event.result); return; }
    if (signal?.type === 'blocked') {
      const streak = (this.goal.blockerStreak || 0) + 1;
      const reason = signal.reason || 'The model reported that it cannot make further progress';
      this.touch({ blockerStreak: streak, lastBlocker: reason, errorStreak: 0, lastErrorSubtype: null });
      if (streak >= 3) { this.block('model-reported', reason); return; }
    } else this.touch({ blockerStreak: 0, lastBlocker: null, errorStreak: 0, lastErrorSubtype: null });
    this.schedule(1200);
  }

  // A completion claim is never taken at face value when a verifier is wired:
  // an independent session checks it against the goal and criterion first.
  async verify(report) {
    if (!this.goal || this.goal.phase !== 'active' || !this.armed) return;
    if (typeof this.verifyCompletion !== 'function') { this.setPhase('complete'); return; }
    this.touch({ verifying: { at: this.now(), report: String(report || '').slice(0, 4000) } });
    let verdict;
    try { verdict = await this.verifyCompletion({ objective: this.goal.objective, criterion: this.goal.criterion || '', report }); }
    catch (error) { verdict = { error: error.message }; }
    if (!this.goal || this.goal.phase !== 'active' || !this.armed) return;
    this.touch({ verifying: null });
    if (verdict.pass === true) {
      this.touch({ verifyStreak: 0, lastVerify: null, verified: { at: this.now(), evidence: verdict.reason || '' } });
      this.setPhase('complete');
      return;
    }
    if (verdict.pass === false) {
      const streak = (this.goal.verifyStreak || 0) + 1;
      this.touch({ verifyStreak: streak, lastVerify: verdict.reason || 'The verifier found the goal incomplete', errorStreak: 0, lastErrorSubtype: null });
      if (streak >= 3) { this.block('verification-failed', this.goal.lastVerify); return; }
      this.schedule(1200);
      return;
    }
    // The verifier itself failed to run; treat it as a transient execution error.
    const streak = (this.goal.errorStreak || 0) + 1;
    this.touch({ errorStreak: streak, lastErrorSubtype: 'verification-error' });
    if (streak >= 3) { this.block('repeated-errors', 'Verification could not run 3 times in a row. ' + (verdict.error || '')); return; }
    this.schedule(1200 * streak);
  }
}

// Only standalone status lines count; quoted instructions and code examples do not.
function goalSignal(result) {
  let fence = null, signal = null;
  for (const line of String(result || '').split(/\r?\n/)) {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (delimiter) {
      if (!fence) fence = delimiter[1];
      else if (delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const match = line.match(/^ {0,3}<goal:(complete|blocked)>[ \t]*(.*)$/i);
    if (match) signal = { type: match[1].toLowerCase(), reason: match[2].trim() };
  }
  return signal;
}

function goalPrompt(goal) {
  return [
    `[${goal.roundsStarted === 1 ? 'Goal' : 'Goal continuation'}] ${goal.objective}`,
    goal.criterion ? `Completion criterion (the acceptance standard an independent verifier will check): ${goal.criterion}` : null,
    'Keep working autonomously until this goal is fully achieved or a serious blocker prevents further progress. There is no fixed turn limit.',
    'Continue from the existing progress, verify the result, and fix recoverable errors. Do not stop after a plan, a partial result, or one failed approach. Do not repeat completed actions.',
    'Respect the configured permissions and the user\'s instructions. If permission or essential input is required, request it; never bypass it to keep the goal running.',
    'Only when all requested work and relevant verification are complete, run objective checks (tests, builds, inspecting changed files), report the concrete evidence, then output <goal:complete> on its own line. Never mark an incomplete goal complete. An independent verifier will review the claim against the goal and criterion; a rejected claim comes back as work to finish.',
    'If an external condition prevents all useful progress, explain what is needed to unblock it and output <goal:blocked> followed by a short reason on its own line. Try reasonable alternatives first. Camellia pauses after three consecutive blocker reports.',
    goal.lastBlocker ? `Previous blocker report (${goal.blockerStreak}/3): ${goal.lastBlocker}. Check whether it can be resolved or independent work remains. If it still blocks all progress, report it again.` : '',
    goal.lastVerify ? `The verifier rejected the completion claim (${goal.verifyStreak}/3): ${goal.lastVerify}. Address these gaps with real changes, then re-verify before claiming completion again.` : '',
    'Do not quote or put status markers in code blocks. Otherwise keep working; Camellia will continue automatically after this response.',
  ].filter(Boolean).join('\n\n');
}

// The verifier runs in a fresh session with no shared history: it judges the
// claim from the workspace state, not from the claimant's narration.
function verifyPrompt({ objective, criterion, report, cwd }) {
  return [
    'You are an independent verifier for an autonomous coding goal. Another agent claims the work below is complete. You share no context with it; trust nothing in the claim and check the workspace yourself.',
    `Goal: ${objective}`,
    criterion ? `Completion criterion: ${criterion}` : null,
    `Working directory: ${cwd}`,
    `The agent's completion claim: ${String(report || '').trim() || '(no evidence reported)'}`,
    'Inspect the files and run objective checks (tests, builds, git diff) as appropriate. Do not modify project files; temporary test artifacts are fine. Do not fix the work — your only job is to judge it.',
    'Then output exactly one verdict on its own line: <verify:pass> with a one-line evidence summary if the goal and every point of the criterion are genuinely met, or <verify:fail> followed by the specific gaps that remain.',
  ].filter(Boolean).join('\n\n');
}

function verifySignal(result) {
  let fence = null, signal = null;
  for (const line of String(result || '').split(/\r?\n/)) {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (delimiter) {
      if (!fence) fence = delimiter[1];
      else if (delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const match = line.match(/^ {0,3}<verify:(pass|fail)>[ \t]*(.*)$/i);
    if (match) signal = { type: match[1].toLowerCase(), reason: match[2].trim() };
  }
  return signal;
}

module.exports = { ClaudeGoal, verifyPrompt, verifySignal };
