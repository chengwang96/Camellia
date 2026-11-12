'use strict';

window.createReviewPanel = ({ context, getEngine, setStatus }) => {
  const toggle = document.getElementById('reviewToggle');
  const dialog = document.getElementById('reviewDialog');
  const form = document.getElementById('reviewForm');
  const engineSelect = document.getElementById('reviewEngine');
  const modelSelect = document.getElementById('reviewModel');
  const modeSelect = document.getElementById('reviewMode');
  const baseInput = document.getElementById('reviewBase');
  const maxTokensInput = document.getElementById('reviewMaxTokens');
  const focusInput = document.getElementById('reviewFocus');
  const agentConsent = document.getElementById('reviewAgentConsent');
  const gateToggle = document.getElementById('reviewGate');
  const turnGateToggle = document.getElementById('reviewTurnGate');
  const sameEngineToggle = document.getElementById('reviewSameEngine');
  const status = document.getElementById('reviewStatus');
  const startButton = document.getElementById('reviewStart');
  const cancelButton = document.getElementById('reviewCancel');
  const overrideButton = document.getElementById('reviewOverrideGate');
  const closeButton = document.getElementById('reviewClose');
  if (!toggle || !dialog || !form || !engineSelect || !modelSelect || !modeSelect || !maxTokensInput || !agentConsent || !gateToggle || !turnGateToggle || !sameEngineToggle
      || !status || !startButton || !overrideButton) return null;
  const t = value => window.CamelliaI18n?.t(value) || value;
  const shortcutBindings = window.CamelliaShortcuts?.watchBindings(window.dshDesktop);
  let options = null;
  let review = null;
  let pollTimer = null;
  let contextTicket = 0;

  function stopPolling() { clearInterval(pollTimer); pollTimer = null; }
  function setStatusText(value) { status.textContent = value ? t(value) : ''; }
  function clearReport() {
    for (const node of status.parentElement.querySelectorAll('.review-report')) node.remove();
  }
  function removeConsent(id = '') {
    for (const node of document.querySelectorAll('.review-consent-card')) {
      if (!id || node.dataset.consentId === id) node.remove();
    }
  }
  function renderConsent(consent) {
    if (!consent?.id) return;
    removeConsent(consent.id);
    if (consent.status === 'approved' || consent.status === 'dismissed') return;
    const chat = document.getElementById('chat');
    if (!chat) return;
    const card = document.createElement('section');
    card.className = 'review-consent-card';
    card.dataset.consentId = consent.id;
    const title = document.createElement('strong');
    title.textContent = t('Allow this conversation to start a cross-engine review?');
    const detail = document.createElement('p');
    detail.textContent = [consent.reviewerEngine, t(consent.mode === 'adversarial' ? 'Adversarial review' : 'Standard review'),
      consent.focus].filter(Boolean).join(' · ');
    const note = document.createElement('p');
    note.className = 'review-consent-note';
    note.textContent = t('Approving spends reviewer quota. The reviewer runs in an isolated read-only snapshot and cannot change this workspace.');
    const actions = document.createElement('div');
    actions.className = 'review-consent-actions';
    const allow = document.createElement('button');
    allow.type = 'button'; allow.className = 'btn-primary';
    allow.textContent = t('Allow reviews in this conversation');
    const dismiss = document.createElement('button');
    dismiss.type = 'button'; dismiss.className = 'btn-secondary';
    dismiss.textContent = t('Not now');
    allow.onclick = async () => {
      allow.disabled = true; dismiss.disabled = true;
      try {
        const result = await window.dshDesktop.conversationCommand({
          engine: getEngine(), action: 'review-consent-approve',
          payload: { sessionId: context.sessionId, consentId: consent.id },
        });
        if (!result?.ok) throw new Error(result?.error || 'Could not start the review');
        card.remove();
        if (result.review) {
          render(result.review);
          poll();
        }
        setStatusText('Review approved and started.');
      } catch (error) {
        allow.disabled = false; dismiss.disabled = false;
        setStatusText(error.message);
      }
    };
    dismiss.onclick = async () => {
      dismiss.disabled = true;
      try {
        await window.dshDesktop.conversationCommand({
          engine: getEngine(), action: 'review-consent-dismiss',
          payload: { sessionId: context.sessionId, consentId: consent.id },
        });
      } finally { card.remove(); }
    };
    actions.append(allow, dismiss);
    card.append(title, detail, note, actions);
    chat.appendChild(card);
    card.scrollIntoView({ block: 'nearest' });
  }
  function setBusy(busy) {
    startButton.disabled = busy;
    engineSelect.disabled = busy;
    modelSelect.disabled = busy;
    modeSelect.disabled = busy;
    baseInput.disabled = busy;
    maxTokensInput.disabled = busy;
    focusInput.disabled = busy;
    agentConsent.disabled = busy;
    gateToggle.disabled = busy;
    turnGateToggle.disabled = busy;
    sameEngineToggle.disabled = busy;
  }
  function modelOptions(preferred = '') {
    const value = engineSelect.value;
    const engine = options?.engines?.find(item => item.engine === value);
    modelSelect.replaceChildren();
    for (const model of engine?.models || []) {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.name || model.id;
      modelSelect.append(option);
    }
    modelSelect.disabled = !engine?.models?.length;
    if (preferred && engine?.models?.some(model => model.id === preferred)) modelSelect.value = preferred;
  }
  function fillOptions(value) {
    options = value;
    engineSelect.replaceChildren();
    for (const item of value.engines || []) {
      const option = document.createElement('option');
      option.value = item.engine;
      option.textContent = item.engine + (item.available ? '' : ' · ' + t('Unavailable'));
      option.disabled = !item.available;
      engineSelect.append(option);
    }
    const preferred = value.settings?.reviewerEngine || value.defaultEngine;
    engineSelect.value = value.engines?.some(item => item.engine === preferred && item.available)
      ? preferred : value.engines?.find(item => item.available)?.engine || '';
    modelOptions(value.settings?.model);
    modeSelect.value = value.settings?.mode === 'adversarial' ? 'adversarial' : 'standard';
    maxTokensInput.value = String(value.settings?.maxTokens || 50000);
    agentConsent.checked = value.settings?.allowAgentReviews === true;
    gateToggle.checked = value.settings?.gate === true;
    turnGateToggle.checked = value.settings?.turnGate === true;
    sameEngineToggle.checked = value.settings?.allowSameEngine === true;
  }
  async function savePolicy(patch, { quiet = false } = {}) {
    if (!context.sessionId) return false;
    let saved = false;
    if (!quiet) setBusy(true);
    try {
      const result = await window.dshDesktop.conversationCommand({
        engine: getEngine(), action: 'review-save-settings',
        payload: { sessionId: context.sessionId, ...patch },
      });
      if (!result?.ok) throw new Error(result?.error || 'Could not save review settings');
      options = { ...options, settings: result.settings };
      saved = true;
      return true;
    } catch (error) {
      setStatusText(error.message);
      if (options?.settings) {
        agentConsent.checked = options.settings.allowAgentReviews === true;
        gateToggle.checked = options.settings.gate === true;
        turnGateToggle.checked = options.settings.turnGate === true;
        sameEngineToggle.checked = options.settings.allowSameEngine === true;
      }
      return false;
    } finally {
      if (!quiet) {
        setBusy(false);
        if (saved && review && ['running', 'queued'].includes(review.status)) render(review);
      }
    }
  }
  function renderReport(report) {
    clearReport();
    if (!report) return;
    const section = document.createElement('section');
    section.className = 'review-report';
    const verdict = document.createElement('span');
    verdict.className = 'review-verdict';
    verdict.textContent = t(report.verdict === 'pass' ? 'Pass'
      : report.verdict === 'changes_requested' ? 'Changes requested' : 'Blocked');
    const summary = document.createElement('div');
    summary.className = 'review-report-summary';
    summary.textContent = report.summary || '';
    section.append(verdict, summary);
    for (const finding of report.findings || []) {
      const row = document.createElement('div');
      row.className = 'review-finding';
      const head = document.createElement('div');
      head.className = 'review-finding-head';
      const severity = document.createElement('span');
      severity.className = 'review-severity';
      severity.textContent = finding.severity || 'info';
      head.append(severity);
      if (finding.file) {
        const location = document.createElement('span');
        location.className = 'review-finding-location';
        location.textContent = finding.file + (finding.line ? ':' + finding.line : '');
        head.append(location);
      }
      row.append(head);
      const evidence = document.createElement('p');
      evidence.textContent = finding.evidence || '';
      const recommendation = document.createElement('p');
      recommendation.className = 'review-finding-recommendation';
      recommendation.textContent = finding.recommendation || '';
      row.append(evidence, recommendation);
      section.append(row);
    }
    status.after(section);
  }
  function render(value) {
    review = value || review;
    if (!review) { setStatusText(''); clearReport(); return; }
    const labels = {
      running: 'Review running…',
      completed: 'Review completed',
      failed: 'Review failed',
      cancelled: 'Review cancelled',
      stale: 'Review is stale',
      invalid: 'Reviewer did not submit a report',
      interrupted: 'Review was interrupted',
    };
    setStatusText(labels[review.status] || review.status || '');
    if (review.error) setStatusText((labels[review.status] || '') + '\n' + review.error);
    renderReport(review.report);
    const active = ['running', 'queued'].includes(review.status);
    cancelButton.hidden = !active;
    overrideButton.hidden = !(options?.settings?.gate && !active && review.status
      && (!['completed'].includes(review.status) || review.report?.verdict !== 'pass'));
    startButton.textContent = t(active ? 'Review running…' : 'Start review');
    startButton.disabled = active;
    if (!active) setBusy(false);
  }
  async function loadOptions() {
    if (!context.sessionId) throw new Error(t('Open a conversation first.'));
    const result = await window.dshDesktop.conversationCommand({
      engine: getEngine(), action: 'review-options', payload: { sessionId: context.sessionId },
    });
    if (!result?.ok) throw new Error(result?.error || 'Could not load review options');
    fillOptions(result);
    if (!result.engines?.some(item => item.available)) {
      throw new Error(t('Install or sign in to a reviewer engine first.'));
    }
    setBusy(false);
  }
  function poll() {
    if (!review?.id) return;
    stopPolling();
    pollTimer = setInterval(async () => {
      try {
        const result = await window.dshDesktop.conversationCommand({
          engine: getEngine(), action: 'review-status', payload: { reviewId: review.id },
        });
        if (!result?.ok) return;
        render(result.review);
        if (!['running', 'queued'].includes(result.review?.status)) stopPolling();
      } catch { /* The next open can retry. */ }
    }, 1000);
  }
  async function open() {
    if (!context.sessionId) { setStatus(t('Open a conversation first.')); return; }
    review = null;
    status.textContent = t('Loading review options…');
    clearReport();
    try {
      setBusy(true);
      await loadOptions();
      const listed = await window.dshDesktop.conversationCommand({
        engine: getEngine(), action: 'review-list', payload: { sessionId: context.sessionId },
      });
      const latest = listed?.reviews?.[0] || null;
      if (latest) {
        render(latest);
        if (['running', 'queued'].includes(latest.status)) poll();
      }
      const pending = await window.dshDesktop.conversationCommand({
        engine: getEngine(), action: 'review-consent-pending', payload: { sessionId: context.sessionId },
      });
      if (pending?.consent) renderConsent(pending.consent);
      if (!dialog.open) dialog.showModal();
      status.textContent = '';
    } catch (error) {
      setBusy(false);
      status.textContent = error.message;
      if (!dialog.open) dialog.showModal();
    }
  }
  async function refreshContext() {
    const ticket = ++contextTicket;
    const sessionId = context.sessionId;
    if (!sessionId) return;
    try {
      const result = await window.dshDesktop.conversationCommand({
        engine: getEngine(), action: 'review-context', payload: { sessionId },
      });
      const pending = await window.dshDesktop.conversationCommand({
        engine: getEngine(), action: 'review-consent-pending', payload: { sessionId },
      });
      if (ticket !== contextTicket || sessionId !== context.sessionId) return;
      if (pending?.consent) renderConsent(pending.consent);
      const unavailable = result?.reviewable ? '' : t(result?.reason || 'No reviewable changes');
      toggle.title = unavailable || t('Review this change with another engine');
      toggle.setAttribute('aria-label', unavailable || t('Cross-engine review'));
    } catch { /* Keep the header entry available when context discovery fails. */ }
  }
  async function start(event) {
    event.preventDefault();
    if (!context.sessionId || !engineSelect.value) return;
    setBusy(true);
    setStatusText('Starting review…');
    try {
      const result = await window.dshDesktop.conversationCommand({
        engine: getEngine(), action: 'review-start', payload: {
          sessionId: context.sessionId, reviewerEngine: engineSelect.value, model: modelSelect.value || undefined,
          mode: modeSelect.value, base: baseInput.value.trim(), focus: focusInput.value,
          maxTokens: Number(maxTokensInput.value) || 50000,
          allowSameEngine: options?.settings?.allowSameEngine === true,
        },
      });
      if (!result?.ok) throw new Error(result?.error || 'Could not start review');
      render(result.review);
      void savePolicy({ reviewerEngine: engineSelect.value, model: modelSelect.value || '',
        mode: modeSelect.value, maxTokens: Number(maxTokensInput.value) || 50000 }, { quiet: true });
      poll();
    } catch (error) {
      setBusy(false);
      setStatusText(error.message);
    }
  }
  async function cancel() {
    if (!review?.id) return;
    cancelButton.disabled = true;
    try {
      const result = await window.dshDesktop.conversationCommand({
        engine: getEngine(), action: 'review-cancel', payload: { reviewId: review.id },
      });
      if (result?.ok) render(result.review);
    } catch (error) { setStatusText(error.message); }
    finally { cancelButton.disabled = false; }
  }
  async function overrideGate() {
    if (!context.sessionId) return;
    overrideButton.disabled = true;
    try {
      const goalResult = await window.dshDesktop.conversationCommand({
        engine: getEngine(), action: 'goal-get', payload: { sessionId: context.sessionId },
      });
      const goalId = goalResult?.goal?.id;
      if (!goalResult?.ok || !goalId) throw new Error(t('No active goal to override.'));
      const result = await window.dshDesktop.conversationCommand({
        engine: getEngine(), action: 'review-gate-override',
        payload: { sessionId: context.sessionId, goalId, reason: 'User override from the Review dialog' },
      });
      if (!result?.ok) throw new Error(result?.error || 'Could not override the review gate');
      overrideButton.hidden = true;
      setStatusText('Review gate overridden for this goal.');
    } catch (error) { setStatusText(error.message); }
    finally { overrideButton.disabled = false; }
  }
  function reset() {
    stopPolling();
    review = null;
    removeConsent();
    if (dialog.open) dialog.close();
    clearReport();
    setStatusText('');
    setBusy(false);
  }
  function receive(value) {
    if (!value || value.parentConversationId !== context.sessionId) return;
    render(value);
    if (dialog.open && ['running', 'queued'].includes(value.status)) poll();
    else stopPolling();
  }
  function receiveConsent(value) {
    if (value) renderConsent(value);
  }

  engineSelect.onchange = () => modelOptions();
  agentConsent.onchange = () => void savePolicy({ allowAgentReviews: agentConsent.checked });
  gateToggle.onchange = () => void savePolicy({ gate: gateToggle.checked });
  turnGateToggle.onchange = () => void savePolicy({ turnGate: turnGateToggle.checked });
  sameEngineToggle.onchange = async () => {
    if (await savePolicy({ allowSameEngine: sameEngineToggle.checked })) await loadOptions();
  };
  form.onsubmit = start;
  cancelButton.onclick = cancel;
  overrideButton.onclick = overrideGate;
  toggle.onclick = open;
  closeButton.onclick = () => dialog.close();
  dialog.addEventListener('close', stopPolling);
  window.addEventListener('camellia:open-review', () => void open());
  document.addEventListener('keydown', event => {
    if (!shortcutBindings?.matches(event, 'review')) return;
    event.preventDefault();
    void open();
  });
  window.addEventListener('camellia:language', () => { render(review); void refreshContext(); });
  setTimeout(refreshContext, 0);
  return { reset, open, render, receive, receiveConsent, refreshContext };
};
