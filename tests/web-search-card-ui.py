"""Structured web-search results render as a source list in history."""
import json
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
output = repo / 'artifacts/web-search-card'
output.mkdir(parents=True, exist_ok=True)

search_output = json.dumps({
    'ok': True,
    'provider': 'deepseek',
    'results': [
        {'title': 'First source', 'url': 'https://example.com/a', 'summary': 'Summary one'},
        {'title': 'Duplicate source', 'url': 'https://example.com/a', 'summary': 'Ignored duplicate'},
        {'title': 'Second source', 'url': 'https://example.org/b', 'summary': 'Summary two'},
    ],
    'truncated': False,
})

fixture = {
    'id': 'web-search-fixture', 'title': 'Search sources', 'origin': 'claude',
    'currentEngine': 'claude', 'workspaceId': None,
    'messages': [
        {'role': 'user', 'text': 'Find two sources.'},
        {'role': 'assistant', 'engine': 'claude',
         'text': 'Here are the sources: [First](https://example.com/a) and [Second](https://example.org/b).',
         'sources': [
             {'index': 1, 'title': 'First source', 'url': 'https://example.com/a',
              'key': 'https://example.com/a', 'site': 'example.com', 'summary': 'Summary one', 'date': ''},
             {'index': 2, 'title': 'Second source', 'url': 'https://example.org/b',
              'key': 'https://example.org/b', 'site': 'example.org', 'summary': 'Summary two', 'date': ''},
         ],
         'process': [
             {'type': 'tool', 'title': 'camellia_web_search', 'text': search_output,
              'status': 'completed', 'input': 'Find two sources'},
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
    scheduledTasksList:async()=>({ok:true,tasks:[]}),
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
    page.on('console', lambda message: errors.append('console: ' + message.text) if message.type == 'error' else None)
    page.add_init_script(bridge)
    page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=claude', wait_until='networkidle')
    page.wait_for_function('uiReady')
    page.locator('[data-sid="web-search-fixture"]').click()
    card = page.locator('.tool-card', has_text='camellia_web_search')
    expect(card).to_have_count(1)
    page.evaluate("""() => {
      const card = document.querySelector('.tool-card');
      if (card) card.classList.add('open');
      card?.closest('.execution-process')?.setAttribute('open', '');
    }""")
    expect(card).to_be_visible()
    expect(card.locator('.tool-summary')).to_contain_text('2 sources')
    expect(card.locator('.web-search-result')).to_have_count(2)
    expect(card.locator('.web-search-title').first).to_have_text('First source')
    expect(card.locator('.web-search-result').nth(1).locator('.web-search-meta')).to_contain_text('example.org')
    expect(card.locator('.web-search-result').first.locator('.web-search-summary')).to_have_text('Summary one')
    expect(card.locator('.tool-output')).not_to_contain_text('"results"')
    # The reply numbers its cited links in order; the card keeps search order.
    expect(page.locator('.md-source-marker')).to_have_count(2)
    expect(page.locator('.md-source-marker').first).to_have_text('1')
    expect(page.locator('.md-source-marker').nth(1)).to_have_text('2')
    expect(page.locator('.md-source-marker').first).to_have_attribute('href', 'https://example.com/a')
    expect(page.locator('.md-source-marker').first).to_have_attribute('target', '_blank')
    expect(page.locator('.md-source-marker').first).to_have_attribute('rel', 'noopener noreferrer')
    expect(page.locator('#statusLine')).not_to_contain_text("reading 'some'")
    page.wait_for_timeout(800)
    page.screenshot(path=str(output / 'web-search-card.png'), animations='disabled')
    for error in errors:
        print(error)
    assert not errors, errors

with sync_playwright() as p:
    # A trimmed transcript keeps the stored snapshot but no search tool row.
    trimmed = json.loads(json.dumps(fixture))
    trimmed['messages'][-1]['process'] = []
    trimmed_bridge = bridge.replace(json.dumps(fixture), json.dumps(trimmed))
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1280, 'height': 900})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error.stack or error)))
    page.add_init_script(trimmed_bridge)
    page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=claude', wait_until='networkidle')
    page.wait_for_function('uiReady')
    page.locator('[data-sid="web-search-fixture"]').click()
    expect(page.locator('.tool-card', has_text='camellia_web_search')).to_have_count(0)
    expect(page.locator('.md-source-marker')).to_have_count(2)
    expect(page.locator('.md-source-marker').first).to_have_text('1')
    assert not errors, errors
