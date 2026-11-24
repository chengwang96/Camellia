'use strict';

// A card browser for one conversation. Cards accumulate far faster than chat
// turns, so finding one by title must not mean scrolling the transcript.
// The list comes from the stored index, not from parsing history.
window.CamelliaCardFinder = (() => {
  const MAX_RESULTS = 40;

  function normalize(value) {
    return String(value || '').toLowerCase();
  }

  function mount({ button, panel, input, status, list, getSessionId, onOpen, onStatus = () => {} }) {
    if (!button || !panel || !input || !status || !list) return null;
    let cards = [];
    let active = -1;
    let loading = false;

    const close = () => {
      panel.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      input.value = '';
      list.replaceChildren();
      status.textContent = '';
      active = -1;
    };

    const open = async () => {
      const sessionId = getSessionId();
      if (!sessionId) {
        onStatus('Open a conversation before searching its cards.');
        return;
      }
      panel.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      loading = true;
      status.textContent = 'Loading cards…';
      try {
        const result = await window.dshDesktop.visualizeList?.({ sessionId });
        if (!result?.ok) throw new Error(result?.error || 'Could not list cards');
        // A newer conversation may have opened while the list was loading.
        if (getSessionId() !== sessionId) return;
        cards = Array.isArray(result.cards) ? result.cards : [];
        // Clear the guard before rendering: render() deliberately skips while
        // a request is in flight, and the finally block ran too late for it.
        loading = false;
        render();
      } catch (error) {
        status.textContent = error.message || 'Could not list cards';
        cards = [];
        list.replaceChildren();
      } finally {
        loading = false;
      }
      input.focus();
      input.select();
    };

    const matches = () => {
      const query = normalize(input.value).trim();
      const rows = query
        ? cards.filter(card => normalize(card.title).includes(query)
          || normalize(card.summary).includes(query))
        : cards;
      return rows.slice(0, MAX_RESULTS);
    };

    const render = () => {
      if (loading) return;
      const rows = matches();
      active = rows.length ? Math.min(Math.max(active, 0), rows.length - 1) : -1;
      list.replaceChildren();
      for (const [index, card] of rows.entries()) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'card-finder-row';
        row.setAttribute('role', 'option');
        row.dataset.cardId = card.cardId;
        if (index === active) row.setAttribute('aria-selected', 'true');
        const title = document.createElement('strong');
        title.textContent = card.title || 'Untitled card';
        const meta = document.createElement('span');
        meta.textContent = (card.revision ? 'v' + card.revision : '') + (card.summary ? ' · ' + card.summary : '');
        row.append(title, meta);
        row.addEventListener('click', () => choose(card));
        list.append(row);
      }
      if (!rows.length) {
        status.textContent = cards.length
          ? 'No card matches this search.'
          : 'This conversation has no cards yet.';
        return;
      }
      status.textContent = cards.length > rows.length
        ? 'Showing ' + rows.length + ' of ' + cards.length + ' cards.'
        : rows.length + (rows.length === 1 ? ' card.' : ' cards.');
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
      if (panel.hidden) void open();
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
      } else if (event.key === 'Escape') { event.preventDefault(); close(); button.focus(); }
    });
    panel.querySelector('[data-card-finder-close], #cardFinderClose')
      ?.addEventListener('click', () => { close(); button.focus(); });
    document.addEventListener('pointerdown', event => {
      if (panel.hidden) return;
      if (panel.contains(event.target) || button.contains(event.target)) return;
      close();
    }, true);

    return {
      open: () => { void open(); },
      close,
      setAvailable: available => { button.hidden = !available; if (!available) close(); },
    };
  }

  return { mount, MAX_RESULTS };
})();
