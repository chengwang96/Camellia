"""Real disclosure clicks and history gestures retain reading through live updates."""
import ast
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
tree = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
fixture = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign)
               and any(isinstance(t, ast.Name) and t.id == 'fixture' for t in n.targets))
node = next(n for n in tree.body if isinstance(n, ast.Assign)
            and any(isinstance(t, ast.Name) and t.id == 'bridge' for t in n.targets))
fixture['messages'] = [dict(role='assistant' if i % 2 else 'user', seq=i+1,
                            text=f'History {i}\n\n' + 'A saved paragraph.\n\n' * 5) for i in range(30)]
bridge = ast.literal_eval(node.value.func.value).replace('FIXTURE', json.dumps(fixture))
bridge = bridge.replace('onConversationEvent:()=>{}', 'onConversationEvent:fn=>{window.deliverEvent=fn;}')

def settled(page):
    page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')

def inside(page, locator):
    viewport = page.locator('#chatScroll').bounding_box()
    rect = locator.bounding_box()
    assert rect and viewport['y'] <= rect['y'] and rect['y'] + rect['height'] <= viewport['y'] + viewport['height'], (rect, viewport)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    errors = []
    for width, height, theme in [(1200, 820, 'light'), (390, 844, 'dark'), (844, 390, 'light')]:
        page = browser.new_page(viewport={'width': width, 'height': height}, color_scheme=theme)
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=codex&conversation=shared-fixture', wait_until='networkidle')
        page.wait_for_function('uiReady && !loadingSession')
        page.evaluate("""() => {
          window.emit = event => deliverEvent({session_id:'shared-fixture',engine:'codex',runId:910,...event});
          emit({type:'conversation:started',prompt:'Reading intent',userSeq:31});
          for (let i=0;i<165;i++) emit({type:'gui:tool',id:'step'+i,name:'verify',input:{step:i},status:'completed',output:'Passed'});
        }""")
        process = page.locator('.turn').last.locator('.execution-process')
        expect(process.locator('.tool-card')).to_have_count(165)
        settled(page)
        # Even a small upward wheel action inside the old near-bottom threshold
        # suspends streamed updates, including those queued in a follow frame.
        page.locator('#chatScroll').hover()
        page.mouse.wheel(0, -24)
        page.wait_for_function('!followRunOutput')
        settled(page)
        before = page.evaluate('chatScroll.scrollTop')
        page.evaluate("emit({type:'gui:tool',id:'step165',name:'verify',status:'completed',output:'New tool'})")
        settled(page)
        assert not page.evaluate('followRunOutput')
        assert abs(page.evaluate('chatScroll.scrollTop') - before) <= 2
        # A fresh disclosure always lands on its first record and cancels follow.
        process.locator('summary').click()
        settled(page)
        assert not page.evaluate('followRunOutput')
        inside(page, process.locator('.tool-card').first)
        before = process.locator('.tool-card').first.bounding_box()['y']
        page.evaluate("""() => {
          emit({type:'gui:tool',id:'step166',name:'verify',status:'completed',output:'Another new tool'});
          emit({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text',text:'Final answer below the process.'}}});
          emit({type:'stream_event',event:{type:'content_block_stop',index:0}});
          emit({type:'result',subtype:'success',is_error:false});
        }""")
        settled(page)
        expect(process).to_have_attribute('open', '')
        assert not page.evaluate('followRunOutput')
        assert abs(process.locator('.tool-card').first.bounding_box()['y'] - before) <= 2, (width, before, process.locator('.tool-card').first.bounding_box(), page.evaluate('chatScroll.scrollTop'))
        # Collapse from the end of hundreds of rows, then reopen by keyboard.
        process.locator('.execution-process-collapse').click()
        settled(page)
        toggle = page.locator('.turn').last.locator('.completion-label')
        inside(page, toggle)
        expect(process).not_to_have_attribute('open', '')
        assert not page.evaluate('followRunOutput')
        toggle.focus()
        page.keyboard.press('Enter')
        settled(page)
        inside(page, process.locator('.tool-card').first)
        assert not page.evaluate('followRunOutput')
        # Bottom return is an explicit gesture; automatic updates cannot opt in.
        page.locator('#chatScroll').hover()
        page.mouse.wheel(0, 100000)
        page.wait_for_function('followRunOutput && chatScroll.scrollHeight-chatScroll.clientHeight-chatScroll.scrollTop <= 1')
        page.close()
    browser.close()
    assert not errors, errors
print('PASS: small history gestures, 167 tool calls, completion, footer collapse, keyboard reopen and bottom return on desktop, portrait and landscape')
