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
bridge = bridge.replace('...fixture,currentEngine:fixtureEngine,preferences:', "...fixture,...(payload==='another-session'?{id:'another-session',backgroundWork:null}:{}),currentEngine:fixtureEngine,preferences:")
bridge = bridge.replace('window.currentGoal = null;', """window.currentGoal = null;
  window.setFixtureBackground = value => { fixture.backgroundWork = value; };
  window.backgroundStopCalls = [];
  fixture.backgroundWork = {engine:'kimi',tasks:[{id:'bash-eval',engine:'kimi',runId:7,canStop:true,description:'Governed policy evaluation',kind:'process',status:'running'}]};""")
bridge = bridge.replace("if(action==='get-live')", """if(action==='stop-background-work') {
        backgroundStopCalls.push(payload);
        return new Promise(resolve => { window.finishBackgroundStop = resolve; });
      }
      if(action==='get-live')""")
bridge = bridge.replace("if(action==='goal-get')", "if(action==='task-list') return {ok:true,tasks:[]}; if(action==='goal-get')")

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
    expect(page.locator('.background-work-status')).to_contain_text('Background tasks')
    expect(page.locator('.background-work-status')).not_to_contain_text('Reply completed')
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

    # An acknowledgement cannot hide a task. Native events own its state, and
    # errors leave a keyboard-accessible retry without stealing the draft.
    expect(page.get_by_role('button', name='Stop background tasks', exact=True)).to_be_visible()
    stop = page.locator('.background-work-stop')
    page.locator('#input').fill('Keep this draft')
    stop.click()
    expect(stop).to_be_disabled()
    expect(stop).to_have_text('Stopping…')
    assert page.evaluate('backgroundStopCalls') == [{'sessionId': 'shared-fixture', 'tasks': [{'id': 'bash-eval', 'engine': 'kimi', 'runId': 7}]}]
    page.evaluate("finishBackgroundStop({ok:false,error:'Could not stop background tasks. Retry.'})")
    expect(page.locator('.background-work-error')).to_have_text('Could not stop background tasks. Retry.')
    expect(stop).to_be_enabled()
    expect(page.locator('#input')).to_have_value('Keep this draft')
    stop.focus()
    page.keyboard.press('Enter')
    expect(stop).to_be_disabled()
    assert page.evaluate('backgroundStopCalls.length') == 2
    page.evaluate('finishBackgroundStop({ok:true})')
    expect(stop).to_be_enabled()
    expect(page.locator('.background-work-status')).to_be_visible()

    # Pending results belong to the original conversation even when navigation
    # and a stop failure arrive in the opposite order.
    stop.click()
    page.locator('[data-sid="another-session"]').click()
    expect(page.locator('.background-work-status')).to_have_count(0)
    page.evaluate("finishBackgroundStop({ok:false,error:'Could not stop background tasks. Retry.'})")
    expect(page.locator('.background-work-status')).to_have_count(0)
    page.locator('[data-sid="shared-fixture"]').click()
    expect(page.locator('.background-work-error')).to_be_visible()

    # Reuse the current work controls and tokens at compact widths, in both
    # languages/themes. The count exposes individual descriptions as a tooltip.
    for language, theme, width, height in [('en', 'light', 1100, 800), ('zh-CN', 'dark', 1100, 800), ('en', 'dark', 390, 760), ('zh-CN', 'light', 390, 760)]:
        page.set_viewport_size({'width': width, 'height': height})
        page.emulate_media(color_scheme=theme, reduced_motion='reduce')
        page.evaluate('(language) => CamelliaI18n.setLanguage(language)', language)
        page.evaluate("""() => {
          const value = {engine:'kimi',tasks:[
            {id:'bash-eval',engine:'kimi',runId:7,canStop:true,description:'Governed policy evaluation',status:'running'},
            {id:'bash-report',engine:'claude',runId:8,canStop:true,description:'Generate the comparison report',status:'running'}]};
          setFixtureBackground(value);
          sendEvent({type:'conversation:activity',activity:null,backgroundWork:value});
        }""")
        expect(page.locator('.background-work-text')).to_contain_text('2 个后台任务' if language == 'zh-CN' else '2 background tasks')
        expect(stop).to_have_text('停止后台任务' if language == 'zh-CN' else 'Stop background tasks')
        expect(page.locator('.background-work-text')).to_have_attribute('title', 'Governed policy evaluation\nGenerate the comparison report')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        assert stop.bounding_box()['width'] > 80
        page.screenshot(path=str(preview / f'background-work-{language}-{theme}-{width}.png'), animations='disabled')

    page.evaluate("""() => {
      const value = {engine:'grok',tasks:[{id:'uncontrolled',engine:'grok',runId:2,canStop:false,status:'running'}]};
      sendEvent({type:'conversation:activity',activity:null,backgroundWork:value});
    }""")
    expect(stop).to_be_hidden()

    page.evaluate("""() => {
      setFixtureBackground(null);
      sendEvent({type:'conversation:activity',activity:null,backgroundWork:null});
    }""")
    expect(page.locator('.background-work-status')).to_have_count(0)
    expect(page.locator('[data-sid="shared-fixture"] .session-item-time')).not_to_have_text('Background tasks')
    assert not errors, errors
    browser.close()
