"""A real MCP-wrapped fetch result renders as the page card."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
output = repo / 'artifacts/web-fetch-card'
output.mkdir(parents=True, exist_ok=True)

page_body = (
    "# safeStorage\n\nAllows access to simple encryption and decryption of strings "
    "for storage on the local machine.\n\nWindows Encryption keys are generated via "
    "DPAPI.\n"
)

# Exactly the shape Codex records: MCP content text wrapping the web-tool JSON.
inner = json.dumps({
    'ok': True,
    'provider': 'deepseek',
    'url': 'https://www.electronjs.org/docs/latest/api/safe-storage',
    'title': 'safeStorage | Electron',
    'content': page_body,
    'truncated': False,
})
envelope = json.dumps({'content': [{'type': 'text', 'text': inner}]})

fixture = {
    'id': 'fetch-envelope', 'title': 'Envelope', 'origin': 'codex',
    'currentEngine': 'codex', 'workspaceId': None,
    'messages': [
        {'role': 'user', 'text': 'What does the safeStorage page say?'},
        {'role': 'assistant', 'engine': 'codex', 'text': 'It documents OS-backed encryption.',
         'process': [
             {'type': 'tool', 'title': 'camellia_web_fetch', 'text': envelope,
              'status': 'completed', 'input': 'https://www.electronjs.org/docs/latest/api/safe-storage'},
         ]},
    ],
}

bridge = r"""(() => {
  const fixture = FIXTURE;
  const settings = {model:'fixture-model',permissionMode:'default',connection:'api'};
  window.dshDesktop = {
    sharedConversations:true,
    onLanguageChanged:fn=>{window.changeLanguage=fn;return()=>{};},
    conversationCommand:async ({action}) => {
      if(action==='list-sessions') return {ok:true,sessions:[{...fixture,mtimeMs:Date.now()}],workspaces:[],pagination:{}};
      if(action==='get-live') return {ok:true,live:null};
      if(action==='load-session') return {ok:true,...fixture,preferences:{mode:'direct',warnOnSwitch:false,showOrigin:false},settings};
      if(action==='get-settings') return settings;
      if(action==='task-list') return {ok:true,tasks:[]};
      return {ok:true};
    },
    workbenchSettings:async()=>({ok:true,conversations:{mode:'direct',warnOnSwitch:false,showOrigin:false}}),
    conversationSwitch:async()=>({ok:true}),
    apiRouterGetState:async()=>({enabled:true,models:['fixture-model']}),
    onConversationEvent:()=>{},onConversationGoal:()=>{},onConversationStatus:()=>{},
    onEngineSettingsChanged:()=>{},onApiRouterState:()=>{},onNetworkHealth:()=>{},onHarnessNavigate:()=>{},openSettingsWindow:()=>{},
    previewFile:async()=>({ok:false,error:'fixture'}),openFileExternally:async()=>({ok:true}),
  };
})();""".replace('FIXTURE', json.dumps(fixture))

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1280, 'height': 900})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error.stack or error)))
    page.add_init_script(bridge)
    page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=codex', wait_until='networkidle')
    page.wait_for_function('uiReady')
    page.locator('[data-sid="fetch-envelope"]').click()
    card = page.locator('.tool-card', has_text='camellia_web_fetch')
    expect(card).to_have_count(1)
    page.evaluate("""() => {
      const card = document.querySelector('.tool-card');
      if (card) card.classList.add('open');
      card?.closest('.execution-process')?.setAttribute('open', '');
    }""")
    # The page card, not the raw MCP envelope, must be what the user sees.
    expect(card.locator('.web-fetch-title')).to_have_text('safeStorage | Electron')
    expect(card.locator('.web-fetch-meta')).to_contain_text('electronjs.org')
    expect(card.locator('.web-fetch-content').first).to_contain_text('DPAPI')
    expect(card.locator('.tool-output')).not_to_contain_text('"content"')
    page.screenshot(path=str(output / 'web-fetch-envelope.png'), animations='disabled')
    assert not errors, errors
