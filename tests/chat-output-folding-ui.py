"""Process messages stay collapsed during streaming and after history reload."""
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
bridge = bridge.replace('const fixture = ', 'const fixture = window.chatFixture = ')

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
        page.evaluate("""() => {
          window.sendEvent = event => deliverEvent({session_id:'shared-fixture', engine:'codex', runId:91, ...event});
          sendEvent({type:'conversation:started', prompt:'Check output folding'});
          sendEvent({type:'stream_event',event:{type:'message_start'}});
          window.sendText = (index, text) => {
            sendEvent({type:'stream_event',event:{type:'content_block_start',index,content_block:{type:'text',phase:'commentary'}}});
            sendEvent({type:'stream_event',event:{type:'content_block_delta',index,delta:{type:'text_delta',text}}});
            sendEvent({type:'stream_event',event:{type:'content_block_stop',index}});
          };
          sendText(0, 'I will inspect the code.');
          sendText(1, 'Checking the event history.');
        }""")
        turn = page.locator('.turn').last
        process = turn.locator('.execution-process')
        expect(process).to_be_visible()
        expect(process).not_to_have_attribute('open', '')
        expect(turn.locator('.turn-body > .md')).to_have_count(0)
        expect(process.locator('.md')).to_have_count(2)
        process.locator('summary').click()
        expect(process.locator('.md').first).to_be_visible()
        page.evaluate("""() => {
          sendText(2, 'The confirmed answer.');
          sendEvent({type:'gui:message-phase',index:2,phase:'final_answer'});
          sendEvent({type:'result',subtype:'success',result:'The confirmed answer.'});
        }""")
        expect(turn.locator('.turn-body > .md')).to_have_text('The confirmed answer.')
        expect(process).not_to_have_attribute('open', '')
        page.screenshot(path=str(scope['preview'] / f'output-folding-{theme}.png'))
        page.evaluate("""() => {
          chatFixture.messages = [{role:'user',text:'Check output folding'}, {
            role:'assistant',engine:'codex',text:'The confirmed answer.',outputBlocks:[
              {type:'text',phase:'commentary',text:'I will inspect the code.'},
              {type:'text',phase:'commentary',text:'Checking the event history.'},
              {type:'text',phase:'final_answer',text:'The confirmed answer.'}
            ]
          }];
        }""")
        page.locator('[data-sid="another-session"]').click()
        page.locator('[data-sid="shared-fixture"]').click()
        turn = page.locator('.turn').last
        expect(turn.locator('.turn-body > .md')).to_have_text('The confirmed answer.')
        expect(turn.locator('.execution-process')).not_to_have_attribute('open', '')
        expect(turn.locator('.execution-process .md')).to_have_count(2)
        page.evaluate("chatFixture.messages[1].text=''; chatFixture.messages[1].outputBlocks.pop()")
        page.locator('[data-sid="another-session"]').click()
        page.locator('[data-sid="shared-fixture"]').click()
        turn = page.locator('.turn').last
        expect(turn.locator('.turn-body > .md')).to_have_count(0)
        expect(turn.locator('.execution-process')).to_be_visible()
        expect(turn.locator('.execution-process')).not_to_have_attribute('open', '')
        assert not errors, errors
        page.close()
    browser.close()
print('PASS output folding: streaming, final answer, reload and process-only history')
