'use strict';

// One renderer and one set of workspace menus, with engine-specific abilities.
const harnessId = new URLSearchParams(location.search).get('harness') === 'kimi' ? 'kimi' : 'claude';
const chatProfile = harnessId === 'kimi'
  ? { name: 'Kimi Code', shortName: 'Kimi', initial: 'K', fixedCwd: true, permission: 'default' }
  : { name: 'Claude Code', shortName: 'Claude', initial: 'C', fixedCwd: false, permission: 'acceptEdits' };
const chatApi = Object.fromEntries(['Send', 'Cancel', 'GetSettings', 'SaveSettings', 'ControlRespond',
  'ListSessions', 'LoadSession', 'RenameSession', 'ArchiveSession', 'MetaOp',
  'GoalGet', 'GoalStart', 'GoalPause', 'GoalResume', 'GoalComplete', 'GoalClear'].map(action => [
  action[0].toLowerCase() + action.slice(1), payload => window.dshDesktop[harnessId + action](payload),
]));
if (harnessId === 'kimi') chatApi.getLive = () => window.dshDesktop.kimiGetLive();
chatApi.onEvent = callback => window.dshDesktop[harnessId === 'kimi' ? 'onKimiEvent' : 'onClaudeEvent'](callback);
chatApi.onGoal = callback => window.dshDesktop[harnessId === 'kimi' ? 'onKimiGoal' : 'onClaudeGoal'](callback);

document.title = chatProfile.name + ' — Camellia';
document.body.dataset.harness = harnessId;
for (const el of document.querySelectorAll('[data-harness-name]')) el.textContent = chatProfile.name;
document.querySelector('.logo-icon').textContent = chatProfile.initial;
document.getElementById('input').placeholder = 'Message ' + chatProfile.name;
document.getElementById('goalInput').placeholder = 'Set a long-term goal. ' + chatProfile.shortName + ' will work through it automatically…';
document.querySelector('.perm-dialog .perm-title').textContent = chatProfile.shortName + ' requests the following action';
if (harnessId === 'kimi') {
  document.getElementById('selPermission').replaceChildren(...[
    ['default', "Default permissions"], ['yolo', "Ask as needed"], ['auto', "Fully automatic"], ['plan', "Plan only"],
  ].map(([value, label]) => new Option(label, value)));
  document.getElementById('wsHint').textContent = "New sessions use the selected folder. Kimi fixes the directory when a session is created. You can also start without a workspace.";
}
