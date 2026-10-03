'use strict';

// Mount the discussion UI once inside the existing workbench. A shadow root
// keeps its controls/styles scoped while the sidebar and document stay alive.
window.CamelliaDiscussionSurface = { create({ host, onChange, onRename, onSidebarToggle }) {
  let view, preparing;
  async function prepare() {
    if (view) return view;
    if (preparing) return preparing;
    preparing = (async () => {
      const result = await window.dshDesktop.discussion('template');
      if (!result?.ok) throw new Error(result?.error === 'Unknown discussion action' || result?.code === 'DISCUSSION_ACTION_UNSUPPORTED'
        ? 'This feature is not loaded. Restart Camellia, then try again.' : result?.error || 'Could not open Agent discussions.');
      const template = new DOMParser().parseFromString(result.html, 'text/html');
      const base = new URL('../discussions/discussions.html', location.href);
      const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
      root.replaceChildren();
      const styles = [...template.querySelectorAll('link[rel=stylesheet]')].map(source => {
        const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = new URL(source.getAttribute('href'), base).href;
        const ready = new Promise((resolve, reject) => { link.onload = resolve; link.onerror = () => reject(new Error('Could not load discussion styles.')); });
        root.append(link); return ready;
      });
      const body = document.createElement('div'); body.className = 'discussion-workbench embedded-discussion';
      template.body.querySelectorAll('script').forEach(script => script.remove());
      body.append(...template.body.childNodes); root.append(body);
      const style = document.createElement('style');
      style.textContent = '.embedded-discussion .sidebar, .embedded-discussion .sidebar-backdrop { display: none !important; }';
      root.append(style);
      await Promise.all(styles);
      window.CamelliaI18n.observe(root);
      const mounted = window.CamelliaDiscussions.create({ root, embedded: true, onChange, onRename });
      root.getElementById('sidebarToggle').onclick = onSidebarToggle;
      root.getElementById('sidebarToggle').setAttribute('aria-label', 'Show sidebar');
      await mounted.ready; view = mounted;
      return view;
    })();
    try { return await preparing; } finally { preparing = null; }
  }
  return { prepare, async open(navigation) { return (await prepare()).open(navigation); },
    suspend: () => !view || view.suspend(), refresh: () => view?.activate(), error: error => view?.error(error), get groupId() { return view?.groupId || null; } };
} };
