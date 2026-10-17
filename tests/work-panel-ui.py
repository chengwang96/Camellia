"""Exercise the real chat renderer's child controls and navigation without model calls."""
import ast
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

sys.stdout.reconfigure(encoding='utf-8')
repo = Path(__file__).resolve().parents[1]
module = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
namespace = {'json': json}
for name in ('fixture', 'bridge'):
    node = next(node for node in module.body if isinstance(node, ast.Assign)
                and any(isinstance(target, ast.Name) and target.id == name for target in node.targets))
    exec(compile(ast.Module(body=[node], type_ignores=[]), 'shared-chat-fixture', 'exec'), namespace)
    if name == 'fixture':
        namespace['fixture']['messages'] = [
            {'role': 'user' if i % 2 == 0 else 'assistant', 'engine': 'codex', 'seq': i + 1,
             'text': 'Review sample ' + str(i) if i % 2 == 0 else ('Review result ' + str(i) + '\n\n') * 20}
            for i in range(20)]
bridge = namespace['bridge'].replace('onConversationEvent:()=>{}',
    'onConversationEvent:fn=>{window.deliverEvent=fn;window.deliverChild=tasks=>fn({type:"gui:subagent",session_id:"shared-fixture",tasks});}')
bridge = bridge.replace("if(action==='goal-get')", "if(action==='task-list') return {ok:true,tasks:[]}; if(action==='goal-get')")
bridge += """(() => {
  const command = window.dshDesktop.conversationCommand;
  window.childCommands=[];
  window.dshDesktop.conversationCommand=async value=>{
    if(value.action==='subagent-command') {window.childCommands.push(value);return {ok:true};}
    return command(value);
  };
  window.dshDesktop.resolveArtifacts=async()=>({ok:true,files:[{path:'/demo/checks.md',name:'checks.md'}]});
})();"""
task = {'id': 'child-1', 'engine': 'codex', 'userSeq': 1, 'title': 'Check Android',
        'goal': 'Validate child navigation', 'status': 'waiting', 'progress': 'Needs a decision',
        'turnId': 'child-turn', 'canReply': True, 'canStop': True,
        'history': [{'type': 'commandExecution', 'text': 'gradle test'}],
        'approvals': [{'requestId': 'req-1', 'fingerprint': 'fingerprint-1', 'toolName': 'Question',
                       'details': 'Choose a report format', 'responseSupported': True,
                       'questions': [{'id': 'format', 'question': 'Which format?', 'options': [{'label': 'CSV'}]}]}]}


