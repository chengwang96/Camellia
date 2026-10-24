"""User history reading survives streaming, reasoning, results and automatic turns."""
import ast
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

repo = Path(__file__).resolve().parents[1]
tree = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
fixture = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign)
               and any(isinstance(target, ast.Name) and target.id == 'fixture' for target in node.targets))
fixture['messages'] = [dict(role='assistant' if index % 2 else 'user', seq=index+1,
                           text=f'History message {index}\n\n' + 'A saved history paragraph.\n\n' * 5)
                       for index in range(40)]
bridge_node = next(node for node in tree.body if isinstance(node, ast.Assign)
                   and any(isinstance(target, ast.Name) and target.id == 'bridge' for target in node.targets))
bridge = ast.literal_eval(bridge_node.value.func.value).replace('FIXTURE', json.dumps(fixture))
bridge = bridge.replace('onConversationEvent:()=>{}', 'onConversationEvent:fn=>{window.deliverEvent=fn;}')
bridge += r"""window.runSerial = 80;
window.emit = event => deliverEvent({session_id:'shared-fixture',engine:new URLSearchParams(location.search).get('harness'),runId:runSerial,...event});
window.startReply = () => {
  runSerial++;
  emit({type:'conversation:started',prompt:'Continue the task',userSeq:runSerial});
  emit({type:'stream_event',event:{type:'content_block_start',index:0,
    content_block:{type:'text',phase:'final_answer',text:'Initial answer.\n\n'}}});
};
window.appendReply = text => {
  emit({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text}}});
  flushBlockRenders();
};"""


def settled(page):
    page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')


def gap(page):
    return page.evaluate('chatScroll.scrollHeight-chatScroll.clientHeight-chatScroll.scrollTop')


def position(page):
    return page.evaluate('chatScroll.scrollTop')


def unchanged(page, before):
    settled(page)
    assert abs(position(page) - before) <= 1, ('Reading position changed', before, position(page))
    assert page.evaluate('!followRunOutput')


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, ignore_default_args=['--hide-scrollbars'])
    errors = []
    cases = [(engine,1200,'light') for engine in ['claude','codex','dsh','kimi','antigravity']]
    cases.append(('codex',480,'dark'))
    for engine, width, theme in cases:
        page = browser.new_page(viewport={'width':width,'height':820}, color_scheme=theme)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + f'?harness={engine}&conversation=shared-fixture', wait_until='networkidle')
        page.wait_for_function('uiReady && !loadingSession')
        page.evaluate('startReply()')
        page.evaluate("appendReply('An answer paragraph.\\n\\n'.repeat(25))")
        settled(page)
        assert abs(gap(page)) <= 1

        # Even a small upward wheel gesture pauses following inside the old
        # 140px near-bottom threshold.
        page.locator('#chatScroll').hover()
        page.mouse.wheel(0,-24)
        page.wait_for_function('chatScroll.scrollHeight-chatScroll.clientHeight-chatScroll.scrollTop > 10')
        settled(page)
        assert gap(page) < 140, gap(page)
        before = position(page)
        page.evaluate("emit({type:'gui:subagent',tasks:[]})")
        unchanged(page, before)
        page.evaluate("appendReply('New output must not steal the viewport.\\n\\n')")
        unchanged(page, before)

        # The user can keep searching older messages while thinking, tool
        # updates and the final result arrive below the viewport.
        page.mouse.wheel(0,-1200)
        page.wait_for_function('chatScroll.scrollHeight-chatScroll.clientHeight-chatScroll.scrollTop > 800')
        settled(page)
        before = position(page)
        page.evaluate("""() => {
          emit({type:'stream_event',event:{type:'content_block_start',index:1,
            content_block:{type:'thinking',thinking:'Reasoning about the next steps.'}}});
          emit({type:'stream_event',event:{type:'content_block_delta',index:1,
            delta:{type:'thinking_delta',thinking:' More reasoning.'}}});
          flushBlockRenders();
          emit({type:'gui:tool',id:'reading-tool',name:'Read',input:{path:'fixture.txt'}});
        }""")
        unchanged(page, before)
        for subtype in ['success','stopped','error']:
            page.evaluate("subtype => emit({type:'result',subtype,result:'The response has ended.'})", subtype)
            unchanged(page, before)
            page.evaluate('startReply()')
            page.evaluate("appendReply('Automatic next turn.\\n\\n')")
            unchanged(page, before)

        # Returning all the way down resumes streaming follow.
        page.mouse.wheel(0,100000)
        page.wait_for_function('chatScroll.scrollHeight-chatScroll.clientHeight-chatScroll.scrollTop <= 1')
        settled(page)
        assert page.evaluate('followRunOutput')
        page.evaluate("appendReply('Following again.\\n\\n'.repeat(12))")
        settled(page)
        assert abs(gap(page)) <= 1

        # Native keyboard scrolling receives the same protection.
        page.locator('#chatScroll').evaluate('(element) => { element.tabIndex=0; element.focus(); }')
        page.evaluate("() => { window.keyboardScrollEnded=false; chatScroll.addEventListener('scrollend', () => { keyboardScrollEnded=true; }, {once:true}); }")
        page.keyboard.press('PageUp')
        page.wait_for_function('keyboardScrollEnded')
        settled(page)
        before = position(page)
        page.evaluate("appendReply('Keyboard reading position.\\n\\n')")
        unchanged(page, before)

        # Drag the native scrollbar thumb, rather than synthesizing a DOM
        # scroll, to cover users who browse history with the scrollbar.
        page.evaluate('scrollToLatest()')
        settled(page)
        bounds = page.locator('#chatScroll').bounding_box()
        x, y = bounds['x'] + bounds['width'] - 4, bounds['y'] + bounds['height'] - 10
        page.mouse.move(x,y)
        page.mouse.down()
        page.mouse.move(x,y-100,steps=6)
        page.mouse.up()
        page.wait_for_function('chatScroll.scrollHeight-chatScroll.clientHeight-chatScroll.scrollTop > 200')
        settled(page)
        before = position(page)
        page.evaluate("appendReply('Scrollbar reading position.\\n\\n')")
        unchanged(page, before)
        page.close()

    assert not errors, errors
    browser.close()
print('PASS: wheel and keyboard history reading survive thinking, streaming, results and automatic continuation; bottom return resumes follow')
