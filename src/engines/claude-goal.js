'use strict';

const fs = require('node:fs');
const { readJson, writeJson } = require('../shared/json-store');

// One driver owns its saved goal, continuation timer and in-flight turn.
// Loading a saved goal never grants permission to continue automatically.
class ClaudeGoal {
  constructor({ file, getSession, ensureSession, resolveWorkspace, onChange, log, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { file, getSession, ensureSession, resolveWorkspace, onChange, log, setTimer, clearTimer });
    this.goal = null;
    this.armed = false;
    this.timer = null;
    this.owner = null;
  }

  load() {
    try {
      const saved = readJson(this.file(), null);
      if (saved && typeof saved.objective === 'string') this.goal = saved;
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
    Object.assign(this.goal, patch, { updatedAt: Date.now() });
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
      id: 'goal-' + Date.now().toString(36), objective, phase: 'active',
      maxRounds: Math.max(1, Math.min(999, Math.floor(Number(payload.maxRounds) || 10))),
      roundsStarted: 0, createdAt: Date.now(), updatedAt: Date.now(),
      blockedReason: null, errorStreak: 0, lastErrorSubtype: null,
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
    this.armed = false;
    this.cancelTimer();
    this.touch({ phase, blockedReason: null });
    return { ok: true, goal: this.view() };
  }

  resume() {
    if (!this.goal) return { ok: false, error: "No current goal" };
    if (this.getSession()?.running) return { ok: false, error: "Wait for the response to finish or stop it before resuming the goal" };
    if (this.goal.roundsStarted >= this.goal.maxRounds) return { ok: false, error: "Turn budget exhausted" };
    this.armed = true;
    this.touch({ phase: 'active', blockedReason: null, errorStreak: 0, lastErrorSubtype: null });
    this.schedule(100);
    return { ok: true, goal: this.view() };
  }

  clear() {
    this.goal = null;
    this.owner = null;
    this.armed = false;
    this.cancelTimer();
    this.publish();
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

  drive() {
    this.cancelTimer();
    if (!this.armed || this.goal?.phase !== 'active' || this.getSession()?.running) return;
    if (this.goal.roundsStarted >= this.goal.maxRounds) {
      this.block('rounds-exhausted', `Turn limit reached ${this.goal.maxRounds}`);
      return;
    }
    let session;
    try { session = this.ensureSession({ sessionId: this.goal.sessionId, workspaceId: this.goal.workspaceId }); }
    catch (err) { this.block('workspace-unavailable', err.message); return; }
    this.touch({ roundsStarted: this.goal.roundsStarted + 1 });
    this.owner = { goalId: this.goal.id, gen: session.gen };
    if (session.sendUserMessage(goalPrompt(this.goal))) this.rememberSession(session);
    else this.block('session-unavailable', "Session process is unavailable; cannot continue");
  }

  block(code, message) {
    this.armed = false;
    this.cancelTimer();
    this.touch({ phase: 'blocked', blockedReason: { code, message } });
    this.log(`goal: blocked (${code}): ${message}`);
  }

  handleResult(event) {
    const session = this.getSession();
    if (!this.owner || this.owner.goalId !== this.goal?.id || this.owner.gen !== session?.gen) return;
    this.rememberSession(session);
    this.owner = null;
    if (!this.armed || this.goal.phase !== 'active') return;
    const text = String(event.result || '').replace(/```[\s\S]*?(?:```|$)/g, '\n');
    if (/<goal:complete>/i.test(text)) { this.setPhase('complete'); return; }
    const blocked = text.match(/<goal:blocked>\s*([^\n]*)/i);
    if (blocked) { this.block('model-reported', blocked[1].trim() || "The model reported a blocker"); return; }
    if (event.is_error) {
      const subtype = event.subtype || 'unknown';
      const streak = (this.goal.lastErrorSubtype === subtype ? this.goal.errorStreak : 0) + 1;
      this.touch({ errorStreak: streak, lastErrorSubtype: subtype });
      if (streak >= 3) { this.block('repeated-errors', `Failed for 3 consecutive turns (last error: ${subtype})`); return; }
    } else if (this.goal.errorStreak) this.touch({ errorStreak: 0, lastErrorSubtype: null });
    this.schedule(1200);
  }
}

function goalPrompt(goal) {
  if (goal.roundsStarted === 1) return goal.objective;
  return [
    `[Goal continuation] Goal: ${goal.objective}`,
    `This is automatic continuation turn ${goal.roundsStarted} (budget: ${goal.maxRounds} turns). Continue from the previous progress.`,
    "When the goal is complete and no work remains, output a separate line containing <goal:complete> followed by a brief summary. Do not put the marker in a code block.",
    "When an external condition prevents further progress, output a separate line containing <goal:blocked> and explain the reason.",
    "Otherwise, keep working. Another continuation will follow this turn.",
  ].join('\n');
}

module.exports = { ClaudeGoal };
