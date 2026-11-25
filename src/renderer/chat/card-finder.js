'use strict';

// A card browser for one conversation. Cards accumulate far faster than chat
// turns, so finding one by title must not mean scrolling the transcript.
// The list comes from the stored index, not from parsing history.
window.CamelliaCardFinder = (() => {
  const t = value => window.CamelliaI18n?.t(value) || value;

  function normalize(value) {
    return String(value || '').toLowerCase();
  }

  function mount({ button, panel, input, status, list, getSessionId, onOpen, onStatus = () => {} }) {
    if (!button || !panel || !input || !status || !list) return null;
    const main = panel.closest('.main');
    const motion = window.CamelliaPanelMotion;
    const isOpen = () => motion?.isOpen(panel) ?? !panel.hidden;
    const showPanel = open => {
      main?.classList.toggle('has-card-finder', open);
      if (motion) motion[open ? 'open' : 'close'](panel);
      else panel.hidden = !open;
      panel.inert = !open;
      panel.setAttribute('aria-hidden', String(!open));
      button.setAttribute('aria-expanded', String(open));
    };
    let cards = [];
    let active = -1;
    let loading = false;
    let request = 0;
    const expanded = new Set();

    const close = () => {
      request += 1;
      loading = false;
      cards = [];
      expanded.clear();
      showPanel(false);
      input.value = '';
      list.replaceChildren();
      status.textContent = '';
      active = -1;
    };

    const open = async () => {
      const sessionId = getSessionId();
      if (!sessionId) {
        onStatus(t('Open a conversation before searching its cards.'));
        return;
      }
      showPanel(true);
      window.dispatchEvent(new CustomEvent('camellia:panel-open', { detail: { name: 'cards' } }));
      requestAnimationFrame(() => { if (isOpen()) input.focus(); });
      loading = true;
      const currentRequest = ++request;
      status.textContent = t('Loading cards…');
      try {
        const result = await window.dshDesktop.visualizeList?.({ sessionId, includeRevisions: true });
        if (request !== currentRequest || getSessionId() !== sessionId) return;
        if (!result?.ok) throw new Error(result?.error || t('Could not list cards'));
        cards = Array.isArray(result.cards) ? result.cards.map(card => ({
          ...card,
          revisions: (card.revisions || []).map(revision => ({ ...revision, historical: true })),
        })).sort((first, second) =>
          (second.updatedAt || 0) - (first.updatedAt || 0)
          || (second.createdAt || 0) - (first.createdAt || 0)) : [];
        loading = false;
        render();
      } catch (error) {
        if (request !== currentRequest || getSessionId() !== sessionId) return;
        loading = false;
        status.textContent = error.message || t('Could not list cards');
      }
    };

    const matches = () => {
      const query = normalize(input.value).trim();
      const byRevision = /^v\d+$/.test(query);
      return cards.flatMap(card => {
        if (!query) return expanded.has(card.cardId) ? [card, ...card.revisions] : [card];
        return [card, ...card.revisions].filter(version => byRevision
          ? 'v' + version.revision === query
          : normalize(version.title).includes(query) || normalize(version.summary).includes(query));
      });
    };

    const render = () => {
      if (loading) return;
      const rows = matches();
      const browsing = !input.value.trim();
      const dateFormat = new Intl.DateTimeFormat(document.documentElement.lang || undefined, {
        dateStyle: 'short', timeStyle: 'medium',
      });
      active = rows.length ? Math.min(Math.max(active, 0), rows.length - 1) : -1;
      list.replaceChildren();
      for (const [index, card] of rows.entries()) {
        const entry = document.createElement('div');
        entry.className = card.historical ? 'card-finder-entry is-historical' : 'card-finder-entry';
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'card-finder-row';
        row.dataset.cardId = card.cardId;
        const revision = card.revision ? 'v' + card.revision : '';
        const grouped = browsing && card.historical === true;
        if (card.revision) row.dataset.revision = card.revision;
        row.classList.toggle('is-active', index === active);
        row.classList.toggle('is-version', grouped);
        const title = document.createElement('strong');
        const cardTitle = card.title || t('Untitled card');
        title.textContent = grouped ? revision : cardTitle;
        if (grouped) row.setAttribute('aria-label', cardTitle + ' · ' + revision);
        const meta = document.createElement('span');
        const date = new Date((card.historical ? card.updatedAt : card.createdAt) ?? NaN);
        const dateLabel = card.historical ? 'Updated %s' : 'Created %s';
        meta.textContent = [
          Number.isFinite(date.getTime()) ? t(dateLabel).replace('%s', dateFormat.format(date)) : '',
          grouped ? '' : revision,
        ].filter(Boolean).join(' · ');
        row.append(title);
        if (meta.textContent) row.append(meta);
        row.addEventListener('click', () => choose(card));
        entry.append(row);
        if (card.revisions?.length && browsing) {
          const versions = document.createElement('button');
          versions.type = 'button';
          versions.className = 'card-finder-versions';
          versions.textContent = t('Version history');
          versions.setAttribute('aria-label', t('Version history for %s').replace('%s', title.textContent));
          versions.setAttribute('aria-expanded', String(expanded.has(card.cardId)));
          versions.addEventListener('click', () => {
            if (expanded.has(card.cardId)) expanded.delete(card.cardId);
            else expanded.add(card.cardId);
            active = index;
            render();
            list.children[index]?.querySelector('.card-finder-versions')?.focus();
          });
          entry.append(versions);
        }
        list.append(entry);
      }
      status.textContent = rows.length
        ? ''
        : t(cards.length ? 'No card matches this search.' : 'This conversation has no cards yet.');
    };

    const choose = card => {
      close();
      onOpen?.(card);
    };

    const move = delta => {
      const rows = matches();
      if (!rows.length) return;
      active = (active + delta + rows.length) % rows.length;
      render();
      list.children[active]?.scrollIntoView({ block: 'nearest' });
    };

    button.addEventListener('click', () => {
      if (!isOpen()) void open();
      else close();
    });
    input.addEventListener('input', () => { active = 0; render(); });
    input.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
      else if (event.key === 'Enter') {
        event.preventDefault();
        const rows = matches();
        if (rows[active]) choose(rows[active]);
      }
    });
    panel.querySelector('[data-card-finder-close], #cardFinderClose')
      ?.addEventListener('click', () => { close(); button.focus(); });
    panel.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); button.focus(); }
    });
    window.addEventListener('camellia:panel-open', event => {
      if (event.detail?.name !== 'cards' && isOpen()) close();
    });

    return {
      open: () => { void open(); },
      close,
      setAvailable: available => { button.hidden = !available; if (!available) close(); },
    };
  }

  return { mount };
})();
