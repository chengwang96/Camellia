'use strict';
window.createCodexResetUI = ({ api, onState, onBusy, status }) => {
  const $ = id => document.getElementById(id);
  const dialog = $('codexResetDialog'), confirm = $('confirmCodexReset'), cancel = $('cancelCodexReset');
  const t = text => window.CamelliaI18n.t(text);
  const format = (text, value) => t(text).replace('{0}', String(value));
  const date = seconds => seconds ? new Date(seconds * 1000).toLocaleString(document.documentElement.lang || undefined,
    { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : t('No expiry');
  let generation = 0, accountId = null, preview = null, consuming = false;
  function message(text, error = false) {
    $('codexResetMessage').textContent = t(text);
    $('codexResetMessage').classList.toggle('error', error);
  }
  function render() {
    const credits = preview?.credits;
    $('codexResetEmail').textContent = preview?.account?.email || '—';
    $('codexResetCount').textContent = credits ? format('{0} reset credits available', credits.availableCount) : t('Reset credit information is unavailable.');
    const available = (credits?.credits || []).filter(credit => credit.status === 'available' && credit.resetType === 'codexRateLimits'
      && (!credit.expiresAt || credit.expiresAt * 1000 > Date.now()))
      .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
    const expiry = available.find(credit => credit.expiresAt)?.expiresAt;
    $('codexResetExpiry').textContent = expiry ? format('Earliest expiry: {0}', date(expiry)) : '';
    $('codexResetExpiry').hidden = !expiry;
    const rows = $('codexResetCredits'); rows.replaceChildren();
    for (const credit of available) {
      const row = document.createElement('li'), badge = document.createElement('span'), detail = document.createElement('dl');
      const selected = credit.id === preview.creditId;
      row.classList.toggle('selected', selected);
      badge.className = 'codex-reset-credit-status'; badge.textContent = t(selected ? 'Will be used' : 'Available');
      for (const [label, value] of [['Granted', credit.grantedAt ? date(credit.grantedAt) : '—'], ['Expires', date(credit.expiresAt)]]) {
        const group = document.createElement('div'), term = document.createElement('dt'), content = document.createElement('dd');
        term.textContent = t(label); content.textContent = value; group.append(term, content); detail.append(group);
      }
      row.append(badge, detail); rows.append(row);
    }
    $('codexResetDetails').hidden = !available.length;
    $('codexResetDetailHint').hidden = !credits?.availableCount || available.length >= credits.availableCount;
    $('codexResetDetailHint').textContent = t(available.length ? 'Only some credit details are available.' : 'The provider will select a reset credit. Credit dates are unavailable.');
    confirm.textContent = t(preview?.retry ? 'Retry this reset request' : 'Confirm and use one credit');
    confirm.disabled = !preview?.confirmationToken || consuming;
    if (preview?.retry) message('The previous reset result is unknown. Retry to check the same request; no new request will be created.');
    else if (credits?.availableCount === 0) message('No reset credits are available for this account.');
    else if (!credits) message('Reset credit information is unavailable. Refresh the account or update Codex CLI and try again.', true);
    else message('');
  }
  const close = () => { if (!consuming) dialog.close(); };
  cancel.onclick = close; $('closeCodexReset').onclick = close;
  dialog.addEventListener('cancel', event => { if (consuming) event.preventDefault(); });
  dialog.addEventListener('close', () => { generation++; preview = null; accountId = null; onBusy(false); });
  confirm.onclick = async () => {
    if (consuming || !preview?.confirmationToken) return;
    consuming = true; confirm.disabled = true; cancel.disabled = true; $('closeCodexReset').disabled = true;
    message('Using reset credit…');
    try {
      const result = await api.codexAccountResetConsume({ id: accountId, confirmed: true, confirmationToken: preview.confirmationToken });
      if (!result.ok) throw new Error(result.error);
      onState(result);
      const outcomes = { reset: 'Usage reset.',
        alreadyRedeemed: 'This reset request was already completed.',
        nothingToReset: 'There is no eligible usage to reset.', noCredit: 'No reset credits are available for this account.' };
      status(t(outcomes[result.outcome] || 'The reset result is unknown.') + (result.warning ? ' ' + t(result.warning) : ''), Boolean(result.warning));
      consuming = false; dialog.close();
    } catch (error) {
      // Keep the original confirmation token for an explicit retry.
      message(error.message, true);
      confirm.textContent = t('Retry this reset request');
    } finally {
      consuming = false; confirm.disabled = !preview?.confirmationToken; cancel.disabled = false; $('closeCodexReset').disabled = false;
    }
  };
  async function open(id) {
    if (dialog.open || consuming) return;
    accountId = id; preview = null; const request = ++generation;
    $('codexResetEmail').textContent = '—'; $('codexResetCount').textContent = t('Checking reset credits…');
    $('codexResetExpiry').hidden = true; $('codexResetDetails').hidden = true; $('codexResetDetailHint').hidden = true;
    confirm.textContent = t('Confirm and use one credit'); confirm.disabled = true;
    message(''); onBusy(true); dialog.showModal(); cancel.focus();
    try {
      const result = await api.codexAccountResetPreview(id);
      if (!result.ok) throw new Error(result.error);
      onState(result);
      if (request !== generation || !dialog.open) return;
      preview = result.preview; render();
    } catch (error) { if (request === generation && dialog.open) message(error.message, true); }
  }
  return { open };
};
