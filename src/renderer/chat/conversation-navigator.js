'use strict';

window.CamelliaConversationNavigator = (() => {
  const translate = value => window.CamelliaI18n?.t(value) || value;
  const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const summarize = text => {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    return value.length > 96 ? value.slice(0, 95).trimEnd() + '…' : value;
  };
  const previewSummary = text => {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    return value.length > 480 ? value.slice(0, 479).trimEnd() + '…' : value;
  };

  function create({ rail, scroll, chat, main, enabled = true }) {
    if (!rail || !scroll || !chat || !main) return null;
    let isEnabled = enabled !== false;
    let entries = [];
    let signature = '';
    let track = null;
    let earlierButton = null;
    let laterButton = null;
    let activeIndex = -1;
    let windowStart = 0;
    let syncTimer = 0;
    let activeFrame = 0;
    let previewIndex = -1;
    const MAX_VISIBLE_MARKERS = 20;
    const preview = document.createElement('div');
    preview.className = 'conversation-preview';
    preview.id = 'conversationPreview';
    preview.setAttribute('role', 'tooltip');
    preview.setAttribute('aria-hidden', 'true');
    main.append(preview);

    const promptOf = turn => {
      const text = turn.messageData?.text;
      return summarize(text || translate('Attachments'));
    };
    const markerLabel = (turn, index) => translate('Jump to turn {0}: {1}')
      .replace('{0}', String(index + 1)).replace('{1}', promptOf(turn));
    const turns = () => [...chat.querySelectorAll('.msg-user')];

    function hidePreview() {
      previewIndex = -1;
      preview.classList.remove('is-visible');
      preview.setAttribute('aria-hidden', 'true');
    }

    function showPreview(button, index) {
      if (rail.hidden || !isEnabled) return;
      const turn = entries[index];
      if (!turn) return;
      if (previewIndex !== index) {
        previewIndex = index;
        const meta = document.createElement('div'), kicker = document.createElement('span'), action = document.createElement('span');
        meta.className = 'conversation-preview-meta';
        kicker.className = 'conversation-preview-kicker';
        kicker.textContent = translate('Turn {0}').replace('{0}', String(index + 1));
        action.className = 'conversation-preview-action';
        action.textContent = translate('Click to jump');
        meta.append(kicker, action);
        const body = document.createElement('div');
        body.className = 'conversation-preview-text';
        body.textContent = previewSummary(turn.messageData?.text || translate('Attachments'));
        preview.replaceChildren(meta, body);
      }
      const mainBox = main.getBoundingClientRect(), markerBox = button.getBoundingClientRect();
      const width = preview.offsetWidth, height = preview.offsetHeight;
      const left = Math.max(8, markerBox.right - mainBox.left + 10);
      let top = markerBox.top - mainBox.top + markerBox.height / 2 - height / 2;
      top = Math.max(8, Math.min(mainBox.height - height - 8, top));
      const arrow = Math.max(11, Math.min(height - 11, markerBox.top - mainBox.top + markerBox.height / 2 - top));
      preview.style.left = left + 'px';
      preview.style.top = Math.round(top) + 'px';
      preview.style.setProperty('--preview-arrow-y', Math.round(arrow) + 'px');
      preview.classList.add('is-visible');
      preview.setAttribute('aria-hidden', 'false');
    }

    function updateLayout() {
      if (rail.hidden) return;
      const mainBox = main.getBoundingClientRect();
      const scrollBox = scroll.getBoundingClientRect();
      rail.style.left = '2px';
      rail.style.top = Math.max(0, Math.round(scrollBox.top - mainBox.top + 26)) + 'px';
      rail.style.height = Math.max(80, Math.round(scrollBox.height - 52)) + 'px';
    }

    function updateVisibility() {
      const gutter = chat.getBoundingClientRect().left - main.getBoundingClientRect().left;
      const available = turns().length > 1 && innerWidth > 760
        && !chat.querySelector('.empty-state')
        && gutter >= 22
        && scroll.scrollHeight > scroll.clientHeight + 24;
      rail.hidden = !isEnabled || !available;
      rail.setAttribute('aria-hidden', String(rail.hidden));
      if (rail.hidden) hidePreview();
      else updateLayout();
    }

    function updateActive() {
      if (rail.hidden || !entries.length) return;
      const scrollBox = scroll.getBoundingClientRect();
      const probe = scrollBox.top + Math.min(180, scrollBox.height * 0.3);
      let nextIndex = 0;
      if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 4) {
        nextIndex = entries.length - 1;
      } else {
        for (let index = 0; index < entries.length; index++) {
          if (entries[index].getBoundingClientRect().top <= probe) nextIndex = index;
          else break;
        }
      }
      if (nextIndex === activeIndex) return;
      activeIndex = nextIndex;
      updateWindow();
      const buttons = track ? [...track.querySelectorAll('.conversation-marker')] : [];
      for (let index = 0; index < buttons.length; index++) {
        const active = index === activeIndex;
        buttons[index].classList.toggle('is-current', active);
        if (active) buttons[index].setAttribute('aria-current', 'location');
        else buttons[index].removeAttribute('aria-current');
      }
      const activeButton = buttons[activeIndex];
      if (activeButton && track.scrollHeight > track.clientHeight) {
        const centered = activeButton.offsetTop - (track.clientHeight - activeButton.offsetHeight) / 2;
        track.scrollTop = Math.max(0, centered);
      }
    }

    function updateWindow() {
      const total = entries.length;
      const maxStart = Math.max(0, total - MAX_VISIBLE_MARKERS);
      const centered = activeIndex - Math.floor(MAX_VISIBLE_MARKERS / 2);
      windowStart = Math.max(0, Math.min(maxStart, centered));
      if (total <= MAX_VISIBLE_MARKERS) windowStart = 0;
      if (track) {
        for (const [index, button] of [...track.querySelectorAll('.conversation-marker')].entries()) {
          button.hidden = index < windowStart || index >= windowStart + MAX_VISIBLE_MARKERS;
        }
      }
      if (earlierButton) {
        earlierButton.hidden = windowStart === 0;
        earlierButton.setAttribute('aria-label', translate('Earlier turns'));
      }
      if (laterButton) {
        laterButton.hidden = windowStart + MAX_VISIBLE_MARKERS >= total;
        laterButton.setAttribute('aria-label', translate('Later turns'));
      }
    }

    function jumpTo(index) {
      const turn = entries[index];
      if (!turn) return;
      const top = scroll.scrollTop + turn.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 18;
      scroll.scrollTo({ top: Math.max(0, top), behavior: reducedMotion() ? 'auto' : 'smooth' });
    }

    function windowButton(direction) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'conversation-window-more is-' + direction;
      button.addEventListener('click', () => {
        hidePreview();
        const target = direction === 'up'
          ? Math.max(0, windowStart - 1)
          : Math.min(entries.length - 1, windowStart + MAX_VISIBLE_MARKERS);
        jumpTo(target);
      });
      return button;
    }

    function build(force = false) {
      const nextEntries = turns();
      const nextSignature = nextEntries.map(turn => (turn.messageData?.seq || '') + '\u0000' + promptOf(turn)).join('\u0001');
      if (force || nextSignature !== signature) {
        hidePreview();
        signature = nextSignature;
        entries = nextEntries;
        activeIndex = -1;
        rail.replaceChildren();
        track = document.createElement('div');
        track.className = 'conversation-rail-track';
        earlierButton = windowButton('up');
        laterButton = windowButton('down');
        track.append(earlierButton);
        for (let index = 0; index < entries.length; index++) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'conversation-marker';
          button.setAttribute('aria-label', markerLabel(entries[index], index));
          button.setAttribute('aria-describedby', preview.id);
          const line = document.createElement('span');
          line.className = 'conversation-marker-line';
          button.append(line);
          button.addEventListener('mouseenter', () => showPreview(button, index));
          button.addEventListener('mouseleave', hidePreview);
          button.addEventListener('focus', () => showPreview(button, index));
          button.addEventListener('blur', hidePreview);
          button.addEventListener('click', () => { hidePreview(); jumpTo(index); });
          track.append(button);
        }
        track.append(laterButton);
        rail.append(track);
      }
      updateVisibility();
      updateActive();
    }

    function scheduleSync() {
      clearTimeout(syncTimer);
      syncTimer = setTimeout(build, 60);
    }
    function scheduleActive() {
      if (activeFrame) return;
      activeFrame = requestAnimationFrame(() => {
        activeFrame = 0;
        hidePreview();
        updateActive();
        updateVisibility();
      });
    }
    function rebuildForLanguage() { build(true); }

    const mutationObserver = new MutationObserver(scheduleSync);
    mutationObserver.observe(chat, { childList: true });
    const resizeObserver = new ResizeObserver(() => { updateVisibility(); updateLayout(); });
    resizeObserver.observe(scroll);
    resizeObserver.observe(chat);
    scroll.addEventListener('scroll', scheduleActive, { passive: true });
    window.addEventListener('resize', scheduleActive, { passive: true });
    window.addEventListener('camellia:language', rebuildForLanguage);
    window.addEventListener('camellia:panel-open', scheduleActive);

    build();
    return {
      setEnabled(value) {
        isEnabled = value !== false;
        hidePreview();
        build();
      },
      refresh: build,
      isEnabled: () => isEnabled,
      destroy() {
        clearTimeout(syncTimer);
        if (activeFrame) cancelAnimationFrame(activeFrame);
        mutationObserver.disconnect();
        resizeObserver.disconnect();
        scroll.removeEventListener('scroll', scheduleActive);
        window.removeEventListener('resize', scheduleActive);
        window.removeEventListener('camellia:language', rebuildForLanguage);
        window.removeEventListener('camellia:panel-open', scheduleActive);
        rail.replaceChildren();
        rail.hidden = true;
        preview.remove();
      },
    };
  }

  return { create };
})();
