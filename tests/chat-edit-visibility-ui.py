"""The inline edit actions stay reachable without scrolling the transcript."""

import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


repo = Path(__file__).resolve().parents[1]
session = {
    'id': 'edit-visibility', 'title': 'Interrupted conversation',
    'origin': 'codex', 'currentEngine': 'codex', 'workspaceId': None,
    'messages': [
        {'role': 'user', 'seq': 1, 'text': 'Previous request', 'at': 1},
        {'role': 'assistant', 'engine': 'codex', 'text': 'Previous answer', 'at': 2},
        {'role': 'user', 'seq': 3, 'text': 'Please continue', 'at': 3},
        {'role': 'assistant', 'engine': 'codex', 'text': '', 'at': 4},
    ],
    'interrupted': True,
}
bridge = r"""(() => {
  const session = FIXTURE;
  const settings = {model:'fixture-model',permissionMode:'default',connection:'api'};
  window.dshDesktop = {
    sharedConversations:true,
    onLanguageChanged:()=>()=>{},
    conversationCommand:async ({action}) => {
      if(action==='list-sessions') return {ok:true,sessions:[{...session,mtimeMs:Date.now()}],workspaces:[],pagination:{}};
      if(action==='load-session') return {ok:true,...session,preferences:{mode:'direct',warnOnSwitch:false,showOrigin:false},settings,live:null};
      if(action==='get-live') return {ok:true,live:null};
      if(action==='get-settings') return settings;
      if(action==='goal-get') return {ok:true,goal:null};
      if(action==='task-list') return {ok:true,tasks:[]};
      return {ok:true};
    },
    workbenchSettings:async()=>({ok:true,conversations:{mode:'direct',warnOnSwitch:false,showOrigin:false}}),
    conversationSwitch:async()=>({ok:true}),
    apiRouterGetState:async()=>({enabled:true,models:['fixture-model']}),
    onConversationEvent:()=>{},onConversationGoal:()=>{},onConversationStatus:()=>{},
    onEngineSettingsChanged:()=>{},onApiRouterState:()=>{},onNetworkHealth:()=>{},
    onHarnessNavigate:()=>{},openSettingsWindow:()=>{},
    previewFile:async()=>({ok:false,error:'fixture'}),openFileExternally:async()=>({ok:true}),
  };
})();"""


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    errors = []
    cases = [(1200, 760, False, None), (960, 600, False, None),
             (960, 600, True, 'stopped'), (1200, 760, False, 'error')]
    for width, height, long_prompt, result in cases:
        current_session = json.loads(json.dumps(session))
        if result:
            current_session['interrupted'] = False
            last = current_session['messages'][-1]
            last['text'] = 'Compaction failed' if result == 'error' else ''
            last['runResult'] = {'subtype': result, 'is_error': True, 'result': last['text']}
        page = browser.new_page(viewport={'width': width, 'height': height})
        page.on('pageerror', lambda event: errors.append(str(event)))
        page.add_init_script(bridge.replace('FIXTURE', json.dumps(current_session)))
        page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex', wait_until='networkidle')
        page.wait_for_function('uiReady')
        page.locator('[data-sid="edit-visibility"]').click()
        if result:
            expect(page.locator('#chat .run-result.err')).to_have_count(1)
        else:
            expect(page.locator('#statusLine')).to_contain_text('interrupted')
        if long_prompt:
            page.locator('.msg-user').last.evaluate('(node) => node.messageData.text = "A longer message.\\n".repeat(40)')
        page.locator('.msg-user').last.hover()
        page.locator('.msg-user .message-edit').last.click()
        expect(page.locator('.message-editor button.primary')).to_be_visible()
        assert page.locator('.message-editor textarea').evaluate('(node) => document.activeElement === node')
        if not long_prompt:
            page.locator('.message-editor textarea').fill('An expanded message.\n' * 40)
        page.wait_for_timeout(50)
        positions = page.evaluate('''() => {
          const scroll = chatScroll.getBoundingClientRect();
          const button = document.querySelector('.message-editor button.primary');
          const send = button.getBoundingClientRect();
          const composer = document.querySelector('.input-zone').getBoundingClientRect();
          const hit = document.elementFromPoint(send.left + send.width / 2, send.top + send.height / 2);
          return {scrollTop: scroll.top, scrollBottom: scroll.bottom,
            sendTop: send.top, sendBottom: send.bottom, composerTop: composer.top,
            buttonHit: hit === button || button.contains(hit)};
        }''')
        assert positions['sendTop'] >= positions['scrollTop'], positions
        assert positions['sendBottom'] <= positions['scrollBottom'], positions
        assert positions['sendBottom'] <= positions['composerTop'], positions
        assert positions['buttonHit'], positions
        page.evaluate("showMessageEditStatus(editingMessage, 'Could not resend', true)")
        positions = page.evaluate('''() => {
          const scroll = chatScroll.getBoundingClientRect();
          const send = document.querySelector('.message-editor button.primary').getBoundingClientRect();
          return {scrollBottom: scroll.bottom, sendBottom: send.bottom};
        }''')
        assert positions['sendBottom'] <= positions['scrollBottom'], positions
        page.close()
    browser.close()
    assert not errors, errors

print('PASS: inline edit send button is visible without transcript scrolling')
