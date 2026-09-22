"""Immediate instructions transfer the active indicator without losing streamed output."""
import ast
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
fixture_source = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
scope = {'__file__': str(repo / 'tests/shared-chat-ui.py')}
for statement in fixture_source.body:
    if isinstance(statement, ast.With):
        break
    exec(compile(ast.Module(body=[statement], type_ignores=[]), '<fixture>', 'exec'), scope)
bridge = scope['bridge'].replace('onConversationEvent:()=>{}', 'onConversationEvent:fn=>{window.deliverEvent=fn;}')

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    for theme in ['light', 'dark']:
        page = browser.new_page(viewport={'width': 1100, 'height': 800}, color_scheme=theme)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex', wait_until='networkidle')
        page.wait_for_function('uiReady')
        page.locator('[data-sid="shared-fixture"]').click()
        expect(page.locator('#chat')).to_contain_text('Experiment review')
        page.clock.install()
        page.evaluate("""() => {
          window.sendEvent = event => deliverEvent({session_id:'shared-fixture', engine:'codex', runId:91, ...event});
          sendEvent({type:'conversation:started', prompt:'Initial request'});
          sendEvent({type:'stream_event',event:{type:'message_start'}});
          window.activeStatus = document.querySelector('.run-status');
          sendEvent({type:'conversation:steered', displayText:'First instruction'});
        }""")
        expect(page.locator('.run-status')).to_have_count(1)
        expect(page.locator('.turn')).to_have_count(2)
        expect(page.locator('.turn').last.locator('.run-status')).to_have_count(1)
        assert page.evaluate("document.querySelector('.run-status') === activeStatus")
        page.clock.fast_forward(17000)
        expect(page.locator('.run-status .run-clock')).not_to_be_empty()
        page.evaluate("""() => {
          sendEvent({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text'}}});
          sendEvent({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Existing output'}}});
        }""")
        expect(page.locator('.turn').last.locator('.md')).to_contain_text('Existing output')
        page.evaluate("sendEvent({type:'conversation:steered', displayText:'Second instruction'})")
        expect(page.locator('.run-status')).to_have_count(1)
        expect(page.locator('.turn')).to_have_count(3)
        expect(page.locator('.turn').nth(1).locator('.run-status')).to_have_count(0)
        expect(page.locator('.turn').last.locator('.run-status')).to_have_count(1)
        page.evaluate("""() => {
          sendEvent({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:' continues'}}});
          sendEvent({type:'stream_event',event:{type:'content_block_stop',index:0}});
          sendEvent({type:'conversation:steered', displayText:'Third instruction'});
        }""")
        expect(page.locator('.turn').nth(1).locator('.md')).to_have_text('Existing output continues')
        expect(page.locator('.run-status')).to_have_count(1)
        expect(page.locator('.turn')).to_have_count(3)
        page.evaluate("sendEvent({type:'conversation:steered', runId:90, displayText:'Stale instruction'})")
        expect(page.locator('#chat')).not_to_contain_text('Stale instruction')
        expect(page.locator('.run-status')).to_have_count(1)
        page.screenshot(path=str(scope['preview'] / f'steering-{theme}.png'))
        page.evaluate("sendEvent({type:'result',subtype:'success',result:'Finished'})")
        expect(page.locator('.run-status')).to_have_count(0)
        assert not errors, errors
        page.close()
    browser.close()
