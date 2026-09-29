"""Desktop rendering of the computer-owned mobile queue. No model calls."""
import ast
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
module = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
fixture = ast.literal_eval(next(node.value for node in module.body if isinstance(node, ast.Assign)
                                and any(isinstance(target, ast.Name) and target.id == 'fixture' for target in node.targets)))
node = next(node for node in module.body if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == 'bridge' for target in node.targets))
bridge = ast.literal_eval(node.value.func.value).replace('FIXTURE', json.dumps(fixture))
bridge += r"""
window.queueState = {queue: [
  {id:'q1',text:'Review the completed results <img src=x onerror=alert(1)>',state:'queued',attachments:[{name:'notes.txt'}]},
  {id:'q2',text:'Package the final files',state:'paused',attachments:[]}
],queueVersion:1};
window.queueCommands = [];
window.dshDesktop.onConversationEvent = fn => { window.deliverQueueEvent=fn; };
const originalCommand = window.dshDesktop.conversationCommand;
window.dshDesktop.conversationCommand = async request => {
  const {action,payload} = request;
  if (action==='load-session') return {...await originalCommand(request),id:payload,
    remoteQueue:payload==='shared-fixture'?queueState:{queue:[],queueVersion:queueState.queueVersion}};
  if (action.startsWith('remote-queue-')) {
    queueCommands.push(request);
    if(action==='remote-queue-remove') queueState.queue=queueState.queue.filter(row=>row.id!==payload.queueId);
    if(action==='remote-queue-resume') queueState.queue.forEach(row=>row.state='queued');
    queueState.queueVersion++;
    return {ok:true,...queueState};
  }
  return originalCommand(request);
};
"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    errors = []
    try:
        for theme in ['light', 'dark']:
            page = browser.new_page(viewport={'width': 1100, 'height': 820}, color_scheme=theme)
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script(bridge)
            page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex', wait_until='networkidle')
            page.wait_for_function('uiReady')
            page.locator('[data-sid="shared-fixture"]').click()
            queue = page.locator('#messageQueue')
            expect(queue.locator('.queue-item')).to_have_count(2)
            expect(queue).to_contain_text('Mobile queued')
            assert queue.locator('img').count() == 0
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            resume = queue.get_by_role('button', name='Resume mobile queue')
            assert resume.evaluate('(button) => button.scrollWidth <= button.clientWidth && button.scrollHeight <= button.clientHeight')
            page.screenshot(path=str(repo / 'artifacts' / f'remote-queue-desktop-{theme}.png'))
            queue.get_by_role('button', name='Resume mobile queue').click()
            expect(queue.get_by_role('button', name='Resume mobile queue')).to_have_count(0)
            queue.get_by_role('button', name='Remove from queue').first.click()
            expect(queue.locator('.queue-item')).to_have_count(1)
            assert page.evaluate('queueCommands[1].payload.sessionId') == 'shared-fixture'
            assert page.evaluate('queueCommands[1].payload.queueId') == 'q1'
            page.evaluate("deliverQueueEvent({type:'conversation:remote-queue',session_id:'shared-fixture',queue:[{id:'stale',text:'stale text',state:'queued',attachments:[]}],queueVersion:1})")
            expect(queue).not_to_contain_text('stale text')
            page.locator('[data-sid="another-session"]').click()
            expect(queue).to_be_hidden()
            page.evaluate("deliverQueueEvent({type:'conversation:remote-queue',session_id:'shared-fixture',...queueState})")
            expect(queue).to_be_hidden()
            page.locator('[data-sid="shared-fixture"]').click()
            expect(queue).to_contain_text('Package the final files')
            page.close()
        assert not errors, errors
    finally:
        browser.close()
print('PASS: desktop mobile-queue render, resume/remove, stale events, conversation isolation, and both themes')
