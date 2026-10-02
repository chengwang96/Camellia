"""Codex subscription speed toggle in the real renderer. No model calls."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
preview = repo / 'dist/ui-preview'
preview.mkdir(parents=True, exist_ok=True)

bridge = r"""(() => {
  const engine = new URLSearchParams(location.search).get('harness');
  const defaults = {model:'gpt-6-astra',connection:'subscription',permissionMode:'default',thinkingBudget:'max',fastMode:false,subscriptionId:'account-a'};
  const settings = id => ({...defaults,...JSON.parse(localStorage.getItem('speed-fixture:'+id)||'{}')});
  const rows = ['session-a','session-b'].map(id=>({id,title:id==='session-a'?'Fast mode check':'Another conversation',mtimeMs:Date.now(),currentEngine:engine,origin:engine}));
  window.savedSpeedSettings = []; window.sentSpeedMessages = []; window.accountReads = [];
  window.failNextSave = false;
  const account = payload => {
    window.accountReads.push(payload);
    return {ok:true,account:{type:'chatgpt'},models:[
      {id:'gpt-6-astra',name:'GPT-6 Astra',supportedReasoningEfforts:[{reasoningEffort:'max'}],serviceTiers:[{id:'priority',name:'Fast',description:'2x speed, increased usage'}]},
      {id:'standard-model',name:'Standard model',serviceTiers:[]},
    ]};
  };
  window.dshDesktop = {
    sharedConversations:true,
    onLanguageChanged:()=>{}, workbenchSettings:async()=>({ok:true,language:'zh-CN'}),
    conversationCommand:async({action,payload})=>{
      const id=payload?.sessionId;
      if(action==='list-sessions')return {ok:true,sessions:rows,workspaces:[],pagination:{}};
      if(action==='get-live')return {ok:true,live:null};
      if(action==='goal-get')return {ok:true,goal:null};
      if(action==='get-settings')return settings(id);
      if(action==='load-session')return {ok:true,...(rows.find(r=>r.id===payload)||rows[0]),messages:[],settings:settings(payload)};
      if(action==='save-settings'){
        if(window.failNextSave){window.failNextSave=false;return {ok:false,error:'Fixture save failed'};}
        window.savedSpeedSettings.push(payload);
        const next={...settings(id),...payload};
        localStorage.setItem('speed-fixture:'+id,JSON.stringify(next));
        return {ok:true,settings:next};
      }
      if(action==='send'){
        window.sentSpeedMessages.push(payload);
        const nextId=id||'session-new';
        localStorage.setItem('speed-fixture:'+nextId,JSON.stringify({...settings(id),fastMode:payload.fastMode??settings(id).fastMode}));
        return {ok:true,sessionId:nextId,runId:1,userSeq:1};
      }
      return {ok:true};
    },
    codexAccountState:async payload=>account(payload),kimiAccountState:async()=>account(),antigravityAccountState:async()=>account(),
    apiRouterGetState:async()=>({enabled:true,models:['api-model']}),
    onConversationEvent:()=>{},onConversationGoal:()=>{},onConversationStatus:()=>{},
    onEngineSettingsChanged:()=>{},onApiRouterState:()=>{},onNetworkHealth:()=>{},onHarnessNavigate:()=>{},openSettingsWindow:()=>{},
    previewFile:async()=>({ok:false}),openFileExternally:async()=>({ok:true}),
  };
})();"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    errors = []
    try:
        for width, theme in [(1440, 'light'), (960, 'dark'), (720, 'light')]:
            page = browser.new_page(viewport={'width': width, 'height': 800}, color_scheme=theme)
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script(bridge)
            url = (repo/'src/renderer/chat/claude.html').as_uri()+'?harness=codex&conversation=session-a'
            page.goto(url, wait_until='networkidle')
            page.wait_for_function('uiReady && !loadingSession')
            toggle = page.locator('#fastModeToggle')
            expect(toggle).to_be_visible()
            expect(toggle).to_have_attribute('aria-pressed', 'false')
            assert page.evaluate('accountReads.at(-1).id') == 'account-a'
            assert '2 倍速度' in toggle.get_attribute('title')
            before = page.locator('#modelPill').bounding_box()
            button = toggle.bounding_box()
            assert button['x'] + button['width'] <= before['x'], (button, before)
            assert abs(button['y'] + button['height']/2 - before['y'] - before['height']/2) < 1
            save_count = page.evaluate('savedSpeedSettings.length')
            toggle.click()
            expect(toggle).to_have_attribute('aria-pressed', 'true')
            after = page.locator('#modelPill').bounding_box()
            assert before == after, 'Toggling speed must not shift the model selector'
            assert page.evaluate('savedSpeedSettings.length') == save_count + 1
            assert page.evaluate('savedSpeedSettings.at(-1).sessionId') == 'session-a'
            assert page.evaluate('sentSpeedMessages.length') == 0
            assert '消耗更多订阅额度' in toggle.get_attribute('title')
            page.screenshot(path=str(preview/f'codex-fast-mode-{width}-{theme}.png'), animations='disabled')
            # Persistence and a keyboard toggle while a response is running.
            page.reload(wait_until='networkidle')
            page.wait_for_function('uiReady && !loadingSession')
            expect(toggle).to_have_attribute('aria-pressed', 'true')
            page.evaluate('running=true; updateConversationControls()')
            expect(toggle).to_be_enabled()
            toggle.focus()
            page.keyboard.press('Space')
            expect(toggle).to_have_attribute('aria-pressed', 'false')
            page.evaluate('running=false; updateConversationControls(); failNextSave=true')
            toggle.click()
            expect(page.locator('#statusLine')).to_contain_text('Fixture save failed')
            expect(toggle).to_have_attribute('aria-pressed', 'false')
            expect(toggle).to_be_enabled()
            # Unsupported models and API routes hide the button.
            page.evaluate('persistModel("standard-model")')
            expect(toggle).to_be_hidden()
            page.evaluate('persistModel("api-model")')
            expect(toggle).to_be_hidden()
            page.evaluate('persistModel("gpt-6-astra")')
            expect(toggle).to_be_visible()
            # A different conversation keeps its own preference.
            toggle.click()
            expect(toggle).to_have_attribute('aria-pressed', 'true')
            page.locator('[data-sid="session-b"]').click()
            page.wait_for_function('context.sessionId==="session-b" && !loadingSession')
            expect(toggle).to_have_attribute('aria-pressed', 'false')
            page.locator('[data-sid="session-a"]').click()
            page.wait_for_function('context.sessionId==="session-a" && !loadingSession')
            expect(toggle).to_have_attribute('aria-pressed', 'true')
            # A new draft defaults off; selecting fast before its first message is retained.
            page.locator('#newSessionBtn').click()
            page.wait_for_function('context.sessionId===null && !loadingSession')
            expect(toggle).to_have_attribute('aria-pressed', 'false')
            toggle.click()
            expect(toggle).to_have_attribute('aria-pressed', 'true')
            page.goto((repo/'src/renderer/chat/claude.html').as_uri()+'?harness=codex', wait_until='networkidle')
            page.wait_for_function('uiReady && !loadingSession && context.sessionId===null')
            expect(toggle).to_have_attribute('aria-pressed', 'true')
            page.locator('#input').fill('Check fast mode')
            page.locator('#send').click()
            page.wait_for_function('context.sessionId==="session-new" && !sending')
            assert page.evaluate('sentSpeedMessages.at(-1).fastMode') is True
            page.locator('#newSessionBtn').click()
            page.wait_for_function('context.sessionId===null && !loadingSession')
            expect(toggle).to_have_attribute('aria-pressed', 'false')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.close()
        for engine in ['claude', 'dsh', 'kimi', 'antigravity', 'pi']:
            page = browser.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script(bridge)
            page.goto((repo/'src/renderer/chat/claude.html').as_uri()+f'?harness={engine}', wait_until='networkidle')
            page.wait_for_function('uiReady')
            expect(page.locator('#fastModeToggle')).to_be_hidden()
            page.close()
        assert not errors, errors
        print('PASS: placement, themes, keyboard, persistence, next-turn changes, draft first send, failure recovery and engine/model eligibility')
    finally:
        browser.close()
