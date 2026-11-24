'use strict';

(() => {
  const api = window.dshDesktop;
  const $ = id => document.getElementById(id);
  const switchEl = $('surfaceSwitch');
  const engineSwitch = $('engineSwitch');
  const webProviderButton = $('webProviderButton');
  const webProviderLabel = $('webProviderLabel');
  const stage = $('webSurfaceStage');
  const sessionList = $('sessionList');
  const webList = $('webSessionList');
  const placeholder = $('webSurfacePlaceholder');
  const headerTitle = $('headerTitle');
  const agentHeaderActions = $('agentHeaderActions');
  const webHeaderActions = $('webHeaderActions');
  const newSessionBtn = $('newSessionBtn');
  const newSessionLabel = $('newSessionLabel');
  const logoMark = document.querySelector('.logo-icon');
  const logoImage = document.querySelector('.logo-icon img');
  const logoText = $('logoText');
  const logoBadge = $('logoBadge');
  const t = (key, fallback = key) => window.CamelliaI18n?.t(key) || fallback;

  if (!switchEl || !engineSwitch || !stage || !sessionList || !webList) return;
  if (!api?.webSurfaceCommand || !api?.webSurfaceState) {
    switchEl.hidden = true;
    return;
  }

  const agent = {
    options: [...engineSwitch.options].map(option => ({ value: option.value, text: option.textContent })),
    value: engineSwitch.value,
    title: headerTitle.textContent,
    logo: {
      src: logoImage?.getAttribute('src') || '',
      text: logoText?.textContent || '',
      badge: logoBadge?.textContent || 'HARNESS',
      engine: logoMark?.dataset.engine || '',
    },
    newSessionLabel: newSessionLabel?.textContent || 'New session',
    newSessionTitle: newSessionBtn.title,
    scrollTop: sessionList.scrollTop,
    headerActionsHidden: agentHeaderActions?.hidden === true,
  };
  let surface = 'agent';
  let webState = null;
  let provider = 'deepseek';
  let layoutOpen = false;
  let menu = null;
  let sessionMenu = null;
  let providerMenuEl = null;
  let providerMenuBackdrop = null;
  let providerMenuOpen = false;
  let providerMenuGeneration = 0;
  let boundsFrame = 0;
  let sentContentWidth = null;
  let occluded = false;
  let settingsOccluded = false;
  let multiSelectMode = false;
  let renamingWebSessionId = null;
  const selectedWebSessionIds = new Set();
  const webListScroll = { deepseek: 0, kimi: 0 };
  let renderedProvider = null;

  function command(action, payload = {}) {
    return api.webSurfaceCommand(action, payload).catch(error => ({ ok: false, error: error.message }));
  }

  function providerInfo(id = provider) {
    return webState?.providers?.find(item => item.id === id)
      || { id, label: id === 'kimi' ? 'Kimi Web' : 'DeepSeek Web', shortLabel: id === 'kimi' ? 'Kimi' : 'DeepSeek', brand: id };
  }

  function currentTitle() {
    const info = providerInfo();
    if (webState && !webState.activeId) return t('New web conversation', 'New web conversation');
    return webState?.title || t(info.label, info.label);
  }

  function setLogo(info) {
    if (!logoImage || !logoText || !logoBadge) return;
    logoImage.src = '../../../assets/brands/' + info.brand + '.svg';
    logoImage.alt = '';
    if (logoMark) logoMark.dataset.engine = info.brand;
    logoText.textContent = info.shortLabel || info.label;
    logoBadge.textContent = 'WEB';
  }

  function restoreAgentChrome() {
    if (logoImage) {
      logoImage.src = agent.logo.src;
      logoImage.alt = '';
    }
    if (logoMark && agent.logo.engine) logoMark.dataset.engine = agent.logo.engine;
    if (logoText) logoText.textContent = agent.logo.text;
    if (logoBadge) logoBadge.textContent = agent.logo.badge;
    headerTitle.textContent = agent.title;
    if (newSessionLabel) newSessionLabel.textContent = agent.newSessionLabel;
    newSessionBtn.title = agent.newSessionTitle;
    engineSwitch.replaceChildren(...agent.options.map(option => {
      const element = document.createElement('option');
      element.value = option.value;
      element.textContent = option.text;
      return element;
    }));
    engineSwitch.value = agent.value;
    engineSwitch.disabled = false;
    engineSwitch.hidden = false;
    webProviderButton.hidden = true;
    webProviderButton.setAttribute('aria-expanded', 'false');
    agentHeaderActions.hidden = agent.headerActionsHidden;
    webHeaderActions.hidden = true;
    document.body.classList.remove('web-mode');
    sessionList.hidden = false;
    webList.hidden = true;
    stage.hidden = true;
    sessionList.scrollTop = agent.scrollTop;
    document.dispatchEvent(new CustomEvent('camellia:surface-change', { detail: { surface: 'agent' } }));
  }

  function populateWebProviders() {
    const providers = webState?.providers?.length ? webState.providers : [
      { id: 'deepseek', label: 'DeepSeek Web' },
      { id: 'kimi', label: 'Kimi Web' },
    ];
    engineSwitch.replaceChildren(...providers.map(item => {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = t(item.label, item.label);
      return option;
    }));
    if (!providers.some(item => item.id === provider)) provider = providers[0]?.id || 'deepseek';
    engineSwitch.value = provider;
  }

  function updateWebChrome() {
    const info = providerInfo();
    agentHeaderActions.hidden = true;
    webHeaderActions.hidden = false;
    document.body.classList.add('web-mode');
    sessionList.hidden = true;
    webList.hidden = false;
    setLogo(info);
    headerTitle.textContent = currentTitle();
    if (newSessionLabel) newSessionLabel.textContent = t('New web conversation', 'New web conversation');
    newSessionBtn.title = t('New web conversation', 'New web conversation');
    engineSwitch.disabled = false;
    engineSwitch.hidden = true;
    webProviderButton.hidden = false;
    webProviderLabel.textContent = t(info.label, info.label);
    $('webBack').disabled = !webState?.canGoBack;
    $('webForward').disabled = !webState?.canGoForward;
    // The placeholder only covers the provider's first appearance. Once the
    // view is ready, navigations keep the native page visible while loading,
    // matching normal browser behavior.
    placeholder.textContent = webState?.error
      || (webState?.ready === false ? t('Loading web page…', 'Loading web page…') : '');
    stage.setAttribute('aria-busy', String(webState?.ready === false && !webState?.error));
  }

  function renderWebSessions() {
    if (renamingWebSessionId) return;
    if (!webState) {
      webList.replaceChildren();
      const loading = document.createElement('div');
      loading.className = 'web-session-empty';
      loading.textContent = t('Loading web conversations…', 'Loading web conversations…');
      webList.appendChild(loading);
      return;
    }
    if (renderedProvider) webListScroll[renderedProvider] = webList.scrollTop;
    const scrollTop = webListScroll[webState.provider || provider] || 0;
    const fragment = document.createDocumentFragment();
    const group = document.createElement('div');
    group.className = 'sb-group sb-flex';
    const label = document.createElement('span');
    const sessions = Array.isArray(webState.sessions) ? webState.sessions : [];
    const sessionIds = new Set(sessions.map(session => session.id));
    for (const id of selectedWebSessionIds) if (!sessionIds.has(id)) selectedWebSessionIds.delete(id);
    label.textContent = multiSelectMode
      ? t('{0} selected', '{0} selected').replace('{0}', String(selectedWebSessionIds.size))
      : t('Web conversations', 'Web conversations');
    group.append(label);
    if (!multiSelectMode) {
      const refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.className = 'session-more web-refresh';
      refresh.title = t('Refresh web conversations', 'Refresh web conversations');
      refresh.setAttribute('aria-label', refresh.title);
      refresh.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/></svg>';
      refresh.addEventListener('click', async () => {
        const result = await command('refresh-sessions');
        if (result.state) {
          webState = result.state;
          updateWebChrome();
          renderWebSessions();
        } else if (!result.ok) {
          window.alert(result.error || t('The website action failed.', 'The website action failed.'));
        }
      });
      group.append(refresh);
    }
    fragment.appendChild(group);

    if (multiSelectMode) {
      const bulk = document.createElement('div');
      bulk.className = 'web-session-bulk';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'web-session-bulk-cancel';
      cancel.textContent = t('Exit multi-select', 'Exit multi-select');
      cancel.addEventListener('click', () => {
        multiSelectMode = false;
        selectedWebSessionIds.clear();
        renderWebSessions();
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'web-session-bulk-delete';
      remove.textContent = t('Delete selected', 'Delete selected');
      remove.disabled = selectedWebSessionIds.size === 0;
      remove.addEventListener('click', () => void deleteSelectedWebSessions());
      bulk.append(cancel, remove);
      fragment.appendChild(bulk);
    }

    if (sessions.length) {
      for (const session of sessions) {
        const item = document.createElement('div');
        item.className = 'session-item web-session-item'
          + (session.id === webState.activeId ? ' active' : '')
          + (selectedWebSessionIds.has(session.id) ? ' selected' : '');
        item.dataset.webSessionId = session.id;
        item.tabIndex = 0;
        item.setAttribute('role', multiSelectMode ? 'checkbox' : 'link');
        if (multiSelectMode) item.setAttribute('aria-checked', String(selectedWebSessionIds.has(session.id)));
        else if (session.id === webState.activeId) item.setAttribute('aria-current', 'page');
        if (multiSelectMode) {
          const check = document.createElement('span');
          check.className = 'web-session-check' + (selectedWebSessionIds.has(session.id) ? ' checked' : '');
          check.setAttribute('aria-hidden', 'true');
          item.appendChild(check);
        }
        const icon = document.createElement('img');
        icon.className = 'web-session-brand';
        icon.src = '../../../assets/brands/' + (webState.provider || provider) + '.svg';
        icon.alt = '';
        const title = document.createElement('span');
        title.className = 'session-item-text';
        title.textContent = session.title;
        item.append(icon, title);
        const activate = async () => {
          if (multiSelectMode) {
            if (selectedWebSessionIds.has(session.id)) selectedWebSessionIds.delete(session.id);
            else selectedWebSessionIds.add(session.id);
            renderWebSessions();
            return;
          }
          if (session.id === webState.activeId) return;
          const result = await command('navigate', { url: session.url });
          if (result.state) {
            webState = result.state;
            updateWebChrome();
            renderWebSessions();
          }
        };
        item.addEventListener('click', activate);
        item.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            activate();
          }
        });
        if (!multiSelectMode) {
          const more = document.createElement('button');
          more.type = 'button';
          more.className = 'session-more web-session-more';
          more.title = t('Conversation actions', 'Conversation actions');
          more.setAttribute('aria-label', more.title);
          more.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><circle cx="5" cy="12" r=".8"/><circle cx="12" cy="12" r=".8"/><circle cx="19" cy="12" r=".8"/></svg>';
          more.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            openWebSessionMenu(more, session, item);
          });
          item.appendChild(more);
          item.addEventListener('contextmenu', event => {
            event.preventDefault();
            event.stopPropagation();
            openWebSessionMenu(null, session, item, { x: event.clientX, y: event.clientY });
          });
        }
        fragment.appendChild(item);
      }
    } else {
      const empty = document.createElement('div');
      empty.className = 'web-session-empty';
      empty.textContent = webState.loading
        ? t('Loading web conversations…', 'Loading web conversations…')
        : t('Sign in on the web page or start a new conversation.', 'Sign in on the web page or start a new conversation.');
      fragment.appendChild(empty);
    }

    if (webState.error || webState.layout?.status === 'error') {
      const error = document.createElement('div');
      error.className = 'web-session-error';
      error.textContent = webState.error || (webState.layout?.error
        ? t(webState.layout.error, webState.layout.error)
        : t('The web layout needs attention.', 'The web layout needs attention.'));
      fragment.appendChild(error);
    }

    const layoutButton = document.createElement('button');
    layoutButton.type = 'button';
    layoutButton.className = 'web-layout-button';
    layoutButton.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/></svg><span></span>';
    layoutButton.querySelector('span').textContent = t('Web layout and sign-in', 'Web layout and sign-in');
    layoutButton.addEventListener('click', () => openLayoutDialog());
    fragment.appendChild(layoutButton);

    webList.replaceChildren(fragment);
    webList.scrollTop = scrollTop;
    renderedProvider = webState.provider || provider;
  }

  function closeSessionMenu() {
    sessionMenu?.remove();
    sessionMenu = null;
  }

  function openWebSessionMenu(anchor, session, item, point = null) {
    closeMenu();
    closeSessionMenu();
    sessionMenu = document.createElement('div');
    sessionMenu.className = 'dsh-pop action-menu web-session-menu';
    sessionMenu.setAttribute('role', 'menu');
    const add = (label, run, danger = false) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.className = 'pop-row' + (danger ? ' danger' : '');
      const text = document.createElement('span');
      text.textContent = label;
      button.appendChild(text);
      button.addEventListener('click', () => {
        closeSessionMenu();
        void run();
      });
      sessionMenu.appendChild(button);
    };
    add(t('Rename', 'Rename'), () => startWebSessionRename(session, item));
    add(t('Pin / Unpin', 'Pin / Unpin'), () => runWebSessionAction(session, 'pin'));
    add(t('Share', 'Share'), () => runWebSessionAction(session, 'share'));
    add(t('Multi-select', 'Multi-select'), () => {
      multiSelectMode = true;
      selectedWebSessionIds.clear();
      selectedWebSessionIds.add(session.id);
      renderWebSessions();
    });
    add(t('Delete conversation', 'Delete conversation'), () => deleteWebSession(session), true);
    sessionMenu.addEventListener('keydown', event => {
      const rows = [...sessionMenu.querySelectorAll('button:not(:disabled)')];
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const index = rows.indexOf(document.activeElement);
        rows[(index + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeSessionMenu();
        item.focus();
      }
    });
    sessionMenu.style.visibility = 'hidden';
    document.body.appendChild(sessionMenu);
    const sidebar = $('sidebar').getBoundingClientRect();
    const menuWidth = sessionMenu.offsetWidth, menuHeight = sessionMenu.offsetHeight;
    const maxLeft = Math.max(8, Math.min(innerWidth - menuWidth - 8, sidebar.right - menuWidth - 8));
    const maxTop = Math.max(8, innerHeight - menuHeight - 8);
    let left, top;
    if (point) {
      left = Math.max(8, Math.min(maxLeft, point.x));
      top = Math.max(8, Math.min(maxTop, point.y));
    } else {
      const rect = anchor.getBoundingClientRect();
      left = Math.max(8, Math.min(maxLeft, rect.left));
      top = Math.max(8, Math.min(maxTop, rect.bottom + 4));
    }
    sessionMenu.style.left = left + 'px';
    sessionMenu.style.top = top + 'px';
    sessionMenu.style.visibility = '';
    sessionMenu.querySelector('button:not(:disabled)')?.focus();
  }

  async function runWebSessionAction(session, action) {
    const result = await command('session-action', { sessionId: session.id, action });
    if (!result.ok) {
      window.alert(result.error || t('The website action failed.', 'The website action failed.'));
      return false;
    }
    return true;
  }

  function startWebSessionRename(session, item) {
    const title = item.querySelector('.session-item-text');
    if (!title) return;
    renamingWebSessionId = session.id;
    item.classList.add('renaming');
    const input = document.createElement('input');
    input.className = 'session-rename-input web-session-rename';
    input.value = session.title;
    input.maxLength = 180;
    input.setAttribute('aria-label', t('Rename', 'Rename'));
    title.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async save => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      renamingWebSessionId = null;
      if (save && next && next !== session.title) {
        const result = await command('session-action', { sessionId: session.id, action: 'rename', value: next });
        if (!result.ok) window.alert(result.error || t('The website action failed.', 'The website action failed.'));
      }
      item.classList.remove('renaming');
      await command('refresh-sessions');
      renderWebSessions();
    };
    input.addEventListener('click', event => event.stopPropagation());
    input.addEventListener('pointerdown', event => event.stopPropagation());
    input.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); void finish(true); }
      else if (event.key === 'Escape') { event.preventDefault(); void finish(false); }
    });
    input.addEventListener('blur', () => void finish(true));
  }

  async function deleteWebSession(session) {
    if (!window.confirm(t('Delete this web conversation from the official website?',
      'Delete this web conversation from the official website?'))) return;
    await runWebSessionAction(session, 'delete');
  }

  async function deleteSelectedWebSessions() {
    const ids = [...selectedWebSessionIds];
    if (!ids.length) return;
    const message = t('Delete {0} selected web conversations from the official website?',
      'Delete {0} selected web conversations from the official website?').replace('{0}', String(ids.length));
    if (!window.confirm(message)) return;
    const failures = [];
    for (const id of ids) {
      const result = await command('session-action', { sessionId: id, action: 'delete' });
      if (!result.ok) failures.push(result.error || id);
    }
    multiSelectMode = false;
    selectedWebSessionIds.clear();
    await command('refresh-sessions');
    renderWebSessions();
    if (failures.length) window.alert(failures.join('\n'));
  }

  function pushBounds() {
    if (surface !== 'web' || document.hidden || layoutOpen || providerMenuOpen || occluded) return;
    cancelAnimationFrame(boundsFrame);
    boundsFrame = requestAnimationFrame(() => {
      const rect = stage.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      void command('bounds', { bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
      syncContentWidth();
    });
  }

  function agentContentWidth() {
    const rect = stage.getBoundingClientRect();
    const styles = getComputedStyle(document.getElementById('chatScroll'));
    const horizontalPadding = (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0);
    const available = Math.max(0, rect.width - horizontalPadding);
    const configured = getComputedStyle(document.documentElement).getPropertyValue('--content-width').trim();
    if (!configured || configured === 'none') return Math.round(available);
    const target = parseFloat(configured);
    return Math.round(Number.isFinite(target) ? Math.min(target, available) : available);
  }

  function syncContentWidth() {
    if (surface !== 'web' || stage.hidden || occluded || layoutOpen) return;
    const width = agentContentWidth();
    if (width < 200 || width === sentContentWidth) return;
    sentContentWidth = width;
    void command('content-width', { width });
  }

  function showPayload() {
    const rect = stage.getBoundingClientRect();
    const contentWidth = agentContentWidth();
    if (contentWidth >= 200) sentContentWidth = contentWidth;
    return {
      provider,
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      ...(contentWidth >= 200 ? { contentWidth } : {}),
    };
  }

  function hasBlockingOverlay() {
    return settingsOccluded || Boolean(document.querySelector('dialog[open], .perm-mask.visible'));
  }

  function syncOverlayOcclusion() {
    if (surface !== 'web') return;
    const next = hasBlockingOverlay() || layoutOpen;
    if (next === occluded) return;
    occluded = next;
    if (next) {
      void command('hide');
      return;
    }
    void command('show', showPayload());
  }

  async function showWeb() {
    if (document.querySelector('dialog[open]')) return;
    if (surface === 'web') return;
    occluded = false;
    for (const [panelId, closeId] of [['workPanel', 'workPanelClose'], ['contextPanel', 'contextPanelClose'], ['reviewPanel', 'reviewClose']]) {
      const panel = $(panelId);
      if (panel && !panel.hidden) $(closeId)?.click();
    }
    const fileViewer = $('fileViewer');
    if (fileViewer && !fileViewer.hidden) $('fileViewerClose')?.click();
    surface = 'web';
    agent.options = [...engineSwitch.options].map(option => ({ value: option.value, text: option.textContent }));
    agent.value = engineSwitch.value;
    agent.title = headerTitle.textContent;
    agent.logo = {
      src: logoImage?.getAttribute('src') || agent.logo.src,
      text: logoText?.textContent || agent.logo.text,
      badge: logoBadge?.textContent || agent.logo.badge,
      engine: logoMark?.dataset.engine || agent.logo.engine,
    };
    agent.newSessionLabel = newSessionLabel?.textContent || agent.newSessionLabel;
    agent.newSessionTitle = newSessionBtn.title;
    agent.scrollTop = sessionList.scrollTop;
    agent.headerActionsHidden = agentHeaderActions.hidden;
    switchEl.dataset.surface = 'web';
    switchEl.querySelector('[data-surface-option="agent"]')?.setAttribute('aria-pressed', 'false');
    switchEl.querySelector('[data-surface-option="web"]')?.setAttribute('aria-pressed', 'true');
    stage.hidden = false;
    populateWebProviders();
    updateWebChrome();
    renderWebSessions();
    const initial = await api.webSurfaceState().catch(() => null);
    if (initial?.ok) {
      webState = initial;
      if (initial.providers?.some(item => item.id === initial.provider)) provider = initial.provider;
      const available = initial.providers?.some(item => item.id === provider);
      if (!available) provider = initial.providers?.[0]?.id || 'deepseek';
      if (initial.provider !== provider) await command('provider', { provider });
      populateWebProviders();
      updateWebChrome();
      renderWebSessions();
    }
    await command('show', showPayload());
    pushBounds();
  }

  async function showAgent() {
    if (surface === 'agent') return;
    closeProviderMenu(false);
    surface = 'agent';
    occluded = false;
    closeMenu();
    closeSessionMenu();
    multiSelectMode = false;
    selectedWebSessionIds.clear();
    renamingWebSessionId = null;
    closeLayoutDialog();
    switchEl.dataset.surface = 'agent';
    switchEl.querySelector('[data-surface-option="agent"]')?.setAttribute('aria-pressed', 'true');
    switchEl.querySelector('[data-surface-option="web"]')?.setAttribute('aria-pressed', 'false');
    await command('hide');
    restoreAgentChrome();
  }

  function handleState(next) {
    if (!next?.ok) return;
    if (webState?.provider && webState.provider !== next.provider) {
      closeSessionMenu();
      multiSelectMode = false;
      selectedWebSessionIds.clear();
      renamingWebSessionId = null;
    }
    webState = next;
    provider = next.provider || provider;
    if (surface === 'web') {
      populateWebProviders();
      updateWebChrome();
      renderWebSessions();
    }
  }

  function setSurface(next) {
    if (next === 'web') void showWeb();
    else void showAgent();
  }

  switchEl.addEventListener('click', event => {
    const button = event.target.closest('[data-surface-option]');
    if (button) setSurface(button.dataset.surfaceOption);
  });
  switchEl.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    setSurface(event.key === 'ArrowRight' ? 'web' : 'agent');
    const next = switchEl.querySelector('[data-surface-option="' + (event.key === 'ArrowRight' ? 'web' : 'agent') + '"]');
    next?.focus();
  });

  webProviderButton.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    if (surface !== 'web') return;
    if (providerMenuOpen && providerMenuEl) closeProviderMenu(true);
    else if (!providerMenuOpen) void openProviderMenu();
  });

  newSessionBtn.addEventListener('click', event => {
    if (surface !== 'web') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void command('new');
  }, true);

  $('webBack').addEventListener('click', () => void command('back'));
  $('webForward').addEventListener('click', () => void command('forward'));
  $('webReload').addEventListener('click', () => void command('reload'));
  $('webExternal').addEventListener('click', () => void command('external'));
  $('webMore').addEventListener('click', event => {
    event.stopPropagation();
    if (menu) {
      closeMenu(true);
      return;
    }
    openMenu($('webMore'));
  });
  document.addEventListener('click', event => {
    if (menu && !menu.contains(event.target)) closeMenu();
    if (sessionMenu && !sessionMenu.contains(event.target)) closeSessionMenu();
    if (providerMenuOpen && providerMenuEl && !providerMenuEl.contains(event.target)
      && !webProviderButton.contains(event.target)) closeProviderMenu(true);
  });
  document.addEventListener('pointerdown', event => {
    if (sessionMenu && !sessionMenu.contains(event.target)) closeSessionMenu();
  }, true);

  function menuButton(label, run, options = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pop-row' + (options.danger ? ' danger' : '');
    button.setAttribute('role', 'menuitem');
    const text = document.createElement('span');
    text.textContent = label;
    button.appendChild(text);
    button.addEventListener('click', () => {
      closeMenu();
      void run();
    });
    return button;
  }

  function openMenu(anchor) {
    closeMenu();
    closeSessionMenu();
    menu = document.createElement('div');
    menu.id = 'webMoreMenu';
    menu.className = 'dsh-pop action-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-labelledby', 'webMore');
    menu.append(
      menuButton(t('Refresh web conversations', 'Refresh web conversations'), () => command('refresh-sessions')),
      menuButton(t('Repair web layout', 'Repair web layout'), () => openLayoutDialog()),
      menuButton(t('Reset built-in layout', 'Reset built-in layout'), async () => {
        const result = await command('reset-layout');
        if (!result.ok) window.alert(result.error);
      }),
      menuButton(t('Clear web sign-in', 'Clear web sign-in'), async () => {
        if (!window.confirm(t('Clear this provider’s sign-in and stored site data on this computer?', 'Clear this provider’s sign-in and stored site data on this computer?'))) return;
        const result = await command('clear-session');
        if (!result.ok) window.alert(result.error);
      }, { danger: true }),
    );
    menu.style.visibility = 'hidden';
    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(innerWidth - menuRect.width - 8, rect.right - menuRect.width));
    let top = rect.bottom + 4;
    if (top + menuRect.height > innerHeight - 8) top = Math.max(8, rect.top - menuRect.height - 4);
    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(top) + 'px';
    menu.style.visibility = '';
    menu.addEventListener('keydown', event => {
      const rows = [...menu.querySelectorAll('button:not(:disabled)')];
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const index = rows.indexOf(document.activeElement);
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        rows[(index + delta + rows.length) % rows.length]?.focus();
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        rows[event.key === 'Home' ? 0 : rows.length - 1]?.focus();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu(true);
      }
    });
    anchor.setAttribute('aria-expanded', 'true');
    anchor.setAttribute('aria-controls', 'webMoreMenu');
    menu.querySelector('button:not(:disabled)')?.focus();
  }

  function closeMenu(restoreFocus = false) {
    menu?.remove();
    menu = null;
    $('webMore')?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) $('webMore')?.focus();
  }

  function clearProviderMenuFrame() {
    stage.classList.remove('provider-menu-frozen');
    stage.style.removeProperty('background-image');
  }

  function nextPaint() {
    return new Promise(resolve => {
      let timer = 0, done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      requestAnimationFrame(() => requestAnimationFrame(finish));
      timer = setTimeout(finish, 80);
    });
  }

  function closeProviderMenu(restore = true) {
    if (!providerMenuOpen && !providerMenuEl) return;
    providerMenuGeneration++;
    const menu = providerMenuEl, backdrop = providerMenuBackdrop;
    providerMenuOpen = false;
    providerMenuEl = null;
    providerMenuBackdrop = null;
    menu?.remove();
    backdrop?.remove();
    webProviderButton.setAttribute('aria-expanded', 'false');
    if (restore && surface === 'web' && !stage.hidden) {
      void nextPaint().then(() => {
        if (providerMenuOpen || providerMenuEl) return null;
        return command('show', showPayload());
      }).then(result => {
        if (!result) return null;
        if (!result.ok) throw new Error(result.error || t('The website action failed.', 'The website action failed.'));
        return nextPaint();
      }).then(() => {
        if (!providerMenuOpen && !providerMenuEl && surface === 'web') clearProviderMenuFrame();
      }).catch(error => {
        clearProviderMenuFrame();
        window.alert(error.message);
      });
    } else {
      clearProviderMenuFrame();
    }
    if (restore) webProviderButton.focus();
  }

  async function openProviderMenu() {
    if (providerMenuOpen || surface !== 'web') return;
    const generation = ++providerMenuGeneration;
    providerMenuOpen = true;
    webProviderButton.setAttribute('aria-expanded', 'true');
    const frozen = await command('freeze-menu');
    if (generation !== providerMenuGeneration || !providerMenuOpen || surface !== 'web') return;
    if (frozen?.ok && frozen.image) {
      stage.classList.add('provider-menu-frozen');
      stage.style.backgroundImage = `url("${frozen.image}")`;
      await nextPaint();
    }
    if (generation !== providerMenuGeneration || !providerMenuOpen || surface !== 'web') return;
    await command('hide');
    if (generation !== providerMenuGeneration || !providerMenuOpen || surface !== 'web') return;
    providerMenuBackdrop = document.createElement('button');
    providerMenuBackdrop.type = 'button';
    providerMenuBackdrop.tabIndex = -1;
    providerMenuBackdrop.className = 'web-provider-menu-backdrop';
    providerMenuBackdrop.setAttribute('aria-label', t('Close provider menu', 'Close provider menu'));
    providerMenuBackdrop.addEventListener('click', event => {
      event.preventDefault();
      closeProviderMenu(true);
    });
    providerMenuEl = document.createElement('div');
    providerMenuEl.className = 'web-provider-menu';
    providerMenuEl.setAttribute('role', 'listbox');
    providerMenuEl.setAttribute('aria-label', t('Web provider', 'Web provider'));
    const options = (webState?.providers?.length ? webState.providers : [
      { id: 'deepseek', label: 'DeepSeek Web' },
      { id: 'kimi', label: 'Kimi Web' },
    ]).map(item => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'web-provider-menu-option';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(item.id === provider));
      option.dataset.provider = item.id;
      option.textContent = t(item.label, item.label);
      option.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        if (item.id !== provider) {
          const result = await command('provider', { provider: item.id });
          if (!result.ok) {
            window.alert(result.error || t('The website action failed.', 'The website action failed.'));
            closeProviderMenu(true);
            return;
          }
          provider = item.id;
          if (result.state) handleState(result.state);
          else {
            updateWebChrome();
            renderWebSessions();
          }
        }
        closeProviderMenu(true);
      });
      return option;
    });
    providerMenuEl.append(...options);
    document.body.append(providerMenuBackdrop, providerMenuEl);
    const rect = webProviderButton.getBoundingClientRect();
    const menuRect = providerMenuEl.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, innerWidth - menuRect.width - 8));
    let top = rect.bottom + 4;
    if (top + menuRect.height > innerHeight - 8) top = Math.max(8, rect.top - menuRect.height - 4);
    providerMenuEl.style.left = Math.round(left) + 'px';
    providerMenuEl.style.top = Math.round(top) + 'px';
    const buttons = [...providerMenuEl.querySelectorAll('.web-provider-menu-option')];
    const focusIndex = Math.max(0, buttons.findIndex(button => button.getAttribute('aria-selected') === 'true'));
    providerMenuEl.tabIndex = -1;
    buttons.forEach(button => { button.tabIndex = -1; });
    providerMenuEl.addEventListener('keydown', event => {
      const current = buttons.indexOf(document.activeElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        closeProviderMenu(true);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        buttons[(current + delta + buttons.length) % buttons.length]?.focus();
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        buttons[event.key === 'Home' ? 0 : buttons.length - 1]?.focus();
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        buttons[Math.max(0, current)]?.click();
      }
    });
    const menuNode = providerMenuEl;
    menuNode.addEventListener('focusout', event => {
      if (!menuNode.contains(event.relatedTarget)) closeProviderMenu(true);
    });
    providerMenuEl.focus();
    buttons[focusIndex]?.focus();
  }

  let layoutDialog = null;

  function openLayoutDialog() {
    if (surface !== 'web') return;
    layoutOpen = true;
    closeMenu();
    void command('hide');
    if (layoutDialog) {
      layoutDialog.remove();
      layoutDialog = null;
    }
    layoutDialog = document.createElement('dialog');
    layoutDialog.className = 'web-layout-dialog';
    layoutDialog.innerHTML = `
      <header><div><span class="web-layout-kicker"></span><h2></h2></div><button type="button" class="web-layout-close" aria-label="Close">×</button></header>
      <div class="web-layout-body">
        <p class="web-layout-summary"></p>
        <div class="web-layout-model-panel">
          <label><span class="web-layout-model-label"></span><select class="web-layout-model"></select></label>
          <button type="button" class="btn-secondary web-layout-model-run"></button>
          <p class="web-layout-model-hint"></p>
        </div>
        <div class="web-layout-actions"><button type="button" class="btn-secondary web-layout-scan"></button><button type="button" class="btn-secondary web-layout-reset"></button></div>
        <div class="web-layout-result" aria-live="polite"></div>
      </div>
      <footer><button type="button" class="btn-secondary web-layout-done"></button></footer>`;
    layoutDialog.querySelector('.web-layout-kicker').textContent = providerInfo().label;
    layoutDialog.querySelector('h2').textContent = t('Web layout', 'Web layout');
    layoutDialog.querySelector('.web-layout-summary').textContent = t(
      'Camellia reads only page structure and link paths. Conversation text and cookies are not included.',
      'Camellia reads only page structure and link paths. Conversation text and cookies are not included.');
    layoutDialog.querySelector('.web-layout-scan').textContent = t('Scan page', 'Scan page');
    layoutDialog.querySelector('.web-layout-reset').textContent = t('Restore built-in layout', 'Restore built-in layout');
    layoutDialog.querySelector('.web-layout-model-label').textContent = t('Layout model', 'Layout model');
    layoutDialog.querySelector('.web-layout-model-run').textContent = t('Ask selected model', 'Ask selected model');
    layoutDialog.querySelector('.web-layout-model-hint').textContent = t(
      'Only sanitized page structure is sent. The request may consume API quota.',
      'Only sanitized page structure is sent. The request may consume API quota.');
    layoutDialog.querySelector('.web-layout-done').textContent = t('Close', 'Close');
    const close = () => {
      layoutOpen = false;
      layoutDialog?.close();
      layoutDialog?.remove();
      layoutDialog = null;
      pushBounds();
      void command('show', showPayload());
    };
    layoutDialog.querySelector('.web-layout-close').addEventListener('click', close);
    layoutDialog.querySelector('.web-layout-done').addEventListener('click', close);
    layoutDialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    layoutDialog.querySelector('.web-layout-scan').addEventListener('click', () => void scanLayout());
    layoutDialog.querySelector('.web-layout-model-run').addEventListener('click', () => void repairWithModel());
    layoutDialog.querySelector('.web-layout-reset').addEventListener('click', async () => {
      const result = await command('reset-layout');
      if (!result.ok) window.alert(result.error);
      else close();
    });
    document.body.appendChild(layoutDialog);
    layoutDialog.showModal();
    void loadLayoutModels();
    void scanLayout();
  }

  async function loadLayoutModels() {
    if (!layoutDialog) return;
    const select = layoutDialog.querySelector('.web-layout-model');
    const run = layoutDialog.querySelector('.web-layout-model-run');
    const hint = layoutDialog.querySelector('.web-layout-model-hint');
    const result = await command('layout-models');
    if (!layoutDialog) return;
    const models = result.ok && Array.isArray(result.models) ? result.models : [];
    select.replaceChildren();
    if (!models.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = t('No API route model available', 'No API route model available');
      select.appendChild(option);
      select.disabled = true;
      run.disabled = true;
      hint.textContent = result.error || t(
        'Configure an API route to let a model repair the layout. Local scanning remains available.',
        'Configure an API route to let a model repair the layout. Local scanning remains available.');
      return;
    }
    for (const model of models) {
      const option = document.createElement('option');
      option.value = model;
      option.textContent = model;
      select.appendChild(option);
    }
    select.disabled = false;
    run.disabled = false;
    hint.textContent = t(
      'Only sanitized page structure is sent. The request may consume API quota.',
      'Only sanitized page structure is sent. The request may consume API quota.');
  }

  async function scanLayout() {
    if (!layoutDialog) return;
    const result = layoutDialog.querySelector('.web-layout-result');
    result.textContent = t('Scanning page structure…', 'Scanning page structure…');
    const diagnosis = await command('diagnose');
    if (!layoutDialog) return;
    if (!diagnosis.ok) {
      result.textContent = diagnosis.error || t('The page could not be scanned.', 'The page could not be scanned.');
      return;
    }
    result.replaceChildren();
    const summary = document.createElement('p');
    summary.className = 'web-layout-scan-summary';
    summary.textContent = t('Page anchors: {0}. Web conversations found: {1}.',
      'Page anchors: {0}. Web conversations found: {1}.')
      .replace('{0}', String(diagnosis.diagnostics?.links?.length || 0))
      .replace('{1}', String(webState?.sessions?.length || 0));
    result.appendChild(summary);
    if (!diagnosis.proposal) {
      const none = document.createElement('p');
      none.className = 'web-session-error';
      none.textContent = t('No reliable conversation link pattern was found.', 'No reliable conversation link pattern was found.');
      result.appendChild(none);
      return;
    }
    renderLayoutProposal(result, diagnosis.proposal, t('Local proposal', 'Local proposal'));
  }

  async function repairWithModel() {
    if (!layoutDialog) return;
    const select = layoutDialog.querySelector('.web-layout-model');
    const run = layoutDialog.querySelector('.web-layout-model-run');
    const result = layoutDialog.querySelector('.web-layout-result');
    if (!select.value) return;
    run.disabled = true;
    result.textContent = t('Asking the selected model…', 'Asking the selected model…');
    const repaired = await command('repair-layout-model', { model: select.value });
    if (!layoutDialog) return;
    run.disabled = false;
    if (!repaired.ok) {
      result.textContent = repaired.error || t('The selected model did not return a usable profile.', 'The selected model did not return a usable profile.');
      return;
    }
    result.replaceChildren();
    const summary = document.createElement('p');
    summary.className = 'web-layout-scan-summary';
    summary.textContent = t('Model-assisted proposal', 'Model-assisted proposal') + ' · ' + select.value;
    result.appendChild(summary);
    renderLayoutProposal(result, repaired.proposal, t('Model-assisted proposal', 'Model-assisted proposal'));
  }

  function renderLayoutProposal(result, target, sourceLabel) {
    const proposal = document.createElement('div');
    proposal.className = 'web-layout-proposal';
    const source = document.createElement('strong');
    source.textContent = sourceLabel;
    const selector = document.createElement('code');
    selector.textContent = target.historyAnchorSelector;
    const evidence = document.createElement('span');
    evidence.textContent = t('{0} matching links', '{0} matching links').replace('{0}', String(target.evidence?.count || 0));
    const details = document.createElement('details');
    details.className = 'web-layout-profile-details';
    const detailsSummary = document.createElement('summary');
    detailsSummary.textContent = t('Review profile details', 'Review profile details');
    const detailsBody = document.createElement('pre');
    detailsBody.textContent = JSON.stringify({
      historyAnchorSelector: target.historyAnchorSelector,
      titleSelector: target.titleSelector || '',
      css: target.css || '',
    }, null, 2);
    details.append(detailsSummary, detailsBody);
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'btn-primary';
    apply.textContent = t('Preview and apply', 'Preview and apply');
    apply.addEventListener('click', async () => {
      apply.disabled = true;
      const applied = await command('apply-layout', { profile: target });
      if (!applied.ok) {
        apply.disabled = false;
        result.textContent = applied.error || t('The layout profile could not be saved.', 'The layout profile could not be saved.');
        return;
      }
      layoutOpen = false;
      layoutDialog?.close();
      layoutDialog?.remove();
      layoutDialog = null;
      pushBounds();
      void command('show', showPayload());
    });
    proposal.append(source, selector, evidence, details, apply);
    result.appendChild(proposal);
  }

  function closeLayoutDialog() {
    if (!layoutDialog) return;
    layoutOpen = false;
    layoutDialog.close();
    layoutDialog.remove();
    layoutDialog = null;
  }

  const resizeObserver = new ResizeObserver(pushBounds);
  resizeObserver.observe(stage);
  resizeObserver.observe(document.querySelector('.main-header'));
  resizeObserver.observe(document.querySelector('.sidebar'));
  webList.addEventListener('scroll', closeSessionMenu, { passive: true });
  const overlayObserver = new MutationObserver(syncOverlayOcclusion);
  overlayObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'class'] });
  window.addEventListener('resize', pushBounds);
  window.addEventListener('resize', () => { closeSessionMenu(); closeProviderMenu(true); });
  window.addEventListener('blur', () => closeProviderMenu(true));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      closeProviderMenu(false);
      void command('hide');
    }
    else if (surface === 'web') {
      const rect = stage.getBoundingClientRect();
      void command('show', { provider, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
    }
  });
  window.addEventListener('beforeunload', () => { void command('hide'); });
  api.onWebSurfaceState?.(handleState);
  api.onChatContentWidthChanged?.(() => {
    sentContentWidth = null;
    requestAnimationFrame(syncContentWidth);
  });
  api.onSettingsOverlay?.(visible => {
    settingsOccluded = Boolean(visible);
    syncOverlayOcclusion();
  });
  if (typeof api.settingsOverlay === 'function') {
    void api.settingsOverlay().then(visible => {
      settingsOccluded = Boolean(visible);
      syncOverlayOcclusion();
    }).catch(() => {});
  }
  void api.webSurfaceState().then(state => {
    if (state?.ok) {
      webState = state;
      provider = state.provider || provider;
      renderWebSessions();
    }
  }).catch(() => {});

  window.CamelliaWebSurface = Object.freeze({
    get surface() { return surface; },
    get occluded() { return occluded; },
    setSurface,
    openLayoutDialog,
  });
  renderWebSessions();
})();
