'use strict';
window.createWorkPanel = ({ context, setStatus, openFilePreview, shouldFollow, gitPanel, getEngine }) => {
  const panel = document.getElementById('workPanel'), body = document.getElementById('workPanelBody');
  const footer = document.getElementById('workPanelFooter'), count = document.getElementById('workPanelCount');
  const toggle = document.getElementById('workPanelToggle'), badge = document.getElementById('workPanelBadge');
  const main = panel.closest('.main');
  const t = value => window.CamelliaI18n.t(value);
  let tasks = [], selected = null, epoch = 0, fileTicket = 0, busy = false, reviews = [];
  const files = window.CamelliaArtifacts.artifactStore();
  const drafts = new Map(), expanded = new Map(), detailExpanded = new Map(), scrollPositions = new Map();
  let renderedView = null, footerKey = null;
  const header = toggle.closest('.main-header');
  if (header) {
    const place = () => panel.style.setProperty('--work-panel-top', header.offsetHeight + 8 + 'px');
    new ResizeObserver(place).observe(header); place();
  }
  const taskKey = task => task.engine + ':' + task.id;
  const orderedTasks = items => [...items.filter(task => task.status !== 'completed'), ...items.filter(task => task.status === 'completed')];
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
  const panelIsOpen = () => window.CamelliaPanelMotion?.isOpen(panel)
    ?? (!panel.hidden && !panel.classList.contains('is-closing'));
  function setOpen(open) {
    if (open) {
      main?.classList.add('has-work-panel');
      if (window.CamelliaPanelMotion) window.CamelliaPanelMotion.open(panel); else panel.hidden = false;
      window.dispatchEvent(new CustomEvent('camellia:panel-open', { detail: { name: 'work' } }));
      void gitPanel?.refresh();
      void loadReviews();
    } else {
      main?.classList.remove('has-work-panel');
      if (window.CamelliaPanelMotion) window.CamelliaPanelMotion.close(panel); else panel.hidden = true;
    }
    toggle.setAttribute('aria-expanded', String(open));
    panel.setAttribute('aria-hidden', String(!open));
    panel.inert = !open;
  }
  window.addEventListener('camellia:panel-open', event => {
    if (event.detail?.name !== 'work' && panelIsOpen()) setOpen(false);
  });
  toggle.onclick = () => setOpen(!panelIsOpen());
  document.getElementById('workPanelClose').onclick = () => { setOpen(false); toggle.focus(); };
  panel.onkeydown = event => { if (event.key === 'Escape') { setOpen(false); toggle.focus(); } };
  body.addEventListener('focusout', event => { if (['INPUT', 'TEXTAREA'].includes(event.target.tagName)) requestAnimationFrame(render); });
  function section(label, value) {
    if (!value) return;
    const node = el('section', 'work-detail-section'); node.append(el('h3', '', t(label)), el('p', '', value)); body.append(node); return node;
  }
  async function loadReviews() {
    if (!context.sessionId || !getEngine) return;
    try {
      const result = await window.dshDesktop.conversationCommand({
        engine: getEngine(), action: 'review-list', payload: { sessionId: context.sessionId },
      });
      if (!result?.ok) return;
      reviews = result.reviews || [];
      render();
    } catch { /* Review history must not break the work panel. */ }
  }
  function reviewSection() {
    if (!reviews.length) return null;
    const group = el('details', 'work-group');
    group.open = true;
    const summary = el('summary', '', t('Cross-engine reviews'));
    summary.append(el('span', 'work-section-count', String(reviews.length)));
    group.append(summary);
    for (const review of reviews) {
      const row = el('div', 'work-review-row');
      const head = el('div', 'work-review-head');
      head.append(el('strong', '', t(review.mode === 'adversarial' ? 'Adversarial review' : 'Standard review')),
        el('span', 'work-state work-' + (review.status || 'unavailable'),
          t(review.status === 'completed' ? 'Completed'
            : review.status === 'running' ? 'Running'
              : review.status === 'cancelled' ? 'Cancelled'
                : review.status === 'stale' ? 'Review is stale'
                  : review.status === 'interrupted' ? 'Review was interrupted'
                    : review.status === 'failed' ? 'Failed' : review.status || '')));
      row.append(head, el('span', 'work-review-meta', review.reviewerEngine || ''));
      if (review.report?.summary) row.append(el('p', 'work-review-summary', review.report.summary));
      if (review.error) row.append(el('p', 'work-review-error', review.error));
      for (const finding of (review.report?.findings || []).slice(0, 6)) {
        row.append(el('p', 'work-review-finding', '[' + (finding.severity || 'info') + '] '
          + (finding.file || '') + (finding.line ? ':' + finding.line : '') + ' · ' + (finding.evidence || '')));
      }
      if ((review.report?.findings?.length || 0) > 6) row.append(el('small', 'work-review-findings',
        String(review.report.findings.length) + ' ' + t('findings')));
      const open = button('Open review', () => window.dispatchEvent(new CustomEvent('camellia:open-review')));
      open.dataset.workCommand = 'true';
      row.append(open);
      group.append(row);
    }
    return group;
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
  function summaryCard(attention) {
    if (!tasks.length) return null;
    const groups = [
      ['running', tasks.filter(task => ['starting', 'running'].includes(state(task))).length],
      ['waiting', tasks.filter(task => state(task) === 'waiting').length],
      ['completed', tasks.filter(task => state(task) === 'completed').length],
      ['failed', tasks.filter(task => state(task) === 'failed').length],
      ['stopped', tasks.filter(task => state(task) === 'stopped').length],
      ['unavailable', tasks.filter(task => state(task) === 'unavailable').length],
      ['ready', tasks.filter(task => state(task) === 'ready').length],
    ].filter(([, value]) => value > 0);
    const card = el('section', 'work-overview');
    const head = el('div', 'work-overview-head'), total = el('div', 'work-overview-total');
    total.append(el('strong', '', String(tasks.length)), el('span', '', t('Tasks')));
    head.append(total);
    if (attention) head.append(el('span', 'work-overview-attention', t('Needs attention') + ' ' + attention));
    const meter = el('div', 'work-overview-meter');
    meter.setAttribute('aria-hidden', 'true');
    for (const [key, value] of groups) {
      const segment = el('span', 'work-overview-segment is-' + key);
      segment.style.width = value / tasks.length * 100 + '%';
      meter.append(segment);
    }
    const legend = el('div', 'work-overview-legend');
    for (const [key, value] of groups) {
      const item = el('span', 'work-overview-legend-item');
      item.append(el('span', 'work-overview-dot is-' + key), el('span', '', t(key) + ' ' + value));
      legend.append(item);
    }
    card.append(head, meter, legend);
    return card;
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
      if (task.contextPacket) {
        const packet = disclosure('Context packet', taskKey(task) + ':context-packet', false);
        packet.append(el('pre', 'work-context-json', JSON.stringify(task.contextPacket, null, 2)));
        body.append(packet);
      }
      if (task.settlement) {
        const settlement = disclosure('Settlement', taskKey(task) + ':settlement', false);
        settlement.append(el('pre', 'work-context-json', JSON.stringify(task.settlement, null, 2)));
        body.append(settlement);
      }
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
      let changes = null;
      if (gitPanel) {
        changes = disclosure('Changes', 'git'); changes.querySelector('summary').append(el('span', 'work-section-count', String(gitPanel.count())));
        gitPanel.renderSummary(changes);
      }
      const agents = disclosure('Subtasks', 'tasks'); agents.querySelector('summary').append(el('span', 'work-section-count', String(tasks.length)));
      if (!tasks.length) agents.append(el('p', 'work-empty', t('No subtasks yet'))); for (const task of tasks) agents.append(taskRow(task));
      const artifacts = disclosure('Artifacts', 'artifacts'); artifacts.querySelector('summary').append(el('span', 'work-section-count', String(files.size)));
      if (!files.size) artifacts.append(el('p', 'work-empty', t('No artifacts yet')));
      for (const file of files.values()) {
        const row = button('', () => void openFilePreview(file.path), 'work-artifact'), icon = el('span', 'work-artifact-icon');
        icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v5h5"/></svg>';
        row.dataset.path = file.path; row.dataset.workFocus = 'file:' + fileKey(file);
        row.append(icon, el('strong', '', file.name), el('small', '', file.origin));
        artifacts.append(row);
      }
      const summary = summaryCard(attention);
      if (summary) body.append(summary);
      if (changes) body.append(changes);
      body.append(agents, artifacts);
      const reviewGroup = reviewSection();
      if (reviewGroup) body.append(reviewGroup);
    }
    if (focused) body.querySelector(`[data-work-focus="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
    body.scrollTop = scrollPositions.get(renderedView) || 0;
  }
  async function childFiles() {
    const ticket = ++fileTicket, generation = epoch, sessionId = context.sessionId;
    for (const task of tasks) if (task.status === 'completed' && (task.artifacts?.length || task.result)) {
      try {
        const result = await window.dshDesktop.resolveArtifacts({ sessionId: task.managedConversationId || sessionId, paths: task.artifacts?.map(file => file.path) || [],
          explicitPaths: task.artifacts?.filter(file => file.explicitDelivery).map(file => file.path), text: task.result });
        if (epoch !== generation || fileTicket !== ticket || context.sessionId !== sessionId) return;
        if (result.ok) for (const file of result.files) addFile(file, task.title);
      } catch {}
    }
    render();
  }
  window.addEventListener('camellia:language', () => { render(); renderCards(); });
  return { reset() { epoch++; tasks = []; reviews = []; files.clear(); drafts.clear(); expanded.clear(); detailExpanded.clear(); scrollPositions.clear(); renderedView = null; selected = null; gitPanel?.reset(); render(); },
    update(value) { tasks = orderedTasks(value || []); render(); renderCards(); void childFiles(); },
    artifacts(value) { for (const file of value || []) addFile(file, t('Main conversation')); render(); }, refreshCards: renderCards,
    refreshReviews: loadReviews, setOpen, render };
};
