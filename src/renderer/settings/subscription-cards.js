'use strict';
window.renderSubscriptionCards = ({ container, state, busy, engine, manage = true, onSelect, onRemove, onLabel, onRefresh, onWake, onSignIn }) => {
  container.setAttribute('role', 'group');
  const t = text => window.CamelliaI18n.t(text);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const paths = {
    switch: '<path d="M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4"/>',
    edit: '<path d="m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14z"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6"/>',
    wake: '<path d="m13 2-9 12h7l-1 8 10-12h-7z"/>',
    remove: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
    logout: '<path d="M9 4H4v16h5m6-13 5 5-5 5m-7-5h12"/>',
    login: '<path d="M15 4h5v16h-5M9 7l5 5-5 5m-6-5h11"/>',
  };
  const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
  const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString(document.documentElement.lang || undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  const relative = value => {
    const time = value && Date.parse(value);
    if (!Number.isFinite(time)) return '';
    const minutes = Math.round((time - Date.now()) / 60000);
    if (minutes <= 0) return t('now');
    const days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60), rest = minutes % 60;
    return days ? `${days}${t('d')} ${hours}${t('h')}` : hours ? `${hours}${t('h')} ${rest}${t('m')}` : `${rest}${t('m')}`;
  };
  const planClass = value => /max|pro|ultra/i.test(String(value || '')) ? ' premium' : /plus/i.test(String(value || '')) ? ' paid' : '';
  // A meter turns amber below a quarter and red below a tenth so the card
  // reads at a glance instead of relying on the number alone.
  const level = remaining => remaining < 10 ? 'critical' : remaining < 25 ? 'low' : 'ok';
  if (container.querySelector('.subscription-note:not([hidden])')) return;
  container.innerHTML = (state?.accounts || []).map(account => {
    const action = (name, label, disabled = false, hint = label) => `<button type="button" data-card-action="${name}" title="${esc(t(hint))}" aria-label="${esc(t(label))}" ${disabled ? 'disabled' : ''}>${icon(name)}</button>`;
    const windows = account.quotaWindows || [];
    const quotas = windows.map(window => {
      const known = typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent);
      const remaining = known ? Math.max(0, Math.min(100, 100 - window.usedPercent)) : null;
      const reset = window.resetsAt ? relative(window.resetsAt) : '';
      return `<div class="subscription-meter ${known ? level(remaining) : 'unknown'}"><div class="subscription-meter-head">${esc(t(window.label || 'Usage'))}</div>
        <div class="subscription-meter-row">${known ? `<progress max="100" value="${remaining}" aria-label="${esc(t(window.label || 'Usage') + ' · ' + t('Remaining quota'))}"></progress>` : ''}<strong>${known ? Math.round(remaining) + '%' : '—'}</strong></div>
        <small>${esc(window.resetsAt ? t('Resets') + ' ' + date(window.resetsAt) + (reset ? ' · ' + reset : '') : t('Reset time unavailable'))}</small></div>`;
    }).join('');
    const heading = account.email || account.label || (account.signedIn && engine === 'antigravity' ? t('Google account') : t('Not signed in'));
    const accountStatus = account.error ? 'error' : account.loginPending ? 'pending' : account.exhausted ? 'exhausted' : account.signedIn ? 'signed-in' : account.stale ? 'stale' : '';
    const note = typeof onLabel === 'function' ? account.label || t('No note')
      : account.models ? t('Available account models') + ' · ' + account.models : '';
    const badges = `${account.active ? `<span class="subscription-current">${esc(t('Current'))}</span>` : ''}<span class="subscription-plan${account.plan ? planClass(account.plan) : ''}">${esc(account.plan || (engine === 'codex' ? 'ChatGPT' : engine === 'antigravity' ? 'Google' : 'Kimi'))}</span>`;
    const wake = engine === 'codex' || engine === 'kimi'
      ? action('wake', 'Wake account', !account.signedIn, 'Send 你好 once and refresh quota. Uses subscription allowance; does not reset an active window.') : '';
    const sessionActions = `${action('switch', 'Switch account', account.active || !account.signedIn, 'Use this account on the next message')}${wake}${!account.signedIn ? action('login', 'Sign in') : ''}${account.id === 'default' ? action('logout', 'Sign out', !account.signedIn) : action('remove', 'Remove account')}`;
    return `<article class="subscription-card${account.active ? ' active' : ''}" data-card-id="${esc(account.id)}">
      <header><strong title="${esc(heading)}">${esc(heading)}</strong><span class="subscription-badges">${badges}</span></header>
      <div class="subscription-identity-meta">
        <p class="subscription-state ${accountStatus}"><i aria-hidden="true"></i>${esc(account.error || t(account.loginPending ? 'Waiting for sign-in' : account.signedIn ? account.exhausted ? 'Quota exhausted' : 'Signed in' : account.stale ? 'Previous verification expired. Verify again.' : 'Not signed in'))}</p>
        ${note ? `<span class="subscription-note-text${account.label ? '' : ' is-empty'}" title="${esc(note)}">${esc(note)}</span>` : ''}
      </div>
      <div class="subscription-meters">${quotas || `<p class="hint">${esc(t(account.signedIn ? 'Quota information is currently unavailable.' : 'Sign in to view quota'))}</p>`}</div>
      <form class="subscription-note" hidden><input maxlength="60" data-account-label="${esc(account.id)}" aria-label="${esc(t('Account label'))}" value="${esc(account.label)}"><button type="submit">${esc(t('Save'))}</button><button type="button" data-note-cancel>${esc(t('Cancel'))}</button></form>
      <div class="subscription-meta">
        <span class="subscription-checked">${esc(account.verifiedAt ? t('Last checked') + ' ' + date(account.verifiedAt) : t('Not checked yet'))}</span>
      </div>
      <footer class="subscription-actions">
        <div class="subscription-actions-tools">
          ${typeof onLabel === 'function' ? action('edit', 'Edit note') : ''}
          <button type="button" data-card-action="refresh" title="${esc(t('Refresh quota'))}" aria-label="${esc(t('Refresh quota'))}" ${!account.signedIn && !account.stale ? 'disabled' : ''}>${icon('refresh')}</button>
        </div>
        ${manage ? `<div class="subscription-actions-main">${sessionActions}</div>` : ''}
      </footer>
    </article>`;
  }).join('') || `<p class="hint">${esc(t('No accounts yet.'))}</p>`;
  container.querySelectorAll('.subscription-card').forEach(card => {
    const id = card.dataset.cardId, form = card.querySelector('form'), input = form.querySelector('input');
    for (const control of card.querySelectorAll('button, input')) control.disabled ||= busy || Boolean(state?.accounts?.some(a => a.loginPending));
    card.querySelectorAll('[data-card-action]').forEach(button => { button.onclick = () => {
      switch (button.dataset.cardAction) {
        case 'switch': return onSelect(id);
        case 'edit': form.hidden = false; input.focus(); input.select(); return;
        case 'refresh': return onRefresh(id);
        case 'wake': return onWake(id);
        case 'login': return onSignIn(id);
        case 'logout': case 'remove':
          if (window.confirm(t(id === 'default' ? 'Sign out of this account?' : 'Remove this account and its local login data?'))) return onRemove(id);
      }
    }; });
    form.onsubmit = event => { event.preventDefault(); form.hidden = true; void onLabel(id, input.value); };
    form.querySelector('[data-note-cancel]').onclick = () => { form.hidden = true; };
    input.onkeydown = event => { if (event.key === 'Escape') { form.hidden = true; card.querySelector('[data-card-action=edit]').focus(); } };
  });
};
