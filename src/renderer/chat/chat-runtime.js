'use strict';

// One renderer and one set of workspace menus, with engine-specific abilities.
const requestedHarness = new URLSearchParams(location.search).get('harness');
const harnessId = ['claude', 'codex', 'dsh', 'kimi', 'antigravity'].includes(requestedHarness) ? requestedHarness : 'claude';
const sharedChat = window.dshDesktop.sharedConversations === true;
const chatProfile = {
  codex: { name: 'Codex CLI', shortName: 'Codex', fixedCwd: false, permission: 'ask' },
  kimi: { name: 'Kimi Code', shortName: 'Kimi', fixedCwd: true, permission: 'ask' },
  claude: { name: 'Claude Code', shortName: 'Claude', fixedCwd: false, permission: 'auto' },
  dsh: { name: 'DeepSeek Harness', shortName: 'DSH', fixedCwd: true, permission: 'auto' },
  antigravity: { name: 'Antigravity', shortName: 'Antigravity', fixedCwd: true, permission: 'ask', supportsImages: false },
}[harnessId];
const ENGINE_SHORT_NAMES = { claude: 'Claude', codex: 'Codex', dsh: 'DSH', kimi: 'Kimi', antigravity: 'Antigravity' };
const engineAvatar = engine => '<div class="turn-avatar engine-mark" data-engine="' + engine + '" aria-hidden="true"><img src="../../../assets/brands/' + (engine === 'dsh' ? 'deepseek' : engine) + (engine === 'codex' ? '.png' : '.svg') + '" alt=""></div>';
const chatLogoUrl = '../../../assets/brands/' + (harnessId === 'dsh' ? 'deepseek' : harnessId) + (harnessId === 'codex' ? '.png' : '.svg');
const chatAvatar = engineAvatar(harnessId);
const chatApi = Object.fromEntries(['Send', 'Cancel', 'GetSettings', 'SaveSettings', 'ControlRespond',
  'ListSessions', 'LoadSession', 'RenameSession', 'ArchiveSession', 'MetaOp',
  'GoalGet', 'GoalStart', 'GoalPause', 'GoalResume', 'GoalComplete', 'GoalClear'].map(action => [
  action[0].toLowerCase() + action.slice(1), payload => sharedChat
    ? window.dshDesktop.conversationCommand({ engine: harnessId, action: action.replace(/[A-Z]/g, (c, i) => (i ? '-' : '') + c.toLowerCase()), payload })
    : window.dshDesktop[harnessId + action](payload),
]));
if (sharedChat || harnessId !== 'claude') chatApi.getLive = payload => sharedChat ? window.dshDesktop.conversationCommand({ engine: harnessId, action: 'get-live', payload }) : window.dshDesktop[harnessId + 'GetLive']();
chatApi.onEvent = callback => sharedChat ? window.dshDesktop.onConversationEvent(callback) : window.dshDesktop['on' + chatProfile.shortName + 'Event'](callback);
chatApi.onGoal = callback => sharedChat ? window.dshDesktop.onConversationGoal(callback) : window.dshDesktop['on' + chatProfile.shortName + 'Goal'](callback);

document.title = chatProfile.name + ' — Camellia';
document.body.dataset.harness = harnessId;
for (const el of document.querySelectorAll('[data-harness-name]')) el.textContent = chatProfile.name;
document.querySelector('.logo-icon').dataset.engine = harnessId;
document.querySelector('.logo-icon img').src = chatLogoUrl;
document.getElementById('input').placeholder = 'Message ' + chatProfile.name;
window.goalDraftPlaceholder = 'Set a long-term goal. ' + chatProfile.shortName + ' will work through it automatically…';
document.querySelector('.perm-dialog .perm-title').textContent = chatProfile.shortName + ' requests the following action';
if (harnessId === 'kimi') {
  document.getElementById('selPermission').replaceChildren(...[
    ['default', "Default permissions"], ['yolo', "Ask as needed"], ['auto', "Fully automatic"], ['plan', "Plan only"],
  ].map(([value, label]) => new Option(label, value)));
  document.getElementById('wsHint').textContent = "New sessions use the selected folder. Kimi fixes the directory when a session is created. You can also start without a workspace.";
}

if (harnessId === 'antigravity') document.getElementById('wsHint').textContent = 'New sessions use the selected folder. You can also start without a workspace.';
if (harnessId === 'dsh') document.getElementById('selPermission').replaceChildren(new Option('Default permissions', 'default'), new Option('Fully automatic', 'bypassPermissions'));
if (sharedChat) {
  chatProfile.fixedCwd = true;
  document.getElementById('wsHint').textContent = 'Shared conversations keep the same folder across engines. Start a new session to use a different folder.';
}

for (const option of document.getElementById('selPermission').options) option.dataset.i18n = '';
