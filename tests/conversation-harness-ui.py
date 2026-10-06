"""A saved conversation restores its harness; the header selector changes it."""
from pathlib import Path
from playwright.sync_api import expect, sync_playwright


repo = Path(__file__).resolve().parents[1]
url = (repo / 'src/renderer/chat/claude.html').as_uri()
bridge = r"""(() => {
  const settings = {model:'fixture-model',permissionMode:'default',connection:'api'};
  const rows = [
    {id:'codex-session',title:'Codex task',origin:'codex',message:'Codex answer'},
    {id:'claude-session',title:'Claude task',origin:'claude',message:'Claude answer'},
  ];
  const engineFor = row => localStorage.getItem('fixture-harness:' + row.id) || row.origin;
  const session = row => ({id:row.id,title:row.title,origin:row.origin,
    currentEngine:engineFor(row),workspaceId:null,mtimeMs:Date.now(),
    messages:[{role:'assistant',engine:row.origin,text:row.message}]});
  window.switchCalls = [];
  window.dshDesktop = new Proxy({
    sharedConversations:true,
    workbenchSettings:async()=>({ok:true,conversations:{mode:'direct',warnOnSwitch:false,showOrigin:false}}),
    apiRouterGetState:async()=>({enabled:true,models:['fixture-model']}),
    conversationSwitch:async payload=>{
      switchCalls.push(payload);
      if (!payload.navigate && payload.sessionId)
        localStorage.setItem('fixture-harness:' + payload.sessionId, payload.engine);
      return {ok:true};
    },
    conversationCommand:async ({action,payload})=>{
      if (action==='list-sessions') return {ok:true,sessions:rows.map(session),workspaces:[],pagination:{}};
      if (action==='load-session') return {ok:true,...session(rows.find(row=>row.id===payload)),settings,
        preferences:{mode:'direct',warnOnSwitch:false,showOrigin:false}};
      if (action==='get-settings') return settings;
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
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(bridge)

    page.goto(url + '?harness=codex&conversation=codex-session', wait_until='networkidle')
    page.wait_for_function('uiReady && context.sessionId === "codex-session"')
    expect(page.locator('#engineSwitch')).to_have_value('codex')
    expect(page.locator('#chat')).to_contain_text('Codex answer')
    page.locator('#input').fill('Codex unsent draft')
    page.evaluate("""() => {
      attachments = [{name:'codex-notes.txt',path:'D:/codex-notes.txt'}];
      saveDraft();
      writeUi('draft:claude-session', {text:'Claude unsent draft',attachments:[{name:'claude-notes.txt',path:'D:/claude-notes.txt'}]});
      writeUi('queue:claude-session', [{text:'Paused Claude message',attachments:[]}]);
      writeUi('queue-paused:claude-session', true);
    }""")
    page.locator('[data-sid="claude-session"]').click()
    page.wait_for_function('switchCalls.some(call => call.navigate && call.engine === "claude" && call.sessionId === "claude-session")')
    page.wait_for_function('!loadingSession')
    assert page.evaluate('readUi("draft:codex-session").text') == 'Codex unsent draft'
    assert page.evaluate('readUi("draft:claude-session").text') == 'Claude unsent draft'
    assert page.evaluate('readUi("draft:claude-session").attachments[0].name') == 'claude-notes.txt'
    assert page.evaluate('readUi("queue-paused:claude-session")') is True
    assert page.evaluate('localStorage.getItem("fixture-harness:codex-session")') is None

    page.goto(url + '?harness=claude&conversation=claude-session', wait_until='networkidle')
    page.wait_for_function('uiReady && context.sessionId === "claude-session"')
    expect(page.locator('#engineSwitch')).to_have_value('claude')
    expect(page.locator('#chat')).to_contain_text('Claude answer')
    expect(page.locator('#input')).to_have_value('Claude unsent draft')
    expect(page.locator('#attachRow')).to_contain_text('claude-notes.txt')
    assert page.evaluate('messageQueuePaused') is True
    page.locator('[data-sid="codex-session"]').click()
    page.wait_for_function('switchCalls.some(call => call.navigate && call.engine === "codex" && call.sessionId === "codex-session")')
    page.wait_for_function('!loadingSession')
    assert page.evaluate('readUi("draft:codex-session").text') == 'Codex unsent draft'
    assert page.evaluate('readUi("draft:codex-session").attachments[0].name') == 'codex-notes.txt'
    assert page.evaluate('localStorage.getItem("fixture-harness:codex-session")') is None

    page.goto(url + '?harness=codex&conversation=codex-session', wait_until='networkidle')
    page.wait_for_function('uiReady && context.sessionId === "codex-session"')
    expect(page.locator('#engineSwitch')).to_have_value('codex')
    expect(page.locator('#chat')).to_contain_text('Codex answer')
    expect(page.locator('#input')).to_have_value('Codex unsent draft')
    expect(page.locator('#attachRow')).to_contain_text('codex-notes.txt')
    page.select_option('#engineSwitch', 'claude')
    page.wait_for_function('switchCalls.some(call => !call.navigate && call.engine === "claude" && call.sessionId === "codex-session")')
    assert page.evaluate('localStorage.getItem("fixture-harness:codex-session")') == 'claude'

    page.goto(url + '?harness=claude&conversation=codex-session', wait_until='networkidle')
    page.wait_for_function('uiReady && context.sessionId === "codex-session"')
    expect(page.locator('#engineSwitch')).to_have_value('claude')
    expect(page.locator('#chat')).to_contain_text('Codex answer')
    assert not page.evaluate('switchCalls.some(call => call.navigate)'), 'Explicit selection should persist for this conversation'
    assert not errors, errors
    browser.close()

print('PASS: sidebar restores each conversation harness; only the header selector changes the saved harness')
