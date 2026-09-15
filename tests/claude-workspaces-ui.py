"""Browser regression against real main-process IPC and a fake local Claude CLI.

Run: python tests/claude-workspaces-ui.py [--screenshot PATH]
Requires Python Playwright and its Chromium browser; no API credentials needed.
"""
import argparse
import json
from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--screenshot', type=Path)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[1]
driver = subprocess.Popen(['node', str(repo / 'tests/claude-ui-driver.cjs')], stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')

def rpc(method, payload=None):
    driver.stdin.write(json.dumps({'method': method, 'payload': payload}) + '\n')
    driver.stdin.flush()
    line = driver.stdout.readline()
    if not line:
        raise RuntimeError('Test driver exited: ' + driver.stderr.read())
    response = json.loads(line)
    if 'error' in response:
        raise RuntimeError(response['error'])
    return response

bridge = r"""
(() => {
  let onEvent = () => {}, onGoal = () => {}, onRouter = () => {};
  window.testCall = async (method, payload) => {
    const response = await window.testRpc(method, payload);
    for (const event of response.events || []) {
      if (event.channel === 'dsh:claude-event') onEvent(event.data);
      if (event.channel === 'dsh:claude-goal') onGoal(event.data);
      if (event.channel === 'dsh:api-router-state') onRouter(event.data);
    }
    return response.result;
  };
  window.dshDesktop = new Proxy({}, { get: (_, method) => {
    if (method === 'onEngineSettingsChanged') return () => () => {};
    if (method === 'onClaudeEvent') return (fn) => { onEvent = fn; };
    if (method === 'onClaudeGoal') return (fn) => { onGoal = fn; };
    if (method === 'onApiRouterState') return (fn) => { onRouter = fn; };
    return (payload) => window.testCall(method, payload);
  } });
})();
"""

try:
    rpc('configureTestApi')
    fixtures = rpc('fixtures')['result']
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1320, 'height': 900}, device_scale_factor=1)
        errors = []
        page.on('pageerror', lambda err: errors.append(str(err)))
        page.expose_function('testRpc', rpc)
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/chat/claude.html').as_uri())
        page.wait_for_load_state('networkidle')
        expect(page.locator('#workspaceLabel')).to_have_text('No workspace')
        expect(page.locator('#independentSessions [data-sid="legacy-chat"]')).to_be_visible()

        # Native folder picker path/name, keyboard submission, and first workspace.
        page.get_by_role('button', name='Add workspace', exact=True).click()
        page.locator('#wsBrowse').click()
        expect(page.locator('#wsName')).to_have_value('Alpha Project')
        expect(page.locator('#wsPath')).to_have_value(fixtures['alpha'])
        page.locator('#wsName').press('Enter')
        expect(page.locator('#wsMask')).not_to_be_visible()
        expect(page.locator('#workspaceLabel')).to_have_text('Alpha Project')
        alpha = page.locator('section[data-workspace-id]').first.get_attribute('data-workspace-id')

        # Drafts stay under their workspace; send uses that directory and records ID.
        expect(page.locator(f'section[data-workspace-id="{alpha}"] #sessionCurrent')).to_be_visible()
        page.locator('#input').fill('Alpha 中的会话')
        page.locator('#send').click()
        expect(page.locator('#newSessionBtn')).to_be_disabled()
        page.wait_for_function('currentRunId !== null')
        assert rpc('lastProcess')['result']['cwd'] == fixtures['alpha']
        grouped_id = page.evaluate("window.testCall('finishTurn')")
        expect(page.locator(f'section[data-workspace-id="{alpha}"] [data-sid="{grouped_id}"]')).to_be_visible()
        expect(page.locator('#newSessionBtn')).to_be_enabled()

        # Top-level new session must be independent after a workspace conversation.
        page.locator('#newSessionBtn').click()
        expect(page.locator('#workspaceLabel')).to_have_text('No workspace')
        page.locator('#input').fill('不关联任何工作区的会话')
        page.locator('#send').click()
        page.wait_for_function('currentRunId !== null')
        assert Path(rpc('lastProcess')['result']['cwd']) == Path(fixtures['userData']) / 'claude-sessions'
        independent_id = page.evaluate("window.testCall('finishTurn')")
        expect(page.locator(f'#independentSessions [data-sid="{independent_id}"]')).to_be_visible()

        # Move the open session in and out via the header picker; resume ID is stable.
        page.locator('#workspacePicker').click()
        page.get_by_role('menuitem', name='Alpha Project', exact=True).click()
        expect(page.locator(f'section[data-workspace-id="{alpha}"] [data-sid="{independent_id}"]')).to_be_visible()
        page.locator('#input').fill('继续在 Alpha 工作')
        page.locator('#send').click()
        page.wait_for_function('currentRunId !== null')
        assert rpc('lastProcess')['result']['cwd'] == fixtures['alpha']
        assert page.evaluate("window.testCall('finishTurn')") == independent_id
        page.locator('#workspacePicker').click()
        page.get_by_role('menuitem', name='No workspace · Standalone session', exact=True).click()
        expect(page.locator('#workspaceLabel')).to_have_text('No workspace')
        expect(page.locator(f'#independentSessions [data-sid="{independent_id}"]')).to_be_visible()

        # Add another workspace, rename it, collapse Alpha and verify durable state.
        page.locator('#wsCreateBtn').click()
        page.locator('#wsName').fill('Beta Project')
        page.locator('#wsPath').fill(fixtures['beta'])
        page.locator('#wsCreate').click()
        expect(page.locator('section[data-workspace-id]')).to_have_count(2)
        page.get_by_role('button', name='Beta Project workspace actions', exact=True).click()
        page.get_by_role('menuitem', name='Rename workspace', exact=True).click()
        expect(page.locator('#wsPathField')).not_to_be_visible()
        page.locator('#wsName').fill('Beta 研究')
        page.locator('#wsCreate').click()
        expect(page.locator('.ws-name').filter(has_text='Beta 研究')).to_be_visible()
        alpha_row = page.locator(f'section[data-workspace-id="{alpha}"] .ws-row')
        alpha_row.click()
        expect(alpha_row).to_have_attribute('aria-expanded', 'false')
        rpc('restart')
        page.reload(wait_until='networkidle')
        expect(page.locator(f'section[data-workspace-id="{alpha}"] .ws-row')).to_have_attribute('aria-expanded', 'false')
        expect(page.locator('.ws-name').filter(has_text='Beta 研究')).to_be_visible()
        expect(page.locator(f'#independentSessions [data-sid="{independent_id}"]')).to_be_visible()

        # Add in a collapsed workspace automatically expands it and starts a draft.
        page.get_by_role('button', name='New session in Alpha Project', exact=True).click()
        expect(page.locator(f'section[data-workspace-id="{alpha}"] #sessionCurrent')).to_be_visible()
        expect(page.locator('#workspaceLabel')).to_have_text('Alpha Project')

        # Pin, fork, rename and archive still work with grouped history.
        grouped = page.locator(f'[data-sid="{grouped_id}"]')
        grouped.get_by_role('button', name='Session actions').click()
        page.get_by_role('menuitem', name='Pin session', exact=True).click()
        expect(page.locator('section [data-sid="' + grouped_id + '"]')).to_have_count(0)
        grouped = page.locator(f'[data-sid="{grouped_id}"]')
        grouped.get_by_role('button', name='Session actions').click()
        page.get_by_role('menuitem', name='Fork session', exact=True).click()
        expect(page.locator('#headerTitle')).to_have_text('Alpha 中的会话')
        page.wait_for_function('pendingForkId !== null')
        page.locator('#input').fill('保留历史的分叉')
        page.locator('#send').click()
        page.wait_for_function('currentRunId !== null')
        assert '--fork-session' in rpc('lastProcess')['result']['args']
        fork_id = page.evaluate("window.testCall('finishTurn')")
        assert fork_id != grouped_id
        expect(page.locator(f'section[data-workspace-id="{alpha}"] [data-sid="{fork_id}"]')).to_be_visible()
        fork_row = page.locator(f'[data-sid="{fork_id}"]')
        fork_row.get_by_role('button', name='Session actions').click()
        page.get_by_role('menuitem', name='Rename', exact=True).click()
        page.locator('.session-rename-input').fill('分叉后的研究')
        page.locator('.session-rename-input').press('Enter')
        expect(page.locator('#headerTitle')).to_have_text('分叉后的研究')

        # Collect the final layout before exercising destructive-looking UI removal.
        if args.screenshot:
            args.screenshot.parent.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(args.screenshot), full_page=True)
        page.set_viewport_size({'width': 960, 'height': 680})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        expect(page.locator('#workspacePicker')).to_be_visible()
        page.set_viewport_size({'width': 1320, 'height': 900})
        page.get_by_role('button', name='Alpha Project workspace actions', exact=True).click()
        page.get_by_role('menuitem', name='Remove workspace (keep sessions)', exact=True).click()
        expect(page.locator(f'section[data-workspace-id="{alpha}"]')).to_have_count(0)
        expect(page.locator('#workspaceLabel')).to_have_text('No workspace')
        expect(page.locator(f'#independentSessions [data-sid="{fork_id}"]')).to_be_visible()
        assert Path(fixtures['alpha']).exists()
        assert Path(fixtures['legacy']).exists()
        page.locator(f'[data-sid="{fork_id}"]').get_by_role('button', name='Session actions').click()
        page.get_by_role('menuitem', name='Archive session', exact=True).click()
        expect(page.locator(f'[data-sid="{fork_id}"]')).to_have_count(0)
        expect(page.locator('#headerTitle')).to_have_text('New session')

        # Validation errors remain in the modal, with keyboard dismissal.
        page.locator('#wsCreateBtn').click()
        page.locator('#wsName').fill('Invalid folder')
        page.locator('#wsPath').fill(str(Path(fixtures['userData']) / 'does-not-exist'))
        page.locator('#wsCreate').click()
        expect(page.locator('#wsError')).to_contain_text('Folder does not exist')
        page.locator('#wsName').press('Escape')
        expect(page.locator('#wsMask')).not_to_be_visible()
        # IME confirmation must not submit a half-composed Chinese message.
        page.locator('#input').fill('中文输入')
        page.locator('#input').dispatch_event('keydown', {'key': 'Enter', 'isComposing': True})
        assert page.evaluate('running') is False
        expect(page.locator('#input')).to_have_value('中文输入')
        # Hundreds of deltas in one event-loop slice produce one Markdown render.
        page.evaluate(r'''() => {
          window.markdownCalls = 0;
          const original = mdRender;
          mdRender = value => { window.markdownCalls++; return original(value); };
          onBlockStart({type:'text',text:'开头'}, 0);
          for(let i=0;i<100;i++) onBlockDelta({type:'text_delta',text:'中文'},0);
          if(window.markdownCalls !== 0) throw new Error('Rendered every delta synchronously');
        }''')
        page.wait_for_function('window.markdownCalls === 1')
        assert page.locator('.turn-body .md').last.inner_text().startswith('开头' + '中文' * 100)
        page.evaluate("onBlockDelta({type:'text_delta',text:'结尾'},0); onBlockStop(0)")
        expect(page.locator('.turn-body .md').last).to_contain_text('结尾')
        expect(page.locator('.cursor')).to_have_count(0)
        assert page.evaluate(r"fileUrl('C:\\文档 #1\\why?.png')").endswith('%23' + '1/why%3F.png')
        assert page.evaluate(r"mdRender('\x01999\x01')") == '\x01999\x01'
        # Each history group loads independently; collapse keeps accurate totals.
        paged_ws = page.evaluate("window.testCall('seedPagedHistory')")
        page.reload()
        section = page.locator(f'section[data-workspace-id="{paged_ws}"]')
        expect(section.locator('[data-history]')).to_have_count(60)
        expect(section.locator('.ws-count')).to_have_text('75')
        section.locator('.history-more').click()
        expect(section.locator('[data-history]')).to_have_count(75)
        expect(section.locator('.history-more')).to_have_count(0)
        expect(page.locator('#independentSessions [data-history]')).to_have_count(60)
        page.locator('#independentSessions .history-more').click()
        expect(page.locator('#independentSessions .history-more')).to_have_count(0)
        section.locator('.ws-row').click()
        expect(section.locator('[data-history]')).to_have_count(0)
        expect(section.locator('.ws-count')).to_have_text('75')
        page.reload()
        expect(section.locator('[data-history]')).to_have_count(0)
        page.locator('#resumeLastBtn').click()
        expect(page.locator('#workspaceLabel')).to_have_text('分页工作区')
        expect(page.locator('#chat')).to_contain_text('分页会话 0')

        # The extracted goal UI retains start/pause/resume/complete/clear behavior.
        page.locator('#goalPillBtn').click()
        page.locator('#goalInput').fill('整理这份项目')
        page.locator('#goalInput').dispatch_event('keydown', {'key': 'Enter', 'isComposing': True})
        expect(page.locator('#goalInputRow')).to_be_visible()
        page.locator('#goalStartBtn').click()
        expect(page.locator('#goalPhase')).to_have_text('In progress')
        expect(page.locator('#newSessionBtn')).to_be_disabled()
        page.locator('#goalPauseBtn').click()
        expect(page.locator('#goalPhase')).to_have_text('Paused')
        expect(page.locator('#newSessionBtn')).to_be_enabled()
        page.locator('#goalResumeBtn').click()
        expect(page.locator('#goalPhase')).to_have_text('In progress')
        page.locator('#goalCompleteBtn').click()
        expect(page.locator('#goalPhase')).to_have_text('Completed')
        page.locator('#goalClearBtn').click()
        expect(page.locator('#goalInputRow')).to_be_visible()

        assert not errors, errors
        print('PASS: workspaces, moves, restart, paginated history, goals, pin/fork/archive, layout, Chinese IME, batched streaming and special paths; no browser errors')
        browser.close()
finally:
    try:
        rpc('cleanup')
    finally:
        driver.terminate()
        driver.wait(timeout=10)
