'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const directory = path.join(__dirname, '../android/app/src/main/java/app/camellia/mobile');
const source = name => fs.readFileSync(path.join(directory, name + '.java'), 'utf8');

// These are architecture guards for the regression in which a fix reaches
// only one of several independently built instances of the same control.
test('ordinary scrolling surfaces use the shared scrollbar policy', () => {
  const escaped = fs.readdirSync(directory).filter(file => file.endsWith('.java') && file !== 'ScrollViews.java')
    .filter(file => /new\s+(?:android\.widget\.)?ScrollView\s*\(/.test(fs.readFileSync(path.join(directory, file), 'utf8')));
  assert.deepEqual(escaped, [], 'Add the surface through ScrollViews.plain; do not create a separate scrollbar policy');
});

test('all page and dialog action adapters use the common enabled/disabled appearance', () => {
  for (const name of ['MainActivity', 'LocalChatActivity', 'RemoteDiscussionsActivity', 'SettingsStyle', 'CamelliaDialog', 'ArtifactSheet', 'SettingsChoiceDialog', 'SubtaskPage']) {
    assert.match(source(name), /ActionStyle\.(?:page|dialog)\(/, name);
  }
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/android.yml'), 'utf8');
  for (const suite of ['UiConsistencyTest', 'SettingsControlsTest', 'SubtaskPageLayoutTest']) assert.match(workflow, new RegExp('\\b' + suite + '\\b'));
});

test('local, remote and discussion composers share viewport clipping and reserved dock space', () => {
  for (const name of ['MainActivity', 'LocalChatActivity', 'RemoteDiscussionsActivity']) {
    assert.match(source(name), /ChatDockLayout\.attach\(/, name);
    assert.match(source(name), /\.pageHeader\(header\)/, name);
  }
});

const swift = name => fs.readFileSync(path.join(__dirname, '../ios/CamelliaApp/Sources/', name), 'utf8');
test('shared Android/iOS semantic colors do not silently drift', () => {
  const android = source('Palette'), ios = swift('Shared/Palette.swift');
  for (const role of ['background', 'surface', 'ink', 'muted', 'faint', 'caption', 'userBubble', 'cardBorder', 'controlFill', 'selectedBorder', 'progressTrack', 'accent', 'card', 'divider', 'error', 'success', 'warning', 'trackOff', 'separator']) {
    const java = android.match(new RegExp('\\b' + role + ' = color\\(dark, "#([A-Fa-f0-9]+)", "#([A-Fa-f0-9]+)"\\)'));
    const apple = ios.match(new RegExp('static let ' + role + ' = dynamic\\(light: 0x([A-Fa-f0-9]+), dark: 0x([A-Fa-f0-9]+)\\)'));
    assert.ok(java && apple, role); assert.equal(java[1], apple[2], role + ' dark'); assert.equal(java[2], apple[1], role + ' light');
  }
});

test('shared type and shape roles use the same current tokens on both clients', () => {
  const android = source('Palette'), ios = swift('Shared/Palette.swift');
  const roles = { textTiny:'TEXT_TINY', textSmall:'TEXT_SMALL', textNote:'TEXT_NOTE', textBody:'TEXT_BODY', textInput:'TEXT_INPUT',
    textRow:'TEXT_ROW', textRowStrong:'TEXT_ROW_STRONG', textCard:'TEXT_CARD', textTitle:'TEXT_TITLE', textDisplay:'TEXT_DISPLAY', textHero:'TEXT_HERO',
    userBubbleRadius:'RADIUS_USER_BUBBLE', settingsCardRadius:'RADIUS_SETTINGS_CARD', settingsControlRadius:'RADIUS_SETTINGS_CONTROL', groupRadius:'RADIUS_GROUP',
    sheetRadius:'RADIUS_SHEET', fieldRadius:'RADIUS_FIELD', homeRadius:'RADIUS_HOME_CARD', dialogActionRadius:'RADIUS_DIALOG_ACTION', capsuleRadius:'RADIUS_CAPSULE', userInset:'BUBBLE_INSET' };
  for (const [appleRole, javaRole] of Object.entries(roles)) {
    const java = android.match(new RegExp('\\b' + javaRole + ' = (\\d+);'));
    const apple = ios.match(new RegExp('static let ' + appleRole + ': CGFloat = (\\d+)'));
    assert.ok(java && apple, appleRole); assert.equal(java[1], apple[1], appleRole);
  }
});

test('both iOS conversation types use the same send/stop control', () => {
  for (const name of ['LocalChatScreens.swift', 'ConversationScreens.swift']) assert.match(swift(name), /ComposerActionButton\(symbol:/, name);
});

test('conversation state text and composition stay aligned across desktop and mobile', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/workbench.css'), 'utf8');
  assert.match(css, /\.session-hint-state\.is-busy\s*\{[^}]*state-success-primary/);
  assert.match(css, /\.session-hint-state\.is-unread\s*\{[^}]*static-deepseek-500/);
  assert.match(css, /\.session-hint-state\.is-draft\s*\{[^}]*state-error-primary/);
  assert.match(css, /\.session-item \.session-item-time\.is-unread\s*\{[^}]*static-deepseek-500/);
  assert.match(css, /\.session-item \.session-item-time\.is-draft\s*\{[^}]*state-error-primary/);
  assert.match(css, /\.session-item\[data-background="unknown"\] \.session-item-time\s*\{[^}]*#ae6900/);

  const sidebar = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/workbench-sidebar.js'), 'utf8');
  assert.match(sidebar, /else if \(activity\) \{ parts\.push\(t\('Running'\)\); tone = 'busy'; \}/);
  assert.match(sidebar, /else if \(uncertain\) \{ parts\.push\(t\('Background status unknown'\)\); tone = 'attention'; \}/);
  assert.match(sidebar, /else if \(unread\) \{ parts\.push\(t\('Unread reply'\)\); tone = 'unread'; \}/);
  assert.match(sidebar, /else if \(draft\) \{ parts\.push\(t\('Draft'\)\); tone = 'draft'; \}/);
  assert.match(sidebar, /if \(unread && parts\[0\] !== t\('Unread reply'\)\) parts\.push\(t\('Unread reply'\)\);/);
  assert.match(sidebar, /if \(session\?\.pinned\) parts\.push\(t\('Pinned'\)\);/);
  assert.doesNotMatch(sidebar, /t\('(Working|Current)'\)/);

  const android = source('MainActivity');
  assert.match(android, /state\.equals\("running"\)\) return palette\.success/);
  assert.match(android, /RemoteWorkStatus\.backgroundUnknown\(conversation\) \? palette\.warning : palette\.success/);
  assert.match(android, /if \(unread\) return palette\.accent/);
  assert.match(android, /if \(draft\) return palette\.error/);
  assert.match(android, /tr\("运行中", "Running"\)/);
  assert.match(android, /tr\("等待确认", "Needs approval"\)/);
  assert.match(android, /tr\("等待回答", "Needs input"\)/);
  assert.match(android, /tr\("未读回复", "Unread reply"\)/);
  assert.match(android, /tr\("置顶", "Pinned"\)/);

  const ios = swift('ConversationScreens.swift');
  assert.match(ios, /case \.running:\s*return Palette\.success/);
  assert.match(ios, /return work\.statusUnknown \? Palette\.warning : Palette\.success/);
  assert.match(ios, /if unread \{ return Palette\.accent \}/);
  assert.match(ios, /if model\.hasDraft\(conversation\) \{ return Palette\.error \}/);
  assert.match(ios, /return Palette\.muted\s*\}\s*\}\s*\}/);
  assert.match(ios, /model\.usesChinese \? "运行中" : "Running"/);
  assert.match(ios, /model\.usesChinese \? "等待确认" : "Needs approval"/);
  assert.match(ios, /model\.usesChinese \? "等待回答" : "Needs input"/);
  assert.match(ios, /model\.usesChinese \? "未读回复" : "Unread reply"/);
  assert.match(ios, /model\.usesChinese \? "置顶" : "Pinned"/);
});
