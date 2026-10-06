"""Keep literal reasoning-tag examples visible through the real chat renderer."""
import ast
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
fixture_module = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
fixture = next(ast.literal_eval(node.value) for node in fixture_module.body
               if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'fixture' for target in node.targets))
bridge_node = next(node for node in fixture_module.body if isinstance(node, ast.Assign)
                   and any(isinstance(target, ast.Name) and target.id == 'bridge' for target in node.targets))
bridge = ast.literal_eval(bridge_node.value.func.value).replace('FIXTURE', json.dumps(fixture))
bridge = bridge.replace('onConversationEvent:()=>{}', 'onConversationEvent:fn=>{window.deliverEvent=fn;}')
preview = repo / 'dist/ui-preview'
preview.mkdir(parents=True, exist_ok=True)
answer = 'It is the new `<thinking>` parser. The complete reply remains visible.'
example = 'Examples use `<thinking>` literally.\n\n```xml\n<thinking>example</thinking>\n```\n\nThe complete final answer.'

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    errors = []
    for width, height, theme in [(1440, 900, 'light'), (960, 800, 'dark')]:
        page = browser.new_page(viewport={'width': width, 'height': height}, color_scheme=theme)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex&conversation=shared-fixture', wait_until='networkidle')
        page.wait_for_function('uiReady')
        page.evaluate("""() => {
          window.emit = event => deliverEvent({session_id:'shared-fixture',engine:'codex',runId:950,...event});
          emit({type:'conversation:started',prompt:'Explain the reasoning parser',userSeq:3});
          emit({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text',phase:'final_answer'}}});
        }""")
        turn = page.locator('.turn').last
        streamed = ''
        for chunk in ['It is the new `', '<thi', 'nking>', '` parser. ', 'The complete reply remains visible.']:
            streamed += chunk
            page.evaluate("""chunk => emit({type:'stream_event',event:{type:'content_block_delta',index:0,
              delta:{type:'text_delta',text:chunk}}})""", chunk)
            page.wait_for_function("""expected => Array.from(document.querySelectorAll('.turn')).at(-1)
              .querySelector('.turn-body > .md')?.artifactText === expected""", arg=streamed)
            expect(turn.locator('.think')).to_have_count(0)
        page.evaluate("""() => {
          emit({type:'stream_event',event:{type:'content_block_stop',index:0}});
          emit({type:'result',subtype:'success'});
        }""")
        expect(turn.locator('.turn-body > .md')).to_have_text(answer.replace('`', ''))
        expect(turn.locator('.md code')).to_have_text('<thinking>')
        expect(turn.locator('.execution-process')).not_to_be_visible()
        page.screenshot(path=str(preview / f'thinking-tags-{theme}.png'))

        page.evaluate("""text => {
          emit({type:'conversation:started',prompt:'Show a code example',userSeq:4});
          emit({type:'assistant',message:{content:[{type:'text',phase:'final_answer',text}]}});
          emit({type:'result',subtype:'success'});
        }""", example)
        canonical = page.locator('.turn').last
        expect(canonical.locator('.think')).to_have_count(0)
        expect(canonical.locator('.turn-body > .md')).to_contain_text('The complete final answer.')
        expect(canonical.locator('pre code')).to_have_text('<thinking>example</thinking>')

        page.evaluate("""text => {
          emit({type:'conversation:started',prompt:'Reasoning and literal examples',userSeq:5});
          emit({type:'stream_event',event:{type:'content_block_start',index:0,
            content_block:{type:'thinking',thinking:'Actual native reasoning.'}}});
          emit({type:'stream_event',event:{type:'content_block_stop',index:0}});
          emit({type:'stream_event',event:{type:'content_block_start',index:1,
            content_block:{type:'text',phase:'final_answer',text:'<thinking>Check `</thinking>` literally.</thinking>' + text}}});
          emit({type:'stream_event',event:{type:'content_block_stop',index:1}});
          emit({type:'result',subtype:'success'});
        }""", answer)
        mixed = page.locator('.turn').last
        expect(mixed.locator('.think')).to_have_count(1)
        expect(mixed.locator('.think-body')).to_have_text('Check `</thinking>` literally.')
        expect(mixed.locator('.turn-body > .md')).to_have_text(answer.replace('`', ''))

        page.evaluate("""text => renderHistoryMessages([{role:'assistant',engine:'codex',text,
          outputBlocks:[{phase:'final_answer',text}]}])""", example)
        historical = page.locator('.turn').last
        expect(historical.locator('.think')).to_have_count(0)
        expect(historical.locator('.turn-body > .md')).to_contain_text('The complete final answer.')
        expect(historical.locator('pre code')).to_have_text('<thinking>example</thinking>')
        page.evaluate("text => renderHistoryMessages([{role:'assistant',engine:'codex',text}])", answer)
        legacy = page.locator('.turn').last
        expect(legacy.locator('.think')).to_have_count(0)
        expect(legacy.locator('.turn-body > .md')).to_have_text(answer.replace('`', ''))

        page.evaluate("""text => applyLiveRun({sessionId:'shared-fixture',engine:'codex',runId:951,
          prompt:'Restore a reply with code',messages:[],events:[
            {type:'stream_event',session_id:'shared-fixture',runId:951,event:{type:'content_block_start',index:0,
              content_block:{type:'text',phase:'final_answer',text}}},
            {type:'stream_event',session_id:'shared-fixture',runId:951,event:{type:'content_block_stop',index:0}}
          ]})""", answer)
        restored = page.locator('.turn').last
        expect(restored.locator('.think')).to_have_count(0)
        expect(restored.locator('.turn-body > .md')).to_have_text(answer.replace('`', ''))
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.close()
    browser.close()
    assert not errors, errors
    print('PASS: literal reasoning tags never truncate streamed, canonical, historical or restored replies in light/dark themes')
