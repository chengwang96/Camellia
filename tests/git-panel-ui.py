"""Exercise the Git work summary and right-side diff workflow without model calls."""
import ast
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
module = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
namespace = {'json': json}
for name in ('fixture', 'bridge'):
    node = next(node for node in module.body if isinstance(node, ast.Assign)
                and any(isinstance(target, ast.Name) and target.id == name for target in node.targets))
    exec(compile(ast.Module(body=[node], type_ignores=[]), 'shared-chat-fixture', 'exec'), namespace)
    if name == 'fixture':
        namespace['fixture']['cwd'] = 'D:/demo'
        namespace['fixture']['workspaceId'] = None
bridge = namespace['bridge']
status = {
    'root': 'D:/demo', 'name': 'demo', 'branch': 'main', 'upstream': 'origin/main',
    'ahead': 1, 'behind': 0, 'detached': False, 'hasHead': True, 'remotes': ['origin'],
    'additions': 7, 'deletions': 1, 'statsTruncated': True,
    'files': [
        {'path': 'src/main.js', 'oldPath': None, 'status': 'M', 'staged': False, 'unstaged': True, 'untracked': False,
         'stats': {'additions': 2, 'deletions': 1}, 'unstagedStats': {'additions': 2, 'deletions': 1}, 'stagedStats': None},
        {'path': 'README.md', 'oldPath': None, 'status': 'M', 'staged': True, 'unstaged': False, 'untracked': False,
         'stats': {'additions': 3, 'deletions': 0}, 'unstagedStats': None, 'stagedStats': {'additions': 3, 'deletions': 0}},
        {'path': 'notes.txt', 'oldPath': None, 'status': 'A', 'staged': False, 'unstaged': True, 'untracked': True,
         'stats': {'additions': 2, 'deletions': 0}, 'unstagedStats': {'additions': 2, 'deletions': 0}, 'stagedStats': None},
        {'path': 'assets/', 'oldPath': None, 'status': 'A', 'staged': False, 'unstaged': True, 'untracked': True, 'directory': True,
         'stats': None, 'unstagedStats': None, 'stagedStats': None},
    ],
}
git_bridge = r"""(() => {
  const initialStatus = GIT_STATUS;
  window.gitStatusValue = JSON.parse(JSON.stringify(initialStatus));
  window.gitCalls = [];
  window.statusDelay = 0;
  function updateTotals() {
    gitStatusValue.additions = gitStatusValue.files.reduce((sum, file) => sum + (file.stats?.additions || 0), 0);
    gitStatusValue.deletions = gitStatusValue.files.reduce((sum, file) => sum + (file.stats?.deletions || 0), 0);
  }
  dshDesktop.gitStatus = async payload => {
    gitCalls.push({type:'status',payload});
    await new Promise(resolve => setTimeout(resolve, window.statusDelay));
    return {ok:true,status:JSON.parse(JSON.stringify(gitStatusValue))};
  };
  dshDesktop.gitUntracked = async payload => {
    gitCalls.push({type:'untracked',payload});
    return {ok:true,result:{root:'D:/demo',directory:'assets/',total:2,truncated:false,files:[
      {path:'assets/data.txt',status:'A',staged:false,unstaged:true,untracked:true,directory:false,stats:{additions:1,deletions:0},unstagedStats:{additions:1,deletions:0},stagedStats:null},
      {path:'assets/logo.txt',status:'A',staged:false,unstaged:true,untracked:true,directory:false,stats:{additions:1,deletions:0},unstagedStats:{additions:1,deletions:0},stagedStats:null}
    ]}};
  };
  dshDesktop.gitDiff = async payload => {
    gitCalls.push({type:'diff',payload});
    if (payload.filePath === 'notes.txt') return {ok:true,diff:{path:payload.filePath,scope:payload.scope,binary:false,truncated:false,
      patch:'diff --git a/notes.txt b/notes.txt\n--- /dev/null\n+++ b/notes.txt\n@@ -0,0 +1,2 @@\n+first note\n+second note\n'}};
    if (payload.filePath.startsWith('assets/')) return {ok:true,diff:{path:payload.filePath,scope:payload.scope,binary:false,truncated:false,
      patch:'diff --git a/assets/logo.txt b/assets/logo.txt\n--- /dev/null\n+++ b/assets/logo.txt\n@@ -0,0 +1 @@\n+asset content\n'}};
    return {ok:true,diff:{path:payload.filePath,scope:payload.scope,binary:false,truncated:false,
      patch:'diff --git a/src/main.js b/src/main.js\nindex 1111111..2222222 100644\n--- a/src/main.js\n+++ b/src/main.js\n@@ -10,2 +10,3 @@\n const before = true;\n-oldImplementation();\n+newImplementation();\n+finishUpdate();\n'}};
  };
  dshDesktop.gitAction = async payload => {
    gitCalls.push({type:payload.action,payload});
    if (payload.action === 'stage' || payload.action === 'unstage') {
      const stage = payload.action === 'stage';
      for (const file of gitStatusValue.files) if (payload.paths.includes(file.path)) {
        file.staged = stage; file.unstaged = !stage;
        if (stage) file.stagedStats = file.stats; else file.unstagedStats = file.stats;
      }
    } else if (payload.action === 'commit') {
      gitStatusValue.files = gitStatusValue.files.filter(file => !file.staged);
      gitStatusValue.ahead++;
      updateTotals();
      return {ok:true,hash:'abc1234'};
    } else if (payload.action === 'push') {
      gitStatusValue.ahead = 0;
      if (payload.setUpstream) gitStatusValue.upstream = payload.remote + '/' + gitStatusValue.branch;
    }
    updateTotals();
    return {ok:true};
  };
  dshDesktop.previewFile = async filePath => ({ok:true,file:{path:filePath,name:'preview.txt',kind:'text',extension:'TXT',size:12,text:'preview text',url:'file:///D:/demo/preview.txt'}});
  dshDesktop.revealFile = async () => ({ok:true});
  dshDesktop.openInVSCode = async () => ({ok:true});
})();""".replace('GIT_STATUS', json.dumps(status))


