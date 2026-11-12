'use strict';

window.createContextPanel = ({ context, getEngine, onOpen, setStatus, openConversation }) => {
  const panel = document.getElementById('contextPanel');
  const body = document.getElementById('contextPanelBody');
  const toggle = document.getElementById('contextToggle');
  const close = document.getElementById('contextPanelClose');
  const main = panel?.closest('.main');
  if (!panel || !body || !toggle || !close) return null;

  const t = value => window.CamelliaI18n?.t(value) || value;
  const categoryLabel = id => ({
    instructions: t('Instructions'), conversation: t('Conversation'), 'tool-calls': t('Tool calls'),
    'tool-results': t('Tool results'), attachments: t('Attachments'), compaction: t('Compaction'),
    pending: t('Pending input'), 'engine-managed': t('Engine-managed'),
  })[id] || id;
  const eventKindLabel = kind => ({
    compact: t('Context compacted'), handoff: t('Handoff'), 'child-settle': t('Child agent settled'),
    inject: t('Context injected'), switch: t('Binding changed'), 'child-create': t('Child created'),
    fork: t('Conversation forked'), retire: t('Summary retired'), restore: t('Summary restored'), rewrite: t('Summary rewritten'),
    'review-start': t('Cross-engine review started'), 'review-settle': t('Cross-engine review settled'),
    'review-stale': t('Cross-engine review stale'), 'review-gate': t('Review gate changed'),
  })[kind] || kind;
  const sourceLabel = source => ({
    compaction: t('Compaction'), handoff: t('Handoff'), child: t('Child agent'), block: t('Context block'),
    agent: t('Agent'), binding: t('Binding'), 'working-memory': t('Working memory'), 'global-memory': t('Global memory'),
    review: t('Cross-engine review'),
  })[source] || source;
  const statusLabel = status => ({
    completed: t('Completed'), failed: t('Failed'), stopped: t('Stopped'), running: t('Running'),
    starting: t('Starting'), waiting: t('Waiting'), cancelled: t('Cancelled'), unavailable: t('Unavailable'),
  })[status] || status;
  const fmt = value => {
    const number = Number(value) || 0;
    const absolute = Math.abs(number);
    const rendered = absolute < 1000 ? String(absolute)
      : new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(absolute / (absolute < 1e6 ? 1000 : 1e6))
        + (absolute < 1e6 ? 'K' : 'M');
    return number < 0 ? '-' + rendered : rendered;
  };
  const tokenLabel = value => fmt(value) + ' ' + t('tok');
  const countLabel = (count, singular, plural) => t(count + ' ' + (count === 1 ? singular : plural));
  const categoryClass = id => 'ctx-cat-' + String(id).replace(/[^a-z-]/g, '');
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const button = (label, run, className = 'ctx-button') => {
    const node = el('button', className, label);
    node.type = 'button';
    node.onclick = run;
    return node;
  };

  let snapshot = null;
  let previousSnapshot = null;
  let graph = null;
  let blocks = [];
  let memory = null;
  let turnSeq = null;
  let loading = false;
  let error = '';
  let requestEpoch = 0;
  let refreshTimer = null;
  const expanded = new Set();
  const contents = new Map();
  const pendingNodes = new Set();
  const expandedBlocks = new Set();
  const blockContents = new Map();
  const pendingBlocks = new Set();
  const snapshotCache = new Map();
  let rewriteBlockId = null;
  let lastSessionId = null;

  const panelIsOpen = () => window.CamelliaPanelMotion?.isOpen(panel)
    ?? (!panel.hidden && !panel.classList.contains('is-closing'));
  function setOpen(open) {
    if (open) {
      main?.classList.add('has-context-panel');
      if (window.CamelliaPanelMotion) window.CamelliaPanelMotion.open(panel); else panel.hidden = false;
      onOpen?.();
      window.dispatchEvent(new CustomEvent('camellia:panel-open', { detail: { name: 'context' } }));
      void load();
    } else {
      main?.classList.remove('has-context-panel');
      if (window.CamelliaPanelMotion) window.CamelliaPanelMotion.close(panel); else panel.hidden = true;
    }
    toggle.setAttribute('aria-expanded', String(open));
    panel.setAttribute('aria-hidden', String(!open));
    panel.inert = !open;
  }

  function reset() {
    requestEpoch++;
    snapshot = null;
    previousSnapshot = null;
    graph = null;
    blocks = [];
    memory = null;
    turnSeq = null;
    // A reset that still has a conversation to inspect is a switch in
    // progress: show the loading row until the new snapshot arrives instead
    // of an empty panel. Resets without a session render the empty state.
    loading = Boolean(context.sessionId);
    error = '';
    expanded.clear();
    contents.clear();
    pendingNodes.clear();
    expandedBlocks.clear();
    blockContents.clear();
    pendingBlocks.clear();
    snapshotCache.clear();
    rewriteBlockId = null;
    lastSessionId = context.sessionId;
    render();
  }

  async function load() {
    const sessionId = context.sessionId;
    if (!sessionId) {
      snapshot = null;
      render();
      return;
    }
    if (lastSessionId !== sessionId) reset();
    lastSessionId = sessionId;
    const epoch = ++requestEpoch;
    loading = true;
    error = '';
    render();
    try {
      const [result, agentResult, blockResult, memoryResult] = await Promise.all([
        window.dshDesktop.conversationCommand({
          engine: getEngine(), action: 'context-snapshot',
          payload: { sessionId, ...(turnSeq ? { turnSeq } : {}) },
        }),
        window.dshDesktop.conversationCommand({
          engine: getEngine(), action: 'agent-graph', payload: { sessionId },
        }).catch(() => null),
        window.dshDesktop.conversationCommand({
          engine: getEngine(), action: 'context-blocks', payload: { sessionId },
        }).catch(() => null),
        window.dshDesktop.conversationCommand({
          engine: getEngine(), action: 'context-memory-status', payload: { sessionId },
        }).catch(() => null),
      ]);
      if (epoch !== requestEpoch || context.sessionId !== sessionId) return;
      if (!result?.ok) throw new Error(result?.error || 'Context snapshot failed');
      snapshot = result.snapshot;
      if (snapshot?.turnSeq) {
        snapshotCache.set(snapshot.turnSeq, snapshot);
        while (snapshotCache.size > 32) snapshotCache.delete(snapshotCache.keys().next().value);
      }
      previousSnapshot = null;
      if (snapshot?.turnSeq > 1) {
        const previousSeq = snapshot.turnSeq - 1;
        previousSnapshot = snapshotCache.get(previousSeq) || null;
        if (!previousSnapshot) {
          const previousResult = await window.dshDesktop.conversationCommand({
            engine: getEngine(), action: 'context-snapshot',
            payload: { sessionId, turnSeq: previousSeq },
          }).catch(() => null);
          if (previousResult?.ok && previousResult.snapshot?.turnSeq
              && previousResult.snapshot.turnSeq < snapshot.turnSeq) {
            previousSnapshot = previousResult.snapshot;
            snapshotCache.set(previousSnapshot.turnSeq, previousSnapshot);
          }
        }
      }
      if (epoch !== requestEpoch || context.sessionId !== sessionId) return;
      graph = agentResult?.ok ? agentResult.graph : null;
      blocks = blockResult?.ok ? blockResult.blocks || [] : [];
      memory = memoryResult?.ok ? memoryResult : null;
      if (snapshot?.turnSeq) turnSeq = snapshot.turnSeq;
    } catch (failure) {
      if (epoch === requestEpoch) error = failure.message || String(failure);
    } finally {
      if (epoch === requestEpoch) {
        loading = false;
        render();
      }
    }
  }

  function refresh() {
    if (panel.hidden) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { refreshTimer = null; void load(); }, 180);
  }

  async function expand(node) {
    if (!node.expandable || pendingNodes.has(node.id)) return;
    if (expanded.has(node.id)) {
      expanded.delete(node.id);
      render();
      return;
    }
    expanded.add(node.id);
    if (contents.has(node.id)) {
      render();
      return;
    }
    pendingNodes.add(node.id);
    render();
    const sessionId = context.sessionId;
    try {
      const result = await window.dshDesktop.conversationCommand({
        engine: getEngine(), action: 'context-node', payload: { sessionId, nodeId: node.id },
      });
      if (!result?.ok) throw new Error(result?.error || 'Context node failed');
      if (context.sessionId === sessionId) contents.set(node.id, result.node);
    } catch (failure) {
      if (context.sessionId === sessionId) contents.set(node.id, { error: failure.message || String(failure) });
    } finally {
      pendingNodes.delete(node.id);
      render();
    }
  }

  async function expandBlock(block) {
    if (pendingBlocks.has(block.blockId)) return;
    if (expandedBlocks.has(block.blockId)) {
      expandedBlocks.delete(block.blockId);
      render();
      return;
    }
    expandedBlocks.add(block.blockId);
    if (blockContents.has(block.blockId)) {
      render();
      return;
    }
    pendingBlocks.add(block.blockId);
    render();
    const sessionId = context.sessionId;
    try {
      const result = await window.dshDesktop.conversationCommand({
        engine: getEngine(), action: 'context-expand',
        payload: { sessionId, blockId: block.blockId, maxChars: 8000 },
      });
      if (!result?.ok) throw new Error(result?.error || 'Context expansion failed');
      if (context.sessionId === sessionId) blockContents.set(block.blockId, result);
    } catch (failure) {
      if (context.sessionId === sessionId) blockContents.set(block.blockId, { error: failure.message || String(failure) });
    } finally {
      pendingBlocks.delete(block.blockId);
      render();
    }
  }

  async function blockAction(block, action, extra = {}) {
    const sessionId = context.sessionId;
    try {
      const result = await window.dshDesktop.conversationCommand({
        engine: getEngine(), action, payload: { sessionId, blockId: block.blockId, ...extra },
      });
      if (!result?.ok) throw new Error(result?.error || 'Context block action failed');
      await load();
    } catch (failure) {
      if (context.sessionId === sessionId) setStatus(failure.message || String(failure));
    }
  }

  function renderPressure() {
    if (!snapshot) return;
    const pressure = snapshot.pressure || {};
    const card = el('section', 'ctx-pressure');
    const heading = el('div', 'ctx-pressure-head');
    heading.append(el('strong', '', tokenLabel(pressure.used)), el('span', 'ctx-muted', pressure.cap ? '/ ' + tokenLabel(pressure.cap) : t('Window unknown')));
    card.append(heading);
    const meter = el('div', 'ctx-meter');
    const fill = el('span', 'ctx-meter-fill');
    fill.style.width = Math.max(0, Math.min(100, Number(pressure.pct) || 0)) + '%';
    if ((Number(pressure.pct) || 0) >= 80) fill.classList.add('hot');
    meter.append(fill);
    card.append(meter);
    const meta = el('div', 'ctx-meta');
    meta.append(el('span', 'ctx-status ' + (pressure.source === 'usage' ? 'is-observed' : 'is-estimated'),
      pressure.source === 'usage' ? t('Observed usage') : t('Estimated')));
    if (snapshot.usage?.cacheHitRate != null) meta.append(el('span', 'ctx-muted', t('Cache hit') + ' ' + snapshot.usage.cacheHitRate.toFixed(1) + '%'));
    if (snapshot.model) meta.append(el('span', 'ctx-muted', snapshot.model));
    if (snapshot.memory?.pinned) meta.append(el('span', 'ctx-badge', t('Memory pinned')));
    const diff = diffSnapshot();
    if (diff) meta.append(el('span', 'ctx-diff ' + diffClass(diff.total),
      t('vs previous') + ' ' + deltaLabel(diff.total)));
    card.append(meta);
    body.append(card);
  }

  function renderCategories() {
    if (!snapshot?.categories?.length) return;
    const section = el('section', 'ctx-section');
    const head = el('div', 'ctx-section-head');
    head.append(el('h3', '', t('Composition')), el('span', 'ctx-muted', t('Estimated categories')));
    section.append(head);
    const total = Math.max(1, snapshot.categories.reduce((sum, category) => sum + (Number(category.tokens) || 0), 0));
    const bar = el('div', 'ctx-bar');
    for (const category of snapshot.categories) {
      const part = el('span', 'ctx-bar-part ' + categoryClass(category.id));
      part.style.width = ((Number(category.tokens) || 0) / total * 100) + '%';
      part.title = categoryLabel(category.id) + ' · ' + tokenLabel(category.tokens);
      bar.append(part);
    }
    section.append(bar);
    const list = el('div', 'ctx-categories');
    for (const category of snapshot.categories) {
      const row = el('div', 'ctx-category-row');
      const label = el('span', 'ctx-category-label');
      const dot = el('span', 'ctx-dot ' + categoryClass(category.id));
      label.append(dot, el('span', '', categoryLabel(category.id)));
      row.append(label, el('span', 'ctx-category-tokens', tokenLabel(category.tokens)));
      const diff = diffSnapshot()?.categories.get(category.id);
      if (diff && diff.delta !== 0) row.append(el('span', 'ctx-diff ' + diffClass(diff.delta), deltaLabel(diff.delta)));
      row.append(el('span', 'ctx-status ' + (category.status === 'opaque' ? 'is-opaque' : category.status === 'observed' ? 'is-observed' : 'is-estimated'),
        category.status === 'opaque' ? t('Opaque') : category.status === 'observed' ? t('Observed') : t('Estimated')));
      list.append(row);
    }
    section.append(list);
    body.append(section);
  }

  function renderNodes() {
    if (!snapshot?.nodes?.length) return;
    const section = el('section', 'ctx-section');
    const head = el('div', 'ctx-section-head');
    head.append(el('h3', '', t('Request contents')), el('span', 'ctx-muted', countLabel(snapshot.nodes.length, 'item', 'items')));
    section.append(head);
    const list = el('div', 'ctx-nodes');
    for (const node of snapshot.nodes) {
      const row = el('div', 'ctx-node');
      const trigger = el('button', 'ctx-node-trigger');
      trigger.type = 'button';
      trigger.disabled = !node.expandable;
      trigger.setAttribute('aria-expanded', String(expanded.has(node.id)));
      trigger.onclick = () => void expand(node);
      const title = el('span', 'ctx-node-title');
      title.append(el('span', 'ctx-dot ' + categoryClass(node.category)), el('strong', '', categoryLabel(node.category)));
      if (node.seq) title.append(el('span', 'ctx-muted', '#' + node.seq));
      if (diffSnapshot()?.addedNodes.has(node.id)) title.append(el('span', 'ctx-badge', t('New')));
      trigger.append(title, el('span', 'ctx-node-tokens', tokenLabel(node.tokens)));
      row.append(trigger);
      if (node.preview) row.append(el('div', 'ctx-node-preview', node.preview));
      if (expanded.has(node.id)) {
        const content = contents.get(node.id);
        if (pendingNodes.has(node.id)) row.append(el('div', 'ctx-node-loading', t('Loading…')));
        else if (content?.error) row.append(el('pre', 'ctx-node-content ctx-error', content.error));
        else if (content) {
          const pre = el('pre', 'ctx-node-content', content.content || '');
          if (content.truncated) pre.append(el('span', 'ctx-node-note', '\n' + t('Content truncated')));
          if (content.redacted) pre.append(el('span', 'ctx-node-note', '\n' + t('Sensitive values redacted')));
          row.append(pre);
        }
      }
      list.append(row);
    }
    section.append(list);
    body.append(section);
  }

  function renderBlocks() {
    if (!blocks.length) return;
    const section = el('section', 'ctx-section');
    const head = el('div', 'ctx-section-head');
    head.append(el('h3', '', t('Recoverable blocks')), el('span', 'ctx-muted', String(blocks.length)));
    section.append(head);
    const list = el('div', 'ctx-blocks');
    for (const block of blocks) {
      const row = el('div', 'ctx-block');
      const trigger = el('button', 'ctx-node-trigger');
      trigger.type = 'button';
      trigger.setAttribute('aria-expanded', String(expandedBlocks.has(block.blockId)));
      trigger.onclick = () => void expandBlock(block);
      const title = el('span', 'ctx-node-title');
      title.append(el('strong', '', block.blockId), el('span', 'ctx-muted', '#' + block.fromSeq + '–#' + block.toSeq));
      if (block.firstUserPinned) title.append(el('span', 'ctx-badge', t('First user pinned')));
      if (block.retired) title.append(el('span', 'ctx-badge ctx-badge-retired', t('Retired')));
      trigger.append(title, el('span', 'ctx-node-tokens', tokenLabel(block.summaryTokens)));
      row.append(trigger);
      row.append(el('div', 'ctx-node-preview', block.summaryPreview || ''));
      if (block.active) {
        const actions = el('div', 'ctx-block-actions');
        actions.append(button(block.retired ? t('Restore') : t('Retire'), () => void blockAction(block,
          block.retired ? 'context-restore' : 'context-retire'), 'ctx-button'));
        actions.append(button(t('Rewrite'), () => { rewriteBlockId = block.blockId; render(); }, 'ctx-button'));
        row.append(actions);
        if (rewriteBlockId === block.blockId) {
          const form = el('form', 'ctx-block-rewrite');
          const input = el('textarea', '');
          input.rows = 6;
          input.placeholder = t('Paste or write the replacement summary');
          input.setAttribute('aria-label', t('Replacement summary'));
          const controls = el('div', 'ctx-block-actions');
          const save = button(t('Save summary'), () => {}, 'ctx-button');
          save.type = 'submit';
          const cancel = button(t('Cancel'), () => { rewriteBlockId = null; render(); }, 'ctx-button');
          cancel.type = 'button';
          controls.append(save, cancel);
          form.append(input, controls);
          form.onsubmit = event => {
            event.preventDefault();
            const summary = input.value.trim();
            if (!summary) return;
            rewriteBlockId = null;
            void blockAction(block, 'context-rewrite', { summary });
          };
          row.append(form);
        }
      }
      if (expandedBlocks.has(block.blockId)) {
        const content = blockContents.get(block.blockId);
        if (pendingBlocks.has(block.blockId)) row.append(el('div', 'ctx-node-loading', t('Recovering…')));
        else if (content?.error) row.append(el('pre', 'ctx-node-content ctx-error', content.error));
        else if (content) {
          row.append(el('pre', 'ctx-node-content', content.text || ''));
          if (content.truncated) row.append(el('div', 'ctx-node-note', t('Range truncated; narrow the block or export it.')));
        }
      }
      list.append(row);
    }
    section.append(list);
    body.append(section);
  }

  function renderEvents() {
    if (!snapshot?.events?.length) return;
    const section = el('section', 'ctx-section');
    section.append(el('h3', '', t('Context events')));
    const list = el('div', 'ctx-events');
    for (const event of snapshot.events) {
      const row = el('div', 'ctx-event');
      const kind = eventKindLabel(event.kind);
      row.append(el('span', 'ctx-event-kind', kind), el('span', 'ctx-event-text', kind === event.kind ? event.text : kind));
      if (Number.isFinite(event.deltaTokens)) {
        const delta = el('span', 'ctx-event-delta ' + (event.deltaTokens < 0 ? 'is-down' : 'is-up'),
          (event.deltaTokens > 0 ? '+' : '') + tokenLabel(event.deltaTokens));
        row.append(delta);
      }
      if (event.source) row.append(el('span', 'ctx-muted', sourceLabel(event.source)));
      if (event.native) row.append(el('span', 'ctx-muted', t('native')));
      list.append(row);
    }
    section.append(list);
    body.append(section);
  }

  function renderAgents() {
    if (!graph) return;
    const section = el('section', 'ctx-section');
    const head = el('div', 'ctx-section-head');
    const agentCount = Math.max(0, graph.nodes.length - 1);
    head.append(el('h3', '', t('Agents')), el('span', 'ctx-muted', countLabel(agentCount, 'child agent', 'child agents')));
    section.append(head);
    const list = el('div', 'ctx-agents');
    const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
    const depthOf = (node, seen = new Set()) => {
      if (!node?.parentId || seen.has(node.id)) return 0;
      seen.add(node.id);
      const parent = nodeById.get(node.parentId);
      return parent ? 1 + depthOf(parent, seen) : 0;
    };
    const depths = new Map(graph.nodes.map(node => [node.id, depthOf(node)]));
    if (graph.nodes.length > 1) section.append(agentGraph(depths, nodeById));
    for (const node of graph.nodes) {
      const row = el('div', 'ctx-agent');
      const depth = depths.get(node.id) || 0;
      row.style.paddingLeft = Math.min(28, depth * 12) + 'px';
      const identity = el('div', 'ctx-agent-identity');
      if (depth > 0) identity.append(el('span', 'ctx-agent-branch', '↳'));
      identity.append(el('span', 'ctx-dot ' + (node.kind === 'managed' ? 'ctx-cat-conversation' : 'ctx-cat-engine-managed')));
      const label = el('span', 'ctx-agent-title', node.title || t('Subtask'));
      if (node.managedConversationId && typeof openConversation === 'function') {
        label.setAttribute('role', 'link');
        label.tabIndex = 0;
        label.onclick = () => openConversation(node.managedConversationId);
        label.onkeydown = event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openConversation(node.managedConversationId);
          }
        };
      }
      identity.append(label);
      row.append(identity);
      const meta = el('div', 'ctx-agent-meta');
      meta.append(el('span', 'ctx-status is-' + (node.contextObserved ? 'observed' : 'opaque'),
        node.contextObserved ? t('Observed context') : t('Opaque context')));
      if (node.engine) meta.append(el('span', 'ctx-muted', node.engine));
      const parent = node.parentId ? nodeById.get(node.parentId) : null;
      if (parent) meta.append(el('span', 'ctx-muted', '← ' + (parent.title || t('Parent'))));
      if (node.contextPacket) meta.append(el('span', 'ctx-badge', t('Packet')));
      if (node.settlement) meta.append(el('span', 'ctx-badge', statusLabel(node.settlement.status)));
      row.append(meta);
      if (node.settlement?.summary) row.append(el('div', 'ctx-agent-summary', node.settlement.summary));
      list.append(row);
    }
    if (graph.nodes.length < 2) list.append(el('p', 'ctx-empty', t('No child agents yet.')));
    if (graph.truncated) list.append(el('p', 'ctx-empty', t('Only the newest agents are shown.')));
    section.append(list);
    body.append(section);
  }

  function agentGraph(depths, nodeById) {
    const levels = new Map();
    for (const node of graph.nodes) {
      const depth = depths.get(node.id) || 0;
      const level = levels.get(depth) || [];
      level.push(node);
      levels.set(depth, level);
    }
    const maxDepth = Math.max(0, ...levels.keys());
    const maxLevel = Math.max(1, ...[...levels.values()].map(level => level.length));
    const width = Math.max(320, maxLevel * 150);
    const height = Math.max(64, (maxDepth + 1) * 62);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('ctx-graph-svg');
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', t('Agent graph'));
    const points = new Map();
    for (const [depth, level] of levels) {
      level.forEach((node, index) => {
        const x = width / (level.length + 1) * (index + 1);
        const y = 22 + depth * 62;
        points.set(node.id, { x, y });
      });
    }
    for (const edge of graph.edges || []) {
      const from = points.get(edge.from), to = points.get(edge.to);
      if (!from || !to) continue;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', from.x); line.setAttribute('y1', from.y + 12);
      line.setAttribute('x2', to.x); line.setAttribute('y2', to.y - 12);
      line.classList.add('ctx-graph-edge');
      svg.append(line);
    }
    for (const node of graph.nodes) {
      const point = points.get(node.id);
      if (!point) continue;
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      const box = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      box.setAttribute('x', point.x - 48); box.setAttribute('y', point.y - 12);
      box.setAttribute('width', 96); box.setAttribute('height', 24); box.setAttribute('rx', 7);
      box.classList.add('ctx-graph-node', node.contextObserved ? 'is-observed' : 'is-opaque');
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', point.x); label.setAttribute('y', point.y + 4);
      label.classList.add('ctx-graph-label');
      label.textContent = String(node.title || t('Subtask')).slice(0, 18);
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = node.title || '';
      group.append(box, label, title);
      svg.append(group);
    }
    return svg;
  }

  function renderMemory() {
    if (!memory) return;
    const section = el('section', 'ctx-section');
    const head = el('div', 'ctx-section-head');
    head.append(el('h3', '', t('Working memory')), el('span', 'ctx-status ' + (memory.enabled ? 'is-observed' : 'is-opaque'),
      memory.enabled ? t('Enabled') : t('Disabled')));
    section.append(head);
    if (!memory.enabled) {
      section.append(el('p', 'ctx-empty', t('Enable working memory in Settings to inject a bounded snapshot.')));
      body.append(section);
      return;
    }
    section.append(el('p', 'ctx-muted', t('User entries') + ': ' + memory.scope.user + ' · ' + t('Workspace entries') + ': ' + memory.scope.workspace));
    if (memory.snapshot) {
      const details = el('details', 'ctx-memory-snapshot');
      details.append(el('summary', '', t('Snapshot preview')));
      details.append(el('pre', 'ctx-node-content', memory.snapshot));
      section.append(details);
    }
    body.append(section);
  }

  function render() {
    body.replaceChildren();
    if (!context.sessionId) {
      body.append(el('p', 'ctx-empty', t('Open a conversation to inspect its context.')));
      return;
    }
    const controls = el('div', 'ctx-controls');
    controls.append(button(t('Previous turn'), () => {
      if (!snapshot?.turnSeq) return;
      turnSeq = Math.max(1, snapshot.turnSeq - 1);
      void load();
    }));
    controls.append(button(t('Latest'), () => { turnSeq = null; void load(); }));
    controls.append(button(loading ? t('Refreshing…') : t('Refresh'), () => void load()));
    body.append(controls);
    if (loading && !snapshot) body.append(el('p', 'ctx-empty', t('Reading context…')));
    if (error) body.append(el('p', 'ctx-empty ctx-error', error));
    if (!snapshot) return;
    renderPressure();
    renderDiffSummary();
    renderCategories();
    renderBlocks();
    renderNodes();
    renderEvents();
    renderAgents();
    renderMemory();
    if (snapshot.warnings?.length) {
      const section = el('section', 'ctx-section ctx-warnings');
      section.append(el('h3', '', t('Limits')));
      for (const warning of snapshot.warnings) section.append(el('p', '', t(warning)));
      body.append(section);
    }
  }

  function diffSnapshot() {
    if (!snapshot || !previousSnapshot) return null;
    if (snapshot.conversationId !== previousSnapshot.conversationId) return null;
    const previousCategories = new Map((previousSnapshot.categories || []).map(category => [category.id, Number(category.tokens) || 0]));
    const currentIds = new Set((snapshot.categories || []).map(category => category.id));
    const categories = new Map();
    for (const category of snapshot.categories || []) {
      const before = previousCategories.get(category.id) || 0;
      categories.set(category.id, { before, after: Number(category.tokens) || 0, delta: (Number(category.tokens) || 0) - before });
    }
    for (const [id, before] of previousCategories) {
      if (!currentIds.has(id)) categories.set(id, { before, after: 0, delta: -before, removed: true });
    }
    const previousNodes = new Set((previousSnapshot.nodes || []).map(node => node.id));
    const currentNodeList = snapshot.nodes || [];
    const currentNodes = new Set(currentNodeList.map(node => node.id));
    return {
      total: (Number(snapshot.pressure?.used) || 0) - (Number(previousSnapshot.pressure?.used) || 0),
      categories,
      addedNodes: new Set(currentNodeList.filter(node => !previousNodes.has(node.id)).map(node => node.id)),
      removedNodes: (previousSnapshot.nodes || []).filter(node => !currentNodes.has(node.id)),
    };
  }

  function renderDiffSummary() {
    const diff = diffSnapshot();
    if (!diff) return;
    const summary = el('div', 'ctx-diff-summary');
    summary.append(el('span', 'ctx-muted', t('vs previous turn')),
      el('span', 'ctx-diff ' + diffClass(diff.total), deltaLabel(diff.total)),
      el('span', 'ctx-muted', '+' + diff.addedNodes.size + ' / -' + diff.removedNodes.length + ' ' + t('nodes')));
    body.append(summary);
  }

  function diffClass(value) {
    return value > 0 ? 'is-up' : value < 0 ? 'is-down' : 'is-flat';
  }

  function deltaLabel(value) {
    const number = Number(value) || 0;
    return (number > 0 ? '+' : '') + tokenLabel(number);
  }

  toggle.onclick = () => setOpen(!panelIsOpen());
  close.onclick = () => { setOpen(false); toggle.focus(); };
  panel.onkeydown = event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      toggle.focus();
    }
  };
  window.addEventListener('camellia:panel-open', event => {
    if (event.detail?.name !== 'context' && panelIsOpen()) setOpen(false);
  });
  window.addEventListener('camellia:language', render);
  render();

  return {
    setOpen,
    isOpen: panelIsOpen,
    refresh,
    reset,
    render,
  };
};
