'use strict';

// One renderer and one set of workspace menus, with engine-specific abilities.
const requestedHarness = new URLSearchParams(location.search).get('harness');
const harnessId = ['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi'].includes(requestedHarness) ? requestedHarness : 'claude';
const chatProfile = {
  pi: { name: 'Pi', shortName: 'Pi', permission: 'ask' },
  codex: { name: 'Codex CLI', shortName: 'Codex', permission: 'ask' },
  kimi: { name: 'Kimi Code', shortName: 'Kimi', permission: 'ask' },
  claude: { name: 'Claude Code', shortName: 'Claude', permission: 'auto' },
  dsh: { name: 'DeepSeek Harness', shortName: 'DSH', permission: 'auto' },
  antigravity: { name: 'Antigravity', shortName: 'Antigravity', permission: 'ask', supportsImages: false },
}[harnessId];
const ENGINE_SHORT_NAMES = { claude: 'Claude', codex: 'Codex', dsh: 'DSH', kimi: 'Kimi', antigravity: 'Antigravity', pi: 'Pi' };
const engineAvatar = engine => '<div class="turn-avatar engine-mark" data-engine="' + engine + '" aria-hidden="true"><img src="../../../assets/brands/' + (engine === 'dsh' ? 'deepseek' : engine) + (engine === 'codex' ? '.png' : '.svg') + '" alt=""></div>';
const chatLogoUrl = '../../../assets/brands/' + (harnessId === 'dsh' ? 'deepseek' : harnessId) + (harnessId === 'codex' ? '.png' : '.svg');
const chatAvatar = engineAvatar(harnessId);
const chatApi = Object.fromEntries(['Send', 'Steer', 'Cancel', 'GetSettings', 'SaveSettings', 'ControlRespond', 'Find',
  'ListSessions', 'LoadSession', 'ForkSession', 'RenameSession', 'ArchiveSession', 'DeleteSession', 'MetaOp',
  'GoalGet', 'GoalStart', 'GoalPause', 'GoalResume', 'GoalComplete', 'GoalClear'].map(action => [
  action[0].toLowerCase() + action.slice(1), payload =>
    window.dshDesktop.conversationCommand({ engine: harnessId, action: action.replace(/[A-Z]/g, (c, i) => (i ? '-' : '') + c.toLowerCase()), payload }),
]));
chatApi.onEvent = callback => window.dshDesktop.onConversationEvent(callback);
chatApi.onGoal = callback => window.dshDesktop.onConversationGoal(callback);
chatApi.loadSession = (id, historyPage = {}) => window.dshDesktop.conversationCommand({
  engine: harnessId, action: 'load-session', payload: id, historyPage,
});

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
}

if (harnessId === 'dsh') document.getElementById('selPermission').replaceChildren(new Option('Default permissions', 'default'), new Option('Fully automatic', 'bypassPermissions'));
document.getElementById('wsHint').textContent = 'Shared conversations keep the same folder across engines. Start a new session to use a different folder.';

for (const option of document.getElementById('selPermission').options) option.dataset.i18n = '';
// A stale system proxy is downgraded in the background; report it on the chat
// surface too, since this is where long-running work happens.
window.dshDesktop.onNetworkHealth(payload => window.CamelliaNetworkNotice?.sync(payload));