def exercise_design(browser, theme, language, width, height):
    page = browser.new_page(viewport={'width': width, 'height': height}, color_scheme=theme,
                            reduced_motion='reduce')
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(bridge)
    page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex', wait_until='networkidle')
    page.wait_for_function('uiReady')
    if not page.locator('[data-sid="shared-fixture"]').is_visible():
        page.locator('#workbenchSidebarToggle').click()
    page.locator('[data-sid="shared-fixture"]').click()
    page.evaluate('language => CamelliaI18n.setLanguage(language)', 'zh-CN' if language == 'zh' else 'en')
    chinese = language == 'zh'
    goal = '复核主题分类并记录有分歧的条目。' if chinese else 'Review topic classifications and record disagreements.'
    progress = '已完成 8 包，正在核对剩余 2 包。' if chinese else 'Eight packets complete. Reviewing the remaining two.'
    child = {'id': 'nash', 'engine': 'codex', 'userSeq': 1, 'title': 'Nash', 'status': 'running',
             'goal': goal, 'progress': progress, 'turnId': 'nash-turn', 'canStop': True,
             'history': [{'type': 'commandExecution', 'text': f'node verify.cjs --packet={i}\nPASS: packet validated'} for i in range(12)]}
    waiting = {**child, 'id': 'ramanujan', 'title': 'Ramanujan', 'status': 'waiting',
               'progress': '等待确认审核范围。' if chinese else 'Waiting for a scope decision.', 'history': []}
    finished = {**child, 'id': 'chandra', 'title': 'Chandrasekhar', 'status': 'completed', 'canStop': False,
                'result': '核验已完成，报告已保存。' if chinese else 'Validation complete. Report saved.'}
    children = [child, waiting, finished]
    page.evaluate('tasks => deliverChild(tasks)', children)
    expect(page.locator('#workPanel')).to_be_hidden()
    page.locator('#workPanelToggle').click()
    expect(page.locator('#workPanel .work-task')).to_have_count(3)
    expect(page.locator('#workPanelCount')).to_have_text('3')
    expect(page.locator('#workPanel .work-task[data-state=completed] .work-task-preview')).to_have_text(finished['result'])
    output = repo / 'dist/ui-preview/work-panel-design'
    output.mkdir(parents=True, exist_ok=True)
    stem = f'{theme}-{language}-{width}x{height}'
    page.locator('#workPanel').screenshot(path=str(output / f'overview-{stem}.png'), animations='disabled')
    page.locator('#workPanel .work-task').first.click()
    expect(page.locator('.work-detail-heading h2')).to_have_text('Nash')
    expect(page.locator('.work-detail-heading .work-state')).to_have_text('运行中' if chinese else 'running')
    expect(page.locator('.work-progress')).to_contain_text(progress)
    expect(page.locator('#workPanelFooter .work-stop')).to_be_visible()
    panel = page.locator('#workPanel').bounding_box()
    header = page.locator('.main-header').bounding_box()
    main = page.locator('.main').bounding_box()
    footer = page.locator('#workPanelFooter').bounding_box()
    assert panel['y'] >= header['y'] + header['height'], (header, panel)
    assert panel['height'] <= main['height'] / 2 + 1, (main, panel)
    assert main['x'] <= panel['x'] and panel['x'] + panel['width'] <= width
    assert panel['y'] + panel['height'] <= height
    assert footer['y'] + footer['height'] <= panel['y'] + panel['height']
    assert page.locator('#workPanelBody').evaluate('(node)=>node.scrollWidth<=node.clientWidth')
    page.locator('#workPanel').screenshot(path=str(output / f'detail-{stem}.png'), animations='disabled')

    # Live updates preserve an expanded history and the current reading position.
    page.locator('.work-history summary').click()
    expect(page.locator('.work-history')).to_have_attribute('open', '')
    page.locator('#workPanelBody').evaluate('(node)=>node.scrollTop=200')
    before = page.locator('#workPanelBody').evaluate('(node)=>node.scrollTop')
    assert before > 0
    updated = {**child, 'progress': progress + ' ✓'}
    page.evaluate('tasks => deliverChild(tasks)', [updated, waiting, finished])
    expect(page.locator('.work-progress')).to_contain_text('✓')
    page.evaluate('() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    assert page.locator('.work-history').evaluate('(node)=>node.open')
    after = page.locator('#workPanelBody').evaluate('(node)=>node.scrollTop')
    assert abs(after - before) <= 2, (before, after)

    # A browser-native state change can precede its queued toggle event.
    # Reproduce an update in that same turn, including newly appended records.
    page.locator('.work-history summary').click()
    expect(page.locator('.work-history')).not_to_have_attribute('open', '')
    changed_history = {**updated, 'history': [*child['history'], {'type': 'agentMessage', 'text': 'New live history record'}]}
    still_open = page.evaluate('''tasks => {
      document.querySelector('.work-history').open=true;
      deliverChild(tasks);
      return document.querySelector('.work-history').open;
    }''', [changed_history, waiting, finished])
    assert still_open, 'A live update must preserve the actual expanded state before the toggle event arrives'
    expect(page.locator('.work-history-entry').last).to_contain_text('New live history record')
    still_closed = page.evaluate('''tasks => {
      document.querySelector('.work-history').open=false;
      deliverChild(tasks);
      return !document.querySelector('.work-history').open;
    }''', [changed_history, waiting, finished])
    assert still_closed, 'A live update must also preserve an explicit collapse'
    page.locator('.work-history summary').focus()
    page.keyboard.press('Enter')
    expect(page.locator('.work-history')).to_have_attribute('open', '')
    for index in range(4):
        refreshed = {**changed_history, 'history': [*changed_history['history'], {'type': 'agentMessage', 'text': f'Additional live record {index}'}]}
        page.evaluate('tasks => deliverChild(tasks)', [refreshed, waiting, finished])
        expect(page.locator('.work-history')).to_have_attribute('open', '')
        expect(page.locator('.work-history-entry').last).to_contain_text(f'Additional live record {index}')

    # A pending stop disables controls, keeps its focus during updates, and
    # still carries the displayed task identity rather than the parent ID.
    page.evaluate('''() => {
      const command=dshDesktop.conversationCommand;
      dshDesktop.conversationCommand=async value=>{
        const result=await command(value);
        if(value.action==='subagent-command') await new Promise(resolve=>window.finishChildCommand=resolve);
        return result;
      };
    }''')
    stop = page.locator('.work-stop')
    stop.click()
    expect(stop).to_be_disabled()
    page.evaluate('tasks => deliverChild(tasks)', [updated, waiting, finished])
    expect(stop).to_be_disabled()
    page.wait_for_function('typeof finishChildCommand === "function"')
    page.evaluate('finishChildCommand()')
    expect(stop).to_be_enabled()
    command = page.evaluate('childCommands.at(-1).payload')
    assert command['taskId'] == 'nash' and command['expectedTurnId'] == 'nash-turn'

    # Keyboard focus on disclosures survives a progress-only render.
    page.locator('.work-history summary').focus()
    page.evaluate('tasks => deliverChild(tasks)', [updated, waiting, finished])
    expect(page.locator('.work-history summary')).to_be_focused()
    page.locator('.work-back').click()
    page.locator('#workPanel .work-group').last.locator('summary').click()
    page.evaluate('tasks => deliverChild(tasks)', [updated, waiting, finished])
    assert not page.locator('#workPanel .work-group').last.evaluate('(node)=>node.open')

    # Native tasks can have only a nickname until progress arrives.
    empty = {**child, 'goal': '', 'progress': '', 'history': []}
    page.evaluate('tasks => deliverChild(tasks)', [empty])
    page.locator('#workPanel .work-task').click()
    expect(page.locator('.work-progress')).to_contain_text('尚未收到进展' if chinese else 'No progress reported yet')
    expect(page.locator('.work-history')).to_have_count(0)
    page.locator('#workPanel').screenshot(path=str(output / f'empty-{stem}.png'), animations='disabled')
    page.locator('.work-stop').focus()
    page.keyboard.press('Escape')
    expect(page.locator('#workPanel')).to_be_hidden()
    expect(page.locator('#workPanelToggle')).to_be_focused()

    # Long native/custom names wrap safely, and completed details show the
    # actual result once instead of repeating an old progress message.
    long_task = {**finished, 'title': 'Chandrasekhar · ' + goal * 4}
    page.evaluate('tasks => deliverChild(tasks)', [long_task])
    expect(page.locator('#workPanel')).to_be_hidden()
    page.locator('#workPanelToggle').click()
    page.locator('#workPanel .work-task').click()
    expect(page.locator('.work-progress')).to_contain_text(finished['result'])
    expect(page.locator('.work-detail-section p').filter(has_text=finished['result'])).to_have_count(1)
    expect(page.locator('#workPanelFooter')).to_be_hidden()
    assert page.locator('#workPanelBody').evaluate('(node)=>node.scrollWidth<=node.clientWidth')
    assert not errors, errors
    page.close()


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for theme, width in [('light', 1440), ('dark', 960)]:
        page = browser.new_page(viewport={'width': width, 'height': 900}, color_scheme=theme)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex', wait_until='networkidle')
        page.wait_for_function('uiReady')
        page.locator('[data-sid="shared-fixture"]').click()
        expect(page.locator('#chat')).to_contain_text('Review sample 0')
        page.locator('#input').fill('Keep this parent draft')
        page.evaluate('tasks => deliverChild(tasks)', [task])
        expect(page.locator('#workPanel')).to_be_hidden()
        expect(page.locator('#workPanelBadge')).to_have_text('1')
        expect(page.locator('.subtask-turn-card')).to_have_count(1)
        assert page.locator('.subtask-turn-card').evaluate('(node)=>node.previousElementSibling.messageData.seq') == 1
        page.locator('#workPanelToggle').click()
        page.locator('#workPanel .work-task').click()
        expect(page.locator('#workPanelBody')).to_contain_text('Validate child navigation')
        page.locator('.work-reply textarea').fill('Keep this child draft')
        updated = {**task, 'progress': 'Additional progress'}
        page.evaluate('tasks => deliverChild(tasks)', [updated])
        page.locator('#workPanelClose').click()
        expect(page.locator('#workPanel')).to_be_hidden()
        assert page.evaluate('childCommands.length') == 0, 'closing the panel must not stop a task'
        page.locator('#workPanelToggle').click()
        expect(page.locator('.work-reply textarea')).to_have_value('Keep this child draft')
        page.locator('.work-reply button').click()
        page.wait_for_function('childCommands.length===1')
        payload = page.evaluate('childCommands[0].payload')
        assert payload['sessionId'] == 'shared-fixture' and payload['taskId'] == 'child-1'
        assert payload['operation'] == 'reply' and payload['expectedTurnId'] == 'child-turn'
        page.locator('.work-approval input').fill('CSV')
        page.locator('.work-approval button[type=submit]').click()
        page.wait_for_function('childCommands.length===2')
        payload = page.evaluate('childCommands[1].payload')
        assert payload['operation'] == 'approve' and payload['input'] == {'format': 'CSV'}
        assert payload['approvalId'] == 'req-1' and payload['fingerprint'] == 'fingerprint-1'
        page.get_by_role('button', name='Stop subtask', exact=True).click()
        page.wait_for_function('childCommands.length===3')
        assert page.evaluate('childCommands[2].payload.taskId') == 'child-1'
        expect(page.locator('#input')).to_have_value('Keep this parent draft')
        page.locator('#workPanelClose').click()
        page.evaluate('document.getElementById("chatScroll").scrollTop=0')
        page.locator('.subtask-turn-card summary').click()
        page.evaluate('tasks => deliverChild(tasks)', [updated])
        assert not page.locator('.subtask-turn-card').evaluate('(node)=>node.open')
        expect(page.locator('.subtask-turn-card summary')).to_contain_text('Needs attention')
        completed = {**task, 'id': 'child-2', 'userSeq': 3, 'title': 'Check report', 'status': 'completed',
                     'result': 'Wrote checks.md', 'approvals': [], 'canReply': False, 'canStop': False}
        page.evaluate('tasks => deliverChild(tasks)', [updated, completed])
        assert not page.locator('.subtask-turn-card[data-seq="3"]').evaluate('(node)=>node.open')
        page.locator('#workPanelToggle').click()
        page.get_by_role('button', name='Back to overview', exact=True).click()
        expect(page.locator('.work-artifact')).to_contain_text('checks.md')
        expect(page.locator('.work-artifact')).to_contain_text('Check report')
        # Resolving an older path-only record must update its row when the
        # canonical path becomes available, including after the file changes.
        page.evaluate("""() => {
          window.dshDesktop.resolveArtifacts = async () => ({ok:true,files:[{
            path:'/demo/checks.md',canonicalPath:'/real/demo/checks.md',name:'checks.md',size:2048
          }]});
        }""")
        page.evaluate('tasks => deliverChild(tasks)', [{**completed, 'title': 'Recheck report'}])
        expect(page.locator('.work-artifact')).to_have_count(1)
        expect(page.locator('.work-artifact')).to_contain_text('Recheck report')
        page.evaluate(r"""() => {
          window.dshDesktop.platform = 'win32';
          window.dshDesktop.resolveArtifacts = async request => ({ok:true,files:request.paths.map(path => ({
            path, name:'checks.md', canonicalPath:path.includes('other') ? 'C:\\other\\checks.md' : 'C:\\outputs\\checks.md'
          }))});
        }""")
        alias_tasks = [
            {**completed, 'id': 'alias-1', 'artifacts': [{'path': 'C:/outputs/checks.md'}]},
            {**completed, 'id': 'alias-2', 'artifacts': [{'path': 'c:\\OUTPUTS\\checks.md'}]},
            {**completed, 'id': 'alias-link', 'artifacts': [{'path': 'C:/linked/checks.md'}]},
            {**completed, 'id': 'alias-3', 'artifacts': [{'path': 'C:/other/checks.md'}]},
        ]
        page.evaluate('tasks => deliverChild(tasks)', alias_tasks)
        expect(page.locator('.work-artifact')).to_have_count(3)
        page.evaluate("""() => {
          const emit = event => deliverEvent({session_id:'shared-fixture',engine:'codex',runId:901,...event});
          emit({type:'conversation:started',prompt:'Create report',userSeq:21});
          emit({type:'assistant',message:{content:[{type:'text',text:'[report](C:/outputs/checks.md) [again](C:/outputs/checks.md)'}]}});
          emit({type:'result',subtype:'success',artifacts:[{path:'C:/main-alias/checks.md'}]});
        }""")
        expect(page.locator('.turn').last.locator('.artifact-row')).to_have_count(1)
        expect(page.locator('.work-artifact')).to_have_count(3)
        main_file = page.locator('.work-artifact[title="C:/main-alias/checks.md"]')
        expect(main_file).to_contain_text('Main conversation')
        # A later main-conversation update keeps the count and refreshes the
        # path used by the preview, even when a child reported the file first.
        page.evaluate("""() => {
          const emit = event => deliverEvent({session_id:'shared-fixture',engine:'codex',runId:902,...event});
          emit({type:'conversation:started',prompt:'Update report',userSeq:23});
          emit({type:'assistant',message:{content:[{type:'text',text:'Updated the report.'}]}});
          emit({type:'result',subtype:'success',artifacts:[{path:'C:/updated/checks.md'}]});
          window.dshDesktop.previewFile = async path => {
            window.previewedArtifact = path;
            return {ok:true,file:{path,name:'checks.md',kind:'text',extension:'MD',text:'# Updated report'}};
          };
        }""")
        expect(page.locator('.work-artifact')).to_have_count(3)
        page.locator('.work-artifact[title="C:/updated/checks.md"]').click()
        expect(page.locator('#fileViewer')).to_be_visible()
        assert page.evaluate('previewedArtifact') == 'C:/updated/checks.md'
        expect(page.locator('.file-preview-markdown')).to_contain_text('Updated report')
        page.locator('#fileViewerClose').click()
        page.evaluate('tasks => deliverChild(tasks)', alias_tasks)
        expect(page.locator('.work-artifact')).to_have_count(3)
        panel = page.locator('#workPanel').bounding_box()
        assert 360 <= panel['width'] <= 420
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        output = repo / 'dist/ui-preview'
        output.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(output / f'work-panel-{theme}.png'), animations='disabled')
        page.locator('#workPanelClose').click()
        page.locator('#conversationActions').click()
        expect(page.locator('.action-menu')).to_be_visible()
        assert page.locator('.action-menu').bounding_box()['width'] <= 260
        assert not errors, errors
        page.close()
    for theme, language, width, height in [
        ('light', 'zh', 1440, 900), ('dark', 'zh', 1440, 900),
        ('light', 'en', 960, 700), ('dark', 'en', 960, 700),
        ('light', 'zh', 390, 700), ('dark', 'en', 390, 700),
        ('light', 'en', 740, 420), ('dark', 'zh', 740, 420),
    ]:
        exercise_design(browser, theme, language, width, height)
    browser.close()
print('PASS: child controls and drafts; eight light/dark, Chinese/English, narrow/short viewport cases; live scroll, focus and disclosure persistence; busy controls, long names and completed results')
