'use strict';

// One renderer and one set of workspace menus, with engine-specific abilities.
const requestedHarness = new URLSearchParams(location.search).get('harness');
const CHAT_PROFILES = {
  grok: { name: 'Grok Build', shortName: 'Grok', permission: 'ask' },
  codex: { name: 'Codex CLI', shortName: 'Codex', permission: 'ask' },
  kimi: { name: 'Kimi Code', shortName: 'Kimi', permission: 'ask' },
  claude: { name: 'Claude Code', shortName: 'Claude', permission: 'auto' },
  dsh: { name: 'DeepSeek Harness', shortName: 'DSH', permission: 'auto' },
  antigravity: { name: 'Antigravity', shortName: 'Antigravity', permission: 'ask', supportsImages: false },
};
let harnessId = Object.hasOwn(CHAT_PROFILES, requestedHarness) ? requestedHarness : 'claude';
let chatProfile = CHAT_PROFILES[harnessId];
const ENGINE_SHORT_NAMES = { claude: 'Claude', codex: 'Codex', dsh: 'DSH', kimi: 'Kimi', antigravity: 'Antigravity', grok: 'Grok' };
const engineAvatar = engine => '<div class="turn-avatar engine-mark" data-engine="' + engine + '" aria-hidden="true"><img src="../../../assets/brands/' + (engine === 'dsh' ? 'deepseek' : engine) + (engine === 'codex' ? '.png' : '.svg') + '" alt=""></div>';
let chatAvatar = engineAvatar(harnessId);
const chatApi = Object.fromEntries(['Send', 'Steer', 'Cancel', 'GetSettings', 'SaveSettings', 'ControlRespond', 'Find',
  'ListSessions', 'LoadSession', 'ForkSession', 'RenameSession', 'ArchiveSession', 'DeleteSession', 'MetaOp',
  'GoalGet', 'GoalStart', 'GoalPause', 'GoalResume', 'GoalComplete', 'GoalClear'].map(action => [
  action[0].toLowerCase() + action.slice(1), (payload, engine = harnessId) =>
    window.dshDesktop.conversationCommand({ engine, action: action.replace(/[A-Z]/g, (c, i) => (i ? '-' : '') + c.toLowerCase()), payload }),
]));
chatApi.onEvent = callback => window.dshDesktop.onConversationEvent(callback);
chatApi.onGoal = callback => window.dshDesktop.onConversationGoal(callback);
chatApi.loadSession = (id, historyPage = {}) => window.dshDesktop.conversationCommand({
  engine: harnessId, action: 'load-session', payload: id, historyPage,
});

function setChatHarness(engine) {
  if (!Object.hasOwn(CHAT_PROFILES, engine)) throw new Error('Unknown engine');
  harnessId = engine;
  chatProfile = CHAT_PROFILES[engine];
  chatAvatar = engineAvatar(engine);
  document.title = chatProfile.name + ' — Camellia';
  document.body.dataset.harness = harnessId;
  for (const el of document.querySelectorAll('[data-harness-name]')) el.textContent = chatProfile.name;
  document.querySelector('.logo-icon').dataset.engine = harnessId;
  document.querySelector('.logo-icon img').src = '../../../assets/brands/' + (harnessId === 'dsh' ? 'deepseek' : harnessId) + (harnessId === 'codex' ? '.png' : '.svg');
  document.getElementById('input').placeholder = 'Message ' + chatProfile.name;
  window.goalDraftPlaceholder = 'Set a long-term goal. ' + chatProfile.shortName + ' will work through it automatically…';
  document.querySelector('.perm-dialog .perm-title').textContent = chatProfile.shortName + ' requests the following action';
  const permission = document.getElementById('selPermission');
  permission.querySelector('[value="ask"]').textContent = 'Ask before acting';
  permission.title = '';
}
setChatHarness(harnessId);
document.getElementById('wsHint').textContent = 'Shared conversations keep the same folder across engines. Start a new session to use a different folder.';

for (const option of document.getElementById('selPermission').options) option.dataset.i18n = '';
// A stale system proxy is downgraded in the background; report it on the chat
// surface too, since this is where long-running work happens.
window.dshDesktop.onNetworkHealth(payload => window.CamelliaNetworkNotice?.sync(payload));
