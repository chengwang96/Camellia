'use strict';

function createScheduledTasksUI({ $, context, setStatus }) {
  const dialog = $('tasksDialog'), controls = $('tasksControls'), toggle = $('tasksToggle'), cancel = $('tasksCancel'), list = $('tasksList'), editor = $('tasksEditor');
  let sessionId = null, editing = null, pending = false, refreshSequence = 0, toggleSessionId = null;
  const translate = text => window.CamelliaI18n.t(text);
  const scheduling = window.CamelliaTaskSchedule;
  const localInput = at => {
    const value = new Date(at);
    return new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  let editingTask = null;
  function formOptions() {
    const scheduleType = $('taskSchedule').value;
    return { instruction: $('taskInstruction').value, scheduleType,
      ...(scheduleType === 'interval' ? { intervalMinutes: Number($('taskInterval').value) }
        : scheduleType === 'once' ? { runAt: new Date($('taskRunAt').value).toISOString() }
          : { dailyTime: $('taskDailyTime').value, timeZone: $('taskZone').value.trim() }),
      maxRuns: Number($('taskRuns').value), maxHours: Number($('taskHours').value), maxRepairs: Number($('taskRepairs').value) };
  }
  function updateScheduleFields() {
    const type = $('taskSchedule').value;
    for (const [field, input, visible] of [['taskIntervalField', 'taskInterval', type === 'interval'],
      ['taskOnceField', 'taskRunAt', type === 'once'], ['taskDailyField', 'taskDailyTime', type === 'daily'],
      ['taskZoneField', 'taskZone', type === 'daily']]) {
      $(field).hidden = !visible; $(input).required = visible;
    }
    updatePreview();
  }
  function updatePreview() {
    try {
      const options = formOptions(), now = Date.now();
      const schedule = scheduling.normalizeSchedule(options);
      const task = { ...options, schedule, lastRunAt: editingTask?.lastRunAt };
      const next = scheduling.nextTaskRun(task, now, { resume: Boolean(editingTask) });
      const deadline = (editingTask?.createdAt ?? now) + options.maxHours * 3600000;
      if (next <= now && !editingTask || next >= deadline) {
        $('taskPreview').textContent = translate('The next check must be in the future and before the deadline.');
        return;
      }
      let preview = scheduling.scheduleLabel(task, window.CamelliaI18n.locale) + ' · ' + translate('Next check') + ': ' + date(next);
      if (schedule.type === 'interval') {
        const count = Math.max(1, options.maxRuns - (editingTask?.runs || 0));
        preview += '\n' + translate('Without delays, checks end around') + ': ' + date(Math.min(deadline, next + (count - 1) * schedule.minutes * 60000));
      }
      $('taskPreview').textContent = preview + '\n' + translate('Deadline') + ': ' + date(deadline) + '\n' + translate('Check count and deadline: whichever is reached first. Check time and delays may extend the estimate.');
    } catch { $('taskPreview').textContent = translate('Choose a valid schedule to preview its next check.'); }
  }
  const call = async (action, payload = {}) => {
    const result = await window.dshDesktop.conversationCommand({ engine: harnessId, action: 'task-' + action, payload: { sessionId, ...payload } });
    if (!result.ok) throw new Error(result.error || 'Task operation failed');
    return result;
  };
  function element(tag, text, translated = false) {
    const node = document.createElement(tag); node.textContent = translated ? translate(text) : text;
    return node;
  }
  function resetForm() {
    editing = null; editingTask = null; $('tasksForm').reset(); $('taskSave').textContent = $('taskEditorTitle').textContent = translate('Create task');
    $('taskZone').value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    $('taskRunAt').value = localInput(Date.now() + 3600000); updateScheduleFields();
    $('taskEditCancel').hidden = true;
  }
  const date = at => new Date(at).toLocaleString(window.CamelliaI18n.locale);
  function setPending(value) {
    $('taskSave').disabled = cancel.disabled = toggle.disabled = value;
    dialog.querySelectorAll('.task-actions button, #tasksForm input, #tasksForm textarea, #tasksForm select, #taskEditCancel').forEach(node => { node.disabled = value; });
  }
  async function refresh() {
    const sequence = ++refreshSequence;
    const currentSessionId = context.sessionId;
    if (toggleSessionId !== currentSessionId) controls.hidden = true;
    toggleSessionId = currentSessionId;
    if (!currentSessionId) { controls.hidden = true; return; }
    const result = await call('list', { sessionId: currentSessionId });
    if (sequence !== refreshSequence || currentSessionId !== context.sessionId) return;
    controls.hidden = !result.tasks.some(task => task.stopping || ['scheduled', 'running', 'paused'].includes(task.status));
    if (!dialog.open || sessionId !== currentSessionId) return;
    const expanded = new Set([...list.querySelectorAll('details[open]')].map(node => node.id));
    $('tasksConflict').hidden = result.waitingFor !== 'goal';
    $('tasksConflict').textContent = translate('Goal mode owns this conversation. Scheduled checks wait until Goal is paused or finished; their deadline keeps running.');
    const focused = list.contains(document.activeElement) ? {
      taskId: document.activeElement.closest('.task-card')?.dataset.taskId,
      detailsId: document.activeElement.closest('details')?.id,
      action: document.activeElement.dataset.action,
    } : null;
    list.replaceChildren();
    if (!result.tasks.length) {
      const empty = element('p', 'No scheduled tasks in this conversation.', true); empty.className = 'tasks-empty'; list.append(empty);
    }
    for (const task of result.tasks) {
      const card = element('section', ''); card.className = 'task-card'; card.dataset.status = task.status; card.dataset.taskId = task.id;
      const status = { scheduled: 'Scheduled', running: 'Checking', paused: 'Paused', complete: 'Completed', cancelled: 'Cancelled' }[task.status] || task.status;
      const heading = element('div', ''); heading.className = 'task-heading';
      const badge = element('span', task.stopping ? 'Stopping check…' : status, true); badge.className = 'task-status';
      const counts = element('span', `${task.runs}/${task.maxRuns} ${translate('checks')} · ${task.repairs}/${task.maxRepairs} ${translate('recoveries')}`); counts.className = 'task-counts';
      heading.append(badge, counts); card.append(heading);
      const schedule = element('div', scheduling.scheduleLabel(task, window.CamelliaI18n.locale)); schedule.className = 'task-schedule'; card.append(schedule);
      const instruction = element('details', ''); instruction.className = 'task-instruction'; instruction.id = 'task-instruction-' + task.id;
      const summary = element('summary', '');
      const preview = element('span', task.instruction); preview.className = 'task-preview';
      const label = element('span', 'What to check', true); label.className = 'task-instruction-label';
      summary.append(preview, label); instruction.append(summary);
      const full = element('p', task.instruction); full.className = 'task-instruction-full'; instruction.append(full); card.append(instruction);
      const timing = element('div', ''); timing.className = 'task-timing';
      if (task.nextRunAt) timing.append(element('span', translate('Next check') + ': ' + date(task.nextRunAt)));
      timing.append(element('span', translate('Deadline') + ': ' + date(task.expiresAt))); card.append(timing);
      const notice = scheduling.taskNotice(task, window.CamelliaI18n.locale);
      if (notice) { const message = element('p', notice); message.className = 'task-notice'; card.append(message); }
      if (task.lastResult) { const result = element('p', task.lastResult); result.className = 'task-result'; card.append(result); }
      if (task.lastCheck?.summary && task.lastCheck.summary !== task.lastResult) {
        const evidence = element('p', translate('Last check result') + ': ' + task.lastCheck.summary); evidence.className = 'task-result'; card.append(evidence);
      }
      const actions = element('div', ''); actions.className = 'task-actions';
      function button(label, handler) {
        const control = element('button', label, true); control.type = 'button'; control.className = 'btn-secondary';
        control.dataset.action = label;
        control.addEventListener('click', async () => {
          await perform(handler);
          if (label === 'Edit task' && editing === task.id && dialog.open) $('taskInstruction').focus();
        }); actions.append(control);
      }
      if (!task.stopping && ['scheduled', 'running'].includes(task.status)) button('Pause', () => call('pause', { id: task.id }));
      if (!task.stopping && task.status === 'paused') {
        button('Resume', () => call('resume', { id: task.id }));
        button('Edit task', async () => {
          editing = task.id; editingTask = task; $('taskInstruction').value = task.instruction;
          for (const [field, key] of [['taskInterval', 'intervalMinutes'], ['taskRuns', 'maxRuns'], ['taskHours', 'maxHours'], ['taskRepairs', 'maxRepairs']]) $(field).value = task[key];
          let schedule;
          try { schedule = scheduling.normalizeSchedule(task); } catch { schedule = { type: 'interval' }; }
          $('taskSchedule').value = schedule.type;
          if (schedule.type === 'once') $('taskRunAt').value = localInput(schedule.at);
          if (schedule.type === 'daily') { $('taskDailyTime').value = schedule.time; $('taskZone').value = schedule.timeZone; }
          updateScheduleFields();
          $('taskSave').textContent = translate('Save task'); $('taskEditorTitle').textContent = translate('Edit task');
          $('taskEditCancel').hidden = false; editor.open = true;
        });
      }
      if (!task.stopping && !['complete', 'cancelled'].includes(task.status)) button('Cancel task', () => call('cancel', { id: task.id }));
      card.append(actions);
      if (task.history?.length || task.lastResult) {
        const details = element('details', ''); details.className = 'task-history'; details.id = 'task-history-' + task.id;
        details.append(element('summary', 'Recent checks', true));
        const records = element('ol', '');
        for (const entry of task.history?.length ? [...task.history].reverse() : [{ message: task.lastResult }]) {
          const row = element('li', '');
          if (entry.at) { const time = element('time', date(entry.at)); time.dateTime = new Date(entry.at).toISOString(); row.append(time); }
          row.append(element('p', entry.message)); records.append(row);
        }
        details.append(records);
        card.append(details);
      }
      list.append(card);
    }
    for (const node of list.querySelectorAll('details')) node.open = expanded.has(node.id);
    setPending(pending);
    if (focused) {
      const card = [...list.children].find(node => node.dataset.taskId === focused.taskId);
      const target = focused.detailsId ? document.getElementById(focused.detailsId)?.querySelector('summary')
        : [...(card?.querySelectorAll('button') || [])].find(node => node.dataset.action === focused.action && !node.disabled);
      (target || card?.querySelector('summary'))?.focus({ preventScroll: true });
    }
  }
  async function perform(operation) {
    if (pending) return;
    pending = true; setPending(true); $('tasksError').textContent = '';
    try { await operation(); await refresh(); }
    catch (error) { $('tasksError').textContent = error.message; if (dialog.open) $('tasksError').scrollIntoView({ block: 'nearest' }); else setStatus(error.message); }
    finally { pending = false; setPending(false); }
  }
  async function reveal() {
    if (!context.sessionId) { setStatus('Open a conversation before scheduling a task.'); return; }
    sessionId = context.sessionId; resetForm(); editor.open = false; $('tasksError').textContent = ''; list.replaceChildren();
    if (!dialog.open) dialog.showModal();
    await perform(async () => {});
    if (dialog.open) { editor.open = !list.querySelector('.task-card'); dialog.querySelector('.tasks-body').scrollTop = 0; }
  }
  $('tasksForm').addEventListener('submit', event => {
    event.preventDefault();
    void perform(async () => {
      await call(editing ? 'update' : 'create', { id: editing, ...formOptions() });
      resetForm(); editor.open = false;
    });
  });
  controls.hidden = true;
  $('tasksForm').addEventListener('input', updatePreview);
  $('taskSchedule').addEventListener('change', () => {
    const type = $('taskSchedule').value;
    $('taskRuns').value = type === 'once' ? 1 : type === 'daily' ? 7 : 24;
    $('taskHours').value = type === 'interval' ? 24 : 168;
    if (type === 'interval' && Number($('taskInterval').value) < 1) $('taskInterval').value = 10;
    updateScheduleFields();
  });
  for (const zone of Intl.supportedValuesOf?.('timeZone') || ['UTC']) {
    const option = element('option', ''); option.value = zone; $('taskZones').append(option);
  }
  toggle.addEventListener('click', () => void reveal());
  cancel.addEventListener('click', () => {
    const targetSessionId = context.sessionId;
    void perform(async () => {
      await call('cancel-all', { sessionId: targetSessionId });
      if (context.sessionId === targetSessionId) {
        resetForm(); setStatus('Scheduled tasks cancelled.'); $('input').focus();
      }
    });
  });
  $('tasksClose').addEventListener('click', () => dialog.close());
  $('taskEditCancel').addEventListener('click', () => { resetForm(); editor.open = false; $('taskEditorTitle').focus(); });
  // A press must start and end outside: selecting text or dragging from the
  // panel onto the backdrop must not dismiss the dialog.
  let backdropPress = false;
  function outside(event) {
    const rect = dialog.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  }
  dialog.addEventListener('pointerdown', event => { backdropPress = event.button === 0 && event.target === dialog && outside(event); });
  dialog.addEventListener('click', event => {
    if (backdropPress && event.target === dialog && outside(event)) dialog.close();
    backdropPress = false;
  });
  dialog.addEventListener('pointercancel', () => { backdropPress = false; });
  dialog.addEventListener('close', () => { backdropPress = false; });
  window.dshDesktop.onConversationEvent(event => {
    if (event.type !== 'conversation:task') return;
    if (event.session_id === context.sessionId) void refresh().catch(error => { $('tasksError').textContent = error.message; });
    if (event.session_id === context.sessionId && ['complete', 'paused'].includes(event.task.status))
      setStatus(scheduling.taskNotice(event.task, window.CamelliaI18n.locale) || event.task.lastResult);
  });
  return { reveal, refresh: () => refresh().catch(error => setStatus(error.message)) };
}