def exercise(browser, theme, language, width, full_workflow):
    page = browser.new_page(viewport={'width': width, 'height': 900}, color_scheme=theme, reduced_motion='reduce')
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(bridge + git_bridge)
    page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=codex', wait_until='networkidle')
    page.wait_for_function('uiReady')
    page.locator('[data-sid="shared-fixture"]').click()
    if language == 'zh':
        page.evaluate("CamelliaI18n.setLanguage('zh-CN')")
    page.evaluate('statusDelay = 120')
    page.locator('#workPanelToggle').click()
    loading_text = '正在读取 Git 状态…' if language == 'zh' else 'Loading Git status…'
    expect(page.locator('#workPanel').get_by_text(loading_text, exact=True)).to_have_count(1)
    page.evaluate('statusDelay = 0')
    page.wait_for_function('gitCalls.some(call => call.type === "status")')
    summary = page.locator('#workPanel [data-work-disclosure="git"]')
    expect(summary.locator('.git-change-label')).to_have_text('4 个变更项' if language == 'zh' else '4 changed item(s)')
    expect(summary.locator('.git-additions')).to_have_text('+7')
    expect(summary.locator('.git-deletions')).to_have_text('−1')
    expect(summary.locator('.git-stats-partial')).to_be_visible()
    output = repo / 'dist/ui-preview/git-panel-design'
    output.mkdir(parents=True, exist_ok=True)
    stem = f'{theme}-{language}-{width}'
    summary.screenshot(path=str(output / f'summary-{stem}.png'), animations='disabled')

    expect(summary.locator('.git-summary-branch')).to_have_count(0)
    expect(summary.locator('.git-summary-actions')).to_have_count(0)
    menu_button = summary.locator('.git-change-menu')
    expect(menu_button).to_be_hidden()
    summary.locator('.git-change-open').hover()
    expect(menu_button).to_be_visible()
    expect(summary.locator('.git-stats')).to_be_hidden()
    assert 'origin/main' in menu_button.get_attribute('title')
    summary.screenshot(path=str(output / f'summary-hover-{stem}.png'), animations='disabled')
    menu_button.click()
    expect(page.locator('#fileViewer')).to_be_hidden()
    action_menu = page.locator('.dsh-pop.action-menu')
    expect(action_menu).to_be_visible()
    expect(action_menu.locator('.pop-row')).to_have_count(8)
    expect(action_menu).to_contain_text('提交' if language == 'zh' else 'Commit')
    expect(action_menu).to_contain_text('推送' if language == 'zh' else 'Push')
    page.keyboard.press('Escape')
    expect(page.locator('.dsh-pop.action-menu')).to_have_count(0)

    status_calls = page.evaluate('gitCalls.filter(call => call.type === "status").length')
    summary.locator('.git-change-open').click()
    expect(page.locator('#workPanel')).to_be_hidden()
    expect(page.locator('#fileViewer')).to_be_visible()
    expect(page.locator('#fileViewer')).to_have_attribute('data-mode', 'git')
    expect(page.locator('#fileViewerExternal')).to_be_hidden()
    expect(page.locator('#fileViewerReveal')).to_be_hidden()
    assert page.evaluate('gitCalls.filter(call => call.type === "status").length') == status_calls
    page.wait_for_function('gitCalls.some(call => call.type === "diff")')
    expect(page.locator('.git-diff-deletion .git-old-line')).to_have_text('11')
    expect(page.locator('.git-diff-addition .git-new-line').first).to_have_text('11')
    expect(page.locator('.git-diff-addition .git-new-line').nth(1)).to_have_text('12')
    expect(page.locator('.git-diff-addition').first).to_contain_text('newImplementation')
    diff_calls = page.evaluate('gitCalls.filter(call => call.type === "diff").length')
    page.locator('[data-git-path="src/main.js"]').click()
    assert page.evaluate('gitCalls.filter(call => call.type === "diff").length') == diff_calls
    assert page.locator('#fileViewerBody').evaluate('node => node.scrollWidth <= node.clientWidth')
    page.locator('#fileViewer').screenshot(path=str(output / f'diff-{stem}.png'), animations='disabled')

    page.locator('[data-git-path="assets/"]').click()
    page.locator('.git-directory-content .work-action').click()
    page.wait_for_function('gitCalls.some(call => call.type === "untracked")')
    expect(page.locator('.git-directory-files .git-file-row')).to_have_count(2)
    page.locator('#fileViewer').screenshot(path=str(output / f'directory-{stem}.png'), animations='disabled')
    page.locator('[data-git-path="assets/logo.txt"]').click()
    expect(page.locator('.git-diff-addition').first).to_contain_text('asset content')

    if full_workflow:
        page.locator('.git-commit-input').fill('Keep this commit draft')
        notes = page.locator('.git-file-row').filter(has_text='notes.txt')
        notes.locator('.git-stage-button').click()
        page.wait_for_function('gitCalls.some(call => call.type === "stage")')
        expect(page.locator('.git-commit-input')).to_have_value('Keep this commit draft')
        expect(page.locator('.git-file-group').nth(1).locator('.git-group-count')).to_have_text('2')
        page.locator('.git-commit-input').fill('Add the Git work panel')
        page.locator('.git-commit-form button[type="submit"]').click()
        page.wait_for_function('gitCalls.some(call => call.type === "commit")')
        expect(page.locator('.git-operation-notice')).to_contain_text('abc1234')
        expect(page.locator('.git-commit-input')).to_have_value('')
        page.locator('.git-push-button').click()
        expect(page.locator('.git-confirm-dialog')).to_be_visible()
        expect(page.locator('.git-confirm-body')).to_contain_text('main → origin/main')
        page.locator('.git-confirm-actions button[type="submit"]').click()
        page.wait_for_function('gitCalls.some(call => call.type === "push")')
        expect(page.locator('.git-operation-notice')).to_contain_text('Pushed commits')
        assert page.evaluate('gitCalls.find(call => call.type === "commit").payload.message') == 'Add the Git work panel'
        page.locator('#fileViewer').screenshot(path=str(output / f'committed-{stem}.png'), animations='disabled')
        page.evaluate("openFilePreview('D:/demo/preview.txt')")
        expect(page.locator('#fileViewer')).to_have_attribute('data-mode', 'preview')
        expect(page.locator('#fileViewerBody')).to_contain_text('preview text')
        expect(page.locator('#fileViewerExternal')).to_be_visible()
        page.locator('#workPanelToggle').click()
        page.locator('#workPanel .git-change-open').click()
        expect(page.locator('#fileViewer')).to_have_attribute('data-mode', 'git')
        expect(page.locator('#fileViewerExternal')).to_be_hidden()
        expect(page.locator('.git-diff-addition').first).to_contain_text('newImplementation')
        page.locator('#workPanelToggle').click()
        page.locator('#workPanel .git-change-open').hover()
        page.locator('#workPanel .git-change-menu').click()
        menu_commit = page.locator('.dsh-pop.action-menu .pop-row').filter(has_text='Commit')
        expect(menu_commit).to_be_enabled()
        menu_commit.click()
        expect(page.locator('#fileViewer')).to_have_attribute('data-mode', 'git')
        expect(page.locator('.git-commit-input')).to_be_focused()
    else:
        page.locator('.git-detail-toolbar .git-icon-text-button').click()
        expect(page.locator('.git-diff')).to_have_class('git-diff is-wrapped')
        page.locator('#fileViewerClose').click()
        expect(page.locator('#fileViewer')).to_be_hidden()
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    assert not errors, errors
    page.close()


with sync_playwright() as playwright:
    chromium = playwright.chromium.launch(headless=True)
    exercise(chromium, 'light', 'en', 1440, True)
    exercise(chromium, 'dark', 'zh', 900, False)
    chromium.close()

print('PASS: Git summary, diff line numbers, staging, commit, push confirmation, preview switching and narrow Chinese layout')
