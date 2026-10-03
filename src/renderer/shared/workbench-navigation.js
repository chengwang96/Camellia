'use strict';

// Shared navigation primitives. Discussion histories remain separate from ordinary sessions.
window.CamelliaWorkbenchNavigation = (() => {
  const t = value => window.CamelliaI18n.t(value);
  const engines = ['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi'];
  const paths = { plus: 'M12 5v14M5 12h14', chevron: 'm6 9 6 6 6-6',
    chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    folder: 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z',
    more: 'M5 12h.01M12 12h.01M19 12h.01', pin: 'm16 3 5 5-4 1-3 5-1 4-7-7 4-1 5-3 1-4ZM9 15l-6 6' };
  function node(tag, className, text) {
    const el = document.createElement(tag); if (className) el.className = className;
    if (text !== undefined) el.textContent = text; return el;
  }
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ width: '15', height: '15', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': name === 'more' ? '3' : '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
    const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', paths[name]); svg.append(path); return svg;
  }
  function action(label, name, run) {
    const el = node('button', 'session-more'); el.type = 'button'; el.title = t(label); el.setAttribute('aria-label', t(label));
    el.dataset.i18nAttrs = 'title aria-label'; el.append(icon(name)); el.onclick = event => { event.stopPropagation(); run(el); }; return el;
  }
  function section({ key, title, content, add, addId, addLabel = 'New group' }) {
    const el = node('section', 'nav-section'); el.dataset.navSection = key;
    const header = node('div', 'sb-group sb-flex'), toggle = node('button', 'nav-section-toggle'); toggle.type = 'button';
    const label = node('span', '', t(title)); label.dataset.i18n = ''; toggle.append(label, icon('chevron'));
    const storageKey = 'camellia-navigation-collapsed:' + key;
    let collapsed = false; try { collapsed = localStorage.getItem(storageKey) === 'true'; } catch { /* optional preference */ }
    function update() { content.hidden = collapsed; toggle.setAttribute('aria-expanded', String(!collapsed)); }
    if (!content.id) content.id = 'nav-' + key;
    toggle.setAttribute('aria-controls', content.id);
    toggle.onclick = () => { collapsed = !collapsed; update(); try { localStorage.setItem(storageKey, String(collapsed)); } catch { /* optional preference */ } };
    const create = action(addLabel, 'plus', add); if (addId) create.id = addId;
    header.append(toggle, create); el.append(header, content); update(); return el;
  }
  function discussionRow(row, { open, actions, activeId }) {
    const item = node('div', 'session-item group-item'); item.tabIndex = 0; item.setAttribute('role', 'button');
    item.dataset.groupId = row.id; item.title = row.preview || row.title;
    item.append(icon('chat'), node('span', 'session-item-text', row.title));
    if (row.id === activeId) { item.classList.add('active'); item.setAttribute('aria-current', 'page'); }
    if (row.pinned) { const pin = node('span', 'group-item-pin'); pin.title = t('Pinned'); pin.append(icon('pin')); item.append(pin); }
    const more = action('Discussion actions', 'more', anchor => actions(anchor, row)); more.setAttribute('aria-haspopup', 'menu');
    item.append(node('span', 'group-item-count', String(row.members)), more);
    item.onclick = () => open(row.id);
    item.onkeydown = event => {
      if (event.target !== item) return;
      if (['Enter', ' '].includes(event.key)) { event.preventDefault(); open(row.id); }
      if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); actions(more, row); }
    };
    item.oncontextmenu = event => { event.preventDefault(); actions(more, row, { x: event.clientX, y: event.clientY }); };
    return item;
  }
  function rememberEngine(engine) { try { if (engines.includes(engine)) localStorage.setItem('camellia-navigation-engine', engine); } catch { /* optional preference */ } }
  function lastEngine() { try { const engine = localStorage.getItem('camellia-navigation-engine'); if (engines.includes(engine)) return engine; } catch { /* use default */ } return 'claude'; }

  // The discussion page uses the same persisted workspace ordering and pagination,
  // and navigates to the ordinary renderer before creating or opening a session.
  function conversations({ container, beforeNavigate, error }) {
    const api = window.dshDesktop; let seq = 0, limits = {}, timer;
    async function command(action, payload = {}) {
      const result = await api.conversationCommand({ engine: lastEngine(), action, payload });
      if (!result?.ok) throw new Error(result?.error || 'Could not load session'); return result;
    }
    async function navigate(payload) {
      if (!beforeNavigate()) return;
      try { const result = await api.conversationSwitch({ engine: lastEngine(), navigate: true, ...payload }); if (!result?.ok) throw new Error(result?.error || 'Could not open conversation'); }
      catch (err) { error(err); }
    }
    const create = (workspaceId = null, addWorkspace = false) => navigate({ newSession: true, workspaceId, addWorkspace });
    function row(session) {
      const el = node('div', 'session-item'); el.tabIndex = 0; el.setAttribute('role', 'button'); el.dataset.conversationId = session.id;
      el.append(icon('chat'), node('span', 'session-item-text', session.title));
      el.onclick = () => navigate({ sessionId: session.id, engine: session.currentEngine });
      el.onkeydown = event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); el.click(); } }; return el;
    }
    function header(title, add) {
      const el = node('div', 'sb-group sb-flex'), label = node('span', '', t(title)); label.dataset.i18n = ''; el.append(label);
      if (add) el.append(add); return el;
    }
    async function load() {
      const current = ++seq;
      try {
        const result = await command('list-sessions', { limits }); if (current !== seq) return;
        const fragment = document.createDocumentFragment(), sessions = result.sessions || [];
        function more(target, group) {
          const page = result.pagination?.[group]; if (!page?.hasMore) return;
          const button = node('button', 'history-more', t('Load more ({0} / {1})').replace('{0}', page.loaded).replace('{1}', page.total));
          button.type = 'button'; button.onclick = () => { limits[group] = page.loaded + 60; void load(); }; target.append(button);
        }
        const pinned = sessions.filter(s => s.pinned);
        if (pinned.length) { fragment.append(header('Pinned')); pinned.forEach(s => fragment.append(row(s))); more(fragment, 'pinned'); }
        fragment.append(header('Workspaces', action('Add workspace', 'plus', () => create(null, true))));
        for (const ws of result.workspaces || []) {
          const section = node('section'); section.dataset.workspaceId = ws.id;
          const heading = node('div', 'session-item ws-row' + (ws.collapsed ? ' collapsed' : '')); heading.tabIndex = 0; heading.setAttribute('role', 'button');
          heading.setAttribute('aria-expanded', String(!ws.collapsed)); heading.title = ws.path;
          const chevron = node('span', 'ws-chev'); chevron.append(icon('chevron'));
          heading.append(chevron, icon('folder'), node('span', 'session-item-text ws-name', ws.name), node('span', 'ws-count', ws.sessionCount || ''));
          const toggle = () => command('meta-op', { op: 'toggle-collapse', workspaceId: ws.id }).then(load).catch(error);
          heading.onclick = toggle; heading.onkeydown = event => { if (event.target === heading && ['Enter', ' '].includes(event.key)) { event.preventDefault(); void toggle(); } };
          heading.append(action('New session in ' + ws.name, 'plus', () => create(ws.id))); section.append(heading);
          if (!ws.collapsed) {
            const children = node('div', 'ws-children'); sessions.filter(s => s.workspaceId === ws.id && !s.pinned).forEach(s => children.append(row(s)));
            more(children, ws.id); if (!children.childElementCount) children.append(node('div', 'ws-empty', t('No sessions. Click + to start.'))); section.append(children);
          }
          fragment.append(section);
        }
        if (!result.workspaces?.length) {
          const add = node('button', 'ws-create-link', t('Add a folder as a workspace')); add.type = 'button'; add.onclick = () => create(null, true); fragment.append(add);
        }
        fragment.append(header('Standalone sessions', action('New standalone session', 'plus', () => create())));
        const standalone = node('div'); sessions.filter(s => !s.workspaceId && !s.pinned).forEach(s => standalone.append(row(s))); more(standalone, 'recent');
        if (!standalone.childElementCount) standalone.append(node('div', 'ws-empty', t('Choose New session to start a standalone conversation')));
        fragment.append(standalone); container.replaceChildren(fragment);
      } catch (err) { if (current === seq) error(err); }
    }
    const refresh = () => { clearTimeout(timer); timer = setTimeout(load, 200); };
    const off = api.onConversationEvent?.(refresh), offArchived = api.onArchivedChanged?.(refresh);
    window.addEventListener('camellia:language', refresh); void load();
    return { create, destroy() { seq++; clearTimeout(timer); off?.(); offArchived?.(); window.removeEventListener('camellia:language', refresh); } };
  }
  return { section, discussionRow, conversations, rememberEngine };
})();
