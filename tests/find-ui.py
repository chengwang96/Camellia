"""/find turns the desktop composer into a file search and renders the result. No model calls."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
preview = repo / 'dist/ui-preview'
preview.mkdir(parents=True, exist_ok=True)
fixture = {
    'id': 'shared-fixture', 'title': 'Find the deck', 'origin': 'codex', 'currentEngine': 'codex', 'workspaceId': None,
    'messages': [{'role': 'user', 'text': 'Where is the deck?'}],
}
bridge = r"""(() => {
  const fixture = FIXTURE;
  window.findCalls = [];
  const messages = fixture.messages.slice();
  const engine = new URLSearchParams(location.search).get('harness');
  const settings = {model:'fixture-model',permissionMode:'default',connection:'api'};
  window.dshDesktop = {
    sharedConversations:true,
    onLanguageChanged:fn=>{window.changeLanguage=fn;return()=>{};},
    conversationCommand:async ({action,payload}) => {
      if(action==='list-sessions') return {ok:true,sessions:[{...fixture,mtimeMs:Date.now()}],workspaces:[],pagination:{}};
      if(action==='get-live') return {ok:true,live:null};
      if(action==='load-session') return {ok:true,...fixture,messages,preferences:{mode:'direct',warnOnSwitch:false,showOrigin:false},settings};
      if(action==='get-settings') return settings;
      if(action==='goal-get') return {ok:true,goal:null};
      if(action==='task-list') return {ok:true,tasks:[]};
      if(action==='find') {
        window.findCalls.push(payload);
        const reply = payload.query
          ? 'Found 2 files for "'+payload.query+'":\n\n- `UDP与TCP试讲.pptx` — PPTX · 2.0 KB\n- `UDP与TCP试讲.pdf` — PDF · 1.0 KB'
          : 'Files edited or produced most recently (newest first):\n\n- `UDP与TCP试讲.pptx` — 试讲材料\n- `UDP与TCP试讲.pdf` — 试讲材料';
        messages.push({role:'user',seq:8,text:'/find '+payload.query,displayText:'/find '+payload.query});
        messages.push({role:'assistant',engine:'codex',seq:9,text:reply,artifacts:[{path:'UDP与TCP试讲.pptx'},{path:'UDP与TCP试讲.pdf'}]});
        return {ok:true,sessionId:payload.sessionId,seq:9,query:payload.query,count:2,
          files:[{name:'UDP与TCP试讲.pptx',kind:'presentation',extension:'PPTX',size:2048},
                 {name:'UDP与TCP试讲.pdf',kind:'pdf',extension:'PDF',size:1024}]};
      }
      return {ok:true};
    },
    workbenchSettings:async()=>({conversations:{mode:'direct'}}),
    apiRouterGetState:async()=>({enabled:true,models:['fixture-model']}),
    resolveArtifacts:async({text})=>{
      const names = [...String(text||'').matchAll(/`([^`\n]+)`/g)].map(match => match[1]);
      return {ok:true,files:names.filter(name => /\.[a-z0-9]+$/i.test(name)).map(name => ({
        path:name, name:name.split(/[\\/]/).pop(),
        kind:/\.pptx$/i.test(name)?'presentation':/\.pdf$/i.test(name)?'pdf':'text',
        extension:name.split('.').pop().toUpperCase(), size:2048}))};
    },
    onConversationEvent:()=>{},onConversationGoal:()=>{},onConversationStatus:()=>{},
    onEngineSettingsChanged:()=>{},onApiRouterState:()=>{},openSettingsWindow:()=>{},
    previewFile:async()=>({ok:false,error:'fixture'}),openFileExternally:async()=>({ok:true}),
  };
})();""".replace('FIXTURE', json.dumps(fixture))

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    errors = []
    for theme in ['light', 'dark']:
        page = browser.new_page(viewport={'width': 1100, 'height': 800}, color_scheme=theme)
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.add_init_script(bridge)
        page.goto((repo/'src/renderer/chat/claude.html').as_uri()+'?harness=codex', wait_until='networkidle')
        page.wait_for_function('uiReady')
        page.locator('[data-sid="shared-fixture"]').click()
        expect(page.locator('#chat')).to_contain_text('Where is the deck?')
        expect(page.locator('#findRow')).to_be_hidden()
        # The slash menu offers /find and selecting it enters search mode.
        page.locator('#input').fill('/fi')
        expect(page.locator('.slash-pop')).to_contain_text('/find')
        page.locator('.slash-pop .slash-row', has_text='/find').click()
        expect(page.locator('#findRow')).to_be_visible()
        expect(page.locator('#findRow')).to_contain_text('Find files')
        assert 'describe' in page.locator('#input').get_attribute('placeholder').lower()
        page.screenshot(path=str(preview/f'find-draft-{theme}.png'), animations='disabled')
        # Describing the file answers through the find action, never an engine send.
        page.locator('#input').fill('UDP 试讲')
        page.locator('#input').press('Enter')
        page.wait_for_function('window.findCalls.length === 1')
        assert page.evaluate('findCalls[0].query') == 'UDP 试讲'
        assert page.evaluate('findCalls[0].sessionId') == 'shared-fixture'
        expect(page.locator('#findRow')).to_be_hidden()
        expect(page.locator('#statusLine')).to_contain_text('2 files found')

        # A bare Enter with an empty composer is a valid request: it lists the
        # files recent conversations produced, so nothing needs to be named.
        page.locator('#input').fill('/find')
        page.locator('#input').press('Enter')
        expect(page.locator('#findRow')).to_be_visible()
        assert 'nothing' in page.locator('#input').get_attribute('placeholder').lower()
        page.locator('#input').press('Enter')
        page.wait_for_function('window.findCalls.length === 2')
        assert page.evaluate('findCalls[1].query') == ''
        expect(page.locator('#statusLine')).to_contain_text('files found')
        # The reply renders as a normal turn whose files reach the artifact panel.
        expect(page.locator('#chat')).to_contain_text('Found 2 files for "UDP 试讲"')
        expect(page.locator('#chat')).to_contain_text('/find UDP 试讲')
        # Two searches ran, so the transcript holds two artifact groups.
        expect(page.locator('.turn-artifacts .artifact-row')).to_have_count(4)
        expect(page.locator('.turn-artifacts').first).to_contain_text('UDP与TCP试讲.pptx')
        page.screenshot(path=str(preview/f'find-result-{theme}.png'), animations='disabled', full_page=True)
        assert not errors, errors
        page.close()
    browser.close()
