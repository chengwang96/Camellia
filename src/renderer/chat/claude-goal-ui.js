'use strict';

function createClaudeGoalUI({ $, context, canChangeContext, openHistorySession, acceptEvents, setStatus, onChange }) {
  // ---------- P2: goal bar ----------
  let goalState = null;
  function renderGoalBar() {
    onChange();
    const bar = $('goalBar');
    if (!goalState) {
      bar.classList.remove('visible');
      return;
    }
    bar.classList.add('visible');
    $('goalInputRow').style.display = 'none';
    const card = $('goalCard');
    card.style.display = 'block';
    $('goalObjective').textContent = goalState.objective;
    $('goalObjective').title = goalState.objective;
    const phaseMap = { active: "In progress", paused: "Paused", blocked: "Blocked", complete: "Completed" };
    const ph = $('goalPhase');
    ph.textContent = phaseMap[goalState.phase] || goalState.phase;
    ph.className = 'goal-phase ' + goalState.phase;
    $('goalMeta').textContent =
      "Round " + goalState.roundsStarted + ' / ' + goalState.maxRounds + " " +
      (goalState.phase === 'active' ? (goalState.armed ? " · Continuing automatically" : " · Waiting to continue") : '');
    const reason = $('goalReason');
    if (goalState.phase === 'blocked' && goalState.blockedReason) {
      reason.style.display = 'block';
      reason.textContent = "Blocked: " + (goalState.blockedReason.message || goalState.blockedReason.code);
    } else {
      reason.style.display = 'none';
    }
    $('goalPauseBtn').style.display = goalState.phase === 'active' && goalState.armed ? '' : 'none';
    $('goalResumeBtn').style.display = (goalState.phase === 'paused' || goalState.phase === 'blocked' || (goalState.phase === 'active' && !goalState.armed)) ? '' : 'none';
  }
  function showGoalInput() {
    $('goalBar').classList.add('visible');
    $('goalInputRow').style.display = 'flex';
    $('goalCard').style.display = 'none';
    $('goalInput').focus();
  }
  async function refreshGoal() {
    const res = await chatApi.goalGet();
    goalState = res && res.ok ? res.goal : null;
    renderGoalBar();
  }
  $('goalStartBtn').addEventListener('click', async () => {
    const objective = $('goalInput').value.trim();
    if (!objective) return;
    if (!canChangeContext()) return;
    acceptEvents();
    const res = await chatApi.goalStart({ objective, maxRounds: Number($('goalRounds').value) || 10, sessionId: context.sessionId, workspaceId: context.workspaceId });
    if (res && res.ok) {
      goalState = res.goal;
      $('goalInput').value = '';
      renderGoalBar();
      setStatus("Goal started. Continuing automatically…");
    } else {
      setStatus("Failed to start: " + ((res && res.error) || "Unknown error"));
    }
  });
  $('goalInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); $('goalStartBtn').click(); }
  });
  $('goalPauseBtn').addEventListener('click', async () => { goalState = (await chatApi.goalPause()).goal; renderGoalBar(); });
  $('goalResumeBtn').addEventListener('click', async () => {
    if (!canChangeContext()) return;
    if (goalState.sessionId && !await openHistorySession(goalState.sessionId)) return;
    if (!goalState.sessionId) context.workspaceId = goalState.workspaceId || null;
    acceptEvents();
    const res = await chatApi.goalResume();
    if (res && res.ok) { goalState = res.goal; renderGoalBar(); }
    else setStatus((res && res.error) || "Could not resume the goal");
  });
  $('goalCompleteBtn').addEventListener('click', async () => { goalState = (await chatApi.goalComplete()).goal; renderGoalBar(); });
  $('goalClearBtn').addEventListener('click', async () => {
    await chatApi.goalClear();
    goalState = null;
    showGoalInput();
  });
  chatApi.onGoal((g) => { goalState = g; renderGoalBar(); });

  // Goal entry: header pill toggles the goal bar (Ctrl+G also works).
  $('goalPillBtn').addEventListener('click', () => {
    if ($('goalBar').classList.contains('visible') && !goalState) {
      $('goalBar').classList.remove('visible');
    } else if (goalState) {
      renderGoalBar();
    } else {
      showGoalInput();
    }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'g' || e.key === 'G')) {
      e.preventDefault();
      if (!goalState) showGoalInput(); else renderGoalBar();
    }
  });

  return { refresh: refreshGoal, isActive: () => Boolean(goalState?.phase === 'active' && goalState.armed) };
}
