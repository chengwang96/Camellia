"""Exercise the real chat renderer with local stream fixtures, without model calls."""
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

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    errors = []
    for theme in ['light', 'dark']:
        page = browser.new_page(viewport={'width': 960, 'height': 800}, color_scheme=theme)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex&conversation=shared-fixture', wait_until='networkidle')
        page.wait_for_function('uiReady')
        page.evaluate("""() => {
          window.emit = event => deliverEvent({session_id:'shared-fixture',engine:'codex',runId:901,...event});
          window.text = (index, value) => {
            emit({type:'stream_event',event:{type:'content_block_start',index,content_block:{type:'text'}}});
            emit({type:'stream_event',event:{type:'content_block_delta',index,delta:{type:'text_delta',text:value}}});
            emit({type:'stream_event',event:{type:'content_block_stop',index}});
          };
          emit({type:'conversation:started',prompt:'Inspect the execution process',userSeq:3});
          text(0, 'First progress');
          emit({type:'gui:tool',id:'first',name:'read_file',input:{path:'notes.txt'},status:'in_progress'});
          text(1, 'Latest progress');
        }""")
        turn = page.locator('.turn').last
        process = turn.locator('.execution-process')
        expect(turn.locator('.turn-body > .md')).to_have_text('Latest progress')
        expect(process).not_to_have_attribute('open', '')
        expect(process.locator('.tool-card')).to_have_count(1)
        process.locator('summary').focus()
        page.keyboard.press('Enter')
        expect(process).to_have_attribute('open', '')
        expect(process.locator('.md')).to_have_text('First progress')
        process.locator('.tool-head').click()
        page.evaluate("emit({type:'gui:tool',id:'first',status:'completed',output:'Read succeeded'})")
        expect(process.locator('.tool-output')).to_be_visible()
        expect(process.locator('.tool-output')).to_have_text('Read succeeded')
        page.evaluate("""() => {
          emit({type:'stream_event',event:{type:'content_block_start',index:2,content_block:{type:'thinking',thinking:'Check the evidence'}}});
          emit({type:'stream_event',event:{type:'content_block_stop',index:2}});
          emit({type:'gui:tool',id:'second',name:'verify',status:'completed',output:'Verified'});
          text(3, 'Final answer');
        }""")
        expect(process).to_have_attribute('open', '')
        assert process.locator('.execution-process-body > *').evaluate_all('(nodes) => nodes.map(node => node.className)') == ['md', 'tool-card open', 'md', 'think', 'tool-card']
        page.evaluate("emit({type:'result',subtype:'success',is_error:false})")
        expect(process).not_to_have_attribute('open', '')
        expect(turn.locator('.turn-body > .md')).to_have_text('Final answer')
        expect(process.locator('.execution-process-count')).to_have_text('2 tool calls')
        page.evaluate("changeLanguage('zh-CN')")
        expect(process.locator('summary')).to_contain_text('执行过程')
        page.screenshot(path=str(preview / f'execution-process-{theme}.png'))
        process.locator('summary').click()
        expect(process.locator('.md')).to_have_text(['First progress', 'Latest progress'])
        page.evaluate("""() => {
          emit({type:'conversation:started',prompt:'Interrupted inspection',userSeq:4});
          text(0, 'Still inspecting');
          emit({type:'gui:tool',id:'unfinished',name:'verify',status:'in_progress'});
          emit({type:'result',subtype:'stopped'});
        }""")
        stopped = page.locator('.turn').last
        expect(stopped.locator('.turn-body > .md')).to_have_count(0)
        stopped.locator('summary').click()
        expect(stopped.locator('.md')).to_have_text('Still inspecting')
        expect(stopped.locator('.tool-state')).to_have_class('tool-state err')
        page.evaluate("""() => {
          emit({type:'conversation:started',prompt:'Plain reply',userSeq:5});
          text(0, 'Plain final answer');
          emit({type:'result',subtype:'success'});
        }""")
        expect(page.locator('.turn').last.locator('.execution-process')).to_have_count(0)
        expect(page.locator('.turn').last.locator('.md')).to_have_text('Plain final answer')
        page.evaluate("""() => {
          emit({type:'conversation:started',prompt:'Canonical reply',userSeq:6});
          text(0, 'Partial');
          emit({type:'assistant',message:{content:[
            {type:'text',text:'Canonical progress'},
            {type:'tool_use',id:'canonical',name:'verify',input:{}},
            {type:'text',text:'Canonical final'}
          ]}});
          emit({type:'user',message:{content:[{type:'tool_result',tool_use_id:'canonical',content:'Canonical output'}]}});
          emit({type:'result',subtype:'success'});
        }""")
        canonical = page.locator('.turn').last
        expect(canonical.locator('.md')).to_have_text(['Canonical progress', 'Canonical final'])
        expect(canonical.locator('.turn-body > .md')).to_have_text('Canonical final')
        expect(canonical.locator('.tool-output')).to_have_text('Canonical output')
        page.evaluate("""() => {
          emit({type:'conversation:started',prompt:'Many progress updates',userSeq:7});
          for (let index = 0; index < 27; index++) {
            text(index, 'Progress ' + index);
            emit({type:'gui:tool',id:'batch-' + index,name:'inspect',status:'completed',output:'Output ' + index});
          }
          text(27, 'Answer part one');
          text(28, 'Answer part two');
          emit({type:'result',subtype:'success'});
        }""")
        batch = page.locator('.turn').last
        expect(batch.locator('.turn-body > .md')).to_have_text(['Answer part one', 'Answer part two'])
        expect(batch.locator('.execution-process .md')).to_have_count(27)
        expect(batch.locator('.execution-process .tool-card')).to_have_count(27)
        page.evaluate("""() => {
          applyLiveRun({sessionId:'shared-fixture',engine:'codex',runId:902,prompt:'Restored run',messages:[],events:[
            {type:'stream_event',session_id:'shared-fixture',runId:902,event:{type:'content_block_start',index:0,content_block:{type:'text',text:'Restored progress'}}},
            {type:'stream_event',session_id:'shared-fixture',runId:902,event:{type:'content_block_stop',index:0}},
            {type:'gui:tool',session_id:'shared-fixture',runId:902,id:'restored-tool',name:'inspect',status:'completed',output:'Restored output'},
            {type:'stream_event',session_id:'shared-fixture',runId:902,event:{type:'content_block_start',index:1,content_block:{type:'text',text:'Latest restored progress'}}},
            {type:'stream_event',session_id:'shared-fixture',runId:902,event:{type:'content_block_stop',index:1}}
          ]});
        }""")
        restored = page.locator('.turn').last
        expect(restored.locator('.turn-body > .md')).to_have_text('Latest restored progress')
        expect(restored.locator('.execution-process .md')).to_have_text('Restored progress')
        expect(restored.locator('.tool-output')).to_have_text('Restored output')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.close()
    browser.close()
    assert not errors, errors
    print('PASS: live progress, chronological archive, keyboard toggle, tool updates, completion, stop, canonical rebuild, plain replies and localization in light/dark themes')
