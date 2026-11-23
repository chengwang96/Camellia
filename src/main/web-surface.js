'use strict';

const path = require('node:path');
const {
  PROVIDERS, activeSessionId, canonicalSessionUrl, cleanTitle,
  navigationAllowed, normalizeProfile, normalizeSessions, providerFor, publicProviders,
} = require('../shared/web-providers.js');
const { extractionScript, sessionActionScript } = require('../shared/web-layout-runtime.js');
const { readJson, writeJson } = require('../shared/json-store.js');

const EXTRACT_INTERVAL_MS = 2500;
// A provider page is only revealed after its layout CSS and column width are
// applied and the first history extraction has settled. These budgets keep a
// slow or signed-out page from leaving the Web pane blank forever.
const REVEAL_PROBE_MS = 400;
const REVEAL_HOME_SETTLE_MS = 150;
const REVEAL_EMPTY_MS = 1500;
const REVEAL_HISTORY_MS = 6000;
const REVEAL_WATCHDOG_MS = 12000;
const PRELOAD_RETRY_MS = 8000;

function finiteBounds(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    const number = Number(value[key]);
    if (!Number.isFinite(number)) return null;
    result[key] = number;
  }
  if (result.width < 1 || result.height < 1) return null;
  return result;
}

function createWebSurfaceManager({
  app, BrowserWindow, WebContentsView, Menu, session, shell, ipcMain, nativeTheme,
  getWindow, log = () => {}, layoutAssistant = null,
}) {
  const providerStates = new Map();
  const cachePath = path.join(app.getPath('userData'), 'web-sessions.json');
  const profilePath = path.join(app.getPath('userData'), 'web-layout-profiles.json');
  let cache = {}, profiles = {};
  try { cache = readJson(cachePath, {}); }
  catch (error) { log('Web sessions cache: ' + error.message); }
  try { profiles = readJson(profilePath, {}); }
  catch (error) { log('Web layout profiles: ' + error.message); }
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = {};
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) profiles = {};
  let currentProvider = providerFor(cache.currentProvider) ? cache.currentProvider : 'deepseek';
  let contentWidth = 768;
  let visible = false;
  let lastBounds = finiteBounds(cache.bounds);
  let emitTimer = null;
  let persistTimer = null;
  let preloadRetryTimer = null;
  let disposed = false;
  const handlers = [];

  function windowForUse() {
    const window = getWindow?.();
    return window && !window.isDestroyed() ? window : null;
  }

  function applyThemeBackground(state) {
    if (!state?.view || state.view.webContents.isDestroyed()) return;
    state.view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#151517' : '#ffffff');
  }

  function syncThemeBackgrounds() {
    for (const state of providerStates.values()) applyThemeBackground(state);
  }

  const themeUpdated = () => syncThemeBackgrounds();
  nativeTheme.on?.('updated', themeUpdated);

  for (const provider of Object.values(PROVIDERS)) {
    const saved = cache.providers?.[provider.id];
    providerStates.set(provider.id, {
      provider,
      view: null,
      sessions: normalizeSessions(provider, saved?.sessions),
      currentUrl: provider.startUrl,
      title: provider.label,
      loading: false,
      error: null,
      ready: false,
      layout: { status: 'unknown', historyCount: 0, sidebarMarked: false, error: '' },
      cssKeys: [],
      extracting: false,
      extractionTimer: null,
      popup: null,
      loadGeneration: 0,
      revealToken: 0,
      revealTimer: null,
      revealWatchdog: null,
      revealStartedAt: 0,
      revealExpectedSessions: false,
      pageReady: false,
      docReadyAt: 0,
      loadStoppedAt: 0,
      navigationStartedAt: 0,
      layoutReady: false,
    });
  }

  function persistNow() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    const providers = {};
    for (const [id, state] of providerStates) {
      providers[id] = {
        sessions: state.sessions,
      };
    }
    try {
      writeJson(cachePath, { version: 1, currentProvider, bounds: lastBounds, providers });
    } catch (error) {
      log('Web sessions: ' + error.message);
    }
  }

  function persistSoon() {
    if (persistTimer) return;
    persistTimer = setTimeout(persistNow, 250);
    persistTimer.unref?.();
  }

  function currentState() {
    return providerStates.get(currentProvider);
  }

  function publicState() {
    const state = currentState();
    return {
      ok: true,
      provider: currentProvider,
      providers: publicProviders(),
      sessions: state.sessions,
      activeId: activeSessionId(state.provider, state.currentUrl),
      currentUrl: state.currentUrl,
      title: state.title,
      loading: state.loading,
      ready: state.ready,
      error: state.error,
      visible,
      canGoBack: Boolean(state.view && !state.view.webContents.isDestroyed() && state.view.webContents.navigationHistory.canGoBack()),
      canGoForward: Boolean(state.view && !state.view.webContents.isDestroyed() && state.view.webContents.navigationHistory.canGoForward()),
      layout: state.layout,
    };
  }

  function emitSoon() {
    if (emitTimer || disposed) return;
    emitTimer = setTimeout(() => {
      emitTimer = null;
      const window = windowForUse();
      if (!window) return;
      window.webContents.send('dsh:web-surface-state', publicState());
    }, 40);
    emitTimer.unref?.();
  }

  function updateBounds(payload) {
    const window = windowForUse();
    const bounds = finiteBounds(payload);
    if (!window || !bounds) return false;
    const zoom = window.webContents.getZoomFactor?.() || 1;
    const content = window.getContentBounds();
    const scaled = {
      x: Math.max(0, Math.min(content.width - 1, Math.round(bounds.x * zoom))),
      y: Math.max(0, Math.min(content.height - 1, Math.round(bounds.y * zoom))),
      width: Math.max(0, Math.round(bounds.width * zoom)),
      height: Math.max(0, Math.round(bounds.height * zoom)),
    };
    scaled.width = Math.min(scaled.width, Math.max(0, content.width - scaled.x));
    scaled.height = Math.min(scaled.height, Math.max(0, content.height - scaled.y));
    lastBounds = { ...bounds };
    if (scaled.width < 2 || scaled.height < 2) {
      if (visible) hide();
      return false;
    }
    const state = currentState();
    if (state.view) {
      try { state.view.webContents.setZoomFactor(zoom); } catch {}
      state.view.setBounds(scaled);
    }
    persistSoon();
    return true;
  }

  function syncVisibility() {
    for (const [id, state] of providerStates) {
      if (!state.view || state.view.webContents.isDestroyed()) continue;
      state.view.setVisible(visible && id === currentProvider && state.ready === true);
    }
  }

  function setVisible(next) {
    visible = Boolean(next);
    syncVisibility();
    if (!visible) {
      const window = windowForUse();
      window?.setIgnoreMenuShortcuts?.(false);
    }
    emitSoon();
  }

  function clearRevealTimers(state) {
    clearTimeout(state.revealTimer);
    state.revealTimer = null;
    clearTimeout(state.revealWatchdog);
    state.revealWatchdog = null;
  }

  function providerHomePage(state) {
    return activeSessionId(state.provider, state.currentUrl) === null;
  }

  // A full document load re-arms the reveal gate. The native view stays hidden
  // while the provider paints its own skeleton and removes its sidebar, so the
  // first visible frame is already the finished layout.
  function armReveal(state) {
    clearRevealTimers(state);
    const token = ++state.revealToken;
    state.ready = false;
    state.layoutReady = false;
    state.pageReady = false;
    state.error = null;
    state.docReadyAt = 0;
    state.loadStoppedAt = 0;
    state.navigationStartedAt = Date.now();
    state.revealStartedAt = 0;
    state.revealExpectedSessions = !providerHomePage(state) && state.sessions.length > 0;
    state.revealWatchdog = setTimeout(() => {
      if (disposed || token !== state.revealToken || state.ready) return;
      revealProvider(state);
    }, REVEAL_WATCHDOG_MS);
    state.revealWatchdog.unref?.();
    syncVisibility();
    emitSoon();
    return token;
  }

  function revealProvider(state) {
    if (state.ready) return;
    clearRevealTimers(state);
    state.ready = true;
    syncVisibility();
    emitSoon();
  }

  function scheduleRevealProbe(state, token, delay = REVEAL_PROBE_MS) {
    if (disposed || state.ready || token !== state.revealToken) return;
    clearTimeout(state.revealTimer);
    state.revealTimer = setTimeout(() => { void probeReveal(state, token); }, delay);
    state.revealTimer.unref?.();
  }

  async function probeReveal(state, token) {
    state.revealTimer = null;
    if (disposed || state.ready || token !== state.revealToken) return;
    const homePage = providerHomePage(state);
    const loaded = state.loadStoppedAt >= state.navigationStartedAt;
    if (!state.docReadyAt || state.docReadyAt < state.navigationStartedAt
      || (!homePage && !loaded) || !state.layoutReady) {
      scheduleRevealProbe(state, token);
      return;
    }
    if (!state.revealStartedAt) state.revealStartedAt = Date.now();
    const result = await extractNow(state.provider.id, 'reveal');
    if (disposed || state.ready || token !== state.revealToken) return;
    const historyFound = result.ok && Number(result.state?.layout?.historyCount) > 0;
    const signIn = /(?:^|[./_-])(?:sign[-_]?in|login|log[-_]?in)(?:[./?#_-]|$)/i.test(state.currentUrl || '');
    const elapsed = Date.now() - state.revealStartedAt;
    const budget = state.revealExpectedSessions ? REVEAL_HISTORY_MS : REVEAL_EMPTY_MS;
    const homeReady = homePage && state.pageReady && elapsed >= REVEAL_HOME_SETTLE_MS;
    if (historyFound || signIn || homeReady || (loaded && elapsed >= budget) || state.error) {
      revealProvider(state);
      return;
    }
    scheduleRevealProbe(state, token);
  }

  function hide() {
    setVisible(false);
  }

  function openExternal(url) {
    let target;
    try {
      const parsed = new URL(String(url || ''));
      if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol) || parsed.username || parsed.password) return;
      target = parsed.href;
    } catch {
      return;
    }
    try {
      Promise.resolve(shell.openExternal(target)).catch(error => log('Web surface external link: ' + error.message));
    } catch (error) {
      log('Web surface external link: ' + error.message);
    }
  }

  function attachWindowGuards(window, state) {
    const contents = state.view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      if (!navigationAllowed(state.provider, url)) {
        openExternal(url);
        return { action: 'deny' };
      }
      if (state.popup && !state.popup.isDestroyed()) {
        state.popup.focus();
        return { action: 'deny' };
      }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: window,
          width: 560,
          height: 760,
          minWidth: 420,
          minHeight: 560,
          autoHideMenuBar: true,
          title: state.provider.label,
          webPreferences: {
            partition: state.provider.partition,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      };
    });
    contents.on('did-create-window', child => {
      state.popup = child;
      child.setMenuBarVisibility(false);
      const popupGuard = (event, url) => {
        if (navigationAllowed(state.provider, url)) return;
        event.preventDefault();
        openExternal(url);
      };
      child.webContents.on('will-navigate', popupGuard);
      child.webContents.on('will-redirect', popupGuard);
      child.webContents.setWindowOpenHandler(({ url }) => {
        openExternal(url);
        return { action: 'deny' };
      });
      child.once('closed', () => {
        if (state.popup === child) state.popup = null;
      });
    });
    const guard = (event, url) => {
      if (navigationAllowed(state.provider, url)) return;
      event.preventDefault();
      openExternal(url);
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
  }

  function attachProviderSession(state) {
    const providerSession = session.fromPartition(state.provider.partition);
    providerSession.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(permission === 'clipboard-sanitized-write');
    });
    providerSession.setPermissionCheckHandler((_contents, permission) => permission === 'clipboard-sanitized-write');
  }

  function createView(state, window) {
    if (state.view && !state.view.webContents.isDestroyed()) return state.view;
    attachProviderSession(state);
    const view = new WebContentsView({
      webPreferences: {
        partition: state.provider.partition,
        preload: path.join(__dirname, 'web-view-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
        backgroundThrottling: false,
      },
    });
    state.view = view;
    applyThemeBackground(state);
    if (state.provider.webRTCIPHandlingPolicy) {
      try {
        view.webContents.setWebRTCIPHandlingPolicy(state.provider.webRTCIPHandlingPolicy);
      } catch (error) {
        log('WebRTC policy: ' + error.message);
      }
    }
    view.setVisible(false);
    window.contentView.addChildView(view);
    attachWindowGuards(window, state);
    const contents = view.webContents;
    try {
      const productToken = String(app.getName() || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      contents.setUserAgent(contents.getUserAgent()
        .replace(/\sElectron\/\S+/i, '')
        .replace(productToken ? new RegExp('\\s' + productToken + '/\\S+', 'i') : /$^/, ''));
    } catch {}

    contents.on('focus', () => window.setIgnoreMenuShortcuts?.(true));
    contents.on('blur', () => window.setIgnoreMenuShortcuts?.(false));
    contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace) return;
      armReveal(state);
    });
    contents.on('did-start-loading', () => {
      if (state.ready) armReveal(state);
      state.loading = true;
      state.error = null;
      emitSoon();
    });
    contents.on('did-stop-loading', () => {
      state.loading = false;
      state.loadStoppedAt = Date.now();
      state.currentUrl = contents.getURL() || state.currentUrl;
      if (!state.ready) scheduleRevealProbe(state, state.revealToken, 0);
      emitSoon();
    });
    contents.on('did-fail-load', (_event, code, description, validatedURL, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      state.loading = false;
      state.error = description || 'The web page could not be loaded.';
      state.currentUrl = validatedURL || state.currentUrl;
      // The browser error page is the only useful thing to show now. Keeping
      // the view hidden would leave the Camellia loading placeholder forever.
      revealProvider(state);
    });
    contents.on('render-process-gone', (_event, details) => {
      state.loading = false;
      state.error = 'The web page stopped unexpectedly (' + details.reason + ').';
      state.ready = false;
      clearRevealTimers(state);
      syncVisibility();
      emitSoon();
    });
    contents.on('dom-ready', () => {
      const token = state.revealToken;
      state.docReadyAt = Date.now();
      state.layoutReady = false;
      if (!state.revealStartedAt) state.revealStartedAt = Date.now();
      if (!state.revealExpectedSessions && !providerHomePage(state)) {
        state.revealExpectedSessions = state.sessions.length > 0;
      }
      state.cssKeys = [];
      const profile = normalizeProfile(state.provider, profiles?.[state.provider.id]);
      const css = [state.provider.layout.css, profile?.css || ''].join('\n');
      // The view is revealed only after both the layout CSS and the column
      // width are in place, so a provider page cannot paint its own width and
      // then reflow when Camellia's rules arrive.
      const cssReady = contents.insertCSS(css, { cssOrigin: 'user' }).then(key => {
        if (disposed || contents.isDestroyed()) return;
        state.cssKeys.push(key);
      }).catch(error => log('Web layout CSS: ' + error.message));
      const widthReady = applyContentWidth(state);
      Promise.allSettled([cssReady, widthReady]).then(() => {
        if (disposed || contents.isDestroyed() || token !== state.revealToken) return;
        state.layoutReady = true;
        scheduleRevealProbe(state, token, 0);
      });
      if (state.sessions.length) {
        void contents.executeJavaScript(
          "document.documentElement.setAttribute('data-camellia-web-hide-site-sidebar', '')",
          true,
        ).catch(() => {});
      }
      setTimeout(() => void extractNow(state.provider.id, 'dom-ready'), 350);
    });
    const navigationChanged = () => {
      state.currentUrl = contents.getURL() || state.currentUrl;
      state.title = cleanTitle(contents.getTitle(), state.provider.label);
      persistSoon();
      emitSoon();
      clearTimeout(state.extractionTimer);
      state.extractionTimer = setTimeout(() => void extractNow(state.provider.id, 'navigation'), 300);
    };
    contents.on('did-navigate', navigationChanged);
    contents.on('did-navigate-in-page', navigationChanged);
    contents.on('page-title-updated', (_event, title) => {
      state.title = cleanTitle(title, state.provider.label);
      emitSoon();
    });

    if (lastBounds) updateBounds(lastBounds);
    void loadProvider(state).catch(error => {
      state.loading = false;
      state.error = error.message;
      emitSoon();
    });
    return view;
  }

  async function loadProvider(state) {
    const contents = state.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    const generation = ++state.loadGeneration;
    const target = navigationAllowed(state.provider, state.currentUrl) ? state.currentUrl : state.provider.startUrl;
    armReveal(state);
    try {
      await contents.loadURL(target);
    } catch (error) {
      if (error.code === 'ERR_ABORTED' || generation !== state.loadGeneration) return;
      throw error;
    }
  }

  function ensureProvider(id) {
    const provider = providerFor(id);
    const window = windowForUse();
    if (!provider || !window) return null;
    currentProvider = id;
    const state = providerStates.get(id);
    createView(state, window);
    return state;
  }

  function retryProviderLoad(state) {
    const contents = state?.view?.webContents;
    if (!contents || contents.isDestroyed() || state.loading) return;
    state.error = null;
    void loadProvider(state).catch(error => {
      state.loading = false;
      state.error = error.message;
      emitSoon();
    });
  }

  function preloadProviders() {
    const window = windowForUse();
    if (!window) return { ok: false, error: 'The web surface is unavailable.' };
    const activeProvider = currentProvider;
    const preloaded = [];
    clearTimeout(preloadRetryTimer);
    preloadRetryTimer = null;
    for (const provider of Object.values(PROVIDERS)) {
      currentProvider = provider.id;
      const existing = providerStates.get(provider.id);
      const hadView = Boolean(existing?.view && !existing.view.webContents.isDestroyed());
      const state = ensureProvider(provider.id);
      if (!state?.view) continue;
      if (!lastBounds) {
        try {
          const content = window.getContentBounds();
          state.view.webContents.setZoomFactor(window.webContents.getZoomFactor?.() || 1);
          state.view.setBounds({
            x: 0,
            y: 0,
            width: Math.max(2, Math.min(1600, content.width)),
            height: Math.max(2, Math.min(1000, content.height)),
          });
        } catch {}
      }
      const contents = state.view.webContents;
      if (hadView && !state.loading && (!contents.getURL() || state.error)) retryProviderLoad(state);
      applyContentWidth(state);
      preloaded.push(provider.id);
    }
    currentProvider = activeProvider;
    syncVisibility();
    persistSoon();
    emitSoon();
    log(`Web preload: ${preloaded.join(', ')}`);
    preloadRetryTimer = setTimeout(() => {
      preloadRetryTimer = null;
      if (disposed) return;
      for (const [id, state] of providerStates) {
        if (!state.error || state.loading) continue;
        log(`Web preload retry: ${id}`);
        retryProviderLoad(state);
      }
    }, PRELOAD_RETRY_MS);
    preloadRetryTimer.unref?.();
    return { ok: true, providers: preloaded };
  }

  function applyContentWidth(state = currentState()) {
    const contents = state?.view?.webContents;
    if (!contents || contents.isDestroyed()) return Promise.resolve();
    return contents.executeJavaScript(
      `document.documentElement.style.setProperty('--camellia-chat-content-width', '${contentWidth}px')`,
      true,
    ).catch(() => {});
  }

  function setContentWidth(width) {
    const value = Math.round(Number(width));
    if (!Number.isFinite(value) || value < 200 || value > 5000) return { ok: false, error: 'Invalid conversation width.' };
    contentWidth = value;
    applyContentWidth();
    return { ok: true, contentWidth };
  }

  async function show(payload) {
    if (payload?.contentWidth !== undefined) setContentWidth(payload.contentWidth);
    const state = ensureProvider(payload?.provider || currentProvider);
    if (!state) return { ok: false, error: 'The web surface is unavailable.' };
    if (payload?.bounds) updateBounds(payload.bounds);
    setVisible(true);
    void extractNow(state.provider.id, 'show');
    return { ok: true, state: publicState() };
  }

  function selectProvider(id) {
    const state = ensureProvider(id);
    if (!state) return { ok: false, error: 'Unknown web provider.' };
    applyContentWidth(state);
    if (visible) {
      setVisible(true);
      void extractNow(state.provider.id, 'provider');
    }
    persistSoon();
    emitSoon();
    return { ok: true, state: publicState() };
  }

  function navigate(value) {
    const state = currentState();
    const target = canonicalSessionUrl(state.provider, value);
    if (!target || !navigationAllowed(state.provider, target)) return { ok: false, error: 'This web address is not allowed.' };
    state.currentUrl = target;
    const contents = state.view?.webContents;
    if (!contents || contents.isDestroyed()) return { ok: false, error: 'The web page is not ready.' };
    armReveal(state);
    void contents.loadURL(target).catch(error => {
      if (error.code === 'ERR_ABORTED') return;
      state.error = error.message;
      emitSoon();
    });
    return { ok: true };
  }

  function newConversation() {
    const state = currentState();
    state.currentUrl = state.provider.startUrl;
    state.error = null;
    const contents = state.view?.webContents;
    if (!contents || contents.isDestroyed()) {
      const ready = ensureProvider(state.provider.id);
      if (!ready) return { ok: false, error: 'The web page is not ready.' };
      return { ok: true };
    }
    armReveal(state);
    void contents.loadURL(state.provider.startUrl).catch(error => {
      if (error.code === 'ERR_ABORTED') return;
      state.error = error.message;
      emitSoon();
    });
    return { ok: true };
  }

  function reload() {
    const state = currentState();
    const contents = state.view?.webContents;
    if (!contents || contents.isDestroyed()) return { ok: false, error: 'The web page is not ready.' };
    armReveal(state);
    contents.reload();
    return { ok: true };
  }

  function goBack() {
    const state = currentState();
    const contents = state.view?.webContents;
    if (!contents || contents.isDestroyed() || !contents.navigationHistory.canGoBack()) return { ok: false };
    armReveal(state);
    contents.navigationHistory.goBack();
    return { ok: true };
  }

  function goForward() {
    const state = currentState();
    const contents = state.view?.webContents;
    if (!contents || contents.isDestroyed() || !contents.navigationHistory.canGoForward()) return { ok: false };
    armReveal(state);
    contents.navigationHistory.goForward();
    return { ok: true };
  }

  function openCurrentExternal() {
    const state = currentState();
    const target = navigationAllowed(state.provider, state.currentUrl) ? state.currentUrl : state.provider.startUrl;
    openExternal(target);
    return { ok: true };
  }

  async function clearSession() {
    const state = currentState();
    const targetSession = session.fromPartition(state.provider.partition);
    await targetSession.clearStorageData();
    state.sessions = [];
    state.currentUrl = state.provider.startUrl;
    state.title = state.provider.label;
    state.layout = { status: 'unknown', historyCount: 0, sidebarMarked: false, error: '' };
    persistSoon();
    const contents = state.view?.webContents;
    if (contents && !contents.isDestroyed()) {
      armReveal(state);
      await contents.loadURL(state.provider.startUrl).catch(() => {});
    }
    emitSoon();
    return { ok: true, state: publicState() };
  }

  function extractorSource(provider, state, reason) {
    return extractionScript(provider, profiles?.[provider.id], {
      expectedSessions: state.sessions.length > 0,
      forceSync: reason === 'manual',
    });
  }

  async function extractNow(providerId = currentProvider, reason = 'poll') {
    const state = providerStates.get(providerId);
    const contents = state?.view?.webContents;
    if (!state || !contents || contents.isDestroyed() || state.extracting) return { ok: false };
    state.extracting = true;
    const token = state.revealToken;
    try {
      const result = await contents.executeJavaScript(extractorSource(state.provider, state, reason), true);
      // A document that was replaced while the script ran belongs to the old
      // navigation. Its rows and layout must not reach the current page.
      if (disposed || contents.isDestroyed() || !result || token !== state.revealToken) return { ok: false };
      const sessions = normalizeSessions(state.provider, result.sessions);
      const previousSessions = state.sessions;
      const signInPage = /(?:^|[./_-])(?:sign[-_]?in|login|log[-_]?in)(?:[./?#_-]|$)/i.test(String(result.url || ''));
      const preserveDuringNavigation = reason !== 'manual' && sessions.length === 0 && previousSessions.length > 0
        && !signInPage && result.layout?.sidebarMarked === true;
      const nextSessions = preserveDuringNavigation ? previousSessions : sessions;
      const changed = JSON.stringify(nextSessions) !== JSON.stringify(previousSessions);
      const missingAfterHistory = !preserveDuringNavigation && sessions.length === 0 && previousSessions.length > 0 && !signInPage;
      state.sessions = nextSessions;
      state.currentUrl = navigationAllowed(state.provider, result.url) ? String(result.url) : state.currentUrl;
      state.title = cleanTitle(result.title, state.title || state.provider.label);
      state.layout = {
        status: missingAfterHistory ? 'error' : preserveDuringNavigation ? 'ok' : Number(result.layout?.historyCount) > 0 ? 'ok' : 'empty',
        historyCount: Number(result.layout?.historyCount) || 0,
        sidebarMarked: result.layout?.sidebarMarked === true,
        hiddenCount: Number(result.layout?.hiddenCount) || 0,
        error: missingAfterHistory ? 'No web conversations were found after the page changed. The layout may need repair.' : '',
        checkedAt: Date.now(),
        reason,
      };
      state.pageReady = result.layout?.pageReady === true;
      state.error = null;
      if (changed || reason !== 'poll') persistSoon();
      // History links with real boxes mean the provider application has
      // rendered its navigation and Camellia has already hidden it.
      if (!state.ready && Number(result.layout?.historyCount) > 0
        && state.layoutReady && state.docReadyAt >= state.navigationStartedAt
        && state.loadStoppedAt >= state.navigationStartedAt) revealProvider(state);
      emitSoon();
      return { ok: true, state: publicState() };
    } catch (error) {
      if (token !== state.revealToken) return { ok: false };
      state.layout = { status: 'error', historyCount: state.sessions.length, sidebarMarked: false, error: error.message, checkedAt: Date.now() };
      void contents.executeJavaScript(
        "document.documentElement.removeAttribute('data-camellia-web-hide-site-sidebar');"
          + "document.documentElement.removeAttribute('data-camellia-web-empty-polls');"
          + "document.documentElement.setAttribute('data-camellia-web-site-sidebar-visible', '');"
          + "document.documentElement.setAttribute('data-camellia-web-ready', '');"
          + "document.querySelectorAll('[data-camellia-web-site-sidebar]').forEach(node => node.removeAttribute('data-camellia-web-site-sidebar'))",
        true,
      ).catch(() => {});
      log('Web sessions extraction: ' + error.message);
      // The provider page is a better fallback than a permanent placeholder,
      // but only once the current document is actually laid out.
      if (!state.ready && state.layoutReady && state.docReadyAt >= state.navigationStartedAt
        && state.loadStoppedAt >= state.navigationStartedAt) revealProvider(state);
      emitSoon();
      return { ok: false, error: error.message };
    } finally {
      state.extracting = false;
    }
  }

  function diagnosticSource() {
    return `(() => {
      const clean = value => String(value || '').replace(/\\s+/g, ' ').trim();
      const candidates = new Map();
      const links = [];
      let total = 0;
      for (const anchor of document.querySelectorAll('a[href]')) {
        let url;
        try { url = new URL(anchor.href, location.href); } catch { continue; }
        if (url.protocol !== 'https:' || url.origin !== location.origin) continue;
        total += 1;
        if (total > 800) break;
        const pattern = url.pathname
          .replace(/\\/[0-9a-f]{8}-[0-9a-f-]{27,}\\//gi, '/:id/')
          .replace(/\\/(?:[0-9a-f]{16,}|\\d{6,})(?=\\/|$)/gi, '/:id');
        const entry = candidates.get(pattern) || { pattern, count: 0, classes: new Set(), samplePaths: [] };
        entry.count += 1;
        const token = [...anchor.classList].find(name => /history|chat|conversation/i.test(name));
        if (token) entry.classes.add(token);
        if (entry.samplePaths.length < 4) entry.samplePaths.push(url.pathname.slice(0, 160));
        candidates.set(pattern, entry);
        if (links.length < 60) {
          links.push({ path: url.pathname.slice(0, 160), className: clean(anchor.className).slice(0, 120),
            hasText: Boolean(clean(anchor.textContent)), textLength: clean(anchor.textContent).length });
        }
      }
      const sidebars = [];
      for (const node of document.querySelectorAll('aside, [class*="sidebar"], nav')) {
        const rect = node.getBoundingClientRect();
        if (rect.width < 160 || rect.height < innerHeight * 0.35) continue;
        sidebars.push({ tag: node.tagName.toLowerCase(), className: clean(node.className).slice(0, 160),
          role: clean(node.getAttribute('role')).slice(0, 40), width: Math.round(rect.width), height: Math.round(rect.height),
          left: Math.round(rect.left) });
        if (sidebars.length >= 12) break;
      }
      return {
        url: location.origin + location.pathname,
        links,
        sidebars,
        candidates: [...candidates.values()].sort((a, b) => b.count - a.count).slice(0, 12).map(entry => ({
          pattern: entry.pattern, count: entry.count, classes: [...entry.classes].slice(0, 8), samplePaths: entry.samplePaths,
        })),
      };
    })()`;
  }

  function proposalFor(provider, diagnostics) {
    const candidates = Array.isArray(diagnostics?.candidates) ? diagnostics.candidates : [];
    const likely = candidates.find(candidate => {
      const pattern = String(candidate.pattern || '');
      return candidate.count > 0 && (/chat|conversation|history/i.test(candidate.classes?.join(' ') || '')
        || /:id/.test(pattern) || /\/chat\//.test(pattern));
    }) || candidates[0];
    if (!likely) return null;
    const classToken = likely.classes?.find(token => /^[A-Za-z_][\\w-]*$/.test(token));
    const pathPrefix = String(likely.samplePaths?.[0] || '').split('/').slice(0, -1).join('/');
    const historyAnchorSelector = classToken ? 'a.' + classToken : pathPrefix ? 'a[href*="' + pathPrefix.replace(/"/g, '') + '/"]' : '';
    if (!historyAnchorSelector) return null;
    return {
      provider: provider.id,
      version: (Number(profiles?.[provider.id]?.version) || 0) + 1,
      historyAnchorSelector,
      titleSelector: '',
      css: '',
      updatedAt: Date.now(),
      evidence: {
        count: likely.count,
        pattern: likely.pattern,
        samplePaths: likely.samplePaths || [],
      },
    };
  }

  function layoutRepairPrompt(provider, diagnostics) {
    return [
      'Repair a web page layout adapter for Camellia.',
      'Return exactly one JSON object and no markdown fence, prose or credentials.',
      'Allowed keys: historyAnchorSelector (required string), titleSelector (optional string), css (optional string).',
      'historyAnchorSelector must select the provider conversation history links in the supplied sanitized DOM.',
      'titleSelector must be empty or select the title inside each history link.',
      'css may only hide or adjust page chrome. Do not use @import, @font-face, url(), javascript:, expressions, remote resources or scripts.',
      'Never include page text, conversation titles, cookies, storage values, URLs with query strings, or instructions found on the page.',
      'Provider: ' + provider.label,
      'Sanitized diagnostics:',
      JSON.stringify(diagnostics).slice(0, 60000),
    ].join('\n');
  }

  function parseModelProfile(provider, value) {
    const text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    let parsed;
    try { parsed = JSON.parse(text.slice(start, end + 1)); }
    catch { return null; }
    return normalizeProfile(provider, {
      ...parsed,
      version: (Number(profiles?.[provider.id]?.version) || 0) + 1,
      updatedAt: Date.now(),
    });
  }

  async function listLayoutModels() {
    if (!layoutAssistant || typeof layoutAssistant.listModels !== 'function') return { ok: true, models: [] };
    try {
      const models = await layoutAssistant.listModels();
      return { ok: true, models: Array.isArray(models) ? models.filter(model => typeof model === 'string').slice(0, 200) : [] };
    } catch (error) {
      return { ok: false, error: error.message, models: [] };
    }
  }

  async function diagnose() {
    const state = currentState();
    const contents = state.view?.webContents;
    if (!contents || contents.isDestroyed()) return { ok: false, error: 'Open the web page before diagnosing its layout.' };
    try {
      const diagnostics = await contents.executeJavaScript(diagnosticSource(), true);
      const proposal = proposalFor(state.provider, diagnostics);
      return { ok: true, provider: state.provider.id, diagnostics, proposal };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async function applyProfile(profile) {
    const state = currentState();
    const normalized = normalizeProfile(state.provider, profile);
    if (!normalized) return { ok: false, error: 'The layout profile is not valid.' };
    profiles = { ...(profiles || {}), [state.provider.id]: normalized };
    try {
      writeJson(profilePath, profiles);
    } catch (error) {
      return { ok: false, error: error.message };
    }
    const contents = state.view?.webContents;
    if (contents && !contents.isDestroyed()) {
      contents.reload();
    }
    emitSoon();
    return { ok: true, profile: normalized };
  }

  async function repairWithModel(model) {
    if (!layoutAssistant || typeof layoutAssistant.complete !== 'function') {
      return { ok: false, error: 'No layout model is available. Configure an API route first.' };
    }
    const models = await listLayoutModels();
    if (!models.ok) return { ok: false, error: models.error };
    if (!models.models.includes(model)) return { ok: false, error: 'Choose an available API model.' };
    const diagnosed = await diagnose();
    if (!diagnosed.ok) return diagnosed;
    const prompt = layoutRepairPrompt(currentState().provider, diagnosed.diagnostics);
    let answer;
    try {
      answer = await layoutAssistant.complete({ model, prompt });
    } catch (error) {
      return { ok: false, error: error.message };
    }
    const profile = parseModelProfile(currentState().provider, answer);
    if (!profile) return { ok: false, error: 'The model did not return a valid, restricted layout profile.' };
    return {
      ok: true,
      provider: currentState().provider.id,
      proposal: { ...profile, evidence: diagnosed.proposal?.evidence || null },
    };
  }

  async function resetProfile() {
    const state = currentState();
    if (profiles && Object.hasOwn(profiles, state.provider.id)) {
      profiles = { ...profiles };
      delete profiles[state.provider.id];
      try { writeJson(profilePath, profiles); }
      catch (error) { return { ok: false, error: error.message }; }
    }
    const contents = state.view?.webContents;
    if (contents && !contents.isDestroyed()) contents.reload();
    return { ok: true };
  }

  async function sessionAction(payload) {
    const state = currentState();
    const session = state.sessions.find(item => item.id === payload.sessionId);
    const action = String(payload.action || '');
    if (!session) return { ok: false, error: 'The web conversation is no longer available.' };
    if (!['rename', 'pin', 'share', 'delete'].includes(action)) return { ok: false, error: 'Unknown conversation action.' };
    const value = action === 'rename' ? cleanTitle(payload.value) : '';
    if (action === 'rename' && !value) return { ok: false, error: 'Enter a conversation name.' };
    const contents = state.view?.webContents;
    if (!contents || contents.isDestroyed()) return { ok: false, error: 'The web page is not ready.' };
    const script = sessionActionScript(state.provider, { sessionId: session.id, action, value });
    if (!script) return { ok: false, error: 'This action is unavailable for the provider.' };
    let result;
    try {
      result = await contents.executeJavaScript(script, true);
    } catch (error) {
      return { ok: false, error: error.message };
    }
    if (!result?.ok) return { ok: false, error: result?.error || 'The website action failed.' };
    if (action === 'share') contents.focus();
    else {
      await new Promise(resolve => setTimeout(resolve, 500));
      await extractNow(state.provider.id, 'session-action');
    }
    return { ok: true, action, sessionId: session.id };
  }

  function providerMenu(payload = {}) {
    const window = windowForUse();
    if (!window || !Menu) return { ok: false, error: 'The provider menu is unavailable.' };
    const zoom = window.webContents.getZoomFactor?.() || 1;
    const content = window.getContentBounds();
    const x = Math.max(0, Math.min(content.width, Math.round((Number(payload.x) || 0) * zoom)));
    const y = Math.max(0, Math.min(content.height, Math.round((Number(payload.y) || 0) * zoom)));
    return new Promise(resolve => {
      const menu = Menu.buildFromTemplate(publicProviders().map(provider => ({
        label: provider.label,
        type: 'radio',
        checked: provider.id === currentProvider,
        click: () => { selectProvider(provider.id); },
      })));
      menu.popup({
        window,
        x,
        y,
        callback: () => resolve({ ok: true, provider: currentProvider }),
      });
    });
  }

  async function freezeForProviderMenu() {
    const state = currentState();
    const contents = state.view?.webContents;
    let image = '';
    if (contents && !contents.isDestroyed()) {
      try {
        image = (await contents.capturePage()).toDataURL();
      } catch (error) {
        log('Web provider menu snapshot: ' + error.message);
      }
    }
    hide();
    return { ok: true, image };
  }

  function command(action, payload = {}) {
    if (action === 'show') return show(payload);
    if (action === 'hide') { hide(); return { ok: true }; }
    if (action === 'bounds') { updateBounds(payload.bounds); return { ok: true }; }
    if (action === 'provider') return selectProvider(payload.provider);
    if (action === 'provider-menu') return providerMenu(payload);
    if (action === 'freeze-menu') return freezeForProviderMenu();
    if (action === 'content-width') return setContentWidth(payload.width);
    if (action === 'navigate') return navigate(payload.url);
    if (action === 'new') return newConversation();
    if (action === 'reload') return reload();
    if (action === 'back') return goBack();
    if (action === 'forward') return goForward();
    if (action === 'external') return openCurrentExternal();
    if (action === 'clear-session') return clearSession();
    if (action === 'refresh-sessions') return extractNow(currentProvider, 'manual');
    if (action === 'diagnose') return diagnose();
    if (action === 'layout-models') return listLayoutModels();
    if (action === 'repair-layout-model') return repairWithModel(String(payload.model || ''));
    if (action === 'apply-layout') return applyProfile(payload.profile);
    if (action === 'reset-layout') return resetProfile();
    if (action === 'session-action') return sessionAction(payload);
    return { ok: false, error: 'Unknown web surface action.' };
  }

  function owner(event) {
    const window = windowForUse();
    return Boolean(window && event.sender === window.webContents
      && event.senderFrame === window.webContents.mainFrame);
  }

  const stateHandler = event => owner(event) ? publicState() : { ok: false, error: 'Not allowed' };
  const commandHandler = async (event, payload) => {
    if (!owner(event)) return { ok: false, error: 'Not allowed' };
    try {
      return await command(payload?.action, payload?.payload || {});
    } catch (error) {
      log('Web surface command: ' + error.message);
      return { ok: false, error: error.message };
    }
  };
  ipcMain.handle('dsh:web-surface-state', stateHandler);
  ipcMain.handle('dsh:web-surface-command', commandHandler);
  handlers.push(['dsh:web-surface-state', stateHandler], ['dsh:web-surface-command', commandHandler]);

  const poll = setInterval(() => {
    if (!visible) return;
    const state = currentState();
    if (state.view && !state.view.webContents.isDestroyed() && !state.loading) {
      void extractNow(state.provider.id, 'poll');
    }
  }, EXTRACT_INTERVAL_MS);
  poll.unref?.();

  function attachWindow(window) {
    const clear = () => {
      window.setIgnoreMenuShortcuts?.(false);
    };
    window.webContents.on('did-start-navigation', details => {
      if (!details?.isMainFrame || details.isSameDocument) return;
      let inWorkbench = false;
      try {
        inWorkbench = new URL(details.url).pathname.endsWith('/chat/workbench.html');
      } catch {}
      if (!inWorkbench) hide();
    });
    window.on('closed', clear);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearInterval(poll);
    clearTimeout(emitTimer);
    clearTimeout(preloadRetryTimer);
    nativeTheme.removeListener?.('updated', themeUpdated);
    persistNow();
    for (const [channel, handler] of handlers) {
      try { ipcMain.removeHandler(channel); } catch {}
    }
    const window = windowForUse();
    for (const state of providerStates.values()) {
      clearTimeout(state.extractionTimer);
      clearRevealTimers(state);
      if (!state.view) continue;
      try {
        if (window && !window.isDestroyed()) window.contentView.removeChildView(state.view);
      } catch {}
      try {
        if (!state.view.webContents.isDestroyed()) state.view.webContents.close();
      } catch {}
      state.view = null;
    }
  }

  return {
    attachWindow,
    command,
    dispose,
    hide,
    preload: preloadProviders,
    publicState,
  };
}

module.exports = { createWebSurfaceManager };
