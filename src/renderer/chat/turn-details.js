'use strict';

// Settings and transcript chrome share the neutral DeepSeek Harness visual
// language. This module only presents normalized engine usage, never bills it.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CamelliaTurnDetails = api;
})(typeof window === 'object' ? window : globalThis, function () {
  const databaseIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/></svg>';
  const chevron = '<svg class="completion-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>';
  let nextId = 0, openPanel = null;

  // Harness adapters normalize input_tokens as uncached input. Cache reads
  // and writes are separate buckets; counting them twice inflates the total.
  // An omitted bucket is unknown, whereas an explicitly reported zero is zero.
  function usageDetails(usage) {
    if (!usage) return null;
    const count = key => Number.isFinite(usage[key]) && usage[key] >= 0 ? usage[key] : null;
    const input = count('input_tokens'), output = count('output_tokens');
    const cacheRead = count('cache_read_input_tokens'), cacheWrite = count('cache_creation_input_tokens');
    if ([input, output, cacheRead, cacheWrite].every(value => value === null)) return null;
    const inputTotal = (input || 0) + (cacheRead || 0) + (cacheWrite || 0);
    return { input, output, cacheRead, cacheWrite, total: inputTotal + (output || 0),
      cacheHit: input !== null && cacheRead !== null ? (inputTotal ? cacheRead / inputTotal * 100 : 0) : null };
  }

  function text(tag, className, value, translate = false) {
    const el = document.createElement(tag); el.className = className; el.textContent = value;
    if (translate) el.dataset.i18n = '';
    return el;
  }
  function formatDuration(ms) {
    const seconds = Math.round(ms / 1000);
    return seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm ' + seconds % 60 + 's';
  }
  function compactTokens(value) {
    if (value < 1000) return String(value);
    return new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(value / (value < 1e6 ? 1000 : 1e6)) + (value < 1e6 ? 'K' : 'M');
  }
  const exactTokens = value => value.toLocaleString('en-US') + ' tok';

  function completionHeader(turn, info) {
    const result = turn.querySelector('.run-result');
    if (result?.classList.contains('err')) return;
    const header = result || document.createElement('div');
    header.classList.add('turn-completion');
    header.replaceChildren();
    const process = turn.querySelector('.execution-process:not([hidden])');
    const label = document.createElement(process ? 'button' : 'span');
    label.className = 'completion-label';
    label.appendChild(text('span', '', 'Completed', true));
    if (Number.isFinite(info.duration_ms) && info.duration_ms >= 0) {
      label.appendChild(text('span', 'completion-duration', 'Elapsed ' + formatDuration(info.duration_ms), true));
    }
    if (process) {
      label.type = 'button'; label.title = 'Execution process'; label.dataset.i18nAttrs = 'title';
      process.id ||= 'turn-process-' + ++nextId;
      label.setAttribute('aria-controls', process.id);
      const sync = () => label.setAttribute('aria-expanded', String(process.open));
      label.innerHTML += chevron;
      label.onclick = () => { process.open = !process.open; sync(); };
      process.addEventListener('toggle', sync); sync();
    }
    header.appendChild(label);
    turn.insertBefore(header, turn.querySelector('.turn-body'));
    turn.classList.add('has-completion');
  }

  function positionPanel(panel, trigger) {
    const anchor = trigger.getBoundingClientRect(), rect = panel.getBoundingClientRect();
    const top = anchor.top - rect.height - 8;
    panel.style.left = Math.max(12, Math.min(anchor.left, innerWidth - rect.width - 12)) + 'px';
    panel.style.top = Math.max(12, Math.min(top >= 12 ? top : anchor.bottom + 8, innerHeight - rect.height - 12)) + 'px';
  }

  function usagePanel(footer, info) {
    const usage = usageDetails(info.usage);
    if (!usage) return;
    const root = document.createElement('span'); root.className = 'turn-usage';
    const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'turn-usage-trigger';
    trigger.innerHTML = databaseIcon;
    trigger.appendChild(text('span', '', 'Usage ' + compactTokens(usage.total) + ' tok', true));
    trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-expanded', 'false');
    const panel = document.createElement('div'); panel.className = 'turn-usage-panel'; panel.popover = 'auto';
    panel.id = 'turn-usage-' + ++nextId; panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Turn usage'); panel.dataset.i18nAttrs = 'aria-label';
    panel.tabIndex = -1;
    trigger.setAttribute('aria-controls', panel.id); trigger.popoverTargetElement = panel;
    const heading = document.createElement('div'); heading.className = 'turn-usage-heading';
    const title = document.createElement('span'); title.innerHTML = databaseIcon;
    title.appendChild(text('span', '', 'Turn usage', true));
    heading.append(title, text('strong', '', exactTokens(usage.total))); panel.appendChild(heading);
    const details = document.createElement('dl'); details.className = 'turn-usage-details';
    const row = (name, value, className = '') => details.append(text('dt', '', name, true), text('dd', className, value));
    // Historical turns never borrow the currently selected model.
    if (info.model) row('Model', info.model, 'turn-usage-model');
    if (usage.cacheHit !== null) row('Cache hit rate', new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(usage.cacheHit) + '%');
    if (usage.input !== null) row('Uncached input', exactTokens(usage.input));
    if (usage.cacheRead !== null) row('Cache read', exactTokens(usage.cacheRead));
    if (usage.cacheWrite !== null) row('Cache write', exactTokens(usage.cacheWrite));
    if (usage.output !== null) row('Output', exactTokens(usage.output));
    if (Number.isFinite(info.total_cost_usd)) row('Cost', '$' + info.total_cost_usd.toFixed(4));
    panel.appendChild(details); root.append(trigger, panel);
    footer.insertBefore(root, footer.querySelector('time'));
    panel.addEventListener('beforetoggle', event => {
      const opening = event.newState === 'open';
      trigger.setAttribute('aria-expanded', String(opening));
      if (opening) openPanel = panel;
      else if (openPanel === panel) openPanel = null;
    });
    panel.addEventListener('toggle', event => {
      if (event.newState === 'open') positionPanel(panel, trigger);
    });
  }

  function render(turn, info) {
    if (!turn) return;
    completionHeader(turn, info);
    const footer = turn.querySelector('.turn-actions');
    if (footer) usagePanel(footer, info);
  }
  if (typeof document === 'object') {
    const dismiss = event => {
      if (openPanel?.matches(':popover-open') && !openPanel.contains(event.target)) openPanel.hidePopover();
    };
    document.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
  }
  return { usageDetails, render };
});
