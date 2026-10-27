"""Cross-engine navigation preserves the document, drafts and live conversation."""
from pathlib import Path
from playwright.sync_api import expect, sync_playwright


repo = Path(__file__).resolve().parents[1]
url = (repo / 'src/renderer/chat/claude.html').as_uri()
bridge = r"""(() => {
  const settingsFor = engine => ({model:engine+'-model',permissionMode:engine==='kimi'?'yolo':'default',
    connection:['codex','kimi'].includes(engine)?'subscription':'api'});
  const rows = [
    {id:'codex-session',title:'Codex task',origin:'codex',message:'Codex answer'},
    {id:'claude-session',title:'Claude task',origin:'claude',message:'Claude answer'},
    {id:'kimi-session',title:'Kimi task',origin:'kimi',message:'Kimi answer'},
    {id:'dsh-session',title:'DSH task',origin:'dsh',message:'DSH answer'},
    {id:'antigravity-session',title:'Google task',origin:'antigravity',message:'Google answer'},
    {id:'grok-session',title:'Grok Build task',origin:'grok',message:'Grok Build answer'},
  ];
  const engineFor = row => localStorage.getItem('fixture-harness:' + row.id) || row.origin;
  const session = row => ({id:row.id,title:row.title,origin:row.origin,
    currentEngine:engineFor(row),workspaceId:null,mtimeMs:Date.now(),
    messages:[{role:'assistant',engine:row.origin,text:row.message}]});
  window.switchCalls = [];
  window.receiveEvent = () => {};
  window.dshDesktop = new Proxy({
    sharedConversations:true,
    discussion:async()=>({ok:true,groups:[]}),
    workbenchSettings:async()=>({ok:true,conversations:{mode:'direct',warnOnSwitch:false,showOrigin:false}}),
    apiRouterGetState:async()=>({enabled:true,models:rows.map(row=>row.origin+'-model')}),
    onConversationEvent:callback=>{ window.receiveEvent=callback; },
    codexAccountState:async()=>{
      if (window.holdCodexAccount) {
        window.holdCodexAccount=false;
        await new Promise(resolve=>{ window.releaseAccount=resolve; });
      }
      return {ok:true,models:[{id:'codex-model',name:'Codex account model',supportedReasoningEfforts:['high']}]};
    },
    kimiAccountState:async()=>({ok:true,models:[{id:'kimi-model',name:'Kimi account model',supportedReasoningEfforts:['low','high']}]}),
    conversationSwitch:async payload=>{
      switchCalls.push(payload);
      if (window.failNextSwitch) { window.failNextSwitch=false; return {ok:false,error:'Fixture engine unavailable'}; }
      if (!payload.navigate && payload.sessionId)
        localStorage.setItem('fixture-harness:' + payload.sessionId, payload.engine);
      if (window.delayNextSwitch && payload.navigate) {
        window.delayNextSwitch=false;
        await new Promise(resolve=>{ window.releaseSwitch=resolve; });
      }
      return {ok:true};
    },
    conversationCommand:async ({engine,action,payload})=>{
      if (action==='list-sessions') return {ok:true,sessions:rows.map(session),workspaces:[],pagination:{}};
      if (action==='load-session') {
        const result={ok:true,...session(rows.find(row=>row.id===payload)),settings:settingsFor(engine),
          preferences:{mode:'direct',warnOnSwitch:false,showOrigin:false}};
        if (payload==='kimi-session' && window.fixtureRunning) {
          const event=event=>({session_id:payload,engine:'kimi',runId:42,...event});
          result.activity='running';
          result.live={sessionId:payload,engine:'kimi',workspaceId:null,runId:42,startedAt:Date.now(),
            messages:result.messages,prompt:'Kimi live prompt',eventSeq:3,events:[
              event({type:'stream_event',event:{type:'message_start'}}),
              event({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}}),
              event({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Kimi live answer'}}}),
            ]};
        }
        return result;
      }
      if (action==='get-settings') return settingsFor(engine);
      if (action==='get-live') return {ok:true,live:null};
      if (action==='goal-get') return {ok:true,goal:null};
      if (action==='task-list') return {ok:true,tasks:[]};
      return {ok:true};
    },
  }, {get:(target,key)=>key in target ? target[key]
    : String(key).startsWith('on') ? ()=>()=>{} : async()=>({ok:true})});
})();"""


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page()
    errors = []
    document_loads = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('domcontentloaded', lambda: document_loads.append(page.url))
    page.add_init_script(bridge)

    page.goto(url + '?harness=codex&conversation=codex-session', wait_until='networkidle')
    page.wait_for_function('uiReady && context.sessionId === "codex-session"')
    page.evaluate('window.originalSidebar = document.getElementById("sidebar")')
    expect(page.locator('#engineSwitch')).to_have_value('codex')
    expect(page.locator('#chat')).to_contain_text('Codex answer')
    page.locator('#input').fill('Codex unsent draft')
    page.evaluate('holdCodexAccount = true; void loadSettings()')
    page.wait_for_function('typeof releaseAccount === "function"')
    page.evaluate("""() => {
      attachments = [{name:'codex-notes.txt',path:'D:/codex-notes.txt'}];
      saveDraft();
      writeUi('draft:claude-session', {text:'Claude unsent draft',attachments:[{name:'claude-notes.txt',path:'D:/claude-notes.txt'}]});
      writeUi('queue:claude-session', [{text:'Paused Claude message',attachments:[]}]);
      writeUi('queue-paused:claude-session', true);
    }""")
    page.locator('[data-sid="claude-session"]').click()
    page.wait_for_function('harnessId === "claude" && !loadingSession')
    page.evaluate('releaseAccount()')
    page.wait_for_function('currentModel === "claude-model" && accountModels.length === 0')
    assert page.evaluate('readUi("draft:codex-session").text') == 'Codex unsent draft'
    assert page.evaluate('readUi("draft:claude-session").text') == 'Claude unsent draft', page.evaluate('({draft:readUi("draft:claude-session"),status:statusLine.textContent})')
    assert page.evaluate('readUi("draft:claude-session").attachments[0].name') == 'claude-notes.txt'
    assert page.evaluate('readUi("queue-paused:claude-session")') is True
    assert page.evaluate('localStorage.getItem("fixture-harness:codex-session")') is None

    page.wait_for_function('uiReady && context.sessionId === "claude-session"')
    expect(page.locator('#engineSwitch')).to_have_value('claude')
    expect(page.locator('#chat')).to_contain_text('Claude answer')
    expect(page.locator('#input')).to_have_value('Claude unsent draft')
    expect(page.locator('#attachRow')).to_contain_text('claude-notes.txt')
    assert page.evaluate('messageQueuePaused') is True
    page.locator('[data-sid="codex-session"]').click()
    page.wait_for_function('harnessId === "codex" && !loadingSession')
    assert page.evaluate('readUi("draft:codex-session").text') == 'Codex unsent draft'
    assert page.evaluate('readUi("draft:codex-session").attachments[0].name') == 'codex-notes.txt'
    assert page.evaluate('localStorage.getItem("fixture-harness:codex-session")') is None

    page.wait_for_function('uiReady && context.sessionId === "codex-session"')
    expect(page.locator('#engineSwitch')).to_have_value('codex')
    expect(page.locator('#chat')).to_contain_text('Codex answer')
    expect(page.locator('#input')).to_have_value('Codex unsent draft')
    expect(page.locator('#attachRow')).to_contain_text('codex-notes.txt')
    page.select_option('#engineSwitch', 'claude')
    page.wait_for_function('switchCalls.some(call => !call.navigate && call.engine === "claude" && call.sessionId === "codex-session")')
    assert page.evaluate('localStorage.getItem("fixture-harness:codex-session")') == 'claude'

    page.wait_for_function('uiReady && harnessId === "claude" && !loadingSession && !switchingEngine')
    expect(page.locator('#engineSwitch')).to_have_value('claude')
    expect(page.locator('#chat')).to_contain_text('Codex answer')
    assert page.evaluate('switchCalls.every(call => call.inPlace)'), 'Every switch must stay in the same document'
    for engine, name in [('kimi', 'Kimi Code'), ('dsh', 'DeepSeek Harness'), ('antigravity', 'Antigravity'), ('grok', 'Grok Build')]:
        page.locator(f'[data-sid="{engine}-session"]').click()
        page.wait_for_function(f'harnessId === "{engine}" && !loadingSession')
        expect(page.locator('#engineSwitch')).to_have_value(engine)
        expect(page).to_have_title(name + ' — Camellia')
        expect(page.locator('#input')).to_have_attribute('placeholder', 'Message ' + name)
        page.wait_for_function(f'currentModel === "{engine}-model"')
        assert page.locator('#selPermission option').evaluate_all('(options)=>options.map(option=>option.value)') == ['ask', 'auto', 'full']
        expect(page.locator('#selPermission')).to_have_value('full' if engine == 'kimi' else 'ask' if engine == 'antigravity' else 'auto' if engine == 'dsh' else 'ask')
        assert page.evaluate('new URLSearchParams(location.search).get("conversation")') == engine + '-session'

    # A late cross-engine open must not overwrite the conversation selected next.
    page.evaluate('delayNextSwitch = true')
    page.locator('[data-sid="kimi-session"]').click()
    page.wait_for_function('typeof releaseSwitch === "function"')
    page.locator('[data-sid="grok-session"]').click()
    page.wait_for_function('harnessId === "grok" && context.sessionId === "grok-session" && !loadingSession')
    page.evaluate('releaseSwitch()')
    page.evaluate('() => new Promise(resolve => requestAnimationFrame(resolve))')
    assert page.evaluate('harnessId') == 'grok'

    # Failed navigation must not replace the target's stored draft with blanks.
    page.evaluate("failNextSwitch=true; writeUi('draft:kimi-session',{text:'Kimi retained draft',attachments:[]})")
    page.locator('[data-sid="kimi-session"]').click()
    page.wait_for_function('!loadingSession && statusLine.textContent.includes("Fixture engine unavailable")')
    assert page.evaluate('readUi("draft:kimi-session").text') == 'Kimi retained draft'
    expect(page.locator('#input')).to_have_value('Kimi retained draft')
    assert page.evaluate('harnessId') == 'grok'

    # Running conversations restore their snapshot and continue receiving events.
    page.evaluate('fixtureRunning = true')
    page.locator('[data-sid="kimi-session"]').click()
    page.wait_for_function('harnessId === "kimi" && running && !loadingSession')
    expect(page.locator('#chat')).to_contain_text('Kimi live answer')
    page.evaluate("receiveEvent({type:'stream_event',session_id:'kimi-session',engine:'kimi',runId:42,eventSeq:4,event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:' still streaming'}}})")
    expect(page.locator('#chat')).to_contain_text('Kimi live answer still streaming')
    expect(page.locator('#engineSwitch')).to_be_disabled()
    page.locator('[data-sid="codex-session"]').click()
    page.wait_for_function('harnessId === "claude" && !loadingSession')
    expect(page.locator('#input')).to_have_value('Codex unsent draft')
    assert len(document_loads) == 1, document_loads
    assert page.evaluate('originalSidebar === document.getElementById("sidebar")')
    assert not errors, errors
    browser.close()

print('PASS: all six engines switch without reloading; drafts, permissions, rapid navigation and live output stay correct')
