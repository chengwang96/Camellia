'use strict';

function createScheduledTasksUI({ $, context, setStatus }) {
  const dialog = $('tasksDialog'), toggle = $('tasksToggle'), list = $('tasksList');
  let sessionId = null, editing = null, pending = false, refreshSequence = 0, toggleSessionId = null;
  const translate = text => window.CamelliaI18n.t(text);
  const call = async (action, payload = {}) => {
    const result = await window.dshDesktop.conversationCommand({ engine: harnessId, action: 'task-' + action, payload: { sessionId, ...payload } });
    if (!result.ok) throw new Error(result.error || 'Task operation failed');
    return result;
  };
  function element(tag, text, translated = false) {
    const node = document.createElement(tag); node.textContent = translated ? translate(text) : text;
    return node;
  }
  function resetForm() { editing = null; $('tasksForm').reset(); $('taskSave').textContent = translate('Create task'); }
  async function refresh() {
    const sequence = ++refreshSequence;
    const currentSessionId = context.sessionId;
    if (toggleSessionId !== currentSessionId) toggle.hidden = true;
    toggleSessionId = currentSessionId;
    if (!sharedChat || !currentSessionId) { toggle.hidden = true; return; }
    const result = await call('list', { sessionId: currentSessionId });
    if (sequence !== refreshSequence || currentSessionId !== context.sessionId) return;
    toggle.hidden = !result.tasks.some(task => ['scheduled', 'running', 'paused'].includes(task.status));
    if (!dialog.open || sessionId !== currentSessionId) return;
    list.replaceChildren();
    if (!result.tasks.length) list.append(element('p', 'No scheduled tasks in this conversation.', true));
    for (const task of result.tasks) {
      const card = element('section', ''); card.className = 'task-card';
      card.append(element('h3', task.instruction));
      const status = { scheduled: 'Scheduled', running: 'Checking', paused: 'Paused', complete: 'Completed', cancelled: 'Cancelled' }[task.status] || task.status;
      card.append(element('p', `${translate(status)} · ${task.runs}/${task.maxRuns} ${translate('checks')} · ${task.repairs}/${task.maxRepairs} ${translate('recoveries')}`));
      if (task.nextRunAt) card.append(element('p', translate('Next check') + ': ' + new Date(task.nextRunAt).toLocaleString(window.CamelliaI18n.locale)));
      card.append(element('p', translate('Deadline') + ': ' + new Date(task.expiresAt).toLocaleString(window.CamelliaI18n.locale)));
      if (task.lastResult) card.append(element('p', task.lastResult));
      const actions = element('div', ''); actions.className = 'task-actions';
      function button(label, handler) {
        const control = element('button', label, true); control.type = 'button'; control.className = 'btn-secondary';
        control.addEventListener('click', () => void perform(handler)); actions.append(control);
      }
      if (['scheduled', 'running'].includes(task.status)) button('Pause', () => call('pause', { id: task.id }));
      if (task.status === 'paused') {
        button('Resume', () => call('resume', { id: task.id }));
        button('Edit task', async () => {
          editing = task.id; $('taskInstruction').value = task.instruction;
          for (const [field, key] of [['taskInterval', 'intervalMinutes'], ['taskRuns', 'maxRuns'], ['taskHours', 'maxHours'], ['taskRepairs', 'maxRepairs']]) $(field).value = task[key];
          $('taskSave').textContent = translate('Save task'); $('taskInstruction').focus();
        });
      }
      if (!['complete', 'cancelled'].includes(task.status)) button('Cancel task', () => call('cancel', { id: task.id }));
      card.append(actions);
      if (task.history.length) {
        const details = element('details', ''); details.append(element('summary', 'Recent checks', true));
        for (const entry of task.history) details.append(element('p', new Date(entry.at).toLocaleString(window.CamelliaI18n.locale) + ' · ' + entry.message));
        card.append(details);
      }
      list.append(card);
    }
  }
  async function perform(operation) {
    if (pending) return;
    pending = true; $('taskSave').disabled = true; $('tasksError').textContent = '';
    try { await operation(); await refresh(); }
    catch (error) { $('tasksError').textContent = error.message; }
    finally { pending = false; $('taskSave').disabled = false; }
  }
  async function reveal() {
    if (!sharedChat) return;
    if (!context.sessionId) { setStatus('Open a conversation before scheduling a task.'); return; }
    sessionId = context.sessionId; resetForm(); $('tasksError').textContent = ''; list.replaceChildren();
    if (!dialog.open) dialog.showModal();
    await perform(async () => {});
  }
  $('tasksForm').addEventListener('submit', event => {
    event.preventDefault();
    void perform(async () => {
      await call(editing ? 'update' : 'create', { id: editing, instruction: $('taskInstruction').value,
        intervalMinutes: Number($('taskInterval').value), maxRuns: Number($('taskRuns').value), maxHours: Number($('taskHours').value), maxRepairs: Number($('taskRepairs').value) });
      resetForm();
    });
  });
  toggle.hidden = true;
  toggle.addEventListener('click', () => void reveal());
  $('tasksClose').addEventListener('click', () => dialog.close());
  if (sharedChat) window.dshDesktop.onConversationEvent(event => {
    if (event.type !== 'conversation:task') return;
    if (event.session_id === context.sessionId) void refresh().catch(error => { $('tasksError').textContent = error.message; });
    if (event.session_id === context.sessionId && ['complete', 'paused'].includes(event.task.status)) setStatus(event.task.lastResult);
  });
  return { reveal, refresh: () => refresh().catch(error => setStatus(error.message)) };
}
