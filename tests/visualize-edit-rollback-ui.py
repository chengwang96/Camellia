"""Actual edit/resend rollback preserves a card's frame and state bridge."""
import json
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

repo = Path(__file__).resolve().parents[1]
bridge = r'''(() => {
  const session={id:'edit-card-fixture',title:'Edit card',origin:'codex',currentEngine:'codex',
    workspaceId:null,messages:[{role:'user',seq:1,text:'Earlier request',at:1},
      {role:'assistant',seq:2,engine:'codex',text:'Earlier answer',at:2},
      {role:'user',seq:3,text:'Previous request',at:3},
      {role:'assistant',seq:4,engine:'codex',text:'Previous answer',at:4,userSeq:3,
        requestUsage:{main:{input_tokens:10,output_tokens:1}}}]};
  const settings={model:'fixture-model',permissionMode:'default',connection:'api'};
  window.cardDisposals=0;window.cardSaves=[];window.editPending=false;
  window.dshDesktop={sharedConversations:true,
    onLanguageChanged:()=>()=>{},onEngineSettingsChanged:()=>{},onApiRouterState:()=>{},
    onNetworkHealth:()=>{},onHarnessNavigate:()=>{},onConversationGoal:()=>{},onConversationStatus:()=>{},
    onConversationEvent:fn=>{window.deliverEvent=fn;},
    workbenchSettings:async()=>({ok:true,conversations:{mode:'direct'}}),
    apiRouterGetState:async()=>({enabled:true,models:['fixture-model']}),
    conversationSwitch:async()=>({ok:true}),
    previewFile:async()=>({ok:false,error:'fixture'}),openFileExternally:async()=>({ok:true}),
    visualizeGet:async()=>({ok:true,card:{cardId:'edit-card',title:'Edit card',
      html:'<button id="control">Control</button>',state:{value:0}}}),
    visualizeState:async payload=>{cardSaves.push(payload.state);return {ok:true};},
    conversationCommand:async({action,payload})=>{
      if(action==='list-sessions')return {ok:true,sessions:[{...session,mtimeMs:Date.now()}],workspaces:[],pagination:{}};
      if(action==='load-session')return {ok:true,...structuredClone(session),settings,live:null};
      if(action==='get-settings')return settings;
      if(action==='get-live')return {ok:true,live:null};
      if(action==='goal-get')return {ok:true,goal:null};
      if(action==='task-list')return {ok:true,tasks:[]};
      if(action==='send'){
        if(payload.editSeq!==3)throw Error('Expected the real edit/resend command');
        editPending=true;
        return await new Promise((resolve,reject)=>{window.acceptEdit=resolve;window.rejectEdit=reject;});
      }
      return {ok:true};
    }
  };
})();'''

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        results = []
        for outcome in ['rejected', 'cancelled', 'transport-error', 'accepted', 'navigate-away']:
            page = browser.new_page(viewport={'width': 1200, 'height': 800})
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script(bridge)
            page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=codex',
                      wait_until='networkidle')
            page.wait_for_function('uiReady')
            page.locator('[data-sid="edit-card-fixture"]').click()
            expect(page.locator('#chat')).to_contain_text('Previous answer')
            assert page.evaluate('requestTurns.size') == 1
            page.evaluate('''() => {
              document.querySelectorAll('.turn').item(1).style.setProperty('display','block','important');
              addVisualizeResult({ok:true,visualize:{cardId:'edit-card',title:'Edit card',revision:1}},
                document.querySelectorAll('.turn-body').item(1));
              const card=document.querySelector('.visualize-block');
              const dispose=card.disposeVisualize;
              card.disposeVisualize=()=>{cardDisposals++;dispose();};
              window.cardWeak=new WeakRef(card);
            }''')
            frame = page.frame_locator('.visualize-frame')
            frame.locator('#control').wait_for()
            frame.locator('#control').evaluate('''() => {
              window.cardInstance='original';camelliaVisualize.state.set({value:1});
            }''')
            page.wait_for_function("document.querySelector('.visualize-block').getVisualizeState().value===1")
            page.evaluate("document.querySelector('.visualize-block').flushVisualizeState()")
            page.locator('.msg-user .message-edit').last.click()
            page.locator('.message-editor textarea').fill('Edited request')
            page.locator('.message-editor button.primary').click()
            page.wait_for_function('editPending')
            # Let MutationObserver delivery happen while the backend is pending.
            page.wait_for_timeout(80)
            assert page.evaluate('cardDisposals') == 0, outcome
            expect(page.locator('.visualize-block')).to_be_hidden()

            if outcome == 'navigate-away':
                page.locator('#newSessionBtn').click()
                page.wait_for_function('context.sessionId !== "edit-card-fixture"')
                page.wait_for_function('cardDisposals===1')
                page.evaluate("acceptEdit({ok:false,error:'Rejected after navigation'})")
            elif outcome == 'accepted':
                page.evaluate("acceptEdit({ok:true,runId:9,userSeq:5})")
                page.wait_for_function('cardDisposals===1')
                assert page.evaluate('requestTurns.size') == 0
            else:
                if outcome == 'transport-error':
                    page.evaluate("rejectEdit(new Error('Transport failed'))")
                elif outcome == 'cancelled':
                    page.evaluate("acceptEdit({ok:false,cancelled:true,error:'Cancelled'})")
                else:
                    page.evaluate("acceptEdit({ok:false,error:'Fixture send rejected'})")
                expect(page.locator('.message-editor')).to_be_visible()
                expect(page.locator('.visualize-block')).to_be_visible()
                expect(page.locator('.msg-user')).to_have_count(2)
                expect(page.locator('.msg-user').last).to_be_visible()
                assert page.locator('.turn').last.evaluate(
                    "node => [node.style.getPropertyValue('display'),node.style.getPropertyPriority('display')]") == ['block', 'important']
                assert page.evaluate('cardDisposals') == 0, outcome
                assert page.evaluate('requestTurns.size') == 1, outcome
                assert frame.locator('#control').evaluate('window.cardInstance') == 'original', outcome
                frame.locator('#control').evaluate('camelliaVisualize.state.set({value:2})')
                page.wait_for_function("document.querySelector('.visualize-block').getVisualizeState().value===2")
                page.evaluate("document.querySelector('.visualize-block').flushVisualizeState()")
                assert page.evaluate('cardSaves.at(-1).value') == 2
                # Later permanent navigation must still dispose a restored card.
                page.locator('#newSessionBtn').click()
                page.wait_for_function('cardDisposals===1')
            expect(page.locator('.visualize-block')).to_have_count(0)
            page.wait_for_timeout(80)
            cdp = page.context.new_cdp_session(page)
            cdp.send('HeapProfiler.collectGarbage')
            cdp.send('HeapProfiler.collectGarbage')
            assert page.evaluate('!cardWeak.deref()'), outcome
            assert not errors, errors
            results.append({'outcome': outcome, 'permanentDisposals': 1, 'retainedCards': 0})
            page.close()
        print(json.dumps({'result': 'PASS', 'cases': results,
                          'rollbackStateUpdate': '1 -> 2', 'iframeContextPreserved': True}))
    finally:
        browser.close()
