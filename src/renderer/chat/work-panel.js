'use strict';
window.createWorkPanel = ({ context, setStatus, openFilePreview }) => {
  const panel = document.getElementById('workPanel'), body = document.getElementById('workPanelBody');
  const toggle = document.getElementById('workPanelToggle'), badge = document.getElementById('workPanelBadge');
  const t = value => window.CamelliaI18n.t(value);
  let tasks = [], selected = null, files = new Map(), epoch = 0, fileTicket = 0, busy = false;
  const drafts = new Map(), expanded = new Map();
  const taskKey = task => task.engine + ':' + task.id;
  const el = (tag, cls, text) => { const node = document.createElement(tag); node.className = cls; if (text != null) node.textContent = text; return node; };
  function button(text, run, cls = 'work-action') { const node = el('button', cls, t(text)); node.type = 'button'; node.onclick = run; return node; }
  function setOpen(open) { panel.hidden = !open; toggle.setAttribute('aria-expanded', String(open)); }
  toggle.onclick = () => setOpen(panel.hidden);
  document.getElementById('workPanelClose').onclick = () => { setOpen(false); toggle.focus(); };
  panel.onkeydown = event => { if (event.key === 'Escape') { setOpen(false); toggle.focus(); } };
  body.addEventListener('focusout', () => requestAnimationFrame(render));
  function section(label, value) {
    if (!value) return;
    const node = el('section', 'work-detail-section'); node.append(el('h3', '', t(label)), el('p', '', value)); body.append(node);
  }
  async function command(task, operation, extra = {}) {
    if (busy) return false;
    busy = true; const sessionId = context.sessionId;
    try {
      const result = await window.dshDesktop.conversationCommand({ engine: task.engine, action: 'subagent-command',
        payload: { sessionId, engine: task.engine, taskId: task.id, operation, expectedTurnId: task.turnId, ...extra } });
      if (!result.ok) throw new Error(result.error);
      return true;
    } catch (error) { if (context.sessionId === sessionId) setStatus(error.message); return false; }
    finally { busy = false; }
  }
  function approvalForm(task, request) {
    const form = el('form', 'work-approval'); form.append(el('h3', '', request.toolName), el('pre', '', request.details));
    const inputs = new Map();
    for (const question of request.questions || []) {
      const label = el('label', '', question.question), input = el('input', ''); input.type = question.isSecret ? 'password' : 'text'; input.required = true;
      const key = taskKey(task) + ':approval:' + request.requestId + ':' + question.id;
      input.value = drafts.get(key) || ''; input.oninput = () => drafts.set(key, input.value);
      input.placeholder = (question.options || []).map(option => option.label).join(' / '); label.append(input); form.append(label); inputs.set(question.id, { input, question });
    }
    if (!request.responseSupported) form.append(el('p', '', t('Handle this request on the computer (questions or oversized details).')));
    else {
      form.append(button('Deny', () => void command(task, 'approve', { approvalId: request.requestId, fingerprint: request.fingerprint, allow: false })));
      const submit = button(request.questions?.length ? 'Send' : 'Allow once', () => {}); submit.type = 'submit'; form.append(submit);
      form.onsubmit = event => {
        event.preventDefault();
        const input = Object.fromEntries([...inputs].map(([id, { input, question }]) => [id, question.multiSelect ? input.value.split(',').map(value => value.trim()).filter(Boolean) : input.value]));
        void command(task, 'approve', { approvalId: request.requestId, fingerprint: request.fingerprint, allow: true, ...(inputs.size ? { input } : {}) });
      };
    }
    body.append(form);
  }
  function taskRow(task) {
    const row = button('', () => { selected = taskKey(task); setOpen(true); render(); }, 'work-task');
    row.append(el('strong', '', task.title), el('span', 'work-state work-' + task.status, t(task.status)), el('small', '', task.progress || task.goal || ''));
    if (task.approvals?.length) row.append(el('span', 'work-attention', t('Needs attention'))); return row;
  }
  function renderCards() {
    const scroll = document.getElementById('chatScroll'), rect = scroll.getBoundingClientRect();
    const anchor = [...document.querySelectorAll('.msg-user, .turn')].find(node => {
      const box = node.getBoundingClientRect(); return box.bottom > rect.top && box.top < rect.bottom;
    });
    const top = anchor?.getBoundingClientRect().top;
    const follow = panel.hidden && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
    document.querySelectorAll('.subtask-turn-card').forEach(node => node.remove());
    const groups = new Map();
    for (const task of tasks) { const group = groups.get(task.userSeq) || []; group.push(task); groups.set(task.userSeq, group); }
    for (const [seq, children] of groups) {
      const user = [...document.querySelectorAll('.msg-user')].find(node => node.messageData?.seq === seq); if (!user) continue;
      const card = el('details', 'subtask-turn-card'); card.dataset.seq = seq;
      card.open = expanded.get(seq) ?? children.some(task => ['starting', 'running', 'waiting'].includes(task.status));
      const attention = children.filter(task => task.approvals?.length || task.status === 'waiting').length;
      card.append(el('summary', '', `${t('Subtasks')} · ${children.length}${attention ? ' · ' + t('Needs attention') + ' ' + attention : ''}`));
      for (const task of children) card.append(taskRow(task)); user.after(card);
      card.querySelector('summary').onclick = () => expanded.set(seq, !card.open);
    }
    if (follow) scroll.scrollTop = scroll.scrollHeight;
    else if (anchor?.isConnected) scroll.scrollTop += anchor.getBoundingClientRect().top - top;
  }
  function render() {
    const attention = tasks.filter(task => task.approvals?.length || task.status === 'waiting').length;
    badge.textContent = String(attention); badge.hidden = !attention; toggle.title = t('Work panel') + (attention ? ' · ' + t('Needs attention') + ' ' + attention : '');
    // A streaming update must not erase a child reply or question being typed.
    if (body.contains(document.activeElement) && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    body.replaceChildren(); const task = tasks.find(task => taskKey(task) === selected);
    if (task) {
      body.append(button('Back to overview', () => { selected = null; render(); }), el('h2', '', task.title), el('span', 'work-state work-' + task.status, t(task.status)));
      section('Goal', task.goal); section('Latest progress', task.progress); section('Result', task.result);
      for (const request of task.approvals || []) approvalForm(task, request);
      if (task.canReply) {
        const form = el('form', 'work-reply'), input = el('textarea', ''); input.required = true; input.maxLength = 32000; input.placeholder = t('Reply to subtask'); input.setAttribute('aria-label', t('Reply to subtask'));
        const key = taskKey(task) + ':reply'; input.value = drafts.get(key) || ''; input.oninput = () => drafts.set(key, input.value);
        const submit = button('Send', () => {}); submit.type = 'submit'; form.append(input, submit);
        form.onsubmit = async event => {
          event.preventDefault(); const prompt = input.value;
          if (await command(task, 'reply', { prompt }) && drafts.get(key) === prompt) { drafts.delete(key); input.value = ''; }
        }; body.append(form);
      }
      if (task.canStop) body.append(button('Stop subtask', () => void command(task, 'stop')));
      const history = el('details', 'work-history'); history.append(el('summary', '', t('Execution history')));
      for (const entry of task.history || []) history.append(el('small', '', entry.type), el('pre', '', entry.text)); body.append(history);
    } else {
      const agents = el('details', 'work-group'); agents.open = true; agents.append(el('summary', '', `${t('Subtasks')} · ${tasks.length}`));
      if (!tasks.length) agents.append(el('p', 'work-empty', t('No subtasks yet'))); for (const task of tasks) agents.append(taskRow(task));
      const artifacts = el('details', 'work-group'); artifacts.open = true; artifacts.append(el('summary', '', `${t('Artifacts')} · ${files.size}`));
      if (!files.size) artifacts.append(el('p', 'work-empty', t('No artifacts yet')));
      for (const file of files.values()) { const row = button('', () => void openFilePreview(file.path), 'work-artifact'); row.append(el('strong', '', file.name), el('small', '', file.origin)); artifacts.append(row); }
      body.append(agents, artifacts);
    }
  }
  async function childFiles() {
    const ticket = ++fileTicket, generation = epoch, sessionId = context.sessionId;
    for (const task of tasks) if (task.status === 'completed' && (task.artifacts?.length || task.result)) {
      try {
        const result = await window.dshDesktop.resolveArtifacts({ sessionId: task.managedConversationId || sessionId, paths: task.artifacts?.map(file => file.path) || [], text: task.result });
        if (epoch !== generation || fileTicket !== ticket || context.sessionId !== sessionId) return;
        if (result.ok) for (const file of result.files) files.set(file.path, { ...file, origin: task.title });
      } catch {}
    }
    render();
  }
  window.addEventListener('camellia:language', () => { render(); renderCards(); });
  return { reset() { epoch++; tasks = []; files.clear(); drafts.clear(); expanded.clear(); selected = null; render(); },
    update(value) { tasks = value || []; render(); renderCards(); void childFiles(); },
    artifacts(value) { for (const file of value || []) if (!files.has(file.path)) files.set(file.path, { ...file, origin: t('Main conversation') }); render(); }, refreshCards: renderCards };
};
