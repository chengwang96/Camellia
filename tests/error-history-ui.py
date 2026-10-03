"""A terminal error keeps its result chip after switching conversations."""
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


repo = Path(__file__).resolve().parents[1]
error = 'Context recovery failed: Compaction failed: the summary request returned no text.'
sessions = {
    'failed': {'id': 'failed', 'title': 'Failed summary', 'origin': 'codex', 'currentEngine': 'codex',
               'workspaceId': None, 'messages': [
                   {'role': 'user', 'text': 'Continue the manuscript review.'},
                   {'role': 'assistant', 'engine': 'codex', 'text': error,
                    'runResult': {'subtype': 'error', 'is_error': True, 'result': error, 'duration_ms': 104000}},
               ]},
    'other': {'id': 'other', 'title': 'Other conversation', 'origin': 'codex', 'currentEngine': 'codex',
              'workspaceId': None, 'messages': [
                  {'role': 'user', 'text': 'Another question'},
                  {'role': 'assistant', 'engine': 'codex', 'text': 'Another answer'},
              ]},
    'structured': {'id': 'structured', 'title': 'Structured failure', 'origin': 'codex', 'currentEngine': 'codex',
                   'workspaceId': None, 'messages': [
                       {'role': 'user', 'text': 'Retry the summary.'},
                       {'role': 'assistant', 'engine': 'codex', 'text': error,
                        'outputBlocks': [{'phase': 'commentary', 'text': 'Attempted summary'},
                                         {'phase': 'final_answer', 'text': error}],
                        'runResult': {'subtype': 'error', 'is_error': True, 'result': error}},
                   ]},
}
bridge = r"""(() => {
  const sessions = FIXTURE;
  const preferences = {mode:'direct',warnOnSwitch:false,showOrigin:false};
  const settings = {model:'fixture-model',permissionMode:'default',connection:'api'};
  window.dshDesktop = {
    sharedConversations:true,
    onLanguageChanged:()=>()=>{},
    conversationCommand:async ({action,payload}) => {
      if(action==='list-sessions') return {ok:true,sessions:Object.values(sessions).map(s=>({...s,mtimeMs:Date.now()})),workspaces:[],pagination:{}};
      if(action==='load-session') {
        const id = typeof payload==='string' ? payload : payload?.id || payload?.sessionId;
        return {ok:true,...sessions[id],preferences,settings,live:null};
      }
      if(action==='get-live') return {ok:true,live:null};
      if(action==='get-settings') return settings;
      if(action==='goal-get') return {ok:true,goal:null};
      if(action==='task-list') return {ok:true,tasks:[]};
      return {ok:true};
    },
    workbenchSettings:async()=>({ok:true,conversations:preferences}),
    conversationSwitch:async()=>({ok:true}),
    apiRouterGetState:async()=>({enabled:true,models:['fixture-model']}),
    onConversationEvent:()=>{},onConversationGoal:()=>{},onConversationStatus:()=>{},
    onEngineSettingsChanged:()=>{},onApiRouterState:()=>{},onNetworkHealth:()=>{},
    onHarnessNavigate:()=>{},openSettingsWindow:()=>{},
    previewFile:async()=>({ok:false,error:'fixture'}),openFileExternally:async()=>({ok:true}),
  };
})();""".replace('FIXTURE', json.dumps(sessions))


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1200, 'height': 820})
    errors = []
    page.on('pageerror', lambda event: errors.append(str(event)))
    page.add_init_script(bridge)
    page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex', wait_until='networkidle')
    page.wait_for_function('uiReady')
    page.locator('[data-sid="failed"]').click()
    expect(page.locator('#chat .run-result.err')).to_contain_text(error)
    assert page.locator('#chat .turn-body .md', has_text=error).count() == 0
    page.locator('[data-sid="other"]').click()
    expect(page.locator('#chat .run-result.err')).to_have_count(0)
    expect(page.locator('#chat')).to_contain_text('Another answer')
    page.locator('[data-sid="failed"]').click()
    expect(page.locator('#chat .run-result.err')).to_have_count(1)
    expect(page.locator('#chat .run-result.err')).to_contain_text(error)
    page.locator('[data-sid="structured"]').click()
    expect(page.locator('#chat .run-result.err')).to_contain_text(error)
    assert page.locator('#chat .turn-body .md', has_text=error).count() == 0
    assert 'Cannot read properties' not in page.locator('#statusLine').inner_text()
    preview = repo / 'dist/ui-preview'
    preview.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(preview / 'error-after-reload.png'), animations='disabled')
    browser.close()
    assert not errors, errors

print('PASS: terminal error remains a result chip after switching conversations')
