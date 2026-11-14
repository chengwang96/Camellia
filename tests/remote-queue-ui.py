"""Desktop rendering of the computer-owned mixed message queue. No model calls."""
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
  {id:'d1',source:'desktop',text:'Computer queued first',state:'queued',at:1,order:1,attachments:[{name:'desktop.txt',path:'D:/Fixture/desktop.txt'}]},
  {id:'q1',source:'mobile',text:'Review the completed results <img src=x onerror=alert(1)>',state:'queued',at:2,order:2,attachments:[{name:'notes.txt'}]},
  {id:'q2',source:'mobile',text:'Package the final files',state:'paused',at:3,order:3,attachments:[]}
],queueVersion:1};
window.queueCommands = [];
window.dshDesktop.onConversationEvent = fn => { window.deliverQueueEvent=fn; };
const originalCommand = window.dshDesktop.conversationCommand;
window.dshDesktop.conversationCommand = async request => {
  const {action,payload} = request;
  if (action==='load-session') return {...await originalCommand(request),id:payload,
    remoteQueue:payload==='shared-fixture'?queueState:{queue:[],queueVersion:queueState.queueVersion}};
  if (action==='message-queue-add') {
    queueState.queue.push({id:'d2',source:'desktop',text:payload.displayText,state:'queued',
      at:Date.now(),order:Date.now(),attachments:payload.attachments||[]});
    queueState.queueVersion++;
    return {ok:true,state:'queued',queueId:'d2',...queueState};
  }
  if (action==='message-queue-edit') {
    queueCommands.push(request);
    const entry=queueState.queue.find(entry=>entry.id===payload.queueId);
    if(!entry || entry.text!==payload.expectedText) return {ok:false,error:'Queued message changed; refresh before editing it'};
    entry.text=payload.prompt.trim();
    queueState.queueVersion++;
    return {ok:true,...queueState};
  }
  if (action==='message-queue-steer') {
    queueCommands.push(request);
    queueState.queue=queueState.queue.filter(row=>row.id!==payload.queueId);
    queueState.queueVersion++;
    return {ok:true,...queueState};
  }
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
            page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=codex', wait_until='networkidle')
            page.wait_for_function('uiReady')
            page.locator('[data-sid="shared-fixture"]').click()
            queue = page.locator('#messageQueue')
            expect(queue.locator('.queue-item')).to_have_count(3)
            expect(queue).to_contain_text('Mobile queued')
            expect(queue.locator('.queue-text')).to_have_text([
              'Computer queued first',
              'Review the completed results <img src=x onerror=alert(1)>',
              'Package the final files',
            ])
            assert queue.locator('.queue-item').nth(0).get_attribute('data-source') == 'desktop'
            assert queue.locator('.queue-item').nth(1).get_attribute('data-source') == 'mobile'
            expect(queue.locator('.queue-item').nth(0).locator('.queue-index').first).to_have_text('Computer queued 1')
            expect(queue.locator('.queue-item').nth(1).locator('.queue-index').first).to_have_text('Mobile queued 2')
            expect(queue.locator('.queue-item').nth(0).locator('.queue-edit')).to_have_count(1)
            expect(queue.locator('.queue-item').nth(1).locator('.queue-edit')).to_have_count(1)
            expect(queue.locator('.queue-item').nth(1).locator('.queue-steer')).to_have_count(1)
            assert queue.locator('img').count() == 0
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')

            # Editing either source must preserve the composer draft and leave
            # the original entry in place even when the editor is cancelled.
            page.locator('#input').fill('Keep my unsent draft')
            queue.locator('.queue-edit').nth(1).click()
            editor = page.get_by_role('dialog', name='Edit queued message')
            expect(editor).to_contain_text('Mobile queued')
            expect(editor).to_contain_text('notes.txt')
            expect(editor.get_by_role('textbox')).to_have_value('Review the completed results <img src=x onerror=alert(1)>')
            editor.get_by_role('textbox').fill('Phone revised on computer')
            editor.get_by_role('button', name='Cancel', exact=True).click()
            expect(queue.locator('.queue-text').nth(1)).to_have_text('Review the completed results <img src=x onerror=alert(1)>')
            queue.locator('.queue-edit').nth(1).click()
            editor.get_by_role('textbox').fill('Phone revised on computer')
            editor.get_by_role('button', name='Save', exact=True).click()
            expect(editor).to_have_count(0)
            expect(queue.locator('.queue-text').nth(1)).to_have_text('Phone revised on computer')
            expect(page.locator('#input')).to_have_value('Keep my unsent draft')
            assert page.evaluate("queueState.queue[1].source==='mobile' && queueState.queue[1].order===2 && queueState.queue[1].attachments[0].name==='notes.txt'")

            # A newer edit arriving from the phone wins over the open editor.
            queue.locator('.queue-edit').nth(1).click()
            editor.get_by_role('textbox').fill('Stale overwrite')
            page.evaluate("queueState.queue[1].text='Newer phone edit';queueState.queueVersion++;deliverQueueEvent({type:'conversation:remote-queue',session_id:'shared-fixture',...queueState})")
            editor.get_by_role('button', name='Save', exact=True).click()
            expect(editor.get_by_role('status')).to_contain_text('Queued message changed')
            editor.get_by_role('button', name='Cancel', exact=True).click()
            expect(queue.locator('.queue-text').nth(1)).to_have_text('Newer phone edit')

            resume = queue.get_by_role('button', name='Resume mobile queue')
            assert resume.evaluate('(button) => button.scrollWidth <= button.clientWidth && button.scrollHeight <= button.clientHeight')
            page.screenshot(path=str(repo / 'artifacts' / f'remote-queue-desktop-{theme}.png'))
            queue.get_by_role('button', name='Resume mobile queue').click()
            expect(queue.get_by_role('button', name='Resume mobile queue')).to_have_count(0)
            queue.get_by_role('button', name='Remove from queue').first.click()
            expect(queue.locator('.queue-item')).to_have_count(2)
            assert page.evaluate('queueCommands.at(-1).payload.sessionId') == 'shared-fixture'
            assert page.evaluate('queueCommands.at(-1).payload.queueId') == 'd1'
            page.evaluate("deliverQueueEvent({type:'conversation:remote-queue',session_id:'shared-fixture',queue:[{id:'stale',text:'stale text',state:'queued',attachments:[]}],queueVersion:1})")
            expect(queue).not_to_contain_text('stale text')
            page.locator('[data-sid="another-session"]').click()
            expect(queue).to_be_hidden()
            page.evaluate("deliverQueueEvent({type:'conversation:remote-queue',session_id:'shared-fixture',...queueState})")
            expect(queue).to_be_hidden()
            page.locator('[data-sid="shared-fixture"]').click()
            expect(queue).to_contain_text('Package the final files')
            page.wait_for_function('!loadingSession')
            page.evaluate("input.value='Computer added now'; queueComposerMessage()")
            expect(queue.locator('.queue-text')).to_have_text([
              'Newer phone edit',
              'Package the final files',
              'Computer added now',
            ])
            expect(queue.locator('.queue-item').nth(2).locator('.queue-index').first).to_have_text('Computer queued 3')
            assert page.evaluate("messageQueue.length") == 0
            queue.locator('.queue-item').nth(2).locator('.queue-edit').click()
            expect(editor).to_contain_text('Computer queued')
            editor.get_by_role('textbox').fill('Computer revised in place')
            editor.get_by_role('button', name='Save', exact=True).click()
            expect(queue.locator('.queue-text').nth(2)).to_have_text('Computer revised in place')
            assert queue.locator('.queue-item').nth(2).get_attribute('data-source') == 'desktop'
            expect(queue.locator('.queue-item')).to_have_count(3)

            page.locator('#input').fill('Keep this draft during insert')
            page.evaluate('running=true; currentRunId=12; updateSendEnabled()')
            expect(queue.locator('.queue-steer').first).to_be_enabled()
            queue.locator('.queue-steer').first.click()
            expect(queue.locator('.queue-item')).to_have_count(2)
            assert page.evaluate("queueCommands.at(-1).action==='message-queue-steer' && queueCommands.at(-1).payload.queueId==='q1' && queueCommands.at(-1).payload.runId===12")
            expect(page.locator('#input')).to_have_value('Keep this draft during insert')
            expect(queue.locator('.queue-text')).to_have_text(['Package the final files', 'Computer revised in place'])
            page.evaluate("queueState.queue[0].state='starting';queueState.queueVersion++;deliverQueueEvent({type:'conversation:remote-queue',session_id:'shared-fixture',...queueState})")
            for button in ['.queue-edit', '.queue-steer', '.queue-remove']:
                expect(queue.locator('.queue-item').first.locator(button)).to_be_disabled()
            page.close()
        assert not errors, errors
    finally:
        browser.close()
print('PASS: mixed-queue source labels, in-place cross-device editing, stale edit conflicts, insert, draft preservation, starting guards, isolation, and both themes')
