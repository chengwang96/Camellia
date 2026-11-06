"""Background work and queued-prompt status stay distinct from reply generation."""
import ast
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
preview = repo / 'dist/ui-preview'
preview.mkdir(parents=True, exist_ok=True)
fixture_source = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
scope = {'__file__': str(repo / 'tests/shared-chat-ui.py')}
for statement in fixture_source.body:
    if isinstance(statement, ast.With):
        break
    exec(compile(ast.Module(body=[statement], type_ignores=[]), '<fixture>', 'exec'), scope)
bridge = scope['bridge'].replace('onConversationEvent:()=>{}', 'onConversationEvent:fn=>{window.deliverEvent=fn;}')
bridge = bridge.replace("id:'another-session',title:'Another task'", "id:'another-session',title:'Another task',backgroundWork:null")
bridge = bridge.replace('window.currentGoal = null;', """window.currentGoal = null;
  window.setFixtureBackground = value => { fixture.backgroundWork = value; };
  fixture.backgroundWork = {engine:'kimi',tasks:[{id:'bash-eval',description:'Governed policy evaluation',kind:'process',status:'running'}]};""")

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1100, 'height': 800}, color_scheme='light')
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(bridge)
    page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=kimi&conversation=shared-fixture', wait_until='networkidle')
    page.wait_for_function('uiReady')
    page.locator('[data-sid="shared-fixture"]').click()
    expect(page.locator('.background-work-status')).to_contain_text('Reply completed · background work still running')
    expect(page.locator('.background-work-status')).to_contain_text('Governed policy evaluation')
    expect(page.locator('[data-sid="shared-fixture"] .session-item-time')).to_have_text('Background tasks')

    page.evaluate("""() => {
      window.sendEvent = event => deliverEvent({session_id:'shared-fixture',engine:'kimi',runId:91,...event});
      sendEvent({type:'conversation:started',prompt:'Can the model complete the task?'});
      sendEvent({type:'stream_event',event:{type:'message_start'}});
    }""")
    expect(page.locator('.background-work-status')).to_have_count(0)
    page.evaluate("sendEvent({type:'gui:prompt-queue',state:'queued'})")
    expect(page.locator('.run-status')).to_contain_text('Background work in progress · request queued')
    expect(page.locator('#statusLine')).to_contain_text('Background work in progress · request queued')
    expect(page.locator('.turn').last.locator('.turn-body')).not_to_contain_text('Kimi is finishing background work')

    page.evaluate("""() => {
      sendEvent({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text'}}});
      sendEvent({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Actual answer'}}});
    }""")
    expect(page.locator('.run-status')).to_contain_text('Writing a response…')
    expect(page.locator('#statusLine')).not_to_contain_text('request queued')
    expect(page.locator('.turn').last.locator('.md')).to_contain_text('Actual answer')
    page.evaluate("sendEvent({type:'result',subtype:'success',result:'Actual answer'})")
    expect(page.locator('.background-work-status')).to_be_visible()
    page.screenshot(path=str(preview / 'background-work-status.png'), animations='disabled')

    page.evaluate("""() => {
      setFixtureBackground(null);
      sendEvent({type:'conversation:activity',activity:null,backgroundWork:null});
    }""")
    expect(page.locator('.background-work-status')).to_have_count(0)
    expect(page.locator('[data-sid="shared-fixture"] .session-item-time')).not_to_have_text('Background tasks')
    assert not errors, errors
    browser.close()
