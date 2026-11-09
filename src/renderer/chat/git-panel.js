'use strict';

window.CamelliaGitPanel = { create({ context, getCwd, setStatus, fileViewer, closeFilePreview, openPreviewExternally, revealFile,
  updatePreviewWidth, openActionMenu, closeWorkPanel, onUpdate }) {
  const $ = id => document.getElementById(id);
  const t = value => window.CamelliaI18n.t(value);
  const el = (tag, className = '', text) => { const node = document.createElement(tag); node.className = className; if (text != null) node.textContent = text; return node; };
  let status = null, repositoryError = null, operationError = '', notice = '', loading = false, busy = '', loadedCwd = '';
  let open = false, selected = null, diff = null, diffLoading = false, statusTicket = 0, diffTicket = 0, actionTicket = 0, directoryTicket = 0;
  let commitMessage = '', commitFocusPending = false, wrapDiff = false, lastStatusAt = 0;
  let directoryFiles = null, directoryParent = '', directoryLoading = '', directoryError = '';
  const diffScroll = new Map(), diffCache = new Map();

  function commandButton(label, run, className = 'work-action', focus) {
    const node = el('button', className, t(label)); node.type = 'button'; node.disabled = Boolean(busy);
    node.dataset.gitCommand = 'true'; if (focus) node.dataset.workFocus = focus;
    node.onclick = event => { event.stopPropagation(); void run(); }; return node;
  }
  function statsNodes(target, stats, className = '') {
    const wrap = el('span', 'git-stats ' + className);
    if (Number.isFinite(stats?.additions)) wrap.append(el('span', 'git-additions', '+' + stats.additions));
    if (Number.isFinite(stats?.deletions)) wrap.append(el('span', 'git-deletions', '−' + stats.deletions));
    target.append(wrap); return wrap;
  }
  function entries(scope) {
    if (!status) return [];
    return status.files.flatMap(file => {
      if (scope === 'staged' && file.staged) return [{ file, scope: 'staged', key: 'staged:' + file.path }];
      if (scope === 'unstaged' && file.unstaged) {
        const actualScope = file.untracked ? 'untracked' : 'unstaged';
        return [{ file, scope: actualScope, key: actualScope + ':' + file.path }];
      }
      return [];
    });
  }
  function allEntries() { return [...entries('unstaged'), ...entries('staged')]; }
  function selectedEntry() {
    const nested = directoryFiles?.files.find(file => 'untracked:' + file.path === selected);
    if (nested) return { file: nested, scope: 'untracked', key: 'untracked:' + nested.path };
    return allEntries().find(entry => entry.key === selected) || null;
  }
  function ensureSelection() {
    if (selectedEntry()) return;
    selected = allEntries()[0]?.key || null;
  }
  function entryStats(entry) {
    return entry.scope === 'staged' ? entry.file.stagedStats : entry.scope === 'untracked' ? entry.file.stats : entry.file.unstagedStats;
  }
  function absolutePath(filePath) {
    if (!status) return filePath;
    const root = status.root.replace(/[\\/]+$/, '');
    return root + (root.includes('\\') ? '\\' : '/') + String(filePath).split('/').join(root.includes('\\') ? '\\' : '/');
  }
  function branchLabel() {
    if (!status) return '';
    return status.branch + (status.upstream ? ' ↔ ' + status.upstream : '') +
      (status.ahead ? ' ↑' + status.ahead : '') + (status.behind ? ' ↓' + status.behind : '');
  }

  async function refresh(force = false) {
    const cwd = getCwd();
    if (!force && status && cwd === loadedCwd && Date.now() - lastStatusAt < 2000) {
      onUpdate(); renderViewer();
      if (open && selectedEntry() && !selectedEntry().file.directory) await loadDiff();
      return;
    }
    const ticket = ++statusTicket;
    if (!cwd) {
      status = null; repositoryError = null; loadedCwd = ''; loading = false; lastStatusAt = 0; onUpdate(); renderViewer(); return;
    }
    if (cwd !== loadedCwd) {
      loadedCwd = cwd; status = null; repositoryError = null; operationError = ''; notice = ''; selected = null; diff = null; commitMessage = '';
      lastStatusAt = 0; diffCache.clear(); directoryFiles = null; directoryParent = ''; directoryError = '';
    }
    loading = true; onUpdate(); renderViewer();
    let result;
    try {
      if (!window.dshDesktop.gitStatus) throw new Error(t('Git status is unavailable.'));
      result = await window.dshDesktop.gitStatus({ cwd });
    } catch (error) { result = { ok: false, error: error.message }; }
    if (ticket !== statusTicket || cwd !== getCwd()) return;
    loading = false;
    if (!result.ok) {
      status = null; repositoryError = { message: result.error || t('Could not read Git status.'), code: result.code };
    } else {
      status = result.status; repositoryError = null; lastStatusAt = Date.now(); diffCache.clear();
      directoryTicket++; directoryFiles = null; directoryParent = ''; directoryLoading = ''; directoryError = '';
      ensureSelection();
    }
    onUpdate(); renderViewer();
    if (open && selectedEntry() && !selectedEntry().file.directory) await loadDiff(true);
  }

  async function loadDiff(force = false) {
    const entry = selectedEntry();
    if (!entry || !open || entry.file.directory) { diff = null; renderViewer(); return; }
    const ticket = ++diffTicket, cwd = status.root, key = entry.key;
    const cached = diffCache.get(key);
    diff = cached?.value || null;
    diffLoading = force || !cached || Date.now() - cached.at >= 2000;
    renderViewer();
    if (!diffLoading) return;
    let result;
    try { result = await window.dshDesktop.gitDiff({ cwd, filePath: entry.file.path, scope: entry.scope }); }
    catch (error) { result = { ok: false, error: error.message }; }
    if (ticket !== diffTicket || !open || selected !== key) return;
    diffLoading = false;
    if (!result.ok) { diff = { error: result.error || t('Could not load the diff.') }; }
    else {
      diff = result.diff;
      diffCache.set(key, { value: diff, at: Date.now() });
    }
    renderViewer();
  }

  async function loadDirectory() {
    const entry = selectedEntry();
    if (!entry?.file.directory) return;
    const cwd = status.root, filePath = entry.file.path, ticket = ++directoryTicket;
    directoryParent = filePath; directoryLoading = filePath; directoryError = ''; directoryFiles = null; renderViewer();
    let result;
    try { result = await window.dshDesktop.gitUntracked({ cwd, filePath, limit: 200 }); }
    catch (error) { result = { ok: false, error: error.message }; }
    if (ticket !== directoryTicket || directoryParent !== filePath || selected !== 'untracked:' + filePath) return;
    directoryLoading = '';
    if (!result.ok) directoryError = result.error || t('Could not load untracked files.');
    else directoryFiles = result.result;
    renderViewer();
  }

  async function runAction(action, payload = {}) {
    if (busy || !status) return false;
    const ticket = ++actionTicket, cwd = status.root, conversationCwd = loadedCwd, previousMessage = commitMessage;
    busy = action; operationError = ''; notice = ''; onUpdate(); renderViewer();
    try {
      const result = await window.dshDesktop.gitAction({ cwd, action, ...payload });
      if (!result.ok) throw new Error(result.error || t('The Git operation failed.'));
      if (ticket !== actionTicket || loadedCwd !== conversationCwd) return false;
      if (action === 'commit') {
        if (commitMessage === previousMessage) commitMessage = '';
        notice = t('Created commit {0}').replace('{0}', result.hash || '');
      } else if (action === 'push') notice = t('Pushed commits to the remote.');
      else if (action === 'fetch') notice = t('Fetched remote updates.');
      else if (action === 'pull') notice = t('Pulled remote changes.');
      if ((action === 'stage' || action === 'unstage') && selectedEntry()) {
        selected = (action === 'stage' ? 'staged:' : selectedEntry().scope === 'untracked' ? 'untracked:' : 'unstaged:') + selectedEntry().file.path;
      }
      await refresh(true);
      if (notice) setStatus(notice);
      return true;
    } catch (error) {
      if (ticket === actionTicket) { operationError = error.message; setStatus(error.message); }
      return false;
    } finally {
      if (ticket === actionTicket) { busy = ''; onUpdate(); renderViewer(); }
    }
  }

  function dialog({ title, body, confirmLabel, remotes }) {
    return new Promise(resolve => {
      const modal = el('dialog', 'git-confirm-dialog'), form = el('form', 'git-confirm-form');
      form.append(el('h2', '', t(title)), el('p', 'git-confirm-body', body));
      let select = null;
      if (remotes) {
        select = el('select', 'git-remote-select'); select.setAttribute('aria-label', t('Remote'));
        for (const remote of remotes) select.append(new Option(remote, remote));
        form.append(el('label', 'git-remote-label', t('Remote'))); form.lastChild.append(select);
      }
      const actions = el('div', 'git-confirm-actions');
      const cancel = el('button', 'work-action', t('Cancel')); cancel.type = 'button';
      const confirm = el('button', 'work-action work-primary', t(confirmLabel)); confirm.type = 'submit';
      actions.append(cancel, confirm); form.append(actions); modal.append(form); document.body.append(modal);
      cancel.onclick = () => modal.close('');
      form.onsubmit = event => { event.preventDefault(); modal.close(select ? select.value : 'confirmed'); };
      modal.oncancel = () => { modal.returnValue = ''; };
      modal.onclose = () => { const value = modal.returnValue; modal.remove(); resolve(value || null); };
      modal.showModal(); (select || confirm).focus();
    });
  }

  async function push() {
    if (!status || busy) return;
    let payload = {};
    if (status.upstream) {
      const body = t('{0} → {1}').replace('{0}', status.branch).replace('{1}', status.upstream) + '\n' +
        t('{0} commit(s) will be pushed.').replace('{0}', status.ahead);
      if (!await dialog({ title: 'Push commits', body, confirmLabel: 'Push' })) return;
    } else {
      if (!status.remotes.length) { operationError = t('No Git remote is configured.'); renderViewer(); onUpdate(); return; }
      const remote = await dialog({ title: 'Publish branch', body: t('Choose a remote for {0}.').replace('{0}', status.branch),
        confirmLabel: 'Publish branch', remotes: status.remotes });
      if (!remote) return;
      payload = { setUpstream: true, remote };
    }
    await runAction('push', payload);
  }

  async function pull() {
    if (!status?.upstream || busy) return;
    const body = t('Fast-forward {0} from {1}.').replace('{0}', status.branch).replace('{1}', status.upstream) + '\n' +
      t('The pull stops if the branches have diverged.');
    if (await dialog({ title: 'Pull changes', body, confirmLabel: 'Pull' })) await runAction('pull');
  }

  function more(anchor) {
    if (!status) return;
    openActionMenu(anchor, [
      { label: 'Changes', run: () => openChanges() },
      { label: 'Commit', disabled: Boolean(busy) || !status.files.length, run: () => openCommit() },
      { label: status.upstream ? 'Push' : 'Publish branch', disabled: Boolean(busy) || !status.hasHead || status.detached, run: () => void push() },
      { label: 'Fetch', disabled: Boolean(busy) || !status.remotes.length, run: () => void runAction('fetch') },
      { label: 'Pull (fast-forward only)', disabled: Boolean(busy) || !status.upstream, run: () => void pull() },
      { label: 'Refresh Git status', disabled: Boolean(busy), run: () => void refresh(true) },
      { label: 'Open in VS Code', run: async () => {
        const result = await window.dshDesktop.openInVSCode(status.root);
        if (!result.ok) setStatus(result.error || t('Could not open the workspace in VS Code.'));
      } },
      { label: 'Show in folder', run: () => void revealFile(status.root) },
    ]);
  }

  function renderSummary(group) {
    const cwd = getCwd(); group.hidden = !cwd;
    if (!cwd) return;
    if (repositoryError) {
      const message = repositoryError.code === 'NOT_REPOSITORY' ? t('This folder is not a Git repository.') : repositoryError.message;
      const error = el('p', 'work-empty git-summary-message', message); error.title = repositoryError.message; group.append(error);
      group.append(commandButton('Retry', () => refresh(true), 'work-action')); return;
    }
    if (!status) { group.append(el('p', 'work-empty git-summary-message', loading ? t('Loading Git status…') : t('Refresh to read Git status.'))); return; }
    const row = el('div', 'git-change-row'), openButton = el('button', 'git-change-open');
    openButton.type = 'button'; openButton.dataset.workFocus = 'git:changes'; openButton.disabled = Boolean(busy);
    const changeIcon = el('span', 'git-change-icon');
    changeIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v5h5M10 12h5M12.5 9.5v5"/></svg>';
    openButton.append(changeIcon, el('span', 'git-change-label', t('{0} changed item(s)').replace('{0}', status.files.length)));
    statsNodes(openButton, status);
    if (status.statsTruncated) {
      const partial = el('span', 'git-stats-partial', '…'); partial.title = t('Line counts exclude collapsed untracked folders.'); openButton.append(partial);
    }
    openButton.onclick = () => openChanges(); row.append(openButton);
    const menuButton = commandButton('', () => more(menuButton), 'git-change-menu', 'git:menu');
    menuButton.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10M18 7c0 5-12 5-12 10"/></svg>';
    menuButton.title = branchLabel() || t('Git actions'); menuButton.setAttribute('aria-label', t('Git actions'));
    row.append(menuButton); group.append(row);
    if (!status.files.length) group.append(el('p', 'work-empty git-summary-message', t('Working tree clean')));
    if (operationError) group.append(el('p', 'git-summary-error', operationError));
    if (notice) group.append(el('p', 'git-summary-notice', notice));
  }

  function selectEntry(entry) {
    if (selected === entry.key) return;
    selected = entry.key; diff = null;
    if (entry.file.directory) {
      directoryTicket++;
      if (directoryParent !== entry.file.path) directoryFiles = null;
      directoryParent = entry.file.path; directoryError = ''; renderViewer(); return;
    }
    const nested = directoryFiles?.files.some(file => file.path === entry.file.path);
    if (!nested) { directoryTicket++; directoryFiles = null; directoryParent = ''; }
    void loadDiff();
  }

  function fileRow(entry) {
    const row = el('div', 'git-file-row' + (selected === entry.key ? ' is-selected' : ''));
    const select = el('button', 'git-file-select'); select.type = 'button'; select.dataset.gitFocus = 'file:' + entry.key;
    select.dataset.gitPath = entry.file.path; select.dataset.gitScope = entry.scope;
    select.onclick = () => selectEntry(entry);
    const label = el('span', 'git-file-label');
    label.append(el('span', 'git-file-status git-status-' + entry.file.status.toLowerCase(), entry.file.status));
    const name = el('span', 'git-file-path' + (entry.file.directory ? ' git-directory-path' : ''), entry.file.path);
    name.title = entry.file.oldPath ? entry.file.oldPath + ' → ' + entry.file.path : entry.file.path;
    label.append(name); select.append(label); statsNodes(select, entryStats(entry)); row.append(select);
    const stage = commandButton(entry.scope === 'staged' ? '−' : '+', () => runAction(entry.scope === 'staged' ? 'unstage' : 'stage', { paths: [entry.file.path] }), 'git-stage-button');
    stage.title = t(entry.scope === 'staged' ? 'Unstage file' : 'Stage file'); stage.setAttribute('aria-label', stage.title + ': ' + entry.file.path);
    row.append(stage); return row;
  }

  function fileGroup(title, items, stageAll) {
    const section = el('section', 'git-file-group'), heading = el('div', 'git-file-group-heading');
    heading.append(el('strong', '', t(title)), el('span', 'git-group-count', String(items.length)));
    if (items.length) {
      const all = commandButton(stageAll ? 'Stage all' : 'Unstage all', () => runAction(stageAll ? 'stage' : 'unstage', { paths: items.map(entry => entry.file.path) }), 'git-group-action');
      heading.append(all);
    }
    section.append(heading);
    if (!items.length) section.append(el('p', 'git-empty-files', t('No files in this group.')));
    for (const entry of items.slice(0, 300)) section.append(fileRow(entry));
    if (items.length > 300) section.append(el('p', 'git-empty-files', t('Showing the first {0} of {1} entries.').replace('{0}', 300).replace('{1}', items.length)));
    return section;
  }

  function languageFor(filePath) {
    const extension = String(filePath).split('.').pop().toLowerCase();
    return { js: 'javascript', cjs: 'javascript', mjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
      json: 'json', css: 'css', html: 'xml', htm: 'xml', xml: 'xml', md: 'markdown', py: 'python', sh: 'bash', bash: 'bash',
      yml: 'yaml', yaml: 'yaml', java: 'java', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', go: 'go', rs: 'rust', rb: 'ruby', php: 'php', sql: 'sql' }[extension] || extension;
  }

  function appendDiff(body, entry) {
    const scroll = el('div', 'git-diff' + (wrapDiff ? ' is-wrapped' : '')); scroll.dataset.gitDiff = entry.key;
    if (diffLoading && !diff) { scroll.append(el('p', 'git-diff-empty', t('Loading diff…'))); body.append(scroll); return; }
    if (diff?.error) { scroll.append(el('p', 'git-diff-error', diff.error)); body.append(scroll); return; }
    if (!diff) { scroll.append(el('p', 'git-diff-empty', t('Loading diff…'))); body.append(scroll); return; }
    if (diff.binary) { scroll.append(el('p', 'git-diff-empty', t('Binary file diff is not available.'))); body.append(scroll); return; }
    if (!diff.patch.trim()) { scroll.append(el('p', 'git-diff-empty', t('No changes in this view.'))); body.append(scroll); return; }
    let oldLine = 0, newLine = 0, rendered = 0, truncatedByView = false;
    const language = languageFor(entry.file.path);
    for (const line of diff.patch.split(/\r?\n/)) {
      if (rendered >= 4000) { truncatedByView = true; break; }
      if (line.startsWith('@@')) {
        const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (!match) continue;
        oldLine = Number(match[1]); newLine = Number(match[2]);
        scroll.append(el('div', 'git-diff-hunk', line)); rendered++; continue;
      }
      if (!oldLine && !newLine) continue;
      const type = line[0], oldNumber = oldLine, newNumber = newLine;
      let className = 'context';
      if (type === '+') { className = 'addition'; newLine++; }
      else if (type === '-') { className = 'deletion'; oldLine++; }
      else if (type === '\\') { scroll.append(el('div', 'git-diff-no-newline', line)); continue; }
      else if (type === ' ') { oldLine++; newLine++; }
      else continue;
      const row = el('div', 'git-diff-line git-diff-' + className);
      row.append(el('span', 'git-old-line', className === 'addition' ? '' : String(oldNumber)));
      row.append(el('span', 'git-new-line', className === 'deletion' ? '' : String(newNumber)));
      row.append(el('span', 'git-diff-sign', type));
      const code = el('code', 'git-diff-code');
      code.innerHTML = window.CamelliaMarkdownPreview.highlight(language, line.slice(1));
      row.append(code); scroll.append(row); rendered++;
    }
    if (diff.truncated || truncatedByView) scroll.append(el('p', 'git-diff-notice', t('The diff is too large to display completely.')));
    body.append(scroll);
    scroll.scrollTop = diffScroll.get(entry.key) || 0;
    scroll.onscroll = () => diffScroll.set(entry.key, scroll.scrollTop);
  }

  function appendDirectory(body, entry) {
    const filePath = entry.file.path, content = el('div', 'git-directory-content');
    if (directoryLoading === filePath) content.append(el('p', 'git-diff-empty', t('Loading untracked files…')));
    else if (directoryError && directoryParent === filePath) {
      content.append(el('p', 'git-diff-error', directoryError), commandButton('Retry', loadDirectory, 'work-action'));
    } else if (!directoryFiles || directoryParent !== filePath) {
      content.append(el('p', 'git-diff-empty', t('Untracked folders are loaded on demand.')));
      content.append(commandButton('Load files', loadDirectory, 'work-action'));
    } else {
      content.append(el('div', 'git-directory-heading', t('{0} untracked file(s)').replace('{0}', directoryFiles.total)));
      const list = el('div', 'git-directory-files');
      if (!directoryFiles.files.length) list.append(el('p', 'git-empty-files', t('No untracked files in this folder.')));
      for (const file of directoryFiles.files) list.append(fileRow({ file, scope: 'untracked', key: 'untracked:' + file.path }));
      content.append(list);
      if (directoryFiles.truncated) content.append(el('p', 'git-diff-notice', t('Showing the first {0} of {1} entries.').replace('{0}', directoryFiles.files.length).replace('{1}', directoryFiles.total)));
    }
    body.append(content);
  }

  function renderDetail(entry) {
    const detail = el('section', 'git-detail');
    if (!entry) { detail.append(el('p', 'git-diff-empty', t('Select a changed file to view its diff.'))); return detail; }
    const toolbar = el('div', 'git-detail-toolbar');
    const title = el('span', 'git-detail-path', entry.file.path); title.title = entry.file.path; toolbar.append(title);
    statsNodes(toolbar, entryStats(entry));
    if (!entry.file.directory) {
      const wrap = commandButton(wrapDiff ? 'No wrap' : 'Wrap', () => { wrapDiff = !wrapDiff; renderViewer(); }, 'git-icon-text-button');
      wrap.dataset.gitFocus = 'wrap'; toolbar.append(wrap);
    }
    const external = commandButton('↗', async () => {
      const result = await openPreviewExternally(absolutePath(entry.file.path)); if (result && !result.ok) setStatus(result.error);
    }, 'git-icon-button'); external.title = t('Open with system app'); external.setAttribute('aria-label', external.title); toolbar.append(external);
    const reveal = commandButton('⌂', () => revealFile(absolutePath(entry.file.path)), 'git-icon-button');
    reveal.title = t('Show in folder'); reveal.setAttribute('aria-label', reveal.title); toolbar.append(reveal);
    detail.append(toolbar);
    if (entry.file.directory) appendDirectory(detail, entry); else appendDiff(detail, entry);
    return detail;
  }

  function renderCommit() {
    const staged = entries('staged'), form = el('form', 'git-commit-form');
    const input = el('input', 'git-commit-input'); input.type = 'text'; input.maxLength = 10000; input.value = commitMessage;
    input.placeholder = t('Commit message'); input.setAttribute('aria-label', t('Commit message')); input.dataset.gitFocus = 'commit-message';
    const submit = commandButton('Commit staged', () => {}, 'work-action work-primary'); submit.type = 'submit';
    submit.disabled = Boolean(busy) || !staged.length || !commitMessage.trim();
    input.oninput = () => { commitMessage = input.value; submit.disabled = Boolean(busy) || !staged.length || !commitMessage.trim(); };
    form.onsubmit = event => { event.preventDefault(); if (commitMessage.trim() && staged.length) void runAction('commit', { message: commitMessage }); };
    const pushButton = commandButton(status.upstream ? 'Push' : 'Publish branch', push, 'work-action git-push-button');
    pushButton.disabled = Boolean(busy) || !status.hasHead || status.detached;
    form.append(input, submit, pushButton); return form;
  }

  function renderViewer() {
    if (!open) return;
    const focused = fileViewer.contains(document.activeElement) ? document.activeElement.dataset.gitFocus : null;
    fileViewer.hidden = false; fileViewer.dataset.mode = 'git';
    $('fileViewerReveal').hidden = true; $('fileViewerExternal').hidden = true;
    $('fileViewerType').textContent = t('Changes'); $('fileViewerTitle').textContent = status?.name || t('Git');
    $('fileViewerTitle').title = status?.root || getCwd(); $('fileViewerMeta').textContent = status ? branchLabel() : (getCwd() || '');
    const body = $('fileViewerBody'), layout = el('div', 'git-layout');
    if (loading && !status && !repositoryError) layout.append(el('p', 'git-diff-empty', t('Loading Git status…')));
    else if (repositoryError) {
      layout.append(el('p', 'git-diff-error', repositoryError.code === 'NOT_REPOSITORY' ? t('This folder is not a Git repository.') : repositoryError.message));
      layout.append(commandButton('Retry', () => refresh(), 'work-action'));
    } else if (status) {
      const files = el('div', 'git-files'); files.append(fileGroup('Unstaged', entries('unstaged'), true), fileGroup('Staged', entries('staged'), false));
      layout.append(files, renderDetail(selectedEntry()), renderCommit());
      if (operationError) layout.append(el('p', 'git-operation-error', operationError));
      if (notice) layout.append(el('p', 'git-operation-notice', notice));
      if (busy) layout.append(el('p', 'git-operation-busy', t('Running Git operation…')));
    }
    body.replaceChildren(layout);
    for (const button of body.querySelectorAll('[data-git-command]')) button.disabled = Boolean(busy) || (button.type === 'submit' && (!entries('staged').length || !commitMessage.trim()));
    if (focused) body.querySelector(`[data-git-focus="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
    if (commitFocusPending) {
      commitFocusPending = false; body.querySelector('.git-commit-input')?.focus();
    }
  }

  function openChanges() {
    if (!getCwd()) { setStatus(t('No workspace folder is associated with this conversation.')); return; }
    closeFilePreview();
    open = true; fileViewer.dataset.mode = 'git'; updatePreviewWidth(); closeWorkPanel(); void refresh();
  }
  function openCommit() { commitFocusPending = true; openChanges(); }
  function markClosed() { open = false; diffTicket++; diffLoading = false; }
  function close() { if (open) closeFilePreview(); else markClosed(); }
  function reset() {
    statusTicket++; diffTicket++; actionTicket++; directoryTicket++; if (open) closeFilePreview();
    status = null; repositoryError = null; operationError = ''; notice = ''; loading = false; busy = ''; loadedCwd = ''; lastStatusAt = 0;
    selected = null; diff = null; commitMessage = ''; commitFocusPending = false; diffScroll.clear(); diffCache.clear();
    directoryFiles = null; directoryParent = ''; directoryLoading = ''; directoryError = ''; markClosed();
  }
  window.addEventListener('focus', () => { if ((status || open) && !busy) void refresh(); });
  window.addEventListener('camellia:language', () => { onUpdate(); renderViewer(); });

  return {
    renderSummary,
    count: () => status?.files.length || 0,
    refresh,
    openChanges,
    openCommit,
    close,
    markClosed,
    reset,
  };
} };
