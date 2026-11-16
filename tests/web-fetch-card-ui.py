"""Structured page-fetch output renders as a readable page card in history."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
output = repo / 'artifacts/web-fetch-card'
output.mkdir(parents=True, exist_ok=True)

body = (
    "# Getting started\n\n"
    "Electron's safeStorage API encrypts a small string with the platform's "
    "credential store. On Windows it uses DPAPI, whose key is bound to the "
    "current user profile.\n\n"
    "Call isEncryptionAvailable() before writing. On Linux desktops without a "
    "keyring, Electron may fall back to a weak backend.\n\n"
    "The API does not protect against malware running as the same user.\n"
) * 12

fetch_output = json.dumps({
    'ok': True,
    'provider': 'local',
    'url': 'https://www.electronjs.org/docs/latest/api/safe-storage',
    'final_url': 'https://www.electronjs.org/docs/latest/api/safe-storage',
    'title': 'safeStorage | Electron',
    'content': body,
    'truncated': False,
    'fallback_from': 'deepseek',
    'fallback_reason': 'web_page_unavailable',
    'connection_mode': 'auto',
})

fixture = {
    'id': 'web-fetch-fixture', 'title': 'Fetch a page', 'origin': 'claude',
    'currentEngine': 'claude', 'workspaceId': None,
    'messages': [
        {'role': 'user', 'text': 'Read the Electron safeStorage page.'},
        {'role': 'assistant', 'engine': 'claude',
         'text': 'I read the page and summarised the Windows behaviour below.',
         'process': [
             {'type': 'tool', 'title': 'camellia_web_fetch', 'text': fetch_output,
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
    page = browser.new_page(viewport={'width': 1280, 'height': 1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error.stack or error)))
    page.on('console', lambda message: errors.append('console: ' + message.text) if message.type == 'error' else None)
    page.add_init_script(bridge)
    page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=claude', wait_until='networkidle')
    page.wait_for_function('uiReady')
    page.locator('[data-sid="web-fetch-fixture"]').click()
    card = page.locator('.tool-card', has_text='camellia_web_fetch')
    expect(card).to_have_count(1)
    page.evaluate("""() => {
      const card = document.querySelector('.tool-card');
      if (card) card.classList.add('open');
      card?.closest('.execution-process')?.setAttribute('open', '');
    }""")
    expect(card.locator('.web-fetch-title')).to_have_text('safeStorage | Electron')
    expect(card.locator('.tool-input')).to_contain_text('electronjs.org')
    expect(card.locator('.web-fetch-title')).to_have_attribute('href', 'https://www.electronjs.org/docs/latest/api/safe-storage')
    expect(card.locator('.web-fetch-meta')).to_contain_text('electronjs.org')
    expect(card.locator('.web-fetch-meta')).to_contain_text('Local fetch')
    expect(card.locator('.web-fetch-meta')).to_contain_text('Fell back from deepseek')
    expect(card.locator('.web-fetch-content').first).to_contain_text('safeStorage API')
    expect(card.locator('.web-fetch-more summary')).to_be_visible()
    expect(card.locator('.web-fetch-stats')).to_contain_text('characters read')
    expect(card.locator('.tool-summary')).to_contain_text('safeStorage | Electron')
    page.screenshot(path=str(output / 'web-fetch-card.png'), animations='disabled')

    # The same card in Simplified Chinese must not fall back to English labels.
    page.evaluate("window.changeLanguage && window.changeLanguage('zh-CN')")
    page.wait_for_timeout(150)
    expect(card.locator('.web-fetch-meta')).to_contain_text('本机抓取')
    expect(card.locator('.web-fetch-meta')).to_contain_text('已从 deepseek 回退')
    expect(card.locator('.web-fetch-more summary')).to_have_text('展开其余正文')
    expect(card.locator('.web-fetch-stats')).to_contain_text('个字符')
    page.screenshot(path=str(output / 'web-fetch-card-zh.png'), animations='disabled')
    assert not errors, errors
