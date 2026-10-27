'use strict';
window.createWorkPanel = ({ context, setStatus, openFilePreview, shouldFollow }) => {
  const panel = document.getElementById('workPanel'), body = document.getElementById('workPanelBody');
  const footer = document.getElementById('workPanelFooter'), count = document.getElementById('workPanelCount');
  const toggle = document.getElementById('workPanelToggle'), badge = document.getElementById('workPanelBadge');
  const t = value => window.CamelliaI18n.t(value);
  let tasks = [], selected = null, epoch = 0, fileTicket = 0, busy = false;
  const files = window.CamelliaArtifacts.artifactStore();
  const drafts = new Map(), expanded = new Map(), detailExpanded = new Map(), scrollPositions = new Map();
  let renderedView = null, footerKey = null;
  const header = toggle.closest('.main-header');
  if (header) {
    const place = () => panel.style.setProperty('--work-panel-top', header.offsetHeight + 8 + 'px');
    new ResizeObserver(place).observe(header); place();
  }
  const taskKey = task => task.engine + ':' + task.id;
  const fileKey = file => window.CamelliaArtifacts.artifactPath(file.canonicalPath || file.path, window.dshDesktop.platform);
  const addFile = (file, origin) => files.set({ ...file, origin }, window.dshDesktop.platform);
  const el = (tag, cls, text) => { const node = document.createElement(tag); node.className = cls; if (text != null) node.textContent = text; return node; };
  function button(text, run, cls = 'work-action') { const node = el('button', cls, t(text)); node.type = 'button'; node.onclick = run; node.dataset.workFocus = text; return node; }
  const engineName = engine => ({ codex: 'Codex', claude: 'Claude', kimi: 'Kimi', grok: 'Grok', antigravity: 'Antigravity', dsh: 'DSH' })[engine] || engine || '';
  const state = task => ['ready', 'starting', 'running', 'waiting', 'completed', 'failed', 'stopped', 'unavailable'].includes(task.status) ? task.status : 'unavailable';
  function stateBadge(task) { return el('span', 'work-state work-' + state(task), t(state(task))); }
  function disclosure(label, key, open = true) {
    const node = el('details', 'work-group'); node.dataset.workDisclosure = key; node.open = detailExpanded.get(key) ?? open;
    const summary = el('summary', '', t(label)); summary.dataset.workFocus = 'section:' + key; node.append(summary);
    summary.onclick = event => {
      event.preventDefault(); node.open = !node.open; detailExpanded.set(key, node.open);
    };
    node.ontoggle = () => { if (node.isConnected) detailExpanded.set(key, node.open); };
    return node;
  }
  function commandButton(text, run, cls) {
    const node = button(text, run, cls); node.dataset.workCommand = 'true'; node.disabled = busy; return node;
  }
  function setBusy(value) {
    busy = value;
    panel.querySelectorAll('[data-work-command]').forEach(node => { node.disabled = value; });
  }
  function setOpen(open) { panel.hidden = !open; toggle.setAttribute('aria-expanded', String(open)); }
  toggle.onclick = () => setOpen(panel.hidden);
  document.getElementById('workPanelClose').onclick = () => { setOpen(false); toggle.focus(); };
  panel.onkeydown = event => { if (event.key === 'Escape') { setOpen(false); toggle.focus(); } };
  body.addEventListener('focusout', event => { if (['INPUT', 'TEXTAREA'].includes(event.target.tagName)) requestAnimationFrame(render); });
  function section(label, value) {
    if (!value) return;
    const node = el('section', 'work-detail-section'); node.append(el('h3', '', t(label)), el('p', '', value)); body.append(node); return node;
  }
  async function command(task, operation, extra = {}) {
    if (busy) return false;
    setBusy(true); const sessionId = context.sessionId;
    try {
      const result = await window.dshDesktop.conversationCommand({ engine: task.engine, action: 'subagent-command',
        payload: { sessionId, engine: task.engine, taskId: task.id, operation, expectedTurnId: task.turnId, ...extra } });
      if (!result.ok) throw new Error(result.error);
      return true;
    } catch (error) { if (context.sessionId === sessionId) setStatus(error.message); return false; }
    finally { setBusy(false); }
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
      const actions = el('div', 'work-form-actions');
      const deny = commandButton('Deny', () => void command(task, 'approve', { approvalId: request.requestId, fingerprint: request.fingerprint, allow: false }));
      deny.dataset.workFocus = request.requestId + ':deny'; actions.append(deny);
      const submit = commandButton(request.questions?.length ? 'Send' : 'Allow once', () => {}, 'work-action work-primary'); submit.type = 'submit'; actions.append(submit); form.append(actions);
      submit.dataset.workFocus = request.requestId + ':submit';
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
    row.dataset.workFocus = 'task:' + taskKey(task);
    row.dataset.state = state(task);
    const heading = el('span', 'work-task-heading'); heading.append(el('strong', '', task.title || t('Subtask')), stateBadge(task));
    const preview = task.status === 'completed' ? task.result || task.progress || task.goal : task.progress || task.goal;
    row.append(heading, el('small', 'work-task-preview', preview || t('No progress reported yet')));
    const meta = el('span', 'work-task-meta', engineName(task.engine));
    if (task.approvals?.length) meta.append(el('span', 'work-attention', t('Needs attention')));
    row.append(meta); return row;
  }
  function renderCards() {
    const scroll = document.getElementById('chatScroll'), rect = scroll.getBoundingClientRect();
    const anchor = [...document.querySelectorAll('.msg-user, .turn')].find(node => {
      const box = node.getBoundingClientRect(); return box.bottom > rect.top && box.top < rect.bottom;
    });
    const top = anchor?.getBoundingClientRect().top;
    const follow = panel.hidden && shouldFollow() && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
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
    count.textContent = String(tasks.length); count.hidden = !tasks.length;
    const task = tasks.find(task => taskKey(task) === selected);
    const nextFooter = task?.canStop ? taskKey(task) + ':' + task.turnId : null;
    if (footerKey !== nextFooter) {
      footer.replaceChildren(); footer.hidden = !task?.canStop; footerKey = nextFooter;
      if (task?.canStop) footer.append(commandButton('Stop subtask', () => void command(task, 'stop'), 'work-action work-stop'));
    }
    // A streaming update must not erase a child reply or question being typed.
    if (body.contains(document.activeElement) && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    const focused = body.contains(document.activeElement) ? document.activeElement.dataset.workFocus : null;
    if (renderedView != null) {
      scrollPositions.set(renderedView, body.scrollTop);
      // Native toggle events are queued. A child update can arrive first, so
      // preserve the current DOM state before replacing any disclosure.
      for (const disclosure of body.querySelectorAll('details[data-work-disclosure]'))
        detailExpanded.set(disclosure.dataset.workDisclosure, disclosure.open);
    }
    body.replaceChildren(); renderedView = task ? taskKey(task) : 'overview';
    if (task) {
      body.append(button('Back to overview', () => { selected = null; render(); }, 'work-back'));
      const heading = el('div', 'work-detail-heading'), identity = el('div', 'work-detail-identity');
      identity.append(el('span', 'work-engine', engineName(task.engine)), el('h2', '', task.title || t('Subtask')));
      heading.append(identity, stateBadge(task)); body.append(heading);
      const progressText = task.status === 'completed' ? task.result || task.progress : task.progress;
      const progress = section(task.status === 'completed' && task.result ? 'Result' : 'Latest progress', progressText || t('No progress reported yet'));
      progress.classList.add('work-progress'); progress.dataset.state = state(task);
      for (const request of task.approvals || []) approvalForm(task, request);
      section('Goal', task.goal);
      if (task.result && task.result !== progressText) section('Result', task.result);
      if (task.canReply) {
        const form = el('form', 'work-reply'), input = el('textarea', ''); input.required = true; input.maxLength = 32000; input.placeholder = t('Reply to subtask'); input.setAttribute('aria-label', t('Reply to subtask'));
        const key = taskKey(task) + ':reply'; input.value = drafts.get(key) || ''; input.oninput = () => drafts.set(key, input.value);
        const submit = commandButton('Send', () => {}, 'work-action work-primary'); submit.type = 'submit'; form.append(input, submit);
        form.onsubmit = async event => {
          event.preventDefault(); const prompt = input.value;
          if (await command(task, 'reply', { prompt }) && drafts.get(key) === prompt) { drafts.delete(key); input.value = ''; }
        }; body.append(form);
      }
      if (task.history?.length) {
        const history = disclosure('Execution history', taskKey(task) + ':history', false); history.className = 'work-history';
        history.querySelector('summary').append(el('span', 'work-section-count', String(task.history.length)));
        for (const entry of task.history) {
          const record = el('div', 'work-history-entry');
          const labels = { agentMessage: 'Response', userMessage: 'Message', commandExecution: 'Command', fileChange: 'File changes', reasoning: 'Reasoning', plan: 'Plan' };
          record.append(el('small', '', t(labels[entry.type] || entry.type)), el('pre', '', entry.text)); history.append(record);
        }
        body.append(history);
      }
    } else {
      const agents = disclosure('Subtasks', 'tasks'); agents.querySelector('summary').append(el('span', 'work-section-count', String(tasks.length)));
      const active = tasks.filter(task => ['starting', 'running'].includes(task.status)).length;
      if (active || attention) {
        const summary = el('div', 'work-overview-summary');
        if (active) summary.append(el('span', 'work-overview-running', `${t('running')} ${active}`));
        if (attention) summary.append(el('span', 'work-attention', `${t('Needs attention')} ${attention}`));
        agents.append(summary);
      }
      if (!tasks.length) agents.append(el('p', 'work-empty', t('No subtasks yet'))); for (const task of tasks) agents.append(taskRow(task));
      const artifacts = disclosure('Artifacts', 'artifacts'); artifacts.querySelector('summary').append(el('span', 'work-section-count', String(files.size)));
      if (!files.size) artifacts.append(el('p', 'work-empty', t('No artifacts yet')));
      for (const file of files.values()) { const row = button('', () => void openFilePreview(file.path), 'work-artifact'); row.title = file.path; row.dataset.workFocus = 'file:' + fileKey(file); row.append(el('strong', '', file.name), el('small', '', file.origin)); artifacts.append(row); }
      body.append(agents, artifacts);
    }
    if (focused) body.querySelector(`[data-work-focus="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
    body.scrollTop = scrollPositions.get(renderedView) || 0;
  }
  async function childFiles() {
    const ticket = ++fileTicket, generation = epoch, sessionId = context.sessionId;
    for (const task of tasks) if (task.status === 'completed' && (task.artifacts?.length || task.result)) {
      try {
        const result = await window.dshDesktop.resolveArtifacts({ sessionId: task.managedConversationId || sessionId, paths: task.artifacts?.map(file => file.path) || [], text: task.result });
        if (epoch !== generation || fileTicket !== ticket || context.sessionId !== sessionId) return;
        if (result.ok) for (const file of result.files) addFile(file, task.title);
      } catch {}
    }
    render();
  }
  window.addEventListener('camellia:language', () => { render(); renderCards(); });
  return { reset() { epoch++; tasks = []; files.clear(); drafts.clear(); expanded.clear(); detailExpanded.clear(); scrollPositions.clear(); renderedView = null; selected = null; render(); },
    update(value) { tasks = value || []; render(); renderCards(); void childFiles(); },
    artifacts(value) { for (const file of value || []) addFile(file, t('Main conversation')); render(); }, refreshCards: renderCards };
};
