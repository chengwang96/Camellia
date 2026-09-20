'use strict';

// Goal lives inside the composer: a chip marks draft mode or the running goal,
// and the chip's menu carries details and controls. No bar above the input.
function createClaudeGoalUI({ $, context, canChangeContext, openHistorySession, acceptEvents, setStatus, onChange, openActionMenu, closePops }) {
  let goalState = null, draft = false, criterion = '', pending = false, ticker = null, savedPlaceholder = null;
  const input = $('input');
  const active = () => Boolean(goalState?.phase === 'active' && goalState.armed);

  const TARGET_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></svg>';

  function elapsed() {
    if (!goalState) return '';
    const ms = (goalState.elapsedMs || 0) + (active() && Number.isFinite(goalState.activeSince) ? Math.max(0, Date.now() - goalState.activeSince) : 0);
    const seconds = Math.floor(ms / 1000), minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
    return [hours ? hours + 'h' : '', minutes || hours ? minutes % 60 + 'm' : '', seconds % 60 + 's'].filter(Boolean).join(' ');
  }

  function chip(label, { className = '', title, onClick, onRemove, ariaLabel }) {
    const el = document.createElement(onRemove ? 'span' : 'button');
    el.className = 'goal-chip ' + className;
    if (title) el.title = title;
    if (ariaLabel) el.setAttribute('aria-label', ariaLabel);
    el.innerHTML = TARGET_SVG + '<span class="goal-chip-text"></span>' + (onRemove ? '<button class="attchip-x" title="Remove">✕</button>' : '');
    el.querySelector('.goal-chip-text').textContent = label;
    el.querySelector('.goal-chip-text').dataset.i18n = '';
    if (onClick) el.addEventListener('click', onClick);
    if (onRemove) el.querySelector('.attchip-x').addEventListener('click', (e) => { e.stopPropagation(); onRemove(); });
    return el;
  }

  function phaseOf() { return goalState?.phase === 'active' && !goalState.armed ? 'paused' : goalState?.phase; }

  function render() {
    clearInterval(ticker); ticker = null;
    onChange();
    const row = $('goalChipRow');
    row.replaceChildren();
    const toggle = $('goalToggle');
    toggle.hidden = !draft && !goalState;
    toggle.setAttribute('aria-pressed', String(draft || Boolean(goalState)));
    if (goalState) {
      const phase = phaseOf();
      const text = goalState.verifying && phase === 'active' ? 'Verifying…'
        : { active: 'Goal · ' + elapsed(), paused: 'Goal paused', blocked: 'Goal blocked', complete: goalState.verified ? 'Goal verified' : 'Goal completed' }[phase] || 'Goal';
      row.appendChild(chip(text, { className: phase, title: goalState.objective, onClick: (e) => openGoalMenu(e.currentTarget) }));
      row.hidden = false;
      if (active()) ticker = setInterval(render, 1000);
    } else if (draft) {
      row.appendChild(chip('Goal', { className: 'draft', title: 'Goal mode', onRemove: () => setDraft(false), ariaLabel: 'Goal mode' }));
      if (criterion) {
        row.appendChild(chip('Criterion: ' + criterion, { className: 'draft', title: criterion, onRemove: () => { criterion = ''; render(); }, ariaLabel: 'Completion criterion' }));
      } else {
        const add = document.createElement('button');
        add.className = 'goal-chip draft';
        add.innerHTML = '<span class="goal-chip-text" data-i18n>+ Criterion</span>';
        add.title = 'Completion criterion';
        add.addEventListener('click', () => { row.replaceChildren(); renderCriterionInput(); });
        row.appendChild(add);
      }
      row.hidden = false;
    } else {
      row.hidden = true;
    }
  }

  function renderCriterionInput() {
    const row = $('goalChipRow');
    row.appendChild(chip('Goal', { className: 'draft', title: 'Goal mode', onRemove: () => setDraft(false), ariaLabel: 'Goal mode' }));
    const field = document.createElement('input');
    field.className = 'goal-criterion-input';
    field.id = 'goalCriterionInput';
    field.placeholder = 'How will completion be verified? (optional)';
    field.setAttribute('aria-label', 'Completion criterion');
    field.dataset.i18nAttrs = 'aria-label placeholder';
    const commit = () => { criterion = field.value.trim(); render(); input.focus(); };
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { criterion = ''; render(); input.focus(); }
    });
    field.addEventListener('blur', commit);
    row.appendChild(field);
    field.focus();
  }

  function setDraft(value, focus = true) {
    draft = value;
    if (draft) {
      if (!savedPlaceholder) savedPlaceholder = input.placeholder;
      input.placeholder = window.goalDraftPlaceholder || 'Describe the goal, and what done looks like';
      if (focus) input.focus();
    } else {
      criterion = '';
      if (savedPlaceholder) { input.placeholder = savedPlaceholder; savedPlaceholder = null; }
    }
    render();
  }

  function openGoalMenu(anchor) {
    const phase = phaseOf();
    const items = [
      { label: goalState.objective, localize: false, disabled: true },
    ];
    if (goalState.criterion) items.push({ label: 'Criterion: ' + goalState.criterion, localize: false, disabled: true });
    if (goalState.lastVerify && phase === 'active') items.push({ label: 'Verifier: ' + goalState.lastVerify, localize: false, disabled: true });
    if (phase === 'blocked' && goalState.blockedReason) items.push({ label: goalState.blockedReason.message || goalState.blockedReason.code || '', localize: false, disabled: true });
    if (goalState.verified) items.push({ label: 'Verified: ' + goalState.verified.evidence, localize: false, disabled: true });
    if (active()) items.push({ label: 'Pause goal', run: () => updateGoal(() => chatApi.goalPause(sharedChat ? { sessionId: context.sessionId } : undefined), 'Goal paused. Stopping the current response…') });
    if (['paused', 'blocked'].includes(phase)) items.push({ label: 'Resume goal', run: resumeGoal });
    if (phase !== 'complete') items.push({ label: 'Mark complete', run: () => updateGoal(() => chatApi.goalComplete(sharedChat ? { sessionId: context.sessionId } : undefined), 'Goal marked complete.') });
    items.push({ label: 'Remove goal', run: () => updateGoal(() => chatApi.goalClear(sharedChat ? { sessionId: context.sessionId } : undefined), 'Goal removed. Automatic work has stopped.') });
    openActionMenu(anchor, items);
  }

  async function resumeGoal() {
    if (pending || !goalState || !canChangeContext()) return;
    if (goalState.sessionId && !await openHistorySession(goalState.sessionId)) return;
    if (!goalState.sessionId) context.workspaceId = goalState.workspaceId || null;
    acceptEvents();
    await updateGoal(() => chatApi.goalResume(sharedChat ? { sessionId: context.sessionId } : undefined), 'Goal resumed. Continuing automatically…');
  }

  function receiveGoal(goal) {
    goalState = goal;
    render();
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
    try {
      const res = await action();
      if (!res?.ok) throw new Error(res?.error || 'Could not update the goal');
      if (sessionId !== context.sessionId) return false;
      if (sharedChat && res.sessionId) context.sessionId = res.sessionId;
      receiveGoal(res.goal);
      if (message) setStatus(message);
      return true;
    } catch (error) { setStatus(error.message); return false; }
    finally { pending = false; }
  }

  // The composer send button starts the goal while draft mode is on.
  async function startFromComposer(objective) {
    if (!canChangeContext()) return false;
    acceptEvents();
    const started = await updateGoal(() => chatApi.goalStart({ objective, criterion, sessionId: context.sessionId, workspaceId: context.workspaceId }), 'Goal started. Working until complete or blocked…');
    if (started) setDraft(false, false);
    return started;
  }

  $('goalToggle').addEventListener('click', () => {
    if (goalState) openGoalMenu($('goalToggle'));
    else setDraft(!draft);
  });
  chatApi.onGoal(event => {
    if (!sharedChat) return receiveGoal(event);
    if (event?.sessionId !== context.sessionId) return;
    receiveGoal(Object.prototype.hasOwnProperty.call(event, 'goal') ? event.goal : event);
  });

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'g') {
      event.preventDefault();
      if (goalState) openGoalMenu($('goalToggle'));
      else setDraft(!draft);
    }
  });
  window.addEventListener('beforeunload', () => clearInterval(ticker));
  return { refresh: refreshGoal, isActive: active, isDraft: () => draft, startFromComposer,
    reveal: () => { if (goalState) openGoalMenu($('goalToggle')); else setDraft(true); } };
}
