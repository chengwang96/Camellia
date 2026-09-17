'use strict';

function createClaudeGoalUI({ $, context, canChangeContext, openHistorySession, acceptEvents, setStatus, onChange }) {
  let goalState = null, expanded = false, pending = false, ticker = null;
  const active = () => Boolean(goalState?.phase === 'active' && goalState.armed);
  const controls = ['goalStartBtn', 'goalPauseBtn', 'goalResumeBtn', 'goalCompleteBtn', 'goalClearBtn'];

  function renderElapsed() {
    if (!goalState) return;
    const ms = (goalState.elapsedMs || 0) + (active() && Number.isFinite(goalState.activeSince) ? Math.max(0, Date.now() - goalState.activeSince) : 0);
    const seconds = Math.floor(ms / 1000), minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
    $('goalElapsed').textContent = [hours ? hours + 'h' : '', minutes || hours ? minutes % 60 + 'm' : '', seconds % 60 + 's'].filter(Boolean).join(' ');
  }

  function renderDetails() {
    $('goalDetails').hidden = !expanded;
    $('goalExpandBtn').setAttribute('aria-expanded', String(expanded));
    const label = expanded ? 'Hide goal details' : 'Show goal details';
    $('goalExpandBtn').setAttribute('aria-label', label);
    $('goalExpandBtn').title = label;
  }

  function renderGoalBar() {
    clearInterval(ticker);
    ticker = null;
    onChange();
    const bar = $('goalBar');
    if (!goalState) {
      bar.classList.remove('visible');
      return;
    }
    bar.classList.add('visible');
    $('goalEntry').hidden = true;
    $('goalCard').hidden = false;
    $('goalObjective').textContent = goalState.objective;
    $('goalObjective').title = goalState.objective;
    $('goalFullObjective').textContent = goalState.objective;
    const phase = goalState.phase === 'active' && !goalState.armed ? 'paused' : goalState.phase;
    const phaseMap = { active: 'Goal in progress', paused: 'Goal paused', blocked: 'Goal blocked', complete: 'Goal completed' };
    $('goalPhase').textContent = phaseMap[phase] || phase;
    $('goalPhase').className = 'goal-phase ' + phase;
    const hints = {
      active: goalState.errorStreak ? 'Retrying after an execution error…' : goalState.blockerStreak ? 'Checking whether the blocker can be resolved…' : 'Continues automatically until the goal is complete or blocked.',
      paused: 'Paused. Resume when you are ready to continue.',
      blocked: 'Resolve the issue below, then resume the goal.',
      complete: 'The goal has been marked complete. Automatic continuation has stopped.',
    };
    $('goalMeta').textContent = hints[phase] || '';
    $('goalReason').hidden = phase !== 'blocked' || !goalState.blockedReason;
    $('goalReason').textContent = goalState.blockedReason?.message || goalState.blockedReason?.code || '';
    $('goalPauseBtn').hidden = !active();
    $('goalResumeBtn').hidden = !['paused', 'blocked'].includes(phase);
    $('goalCompleteBtn').hidden = phase === 'complete';
    renderDetails();
    renderElapsed();
    if (active()) ticker = setInterval(renderElapsed, 1000);
  }

  function receiveGoal(goal) {
    if (goal?.id !== goalState?.id) expanded = false;
    if (goal?.phase === 'blocked' && goalState?.phase !== 'blocked') expanded = true;
    goalState = goal;
    renderGoalBar();
  }

  function showGoalInput() {
    $('goalBar').classList.add('visible');
    $('goalEntry').hidden = false;
    $('goalCard').hidden = true;
    $('goalInput').focus();
  }

  async function refreshGoal() {
    const sessionId = context.sessionId;
    try {
      const res = await chatApi.goalGet(sharedChat ? { sessionId } : undefined);
      if (sessionId !== context.sessionId) return;
      if (res?.ok) receiveGoal(res.goal);
      else setStatus(res?.error || 'Could not load the goal');
    } catch (error) { setStatus('Could not load the goal: ' + error.message); }
  }

  async function updateGoal(action, message) {
    if (pending) return false;
    pending = true;
    const sessionId = context.sessionId;
    for (const id of controls) $(id).disabled = true;
    try {
      const res = await action();
      if (!res?.ok) throw new Error(res?.error || 'Could not update the goal');
      if (sessionId !== context.sessionId) return false;
      if (sharedChat && res.sessionId) context.sessionId = res.sessionId;
      receiveGoal(res.goal);
      if (message) setStatus(message);
      return true;
    } catch (error) { setStatus(error.message); return false; }
    finally {
      pending = false;
      for (const id of controls) $(id).disabled = false;
    }
  }

  $('goalStartBtn').addEventListener('click', async () => {
    const objective = $('goalInput').value.trim();
    if (!objective || !canChangeContext()) return;
    acceptEvents();
    if (await updateGoal(() => chatApi.goalStart({ objective, sessionId: context.sessionId, workspaceId: context.workspaceId }), 'Goal started. Working until complete or blocked…')) $('goalInput').value = '';
  });
  $('goalInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); $('goalStartBtn').click(); }
    if (event.key === 'Escape' && !goalState) { $('goalBar').classList.remove('visible'); $('goalPillBtn').focus(); }
  });
  $('goalPauseBtn').addEventListener('click', () => updateGoal(() => chatApi.goalPause(sharedChat ? { sessionId: context.sessionId } : undefined), 'Goal paused. Stopping the current response…'));
  $('goalResumeBtn').addEventListener('click', async () => {
    if (pending || !goalState || !canChangeContext()) return;
    if (goalState.sessionId && !await openHistorySession(goalState.sessionId)) return;
    if (!goalState.sessionId) context.workspaceId = goalState.workspaceId || null;
    acceptEvents();
    await updateGoal(() => chatApi.goalResume(sharedChat ? { sessionId: context.sessionId } : undefined), 'Goal resumed. Continuing automatically…');
  });
  $('goalCompleteBtn').addEventListener('click', () => updateGoal(() => chatApi.goalComplete(sharedChat ? { sessionId: context.sessionId } : undefined), 'Goal marked complete.'));
  $('goalClearBtn').addEventListener('click', async () => {
    if (await updateGoal(() => chatApi.goalClear(sharedChat ? { sessionId: context.sessionId } : undefined), 'Goal removed. Automatic work has stopped.')) $('goalPillBtn').focus();
  });
  $('goalExpandBtn').addEventListener('click', () => { expanded = !expanded; renderDetails(); });
  chatApi.onGoal(event => {
    if (!sharedChat) return receiveGoal(event);
    if (event?.sessionId !== context.sessionId) return;
    receiveGoal(Object.prototype.hasOwnProperty.call(event, 'goal') ? event.goal : event);
  });

  function toggleGoal() {
    if (goalState) { expanded = !expanded; renderGoalBar(); }
    else if ($('goalBar').classList.contains('visible')) $('goalBar').classList.remove('visible');
    else showGoalInput();
  }
  $('goalPillBtn').addEventListener('click', toggleGoal);
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'g') { event.preventDefault(); toggleGoal(); }
  });
  window.addEventListener('beforeunload', () => clearInterval(ticker));
  return { refresh: refreshGoal, isActive: active };
}
