'use strict';

const discussionReferenceSources = new Set();
window.CamelliaDiscussions = {
references() {
  const snapshots = [...discussionReferenceSources].map(read => read());
  return { references: snapshots.map(snapshot => snapshot.references), active: snapshots.some(snapshot => snapshot.active) };
},
create({ root = document, embedded = false, onChange = () => {}, onRename } = {}) {
const $ = id => root.getElementById(id);
const body = embedded ? root.querySelector('.discussion-workbench') : document.body;
const isVisible = () => !embedded || !root.host.hidden;
const desktop = window.dshDesktop;
const t = text => window.CamelliaI18n.t(text);
const navigation = window.CamelliaWorkbenchNavigation;
$('discussionNavigation').replaceChildren(navigation.section({ key: 'discussions', title: 'Agent discussions (beta)', content: $('groupList'), add: newGroup, addId: 'newGroup' }));
let conversationNavigation, navigationRequest = 0, pendingNavigationIntent, navigating = false;
let groups = [], group = null, bindings = [], selected = new Set(), sending = false, loading = 0, refreshTimer;
const verifyingMembers = new Set();
const verificationErrors = new Map();
let verifyingBinding = null;
let selectedProvider = '';
let identityTarget = null, identitySaving = false, identityReturnFocus = null;
let attachments = [];
const drafts = new Map(), failures = new Map();
const selectedGroupKey = 'camellia:discussion:selected';
const draftPrefix = 'camellia:discussion:draft:';
const messageNodes = new Map();
let groupMenu = null, renamingId = null, deleteTarget = null;
const openStatuses = new Set(['queued', 'preparing', 'running', 'stopping']);
const stateLabels = { queued: 'Waiting', preparing: 'Preparing context', context: 'Preparing context', running: 'Replying', stopping: 'Stopping',
  failed: 'Response failed', cancelled: 'Stopped', interrupted: 'Interrupted', completed: 'Finished', summary: 'Preparing context', approval: 'Waiting for your input' };
const rich = window.CamelliaDiscussionRich.create({ root, isVisible, getGroup: () => group, call, mutate: (action, payload) => mutate(action, payload, true),
  getAttachments: () => attachments, setAttachments: value => { attachments = value; }, changed: () => { rememberDraft(); resizeComposer(); }, error });
const cleanupReferences = () => ({ references: [attachments, [...drafts.values()]], active: sending || rich.uploading || navigating });
discussionReferenceSources.add(cleanupReferences);
let cleanupReferenceIdentity = '';
function node(tag, className, text) { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; }
function button(text, action, className = 'btn-secondary') {
  const value = node('button', className, text); value.type = 'button';
  value.onclick = async () => { value.disabled = true; try { await action(); } catch (err) { error(err); } finally { if (value.isConnected) value.disabled = false; } };
  return value;
}
function error(error) { $('noticeText').textContent = error?.message || String(error); $('notice').hidden = false; }
function clearNotice() { $('noticeText').textContent = ''; $('notice').hidden = true; }
$('dismissNotice').onclick = clearNotice;
function icon(path, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true'); if (className) svg.setAttribute('class', className);
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path'); line.setAttribute('d', path); svg.append(line); return svg;
}
function avatar(engine, className = '') {
  const mark = node('span', 'engine-mark ' + className), image = node('img');
  mark.dataset.engine = engine; mark.setAttribute('aria-hidden', 'true'); image.alt = '';
  image.src = '../../../assets/brands/' + ({ codex: 'codex.png', dsh: 'deepseek.svg', claude: 'claude.svg', kimi: 'kimi.svg', pi: 'pi.svg', antigravity: 'antigravity.svg' }[engine] || 'codex.png');
  mark.append(image); return mark;
}
function identityButton(memberId, name, engine, roster = false) {
  const control = node('button', 'member-identity'); control.type = 'button'; control.dataset.memberId = memberId;
  control.title = t('Edit identity prompt'); control.setAttribute('aria-label', t('Edit identity prompt') + ': ' + name);
  control.append(avatar(engine, roster ? '' : 'turn-avatar'), node(roster ? 'strong' : 'span', 'identity-name', name));
  control.onclick = () => openIdentity(memberId);
  return control;
}
function openIdentity(memberId) {
  const member = group?.participants.find(p => p.id === memberId); if (!member) return;
  identityTarget = { groupId: group.id, memberId }; identityReturnFocus = root.activeElement;
  $('identityMember').replaceChildren(avatar(member.engine), node('strong', '', member.name));
  $('identityPrompt').value = member.identityPrompt || ''; $('identityError').textContent = '';
  updateIdentityState(); $('identityDialog').showModal(); $('identityPrompt').focus();
}
function updateIdentityState() {
  if (!identityTarget) return;
  if (identityTarget.groupId !== group?.id) { $('identityDialog').close(); return; }
  const member = group.participants.find(p => p.id === identityTarget.memberId);
  const busy = group.verifying || verifyingMembers.has(member?.id)
    || group.deliveries.some(d => d.participantId === member?.id && openStatuses.has(d.status));
  const notice = !member || member.removed || member.removalPending ? 'This member has been removed.'
    : member.recoveryRequired ? 'Recovery needs verification'
      : busy ? 'Wait for this member to finish replying or stop it before editing its identity.' : '';
  $('identityBusy').textContent = t(notice); $('identityBusy').hidden = !notice;
  $('saveIdentity').disabled = identitySaving || Boolean(notice);
  $('identityPrompt').readOnly = identitySaving || !member || member.removed || member.removalPending;
  $('identityDialog').querySelector('[data-close]').disabled = identitySaving;
}
function markdown(text) {
  const fragment = window.CamelliaMarkdown.render(document, text, { allowImages: true,
    copyLabel: t('Copy code'), copiedLabel: t('Copied'), failedLabel: t('Copy failed'), wrapLabel: t('Word wrap') });
  fragment.querySelectorAll('code').forEach(code => { if (!code.closest('pre')) code.classList.add('md-inline'); });
  for (const [selector, className] of [['table', 'md-table'], ['ul, ol', 'md-list'], ['blockquote', 'md-quote'], ['hr', 'md-rule'], ['.md-code-header .actions', 'md-code-actions']]) {
    fragment.querySelectorAll(selector).forEach(element => element.classList.add(className));
  }
  return fragment;
}
function copyAction(text, assistant) {
  const actions = node('div', 'message-actions' + (assistant ? ' turn-actions' : ''));
  const copy = button('', async () => { await navigator.clipboard.writeText(text); copy.title = t('Message copied'); copy.setAttribute('aria-label', t('Message copied')); }, 'message-copy');
  copy.title = t('Copy message'); copy.setAttribute('aria-label', t('Copy message'));
  copy.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="3"/><path d="M15 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/></svg>';
  actions.append(copy); return actions;
}
function resizeComposer() {
  const input = $('message'); input.style.height = 'auto';
  input.style.height = Math.min(Math.max(input.scrollHeight, 52), 180) + 'px';
  $('send').disabled = sending || rich.uploading || (!input.value.trim() && !attachments.length);
}
async function call(action, payload) {
  const result = await desktop.discussion(action, payload);
  if (!result?.ok) {
    // Older main processes only return this string. A renderer reload cannot
    // load their updated discussion handlers; the app itself must restart.
    const unsupported = result?.code === 'DISCUSSION_ACTION_UNSUPPORTED' || result?.error === 'Unknown discussion action';
    throw Object.assign(new Error(unsupported ? 'This feature is not loaded. Restart Camellia, then try again.'
      : result?.error || 'Discussion request failed.'), { action, code: unsupported ? 'DISCUSSION_ACTION_UNSUPPORTED' : result?.code });
  }
  return result;
}
function rememberDraft() {
  if (!group) return true;
  const draft = { text: $('message').value, selected: [...selected], mode: $('replyMode').value, attachments };
  drafts.set(group.id, draft);
  const identity = group.id + JSON.stringify(attachments.map(file => [file.id, file.path]));
  if (identity !== cleanupReferenceIdentity) {
    cleanupReferenceIdentity = identity;
    void desktop.storageReferencesChanged?.();
  }
  try { localStorage.setItem(draftPrefix + group.id, JSON.stringify(draft)); return true; }
  catch { error(new Error('Could not save the draft on this computer. Keep this page open until you copy or send it.')); return false; }
}
function readDraft(id) {
  if (drafts.has(id)) return drafts.get(id);
  try {
    const draft = JSON.parse(localStorage.getItem(draftPrefix + id));
    if (draft) return { text: typeof draft.text === 'string' ? draft.text : '',
      selected: Array.isArray(draft.selected) ? draft.selected.filter(value => typeof value === 'string') : [],
      mode: draft.mode === 'serial' ? 'serial' : 'parallel', attachments: Array.isArray(draft.attachments) ? draft.attachments : [] };
  } catch { /* A damaged optional draft must not hide persisted discussion history. */ }
  return null;
}
function renderGroups() {
  if (renamingId) return;
  $('groupList').replaceChildren(...groups.map(row => navigation.discussionRow(row, { open: id => load(id).catch(error), actions: openGroupMenu, activeId: group?.id })));
  if (!groups.length) $('groupList').append(node('div', 'ws-empty', t('No discussions. Click + to start.')));
}
function confirmDeleteGroup(row) {
  if (row.active) { error(new Error('Stop all replies before deleting this discussion.')); return; }
  deleteTarget = row.id; $('deleteTitle').textContent = row.title; $('deleteError').textContent = '';
  $('deleteConfirm').disabled = false; $('deleteDialog').showModal(); $('deleteCancel').focus();
}
function closeGroupMenu(restore = false) {
  if (!groupMenu) return;
  const { element, id } = groupMenu; element.remove(); groupMenu = null;
  if (restore) $('groupList').querySelector('[data-group-id="' + id + '"] .session-more')?.focus();
}
function openGroupMenu(anchor, row, position) {
  closeGroupMenu(); row = groups.find(value => value.id === row.id) || row;
  const menu = node('div', 'dsh-pop'); menu.setAttribute('role', 'menu');
  const actions = [
    { label: 'Rename', action: 'rename', run: () => renameGroup(row) },
    { label: row.pinned ? 'Unpin' : 'Pin discussion', action: 'pin', run: async () => {
      const result = await call('pin', { id: row.id, pinned: !row.pinned });
      groups = result.groups; if (group?.id === row.id && result.group.revision >= group.revision) group = result.group; render();
    } },
    { label: 'Delete discussion', action: 'delete', disabled: row.active, run: () => confirmDeleteGroup(row) },
  ];
  for (const action of actions) {
    const item = button('', async () => { closeGroupMenu(); await action.run(); }, 'pop-row' + (action.action === 'delete' ? ' danger' : ''));
    item.append(node('span', '', t(action.label))); item.dataset.action = action.action; item.setAttribute('role', 'menuitem');
    item.disabled = Boolean(action.disabled); item.title = t(action.disabled ? 'Stop all replies before deleting this discussion.' : action.label); menu.append(item);
  }
  menu.onkeydown = event => {
    const items = [...menu.querySelectorAll('button:not(:disabled)')];
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const index = items.indexOf(root.activeElement);
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeGroupMenu(true); }
    if (event.key === 'Tab') closeGroupMenu(true);
  };
  body.append(menu); const rect = anchor.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(position?.x ?? rect.left, innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(position?.y ?? rect.bottom + 4, innerHeight - menu.offsetHeight - 8)) + 'px';
  groupMenu = { element: menu, id: row.id }; menu.querySelector('button')?.focus();
}
function renameGroup(row) {
  if (onRename) { onRename(row); return; }
  const item = $('groupList').querySelector('[data-group-id="' + row.id + '"]'); if (!item) return;
  renamingId = row.id;
  const input = node('input', 'session-rename-input'); input.value = row.title; input.maxLength = 120; input.setAttribute('aria-label', t('Discussion topic'));
  item.querySelector('.session-item-text').replaceChildren(input); input.focus(); input.select();
  let done = false;
  const finish = async save => {
    if (done) return; done = true;
    try {
      if (save && input.value.trim() !== row.title) {
        const result = await call('rename', { id: row.id, title: input.value }); groups = result.groups;
        if (group?.id === row.id && result.group.revision >= group.revision) group = result.group;
      }
    } catch (err) { error(err); }
    finally { renamingId = null; render(); }
  };
  input.onclick = event => event.stopPropagation();
  input.onkeydown = event => { event.stopPropagation(); if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); void finish(event.key === 'Enter'); } };
  input.onblur = () => void finish(true);
}
async function discardGroup(id, nextGroups) {
  const index = groups.findIndex(row => row.id === id); groups = nextGroups;
  drafts.delete(id); try { localStorage.removeItem(draftPrefix + id); } catch { /* optional draft */ }
  if (group?.id === id) {
    ++loading; group = null; selected.clear(); attachments = []; messageNodes.clear(); $('messages').replaceChildren(); $('message').value = '';
    try { localStorage.removeItem(selectedGroupKey); } catch { /* optional selection */ }
    const next = groups[Math.max(0, Math.min(index, groups.length - 1))];
    if (next) await load(next.id);
  }
  render();
}
root.addEventListener('click', event => { if (groupMenu && !groupMenu.element.contains(event.target) && !event.target.closest('.session-more')) closeGroupMenu(); });
$('groupList').addEventListener('scroll', () => closeGroupMenu());
function reason(value) {
  if (['unknown-runtime-policy', 'unverified-connection', 'incomplete-enforcement', 'evidence-mismatch'].includes(value)) return t('This connection is not verified for discussions yet.');
  return t(value || 'The response did not finish. You can retry it explicitly.');
}
function renderMembers() {
  const members = group.participants.filter(p => !p.removed);
  selected = new Set([...selected].filter(id => members.some(p => p.id === id)));
  $('memberCount').textContent = `${members.length} / 4`;
  $('noMembers').hidden = members.length > 0;
  $('recipientRow').hidden = !members.length;
  $('addMember').disabled = members.length >= 4;
  $('connectionNotice').hidden = !members.some(p => !p.capability.available);
  $('connectionNotice').textContent = t(members.some(p => p.verifying || verifyingMembers.has(p.id))
    ? 'Verifying member connections… You can keep writing.' : 'Some members are unavailable. Open Members for details.');
  $('roster').replaceChildren(...members.map(p => {
    const card = node('div', 'member-card'), head = node('div', 'member-head'); card.dataset.memberId = p.id;
    head.append(identityButton(p.id, p.name, p.engine, true));
    const engineName = { claude: 'Claude Code', codex: 'Codex CLI', dsh: 'DeepSeek Harness', kimi: 'Kimi Code', antigravity: 'Antigravity', pi: 'Pi' }[p.engine] || p.engine;
    const model = node('span', 'member-model', `${engineName} · ${p.connection === 'api' ? 'API' : t('Subscription')} · ${p.model}`); model.title = model.textContent;
    const active = group.deliveries.find(d => d.participantId === p.id && openStatuses.has(d.status));
    const verifying = p.verifying || verifyingMembers.has(p.id);
    const verificationError = verificationErrors.get(p.id) || p.verificationError;
    const label = p.recoveryRequired ? 'Recovery needs verification' : verifying ? 'Verifying connection…' : active ? stateLabels[active.phase || active.status] : p.capability.available ? 'Ready' : p.capability.supported === false ? 'Not supported yet' : verificationError && verificationError !== 'Discussion cancelled' ? 'Connection verification failed' : 'Connection not verified';
    const actions = node('div', 'member-actions');
    if (verifying || !p.capability.available && p.capability.canVerify) {
      const verify = button(t(verifying ? 'Cancel verification' : 'Verify connection'), async () => {
        if (verifying) { await call('cancel-member-verification', { id: group.id, participantId: p.id }); return; }
        const id = group.id;
        verifyingMembers.add(p.id); verificationErrors.delete(p.id); renderMembers();
        try {
          const result = await call('verify-member', { id, participantId: p.id });
          if (group?.id === id && result.group.revision >= group.revision) group = result.group; if (result.groups) groups = result.groups; render();
        } catch (err) { verificationErrors.set(p.id, err.message); }
        finally { verifyingMembers.delete(p.id); if (group) renderMembers(); }
      }, 'btn-secondary');
      actions.append(verify);
    }
    if (active) actions.append(button(t('Stop'), () => mutate('stop', { participantId: p.id }), 'btn-secondary danger'));
    actions.append(button(t('Remove'), () => mutate('remove-member', { participantId: p.id })));
    const account = node('span', 'member-account', p.accountLabel); account.title = p.accountLabel;
    card.append(head, model, account, node('span', 'member-state', t(label)), actions);
    if (!p.capability.available && (verificationError || p.capability.detail)) card.append(node('p', 'dialog-note', t(verifying ? p.capability.detail || 'Verifying connection…' : verificationError || p.capability.detail)));
    return card;
  }));
  $('mentions').replaceChildren(...members.map(p => {
    const order = $('replyMode').value === 'serial' && selected.has(p.id) ? String([...selected].indexOf(p.id) + 1) : '';
    const chip = button('', () => {
      if (!selected.has(p.id) && p.capability.supported === false) { $('membersPanel').showModal(); return; }
      selected.has(p.id) ? selected.delete(p.id) : selected.add(p.id); renderMembers(); rememberDraft();
      $('mentions').querySelector('[data-mention-id="' + p.id + '"]')?.focus({ preventScroll: true }); }, 'goal-chip mention');
    chip.append(avatar(p.engine), node('span', 'mention-name', '@' + p.name));
    if (order) chip.append(node('span', 'mention-order', order));
    chip.title = p.name + ' · ' + p.model + (p.verifying ? ' · ' + t('Verifying connection…') : p.capability.available ? '' : ' · ' + t(p.verificationError || p.capability.detail || 'Connection not verified'));
    chip.dataset.mentionId = p.id; chip.setAttribute('aria-pressed', String(selected.has(p.id)));
    chip.disabled = p.removalPending || p.recoveryRequired; return chip;
  }));
  $('sendHint').textContent = selected.size ? t($('replyMode').value === 'serial' ? 'Each member sees the previous reply.' : 'Selected members reply independently.') : t('No mentions: save a note without calling a model.');
  if ([...selected].some(id => members.find(p => p.id === id)?.capability.canVerify)) $('sendHint').textContent = t('The first send checks the selected connections using two short messages, then sends your question.');
  if (group.verifying) $('sendHint').textContent = t(sending ? 'Checking connections before sending… You can stop this check.' : 'Verifying member connections… You can keep writing.');
  else if (selected.size && group.participants.some(p => selected.has(p.id) && p.capability.mode === 'native-tools')) $('sendHint').textContent = t('Tool tasks share this group folder and run one at a time.');
  $('stopAll').disabled = !group.verifying && !group.stopping && !group.deliveries.some(d => openStatuses.has(d.status));
}
function renderMessages() {
  const container = $('messages'), scroll = $('chatScroll'), bottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90;
  const fragment = document.createDocumentFragment();
  const lastByRequest = new Map(group.messages.map(m => [m.requestId, m.id]));
  const anchors = new Map();
  for (const m of group.messages) {
    let item = messageNodes.get(m.id);
    if (!item) {
    const assistant = m.role !== 'user';
    item = node('article', 'message ' + m.role + (assistant ? ' turn' : ' msg-user'));
    const header = node('div', 'message-header turn-meta');
    item.dataset.messageId = m.id;
    if (assistant) header.append(identityButton(m.speakerId, m.speakerName, group.participants.find(p => p.id === m.speakerId)?.engine));
    if (m.role === 'user') {
      const request = group.requests.find(r => r.id === m.requestId);
      const names = [...new Set((request?.deliveryIds || []).map(id => group.deliveries.find(d => d.id === id)?.participantId))]
        .map(id => group.participants.find(p => p.id === id)?.name).filter(Boolean);
      if (names.length) header.append(node('span', '', names.map(name => '@' + name).join(' ')));
    }
    const body = node('div', 'message-body md' + (assistant ? '' : ' bubble'));
    body.append(markdown(m.text));
    if (header.childNodes.length) item.append(header);
    item.append(body, copyAction(m.text, assistant)); messageNodes.set(m.id, item);
    if (m.attachments?.length) { const row = node('div', 'attach-row discussion-message-attachments'); rich.attachments(row, m.attachments); item.append(row); }
    }
    if (m.role === 'assistant') rich.renderTools(item, group.deliveries.find(d => d.id === m.deliveryId));
    fragment.append(item);
    if (lastByRequest.get(m.requestId) === m.id) { const anchor = document.createComment('response'); fragment.append(anchor); anchors.set(m.requestId, anchor); }
  }
  for (const d of group.deliveries.filter(d => d.status !== 'completed' && !d.serialResolution)) {
    const member = group.participants.find(p => p.id === d.participantId), item = node('article', 'message pending turn'); item.dataset.deliveryId = d.id;
    const header = node('div', 'message-header turn-meta');
    header.append(identityButton(d.participantId, member?.name || '', member?.engine), node('span', 'response-status', '· ' + t(stateLabels[d.phase || d.status] || d.status)));
    item.append(header);
    rich.renderTools(item, d);
    if (d.partialText) { const body = node('div', 'message-body md'); body.append(markdown(d.partialText)); item.append(body); }
    if (openStatuses.has(d.status)) {
      if (!d.partialText) { const status = node('div', 'run-status'); status.append(node('span', 'pulse'), node('span', '', t(stateLabels[d.phase || d.status] || d.status))); item.append(status); }
      const actions = node('div', 'response-actions'); actions.append(button(t('Stop'), () => mutate('stop', { deliveryId: d.id }))); item.append(actions);
    }
    if (['failed', 'cancelled', 'interrupted'].includes(d.status)) {
      const unavailable = ['unknown-runtime-policy', 'unverified-connection', 'incomplete-enforcement', 'evidence-mismatch'].includes(d.reason);
      item.append(node('p', 'pending-state', d.status === 'failed' ? reason(unavailable && member?.capability.detail || d.reason || failures.get(d.id)) : t(stateLabels[d.status])));
      const actions = node('div', 'response-actions');
      if (!member?.removed) {
        if (member?.capability.supported === false) actions.append(button(t('View members'), () => $('membersPanel').showModal()));
        else actions.append(button(t('Retry'), () => mutate('retry', { deliveryId: d.id, actionId: crypto.randomUUID() })));
      }
      if (group.requests.find(r => r.id === d.requestId)?.mode === 'serial') actions.append(button(t('Skip'), () => mutate('resolve-serial', { deliveryId: d.id, resolution: 'skip', actionId: crypto.randomUUID() })));
      item.append(actions);
    }
    const anchor = anchors.get(d.requestId);
    if (anchor) anchor.before(item); else fragment.append(item);
  }
  container.replaceChildren(fragment);
  if (bottom) scroll.scrollTop = scroll.scrollHeight;
}
function render() {
  onChange(group?.id || null);
  const empty = !group?.messages.length;
  $('welcome').hidden = !empty; $('welcome').classList.toggle('empty-state', empty);
  $('firstGroup').hidden = Boolean(group); $('groupView').hidden = !group; $('groupActions').hidden = !group;
  $('groupTitle').textContent = group?.title || t('New discussion');
  $('welcomeHint').textContent = t(group ? 'Choose who should reply, then share your first question.' : 'Create a group, add models, and choose who replies to each message.');
  renderGroups();
  updateIdentityState();
  rich.render();
  if (!group) return;
  renderMembers(); renderMessages(); resizeComposer();
}
async function load(id, refresh = false) {
  const ticket = ++loading;
  if (!refresh) rememberDraft();
  const result = await call('load', { id });
  if (ticket !== loading) return;
  if (!refresh) { closeGroupMenu(); setSidebarOpen(false); }
  const changed = group?.id !== id;
  if (!changed && result.group.revision < group.revision) return;
  group = result.group;
  try { localStorage.setItem(selectedGroupKey, id); } catch { /* Selection is optional; discussion data is saved by the service. */ }
  if (changed) {
    messageNodes.clear();
    const draft = readDraft(id); $('message').value = draft?.text || ''; selected = new Set(draft?.selected || []); $('replyMode').value = draft?.mode || 'parallel';
    attachments = draft?.attachments || [];
    clearNotice();
  }
  render();
}
async function mutate(action, payload, throwError = false) {
  if (!group) return;
  const id = group.id;
  try {
    clearNotice(); const result = await call(action, { id, ...payload });
    if (group?.id === id && result.group.revision >= group.revision) group = result.group;
    if (result.groups) groups = result.groups; render();
  } catch (err) { error(err); if (throwError) throw err; }
}
async function catalog() { bindings = (await call('catalog')).bindings; renderProviders(); }
function matchingBindings() { return bindings.filter(row => row.binding.engine === $('engine').value && row.binding.connection === $('connection').value); }
function renderProviders() {
  const subscription = $('connection').querySelector('option[value="subscription"]');
  subscription.hidden = subscription.disabled = !['codex', 'kimi', 'antigravity'].includes($('engine').value);
  if (subscription.disabled && $('connection').value === 'subscription') $('connection').value = 'api';
  const api = $('connection').value === 'api', previous = $('provider').value || selectedProvider;
  $('bindingLabel').textContent = t(api ? 'Model and provider' : 'Model and account');
  $('providerField').hidden = !api; $('providerHint').hidden = !api;
  const providers = new Map(matchingBindings().filter(row => row.providerId).map(row => [row.providerId, row.providerLabel]));
  const all = node('option', '', t('All enabled providers')); all.value = '';
  $('provider').replaceChildren(all, ...[...providers].map(([id, label]) => { const option = node('option', '', label); option.value = id; return option; }));
  if (providers.has(previous)) $('provider').value = previous;
  renderBindings();
}
function renderBindings() {
  const filtered = matchingBindings().filter(row => $('connection').value !== 'api' || !$('provider').value || row.providerId === $('provider').value);
  const previous = $('binding').value;
  $('binding').replaceChildren(...filtered.map(row => {
    const detail = row.binding.connection === 'api' ? row.providerLabel : row.accountLabel;
    const option = node('option', '', row.label + (detail ? ' · ' + detail : '')); option.value = row.id; return option;
  }));
  if (filtered.some(row => row.id === previous)) $('binding').value = previous;
  if (!filtered.length) { const option = node('option', '', t('No configured models')); option.value = ''; $('binding').append(option); }
  bindingChanged();
}
function bindingChanged() {
  const row = bindings.find(row => row.id === $('binding').value);
  $('memberName').value = row?.label || '';
  $('bindingStatus').textContent = !row ? t('Add an API route or sign in to a subscription in Settings, then refresh models.') : row.capability.available ? t('Ready for discussions.') : t(row.capability.canVerify
    ? 'After adding this member, its connection will be checked automatically with two short messages. This uses a small amount of model quota.'
    : row.capability.detail || 'This connection is not verified for discussions yet.');
  $('verifyBinding').hidden = !row?.capability.canVerify;
  $('saveMember').disabled = !row || row.capability.supported === false || Boolean(verifyingBinding);
}
function newGroup() { $('title').value = ''; $('createError').textContent = ''; $('groupDialog').showModal(); $('title').focus(); }
$('home').onclick = () => desktop.switchMode('home'); $('settings').onclick = () => desktop.openSettingsWindow();
$('newGroup').onclick = newGroup; $('firstGroup').onclick = newGroup;
$('deleteConfirm').onclick = async () => {
  const id = deleteTarget; if (!id || $('deleteConfirm').disabled) return;
  $('deleteConfirm').disabled = true; $('deleteError').textContent = '';
  try { const result = await call('delete', { id }); $('deleteDialog').close(); await discardGroup(id, result.groups); }
  catch (err) { $('deleteError').textContent = t(err.message); }
  finally { $('deleteConfirm').disabled = false; }
};
$('deleteDialog').addEventListener('close', () => { const id = deleteTarget; deleteTarget = null; $('groupList').querySelector('[data-group-id="' + id + '"]')?.focus(); });
$('membersToggle').onclick = () => $('membersPanel').showModal();
for (const el of root.querySelectorAll('[data-close]')) el.onclick = () => $(el.dataset.close).close();
$('createForm').onsubmit = async event => {
  event.preventDefault();
  const submit = event.currentTarget.querySelector('[type=submit]'); if (submit.disabled) return; submit.disabled = true;
  try { const result = await call('create', { title: $('title').value }); $('groupDialog').close(); groups = (await call('list')).groups; await load(result.group.id); }
  catch (err) { if ($('groupDialog').open) $('createError').textContent = t(err.message); else error(err); }
  finally { submit.disabled = false; }
};
$('addMember').onclick = async () => { try { await catalog(); $('memberIdentityPrompt').value = ''; $('memberDialog').showModal(); } catch (err) { error(err); } };
$('engine').onchange = renderProviders; $('connection').onchange = renderProviders;
$('provider').onchange = () => { selectedProvider = $('provider').value; renderBindings(); }; $('binding').onchange = bindingChanged;
$('refreshModels').onclick = () => catalog().catch(error);
$('verifyBinding').onclick = async () => {
  if (verifyingBinding) { await call('cancel-verification', { bindingId: verifyingBinding }); return; }
  const bindingId = $('binding').value;
  verifyingBinding = bindingId; $('verifyBinding').textContent = t('Cancel verification'); $('bindingStatus').textContent = t('Verifying connection…');
  for (const id of ['engine', 'connection', 'provider', 'binding', 'refreshModels', 'saveMember']) $(id).disabled = true;
  try { const result = await call('verify-binding', { bindingId }); bindings = result.bindings; renderProviders(); if (group) await load(group.id, true); }
  catch (err) { $('bindingStatus').textContent = t(err.message); }
  finally {
    verifyingBinding = null; $('verifyBinding').textContent = t('Verify connection');
    for (const id of ['engine', 'connection', 'provider', 'binding', 'refreshModels']) $(id).disabled = false;
    $('saveMember').disabled = !bindings.some(row => row.id === $('binding').value && row.capability.supported !== false);
  }
};
$('memberDialog').addEventListener('close', () => { if (verifyingBinding) void call('cancel-verification', { bindingId: verifyingBinding }).catch(error); });
$('memberForm').onsubmit = async event => {
  event.preventDefault(); const id = group.id; $('saveMember').disabled = true;
  try { const result = await call('add-member', { id, name: $('memberName').value, bindingId: $('binding').value, identityPrompt: $('memberIdentityPrompt').value });
    if (group?.id === id) group = result.group; if (result.groups) groups = result.groups; $('memberDialog').close(); render(); }
  catch (err) { $('bindingStatus').textContent = t(err.message); }
  finally { $('saveMember').disabled = !bindings.some(row => row.id === $('binding').value && row.capability.supported !== false); }
};
$('identityForm').onsubmit = async event => {
  event.preventDefault(); if (!identityTarget || $('saveIdentity').disabled) return;
  const target = identityTarget; identitySaving = true; $('identityError').textContent = ''; updateIdentityState();
  try {
    const result = await call('set-identity', { id: target.groupId, participantId: target.memberId, identityPrompt: $('identityPrompt').value });
    if (group?.id === target.groupId && result.group.revision >= group.revision) group = result.group;
    if (result.groups) groups = result.groups;
    $('identityDialog').close(); render();
  } catch (err) { $('identityError').textContent = t(err.message); }
  finally { identitySaving = false; updateIdentityState(); }
};
$('identityDialog').addEventListener('cancel', event => { if (identitySaving) event.preventDefault(); });
$('identityDialog').addEventListener('close', () => {
  // The close event is queued; the user may already have reopened the editor.
  if ($('identityDialog').open) return;
  identityTarget = null;
  if (identityReturnFocus?.isConnected) identityReturnFocus.focus({ preventScroll: true });
  identityReturnFocus = null;
});
$('stopAll').onclick = () => mutate('stop', {}); $('replyMode').onchange = () => { if (group) { renderMembers(); rememberDraft(); } };
$('composer').onsubmit = async event => {
  event.preventDefault(); if (sending || rich.uploading || !group || (!$('message').value.trim() && !attachments.length)) return;
  const id = group.id, text = $('message').value, participantIds = [...selected], sentAttachments = [...attachments];
  sending = true; resizeComposer(); clearNotice();
  try { const result = await call('send', { id, requestId: crypto.randomUUID(), text, participantIds, mode: $('replyMode').value, attachments: sentAttachments });
    drafts.delete(id);
    try { localStorage.removeItem(draftPrefix + id); }
    catch { error(new Error('Could not save the draft on this computer. Keep this page open until you copy or send it.')); }
    if (group?.id === id) { group = result.group; if ($('message').value === text) $('message').value = ''; attachments = attachments.filter(file => !sentAttachments.some(sent => sent.id === file.id)); rememberDraft(); }
    if (result.groups) groups = result.groups; render(); }
  catch (err) { error(err); }
  finally { sending = false; resizeComposer(); }
};
$('message').addEventListener('input', () => { resizeComposer(); rememberDraft(); });
$('message').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); } };
const unsubscribe = desktop.onDiscussionEvent(event => {
  if (event.reason) failures.set(event.deliveryId, event.reason);
  if (!isVisible() || navigating) return;
  clearTimeout(refreshTimer); refreshTimer = setTimeout(async () => {
    if (!isVisible() || navigating) return;
    try {
      const next = (await call('list')).groups;
      if (group && !next.some(row => row.id === group.id)) await discardGroup(group.id, next);
      else { groups = next; if (group) await load(group.id, true); else renderGroups(); }
    }
    catch (err) { error(err); }
  }, 60);
});
function setSidebarOpen(open) {
  body.classList.toggle('sidebar-open', open); $('sidebarBackdrop').hidden = !open;
  $('sidebarToggle').setAttribute('aria-expanded', String(open));
  // Prevent keyboard focus entering the narrow-window drawer while closed.
  $('sidebar').inert = innerWidth <= 680 && !open;
}
$('sidebarToggle').onclick = () => { setSidebarOpen(!body.classList.contains('sidebar-open')); if (body.classList.contains('sidebar-open')) $('newGroup').focus(); };
$('sidebarBackdrop').onclick = () => { setSidebarOpen(false); $('sidebarToggle').focus(); };
root.addEventListener('keydown', event => {
  if (!isVisible()) return;
  if (event.key === 'Escape' && body.classList.contains('sidebar-open') && !root.querySelector('dialog[open]')) { setSidebarOpen(false); $('sidebarToggle').focus(); }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'h') { event.preventDefault(); void desktop.switchMode('home'); }
});
let preferredSidebarWidth = null, sidebarDrag = null;
try { const width = JSON.parse(localStorage.getItem('camellia-chat-sidebar-width')); if (Number.isFinite(width) && width > 0) preferredSidebarWidth = width; } catch { /* optional preference */ }
function sidebarBounds() { return { min: 210, max: Math.max(210, Math.min(520, innerWidth - (innerWidth > 800 ? 540 : 320))) }; }
function updateSidebarWidth(width = preferredSidebarWidth) {
  const { min, max } = sidebarBounds();
  if (width === null) width = innerWidth <= 800 ? 210 : 260;
  const value = Math.round(Math.max(min, Math.min(max, width)));
  $('sidebar').style.setProperty('--sidebar-width', value + 'px');
  for (const [key, number] of Object.entries({ min, max, now: value })) $('sidebarResize').setAttribute('aria-value' + key, number);
  return value;
}
function saveSidebarWidth() { try { localStorage.setItem('camellia-chat-sidebar-width', JSON.stringify(preferredSidebarWidth)); } catch { /* optional preference */ } }
function finishSidebarResize() {
  if (!sidebarDrag) return;
  const { pointerId } = sidebarDrag; sidebarDrag = null; document.body.classList.remove('resizing-sidebar');
  if ($('sidebarResize').hasPointerCapture(pointerId)) $('sidebarResize').releasePointerCapture(pointerId);
  saveSidebarWidth();
}
$('sidebarResize').onpointerdown = event => {
  if (event.button !== 0 || !event.isPrimary || sidebarDrag) return;
  event.preventDefault(); sidebarDrag = { pointerId: event.pointerId, x: event.clientX, width: $('sidebar').getBoundingClientRect().width };
  $('sidebarResize').setPointerCapture(event.pointerId); $('sidebarResize').focus(); document.body.classList.add('resizing-sidebar');
};
$('sidebarResize').onpointermove = event => { if (sidebarDrag?.pointerId === event.pointerId) preferredSidebarWidth = updateSidebarWidth(sidebarDrag.width + event.clientX - sidebarDrag.x); };
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) $('sidebarResize').addEventListener(event, finishSidebarResize);
$('sidebarResize').onkeydown = event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault(); const bounds = sidebarBounds(), step = event.shiftKey ? 50 : 10;
  preferredSidebarWidth = updateSidebarWidth(event.key === 'Home' ? bounds.min : event.key === 'End' ? bounds.max
    : $('sidebar').getBoundingClientRect().width + (event.key === 'ArrowRight' ? step : -step)); saveSidebarWidth();
};
window.addEventListener('blur', finishSidebarResize);
window.addEventListener('resize', () => { closeGroupMenu(); finishSidebarResize(); updateSidebarWidth(); setSidebarOpen(false); resizeComposer(); });
updateSidebarWidth(); setSidebarOpen(false);
function applyContentWidth(value) {
  document.documentElement.style.setProperty('--content-width', ({ standard: '768px', wide: '1080px', full: 'none' })[value] || '768px');
  try { localStorage.setItem('camellia-chat-content-width', JSON.stringify(value)); } catch { /* optional preference */ }
  resizeComposer();
}
try { applyContentWidth(JSON.parse(localStorage.getItem('camellia-chat-content-width'))); } catch { /* use CSS default */ }
const unsubscribeWidth = desktop.onChatContentWidthChanged?.(applyContentWidth);
void desktop.workbenchSettings().then(settings => { if (settings?.ok) applyContentWidth(settings.chatContentWidth); }).catch(error);
window.addEventListener('beforeunload', () => { discussionReferenceSources.delete(cleanupReferences); conversationNavigation?.destroy(); rememberDraft(); unsubscribe?.(); unsubscribeWidth?.(); clearTimeout(refreshTimer); });
window.addEventListener('camellia:language', () => { closeGroupMenu(); messageNodes.clear(); render(); if ($('memberDialog').open) renderProviders(); });
const ready = (async () => {
  await window.CamelliaI18n.ready;
  if (!embedded) {
    conversationNavigation = navigation.conversations({ container: $('conversationNavigation'), beforeNavigate: () => {
      if (sending || rich.uploading) return false;
      return rememberDraft();
    }, error });
    $('newSessionBtn').onclick = () => conversationNavigation.create();
  }
})();
async function open({ id, group: requestedGroup, intent } = {}) {
  const request = ++navigationRequest;
  navigating = true;
  try {
    await ready;
    const requested = id || requestedGroup;
    let previous; try { previous = localStorage.getItem(selectedGroupKey); } catch { /* storage may be unavailable */ }
    const snapshot = (await call('list')).groups;
    if (request !== navigationRequest) return;
    groups = snapshot;
    if (requested && !groups.some(row => row.id === requested)) throw new Error('Discussion not found');
    if (groups.length) await load(requested || groups.find(row => row.id === previous)?.id || groups[0].id); else render();
    if (request !== navigationRequest) return;
    pendingNavigationIntent = () => {
      if (intent === 'create') newGroup();
      if (requested && ['rename', 'delete'].includes(intent)) {
        if ($('groupList').hidden) $('discussionNavigation').querySelector('.nav-section-toggle').click();
        const row = groups.find(row => row.id === requested);
        if (intent === 'rename') renameGroup(row); else confirmDeleteGroup(row);
      }
    };
    if (isVisible()) activate();
  } finally { if (request === navigationRequest) navigating = false; }
}
function activate() {
  render();
  const intent = pendingNavigationIntent; pendingNavigationIntent = null;
  intent?.();
}
function suspend() {
  if (sending || rich.uploading || !rememberDraft()) return false;
  ++navigationRequest; ++loading;
  navigating = false;
  pendingNavigationIntent = null;
  rich.suspend(); closeGroupMenu();
  root.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  return true;
}
if (!embedded) {
  const query = new URLSearchParams(location.search);
  void open({ group: query.get('group'), intent: query.get('intent') }).then(() => {
    if (query.has('group') || query.has('intent')) history.replaceState(null, '', location.pathname);
  }).catch(error);
}
return { ready, open, suspend, activate, error, get groupId() { return group?.id || null; } };
} };
if (document.body.classList.contains('discussion-workbench')) window.CamelliaDiscussions.create();
