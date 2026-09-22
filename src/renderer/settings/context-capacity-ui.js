'use strict';

window.createContextCapacityUI = function ({ api, current, assertClean, status, esc, fmt, keyName }) {
  let state = { entries: [], active: null }, selection = null;
  const element = id => document.getElementById(id);
  const translate = text => window.CamelliaI18n.t(text);
  const line = (label, value) => `<div><span data-i18n>${label}</span>: ${esc(value)}</div>`;
  const statuses = { running: 'Probing…', range: 'Boundary range found', input_cap: 'Input cap reached', request_cap: 'Request limit reached',
    budget: 'Total input budget reached', cancelled: 'Cancelled', timeout: 'Timed out', network_error: 'Network error',
    body_limit: 'Request body limit, not a context limit', rate_limit: 'Rate limited, not a context limit', http_error: 'API error, not a confirmed context limit',
    invalid_response: 'Invalid model response', interrupted: 'Interrupted by restart', configuration_changed: 'Configuration changed' };
  function render() {
    const host = element('contextCapacityResults');
    if (!host) return;
    const provider = current();
    host.innerHTML = state.entries.filter(entry => entry.providerId === provider?.id).map(entry => {
      const key = provider.keys.find(item => item.id === entry.keyId);
      const probe = entry.probe, passive = entry.passive;
      const samples = probe?.samples || [];
      const accepted = samples.filter(sample => sample.kind === 'accepted');
      const actual = accepted.filter(sample => sample.reportedInput !== null).map(sample => sample.reportedInput);
      const declared = samples.find(sample => sample.declared)?.declared || passive?.lastContextError?.declared;
      return `<div class="context-capacity-card"><strong>${esc(entry.model)} · ${esc(keyName(key || {}))} · ${esc(entry.protocol)}</strong>
        ${line('Provider-declared context', entry.declared ? fmt(entry.declared) : translate('Unknown'))}
        ${declared ? line('Limit reported in API error', fmt(declared)) : ''}
        ${passive?.maxReportedInput ? line('Largest observed input (provider tokens)', fmt(passive.maxReportedInput)) + line('Observed at', new Date(passive.at).toLocaleString()) : ''}
        ${probe ? `<p data-i18n>${statuses[probe.status] || 'Unknown'}</p>
          ${line('Probe input estimate: accepted / rejected', `${probe.acceptedEstimate ? '≈' + fmt(probe.acceptedEstimate) : '—'} / ${probe.rejectedEstimate ? '≈' + fmt(probe.rejectedEstimate) : '—'}`)}
          ${line('Largest probe input (provider tokens)', actual.length ? fmt(Math.max(...actual)) : translate('Unknown'))}
          ${line('Requests / limit', `${samples.length} / ${probe.maxRequests}`)}
          ${line('Output token budget', fmt(probe.outputBudget))}
          ${line('Measured at', new Date(probe.at).toLocaleString())}
          <p class="hint" data-i18n>${accepted.some(sample => !sample.markersFound) ? 'Some markers were missing. Retention is unverified; this is not proof of truncation.' : 'Accepted requests do not prove full retention. Estimates are not tokenizer counts or the model maximum.'}</p>` : ''}
        </div>`;
    }).join('') || '<p class="hint" data-i18n>No capacity evidence yet. Save a model and key first.</p>';
    element('contextCapacityCancel').hidden = !state.active;
    element('contextCapacityStart').disabled = !!state.active;
  }
  async function refresh() {
    try { const next = await api.contextCapacity(); if (next?.ok) state = next; render(); } catch (error) { status(error.message, true); }
  }
  function mount() {
    const host = element('contextCapacityPanel');
    if (!host) return;
    host.innerHTML = `<details class="advanced section"><summary data-i18n>Context capacity evidence</summary>
      <p class="hint" data-i18n>Normal requests collect evidence without extra API calls. Probes use synthetic text on one saved route and never change your configured context window.</p>
      <button id="contextCapacityStart" data-i18n>Detect context capacity</button> <button id="contextCapacityCancel" hidden data-i18n>Cancel probe</button>
      <div id="contextCapacityResults" role="status" aria-live="polite"></div></details>`;
    element('contextCapacityStart').onclick = async () => {
      try {
        assertClean();
        const provider = current(), model = element('verifyModel').value;
        if (!model) throw new Error('Add and select a model first');
        selection = { providerId: provider.id, model };
        element('contextProbeTarget').textContent = `${provider.name} · ${model}`;
        element('contextProbeKey').innerHTML = provider.keys.filter(key => key.enabled && (key.key || key.maskedKey))
          .map(key => `<option value="${esc(key.id)}">${esc(keyName(key))}</option>`).join('');
        if (!element('contextProbeKey').value) throw new Error('Add a key to validate with first');
        const mapping = provider.models.find(item => item.id === model);
        const protocols = mapping.protocol && mapping.protocol !== 'auto' ? [mapping.protocol] : provider.protocol === 'dual' ? ['openai', 'anthropic'] : [provider.protocol];
        element('contextProbeProtocol').innerHTML = protocols.map(protocol => `<option value="${esc(protocol)}">${esc(protocol)}</option>`).join('');
        element('contextProbeConfirm').checked = false;
        element('contextProbeSubmit').disabled = true;
        element('contextProbeDialog').showModal();
      } catch (error) { status(error.message, true); }
    };
    element('contextCapacityCancel').onclick = async () => {
      try { const next = await api.contextCapacityCancel(); if (!next.ok) throw new Error(next.error); state = next; render(); } catch (error) { status(error.message, true); }
    };
    render();
    void refresh();
  }
  element('contextProbeConfirm').onchange = event => { element('contextProbeSubmit').disabled = !event.target.checked; };
  element('contextProbeSubmit').onclick = async () => {
    try {
      assertClean();
      element('contextProbeSubmit').disabled = true;
      const next = await api.contextCapacityStart({ ...selection, keyId: element('contextProbeKey').value, protocol: element('contextProbeProtocol').value,
        maxEstimate: Number(element('contextProbeMax').value), maxRequests: Number(element('contextProbeRequests').value), confirmed: element('contextProbeConfirm').checked });
      if (!next.ok) throw new Error(next.error);
      state = next;
      element('contextProbeDialog').close();
      render();
    } catch (error) { status(error.message, true); }
    finally { element('contextProbeSubmit').disabled = !element('contextProbeConfirm').checked; }
  };
  api.onContextCapacity(next => { state = next; render(); });
  window.addEventListener('camellia:language', render);
  return { mount, refresh };
};
