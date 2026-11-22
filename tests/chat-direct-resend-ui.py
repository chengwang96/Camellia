"""The latest user message can resend its exact text and attachments."""

import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


repo = Path(__file__).resolve().parents[1]
preview = repo / 'dist/ui-preview'
preview.mkdir(parents=True, exist_ok=True)
session = {
    'id': 'direct-resend', 'title': 'Remember these things',
    'origin': 'codex', 'currentEngine': 'codex', 'workspaceId': None,
    'messages': [
        {'role': 'user', 'seq': 1, 'text': 'Remember these things', 'at': 1,
         'attachments': [{'name': 'mobile-image-3.jpg', 'path': 'D:/Fixture/mobile-image-3.jpg', 'isImage': True}]},
        {'role': 'assistant', 'engine': 'codex', 'text': 'I will keep them.', 'at': 2},
    ],
}
bridge = r"""(() => {
  const session = FIXTURE;
  const settings = {model:'fixture-model',permissionMode:'default',connection:'api'};
  window.sent = [];
  window.dshDesktop = {
    sharedConversations:true,
    onLanguageChanged:()=>()=>{},
    conversationCommand:async ({action,payload}) => {
      if(action==='list-sessions') return {ok:true,sessions:[{...session,mtimeMs:Date.now()}],workspaces:[],pagination:{}};
      if(action==='load-session') return {ok:true,...session,preferences:{mode:'direct',warnOnSwitch:false,showOrigin:false},settings,live:null};
      if(action==='get-live') return {ok:true,live:null};
      if(action==='get-settings') return settings;
      if(action==='goal-get') return {ok:true,goal:null};
      if(action==='task-list') return {ok:true,tasks:[]};
      if(action==='send') {
        window.sent.push(payload);
        return {ok:true,sessionId:'direct-resend',runId:9,userSeq:3};
      }
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
    for width, height, language in [(960, 760, 'en'), (390, 760, 'zh-CN')]:
        page = browser.new_page(viewport={'width': width, 'height': height})
        page.on('pageerror', lambda event: errors.append(str(event)))
        page.add_init_script(bridge.replace('FIXTURE', json.dumps(session)))
        page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=codex&conversation=direct-resend',
                  wait_until='networkidle')
        page.wait_for_function('uiReady && !loadingSession')
        if language != 'en':
            page.evaluate('language => CamelliaI18n.setLanguage(language)', language)
        user = page.locator('.msg-user').last
        user.hover()
        resend = user.locator('.message-resend')
        expect(resend).to_be_visible()
        expect(resend).to_have_attribute('title', 'Resend message' if language == 'en' else '重新发送消息')
        page.screenshot(path=str(preview / f'direct-resend-{width}.png'), animations='disabled')
        resend.click()
        page.wait_for_function('sent.length === 1 && !sending')
        assert page.evaluate('sent[0].editSeq') == 1
        assert page.evaluate('sent[0].displayText') == 'Remember these things'
        assert page.evaluate('sent[0].attachments[0].path') == 'D:/Fixture/mobile-image-3.jpg'
        expect(page.locator('.message-editor')).to_have_count(0)
        page.close()
    assert not errors, errors
    browser.close()

print('PASS: direct resend reuses the edit/resend path without opening the editor')
