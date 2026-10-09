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
    'onConversationEvent:fn=>{window.deliverChild=tasks=>fn({type:"gui:subagent",session_id:"shared-fixture",tasks});}')
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
        panel = page.locator('#workPanel').bounding_box()
        assert 320 <= panel['width'] <= 380
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
    browser.close()
print('PASS: child status, scoped reply/approval/stop, attention without auto-opening, parent and child drafts, turn cards, artifact origin, compact menu, light/dark work panel')
